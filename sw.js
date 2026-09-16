const CACHE='pulse-v4';
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

/* пришёл push из облака — показываем, даже если приложение закрыто */
self.addEventListener('push',e=>{
  let d={};try{d=e.data?e.data.json():{}}catch(err){}
  e.waitUntil((async()=>{
    if(!d.force){
      const list=await self.clients.matchAll({type:'window',includeUncontrolled:true});
      if(list.some(c=>c.visibilityState==='visible'))return; // приложение на экране — оно само покажет попап
    }
    await self.registration.showNotification(d.title||'Пульс',{
      body:d.body||'',icon:'icon-192.png',badge:'icon-192.png',
      tag:'push-'+(d.key||d.id||'x'),vibrate:[200,100,200],
      data:{id:d.id,date:d.date,server:d.server,src:'push',title:d.title},
      actions:[{action:'open',title:'Открыть'},{action:'snooze',title:'Отложить 10 мин'}]
    });
  })());
});

self.addEventListener('notificationclick',e=>{
  e.notification.close();
  const d=e.notification.data||{};
  const act=e.action||'open';
  e.waitUntil((async()=>{
    const list=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    const c=list.find(x=>x.url.startsWith(self.location.origin));
    if(c){c.focus();c.postMessage({type:act,id:d.id,date:d.date});return}
    if(act==='snooze'&&d.server){
      try{await fetch(d.server+'/snooze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:d.id,ds:d.date,minutes:10,title:d.title})})}catch(err){}
      return;
    }
    const url=act==='snooze'?`./index.html?snooze=${encodeURIComponent(d.id)}`:`./index.html?open=${encodeURIComponent(d.date||'')}`;
    await self.clients.openWindow(url);
  })());
});
