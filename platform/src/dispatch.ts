// Диспетчер уведомлений. Запускается cron-ом каждую минуту и сразу после срочных событий.
//
// Надёжность:
//  • notifications → deliveries «раскладываются» одной транзакцией; UNIQUE(notification, channel)
//    исключает дубли даже при параллельных запусках;
//  • доставка сначала «захватывается» (status='sending' + аренда на 5 минут), поэтому два
//    одновременных запуска не отправят одно и то же, а упавший запуск не потеряет сообщение;
//  • временные ошибки (сеть, 429, 5xx) повторяются с нарастающей паузой, мёртвые подписки
//    отключаются, устаревшие напоминания не отправляются задним числом.
import { sendWebPush, type PushSubscriptionData, type SendResult, type VapidKeys } from './push';
import { tgSend } from './telegram';
import type { NewNotification } from './schedule';
import { newId, setMetaStmt, type Env } from './util';

export const LEASE_MS = 5 * 60_000;
export const MAX_ATTEMPTS = 5;
export const BACKOFF_MS = [30_000, 2 * 60_000, 5 * 60_000, 15 * 60_000];
const CHANNEL_MAX_FAILS = 10;

export function insertNotificationStmt(db: D1Database, n: NewNotification, now: number): D1PreparedStatement {
  return db.prepare(`INSERT INTO notifications
      (id, group_id, event_id, kind, lead_min, audience, fire_at, expires_at, title, body, urgent, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
    .bind(newId(), n.group_id, n.event_id, n.kind, n.lead_min, n.audience ? JSON.stringify(n.audience) : null,
      n.fire_at, n.expires_at, n.title.slice(0, 300), n.body.slice(0, 1000), n.urgent ? 1 : 0, now);
}

interface DueRow {
  id: string; attempts: number; channel_id: string; kind: 'webpush' | 'telegram'; address: string; data: string;
  n_kind: string; title: string; body: string; urgent: number; expires_at: number; event_id: string | null;
  notification_id: string; token: string;
}

export interface DispatchStats { fanned: number; claimed: number; sent: number; retried: number; failed: number; gone: number; expired: number }

export interface DispatchDeps { fetcher?: typeof fetch; now?: number }

export async function runDispatch(env: Env, deps: DispatchDeps = {}): Promise<DispatchStats> {
  const db = env.DB;
  const now = deps.now ?? Date.now();
  const fetcher = deps.fetcher ?? fetch;
  const maxSends = Math.max(1, Number(env.MAX_SENDS_PER_RUN) || 40);
  const stats: DispatchStats = { fanned: 0, claimed: 0, sent: 0, retried: 0, failed: 0, gone: 0, expired: 0 };

  // 1. Раскладываем наступившие уведомления по каналам получателей — одной транзакцией.
  const fan = await db.batch([
    db.prepare(`UPDATE notifications SET status = 'skipped' WHERE status = 'pending' AND fire_at <= ? AND expires_at <= ?`).bind(now, now),
    db.prepare(`INSERT OR IGNORE INTO deliveries (id, notification_id, channel_id, status, attempts, next_attempt_at)
        SELECT lower(hex(randomblob(16))), n.id, c.id, 'pending', 0, ?1
        FROM notifications n
        JOIN participants p ON p.group_id = n.group_id AND p.revoked = 0
        JOIN channels c ON c.participant_id = p.id AND c.active = 1
        WHERE n.status = 'pending' AND n.fire_at <= ?1
          AND (n.audience IS NULL OR p.id IN (SELECT value FROM json_each(n.audience)))`).bind(now),
    db.prepare(`UPDATE notifications SET status = 'fanned' WHERE status = 'pending' AND fire_at <= ?`).bind(now),
  ]);
  stats.fanned = fan[2].meta.changes ?? 0;

  // 2. Захватываем порцию доставок. «sending» с истёкшей арендой — значит, прошлый запуск упал.
  const claimed = await db.prepare(`UPDATE deliveries SET status = 'sending', attempts = attempts + 1, next_attempt_at = ?1
      WHERE id IN (SELECT id FROM deliveries WHERE status IN ('pending','sending') AND next_attempt_at <= ?2
                   ORDER BY next_attempt_at LIMIT ?3)
      RETURNING id`).bind(now + LEASE_MS, now, maxSends).all<{ id: string }>();
  const ids = claimed.results.map((r) => r.id);
  stats.claimed = ids.length;

  if (ids.length) {
    const rows = (await db.prepare(`SELECT d.id, d.attempts, d.notification_id, c.id AS channel_id, c.kind, c.address, c.data,
          n.kind AS n_kind, n.title, n.body, n.urgent, n.expires_at, n.event_id, p.token
        FROM deliveries d
        JOIN channels c ON c.id = d.channel_id
        JOIN notifications n ON n.id = d.notification_id
        JOIN participants p ON p.id = c.participant_id
        WHERE d.id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(ids)).all<DueRow>()).results;

    const vapid: VapidKeys | null = env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY
      ? { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT || 'mailto:admin@example.com' }
      : null;

    const results = await mapLimit(rows, 6, async (row) => ({ row, res: await deliver(row, env, vapid, fetcher, now) }));

    const updates: D1PreparedStatement[] = [];
    for (const { row, res } of results) {
      switch (res.outcome) {
        case 'sent':
          stats.sent++;
          updates.push(db.prepare(`UPDATE deliveries SET status = 'sent', sent_at = ?, last_error = NULL WHERE id = ?`).bind(now, row.id));
          updates.push(db.prepare(`UPDATE channels SET fail_count = 0 WHERE id = ? AND fail_count <> 0`).bind(row.channel_id));
          break;
        case 'expired':
          stats.expired++;
          updates.push(db.prepare(`UPDATE deliveries SET status = 'expired' WHERE id = ?`).bind(row.id));
          break;
        case 'gone':
          stats.gone++;
          updates.push(db.prepare(`UPDATE deliveries SET status = 'gone', last_error = ? WHERE id = ?`).bind(`HTTP ${res.status}`, row.id));
          updates.push(db.prepare(`UPDATE channels SET active = 0, updated_at = ? WHERE id = ?`).bind(now, row.channel_id));
          break;
        case 'retry': {
          const backoff = BACKOFF_MS[Math.min(row.attempts - 1, BACKOFF_MS.length - 1)];
          const next = now + Math.max(backoff, (res.retryAfterSec ?? 0) * 1000);
          if (row.attempts < MAX_ATTEMPTS && next < row.expires_at) {
            stats.retried++;
            updates.push(db.prepare(`UPDATE deliveries SET status = 'pending', next_attempt_at = ?, last_error = ? WHERE id = ?`)
              .bind(next, `HTTP ${res.status}: ${res.error}`.slice(0, 300), row.id));
            break;
          }
          stats.failed++;
          updates.push(...failStmts(db, row, `HTTP ${res.status}: ${res.error}`, now));
          break;
        }
        case 'failed':
          stats.failed++;
          updates.push(...failStmts(db, row, `HTTP ${res.status}: ${res.error}`, now));
          break;
      }
    }
    if (updates.length) await db.batch(updates);
  }

  await db.batch([setMetaStmt(db, 'last_dispatch_at', String(now))]);
  return stats;
}

function failStmts(db: D1Database, row: DueRow, error: string, now: number): D1PreparedStatement[] {
  return [
    db.prepare(`UPDATE deliveries SET status = 'failed', last_error = ? WHERE id = ?`).bind(error.slice(0, 300), row.id),
    db.prepare(`UPDATE channels SET fail_count = fail_count + 1,
        active = CASE WHEN fail_count + 1 >= ? THEN 0 ELSE active END, updated_at = ? WHERE id = ?`).bind(CHANNEL_MAX_FAILS, now, row.channel_id),
  ];
}

type DeliverResult = SendResult | { outcome: 'expired' };

async function deliver(row: DueRow, env: Env, vapid: VapidKeys | null, fetcher: typeof fetch, now: number): Promise<DeliverResult> {
  if (row.expires_at <= now) return { outcome: 'expired' };
  const url = `/t/${row.token}/`;
  if (row.kind === 'webpush') {
    if (!vapid) return { outcome: 'failed', status: 0, error: 'VAPID-ключи не настроены' };
    let sub: PushSubscriptionData;
    try { sub = { endpoint: row.address, keys: JSON.parse(row.data).keys }; } catch { return { outcome: 'gone', status: 0 }; }
    return sendWebPush(sub, {
      payload: { title: row.title, body: row.body, url, tag: row.event_id ? `ev-${row.event_id}` : `n-${row.notification_id}`, kind: row.n_kind, urgent: !!row.urgent },
      ttlSec: (row.expires_at - now) / 1000,
      urgency: row.urgent ? 'high' : 'normal',
    }, vapid, fetcher);
  }
  if (row.kind === 'telegram') {
    if (!env.TELEGRAM_BOT_TOKEN) return { outcome: 'failed', status: 0, error: 'TELEGRAM_BOT_TOKEN не настроен' };
    const base = env.PUBLIC_URL?.replace(/\/+$/, '');
    return tgSend(env.TELEGRAM_BOT_TOKEN, row.address, `${row.title}\n${row.body}`,
      { button: base ? { text: 'Открыть расписание', url: base + url } : undefined }, fetcher);
  }
  return { outcome: 'failed', status: 0, error: `unknown channel ${row.kind}` };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Плановая уборка старых данных (раз в час). */
export async function cleanup(db: D1Database, now: number): Promise<void> {
  const day = 86400_000;
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    db.prepare('DELETE FROM login_failures WHERE at < ?').bind(now - day),
    db.prepare(`DELETE FROM deliveries WHERE status IN ('sent','failed','gone','expired')
        AND notification_id IN (SELECT id FROM notifications WHERE fire_at < ?)`).bind(now - 60 * day),
    db.prepare(`DELETE FROM notifications WHERE status <> 'pending' AND fire_at < ?`).bind(now - 60 * day),
  ]);
}
