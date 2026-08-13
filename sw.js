const CACHE='cozy-shell-v22';
const SHELL=[
  './','./index.html','./manifest.webmanifest',
  './core/runtime-config.js','./core/runtime.js','./core/data.js','./core/memory.js',
  './core/butler_widget.js','./core/pwa.js','./core/mobile.js','./logger.js',
  './pages/orchard.html','./pages/heart_hollow.html','./pages/travel.html',
  './pages/bedroom.html','./pages/memory_nook.html',
  './assets/app/icon-180.png','./assets/app/icon-192.png','./assets/app/icon-512.png',
  './assets/estate/butler_dog.webp'
];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(event.request.method!=='GET'||url.origin!==location.origin||url.pathname.startsWith('/api/'))return;
  if(url.pathname.includes('/assets/')){
    event.respondWith(caches.match(event.request).then(hit=>hit||fetch(event.request).then(response=>{
      if(response.ok){const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(event.request,copy));}
      return response;
    })));
    return;
  }
  event.respondWith(fetch(event.request).then(response=>{
    if(response.ok){const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(event.request,copy));}
    return response;
  }).catch(async()=>{
    const hit=await caches.match(event.request);
    if(hit)return hit;
    if(event.request.mode==='navigate')return caches.match('./index.html');
    return new Response('',{status:503,statusText:'Offline'});
  }));
});
