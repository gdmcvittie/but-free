const DB_NAME = 'Freeplay_OfflineGames_DB';
const STORE_NAME = 'roms';
const USER_KEY = 'freeplay.offline.user';
const GAMES_KEY = 'freeplay.offline.games';

const pendingDownloads = new Map();

function openOfflineDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open offline game storage'));
  });
}

function cacheKey(userId, gameId) {
  return `${userId || 'default'}:${gameId}`;
}

export function isAndroidOfflineMode() {
  return typeof window !== 'undefined' && window.FREEPLAY_ANDROID_OFFLINE === true;
}

export function saveOfflineLibrary(user, games) {
  try {
    if (user) window.localStorage.setItem(USER_KEY, JSON.stringify(user));
    if (Array.isArray(games)) window.localStorage.setItem(GAMES_KEY, JSON.stringify(games));
  } catch (err) {
    console.warn('[Offline] Could not save library metadata:', err.message);
  }
}

export function loadOfflineLibrary() {
  try {
    const user = JSON.parse(window.localStorage.getItem(USER_KEY) || 'null');
    const games = JSON.parse(window.localStorage.getItem(GAMES_KEY) || '[]');
    return { user, games: Array.isArray(games) ? games : [] };
  } catch {
    return { user: null, games: [] };
  }
}

export async function requestOfflineStorage() {
  try {
    if (navigator.storage?.persist) await navigator.storage.persist();
  } catch { /* persistence is best effort */ }
}

export async function getCachedRom(userId, gameId) {
  if (!gameId || typeof indexedDB === 'undefined') return null;
  try {
    const db = await openOfflineDB();
    return await new Promise((resolve) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(cacheKey(userId, gameId));
      request.onsuccess = () => resolve(request.result?.blob || null);
      request.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function storeCachedRom(userId, gameId, blob) {
  if (!gameId || !blob || blob.size === 0 || typeof indexedDB === 'undefined') return false;
  try {
    const db = await openOfflineDB();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put({ blob, savedAt: Date.now() }, cacheKey(userId, gameId));
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    });
  } catch (err) {
    console.warn('[Offline] Could not cache game ROM:', err.message);
    return false;
  }
}

export function cacheGameForOffline(game, userId) {
  if (!game?.id || !game?.driveId || game.console === 'pc' || game.isPcGame || game.console === 'web' || game.isWebGame) {
    return Promise.resolve(false);
  }

  const key = cacheKey(userId, game.id);
  if (pendingDownloads.has(key)) return pendingDownloads.get(key);

  const download = (async () => {
    const cachedRom = await getCachedRom(userId, game.id);
    if (cachedRom) return cachedRom;
    const query = `?filename=${encodeURIComponent(game.filename || 'rom.bin')}`;
    const response = await fetch(`/api/games/stream/${encodeURIComponent(game.driveId)}${query}`, {
      credentials: 'include'
    });
    if (!response.ok) throw new Error(`ROM download failed (HTTP ${response.status})`);
    const blob = await response.blob();
    await storeCachedRom(userId, game.id, blob);
    return blob;
  })().catch((err) => {
    console.warn(`[Offline] Could not cache ${game.title || 'game'}:`, err.message);
    return false;
  }).finally(() => pendingDownloads.delete(key));

  pendingDownloads.set(key, download);
  return download;
}
