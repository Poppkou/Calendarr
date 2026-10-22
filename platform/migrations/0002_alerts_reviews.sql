-- Обращения туристов («Я опаздываю», «Нужна помощь», сообщения в бот), отзывы после тура,
-- Telegram для сотрудников и ссылка на страницу отзывов агентства.

ALTER TABLE agencies ADD COLUMN review_url TEXT NOT NULL DEFAULT '';

ALTER TABLE staff ADD COLUMN tg_chat_id TEXT;
ALTER TABLE staff ADD COLUMN tg_link_token TEXT;
CREATE UNIQUE INDEX staff_tg_link ON staff(tg_link_token);

ALTER TABLE groups ADD COLUMN review_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE groups ADD COLUMN review_at INTEGER;   -- когда попросить отзыв (UTC ms); заполняется сервером

CREATE TABLE alerts (
  id             TEXT PRIMARY KEY,
  agency_id      TEXT NOT NULL REFERENCES agencies(id) ON DELETE CASCADE,
  group_id       TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('late','help','message','review')),
  minutes        INTEGER,                  -- на сколько опаздывает
  text           TEXT NOT NULL DEFAULT '',
  contact        TEXT NOT NULL DEFAULT '', -- телефон, который турист оставил для связи
  source         TEXT NOT NULL DEFAULT 'web' CHECK (source IN ('web','telegram')),
  status         TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','done')),
  handled_by     TEXT,                     -- имя сотрудника, который принял
  handled_at     INTEGER,
  tg_msgs        TEXT NOT NULL DEFAULT '[]', -- [{chat, msg}] — сообщения сотрудникам, чтобы ответить реплаем
  created_at     INTEGER NOT NULL
);
CREATE INDEX alerts_agency ON alerts(agency_id, status, created_at);
CREATE INDEX alerts_participant ON alerts(participant_id, created_at);

CREATE TABLE reviews (
  id             TEXT PRIMARY KEY,
  group_id       TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  rating         INTEGER CHECK (rating BETWEEN 1 AND 5),
  comment        TEXT NOT NULL DEFAULT '',
  asked_at       INTEGER NOT NULL,
  answered_at    INTEGER,
  UNIQUE (group_id, participant_id)
);
CREATE INDEX reviews_group ON reviews(group_id);
