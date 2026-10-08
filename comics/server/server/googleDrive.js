const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const GoogleAuth = require('./googleAuth');
const Database = require('./database');
const CacheManager = require('./cacheManager');
const CBZReader = require('./cbzReader');
const ComicCompressor = require('./comicCompressor');

// In-flight download deduplication: googleFileId -> Promise<string>
const activeDownloads = new Map();
// In-flight cover extraction deduplication: googleFileId -> Promise<{ data, mimeType }>
const activeCoverRequests = new Map();

/**
 * Google Drive API v3 Integration:
 * Lightweight, direct REST client with automatic token refreshing.
 * Supports:
 * - In-app folder browsing and folder creation
 * - Recursive comic library indexing (.cbz, .cbr, .zip)
 * - On-demand streaming with local caching
 * - Fast page extraction and cover caching
 * - Direct upload of downloaded comics into user's Google Drive folder
 */

const GENERIC_FOLDERS = new Set([
  'other comics',
  'marvel comics',
  'dc comics',
  'image comics',
  'idw publishing',
  'boom studios',
  'dark horse',
  'dynamite',
  'valiant',
  'vertigo',
  'comics',
  'downloads',
  'dl',
  'unsorted',
  'loose',
  'temp',
  '_tmp',
  'new'
]);

function sanitizeSeriesName(name) {
  if (!name) return 'Comics';
  return name
    .replace(/[<>:"/\\|?*]+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[-–—\s,.]+|[-–—\s,.]+$/g, '')
    .trim();
}

function parseComicTitle(rawTitle) {
  if (!rawTitle || typeof rawTitle !== 'string') {
    return { series: 'Comics', item: 'Issue 01', isVolume: false, rawTitle: '' };
  }

  // Strip file extension if present
  let clean = rawTitle.replace(/\.(cbz|cbr|pdf|zip)$/i, '').trim();

  // Strip typical release group and format tags
  clean = clean
    .replace(/\b(digital|hd|webrip|c2c|novus|minutemen|zone-empire|empire|dcp|kresge|steam|hybrid|complete|scan)\b/gi, '')
    .replace(/\(cover\s+[a-z0-9]+\)/gi, '')
    .replace(/\[\s*\]|\(\s*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // 1a. Check Volume / Book / TPB / Compendium / Omnibus / Tome patterns with volume/book number
  const volMatch = clean.match(/^(.*?)(?:[\s,–—:-]+|\s+)(?:(vol(?:ume)?|bk|book|tpb|tome|compendium|omnibus)\.?|v)\s*([0-9]+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)\b(?:\s*[:-]\s*(.*?))?(?:\s*\(.*?\))?$/i);
  if (volMatch && volMatch[1].trim().length > 1) {
    const rawSeries = volMatch[1].trim();
    const typeLabel = (volMatch[2] || 'Vol').toLowerCase();
    const numRaw = volMatch[3];
    const subtitle = volMatch[4] ? volMatch[4].trim() : '';

    let formattedNum = numRaw;
    const parsedNum = parseInt(numRaw, 10);
    if (!isNaN(parsedNum)) {
      formattedNum = String(parsedNum).padStart(2, '0');
    }

    let prefix = 'Vol.';
    if (typeLabel.startsWith('book') || typeLabel.startsWith('bk')) prefix = 'Book';
    else if (typeLabel.startsWith('tpb')) prefix = 'TPB';
    else if (typeLabel.startsWith('compendium')) prefix = 'Compendium';
    else if (typeLabel.startsWith('omnibus')) prefix = 'Omnibus';
    else if (typeLabel.startsWith('tome')) prefix = 'Tome';

    let itemStr = `${prefix} ${formattedNum}`;
    if (subtitle) {
      itemStr += ` - ${subtitle}`;
    }

    return {
      series: sanitizeSeriesName(rawSeries),
      item: itemStr,
      isVolume: true,
      rawTitle
    };
  }

  // 1b. Standalone Omnibus / Compendium / TPB / Collection / Deluxe Edition WITHOUT a number
  // e.g. "Batman Omnibus", "Batman - Court of Owls Omnibus", "Saga Deluxe Edition", "Civil War Compendium"
  const standaloneVolMatch = clean.match(/^(.*?)(?:[\s,–—:-]+|\s+)(omnibus|compendium|tpb|tome|collection|deluxe(?:\s+edition)?|absolute)\b(?:\s*[:-]\s*(.*?))?(?:\s*\(.*?\))?$/i);
  if (standaloneVolMatch && standaloneVolMatch[1].trim().length > 1) {
    const rawSeriesPart = standaloneVolMatch[1].trim();
    const typeLabel = standaloneVolMatch[2];
    const subtitle = standaloneVolMatch[3] ? standaloneVolMatch[3].trim() : '';

    let prefix = 'Omnibus';
    if (/compendium/i.test(typeLabel)) prefix = 'Compendium';
    else if (/tpb/i.test(typeLabel)) prefix = 'TPB';
    else if (/deluxe/i.test(typeLabel)) prefix = 'Deluxe Edition';
    else if (/absolute/i.test(typeLabel)) prefix = 'Absolute';
    else if (/collection/i.test(typeLabel)) prefix = 'Collection';
    else if (/tome/i.test(typeLabel)) prefix = 'Tome';

    let itemStr = prefix;
    let seriesStr = sanitizeSeriesName(rawSeriesPart);

    // If rawSeriesPart contains a subtitle like "Batman - Court of Owls"
    const splitMatch = rawSeriesPart.match(/^(.*?)\s*[-–—:]\s*(.*?)$/);
    if (splitMatch && splitMatch[1].trim().length > 1) {
      seriesStr = sanitizeSeriesName(splitMatch[1].trim());
      itemStr = `${prefix} - ${splitMatch[2].trim()}`;
    } else if (subtitle) {
      itemStr += ` - ${subtitle}`;
    }

    return {
      series: seriesStr,
      item: itemStr,
      isVolume: true,
      rawTitle
    };
  }

  // 1c. Title starting with Omnibus/Collection
  if (/^omnibus\b/i.test(clean)) {
    return {
      series: 'Comics',
      item: clean,
      isVolume: true,
      rawTitle
    };
  }

  // 2. Check Issue Hashtag pattern: "Batman #125", "Amazing Spider-Man (2022) #01", "Revival #47"
  const hashMatch = clean.match(/^(.*?)(?:\s*#\s*([0-9]+(?:\.[0-9]+)?))/i);
  if (hashMatch && hashMatch[1].trim().length > 1) {
    const rawSeries = hashMatch[1].trim();
    const num = hashMatch[2];
    const parsed = parseInt(num, 10);
    const formatted = !isNaN(parsed) && !num.includes('.') ? String(parsed).padStart(2, '0') : num;
    return {
      series: sanitizeSeriesName(rawSeries),
      item: `Issue ${formatted}`,
      isVolume: false,
      rawTitle
    };
  }

  // 3. Check explicit Issue / Chapter words: "Invincible - Issue 100", "Batman Chapter 12"
  const wordMatch = clean.match(/^(.*?)(?:[\s,–—:-]+|\s+)(?:issue|iss|ch|chapter|no)\.?\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (wordMatch && wordMatch[1].trim().length > 1) {
    const rawSeries = wordMatch[1].trim();
    const num = wordMatch[2];
    const parsed = parseInt(num, 10);
    const formatted = !isNaN(parsed) && !num.includes('.') ? String(parsed).padStart(2, '0') : num;
    return {
      series: sanitizeSeriesName(rawSeries),
      item: `Issue ${formatted}`,
      isVolume: false,
      rawTitle
    };
  }

  // 4. Check trailing digits preceded by hyphen or space (with optional trailing year)
  const trailingNumMatch = clean.match(/^(.*?)(?:\s*[-–—]\s*|\s+)(?:0([0-9]+)|([0-9]{1,4}))(?:\s*\(.*?\))?$/);
  if (trailingNumMatch && trailingNumMatch[1].trim().length > 1) {
    const rawSeries = trailingNumMatch[1].trim();
    const num = trailingNumMatch[2] || trailingNumMatch[3];
    const parsed = parseInt(num, 10);
    const formatted = !isNaN(parsed) ? String(parsed).padStart(2, '0') : num;
    return {
      series: sanitizeSeriesName(rawSeries),
      item: `Issue ${formatted}`,
      isVolume: false,
      rawTitle
    };
  }

  // 5. Check Annual / Special / One-Shot pattern
  const specialMatch = clean.match(/^(.*?)(?:[\s,–—:-]+|\s+)(annual|special|one-shot|giant-size)\b(?:\s*#?\s*([0-9]+))?/i);
  if (specialMatch && specialMatch[1].trim().length > 1) {
    const rawSeries = specialMatch[1].trim();
    const type = specialMatch[2].charAt(0).toUpperCase() + specialMatch[2].slice(1).toLowerCase();
    const num = specialMatch[3];
    let formatted = '';
    if (num) {
      const parsed = parseInt(num, 10);
      formatted = !isNaN(parsed) ? ` ${String(parsed).padStart(2, '0')}` : ` ${num}`;
    }
    return {
      series: sanitizeSeriesName(rawSeries),
      item: `${type}${formatted}`,
      isVolume: false,
      rawTitle
    };
  }

  // Fallback: clean without trailing hyphens/punctuation
  const fallbackSeries = sanitizeSeriesName(clean);
  return {
    series: fallbackSeries || 'Comics',
    item: 'Issue 01',
    isVolume: false,
    rawTitle
  };
}

function parseTitleAndSeries(fileName, folderSeries = '') {
  let cleanName = fileName.replace(/\.(cbz|cbr|zip)$/i, '').trim();
  const parsed = parseComicTitle(cleanName);

  let series = parsed.series;
  if (folderSeries && folderSeries.trim()) {
    const norm = folderSeries.trim().toLowerCase();
    if (!GENERIC_FOLDERS.has(norm)) {
      series = sanitizeSeriesName(folderSeries.trim());
    }
  }

  let cleanTitle = `${series} - ${parsed.item}`;
  let cleanFilename = `${cleanTitle}.cbz`;

  // For volumes/omnibuses that already cleanly contain the series or full descriptive name,
  // retain the clean name rather than mangling it with a redundant prefix
  if (parsed.isVolume) {
    if (cleanName.toLowerCase().startsWith(series.toLowerCase()) || cleanName.toLowerCase().includes('omnibus')) {
      cleanTitle = cleanName;
      cleanFilename = `${cleanName}.cbz`;
    }
  }

  return {
    title: cleanTitle,
    series: series || 'Comics',
    item: parsed.item,
    isVolume: parsed.isVolume,
    cleanFilename
  };
}

const GoogleDrive = {
  /**
   * Lists folders in Google Drive under a parent folder.
   */
  async listFolders(user, parentId = 'root') {
    const accessToken = await GoogleAuth.getValidAccessToken(user);
    const query = `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.set('q', query);
    url.searchParams.set('fields', 'files(id, name, mimeType, modifiedTime, parents)');
    url.searchParams.set('orderBy', 'name');
    url.searchParams.set('pageSize', '100');

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error?.message || 'Failed to list Google Drive folders');
    }

    return data.files || [];
  },

  /**
   * Creates a new folder in Google Drive.
   */
  async createFolder(user, folderName, parentId = null) {
    const accessToken = await GoogleAuth.getValidAccessToken(user);
    const targetParent = parentId || user.driveFolderId || 'root';

    const res = await fetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [targetParent]
      })
    });

    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error?.message || 'Failed to create folder in Google Drive');
    }

    return data;
  },

  /**
   * Finds or creates a subfolder by name inside a parent folder.
   */
  async getOrCreateSubfolder(user, folderName, parentId) {
    const accessToken = await GoogleAuth.getValidAccessToken(user);
    const escapedName = folderName.replace(/'/g, "\\'");
    const query = `'${parentId}' in parents and name = '${escapedName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.set('q', query);
    url.searchParams.set('fields', 'files(id, name)');

    const searchRes = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const searchData = await searchRes.json();
    if (searchData.files && searchData.files.length > 0) {
      return searchData.files[0];
    }

    return await this.createFolder(user, folderName, parentId);
  },

  /**
   * Gets details of a specific folder.
   */
  getUserPrefix(user) {
    const email = (user?.email || '').trim();
    let prefix = '';
    if (email && email.includes('@')) {
      prefix = email.split('@')[0].trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
    }
    if (!prefix && user?.id) {
      prefix = String(user.id).trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
    }
    return prefix || 'user';
  },

  getUserMetaFilename(user, baseName) {
    const prefix = this.getUserPrefix(user);
    return `${prefix}-${baseName}`;
  },

  async findFileByName(user, parentId, fileName) {
    if (!parentId) return null;
    const accessToken = await GoogleAuth.getValidAccessToken(user);
    const safeName = String(fileName).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const q = `'${parentId}' in parents and name = '${safeName}' and trashed = false`;
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.set('q', q);
    url.searchParams.set('fields', 'files(id, name, mimeType, size)');
    url.searchParams.set('pageSize', '1');

    try {
      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      const data = await res.json();
      if (data.files && data.files.length > 0) {
        return data.files[0];
      }
    } catch (err) {
      console.warn(`[GoogleDrive] findFileByName (${fileName}) warning:`, err.message);
    }
    return null;
  },

  async writeJsonFile(user, folderId, fileName, payload) {
    if (!folderId) return null;
    try {
      const accessToken = await GoogleAuth.getValidAccessToken(user);
      const buffer = Buffer.from(JSON.stringify(payload, null, 2), 'utf-8');
      const existing = await this.findFileByName(user, folderId, fileName);

      if (existing) {
        const patchUrl = `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=media&fields=id,name,size`;
        const res = await fetch(patchUrl, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: buffer
        });
        if (res.ok) return await res.json();
      }

      const uploadUrl = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size';
      const boundary = `comics_${Date.now()}_${Math.random().toString(36).substring(2)}`;
      const metadata = { name: fileName, parents: [folderId], mimeType: 'application/json' };
      const delimiter = `\r\n--${boundary}\r\n`;
      const closeDelimiter = `\r\n--${boundary}--`;

      const multipartBody = Buffer.concat([
        Buffer.from(delimiter + 'Content-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(metadata) + delimiter + 'Content-Type: application/json\r\n\r\n'),
        buffer,
        Buffer.from(closeDelimiter)
      ]);

      const res = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
          'Content-Length': String(multipartBody.length)
        },
        body: multipartBody
      });

      if (res.ok) return await res.json();
    } catch (err) {
      console.warn(`[GoogleDrive] writeJsonFile (${fileName}) error:`, err.message);
    }
    return null;
  },

  async readJsonFile(user, fileId) {
    try {
      const accessToken = await GoogleAuth.getValidAccessToken(user);
      const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      if (res.ok) return await res.json();
    } catch (err) {
      console.warn('[GoogleDrive] readJsonFile error:', err.message);
    }
    return null;
  },

  async getFolderInfo(user, folderId) {
    const accessToken = await GoogleAuth.getValidAccessToken(user);
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${folderId}?fields=id,name,mimeType`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error?.message || 'Failed to get folder information');
    }
    return data;
  },

  /**
   * Recursively scans the user's selected Google Drive folder for comic archives.
   */
  async syncLibrary(user, options = {}) {
    if (!user.driveFolderId) {
      throw new Error('No Google Drive folder selected. Please select a folder in Settings.');
    }

    const accessToken = await GoogleAuth.getValidAccessToken(user);
    const discoveredComics = [];

    // Recursive helper to traverse folders
    async function scanFolder(folderId, seriesName = '') {
      let pageToken = null;
      do {
        const query = `'${folderId}' in parents and trashed = false`;
        const url = new URL('https://www.googleapis.com/drive/v3/files');
        url.searchParams.set('q', query);
        url.searchParams.set('fields', 'nextPageToken, files(id, name, mimeType, size, modifiedTime, thumbnailLink, hasThumbnail)');
        url.searchParams.set('pageSize', '100');
        if (pageToken) url.searchParams.set('pageToken', pageToken);

        const res = await fetch(url.toString(), {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const data = await res.json();
        if (!res.ok || data.error) {
          console.warn('[GoogleDrive] Sync folder query warning:', data.error?.message);
          break;
        }

        const files = data.files || [];
        // Map companion cover image files in this folder by base name (e.g. "comic.jpg" -> "comic")
        const imageFileMap = new Map();
        for (const file of files) {
          if (/\.(jpe?g|png|webp)$/i.test(file.name)) {
            const base = file.name.replace(/\.[a-zA-Z0-9]+$/i, '').toLowerCase();
            imageFileMap.set(base, file);
          }
        }

        for (const file of files) {
          if (file.mimeType === 'application/vnd.google-apps.folder') {
            // Recurse into series subfolder
            await scanFolder(file.id, file.name);
          } else if (/\.(cbz|cbr|zip)$/i.test(file.name)) {
            const parsed = parseTitleAndSeries(file.name, seriesName);
            const base = file.name.replace(/\.[a-zA-Z0-9]+$/i, '').toLowerCase();
            const matchingJpg = imageFileMap.get(base);
            const coverImage = (matchingJpg && matchingJpg.thumbnailLink)
              ? matchingJpg.thumbnailLink.replace(/=s\d+$/, '=s400')
              : (file.thumbnailLink ? file.thumbnailLink.replace(/=s\d+$/, '=s400') : null);

            discoveredComics.push({
              googleFileId: file.id,
              title: parsed.title,
              series: parsed.series,
              item: parsed.item,
              isVolume: parsed.isVolume,
              size: parseInt(file.size, 10) || 0,
              mimeType: file.mimeType,
              coverImage,
              modifiedTime: file.modifiedTime
            });
          }
        }

        pageToken = data.nextPageToken;
      } while (pageToken);
    }

    await scanFolder(user.driveFolderId, '');

    // Batch update database
    const synced = Database.batchSyncComics(user.id, discoveredComics, options.protectFileIds || []);

    // Sync comic library JSON to user's Google Drive folder
    try {
      const libraryFileName = this.getUserMetaFilename(user, 'comics-library.json');
      await this.writeJsonFile(user, user.driveFolderId, libraryFileName, {
        version: 1,
        folderName: user.driveFolderName || 'Comics',
        updatedAt: Date.now(),
        count: synced.length,
        comics: synced
      });
    } catch (libErr) {
      console.warn('[GoogleDrive] Failed to write library to Drive:', libErr.message);
    }
    return {
      count: synced.length,
      comics: synced
    };
  },

  /**
   * Downloads a comic file from Google Drive into the local cache if not already cached.
   * Streams directly to disk to keep RAM usage under 100KB, preventing 503 errors on shared hosting.
   * Deduplicates concurrent requests for the same comic.
   */
  async ensureComicCached(user, googleFileId) {
    if (!googleFileId) {
      throw new Error('Missing Google Drive file ID');
    }

    if (CacheManager.hasComic(googleFileId)) {
      return CacheManager.getComicCachePath(googleFileId);
    }

    if (activeDownloads.has(googleFileId)) {
      return activeDownloads.get(googleFileId);
    }

    const downloadPromise = (async () => {
      let tempPath = null;
      let fileStream = null;
      try {
        const accessToken = await GoogleAuth.getValidAccessToken(user);
        const downloadUrl = `https://www.googleapis.com/drive/v3/files/${googleFileId}?alt=media`;

        const res = await fetch(downloadUrl, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });

        if (!res.ok) {
          throw new Error(`Google Drive download failed: HTTP ${res.status}`);
        }

        const finalPath = CacheManager.getComicCachePath(googleFileId);
        tempPath = `${finalPath}.part_${Date.now()}`;

        // Stream directly to disk using minimal memory (<100KB)
        fileStream = fs.createWriteStream(tempPath);
        if (res.body.pipe) {
          await pipeline(res.body, fileStream);
        } else if (Readable.fromWeb) {
          await pipeline(Readable.fromWeb(res.body), fileStream);
        } else {
          const arrayBuf = await res.arrayBuffer();
          fs.writeFileSync(tempPath, Buffer.from(arrayBuf));
        }

        fs.renameSync(tempPath, finalPath);
        return finalPath;
      } catch (err) {
        if (fileStream) {
          try { fileStream.destroy(); } catch (e) {}
        }
        if (tempPath && fs.existsSync(tempPath)) {
          try { fs.unlinkSync(tempPath); } catch (e) {}
        }
        console.error(`[GoogleDrive] Error downloading comic ${googleFileId}:`, err.message);
        throw err;
      } finally {
        activeDownloads.delete(googleFileId);
      }
    })();

    activeDownloads.set(googleFileId, downloadPromise);
    return downloadPromise;
  },

  /**
   * Returns comic page list from Google Drive file.
   */
  async getComicPages(user, comic) {
    const cachedPath = await this.ensureComicCached(user, comic.googleFileId);
    return CBZReader.getPageList(cachedPath);
  },

  /**
   * Extracts a specific page image from the comic file.
   */
  async getComicPage(user, comic, pageNum) {
    const cachedPath = await this.ensureComicCached(user, comic.googleFileId);
    return CBZReader.extractPage(cachedPath, pageNum);
  },

  /**
   * Fast Range-based cover extraction directly from Google Drive.
   * Downloads only ~2MB instead of the entire 100MB archive.
   */
  async extractCoverViaRange(user, googleFileId) {
    const accessToken = await GoogleAuth.getValidAccessToken(user);
    const downloadUrl = `https://www.googleapis.com/drive/v3/files/${googleFileId}?alt=media`;

    // Fetch first 2.5 MB (covers 95%+ of comic covers in CBZ archives)
    const rangeHeader = 'bytes=0-2621439';
    const res = await fetch(downloadUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Range: rangeHeader
      }
    });

    if (!res.ok && res.status !== 206) {
      throw new Error(`Range request returned status ${res.status}`);
    }

    const chunkBuf = Buffer.from(await res.arrayBuffer());
    return CBZReader.extractFirstImageFromBuffer(chunkBuf, async (start, end) => {
      const subRes = await fetch(downloadUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Range: `bytes=${start}-${end}`
        }
      });
      if (!subRes.ok && subRes.status !== 206) {
        throw new Error(`Targeted range request returned ${subRes.status}`);
      }
      return Buffer.from(await subRes.arrayBuffer());
    });
  },

  /**
   * Retrieves or generates the cover image for a comic.
   * Prioritizes fast 2MB range extraction to prevent 503 timeouts on shared hosting.
   */
  async getComicCover(user, comic) {
    const fileId = comic.googleFileId || comic.id;

    // 1. Check disk cover cache (<1ms response)
    if (CacheManager.hasCover(fileId)) {
      const coverPath = CacheManager.getCoverCachePath(fileId);
      const data = fs.readFileSync(coverPath);
      return { data, mimeType: 'image/jpeg' };
    }

    // Deduplicate in-flight cover requests for this comic
    if (activeCoverRequests.has(fileId)) {
      return activeCoverRequests.get(fileId);
    }

    const coverPromise = (async () => {
      try {
        // 2. If the full comic archive is already cached locally, extract page 1 from it (<5ms)
        if (comic.googleFileId && CacheManager.hasComic(comic.googleFileId)) {
          const cachedPath = CacheManager.getComicCachePath(comic.googleFileId);
          const page1 = CBZReader.extractPage(cachedPath, 1);
          CacheManager.saveCoverBuffer(fileId, page1.data);
          return { data: page1.data, mimeType: page1.mimeType };
        }

        // 3. Fast Range extraction: Download only the first ~2MB to extract the cover in ~200ms
        if (comic.googleFileId) {
          try {
            const rangeCover = await this.extractCoverViaRange(user, comic.googleFileId);
            if (rangeCover && rangeCover.data) {
              CacheManager.saveCoverBuffer(fileId, rangeCover.data);
              return rangeCover;
            }
          } catch (rangeErr) {
            console.warn(`[GoogleDrive] Range cover extraction failed for ${comic.title || fileId}:`, rangeErr.message);
          }
        }

        // 4. Fallback: Full comic download if range extraction wasn't possible
        if (comic.googleFileId) {
          const cachedPath = await this.ensureComicCached(user, comic.googleFileId);
          const page1 = CBZReader.extractPage(cachedPath, 1);
          CacheManager.saveCoverBuffer(fileId, page1.data);
          return { data: page1.data, mimeType: page1.mimeType };
        }

        throw new Error('Cover not found');
      } finally {
        activeCoverRequests.delete(fileId);
      }
    })();

    activeCoverRequests.set(fileId, coverPromise);
    return coverPromise;
  },

  /**
   * Uploads a small image buffer (a cover JPG) into Google Drive using a
   * multipart upload, named after the comic with a .jpg extension.
   */
  async uploadCoverJpeg(user, imageBuffer, comicFileName, parentId) {
    if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) return null;
    const accessToken = await GoogleAuth.getValidAccessToken(user);
    const baseName = String(comicFileName).replace(/\.[a-zA-Z0-9]+$/i, '');
    const name = `${baseName}.jpg`;

    const metadata = {
      name,
      mimeType: 'image/jpeg'
    };
    if (parentId) {
      metadata.parents = Array.isArray(parentId) ? parentId.filter(Boolean) : [parentId];
    }

    // Check if an existing cover file with this name already exists in target folder
    if (parentId && typeof parentId === 'string') {
      try {
        const escapedName = name.replace(/'/g, "\\'");
        const query = `'${parentId}' in parents and name = '${escapedName}' and trashed = false`;
        const searchUrl = new URL('https://www.googleapis.com/drive/v3/files');
        searchUrl.searchParams.set('q', query);
        searchUrl.searchParams.set('fields', 'files(id, name, thumbnailLink)');
        searchUrl.searchParams.set('supportsAllDrives', 'true');
        const searchRes = await fetch(searchUrl.toString(), {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        if (searchRes.ok) {
          const searchData = await searchRes.json();
          if (searchData.files && searchData.files.length > 0) {
            const existingId = searchData.files[0].id;
            const patchRes = await fetch(
              `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=media&supportsAllDrives=true`,
              {
                method: 'PATCH',
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  'Content-Type': 'image/jpeg',
                  'Content-Length': imageBuffer.length.toString()
                },
                body: imageBuffer,
                signal: AbortSignal.timeout(60000)
              }
            );
            const patchData = await patchRes.json().catch(() => ({}));
            if (patchRes.ok && !patchData.error) {
              return patchData;
            }
          }
        }
      } catch (checkErr) {
        // Fall back to multipart creation
      }
    }

    const boundary = `comix${Date.now()}${Math.random().toString(36).slice(2)}`;
    const preamble = Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
        `${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: image/jpeg\r\n\r\n`,
      'utf8'
    );
    const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const body = Buffer.concat([preamble, imageBuffer, epilogue]);

    const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,thumbnailLink&supportsAllDrives=true', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
        'Content-Length': body.length.toString()
      },
      body,
      signal: AbortSignal.timeout(60000)
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      throw new Error(data.error?.message || `Cover JPG upload failed (${res.status})`);
    }
    return data;
  },

  /**
   * Uploads a comic archive buffer to Google Drive.
   * If organizeBySeries is enabled, puts it into a series subfolder.
   */
  async uploadComicFile(
    user,
    fileBuffer,
    fileName,
    seriesName = '',
    coverUrl = '',
    targetFolderIdOverride = null,
    metadataOverride = null,
    onProgress = null,
    providedCoverJpeg = null
  ) {
    if (!user.driveFolderId && !targetFolderIdOverride) {
      throw new Error('Please select a Google Drive comic folder first in Settings.');
    }

    const parsed = parseTitleAndSeries(fileName, seriesName);
    const finalSeries = (metadataOverride && metadataOverride.series) || parsed.series;
    const finalTitle = (metadataOverride && (metadataOverride.title || metadataOverride.name)) || parsed.title;
    const finalItem = (metadataOverride && metadataOverride.item) || parsed.item;
    const finalIsVolume = (metadataOverride && metadataOverride.isVolume !== undefined) ? metadataOverride.isVolume : parsed.isVolume;

    let finalFileName = (metadataOverride && (metadataOverride.fileName || metadataOverride.name));
    if (!finalFileName) {
      if (fileName && fileName.toLowerCase().endsWith('.cbz') && !parsed.cleanFilename.toLowerCase().includes('issue 01')) {
        finalFileName = fileName;
      } else {
        finalFileName = parsed.cleanFilename || fileName;
      }
    }
    if (!finalFileName.toLowerCase().endsWith('.cbz')) {
      finalFileName += '.cbz';
    }

    const accessToken = await GoogleAuth.getValidAccessToken(user);
    const userSettings = Database.getUserSettings(user.id);

    let targetFolderId = targetFolderIdOverride || user.driveFolderId;
    if (!targetFolderIdOverride) {
      const shouldOrganize = userSettings.organizeBySeries !== false;
      if (shouldOrganize && finalSeries && !GENERIC_FOLDERS.has(finalSeries.toLowerCase())) {
        const seriesFolder = await this.getOrCreateSubfolder(user, finalSeries, user.driveFolderId);
        targetFolderId = seriesFolder.id;
      }
    }

    const metadata = {
      name: finalFileName,
      mimeType: 'application/vnd.comicbook+zip',
      parents: [targetFolderId]
    };

    let uploadData = null;
    // Accept either an in-memory Buffer or a path on disk. The path form keeps
    // peak memory flat for large comics on shared hosting.
    const sourceIsPath = typeof fileBuffer === 'string';
    const totalBytes = sourceIsPath ? fs.statSync(fileBuffer).size : fileBuffer.length;

    // Resumable Upload Protocol (required by Google Drive for media files > 5MB)
    // 1. Initiate Resumable Upload Session
    const initRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': 'application/vnd.comicbook+zip',
        'X-Upload-Content-Length': totalBytes.toString()
      },
      body: JSON.stringify(metadata),
      signal: AbortSignal.timeout(30000)
    });

    if (!initRes.ok) {
      const errJson = await initRes.json().catch(() => ({}));
      throw new Error(errJson.error?.message || `Failed to initiate Google Drive upload session (${initRes.status})`);
    }

    const sessionUri = initRes.headers.get('location');
    if (!sessionUri) {
      throw new Error('Google Drive upload session URL was not provided');
    }

    // 2. Upload file in 4MB chunks (must be multiple of 256KB)
    const CHUNK_SIZE = 4 * 1024 * 1024;
    let offset = 0;

    while (offset < totalBytes) {
      const chunkEnd = Math.min(offset + CHUNK_SIZE, totalBytes);
      let chunkBuffer;
      if (sourceIsPath) {
        const len = chunkEnd - offset;
        chunkBuffer = Buffer.allocUnsafe(len);
        const fd = fs.openSync(fileBuffer, 'r');
        try {
          fs.readSync(fd, chunkBuffer, 0, len, offset);
        } finally {
          fs.closeSync(fd);
        }
      } else {
        chunkBuffer = fileBuffer.subarray(offset, chunkEnd);
      }
      const isLastChunk = chunkEnd >= totalBytes;

      const chunkRes = await fetch(sessionUri, {
        method: 'PUT',
        headers: {
          'Content-Length': chunkBuffer.length.toString(),
          'Content-Range': `bytes ${offset}-${chunkEnd - 1}/${totalBytes}`
        },
        body: chunkBuffer,
        signal: AbortSignal.timeout(90000)
      });

      offset = chunkEnd;

      if (onProgress) {
        try {
          onProgress({ uploaded: offset, total: totalBytes });
        } catch (e) {}
      }

      if (isLastChunk) {
        uploadData = await chunkRes.json().catch(() => ({}));
        if (!chunkRes.ok || uploadData.error) {
          throw new Error(uploadData.error?.message || `Google Drive upload completion failed (${chunkRes.status})`);
        }
      } else {
        // Intermediary chunks return 308 Resume Incomplete
        if (chunkRes.status !== 308 && !chunkRes.ok) {
          const errData = await chunkRes.json().catch(() => ({}));
          throw new Error(errData.error?.message || `Google Drive chunk upload failed (${chunkRes.status})`);
        }
      }
    }

    // Cache the uploaded comic locally immediately for fast reading
    CacheManager.saveComicBuffer(uploadData.id, fileBuffer);

    // Obtain the 512px cover thumbnail
    let coverJpeg = providedCoverJpeg;
    let page1Data = null;
    let totalPages = 0;

    try {
      const cachedPath = CacheManager.getComicCachePath(uploadData.id);
      const pageList = CBZReader.getPageList(cachedPath);
      totalPages = pageList.totalPages || 0;
      if (!coverJpeg) {
        const page1 = CBZReader.extractPage(cachedPath, 1);
        if (page1 && page1.data) {
          page1Data = page1.data;
          coverJpeg = await ComicCompressor.makeCoverJpeg(page1.data, { maxHeight: 512, quality: 85 });
        }
      }
    } catch (e) {
      console.warn('[Upload] Page inspection note:', e.message);
    }

    if (!coverJpeg) {
      try {
        const extracted = await ComicCompressor.extractCoverThumbnail(fileBuffer, { maxHeight: 512, quality: 85 });
        if (extracted && extracted.coverJpeg) {
          coverJpeg = extracted.coverJpeg;
          page1Data = extracted.rawImage;
        }
      } catch (covErr) {
        console.warn('[Upload] Cover thumbnail extraction note:', covErr.message);
      }
    }

    // Cache cover thumbnail locally under both file ID and comic ID
    if (coverJpeg) {
      CacheManager.saveCoverBuffer(uploadData.id, coverJpeg);
    } else if (page1Data) {
      CacheManager.saveCoverBuffer(uploadData.id, page1Data);
    }

    // Also save cover JPG beside the .cbz into the exact same folder with the same file name: first page, max 512px tall @ 85%.
    let uploadedCover = null;
    if (coverJpeg) {
      try {
        uploadedCover = await this.uploadCoverJpeg(user, coverJpeg, finalFileName, targetFolderId);
        console.log(`[Upload] Uploaded cover JPG for ${finalFileName} (${coverJpeg.length} bytes) to folder ${targetFolderId}`);
      } catch (coverErr) {
        console.warn('[Upload] Could not upload cover JPG:', coverErr.message);
      }
    }

    // Save comic to database
    const savedComic = Database.saveComic(user.id, {
      googleFileId: uploadData.id,
      title: finalTitle,
      series: finalSeries,
      item: finalItem,
      isVolume: finalIsVolume,
      size: totalBytes,
      totalPages,
      coverImage: (uploadedCover && uploadedCover.thumbnailLink)
        ? uploadedCover.thumbnailLink.replace(/=s\d+$/, '=s400')
        : (coverUrl || null),
      mimeType: 'application/vnd.comicbook+zip'
    });

    if (coverJpeg && savedComic.id) {
      CacheManager.saveCoverBuffer(savedComic.id, coverJpeg);
    }

    return savedComic;
  },

  /**
   * Updates comic metadata (title, series, item, isVolume) and renames file in Google Drive/local disk.
   */
  async updateComicMetadata(user, comicId, updates = {}) {
    if (!user) throw new Error('User authentication required.');
    const comic = Database.getComicById(user.id, comicId) || Database.getComic(comicId);
    if (!comic) throw new Error('Comic not found.');

    const newTitle = updates.title ? String(updates.title).trim() : comic.title;
    const newSeries = updates.series !== undefined ? String(updates.series).trim() : comic.series;
    const newItem = updates.item !== undefined ? String(updates.item).trim() : comic.item;
    const newIsVolume = updates.isVolume !== undefined ? Boolean(updates.isVolume) : comic.isVolume;

    let finalFileName = newTitle;
    if (!finalFileName.toLowerCase().endsWith('.cbz') && !finalFileName.toLowerCase().endsWith('.cbr') && !finalFileName.toLowerCase().endsWith('.zip')) {
      finalFileName += '.cbz';
    }

    // 1. If stored in Google Drive, rename the file in Drive
    if (comic.googleFileId) {
      try {
        const accessToken = await GoogleAuth.getValidAccessToken(user);
        const patchRes = await fetch(`https://www.googleapis.com/drive/v3/files/${comic.googleFileId}?supportsAllDrives=true`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ name: finalFileName })
        });

        if (!patchRes.ok) {
          const errData = await patchRes.json().catch(() => ({}));
          console.warn('[GoogleDrive] Rename Drive file warning:', errData.error?.message || patchRes.status);
        }

        // If series changed and organizeBySeries is enabled, move to new series folder
        if (newSeries && newSeries !== comic.series && user.driveFolderId) {
          const userSettings = Database.getUserSettings(user.id);
          if (userSettings.organizeBySeries !== false && !GENERIC_FOLDERS.has(newSeries.toLowerCase())) {
            const seriesFolder = await this.getOrCreateSubfolder(user, newSeries, user.driveFolderId);
            if (seriesFolder && seriesFolder.id) {
              const fileInfoRes = await fetch(`https://www.googleapis.com/drive/v3/files/${comic.googleFileId}?fields=parents&supportsAllDrives=true`, {
                headers: { Authorization: `Bearer ${accessToken}` }
              });
              const fileInfo = await fileInfoRes.json().catch(() => ({}));
              const oldParents = (fileInfo.parents || []).join(',');
              if (oldParents) {
                await fetch(`https://www.googleapis.com/drive/v3/files/${comic.googleFileId}?addParents=${seriesFolder.id}&removeParents=${oldParents}&supportsAllDrives=true`, {
                  method: 'PATCH',
                  headers: { Authorization: `Bearer ${accessToken}` }
                });
              }
            }
          }
        }
      } catch (driveErr) {
        console.warn('[GoogleDrive] Error updating Google Drive file:', driveErr.message);
      }
    }

    // 2. If stored locally on disk, rename local file if path exists
    let updatedFilePath = comic.filepath;
    if (comic.filepath && fs.existsSync(comic.filepath)) {
      try {
        const dir = path.dirname(comic.filepath);
        const ext = path.extname(comic.filepath) || '.cbz';
        const targetPath = path.join(dir, `${newTitle}${ext}`);
        if (targetPath !== comic.filepath && !fs.existsSync(targetPath)) {
          fs.renameSync(comic.filepath, targetPath);
          updatedFilePath = targetPath;
        }
      } catch (fsErr) {
        console.warn('[GoogleDrive] Error renaming local file:', fsErr.message);
      }
    }

    // 3. Update database record
    const updated = Database.updateComicMetadata(user.id, comicId, {
      title: newTitle,
      series: newSeries,
      item: newItem,
      isVolume: newIsVolume,
      filepath: updatedFilePath
    });

    return updated;
  },

  /**
   * Deletes a comic from storage (Google Drive or local disk), caches, and database.
   */
  async deleteComic(user, comicId) {
    return this.deleteComics(user, [comicId]);
  },

  /**
   * Deletes multiple comics in batch from storage (Google Drive or local disk), caches, and database.
   */
  async deleteComics(user, comicIds) {
    if (!user) throw new Error('User authentication required.');
    if (!Array.isArray(comicIds) || comicIds.length === 0) {
      return { success: true, deletedCount: 0 };
    }

    let deletedCount = 0;
    const accessToken = await GoogleAuth.getValidAccessToken(user).catch(() => null);

    for (const comicId of comicIds) {
      try {
        const comic = Database.getComicById(user.id, comicId) || Database.getComic(comicId);
        if (!comic) continue;

        // 1. Delete from Google Drive if cloud stored
        if (comic.googleFileId && accessToken) {
          try {
            const delRes = await fetch(`https://www.googleapis.com/drive/v3/files/${comic.googleFileId}`, {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${accessToken}` }
            });
            if (!delRes.ok && delRes.status !== 404) {
              console.warn(`[Delete] Google Drive file delete returned ${delRes.status}`);
            }
          } catch (e) {
            console.warn(`[Delete] Could not delete Drive file ${comic.googleFileId}:`, e.message);
          }
          CacheManager.deleteComicCache(comic.googleFileId);
        }

        // 2. Delete local file if local storage
        if (comic.filepath && fs.existsSync(comic.filepath)) {
          try {
            fs.unlinkSync(comic.filepath);
            const coverCandidate = comic.filepath.replace(/\.cbz$/i, '.jpg');
            if (fs.existsSync(coverCandidate)) fs.unlinkSync(coverCandidate);
          } catch (e) {
            console.warn(`[Delete] Could not delete local file ${comic.filepath}:`, e.message);
          }
        }

        // 3. Remove from Database
        Database.deleteComic(user.id, comic.id);
        deletedCount++;
      } catch (err) {
        console.error(`[Delete] Error deleting comic ${comicId}:`, err);
      }
    }

    return {
      success: true,
      deletedCount
    };
  }
};

module.exports = GoogleDrive;
