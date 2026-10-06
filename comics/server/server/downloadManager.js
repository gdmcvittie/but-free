const fs = require('fs');
const path = require('path');
const os = require('os');
const ComicScraper = require('./scraper');
const GoogleDrive = require('./googleDrive');
const Database = require('./database');
const ComicCompressor = require('./comicCompressor');

/**
 * DownloadManager:
 * Runs GetComics downloads (fetch -> compress -> upload to Drive) as BACKGROUND jobs.
 *
 * On cPanel/Passenger the web process is killed with SIGTERM moments after a
 * request completes, so the job CANNOT run inside the web process. Instead this
 * module only tracks jobs on disk and spawns a DETACHED worker process
 * (`downloadWorker.js`) that performs the actual work and survives the web
 * process being torn down. The client polls for progress.
 *
 * Jobs are persisted to `data/jobs/${job.id}.json` so every web process (and
 * restarts) can find/read them, and exactly one worker is coordinated through
 * `data/jobs/.worker.lock`.
 */

const { spawn } = require('child_process');

const JOB_TTL_MS = 60 * 60 * 1000; // keep finished jobs addressable for 1 hour
// A job with no owner info (e.g. written by an older server build) is only
// considered orphaned once it has gone this long without any update.
const ORPHAN_GRACE_MS = 3 * 60 * 1000;
// Don't spawn more than one worker per this window from a single web process.
const WORKER_SPAWN_DEBOUNCE_MS = 3000;

const jobs = new Map();
let counter = 0;

const OWNER_HOST = os.hostname();

function isProcessAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but belongs to another user.
    return e && e.code === 'EPERM';
  }
}

// Passenger keeps a POOL of worker processes that all share this jobs directory.
// A newly spawned worker must never fail a job that another live worker is still
// running, otherwise every extra worker marks in-progress downloads as "restarted".
function shouldPreserveInProgressJob(job) {
  if (!job || ['done', 'error'].includes(job.status)) return true;

  // Same host: trust the OS to tell us whether the owning process is still alive.
  if (job.ownerPid && (!job.ownerHost || job.ownerHost === OWNER_HOST)) {
    return isProcessAlive(job.ownerPid);
  }

  // No/foreign owner info: fall back to a recent-update grace window.
  return Date.now() - (job.updatedAt || 0) < ORPHAN_GRACE_MS;
}

function getJobsDir() {
  const baseDir = process.env.DATA_DIR
    ? (path.isAbsolute(process.env.DATA_DIR) ? process.env.DATA_DIR : path.join(__dirname, '..', process.env.DATA_DIR))
    : path.join(__dirname, '..', 'data');
  const dir = path.join(baseDir, 'jobs');
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  } catch (e) {}
  return dir;
}

function saveJobToDisk(job) {
  try {
    const dir = getJobsDir();
    const filePath = path.join(dir, `${job.id}.json`);
    const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tempPath, JSON.stringify(job, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (e) {
    console.error(`[DownloadManager] Failed to persist job ${job.id} to disk:`, e.message);
  }
}

function getLockPath() {
  return path.join(getJobsDir(), '.worker.lock');
}

// True when a detached download worker is currently alive (on any process).
function isWorkerLive() {
  try {
    const info = JSON.parse(fs.readFileSync(getLockPath(), 'utf8'));
    return Boolean(info && isProcessAlive(info.pid));
  } catch (e) {
    return false;
  }
}

let lastSpawnAt = 0;

/**
 * Spawns the detached background worker that actually performs downloads.
 * Passenger (cPanel) tears the web process down with SIGTERM as soon as a
 * request finishes, so the work MUST live outside this process. The child is
 * detached (new session) and unref'd so it survives the web worker being killed.
 */
function ensureWorker() {
  if (isWorkerLive()) return;
  const now = Date.now();
  if (now - lastSpawnAt < WORKER_SPAWN_DEBOUNCE_MS) return;
  lastSpawnAt = now;

  try {
    const workerPath = path.join(__dirname, 'downloadWorker.js');
    const child = spawn(process.execPath, [workerPath], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
      cwd: __dirname
    });
    child.on('error', (err) => {
      console.error('[DownloadManager] Failed to spawn download worker:', err.message);
    });
    child.unref();
    console.log(`[DownloadManager] Spawned download worker pid=${child.pid}`);
  } catch (e) {
    console.error('[DownloadManager] Failed to spawn download worker:', e.message);
  }
}

function listQueuedJobs() {
  const queued = [];
  try {
    const dir = getJobsDir();
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const job = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        if (job && job.status === 'queued') queued.push(job);
      } catch (e) {}
    }
  } catch (e) {}
  queued.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  return queued;
}

function cleanupOrphanedJobs() {
  try {
    const dir = getJobsDir();
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const filePath = path.join(dir, file);
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const job = JSON.parse(raw);
        if (job && ['queued', 'downloading', 'compressing', 'uploading'].includes(job.status)) {
          if (shouldPreserveInProgressJob(job)) {
            // Another live worker process is still running this job - leave it alone.
            continue;
          }
          console.warn(`[DownloadManager] Marking interrupted job ${job.id} as failed (owner process is gone).`);
          job.status = 'error';
          job.phase = 'Failed';
          job.message = 'Server restarted while processing. Please try downloading again.';
          job.error = 'Server process was interrupted or restarted.';
          job.updatedAt = Date.now();
          fs.writeFileSync(filePath, JSON.stringify(job, null, 2), 'utf8');
        }
      } catch (e) {}
    }
  } catch (e) {}
}

// Check for interrupted jobs from previous server instance on startup
cleanupOrphanedJobs();

function readJobFromDisk(id) {
  try {
    const filePath = path.join(getJobsDir(), `${id}.json`);
    if (!fs.existsSync(filePath)) return null;
    const job = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return job && job.id ? job : null;
  } catch (e) {
    return null;
  }
}

function getJob(id) {
  // 1. Check in-memory map first
  let job = jobs.get(id);
  if (job) return job;

  // 2. Check on-disk store (for other Passenger worker processes or post-restart)
  try {
    const dir = getJobsDir();
    const filePath = path.join(dir, `${id}.json`);
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      job = JSON.parse(raw);
      if (job && job.id) {
        jobs.set(job.id, job);
        return job;
      }
    }
  } catch (e) {
    console.warn(`[DownloadManager] Failed to read job ${id} from disk:`, e.message);
  }
  return null;
}

function newJobId() {
  counter = (counter + 1) % 1000000;
  return `dl_${Date.now().toString(36)}_${counter.toString(36)}`;
}

function prune() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    const finished = job.status === 'done' || job.status === 'error';
    if (finished && now - job.updatedAt > JOB_TTL_MS) jobs.delete(id);
  }

  try {
    const dir = getJobsDir();
    const files = fs.readdirSync(dir);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const filePath = path.join(dir, file);
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > JOB_TTL_MS) {
          fs.unlinkSync(filePath);
        }
      } catch (e) {}
    }
  } catch (e) {}
}

const DownloadManager = {
  /**
   * Queues a download job and returns its public state immediately.
   */
  start(user, url, seriesName = '') {
    prune();
    const id = newJobId();
    const now = Date.now();
    const job = {
      id,
      userId: user.id,
      url,
      seriesName,
      status: 'queued',
      phase: 'Queued',
      percent: 0,
      message: 'Queued for download...',
      ownerPid: null,
      ownerHost: OWNER_HOST,
      createdAt: now,
      updatedAt: now,
      result: null,
      error: null
    };
    jobs.set(id, job);
    saveJobToDisk(job);
    ensureWorker();
    return job;
  },

  /**
   * Returns the public status of a job owned by `userId` (or null).
   */
  status(id, userId) {
    prune();
    // The detached worker owns the job, so disk is always authoritative. Never
    // serve a cached snapshot (that caused jobs to appear stuck on "queued").
    const diskJob = readJobFromDisk(id);
    let job = diskJob || getJob(id);
    if (!job) return null;
    jobs.set(id, job);

    if (userId && job.userId && String(job.userId) !== String(userId)) return null;

    // Self-heal: if a job is queued but no worker is alive (e.g. the spawn was
    // lost when Passenger killed the web process), start one from the poll.
    if (job.status === 'queued') ensureWorker();

    // Fail a running job as soon as its owning process is gone (never reap
    // another live worker's job). A job stuck in the queue for > 15m (no worker
    // ever picked it up) is failed too.
    const inProgress = ['downloading', 'compressing', 'uploading'].includes(job.status);
    const queuedTooLong = job.status === 'queued' && Date.now() - job.updatedAt > 15 * 60 * 1000;
    if ((inProgress && !shouldPreserveInProgressJob(job)) || queuedTooLong) {
      job.status = 'error';
      job.phase = 'Failed';
      job.error = 'Server process was interrupted or restarted.';
      job.message = 'Server restarted while processing. Please try downloading again.';
      saveJobToDisk(job);
    }

    return {
      id: job.id,
      status: job.status,
      phase: job.phase,
      percent: job.percent,
      message: job.message,
      error: job.error,
      result: job.status === 'done' ? job.result : null,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt
    };
  },

  _update(id, patch) {
    let job = jobs.get(id);
    if (!job) {
      job = getJob(id);
    }
    if (!job) return;
    Object.assign(job, patch, { updatedAt: Date.now() });
    jobs.set(id, job);
    saveJobToDisk(job);
  },

  /**
   * Called by the detached worker: claims a queued job for this process and
   * runs the full download pipeline. Returns true if a job was processed.
   */
  async _processQueuedJob(id) {
    const job = getJob(id);
    if (!job || job.status !== 'queued') return false;
    job.ownerPid = process.pid;
    job.ownerHost = OWNER_HOST;
    job.updatedAt = Date.now();
    jobs.set(id, job);
    saveJobToDisk(job);
    await runJob(job);
    return true;
  },

  /**
   * Admin "restart downloader": stops any live download worker processes,
   * requeues every in-flight job so a fresh worker restarts them from the
   * beginning, then spawns that fresh worker immediately.
   * Returns counts for the admin UI.
   */
  restartWorker() {
    let killed = 0;
    let requeued = 0;
    const dir = getJobsDir();
    if (fs.existsSync(dir)) {
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.json')) continue;
        const filePath = path.join(dir, file);
        try {
          const job = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          if (!job || !job.id) continue;
          const inProgress = ['downloading', 'compressing', 'uploading'].includes(job.status);
          if (inProgress && job.ownerPid && job.ownerPid !== process.pid) {
            try {
              process.kill(job.ownerPid, 'SIGKILL');
              killed++;
            } catch (e) {}
          }
          if (inProgress) {
            job.status = 'queued';
            job.phase = 'Queued';
            job.percent = 0;
            job.message = 'Queued for download...';
            job.ownerPid = null;
            job.ownerHost = null;
            job.updatedAt = Date.now();
            fs.writeFileSync(filePath, JSON.stringify(job, null, 2), 'utf8');
            jobs.delete(job.id);
            requeued++;
          }
        } catch (e) {}
      }
    }
    lastSpawnAt = 0;
    try { ensureWorker(); } catch (e) {}
    return { killed, requeued };
  },

  // Internals shared with downloadWorker.js
  _getJobsDir: getJobsDir,
  _isProcessAlive: isProcessAlive,
  _listQueuedJobs: listQueuedJobs,
  _getLockPath: getLockPath
};

function logMemory(tag) {
  try {
    const m = process.memoryUsage();
    console.log(
      `[DownloadJob] memory ${tag}: rss=${(m.rss / 1048576).toFixed(0)}MB heapUsed=${(m.heapUsed / 1048576).toFixed(0)}MB external=${(m.external / 1048576).toFixed(0)}MB`
    );
  } catch (e) {}
}

async function runJob(job) {
  const id = job.id;
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const tempArchive = path.join(os.tmpdir(), `cmx_dl_${id}_${stamp}.archive`);
  const tempOutput = path.join(os.tmpdir(), `cmx_dl_${id}_${stamp}.cbz`);
  const tempCover = path.join(os.tmpdir(), `cmx_dl_${id}_${stamp}.jpg`);
  const cleanupTemp = () => {
    for (const p of [tempArchive, tempOutput, tempCover]) {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) {}
    }
  };

  try {
    const user = Database.getUser(job.userId);
    if (!user) {
      throw new Error('Your session has expired. Please sign in with Google again.');
    }
    if (!user.driveFolderId) {
      throw new Error('Please select a Google Drive comics folder in Settings first.');
    }

    logMemory('start');
    DownloadManager._update(id, {
      status: 'downloading',
      phase: 'Resolving download mirror',
      percent: 5,
      message: 'Resolving download mirror...'
    });

    // 1. Stream the issue straight to disk (never hold the whole archive in RAM)
    const downloadResult = await ComicScraper.downloadIssueToFile(job.url, tempArchive, (p) => {
      const pct = p && typeof p.percent === 'number' ? p.percent : 0;
      DownloadManager._update(id, {
        status: 'downloading',
        phase: 'Downloading from mirror',
        percent: Math.max(5, Math.min(40, pct)),
        message: (p && p.status) || 'Downloading issue...'
      });
    });
    logMemory(`downloaded ${(downloadResult.size / (1024 * 1024)).toFixed(1)}MB`);

    DownloadManager._update(id, {
      status: 'compressing',
      phase: 'Compressing pages',
      percent: 42,
      message: 'Compressing comic pages...'
    });

    // 2. Optionally compress images and repack the CBZ on disk
    const userSettings = Database.getUserSettings(user.id);
    const shouldCompress = userSettings.compressLibrary !== false;
    const quality = userSettings.compressionQuality || 75;

    let finalSource = tempArchive;
    let finalSize = downloadResult.size;
    let compInfo = { isCompressed: false, percentSaved: 0 };
    let coverJpeg = null;

    if (shouldCompress) {
      try {
        const compResult = await ComicCompressor.compressArchiveFileToFile(tempArchive, tempOutput, {
          quality,
          onProgress: (p) => {
            const pagesPercent = Math.max(0, Math.min(100, p && typeof p.percent === 'number' ? p.percent : 0));
            DownloadManager._update(id, {
              status: 'compressing',
              phase: 'Compressing pages',
              percent: 42 + Math.round(pagesPercent * 0.48),
              message: (p && p.step) || 'Compressing comic pages...'
            });
          }
        });
        if (compResult.compressedSize > 0 && compResult.compressedSize < downloadResult.size) {
          finalSource = tempOutput;
          finalSize = compResult.compressedSize;
        }
        if (compResult.coverJpeg) {
          coverJpeg = compResult.coverJpeg;
        }
        compInfo = {
          isCompressed: Boolean(compResult.isCompressed || compResult.percentSaved > 0),
          originalSize: compResult.originalSize,
          compressedSize: compResult.compressedSize,
          savedBytes: compResult.savedBytes,
          percentSaved: compResult.percentSaved
        };
      } catch (compErr) {
        console.error('[DownloadJob] Compression FAILED - saving file uncompressed:', compErr.message);
        compInfo = { isCompressed: false, percentSaved: 0, compressionError: compErr.message };
      }
    }

    // If compression was skipped, didn't run, or didn't yield a cover, extract directly from finalSource
    if (!coverJpeg) {
      try {
        const extracted = await ComicCompressor.extractCoverThumbnail(finalSource, { maxHeight: 512, quality: 85 });
        if (extracted && extracted.coverJpeg) {
          coverJpeg = extracted.coverJpeg;
        }
      } catch (covErr) {
        console.warn('[DownloadJob] Could not extract cover thumbnail:', covErr.message);
      }
    }

    logMemory('after compression');

    // 3. Upload the (possibly repacked) CBZ from disk straight into Google Drive
    const totalMb = (finalSize / (1024 * 1024)).toFixed(1);
    DownloadManager._update(id, {
      status: 'uploading',
      phase: 'Uploading to Google Drive',
      percent: 91,
      message: `Uploading to Google Drive (${totalMb} MB)...`
    });

    const savedComic = await GoogleDrive.uploadComicFile(
      user,
      finalSource,
      downloadResult.fileName,
      job.seriesName,
      downloadResult.coverUrl,
      null, // targetFolderIdOverride
      null, // metadataOverride
      (progress) => {
        const uploadPercent = Math.min(99, Math.max(91, 91 + Math.round((progress.uploaded / progress.total) * 8)));
        const mbDone = (progress.uploaded / (1024 * 1024)).toFixed(1);
        const mbTotal = (progress.total / (1024 * 1024)).toFixed(1);
        DownloadManager._update(id, {
          status: 'uploading',
          phase: 'Uploading to Google Drive',
          percent: uploadPercent,
          message: `Uploading to Google Drive (${mbDone} / ${mbTotal} MB)...`
        });
      },
      coverJpeg
    );

    // 4. Auto-scan Google Drive so the user's library reflects the new comic
    // (and anything else that landed) without a manual refresh. The just-uploaded
    // file is protected in case Drive hasn't indexed it in the listing yet.
    let libraryCount = null;
    try {
      DownloadManager._update(id, {
        status: 'uploading',
        phase: 'Updating library',
        percent: 99,
        message: 'Scanning Google Drive for new comics...'
      });
      const scan = await GoogleDrive.syncLibrary(user, { protectFileIds: [savedComic.googleFileId] });
      libraryCount = scan.count;
      console.log(`[DownloadJob] Post-download library scan complete: ${libraryCount} comics.`);
    } catch (scanErr) {
      console.warn('[DownloadJob] Post-download library scan failed:', scanErr.message);
    }

    let message;
    if (compInfo.isCompressed) {
      message = `⚡ Compressed (${compInfo.percentSaved}% saved at ${quality}% quality) & saved to Google Drive!`;
    } else if (compInfo.compressionError) {
      message = `Comic saved to Google Drive without compression (${compInfo.compressionError})`;
    } else {
      message = 'Comic downloaded and saved directly to your Google Drive library!';
    }

    DownloadManager._update(id, {
      status: 'done',
      phase: 'Complete',
      percent: 100,
      message,
      result: {
        success: true,
        title: savedComic.title,
        comic: savedComic,
        id: savedComic.id,
        googleFileId: savedComic.googleFileId,
        coverImage: savedComic.coverImage,
        libraryCount,
        ...compInfo,
        message
      }
    });
  } catch (err) {
    console.error('[DownloadJob] Error downloading comic:', err.message);
    DownloadManager._update(id, {
      status: 'error',
      phase: 'Failed',
      message: err.message || 'Download failed',
      error: err.message || 'Download failed'
    });
  } finally {
    cleanupTemp();
  }
}

module.exports = DownloadManager;
