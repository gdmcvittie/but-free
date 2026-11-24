// =============================================================================
// MODERN PC GAMES DDL SITES SCRAPER & DISCOVERY ENGINE (FREEPLAY DOWNLOADER)
// Supports all 21 Direct Download (DDL) sites from the Rentry Megathread:
// https://rentry.org/pgames#direct-download-ddl-sites
// =============================================================================

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { electronBridge } from '../lib/electron-bridge.js';
import {
  decodeHtmlEntities,
  getXmlTag,
  extractThumbnailAndWebm,
  classifyDownloadUrl
} from './link-utils.js';
import {
  isSteamripUrl,
  fetchSteamripFeed,
  scrapeSteamripPost,
  parseSizeStringToBytes,
  cleanSteamripTitle
} from './steamrip.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const defaultStableDir = path.join(
  process.env.APPDATA || (process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : path.join(os.homedir(), '.config')),
  'Freeplay Downloader'
);

function getDataDir(customDir) {
  return customDir || process.env.DATA_DIR || defaultStableDir;
}

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 FreeplayDL/1.0';

// ── Catalog of Modern PC Games DDL Sites from Rentry ───────────────────────
export const MODERN_PC_SITES = [
  {
    key: 'ovagames',
    name: 'OvaGames',
    badge: 'OVAGAMES',
    badgeColor: '#10b981',
    description: 'Pre-installed & ElAmigos PC Games (Direct Mirrors: Google Drive, Datanodes, Mediafire)',
    url: 'https://www.ovagames.com/',
    feedUrl: 'https://www.ovagames.com/feed',
    searchFeed: 'https://www.ovagames.com/search/{query}/feed/rss2/',
    searchUrl: 'https://www.ovagames.com/?s={query}',
    type: 'ddl',
    hasSearch: true
  },
  {
    key: 'gload',
    name: 'GLOAD',
    badge: 'GLOAD',
    badgeColor: '#f59e0b',
    description: 'Scene & P2P PC Game Releases (DDownload, Rapidgator, Buzzheavier)',
    url: 'https://gload.cc/',
    feedUrl: 'https://gload.cc/feed/',
    searchFeed: 'https://gload.cc/?s={query}&feed=rss2',
    searchUrl: 'https://gload.cc/?s={query}',
    type: 'ddl',
    hasSearch: true
  },
  {
    key: 'online-fix',
    name: 'Online-Fix',
    badge: 'ONLINE-FIX',
    badgeColor: '#3b82f6',
    description: 'Multiplayer & Co-op Steam/LAN Fixes and Game Releases',
    url: 'https://online-fix.me/',
    feedUrl: 'https://online-fix.me/rss.xml',
    searchUrl: 'https://online-fix.me/index.php?do=search&subaction=search&story={query}',
    type: 'ddl',
    hasSearch: true
  },
  {
    key: 'steamrip',
    name: 'SteamRIP',
    badge: 'STEAMRIP',
    badgeColor: '#31a8ff',
    description: 'Pre-installed Steam PC Games with Unthrottled Mirrors (Buzzheavier & FileDitch)',
    url: 'https://steamrip.com/',
    type: 'ddl',
    hasSearch: true
  },
  {
    key: 'scnlog',
    name: 'SCNLOG.ME',
    badge: 'SCNLOG',
    badgeColor: '#a855f7',
    description: 'Scene Release Logs & Direct Downloads (1fichier, Rapidgator, DDownload)',
    url: 'https://scnlog.me/',
    feedUrl: 'https://scnlog.me/feed/',
    searchFeed: 'https://scnlog.me/?s={query}&feed=rss2',
    searchUrl: 'https://scnlog.me/?s={query}',
    type: 'ddl',
    hasSearch: true
  },
  {
    key: 'gog-rev',
    name: 'GoG Revived',
    badge: 'GOG REVIVED',
    badgeColor: '#ec4899',
    description: 'DRM-Free GOG Installers, Goodies & Game Updates',
    url: 'https://gog-rev.com/',
    searchUrl: 'https://gog-rev.com/?s={query}',
    type: 'ddl',
    hasSearch: true
  },
  {
    key: 'gog-archive',
    name: 'GOG Archive',
    badge: 'GOG ARCHIVE',
    badgeColor: '#6366f1',
    description: 'Complete GOG Game Archive Directory (squid.wtf)',
    url: 'https://gog.squid.wtf/',
    type: 'ddl',
    hasSearch: true
  },
  {
    key: 'ankergames',
    name: 'Ankergames',
    badge: 'ANKERGAMES',
    badgeColor: '#14b8a6',
    description: 'Direct PC Game Downloads & Repacks',
    url: 'https://ankergames.net/',
    altUrl: 'https://ankergames.to/',
    searchUrl: 'https://ankergames.net/?s={query}',
    type: 'ddl',
    hasSearch: true
  },
  {
    key: 'appnetica',
    name: 'Appnetica',
    badge: 'APPNETICA',
    badgeColor: '#8b5cf6',
    description: 'Clean PC Games and Software Downloads',
    url: 'https://appnetica.com/',
    searchUrl: 'https://appnetica.com/?s={query}',
    type: 'ddl',
    hasSearch: true
  },
  {
    key: 'astralgames',
    name: 'AstralGames',
    badge: 'ASTRAL',
    badgeColor: '#06b6d4',
    description: 'Pre-installed & Repacked PC Game Downloads',
    url: 'https://astralgames.net/',
    searchUrl: 'https://astralgames.net/?s={query}',
    type: 'ddl',
    hasSearch: true
  },
  {
    key: 'cracked-games',
    name: 'Cracked-Games',
    badge: 'CRACKED-G',
    badgeColor: '#ef4444',
    description: 'Cracked PC Games & Scene Releases',
    url: 'https://cracked-games.org/',
    searchUrl: 'https://cracked-games.org/?s={query}',
    type: 'ddl',
    hasSearch: true
  },
  {
    key: 'cs-rin-ru',
    name: 'CS.RIN.RU',
    badge: 'CS.RIN.RU',
    badgeColor: '#eab308',
    description: 'Steam Underground Community Forum & Clean Steam Files',
    url: 'https://cs.rin.ru/forum/',
    searchUrl: 'https://cs.rin.ru/forum/search.php?keywords={query}',
    type: 'community',
    hasSearch: true
  },
  {
    key: 'cs-rin-gog',
    name: 'CS.RIN.RU GOG Collection',
    badge: 'RIN GOG',
    badgeColor: '#ca8a04',
    description: 'CS.RIN.RU GOG Games Complete Collection thread',
    url: 'https://cs.rin.ru/forum/viewtopic.php?f=38&t=136823',
    type: 'community',
    hasSearch: false
  },
  {
    key: 'downloadha',
    name: 'DownloadHa',
    badge: 'DOWNLOADHA',
    badgeColor: '#10b981',
    description: 'PC Computer Game Direct Archive (Split RAR Mirrors)',
    url: 'https://www.downloadha.com/category/%d8%a8%d8%a7%d8%b2%db%8c-%da%a9%d8%a7%d9%85%d9%be%db%8c%d9%88%d8%aa%d8%b1-pc-computer-game/',
    searchUrl: 'https://www.downloadha.com/?s={query}',
    type: 'ddl',
    hasSearch: true
  },
  {
    key: 'g4u',
    name: 'G4U',
    badge: 'G4U',
    badgeColor: '#f97316',
    description: 'Games for You PC Scene Releases & Direct Mirrors',
    url: 'https://g4u.to/',
    searchUrl: 'https://g4u.to/?s={query}',
    type: 'ddl',
    hasSearch: true
  },
  {
    key: 'gamebounty',
    name: 'GameBounty',
    badge: 'GAMEBOUNTY',
    badgeColor: '#84cc16',
    description: 'PC Game Releases Direct Downloads',
    url: 'https://gamebounty.site/',
    searchUrl: 'https://gamebounty.site/?s={query}',
    type: 'ddl',
    hasSearch: true
  },
  {
    key: 'rlsbb',
    name: 'RLSBB',
    badge: 'RLSBB',
    badgeColor: '#0ea5e9',
    description: 'Release BB Direct Download Mirrors & Scene Releases',
    url: 'https://rlsbb.ru/',
    searchUrl: 'https://rlsbb.ru/?s={query}',
    type: 'ddl',
    hasSearch: true
  },
  {
    key: 'scene-cat',
    name: 'Scene.Cat',
    badge: 'SCENE.CAT',
    badgeColor: '#f43f5e',
    description: 'Scene Releases & Fast Mirrors (formerly Gamesdrive)',
    url: 'https://scene.cat/',
    searchUrl: 'https://scene.cat/?s={query}',
    type: 'ddl',
    hasSearch: true
  },
  {
    key: 'scene-rls',
    name: 'Scene Release',
    badge: 'SCENE-RLS',
    badgeColor: '#d946ef',
    description: 'Scene Releases PC Game Mirrors',
    url: 'https://scene-rls.net/',
    searchUrl: 'https://scene-rls.net/?s={query}',
    type: 'ddl',
    hasSearch: true
  },
  {
    key: 'torrminatorr',
    name: 'Torrminatorr Forums',
    badge: 'TORRMINATORR',
    badgeColor: '#64748b',
    description: 'GOG & Linux Games Forum Community',
    url: 'https://torrminatorr.com/',
    type: 'community',
    hasSearch: false
  },
  {
    key: 'zeigames',
    name: 'ZeiGames',
    badge: 'ZEIGAMES',
    badgeColor: '#22c55e',
    description: 'Direct PC Games Catalogue & Downloads',
    url: 'https://zeigames.com/',
    searchUrl: 'https://zeigames.com/?s={query}',
    type: 'ddl',
    hasSearch: true
  }
];

export const SITE_MAP = new Map(MODERN_PC_SITES.map(s => [s.key, s]));

/**
 * Checks if a URL belongs to any modern PC DDL site
 */
export function isModernPcUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    for (const site of MODERN_PC_SITES) {
      const siteHost = new URL(site.url).hostname.toLowerCase();
      if (host === siteHost || host.endsWith('.' + siteHost)) return true;
      if (site.altUrl) {
        const altHost = new URL(site.altUrl).hostname.toLowerCase();
        if (host === altHost || host.endsWith('.' + altHost)) return true;
      }
    }
  } catch (_) {
    for (const site of MODERN_PC_SITES) {
      if (url.toLowerCase().includes(site.key)) return true;
    }
  }
  return false;
}

/**
 * Finds the site definition for a given URL
 */
export function getSiteForUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    for (const site of MODERN_PC_SITES) {
      const siteHost = new URL(site.url).hostname.toLowerCase();
      if (host === siteHost || host.endsWith('.' + siteHost)) return site;
      if (site.altUrl) {
        const altHost = new URL(site.altUrl).hostname.toLowerCase();
        if (host === altHost || host.endsWith('.' + altHost)) return site;
      }
    }
  } catch (_) {}
  return null;
}

function loadModernPcCache(siteKey, dataDir) {
  const cacheFile = path.join(getDataDir(dataDir), `modern_pc_${siteKey}_cache.json`);
  try {
    if (fs.existsSync(cacheFile)) {
      const raw = fs.readFileSync(cacheFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch (_) {}
  return { items: [], lastFetched: 0 };
}

function saveModernPcCache(siteKey, cache, dataDir) {
  try {
    const dir = getDataDir(dataDir);
    const cacheFile = path.join(dir, `modern_pc_${siteKey}_cache.json`);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2), 'utf8');
  } catch (_) {}
}

/**
 * Helper to run page extraction via Electron offscreen window
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
        fail(new Error(`Page timed out after ${options.timeoutMs || 16000}ms`));
      }, options.timeoutMs || 16000);

      win.loadURL(targetUrl, {
        userAgent: BROWSER_UA
      }).catch(() => {});

      win.webContents.on('did-finish-load', async () => {
        try {
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
          fail(new Error(`Load failed: ${errorDescription} (${errorCode})`));
        }
      });

    } catch (err) {
      fail(err);
    }
  });
}

/**
 * Parses generic RSS XML into normalized feed items
 */
function parseRssXmlToItems(xmlString, siteName, siteKey) {
  const items = [];
  const itemRe = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemRe.exec(xmlString)) !== null) {
    const raw = match[1];
    const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const linkMatch = raw.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || raw.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i);
    const pubDateMatch = raw.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i);
    const contentMatch = raw.match(/<content:encoded[^>]*>([\s\S]*?)<\/content:encoded>/i) ||
                         raw.match(/<description[^>]*>([\s\S]*?)<\/description>/i);

    let rawTitle = titleMatch ? titleMatch[1].replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim() : '';
    let link = linkMatch ? linkMatch[1].replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim() : '';
    let pubDate = pubDateMatch ? pubDateMatch[1].trim() : new Date().toISOString();
    let content = contentMatch ? contentMatch[1].replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1') : '';

    if (!rawTitle || !link) continue;

    // Clean title
    let cleanTitle = decodeHtmlEntities(rawTitle)
      .replace(/\s*[-–—|]\s*(?:OvaGames|GLOAD|Online-Fix|SCNLOG|ElAmigos)[\w.]*\s*$/i, '')
      .replace(/\bFree\s*Download\b/gi, '')
      .replace(/\bRepack\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();

    // Extract thumbnail
    const imgM = content.match(/<img[^>]+(?:src|data-src)=["']([^"']+)["']/i);
    const thumb = imgM ? imgM[1] : '';

    // Extract size
    let size = '';
    const sizeM = rawTitle.match(/(\d+(?:\.\d+)?\s*(?:GB|MB|TB))/i) ||
                  content.match(/(?:Size|Game Size|File Size):\s*([^\n<]+)/i) ||
                  content.match(/(\d+(?:\.\d+)?\s*(?:GB|MB|TB))/i);
    if (sizeM) size = sizeM[1].trim();

    // Categories
    const catMatches = Array.from(raw.matchAll(/<category[^>]*>([\s\S]*?)<\/category>/gi)).map(m => m[1].replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim()).filter(Boolean);

    const id = `${siteKey}_` + crypto.createHash('md5').update(link).digest('hex').substring(0, 14);

    items.push({
      id,
      title: cleanTitle || rawTitle,
      rawTitle: rawTitle,
      link: link,
      thumbnail: thumb,
      size: size,
      sizeBytes: parseSizeStringToBytes(size),
      categories: catMatches.length > 0 ? catMatches : ['PC Game'],
      platform: 'PC',
      author: siteName,
      pubDate: pubDate,
      excerpt: size ? `${siteName} PC release (${size}) with direct mirrors.` : `${siteName} PC game download.`
    });
  }

  return items;
}

/**
 * Fetches feed/catalog for any modern PC DDL site
 */
export async function fetchModernPcFeed({
  siteKey = 'ovagames',
  query = '',
  forceRefresh = false,
  retentionMonths = 3,
  page = 1,
  dataDir = null
} = {}) {
  // 1. SteamRIP has its own mature dedicated engine
  if (siteKey === 'steamrip') {
    return await fetchSteamripFeed({ forceRefresh, query, retentionMonths, page, dataDir });
  }

  const site = SITE_MAP.get(siteKey);
  if (!site) {
    throw new Error(`Unknown Modern PC site key: "${siteKey}"`);
  }

  const cache = loadModernPcCache(siteKey, dataDir);
  const now = Date.now();
  const isSearch = Boolean(query && query.trim());
  const cleanQ = (query || '').trim();

  // Return disk cache if recent (< 15 mins) and not searching
  if (!isSearch && !forceRefresh && cache.items && cache.items.length > 0 && (now - (cache.lastFetched || 0) < 15 * 60 * 1000)) {
    return {
      site: site,
      title: `${site.name} Catalog`,
      description: site.description,
      link: site.url,
      itemsCount: cache.items.length,
      items: cache.items,
      cached: true
    };
  }

  // 2. XML Feed Sites: OvaGames, GLOAD, Online-Fix, SCNLOG
  let feedUrlToFetch = null;
  if (isSearch) {
    if (site.searchFeed) {
      feedUrlToFetch = site.searchFeed.replace('{query}', encodeURIComponent(cleanQ));
    }
  } else if (site.feedUrl) {
    feedUrlToFetch = site.feedUrl;
  }

  if (feedUrlToFetch) {
    try {
      const resp = await fetch(feedUrlToFetch, {
        headers: { 'User-Agent': BROWSER_UA },
        signal: AbortSignal.timeout(12000)
      });
      if (resp.ok) {
        const xml = await resp.text();
        if (xml.includes('<rss') || xml.includes('<channel') || xml.includes('<feed')) {
          const parsedItems = parseRssXmlToItems(xml, site.name, site.key);
          if (parsedItems.length > 0) {
            if (!isSearch) {
              cache.items = parsedItems;
              cache.lastFetched = now;
              saveModernPcCache(siteKey, cache, dataDir);
            }
            return {
              site: site,
              title: isSearch ? `${site.name} search: "${query}"` : `${site.name} Feed`,
              description: site.description,
              link: site.url,
              itemsCount: parsedItems.length,
              items: parsedItems,
              cached: false
            };
          }
        }
      }
    } catch (feedErr) {
      console.warn(`[Modern PC] Feed fetch for ${site.name} failed (${feedUrlToFetch}):`, feedErr.message);
    }
  }

  // 3. HTML / Electron Scraper Fallback
  let targetUrl = site.url;
  if (isSearch && site.searchUrl) {
    targetUrl = site.searchUrl.replace('{query}', encodeURIComponent(cleanQ));
  } else if (site.url) {
    targetUrl = site.url;
  }

  console.log(`[Modern PC] Fetching HTML/Electron feed for ${site.name} from: ${targetUrl}`);

  const extractCardsScript = `
    function() {
      const items = [];
      const seen = new Set();
      const selectors = [
        '.post-element', '.post-item', 'article.post', 'article', '.entry', '.game-card',
        '.slide', '.post', '.the-post-title', '.movie-poster', '.games-item', '.item-game'
      ];
      document.querySelectorAll(selectors.join(',')).forEach(el => {
        const a = el.querySelector('h1 a, h2 a, h3 a, h4 a, a.game-card, a.entry-title, a.post-thumb, a');
        if (!a || !a.href) return;
        const href = a.href;
        if (seen.has(href)) return;
        seen.add(href);

        const rawTitle = (el.querySelector('.screen-reader-text') || {}).textContent ||
                         (el.querySelector('.entry-title') || {}).textContent ||
                         (el.querySelector('.post-title') || {}).textContent ||
                         (el.querySelector('.game-title') || {}).textContent ||
                         (el.querySelector('h2, h3, h4') || {}).textContent ||
                         a.getAttribute('title') ||
                         a.textContent || '';

        let imgSrc = '';
        const img = el.querySelector('img');
        if (img) {
          imgSrc = img.getAttribute('data-src') || img.getAttribute('data-src-webp') || img.src || '';
        }
        if (!imgSrc || imgSrc.startsWith('data:image')) {
          const style = (el.querySelector('[style*="background-image"]') || el).getAttribute('style') || '';
          const bgMatch = style.match(/background-image:\\s*url\\([\"']?([^\"')]+)[\"']?\\)/i);
          if (bgMatch && bgMatch[1] && !bgMatch[1].startsWith('data:image')) imgSrc = bgMatch[1];
        }

        let size = '';
        const textToMatch = el.textContent || '';
        const sizeMatch = textToMatch.match(/(\\d+(?:\\.\\d+)?\\s*(?:GB|MB|TB))/i);
        if (sizeMatch) size = sizeMatch[1];

        const cats = Array.from(el.querySelectorAll('.post-cat, .category a, .genre, .tag')).map(c => c.textContent.trim()).filter(Boolean);

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
    scrapedCards = await runElectronPageExtraction(targetUrl, extractCardsScript, { timeoutMs: 16000, settleMs: 800 });
  } catch (scrapeErr) {
    console.warn(`[Modern PC] Scrape failed for ${site.name}:`, scrapeErr.message);

    // If cache available, return it
    if (cache.items && cache.items.length > 0) {
      return {
        site: site,
        title: `${site.name} Catalog`,
        description: site.description,
        link: targetUrl,
        itemsCount: cache.items.length,
        items: cache.items,
        cached: true,
        fallbackError: scrapeErr.message
      };
    }

    // Curated quick-access card for community/forum sites or empty states
    const fallbackItem = {
      id: `${site.key}_home`,
      title: `${site.name} - Official Hub`,
      rawTitle: `${site.name} - Official Hub`,
      link: site.url,
      thumbnail: '',
      size: '',
      sizeBytes: null,
      categories: [site.type.toUpperCase()],
      platform: 'PC',
      author: site.name,
      pubDate: new Date().toISOString(),
      excerpt: site.description
    };

    return {
      site: site,
      title: `${site.name} (Direct Access)`,
      description: site.description,
      link: targetUrl,
      itemsCount: 1,
      items: [fallbackItem],
      cached: false
    };
  }

  const normalizedItems = scrapedCards.filter(c => c.rawTitle && c.rawTitle.length > 2).map(card => {
    const cleanTitle = cleanSteamripTitle(card.rawTitle);
    const id = `${siteKey}_` + crypto.createHash('md5').update(card.url).digest('hex').substring(0, 14);
    return {
      id,
      title: cleanTitle || card.rawTitle,
      rawTitle: card.rawTitle,
      link: card.url,
      thumbnail: card.thumbnail,
      size: card.size,
      sizeBytes: parseSizeStringToBytes(card.size),
      categories: card.categories.length > 0 ? card.categories : ['PC Game'],
      platform: 'PC',
      author: site.name,
      pubDate: new Date().toISOString(),
      excerpt: card.size ? `${site.name} game (${card.size}) with direct download mirrors.` : `${site.name} PC game release.`
    };
  });

  if (!isSearch && normalizedItems.length > 0) {
    cache.items = normalizedItems;
    cache.lastFetched = now;
    saveModernPcCache(siteKey, cache, dataDir);
  }

  return {
    site: site,
    title: isSearch ? `${site.name} search: "${query}"` : `${site.name} Catalog`,
    description: isSearch ? `Found ${normalizedItems.length} games on ${site.name}` : site.description,
    link: targetUrl,
    itemsCount: normalizedItems.length,
    items: normalizedItems.length > 0 ? normalizedItems : [
      {
        id: `${site.key}_direct`,
        title: `${site.name} Portal`,
        rawTitle: `${site.name} Portal`,
        link: site.url,
        thumbnail: '',
        size: '',
        categories: [site.type.toUpperCase()],
        platform: 'PC',
        author: site.name,
        pubDate: new Date().toISOString(),
        excerpt: site.description
      }
    ],
    cached: false
  };
}

/**
 * Scrapes a single game post page from any modern PC DDL site to extract mirrors and buttons
 */
export async function scrapeModernPcPost(postUrl) {
  if (isSteamripUrl(postUrl)) {
    return await scrapeSteamripPost(postUrl);
  }

  const site = getSiteForUrl(postUrl);
  console.log(`[Modern PC Post Scraper] Scraping post: ${postUrl} (${site ? site.name : 'Unknown'})`);

  const extractPostScript = `
    function() {
      const title = (document.querySelector('h1.entry-title, h1, .post-title, .the-post-title') || {}).textContent || '';
      const heroImg = document.querySelector('.post-thumb img, .entry-thumb img, .poster-image, article img, .game-poster img');
      const imgSrc = heroImg ? (heroImg.getAttribute('data-src') || heroImg.src || '') : '';

      let gameSize = '';
      document.querySelectorAll('p, .entry-content p, .game-meta').forEach(p => {
        const text = p.textContent || '';
        if (text.includes('Size:') || text.includes('Game Size:') || text.includes('File Size:')) {
          const sizeM = text.match(/(?:Size|Game Size|File Size):\\s*([\\d.]+\\s*(?:GB|MB|TB))/i);
          if (sizeM) gameSize = sizeM[1];
        }
      });

      const buttons = [];
      const seenUrls = new Set();
      const selector = 'a[href*="filecrypt"], a[href*="buzzheavier"], a[href*="bzzhr"], a[href*="gofile"], a[href*="1fichier"], a[href*="rapidgator"], a[href*="ddownload"], a[href*="datanodes"], a[href*="filekeeper"], a[href*="pixeldrain"], a[href*="qiwi"], a[href*="mega."], a[href*="mediafire"], a[href*="torrent"], a[href^="magnet:"]';

      document.querySelectorAll(selector).forEach(a => {
        const h = a.href || '';
        if (!h || seenUrls.has(h)) return;
        seenUrls.add(h);

        buttons.push({
          href: h,
          text: a.textContent.trim(),
          parentText: a.parentElement ? a.parentElement.textContent.trim() : ''
        });
      });

      return {
        rawTitle: title.trim(),
        heroImg: imgSrc,
        gameSize: gameSize,
        buttons: buttons
      };
    }
  `;

  let scraped = null;
  try {
    scraped = await runElectronPageExtraction(postUrl, extractPostScript, { timeoutMs: 16000, settleMs: 600 });
  } catch (err) {
    console.warn(`[Modern PC Scraper] Electron extraction failed for ${postUrl}, falling back to fetch:`, err.message);
    try {
      const res = await fetch(postUrl, { headers: { 'User-Agent': BROWSER_UA }, signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const html = await res.text();
        const titleM = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
        const title = titleM ? titleM[1].replace(/<[^>]+>/g, '').trim() : (site ? site.name : 'PC Game');
        const links = [];
        const linkRe = /href=["']([^"']*(?:filecrypt|buzzheavier|bzzhr|gofile|1fichier|rapidgator|ddownload|datanodes|filekeeper|pixeldrain|qiwi|mega|mediafire|torrent|magnet)[^"']*)["']/gi;
        let lm;
        const seen = new Set();
        while ((lm = linkRe.exec(html)) !== null) {
          const u = lm[1];
          if (!seen.has(u)) {
            seen.add(u);
            links.push({ href: u, text: 'Download Mirror', parentText: '' });
          }
        }
        scraped = { rawTitle: title, heroImg: '', gameSize: '', buttons: links };
      }
    } catch (_) {}
  }

  if (!scraped) {
    throw new Error(`Failed to scrape download links from ${postUrl}`);
  }

  const cleanTitle = cleanSteamripTitle(scraped.rawTitle) || (site ? site.name : 'PC Game');

  const links = [];
  let linkIdx = 0;
  for (const btn of scraped.buttons) {
    linkIdx++;
    const url = btn.href;
    const classified = classifyDownloadUrl(url, btn.text);

    let hosterName = classified.hoster || 'Direct Mirror';
    let isRecommended = hosterName.includes('Buzzheavier') || hosterName.includes('DataNodes') || hosterName.includes('Gofile') || hosterName.includes('FileCrypt') || hosterName.includes('MediaFire');

    links.push({
      id: `modern_${linkIdx}_${crypto.createHash('md5').update(url).digest('hex').substring(0, 8)}`,
      label: btn.text || hosterName,
      url: url,
      directUrl: url,
      hoster: hosterName.toLowerCase().replace(/\s+/g, '-'),
      hosterName: hosterName,
      badge: classified.category === 'torrent' ? 'Torrent' : 'Direct Download',
      recommended: isRecommended,
      size: scraped.gameSize || null
    });
  }

  return {
    title: cleanTitle,
    rawTitle: scraped.rawTitle,
    postUrl: postUrl,
    heroImg: scraped.heroImg,
    size: scraped.gameSize || null,
    links: links
  };
}
