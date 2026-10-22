// Сохранение событий: валидация, пересчёт напоминаний и уведомления об изменениях — одной транзакцией.
import { buildReminders, changeNotification, EVENT_TYPES, eventType, type EventLike } from './schedule';
import { isValidDate, isValidTime, isValidTz, zonedToUtc } from './time';
import { insertNotificationStmt } from './dispatch';
import { bad, newId, parseJson, str } from './util';

export interface GroupRow {
  id: string; agency_id: string; title: string; tz: string; home_tz: string; start_date: string; end_date: string;
  guide_name: string; guide_phone: string; notes: string; archived: number; version: number; created_at: number; updated_at: number;
  review_enabled: number; review_at: number | null;
}

export interface EventRow {
  id: string; group_id: string; type: string; title: string; local_date: string; local_time: string | null; tz: string;
  starts_at: number; duration_min: number; location: string; address: string; map_url: string; meeting_point: string;
  notes: string; flight_no: string; leads: string; audience: string | null; cancelled: number; rev: number;
  created_at: number; updated_at: number;
}

export type EventDto = Omit<EventRow, 'leads' | 'audience' | 'cancelled'> & { leads: number[]; audience: string[] | null; cancelled: boolean };

export const toDto = (r: EventRow): EventDto => ({
  ...r, leads: parseJson<number[]>(r.leads, []), audience: parseJson<string[] | null>(r.audience, null), cancelled: !!r.cancelled,
});
const toLike = (d: EventDto): EventLike => d;

export interface EventInput {
  type: string; title: string; local_date: string; local_time: string | null; tz: string; duration_min: number;
  location: string; address: string; map_url: string; meeting_point: string; notes: string; flight_no: string;
  leads: number[]; audience: string[] | null; cancelled: boolean;
}

const MAX_LEAD = 7 * 1440;

export function parseEventInput(body: Record<string, unknown>, group: GroupRow, prev?: EventDto): EventInput {
  const pick = <K extends keyof EventInput>(k: K): unknown => (k in body ? body[k] : prev?.[k as keyof EventDto]);
  const type = String(pick('type') ?? 'other');
  if (!(type in EVENT_TYPES)) throw bad('Неизвестный тип события');
  const title = str(pick('title'), 'Название', { required: true, max: 200 });
  const local_date = pick('local_date');
  if (!isValidDate(local_date)) throw bad('Некорректная дата');
  const t = pick('local_time');
  const local_time = t == null || t === '' ? null : t;
  if (local_time !== null && !isValidTime(local_time)) throw bad('Некорректное время (нужно ЧЧ:ММ)');
  const tz = (pick('tz') as string) || group.tz;
  if (!isValidTz(tz)) throw bad('Неизвестный часовой пояс');
  const duration_min = Number(pick('duration_min') ?? 0);
  if (!Number.isInteger(duration_min) || duration_min < 0 || duration_min > 14 * 1440) throw bad('Некорректная длительность');

  let leads: number[];
  const rawLeads = pick('leads');
  if (rawLeads == null) leads = eventType(type).leads;
  else {
    if (!Array.isArray(rawLeads) || rawLeads.length > 8) throw bad('Некорректный список напоминаний');
    leads = rawLeads.map(Number);
    if (leads.some((x) => !Number.isInteger(x) || x < 0 || x > MAX_LEAD)) throw bad('Напоминание: от 0 минут до 7 дней');
    leads = [...new Set(leads)].sort((a, b) => b - a);
  }

  const rawAud = pick('audience');
  let audience: string[] | null = null;
  if (rawAud != null) {
    if (!Array.isArray(rawAud) || rawAud.some((x) => typeof x !== 'string')) throw bad('Некорректный список получателей');
    audience = [...new Set(rawAud as string[])];
    if (!audience.length) throw bad('Выберите хотя бы одного туриста или «вся группа»');
  }

  let map_url = str(pick('map_url'), 'Ссылка на карту', { max: 1000 });
  if (map_url && !/^https?:\/\//i.test(map_url)) throw bad('Ссылка на карту должна начинаться с http(s)://');

  return {
    type, title, local_date, local_time, tz, duration_min,
    location: str(pick('location'), 'Место', { max: 200 }),
    address: str(pick('address'), 'Адрес', { max: 300 }),
    map_url,
    meeting_point: str(pick('meeting_point'), 'Место сбора', { max: 200 }),
    notes: str(pick('notes'), 'Заметки', { max: 3000 }),
    flight_no: str(pick('flight_no'), 'Рейс', { max: 20 }).toUpperCase(),
    leads, audience, cancelled: !!pick('cancelled'),
  };
}

/** Аудитория может ссылаться только на туристов этой группы. */
export async function checkAudience(db: D1Database, groupId: string, audience: string[] | null): Promise<void> {
  if (!audience) return;
  const r = await db.prepare(`SELECT COUNT(*) AS n FROM participants WHERE group_id = ? AND id IN (SELECT value FROM json_each(?))`)
    .bind(groupId, JSON.stringify(audience)).first<{ n: number }>();
  if ((r?.n ?? 0) !== audience.length) throw bad('В списке получателей есть туристы не из этой группы');
}

/**
 * Готовит запросы на создание/изменение события. Возвращает итоговое событие и список statement-ов,
 * которые нужно выполнить одним db.batch (атомарно).
 */
export function saveEventStmts(
  db: D1Database, group: GroupRow, prev: EventDto | null, input: EventInput, opts: { notify: boolean; now: number },
): { event: EventDto; stmts: D1PreparedStatement[]; notified: boolean } {
  const now = opts.now;
  const starts_at = zonedToUtc(input.local_date, input.local_time, input.tz);
  const event: EventDto = {
    type: input.type, title: input.title, local_date: input.local_date, local_time: input.local_time, tz: input.tz,
    duration_min: input.duration_min, location: input.location, address: input.address, map_url: input.map_url,
    meeting_point: input.meeting_point, notes: input.notes, flight_no: input.flight_no, leads: input.leads,
    audience: input.audience, cancelled: input.cancelled,
    id: prev?.id ?? newId(), group_id: group.id, starts_at,
    rev: prev ? prev.rev + 1 : 1, created_at: prev?.created_at ?? now, updated_at: now,
  };
  const stmts: D1PreparedStatement[] = [];
  const cols = [event.type, event.title, event.local_date, event.local_time, event.tz, event.starts_at, event.duration_min,
    event.location, event.address, event.map_url, event.meeting_point, event.notes, event.flight_no,
    JSON.stringify(event.leads), event.audience ? JSON.stringify(event.audience) : null, event.cancelled ? 1 : 0];
  if (prev) {
    stmts.push(db.prepare(`UPDATE events SET type=?, title=?, local_date=?, local_time=?, tz=?, starts_at=?, duration_min=?,
        location=?, address=?, map_url=?, meeting_point=?, notes=?, flight_no=?, leads=?, audience=?, cancelled=?,
        rev=?, updated_at=? WHERE id=?`).bind(...cols, event.rev, now, event.id));
    // Старые напоминания больше не актуальны: удаляем ожидающие и гасим ещё не отправленные доставки.
    stmts.push(db.prepare(`DELETE FROM notifications WHERE event_id = ? AND kind = 'reminder' AND status = 'pending'`).bind(event.id));
    stmts.push(db.prepare(`UPDATE deliveries SET status = 'expired' WHERE status IN ('pending','sending')
        AND notification_id IN (SELECT id FROM notifications WHERE event_id = ? AND kind = 'reminder')`).bind(event.id));
  } else {
    stmts.push(db.prepare(`INSERT INTO events (type, title, local_date, local_time, tz, starts_at, duration_min,
        location, address, map_url, meeting_point, notes, flight_no, leads, audience, cancelled, rev, created_at, updated_at, id, group_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(...cols, event.rev, now, now, event.id, event.group_id));
  }
  if (!group.archived) for (const n of buildReminders(toLike(event), group.tz, now)) stmts.push(insertNotificationStmt(db, n, now));

  let notified = false;
  if (prev && opts.notify) {
    const ch = changeNotification(toLike(prev), toLike(event), group.tz, now);
    if (ch) { stmts.push(insertNotificationStmt(db, ch, now)); notified = true; }
  }
  stmts.push(bumpGroupStmt(db, group.id, now));
  return { event, stmts, notified };
}

export const bumpGroupStmt = (db: D1Database, groupId: string, now: number) =>
  db.prepare('UPDATE groups SET version = version + 1, updated_at = ? WHERE id = ?').bind(now, groupId);
