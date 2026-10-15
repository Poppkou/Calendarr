import { Hono } from 'hono';
import { checkAudience, parseEventInput, saveEventStmts, toDto, bumpGroupStmt, type EventRow, type GroupRow } from '../events';
import { insertNotificationStmt, runDispatch } from '../dispatch';
import { buildReminders, EVENT_TYPES } from '../schedule';
import { addDays, daysBetween, isValidDate, isValidTz, tzLabel } from '../time';
import { tgCall } from '../telegram';
import {
  bad, formatCode, getMeta, hashPassword, HttpError, newCode, newId, newToken, sha256, str, verifyPassword, type Env,
} from '../util';
import { readJson } from './common';

export interface StaffRow { id: string; agency_id: string; email: string; name: string; role: 'owner' | 'manager' }
type Vars = { staff: StaffRow };
export const admin = new Hono<{ Bindings: Env; Variables: Vars }>();

const SESSION_MS = 30 * 86400_000;
const MAX_EVENTS_PER_GROUP = 400;
const MAX_PARTICIPANTS_PER_GROUP = 500;

// ---------- Первичная настройка и вход ----------

export const auth = new Hono<{ Bindings: Env }>();

auth.post('/setup', async (c) => {
  const b = await readJson(c);
  const key = c.env.SETUP_KEY;
  if (!key || key.length < 16) throw new HttpError(403, 'SETUP_KEY не задан на сервере (минимум 16 символов)');
  if (typeof b.setupKey !== 'string' || (await sha256(b.setupKey)) !== (await sha256(key))) throw new HttpError(403, 'Неверный ключ настройки');
  const agencyName = str(b.agencyName, 'Название агентства', { required: true, max: 120 });
  const email = str(b.email, 'E-mail', { required: true, max: 200 }).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Некорректный e-mail');
  const password = String(b.password ?? '');
  if (password.length < 8) throw bad('Пароль — минимум 8 символов');
  const now = Date.now();
  const agencyId = newId();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO agencies (id, name, created_at) VALUES (?, ?, ?)').bind(agencyId, agencyName, now),
      c.env.DB.prepare(`INSERT INTO staff (id, agency_id, email, name, pass_hash, role, created_at) VALUES (?, ?, ?, ?, ?, 'owner', ?)`)
        .bind(newId(), agencyId, email, str(b.name, 'Имя', { max: 120 }), await hashPassword(password), now),
    ]);
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) throw bad('Пользователь с таким e-mail уже существует');
    throw e;
  }
  return c.json({ ok: true, agencyId });
});

auth.post('/login', async (c) => {
  const db = c.env.DB;
  const b = await readJson(c);
  const email = String(b.email ?? '').trim().toLowerCase().slice(0, 200);
  const password = String(b.password ?? '');
  const now = Date.now();
  const fails = await db.prepare('SELECT COUNT(*) AS n FROM login_failures WHERE email = ? AND at > ?').bind(email, now - 15 * 60_000).first<{ n: number }>();
  if ((fails?.n ?? 0) >= 10) throw new HttpError(429, 'Слишком много попыток. Попробуйте через 15 минут.');
  const s = await db.prepare('SELECT id, pass_hash FROM staff WHERE email = ?').bind(email).first<{ id: string; pass_hash: string }>();
  if (!s || !(await verifyPassword(password, s.pass_hash))) {
    await db.prepare('INSERT INTO login_failures (email, at) VALUES (?, ?)').bind(email, now).run();
    throw new HttpError(401, 'Неверный e-mail или пароль');
  }
  const token = newToken();
  await db.prepare('INSERT INTO sessions (token_hash, staff_id, expires_at) VALUES (?, ?, ?)').bind(await sha256(token), s.id, now + SESSION_MS).run();
  return c.json({ token });
});

// ---------- Всё ниже требует входа ----------

admin.use('*', async (c, next) => {
  const h = c.req.header('authorization') ?? '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) throw new HttpError(401, 'Требуется вход');
  const s = await c.env.DB.prepare(`SELECT s.id, s.agency_id, s.email, s.name, s.role FROM sessions x JOIN staff s ON s.id = x.staff_id
      WHERE x.token_hash = ? AND x.expires_at > ?`).bind(await sha256(token), Date.now()).first<StaffRow>();
  if (!s) throw new HttpError(401, 'Сессия истекла, войдите снова');
  c.set('staff', s);
  await next();
});

const ownerOnly = (s: StaffRow) => { if (s.role !== 'owner') throw new HttpError(403, 'Доступно только владельцу аккаунта'); };

async function getGroup(db: D1Database, staff: StaffRow, id: string): Promise<GroupRow> {
  const g = await db.prepare('SELECT * FROM groups WHERE id = ? AND agency_id = ?').bind(id, staff.agency_id).first<GroupRow>();
  if (!g) throw new HttpError(404, 'Группа не найдена');
  return g;
}
async function getEvent(db: D1Database, staff: StaffRow, id: string): Promise<{ ev: EventRow; group: GroupRow }> {
  const ev = await db.prepare(`SELECT e.* FROM events e JOIN groups g ON g.id = e.group_id WHERE e.id = ? AND g.agency_id = ?`)
    .bind(id, staff.agency_id).first<EventRow>();
  if (!ev) throw new HttpError(404, 'Событие не найдено');
  return { ev, group: await getGroup(db, staff, ev.group_id) };
}
async function getParticipant(db: D1Database, staff: StaffRow, id: string) {
  const p = await db.prepare(`SELECT p.* FROM participants p JOIN groups g ON g.id = p.group_id WHERE p.id = ? AND g.agency_id = ?`)
    .bind(id, staff.agency_id).first<{ id: string; group_id: string }>();
  if (!p) throw new HttpError(404, 'Турист не найден');
  return p;
}

admin.post('/logout', async (c) => {
  const token = (c.req.header('authorization') ?? '').slice(7);
  await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
  return c.json({ ok: true });
});

admin.get('/me', async (c) => {
  const s = c.get('staff');
  const agency = await c.env.DB.prepare('SELECT id, name, brand_color, phone FROM agencies WHERE id = ?').bind(s.agency_id).first();
  const last = await getMeta(c.env.DB, 'last_dispatch_at');
  return c.json({
    staff: s, agency,
    eventTypes: EVENT_TYPES,
    system: {
      lastDispatchAt: last ? Number(last) : null, serverTime: Date.now(),
      push: !!(c.env.VAPID_PUBLIC_KEY && c.env.VAPID_PRIVATE_KEY),
      telegram: !!(c.env.TELEGRAM_BOT_TOKEN && c.env.TELEGRAM_BOT_USERNAME),
      publicUrl: c.env.PUBLIC_URL ?? null,
    },
  });
});

admin.post('/password', async (c) => {
  const s = c.get('staff');
  const b = await readJson(c);
  const row = await c.env.DB.prepare('SELECT pass_hash FROM staff WHERE id = ?').bind(s.id).first<{ pass_hash: string }>();
  if (!row || !(await verifyPassword(String(b.oldPassword ?? ''), row.pass_hash))) throw bad('Текущий пароль неверный');
  if (String(b.newPassword ?? '').length < 8) throw bad('Новый пароль — минимум 8 символов');
  await c.env.DB.prepare('UPDATE staff SET pass_hash = ? WHERE id = ?').bind(await hashPassword(String(b.newPassword)), s.id).run();
  return c.json({ ok: true });
});

admin.patch('/agency', async (c) => {
  const s = c.get('staff');
  ownerOnly(s);
  const b = await readJson(c);
  const name = str(b.name, 'Название', { required: true, max: 120 });
  const color = str(b.brand_color, 'Цвет', { max: 7 }) || '#6366f1';
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw bad('Цвет в формате #RRGGBB');
  await c.env.DB.prepare('UPDATE agencies SET name = ?, brand_color = ?, phone = ? WHERE id = ?')
    .bind(name, color, str(b.phone, 'Телефон', { max: 40 }), s.agency_id).run();
  return c.json({ ok: true });
});

admin.get('/staff', async (c) => {
  const s = c.get('staff');
  const r = await c.env.DB.prepare('SELECT id, email, name, role, created_at FROM staff WHERE agency_id = ? ORDER BY created_at').bind(s.agency_id).all();
  return c.json({ staff: r.results });
});
admin.post('/staff', async (c) => {
  const s = c.get('staff');
  ownerOnly(s);
  const b = await readJson(c);
  const email = str(b.email, 'E-mail', { required: true, max: 200 }).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Некорректный e-mail');
  if (String(b.password ?? '').length < 8) throw bad('Пароль — минимум 8 символов');
  const role = b.role === 'owner' ? 'owner' : 'manager';
  try {
    await c.env.DB.prepare('INSERT INTO staff (id, agency_id, email, name, pass_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(newId(), s.agency_id, email, str(b.name, 'Имя', { max: 120 }), await hashPassword(String(b.password)), role, Date.now()).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) throw bad('Этот e-mail уже зарегистрирован');
    throw e;
  }
  return c.json({ ok: true });
});
admin.delete('/staff/:id', async (c) => {
  const s = c.get('staff');
  ownerOnly(s);
  if (c.req.param('id') === s.id) throw bad('Нельзя удалить самого себя');
  await c.env.DB.prepare('DELETE FROM staff WHERE id = ? AND agency_id = ?').bind(c.req.param('id'), s.agency_id).run();
  return c.json({ ok: true });
});

// ---------- Группы ----------

admin.get('/groups', async (c) => {
  const s = c.get('staff');
  const archived = c.req.query('archived') === '1' ? 1 : 0;
  const r = await c.env.DB.prepare(`SELECT g.*,
      (SELECT COUNT(*) FROM participants p WHERE p.group_id = g.id AND p.revoked = 0) AS participants,
      (SELECT COUNT(DISTINCT p.id) FROM participants p JOIN channels ch ON ch.participant_id = p.id AND ch.active = 1
         WHERE p.group_id = g.id AND p.revoked = 0) AS connected,
      (SELECT COUNT(*) FROM events e WHERE e.group_id = g.id) AS events
    FROM groups g WHERE g.agency_id = ? AND g.archived = ? ORDER BY g.start_date ${archived ? 'DESC' : 'ASC'} LIMIT 300`)
    .bind(s.agency_id, archived).all();
  return c.json({ groups: r.results });
});

function parseGroupInput(b: Record<string, any>, prev?: GroupRow) {
  const pick = (k: string) => (k in b ? b[k] : (prev as any)?.[k]);
  const title = str(pick('title'), 'Название', { required: true, max: 150 });
  const tz = pick('tz');
  if (!isValidTz(tz)) throw bad('Выберите часовой пояс места отдыха');
  const home_tz = pick('home_tz') || 'Europe/Moscow';
  if (!isValidTz(home_tz)) throw bad('Некорректный домашний часовой пояс');
  const start_date = pick('start_date'), end_date = pick('end_date');
  if (!isValidDate(start_date) || !isValidDate(end_date)) throw bad('Укажите даты тура');
  if (end_date < start_date) throw bad('Дата окончания раньше даты начала');
  if (daysBetween(start_date, end_date) > 120) throw bad('Тур длиннее 120 дней');
  return {
    title, tz, home_tz, start_date, end_date,
    guide_name: str(pick('guide_name'), 'Гид', { max: 120 }),
    guide_phone: str(pick('guide_phone'), 'Телефон гида', { max: 40 }),
    notes: str(pick('notes'), 'Памятка', { max: 5000 }),
  };
}

admin.post('/groups', async (c) => {
  const s = c.get('staff');
  const g = parseGroupInput(await readJson(c));
  const id = newId(), now = Date.now();
  await c.env.DB.prepare(`INSERT INTO groups (id, agency_id, title, tz, home_tz, start_date, end_date, guide_name, guide_phone, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, s.agency_id, g.title, g.tz, g.home_tz, g.start_date, g.end_date, g.guide_name, g.guide_phone, g.notes, now, now).run();
  return c.json({ id });
});

admin.get('/groups/:id', async (c) => {
  const s = c.get('staff');
  const db = c.env.DB;
  const g = await getGroup(db, s, c.req.param('id'));
  const [events, participants] = await Promise.all([
    db.prepare('SELECT * FROM events WHERE group_id = ? ORDER BY starts_at, created_at').bind(g.id).all<EventRow>(),
    db.prepare(`SELECT p.id, p.name, p.token, p.code, p.revoked, p.last_seen_at, p.created_at,
        COALESCE(SUM(c.kind = 'webpush' AND c.active = 1), 0) AS webpush,
        COALESCE(SUM(c.kind = 'telegram' AND c.active = 1), 0) AS telegram
      FROM participants p LEFT JOIN channels c ON c.participant_id = p.id
      WHERE p.group_id = ? GROUP BY p.id ORDER BY p.created_at, p.name`).bind(g.id).all<{ code: string }>(),
  ]);
  const tzs = new Set([g.tz, g.home_tz, ...events.results.map((e) => e.tz)]);
  return c.json({
    group: g,
    events: events.results.map(toDto),
    participants: participants.results.map((p) => ({ ...p, code: formatCode(p.code) })),
    tzLabels: Object.fromEntries([...tzs].map((z) => [z, tzLabel(z)])),
  });
});

admin.patch('/groups/:id', async (c) => {
  const s = c.get('staff');
  const db = c.env.DB;
  const prev = await getGroup(db, s, c.req.param('id'));
  const b = await readJson(c);
  const g = parseGroupInput(b, prev);
  const archived = 'archived' in b ? (b.archived ? 1 : 0) : prev.archived;
  await db.batch([
    db.prepare(`UPDATE groups SET title=?, tz=?, home_tz=?, start_date=?, end_date=?, guide_name=?, guide_phone=?, notes=?, archived=? WHERE id=?`)
      .bind(g.title, g.tz, g.home_tz, g.start_date, g.end_date, g.guide_name, g.guide_phone, g.notes, archived, prev.id),
    // Архивная группа больше не получает напоминаний.
    ...(archived && !prev.archived ? [db.prepare(`UPDATE notifications SET status = 'cancelled' WHERE group_id = ? AND status = 'pending'`).bind(prev.id)] : []),
    bumpGroupStmt(db, prev.id, Date.now()),
  ]);
  if (!archived && prev.archived) await rebuildGroupReminders(db, await getGroup(db, s, prev.id));
  return c.json({ ok: true });
});

admin.delete('/groups/:id', async (c) => {
  const s = c.get('staff');
  const g = await getGroup(c.env.DB, s, c.req.param('id'));
  await c.env.DB.prepare('DELETE FROM groups WHERE id = ?').bind(g.id).run();
  return c.json({ ok: true });
});

async function rebuildGroupReminders(db: D1Database, g: GroupRow) {
  const now = Date.now();
  const events = (await db.prepare('SELECT * FROM events WHERE group_id = ? AND starts_at > ?').bind(g.id, now).all<EventRow>()).results;
  const stmts: D1PreparedStatement[] = [
    db.prepare(`DELETE FROM notifications WHERE group_id = ? AND kind = 'reminder' AND status IN ('pending','cancelled')`).bind(g.id),
  ];
  for (const e of events) for (const n of buildReminders(toDto(e), g.tz, now)) stmts.push(insertNotificationStmt(db, n, now));
  await batchChunks(db, stmts);
}

/** D1 ограничивает размер batch — режем на части (используется только там, где атомарность не критична). */
async function batchChunks(db: D1Database, stmts: D1PreparedStatement[], size = 50) {
  for (let i = 0; i < stmts.length; i += size) await db.batch(stmts.slice(i, i + size));
}

// Копия группы на новые даты: «следующий заезд по той же программе».
admin.post('/groups/:id/copy', async (c) => {
  const s = c.get('staff');
  const db = c.env.DB;
  const src = await getGroup(db, s, c.req.param('id'));
  const b = await readJson(c);
  const start = b.start_date;
  if (!isValidDate(start)) throw bad('Укажите дату начала нового заезда');
  const shift = daysBetween(src.start_date, start);
  const title = str(b.title, 'Название', { max: 150 }) || src.title;
  const now = Date.now();
  const id = newId();
  const g: GroupRow = { ...src, id, title, start_date: start, end_date: addDays(src.end_date, shift), archived: 0, version: 1, created_at: now, updated_at: now };
  const events = (await db.prepare('SELECT * FROM events WHERE group_id = ?').bind(src.id).all<EventRow>()).results;
  const stmts: D1PreparedStatement[] = [
    db.prepare(`INSERT INTO groups (id, agency_id, title, tz, home_tz, start_date, end_date, guide_name, guide_phone, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, s.agency_id, g.title, g.tz, g.home_tz, g.start_date, g.end_date, g.guide_name, g.guide_phone, g.notes, now, now),
  ];
  for (const e of events) {
    const dto = toDto(e);
    const input = { ...dto, local_date: addDays(dto.local_date, shift), audience: null, cancelled: false };
    stmts.push(...saveEventStmts(db, g, null, input, { notify: false, now }).stmts);
  }
  await batchChunks(db, stmts);
  return c.json({ id });
});

// ---------- События ----------

admin.post('/groups/:id/events', async (c) => {
  const s = c.get('staff');
  const db = c.env.DB;
  const g = await getGroup(db, s, c.req.param('id'));
  const cnt = await db.prepare('SELECT COUNT(*) AS n FROM events WHERE group_id = ?').bind(g.id).first<{ n: number }>();
  if ((cnt?.n ?? 0) >= MAX_EVENTS_PER_GROUP) throw bad(`Не больше ${MAX_EVENTS_PER_GROUP} событий в группе`);
  const input = parseEventInput(await readJson(c), g);
  await checkAudience(db, g.id, input.audience);
  const { event, stmts } = saveEventStmts(db, g, null, input, { notify: false, now: Date.now() });
  await db.batch(stmts);
  return c.json({ event });
});

admin.patch('/events/:id', async (c) => {
  const s = c.get('staff');
  const db = c.env.DB;
  const { ev, group } = await getEvent(db, s, c.req.param('id'));
  const b = await readJson(c);
  const prev = toDto(ev);
  // Защита от одновременного редактирования двумя менеджерами.
  if (b.rev != null && Number(b.rev) !== prev.rev) throw new HttpError(409, 'Событие уже изменил другой сотрудник. Обновите страницу.');
  const input = parseEventInput(b, group, prev);
  await checkAudience(db, group.id, input.audience);
  const { event, stmts, notified } = saveEventStmts(db, group, prev, input, { notify: b.notify !== false && !group.archived, now: Date.now() });
  await db.batch(stmts);
  if (notified) c.executionCtx.waitUntil(runDispatch(c.env).catch((e) => console.error('dispatch', e)));
  return c.json({ event, notified });
});

admin.delete('/events/:id', async (c) => {
  const s = c.get('staff');
  const db = c.env.DB;
  const { ev, group } = await getEvent(db, s, c.req.param('id'));
  await db.batch([db.prepare('DELETE FROM events WHERE id = ?').bind(ev.id), bumpGroupStmt(db, group.id, Date.now())]);
  return c.json({ ok: true });
});

// ---------- Туристы ----------

admin.post('/groups/:id/participants', async (c) => {
  const s = c.get('staff');
  const db = c.env.DB;
  const g = await getGroup(db, s, c.req.param('id'));
  const b = await readJson(c);
  let names: string[] = Array.isArray(b.names) ? b.names.map((x: unknown) => String(x ?? '').trim().slice(0, 120)) : [];
  const count = Number(b.count ?? 0);
  if (!names.length && Number.isInteger(count) && count > 0) names = Array(Math.min(count, 200)).fill('');
  names = names.filter((n, i) => n || !b.names);
  if (!names.length) throw bad('Добавьте хотя бы одного туриста');
  const cnt = await db.prepare('SELECT COUNT(*) AS n FROM participants WHERE group_id = ?').bind(g.id).first<{ n: number }>();
  if ((cnt?.n ?? 0) + names.length > MAX_PARTICIPANTS_PER_GROUP) throw bad(`Не больше ${MAX_PARTICIPANTS_PER_GROUP} туристов в группе`);
  const now = Date.now();
  await batchChunks(db, names.map((name) => db.prepare(
    'INSERT INTO participants (id, group_id, name, token, code, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(newId(), g.id, name, newToken(), newCode(), now)));
  return c.json({ ok: true, added: names.length });
});

admin.patch('/participants/:id', async (c) => {
  const s = c.get('staff');
  const db = c.env.DB;
  const p = await getParticipant(db, s, c.req.param('id'));
  const b = await readJson(c);
  const stmts: D1PreparedStatement[] = [];
  if ('name' in b) stmts.push(db.prepare('UPDATE participants SET name = ? WHERE id = ?').bind(str(b.name, 'Имя', { max: 120 }), p.id));
  if ('revoked' in b) stmts.push(db.prepare('UPDATE participants SET revoked = ? WHERE id = ?').bind(b.revoked ? 1 : 0, p.id));
  if (b.regenerate) {
    // Новая ссылка: старая перестаёт работать, подписки отключаются.
    stmts.push(db.prepare('UPDATE participants SET token = ?, code = ? WHERE id = ?').bind(newToken(), newCode(), p.id));
    stmts.push(db.prepare('UPDATE channels SET active = 0 WHERE participant_id = ?').bind(p.id));
  }
  if (stmts.length) await db.batch(stmts);
  return c.json({ ok: true });
});

admin.delete('/participants/:id', async (c) => {
  const s = c.get('staff');
  const p = await getParticipant(c.env.DB, s, c.req.param('id'));
  await c.env.DB.prepare('DELETE FROM participants WHERE id = ?').bind(p.id).run();
  return c.json({ ok: true });
});

// ---------- Рассылки и журнал ----------

admin.post('/groups/:id/broadcast', async (c) => {
  const s = c.get('staff');
  const db = c.env.DB;
  const g = await getGroup(db, s, c.req.param('id'));
  const b = await readJson(c);
  const text = str(b.text, 'Сообщение', { required: true, max: 900 });
  let audience: string[] | null = null;
  if (Array.isArray(b.audience) && b.audience.length) {
    audience = b.audience.map(String);
    const r = await db.prepare(`SELECT COUNT(*) AS n FROM participants WHERE group_id = ? AND id IN (SELECT value FROM json_each(?))`)
      .bind(g.id, JSON.stringify(audience)).first<{ n: number }>();
    if (r?.n !== audience.length) throw bad('Некорректный список получателей');
  }
  const now = Date.now();
  await insertNotificationStmt(db, {
    group_id: g.id, event_id: null, kind: 'broadcast', lead_min: null, audience, fire_at: now, expires_at: now + 6 * 3600_000,
    title: `📣 ${g.title}`, body: text, urgent: true,
  }, now).run();
  const stats = await runDispatch(c.env);
  return c.json({ ok: true, stats });
});

admin.get('/groups/:id/notifications', async (c) => {
  const s = c.get('staff');
  const g = await getGroup(c.env.DB, s, c.req.param('id'));
  const r = await c.env.DB.prepare(`SELECT n.id, n.kind, n.title, n.body, n.fire_at, n.status, n.lead_min,
      COALESCE(SUM(d.status = 'sent'), 0) AS sent,
      COALESCE(SUM(d.status IN ('pending','sending')), 0) AS queued,
      COALESCE(SUM(d.status = 'failed'), 0) AS failed,
      COALESCE(SUM(d.status IN ('gone','expired')), 0) AS dropped,
      MAX(d.last_error) AS last_error
    FROM notifications n LEFT JOIN deliveries d ON d.notification_id = n.id
    WHERE n.group_id = ? AND n.status <> 'cancelled'
    GROUP BY n.id ORDER BY n.fire_at DESC LIMIT 300`).bind(g.id).all();
  return c.json({ notifications: r.results });
});

// Подключение Telegram-бота: регистрирует webhook и список команд.
admin.post('/telegram/setup', async (c) => {
  const s = c.get('staff');
  ownerOnly(s);
  const { TELEGRAM_BOT_TOKEN: tok, TELEGRAM_WEBHOOK_SECRET: secret } = c.env;
  if (!tok || !secret) throw bad('На сервере не заданы TELEGRAM_BOT_TOKEN и TELEGRAM_WEBHOOK_SECRET');
  const base = (c.env.PUBLIC_URL || new URL(c.req.url).origin).replace(/\/+$/, '');
  const r1 = await (await tgCall(tok, 'setWebhook', { url: `${base}/api/telegram/webhook`, secret_token: secret, allowed_updates: ['message'] })).json();
  const r2 = await (await tgCall(tok, 'setMyCommands', {
    commands: [
      { command: 'next', description: 'Ближайшие события' },
      { command: 'today', description: 'Расписание на сегодня' },
      { command: 'stop', description: 'Отключить уведомления' },
    ],
  })).json();
  return c.json({ webhook: r1, commands: r2 });
});

