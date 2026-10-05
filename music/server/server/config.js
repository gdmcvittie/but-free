import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Explicitly load root .env from monorepo root, with local fallback
const rootEnv = path.resolve(__dirname, '../../../.env');
if (fs.existsSync(rootEnv)) {
  dotenv.config({ path: rootEnv });
}
dotenv.config();

/** Project root = parent of /server */
export const ROOT_DIR = path.join(__dirname, '..');

function resolveDir(envValue, fallback) {
  const raw = envValue && envValue.trim() ? envValue.trim() : fallback;
  return path.isAbsolute(raw) ? raw : path.join(ROOT_DIR, raw);
}

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

export const DATA_DIR = resolveDir(process.env.DATA_DIR || process.env.MUSIC_DATA_DIR, './data');
export const BIN_DIR = resolveDir(process.env.BIN_DIR || process.env.MUSIC_BIN_DIR, './bin');

/** Where torrents land before being uploaded to Drive. */
export const DOWNLOADS_DIR = path.join(DATA_DIR, 'downloads');
/** Offline audio cache - files kept on local disk for offline playback. */
export const OFFLINE_DIR = path.join(DATA_DIR, 'offline');
/** Extracted cover art (JPEG), served from /covers. */
export const COVERS_DIR = path.join(DATA_DIR, 'covers');
/** Database file (legacy, kept for migration / fallback). */
export const DB_FILE = path.join(DATA_DIR, 'library.json');
/** Per-user libraries directory: data/users/<userId>/{audiobooks,music,user}.json */
export const USERS_DIR = path.join(DATA_DIR, 'users');

export const config = {
  port: process.env.PORT || process.env.PORT_MUSIC || 5100,
  nodeEnv: process.env.NODE_ENV || 'development',

  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri: process.env.GOOGLE_REDIRECT_URI || process.env.GOOGLE_REDIRECT_URI_MUSIC || '',
    sessionSecret: process.env.SESSION_SECRET || 'fraudio_dev_secret_change_me'
  },

  abb: {
    baseUrl: (process.env.ABB_BASE_URL || 'https://audiobookbay.lu').replace(/\/+$/, ''),
    username: process.env.ABB_USERNAME || '',
    password: process.env.ABB_PASSWORD || ''
  },

  torrent: {
    /**
     * Remote audiobook downloader. When TORRENT_NODE_URL is set, FRAUDIO never
     * runs webtorrent locally - it dispatches the magnet and lets the node do
     * the download and the Drive upload, so audio bytes never cross the
     * network twice.
     */
    nodeUrl: (process.env.TORRENT_NODE_URL || process.env.DOWNLOADER_URL || 'http://74.208.22.119:4000').replace(/\/+$/, ''),
    nodeKey: process.env.TORRENT_NODE_KEY || process.env.DOWNLOADER_SECRET_KEY || process.env.NODE_KEY || '',
    requestTimeoutMs: num(process.env.TORRENT_NODE_TIMEOUT_MS, 20000),
    maxConcurrent: Math.max(1, num(process.env.TORRENT_MAX_CONCURRENT, 1)),
    cacheMaxBytes: num(process.env.TORRENT_CACHE_MAX_BYTES, 20 * 1024 * 1024 * 1024),
    deleteAfterUpload: bool(process.env.TORRENT_DELETE_AFTER_UPLOAD, true)
  },

  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',

  music: {
    /**
     * Netscape-format cookies.txt for your YouTube account, required for private
     * catalogs like the auto-generated Liked Music playlist (`list=LM`) and for
     * age/region-gated tracks. Users can override this per account in Settings.
     * Kept out of the Drive-backed metadata sync - paths are machine-specific.
     */
    cookiesFile: process.env.YTM_COOKIES_FILE || ''
  }
};

/** Create every runtime directory FRAUDIO needs. Safe to call repeatedly. */
export function ensureDirs() {
  for (const dir of [DATA_DIR, USERS_DIR, DOWNLOADS_DIR, OFFLINE_DIR, COVERS_DIR, BIN_DIR]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      console.error(`[Config] Could not create directory ${dir}:`, err.message);
    }
  }
}

export default config;
