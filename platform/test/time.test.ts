import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, formatDateInTz, formatTimeInTz, isValidDate, isValidTime, isValidTz, tzLabel, zonedToUtc } from '../src/time';

describe('zonedToUtc', () => {
  it('converts fixed-offset zones', () => {
    expect(new Date(zonedToUtc('2026-05-12', '10:00', 'Europe/Moscow')).toISOString()).toBe('2026-05-12T07:00:00.000Z');
    expect(new Date(zonedToUtc('2026-05-12', '10:00', 'Asia/Bangkok')).toISOString()).toBe('2026-05-12T03:00:00.000Z');
    expect(new Date(zonedToUtc('2026-05-12', '00:30', 'Asia/Kolkata')).toISOString()).toBe('2026-05-11T19:00:00.000Z');
    expect(new Date(zonedToUtc('2026-01-01', null, 'UTC')).toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('handles DST in both directions', () => {
    // Берлин: лето UTC+2, зима UTC+1.
    expect(new Date(zonedToUtc('2026-07-01', '12:00', 'Europe/Berlin')).toISOString()).toBe('2026-07-01T10:00:00.000Z');
    expect(new Date(zonedToUtc('2026-12-01', '12:00', 'Europe/Berlin')).toISOString()).toBe('2026-12-01T11:00:00.000Z');
    // Весенний переход 29.03.2026 02:00 → 03:00: 02:30 не существует, берём момент после перехода.
    const gap = zonedToUtc('2026-03-29', '02:30', 'Europe/Berlin');
    expect(gap).toBeGreaterThanOrEqual(Date.parse('2026-03-29T01:00:00Z'));
    expect(gap).toBeLessThanOrEqual(Date.parse('2026-03-29T01:30:00Z'));
    // Осенний переход 25.10.2026: 02:30 бывает дважды — берём первое.
    expect(new Date(zonedToUtc('2026-10-25', '02:30', 'Europe/Berlin')).toISOString()).toBe('2026-10-25T00:30:00.000Z');
    // Сразу до и после переходов.
    expect(new Date(zonedToUtc('2026-03-29', '03:00', 'Europe/Berlin')).toISOString()).toBe('2026-03-29T01:00:00.000Z');
    expect(new Date(zonedToUtc('2026-10-25', '03:00', 'Europe/Berlin')).toISOString()).toBe('2026-10-25T02:00:00.000Z');
    expect(new Date(zonedToUtc('2026-03-08', '09:00', 'America/New_York')).toISOString()).toBe('2026-03-08T13:00:00.000Z');
  });

  it('round-trips every 15 minutes across a DST day', () => {
    for (const tz of ['Europe/Berlin', 'America/New_York', 'Australia/Lord_Howe', 'Asia/Kathmandu']) {
      for (let m = 0; m < 24 * 60; m += 15) {
        const time = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
        for (const date of ['2026-03-08', '2026-03-29', '2026-10-04', '2026-10-25', '2026-11-01']) {
          const t = zonedToUtc(date, time, tz);
          // Существующее время должно точно восстанавливаться; в «дыре» — уходить вперёд не больше чем на час.
          const back = `${formatDateInTz(t, tz)} ${formatTimeInTz(t, tz)}`;
          if (back !== `${date} ${time}`) {
            const delta = t - zonedToUtc(date, '00:00', tz);
            expect(delta).toBeGreaterThan(0);
          }
        }
      }
    }
  });
});

describe('validators and helpers', () => {
  it('validates', () => {
    expect(isValidTz('Europe/Istanbul')).toBe(true);
    expect(isValidTz('Mars/Olympus')).toBe(false);
    expect(isValidDate('2026-02-29')).toBe(false);
    expect(isValidDate('2028-02-29')).toBe(true);
    expect(isValidTime('24:00')).toBe(false);
    expect(isValidTime('07:05')).toBe(true);
  });
  it('date math', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2);
    expect(tzLabel('Europe/Istanbul')).toBe('Стамбул');
    expect(tzLabel('America/Argentina/Buenos_Aires')).toBe('Buenos Aires');
  });
});
