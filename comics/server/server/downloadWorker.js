/**
 * Detached download worker.
 *
 * cPanel/Passenger kills the web process with SIGTERM moments after a request
 * finishes ("scale to zero" style), which destroyed any in-process background
 * job. This script is spawned with { detached: true, stdio: 'ignore' } and
 * unref()'d, so it keeps running (own session/process group) even after the web
 * worker is gone.
 *
 * Exactly one worker may run at a time, coordinated through `data/jobs/.worker.lock`
 * (with stale-lock detection via PID liveness). The worker drains queued jobs
 * one at a time, updating each job's JSON on disk, then exits.
 */
const fs = require('fs');
const path = require('path');

// Route worker logs into the same server.log as the web process.
const LOG_FILE = process.env.LOG_FILE || path.join(__dirname, '..', 'server.log');

function formatArg(a) {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack || a.message;
  if (a === undefined) return 'undefined';
  try { return JSON.stringify(a); } catch (e) { return String(a); }
}

function writeLine(level, args) {
  const line = `[${new Date().toISOString()}] [${level}] [worker ${process.pid}] ${args.map(formatArg).join(' ')}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch (e) {}
}

console.log = (...a) => writeLine('INFO', a);
console.info = (...a) => writeLine('INFO', a);
console.warn = (...a) => writeLine('WARN', a);
console.error = (...a) => writeLine('ERROR', a);

const DownloadManager = require('./downloadManager');

function acquireLock() {
  const lockPath = DownloadManager._getLockPath();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') {
        console.error('Could not create worker lock:', e.message);
        return false;
      }
      // Lock exists: take it over only if its owner process is gone.
      try {
        const info = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        if (info && DownloadManager._isProcessAlive(info.pid)) {
          return false; // a live worker already owns it
        }
      } catch (e2) {}
      try { fs.unlinkSync(lockPath); } catch (e3) {}
    }
  }
  return false;
}

function releaseLock() {
  try {
    const lockPath = DownloadManager._getLockPath();
    const info = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (info && info.pid === process.pid) fs.unlinkSync(lockPath);
  } catch (e) {}
}

let currentJobId = null;

process.on('SIGTERM', () => {
  console.warn('SIGTERM received; releasing lock and exiting.');
  releaseLock();
  process.exit(0);
});

(async () => {
  if (!acquireLock()) {
    // A live worker is already handling the queue; nothing to do.
    process.exit(0);
  }

  console.log('Worker started, draining queued jobs.');
  try {
    for (;;) {
      const queued = DownloadManager._listQueuedJobs();
      if (queued.length === 0) break;
      currentJobId = queued[0].id;
      console.log(`Processing job ${currentJobId}`);
      await DownloadManager._processQueuedJob(currentJobId);
      currentJobId = null;
    }
  } catch (e) {
    console.error('Worker fatal error:', e && e.stack ? e.stack : e);
    if (currentJobId) {
      DownloadManager._update(currentJobId, {
        status: 'error',
        phase: 'Failed',
        message: 'Download failed',
        error: e && e.message ? e.message : String(e)
      });
    }
  } finally {
    releaseLock();
  }

  console.log('Worker finished.');
  process.exit(0);
})();
