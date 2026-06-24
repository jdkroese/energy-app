// Power PWA service worker — minimal, safe for a Vite SPA with hashed assets.
// Strategy: navigations = network-first (offline.html fallback); static assets =
// cache-first runtime; /api/ = always network (never cache live energy data).
const VERSION = 'power-v1';
const PRECACHE = `${VERSION}-precache`;
const RUNTIME = `${VERSION}-runtime`;
const PRECACHE_URLS = ['/offline.html', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(PRECACHE).then((c) => c.addAll(PRECACHE_URLS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Never cache the API — energy data must be live.
  if (url.pathname.startsWith('/api/')) return;

  // Navigations: network-first, fall back to cached shell / offline page.
  if (request.mode === 'navigate') {
    e.respondWith(
      fetch(request).catch(() => caches.match(request).then((r) => r || caches.match('/offline.html')))
    );
    return;
  }

  // Same-origin static assets: cache-first, then revalidate in the background.
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(request).then((cached) => {
        const network = fetch(request).then((res) => {
          if (res && res.status === 200) caches.open(RUNTIME).then((c) => c.put(request, res.clone()));
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    );
  }
});
