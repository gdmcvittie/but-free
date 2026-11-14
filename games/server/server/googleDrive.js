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
  iso: 'ps2', // .iso in Sony family is overwhelmingly PS2 (DVD-sized) or PSP; PSX CD games use .bin/.cue
  cue: 'psx',
  chd: 'psx',
  pbp: 'psp', // EBOOT.PBP native PSP package format
  cso: 'psp', // Compressed ISO is 100% PSP
  vpk: 'vita',
  pkg: 'ps3',
  rap: 'ps3',
  // NEC / SNK / Other
  pce: 'pce',
  p8: 'pico8',
  // PC executables
  exe: 'pc',
  msi: 'pc',
  bat: 'pc'
};

// Folder-name variants -> console key (used for subfolder hints at any depth)
const FOLDER_CONSOLE_HINTS = [
  { names: ['pc', 'pc games', 'windows', 'gog', 'steam', 'epic', 'epic games', 'itch', 'itch.io', 'dos'], console: 'pc' },
  { names: ['snes', 'super nintendo', 'super famicom', 'sfc'], console: 'snes' },
  { names: ['nes', 'famicom'], console: 'nes' },
  { names: ['gba', 'game boy advance', 'gameboy advance'], console: 'gba' },
  { names: ['gbc', 'game boy color', 'gameboy color'], console: 'gbc' },
  { names: ['gb', 'game boy', 'gameboy', 'game gear boy'], console: 'gb' },
  { names: ['genesis', 'sega', 'mega drive', 'megadrive'], console: 'sega' },
  { names: ['psx', 'ps1', 'ps 1', 'ps-1', 'ps_1', 'playstation 1', 'playstation1', 'ps one', 'psone', 'playstation one'], console: 'psx' },
  { names: ['ps2', 'ps 2', 'ps-2', 'ps_2', 'playstation 2', 'playstation2', 'playstation-2', 'playstation_2', 'sony ps2', 'sony playstation 2'], console: 'ps2' },
  { names: ['ps3', 'ps 3', 'ps-3', 'ps_3', 'playstation 3', 'playstation3', 'playstation-3', 'playstation_3', 'sony ps3', 'sony playstation 3'], console: 'ps3' },
  { names: ['ps4', 'ps 4', 'ps-4', 'ps_4', 'playstation 4', 'playstation4', 'playstation-4', 'playstation_4'], console: 'ps4' },
  { names: ['ps5', 'ps 5', 'ps-5', 'ps_5', 'playstation 5', 'playstation5', 'ps-5', 'ps_5'], console: 'ps5' },
  { names: ['psp', 'playstation portable', 'playstationportable', 'playstation-portable', 'playstation_portable', 'sony psp', 'sony playstation portable'], console: 'psp' },
  { names: ['vita', 'ps vita', 'psvita', 'playstation vita', 'ps-vita', 'ps_vita'], console: 'vita' },
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

export function resolveConsoleKey(folderName) {
  if (!folderName) return 'other';
  const lower = String(folderName).toLowerCase().trim();
  const norm = lower.replace(/[-_.]+/g, ' ');

  // Switch: check first so it's NEVER misclassified
  if (norm === 'switch' || /\b(switch|nintendo\s*switch|nsw|nx)\b/.test(norm)) return 'switch';
  // PC: check explicit PC names
  if (norm === 'pc' || norm === 'pc games' || norm === 'windows' || /\b(gog|steam|epic|itch)\b/.test(norm)) return 'pc';
  // Sony consoles: PS2, PSP, PS3, PS4, PS5, Vita, PSX
  if (/\b(ps\s*2|playstation\s*2)\b/.test(norm)) return 'ps2';
  if (/\b(psp|playstation\s*portable)\b/.test(norm)) return 'psp';
  if (/\b(ps\s*3|playstation\s*3)\b/.test(norm)) return 'ps3';
  if (/\b(ps\s*4|playstation\s*4)\b/.test(norm)) return 'ps4';
  if (/\b(ps\s*5|playstation\s*5)\b/.test(norm)) return 'ps5';
  if (/\b(ps\s*vita|playstation\s*vita|vita)\b/.test(norm)) return 'vita';
  if (/\b(ps\s*1|psx|ps\s*one|psone|playstation\s*1|playstation\s*one)\b/.test(norm)) return 'psx';
  if (norm === 'playstation' || norm === 'sony playstation') return 'psx';

  // Nintendo retro
  if (/\b(n64|nintendo\s*64)\b/.test(norm)) return 'n64';
  if (/\b(snes|super\s*nintendo|sfc)\b/.test(norm)) return 'snes';
  if (/\b(nes|famicom)\b/.test(norm)) return 'nes';
  if (/\b(gba|game\s*boy\s*advance)\b/.test(norm)) return 'gba';
  if (/\b(gbc|game\s*boy\s*color)\b/.test(norm)) return 'gbc';
  if (/\b(gb|game\s*boy)\b/.test(norm)) return 'gb';
  if (/\b(gamecube|game\s*cube|gc|ngc)\b/.test(norm)) return 'gamecube';
  if (norm === 'wii' || norm.startsWith('wii ') || norm.endsWith(' wii')) return 'wii';
  if (/\b(wii\s*u|wiiu)\b/.test(norm)) return 'wiiu';
  if (/\b(3ds|nintendo\s*3ds)\b/.test(norm)) return '3ds';
  if (/\b(nds|ds|nintendo\s*ds)\b/.test(norm)) return 'nds';

  // Sega
  if (/\b(genesis|sega|mega\s*drive)\b/.test(norm)) return 'sega';
  if (/\b(dreamcast|dc)\b/.test(norm)) return 'dreamcast';
  if (/\b(saturn)\b/.test(norm)) return 'saturn';
  if (/\b(gg|game\s*gear)\b/.test(norm)) return 'gg';
  if (/\b(sms|master\s*system)\b/.test(norm)) return 'sms';

  // Xbox
  if (/\b(xbox\s*360|xbox360|x360)\b/.test(norm)) return 'xbox360';
  if (/\b(xbox\s*one|xboxone|xone)\b/.test(norm)) return 'xboxone';
  if (/\b(xbox)\b/.test(norm)) return 'xbox';

  // Other retro
  if (/\b(pce|pc\s*engine|turbografx)\b/.test(norm)) return 'pce';
  if (/\b(pico8|pico-8|pico)\b/.test(norm)) return 'pico8';
  if (/\b(atari)\b/.test(norm)) return 'atari';
  if (/\b(amiga)\b/.test(norm)) return 'amiga';
  if (/\b(c64|commodore)\b/.test(norm)) return 'c64';
  if (/\b(dos|ms-dos)\b/.test(norm)) return 'dos';

  return lower.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'other';
}

export function cleanGameTitle(rawName, isFolder = false) {
  if (!rawName) return 'Unknown Game';
  let clean = String(rawName).trim();
  if (isFolder) {
    clean = clean.replace(/\.(rar|zip|7z|tar|gz|iso|bin|cue|chd|pbp|exe|msi|pkg)$/i, '').trim();
  } else {
    clean = clean.replace(/\.[^/.]+$/, '').trim();
  }
  // Strip scene release groups (-RUNE, -TENOKE, -CODEX, -FLT, -DODI, -FitGirl, etc.)
  clean = clean.replace(/-[A-Za-z0-9_]{3,15}$/g, '');
  // Strip bracketed scene tags: [FitGirl Repack], [GOG], [PS2], [PSP], [!], etc.
  clean = clean.replace(/\s*\[[^\]]*\]/gi, '');
  // Strip typical scene / region / disc / version / platform tags:
  clean = clean
    .replace(/\s*\((USA|Europe|Japan|En,Ja|World|Beta|Rev\s*\d+|v\d+\.\d+|Proto|Demo|Unl|Sample|Disc\s*\d+|Disk\s*\d+|Track\s*\d+|PS2|PSP|PSX|PS1|PS3|PS4|PS5)[^)]*\)/gi, '')
    .replace(/\s+-\s+(USA|Europe|Japan|PS2|PSP|PSX|PS1)$/i, '')
    .replace(/[._ -]v\d+(\.\d+)*/gi, '')
    .replace(/[._ -]build[._ -]?\d+/gi, '')
    .replace(/[._ -](repack|deluxe|complete|gold|goty|edition|definitive|remastered)/gi, ' ');
  // If dots or underscores are used as word separators, replace them with spaces:
  if (clean.includes('.') || clean.includes('_')) {
    clean = clean.replace(/[._]/g, ' ');
  }
  clean = clean.replace(/\s+/g, ' ').trim();
  return clean || rawName;
}

export function detectConsoleFromFilename(filename, ext = '', fileSize = 0, folderHint = null) {
  const name = String(filename || '');
  const lower = name.toLowerCase();
  const norm = lower.replace(/[-_.]+/g, ' ');

  // 1. Nintendo Switch
  if (['nsp', 'nsz', 'xci', 'xcz'].includes(ext) || /\b(switch|nintendo\s*switch|nsw|nx)\b/.test(norm)) {
    return 'switch';
  }

  // 2. Explicit console bracketed/parenthetical tags or serial codes
  if (/\b(ps\s*5|playstation\s*5)\b/.test(norm)) return 'ps5';
  if (/\b(ps\s*4|playstation\s*4)\b/.test(norm)) return 'ps4';
  if (/\b(ps\s*3|playstation\s*3)\b|(blus|bles|bcus|bces|mrtc|npeb|npub)[-_\s]?\d{4,5}/i.test(name)) return 'ps3';
  if (/\b(ps\s*2|playstation\s*2)\b|(slus|sles|scus|sces|slpm|slps|scaj|scka)[-_\s]?\d{4,5}/i.test(name)) return 'ps2';
  if (/\b(psp|playstation\s*portable)\b|(ulus|ules|ucus|uces|uljs|uljm|ucjs|npeg|npug|npuh|npez|npuz)[-_\s]?\d{4,5}/i.test(name)) return 'psp';
  if (/\b(ps\s*vita|playstation\s*vita|vita)\b/.test(norm)) return 'vita';
  if (/\b(ps\s*1|psx|ps\s*one|psone|playstation\s*1|playstation\s*one)\b/.test(norm)) return 'psx';

  // 3. Specific unique file extensions
  if (ext === 'cso') return 'psp';
  if (ext === 'vpk') return 'vita';
  if (ext === 'pkg' || ext === 'rap') return 'ps3';
  if (ext === 'cue') return 'psx';

  // 4. For .iso and .chd: PS1 physical discs were CD-ROMs maxing out at 700 MB.
  // Any disc image above 850 MB is a DVD, which is PlayStation 2!
  // (Only apply this size heuristic if not in a known non-Sony console folder like Dreamcast or Gamecube)
  const isNonSonyFolder = folderHint && !['psx', 'ps1', 'ps2', 'psp', 'ps3', 'ps4', 'ps5', 'vita', 'pc'].includes(folderHint);
  if (!isNonSonyFolder && ['iso', 'chd'].includes(ext)) {
    if (fileSize > 850 * 1024 * 1024) {
      return 'ps2';
    }
  }

  return null;
}

export function getBoxArtCandidateUrls(cleanTitle, consoleKey, rawFilename = '') {
  const systemName = LIBRETRO_SYSTEM_NAMES[consoleKey];
  if (!systemName) return [];

  const candidates = [];
  const addCandidate = (name) => {
    if (!name) return;
    const sanitized = String(name)
      .replace(/[&]/g, '_')
      .replace(/[/\\:*?"<>|]/g, '_')
      .trim();
    if (!sanitized) return;
    const url = `https://thumbnails.libretro.com/${encodeURIComponent(systemName)}/Named_Boxarts/${encodeURIComponent(sanitized)}.png`;
    if (!candidates.includes(url)) candidates.push(url);
  };

  // 1. Raw filename base without extension (e.g. "Crash Bandicoot (USA)")
  if (rawFilename) {
    const rawStem = rawFilename.replace(/\.[^/.]+$/, '').trim();
    addCandidate(rawStem);
  }

  // 2. Cleaned title
  addCandidate(cleanTitle);

  // 3. Region variants (Libretro Named_Boxarts is almost exclusively indexed by region)
  addCandidate(`${cleanTitle} (USA)`);
  addCandidate(`${cleanTitle} (Europe)`);
  addCandidate(`${cleanTitle} (World)`);
  addCandidate(`${cleanTitle} (Japan)`);
  addCandidate(`${cleanTitle} (En,Ja)`);
  addCandidate(`${cleanTitle} (Europe, Australia)`);

  return candidates;
}

export async function fetchFirstWorkingBoxArt(candidateUrls, timeoutMs = 2500) {
  if (!candidateUrls || candidateUrls.length === 0) return null;
  try {
    const fetchSingle = async (url) => {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 500) {
          return { buffer: buf, mime: res.headers.get('content-type') || 'image/png', sourceUrl: url };
        }
      }
      throw new Error('Not found');
    };

    return await Promise.any(candidateUrls.map(u => fetchSingle(u)));
  } catch (_) {
    return null;
  }
}

export function getBoxArtUrl(title, consoleKey) {
  const systemName = LIBRETRO_SYSTEM_NAMES[consoleKey];
  if (!systemName) return null;
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

/**
 * Multi-tiered search for game box art / poster art / screenshots:
 * Tier 1: Libretro Thumbnails with automatic region fallback (USA, Europe, World, Japan).
 * Tier 2: Steam Store API & CDN (library 600x900 vertical poster, header, screenshot).
 * Tier 3: GOG Catalog API (high-res official cover images for PC & classic releases).
 * Tier 4: Wikipedia PageImages API (official infobox covers for retro & PC games).
 * Tier 5: Open-web search (DuckDuckGo images).
 */
export async function searchInternetGameArt(cleanTitle, consoleKey = '', rawFilename = '') {
  const clean = cleanGameTitle(cleanTitle || rawFilename || '', false);
  if (!clean || clean.length < 2) return null;

  const canonKey = String(consoleKey || '').toLowerCase().trim();

  // Tier 1 for PC games: Steam Store Search API (official 600x900 vertical poster)
  if (canonKey === 'pc') {
    try {
      const steamUrl = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(clean)}&l=english&cc=US`;
      const sRes = await fetch(steamUrl, { signal: AbortSignal.timeout(4000) });
      if (sRes.ok) {
        const sData = await sRes.json();
        if (sData.items && sData.items.length > 0) {
          const topApp = sData.items[0];
          const appId = topApp.id;
          const libUrl = `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appId}/library_600x900.jpg`;
          return { buffer: null, mime: 'image/jpeg', source: 'Steam vertical box art', sourceUrl: libUrl };
        }
      }
    } catch (_) {}
  }

  // Tier 1 for emulator/retro consoles: Libretro candidate URLs with region fallback
  if (canonKey !== 'pc' && LIBRETRO_SYSTEM_NAMES[canonKey]) {
    try {
      const candidates = getBoxArtCandidateUrls(clean, canonKey, rawFilename);
      const hit = await fetchFirstWorkingBoxArt(candidates, 3000);
      if (hit) {
        return { buffer: hit.buffer, mime: hit.mime, source: 'Libretro Box Art', sourceUrl: hit.sourceUrl };
      }
    } catch (_) {}
  }

  // Tier 2: Wikipedia PageImages API (official infobox box art for Switch, PS2, PSP, PSX, PC, etc.)
  try {
    let wikiSystem = '';
    if (canonKey === 'switch') wikiSystem = 'Nintendo Switch';
    else if (canonKey === 'ps2') wikiSystem = 'PlayStation 2';
    else if (canonKey === 'psp') wikiSystem = 'PlayStation Portable';
    else if (canonKey === 'psx' || canonKey === 'ps1') wikiSystem = 'PlayStation';
    else if (canonKey === 'snes') wikiSystem = 'Super Nintendo';
    else if (canonKey === 'nes') wikiSystem = 'NES';
    else if (canonKey === 'n64') wikiSystem = 'Nintendo 64';
    else if (canonKey === 'gba') wikiSystem = 'Game Boy Advance';
    else if (canonKey && canonKey !== 'pc') wikiSystem = canonKey;

    const q = `${clean} ${wikiSystem ? wikiSystem + ' ' : ''}video game`.trim();
    const wikiUrl = `https://en.wikipedia.org/w/api.php?action=query&format=json&prop=pageimages&piprop=thumbnail&pithumbsize=600&pilicense=any&generator=search&gsrsearch=${encodeURIComponent(q)}&gsrlimit=1`;
    const wRes = await fetch(wikiUrl, {
      headers: {
        'User-Agent': 'FREEPLAY/1.0 (https://games.butfree.online; contact@butfree.online) Mozilla/5.0'
      },
      signal: AbortSignal.timeout(5000)
    });
    if (wRes.ok) {
      const wData = await wRes.json();
      const pages = wData.query ? Object.values(wData.query.pages) : [];
      if (pages.length > 0 && pages[0].thumbnail?.source) {
        const thumbUrl = pages[0].thumbnail.source;
        return { buffer: null, mime: 'image/jpeg', source: 'Wikipedia box art', sourceUrl: thumbUrl };
      }
    }
  } catch (_) {}

  // Tier 3: Steam Store Search API fallback for non-PC games (many console games have PC/Steam releases)
  if (canonKey !== 'pc') {
    try {
      const steamUrl = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(clean)}&l=english&cc=US`;
      const sRes = await fetch(steamUrl, { signal: AbortSignal.timeout(3500) });
      if (sRes.ok) {
        const sData = await sRes.json();
        if (sData.items && sData.items.length > 0) {
          const topApp = sData.items[0];
          const appId = topApp.id;
          const libUrl = `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appId}/library_600x900.jpg`;
          return { buffer: null, mime: 'image/jpeg', source: 'Steam vertical box art', sourceUrl: libUrl };
        }
      }
    } catch (_) {}
  }

  // Tier 4: GOG Catalog API (DRM-free PC games & classic releases)
  try {
    const gogUrl = `https://catalog.gog.com/v1/catalog?limit=1&locale=en-US&query=${encodeURIComponent(clean)}`;
    const gRes = await fetch(gogUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      signal: AbortSignal.timeout(3500)
    });
    if (gRes.ok) {
      const gData = await gRes.json();
      if (gData.products && gData.products.length > 0) {
        const prod = gData.products[0];
        const gogCover = prod.coverVertical || prod.coverHorizontal;
        if (gogCover) {
          return { buffer: null, mime: 'image/png', source: 'GOG cover art', sourceUrl: gogCover };
        }
      }
    }
  } catch (_) {}

  // Tier 5: Open-web image search (DuckDuckGo) fallback
  const queries = [
    `${clean} ${canonKey === 'switch' ? 'nintendo switch' : canonKey && canonKey !== 'pc' ? canonKey : ''} box art cover`.trim(),
    `${clean} video game screenshot`.trim()
  ];

  for (const query of queries) {
    try {
      const vqdRes = await fetch(`https://duckduckgo.com/?q=${encodeURIComponent(query)}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
        signal: AbortSignal.timeout(3500)
      });
      if (!vqdRes.ok) continue;
      const html = await vqdRes.text();
      const match = html.match(/vqd=["']?([0-9-]+)/);
      const vqd = match ? match[1] : null;
      if (!vqd) continue;

      const imgApi = `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(query)}&vqd=${vqd}&f=,,,`;
      const ddgRes = await fetch(imgApi, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://duckduckgo.com/'
        },
        signal: AbortSignal.timeout(3500)
      });
      if (!ddgRes.ok) continue;

      const ddgData = await ddgRes.json();
      const results = ddgData.results || [];
      for (let i = 0; i < Math.min(3, results.length); i++) {
        const candidateUrl = results[i].image;
        if (!candidateUrl || !candidateUrl.startsWith('http')) continue;
        try {
          const imgDl = await fetch(candidateUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            signal: AbortSignal.timeout(4000)
          });
          if (imgDl.ok) {
            const buf = Buffer.from(await imgDl.arrayBuffer());
            const mime = imgDl.headers.get('content-type') || '';
            if (buf.length > 1000 && (mime.startsWith('image/') || candidateUrl.match(/\.(jpe?g|png|webp)/i))) {
              return { buffer: buf, mime: mime || 'image/jpeg', source: 'Web image search', sourceUrl: candidateUrl };
            }
          }
        } catch (_) {}
      }
    } catch (_) {}
  }

  return null;
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

  async getFileMetadata(user, fileId) {
    if (!fileId) return null;
    try {
      const accessToken = await GoogleAuth.getValidAccessToken(user);
      const url = new URL(`https://www.googleapis.com/drive/v3/files/${fileId}`);
      url.searchParams.set('fields', 'id,name,mimeType,size,modifiedTime,parents');
      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      if (!res.ok) return null;
      return await res.json();
    } catch (_) {
      return null;
    }
  },

  async findCompanionDiscFile(user, parentId, cueFilename) {
    if (!parentId) return null;
    try {
      const accessToken = await GoogleAuth.getValidAccessToken(user);
      const url = new URL('https://www.googleapis.com/drive/v3/files');
      url.searchParams.set('q', `'${parentId}' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false`);
      url.searchParams.set('fields', 'files(id, name, size, mimeType)');
      url.searchParams.set('pageSize', '100');
      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      if (!res.ok) return null;
      const data = await res.json();
      const files = data.files || [];
      const discFiles = files.filter(f => {
        const e = fileExt(f.name);
        return ['bin', 'iso', 'chd', 'pbp', 'img'].includes(e);
      });
      if (discFiles.length === 0) return null;
      discFiles.sort((a, b) => Number(b.size || 0) - Number(a.size || 0));
      return discFiles[0];
    } catch (_) {
      return null;
    }
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

    const header = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`;
    const footer = `\r\n--${boundary}--`;

    const multipartBody = Buffer.concat([
      Buffer.from(header),
      buffer,
      Buffer.from(footer)
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

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.warn(`[GoogleDrive] uploadBufferToDrive failed for "${fileName}" (${res.status}):`, errBody);
      return null;
    }
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
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          console.error(`[GoogleDrive API ${res.status}]:`, errData.error?.message || res.statusText);
          break;
        }
        const data = await res.json();
        if (data.files) results.push(...data.files);
        pageToken = data.nextPageToken;
      } while (pageToken);
      return results;
    };

    const folderHint = (name) => {
      const lower = (name || '').toLowerCase().trim();
      const norm = lower.replace(/[-_.]+/g, ' ');

      for (const entry of FOLDER_CONSOLE_HINTS) {
        if (entry.names.includes(lower) || entry.names.includes(norm)) return entry.console;
      }

      // Check PS5, PS4, PS3, PS2, PSP, Vita BEFORE checking generic PlayStation
      if (/\b(ps\s*5|playstation\s*5)\b/.test(norm)) return 'ps5';
      if (/\b(ps\s*4|playstation\s*4)\b/.test(norm)) return 'ps4';
      if (/\b(ps\s*3|playstation\s*3)\b|(blus|bles|bcus|bces|mrtc|npeb|npub)[-_\s]?\d{4,5}/i.test(name)) return 'ps3';
      if (/\b(ps\s*2|playstation\s*2)\b|(slus|sles|scus|sces|slpm|slps|scaj|scka)[-_\s]?\d{4,5}/i.test(name)) return 'ps2';
      if (/\b(psp|playstation\s*portable)\b|(ulus|ules|ucus|uces|uljs|uljm|ucjs|npeg|npug|npuh|npez|npuz)[-_\s]?\d{4,5}/i.test(name)) return 'psp';
      if (/\b(ps\s*vita|playstation\s*vita|vita)\b/.test(norm)) return 'vita';

      // Explicit PS1 / PSX / PS One / PlayStation 1
      if (/\b(ps\s*1|psx|ps\s*one|psone|playstation\s*1|playstation\s*one)\b/.test(norm)) return 'psx';

      if (norm.includes('switch') || norm.includes('nintendo switch')) return 'switch';
      if (norm.includes('gamecube') || norm.includes('game cube')) return 'gamecube';
      if (norm === 'wii' || norm.startsWith('wii ') || norm.endsWith(' wii')) return 'wii';
      if (norm.includes('wii u') || norm.includes('wiiu')) return 'wiiu';
      if (norm.includes('3ds')) return '3ds';
      if (norm.includes('snes') || norm.includes('super nintendo')) return 'snes';
      if (norm.includes('gba') || norm.includes('game boy advance')) return 'gba';
      if (norm.includes('gbc') || norm.includes('game boy color')) return 'gbc';
      if (norm.includes('game boy') || norm === 'gb') return 'gb';
      if (norm.includes('genesis') || norm.includes('sega') || norm.includes('mega drive')) return 'sega';
      if (norm.includes('n64') || norm.includes('nintendo 64')) return 'n64';
      if (norm.includes('nes') || norm.includes('famicom')) return 'nes';
      if (norm.includes('nds') || norm.includes('nintendo ds')) return 'nds';
      if (norm.includes('pico')) return 'pico8';
      if (norm.includes('dreamcast')) return 'dreamcast';
      if (norm.includes('saturn')) return 'saturn';
      if (norm.includes('xbox 360') || norm.includes('xbox360') || norm.includes('x360')) return 'xbox360';
      if (norm.includes('xbox')) return 'xbox';
      if (norm.includes('atari')) return 'atari';
      if (norm.includes('amiga')) return 'amiga';
      if (norm.includes('c64') || norm.includes('commodore')) return 'c64';
      if (norm === 'pc games' || norm === 'pc' || norm.includes('gog') || norm.includes('itch') || norm.includes('windows')) return 'pc';

      // If standalone "playstation" or "sony playstation" with no sub-indicator, return null
      // so it acts as an umbrella container for PS1/PS2/PSP without forcing everything to PS1!
      if (/^(playstation|sony playstation)$/.test(norm)) {
        return null;
      }

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

    // 1. Enumerate Console Folders under the main games folder
    // The main games folder contains console subfolders (e.g. switch, psp, ps2, psx, n64, snes, pc)
    const rawLevel1Folders = await driveQueryFiles(
      `'${user.gamesFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      'id,name'
    );
    const topLevelFolders = [];
    for (const f of rawLevel1Folders) {
      const lower = (f.name || '').toLowerCase().trim();
      if (lower === 'posters') {
        posterFoldersByParent.set(user.gamesFolderId, f);
        continue;
      }
      if (!IGNORED_FOLDER_NAMES.has(lower)) topLevelFolders.push(f);
    }

    // Resolve console folders, expanding umbrella containers (e.g. "PlayStation", "Sony", "Nintendo", "Roms", etc.)
    const consoleFolders = []; // [{ id, name, consoleKey, parentId }]
    const visitedFolders = new Set();

    const resolveConsoleFolder = async (folder, parentId, depth = 0) => {
      if (visitedFolders.has(folder.id) || depth > 2) return;
      visitedFolders.add(folder.id);

      const fLower = (folder.name || '').toLowerCase().trim();
      const fNorm = fLower.replace(/[-_.]+/g, ' ');
      const isKnownUmbrella = /^(sony|playstation|sony playstation|nintendo|retro games|retro|roms|games|collection|systems|emulation)$/i.test(fNorm);

      // Check for subfolders if it could be an umbrella or container folder
      if (depth < 2) {
        const subs = await driveQueryFiles(
          `'${folder.id}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
          'id,name'
        );
        const validSubs = subs.filter(s => {
          const sLower = (s.name || '').toLowerCase().trim();
          if (sLower === 'posters') {
            posterFoldersByParent.set(folder.id, s);
            return false;
          }
          return !IGNORED_FOLDER_NAMES.has(sLower);
        });

        // If it's a known umbrella OR if its children are recognized console folders (e.g. ps2, psp, psx, switch inside it)
        const hasConsoleChildren = validSubs.some(s => resolveConsoleKey(s.name) !== 'other');
        if ((isKnownUmbrella || hasConsoleChildren) && validSubs.length > 0) {
          console.log(`[GoogleDrive] Expanding container folder "${folder.name}" (${validSubs.length} subfolders)`);
          for (const sub of validSubs) {
            await resolveConsoleFolder(sub, folder.id, depth + 1);
          }
          return;
        }
      }

      const consoleKey = resolveConsoleKey(folder.name);
      consoleFolders.push({ id: folder.id, name: folder.name, consoleKey, parentId });
      console.log(`[GoogleDrive] Console folder mapped: "${folder.name}" -> console "${consoleKey}" (ID: ${folder.id})`);
    };

    for (const f of topLevelFolders) {
      await resolveConsoleFolder(f, user.gamesFolderId, 0);
    }

    const folderInfo = new Map(); // folderId -> { name, parentId, hint }
    folderInfo.set(user.gamesFolderId, { name: user.gamesFolderName || 'Games', parentId: null, hint: null });
    for (const c of consoleFolders) {
      folderInfo.set(c.id, { name: c.name, parentId: c.parentId, hint: c.consoleKey });
    }

    // Fast non-blocking art discovery: checks Drive index, then falls back to on-demand endpoint
    const findCoverForGame = async (stem, title, consoleKey, folderId = null) => {
      const keys = posterLookupKeys(stem.toLowerCase(), title.toLowerCase(), consoleKey);
      let coverUrl = null;

      // 1. Check local poster index in Google Drive (posters/<console>/ or <root>/posters/)
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

      // 2. Fallback on-demand cover endpoint (browser loads asynchronously via <img src="..." />)
      if (!coverUrl) {
        coverUrl = `/api/games/cover?title=${encodeURIComponent(title)}&console=${encodeURIComponent(consoleKey || '')}`;
      }

      return coverUrl;
    };

    const recognizedGames = [];

    // 2. Scan each Console Folder
    for (let cIdx = 0; cIdx < consoleFolders.length; cIdx++) {
      const cFolder = consoleFolders[cIdx];
      const consoleKey = cFolder.consoleKey;
      const isPlayable = SUPPORTED_EMULATOR_CONSOLES.has(consoleKey);

      // Query subfolders and direct files in this console folder
      const subfolders = await driveQueryFiles(
        `'${cFolder.id}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        'id,name'
      );
      const directFiles = await driveQueryFiles(
        `'${cFolder.id}' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false`
      );

      // Index loose poster images in the console folder
      for (const file of directFiles) {
        if (!POSTER_IMAGE_EXTS.has(fileExt(file.name))) continue;
        if (!looseImagesByParent.has(cFolder.id)) looseImagesByParent.set(cFolder.id, new Map());
        indexPosterFile(looseImagesByParent.get(cFolder.id), file);
      }

      // 2a. Process game subfolders within this console folder (e.g. switch/Super Mario Odyssey/ or ps2/GTA/)
      const validSubfolders = [];
      for (const sf of subfolders) {
        const sfLower = (sf.name || '').toLowerCase().trim();
        if (sfLower === 'posters') {
          posterFoldersByParent.set(cFolder.id, sf);
          continue;
        }
        if (IGNORED_FOLDER_NAMES.has(sfLower)) continue;

        // If this subfolder is itself a recognized console (e.g. "switch", "psp", "ps2", "psx" inside "pc" or vice-versa)
        const mappedConsole = resolveConsoleKey(sf.name);
        if (mappedConsole !== 'other' && mappedConsole !== consoleKey) {
          console.log(`[GoogleDrive] Detected nested console folder "${sf.name}" -> console "${mappedConsole}" inside "${cFolder.name}"`);
          if (!consoleFolders.some(cf => cf.id === sf.id)) {
            consoleFolders.push({ id: sf.id, name: sf.name, consoleKey: mappedConsole, parentId: cFolder.id });
          }
          continue; // DO NOT treat this folder as a game card!
        }

        // Never treat a folder titled literally after a console as a game card under a different console
        if (['switch', 'pc', 'ps2', 'psp', 'psx', 'n64', 'snes', 'gba', 'nes'].includes(sfLower) && sfLower !== consoleKey) {
          continue;
        }

        validSubfolders.push(sf);
      }

      // Batch-fetch all direct files inside game subfolders (up to 25 subfolders per API call)
      const sfFilesMap = new Map();
      for (const sf of validSubfolders) {
        sfFilesMap.set(sf.id, []);
        folderInfo.set(sf.id, { name: sf.name, parentId: cFolder.id, hint: consoleKey });
      }

      const BATCH_SIZE = 25;
      for (let i = 0; i < validSubfolders.length; i += BATCH_SIZE) {
        const batch = validSubfolders.slice(i, i + BATCH_SIZE);
        const parentClauses = batch.map(sf => `'${sf.id}' in parents`).join(' or ');
        const batchFiles = await driveQueryFiles(
          `(${parentClauses}) and mimeType != 'application/vnd.google-apps.folder' and trashed = false`
        );
        for (const file of batchFiles) {
          if (file.parents && Array.isArray(file.parents)) {
            for (const pid of file.parents) {
              if (sfFilesMap.has(pid)) {
                sfFilesMap.get(pid).push(file);
              }
            }
          }
        }
      }

      for (const sf of validSubfolders) {
        const sfFiles = sfFilesMap.get(sf.id) || [];

        // Index loose poster images inside the game folder
        for (const file of sfFiles) {
          if (!POSTER_IMAGE_EXTS.has(fileExt(file.name))) continue;
          if (!looseImagesByParent.has(sf.id)) looseImagesByParent.set(sf.id, new Map());
          indexPosterFile(looseImagesByParent.get(sf.id), file);
        }

        let gameFiles = sfFiles.filter(f => !IGNORED_FILE_EXTS.has(fileExt(f.name)) && !POSTER_IMAGE_EXTS.has(fileExt(f.name)));
        
        // If no game files found at top level of folder, check one level deeper
        if (gameFiles.length === 0) {
          const nestedSubs = await driveQueryFiles(
            `'${sf.id}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
            'id,name'
          );
          for (const nsf of nestedSubs) {
            const nFiles = await driveQueryFiles(
              `'${nsf.id}' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false`
            );
            const validNFiles = nFiles.filter(f => !IGNORED_FILE_EXTS.has(fileExt(f.name)) && !POSTER_IMAGE_EXTS.has(fileExt(f.name)));
            if (validNFiles.length > 0) {
              gameFiles.push(...validNFiles);
            }
          }
        }

        if (gameFiles.length === 0) continue;

        // Detect effective console from contents: Switch, PSP, or PS2 ROMs can NEVER be PC games
        let effectiveConsole = consoleKey;
        const hasSwitchRom = gameFiles.some(f => ['nsp', 'nsz', 'xci', 'xcz'].includes(fileExt(f.name)));
        const hasPspRom = gameFiles.some(f => ['cso', 'pbp'].includes(fileExt(f.name)));
        const hasPs2Rom = gameFiles.some(f => fileExt(f.name) === 'iso' && Number(f.size || 0) > 800 * 1024 * 1024);

        if (hasSwitchRom) effectiveConsole = 'switch';
        else if (hasPspRom) effectiveConsole = 'psp';
        else if (hasPs2Rom && (consoleKey === 'psx' || consoleKey === 'pc')) effectiveConsole = 'ps2';

        const effectivePlayable = SUPPORTED_EMULATOR_CONSOLES.has(effectiveConsole);
        const mainFile = [...gameFiles].sort((a, b) => Number(b.size || 0) - Number(a.size || 0))[0];
        const mainExt = fileExt(mainFile.name);
        const totalSize = gameFiles.reduce((sum, f) => sum + Number(f.size || 0), 0);
        const title = cleanGameTitle(sf.name, true);
        const isDownload = !effectivePlayable || PC_FILE_EXTS.has(mainExt);

        const coverUrl = await findCoverForGame(sf.name, title, effectiveConsole, sf.id);

        recognizedGames.push({
          id: effectiveConsole === 'pc' ? `gmpc_${sf.id}` : `gm_${effectiveConsole}_${sf.id}`,
          driveId: sf.id,
          driveFileId: mainFile ? mainFile.id : null,
          folderId: sf.id,
          isFolder: true,
          source: 'drive',
          filename: sf.name,
          title,
          console: effectiveConsole,
          isPcGame: effectiveConsole === 'pc',
          isDownloadOnly: isDownload,
          size: totalSize,
          sizeFormatted: formatBytes(totalSize),
          fileCount: gameFiles.length,
          files: gameFiles.map(f => ({ name: f.name, driveId: f.id, size: Number(f.size || 0) })),
          coverUrl,
          addedAt: mainFile && mainFile.modifiedTime ? new Date(mainFile.modifiedTime).getTime() : Date.now()
        });
      }

      // 2b. Process loose game files directly in the console folder
      const looseGameFiles = directFiles.filter(f => !IGNORED_FILE_EXTS.has(fileExt(f.name)) && !POSTER_IMAGE_EXTS.has(fileExt(f.name)));

      // Handle disc sheet (.cue) vs raw image (.bin): skip small .cue if .bin is present
      const hasBinOrIso = looseGameFiles.some(f => ['bin', 'iso', 'chd', 'pbp', 'img'].includes(fileExt(f.name)));

      for (const file of looseGameFiles) {
        const ext = fileExt(file.name);
        if (ext === 'cue' && hasBinOrIso) continue;

        // Skip non-primary split volumes (.r01, .z01, track 2 .bin)
        if (isPlayable && (/\.r\d{2}$/i.test(file.name) || /\.z\d{2}$/i.test(file.name) || /\.\d{3}$/.test(file.name))) {
          continue;
        }

        let fileConsole = consoleKey;
        if (['nsp', 'nsz', 'xci', 'xcz'].includes(ext)) fileConsole = 'switch';
        else if (['cso', 'pbp'].includes(ext)) fileConsole = 'psp';
        else if (ext === 'iso' && (consoleKey === 'ps2' || Number(file.size || 0) > 800 * 1024 * 1024)) fileConsole = 'ps2';
        else if ((ext === 'cue' || ext === 'bin' || ext === 'chd') && consoleKey === 'psx') fileConsole = 'psx';

        const filePlayable = SUPPORTED_EMULATOR_CONSOLES.has(fileConsole);
        const isDownload = !filePlayable || PC_FILE_EXTS.has(ext);
        const cleanStem = file.name.replace(/\.[^.]+$/, '');
        const title = cleanGameTitle(file.name);
        const coverUrl = await findCoverForGame(cleanStem, title, fileConsole, cFolder.id);

        recognizedGames.push({
          id: fileConsole === 'pc' ? `gmpc_${file.id}` : `gm_${fileConsole}_${file.id}`,
          driveId: file.id,
          folderId: cFolder.id,
          source: 'drive',
          filename: file.name,
          title,
          console: fileConsole,
          isPcGame: fileConsole === 'pc',
          isDownloadOnly: isDownload,
          size: Number(file.size || 0),
          sizeFormatted: formatBytes(file.size),
          coverUrl,
          addedAt: file.modifiedTime ? new Date(file.modifiedTime).getTime() : Date.now()
        });
      }
    }

    // 3. Process any loose files directly in the user's root games folder (if any)
    const rootDirectFiles = await driveQueryFiles(
      `'${user.gamesFolderId}' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false`
    );
    for (const file of rootDirectFiles) {
      const ext = fileExt(file.name);
      if (IGNORED_FILE_EXTS.has(ext) || POSTER_IMAGE_EXTS.has(ext)) continue;

      let fileConsole = detectConsoleFromFilename(file.name, ext, Number(file.size || 0)) || EXTENSION_CONSOLE_MAP[ext] || 'other';
      if (['nsp', 'nsz', 'xci', 'xcz'].includes(ext)) fileConsole = 'switch';
      else if (['cso', 'pbp'].includes(ext)) fileConsole = 'psp';
      else if (ext === 'iso' && Number(file.size || 0) > 800 * 1024 * 1024) fileConsole = 'ps2';

      const isPlayable = SUPPORTED_EMULATOR_CONSOLES.has(fileConsole);
      const isDownload = !isPlayable || PC_FILE_EXTS.has(ext);
      const cleanStem = file.name.replace(/\.[^.]+$/, '');
      const title = cleanGameTitle(file.name);
      const coverUrl = await findCoverForGame(cleanStem, title, fileConsole, user.gamesFolderId);

      recognizedGames.push({
        id: fileConsole === 'pc' ? `gmpc_${file.id}` : `gm_${fileConsole}_${file.id}`,
        driveId: file.id,
        folderId: null,
        source: 'drive',
        filename: file.name,
        title,
        console: fileConsole,
        isPcGame: fileConsole === 'pc',
        isDownloadOnly: isDownload,
        size: Number(file.size || 0),
        sizeFormatted: formatBytes(file.size),
        coverUrl,
        addedAt: file.modifiedTime ? new Date(file.modifiedTime).getTime() : Date.now()
      });
    }

    // Sanitize: filter out any errant console folder cards
    const cleanRecognizedGames = [];
    for (const g of recognizedGames) {
      const tLower = (g.title || '').toLowerCase().trim();
      if (['switch', 'pc', 'ps2', 'psp', 'psx'].includes(tLower) && g.isFolder && (g.isPcGame || g.console === 'pc')) {
        console.log(`[GoogleDrive] Filtered errant console folder card "${g.title}" under ${g.console}`);
        continue;
      }
      cleanRecognizedGames.push(g);
    }

    const breakdown = {};
    for (const g of cleanRecognizedGames) {
      breakdown[g.console] = (breakdown[g.console] || 0) + 1;
    }
    console.log(`[GoogleDrive] Scan complete! Found ${cleanRecognizedGames.length} games across ${consoleFolders.length} console folders.`);
    console.log(`[GoogleDrive] Breakdown by console:`, JSON.stringify(breakdown));

    // Save into database (drive-sourced records only; bookmarks survive)
    Database.saveGames(user.id, cleanRecognizedGames, 'drive');

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
    if (!fileId) {
      if (!res.headersSent) res.status(400).end();
      return;
    }

    // Handle HEAD requests without querying Google Drive with method HEAD (which GDrive rejects with 405)
    if (req.method === 'HEAD') {
      const meta = await this.getFileMetadata(user, fileId);
      if (!meta) {
        if (!res.headersSent) res.status(404).end();
        return;
      }

      let targetSize = meta.size;
      let targetMime = meta.mimeType || 'application/octet-stream';

      // If requested file is a small .cue sheet, resolve companion .bin for accurate content-length
      if (meta.name && meta.name.toLowerCase().endsWith('.cue') && meta.parents && meta.parents.length) {
        const companion = await this.findCompanionDiscFile(user, meta.parents[0], meta.name);
        if (companion) {
          targetSize = companion.size || targetSize;
          targetMime = companion.mimeType || targetMime;
        }
      }

      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
      res.setHeader('Content-Type', targetMime);
      if (targetSize) {
        res.setHeader('Content-Length', targetSize);
      }
      if (meta.modifiedTime) {
        res.setHeader('Last-Modified', new Date(meta.modifiedTime).toUTCString());
      }
      return res.status(200).end();
    }

    let targetFileId = fileId;

    // For GET: if file is a .cue file, redirect stream to the companion playable disc image (.bin/.iso/.chd)
    const reqFilename = (req.params?.filename || '').toLowerCase();
    if (reqFilename.endsWith('.cue') || reqFilename.endsWith('.bin')) {
      try {
        const meta = await this.getFileMetadata(user, fileId);
        if (meta && meta.name && meta.name.toLowerCase().endsWith('.cue') && meta.parents && meta.parents.length) {
          const companion = await this.findCompanionDiscFile(user, meta.parents[0], meta.name);
          if (companion && companion.id) {
            targetFileId = companion.id;
          }
        }
      } catch (_) {}
    }

    const accessToken = await GoogleAuth.getValidAccessToken(user);
    const driveUrl = `https://www.googleapis.com/drive/v3/files/${targetFileId}?alt=media&acknowledgeAbuse=true`;

    const fetchHeaders = {
      Authorization: `Bearer ${accessToken}`
    };

    if (req.headers.range) {
      fetchHeaders.Range = req.headers.range;
    }

    const driveRes = await fetch(driveUrl, {
      method: 'GET',
      headers: fetchHeaders
    });

    if (!driveRes.ok && driveRes.status !== 206) {
      throw new Error(`Google Drive stream error: HTTP ${driveRes.status}`);
    }

    // Forward range and content headers to client emulator
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');

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
