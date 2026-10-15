-- «Пульс Тур»: исходная схема.
-- Все моменты времени — миллисекунды Unix (UTC). Локальное время события хранится отдельно
-- вместе с IANA-таймзоной, чтобы показывать его «как в программе тура».

CREATE TABLE agencies (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  brand_color TEXT NOT NULL DEFAULT '#6366f1',
  phone       TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);

CREATE TABLE staff (
  id         TEXT PRIMARY KEY,
  agency_id  TEXT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  email      TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL DEFAULT '',
  pass_hash  TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'manager' CHECK (role IN ('owner','manager')),
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  staff_id   TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_staff ON sessions(staff_id);

-- Неудачные попытки входа: защита от перебора паролей.
CREATE TABLE login_failures (
  email TEXT NOT NULL,
  at    INTEGER NOT NULL
);
CREATE INDEX login_failures_email ON login_failures(email, at);

CREATE TABLE groups (
  id          TEXT PRIMARY KEY,
  agency_id   TEXT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  tz          TEXT NOT NULL,              -- таймзона по умолчанию для событий группы
  home_tz     TEXT NOT NULL DEFAULT 'Europe/Moscow', -- «домашнее» время туристов
  start_date  TEXT NOT NULL,              -- YYYY-MM-DD
  end_date    TEXT NOT NULL,
  guide_name  TEXT NOT NULL DEFAULT '',
  guide_phone TEXT NOT NULL DEFAULT '',
  notes       TEXT NOT NULL DEFAULT '',
  archived    INTEGER NOT NULL DEFAULT 0,
  version     INTEGER NOT NULL DEFAULT 1, -- растёт при любом изменении расписания (ETag для туристов)
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX groups_agency ON groups(agency_id, archived, start_date);

CREATE TABLE events (
  id            TEXT PRIMARY KEY,
  group_id      TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  type          TEXT NOT NULL DEFAULT 'other',
  title         TEXT NOT NULL,
  local_date    TEXT NOT NULL,            -- YYYY-MM-DD в таймзоне tz
  local_time    TEXT,                     -- HH:MM или NULL для «весь день»
  tz            TEXT NOT NULL,
  starts_at     INTEGER NOT NULL,         -- UTC ms
  duration_min  INTEGER NOT NULL DEFAULT 0,
  location      TEXT NOT NULL DEFAULT '',
  address       TEXT NOT NULL DEFAULT '',
  map_url       TEXT NOT NULL DEFAULT '',
  meeting_point TEXT NOT NULL DEFAULT '',
  notes         TEXT NOT NULL DEFAULT '',
  flight_no     TEXT NOT NULL DEFAULT '',
  leads         TEXT NOT NULL DEFAULT '[]', -- JSON: минуты до начала
  audience      TEXT,                     -- JSON-массив participant_id или NULL = вся группа
  cancelled     INTEGER NOT NULL DEFAULT 0,
  rev           INTEGER NOT NULL DEFAULT 1, -- ревизия события (метка «изменено» у туриста)
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX events_group ON events(group_id, starts_at);

CREATE TABLE participants (
  id           TEXT PRIMARY KEY,
  group_id     TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name         TEXT NOT NULL DEFAULT '',
  token        TEXT NOT NULL UNIQUE,      -- секрет в персональной ссылке
  code         TEXT NOT NULL UNIQUE,      -- короткий код для ручного ввода
  revoked      INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX participants_group ON participants(group_id);

CREATE TABLE channels (
  id             TEXT PRIMARY KEY,
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('webpush','telegram')),
  address        TEXT NOT NULL,           -- endpoint подписки или chat_id
  data           TEXT NOT NULL DEFAULT '{}', -- ключи подписки и пр.
  active         INTEGER NOT NULL DEFAULT 1,
  fail_count     INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  UNIQUE (participant_id, kind, address)
);
CREATE INDEX channels_participant ON channels(participant_id, active);

-- Что и когда нужно отправить. Напоминания пересоздаются при каждом изменении события.
CREATE TABLE notifications (
  id         TEXT PRIMARY KEY,
  group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  event_id   TEXT REFERENCES events(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('reminder','change','cancel','broadcast','test')),
  lead_min   INTEGER,
  audience   TEXT,                        -- JSON-массив participant_id или NULL = вся группа
  fire_at    INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,            -- позже этого момента отправлять бессмысленно
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  urgent     INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','fanned','skipped','cancelled')),
  created_at INTEGER NOT NULL
);
CREATE INDEX notifications_due ON notifications(status, fire_at);
CREATE INDEX notifications_event ON notifications(event_id, status);
CREATE INDEX notifications_group ON notifications(group_id, fire_at);

-- Конкретная доставка в конкретный канал. UNIQUE гарантирует «не больше одного раза».
CREATE TABLE deliveries (
  id              TEXT PRIMARY KEY,
  notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  channel_id      TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed','gone','expired')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error      TEXT,
  sent_at         INTEGER,
  UNIQUE (notification_id, channel_id)
);
CREATE INDEX deliveries_due ON deliveries(status, next_attempt_at);
CREATE INDEX deliveries_notification ON deliveries(notification_id);

-- Служебные значения: время последнего запуска планировщика и т.п.
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
