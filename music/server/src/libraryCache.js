/**
 * Persistent cache for the grouped library payload.
 *
 * `/api/library/groups` serialises the whole library in one response - for a
 * large collection that is around a megabyte of JSON, and it is by far the
 * slowest part of a cold start. The payload only changes when the user scans or
 * edits something, so we keep the last one in IndexedDB:
 *
 *   - a warm start paints from disk immediately and revalidates in the
 *     background, so the browse view is never blocked on the network;
 *   - revalidation sends the stored ETag, so an unchanged library costs a bodiless
 *     304 and React never re-groups a thousand items for nothing.
 *
 * Entries are keyed by user and library kind, so signing in as somebody else
 * never reads somebody else's cached library.
 */

const DB_NAME = 'fraudio_library_cache';
const DB_VERSION = 1;
const STORE = 'payloads';

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB unavailable'));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'key' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('IndexedDB upgrade blocked'));
    }).catch((err) => {
      // Do not cache the failure: a later open (after storage is freed) can work.
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

async function readEntry(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function writeEntry(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ key, savedAt: Date.now(), ...value });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Cache key for one user's view of one library. */
export function libraryCacheKey(userId, kind) {
  return `${userId || 'anonymous'}:${kind === 'music' ? 'music' : 'audiobooks'}`;
}

/**
 * Last known payload for this key, or null on a cold start.
 *
 * Never throws: a missing cache just means the caller waits for the network.
 */
export async function readCachedLibrary(key) {
  try {
    const entry = await readEntry(key);
    return entry?.data ?? null;
  } catch {
    return null;
  }
}

/**
 * Bring the cached entry up to date.
 *
 * `load(etag, { force })` must resolve to `{ data, etag, notModified }` - see
 * `api.libraryGroupsIfChanged`. Resolves to `{ data, changed }`, where
 * `changed` is false when the server confirmed the cached copy is current, so
 * callers can skip a re-render.
 */
export async function revalidateLibrary(key, load, { force = false } = {}) {
  let entry = null;
  try {
    entry = await readEntry(key);
  } catch {
    /* cold start */
  }

  const result = await load(entry?.etag || null, { force });

  if (result.notModified && entry) {
    return { data: entry.data, changed: false };
  }

  try {
    await writeEntry(key, { data: result.data, etag: result.etag || null });
  } catch {
    // Best effort: a full or blocked database must not break the library view.
  }

  // Without a usable ETag we cannot prove the payload is identical, so treat
  // every body as a change.
  const changed = !entry || !result.etag || entry.etag !== result.etag;
  return { data: result.data, changed };
}

/** Drops every cached library. Used when signing out. */
export async function clearLibraryCache() {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* nothing to clear */
  }
}

/**
 * Asks the service worker to drop its cover cache.
 *
 * Cached covers are keyed by item id, which is scoped to one account, so they
 * have to go when we sign out. Resolves even when no worker is controlling the
 * page - then there is no cache to drop.
 */
export async function purgeThumbnailCache() {
  try {
    const registration = await navigator.serviceWorker?.ready;
    registration?.active?.postMessage({ type: 'purge-thumbs' });
  } catch {
    /* no service worker available */
  }
}
