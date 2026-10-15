// Service worker туриста: офлайн-кэш расписания, показ push-уведомлений, восстановление подписки.
const VERSION = 'pt-v1';
const SHELL = ['/app/', '/app/app.js', '/app/app.css', '/app/icon-192.png', '/app/icon-512.png'];
const META = '/__pt_meta__';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('pt-') && k !== VERSION && k !== 'pt-data' && k !== 'pt-meta').map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

const putCache = async (name, req, res) => { try { const c = await caches.open(name); await c.put(req, res); } catch { /* квота */ } };

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Страница тура: сначала сеть, без сети — оболочка приложения из кэша.
  if (req.mode === 'navigate' && /^\/t\/[^/]+\/?$/.test(url.pathname)) {
    e.respondWith(fetch(req).then((r) => {
      if (r.ok) putCache(VERSION, '/app/', r.clone());
      return r;
    }).catch(async () => (await caches.match('/app/')) || Response.error()));
    return;
  }
  // Данные тура: сначала сеть (с таймаутом), иначе последняя сохранённая копия.
  if (/^\/api\/t\/[^/]+$/.test(url.pathname)) {
    e.respondWith((async () => {
      try {
        const r = await Promise.race([fetch(req), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 12000))]);
        if (r.ok) {
          const h = new Headers(r.headers);
          h.set('x-pt-saved-at', String(Date.now()));
          putCache('pt-data', url.pathname, new Response(await r.clone().arrayBuffer(), { status: 200, headers: h }));
        }
        return r;
      } catch (err) {
        const cached = await caches.match(url.pathname, { cacheName: 'pt-data' });
        if (!cached) throw err;
        // Помечаем ответ как сохранённую копию, чтобы приложение честно показало «нет интернета».
        const h = new Headers(cached.headers);
        h.set('x-pt-offline', '1');
        return new Response(cached.body, { status: 200, headers: h });
      }
    })());
    return;
  }
  // Статика приложения: stale-while-revalidate.
  if (url.pathname.startsWith('/app/')) {
    e.respondWith((async () => {
      const cached = await caches.match(req);
      const fresh = fetch(req).then((r) => { if (r.ok) putCache(VERSION, req, r.clone()); return r; }).catch(() => cached);
      return cached || fresh;
    })());
  }
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'meta') {
    e.waitUntil(putCache('pt-meta', META, new Response(JSON.stringify({ token: e.data.token, vapid: e.data.vapid }))));
  }
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'Мой тур', body: e.data ? e.data.text() : '' }; }
  e.waitUntil((async () => {
    await self.registration.showNotification(d.title || 'Мой тур', {
      body: d.body || '',
      icon: '/app/icon-192.png',
      badge: '/app/icon-192.png',
      tag: d.tag || undefined,
      renotify: !!d.tag,
      requireInteraction: !!d.urgent,
      vibrate: d.urgent ? [300, 150, 300, 150, 300] : [200, 100, 200],
      data: { url: d.url || '/app/' },
    });
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    list.forEach((c) => c.postMessage({ type: 'push' }));
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || '/app/', self.location.origin).href;
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const same = list.find((c) => c.url.split('#')[0] === target);
    if (same) return same.focus();
    return self.clients.openWindow(target);
  })());
});

// Браузер сменил подписку (истекла/обновилась) — переподписываемся без участия туриста.
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil((async () => {
    const res = await caches.match(META, { cacheName: 'pt-meta' });
    if (!res) return;
    const { token, vapid } = await res.json();
    if (!token || !vapid) return;
    let s = vapid.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const key = Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    const sub = (e.newSubscription) || await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await fetch(`/api/t/${token}/webpush`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sub.toJSON()) });
  })());
});
