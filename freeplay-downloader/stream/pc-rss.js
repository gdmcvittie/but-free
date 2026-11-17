// PC RSS & Torrent Hub endpoints: RSS/Atom feed parsing, Steam popular
// releases, FitGirl availability checking and webpage download-link scraping.
// Ported from my-games-server server.js.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  decodeHtmlEntities,
  getXmlTag,
  extractThumbnailAndWebm,
  extractAllDownloadsFromRssItem,
  scrapeDownloadLinksFromHtml,
  classifyDownloadUrl,
  isFitgirlUpdateTitle
} from './link-utils.js';
import {
  fetchRomslabFeed,
  scrapeRomslabPost,
  isRomslabUrl
} from './romslab.js';

const SCRAPE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let feedCachePath = null;

export function setFeedCachePath(p) {
  feedCachePath = p;
}

function loadFeedCache() {
  try {
    if (feedCachePath && fs.existsSync(feedCachePath)) {
      const raw = fs.readFileSync(feedCachePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch (err) {
    console.warn('[PC RSS] Failed to read feed cache:', err.message);
  }
  return { items: [], lastFetched: 0, title: 'FitGirl Repacks', description: '', link: 'https://fitgirl-repacks.site/feed/' };
}

function saveFeedCache(cache) {
  try {
    if (feedCachePath) {
      const dir = path.dirname(feedCachePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(feedCachePath, JSON.stringify(cache, null, 2), 'utf8');
    }
  } catch (err) {
    console.warn('[PC RSS] Failed to save feed cache:', err.message);
  }
}

export async function fetchAndCacheFeed(feedUrl, options = {}) {
  if (!feedUrl) feedUrl = 'https://fitgirl-repacks.site/feed/';
  const isMainFeed = !feedUrl.includes('?s=') && !feedUrl.includes('&s=');
  const forceRefresh = options.forceRefresh === true || options.force === true;
  const retentionMonths = Math.max(1, parseInt(options.retentionMonths, 10) || 3);
  const cache = loadFeedCache();
  const now = Date.now();

  // If main feed and cached recently (< 10 min) without forceRefresh, return pruned cached items
  if (isMainFeed && !forceRefresh && cache.items && cache.items.length > 0 && (now - (cache.lastFetched || 0) < 10 * 60 * 1000)) {
    const cutoffMs = now - (retentionMonths * 30 * 24 * 60 * 60 * 1000);
    const validItems = cache.items.filter(item => {
      let t = item.pubDate ? new Date(item.pubDate).getTime() : 0;
      if (isNaN(t) || t <= 0) t = item.firstSeenAt ? new Date(item.firstSeenAt).getTime() : now;
      return t >= cutoffMs;
    });
    return {
      title: cache.title || 'PC Games Feed',
      description: cache.description || '',
      link: cache.link || feedUrl,
      feedUrl,
      itemsCount: validItems.length,
      items: validItems,
      cached: true
    };
  }

  let xmlString = null;
  let fetchError = null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 14000);

    const response = await fetch(feedUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': SCRAPE_USER_AGENT,
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html, */*'
      }
    });
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`Remote feed server responded with HTTP ${response.status}`);
    }
    xmlString = await response.text();
  } catch (err) {
    fetchError = err;
    console.warn('[PC RSS] Feed fetch error:', err.message);
  }

  // Fallback to cache if remote is unreachable
  if (!xmlString) {
    if (cache.items && cache.items.length > 0) {
      const cutoffMs = now - (retentionMonths * 30 * 24 * 60 * 60 * 1000);
      const validItems = cache.items.filter(item => {
        let t = item.pubDate ? new Date(item.pubDate).getTime() : 0;
        if (isNaN(t) || t <= 0) t = item.firstSeenAt ? new Date(item.firstSeenAt).getTime() : now;
        return t >= cutoffMs;
      });
      return {
        title: cache.title || 'PC Games Feed',
        description: cache.description || '',
        link: cache.link || feedUrl,
        feedUrl,
        itemsCount: validItems.length,
        items: validItems,
        cached: true,
        stale: true,
        fetchError: fetchError?.message
      };
    }
    throw fetchError || new Error('Failed to fetch feed XML');
  }

  const isAtom = xmlString.includes('<feed') || xmlString.includes('<entry');

  const feedTitle = getXmlTag(xmlString, 'title') || 'PC Games Feed';
  const feedDesc = getXmlTag(xmlString, 'description') || getXmlTag(xmlString, 'subtitle') || '';
  let feedLink = getXmlTag(xmlString, 'link') || feedUrl;
  if (isAtom && !feedLink) {
    const linkMatch = xmlString.match(/<link[^>]+rel=["']alternate["'][^>]+href=["']([^"']+)["']/i) ||
                      xmlString.match(/<link[^>]+href=["']([^"']+)["']/i);
    if (linkMatch) feedLink = linkMatch[1];
  }

  const itemTag = isAtom ? 'entry' : 'item';
  const itemRegex = new RegExp(`<${itemTag}[^>]*>([\\s\\S]*?)<\\/${itemTag}>`, 'gi');
  const fetchedItems = [];
  let match;

  while ((match = itemRegex.exec(xmlString)) !== null && fetchedItems.length < 100) {
    const itemXml = match[1];
    const title = getXmlTag(itemXml, 'title') || 'Untitled Release';

    let link = getXmlTag(itemXml, 'link');
    if (isAtom || !link) {
      const atomLinkMatch = itemXml.match(/<link[^>]+href=["']([^"']+)["'][^>]*>/i);
      if (atomLinkMatch) link = atomLinkMatch[1];
    }
    link = link.replace(/&amp;/g, '&').trim();

    const pubDate = getXmlTag(itemXml, 'pubDate') || getXmlTag(itemXml, 'published') || getXmlTag(itemXml, 'updated') || getXmlTag(itemXml, 'dc:date');
    const author = getXmlTag(itemXml, 'author') || getXmlTag(itemXml, 'dc:creator') || feedTitle;
    const rawDesc = getXmlTag(itemXml, 'description') || getXmlTag(itemXml, 'summary');
    const rawContent = getXmlTag(itemXml, 'content:encoded') || getXmlTag(itemXml, 'content') || rawDesc;

    const decodedForExcerpt = decodeHtmlEntities(rawContent || rawDesc);
    const cleanExcerpt = decodedForExcerpt
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<img[^>]*>/gi, '')
      .replace(/<p>\s*This item belongs to:[\s\S]*?<\/p>/gi, '')
      .replace(/<p>\s*This item has files of the following types:[\s\S]*?<\/p>/gi, '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 260);

    const thumbInfo = extractThumbnailAndWebm(itemXml, rawContent, link);
    const downloads = extractAllDownloadsFromRssItem(itemXml, rawContent, link, title);
    const firstMagnet = downloads.find(d => d.isMagnet);
    const magnetUrl = firstMagnet ? firstMagnet.url : null;

    const rawSizeStr = extractSizeFromText(rawContent || rawDesc || title);
    const sizeBytes = rawSizeStr ? parseSizeStringToBytes(rawSizeStr) : null;

    fetchedItems.push({
      id: 'pcrss_' + crypto.createHash('md5').update(link || title).digest('hex').substring(0, 14),
      title,
      link,
      pubDate,
      firstSeenAt: Date.now(),
      author,
      excerpt: cleanExcerpt,
      content: (rawContent || '').slice(0, 3000),
      size: rawSizeStr,
      sizeBytes,
      thumbnail: thumbInfo.url,
      isVideoThumbnail: thumbInfo.isVideo,
      hasMagnet: !!magnetUrl,
      magnetUrl: magnetUrl,
      downloads: downloads,
      hasDownloads: downloads.length > 0,
      isUpdate: isFitgirlUpdateTitle(title),
      feedTitle
    });
  }

  // Merge newly fetched items with existing stored items to prevent overnight drops
  const itemMap = new Map();
  const existingStored = Array.isArray(cache.items) ? cache.items : [];
  for (const item of existingStored) {
    if (!item || !item.id) continue;
    itemMap.set(item.id, item);
  }

  for (const item of fetchedItems) {
    if (!item || !item.id) continue;
    const prev = itemMap.get(item.id);
    if (prev) {
      itemMap.set(item.id, {
        ...prev,
        ...item,
        firstSeenAt: prev.firstSeenAt || Date.now()
      });
    } else {
      itemMap.set(item.id, {
        ...item,
        firstSeenAt: Date.now()
      });
    }
  }

  // Retention filter: prune items older than retentionMonths
  const cutoffMs = now - (retentionMonths * 30 * 24 * 60 * 60 * 1000);
  const validAccumulated = [];
  for (const it of itemMap.values()) {
    let t = it.pubDate ? new Date(it.pubDate).getTime() : 0;
    if (isNaN(t) || t <= 0) t = it.firstSeenAt ? new Date(it.firstSeenAt).getTime() : now;
    if (t >= cutoffMs) {
      validAccumulated.push(it);
    }
  }

  validAccumulated.sort((a, b) => {
    const timeA = a.pubDate ? new Date(a.pubDate).getTime() : (a.firstSeenAt || 0);
    const timeB = b.pubDate ? new Date(b.pubDate).getTime() : (b.firstSeenAt || 0);
    return timeB - timeA;
  });

  // Save the updated cumulative cache
  cache.items = validAccumulated;
  cache.lastFetched = Date.now();
  cache.title = feedTitle;
  cache.description = feedDesc;
  cache.link = feedLink;
  saveFeedCache(cache);

  const returnedItems = isMainFeed ? validAccumulated : fetchedItems;

  return {
    title: feedTitle,
    description: feedDesc,
    link: feedLink,
    feedUrl,
    itemsCount: returnedItems.length,
    items: returnedItems
  };
}

function extractSizeFromText(text) {
  if (!text) return null;
  const repackMatch = text.match(/(?:repack|download|original|game|file)?\s*size[^:\d<]*:\s*(?:from\s*|approx\.?\s*)?([0-9]+(?:\.[0-9]+)?\s*(?:TB|GB|MB|KB|B)\b)/i);
  if (repackMatch) return repackMatch[1];
  const bracketMatch = text.match(/[\(\[]\s*([0-9]+(?:\.[0-9]+)?\s*(?:TB|GB|MB)\b)\s*[\)\]]/i);
  if (bracketMatch) return bracketMatch[1];
  return null;
}

function parseSizeStringToBytes(str) {
  if (!str) return null;
  const match = String(str).match(/([0-9]+(?:\.[0-9]+)?)\s*(TB|GB|MB|KB|B)\b/i);
  if (!match) return null;
  const num = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  const mult = { B: 1, KB: 1024, MB: 1024 * 1024, GB: 1024 * 1024 * 1024, TB: 1024 * 1024 * 1024 * 1024 };
  return Math.round(num * (mult[unit] || 1));
}

export function registerPcRssRoutes(app, options = {}) {
  if (options.dataDir) {
    setFeedCachePath(path.join(options.dataDir, 'pc_feed_cache.json'));
  }

  // Settings for RSS frequency and retention
  app.get('/api/settings/rss', (_req, res) => {
    const conf = (options.getConfig && options.getConfig()) || {};
    res.json({
      success: true,
      intervalMinutes: parseInt(conf.rssInterval, 10) || 30,
      retentionMonths: parseInt(conf.rssRetentionMonths, 10) || 3
    });
  });

  app.post('/api/settings/rss', (req, res) => {
    const { intervalMinutes, retentionMonths } = req.body || {};
    const conf = (options.getConfig && options.getConfig()) || {};
    if (intervalMinutes !== undefined) {
      conf.rssInterval = Math.max(5, parseInt(intervalMinutes, 10) || 30);
    }
    if (retentionMonths !== undefined) {
      conf.rssRetentionMonths = Math.max(1, parseInt(retentionMonths, 10) || 3);
    }
    if (options.saveConfig) options.saveConfig();
    res.json({
      success: true,
      intervalMinutes: conf.rssInterval,
      retentionMonths: conf.rssRetentionMonths
    });
  });

  // 1. Fetch & Parse RSS / Atom Feed: /api/pc-rss/feed?url=<feedUrl>
  app.get('/api/pc-rss/feed', async (req, res) => {
    const feedUrl = (req.query.url || '').trim() || 'https://fitgirl-repacks.site/feed/';
    const forceRefresh = req.query.refresh === 'true' || req.query.force === 'true';
    const retentionMonths = parseInt(req.query.retentionMonths || (options.getConfig && options.getConfig().rssRetentionMonths), 10) || 3;

    try {
      const feed = await fetchAndCacheFeed(feedUrl, { retentionMonths, forceRefresh });
      res.json({ success: true, feed });
    } catch (err) {
      console.error('[PC RSS] Feed fetch error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 1b. Romslab ROM & Console Feed: /api/romslab/feed
  app.get('/api/romslab/feed', async (req, res) => {
    try {
      const forceRefresh = req.query.refresh === 'true' || req.query.force === 'true';
      const query = (req.query.q || req.query.query || '').trim();
      const platformFilter = (req.query.platform || '').trim();
      const retentionMonths = parseInt(req.query.retentionMonths || (options.getConfig && options.getConfig().rssRetentionMonths), 10) || 3;
      const page = parseInt(req.query.page, 10) || 1;
      const pagesCount = Math.min(10, Math.max(1, parseInt(req.query.pages || req.query.pagesCount, 10) || 6));
      const dataDir = options.dataDir;

      const feed = await fetchRomslabFeed({ forceRefresh, query, platformFilter, retentionMonths, page, pagesCount, dataDir });
      res.json({ success: true, feed });
    } catch (err) {
      console.error('[Romslab API] Feed error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 1c. Romslab Post Scraper: /api/romslab/scrape?url=<postUrl>
  app.get('/api/romslab/scrape', async (req, res) => {
    try {
      const pageUrl = (req.query.url || '').trim();
      if (!pageUrl) return res.status(400).json({ success: false, error: 'URL is required' });
      const data = await scrapeRomslabPost(pageUrl);
      res.json({ success: true, ...data });
    } catch (err) {
      console.error('[Romslab API] Scrape error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // FitGirl Availability Cache & Matching
  const fitgirlAvailabilityCache = new Map();
  const FITGIRL_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

  function normalizeTitleForFitgirlSearch(rawTitle) {
    if (!rawTitle) return '';
    let title = rawTitle.trim();
    title = decodeHtmlEntities(title);
    title = title.replace(/[™®©]/g, '');
    // Strip bracketed suffixes like [Demo], (Early Access), (Demo), (Soundtrack), etc.
    title = title.replace(/\s*(\(|\[)(?:demo|playtest|prologue|soundtrack|ost|dlc|deluxe|edition|bundle|vr|early access)[\s\S]*?(\)|\])/gi, '');
    // Strip edition titles like - Deluxe Edition, - Digital Deluxe, : Enhanced Edition, - Definitive Edition
    title = title.replace(/\s*[-–—:]\s*(?:Digital\s+)?(?:Deluxe|Definitive|Ultimate|Standard|Collector'?s|Enhanced|Anniversary|Gold|Premium|Special|Complete|Director'?s Cut|GOTY|Game of the Year)\s*(?:Edition|Version|Bundle)?.*$/i, '');
    title = title.replace(/\s+/g, ' ').replace(/^[-–—:\s]+|[-–—:\s]+$/g, '').trim();
    return title;
  }

  function cleanTitleTokens(str) {
    return (str || '')
      .toLowerCase()
      .replace(/[™®©'"`]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(t => t.length > 0 && !['the', 'a', 'an', 'and', 'of', 'in', 'on', 'for', 'to', 'edition', 'repack', 'version', 'bundle', 'pack'].includes(t));
  }

  function isFitgirlMatch(queryTitle, fitgirlItemTitle) {
    if (!queryTitle || !fitgirlItemTitle) return false;
    // Filter out posts that are standalone updates/patches so only base game repacks match
    if (isFitgirlUpdateTitle(fitgirlItemTitle)) return false;
    const qTokens = cleanTitleTokens(queryTitle);
    const fgTokens = cleanTitleTokens(fitgirlItemTitle);
    const fgTokenSet = new Set(fgTokens);
    if (qTokens.length === 0) return false;

    const numRegex = /^(?:[0-9]+|ii|iii|iv|v|vi|vii|viii|ix|x)$/i;
    const qNums = qTokens.filter(t => numRegex.test(t));
    const fgNums = fgTokens.filter(t => numRegex.test(t));

    // If query specifies numbers/sequels (e.g. "2", "3", "IV"), FitGirl title MUST include that number
    for (const n of qNums) {
      if (!fgTokenSet.has(n)) {
        return false;
      }
    }

    // If query has NO numbers, but FitGirl title clearly has a sequel number like 2, 3, 4, ii, iii...
    // Do not match query "Game" with "Game 2"
    if (qNums.length === 0 && fgNums.length > 0) {
      const firstQWord = qTokens[0];
      const qIndexInFg = fgTokens.indexOf(firstQWord);
      if (qIndexInFg !== -1 && fgTokens[qIndexInFg + 1] && numRegex.test(fgTokens[qIndexInFg + 1])) {
        return false;
      }
    }

    // Count matching words
    let matchCount = 0;
    for (const t of qTokens) {
      if (fgTokenSet.has(t)) {
        matchCount++;
      }
    }

    if (qTokens.length <= 2) {
      return matchCount === qTokens.length;
    }
    return (matchCount / qTokens.length) >= 0.7;
  }

  async function checkFitgirlAvailability(rawGameTitle) {
    if (!rawGameTitle) return { available: false };
    const cleanTitle = normalizeTitleForFitgirlSearch(rawGameTitle);
    if (!cleanTitle) return { available: false };
    const cacheKey = cleanTitle.toLowerCase();

    const cached = fitgirlAvailabilityCache.get(cacheKey);
    const now = Date.now();
    if (cached && (now - cached.timestamp < FITGIRL_CACHE_TTL)) {
      return {
        available: cached.available,
        matchTitle: cached.matchTitle || cleanTitle,
        matchLink: cached.matchLink || null,
        cached: true
      };
    }

    try {
      const searchUrl = `https://fitgirl-repacks.site/feed/?s=${encodeURIComponent(cleanTitle)}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6500);

      const response = await fetch(searchUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'application/rss+xml, application/xml, text/xml, */*'
        }
      });
      clearTimeout(timeout);

      if (!response.ok) {
        return { available: false };
      }

      const xml = await response.text();
      const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
      let match;
      let foundMatch = null;

      while ((match = itemRegex.exec(xml)) !== null) {
        const itemXml = match[1];
        const itemTitle = decodeHtmlEntities(getXmlTag(itemXml, 'title') || '').trim();
        let itemLink = decodeHtmlEntities(getXmlTag(itemXml, 'link') || '').trim();
        if (!itemLink) {
          const linkMatch = itemXml.match(/<link[^>]*>([^<]+)<\/link>/i);
          if (linkMatch) itemLink = linkMatch[1].trim();
        }

        if (itemTitle && isFitgirlMatch(cleanTitle, itemTitle)) {
          foundMatch = {
            title: itemTitle,
            link: itemLink
          };
          break;
        }
      }

      const result = {
        available: !!foundMatch,
        matchTitle: foundMatch ? foundMatch.title : null,
        matchLink: foundMatch ? foundMatch.link : null,
        timestamp: now
      };

      fitgirlAvailabilityCache.set(cacheKey, result);

      return {
        available: result.available,
        matchTitle: result.matchTitle || cleanTitle,
        matchLink: result.matchLink || null,
        cached: false
      };
    } catch (err) {
      return { available: false, error: err.message };
    }
  }

  async function checkFitgirlBatch(titles) {
    const results = {};
    if (!Array.isArray(titles) || titles.length === 0) return results;

    const CONCURRENCY = 4;
    let idx = 0;

    async function worker() {
      while (idx < titles.length) {
        const currentTitle = titles[idx++];
        if (!currentTitle) continue;
        try {
          const res = await checkFitgirlAvailability(currentTitle);
          results[currentTitle] = res;
        } catch (e) {
          results[currentTitle] = { available: false, error: e.message };
        }
      }
    }

    const workers = [];
    const count = Math.min(CONCURRENCY, titles.length);
    for (let i = 0; i < count; i++) {
      workers.push(worker());
    }
    await Promise.all(workers);
    return results;
  }

  function decorateItemsWithFitgirlCache(itemList) {
    if (!Array.isArray(itemList)) return itemList;
    const now = Date.now();
    return itemList.map(it => {
      const clean = normalizeTitleForFitgirlSearch(it.title).toLowerCase();
      const cached = fitgirlAvailabilityCache.get(clean);
      if (cached && (now - cached.timestamp < FITGIRL_CACHE_TTL)) {
        return {
          ...it,
          fitgirlAvailable: cached.available,
          fitgirlMatchTitle: cached.matchTitle || null,
          fitgirlLink: cached.matchLink || null
        };
      }
      return it;
    });
  }

  // 2. Scrape Download Links: /api/pc-rss/scrape-links?url=<pageUrl>
  app.get('/api/pc-rss/scrape-links', async (req, res) => {
    const pageUrl = (req.query.url || '').trim();
    if (!pageUrl) {
      return res.status(400).json({ success: false, error: 'Webpage URL is required' });
    }

    try {
      if (isRomslabUrl(pageUrl)) {
        const romslabData = await scrapeRomslabPost(pageUrl);
        return res.json({
          success: true,
          url: pageUrl,
          title: romslabData.title,
          gameSize: romslabData.size || null,
          gameSizeBytes: romslabData.size ? parseSizeStringToBytes(romslabData.size) : null,
          links: romslabData.links
        });
      }
      async function fetchHtmlWithHeaders(url) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 12000);
        try {
          const resp = await fetch(url, {
            signal: controller.signal,
            headers: {
              'User-Agent': SCRAPE_USER_AGENT,
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.9',
              'Cache-Control': 'no-cache',
              'Referer': 'https://fitgirl-repacks.site/'
            }
          });
          clearTimeout(timeout);
          if (resp.ok) {
            return await resp.text();
          }
          return null;
        } catch (_) {
          clearTimeout(timeout);
          return null;
        }
      }

      let html = await fetchHtmlWithHeaders(pageUrl);
      let result = html ? scrapeDownloadLinksFromHtml(html, pageUrl) : { links: [] };

      // FitGirl Fallback: If direct page fetch failed or found no links (e.g. Cloudflare / anti-bot block),
      // fetch the post's WordPress RSS feed (/feed/) which contains <content:encoded> with all download links.
      if ((!html || result.links.length === 0) && pageUrl.includes('fitgirl-repacks.site')) {
        const slugMatch = pageUrl.match(/fitgirl-repacks\.site\/([^\/?#]+)/i);
        const slug = slugMatch ? slugMatch[1] : '';
        if (slug) {
          // 1. Post feed: https://fitgirl-repacks.site/<slug>/feed/
          const postFeedUrl = `https://fitgirl-repacks.site/${slug}/feed/`;
          const postFeedXml = await fetchHtmlWithHeaders(postFeedUrl);
          if (postFeedXml) {
            const contentMatch = postFeedXml.match(/<content:encoded[^>]*>([\s\S]*?)<\/content:encoded>/i);
            const feedHtml = contentMatch ? decodeHtmlEntities(contentMatch[1]) : postFeedXml;
            const feedResult = scrapeDownloadLinksFromHtml(feedHtml, pageUrl);
            if (feedResult.links.length > 0) {
              html = feedHtml;
              result = feedResult;
            }
          }

          // 2. Search feed: https://fitgirl-repacks.site/feed/?s=<slug>
          if (!html || result.links.length === 0) {
            const searchFeedUrl = `https://fitgirl-repacks.site/feed/?s=${encodeURIComponent(slug.replace(/[-_]/g, ' '))}`;
            const searchFeedXml = await fetchHtmlWithHeaders(searchFeedUrl);
            if (searchFeedXml) {
              const itemMatch = searchFeedXml.match(new RegExp(`<item[\\s\\S]*?${slug}[\\s\\S]*?<\\/item>`, 'i')) ||
                                searchFeedXml.match(/<item[\s\S]*?<\/item>/i);
              if (itemMatch) {
                const itemXml = itemMatch[0];
                const contentMatch = itemXml.match(/<content:encoded[^>]*>([\s\S]*?)<\/content:encoded>/i);
                const searchHtml = contentMatch ? decodeHtmlEntities(contentMatch[1]) : itemXml;
                const searchResult = scrapeDownloadLinksFromHtml(searchHtml, pageUrl);
                if (searchResult.links.length > 0) {
                  html = searchHtml;
                  result = searchResult;
                }
              }
            }
          }
        }
      }

      if (!html && result.links.length === 0) {
        throw new Error('Could not fetch or parse download links from webpage');
      }

      const detectedSizeStr = html ? extractSizeFromText(html) : null;
      result.gameSize = detectedSizeStr;
      result.gameSizeBytes = detectedSizeStr ? parseSizeStringToBytes(detectedSizeStr) : null;

      const seenUrls = new Set(result.links.map(l => l.url));

      // Scan raw HTML for direct FuckingFast URLs (they often appear outside
      // <a> tags, so the anchor scraper misses them).
      const ffRegex = /https?:\/\/(?:[a-zA-Z0-9.-]+\.)?fuckingfast\.co\/[^\s"'<>\\]+/gi;
      const rawFfMatches = html.match(ffRegex) || [];
      for (const rawFf of rawFfMatches) {
        const cleanFf = rawFf.replace(/&amp;/g, '&').replace(/[),.;]+$/, '');
        if (!seenUrls.has(cleanFf)) {
          seenUrls.add(cleanFf);
          const classification = classifyDownloadUrl(cleanFf, '');
          result.links.push({
            id: 'dl-ff-' + Math.random().toString(36).substring(2, 9),
            url: cleanFf,
            filename: classification.filename || 'FuckingFast Download',
            extension: classification.extension || 'RAR',
            category: classification.category || 'archive',
            hoster: 'FuckingFast',
            isMagnet: false,
            source: 'page-scraper'
          });
        }
      }

      // Deep-scrape paste.fitgirl-repacks.site links where multi-part
      // FuckingFast mirrors are often hosted.
      const pasteLinks = result.links.filter(l => l.url && (l.url.includes('paste.fitgirl-repacks.site') || l.hoster === 'FitGirl Paste'));
      for (const pl of pasteLinks.slice(0, 5)) {
        try {
          const pasteController = new AbortController();
          const pasteTimeout = setTimeout(() => pasteController.abort(), 6000);
          const pasteRes = await fetch(pl.url, {
            signal: pasteController.signal,
            headers: { 'User-Agent': SCRAPE_USER_AGENT, 'Accept': 'text/html,application/xhtml+xml,application/xml,text/plain,*/*' }
          });
          clearTimeout(pasteTimeout);
          if (pasteRes.ok) {
            const pasteBody = await pasteRes.text();
            const pasteFfMatches = pasteBody.match(ffRegex) || [];
            for (const rawFf of pasteFfMatches) {
              const cleanFf = rawFf.replace(/&amp;/g, '&').replace(/[),.;]+$/, '');
              if (!seenUrls.has(cleanFf)) {
                seenUrls.add(cleanFf);
                const classification = classifyDownloadUrl(cleanFf, '');
                result.links.push({
                  id: 'dl-ff-' + Math.random().toString(36).substring(2, 9),
                  url: cleanFf,
                  filename: classification.filename || 'FuckingFast Part',
                  extension: classification.extension || 'RAR',
                  category: 'archive',
                  hoster: 'FuckingFast',
                  isMagnet: false,
                  source: 'paste-scraper'
                });
              }
            }
          }
        } catch (_) {}
      }

      // Sort: Magnets first, Torrents second, FuckingFast mirrors third, other hosters last
      const magnetLinks = result.links.filter(l => l.isMagnet || (l.url && l.url.startsWith('magnet:')));
      const torrentLinks = result.links.filter(l => !l.isMagnet && l.extension === 'TORRENT');
      const ffLinks = result.links.filter(l => !l.isMagnet && l.extension !== 'TORRENT' && l.hoster === 'FuckingFast');
      const otherMirrors = result.links.filter(l => !l.isMagnet && l.extension !== 'TORRENT' && l.hoster !== 'FuckingFast');
      const sortedLinks = [...magnetLinks, ...torrentLinks, ...ffLinks, ...otherMirrors];

      res.json({
        success: true,
        pageUrl,
        hasMagnet: magnetLinks.length > 0,
        hasTorrents: torrentLinks.length > 0,
        hasMirrors: (ffLinks.length + otherMirrors.length) > 0,
        hasFuckingFast: ffLinks.length > 0,
        magnetCount: magnetLinks.length,
        torrentCount: torrentLinks.length,
        fuckingFastCount: ffLinks.length,
        mirrorCount: ffLinks.length + otherMirrors.length,
        gameSize: result.gameSize || null,
        gameSizeBytes: result.gameSizeBytes || null,
        links: sortedLinks,
        totalFound: sortedLinks.length
      });
    } catch (err) {
      console.error('[PC RSS] Scrape error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });
}

export default registerPcRssRoutes;
