import { GoogleAuth } from './googleAuth.js';
import * as Database from './database.js';

// Consoles with browser-based WASM emulator cores
export const SUPPORTED_EMULATOR_CONSOLES = new Set([
  'snes', 'nes', 'gba', 'gb', 'gbc', 'sega', 'genesis', 'megadrive',
  'gg', 'gamegear', 'sms', 'mastersystem', 'pce', 'tg16',
  'neo', 'neogeo', 'arcade', 'pico8',
  'psx', 'ps1', 'playstation', 'n64', 'nds', 'ds', 'saturn', 'vb'
]);

// Console detection rules by file extension
const EXTENSION_CONSOLE_MAP = {
  // Nintendo
  sfc: 'snes',
  smc: 'snes',
  snes: 'snes',
  nes: 'nes',
  gba: 'gba',
  gb: 'gb',
  gbc: 'gbc',
  n64: 'n64',
  z64: 'n64',
  v64: 'n64',
  nds: 'nds',
  '3ds': '3ds',
  cia: '3ds',
  cxi: '3ds',
  gcm: 'gamecube',
  rvz: 'gamecube',
  wbfs: 'wii',
  wad: 'wii',
  wud: 'wiiu',
  wux: 'wiiu',
  rpx: 'wiiu',
  wua: 'wiiu',
  nsp: 'switch',
  xci: 'switch',
  nsz: 'switch',
  xcz: 'switch',
  vb: 'vb',
  // Sega
  md: 'sega',
  gen: 'sega',
  smd: 'sega',
  gg: 'gg',
  sms: 'sms',
  cdi: 'dreamcast',
  gdi: 'dreamcast',
  // Sony
  iso: 'psx',
  cue: 'psx',
  chd: 'psx',
  pbp: 'psx',
  cso: 'psp',
  vpk: 'vita',
  pkg: 'ps3',
  rap: 'ps3',
  // NEC / SNK / Other
  pce: 'pce',
  p8: 'pico8',
  // PC / archive parts (classified as pc unless a console folder hint wins)
  exe: 'pc',
  msi: 'pc',
  bat: 'pc',
  '7z': 'pc',
  rar: 'pc',
  zip: 'snes', // legacy fallback or detected from subfolder
  bin: 'sega' // detected from folder context for PC installers / disc images
};

// Folder-name variants -> console key (used for subfolder hints at any depth)
const FOLDER_CONSOLE_HINTS = [
  { names: ['snes', 'super nintendo', 'super famicom', 'sfc'], console: 'snes' },
  { names: ['nes', 'famicom'], console: 'nes' },
  { names: ['gba', 'game boy advance', 'gameboy advance'], console: 'gba' },
  { names: ['gbc', 'game boy color', 'gameboy color'], console: 'gbc' },
  { names: ['gb', 'game boy', 'gameboy', 'game gear boy'], console: 'gb' },
  { names: ['genesis', 'sega', 'mega drive', 'megadrive'], console: 'sega' },
  { names: ['psx', 'ps1', 'playstation', 'playstation 1', 'ps one'], console: 'psx' },
  { names: ['ps2', 'playstation 2', 'playstation2'], console: 'ps2' },
  { names: ['ps3', 'playstation 3', 'playstation3'], console: 'ps3' },
  { names: ['ps4', 'playstation 4', 'playstation4'], console: 'ps4' },
  { names: ['ps5', 'playstation 5', 'playstation5'], console: 'ps5' },
  { names: ['psp', 'playstation portable'], console: 'psp' },
  { names: ['vita', 'ps vita', 'psvita', 'playstation vita'], console: 'vita' },
  { names: ['n64', 'nintendo 64'], console: 'n64' },
  { names: ['gamecube', 'game cube', 'ngc', 'gc'], console: 'gamecube' },
  { names: ['wii'], console: 'wii' },
  { names: ['wiiu', 'wii u'], console: 'wiiu' },
  { names: ['switch', 'nintendo switch', 'nsw', 'nx'], console: 'switch' },
  { names: ['nds', 'ds', 'nintendo ds'], console: 'nds' },
  { names: ['3ds', 'nintendo 3ds', 'n3ds'], console: '3ds' },
  { names: ['saturn', 'sega saturn'], console: 'saturn' },
  { names: ['dreamcast', 'sega dreamcast', 'dc'], console: 'dreamcast' },
  { names: ['xbox', 'original xbox', 'xbox classic'], console: 'xbox' },
  { names: ['xbox 360', 'xbox360', 'x360'], console: 'xbox360' },
  { names: ['xbox one', 'xboxone', 'xone'], console: 'xboxone' },
  { names: ['pce', 'pc engine', 'turbografx', 'turbografx-16', 'tg16'], console: 'pce' },
  { names: ['gg', 'game gear'], console: 'gg' },
  { names: ['sms', 'master system'], console: 'sms' },
  { names: ['neo', 'neogeo', 'neo geo'], console: 'neo' },
  { names: ['arcade', 'mame', 'fba', 'fbneo'], console: 'arcade' },
  { names: ['pico8', 'pico-8', 'pico'], console: 'pico8' },
  { names: ['atari', 'atari 2600', 'atari 5200', 'atari 7800', 'atari lynx', 'lynx', '2600', '7800'], console: 'atari' },
  { names: ['amiga', 'commodore amiga'], console: 'amiga' },
  { names: ['c64', 'commodore 64'], console: 'c64' },
  { names: ['dos', 'ms-dos', 'msdos'], console: 'dos' },
  { names: ['vb', 'virtual boy', 'virtualboy'], console: 'vb' },
  { names: ['pc', 'pc games', 'windows', 'gog', 'gog.com', 'epic', 'epic games', 'itch', 'itch.io'], console: 'pc' }
];

// File extensions that mark a Drive folder as a PC game installation
const PC_FILE_EXTS = new Set(['exe', 'msi', 'bat', '7z', 'rar', 'zip', 'bin', 'iso', 'img', '001', 'dat']);

const IGNORED_FILE_EXTS = new Set(['txt', 'nfo', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'html', 'pdf', 'url', 'srm', 'cfg', 'ini', 'md5', 'sha1', 'sfv', 'doc', 'docx', 'log', 'state']);

const IGNORED_FOLDER_NAMES = new Set(['posters', 'save_states', 'savestates', 'game_saves', '.git', 'node_modules', 'temp', 'tmp']);

// Map console names to Libretro thumbnail repository names
const LIBRETRO_SYSTEM_NAMES = {
  snes: 'Nintendo - Super Nintendo Entertainment System',
  nes: 'Nintendo - Nintendo Entertainment System',
  gba: 'Nintendo - Game Boy Advance',
  gb: 'Nintendo - Game Boy',
  gbc: 'Nintendo - Game Boy Color',
  sega: 'Sega - Mega Drive - Genesis',
  genesis: 'Sega - Mega Drive - Genesis',
  psx: 'Sony - PlayStation',
  ps1: 'Sony - PlayStation',
  ps2: 'Sony - PlayStation 2',
  psp: 'Sony - PlayStation Portable',
  n64: 'Nintendo - Nintendo 64',
  nds: 'Nintendo - Nintendo DS',
  '3ds': 'Nintendo - Nintendo 3DS',
  gamecube: 'Nintendo - GameCube',
  wii: 'Nintendo - Wii',
  wiiu: 'Nintendo - Wii U',
  switch: 'Nintendo - Nintendo Switch',
  pce: 'NEC - PC Engine - TurboGrafx 16',
  gg: 'Sega - Game Gear',
  sms: 'Sega - Master System - Mark III',
  saturn: 'Sega - Saturn',
  dreamcast: 'Sega - Dreamcast',
  atari: 'Atari - 2600'
};

function formatBytes(bytes) {
  if (!bytes || isNaN(bytes)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = Number(bytes);
  let unitIdx = 0;
  while (size >= 1024 && unitIdx < units.length - 1) {
    size /= 1024;
    unitIdx++;
  }
  return `${size.toFixed(unitIdx === 0 ? 0 : 1)} ${units[unitIdx]}`;
}

export function cleanGameTitle(rawName) {
  if (!rawName) return 'Unknown Game';
  // Strip extension
  let clean = rawName.replace(/\.[^/.]+$/, '').trim();
  // Strip typical scene / region tags
  clean = clean
    .replace(/\s*\((USA|Europe|Japan|En,Ja|World|Beta|Rev\s*\d+|v\d+\.\d+|Proto|Demo|Unl|Sample)[^)]*\)/gi, '')
    .replace(/\s*\[(!|b\d+|h\d+|t\d+|o\d+|p\d+|f\d+|a\d+)[^\]]*\]/gi, '')
    .replace(/\s+-\s+(USA|Europe|Japan)$/i, '')
    .trim();
  return clean || rawName;
}

export function getBoxArtUrl(title, consoleKey) {
  const systemName = LIBRETRO_SYSTEM_NAMES[consoleKey];
  if (!systemName) return null;
  // Libretro thumbnails format: replaces slashes/colons/question marks with underscores
  const sanitizedTitle = title
    .replace(/[&]/g, '_')
    .replace(/[/\\:*?"<>|]/g, '_')
    .trim();
  return `https://thumbnails.libretro.com/${encodeURIComponent(systemName)}/Named_Boxarts/${encodeURIComponent(sanitizedTitle)}.png`;
}

// ---------------------------------------------------------------------------
// Poster helpers
// Canonical layout: <games folder>/posters/<console>/<rom filename>.<img ext>
// ---------------------------------------------------------------------------

const POSTER_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp']);
const MAX_POSTER_EDGE = 512;

function fileExt(name) {
  const str = String(name || '');
  const idx = str.lastIndexOf('.');
  return idx > 0 ? str.slice(idx + 1).toLowerCase() : '';
}

// Drive rejects nothing we use, but keep names tidy and ROM-stem identical.
function sanitizeDriveName(name) {
  return String(name || '').replace(/[/\\:*?"<>|]/g, '_').trim();
}

// "Mario Kart (USA).sfc" -> "mario kart (usa)" (poster files are matched by
// this stem so .png/.jpg/.jpeg/.webp all resolve against one ROM).
function posterStem(name) {
  const str = String(name || '').trim();
  const idx = str.lastIndexOf('.');
  return (idx > 0 ? str.slice(0, idx) : str).trim().toLowerCase();
}

function indexPosterFile(map, file) {
  const stem = posterStem(file.name);
  if (!stem || !file || !file.id) return;
  if (!map.has(stem)) map.set(stem, file);
  const sanitized = sanitizeDriveName(stem).toLowerCase();
  if (sanitized && !map.has(sanitized)) map.set(sanitized, file);
}

function removeFromPosterIndex(map, file) {
  if (!map || !file) return;
  for (const [key, value] of map.entries()) {
    if (value.id === file.id) map.delete(key);
  }
}

function findPosterIn(map, keys) {
  if (!map) return null;
  for (const key of keys) {
    const hit = map.get(key);
    if (hit) return hit;
  }
  return null;
}

// Candidate keys for a ROM, most specific first (exact filename stem wins).
function posterLookupKeys(baseNoExt, cleanLower, consoleKey) {
  const keys = [];
  const push = (value) => {
    const key = String(value || '').trim().toLowerCase();
    if (!key || keys.includes(key)) return;
    keys.push(key);
    const sanitized = sanitizeDriveName(key).toLowerCase();
    if (sanitized && !keys.includes(sanitized)) keys.push(sanitized);
  };
  push(baseNoExt);
  push(cleanLower);
  push(`${consoleKey}_${cleanLower}`);
  return keys;
}

// Sharp is an optional native dep (same as comics/server): if it is missing or
// broken the poster is still uploaded, just without the 512px downscale.
let _sharp;
let _sharpTried = false;
async function getSharp() {
  if (_sharpTried) return _sharp;
  _sharpTried = true;
  try {
    const mod = await import('sharp');
    _sharp = mod.default || mod;
  } catch (err) {
    console.warn('[GoogleDrive] sharp unavailable, posters will not be resized:', err.message);
    _sharp = null;
  }
  return _sharp;
}

/** Fit inside a 512x512 box (never enlarged), keeping the source format. */
async function processPosterBuffer(buffer, sourceMime) {
  const mime = String(sourceMime || '').split(';')[0].trim().toLowerCase();
  const ext = mime.includes('jpeg') ? 'jpg' : mime.includes('webp') ? 'webp' : 'png';
  const outMime = ext === 'jpg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';

  const sharp = await getSharp();
  if (!sharp) return { buffer, ext, mime: outMime, resized: false };

  try {
    let pipeline = sharp(buffer, { failOn: 'none', animated: false }).resize({
      width: MAX_POSTER_EDGE,
      height: MAX_POSTER_EDGE,
      fit: 'inside',
      withoutEnlargement: true
    });
    if (ext === 'jpg') pipeline = pipeline.jpeg({ quality: 85, mozjpeg: true });
    else if (ext === 'webp') pipeline = pipeline.webp({ quality: 85 });
    else pipeline = pipeline.png({ compressionLevel: 9 });

    const out = await pipeline.toBuffer();
    return { buffer: out, ext, mime: outMime, resized: true };
  } catch (err) {
    console.warn('[GoogleDrive] Poster resize failed:', err.message);
    return { buffer, ext, mime: outMime, resized: false };
  }
}

export const GoogleDrive = {
  async listFolders(user, parentId = 'root') {
    const accessToken = await GoogleAuth.getValidAccessToken(user);
    const query = `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.set('q', query);
    url.searchParams.set('fields', 'files(id, name, mimeType, modifiedTime)');
    url.searchParams.set('orderBy', 'name');
    url.searchParams.set('pageSize', '100');

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error?.message || 'Failed to list folders');
    }
    return data.files || [];
  },

  async createFolder(user, folderName, parentId = 'root') {
    const accessToken = await GoogleAuth.getValidAccessToken(user);
    const res = await fetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId]
      })
    });

    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error?.message || 'Failed to create folder');
    }
    return data;
  },

  async findFileByName(user, parentId, fileName) {
    const accessToken = await GoogleAuth.getValidAccessToken(user);
    const safeName = (fileName || '').replace(/'/g, "\\'");
    const q = `'${parentId}' in parents and name = '${safeName}' and trashed = false`;
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.set('q', q);
    url.searchParams.set('fields', 'files(id, name, mimeType, size)');
    url.searchParams.set('pageSize', '1');

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const data = await res.json();
    return (data.files && data.files[0]) || null;
  },

  async findOrCreateFolder(user, folderName, parentId = 'root') {
    const accessToken = await GoogleAuth.getValidAccessToken(user);
    const safeName = (folderName || '').replace(/'/g, "\\'");
    const q = `'${parentId}' in parents and name = '${safeName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.set('q', q);
    url.searchParams.set('fields', 'files(id, name)');
    url.searchParams.set('pageSize', '1');

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const data = await res.json();
    if (data.files && data.files.length > 0) {
      return data.files[0];
    }
    return await this.createFolder(user, folderName, parentId);
  },

  async uploadBufferToDrive(user, buffer, fileName, mimeType = 'application/octet-stream', parentId) {
    if (!parentId) return null;
    const accessToken = await GoogleAuth.getValidAccessToken(user);

    // Check if file already exists in folder to update rather than duplicate
    const existing = await this.findFileByName(user, parentId, fileName);
    if (existing) {
      const patchUrl = `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=media&fields=id,name,size`;
      const res = await fetch(patchUrl, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': mimeType
        },
        body: buffer
      });
      if (!res.ok) return null;
      return await res.json();
    }

    // Multipart create
    const uploadUrl = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size';
    const boundary = `freeplay_${Date.now()}_${Math.random().toString(36).substring(2)}`;
    const metadata = { name: fileName, parents: [parentId], mimeType };

    const delimiter = `\r\n--${boundary}\r\n`;
    const closeDelimiter = `\r\n--${boundary}--`;

    const multipartBody = Buffer.concat([
      Buffer.from(delimiter + 'Content-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(metadata) + delimiter + `Content-Type: ${mimeType}\r\n\r\n`),
      buffer,
      Buffer.from(closeDelimiter)
    ]);

    const res = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
        'Content-Length': String(multipartBody.length)
      },
      body: multipartBody
    });

    if (!res.ok) return null;
    return await res.json();
  },

  getUserPrefix(user) {
    const email = (user?.email || '').trim();
    let prefix = '';
    if (email && email.includes('@')) {
      prefix = email.split('@')[0].trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
    }
    if (!prefix && user?.id) {
      prefix = String(user.id).trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
    }
    return prefix || 'user';
  },

  getUserMetaFilename(user, baseName) {
    const prefix = this.getUserPrefix(user);
    return `${prefix}-${baseName}`;
  },

  async writeJsonFile(user, folderId, fileName, payload) {
    if (!folderId) return null;
    const buffer = Buffer.from(JSON.stringify(payload, null, 2), 'utf-8');
    return await this.uploadBufferToDrive(user, buffer, fileName, 'application/json', folderId);
  },

  async readJsonFile(user, fileId) {
    const accessToken = await GoogleAuth.getValidAccessToken(user);
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!res.ok) return null;
    try {
      return await res.json();
    } catch {
      return null;
    }
  },

  async deleteFile(user, fileId) {
    const accessToken = await GoogleAuth.getValidAccessToken(user);
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}`;
    await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    return true;
  },

  /** Move (and optionally rename) a file into another folder in place. */
  async moveFile(user, fileId, { newParentId, oldParentId, newName }) {
    if (!newParentId) return null;
    const accessToken = await GoogleAuth.getValidAccessToken(user);
    const url = new URL(`https://www.googleapis.com/drive/v3/files/${fileId}`);
    url.searchParams.set('addParents', newParentId);
    if (oldParentId && oldParentId !== newParentId) url.searchParams.set('removeParents', oldParentId);
    url.searchParams.set('fields', 'id,name,parents');

    const res = await fetch(url.toString(), {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(newName ? { name: newName } : {})
    });
    if (!res.ok) return null;
    return await res.json();
  },

  /** Upload or update a game's poster in <root>/posters/<console>/<gameStem>.<ext>. */
  async uploadGamePoster(user, consoleKey, gameStem, imageUrl) {
    if (!user || !user.gamesFolderId || !imageUrl || !gameStem) return null;

    let targetUrl = String(imageUrl).trim();
    if (!targetUrl) return null;

    if (targetUrl.startsWith('/api/proxy-image')) {
      try {
        const parsed = new URL(targetUrl, 'http://localhost');
        const unproxied = parsed.searchParams.get('url');
        if (unproxied) targetUrl = unproxied;
      } catch (_) {}
    }

    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      return null;
    }

    try {
      const postersFolder = await this.findOrCreateFolder(user, 'posters', user.gamesFolderId);
      if (!postersFolder) return null;

      const key = String(consoleKey || 'pc').toLowerCase().trim();
      const consoleFolder = await this.findOrCreateFolder(user, key, postersFolder.id);
      if (!consoleFolder) return null;

      const res = await fetch(targetUrl, {
        signal: AbortSignal.timeout(10000),
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': targetUrl.includes('itch') ? 'https://itch.io/' : 'https://www.google.com/'
        }
      });
      if (!res.ok) return null;

      const rawBuf = Buffer.from(await res.arrayBuffer());
      if (rawBuf.length < 100) return null;

      const processed = await processPosterBuffer(rawBuf, res.headers.get('content-type'));
      const cleanStem = sanitizeDriveName(gameStem);
      const posterName = `${cleanStem}.${processed.ext}`;

      const uploaded = await this.uploadBufferToDrive(
        user,
        processed.buffer,
        posterName,
        processed.mime,
        consoleFolder.id
      );

      return uploaded;
    } catch (err) {
      console.warn(`[GoogleDrive] uploadGamePoster failed for "${gameStem}" (${consoleKey}):`, err.message);
      return null;
    }
  },

  async scanGamesFolder(user) {
    if (!user.gamesFolderId) {
      throw new Error('No Games folder selected. Please select a Google Drive folder first.');
    }

    const accessToken = await GoogleAuth.getValidAccessToken(user);

    const driveQueryFiles = async (queryString, extraFields = 'id,name,size,mimeType,modifiedTime,parents') => {
      const results = [];
      let pageToken = null;
      do {
        const url = new URL('https://www.googleapis.com/drive/v3/files');
        url.searchParams.set('q', queryString);
        url.searchParams.set('fields', `nextPageToken, files(${extraFields})`);
        url.searchParams.set('pageSize', '250');
        if (pageToken) url.searchParams.set('pageToken', pageToken);

        const res = await fetch(url.toString(), {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const data = await res.json();
        if (data.files) results.push(...data.files);
        pageToken = data.nextPageToken;
      } while (pageToken);
      return results;
    };

    const folderHint = (name) => {
      const lower = (name || '').toLowerCase().trim();
      for (const entry of FOLDER_CONSOLE_HINTS) {
        if (entry.names.includes(lower)) return entry.console;
      }
      if (lower.includes('switch') || lower.includes('nintendo switch')) return 'switch';
      if (lower.includes('ps2') || lower.includes('playstation 2')) return 'ps2';
      if (lower.includes('ps3') || lower.includes('playstation 3')) return 'ps3';
      if (lower.includes('ps4') || lower.includes('playstation 4')) return 'ps4';
      if (lower.includes('ps5') || lower.includes('playstation 5')) return 'ps5';
      if (lower.includes('psp') || lower.includes('playstation portable')) return 'psp';
      if (lower.includes('vita')) return 'vita';
      if (lower.includes('gamecube') || lower.includes('game cube')) return 'gamecube';
      if (lower === 'wii' || lower.startsWith('wii ') || lower.endsWith(' wii')) return 'wii';
      if (lower.includes('wii u') || lower.includes('wiiu')) return 'wiiu';
      if (lower.includes('3ds')) return '3ds';
      if (lower.includes('snes') || lower.includes('super nintendo')) return 'snes';
      if (lower.includes('gba') || lower.includes('game boy advance')) return 'gba';
      if (lower.includes('gbc') || lower.includes('game boy color')) return 'gbc';
      if (lower.includes('game boy') || lower === 'gb') return 'gb';
      if (lower.includes('genesis') || lower.includes('sega') || lower.includes('mega drive')) return 'sega';
      if (lower.includes('psx') || lower.includes('ps1') || lower.includes('playstation')) return 'psx';
      if (lower.includes('n64') || lower.includes('nintendo 64')) return 'n64';
      if (lower.includes('nes') || lower.includes('famicom')) return 'nes';
      if (lower.includes('nds') || lower.includes('nintendo ds')) return 'nds';
      if (lower.includes('pico')) return 'pico8';
      if (lower.includes('dreamcast')) return 'dreamcast';
      if (lower.includes('saturn')) return 'saturn';
      if (lower.includes('xbox 360') || lower.includes('xbox360') || lower.includes('x360')) return 'xbox360';
      if (lower.includes('xbox')) return 'xbox';
      if (lower.includes('atari')) return 'atari';
      if (lower.includes('amiga')) return 'amiga';
      if (lower.includes('c64') || lower.includes('commodore')) return 'c64';
      if (lower === 'pc games' || lower === 'pc' || lower.includes('gog') || lower.includes('itch') || lower.includes('windows')) return 'pc';
      return null;
    };

    // 0. Poster folders ----------------------------------------------------
    // Canonical layout: <root>/posters/<console>/<rom filename>.<img ext>.
    // Legacy layouts are still read and migrated into the canonical folder:
    //   • flat files directly in <root>/posters
    //   • a 'posters' folder inside the ROM's own folder
    //   • image files sitting next to the ROM
    let postersFolder = null;
    const postersFolderByConsole = new Map(); // lowercased console key -> <root>/posters/<console>
    const posterIndexByFolder = new Map();    // folderId -> Map(stem key -> drive file)
    const posterFoldersByParent = new Map();  // folderId -> legacy 'posters' folder inside it
    const looseImagesByParent = new Map();    // folderId -> Map(stem key -> image beside ROMs)

    try {
      postersFolder = await this.findOrCreateFolder(user, 'posters', user.gamesFolderId);
      const existingPosters = await driveQueryFiles(
        `'${postersFolder.id}' in parents and trashed = false`,
        'id,name,mimeType,parents'
      );
      const rootIndex = new Map();
      for (const p of existingPosters) {
        if (p.mimeType === 'application/vnd.google-apps.folder') {
          postersFolderByConsole.set((p.name || '').toLowerCase().trim(), p);
        } else if (POSTER_IMAGE_EXTS.has(fileExt(p.name))) {
          indexPosterFile(rootIndex, p);
        }
      }
      posterIndexByFolder.set(postersFolder.id, rootIndex);
      // ROMs sitting directly in the games folder already have this as legacy source.
      posterFoldersByParent.set(user.gamesFolderId, postersFolder);
    } catch (postersErr) {
      console.warn('[GoogleDrive] Could not access posters folder:', postersErr.message);
    }

    const getPosterIndex = async (folderId) => {
      if (posterIndexByFolder.has(folderId)) return posterIndexByFolder.get(folderId);
      const map = new Map();
      posterIndexByFolder.set(folderId, map);
      try {
        const files = await driveQueryFiles(
          `'${folderId}' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false`,
          'id,name,mimeType,parents'
        );
        for (const f of files) {
          if (POSTER_IMAGE_EXTS.has(fileExt(f.name))) indexPosterFile(map, f);
        }
      } catch (err) {
        console.warn('[GoogleDrive] Could not index posters folder:', err.message);
      }
      return map;
    };

    const findLegacyPostersFolder = async (parentId) => {
      if (posterFoldersByParent.has(parentId)) return posterFoldersByParent.get(parentId);
      let folder = null;
      try {
        const matches = await driveQueryFiles(
          `'${parentId}' in parents and name = 'posters' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
          'id,name,parents'
        );
        folder = matches[0] || null;
      } catch (err) {
        console.warn('[GoogleDrive] Could not look up posters folder:', err.message);
      }
      posterFoldersByParent.set(parentId, folder);
      return folder;
    };

    const ensureConsolePostersFolder = async (consoleKey) => {
      if (!postersFolder) return null;
      const key = String(consoleKey || '').toLowerCase().trim();
      if (!key) return null;
      const existing = postersFolderByConsole.get(key);
      if (existing) return existing;
      try {
        const folder = await this.findOrCreateFolder(user, key, postersFolder.id);
        postersFolderByConsole.set(key, folder);
        return folder;
      } catch (err) {
        console.warn('[GoogleDrive] Could not create console posters folder:', err.message);
        return null;
      }
    };

    // 0b. Read favorites from Drive (user-specific first, with legacy fallback)
    try {
      const userFavFilename = this.getUserMetaFilename(user, 'favorites.json');
      const userFavesFilename = this.getUserMetaFilename(user, 'faves.json');
      const favFile = (await this.findFileByName(user, user.gamesFolderId, userFavFilename))
                   || (await this.findFileByName(user, user.gamesFolderId, userFavesFilename))
                   || (await this.findFileByName(user, user.gamesFolderId, 'favorites.json'))
                   || (await this.findFileByName(user, user.gamesFolderId, 'faves.json'));
      if (favFile) {
        const favData = await this.readJsonFile(user, favFile.id);
        if (favData && Array.isArray(favData.favorites)) {
          Database.setFavorites(user.id, favData.favorites);
        }
      }
    } catch (favErr) {
      console.warn('[GoogleDrive] Could not sync favorites from Drive:', favErr.message);
    }

    // 1. Enumerate the folder tree (Games root -> level 1 -> level 2)
    const rawLevel1Folders = await driveQueryFiles(
      `'${user.gamesFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      'id,name'
    );
    const level1Folders = [];
    for (const f of rawLevel1Folders) {
      const lower = (f.name || '').toLowerCase().trim();
      // A 'posters' folder inside a console folder is a legacy poster source.
      if (lower === 'posters') {
        posterFoldersByParent.set(user.gamesFolderId, f);
        continue;
      }
      if (!IGNORED_FOLDER_NAMES.has(lower)) level1Folders.push(f);
    }

    const folderInfo = new Map(); // folderId -> { name, parentId, hint }
    folderInfo.set(user.gamesFolderId, { name: user.gamesFolderName || 'Games', parentId: null, hint: null });

    if (level1Folders.length > 0) {
      const l1Ids = level1Folders.map(f => f.id);
      const parentClause = l1Ids.map(id => `'${id}' in parents`).join(' or ');
      const rawLevel2Folders = await driveQueryFiles(
        `(${parentClause}) and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        'id,name,parents'
      );

      // Track folders that contain subfolders (definitely container folders)
      const hasSubfolders = new Set();
      for (const f of rawLevel2Folders) {
        const parentId = f.parents && f.parents.length ? f.parents[0] : null;
        if (parentId) hasSubfolders.add(parentId);
      }

      // Check level 3 folders for deeply nested collections (e.g. <console>/<game>/)
      const validL2 = rawLevel2Folders.filter(f => !IGNORED_FOLDER_NAMES.has((f.name || '').toLowerCase().trim()));
      let rawLevel3Folders = [];
      if (validL2.length > 0) {
        const l2Ids = validL2.map(f => f.id);
        const l3Clauses = [];
        for (let i = 0; i < l2Ids.length; i += 25) {
          const batch = l2Ids.slice(i, i + 25);
          l3Clauses.push(`(${batch.map(id => `'${id}' in parents`).join(' or ')})`);
        }
        for (const clause of l3Clauses) {
          const l3 = await driveQueryFiles(
            `${clause} and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
            'id,name,parents'
          );
          rawLevel3Folders.push(...l3);
        }
        for (const f of rawLevel3Folders) {
          const parentId = f.parents && f.parents.length ? f.parents[0] : null;
          if (parentId) hasSubfolders.add(parentId);
        }
      }

      for (const f of level1Folders) {
        let hint = folderHint(f.name);
        if (!hint && (hasSubfolders.has(f.id) || /(games|roms|collection|systems|emulation|library|pack)/i.test(f.name))) {
          hint = f.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'other';
        }
        folderInfo.set(f.id, { name: f.name, parentId: user.gamesFolderId, hint });
      }

      for (const f of rawLevel2Folders) {
        const parentId = f.parents && f.parents.length ? f.parents[0] : null;
        const lower = (f.name || '').toLowerCase().trim();
        if (lower === 'posters') {
          if (parentId) posterFoldersByParent.set(parentId, f);
          continue;
        }
        if (IGNORED_FOLDER_NAMES.has(lower)) continue;
        let hint = folderHint(f.name);
        if (!hint && hasSubfolders.has(f.id)) {
          hint = f.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'other';
        }
        folderInfo.set(f.id, { name: f.name, parentId, hint });
      }

      for (const f of rawLevel3Folders) {
        const parentId = f.parents && f.parents.length ? f.parents[0] : null;
        const lower = (f.name || '').toLowerCase().trim();
        if (IGNORED_FOLDER_NAMES.has(lower)) continue;
        folderInfo.set(f.id, { name: f.name, parentId, hint: folderHint(f.name) });
      }
    } else {
      for (const f of level1Folders) {
        folderInfo.set(f.id, { name: f.name, parentId: user.gamesFolderId, hint: folderHint(f.name) });
      }
    }

    // 2. Query all files under root + any folder (up to 3 levels deep)
    const allFolderIds = Array.from(folderInfo.keys()).filter(id => id !== user.gamesFolderId);
    const searchableParents = [user.gamesFolderId, ...allFolderIds];
    const fileClauses = [];
    let allFiles = [];
    for (let i = 0; i < searchableParents.length; i += 20) {
      const batch = searchableParents.slice(i, i + 20);
      fileClauses.push(`(${batch.map(id => `'${id}' in parents`).join(' or ')})`);
    }
    for (const clause of fileClauses) {
      const files = await driveQueryFiles(
        `(${clause}) and mimeType != 'application/vnd.google-apps.folder' and trashed = false`
      );
      allFiles.push(...files);
    }

    // 2b. Index images lying loose next to ROMs (never games: image extensions
    //     are ignored by detection) so they can be adopted as posters too.
    for (const file of allFiles) {
      if (!POSTER_IMAGE_EXTS.has(fileExt(file.name))) continue;
      const parentId = file.parents && file.parents.length ? file.parents[0] : user.gamesFolderId;
      if (!looseImagesByParent.has(parentId)) looseImagesByParent.set(parentId, new Map());
      indexPosterFile(looseImagesByParent.get(parentId), file);
    }

    // 3. Infer console for each file by walking the folder chain upward
    const resolveChainHint = (folderId) => {
      let current = folderId;
      const visited = new Set();
      while (current && !visited.has(current)) {
        visited.add(current);
        const info = folderInfo.get(current);
        if (!info) break;
        if (info.hint) return { hint: info.hint, hintFolderId: current };
        current = info.parentId;
      }
      return { hint: null, hintFolderId: null };
    };

    const isContainerFolder = (fId) => {
      if (!fId || fId === user.gamesFolderId) return true;
      const info = folderInfo.get(fId);
      if (!info) return true;
      const lower = (info.name || '').toLowerCase().trim();
      if (/^(pc games|pc|gog|gog\.com|epic|epic games|itch|itch\.io|retro games|roms|games|collection|systems|emulation)$/i.test(lower)) {
        return true;
      }
      for (const entry of FOLDER_CONSOLE_HINTS) {
        if (entry.names.includes(lower)) return true;
      }
      return false;
    };

    const findCoverForGame = async (stem, title, consoleKey, folderId = null) => {
      const keys = posterLookupKeys(stem.toLowerCase(), title.toLowerCase(), consoleKey);
      let coverUrl = null;
      const canonFolder = postersFolderByConsole.get(String(consoleKey || '').toLowerCase()) || null;
      if (canonFolder) {
        const canonIdx = await getPosterIndex(canonFolder.id);
        const hit = findPosterIn(canonIdx, keys);
        if (hit) coverUrl = `/api/drive/file/${hit.id}`;
      }
      if (!coverUrl && postersFolder) {
        const rootIdx = posterIndexByFolder.get(postersFolder.id);
        const hit = findPosterIn(rootIdx, keys);
        if (hit) coverUrl = `/api/drive/file/${hit.id}`;
      }
      if (!coverUrl && folderId) {
        const looseIdx = looseImagesByParent.get(folderId) || null;
        const hit = findPosterIn(looseIdx, keys);
        if (hit) coverUrl = `/api/drive/file/${hit.id}`;
      }
      if (!coverUrl && postersFolder && LIBRETRO_SYSTEM_NAMES[consoleKey]) {
        const remoteBoxArt = getBoxArtUrl(title, consoleKey);
        if (remoteBoxArt) {
          try {
            const artRes = await fetch(remoteBoxArt, { signal: AbortSignal.timeout(4000) });
            if (artRes.ok) {
              const artBuf = Buffer.from(await artRes.arrayBuffer());
              if (artBuf.length > 500) {
                const processed = await processPosterBuffer(artBuf, artRes.headers.get('content-type'));
                const destFolder = await ensureConsolePostersFolder(consoleKey);
                if (destFolder) {
                  const posterName = `${sanitizeDriveName(stem)}.${processed.ext}`;
                  const uploaded = await this.uploadBufferToDrive(
                    user,
                    processed.buffer,
                    posterName,
                    processed.mime,
                    destFolder.id
                  );
                  if (uploaded && uploaded.id) {
                    const canonicalIndex = await getPosterIndex(destFolder.id);
                    indexPosterFile(canonicalIndex, { ...uploaded, parents: [destFolder.id] });
                    coverUrl = `/api/drive/file/${uploaded.id}`;
                  }
                }
              }
            }
          } catch (_) {}
        }
      }
      return coverUrl;
    };

    const recognizedGames = [];
    const downloadGroups = new Map(); // gameFolderId -> { consoleKey, files: [] }

    for (const file of allFiles) {
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      const parentId = file.parents && file.parents.length ? file.parents[0] : user.gamesFolderId;
      const { hint } = resolveChainHint(parentId);

      if (IGNORED_FILE_EXTS.has(ext)) continue;

      let consoleKey = hint || EXTENSION_CONSOLE_MAP[ext] || null;
      if (!consoleKey) {
        if (parentId !== user.gamesFolderId) {
          const parentInfo = folderInfo.get(parentId);
          if (parentInfo) {
            consoleKey = folderHint(parentInfo.name) ||
              parentInfo.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') ||
              'pc';
          }
        }
      }
      if (!consoleKey) continue;

      const isSupportedEmulator = SUPPORTED_EMULATOR_CONSOLES.has(consoleKey) && !PC_FILE_EXTS.has(ext);

      // Legacy split-volume suffixes outside of download groups are noise
      if (isSupportedEmulator && (/\.r\d{2}$/i.test(file.name) || /\.z\d{2}$/i.test(file.name) || /\.\d{3}$/.test(file.name))) {
        continue;
      }

      if (!isSupportedEmulator) {
        // Any folder/system not supported by browser emulator (PC, Switch, PS2, PS3, GameCube, Wii, Xbox, or custom folder)
        const parentIsContainer = isContainerFolder(parentId);
        const gameFolderId = (!parentIsContainer && folderInfo.has(parentId)) ? parentId : null;

        if (gameFolderId) {
          if (!downloadGroups.has(gameFolderId)) {
            downloadGroups.set(gameFolderId, { consoleKey, files: [] });
          }
          downloadGroups.get(gameFolderId).files.push(file);
        } else {
          // Loose file directly in container or root
          const cleanTitle = cleanGameTitle(file.name);
          const coverUrl = await findCoverForGame(
            file.name.replace(/\.[^.]+$/, ''),
            cleanTitle,
            consoleKey,
            parentId !== user.gamesFolderId ? parentId : null
          );

          recognizedGames.push({
            id: `gm_${file.id}`,
            driveId: file.id,
            folderId: parentId !== user.gamesFolderId ? parentId : null,
            source: 'drive',
            filename: file.name,
            title: cleanTitle,
            console: consoleKey,
            isPcGame: consoleKey === 'pc',
            isDownloadOnly: true,
            size: Number(file.size || 0),
            sizeFormatted: formatBytes(file.size),
            coverUrl,
            addedAt: file.modifiedTime ? new Date(file.modifiedTime).getTime() : Date.now()
          });
        }
        continue;
      }

      // Supported browser emulator games (NES, SNES, GBA, etc.)
      const cleanTitle = cleanGameTitle(file.name);
      const baseNoExt = file.name.replace(/\.[^.]+$/, '').trim().toLowerCase();
      const cleanLower = cleanTitle.toLowerCase();

      const romKeys = posterLookupKeys(baseNoExt, cleanLower, consoleKey);
      let matchedPoster = null;
      let matchedMap = null;
      let foundCanonical = false;

      // 1. Canonical location: <root>/posters/<console>/<rom filename>
      const canonicalFolder = postersFolderByConsole.get(String(consoleKey).toLowerCase()) || null;
      if (canonicalFolder) {
        const canonicalIndex = await getPosterIndex(canonicalFolder.id);
        matchedPoster = findPosterIn(canonicalIndex, romKeys);
        if (matchedPoster) {
          matchedMap = canonicalIndex;
          foundCanonical = true;
        }
      }

      // 2. Legacy flat files directly in <root>/posters
      if (!matchedPoster && postersFolder) {
        const rootIndex = posterIndexByFolder.get(postersFolder.id);
        matchedPoster = findPosterIn(rootIndex, romKeys);
        if (matchedPoster) matchedMap = rootIndex;
      }

      // 3. Legacy 'posters' folder inside the ROM's own folder
      if (!matchedPoster) {
        const legacyFolder = await findLegacyPostersFolder(parentId);
        if (legacyFolder) {
          const legacyIndex = await getPosterIndex(legacyFolder.id);
          matchedPoster = findPosterIn(legacyIndex, romKeys);
          if (matchedPoster) matchedMap = legacyIndex;
        }
      }

      // 4. Image file lying loose next to the ROM
      if (!matchedPoster) {
        const looseIndex = looseImagesByParent.get(parentId) || null;
        matchedPoster = findPosterIn(looseIndex, romKeys);
        if (matchedPoster) matchedMap = looseIndex;
      }

      // Migrate any non-canonical hit into <root>/posters/<console>/, renamed
      // to the ROM's filename. The file id is unchanged, so covers keep working.
      if (matchedPoster && !foundCanonical) {
        const destFolder = await ensureConsolePostersFolder(consoleKey);
        if (destFolder) {
          const oldParentId = matchedPoster.parents && matchedPoster.parents[0];
          const newName = `${sanitizeDriveName(baseNoExt)}.${fileExt(matchedPoster.name) || 'png'}`;
          const moved = await this.moveFile(user, matchedPoster.id, {
            newParentId: destFolder.id,
            oldParentId,
            newName: oldParentId === destFolder.id && matchedPoster.name === newName ? undefined : newName
          });
          if (moved) {
            removeFromPosterIndex(matchedMap, matchedPoster);
            const canonicalIndex = await getPosterIndex(destFolder.id);
            const relocated = { ...matchedPoster, name: moved.name || newName, parents: [destFolder.id] };
            indexPosterFile(canonicalIndex, relocated);
            matchedPoster = relocated;
          } else {
            console.warn(`[GoogleDrive] Could not move poster "${matchedPoster.name}" into posters/${consoleKey}`);
          }
        }
      }

      let coverUrl = matchedPoster ? `/api/drive/file/${matchedPoster.id}` : null;

      // 5. No poster on Drive: scrape box art, cap it at 512px on the longest
      //    edge and save it as the ROM's filename in <root>/posters/<console>/
      if (!coverUrl && postersFolder) {
        const remoteBoxArt = getBoxArtUrl(cleanTitle, consoleKey);
        if (remoteBoxArt) {
          try {
            const artRes = await fetch(remoteBoxArt, { signal: AbortSignal.timeout(5000) });
            if (artRes.ok) {
              const artBuf = Buffer.from(await artRes.arrayBuffer());
              if (artBuf.length > 500) {
                const processed = await processPosterBuffer(artBuf, artRes.headers.get('content-type'));
                const destFolder = await ensureConsolePostersFolder(consoleKey);
                if (destFolder) {
                  const posterName = `${sanitizeDriveName(baseNoExt)}.${processed.ext}`;
                  const uploaded = await this.uploadBufferToDrive(
                    user,
                    processed.buffer,
                    posterName,
                    processed.mime,
                    destFolder.id
                  );
                  if (uploaded && uploaded.id) {
                    const canonicalIndex = await getPosterIndex(destFolder.id);
                    indexPosterFile(canonicalIndex, { ...uploaded, parents: [destFolder.id] });
                    coverUrl = `/api/drive/file/${uploaded.id}`;
                  }
                }
              }
            }
          } catch (_) {
            // Best-effort scrape
          }
        }
      }

      recognizedGames.push({
        id: `gm_${file.id}`,
        driveId: file.id,
        folderId: parentId !== user.gamesFolderId ? parentId : null,
        source: 'drive',
        filename: file.name,
        title: cleanTitle,
        console: consoleKey,
        isPcGame: false,
        isDownloadOnly: false,
        size: Number(file.size || 0),
        sizeFormatted: formatBytes(file.size),
        coverUrl,
        addedAt: file.modifiedTime ? new Date(file.modifiedTime).getTime() : Date.now()
      });
    }

    // 4. Collapse download-only game folders into single library entries
    for (const [gameFolderId, group] of downloadGroups.entries()) {
      const info = folderInfo.get(gameFolderId);
      const folderName = (info && info.name) || 'Game';
      const consoleKey = group.consoleKey || 'pc';

      // A folder that literally is a generic container keeps its files as individual game entries
      const isContainerName = /^(pc games|pc|gog|gog\.com|epic|epic games|itch|itch\.io|retro games|roms|games)$/i.test(folderName.trim());

      const mainFile = [...group.files].sort((a, b) => Number(b.size || 0) - Number(a.size || 0))[0];

      if (isContainerName) {
        for (const file of group.files) {
          const cleanTitle = cleanGameTitle(file.name);
          const coverUrl = await findCoverForGame(
            file.name.replace(/\.[^.]+$/, ''),
            cleanTitle,
            consoleKey,
            gameFolderId
          );

          recognizedGames.push({
            id: `gm_${file.id}`,
            driveId: file.id,
            folderId: gameFolderId,
            source: 'drive',
            filename: file.name,
            title: cleanTitle,
            console: consoleKey,
            isPcGame: consoleKey === 'pc',
            isDownloadOnly: true,
            size: Number(file.size || 0),
            sizeFormatted: formatBytes(file.size),
            coverUrl,
            addedAt: file.modifiedTime ? new Date(file.modifiedTime).getTime() : Date.now()
          });
        }
        continue;
      }

      const totalSize = group.files.reduce((sum, f) => sum + Number(f.size || 0), 0);
      const title = cleanGameTitle(folderName.replace(/\.(rar|zip|7z)$/i, ''));
      const coverUrl = await findCoverForGame(
        folderName.replace(/\.(rar|zip|7z)$/i, ''),
        title,
        consoleKey,
        gameFolderId
      );

      recognizedGames.push({
        id: consoleKey === 'pc' ? `gmpc_${gameFolderId}` : `gm_${consoleKey}_${gameFolderId}`,
        driveId: gameFolderId,
        driveFileId: mainFile ? mainFile.id : null,
        isFolder: true,
        source: 'drive',
        filename: folderName,
        title,
        console: consoleKey,
        isPcGame: consoleKey === 'pc',
        isDownloadOnly: true,
        size: totalSize,
        sizeFormatted: formatBytes(totalSize),
        fileCount: group.files.length,
        files: group.files.map(f => ({ name: f.name, driveId: f.id, size: Number(f.size || 0) })),
        coverUrl,
        addedAt: mainFile && mainFile.modifiedTime ? new Date(mainFile.modifiedTime).getTime() : Date.now()
      });
    }

    // Save into database (drive-sourced records only; bookmarks survive)
    Database.saveGames(user.id, recognizedGames, 'drive');

    // Sync game library JSON to the root of the user's games folder in Google Drive
    const userGamesFilename = this.getUserMetaFilename(user, 'games.json');
    try {
      await this.writeJsonFile(user, user.gamesFolderId, userGamesFilename, {
        version: 1,
        folderName: user.gamesFolderName || 'Games',
        updatedAt: Date.now(),
        count: recognizedGames.length,
        games: recognizedGames
      });
    } catch (jsonErr) {
      console.warn(`[GoogleDrive] Failed to write ${userGamesFilename} to Drive:`, jsonErr.message);
    }

    // Sync favorites to user's favorites JSON in the root of the user's games folder
    const currentFavs = Database.getFavorites(user.id);
    if (currentFavs && currentFavs.length > 0) {
      const userFavsFilename = this.getUserMetaFilename(user, 'favorites.json');
      try {
        await this.writeJsonFile(user, user.gamesFolderId, userFavsFilename, {
          version: 1,
          updatedAt: Date.now(),
          favorites: currentFavs
        });
      } catch (favErr) {
        console.warn(`[GoogleDrive] Failed to write ${userFavsFilename} to Drive:`, favErr.message);
      }
    }

    return {
      count: recognizedGames.length,
      games: recognizedGames
    };
  },

  async streamFile(user, fileId, req, res) {
    const accessToken = await GoogleAuth.getValidAccessToken(user);
    const driveUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;

    const fetchHeaders = {
      Authorization: `Bearer ${accessToken}`
    };

    if (req.headers.range) {
      fetchHeaders.Range = req.headers.range;
    }

    const driveRes = await fetch(driveUrl, {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: fetchHeaders
    });

    if (!driveRes.ok && driveRes.status !== 206) {
      throw new Error(`Google Drive stream error: HTTP ${driveRes.status}`);
    }

    // Forward range and content headers to client emulator
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const headersToForward = [
      'content-range',
      'content-length',
      'content-type',
      'last-modified',
      'etag'
    ];

    for (const h of headersToForward) {
      const val = driveRes.headers.get(h);
      if (val) {
        res.setHeader(h, val);
      }
    }

    res.status(driveRes.status);

    if (req.method === 'HEAD') {
      return res.end();
    }

    if (!driveRes.body) {
      return res.end();
    }

    const { Readable } = await import('stream');
    const nodeStream = Readable.fromWeb(driveRes.body);
    nodeStream.pipe(res);

    nodeStream.on('error', (err) => {
      console.warn('[Stream Pipe Error]:', err.message);
      if (!res.headersSent) res.status(500).end();
    });

    req.on('close', () => {
      nodeStream.destroy();
    });
  }
};
