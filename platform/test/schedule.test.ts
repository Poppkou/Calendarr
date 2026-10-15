import { describe, expect, it } from 'vitest';
import { applyQuietHours, buildReminders, changeNotification, type EventLike } from '../src/schedule';
import { formatTimeInTz, zonedToUtc } from '../src/time';

const TZ = 'Europe/Istanbul'; // UTC+3 круглый год
const ev = (o: Partial<EventLike> = {}): EventLike => {
  const base: EventLike = {
    id: 'e1', group_id: 'g1', type: 'transfer', title: 'Трансфер в аэропорт', local_date: '2026-05-14', local_time: '08:00',
    tz: TZ, starts_at: 0, location: 'Отель', meeting_point: 'Лобби', flight_no: '', leads: [720, 60, 15], audience: null, cancelled: false,
    ...o,
  };
  base.starts_at = o.starts_at ?? zonedToUtc(base.local_date, base.local_time, base.tz);
  return base;
};
const NOW = zonedToUtc('2026-05-10', '12:00', TZ);

describe('buildReminders', () => {
  it('creates reminders with readable texts', () => {
    const r = buildReminders(ev(), TZ, NOW);
    expect(r.map((n) => formatTimeInTz(n.fire_at, TZ))).toEqual(['20:00', '07:00', '07:45']);
    expect(r[0].body).toBe('Завтра в 08:00 · Место сбора: Лобби');
    expect(r[1].title).toBe('🚌 Трансфер в аэропорт — через 1 ч');
    expect(r[1].body).toBe('Сегодня в 08:00 · Место сбора: Лобби');
    expect(r[1].urgent).toBe(true);
    expect(r.every((n) => n.expires_at <= ev().starts_at && n.expires_at > n.fire_at)).toBe(true);
  });

  it('shifts reminders that would fire at night', () => {
    const e = ev({ local_time: '10:00', leads: [720] }); // 22:00 накануне — ок
    expect(formatTimeInTz(buildReminders(e, TZ, NOW)[0].fire_at, TZ)).toBe('22:00');
    const e2 = ev({ local_time: '05:00', leads: [480, 120] }); // 21:00 накануне и 03:00 (короткий — не сдвигаем)
    expect(buildReminders(e2, TZ, NOW).map((n) => formatTimeInTz(n.fire_at, TZ))).toEqual(['21:00', '03:00']);
    const t = zonedToUtc('2026-05-14', '02:00', TZ);
    expect(formatTimeInTz(applyQuietHours(t, 720, TZ), TZ)).toBe('21:00');
    expect(applyQuietHours(t, 60, TZ)).toBe(t);
  });

  it('deduplicates reminders collapsing onto the same time and skips past ones', () => {
    const collide = ev({ local_time: '06:00', leads: [360, 400] }); // 00:00→21:00 и 23:20→21:00
    expect(buildReminders(collide, TZ, NOW)).toHaveLength(1);
    const soon = ev({ local_date: '2026-05-10', local_time: '12:30' });
    expect(buildReminders(soon, TZ, NOW).map((n) => n.lead_min)).toEqual([15]);
    expect(buildReminders(ev({ cancelled: true }), TZ, NOW)).toEqual([]);
  });

  it('notes the event time zone when it differs from the group zone (flights)', () => {
    const f = ev({ type: 'flight', title: 'Вылет домой', flight_no: 'SU2137', tz: 'Europe/Moscow', leads: [180] });
    const [n] = buildReminders(f, TZ, NOW);
    expect(n.title).toBe('✈️ Вылет домой SU2137 — через 3 ч');
    expect(n.body).toContain('по времени: Москва');
  });
});

describe('changeNotification', () => {
  it('reports a time change with old and new time', () => {
    const before = ev();
    const after = ev({ local_time: '07:30' });
    const n = changeNotification(before, after, TZ, NOW)!;
    expect(n.kind).toBe('change');
    expect(n.title).toBe('⚠️ Изменение: 🚌 Трансфер в аэропорт');
    expect(n.body).toContain('Новое время: 14 мая в 07:30 (было 14 мая в 08:00)');
  });
  it('reports cancellation and ignores non-material edits / past events', () => {
    expect(changeNotification(ev(), ev({ cancelled: true }), TZ, NOW)!.kind).toBe('cancel');
    expect(changeNotification(ev(), ev({ title: 'Опечатка исправлена' }), TZ, NOW)).toBeNull();
    const past = ev({ local_date: '2026-05-01' });
    expect(changeNotification(past, { ...past, local_time: '09:00', starts_at: past.starts_at + 3600_000 }, TZ, NOW)).toBeNull();
  });
  it('notifies both old and new audience', () => {
    const n = changeNotification(ev({ audience: ['a'] }), ev({ audience: ['b'], local_time: '09:00' }), TZ, NOW)!;
    expect(n.audience!.sort()).toEqual(['a', 'b']);
    expect(changeNotification(ev({ audience: ['a'] }), ev({ local_time: '09:00' }), TZ, NOW)!.audience).toBeNull();
  });
});
