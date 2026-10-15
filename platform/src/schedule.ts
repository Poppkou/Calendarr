// Расчёт напоминаний и тексты уведомлений. Чистые функции — легко тестировать.
import { addDays, formatDateInTz, formatTimeInTz, humanDate, tzLabel, zonedParts, zonedToUtc } from './time';

export const EVENT_TYPES: Record<string, { icon: string; name: string; leads: number[]; critical?: boolean }> = {
  flight:    { icon: '✈️', name: 'Перелёт',          leads: [1440, 300, 180], critical: true },
  transfer:  { icon: '🚌', name: 'Трансфер',         leads: [720, 60, 15],    critical: true },
  meeting:   { icon: '📍', name: 'Сбор группы',      leads: [720, 30, 10],    critical: true },
  excursion: { icon: '🏛️', name: 'Экскурсия',        leads: [720, 30] },
  hotel:     { icon: '🏨', name: 'Отель',            leads: [60] },
  meal:      { icon: '🍽️', name: 'Питание',          leads: [] },
  free:      { icon: '🌴', name: 'Свободное время',  leads: [] },
  other:     { icon: '📌', name: 'Другое',           leads: [60, 15] },
};
export const eventType = (t: string) => EVENT_TYPES[t] ?? EVENT_TYPES.other;

export interface EventLike {
  id: string; group_id: string; type: string; title: string;
  local_date: string; local_time: string | null; tz: string; starts_at: number;
  location: string; meeting_point: string; flight_no: string;
  leads: number[]; audience: string[] | null; cancelled: number | boolean;
}

export interface NewNotification {
  group_id: string; event_id: string | null; kind: 'reminder' | 'change' | 'cancel' | 'broadcast' | 'test';
  lead_min: number | null; audience: string[] | null;
  fire_at: number; expires_at: number; title: string; body: string; urgent: boolean;
}

export const QUIET_FROM = 23; // с 23:00
export const QUIET_TO = 7;    // до 07:00 по месту события
const MIN = 60_000;

/**
 * Если «заблаговременное» напоминание (за 6+ часов) попадает на ночь, переносим его на 21:00
 * предыдущего вечера — раньше, а не позже, чтобы турист точно успел подготовиться.
 */
export function applyQuietHours(fireAt: number, lead: number, tz: string): number {
  if (lead < 360) return fireAt;
  const z = zonedParts(fireAt, tz);
  if (z.hour >= QUIET_FROM || z.hour < QUIET_TO) {
    const date = formatDateInTz(fireAt, tz);
    const evening = z.hour >= QUIET_FROM ? date : addDays(date, -1);
    return zonedToUtc(evening, '21:00', tz);
  }
  return fireAt;
}

/** «сегодня в 14:30», «завтра в 07:00», «18 мая в 10:00», «18 мая (весь день)». */
export function whenPhrase(ev: Pick<EventLike, 'local_date' | 'local_time' | 'tz'>, relativeTo: number): string {
  const today = formatDateInTz(relativeTo, ev.tz);
  const day = ev.local_date === today ? 'сегодня'
    : ev.local_date === addDays(today, 1) ? 'завтра'
    : humanDate(ev.local_date);
  return ev.local_time ? `${day} в ${ev.local_time}` : `${day} (весь день)`;
}

export function untilPhrase(ms: number): string {
  const m = Math.round(ms / MIN);
  if (m <= 1) return 'начинается сейчас';
  if (m < 60) return `через ${m} мин`;
  const h = Math.floor(m / 60), mm = m % 60;
  if (h < 24) return mm ? `через ${h} ч ${mm} мин` : `через ${h} ч`;
  return '';
}

function eventHeadline(ev: EventLike): string {
  const t = eventType(ev.type);
  const flight = ev.type === 'flight' && ev.flight_no && !ev.title.includes(ev.flight_no) ? ` ${ev.flight_no}` : '';
  return `${t.icon} ${ev.title}${flight}`;
}
function placeLine(ev: EventLike): string {
  return [ev.meeting_point && `Место сбора: ${ev.meeting_point}`, !ev.meeting_point && ev.location].filter(Boolean).join('');
}

export function reminderText(ev: EventLike, fireAt: number, groupTz: string): { title: string; body: string } {
  const until = untilPhrase(ev.starts_at - fireAt);
  const title = until && ev.local_time ? `${eventHeadline(ev)} — ${until}` : eventHeadline(ev);
  const tzNote = ev.tz !== groupTz ? ` (по времени: ${tzLabel(ev.tz)})` : '';
  const body = [`${capitalize(whenPhrase(ev, fireAt))}${tzNote}`, placeLine(ev)].filter(Boolean).join(' · ');
  return { title, body };
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Все будущие напоминания для события. */
export function buildReminders(ev: EventLike, groupTz: string, now: number): NewNotification[] {
  if (ev.cancelled) return [];
  const out: NewNotification[] = [];
  const seen = new Set<number>();
  const critical = !!eventType(ev.type).critical;
  for (const lead of [...new Set(ev.leads)].sort((a, b) => b - a)) {
    const fireAt = applyQuietHours(ev.starts_at - lead * MIN, lead, ev.tz);
    // Напоминание, которое уже должно было уйти, не отправляем задним числом.
    if (fireAt <= now - MIN) continue;
    // После переноса на «тихие часы» два напоминания могут совпасть — оставляем одно.
    if (seen.has(fireAt)) continue;
    seen.add(fireAt);
    const expires = lead === 0 ? ev.starts_at + 10 * MIN : Math.min(fireAt + 30 * MIN, ev.starts_at);
    const { title, body } = reminderText(ev, fireAt, groupTz);
    out.push({
      group_id: ev.group_id, event_id: ev.id, kind: 'reminder', lead_min: lead, audience: ev.audience,
      fire_at: fireAt, expires_at: expires, title, body, urgent: critical && lead <= 300,
    });
  }
  return out;
}

export interface ChangeSet { time: boolean; place: boolean; cancelled: boolean; restored: boolean }

export function diffEvent(before: EventLike, after: EventLike): ChangeSet {
  return {
    time: before.starts_at !== after.starts_at || before.local_time !== after.local_time,
    place: before.location !== after.location || before.meeting_point !== after.meeting_point,
    cancelled: !before.cancelled && !!after.cancelled,
    restored: !!before.cancelled && !after.cancelled,
  };
}

/** Уведомление об изменении/отмене. null — если сообщать не о чем или событие уже прошло. */
export function changeNotification(before: EventLike, after: EventLike, groupTz: string, now: number): NewNotification | null {
  const ch = diffEvent(before, after);
  if (!ch.time && !ch.place && !ch.cancelled && !ch.restored) return null;
  if (Math.max(before.starts_at, after.starts_at) < now) return null;
  const head = eventHeadline(after);
  let title: string, body: string, kind: NewNotification['kind'] = 'change';
  if (ch.cancelled) {
    kind = 'cancel';
    title = `❌ Отменено: ${after.title}`;
    body = `Событие ${whenPhrase(before, now)} отменено.`;
  } else {
    title = `⚠️ Изменение: ${head}`;
    const parts: string[] = [];
    if (ch.restored) parts.push(`Событие снова в программе: ${whenPhrase(after, now)}`);
    else if (ch.time) parts.push(`Новое время: ${whenPhrase(after, now)} (было ${whenPhrase(before, now)})`);
    else parts.push(capitalize(whenPhrase(after, now)));
    if (ch.place) parts.push(placeLine(after) || 'Место изменено');
    if (after.tz !== groupTz) parts.push(`время: ${tzLabel(after.tz)}`);
    body = parts.join(' · ');
  }
  const audience = mergeAudience(before.audience, after.audience);
  return {
    group_id: after.group_id, event_id: after.id, kind, lead_min: null, audience,
    fire_at: now, expires_at: Math.max(now + 60 * MIN, Math.max(before.starts_at, after.starts_at)),
    title, body, urgent: true,
  };
}

/** Об изменении сообщаем и тем, кто был в списке до правки, и тем, кто стал. */
function mergeAudience(a: string[] | null, b: string[] | null): string[] | null {
  if (!a || !b) return null;
  return [...new Set([...a, ...b])];
}

export const formatLocal = (ms: number, tz: string) => `${formatDateInTz(ms, tz)} ${formatTimeInTz(ms, tz)}`;
