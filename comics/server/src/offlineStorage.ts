import { apiUrl } from './api';

export interface OfflineComic {
  id: any;
  title: string;
  totalPages: number;
  type?: string;
  series?: string;
  coverBlob?: Blob;
  coverUrl?: string;
  savedAt: number;
  downloadedPages: number;
  isComplete: boolean;
}

const DB_NAME = 'comixolo_offline';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;
const pageObjectUrls = new Map<string, string>();
const coverObjectUrls = new Map<any, string>();

/**
 * Synchronous lookup for an already-created offline cover blob URL
 */
export function getCachedOfflineCoverUrl(comicId: any): string | null {
  return coverObjectUrls.get(comicId) || null;
}

/**
 * Returns an object URL for a cached offline cover, or null if not stored
 */
export async function getOfflineCoverUrl(comicId: any): Promise<string | null> {
  if (coverObjectUrls.has(comicId)) {
    return coverObjectUrls.get(comicId)!;
  }
  const comic = await getOfflineComic(comicId);
  if (comic && comic.coverBlob) {
    const objectUrl = URL.createObjectURL(comic.coverBlob);
    coverObjectUrls.set(comicId, objectUrl);
    return objectUrl;
  }
  return null;
}

/**
 * Synchronous lookup for an already-created offline page blob URL
 */
export function getCachedOfflinePageUrl(comicId: any, pageNum: number): string | null {
  const key = `${comicId}_${pageNum}`;
  return pageObjectUrls.get(key) || null;
}

/**
 * Initialize and open IndexedDB database
 */
export function getOfflineDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !window.indexedDB) {
      return reject(new Error('IndexedDB not supported in this environment.'));
    }

    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;

      // 1. Store for comic archives metadata
      if (!db.objectStoreNames.contains('comics')) {
        const comicStore = db.createObjectStore('comics', { keyPath: 'id' });
        comicStore.createIndex('savedAt', 'savedAt', { unique: false });
        comicStore.createIndex('isComplete', 'isComplete', { unique: false });
      }

      // 2. Store for individual page image blobs
      if (!db.objectStoreNames.contains('pages')) {
        const pageStore = db.createObjectStore('pages', { keyPath: 'key' });
        pageStore.createIndex('comicId', 'comicId', { unique: false });
      }

      // 3. Store for library snapshot and app cache
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('comics') || !db.objectStoreNames.contains('pages')) {
        db.close();
        dbPromise = null;
        try {
          const delReq = window.indexedDB.deleteDatabase(DB_NAME);
          delReq.onsuccess = () => {
            getOfflineDB().then(resolve).catch(reject);
          };
          delReq.onerror = () => resolve(db);
          delReq.onblocked = () => resolve(db);
        } catch {
          resolve(db);
        }
        return;
      }
      resolve(db);
    };
    request.onerror = () => {
      dbPromise = null;
      reject(request.error || new Error('Failed to open offline database'));
    };
  });

  return dbPromise;
}

/**
 * Save or update comic metadata in offline store
 */
export async function saveOfflineComicMetadata(comic: OfflineComic): Promise<void> {
  const db = await getOfflineDB();
  if (!db.objectStoreNames.contains('comics')) return;
  return new Promise((resolve, reject) => {
    const tx = db.transaction('comics', 'readwrite');
    const store = tx.objectStore('comics');
    const req = store.put(comic);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/**
 * Get offline comic metadata by ID
 */
export async function getOfflineComic(comicId: any): Promise<OfflineComic | null> {
  try {
    const db = await getOfflineDB();
    if (!db.objectStoreNames.contains('comics')) return null;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('comics', 'readonly');
      const store = tx.objectStore('comics');
      const req = store.get(comicId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

/**
 * Get all comics saved for offline reading
 */
export async function getAllOfflineComics(): Promise<OfflineComic[]> {
  try {
    const db = await getOfflineDB();
    if (!db.objectStoreNames.contains('comics')) return [];
    return new Promise((resolve, reject) => {
      const tx = db.transaction('comics', 'readonly');
      const store = tx.objectStore('comics');
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

/**
 * Checks whether a comic is completely downloaded and ready for offline reading
 */
export async function isComicStoredOffline(comicId: any): Promise<boolean> {
  const comic = await getOfflineComic(comicId);
  return Boolean(comic && comic.isComplete);
}

/**
 * Save a single page image blob into IndexedDB
 */
export async function saveComicPageBlob(
  comicId: any,
  pageNum: number,
  blob: Blob,
  mimeType = 'image/jpeg'
): Promise<void> {
  const db = await getOfflineDB();
  const key = `${comicId}_${pageNum}`;
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pages', 'readwrite');
    const store = tx.objectStore('pages');
    const req = store.put({
      key,
      comicId,
      pageNum,
      blob,
      mimeType,
      savedAt: Date.now()
    });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/**
 * Retrieve a single page image blob from IndexedDB
 */
export async function getComicPageBlob(comicId: any, pageNum: number): Promise<Blob | null> {
  try {
    const db = await getOfflineDB();
    const key = `${comicId}_${pageNum}`;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('pages', 'readonly');
      const store = tx.objectStore('pages');
      const req = store.get(key);
      req.onsuccess = () => {
        if (req.result && req.result.blob) {
          resolve(req.result.blob);
        } else {
          resolve(null);
        }
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

/**
 * Returns a fast object URL for a cached offline page image, or null if not yet cached offline.
 */
export async function getOfflinePageUrl(comicId: any, pageNum: number): Promise<string | null> {
  const key = `${comicId}_${pageNum}`;
  if (pageObjectUrls.has(key)) {
    return pageObjectUrls.get(key)!;
  }

  const blob = await getComicPageBlob(comicId, pageNum);
  if (!blob) return null;

  const objectUrl = URL.createObjectURL(blob);
  pageObjectUrls.set(key, objectUrl);
  return objectUrl;
}

/**
 * Check if a specific page is cached offline
 */
export async function isPageCachedOffline(comicId: any, pageNum: number): Promise<boolean> {
  const blob = await getComicPageBlob(comicId, pageNum);
  return Boolean(blob && blob.size > 0);
}

/**
 * Save library snapshot to offline store so user can browse library when offline
 */
export async function saveLibraryOffline(comics: any[]): Promise<void> {
  try {
    const db = await getOfflineDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('meta', 'readwrite');
      const store = tx.objectStore('meta');
      const req = store.put({
        key: 'cached_library',
        comics,
        savedAt: Date.now()
      });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {}
}

/**
 * Retrieve library snapshot from offline store
 */
export async function getLibraryOffline(): Promise<any[]> {
  try {
    const db = await getOfflineDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('meta', 'readonly');
      const store = tx.objectStore('meta');
      const req = store.get('cached_library');
      req.onsuccess = () => {
        if (req.result && Array.isArray(req.result.comics)) {
          resolve(req.result.comics);
        } else {
          resolve([]);
        }
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

/**
 * Automatically downloads and caches an entire comic in the background when reading.
 */
export function autoDownloadComicForOffline(
  comic: any,
  totalPages?: number,
  onProgress?: (downloaded: number, total: number, isFinished: boolean) => void
): () => void {
  let isAborted = false;

  if (!comic || !comic.id) {
    return () => {};
  }

  const comicId = comic.id;

  (async () => {
    try {
      // 0. Resolve true totalPages if missing or 0
      let resolvedTotalPages = totalPages && totalPages > 0 ? totalPages : 0;
      if (resolvedTotalPages <= 0) {
        try {
          const pagesRes = await fetch(apiUrl(`/api/comics/${comicId}/pages`));
          if (pagesRes.ok) {
            const pagesData = await pagesRes.json();
            if (pagesData && pagesData.totalPages > 0) {
              resolvedTotalPages = pagesData.totalPages;
            }
          }
        } catch {}
      }
      if (resolvedTotalPages <= 0) {
        const existingRec = await getOfflineComic(comicId);
        if (existingRec && existingRec.totalPages > 0) {
          resolvedTotalPages = existingRec.totalPages;
        } else {
          resolvedTotalPages = 30; // fallback
        }
      }
      // 1. Load existing offline record or create initial
      let record = await getOfflineComic(comicId);
      if (!record) {
        record = {
          id: comicId,
          title: comic.title || `Comic #${comicId}`,
          totalPages: resolvedTotalPages,
          type: comic.type,
          series: comic.series,
          coverUrl: comic.coverImage || `/api/comics/${comicId}/cover`,
          savedAt: Date.now(),
          downloadedPages: 0,
          isComplete: false
        };
        await saveOfflineComicMetadata(record);
      } else if (record.totalPages !== resolvedTotalPages && resolvedTotalPages > 0) {
        record.totalPages = resolvedTotalPages;
        await saveOfflineComicMetadata(record);
      }

      // If already fully downloaded and complete, notify and exit
      if (record.isComplete && record.downloadedPages >= resolvedTotalPages) {
        if (onProgress) onProgress(resolvedTotalPages, resolvedTotalPages, true);
        return;
      }

      // 2. Cache companion cover image if not yet cached
      try {
        const coverRes = await fetch(apiUrl(`/api/comics/${comicId}/cover`));
        if (coverRes.ok) {
          const coverBlob = await coverRes.blob();
          if (coverBlob && coverBlob.size > 0) {
            record.coverBlob = coverBlob;
            await saveOfflineComicMetadata(record);
          }
        }
      } catch {}

      // 3. Scan which pages already exist in offline storage
      const missingPages: number[] = [];
      let downloadedCount = 0;

      for (let p = 1; p <= resolvedTotalPages; p++) {
        if (isAborted) return;
        const exists = await isPageCachedOffline(comicId, p);
        if (exists) {
          downloadedCount++;
        } else {
          missingPages.push(p);
        }
      }

      if (onProgress) onProgress(downloadedCount, resolvedTotalPages, missingPages.length === 0);

      if (missingPages.length === 0) {
        record.downloadedPages = resolvedTotalPages;
        record.isComplete = true;
        await saveOfflineComicMetadata(record);
        if (onProgress) onProgress(resolvedTotalPages, resolvedTotalPages, true);
        window.dispatchEvent(new CustomEvent('comix_offline_updated', { detail: { comicId, isComplete: true } }));
        return;
      }

      // 4. Sequentially fetch missing pages with 60ms micro-pause
      for (const pageNum of missingPages) {
        if (isAborted) return;

        try {
          const pageUrl = apiUrl(`/api/comics/${comicId}/page/${pageNum}`);
          const res = await fetch(pageUrl);
          if (res.ok) {
            const blob = await res.blob();
            if (blob && blob.size > 0) {
              await saveComicPageBlob(comicId, pageNum, blob, res.headers.get('content-type') || 'image/jpeg');
              downloadedCount++;
              record.downloadedPages = downloadedCount;
              record.isComplete = downloadedCount >= resolvedTotalPages;
              await saveOfflineComicMetadata(record);

              if (onProgress) {
                onProgress(downloadedCount, resolvedTotalPages, record.isComplete);
              }
            }
          }
        } catch (fetchErr) {
          console.warn(`[OfflineStorage] Page ${pageNum} download pause:`, fetchErr);
        }

        await new Promise((r) => setTimeout(r, 60));
      }

      if (!isAborted) {
        record.isComplete = downloadedCount >= resolvedTotalPages;
        record.downloadedPages = downloadedCount;
        await saveOfflineComicMetadata(record);
        if (onProgress) onProgress(downloadedCount, resolvedTotalPages, record.isComplete);
        window.dispatchEvent(new CustomEvent('comix_offline_updated', { detail: { comicId, isComplete: record.isComplete } }));
      }
    } catch (err) {
      console.warn('[OfflineStorage] Auto-download error:', err);
    }
  })();

  return () => {
    isAborted = true;
  };
}

/**
 * Remove an offline comic and all its cached pages
 */
export async function deleteOfflineComic(comicId: any, preserveKey?: string): Promise<void> {
  try {
    const db = await getOfflineDB();

    // Delete matching pages for comicId (testing both original type and string/number variant)
    const idVariants = [comicId];
    if (typeof comicId === 'string' && !isNaN(Number(comicId))) {
      idVariants.push(Number(comicId));
    } else if (typeof comicId === 'number') {
      idVariants.push(String(comicId));
    }

    for (const idVar of idVariants) {
      await new Promise<void>((resolve) => {
        try {
          const tx = db.transaction('pages', 'readwrite');
          const store = tx.objectStore('pages');
          const index = store.index('comicId');
          const req = index.openCursor(IDBKeyRange.only(idVar));

          req.onsuccess = (e) => {
            const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
            if (cursor) {
              cursor.delete();
              cursor.continue();
            } else {
              resolve();
            }
          };
          req.onerror = () => resolve();
        } catch {
          resolve();
        }
      });
    }

    // Revoke cached page blob object URLs (preserving active page if requested)
    const idPrefix = `${comicId}_`;
    for (const [key, url] of pageObjectUrls.entries()) {
      if (key.startsWith(idPrefix)) {
        if (!preserveKey || key !== preserveKey) {
          try { URL.revokeObjectURL(url); } catch {}
          pageObjectUrls.delete(key);
        }
      }
    }

    // Revoke cover object URL
    if (coverObjectUrls.has(comicId)) {
      try { URL.revokeObjectURL(coverObjectUrls.get(comicId)!); } catch {}
      coverObjectUrls.delete(comicId);
    }
    for (const idVar of idVariants) {
      if (coverObjectUrls.has(idVar)) {
        try { URL.revokeObjectURL(coverObjectUrls.get(idVar)!); } catch {}
        coverObjectUrls.delete(idVar);
      }
    }

    // Delete comic metadata record
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction('comics', 'readwrite');
        const store = tx.objectStore('comics');
        for (const idVar of idVariants) {
          try { store.delete(idVar); } catch {}
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });

    window.dispatchEvent(new CustomEvent('comix_offline_updated', { detail: { comicId, isDeleted: true } }));
  } catch (err) {
    console.error('Failed to delete offline comic:', err);
  }
}

