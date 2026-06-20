/* EventOS PWA service worker */
const SHELL = 'eventos-shell-v1';
const ASSETS = 'eventos-assets-v1';
const SHELL_URLS = ['/index.html', '/offline.html'];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    try { const c = await caches.open(SHELL); await c.addAll(SHELL_URLS); } catch (_) {}
    self.skipWaiting();
  })());
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== SHELL && k !== ASSETS).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});
const bypass = (p) => /^\/(api|go2rtc|socket\.io)\//.test(p);
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;     // CDN/tiles: dejar pasar
  if (bypass(url.pathname)) return;                     // datos en vivo: nunca cachear
  if (req.mode === 'navigate') {                        // navegaciones: red, fallback al shell
    e.respondWith((async () => {
      try { return await fetch(req); }
      catch (_) { return (await caches.match('/index.html')) || (await caches.match('/offline.html')) || Response.error(); }
    })());
    return;
  }
  if (url.pathname.startsWith('/assets/')) {            // bundle hasheado: cache-first
    e.respondWith((async () => {
      const hit = await caches.match(req); if (hit) return hit;
      const net = await fetch(req); const c = await caches.open(ASSETS); c.put(req, net.clone()); return net;
    })());
    return;
  }
  e.respondWith((async () => {                          // resto: stale-while-revalidate
    const c = await caches.open(ASSETS);
    const hit = await c.match(req);
    const p = fetch(req).then((net) => { c.put(req, net.clone()); return net; }).catch(() => hit);
    return hit || p;
  })());
});
