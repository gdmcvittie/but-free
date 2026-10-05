import fs from 'fs';
import path from 'path';

/** Audio containers audiobook releases actually ship in. */
export const AUDIO_EXTS = ['.m4b', '.m4a', '.mp3', '.aac', '.ogg', '.opus', '.flac', '.wma'];

export function isAudioFile(filename) {
  return AUDIO_EXTS.includes(path.extname(filename || '').toLowerCase());
}

/**
 * Public BitTorrent trackers used to build magnet URIs.
 *
 * AudioBookBay's own download button redirects to a third-party signup wall, so
 * the .torrent bytes are not retrievable. Every release page does expose a
 * clean info hash though, so we build the magnet ourselves and rely on trackers
 * + DHT for peer discovery.
 */
export const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://exodus.desync.com:6971/announce',
  'udp://ipv4.tracker.torrent.eu.org:451/announce',
  'udp://tracker.empire-js.us:1337/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'http://tracker.bt4g.com:2095/announce',
  'http://tracker.opentrackr.org:1337/announce',
  'https://tracker.bt4g.com:2095/announce'
];

/**
 * Builds a magnet URI from a 40-char hex info hash.
 * Returns null when the hash is missing or malformed.
 */
export function buildMagnet(infoHash, name = '') {
  if (!infoHash) return null;
  const hash = String(infoHash).trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(hash)) return null;

  const parts = [`magnet:?xt=urn:btih:${hash}`];
  if (name) parts.push(`dn=${encodeURIComponent(String(name).trim())}`);
  for (const tracker of TRACKERS) parts.push(`tr=${encodeURIComponent(tracker)}`);
  return parts.join('&');
}

export function infoHashOf(source) {
  if (!source) return null;
  const str = String(source);
  const magnet = str.match(/urn:btih:([a-f0-9]{40})/i);
  if (magnet) return magnet[1].toLowerCase();
  const url = str.match(/[?&](?:info_?hash|hash)=([a-f0-9]{40})/i);
  if (url) return url[1].toLowerCase();
  return null;
}

/** Characters Google Drive rejects in folder/file names, plus control chars. */
const ILLEGAL_NAME_CHARS = /[\\/:*?"<>|\x00-\x1F]/g;

/** Collapses whitespace and strips characters that break Drive names. */
export function sanitizeName(value, fallback = '') {
  const cleaned = String(value ?? '')
    .replace(ILLEGAL_NAME_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .trim();
  return cleaned || fallback;
}

/**
 * Downloads sometimes include covers, nfo files, or sample clips next to the
 * audio. Parts must look like real book files, not artwork.
 */
export function looksLikeAudioPart(filename) {
  const base = path.basename(filename || '');
  if (!isAudioFile(base)) return false;
  if (/\b(sample|preview|excerpt|trailer|teaser|bonus|cover|artwork)\b/i.test(base)) return false;
  return true;
}

/**
 * Recursively lists every audio file under a directory, largest first.
 *
 * Multi-book torrents (e.g. "[Books 1-3]") yield several .m4b files and each one
 * becomes its own library entry, so we return a list rather than picking one.
 */
export function listAudioParts(dir) {
  const results = [];
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && looksLikeAudioPart(entry.name)) results.push(full);
    }
  };
  walk(dir);
  return results;
}

// -------------------------------------------------------------
// Video Media Utilities for TV & Movies
// -------------------------------------------------------------
export const VIDEO_EXTS = ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v', '.flv', '.wmv', '.ts', '.mpg', '.mpeg'];

export function isVideoFile(filename) {
  return VIDEO_EXTS.includes(path.extname(filename || '').toLowerCase());
}

export function sanitizeCleanTitle(str) {
  if (!str) return '';
  let s = String(str);

  s = s.replace(/\.[a-z0-9]{2,5}$/i, '');
  s = s.replace(/[👤👥]\s*\d+/gu, ' ');
  s = s.replace(/\b(?:seeds?|peers?|leech(?:ers?)?)\s*[:#]?\s*\d+\b/gi, ' ');
  s = s.replace(/\b\d+\s*(?:seeds?|peers?|leech(?:ers?)?)\b/gi, ' ');
  s = s.replace(/\b\d+(?:\.\d+)?\s*(?:gb|mb|tb|gib|mib|tib|kb|kib|bytes|b)\b/gi, ' ');
  s = s.replace(/[\uFE00-\uFE0F]/gu, '');
  s = s.replace(/\p{Extended_Pictographic}|\p{Emoji_Presentation}|[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu, ' ');
  s = s.replace(/\[.*?\]/g, ' ');
  s = s.replace(/\b(2160p|1080p|720p|480p|360p|576p|4k|8k|uhd|fhd|hd|sd)\b/gi, ' ');
  s = s.replace(/\b(bluray|blu-ray|brrip|bdrip|webrip|web-dl|webdl|web|hdtv|hdrip|dvdrip|dvd|cam|ts|telesync)\b/gi, ' ');
  s = s.replace(/\b(x264|h264|x265|h265|hevc|avc|xvid|divx|10bit|8bit|hdr|hdr10|hdr10\+|dv|dolby\s*vision)\b/gi, ' ');
  s = s.replace(/\b(aac|dts|dts-hd|ac3|eac3|ddp?5\.1|truehd|atmos|mp3|flac|stereo|5\.1|7\.1)\b/gi, ' ');
  s = s.replace(/\b(yts|yify|eztv|rarbg|psa|galaxytv|tgx|ettv|vxt|ion10|tpb|syncopy|megusta|realdebrid)\b/gi, ' ');
  s = s.replace(/\b(proper|repack|rerip|remastered|extended|directors?\s*cut|unrated|uncut|complete|multi(?:-?sub)?)\b/gi, ' ');
  s = s.replace(/[._]/g, ' ');
  s = s.replace(/\s*-\s*/g, ' - ');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^[-:,\s]+|[-:,\s]+$/g, '').trim();

  return s;
}

export function cleanMovieFilenameForSearch(filename) {
  if (!filename) return { title: 'Movie', year: null };
  const yearMatch = filename.match(/\b(19\d\d|20\d\d)\b/);
  const year = yearMatch ? parseInt(yearMatch[1], 10) : null;

  let name = sanitizeCleanTitle(filename);
  if (year) {
    name = name.replace(new RegExp(`\\b${year}\\b`, 'g'), '').trim();
  }
  name = name.replace(/\s+/g, ' ').trim();
  return { title: name || 'Movie', year };
}

export function isTvShowEpisode(filename) {
  if (!filename) return false;
  return /[sS]\d+[\s._]*[eE]\d+/.test(filename) ||
    /\b\d+x\d+\b/.test(filename) ||
    /season[\s._]*\d+[\s._]*episode[\s._]*\d+/i.test(filename);
}

export function parseTvEpisode(filename) {
  if (!filename) return { season: 1, episode: 999, isSeasonPack: false };
  const m1 = filename.match(/[sS](\d+)[\s._]*[eE](\d+)/);
  if (m1) return { season: parseInt(m1[1], 10), episode: parseInt(m1[2], 10), isSeasonPack: false };
  const m2 = filename.match(/\b(\d+)x(\d+)\b/);
  if (m2) return { season: parseInt(m2[1], 10), episode: parseInt(m2[2], 10), isSeasonPack: false };
  const m3 = filename.match(/season[\s._]*(\d+)[\s._]*episode[\s._]*(\d+)/i);
  if (m3) return { season: parseInt(m3[1], 10), episode: parseInt(m3[2], 10), isSeasonPack: false };
  const m4 = filename.match(/(?:season[\s._]*(\d+)|[sS](\d+))\b/i);
  if (m4) {
    const s = parseInt(m4[1] || m4[2], 10);
    return { season: s, episode: 0, isSeasonPack: true };
  }
  return { season: 1, episode: 999, isSeasonPack: false };
}

export function parseTvShowName(filename) {
  if (!filename) return '';
  let name = filename.replace(/\.[^/.]+$/, '');
  const match = name.match(/^(.*?)(?:[sS]\d+[\s._]*[eE]\d+|[sS]\d+|\bseason[\s._]*\d+|\b\d+x\d+)/i);
  if (match) {
    if (!match[1].trim()) return '';
    name = match[1];
  }
  name = sanitizeCleanTitle(name);
  if (/^(s\d+e\d+|s\d+|\bseason[\s._]*\d+|\b\d+x\d+)$/i.test(name)) return '';
  return name.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

export function cleanMediaFilename(filename, fallbackShowName = '', hintMeta = {}, overrideExt = null) {
  if (!filename) return filename;

  let ext = overrideExt || path.extname(filename) || '.mp4';
  if (!ext.startsWith('.')) ext = '.' + ext;
  if (!VIDEO_EXTS.includes(ext.toLowerCase())) ext = '.mp4';

  let validFallback = fallbackShowName || hintMeta.showName || '';
  if (validFallback && /^(season[\s._]*\d+|s\d+|specials|extra|extras)$/i.test(validFallback.trim())) {
    validFallback = '';
  }

  const isTv = hintMeta.kind === 'tv' || isTvShowEpisode(filename) || !!validFallback || !!hintMeta.showName;

  if (isTv) {
    let rawShowName = hintMeta.showName || validFallback || parseTvShowName(filename);
    if (!rawShowName) rawShowName = parseTvShowName(filename) || 'TV Series';

    let showName = sanitizeCleanTitle(rawShowName);
    showName = showName.replace(/(?:[ ._-]+[sS]\d+[eE]\d+|[ ._-]+[sS]\d+|\bseason[\s._]*\d+|\b\d+x\d+).*$/i, '').trim();
    showName = showName.replace(/\s+\b(19\d\d|20\d\d)\b$/g, '').trim();
    showName = showName.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    if (!showName) showName = 'TV Series';

    const seasonMatch = filename.match(/[sS](\d+)[\s._]*[eE](\d+)/) ||
      filename.match(/\b(\d+)x(\d+)\b/) ||
      filename.match(/season[\s._]*(\d+)[\s._]*episode[\s._]*(\d+)/i);

    let seasonNum = hintMeta.season ? parseInt(hintMeta.season, 10) : (seasonMatch ? parseInt(seasonMatch[1], 10) : 1);
    let epNum = hintMeta.episode ? parseInt(hintMeta.episode, 10) : (seasonMatch ? parseInt(seasonMatch[2], 10) : 1);
    if (isNaN(seasonNum) || seasonNum < 1) seasonNum = 1;
    if (isNaN(epNum) || epNum < 1) epNum = 1;

    const sStr = String(seasonNum).padStart(2, '0');
    const eStr = String(epNum).padStart(2, '0');

    return `${showName} - S${sStr}E${eStr}${ext}`;
  }

  const movieSearch = cleanMovieFilenameForSearch(filename);
  let rawTitle = hintMeta.cleanTitle || hintMeta.title || movieSearch.title || path.basename(filename, path.extname(filename));

  let year = hintMeta.year || movieSearch.year;
  if (!year) {
    const ym = String(rawTitle + ' ' + filename).match(/\b(19\d\d|20\d\d)\b/);
    if (ym) year = parseInt(ym[1], 10);
  }

  let title = sanitizeCleanTitle(rawTitle);
  if (year) {
    title = title.replace(new RegExp(`\\b${year}\\b`, 'g'), '').trim();
    title = title.replace(/\(\s*\)/g, '').trim();
  }

  title = title.split(' ').filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  if (!title) title = 'Movie';

  if (year) {
    return `${title} (${year})${ext}`;
  }
  return `${title}${ext}`;
}

export function resolveMediaMeta(filename, kind = '', hintMeta = {}) {
  if (kind === 'tv' || (!kind && isTvShowEpisode(filename)) || hintMeta.showName) {
    const showName = hintMeta.showName || parseTvShowName(filename);
    const ep = (hintMeta.season && hintMeta.episode) ? { season: hintMeta.season, episode: hintMeta.episode } : parseTvEpisode(filename);
    return {
      kind: 'tv',
      showName: showName || 'TV Series',
      season: ep.season || 1,
      episode: ep.episode || 1
    };
  }
  const movieMeta = cleanMovieFilenameForSearch(filename);
  return {
    kind: 'movie',
    title: hintMeta.cleanTitle || hintMeta.title || movieMeta.title || filename.replace(/\.[^/.]+$/, '').replace(/[._]/g, ' '),
    year: hintMeta.year || movieMeta.year || null,
    genre: hintMeta.genre || null
  };
}