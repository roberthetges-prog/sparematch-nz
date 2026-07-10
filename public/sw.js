// TapSnap service worker — stale-while-revalidate for same-origin GETs; API always live.
const CACHE = 'tapsnap-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(e.request);
      const net = fetch(e.request)
        .then((res) => { if (res && res.status === 200) cache.put(e.request, res.clone()); return res; })
        .catch(() => cached);
      return cached || net;
    })
  );
});
