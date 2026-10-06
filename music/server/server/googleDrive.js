import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseBuffer } from 'music-metadata';
import googleAuth from './googleAuth.js';
import db from './db.js';
import { COVERS_DIR, config } from './config.js';
import {
  buildAudiobookRecord,
  buildTrackRecord,
  extensionOf,
  isAudioFile,
  isImageFile,
  sanitizeSegment,
  stripExtension,
  stripTrackNumberPrefix
} from './libraryParser.js';

/**
 * Google Drive API v3 client.
 *
 * Plain `fetch` against the REST API - no SDK. Everything is scoped to the two
 * folders the user picks in Settings (audiobooks + music).
 */

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const COVER_SCAN_BYTES = 1024 * 1024;

// Dedupe concurrent work for the same file.
const activeBufferReads = new Map();
const activeCoverBuilds = new Map();

/**
 * Branded placeholder art used when Drive holds no usable cover for an item.
 * Written to disk as .svg so the cover route can serve it like any other file.
 */
export function renderPlaceholderSvg(title = 'FRAUDIO') {
  const safe = String(title || 'FRAUDIO').replace(/[<>&"']/g, '').slice(0, 26);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300">
  <defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
    <stop offset="0%" stop-color="#1B2033"/><stop offset="100%" stop-color="#0E1119"/>
  </linearGradient></defs>
  <rect width="300" height="300" fill="url(#g)"/>
  <circle cx="150" cy="150" r="46" fill="none" stroke="#3DDC97" stroke-width="7"/>
  <circle cx="150" cy="150" r="10" fill="#3DDC97"/>
  <text x="150" y="252" font-family="system-ui,sans-serif" font-size="19" font-weight="600"
        fill="#E7EAF0" text-anchor="middle">${safe}</text>
</svg>`;
}

function escapeQuery(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function driveFetch(user, url, options = {}) {
  const accessToken = await googleAuth.getValidAccessToken(user);
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.headers || {})
    }
  });
  if (res.status === 401) {
    throw new Error('Google Drive rejected the access token. Please sign in again.');
  }
  return res;
}

async function driveJson(user, url, options = {}) {
  const res = await driveFetch(user, url, options);
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  if (!res.ok) {
    throw new Error(data?.error?.message || `Google Drive request failed (HTTP ${res.status})`);
  }
  return data;
}

/** Persistent upload that streams from disk and reports byte progress. */
async function resumableUpload(user, localPath, { name, mimeType, parents, onProgress, signal }) {
  const accessToken = await googleAuth.getValidAccessToken(user);
  const stat = fs.statSync(localPath);

  const initRes = await fetch(`${DRIVE_UPLOAD_API}/files?uploadType=resumable`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Length': String(stat.size),
      'X-Upload-Content-Type': mimeType || 'application/octet-stream'
    },
    body: JSON.stringify({ name, mimeType: mimeType || 'application/octet-stream', parents: parents || [] })
  });

  if (!initRes.ok) {
    const errText = await initRes.text();
    throw new Error(`Could not start Drive upload: HTTP ${initRes.status} ${errText.slice(0, 200)}`);
  }

  const sessionUrl = initRes.headers.get('location');
  if (!sessionUrl) throw new Error('Google Drive did not return an upload session URL.');

  let uploaded = 0;
  const source = fs.createReadStream(localPath, { highWaterMark: 1024 * 512 });
  source.on('data', (chunk) => {
    uploaded += chunk.length;
    onProgress?.({ uploaded, total: stat.size });
  });

  const uploadRes = await fetch(sessionUrl, {
    method: 'PUT',
    headers: { 'Content-Length': String(stat.size) },
    body: Readable.toWeb(source),
    signal,
    duplex: 'half'
  });

  const text = await uploadRes.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* ignore */ }
  if (!uploadRes.ok) {
    throw new Error(data?.error?.message || `Drive upload failed (HTTP ${uploadRes.status})`);
  }
  onProgress?.({ uploaded: stat.size, total: stat.size });
  return data;
}

export const googleDrive = {
  FOLDER_MIME,

  // ------------------------------------------------------------------
  // Folder browsing
  // ------------------------------------------------------------------
  async listFolders(user, parentId = 'root') {
    const url = new URL(`${DRIVE_API}/files`);
    url.searchParams.set('q', `'${parentId}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`);
    url.searchParams.set('fields', 'files(id,name,mimeType,modifiedTime)');
    url.searchParams.set('orderBy', 'name');
    url.searchParams.set('pageSize', '200');
    const data = await driveJson(user, url.toString());
    return data.files || [];
  },

  async createFolder(user, name, parentId = 'root') {
    return driveJson(user, `${DRIVE_API}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId || 'root'] })
    });
  },

  async getFolderInfo(user, folderId) {
    return driveJson(user, `${DRIVE_API}/files/${folderId}?fields=id,name,mimeType,parents`);
  },

  async getFileMetadata(user, fileId, fields = 'id,name,mimeType,size,modifiedTime,thumbnailLink,parents,properties') {
    return driveJson(user, `${DRIVE_API}/files/${fileId}?fields=${encodeURIComponent(fields)}`);
  },

  /** Returns the existing child folder with this name, creating it if absent. */
  async getOrCreateSubfolder(user, name, parentId) {
    const safeName = sanitizeSegment(name, 'Unsorted');
    const url = new URL(`${DRIVE_API}/files`);
    url.searchParams.set('q', `'${parentId}' in parents and name = '${escapeQuery(safeName)}' and mimeType = '${FOLDER_MIME}' and trashed = false`);
    url.searchParams.set('fields', 'files(id,name)');
    url.searchParams.set('pageSize', '1');
    const data = await driveJson(user, url.toString());
    if (data.files?.length) return data.files[0];
    return this.createFolder(user, safeName, parentId);
  },

  /** Walks `Author / Series / Book` style paths, creating anything missing. */
  async ensureFolderPath(user, parentId, segments) {
    let current = parentId;
    for (const segment of segments.filter(Boolean)) {
      const folder = await this.getOrCreateSubfolder(user, segment, current);
      current = folder.id;
    }
    return current;
  },

  // ------------------------------------------------------------------
  // Recursive listing
  // ------------------------------------------------------------------
  /**
   * Walks a Drive folder tree, collecting audio files with their folder trail.
   * `imageMap` links a cover image to the audio file that shares its base name.
   */
  async listLibraryFiles(user, rootFolderId, { maxDepth = 6, onProgress } = {}) {
    const audioFiles = [];
    const visited = new Set();

    const walk = async (folderId, segments, depth) => {
      if (depth > maxDepth || visited.has(folderId)) return;
      visited.add(folderId);

      let pageToken = null;
      let entries = [];
      do {
        const url = new URL(`${DRIVE_API}/files`);
        url.searchParams.set('q', `'${folderId}' in parents and trashed = false`);
        url.searchParams.set('fields', 'nextPageToken,files(id,name,mimeType,size,modifiedTime,thumbnailLink)');
        url.searchParams.set('pageSize', '1000');
        if (pageToken) url.searchParams.set('pageToken', pageToken);

        const data = await driveJson(user, url.toString());
        entries.push(...(data.files || []));
        pageToken = data.nextPageToken || null;
      } while (pageToken);

      // Index same-folder cover images by base name so "Book Title.jpg" pairs
      // with "Book Title.m4b".
      const localImages = new Map();
      for (const entry of entries) {
        if (isImageFile(entry.name)) localImages.set(stripExtension(entry.name).toLowerCase(), entry);
      }

      const childFolders = [];
      for (const entry of entries) {
        if (entry.mimeType === FOLDER_MIME) {
          childFolders.push(entry);
        } else if (isAudioFile(entry.name)) {
          const image = localImages.get(stripExtension(entry.name).toLowerCase());
          audioFiles.push({
            ...entry,
            coverImage: image?.thumbnailLink || entry.thumbnailLink || null,
            folderSegments: [...segments]
          });
        }
      }

      for (const folder of childFolders) {
        onProgress?.({ depth, folder: folder.name });
        await walk(folder.id, [...segments, folder.name], depth + 1);
      }
    };

    await walk(rootFolderId, [], 0);
    return audioFiles;
  },

  // ------------------------------------------------------------------
  // Tags
  // ------------------------------------------------------------------
  /** Reads embedded tags from the head of a Drive file (never downloads it all). */
  async readTags(user, googleFileId) {
    if (activeBufferReads.has(googleFileId)) return activeBufferReads.get(googleFileId);

    const task = (async () => {
      try {
        const res = await driveFetch(user, `${DRIVE_API}/files/${googleFileId}?alt=media`, {
          headers: { Range: `bytes=0-${COVER_SCAN_BYTES - 1}` }
        });
        if (!res.ok && res.status !== 206) return null;
        const arrayBuffer = await res.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        if (buffer.length < 32) return null;
        try {
          const parsed = await parseBuffer(buffer, googleFileId, { duration: false });
          if (!parsed) return null;
          const common = parsed.common || {};
          const format = parsed.format || {};
          return {
            ...common,
            artist: common.artist || common.albumartist,
            title: common.title,
            album: common.album,
            albumartist: common.albumartist,
            genre: common.genre,
            track: common.track,
            disk: common.disk,
            duration: format.duration,
            bitrate: format.bitrate,
            format: format.container || format.codec,
            common,
            rawFormat: format,
            rawParsed: parsed
          };
        } catch {
          return null;
        }
      } catch {
        return null;
      }
    })();

    activeBufferReads.set(googleFileId, task);
    task.finally(() => activeBufferReads.delete(googleFileId));
    return task;
  },

  // ------------------------------------------------------------------
  // Library sync
  // ------------------------------------------------------------------
  /**
   * Rebuilds the database view of one Drive folder.
   * @param {'audiobooks'|'music'} kind
   */
  async syncLibrary(user, kind = 'audiobooks', { protectFileIds = [], onProgress } = {}) {
    const folderId = kind === 'music' ? user.musicFolderId : user.audiobooksFolderId;
    if (!folderId) {
      throw new Error(
        kind === 'music'
          ? 'No music folder selected yet. Pick one in Settings first.'
          : 'No audiobooks folder selected yet. Pick one in Settings first.'
      );
    }

    onProgress?.({ stage: 'listing', message: 'Scanning Google Drive…', processed: 0, total: 0 });

    const files = await this.listLibraryFiles(user, folderId, {
      onProgress: (p) => onProgress?.({ stage: 'listing', message: p.folder ? `Scanning ${p.folder}…` : 'Scanning Google Drive…', ...p })
    });

    // Lookup existing items for this kind to avoid re-reading tags on unchanged files
    const targetKind = kind === 'music' ? 'track' : 'audiobook';
    const existingItems = db.getUserItems(user.id, targetKind);
    const existingByFileId = new Map();
    for (const item of existingItems) {
      if (item.googleFileId) existingByFileId.set(item.googleFileId, item);
    }

    const incoming = [];
    const filesToRead = [];

    for (const file of files) {
      const existing = existingByFileId.get(file.id);
      const fileSizeBytes = Number(file.size) || 0;
      const isUnchanged = Boolean(
        existing &&
        existing.title &&
        existing.modifiedTime === file.modifiedTime &&
        (!fileSizeBytes || !existing.sizeBytes || existing.sizeBytes === fileSizeBytes)
      );

      if (isUnchanged) {
        let title = existing.title;
        if (kind === 'music' && title) title = stripTrackNumberPrefix(title);
        const record = {
          ...existing,
          title,
          driveFolderId: folderId,
          drivePath: [...file.folderSegments, file.name].join('/'),
          coverImage: file.coverImage || file.thumbnailLink || existing.coverImage,
          sizeBytes: fileSizeBytes || existing.sizeBytes || 0,
          modifiedTime: file.modifiedTime || existing.modifiedTime
        };
        incoming.push(record);
      } else {
        filesToRead.push({ file, existing });
      }
    }

    let processedCount = incoming.length;
    const totalFiles = files.length;

    onProgress?.({
      stage: 'tags',
      processed: processedCount,
      current: processedCount,
      total: totalFiles,
      name: filesToRead.length > 0 ? `Reading metadata (${filesToRead.length} new/changed)…` : 'Up to date'
    });

    // Read tags only for new or modified files, with controlled concurrency (5 at a time)
    const CONCURRENCY = 5;
    for (let i = 0; i < filesToRead.length; i += CONCURRENCY) {
      const chunk = filesToRead.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async ({ file, existing }) => {
          let tags = null;
          try {
            tags = await this.readTags(user, file.id);
          } catch (err) {
            console.warn(`[Drive] Could not read tags for ${file.name}:`, err.message);
          }

          const base = {
            googleFileId: file.id,
            driveFolderId: folderId,
            sizeBytes: Number(file.size) || 0,
            modifiedTime: file.modifiedTime,
            coverImage: file.coverImage || file.thumbnailLink || null,
            fileName: file.name
          };

          const record = kind === 'music'
            ? buildTrackRecord({ ...base, pathSegments: file.folderSegments, fileName: file.name, tags })
            : buildAudiobookRecord({ ...base, pathSegments: file.folderSegments, fileName: file.name, tags });

          if (existing) {
            record.id = existing.id;
            record.narrator = existing.narrator || record.narrator;
            record.abridged = existing.abridged;
            if (!record.series) record.series = existing.series;
          }

          incoming.push(record);
          processedCount += 1;
          onProgress?.({
            stage: 'tags',
            processed: processedCount,
            current: processedCount,
            total: totalFiles,
            name: file.name
          });
        })
      );
    }

    const items = db.syncItems(user.id, incoming, protectFileIds, { kind });
    onProgress?.({ stage: 'done', done: true, processed: totalFiles, total: totalFiles });
    return {
      count: incoming.length,
      items,
      folderId,
      kind
    };
  },

  // ------------------------------------------------------------------
  // Streaming / reading
  // ------------------------------------------------------------------
  /**
   * Streams a Drive file to the client, honouring HTTP Range so the browser can
   * seek. Returns true when it handled the response.
   */
  async streamFile(user, googleFileId, req, res) {
    const headers = {};
    const range = req.headers.range;
    if (range) headers.Range = range;

    const meta = await this.getFileMetadata(user, googleFileId, 'id,name,mimeType,size');
    const mimeType = meta.mimeType || 'application/octet-stream';
    const total = Number(meta.size) || 0;

    const upstream = await driveFetch(user, `${DRIVE_API}/files/${googleFileId}?alt=media`, { headers });
    if (!upstream.ok && upstream.status !== 206) {
      throw new Error(`Drive stream failed (HTTP ${upstream.status})`);
    }

    const partial = upstream.status === 206;
    res.status(partial ? 206 : 200);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');

    const contentRange = upstream.headers.get('content-range');
    if (partial && contentRange) res.setHeader('Content-Range', contentRange);
    else if (total) res.setHeader('Content-Length', String(total));

    const length = upstream.headers.get('content-length');
    if (length && !contentRange) res.setHeader('Content-Length', length);

    if (req.method === 'HEAD') {
      res.end();
      return true;
    }

    await pipeline(Readable.fromWeb(upstream.body), res);
    return true;
  },

  /** Downloads a byte range (or the whole file) into a Buffer. */
  async getFileBuffer(user, googleFileId, { range = null } = {}) {
    const headers = range ? { Range: range } : {};
    const res = await driveFetch(user, `${DRIVE_API}/files/${googleFileId}?alt=media`, { headers });
    if (!res.ok && res.status !== 206) {
      throw new Error(`Drive download failed (HTTP ${res.status})`);
    }
    return Buffer.from(await res.arrayBuffer());
  },

  // ------------------------------------------------------------------
  // Covers
  // ------------------------------------------------------------------
  async buildCover(user, googleFileId, { width = 600, hintCoverUrl = null } = {}) {
    // Drive returns sibling/image covers in the order Author / Series / Book, so a
    // "Book Title.jpg" typically sits next to "Book Title.m4b" rather than beside the
    // first file of the book. Search outward from the item's own folder.
    const cover = await this.resolveCover(user, googleFileId, width, hintCoverUrl);
    if (cover) return cover;

    // Nothing in Drive at all: synthesise the same branded placeholder the API
    // route would have produced, so callers always get a real file on disk.
    const key = crypto.createHash('sha1').update(`placeholder-${googleFileId}`).digest('hex');
    const outPath = path.join(COVERS_DIR, `${key}.svg`);
    if (!fs.existsSync(outPath)) {
      fs.mkdirSync(COVERS_DIR, { recursive: true });
      fs.writeFileSync(outPath, renderPlaceholderSvg('FRAUDIO'));
    }
    return { file: outPath, cached: true, placeholder: true };
  },

  /**
   * Extracts the first embedded ID3 picture from an audio file using two small
   * ranged reads (the 10-byte header, then exactly the declared tag). Most MP3s
   - including every YouTube Music download, which yt-dlp tags with
   * --embed-thumbnail - carry their album art here, so the library shows real
   * covers without downloading the whole track.
   */
  async extractEmbeddedPicture(user, googleFileId, key) {
    try {
      const head = await this.getFileBuffer(user, googleFileId, { range: 'bytes=0-9' });
      if (head.length < 10 || head.subarray(0, 3).toString('latin1') !== 'ID3') return null;
      const size = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
      if (size <= 0 || size > 16 * 1024 * 1024) return null;

      const tag = await this.getFileBuffer(user, googleFileId, { range: `bytes=0-${9 + size}` });
      const parsed = await parseBuffer(tag, { mimeType: 'audio/mpeg' }, { duration: false, skipCovers: false });
      const pic = parsed.common.picture?.[0];
      if (!pic?.data?.length) return null;

      const format = String(pic.format || '').toLowerCase();
      const ext = format.includes('png') ? 'png' : format.includes('gif') ? 'gif' : format.includes('webp') ? 'webp' : 'jpg';
      const outPath = path.join(COVERS_DIR, `${key}.${ext}`);
      fs.mkdirSync(COVERS_DIR, { recursive: true });
      fs.writeFileSync(outPath, pic.data);
      return { file: outPath, cached: false };
    } catch (err) {
      console.warn(`[Cover] Embedded art extraction failed for ${googleFileId}: ${err.message}`);
      return null;
    }
  },

  /**
   * Resolves a cover image for one Drive file and caches it on disk.
   * Returns null when Drive has no usable art, so the caller can fall back.
   */
  async resolveCover(user, googleFileId, width, hintCoverUrl = null) {
    const buildKey = `${googleFileId}-${width}`;
    if (activeCoverBuilds.has(buildKey)) return activeCoverBuilds.get(buildKey);

    const task = (async () => {
      const key = crypto.createHash('sha1').update(buildKey).digest('hex');
      const cached = ['jpg', 'png', 'gif', 'webp']
        .map((ext) => path.join(COVERS_DIR, `${key}.${ext}`))
        .find((file) => fs.existsSync(file) && fs.statSync(file).size > 0);
      if (cached) return { file: cached, cached: true };
      const outPath = path.join(COVERS_DIR, `${key}.jpg`);

      // 0. Hint cover URL (e.g. from YouTube Music, thumbnailLink, or known art)
      if (hintCoverUrl && (hintCoverUrl.startsWith('http://') || hintCoverUrl.startsWith('https://'))) {
        try {
          const hinted = await this.cacheRemoteCover(hintCoverUrl, key, outPath, user);
          if (hinted) return hinted;
        } catch {
          // fallback to Drive methods
        }
      }

      // `parents` is required: findSiblingCover walks the item's folder.
      const meta = await this.getFileMetadata(
        user, googleFileId, 'id,name,mimeType,parents,thumbnailLink,hasThumbnail'
      );

      // 1. A cover image stored beside the audio file, by exact name match.
      const sibling = await this.findSiblingCover(user, meta);
      if (sibling) {
        return this.cacheRemoteCover(sibling, key, outPath, user);
      }

      // 2. Art embedded in the audio file itself (ID3 APIC on MP3).
      if (isAudioFile(meta.name) && (meta.mimeType || '').startsWith('audio')) {
        const embedded = await this.extractEmbeddedPicture(user, googleFileId, key);
        if (embedded) return embedded;
      }

      // 3. Drive's own generated thumbnail for this file.
      if (meta.thumbnailLink) {
        return this.cacheRemoteCover(meta.thumbnailLink, key, outPath, user);
      }

      // 4. Walk up the folder tree looking for any cover image.
      const inherited = await this.findInheritedCover(user, meta);
      if (inherited) {
        return this.cacheRemoteCover(inherited, key, outPath, user);
      }

      return null;
    })();

    activeCoverBuilds.set(buildKey, task);
    // Drop the memoised promise once settled, and swallow the rejection on the
    // bookkeeping chain so a failed build never surfaces as an unhandled rejection.
    task.then(
      () => activeCoverBuilds.delete(buildKey),
      () => activeCoverBuilds.delete(buildKey)
    );
    return task;
  },

  /**
   * Looks for cover art in the item's ancestors (Book -> Series -> Author).
   * Multi-file books usually keep one cover at the series level.
   */
  async findInheritedCover(user, meta, maxDepth = 3) {
    let parentId = meta.parents?.[0];
    let depth = 0;
    const visited = new Set();

    while (parentId && parentId !== 'root' && depth < maxDepth && !visited.has(parentId)) {
      visited.add(parentId);
      const url = new URL(`${DRIVE_API}/files`);
      url.searchParams.set('q', `'${parentId}' in parents and trashed = false`);
      url.searchParams.set('fields', 'files(id,name,mimeType,thumbnailLink)');
      url.searchParams.set('pageSize', '200');
      const data = await driveJson(user, url.toString()).catch(() => null);
      if (!data) return null;

      const image = (data.files || []).find((f) => isImageFile(f.name) && f.thumbnailLink);
      if (image) return image.thumbnailLink;

      const info = await driveJson(user, `${DRIVE_API}/files/${parentId}?fields=id,parents`)
        .catch(() => null);
      parentId = info?.parents?.[0];
      depth += 1;
    }
    return null;
  },

  async cacheRemoteCover(url, key, outPath, user = null) {
    const headers = { 'User-Agent': config.userAgent };
    if (user) {
      // Drive thumbnailLinks point at private files, so they need the caller's token.
      try { headers.Authorization = `Bearer ${await googleAuth.getValidAccessToken(user)}`; } catch { /* ignore */ }
    }
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Could not fetch cover image (HTTP ${res.status})`);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length < 100) throw new Error('Cover image was empty.');
    fs.mkdirSync(COVERS_DIR, { recursive: true });
    fs.writeFileSync(outPath, buffer);
    return { file: outPath, cached: false };
  },

  /** Looks for "Book Title.jpg" sitting next to "Book Title.m4b" in Drive. */
  async findSiblingCover(user, meta) {
    const parentId = meta.parents?.[0];
    if (!parentId || !meta.name) return null;

    const base = stripExtension(meta.name).toLowerCase();
    const url = new URL(`${DRIVE_API}/files`);
    url.searchParams.set('q', `'${parentId}' in parents and trashed = false`);
    url.searchParams.set('fields', 'files(id,name,mimeType,thumbnailLink)');
    url.searchParams.set('pageSize', '200');
    const data = await driveJson(user, url.toString());

    for (const file of data.files || []) {
      if (isImageFile(file.name) && stripExtension(file.name).toLowerCase() === base && file.thumbnailLink) {
        return file.thumbnailLink;
      }
    }
    // Otherwise any image in the folder works as a fallback.
    const anyImage = (data.files || []).find((f) => isImageFile(f.name) && f.thumbnailLink);
    return anyImage ? anyImage.thumbnailLink : null;
  },

  // ------------------------------------------------------------------
  // Writes
  // ------------------------------------------------------------------
  /** Uploads a local file into a Drive folder, creating the folder path first. */
  // ------------------------------------------------------------------
  // Visible metadata documents (FRAUDIO state stored beside the media)
  // ------------------------------------------------------------------

  /**
   * Finds a *direct child* of `folderId` by exact name. Used to locate the
   * visible `fraudio-*.json` state document without walking the whole tree.
   */
  async findFileByName(user, folderId, name) {
    const matches = await this.findFilesByName(user, folderId, name);
    return matches[0] || null;
  },

  /** Every non-trashed file in a folder with this exact name (Drive permits dupes). */
  async findFilesByName(user, folderId, name) {
    if (!folderId) return [];
    const url = new URL(`${DRIVE_API}/files`);
    url.searchParams.set(
      'q',
      `'${folderId}' in parents and trashed = false and name = '${String(name).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
    );
    url.searchParams.set('fields', 'files(id,name,mimeType,size,modifiedTime)');
    url.searchParams.set('pageSize', '50');

    const data = await driveJson(user, url.toString());
    return data.files || [];
  },

  /**
   * Creates - or overwrites - a small JSON document directly in a Drive folder.
   * These are deliberately visible files: users can open, back up, diff or delete
   * them like any other file in the folder.
   */
  async writeJsonFile(user, folderId, fileName, payload, { fileId = null } = {}) {
    if (!folderId) throw new Error('No Drive folder selected.');
    const body = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');

    if (fileId) {
      const url = `${DRIVE_UPLOAD_API}/files/${fileId}?uploadType=media&fields=${encodeURIComponent('id,name,modifiedTime,size')}`;
      const res = await driveFetch(user, url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body
      });
      if (!res.ok) throw new Error(`Drive metadata update failed (HTTP ${res.status})`);
      return { id: fileId, name: fileName, updated: true };
    }

    const url = new URL(`${DRIVE_UPLOAD_API}/files`);
    url.searchParams.set('uploadType', 'multipart');
    url.searchParams.set('fields', 'id,name,modifiedTime,size');

    const boundary = `fraudio-${crypto.randomBytes(12).toString('hex')}`;
    const preamble =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify({ name: fileName, parents: [folderId] })}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n`;
    const epilogue = `\r\n--${boundary}--`;

    const res = await driveFetch(user, url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/related; boundary=${boundary}`,
        'Content-Length': String(
          Buffer.byteLength(preamble) + body.length + Buffer.byteLength(epilogue)
        )
      },
      body: Buffer.concat([Buffer.from(preamble), body, Buffer.from(epilogue)])
    });
    if (!res.ok) throw new Error(`Drive metadata upload failed (HTTP ${res.status})`);
    const data = await res.json();
    return { id: data.id, name: data.name || fileName, updated: false };
  },

  async uploadFile(user, localPath, { name, mimeType, folderId, onProgress } = {}) {
    const safeName = sanitizeSegment(stripExtension(name || path.basename(localPath)), 'Untitled');
    const fileName = `${safeName}${extensionOf(name || path.basename(localPath)) ? `.${extensionOf(name || path.basename(localPath))}` : ''}`;

    const result = await resumableUpload(user, localPath, {
      name: fileName,
      mimeType,
      parents: [folderId],
      onProgress
    });

    // Consumers (torrent downloads, YouTube Music) store `driveFileId`/
    // `driveFolderId`, so expose them here next to the raw Drive `id`. The final
    // Drive resource sometimes omits `size`, so fall back to the local file.
    return {
      ...result,
      driveFileId: result.id,
      driveFolderId: folderId,
      sizeBytes: Number(result.size) || fs.statSync(localPath).size,
      fileName
    };
  },

  /** Uploads an audiobook into Author / Series / Book inside the audiobooks folder. */
  async uploadAudiobook(user, localPath, { fileName, author, series, onProgress } = {}) {
    const folderId = user.audiobooksFolderId;
    if (!folderId) throw new Error('No audiobooks folder selected. Pick one in Settings first.');

    const segments = [];
    if (author) segments.push(sanitizeSegment(author, 'Unknown Author'));
    if (series) segments.push(sanitizeSegment(series, 'Unsorted'));

    const targetFolderId = segments.length
      ? await this.ensureFolderPath(user, folderId, segments)
      : folderId;

    const result = await this.uploadFile(user, localPath, {
      name: fileName || path.basename(localPath),
      folderId: targetFolderId,
      onProgress
    });

    return { ...result, drivePath: [...segments, result.fileName].join('/') };
  },

  async deleteFile(user, googleFileId) {
    await driveJson(user, `${DRIVE_API}/files/${googleFileId}`, { method: 'DELETE' });
    return true;
  },

  /** Removes a file and every descendant folder. */
  async deleteFolderRecursive(user, folderId) {
    const walk = async (id) => {
      const url = new URL(`${DRIVE_API}/files`);
      url.searchParams.set('q', `'${id}' in parents and trashed = false`);
      url.searchParams.set('fields', 'files(id,mimeType)');
      url.searchParams.set('pageSize', '1000');
      const data = await driveJson(user, url.toString());
      for (const child of data.files || []) {
        if (child.mimeType === FOLDER_MIME) await walk(child.id);
        else await this.deleteFile(user, child.id);
      }
    };
    await walk(folderId);
    await this.deleteFile(user, folderId);
    return true;
  },

  /** Returns a valid Google Drive access token for the given user. */
  async getAccessToken(user) {
    return googleAuth.getValidAccessToken(user);
  },

  async getValidAccessToken(user) {
    return googleAuth.getValidAccessToken(user);
  }
};

export default googleDrive;
