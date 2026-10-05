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