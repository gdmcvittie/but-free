import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import http from 'http';
import https from 'https';
import zlib from 'zlib';
import { spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { inspect } from 'util';
import dotenv from 'dotenv';

const require = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Explicitly load root .env from monorepo root (../../.env), with local fallback
const rootEnv = path.resolve(__dirname, '..', '..', '.env');
if (fs.existsSync(rootEnv)) {
  dotenv.config({ path: rootEnv });
}
dotenv.config({ path: path.join(__dirname, '.env') });

// ------------------------------------------------------------------
// File logging: mirror ALL console output plus every HTTP request to
// data/logs/server.log so playback issues can be diagnosed from the
// VPS without needing access to journalctl / Passenger logs.
// ------------------------------------------------------------------
const LOG_DIR = path.join(__dirname, 'data', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'server.log');

function logFmtArg(a) {
  if (typeof a === 'string') return a;
  try { return inspect(a, { depth: 3, breakLength: 160 }); } catch (_) { return String(a); }
}

function writeFileLog(tag, args) {
  const line = `[${new Date().toISOString()}] [${tag}] ${args.map(logFmtArg).join(' ')}`;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (_) {}
}

for (const level of ['log', 'warn', 'error']) {
  const orig = console[level];
  console[level] = function (...args) {
    writeFileLog(`console:${level.toUpperCase()}`, args);
    orig.apply(console, args);
  };
}

let httpServer = null;
let isFfmpegAvailable = false;
let ffmpegCmd = 'ffmpeg';

function resolveFfmpegPath() {
  const binName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const candidates = [];

  // Check explicit environment variable overrides
  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH);
  if (process.env.FFMPEG_BIN) candidates.push(process.env.FFMPEG_BIN);

  // 1. ffmpeg-static npm package (newest builds) - default export is the path
  try {
    const ffmpegStatic = require('ffmpeg-static');
    if (ffmpegStatic && typeof ffmpegStatic === 'string' && fs.existsSync(ffmpegStatic)) {
      candidates.push(ffmpegStatic);
    } else if (ffmpegStatic && typeof ffmpegStatic === 'object' && ffmpegStatic.path) {
      candidates.push(ffmpegStatic.path);
    }
  } catch (_) {}

  // 2. @ffmpeg-installer npm package path (if installed)
  try {
    const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
    if (ffmpegInstaller && ffmpegInstaller.path) {
      candidates.push(ffmpegInstaller.path.replace('app.asar', 'app.asar.unpacked'));
      candidates.push(ffmpegInstaller.path);
    }
  } catch (_) {}

  // 3. Root bin (copied during deployment) & cloud-local bin
  candidates.push(path.join(__dirname, '..', 'bin', binName));
  candidates.push(path.join(__dirname, 'bin', binName));

  // 4. System PATH fallback
  candidates.push('ffmpeg');

  for (const candidate of candidates) {
    if (!candidate) continue;
    const exists = (candidate === 'ffmpeg') || fs.existsSync(candidate);
    console.log(`[Transcoder] Checking ffmpeg candidate: "${candidate}" exists=${exists}`);
    if (!exists) continue;
    // Bundled binaries uploaded via scp often lose the executable bit.
    // If the file exists but isn't executable, fix the mode and retry.
    if (candidate !== 'ffmpeg') {
      try {
        const st = fs.statSync(candidate);
        console.log(`[Transcoder]   mode=0o${(st.mode & 0o777).toString(8)} size=${st.size}`);
        if (!(st.mode & 0o111)) {
          console.log(`[Transcoder] Setting executable bit on "${candidate}"`);
          fs.chmodSync(candidate, 0o755);
        }
      } catch (e) {
        console.log(`[Transcoder]   stat/chmod error: ${e.message}`);
      }
    }
    try {
      const ver = execSync(`"${candidate}" -version`, { stdio: 'pipe', timeout: 5000 }).toString();
      const ok = ver && ver.toLowerCase().includes('ffmpeg');
      console.log(`[Transcoder]   version check ok=${ok}`);
      if (ok) {
        return candidate;
      }
    } catch (e) {
      console.log(`[Transcoder]   version check failed: ${e.message}`);
    }
  }
  console.log('[Transcoder] No usable ffmpeg found.');
  return 'ffmpeg';
}

function getFfmpegPath() {
  if (ffmpegCmd !== 'ffmpeg' || isFfmpegAvailable) return ffmpegCmd;
  const resolved = resolveFfmpegPath();
  if (resolved !== 'ffmpeg') {
    isFfmpegAvailable = true;
    ffmpegCmd = resolved;
    console.log(`[Transcoder] FFmpeg ready at "${resolved}"`);
  }
  return ffmpegCmd;
}

// Detailed report of every ffmpeg location the server tries, so the state of
// the bundled binary can be inspected without shell access (served over HTTP).
function inspectFfmpegCandidates() {
  const binName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const results = [];
  try {
    const ffmpegStatic = require('ffmpeg-static');
    results.push({ source: 'ffmpeg-static', candidate: String(ffmpegStatic) });
  } catch (e) {
    results.push({ source: 'ffmpeg-static', candidate: null, error: e.message });
  }
  try {
    const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
    results.push({ source: '@ffmpeg-installer', candidate: ffmpegInstaller.path });
  } catch (e) {
    results.push({ source: '@ffmpeg-installer', candidate: null, error: 'not installed' });
  }
  results.push({ source: 'root bin (../bin)', candidate: path.join(__dirname, '..', 'bin', binName) });
  results.push({ source: 'local bin (./bin)', candidate: path.join(__dirname, 'bin', binName) });
  results.push({ source: 'PATH', candidate: 'ffmpeg' });

  for (const r of results) {
    if (r.candidate === null) continue;
    if (r.candidate === 'ffmpeg') {
      r.exists = true;
    } else {
      try { r.exists = fs.existsSync(r.candidate); } catch (e) { r.exists = false; r.error = e.message; }
    }
    if (r.exists && r.candidate !== 'ffmpeg') {
      try {
        const st = fs.statSync(r.candidate);
        r.mode = `0o${(st.mode & 0o777).toString(8)}`;
        r.size = st.size;
      } catch (e) { r.error = e.message; }
    }
    if (r.exists) {
      try {
        const ver = execSync(`"${r.candidate}" -version`, { stdio: 'pipe', timeout: 5000 }).toString();
        r.works = ver.toLowerCase().includes('ffmpeg');
        r.version = ver.split('\n')[0].trim();
      } catch (e) {
        r.works = false;
        r.error = e.message;
        r.stderr = (e.stderr && e.stderr.toString().trim()) || (e.stdout && e.stdout.toString().trim()) || '';
      }
    }
  }
  return results;
}

// The known-good static ffmpeg binary (Linux x64) that the server downloads
// and bundles itself when the local copy is missing or corrupt.
const FFMPEG_DOWNLOAD_URL = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-linux-x64';

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const doDownload = (u) => {
      const req = https.get(u, { headers: { 'User-Agent': 'FREEVEE-cloud-ffmpeg' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          doDownload(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => { file.close(() => resolve()); });
        file.on('error', reject);
        res.on('error', reject);
      });
      req.on('error', reject);
    };
    doDownload(url);
  });
}

// Replaces bin/ffmpeg with a freshly-downloaded, verified binary. Used as a
// self-heal when the bundled copy is missing, truncated, or not executable.
async function ensureFfmpegBundled() {
  const binName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const binPath = path.join(__dirname, 'bin', binName);
  const tmpPath = binPath + '.download';
  console.log('[Transcoder] Downloading known-good ffmpeg binary...');
  try {
    await downloadFile(FFMPEG_DOWNLOAD_URL, tmpPath);
    fs.chmodSync(tmpPath, 0o755);
    fs.renameSync(tmpPath, binPath);
    const resolved = resolveFfmpegPath();
    if (resolved !== 'ffmpeg') {
      isFfmpegAvailable = true;
      ffmpegCmd = resolved;
      console.log(`[Transcoder] FFmpeg ready at "${resolved}"`);
      return true;
    }
    console.warn('[Transcoder] Downloaded ffmpeg still fails verification.');
  } catch (e) {
    console.error('[Transcoder] ffmpeg download failed:', e.message);
  } finally {
    try { fs.rmSync(tmpPath, { force: true }); } catch (_) {}
  }
  return false;
}

function checkFfmpegAvailability() {
  const resolved = resolveFfmpegPath();
  if (resolved !== 'ffmpeg') {
    isFfmpegAvailable = true;
    ffmpegCmd = resolved;
    console.log(`[Transcoder] FFmpeg ready at "${resolved}"`);
  } else {
    console.warn('[Transcoder] WARNING: FFmpeg not found. Drive HLS transcoding will be unavailable.');
    // Self-heal: replace the bad/missing bundled binary with a fresh download.
    // `.catch` so a failed download can never crash the server via an
    // unhandled promise rejection.
    ensureFfmpegBundled().catch((e) => console.error('[Transcoder] ffmpeg self-heal error:', e.message));
  }
  // Persist a downloadable diagnostic report in the statically-served public dir
  // so the operator can see the ffmpeg state without shell access.
  try {
    const report = {
      timestamp: new Date().toISOString(),
      __dirname,
      process: { platform: process.platform, arch: process.arch, version: process.version },
      resolved,
      candidates: inspectFfmpegCandidates()
    };
    const publicPath = path.join(__dirname, 'public');
    if (fs.existsSync(publicPath)) {
      fs.writeFileSync(path.join(publicPath, 'ffmpeg-debug.json'), JSON.stringify(report, null, 2));
    }
  } catch (_) {}
}

const PORT = process.env.PORT || process.env.PORT_TV || 3001;
const BASE_URL = process.env.BASE_URL || (process.env.PORT ? `http://localhost:${process.env.PORT}` : `http://localhost:${PORT}`);
const TV_PUBLIC_URL = (process.env.TV_URL || (process.env.DOMAIN ? `https://tv.${process.env.DOMAIN}` : null) || BASE_URL).replace(/\/+$/, '');
const SESSION_SECRET = process.env.SESSION_SECRET || 'FREEVEE_cloud_secret_jwt_key_2026';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || process.env.GOOGLE_REDIRECT_URI_TV || `${TV_PUBLIC_URL}/auth/google/callback`;
const TORRENT_STREAM_SERVER = (process.env.TORRENT_STREAM_SERVER || process.env.DOWNLOADER_URL || 'http://download.butfree.online:4000').replace(/\/+$/, '');

// Hard-locked resource guardrails for Cloud VPS
const MAX_CONCURRENT_DOWNLOADS = 1;
const MAX_CONCURRENT_TRANSCODES = 1;

// On-demand HLS transcoding sessions (used by the Roku app to play Drive
// files that the Roku's native decoder can't handle directly, e.g. HEVC).
// ffmpeg writes .ts segments + index.m3u8 into a temp dir per session; the
// client re-polls the playlist and fetches segments via /api/stream/hls/:id/*.
const hlsSessions = new Map();
const HLS_IDLE_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4 hours to support full movies & pauses
const HLS_TRANSCODE_ACTIVE = new Set(); // session ids currently transcoding (guardrail cap)
// Maps a `<userId>:<fileId>` key to the active HLS session id so that Roku
// manifest re-polls hit the same transcode instead of spawning a new one.
const hlsActiveByKey = new Map();
// In-flight transcode startup promises by `<sessionKey>:<offset>` to prevent duplicate concurrent spawns
const hlsStartingByKeyOffset = new Map();

// On-demand content (Drive / torrent) is transcoded in bounded VOD chunks. Each chunk is a
// complete ~2-hour playlist ending in #EXT-X-ENDLIST, so Roku always sees a closed VOD
// playlist instead of an unbounded event list. The Roku app chains chunks via ?offset=.
const HLS_CHUNK_SECONDS = parseInt(process.env.HLS_CHUNK_SECONDS, 10) || 7200; // 2-hour chunks (7200s) default
// Function to resolve ffmpeg's input proxy URL.
// When running as a standalone Node service (e.g. systemd on Debian VPS or local dev),
// uses 127.0.0.1:PORT directly to bypass external reverse proxy (Nginx) timeouts,
// proxy buffer limits (proxy_max_temp_file_size), and TLS session renegotiation.
// In Passenger/cPanel deployments, Passenger intercepts app.listen() to use its own
// socket (the Node process never actually opens a TCP listener on PORT), so ffmpeg
// cannot reach 127.0.0.1:PORT. The availability is probed at startup and the public
// origin / BASE_URL is used instead in that case.
let isLoopbackPortOpen = null; // null = unknown, true = ffmpeg can reach 127.0.0.1:PORT
let isLoopbackProbeDone = false;
let loopbackProbePromise = null;

async function probeLoopbackPort(port) {
  return new Promise(async (resolve) => {
    try {
      const sock = net.createConnection({ host: '127.0.0.1', port }, () => {
        try { sock.destroy(); } catch (_) {}
        resolve(true);
      });
      sock.setTimeout(1200, () => {
        try { sock.destroy(); } catch (_) {}
        resolve(false);
      });
      sock.on('error', () => {
        try { sock.destroy(); } catch (_) {}
        resolve(false);
      });
    } catch (_) {
      resolve(false);
    }
  });
}

async function initLoopbackProbe() {
  if (isLoopbackProbeDone) return isLoopbackPortOpen;
  if (!loopbackProbePromise) {
    loopbackProbePromise = (async () => {
      const port = (typeof PORT === 'number' || (typeof PORT === 'string' && /^\d+$/.test(PORT))) ? Number(PORT) : 3000;
      isLoopbackPortOpen = await probeLoopbackPort(port);
      isLoopbackProbeDone = true;
      console.log(`[Transcoder] Probed ffmpeg input loopback 127.0.0.1:${port} -> ${isLoopbackPortOpen ? 'OPEN (using internal input URL)' : 'CLOSED (using public TV input URL)'}`);
      return isLoopbackPortOpen;
    })();
  }
  return loopbackProbePromise;
}

async function getFfmpegInputUrl(sessionId, fileId, req) {
  // Always wait for the probe so a very-fast-first request cannot pick the
  // wrong input URL before we know whether loopback is reachable.
  await initLoopbackProbe();
  const port = (typeof PORT === 'number' || (typeof PORT === 'string' && /^\d+$/.test(PORT))) ? PORT : 3000;

  // Prefer the public origin if loopback is definitely closed/unreachable.
  if (isLoopbackPortOpen === false) {
    if (TV_PUBLIC_URL && (TV_PUBLIC_URL.startsWith('http://') || TV_PUBLIC_URL.startsWith('https://')) && !TV_PUBLIC_URL.includes('localhost') && !TV_PUBLIC_URL.includes('127.0.0.1')) {
      return `${TV_PUBLIC_URL.replace(/\/+$/, '')}/api/stream/drive-hls-input/${sessionId}/${fileId}`;
    }
    if (req) {
      const origin = getHostOrigin(req);
      if (origin && !origin.includes('localhost') && !origin.includes('127.0.0.1')) {
        return `${origin}/api/stream/drive-hls-input/${sessionId}/${fileId}`;
      }
    }
  }

  // Default / gracefully degrade: internal loopback (works for standalone services).
  return `http://127.0.0.1:${port}/api/stream/drive-hls-input/${sessionId}/${fileId}`;
}

function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function cleanupHlsSession(sessionId, killFfmpeg = true) {
  const session = hlsSessions.get(sessionId);
  let pidToKill = session?.ffmpegProcess?.pid || null;
  if (!pidToKill) {
    const sessionJsonFile = path.join(CACHE_DIR, 'hls', sessionId, 'session.json');
    if (fs.existsSync(sessionJsonFile)) {
      try {
        const meta = JSON.parse(fs.readFileSync(sessionJsonFile, 'utf-8'));
        if (meta?.pid) pidToKill = meta.pid;
      } catch (_) {}
    }
  }
  if (killFfmpeg && pidToKill && isPidAlive(pidToKill)) {
    try {
      console.log(`[HLS Cleanup] Terminating FFmpeg pid=${pidToKill} for session=${sessionId}`);
      process.kill(pidToKill, 'SIGKILL');
    } catch (_) {}
  }
  if (session) {
    if (session.timer) clearTimeout(session.timer);
    if (killFfmpeg && session.ffmpegProcess && session.ffmpegProcess.exitCode === null) {
      try { session.ffmpegProcess.kill('SIGKILL'); } catch (_) {}
    }
    if (session.key && hlsActiveByKey.get(session.key) === sessionId) hlsActiveByKey.delete(session.key);
    if (session.fileId) {
      try { fs.rmSync(path.join(CACHE_DIR, 'hls', `active_${session.fileId}.json`), { force: true }); } catch (_) {}
    }
    hlsSessions.delete(sessionId);
    HLS_TRANSCODE_ACTIVE.delete(sessionId);
  }
  // Always remove the session directory on disk even if session was not in this worker's memory
  try { fs.rmSync(path.join(CACHE_DIR, 'hls', sessionId), { recursive: true, force: true }); } catch (_) {}
}

function touchHlsSession(sessionId) {
  const session = hlsSessions.get(sessionId);
  if (!session) return;
  if (session.timer) clearTimeout(session.timer);
  session.timer = setTimeout(() => cleanupHlsSession(sessionId), HLS_IDLE_TIMEOUT_MS);
}

const DATA_DIR = path.join(__dirname, 'data');
const USERS_DIR = path.join(DATA_DIR, 'users');
const CACHE_DIR = path.join(DATA_DIR, 'cache');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(USERS_DIR)) fs.mkdirSync(USERS_DIR, { recursive: true });
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// Purge any stale HLS transcode sessions and active files left from previous runs on startup
try {
  const hlsBaseDir = path.join(CACHE_DIR, 'hls');
  if (fs.existsSync(hlsBaseDir)) {
    const entries = fs.readdirSync(hlsBaseDir);
    for (const e of entries) {
      try { fs.rmSync(path.join(hlsBaseDir, e), { recursive: true, force: true }); } catch (_) {}
    }
  } else {
    fs.mkdirSync(hlsBaseDir, { recursive: true });
  }
} catch (_) {}

// ----------------- Chunked-VOD helpers (Drive & torrent HLS transcoding) -----------------

// Parse total file duration (in seconds) from ffmpeg's stderr "Duration:" line.
function parseFfmpegDuration(text) {
  const m = String(text || '').match(/Duration\s*:\s*(\d+):(\d{1,2}):(\d{1,2})(?:\.\d+)?/);
  if (!m) return null;
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
}

function readHlsMetaFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) || {};
  } catch (_) {
    return {};
  }
}

function writeHlsMetaFile(filePath, extra) {
  try {
    const existing = readHlsMetaFile(filePath);
    fs.writeFileSync(filePath, JSON.stringify(Object.assign({}, existing, extra)));
  } catch (_) {}
}

// Sum EXTINF durations + count segments in the playlist ffmpeg just wrote.
function computePlaylistStats(m3u8Path) {
  try {
    const content = fs.readFileSync(m3u8Path, 'utf-8');
    let dur = 0;
    let segs = 0;
    const re = /#EXTINF:\s*([0-9.]+)/g;
    let match;
    while ((match = re.exec(content)) !== null) {
      dur += parseFloat(match[1]);
      segs++;
    }
    return { durationSec: dur, segmentCount: segs };
  } catch (_) {
    return { durationSec: 0, segmentCount: 0 };
  }
}

// A request that starts a NEW chunk at `offset` is terminal (no more content) when:
//  - offset is at/past the parsed total duration, OR
//  - the previous chunk already ran into end-of-file (covers full-length final chunks
//    when the total duration could not be parsed from the container) and offset is at/past it.
function isTerminalChunkRequest(meta, offset) {
  if (!meta || !offset || offset <= 0) return false;
  const dur = meta.durationSec;
  if (typeof dur === 'number' && dur > 0 && offset >= dur - 2) return true;
  if (meta.atEndOfFile === true && typeof meta.lastChunkStart === 'number') {
    const endOffset = meta.lastChunkStart + (meta.chunkDurationSec || 0);
    if (endOffset > 0 && offset >= endOffset - 2) return true;
  }
  return false;
}

// Per-file chunking metadata (kept separate from the active-session file, which is deleted
// whenever a chunk boundary or new playback happens; persists across Passenger workers on disk).
const getHlsMetaFile = (fileId) => path.join(CACHE_DIR, 'hls', `meta_${fileId}.json`);
const getTorrentHlsMetaFile = (streamId, fileIndex) => path.join(CACHE_DIR, 'hls', `meta_torrent_${streamId}_${fileIndex}.json`);

// Terminal response: an empty playlist so Roku finishes instantly and stops chaining.
function sendTerminalPlaylist(res) {
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.end('#EXTM3U\n#EXT-X-ENDLIST\n');
}

// Pre-warming the next chunk means several sessions can exist for the same file at once
// (the chunk currently on screen + the next chunk transcoding in the background). Old
// finished chunks must be reaped once the player has moved past them, but never while the
// player might still be fetching their segments. Sessions whose ffmpeg is still running are
// always kept (their chunk is either playing or warming).
function pruneSameKeySessions(key, keepCount = 2, keepExplicit = null) {
  const ids = [];
  for (const [id, s] of hlsSessions) {
    if (s && s.key === key) ids.push(id);
  }
  ids.sort((a, b) => {
    const sa = hlsSessions.get(a);
    const sb = hlsSessions.get(b);
    return ((sa && sa.startedAt) || 0) - ((sb && sb.startedAt) || 0);
  });
  const safe = new Set();
  if (keepExplicit) safe.add(keepExplicit);
  for (let i = ids.length - 1; i >= 0 && safe.size < keepCount; i--) safe.add(ids[i]);
  for (const id of ids) {
    if (safe.has(id)) continue;
    const s = hlsSessions.get(id);
    if (s && s.ffmpegProcess && s.ffmpegProcess.exitCode !== null) {
      cleanupHlsSession(id);
    }
  }
}

const app = express();
// Request logging: every HTTP request is written to data/logs/server.log.
// Query tokens/passwords are redacted so secrets never hit the log.
const redactUrl = (url) => (url || '').replace(/([?&](?:token|password|secret|code|access_token)=)[^&]*/gi, '$1[REDACTED]');
app.use((req, res, next) => {
  const started = Date.now();
  let logged = false;
  const finishLog = (aborted) => {
    if (logged) return;
    logged = true;
    const ms = Date.now() - started;
    writeFileLog('HTTP', [req.method, aborted ? 'ABORTED' : String(res.statusCode), `${ms}ms`, redactUrl(req.originalUrl || req.url || '')]);
  };
  res.on('finish', () => finishLog(false));
  res.on('close', () => { if (!res.writableEnded) finishLog(true); });
  next();
});
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// Serve static public and frontend assets
const publicPath = path.join(__dirname, 'public');
if (fs.existsSync(publicPath)) {
  app.use(express.static(publicPath));
}

const distPath = path.join(__dirname, 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
}

// Serve downloadable TV app packages (Fire TV Cloud APK, Roku Cloud channel).
// Files live under public/tv/downloads (also served at /tv/downloads via the
// public static mount above); keep the /downloads alias for backwards compat.
const downloadsDir = path.join(__dirname, 'public', 'tv', 'downloads');
if (fs.existsSync(downloadsDir)) {
  app.use('/downloads', express.static(downloadsDir, {
    setHeaders: (res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Disposition', 'attachment');
    }
  }));
  console.log('[Cloud] Serving app downloads from /tv/downloads');
}

app.get(['/freevee.apk', '/tv.apk'], (req, res) => {
  const apkPath = path.join(publicPath, 'freevee.apk');
  if (fs.existsSync(apkPath)) {
    res.setHeader('Content-Disposition', 'attachment; filename="freevee.apk"');
    res.sendFile(apkPath);
  } else {
    res.status(404).send('freevee.apk not built yet. Run npm run build.');
  }
});

app.get(['/firetv.apk', '/freevee-firetv.apk'], (req, res) => {
  const apkPath = fs.existsSync(path.join(publicPath, 'firetv.apk'))
    ? path.join(publicPath, 'firetv.apk')
    : path.join(__dirname, 'public', 'tv', 'downloads', 'firetv.apk');
  if (fs.existsSync(apkPath)) {
    res.setHeader('Content-Disposition', 'attachment; filename="firetv.apk"');
    res.sendFile(apkPath);
  } else {
    res.status(404).send('firetv.apk not built yet. Run npm run build.');
  }
});

app.get(['/roku.zip', '/freevee-roku.zip'], (req, res) => {
  const zipPath = fs.existsSync(path.join(publicPath, 'roku.zip'))
    ? path.join(publicPath, 'roku.zip')
    : path.join(__dirname, 'public', 'tv', 'downloads', 'roku.zip');
  if (fs.existsSync(zipPath)) {
    res.setHeader('Content-Disposition', 'attachment; filename="roku.zip"');
    res.sendFile(zipPath);
  } else {
    res.status(404).send('roku.zip not built yet. Run npm run build.');
  }
});

// Legal and Compliance Routes (for Google OAuth Verification)
app.get(['/privacy', '/privacy.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});

app.get(['/terms', '/terms.html', '/toc', '/toc.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'terms.html'));
});

// -------------------------------------------------------------
// Multi-User Storage Helpers
// -------------------------------------------------------------
function getUserDir(userId) {
  const cleanId = String(userId).replace(/[^a-zA-Z0-9_-]/g, '_');
  const dir = path.join(USERS_DIR, cleanId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getUserFile(userId, filename, defaultValue = {}) {
  const filePath = path.join(getUserDir(userId), filename);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2), 'utf-8');
    return defaultValue;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return defaultValue;
  }
}

function saveUserFile(userId, filename, data) {
  const filePath = path.join(getUserDir(userId), filename);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// -------------------------------------------------------------
// Auth Middleware
// -------------------------------------------------------------
function getAuthToken(req) {
  return (
    req.query.token ||
    req.cookies.FREEVEE_token ||
    req.headers.authorization?.replace('Bearer ', '') ||
    null
  );
}

function authenticate(req, res, next) {
  const token = getAuthToken(req);
  if (!token) {
    return res.status(401).json({ success: false, error: 'Unauthorized. Please sign in.' });
  }
  try {
    const payload = jwt.verify(token, SESSION_SECRET);
    if (!isVipEmail(payload.email)) {
      return res.status(403).json({ success: false, code: 'VIP_ONLY', error: VIP_ONLY_MESSAGE });
    }
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Session expired. Please sign in again.' });
  }
}

function optionalAuth(req, res, next) {
  const token = getAuthToken(req);
  req.vipAccessDenied = false;
  if (token) {
    try {
      const payload = jwt.verify(token, SESSION_SECRET);
      if (isVipEmail(payload.email)) req.user = payload;
      else req.vipAccessDenied = true;
    } catch {}
  }
  next();
}

// -------------------------------------------------------------
// Administrator authorization uses the server-configured ADMIN_EMAIL.
// -------------------------------------------------------------
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const VIP_ONLY_MESSAGE = 'This suite is for VIPs only. This Google account is not on the access list.';

function isVipEmail(email) {
  const allowedEmails = new Set((process.env.VIP_EMAILS || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));
  if (ADMIN_EMAIL) allowedEmails.add(ADMIN_EMAIL);
  return typeof email === 'string' && allowedEmails.has(email.trim().toLowerCase());
}

function isAdminUser(user) {
  if (!user) return false;
  let email = user.email;
  if (!email && user.id) {
    try {
      const u = getUserFile(user.id, 'user.json', {});
      email = u?.email;
    } catch (_) {}
  }
  return typeof email === 'string' && !!ADMIN_EMAIL && email.trim().toLowerCase() === ADMIN_EMAIL;
}

function requireAdmin(req, res, next) {
  if (!req.user || !isAdminUser(req.user)) {
    return res.status(403).json({
      success: false,
      error: 'Access denied. Administrator privileges required.'
    });
  }
  next();
}

// -------------------------------------------------------------
// Google OAuth 2.0 Client & Token Management
// -------------------------------------------------------------
async function refreshGoogleAccessToken(userId) {
  const user = getUserFile(userId, 'user.json', {});
  if (!user.refreshToken) throw new Error('No Google refresh token found');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: user.refreshToken,
      grant_type: 'refresh_token'
    })
  });

  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || 'Failed to refresh Google token');
  }

  user.accessToken = data.access_token;
  user.tokenExpiresAt = Date.now() + data.expires_in * 1000;
  saveUserFile(userId, 'user.json', user);
  return data.access_token;
}

async function getValidGoogleToken(userId) {
  const user = getUserFile(userId, 'user.json', {});
  if (user.accessToken && user.tokenExpiresAt && user.tokenExpiresAt > Date.now() + 60000) {
    return user.accessToken;
  }
  return await refreshGoogleAccessToken(userId);
}

// Dynamically resolve an active Google access token for long-running streams or transcodes.
// Automatically refreshes nearing or expired tokens.
async function resolveGoogleToken(userIdHint) {
  if (userIdHint) {
    try {
      const token = await getValidGoogleToken(userIdHint);
      if (token) return { token, userId: userIdHint };
    } catch (err) {
      console.warn(`[Google Token] Failed to get valid token for user ${userIdHint}:`, err.message);
    }
  }
  try {
    const userDirs = fs.readdirSync(USERS_DIR);
    for (const u of userDirs) {
      try {
        const token = await getValidGoogleToken(u);
        if (token) return { token, userId: u };
      } catch (_) {}
    }
  } catch (_) {}
  return { token: null, userId: userIdHint || null };
}

// Force a token refresh when Google Drive returns 401 Unauthorized or 403 Forbidden mid-stream
async function forceRefreshGoogleToken(userIdHint) {
  if (userIdHint) {
    try {
      const token = await refreshGoogleAccessToken(userIdHint);
      if (token) return { token, userId: userIdHint };
    } catch (err) {
      console.warn(`[Google Token] Force refresh failed for user ${userIdHint}:`, err.message);
    }
  }
  try {
    const userDirs = fs.readdirSync(USERS_DIR);
    for (const u of userDirs) {
      try {
        const token = await refreshGoogleAccessToken(u);
        if (token) return { token, userId: u };
      } catch (_) {}
    }
  } catch (_) {}
  return { token: null, userId: userIdHint || null };
}

// -------------------------------------------------------------
// Auth Routes
// -------------------------------------------------------------
app.get('/auth/google', (req, res) => {
  if (!GOOGLE_CLIENT_ID) {
    return res.status(500).send('Google Client ID not configured in .env');
  }
  const scopes = [
    'openid',
    'email',
    'profile',
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/drive.metadata.readonly',
    'https://www.googleapis.com/auth/drive'
  ].join(' ');

  // Pass the device pairing code through Google's OAuth `state` param so the
  // redirect_uri stays EXACTLY equal to the registered GOOGLE_REDIRECT_URI
  // (appending a query string to redirect_uri causes Google to block the
  // request with redirect_uri_mismatch). Google echoes `state` back unchanged.
  let stateParam = '{}';
  if (req.query.device_code) {
    stateParam = JSON.stringify({ device_code: String(req.query.device_code) });
  }

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` + new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: scopes,
    access_type: 'offline',
    prompt: 'consent select_account',
    include_granted_scopes: 'true',
    state: stateParam
  }).toString();

  res.redirect(authUrl);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, error, state } = req.query;
  if (error || !code) {
    return res.redirect(`/?auth_error=${encodeURIComponent(error || 'Authorization denied')}`);
  }

  // Decode the device pairing code from the echoed `state` param
  let deviceCode = null;
  if (state) {
    try {
      const parsed = JSON.parse(state);
      deviceCode = parsed.device_code || null;
    } catch (_) {
      deviceCode = null;
    }
  }

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        code: String(code),
        grant_type: 'authorization_code',
        redirect_uri: GOOGLE_REDIRECT_URI
      })
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(tokenData.error_description || 'Failed to exchange authorization code');

    // Fetch Google User Profile
    const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const profile = await profileRes.json();
    if (!profileRes.ok || profile.error) throw new Error(profile.error?.message || 'Failed to fetch Google profile');
    if (!isVipEmail(profile.email)) {
      return res.redirect(`/?auth_error=${encodeURIComponent(VIP_ONLY_MESSAGE)}`);
    }
    const userId = profile.id || profile.email;

    const existing = getUserFile(userId, 'user.json', {});
    const userData = {
      ...existing,
      id: userId,
      email: profile.email,
      name: profile.name || profile.email.split('@')[0],
      picture: profile.picture,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || existing.refreshToken,
      tokenExpiresAt: Date.now() + tokenData.expires_in * 1000,
      updatedAt: new Date().toISOString()
    };
    saveUserFile(userId, 'user.json', userData);

    // Issue JWT Session Cookie
    const sessionToken = jwt.sign(
      { id: userId, email: profile.email, name: userData.name, picture: profile.picture },
      SESSION_SECRET,
      { expiresIn: '30d' }
    );

    res.cookie('FREEVEE_token', sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 30 * 24 * 60 * 60 * 1000,
      sameSite: 'lax'
    });

    // If this was a device pairing flow, complete it
    if (deviceCode) {
      devicePairingStore = loadPairingStore();
      const entry = devicePairingStore[String(deviceCode)];
      if (entry && !entry.completed) {
        entry.completed = true;
        entry.userId = userId;
        entry.token = sessionToken;
        savePairingStore(devicePairingStore);
      }
    }

    res.redirect('/');
  } catch (err) {
    console.error('[OAuth] Callback error:', err);
    res.redirect(`/?auth_error=${encodeURIComponent(err.message)}`);
  }
});

// Diagnostic: reports every ffmpeg candidate the server checks and its state.
// No auth required so it can be viewed in a browser without shell access.
// Append ?install=1 to force a fresh download of the known-good binary first.
app.get('/api/debug/ffmpeg', async (req, res) => {
  if (req.query.install === '1') {
    await ensureFfmpegBundled();
  }
  const report = {
    timestamp: new Date().toISOString(),
    __dirname,
    process: { platform: process.platform, arch: process.arch, version: process.version },
    ffmpegInputUrl: await getFfmpegInputUrl('test-session', 'test-file'),
    resolved: resolveFfmpegPath(),
    candidates: inspectFfmpegCandidates()
  };
  res.json(report);
});

app.get('/api/debug/probe/:sessionId/:file', (req, res) => {
  const { sessionId, file } = req.params;
  const filePath = path.join(CACHE_DIR, 'hls', sessionId, file);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('File not found: ' + filePath);
  }
  const ffmpegCmd = getFfmpegPath();
  try {
    const out = execSync(`"${ffmpegCmd}" -i "${filePath}" 2>&1`, { encoding: 'utf-8' });
    res.type('text/plain').send(out);
  } catch (err) {
    res.type('text/plain').send(err.stdout || err.stderr || err.message);
  }
});

app.get('/auth/me', optionalAuth, (req, res) => {
  if (!req.user) {
    return res.json({
      authenticated: false,
      googleConfigured: !!GOOGLE_CLIENT_ID,
      ...(req.vipAccessDenied ? { code: 'VIP_ONLY', error: VIP_ONLY_MESSAGE } : {})
    });
  }
  const user = getUserFile(req.user.id, 'user.json', {});
  const folders = getUserFile(req.user.id, 'folders.json', {});
  const email = user.email || req.user.email;
  const isAdmin = isAdminUser({ ...req.user, email });
  res.json({
    authenticated: true,
    user: {
      id: req.user.id,
      name: user.name || req.user.name,
      email: email,
      picture: user.picture || req.user.picture,
      isAdmin
    },
    googleDriveConnected: !!user.refreshToken || !!user.accessToken,
    folders: {
      tv: folders.tv || null,
      movies: folders.movies || null
    },
    limits: {
      maxDownloads: MAX_CONCURRENT_DOWNLOADS,
      maxTranscodes: MAX_CONCURRENT_TRANSCODES
    }
  });
});

app.post('/auth/logout', (req, res) => {
  res.clearCookie('FREEVEE_token');
  res.json({ success: true });
});

// -------------------------------------------------------------
// Server Process Management (cPanel / Phusion Passenger / PM2 / VPS)
// -------------------------------------------------------------
app.get('/api/server/status', authenticate, requireAdmin, (req, res) => {
  const uptimeSeconds = Math.floor(process.uptime());
  const mem = process.memoryUsage();
  res.json({
    success: true,
    status: 'online',
    uptime: uptimeSeconds,
    nodeVersion: process.version,
    platform: process.platform,
    memory: {
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024)
    },
    pid: process.pid
  });
});

function performServerRestart() {
  const isPassenger = typeof PhusionPassenger !== 'undefined' || !!process.env.PASSENGER_APP_ENV;
  const isPm2 = typeof process.env.pm_id !== 'undefined' || !!process.env.PM2_HOME;

  console.log(`[Server] Initiating restart sequence (isPassenger=${isPassenger}, isPm2=${isPm2})...`);

  const spawnReplacement = () => {
    if (!isPassenger && !isPm2) {
      try {
        console.log('[Server] Spawning replacement Node process...');
        const child = spawn(process.argv[0], process.argv.slice(1), {
          cwd: process.cwd(),
          detached: true,
          stdio: 'inherit',
          env: process.env
        });
        child.unref();
        console.log(`[Server] Replacement process started (PID: ${child.pid})`);
      } catch (err) {
        console.error('[Server] Failed to spawn replacement process:', err.message);
      }
    }
    process.exit(0);
  };

  if (httpServer) {
    try {
      if (typeof httpServer.closeAllConnections === 'function') {
        httpServer.closeAllConnections();
      }
      httpServer.close(() => {
        spawnReplacement();
      });
      setTimeout(spawnReplacement, 500);
      return;
    } catch (_) {}
  }

  spawnReplacement();
}

app.post('/api/server/restart', authenticate, requireAdmin, (req, res) => {
  console.log(`[Server] Restart initiated by user: ${req.user?.name || req.user?.email || req.user?.id || 'unknown'}`);

  // 1. Touch tmp/restart.txt for cPanel / Phusion Passenger
  const restartCandidates = [
    path.join(__dirname, 'tmp', 'restart.txt'),
    path.join(__dirname, '..', 'tmp', 'restart.txt')
  ];
  for (const rPath of restartCandidates) {
    try {
      fs.mkdirSync(path.dirname(rPath), { recursive: true });
      fs.writeFileSync(rPath, String(Date.now()), 'utf-8');
      console.log(`[Server] Updated restart signal at ${rPath}`);
    } catch (e) {
      console.warn(`[Server] Could not write ${rPath}: ${e.message}`);
    }
  }

  // 2. Respond to the client so UI gets the confirmation before the process exits
  res.json({
    success: true,
    message: 'Server restart initiated. The server is restarting...'
  });

  // 3. Gracefully reboot
  setTimeout(() => {
    performServerRestart();
  }, 500);
});

// -------------------------------------------------------------
// Device Pairing (Roku login via code)
// -------------------------------------------------------------
const PAIRING_FILE = path.join(DATA_DIR, 'pairing.json');

function loadPairingStore() {
  try {
    if (fs.existsSync(PAIRING_FILE)) {
      return JSON.parse(fs.readFileSync(PAIRING_FILE, 'utf-8'));
    }
  } catch (_) {}
  return {};
}

function savePairingStore(store) {
  try {
    fs.writeFileSync(PAIRING_FILE, JSON.stringify(store, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Pairing] Failed to save store:', err.message);
  }
}

let devicePairingStore = loadPairingStore();

// Clean up expired codes (persisted so a server restart doesn't lose the code)
function cleanupPairingStore() {
  const now = Date.now();
  let changed = false;
  for (const k of Object.keys(devicePairingStore)) {
    if (now - devicePairingStore[k].createdAt > 5 * 60 * 1000) {
      delete devicePairingStore[k];
      changed = true;
    }
  }
  if (changed) savePairingStore(devicePairingStore);
}

function generatePairingCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (devicePairingStore[code]);
  return code;
}

// Generate a new pairing code
app.get('/auth/device/code', (req, res) => {
  devicePairingStore = loadPairingStore();
  cleanupPairingStore();
  const code = generatePairingCode();
  devicePairingStore[code] = {
    completed: false,
    userId: null,
    token: null,
    createdAt: Date.now()
  };
  savePairingStore(devicePairingStore);
  res.json({ code, expiresIn: 300 });
});

// Roku polls this until pairing completes (small payload, no token)
app.get('/auth/device/status/:code', (req, res) => {
  devicePairingStore = loadPairingStore();
  const entry = devicePairingStore[req.params.code];
  if (!entry) return res.json({ status: 'expired' });
  if (Date.now() - entry.createdAt > 5 * 60 * 1000) {
    delete devicePairingStore[req.params.code];
    savePairingStore(devicePairingStore);
    return res.json({ status: 'expired' });
  }
  if (!entry.completed) return res.json({ status: 'pending' });
  res.json({ status: 'complete', userId: entry.userId });
});

// Roku fetches the JWT once status is complete
app.get('/auth/device/token/:code', (req, res) => {
  devicePairingStore = loadPairingStore();
  const entry = devicePairingStore[req.params.code];
  if (!entry) return res.json({ success: false, error: 'Code not found' });
  if (Date.now() - entry.createdAt > 5 * 60 * 1000) {
    delete devicePairingStore[req.params.code];
    savePairingStore(devicePairingStore);
    return res.json({ success: false, error: 'Code expired' });
  }
  if (!entry.completed || !entry.token) {
    return res.json({ success: false, error: 'Not completed' });
  }
  const token = entry.token;
  // One-time retrieval: remove the store entry now that the Roku has the token
  delete devicePairingStore[req.params.code];
  savePairingStore(devicePairingStore);
  res.json({ success: true, token });
});

// Phone opens this page, enters code, authenticates with Google
app.get('/device', (req, res) => {
  const deviceCode = req.query.code || '';
  const error = req.query.error || '';
  res.type('html').send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>FREEVEE - Connect TV</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0b10;color:#e0e0e0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
  .card{background:#14161f;border:1px solid #1a1e2c;border-radius:16px;padding:40px 32px;max-width:400px;width:100%;text-align:center}
  h1{font-size:24px;margin-bottom:8px;color:#fff}
  .subtitle{color:#a3a8b8;margin-bottom:24px;font-size:14px}
  .icon{width:64px;height:64px;background:#e50914;border-radius:16px;margin:0 auto 20px;display:flex;align-items:center;justify-content:center;font-size:28px}
  input{width:100%;padding:14px 16px;border:2px solid #2a2e3f;border-radius:10px;background:#0d0e15;color:#fff;font-size:24px;text-align:center;letter-spacing:8px;text-transform:uppercase;font-weight:600;margin-bottom:16px;outline:none;transition:border-color .2s}
  input:focus{border-color:#e50914}
  input::placeholder{color:#3a3e4f;letter-spacing:4px;font-size:18px}
  button{width:100%;padding:14px;border:none;border-radius:10px;font-size:16px;font-weight:600;cursor:pointer;transition:all .2s;margin-bottom:12px}
  .btn-primary{background:#e50914;color:#fff}
  .btn-primary:hover{background:#ff1a25}
  .btn-primary:disabled{background:#2a2e3f;color:#666;cursor:not-allowed}
  .btn-secondary{background:transparent;color:#a3a8b8;border:1px solid #2a2e3f}
  .btn-secondary:hover{border-color:#a3a8b8;color:#fff}
  .btn-google{background:#fff;color:#333;display:flex;align-items:center;justify-content:center;gap:10px;font-size:15px}
  .btn-google:hover{background:#f0f0f0}
  .btn-google svg{width:20px;height:20px}
  .error{color:#e50914;font-size:13px;margin-bottom:16px}
  .success{color:#4caf50;font-size:14px;margin:20px 0}
  .success-icon{font-size:48px;margin-bottom:12px}
  .hidden{display:none}
  .step{margin-bottom:20px}
  .step-label{font-size:12px;color:#a3a8b8;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px}
  .or-divider{display:flex;align-items:center;gap:12px;margin:16px 0;color:#3a3e4f;font-size:13px}
  .or-divider::before,.or-divider::after{content:'';flex:1;height:1px;background:#1a1e2c}
  .account-info{background:#0d0e15;border:1px solid #1a1e2c;border-radius:10px;padding:12px;margin-bottom:16px;display:flex;align-items:center;gap:12px}
  .account-info img{width:36px;height:36px;border-radius:50%}
  .account-info .name{font-size:14px;font-weight:500}
  .account-info .email{font-size:12px;color:#a3a8b8}
</style></head><body>
<div class="card">
  <div class="icon">&#128250;</div>
  <h1>Connect Your TV</h1>
  <p class="subtitle">Enter the 6-digit code shown on your TV screen</p>
  ${error ? '<p class="error">' + error + '</p>' : ''}

  <div id="step-enter" class="step">
    <input type="text" id="codeInput" placeholder="XXXXXX" maxlength="6" value="${deviceCode}" autocomplete="off" autocapitalize="characters" spellcheck="false" />
    <button class="btn-primary" id="verifyBtn" onclick="verifyCode()">Connect</button>
  </div>

  <div id="step-auth" class="step hidden">
    <p style="margin-bottom:16px;color:#a3a8b8">Code verified! Now sign in with Google to link your account.</p>
    <div id="accountInfo"></div>
    <a id="googleLink" href="/auth/google" class="btn-google" style="display:flex;text-decoration:none;justify-content:center">
      <svg viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
      Sign in with Google
    </a>
  </div>

  <div id="step-done" class="step hidden">
    <div class="success-icon">&#10003;</div>
    <h2 style="color:#4caf50;margin-bottom:8px">All Set!</h2>
    <p class="success">Your TV is now connected.<br>You can close this page and return to your TV.</p>
  </div>

  <div id="step-expired" class="step hidden">
    <p style="color:#a3a8b8;margin-bottom:16px">This pairing code has expired.</p>
    <button class="btn-secondary" onclick="location.reload()">Try Again</button>
  </div>
</div>
<script>
  var deviceCode = ${JSON.stringify(deviceCode)};
  function verifyCode() {
    var code = document.getElementById('codeInput').value.trim().toUpperCase();
    if (code.length !== 6) return;
    document.getElementById('verifyBtn').textContent = 'Verifying...';
    document.getElementById('verifyBtn').disabled = true;
    fetch('/auth/device/status/' + code).then(function(r){return r.json()}).then(function(d) {
      if (d.status === 'expired' || d.status === 'error') {
        document.getElementById('step-expired').classList.remove('hidden');
        document.getElementById('step-enter').classList.add('hidden');
      } else {
        deviceCode = code;
        document.getElementById('step-enter').classList.add('hidden');
        document.getElementById('step-auth').classList.remove('hidden');
        document.getElementById('googleLink').href = '/auth/google?device_code=' + code;
      }
    }).catch(function() {
      document.getElementById('verifyBtn').textContent = 'Connect';
      document.getElementById('verifyBtn').disabled = false;
      alert('Error verifying code. Please try again.');
    });
  }
  document.getElementById('codeInput').addEventListener('keyup', function(e) {
    if (e.key === 'Enter') verifyCode();
  });
  if (deviceCode && deviceCode.length === 6) {
    document.getElementById('step-enter').classList.add('hidden');
    document.getElementById('step-auth').classList.remove('hidden');
    document.getElementById('googleLink').href = '/auth/google?device_code=' + deviceCode;
  }
</script></body></html>`);
});

// -------------------------------------------------------------
// Google Drive API & Folder Browser
// -------------------------------------------------------------
app.get('/api/drive/folders', authenticate, async (req, res) => {
  try {
    const accessToken = await getValidGoogleToken(req.user.id);
    const parentId = req.query.parentId || 'root';

    const q = parentId === 'root'
      ? `('root' in parents or sharedWithMe = true) and mimeType = 'application/vnd.google-apps.folder' and trashed = false`
      : `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
    const driveUrl = `https://www.googleapis.com/drive/v3/files?` + new URLSearchParams({
      q,
      fields: 'files(id, name, mimeType, modifiedTime, capabilities(canAddChildren, canEdit), ownedByMe, shared)',
      orderBy: 'name',
      pageSize: '100',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true'
    });

    const response = await fetch(driveUrl, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const data = await response.json();

    if (!response.ok) throw new Error(data.error?.message || 'Failed to list Google Drive folders');
    const folders = (data.files || []).map(f => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      modifiedTime: f.modifiedTime,
      canAddChildren: f.capabilities?.canAddChildren ?? true,
      canEdit: f.capabilities?.canEdit ?? true,
      ownedByMe: f.ownedByMe ?? true,
      shared: f.shared ?? false
    }));
    res.json({ success: true, folders });
  } catch (err) {
    console.error('[Drive] List folders error:', err);
    const isReauth = err.message && (err.message.includes('refresh token') || err.message.includes('invalid_grant'));
    res.status(isReauth ? 401 : 500).json({
      success: false,
      error: isReauth ? 'Google re-authentication required. Please sign in with Google again.' : err.message,
      reauth: !!isReauth
    });
  }
});

app.post('/api/drive/set-folders', authenticate, async (req, res) => {
  try {
    const { tvFolder, moviesFolder } = req.body;
    let accessToken = null;
    try {
      accessToken = await getValidGoogleToken(req.user.id);
    } catch (_) {}

    const current = getUserFile(req.user.id, 'folders.json', {});

    const resolveFolder = async (newFolder, existingFolder) => {
      if (newFolder === undefined) return existingFolder;
      if (!newFolder || !newFolder.id) return null;
      if (newFolder.id === 'root') {
        return { id: 'root', name: newFolder.name || 'My Drive', canAddChildren: true, canEdit: true, ownedByMe: true, shared: false };
      }
      if (typeof newFolder.canAddChildren === 'boolean' && typeof newFolder.ownedByMe === 'boolean') {
        return {
          id: newFolder.id,
          name: newFolder.name,
          canAddChildren: newFolder.canAddChildren,
          canEdit: newFolder.canEdit !== undefined ? newFolder.canEdit : newFolder.canAddChildren,
          ownedByMe: newFolder.ownedByMe,
          shared: newFolder.shared ?? !newFolder.ownedByMe
        };
      }
      if (accessToken) {
        try {
          const driveRes = await fetch(
            `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(newFolder.id)}?fields=id,name,capabilities(canAddChildren,canEdit),ownedByMe,shared&supportsAllDrives=true`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );
          if (driveRes.ok) {
            const meta = await driveRes.json();
            return {
              id: newFolder.id,
              name: newFolder.name || meta.name,
              canAddChildren: meta.capabilities?.canAddChildren ?? true,
              canEdit: meta.capabilities?.canEdit ?? true,
              ownedByMe: meta.ownedByMe ?? true,
              shared: meta.shared ?? false
            };
          }
        } catch (err) {
          console.warn('[Drive] Error resolving folder capabilities:', err.message);
        }
      }
      return {
        id: newFolder.id,
        name: newFolder.name,
        canAddChildren: newFolder.canAddChildren !== undefined ? newFolder.canAddChildren : true,
        canEdit: newFolder.canEdit !== undefined ? newFolder.canEdit : true,
        ownedByMe: newFolder.ownedByMe !== undefined ? newFolder.ownedByMe : true,
        shared: newFolder.shared ?? false
      };
    };

    const tv = await resolveFolder(tvFolder, current.tv);
    const movies = await resolveFolder(moviesFolder, current.movies);

    const updated = {
      ...current,
      tv,
      movies,
      updatedAt: new Date().toISOString()
    };
    saveUserFile(req.user.id, 'folders.json', updated);
    res.json({ success: true, folders: updated });
  } catch (err) {
    console.error('[Drive] Set folders error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------------
// Google Drive Media Scanner
// -------------------------------------------------------------
async function fetchFolderFilesRecursive(accessToken, folderId, folderPath = '', userId = null, target = 'tv') {
  let allFiles = [];
  let pageToken = null;
  let currentToken = accessToken;

  do {
    const q = `'${folderId}' in parents and trashed = false`;
    const params = new URLSearchParams({
      q,
      fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime, thumbnailLink)',
      pageSize: '200'
    });
    if (pageToken) params.set('pageToken', pageToken);

    let res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
      headers: { Authorization: `Bearer ${currentToken}` }
    });

    if (res.status === 401 && userId) {
      try {
        console.log(`[Drive Scan] Access token expired mid-scan for user ${userId}, refreshing...`);
        currentToken = await refreshGoogleAccessToken(userId);
        res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
          headers: { Authorization: `Bearer ${currentToken}` }
        });
      } catch (refErr) {
        console.warn(`[Drive Scan] Mid-scan token refresh failed:`, refErr.message);
      }
    }

    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'Error fetching drive files');

    const files = data.files || [];
    if (userId) {
      const cur = getScanProgress(userId);
      const base = target === 'tv' ? (cur?.tvFiles || 0) : (cur?.movieFiles || 0);
      setScanProgress(userId, {
        stage: 'walking',
        scanning: true,
        message: `Scanning ${target === 'tv' ? 'TV Shows' : 'Movies'} folder (${cur?.foldersScanned || 0} folders, ${base} files)...`,
        foldersScanned: (cur?.foldersScanned || 0) + 1
      });
    }
    for (const f of files) {
      if (f.mimeType === 'application/vnd.google-apps.folder') {
        const subFiles = await fetchFolderFilesRecursive(currentToken, f.id, `${folderPath}/${f.name}`, userId, target);
        allFiles = allFiles.concat(subFiles);
      } else {
        const ext = path.extname(f.name).toLowerCase();
        const isVideo = ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v'].includes(ext) || (f.mimeType || '').startsWith('video/');
        if (isVideo) {
          allFiles.push({
            ...f,
            relPath: `${folderPath}/${f.name}`,
            folderPath: folderPath,
            extension: ext
          });
        }
      }
    }
    if (userId) {
      const cur = getScanProgress(userId);
      setScanProgress(userId, {
        stage: 'walking',
        scanning: true,
        message: `Found ${allFiles.length} ${target === 'tv' ? 'episodes' : 'movies'} so far...`
      });
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  return allFiles;
}

const posterCacheFile = path.join(CACHE_DIR, 'drive_posters.json');
let drivePosterCache = {};
if (fs.existsSync(posterCacheFile)) {
  try { drivePosterCache = JSON.parse(fs.readFileSync(posterCacheFile, 'utf-8')); } catch {}
}

function saveDrivePosterCache() {
  try { fs.writeFileSync(posterCacheFile, JSON.stringify(drivePosterCache, null, 2), 'utf-8'); } catch {}
}

async function fetchShowPoster(showName) {
  if (!showName) return null;
  const k = `tv_${showName.toLowerCase()}`;
  if (drivePosterCache[k]) return drivePosterCache[k];

  try {
    const clean = showName.replace(/\(.*?\)/g, '').trim();
    const res = await fetch(`https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(clean)}`);
    if (res.ok) {
      const data = await res.json();
      const img = data?.image?.medium || data?.image?.original || null;
      if (img) {
        drivePosterCache[k] = img;
        saveDrivePosterCache();
        return img;
      }
    }
  } catch {}
  return null;
}

async function fetchMovieMeta(movieTitle, year) {
  if (!movieTitle) return { poster: null, posterUrl: null, genres: [] };
  const cleanTitle = movieTitle.replace(/\(.*?\)/g, '').replace(/[._\-]/g, ' ').replace(/\s+/g, ' ').trim();
  const k = `movie_${cleanTitle.toLowerCase()}_${year || ''}`;

  if (drivePosterCache[k]) {
    const cached = drivePosterCache[k];
    const cachedPoster = typeof cached === 'string' ? cached : (cached.poster || cached.posterUrl || null);
    const cachedGenres = typeof cached === 'string' ? [] : (cached.genres || []);
    if (cachedPoster) {
      return { poster: cachedPoster, posterUrl: cachedPoster, genres: cachedGenres };
    }
  }

  let poster = null;
  let genres = [];

  // 1. Try Apple iTunes Search API (fast, high-resolution 600x900 cover art)
  try {
    const q = year ? `${cleanTitle} ${year}` : cleanTitle;
    const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=movie&limit=1`;
    const itunesRes = await fetch(itunesUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (itunesRes.ok) {
      const itunesJson = await itunesRes.json();
      if (itunesJson.results && itunesJson.results.length > 0) {
        const art = itunesJson.results[0].artworkUrl100;
        if (art) {
          poster = art.replace('100x100bb', '600x900bb');
        }
        if (itunesJson.results[0].primaryGenreName) {
          genres.push(itunesJson.results[0].primaryGenreName);
        }
      }
    }
  } catch (_) {}

  // 2. Try Cinemeta (Stremio metadata provider)
  if (!poster) {
    try {
      const q = year ? `${cleanTitle} ${year}` : cleanTitle;
      const res = await fetch(`https://v3-cinemeta.strem.io/catalog/movie/top/search=${encodeURIComponent(q)}.json`);
      if (res.ok) {
        const data = await res.json();
        const meta = data?.metas?.[0];
        if (meta) {
          if (meta.poster) poster = meta.poster;
          const metaGenres = Array.isArray(meta.genre) ? meta.genre : (Array.isArray(meta.genres) ? meta.genres : []);
          if (metaGenres.length > 0) genres = metaGenres;
        }
      }
    } catch (_) {}
  }

  // 3. Try Wikipedia REST API summary
  if (!poster) {
    try {
      const wikiSearchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(cleanTitle + ' film')}&format=json&origin=*`;
      const wikiSearchRes = await fetch(wikiSearchUrl);
      if (wikiSearchRes.ok) {
        const wikiSearchJson = await wikiSearchRes.json();
        const firstResult = wikiSearchJson.query?.search?.[0];
        if (firstResult) {
          const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(firstResult.title.replace(/ /g, '_'))}`;
          const summaryRes = await fetch(summaryUrl);
          if (summaryRes.ok) {
            const summaryJson = await summaryRes.json();
            poster = summaryJson.thumbnail?.source || summaryJson.originalimage?.source || null;
          }
        }
      }
    } catch (_) {}
  }

  // 4. Try TVMaze fallback
  if (!poster) {
    try {
      const res = await fetch(`https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(cleanTitle)}`);
      if (res.ok) {
        const data = await res.json();
        poster = data?.image?.original || data?.image?.medium || null;
      }
    } catch (_) {}
  }

  if (poster) {
    drivePosterCache[k] = { poster, posterUrl: poster, genres };
    saveDrivePosterCache();
  }

  return { poster, posterUrl: poster, genres };
}

// -------------------------------------------------------------
// Drive Scan Progress Tracking
// -------------------------------------------------------------
const scanProgressStore = new Map(); // userId -> progress object

function getScanProgress(userId) {
  return scanProgressStore.get(userId) || null;
}
function setScanProgress(userId, patch) {
  const cur = scanProgressStore.get(userId) || {
    scanning: true,
    stage: 'idle',
    message: '',
    tvFiles: 0,
    movieFiles: 0,
    foldersScanned: 0,
    showsProcessed: 0,
    totalShows: 0,
    moviesProcessed: 0,
    totalMovies: 0
  };
  scanProgressStore.set(userId, Object.assign({}, cur, patch));
  return scanProgressStore.get(userId);
}
function clearScanProgress(userId) {
  scanProgressStore.delete(userId);
}

// -------------------------------------------------------------
// Google Drive Media Scanner & Background 4-Hour Scheduler
// -------------------------------------------------------------
const DRIVE_AUTO_SCAN_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const DRIVE_AUTO_SCAN_CHECK_INTERVAL_MS = 15 * 60 * 1000; // Check every 15 minutes
const activeScanPromises = new Map(); // userId -> Promise<libraryData>

async function scanUserDrive(userId) {
  if (!userId) throw new Error('User ID is required to scan Google Drive');

  // If a scan is already running for this user, join the existing promise
  if (activeScanPromises.has(userId)) {
    console.log(`[Drive Scan] Scan already running for user ${userId}; joining active scan.`);
    return activeScanPromises.get(userId);
  }

  const scanPromise = (async () => {
    try {
      const folders = getUserFile(userId, 'folders.json', {});
      if (!folders?.tv?.id && !folders?.movies?.id) {
        console.log(`[Drive Scan] User ${userId} has no TV or Movies folders configured.`);
        return null;
      }

      console.log(`[Drive Scan] Starting scan for user ${userId}...`);
      setScanProgress(userId, { scanning: true, stage: 'walking', message: 'Scanning folders...' });

      const accessToken = await getValidGoogleToken(userId);

      const tvFiles = folders.tv?.id
        ? await fetchFolderFilesRecursive(accessToken, folders.tv.id, folders.tv.name || 'TV', userId, 'tv')
        : [];
      const movieFiles = folders.movies?.id
        ? await fetchFolderFilesRecursive(accessToken, folders.movies.id, folders.movies.name || 'Movies', userId, 'movies')
        : [];

      setScanProgress(userId, {
        scanning: true,
        stage: 'parse',
        message: `Organizing ${tvFiles.length} episodes and ${movieFiles.length} movies...`,
        tvFiles: tvFiles.length,
        movieFiles: movieFiles.length
      });

      // Parse TV Shows and Episodes
      const shows = {};
      const showsList = [];

      for (const f of tvFiles) {
        const name = f.name;
        // Match pattern: Show.Name.S01E02 or Show Name - S01E02
        const match = name.match(/^(.*?)[ ._-]+[sS](\d{1,2})[eE](\d{1,2})(?:[ ._-]+(.*?))?(?:\.[a-zA-Z0-9]+)$/i);
        let showName = 'TV Series';
        let seasonNum = '1';
        let episodeNum = 1;
        let epTitle = name.replace(/\.[^/.]+$/, '');

        if (match) {
          showName = match[1].replace(/[._]/g, ' ').trim();
          seasonNum = String(parseInt(match[2], 10));
          episodeNum = parseInt(match[3], 10);
          if (match[4]) epTitle = match[4].replace(/[._]/g, ' ').trim();
        } else {
          // Folder name as show name fallback
          const parts = f.relPath.split('/');
          if (parts.length > 2) showName = parts[1];
        }

        if (!shows[showName]) {
          shows[showName] = {};
          showsList.push(showName);
        }
        if (!shows[showName][seasonNum]) {
          shows[showName][seasonNum] = [];
        }

        shows[showName][seasonNum].push({
          id: f.id,
          driveId: f.id,
          filename: f.name,
          title: epTitle,
          show: showName,
          season: parseInt(seasonNum, 10),
          episode: episodeNum,
          path: `drive://${f.id}`,
          size: f.size,
          thumbnailUrl: f.thumbnailLink,
          modifiedTime: f.modifiedTime
        });
      }

      // Sort episodes
      for (const s of showsList) {
        for (const season in shows[s]) {
          shows[s][season].sort((a, b) => a.episode - b.episode);
        }
      }

      // Look up TV show posters
      const showsPosters = {};
      setScanProgress(userId, {
        stage: 'posters',
        message: `Fetching posters for ${showsList.length} shows...`,
        totalShows: showsList.length,
        showsProcessed: 0
      });
      for (const s of showsList) {
        showsPosters[s] = await fetchShowPoster(s);
        const cur = getScanProgress(userId);
        setScanProgress(userId, {
          stage: 'posters',
          showsProcessed: (cur?.showsProcessed || 0) + 1,
          message: `Fetching show posters... (${(cur?.showsProcessed || 0) + 1}/${showsList.length})`
        });
      }

      // Parse Movies with poster and genre lookup
      const movies = [];
      const genreMap = {}; // genreName -> [movie objects]
      setScanProgress(userId, {
        stage: 'posters',
        message: `Fetching posters for ${movieFiles.length} movies...`,
        totalMovies: movieFiles.length,
        moviesProcessed: 0
      });
      const rootMoviesName = folders.movies?.name || 'Movies';
      for (const f of movieFiles) {
        const cleanTitle = f.name.replace(/\.[^/.]+$/, '').replace(/[._]/g, ' ');
        const yearMatch = cleanTitle.match(/(.*?)[\(\[\s]+(19\d\d|20\d\d)[\)\]\s]*/);
        const title = yearMatch ? yearMatch[1].trim() : cleanTitle;
        const year = yearMatch ? parseInt(yearMatch[2], 10) : null;
        const { posterUrl, genres } = await fetchMovieMeta(title, year);

        let relFolder = f.folderPath || '';
        if (relFolder.startsWith(rootMoviesName)) {
          relFolder = relFolder.slice(rootMoviesName.length);
        }
        relFolder = relFolder.replace(/^[\/\\]+/, '').replace(/[\/\\]+$/, '');

        const movieObj = {
          id: f.id,
          driveId: f.id,
          filename: f.name,
          title,
          year,
          posterUrl,
          path: `drive://${f.id}`,
          size: f.size,
          thumbnailUrl: f.thumbnailLink,
          modifiedTime: f.modifiedTime,
          folder: relFolder,
          folderPath: relFolder,
          relPath: f.relPath || f.name
        };
        movies.push(movieObj);

        for (const g of genres) {
          if (!genreMap[g]) genreMap[g] = [];
          genreMap[g].push(movieObj);
        }

        const cur = getScanProgress(userId);
        setScanProgress(userId, {
          stage: 'posters',
          moviesProcessed: (cur?.moviesProcessed || 0) + 1,
          message: `Fetching movie posters... (${(cur?.moviesProcessed || 0) + 1}/${movieFiles.length})`
        });
      }

      // Group movies into folders
      const movieFolders = {};
      const movieFolderList = [];
      const moviesPosters = {};
      for (const m of movies) {
        if (m.posterUrl) {
          moviesPosters[m.title] = m.posterUrl;
          if (m.driveId) moviesPosters[m.driveId] = m.posterUrl;
        }
        const folderName = (m.folder || '').trim();
        if (folderName) {
          const topFolder = folderName.split(/[\/\\]/)[0].trim();
          if (!movieFolders[topFolder]) {
            movieFolders[topFolder] = [];
            movieFolderList.push(topFolder);
          }
          movieFolders[topFolder].push(m);
        }
      }
      movieFolderList.sort((a, b) => a.localeCompare(b));

      const genresList = Object.keys(genreMap).sort();
      const genres = {};
      for (const g of genresList) genres[g] = genreMap[g];

      const libraryData = {
        shows,
        showsList: showsList.sort(),
        showsPosters,
        movies,
        moviesPosters,
        movieFolders,
        movieFolderList,
        genresList,
        genres,
        scannedAt: new Date().toISOString(),
        counts: {
          tvEpisodes: tvFiles.length,
          movies: movies.length,
          shows: showsList.length,
          movieFolders: movieFolderList.length
        }
      };

      saveUserFile(userId, 'library.json', libraryData);
      setScanProgress(userId, {
        scanning: false,
        stage: 'complete',
        message: 'Scan complete',
        showsProcessed: showsList.length,
        moviesProcessed: movies.length
      });
      console.log(`[Drive Scan] Successfully completed scan for user ${userId}: ${tvFiles.length} episodes, ${movies.length} movies.`);
      return libraryData;
    } catch (err) {
      console.error(`[Drive Scan] Error scanning user ${userId}:`, err);
      const isReauth = err.message && (err.message.includes('refresh token') || err.message.includes('invalid_grant'));
      const message = isReauth ? 'Google re-authentication required. Please sign in with Google again.' : err.message;
      setScanProgress(userId, { scanning: false, stage: 'error', message });
      throw err;
    } finally {
      activeScanPromises.delete(userId);
    }
  })();

  activeScanPromises.set(userId, scanPromise);
  return scanPromise;
}

// -------------------------------------------------------------
// Auto-Scan Scheduler for All Users (Every 4 Hours)
// -------------------------------------------------------------
async function autoScanAllUsers({ force = false } = {}) {
  try {
    if (!fs.existsSync(USERS_DIR)) return;
    const userDirs = fs.readdirSync(USERS_DIR);

    for (const userId of userDirs) {
      const userDir = path.join(USERS_DIR, userId);
      try {
        if (!fs.statSync(userDir).isDirectory()) continue;
      } catch (_) {
        continue;
      }

      // Check if user has Google credentials
      const user = getUserFile(userId, 'user.json', {});
      if (!user?.refreshToken && !user?.accessToken) continue;

      // Check if user has folders configured
      const folders = getUserFile(userId, 'folders.json', {});
      if (!folders?.tv?.id && !folders?.movies?.id) continue;

      // Check if currently scanning
      if (activeScanPromises.has(userId)) {
        console.log(`[Auto-Scan] User ${userId} is currently scanning, skipping.`);
        continue;
      }

      // Check last scanned time from library.json
      const library = getUserFile(userId, 'library.json', {});
      const lastScannedTime = library?.scannedAt ? new Date(library.scannedAt).getTime() : 0;
      const elapsed = Date.now() - lastScannedTime;

      if (!force && lastScannedTime > 0 && elapsed < DRIVE_AUTO_SCAN_INTERVAL_MS) {
        continue;
      }

      const userName = user.name || user.email || userId;
      console.log(`[Auto-Scan] Starting automatic 4-hour scan for user: ${userId} (${userName})...`);
      try {
        await scanUserDrive(userId);
      } catch (err) {
        console.warn(`[Auto-Scan] Auto-scan failed for user ${userId}:`, err.message);
      }
    }
  } catch (err) {
    console.warn('[Auto-Scan] Error during auto-scan check:', err.message);
  }
}

// Periodic check every 15 minutes to run scans for users due (>= 4 hours since last scan)
setInterval(() => {
  autoScanAllUsers().catch(e => console.warn('[Auto-Scan] Periodic check warning:', e.message));
}, DRIVE_AUTO_SCAN_CHECK_INTERVAL_MS);

// Initial background scan check 25 seconds after server startup
setTimeout(() => {
  console.log('[Auto-Scan] Checking users for initial Google Drive scan...');
  autoScanAllUsers().catch(e => console.warn('[Auto-Scan] Startup scan warning:', e.message));
}, 25 * 1000);

app.get('/api/drive/scan/progress', authenticate, (req, res) => {
  const progress = getScanProgress(req.user.id);
  const library = getUserFile(req.user.id, 'library.json', {});
  const lastScannedAt = library?.scannedAt || null;
  const nextAutoScanAt = lastScannedAt
    ? new Date(new Date(lastScannedAt).getTime() + DRIVE_AUTO_SCAN_INTERVAL_MS).toISOString()
    : null;

  res.json({
    success: true,
    progress: progress || { scanning: false, stage: 'idle' },
    lastScannedAt,
    nextAutoScanAt,
    autoScanIntervalHours: 4
  });
});

app.post('/api/drive/scan', authenticate, async (req, res) => {
  try {
    const libraryData = await scanUserDrive(req.user.id);
    if (!libraryData) {
      return res.status(400).json({
        success: false,
        error: 'No Google Drive folders configured to scan. Please select a TV or Movies folder first.'
      });
    }
    res.json({ success: true, library: libraryData });
  } catch (err) {
    console.error('[Drive Scan] Route error:', err);
    const isReauth = err.message && (err.message.includes('refresh token') || err.message.includes('invalid_grant'));
    const message = isReauth ? 'Google re-authentication required. Please sign in with Google again.' : err.message;
    res.status(isReauth ? 401 : 500).json({ success: false, error: message, reauth: !!isReauth });
  }
});

// -------------------------------------------------------------
// On Demand Media Endpoint (Per User)
// -------------------------------------------------------------
app.get('/api/ondemand', optionalAuth, (req, res) => {
  const userId = req.user?.id || 'default';
  const library = getUserFile(userId, 'library.json', {
    shows: {},
    showsList: [],
    movies: [],
    moviesPosters: {},
    movieFolders: {},
    movieFolderList: [],
    genresList: [],
    genres: {}
  });
  const progress = getUserFile(userId, 'progress.json', {});

  // Enrich any movies missing posterUrl from drivePosterCache
  const moviesPosters = Object.assign({}, library.moviesPosters || {});
  if (Array.isArray(library.movies)) {
    for (const m of library.movies) {
      if (!m.posterUrl && m.title) {
        const cleanTitle = m.title.replace(/\(.*?\)/g, '').replace(/[._\-]/g, ' ').replace(/\s+/g, ' ').trim();
        const k = `movie_${cleanTitle.toLowerCase()}_${m.year || ''}`;
        const cached = drivePosterCache[k] || drivePosterCache[`movie_${cleanTitle.toLowerCase()}_`];
        const cachedPoster = typeof cached === 'string' ? cached : (cached?.poster || cached?.posterUrl || null);
        if (cachedPoster) {
          m.posterUrl = cachedPoster;
          moviesPosters[m.title] = cachedPoster;
          if (m.driveId) moviesPosters[m.driveId] = cachedPoster;
        }
      } else if (m.posterUrl) {
        moviesPosters[m.title] = m.posterUrl;
        if (m.driveId) moviesPosters[m.driveId] = m.posterUrl;
      }
    }
  }

  // Compute movieFolders dynamically if not present on disk
  let movieFolders = library.movieFolders;
  let movieFolderList = library.movieFolderList;
  if ((!movieFolders || Object.keys(movieFolders).length === 0) && Array.isArray(library.movies)) {
    movieFolders = {};
    movieFolderList = [];
    for (const m of library.movies) {
      const fName = (m.folder || m.folderPath || '').trim();
      if (fName) {
        const topFolder = fName.split(/[\/\\]/)[0].trim();
        if (!movieFolders[topFolder]) {
          movieFolders[topFolder] = [];
          movieFolderList.push(topFolder);
        }
        movieFolders[topFolder].push(m);
      }
    }
    movieFolderList.sort((a, b) => a.localeCompare(b));
  }

  // Attach progress
  const continueWatching = Object.values(progress).filter(p => p.currentTime > 5 && (p.duration <= 0 || p.currentTime < p.duration * 0.95));

  const lastScannedAt = library?.scannedAt || null;
  const nextAutoScanAt = lastScannedAt
    ? new Date(new Date(lastScannedAt).getTime() + DRIVE_AUTO_SCAN_INTERVAL_MS).toISOString()
    : null;

  res.json({
    ...library,
    moviesPosters,
    movieFolders: movieFolders || {},
    movieFolderList: movieFolderList || [],
    continueWatching,
    personal: true,
    user: req.user ? { id: req.user.id, name: req.user.name } : null,
    autoScanIntervalHours: 4,
    nextAutoScanAt,
    hlsChunkSeconds: HLS_CHUNK_SECONDS
  });
});

// -------------------------------------------------------------
// Drive Channels (Per User) - linear playlists like the main my-tv app
// -------------------------------------------------------------
function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function channelIdFromName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '_');
}

app.get('/api/drive/channels', optionalAuth, (req, res) => {
  const userId = req.user?.id || 'default';
  const library = getUserFile(userId, 'library.json', {
    shows: {},
    showsList: [],
    showsPosters: {},
    movies: [],
    genresList: [],
    genres: {}
  });
  const channels = [];

  // New Episodes - last 100 shows sorted by most recently added episode
  const allShowEntries = [];
  for (const showName of (library.showsList || [])) {
    const seasons = library.shows[showName] || {};
    let latestMtime = 0;
    let episodeCount = 0;
    for (const season of Object.keys(seasons)) {
      for (const ep of (seasons[season] || [])) {
        episodeCount++;
        const t = new Date(ep.modifiedTime || 0).getTime();
        if (t > latestMtime) latestMtime = t;
      }
    }
    allShowEntries.push({ showName, latestMtime, episodeCount });
  }
  allShowEntries.sort((a, b) => b.latestMtime - a.latestMtime);
  const newEpisodesPlaylist = [];
  for (const { showName } of allShowEntries.slice(0, 100)) {
    const seasons = library.shows[showName] || {};
    const seasonKeys = Object.keys(seasons).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    for (const season of seasonKeys) {
      const eps = (seasons[season] || []).slice().sort((a, b) => a.episode - b.episode);
      for (const ep of eps) newEpisodesPlaylist.push(ep);
    }
  }
  if (newEpisodesPlaylist.length > 0) {
    const totalDuration = newEpisodesPlaylist.reduce((sum, ep) => sum + (ep.duration || 0), 0);
    channels.push({
      id: 'new_episodes',
      name: 'New Episodes',
      type: 'new_episodes',
      channelType: 'new_episodes',
      playlist: newEpisodesPlaylist,
      posterUrl: null,
      episodeCount: newEpisodesPlaylist.length,
      totalDuration
    });
  }

  // All Movies - shuffled
  const allMovies = (library.movies || []).slice();
  if (allMovies.length > 0) {
    const shuffled = shuffleArray(allMovies);
    const totalDuration = shuffled.reduce((sum, m) => sum + (m.duration || 0), 0);
    channels.push({
      id: 'movies_all',
      name: 'All Movies',
      type: 'movies',
      channelType: 'movies',
      playlist: shuffled,
      posterUrl: allMovies.find(m => m.posterUrl)?.posterUrl ||
        allMovies.find(m => m.thumbnailUrl)?.thumbnailUrl ||
        null,
      movieCount: allMovies.length,
      totalDuration
    });
  }

  // Per-genre movie channels
  const genres = library.genres || {};
  for (const [genreName, movies] of Object.entries(genres)) {
    if (genreName === 'All Movies') continue;
    if (!Array.isArray(movies) || movies.length === 0) continue;
    const shuffled = shuffleArray(movies);
    const totalDuration = shuffled.reduce((sum, m) => sum + (m.duration || 0), 0);
    channels.push({
      id: `genre_${channelIdFromName(genreName)}`,
      name: `${genreName} Movies`,
      type: 'genre',
      channelType: 'genre',
      playlist: shuffled,
      posterUrl: movies.find(m => m.posterUrl)?.posterUrl ||
        movies.find(m => m.thumbnailUrl)?.thumbnailUrl ||
        null,
      movieCount: movies.length,
      totalDuration
    });
  }

  // One channel per TV show - episodes sorted by season then episode
  for (const showName of (library.showsList || [])) {
    const seasons = library.shows[showName] || {};
    const playlist = [];
    const seasonKeys = Object.keys(seasons).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    for (const season of seasonKeys) {
      const eps = (seasons[season] || []).slice().sort((a, b) => a.episode - b.episode);
      for (const ep of eps) playlist.push(ep);
    }
    if (playlist.length === 0) continue;
    const totalDuration = playlist.reduce((sum, ep) => sum + (ep.duration || 0), 0);
    const posterUrl = library.showsPosters?.[showName] ||
      (playlist.find(ep => ep.thumbnailUrl)?.thumbnailUrl) ||
      null;
    channels.push({
      id: `show_${channelIdFromName(showName)}`,
      name: showName,
      type: 'show',
      channelType: 'show',
      playlist,
      posterUrl,
      episodeCount: playlist.length,
      totalDuration
    });
  }

  // Sort: special channels first (alphabetically), then genre channels, then shows
  channels.sort((a, b) => {
    const order = { new_episodes: 0, movies: 1, genre: 2, show: 3 };
    const oa = order[a.channelType] ?? 99;
    const ob = order[b.channelType] ?? 99;
    if (oa !== ob) return oa - ob;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });

  res.json({ channels });
});

// -------------------------------------------------------------
// Playback Progress & Favorites (Per User)
// -------------------------------------------------------------
app.post('/api/playback/progress', authenticate, (req, res) => {
  const { path: mediaPath, currentTime, duration, title, type, show, season, episode, posterPath } = req.body;
  if (!mediaPath) return res.status(400).json({ error: 'Missing path' });

  const progress = getUserFile(req.user.id, 'progress.json', {});
  progress[mediaPath] = {
    path: mediaPath,
    currentTime: Math.floor(currentTime || 0),
    duration: Math.floor(duration || 0),
    title: title || 'Video',
    type: type || 'video',
    show,
    season,
    episode,
    posterPath,
    updatedAt: new Date().toISOString()
  };
  saveUserFile(req.user.id, 'progress.json', progress);
  res.json({ success: true });
});

app.get('/api/favorites', optionalAuth, (req, res) => {
  const userId = req.user?.id || 'default';
  const favs = getUserFile(userId, 'favorites.json', { favorites: [] });
  res.json(favs);
});

app.post('/api/favorites', authenticate, (req, res) => {
  const { favorites } = req.body;
  saveUserFile(req.user.id, 'favorites.json', { favorites: Array.isArray(favorites) ? favorites : [] });
  res.json({ success: true });
});

app.post('/api/favorites/toggle', authenticate, (req, res) => {
  const { item } = req.body;
  if (!item || !item.title) return res.status(400).json({ error: 'Missing title' });
  
  const favData = getUserFile(req.user.id, 'favorites.json', { favorites: [] });
  let list = Array.isArray(favData.favorites) ? favData.favorites : [];
  const idx = list.findIndex(f => f.title && f.title.toLowerCase() === item.title.toLowerCase());
  let isFavorite = false;
  
  if (idx >= 0) {
    list.splice(idx, 1);
    isFavorite = false;
  } else {
    list.unshift({
      title: item.title,
      type: item.type || 'movie',
      image: item.image || item.posterUrl || item.thumbnailUrl || null,
      show: item.show || null,
      year: item.year || null,
      path: item.path || null,
      driveId: item.driveId || null,
      addedAt: new Date().toISOString()
    });
    isFavorite = true;
  }
  
  saveUserFile(req.user.id, 'favorites.json', { favorites: list });
  res.json({ success: true, isFavorite, favorites: list });
});

// -------------------------------------------------------------
// Google Drive Video Streaming (HTTP Byte-Range Proxied)
// -------------------------------------------------------------
app.get(['/api/stream/drive/:fileId', '/api/stream/drive/:fileId/:fileName'], optionalAuth, async (req, res) => {
  const { fileId } = req.params;
  let effectiveUserId = req.user?.id;

  try {
    let { token: accessToken, userId } = await resolveGoogleToken(effectiveUserId);
    if (userId) effectiveUserId = userId;

    if (!accessToken) {
      return res.status(401).send('No valid Google Drive authorization token available');
    }

    const driveUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
    const initialRange = req.headers.range || null;
    const forceDownload = req.query.download === '1' || req.query.dl === '1';

    let bytesSent = 0;
    let headersSent = false;
    let responded = false;
    let totalFileSize = null;
    let expectedBytesForThisRequest = null;

    let rangeStart = 0;
    let rangeEnd = null;
    if (initialRange) {
      const m = initialRange.match(/bytes=(\d*)-(\d*)/i);
      if (m) {
        if (m[1] !== '') rangeStart = parseInt(m[1], 10);
        if (m[2] !== '') rangeEnd = parseInt(m[2], 10);
      }
    }
    console.warn(`[Stream Drive] REQ fileId=${fileId} method=${req.method} range=${initialRange || 'none'} offset=${req.query.offset || 0} fileName=${req.params.fileName || ''}`);

    // Abort controller for clean client disconnects
    const clientAbortController = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) {
        clientAbortController.abort();
      }
    });

    async function pumpFrom(currentFileOffset) {
      if (res.destroyed || res.writableEnded) {
        return { completed: false, aborted: true };
      }

      const resolved = await resolveGoogleToken(effectiveUserId);
      if (resolved.token) {
        accessToken = resolved.token;
        if (resolved.userId) effectiveUserId = resolved.userId;
      }

      const headers = { Authorization: `Bearer ${accessToken}`, 'Accept': '*/*' };
      if (rangeEnd !== null) {
        headers['Range'] = `bytes=${currentFileOffset}-${rangeEnd}`;
      } else {
        headers['Range'] = `bytes=${currentFileOffset}-`;
      }

      let driveResponse;
      try {
        driveResponse = await fetch(driveUrl, {
          headers,
          signal: clientAbortController.signal
        });
      } catch (err) {
        if (clientAbortController.signal.aborted) return { completed: false, aborted: true };
        return { retryable: true, err };
      }

      if (driveResponse.status === 401 || driveResponse.status === 403) {
        console.warn(`[Stream Drive] Google auth error ${driveResponse.status} for fileId=${fileId}. Forcing token refresh...`);
        const refreshed = await forceRefreshGoogleToken(effectiveUserId);
        if (refreshed.token) {
          accessToken = refreshed.token;
          if (refreshed.userId) effectiveUserId = refreshed.userId;
          console.log(`[Stream Drive] Token refreshed successfully. Retrying fetch from byte ${currentFileOffset}...`);
          return { retryable: true, authRefreshed: true };
        }
      }

      if (!driveResponse.ok && driveResponse.status !== 206) {
        console.error(`[Stream Drive] Google error ${driveResponse.status} for fileId=${fileId}`);
        if (!headersSent && !responded) {
          responded = true;
          return res.status(driveResponse.status).send(`Google Drive error: ${driveResponse.statusText}`);
        }
        return { fatal: true };
      }

      // Determine total file size and expected bytes for this Range request
      if (totalFileSize === null) {
        const cr = driveResponse.headers.get('content-range');
        if (cr) {
          const match = cr.match(/\/(\d+)$/);
          if (match) totalFileSize = parseInt(match[1], 10);
        }
        if (!totalFileSize) {
          const cl = driveResponse.headers.get('content-length');
          if (cl && rangeStart === 0 && rangeEnd === null) {
            totalFileSize = parseInt(cl, 10);
          }
        }
        // If still unknown (e.g. chunked transfer), fetch exact file size via Google Drive API metadata
        if (!totalFileSize && accessToken) {
          try {
            const metaRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=size`, {
              headers: { Authorization: `Bearer ${accessToken}` },
              signal: clientAbortController.signal
            });
            if (metaRes.ok) {
              const meta = await metaRes.json();
              if (meta?.size) totalFileSize = parseInt(meta.size, 10);
            }
          } catch (_) {}
        }
        if (totalFileSize !== null) {
          expectedBytesForThisRequest = (rangeEnd !== null ? rangeEnd : totalFileSize - 1) - rangeStart + 1;
        } else if (rangeEnd !== null) {
          expectedBytesForThisRequest = (rangeEnd - rangeStart) + 1;
        }
      }

      if (!headersSent) {
        res.status(driveResponse.status);
        const forwardHeaders = ['content-length', 'content-range', 'accept-ranges', 'content-disposition'];
        forwardHeaders.forEach(h => {
          const val = driveResponse.headers.get(h);
          if (val) res.setHeader(h, val);
        });

        if (forceDownload) {
          const dlName = String(req.params.fileName || `video-${fileId}`).replace(/["\r\n]/g, '');
          res.setHeader('Content-Disposition', `attachment; filename="${dlName}"`);
        }

        let cType = driveResponse.headers.get('content-type');
        const fileName = req.params.fileName || '';
        if (!cType || cType.includes('octet-stream')) {
          if (fileName.endsWith('.mkv')) cType = 'video/x-matroska';
          else cType = 'video/mp4';
        }
        res.setHeader('Content-Type', cType);
        res.setHeader('Access-Control-Allow-Origin', '*');

        if (!res.getHeader('accept-ranges')) {
          res.setHeader('Accept-Ranges', 'bytes');
        }
        headersSent = true;
        console.warn(`[Stream Drive] HEADERS SENT status=${driveResponse.status} ctype=${cType} total=${totalFileSize} requested=${expectedBytesForThisRequest} atOffset=${currentFileOffset}`);
      }

      const reader = driveResponse.body.getReader();
      try {
        while (true) {
          if (res.destroyed || res.writableEnded) {
            try { await reader.cancel(); } catch (_) {}
            return { completed: false, aborted: true };
          }

          let readTimer;
          const readTimeout = new Promise((_, reject) => {
            readTimer = setTimeout(() => reject(new Error('Google Drive stream stalled (60s timeout)')), 60000);
          });

          let readResult;
          try {
            readResult = await Promise.race([reader.read(), readTimeout]);
          } finally {
            clearTimeout(readTimer);
          }

          const { done, value } = readResult;
          if (done) break;

          const buf = Buffer.from(value);
          bytesSent += buf.length;
          const canWrite = res.write(buf);
          if (!canWrite) {
            await new Promise(resolve => res.once('drain', resolve));
          }
          if (expectedBytesForThisRequest !== null && bytesSent >= expectedBytesForThisRequest) {
            break;
          }
        }

        // If upstream closed before all requested bytes were delivered, it's a premature termination
        if (expectedBytesForThisRequest !== null && bytesSent < expectedBytesForThisRequest) {
          console.warn(`[Stream Drive] Premature EOF from Google Drive at ${bytesSent}/${expectedBytesForThisRequest} bytes (file offset ${currentFileOffset + bytesSent}) for fileId=${fileId}. Resuming...`);
          return { retryable: true, prematureEof: true };
        }

        return { completed: true };
      } catch (err) {
        try { await reader.cancel(); } catch (_) {}
        if (clientAbortController.signal.aborted || res.destroyed) return { completed: false, aborted: true };
        return { retryable: true, err };
      }
    }

    try {
      for (let attempt = 0; attempt < 50; attempt++) {
        if (res.destroyed || res.writableEnded) break;

        const bytesBefore = bytesSent;
        const currentFileOffset = rangeStart + bytesSent;
        const result = await pumpFrom(currentFileOffset);

        if (bytesSent > bytesBefore) {
          attempt = 0; // Reset retry counter whenever progress is made
        }
        if (result && result.completed) {
          if (!res.writableEnded) res.end();
          return;
        }
        if (result && result.aborted) {
          return;
        }
        if (result && result.retryable) {
          const delay = result.authRefreshed ? 100 : Math.min(600 * (attempt + 1), 5000);
          console.error(`[Stream Drive] Upstream dropped at ${currentFileOffset} bytes (delivered ${bytesSent}/${expectedBytesForThisRequest || 'unknown'}); resuming in ${delay}ms for fileId=${fileId}`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        if (result && result.fatal) {
          if (!res.writableEnded && !responded) res.end();
          return;
        }
        if (!res.writableEnded && !responded) res.end();
        return;
      }
      if (!res.writableEnded) res.end();
      console.error(`[Stream Drive] Giving up after retries for fileId=${fileId} (bytesSent=${bytesSent})`);
    } catch (err) {
      console.error('[Stream Drive] Error:', err);
      if (!headersSent && !responded) res.status(500).send('Streaming error: ' + err.message);
      else if (!res.writableEnded) res.end();
    }
  } catch (err) {
    console.error('[Stream Drive] Error:', err);
    res.status(500).send('Streaming error: ' + err.message);
  }
});

// -------------------------------------------------------------
// Google Drive HLS Transcode (Roku-friendly playback)
// The server spawns ffmpeg with an input URL pointing at its own
// byte-range proxy for the Drive file, so ffmpeg can seek (Range) and the
// Google token stays server-side. ffmpeg transcodes to H.264/AAC HLS that
// every Roku can decode, regardless of the source container/codec.
// -------------------------------------------------------------

// Serve a session's m3u8 directly. Roku mishandles 302 redirects to HLS
// manifests (segments get resolved against the wrong base URL), so the
// drive-hls route streams the playlist at its own URL and rewrites segment
function getHostOrigin(req) {
  if (TV_PUBLIC_URL && (TV_PUBLIC_URL.startsWith('http://') || TV_PUBLIC_URL.startsWith('https://')) && !TV_PUBLIC_URL.includes('localhost') && !TV_PUBLIC_URL.includes('127.0.0.1')) {
    return TV_PUBLIC_URL.replace(/\/+$/, '');
  }
  if (!req) return 'https://tv.butfree.online';
  const host = req.get?.('host') || req.headers?.host || 'tv.butfree.online';
  let proto = 'https';
  if (host.includes('localhost') || host.includes('127.0.0.1')) {
    proto = req.headers?.['x-forwarded-proto'] || req.protocol || 'http';
  }
  return `${proto}://${host}`;
}

function serveHlsPlaylist(sessionId, req, res) {
  const sessionDir = path.join(CACHE_DIR, 'hls', sessionId);
  const filePath = path.join(sessionDir, 'index.m3u8');
  let playlist;
  try {
    playlist = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return res.status(404).send('Playlist not ready');
  }
  touchHlsSession(sessionId);
  let rewritten = playlist.replace(/^(?:.*[\\/])?(seg_\d+\.ts)\r?$/gm, (match, p1) => `/api/stream/hls/${sessionId}/${p1}`);
  if (rewritten.includes('#EXT-X-ENDLIST')) {
    rewritten = rewritten.replace('#EXT-X-PLAYLIST-TYPE:EVENT', '#EXT-X-PLAYLIST-TYPE:VOD');
  }
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(rewritten);
}

// Force-purge all HLS transcode sessions and temp directories from disk
app.all('/api/stream/drive-hls/purge-all', optionalAuth, (req, res) => {
  const hlsBaseDir = path.join(CACHE_DIR, 'hls');
  try {
    if (fs.existsSync(hlsBaseDir)) {
      const entries = fs.readdirSync(hlsBaseDir);
      for (const e of entries) {
        cleanupHlsSession(e, true);
      }
    }
  } catch (_) {}
  for (const [sid] of hlsSessions) {
    cleanupHlsSession(sid, true);
  }
  hlsSessions.clear();
  hlsActiveByKey.clear();
  HLS_TRANSCODE_ACTIVE.clear();
  res.json({ success: true, purged: true });
});

// Inspect Drive HLS transcode state across all Passenger workers
app.get('/api/stream/drive-hls/status', optionalAuth, (req, res) => {
  const active = [];
  const reported = new Set();
  for (const [sid, s] of hlsSessions) {
    reported.add(sid);
    let errTail = '';
    try {
      const logPath = path.join(s.dir, 'ffmpeg.log');
      if (fs.existsSync(logPath)) {
        const raw = fs.readFileSync(logPath, 'utf-8');
        errTail = raw.slice(-1500);
      }
    } catch (_) {}
    active.push({
      sessionId: sid,
      fileId: s.fileId,
      offset: s.offset,
      pid: s.ffmpegProcess?.pid,
      ffmpegRunning: Boolean(s.ffmpegProcess && s.ffmpegProcess.exitCode === null),
      exitCode: s.ffmpegProcess?.exitCode,
      ffmpegStderrTail: errTail
    });
  }
  // Also collect active sessions from other Passenger workers via disk
  const hlsBaseDir = path.join(CACHE_DIR, 'hls');
  let diskEntries = [];
  try {
    if (fs.existsSync(hlsBaseDir)) {
      diskEntries = fs.readdirSync(hlsBaseDir);
      for (const e of diskEntries) {
        if (!e || e.startsWith('active_') || e.startsWith('meta_') || reported.has(e)) continue;
        const sJsonPath = path.join(hlsBaseDir, e, 'session.json');
        if (fs.existsSync(sJsonPath)) {
          try {
            const meta = JSON.parse(fs.readFileSync(sJsonPath, 'utf-8'));
            let errTail = '';
            const logPath = path.join(hlsBaseDir, e, 'ffmpeg.log');
            if (fs.existsSync(logPath)) {
              errTail = fs.readFileSync(logPath, 'utf-8').slice(-1500);
            }
            active.push({
              sessionId: e,
              fileId: meta.fileId,
              streamId: meta.streamId,
              offset: meta.offset,
              pid: meta.pid,
              ffmpegRunning: Boolean(meta.pid && isPidAlive(meta.pid)),
              exitCode: null,
              ffmpegStderrTail: errTail,
              worker: 'external-passenger-worker'
            });
          } catch (_) {}
        }
      }
    }
  } catch (_) {}
  let serverLogTail = '';
  try {
    if (fs.existsSync(LOG_FILE)) {
      serverLogTail = fs.readFileSync(LOG_FILE, 'utf-8').slice(-3000);
    }
  } catch (_) {}
  res.json({
    activeSessions: active,
    transcodingActiveCount: active.filter(a => a.ffmpegRunning).length,
    chunkSeconds: HLS_CHUNK_SECONDS,
    diskEntries,
    serverLogTail
  });
});

app.get(['/api/stream/drive-hls/:fileId', '/api/stream/drive-hls/:fileId.m3u8'], optionalAuth, async (req, res) => {
  let { fileId } = req.params;
  if (fileId && fileId.endsWith('.m3u8')) {
    fileId = fileId.replace(/\.m3u8$/, '');
  }
  const userId = req.user?.id;
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const sessionKey = `${userId || 'anon'}:${fileId}`;
  const lockKey = `${sessionKey}:${offset}`;

  // In-flight deduplication: if another request is currently initializing this exact transcode,
  // wait for it rather than spawning a second redundant FFmpeg process.
  if (hlsStartingByKeyOffset.has(lockKey)) {
    try {
      const waitSessionId = await hlsStartingByKeyOffset.get(lockKey);
      if (waitSessionId) {
        const origin = getHostOrigin(req);
        res.writeHead(302, {
          'Location': `${origin}/api/stream/hls/${waitSessionId}/index.m3u8`,
          'Cache-Control': 'no-cache'
        });
        return res.end();
      }
    } catch (_) {}
  }

  // Only reuse an existing session if it is actively running in memory
  // with the exact same offset. Never reuse dead, completed, or stale sessions from disk.
  const activeSessionFile = path.join(CACHE_DIR, 'hls', `active_${fileId}.json`);

  let existingId = hlsActiveByKey.get(sessionKey);
  let persistedOffset = null;
  if (!existingId && fs.existsSync(activeSessionFile)) {
    try {
      const activeData = JSON.parse(fs.readFileSync(activeSessionFile, 'utf-8'));
      if (activeData?.sessionId) { existingId = activeData.sessionId; persistedOffset = activeData.offset; }
    } catch (_) {}
  }

  if (existingId) {
    const memSession = hlsSessions.get(existingId);
    let isProcessRunning = Boolean(memSession?.ffmpegProcess && memSession.ffmpegProcess.exitCode === null);
    let activeOffset = memSession ? memSession.offset : persistedOffset;

    if (!isProcessRunning) {
      const sessionJsonFile = path.join(CACHE_DIR, 'hls', existingId, 'session.json');
      if (fs.existsSync(sessionJsonFile)) {
        try {
          const meta = JSON.parse(fs.readFileSync(sessionJsonFile, 'utf-8'));
          if (meta?.offset !== undefined) activeOffset = meta.offset;
          if (meta?.pid && isPidAlive(meta.pid)) {
            isProcessRunning = true;
          }
        } catch (_) {}
      }
    }

    const isSameOffset = (activeOffset === offset);
    const m3u8Path = path.join(CACHE_DIR, 'hls', existingId, 'index.m3u8');
    let isCompletedSuccessfully = false;
    if (fs.existsSync(m3u8Path)) {
      try {
        const m3u8Content = fs.readFileSync(m3u8Path, 'utf-8');
        isCompletedSuccessfully = m3u8Content.includes('#EXT-X-ENDLIST') && (!memSession || memSession?.ffmpegProcess?.exitCode === 0);
      } catch (_) {}
    }

    if ((isProcessRunning || isCompletedSuccessfully) && isSameOffset && fs.existsSync(m3u8Path)) {
      // Chain request hit the pre-warmed next chunk: reuse it instantly and drop the
      // previous chunk, which the player has now finished.
      pruneSameKeySessions(sessionKey, 1, existingId);
      const origin = getHostOrigin(req);
      res.writeHead(302, {
        'Location': `${origin}/api/stream/hls/${existingId}/index.m3u8`,
        'Cache-Control': 'no-cache'
      });
      return res.end();
    }
  }

  // End-of-content short circuit: only when no reusable session exists for this offset.
  if (isTerminalChunkRequest(readHlsMetaFile(getHlsMetaFile(fileId)), offset)) {
    console.log(`[Drive HLS] End-of-content reached fileId=${fileId} offset=${offset}s -> terminal playlist`);
    return sendTerminalPlaylist(res);
  }

  // Preempt any existing transcode for OTHER content OR for the SAME content when seeking to a new offset.
  // We guarantee 100% of the VPS CPU is focused on this active playback across all Passenger workers.
  try {
    const hlsBase = path.join(CACHE_DIR, 'hls');
    if (fs.existsSync(hlsBase)) {
      const entries = fs.readdirSync(hlsBase);
      for (const ent of entries) {
        if (!ent || ent.startsWith('active_') || ent.startsWith('meta_')) continue;
        const sJsonPath = path.join(hlsBase, ent, 'session.json');
        if (fs.existsSync(sJsonPath)) {
          try {
            const sMeta = JSON.parse(fs.readFileSync(sJsonPath, 'utf-8'));
            const sKey = sMeta.streamId !== undefined
              ? `torrent:${sMeta.streamId}:${sMeta.fileIndex}`
              : `drive:${sMeta.userId || effectiveUserId || 'anon'}:${sMeta.fileId}`;
            if (sKey !== sessionKey || sMeta.offset !== offset) {
              console.log(`[Drive HLS] Preempting existing transcode session=${ent} (pid=${sMeta.pid} offset=${sMeta.offset}) for new playback at offset=${offset}`);
              cleanupHlsSession(ent);
            }
          } catch (_) {}
        }
      }
    }
  } catch (_) {}

  let resolveLock;
  const startPromise = new Promise((resolve) => { resolveLock = resolve; });
  hlsStartingByKeyOffset.set(lockKey, startPromise);

  try {
    let { token: accessToken, userId: effectiveUserId } = await resolveGoogleToken(userId);
    if (!accessToken) {
      return res.status(401).send('No valid Google Drive authorization token available');
    }
    const ffmpegCmd = getFfmpegPath();
    console.log(`[Drive HLS] Starting transcode fileId=${fileId} user=${userId || 'anon'} offset=${offset}s ffmpeg=${ffmpegCmd}`);

    const sessionId = crypto.randomBytes(6).toString('hex');
    const hlsDir = path.join(CACHE_DIR, 'hls', sessionId);
    try {
      fs.mkdirSync(hlsDir, { recursive: true });
    } catch (err) {
      return res.status(500).send('Failed to create transcode temp dir');
    }

    const m3u8Path = path.join(hlsDir, 'index.m3u8');
    let sessionTotalDurationSec = null;

    // Input URL points at this server's own Drive proxy. ffmpeg can issue
    // Range requests (seeking for moov atom etc.) and playback starts as soon
    // as ffmpeg pulls the first bytes - no full download required upfront.
    const inputUrl = await getFfmpegInputUrl(sessionId, fileId, req);

    // Roku-compatible HLS transcoding matching root server.js with guaranteed keyframes:
    const ffmpegArgs = [
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      '-analyzeduration', '2M',
      '-probesize', '2M'
    ];

    if (offset > 0) {
      ffmpegArgs.push('-ss', offset.toString());
    }

    ffmpegArgs.push(
      '-i', inputUrl,
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-sn',
      '-c:v', 'libx264',
      '-profile:v', 'main',
      '-level', '4.1',
      '-preset', 'ultrafast',
      '-tune', 'fastdecode',
      '-threads', '0',
      '-crf', '28',
      '-b:v', '2000k',
      '-maxrate', '2500k',
      '-bufsize', '5000k',
      '-g', '48',
      '-keyint_min', '48',
      '-sc_threshold', '0',
      '-x264-params', 'repeat-headers=1:no-deblock=1',
      '-vf', "scale=-2:'min(720,ih)':flags=fast_bilinear",
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-ar', '44100',
      '-b:a', '128k',
      '-ac', '2',
      '-max_muxing_queue_size', '2048',
      '-hls_time', '6',
      // Chunked VOD: transcode exactly HLS_CHUNK_SECONDS of content per session, then stop.
      // Each chunk is a short, bounded, EVENT-then-ENDLIST playlist that Roku plays end-to-end;
      // the Roku app chains chunks via ?offset=. 6-second segments match Apple/Roku best practices.
      '-t', String(HLS_CHUNK_SECONDS),
      '-hls_playlist_type', 'event',
      '-hls_list_size', '0',
      '-hls_flags', 'temp_file',
      '-hls_segment_filename', path.join(hlsDir, 'seg_%05d.ts'),
      path.join(hlsDir, 'index.m3u8')
    );

    const ffmpegProcess = spawn(ffmpegCmd, ffmpegArgs, { cwd: hlsDir });
    let ffmpegErrTail = '';
    const ffmpegLogPath = path.join(hlsDir, 'ffmpeg.log');
    try { fs.writeFileSync(ffmpegLogPath, `[${new Date().toISOString()}] spawn ${ffmpegCmd} ${ffmpegArgs.join(' ')}\n`); } catch (_) {}
    ffmpegProcess.stderr.on('data', (d) => {
      ffmpegErrTail = (ffmpegErrTail + d.toString()).slice(-2000);
      try { fs.appendFileSync(ffmpegLogPath, d.toString()); } catch (_) {}
      if (sessionTotalDurationSec === null) {
        const parsedDur = parseFfmpegDuration(d.toString());
        if (parsedDur) {
          sessionTotalDurationSec = parsedDur;
          writeHlsMetaFile(getHlsMetaFile(fileId), { durationSec: parsedDur });
          console.log(`[Drive HLS] Parsed total duration session=${sessionId} duration=${parsedDur}s`);
        }
      }
    });
    hlsSessions.set(sessionId, {
      dir: hlsDir,
      ffmpegProcess,
      timer: null,
      token: accessToken,
      userId: effectiveUserId,
      fileId,
      key: sessionKey,
      offset,
      startedAt: Date.now()
    });
    hlsActiveByKey.set(sessionKey, sessionId);
    try {
      const sessionMeta = { sessionId, fileId, userId: effectiveUserId, offset, pid: ffmpegProcess.pid, startedAt: Date.now() };
      fs.writeFileSync(activeSessionFile, JSON.stringify(sessionMeta));
      fs.writeFileSync(path.join(hlsDir, 'session.json'), JSON.stringify(sessionMeta));
    } catch (_) {}
    HLS_TRANSCODE_ACTIVE.add(sessionId);
    touchHlsSession(sessionId);
    pruneSameKeySessions(sessionKey, 2);

    ffmpegProcess.on('error', (err) => {
      console.error('[Drive HLS] FFmpeg launch error:', err.message);
      console.error('[Drive HLS] FFmpeg stderr tail:', ffmpegErrTail);
      cleanupHlsSession(sessionId);
      if (!res.headersSent) res.status(500).send('Transcoding failed to start');
      else res.end();
    });

    let ffmpegExited = false;
    let ffmpegExitCode = null;
    ffmpegProcess.on('exit', (code) => {
      ffmpegExited = true;
      ffmpegExitCode = code;
      if (code !== 0 && code !== null) {
        console.warn(`[Drive HLS] FFmpeg exited with code ${code}`);
        console.warn('[Drive HLS] FFmpeg stderr tail:', ffmpegErrTail);
      } else {
        console.log(`[Drive HLS] FFmpeg done session=${sessionId} code=${code}`);
        if (code === 0) {
          // Record chunking metadata so the next chained ?offset= request knows where
          // the content ends and whether end-of-file was reached within this chunk.
          const stats = computePlaylistStats(m3u8Path);
          const atEndOfFile = stats.durationSec > 0 && stats.durationSec < HLS_CHUNK_SECONDS - 6;
          const meta = { atEndOfFile, lastChunkStart: offset, chunkDurationSec: stats.durationSec, segmentCount: stats.segmentCount };
          if (sessionTotalDurationSec) meta.durationSec = sessionTotalDurationSec;
          writeHlsMetaFile(getHlsMetaFile(fileId), meta);
          console.log(`[Drive HLS] Chunk complete session=${sessionId} segs=${stats.segmentCount} duration=${stats.durationSec.toFixed(1)}s chunkStart=${offset}s atEndOfFile=${atEndOfFile} totalDuration=${sessionTotalDurationSec === null ? 'unknown' : sessionTotalDurationSec}`);
        }
      }
      HLS_TRANSCODE_ACTIVE.delete(sessionId);
    });

    // Wait for the playlist to appear with at least 1 segment, then 302 redirect
    // to the stable session URL (matching main server.js /roku2 behavior).
    const waitStarted = Date.now();
    const waitForPlaylist = () => {
      if (ffmpegExited && ffmpegExitCode !== 0 && ffmpegExitCode !== null) {
        console.error(`[Drive HLS] FFmpeg failed session=${sessionId} code=${ffmpegExitCode}`);
        if (resolveLock) { resolveLock(null); hlsStartingByKeyOffset.delete(lockKey); }
        cleanupHlsSession(sessionId);
        if (!res.headersSent) res.status(500).send('Transcoding failed: ' + (ffmpegErrTail || 'FFmpeg error'));
        return;
      }
      try {
        if (fs.existsSync(m3u8Path)) {
          const content = fs.readFileSync(m3u8Path, 'utf-8');
          const segCount = (content.match(/seg_\d+\.ts/g) || []).length;
          const isComplete = content.includes('#EXT-X-ENDLIST');
          // Wait for 3 segments (18s of video) or end-of-file before redirecting.
          // This ensures Roku has a deep initial buffer cushion, preventing mid-stream buffering stalls.
          const elapsed = Date.now() - waitStarted;
          if (segCount >= 3 || isComplete || (segCount >= 2 && elapsed > 7000)) {
            if (resolveLock) { resolveLock(sessionId); hlsStartingByKeyOffset.delete(lockKey); }
            const origin = getHostOrigin(req);
            console.log(`[Drive HLS] Playlist ready session=${sessionId} segments=${segCount} (${elapsed}ms) -> redirecting to ${origin}/api/stream/hls/${sessionId}/index.m3u8`);
            res.writeHead(302, {
              'Location': `${origin}/api/stream/hls/${sessionId}/index.m3u8`,
              'Cache-Control': 'no-cache'
            });
            return res.end();
          }
        }
      } catch (_) {}
      if (Date.now() - waitStarted > 90000) {
        console.error(`[Drive HLS] Transcode timed out session=${sessionId}`);
        console.error('[Drive HLS] FFmpeg stderr tail:', ffmpegErrTail);
        if (resolveLock) { resolveLock(null); hlsStartingByKeyOffset.delete(lockKey); }
        cleanupHlsSession(sessionId);
        if (!res.headersSent) res.status(500).send('Transcoding timed out');
        return;
      }
      setTimeout(waitForPlaylist, 350);
    };
    waitForPlaylist();
  } catch (err) {
    if (resolveLock) { resolveLock(null); hlsStartingByKeyOffset.delete(lockKey); }
    console.error('[Drive HLS] Error:', err.message);
    res.status(500).send('Transcoding error: ' + err.message);
  }
});

// Input proxy used by ffmpeg for HLS transcoding. Reads the Drive file
// server-side (with the session's stored Google token) and supports HTTP
// Range requests so ffmpeg can seek (moov atom, etc).
//
// Google Drive throttles/aborts large `alt=media` downloads partway through a
// long file (movies are multi-GB and routinely get a mid-stream reset). If the
// upstream connection drops, ffmpeg sees an early EOF, writes #EXT-X-ENDLIST,
// and the Roku silently "finishes" a movie that was only ~33% done. To avoid
// that, we resume the upstream fetch from the last byte we actually delivered
// (via a fresh Range request) so the transcode keeps producing segments.
const DRIVE_INPUT_RETRY_DELAY_MS = 600;

async function driveHlsInputHandler(req, res) {
  const { sessionId, fileId } = req.params;
  let session = hlsSessions.get(sessionId);
  if (!session) {
    const sessionJsonFile = path.join(CACHE_DIR, 'hls', sessionId, 'session.json');
    if (fs.existsSync(sessionJsonFile)) {
      try {
        const fileData = JSON.parse(fs.readFileSync(sessionJsonFile, 'utf-8'));
        if (fileData) session = fileData;
      } catch (_) {}
    }
    if (!session) {
      const activeFile = path.join(CACHE_DIR, 'hls', `active_${fileId}.json`);
      if (fs.existsSync(activeFile)) {
        try {
          const activeData = JSON.parse(fs.readFileSync(activeFile, 'utf-8'));
          if (activeData?.sessionId === sessionId) session = activeData;
        } catch (_) {}
      }
    }
  }
  if (!session && fs.existsSync(path.join(CACHE_DIR, 'hls', sessionId))) {
    session = { sessionId, fileId, userId: null };
  }
  if (!session) {
    return res.status(404).send('Session not found');
  }
  touchHlsSession(sessionId);

  const driveUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  let bytesSent = 0;
  let headersSent = false;
  let responded = false;
  let totalFileSize = null;
  let expectedBytesForThisRequest = null;

  const initialRange = req.headers.range || null;
  let rangeStart = 0;
  let rangeEnd = null;
  if (initialRange) {
    const m = initialRange.match(/bytes=(\d*)-(\d*)/i);
    if (m) {
      if (m[1] !== '') rangeStart = parseInt(m[1], 10);
      if (m[2] !== '') rangeEnd = parseInt(m[2], 10);
    }
  }

  const clientAbortController = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) {
      clientAbortController.abort();
    }
  });

  async function pumpFrom(currentFileOffset) {
    if (res.destroyed || res.writableEnded) {
      return { completed: false, aborted: true };
    }

    // Dynamic token retrieval: verify validity or refresh before requesting
    const resolved = await resolveGoogleToken(session.userId);
    if (resolved.token) {
      session.token = resolved.token;
      if (resolved.userId) session.userId = resolved.userId;
    }

    if (!session.token) {
      console.error(`[Drive HLS Input] No valid Google token available for session=${sessionId}`);
      if (!headersSent && !responded) {
        responded = true;
        res.status(401).send('No valid Google token');
      }
      return { retryable: false };
    }

    const headers = { Authorization: `Bearer ${session.token}`, 'Accept': '*/*' };
    if (rangeEnd !== null) {
      headers['Range'] = `bytes=${currentFileOffset}-${rangeEnd}`;
    } else {
      headers['Range'] = `bytes=${currentFileOffset}-`;
    }

    let driveResponse;
    const connectAbortController = new AbortController();
    const connectTimer = setTimeout(() => {
      connectAbortController.abort(new Error('Google Drive initial connection timed out (15s)'));
    }, 15000);

    const fetchSignal = (typeof AbortSignal.any === 'function')
      ? AbortSignal.any([clientAbortController.signal, connectAbortController.signal])
      : clientAbortController.signal;

    try {
      driveResponse = await fetch(driveUrl, {
        headers,
        signal: fetchSignal
      });
    } catch (err) {
      clearTimeout(connectTimer);
      if (clientAbortController.signal.aborted) return { completed: false, aborted: true };
      return { retryable: true, err };
    } finally {
      clearTimeout(connectTimer);
    }

    // If Google returns 401 or 403, token expired mid-stream! Force-refresh and retry.
    if (driveResponse.status === 401 || driveResponse.status === 403) {
      console.warn(`[Drive HLS Input] Google auth error (${driveResponse.status}) for fileId=${fileId}. Forcing token refresh...`);
      const refreshed = await forceRefreshGoogleToken(session.userId);
      if (refreshed.token) {
        session.token = refreshed.token;
        if (refreshed.userId) session.userId = refreshed.userId;
        console.log(`[Drive HLS Input] Token refreshed successfully. Retrying fetch from byte ${currentFileOffset}...`);
        return { retryable: true, authRefreshed: true };
      }
    }

    if (!driveResponse.ok && driveResponse.status !== 206) {
      console.error(`[Drive HLS Input] Google error ${driveResponse.status} for fileId=${fileId}`);
      if (!headersSent && !responded) {
        responded = true;
        return res.status(driveResponse.status).send(`Google Drive error: ${driveResponse.statusText}`);
      }
      return { retryable: true };
    }

    // Determine total file size and expected bytes for this Range request
    if (totalFileSize === null) {
      const cr = driveResponse.headers.get('content-range');
      if (cr) {
        const match = cr.match(/\/(\d+)$/);
        if (match) totalFileSize = parseInt(match[1], 10);
      }
      // Prioritize Google Drive API metadata to avoid trusting truncated Content-Length
      if (!totalFileSize && session.token) {
        try {
          const metaRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=size`, {
            headers: { Authorization: `Bearer ${session.token}` },
            signal: clientAbortController.signal
          });
          if (metaRes.ok) {
            const meta = await metaRes.json();
            if (meta?.size) totalFileSize = parseInt(meta.size, 10);
          }
        } catch (_) {}
      }
      if (!totalFileSize) {
        const cl = driveResponse.headers.get('content-length');
        if (cl && rangeStart === 0 && rangeEnd === null) {
          totalFileSize = parseInt(cl, 10);
        }
      }
      if (totalFileSize !== null) {
        expectedBytesForThisRequest = (rangeEnd !== null ? rangeEnd : totalFileSize - 1) - rangeStart + 1;
      } else if (rangeEnd !== null) {
        expectedBytesForThisRequest = (rangeEnd - rangeStart) + 1;
      }
    }

    if (!headersSent) {
      res.status(driveResponse.status);
      const forwardHeaders = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'content-disposition'];
      forwardHeaders.forEach(h => {
        const val = driveResponse.headers.get(h);
        if (val) res.setHeader(h, val);
      });
      if (!res.getHeader('accept-ranges')) {
        res.setHeader('Accept-Ranges', 'bytes');
      }
      headersSent = true;
    }

    const reader = driveResponse.body.getReader();
    try {
      while (true) {
        if (res.destroyed || res.writableEnded) {
          try { await reader.cancel(); } catch (_) {}
          return { completed: false, aborted: true };
        }

        let readTimer;
        const readTimeout = new Promise((_, reject) => {
          readTimer = setTimeout(() => reject(new Error('Google Drive HLS input stream stalled (60s timeout)')), 60000);
        });

        let readResult;
        try {
          readResult = await Promise.race([reader.read(), readTimeout]);
        } finally {
          clearTimeout(readTimer);
        }

        const { done, value } = readResult;
        if (done) break;

        const buf = Buffer.from(value);
        bytesSent += buf.length;
        const canWrite = res.write(buf);
        if (!canWrite) {
          await new Promise((resolve) => {
            let settled = false;
            const doneDrain = () => {
              if (settled) return;
              settled = true;
              res.removeListener('drain', doneDrain);
              res.removeListener('close', doneDrain);
              res.removeListener('error', doneDrain);
              clearTimeout(drainTimer);
              resolve();
            };
            const drainTimer = setTimeout(doneDrain, 60000);
            res.once('drain', doneDrain);
            res.once('close', doneDrain);
            res.once('error', doneDrain);
          });
        }
        if (expectedBytesForThisRequest !== null && bytesSent >= expectedBytesForThisRequest) {
          break;
        }
      }

      // Check if upstream closed early before delivering all requested bytes
      if (expectedBytesForThisRequest !== null && bytesSent < expectedBytesForThisRequest) {
        console.warn(`[Drive HLS Input] Premature EOF from Google Drive at ${bytesSent}/${expectedBytesForThisRequest} bytes (file offset ${currentFileOffset + bytesSent}) for fileId=${fileId}. Resuming...`);
        return { retryable: true, prematureEof: true };
      }

      return { retryable: false, completed: true };
    } catch (err) {
      try { await reader.cancel(); } catch (_) {}
      if (clientAbortController.signal.aborted || res.destroyed) return { completed: false, aborted: true };
      return { retryable: true, err };
    }
  }

  try {
    // Retry loop: never close the response to FFmpeg on transient Drive failures.
    // Closing the response signals EOF to FFmpeg, which writes #EXT-X-ENDLIST and
    // causes the Roku to think the movie finished (even if only partially transcode).
    // Instead, keep retrying with exponential backoff.
    for (let attempt = 0; attempt < 50; attempt++) {
      if (res.destroyed || res.writableEnded) break;

      const bytesBefore = bytesSent;
      const currentFileOffset = rangeStart + bytesSent;
      const result = await pumpFrom(currentFileOffset);

      if (bytesSent > bytesBefore) {
        attempt = 0; // Reset retry counter whenever progress is made
      }
      if (result && result.completed) {
        if (!res.writableEnded) res.end();
        return;
      }
      if (result && result.aborted) {
        return;
      }
      if (result && result.retryable) {
        const delay = result.authRefreshed ? 100 : Math.min(DRIVE_INPUT_RETRY_DELAY_MS * (attempt + 1), 5000);
        const errDetail = result.err?.message || (result.prematureEof ? 'premature EOF' : 'stalled stream');
        console.error(`[Drive HLS Input] Upstream dropped at ${currentFileOffset} bytes (${errDetail}, delivered ${bytesSent}/${expectedBytesForThisRequest || 'unknown'}); resuming in ${delay}ms for fileId=${fileId}`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      if (headersSent) {
        const delay = DRIVE_INPUT_RETRY_DELAY_MS;
        console.error(`[Drive HLS Input] Non-retryable Google error mid-stream after ${bytesSent} bytes; retrying in ${delay}ms for fileId=${fileId}`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      if (!res.writableEnded && !responded) res.end();
      return;
    }
  } catch (err) {
    console.error('[Drive HLS Input] Error:', err.message);
    if (!headersSent && !responded) res.status(500).send('Streaming error: ' + err.message);
    else if (!res.writableEnded) res.end();
  }
}

// Keep the input proxy reachable on the main app too (external/backwards compat).
app.get('/api/stream/drive-hls-input/:sessionId/:fileId', driveHlsInputHandler);

// Stop the active transcode session for a Drive file. Called by the Roku when
// the user exits a video or playback ends, so ffmpeg is killed and the
// transcode cap frees up instead of transcoding the whole file in the background.
app.all('/api/stream/drive-hls/stop', optionalAuth, (req, res) => {
  let fileId = (req.body && req.body.fileId) || req.query.fileId || '';
  if (fileId.endsWith('.m3u8')) fileId = fileId.replace(/\.m3u8$/, '');
  const userId = req.user?.id;
  const key = `${userId || 'anon'}:${fileId}`;
  let sessionId = hlsActiveByKey.get(key);
  const activeSessionFile = path.join(CACHE_DIR, 'hls', `active_${fileId}.json`);
  if (!sessionId && fs.existsSync(activeSessionFile)) {
    try {
      const activeData = JSON.parse(fs.readFileSync(activeSessionFile, 'utf-8'));
      if (activeData?.sessionId) sessionId = activeData.sessionId;
    } catch (_) {}
  }
  if (sessionId) {
    cleanupHlsSession(sessionId);
    hlsActiveByKey.delete(key);
    try { fs.rmSync(activeSessionFile, { force: true }); } catch (_) {}
    return res.json({ success: true, stopped: true });
  }
  if (fileId) {
    try { fs.rmSync(activeSessionFile, { force: true }); } catch (_) {}
  }
  res.json({ success: true, stopped: false });
});

// ==============================================================================
// Torrent HLS Transcoding Pipeline for Roku & Non-Native Clients
// Transcodes raw torrent streams into universal 720p H.264 + stereo AAC HLS
// ==============================================================================
app.get(['/api/stream/torrent-hls/:streamId/:fileIndex', '/api/stream/torrent-hls/:streamId/:fileIndex.m3u8'], optionalAuth, async (req, res) => {
  let { streamId, fileIndex } = req.params;
  if (fileIndex && fileIndex.endsWith('.m3u8')) {
    fileIndex = fileIndex.replace(/\.m3u8$/, '');
  }
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const sessionKey = `torrent:${streamId}:${fileIndex}`;
  const lockKey = `${sessionKey}:${offset}`;

  // In-flight deduplication: if another request is currently initializing this exact transcode,
  // wait for it rather than spawning a second redundant FFmpeg process.
  if (hlsStartingByKeyOffset.has(lockKey)) {
    try {
      const waitSessionId = await hlsStartingByKeyOffset.get(lockKey);
      if (waitSessionId) {
        const origin = getHostOrigin(req);
        res.writeHead(302, {
          'Location': `${origin}/api/stream/hls/${waitSessionId}/index.m3u8`,
          'Cache-Control': 'no-cache'
        });
        return res.end();
      }
    } catch (_) {}
  }

  const activeSessionFile = path.join(CACHE_DIR, 'hls', `active_torrent_${streamId}_${fileIndex}.json`);

  let existingId = hlsActiveByKey.get(sessionKey);
  let persistedOffset = null;
  if (!existingId && fs.existsSync(activeSessionFile)) {
    try {
      const activeData = JSON.parse(fs.readFileSync(activeSessionFile, 'utf-8'));
      if (activeData?.sessionId) { existingId = activeData.sessionId; persistedOffset = activeData.offset; }
    } catch (_) {}
  }

  if (existingId) {
    const memSession = hlsSessions.get(existingId);
    let isProcessRunning = Boolean(memSession?.ffmpegProcess && memSession.ffmpegProcess.exitCode === null);
    let activeOffset = memSession ? memSession.offset : persistedOffset;

    if (!isProcessRunning) {
      const sessionJsonFile = path.join(CACHE_DIR, 'hls', existingId, 'session.json');
      if (fs.existsSync(sessionJsonFile)) {
        try {
          const meta = JSON.parse(fs.readFileSync(sessionJsonFile, 'utf-8'));
          if (meta?.offset !== undefined) activeOffset = meta.offset;
          if (meta?.pid && isPidAlive(meta.pid)) {
            isProcessRunning = true;
          }
        } catch (_) {}
      }
    }

    const isSameOffset = (activeOffset === offset);
    const m3u8Path = path.join(CACHE_DIR, 'hls', existingId, 'index.m3u8');
    let isCompletedSuccessfully = false;
    if (fs.existsSync(m3u8Path)) {
      try {
        const m3u8Content = fs.readFileSync(m3u8Path, 'utf-8');
        isCompletedSuccessfully = m3u8Content.includes('#EXT-X-ENDLIST') && (!memSession || memSession?.ffmpegProcess?.exitCode === 0);
      } catch (_) {}
    }

    if ((isProcessRunning || isCompletedSuccessfully) && isSameOffset && fs.existsSync(m3u8Path)) {
      const origin = getHostOrigin(req);
      res.writeHead(302, {
        'Location': `${origin}/api/stream/hls/${existingId}/index.m3u8`,
        'Cache-Control': 'no-cache'
      });
      return res.end();
    }

    cleanupHlsSession(existingId);
    hlsActiveByKey.delete(sessionKey);
    try { fs.rmSync(activeSessionFile, { force: true }); } catch (_) {}
  }

  // End-of-content short circuit: only when no reusable session exists for this offset.
  if (isTerminalChunkRequest(readHlsMetaFile(getTorrentHlsMetaFile(streamId, fileIndex)), offset)) {
    console.log(`[Torrent HLS] End-of-content reached streamId=${streamId} fileIndex=${fileIndex} offset=${offset}s -> terminal playlist`);
    return sendTerminalPlaylist(res);
  }

  // Preempt any existing transcode for OTHER content OR for the SAME content when seeking to a new offset.
  // We guarantee 100% of the VPS CPU is focused on this active playback across all Passenger workers.
  try {
    const hlsBase = path.join(CACHE_DIR, 'hls');
    if (fs.existsSync(hlsBase)) {
      const entries = fs.readdirSync(hlsBase);
      for (const ent of entries) {
        if (!ent || ent.startsWith('active_') || ent.startsWith('meta_')) continue;
        const sJsonPath = path.join(hlsBase, ent, 'session.json');
        if (fs.existsSync(sJsonPath)) {
          try {
            const sMeta = JSON.parse(fs.readFileSync(sJsonPath, 'utf-8'));
            const sKey = sMeta.streamId !== undefined
              ? `torrent:${sMeta.streamId}:${sMeta.fileIndex}`
              : `drive:${sMeta.userId || 'anon'}:${sMeta.fileId}`;
            if (sKey !== sessionKey || sMeta.offset !== offset) {
              console.log(`[Torrent HLS] Preempting existing transcode session=${ent} (pid=${sMeta.pid} offset=${sMeta.offset}) for new playback at offset=${offset}`);
              cleanupHlsSession(ent);
            }
          } catch (_) {}
        }
      }
    }
  } catch (_) {}

  let resolveLock;
  const startPromise = new Promise((resolve) => { resolveLock = resolve; });
  hlsStartingByKeyOffset.set(lockKey, startPromise);

  try {
    const targetServer = await getActiveTorrentServer();
    const inputUrl = `${targetServer}/api/torrent/serve/${encodeURIComponent(streamId)}/${encodeURIComponent(fileIndex || 0)}`;
    const ffmpegCmd = getFfmpegPath();
    console.log(`[Torrent HLS] Starting transcode streamId=${streamId} fileIndex=${fileIndex} offset=${offset}s ffmpeg=${ffmpegCmd}`);

    const sessionId = crypto.randomBytes(6).toString('hex');
    const hlsDir = path.join(CACHE_DIR, 'hls', sessionId);
    try {
      fs.mkdirSync(hlsDir, { recursive: true });
    } catch (err) {
      return res.status(500).send('Failed to create transcode temp dir');
    }

    const m3u8Path = path.join(hlsDir, 'index.m3u8');
    let sessionTotalDurationSec = null;

    const ffmpegArgs = [
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      '-analyzeduration', '2M',
      '-probesize', '2M'
    ];

    if (offset > 0) {
      ffmpegArgs.push('-ss', offset.toString());
    }

    ffmpegArgs.push(
      '-i', inputUrl,
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-sn',
      '-c:v', 'libx264',
      '-profile:v', 'main',
      '-level', '4.1',
      '-preset', 'ultrafast',
      '-tune', 'fastdecode',
      '-threads', '0',
      '-crf', '28',
      '-b:v', '2000k',
      '-maxrate', '2500k',
      '-bufsize', '5000k',
      '-g', '48',
      '-keyint_min', '48',
      '-sc_threshold', '0',
      '-x264-params', 'repeat-headers=1:no-deblock=1',
      '-vf', "scale=-2:'min(720,ih)':flags=fast_bilinear",
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-ar', '44100',
      '-b:a', '128k',
      '-ac', '2',
      '-max_muxing_queue_size', '2048',
      '-hls_time', '6',
      // Chunked VOD (mirrors drive-hls): bounded EVENT-then-ENDLIST playlists that
      // Roku plays end-to-end; the app chains chunks via ?offset=.
      '-t', String(HLS_CHUNK_SECONDS),
      '-hls_playlist_type', 'event',
      '-hls_list_size', '0',
      '-hls_flags', 'temp_file',
      '-hls_segment_filename', path.join(hlsDir, 'seg_%05d.ts'),
      path.join(hlsDir, 'index.m3u8')
    );

    const ffmpegProcess = spawn(ffmpegCmd, ffmpegArgs, { cwd: hlsDir });
    let ffmpegErrTail = '';
    ffmpegProcess.stderr.on('data', (d) => {
      ffmpegErrTail = (ffmpegErrTail + d.toString()).slice(-2000);
      if (sessionTotalDurationSec === null) {
        const parsedDur = parseFfmpegDuration(d.toString());
        if (parsedDur) {
          sessionTotalDurationSec = parsedDur;
          writeHlsMetaFile(getTorrentHlsMetaFile(streamId, fileIndex), { durationSec: parsedDur });
          console.log(`[Torrent HLS] Parsed total duration session=${sessionId} duration=${parsedDur}s`);
        }
      }
    });
    hlsSessions.set(sessionId, {
      dir: hlsDir,
      ffmpegProcess,
      timer: null,
      streamId,
      fileIndex,
      key: sessionKey,
      offset,
      startedAt: Date.now()
    });
    hlsActiveByKey.set(sessionKey, sessionId);
    try {
      const sessionMeta = { sessionId, streamId, fileIndex, offset, pid: ffmpegProcess.pid, startedAt: Date.now() };
      fs.writeFileSync(activeSessionFile, JSON.stringify(sessionMeta));
      fs.writeFileSync(path.join(hlsDir, 'session.json'), JSON.stringify(sessionMeta));
    } catch (_) {}
    HLS_TRANSCODE_ACTIVE.add(sessionId);
    touchHlsSession(sessionId);
    pruneSameKeySessions(sessionKey, 2);

    ffmpegProcess.on('error', (err) => {
      console.error('[Torrent HLS] FFmpeg launch error:', err.message);
      cleanupHlsSession(sessionId);
      if (!res.headersSent) res.status(500).send('Transcoding failed to start');
      else res.end();
    });

    let ffmpegExited = false;
    let ffmpegExitCode = null;
    ffmpegProcess.on('exit', (code) => {
      ffmpegExited = true;
      ffmpegExitCode = code;
      if (code !== 0 && code !== null) {
        console.warn(`[Torrent HLS] FFmpeg exited with code ${code}`);
        console.warn('[Torrent HLS] FFmpeg stderr tail:', ffmpegErrTail);
      } else {
        console.log(`[Torrent HLS] FFmpeg done session=${sessionId} code=${code}`);
        if (code === 0) {
          // Record chunking metadata so the next chained ?offset= request knows where
          // the content ends and whether end-of-file was reached within this chunk.
          const stats = computePlaylistStats(m3u8Path);
          const atEndOfFile = stats.durationSec > 0 && stats.durationSec < HLS_CHUNK_SECONDS - 6;
          const meta = { atEndOfFile, lastChunkStart: offset, chunkDurationSec: stats.durationSec, segmentCount: stats.segmentCount };
          if (sessionTotalDurationSec) meta.durationSec = sessionTotalDurationSec;
          writeHlsMetaFile(getTorrentHlsMetaFile(streamId, fileIndex), meta);
          console.log(`[Torrent HLS] Chunk complete session=${sessionId} segs=${stats.segmentCount} duration=${stats.durationSec.toFixed(1)}s chunkStart=${offset}s atEndOfFile=${atEndOfFile} totalDuration=${sessionTotalDurationSec === null ? 'unknown' : sessionTotalDurationSec}`);
        }
      }
      HLS_TRANSCODE_ACTIVE.delete(sessionId);
    });

    const waitStarted = Date.now();
    const waitForPlaylist = () => {
      if (ffmpegExited && ffmpegExitCode !== 0 && ffmpegExitCode !== null) {
        console.error(`[Torrent HLS] FFmpeg failed session=${sessionId} code=${ffmpegExitCode}`);
        if (resolveLock) { resolveLock(null); hlsStartingByKeyOffset.delete(lockKey); }
        cleanupHlsSession(sessionId);
        if (!res.headersSent) res.status(500).send('Transcoding failed: ' + (ffmpegErrTail || 'FFmpeg error'));
        return;
      }
      try {
        if (fs.existsSync(m3u8Path)) {
          const content = fs.readFileSync(m3u8Path, 'utf-8');
          const segCount = (content.match(/seg_\d+\.ts/g) || []).length;
          const isComplete = content.includes('#EXT-X-ENDLIST');
          // Wait for 3 segments (18s of video) or end-of-file before redirecting.
          // This ensures Roku has a deep initial buffer cushion, preventing mid-stream buffering stalls.
          const elapsed = Date.now() - waitStarted;
          if (segCount >= 3 || isComplete || (segCount >= 2 && elapsed > 7000)) {
            if (resolveLock) { resolveLock(sessionId); hlsStartingByKeyOffset.delete(lockKey); }
            const origin = getHostOrigin(req);
            console.log(`[Torrent HLS] Playlist ready session=${sessionId} segments=${segCount} (${elapsed}ms) -> redirecting to ${origin}/api/stream/hls/${sessionId}/index.m3u8`);
            res.writeHead(302, {
              'Location': `${origin}/api/stream/hls/${sessionId}/index.m3u8`,
              'Cache-Control': 'no-cache'
            });
            return res.end();
          }
        }
      } catch (_) {}
      if (Date.now() - waitStarted > 90000) {
        console.error(`[Torrent HLS] Transcode timed out session=${sessionId}`);
        if (resolveLock) { resolveLock(null); hlsStartingByKeyOffset.delete(lockKey); }
        cleanupHlsSession(sessionId);
        if (!res.headersSent) res.status(500).send('Transcoding timed out');
        return;
      }
      setTimeout(waitForPlaylist, 350);
    };
    waitForPlaylist();
  } catch (err) {
    if (resolveLock) { resolveLock(null); hlsStartingByKeyOffset.delete(lockKey); }
    console.error('[Torrent HLS] Error:', err.message);
    res.status(500).send('Transcoding error: ' + err.message);
  }
});

app.all('/api/stream/torrent-hls/stop', optionalAuth, async (req, res) => {
  let streamId = (req.body && req.body.streamId) || req.query.streamId || '';
  let fileIndex = (req.body && req.body.fileIndex) || req.query.fileIndex || '0';
  const key = `torrent:${streamId}:${fileIndex}`;
  let sessionId = hlsActiveByKey.get(key);
  const activeSessionFile = path.join(CACHE_DIR, 'hls', `active_torrent_${streamId}_${fileIndex}.json`);
  if (!sessionId && fs.existsSync(activeSessionFile)) {
    try {
      const activeData = JSON.parse(fs.readFileSync(activeSessionFile, 'utf-8'));
      if (activeData?.sessionId) sessionId = activeData.sessionId;
    } catch (_) {}
  }
  if (sessionId) {
    cleanupHlsSession(sessionId);
    hlsActiveByKey.delete(key);
    try { fs.rmSync(activeSessionFile, { force: true }); } catch (_) {}
  }

  // Also notify the active torrent server to stop the torrent download
  try {
    const targetServer = await getActiveTorrentServer();
    if (streamId) {
      await fetch(`${targetServer}/api/torrent/stream/${encodeURIComponent(streamId)}/stop`, {
        method: 'POST',
        signal: AbortSignal.timeout(5000)
      }).catch(() => {});
    }
  } catch (_) {}

  res.json({ success: true, stopped: true });
});

// Serve HLS playlist + segments produced by an on-demand transcode session
app.get('/api/stream/hls/:sessionId/:file', (req, res) => {
  const { sessionId, file } = req.params;
  if (!sessionId || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    return res.status(400).send('Bad request');
  }
  const safeFile = path.basename(file);
  if (!safeFile || !/^[a-zA-Z0-9._-]+$/.test(safeFile)) {
    return res.status(400).send('Bad request');
  }
  // Check disk directly so multi-process Passenger workers can serve segments reliably
  const sessionDir = path.join(CACHE_DIR, 'hls', sessionId);
  const filePath = path.join(sessionDir, safeFile);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Segment not found');
  }
  touchHlsSession(sessionId);
  const ext = path.extname(safeFile).toLowerCase();
  if (ext === '.m3u8') {
    let playlist = '';
    try {
      playlist = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      return res.status(404).send('Segment not found');
    }
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin', '*');
    const origin = getHostOrigin(req);
    const rewritten = playlist.replace(/^(?:.*[\\/])?(seg_\d+\.ts)\r?$/gm, (match, p1) => `${origin}/api/stream/hls/${sessionId}/${p1}`);
    console.log(`[HLS Serve] m3u8 session=${sessionId} segments=${(rewritten.match(/seg_\d+\.ts/g) || []).length}`);
    res.end(rewritten);
  } else {
    const stat = fs.statSync(filePath);
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.setHeader('Access-Control-Allow-Origin', '*');
    console.log(`[HLS Serve] segment session=${sessionId} file=${safeFile} size=${stat.size}`);
    fs.createReadStream(filePath).pipe(res);
  }
});

// -------------------------------------------------------------
// Shared Global Endpoints (Streaming Services, Popular, Live TV)
// -------------------------------------------------------------
const STREAMING_SERVICES = [
  // Free Live FAST Channels (Broken down by service)
  { id: 'pluto', name: 'Pluto TV', color: '#FFDE00', description: '300+ Live FAST channels with live electronic program guide from Pluto TV.', isLive: true, category: 'Free Live TV' },
  { id: 'roku', name: 'The Roku Channel', color: '#7B2CBF', description: '400+ Live FAST linear streaming channels from The Roku Channel.', isLive: true, category: 'Free Live TV' },
  { id: 'tubi', name: 'Tubi TV', color: '#FA541C', description: '200+ Live FAST channels with movies, news, and sports from Tubi.', isLive: true, category: 'Free Live TV' },
  { id: 'plex', name: 'Plex TV', color: '#E5A00D', description: 'Live linear streaming FAST channels from Plex TV.', isLive: true, category: 'Free Live TV' },

  // On-Demand Streaming Services
  { id: 'netflix', name: 'Netflix', color: '#E50914', description: 'Original films, award-winning series, documentaries and comedy specials.', packages: ['nfx', 'nfk'] },
  { id: 'prime', name: 'Prime Video', color: '#00A8E1', description: 'Amazon Originals, blockbuster movies, hit TV series and live sports.', packages: ['prv', 'amp', 'amz'] },
  { id: 'disney', name: 'Disney+', color: '#113CCF', description: 'Disney, Pixar, Marvel, Star Wars, National Geographic and Star.', packages: ['dnp', 'dsk'] },
  { id: 'paramount', name: 'Paramount+', color: '#0064FF', description: 'CBS originals, Showtime hits, blockbuster movies and exclusive series.', packages: ['pmp', 'pmt', 'sho'] },
  { id: 'apple', name: 'Apple TV+', color: '#000000', description: 'Star-studded Apple Original series, films, kids entertainment and documentaries.', packages: ['atp', 'app'] },
  { id: 'max', name: 'Max', color: '#002BE7', description: 'HBO prestige dramas, Warner Bros. films, DC Universe and Max Originals.', packages: ['hbo', 'max', 'hbm'] },
  { id: 'hulu', name: 'Hulu', color: '#1CE783', description: 'Current TV shows, FX on Hulu, Hulu Originals and classic movies.', packages: ['hlu', 'hls'] },
  { id: 'peacock', name: 'Peacock', color: '#000000', description: 'NBC comedy and drama, Peacock Originals, next-day TV and live sports.', packages: ['pck', 'pku'] },
  { id: 'citytv', name: 'Citytv', color: '#00529B', description: 'Canadian primetime dramas, comedies, Breakfast Television and reality series.', country: 'CA', packages: ['ctv', 'cpv', 'cta', 'cty'] },
  { id: 'crave', name: 'Crave', color: '#0047FF', description: 'HBO, Max Originals, Showtime, Hollywood movies and Canadian originals.', country: 'CA', packages: ['crv', 'cst', 'cpv', 'cra'] },
  { id: 'cbc', name: 'CBC Gem', color: '#E01E26', description: 'Acclaimed Canadian drama, comedy, documentaries, news and Kids programming.', country: 'CA', packages: ['cbc', 'cbg', 'gem', 'cbp'] }
];

// -------------------------------------------------------------
// Free TV Engine (Pluto, Roku, Tubi, Plex) & Stream Proxy
// -------------------------------------------------------------
const FREETV_CACHE_PATH = path.join(CACHE_DIR, 'freetv_cache.json');
let freeTvCache = {
  channels: [],
  categories: [],
  providers: {
    pluto: [],
    roku: [],
    tubi: [],
    plex: []
  },
  lastUpdated: null
};

if (fs.existsSync(FREETV_CACHE_PATH)) {
  try {
    const loaded = JSON.parse(fs.readFileSync(FREETV_CACHE_PATH, 'utf-8'));
    if (loaded && Array.isArray(loaded.channels)) {
      freeTvCache = {
        channels: loaded.channels || [],
        categories: loaded.categories || ['All'],
        providers: loaded.providers || {
          pluto: loaded.channels.filter(c => c.provider === 'Pluto TV'),
          roku: loaded.channels.filter(c => c.provider === 'Roku Channel'),
          tubi: loaded.channels.filter(c => c.provider === 'Tubi'),
          plex: loaded.channels.filter(c => c.provider === 'Plex TV')
        },
        lastUpdated: loaded.lastUpdated
      };
      console.log(`[Free TV] Loaded ${freeTvCache.channels.length} Free TV channels from cache.`);
    }
  } catch (err) {
    console.warn('[Free TV] Failed to parse freetv_cache.json:', err.message);
  }
}

function normalizeFreeTvCategory(cat = '') {
  const c = (cat || '').trim();
  const lower = c.toLowerCase();
  if (lower.includes('movie') || lower.includes('cinema') || lower.includes('film')) return 'Movies';
  if (lower.includes('sci-fi') || lower.includes('fantasy') || lower.includes('anime')) return 'Sci-Fi';
  if (lower.includes('comedy') || lower.includes('sitcom') || lower.includes('stand-up') || lower.includes('south park')) return 'Comedy';
  if (lower.includes('crime') || lower.includes('mystery') || lower.includes('true crime') || lower.includes('investigation')) return 'Crime';
  if (lower.includes('news') || lower.includes('finance') || lower.includes('weather')) return 'News';
  if (lower.includes('sport') || lower.includes('racing') || lower.includes('fight') || lower.includes('wrestling')) return 'Sports';
  if (lower.includes('game') || lower.includes('gaming') || lower.includes('esport')) return 'Gaming';
  if (lower.includes('kid') || lower.includes('family') || lower.includes('cartoon') || lower.includes('animation')) return 'Kids';
  if (lower.includes('drama') || lower.includes('soap')) return 'Drama';
  if (lower.includes('reality') || lower.includes('competition') || lower.includes('lifestyle') || lower.includes('court')) return 'Reality';
  if (lower.includes('music') || lower.includes('concert') || lower.includes('vevo')) return 'Music';
  if (lower.includes('food') || lower.includes('home') || lower.includes('travel') || lower.includes('cooking')) return 'Lifestyle';
  if (lower.includes('classic') || lower.includes('vintage') || lower.includes('retro')) return 'Classic TV';
  if (lower.includes('doc') || lower.includes('science') || lower.includes('history') || lower.includes('nature')) return 'Documentary';
  return c || 'Entertainment';
}

function parseM3uPlaylist(m3uText, providerName, idPrefix) {
  if (!m3uText || typeof m3uText !== 'string') return [];
  const lines = m3uText.split('\n');
  const channels = [];
  let currentInfo = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF:')) {
      const tvgIdMatch = line.match(/tvg-id="([^"]+)"/i) || line.match(/channel-id="([^"]+)"/i);
      const tvgNameMatch = line.match(/tvg-name="([^"]+)"/i);
      const tvgLogoMatch = line.match(/tvg-logo="([^"]+)"/i);
      const tvgChNoMatch = line.match(/tvg-chno="([^"]+)"/i);
      const groupTitleMatch = line.match(/group-title="([^"]+)"/i);

      let channelName = '';
      const commaIdx = line.lastIndexOf(',');
      if (commaIdx !== -1) {
        channelName = line.slice(commaIdx + 1).trim();
      }
      if (!channelName && tvgNameMatch) {
        channelName = tvgNameMatch[1].trim();
      }

      const rawId = tvgIdMatch ? tvgIdMatch[1] : (channelName ? channelName.toLowerCase().replace(/[^a-z0-9]/g, '_') : crypto.randomUUID());

      currentInfo = {
        rawId,
        name: channelName || 'Live Channel',
        logo: tvgLogoMatch ? tvgLogoMatch[1] : null,
        number: tvgChNoMatch ? parseInt(tvgChNoMatch[1], 10) : 0,
        groupTitle: groupTitleMatch ? groupTitleMatch[1] : 'General'
      };
    } else if (line.startsWith('http') && currentInfo) {
      const streamUrl = line;
      const chId = `${idPrefix}_${currentInfo.rawId}`;
      const normalizedCat = normalizeFreeTvCategory(currentInfo.groupTitle);

      channels.push({
        id: `freetv_${chId}`,
        provider: providerName,
        plutoId: chId,
        number: currentInfo.number || 0,
        name: currentInfo.name,
        slug: currentInfo.name.toLowerCase().replace(/[^a-z0-9]/g, '-'),
        category: normalizedCat,
        rawCategory: currentInfo.groupTitle,
        summary: `${currentInfo.name} live FAST streaming channel on ${providerName}.`,
        logo: currentInfo.logo,
        featuredImage: currentInfo.logo,
        image: currentInfo.logo,
        type: 'live',
        streamUrl: `/api/freetv/stream/${chId}.m3u8`,
        directStreamUrl: streamUrl,
        currentProgram: {
          title: currentInfo.name,
          description: `Live stream broadcasting now on ${providerName}.`,
          start: new Date().toISOString(),
          stop: new Date(Date.now() + 3600000).toISOString(),
          poster: currentInfo.logo,
          thumbnail: currentInfo.logo
        }
      });
      currentInfo = null;
    }
  }
  return channels;
}

function generatePlutoStreamUrl(plutoId) {
  const cleanId = String(plutoId || '').replace(/^pluto_/, '');
  const deviceId = crypto.randomUUID();
  const sid = crypto.randomUUID();
  return `https://service-stitcher.clusters.pluto.tv/stitch/hls/channel/${cleanId}/master.m3u8?advertisingId=&appName=web&appVersion=9.0.0&deviceDNT=0&deviceId=${deviceId}&deviceMake=Chrome&deviceModel=web&deviceType=web&deviceVersion=120.0.0&marketingRegion=US&sid=${sid}`;
}

async function fetchPlutoTvChannels() {
  const start = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const stop = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
  const url = `https://api.pluto.tv/v2/channels?start=${encodeURIComponent(start)}&stop=${encodeURIComponent(stop)}`;
  
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  const res = await fetch(url, {
    signal: controller.signal,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  });
  clearTimeout(timeout);

  if (!res.ok) throw new Error(`Pluto HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) return [];

  const now = Date.now();
  const parsed = [];

  for (const ch of data) {
    if (!ch._id || !ch.name || ch.visibility === 'false' || ch.visibility === false) continue;
    const normalizedCat = normalizeFreeTvCategory(ch.category);

    let currentProg = null;
    if (Array.isArray(ch.timelines) && ch.timelines.length > 0) {
      for (const t of ch.timelines) {
        const tStart = new Date(t.start).getTime();
        const tStop = new Date(t.stop).getTime();
        if (now >= tStart && now <= tStop) {
          currentProg = {
            title: t.title || t.episode?.name || t.episode?.series?.name || ch.name,
            description: t.episode?.description || t.episode?.series?.description || t.episode?.series?.summary || '',
            start: t.start,
            stop: t.stop,
            rating: t.episode?.rating || '',
            genre: t.episode?.genre || normalizedCat,
            poster: t.episode?.poster?.path || t.episode?.series?.poster16_9?.path || t.episode?.featuredImage?.path || null,
            thumbnail: t.episode?.thumbnail?.path || null
          };
          break;
        }
      }
    }

    const logo = ch.colorLogoPNG?.path || ch.logo?.path || ch.thumbnail?.path || ch.colorLogoSVG?.path || null;
    const featuredImage = ch.featuredImage?.path || null;

    parsed.push({
      id: `freetv_${ch._id}`,
      provider: 'Pluto TV',
      plutoId: ch._id,
      number: ch.number || 0,
      name: ch.name,
      slug: ch.slug || '',
      category: normalizedCat,
      rawCategory: ch.category || 'General',
      summary: ch.summary || ch.onDemandDescription || `${ch.name} Free TV streaming channel on Pluto TV.`,
      logo,
      featuredImage,
      image: logo || featuredImage,
      type: 'live',
      streamUrl: `/api/freetv/stream/${ch._id}.m3u8`,
      directStreamUrl: generatePlutoStreamUrl(ch._id),
      currentProgram: currentProg || {
        title: ch.name,
        description: ch.summary || 'Live stream broadcasting now on Free TV.',
        start: new Date().toISOString(),
        stop: new Date(now + 3600000).toISOString(),
        poster: featuredImage,
        thumbnail: logo
      }
    });
  }
  return parsed;
}

async function fetchTubiChannels() {
  const urls = [
    'https://raw.githubusercontent.com/BuddyChewChew/app-m3u-generator/main/playlists/tubi_all.m3u',
    'https://raw.githubusercontent.com/BuddyChewChew/tubi-scraper/main/tubi_playlist.m3u',
    'https://raw.githubusercontent.com/BuddyChewChew/app-m3u-generator/refs/heads/main/playlists/tubi_all.m3u'
  ];
  let parsed = [];
  for (const url of urls) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });
      clearTimeout(timeout);
      if (res.ok) {
        const text = await res.text();
        const raw = parseM3uPlaylist(text, 'Tubi', 'tubi');
        if (raw.length > 0) {
          parsed = raw;
          break;
        }
      }
    } catch (err) {
      console.warn(`[Free TV] Tubi URL fetch failed (${url}):`, err.message);
    }
  }

  if (parsed.length === 0) return [];

  // Validate Tubi streams in parallel to keep only active channels
  const validated = [];
  const chunkSize = 15;
  for (let i = 0; i < parsed.length; i += chunkSize) {
    const chunk = parsed.slice(i, i + chunkSize);
    const checks = await Promise.allSettled(chunk.map(async (ch) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3500);
      const r = await fetch(ch.directStreamUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Origin': 'https://tubitv.com',
          'Referer': 'https://tubitv.com/'
        }
      });
      clearTimeout(timeout);
      if (r.ok) return ch;
      throw new Error(`Status ${r.status}`);
    }));

    for (const check of checks) {
      if (check.status === 'fulfilled' && check.value) {
        validated.push(check.value);
      }
    }
  }

  return validated;
}

async function fetchRokuFastChannels() {
  const urls = [
    'https://raw.githubusercontent.com/BuddyChewChew/app-m3u-generator/main/playlists/roku_all.m3u',
    'https://raw.githubusercontent.com/BuddyChewChew/app-m3u-generator/refs/heads/main/playlists/roku_all.m3u'
  ];
  for (const url of urls) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });
      clearTimeout(timeout);
      if (res.ok) {
        const text = await res.text();
        const parsed = parseM3uPlaylist(text, 'Roku Channel', 'roku');
        if (parsed.length > 0) {
          return parsed;
        }
      }
    } catch (err) {
      console.warn(`[Free TV] Roku URL fetch failed (${url}):`, err.message);
    }
  }
  return [];
}

async function fetchPlexFastChannels() {
  const urls = [
    'https://raw.githubusercontent.com/BuddyChewChew/app-m3u-generator/main/playlists/plex_all.m3u',
    'https://raw.githubusercontent.com/BuddyChewChew/app-m3u-generator/refs/heads/main/playlists/plex_all.m3u'
  ];
  for (const url of urls) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });
      clearTimeout(timeout);
      if (res.ok) {
        const text = await res.text();
        const parsed = parseM3uPlaylist(text, 'Plex TV', 'plex');
        if (parsed.length > 0) {
          return parsed;
        }
      }
    } catch (err) {
      console.warn(`[Free TV] Plex URL fetch failed (${url}):`, err.message);
    }
  }
  return [];
}

async function fetchFreeTvChannels() {
  console.log('[Free TV] Fetching live FAST channels for Pluto, Roku, Tubi, and Plex...');
  
  const results = await Promise.allSettled([
    fetchPlutoTvChannels(),
    fetchRokuFastChannels(),
    fetchPlexFastChannels(),
    fetchTubiChannels()
  ]);

  const plutoChannels = results[0].status === 'fulfilled' ? results[0].value : [];
  const rokuChannels = results[1].status === 'fulfilled' ? results[1].value : [];
  const plexChannels = results[2].status === 'fulfilled' ? results[2].value : [];
  const tubiChannels = results[3].status === 'fulfilled' ? results[3].value : [];

  if (results[0].status === 'rejected') console.warn('[Free TV] Pluto TV fetch warning:', results[0].reason?.message);
  if (results[1].status === 'rejected') console.warn('[Free TV] Roku FAST fetch warning:', results[1].reason?.message);
  if (results[2].status === 'rejected') console.warn('[Free TV] Plex FAST fetch warning:', results[2].reason?.message);
  if (results[3].status === 'rejected') console.warn('[Free TV] Tubi fetch warning:', results[3].reason?.message);

  const combined = [...plutoChannels, ...rokuChannels, ...plexChannels, ...tubiChannels];
  if (combined.length === 0) {
    return freeTvCache;
  }

  const catSet = new Set(['All']);
  for (const ch of combined) {
    if (ch.category) catSet.add(ch.category);
  }

  freeTvCache = {
    channels: combined,
    categories: Array.from(catSet),
    providers: {
      pluto: plutoChannels,
      roku: rokuChannels,
      tubi: tubiChannels,
      plex: plexChannels
    },
    lastUpdated: new Date().toISOString()
  };

  try {
    fs.writeFileSync(FREETV_CACHE_PATH, JSON.stringify(freeTvCache, null, 2), 'utf-8');
    console.log(`[Free TV] Ingested ${combined.length} channels (Pluto: ${plutoChannels.length}, Roku: ${rokuChannels.length}, Tubi: ${tubiChannels.length}, Plex: ${plexChannels.length}).`);
  } catch (err) {
    console.error('[Free TV] Cache write error:', err.message);
  }

  return freeTvCache;
}

// Background auto-refresh every 4 hours
setInterval(() => {
  fetchFreeTvChannels().catch(e => console.warn('[Free TV] Periodic refresh warning:', e.message));
}, 4 * 60 * 60 * 1000);

// Initial background load if cache is empty
(async () => {
  if (!freeTvCache.channels || freeTvCache.channels.length === 0) {
    await fetchFreeTvChannels();
  }
})();

// -------------------------------------------------------------
// Free TV & HLS Stream Proxy API Endpoints
// -------------------------------------------------------------
app.get('/api/freetv/channels', async (req, res) => {
  if (!freeTvCache.channels || freeTvCache.channels.length === 0) {
    await fetchFreeTvChannels();
  }
  const provider = (req.query.provider || '').toLowerCase();
  let channels = freeTvCache.channels || [];
  if (provider) {
    if (provider.includes('pluto')) channels = freeTvCache.providers?.pluto || channels.filter(c => c.provider === 'Pluto TV');
    else if (provider.includes('roku')) channels = freeTvCache.providers?.roku || channels.filter(c => c.provider === 'Roku Channel');
    else if (provider.includes('tubi')) channels = freeTvCache.providers?.tubi || channels.filter(c => c.provider === 'Tubi');
    else if (provider.includes('plex')) channels = freeTvCache.providers?.plex || channels.filter(c => c.provider === 'Plex TV');
  }
  res.json({
    success: true,
    channels,
    categories: freeTvCache.categories || ['All'],
    lastUpdated: freeTvCache.lastUpdated
  });
});

app.get(['/api/freetv/stream/:id', '/api/freetv/stream/:id.m3u8', '/api/freetv/stream/:id/playlist.m3u8'], async (req, res) => {
  const rawParam = req.params.id.replace(/\.m3u8$/, '');
  const channelId = rawParam.replace(/^freetv_/, '');
  
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');

  try {
    const matchedChannel = (freeTvCache.channels || []).find(c => 
      c.id === rawParam || 
      c.id === `freetv_${channelId}` || 
      c.plutoId === channelId ||
      c.id.endsWith(channelId)
    );

    let targetStreamUrl = null;
    const isPluto = (!matchedChannel && !channelId.startsWith('tubi_') && !channelId.startsWith('roku_') && !channelId.startsWith('plex_')) || 
                    matchedChannel?.provider === 'Pluto TV' || 
                    (!channelId.includes('tubi') && !channelId.includes('roku') && !channelId.includes('plex') && /^[0-9a-f]{24}$/i.test(channelId));

    if (isPluto) {
      const cleanPlutoId = (matchedChannel?.plutoId || channelId).replace(/^pluto_/, '');
      targetStreamUrl = `https://jmp2.uk/plu-${cleanPlutoId}.m3u8`;
    } else if (matchedChannel?.directStreamUrl) {
      targetStreamUrl = matchedChannel.directStreamUrl;
    } else if (channelId.startsWith('tubi_')) {
      const tId = channelId.replace(/^tubi_/, '');
      targetStreamUrl = `https://live-manifest.production-public.tubi.io/live/${tId}/playlist.m3u8`;
    } else if (channelId.startsWith('roku_')) {
      const rId = channelId.replace(/^roku_/, '');
      targetStreamUrl = `https://jmp2.uk/rok-${rId}.m3u8`;
    } else if (channelId.startsWith('plex_')) {
      const pId = channelId.replace(/^plex_/, '');
      targetStreamUrl = `https://jmp2.uk/plx-${pId}.m3u8`;
    }

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': '*/*'
    };
    if (targetStreamUrl && targetStreamUrl.includes('tubi')) {
      headers['Origin'] = 'https://tubitv.com';
      headers['Referer'] = 'https://tubitv.com/';
    }

    let streamRes = await fetch(targetStreamUrl, { headers });

    if (!streamRes.ok && isPluto) {
      const cleanPlutoId = (matchedChannel?.plutoId || channelId).replace(/^pluto_/, '');
      const altPlutoUrl = generatePlutoStreamUrl(cleanPlutoId);
      streamRes = await fetch(altPlutoUrl, { headers });
    }

    if (!streamRes.ok) {
      return res.status(502).send('#EXTM3U\n#EXT-X-ERROR: Unable to fetch live stream from provider\n');
    }

    const host = req.get('host') || req.headers.host || (process.env.PORT ? `localhost:${process.env.PORT}` : 'localhost:3000');
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0];
    const serverOrigin = `${proto}://${host}`;

    const finalUrl = streamRes.url;
    const cleanFinalUrl = finalUrl.split('?')[0].split('#')[0];
    const baseUrl = cleanFinalUrl.substring(0, cleanFinalUrl.lastIndexOf('/') + 1);
    const m3u8Content = await streamRes.text();

    const rewritten = m3u8Content.split('\n').map(line => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        if (trimmed.includes('URI="')) {
          return trimmed.replace(/URI="([^"]+)"/g, (match, uri) => {
            let absUri;
            try { absUri = new URL(uri, finalUrl).href; } catch (_) { absUri = uri.startsWith('http') ? uri : (baseUrl + uri); }
            return `URI="${serverOrigin}/api/freetv/proxy?url=${encodeURIComponent(absUri)}"`;
          });
        }
        return line;
      }
      let absUrl;
      try { absUrl = new URL(trimmed, finalUrl).href; } catch (_) { absUrl = trimmed.startsWith('http') ? trimmed : (baseUrl + trimmed); }
      return `${serverOrigin}/api/freetv/proxy?url=${encodeURIComponent(absUrl)}`;
    }).join('\n');

    res.send(rewritten);
  } catch (err) {
    console.error('[Free TV] Stream proxy error:', err.message);
    res.status(500).send('#EXTM3U\n#EXT-X-ERROR: Internal stream error\n');
  }
});

app.get('/api/freetv/proxy', async (req, res) => {
  let targetUrl = req.query.url;
  
  const prefix = '/api/freetv/proxy?url=';
  const rawIdx = (req.originalUrl || req.url || '').indexOf(prefix);
  if (rawIdx !== -1) {
    const rawEncoded = (req.originalUrl || req.url).substring(rawIdx + prefix.length);
    try {
      targetUrl = decodeURIComponent(rawEncoded);
    } catch (_) {
      targetUrl = rawEncoded;
    }
  }

  if (!targetUrl) return res.status(400).send('Missing url parameter');

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  try {
    const host = req.get('host') || req.headers.host || (process.env.PORT ? `localhost:${process.env.PORT}` : 'localhost:3000');
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0];
    const serverOrigin = `${proto}://${host}`;

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': '*/*'
    };
    if (targetUrl.includes('tubi')) {
      headers['Origin'] = 'https://tubitv.com';
      headers['Referer'] = 'https://tubitv.com/';
    }

    const upstreamRes = await fetch(targetUrl, { headers });
    const contentType = upstreamRes.headers.get('content-type') || '';
    
    if (contentType.includes('mpegurl') || targetUrl.includes('.m3u8') || targetUrl.includes('playlist')) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      const text = await upstreamRes.text();
      const cleanTargetUrl = targetUrl.split('?')[0].split('#')[0];
      const baseUrl = cleanTargetUrl.substring(0, cleanTargetUrl.lastIndexOf('/') + 1);

      const rewritten = text.split('\n').map(line => {
        const trimmed = line.trim();
        if (!trimmed) return line;
        if (trimmed.startsWith('#')) {
          if (trimmed.includes('URI="')) {
            return trimmed.replace(/URI="([^"]+)"/g, (match, uri) => {
              let absUri;
              try { absUri = new URL(uri, targetUrl).href; } catch (_) { absUri = uri.startsWith('http') ? uri : (baseUrl + uri); }
              return `URI="${serverOrigin}/api/freetv/proxy?url=${encodeURIComponent(absUri)}"`;
            });
          }
          return line;
        }
        let absUrl;
        try { absUrl = new URL(trimmed, targetUrl).href; } catch (_) { absUrl = trimmed.startsWith('http') ? trimmed : (baseUrl + trimmed); }
        return `${serverOrigin}/api/freetv/proxy?url=${encodeURIComponent(absUrl)}`;
      }).join('\n');

      return res.send(rewritten);
    }

    if (contentType) res.setHeader('Content-Type', contentType);
    const arrayBuffer = await upstreamRes.arrayBuffer();
    return res.send(Buffer.from(arrayBuffer));
  } catch (err) {
    console.error('[Free TV] Proxy chunk error:', err.message);
    res.status(502).send('Error proxying media resource');
  }
});

// -------------------------------------------------------------
// JustWatch GraphQL Helpers & Poster Proxy
// -------------------------------------------------------------
const popularGraphQLQuery = `query PopularTitles($country: Country!, $first: Int!, $filter: TitleFilter, $sortBy: PopularTitlesSorting!) {
  popularTitles(country: $country, first: $first, filter: $filter, sortBy: $sortBy) {
    edges { node {
      __typename
      content(country: $country, language: "en") {
        ... on MovieContent { title shortDescription originalReleaseYear isReleased runtime posterUrl(profile: S718) }
        ... on ShowContent { title shortDescription originalReleaseYear isReleased runtime posterUrl(profile: S718) }
      }
      watchNowOffer(country: $country, filter: { monetizationTypes: [], packages: ["amz","asd","atp","crv","ctc","dnp","gtv","itu","nfx","pmp","prv","hbo","max","hlu","pck","cpv","cta","cty","gem"] }, platform: WEB) {
        package { clearName shortName }
      }
    } }
  }
}`;

const newGraphQLQuery = `query GetNewTitles($country: Country!, $first: Int!, $filter: TitleFilter) {
  newTitles(country: $country, first: $first, filter: $filter, pageType: NEW) {
    edges { node {
      __typename
      ... on Season {
        show {
          content(country: $country, language: "en") {
            title
            posterUrl(profile: S718)
          }
        }
      }
      content(country: $country, language: "en") {
        title
        originalReleaseYear
        shortDescription
        posterUrl(profile: S718)
        runtime
        isReleased
      }
      watchNowOffer(country: $country, filter: { monetizationTypes: [], packages: ["amz","asd","atp","crv","ctc","dnp","gtv","itu","nfx","pmp","prv","hbo","max","hlu","pck","cpv","cta","cty","gem"] }, platform: WEB) {
        package { clearName shortName }
      }
    } }
  }
}`;

const fetchJustWatchGraphQL = (query, variables) => ({
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json'
  },
  body: JSON.stringify({ query, variables })
});

function parseGraphQLNode(e, defaultProvider = '') {
  const node = e && e.node;
  if (!node || !node.content) return null;
  const c = node.content;
  const type = node.__typename === 'Movie' ? 'movie' : (node.__typename === 'Show' || node.__typename === 'Season') ? 'tv' : null;
  if (!type) return null;

  const title = node.show?.content?.title || c.title;
  if (!title) return null;

  const rawPoster = c.posterUrl || node.show?.content?.posterUrl;
  let image = '';
  if (rawPoster) {
    const rawImage = 'https://images.justwatch.com' + rawPoster.replace('{format}', 'jpg');
    image = '/api/whatson/poster?url=' + encodeURIComponent(rawImage);
  }

  const pkg = node.watchNowOffer && node.watchNowOffer.package;
  return {
    title,
    type,
    image: image || '',
    year: c.originalReleaseYear || null,
    description: c.shortDescription || '',
    provider: pkg ? (pkg.clearName || pkg.shortName || defaultProvider) : defaultProvider,
    released: !!c.isReleased,
    runtime: c.runtime || null
  };
}

// Poster Proxy for JustWatch images
app.get('/api/whatson/poster', async (req, res) => {
  const url = req.query.url;
  if (!url || !/^https:\/\/(www\.|images\.)?justwatch\.com\//.test(url)) {
    return res.status(400).send('Invalid poster URL');
  }
  const fetchUrl = url.replace(/^https:\/\/www\.justwatch\.com\//, 'https://images.justwatch.com/');
  try {
    const imgRes = await fetch(fetchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.justwatch.com/'
      }
    });
    if (!imgRes.ok) return res.status(imgRes.status).send('Poster not available');
    res.setHeader('Content-Type', imgRes.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    const buffer = Buffer.from(await imgRes.arrayBuffer());
    res.send(buffer);
  } catch (err) {
    res.status(500).send('Poster error');
  }
});

app.get('/api/services', (req, res) => {
  res.json({ success: true, services: STREAMING_SERVICES });
});

// TV Show seasons and episodes lookup via TVMaze
app.get('/api/services/tv-details', async (req, res) => {
  const { title } = req.query;
  if (!title) return res.status(400).json({ error: 'Missing title query' });

  try {
    const cleanTitle = String(title).replace(/['"]/g, '').trim();
    let showData = null;

    // Try singlesearch first
    const searchRes = await fetch(`https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(cleanTitle)}&embed=episodes`);
    if (searchRes.ok) {
      showData = await searchRes.json();
    } else {
      // Fallback: general search
      const generalRes = await fetch(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(cleanTitle)}`);
      if (generalRes.ok) {
        const matches = await generalRes.json();
        if (matches && matches.length > 0) {
          const showId = matches[0].show.id;
          const showWithEpRes = await fetch(`https://api.tvmaze.com/shows/${showId}?embed=episodes`);
          if (showWithEpRes.ok) {
            showData = await showWithEpRes.json();
          }
        }
      }
    }

    if (showData) {
      const rawEpisodes = showData._embedded?.episodes || [];
      const seasonsMap = {};

      for (const ep of rawEpisodes) {
        const sNum = ep.season || 1;
        if (!seasonsMap[sNum]) {
          seasonsMap[sNum] = { seasonNumber: sNum, episodes: [] };
        }
        seasonsMap[sNum].episodes.push({
          episodeNumber: ep.number,
          name: ep.name,
          overview: (ep.summary || '').replace(/<[^>]+>/g, ''),
          airdate: ep.airdate,
          stillUrl: ep.image?.medium || ep.image?.original || null
        });
      }

      return res.json({
        success: true,
        title: showData.name || title,
        summary: (showData.summary || '').replace(/<[^>]+>/g, ''),
        poster: showData.image?.original || showData.image?.medium || null,
        seasons: Object.values(seasonsMap)
      });
    }
  } catch (err) {
    console.error('[TV Details] Lookup error:', err);
  }

  res.json({ success: false, error: 'Could not find episode details' });
});

app.get('/api/services/poster/:serviceId', (req, res) => {
  const { serviceId } = req.params;
  const rokuPoster = path.join(__dirname, '..', 'roku2', 'images', `${serviceId}.jpg`);
  const publicPoster = path.join(__dirname, 'public', 'service-posters', `${serviceId}.jpg`);
  if (fs.existsSync(publicPoster)) {
    res.setHeader('Content-Type', 'image/jpeg');
    return fs.createReadStream(publicPoster).pipe(res);
  }
  if (fs.existsSync(rokuPoster)) {
    res.setHeader('Content-Type', 'image/jpeg');
    return fs.createReadStream(rokuPoster).pipe(res);
  }
  // Generate on-the-fly branded SVG poster if image is missing
  const svc = STREAMING_SERVICES.find(s => s.id === serviceId) || { name: serviceId, color: '#6366f1' };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${svc.color}" stop-opacity="0.8"/>
        <stop offset="100%" stop-color="#0a0a0f" stop-opacity="1"/>
      </linearGradient>
    </defs>
    <rect width="300" height="450" fill="url(#g)"/>
    <rect width="300" height="450" fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="2"/>
    <text x="150" y="225" fill="#ffffff" font-family="Arial, sans-serif" font-size="24" font-weight="bold" text-anchor="middle">${svc.name}</text>
  </svg>`;
  res.setHeader('Content-Type', 'image/svg+xml');
  res.send(svg);
});

app.get('/api/services/:serviceId', async (req, res) => {
  const svc = STREAMING_SERVICES.find(s => s.id === req.params.serviceId);
  if (!svc) return res.status(404).json({ success: false, error: 'Service not found' });

  // Handle Free TV Live FAST Channels
  if (svc.isLive) {
    if (!freeTvCache.channels || freeTvCache.channels.length === 0) {
      await fetchFreeTvChannels();
    }
    let providerChannels = [];
    if (svc.id === 'pluto') providerChannels = freeTvCache.providers?.pluto || freeTvCache.channels.filter(c => c.provider === 'Pluto TV');
    else if (svc.id === 'roku') providerChannels = freeTvCache.providers?.roku || freeTvCache.channels.filter(c => c.provider === 'Roku Channel');
    else if (svc.id === 'tubi') providerChannels = freeTvCache.providers?.tubi || freeTvCache.channels.filter(c => c.provider === 'Tubi');
    else if (svc.id === 'plex') providerChannels = freeTvCache.providers?.plex || freeTvCache.channels.filter(c => c.provider === 'Plex TV');

    const catSet = new Set(['All']);
    providerChannels.forEach(c => { if (c.category) catSet.add(c.category); });

    return res.json({
      success: true,
      service: svc.name,
      serviceId: svc.id,
      isLive: true,
      categories: Array.from(catSet),
      items: providerChannels,
      channels: providerChannels
    });
  }

  const cacheFile = path.join(CACHE_DIR, `services_${svc.id}.json`);
  const force = req.query.force === 'true';

  if (!force && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
      if (cached && cached.items && cached.items.length > 0) {
        return res.json({ success: true, service: svc.name, serviceId: svc.id, items: cached.items });
      }
    } catch {}
  }

  try {
    const packages = svc.packages || [];
    const country = svc.country || 'US';

    const [popResult, newResult] = await Promise.allSettled([
      fetch('https://apis.justwatch.com/graphql', fetchJustWatchGraphQL(popularGraphQLQuery, { country, first: 40, filter: { packages }, sortBy: 'POPULAR' })).then(r => r.json()),
      fetch('https://apis.justwatch.com/graphql', fetchJustWatchGraphQL(newGraphQLQuery, { country, first: 40, filter: { packages } })).then(r => r.json())
    ]);

    const popEdges = (popResult.status === 'fulfilled' && popResult.value?.data?.popularTitles?.edges) || [];
    const freshEdges = (newResult.status === 'fulfilled' && newResult.value?.data?.newTitles?.edges) || [];

    const popItems = popEdges.map(e => parseGraphQLNode(e, svc.name)).filter(Boolean);
    const freshItems = freshEdges.map(e => parseGraphQLNode(e, svc.name)).filter(Boolean);

    const items = [];
    const seen = new Set();
    for (const it of [...freshItems, ...popItems]) {
      const k = `${it.title.toLowerCase()}_${it.type}`;
      if (!seen.has(k)) {
        seen.add(k);
        items.push(it);
      }
    }

    if (items.length > 0) {
      fs.writeFileSync(cacheFile, JSON.stringify({ lastUpdated: new Date().toISOString(), items }, null, 2), 'utf-8');
      return res.json({ success: true, service: svc.name, serviceId: svc.id, items });
    }
  } catch (err) {
    console.error(`[Services] Error loading ${svc.name}:`, err);
  }

  res.json({ success: true, service: svc.name, serviceId: svc.id, items: [] });
});

// What's On / Popular titles
app.get('/api/whatson', async (req, res) => {
  const cacheFile = path.join(CACHE_DIR, 'whatson_cache.json');
  const force = req.query.force === 'true';

  if (!force && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
      if (cached && cached.items && cached.items.length > 0) {
        const sanitizedItems = cached.items.map(it => ({
          ...it,
          image: it.image || ''
        }));
        return res.json({ success: true, items: sanitizedItems });
      }
    } catch {}
  }

  try {
    const packages = ['amz', 'asd', 'atp', 'crv', 'ctc', 'dnp', 'gtv', 'itu', 'nfx', 'pmp', 'prv'];
    const [popResult, newResult] = await Promise.allSettled([
      fetch('https://apis.justwatch.com/graphql', fetchJustWatchGraphQL(popularGraphQLQuery, { country: 'US', first: 40, filter: { packages }, sortBy: 'POPULAR' })).then(r => r.json()),
      fetch('https://apis.justwatch.com/graphql', fetchJustWatchGraphQL(newGraphQLQuery, { country: 'US', first: 40, filter: { packages } })).then(r => r.json())
    ]);

    const popEdges = (popResult.status === 'fulfilled' && popResult.value?.data?.popularTitles?.edges) || [];
    const freshEdges = (newResult.status === 'fulfilled' && newResult.value?.data?.newTitles?.edges) || [];

    const popItems = popEdges.map(e => parseGraphQLNode(e)).filter(Boolean);
    const freshItems = freshEdges.map(e => parseGraphQLNode(e)).filter(Boolean);

    const items = [];
    const seen = new Set();
    for (const it of [...popItems, ...freshItems]) {
      const k = `${it.title.toLowerCase()}_${it.type}`;
      if (!seen.has(k)) {
        seen.add(k);
        items.push({
          ...it,
          image: it.image || ''
        });
      }
    }

    if (items.length > 0) {
      fs.writeFileSync(cacheFile, JSON.stringify({ lastUpdated: new Date().toISOString(), items }, null, 2), 'utf-8');
      return res.json({ success: true, items });
    }
  } catch (err) {
    console.error('[WhatsOn] Fetch error:', err);
  }

  res.json({ success: true, items: [] });
});

// Stream endpoints for TV & Movie rails (compatibility with TV clients)
app.get(['/api/movie-streams', '/api/tv-streams'], (req, res) => {
  res.json({ results: [] });
});

// -------------------------------------------------------------
// Torrent Search & Multi-Engine Aggregator
// -------------------------------------------------------------

// Helper to identify non-English and foreign-dubbed torrent releases
function isForeignOrDubbedTorrent(rawTitle, query = '') {
  if (!rawTitle) return false;
  const title = String(rawTitle).toLowerCase();
  const qLower = String(query).toLowerCase();

  // 1. Cyrillic characters (Russian / Ukrainian / Bulgarian releases)
  // Skip check only if user explicitly typed Cyrillic in their search query
  if (/[\u0400-\u04FF]/.test(rawTitle) && !/[\u0400-\u04FF]/.test(query)) {
    return true;
  }

  // 2. Torrentio emoji flags: foreign flag without English flag
  // Flags: 🇷🇺 (RU), 🇮🇹 (IT), 🇪🇸 (ES), 🇫🇷 (FR), 🇩🇪 (DE), 🇵🇹 (PT), 🇧🇷 (BR), 🇮🇳 (IN)
  const foreignFlags = /[\u{1F1F7}\u{1F1FA}\u{1F1EE}\u{1F1F9}\u{1F1EA}\u{1F1F8}\u{1F1EB}\u{1F1F7}\u{1F1E9}\u{1F1EA}\u{1F1F5}\u{1F1F9}\u{1F1E7}\u{1F1F7}\u{1F1EE}\u{1F1F3}]/u;
  const englishFlags = /[\u{1F1EC}\u{1F1E7}\u{1F1FA}\u{1F1F8}]/u;
  if (foreignFlags.test(rawTitle) && !englishFlags.test(rawTitle)) {
    return true;
  }

  // 3. Foreign Dub & Audio release tag heuristics: [regex, tokenToIgnoreIfInQuery]
  const foreignPatterns = [
    // Italian
    [/\b(ita|italian|italiano|audio[-._ ]?ita|sub[-._ ]?ita)\b/i, 'ita'],
    // French
    [/\b(french|truefrench|vff|vfq|vf2|vostfr|subfrench)\b/i, 'french'],
    [/\b(vf)\b/i, 'vf'],
    // German
    [/\b(german|deutsch|synchro)\b/i, 'german'],
    // Spanish / Latin American
    [/\b(castellano|latino|audio[-._ ]?latino|sub[-._ ]?esp|espanol|español)\b/i, 'latino'],
    [/\b(spanish|spa)\b/i, 'spanish'],
    // Russian
    [/\b(rus|russian|mvo|avo|pvo|sub[-._ ]?rus)\b/i, 'russian'],
    // Portuguese
    [/\b(dublado|legendado|portuguese|pt[-._ ]?br)\b/i, 'portuguese'],
    // Hindi / Indian languages
    [/\b(hindi|tamil|telugu|malayalam|kannada|bengali|punjabi)\b/i, 'hindi'],
    [/\b(dual[-._ ]?audio)\b/i, 'dual'],
    // Other European languages
    [/\b(lektor|polski|turkce|turkish|hungarian|czech|dutch)\b/i, ''],
    // Generic foreign dubbing (unless explicitly English dubbed)
    [/(?<!eng|english)[-._ ]\b(dubbed)\b/i, 'dubbed'],
    [/\bforeign[-._ ]?dub\b/i, '']
  ];

  for (const [regex, keyword] of foreignPatterns) {
    if (keyword && qLower.includes(keyword)) continue;
    if (regex.test(title)) return true;
  }

  return false;
}

function sanitizeCleanTitle(str) {
  if (!str) return '';
  let s = String(str);

  // 1. Strip file extension if present (.mp4, .mkv, .avi, etc.)
  s = s.replace(/\.[a-z0-9]{2,5}$/i, '');

  // 2. Strip peer / seed / leech count patterns and icons FIRST (before stripping emoji chars)
  s = s.replace(/[👤👥]\s*\d+/gu, ' ');
  s = s.replace(/\b(?:seeds?|peers?|leech(?:ers?)?)\s*[:#]?\s*\d+\b/gi, ' ');
  s = s.replace(/\b\d+\s*(?:seeds?|peers?|leech(?:ers?)?)\b/gi, ' ');

  // 3. Strip file size patterns (e.g. "2.1 GB", "1.8GB", "750 MB", "4.5 GiB")
  s = s.replace(/\b\d+(?:\.\d+)?\s*(?:gb|mb|tb|gib|mib|tib|kb|kib|bytes|b)\b/gi, ' ');

  // 4. Strip Unicode emojis, pictographs, symbols, variation selectors, and icons (e.g. 💾, ⚙️, 🎬, 📺, etc.)
  s = s.replace(/[\uFE00-\uFE0F]/gu, '');
  s = s.replace(/\p{Extended_Pictographic}|\p{Emoji_Presentation}|[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu, ' ');

  // 5. Strip bracketed metadata (e.g. [1080p], [YTS.MX], [HEVC])
  s = s.replace(/\[.*?\]/g, ' ');

  // 6. Strip resolution, encoding, release groups
  s = s.replace(/\b(2160p|1080p|720p|480p|360p|576p|4k|8k|uhd|fhd|hd|sd)\b/gi, ' ');
  s = s.replace(/\b(bluray|blu-ray|brrip|bdrip|webrip|web-dl|webdl|web|hdtv|hdrip|dvdrip|dvd|cam|ts|telesync)\b/gi, ' ');
  s = s.replace(/\b(x264|h264|x265|h265|hevc|avc|xvid|divx|10bit|8bit|hdr|hdr10|hdr10\+|dv|dolby\s*vision)\b/gi, ' ');
  s = s.replace(/\b(aac|dts|dts-hd|ac3|eac3|ddp?5\.1|truehd|atmos|mp3|flac|stereo|5\.1|7\.1)\b/gi, ' ');
  s = s.replace(/\b(yts|yify|eztv|rarbg|psa|galaxytv|tgx|ettv|vxt|ion10|tpb|syncopy|megusta|realdebrid)\b/gi, ' ');
  s = s.replace(/\b(proper|repack|rerip|remastered|extended|directors?\s*cut|unrated|uncut|complete|multi(?:-?sub)?)\b/gi, ' ');

  // 7. Strip dots, underscores, extra dashes, and cleanup whitespace
  s = s.replace(/[._]/g, ' ');
  s = s.replace(/\s*-\s*/g, ' - ');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^[-:,\s]+|[-:,\s]+$/g, '').trim();

  return s;
}

async function doTorrentSearch(q, type = 'movie', options = {}) {
  q = (q || '').toString().trim();
  type = (type || 'movie').toString().toLowerCase();
  const filterForeign = options.filterForeign !== false;
  if (!q) return { results: [] };

  const results = [];
  const seenHashes = new Set();

  const addResult = (item) => {
    if (!item || !item.link) return;
    if (filterForeign && isForeignOrDubbedTorrent(item.title, q)) return;
    const hashMatch = item.link.match(/btih:([a-zA-Z0-9]+)/i);
    const hash = hashMatch ? hashMatch[1].toLowerCase() : item.id;
    if (seenHashes.has(hash)) return;
    seenHashes.add(hash);
    results.push(item);
  };

  // Clean query for search
  const cleanShow = q.replace(/[sS]\d{1,2}[eE]\d{1,2}.*$/, '').trim();
  const seMatch = q.match(/[sS](\d{1,2})[eE](\d{1,2})/i);
  const targetSeason = seMatch ? parseInt(seMatch[1], 10) : null;
  const targetEpisode = seMatch ? parseInt(seMatch[2], 10) : null;

  // Trackers to append
  const trList = DEFAULT_TRACKERS.map(t => `&tr=${encodeURIComponent(t)}`).join('');

  // Parallel Task 1: Apibay / The Pirate Bay Official API
  const searchApibay = async () => {
    try {
      const searchTerms = [q];
      if (cleanShow && cleanShow !== q) searchTerms.push(cleanShow);

      for (const term of searchTerms) {
        const res = await fetch(`https://apibay.org/q.php?q=${encodeURIComponent(term)}&cat=200`, {
          headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data)) {
            for (const item of data) {
              if (!item.info_hash || item.info_hash === '0000000000000000000000000000000000000000') continue;
              const name = item.name || 'Torrent Stream';
              const sNum = item.seeders ? parseInt(item.seeders, 10) : 0;
              const pNum = item.leechers ? parseInt(item.leechers, 10) : 0;
              const size = item.size ? parseInt(item.size, 10) : 0;

              // If specific season/episode requested, filter
              if (targetSeason !== null && targetEpisode !== null) {
                const epRegex = new RegExp(`[sS]0?${targetSeason}[eE]0?${targetEpisode}\\b`, 'i');
                if (!epRegex.test(name)) continue;
              }

              const magnet = `magnet:?xt=urn:btih:${item.info_hash}&dn=${encodeURIComponent(name)}${trList}`;
              addResult({
                id: `tpb-${item.info_hash}`,
                title: name,
                quality: name.includes('1080p') ? '1080p' : name.includes('720p') ? '720p' : name.includes('2160p') || name.includes('4K') ? '4K' : 'HD',
                size,
                seeds: sNum,
                peers: pNum,
                link: magnet,
                magnet,
                source: 'PirateBay'
              });
            }
          }
        }
      }
    } catch (err) {
      console.warn('[Torrent Search] Apibay error:', err.message);
    }
  };

  // Parallel Task 2: YTS Movies API
  const searchYTS = async () => {
    try {
      const ytsLangParam = filterForeign ? '&language=en' : '';
      const res = await fetch(`https://yts.mx/api/v2/list_movies.json?query_term=${encodeURIComponent(cleanShow || q)}&limit=20${ytsLangParam}`);
      if (res.ok) {
        const ytsData = await res.json();
        const movies = ytsData.data?.movies || [];
        for (const m of movies) {
          if (filterForeign && m.language && m.language.toLowerCase() !== 'en' && m.language.toLowerCase() !== 'english') continue;
          for (const t of (m.torrents || [])) {
            const magnet = `magnet:?xt=urn:btih:${t.hash}&dn=${encodeURIComponent(m.title_long || m.title)}${trList}`;
            addResult({
              id: `yts-${t.hash}`,
              title: `${m.title_long || m.title} [${t.quality}] [${t.type}]`,
              quality: t.quality || 'HD',
              size: t.size_bytes || 0,
              seeds: t.seeds || 0,
              peers: t.peers || 0,
              link: magnet,
              magnet,
              source: 'YTS'
            });
          }
        }
      }
    } catch (err) {
      console.warn('[Torrent Search] YTS error:', err.message);
    }
  };

  // Parallel Task 3: EZTV TV Shows via IMDB ID
  const searchEZTV = async () => {
    try {
      let imdbId = null;
      // Resolve IMDB ID from TVMaze
      const tvmRes = await fetch(`https://api.tvmaze.com/singlesearch/shows?q=${encodeURIComponent(cleanShow || q)}`);
      if (tvmRes.ok) {
        const tvmData = await tvmRes.json();
        imdbId = tvmData?.externals?.imdb?.replace(/^tt/, '');
      }

      if (imdbId) {
        const ezRes = await fetch(`https://eztvx.to/api/get-torrents?imdb_id=${encodeURIComponent(imdbId)}&limit=75`);
        if (ezRes.ok) {
          const ezData = await ezRes.json();
          for (const t of (ezData.torrents || [])) {
            if (!t.magnet_url && !t.hash) continue;
            const sNum = t.season ? parseInt(t.season, 10) : null;
            const eNum = t.episode ? parseInt(t.episode, 10) : null;

            if (targetSeason !== null && targetEpisode !== null) {
              if (sNum !== targetSeason || eNum !== targetEpisode) continue;
            }

            const magnet = t.magnet_url || `magnet:?xt=urn:btih:${t.hash}&dn=${encodeURIComponent(t.title || t.filename)}${trList}`;
            addResult({
              id: `eztv-${t.id || t.hash}`,
              title: t.title || t.filename,
              season: sNum,
              episode: eNum,
              quality: (t.title || '').includes('1080p') ? '1080p' : (t.title || '').includes('720p') ? '720p' : 'HD',
              size: t.size_bytes || 0,
              seeds: t.seeds || 0,
              peers: t.peers || 0,
              link: magnet,
              magnet,
              source: 'EZTV'
            });
          }
        }
      }
    } catch (err) {
      console.warn('[Torrent Search] EZTV error:', err.message);
    }
  };

  // Parallel Task 4: Cinemeta + Torrentio Multi-Tracker Swarm
  const searchTorrentio = async () => {
    try {
      // 1. Resolve IMDb ID from Cinemeta
      const metaType = type === 'tv' ? 'series' : 'movie';
      const cRes = await fetch(`https://v3-cinemeta.strem.io/catalog/${metaType}/top/search=${encodeURIComponent(cleanShow || q)}.json`);
      let imdbId = null;
      if (cRes.ok) {
        const cData = await cRes.json();
        if (cData?.metas && cData.metas.length > 0) {
          imdbId = cData.metas[0].imdb_id || cData.metas[0].id;
        }
      }

      if (imdbId) {
        const streamPath = targetSeason && targetEpisode
          ? `series/${imdbId}:${targetSeason}:${targetEpisode}.json`
          : metaType === 'series'
            ? `series/${imdbId}:1:1.json`
            : `movie/${imdbId}.json`;

        const tioRes = await fetch(`https://torrentio.strem.fun/stream/${streamPath}`, {
          headers: { 'User-Agent': 'Mozilla/5.0' }
        });

        if (tioRes.ok) {
          const tioData = await tioRes.json();
          for (const s of (tioData.streams || [])) {
            if (!s.infoHash) continue;
            const rawName = String(s.title || s.name || '').replace(/\n/g, ' ');
            const seedMatch = rawName.match(/👤\s*(\d+)/) || rawName.match(/seeds?:\s*(\d+)/i);
            const seeds = seedMatch ? parseInt(seedMatch[1], 10) : 5;
            const sizeMatch = rawName.match(/(\d+(?:\.\d+)?)\s*(GB|MB|GiB|MiB)/i);
            let sizeBytes = 0;
            if (sizeMatch) {
              const val = parseFloat(sizeMatch[1]);
              const unit = sizeMatch[2].toUpperCase();
              sizeBytes = unit.startsWith('G') ? Math.round(val * 1024 * 1024 * 1024) : Math.round(val * 1024 * 1024);
            }
            const cleanTitle = sanitizeCleanTitle(rawName) || rawName;
            const magnet = `magnet:?xt=urn:btih:${s.infoHash}&dn=${encodeURIComponent(cleanTitle)}${trList}`;

            addResult({
              id: `tio-${s.infoHash}`,
              title: cleanTitle,
              quality: rawName.includes('1080p') ? '1080p' : rawName.includes('720p') ? '720p' : rawName.includes('4K') || rawName.includes('2160p') ? '4K' : 'HD',
              size: sizeBytes,
              seeds,
              peers: 0,
              link: magnet,
              magnet,
              source: 'Torrentio'
            });
          }
        }
      }
    } catch (err) {
      console.warn('[Torrent Search] Torrentio error:', err.message);
    }
  };

  // Execute ALL search providers concurrently
  await Promise.allSettled([
    searchApibay(),
    searchYTS(),
    searchEZTV(),
    searchTorrentio()
  ]);

  // Sort results by seeders descending
  results.sort((a, b) => (b.seeds || 0) - (a.seeds || 0));

  return { results };
}

app.get('/api/torrent-search', async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim();
    const type = (req.query.type || 'movie').toString().toLowerCase();
    const filterForeign = req.query.filterForeign !== 'false';
    const result = await doTorrentSearch(q, type, { filterForeign });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Search failed: ' + err.message });
  }
});

// -------------------------------------------------------------
// WebTorrent Streaming Engine & Error Guard
// -------------------------------------------------------------
let webtorrentClient = null;
const activeTorrentStreams = new Map();
const TORRENT_CACHE_DIR = path.join(DATA_DIR, 'torrents');
if (!fs.existsSync(TORRENT_CACHE_DIR)) fs.mkdirSync(TORRENT_CACHE_DIR, { recursive: true });

function guardTorrentRequest(torrent) {
  if (!torrent || torrent._requestGuarded) return;
  torrent._requestGuarded = true;
  const origRequest = torrent._request;
  if (typeof origRequest === 'function') {
    torrent._request = function(pieceIndex, offset, length) {
      if (!this.pieces || !this.pieces[pieceIndex]) {
        return;
      }
      try {
        return origRequest.apply(this, arguments);
      } catch (err) {
        console.warn('[Torrent._request Guarded]:', err.message);
      }
    };
  }
}

function guardTorrentDebug(torrent) {
  if (!torrent || torrent._debugGuarded) return;
  torrent._debugGuarded = true;
  const origUpdate = torrent._update;
  if (typeof origUpdate === 'function') {
    torrent._update = function() {
      try {
        return origUpdate.apply(this, arguments);
      } catch (err) {
        console.warn('[Torrent._update Guarded]:', err.message);
      }
    };
  }
}

process.on('uncaughtException', (err) => {
  console.error('[Uncaught Exception Intercepted]:', err.message || err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Unhandled Rejection Intercepted]:', reason?.message || reason);
});

const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.openbittorrent.com:80',
  'udp://tracker.coppersurfer.tk:6969',
  'udp://glotorrents.pw:6969/announce',
  'udp://tracker.leechers-paradise.org:6969'
];

function normalizeMagnet(url) {
  if (typeof url === 'string' && url.startsWith('magnet:')) {
    let clean = url;
    for (const tr of DEFAULT_TRACKERS) {
      if (!clean.includes(encodeURIComponent(tr)) && !clean.includes(tr)) {
        clean += `&tr=${encodeURIComponent(tr)}`;
      }
    }
    return clean;
  }
  return url;
}

async function getWebTorrentClient() {
  if (!webtorrentClient) {
    try {
      const mod = await import('webtorrent').catch(() => null);
      const WebTorrentClass = typeof mod === 'function' ? mod : (mod?.default || mod);
      if (typeof WebTorrentClass === 'function') {
        webtorrentClient = new WebTorrentClass({
          maxConns: 60,
          dht: true,
          tracker: true
        });
        webtorrentClient.on('error', (err) => {
          console.warn('[WebTorrent Client Error]:', err?.message || err);
        });
      }
    } catch (err) {
      console.warn('[WebTorrent] Local engine not available:', err?.message || err);
    }
  }
  return webtorrentClient;
}

let cachedTorrentServerUrl = null;
let lastTorrentServerCheck = 0;

function getTorrentHeaders(extra = {}) {
  const key = process.env.TORRENT_NODE_KEY || process.env.DOWNLOADER_SECRET_KEY || process.env.NODE_KEY || process.env.TORRENT_DASHBOARD_KEY || process.env.DASHBOARD_KEY || '';
  return {
    'Accept': 'application/json',

    ...(key ? { 'x-node-key': key, 'x-dashboard-key': key } : {}),
    ...extra
  };
}

async function getActiveTorrentServer() {
  const now = Date.now();
  if (cachedTorrentServerUrl && (now - lastTorrentServerCheck < 20000)) {
    return cachedTorrentServerUrl;
  }

  const configured = (process.env.TORRENT_STREAM_SERVER || process.env.DOWNLOADER_URL || '').replace(/\/+$/, '');
  const candidateUrls = [];
  if (configured) {
    candidateUrls.push(configured);
    if (!configured.includes(':4000')) candidateUrls.push(`${configured}:4000`);
  }
  candidateUrls.push('http://download.butfree.online:4000');
  candidateUrls.push('http://74.208.22.119:4000');
  if (configured && configured.includes('download.butfree.online')) {
    candidateUrls.push(configured.replace('download.butfree.online', '74.208.22.119'));
  }
  candidateUrls.push('http://74.208.22.119');
  candidateUrls.push('http://127.0.0.1:4000');
  candidateUrls.push('http://localhost:4000');
  candidateUrls.push('http://127.0.0.1:42069');
  candidateUrls.push('http://localhost:42069');

  for (const candidate of candidateUrls) {
    try {
      const res = await fetch(`${candidate}/api/torrent/status`, {
        headers: getTorrentHeaders(),
        signal: AbortSignal.timeout(3000)
      });
      if (res.ok) {
        cachedTorrentServerUrl = candidate;
        lastTorrentServerCheck = now;
        return candidate;
      }
    } catch (_) {}
  }

  return configured || 'http://download.butfree.online:4000';
}

app.get('/api/torrent/status', async (req, res) => {
  const configured = (process.env.TORRENT_STREAM_SERVER || process.env.DOWNLOADER_URL || '').replace(/\/+$/, '');
  let serverUrl = await getActiveTorrentServer();

  try {
    let testRes = null;
    try {
      testRes = await fetch(`${serverUrl}/api/torrent/status`, {
        headers: getTorrentHeaders(),
        signal: AbortSignal.timeout(5000)
      });
    } catch (fetchErr) {
      if (serverUrl.includes('download.butfree.online')) {
        const direct = serverUrl.replace('download.butfree.online', '74.208.22.119');
        testRes = await fetch(`${direct}/api/torrent/status`, {
          headers: getTorrentHeaders(),
          signal: AbortSignal.timeout(5000)
        });
        if (testRes.ok) {
          cachedTorrentServerUrl = direct;
          serverUrl = direct;
        }
      }
      if (!testRes) throw fetchErr;
    }

    if (testRes.ok) {
      const vpsStatus = await testRes.json();
      return res.json({
        configured: true,
        mode: 'remote-vps',
        vpsServer: configured || serverUrl,
        status: 'online',
        details: vpsStatus
      });
    } else {
      return res.json({
        configured: true,
        mode: 'remote-vps',
        vpsServer: configured || serverUrl,
        status: 'error',
        httpStatus: testRes.status
      });
    }
  } catch (err) {
    const cause = err.cause?.message || err.cause?.code || err.cause || '';
    const fullError = cause ? `${err.message} (${cause})` : err.message;
    return res.json({
      configured: true,
      mode: 'remote-vps',
      vpsServer: configured || serverUrl,
      status: 'offline',
      error: fullError
    });
  }
});

app.get('/api/torrent/cache/size', authenticate, requireAdmin, async (req, res) => {
  const targetServer = await getActiveTorrentServer();
  try {
    const vpsRes = await fetch(`${targetServer}/api/torrent/cache/size`, {
      headers: getTorrentHeaders(),
      signal: AbortSignal.timeout(5000)
    });
    const data = await vpsRes.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: `Could not reach torrent streamer: ${err.message}` });
  }
});

app.post('/api/torrent/cache/clear', authenticate, requireAdmin, async (req, res) => {
  const targetServer = await getActiveTorrentServer();
  try {
    const vpsRes = await fetch(`${targetServer}/api/torrent/cache/clear`, {
      method: 'POST',
      headers: getTorrentHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(req.body || {}),
      signal: AbortSignal.timeout(30000)
    });
    const data = await vpsRes.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: `Could not reach torrent streamer: ${err.message}` });
  }
});

app.post('/api/torrent/restart', authenticate, requireAdmin, async (req, res) => {
  const targetServer = await getActiveTorrentServer();
  const headers = getTorrentHeaders({ 'Content-Type': 'application/json' });

  try {
    console.log(`[Torrent Streamer]: Forwarding restart command to ${targetServer}...`);
    let vpsRes = null;
    try {
      vpsRes = await fetch(`${targetServer}/api/torrent/restart`, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(10000)
      });
    } catch (_) {
      // Endpoint error or network disconnect during reboot
    }

    if (!vpsRes || vpsRes.status === 404) {
      try {
        vpsRes = await fetch(`${targetServer}/api/dashboard/restart`, {
          method: 'POST',
          headers,
          signal: AbortSignal.timeout(10000)
        });
      } catch (_) {}
    }

    if (!vpsRes) {
      return res.json({
        success: true,
        message: 'Restart command dispatched to remote torrent streamer (rebooting process).',
        server: targetServer
      });
    }

    const data = await vpsRes.json().catch(() => ({}));
    return res.json({
      success: true,
      message: data.message || 'Restarting torrent streamer node...',
      server: targetServer,
      ...data
    });
  } catch (err) {
    return res.status(500).json({
      error: `Could not send restart command to torrent streamer: ${err.message}`,
      server: targetServer
    });
  }
});

app.post('/api/torrent/stream', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing torrent URL or magnet' });

  const targetServer = await getActiveTorrentServer();
  console.log(`[Torrent Stream Dispatch]: Sending to ${targetServer}...`);

  try {
    const forwardRes = await fetch(`${targetServer}/api/torrent/stream`, {
      method: 'POST',
      headers: getTorrentHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(60000)
    });
    const data = await forwardRes.json().catch(() => ({}));
    if (forwardRes.ok && data.streamUrl) {
      let streamPath = data.streamUrl || '';
      if (streamPath.startsWith('http')) {
        try { streamPath = new URL(streamPath).pathname; } catch (_) {}
      }
      return res.json({
        success: true,
        streamUrl: streamPath,
        title: data.title
      });
    } else {
      return res.status(forwardRes.status || 500).json({
        error: data.error || `Torrent server returned status ${forwardRes.status}`
      });
    }
  } catch (err) {
    const cause = err.cause?.message || err.cause?.code || err.cause || '';
    const fullError = cause ? `${err.message} (${cause})` : err.message;
    console.error(`[Torrent Node Error]: ${fullError}`);
    return res.status(502).json({ error: `Torrent Streamer (${targetServer}) error: ${fullError}` });
  }
});

app.post('/api/torrent/stream/:streamId/stop', async (req, res) => {
  const { streamId } = req.params;
  const targetServer = await getActiveTorrentServer();

  try {
    const stopRes = await fetch(`${targetServer}/api/torrent/stream/${encodeURIComponent(streamId)}/stop`, {
      method: 'POST',
      headers: getTorrentHeaders(),
      signal: AbortSignal.timeout(10000)
    });
    const data = await stopRes.json().catch(() => ({}));
    return res.json({ success: true, ...data });
  } catch (err) {
    console.error(`[Torrent Stop Proxy Error]: ${err.message}`);
    return res.status(502).json({ error: 'Torrent stop failed: ' + err.message });
  }
});

const handleTorrentServe = async (req, res) => {
  const { streamId, fileIndex } = req.params;
  const targetServer = await getActiveTorrentServer();

  const controller = new AbortController();
  try {
    const vpsUrl = `${targetServer}/api/torrent/serve/${encodeURIComponent(streamId)}/${encodeURIComponent(fileIndex || 0)}`;
    const reqHeaders = getTorrentHeaders();
    if (req.headers.range) reqHeaders['range'] = req.headers.range;
    if (req.headers['user-agent']) reqHeaders['user-agent'] = req.headers['user-agent'];

    const vpsRes = await fetch(vpsUrl, {
      method: req.method,
      headers: reqHeaders,
      signal: controller.signal
    });

    if (vpsRes.ok || vpsRes.status === 206) {
      res.status(vpsRes.status);
      ['content-range', 'accept-ranges', 'content-length', 'content-type'].forEach(h => {
        const val = vpsRes.headers.get(h);
        if (val) res.setHeader(h, val);
      });
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', '*');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Type');

      if (req.method === 'HEAD') {
        return res.end();
      }

      const { Readable } = await import('stream');
      if (vpsRes.body) {
        const nodeStream = Readable.fromWeb(vpsRes.body);
        nodeStream.pipe(res);
        nodeStream.on('error', (err) => {
          if (!res.headersSent) res.status(500).end();
          else res.end();
        });
        req.on('close', () => {
          controller.abort();
          try { nodeStream.destroy(); } catch (_) {}
        });
        return;
      }
    } else {
      const errorText = await vpsRes.text().catch(() => 'Stream serve error');
      return res.status(vpsRes.status).send(errorText);
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('[Torrent Serve Proxy Error]:', err.message);
    if (!res.headersSent) res.status(502).send('Torrent Streamer Proxy Error: ' + err.message);
    else res.end();
  }
};

app.get('/api/torrent/serve/:streamId/:fileIndex', handleTorrentServe);
app.head('/api/torrent/serve/:streamId/:fileIndex', handleTorrentServe);

// -------------------------------------------------------------
// Transcoding Configuration (Per User)
// -------------------------------------------------------------
const DEFAULT_TRANSCODE_SETTINGS = {
  enabled: true,
  targetHeight: '720',
  codec: 'h264',
  preset: 'veryfast',
  crf: '22',
  audioCodec: 'aac',
  audioBitrate: '128k',
  force: false
};

app.get('/api/settings/transcode', authenticate, (req, res) => {
  const settings = getUserFile(req.user.id, 'transcode.json', DEFAULT_TRANSCODE_SETTINGS);
  res.json({ success: true, settings: { ...DEFAULT_TRANSCODE_SETTINGS, ...settings } });
});

app.post('/api/settings/transcode', authenticate, (req, res) => {
  const current = getUserFile(req.user.id, 'transcode.json', DEFAULT_TRANSCODE_SETTINGS);
  const updated = {
    ...current,
    ...req.body,
    updatedAt: new Date().toISOString()
  };
  saveUserFile(req.user.id, 'transcode.json', updated);
  res.json({ success: true, settings: updated });
});

// -------------------------------------------------------------
// Cloud Torrent Downloader & Google Drive Loader
// -------------------------------------------------------------
const userLibraryUpdateTimestamps = new Map();

async function dispatchTorrentDownload({ userId, magnet, title, kind, meta = {}, transcodeConfig = null }) {
  if (!magnet) {
    return { ok: false, status: 400, error: 'Missing magnet or torrent URL' };
  }

  const folders = getUserFile(userId, 'folders.json', {});
  const effectiveMeta = { ...meta };
  const effectiveKind = kind || (effectiveMeta.showName || /[sS]\d+/i.test(title || '') ? 'tv' : 'movie');
  effectiveMeta.kind = effectiveKind;

  if (effectiveKind === 'tv') {
    const rawTitle = title || effectiveMeta.title || '';
    const tvMatch = rawTitle.match(/^(.*?)[ ._-]+[sS](\d{1,2})[eE](\d{1,2})/i) ||
                    rawTitle.match(/^(.*?)[ ._-]+(\d{1,2})x(\d{1,2})/i);
    if (tvMatch) {
      if (!effectiveMeta.showName) {
        effectiveMeta.showName = sanitizeCleanTitle(tvMatch[1]);
      }
      if (!effectiveMeta.season) effectiveMeta.season = parseInt(tvMatch[2], 10);
      if (!effectiveMeta.episode) effectiveMeta.episode = parseInt(tvMatch[3], 10);
    } else if (!effectiveMeta.showName && title) {
      effectiveMeta.showName = sanitizeCleanTitle(title);
    }
    if (effectiveMeta.showName) {
      effectiveMeta.showName = sanitizeCleanTitle(effectiveMeta.showName);
      effectiveMeta.showName = effectiveMeta.showName.replace(/(?:[ ._-]+[sS]\d+[eE]\d+|[ ._-]+[sS]\d+|\bseason\s*\d+|\b\d+x\d+).*$/i, '').trim();
      effectiveMeta.showName = effectiveMeta.showName.replace(/\s+\b(19\d\d|20\d\d)\b$/g, '').trim();
      effectiveMeta.showName = effectiveMeta.showName.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    }
    if (!effectiveMeta.showName) effectiveMeta.showName = 'TV Series';
    if (!effectiveMeta.season) effectiveMeta.season = 1;
    if (!effectiveMeta.episode) effectiveMeta.episode = 1;
  } else {
    // Movie
    let movieTitle = effectiveMeta.cleanTitle || effectiveMeta.title || title || '';
    const yearMatch = (title || '').match(/\b(19\d\d|20\d\d)\b/);
    const movieYear = effectiveMeta.year || (yearMatch ? parseInt(yearMatch[1], 10) : null);

    movieTitle = sanitizeCleanTitle(movieTitle);
    if (movieYear) {
      movieTitle = movieTitle.replace(new RegExp(`\\b${movieYear}\\b`, 'g'), '').trim();
      movieTitle = movieTitle.replace(/\(\s*\)/g, '').trim();
    }
    movieTitle = movieTitle.split(' ').filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    if (!movieTitle) movieTitle = 'Movie';

    effectiveMeta.cleanTitle = movieTitle;
    effectiveMeta.title = movieTitle;
    if (movieYear) effectiveMeta.year = movieYear;

    if (!effectiveMeta.genre) {
      try {
        const metaResult = await fetchMovieMeta(movieTitle, movieYear);
        if (metaResult?.genres?.length > 0) {
          let g = metaResult.genres[0];
          if (/action/i.test(g)) g = 'Action';
          else if (/sci-?fi/i.test(g)) g = 'Sci-Fi';
          else if (/comedy/i.test(g)) g = 'Comedy';
          else if (/horror/i.test(g)) g = 'Horror';
          else if (/thriller/i.test(g)) g = 'Thriller';
          else if (/drama/i.test(g)) g = 'Drama';
          else if (/animation/i.test(g)) g = 'Animation';
          else if (/romance/i.test(g)) g = 'Romance';
          else if (/documentary/i.test(g)) g = 'Documentary';
          else if (/adventure/i.test(g)) g = 'Adventure';
          else if (/crime/i.test(g)) g = 'Crime';
          else if (/mystery/i.test(g)) g = 'Mystery';
          else if (/family/i.test(g)) g = 'Family';
          else if (/fantasy/i.test(g)) g = 'Fantasy';
          effectiveMeta.genre = g;
        }
      } catch (_) {}
    }
    if (!effectiveMeta.genre) {
      effectiveMeta.genre = 'Movies';
    }
  }

  const rootFolder = effectiveKind === 'tv' ? folders.tv : folders.movies;

  if (!rootFolder || !rootFolder.id) {
    return {
      ok: false,
      status: 400,
      error: `Please configure your ${effectiveKind === 'tv' ? 'TV Shows' : 'Movies'} folder in Settings before downloading.`
    };
  }

  // Pre-flight check: is the target folder view-only / shared without edit access?
  if (rootFolder.canAddChildren === false) {
    return {
      ok: false,
      status: 403,
      error: `Cannot download to "${rootFolder.name || 'selected folder'}". You only have viewing access to this folder (it is shared with you without edit permissions). Please choose a folder you own or have edit access to in Drive Settings.`
    };
  }

  let accessToken;
  try {
    accessToken = await getValidGoogleToken(userId);
  } catch (err) {
    return {
      ok: false,
      status: 401,
      error: 'Google Drive authentication required. Please reconnect Google Drive in Settings.',
      reauth: true
    };
  }

  // If canAddChildren was not cached yet, verify with Google Drive API
  if (rootFolder.canAddChildren === undefined && rootFolder.id !== 'root') {
    try {
      const chkRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(rootFolder.id)}?fields=id,name,capabilities(canAddChildren),ownedByMe&supportsAllDrives=true`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (chkRes.ok) {
        const meta = await chkRes.json();
        const canAdd = meta.capabilities?.canAddChildren ?? true;
        rootFolder.canAddChildren = canAdd;
        rootFolder.ownedByMe = meta.ownedByMe ?? true;
        folders[effectiveKind === 'tv' ? 'tv' : 'movies'] = rootFolder;
        saveUserFile(userId, 'folders.json', folders);

        if (!canAdd) {
          return {
            ok: false,
            status: 403,
            error: `Cannot download to "${rootFolder.name || 'selected folder'}". You only have viewing access to this folder (it is shared with you without edit permissions). Please choose a folder you own or have edit access to in Drive Settings.`
          };
        }
      }
    } catch (chkErr) {
      console.warn('[Downloads Add] Error checking folder capabilities:', chkErr.message);
    }
  }

  const userTranscode = getUserFile(userId, 'transcode.json', DEFAULT_TRANSCODE_SETTINGS);
  const effectiveTranscodeConfig = {
    ...DEFAULT_TRANSCODE_SETTINGS,
    ...userTranscode,
    ...(transcodeConfig || {})
  };

  const targetServer = await getActiveTorrentServer();
  const webhookUrl = `${TV_PUBLIC_URL}/api/downloads/webhook`;

  try {
    const vpsRes = await fetch(`${targetServer}/api/torrent/download`, {
      method: 'POST',
      headers: getTorrentHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        magnet,
        title: title || 'Download',
        kind: effectiveKind,
        meta: effectiveMeta,
        driveConfig: {
          accessToken,
          rootFolderId: rootFolder.id,
          tokenRefreshUrl: `${TV_PUBLIC_URL}/api/downloads/token-refresh`
        },
        transcodeConfig: effectiveTranscodeConfig,
        webhookUrl,
        userId
      })
    });

    if (!vpsRes.ok) {
      const errBody = await vpsRes.text();
      return { ok: false, status: vpsRes.status, error: `Torrent node error: ${errBody}` };
    }

    const data = await vpsRes.json();
    return { ok: true, status: 200, data };
  } catch (err) {
    console.error('[Downloads Add] Error dispatching to Torrent VPS:', err);
    return { ok: false, status: 502, error: `Could not reach torrent streaming server: ${err.message}` };
  }
}

app.post('/api/downloads/add', authenticate, async (req, res) => {
  const { magnet, title, kind, meta = {}, transcodeConfig = null } = req.body;
  const result = await dispatchTorrentDownload({
    userId: req.user.id,
    magnet,
    title,
    kind,
    meta,
    transcodeConfig
  });
  if (!result.ok) {
    return res.status(result.status || 500).json({ error: result.error, reauth: result.reauth });
  }
  res.json(result.data);
});

app.get('/api/downloads', authenticate, async (req, res) => {
  const userId = req.user.id;
  const targetServer = await getActiveTorrentServer();
  const libraryUpdatedAt = userLibraryUpdateTimestamps.get(userId) || 0;

  try {
    const vpsRes = await fetch(`${targetServer}/api/torrent/downloads?userId=${encodeURIComponent(userId)}`, {
      headers: getTorrentHeaders({ 'Accept': 'application/json' }),
      signal: AbortSignal.timeout(4000)
    });

    if (vpsRes.ok) {
      const data = await vpsRes.json();
      return res.json({ ...data, libraryUpdatedAt });
    }
    res.json({ success: true, downloads: [], libraryUpdatedAt });
  } catch (err) {
    res.json({ success: true, downloads: [], libraryUpdatedAt, warning: 'Torrent node unreachable' });
  }
});

app.post('/api/downloads/:id/cancel', authenticate, async (req, res) => {
  const targetServer = await getActiveTorrentServer();
  try {
    const vpsRes = await fetch(`${targetServer}/api/torrent/download/${req.params.id}/cancel`, {
      method: 'POST',
      headers: getTorrentHeaders({ 'Content-Type': 'application/json' })
    });
    const data = await vpsRes.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.delete('/api/downloads/history', authenticate, async (req, res) => {
  const userId = req.user.id;
  const targetServer = await getActiveTorrentServer();
  try {
    const vpsRes = await fetch(`${targetServer}/api/torrent/downloads/history?userId=${encodeURIComponent(userId)}`, {
      method: 'DELETE',
      headers: getTorrentHeaders({ 'Content-Type': 'application/json' }),
      signal: AbortSignal.timeout(4000)
    });
    if (vpsRes.ok) {
      const data = await vpsRes.json();
      return res.json(data);
    }
  } catch (err) {
    console.warn('[Downloads] Failed to clear history on VPS:', err.message);
  }
  res.json({ success: true, count: 0 });
});

app.post('/api/downloads/clear-history', authenticate, async (req, res) => {
  const userId = req.user.id;
  const targetServer = await getActiveTorrentServer();
  try {
    const vpsRes = await fetch(`${targetServer}/api/torrent/downloads/history?userId=${encodeURIComponent(userId)}`, {
      method: 'DELETE',
      headers: getTorrentHeaders({ 'Content-Type': 'application/json' }),
      signal: AbortSignal.timeout(4000)
    });
    if (vpsRes.ok) {
      const data = await vpsRes.json();
      return res.json(data);
    }
  } catch (err) {
    console.warn('[Downloads] Failed to clear history on VPS:', err.message);
  }
  res.json({ success: true, count: 0 });
});

app.delete('/api/downloads/:id', authenticate, async (req, res) => {
  const targetServer = await getActiveTorrentServer();
  try {
    const vpsRes = await fetch(`${targetServer}/api/torrent/download/${req.params.id}`, {
      method: 'DELETE',
      headers: getTorrentHeaders({ 'Content-Type': 'application/json' }),
      signal: AbortSignal.timeout(4000)
    });
    const data = await vpsRes.json();
    res.json(data);
  } catch (err) {
    res.json({ success: true, deleted: false });
  }
});

app.post('/api/downloads/token-refresh', async (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }

  try {
    const accessToken = await refreshGoogleAccessToken(userId);
    console.log(`[Google Token] Successfully refreshed Drive access token for user ${userId}`);
    res.json({ success: true, accessToken });
  } catch (err) {
    console.warn(`[Google Token] Force refresh failed for user ${userId} (${err.message}). Trying getValidGoogleToken...`);
    try {
      const fallbackToken = await getValidGoogleToken(userId);
      res.json({ success: true, accessToken: fallbackToken });
    } catch (fallbackErr) {
      console.error(`[Google Token] Failed to obtain valid Google access token for user ${userId}:`, fallbackErr.message);
      res.status(401).json({
        error: 'Google Drive authentication expired or revoked. Please reconnect in Settings.',
        reauth: true
      });
    }
  }
});

app.post('/api/downloads/webhook', async (req, res) => {
  const { jobId, userId, status, driveFileId, cleanName, meta = {} } = req.body;
  console.log(`[Downloads Webhook] Job ${jobId} status: ${status} ("${cleanName || 'untitled'}") for user ${userId}`);

  if (status === 'completed' && userId) {
    // 1. Immediately inject the completed item into library.json so ondemand queries return it right now!
    try {
      const library = getUserFile(userId, 'library.json', {
        shows: {},
        showsList: [],
        movies: [],
        moviesPosters: {},
        movieFolders: {},
        movieFolderList: [],
        genresList: [],
        genres: {}
      });

      const kind = meta.kind || (meta.showName ? 'tv' : 'movie');

      if (kind === 'tv' && meta.showName) {
        const showName = meta.showName;
        const seasonNum = String(meta.season || 1);
        const epNum = meta.episode || 1;
        const filename = cleanName || `${showName} - S${String(seasonNum).padStart(2, '0')}E${String(epNum).padStart(2, '0')}.mp4`;

        if (!library.shows) library.shows = {};
        if (!library.showsList) library.showsList = [];
        if (!library.shows[showName]) {
          library.shows[showName] = {};
          if (!library.showsList.includes(showName)) library.showsList.push(showName);
        }
        if (!library.shows[showName][seasonNum]) {
          library.shows[showName][seasonNum] = [];
        }

        const existingIdx = library.shows[showName][seasonNum].findIndex(ep => ep.id === driveFileId || ep.filename === filename);
        const epObj = {
          id: driveFileId || `drive_${Date.now()}`,
          driveId: driveFileId || `drive_${Date.now()}`,
          filename,
          title: filename.replace(/\.[^/.]+$/, ''),
          show: showName,
          season: parseInt(seasonNum, 10),
          episode: epNum,
          path: `drive://${driveFileId}`,
          modifiedTime: new Date().toISOString()
        };

        if (existingIdx >= 0) {
          library.shows[showName][seasonNum][existingIdx] = epObj;
        } else {
          library.shows[showName][seasonNum].push(epObj);
        }

        fetchShowPoster(showName).then(poster => {
          if (poster) {
            library.showsPosters = library.showsPosters || {};
            library.showsPosters[showName] = poster;
            saveUserFile(userId, 'library.json', library);
          }
        }).catch(() => {});
      } else {
        // Movie
        const genre = meta.genre || 'Movies';
        const title = meta.cleanTitle || meta.title || (cleanName ? cleanName.replace(/\.[^/.]+$/, '').replace(/\(\d{4}\)/, '').trim() : 'Movie');
        const year = meta.year || null;
        const filename = cleanName || `${title}${year ? ` (${year})` : ''}.mp4`;

        library.movies = library.movies || [];
        library.movieFolders = library.movieFolders || {};
        library.movieFolderList = library.movieFolderList || [];
        library.genres = library.genres || {};
        library.genresList = library.genresList || [];

        const existingIdx = library.movies.findIndex(m => m.id === driveFileId || m.filename === filename);
        const movieObj = {
          id: driveFileId || `drive_${Date.now()}`,
          driveId: driveFileId || `drive_${Date.now()}`,
          filename,
          title,
          year,
          path: `drive://${driveFileId}`,
          folder: genre,
          folderPath: genre,
          relPath: `${genre}/${filename}`,
          modifiedTime: new Date().toISOString()
        };

        if (existingIdx >= 0) {
          library.movies[existingIdx] = movieObj;
        } else {
          library.movies.push(movieObj);
        }

        if (!library.movieFolders[genre]) {
          library.movieFolders[genre] = [];
          if (!library.movieFolderList.includes(genre)) library.movieFolderList.push(genre);
        }
        if (!library.movieFolders[genre].some(m => m.id === movieObj.id)) {
          library.movieFolders[genre].push(movieObj);
        }

        if (!library.genres[genre]) {
          library.genres[genre] = [];
          if (!library.genresList.includes(genre)) library.genresList.push(genre);
        }
        if (!library.genres[genre].some(m => m.id === movieObj.id)) {
          library.genres[genre].push(movieObj);
        }

        fetchMovieMeta(title, year).then(res => {
          if (res?.posterUrl) {
            movieObj.posterUrl = res.posterUrl;
            library.moviesPosters = library.moviesPosters || {};
            library.moviesPosters[title] = res.posterUrl;
            if (driveFileId) library.moviesPosters[driveFileId] = res.posterUrl;
            saveUserFile(userId, 'library.json', library);
          }
        }).catch(() => {});
      }

      library.updatedAt = Date.now();
      saveUserFile(userId, 'library.json', library);
      userLibraryUpdateTimestamps.set(userId, Date.now());
      console.log(`[Downloads Webhook] Injected "${cleanName}" directly into library.json for user ${userId}.`);
    } catch (injErr) {
      console.warn(`[Downloads Webhook] Error injecting into library.json:`, injErr.message);
    }

    // 2. Trigger full background Google Drive scan for the user so everything is strictly synced
    setTimeout(async () => {
      try {
        console.log(`[Downloads Webhook] Auto-scanning library for user ${userId}...`);
        await scanUserDrive(userId);
        userLibraryUpdateTimestamps.set(userId, Date.now());
        console.log(`[Downloads Webhook] Library refresh complete for user ${userId}.`);
      } catch (scanErr) {
        console.warn(`[Downloads Webhook] Auto-scan error: ${scanErr.message}`);
      }
    }, 1000);
  }

  res.json({ success: true, received: true });
});

// -------------------------------------------------------------
// RSS Feeds (TV & Movie Feeds)
// -------------------------------------------------------------
const DEFAULT_RSS_FEEDS = [
  { id: 'eztv', url: 'https://myrss.org/eztv', name: 'EZTV Shows', defaultType: 'tv', enabled: true },
  { id: 'atlas', url: 'https://atlas.rssly.org/feed', name: 'YTS Movies', defaultType: 'movie', enabled: true }
];

const RSS_FALLBACK_URLS = {
  eztv: [
    'https://myrss.org/eztv',
    'https://eztvx.to/ezrss.xml',
    'https://eztv.re/ezrss.xml',
    'https://eztv.wf/ezrss.xml'
  ],
  atlas: [
    'https://atlas.rssly.org/feed',
    'https://yts.mx/rss',
    'https://yts.nz/rss'
  ]
};

let rssCache = {
  items: [],
  lastFetched: 0,
  fetching: null
};

function decodeXmlEntities(str) {
  if (!str) return '';
  return str
    .replace(/&#0*39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(code))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function parseRssFeedXml(xml, feedInfo) {
  if (!xml || typeof xml !== 'string') return [];
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[1];

    const titleMatch = itemXml.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>|<title>([\s\S]*?)<\/title>/i);
    const title = decodeXmlEntities((titleMatch ? (titleMatch[1] || titleMatch[2] || '') : '').trim());

    // 1. Direct Magnet URI tag (with or without CDATA and namespace)
    const magnetMatch = itemXml.match(/<(?:torrent:)?(?:magnetURI|magnetUrl|magnet)><!\[CDATA\[([\s\S]*?)\]\]><\/(?:torrent:)?(?:magnetURI|magnetUrl|magnet)>|<(?:torrent:)?(?:magnetURI|magnetUrl|magnet)>([\s\S]*?)<\/(?:torrent:)?(?:magnetURI|magnetUrl|magnet)>/i);
    let magnet = magnetMatch ? decodeXmlEntities((magnetMatch[1] || magnetMatch[2] || '').trim()) : '';

    // 2. InfoHash tag
    const hashTagMatch = itemXml.match(/<(?:torrent:)?(?:infoHash|hash)>([0-9a-fA-F]{40})<\/(?:torrent:)?(?:infoHash|hash)>/i);
    const infoHash = hashTagMatch ? hashTagMatch[1] : '';

    const encMatch = itemXml.match(/<enclosure[^>]*url=["']([^"']+)["'][^>]*(?:length=["'](\d+)["'])?[^>]*(?:type=["']([^"']+)["'])?/i);
    let enclosureUrl = encMatch ? decodeXmlEntities(encMatch[1]) : '';
    let enclosureLength = encMatch && encMatch[2] ? parseInt(encMatch[2], 10) : 0;

    const lenMatch = itemXml.match(/<(?:torrent:)?contentLength>(\d+)<\/(?:torrent:)?contentLength>/i);
    let sizeBytes = lenMatch ? parseInt(lenMatch[1], 10) : (enclosureLength || 0);

    const linkMatch = itemXml.match(/<link><!\[CDATA\[([\s\S]*?)\]\]><\/link>|<link>([\s\S]*?)<\/link>/i);
    let link = linkMatch ? decodeXmlEntities((linkMatch[1] || linkMatch[2] || '').trim()) : '';

    if (!magnet && infoHash) {
      magnet = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451%2Fannounce&tr=udp%3A%2F%2Ftracker.dler.org%3A6969%2Fannounce`;
    }

    if (!magnet && enclosureUrl) {
      const hexMatch = enclosureUrl.match(/\/download\/([0-9a-fA-F]{40})/i);
      if (hexMatch) {
        magnet = `magnet:?xt=urn:btih:${hexMatch[1]}&dn=${encodeURIComponent(title)}&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451%2Fannounce&tr=udp%3A%2F%2Ftracker.dler.org%3A6969%2Fannounce`;
      } else if (enclosureUrl.startsWith('magnet:')) {
        magnet = enclosureUrl;
      }
    }

    if (!magnet && link && link.startsWith('magnet:')) {
      magnet = link;
    }

    const effectiveLink = magnet || enclosureUrl || link;
    if (!title || !effectiveLink) continue;

    const descMatch = itemXml.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>|<description>([\s\S]*?)<\/description>/i);
    const descRaw = descMatch ? decodeXmlEntities((descMatch[1] || descMatch[2] || '').trim()) : '';
    const description = descRaw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

    let poster = '';
    const imgMatch = descRaw.match(/<img[^>]*src=["']([^"']+)["']/i);
    if (imgMatch) poster = decodeXmlEntities(imgMatch[1]);
    if (!poster) {
      const mediaThumb = itemXml.match(/<media:thumbnail[^>]*url=["']([^"']+)["']/i);
      if (mediaThumb) poster = decodeXmlEntities(mediaThumb[1]);
    }

    let sizeText = '';
    const sizeInDesc = descRaw.match(/Size:\s*([\d.]+\s*(?:GB|MB|KB))/i);
    if (sizeInDesc) {
      sizeText = sizeInDesc[1];
    } else if (sizeBytes > 0) {
      if (sizeBytes > 1024 * 1024 * 1024) sizeText = `${(sizeBytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
      else if (sizeBytes > 1024 * 1024) sizeText = `${(sizeBytes / 1024 / 1024).toFixed(0)} MB`;
    }

    const dateMatch = itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/i);
    const pubDate = dateMatch ? dateMatch[1].trim() : '';

    const qMatch = title.match(/\b(2160p|4k|1080p|720p|480p)\b/i);
    const quality = qMatch ? qMatch[1].toLowerCase() : '';

    // Category and Genre detection
    const catMatch = itemXml.match(/<category>([\s\S]*?)<\/category>/i);
    const categoryRaw = catMatch ? catMatch[1].trim().toLowerCase() : '';

    let type = feedInfo.defaultType || 'movie';
    if (categoryRaw.includes('tv') || categoryRaw.includes('television')) {
      type = 'tv';
    } else if (categoryRaw.includes('movie') || categoryRaw.includes('film')) {
      type = 'movie';
    }

    let genre = '';
    const allCatMatches = [...itemXml.matchAll(/<category>([\s\S]*?)<\/category>/gi)];
    for (const cm of allCatMatches) {
      const catText = decodeXmlEntities(cm[1]).trim();
      if (!catText) continue;
      if (!/^(movies|tv|television|video|other|applications|highres|720p|1080p|2160p|4k)$/i.test(catText)) {
        genre = catText.split(/[\/,]/)[0].trim();
        break;
      }
    }
    if (!genre && descRaw) {
      const gDescMatch = descRaw.match(/(?:Genre|Genres):\s*([a-zA-Z0-9\s,\/]+?)(?:<|\n|$|Size|Runtime|Quality)/i);
      if (gDescMatch) {
        genre = gDescMatch[1].split(/[\/,]/)[0].trim();
      }
    }
    if (genre) {
      if (/action/i.test(genre)) genre = 'Action';
      else if (/sci-?fi/i.test(genre)) genre = 'Sci-Fi';
      else if (/comedy/i.test(genre)) genre = 'Comedy';
      else if (/horror/i.test(genre)) genre = 'Horror';
      else if (/thriller/i.test(genre)) genre = 'Thriller';
      else if (/drama/i.test(genre)) genre = 'Drama';
      else if (/animation/i.test(genre)) genre = 'Animation';
      else if (/romance/i.test(genre)) genre = 'Romance';
      else if (/documentary/i.test(genre)) genre = 'Documentary';
      else if (/adventure/i.test(genre)) genre = 'Adventure';
      else if (/crime/i.test(genre)) genre = 'Crime';
      else if (/mystery/i.test(genre)) genre = 'Mystery';
      else if (/family/i.test(genre)) genre = 'Family';
      else if (/fantasy/i.test(genre)) genre = 'Fantasy';
    }

    let season = null;
    let episode = null;
    let year = null;
    let cleanTitle = title;

    const tvMatch = title.match(/^(.*?)[ ._-]+[sS](\d{1,2})[eE](\d{1,2})/i);
    if (tvMatch) {
      type = 'tv';
      cleanTitle = tvMatch[1].replace(/[._-]/g, ' ').trim();
      season = parseInt(tvMatch[2], 10);
      episode = parseInt(tvMatch[3], 10);
    } else {
      const yearMatch = title.match(/^(.*?)[ ._(-]+(\b(?:19|20)\d{2}\b)/);
      if (yearMatch) {
        cleanTitle = yearMatch[1].replace(/[._-]/g, ' ').trim();
        year = parseInt(yearMatch[2], 10);
      }
    }

    const itemHash = crypto.createHash('sha256').update(String(effectiveLink || '') + '|' + String(title || '')).digest('hex').slice(0, 20);
    items.push({
      id: `rss_${itemHash}`,
      title,
      cleanTitle,
      link: effectiveLink,
      magnet: magnet || effectiveLink,
      type,
      genre,
      season,
      episode,
      year,
      quality,
      size: sizeText,
      sizeBytes,
      poster,
      pubDate,
      feedId: feedInfo.id || feedInfo.name,
      feedName: feedInfo.name,
      feedUrl: feedInfo.url,
      description
    });
  }

  return items;
}

// Fetch helper: tries global fetch first, falls back to https.get with redirect & gzip support
async function fetchRssXml(targetUrl, timeoutMs = 12000) {
  // Strategy 1: Node fetch with full browser headers
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      },
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (res.ok) {
      const text = await res.text();
      if (text && (text.includes('<rss') || text.includes('<feed') || text.includes('<item'))) {
        return { ok: true, xml: text, url: targetUrl, method: 'fetch', status: res.status };
      }
    }
  } catch (_) {
    // Fall back to https.get
  }

  // Strategy 2: Node built-in https.get with redirect following and decompression
  return new Promise((resolve) => {
    function tryGet(currUrl, hops = 0) {
      if (hops > 5) {
        return resolve({ ok: false, error: 'Too many redirects', url: currUrl });
      }

      let parsedUrl;
      try {
        parsedUrl = new URL(currUrl);
      } catch (err) {
        return resolve({ ok: false, error: 'Invalid URL: ' + err.message, url: currUrl });
      }

      const client = parsedUrl.protocol === 'http:' ? http : https;
      const req = client.get(currUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'application/rss+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate',
          'Cache-Control': 'no-cache'
        },
        timeout: timeoutMs
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const nextUrl = new URL(res.headers.location, currUrl).href;
          res.resume();
          return tryGet(nextUrl, hops + 1);
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return resolve({ ok: false, status: res.statusCode, error: `HTTP ${res.statusCode}`, url: currUrl });
        }

        let stream = res;
        const encoding = (res.headers['content-encoding'] || '').toLowerCase();
        if (encoding === 'gzip') {
          stream = res.pipe(zlib.createGunzip());
        } else if (encoding === 'deflate') {
          stream = res.pipe(zlib.createInflate());
        }

        let rawData = '';
        stream.setEncoding('utf8');
        stream.on('data', chunk => { rawData += chunk; });
        stream.on('end', () => {
          if (rawData && (rawData.includes('<rss') || rawData.includes('<feed') || rawData.includes('<item'))) {
            resolve({ ok: true, xml: rawData, url: currUrl, method: 'https.get', status: res.statusCode });
          } else {
            resolve({ ok: false, xml: rawData, error: 'Response was not valid RSS XML', url: currUrl, status: res.statusCode });
          }
        });
        stream.on('error', (err) => resolve({ ok: false, error: err.message, url: currUrl }));
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ ok: false, error: 'Request timeout', url: currUrl });
      });

      req.on('error', (err) => {
        resolve({ ok: false, error: err.message, url: currUrl });
      });
    }

    tryGet(targetUrl);
  });
}

async function fetchAllRssFeeds(customFeeds = null, force = false) {
  const now = Date.now();
  if (!force && rssCache.items.length > 0 && now - rssCache.lastFetched < 10 * 60 * 1000) {
    return rssCache.items;
  }
  if (rssCache.fetching) {
    return rssCache.fetching;
  }

  const feeds = Array.isArray(customFeeds) && customFeeds.length > 0 ? customFeeds : DEFAULT_RSS_FEEDS;

  rssCache.fetching = (async () => {
    try {
      const allItems = [];
      await Promise.all(
        feeds.filter(f => f.enabled !== false).map(async (feed) => {
          // Build list of candidate URLs (configured URL first, then known mirrors)
          const fallbackUrls = RSS_FALLBACK_URLS[feed.id] || [];
          const candidateUrls = [feed.url, ...fallbackUrls.filter(u => u !== feed.url)];

          let fetchedItems = [];
          for (const candUrl of candidateUrls) {
            try {
              const res = await fetchRssXml(candUrl, 10000);
              if (res.ok && res.xml) {
                const parsed = parseRssFeedXml(res.xml, { ...feed, url: candUrl });
                if (parsed.length > 0) {
                  fetchedItems = parsed;
                  break;
                }
              }
            } catch (_) {}
          }

          if (fetchedItems.length > 0) {
            allItems.push(...fetchedItems);
          }
        })
      );

      allItems.sort((a, b) => {
        const timeA = a.pubDate ? new Date(a.pubDate).getTime() : 0;
        const timeB = b.pubDate ? new Date(b.pubDate).getTime() : 0;
        return timeB - timeA;
      });

      rssCache.items = allItems;
      rssCache.lastFetched = Date.now();
      return allItems;
    } finally {
      rssCache.fetching = null;
    }
  })();

  return rssCache.fetching;
}

app.get('/api/rss-feeds', authenticate, async (req, res) => {
  const force = req.query.refresh === 'true' || req.query.force === 'true';
  const typeFilter = req.query.type;
  const feeds = getUserFile(req.user.id, 'rss_feeds.json', DEFAULT_RSS_FEEDS);

  try {
    const items = await fetchAllRssFeeds(feeds, force);
    let filtered = items;
    if (typeFilter && typeFilter !== 'all') {
      filtered = items.filter(it => it.type === typeFilter);
    }
    res.json({
      success: true,
      items: filtered,
      total: filtered.length,
      lastFetched: rssCache.lastFetched,
      feeds
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch RSS feeds: ' + err.message });
  }
});

app.post('/api/rss-feeds/refresh', authenticate, async (req, res) => {
  const feeds = getUserFile(req.user.id, 'rss_feeds.json', DEFAULT_RSS_FEEDS);
  try {
    const items = await fetchAllRssFeeds(feeds, true);
    res.json({
      success: true,
      items,
      total: items.length,
      lastFetched: rssCache.lastFetched,
      feeds
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// Coming Soon / Upcoming Releases — Metacritic Discovery
// -------------------------------------------------------------
const COMING_SOON_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const COMING_SOON_SERVICES = [
  'Netflix', 'Hulu', 'Disney+', 'Prime Video', 'Apple TV+', 'Max', 'Peacock', 'Paramount+',
  'Bravo', 'Hayu', 'FX', 'Showtime', 'HBO', 'AMC', 'Starz', 'MGM+', 'BBC One', 'BBC'
];

async function scrapeMetacriticPage(url, isCinema = false) {
  const pageRes = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    },
    signal: AbortSignal.timeout(10000)
  });
  if (!pageRes.ok) throw new Error(`HTTP ${pageRes.status} fetching ${url}`);
  const html = await pageRes.text();
  const match = html.match(/<script[^>]*id="__NUXT_DATA__"[^>]*>(.*?)<\/script>/is);
  if (!match) return [];
  const data = JSON.parse(match[1]);
  const rootData = data[3];
  if (!rootData) return [];
  const browseKey = Object.keys(rootData).find(k => k.startsWith('browse-'));
  if (!browseKey) return [];

  function resolve(val, visited = new Set()) {
    if (val === null || val === undefined) return val;
    if (typeof val === 'number') {
      if (val >= 0 && val < data.length) {
        if (visited.has(val)) return `[Circular:${val}]`;
        const nv = new Set(visited);
        nv.add(val);
        return resolveValue(data[val], nv);
      }
      return val;
    }
    return resolveValue(val, visited);
  }

  function resolveValue(val, visited) {
    if (val === null || val === undefined) return val;
    if (typeof val !== 'object') return val;
    if (Array.isArray(val)) return val.map(item => resolve(item, new Set(visited)));
    const obj = {};
    for (const key of Object.keys(val)) obj[key] = resolve(val[key], new Set(visited));
    return obj;
  }

  const browseData = resolve(rootData[browseKey]);
  const rawItems = browseData.items || [];

  return rawItems.map(item => {
    const type = item.type === 'show' ? 'tv' : 'movie';
    const releaseDate = item.releaseDate || item.premiereDate || '';

    const detectedServices = [];
    if (isCinema) {
      detectedServices.push('Cinema');
    } else {
      if (item.network) detectedServices.push(item.network);
      if (item.streamingDates && Array.isArray(item.streamingDates.networks)) {
        item.streamingDates.networks.forEach(n => {
          if (n && n.name) detectedServices.push(n.name);
        });
      }
      const desc = item.description || '';
      for (const s of COMING_SOON_SERVICES) {
        const regex = new RegExp(`\\b${s.replace('+', '\\+')}\\b`, 'i');
        if (regex.test(desc)) detectedServices.push(s);
      }
      if (detectedServices.length === 0) {
        detectedServices.push(type === 'movie' ? 'Cinema' : 'Other');
      }
    }

    const services = [...new Set(detectedServices)].map(s => {
      if (s.toLowerCase() === 'bbc' || s.toLowerCase() === 'bbc one') return 'BBC';
      if (s.toLowerCase() === 'hbo' || s.toLowerCase() === 'max') return 'Max';
      return s;
    });

    let image = null;
    if (item.image && item.image.bucketPath) {
      image = `https://www.metacritic.com/a/img/catalog${item.image.bucketPath}`;
    }

    let year = null;
    if (releaseDate) {
      const ym = releaseDate.match(/\b(20\d\d|19\d\d)\b/);
      if (ym) year = parseInt(ym[1], 10);
    }

    return {
      title: item.title,
      type,
      releaseDate,
      year,
      description: item.description || '',
      image,
      services,
      duration: item.duration,
      numberOfSeasons: item.numberOfSeasons
    };
  });
}

async function fetchComingSoonTitles(force = false) {
  const cacheFile = path.join(CACHE_DIR, 'discover_upcoming.json');
  if (!force && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
      if (cached && cached.items && Date.now() - new Date(cached.lastUpdated).getTime() < COMING_SOON_CACHE_TTL_MS) {
        return { success: true, items: cached.items, lastUpdated: cached.lastUpdated, cached: true };
      }
    } catch (_) {}
  }

  console.log('[Coming Soon] Scraping Metacritic for upcoming TV & movie titles...');
  try {
    const urls = [
      'https://www.metacritic.com/browse/movie/?releaseType=coming-soon&page=1',
      'https://www.metacritic.com/browse/movie/?releaseType=coming-soon&page=2',
      'https://www.metacritic.com/browse/movie/?releaseType=in-theaters&page=1',
      'https://www.metacritic.com/browse/tv/?releaseType=coming-soon&page=1'
    ];

    const results = await Promise.allSettled(urls.map((url, i) => scrapeMetacriticPage(url, i === 2)));
    const allItems = [];
    for (const res of results) {
      if (res.status === 'fulfilled' && Array.isArray(res.value)) {
        allItems.push(...res.value);
      }
    }

    const uniqueMap = new Map();
    allItems.forEach(item => {
      const key = `${item.title.toLowerCase()}_${item.type}`;
      if (!uniqueMap.has(key)) {
        uniqueMap.set(key, item);
      } else {
        const existing = uniqueMap.get(key);
        existing.services = [...new Set([...existing.services, ...item.services])];
      }
    });

    const uniqueItems = [...uniqueMap.values()];
    const nowIso = new Date().toISOString();

    try {
      fs.writeFileSync(cacheFile, JSON.stringify({ lastUpdated: nowIso, items: uniqueItems }, null, 2), 'utf-8');
    } catch (err) {
      console.warn('[Coming Soon] Cache write error:', err.message);
    }

    return { success: true, items: uniqueItems, lastUpdated: nowIso, cached: false };
  } catch (err) {
    console.error('[Coming Soon] Scrape failed:', err.message);
    if (fs.existsSync(cacheFile)) {
      try {
        const stale = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
        return { success: true, items: stale.items, lastUpdated: stale.lastUpdated, cached: true, stale: true };
      } catch (_) {}
    }
    return { success: false, items: [], error: err.message };
  }
}

app.get(['/api/coming-soon', '/api/discover/upcoming'], authenticate, async (req, res) => {
  const force = req.query.refresh === 'true' || req.query.force === 'true';
  const result = await fetchComingSoonTitles(force);
  res.json(result);
});

app.get('/api/settings/rss', authenticate, requireAdmin, (req, res) => {
  const feeds = getUserFile(req.user.id, 'rss_feeds.json', DEFAULT_RSS_FEEDS);
  const wishlist = getUserWishlist(req.user.id);
  res.json({
    success: true,
    feeds,
    intervalMinutes: wishlist.settings?.intervalMinutes || 30,
    wishlistEnabled: wishlist.settings?.enabled !== false
  });
});

app.post('/api/settings/rss', authenticate, requireAdmin, (req, res) => {
  const { feeds, intervalMinutes, wishlistEnabled } = req.body;
  if (feeds !== undefined) {
    if (!Array.isArray(feeds)) {
      return res.status(400).json({ error: 'feeds must be an array' });
    }
    saveUserFile(req.user.id, 'rss_feeds.json', feeds);
    rssCache.lastFetched = 0;
  }
  if (intervalMinutes !== undefined || wishlistEnabled !== undefined) {
    const wishlist = getUserWishlist(req.user.id);
    if (intervalMinutes !== undefined) {
      wishlist.settings.intervalMinutes = Math.max(5, parseInt(intervalMinutes, 10) || 30);
    }
    if (wishlistEnabled !== undefined) {
      wishlist.settings.enabled = !!wishlistEnabled;
    }
    saveUserWishlist(req.user.id, wishlist);
  }
  const updatedFeeds = getUserFile(req.user.id, 'rss_feeds.json', DEFAULT_RSS_FEEDS);
  const updatedWishlist = getUserWishlist(req.user.id);
  res.json({
    success: true,
    feeds: updatedFeeds,
    intervalMinutes: updatedWishlist.settings?.intervalMinutes || 30,
    wishlistEnabled: updatedWishlist.settings?.enabled !== false
  });
});

// -------------------------------------------------------------
// RSS Wish List: Auto-Monitor, Transcode & Drive Loader Pipeline
// -------------------------------------------------------------
const DEFAULT_WISHLIST_SETTINGS = {
  intervalMinutes: 30,
  enabled: true,
  lastCheckedAt: null,
  nextCheckAt: null,
  lastCheckSummary: null
};

function getUserWishlist(userId) {
  const data = getUserFile(userId, 'wishlist.json', {
    items: [],
    settings: { ...DEFAULT_WISHLIST_SETTINGS },
    history: []
  });
  if (!Array.isArray(data.items)) data.items = [];
  data.settings = { ...DEFAULT_WISHLIST_SETTINGS, ...(data.settings || {}) };
  if (!Array.isArray(data.history)) data.history = [];
  return data;
}

function saveUserWishlist(userId, wishlistData) {
  saveUserFile(userId, 'wishlist.json', wishlistData);
}

function normalizeWishTitle(str) {
  if (!str) return '';
  return String(str)
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function matchRssItemWithWishlist(item, wishItem, userLibrary = {}) {
  if (!item || !wishItem) return { matched: false };
  if (wishItem.enabled === false) return { matched: false };

  // 1. Media Type match
  const wishType = wishItem.type || 'tv';
  if (wishType !== 'all' && item.type && item.type !== wishType) {
    return { matched: false };
  }

  // 2. Title matching
  const wishNorm = normalizeWishTitle(wishItem.title);
  if (!wishNorm) return { matched: false };

  const cleanNorm = normalizeWishTitle(item.cleanTitle || '');
  const rawNorm = normalizeWishTitle(item.title || '');

  let titleMatches = false;
  if (cleanNorm === wishNorm) {
    titleMatches = true;
  } else if (cleanNorm.startsWith(wishNorm + ' ')) {
    titleMatches = true;
  } else if (rawNorm.startsWith(wishNorm + ' ') || rawNorm === wishNorm) {
    titleMatches = true;
  }

  if (!titleMatches) {
    return { matched: false };
  }

  // 3. Quality filter
  const prefQ = (wishItem.quality || 'any').toLowerCase();
  if (prefQ !== 'any') {
    const itemQ = ((item.quality || '') + ' ' + (item.title || '')).toLowerCase();
    if (prefQ === '2160p' || prefQ === '4k') {
      if (!itemQ.includes('2160') && !itemQ.includes('4k')) {
        return { matched: false, reason: 'quality_mismatch' };
      }
    } else if (!itemQ.includes(prefQ)) {
      return { matched: false, reason: 'quality_mismatch' };
    }
  }

  // 4. TV show duplicate & scope check
  if (wishType === 'tv') {
    const season = item.season || 1;
    const episode = item.episode || 1;
    const epKey = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;

    // Specific season check if specified
    if (wishItem.season && Number(wishItem.season) !== season) {
      return { matched: false, reason: 'season_mismatch' };
    }
    // Specific episode check if specified
    if (wishItem.episode && Number(wishItem.episode) !== episode) {
      return { matched: false, reason: 'episode_mismatch' };
    }

    // Check if already downloaded by wishlist
    const downloadedEps = Array.isArray(wishItem.downloadedEpisodes) ? wishItem.downloadedEpisodes : [];
    if (downloadedEps.includes(epKey)) {
      return { matched: false, reason: 'already_downloaded', epKey };
    }

    // Check if already downloaded release item hash or title
    const downloadedItems = Array.isArray(wishItem.downloadedItems) ? wishItem.downloadedItems : [];
    if (downloadedItems.some(d => d.id === item.id || d.title === item.title)) {
      return { matched: false, reason: 'already_downloaded', epKey };
    }

    // Check if already in Google Drive library
    if (userLibrary && userLibrary.shows) {
      for (const [showName, seasons] of Object.entries(userLibrary.shows)) {
        if (normalizeWishTitle(showName) === wishNorm) {
          const seasonEps = seasons[String(season)] || [];
          if (seasonEps.some(e => Number(e.episode) === episode)) {
            return { matched: false, reason: 'already_in_library', epKey };
          }
        }
      }
    }

    return { matched: true, epKey, season, episode, kind: 'tv' };
  }

  // 5. Movie duplicate & scope check
  if (wishType === 'movie') {
    if (wishItem.year && item.year) {
      if (Number(wishItem.year) !== Number(item.year)) {
        return { matched: false, reason: 'year_mismatch' };
      }
    }

    // Check if already downloaded
    const downloadedItems = Array.isArray(wishItem.downloadedItems) ? wishItem.downloadedItems : [];
    if (downloadedItems.length > 0 || downloadedItems.some(d => d.id === item.id || d.title === item.title)) {
      return { matched: false, reason: 'already_downloaded' };
    }

    // Check if already in Google Drive library
    if (userLibrary && Array.isArray(userLibrary.movies)) {
      const existsInLibrary = userLibrary.movies.some(m => {
        const movieNorm = normalizeWishTitle(m.cleanTitle || m.title || '');
        if (movieNorm === wishNorm) {
          if (wishItem.year && m.year) {
            return Number(m.year) === Number(wishItem.year);
          }
          return true;
        }
        return false;
      });
      if (existsInLibrary) {
        return { matched: false, reason: 'already_in_library' };
      }
    }

    return { matched: true, kind: 'movie', year: item.year || wishItem.year };
  }

  return { matched: true, kind: item.type || 'tv' };
}

const activeWishlistChecks = new Set();

async function checkUserWishlist(userId, force = false) {
  if (activeWishlistChecks.has(userId)) {
    return { ok: false, error: 'Check already in progress' };
  }
  activeWishlistChecks.add(userId);

  try {
    const wishlist = getUserWishlist(userId);
    const enabledItems = (wishlist.items || []).filter(i => i.enabled !== false);
    if (enabledItems.length === 0) {
      wishlist.settings.lastCheckedAt = new Date().toISOString();
      wishlist.settings.nextCheckAt = new Date(Date.now() + (wishlist.settings.intervalMinutes || 30) * 60 * 1000).toISOString();
      wishlist.settings.lastCheckSummary = 'Wish list is empty or all items are paused.';
      saveUserWishlist(userId, wishlist);
      return { ok: true, matchedCount: 0, newDownloads: [], summary: wishlist.settings.lastCheckSummary };
    }

    // Check if user has Drive credentials & folders configured
    const folders = getUserFile(userId, 'folders.json', {});
    if (!folders?.tv?.id && !folders?.movies?.id) {
      const summary = 'Cannot auto-download: TV/Movies folders not configured in Drive Settings.';
      wishlist.settings.lastCheckedAt = new Date().toISOString();
      wishlist.settings.lastCheckSummary = summary;
      saveUserWishlist(userId, wishlist);
      return { ok: false, error: summary };
    }

    if (folders?.tv?.canAddChildren === false && folders?.movies?.canAddChildren === false) {
      const summary = 'Cannot auto-download: Selected Google Drive folders are view-only (no edit access). Please select writable folders in Drive Settings.';
      wishlist.settings.lastCheckedAt = new Date().toISOString();
      wishlist.settings.lastCheckSummary = summary;
      saveUserWishlist(userId, wishlist);
      return { ok: false, error: summary };
    }

    // Fetch latest RSS items
    const userFeeds = getUserFile(userId, 'rss_feeds.json', DEFAULT_RSS_FEEDS);
    const rssItems = await fetchAllRssFeeds(userFeeds, force);
    const userLibrary = getUserFile(userId, 'library.json', {});

    const newDownloads = [];
    let matchedCount = 0;

    for (const wishItem of enabledItems) {
      for (const item of rssItems) {
        if (!item.magnet && !item.link) continue;

        const matchResult = matchRssItemWithWishlist(item, wishItem, userLibrary);
        if (!matchResult.matched) continue;

        // Auto-download if enabled on wish item (default true)
        if (wishItem.autoDownload !== false) {
          const targetKind = matchResult.kind || item.type || 'tv';
          const targetFolder = targetKind === 'tv' ? folders.tv : folders.movies;
          if (targetFolder?.canAddChildren === false) {
            console.log(`[RSS Wishlist] Skipping auto-download for "${item.title}": ${targetKind} folder "${targetFolder.name || 'folder'}" is view-only.`);
            continue;
          }

          console.log(`[RSS Wishlist] Match found for user ${userId}: "${item.title}" (wish: "${wishItem.title}")`);

          const downloadRes = await dispatchTorrentDownload({
            userId,
            magnet: item.magnet || item.link,
            title: item.title,
            kind: matchResult.kind || item.type,
            meta: {
              showName: matchResult.kind === 'tv' ? (item.cleanTitle || wishItem.title) : undefined,
              season: matchResult.season || item.season || undefined,
              episode: matchResult.episode || item.episode || undefined,
              year: matchResult.year || item.year || wishItem.year || undefined,
              genre: item.genre || undefined,
              cleanTitle: item.cleanTitle || wishItem.title
            }
          });

          if (downloadRes.ok) {
            matchedCount++;
            const record = {
              id: item.id || `match_${Date.now()}`,
              title: item.title,
              cleanTitle: item.cleanTitle || wishItem.title,
              type: matchResult.kind || item.type,
              quality: item.quality || 'unknown',
              season: matchResult.season || item.season,
              episode: matchResult.episode || item.episode,
              epKey: matchResult.epKey,
              magnet: item.magnet || item.link,
              jobId: downloadRes.data?.job?.id || downloadRes.data?.id || null,
              downloadedAt: new Date().toISOString()
            };

            if (!wishItem.downloadedItems) wishItem.downloadedItems = [];
            wishItem.downloadedItems.unshift(record);

            if (matchResult.epKey) {
              if (!wishItem.downloadedEpisodes) wishItem.downloadedEpisodes = [];
              if (!wishItem.downloadedEpisodes.includes(matchResult.epKey)) {
                wishItem.downloadedEpisodes.push(matchResult.epKey);
              }
            }

            wishItem.lastMatchedAt = record.downloadedAt;
            wishItem.matchCount = (wishItem.matchCount || 0) + 1;

            if (!wishlist.history) wishlist.history = [];
            wishlist.history.unshift({
              id: `hist_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              wishItemId: wishItem.id,
              wishTitle: wishItem.title,
              releaseTitle: item.title,
              type: matchResult.kind || item.type,
              season: matchResult.season,
              episode: matchResult.episode,
              epKey: matchResult.epKey,
              quality: item.quality,
              timestamp: record.downloadedAt,
              status: 'queued',
              jobId: record.jobId
            });
            if (wishlist.history.length > 50) wishlist.history = wishlist.history.slice(0, 50);

            newDownloads.push(record);
          } else {
            console.warn(`[RSS Wishlist] Failed to dispatch download for "${item.title}":`, downloadRes.error);
          }
        }
      }
    }

    const intervalMin = wishlist.settings.intervalMinutes || 30;
    wishlist.settings.lastCheckedAt = new Date().toISOString();
    wishlist.settings.nextCheckAt = new Date(Date.now() + intervalMin * 60 * 1000).toISOString();
    wishlist.settings.lastCheckSummary = matchedCount > 0
      ? `Checked ${rssItems.length} releases: queued ${matchedCount} new item(s) to Drive.`
      : `Checked ${rssItems.length} releases: no new matching items found.`;

    saveUserWishlist(userId, wishlist);

    return {
      ok: true,
      matchedCount,
      newDownloads,
      summary: wishlist.settings.lastCheckSummary,
      lastCheckedAt: wishlist.settings.lastCheckedAt,
      nextCheckAt: wishlist.settings.nextCheckAt
    };
  } catch (err) {
    console.error(`[RSS Wishlist] Error checking user ${userId}:`, err);
    return { ok: false, error: err.message };
  } finally {
    activeWishlistChecks.delete(userId);
  }
}

function checkAllUsersWishlists() {
  try {
    if (!fs.existsSync(USERS_DIR)) return;
    const userDirs = fs.readdirSync(USERS_DIR);

    for (const userId of userDirs) {
      const userDir = path.join(USERS_DIR, userId);
      try {
        if (!fs.statSync(userDir).isDirectory()) continue;
      } catch (_) {
        continue;
      }

      const wishlist = getUserWishlist(userId);
      if (wishlist.settings.enabled === false) continue;
      if (!wishlist.items || wishlist.items.length === 0) continue;

      const intervalMs = (wishlist.settings.intervalMinutes || 30) * 60 * 1000;
      const lastCheckTime = wishlist.settings.lastCheckedAt
        ? new Date(wishlist.settings.lastCheckedAt).getTime()
        : 0;

      if (Date.now() - lastCheckTime >= intervalMs) {
        console.log(`[RSS Wishlist Worker] Running scheduled check for user ${userId} (interval: ${wishlist.settings.intervalMinutes || 30}m)...`);
        checkUserWishlist(userId, false).catch(err => {
          console.warn(`[RSS Wishlist Worker] Error during scheduled check for user ${userId}:`, err.message);
        });
      }
    }
  } catch (err) {
    console.warn('[RSS Wishlist Worker] Periodic sweep error:', err.message);
  }
}

// Background scheduler: checks every 60 seconds whether any user's wishlist is due for checking
setInterval(() => {
  checkAllUsersWishlists();
}, 60 * 1000);

// Initial check 35 seconds after server startup
setTimeout(() => {
  console.log('[RSS Wishlist Worker] Running initial post-startup check...');
  checkAllUsersWishlists();
}, 35 * 1000);

// Wish List Endpoints
app.get('/api/wishlist', authenticate, (req, res) => {
  const wishlist = getUserWishlist(req.user.id);
  res.json({
    success: true,
    items: wishlist.items,
    settings: wishlist.settings,
    history: wishlist.history
  });
});

app.post('/api/wishlist', authenticate, async (req, res) => {
  const { title, type = 'tv', quality = 'any', season = null, episode = null, year = null, autoDownload = true } = req.body;
  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'Title is required' });
  }

  const wishlist = getUserWishlist(req.user.id);
  const cleanTitle = title.trim();

  // Avoid exact duplicates in list
  const existing = (wishlist.items || []).find(
    i => normalizeWishTitle(i.title) === normalizeWishTitle(cleanTitle) && (i.type || 'tv') === (type || 'tv')
  );
  if (existing) {
    return res.status(400).json({ error: `"${cleanTitle}" is already in your wish list.` });
  }

  const newItem = {
    id: 'wish_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
    title: cleanTitle,
    type: type === 'movie' ? 'movie' : 'tv',
    quality: quality || 'any',
    season: season ? parseInt(season, 10) : null,
    episode: episode ? parseInt(episode, 10) : null,
    year: year ? parseInt(year, 10) : null,
    enabled: true,
    autoDownload: autoDownload !== false,
    addedAt: new Date().toISOString(),
    lastMatchedAt: null,
    matchCount: 0,
    downloadedEpisodes: [],
    downloadedItems: []
  };

  wishlist.items.unshift(newItem);
  saveUserWishlist(req.user.id, wishlist);

  // Trigger an asynchronous background check for the newly added item right away!
  checkUserWishlist(req.user.id, false).catch(() => {});

  res.json({
    success: true,
    item: newItem,
    items: wishlist.items
  });
});

app.put('/api/wishlist/:id', authenticate, (req, res) => {
  const wishlist = getUserWishlist(req.user.id);
  const itemIndex = (wishlist.items || []).findIndex(i => i.id === req.params.id);
  if (itemIndex === -1) {
    return res.status(404).json({ error: 'Wish list item not found' });
  }

  const item = wishlist.items[itemIndex];
  const { title, type, quality, season, episode, year, enabled, autoDownload } = req.body;

  if (title !== undefined) item.title = title.trim();
  if (type !== undefined) item.type = type === 'movie' ? 'movie' : 'tv';
  if (quality !== undefined) item.quality = quality;
  if (season !== undefined) item.season = season ? parseInt(season, 10) : null;
  if (episode !== undefined) item.episode = episode ? parseInt(episode, 10) : null;
  if (year !== undefined) item.year = year ? parseInt(year, 10) : null;
  if (enabled !== undefined) item.enabled = !!enabled;
  if (autoDownload !== undefined) item.autoDownload = !!autoDownload;

  wishlist.items[itemIndex] = item;
  saveUserWishlist(req.user.id, wishlist);

  res.json({
    success: true,
    item,
    items: wishlist.items
  });
});

app.delete('/api/wishlist/:id', authenticate, (req, res) => {
  const wishlist = getUserWishlist(req.user.id);
  wishlist.items = (wishlist.items || []).filter(i => i.id !== req.params.id);
  saveUserWishlist(req.user.id, wishlist);
  res.json({
    success: true,
    items: wishlist.items
  });
});

app.post('/api/wishlist/settings', authenticate, (req, res) => {
  const { intervalMinutes, enabled } = req.body;
  const wishlist = getUserWishlist(req.user.id);

  if (intervalMinutes !== undefined) {
    wishlist.settings.intervalMinutes = Math.max(5, parseInt(intervalMinutes, 10) || 30);
  }
  if (enabled !== undefined) {
    wishlist.settings.enabled = !!enabled;
  }
  wishlist.settings.nextCheckAt = new Date(Date.now() + (wishlist.settings.intervalMinutes || 30) * 60 * 1000).toISOString();
  saveUserWishlist(req.user.id, wishlist);

  res.json({
    success: true,
    settings: wishlist.settings
  });
});

app.post('/api/wishlist/check-now', authenticate, async (req, res) => {
  try {
    const result = await checkUserWishlist(req.user.id, true);
    const wishlist = getUserWishlist(req.user.id);
    res.json({
      success: true,
      result,
      items: wishlist.items,
      settings: wishlist.settings,
      history: wishlist.history
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/wishlist/history', authenticate, (req, res) => {
  const wishlist = getUserWishlist(req.user.id);
  wishlist.history = [];
  saveUserWishlist(req.user.id, wishlist);
  res.json({ success: true, history: [] });
});

app.get('/api/debug/rss-status', authenticate, requireAdmin, async (req, res) => {
  const feedsToTest = [
    { id: 'eztv_myrss', name: 'EZTV (myrss.org)', url: 'https://myrss.org/eztv', defaultType: 'tv' },
    { id: 'eztv_official', name: 'EZTV (official eztvx.to)', url: 'https://eztvx.to/ezrss.xml', defaultType: 'tv' },
    { id: 'eztv_mirror', name: 'EZTV (mirror eztv.re)', url: 'https://eztv.re/ezrss.xml', defaultType: 'tv' },
    { id: 'atlas_yts', name: 'YTS (atlas.rssly.org)', url: 'https://atlas.rssly.org/feed', defaultType: 'movie' },
    { id: 'yts_mx', name: 'YTS (yts.mx)', url: 'https://yts.mx/rss', defaultType: 'movie' }
  ];

  const results = [];
  for (const f of feedsToTest) {
    try {
      const fetchRes = await fetchRssXml(f.url, 8000);
      let parsedCount = 0;
      let sampleTitle = null;
      if (fetchRes.ok && fetchRes.xml) {
        const parsed = parseRssFeedXml(fetchRes.xml, f);
        parsedCount = parsed.length;
        if (parsed[0]) sampleTitle = parsed[0].title;
      }
      results.push({
        name: f.name,
        url: f.url,
        ok: fetchRes.ok,
        status: fetchRes.status,
        method: fetchRes.method,
        xmlLength: fetchRes.xml ? fetchRes.xml.length : 0,
        parsedCount,
        sampleTitle,
        error: fetchRes.error || null
      });
    } catch (err) {
      results.push({ name: f.name, url: f.url, ok: false, error: err.message });
    }
  }

  res.json({
    timestamp: new Date().toISOString(),
    cacheCount: rssCache.items.length,
    cacheLastFetched: rssCache.lastFetched,
    results
  });
});

// Channels / Live Free TV
app.get('/api/channels', (req, res) => {
  res.json({ success: true, channels: [] });
});

// Serve the FireTV web app (built with vite into tv/firetv/dist)
const fireTvDist = fs.existsSync(path.join(__dirname, '..', 'firetv', 'dist'))
  ? path.join(__dirname, '..', 'firetv', 'dist')
  : path.join(__dirname, '..', 'firetv-cloud', 'dist');
if (fs.existsSync(fireTvDist)) {
  const serveFireTv = (req, res, next) => {
    const staticMw = express.static(fireTvDist);
    staticMw(req, res, () => {
      res.sendFile(path.join(fireTvDist, 'index.html'));
    });
  };
  app.use(['/firetv', '/firetv-cloud'], serveFireTv);
  console.log(`[FireTV] Serving app from ${fireTvDist} at /firetv and /firetv-cloud`);
}

// Any unmatched /api/* request returns JSON, never the SPA HTML page, so
// frontend fetch()/res.json() calls can't choke on a "<!DOCTYPE" HTML body.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

// Fallback for SPA frontend routing
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  const indexHtml = path.join(distPath, 'index.html');
  if (fs.existsSync(indexHtml)) {
    res.sendFile(indexHtml);
  } else {
    res.send(`<h1>FREEVEE Server Running on Port ${PORT}</h1><p>Build the frontend with <code>npm run build</code></p>`);
  }
});

// Write a downloadable identity file at startup so the deployed state can be
// verified from a browser (operator has no shell access). Fetching
// /server-identity.json reveals exactly which server.js is running and its size.
try {
  const publicDir = path.join(__dirname, 'public');
  if (fs.existsSync(publicDir)) {
    const serverJsPath = path.join(__dirname, 'server.js');
    fs.writeFileSync(path.join(publicDir, 'server-identity.json'), JSON.stringify({
      startedAt: new Date().toISOString(),
      pid: process.pid,
      __dirname,
      serverJsSize: fs.existsSync(serverJsPath) ? fs.statSync(serverJsPath).size : -1,
      node: process.version
    }, null, 2));
  }
} catch (_) {}

const listenTarget = typeof PhusionPassenger !== 'undefined' ? 'passenger' : PORT;
httpServer = app.listen(listenTarget, () => {
  checkFfmpegAvailability();
  initLoopbackProbe();
  console.log(`=============================================`);
  console.log(`🚀 FREEVEE Server running (Port/Pipe: ${listenTarget})`);
  console.log(`🔒 Max Concurrent Downloads: ${MAX_CONCURRENT_DOWNLOADS}`);
  console.log(`🔒 Max Concurrent Transcodes: ${MAX_CONCURRENT_TRANSCODES}`);
  console.log(`💾 File log: ${LOG_FILE}`);
  console.log(`=============================================`);
});
