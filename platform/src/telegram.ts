// Telegram Bot API: отправка сообщений с классификацией ошибок, как и для Web Push.
import type { SendResult } from './push';

export async function tgCall(token: string, method: string, body: unknown, fetcher: typeof fetch = fetch): Promise<Response> {
  return fetcher(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

export interface TgButton { text: string; url: string }

export async function tgSend(token: string, chatId: string, text: string, opts: { button?: TgButton; silent?: boolean } = {}, fetcher: typeof fetch = fetch): Promise<SendResult> {
  const body: Record<string, unknown> = {
    chat_id: chatId, text: text.slice(0, 4000),
    link_preview_options: { is_disabled: true },
    disable_notification: !!opts.silent,
  };
  if (opts.button) body.reply_markup = { inline_keyboard: [[opts.button]] };
  let res: Response;
  try {
    res = await tgCall(token, 'sendMessage', body, fetcher);
  } catch (e) {
    return { outcome: 'retry', status: 0, error: `network: ${(e as Error).message}` };
  }
  if (res.ok) return { outcome: 'sent' };
  const data = await res.json().catch(() => ({})) as { description?: string; parameters?: { retry_after?: number } };
  const desc = String(data.description ?? '').slice(0, 200);
  // 403 — пользователь заблокировал бота; 400 chat not found — чата больше нет.
  if (res.status === 403 || (res.status === 400 && /chat not found|user is deactivated/i.test(desc))) return { outcome: 'gone', status: res.status };
  if (res.status === 429 || res.status >= 500) return { outcome: 'retry', status: res.status, error: desc, retryAfterSec: data.parameters?.retry_after };
  return { outcome: 'failed', status: res.status, error: desc };
}

export interface TgUpdate {
  update_id: number;
  message?: { message_id: number; text?: string; chat: { id: number; type: string }; from?: { first_name?: string } };
}
