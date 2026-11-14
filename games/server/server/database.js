import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'games-db.json');

let db = {
  users: {},          // userId -> { id, googleId, name, email, avatar, tokens, gamesFolderId, gamesFolderName, settings }
  games: {},          // gameId -> { id, userId, driveId, filename, title, console, size, sizeFormatted, isFavorite, coverUrl, addedAt }
  favorites: {},      // userId -> Set<gameId> (saved as array)
  recentlyPlayed: {}  // userId -> { gameId: lastPlayedAt } (capped at RECENT_PLAY_LIMIT)
};

// The "Recently played" menu tracks a play *history*: last N games, newest first.
const RECENT_PLAY_LIMIT = 50;

function ensureDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  } catch (err) {
    console.warn('[Database] Could not create data dir:', err.message);
  }
}

export function normalizeGameRecord(game) {
  if (!game) return game;
  let rec = { ...game };
  let c = String(rec.console || '').toLowerCase().trim();

  // 1. Check ID for console tag (e.g. gm_switch_..., gm_ps2_..., gm_psp_..., gm_psx_..., gmpc_...)
  const idStr = String(rec.id || '');
  if (idStr.startsWith('gm_switch_') || idStr.includes('_switch_')) c = 'switch';
  else if (idStr.startsWith('gm_ps2_') || idStr.includes('_ps2_')) c = 'ps2';
  else if (idStr.startsWith('gm_psp_') || idStr.includes('_psp_')) c = 'psp';
  else if (idStr.startsWith('gm_psx_') || idStr.includes('_psx_')) c = 'psx';
  else if (idStr.startsWith('gmpc_') || idStr.startsWith('gm_pc_') || idStr.includes('_pc_')) c = 'pc';

  // 2. Check title, filename, originalFilename, and files array
  const filename = String(rec.filename || rec.originalFilename || '');
  const title = String(rec.title || '');
  const filesList = Array.isArray(rec.files) ? rec.files.map(f => f.name || '').join(' ') : '';
  const allText = `${title} ${filename} ${filesList}`.toLowerCase();

  // Switch check: if filename/title or any file has Switch extension or keyword
  if (
    c === 'switch' ||
    /\.(nsp|nsz|xci|xcz)\b/i.test(allText) ||
    /\b(switch|nintendo\s*switch|nsw)\b/i.test(allText) ||
    title.toLowerCase().trim() === 'switch' ||
    filename.toLowerCase().trim() === 'switch'
  ) {
    c = 'switch';
  }
  // PSP check
  else if (
    c === 'psp' ||
    /\.(cso|pbp)\b/i.test(allText) ||
    /\b(psp|playstation\s*portable)\b/i.test(allText) ||
    /(ulus|ules|ucus|uces|uljs|uljm|ucjs|npeg|npug|npuh|npez|npuz)[-_\s]?\d{4,5}/i.test(allText)
  ) {
    c = 'psp';
  }
  // PS2 check: any Sony ISO > 700MB, or with GB size, or with PS2 serial code
  else if (
    c === 'ps2' ||
    /\b(ps\s*2|playstation\s*2)\b/i.test(allText) ||
    /(slus|sles|scus|sces|slpm|slps|scaj|scka)[-_\s]?\d{4,5}/i.test(allText) ||
    ((c === 'psx' || c === 'ps1' || c === 'playstation' || c === 'pc' || !c) && (
      filename.toLowerCase().endsWith('.iso') ||
      String(rec.sizeFormatted || '').includes('GB') ||
      (rec.size && Number(rec.size) > 700 * 1024 * 1024)
    ))
  ) {
    c = 'ps2';
  }

  rec.console = c;
  rec.isPcGame = c === 'pc';

  // Systems not supported by in-browser emulator cores are download-only
  const downloadOnlySystems = new Set([
    'switch', 'ps2', 'psp', 'ps3', 'ps4', 'ps5', 'vita', 'pc',
    'gamecube', 'wii', 'wiiu', '3ds', 'xbox', 'xbox360', 'xboxone'
  ]);
  if (downloadOnlySystems.has(c)) {
    rec.isDownloadOnly = true;
  }

  // Ensure coverUrl fallback if null or missing or broken string
  if (!rec.coverUrl || rec.coverUrl === 'null' || rec.coverUrl === 'undefined') {
    rec.coverUrl = `/api/games/cover?title=${encodeURIComponent(rec.title || 'Game')}&console=${encodeURIComponent(rec.console || '')}`;
  }

  return rec;
}

export function loadDatabase() {
  ensureDir();
  if (fs.existsSync(DB_FILE)) {
    try {
      const raw = fs.readFileSync(DB_FILE, 'utf-8').replace(/^\uFEFF/, '');
      const data = JSON.parse(raw);
      db = {
        users: data.users || {},
        games: data.games || {},
        favorites: data.favorites || {},
        recentlyPlayed: data.recentlyPlayed || {}
      };

      let modified = false;
      for (const [id, game] of Object.entries(db.games || {})) {
        const titleLower = String(game.title || '').toLowerCase().trim();
        // Remove errant folder container card named "switch" or "pc" under PC
        if (['switch', 'pc', 'ps2', 'psp', 'psx'].includes(titleLower) && game.isFolder && (game.isPcGame || game.console === 'pc')) {
          delete db.games[id];
          modified = true;
          continue;
        }

        const norm = normalizeGameRecord(game);
        if (
          norm.console !== game.console ||
          norm.isDownloadOnly !== game.isDownloadOnly ||
          norm.isPcGame !== game.isPcGame ||
          norm.coverUrl !== game.coverUrl
        ) {
          db.games[id] = norm;
          modified = true;
        }
      }
      if (modified) {
        saveDatabase();
      }
    } catch (err) {
      console.warn('[Database] Error parsing games-db.json, starting fresh:', err.message);
    }
  } else {
    saveDatabase();
  }
}

export function saveDatabase() {
  ensureDir();
  try {
    const tempFile = `${DB_FILE}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(db, null, 2), 'utf-8');
    fs.renameSync(tempFile, DB_FILE);
  } catch (err) {
    console.error('[Database] Failed to write database:', err.message);
  }
}

// User operations
export function getUser(userId) {
  return db.users[userId] || null;
}

export function getUserByGoogleId(googleId) {
  return Object.values(db.users).find((u) => u.googleId === googleId) || null;
}

export function getAllUsers() {
  return Object.values(db.users);
}

export function upsertUser(profile, tokens) {
  const googleId = profile.id || profile.sub;
  let user = getUserByGoogleId(googleId);

  if (!user) {
    const userId = `usr_${googleId}`;
    user = {
      id: userId,
      googleId,
      email: profile.email || '',
      name: profile.name || 'Google User',
      avatar: profile.picture || profile.avatar || '',
      gamesFolderId: null,
      gamesFolderName: null,
      tokens: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expiry_date: tokens.expiry_date
      },
      settings: {
        autoScan: true,
        organizeByConsole: true
      },
      createdAt: Date.now()
    };
  } else {
    user.name = profile.name || user.name;
    user.avatar = profile.picture || user.avatar;
    user.email = profile.email || user.email;
    if (tokens.access_token) user.tokens.access_token = tokens.access_token;
    if (tokens.refresh_token) user.tokens.refresh_token = tokens.refresh_token;
    if (tokens.expiry_date) user.tokens.expiry_date = tokens.expiry_date;
  }

  db.users[user.id] = user;
  saveDatabase();
  return user;
}

export function updateUserTokens(userId, tokens) {
  const user = db.users[userId];
  if (user) {
    user.tokens = { ...user.tokens, ...tokens };
    saveDatabase();
  }
}

export function updateUserFolder(userId, folderId, folderName) {
  const user = db.users[userId];
  if (user) {
    user.gamesFolderId = folderId;
    user.gamesFolderName = folderName;
    saveDatabase();
  }
}

export function updateUserSettings(userId, settings) {
  const user = db.users[userId];
  if (user) {
    user.settings = { ...(user.settings || {}), ...settings };
    saveDatabase();
  }
}

// Store-linked accounts (itch.io API key, GOG tokens) - kept per user
export function updateUserIntegrations(userId, integrationsPatch) {
  const user = db.users[userId];
  if (!user) return null;
  user.integrations = { ...(user.integrations || {}) };
  for (const [key, value] of Object.entries(integrationsPatch || {})) {
    if (value === null || value === undefined) {
      delete user.integrations[key];
    } else {
      user.integrations[key] = value;
    }
  }
  saveDatabase();
  return user.integrations;
}

export function upsertGame(gameRecord) {
  db.games[gameRecord.id] = { ...gameRecord };
  saveDatabase();
  return db.games[gameRecord.id];
}

export function removeGame(userId, gameId) {
  const game = db.games[gameId];
  if (!game || game.userId !== userId) return false;
  delete db.games[gameId];
  if (db.favorites[userId]) {
    db.favorites[userId] = db.favorites[userId].filter(id => id !== gameId);
  }
  saveDatabase();
  return true;
}

// Games operations
export function getGames(userId) {
  const userGames = Object.values(db.games).filter((g) => g.userId === userId);
  const userFavs = new Set(db.favorites[userId] || []);
  const results = [];

  for (const g of userGames) {
    const norm = normalizeGameRecord(g);
    const titleLower = String(norm.title || '').toLowerCase().trim();
    // Exclude folder containers that are literally named after a console
    if (['switch', 'pc', 'ps2', 'psp', 'psx'].includes(titleLower) && norm.isFolder && (!norm.files || norm.files.length === 0 || norm.isPcGame)) {
      continue;
    }
    results.push({
      ...norm,
      isFavorite: userFavs.has(norm.id)
    });
  }

  return results;
}

export function getGame(gameId) {
  return db.games[gameId] || null;
}

export function saveGames(userId, gameList, source = 'drive') {
  // Clear previous scans of this SAME source only (keeps web bookmarks etc.)
  for (const [id, game] of Object.entries(db.games)) {
    if (game.userId === userId && (game.source || 'drive') === source) {
      delete db.games[id];
    }
  }

  for (const game of gameList) {
    const norm = normalizeGameRecord(game);
    const titleLower = String(norm.title || '').toLowerCase().trim();
    // Do not save a card that is literally a console folder container under PC
    if (['switch', 'pc', 'ps2', 'psp', 'psx'].includes(titleLower) && norm.isFolder && (norm.isPcGame || norm.console === 'pc')) {
      continue;
    }
    db.games[norm.id] = {
      ...norm,
      source,
      userId
    };
  }
  saveDatabase();
}

export function toggleFavorite(userId, gameId) {
  if (!db.favorites[userId]) {
    db.favorites[userId] = [];
  }

  const set = new Set(db.favorites[userId]);
  let isFav = false;
  if (set.has(gameId)) {
    set.delete(gameId);
    isFav = false;
  } else {
    set.add(gameId);
    isFav = true;
  }

  db.favorites[userId] = Array.from(set);
  saveDatabase();
  return isFav;
}

export function getFavorites(userId) {
  return db.favorites[userId] || [];
}

export function setFavorites(userId, list) {
  db.favorites[userId] = Array.isArray(list) ? Array.from(new Set(list)) : [];
  saveDatabase();
}

// Recently played (per-user play history, newest first, capped)
export function markGamePlayed(userId, gameId) {
  if (!db.recentlyPlayed[userId]) db.recentlyPlayed[userId] = {};
  const history = db.recentlyPlayed[userId];
  history[gameId] = Date.now();

  // Prune to the newest RECENT_PLAY_LIMIT entries so the map never grows.
  const entries = Object.entries(history).sort((a, b) => b[1] - a[1]);
  if (entries.length > RECENT_PLAY_LIMIT) {
    db.recentlyPlayed[userId] = Object.fromEntries(entries.slice(0, RECENT_PLAY_LIMIT));
  }

  saveDatabase();
  return db.recentlyPlayed[userId][gameId];
}

export function getRecentlyPlayed(userId) {
  const history = db.recentlyPlayed[userId] || {};
  return Object.entries(history)
    .map(([gameId, playedAt]) => ({ gameId, playedAt }))
    .sort((a, b) => b.playedAt - a.playedAt)
    .slice(0, RECENT_PLAY_LIMIT);
}

// Initial boot load
loadDatabase();
