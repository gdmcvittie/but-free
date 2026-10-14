const SHELL_CACHE = 'freeplay-shell-v2';
const THUMB_CACHE = 'freeplay-thumbs-v2';
const PRECACHE_URLS = [
  '/manifest.webmanifest',
  '/favicon.svg',
  '/freeplay-pwa-icon.svg',
  '/icon-192.png',
  '/icon-512.png'
];

// A shelf can scroll through hundreds of box arts; capping keeps the WebView's
// storage bounded without evicting anything the current session is likely to need.
const THUMB_MAX_ENTRIES = 400;

async function precacheAppShell() {
  const cache = await caches.open(SHELL_CACHE);
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

/**
 * Box art sources.
 *
 * `/api/drive/file/:id` is a general Drive passthrough that also serves ROMs, so
 * a response is only ever stored once it turns out to be an image - that keeps
 * a multi-gigabyte ROM out of the thumbnail cache.
 */
function isThumbnail(url) {
  return (
    url.pathname.startsWith('/api/proxy-image') ||
    /^\/api\/drive\/file\/[^/]+$/.test(url.pathname)
  );
}

/** Drops the oldest entries once the cache outgrows its cap. */
async function trimCache(cache, max) {
  const keys = await cache.keys();
  if (keys.length <= max) return;
  await Promise.all(keys.slice(0, keys.length - max).map((key) => cache.delete(key)));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(precacheAppShell)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys
        .filter((key) => key.startsWith('freeplay-') && key !== SHELL_CACHE && key !== THUMB_CACHE)
        .map((key) => caches.delete(key))
    ))
      .then(() => self.clients.claim())
  );
});

// Signing out must not leave the previous account's box art on disk.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'purge-thumbs') {
    event.waitUntil(caches.delete(THUMB_CACHE));
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Box art: stale-while-revalidate. A cached image paints instantly and a
  // changed one still updates, because the background revalidation costs a
  // bodiless 304 when nothing moved.
  if (url.origin === self.location.origin && isThumbnail(url)) {
    event.respondWith(
      caches.open(THUMB_CACHE).then((cache) =>
        cache.match(request).then((cached) => {
          const network = fetch(request)
            .then((response) => {
              const isImage = response
                && response.ok
                && (response.headers.get('Content-Type') || '').startsWith('image/');
              if (isImage) {
                const clone = response.clone();
                cache.put(request, clone).then(() => trimCache(cache, THUMB_MAX_ENTRIES));
              }
              return response;
            })
            .catch(() => null);

          if (cached) {
            event.waitUntil(network);
            return cached;
          }
          return network.then((response) => response || new Response('', { status: 504 }));
        })
      )
    );
    return;
  }

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
          caches.open(SHELL_CACHE).then((cache) => cache.put('/', copy));
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
            caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        });
      })
    );
  }
});