const CACHE_VERSION = 'v2';
const SHELL_CACHE = `fraudio-pwa-${CACHE_VERSION}`;
const THUMB_CACHE = `fraudio-thumbs-${CACHE_VERSION}`;

const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/favicon.svg',
  '/icon-192.png',
  '/icon-512.png'
];

// A browse grid can show a few hundred covers before the user scrolls away.
// Capping keeps the WebView's storage bounded without evicting anything the
// current session is likely to need.
const THUMB_MAX_ENTRIES = 400;

/** Cover art. The server already serves these with a week-long max-age. */
function isThumbnail(url) {
  return (
    url.pathname.startsWith('/covers/') ||
    /^\/api\/items\/[^/]+\/cover$/.test(url.pathname)
  );
}

/** Streaming audio and torrent downloads must never be touched. */
function isBypassed(url) {
  return (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/stream/') ||
    url.pathname.endsWith('.apk')
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
    caches.open(SHELL_CACHE).then((cache) => {
      return cache.addAll(PRECACHE_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key !== SHELL_CACHE && key !== THUMB_CACHE)
          .map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

// Signing out must not leave the previous user's covers on disk.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'purge-thumbs') {
    event.waitUntil(caches.delete(THUMB_CACHE));
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  // Cover art: stale-while-revalidate. A cached cover paints instantly and a
  // changed one still updates, because the background revalidation costs a
  // bodiless 304 when nothing moved.
  if (isThumbnail(url)) {
    event.respondWith(
      caches.open(THUMB_CACHE).then((cache) =>
        cache.match(req).then((cached) => {
          const network = fetch(req)
            .then((response) => {
              if (response && response.ok && response.type === 'basic') {
                const clone = response.clone();
                cache.put(req, clone).then(() => trimCache(cache, THUMB_MAX_ENTRIES));
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

  // The library payloads are cached in IndexedDB by the page itself, which can
  // key them per user; the rest of the API stays uncached.
  if (isBypassed(url)) return;

  // HTML navigation: Network-first, fallback to cached index.html
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Static assets: Cache-first, fallback to network
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(req, clone));
        }
        return response;
      });
    })
  );
});