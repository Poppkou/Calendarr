import { Hono } from 'hono';
import { runDispatch, insertNotificationStmt } from '../dispatch';
import { toDto, type EventRow } from '../events';
import { eventType } from '../schedule';
import { tzLabel } from '../time';
import { bad, HttpError, newId, normalizeCode, formatCode, type Env } from '../util';
import { readJson } from './common';

export const tourist = new Hono<{ Bindings: Env }>();

export interface TouristCtx {
  participant_id: string; participant_name: string; code: string; token: string;
  group_id: string; group_title: string; tz: string; home_tz: string; start_date: string; end_date: string;
  guide_name: string; guide_phone: string; group_notes: string; version: number; archived: number;
  agency_name: string; brand_color: string; agency_phone: string; last_seen_at: number | null;
}

export async function loadTourist(db: D1Database, token: string): Promise<TouristCtx> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw new HttpError(404, 'Ссылка недействительна');
  const r = await db.prepare(`SELECT p.id AS participant_id, p.name AS participant_name, p.code, p.token, p.last_seen_at,
        g.id AS group_id, g.title AS group_title, g.tz, g.home_tz, g.start_date, g.end_date, g.guide_name, g.guide_phone,
        g.notes AS group_notes, g.version, g.archived,
        a.name AS agency_name, a.brand_color, a.phone AS agency_phone
      FROM participants p JOIN groups g ON g.id = p.group_id JOIN agencies a ON a.id = g.agency_id
      WHERE p.token = ? AND p.revoked = 0`).bind(token).first<TouristCtx>();
  if (!r) throw new HttpError(404, 'Ссылка недействительна или отключена турфирмой');
  return r;
}

export async function touristEvents(db: D1Database, t: TouristCtx): Promise<EventRow[]> {
  return (await db.prepare(`SELECT * FROM events WHERE group_id = ?
      AND (audience IS NULL OR EXISTS (SELECT 1 FROM json_each(events.audience) WHERE value = ?))
      ORDER BY starts_at, created_at`).bind(t.group_id, t.participant_id).all<EventRow>()).results;
}

tourist.get('/code/:code', async (c) => {
  const code = normalizeCode(c.req.param('code'));
  if (code.length !== 8) throw bad('Код состоит из 8 символов');
  const r = await c.env.DB.prepare('SELECT token FROM participants WHERE code = ? AND revoked = 0').bind(code).first<{ token: string }>();
  if (!r) throw new HttpError(404, 'Код не найден. Проверьте, нет ли опечатки.');
  return c.json({ token: r.token });
});

tourist.get('/t/:token', async (c) => {
  const db = c.env.DB;
  const t = await loadTourist(db, c.req.param('token'));
  const now = Date.now();
  const [events, ch] = await Promise.all([
    touristEvents(db, t),
    db.prepare(`SELECT kind, COUNT(*) AS n FROM channels WHERE participant_id = ? AND active = 1 GROUP BY kind`)
      .bind(t.participant_id).all<{ kind: string; n: number }>(),
  ]);
  if (!t.last_seen_at || t.last_seen_at < now - 10 * 60_000) {
    c.executionCtx.waitUntil(db.prepare('UPDATE participants SET last_seen_at = ? WHERE id = ?').bind(now, t.participant_id).run().catch(() => {}));
  }
  const tzs = new Set([t.tz, t.home_tz, ...events.map((e) => e.tz)]);
  c.header('Cache-Control', 'no-store');
  return c.json({
    serverTime: now,
    participant: { id: t.participant_id, name: t.participant_name, code: formatCode(t.code) },
    group: {
      id: t.group_id, title: t.group_title, tz: t.tz, home_tz: t.home_tz, start_date: t.start_date, end_date: t.end_date,
      guide_name: t.guide_name, guide_phone: t.guide_phone, notes: t.group_notes, version: t.version, archived: !!t.archived,
    },
    agency: { name: t.agency_name, brand_color: t.brand_color, phone: t.agency_phone },
    tzLabels: Object.fromEntries([...tzs].map((z) => [z, tzLabel(z)])),
    events: events.map((r) => {
      const { audience, leads, group_id, created_at, ...rest } = toDto(r);
      return { ...rest, leads, icon: eventType(r.type).icon, type_name: eventType(r.type).name };
    }),
    channels: Object.fromEntries(ch.results.map((x) => [x.kind, x.n])),
    push: { vapidPublicKey: c.env.VAPID_PUBLIC_KEY ?? null },
    telegram: c.env.TELEGRAM_BOT_USERNAME && c.env.TELEGRAM_BOT_TOKEN
      ? { url: `https://t.me/${c.env.TELEGRAM_BOT_USERNAME}?start=${t.token}` } : null,
  });
});

function validSubscription(b: any): { endpoint: string; keys: { p256dh: string; auth: string } } {
  const endpoint = b?.endpoint, p256dh = b?.keys?.p256dh, auth = b?.keys?.auth;
  if (typeof endpoint !== 'string' || endpoint.length > 1000) throw bad('Некорректная подписка');
  let u: URL;
  try { u = new URL(endpoint); } catch { throw bad('Некорректная подписка'); }
  if (u.protocol !== 'https:' || /^[\d.]+$|^\[|^localhost$/i.test(u.hostname)) throw bad('Некорректная подписка');
  if (typeof p256dh !== 'string' || !/^[A-Za-z0-9_-]{80,100}$/.test(p256dh)) throw bad('Некорректный ключ подписки');
  if (typeof auth !== 'string' || !/^[A-Za-z0-9_-]{16,40}$/.test(auth)) throw bad('Некорректный ключ подписки');
  return { endpoint, keys: { p256dh, auth } };
}

tourist.post('/t/:token/webpush', async (c) => {
  const db = c.env.DB;
  const t = await loadTourist(db, c.req.param('token'));
  const sub = validSubscription(await readJson(c));
  const now = Date.now();
  const cnt = await db.prepare(`SELECT COUNT(*) AS n FROM channels WHERE participant_id = ? AND kind = 'webpush' AND active = 1 AND address <> ?`)
    .bind(t.participant_id, sub.endpoint).first<{ n: number }>();
  if ((cnt?.n ?? 0) >= 10) {
    // Слишком много устройств — отключаем самое старое.
    await db.prepare(`UPDATE channels SET active = 0 WHERE id = (SELECT id FROM channels WHERE participant_id = ? AND kind = 'webpush' AND active = 1 ORDER BY updated_at LIMIT 1)`)
      .bind(t.participant_id).run();
  }
  await db.prepare(`INSERT INTO channels (id, participant_id, kind, address, data, active, fail_count, created_at, updated_at)
      VALUES (?, ?, 'webpush', ?, ?, 1, 0, ?, ?)
      ON CONFLICT (participant_id, kind, address) DO UPDATE SET data = excluded.data, active = 1, fail_count = 0, updated_at = excluded.updated_at`)
    .bind(newId(), t.participant_id, sub.endpoint, JSON.stringify({ keys: sub.keys }), now, now).run();
  return c.json({ ok: true });
});

tourist.post('/t/:token/webpush/remove', async (c) => {
  const t = await loadTourist(c.env.DB, c.req.param('token'));
  const b = await readJson(c);
  if (typeof b.endpoint !== 'string') throw bad('endpoint обязателен');
  await c.env.DB.prepare(`UPDATE channels SET active = 0, updated_at = ? WHERE participant_id = ? AND kind = 'webpush' AND address = ?`)
    .bind(Date.now(), t.participant_id, b.endpoint).run();
  return c.json({ ok: true });
});

tourist.post('/t/:token/test', async (c) => {
  const db = c.env.DB;
  const t = await loadTourist(db, c.req.param('token'));
  const now = Date.now();
  const recent = await db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE group_id = ? AND kind = 'test' AND created_at > ? AND audience = ?`)
    .bind(t.group_id, now - 60_000, JSON.stringify([t.participant_id])).first<{ n: number }>();
  if ((recent?.n ?? 0) >= 2) throw new HttpError(429, 'Подождите минуту перед следующей проверкой');
  await insertNotificationStmt(db, {
    group_id: t.group_id, event_id: null, kind: 'test', lead_min: null, audience: [t.participant_id],
    fire_at: now, expires_at: now + 10 * 60_000, title: '🔔 Проверка уведомлений',
    body: `Всё работает! Напоминания по туру «${t.group_title}» будут приходить сюда.`, urgent: true,
  }, now).run();
  const stats = await runDispatch(c.env);
  return c.json({ ok: true, sent: stats.sent });
});

// Экспорт в календарь телефона: напоминания календаря работают даже без интернета.
tourist.get('/t/:token/calendar.ics', async (c) => {
  const t = await loadTourist(c.env.DB, c.req.param('token'));
  const events = await touristEvents(c.env.DB, t);
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const utc = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const fold = (line: string) => {
    const out: string[] = [];
    let s = line;
    while (s.length > 74) { out.push(s.slice(0, 74)); s = ' ' + s.slice(74); }
    out.push(s);
    return out.join('\r\n');
  };
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Pulse Tour//RU', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(t.group_title)}`];
  const stamp = utc(Date.now());
  for (const r of events) {
    if (r.cancelled) continue;
    const e = toDto(r);
    lines.push('BEGIN:VEVENT', `UID:${e.id}@pulse-tour`, `DTSTAMP:${stamp}`, `SEQUENCE:${e.rev}`);
    if (e.local_time) {
      lines.push(`DTSTART:${utc(e.starts_at)}`, `DTEND:${utc(e.starts_at + Math.max(e.duration_min, 15) * 60_000)}`);
    } else {
      const d = e.local_date.replace(/-/g, '');
      const next = new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6) + 1)).toISOString().slice(0, 10).replace(/-/g, '');
      lines.push(`DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${next}`);
    }
    const title = `${eventType(e.type).icon} ${e.title}${e.flight_no && !e.title.includes(e.flight_no) ? ' ' + e.flight_no : ''}`;
    lines.push(`SUMMARY:${esc(title)}`);
    const loc = [e.meeting_point && `Сбор: ${e.meeting_point}`, e.location, e.address].filter(Boolean).join(', ');
    if (loc) lines.push(`LOCATION:${esc(loc)}`);
    if (e.notes) lines.push(`DESCRIPTION:${esc(e.notes)}`);
    if (e.map_url) lines.push(`URL:${esc(e.map_url)}`);
    if (e.local_time) {
      for (const lead of e.leads.slice(0, 3)) {
        lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(title)}`, `TRIGGER:-PT${lead}M`, 'END:VALARM');
      }
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return new Response(lines.map(fold).join('\r\n') + '\r\n', {
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': `attachment; filename="tour.ics"`,
      'cache-control': 'no-store',
    },
  });
});

export function manifestFor(t: TouristCtx, token: string) {
  return {
    name: `${t.group_title} — ${t.agency_name}`,
    short_name: t.group_title.slice(0, 24),
    description: `Расписание тура от ${t.agency_name}`,
    id: `/t/${token}/`,
    start_url: `/t/${token}/`,
    scope: `/t/${token}/`,
    display: 'standalone',
    background_color: '#0b0d12',
    theme_color: /^#[0-9a-f]{6}$/i.test(t.brand_color) ? t.brand_color : '#6366f1',
    icons: [
      { src: '/app/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: '/app/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  };
}
export const _test = { validSubscription };
