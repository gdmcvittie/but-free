import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'games-db.json');

let db = {
  users: {},     // userId -> { id, googleId, name, email, avatar, tokens, gamesFolderId, gamesFolderName, settings }
  games: {},     // gameId -> { id, userId, driveId, filename, title, console, size, sizeFormatted, isFavorite, coverUrl, addedAt }
  favorites: {}  // userId -> Set<gameId> (saved as array)
};

function ensureDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  } catch (err) {
    console.warn('[Database] Could not create data dir:', err.message);
  }
}

export function loadDatabase() {
  ensureDir();
  if (fs.existsSync(DB_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
      db = {
        users: data.users || {},
        games: data.games || {},
        favorites: data.favorites || {}
      };
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

// Games operations
export function getGames(userId) {
  const userGames = Object.values(db.games).filter((g) => g.userId === userId);
  const userFavs = new Set(db.favorites[userId] || []);
  return userGames.map((g) => ({
    ...g,
    isFavorite: userFavs.has(g.id)
  }));
}

export function getGame(gameId) {
  return db.games[gameId] || null;
}

export function saveGames(userId, gameList) {
  // Clear previous games for this user and replace with fresh scan
  for (const [id, game] of Object.entries(db.games)) {
    if (game.userId === userId) {
      delete db.games[id];
    }
  }

  for (const game of gameList) {
    db.games[game.id] = {
      ...game,
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

// Initial boot load
loadDatabase();
