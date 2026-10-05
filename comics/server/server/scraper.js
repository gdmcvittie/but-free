const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

class ComicScraper {
  static async fetchHtml(url) {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-Ch-Ua': '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1'
      }
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} when fetching ${url}`);
    }

    return await res.text();
  }

  static async resolveDownloadRedirect(url) {
    try {
      const headRes = await fetch(url, {
        method: 'HEAD',
        headers: { 'User-Agent': USER_AGENT },
        redirect: 'manual',
        signal: AbortSignal.timeout(8000)
      });
      const location = headRes.headers.get('location');
      if (location) return location;
    } catch (e) {}

    try {
      const getRes = await fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': USER_AGENT },
        redirect: 'follow',
        signal: AbortSignal.timeout(12000)
      });

      if (getRes.url && getRes.url !== url) return getRes.url;

      const text = await getRes.text();
      const ogMatch = text.match(/<meta\s+property=["']og:url["']\s+content=["']([^"']+)["']/i);
      if (ogMatch && ogMatch[1]) return ogMatch[1];

      const pdMatch = text.match(/https?:\/\/pixeldrain\.com\/(?:u|api\/file)\/([a-zA-Z0-9_-]+)/i);
      if (pdMatch) return pdMatch[0];

      const metaRefresh = text.match(/<meta[^>]+content=["'][^"']*url=([^"'\s]+)["']/i);
      if (metaRefresh && metaRefresh[1]) return metaRefresh[1];

      return getRes.url || url;
    } catch (err) {
      return url;
    }
  }

  static toDirectPixeldrainUrl(url) {
    const match = url.match(/pixeldrain\.com\/(?:u|api\/file)\/([a-zA-Z0-9_-]+)/);
    if (match) {
      return `https://pixeldrain.com/api/file/${match[1]}`;
    }
    return url;
  }

  static normalizeImageUrl(url) {
    if (!url) return url;
    // Normalize protocol-relative and http:// URLs to https:// to avoid mixed-content
    // blocks on the HTTPS-hosted cloud site (getcomics.org images are http by default).
    return url
      .replace(/^\/\//, 'https://')
      .replace(/^http:\/\//i, 'https://');
  }

  static async scrapeLatestReleases(page = 1) {
    const targetUrl = page > 1 ? `https://getcomics.org/page/${page}/` : 'https://getcomics.org/';

    try {
      const html = await this.fetchHtml(targetUrl);
      const releases = [];
      const seen = new Set();

      const articleRegex = /<article\s+id=["']post-(\d+)["'][^>]*>([\s\S]*?)<\/article>/gi;
      let match;

      while ((match = articleRegex.exec(html)) !== null) {
        const articleHtml = match[2];

        const titleMatch = articleHtml.match(/<h1 class=["']post-title["'][^>]*><a\s+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a><\/h1>/i) ||
                           articleHtml.match(/<h2 class=["']post-title["'][^>]*><a\s+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a><\/h2>/i);
        if (!titleMatch) continue;

        const chapterUrl = titleMatch[1].trim();
        const rawTitle = titleMatch[2].replace(/<[^>]+>/g, '').replace(/&#8211;/g, '–').replace(/&#8217;/g, "'").trim();

        const imgMatch = articleHtml.match(/<img[^>]+src=["']([^"']+)["']/i);
        let cover = imgMatch ? this.normalizeImageUrl(imgMatch[1]) : null;

        const catMatch = articleHtml.match(/<a class=["']post-category[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
        const publisher = catMatch ? catMatch[1].replace(/<[^>]+>/g, '').trim() : 'Comics';

        if (
          publisher.toLowerCase().includes('news') ||
          rawTitle.toLowerCase().includes('site update') ||
          rawTitle.toLowerCase().includes('weekly update') ||
          chapterUrl.includes('/cat/blog/')
        ) {
          continue;
        }

        const sizeMatch = articleHtml.match(/Size\s*:\s*(?:<\/strong>\s*)?([^<|]+)/i);
        const size = sizeMatch ? sizeMatch[1].trim() : '';

        const yearMatch = articleHtml.match(/Year\s*:\s*(?:<\/strong>\s*)?(\d{4})/i);
        const year = yearMatch ? yearMatch[1].trim() : '';

        if (!seen.has(chapterUrl)) {
          seen.add(chapterUrl);
          releases.push({
            title: rawTitle,
            cover,
            chapterUrl,
            publisher,
            size,
            year
          });
        }
      }

      if (releases.length > 0) return releases;
    } catch (htmlErr) {
      console.warn('[Scraper] HTML catalog scrape warning:', htmlErr.message);
    }

    // Fallback: GetComics RSS Feed
    try {
      const feedRes = await fetch('https://getcomics.org/feed/', {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8'
        }
      });

      if (feedRes.ok) {
        const xml = await feedRes.text();
        const releases = [];
        const seen = new Set();
        const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
        let itemMatch;

        while ((itemMatch = itemRegex.exec(xml)) !== null) {
          const itemXml = itemMatch[1];
          const titleM = itemXml.match(/<title>([\s\S]*?)<\/title>/i);
          const linkM = itemXml.match(/<link>([\s\S]*?)<\/link>/i);
          const descM = itemXml.match(/<description>([\s\S]*?)<\/description>/i);

          if (!titleM || !linkM) continue;

          const title = titleM[1].replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').replace(/&#8211;/g, '–').replace(/&#8217;/g, "'").trim();
          const chapterUrl = linkM[1].replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim();
          const desc = descM ? descM[1] : '';

          const catM = itemXml.match(/<category><!\[CDATA\[(.*?)\]\]><\/category>/i);
          const publisher = catM ? catM[1].trim() : 'Comics';

          if (
            publisher.toLowerCase().includes('news') ||
            title.toLowerCase().includes('site update') ||
            title.toLowerCase().includes('weekly update') ||
            chapterUrl.includes('/cat/blog/')
          ) {
            continue;
          }

          const sizeMatch = desc.match(/Size\s*:\s*(?:<\/strong>\s*)?([^<|]+)/i);
          const size = sizeMatch ? sizeMatch[1].trim() : '';

          const yearMatch = desc.match(/Year\s*:\s*(?:<\/strong>\s*)?(\d{4})/i);
          const year = yearMatch ? yearMatch[1].trim() : '';

          const imgM = desc.match(/src=["']([^"']+)["']/i);
          const cover = imgM ? this.normalizeImageUrl(imgM[1]) : null;

          if (!seen.has(chapterUrl)) {
            seen.add(chapterUrl);
            releases.push({
              title,
              cover,
              chapterUrl,
              publisher,
              size,
              year
            });
          }
        }
        return releases;
      }
    } catch (feedErr) {
      console.warn('[Scraper] RSS feed fallback warning:', feedErr.message);
    }

    return [];
  }

  static async searchGetComics(query) {
    if (!query || !query.trim()) return [];
    const encoded = encodeURIComponent(query.trim());
    const searchUrl = `https://getcomics.org/?s=${encoded}`;

    try {
      const html = await this.fetchHtml(searchUrl);
      const results = [];
      const seen = new Set();

      const articleRegex = /<article\s+id=["']post-(\d+)["'][^>]*>([\s\S]*?)<\/article>/gi;
      let match;

      while ((match = articleRegex.exec(html)) !== null) {
        const articleHtml = match[2];
        const titleMatch = articleHtml.match(/<h1 class=["']post-title["'][^>]*><a\s+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a><\/h1>/i) ||
                           articleHtml.match(/<h2 class=["']post-title["'][^>]*><a\s+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a><\/h2>/i);
        if (!titleMatch) continue;

        const chapterUrl = titleMatch[1].trim();
        const rawTitle = titleMatch[2].replace(/<[^>]+>/g, '').replace(/&#8211;/g, '–').replace(/&#8217;/g, "'").trim();

        const imgMatch = articleHtml.match(/<img[^>]+src=["']([^"']+)["']/i);
        const cover = imgMatch ? this.normalizeImageUrl(imgMatch[1]) : null;

        const catMatch = articleHtml.match(/<a class=["']post-category[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
        const publisher = catMatch ? catMatch[1].replace(/<[^>]+>/g, '').trim() : 'Comics';

        const sizeMatch = articleHtml.match(/Size\s*:\s*(?:<\/strong>\s*)?([^<|]+)/i);
        const size = sizeMatch ? sizeMatch[1].trim() : '';

        const yearMatch = articleHtml.match(/Year\s*:\s*(?:<\/strong>\s*)?(\d{4})/i);
        const year = yearMatch ? yearMatch[1].trim() : '';

        if (!seen.has(chapterUrl)) {
          seen.add(chapterUrl);
          results.push({
            title: rawTitle,
            cover,
            chapterUrl,
            publisher,
            size,
            year
          });
        }
      }

      return results;
    } catch (err) {
      console.warn('[Scraper] Search warning:', err.message);
      return [];
    }
  }

  static async inspectChapter(chapterUrl) {
    if (!chapterUrl) throw new Error('No comic URL provided');

    const html = await this.fetchHtml(chapterUrl);

    const titleMatch = html.match(/<h1 class=["']search-title["'][^>]*>([\s\S]*?)<\/h1>/i) ||
                       html.match(/<h1 class=["']post-title["'][^>]*>([\s\S]*?)<\/h1>/i) ||
                       html.match(/<title>([\s\S]*?)<\/title>/i);
    let title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').replace(/–\s*GetComics.*$/i, '').trim() : 'Comic Issue';
    title = title.replace(/&#8211;/g, '–').replace(/&#8217;/g, "'").trim();

    const ogImageMatch = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
    const coverUrl = ogImageMatch ? this.normalizeImageUrl(ogImageMatch[1]) : null;

    const sizeMatch = html.match(/Size\s*:\s*(?:<\/strong>\s*)?([^<|\n]+)/i);
    const size = sizeMatch ? sizeMatch[1].trim() : '';

    const yearMatch = html.match(/Year\s*:\s*(?:<\/strong>\s*)?(\d{4})/i);
    const year = yearMatch ? yearMatch[1].trim() : '';

    // Collect all links
    const allLinks = [];
    const linkRegex = /<a\s+([^>]*?)href=["']([^"']+)["']([^>]*?)>([\s\S]*?)<\/a>/gi;
    let lMatch;
    while ((lMatch = linkRegex.exec(html)) !== null) {
      const href = lMatch[2].trim();
      const text = lMatch[4].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      allLinks.push({ href, text });
    }

    let rawDownloadLink = null;
    // 1. Pixeldrain
    const pdLink = allLinks.find(l => l.text.toLowerCase().includes('pixeldrain') || l.href.includes('pixeldrain.com'));
    if (pdLink) rawDownloadLink = pdLink.href;

    // 2. Download Now / dls
    if (!rawDownloadLink) {
      const dlNow = allLinks.find(l => l.text.toLowerCase().includes('download now') || (l.text.toLowerCase() === 'download' && l.href.includes('/dls/')));
      if (dlNow) rawDownloadLink = dlNow.href;
    }

    // 3. Datanodes
    if (!rawDownloadLink) {
      const dataNodes = allLinks.find(l => l.text.toLowerCase().includes('datanodes') || l.href.includes('datanodes.to') || l.href.match(/\.(cbz|cbr)$/i));
      if (dataNodes) rawDownloadLink = dataNodes.href;
    }

    // 4. Any /dls/
    if (!rawDownloadLink) {
      const dlsLink = allLinks.find(l => l.href.includes('/dls/'));
      if (dlsLink) rawDownloadLink = dlsLink.href;
    }

    // 5. External host
    if (!rawDownloadLink) {
      const ext = allLinks.find(l => l.href.includes('mediafire.com') || l.href.includes('vikingfile.com') || l.href.includes('mega.nz'));
      if (ext) rawDownloadLink = ext.href;
    }

    if (!rawDownloadLink) {
      throw new Error('No valid download mirror found on this GetComics page.');
    }

    let resolvedUrl = rawDownloadLink;
    if (rawDownloadLink.includes('/dls/')) {
      resolvedUrl = await this.resolveDownloadRedirect(rawDownloadLink);
    }

    let directDownloadUrl = resolvedUrl;
    if (resolvedUrl.includes('pixeldrain.com')) {
      directDownloadUrl = this.toDirectPixeldrainUrl(resolvedUrl);
    } else if (resolvedUrl.includes('mediafire.com/file/')) {
      try {
        const mfHtml = await this.fetchHtml(resolvedUrl);
        const mfMatch = mfHtml.match(/href=["'](https?:\/\/download\d+\.mediafire\.com\/[^"']+)["']/i) ||
                        mfHtml.match(/<a[^>]+id=["']downloadButton["'][^>]+href=["']([^"']+)["']/i);
        if (mfMatch) directDownloadUrl = mfMatch[1];
      } catch (e) {}
    }

    return {
      title,
      coverUrl,
      downloadUrl: directDownloadUrl,
      size,
      year,
      chapterUrl
    };
  }

  /**
   * Streams the resolved mirror download straight to `destPath` so a large CBZ
   * never has to sit in memory (shared-hosting LVE memory limits kill the process
   * otherwise). Returns the same metadata shape as downloadIssueBuffer.
   */
  static async downloadIssueToFile(chapterUrl, destPath, onProgress) {
    const fs = require('fs');
    const { Readable, Transform } = require('stream');
    const { pipeline } = require('stream/promises');

    const info = await this.inspectChapter(chapterUrl);
    if (!info.downloadUrl) {
      throw new Error('No direct download mirror URL resolved for this comic.');
    }

    if (onProgress) onProgress({ status: 'Connecting to download mirror...', percent: 5 });

    const res = await fetch(info.downloadUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(15 * 60 * 1000)
    });

    if (!res.ok) {
      throw new Error(`Download mirror HTTP error ${res.status}`);
    }
    if (!res.body) {
      throw new Error('Download mirror returned an empty response body.');
    }

    const total = Number(res.headers.get('content-length')) || 0;
    let received = 0;
    const body = typeof Readable.fromWeb === 'function' ? Readable.fromWeb(res.body) : res.body;
    if (onProgress && total > 0) {
      onProgress({ status: 'Downloading issue...', percent: 10, received: 0, total });
    }

    // Count bytes as they pass through without disturbing back-pressure.
    const counter = new Transform({
      transform(chunk, enc, cb) {
        received += chunk.length;
        if (onProgress && total > 0) {
          onProgress({
            status: 'Downloading issue...',
            percent: 10 + Math.round((received / total) * 25),
            received,
            total
          });
        }
        cb(null, chunk);
      }
    });

    await pipeline(body, counter, fs.createWriteStream(destPath));

    const size = fs.existsSync(destPath) ? fs.statSync(destPath).size : 0;
    if (size < 1000) {
      try { fs.unlinkSync(destPath); } catch (e) {}
      throw new Error('Downloaded file is too small or invalid (mirror error)');
    }

    if (onProgress) onProgress({ status: 'Download completed! Preparing upload...', percent: 40 });

    const safeTitle = info.title.replace(/[\\/:*?"<>|]/g, '_').trim();
    const fileName = `${safeTitle}.cbz`;

    return {
      filePath: destPath,
      title: info.title,
      fileName,
      coverUrl: info.coverUrl,
      size
    };
  }

  static async downloadIssueBuffer(chapterUrl, onProgress) {
    const info = await this.inspectChapter(chapterUrl);
    if (!info.downloadUrl) {
      throw new Error('No direct download mirror URL resolved for this comic.');
    }

    if (onProgress) onProgress({ status: 'Connecting to download mirror...', percent: 10 });

    const res = await fetch(info.downloadUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(60000)
    });

    if (!res.ok) {
      throw new Error(`Download mirror HTTP error ${res.status}`);
    }

    if (onProgress) onProgress({ status: 'Downloading issue...', percent: 40 });

    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (buffer.length < 1000) {
      throw new Error('Downloaded file is too small or invalid (mirror error)');
    }

    if (onProgress) onProgress({ status: 'Download completed! Preparing upload...', percent: 80 });

    // Clean file name
    const safeTitle = info.title.replace(/[\\/:*?"<>|]/g, '_').trim();
    const fileName = `${safeTitle}.cbz`;

    return {
      buffer,
      title: info.title,
      fileName,
      coverUrl: info.coverUrl,
      size: buffer.length
    };
  }
}

module.exports = ComicScraper;
