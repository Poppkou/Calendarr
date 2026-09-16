const CACHE='pulse-v3';
const ASSETS=['index.html','manifest.json','icon-192.png','icon-512.png'];

self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS).catch(()=>{})));
  self.skipWaiting();
});

self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  e.respondWith(caches.match(e.request).then(cached=>{
    const fresh=fetch(e.request).then(r=>{
      if(r&&r.status===200){const cp=r.clone();caches.open(CACHE).then(c=>c.put(e.request,cp))}
      return r;
    }).catch(()=>cached);
    return cached||fresh;
  }));
});

/* нажатия на уведомления в шторке: «Открыть» и «Отложить» */
self.addEventListener('notificationclick',e=>{
  e.notification.close();
  const d=e.notification.data||{};
  const act=e.action||'open';
  e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{
    const c=list.find(x=>x.url.startsWith(self.location.origin));
    if(c){c.focus();c.postMessage({type:act,id:d.id,date:d.date});return}
    const url=act==='snooze'?`./index.html?snooze=${encodeURIComponent(d.id)}`:`./index.html?open=${encodeURIComponent(d.date||'')}`;
    return clients.openWindow(url);
  }));
});
