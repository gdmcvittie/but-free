import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, COVERS_DIR } from './config.js';
import db from './db.js';
import googleDrive from './googleDrive.js';
import { resolveFfmpeg, runProcess } from './binManager.js';
import offlineCache, { localFileFor } from './offlineCache.js';
import { broadcast } from './events.js';
import { extensionOf } from './libraryParser.js';

/**
 * Dedicated ID3 tag editor.
 *
 * Downloads one Drive audio file, rewrites its tags (and optional cover art) with
 * ffmpeg using stream copy, then uploads it back in place. Nothing is re-encoded:
 * the audio bitstream is preserved byte-for-byte.
 */

const TMP_DIR = path.join(DATA_DIR, 'temp_id3');
const MAX_COVER_BYTES = 15 * 1024 * 1024;
const COVER_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
const COVER_EMBED_EXTENSIONS = new Set(['mp3', 'm4a', 'm4b', 'mp4', 'aac', 'flac']);

function ensureTempDir() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  return TMP_DIR;
}

function cleanupWorkDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

function text(value, max = 512) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/\0/g, '').slice(0, max);
}

function imageExtension(format = '', url = '') {
  const lower = String(format || '').toLowerCase();
  if (lower.includes('png')) return 'png';
  if (lower.includes('gif')) return 'gif';
  if (lower.includes('webp')) return 'webp';
  if (lower.includes('jpeg') || lower.includes('jpg')) return 'jpg';
  const urlExt = String(url).split('?')[0].match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase();
  return COVER_EXTENSIONS.includes(urlExt) ? urlExt : 'jpg';
}

function bufferExtension(buffer) {
  if (!buffer || buffer.length < 12) return 'jpg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png';
  if (buffer.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return 'jpg';
}

function decodeDataUri(dataUri) {
  const match = String(dataUri).match(/^data:([^;]+);base64,(.+)$/s);
  if (!match) throw new Error('Cover image data was not a valid base64 data URL.');
  return { buffer: Buffer.from(match[2], 'base64'), mime: match[1] };
}

async function fetchCoverBuffer(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Cover image URL must start with http:// or https://.');
  }

  const res = await fetch(parsed.toString(), {
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      Accept: 'image/*'
    }
  });
  if (!res.ok) throw new Error(`Could not download cover art (HTTP ${res.status}).`);

  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > MAX_COVER_BYTES) throw new Error('Cover image is too large.');

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < 100) throw new Error('Cover image was empty.');
  if (buffer.length > MAX_COVER_BYTES) throw new Error('Cover image is too large.');
  return { buffer, mime: res.headers.get('content-type') || '' };
}

/** Turns one iTunes result into the shape the UI consumes. */
function toCoverOption(result) {
  const raw = result.artworkUrl600 || result.artworkUrl100 || '';
  if (!raw) return null;
  const artworkUrl = String(raw).replace(/\/\d+x\d+bb\./, '/600x600bb.');
  return {
    id: String(result.collectionId || result.trackId || artworkUrl),
    title: result.collectionName || result.trackName || result.artistName || 'Cover art',
    artist: result.artistName || '',
    album: result.collectionName || '',
    releaseDate: result.releaseDate || '',
    artworkUrl,
    thumbnailUrl: String(raw).replace(/\/\d+x\d+bb\./, '/200x200bb.')
  };
}

async function itunesSearch(term, { media, entity, limit = 12 }) {
  const params = new URLSearchParams({
    term,
    media,
    entity,
    limit: String(limit),
    country: 'US'
  });
  const res = await fetch(`https://itunes.apple.com/search?${params.toString()}`, {
    headers: { 'User-Agent': 'FRAUDIO/1.0', Accept: 'application/json' }
  });
  if (!res.ok) throw new Error(`Cover search failed (HTTP ${res.status}).`);
  const data = await res.json().catch(() => ({}));
  return Array.isArray(data.results) ? data.results : [];
}

/**
 * Searches iTunes for artwork. No API key needed, and it covers both music
 * albums and audiobooks. Returns a handful of options for the user to pick from.
 */
export async function searchCovers({ q, title, artist, album, kind, itemId }, user = null) {
  let subject = {
    title: text(title, 200),
    artist: text(artist, 200),
    album: text(album, 200),
    kind: kind === 'music' ? 'music' : 'audiobooks'
  };

  if (itemId && user) {
    const item = db.getItem(user.id, itemId);
    if (item) subject = subjectFromItem(item);
  }

  const query = text(q, 300).trim() || buildQuery(subject);
  if (!query) throw new Error('Add a title or artist before searching for cover art.');

  const wantsAudiobook = subject.kind !== 'music';
  const errors = [];
  const found = [];

  const collect = async (label, fn) => {
    try {
      found.push(...await fn());
    } catch (err) {
      console.warn(`[Covers] ${label} search failed: ${err.message}`);
      errors.push(`${label}: ${err.message}`);
    }
  };

  if (wantsAudiobook) {
    await collect('Open Library', () => openLibrarySearch(subject, query));
  }

  const itunesAttempts = wantsAudiobook
    ? [{ media: 'audiobook', entity: 'audiobook' }, { media: 'music', entity: 'album' }]
    : [{ media: 'music', entity: 'album' }, { media: 'music', entity: 'song' }];

  for (const attempt of itunesAttempts) {
    if (found.length >= 8) break;
    await collect(`iTunes ${attempt.entity}`, async () => {
      const results = await itunesSearch(query, attempt);
      return results.map(toCoverOption).filter(Boolean);
    });
  }

  const seen = new Set();
  const options = [];
  for (const option of found) {
    if (seen.has(option.artworkUrl)) continue;
    seen.add(option.artworkUrl);
    options.push(option);
    if (options.length >= 12) break;
  }

  if (options.length === 0 && errors.length === itunesAttempts.length + (wantsAudiobook ? 1 : 0)) {
    throw new Error(`Cover search is unavailable (${errors[0]}).`);
  }

  return { query, options, kind: subject.kind };
}

async function openLibrarySearch(subject, query) {
  const params = new URLSearchParams({ limit: '12', fields: 'key,title,author_name,cover_i' });
  if (subject.title) params.set('title', subject.title);
  if (subject.artist) params.set('author', subject.artist);
  if (!subject.title) params.set('q', query);

  const res = await fetch(`https://openlibrary.org/search.json?${params.toString()}`, {
    headers: { 'User-Agent': 'FRAUDIO/1.0 (cover art lookup)', Accept: 'application/json' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json().catch(() => ({}));

  return (data.docs || [])
    .filter((doc) => doc.cover_i)
    .map((doc) => ({
      id: `ol-${doc.cover_i}`,
      title: doc.title || 'Cover art',
      artist: (doc.author_name || []).join(', '),
      album: doc.title || '',
      releaseDate: '',
      artworkUrl: `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`,
      thumbnailUrl: `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg`
    }));
}

function buildQuery({ title, artist, album, kind }) {
  if (kind === 'music') return [artist, album || title].filter(Boolean).join(' ').trim();
  return [title, artist].filter(Boolean).join(' ').trim() || album || '';
}

function subjectFromItem(item) {
  if (item.kind === 'track') {
    return {
      title: item.title || '',
      artist: item.albumArtist || item.artist || item.author || '',
      album: item.album || '',
      kind: 'music'
    };
  }
  return {
    title: item.title || '',
    artist: item.author || item.artist || '',
    album: item.series || item.album || '',
    kind: 'audiobooks'
  };
}

/** Payload for the editor modal: item fields plus whether art already exists. */
export async function getEditorItem(user, itemId) {
  const item = db.getItem(user.id, itemId);
  if (!item) throw new Error('Item not found.');

  let hasCover = false;
  try {
    const resolved = await googleDrive.resolveCover(user, item.googleFileId, 600, item.coverImage || null);
    hasCover = Boolean(resolved && !resolved.placeholder);
  } catch (err) {
    console.warn(`[ID3] Cover probe failed for ${itemId}: ${err.message}`);
  }

  return {
    item,
    hasCover,
    coverUrl: hasCover ? `/api/items/${encodeURIComponent(item.id)}/cover?v=${Date.now()}` : null,
    ffmpegAvailable: Boolean(resolveFfmpeg()),
    defaults: subjectFromItem(item)
  };
}

/** Builds the ffmpeg `-metadata` pairs from an editor save payload. */
function buildMetadataArgs(payload) {
  const entries = [];
  const add = (key, value) => {
    if (value === undefined || value === null) return;
    entries.push([key, text(value, 2048)]);
  };

  add('title', payload.title);
  add('artist', payload.artist);
  add('album_artist', payload.albumArtist);
  add('album', payload.album);
  add('genre', payload.genre);
  add('date', payload.year);
  add('track', payload.track);
  add('disc', payload.disc);
  add('comment', payload.comment);
  add('composer', payload.composer);
  // Audiobooks send `series`; store it as the album tag when no album was given.
  if (payload.album === undefined && payload.series !== undefined) add('album', payload.series);

  return entries;
}

function buildDbUpdates(item, payload) {
  const updates = {};
  const isAudiobook = item.kind !== 'track';

  if (payload.title !== undefined) updates.title = text(payload.title, 300);
  if (payload.artist !== undefined) {
    updates.artist = text(payload.artist, 300);
    if (isAudiobook) updates.author = text(payload.artist, 300);
  }
  if (payload.albumArtist !== undefined) updates.albumArtist = text(payload.albumArtist, 300);
  if (payload.album !== undefined) {
    updates.album = text(payload.album, 300);
    if (isAudiobook) updates.series = text(payload.album, 300);
  }
  if (payload.series !== undefined && isAudiobook) updates.series = text(payload.series, 300);
  if (payload.genre !== undefined) updates.genre = text(payload.genre, 300);
  if (payload.year !== undefined) updates.year = text(payload.year, 40);
  if (payload.track !== undefined) {
    const parsed = parseInt(String(payload.track).split('/')[0], 10);
    updates.trackNumber = Number.isFinite(parsed) ? parsed : null;
  }
  if (payload.disc !== undefined) {
    const parsed = parseInt(String(payload.disc).split('/')[0], 10);
    updates.discNumber = Number.isFinite(parsed) ? parsed : null;
  }
  if (payload.comment !== undefined) updates.comment = text(payload.comment, 2000);
  if (payload.composer !== undefined) {
    updates.composer = text(payload.composer, 300);
    if (isAudiobook) updates.narrator = text(payload.composer, 300);
  }

  return updates;
}

/** Removes cached cover files for a Drive file so the new art is rebuilt. */
function invalidateCoverCache(googleFileId) {
  for (const width of [600, 300, 1200]) {
    const key = crypto.createHash('sha1').update(`${googleFileId}-${width}`).digest('hex');
    for (const ext of ['jpg', 'png', 'gif', 'webp', 'svg']) {
      try {
        fs.rmSync(path.join(COVERS_DIR, `${key}.${ext}`), { force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Saves tags and cover art back to the original Drive file.
 *
 * `coverBase64` (user upload), `coverUrl` (search result) and `removeCover` are
 * mutually exclusive. When none is given the existing embedded art is preserved.
 */
export async function saveItemTags(user, itemId, payload = {}) {
  const item = db.getItem(user.id, itemId);
  if (!item) throw new Error('Item not found.');
  if (!item.googleFileId) throw new Error('This item has no file in Google Drive.');

  const ffmpeg = resolveFfmpeg();
  if (!ffmpeg) throw new Error('FFmpeg is not installed, so tags cannot be written.');

  const meta = await googleDrive.getFileMetadata(user, item.googleFileId, 'id,name,mimeType,size,modifiedTime');
  const fileName = meta.name || item.fileName || item.title || 'audio.mp3';
  const ext = (extensionOf(fileName) || 'mp3').toLowerCase();

  ensureTempDir();
  const workDir = fs.mkdtempSync(path.join(TMP_DIR, 'edit-'));
  const inputPath = path.join(workDir, `input.${ext}`);
  const outputPath = path.join(workDir, `output.${ext}`);

  try {
    await googleDrive.downloadFile(user, item.googleFileId, inputPath);

    // Resolve cover art. `undefined` means "leave whatever is already embedded".
    let cover = null;
    if (payload.removeCover) {
      cover = null;
    } else if (payload.coverBase64) {
      const decoded = decodeDataUri(payload.coverBase64);
      cover = { buffer: decoded.buffer, ext: imageExtension(decoded.mime) };
    } else if (payload.coverUrl) {
      const fetched = await fetchCoverBuffer(payload.coverUrl);
      cover = { buffer: fetched.buffer, ext: imageExtension(fetched.mime, payload.coverUrl) };
    }

    const canEmbedCover = COVER_EMBED_EXTENSIONS.has(ext);
    const writeCover = Boolean(cover && canEmbedCover);
    const removeCover = Boolean(payload.removeCover && canEmbedCover);

    let coverPath = null;
    if (writeCover) {
      coverPath = path.join(workDir, `cover.${cover.ext}`);
      fs.writeFileSync(coverPath, cover.buffer);
    }

    const args = ['-y', '-i', inputPath];

    if (writeCover) {
      args.push('-i', coverPath);
      args.push('-map', '0:a', '-map', '1:v');
      args.push('-c:a', 'copy');
      args.push('-c:v', ext === 'flac' ? 'copy' : 'mjpeg');
      args.push('-disposition:v:0', 'attached_pic');
      args.push('-metadata:s:v', 'title=Album cover');
      args.push('-metadata:s:v', 'comment=Cover (front)');
    } else if (removeCover) {
      args.push('-map', '0:a', '-c:a', 'copy');
    } else {
      // No art change: copy every stream so the existing APIC/attached picture
      // survives untouched.
      args.push('-map', '0', '-c', 'copy');
    }

    args.push('-map_metadata', '0');
    if (ext === 'mp3') args.push('-id3v2_version', '3');

    for (const [key, value] of buildMetadataArgs(payload)) {
      args.push('-metadata', `${key}=${value}`);
    }
    args.push(outputPath);

    await runProcess(ffmpeg, args);

    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
      throw new Error('FFmpeg produced an empty audio file.');
    }

    await googleDrive.updateFileContent(user, item.googleFileId, outputPath);

    // Keep an offline copy in sync so offline playback doesn't serve stale tags.
    const localCopy = localFileFor(item.id);
    if (localCopy) {
      try {
        if (path.extname(localCopy).toLowerCase() === path.extname(outputPath).toLowerCase()) {
          fs.copyFileSync(outputPath, localCopy);
          offlineCache.invalidateOfflineCache();
        }
      } catch (err) {
        console.warn(`[ID3] Could not refresh offline copy for ${item.id}: ${err.message}`);
      }
    }

    const updates = buildDbUpdates(item, payload);

    // Store the chosen art locally as the item's cover hint, or clear it when art
    // was explicitly removed.
    if (cover) {
      const coverExt = cover.ext === 'jpeg' ? 'jpg' : cover.ext;
      const coverPathOnDisk = path.join(COVERS_DIR, `id3_${item.id}_${Date.now()}.${coverExt}`);
      fs.mkdirSync(COVERS_DIR, { recursive: true });
      fs.writeFileSync(coverPathOnDisk, cover.buffer);
      updates.coverImage = coverPathOnDisk;
    } else if (payload.removeCover) {
      updates.coverImage = null;
    }

    updates.sizeBytes = fs.statSync(outputPath).size;
    updates.modifiedTime = new Date().toISOString();

    invalidateCoverCache(item.googleFileId);
    const saved = db.updateItem(user.id, item.id, updates);

    // Probe again so the caller knows whether art is present after the edit.
    let hasCover = false;
    try {
      const resolved = await googleDrive.resolveCover(
        user,
        item.googleFileId,
        600,
        updates.coverImage !== undefined ? updates.coverImage : item.coverImage || null
      );
      hasCover = Boolean(resolved && !resolved.placeholder);
    } catch {
      hasCover = Boolean(cover);
    }

    broadcast('library_changed', {
      userId: user.id,
      reason: 'id3_edit',
      kind: item.kind === 'track' ? 'music' : 'audiobooks'
    });

    return {
      success: true,
      item: saved,
      hasCover,
      coverUrl: hasCover ? `/api/items/${encodeURIComponent(item.id)}/cover?v=${Date.now()}` : null,
      coverWarning: cover && !canEmbedCover
        ? `Cover art cannot be embedded in .${ext} files; tags were saved without it.`
        : null
    };
  } finally {
    cleanupWorkDir(workDir);
  }
}

export default { getEditorItem, searchCovers, saveItemTags };
