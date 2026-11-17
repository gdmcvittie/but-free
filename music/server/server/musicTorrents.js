/**
 * Music Torrent Feeds & Search Provider
 *
 * Integrates high-quality music torrent top feeds:
 * 1. Apibay Top 100 Category 104: Lossless FLAC releases
 * 2. Apibay Top 100 Category 101: Top MP3 releases
 * 3. Apibay Music Search: Search lossless or all music torrents
 * 4. Cover art resolution: iTunes Search API cache
 */

const FEED_CACHE_MS = 15 * 60 * 1000; // 15 minutes cache
const feedCache = new Map(); // key -> { time, data }
const coverCache = new Map(); // "artist::album" or query -> url

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

export async function fetchApibayTop(category = 104, refresh = false) {
  const cacheKey = `apibay_${category}`;
  const now = Date.now();
  if (!refresh && feedCache.has(cacheKey)) {
    const hit = feedCache.get(cacheKey);
    if (now - hit.time < FEED_CACHE_MS) return hit.data;
  }

  const url = `https://apibay.org/precompiled/data_top100_${category}.json`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (FraudioMusic/1.0)' },
    signal: AbortSignal.timeout(10000)
  });

  if (!res.ok) throw new Error(`Apibay returned HTTP ${res.status}`);
  const list = await res.json();
  if (!Array.isArray(list)) return [];

  const items = list
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
        coverUrl: null,
        source: 'apibay',
        category
      };
    });

  // Batch-resolve cover art for first 25 items so the UI loads crisp covers fast
  const topSlice = items.slice(0, 25);
  await Promise.allSettled(
    topSlice.map(async (item) => {
      item.coverUrl = await resolveCoverArt(item.artist, item.album);
    })
  );

  feedCache.set(cacheKey, { time: now, data: items });
  return items;
}

export async function searchTorrents(query, category = 104) {
  if (!query || typeof query !== 'string' || !query.trim()) return [];

  const url = `https://apibay.org/q.php?q=${encodeURIComponent(query.trim())}&cat=${category}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (FraudioMusic/1.0)' },
    signal: AbortSignal.timeout(10000)
  });

  if (!res.ok) throw new Error(`Search returned HTTP ${res.status}`);
  const list = await res.json();
  if (!Array.isArray(list)) return [];

  const items = list
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
        coverUrl: null,
        source: 'apibay'
      };
    });

  // Resolve cover art for top 10 search results
  const topSlice = items.slice(0, 10);
  await Promise.allSettled(
    topSlice.map(async (item) => {
      item.coverUrl = await resolveCoverArt(item.artist, item.album);
    })
  );

  return items;
}

export default {
  fetchApibayTop,
  searchTorrents,
  resolveCoverArt,
  parseMusicRelease
};
