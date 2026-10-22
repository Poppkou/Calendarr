// Обращения туристов («Я опаздываю», «Нужна помощь», сообщения в бот) и ответы менеджеров.
import { insertNotificationStmt, runDispatch } from './dispatch';
import { tgSendMessage } from './telegram';
import { eventType } from './schedule';
import { formatDateInTz, humanDate } from './time';
import { HttpError, newId, type Env } from './util';
import type { TouristCtx } from './routes/tourist';

export type AlertKind = 'late' | 'help' | 'message' | 'review';

export interface AlertRow {
  id: string; agency_id: string; group_id: string; participant_id: string; kind: AlertKind; minutes: number | null;
  text: string; contact: string; source: 'web' | 'telegram'; status: 'new' | 'done'; handled_by: string | null;
  handled_at: number | null; tg_msgs: string; created_at: number;
}

export const ALERT_TITLES: Record<AlertKind, string> = {
  late: '⏰ Опаздывает', help: '🆘 Нужна помощь', message: '💬 Сообщение', review: '⭐ Отзыв',
};

const RATE_WINDOW = 10 * 60_000;
const RATE_MAX = 6;

/** Ближайшее событие — чтобы менеджер сразу понимал, куда турист опаздывает. */
async function nextEventLine(db: D1Database, t: TouristCtx, now: number): Promise<string> {
  const ev = await db.prepare(`SELECT title, type, local_date, local_time, meeting_point, location, tz FROM events
      WHERE group_id = ? AND cancelled = 0 AND starts_at >= ?
        AND (audience IS NULL OR EXISTS (SELECT 1 FROM json_each(events.audience) WHERE value = ?))
      ORDER BY starts_at LIMIT 1`).bind(t.group_id, now - 30 * 60_000, t.participant_id)
    .first<{ title: string; type: string; local_date: string; local_time: string | null; meeting_point: string; location: string; tz: string }>();
  if (!ev) return '';
  const today = formatDateInTz(now, ev.tz);
  const day = ev.local_date === today ? 'сегодня' : humanDate(ev.local_date);
  const place = ev.meeting_point || ev.location;
  return `Ближайшее: ${day}${ev.local_time ? ' в ' + ev.local_time : ''} ${eventType(ev.type).icon} ${ev.title}${place ? ` (${place})` : ''}`;
}

export async function createAlert(env: Env, t: TouristCtx, input: { kind: AlertKind; minutes?: number | null; text?: string; contact?: string; source: 'web' | 'telegram' }, now = Date.now()): Promise<AlertRow> {
  const db = env.DB;
  const recent = await db.prepare('SELECT COUNT(*) AS n FROM alerts WHERE participant_id = ? AND created_at > ?')
    .bind(t.participant_id, now - RATE_WINDOW).first<{ n: number }>();
  if ((recent?.n ?? 0) >= RATE_MAX) throw new HttpError(429, 'Слишком много сообщений подряд. Если срочно — позвоните гиду.');
  const alert: AlertRow = {
    id: newId(), agency_id: t.agency_id, group_id: t.group_id, participant_id: t.participant_id, kind: input.kind,
    minutes: input.minutes ?? null, text: (input.text ?? '').trim().slice(0, 1000), contact: (input.contact ?? '').trim().slice(0, 40),
    source: input.source, status: 'new', handled_by: null, handled_at: null, tg_msgs: '[]', created_at: now,
  };
  await db.prepare(`INSERT INTO alerts (id, agency_id, group_id, participant_id, kind, minutes, text, contact, source, status, tg_msgs, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', '[]', ?)`)
    .bind(alert.id, alert.agency_id, alert.group_id, alert.participant_id, alert.kind, alert.minutes, alert.text, alert.contact, alert.source, now).run();
  await notifyStaff(env, t, alert, now);
  return alert;
}

function alertHeadline(a: Pick<AlertRow, 'kind' | 'minutes'>): string {
  if (a.kind === 'late') return a.minutes ? `⏰ Опаздывает на ${a.minutes} мин` : '⏰ Опаздывает';
  return ALERT_TITLES[a.kind];
}

/** Сообщение сотрудникам агентства, подключившим Telegram. На него можно ответить реплаем. */
async function notifyStaff(env: Env, t: TouristCtx, a: AlertRow, now: number): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  const staff = (await env.DB.prepare('SELECT tg_chat_id FROM staff WHERE agency_id = ? AND tg_chat_id IS NOT NULL')
    .bind(t.agency_id).all<{ tg_chat_id: string }>()).results;
  if (!staff.length) return;
  const next = a.kind === 'late' || a.kind === 'help' ? await nextEventLine(env.DB, t, now) : '';
  const text = [
    alertHeadline(a),
    `${t.participant_name || 'Турист ' + t.code} · ${t.group_title}`,
    a.text && `«${a.text}»`,
    a.contact && `Телефон туриста: ${a.contact}`,
    next,
    t.guide_phone && `Гид: ${t.guide_name} ${t.guide_phone}`.trim(),
    '',
    'Ответьте на это сообщение (Reply) — ответ придёт туристу.',
  ].filter((x, i, arr) => typeof x === 'string' && (x !== '' || i === arr.length - 2)).join('\n');
  const markup = { inline_keyboard: [[{ text: '✅ Принял', callback_data: `ack:${a.id}` }]] };
  const sent: { chat: string; msg: number }[] = [];
  for (const s of staff.slice(0, 10)) {
    const r = await tgSendMessage(env.TELEGRAM_BOT_TOKEN, s.tg_chat_id, text, markup);
    if (r.ok && r.messageId) sent.push({ chat: s.tg_chat_id, msg: r.messageId });
  }
  if (sent.length) await env.DB.prepare('UPDATE alerts SET tg_msgs = ? WHERE id = ?').bind(JSON.stringify(sent), a.id).run();
}

/** Личное сообщение туристу — через обычную рассылку (браузер + Telegram) и в ленту «Сообщения» на сайте. */
export async function messageTourist(env: Env, groupId: string, participantId: string, title: string, body: string, now = Date.now()): Promise<void> {
  await insertNotificationStmt(env.DB, {
    group_id: groupId, event_id: null, kind: 'broadcast', lead_min: null, audience: [participantId],
    fire_at: now, expires_at: now + 6 * 3600_000, title, body: body.slice(0, 900), urgent: true,
  }, now).run();
  await runDispatch(env);
}

export async function ackAlert(env: Env, alertId: string, agencyId: string, staffName: string, now = Date.now()): Promise<AlertRow> {
  const a = await env.DB.prepare('SELECT * FROM alerts WHERE id = ? AND agency_id = ?').bind(alertId, agencyId).first<AlertRow>();
  if (!a) throw new HttpError(404, 'Обращение не найдено');
  if (a.status === 'done') return a;
  await env.DB.prepare(`UPDATE alerts SET status = 'done', handled_by = ?, handled_at = ? WHERE id = ? AND status = 'new'`)
    .bind(staffName, now, a.id).run();
  if (a.kind === 'late' || a.kind === 'help') {
    await messageTourist(env, a.group_id, a.participant_id, '✅ Менеджер получил ваше сообщение',
      `${staffName ? staffName + ' уже' : 'Мы уже'} в курсе${a.kind === 'late' ? ' — вас подождут или подскажут, как догнать группу' : ' и свяжется с вами'}.`, now);
  }
  return { ...a, status: 'done', handled_by: staffName, handled_at: now };
}

export async function replyToAlert(env: Env, alertId: string, agencyId: string, staffName: string, agencyName: string, text: string, now = Date.now()): Promise<void> {
  const a = await env.DB.prepare('SELECT * FROM alerts WHERE id = ? AND agency_id = ?').bind(alertId, agencyId).first<AlertRow>();
  if (!a) throw new HttpError(404, 'Обращение не найдено');
  await env.DB.prepare(`UPDATE alerts SET status = 'done', handled_by = COALESCE(handled_by, ?), handled_at = COALESCE(handled_at, ?) WHERE id = ?`)
    .bind(staffName, now, a.id).run();
  await messageTourist(env, a.group_id, a.participant_id, `💬 ${agencyName}${staffName ? ' · ' + staffName : ''}`, text, now);
}
