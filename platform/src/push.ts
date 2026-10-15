// Web Push без зависимостей: VAPID (RFC 8292) + шифрование aes128gcm (RFC 8291) на WebCrypto.

export const b64url = {
  encode(buf: ArrayBuffer | Uint8Array): string {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(str: string): Uint8Array {
    const s = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
    const bin = atob(s);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  },
};

const enc = new TextEncoder();
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export interface VapidKeys { publicKey: string; privateKey: string; subject: string }
export interface PushSubscriptionData { endpoint: string; keys: { p256dh: string; auth: string } }

let signingKeyCache: { pk: string; key: CryptoKey } | null = null;
async function vapidSigningKey(v: VapidKeys): Promise<CryptoKey> {
  if (signingKeyCache?.pk === v.privateKey) return signingKeyCache.key;
  const pub = b64url.decode(v.publicKey);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID_PUBLIC_KEY должен быть несжатым ключом P-256 (65 байт)');
  const key = await crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256', d: v.privateKey,
    x: b64url.encode(pub.slice(1, 33)), y: b64url.encode(pub.slice(33, 65)), ext: true,
  }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  signingKeyCache = { pk: v.privateKey, key };
  return key;
}

export async function vapidAuthHeader(endpoint: string, v: VapidKeys, now = Date.now()): Promise<string> {
  const aud = new URL(endpoint).origin;
  const header = b64url.encode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64url.encode(enc.encode(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: v.subject })));
  const unsigned = `${header}.${payload}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await vapidSigningKey(v), enc.encode(unsigned));
  return `vapid t=${unsigned}.${b64url.encode(sig)}, k=${v.publicKey}`;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8));
}

/** Шифрует payload для подписки (одна запись aes128gcm). */
export async function encryptPayload(sub: PushSubscriptionData, plaintext: Uint8Array): Promise<Uint8Array> {
  const uaPublic = b64url.decode(sub.keys.p256dh);
  const authSecret = b64url.decode(sub.keys.auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error('bad subscription keys');

  const asKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey } as any, asKeys.privateKey, 256));

  const ikm = await hkdf(authSecret, ecdhSecret, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const record = concat(plaintext, new Uint8Array([2])); // 0x02 — разделитель последней записи
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, record));

  const rs = 4096;
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, rs);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, cipher);
}

export type SendResult =
  | { outcome: 'sent' }
  | { outcome: 'gone'; status: number }                  // подписка больше не существует
  | { outcome: 'retry'; status: number; error: string; retryAfterSec?: number }
  | { outcome: 'failed'; status: number; error: string };

export interface WebPushMessage { payload: unknown; ttlSec: number; urgency: 'normal' | 'high'; topic?: string }

export async function sendWebPush(sub: PushSubscriptionData, msg: WebPushMessage, v: VapidKeys, fetcher: typeof fetch = fetch): Promise<SendResult> {
  let body: Uint8Array;
  try {
    body = await encryptPayload(sub, enc.encode(JSON.stringify(msg.payload)));
  } catch (e) {
    return { outcome: 'gone', status: 0 }; // повреждённые ключи подписки — восстановить нельзя
  }
  const headers: Record<string, string> = {
    Authorization: await vapidAuthHeader(sub.endpoint, v),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(Math.max(0, Math.min(Math.round(msg.ttlSec), 2419200))),
    Urgency: msg.urgency,
  };
  // Topic заменяет недоставленное сообщение с тем же topic (≤32 символов base64url).
  if (msg.topic) headers.Topic = msg.topic.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  let res: Response;
  try {
    res = await fetcher(sub.endpoint, { method: 'POST', headers, body });
  } catch (e) {
    return { outcome: 'retry', status: 0, error: `network: ${(e as Error).message}` };
  }
  if (res.status >= 200 && res.status < 300) return { outcome: 'sent' };
  const text = (await res.text().catch(() => '')).slice(0, 200);
  if (res.status === 404 || res.status === 410) return { outcome: 'gone', status: res.status };
  if (res.status === 429 || res.status >= 500) {
    const ra = Number(res.headers.get('retry-after'));
    return { outcome: 'retry', status: res.status, error: text, retryAfterSec: Number.isFinite(ra) && ra > 0 ? ra : undefined };
  }
  // 400/401/403/413: ошибка конфигурации или запроса — повтор не поможет.
  return { outcome: 'failed', status: res.status, error: text };
}

/** Генерация пары VAPID-ключей (для npm run vapid). */
export async function generateVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey) as JsonWebKey;
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey) as ArrayBuffer);
  return { publicKey: b64url.encode(pub), privateKey: jwk.d! };
}
