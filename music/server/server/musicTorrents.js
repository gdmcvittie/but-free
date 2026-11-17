/**
 * Music Torrent Feeds & Search Provider
 *
 * Integrates high-quality music torrent top feeds with persistent disk caching:
 * 1. Apibay Top 100 Category 104: Lossless FLAC releases
 * 2. Apibay Top 100 Category 101: Top MP3 releases
 * 3. Apibay Music Search: Search lossless or all music torrents
 * 4. Persistent local cache: stored in DATA_DIR/music_torrents_cache.json
 * 5. Retention filter: retains releases for X months (default 3) across overnight sweeps
 * 6. Background sweeper: sweeps Apibay on a configurable interval (default 30m)
 * 7. Cover art resolution: iTunes Search API with persistent disk caching
 */

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const CACHE_FILE = path.join(DATA_DIR, 'music_torrents_cache.json');

let cacheLoaded = false;
let cacheStore = {
  lastSwept: 0,
  lastFetched: { 104: 0, 101: 0 },
  items: {
    104: [],
    101: []
  }
};

const coverCache = new Map(); // "artist::album" -> url

function loadCache() {
  if (cacheLoaded) return cacheStore;
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        cacheStore = {
          lastSwept: parsed.lastSwept || 0,
          lastFetched: parsed.lastFetched || { 104: 0, 101: 0 },
          items: {
            104: Array.isArray(parsed.items?.['104']) ? parsed.items['104'] : [],
            101: Array.isArray(parsed.items?.['101']) ? parsed.items['101'] : []
          }
        };

        // Prepopulate coverCache from disk items
        for (const cat of ['104', '101']) {
          for (const it of cacheStore.items[cat]) {
            if (it?.coverUrl && it?.artist && it?.album) {
              const k = `${it.artist}::${it.album}`.toLowerCase().trim();
              coverCache.set(k, it.coverUrl);
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn('[MusicTorrents] Failed to read disk cache:', err.message);
  }
  cacheLoaded = true;
  return cacheStore;
}

function saveCache() {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cacheStore, null, 2), 'utf8');
  } catch (err) {
    console.warn('[MusicTorrents] Failed to write disk cache:', err.message);
  }
}

function formatBytes(bytes) {
  const b = parseInt(bytes, 10);
  if (isNaN(b) || b <= 0) return '';
  if (b >= 1024 * 1024 * 1024) {
    return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

export function parseMusicRelease(raw) {
  let clean = String(raw || '').trim();

  // Detect format
  let format = 'Lossless';
  if (/24[- ](?:bit|96|48|192|44)/i.test(clean) || /Hi-Res/i.test(clean)) {
    format = 'FLAC Hi-Res';
  } else if (/FLAC/i.test(clean)) {
    format = 'FLAC';
  } else if (/MP3|320/i.test(clean)) {
    format = 'MP3 320k';
  } else if (/AAC|M4A/i.test(clean)) {
    format = 'AAC';
  }

  // Strip leading group tag like [Group], (Group), etc.
  clean = clean.replace(/^\[[^\]]+\]\s*/, '');

  // Extract year
  const yearMatch = clean.match(/[\(\[]\s*(19\d{2}|20\d{2})\s*[\)\]]/) || clean.match(/\b(19\d{2}|20\d{2})\b/);
  const year = yearMatch ? yearMatch[1] : '';

  // Separate artist & album
  let artist = '';
  let album = '';
  if (clean.includes(' - ')) {
    const parts = clean.split(/\s+-\s+/);
    artist = parts[0].trim();
    album = parts.slice(1).join(' - ').trim();
  } else {
    album = clean;
  }

  // Clean metadata brackets and formatting from album name
  let cleanAlbum = album
    .replace(/\[.*?\]/g, '')
    .replace(/\(.*?\)/g, (m) => (/\b(19|20)\d{2}\b/.test(m) ? '' : m))
    .replace(/\b(FLAC|MP3|Hi-Res|Lossless|Remastered|REMASTER|Deluxe|Edition|Vinyl|WEB|CD|24[- ]\d+|320kbps|320k)\b/gi, '')
    .replace(/\s+\d{2,3}\s*$/, '') // Remove trailing release group numbers e.g. 88
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleanAlbum) cleanAlbum = album;

  return {
    artist: artist || 'Various Artists',
    album: cleanAlbum || clean,
    year,
    format
  };
}

async function resolveCoverArt(artist, album) {
  if (!album && !artist) return null;
  const cacheKey = `${artist || ''}::${album || ''}`.toLowerCase().trim();
  if (coverCache.has(cacheKey)) {
    return coverCache.get(cacheKey);
  }

  try {
    const term = `${artist} ${album}`.trim().slice(0, 100);
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=album&limit=1`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const data = await res.json();
      const artwork = data.results?.[0]?.artworkUrl100?.replace('100x100bb', '600x600bb') || null;
      coverCache.set(cacheKey, artwork);
      return artwork;
    }
  } catch {
    // cover lookup failed
  }

  coverCache.set(cacheKey, null);
  return null;
}

function mergeAndPruneItems(category, newlyFetched, retentionMonths = 3) {
  const catKey = String(category);
  const existing = cacheStore.items[catKey] || [];
  const map = new Map();

  // Load existing items into map
  for (const item of existing) {
    if (!item) continue;
    const key = item.infoHash || item.id;
    if (key) map.set(key, item);
  }

  // Merge newly fetched items
  for (const item of newlyFetched) {
    if (!item) continue;
    const key = item.infoHash || item.id;
    if (!key) continue;
    const prev = map.get(key);
    if (prev) {
      map.set(key, {
        ...prev,
        ...item,
        firstSeenAt: prev.firstSeenAt || Date.now(),
        coverUrl: prev.coverUrl || item.coverUrl || null
      });
    } else {
      map.set(key, {
        ...item,
        firstSeenAt: Date.now()
      });
    }
  }

  // Retention filter: prune items older than retentionMonths
  const cutoffMs = Date.now() - (retentionMonths * 30 * 24 * 60 * 60 * 1000);
  const merged = [];

  for (const item of map.values()) {
    let t = 0;
    if (item.firstSeenAt) {
      t = item.firstSeenAt;
    } else if (item.added) {
      t = item.added * 1000;
    }
    if (isNaN(t) || t <= 0) t = Date.now();
    if (t >= cutoffMs) {
      merged.push(item);
    }
  }

  // Sort: newest firstSeenAt first, then by seeders
  merged.sort((a, b) => {
    const timeA = a.firstSeenAt || (a.added ? a.added * 1000 : 0);
    const timeB = b.firstSeenAt || (b.added ? b.added * 1000 : 0);
    if (timeB !== timeA) return timeB - timeA;
    return (b.seeders || 0) - (a.seeders || 0);
  });

  cacheStore.items[catKey] = merged;
  saveCache();
  return merged;
}

async function resolveMissingCovers(items) {
  const missing = items.filter((i) => !i.coverUrl).slice(0, 30);
  if (!missing.length) return;
  let updated = false;
  await Promise.allSettled(
    missing.map(async (item) => {
      const cover = await resolveCoverArt(item.artist, item.album);
      if (cover) {
        item.coverUrl = cover;
        updated = true;
      }
    })
  );
  if (updated) {
    saveCache();
  }
}

export async function fetchAndAccumulate(category = 104, options = {}) {
  loadCache();
  const catKey = String(category);
  const retentionMonths = Math.max(1, parseInt(options.retentionMonths, 10) || 3);
  const forceRefresh = options.forceRefresh === true || options.force === true;
  const now = Date.now();
  const lastTime = cacheStore.lastFetched?.[catKey] || 0;

  // If not forcing refresh and fetched recently (< 10 min), return pruned cached items
  if (!forceRefresh && cacheStore.items[catKey]?.length > 0 && (now - lastTime < 10 * 60 * 1000)) {
    const cutoffMs = now - (retentionMonths * 30 * 24 * 60 * 60 * 1000);
    return (cacheStore.items[catKey] || []).filter((item) => {
      const t = item.firstSeenAt || (item.added ? item.added * 1000 : now);
      return t >= cutoffMs;
    });
  }

  // Fetch remote items from Apibay
  let newRawItems = [];
  try {
    const url = `https://apibay.org/precompiled/data_top100_${category}.json`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (FraudioMusic/1.0)' },
      signal: AbortSignal.timeout(10000)
    });

    if (res.ok) {
      const list = await res.json();
      if (Array.isArray(list)) {
        newRawItems = list
          .filter((item) => item && item.id !== 0 && item.id !== '0' && item.name !== 'No results returned')
          .map((item) => {
            const parsed = parseMusicRelease(item.name);
            const infoHash = String(item.info_hash || '').toLowerCase();
            const magnet = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(item.name)}`;
            return {
              id: `apibay_${item.id}`,
              title: item.name,
              artist: parsed.artist,
              album: parsed.album,
              year: parsed.year,
              format: parsed.format,
              size: formatBytes(item.size),
              sizeBytes: parseInt(item.size, 10) || 0,
              seeders: parseInt(item.seeders, 10) || 0,
              leechers: parseInt(item.leechers, 10) || 0,
              infoHash,
              magnet,
              added: item.added ? parseInt(item.added, 10) : 0,
              coverUrl: null,
              source: 'apibay',
              category: parseInt(category, 10)
            };
          });
      }
    }
  } catch (err) {
    console.warn(`[MusicTorrents] Remote fetch failed for cat ${category}:`, err.message);
  }

  // If remote returned items, merge into persistent cache
  if (newRawItems.length > 0) {
    if (!cacheStore.lastFetched) cacheStore.lastFetched = {};
    cacheStore.lastFetched[catKey] = now;
    const merged = mergeAndPruneItems(category, newRawItems, retentionMonths);
    resolveMissingCovers(merged).catch(() => {});
    return merged;
  }

  // Fallback to cache if remote failed
  const cutoffMs = now - (retentionMonths * 30 * 24 * 60 * 60 * 1000);
  return (cacheStore.items[catKey] || []).filter((item) => {
    const t = item.firstSeenAt || (item.added ? item.added * 1000 : now);
    return t >= cutoffMs;
  });
}

export async function searchTorrents(query, category = 104) {
  if (!query || typeof query !== 'string' || !query.trim()) return [];
  loadCache();

  const url = `https://apibay.org/q.php?q=${encodeURIComponent(query.trim())}&cat=${category}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (FraudioMusic/1.0)' },
    signal: AbortSignal.timeout(10000)
  });

  if (!res.ok) throw new Error(`Search returned HTTP ${res.status}`);
  const list = await res.json();
  if (!Array.isArray(list)) return [];

  const catKey = String(category);
  const cachedMap = new Map();
  for (const item of (cacheStore.items[catKey] || [])) {
    if (item.infoHash) cachedMap.set(item.infoHash.toLowerCase(), item);
  }

  const items = list
    .filter((item) => item && item.id !== 0 && item.id !== '0' && item.name !== 'No results returned')
    .map((item) => {
      const parsed = parseMusicRelease(item.name);
      const infoHash = String(item.info_hash || '').toLowerCase();
      const cached = cachedMap.get(infoHash);
      const magnet = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(item.name)}`;
      return {
        id: `apibay_${item.id}`,
        title: item.name,
        artist: parsed.artist,
        album: parsed.album,
        year: parsed.year,
        format: parsed.format,
        size: formatBytes(item.size),
        sizeBytes: parseInt(item.size, 10) || 0,
        seeders: parseInt(item.seeders, 10) || 0,
        leechers: parseInt(item.leechers, 10) || 0,
        infoHash,
        magnet,
        coverUrl: cached?.coverUrl || null,
        source: 'apibay'
      };
    });

  // Resolve cover art for top 10 search results lacking a cover
  const topSlice = items.filter((i) => !i.coverUrl).slice(0, 10);
  await Promise.allSettled(
    topSlice.map(async (item) => {
      item.coverUrl = await resolveCoverArt(item.artist, item.album);
    })
  );

  return items;
}

// -------------------------------------------------------------
// Background Sweeper
// -------------------------------------------------------------
let sweeperTimer = null;
let lastSweepTime = 0;

export function initBackgroundSweeper(options = {}) {
  if (sweeperTimer) clearInterval(sweeperTimer);

  loadCache();

  const getSettings = options.getSettings || (() => ({}));

  async function sweep() {
    try {
      const settings = getSettings() || {};
      const intervalMinutes = Math.max(5, parseInt(settings.musicTorrentsInterval, 10) || 30);
      const retentionMonths = Math.max(1, parseInt(settings.musicTorrentsRetentionMonths, 10) || 3);
      const intervalMs = intervalMinutes * 60 * 1000;
      const now = Date.now();

      if (now - lastSweepTime >= intervalMs) {
        lastSweepTime = now;
        cacheStore.lastSwept = now;
        console.log(`[MusicTorrents] Running background feed sweep (interval: ${intervalMinutes}m, retention: ${retentionMonths}mo)…`);

        const flac = await fetchAndAccumulate(104, { retentionMonths, forceRefresh: true });
        const mp3 = await fetchAndAccumulate(101, { retentionMonths, forceRefresh: true });

        console.log(`[MusicTorrents] Background sweep complete: ${flac.length} FLAC, ${mp3.length} MP3 cached.`);
      }
    } catch (err) {
      console.warn('[MusicTorrents] Background sweeper error:', err.message);
    }
  }

  // Initial sweep shortly after startup (15s)
  setTimeout(sweep, 15 * 1000);

  // Periodic interval check (every 60s)
  sweeperTimer = setInterval(sweep, 60 * 1000);
}

export function triggerImmediateSweep(options = {}) {
  const retentionMonths = Math.max(1, parseInt(options.retentionMonths, 10) || 3);
  return Promise.allSettled([
    fetchAndAccumulate(104, { retentionMonths, forceRefresh: true }),
    fetchAndAccumulate(101, { retentionMonths, forceRefresh: true })
  ]).then(() => {
    cacheStore.lastSwept = Date.now();
    saveCache();
  });
}

export function getStats(retentionMonths = 3) {
  loadCache();
  const cutoffMs = Date.now() - (retentionMonths * 30 * 24 * 60 * 60 * 1000);
  const flac = (cacheStore.items['104'] || []).filter((i) => {
    const t = i.firstSeenAt || (i.added ? i.added * 1000 : 0);
    return t >= cutoffMs;
  });
  const mp3 = (cacheStore.items['101'] || []).filter((i) => {
    const t = i.firstSeenAt || (i.added ? i.added * 1000 : 0);
    return t >= cutoffMs;
  });
  return {
    lastSwept: cacheStore.lastSwept || 0,
    lastFetchedFlac: cacheStore.lastFetched?.['104'] || 0,
    lastFetchedMp3: cacheStore.lastFetched?.['101'] || 0,
    countFlac: flac.length,
    countMp3: mp3.length
  };
}

export default {
  fetchAndAccumulate,
  searchTorrents,
  initBackgroundSweeper,
  triggerImmediateSweep,
  getStats,
  resolveCoverArt,
  parseMusicRelease
};
