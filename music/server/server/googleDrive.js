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
    body: JSON.stringify({ name, mimeType: mimeType || 'application/octet-stream', parents: (parents || []).filter(Boolean) })
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
            coverImage: image?.thumbnailLink || null,
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
  async syncLibrary(user, kind = 'audiobooks', { protectFileIds = [], forceCovers = false, onProgress } = {}) {
    const folderId = kind === 'music' ? user.musicFolderId : user.audiobooksFolderId;
    if (!folderId) {
      throw new Error(
        kind === 'music'
          ? 'No music folder selected yet. Pick one in Settings first.'
          : 'No audiobooks folder selected yet. Pick one in Settings first.'
      );
    }

    if (forceCovers) {
      activeCoverBuilds.clear();
      activeBufferReads.clear();
      try {
        if (fs.existsSync(COVERS_DIR)) {
          const entries = fs.readdirSync(COVERS_DIR);
          for (const ent of entries) {
            // Keep local custom id3 editor uploads
            if (!ent.startsWith('id3_')) {
              try { fs.rmSync(path.join(COVERS_DIR, ent), { force: true }); } catch {}
            }
          }
        }
      } catch (err) {
        console.warn('[Cover] Could not purge covers cache:', err.message);
      }
    }

    onProgress?.({
      stage: 'listing',
      message: forceCovers ? 'Scanning Drive & updating covers…' : 'Scanning Google Drive…',
      processed: 0,
      total: 0
    });

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
        !forceCovers &&
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
          coverImage: existing.coverImage || file.coverImage || null,
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
      name: filesToRead.length > 0
        ? `${forceCovers ? 'Re-evaluating covers & metadata' : 'Reading metadata'} (${filesToRead.length} ${forceCovers ? 'tracks' : 'new/changed'})…`
        : 'Up to date'
    });

    // Read tags with controlled concurrency (5 at a time)
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

          // If forceCovers is active, discard old remote URLs to let true embedded covers or fresh siblings win
          let initialCover = file.coverImage || null;
          if (!forceCovers && existing?.coverImage) {
            initialCover = existing.coverImage;
          } else if (forceCovers && existing?.coverImage && !/^https?:\/\//i.test(existing.coverImage) && fs.existsSync(existing.coverImage)) {
            // Preserve manual ID3 editor cover file stored locally
            initialCover = existing.coverImage;
          }

          const base = {
            googleFileId: file.id,
            driveFolderId: folderId,
            sizeBytes: Number(file.size) || 0,
            modifiedTime: file.modifiedTime,
            coverImage: initialCover,
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
            if (existing.genre && (!record.genre || record.genre === 'Audiobook')) record.genre = existing.genre;
            if (existing.author && (!record.author || record.author === 'Unknown Author')) record.author = existing.author;
            if (existing.subtitle && !record.subtitle) record.subtitle = existing.subtitle;
            if (!forceCovers && existing.coverImage) {
              record.coverImage = existing.coverImage;
            } else if (forceCovers && existing.coverImage && !/^https?:\/\//i.test(existing.coverImage) && fs.existsSync(existing.coverImage)) {
              record.coverImage = existing.coverImage;
            } else if (forceCovers) {
              record.coverImage = initialCover;
            }
          }

          if (forceCovers) {
            record.coverUpdatedAt = Date.now();
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

  /** Streams a Drive file to local disk without holding it in memory. */
  async downloadFile(user, googleFileId, destPath) {
    const res = await driveFetch(user, `${DRIVE_API}/files/${googleFileId}?alt=media`);
    if (!res.ok && res.status !== 206) {
      throw new Error(`Drive download failed (HTTP ${res.status})`);
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(destPath));
    return destPath;
  },

  // ------------------------------------------------------------------
  // Covers
  // ------------------------------------------------------------------
  async buildCover(user, googleFileId, { width = 600, hintCoverUrl = null, force = false } = {}) {
    // Drive returns sibling/image covers in the order Author / Series / Book, so a
    // "Book Title.jpg" typically sits next to "Book Title.m4b" rather than beside the
    // first file of the book. Search outward from the item's own folder.
    const cover = await this.resolveCover(user, googleFileId, width, hintCoverUrl, force);
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
   * Extracts embedded picture data from an audio file.
   * Handles MP3 ID3v2 tags (with exact ranged tag reads), as well as FLAC, M4A,
   * OGG, and AAC files via header buffer parsing with music-metadata.
   */
  async extractEmbeddedPicture(user, googleFileId, key, meta = null) {
    try {
      // 1. Try ID3v2 header check for MP3 / ID3-tagged files
      const head = await this.getFileBuffer(user, googleFileId, { range: 'bytes=0-9' }).catch(() => null);
      if (head && head.length >= 10 && head.subarray(0, 3).toString('latin1') === 'ID3') {
        const hasFooter = Boolean(head[5] & 0x10);
        const size = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
        if (size > 0 && size <= 16 * 1024 * 1024) {
          const totalTagBytes = 10 + size + (hasFooter ? 10 : 0);
          const tag = await this.getFileBuffer(user, googleFileId, { range: `bytes=0-${totalTagBytes - 1}` }).catch(() => null);
          if (tag && tag.length >= 10) {
            const parsed = await parseBuffer(tag, { mimeType: 'audio/mpeg' }, { duration: false, skipCovers: false }).catch(() => null);
            const pic = parsed?.common?.picture?.[0];
            if (pic?.data?.length) {
              const format = String(pic.format || '').toLowerCase();
              const ext = format.includes('png') ? 'png' : format.includes('gif') ? 'gif' : format.includes('webp') ? 'webp' : 'jpg';
              const outPath = path.join(COVERS_DIR, `${key}.${ext}`);
              fs.mkdirSync(COVERS_DIR, { recursive: true });
              fs.writeFileSync(outPath, pic.data);
              return { file: outPath, cached: false };
            }
          }
        }
      }

      // 2. Fallback for FLAC, M4A, OGG, or files without ID3 at byte 0:
      // Read first COVER_SCAN_BYTES (1MB) and let music-metadata parse the container/tags
      const buf = await this.getFileBuffer(user, googleFileId, { range: `bytes=0-${COVER_SCAN_BYTES - 1}` }).catch(() => null);
      if (buf && buf.length >= 32) {
        const mimeType = meta?.mimeType || (meta?.name?.endsWith('.flac') ? 'audio/flac' : meta?.name?.endsWith('.m4a') ? 'audio/mp4' : undefined);
        const parsed = await parseBuffer(buf, mimeType ? { mimeType } : undefined, { duration: false, skipCovers: false }).catch(() => null);
        const pic = parsed?.common?.picture?.[0];
        if (pic?.data?.length) {
          const format = String(pic.format || '').toLowerCase();
          const ext = format.includes('png') ? 'png' : format.includes('gif') ? 'gif' : format.includes('webp') ? 'webp' : 'jpg';
          const outPath = path.join(COVERS_DIR, `${key}.${ext}`);
          fs.mkdirSync(COVERS_DIR, { recursive: true });
          fs.writeFileSync(outPath, pic.data);
          return { file: outPath, cached: false };
        }
      }
      return null;
    } catch (err) {
      console.warn(`[Cover] Embedded art extraction failed for ${googleFileId}: ${err.message}`);
      return null;
    }
  },

  /**
   * Resolves a cover image for one Drive file and caches it on disk.
   * Prioritizes track-specific embedded art to avoid assigning unrelated sibling images.
   */
  async resolveCover(user, googleFileId, width, hintCoverUrl = null, force = false) {
    const buildKey = `${googleFileId}-${width}`;
    if (!force && activeCoverBuilds.has(buildKey)) return activeCoverBuilds.get(buildKey);

    const task = (async () => {
      const key = crypto.createHash('sha1').update(buildKey).digest('hex');

      // 0. A locally cached cover chosen by the ID3 editor or stitcher wins over
      //    anything Drive-derived, so the user's pick shows immediately.
      if (hintCoverUrl && !/^https?:\/\//i.test(hintCoverUrl) && fs.existsSync(hintCoverUrl)) {
        return { file: hintCoverUrl, cached: true };
      }

      if (!force) {
        const cached = ['jpg', 'png', 'gif', 'webp']
          .map((ext) => path.join(COVERS_DIR, `${key}.${ext}`))
          .find((file) => fs.existsSync(file) && fs.statSync(file).size > 0);
        if (cached) return { file: cached, cached: true };
      } else {
        for (const ext of ['jpg', 'png', 'gif', 'webp', 'svg']) {
          try { fs.rmSync(path.join(COVERS_DIR, `${key}.${ext}`), { force: true }); } catch {}
        }
      }
      const outPath = path.join(COVERS_DIR, `${key}.jpg`);

      // `parents` is required: findSiblingCover walks the item's folder.
      const meta = await this.getFileMetadata(
        user, googleFileId, 'id,name,mimeType,parents,thumbnailLink,hasThumbnail'
      );
      if (!meta) return null;

      const isAudio = isAudioFile(meta.name) || (meta.mimeType || '').startsWith('audio');

      // 1. Embedded art in the audio file itself (ID3 APIC, FLAC picture block, M4A covr).
      // For audio tracks, embedded art is the most accurate source and prevents
      // unrelated artist or folder images from overriding the track's real cover.
      if (isAudio) {
        const embedded = await this.extractEmbeddedPicture(user, googleFileId, key, meta);
        if (embedded) return embedded;
      }

      // 2. A cover image stored beside the audio file:
      // exact name match ("Track.jpg") or standard album cover name ("cover.jpg", "folder.jpg").
      const sibling = await this.findSiblingCover(user, meta);
      if (sibling) {
        return this.cacheRemoteCover(sibling, key, outPath, user);
      }

      // 3. Hint cover URL (e.g. from YouTube Music album/song download).
      if (hintCoverUrl && (hintCoverUrl.startsWith('http://') || hintCoverUrl.startsWith('https://'))) {
        try {
          const hinted = await this.cacheRemoteCover(hintCoverUrl, key, outPath, user);
          if (hinted) return hinted;
        } catch {
          // fallback to Drive methods
        }
      }

      // 4. Drive's own generated thumbnail for this file.
      if (meta.thumbnailLink) {
        return this.cacheRemoteCover(meta.thumbnailLink, key, outPath, user);
      }

      // 5. Walk up the folder tree looking for standard album cover art (primarily for multi-file audiobooks).
      const inherited = await this.findInheritedCover(user, meta);
      if (inherited) {
        return this.cacheRemoteCover(inherited, key, outPath, user);
      }

      return null;
    })();

    activeCoverBuilds.set(buildKey, task);
    task.then(
      () => activeCoverBuilds.delete(buildKey),
      () => activeCoverBuilds.delete(buildKey)
    );
    return task;
  },

  /**
   * Looks for cover art in the item's ancestors (Book -> Series -> Author).
   * Only matches standard cover names ("cover.jpg", "folder.jpg", "album.jpg", "front.jpg")
   * to avoid inheriting arbitrary unrelated images from parent directories.
   */
  async findInheritedCover(user, meta, maxDepth = 3) {
    let parentId = meta.parents?.[0];
    let depth = 0;
    const visited = new Set();
    const STANDARD_COVER_NAMES = new Set(['cover', 'folder', 'album', 'front', 'artwork']);

    while (parentId && parentId !== 'root' && depth < maxDepth && !visited.has(parentId)) {
      visited.add(parentId);
      const url = new URL(`${DRIVE_API}/files`);
      url.searchParams.set('q', `'${parentId}' in parents and trashed = false`);
      url.searchParams.set('fields', 'files(id,name,mimeType,thumbnailLink)');
      url.searchParams.set('pageSize', '200');
      const data = await driveJson(user, url.toString()).catch(() => null);
      if (!data) return null;

      const image = (data.files || []).find((f) =>
        isImageFile(f.name) &&
        f.thumbnailLink &&
        STANDARD_COVER_NAMES.has(stripExtension(f.name).toLowerCase())
      );
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

  /**
   * Looks for a cover image sitting in the same folder as the media file:
   * 1. Exact base match: "Song Name.jpg" next to "Song Name.mp3"
   * 2. Standard album art: "cover.jpg", "folder.jpg", "album.jpg", "front.jpg", "artwork.jpg"
   * Arbitrary unrelated images in the folder are strictly ignored.
   */
  async findSiblingCover(user, meta) {
    const parentId = meta.parents?.[0];
    if (!parentId || !meta.name) return null;

    const base = stripExtension(meta.name).toLowerCase();
    const url = new URL(`${DRIVE_API}/files`);
    url.searchParams.set('q', `'${parentId}' in parents and trashed = false`);
    url.searchParams.set('fields', 'files(id,name,mimeType,thumbnailLink)');
    url.searchParams.set('pageSize', '200');
    const data = await driveJson(user, url.toString()).catch(() => null);
    if (!data) return null;

    const files = data.files || [];
    // 1. Exact base match
    for (const file of files) {
      if (isImageFile(file.name) && stripExtension(file.name).toLowerCase() === base && file.thumbnailLink) {
        return file.thumbnailLink;
      }
    }

    // 2. Standard album art filenames
    const STANDARD_COVER_NAMES = new Set(['cover', 'folder', 'album', 'front', 'artwork']);
    for (const file of files) {
      if (isImageFile(file.name) && STANDARD_COVER_NAMES.has(stripExtension(file.name).toLowerCase()) && file.thumbnailLink) {
        return file.thumbnailLink;
      }
    }

    return null;
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

  /** Replaces an existing Drive file's binary content in-place using resumable upload. */
  async updateFileContent(user, fileId, localPath, { onProgress, signal } = {}) {
    const accessToken = await googleAuth.getValidAccessToken(user);
    const stat = fs.statSync(localPath);

    const initRes = await fetch(`${DRIVE_UPLOAD_API}/files/${fileId}?uploadType=resumable`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(stat.size)
      }
    });

    if (!initRes.ok) {
      const errText = await initRes.text();
      throw new Error(`Could not start Drive update: HTTP ${initRes.status} ${errText.slice(0, 200)}`);
    }

    const sessionUrl = initRes.headers.get('location');
    if (!sessionUrl) throw new Error('Google Drive did not return an update session URL.');

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
      throw new Error(data?.error?.message || `Drive update failed (HTTP ${uploadRes.status})`);
    }
    onProgress?.({ uploaded: stat.size, total: stat.size });
    return {
      ...data,
      driveFileId: fileId,
      sizeBytes: Number(data.size) || stat.size
    };
  },

  /** Lists all files within a specific Drive folder. */
  async listFilesInFolder(user, folderId) {
    if (!folderId) return [];
    const url = new URL(`${DRIVE_API}/files`);
    url.searchParams.set('q', `'${folderId}' in parents and trashed = false`);
    url.searchParams.set('fields', 'files(id,name,mimeType,size,modifiedTime)');
    url.searchParams.set('pageSize', '1000');
    const data = await driveJson(user, url.toString());
    return data.files || [];
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

  /** Copies an existing Drive file to a target destination folder using Google Drive API v3. */
  async copyFile(user, googleFileId, { name, folderId } = {}) {
    if (!googleFileId) throw new Error('File ID is required for copy.');
    const url = new URL(`${DRIVE_API}/files/${googleFileId}/copy`);
    url.searchParams.set('supportsAllDrives', 'true');
    url.searchParams.set('fields', 'id,name,mimeType,size,parents');

    const body = {};
    if (name) body.name = name;
    if (folderId) body.parents = [folderId];

    const data = await driveJson(user, url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify(body)
    });

    return {
      ...data,
      driveFileId: data.id,
      driveFolderId: folderId || data.parents?.[0],
      sizeBytes: Number(data.size) || 0,
      fileName: data.name || name
    };
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
