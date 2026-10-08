import db from './db.js';
import googleDrive from './googleDrive.js';

/**
 * Drive-backed metadata mirror.
 *
 * Playback progress, favourites (including music favourites), author/artist
 * favourites and playlists are stored as a *visible* JSON document sitting at the
 * root of the Drive folder the user picked for that library - `fraudio-audiobooks.json`
 * in the audiobooks folder, `fraudio-music.json` in the music folder. No hidden
 * subfolder, so the files are visible, editable and backup-able in Drive itself.
 *
 * Two design points worth calling out:
 *
 * 1. The document keys items by `googleFileId`, never by the local `abk_`/`trk_` id.
 *    Local ids are regenerated per install, so a document keyed by them would be
 *    meaningless on another machine; Drive file ids are stable.
 *
 * 2. `db` stays synchronous and local-first. Nothing here is awaited by a request
 *    handler - mutations call `schedulePersist`, which debounces and then writes in
 *    the background. A Drive outage degrades to local-only rather than failing the API.
 *
 * Offline-cache records are deliberately *not* mirrored: they describe files on one
 * specific machine, so they have no meaning anywhere else.
 */

export const SCHEMA_VERSION = 1;

/** Settings that are per-machine by design and therefore never synced. */
const LOCAL_ONLY_SETTINGS = new Set(['youtubeCookiesFile', 'youtubeCookiesBrowser']);

export function getUserPrefix(user) {
  const email = (user?.email || '').trim();
  let prefix = '';
  if (email && email.includes('@')) {
    prefix = email.split('@')[0].trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
  }
  if (!prefix && user?.id) {
    prefix = String(user.id).trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
  }
  return prefix || 'user';
}

export function getUserMetaFilename(user, kind) {
  const prefix = getUserPrefix(user);
  return `${prefix}-${META_FILENAMES[kind]}`;
}

const META_FILENAMES = {
  audiobooks: 'fraudio-audiobooks.json',
  music: 'fraudio-music.json'
};

/** Library kind -> item.kind */
const ITEM_KIND = { audiobooks: 'audiobook', music: 'track' };

/** Debounce window for mirroring, in ms. Progress writes are frequent. */
const PERSIST_DEBOUNCE_MS = 4000;

const fileIdCache = new Map();   // `${userId}:${kind}` -> Drive file id
const persistTimers = new Map(); // `${userId}:${kind}` -> timeout
const inFlight = new Map();      // `${userId}:${kind}` -> Promise

const warnedNoFolder = new Set();

/**
 * Items from a legacy mixed playlist that this document could not resolve. The
 * sibling library's document is processed next, so the leftovers are stashed here
 * and folded into a playlist belonging to that library instead of being dropped.
 */
const deferredPlaylistItems = new Map(); // userId -> [{ name, createdAt, keys }]

function stashDeferredPlaylist(userId, playlist, keys) {
  const list = deferredPlaylistItems.get(userId) || [];
  const sameName = list.find((p) => p.name === playlist.name);
  if (sameName) {
    sameName.keys = Array.from(new Set([...sameName.keys, ...keys]));
  } else {
    list.push({ name: playlist.name, createdAt: playlist.createdAt || null, keys: [...keys] });
  }
  deferredPlaylistItems.set(userId, list);
}

function takeDeferredPlaylists(userId) {
  const list = deferredPlaylistItems.get(userId) || [];
  deferredPlaylistItems.delete(userId);
  return list;
}

function folderFor(user, kind) {
  if (!user) return null;
  return kind === 'music' ? user.musicFolderId : user.audiobooksFolderId;
}

function cacheKey(userId, kind) {
  return `${userId}:${kind}`;
}

/**
 * Builds the portable document for one library kind: items become Drive file ids
 * and only the state relevant to that kind is included.
 */
function dehydrate(userId, kind) {
  const wantedKind = ITEM_KIND[kind];
  const mine = db.getUserItems(userId).filter((i) => i.kind === wantedKind);
  const owned = new Set(mine.map((i) => i.id));
  const keyOf = (itemId) => {
    const item = mine.find((i) => i.id === itemId);
    return item?.googleFileId || itemId;
  };

  const progress = {};
  for (const entry of Object.values(db.getProgress(userId))) {
    if (!owned.has(entry.itemId)) continue;
    progress[keyOf(entry.itemId)] = {
      positionSec: entry.positionSec,
      durationSec: entry.durationSec ?? null,
      updatedAt: entry.updatedAt
    };
  }

  // Author/artist names are partitioned by the library they were favourited from.
  // `db.getAuthorFavorites(userId, kind)` owns that rule: names with a recorded kind
  // resolve exactly, and a name recorded by neither library (i.e. favourited before
  // the split) is inferred from the item pool and kept with the audiobooks.
  const authorFavorites = db.getAuthorFavorites(userId, kind);

  const playlists = {};
  // Playlists belong to exactly one library, so each one is written to a single
  // document. Legacy rows saved before the split default to audiobooks.
  for (const playlist of db.getPlaylists(userId, kind)) {
    const full = db.getPlaylist(userId, playlist.id);
    const itemIds = (full?.itemIds || []).filter((id) => owned.has(id));
    if (!itemIds.length) continue;
    playlists[playlist.id] = {
      id: playlist.id,
      name: playlist.name,
      items: itemIds.map(keyOf),
      createdAt: playlist.createdAt,
      updatedAt: playlist.updatedAt
    };
  }

  // App-level state travels with the audiobooks document; it is not media-scoped.
  const appState = kind === 'audiobooks'
    ? {
        // Local-only settings (machine-specific paths) must never ride along in the
        // Drive document or be overwritten by another machine's values.
        settings: Object.fromEntries(
          Object.entries(db.getSettings(userId))
            .filter(([key]) => !LOCAL_ONLY_SETTINGS.has(key))
        ),
        abbSeen: db.getAbbSeen(userId),
        pullList: db.getPullList(userId)
      }
    : { settings: {}, abbSeen: [], pullList: null };

  return {
    schema: SCHEMA_VERSION,
    kind,
    updatedAt: new Date().toISOString(),
    progress,
    favorites: db.getFavorites(userId, kind).map(keyOf),
    authorFavorites,
    // Album favourites only exist for music; audiobooks have no albums.
    ...(kind === 'music' ? { albumFavorites: db.getAlbumFavorites(userId), smartPlaylists: db.getSmartPlaylists(userId) } : {}),
    playlists,
    ...appState
  };
}

/**
 * Merges a document from Drive into the local store. Entries are merged rather
 * than replacing wholesale: progress and playlists resolve by newest `updatedAt`,
 * while set-shaped data (favourites) unions so an offline toggle is never lost.
 */
function hydrate(userId, kind, doc) {
  const wantedKind = ITEM_KIND[kind];
  const items = db.getUserItems(userId);
  const localByDriveId = new Map(
    items.filter((i) => i.kind === wantedKind && i.googleFileId).map((i) => [i.googleFileId, i.id])
  );

  // Accept both Drive file ids and legacy local ids so a hand-edited file still works.
  const resolve = (key) => {
    if (!key) return null;
    if (localByDriveId.has(key)) return localByDriveId.get(key);
    return items.some((i) => i.id === key && i.kind === wantedKind) ? key : null;
  };

  // Everything in `items` that belongs to *another* library, so a legacy mixed
  // playlist can be split instead of silently losing half its entries.
  const foreignItems = items.filter((i) => i.kind !== wantedKind);
  const foreignByDriveId = new Map(
    foreignItems.filter((i) => i.googleFileId).map((i) => [i.googleFileId, i.id])
  );
  const resolveForeign = (key) => {
    if (!key) return null;
    if (foreignByDriveId.has(key)) return foreignByDriveId.get(key);
    return foreignItems.some((i) => i.id === key) ? key : null;
  };

  const favoriteIds = new Set(db.getFavorites(userId));
  const names = new Set(db.getAuthorFavorites(userId));

  let restored = { progress: 0, favorites: 0, authors: 0, playlists: 0 };

  for (const [key, entry] of Object.entries(doc.progress || {})) {
    const itemId = resolve(key);
    if (!itemId) continue;
    const existing = db.getProgress(userId, itemId);
    const incomingAt = entry.updatedAt ? Date.parse(entry.updatedAt) : 0;
    const existingAt = existing?.updatedAt ? Date.parse(existing.updatedAt) : 0;
    if (existing && existingAt > incomingAt) continue;
    db.saveProgress(userId, itemId, entry.positionSec || 0, entry.durationSec);
    restored.progress += 1;
  }

  for (const key of doc.favorites || []) {
    const itemId = resolve(key);
    if (itemId && !favoriteIds.has(itemId)) {
      db.toggleFavorite(userId, itemId, true);
      restored.favorites += 1;
    }
  }

  // Author/artist favourites share one flat list locally, so merge as a union. The
  // document's kind is recorded, which is what keeps the two libraries apart.
  for (const name of doc.authorFavorites || []) {
    if (name && !names.has(name)) {
      db.toggleAuthorFavorite(userId, name, true, kind);
      restored.authors += 1;
    }
  }

  // Album favourites are a music-only concept (`Artist::Album` keys).
  if (kind === 'music' && Array.isArray(doc.albumFavorites) && doc.albumFavorites.length) {
    restored.albums = db.mergeAlbumFavoriteKeys(userId, doc.albumFavorites);
  }

  // Smart-playlist rules travel with the music document; creating is
  // name-merge, so a re-hydrate never duplicates a rule.
  if (kind === 'music' && Array.isArray(doc.smartPlaylists)) {
    for (const rule of doc.smartPlaylists) {
      if (!rule?.name || !Array.isArray(rule.keywords) || !rule.keywords.length) continue;
      try {
        db.createSmartPlaylist(userId, rule.name, rule.keywords);
        restored.smart = (restored.smart || 0) + 1;
      } catch { /* malformed rule from a hand-edited file - skip */ }
    }
  }

  for (const playlist of Object.values(doc.playlists || {})) {
    // Only this library's items are accepted, so a document can never pull a
    // playlist across the audiobook/music boundary.
    const itemIds = (playlist.items || []).map(resolve).filter(Boolean);
    const existing = db.getPlaylist(userId, playlist.id);

    if (existing) {
      const existingKind = existing.kind || 'audiobooks';
      if (existingKind !== kind) continue; // this playlist lives in the other library

      const incomingAt = playlist.updatedAt ? Date.parse(playlist.updatedAt) : 0;
      const existingAt = existing.updatedAt ? Date.parse(existing.updatedAt) : 0;
      const merged = Array.from(new Set([...itemIds, ...existing.itemIds]));
      if (merged.length !== existing.itemIds.length) {
        db.setPlaylistItems(userId, playlist.id, merged);
        restored.playlists += 1;
      }
      if (existingAt <= incomingAt && playlist.name) {
        db.renamePlaylist(userId, playlist.id, playlist.name);
      }
      continue;
    }

    // Legacy documents predate the split, so a playlist may still hold items from
    // both libraries. Split it: this document keeps its own items, and the
    // remaining ones are recovered when the other library's document loads.
    if (!itemIds.length) continue;

    const ownedIds = new Set(items.map((i) => i.id));
    const foreignIds = (playlist.items || [])
      .filter((key) => !ownedIds.has(key) && !resolve(key))
      .map(resolveForeign)
      .filter(Boolean);

    db.createPlaylist(userId, playlist.name, {
      id: playlist.id,
      kind,
      createdAt: playlist.createdAt
    });
    db.setPlaylistItems(userId, playlist.id, itemIds);
    restored.playlists += 1;

    if (foreignIds.length) {
      stashDeferredPlaylist(userId, playlist, foreignIds);
    }
  }

  // A playlist split above leaves its other half here; this library adopts it.
  for (const deferred of takeDeferredPlaylists(userId)) {
    const leftover = deferred.keys.map(resolve).filter(Boolean);
    if (!leftover.length) continue;
    if (db.getPlaylists(userId, kind).some((p) => p.name === deferred.name)) continue;
    const created = db.createPlaylist(userId, deferred.name, {
      kind,
      createdAt: deferred.createdAt || undefined
    });
    if (created?.id) {
      db.setPlaylistItems(userId, created.id, leftover);
      restored.playlists += 1;
    }
  }

  if (kind === 'audiobooks') {
    // Never let a synced document overwrite this machine's cookie config.
    const remote = doc.settings ? Object.fromEntries(Object.entries(doc.settings).filter(([key]) => !LOCAL_ONLY_SETTINGS.has(key))) : {};
    if (Object.keys(remote).length) db.saveSettings(userId, remote);
    if (Array.isArray(doc.abbSeen) && doc.abbSeen.length) db.markAllAbbSeen(userId, doc.abbSeen);
    if (doc.pullList) db.savePullList(userId, doc.pullList);
  }

  return restored;
}

/** Reads and applies the document for one kind. Safe to call repeatedly. */
async function loadKind(user, kind) {
  const folderId = folderFor(user, kind);
  if (!folderId) return null;

  const targetFilename = getUserMetaFilename(user, kind);
  const legacyFilename = META_FILENAMES[kind];

  try {
    let fileId = fileIdCache.get(cacheKey(user.id, kind));
    let loadedFilename = targetFilename;

    if (!fileId) {
      // 1. Try finding the user-prefixed metadata file first (e.g. gdmcvittie-fraudio-music.json)
      let found = await googleDrive.findFileByName(user, folderId, targetFilename);
      // 2. Fall back to legacy non-prefixed file if user-specific file doesn't exist yet
      if (!found && legacyFilename) {
        found = await googleDrive.findFileByName(user, folderId, legacyFilename);
        if (found) {
          console.log(`[META] ${kind}: found legacy ${legacyFilename}, will migrate to ${targetFilename} on save`);
          loadedFilename = legacyFilename;
        }
      }

      if (!found) {
        fileIdCache.set(cacheKey(user.id, kind), '');
        return null;
      }
      fileId = found.id;
      // Only cache fileId if it's the target user file so persistKind creates the new user file rather than overwriting legacy
      if (found.name === targetFilename) {
        fileIdCache.set(cacheKey(user.id, kind), fileId);
      }
    }

    const buffer = await googleDrive.getFileBuffer(user, fileId);
    const doc = JSON.parse(buffer.toString('utf8'));
    if (!doc || typeof doc !== 'object') throw new Error('not an object');

    const restored = hydrate(user.id, kind, doc);
    console.log(
      `[META] ${kind}: loaded ${loadedFilename} ` +
      `(${restored.progress} progress, ${restored.favorites} favourites, ` +
      `${restored.authors} authors, ${restored.playlists} playlists restored)`
    );
    return doc;
  } catch (err) {
    console.warn(`[META] Could not read ${targetFilename}: ${err.message}`);
    return null;
  }
}

/** Writes the document for one kind. Creates it on first save. */
async function persistKind(user, kind) {
  const folderId = folderFor(user, kind);
  const targetFilename = getUserMetaFilename(user, kind);
  if (!folderId) {
    if (!warnedNoFolder.has(cacheKey(user.id, kind))) {
      warnedNoFolder.add(cacheKey(user.id, kind));
      console.warn(
        `[META] No ${kind} Drive folder selected - ${targetFilename} not written. ` +
        'Pick a folder in Settings to enable Drive-backed sync.'
      );
    }
    return null;
  }

  const doc = dehydrate(user.id, kind);
  const key = cacheKey(user.id, kind);
  let fileId = fileIdCache.get(key) || '';

  if (!fileId) {
    const found = await googleDrive.findFileByName(user, folderId, targetFilename);
    fileId = found?.id || '';
    if (fileId) fileIdCache.set(key, fileId);
  }

  const result = await googleDrive.writeJsonFile(user, folderId, targetFilename, doc, {
    fileId: fileId || null
  });
  fileIdCache.set(key, result.id);
  console.log(`[META] ${kind}: wrote ${targetFilename} (${result.updated ? 'updated' : 'created'})`);
  return result;
}

const metaStore = {
  SCHEMA_VERSION,
  META_FILENAMES,
  getUserPrefix,
  getUserMetaFilename,
  dehydrate,
  hydrate,
  loadKind,
  persistKind,

  /**
   * Loads every configured document. Call after login / folder selection.
   *
   * Audiobooks is always loaded first so any legacy playlist that still spans both
   * libraries is split during that pass, leaving the music half for the music pass.
   */
  async loadAll(user) {
    if (!user) return;
    const kinds = ['audiobooks', 'music'].filter((k) => folderFor(user, k));
    for (const kind of kinds) {
      try {
        await this.loadKind(user, kind);
      } catch (err) {
        console.warn(`[META] loadAll(${kind}) failed: ${err.message}`);
      }
    }
  },

  /** Debounced, background write. This is what `db.setMetaHook` calls. */
  schedulePersist(userId, kind = null) {
    const kinds = kind ? [kind] : ['audiobooks', 'music'];
    for (const k of kinds) {
      const key = cacheKey(userId, k);
      if (persistTimers.has(key)) clearTimeout(persistTimers.get(key));
      persistTimers.set(
        key,
        setTimeout(() => {
          persistTimers.delete(key);
          const user = db.getUser(userId);
          if (!user) return;

          const run = (persistKind(user, k).catch((err) => {
            console.warn(`[META] persist(${k}) failed: ${err.message}`);
          })).finally(() => inFlight.delete(key));
          inFlight.set(key, run);
        }, PERSIST_DEBOUNCE_MS)
      );
      persistTimers.get(key)?.unref?.();
    }
  },

  /** Flushes any pending writes immediately (used on shutdown and after scans). */
  async flush(userId = null) {
    if (userId) {
      const user = db.getUser(userId);
      if (user) {
        for (const kind of ['audiobooks', 'music']) {
          if (!persistTimers.has(cacheKey(userId, kind))) continue;
          clearTimeout(persistTimers.get(cacheKey(userId, kind)));
          persistTimers.delete(cacheKey(userId, kind));
          await persistKind(user, kind).catch((err) => {
            console.warn(`[META] flush(${kind}) failed: ${err.message}`);
          });
        }
      }
    } else {
      for (const [key, timer] of persistTimers) {
        clearTimeout(timer);
        persistTimers.delete(key);
        const [userId2, kind] = key.split(':');
        const user = db.getUser(userId2);
        if (user) await persistKind(user, kind).catch(() => {});
      }
    }
    for (const [key, promise] of inFlight) {
      inFlight.delete(key);
      await promise.catch(() => {});
    }
  },

  /** Drops cached Drive file ids, e.g. after the user picks a different folder. */
  reset(userId) {
    if (!userId) {
      fileIdCache.clear();
      return;
    }
    for (const key of Array.from(fileIdCache.keys())) {
      if (key.startsWith(`${userId}:`)) fileIdCache.delete(key);
    }
    warnedNoFolder.clear();
  }
};

export default metaStore;