const CACHE_NAME = 'campus-companion-shell-v4';
const ASSETS_TO_CACHE = [
  './',
  'index.html',
  'privacy.html',
  'terms.html',
  'styles.css',
  'fonts/inter-400-latin.woff2',
  'fonts/inter-500-latin.woff2',
  'fonts/inter-600-latin.woff2',
  'fonts/inter-700-latin.woff2',
  'fonts/inter-800-latin.woff2',
  'vendor/supabase-2.117.3.js',
  'app.js',
  'calc.js',
  'config.js',
  'manifest.webmanifest',
  'favicon.svg',
  'favicon.ico',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS_TO_CACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter((name) => name !== CACHE_NAME)
            .map((name) => caches.delete(name))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname.includes('/rest/v1/')) return;

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(event.request)
        .then((networkResponse) => {
          if (
            networkResponse &&
            networkResponse.status === 200 &&
            networkResponse.type === 'basic'
          ) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseClone);
            });
          }
          return networkResponse;
        })
        .catch(() => {
          if (event.request.mode === 'navigate') {
            return caches.match('index.html');
          }
        });
    })
  );
});
