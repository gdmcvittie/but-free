import fs from 'fs';
import { sanitizeName } from './util.js';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

const MIME_BY_EXT = {
  '.m4b': 'audio/mp4',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.wma': 'audio/x-ms-wma',
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.m4v': 'video/mp4'
};

function mimeFor(filePath) {
  const ext = String(filePath).slice(String(filePath).lastIndexOf('.')).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

function escapeQuery(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export async function findFolder(accessToken, parentFolderId, folderName, refreshTokenFn) {
  const cleanName = sanitizeName(folderName);
  if (!accessToken || !parentFolderId || !cleanName) return null;

  const query = `'${escapeQuery(parentFolderId)}' in parents and name = '${escapeQuery(cleanName)}'`
    + " and mimeType = 'application/vnd.google-apps.folder' and trashed = false";
  const url = `${DRIVE_API}/files?q=${encodeURIComponent(query)}&fields=files(id,name)&pageSize=1`;

  let res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });

  if (res.status === 401 && typeof refreshTokenFn === 'function') {
    const refreshed = await refreshTokenFn();
    if (refreshed) {
      accessToken = refreshed;
      res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    }
  }

  if (res.ok) {
    const data = await res.json();
    if (data.files && data.files.length) return data.files[0].id;
  }
  return null;
}

export async function findOrCreateFolder(accessToken, parentFolderId, folderName, refreshTokenFn) {
  const cleanName = sanitizeName(folderName);
  if (!accessToken || !parentFolderId) throw new Error('Missing credentials or parent folder for folder lookup');
  if (!cleanName) throw new Error('Refusing to create a folder with an empty name');

  const existing = await findFolder(accessToken, parentFolderId, cleanName, refreshTokenFn);
  if (existing) return existing;

  const create = () => fetch(`${DRIVE_API}/files`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: cleanName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentFolderId]
    })
  });

  let res = await create();
  if (res.status === 401 && typeof refreshTokenFn === 'function') {
    const refreshed = await refreshTokenFn();
    if (refreshed) {
      accessToken = refreshed;
      res = await create();
    }
  }

  if (!res.ok) {
    throw new Error(`Failed to create Drive folder "${cleanName}": ${res.status} ${await res.text()}`);
  }
  const created = await res.json();
  return created.id;
}

export async function resolveTargetFolderId(accessToken, rootFolderId, meta, refreshTokenFn = null) {
  if (meta && meta.kind === 'tv' && meta.showName) {
    const showFolderId = await findOrCreateFolder(accessToken, rootFolderId, meta.showName, refreshTokenFn);
    const seasonNum = parseInt(meta.season, 10) || 1;
    const seasonCandidates = [`Season ${seasonNum}`, `Season ${String(seasonNum).padStart(2, '0')}`];
    let seasonFolderId = null;
    for (const cand of seasonCandidates) {
      seasonFolderId = await findFolder(accessToken, showFolderId, cand, refreshTokenFn);
      if (seasonFolderId) break;
    }
    if (!seasonFolderId) {
      seasonFolderId = await findOrCreateFolder(accessToken, showFolderId, `Season ${seasonNum}`, refreshTokenFn);
    }
    return seasonFolderId;
  }

  if (meta && meta.kind === 'movie' && meta.genre) {
    const cleanGenre = String(meta.genre).replace(/['\\\/]/g, '').trim() || 'Movies';
    return await findOrCreateFolder(accessToken, rootFolderId, cleanGenre, refreshTokenFn);
  }

  return rootFolderId;
}

/**
 * Resolves the Author / Series destination for an audiobook.
 *
 *   <root>/<Author>/<Series>/
 *
 * When no series is known the file lands directly in the Author folder, which
 * keeps standalone books from sprouting a pointless "Unsorted" level.
 */
export async function resolveAudiobookFolder(accessToken, rootFolderId, meta, refreshTokenFn) {
  const author = sanitizeName(meta?.author, 'Unknown Author');
  const authorFolderId = await findOrCreateFolder(accessToken, rootFolderId, author, refreshTokenFn);

  const series = sanitizeName(meta?.series);
  if (!series) return { folderId: authorFolderId, drivePath: author };

  const seriesFolderId = await findOrCreateFolder(accessToken, authorFolderId, series, refreshTokenFn);
  return { folderId: seriesFolderId, drivePath: `${author} / ${series}` };
}

/** Small non-resumable upload, used for cover art. */
export async function uploadCover(filePath, fileName, destFolderId, accessToken, refreshTokenFn) {
  if (!fs.existsSync(filePath)) throw new Error(`Cover file not found: ${filePath}`);
  const body = new Uint8Array(fs.readFileSync(filePath));

  const send = () => fetch(`${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,name,parents`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'multipart/related; boundary=fraudio_boundary'
    },
    body: buildMultipart(fileName, destFolderId, body)
  });

  let res = await send();
  if (res.status === 401 && typeof refreshTokenFn === 'function') {
    const refreshed = await refreshTokenFn();
    if (refreshed) {
      accessToken = refreshed;
      res = await send();
    }
  }
  if (!res.ok) throw new Error(`Cover upload failed: ${res.status} ${await res.text()}`);
  return res.json();
}

function buildMultipart(fileName, destFolderId, bytes) {
  const boundary = 'fraudio_boundary';
  const meta = JSON.stringify({ name: fileName, parents: [destFolderId] });
  const head = Buffer.from(
    `--${boundary}\r\n`
    + 'Content-Type: application/json; charset=UTF-8\r\n\r\n'
    + `${meta}\r\n`
    + `--${boundary}\r\n`
    + 'Content-Type: image/jpeg\r\n\r\n',
    'utf8'
  );
  const tail = Buffer.from(`\r\n--${boundary}--`, 'utf8');
  return Buffer.concat([head, Buffer.from(bytes), tail]);
}

/**
 * Chunked resumable upload. Audiobooks routinely exceed 1GB, so a single
 * multipart POST is not an option and Drive's 1-hour token TTL can expire
 * mid-transfer - hence the refresh callback.
 */
export async function uploadFileToGoogleDrive(
  filePath,
  fileName,
  destFolderId,
  accessToken,
  onProgress = null,
  refreshTokenFn = null
) {
  if (!fs.existsSync(filePath)) throw new Error(`Local file not found for Drive upload: ${filePath}`);

  const fileSize = fs.statSync(filePath).size;
  const contentType = mimeFor(filePath);

  const initiate = () => fetch(`${DRIVE_UPLOAD_API}/files?uploadType=resumable&fields=id,name,parents`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': contentType,
      'X-Upload-Content-Length': String(fileSize)
    },
    body: JSON.stringify({ name: fileName, parents: [destFolderId] })
  });

  let initRes = await initiate();
  if (initRes.status === 401 && typeof refreshTokenFn === 'function') {
    const refreshed = await refreshTokenFn();
    if (refreshed) {
      accessToken = refreshed;
      initRes = await initiate();
    }
  }
  if (!initRes.ok) {
    throw new Error(`Failed to initiate Drive upload for "${fileName}": ${initRes.status} ${await initRes.text()}`);
  }

  const sessionUri = initRes.headers.get('location');
  if (!sessionUri) throw new Error('Google Drive did not return a resumable session URI');

  // 8 MiB is the chunk size Google documents as a safe multiple of 256 KiB.
  const CHUNK_SIZE = 8 * 1024 * 1024;
  let offset = 0;
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(CHUNK_SIZE);

  try {
    while (offset < fileSize) {
      const bytesToRead = Math.min(CHUNK_SIZE, fileSize - offset);
      fs.readSync(fd, buffer, 0, bytesToRead, offset);
      const chunk = bytesToRead === CHUNK_SIZE ? buffer : buffer.subarray(0, bytesToRead);

      let chunkRes = await fetch(sessionUri, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Length': String(bytesToRead),
          'Content-Range': `bytes ${offset}-${offset + bytesToRead - 1}/${fileSize}`
        },
        body: chunk
      });

      // A long upload can outlive the access token; refresh once and retry the
      // same range rather than restarting the whole file.
      if (chunkRes.status === 401 && typeof refreshTokenFn === 'function') {
        const refreshed = await refreshTokenFn();
        if (refreshed) {
          accessToken = refreshed;
          chunkRes = await fetch(sessionUri, {
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Length': String(bytesToRead),
              'Content-Range': `bytes ${offset}-${offset + bytesToRead - 1}/${fileSize}`
            },
            body: chunk
          });
        }
      }

      if (chunkRes.status === 308) {
        offset += bytesToRead;
        if (onProgress) onProgress(Math.round((offset / fileSize) * 100));
        continue;
      }

      if (chunkRes.ok) {
        const fileObj = await chunkRes.json();
        if (onProgress) onProgress(100);
        return fileObj;
      }

      throw new Error(`Upload of "${fileName}" failed at byte ${offset}: HTTP ${chunkRes.status} - ${await chunkRes.text()}`);
    }
  } finally {
    fs.closeSync(fd);
  }

  throw new Error(`Upload of "${fileName}" ended without a Drive response`);
}

/**
 * Resolves the Artist / Album destination for music tracks.
 *   <musicRoot>/<Artist>/<Album>/
 */
export async function resolveMusicFolder(accessToken, rootFolderId, artist, album, refreshTokenFn) {
  const cleanArtist = sanitizeName(artist || 'Unknown Artist', 'Unknown Artist');
  const artistFolderId = await findOrCreateFolder(accessToken, rootFolderId, cleanArtist, refreshTokenFn);

  const cleanAlbum = sanitizeName(album || 'Singles', 'Singles');
  const albumFolderId = await findOrCreateFolder(accessToken, artistFolderId, cleanAlbum, refreshTokenFn);

  return { folderId: albumFolderId, drivePath: `${cleanArtist} / ${cleanAlbum}` };
}

/**
 * Deletes any existing file matching `fileName` inside `folderId` so resumed or
 * re-run downloads don't create duplicate files in Drive.
 */
export async function deleteFileByName(accessToken, folderId, fileName, refreshTokenFn) {
  const cleanName = sanitizeName(fileName);
  if (!accessToken || !folderId || !cleanName) return;

  const query = `'${escapeQuery(folderId)}' in parents and name = '${escapeQuery(cleanName)}' and trashed = false`;
  const url = `${DRIVE_API}/files?q=${encodeURIComponent(query)}&fields=files(id,name)&pageSize=10`;

  let res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (res.status === 401 && typeof refreshTokenFn === 'function') {
    const refreshed = await refreshTokenFn();
    if (refreshed) {
      accessToken = refreshed;
      res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    }
  }

  if (res.ok) {
    const data = await res.json();
    for (const f of data.files || []) {
      try {
        await fetch(`${DRIVE_API}/files/${f.id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${accessToken}` }
        });
      } catch (_) { /* ignore */ }
    }
  }
}