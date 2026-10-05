const path = require('path');
const fs = require('fs');

/**
 * Cloud Database Module:
 * Multi-user, isolated persistent storage for Google OAuth accounts,
 * Google Drive comics, reading progress, favorites, and pull lists.
 * Pure JavaScript for 100% reliability on shared hosting environments.
 */

let dbData = {
  users: {},          // googleId -> { id, googleId, email, name, avatar, tokens, driveFolderId, driveFolderName, createdAt }
  comics: {},         // comicId -> { id, userId, googleFileId, title, series, item, isVolume, size, mimeType, coverImage, modifiedTime }
  readingProgress: {},// `${userId}:${comicId}` -> { userId, comicId, currentPage, totalPages, lastRead }
  favorites: {},      // userId -> Set<comicId> (as array)
  seriesFavorites: {},// userId -> Set<seriesName> (as array)
  pullList: {},       // userId -> { series: [], enabled: true, lastCheck: null, lastResults: null }
  settings: {}        // userId -> { organizeBySeries: true, autoScan: true }
};

let dbFilePath = path.join(__dirname, '..', 'data', 'cloud-db.json');

// Cross-process freshness: Passenger runs several worker processes that each
// hold their own in-memory copy. Downloads/scans write the DB from the detached
// worker, so readers reload when the file on disk has changed.
let lastLoadedMtimeMs = 0;
let dbDirty = false;

function ensureDataDirectory() {
  try {
    const customDir = process.env.DATA_DIR;
    if (customDir) {
      dbFilePath = path.isAbsolute(customDir)
        ? path.join(customDir, 'cloud-db.json')
        : path.join(__dirname, '..', customDir, 'cloud-db.json');
    }
    const dir = path.dirname(dbFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  } catch (err) {
    // Never let an unwritable data directory crash the whole server on boot.
    console.error('[Database] Data directory unavailable:', err.message);
  }
}

function loadDatabase() {
  ensureDataDirectory();
  if (fs.existsSync(dbFilePath)) {
    try {
      const raw = fs.readFileSync(dbFilePath, 'utf8');
      const parsed = JSON.parse(raw);
      dbData = {
        users: parsed.users || {},
        comics: parsed.comics || {},
        readingProgress: parsed.readingProgress || {},
        favorites: parsed.favorites || {},
        seriesFavorites: parsed.seriesFavorites || {},
        pullList: parsed.pullList || {},
        settings: parsed.settings || {}
      };
    } catch (err) {
      console.warn('[Database] Could not parse cloud-db.json, initializing new DB:', err.message);
    }
  } else {
    saveDatabase();
  }
  try {
    lastLoadedMtimeMs = fs.existsSync(dbFilePath) ? fs.statSync(dbFilePath).mtimeMs : 0;
  } catch (e) {
    lastLoadedMtimeMs = 0;
  }
}

let saveTimer = null;
function saveDatabase() {
  ensureDataDirectory();
  try {
    const tempPath = `${dbFilePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(dbData, null, 2), 'utf8');
    fs.renameSync(tempPath, dbFilePath);
    dbDirty = false;
    try { lastLoadedMtimeMs = fs.statSync(dbFilePath).mtimeMs; } catch (e) {}
  } catch (err) {
    console.error('[Database] Failed to write cloud-db.json:', err.message);
  }
}

function debouncedSave() {
  dbDirty = true;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveDatabase, 300);
}

// Reload from disk when another process has written a newer copy. If we have
// unsaved local changes, persist them and keep our state (whole-file stores are
// last-writer-wins; this at least avoids reloading over pending work).
function reloadIfChanged() {
  try {
    if (!fs.existsSync(dbFilePath)) return;
    const mtime = fs.statSync(dbFilePath).mtimeMs;
    if (mtime === lastLoadedMtimeMs) return;
    if (dbDirty) {
      saveDatabase();
      return;
    }
    loadDatabase();
  } catch (e) {}
}

// Initialize on module load (never fatal: fall back to in-memory store)
try {
  loadDatabase();
} catch (err) {
  console.error('[Database] Startup load failed, using in-memory store:', err.message);
}

const Database = {
  // --- User Operations ---
  upsertUser(googleUser, tokens) {
    const { id: googleId, email, name, picture: avatar } = googleUser;
    const existing = dbData.users[googleId] || {};
    const updated = {
      id: googleId,
      googleId,
      email: email || existing.email || '',
      name: name || existing.name || 'Comics Reader',
      avatar: avatar || existing.avatar || '🦸',
      tokens: {
        access_token: tokens.access_token || existing.tokens?.access_token,
        refresh_token: tokens.refresh_token || existing.tokens?.refresh_token,
        expiry_date: tokens.expiry_date || existing.tokens?.expiry_date,
        token_type: tokens.token_type || existing.tokens?.token_type || 'Bearer'
      },
      driveFolderId: existing.driveFolderId || null,
      driveFolderName: existing.driveFolderName || null,
      createdAt: existing.createdAt || new Date().toISOString(),
      lastLogin: new Date().toISOString()
    };
    dbData.users[googleId] = updated;
    debouncedSave();
    return updated;
  },

  getUser(googleId) {
    reloadIfChanged();
    return dbData.users[googleId] || null;
  },

  updateUserTokens(googleId, newTokens) {
    const user = dbData.users[googleId];
    if (user) {
      user.tokens = { ...user.tokens, ...newTokens };
      debouncedSave();
    }
  },

  updateUserDriveFolder(googleId, folderId, folderName) {
    const user = dbData.users[googleId];
    if (user) {
      user.driveFolderId = folderId;
      user.driveFolderName = folderName;
      debouncedSave();
      return user;
    }
    return null;
  },

  // --- Comics Operations (Scoped to User) ---
  getUserComics(userId) {
    reloadIfChanged();
    const list = Object.values(dbData.comics).filter((c) => c.userId === userId);
    if (list.length === 0 && (userId === 'default' || !userId)) {
      return Object.values(dbData.comics).sort((a, b) => (b.id > a.id ? 1 : -1));
    }
    return list.sort((a, b) => (b.id > a.id ? 1 : -1));
  },

  getComicById(userId, comicId) {
    reloadIfChanged();
    const comic = dbData.comics[comicId];
    if (comic && comic.userId === userId) {
      return comic;
    }
    return null;
  },

  getComic(comicId) {
    reloadIfChanged();
    return dbData.comics[comicId] || Object.values(dbData.comics).find(
      (c) => c.googleFileId === comicId || c.id === comicId
    ) || null;
  },

  getComicByGoogleFileId(userId, fileId) {
    return Object.values(dbData.comics).find(
      (c) => c.userId === userId && c.googleFileId === fileId
    ) || null;
  },

  saveComic(userId, comicInfo) {
    const id = comicInfo.id || `cmx_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const comic = {
      id,
      userId,
      googleFileId: comicInfo.googleFileId,
      title: comicInfo.title || 'Untitled Comic',
      series: comicInfo.series || '',
      item: comicInfo.item || '',
      isVolume: Boolean(comicInfo.isVolume),
      size: comicInfo.size || 0,
      totalPages: comicInfo.totalPages || 0,
      mimeType: comicInfo.mimeType || 'application/vnd.comicbook+zip',
      coverImage: comicInfo.coverImage || null,
      modifiedTime: comicInfo.modifiedTime || new Date().toISOString(),
      addedAt: comicInfo.addedAt || new Date().toISOString()
    };
    dbData.comics[id] = comic;
    debouncedSave();
    return comic;
  },

  batchSyncComics(userId, newComicsList, protectedFileIds = []) {
    // Keep only comics for this user
    const existingForUser = Object.values(dbData.comics).filter((c) => c.userId === userId);
    const incomingFileIds = new Set(newComicsList.map((c) => c.googleFileId));
    // Files that must never be deleted by this sync (e.g. a comic just uploaded
    // to Drive that the listing may not have indexed yet).
    const protectedIds = new Set((protectedFileIds || []).filter(Boolean));

    // Remove deleted files
    for (const ex of existingForUser) {
      if (!incomingFileIds.has(ex.googleFileId) && !protectedIds.has(ex.googleFileId)) {
        delete dbData.comics[ex.id];
      }
    }

    // Add or update incoming files
    for (const inc of newComicsList) {
      const match = existingForUser.find((c) => c.googleFileId === inc.googleFileId);
      if (match) {
        dbData.comics[match.id] = {
          ...match,
          title: inc.title || match.title,
          series: inc.series || match.series,
          item: inc.item || match.item,
          isVolume: inc.isVolume !== undefined ? inc.isVolume : match.isVolume,
          size: inc.size || match.size,
          totalPages: inc.totalPages || match.totalPages || 0,
          coverImage: inc.coverImage || match.coverImage,
          modifiedTime: inc.modifiedTime || match.modifiedTime
        };
      } else {
        const id = `cmx_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        dbData.comics[id] = {
          ...inc,
          id,
          userId
        };
      }
    }

    saveDatabase();
    return this.getUserComics(userId);
  },

  deleteComic(userId, comicId) {
    const comic = dbData.comics[comicId];
    if (comic && comic.userId === userId) {
      delete dbData.comics[comicId];
      delete dbData.readingProgress[`${userId}:${comicId}`];
      debouncedSave();
      return true;
    }
    return false;
  },

  updateComicMetadata(userId, comicId, updates) {
    reloadIfChanged();
    const comic = dbData.comics[comicId];
    if (!comic || (comic.userId !== userId && userId !== 'default')) {
      return null;
    }

    const updated = {
      ...comic,
      title: updates.title !== undefined ? String(updates.title).trim() : comic.title,
      series: updates.series !== undefined ? String(updates.series).trim() : comic.series,
      item: updates.item !== undefined ? String(updates.item).trim() : comic.item,
      isVolume: updates.isVolume !== undefined ? Boolean(updates.isVolume) : comic.isVolume,
      modifiedTime: new Date().toISOString()
    };

    if (updates.filepath) {
      updated.filepath = updates.filepath;
    }

    dbData.comics[comicId] = updated;
    debouncedSave();
    return updated;
  },

  // --- Reading Progress Operations ---
  getReadingProgress(userId, comicId) {
    if (comicId) {
      return dbData.readingProgress[`${userId}:${comicId}`] || null;
    }
    // Return all progress for this user
    const userProgress = {};
    for (const [key, val] of Object.entries(dbData.readingProgress)) {
      if (val.userId === userId) {
        userProgress[val.comicId] = val;
      }
    }
    return userProgress;
  },

  saveReadingProgress(userId, comicId, currentPage, totalPages, zoomNormX, zoomNormY) {
    const key = `${userId}:${comicId}`;
    const prev = dbData.readingProgress[key] || {};
    const entry = {
      userId,
      comicId,
      currentPage: parseInt(currentPage, 10) || 0,
      totalPages: totalPages ? parseInt(totalPages, 10) : prev.totalPages,
      zoomNormX: typeof zoomNormX === 'number' ? zoomNormX : prev.zoomNormX,
      zoomNormY: typeof zoomNormY === 'number' ? zoomNormY : prev.zoomNormY,
      lastRead: new Date().toISOString()
    };
    dbData.readingProgress[key] = entry;
    debouncedSave();
    return entry;
  },

  // --- Favorites Operations ---
  getFavorites(userId) {
    return dbData.favorites[userId] || [];
  },

  toggleFavorite(userId, comicId, isFavorite) {
    const current = new Set(dbData.favorites[userId] || []);
    if (isFavorite) {
      current.add(comicId);
    } else {
      current.delete(comicId);
    }
    const updated = Array.from(current);
    dbData.favorites[userId] = updated;
    debouncedSave();
    return updated;
  },

  saveFavorites(userId, favoritesArray) {
    dbData.favorites[userId] = Array.isArray(favoritesArray) ? favoritesArray : [];
    debouncedSave();
    return dbData.favorites[userId];
  },

  getSeriesFavorites(userId) {
    return dbData.seriesFavorites[userId] || [];
  },

  toggleSeriesFavorite(userId, seriesName, isFavorite) {
    const current = new Set(dbData.seriesFavorites[userId] || []);
    if (isFavorite) {
      current.add(seriesName);
    } else {
      current.delete(seriesName);
    }
    const updated = Array.from(current);
    dbData.seriesFavorites[userId] = updated;
    debouncedSave();
    return updated;
  },

  saveSeriesFavorites(userId, seriesArray) {
    dbData.seriesFavorites[userId] = Array.isArray(seriesArray) ? seriesArray : [];
    debouncedSave();
    return dbData.seriesFavorites[userId];
  },

  // --- Pull List Operations ---
  getPullList(userId) {
    const entry = dbData.pullList[userId] || {
      series: [],
      enabled: true,
      lastCheck: null,
      lastResults: null
    };
    return entry;
  },

  savePullList(userId, seriesArray) {
    const current = this.getPullList(userId);
    current.series = Array.isArray(seriesArray) ? seriesArray : [];
    dbData.pullList[userId] = current;
    debouncedSave();
    return current;
  },

  setPullListEnabled(userId, enabled) {
    const current = this.getPullList(userId);
    current.enabled = Boolean(enabled);
    dbData.pullList[userId] = current;
    debouncedSave();
    return current;
  },

  updatePullListResults(userId, results) {
    const current = this.getPullList(userId);
    current.lastCheck = new Date().toISOString();
    current.lastResults = results;
    dbData.pullList[userId] = current;
    debouncedSave();
    return current;
  },

  // --- User Settings ---
  getUserSettings(userId) {
    reloadIfChanged();
    const defaults = {
      organizeBySeries: true,
      autoScan: true,
      compressLibrary: true,
      compressionQuality: 75
    };
    return { ...defaults, ...(dbData.settings[userId] || {}) };
  },

  saveUserSettings(userId, settingsObj) {
    const current = this.getUserSettings(userId);
    const updated = { ...current, ...settingsObj };
    dbData.settings[userId] = updated;
    debouncedSave();
    return updated;
  }
};

module.exports = Database;
