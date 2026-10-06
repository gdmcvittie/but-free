import fs from 'fs';
import path from 'path';
import WebTorrent from 'webtorrent';
import { isVideoFile, cleanMediaFilename, resolveMediaMeta } from './util.js';
import { transcodeMediaFile } from './transcoder.js';
import { resolveTargetFolderId, uploadFileToGoogleDrive } from './driveUploader.js';

const DOWNLOADS_DIR = path.join(process.cwd(), 'downloads');
const HISTORY_FILE = path.join(process.cwd(), 'download_history_tv.json');
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

let client = null;
function getTorrentClient() {
  if (!client) {
    client = new WebTorrent({ dht: true, maxConns: 100 });
    client.on('error', (err) => {
      console.warn('[TvDownloadManager] WebTorrent error:', err?.message || err);
    });
  }
  return client;
}

// -------------------------------------------------------------
// Dual Independent Queues:
// - Max 1 concurrent torrent download to protect bandwidth & disk IOPS
// - Max 1 concurrent video transcode to protect CPU & prevent throttling
// -------------------------------------------------------------
const jobs = new Map();

const downloadQueue = [];
let activeDownloadJob = null;

const transcodeQueue = [];
let activeTranscodeJob = null;

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
      if (Array.isArray(data)) {
        for (const item of data) {
          jobs.set(item.id, item);
        }
      }
    }
  } catch (_) {}
}

function saveHistory() {
  try {
    const list = Array.from(jobs.values()).slice(-100);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(list, null, 2), 'utf-8');
  } catch (_) {}
}

loadHistory();

export function getJobs(userId = null) {
  const all = Array.from(jobs.values());
  const filtered = userId ? all.filter(j => j.userId === userId) : all;

  // Augment jobs with live queue positions
  return filtered.map(j => {
    let queuePosition = null;
    let queueType = null;

    if (j.stage === 'queued_download') {
      const idx = downloadQueue.findIndex(q => q.id === j.id);
      if (idx >= 0) {
        queuePosition = idx + 1;
        queueType = 'download';
      }
    } else if (j.stage === 'queued_transcode') {
      const idx = transcodeQueue.findIndex(q => q.id === j.id);
      if (idx >= 0) {
        queuePosition = idx + 1;
        queueType = 'transcode';
      }
    }

    return {
      ...j,
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

  console.log(`[TvDownloadManager] Cancelling job ${id} (current stage: ${job.stage})...`);
  job.cancelled = true;
  job.status = 'cancelled';
  job.stage = 'cancelled';
  job.updatedAt = Date.now();

  // 1. Remove from download queue if pending
  const dlIdx = downloadQueue.findIndex(q => q.id === id);
  if (dlIdx >= 0) downloadQueue.splice(dlIdx, 1);

  // 2. Stop active torrent swarm if currently downloading
  if (activeDownloadJob && activeDownloadJob.id === id) {
    if (job.torrent) {
      try { job.torrent.destroy(); } catch (_) {}
    }
    activeDownloadJob = null;
    setImmediate(pumpDownloadQueue);
  }

  // 3. Remove from transcode queue if pending
  const tcIdx = transcodeQueue.findIndex(q => q.id === id);
  if (tcIdx >= 0) transcodeQueue.splice(tcIdx, 1);

  // 4. Terminate active FFmpeg process if currently transcoding
  if (activeTranscodeJob && activeTranscodeJob.id === id) {
    if (job.ffmpegProcess) {
      try {
        job.ffmpegProcess.kill('SIGKILL');
      } catch (_) {}
    }
    activeTranscodeJob = null;
    setImmediate(pumpTranscodeQueue);
  }

  // 5. Clean local temp files
  try {
    const jobDir = path.join(DOWNLOADS_DIR, id);
    if (fs.existsSync(jobDir)) fs.rmSync(jobDir, { recursive: true, force: true });
  } catch (_) {}

  saveHistory();
  return true;
}

export function clearHistory(userId = null) {
  let cleared = 0;
  for (const [id, job] of jobs.entries()) {
    if (['completed', 'error', 'cancelled'].includes(job.stage || job.status)) {
      if (!userId || job.userId === userId) {
        // Clean any leftover temp directory
        try {
          const jobDir = path.join(DOWNLOADS_DIR, id);
          if (fs.existsSync(jobDir)) fs.rmSync(jobDir, { recursive: true, force: true });
        } catch (_) {}

        jobs.delete(id);
        cleared++;
      }
    }
  }
  if (cleared > 0) {
    saveHistory();
  }
  return cleared;
}

export function deleteJob(id) {
  const job = jobs.get(id);
  if (!job) return false;
  try {
    const jobDir = path.join(DOWNLOADS_DIR, id);
    if (fs.existsSync(jobDir)) fs.rmSync(jobDir, { recursive: true, force: true });
  } catch (_) {}
  jobs.delete(id);
  saveHistory();
  return true;
}

export function addDownloadJob(options) {
  const id = options.id || `dl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const job = {
    id,
    userId: options.userId || 'default',
    magnet: options.magnet,
    title: options.title || 'Torrent Download',
    kind: options.kind || 'movie',
    meta: options.meta || {},
    driveConfig: options.driveConfig || null,
    transcodeConfig: options.transcodeConfig || { enabled: true, targetHeight: '480', codec: 'h265', preset: 'veryfast', crf: '20' },
    webhookUrl: options.webhookUrl || null,
    status: 'queued',
    stage: 'queued_download',
    downloadPercent: 0,
    downloadSpeed: 0,
    numPeers: 0,
    transcodePercent: 0,
    uploadPercent: 0,
    driveFileId: null,
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  jobs.set(id, job);
  downloadQueue.push(job);
  saveHistory();

  console.log(`[TvDownloadManager] Enqueued job ${id} into download queue (Queue length: ${downloadQueue.length})`);
  pumpDownloadQueue();
  return job;
}

// -------------------------------------------------------------
// Pipeline Phase 1: Torrent Download (Concurrency = 1)
// -------------------------------------------------------------
function pumpDownloadQueue() {
  if (activeDownloadJob !== null) {
    return; // A torrent is already downloading
  }

  while (downloadQueue.length > 0) {
    const nextJob = downloadQueue.shift();
    if (nextJob.cancelled) continue;

    activeDownloadJob = nextJob;
    runDownloadPhase(nextJob);
    break;
  }
}

async function runDownloadPhase(job) {
  const wt = getTorrentClient();
  const jobDir = path.join(DOWNLOADS_DIR, job.id);
  if (!fs.existsSync(jobDir)) fs.mkdirSync(jobDir, { recursive: true });

  job.status = 'active';
  job.stage = 'downloading';
  job.updatedAt = Date.now();

  console.log(`[TvDownloadManager] Starting download phase for ${job.id}: "${job.title}"`);

  let torrent = null;
  try {
    await new Promise((resolve, reject) => {
      if (job.cancelled) return reject(new Error('Job cancelled'));

      torrent = wt.add(job.magnet, { path: jobDir }, (t) => {
        job.torrent = t;

        t.on('download', () => {
          if (job.cancelled) return;
          job.downloadPercent = Math.min(100, Math.round(t.progress * 100));
          job.downloadSpeed = t.downloadSpeed;
          job.numPeers = t.numPeers;
          job.updatedAt = Date.now();
        });

        t.on('done', () => {
          job.downloadPercent = 100;
          job.downloadSpeed = 0;
          resolve();
        });

        t.on('error', (err) => {
          reject(err);
        });
      });

      torrent.on('error', (err) => reject(err));
    });

    if (job.cancelled) throw new Error('Job cancelled');

    // Close torrent client handle to flush locks and free RAM
    try {
      if (torrent && typeof torrent.destroy === 'function') {
        torrent.destroy({ destroyStore: false });
      }
    } catch (_) {}

    // Find main video file
    const files = listFilesRecursive(jobDir).filter(f => isVideoFile(f));
    if (files.length === 0) {
      throw new Error('No video files found in the completed torrent download');
    }
    files.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
    const sourceVideoPath = files[0];
    const originalFilename = path.basename(sourceVideoPath);

    const mediaMeta = resolveMediaMeta(originalFilename, job.kind, job.meta);
    const targetExt = (job.transcodeConfig && job.transcodeConfig.enabled !== false) ? '.mp4' : (path.extname(originalFilename) || '.mp4');
    const cleanName = cleanMediaFilename(originalFilename, mediaMeta.showName, { ...job.meta, ...mediaMeta }, targetExt);

    job.sourceVideoPath = sourceVideoPath;
    job.originalFilename = originalFilename;
    job.cleanName = cleanName;
    job.mediaMeta = mediaMeta;
    job.updatedAt = Date.now();

    console.log(`[TvDownloadManager] Download complete for ${job.id}: "${cleanName}"`);

    // Download slot is now released! Next torrent can start downloading
    activeDownloadJob = null;
    pumpDownloadQueue();

    // Route to Transcode Queue
    enqueueTranscodePhase(job);

  } catch (err) {
    activeDownloadJob = null;
    handleJobError(job, err);
    pumpDownloadQueue();
  }
}

// -------------------------------------------------------------
// Pipeline Phase 2: Transcoding (Concurrency = 1)
// -------------------------------------------------------------
function enqueueTranscodePhase(job) {
  if (job.cancelled) return;

  const transcodeRequested = job.transcodeConfig && job.transcodeConfig.enabled !== false;
  if (!transcodeRequested) {
    console.log(`[TvDownloadManager] Transcoding disabled for ${job.id}, proceeding directly to upload.`);
    job.fileToUpload = job.sourceVideoPath;
    runUploadPhase(job);
    return;
  }

  job.status = 'queued';
  job.stage = 'queued_transcode';
  job.updatedAt = Date.now();
  transcodeQueue.push(job);
  saveHistory();

  console.log(`[TvDownloadManager] Enqueued job ${job.id} into transcode queue (Queue length: ${transcodeQueue.length})`);
  pumpTranscodeQueue();
}

function pumpTranscodeQueue() {
  if (activeTranscodeJob !== null) {
    return; // A file is already transcoding
  }

  while (transcodeQueue.length > 0) {
    const nextJob = transcodeQueue.shift();
    if (nextJob.cancelled) continue;

    activeTranscodeJob = nextJob;
    runTranscodePhase(nextJob);
    break;
  }
}

async function runTranscodePhase(job) {
  job.status = 'active';
  job.stage = 'transcoding';
  job.updatedAt = Date.now();

  const jobDir = path.join(DOWNLOADS_DIR, job.id);
  const cleanBase = path.basename(job.cleanName, path.extname(job.cleanName));
  const transcodeOut = path.join(jobDir, `${cleanBase}.transcoded.mp4`);

  console.log(`[TvDownloadManager] Starting transcode phase for ${job.id}: "${path.basename(job.sourceVideoPath)}" -> "${path.basename(transcodeOut)}"`);

  try {
    const transResult = await transcodeMediaFile(
      job.sourceVideoPath,
      transcodeOut,
      {
        ...job.transcodeConfig,
        onProcess: (proc) => {
          job.ffmpegProcess = proc;
        }
      },
      (pct) => {
        if (job.cancelled) return;
        job.transcodePercent = pct;
        job.updatedAt = Date.now();
      }
    );

    if (transResult && transResult.outputPath && !transResult.skipped) {
      job.fileToUpload = transResult.outputPath;
      job.cleanName = job.cleanName.replace(/\.[^/.]+$/, '') + '.mp4';
      // Immediately delete the original downloaded source video to reclaim disk space before upload begins!
      try {
        if (fs.existsSync(job.sourceVideoPath) && job.sourceVideoPath !== transResult.outputPath) {
          const freedMb = (fs.statSync(job.sourceVideoPath).size / 1024 / 1024).toFixed(1);
          fs.unlinkSync(job.sourceVideoPath);
          console.log(`[TvDownloadManager] [Disk Cleanup] Deleted raw source video after transcode: "${path.basename(job.sourceVideoPath)}" (Freed ${freedMb} MB)`);
        }
      } catch (delErr) {
        console.warn(`[TvDownloadManager] Could not delete original source video:`, delErr.message);
      }
    } else {
      job.fileToUpload = (transResult && transResult.outputPath) ? transResult.outputPath : job.sourceVideoPath;
      if (job.transcodeConfig && job.transcodeConfig.enabled !== false) {
        job.cleanName = job.cleanName.replace(/\.[^/.]+$/, '') + '.mp4';
      }
    }

    job.transcodePercent = 100;
    job.ffmpegProcess = null;
    job.updatedAt = Date.now();

    console.log(`[TvDownloadManager] Transcode phase finished for ${job.id} (skipped: ${!!transResult?.skipped})`);

    // Transcode slot is now released! Next file can start transcoding
    activeTranscodeJob = null;
    pumpTranscodeQueue();

    // Proceed to Google Drive upload
    runUploadPhase(job);

  } catch (err) {
    job.ffmpegProcess = null;
    activeTranscodeJob = null;
    handleJobError(job, err);
    pumpTranscodeQueue();
  }
}

// -------------------------------------------------------------
// Pipeline Phase 3: Google Drive Upload & Webhook
// -------------------------------------------------------------
async function runUploadPhase(job) {
  if (job.cancelled) return;

  const jobDir = path.join(DOWNLOADS_DIR, job.id);

  try {
    if (job.driveConfig && job.driveConfig.accessToken && job.driveConfig.rootFolderId) {
      job.status = 'active';
      job.stage = 'uploading';
      job.updatedAt = Date.now();

      // Dynamic token refresh helper function
      const refreshToken = async () => {
        let refreshUrl = job.driveConfig?.tokenRefreshUrl || 'https://tv.butfree.online/api/downloads/token-refresh';
        if (!job.userId) return null;
        if (refreshUrl.includes('butfree.online') && !refreshUrl.includes('tv.butfree.online')) {
          refreshUrl = refreshUrl.replace('://butfree.online', '://tv.butfree.online');
        }
        try {
          console.log(`[TvDownloadManager] Requesting fresh Drive access token from ${refreshUrl}...`);
          let rfRes = await fetch(refreshUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: job.userId })
          });
          // If the configured URL returned 404, fallback to tv.butfree.online
          if (rfRes.status === 404 && !refreshUrl.includes('tv.butfree.online')) {
            const fallbackUrl = 'https://tv.butfree.online/api/downloads/token-refresh';
            console.log(`[TvDownloadManager] Retrying token refresh via fallback: ${fallbackUrl}`);
            rfRes = await fetch(fallbackUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ userId: job.userId })
            });
          }
          if (rfRes.ok) {
            const rfData = await rfRes.json();
            if (rfData.accessToken) {
              job.driveConfig.accessToken = rfData.accessToken;
              console.log(`[TvDownloadManager] Successfully obtained fresh Drive access token.`);
              return rfData.accessToken;
            }
          } else {
            const errBody = await rfRes.text();
            console.warn(`[TvDownloadManager] Token refresh returned HTTP ${rfRes.status}: ${errBody}`);
          }
        } catch (rfErr) {
          console.warn(`[TvDownloadManager] Token refresh request error:`, rfErr.message);
        }
        return null;
      };

      // Downloading and transcoding frequently take 30-90 minutes, which easily exceeds
      // Google's 1-hour access token TTL. Always request a fresh token before starting Phase 3.
      if (job.driveConfig.tokenRefreshUrl && job.userId) {
        const freshToken = await refreshToken();
        if (freshToken) {
          job.driveConfig.accessToken = freshToken;
        }
      }

      console.log(`[TvDownloadManager] Uploading "${job.cleanName}" to Google Drive...`);
      const targetFolderId = await resolveTargetFolderId(
        job.driveConfig.accessToken,
        job.driveConfig.rootFolderId,
        job.mediaMeta,
        refreshToken
      );

      const driveFile = await uploadFileToGoogleDrive(
        job.fileToUpload,
        job.cleanName,
        targetFolderId,
        job.driveConfig.accessToken,
        (pct) => {
          if (job.cancelled) return;
          job.uploadPercent = pct;
          job.updatedAt = Date.now();
        },
        refreshToken
      );

      job.driveFileId = driveFile.id;
    }

    // Success Completion
    job.status = 'completed';
    job.stage = 'completed';
    job.uploadPercent = 100;
    job.updatedAt = Date.now();
    console.log(`[TvDownloadManager] Successfully completed all stages for ${job.id}: "${job.cleanName}"`);

    // Complete cleanup of temporary local torrent and transcoded files
    try {
      if (fs.existsSync(jobDir)) {
        fs.rmSync(jobDir, { recursive: true, force: true });
        console.log(`[TvDownloadManager] [Disk Cleanup] Successfully wiped job directory from disk: ${jobDir}`);
      }
    } catch (cleanErr) {
      console.warn(`[TvDownloadManager] Warning wiping directory ${jobDir}:`, cleanErr.message);
    }

    // Notify Webhook
    if (job.webhookUrl) {
      try {
        await fetch(job.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jobId: job.id,
            userId: job.userId,
            status: 'completed',
            driveFileId: job.driveFileId,
            cleanName: job.cleanName,
            meta: job.mediaMeta
          })
        });
      } catch (wErr) {
        console.warn(`[TvDownloadManager] Webhook notification failed for ${job.id}:`, wErr.message);
      }
    }

  } catch (err) {
    handleJobError(job, err);
  } finally {
    saveHistory();
  }
}

// -------------------------------------------------------------
// Orphan Disk Cleanup: removes abandoned/leftover torrent folders
// -------------------------------------------------------------
export function cleanupOrphanedTvDownloads() {
  try {
    if (!fs.existsSync(DOWNLOADS_DIR)) return;
    const entries = fs.readdirSync(DOWNLOADS_DIR);
    const now = Date.now();

    for (const entry of entries) {
      if (!entry.startsWith('dl_')) continue;
      const entryPath = path.join(DOWNLOADS_DIR, entry);
      try {
        if (!fs.statSync(entryPath).isDirectory()) continue;
      } catch (_) { continue; }

      const isJobActive = (activeDownloadJob?.id === entry) ||
                          (activeTranscodeJob?.id === entry) ||
                          downloadQueue.some(q => q.id === entry) ||
                          transcodeQueue.some(q => q.id === entry);

      const jobRecord = jobs.get(entry);
      const isCompletedOrCancelled = jobRecord && ['completed', 'cancelled', 'error'].includes(jobRecord.status);

      if (!isJobActive) {
        let shouldClean = isCompletedOrCancelled;
        if (!shouldClean) {
          try {
            const mtime = fs.statSync(entryPath).mtimeMs;
            if (now - mtime > 30 * 60 * 1000) {
              shouldClean = true;
            }
          } catch (_) {}
        }

        if (shouldClean) {
          try {
            fs.rmSync(entryPath, { recursive: true, force: true });
            console.log(`[TvDownloadManager] [Disk Cleanup] Cleaned up abandoned/orphaned directory: ${entry}`);
          } catch (rmErr) {
            console.warn(`[TvDownloadManager] Could not remove orphan directory ${entry}:`, rmErr.message);
          }
        }
      }
    }
  } catch (err) {
    console.warn('[TvDownloadManager] Error during orphan cleanup check:', err.message);
  }
}

// Startup orphan sweep (after 5 seconds)
setTimeout(cleanupOrphanedTvDownloads, 5000);
// Periodic sweep every 30 minutes
setInterval(cleanupOrphanedTvDownloads, 30 * 60 * 1000);

function handleJobError(job, err) {
  if (job.cancelled) return;

  job.status = 'error';
  job.stage = 'error';
  job.error = err.message;
  job.updatedAt = Date.now();
  console.error(`[TvDownloadManager] Job ${job.id} failed:`, err.message);

  const jobDir = path.join(DOWNLOADS_DIR, job.id);
  try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch (_) {}

  if (job.webhookUrl) {
    fetch(job.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobId: job.id,
        userId: job.userId,
        status: 'error',
        error: err.message
      })
    }).catch(() => {});
  }
  saveHistory();
}

function listFilesRecursive(dir) {
  const results = [];
  try {
    const list = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of list) {
      const fullPath = path.join(dir, item.name);
      if (item.isDirectory()) {
        results.push(...listFilesRecursive(fullPath));
      } else if (item.isFile()) {
        results.push(fullPath);
      }
    }
  } catch (_) {}
  return results;
}
