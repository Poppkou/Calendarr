import { expect, vi } from 'vitest';
import worker from '../src/index';
import { runDispatch } from '../src/dispatch';
import { b64url, generateVapidKeys } from '../src/push';
import { zonedToUtc } from '../src/time';
import type { Env } from '../src/util';
import { createD1 } from './d1shim';

export const TZ = 'Europe/Istanbul';
export const T0 = zonedToUtc('2026-05-10', '12:00', TZ);

export interface Sent { url: string; body: any; kind: 'push' | 'tg' }

export async function setup() {
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
  let tgMsgId = 1000;
  const waits: Promise<unknown>[] = [];
  const fetchMock = vi.fn(async (input: any, init?: any) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://api.telegram.org/')) {
      sent.push({ url, body: JSON.parse(init.body), kind: 'tg' });
      return Response.json({ ok: true, result: { message_id: ++tgMsgId } });
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

