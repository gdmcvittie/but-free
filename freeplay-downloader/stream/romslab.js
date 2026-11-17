// =============================================================================
// ROMSLAB SCRAPER & FEED DISCOVERY (FREEPLAY DOWNLOADER)
// Scrapes Nintendo Switch, Console, and Retro ROMs from romslab.com
// Provides feed caching, search, category filtering, and direct link extraction
// =============================================================================

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const defaultStableDir = path.join(
  process.env.APPDATA || (process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : path.join(os.homedir(), '.config')),
  'Freeplay Downloader'
);

function getDataDir(customDir) {
  return customDir || process.env.DATA_DIR || defaultStableDir;
}

export const ROMSLAB_FEED_URL = 'https://romslab.com/feed/';
const UA_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function decodeHtmlEntities(str) {
  if (!str) return '';
  return str
    .replace(/&#8211;/g, '–')
    .replace(/&#8212;/g, '—')
    .replace(/&#8216;/g, '‘')
    .replace(/&#8217;/g, '’')
    .replace(/&#8220;/g, '“')
    .replace(/&#8221;/g, '”')
    .replace(/&#8230;/g, '…')
    .replace(/&#038;/g, '&')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(dec))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function getXmlTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i')) ||
                xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? match[1].trim() : null;
}

export function cleanRomslabTitle(title) {
  if (!title) return '';
  const decoded = decodeHtmlEntities(title);
  return decoded
    .replace(/\s*[-–—|]\s*Romslab(?:\.com)?\s*$/i, '')
    .replace(/→.*$/g, '')
    .replace(/\b(Switch\s*2\s*(?:NUP|NSP|XCI)?)\b/gi, '')
    .replace(/\b(Switch\s*(?:NSP|XCI|NUP)?)\b/gi, '')
    .replace(/\b(PS[45]\s*(?:PKG)?)\b/gi, '')
    .replace(/\b(Free\s*Download)\b/gi, '')
    .replace(/\b(Update(?:\s*v?[\d.]+)?(?:\s*\+\s*DLCs?)?)\b/gi, '')
    .replace(/\b(DLCs?)\b/gi, '')
    .replace(/\b(NSP|XCI|NUP|PKG)\b/gi, '')
    .replace(/\b(Romslab)\b/gi, '')
    .replace(/\s*[→+|-]\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function detectPlatform(title, categories = []) {
  const combined = (String(title || '') + ' ' + (categories || []).join(' ')).toLowerCase();
  if (combined.includes('switch 2')) return 'Switch 2';
  if (combined.includes('switch')) return 'Nintendo Switch';
  if (combined.includes('ps5') || combined.includes('playstation 5')) return 'PlayStation 5';
  if (combined.includes('ps4') || combined.includes('playstation 4')) return 'PlayStation 4';
  if (combined.includes('ps3') || combined.includes('playstation 3')) return 'PlayStation 3';
  if (combined.includes('ps2') || combined.includes('playstation 2')) return 'PlayStation 2';
  if (combined.includes('wii u') || combined.includes('wiiu')) return 'Wii U';
  if (combined.includes('wii')) return 'Wii';
  if (combined.includes('gamecube') || combined.includes('gc')) return 'GameCube';
  if (combined.includes('3ds')) return 'Nintendo 3DS';
  if (combined.includes('nds') || combined.includes('nintendo ds')) return 'Nintendo DS';
  if (combined.includes('gba') || combined.includes('game boy advance')) return 'Game Boy Advance';
  return 'Nintendo Switch';
}

export function isRomslabUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'romslab.com' || host.endsWith('.romslab.com');
  } catch (_) {
    return url.toLowerCase().includes('romslab.com');
  }
}

// -------------------------------------------------------------
// Feed Disk Caching
// -------------------------------------------------------------

function loadRomslabCache(dataDir) {
  const cacheFile = path.join(getDataDir(dataDir), 'romslab_feed_cache.json');
  try {
    if (fs.existsSync(cacheFile)) {
      const raw = fs.readFileSync(cacheFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch (err) {
    console.warn('[Romslab Scraper] Failed to read feed cache:', err.message);
  }
  return { items: [], lastFetched: 0, title: 'Romslab.com', description: 'ROMs & Switch Games', link: 'https://romslab.com' };
}

function saveRomslabCache(cache, dataDir) {
  const dir = getDataDir(dataDir);
  const cacheFile = path.join(dir, 'romslab_feed_cache.json');
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2), 'utf8');
  } catch (err) {
    console.warn('[Romslab Scraper] Failed to save feed cache:', err.message);
  }
}

// -------------------------------------------------------------
// Feed Fetcher (with disk persistence, search, pagination & retention)
// -------------------------------------------------------------

export async function fetchRomslabFeed({ forceRefresh = false, query = '', platformFilter = '', retentionMonths = 3, page = 1, dataDir = null } = {}) {
  const isSearch = Boolean(query && query.trim());
  const cache = loadRomslabCache(dataDir);
  const now = Date.now();

  // If main feed (no query) and cached recently (< 10 min) without forceRefresh, return cached
  if (!isSearch && !forceRefresh && page === 1 && cache.items && cache.items.length > 0 && (now - (cache.lastFetched || 0) < 10 * 60 * 1000)) {
    const cutoffMs = now - (retentionMonths * 30 * 24 * 60 * 60 * 1000);
    let validItems = cache.items.filter(item => {
      let t = item.pubDate ? new Date(item.pubDate).getTime() : 0;
      if (isNaN(t) || t <= 0) t = item.firstSeenAt ? new Date(item.firstSeenAt).getTime() : now;
      return t >= cutoffMs;
    });

    if (platformFilter && platformFilter !== 'all') {
      const pf = platformFilter.toLowerCase();
      validItems = validItems.filter(it => (it.platform || '').toLowerCase().includes(pf));
    }

    return {
      title: cache.title || 'Romslab.com',
      description: cache.description || 'ROMs & Switch Games',
      link: cache.link || 'https://romslab.com',
      itemsCount: validItems.length,
      items: validItems,
      cached: true
    };
  }

  let targetUrl;
  if (isSearch) {
    const q = encodeURIComponent(query.trim());
    targetUrl = page > 1 ? `https://romslab.com/page/${page}/?s=${q}&feed=rss2` : `https://romslab.com/?s=${q}&feed=rss2`;
  } else {
    targetUrl = page > 1 ? `https://romslab.com/feed/?paged=${page}` : ROMSLAB_FEED_URL;
  }

  let xmlString = null;
  let fetchError = null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    const response = await fetch(targetUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': UA_BROWSER,
        'Accept': 'application/rss+xml, application/xml, text/xml, */*'
      }
    });
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`Romslab responded with HTTP ${response.status}`);
    }
    xmlString = await response.text();
  } catch (err) {
    fetchError = err;
    console.warn('[Romslab Scraper] Feed fetch error:', err.message);
  }

  if (!xmlString) {
    if (cache.items && cache.items.length > 0) {
      let validItems = cache.items;
      if (platformFilter && platformFilter !== 'all') {
        const pf = platformFilter.toLowerCase();
        validItems = validItems.filter(it => (it.platform || '').toLowerCase().includes(pf));
      }
      return {
        title: cache.title || 'Romslab.com',
        description: cache.description || '',
        link: cache.link || 'https://romslab.com',
        itemsCount: validItems.length,
        items: validItems,
        cached: true,
        stale: true,
        fetchError: fetchError?.message
      };
    }
    throw fetchError || new Error('Failed to fetch Romslab feed XML');
  }

  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  const fetchedItems = [];
  let match;

  while ((match = itemRegex.exec(xmlString)) !== null && fetchedItems.length < 50) {
    const itemXml = match[1];
    const rawTitle = decodeHtmlEntities(getXmlTag(itemXml, 'title') || 'Untitled Game');
    const cleanTitle = cleanRomslabTitle(rawTitle);
    const link = (getXmlTag(itemXml, 'link') || '').replace(/&amp;/g, '&').trim();
    const pubDate = getXmlTag(itemXml, 'pubDate') || '';
    const author = getXmlTag(itemXml, 'dc:creator') || 'Romslab';

    const categories = [...itemXml.matchAll(/<category><!\[CDATA\[(.*?)\]\]><\/category>/gi)].map(m => decodeHtmlEntities(m[1].trim()));
    const platform = detectPlatform(rawTitle, categories);

    let thumbnail = null;
    const imgMatches = [...itemXml.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map(m => m[1]);
    if (imgMatches.length > 0) {
      thumbnail = imgMatches.find(src => /cover|body.*1/i.test(src)) || imgMatches[0];
    }

    const rawDesc = getXmlTag(itemXml, 'description') || '';
    const cleanExcerpt = decodeHtmlEntities(rawDesc)
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 220);

    const isUpdate = /\bupdate\b/i.test(rawTitle);

    fetchedItems.push({
      id: 'romslab_' + crypto.createHash('md5').update(link || rawTitle).digest('hex').substring(0, 14),
      title: rawTitle,
      cleanTitle,
      link,
      pubDate,
      firstSeenAt: Date.now(),
      author,
      thumbnail,
      categories,
      platform,
      isUpdate,
      excerpt: cleanExcerpt
    });
  }

  if (!isSearch && page === 1 && fetchedItems.length > 0) {
    const existingMap = new Map((cache.items || []).map(i => [i.id || i.link, i]));
    for (const item of fetchedItems) {
      const key = item.id || item.link;
      const existing = existingMap.get(key);
      if (existing) {
        existingMap.set(key, { ...existing, ...item, firstSeenAt: existing.firstSeenAt || item.firstSeenAt });
      } else {
        existingMap.set(key, item);
      }
    }

    const cutoffMs = now - (retentionMonths * 30 * 24 * 60 * 60 * 1000);
    const merged = Array.from(existingMap.values())
      .filter(item => {
        let t = item.pubDate ? new Date(item.pubDate).getTime() : 0;
        if (isNaN(t) || t <= 0) t = item.firstSeenAt ? new Date(item.firstSeenAt).getTime() : now;
        return t >= cutoffMs;
      })
      .sort((a, b) => {
        const timeA = a.pubDate ? new Date(a.pubDate).getTime() : (a.firstSeenAt || 0);
        const timeB = b.pubDate ? new Date(b.pubDate).getTime() : (b.firstSeenAt || 0);
        return timeB - timeA;
      });

    cache.items = merged;
    cache.lastFetched = now;
    saveRomslabCache(cache, dataDir);

    let returnItems = merged;
    if (platformFilter && platformFilter !== 'all') {
      const pf = platformFilter.toLowerCase();
      returnItems = returnItems.filter(it => (it.platform || '').toLowerCase().includes(pf));
    }

    return {
      title: 'Romslab.com',
      description: 'ROMs & Switch Games',
      link: 'https://romslab.com',
      itemsCount: returnItems.length,
      items: returnItems,
      cached: false
    };
  }

  let finalItems = fetchedItems;
  if (platformFilter && platformFilter !== 'all') {
    const pf = platformFilter.toLowerCase();
    finalItems = finalItems.filter(it => (it.platform || '').toLowerCase().includes(pf));
  }

  return {
    title: isSearch ? `Search results for "${query}"` : 'Romslab.com',
    description: isSearch ? `Found ${finalItems.length} items on Romslab` : 'ROMs & Switch Games',
    link: targetUrl,
    itemsCount: finalItems.length,
    items: finalItems,
    cached: false
  };
}

// -------------------------------------------------------------
// Post Page Scraper (extracts detailed metadata & all download links)
// -------------------------------------------------------------

export async function scrapeRomslabPost(postUrl) {
  if (!postUrl) throw new Error('Post URL is required');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  const response = await fetch(postUrl, {
    signal: controller.signal,
    headers: {
      'User-Agent': UA_BROWSER,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }
  });
  clearTimeout(timeout);

  if (!response.ok) {
    throw new Error(`Romslab page responded with HTTP ${response.status}`);
  }

  const html = await response.text();

  const rcfMatch = html.match(/var\s+rcfGameInfo\s*=\s*(\{[\s\S]*?\});/);
  let rcf = {};
  if (rcfMatch) {
    try { rcf = JSON.parse(rcfMatch[1]); } catch (_) {}
  }

  const ogImage = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
                  html.match(/<img[^>]+class=["'][^"']*wp-post-image[^"']*["'][^>]+src=["']([^"']+)["']/i)?.[1] ||
                  null;

  const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1] || '';
  const titleTagMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const rawTitle = decodeHtmlEntities((ogTitle || (titleTagMatch ? titleTagMatch[1] : '')).replace(/<[^>]+>/g, '').trim());
  const cleanTitle = cleanRomslabTitle(rawTitle);

  let platform = rcf.platform || '';
  if (!platform) {
    platform = detectPlatform(rawTitle);
  }

  const ogDesc = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)?.[1] || '';

  const btnsContainerMatch = html.match(/<div[^>]*class=["'][^"']*\bbtns\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
  const searchArea = btnsContainerMatch ? btnsContainerMatch[1] : html;

  const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const links = [];
  const seenUrls = new Set();
  let m;

  while ((m = linkRegex.exec(searchArea)) !== null) {
    const href = m[1].replace(/&amp;/g, '&').trim();
    const text = decodeHtmlEntities(m[2].replace(/<[^>]+>/g, '').trim());

    if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;
    if (href.includes('discord.gg') || href.includes('romslab.com/community') ||
        href.includes('twitter.com') || href.includes('facebook.com') ||
        href.includes('reddit.com') || href.includes('digg.com') ||
        href.includes('stumbleupon.com') || href.includes('delicious.com')) {
      continue;
    }

    if (href.includes('romslab.com/') && !href.includes('/download')) continue;

    if (seenUrls.has(href)) continue;
    seenUrls.add(href);

    let filename = '';
    try {
      const decodedPath = decodeURIComponent(href);
      const parts = decodedPath.split('?')[0].split('/');
      const last = parts[parts.length - 1];
      if (last && (last.endsWith('.rar') || last.endsWith('.zip') || last.endsWith('.7z') || last.endsWith('.nsp') || last.endsWith('.xci'))) {
        filename = last;
      }
    } catch (_) {}

    let type = 'base';
    let label = text || 'Download';
    const lowerText = text.toLowerCase();
    const lowerHref = href.toLowerCase();

    if (lowerText.includes('update') || lowerHref.includes('update')) {
      type = 'update';
      label = 'Update';
    } else if (lowerText.includes('dlc') || lowerHref.includes('dlc')) {
      type = 'dlc';
      label = "DLC's";
    } else if (lowerText.includes('mirror') || lowerText.includes('mirror 2')) {
      type = 'mirror';
      label = text || 'Mirror';
    } else if (lowerText.includes('download here') || lowerHref.includes('base')) {
      type = 'base';
      label = 'Base Game';
    }

    let hoster = 'Direct Link';
    if (lowerHref.includes('datanodes.to')) hoster = 'DataNodes';
    else if (lowerHref.includes('filekeeper.net')) hoster = 'FileKeeper';
    else if (lowerHref.includes('1fichier.com')) hoster = '1Fichier';
    else if (lowerHref.includes('mega.nz') || lowerHref.includes('mega.co.nz')) hoster = 'MEGA';
    else if (lowerHref.includes('mediafire.com')) hoster = 'MediaFire';
    else if (lowerHref.includes('gofile.io')) hoster = 'Gofile';
    else if (lowerHref.includes('pixeldrain.com')) hoster = 'PixelDrain';
    else if (lowerHref.startsWith('magnet:')) hoster = 'BitTorrent Magnet';
    else if (lowerHref.includes('.torrent')) hoster = 'BitTorrent';

    links.push({
      id: 'romslink_' + Math.random().toString(36).substring(2, 9),
      url: href,
      label,
      type,
      hoster,
      text,
      filename: filename || `${cleanTitle} (${label})`
    });
  }

  return {
    url: postUrl,
    rawTitle,
    cleanTitle,
    platform,
    developer: rcf.developer || null,
    publisher: rcf.publisher || null,
    genres: rcf.genres || null,
    releaseDate: rcf.releaseDate || null,
    coverImage: ogImage,
    description: ogDesc,
    links,
    linksCount: links.length
  };
}
