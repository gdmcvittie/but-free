const CACHE_VERSION = 'v2';
const SHELL_CACHE = `comixcloud-shell-${CACHE_VERSION}`;
const THUMB_CACHE = `comixcloud-thumbs-${CACHE_VERSION}`;

const PRECACHE = ['/', '/192.png', '/512.png', '/manifest.webmanifest'];

// A shelf can scroll through hundreds of covers; capping keeps the WebView's
// storage bounded without evicting anything the current session is likely to need.
const THUMB_MAX_ENTRIES = 400;

/**
 * Cover art served by our own origin.
 *
 * Reader pages are deliberately left out: the offline reader already keeps page
 * blobs in IndexedDB, and caching them here too would store every downloaded
 * issue twice. Undownloaded pages rely on the response's own immutable
 * Cache-Control.
 */
function isThumbnail(url) {
  return (
    url.pathname.startsWith('/covers/') ||
    /^\/api\/comics\/[^/]+\/cover$/.test(url.pathname)
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
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => keys.filter((key) => key !== SHELL_CACHE && key !== THUMB_CACHE))
      .then((stale) => Promise.all(stale.map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// Signing out must not leave the previous account's covers on disk.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'purge-thumbs') {
    event.waitUntil(caches.delete(THUMB_CACHE));
  }
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

  // Covers: stale-while-revalidate. A cached image paints instantly and a changed
  // one still updates, because the background revalidation costs a bodiless 304
  // when nothing moved.
  if (isThumbnail(url)) {
    event.respondWith(
      caches.open(THUMB_CACHE).then((cache) =>
        cache.match(request).then((cached) => {
          const network = fetch(request)
            .then((response) => {
              if (response && response.ok) {
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

  // Only cache same-origin assets. The shelf payload is cached in IndexedDB by
  // the page itself, which can key it per account; the rest of the API carries
  // session state and stays uncached.
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
              caches.open(SHELL_CACHE).then((cache) => cache.put(request, clone));
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
            caches.open(SHELL_CACHE).then((cache) => cache.put('/', clone));
          }
          return response;
        })
        .catch(() =>
          caches.match('/').then((shell) => shell || caches.match(request))
        )
    );
  }
});