const CACHE_NAME = 'comixcloud-shell-v1';
const PRECACHE = ['/', '/192.png', '/512.png', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => keys.filter((key) => key !== CACHE_NAME))
      .then((stale) => Promise.all(stale.map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch (e) {
    return;
  }

  // Only cache same-origin assets. Never cache API requests (auth + sessions).
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // Hashed build assets, icons and manifest: stale-while-revalidate (immutable content).
  const isStatic =
    url.pathname.startsWith('/assets/') ||
    url.pathname === '/192.png' ||
    url.pathname === '/512.png' ||
    url.pathname === '/manifest.webmanifest' ||
    url.pathname === '/favicon.svg';

  if (isStatic) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const network = fetch(request)
          .then((response) => {
            if (response && response.ok) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
            }
            return response;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  // Navigation (app shell): network-first, fall back to the cached shell when offline
  // so downloaded comics can still be read with the offline reader.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put('/', clone));
          }
          return response;
        })
        .catch(() =>
          caches.match('/').then((shell) => shell || caches.match(request))
        )
    );
  }
});