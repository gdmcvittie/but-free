// PC RSS & Torrent Hub endpoints: RSS/Atom feed parsing, Steam popular
// releases, FitGirl availability checking and webpage download-link scraping.
// Ported from my-games-server server.js.

import crypto from 'crypto';
import {
  decodeHtmlEntities,
  getXmlTag,
  extractThumbnailAndWebm,
  extractAllDownloadsFromRssItem,
  scrapeDownloadLinksFromHtml,
  isFitgirlUpdateTitle
} from './link-utils.js';

export function registerPcRssRoutes(app) {
  // 1. Fetch & Parse RSS / Atom Feed: /api/pc-rss/feed?url=<feedUrl>
  app.get('/api/pc-rss/feed', async (req, res) => {
    const feedUrl = (req.query.url || '').trim();
    if (!feedUrl) {
      return res.status(400).json({ success: false, error: 'Feed URL is required' });
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 14000);

      const response = await fetch(feedUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 FreeplayDL/1.0',
          'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html, */*'
        }
      });
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`Remote feed server responded with HTTP ${response.status}`);
      }

      const xmlString = await response.text();
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
      const items = [];
      let match;

      while ((match = itemRegex.exec(xmlString)) !== null && items.length < 50) {
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

        // Clean excerpt: decode entities first so &lt;img...&gt; and &lt;p&gt; tags are real tags, then strip tags cleanly
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

        // Extract preview image or WebM video for the thumbnail
        const thumbInfo = extractThumbnailAndWebm(itemXml, rawContent, link);

        // Extract all download links (enclosures, media contents, magnets, direct hoster mirrors)
        const downloads = extractAllDownloadsFromRssItem(itemXml, rawContent, link, title);
        const firstMagnet = downloads.find(d => d.isMagnet);
        const magnetUrl = firstMagnet ? firstMagnet.url : null;

        items.push({
          id: 'pcrss_' + crypto.createHash('md5').update(link || title).digest('hex').substring(0, 14),
          title,
          link,
          pubDate,
          author,
          excerpt: cleanExcerpt,
          content: (rawContent || '').slice(0, 3000),
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

      res.json({
        success: true,
        feed: {
          title: feedTitle,
          description: feedDesc,
          link: feedLink,
          feedUrl,
          itemsCount: items.length,
          items
        }
      });
    } catch (err) {
      console.error('[PC RSS] Feed fetch error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Steam New Releases / Popular Releases RSS Feed Cache
  let steamPopularCache = {
    timestamp: 0,
    items: []
  };

  function cleanSteamTitle(rawTitle) {
    if (!rawTitle) return '';
    let title = rawTitle.trim();
    title = title.replace(/^Now Available(?: on Steam)?\s*[-–—:]\s*/i, '');
    title = title.replace(/^Pre-Purchase(?: Now)?\s*[-–—:]\s*/i, '');
    title = title.replace(/\s+is Now Available(?: on Steam)?\.?$/i, '');
    title = title.replace(/\s+is Available Now(?: on Steam)?\.?$/i, '');
    return title.trim();
  }

  function parseSteamDbHtml(html) {
    const items = [];
    const seenAppIds = new Set();

    const rowRegex = /<tr[^>]*data-appid=["'](\d+)["'][^>]*>([\s\S]*?)<\/tr>/gi;
    let match;
    while ((match = rowRegex.exec(html)) !== null) {
      const appId = match[1];
      if (seenAppIds.has(appId)) continue;
      const row = match[2];

      const titleMatch = row.match(/<a\s+[^>]*href=["'](?:\/app\/\d+[^"']*|https?:\/\/steamdb\.info\/app\/\d+[^"']*)["'][^>]*>([\s\S]*?)<\/a>/i);
      let title = '';
      if (titleMatch) {
        title = decodeHtmlEntities(titleMatch[1].replace(/<[^>]+>/g, '').trim());
      }
      if (!title) {
        const altMatch = row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi);
        if (altMatch && altMatch[2]) {
          title = decodeHtmlEntities(altMatch[2].replace(/<[^>]+>/g, '').trim());
        }
      }

      if (appId && title && title.length > 1 && !title.toLowerCase().includes('valve')) {
        seenAppIds.add(appId);
        items.push({
          title,
          appId,
          thumbnail: `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appId}/capsule_sm_120.jpg`,
          link: `https://store.steampowered.com/app/${appId}/`
        });
      }
    }

    if (items.length === 0) {
      const linkRegex = /href=["'](?:\/app\/|https?:\/\/steamdb\.info\/app\/)(\d+)[^"']*["'][^>]*>([^<]+)<\/a>/gi;
      let m;
      while ((m = linkRegex.exec(html)) !== null) {
        const appId = m[1];
        const title = decodeHtmlEntities(m[2].trim());
        if (appId && title && title.length > 1 && !seenAppIds.has(appId) && !['SteamDB', 'Install', 'Store'].includes(title)) {
          seenAppIds.add(appId);
          items.push({
            title,
            appId,
            thumbnail: `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appId}/capsule_sm_120.jpg`,
            link: `https://store.steampowered.com/app/${appId}/`
          });
        }
      }
    }

    return items;
  }

  async function fetchSteamPopularSearchGames() {
    const items = [];
    const seen = new Set();

    const endpoints = [
      'https://store.steampowered.com/search/results/?query&start=0&count=100&sort_by=Released_DESC&filter=popularnew&infinite=1',
      'https://store.steampowered.com/search/results/?query&start=0&count=50&sort_by=Released_DESC&infinite=1'
    ];

    for (const url of endpoints) {
      try {
        const res = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/javascript, */*'
          }
        });
        if (!res.ok) continue;
        const data = await res.json();
        const html = data && data.results_html ? data.results_html : '';
        const linkRegex = /<a\s+[^>]*href=["']https?:\/\/store\.steampowered\.com\/app\/(\d+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
        let m;
        while ((m = linkRegex.exec(html)) !== null) {
          const appId = m[1];
          if (seen.has(appId)) continue;
          const inner = m[2];
          const titleMatch = inner.match(/<span\s+class=["']title["']>([\s\S]*?)<\/span>/i);
          const title = titleMatch ? decodeHtmlEntities(titleMatch[1].trim()) : '';

          // Extract image URL directly from Steam search row
          const imgMatch = inner.match(/<img[^>]+src=["']([^"'>]+)["']/i);
          let thumbnail = (imgMatch && imgMatch[1]) ? decodeHtmlEntities(imgMatch[1].trim()) : '';
          if (!thumbnail && appId) {
            thumbnail = `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appId}/header.jpg`;
          }

          if (appId && title) {
            seen.add(appId);
            items.push({
              title,
              appId,
              thumbnail,
              link: `https://store.steampowered.com/app/${appId}/`
            });
          }
        }
      } catch (_) {}
      if (items.length >= 60) break;
    }

    return items;
  }

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

  // 1b. Popular New Releases Feed: /api/pc-rss/popular-games
  app.get('/api/pc-rss/popular-games', async (req, res) => {
    const forceRefresh = req.query.refresh === 'true';
    const now = Date.now();
    if (!forceRefresh && steamPopularCache.items.length > 0 && (now - steamPopularCache.timestamp < 10 * 60 * 1000)) {
      return res.json({ success: true, items: decorateItemsWithFitgirlCache(steamPopularCache.items), cached: true });
    }

    let items = [];

    // Strategy 1: Fast direct HTTP fetch to SteamDB upcoming/lastweek
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3500);
      const response = await fetch('https://steamdb.info/upcoming/?lastweek', {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9'
        }
      });
      clearTimeout(timeout);
      if (response.ok) {
        const html = await response.text();
        items = parseSteamDbHtml(html);
      }
    } catch (_) {}

    // Strategy 2: Official Steam Store Popular New Releases Search API (returns 50-100 popular releases)
    if (items.length === 0) {
      try {
        items = await fetchSteamPopularSearchGames();
      } catch (_) {}
    }

    // Strategy 3: Fallback to Steam official new releases RSS feed
    if (items.length === 0) {
      try {
        const response = await fetch('https://store.steampowered.com/feeds/newreleases.xml', {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'application/rss+xml, application/xml, text/xml, */*'
          }
        });
        if (response.ok) {
          const xml = await response.text();
          const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
          let match;
          while ((match = itemRegex.exec(xml)) !== null && items.length < 50) {
            const itemXml = match[1];
            const rawTitle = decodeHtmlEntities(getXmlTag(itemXml, 'title') || '').trim();
            const title = cleanSteamTitle(rawTitle);
            const link = decodeHtmlEntities(getXmlTag(itemXml, 'link') || '').trim();
            const appMatch = link.match(/\/app\/(\d+)/i);
            const appId = appMatch ? appMatch[1] : null;
            if (title && appId) {
              items.push({
                title,
                appId,
                thumbnail: `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appId}/header.jpg`,
                link: `https://store.steampowered.com/app/${appId}/`
              });
            }
          }
        }
      } catch (_) {}
    }

    if (items.length > 0) {
      steamPopularCache = {
        timestamp: now,
        items
      };
      return res.json({ success: true, items: decorateItemsWithFitgirlCache(items) });
    }

    if (steamPopularCache.items.length > 0) {
      return res.json({ success: true, items: decorateItemsWithFitgirlCache(steamPopularCache.items), cached: true });
    }

    res.status(500).json({ success: false, error: 'Failed to retrieve popular games', items: [] });
  });

  // 1c. Check single game FitGirl availability: GET /api/pc-rss/check-fitgirl?title=...
  app.get('/api/pc-rss/check-fitgirl', async (req, res) => {
    const title = (req.query.title || '').trim();
    if (!title) {
      return res.status(400).json({ success: false, error: 'Title is required' });
    }
    const result = await checkFitgirlAvailability(title);
    res.json({ success: true, title, ...result });
  });

  // 1d. Batch check FitGirl availability: POST /api/pc-rss/check-fitgirl-batch
  app.post('/api/pc-rss/check-fitgirl-batch', async (req, res) => {
    const titles = Array.isArray(req.body.titles) ? req.body.titles : [];
    if (titles.length === 0) {
      return res.json({ success: true, results: {} });
    }
    const capped = titles.slice(0, 50);
    const results = await checkFitgirlBatch(capped);
    res.json({ success: true, results });
  });

  // 2. Scrape Download Links: /api/pc-rss/scrape-links?url=<pageUrl>
  app.get('/api/pc-rss/scrape-links', async (req, res) => {
    const pageUrl = (req.query.url || '').trim();
    if (!pageUrl) {
      return res.status(400).json({ success: false, error: 'Webpage URL is required' });
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);

      const response = await fetch(pageUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 FreeplayDL/1.0',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        }
      });
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`Remote page responded with HTTP ${response.status}`);
      }

      const html = await response.text();
      const result = scrapeDownloadLinksFromHtml(html, pageUrl);

      res.json({
        success: true,
        pageUrl,
        hasMagnet: result.hasMagnet,
        hasTorrents: result.hasTorrents,
        hasMirrors: result.hasMirrors,
        magnetCount: result.magnetCount,
        mirrorCount: result.mirrorCount,
        links: result.links,
        totalFound: result.totalFound
      });
    } catch (err) {
      console.error('[PC RSS] Scrape error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });
}

export default registerPcRssRoutes;
