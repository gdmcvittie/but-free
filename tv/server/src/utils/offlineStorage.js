/**
 * FREEVEE Offline Video Storage
 * Manages client-side IndexedDB caching for downloaded movies and TV show episodes.
 */

const DB_NAME = 'freevee_offline';
const DB_VERSION = 1;

let dbPromise = null;
const objectUrlMap = new Map();

/**
 * Open or initialize the IndexedDB storage
 */
export function getOfflineDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !window.indexedDB) {
      return reject(new Error('IndexedDB is not supported in this browser.'));
    }

    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (e) => {
      const db = e.target.result;

      // 1. Store for downloaded video items (blobs and metadata)
      if (!db.objectStoreNames.contains('videos')) {
        const videoStore = db.createObjectStore('videos', { keyPath: 'id' });
        videoStore.createIndex('type', 'type', { unique: false });
        videoStore.createIndex('showName', 'showName', { unique: false });
        videoStore.createIndex('savedAt', 'savedAt', { unique: false });
      }

      // 2. Store for app metadata, library snapshots, playback checkpoints
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error || new Error('Failed to open offline database'));
    };
  });

  return dbPromise;
}

/**
 * Retrieve all offline videos saved on device
 */
export async function getAllOfflineVideos() {
  try {
    const db = await getOfflineDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('videos', 'readonly');
      const store = tx.objectStore('videos');
      const req = store.getAll();
      req.onsuccess = () => {
        const results = req.result || [];
        // Map results without attaching raw blob to keep UI lightweight
        const summaries = results.map(item => ({
          id: item.id,
          title: item.title,
          type: item.type || 'movie',
          showName: item.showName || null,
          season: item.season || null,
          episode: item.episode || null,
          duration: item.duration || 0,
          posterUrl: item.posterUrl || null,
          filename: item.filename || `${item.title}.mp4`,
          sizeBytes: item.sizeBytes || (item.blob ? item.blob.size : 0),
          savedAt: item.savedAt || Date.now(),
          mimeType: item.mimeType || 'video/mp4',
          lastPosition: item.lastPosition || 0
        }));
        // Sort newest first
        summaries.sort((a, b) => b.savedAt - a.savedAt);
        resolve(summaries);
      };
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('[OfflineStorage] Error loading offline videos:', err);
    return [];
  }
}

/**
 * Checks if a video ID is stored offline
 */
export async function isStoredOffline(videoId) {
  if (!videoId) return false;
  try {
    const db = await getOfflineDB();
    return new Promise((resolve) => {
      const tx = db.transaction('videos', 'readonly');
      const store = tx.objectStore('videos');
      const req = store.count(IDBKeyRange.only(videoId));
      req.onsuccess = () => resolve(req.result > 0);
      req.onerror = () => resolve(false);
    });
  } catch {
    return false;
  }
}

/**
 * Retrieve a specific offline video record with its blob
 */
export async function getOfflineVideo(videoId) {
  if (!videoId) return null;
  try {
    const db = await getOfflineDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('videos', 'readonly');
      const store = tx.objectStore('videos');
      const req = store.get(videoId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

/**
 * Get or create an object URL for offline playback
 */
export async function getOfflineVideoUrl(videoId) {
  if (objectUrlMap.has(videoId)) {
    return objectUrlMap.get(videoId);
  }
  const record = await getOfflineVideo(videoId);
  if (record && record.blob) {
    const url = URL.createObjectURL(record.blob);
    objectUrlMap.set(videoId, url);
    return url;
  }
  return null;
}

/**
 * Revoke object URL
 */
export function revokeOfflineVideoUrl(videoId) {
  if (objectUrlMap.has(videoId)) {
    URL.revokeObjectURL(objectUrlMap.get(videoId));
    objectUrlMap.delete(videoId);
  }
}

/**
 * Save a video blob directly into IndexedDB
 */
export async function saveVideoBlob(item, blob, mimeType = 'video/mp4') {
  const db = await getOfflineDB();
  const id = item.driveId || item.id;
  const record = {
    id,
    title: item.title || item.filename || 'Untitled Video',
    type: item.type || (item.showName || item.season ? 'episode' : 'movie'),
    showName: item.showName || null,
    season: item.season || null,
    episode: item.episode || null,
    duration: item.duration || 0,
    posterUrl: item.posterUrl || null,
    filename: item.filename || `${item.title || 'video'}.mp4`,
    sizeBytes: blob.size,
    savedAt: Date.now(),
    mimeType: mimeType || blob.type || 'video/mp4',
    blob,
    lastPosition: 0
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction('videos', 'readwrite');
    const store = tx.objectStore('videos');
    const req = store.put(record);
    req.onsuccess = () => {
      window.dispatchEvent(new CustomEvent('freevee_offline_updated', { detail: { id, action: 'save' } }));
      resolve(record);
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Downloads a video from the stream endpoint and saves to IndexedDB
 */
export async function downloadVideoForOffline(item, onProgress = () => {}) {
  const fileId = item.driveId || item.id;
  if (!fileId) throw new Error('Missing video ID');

  onProgress({ percent: 5, message: `Connecting to "${item.title || 'video'}"...` });

  const streamUrl = `/api/stream/drive/${encodeURIComponent(fileId)}?download=1`;
  const res = await fetch(streamUrl, {
    credentials: 'include',
    cache: 'no-store'
  });

  if (!res.ok) {
    throw new Error(`Failed to download video: HTTP ${res.status}`);
  }

  const contentLength = Number(res.headers.get('content-length') || 0);
  let receivedBytes = 0;
  const chunks = [];

  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    receivedBytes += value.length;

    if (contentLength > 0) {
      const pct = Math.min(95, Math.round((receivedBytes / contentLength) * 90) + 5);
      onProgress({
        percent: pct,
        receivedBytes,
        totalBytes: contentLength,
        message: `Downloading: ${pct}% (${(receivedBytes / 1024 / 1024).toFixed(1)} MB)`
      });
    } else {
      onProgress({
        percent: 50,
        receivedBytes,
        totalBytes: 0,
        message: `Downloading: ${(receivedBytes / 1024 / 1024).toFixed(1)} MB`
      });
    }
  }

  const mimeType = res.headers.get('content-type') || 'video/mp4';
  const videoBlob = new Blob(chunks, { type: mimeType });

  onProgress({ percent: 98, message: 'Saving to device offline storage...' });

  const record = await saveVideoBlob(item, videoBlob, mimeType);

  onProgress({ percent: 100, message: 'Saved offline!' });
  return record;
}

/**
 * Delete a video from offline storage
 */
export async function deleteOfflineVideo(videoId) {
  revokeOfflineVideoUrl(videoId);
  const db = await getOfflineDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('videos', 'readwrite');
    const store = tx.objectStore('videos');
    const req = store.delete(videoId);
    req.onsuccess = () => {
      window.dispatchEvent(new CustomEvent('freevee_offline_updated', { detail: { id: videoId, action: 'delete' } }));
      resolve(true);
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Save playback position checkpoint
 */
export async function savePlaybackPosition(videoId, positionSeconds) {
  try {
    const db = await getOfflineDB();
    const tx = db.transaction('videos', 'readwrite');
    const store = tx.objectStore('videos');
    const req = store.get(videoId);
    req.onsuccess = () => {
      const record = req.result;
      if (record) {
        record.lastPosition = positionSeconds;
        store.put(record);
      }
    };
  } catch (err) {
    console.warn('[OfflineStorage] Error saving position:', err);
  }
}

/**
 * Get playback position checkpoint
 */
export async function getPlaybackPosition(videoId) {
  try {
    const record = await getOfflineVideo(videoId);
    return record?.lastPosition || 0;
  } catch {
    return 0;
  }
}

/**
 * Cache library metadata for offline browsing
 */
export async function saveLibraryOffline(library) {
  try {
    const db = await getOfflineDB();
    const tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put({ key: 'library_snapshot', data: library, savedAt: Date.now() });
  } catch (err) {
    console.warn('[OfflineStorage] Failed to save library snapshot:', err);
  }
}

/**
 * Load cached library snapshot
 */
export async function getLibraryOffline() {
  try {
    const db = await getOfflineDB();
    return new Promise((resolve) => {
      const tx = db.transaction('meta', 'readonly');
      const req = tx.objectStore('meta').get('library_snapshot');
      req.onsuccess = () => resolve(req.result?.data || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}
