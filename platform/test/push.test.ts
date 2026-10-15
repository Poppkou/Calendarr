import { describe, expect, it } from 'vitest';
import { b64url, encryptPayload, generateVapidKeys, sendWebPush, vapidAuthHeader } from '../src/push';

const enc = new TextEncoder();

/** Расшифровка так, как это делает браузер (RFC 8291) — доказывает корректность шифрования. */
async function decrypt(body: Uint8Array, uaPriv: CryptoKey, uaPublic: Uint8Array, auth: Uint8Array): Promise<string> {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16);
  expect(rs).toBe(4096);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const cipher = body.slice(21 + idlen);
  const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, uaPriv, 256));
  const h = async (s: Uint8Array, ikm: Uint8Array, info: Uint8Array, n: number) => {
    const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: s, info }, k, n * 8));
  };
  const keyInfo = new Uint8Array([...enc.encode('WebPush: info\0'), ...uaPublic, ...asPublic]);
  const ikm = await h(auth, secret, keyInfo, 32);
  const cek = await h(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await h(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const k = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, k, cipher));
  expect(plain[plain.length - 1]).toBe(2);
  return new TextDecoder().decode(plain.slice(0, -1));
}

async function browserSubscription() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { kp, pub, auth, sub: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: b64url.encode(pub), auth: b64url.encode(auth) } } };
}

describe('web push', () => {
  it('encrypts payload that the browser can decrypt', async () => {
    const { kp, pub, auth, sub } = await browserSubscription();
    const msg = JSON.stringify({ title: 'Трансфер ✈️', body: 'x'.repeat(2000) });
    const body = await encryptPayload(sub, enc.encode(msg));
    expect(await decrypt(body, kp.privateKey, pub, auth)).toBe(msg);
  });

  it('signs a valid VAPID JWT', async () => {
    const keys = await generateVapidKeys();
    const header = await vapidAuthHeader('https://fcm.googleapis.com/fcm/send/abc', { ...keys, subject: 'mailto:a@b.c' });
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
    expect(m[2]).toBe(keys.publicKey);
    const [h, p, s] = m[1].split('.');
    const payload = JSON.parse(new TextDecoder().decode(b64url.decode(p)));
    expect(payload.aud).toBe('https://fcm.googleapis.com');
    expect(payload.exp).toBeGreaterThan(Date.now() / 1000);
    const pubKey = await crypto.subtle.importKey('raw', b64url.decode(keys.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pubKey, b64url.decode(s), enc.encode(`${h}.${p}`));
    expect(ok).toBe(true);
  });

  it('classifies push service responses', async () => {
    const { sub } = await browserSubscription();
    const v = { ...(await generateVapidKeys()), subject: 'mailto:a@b.c' };
    const msg = { payload: { a: 1 }, ttlSec: 600, urgency: 'high' as const, topic: 'ev-123' };
    const respond = (status: number, headers: Record<string, string> = {}) => (async (_u: any, init: any) => {
      expect(init.headers['Content-Encoding']).toBe('aes128gcm');
      expect(init.headers.TTL).toBe('600');
      return new Response('err', { status, headers });
    }) as typeof fetch;
    expect((await sendWebPush(sub, msg, v, respond(201))).outcome).toBe('sent');
    expect((await sendWebPush(sub, msg, v, respond(410))).outcome).toBe('gone');
    expect((await sendWebPush(sub, msg, v, respond(404))).outcome).toBe('gone');
    expect(await sendWebPush(sub, msg, v, respond(429, { 'retry-after': '120' }))).toMatchObject({ outcome: 'retry', retryAfterSec: 120 });
    expect((await sendWebPush(sub, msg, v, respond(503))).outcome).toBe('retry');
    expect((await sendWebPush(sub, msg, v, respond(403))).outcome).toBe('failed');
    const boom = (async () => { throw new Error('ECONNRESET'); }) as typeof fetch;
    expect((await sendWebPush(sub, msg, v, boom)).outcome).toBe('retry');
    const broken = { ...sub, keys: { p256dh: 'AAAA', auth: 'BBBB' } };
    expect((await sendWebPush(broken, msg, v, respond(201))).outcome).toBe('gone');
  });
});
