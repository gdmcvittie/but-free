// Shared RSS/Atom parsing + download link classification helpers.
// Ported from my-games-server server.js ("PC RSS & Torrent Hub" section).

export function decodeHtmlEntities(str) {
  if (!str) return '';
  return String(str)
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#039;/g, "'")
    .replace(/&#8217;/g, "'")
    .replace(/&#8216;/g, "'")
    .replace(/&#8211;/g, '–')
    .replace(/&#8212;/g, '—')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function getXmlTag(xml, tagName) {
  const escaped = tagName.replace(':', '\\:');
  const reg = new RegExp(`<(?:${escaped})[^>]*>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))<\\/(?:${escaped})>`, 'i');
  const m = xml.match(reg);
  if (m) {
    const val = m[1] !== undefined ? m[1] : (m[2] || '');
    return val.trim();
  }
  return '';
}

export function getXmlAttr(xml, tagName, attrName) {
  const reg = new RegExp(`<${tagName}[^>]+${attrName}=["']([^"']+)["']`, 'i');
  const m = xml.match(reg);
  return m ? m[1].trim() : '';
}

export function extractMagnetName(magnetUri) {
  if (!magnetUri) return null;
  const match = magnetUri.match(/&dn=([^&]+)/);
  if (match) {
    try {
      return decodeURIComponent(match[1].replace(/\+/g, ' '));
    } catch {
      return match[1];
    }
  }
  return null;
}

export function extractThumbnailAndWebm(itemXml, contentHtml, itemLink = '') {
  const decodedContent = decodeHtmlEntities(contentHtml || '');
  const decodedXml = decodeHtmlEntities(itemXml || '');
  const fullText = (itemXml + ' ' + (contentHtml || '') + ' ' + decodedContent + ' ' + decodedXml);

  // 1. Look for .webm video files first (for animated video thumbnail/preview)
  const webmMatch = fullText.match(/(?:src|href|url)=["']([^"']+\.webm(?:\?[^"']*)?)["']/i) ||
                    fullText.match(/(https?:\/\/[^\s"'<>]+\.webm(?:\?[^\s"'<>]*)?)/i);
  if (webmMatch && webmMatch[1]) {
    return { url: webmMatch[1].replace(/&amp;/g, '&').trim(), isVideo: true };
  }

  // 2. Media thumbnail attribute
  const mediaThumb = getXmlAttr(itemXml, 'media:thumbnail', 'url') ||
                     getXmlAttr(itemXml, 'thumbnail', 'url') ||
                     getXmlAttr(decodedXml, 'media:thumbnail', 'url');
  if (mediaThumb) return { url: mediaThumb.replace(/&amp;/g, '&').trim(), isVideo: false };

  // 3. Media content image
  const mediaContent = fullText.match(/<media:content[^>]+url=["']([^"']+)["'][^>]*>/i);
  if (mediaContent && mediaContent[1] && !mediaContent[1].toLowerCase().includes('.webm')) {
    return { url: mediaContent[1].replace(/&amp;/g, '&').trim(), isVideo: false };
  }

  // 4. Enclosure image
  const encMatch = itemXml.match(/<enclosure[^>]+url=["']([^"']+)["'][^>]*>/i);
  if (encMatch && encMatch[1]) {
    const encUrl = encMatch[1].replace(/&amp;/g, '&').trim();
    if (encUrl.toLowerCase().includes('.webm')) return { url: encUrl, isVideo: true };
    if (encUrl.match(/\.(png|jpg|jpeg|webp|gif)/i) || itemXml.includes('type="image/')) {
      return { url: encUrl, isVideo: false };
    }
  }

  // 5. First <img> tag in HTML or decoded description
  const imgMatch = decodedContent.match(/<img[^>]+src=["']([^"'>]+)["']/i) ||
                   decodedXml.match(/<img[^>]+src=["']([^"'>]+)["']/i) ||
                   fullText.match(/<img[^>]+src=["']([^"'>]+)["']/i);
  if (imgMatch && imgMatch[1] && !imgMatch[1].includes('feedburner') && !imgMatch[1].includes('stat.')) {
    return { url: decodeHtmlEntities(imgMatch[1]).trim(), isVideo: false };
  }

  // 7. Any direct image URL attribute or link
  const directImgMatch = fullText.match(/(?:src|href)=["'](https?:\/\/[^"'\s<>]+\.(?:jpg|jpeg|png|webp|gif)(?:\?[^"'\s<>]*)?)["']/i);
  if (directImgMatch && directImgMatch[1]) {
    return { url: decodeHtmlEntities(directImgMatch[1]).trim(), isVideo: false };
  }

  return { url: null, isVideo: false };
}

export function classifyDownloadUrl(url, linkText = '') {
  const lowerUrl = (url || '').toLowerCase();
  const lowerText = (linkText || '').toLowerCase();

  if (lowerUrl.startsWith('magnet:')) {
    const name = extractMagnetName(url) || linkText || 'BitTorrent Magnet';
    return {
      isDownload: true,
      isMagnet: true,
      filename: name,
      extension: 'MAGNET',
      category: 'torrent',
      hoster: 'BitTorrent Magnet'
    };
  }

  const knownHosters = [
    { domain: 'fuckingfast.co', name: 'FuckingFast' },
    { domain: 'datanodes.to', name: 'DataNodes' },
    { domain: 'filekeeper.net', name: 'FileKeeper' },
    { domain: '1337x.to', name: '1337x Torrent' },
    { domain: 'paste.fitgirl-repacks.site', name: 'FitGirl Paste' },
    { domain: 'mediafire.com', name: 'MediaFire' },
    { domain: 'mega.nz', name: 'MEGA' },
    { domain: 'mega.co.nz', name: 'MEGA' },
    { domain: '1fichier.com', name: '1Fichier' },
    { domain: 'rapidgator.net', name: 'Rapidgator' },
    { domain: 'gofile.io', name: 'Gofile' },
    { domain: 'krakenfiles.com', name: 'KrakenFiles' },
    { domain: 'qiwi.gg', name: 'Qiwi' },
    { domain: 'pixeldrain.com', name: 'PixelDrain' },
    { domain: 'buzzheavier.com', name: 'Buzzheavier' },
    { domain: 'multiupload.io', name: 'MultiUpload' },
    { domain: 'multiupload.biz', name: 'MultiUpload' },
    { domain: 'mirrorace.org', name: 'MirrorAce' },
    { domain: 'drive.google.com', name: 'Google Drive' },
    { domain: 'github.com', name: 'GitHub Releases' },
    { domain: 'send.cm', name: 'Send.cm' },
    { domain: 'bowfile.com', name: 'Bowfile' },
    { domain: 'hexupload.net', name: 'HexUpload' },
    { domain: 'dropgalaxy.com', name: 'DropGalaxy' },
    { domain: 'uploadhaven.com', name: 'UploadHaven' }
  ];

  let detectedHoster = 'Direct File';
  for (const h of knownHosters) {
    if (lowerUrl.includes(h.domain)) {
      detectedHoster = h.name;
      break;
    }
  }

  const downloadExtensions = [
    '.rar', '.zip', '.7z', '.tar', '.gz', '.bz2', '.xz',
    '.iso', '.bin', '.img', '.exe', '.msi', '.torrent', '.apk', '.dmg', '.patch', '.rom'
  ];

  const hasExt = downloadExtensions.find(ext => lowerUrl.includes(ext) || lowerText.includes(ext));
  const isDirectHoster = [
    'FuckingFast', 'DataNodes', 'FileKeeper', 'MediaFire', 'MEGA', '1Fichier',
    'Rapidgator', 'Gofile', 'KrakenFiles', 'Qiwi', 'PixelDrain', 'Buzzheavier',
    'MultiUpload', 'MirrorAce', 'Google Drive', 'Send.cm', 'Bowfile', 'HexUpload',
    'DropGalaxy', 'UploadHaven', 'FitGirl Paste'
  ].includes(detectedHoster);

  if (hasExt || isDirectHoster || lowerText.includes('.torrent') || lowerText.includes('part') || lowerUrl.includes('.part') || lowerText.includes('download') || lowerText.includes('mirror')) {
    let filename = linkText;
    if (url.includes('#')) {
      const hashPart = url.substring(url.indexOf('#') + 1).split('?')[0];
      if (hashPart && hashPart.length > 3 && hashPart.includes('.')) {
        try { filename = decodeURIComponent(hashPart); } catch (_) { filename = hashPart; }
      }
    }
    if (!filename || filename.length < 3 || filename.toLowerCase() === 'download' || filename.toLowerCase().includes('click to show')) {
      const clean = url.split('#')[0].split('?')[0];
      filename = clean.substring(clean.lastIndexOf('/') + 1) || 'download';
    }
    try { filename = decodeURIComponent(filename); } catch (_) {}

    const extMatch = (filename + url).match(/\.([a-zA-Z0-9]{2,5})(?:[?#]|$)/);
    const ext = extMatch ? extMatch[1].toUpperCase() : (hasExt ? hasExt.replace('.', '').toUpperCase() : 'FILE');

    let category = 'archive';
    if (ext === 'BIN') category = 'data-pack';
    else if (ext === 'TORRENT') category = 'torrent';
    else if (['EXE', 'MSI', 'ISO'].includes(ext)) category = 'executable';

    return {
      isDownload: true,
      isMagnet: false,
      filename,
      extension: ext,
      category,
      hoster: detectedHoster
    };
  }

  return { isDownload: false };
}

export function formatBytes(bytes) {
  if (!bytes || isNaN(bytes)) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = Number(bytes);
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

export function createDownloadItem({ url, type = '', length = null, source = 'enclosure', itemTitle = '' }) {
  const cleanUrl = (url || '').split('?')[0].split('#')[0];
  let filename = cleanUrl.substring(cleanUrl.lastIndexOf('/') + 1) || itemTitle || 'download';
  try { filename = decodeURIComponent(filename); } catch (_) {}

  const extMatch = (filename + url).match(/\.([a-zA-Z0-9]{2,5})(?:[?#]|$)/);
  const ext = extMatch ? extMatch[1].toUpperCase() : ((type || '').includes('bittorrent') ? 'TORRENT' : ((type || '').includes('zip') ? 'ZIP' : 'FILE'));

  let category = 'archive';
  if (ext === 'BIN') category = 'data-pack';
  else if (ext === 'TORRENT' || (type || '').includes('bittorrent')) category = 'torrent';
  else if (['EXE', 'MSI', 'ISO'].includes(ext)) category = 'executable';

  const classification = classifyDownloadUrl(url, filename);

  return {
    id: 'dl-' + Math.random().toString(36).substring(2, 9),
    url,
    filename: filename.length > 60 ? filename.slice(0, 56) + '...' + (ext ? '.' + ext.toLowerCase() : '') : filename,
    extension: ext,
    category,
    bytes: length,
    sizeFormatted: length ? formatBytes(length) : (classification.hoster || 'Direct Link'),
    hoster: classification.hoster || 'Direct Link',
    mimeType: type,
    source,
    isMagnet: false
  };
}

// Deep Download Link Extractor from RSS/Atom Item (logic from C:\_code\pc-games)
export function extractAllDownloadsFromRssItem(itemXml = '', htmlContent = '', primaryLink = '', itemTitle = '') {
  const downloads = [];
  const seenUrls = new Set();

  function isWebm(u) {
    if (!u) return false;
    return u.toLowerCase().split('?')[0].endsWith('.webm');
  }

  // 1. Direct <enclosure> tags: <enclosure url="..." length="..." type="..." />
  const encRegex = /<enclosure\s+[^>]*url=["']([^"']+)["'][^>]*>/gi;
  let encMatch;
  while ((encMatch = encRegex.exec(itemXml)) !== null) {
    const url = encMatch[1].replace(/&amp;/g, '&').trim();
    if (url && !isWebm(url) && !seenUrls.has(url)) {
      seenUrls.add(url);
      const tagStr = encMatch[0];
      const lenMatch = tagStr.match(/length=["'](\d+)["']/i);
      const length = lenMatch ? parseInt(lenMatch[1], 10) : null;
      const typeMatch = tagStr.match(/type=["']([^"']+)["']/i);
      const type = typeMatch ? typeMatch[1] : '';

      downloads.push(createDownloadItem({
        url,
        type,
        length,
        source: 'enclosure',
        itemTitle
      }));
    }
  }

  // 2. Atom <link rel="enclosure" href="..." length="..." type="..." />
  const atomEncRegex = /<link\s+[^>]*rel=["']enclosure["'][^>]*href=["']([^"']+)["'][^>]*>/gi;
  let atomMatch;
  while ((atomMatch = atomEncRegex.exec(itemXml)) !== null) {
    const url = atomMatch[1].replace(/&amp;/g, '&').trim();
    if (url && !isWebm(url) && !seenUrls.has(url)) {
      seenUrls.add(url);
      const tagStr = atomMatch[0];
      const lenMatch = tagStr.match(/length=["'](\d+)["']/i);
      const length = lenMatch ? parseInt(lenMatch[1], 10) : null;
      const typeMatch = tagStr.match(/type=["']([^"']+)["']/i);
      const type = typeMatch ? typeMatch[1] : '';

      downloads.push(createDownloadItem({
        url,
        type,
        length,
        source: 'enclosure',
        itemTitle
      }));
    }
  }

  // 3. Media content: <media:content url="..." fileSize="..." type="..." />
  const mediaRegex = /<media:content\s+[^>]*url=["']([^"']+)["'][^>]*>/gi;
  let mediaMatch;
  while ((mediaMatch = mediaRegex.exec(itemXml)) !== null) {
    const url = mediaMatch[1].replace(/&amp;/g, '&').trim();
    if (url && !isWebm(url) && !seenUrls.has(url)) {
      seenUrls.add(url);
      const tagStr = mediaMatch[0];
      const lenMatch = tagStr.match(/(?:fileSize|length)=["'](\d+)["']/i);
      const length = lenMatch ? parseInt(lenMatch[1], 10) : null;
      const typeMatch = tagStr.match(/type=["']([^"']+)["']/i);
      const type = typeMatch ? typeMatch[1] : '';

      downloads.push(createDownloadItem({
        url,
        type,
        length,
        source: 'media',
        itemTitle
      }));
    }
  }

  // 4. Magnet links in raw text / HTML
  const magnetRegex = /magnet:\?xt=urn:btih:[a-zA-Z0-9]{32,40}[^\s"'>]*/gi;
  const combinedText = (itemXml + ' ' + (htmlContent || '')).replace(/&amp;/g, '&');
  const magnetMatches = combinedText.match(magnetRegex) || [];
  magnetMatches.forEach((magUrl) => {
    const cleanMag = magUrl.trim();
    if (!seenUrls.has(cleanMag)) {
      seenUrls.add(cleanMag);
      const magName = extractMagnetName(cleanMag) || (itemTitle ? (itemTitle + '.torrent') : 'BitTorrent Magnet');
      downloads.push({
        id: 'mag-' + Math.random().toString(36).substring(2, 9),
        url: cleanMag,
        filename: magName,
        extension: 'MAGNET',
        category: 'torrent',
        isMagnet: true,
        hoster: 'BitTorrent Magnet',
        sizeFormatted: 'Torrent / Magnet',
        source: 'magnet'
      });
    }
  });

  // 5. Scrape anchor links inside html description / content
  if (htmlContent) {
    const scrapedFromContent = scrapeDownloadLinksFromHtml(htmlContent, primaryLink);
    (scrapedFromContent.links || []).forEach((l) => {
      if (!seenUrls.has(l.url)) {
        seenUrls.add(l.url);
        downloads.push({
          id: l.id || ('dl-' + Math.random().toString(36).substring(2, 9)),
          url: l.url,
          filename: l.filename || itemTitle || 'download',
          extension: l.extension || 'FILE',
          category: l.category || 'archive',
          isMagnet: !!l.isMagnet,
          hoster: l.hoster || 'Direct File',
          sizeFormatted: l.sizeFormatted || (l.isMagnet ? 'Torrent / Magnet' : (l.hoster || 'Direct Link')),
          source: 'link'
        });
      }
    });
  }

  // Group: Magnets & Torrents first, then all Direct Download Mirrors
  const magnets = downloads.filter(d => d.isMagnet);
  const torrents = downloads.filter(d => !d.isMagnet && d.extension === 'TORRENT');
  const mirrors = downloads.filter(d => !d.isMagnet && d.extension !== 'TORRENT');
  return [...magnets, ...torrents, ...mirrors];
}

export function scrapeDownloadLinksFromHtml(htmlString, sourceUrl = '') {
  const links = [];
  const seenUrls = new Set();

  // 1. Scrape raw magnet links inside text
  const magnetRegex = /magnet:\?xt=urn:btih:[a-zA-Z0-9]{32,40}[^\s"'>]*/gi;
  const magnetMatches = htmlString.match(magnetRegex) || [];
  magnetMatches.forEach((magUrl) => {
    const cleanMag = magUrl.replace(/&amp;/g, '&');
    if (!seenUrls.has(cleanMag)) {
      seenUrls.add(cleanMag);
      const name = extractMagnetName(cleanMag) || 'BitTorrent Magnet';
      links.push({
        id: 'mag-' + Math.random().toString(36).substring(2, 9),
        url: cleanMag,
        filename: name,
        extension: 'MAGNET',
        category: 'torrent',
        hoster: 'BitTorrent Magnet',
        isMagnet: true,
        source: 'page-scraper'
      });
    }
  });

  // 2. Scrape all <a> tags
  const anchorRegex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let aMatch;
  while ((aMatch = anchorRegex.exec(htmlString)) !== null) {
    let href = aMatch[1].trim().replace(/&amp;/g, '&');
    const linkText = aMatch[2].replace(/<[^>]+>/g, '').trim();

    if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;

    if (sourceUrl && !href.startsWith('http') && !href.startsWith('magnet:')) {
      try {
        href = new URL(href, sourceUrl).href;
      } catch (_) {}
    }

    if (seenUrls.has(href)) continue;

    if (href.startsWith('magnet:')) {
      seenUrls.add(href);
      const name = extractMagnetName(href) || linkText || 'BitTorrent Magnet';
      links.push({
        id: 'mag-' + Math.random().toString(36).substring(2, 9),
        url: href,
        filename: name,
        extension: 'MAGNET',
        category: 'torrent',
        hoster: 'BitTorrent Magnet',
        isMagnet: true,
        source: 'page-scraper'
      });
      continue;
    }

    const classification = classifyDownloadUrl(href, linkText);
    if (classification.isDownload) {
      seenUrls.add(href);
      links.push({
        id: 'dl-' + Math.random().toString(36).substring(2, 9),
        url: href,
        filename: classification.filename || linkText || 'download',
        extension: classification.extension,
        category: classification.category,
        hoster: classification.hoster,
        isMagnet: classification.isMagnet,
        source: 'page-scraper'
      });
    }
  }

  // Return ALL discovered links (magnets & torrents first, followed by direct hoster mirrors)
  const magnetLinks = links.filter(l => l.isMagnet || (l.url && l.url.startsWith('magnet:')));
  const torrentLinks = links.filter(l => !l.isMagnet && l.extension === 'TORRENT');
  const directLinks = links.filter(l => !l.isMagnet && l.extension !== 'TORRENT');
  const sortedLinks = [...magnetLinks, ...torrentLinks, ...directLinks];

  return {
    hasMagnet: magnetLinks.length > 0,
    hasTorrents: torrentLinks.length > 0,
    hasMirrors: directLinks.length > 0,
    magnetCount: magnetLinks.length,
    mirrorCount: directLinks.length,
    links: sortedLinks,
    totalFound: sortedLinks.length
  };
}

export function isFitgirlUpdateTitle(title) {
  if (!title) return false;
  const t = title.trim();
  // 1. Starts with Update / Updates
  if (/^updates?[\s:–—\-]/i.test(t)) return true;
  // 2. Dash or colon followed by Update / Updates (e.g. "Game – Update to v1.2", "Game - Update 3", "Game: Update")
  if (/[-–—:]\s*updates?(?:\s+(?:to|v\d|\d|only|patch)|$)/i.test(t)) return true;
  // 3. Parentheses or brackets containing Update (e.g. "(Update to v1.2)", "[Update]", "(Update Only)")
  if (/[\(\[]\s*updates?(?:\s+(?:to|v\d|\d|only|patch)|$|\s*[\)\]])/i.test(t)) return true;
  // 4. "Update to v..." or "Update to version..." anywhere
  if (/\bupdates?\s+to\s+(?:v?[\d\.]+|version)/i.test(t)) return true;
  // 5. "Update Only" or "Patch / Update" or "Update / Patch" anywhere
  if (/\b(?:update\s+only|patch\s*\/\s*update|update\s*\/\s*patch|updates?\s+pack)\b/i.test(t)) return true;
  return false;
}
