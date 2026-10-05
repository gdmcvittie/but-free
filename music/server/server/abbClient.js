import { config } from './config.js';

/**
 * AudioBookBay (audiobookbay.lu) client.
 *
 * Responsibilities:
 *   - keep a logged-in cookie session for the configured ABB account
 *   - list the newest releases (What's New) from the RSS feed / paginated HTML
 *   - search the catalogue
 *   - parse a release page into structured metadata
 *   - fetch the .torrent file that webtorrent consumes
 *
 * The parser is deliberately regex based (no DOM dependency): it degrades
 * gracefully and returns null for any field it cannot find, exactly like the
 * comics app's GetComics scraper.
 */

const LOGIN_PATH = '/member/login.php';

const BROWSER_HEADERS = () => ({
  'User-Agent': config.userAgent,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Ch-Ua': '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Upgrade-Insecure-Requests': '1'
});

/** Minimal cookie jar - ABB only needs a plain name=value session cookie. */
class CookieJar {
  constructor() { this.cookies = new Map(); }

  absorb(response) {
    const raw = typeof response.headers?.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : (response.headers?.get?.('set-cookie') ? [response.headers.get('set-cookie')] : []);
    for (const line of raw) {
      const [pair] = String(line).split(';');
      const idx = pair.indexOf('=');
      if (idx > 0) this.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }

  header() {
    return Array.from(this.cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  clear() { this.cookies.clear(); }

  get size() { return this.cookies.size; }
}

const jar = new CookieJar();
let loginPromise = null;
let lastLoginAt = 0;
let lastLoginError = null;
const LOGIN_TTL_MS = 25 * 60 * 1000;

function decodeEntities(value = '') {
  return String(value)
    .replace(/<[^>]+>/g, '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function absoluteUrl(href) {
  if (!href) return null;
  try {
    return new URL(href, config.abb.baseUrl).toString();
  } catch {
    return null;
  }
}

/** The post slug is a stable id we can use for "seen"/"new" bookkeeping. */
function postIdFromUrl(url) {
  if (!url) return null;
  const match = String(url).match(/\/abss\/([^/]+)\/?/);
  return match ? match[1] : new URL(url).pathname.replace(/^\/|\/$/g, '') || null;
}

async function request(url, { method = 'GET', body = null, headers = {}, timeout = 20000, redirect = 'follow' } = {}) {
  const cookie = jar.header();
  const res = await fetch(url, {
    method,
    body,
    redirect,
    signal: AbortSignal.timeout(timeout),
    headers: {
      ...BROWSER_HEADERS(),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers
    }
  });
  jar.absorb(res);
  return res;
}

async function fetchHtml(url, options = {}) {
  const res = await request(url, options);
  if (!res.ok) throw new Error(`AudioBookBay returned HTTP ${res.status} for ${url}`);
  return res.text();
}

export const abbClient = {
  isConfigured() {
    return Boolean(config.abb.username && config.abb.password);
  },

  sessionStatus() {
    return {
      configured: this.isConfigured(),
      loggedIn: jar.size > 0 && Date.now() - lastLoginAt < LOGIN_TTL_MS,
      baseUrl: config.abb.baseUrl,
      error: lastLoginError
    };
  },

  /**
   * Proactively ensures the client is authenticated with AudioBookBay.
   * Reuses existing valid session if available; catches errors without throwing.
   */
  async ensureLoggedIn() {
    if (!this.isConfigured()) return false;
    if (jar.size > 0 && Date.now() - lastLoginAt < LOGIN_TTL_MS) return true;
    try {
      await this.login();
      return true;
    } catch (err) {
      console.warn('[ABB] Auto-login failed:', err.message);
      return false;
    }
  },

  /** Logs in (or reuses a live session). Safe to call concurrently. */
  async login({ force = false } = {}) {
    if (!this.isConfigured()) {
      throw new Error('AudioBookBay credentials are missing. Set ABB_USERNAME and ABB_PASSWORD in .env.');
    }
    if (!force && jar.size > 0 && Date.now() - lastLoginAt < LOGIN_TTL_MS) {
      return true;
    }
    if (loginPromise) return loginPromise;

    loginPromise = (async () => {
      jar.clear();
      // Prime the session so WordPress hands us a POST cookie.
      try { await request(`${config.abb.baseUrl}${LOGIN_PATH}`, { timeout: 15000 }); } catch { /* ignore */ }

      const res = await request(`${config.abb.baseUrl}${LOGIN_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: `${config.abb.baseUrl}${LOGIN_PATH}`
        },
        body: new URLSearchParams({
          username: config.abb.username,
          password: config.abb.password
        }),
        redirect: 'manual',
        timeout: 20000
      });

      // A failed login re-renders the form; a successful one redirects away from it.
      const body = await res.text();
      const looksLoggedIn =
        (res.status >= 300 && res.status < 400) ||
        /logout|wp-admin|my-account/i.test(body) ||
        !/name=["']password["']/i.test(body);

      if (!looksLoggedIn) {
        jar.clear();
        throw new Error('AudioBookBay login failed. Check ABB_USERNAME / ABB_PASSWORD in .env.');
      }

      lastLoginAt = Date.now();
      lastLoginError = null;
      console.log('[ABB] Logged in to AudioBookBay.');
      return true;
    })();

    try {
      const result = await loginPromise;
      lastLoginError = null;
      return result;
    } catch (err) {
      lastLoginError = err.message;
      throw err;
    } finally {
      loginPromise = null;
    }
  },

  async logout() {
    jar.clear();
    lastLoginAt = 0;
    lastLoginError = null;
  },

  // ------------------------------------------------------------------
  // Catalogue listing
  // ------------------------------------------------------------------
  /**
   * Parses the HTML listing pages (home, /page/N/, category pages) into
   * normalized release records.
   */
  parseListingHtml(html) {
    const results = [];
    const seen = new Set();

    // The class must be exactly "post" (optionally followed by more space-separated
    // classes). An earlier version allowed any trailing characters here, which also
    // matched <div class="postTitle"> / "postInfo" / "postContent" - the lazy lookahead
    // then fired on the *next* nested div, so every captured block held only the
    // postTitle (link + title) and never the postContent where the cover <img> lives.
    const postRegex = /<div\s+class=["']post(?:\s[^"']*)?["'][^>]*>([\s\S]*?)(?=<div\s+class=["']post(?:\s[^"']*)?["'][^>]*>|<\/body>)/gi;
    let match;

    while ((match = postRegex.exec(html)) !== null) {
      const block = match[1];

      const linkMatch = block.match(/<a[^>]+href=["']([^"']*\/abss\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
      if (!linkMatch) continue;

      const url = absoluteUrl(linkMatch[1].replace(/\/$/, '/'));
      const id = postIdFromUrl(url);
      if (!id || seen.has(id)) continue;
      seen.add(id);

      const imgMatch = block.match(/<img[^>]+src=["']([^"']+)["']/i);
      const cover = imgMatch ? imgMatch[1].trim() : null;

      const titleMatch = linkMatch[2] && linkMatch[2].replace(/<img[^>]*>/i, '').trim()
        ? linkMatch[2]
        : block.match(/<h\d[^>]*>([\s\S]*?)<\/h\d>/i)?.[1];

      const title = decodeEntities(titleMatch || id.replace(/-/g, ' '));

      const categories = [];
      const catRegex = /href=["'][^"']*\/audio-books\/(?:type|tag)\/([^/"'?]+)\/?["'][^>]*>([\s\S]*?)<\/a>/gi;
      let catMatch;
      while ((catMatch = catRegex.exec(block)) !== null) {
        const name = decodeEntities(catMatch[2]);
        if (name) categories.push(name);
      }

      const dateMatch = block.match(/(\w+\s+\d{1,2},?\s+\d{4})/);
      const posted = dateMatch ? dateMatch[1] : null;

      results.push({
        id,
        title,
        url,
        cover,
        categories: Array.from(new Set(categories)),
        posted,
        detail: null,
        addedAt: new Date().toISOString()
      });
    }

    return results;
  },

  parseFeed(xml) {
    const results = [];
    const seen = new Set();
    const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
    let itemMatch;

    while ((itemMatch = itemRegex.exec(xml)) !== null) {
      const block = itemMatch[1];
      const linkM = block.match(/<link>([\s\S]*?)<\/link>/i);
      const titleM = block.match(/<title>([\s\S]*?)<\/title>/i);
      if (!linkM || !titleM) continue;

      const url = decodeEntities(linkM[1]);
      const id = postIdFromUrl(url);
      if (!id || seen.has(id)) continue;
      seen.add(id);

      const categories = [];
      const catRegex = /<category><!\[CDATA\[([\s\S]*?)\]\]><\/category>/gi;
      let catMatch;
      while ((catMatch = catRegex.exec(block)) !== null) {
        const value = catMatch[1].trim();
        if (value) categories.push(value);
      }

      const descM = block.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/i);
      const desc = descM ? descM[1] : '';
      const coverM = desc.match(/<img[^>]+src=["']([^"']+)["']/i)
        || block.match(/<media:thumbnail[^>]+url=["']([^"']+)["']/i);
      const dateM = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i);

      // ABB puts "Written by", "Read by", "Format:", "Length:" in the description.
      const writtenBy = desc.match(/Written by\s*([^<\n]+?)(?:<br|\s+Read by|$)/i)?.[1]?.trim();
      const readBy = desc.match(/Read by\s*([^<\n]+?)(?:\s*<br|<\/p>|\s*Format:|$)/i)?.[1]?.trim();
      const format = desc.match(/Format:\s*([^<\n]+?)(?:<br|\s*Bitrate|$)/i)?.[1]?.trim();
      const bitrate = desc.match(/Bitrate:\s*([^<\n]+?)(?:<br|<|$)/i)?.[1]?.trim();
      const length = desc.match(/Length:\s*([^<\n]+?)(?:<br|<|$)/i)?.[1]?.trim();
      const abridged = /abridged/i.test(desc) ? !/unabridged/i.test(desc) : null;

      results.push({
        id,
        title: decodeEntities(titleM[1]),
        url,
        cover: coverM ? coverM[1].trim() : null,
        categories: Array.from(new Set(categories)),
        posted: dateM ? dateM[1].trim() : null,
        author: writtenBy || null,
        narrator: readBy || null,
        format: format || null,
        bitrate: bitrate || null,
        length: length || null,
        abridged,
        summary: decodeEntities(desc.replace(/<img[^>]*>/gi, ' ')),
        detail: null,
        addedAt: new Date().toISOString()
      });
    }

    return results;
  },

  /** Newest releases. Prefers the RSS feed, falls back to paginated HTML. */
  async fetchLatest({ page = 1, category = null } = {}) {
    await this.ensureLoggedIn();
    if (page === 1 && !category) {
      try {
        const xml = await fetchHtml(`${config.abb.baseUrl}/feed/`, {
          headers: { Accept: 'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8' }
        });
        const items = this.parseFeed(xml);
        if (items.length) return items;
      } catch (err) {
        console.warn('[ABB] RSS feed failed, falling back to HTML:', err.message);
      }
    }

    const url = category
      ? `${config.abb.baseUrl}/audio-books/type/${encodeURIComponent(category)}/`
      : page > 1
        ? `${config.abb.baseUrl}/page/${page}/`
        : `${config.abb.baseUrl}/`;

    const html = await fetchHtml(url);
    return this.parseListingHtml(html);
  },

  /** Category names for the What's New filter bar. */
  async fetchCategories() {
    await this.ensureLoggedIn();
    try {
      const html = await fetchHtml(config.abb.baseUrl, { timeout: 15000 });
      const categories = [];
      const regex = /href=["'][^"']*\/audio-books\/(?:type|tag)\/([^/"'?]+)\/?["'][^>]*>([\s\S]*?)<\/a>/gi;
      let match;
      while ((match = regex.exec(html)) !== null) {
        const label = decodeEntities(match[2]);
        if (label) categories.push({ slug: match[1], label });
      }
      const seen = new Set();
      return categories.filter((c) => {
        const key = c.label.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    } catch (err) {
      console.warn('[ABB] Could not read category list:', err.message);
      return [];
    }
  },

  async search(query) {
    if (!query || !query.trim()) return [];
    await this.ensureLoggedIn();
    const html = await fetchHtml(`${config.abb.baseUrl}/?s=${encodeURIComponent(query.trim())}`);
    return this.parseListingHtml(html);
  },

  // ------------------------------------------------------------------
  // Release detail
  // ------------------------------------------------------------------
  /** Parses a release page into full metadata + the .torrent link. */
  async fetchDetail(url) {
    await this.ensureLoggedIn();
    const html = await fetchHtml(url);

    const titleMatch = html.match(/<h1[^>]*itemprop=["']name["'][^>]*>([\s\S]*?)<\/h1>/i)
      || html.match(/<h1[^>]*class=["'][^"']*entry-title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i);
    const title = decodeEntities(
      titleMatch?.[1] || (html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || '')
        .replace(/\s*Audiobook\s+M4B\s*$/i, '')
        .replace(/\s*[|–-]\s*AudioBook Bay.*$/i, '')
    );

    const coverMatch = html.match(/<img[^>]+itemprop=["']image["'][^>]*>/i)
      || html.match(/<p[^>]*>\s*<a[^>]*>\s*<img[^>]+src=["']([^"']+)["']/i);
    let cover = null;
    if (coverMatch) {
      cover = coverMatch[0].match(/src=["']([^"']+)["']/i)?.[1]
        || html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1]
        || null;
    }

    // ABB marks up the credits block with schema.org spans - far more reliable
    // than scraping the surrounding prose, which runs fields together.
    const collectSpans = (className) => {
      const values = [];
      const regex = new RegExp(`<span[^>]*class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([^<]*)<\\/span>`, 'gi');
      let match;
      while ((match = regex.exec(html)) !== null) {
        const value = decodeEntities(match[1]);
        if (value) values.push(value);
      }
      return values;
    };

    const field = (pattern) => html.match(pattern)?.[1]?.trim() || null;
    const authors = collectSpans('author');
    const narrators = collectSpans('narrator');
    const formats = collectSpans('format');
    const bitrates = collectSpans('bitrate');

    const author = authors.length
      ? authors.join(', ')
      : field(/Written by\s*:?\s*([^<\n]+?)(?:\s*(?:<br|Read by)|$)/i);
    const narrator = narrators.length
      ? narrators.join(', ')
      : field(/Read by\s*:?\s*([^<\n]+?)(?:\s*(?:<br|Format:)|$)/i);
    const format = formats[0] || field(/Format:\s*:?\s*([^<\n]+)/i);
    const bitrate = bitrates[0] || field(/Bitrate:\s*:?\s*([^<\n]+)/i);
    const length = field(/Length:\s*:?\s*([^<\n]+)/i);

    let abridged = null;
    if (/class=["'][^"']*\bis_abridged\b[^"']*["'][^>]*>\s*Unabridged/i.test(html)) abridged = false;
    else if (/class=["'][^"']*\bis_abridged\b[^"']*["']/i.test(html)) abridged = true;

    let infoHash = field(/Info\s*Hash:?<\/(?:td|th|span|div|p)>\s*<(?:td|th|span|div|p)[^>]*>\s*([0-9a-fA-F]{40})/i)
      || field(/Info\s*Hash:?\s*([0-9a-fA-F]{40})/i);
    if (!infoHash) {
      const magnetMatch = html.match(/magnet:\?xt=urn:btih:([0-9a-fA-F]{40})/i);
      if (magnetMatch) infoHash = magnetMatch[1];
    }
    if (!infoHash) {
      const tdHash = html.match(/<td[^>]*>\s*([0-9a-fA-F]{40})\s*<\/td>/i);
      if (tdHash) infoHash = tdHash[1];
    }
    if (infoHash) infoHash = infoHash.toLowerCase().trim();

    const magnet = infoHash
      ? `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451%2Fannounce&tr=udp%3A%2F%2Fexplodie.org%3A6969%2Fannounce`
      : null;
    const fileSizeMb = parseFloat(field(/File Size:<\/td>\s*<td><span[^>]*>([\d.]+)<\/span>\s*MB/i) || '0') || null;
    const creationDate = field(/Creation Date:<\/td>\s*<td>([^<]+)/i);
    const isMultifile = /Multifile Torrent/i.test(html);
    const listedFiles = [];
    const fileRegex = /<td[^>]*colspan=["']2["'][^>]*>([\s\S]*?)<\/td>/g;
    let fileMatch;
    while ((fileMatch = fileRegex.exec(html)) !== null) {
      const value = decodeEntities(fileMatch[1]);
      if (/\.(m4b|m4a|mp3|aac|flac|ogg|opus)\b/i.test(value)) listedFiles.push(value);
    }

    // ABB keeps the release's real metadata in the postInfo block right under
    // the title:  Category: <a rel="category tag">…  Language: <span
    // itemprop="inLanguage">…  Keywords: <h2><a href="…/tag/…">… (author +
    // series tags). The sidebar on EVERY page lists all genres and a "Popular
    // Language" block (English, Dutch, French, …), so scanning the whole
    // document leaks "Dutch" into the categories of every release.
    const infoBlockMatch = html.match(/<div\s+class=["']postInfo["'][^>]*>([\s\S]*?)<\/div>/i);
    const infoBlock = infoBlockMatch ? infoBlockMatch[1] : null;

    const language = infoBlock
      ?.match(/<span[^>]+itemprop=["']inLanguage["'][^>]*>([^<]+)<\/span>/i)?.[1]?.trim() || null;

    const categories = [];
    let keywords = [];
    if (infoBlock) {
      const catRegex = /<a[^>]+rel=["']category tag["'][^>]*>([\s\S]*?)<\/a>/gi;
      let catMatch;
      while ((catMatch = catRegex.exec(infoBlock)) !== null) {
        const value = decodeEntities(catMatch[1]);
        if (value) categories.push(value);
      }
      const kwRegex = /<h2[^>]*>\s*<a[^>]+href=["'][^"']*\/audio-books\/tag\/[^"']+["'][^>]*>([\s\S]*?)<\/a>/gi;
      let kwMatch;
      while ((kwMatch = kwRegex.exec(infoBlock)) !== null) {
        const value = decodeEntities(kwMatch[1]);
        if (value) keywords.push(value);
      }
    } else {
      // Fallback for pages without the postInfo markup: still better than
      // nothing, but the caller must treat language-ish labels with care.
      const catRegex = /href=["'][^"']*\/audio-books\/(?:type|tag)\/[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
      let catMatch;
      while ((catMatch = catRegex.exec(html)) !== null) {
        const value = decodeEntities(catMatch[1]);
        if (value) categories.push(value);
      }
    }

    // The torrent button. `/dodl3-no?dow=<encoded name>` is the .torrent link;
    // `/downld0?downfs=...` is an alternate mirror of the same file.
    const torrentMatch = html.match(/href=["'](\/dodl3-no\?[^"']+)["']/i)
      || html.match(/href=["'](\/downld0\?[^"']+)["']/i)
      || html.match(/href=["']([^"']*\.torrent[^"']*)["']/i);

    const summaryMatch = html.match(/<div[^>]*class=["']desc["'][^>]*>([\s\S]*?)<\/div>/i)
      || html.match(/<div[^>]*itemprop=["']description["'][^>]*>([\s\S]*?)<\/div>/i);

    const postedMatch = html.match(/(\w+\s+\d{1,2},?\s+\d{4})/);

    return {
      title,
      url,
      cover,
      author: author ? decodeEntities(author) : null,
      narrator: narrator ? decodeEntities(narrator) : null,
      format: format ? decodeEntities(format) : null,
      bitrate: bitrate ? decodeEntities(bitrate) : null,
      length: length ? decodeEntities(length) : null,
      abridged,
      infoHash,
      magnet,
      fileSizeMb,
      creationDate,
      multifile: isMultifile,
      files: listedFiles,
      categories: Array.from(new Set(categories)),
      keywords: Array.from(new Set(keywords)),
      language,
      torrentPath: torrentMatch ? torrentMatch[1] : null,
      summary: summaryMatch ? decodeEntities(summaryMatch[1]) : null,
      posted: postedMatch ? postedMatch[1] : null,
      id: postIdFromUrl(url)
    };
  },

  // ------------------------------------------------------------------
  // Torrent file
  // ------------------------------------------------------------------
  /**
   * Downloads the .torrent bytes. Logs in first because ABB gates torrent
   * downloads behind an account.
   */
  async fetchTorrent(detail) {
    if (!detail?.torrentPath) {
      throw new Error('No torrent download link was found on this AudioBookBay page.');
    }
    await this.login();

    const url = absoluteUrl(detail.torrentPath);
    const res = await request(url, {
      headers: { Referer: detail.url || config.abb.baseUrl },
      timeout: 30000
    });

    if (!res.ok) {
      if (res.status === 403 || res.status === 401) {
        await this.login({ force: true });
        const retry = await request(url, { headers: { Referer: detail.url }, timeout: 30000 });
        if (!retry.ok) throw new Error(`AudioBookBay refused the torrent (HTTP ${retry.status}).`);
        return this.validateTorrent(Buffer.from(await retry.arrayBuffer()));
      }
      throw new Error(`AudioBookBay refused the torrent (HTTP ${res.status}).`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    return this.validateTorrent(buffer);
  },

  /** A bencoded .torrent always starts with 'd' and must mention 'announce'. */
  validateTorrent(buffer) {
    if (!buffer || buffer.length < 20) {
      throw new Error('The downloaded torrent file was empty - the ABB login may have failed.');
    }
    const head = buffer.subarray(0, 4096).toString('latin1');
    if (head[0] !== 'd' || !/announce/i.test(head)) {
      throw new Error('AudioBookBay returned a web page instead of a torrent file. Please sign in again.');
    }
    return buffer;
  },

  /** Builds a magnet URI as a fallback if the .torrent cannot be fetched. */
  magnetFromDetail(detail) {
    if (!detail?.infoHash) return null;
    return `magnet:?xt=urn:btih:${detail.infoHash}`;
  }
};

export default abbClient;
