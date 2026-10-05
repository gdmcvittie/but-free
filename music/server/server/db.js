import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DB_FILE, DATA_DIR, USERS_DIR } from './config.js';
import { stripTrackNumberPrefix } from './libraryParser.js';

/**
 * FRAUDIO persistent store.
 *
 * Each user has their own directory under data/users/<userId>/ with three files:
 *   - audiobooks.json (audiobook items, progress, favorites, playlists, abbSeen, pullList)
 *   - music.json      (music tracks, progress, favorites, albumFavorites, playlists, smartPlaylists, musicQueue)
 *   - user.json       (user profile & tokens, settings, offline records, authorFavoriteKinds)
 *
 * Atomic, debounced writes via temp files protect against write corruption.
 */

const EMPTY_AUDIOBOOKS = () => ({
  items: {},          // itemId -> audiobook metadata
  progress: {},       // itemId -> { userId, itemId, positionSec, durationSec, updatedAt }
  favorites: [],      // [itemId]
  authorFavorites: [],// [author name]
  playlists: {},      // playlistId -> { id, name, kind: 'audiobooks', itemIds, createdAt, updatedAt }
  abbSeen: [],        // [abbPostId]
  pullList: { authors: [], series: [], enabled: true, lastCheck: null, lastResults: [] }
});

const EMPTY_MUSIC = () => ({
  items: {},          // itemId -> track metadata
  progress: {},       // itemId -> { userId, itemId, positionSec, durationSec, updatedAt }
  favorites: [],      // [itemId]
  authorFavorites: [],// [artist name]
  albumFavorites: [], // ['Artist::Album']
  playlists: {},      // playlistId -> { id, name, kind: 'music', itemIds, createdAt, updatedAt }
  smartPlaylists: {}, // ruleId -> { id, name, kind: 'music', keywords[], createdAt, updatedAt }
  musicQueue: {}      // jobId -> { id, kind, title, artist, args, queuedAt }
});

const EMPTY_USER = (userId = '') => ({
  user: null,         // { id, googleId, email, name, avatar, tokens, ... }
  settings: {},       // overrides for DEFAULT_SETTINGS
  offline: [],        // [ { itemId, fileName, bytes, addedAt } ]
  authorFavoriteKinds: {} // authorName -> 'audiobooks' | 'music'
});

export const DEFAULT_SETTINGS = {
  autoScanOnLaunch: true,
  keepLocalCopy: false,
  deleteAfterUpload: true,
  coverCacheDays: 30,
  musicAudioFormat: 'mp3',
  musicAudioQuality: 'v4',
  youtubeCookiesFile: '',
  youtubeCookiesBrowser: ''
};

// In-memory cache: userId -> { audiobooks, music, user, dirty: { audiobooks, music, user }, mtime: { audiobooks, music, user } }
const userStores = new Map();
let saveTimer = null;
let metaHook = null;

function ensureDirs() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(USERS_DIR, { recursive: true });
  } catch (err) {
    console.error('[DB] Directory initialization failed:', err.message);
  }
}

function userDir(userId) {
  return path.join(USERS_DIR, String(userId));
}

function audiobooksFile(userId) {
  return path.join(userDir(userId), 'audiobooks.json');
}

function musicFile(userId) {
  return path.join(userDir(userId), 'music.json');
}

function userFile(userId) {
  return path.join(userDir(userId), 'user.json');
}

function touchMeta(userId, kind = null) {
  if (!metaHook || !userId) return;
  try {
    metaHook(userId, kind);
  } catch (err) {
    console.error('[DB] Metadata mirror hook failed:', err.message);
  }
}

export function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

export function smartRegex(keyword) {
  const escaped = String(keyword || '')
    .toLowerCase()
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '[ /]+');
  if (!escaped) return null;
  try {
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
  } catch {
    return null;
  }
}

export function hash(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 16);
}

// ------------------------------------------------------------------
// Legacy Migration: split data/library.json into data/users/<userId>/
// ------------------------------------------------------------------
function migrateLegacyLibrary() {
  if (!fs.existsSync(DB_FILE)) return;

  console.log('[DB] Found legacy library.json - migrating into per-user split files...');
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const legacy = JSON.parse(raw);
    ensureDirs();

    // Identify all user IDs
    const userIds = new Set(Object.keys(legacy.users || {}));
    for (const item of Object.values(legacy.items || {})) {
      if (item.userId) userIds.add(item.userId);
    }
    for (const u of Object.keys(legacy.settings || {})) userIds.add(u);
    for (const u of Object.keys(legacy.playlists || {})) userIds.add(u);

    if (userIds.size === 0) {
      console.log('[DB] No users found in legacy library.json - leaving as is.');
      return;
    }

    for (const userId of userIds) {
      const uDir = userDir(userId);
      fs.mkdirSync(uDir, { recursive: true });

      const userRecord = legacy.users?.[userId] || { id: userId, googleId: userId };
      const userAuthorFavKinds = legacy.authorFavoriteKinds?.[userId] || {};

      // 1. Audiobooks partition
      const audiobooks = EMPTY_AUDIOBOOKS();
      for (const [id, item] of Object.entries(legacy.items || {})) {
        if (item.userId === userId && item.kind !== 'track') {
          audiobooks.items[id] = item;
        }
      }
      for (const [key, prog] of Object.entries(legacy.progress || {})) {
        if (prog && (prog.userId === userId || key.startsWith(`${userId}:`))) {
          const itemId = prog.itemId || key.slice(userId.length + 1);
          const item = legacy.items?.[itemId];
          const isTrack = item ? item.kind === 'track' : itemId.startsWith('trk_');
          if (!isTrack) {
            audiobooks.progress[itemId] = { ...prog, userId, itemId };
          }
        }
      }
      const allFavs = legacy.favorites?.[userId] || [];
      audiobooks.favorites = allFavs.filter((id) => {
        const item = legacy.items?.[id];
        return item ? item.kind !== 'track' : !id.startsWith('trk_');
      });

      const allAuthorFavs = legacy.authorFavorites?.[userId] || [];
      audiobooks.authorFavorites = allAuthorFavs.filter((name) => {
        if (userAuthorFavKinds[name]) return userAuthorFavKinds[name] === 'audiobooks';
        return true;
      });

      for (const [plId, pl] of Object.entries(legacy.playlists?.[userId] || {})) {
        if (pl.kind !== 'music') {
          audiobooks.playlists[plId] = { ...pl, kind: 'audiobooks' };
        }
      }
      audiobooks.abbSeen = Array.isArray(legacy.abbSeen?.[userId]) ? legacy.abbSeen[userId] : [];
      audiobooks.pullList = legacy.pullList?.[userId] || audiobooks.pullList;

      // 2. Music partition
      const music = EMPTY_MUSIC();
      for (const [id, item] of Object.entries(legacy.items || {})) {
        if (item.userId === userId && item.kind === 'track') {
          music.items[id] = { ...item, title: stripTrackNumberPrefix(item.title) };
        }
      }
      for (const [key, prog] of Object.entries(legacy.progress || {})) {
        if (prog && (prog.userId === userId || key.startsWith(`${userId}:`))) {
          const itemId = prog.itemId || key.slice(userId.length + 1);
          const item = legacy.items?.[itemId];
          const isTrack = item ? item.kind === 'track' : itemId.startsWith('trk_');
          if (isTrack) {
            music.progress[itemId] = { ...prog, userId, itemId };
          }
        }
      }
      music.favorites = allFavs.filter((id) => {
        const item = legacy.items?.[id];
        return item ? item.kind === 'track' : id.startsWith('trk_');
      });
      music.authorFavorites = allAuthorFavs.filter((name) => {
        if (userAuthorFavKinds[name]) return userAuthorFavKinds[name] === 'music';
        return Object.values(music.items).some((i) => i.artist === name || i.albumArtist === name);
      });
      music.albumFavorites = Array.isArray(legacy.albumFavorites?.[userId]) ? legacy.albumFavorites[userId] : [];
      for (const [plId, pl] of Object.entries(legacy.playlists?.[userId] || {})) {
        if (pl.kind === 'music') {
          music.playlists[plId] = { ...pl, kind: 'music' };
        }
      }
      music.smartPlaylists = legacy.smartPlaylists?.[userId] || {};
      music.musicQueue = legacy.musicQueue?.[userId] || {};

      // 3. User partition
      const userSection = {
        user: userRecord,
        settings: legacy.settings?.[userId] || {},
        offline: Array.isArray(legacy.offline?.[userId]) ? legacy.offline[userId] : [],
        authorFavoriteKinds: userAuthorFavKinds
      };

      // Write out the three files
      fs.writeFileSync(audiobooksFile(userId), JSON.stringify(audiobooks, null, 2), 'utf8');
      fs.writeFileSync(musicFile(userId), JSON.stringify(music, null, 2), 'utf8');
      fs.writeFileSync(userFile(userId), JSON.stringify(userSection, null, 2), 'utf8');

      const abMtime = fs.statSync(audiobooksFile(userId)).mtimeMs;
      const muMtime = fs.statSync(musicFile(userId)).mtimeMs;
      const usMtime = fs.statSync(userFile(userId)).mtimeMs;
      userStores.set(userId, {
        audiobooks,
        music,
        user: userSection,
        dirty: { audiobooks: false, music: false, user: false },
        mtime: { audiobooks: abMtime, music: muMtime, user: usMtime }
      });

      console.log(`[DB] Successfully migrated user ${userId} (${userRecord.name || userRecord.email || 'Listener'})`);
    }

    // Rename library.json to library.json.bak
    let backupPath = `${DB_FILE}.bak`;
    if (fs.existsSync(backupPath)) {
      backupPath = `${DB_FILE}.bak.${Date.now()}`;
    }
    fs.renameSync(DB_FILE, backupPath);
    console.log(`[DB] Migration finished. Archived legacy file to ${backupPath}`);
  } catch (err) {
    console.error('[DB] Migration failed:', err);
  }
}

// ------------------------------------------------------------------
// Store Loading, Reloading, and Persistence
// ------------------------------------------------------------------
function loadSection(filePath, fallbackFn) {
  try {
    if (!fs.existsSync(filePath)) return { data: fallbackFn(), mtime: 0 };
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(content);
    if (parsed && parsed.items && filePath.endsWith('music.json')) {
      for (const item of Object.values(parsed.items)) {
        if (item && item.kind === 'track' && item.title) {
          item.title = stripTrackNumberPrefix(item.title);
        }
      }
    }
    const mtime = fs.statSync(filePath).mtimeMs;
    return { data: { ...fallbackFn(), ...parsed }, mtime };
  } catch (err) {
    console.warn(`[DB] Could not read ${filePath}, using defaults:`, err.message);
    return { data: fallbackFn(), mtime: 0 };
  }
}

function getUserStore(userId) {
  if (!userId) {
    return {
      audiobooks: EMPTY_AUDIOBOOKS(),
      music: EMPTY_MUSIC(),
      user: EMPTY_USER(),
      dirty: { audiobooks: false, music: false, user: false },
      mtime: { audiobooks: 0, music: 0, user: 0 }
    };
  }

  const key = String(userId);
  let store = userStores.get(key);
  if (!store) {
    const ab = loadSection(audiobooksFile(key), EMPTY_AUDIOBOOKS);
    const mu = loadSection(musicFile(key), EMPTY_MUSIC);
    const us = loadSection(userFile(key), () => EMPTY_USER(key));

    store = {
      audiobooks: ab.data,
      music: mu.data,
      user: us.data,
      dirty: { audiobooks: false, music: false, user: false },
      mtime: { audiobooks: ab.mtime, music: mu.mtime, user: us.mtime }
    };
    userStores.set(key, store);
  }
  return store;
}

function checkUserReload(userId, section = null) {
  if (!userId) return;
  const store = getUserStore(userId);
  const sections = section ? [section] : ['audiobooks', 'music', 'user'];

  for (const sec of sections) {
    if (store.dirty[sec]) continue;
    const file = sec === 'audiobooks' ? audiobooksFile(userId) : sec === 'music' ? musicFile(userId) : userFile(userId);
    try {
      if (!fs.existsSync(file)) continue;
      const curMtime = fs.statSync(file).mtimeMs;
      if (curMtime !== store.mtime[sec]) {
        const fallbackFn = sec === 'audiobooks' ? EMPTY_AUDIOBOOKS : sec === 'music' ? EMPTY_MUSIC : () => EMPTY_USER(userId);
        const reloaded = loadSection(file, fallbackFn);
        store[sec] = reloaded.data;
        store.mtime[sec] = reloaded.mtime;
      }
    } catch {
      // Ignore file check errors
    }
  }
}

function writeSectionNow(userId, section) {
  const store = userStores.get(String(userId));
  if (!store || !store.dirty[section]) return;
  ensureDirs();
  const dir = userDir(userId);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = section === 'audiobooks' ? audiobooksFile(userId) : section === 'music' ? musicFile(userId) : userFile(userId);
    const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(store[section], null, 2), 'utf8');
    fs.renameSync(tmp, file);
    store.dirty[section] = false;
    try {
      store.mtime[section] = fs.statSync(file).mtimeMs;
    } catch {
      store.mtime[section] = Date.now();
    }
  } catch (err) {
    console.error(`[DB] Failed to write ${section}.json for user ${userId}:`, err.message);
  }
}

function writeNow(userId = null, section = null) {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (userId) {
    const sections = section ? [section] : ['audiobooks', 'music', 'user'];
    for (const sec of sections) writeSectionNow(userId, sec);
    return;
  }
  for (const [uId, s] of userStores.entries()) {
    if (s.dirty.audiobooks) writeSectionNow(uId, 'audiobooks');
    if (s.dirty.music) writeSectionNow(uId, 'music');
    if (s.dirty.user) writeSectionNow(uId, 'user');
  }
}

function save(userId = null, section = null) {
  if (userId && section) {
    const store = getUserStore(userId);
    store.dirty[section] = true;
  }
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => writeNow(), 300);
}

function listUserIds() {
  const ids = new Set(userStores.keys());
  try {
    if (fs.existsSync(USERS_DIR)) {
      const entries = fs.readdirSync(USERS_DIR, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.isDirectory()) ids.add(ent.name);
      }
    }
  } catch {
    // Ignore scan errors
  }
  return Array.from(ids);
}

// Run migration on module load
ensureDirs();
migrateLegacyLibrary();

// ------------------------------------------------------------------
// Legacy Compatibility Proxies for db.raw()
// ------------------------------------------------------------------
function makeUserFieldProxy(getFn, setFn) {
  const dummy = {};
  return new Proxy(dummy, {
    get(target, prop) {
      if (typeof prop === 'symbol') return Reflect.get(target, prop);
      return getFn(String(prop));
    },
    set(target, prop, value) {
      if (typeof prop === 'symbol') return Reflect.set(target, prop, value);
      if (setFn) setFn(String(prop), value);
      return true;
    },
    has(target, prop) {
      return listUserIds().includes(String(prop));
    },
    ownKeys() {
      return listUserIds();
    },
    getOwnPropertyDescriptor(target, prop) {
      const val = getFn(String(prop));
      if (val === undefined) return undefined;
      return {
        configurable: true,
        enumerable: true,
        value: val,
        writable: true
      };
    }
  });
}

function makeItemsProxy() {
  const dummy = {};
  return new Proxy(dummy, {
    get(target, prop) {
      if (typeof prop === 'symbol') return Reflect.get(target, prop);
      const itemId = String(prop);
      for (const userId of listUserIds()) {
        const s = getUserStore(userId);
        if (s.audiobooks.items[itemId]) return s.audiobooks.items[itemId];
        if (s.music.items[itemId]) return s.music.items[itemId];
      }
      return undefined;
    },
    set(target, prop, value) {
      if (typeof prop === 'symbol') return Reflect.set(target, prop, value);
      const item = value;
      if (item && item.userId) {
        db.upsertItem(item.userId, item);
      }
      return true;
    },
    ownKeys() {
      const keys = [];
      for (const userId of listUserIds()) {
        const s = getUserStore(userId);
        keys.push(...Object.keys(s.audiobooks.items), ...Object.keys(s.music.items));
      }
      return keys;
    },
    getOwnPropertyDescriptor(target, prop) {
      const itemId = String(prop);
      for (const userId of listUserIds()) {
        const s = getUserStore(userId);
        const it = s.audiobooks.items[itemId] || s.music.items[itemId];
        if (it) return { configurable: true, enumerable: true, value: it, writable: true };
      }
      return undefined;
    }
  });
}

function makeProgressProxy() {
  const dummy = {};
  return new Proxy(dummy, {
    get(target, prop) {
      if (typeof prop === 'symbol') return Reflect.get(target, prop);
      const key = String(prop);
      const idx = key.indexOf(':');
      if (idx < 0) return undefined;
      const userId = key.slice(0, idx);
      const itemId = key.slice(idx + 1);
      const s = getUserStore(userId);
      return s.audiobooks.progress[itemId] || s.music.progress[itemId] || undefined;
    },
    set(target, prop, value) {
      if (typeof prop === 'symbol') return Reflect.set(target, prop, value);
      const key = String(prop);
      const idx = key.indexOf(':');
      if (idx < 0) return true;
      const userId = key.slice(0, idx);
      const itemId = key.slice(idx + 1);
      if (value) {
        db.saveProgress(userId, itemId, value.positionSec, value.durationSec);
      } else {
        db.clearProgress(userId, itemId);
      }
      return true;
    },
    ownKeys() {
      const keys = [];
      for (const userId of listUserIds()) {
        const s = getUserStore(userId);
        for (const itemId of Object.keys(s.audiobooks.progress)) keys.push(`${userId}:${itemId}`);
        for (const itemId of Object.keys(s.music.progress)) keys.push(`${userId}:${itemId}`);
      }
      return keys;
    },
    getOwnPropertyDescriptor(target, prop) {
      const key = String(prop);
      const idx = key.indexOf(':');
      if (idx < 0) return undefined;
      const userId = key.slice(0, idx);
      const itemId = key.slice(idx + 1);
      const s = getUserStore(userId);
      const p = s.audiobooks.progress[itemId] || s.music.progress[itemId];
      if (p) return { configurable: true, enumerable: true, value: p, writable: true };
      return undefined;
    }
  });
}

const rawProxy = {
  users: makeUserFieldProxy(
    (u) => { checkUserReload(u, 'user'); return getUserStore(u).user.user || undefined; },
    (u, val) => { const s = getUserStore(u); s.user.user = val; save(u, 'user'); }
  ),
  items: makeItemsProxy(),
  progress: makeProgressProxy(),
  favorites: makeUserFieldProxy(
    (u) => db.getFavorites(u),
    (u, val) => { db.toggleFavoritesBulk(u, val, true); }
  ),
  authorFavorites: makeUserFieldProxy(
    (u) => db.getAuthorFavorites(u),
    (u, val) => {
      const s = getUserStore(u);
      s.music.authorFavorites = Array.isArray(val) ? val : [];
      save(u, 'music');
    }
  ),
  albumFavorites: makeUserFieldProxy(
    (u) => { checkUserReload(u, 'music'); return getUserStore(u).music.albumFavorites; },
    (u, val) => {
      const s = getUserStore(u);
      s.music.albumFavorites = Array.isArray(val) ? val : [];
      save(u, 'music');
    }
  ),
  authorFavoriteKinds: makeUserFieldProxy(
    (u) => { checkUserReload(u, 'user'); return getUserStore(u).user.authorFavoriteKinds; },
    (u, val) => { const s = getUserStore(u); s.user.authorFavoriteKinds = val || {}; save(u, 'user'); }
  ),
  playlists: makeUserFieldProxy(
    (u) => {
      checkUserReload(u, 'audiobooks');
      checkUserReload(u, 'music');
      const s = getUserStore(u);
      return { ...s.audiobooks.playlists, ...s.music.playlists };
    },
    null
  ),
  smartPlaylists: makeUserFieldProxy(
    (u) => { checkUserReload(u, 'music'); return getUserStore(u).music.smartPlaylists; },
    (u, val) => { const s = getUserStore(u); s.music.smartPlaylists = val || {}; save(u, 'music'); }
  ),
  musicQueue: makeUserFieldProxy(
    (u) => { checkUserReload(u, 'music'); return getUserStore(u).music.musicQueue; },
    (u, val) => { db.saveMusicQueue(u, val); }
  ),
  offline: makeUserFieldProxy(
    (u) => { checkUserReload(u, 'user'); return getUserStore(u).user.offline; },
    (u, val) => { const s = getUserStore(u); s.user.offline = Array.isArray(val) ? val : []; save(u, 'user'); }
  ),
  abbSeen: makeUserFieldProxy(
    (u) => { checkUserReload(u, 'audiobooks'); return getUserStore(u).audiobooks.abbSeen; },
    (u, val) => { const s = getUserStore(u); s.audiobooks.abbSeen = Array.isArray(val) ? val : []; save(u, 'audiobooks'); }
  ),
  pullList: makeUserFieldProxy(
    (u) => { checkUserReload(u, 'audiobooks'); return getUserStore(u).audiobooks.pullList; },
    (u, val) => { const s = getUserStore(u); s.audiobooks.pullList = val || {}; save(u, 'audiobooks'); }
  ),
  settings: makeUserFieldProxy(
    (u) => { checkUserReload(u, 'user'); return getUserStore(u).user.settings; },
    (u, val) => { const s = getUserStore(u); s.user.settings = val || {}; save(u, 'user'); }
  )
};

// ------------------------------------------------------------------
// DB Public Interface
// ------------------------------------------------------------------
const db = {
  save,
  flush: writeNow,
  raw: () => rawProxy,
  setMetaHook(fn) {
    metaHook = fn;
  },

  // ------------------------------------------------------------------
  // Users
  // ------------------------------------------------------------------
  upsertUser(googleUser, tokens) {
    const googleId = googleUser.id;
    checkUserReload(googleId, 'user');
    const s = getUserStore(googleId);
    const existing = s.user.user || {};
    const user = {
      id: googleId,
      googleId,
      email: googleUser.email || existing.email || '',
      name: googleUser.name || existing.name || 'Listener',
      avatar: googleUser.avatar || existing.avatar || '',
      tokens: {
        access_token: tokens.access_token || existing.tokens?.access_token || null,
        refresh_token: tokens.refresh_token || existing.tokens?.refresh_token || null,
        expiry_date: tokens.expiry_date || existing.tokens?.expiry_date || null,
        token_type: tokens.token_type || existing.tokens?.token_type || 'Bearer'
      },
      audiobooksFolderId: existing.audiobooksFolderId || null,
      audiobooksFolderName: existing.audiobooksFolderName || null,
      musicFolderId: existing.musicFolderId || null,
      musicFolderName: existing.musicFolderName || null,
      createdAt: existing.createdAt || new Date().toISOString(),
      lastLogin: new Date().toISOString()
    };
    s.user.user = user;

    // Ensure all 3 files exist on disk for the user
    const uDir = userDir(googleId);
    if (!fs.existsSync(uDir)) {
      fs.mkdirSync(uDir, { recursive: true });
    }
    if (!fs.existsSync(audiobooksFile(googleId))) {
      fs.writeFileSync(audiobooksFile(googleId), JSON.stringify(s.audiobooks, null, 2), 'utf8');
      try { s.mtime.audiobooks = fs.statSync(audiobooksFile(googleId)).mtimeMs; } catch {}
    }
    if (!fs.existsSync(musicFile(googleId))) {
      fs.writeFileSync(musicFile(googleId), JSON.stringify(s.music, null, 2), 'utf8');
      try { s.mtime.music = fs.statSync(musicFile(googleId)).mtimeMs; } catch {}
    }

    save(googleId, 'user');
    return user;
  },

  getUser(googleId) {
    checkUserReload(googleId, 'user');
    const s = getUserStore(googleId);
    return s.user.user || null;
  },

  updateUserTokens(googleId, tokens) {
    checkUserReload(googleId, 'user');
    const s = getUserStore(googleId);
    if (!s.user.user) return null;
    s.user.user.tokens = { ...s.user.user.tokens, ...tokens };
    save(googleId, 'user');
    return s.user.user;
  },

  setUserFolder(googleId, kind, folderId, folderName) {
    checkUserReload(googleId, 'user');
    const s = getUserStore(googleId);
    if (!s.user.user) return null;
    const suffix = kind === 'music' ? 'music' : 'audiobooks';
    s.user.user[`${suffix}FolderId`] = folderId || null;
    s.user.user[`${suffix}FolderName`] = folderName || null;
    save(googleId, 'user');
    return s.user.user;
  },

  // ------------------------------------------------------------------
  // Library items (audiobooks + music tracks)
  // ------------------------------------------------------------------
  getUserItems(userId, kind = null) {
    const s = getUserStore(userId);
    let list = [];
    if (kind === 'track') {
      checkUserReload(userId, 'music');
      list = Object.values(s.music.items);
    } else if (kind === 'audiobook' || kind === 'audiobooks') {
      checkUserReload(userId, 'audiobooks');
      list = Object.values(s.audiobooks.items);
    } else {
      checkUserReload(userId, 'audiobooks');
      checkUserReload(userId, 'music');
      list = [...Object.values(s.audiobooks.items), ...Object.values(s.music.items)];
    }
    return list.sort((a, b) => (a.title > b.title ? 1 : -1));
  },

  getItem(userId, itemId) {
    if (!itemId) return null;
    const s = getUserStore(userId);
    checkUserReload(userId, 'audiobooks');
    checkUserReload(userId, 'music');
    return s.audiobooks.items[itemId] || s.music.items[itemId] || null;
  },

  getItemByDriveFile(userId, googleFileId) {
    if (!googleFileId) return null;
    const s = getUserStore(userId);
    checkUserReload(userId, 'audiobooks');
    checkUserReload(userId, 'music');
    for (const item of Object.values(s.audiobooks.items)) {
      if (item.googleFileId === googleFileId) return item;
    }
    for (const item of Object.values(s.music.items)) {
      if (item.googleFileId === googleFileId) return item;
    }
    return null;
  },

  upsertItem(userId, info) {
    const s = getUserStore(userId);
    const isTrack = info.kind === 'track';
    const section = isTrack ? 'music' : 'audiobooks';
    checkUserReload(userId, section);

    const existing = info.id ? s[section].items[info.id] : null;
    if (existing) {
      if (isTrack && info.title) info.title = stripTrackNumberPrefix(info.title);
      Object.assign(existing, info, { userId, modifiedAt: new Date().toISOString() });
      save(userId, section);
      return existing;
    }

    const id = info.id || newId(isTrack ? 'trk' : 'abk');
    const item = {
      id,
      userId,
      kind: info.kind || (isTrack ? 'track' : 'audiobook'),
      googleFileId: info.googleFileId || null,
      driveFolderId: info.driveFolderId || null,
      title: isTrack ? stripTrackNumberPrefix(info.title || 'Untitled') : (info.title || 'Untitled'),
      subtitle: info.subtitle || '',
      author: info.author || '',
      artist: info.artist || '',
      series: info.series || '',
      seriesIndex: Number.isFinite(info.seriesIndex) ? info.seriesIndex : null,
      album: info.album || '',
      genre: Array.isArray(info.genre) ? info.genre.join(', ') : (info.genre || ''),
      albumArtist: info.albumArtist || '',
      trackNumber: Number.isFinite(info.trackNumber) ? info.trackNumber : null,
      discNumber: Number.isFinite(info.discNumber) ? info.discNumber : null,
      narrator: info.narrator || '',
      durationSec: Number.isFinite(info.durationSec) ? info.durationSec : null,
      format: info.format || '',
      bitrateKbps: Number.isFinite(info.bitrateKbps) ? info.bitrateKbps : null,
      abridged: info.abridged ?? null,
      sizeBytes: Number.isFinite(info.sizeBytes) ? info.sizeBytes : 0,
      coverImage: info.coverImage || null,
      drivePath: info.drivePath || '',
      addedAt: info.addedAt || new Date().toISOString(),
      modifiedAt: new Date().toISOString()
    };
    s[section].items[id] = item;
    save(userId, section);
    return item;
  },

  syncItems(userId, incoming, protectFileIds = [], { kind = null } = {}) {
    const s = getUserStore(userId);
    const scannedKinds = kind
      ? new Set([this.libraryKind(kind) || kind])
      : new Set(incoming.map((i) => i.kind).filter(Boolean));

    const pruneable = scannedKinds.size > 0;
    const incomingIds = new Set(incoming.map((i) => i.googleFileId).filter(Boolean));
    const protectedIds = new Set((protectFileIds || []).filter(Boolean));

    const isOnlyMusic = scannedKinds.size === 1 && scannedKinds.has('track');
    const isOnlyAudiobooks = scannedKinds.size === 1 && scannedKinds.has('audiobook');

    const targetSections = isOnlyMusic ? ['music'] : isOnlyAudiobooks ? ['audiobooks'] : ['audiobooks', 'music'];

    for (const sec of targetSections) {
      checkUserReload(userId, sec);
      const existingItems = Object.values(s[sec].items);
      for (const ex of existingItems) {
        if (!pruneable || !scannedKinds.has(ex.kind)) continue;
        if (!incomingIds.has(ex.googleFileId) && !protectedIds.has(ex.googleFileId)) {
          this.removeItem(userId, ex.id, { silent: true });
        }
      }
    }

    for (const inc of incoming) {
      const isTrack = inc.kind === 'track';
      const sec = isTrack ? 'music' : 'audiobooks';
      let existing = (inc.id && s[sec].items[inc.id]) || null;
      if (!existing && inc.googleFileId) {
        existing = Object.values(s[sec].items).find((i) => i.googleFileId === inc.googleFileId);
      }
      if (existing) {
        let title = inc.title || existing.title;
        if (isTrack && title) title = stripTrackNumberPrefix(title);
        s[sec].items[existing.id] = {
          ...existing,
          ...inc,
          id: existing.id,
          title,
          userId,
          modifiedAt: new Date().toISOString()
        };
        s.dirty[sec] = true;
      } else {
        const id = inc.id || newId(isTrack ? 'trk' : 'abk');
        let title = inc.title || 'Untitled';
        if (isTrack && title) title = stripTrackNumberPrefix(title);
        s[sec].items[id] = {
          ...inc,
          id,
          userId,
          kind: inc.kind || (isTrack ? 'track' : 'audiobook'),
          title,
          addedAt: inc.addedAt || new Date().toISOString(),
          modifiedAt: new Date().toISOString()
        };
        s.dirty[sec] = true;
      }
    }

    writeNow(userId);
    return this.getUserItems(userId);
  },

  updateItem(userId, itemId, updates) {
    const s = getUserStore(userId);
    checkUserReload(userId, 'audiobooks');
    checkUserReload(userId, 'music');
    let item = s.audiobooks.items[itemId];
    let section = 'audiobooks';
    if (!item) {
      item = s.music.items[itemId];
      section = 'music';
    }
    if (!item || item.userId !== userId) return null;
    Object.assign(item, updates, { modifiedAt: new Date().toISOString() });
    save(userId, section);
    return item;
  },

  removeItem(userId, itemId, { silent = false } = {}) {
    const s = getUserStore(userId);
    checkUserReload(userId, 'audiobooks');
    checkUserReload(userId, 'music');
    checkUserReload(userId, 'user');

    let isMusic = false;
    let item = s.audiobooks.items[itemId];
    if (!item) {
      item = s.music.items[itemId];
      if (item) isMusic = true;
    }
    if (!item || item.userId !== userId) return false;

    if (isMusic) {
      delete s.music.items[itemId];
      delete s.music.progress[itemId];
      const idx = s.music.favorites.indexOf(itemId);
      if (idx >= 0) s.music.favorites.splice(idx, 1);
      for (const playlist of Object.values(s.music.playlists)) {
        const pIdx = playlist.itemIds.indexOf(itemId);
        if (pIdx >= 0) playlist.itemIds.splice(pIdx, 1);
      }
      s.dirty.music = true;
    } else {
      delete s.audiobooks.items[itemId];
      delete s.audiobooks.progress[itemId];
      const idx = s.audiobooks.favorites.indexOf(itemId);
      if (idx >= 0) s.audiobooks.favorites.splice(idx, 1);
      for (const playlist of Object.values(s.audiobooks.playlists)) {
        const pIdx = playlist.itemIds.indexOf(itemId);
        if (pIdx >= 0) playlist.itemIds.splice(pIdx, 1);
      }
      s.dirty.audiobooks = true;
    }

    // Clean up offline list
    let offlineChanged = false;
    for (let i = s.user.offline.length - 1; i >= 0; i--) {
      if (s.user.offline[i].itemId === itemId) {
        s.user.offline.splice(i, 1);
        offlineChanged = true;
      }
    }
    if (offlineChanged) s.dirty.user = true;

    if (!silent) writeNow(userId);
    touchMeta(userId);
    return true;
  },

  // ------------------------------------------------------------------
  // Playback progress
  // ------------------------------------------------------------------
  getProgress(userId, itemId = null) {
    const s = getUserStore(userId);
    checkUserReload(userId, 'audiobooks');
    checkUserReload(userId, 'music');
    if (itemId) {
      return s.audiobooks.progress[itemId] || s.music.progress[itemId] || null;
    }
    return { ...s.audiobooks.progress, ...s.music.progress };
  },

  saveProgress(userId, itemId, positionSec, durationSec) {
    const s = getUserStore(userId);
    checkUserReload(userId, 'audiobooks');
    checkUserReload(userId, 'music');

    const isTrack = s.music.items[itemId] || itemId.startsWith('trk_');
    const section = isTrack ? 'music' : 'audiobooks';
    const prev = s[section].progress[itemId] || {};
    const entry = {
      userId,
      itemId,
      positionSec: Math.max(0, Math.floor(Number(positionSec) || 0)),
      durationSec: Number.isFinite(durationSec) ? Math.floor(durationSec) : prev.durationSec ?? null,
      updatedAt: new Date().toISOString()
    };
    s[section].progress[itemId] = entry;
    save(userId, section);
    touchMeta(userId);
    return entry;
  },

  clearProgress(userId, itemId) {
    const s = getUserStore(userId);
    let changed = false;
    if (s.audiobooks.progress[itemId]) {
      delete s.audiobooks.progress[itemId];
      save(userId, 'audiobooks');
      changed = true;
    }
    if (s.music.progress[itemId]) {
      delete s.music.progress[itemId];
      save(userId, 'music');
      changed = true;
    }
    if (changed) touchMeta(userId);
  },

  // ------------------------------------------------------------------
  // Favourites / likes
  // ------------------------------------------------------------------
  namePools(userId) {
    const s = getUserStore(userId);
    checkUserReload(userId, 'audiobooks');
    checkUserReload(userId, 'music');
    const audiobookNames = new Set();
    const musicNames = new Set();
    for (const item of Object.values(s.audiobooks.items)) {
      if (item.author) audiobookNames.add(item.author);
    }
    for (const item of Object.values(s.music.items)) {
      if (item.artist) musicNames.add(item.artist);
      if (item.albumArtist) musicNames.add(item.albumArtist);
      if (item.author) musicNames.add(item.author);
    }
    return { audiobookNames, musicNames };
  },

  getFavorites(userId, kind = null) {
    const s = getUserStore(userId);
    if (kind === 'music') {
      checkUserReload(userId, 'music');
      return [...s.music.favorites];
    }
    if (kind === 'audiobooks' || kind === 'audiobook') {
      checkUserReload(userId, 'audiobooks');
      return [...s.audiobooks.favorites];
    }
    checkUserReload(userId, 'audiobooks');
    checkUserReload(userId, 'music');
    return [...s.audiobooks.favorites, ...s.music.favorites];
  },

  toggleFavorite(userId, itemId, isFavorite) {
    const s = getUserStore(userId);
    checkUserReload(userId, 'audiobooks');
    checkUserReload(userId, 'music');

    const isTrack = Boolean(s.music.items[itemId]) || itemId.startsWith('trk_');
    const section = isTrack ? 'music' : 'audiobooks';
    const current = new Set(s[section].favorites);

    if (isFavorite) current.add(itemId);
    else current.delete(itemId);

    s[section].favorites = Array.from(current);
    save(userId, section);
    touchMeta(userId);
    return this.getFavorites(userId);
  },

  toggleFavoritesBulk(userId, itemIds, isFavorite) {
    const s = getUserStore(userId);
    checkUserReload(userId, 'audiobooks');
    checkUserReload(userId, 'music');

    let audiobooksDirty = false;
    let musicDirty = false;
    const abSet = new Set(s.audiobooks.favorites);
    const muSet = new Set(s.music.favorites);

    for (const id of itemIds || []) {
      const isTrack = Boolean(s.music.items[id]) || id.startsWith('trk_');
      if (isTrack) {
        if (isFavorite) muSet.add(id);
        else muSet.delete(id);
        musicDirty = true;
      } else {
        if (isFavorite) abSet.add(id);
        else abSet.delete(id);
        audiobooksDirty = true;
      }
    }

    if (audiobooksDirty) {
      s.audiobooks.favorites = Array.from(abSet);
      save(userId, 'audiobooks');
    }
    if (musicDirty) {
      s.music.favorites = Array.from(muSet);
      save(userId, 'music');
    }
    if (audiobooksDirty || musicDirty) touchMeta(userId);
    return this.getFavorites(userId);
  },

  getAuthorFavorites(userId, kind = null) {
    const s = getUserStore(userId);
    if (kind === 'music') {
      checkUserReload(userId, 'music');
      return [...s.music.authorFavorites];
    }
    if (kind === 'audiobooks' || kind === 'audiobook') {
      checkUserReload(userId, 'audiobooks');
      return [...s.audiobooks.authorFavorites];
    }
    checkUserReload(userId, 'audiobooks');
    checkUserReload(userId, 'music');
    return Array.from(new Set([...s.audiobooks.authorFavorites, ...s.music.authorFavorites]));
  },

  toggleAuthorFavorite(userId, name, isFavorite, kind = null) {
    const s = getUserStore(userId);
    checkUserReload(userId, 'audiobooks');
    checkUserReload(userId, 'music');
    checkUserReload(userId, 'user');

    let targetKind = kind;
    if (!targetKind) {
      if (s.user.authorFavoriteKinds?.[name]) {
        targetKind = s.user.authorFavoriteKinds[name];
      } else {
        const { audiobookNames, musicNames } = this.namePools(userId);
        targetKind = musicNames.has(name) ? 'music' : 'audiobooks';
      }
    }

    const isMusic = targetKind === 'music';
    const section = isMusic ? 'music' : 'audiobooks';
    const current = new Set(s[section].authorFavorites);

    if (isFavorite) {
      current.add(name);
      if (!s.user.authorFavoriteKinds) s.user.authorFavoriteKinds = {};
      s.user.authorFavoriteKinds[name] = targetKind;
      save(userId, 'user');
    } else {
      current.delete(name);
      if (s.user.authorFavoriteKinds?.[name]) {
        delete s.user.authorFavoriteKinds[name];
        save(userId, 'user');
      }
    }

    s[section].authorFavorites = Array.from(current);
    save(userId, section);
    touchMeta(userId);
    return this.getAuthorFavorites(userId, kind);
  },

  repairAlbumFavorites(userId) {
    const s = getUserStore(userId);
    checkUserReload(userId, 'music');
    const keys = s.music.albumFavorites;
    if (!Array.isArray(keys) || !keys.length) return keys || [];

    const artistByAlbum = new Map();
    for (const item of Object.values(s.music.items)) {
      if (!item.album) continue;
      const artist = String(item.albumArtist || item.artist || item.author || '').trim();
      if (!artist || /^\d{4}$/.test(artist)) continue;
      if (!artistByAlbum.has(item.album)) artistByAlbum.set(item.album, artist);
    }

    let changed = false;
    const next = [];
    for (const key of keys) {
      const idx = key.indexOf('::');
      if (idx < 0) {
        if (!next.includes(key)) next.push(key);
        continue;
      }
      const artist = key.slice(0, idx);
      const album = key.slice(idx + 2);
      if (/^\d{4}$/.test(artist)) {
        const real = artistByAlbum.get(album);
        if (real) {
          const healed = `${real}::${album}`;
          if (!next.includes(healed)) next.push(healed);
          changed = true;
          continue;
        }
      }
      if (!next.includes(key)) next.push(key);
    }

    if (changed) {
      s.music.albumFavorites = next;
      save(userId, 'music');
      touchMeta(userId);
    }
    return s.music.albumFavorites;
  },

  getAlbumFavorites(userId) {
    return this.repairAlbumFavorites(userId);
  },

  toggleAlbumFavorite(userId, artist, album, isFavorite) {
    const key = `${String(artist || 'Unknown Artist').trim()}::${String(album || '').trim()}`;
    if (!String(album || '').trim()) return this.getAlbumFavorites(userId);
    const s = getUserStore(userId);
    checkUserReload(userId, 'music');
    const current = new Set(s.music.albumFavorites);
    if (isFavorite) current.add(key);
    else current.delete(key);
    s.music.albumFavorites = Array.from(current);
    save(userId, 'music');
    touchMeta(userId);
    return s.music.albumFavorites;
  },

  mergeAlbumFavoriteKeys(userId, keys) {
    const s = getUserStore(userId);
    checkUserReload(userId, 'music');
    const current = new Set(s.music.albumFavorites);
    let added = 0;
    for (const key of keys || []) {
      if (key && !current.has(key)) {
        current.add(key);
        added += 1;
      }
    }
    if (added) {
      s.music.albumFavorites = Array.from(current);
      save(userId, 'music');
      touchMeta(userId);
    }
    return added;
  },

  // ------------------------------------------------------------------
  // Playlists
  // ------------------------------------------------------------------
  libraryKind(kind) {
    if (kind === 'music') return 'track';
    if (kind === 'audiobooks' || kind === 'audiobook') return 'audiobook';
    return null;
  },

  getPlaylists(userId, kind = null) {
    const s = getUserStore(userId);
    const wantedItemKind = this.libraryKind(kind);
    let list = [];
    if (wantedItemKind === 'track') {
      checkUserReload(userId, 'music');
      list = Object.values(s.music.playlists);
    } else if (wantedItemKind === 'audiobook') {
      checkUserReload(userId, 'audiobooks');
      list = Object.values(s.audiobooks.playlists);
    } else {
      checkUserReload(userId, 'audiobooks');
      checkUserReload(userId, 'music');
      list = [...Object.values(s.audiobooks.playlists), ...Object.values(s.music.playlists)];
    }
    return list
      .map((p) => ({
        ...p,
        kind: p.kind || 'audiobooks',
        count: (p.itemIds || []).length,
        coverUrl: p.coverUrl || ((p.itemIds && p.itemIds[0]) ? `/api/items/${p.itemIds[0]}/cover` : null)
      }))
      .sort((a, b) => (a.name > b.name ? 1 : -1));
  },

  getPlaylist(userId, playlistId) {
    if (!playlistId) return null;
    const s = getUserStore(userId);
    checkUserReload(userId, 'audiobooks');
    checkUserReload(userId, 'music');
    return s.music.playlists[playlistId] || s.audiobooks.playlists[playlistId] || null;
  },

  createPlaylist(userId, name, { id = null, kind = null, createdAt = null, updatedAt = null } = {}) {
    const s = getUserStore(userId);
    const isMusic = kind === 'music';
    const section = isMusic ? 'music' : 'audiobooks';
    checkUserReload(userId, section);

    const playlistId = id || newId('pl');
    if (s[section].playlists[playlistId]) return s[section].playlists[playlistId];

    const now = new Date().toISOString();
    const playlist = {
      id: playlistId,
      kind: isMusic ? 'music' : 'audiobooks',
      name: String(name || 'New Playlist').trim() || 'New Playlist',
      itemIds: [],
      createdAt: createdAt || now,
      updatedAt: updatedAt || now
    };
    s[section].playlists[playlist.id] = playlist;
    save(userId, section);
    touchMeta(userId);
    return playlist;
  },

  renamePlaylist(userId, playlistId, name) {
    const playlist = this.getPlaylist(userId, playlistId);
    if (!playlist) return null;
    playlist.name = String(name).trim() || playlist.name;
    playlist.updatedAt = new Date().toISOString();
    const section = playlist.kind === 'music' ? 'music' : 'audiobooks';
    save(userId, section);
    touchMeta(userId);
    return playlist;
  },

  deletePlaylist(userId, playlistId) {
    const s = getUserStore(userId);
    checkUserReload(userId, 'audiobooks');
    checkUserReload(userId, 'music');

    if (s.music.playlists[playlistId]) {
      delete s.music.playlists[playlistId];
      save(userId, 'music');
      touchMeta(userId);
      return true;
    }
    if (s.audiobooks.playlists[playlistId]) {
      delete s.audiobooks.playlists[playlistId];
      save(userId, 'audiobooks');
      touchMeta(userId);
      return true;
    }
    return false;
  },

  setPlaylistItems(userId, playlistId, itemIds) {
    const playlist = this.getPlaylist(userId, playlistId);
    if (!playlist) return null;
    const playlistKind = playlist.kind || 'audiobooks';
    const wantedKind = this.libraryKind(playlistKind);
    const owned = new Set(this.getUserItems(userId, wantedKind).map((i) => i.id));
    playlist.itemIds = Array.from(new Set(itemIds)).filter((id) => owned.has(id));
    playlist.updatedAt = new Date().toISOString();
    const section = playlistKind === 'music' ? 'music' : 'audiobooks';
    save(userId, section);
    touchMeta(userId);
    return playlist;
  },

  // ------------------------------------------------------------------
  // Smart playlists (music-only)
  // ------------------------------------------------------------------
  getSmartPlaylists(userId) {
    const s = getUserStore(userId);
    checkUserReload(userId, 'music');
    return Object.values(s.music.smartPlaylists || {})
      .map((r) => ({ ...r, keywords: [...(r.keywords || [])] }))
      .sort((a, b) => (a.name > b.name ? 1 : -1));
  },

  createSmartPlaylist(userId, name, keywords) {
    const clean = String(name || '').trim().slice(0, 80);
    const kws = [...new Set((Array.isArray(keywords) ? keywords : String(keywords || '').split(','))
      .map((k) => String(k).trim().toLowerCase())
      .filter(Boolean))];
    if (!clean) throw new Error('A smart playlist needs a name.');
    if (!kws.length) throw new Error('Add at least one keyword.');

    const s = getUserStore(userId);
    checkUserReload(userId, 'music');

    const existing = this.getSmartPlaylists(userId).find((r) => r.name === clean);
    if (existing) {
      const merged = [...new Set([...(existing.keywords || []), ...kws])];
      s.music.smartPlaylists[existing.id].keywords = merged;
      save(userId, 'music');
      touchMeta(userId);
      return { ...existing, keywords: merged };
    }
    const now = new Date().toISOString();
    const rule = { id: newId('sp'), name: clean, kind: 'music', keywords: kws, createdAt: now, updatedAt: now };
    s.music.smartPlaylists[rule.id] = rule;
    save(userId, 'music');
    touchMeta(userId);
    return { ...rule };
  },

  deleteSmartPlaylist(userId, ruleId) {
    const s = getUserStore(userId);
    checkUserReload(userId, 'music');
    if (!s.music.smartPlaylists[ruleId]) return false;
    delete s.music.smartPlaylists[ruleId];
    save(userId, 'music');
    touchMeta(userId);
    return true;
  },

  applySmartPlaylists(userId) {
    const rules = this.getSmartPlaylists(userId);
    if (!rules.length) return {};
    const tracks = this.getUserItems(userId, 'track');
    if (!tracks.length) return {};
    const result = {};

    for (const rule of rules) {
      const matchers = (rule.keywords || []).map((kw) => smartRegex(kw)).filter(Boolean);
      if (!matchers.length) continue;
      const hits = tracks.filter((t) => {
        const hay = [t.artist, t.albumArtist, t.author, t.album, t.title, t.genre, t.drivePath]
          .filter(Boolean)
          .join(' · ')
          .toLowerCase();
        return matchers.some((re) => re.test(hay));
      });
      result[rule.name] = 0;
      if (!hits.length) continue;
      const playlists = this.getPlaylists(userId, 'music');
      let playlist = playlists.find((p) => p.name === rule.name);
      if (!playlist) playlist = this.createPlaylist(userId, rule.name, { kind: 'music' });
      const current = this.getPlaylist(userId, playlist.id)?.itemIds || [];
      const union = [...new Set([...current, ...hits.map((h) => h.id)])];
      if (union.length !== current.length) {
        this.setPlaylistItems(userId, playlist.id, union);
        result[rule.name] = union.length - current.length;
      }
    }
    return result;
  },

  // ------------------------------------------------------------------
  // Music download queue
  // ------------------------------------------------------------------
  getMusicQueue(userId) {
    const s = getUserStore(userId);
    checkUserReload(userId, 'music');
    return s.music.musicQueue || {};
  },

  saveMusicQueue(userId, entries) {
    const s = getUserStore(userId);
    if (Object.keys(entries || {}).length) s.music.musicQueue = entries;
    else s.music.musicQueue = {};
    s.dirty.music = true;
    writeSectionNow(userId, 'music');
  },

  findItemByDrivePath(userId, drivePath) {
    const needle = String(drivePath || '').toLowerCase();
    if (!needle) return null;
    const s = getUserStore(userId);
    checkUserReload(userId, 'audiobooks');
    checkUserReload(userId, 'music');
    for (const item of Object.values(s.audiobooks.items)) {
      if (String(item.drivePath || '').toLowerCase() === needle) return item;
    }
    for (const item of Object.values(s.music.items)) {
      if (String(item.drivePath || '').toLowerCase() === needle) return item;
    }
    return null;
  },

  // ------------------------------------------------------------------
  // Offline cache records
  // ------------------------------------------------------------------
  getOffline(userId) {
    const s = getUserStore(userId);
    checkUserReload(userId, 'user');
    return s.user.offline || [];
  },

  setOffline(userId, itemId, record) {
    const s = getUserStore(userId);
    checkUserReload(userId, 'user');
    if (!Array.isArray(s.user.offline)) s.user.offline = [];
    const list = s.user.offline;
    const idx = list.findIndex((r) => r.itemId === itemId);
    const entry = { itemId, ...record, addedAt: new Date().toISOString() };
    if (idx >= 0) list[idx] = { ...list[idx], ...entry };
    else list.push(entry);
    save(userId, 'user');
    return entry;
  },

  removeOffline(userId, itemId) {
    const s = getUserStore(userId);
    checkUserReload(userId, 'user');
    const list = s.user.offline || [];
    const idx = list.findIndex((r) => r.itemId === itemId);
    if (idx >= 0) list.splice(idx, 1);
    save(userId, 'user');
    return idx >= 0;
  },

  // ------------------------------------------------------------------
  // AudioBookBay "What's New" bookkeeping
  // ------------------------------------------------------------------
  getAbbSeen(userId) {
    const s = getUserStore(userId);
    checkUserReload(userId, 'audiobooks');
    return s.audiobooks.abbSeen || [];
  },

  markAbbSeen(userId, postId) {
    if (!postId) return this.getAbbSeen(userId);
    const s = getUserStore(userId);
    checkUserReload(userId, 'audiobooks');
    const set = new Set(s.audiobooks.abbSeen || []);
    set.add(postId);
    s.audiobooks.abbSeen = Array.from(set).slice(-2000);
    save(userId, 'audiobooks');
    touchMeta(userId);
    return s.audiobooks.abbSeen;
  },

  markAllAbbSeen(userId, postIds) {
    const s = getUserStore(userId);
    checkUserReload(userId, 'audiobooks');
    const set = new Set(s.audiobooks.abbSeen || []);
    for (const id of postIds || []) set.add(id);
    s.audiobooks.abbSeen = Array.from(set).slice(-2000);
    save(userId, 'audiobooks');
    touchMeta(userId);
    return s.audiobooks.abbSeen;
  },

  // ------------------------------------------------------------------
  // Pull list
  // ------------------------------------------------------------------
  getPullList(userId) {
    const s = getUserStore(userId);
    checkUserReload(userId, 'audiobooks');
    return s.audiobooks.pullList || { authors: [], series: [], enabled: true, lastCheck: null, lastResults: [] };
  },

  savePullList(userId, patch) {
    const s = getUserStore(userId);
    checkUserReload(userId, 'audiobooks');
    s.audiobooks.pullList = { ...this.getPullList(userId), ...patch };
    save(userId, 'audiobooks');
    touchMeta(userId);
    return s.audiobooks.pullList;
  },

  // ------------------------------------------------------------------
  // Settings
  // ------------------------------------------------------------------
  getSettings(userId) {
    const s = getUserStore(userId);
    checkUserReload(userId, 'user');
    return { ...DEFAULT_SETTINGS, ...(s.user.settings || {}) };
  },

  saveSettings(userId, patch) {
    const s = getUserStore(userId);
    checkUserReload(userId, 'user');
    s.user.settings = { ...this.getSettings(userId), ...patch };
    save(userId, 'user');
    touchMeta(userId);
    return s.user.settings;
  },

  _defaults: DEFAULT_SETTINGS
};

export default db;
