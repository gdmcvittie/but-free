const CACHE_VERSION = 'v2';
const SHELL_CACHE = `FREEVEE-${CACHE_VERSION}`;
const THUMB_CACHE = `FREEVEE-thumbs-${CACHE_VERSION}`;
const PRECACHE_URLS = ['/', '/index.html'];

// A browse grid can show a few hundred posters before the user moves on.
// Capping keeps the WebView's storage bounded without evicting anything the
// current session is likely to need.
const THUMB_MAX_ENTRIES = 400;

/** Posters come from our own proxy routes; the CDN originals are remote. */
function isThumbnail(url) {
  return (
    url.pathname.startsWith('/api/whatson/poster') ||
    url.pathname.startsWith('/api/services/poster/')
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
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== SHELL_CACHE && key !== THUMB_CACHE)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// Signing out must not leave the previous account's posters on disk.
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

  // Posters: stale-while-revalidate, whether they come from our own proxy or
  // from a CDN. A cached image paints instantly and a changed one still
  // updates, because the background revalidation costs a bodiless 304 when
  // nothing moved. CDN responses are opaque, so "did it work" means "did we get
  // a response at all".
  const isImage = request.destination === 'image';
  if (isImage && (url.origin === self.location.origin ? isThumbnail(url) : true)) {
    event.respondWith(
      caches.open(THUMB_CACHE).then((cache) =>
        cache.match(request).then((cached) => {
          const network = fetch(request)
            .then((response) => {
              // Opaque (type 'opaque', status 0) counts as success here.
              if (response && (response.ok || response.type === 'opaque')) {
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

  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match('/')))
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow('/?tab=ondemand');
      }
    })
  );
});