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

export const KNOWN_CONSOLES = new Set([
  'nes', 'snes', 'gb', 'gbc', 'gba', 'sega', 'genesis', 'megadrive',
  'neo', 'neogeo', 'arcade', 'pce', 'tg16', 'gg', 'sms', 'pc', 'web',
  'switch', 'psx', 'ps1', 'ps2', 'ps3', 'ps4', 'ps5', 'psp', 'vita',
  'n64', 'nds', '3ds', 'gamecube', 'wii', 'wiiu', 'xbox', 'xbox360',
  'xboxone', 'saturn', 'dreamcast', 'atari', 'amiga', 'c64', 'dos', 'vb', 'pico8'
]);

export const IGNORED_NAMES = new Set([
  'system', 'plugins', 'textures', 'game', 'ppsspp-state', 'ppsspp_state', 'ppsspp',
  'savedata', 'cheats', 'cache', 'shaders', 'bios', 'logs', 'screenshots',
  'retroarch', 'retroarch-save-files', 'saves', 'memcards', 'games'
]);

export function isIgnoredName(name) {
  if (!name) return false;
  const lower = String(name).toLowerCase().trim();
  const clean = lower.replace(/[-_.\s]+/g, '');
  if (IGNORED_NAMES.has(lower) || IGNORED_NAMES.has(clean)) return true;
  if (clean.startsWith('ppsspp') || clean.includes('savestate') || clean.includes('gamesave')) return true;
  return false;
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
    c.includes('xci') ||
    c.includes('nsp') ||
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
  // Unrecognized console slug (e.g. subfolder of PC like "takeover-2", "mortal-shell-ii-devout-edition")
  else if (!KNOWN_CONSOLES.has(c)) {
    c = 'pc';
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
        const consoleLower = String(game.console || '').toLowerCase().trim();
        const filenameLower = String(game.filename || '').toLowerCase().trim();

        // 1. Remove emulator metadata / cache folders mistakenly added as games
        if (
          isIgnoredName(consoleLower) ||
          isIgnoredName(titleLower) ||
          isIgnoredName(filenameLower)
        ) {
          delete db.games[id];
          modified = true;
          continue;
        }

        // 2. Remove errant folder container card named "switch" or "pc" under PC
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
    if (isIgnoredName(norm.title) || isIgnoredName(norm.console) || isIgnoredName(norm.filename)) {
      continue;
    }
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
    if (isIgnoredName(norm.title) || isIgnoredName(norm.console) || isIgnoredName(norm.filename)) {
      continue;
    }
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
