// Генерирует пару VAPID-ключей для Web Push. Запуск: npm run vapid
const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
const pub = Buffer.from(await crypto.subtle.exportKey('raw', kp.publicKey)).toString('base64url');
console.log(`VAPID_PUBLIC_KEY=${pub}\nVAPID_PRIVATE_KEY=${jwk.d}`);
console.log('\nСохраните в Cloudflare:\n  npx wrangler secret put VAPID_PUBLIC_KEY\n  npx wrangler secret put VAPID_PRIVATE_KEY');
console.log('Внимание: если поменять ключи позже, всем туристам придётся заново включить уведомления.');
