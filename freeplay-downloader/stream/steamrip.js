// =============================================================================
// STEAMRIP SCRAPER & DISCOVERY ENGINE (FREEPLAY DOWNLOADER)
// Scrapes pre-installed Steam PC games from steamrip.com
// Provides catalog caching, category filtering, search, and direct mirror extraction
// =============================================================================

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { electronBridge } from '../lib/electron-bridge.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const defaultStableDir = path.join(
  process.env.APPDATA || (process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : path.join(os.homedir(), '.config')),
  'Freeplay Downloader'
);

function getDataDir(customDir) {
  return customDir || process.env.DATA_DIR || defaultStableDir;
}

export const STEAMRIP_BASE_URL = 'https://steamrip.com';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 FreeplayDL/1.0';

/**
 * Checks if a URL belongs to steamrip.com
 */
export function isSteamripUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'steamrip.com' || host.endsWith('.steamrip.com');
  } catch (_) {
    return url.toLowerCase().includes('steamrip.com');
  }
}

/**
 * Cleans raw SteamRIP post titles for sleek UI display
 */
export function cleanSteamripTitle(title) {
  if (!title) return '';
  return title
    .replace(/^[\d\s|]+(?:GB|MB|KB)?\s*/i, '') // Remove leading "2024 | 94 GB"
    .replace(/\s*[-–—|]\s*SteamRIP(?:\.com)?\s*$/i, '')
    .replace(/\bFree\s*Download\b/gi, '')
    .replace(/\bPre-Installed\s*Game\b/gi, '')
    .replace(/\bDigital\s*Deluxe\s*Edition\b/gi, 'Deluxe Edition')
    .replace(/\bBuild\s*\d+\b/gi, '')
    .replace(/\bv?\d+(?:\.\d+)+(?:\/[a-zA-Z0-9.]+)?/g, '') // Remove version numbers
    .replace(/\(\s*\)/g, '')
    .replace(/\[\s*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parses human-readable size string (e.g. "73.1 GB") into numeric bytes
 */
export function parseSizeStringToBytes(sizeStr) {
  if (!sizeStr || typeof sizeStr !== 'string') return null;
  const match = sizeStr.trim().match(/^([\d.]+)\s*([KMGTP]?B?)$/i);
  if (!match) return null;
  const num = parseFloat(match[1]);
  const unit = (match[2] || 'B').toUpperCase();
  const scale = {
    'B': 1,
    'KB': 1024,
    'K': 1024,
    'MB': 1024 * 1024,
    'M': 1024 * 1024,
    'GB': 1024 * 1024 * 1024,
    'G': 1024 * 1024 * 1024,
    'TB': 1024 * 1024 * 1024 * 1024,
    'T': 1024 * 1024 * 1024 * 1024
  };
  return Math.round(num * (scale[unit] || 1));
}

function loadSteamripCache(dataDir) {
  const cacheFile = path.join(getDataDir(dataDir), 'steamrip_feed_cache.json');
  try {
    if (fs.existsSync(cacheFile)) {
      const raw = fs.readFileSync(cacheFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch (err) {
    console.warn('[SteamRIP Scraper] Failed to read feed cache:', err.message);
  }
  return { items: [], lastFetched: 0, title: 'SteamRIP.com', description: 'Pre-installed Steam Games', link: 'https://steamrip.com' };
}

function saveSteamripCache(cache, dataDir) {
  try {
    const dir = getDataDir(dataDir);
    const cacheFile = path.join(dir, 'steamrip_feed_cache.json');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2), 'utf8');
  } catch (err) {
    console.warn('[SteamRIP Scraper] Failed to save feed cache:', err.message);
  }
}

/**
 * Loads a SteamRIP URL in an offscreen Electron window and runs extraction logic.
 */
function runElectronPageExtraction(targetUrl, extractFnString, options = {}) {
  return new Promise((resolve, reject) => {
    const electron = electronBridge?.electron;
    if (!electron || !electron.BrowserWindow) {
      return reject(new Error('Electron BrowserWindow is not available. Please launch Freeplay Downloader via Electron.'));
    }

    let win = null;
    let resolved = false;
    let timeoutTimer = null;

    const cleanup = () => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      if (win && !win.isDestroyed()) {
        try { win.destroy(); } catch (_) {}
        win = null;
      }
    };

    const finish = (data) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(data);
    };

    const fail = (err) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      reject(err);
    };

    try {
      win = new electron.BrowserWindow({
        show: false,
        width: 1200,
        height: 800,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: false,
          javascript: true,
          webSecurity: false
        }
      });

      timeoutTimer = setTimeout(() => {
        fail(new Error(`SteamRIP page timed out after ${options.timeoutMs || 16000}ms`));
      }, options.timeoutMs || 16000);

      win.loadURL(targetUrl, {
        userAgent: BROWSER_UA,
        httpReferrer: 'https://steamrip.com/'
      }).catch(() => {});

      win.webContents.on('did-finish-load', async () => {
        try {
          // Allow Cloudflare or dynamic DOM elements a moment to settle
          await new Promise(r => setTimeout(r, options.settleMs || 800));
          if (resolved || !win || win.isDestroyed()) return;

          const result = await win.webContents.executeJavaScript(`(${extractFnString})()`);
          finish(result);
        } catch (err) {
          fail(err);
        }
      });

      win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
        if (isMainFrame && errorCode !== -3 && !resolved) {
          fail(new Error(`SteamRIP load failed: ${errorDescription} (${errorCode})`));
        }
      });

    } catch (err) {
      fail(err);
    }
  });
}

/**
 * Fetches the SteamRIP catalog or search results.
 */
export async function fetchSteamripFeed({
  forceRefresh = false,
  query = '',
  categoryFilter = '',
  retentionMonths = 3,
  page = 1,
  dataDir = null
} = {}) {
  const cache = loadSteamripCache(dataDir);
  const now = Date.now();
  const isSearch = Boolean(query && query.trim());
  const cleanQ = (query || '').trim();
  const cleanCat = (categoryFilter || '').trim().toLowerCase();

  // If main feed without search, return memory/disk cache if fresh (< 15 mins)
  if (!isSearch && !cleanCat && !forceRefresh && cache.items && cache.items.length > 0 && (now - (cache.lastFetched || 0) < 15 * 60 * 1000)) {
    return {
      title: cache.title || 'SteamRIP.com',
      description: cache.description || 'Pre-installed Steam PC Games',
      link: cache.link || 'https://steamrip.com',
      feedUrl: 'https://steamrip.com',
      itemsCount: cache.items.length,
      items: cache.items,
      cached: true
    };
  }

  // Determine target SteamRIP URL
  let targetUrl = 'https://steamrip.com/';
  if (isSearch) {
    targetUrl = page > 1
      ? `https://steamrip.com/page/${page}/?s=${encodeURIComponent(cleanQ)}`
      : `https://steamrip.com/?s=${encodeURIComponent(cleanQ)}`;
  } else if (cleanCat === 'top-games' || cleanCat === 'top') {
    targetUrl = 'https://steamrip.com/top-games/';
  } else if (cleanCat === 'updates' || cleanCat === 'updated-games') {
    targetUrl = 'https://steamrip.com/updated-games/';
  } else if (cleanCat) {
    const catSlug = cleanCat.replace(/\s+/g, '-');
    targetUrl = page > 1
      ? `https://steamrip.com/category/${catSlug}/page/${page}/`
      : `https://steamrip.com/category/${catSlug}/`;
  } else if (page > 1) {
    targetUrl = `https://steamrip.com/page/${page}/`;
  }

  console.log(`[SteamRIP Scraper] Fetching feed from: ${targetUrl}`);

  // Browser-based card extraction script
  const extractCardsScript = `
    function() {
      const items = [];
      const seen = new Set();
      document.querySelectorAll('.post-item, article.post').forEach(el => {
        const a = el.querySelector('h2.post-title a, h3.post-title a, a.post-thumb, a');
        if (!a || !a.href || !a.href.includes('steamrip.com')) return;
        const href = a.href;
        if (seen.has(href)) return;
        seen.add(href);

        const thumbA = el.querySelector('a.post-thumb');
        const rawTitle = (thumbA && thumbA.getAttribute('aria-label')) ||
                         (el.querySelector('.post-title') || {}).textContent ||
                         a.textContent || '';

        const img = el.querySelector('img');
        let imgSrc = '';
        if (img) {
          imgSrc = img.getAttribute('data-src') || img.getAttribute('data-src-webp') || img.src || '';
          if (imgSrc.startsWith('data:image')) {
            imgSrc = img.getAttribute('data-src') || '';
          }
        }

        // Game size: look for "73.1 GB" or "588 MB"
        let size = '';
        const sizeMatch = (el.textContent || '').match(/(\\d+(?:\\.\\d+)?\\s*(?:GB|MB|TB))/i);
        if (sizeMatch) size = sizeMatch[1];

        // Categories / tags
        const cats = Array.from(el.querySelectorAll('.post-cat, .category a, .post-cat-wrap span')).map(c => c.textContent.trim()).filter(Boolean);

        items.push({
          rawTitle: rawTitle.trim(),
          url: href,
          thumbnail: imgSrc,
          size: size,
          categories: cats
        });
      });
      return items;
    }
  `;

  let scrapedCards = [];
  try {
    scrapedCards = await runElectronPageExtraction(targetUrl, extractCardsScript, { timeoutMs: 18000, settleMs: 900 });
  } catch (scrapeErr) {
    console.warn(`[SteamRIP Scraper] Electron scrape failed for ${targetUrl}:`, scrapeErr.message);
    if (cache.items && cache.items.length > 0) {
      return {
        title: cache.title || 'SteamRIP.com',
        description: cache.description || '',
        link: cache.link || 'https://steamrip.com',
        feedUrl: targetUrl,
        itemsCount: cache.items.length,
        items: cache.items,
        cached: true,
        fallbackError: scrapeErr.message
      };
    }
    throw scrapeErr;
  }

  // Format and normalize items
  const normalizedItems = scrapedCards.map(card => {
    const cleanTitle = cleanSteamripTitle(card.rawTitle);
    const id = 'steamrip_' + crypto.createHash('md5').update(card.url).digest('hex').substring(0, 14);
    return {
      id,
      title: cleanTitle,
      rawTitle: card.rawTitle,
      link: card.url,
      thumbnail: card.thumbnail,
      size: card.size,
      sizeBytes: parseSizeStringToBytes(card.size),
      categories: card.categories || ['PC'],
      platform: 'PC STEAM',
      author: 'SteamRIP',
      pubDate: new Date().toISOString(),
      excerpt: card.size ? `Pre-installed Steam game (${card.size}) with direct unthrottled download mirrors.` : 'Pre-installed Steam PC game with direct mirrors.'
    };
  });

  // If this was a general fetch, update cache
  if (!isSearch && !cleanCat) {
    const existingMap = new Map((cache.items || []).map(i => [i.link, i]));
    for (const item of normalizedItems) {
      existingMap.set(item.link, item);
    }
    cache.items = Array.from(existingMap.values());
    cache.lastFetched = now;
    saveSteamripCache(cache, dataDir);
  }

  return {
    title: isSearch ? `SteamRIP search: "${query}"` : 'SteamRIP.com',
    description: isSearch ? `Found ${normalizedItems.length} Steam games` : 'Pre-installed Steam PC Games',
    link: targetUrl,
    feedUrl: targetUrl,
    itemsCount: normalizedItems.length,
    items: normalizedItems,
    cached: false
  };
}

/**
 * Scrapes a single SteamRIP game page for download buttons and mirrors.
 */
export async function scrapeSteamripPost(postUrl) {
  console.log(`[SteamRIP Scraper] Deep scraping post mirrors: ${postUrl}`);

  const extractPostScript = `
    function() {
      const title = (document.querySelector('h1.entry-title, h1') || {}).textContent || '';
      const heroImg = document.querySelector('.post-thumb img, .entry-thumb img, article img');
      const imgSrc = heroImg ? (heroImg.getAttribute('data-src') || heroImg.src || '') : '';

      // Extract Game Size & Details
      let gameSize = '';
      let version = '';
      let developer = '';
      let genre = '';

      document.querySelectorAll('p, .entry-content p').forEach(p => {
        const text = p.textContent || '';
        if (text.includes('Game Size:') || text.includes('Version:') || text.includes('Genre:')) {
          const sizeM = text.match(/Game Size:\\s*([\\d.]+\\s*(?:GB|MB|TB))/i);
          if (sizeM) gameSize = sizeM[1];

          const verM = text.match(/Version:\\s*([^\\n|]+)/i);
          if (verM) version = verM[1].trim();

          const devM = text.match(/Developer:\\s*([^\\n|]+)/i);
          if (devM) developer = devM[1].trim();

          const genM = text.match(/Genre:\\s*([^\\n|]+)/i);
          if (genM) genre = genM[1].trim();
        }
      });

      // Extract Download Buttons
      const buttons = [];
      const seenUrls = new Set();

      document.querySelectorAll('a.shortc-button, a[href*="bzzhr"], a[href*="buzzheavier"], a[href*="megadb"], a[href*="gofile"], a[href*="1fichier"], a[href*="fileditch"], a[href*="qiwi"], a[href*="fuckingfast"], a[href*="pixeldrain"], a[href*="torrent"], a[href^="magnet:"]').forEach(a => {
        const h = a.href || '';
        if (!h || seenUrls.has(h)) return;
        if (h.includes('discord.gg') || h.includes('steamrip.com') || h.includes('steamdb.info')) return;
        seenUrls.add(h);

        const parent = a.parentElement;
        const parentText = parent ? parent.textContent.trim().replace(/\\s+/g, ' ') : '';
        const prev = parent ? parent.previousElementSibling : null;
        const prevText = prev ? prev.textContent.trim().replace(/\\s+/g, ' ') : '';

        buttons.push({
          href: h,
          text: a.textContent.trim(),
          parentText: parentText,
          prevText: prevText
        });
      });

      return {
        rawTitle: title.trim(),
        heroImg: imgSrc,
        gameSize: gameSize,
        version: version,
        developer: developer,
        genre: genre,
        buttons: buttons
      };
    }
  `;

  const scraped = await runElectronPageExtraction(postUrl, extractPostScript, { timeoutMs: 16000, settleMs: 600 });
  const cleanTitle = cleanSteamripTitle(scraped.rawTitle);

  // Classify and structure download links
  const links = [];
  let linkIdx = 0;

  for (const btn of scraped.buttons) {
    linkIdx++;
    const url = btn.href;
    const lowerUrl = url.toLowerCase();
    const parentLower = (btn.parentText || '').toLowerCase();

    let hoster = 'other';
    let hosterName = 'Mirror';
    let recommended = false;
    let badge = 'Direct Download';

    if (lowerUrl.includes('bzzhr.to') || lowerUrl.includes('buzzheavier.com') || parentLower.includes('bzzhr') || parentLower.includes('buzzheavier')) {
      hoster = 'buzzheavier';
      hosterName = 'Buzzheavier (BZZHR)';
      recommended = true;
      badge = '⚡ Fastest Unthrottled';
    } else if (lowerUrl.includes('fileditch') || parentLower.includes('fileditch')) {
      hoster = 'fileditch';
      hosterName = 'FileDitch';
      recommended = true;
      badge = '⚡ Direct Archive';
    } else if (lowerUrl.includes('gofile.io') || parentLower.includes('gofile')) {
      hoster = 'gofile';
      hosterName = 'GoFile';
      badge = 'High Speed';
    } else if (lowerUrl.includes('megadb') || parentLower.includes('megadb')) {
      hoster = 'megadb';
      hosterName = 'MegaDB';
      badge = 'Mirror';
    } else if (lowerUrl.includes('1fichier') || parentLower.includes('1fichier')) {
      hoster = '1fichier';
      hosterName = '1fichier';
      badge = 'Mirror';
    } else if (lowerUrl.includes('pixeldrain') || parentLower.includes('pixeldrain')) {
      hoster = 'pixeldrain';
      hosterName = 'PixelDrain';
      badge = 'Mirror';
    } else if (lowerUrl.includes('fuckingfast.co') || parentLower.includes('fuckingfast')) {
      hoster = 'fuckingfast';
      hosterName = 'FuckingFast';
      badge = 'Fast DDL';
    } else if (lowerUrl.startsWith('magnet:') || lowerUrl.includes('.torrent') || parentLower.includes('torrent')) {
      hoster = 'torrent';
      hosterName = 'Torrent / P2P';
      badge = 'Torrent';
    }

    // Determine part or mirror label
    let partLabel = '';
    const partMatch = (btn.text || btn.parentText || url).match(/part\s*0?(\d+)/i);
    if (partMatch) {
      partLabel = `Part ${partMatch[1]}`;
    }

    const titlePrefix = `[${hosterName}]`;
    const fullTitle = `${titlePrefix} ${cleanTitle}${partLabel ? ' (' + partLabel + ')' : ''}${scraped.gameSize ? ' [' + scraped.gameSize + ']' : ''}`;

    links.push({
      id: `steamrip_link_${linkIdx}_` + crypto.createHash('md5').update(url).digest('hex').substring(0, 8),
      title: fullTitle,
      url: url,
      hoster: hoster,
      hosterName: hosterName,
      badge: badge,
      recommended: recommended,
      part: partLabel,
      size: scraped.gameSize || null,
      gameFolder: cleanTitle.replace(/[^a-zA-Z0-9_-]/g, '_')
    });
  }

  // Sort so recommended links (Buzzheavier & FileDitch) appear at the very top
  links.sort((a, b) => {
    if (a.recommended && !b.recommended) return -1;
    if (!a.recommended && b.recommended) return 1;
    return 0;
  });

  return {
    title: cleanTitle,
    rawTitle: scraped.rawTitle,
    size: scraped.gameSize || null,
    version: scraped.version || null,
    developer: scraped.developer || null,
    genre: scraped.genre || null,
    image: scraped.heroImg || null,
    links: links
  };
}
