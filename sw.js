const CACHE_NAME = 'signalbot-real-v1';
const APP_SHELL = [
  '/index.html',
  '/manifest.json',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // API/data requests must always be fresh.
  if (url.pathname.startsWith('/api/') || url.hostname.includes('workers.dev') || url.hostname.includes('binance') || url.hostname.includes('yahoo') || url.hostname.includes('gdelt')) {
    event.respondWith(fetch(req).catch(() => new Response(JSON.stringify({ error: 'offline' }), { status: 503, headers: { 'content-type': 'application/json' } })));
    return;
  }

  event.respondWith(
    caches.match(req).then(cached => cached || fetch(req).then(res => {
      if (res && res.status === 200 && req.method === 'GET') {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
      }
      return res;
    }).catch(() => req.mode === 'navigate' ? caches.match('/index.html') : undefined))
  );
});
