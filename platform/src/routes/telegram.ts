import { Hono } from 'hono';
import { TOURIST_KEYBOARD, tgAnswerCallback, tgEditMarkup, tgSend, tgSendMessage, type TgCallbackQuery, type TgMessageFull, type TgUpdate } from '../telegram';
import { loadTourist, touristEvents, type TouristCtx } from './tourist';
import { ackAlert, createAlert, replyToAlert, type AlertRow } from '../alerts';
import { pendingLowReview, saveRating } from '../reviews';
import { eventType } from '../schedule';
import { formatDateInTz, humanDate, tzLabel } from '../time';
import { HttpError, newId, sha256, type Env } from '../util';
import type { EventRow } from '../events';

export const telegram = new Hono<{ Bindings: Env }>();

const LATE_BTN = '⏰ Я опаздываю';
const HELP_BTN = '🆘 Нужна помощь';
const NEXT_BTN = '📅 Ближайшее';

telegram.post('/webhook', async (c) => {
  const env = c.env;
  const secret = c.req.header('x-telegram-bot-api-secret-token') ?? '';
  if (!env.TELEGRAM_WEBHOOK_SECRET || !env.TELEGRAM_BOT_TOKEN
    || (await sha256(secret)) !== (await sha256(env.TELEGRAM_WEBHOOK_SECRET))) throw new HttpError(403, 'forbidden');
  const upd = await c.req.json<TgUpdate>().catch(() => null);
  const base = (env.PUBLIC_URL || new URL(c.req.url).origin).replace(/\/+$/, '');
  // Telegram повторяет запрос, пока не получит 200, — поэтому ошибки только логируем и всегда отвечаем 200.
  try {
    if (upd?.callback_query) await onCallback(env, upd.callback_query, base);
    else if (upd?.message?.text && upd.message.chat.type === 'private') await onMessage(env, upd.message, base);
  } catch (e) {
    console.error('telegram webhook', e);
  }
  return c.json({ ok: true });
});

/** Турист, к которому привязан этот чат. Если туров несколько — тот, что идёт сейчас (или ближайший). */
async function touristForChat(db: D1Database, chatId: string): Promise<TouristCtx[]> {
  const rows = (await db.prepare(`SELECT p.token, g.start_date, g.end_date FROM channels c JOIN participants p ON p.id = c.participant_id
      JOIN groups g ON g.id = p.group_id
      WHERE c.kind = 'telegram' AND c.address = ? AND c.active = 1 AND p.revoked = 0 ORDER BY c.updated_at DESC`)
    .bind(chatId).all<{ token: string; start_date: string; end_date: string }>()).results;
  const today = new Date().toISOString().slice(0, 10);
  rows.sort((a, b) => Number(b.start_date <= today && b.end_date >= today) - Number(a.start_date <= today && a.end_date >= today));
  const out: TouristCtx[] = [];
  for (const r of rows.slice(0, 3)) out.push(await loadTourist(db, r.token));
  return out;
}

async function onMessage(env: Env, msg: TgMessageFull, base: string) {
  const db = env.DB;
  const tok = env.TELEGRAM_BOT_TOKEN!;
  const chatId = String(msg.chat.id);
  const text = msg.text!.trim();
  const reply = (t: string, markup?: unknown) => tgSendMessage(tok, chatId, t, markup);
  const [cmd, arg] = text.split(/\s+/, 2);

  // ----- Сотрудник подключает Telegram для обращений -----
  if (cmd === '/start' && arg?.startsWith('s_')) {
    const staff = await db.prepare('SELECT id, name FROM staff WHERE tg_link_token = ?').bind(arg.slice(2)).first<{ id: string; name: string }>();
    if (!staff) { await reply('Ссылка для подключения устарела. Нажмите «Подключить Telegram» в настройках офиса ещё раз.'); return; }
    await db.prepare('UPDATE staff SET tg_chat_id = ?, tg_link_token = NULL WHERE id = ?').bind(chatId, staff.id).run();
    await reply(`✅ ${staff.name || 'Готово'}! Сюда будут приходить обращения туристов: «Я опаздываю», «Нужна помощь» и их сообщения.\n\nЧтобы ответить туристу, ответьте (Reply) на его сообщение.`);
    return;
  }

  // ----- Турист подключается по личной ссылке -----
  if (cmd === '/start') {
    if (!arg) { await reply('Здравствуйте! Чтобы получать напоминания по туру, откройте персональную ссылку от турфирмы и нажмите «Получать в Telegram».'); return; }
    const t = await loadTourist(db, arg).catch(() => null);
    if (!t) { await reply('Ссылка недействительна. Попросите у турфирмы новую ссылку.'); return; }
    const now = Date.now();
    await db.prepare(`INSERT INTO channels (id, participant_id, kind, address, data, active, fail_count, created_at, updated_at)
        VALUES (?, ?, 'telegram', ?, '{}', 1, 0, ?, ?)
        ON CONFLICT (participant_id, kind, address) DO UPDATE SET active = 1, fail_count = 0, updated_at = excluded.updated_at`)
      .bind(newId(), t.participant_id, chatId, now, now).run();
    const events = await touristEvents(db, t);
    await reply(`✅ Готово! Напоминания по туру «${t.group_title}» (${t.agency_name}) будут приходить сюда.\n\n${upcoming(events, now, 3, t.tz) || 'Ближайших событий пока нет.'}\n\nКнопки внизу:\n${LATE_BTN} — предупредить, что задерживаетесь\n${HELP_BTN} — срочно связаться с менеджером\n\nМожно и просто написать сообщение — мы передадим его менеджеру.`,
      TOURIST_KEYBOARD);
    await tgSend(tok, chatId, 'Расписание тура всегда под рукой:', { button: { text: 'Открыть расписание', url: `${base}/t/${t.token}/` } });
    return;
  }

  // ----- Ответ сотрудника туристу: реплай на сообщение-обращение -----
  const staff = await db.prepare('SELECT id, name, agency_id FROM staff WHERE tg_chat_id = ?').bind(chatId).first<{ id: string; name: string; agency_id: string }>();
  if (staff && msg.reply_to_message) {
    const alerts = (await db.prepare(`SELECT a.id, a.tg_msgs, ag.name AS agency FROM alerts a JOIN agencies ag ON ag.id = a.agency_id
        WHERE a.agency_id = ? AND a.tg_msgs LIKE ? ORDER BY a.created_at DESC LIMIT 20`)
      .bind(staff.agency_id, `%${msg.reply_to_message.message_id}%`).all<{ id: string; tg_msgs: string; agency: string }>()).results;
    const hit = alerts.find((a) => (JSON.parse(a.tg_msgs) as { chat: string; msg: number }[]).some((m) => m.chat === chatId && m.msg === msg.reply_to_message!.message_id));
    if (hit) {
      await replyToAlert(env, hit.id, staff.agency_id, staff.name, hit.agency, text);
      await reply('✉️ Ответ отправлен туристу.');
      return;
    }
  }

  if (cmd === '/stop') {
    await db.prepare(`UPDATE channels SET active = 0, updated_at = ? WHERE kind = 'telegram' AND address = ?`).bind(Date.now(), chatId).run();
    await reply('Уведомления отключены. Чтобы включить снова, откройте ссылку от турфирмы.', { remove_keyboard: true });
    return;
  }

  const tours = await touristForChat(db, chatId);
  if (!tours.length) {
    await reply(staff
      ? 'Чтобы ответить туристу, ответьте (Reply) на его сообщение-обращение.'
      : 'Вы ещё не подключены к туру. Откройте персональную ссылку от турфирмы и нажмите «Получать в Telegram».');
    return;
  }
  const t = tours[0];
  const now = Date.now();

  if (text === LATE_BTN || cmd === '/late') {
    await reply('На сколько примерно задерживаетесь?', {
      inline_keyboard: [[5, 10, 15, 30].map((n) => ({ text: `${n} мин`, callback_data: `late:${n}` })), [{ text: 'Больше часа', callback_data: 'late:60' }]],
    });
    return;
  }
  const safe = async (fn: () => Promise<unknown>) => {
    try { await fn(); return true; } catch (e) { await reply(e instanceof HttpError ? e.message : 'Не получилось отправить, попробуйте ещё раз.'); return false; }
  };
  if (text === HELP_BTN || cmd === '/help') {
    if (!(await safe(() => createAlert(env, t, { kind: 'help', source: 'telegram' })))) return;
    await reply(`🆘 Менеджер получил сигнал и свяжется с вами.\nОпишите, что случилось, следующим сообщением — мы сразу передадим.${phones(t)}`, TOURIST_KEYBOARD);
    return;
  }
  if (text === NEXT_BTN || cmd === '/next' || cmd === '/today') {
    for (const tour of tours) {
      const events = await touristEvents(db, tour);
      let out: string;
      if (cmd === '/today') {
        const today = formatDateInTz(now, tour.tz);
        const list = events.filter((e) => !e.cancelled && e.local_date === today);
        out = `📅 Сегодня, ${humanDate(today)} — «${tour.group_title}»\n\n` + (list.length ? list.map((e) => line(e, tour.tz)).join('\n') : 'Событий нет.');
      } else {
        out = `⏭ Ближайшее — «${tour.group_title}»\n\n` + (upcoming(events, now, 5, tour.tz) || 'Больше событий нет.');
      }
      await tgSend(tok, chatId, out, { button: { text: 'Открыть расписание', url: `${base}/t/${tour.token}/` } });
    }
    return;
  }
  if (text.startsWith('/')) { await reply('Не знаю такой команды. Пользуйтесь кнопками внизу или просто напишите сообщение.', TOURIST_KEYBOARD); return; }

  // ----- Свободный текст: комментарий к низкой оценке или сообщение менеджеру -----
  const low = await pendingLowReview(db, t.participant_id, now);
  if (low) {
    await db.prepare('UPDATE reviews SET comment = ? WHERE id = ?').bind(text.slice(0, 2000), low.id).run();
    const tour = tours.find((x) => x.group_id === low.group_id) ?? t;
    await createAlert(env, tour, { kind: 'review', text: `Оценка ${low.rating} из 5. ${text}`, source: 'telegram' });
    await reply('Спасибо, что написали. Менеджер прочитает лично — нам важно это исправить. 🙏');
    return;
  }
  if (!(await safe(() => createAlert(env, t, { kind: 'message', text, source: 'telegram' })))) return;
  await reply('✅ Передали менеджеру. Ответ придёт сюда.', TOURIST_KEYBOARD);
}

async function onCallback(env: Env, q: TgCallbackQuery, base: string) {
  const db = env.DB;
  const tok = env.TELEGRAM_BOT_TOKEN!;
  const chatId = String(q.message?.chat.id ?? q.from.id);
  const data = q.data ?? '';
  const done = (text?: string) => tgAnswerCallback(tok, q.id, text);
  const dropButtons = () => (q.message ? tgEditMarkup(tok, chatId, q.message.message_id) : null);

  // Сотрудник нажал «Принял»
  if (data.startsWith('ack:')) {
    const staff = await db.prepare('SELECT name, agency_id FROM staff WHERE tg_chat_id = ?').bind(chatId).first<{ name: string; agency_id: string }>();
    if (!staff) { await done('Нет доступа'); return; }
    const a: AlertRow = await ackAlert(env, data.slice(4), staff.agency_id, staff.name);
    await done(a.handled_by && a.handled_by !== staff.name ? `Уже принял(а): ${a.handled_by}` : 'Отмечено. Турист получил подтверждение.');
    await dropButtons();
    return;
  }

  // Турист выбрал, на сколько опаздывает
  if (data.startsWith('late:')) {
    const minutes = Math.min(Math.max(Number(data.slice(5)) || 0, 1), 600);
    const [t] = await touristForChat(db, chatId);
    if (!t) { await done('Вы не подключены к туру'); return; }
    try {
      await createAlert(env, t, { kind: 'late', minutes, source: 'telegram' });
    } catch (e) {
      await done(e instanceof HttpError ? e.message : 'Не получилось отправить'); return;
    }
    await done('Отправлено');
    await dropButtons();
    await tgSendMessage(tok, chatId, `⏰ Менеджер знает, что вы опаздываете примерно на ${minutes === 60 ? 'час и больше' : minutes + ' мин'}.\nЕсли нужно что-то уточнить — напишите сообщением.${phones(t)}`, TOURIST_KEYBOARD);
    return;
  }

  // Оценка поездки
  if (data.startsWith('rv:')) {
    const [, groupId, n] = data.split(':');
    const rating = Number(n);
    const p = await db.prepare(`SELECT p.id, a.review_url, a.name AS agency FROM channels c JOIN participants p ON p.id = c.participant_id
        JOIN groups g ON g.id = p.group_id JOIN agencies a ON a.id = g.agency_id
        WHERE c.kind = 'telegram' AND c.address = ? AND p.group_id = ? LIMIT 1`).bind(chatId, groupId).first<{ id: string; review_url: string; agency: string }>();
    if (!p || !(rating >= 1 && rating <= 5)) { await done(); return; }
    await saveRating(db, groupId, p.id, rating);
    await done(`Ваша оценка: ${rating}`);
    await dropButtons();
    if (rating >= 4) {
      const url = /^https?:\/\//.test(p.review_url) ? p.review_url : '';
      await tgSendMessage(tok, chatId, url
        ? `Спасибо! 🙏 Нам очень приятно.\nЕсли не сложно, оставьте пару слов о поездке — это помогает другим путешественникам выбрать «${p.agency}».`
        : 'Спасибо! 🙏 Нам очень приятно. Будем рады видеть вас снова!',
      url ? { inline_keyboard: [[{ text: '✍️ Оставить отзыв', url }]] } : undefined);
    } else {
      await tgSendMessage(tok, chatId, 'Нам жаль, что не всё понравилось. 😔\nНапишите одним сообщением, что пошло не так, — менеджер прочитает лично.');
    }
    return;
  }
  await done();
}

function phones(t: TouristCtx): string {
  const list = [t.guide_phone && `Гид ${t.guide_name}: ${t.guide_phone}`.replace('  ', ' '), t.agency_phone && `${t.agency_name}: ${t.agency_phone}`].filter(Boolean);
  return list.length ? `\n\nЕсли срочно — позвоните:\n${list.join('\n')}` : '';
}

function line(e: EventRow, groupTz: string): string {
  const tz = e.tz !== groupTz ? ` (${tzLabel(e.tz)})` : '';
  const place = e.meeting_point || e.location;
  return `${e.local_time ?? 'весь день'}${tz} ${eventType(e.type).icon} ${e.title}${place ? ` — ${place}` : ''}`;
}
function upcoming(events: EventRow[], now: number, n: number, groupTz: string): string {
  const list = events.filter((e) => !e.cancelled && e.starts_at + e.duration_min * 60_000 >= now).slice(0, n);
  return list.map((e) => `${humanDate(e.local_date)}, ${line(e, groupTz)}`).join('\n');
}
