import fs from 'fs';
import path from 'path';
import WebTorrent from 'webtorrent';
import {
  buildMagnet,
  infoHashOf,
  listAudioParts,
  looksLikeAudioPart,
  sanitizeName
} from './util.js';
import {
  resolveAudiobookFolder,
  resolveMusicFolder,
  deleteFileByName,
  uploadCover,
  uploadFileToGoogleDrive
} from './driveUploader.js';
import {
  downloadYoutubeTrack,
  toolsStatus
} from './youtubeDownloader.js';

const DOWNLOADS_DIR = path.resolve(process.env.DOWNLOADS_DIR || './downloads');
const HISTORY_FILE = path.join(path.dirname(DOWNLOADS_DIR), 'download_history.json');
const MAX_CONCURRENT = Math.max(1, parseInt(process.env.MAX_CONCURRENT || '1', 10) || 1);
const ORPHAN_MAX_AGE_MS = (parseInt(process.env.ORPHAN_MAX_AGE_MINUTES || '60', 10) || 60) * 60 * 1000;

fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

/** jobId -> job record */
const jobs = new Map();
/** infoHash -> jobId, prevents queueing the same release twice concurrently. */
const claimed = new Map();

const queue = [];
const active = new Map();

let client = null;
function getClient() {
  if (client) return client;
  client = new WebTorrent({ dht: true, tracker: true, lsd: true, maxConns: 100 });
  client.on('error', (err) => console.warn('[FraudioStreamer] client error:', err?.message || err));
  return client;
}

// -------------------------------------------------------------
// Persistence
// -------------------------------------------------------------
function loadHistory() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    if (!Array.isArray(parsed)) return;
    for (const record of parsed) {
      // Never resurrect a job that was mid-flight; the swarm died with the process.
      if (record && record.id) {
        jobs.set(record.id, {
          ...record,
          status: record.status === 'downloading' || record.status === 'uploading' ? 'error' : record.status,
          error: record.status === 'downloading' || record.status === 'uploading'
            ? 'Node restarted while this job was in flight.'
            : record.error,
          stage: record.status === 'downloading' || record.status === 'uploading' ? 'error' : record.stage
        });
      }
    }
  } catch (_) { /* corrupt history is not worth crashing over */ }
}

function saveHistory() {
  try {
    const list = Array.from(jobs.values())
      .filter((job) => ['completed', 'error', 'cancelled'].includes(job.status))
      .slice(-100)
      .map(serialize);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(list, null, 2), 'utf-8');
  } catch (_) { /* best effort */ }
}

loadHistory();

// -------------------------------------------------------------
// Public API
// -------------------------------------------------------------
/** Strips live handles and credentials so job records stay JSON-serializable. */
function serialize(job) {
  const { torrent, driveConfig, webhookSecret, ...rest } = job;
  return {
    ...rest,
    // Never expose the user's Drive bearer token through the status API.
    hasDriveCredentials: Boolean(driveConfig?.accessToken && driveConfig?.rootFolderId),
    // Report whether the callback secret is configured, never its value.
    hasWebhookSecret: Boolean(webhookSecret)
  };
}

export function getJobs(userId = null) {
  pump();
  const all = Array.from(jobs.values());
  const filtered = userId ? all.filter((job) => job.userId === userId) : all;

  return filtered.map((job) => {
    const index = queue.findIndex((q) => q.id === job.id);
    return {
      ...serialize(job),
      queuePosition: job.status === 'queued' && index >= 0 ? index + 1 : null
    };
  }).sort((a, b) => b.createdAt - a.createdAt);
}

export function getJob(id) {
  pump();
  const job = jobs.get(id);
  // Must go through serialize(): the raw record holds a live WebTorrent handle
  // (circular, and full of internal sockets) plus credentials.
  return job ? serialize(job) : null;
}

export function clearHistory(userId = null) {
  let cleared = 0;
  for (const [id, job] of jobs.entries()) {
    if (!['completed', 'error', 'cancelled'].includes(job.status)) continue;
    if (userId && job.userId !== userId) continue;
    removeJobDir(id);
    jobs.delete(id);
    cleared += 1;
  }
  if (cleared) saveHistory();
  return cleared;
}

export function deleteJob(id) {
  const job = jobs.get(id);
  if (!job) return false;
  removeJobDir(id);
  releaseClaim(job);
  jobs.delete(id);
  saveHistory();
  return true;
}

export function cancelJob(id) {
  const job = jobs.get(id);
  if (!job) return false;

  job.cancelled = true;
  job.status = 'cancelled';
  job.stage = 'cancelled';
  job.error = 'Cancelled';
  job.updatedAt = Date.now();

  const index = queue.findIndex((q) => q.id === id);
  if (index >= 0) queue.splice(index, 1);

  const entry = active.get(id);
  if (entry) {
    if (entry.torrent) {
      try { entry.torrent.destroy({ destroyStore: false }); } catch (_) { /* already gone */ }
    }
    clearTimeout(entry.stallTimer);
    active.delete(id);
    pump();
  }

  removeJobDir(id);
  releaseClaim(job);
  saveHistory();
  return true;
}

function releaseClaim(job) {
  const hash = job.infoHash || infoHashOf(job.source);
  if (hash && claimed.get(hash) === job.id) claimed.delete(hash);
}

function removeJobDir(id) {
  try {
    const dir = path.join(DOWNLOADS_DIR, id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) { /* nothing useful to do */ }
}

/**
 * Queues an audiobook download.
 *
 * Accepts either a raw magnet/info hash or an ABB info hash plus metadata. The
 * Drive upload happens here on the node so the audio bytes never cross the
 * network twice; FRAUDIO is told the result over `webhookUrl`.
 */
export function addDownloadJob(options) {
  const id = options.id || `fra_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const infoHash = options.infoHash || infoHashOf(options.magnet) || infoHashOf(options.source) || null;

  const source = options.magnet || options.source
    || buildMagnet(options.infoHash, options.title || 'Audiobook');
  if (!source) throw new Error('A magnet URI or info hash is required');

  if (infoHash && claimed.has(infoHash)) {
    const existing = jobs.get(claimed.get(infoHash));
    if (existing && !['completed', 'error', 'cancelled'].includes(existing.status)) {
      throw new Error(`This release is already queued or downloading (job ${existing.id})`);
    }
    claimed.delete(infoHash);
  }

  const job = {
    id,
    userId: options.userId || 'default',
    source,
    infoHash,
    title: options.title || 'Audiobook',
    author: options.author || '',
    series: options.series || '',
    seriesIndex: options.seriesIndex ?? null,
    narrator: options.narrator || '',
    format: options.format || '',
    bitrate: options.bitrate || '',
    abridged: options.abridged ?? null,
    coverUrl: options.coverUrl || null,
    postUrl: options.postUrl || null,
    postId: options.postId || null,
driveConfig: options.driveConfig || null,
      webhookUrl: options.webhookUrl || null,
      webhookSecret: options.webhookSecret || options.driveConfig?.webhookSecret || null,
    status: 'queued',
    stage: 'queued',
    percent: 0,
    downloadSpeed: 0,
    numPeers: 0,
    files: [],
    results: [],
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    torrent: null,
    cancelled: false
  };

  jobs.set(id, job);
  if (infoHash) claimed.set(infoHash, id);
  queue.push(job);
  saveHistory();

  console.log(`[FraudioStreamer] Queued ${id} "${job.title}" (queue: ${queue.length})`);
  pump();
  return job;
}

/**
 * Queues a YouTube music download job (single track, playlist, or album).
 */
export function addYoutubeJob(options) {
  if (options.cookiesContent && typeof options.cookiesContent === 'string' && options.cookiesContent.trim().length > 50) {
    try {
      const dest = path.resolve('./cookies.txt');
      fs.writeFileSync(dest, options.cookiesContent.trim(), 'utf8');
      console.log('[FraudioStreamer] Synced fresh cookies.txt from download job');
    } catch (err) {
      console.warn('[FraudioStreamer] Could not sync cookies from job:', err.message);
    }
  }

  const id = options.id || `ytm_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const entries = Array.isArray(options.entries) ? options.entries.filter((e) => e && e.videoId) : [];
  if (!entries.length) throw new Error('At least one track with a valid videoId is required');

  const job = {
    id,
    userId: options.userId || 'default',
    type: 'youtube',
    title: options.title || options.album || options.artist || entries[0].title || 'Music Download',
    artist: options.artist || entries[0].artist || '',
    album: options.album || entries[0].album || 'Singles',
    entries,
    coverUrl: options.coverUrl || null,
    format: options.format || 'mp3',
    quality: options.quality || '320',
    driveConfig: options.driveConfig || null,
    webhookUrl: options.webhookUrl || null,
    webhookSecret: options.webhookSecret || options.driveConfig?.webhookSecret || null,
    status: 'queued',
    stage: 'queued',
    percent: 0,
    currentTrack: '',
    results: [],
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    cancelled: false
  };

  jobs.set(id, job);
  queue.push(job);
  saveHistory();

  console.log(`[FraudioStreamer] Queued YouTube job ${id} "${job.title}" (${entries.length} tracks, queue: ${queue.length})`);
  pump();
  return job;
}

// -------------------------------------------------------------
// Queue pump
// -------------------------------------------------------------
function pump() {
  // Purge any finished jobs lingering in the active set
  for (const [id, item] of active.entries()) {
    if (!item?.job || ['completed', 'error', 'cancelled'].includes(item.job.status)) {
      if (item?.stallTimer) clearTimeout(item.stallTimer);
      active.delete(id);
    }
  }

  while (active.size < MAX_CONCURRENT && queue.length > 0) {
    const job = queue.shift();
    if (!job || job.cancelled) continue;
    active.set(job.id, { job, torrent: null, stallTimer: null });
    const run = job.type === 'youtube' ? runYoutubePhase(job) : runDownloadPhase(job);
    run
      .then(() => {
        if (job.type === 'youtube') {
          active.delete(job.id);
          pump();
        }
      })
      .catch((err) => {
        active.delete(job.id);
        failJob(job, err);
        pump();
      });
  }
}

function update(job, patch) {
  Object.assign(job, patch, { updatedAt: Date.now() });
}

async function runDownloadPhase(job) {
  const jobDir = path.join(DOWNLOADS_DIR, job.id);
  fs.mkdirSync(jobDir, { recursive: true });

  update(job, { status: 'downloading', stage: 'downloading', percent: 1 });
  console.log(`[FraudioStreamer] Downloading ${job.id}: "${job.title}" (${job.infoHash || 'magnet'})`);

  const entry = active.get(job.id);
  if (!entry) return;

  const metadata = await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(entry.stallTimer);
      fn(arg);
    };

    let torrent;
    try {
      torrent = getClient().add(job.source, { path: jobDir });
    } catch (err) {
      reject(err);
      return;
    }

    entry.torrent = torrent;
    job.torrent = torrent;

    torrent.on('metadata', () => {
      console.log(`[FraudioStreamer] Metadata received for ${job.id}: ${torrent.files?.length || 0} file(s)`);
      const hasAudio = (torrent.files || []).some((f) => looksLikeAudioPart(f.name || f.path));
      if (!hasAudio && (torrent.files || []).length > 0) {
        finish(reject, new Error('Torrent contains no playable audio files'));
      }
    });

    torrent.on('download', () => {
      if (job.cancelled) return;
      clearTimeout(entry.stallTimer);
      entry.stallTimer = setTimeout(() => {
        finish(reject, new Error(`No download progress after 45 minutes (${torrent.numPeers} peers connected)`));
      }, 45 * 60 * 1000);
      update(job, {
        percent: Math.min(45, Math.round(torrent.progress * 45)),
        downloadSpeed: torrent.downloadSpeed,
        numPeers: torrent.numPeers
      });
    });

    torrent.on('done', () => {
      update(job, { percent: 50, downloadSpeed: 0 });
      const audio = listAudioParts(jobDir);
      if (audio.length) finish(resolve, { torrent, audio });
      else reject(new Error('Download finished but no audio files were found in the torrent'));
    });

    torrent.on('error', (err) => finish(reject, err));

    // A dead swarm is common for unpopular releases; fail fast instead of
    // leaving the job pinned in the active slot forever.
    entry.stallTimer = setTimeout(() => {
      finish(reject, new Error(`No download progress after 45 minutes (${torrent.numPeers} peers connected)`));
    }, 45 * 60 * 1000);
  });

  if (job.cancelled) return;

  const parts = metadata.audio.filter(looksLikeAudioPart);
  if (!parts.length) throw new Error('No playable audio files found in the completed download');

  update(job, {
    status: 'uploading',
    stage: 'uploading',
    files: parts.map((p) => path.basename(p))
  });

  // Release the download slot before uploading so the next torrent can start.
  const torrent = entry.torrent;
  clearTimeout(entry.stallTimer);
  active.delete(job.id);
  if (torrent) {
    try { torrent.destroy({ destroyStore: false }); } catch (_) { /* best effort */ }
  }
  job.torrent = null;
  pump();

  await runUploadPhase(job, parts);
}

// -------------------------------------------------------------
// Upload phase
// -------------------------------------------------------------
/**
 * Asks FRAUDIO for a fresh Drive access token. Downloads easily exceed the
 * 1-hour token lifetime, so the upload phase calls this first and again on any
 * 401 from Drive. Updates `driveConfig.accessToken` in place.
 */
export async function refreshDriveToken(job) {
  const driveConfig = job?.driveConfig;
  if (!driveConfig?.tokenRefreshUrl) return null;
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (driveConfig.webhookSecret) headers['x-node-secret'] = driveConfig.webhookSecret;
    const res = await fetch(driveConfig.tokenRefreshUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ userId: job.userId })
    });
    if (!res.ok) {
      console.warn(`[FraudioStreamer] Token refresh returned HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    if (data.accessToken) {
      driveConfig.accessToken = data.accessToken;
      return data.accessToken;
    }
  } catch (err) {
    console.warn('[FraudioStreamer] Token refresh failed:', err.message);
  }
  return null;
}

async function runUploadPhase(job, parts) {
  const driveConfig = job.driveConfig;
  if (!driveConfig?.accessToken || !driveConfig?.rootFolderId) {
    throw new Error('Missing Google Drive credentials for upload');
  }

  // Downloads easily exceed the 1-hour access token lifetime, so always start
  // this phase with a fresh token.
  const refreshToken = () => refreshDriveToken(job);

  await refreshToken();

  const { folderId, drivePath } = await resolveAudiobookFolder(
    driveConfig.accessToken,
    driveConfig.rootFolderId,
    { author: job.author, series: job.series },
    refreshToken
  );

  const results = [];
  const multi = parts.length > 1;

  for (let i = 0; i < parts.length; i += 1) {
    if (job.cancelled) return;

    const sourcePath = parts[i];
    const baseName = path.basename(sourcePath);
    const sizeBytes = fs.statSync(sourcePath).size;
    // For multi-book torrents keep the part ordering visible in the file name.
    const fileName = multi
      ? `${String(i + 1).padStart(2, '0')} - ${sanitizeName(baseName)}`
      : sanitizeName(baseName);

    const span = 45 / parts.length;
    const base = 50 + i * span;

    update(job, {
      stage: multi ? `uploading ${i + 1} of ${parts.length}` : 'uploading',
      message: `Uploading ${fileName} to Google Drive…`,
      percent: Math.round(base)
    });

    const uploaded = await uploadFileToGoogleDrive(
      sourcePath,
      fileName,
      folderId,
      driveConfig.accessToken,
      (pct) => update(job, { percent: Math.round(base + (span * pct) / 100) }),
      refreshToken
    );

    results.push({
      fileName,
      driveFileId: uploaded.id,
      driveFolderId: folderId,
      drivePath: `${drivePath} / ${fileName}`,
      sizeBytes,
      partIndex: multi ? i : null,
      partTotal: multi ? parts.length : null
    });

    console.log(`[FraudioStreamer] ${job.id} uploaded "${fileName}" -> ${uploaded.id}`);
  }

  // Cover art is optional; a failure here must not fail the whole job.
  let coverUploaded = false;
  if (job.coverUrl) {
    try {
      const coverLocal = await fetchCover(job.coverUrl, path.join(DOWNLOADS_DIR, job.id, 'cover.jpg'));
      if (coverLocal) {
        await uploadCover(coverLocal, 'cover.jpg', folderId, driveConfig.accessToken, refreshToken);
        coverUploaded = true;
      }
    } catch (err) {
      console.warn(`[FraudioStreamer] ${job.id} cover upload skipped:`, err.message);
    }
  }

  update(job, {
    status: 'completed',
    stage: 'completed',
    percent: 100,
    message: `Uploaded ${results.length} file${results.length === 1 ? '' : 's'} to ${drivePath}`,
    results,
    coverUploaded
  });

  removeJobDir(job.id);
  releaseClaim(job);
  saveHistory();

  await notify(job, { status: 'completed', results, drivePath, coverUploaded });
}

async function runYoutubePhase(job) {
  const driveConfig = job.driveConfig;
  if (!driveConfig?.accessToken || !driveConfig?.rootFolderId) {
    throw new Error('Missing Google Drive credentials for music upload');
  }

  const jobDir = path.join(DOWNLOADS_DIR, job.id);
  fs.mkdirSync(jobDir, { recursive: true });

  update(job, { status: 'downloading', stage: 'starting', percent: 2, message: 'Starting YouTube download...' });

  const refreshToken = () => refreshDriveToken(job);
  await refreshToken();

  const { folderId, drivePath } = await resolveMusicFolder(
    driveConfig.accessToken,
    driveConfig.rootFolderId,
    job.artist || 'Unknown Artist',
    job.album || 'Singles',
    refreshToken
  );

  const entries = job.entries || [];
  const results = [];
  const total = entries.length;
  let lastError = null;

  for (let i = 0; i < total; i += 1) {
    if (job.cancelled) return;
    const entry = entries[i];
    const trackNum = entry.trackNumber || i + 1;
    const trackTitle = entry.title || `Track ${trackNum}`;

    const span = 90 / total;
    const base = 5 + i * span;

    update(job, {
      status: 'downloading',
      stage: `downloading ${i + 1} of ${total}`,
      currentTrack: trackTitle,
      message: `Downloading "${trackTitle}"...`,
      percent: Math.round(base)
    });

    const trackDir = path.join(jobDir, String(i + 1).padStart(2, '0'));
    fs.mkdirSync(trackDir, { recursive: true });

    let dl;
    try {
      dl = await downloadYoutubeTrack(entry, {
        destDir: trackDir,
        format: job.format,
        quality: job.quality
      });
    } catch (err) {
      lastError = err.message;
      console.warn(`[FraudioStreamer] Failed to download "${trackTitle}":`, err.message);
      continue;
    }

    if (job.cancelled) return;

    const ext = dl.ext || 'mp3';
    const uploadName = `${String(trackNum).padStart(2, '0')} ${sanitizeName(trackTitle)}.${ext}`;

    update(job, {
      status: 'uploading',
      stage: `uploading ${i + 1} of ${total}`,
      currentTrack: trackTitle,
      message: `Uploading "${uploadName}" to Google Drive...`,
      percent: Math.round(base + span * 0.5)
    });

    // Overwrite existing file to prevent duplicates
    await deleteFileByName(driveConfig.accessToken, folderId, uploadName, refreshToken).catch(() => {});

    const uploaded = await uploadFileToGoogleDrive(
      dl.localPath,
      uploadName,
      folderId,
      driveConfig.accessToken,
      (pct) => update(job, { percent: Math.round(base + span * 0.5 + (span * 0.5 * pct) / 100) }),
      refreshToken
    );

    const sizeBytes = fs.existsSync(dl.localPath) ? fs.statSync(dl.localPath).size : 0;

    results.push({
      videoId: entry.videoId,
      fileName: uploadName,
      title: trackTitle,
      artist: entry.artist || job.artist || 'Unknown Artist',
      album: entry.album || job.album || 'Singles',
      trackNumber: trackNum,
      durationSec: entry.durationSec || null,
      format: ext.toUpperCase(),
      driveFileId: uploaded.id,
      driveFolderId: folderId,
      drivePath: `${drivePath} / ${uploadName}`,
      sizeBytes
    });

    console.log(`[FraudioStreamer] ${job.id} uploaded track "${uploadName}" -> ${uploaded.id}`);

    try { fs.rmSync(trackDir, { recursive: true, force: true }); } catch (_) {}
  }

  if (!results.length && total > 0) {
    throw new Error(lastError ? `All tracks failed to download (yt-dlp: ${lastError})` : 'All tracks in this YouTube download failed to download.');
  }

  // Cover art upload if provided
  let coverUploaded = false;
  if (job.coverUrl) {
    try {
      const coverLocal = await fetchCover(job.coverUrl, path.join(DOWNLOADS_DIR, job.id, 'cover.jpg'));
      if (coverLocal) {
        await uploadCover(coverLocal, 'cover.jpg', folderId, driveConfig.accessToken, refreshToken);
        coverUploaded = true;
      }
    } catch (err) {
      console.warn(`[FraudioStreamer] ${job.id} cover upload skipped:`, err.message);
    }
  }

  update(job, {
    status: 'completed',
    stage: 'completed',
    percent: 100,
    message: `Uploaded ${results.length} track${results.length === 1 ? '' : 's'} to ${drivePath}`,
    results,
    coverUploaded
  });

  removeJobDir(job.id);
  saveHistory();

  active.delete(job.id);
  pump();

  await notify(job, { status: 'completed', type: 'youtube', results, drivePath, coverUploaded });
}

async function fetchCover(url, destPath) {
  const res = await fetch(url, { headers: { 'User-Agent': 'fraudio-streamer/1.0' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) return null;
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.startsWith('image/')) return null;
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!bytes.length) return null;
  fs.writeFileSync(destPath, bytes);
  return destPath;
}

function failJob(job, err) {
  if (job.cancelled) return;
  const entry = active.get(job.id);
  if (entry) clearTimeout(entry.stallTimer);
  active.delete(job.id);

  update(job, {
    status: 'error',
    stage: 'error',
    error: err.message,
    message: err.message
  });

  console.error(`[FraudioStreamer] Job ${job.id} failed:`, err.message);
  removeJobDir(job.id);
  releaseClaim(job);
  saveHistory();
  notify(job, { status: 'error', error: err.message });
}

/**
 * Posts job state back to FRAUDIO. `job.webhookSecret` is the shared secret the
 * FRAUDIO host verifies in its x-node-secret header.
 */
export async function notify(job, payload) {
  if (!job.webhookUrl) return;
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (job.webhookSecret) headers['x-node-secret'] = job.webhookSecret;
    const res = await fetch(job.webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jobId: job.id, userId: job.userId, ...payload })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[FraudioStreamer] Webhook to ${job.webhookUrl} returned ${res.status} for ${job.id}: ${body.slice(0, 200)}`);
    }
  } catch (err) {
    console.warn(`[FraudioStreamer] Webhook to ${job.webhookUrl} failed for ${job.id}:`, err.message);
  }
}

// -------------------------------------------------------------
// Orphan cleanup
// -------------------------------------------------------------
export function cleanupOrphanedDownloads() {
  try {
    if (!fs.existsSync(DOWNLOADS_DIR)) return;
    const now = Date.now();
    for (const entry of fs.readdirSync(DOWNLOADS_DIR)) {
      const full = path.join(DOWNLOADS_DIR, entry);
      try {
        if (!fs.statSync(full).isDirectory()) continue;
      } catch (_) { continue; }

      const isActive = active.has(entry) || queue.some((j) => j.id === entry);
      if (isActive) continue;

      const record = jobs.get(entry);
      const finished = record && ['completed', 'error', 'cancelled'].includes(record.status);
      let stale = false;
      if (!finished) {
        try { stale = now - fs.statSync(full).mtimeMs > ORPHAN_MAX_AGE_MS; } catch (_) { stale = false; }
      }

      if (finished || stale) {
        try {
          fs.rmSync(full, { recursive: true, force: true });
          console.log(`[FraudioStreamer] Removed ${finished ? 'finished' : 'orphaned'} job dir: ${entry}`);
        } catch (err) {
          console.warn(`[FraudioStreamer] Could not remove ${entry}:`, err.message);
        }
      }
    }
  } catch (err) {
    console.warn('[FraudioStreamer] Orphan cleanup failed:', err.message);
  }
}

export function nodeStatus() {
  pump();
  return {
    activeCount: active.size,
    queuedCount: queue.length,
    maxConcurrent: MAX_CONCURRENT,
    tools: toolsStatus(),
    activeJobs: Array.from(active.values()).map((e) => ({
      id: e.job.id,
      title: e.job.title,
      type: e.job.type || 'torrent',
      stage: e.job.stage,
      currentTrack: e.job.currentTrack || null,
      percent: e.job.percent,
      numPeers: e.job.numPeers || 0,
      downloadSpeed: e.job.downloadSpeed || 0
    }))
  };
}

setTimeout(cleanupOrphanedDownloads, 5000);
setInterval(cleanupOrphanedDownloads, 30 * 60 * 1000);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (client) {
      try { client.destroy(); } catch (_) { /* best effort */ }
    }
    process.exit(0);
  });
}