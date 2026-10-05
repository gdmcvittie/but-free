import { api } from './api';

const DB_NAME = 'fraudio_client_offline';
const DB_VERSION = 1;

let dbPromise = null;
const audioUrlCache = new Map();
const coverUrlCache = new Map();

/**
 * Opens or creates the IndexedDB database for client-side offline audio.
 */
export function getDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !window.indexedDB) {
      return reject(new Error('IndexedDB is not supported in this browser environment.'));
    }

    const req = window.indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;

      // 1. Audio tracks & audiobooks (blobs, tags, duration)
      if (!db.objectStoreNames.contains('tracks')) {
        const trackStore = db.createObjectStore('tracks', { keyPath: 'id' });
        trackStore.createIndex('album', 'album', { unique: false });
        trackStore.createIndex('artist', 'artist', { unique: false });
        trackStore.createIndex('kind', 'kind', { unique: false });
        trackStore.createIndex('downloadedAt', 'downloadedAt', { unique: false });
      }

      // 2. Collections (albums, playlists, multi-part audiobooks)
      if (!db.objectStoreNames.contains('collections')) {
        const colStore = db.createObjectStore('collections', { keyPath: 'id' });
        colStore.createIndex('type', 'type', { unique: false });
        colStore.createIndex('downloadedAt', 'downloadedAt', { unique: false });
      }

      // 3. Sync queue for playback progress recorded while offline
      if (!db.objectStoreNames.contains('syncQueue')) {
        const syncStore = db.createObjectStore('syncQueue', { keyPath: 'id', autoIncrement: true });
        syncStore.createIndex('itemId', 'itemId', { unique: false });
      }

      // 4. Cached progress values so offline player resumes at the exact second
      if (!db.objectStoreNames.contains('progress')) {
        db.createObjectStore('progress', { keyPath: 'itemId' });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error || new Error('Failed to open offline database'));
    };
  });

  return dbPromise;
}

/**
 * Checks if a specific track or item ID is stored offline.
 */
export async function isItemOffline(itemId) {
  if (!itemId) return false;
  try {
    const db = await getDB();
    return new Promise((resolve) => {
      const tx = db.transaction('tracks', 'readonly');
      const req = tx.objectStore('tracks').get(itemId);
      req.onsuccess = () => resolve(Boolean(req.result && req.result.blob));
      req.onerror = () => resolve(false);
    });
  } catch {
    return false;
  }
}

/**
 * Returns a Set of all offline item IDs for fast UI lookup.
 */
export async function getOfflineIds() {
  try {
    const db = await getDB();
    return new Promise((resolve) => {
      const tx = db.transaction(['tracks', 'collections'], 'readonly');
      const trackStore = tx.objectStore('tracks');
      const colStore = tx.objectStore('collections');
      const ids = new Set();

      const reqTracks = trackStore.getAllKeys();
      reqTracks.onsuccess = () => {
        for (const k of reqTracks.result || []) ids.add(k);
        const reqCols = colStore.getAllKeys();
        reqCols.onsuccess = () => {
          for (const k of reqCols.result || []) ids.add(k);
          resolve(ids);
        };
        reqCols.onerror = () => resolve(ids);
      };
      reqTracks.onerror = () => resolve(ids);
    });
  } catch {
    return new Set();
  }
}

/**
 * Retrieves an audio object URL for an offline track blob, or null if not offline.
 */
export async function getOfflineAudioUrl(itemId) {
  if (!itemId) return null;
  if (audioUrlCache.has(itemId)) {
    return audioUrlCache.get(itemId);
  }

  try {
    const db = await getDB();
    const track = await new Promise((resolve) => {
      const tx = db.transaction('tracks', 'readonly');
      const req = tx.objectStore('tracks').get(itemId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });

    if (track && track.blob) {
      const url = URL.createObjectURL(track.blob);
      audioUrlCache.set(itemId, url);
      return url;
    }
  } catch {
    /* fallback to null */
  }
  return null;
}

/**
 * Retrieves a cover image object URL for an offline track, or null.
 */
export async function getOfflineCoverUrl(itemId) {
  if (!itemId) return null;
  if (coverUrlCache.has(itemId)) {
    return coverUrlCache.get(itemId);
  }

  try {
    const db = await getDB();
    const track = await new Promise((resolve) => {
      const tx = db.transaction('tracks', 'readonly');
      const req = tx.objectStore('tracks').get(itemId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });

    if (track && track.coverBlob) {
      const url = URL.createObjectURL(track.coverBlob);
      coverUrlCache.set(itemId, url);
      return url;
    }
  } catch {
    /* fallback to null */
  }
  return null;
}

/**
 * Downloads a single track/audiobook to IndexedDB with chunked progress reporting.
 */
export async function downloadTrack(item, onProgress = () => {}) {
  if (!item?.id) throw new Error('Invalid item: missing ID');

  onProgress({ percent: 5, message: `Connecting: ${item.title}...` });

  const streamUrl = api.streamUrl(item.id);
  const res = await fetch(streamUrl, {
    credentials: 'same-origin',
    cache: 'no-store'
  });

  if (!res.ok) {
    throw new Error(`Failed to download audio for "${item.title}": HTTP ${res.status}`);
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
      onProgress({ percent: pct, receivedBytes, totalBytes: contentLength, message: `Downloading: ${pct}%` });
    }
  }

  const contentType = res.headers.get('content-type') || 'audio/mpeg';
  const audioBlob = new Blob(chunks, { type: contentType });

  // Optional: fetch and cache cover art
  let coverBlob = null;
  const coverUrl = item.coverUrl || api.coverUrl(item.id);
  if (coverUrl) {
    try {
      const cRes = await fetch(coverUrl);
      if (cRes.ok) coverBlob = await cRes.blob();
    } catch {
      /* cover is optional */
    }
  }

  onProgress({ percent: 98, message: 'Saving to device storage...' });

  const record = {
    id: item.id,
    title: item.title,
    artist: item.artist || item.author || 'Unknown Artist',
    album: item.album || 'Singles',
    albumArtist: item.albumArtist || item.artist || '',
    durationSec: item.durationSec || 0,
    trackNumber: item.trackNumber ?? null,
    format: item.format || 'MP3',
    kind: item.kind || 'track',
    blob: audioBlob,
    coverBlob,
    sizeBytes: audioBlob.size,
    downloadedAt: Date.now()
  };

  const db = await getDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('tracks', 'readwrite');
    const req = tx.objectStore('tracks').put(record);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });

  onProgress({ percent: 100, message: 'Download complete' });
  notifyOfflineChanged();
  return record;
}

/**
 * Downloads all tracks in an album sequentially and creates a collection entry.
 */
export async function downloadAlbum(albumName, artistName, tracks, onProgress = () => {}) {
  if (!tracks?.length) throw new Error('No tracks in album');
  const collectionId = `album:${artistName || 'Unknown'}:${albumName || 'Album'}`;

  for (let i = 0; i < tracks.length; i += 1) {
    const t = tracks[i];
    await downloadTrack(t, (p) => {
      onProgress({
        current: i + 1,
        total: tracks.length,
        trackTitle: t.title,
        trackPercent: p.percent,
        overallPercent: Math.round(((i + (p.percent / 100)) / tracks.length) * 100),
        message: `Track ${i + 1} of ${tracks.length}: ${t.title}`
      });
    });
  }

  const db = await getDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('collections', 'readwrite');
    tx.objectStore('collections').put({
      id: collectionId,
      type: 'album',
      title: albumName,
      artist: artistName,
      trackIds: tracks.map((t) => t.id),
      totalTracks: tracks.length,
      downloadedAt: Date.now()
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  notifyOfflineChanged();
}

/**
 * Downloads all tracks in a playlist sequentially.
 */
export async function downloadPlaylist(playlist, tracks, onProgress = () => {}) {
  if (!tracks?.length) throw new Error('No tracks in playlist');
  const collectionId = `playlist:${playlist.id}`;

  for (let i = 0; i < tracks.length; i += 1) {
    const t = tracks[i];
    await downloadTrack(t, (p) => {
      onProgress({
        current: i + 1,
        total: tracks.length,
        trackTitle: t.title,
        trackPercent: p.percent,
        overallPercent: Math.round(((i + (p.percent / 100)) / tracks.length) * 100),
        message: `Track ${i + 1} of ${tracks.length}: ${t.title}`
      });
    });
  }

  const db = await getDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('collections', 'readwrite');
    tx.objectStore('collections').put({
      id: collectionId,
      type: 'playlist',
      title: playlist.name,
      playlistId: playlist.id,
      trackIds: tracks.map((t) => t.id),
      totalTracks: tracks.length,
      downloadedAt: Date.now()
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  notifyOfflineChanged();
}

/**
 * Downloads a book (single file or all chapters/parts).
 */
export async function downloadBook(book, parts, onProgress = () => {}) {
  const targets = Array.isArray(parts) && parts.length ? parts : [book];
  const collectionId = `book:${book.id}`;

  for (let i = 0; i < targets.length; i += 1) {
    const t = targets[i];
    await downloadTrack(t, (p) => {
      onProgress({
        current: i + 1,
        total: targets.length,
        trackTitle: t.title,
        trackPercent: p.percent,
        overallPercent: Math.round(((i + (p.percent / 100)) / targets.length) * 100),
        message: targets.length > 1
          ? `Chapter ${i + 1} of ${targets.length}: ${t.title}`
          : `Downloading book: ${p.percent}%`
      });
    });
  }

  if (targets.length > 1) {
    const db = await getDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('collections', 'readwrite');
      tx.objectStore('collections').put({
        id: collectionId,
        type: 'book',
        title: book.title,
        author: book.author || book.narrator,
        trackIds: targets.map((t) => t.id),
        totalTracks: targets.length,
        downloadedAt: Date.now()
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  notifyOfflineChanged();
}

/**
 * Removes a single track from IndexedDB and revokes object URLs.
 */
export async function removeOfflineTrack(itemId) {
  if (audioUrlCache.has(itemId)) {
    try { URL.revokeObjectURL(audioUrlCache.get(itemId)); } catch {}
    audioUrlCache.delete(itemId);
  }
  if (coverUrlCache.has(itemId)) {
    try { URL.revokeObjectURL(coverUrlCache.get(itemId)); } catch {}
    coverUrlCache.delete(itemId);
  }

  try {
    const db = await getDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('tracks', 'readwrite');
      tx.objectStore('tracks').delete(itemId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    notifyOfflineChanged();
  } catch {
    /* ignore */
  }
}

/**
 * Removes an entire album from offline storage.
 */
export async function removeOfflineAlbum(albumName, artistName) {
  const collectionId = `album:${artistName || 'Unknown'}:${albumName || 'Album'}`;
  try {
    const db = await getDB();
    const col = await new Promise((resolve) => {
      const tx = db.transaction('collections', 'readonly');
      const req = tx.objectStore('collections').get(collectionId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });

    const trackIds = col?.trackIds || [];
    for (const id of trackIds) {
      await removeOfflineTrack(id);
    }

    await new Promise((resolve) => {
      const tx = db.transaction('collections', 'readwrite');
      tx.objectStore('collections').delete(collectionId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    notifyOfflineChanged();
  } catch {
    /* ignore */
  }
}

/**
 * Removes any collection and its tracks by collectionId.
 */
export async function removeOfflineCollection(collectionId) {
  try {
    const db = await getDB();
    const col = await new Promise((resolve) => {
      const tx = db.transaction('collections', 'readonly');
      const req = tx.objectStore('collections').get(collectionId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });

    const trackIds = col?.trackIds || [];
    for (const id of trackIds) {
      await removeOfflineTrack(id);
    }

    await new Promise((resolve) => {
      const tx = db.transaction('collections', 'readwrite');
      tx.objectStore('collections').delete(collectionId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    notifyOfflineChanged();
  } catch {
    /* ignore */
  }
}

/**
 * Removes an offline playlist.
 */
export async function removeOfflinePlaylist(playlistId) {
  const collectionId = String(playlistId).startsWith('playlist:') ? playlistId : `playlist:${playlistId}`;
  return removeOfflineCollection(collectionId);
}

/**
 * Removes a multi-part or single-file book from offline storage.
 */
export async function removeOfflineBook(book) {
  const collectionId = `book:${book.id}`;
  const targets = Array.isArray(book.parts) && book.parts.length ? book.parts : [book];
  for (const t of targets) {
    await removeOfflineTrack(t.id);
  }
  try {
    const db = await getDB();
    await new Promise((resolve) => {
      const tx = db.transaction('collections', 'readwrite');
      tx.objectStore('collections').delete(collectionId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {}
  notifyOfflineChanged();
}

/**
 * Clears all locally downloaded audio files and releases all object URLs.
 */
export async function clearAllOffline() {
  for (const url of audioUrlCache.values()) {
    try { URL.revokeObjectURL(url); } catch {}
  }
  for (const url of coverUrlCache.values()) {
    try { URL.revokeObjectURL(url); } catch {}
  }
  audioUrlCache.clear();
  coverUrlCache.clear();

  try {
    const db = await getDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['tracks', 'collections', 'progress'], 'readwrite');
      tx.objectStore('tracks').clear();
      tx.objectStore('collections').clear();
      tx.objectStore('progress').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    notifyOfflineChanged();
  } catch {
    /* ignore */
  }
}

/**
 * Calculates current offline storage statistics.
 */
export async function getOfflineStats() {
  try {
    const db = await getDB();
    return new Promise((resolve) => {
      const tx = db.transaction(['tracks', 'collections'], 'readonly');
      const trackStore = tx.objectStore('tracks');
      const colStore = tx.objectStore('collections');

      const reqTracks = trackStore.getAll();
      const reqCols = colStore.getAll();

      let tracks = [];
      let collections = [];

      reqTracks.onsuccess = () => {
        tracks = reqTracks.result || [];
        if (reqCols.readyState === 'done') finish();
      };
      reqCols.onsuccess = () => {
        collections = reqCols.result || [];
        if (reqTracks.readyState === 'done') finish();
      };

      function finish() {
        let totalBytes = 0;
        for (const t of tracks) {
          totalBytes += t.sizeBytes || (t.blob?.size || 0);
        }

        const albums = collections.filter((c) => c.type === 'album');
        const playlists = collections.filter((c) => c.type === 'playlist');
        const books = collections.filter((c) => c.type === 'book');

        resolve({
          totalBytes,
          trackCount: tracks.length,
          albumCount: albums.length,
          playlistCount: playlists.length,
          bookCount: books.length,
          tracks,
          albums,
          playlists,
          books
        });
      }

      tx.onerror = () => resolve({ totalBytes: 0, trackCount: 0, albumCount: 0, playlistCount: 0, bookCount: 0, tracks: [], albums: [], playlists: [], books: [] });
    });
  } catch {
    return { totalBytes: 0, trackCount: 0, albumCount: 0, playlistCount: 0, bookCount: 0, tracks: [], albums: [], playlists: [], books: [] };
  }
}

// ---------------------------------------------------------------------------
// Offline Progress & Sync
// ---------------------------------------------------------------------------

/**
 * Saves a playback position checkpoint to IndexedDB and adds it to the sync queue.
 */
export async function saveOfflineProgress(itemId, positionSec, durationSec) {
  if (!itemId) return;
  try {
    const db = await getDB();
    await new Promise((resolve) => {
      const tx = db.transaction(['progress', 'syncQueue'], 'readwrite');
      tx.objectStore('progress').put({ itemId, positionSec, durationSec, updatedAt: Date.now() });
      tx.objectStore('syncQueue').add({ itemId, positionSec, durationSec, timestamp: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    /* best effort */
  }
}

/**
 * Gets offline playback progress for an item.
 */
export async function getOfflineProgress(itemId) {
  if (!itemId) return null;
  try {
    const db = await getDB();
    return new Promise((resolve) => {
      const tx = db.transaction('progress', 'readonly');
      const req = tx.objectStore('progress').get(itemId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

/**
 * Flushes the offline progress sync queue back to the cloud server once online.
 */
export async function syncOfflineProgressToServer() {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;

  try {
    const db = await getDB();
    const items = await new Promise((resolve) => {
      const tx = db.transaction('syncQueue', 'readonly');
      const req = tx.objectStore('syncQueue').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });

    if (!items.length) return;

    // Deduplicate by itemId: keep the newest position per item
    const latest = new Map();
    for (const item of items) {
      latest.set(item.itemId, item);
    }

    for (const record of latest.values()) {
      try {
        await api.saveProgress(record.itemId, record.positionSec, record.durationSec);
      } catch {
        // If server call fails, keep in queue
        return;
      }
    }

    // Successfully sent all latest progress: clear the sync queue
    await new Promise((resolve) => {
      const tx = db.transaction('syncQueue', 'readwrite');
      tx.objectStore('syncQueue').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });

    console.log(`[OfflineStorage] Synced ${latest.size} offline progress checkpoints to server`);
  } catch (err) {
    console.warn('[OfflineStorage] Progress sync error:', err.message);
  }
}

function notifyOfflineChanged() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('fraudio:offline-changed'));
  }
}

// Auto-sync whenever the network connection is restored
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    console.log('[OfflineStorage] Network online: syncing offline progress to server...');
    syncOfflineProgressToServer();
  });
}
