// =============================================================================
// PC GAMES DISCOVERY ENGINE - ported from my-games-server (server.js)
// FitGirl Repacks RSS/Atom parsing, deep download-link extraction,
// SteamDB / Steam Store popular releases, FitGirl availability matching,
// and FuckingFast / DataNodes mirror link resolution.
//
// Pure discovery: this module never touches disk or torrent engines.
// Downloads are dispatched to the central Downloader node.
// =============================================================================

import crypto from 'crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const UA_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export const FITGIRL_FEED_URL = 'https://fitgirl-repacks.site/feed/';

// -------------------------------------------------------------
// Small shared utilities
// -------------------------------------------------------------

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

export const MAX_PC_REMOTE_TORRENT_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
export const PC_REMOTE_TORRENT_LIMIT_MSG = "This game is too large to download remotely (limit is 2 GB).";

export function parseSizeStringToBytes(str) {
  if (!str) return null;
  const match = String(str).match(/([0-9]+(?:\.[0-9]+)?)\s*(TB|GB|MB|KB|B)\b/i);
  if (!match) return null;
  const num = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  const mult = {
    B: 1,
    KB: 1024,
    MB: 1024 * 1024,
    GB: 1024 * 1024 * 1024,
    TB: 1024 * 1024 * 1024 * 1024
  };
  return Math.round(num * (mult[unit] || 1));
}

export function extractSizeFromText(text) {
  if (!text) return null;
  // Match e.g. "Repack Size: from 14.5 GB" or "Download Size: 1.8 GB" or "Original Size: ... Repack Size: 2.3 GB"
  const repackMatch = text.match(/(?:repack|download|original|game|file)?\s*size[^:\d<]*:\s*(?:from\s*|approx\.?\s*)?([0-9]+(?:\.[0-9]+)?\s*(?:TB|GB|MB|KB|B)\b)/i);
  if (repackMatch) {
    return repackMatch[1];
  }
  const bracketMatch = text.match(/[\(\[]\s*([0-9]+(?:\.[0-9]+)?\s*(?:TB|GB|MB)\b)\s*[\)\]]/i);
  if (bracketMatch) {
    return bracketMatch[1];
  }
  return null;
}

export function decodeHtmlEntities(str) {
  if (!str) return '';
  return String(str)
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#039;/g, "'")
    .replace(/&#8217;/g, "'")
    .replace(/&#8216;/g, "'")
    .replace(/&#8211;/g, '\u2013')
    .replace(/&#8212;/g, '\u2014')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
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

// Clean a repack release title into a friendly game name + safe folder name.
export function cleanPcGameTitle(rawTitle) {
  if (!rawTitle) return '';
  let str = String(rawTitle).replace(/&#8211;/g, '\u2013').replace(/&#8212;/g, '\u2014').replace(/&#8217;/g, "'").replace(/&#038;/g, '&').replace(/&amp;/gi, '&');

  str = str.replace(/\[[^\]]*\]/g, ' ');
  str = str.replace(/\((?:v\d|build\b|update\b|patch\b|multilingual|multi\d|inc|incl|\+|all dlc).*?\)/gi, ' ');
  str = str.replace(/\(\s*v?[\d\.]+[^\)]*\)/gi, ' ');
  str = str.replace(/\s*[,:\-\u2013\u2014]\s*(?:v\d|build\b|update\b|patch\b|\+\s*\d|all dlc|bonus).*$/gi, ' ');
  str = str.replace(/\s*,\s*v?\d+(?:\.\d+)*.*$/gi, ' ');
  str = str.replace(/\bv\d+(?:\.\d+)+[a-z0-9_]*\b/gi, ' ');
  str = str.replace(/\b(?:FitGirl|DODI|Monkey|ElAmigos|TENOKE|RUNE|SKIDROW|CODEX|FLT|TiNYiSO|Razor1911)\b/gi, ' ');
  str = str.replace(/\b(?:Repack|Steam-Rip|GOG-Rip|Portable|Lossless|Rip)\b/gi, ' ');

  if (str.includes(' / ')) {
    const parts = str.split(' / ').map(p => p.trim()).filter(Boolean);
    if (parts.length > 1 && parts[0].length >= 3) str = parts[0];
  }

  str = str.replace(/[*?"<>|\\\/]/g, ' ');
  str = str.replace(/[\s\-_:\u2013\u2014,]+$/, '').replace(/^[\s\-_:\u2013\u2014,]+/, '');
  str = str.replace(/\s+/g, ' ').trim();

  if (str.length < 2) {
    str = String(rawTitle).replace(/\[[^\]]*\]/g, '').replace(/[*?"<>|\\\/]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  return str;
}

export function sanitizeFolderName(name) {
  if (!name) return 'Game';
  return String(name)
    .replace(/[?*'"<>|\\/]/g, ' -')
    .replace(/\s+/g, ' ')
    .replace(/\s*-\s*-\s*/g, ' - ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 120);
}

// -------------------------------------------------------------
// XML tag helpers (RSS/Atom without a parser dependency)
// -------------------------------------------------------------

function getXmlTag(xml, tagName) {
  const escaped = tagName.replace(':', '\\:');
  const reg = new RegExp(`<(?:${escaped})[^>]*>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))<\\/(?:${escaped})>`, 'i');
  const m = xml.match(reg);
  if (m) {
    const val = m[1] !== undefined ? m[1] : (m[2] || '');
    return val.trim();
  }
  return '';
}

function getXmlAttr(xml, tagName, attrName) {
  const reg = new RegExp(`<${tagName}[^>]+${attrName}=["']([^"']+)["']`, 'i');
  const m = xml.match(reg);
  return m ? m[1].trim() : '';
}

// -------------------------------------------------------------
// Thumbnail / preview extraction from RSS items
// -------------------------------------------------------------

function extractThumbnailAndWebm(itemXml, contentHtml, itemLink = '') {
  const decodedContent = decodeHtmlEntities(contentHtml || '');
  const decodedXml = decodeHtmlEntities(itemXml || '');
  const fullText = (itemXml + ' ' + (contentHtml || '') + ' ' + decodedContent + ' ' + decodedXml);

  const webmMatch = fullText.match(/(?:src|href|url)=["']([^"']+\.webm(?:\?[^"']*)?)["']/i) ||
                    fullText.match(/(https?:\/\/[^\s"'<>]+\.webm(?:\?[^\s"'<>]*)?)/i);
  if (webmMatch && webmMatch[1]) {
    return { url: webmMatch[1].replace(/&amp;/g, '&').trim(), isVideo: true };
  }

  const mediaThumb = getXmlAttr(itemXml, 'media:thumbnail', 'url') ||
                     getXmlAttr(itemXml, 'thumbnail', 'url') ||
                     getXmlAttr(decodedXml, 'media:thumbnail', 'url');
  if (mediaThumb) return { url: mediaThumb.replace(/&amp;/g, '&').trim(), isVideo: false };

  const mediaContent = fullText.match(/<media:content[^>]+url=["']([^"']+)["'][^>]*>/i);
  if (mediaContent && mediaContent[1] && !mediaContent[1].toLowerCase().includes('.webm')) {
    return { url: mediaContent[1].replace(/&amp;/g, '&').trim(), isVideo: false };
  }

  const encMatch = itemXml.match(/<enclosure[^>]+url=["']([^"']+)["'][^>]*>/i);
  if (encMatch && encMatch[1]) {
    const encUrl = encMatch[1].replace(/&amp;/g, '&').trim();
    if (encUrl.toLowerCase().includes('.webm')) return { url: encUrl, isVideo: true };
    if (encUrl.match(/\.(png|jpg|jpeg|webp|gif)/i) || itemXml.includes('type="image/')) {
      return { url: encUrl, isVideo: false };
    }
  }

  const iaServiceMatch = fullText.match(/(https?:\/\/archive\.org\/services\/(?:get-item-image\.php\?[^"'\s<>]+|img\/[^"'\s<>]+))/i);
  if (iaServiceMatch && iaServiceMatch[1]) {
    return { url: decodeHtmlEntities(iaServiceMatch[1]).trim(), isVideo: false };
  }

  const imgMatch = decodedContent.match(/<img[^>]+src=["']([^"'>]+)["']/i) ||
                   decodedXml.match(/<img[^>]+src=["']([^"'>]+)["']/i) ||
                   fullText.match(/<img[^>]+src=["']([^"'>]+)["']/i);
  if (imgMatch && imgMatch[1] && !imgMatch[1].includes('feedburner') && !imgMatch[1].includes('stat.')) {
    return { url: decodeHtmlEntities(imgMatch[1]).trim(), isVideo: false };
  }

  const directImgMatch = fullText.match(/(?:src|href)=["'](https?:\/\/[^"'\s<>]+\.(?:jpg|jpeg|png|webp|gif)(?:\?[^"'\s<>]*)?)["']/i);
  if (directImgMatch && directImgMatch[1]) {
    return { url: decodeHtmlEntities(directImgMatch[1]).trim(), isVideo: false };
  }

  if (itemLink) {
    const iaIdMatch = itemLink.match(/archive\.org\/details\/([^\/?#\s]+)/i);
    if (iaIdMatch && iaIdMatch[1]) {
      return { url: `https://archive.org/services/img/${iaIdMatch[1]}`, isVideo: false };
    }
  }

  return { url: null, isVideo: false };
}

// -------------------------------------------------------------
// Download link classification (mirrors & torrents on post pages)
// -------------------------------------------------------------

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
    { domain: 'archive.org', name: 'Internet Archive' },
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

function createDownloadItem({ url, type = '', length = null, source = 'enclosure', itemTitle = '' }) {
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

// Deep download-link extractor from RSS/Atom item (enclosures, magnets, mirrors)
function extractAllDownloadsFromRssItem(itemXml = '', htmlContent = '', primaryLink = '', itemTitle = '') {
  const downloads = [];
  const seenUrls = new Set();

  const isWebm = (u) => !!u && u.toLowerCase().split('?')[0].endsWith('.webm');

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
      downloads.push(createDownloadItem({ url, type, length, source: 'enclosure', itemTitle }));
    }
  }

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
      downloads.push(createDownloadItem({ url, type, length, source: 'enclosure', itemTitle }));
    }
  }

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
      downloads.push(createDownloadItem({ url, type, length, source: 'media', itemTitle }));
    }
  }

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

  if (primaryLink && /archive\.org\/details\/([^\/?#\s]+)/i.test(primaryLink)) {
    const iaIdMatch = primaryLink.match(/archive\.org\/details\/([^\/?#\s]+)/i);
    if (iaIdMatch && iaIdMatch[1]) {
      const iaId = iaIdMatch[1];
      const iaTorrentUrl = `https://archive.org/download/${iaId}/${iaId}_archive.torrent`;
      if (!seenUrls.has(iaTorrentUrl)) {
        seenUrls.add(iaTorrentUrl);
        downloads.push({
          id: 'dl-ia-' + Math.random().toString(36).substring(2, 9),
          url: iaTorrentUrl,
          filename: `${iaId}_archive.torrent`,
          extension: 'TORRENT',
          category: 'torrent',
          isMagnet: false,
          hoster: 'Internet Archive Torrent',
          sizeFormatted: 'Torrent File',
          source: 'link'
        });
      }
    }
  }

  const magnets = downloads.filter(d => d.isMagnet);
  const torrents = downloads.filter(d => !d.isMagnet && d.extension === 'TORRENT');
  const mirrors = downloads.filter(d => !d.isMagnet && d.extension !== 'TORRENT');
  return [...magnets, ...torrents, ...mirrors];
}

export function scrapeDownloadLinksFromHtml(htmlString, sourceUrl = '') {
  const links = [];
  const seenUrls = new Set();

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

  if (sourceUrl && /archive\.org\/details\/([^\/?#\s]+)/i.test(sourceUrl)) {
    const iaIdMatch = sourceUrl.match(/archive\.org\/details\/([^\/?#\s]+)/i);
    if (iaIdMatch && iaIdMatch[1]) {
      const iaId = iaIdMatch[1];
      const iaTorrentUrl = `https://archive.org/download/${iaId}/${iaId}_archive.torrent`;
      if (!seenUrls.has(iaTorrentUrl) && !links.some(l => l.url && l.url.includes(`${iaId}_archive.torrent`))) {
        seenUrls.add(iaTorrentUrl);
        links.unshift({
          id: 'dl-ia-' + Math.random().toString(36).substring(2, 9),
          url: iaTorrentUrl,
          filename: `${iaId}_archive.torrent`,
          extension: 'TORRENT',
          category: 'torrent',
          hoster: 'Internet Archive Torrent',
          isMagnet: false,
          source: 'page-scraper'
        });
      }
    }
  }

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

// -------------------------------------------------------------
// FitGirl "update / patch" post detection (base-game repacks only)
// -------------------------------------------------------------

export function isFitgirlUpdateTitle(title) {
  if (!title) return false;
  const t = title.trim();
  if (/^updates?[\s:\u2013\u2014\-]/i.test(t)) return true;
  if (/[-\u2013\u2014:]\s*updates?(?:\s+(?:to|v\d|\d|only|patch)|$)/i.test(t)) return true;
  if (/[\(\[]\s*updates?(?:\s+(?:to|v\d|\d|only|patch)|$|\s*[\)\]])/i.test(t)) return true;
  if (/\bupdates?\s+to\s+(?:v?[\d\.]+|version)/i.test(t)) return true;
  if (/\b(?:update\s+only|patch\s*\/\s*update|update\s*\/\s*patch|updates?\s+pack)\b/i.test(t)) return true;
  return false;
}

// -------------------------------------------------------------
// Feed fetch + parse (RSS or Atom). Returns { feed, items }
// -------------------------------------------------------------

export async function fetchFeed(feedUrl) {
  if (!feedUrl) throw new Error('Feed URL is required');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 14000);

  const response = await fetch(feedUrl, {
    signal: controller.signal,
    headers: {
      'User-Agent': UA_BROWSER,
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

  while ((match = itemRegex.exec(xmlString)) !== null && items.length < 60) {
    const itemXml = match[1];
    const title = getXmlTag(itemXml, 'title') || 'Untitled Release';

    let link = getXmlTag(itemXml, 'link');
    if (isAtom || !link) {
      const atomLinkMatch = itemXml.match(/<link[^>]+href=["']([^"']+)["'][^>]*>/i);
      if (atomLinkMatch) link = atomLinkMatch[1];
    }
    link = (link || '').replace(/&amp;/g, '&').trim();

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

    items.push({
      id: 'pcrss_' + crypto.createHash('md5').update(link || title).digest('hex').substring(0, 14),
      title,
      cleanTitle: cleanPcGameTitle(title),
      link,
      pubDate,
      author,
      excerpt: cleanExcerpt,
      size: rawSizeStr,
      sizeBytes,
      thumbnail: thumbInfo.url,
      isVideoThumbnail: thumbInfo.isVideo,
      hasMagnet: !!magnetUrl,
      magnetUrl,
      downloads,
      hasDownloads: downloads.length > 0,
      isUpdate: isFitgirlUpdateTitle(title),
      feedTitle
    });
  }

  return {
    title: feedTitle,
    description: feedDesc,
    link: feedLink,
    feedUrl,
    itemsCount: items.length,
    items
  };
}

// -------------------------------------------------------------
// Steam popular / new releases (SteamDB -> Steam search -> Steam RSS)
// -------------------------------------------------------------

function cleanSteamTitle(rawTitle) {
  if (!rawTitle) return '';
  let title = rawTitle.trim();
  title = title.replace(/^Now Available(?: on Steam)?\s*[-\u2013\u2014:]\s*/i, '');
  title = title.replace(/^Pre-Purchase(?: Now)?\s*[-\u2013\u2014:]\s*/i, '');
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
          'User-Agent': UA_BROWSER,
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

// -------------------------------------------------------------
// FitGirl availability cache & title matching
// -------------------------------------------------------------

const fitgirlAvailabilityCache = new Map();
const FITGIRL_CACHE_TTL = 24 * 60 * 60 * 1000;

export function normalizeTitleForFitgirlSearch(rawTitle) {
  if (!rawTitle) return '';
  let title = rawTitle.trim();
  title = decodeHtmlEntities(title);
  title = title.replace(/[™®©]/g, '');
  title = title.replace(/\s*(\(|\[)(?:demo|playtest|prologue|soundtrack|ost|dlc|deluxe|edition|bundle|vr|early access)[\s\S]*?(\)|\])/gi, '');
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
  if (isFitgirlUpdateTitle(fitgirlItemTitle)) return false;
  const qTokens = cleanTitleTokens(queryTitle);
  const fgTokens = cleanTitleTokens(fitgirlItemTitle);
  const fgTokenSet = new Set(fgTokens);
  if (qTokens.length === 0) return false;

  const numRegex = /^(?:[0-9]+|ii|iii|iv|v|vi|vii|viii|ix|x)$/i;
  const qNums = qTokens.filter(t => numRegex.test(t));
  const fgNums = fgTokens.filter(t => numRegex.test(t));

  for (const n of qNums) {
    if (!fgTokenSet.has(n)) return false;
  }

  if (qNums.length === 0 && fgNums.length > 0) {
    const firstQWord = qTokens[0];
    const qIndexInFg = fgTokens.indexOf(firstQWord);
    if (qIndexInFg !== -1 && fgTokens[qIndexInFg + 1] && numRegex.test(fgTokens[qIndexInFg + 1])) {
      return false;
    }
  }

  let matchCount = 0;
  for (const t of qTokens) {
    if (fgTokenSet.has(t)) matchCount++;
  }

  if (qTokens.length <= 2) return matchCount === qTokens.length;
  return (matchCount / qTokens.length) >= 0.7;
}

export async function checkFitgirlAvailability(rawGameTitle) {
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
        'User-Agent': UA_BROWSER,
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
        foundMatch = { title: itemTitle, link: itemLink };
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

export async function checkFitgirlBatch(titles) {
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
  for (let i = 0; i < count; i++) workers.push(worker());
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

// -------------------------------------------------------------
// Popular new releases (with multi-strategy fallback + caching)
// -------------------------------------------------------------

let steamPopularCache = { timestamp: 0, items: [] };

export async function fetchPopularGames({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && steamPopularCache.items.length > 0 && (now - steamPopularCache.timestamp < 10 * 60 * 1000)) {
    return { items: decorateItemsWithFitgirlCache(steamPopularCache.items), cached: true };
  }

  let items = [];

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);
    const response = await fetch('https://steamdb.info/upcoming/?lastweek', {
      signal: controller.signal,
      headers: {
        'User-Agent': UA_BROWSER,
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

  if (items.length === 0) {
    try {
      items = await fetchSteamPopularSearchGames();
    } catch (_) {}
  }

  if (items.length === 0) {
    try {
      const response = await fetch('https://store.steampowered.com/feeds/newreleases.xml', {
        headers: {
          'User-Agent': UA_BROWSER,
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
    steamPopularCache = { timestamp: now, items };
    return { items: decorateItemsWithFitgirlCache(items), cached: false };
  }

  if (steamPopularCache.items.length > 0) {
    return { items: decorateItemsWithFitgirlCache(steamPopularCache.items), cached: true };
  }

  return { items: [], error: 'Failed to retrieve popular games' };
}

// -------------------------------------------------------------
// Scrape a repack / post page for download links
// -------------------------------------------------------------

export async function scrapeLinksFromPage(pageUrl) {
  if (!pageUrl) throw new Error('Webpage URL is required');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 14000);

  const response = await fetch(pageUrl, {
    signal: controller.signal,
    headers: {
      'User-Agent': UA_BROWSER,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }
  });
  clearTimeout(timeout);

  if (!response.ok) {
    throw new Error(`Remote page responded with HTTP ${response.status}`);
  }

  const html = await response.text();
  const result = scrapeDownloadLinksFromHtml(html, pageUrl);
  const detectedSizeStr = extractSizeFromText(html);
  result.gameSize = detectedSizeStr;
  result.gameSizeBytes = detectedSizeStr ? parseSizeStringToBytes(detectedSizeStr) : null;

  const seenUrls = new Set(result.links.map(l => l.url));

  // 1. Scan raw HTML for direct FuckingFast URLs (including outside <a> tags)
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

  // 2. Deep-scrape paste.fitgirl-repacks.site links where multi-part FuckingFast mirrors are often hosted
  const pasteLinks = result.links.filter(l => l.url && (l.url.includes('paste.fitgirl-repacks.site') || l.hoster === 'FitGirl Paste'));
  for (const pl of pasteLinks.slice(0, 5)) {
    try {
      const pasteController = new AbortController();
      const pasteTimeout = setTimeout(() => pasteController.abort(), 6000);
      const pasteRes = await fetch(pl.url, {
        signal: pasteController.signal,
        headers: {
          'User-Agent': UA_BROWSER,
          'Accept': 'text/html,application/xhtml+xml,application/xml,text/plain,*/*'
        }
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

  // Sort: Magnets first, Torrents second, FuckingFast direct mirrors third, followed by other hosters
  const magnetLinks = result.links.filter(l => l.isMagnet || (l.url && l.url.startsWith('magnet:')));
  const torrentLinks = result.links.filter(l => !l.isMagnet && l.extension === 'TORRENT');
  const ffLinks = result.links.filter(l => !l.isMagnet && l.extension !== 'TORRENT' && l.hoster === 'FuckingFast');
  const otherMirrors = result.links.filter(l => !l.isMagnet && l.extension !== 'TORRENT' && l.hoster !== 'FuckingFast');
  const sortedLinks = [...magnetLinks, ...torrentLinks, ...ffLinks, ...otherMirrors];

  return {
    pageUrl,
    hasMagnet: magnetLinks.length > 0,
    hasTorrents: torrentLinks.length > 0,
    hasMirrors: (ffLinks.length + otherMirrors.length) > 0,
    hasFuckingFast: ffLinks.length > 0,
    magnetCount: magnetLinks.length,
    torrentCount: torrentLinks.length,
    fuckingFastCount: ffLinks.length,
    mirrorCount: ffLinks.length + otherMirrors.length,
    links: sortedLinks,
    totalFound: sortedLinks.length
  };
}

// -------------------------------------------------------------
// FuckingFast / DataNodes landing page handling
// (Electron-only resolver intentionally dropped: this is a hosted web app)
// -------------------------------------------------------------

export function isFuckingFastUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return url.toLowerCase().includes('fuckingfast.co');
}

export function isFuckingFastDirectUrl(url) {
  if (!isFuckingFastUrl(url)) return false;
  const cleanPath = url.split('#')[0].split('?')[0].toLowerCase();
  if (cleanPath.includes('/dl/')) return true;
  const lastSegment = cleanPath.substring(cleanPath.lastIndexOf('/') + 1);
  return /\.(rar|zip|7z|bin|iso|exe)$/i.test(lastSegment);
}

export function isFuckingFastLandingPage(url) {
  if (!isFuckingFastUrl(url)) return false;
  return !isFuckingFastDirectUrl(url);
}

function extractFuckingFastId(url) {
  try {
    const clean = url.split('#')[0].split('?')[0];
    const parsed = new URL(clean);
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (!parts.length) return null;
    return parts[parts.length - 1];
  } catch (_) {
    return null;
  }
}

// -------------------------------------------------------------
// Cloudflare / Turnstile handling.
//
// Since Aug 2026 the /f/{id}/go endpoint requires a cf-turnstile-response
// token (minted by the widget in a real browser) and the landing page is
// cleared by an edge challenge. A server-side fetch from a datacenter IP
// cannot pass either, so when a block is detected we throw a structured
// FuckingFastBlockedError and let the UI offer the "open popup / paste the
// direct file URL" flow. Direct links on dl.fuckingfast.co are NOT blocked,
// so the user only ever has to discover them once.
// -------------------------------------------------------------
const FF_BLOCK_MARKERS = /Just a moment|__cf_chl|challenges\.cloudflare\.com|cf-turnstile|captcha verification failed|cf-ch[l-]?/i;

export function isFuckingFastBlockedError(err) {
  return !!err && err.code === 'ff-captcha';
}

export class FuckingFastBlockedError extends Error {
  constructor(message, { fileId = null, url = null } = {}) {
    super(message);
    this.name = 'FuckingFastBlockedError';
    this.code = 'ff-captcha';
    this.fileId = fileId;
    this.url = url;
  }
}

// Negative cache: a brand-wide block means EVERY request to fuckingfast.co
// fails identically, so short-circuit the remaining links in a batch instead
// of burning ~7s each. Cleared automatically once a link resolves, and
// explicitly before a user-driven retry.
let ffBlockCooldownUntil = 0;
export function resetFuckingFastCooldown() { ffBlockCooldownUntil = 0; }

function collectCookies(res) {
  if (typeof res.headers.getSetCookie !== 'function') return null;
  const jar = [];
  for (const line of res.headers.getSetCookie()) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const name = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).split(';')[0].trim();
    if (name) jar.push(`${name}=${value}`);
  }
  return jar.length ? jar.join('; ') : null;
}

function ffHeaders(cleanUrl, cookie = null) {
  const headers = {
    'User-Agent': UA_BROWSER,
    'Accept': '*/*',
    'Referer': cleanUrl,
    'Origin': 'https://fuckingfast.co',
    'HX-Request': 'true',
    'HX-Current-URL': cleanUrl,
    'Accept-Language': 'en-US,en;q=0.9'
  };
  if (cookie) headers['Cookie'] = cookie;
  return headers;
}

async function ffFetch(path, { method = 'GET', cleanUrl, cookie = null, body = null, timeoutMs = 7000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = ffHeaders(cleanUrl, cookie);
    if (method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded';
    return await fetch(`https://fuckingfast.co${path}`, {
      method,
      signal: controller.signal,
      redirect: 'manual',
      headers,
      body: method === 'POST' ? (body || '') : undefined
    });
  } finally {
    clearTimeout(timer);
  }
}

// -------------------------------------------------------------
// Chrome-TLS impersonation via ffResolver.py (curl_cffi).
// Cloudflare's edge fingerprints plain Node/undici TLS handshakes (JA3/JA4)
// and 403s them with "Just a moment". curl_cffi presents a full Chrome
// TLS/HTTP2 profile, so the landing page loads and the HTMX POST /go returns
// the signed dl.fuckingfast.co direct URL in its HX-Redirect header.
// This is the only path that works from a server IP without a real browser.
// -------------------------------------------------------------
const execFileAsync = promisify(execFile);
const FF_RESOLVER_PY = fileURLToPath(new URL('./ffResolver.py', import.meta.url));

// null = unprobed, string = python path to use, false = none available
let ffPythonProbe = null;

async function findFuckingFastPython() {
  if (ffPythonProbe !== null) return ffPythonProbe;
  const candidates = process.env.FF_PYTHON
    ? [process.env.FF_PYTHON]
    : ['python3', 'python'];
  for (const cand of candidates) {
    if (!cand) continue;
    try {
      await execFileAsync(cand, ['-c', 'import curl_cffi'], { timeout: 8000, windowsHide: true });
      ffPythonProbe = cand;
      console.log(`[FuckingFast] using "${cand}" (curl_cffi) for direct-link resolution`);
      return cand;
    } catch (_) { /* try next candidate */ }
  }
  ffPythonProbe = false;
  return false;
}

/** Resolves via curl_cffi impersonation. Never throws; returns { ok, url?, blocked?, message? }. */
export async function resolveFuckingFastUrlViaPython(url) {
  const py = await findFuckingFastPython();
  if (!py) return { ok: false };
  const cleanUrl = url.split('#')[0];
  const fileId = extractFuckingFastId(cleanUrl);
  try {
    const { stdout } = await execFileAsync(py, [FF_RESOLVER_PY, cleanUrl], {
      timeout: 35000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024
    });
    const line = String(stdout || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => /^(DIRECT|BLOCKED|ERROR):/.test(l));
    if (line && line.startsWith('DIRECT:')) {
      const direct = line.slice(line.indexOf(':') + 1).trim();
      ffBlockCooldownUntil = 0;
      console.log(`[FuckingFast] resolved ${fileId} -> direct link`);
      return { ok: true, url: direct };
    }
    if (line && line.startsWith('BLOCKED:')) {
      return { ok: false, blocked: true, message: line.slice(line.indexOf(':') + 1).trim() };
    }
    return { ok: false, message: line ? line.slice(line.indexOf(':') + 1).trim() : 'resolver produced no output' };
  } catch (err) {
    const reason = String(err?.message || err?.code || 'spawn failed').replace(/\s+/g, ' ').slice(0, 300);
    console.warn(`[FuckingFast] python resolver error: ${reason}`);
    return { ok: false, message: reason };
  }
}

export async function resolveFuckingFastUrl(url, opts = {}) {
  if (!isFuckingFastUrl(url)) return url;
  if (isFuckingFastDirectUrl(url)) return url;

  const { turnstileToken } = opts || {};
  const cleanUrl = url.split('#')[0];
  const fileId = extractFuckingFastId(cleanUrl);
  if (!fileId) throw new Error('Could not parse file ID from FuckingFast URL');

  const blocked = (message) => {
    ffBlockCooldownUntil = Date.now() + 10 * 60 * 1000;
    throw new FuckingFastBlockedError(message, { fileId, url });
  };

  // Strategy 0: Chrome-TLS impersonation (curl_cffi via ffResolver.py). This is
  // the only path that reliably passes Cloudflare's TLS-fingerprint edge check
  // from a server. Runs before the cooldown short-circuit so a stale negative
  // cache never suppresses a now-working resolver.
  const viaPython = await resolveFuckingFastUrlViaPython(url);
  if (viaPython.ok) return viaPython.url;

  // Strategy 0A: Delegated resolution via Central Downloader Node (IONOS VPS with curl_cffi)
  const client = opts?.downloaderClient;
  if (client?.resolveLink) {
    try {
      const resolved = await client.resolveLink(url);
      if (resolved && isFuckingFastDirectUrl(resolved)) {
        ffBlockCooldownUntil = 0;
        console.log(`[FuckingFast] resolved via downloader node: ${fileId} -> direct link`);
        return resolved;
      }
    } catch (err) {
      console.warn(`[FuckingFast] downloader node resolve failed: ${err.message}`);
    }
  } else {
    try {
      const { GameDownloaderClient } = await import('./downloaderClient.js');
      if (GameDownloaderClient?.resolveLink) {
        const resolved = await GameDownloaderClient.resolveLink(url);
        if (resolved && isFuckingFastDirectUrl(resolved)) {
          ffBlockCooldownUntil = 0;
          console.log(`[FuckingFast] resolved via downloader node: ${fileId} -> direct link`);
          return resolved;
        }
      }
    } catch (_) {}
  }

  if (viaPython.blocked) {
    throw blocked(`FuckingFast ${viaPython.message || 'is blocking automated access'}. Open the link in your browser, pass the check, then paste the direct file URL.`);
  }

  if (Date.now() < ffBlockCooldownUntil) {
    throw new FuckingFastBlockedError(
      'FuckingFast is blocking automated access (Cloudflare check already detected). Open the link in your browser, pass the check, then paste the direct file URL.',
      { fileId, url }
    );
  }

  // Warm the landing page first: captures a browser-like cookie session and
  // detects a hard edge challenge quickly, before paying for the /go round-trip.
  let cookie = null;
  try {
    const warmRes = await ffFetch(`/${fileId}`, { cleanUrl, method: 'GET', timeoutMs: 8000 });
    cookie = collectCookies(warmRes) || cookie;
    if (warmRes.status === 429) throw blocked('FuckingFast is rate-limiting the server right now. Wait a few minutes and try again.');
    const warmBody = warmRes.ok ? await warmRes.text().catch(() => '') : '';
    if (!warmRes.ok || FF_BLOCK_MARKERS.test(warmBody)) {
      throw blocked('FuckingFast is protected by a Cloudflare check that the server cannot pass (only your browser can). Open the link and paste the direct file URL.');
    }
  } catch (err) {
    if (isFuckingFastBlockedError(err)) throw err;
  }

  // Strategy 1: HTMX POST to /f/{id}/go. The direct /dl/ URL is only ever
  // returned in an HX-Redirect response header (the landing page does not embed it).
  try {
    const params = new URLSearchParams();
    if (turnstileToken) params.set('cf-turnstile-response', turnstileToken);

    const postRes = await ffFetch(`/f/${fileId}/go`, {
      cleanUrl,
      method: 'POST',
      cookie,
      body: params.toString(),
      timeoutMs: 8000
    });

    const redirectUrl = postRes.headers.get('hx-redirect') ||
                        postRes.headers.get('hx-location') ||
                        postRes.headers.get('location');

    if (redirectUrl) {
      const fullUrl = new URL(redirectUrl.trim(), 'https://fuckingfast.co').href;
      if (isFuckingFastDirectUrl(fullUrl)) {
        ffBlockCooldownUntil = 0;
        return fullUrl;
      }
    }

    const postBody = await postRes.text().catch(() => '');
    if (!postRes.ok || postRes.status === 429 || FF_BLOCK_MARKERS.test(postBody)) {
      throw blocked(turnstileToken
        ? 'FuckingFast still refused the link (the Cloudflare token was rejected or expired). Re-open the popup, pass the check again, and retry.'
        : 'FuckingFast requires solving a Cloudflare captcha before it issues a direct link. The server cannot auto-solve it - use the popup flow or paste the direct file URL.');
    }

    const bodyMatch = postBody.match(/https:\/\/[a-zA-Z0-9.-]*fuckingfast\.co\/dl\/[^\s"'<>\\]+/i) ||
                      postBody.match(/window\.open\(\s*["']([^"']+)["']/i) ||
                      postBody.match(/(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/i);
    if (bodyMatch && bodyMatch[1]) {
      const candidate = new URL(bodyMatch[1], 'https://fuckingfast.co').href;
      if (isFuckingFastDirectUrl(candidate)) {
        ffBlockCooldownUntil = 0;
        return candidate;
      }
    }
  } catch (err) {
    if (isFuckingFastBlockedError(err)) throw err;
  }

  // Strategy 2: inspect the landing page HTML (non-blocked fallback).
  try {
    const pageRes = await ffFetch(`/${fileId}`, { cleanUrl, method: 'GET', cookie, timeoutMs: 8000 });
    if (pageRes.ok) {
      const html = await pageRes.text();

      const inlineDlMatch = html.match(/https:\/\/[a-zA-Z0-9.-]*fuckingfast\.co\/dl\/[^\s"'<>\\]+/i) ||
                            html.match(/window\.open\(\s*["'](https?:\/\/[^"']+)["']/i) ||
                            html.match(/(?:window\.)?location(?:\.href)?\s*=\s*["'](https?:\/\/[^"']+)["']/i);
      if (inlineDlMatch && inlineDlMatch[1]) {
        const fullUrl = new URL(inlineDlMatch[1], 'https://fuckingfast.co').href;
        if (isFuckingFastDirectUrl(fullUrl)) {
          ffBlockCooldownUntil = 0;
          return fullUrl;
        }
      }

      const hxEndpointMatch = html.match(/(?:hx-post|data-hx-post)=["']([^"']+)["']/i) ||
                              html.match(/(?:hx-get|data-hx-get)=["']([^"']+)["']/i);
      if (hxEndpointMatch && hxEndpointMatch[1]) {
        const endpoint = hxEndpointMatch[1];
        const method = (html.match(/hx-get/i) ? 'GET' : 'POST');

        const subRes = await ffFetch(endpoint, {
          cleanUrl,
          method,
          cookie,
          timeoutMs: 8000
        });

        const subRedirect = subRes.headers.get('hx-redirect') ||
                            subRes.headers.get('hx-location') ||
                            subRes.headers.get('location');
        if (subRedirect) {
          const resolved = new URL(subRedirect.trim(), 'https://fuckingfast.co').href;
          if (isFuckingFastDirectUrl(resolved)) {
            ffBlockCooldownUntil = 0;
            return resolved;
          }
        }
      }
    }
  } catch (_) {}

  throw new Error('Unable to automatically extract direct download link from FuckingFast. Open the link in your browser and paste the direct file URL.');
}

export function isDataNodesLandingPage(url) {
  if (!url || typeof url !== 'string') return false;
  const lower = url.toLowerCase();
  return lower.includes('datanodes.to') && !(lower.includes(':8443') || lower.includes('/d/'));
}
