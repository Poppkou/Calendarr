import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { zonedToUtc } from '../src/time';
import { askReviews } from '../src/reviews';
import { setup, TZ, T0 } from './helpers';

let S: Awaited<ReturnType<typeof setup>>;
const at = (date: string, time: string) => vi.setSystemTime(zonedToUtc(date, time, TZ));
const WH = { 'x-telegram-bot-api-secret-token': 'whsecret' };
let updateId = 1;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  S = await setup();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const tg = () => S.sent.filter((x) => x.kind === 'tg');
const tgTo = (chat: string) => tg().filter((x) => String(x.body.chat_id) === chat && x.url.endsWith('/sendMessage')).map((x) => x.body);
const say = (chat: number, text: string, extra: Record<string, unknown> = {}) =>
  S.call('POST', '/api/telegram/webhook', { update_id: updateId++, message: { message_id: updateId, text, chat: { id: chat, type: 'private' }, ...extra } }, WH);
const press = (chat: number, data: string, messageId = 1) =>
  S.call('POST', '/api/telegram/webhook', { update_id: updateId++, callback_query: { id: 'cb' + updateId, data, from: { id: chat }, message: { message_id: messageId, chat: { id: chat, type: 'private' } } } }, WH);

async function tour() {
  const A = await S.makeAgency('boss@sun.tour');
  const g = await A.post('/groups', { title: 'Стамбул 12–17 мая', tz: TZ, start_date: '2026-05-12', end_date: '2026-05-17', guide_name: 'Айше', guide_phone: '+90 555' });
  const gid = g.json.id;
  await A.post(`/groups/${gid}/participants`, { names: ['Иван Петров', 'Мария'] });
  const [ivan, maria] = (await A.get(`/groups/${gid}`)).json.participants;
  await A.post(`/groups/${gid}/events`, { type: 'excursion', title: 'Босфор', local_date: '2026-05-13', local_time: '10:00', meeting_point: 'Лобби' });
  // Менеджер подключает Telegram для обращений
  const link = await A.post('/telegram/link', {});
  expect(link.json.url).toMatch(/^https:\/\/t\.me\/PulseTourBot\?start=s_/);
  await say(500, `/start ${link.json.url.split('start=')[1]}`);
  expect((await A.get('/me')).json.staff.telegram).toBe(true);
  S.sent.length = 0;
  return { A, gid, ivan, maria };
}

describe('сообщения турфирмы видны туристу (баг)', () => {
  it('срочное объявление и личный ответ появляются в ленте туриста, чужие — нет', async () => {
    const { A, gid, ivan, maria } = await tour();
    await A.post(`/groups/${gid}/broadcast`, { text: 'Автобус задерживается на 15 минут' });
    await A.post(`/groups/${gid}/broadcast`, { text: 'Только для Марии', audience: [maria.id] });
    const iv = (await S.call('GET', `/api/t/${ivan.token}`)).json;
    expect(iv.messages.map((m: any) => m.body)).toEqual(['Автобус задерживается на 15 минут']);
    expect(iv.messages[0].title).toBe('📣 Стамбул 12–17 мая');
    const ma = (await S.call('GET', `/api/t/${maria.token}`)).json;
    expect(ma.messages.map((m: any) => m.body)).toEqual(['Только для Марии', 'Автобус задерживается на 15 минут']);
  });
});

describe('«Я опаздываю» / «Нужна помощь»', () => {
  it('с сайта: менеджер получает в Telegram, принимает, отвечает — турист видит всё в ленте', async () => {
    const { A, ivan } = await tour();
    at('2026-05-13', '09:50');
    const r = await S.call('POST', `/api/t/${ivan.token}/alert`, { kind: 'late', minutes: 10, text: 'Застрял в пробке', contact: '+7 900 000-00-00' });
    expect(r.status).toBe(200);
    const [staffMsg] = tgTo('500');
    expect(staffMsg.text).toContain('⏰ Опаздывает на 10 мин');
    expect(staffMsg.text).toContain('Иван Петров · Стамбул 12–17 мая');
    expect(staffMsg.text).toContain('«Застрял в пробке»');
    expect(staffMsg.text).toContain('Телефон туриста: +7 900 000-00-00');
    expect(staffMsg.text).toContain('Ближайшее: сегодня в 10:00 🏛️ Босфор (Лобби)');
    expect(staffMsg.reply_markup.inline_keyboard[0][0].callback_data).toMatch(/^ack:/);

    // В офисе — счётчик и список
    expect((await A.get('/alerts/count')).json.new).toBe(1);
    const list = (await A.get('/alerts')).json.alerts;
    expect(list[0]).toMatchObject({ kind: 'late', minutes: 10, participant_name: 'Иван Петров', status: 'new' });

    // Менеджер нажимает «Принял» в Telegram
    await press(500, staffMsg.reply_markup.inline_keyboard[0][0].callback_data);
    expect((await A.get('/alerts/count')).json.new).toBe(0);
    let feed = (await S.call('GET', `/api/t/${ivan.token}`)).json;
    expect(feed.messages[0].title).toBe('✅ Менеджер получил ваше сообщение');
    expect(feed.alerts[0]).toMatchObject({ kind: 'late', status: 'done' });

    // Ответ из офиса
    expect((await A.post(`/alerts/${list[0].id}/reply`, { text: 'Ждём 10 минут у автобуса' })).status).toBe(200);
    feed = (await S.call('GET', `/api/t/${ivan.token}`)).json;
    expect(feed.messages[0]).toMatchObject({ title: '💬 Солнце Тур', body: 'Ждём 10 минут у автобуса' });
  });

  it('через Telegram: кнопки, выбор минут, свободный текст и ответ менеджера реплаем', async () => {
    const { ivan } = await tour();
    await say(777, `/start ${ivan.token}`);
    S.sent.length = 0;

    await say(777, '⏰ Я опаздываю');
    const ask = tgTo('777')[0];
    expect(ask.reply_markup.inline_keyboard[0].map((b: any) => b.callback_data)).toEqual(['late:5', 'late:10', 'late:15', 'late:30']);
    await press(777, 'late:15');
    expect(tgTo('500')[0].text).toContain('Опаздывает на 15 мин');
    expect(tgTo('777').at(-1)!.text).toContain('примерно на 15 мин');

    await say(777, '🆘 Нужна помощь');
    expect(tgTo('500').at(-1)!.text).toContain('🆘 Нужна помощь');
    expect(tgTo('777').at(-1)!.text).toContain('Гид Айше: +90 555');

    await say(777, 'Потерял паспорт в такси');
    const staffMsgs = tg().filter((x) => String(x.body.chat_id) === '500');
    const last = staffMsgs.at(-1)!;
    expect(last.body.text).toContain('💬 Сообщение');
    expect(last.body.text).toContain('«Потерял паспорт в такси»');
    expect(tgTo('777').at(-1)!.text).toContain('Передали менеджеру');

    // Менеджер отвечает реплаем на это сообщение (номер сообщения сохранён у обращения)
    const row = S.db.raw.prepare(`SELECT tg_msgs FROM alerts WHERE kind = 'message' ORDER BY created_at DESC LIMIT 1`).get() as any;
    const msgId = JSON.parse(row.tg_msgs)[0].msg;
    S.sent.length = 0;
    await say(500, 'Позвоните мне: +90 111', { reply_to_message: { message_id: msgId } });
    expect(tgTo('500')[0].text).toContain('Ответ отправлен');
    const toTourist = tgTo('777')[0];
    expect(toTourist.text).toContain('💬 Солнце Тур');
    expect(toTourist.text).toContain('Позвоните мне: +90 111');
  });

  it('защищает от спама и проверяет ввод', async () => {
    const { ivan } = await tour();
    expect((await S.call('POST', `/api/t/${ivan.token}/alert`, { kind: 'late' })).status).toBe(400);
    expect((await S.call('POST', `/api/t/${ivan.token}/alert`, { kind: 'party' })).status).toBe(400);
    for (let i = 0; i < 6; i++) expect((await S.call('POST', `/api/t/${ivan.token}/alert`, { kind: 'help' })).status).toBe(200);
    expect((await S.call('POST', `/api/t/${ivan.token}/alert`, { kind: 'help' })).status).toBe(429);
  });
});

describe('отзывы после тура', () => {
  it('спрашивает на следующий день в 12:00, ведёт довольных на отзывы, недовольных — к менеджеру', async () => {
    const { A, gid, ivan, maria } = await tour();
    await A.patch('/agency', { name: 'Солнце Тур', review_url: 'https://yandex.ru/maps/org/solnce/reviews' });
    await say(701, `/start ${ivan.token}`);
    await say(702, `/start ${maria.token}`);
    S.sent.length = 0;

    at('2026-05-18', '11:00'); // до 12:00 по Москве — рано
    expect(await askReviews(S.env)).toBe(0);
    vi.setSystemTime(zonedToUtc('2026-05-18', '12:01', 'Europe/Moscow'));
    expect(await askReviews(S.env)).toBe(2);
    expect(await askReviews(S.env)).toBe(0); // дважды не спрашиваем
    const q = tgTo('701')[0];
    expect(q.text).toContain('Как вам поездка «Стамбул 12–17 мая»');
    expect(q.reply_markup.inline_keyboard[0].map((b: any) => b.callback_data)).toEqual([1, 2, 3, 4, 5].map((n) => `rv:${gid}:${n}`));

    await press(701, `rv:${gid}:5`);
    const thanks = tgTo('701').at(-1)!;
    expect(thanks.reply_markup.inline_keyboard[0][0]).toEqual({ text: '✍️ Оставить отзыв', url: 'https://yandex.ru/maps/org/solnce/reviews' });

    await press(702, `rv:${gid}:2`);
    expect(tgTo('702').at(-1)!.text).toContain('что пошло не так');
    await say(702, 'Гид опоздал на экскурсию');
    expect(tgTo('500').at(-1)!.text).toContain('⭐ Отзыв');
    expect(tgTo('500').at(-1)!.text).toContain('Оценка 2 из 5. Гид опоздал на экскурсию');

    const rv = (await A.get(`/groups/${gid}/reviews`)).json;
    expect(rv).toMatchObject({ asked: 2, answered: 2, average: 3.5 });
    expect(rv.reviews.find((r: any) => r.rating === 2).comment).toBe('Гид опоздал на экскурсию');
  });

  it('не спрашивает, если отзывы выключены для группы', async () => {
    const { A, gid, ivan } = await tour();
    await A.patch(`/groups/${gid}`, { review_enabled: false });
    await say(701, `/start ${ivan.token}`);
    vi.setSystemTime(zonedToUtc('2026-05-18', '13:00', 'Europe/Moscow'));
    expect(await askReviews(S.env)).toBe(0);
  });
});

describe('загрузка программы', () => {
  it('распознаёт вставленный текст и добавляет события пачкой с напоминаниями', async () => {
    const { A, gid } = await tour();
    const parsed = await A.post(`/groups/${gid}/import`, { text: 'День 1\n08:00 Трансфер в отель\nДень 2\n09:00 Обзорная экскурсия. Сбор в лобби.\n19:00 Ужин' });
    expect(parsed.status).toBe(200);
    expect(parsed.json.events).toHaveLength(3);
    const add = await A.post(`/groups/${gid}/events/bulk`, { events: parsed.json.events });
    expect(add.json).toMatchObject({ ok: true, added: 3 });
    const d = (await A.get(`/groups/${gid}`)).json;
    expect(d.events.map((e: any) => `${e.local_date} ${e.local_time} ${e.type}`)).toEqual([
      '2026-05-12 08:00 transfer', '2026-05-13 09:00 excursion', '2026-05-13 10:00 excursion', '2026-05-13 19:00 meal',
    ]);
    expect(d.events.find((e: any) => e.title === 'Трансфер в отель').leads).toEqual([720, 60, 15]);
    const n = S.db.raw.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE group_id = ? AND kind = 'reminder'`).get(gid) as any;
    expect(n.n).toBeGreaterThan(4);
  });

  it('загружает файл и сообщает об ошибках по строкам', async () => {
    const { A, gid } = await tour();
    const file = new TextEncoder().encode('Дата;Время;Событие\n12.05;10:00;Музей\n13.05;11:00;Парк\n');
    const r = await S.call('POST', `/api/admin/groups/${gid}/import`, undefined, { ...A.H, 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('Программа.csv') });
    expect(r.status).toBe(400); // пустое тело
    const req = new Request(`https://tour.example.com/api/admin/groups/${gid}/import`, { method: 'POST', body: file, headers: { ...A.H, 'content-type': 'application/octet-stream', 'x-file-name': 'p.csv' } });
    const worker = (await import('../src/index')).default;
    const res = await worker.fetch(req, S.env, { waitUntil() {}, passThroughOnException() {} } as any);
    const json = await res.json() as any;
    expect(json.events.map((e: any) => e.title)).toEqual(['Музей', 'Парк']);
    const bad = await A.post(`/groups/${gid}/events/bulk`, { events: [json.events[0], { title: '', local_date: 'x' }] });
    expect(bad.status).toBe(400);
    expect(bad.json.errors[0].index).toBe(1);
    const ok = await A.post(`/groups/${gid}/events/bulk`, { events: [json.events[0], { title: '', local_date: 'x' }], skipInvalid: true });
    expect(ok.json).toMatchObject({ ok: true, added: 1 });
  });
});
