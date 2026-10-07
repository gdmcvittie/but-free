const CACHE_NAME = 'freeplay-shell-v1';
const PRECACHE_URLS = [
  '/manifest.webmanifest',
  '/favicon.svg',
  '/freeplay-pwa-icon.svg',
  '/icon-192.png',
  '/icon-512.png'
];

async function precacheAppShell() {
  const cache = await caches.open(CACHE_NAME);
  const response = await fetch('/', { cache: 'reload' });
  if (!response.ok) throw new Error(`Could not fetch FREEPLAY shell (${response.status})`);

  await cache.put('/', response.clone());
  await cache.put('/index.html', response.clone());

  const html = await response.text();
  const assetUrls = new Set();
  const assetPattern = /(?:src|href)=["']([^"']*\/assets\/[^"']+)["']/g;
  for (const match of html.matchAll(assetPattern)) {
    assetUrls.add(new URL(match[1], self.location.origin).href);
  }

  await Promise.all([...assetUrls].map(async (assetUrl) => {
    const assetResponse = await fetch(assetUrl, { cache: 'reload' });
    if (assetResponse.ok) await cache.put(assetUrl, assetResponse);
  }));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(precacheAppShell)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key.startsWith('freeplay-') && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Auth, APIs, ROM streams, and downloadable packages must always go to the
  // network and must never be written into the shared app-shell cache.
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/auth/') ||
    url.pathname.startsWith('/stream/') ||
    url.pathname.endsWith('.apk')
  ) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('/', copy));
        }
        return response;
      }).catch(async () => {
        const cached = await caches.match('/') || await caches.match('/index.html');
        return cached || new Response('FREEPLAY is offline. Open the app while online to cache its shell.', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
      })
    );
    return;
  }

  const isAppAsset = url.pathname.startsWith('/assets/') || [
    '/manifest.webmanifest',
    '/favicon.svg',
    '/freeplay-pwa-icon.svg',
    '/icon-192.png',
    '/icon-512.png'
  ].includes(url.pathname);
  const isEmulatorAsset = url.pathname.startsWith('/cores/');
  if (isAppAsset || isEmulatorAsset) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        });
      })
    );
  }
});
