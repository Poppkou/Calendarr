import { Hono } from 'hono';
import { tgSend, type TgUpdate } from '../telegram';
import { loadTourist, touristEvents } from './tourist';
import { eventType } from '../schedule';
import { formatDateInTz, humanDate, tzLabel } from '../time';
import { HttpError, newId, sha256, type Env } from '../util';
import type { EventRow } from '../events';

export const telegram = new Hono<{ Bindings: Env }>();

telegram.post('/webhook', async (c) => {
  const env = c.env;
  const secret = c.req.header('x-telegram-bot-api-secret-token') ?? '';
  if (!env.TELEGRAM_WEBHOOK_SECRET || !env.TELEGRAM_BOT_TOKEN
    || (await sha256(secret)) !== (await sha256(env.TELEGRAM_WEBHOOK_SECRET))) throw new HttpError(403, 'forbidden');
  const upd = await c.req.json<TgUpdate>().catch(() => null);
  const msg = upd?.message;
  // Telegram повторяет запрос, пока не получит 200, — поэтому на всё, что не понимаем, отвечаем 200.
  if (!msg?.text || msg.chat.type !== 'private') return c.json({ ok: true });
  const chatId = String(msg.chat.id);
  const reply = (text: string, url?: string) =>
    tgSend(env.TELEGRAM_BOT_TOKEN!, chatId, text, { button: url ? { text: 'Открыть расписание', url } : undefined });
  const base = (env.PUBLIC_URL || new URL(c.req.url).origin).replace(/\/+$/, '');
  const db = env.DB;
  const [cmd, arg] = msg.text.trim().split(/\s+/, 2);

  try {
    if (cmd === '/start') {
      if (!arg) {
        await reply('Здравствуйте! Чтобы получать напоминания по туру, откройте персональную ссылку от турфирмы и нажмите «Получать в Telegram».');
        return c.json({ ok: true });
      }
      const t = await loadTourist(db, arg).catch(() => null);
      if (!t) {
        await reply('Ссылка недействительна. Попросите у турфирмы новую ссылку.');
        return c.json({ ok: true });
      }
      const now = Date.now();
      await db.prepare(`INSERT INTO channels (id, participant_id, kind, address, data, active, fail_count, created_at, updated_at)
          VALUES (?, ?, 'telegram', ?, '{}', 1, 0, ?, ?)
          ON CONFLICT (participant_id, kind, address) DO UPDATE SET active = 1, fail_count = 0, updated_at = excluded.updated_at`)
        .bind(newId(), t.participant_id, chatId, now, now).run();
      const events = await touristEvents(db, t);
      await reply(`✅ Готово! Напоминания по туру «${t.group_title}» (${t.agency_name}) будут приходить сюда.\n\n${upcoming(events, now, 3, t.tz) || 'Ближайших событий пока нет.'}\n\nКоманды: /next — ближайшие события, /today — сегодня, /stop — отключить.`,
        `${base}/t/${t.token}/`);
      return c.json({ ok: true });
    }

    const subs = (await db.prepare(`SELECT p.token FROM channels c JOIN participants p ON p.id = c.participant_id
        WHERE c.kind = 'telegram' AND c.address = ? AND c.active = 1 AND p.revoked = 0 ORDER BY c.updated_at DESC`).bind(chatId).all<{ token: string }>()).results;

    if (cmd === '/stop') {
      await db.prepare(`UPDATE channels SET active = 0, updated_at = ? WHERE kind = 'telegram' AND address = ?`).bind(Date.now(), chatId).run();
      await reply('Уведомления отключены. Чтобы включить снова, откройте ссылку от турфирмы.');
      return c.json({ ok: true });
    }
    if (!subs.length) {
      await reply('Вы ещё не подключены к туру. Откройте персональную ссылку от турфирмы и нажмите «Получать в Telegram».');
      return c.json({ ok: true });
    }
    const now = Date.now();
    for (const { token } of subs.slice(0, 3)) {
      const t = await loadTourist(db, token);
      const events = await touristEvents(db, t);
      let text: string;
      if (cmd === '/today') {
        const today = formatDateInTz(now, t.tz);
        const list = events.filter((e) => !e.cancelled && e.local_date === today);
        text = `📅 Сегодня, ${humanDate(today)} — «${t.group_title}»\n\n` + (list.length ? list.map((e) => line(e, t.tz)).join('\n') : 'Событий нет.');
      } else {
        text = `⏭ Ближайшее — «${t.group_title}»\n\n` + (upcoming(events, now, 5, t.tz) || 'Больше событий нет.');
      }
      await reply(text, `${base}/t/${t.token}/`);
    }
  } catch (e) {
    console.error('telegram webhook', e);
  }
  return c.json({ ok: true });
});

function line(e: EventRow, groupTz: string): string {
  const tz = e.tz !== groupTz ? ` (${tzLabel(e.tz)})` : '';
  const place = e.meeting_point || e.location;
  return `${e.local_time ?? 'весь день'}${tz} ${eventType(e.type).icon} ${e.title}${place ? ` — ${place}` : ''}`;
}
function upcoming(events: EventRow[], now: number, n: number, groupTz: string): string {
  const list = events.filter((e) => !e.cancelled && e.starts_at + e.duration_min * 60_000 >= now).slice(0, n);
  return list.map((e) => `${humanDate(e.local_date)}, ${line(e, groupTz)}`).join('\n');
}
