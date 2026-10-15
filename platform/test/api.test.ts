import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { runDispatch } from '../src/dispatch';
import { b64url, generateVapidKeys } from '../src/push';
import { zonedToUtc } from '../src/time';
import type { Env } from '../src/util';
import { createD1 } from './d1shim';

const TZ = 'Europe/Istanbul';
const T0 = zonedToUtc('2026-05-10', '12:00', TZ);

interface Sent { url: string; body: any; kind: 'push' | 'tg' }

async function setup() {
  const db = createD1();
  const vapid = await generateVapidKeys();
  const env: Env = {
    DB: db, ASSETS: { fetch: async () => new Response('<html>app</html>', { headers: { 'content-type': 'text/html' } }) } as any,
    VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: 'mailto:t@t.t',
    TELEGRAM_BOT_TOKEN: 'bot123', TELEGRAM_BOT_USERNAME: 'PulseTourBot', TELEGRAM_WEBHOOK_SECRET: 'whsecret',
    SETUP_KEY: 'setup-key-1234567890', PUBLIC_URL: 'https://tour.example.com',
  };
  const sent: Sent[] = [];
  let pushStatus = 201;
  const waits: Promise<unknown>[] = [];
  const fetchMock = vi.fn(async (input: any, init?: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://api.telegram.org/')) {
      sent.push({ url, body: JSON.parse(init.body), kind: 'tg' });
      return Response.json({ ok: true, result: {} });
    }
    sent.push({ url, body: init?.body, kind: 'push' });
    return new Response('', { status: pushStatus });
  });
  vi.stubGlobal('fetch', fetchMock);

  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const req = new Request(`https://tour.example.com${path}`, {
      method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const res = await worker.fetch(req, env, { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException() {} } as any);
    await Promise.all(waits.splice(0));
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, res };
  };

  const makeAgency = async (email: string) => {
    expect((await call('POST', '/api/auth/setup', { setupKey: env.SETUP_KEY, agencyName: 'Солнце Тур', email, password: 'password123' })).status).toBe(200);
    const login = await call('POST', '/api/auth/login', { email, password: 'password123' });
    expect(login.status).toBe(200);
    const H = { authorization: `Bearer ${login.json.token}` };
    return {
      H,
      get: (p: string) => call('GET', `/api/admin${p}`, undefined, H),
      post: (p: string, b: unknown) => call('POST', `/api/admin${p}`, b, H),
      patch: (p: string, b: unknown) => call('PATCH', `/api/admin${p}`, b, H),
      del: (p: string) => call('DELETE', `/api/admin${p}`, undefined, H),
    };
  };

  const browserSub = async (n = 1) => {
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
    const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey) as ArrayBuffer);
    return { endpoint: `https://fcm.googleapis.com/fcm/send/device${n}`, keys: { p256dh: b64url.encode(pub), auth: b64url.encode(crypto.getRandomValues(new Uint8Array(16))) } };
  };

  return {
    db, env, sent, call, makeAgency, browserSub,
    setPushStatus: (s: number) => { pushStatus = s; },
    dispatch: () => runDispatch(env),
  };
}

let S: Awaited<ReturnType<typeof setup>>;
const at = (date: string, time: string) => vi.setSystemTime(zonedToUtc(date, time, TZ));

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  S = await setup();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

async function tourWithTwoTourists() {
  const A = await S.makeAgency('boss@sun.tour');
  const g = await A.post('/groups', { title: 'Стамбул 12–17 мая', tz: TZ, start_date: '2026-05-12', end_date: '2026-05-17', guide_name: 'Айше', guide_phone: '+90 555' });
  expect(g.status).toBe(200);
  const gid = g.json.id;
  expect((await A.post(`/groups/${gid}/participants`, { names: ['Иван', 'Мария'] })).json.added).toBe(2);
  const detail = await A.get(`/groups/${gid}`);
  const [ivan, maria] = detail.json.participants;
  return { A, gid, ivan, maria };
}

describe('full flow', () => {
  it('office creates schedule → tourist subscribes → reminders and change notices arrive exactly once', async () => {
    const { A, gid, ivan } = await tourWithTwoTourists();
    const ev = await A.post(`/groups/${gid}/events`, { type: 'transfer', title: 'Трансфер в аэропорт', local_date: '2026-05-14', local_time: '08:00', meeting_point: 'Лобби' });
    expect(ev.status).toBe(200);
    expect(ev.json.event.leads).toEqual([720, 60, 15]);

    // Турист открывает ссылку
    const page = await S.call('GET', `/t/${ivan.token}/`);
    expect(page.status).toBe(200);
    const t = await S.call('GET', `/api/t/${ivan.token}`);
    expect(t.status).toBe(200);
    expect(t.json.group.title).toBe('Стамбул 12–17 мая');
    expect(t.json.events).toHaveLength(1);
    expect(t.json.events[0]).not.toHaveProperty('audience');
    expect(t.json.telegram.url).toBe(`https://t.me/PulseTourBot?start=${ivan.token}`);
    const mf = await S.call('GET', `/t/${ivan.token}/manifest.webmanifest`);
    expect(mf.json.start_url).toBe(`/t/${ivan.token}/`);

    // Подписки: веб-пуш и Telegram
    expect((await S.call('POST', `/api/t/${ivan.token}/webpush`, await S.browserSub())).status).toBe(200);
    const tg = await S.call('POST', '/api/telegram/webhook', { update_id: 1, message: { message_id: 1, text: `/start ${ivan.token}`, chat: { id: 777, type: 'private' } } },
      { 'x-telegram-bot-api-secret-token': 'whsecret' });
    expect(tg.status).toBe(200);
    expect(S.sent.pop()!.body.text).toContain('Готово');
    expect((await S.call('GET', `/api/t/${ivan.token}`)).json.channels).toEqual({ webpush: 1, telegram: 1 });

    // Ничего не уходит раньше времени
    await S.dispatch();
    expect(S.sent).toHaveLength(0);

    // Вечер накануне (20:00) — напоминание за 12 ч: 1 пуш + 1 Telegram (у Марии каналов нет)
    at('2026-05-13', '20:00');
    const st = await S.dispatch();
    expect(st).toMatchObject({ fanned: 1, sent: 2 });
    expect(S.sent.map((x) => x.kind).sort()).toEqual(['push', 'tg']);
    const tgMsg = S.sent.find((x) => x.kind === 'tg')!.body;
    expect(tgMsg.chat_id).toBe('777');
    expect(tgMsg.text).toContain('Завтра в 08:00');
    expect(tgMsg.reply_markup.inline_keyboard[0][0].url).toBe(`https://tour.example.com/t/${ivan.token}/`);

    // Повторный запуск — дублей нет
    S.sent.length = 0;
    await S.dispatch();
    expect(S.sent).toHaveLength(0);

    // Менеджер переносит трансфер — уведомление «Изменение» уходит сразу
    const upd = await A.patch(`/events/${ev.json.event.id}`, { local_time: '07:30', rev: 1 });
    expect(upd.json.notified).toBe(true);
    expect(S.sent).toHaveLength(2);
    expect(S.sent.find((x) => x.kind === 'tg')!.body.text).toContain('Новое время: завтра в 07:30 (было завтра в 08:00)');
    // Устаревшая версия формы — конфликт
    expect((await A.patch(`/events/${ev.json.event.id}`, { local_time: '07:00', rev: 1 })).status).toBe(409);

    // Напоминание за 60 мин считается уже от нового времени (06:30)
    S.sent.length = 0;
    at('2026-05-14', '06:30');
    await S.dispatch();
    expect(S.sent).toHaveLength(2);
    expect(S.sent.find((x) => x.kind === 'tg')!.body.text).toContain('через 1 ч');

    // Журнал в админке
    const log = await A.get(`/groups/${gid}/notifications`);
    expect(log.json.notifications.filter((n: any) => n.sent > 0)).toHaveLength(3);
  });

  it('silent edit does not notify; cancellation does', async () => {
    const { A, gid, ivan } = await tourWithTwoTourists();
    await S.call('POST', `/api/t/${ivan.token}/webpush`, await S.browserSub());
    const ev = await A.post(`/groups/${gid}/events`, { type: 'excursion', title: 'Айя-София', local_date: '2026-05-13', local_time: '10:00' });
    expect((await A.patch(`/events/${ev.json.event.id}`, { local_time: '11:00', notify: false })).json.notified).toBe(false);
    expect(S.sent).toHaveLength(0);
    expect((await A.patch(`/events/${ev.json.event.id}`, { cancelled: true })).json.notified).toBe(true);
    expect(S.sent).toHaveLength(1);
    // После отмены напоминаний нет
    S.sent.length = 0;
    at('2026-05-13', '10:30');
    await S.dispatch();
    expect(S.sent).toHaveLength(0);
  });
});

describe('reliability', () => {
  it('disables dead subscriptions, retries temporary failures, recovers crashed runs', async () => {
    const { A, gid, ivan, maria } = await tourWithTwoTourists();
    await S.call('POST', `/api/t/${ivan.token}/webpush`, await S.browserSub(1));
    await S.call('POST', `/api/t/${maria.token}/webpush`, await S.browserSub(2));
    await A.post(`/groups/${gid}/events`, { type: 'meeting', title: 'Сбор', local_date: '2026-05-12', local_time: '09:00', leads: [30, 10] });

    // 503 → повтор с паузой
    at('2026-05-12', '08:30');
    S.setPushStatus(503);
    expect(await S.dispatch()).toMatchObject({ sent: 0, retried: 2 });
    S.setPushStatus(201);
    expect((await S.dispatch()).claimed).toBe(0); // пауза ещё не прошла
    vi.setSystemTime(Date.now() + 31_000);
    expect(await S.dispatch()).toMatchObject({ sent: 2 });

    // 410 → подписка отключена, больше не используется
    S.setPushStatus(410);
    at('2026-05-12', '08:50');
    expect(await S.dispatch()).toMatchObject({ gone: 2 });
    const ch = S.db.raw.prepare(`SELECT COUNT(*) AS n FROM channels WHERE active = 1`).get() as any;
    expect(ch.n).toBe(0);
    expect((await S.call('GET', `/api/t/${ivan.token}`)).json.channels).toEqual({});
  });

  it('re-sends a delivery stuck in "sending" after the lease expires (crashed run)', async () => {
    const { A, gid, ivan } = await tourWithTwoTourists();
    await S.call('POST', `/api/t/${ivan.token}/webpush`, await S.browserSub());
    await A.post(`/groups/${gid}/events`, { type: 'meeting', title: 'Сбор', local_date: '2026-05-12', local_time: '09:00', leads: [30] });
    at('2026-05-12', '08:30');
    // Имитируем: запуск захватил доставку и упал, не отправив
    await S.db.batch([
      S.db.prepare(`INSERT INTO deliveries (id, notification_id, channel_id, status, attempts, next_attempt_at)
        SELECT 'd1', n.id, c.id, 'sending', 1, ? FROM notifications n, channels c`).bind(Date.now() + 5 * 60_000),
      S.db.prepare(`UPDATE notifications SET status = 'fanned'`),
    ]);
    expect((await S.dispatch()).sent).toBe(0);
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
    expect((await S.dispatch()).sent).toBe(1);
    expect((await S.dispatch()).sent).toBe(0);
  });

  it('does not send stale reminders after a long outage', async () => {
    const { A, gid, ivan } = await tourWithTwoTourists();
    await S.call('POST', `/api/t/${ivan.token}/webpush`, await S.browserSub());
    await A.post(`/groups/${gid}/events`, { type: 'meeting', title: 'Сбор', local_date: '2026-05-12', local_time: '09:00', leads: [120, 30] });
    at('2026-05-12', '08:45'); // планировщик «лежал» с 06:59
    const st = await S.dispatch();
    expect(st.sent).toBe(1); // только актуальное «за 30 мин», «за 2 ч» пропущено
    expect(S.db.raw.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE status = 'skipped'`).get()).toMatchObject({ n: 1 });
  });

  it('respects MAX_SENDS_PER_RUN and finishes in the next run', async () => {
    const { A, gid } = await tourWithTwoTourists();
    await A.post(`/groups/${gid}/participants`, { count: 8 });
    const d = await A.get(`/groups/${gid}`);
    let i = 0;
    for (const p of d.json.participants) await S.call('POST', `/api/t/${p.token}/webpush`, await S.browserSub(++i));
    S.env.MAX_SENDS_PER_RUN = '4';
    await A.post(`/groups/${gid}/broadcast`, { text: 'Автобус задерживается на 15 минут' });
    const total = () => (S.db.raw.prepare(`SELECT COUNT(*) AS n FROM deliveries WHERE status = 'sent'`).get() as any).n;
    expect(total()).toBe(4);
    await S.dispatch();
    await S.dispatch();
    expect(total()).toBe(10);
    expect(S.sent).toHaveLength(10);
  });
});

describe('audience, isolation, security', () => {
  it('targets events to selected tourists only', async () => {
    const { A, gid, ivan, maria } = await tourWithTwoTourists();
    await S.call('POST', `/api/t/${ivan.token}/webpush`, await S.browserSub(1));
    await S.call('POST', `/api/t/${maria.token}/webpush`, await S.browserSub(2));
    await A.post(`/groups/${gid}/events`, { type: 'excursion', title: 'Каппадокия (доп.)', local_date: '2026-05-13', local_time: '05:00', leads: [60], audience: [maria.id] });
    expect((await S.call('GET', `/api/t/${ivan.token}`)).json.events).toHaveLength(0);
    expect((await S.call('GET', `/api/t/${maria.token}`)).json.events).toHaveLength(1);
    at('2026-05-13', '04:00');
    expect((await S.dispatch()).sent).toBe(1);
    expect(S.sent[0].url).toContain('device2');
  });

  it('isolates agencies from each other', async () => {
    const { gid } = await tourWithTwoTourists();
    const B = await S.makeAgency('other@agency.ru');
    expect((await B.get(`/groups/${gid}`)).status).toBe(404);
    expect((await B.post(`/groups/${gid}/events`, { title: 'x', local_date: '2026-05-13', local_time: '10:00' })).status).toBe(404);
    expect((await B.get('/groups')).json.groups).toHaveLength(0);
    expect((await S.call('GET', '/api/admin/groups')).status).toBe(401);
  });

  it('revoked or regenerated links stop working', async () => {
    const { A, ivan } = await tourWithTwoTourists();
    await A.patch(`/participants/${ivan.id}`, { revoked: true });
    expect((await S.call('GET', `/api/t/${ivan.token}`)).status).toBe(404);
    await A.patch(`/participants/${ivan.id}`, { revoked: false, regenerate: true });
    expect((await S.call('GET', `/api/t/${ivan.token}`)).status).toBe(404);
  });

  it('finds a tourist by short code', async () => {
    const { ivan } = await tourWithTwoTourists();
    const r = await S.call('GET', `/api/code/${ivan.code.toLowerCase()}`);
    expect(r.json.token).toBe(ivan.token);
    expect((await S.call('GET', '/api/code/AAAA-AAAA')).status).toBe(404);
  });

  it('rate-limits logins and rejects bad setup keys and webhook secrets', async () => {
    await S.makeAgency('boss@sun.tour');
    for (let i = 0; i < 10; i++) expect((await S.call('POST', '/api/auth/login', { email: 'boss@sun.tour', password: 'wrong' })).status).toBe(401);
    expect((await S.call('POST', '/api/auth/login', { email: 'boss@sun.tour', password: 'password123' })).status).toBe(429);
    expect((await S.call('POST', '/api/auth/setup', { setupKey: 'nope', agencyName: 'x', email: 'a@b.cc', password: '12345678' })).status).toBe(403);
    expect((await S.call('POST', '/api/telegram/webhook', { update_id: 1 }, { 'x-telegram-bot-api-secret-token': 'bad' })).status).toBe(403);
  });

  it('validates input', async () => {
    const { A, gid, ivan } = await tourWithTwoTourists();
    expect((await A.post(`/groups/${gid}/events`, { title: '', local_date: '2026-05-13' })).status).toBe(400);
    expect((await A.post(`/groups/${gid}/events`, { title: 'x', local_date: '2026-02-30' })).status).toBe(400);
    expect((await A.post(`/groups/${gid}/events`, { title: 'x', local_date: '2026-05-13', local_time: '25:00' })).status).toBe(400);
    expect((await A.post(`/groups/${gid}/events`, { title: 'x', local_date: '2026-05-13', tz: 'Nowhere/City' })).status).toBe(400);
    expect((await A.post(`/groups/${gid}/events`, { title: 'x', local_date: '2026-05-13', audience: ['foreign-id'] })).status).toBe(400);
    expect((await A.post(`/groups/${gid}/events`, { title: 'x', local_date: '2026-05-13', map_url: 'javascript:alert(1)' })).status).toBe(400);
    expect((await S.call('POST', `/api/t/${ivan.token}/webpush`, { endpoint: 'http://127.0.0.1/x', keys: {} })).status).toBe(400);
    const bad = await S.call('POST', '/api/admin/groups', '{oops', A.H);
    expect(bad.status).toBe(400);
  });
});

describe('group features', () => {
  it('copies a group to new dates with reminders', async () => {
    const { A, gid } = await tourWithTwoTourists();
    await A.post(`/groups/${gid}/events`, { type: 'flight', title: 'Вылет', flight_no: 'tk 414', local_date: '2026-05-12', local_time: '06:00', tz: 'Europe/Moscow' });
    await A.post(`/groups/${gid}/events`, { type: 'excursion', title: 'Босфор', local_date: '2026-05-13', local_time: '14:00' });
    const copy = await A.post(`/groups/${gid}/copy`, { start_date: '2026-06-02', title: 'Стамбул 2–7 июня' });
    const d = await A.get(`/groups/${copy.json.id}`);
    expect(d.json.group.end_date).toBe('2026-06-07');
    expect(d.json.participants).toHaveLength(0);
    expect(d.json.events.map((e: any) => [e.local_date, e.local_time, e.tz, e.flight_no])).toEqual([
      ['2026-06-02', '06:00', 'Europe/Moscow', 'TK 414'], ['2026-06-03', '14:00', TZ, ''],
    ]);
    const n = S.db.raw.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE group_id = ?`).get(copy.json.id) as any;
    expect(n.n).toBe(5);
  });

  it('archived groups stop sending reminders', async () => {
    const { A, gid, ivan } = await tourWithTwoTourists();
    await S.call('POST', `/api/t/${ivan.token}/webpush`, await S.browserSub());
    await A.post(`/groups/${gid}/events`, { title: 'Ужин', local_date: '2026-05-12', local_time: '19:00', leads: [30] });
    await A.patch(`/groups/${gid}`, { archived: true });
    at('2026-05-12', '18:30');
    expect((await S.dispatch()).sent).toBe(0);
  });

  it('exports an iCalendar file with alarms', async () => {
    const { A, gid, ivan } = await tourWithTwoTourists();
    await A.post(`/groups/${gid}/events`, { type: 'excursion', title: 'Босфор, круиз', local_date: '2026-05-13', local_time: '14:00' });
    await A.post(`/groups/${gid}/events`, { type: 'free', title: 'Свободный день', local_date: '2026-05-15' });
    const r = await S.call('GET', `/api/t/${ivan.token}/calendar.ics`);
    expect(r.res.headers.get('content-type')).toContain('text/calendar');
    expect(r.text).toContain('DTSTART:20260513T110000Z');
    expect(r.text).toContain('SUMMARY:🏛️ Босфор\\, круиз');
    expect(r.text).toContain('TRIGGER:-PT720M');
    expect(r.text).toContain('DTSTART;VALUE=DATE:20260515');
  });

  it('tourist test notification is delivered and rate-limited', async () => {
    const { ivan } = await tourWithTwoTourists();
    await S.call('POST', `/api/t/${ivan.token}/webpush`, await S.browserSub());
    expect((await S.call('POST', `/api/t/${ivan.token}/test`)).json.sent).toBe(1);
    await S.call('POST', `/api/t/${ivan.token}/test`);
    expect((await S.call('POST', `/api/t/${ivan.token}/test`)).status).toBe(429);
  });

  it('health reports scheduler state', async () => {
    expect((await S.call('GET', '/api/health')).status).toBe(503);
    await S.dispatch();
    expect((await S.call('GET', '/api/health')).json.ok).toBe(true);
  });
});
