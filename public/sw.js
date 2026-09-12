/*
 * Service worker for the warehouse floor: the app shell, stylesheet and scanner
 * libraries are cached so a phone can open the app inside a metal tool room with
 * no signal. API traffic is never cached - stale stock or tooling data would be
 * worse than an honest "the server is not reachable" message.
 */
const VERSION = 'sp-tooling-v1';
const SHELL = ['/', '/index.html', '/css/app.css', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png', '/vendor/jsqr.js', '/vendor/zxing.js'];
const isShell = (url) => SHELL.some((p) => url.pathname === p) || url.pathname.startsWith('/js/');

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL, { cache: 'reload' }))
      .catch(() => undefined) // an offline-first install must never block activation
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // always live data

  // Navigations: try the network, fall back to the cached shell.
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('/index.html').then((r) => r || caches.match('/'))));
    return;
  }

  if (!isShell(url)) return;

  // Static assets: serve from cache, refresh in the background.
  event.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const hit = await cache.match(req);
      const refresh = fetch(req)
        .then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);
      return hit || (await refresh) || Response.error();
    }),
  );
});
