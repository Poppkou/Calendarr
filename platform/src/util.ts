import { b64url } from './push';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_BOT_USERNAME?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  SETUP_KEY?: string;
  PUBLIC_URL?: string;
  MAX_SENDS_PER_RUN?: string;
}

export const newId = () => crypto.randomUUID();
export const newToken = () => b64url.encode(crypto.getRandomValues(new Uint8Array(24)));

// Без 0/O, 1/I/L — чтобы код можно было продиктовать по телефону.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let s = '';
  for (const b of bytes) s += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return s;
}
export const normalizeCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
export const formatCode = (c: string) => `${c.slice(0, 4)}-${c.slice(4)}`;

export async function sha256(s: string): Promise<string> {
  return b64url.encode(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}

// PBKDF2: 100 000 итераций — максимум, который разрешает WebCrypto в Workers.
const PBKDF2_ITER = 100_000;
async function pbkdf2(password: string, salt: Uint8Array, iter: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256));
}
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITER}$${b64url.encode(salt)}$${b64url.encode(await pbkdf2(password, salt, PBKDF2_ITER))}`;
}
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, iter, salt, hash] = stored.split('$');
  if (alg !== 'pbkdf2') return false;
  const got = await pbkdf2(password, b64url.decode(salt), Number(iter));
  const want = b64url.decode(hash);
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
  return diff === 0;
}

export const parseJson = <T>(s: string | null | undefined, fallback: T): T => {
  if (s == null) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
};

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export const bad = (msg: string) => new HttpError(400, msg);

export function str(v: unknown, field: string, { max = 500, required = false } = {}): string {
  if (v == null || v === '') {
    if (required) throw bad(`Поле «${field}» обязательно`);
    return '';
  }
  if (typeof v !== 'string') throw bad(`Поле «${field}» должно быть строкой`);
  const s = v.trim();
  if (required && !s) throw bad(`Поле «${field}» обязательно`);
  if (s.length > max) throw bad(`Поле «${field}» длиннее ${max} символов`);
  return s;
}

export async function getMeta(db: D1Database, key: string): Promise<string | null> {
  const r = await db.prepare('SELECT value FROM meta WHERE key = ?').bind(key).first<{ value: string }>();
  return r?.value ?? null;
}
export function setMetaStmt(db: D1Database, key: string, value: string): D1PreparedStatement {
  return db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, value);
}
