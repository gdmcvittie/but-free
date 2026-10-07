// =============================================================================
// GAME DOWNLOAD MANAGER (additive module for FREEPLAY / games.butfree.online)
//
// Completely independent pipeline for PC game torrents (FitGirl repacks),
// retro ROM torrents, and direct HTTP downloads (itch.io / GOG installers).
// It uses its OWN WebTorrent client, OWN queues, OWN history file and OWN
// temp directory so it cannot interfere with the TV / Fraudio pipelines.
//
// Ports the download engine concepts from my-games-server
// (runTorrentQueue / startDirectFileDownloadStream) to this node, with the
// finished files uploaded into the user's Google Drive Games folder.
// =============================================================================

import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';
import WebTorrent from 'webtorrent';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { uploadFileToGoogleDrive, findOrCreateFolder } from './driveUploader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GAME_DOWNLOADS_DIR = path.join(process.cwd(), 'downloads-games');
const HISTORY_FILE = path.join(process.cwd(), 'download_history_games.json');
if (!fs.existsSync(GAME_DOWNLOADS_DIR)) fs.mkdirSync(GAME_DOWNLOADS_DIR, { recursive: true });

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 butfree-games/1.0';

let wtClient = null;
function getGameTorrentClient() {
  if (!wtClient) {
    wtClient = new WebTorrent({ dht: true, maxConns: 80, tracker: true });
    wtClient.on('error', (err) => {
      console.warn('[GameDownloadManager] WebTorrent client error:', err?.message || err);
    });
  }
  return wtClient;
}

const jobs = new Map();

const gameQueue = [];
let activeGameJob = null;

const directQueue = [];
let activeDirectJob = null;

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
      if (Array.isArray(data)) {
        for (const item of data) {
          if (item.status === 'active' || item.stage === 'downloading' || item.stage === 'uploading') {
            item.status = 'queued';
            item.stage = 'queued';
            item.updatedAt = Date.now();
          }
          jobs.set(item.id, item);
        }
      }
    }
  } catch (_) {}
}

function saveHistory() {
  try {
    const list = Array.from(jobs.values())
      .slice(-200)
      .map(({ torrent, abortController, __gameResolveAttempted, ...rest }) => rest);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(list, null, 2), 'utf-8');
  } catch (_) {}
}

loadHistory();

// -------------------------------------------------------------
// Public API
// -------------------------------------------------------------

export function addGameTorrentJob(options) {
  const source = options.magnet || options.url || options.torrent;
  if (!source) throw new Error('A magnet URI or .torrent URL is required');

  const id = `gme_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const job = baseJob(id, options, 'game-torrent');
  job.source = String(source).trim().replace(/&#038;/g, '&').replace(/&amp;/gi, '&');
  job.selectedFiles = Array.isArray(options.selectedFiles) && options.selectedFiles.length > 0
    ? options.selectedFiles
    : null;

  jobs.set(id, job);
  gameQueue.push(job);
  saveHistory();
  console.log(`[GameDownloadManager] Queued game torrent ${id}: "${job.title}"`);
  pumpGameQueue();
  return job;
}

export function addDirectDownloadJob(options) {
  const url = options.url || options.directUrl;
  if (!url || !/^https?:\/\//i.test(String(url))) {
    throw new Error('A valid http(s) direct download URL is required');
  }

  const id = `gdl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const job = baseJob(id, options, 'game-direct');
  job.directUrl = String(url).trim();
  job.headers = options.headers && typeof options.headers === 'object' ? options.headers : null;
  job.fileNameHint = options.fileName || null;

  jobs.set(id, job);
  directQueue.push(job);
  saveHistory();
  console.log(`[GameDownloadManager] Queued direct download ${id}: "${job.title}"`);
  pumpDirectQueue();
  return job;
}

function baseJob(id, options, kind) {
  return {
    id,
    kind,
    userId: options.userId || 'default',
    title: options.title || 'Game Download',
    meta: options.meta || {},
    subfolder: options.subfolder || options.meta?.subfolder || options.driveConfig?.subfolder || null,
    driveConfig: options.driveConfig || null,
    webhookUrl: options.webhookUrl || null,
    status: 'queued',
    stage: 'queued',
    downloadPercent: 0,
    downloadSpeed: 0,
    numPeers: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    uploadPercent: 0,
    driveFileId: null,
    driveFolderId: null,
    uploadedFiles: null,
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}

export function getJobs(userId = null) {
  const all = Array.from(jobs.values()).sort((a, b) => b.createdAt - a.createdAt);
  return (userId ? all.filter(j => j.userId === userId) : all).map(j => {
    let queuePosition = null;
    let queueType = null;
    if (j.stage === 'queued') {
      const gIdx = gameQueue.findIndex(q => q.id === j.id);
      const dIdx = directQueue.findIndex(q => q.id === j.id);
      if (gIdx >= 0) { queuePosition = gIdx + 1; queueType = 'game-torrent'; }
      else if (dIdx >= 0) { queuePosition = dIdx + 1; queueType = 'direct'; }
    }
    return {
      id: j.id,
      userId: j.userId,
      title: j.title,
      kind: j.kind,
      status: j.status,
      stage: j.stage,
      downloadPercent: j.downloadPercent,
      downloadSpeed: j.downloadSpeed,
      numPeers: j.numPeers,
      downloadedBytes: j.downloadedBytes,
      totalBytes: j.totalBytes,
      uploadPercent: j.uploadPercent,
      fileName: j.fileName || null,
      subfolder: j.subfolder || null,
      driveFileId: j.driveFileId,
      driveFolderId: j.driveFolderId,
      uploadedCount: j.uploadedFiles ? j.uploadedFiles.length : null,
      error: j.error,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
      queuePosition,
      queueType
    };
  });
}

export function getJob(id) {
  return jobs.get(id) || null;
}

export function cancelJob(id) {
  const job = jobs.get(id);
  if (!job) return false;

  console.log(`[GameDownloadManager] Cancelling job ${id} (stage: ${job.stage})...`);
  job.cancelled = true;
  job.status = 'cancelled';
  job.stage = 'cancelled';
  job.updatedAt = Date.now();

  const gIdx = gameQueue.findIndex(q => q.id === id);
  if (gIdx >= 0) gameQueue.splice(gIdx, 1);
  const dIdx = directQueue.findIndex(q => q.id === id);
  if (dIdx >= 0) directQueue.splice(dIdx, 1);

  if (activeGameJob && activeGameJob.id === id) {
    if (job.torrent) { try { job.torrent.destroy(); } catch (_) {} }
    activeGameJob = null;
    setImmediate(pumpGameQueue);
  }
  if (activeDirectJob && activeDirectJob.id === id) {
    if (job.abortController) { try { job.abortController.abort(); } catch (_) {} }
    activeDirectJob = null;
    setImmediate(pumpDirectQueue);
  }

  cleanupJobDir(id);
  saveHistory();
  return true;
}

export function deleteJob(id) {
  if (!jobs.has(id)) return false;
  cancelJob(id);
  jobs.delete(id);
  saveHistory();
  return true;
}

export function clearHistory(userId = null) {
  let cleared = 0;
  for (const [id, job] of jobs.entries()) {
    if (['completed', 'cancelled', 'error'].includes(job.status) && (!userId || job.userId === userId)) {
      cleanupJobDir(id);
      jobs.delete(id);
      cleared++;
    }
  }
  if (cleared > 0) saveHistory();
  return cleared;
}

// Inspect a torrent's file list without downloading anything (metadata only).
export function inspectTorrent(rawUrl, timeoutMs = 25000) {
  const cleanUrl = String(rawUrl || '').trim().replace(/&#038;/g, '&').replace(/&amp;/gi, '&');
  if (!cleanUrl) return Promise.reject(new Error('Missing torrent url/magnet'));

  const wt = getGameTorrentClient();
  let tempTorrent = null;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      destroyQuietly(tempTorrent);
      reject(new Error('Timed out fetching torrent metadata from DHT/trackers (peer discovery took too long)'));
    }, timeoutMs);

    const emitMetadata = () => {
      clearTimeout(timer);
      const files = (tempTorrent.files || []).map((f, i) => ({
        index: i,
        name: f.name,
        path: f.path,
        length: f.length
      }));
      const result = {
        success: true,
        name: tempTorrent.name,
        infoHash: tempTorrent.infoHash,
        totalBytes: tempTorrent.length,
        files
      };
      destroyQuietly(tempTorrent);
      tempTorrent = null;
      resolve(result);
    };

    try {
      tempTorrent = wt.add(cleanUrl, {
        path: path.join(GAME_DOWNLOADS_DIR, '_inspect'),
        deselect: true
      });
    } catch (err) {
      clearTimeout(timer);
      return reject(err);
    }

    if (tempTorrent.files && tempTorrent.files.length > 0) {
      emitMetadata();
    } else {
      tempTorrent.once('metadata', emitMetadata);
      tempTorrent.once('error', (err) => {
        clearTimeout(timer);
        destroyQuietly(tempTorrent);
        reject(err);
      });
    }
  });
}

export function gameNodeStatus() {
  return {
    gameQueueLength: gameQueue.length,
    directQueueLength: directQueue.length,
    activeGame: activeGameJob ? activeGameJob.id : null,
    activeDirect: activeDirectJob ? activeDirectJob.id : null,
    totalJobs: jobs.size
  };
}

// -------------------------------------------------------------
// Game torrent pipeline
// -------------------------------------------------------------

function pumpGameQueue() {
  if (activeGameJob !== null) return;

  while (gameQueue.length > 0) {
    const nextJob = gameQueue.shift();
    if (nextJob.cancelled) continue;
    activeGameJob = nextJob;
    runGameTorrentPhase(nextJob)
      .then(() => {
        activeGameJob = null;
        pumpGameQueue();
      })
      .catch((err) => {
        activeGameJob = null;
        handleJobError(nextJob, err);
        pumpGameQueue();
      });
    break;
  }
}

async function runGameTorrentPhase(job) {
  const wt = getGameTorrentClient();
  const jobDir = path.join(GAME_DOWNLOADS_DIR, job.id);
  if (!fs.existsSync(jobDir)) fs.mkdirSync(jobDir, { recursive: true });

  job.status = 'active';
  job.stage = 'downloading';
  job.updatedAt = Date.now();
  saveHistory();

  console.log(`[GameDownloadManager] Downloading game torrent ${job.id}: "${job.title}"`);

  const hasSelection = Array.isArray(job.selectedFiles) && job.selectedFiles.length > 0;
  const selSet = hasSelection
    ? new Set(job.selectedFiles.map(p => String(p).toLowerCase().replace(/\\/g, '/')))
    : null;

  const torrent = await new Promise((resolve, reject) => {
    if (job.cancelled) return reject(new Error('Job cancelled'));

    const t = wt.add(job.source, { path: jobDir, deselect: hasSelection }, (tt) => {
      job.torrent = tt;
      let selectedTotal = tt.length;

      if (hasSelection) {
        selectedTotal = 0;
        tt.files.forEach((f) => {
          const p = f.path.toLowerCase().replace(/\\/g, '/');
          const n = f.name.toLowerCase();
          if (selSet.has(p) || selSet.has(n)) {
            f.select();
            selectedTotal += f.length;
          } else {
            f.deselect();
          }
        });
      }

      job.totalBytes = selectedTotal || tt.length || 0;
      job.updatedAt = Date.now();

      const report = () => {
        if (job.cancelled) return;
        job.downloadPercent = job.totalBytes > 0
          ? Math.min(100, Math.round((tt.downloaded / job.totalBytes) * 100))
          : Math.round((tt.progress || 0) * 100);
        job.downloadSpeed = tt.downloadSpeed || 0;
        job.numPeers = tt.numPeers || 0;
        job.downloadedBytes = tt.downloaded || 0;
        job.updatedAt = Date.now();
        if (job.downloadPercent >= 100 && !job.__gameResolveAttempted) {
          job.__gameResolveAttempted = true;
          resolve(tt);
        }
      };

      tt.on('download', report);
      tt.on('torrent', report);
      tt.on('done', () => {
        job.downloadPercent = 100;
        resolve(tt);
      });
      tt.on('error', (err) => reject(err));
      setTimeout(report, 1500);
    });

    t.on('error', (err) => reject(err));
  });

  if (job.cancelled) throw new Error('Job cancelled');

  job.files = (torrent.files || [])
    .filter(f => !hasSelection || selSet.has(f.path.toLowerCase().replace(/\\/g, '/')) || selSet.has(f.name.toLowerCase()))
    .map(f => ({ path: f.path, length: f.length }));

  destroyQuietly(torrent);

  console.log(`[GameDownloadManager] Game torrent download finished for ${job.id}: "${job.title}" (${job.files?.length || 0} files). Uploading to Drive...`);

  await uploadGameTreeToDrive(job);
  cleanupJobDir(job.id);
}

// -------------------------------------------------------------
// Direct HTTP download pipeline
// -------------------------------------------------------------

function pumpDirectQueue() {
  if (activeDirectJob !== null) return;

  while (directQueue.length > 0) {
    const nextJob = directQueue.shift();
    if (nextJob.cancelled) continue;
    activeDirectJob = nextJob;
    runDirectPhase(nextJob)
      .then(() => {
        activeDirectJob = null;
        pumpDirectQueue();
      })
      .catch((err) => {
        activeDirectJob = null;
        handleJobError(nextJob, err);
        pumpDirectQueue();
      });
    break;
  }
}

const execFileAsync = promisify(execFile);
const FF_RESOLVER_PY = fs.existsSync(path.join(__dirname, 'ffResolver.py'))
  ? path.join(__dirname, 'ffResolver.py')
  : path.join(process.cwd(), 'ffResolver.py');

export function isFuckingFastUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return url.toLowerCase().includes('fuckingfast.co');
}

export function isFuckingFastDirectUrl(url) {
  if (!isFuckingFastUrl(url)) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const isDirectHost = host.startsWith('dl.') || host.includes('dl.fuckingfast');
    return isDirectHost && parsed.pathname.includes('/dl/');
  } catch (_) {
    return url.includes('dl.fuckingfast.co') && url.includes('/dl/');
  }
}

export function isFuckingFastLandingPage(url) {
  if (!isFuckingFastUrl(url)) return false;
  return !isFuckingFastDirectUrl(url);
}

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
      console.log(`[Downloader/FuckingFast] using "${cand}" (curl_cffi) for direct-link resolution`);
      return cand;
    } catch (_) { /* try next candidate */ }
  }
  ffPythonProbe = false;
  return false;
}

export async function resolveFuckingFastUrl(url) {
  if (!isFuckingFastUrl(url) || isFuckingFastDirectUrl(url)) return url;
  const cleanUrl = url.split('#')[0];
  const py = await findFuckingFastPython();
  if (py && fs.existsSync(FF_RESOLVER_PY)) {
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
        return direct;
      }
      if (line && line.startsWith('BLOCKED:')) {
        throw new Error(line.slice(line.indexOf(':') + 1).trim());
      }
    } catch (err) {
      console.warn(`[Downloader/FuckingFast] python resolver error: ${err.message}`);
    }
  }

  // Fallback: try basic HTMX POST to /f/{id}/go
  const fileId = cleanUrl.split('#')[0].split('?')[0].split('/').filter(Boolean).pop();
  if (!fileId) throw new Error('Could not parse file ID from FuckingFast URL');

  try {
    const res = await fetch(`https://fuckingfast.co/f/${fileId}/go`, {
      method: 'POST',
      headers: {
        'User-Agent': BROWSER_UA,
        'Referer': cleanUrl,
        'Origin': 'https://fuckingfast.co',
        'HX-Request': 'true'
      },
      redirect: 'manual'
    });
    const redirectUrl = res.headers.get('hx-redirect') ||
                        res.headers.get('hx-location') ||
                        res.headers.get('location');
    if (redirectUrl && isFuckingFastDirectUrl(redirectUrl)) {
      return redirectUrl.trim();
    }
  } catch (_) {}

  return url;
}

async function runDirectPhase(job) {
  job.status = 'active';
  job.stage = 'downloading';
  job.updatedAt = Date.now();
  saveHistory();

  console.log(`[GameDownloadManager] Direct download starting ${job.id}: "${job.title}" -> ${String(job.directUrl).slice(0, 90)}...`);

  // Auto-resolve FuckingFast landing page if not already resolved
  if (isFuckingFastLandingPage(job.directUrl)) {
    try {
      const resolved = await resolveFuckingFastUrl(job.directUrl);
      if (isFuckingFastDirectUrl(resolved)) {
        console.log(`[GameDownloadManager] Resolved FuckingFast landing page to: ${resolved}`);
        job.directUrl = resolved;
      }
    } catch (err) {
      console.warn(`[GameDownloadManager] Could not pre-resolve FuckingFast URL: ${err.message}`);
    }
  }

  const savedPath = await streamDirectToFile(job);
  if (job.cancelled) throw new Error('Job cancelled');

  job.fileName = path.basename(savedPath);
  console.log(`[GameDownloadManager] Direct download finished for ${job.id}: ${job.fileName}. Uploading to Drive...`);

  await uploadGameTreeToDrive(job, [savedPath]);
  cleanupJobDir(job.id);
}

function sanitizeFilename(name) {
  return String(name || 'download')
    .replace(/[/\\?%*:|"<>]/g, '_')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
}

function streamDirectToFile(job, redirectsLeft = 6) {
  return new Promise((resolve, reject) => {
    if (job.cancelled) return reject(new Error('Job cancelled'));
    if (redirectsLeft <= 0) return reject(new Error('Too many HTTP redirects'));

    let parsedUrl;
    try {
      parsedUrl = new URL(job.directUrl);
    } catch (_) {
      return reject(new Error('Invalid direct download URL'));
    }

    const transport = parsedUrl.protocol === 'https:' ? https : http;
    const reqHeaders = { 'User-Agent': BROWSER_UA, 'Accept': '*/*' };
    if (parsedUrl.hostname.includes('fuckingfast.co')) {
      reqHeaders['Referer'] = 'https://fuckingfast.co/';
    }
    if (job.headers) Object.assign(reqHeaders, job.headers);

    const req = transport.get(parsedUrl, { headers: reqHeaders, timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        job.directUrl = new URL(res.headers.location, parsedUrl).href;
        return resolve(streamDirectToFile(job, redirectsLeft - 1));
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        const httpError = new Error(`Server returned HTTP ${res.statusCode}: ${res.statusMessage || ''}`);
        httpError.statusCode = res.statusCode;
        return reject(httpError);
      }

      const contentType = (res.headers['content-type'] || '').toLowerCase();
      const contentLength = parseInt(res.headers['content-length'], 10) || 0;
      if (contentType.includes('text/html') && contentLength < 500000) {
        res.resume();
        const htmlError = new Error('Received HTML webpage instead of downloadable file (link may have expired or requires a fresh link)');
        htmlError.statusCode = 404;
        return reject(htmlError);
      }

      let finalFilename = '';
      const cd = res.headers['content-disposition'];
      if (cd) {
        const match = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)["']?/i);
        if (match && match[1]) {
          try { finalFilename = decodeURIComponent(match[1]); } catch (_) { finalFilename = match[1]; }
        }
      }
      if (!finalFilename || finalFilename.length < 3 || finalFilename === 'download') {
        finalFilename = job.fileNameHint || '';
      }
      if (!finalFilename || finalFilename.length < 3 || finalFilename === 'download') {
        const cleanPath = parsedUrl.pathname.split('#')[0].split('?')[0];
        const lastPart = cleanPath.substring(cleanPath.lastIndexOf('/') + 1);
        if (lastPart && lastPart.length >= 3) {
          try { finalFilename = decodeURIComponent(lastPart); } catch (_) { finalFilename = lastPart; }
        }
      }
      if (!finalFilename || finalFilename.length < 3) {
        finalFilename = String(job.title || 'game_download').replace(/[^a-zA-Z0-9_-]/g, '_') + '.zip';
      }
      finalFilename = sanitizeFilename(finalFilename);

      const jobDir = path.join(GAME_DOWNLOADS_DIR, job.id);
      if (!fs.existsSync(jobDir)) fs.mkdirSync(jobDir, { recursive: true });
      const destPath = path.join(jobDir, finalFilename);
      const partPath = `${destPath}.part`;

      job.fileName = finalFilename;
      job.totalBytes = contentLength || job.totalBytes || 0;

      const fileStream = fs.createWriteStream(partPath);
      let downloadedBytes = 0;
      let lastReport = Date.now();
      let lastBytes = 0;

      res.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        const now = Date.now();
        if (now - lastReport >= 500) {
          job.downloadedBytes = downloadedBytes;
          job.downloadSpeed = (downloadedBytes - lastBytes) / ((now - lastReport) / 1000);
          job.downloadPercent = job.totalBytes > 0
            ? Math.min(100, Math.round((downloadedBytes / job.totalBytes) * 100))
            : job.downloadPercent;
          job.updatedAt = Date.now();
          lastReport = now;
          lastBytes = downloadedBytes;
        }
      });

      fileStream.on('error', (err) => {
        try { fs.unlinkSync(partPath); } catch (_) {}
        reject(err);
      });

      fileStream.on('finish', () => {
        try {
          if (fs.existsSync(partPath)) fs.renameSync(partPath, destPath);
        } catch (renameErr) {
          return reject(renameErr);
        }
        job.downloadedBytes = downloadedBytes;
        job.downloadPercent = 100;
        resolve(destPath);
      });

      job.abortController = {
        abort: () => {
          try { req.destroy(); } catch (_) {}
          try { fileStream.destroy(); } catch (_) {}
          try { if (fs.existsSync(partPath)) fs.unlinkSync(partPath); } catch (_) {}
        }
      };

      res.pipe(fileStream);
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Direct download connection timed out'));
    });
  });
}

// -------------------------------------------------------------
// Google Drive upload (shared by both pipelines)
// -------------------------------------------------------------

async function resolveToken(job) {
  if (job.driveConfig?.tokenRefreshUrl && job.userId) {
    try {
      const rfRes = await fetch(job.driveConfig.tokenRefreshUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: job.userId })
      });
      if (rfRes.ok) {
        const rfData = await rfRes.json();
        if (rfData.accessToken) {
          job.driveConfig.accessToken = rfData.accessToken;
          return rfData.accessToken;
        }
      }
    } catch (err) {
      console.warn(`[GameDownloadManager] Token refresh note for ${job.id}:`, err.message);
    }
  }
  return job.driveConfig?.accessToken || null;
}

async function uploadGameTreeToDrive(job, onlyFiles = null) {
  if (!job.driveConfig || !job.driveConfig.accessToken || !job.driveConfig.rootFolderId) {
    throw new Error('Missing Google Drive configuration for game upload');
  }

  const jobDir = path.join(GAME_DOWNLOADS_DIR, job.id);
  const refreshToken = () => resolveToken(job);

  job.status = 'active';
  job.stage = 'uploading';
  job.uploadPercent = 0;
  job.updatedAt = Date.now();
  saveHistory();

  // Long downloads can exceed the 1h Google token TTL - always refresh first.
  await refreshToken();

  let targetFolderId = job.driveConfig.rootFolderId;
  const subParts = String(job.subfolder || '').split(/[\\/]+/).filter(Boolean);
  for (const part of subParts) {
    targetFolderId = await findOrCreateFolder(
      job.driveConfig.accessToken,
      targetFolderId,
      part,
      refreshToken
    );
  }
  job.driveFolderId = targetFolderId;

  const fileList = onlyFiles || listDownloadFiles(jobDir);
  if (fileList.length === 0) {
    throw new Error('No downloaded files found to upload for this game job');
  }

  fileList.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);

  const uploaded = [];
  let mainFileId = null;
  let largestSize = -1;

  for (let i = 0; i < fileList.length; i++) {
    if (job.cancelled) throw new Error('Job cancelled');
    const filePath = fileList[i];
    const relDir = path.relative(jobDir, path.dirname(filePath));

    let destFolder = targetFolderId;
    for (const sub of relDir.split(path.sep).filter(Boolean)) {
      destFolder = await findOrCreateFolder(
        job.driveConfig.accessToken,
        destFolder,
        sub,
        refreshToken
      );
    }

    const sizeBytes = fs.statSync(filePath).size;
    const driveFile = await uploadFileToGoogleDrive(
      filePath,
      path.basename(filePath),
      destFolder,
      job.driveConfig.accessToken,
      (pct) => {
        if (job.cancelled) return;
        job.uploadPercent = Math.min(99, Math.round(((i + pct / 100) / fileList.length) * 100));
        job.updatedAt = Date.now();
      },
      refreshToken
    );

    uploaded.push({ name: path.basename(filePath), fileId: driveFile.id, size: sizeBytes, relDir });
    if (sizeBytes > largestSize) {
      largestSize = sizeBytes;
      mainFileId = driveFile.id;
    }
    job.driveFileId = mainFileId;
    job.uploadedFiles = uploaded;
    job.updatedAt = Date.now();
    saveHistory();
  }

  job.uploadPercent = 100;
  job.status = 'completed';
  job.stage = 'completed';
  job.updatedAt = Date.now();
  saveHistory();

  console.log(`[GameDownloadManager] Job ${job.id} completed: uploaded ${uploaded.length} file(s) to Drive.`);

  await notifyWebhook(job, {
    success: true,
    status: 'completed',
    fileName: job.fileName || (uploaded[0] && uploaded[0].name) || job.title,
    fileId: mainFileId,
    folderId: targetFolderId,
    subfolder: job.subfolder,
    uploadedCount: uploaded.length
  });
}

async function notifyWebhook(job, payload) {
  if (!job.webhookUrl) return;
  try {
    await fetch(job.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobId: job.id,
        userId: job.userId,
        kind: job.kind,
        title: job.title,
        meta: job.meta,
        ...payload
      })
    });
  } catch (err) {
    console.warn(`[GameDownloadManager] Webhook failed for ${job.id}:`, err.message);
  }
}

function handleJobError(job, err) {
  if (job.cancelled) return;
  console.error(`[GameDownloadManager] Job ${job.id} failed: ${err.message}`);
  job.status = 'error';
  job.stage = 'error';
  job.error = err.message;
  job.updatedAt = Date.now();
  saveHistory();

  notifyWebhook(job, { success: false, status: 'error', error: err.message });
}

// -------------------------------------------------------------
// Filesystem helpers
// -------------------------------------------------------------

function listDownloadFiles(dir) {
  const results = [];
  let list = [];
  try {
    list = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return results;
  }
  for (const item of list) {
    if (item.name === '.parts' || item.name.endsWith('.parts') || item.name.startsWith('.')) continue;
    const fullPath = path.join(dir, item.name);
    if (item.isDirectory()) {
      results.push(...listDownloadFiles(fullPath));
    } else if (item.isFile() && !item.name.endsWith('.cfg')) {
      results.push(fullPath);
    }
  }
  return results;
}

function cleanupJobDir(id) {
  try {
    const jobDir = path.join(GAME_DOWNLOADS_DIR, id);
    if (fs.existsSync(jobDir)) fs.rmSync(jobDir, { recursive: true, force: true });
  } catch (_) {}
}

function destroyQuietly(torrent) {
  try {
    if (torrent && typeof torrent.destroy === 'function') {
      torrent.destroy({ destroyStore: false });
    }
  } catch (_) {}
}

// -------------------------------------------------------------
// Orphan sweep for the game downloads directory (own dir only)
// -------------------------------------------------------------

function cleanupOrphanedGameDownloads() {
  try {
    if (!fs.existsSync(GAME_DOWNLOADS_DIR)) return;
    const entries = fs.readdirSync(GAME_DOWNLOADS_DIR);
    const now = Date.now();

    for (const entry of entries) {
      if (entry === '_inspect') {
        try { fs.rmSync(path.join(GAME_DOWNLOADS_DIR, entry), { recursive: true, force: true }); } catch (_) {}
        continue;
      }
      if (!entry.startsWith('gme_') && !entry.startsWith('gdl_')) continue;

      const isActive = (activeGameJob?.id === entry) || (activeDirectJob?.id === entry) ||
        gameQueue.some(q => q.id === entry) || directQueue.some(q => q.id === entry);
      if (isActive) continue;

      const record = jobs.get(entry);
      const finished = record && ['completed', 'cancelled', 'error'].includes(record.status);
      let shouldClean = finished;
      if (!shouldClean && !record) {
        try {
          const mtime = fs.statSync(path.join(GAME_DOWNLOADS_DIR, entry)).mtimeMs;
          if (now - mtime > 60 * 60 * 1000) shouldClean = true;
        } catch (_) {}
      }
      if (shouldClean) cleanupJobDir(entry);
      if (finished && now - (record.updatedAt || 0) > 7 * 24 * 60 * 60 * 1000) jobs.delete(entry);
    }
    saveHistory();
  } catch (_) {}
}

setTimeout(cleanupOrphanedGameDownloads, 8000);
setInterval(cleanupOrphanedGameDownloads, 60 * 60 * 1000);

// Re-pump queues for anything left 'queued' after a restart
setTimeout(() => {
  for (const job of jobs.values()) {
    if (!job.cancelled && job.status === 'queued' && ['game-torrent', 'game-direct'].includes(job.kind)) {
      if (job.kind === 'game-torrent' && !gameQueue.some(q => q.id === job.id)) {
        gameQueue.push(job);
      } else if (job.kind === 'game-direct' && !directQueue.some(q => q.id === job.id)) {
        directQueue.push(job);
      }
    }
  }
  pumpGameQueue();
  pumpDirectQueue();
}, 6000);
