// Отзывы после тура (через Telegram): на следующий день после окончания тура в 12:00 по домашнему времени
// турист получает «Оцените поездку» с кнопками 1–5. Довольных ведём на страницу отзывов агентства,
// недовольных просим написать, что пошло не так, — это сразу уходит менеджеру.
import { addDays, isValidTz, zonedToUtc } from './time';
import { tgSendMessage } from './telegram';
import { newId, type Env } from './util';

export const REVIEW_TIME = '12:00';
const ASK_WINDOW = 3 * 86400_000; // если планировщик простаивал — не спрашиваем через неделю после тура
const ASK_PER_RUN = 10;

export function reviewAt(endDate: string, homeTz: string): number {
  return zonedToUtc(addDays(endDate, 1), REVIEW_TIME, isValidTz(homeTz) ? homeTz : 'Europe/Moscow');
}

export const ratingKeyboard = (groupId: string) => ({
  inline_keyboard: [[1, 2, 3, 4, 5].map((n) => ({ text: n === 5 ? '5 ⭐' : String(n), callback_data: `rv:${groupId}:${n}` }))],
});

/** Проставляет время запроса отзыва группам, у которых его ещё нет (например, созданным до обновления). */
export async function fillReviewTimes(db: D1Database): Promise<void> {
  const rows = (await db.prepare('SELECT id, end_date, home_tz FROM groups WHERE review_at IS NULL LIMIT 50')
    .all<{ id: string; end_date: string; home_tz: string }>()).results;
  if (!rows.length) return;
  await db.batch(rows.map((g) => db.prepare('UPDATE groups SET review_at = ? WHERE id = ?').bind(reviewAt(g.end_date, g.home_tz), g.id)));
}

interface AskRow { participant_id: string; name: string; group_id: string; title: string; agency: string; chat: string }

export async function askReviews(env: Env, now = Date.now(), fetcher: typeof fetch = fetch): Promise<number> {
  if (!env.TELEGRAM_BOT_TOKEN) return 0;
  const db = env.DB;
  await fillReviewTimes(db);
  const rows = (await db.prepare(`SELECT p.id AS participant_id, p.name, g.id AS group_id, g.title, a.name AS agency, MIN(c.address) AS chat
      FROM groups g
      JOIN agencies a ON a.id = g.agency_id
      JOIN participants p ON p.group_id = g.id AND p.revoked = 0
      JOIN channels c ON c.participant_id = p.id AND c.kind = 'telegram' AND c.active = 1
      WHERE g.review_enabled = 1 AND g.review_at <= ?1 AND g.review_at > ?2
        AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.group_id = g.id AND r.participant_id = p.id)
      GROUP BY p.id LIMIT ?3`).bind(now, now - ASK_WINDOW, ASK_PER_RUN).all<AskRow>()).results;
  let asked = 0;
  for (const r of rows) {
    const hello = r.name ? `${r.name.split(' ')[0]}, с возвращением!` : 'С возвращением!';
    const res = await tgSendMessage(env.TELEGRAM_BOT_TOKEN, r.chat,
      `${hello} 🌴\nКак вам поездка «${r.title}»? Оцените, пожалуйста, от 1 до 5 — это займёт секунду.\n\n${r.agency}`,
      ratingKeyboard(r.group_id), fetcher);
    // Временная ошибка Telegram — попробуем в следующую минуту; остальное фиксируем, чтобы не спрашивать дважды.
    if (!res.ok && (res.status === 0 || res.status === 429 || res.status >= 500)) continue;
    await db.prepare('INSERT OR IGNORE INTO reviews (id, group_id, participant_id, asked_at) VALUES (?, ?, ?, ?)')
      .bind(newId(), r.group_id, r.participant_id, now).run();
    if (res.ok) asked++;
  }
  return asked;
}

/** Оценка из кнопки (повторное нажатие меняет оценку). */
export async function saveRating(db: D1Database, groupId: string, participantId: string, rating: number, now = Date.now()): Promise<void> {
  await db.prepare(`INSERT INTO reviews (id, group_id, participant_id, rating, asked_at, answered_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (group_id, participant_id) DO UPDATE SET rating = excluded.rating, answered_at = excluded.answered_at`)
    .bind(newId(), groupId, participantId, rating, now, now).run();
}

/** Если турист недавно поставил низкую оценку и ещё не объяснил почему — следующий его текст считается комментарием. */
export async function pendingLowReview(db: D1Database, participantId: string, now = Date.now()): Promise<{ id: string; group_id: string; rating: number } | null> {
  return db.prepare(`SELECT id, group_id, rating FROM reviews WHERE participant_id = ? AND rating <= 3 AND comment = '' AND answered_at > ?
      ORDER BY answered_at DESC LIMIT 1`).bind(participantId, now - 2 * 86400_000).first();
}
