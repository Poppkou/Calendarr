import type { Context } from 'hono';
import { bad, HttpError } from '../util';

const MAX_BODY = 256 * 1024;

export async function readJson(c: Context): Promise<Record<string, any>> {
  const len = Number(c.req.header('content-length') || 0);
  if (len > MAX_BODY) throw new HttpError(413, 'Слишком большой запрос');
  const text = await c.req.text();
  if (text.length > MAX_BODY) throw new HttpError(413, 'Слишком большой запрос');
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw bad('Некорректный JSON');
  }
}
