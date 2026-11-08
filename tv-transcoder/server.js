import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { spawn, execFileSync, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import dgram from 'dgram';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { pipeline, Readable } from 'stream';

// Suppress normal client disconnections and stream aborts so they never crash the app
process.on('uncaughtException', (err) => {
  const msg = err?.message || '';
  const code = err?.code || '';
  if (
    msg.includes('terminated') ||
    msg.includes('premature close') ||
    msg.includes('aborted') ||
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === 'ERR_STREAM_PREMATURE_CLOSE'
  ) {
    return;
  }
  console.error('[Transcoder Server] Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  const msg = (reason && typeof reason === 'object' && reason.message) || String(reason || '');
  if (
    msg.includes('terminated') ||
    msg.includes('premature close') ||
    msg.includes('aborted') ||
    msg.includes('ECONNRESET')
  ) {
    return;
  }
  console.error('[Transcoder Server] Unhandled rejection:', reason);
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env from multiple candidate locations (dev, asar, or extraResources)
const envPaths = [
  path.join(__dirname, '.env'),
  process.resourcesPath ? path.join(process.resourcesPath, '.env') : null,
  path.join(process.cwd(), '.env'),
  path.join(__dirname.replace(/app\.asar$/, ''), '.env')
].filter(Boolean);

for (const ep of envPaths) {
  if (fs.existsSync(ep)) {
    dotenv.config({ path: ep });
    console.log(`[Transcoder] Loaded environment from: ${ep}`);
    break;
  }
}

const PORT = parseInt(process.env.PORT || '4300', 10);
const HOST = process.env.HOST || '0.0.0.0';
const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
const MAIN_SERVER_URL = (process.env.MAIN_SERVER_URL || 'https://tv.butfree.online').replace(/\/$/, '');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MEDIA_DIR = process.env.MEDIA_DIR || path.join(__dirname, 'media');
const TMP_DIR = process.env.TMP_DIR || path.join(__dirname, 'tmp');
const HLS_CACHE_DIR = path.join(TMP_DIR, 'hls');

for (const d of [DATA_DIR, MEDIA_DIR, TMP_DIR, HLS_CACHE_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');

// ---------- Local IP Address Discovery ----------
function getLocalIpAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        if (!iface.address.startsWith('127.') && !iface.address.startsWith('169.254.')) {
          addresses.push({ ip: iface.address, name });
        }
      }
    }
  }
  // Sort priority: standard home router subnets (192.168.0.x, 192.168.1.x, 192.168.2.x, 10.x.x.x) first
  addresses.sort((a, b) => {
    const aPri = a.name.toLowerCase().includes('wi-fi') || a.name.toLowerCase().includes('wifi') || a.name.toLowerCase().includes('ethernet') ? 0 : 1;
    const bPri = b.name.toLowerCase().includes('wi-fi') || b.name.toLowerCase().includes('wifi') || b.name.toLowerCase().includes('ethernet') ? 0 : 1;
    if (aPri !== bPri) return aPri - bPri;
    return a.ip.localeCompare(b.ip);
  });
  return addresses;
}

const localIps = getLocalIpAddresses();
const primaryLanIp = localIps.length > 0 ? localIps[0].ip : '127.0.0.1';

// ---------- FFmpeg & FFprobe Resolution ----------
let FFMPEG = null;
let FFPROBE = null;

function testBinary(binPath, isProbe = false) {
  if (!binPath) return false;
  try {
    if (fs.existsSync(binPath)) {
      execFileSync(binPath, ['-version'], { stdio: 'ignore', timeout: 6000 });
      return true;
    }
  } catch (_) {}
  return false;
}

function resolveFfmpeg() {
  const candidates = [];
  const exeName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH);
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'bin', exeName));
    candidates.push(path.join(process.resourcesPath, 'bin', exeName));
  }
  const unpackedDir = __dirname.replace(/app\.asar$/, 'app.asar.unpacked');
  candidates.push(path.join(unpackedDir, 'bin', exeName));
  candidates.push(path.join(__dirname, 'bin', exeName));
  candidates.push('C:\\_code\\but-free\\node_modules\\ffmpeg-static\\ffmpeg.exe');
  candidates.push('C:\\_code\\but-free\\downloader\\bin\\ffmpeg.exe');
  candidates.push('C:\\_code\\but-free\\downloader\\node_modules\\@ffmpeg-installer\\win32-x64\\ffmpeg.exe');
  for (const c of candidates) {
    if (testBinary(c)) return c;
  }
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 5000 });
    return 'ffmpeg';
  } catch (_) {}
  return null;
}

function resolveFfprobe(ffmpegPath) {
  const candidates = [];
  const exeName = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
  if (process.env.FFPROBE_PATH) candidates.push(process.env.FFPROBE_PATH);
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'bin', exeName));
    candidates.push(path.join(process.resourcesPath, 'bin', exeName));
  }
  const unpackedDir = __dirname.replace(/app\.asar$/, 'app.asar.unpacked');
  candidates.push(path.join(unpackedDir, 'bin', exeName));
  candidates.push(path.join(__dirname, 'bin', exeName));
  candidates.push('C:\\_code\\but-free\\downloader\\bin\\ffprobe.exe');
  candidates.push('C:\\_code\\but-free\\downloader\\node_modules\\@ffprobe-installer\\win32-x64\\ffprobe.exe');
  if (ffmpegPath) {
    const dir = path.dirname(ffmpegPath);
    candidates.push(path.join(dir, exeName));
  }
  for (const c of candidates) {
    if (testBinary(c, true)) return c;
  }
  try {
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore', timeout: 5000 });
    return 'ffprobe';
  } catch (_) {}
  return null;
}

FFMPEG = resolveFfmpeg();
FFPROBE = resolveFfprobe(FFMPEG);
console.log(`[Transcoder] Local FFmpeg: "${FFMPEG || 'NOT FOUND'}"`);
console.log(`[Transcoder] Local FFprobe: "${FFPROBE || 'NOT FOUND'}"`);

// Clean process kill on Windows
function killProcessTree(proc) {
  if (!proc) return;
  const pid = typeof proc === 'number' ? proc : proc.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
    } catch (_) {}
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (_) {}
  }
}

// ---------- Auth Storage ----------
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch (_) {}
}

let AUTH = readJson(AUTH_FILE, null);

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/auth/google/callback`;

function isAuthConfigured() { return !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET); }

async function refreshAccessToken() {
  if (!AUTH || !AUTH.refreshToken) return null;
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: AUTH.refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.access_token) return null;
    AUTH.accessToken = data.access_token;
    AUTH.expiresAt = Date.now() + (data.expires_in || 3600) * 1000 - 60000;
    writeJson(AUTH_FILE, AUTH);
    return AUTH.accessToken;
  } catch (_) {
    return AUTH.accessToken || null;
  }
}

async function getAccessToken() {
  if (!AUTH) return null;
  if (AUTH.accessToken && AUTH.expiresAt && Date.now() < AUTH.expiresAt) return AUTH.accessToken;
  return await refreshAccessToken();
}

/**
 * Universal token resolver:
 * 1. Explicit googleToken from caller
 * 2. Local Google Drive OAuth token (from auth.json)
 * 3. Remote resolution from MAIN_SERVER_URL using caller's authToken
 */
async function resolveGoogleDriveToken(preferredToken = '', callerAuthToken = '', userId = '') {
  if (preferredToken && preferredToken.length > 20) return preferredToken;

  // Try local auth
  const localToken = await getAccessToken();
  if (localToken) return localToken;

  // Try remote server using caller's auth token
  if (callerAuthToken || userId) {
    try {
      const q = [];
      if (callerAuthToken) q.push(`token=${encodeURIComponent(callerAuthToken)}`);
      if (userId) q.push(`user=${encodeURIComponent(userId)}`);
      const res = await fetch(`${MAIN_SERVER_URL}/api/drive/token?${q.join('&')}`, {
        headers: callerAuthToken ? { Authorization: `Bearer ${callerAuthToken}` } : {},
        signal: AbortSignal.timeout(4000)
      });
      if (res.ok) {
        const d = await res.json();
        if (d?.googleToken) return d.googleToken;
      }
    } catch (_) {}
  }
  return null;
}

// ---------- Media Codec Probe ----------
const probeCache = new Map();

async function probeMediaCodecs(inputUrl, googleToken = '') {
  if (!FFPROBE) return null;
  return new Promise((resolve) => {
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-show_format',
      '-probesize', '5M',
      '-analyzeduration', '5M',
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '3'
    ];
    if (googleToken) {
      args.push('-headers', `Authorization: Bearer ${googleToken}\r\n`);
    }
    args.push(inputUrl);

    let output = '';
    const proc = spawn(FFPROBE, args);
    proc.stdout.on('data', (d) => { output += d.toString(); });
    proc.on('error', () => resolve(null));
    proc.on('close', (code) => {
      if (code !== 0 || !output) return resolve(null);
      try {
        const data = JSON.parse(output);
        const vStream = data.streams?.find(s => s.codec_type === 'video');
        const aStream = data.streams?.find(s => s.codec_type === 'audio');
        const videoCodec = (vStream?.codec_name || '').toLowerCase();
        const audioCodec = (aStream?.codec_name || '').toLowerCase();
        const channels = parseInt(aStream?.channels, 10) || 2;
        const is10Bit = Boolean(vStream?.pix_fmt && vStream.pix_fmt.includes('10'));
        const durationSec = parseFloat(data.format?.duration || vStream?.duration || 0);
        resolve({ videoCodec, audioCodec, is10Bit, channels, durationSec });
      } catch (_) {
        resolve(null);
      }
    });
  });
}

// ---------- Live On-Demand HLS Transcoding Engine ----------
// Stores active HLS transcoding sessions
const activeHlsSessions = new Map();
const hlsStartingLocks = new Map();

const HLS_IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes of inactivity before pruning

function touchHlsSession(sessionId) {
  const session = activeHlsSessions.get(sessionId);
  if (!session) return;
  session.lastActive = Date.now();
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => cleanupHlsSession(sessionId), HLS_IDLE_TIMEOUT_MS);
}

function cleanupHlsSession(sessionId) {
  const session = activeHlsSessions.get(sessionId);
  if (!session) return;
  if (session.idleTimer) clearTimeout(session.idleTimer);
  if (session.proc) {
    killProcessTree(session.proc);
    session.proc = null;
  }
  if (session.dir && fs.existsSync(session.dir)) {
    try {
      fs.rmSync(session.dir, { recursive: true, force: true });
    } catch (_) {}
  }
  activeHlsSessions.delete(sessionId);
  console.log(`[HLS Transcoder] Session stopped and cleared from disk: ${sessionId}`);
}

function stopAllSessionsForFile(fileId) {
  let count = 0;
  for (const [sid, session] of activeHlsSessions) {
    if (!fileId || fileId === 'all' || session.fileId === fileId) {
      cleanupHlsSession(sid);
      count++;
    }
  }
  // Clear any orphaned session directories in cache folder
  try {
    if (fs.existsSync(HLS_CACHE_DIR)) {
      const dirs = fs.readdirSync(HLS_CACHE_DIR);
      for (const d of dirs) {
        if (!fileId || fileId === 'all' || activeHlsSessions.size === 0) {
          const fullPath = path.join(HLS_CACHE_DIR, d);
          if (fs.statSync(fullPath).isDirectory()) {
            fs.rmSync(fullPath, { recursive: true, force: true });
          }
        }
      }
    }
  } catch (_) {}
  return count;
}

// ---------- Jobs (Batch Queue) ----------
const jobs = new Map();
function loadJobs() {
  const arr = readJson(JOBS_FILE, []);
  for (const j of arr) {
    if (j.status === 'running' || j.status === 'queued') j.status = 'interrupted';
    jobs.set(j.id, j);
  }
}
function saveJobs() {
  writeJson(JOBS_FILE, Array.from(jobs.values()));
}
loadJobs();

const SETTINGS = {
  '360p': { height: 360, vbitrate: '600k', crf: 26, abitrate: '96k' },
  '480p': { height: 480, vbitrate: '1000k', crf: 24, abitrate: '96k' },
  '720p': { height: 720, vbitrate: '2500k', crf: 22, abitrate: '128k' },
  '1080p': { height: 1080, vbitrate: '4500k', crf: 20, abitrate: '128k' },
};

function parseTimeToSec(s) {
  const m = s.match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
}

function createJob({ source, title, setting, fileId, accessToken }) {
  const id = crypto.randomUUID();
  const dir = path.join(MEDIA_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const job = {
    id,
    title: title || (fileId ? `Drive ${fileId}` : 'Video'),
    setting: setting || '720p',
    fileId: fileId || null,
    source: source || null,
    accessToken: accessToken || null,
    status: 'queued',
    progress: 0,
    timeSec: 0,
    durationSec: null,
    error: null,
    createdAt: new Date().toISOString(),
    streamUrl: `/media/${id}/index.m3u8`,
    hlsPath: path.join(dir, 'index.m3u8'),
  };
  jobs.set(id, job);
  saveJobs();
  return job;
}

function runJob(job) {
  if (!FFMPEG) { job.status = 'failed'; job.error = 'ffmpeg not found'; saveJobs(); return; }
  const s = SETTINGS[job.setting] || SETTINGS['720p'];
  const outDir = path.join(MEDIA_DIR, job.id);
  fs.mkdirSync(outDir, { recursive: true });
  const playlist = path.join(outDir, 'index.m3u8');
  const segPattern = path.join(outDir, 'seg_%03d.ts');

  let inputUrl = job.source;
  const args = ['-y', '-hide_banner', '-loglevel', 'info'];
  if (job.fileId) {
    const token = job.accessToken;
    if (token) args.push('-headers', `Authorization: Bearer ${token}\r\n`);
    inputUrl = `https://www.googleapis.com/drive/v3/files/${job.fileId}?alt=media`;
  }
  if (inputUrl && /^https?:/i.test(inputUrl)) {
    args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
  }
  args.push('-i', inputUrl);
  args.push('-vf', `scale=-2:${s.height}`);
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(s.crf), '-b:v', s.vbitrate, '-maxrate', s.vbitrate, '-bufsize', (parseInt(s.vbitrate) * 2) + 'k');
  args.push('-c:a', 'aac', '-b:a', s.abitrate, '-ac', '2');
  args.push('-f', 'hls', '-hls_time', '4', '-hls_list_size', '0', '-hls_segment_filename', segPattern, playlist);

  job.status = 'running';
  job.startedAt = new Date().toISOString();
  saveJobs();

  const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  job.process = proc;
  let stderrBuf = '';
  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    stderrBuf += text;
    const dm = stderrBuf.match(/Duration:\s*(\d+:\d+:\d+\.\d+)/);
    if (dm && !job.durationSec) job.durationSec = parseTimeToSec(dm[1]);
    const tm = text.match(/time=(\d+:\d+:\d+\.\d+)/);
    if (tm) {
      const t = parseTimeToSec(tm[1]);
      if (t !== null) {
        job.timeSec = t;
        if (job.durationSec) job.progress = Math.min(99, (t / job.durationSec) * 100);
      }
    }
    if (stderrBuf.length > 50000) stderrBuf = stderrBuf.slice(-25000);
  });
  proc.on('error', (e) => { job.status = 'failed'; job.error = e.message; saveJobs(); });
  proc.on('close', (code) => {
    delete job.process;
    if (code === 0) {
      job.status = 'completed';
      job.progress = 100;
    } else {
      job.status = 'failed';
      job.error = `ffmpeg exited with code ${code}`;
    }
    saveJobs();
  });
}

// ---------- Express App Setup ----------
const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'DELETE', 'OPTIONS', 'HEAD'], allowedHeaders: ['*'] }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

function getOrigin(req) {
  // If the request arrived from a client (e.g. Host: 192.168.0.15:4300), we MUST use the incoming Host
  // so external LAN devices (like a Roku TV) receive redirects matching their reachable IP, NOT localhost!
  if (req) {
    const forwardedHost = req.headers['x-forwarded-host'];
    const host = forwardedHost || req.headers.host;
    if (host && !host.includes('localhost') && !host.includes('127.0.0.1')) {
      const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
      return `${proto}://${host}`;
    }
  }

  // If BASE_URL is explicitly set and not localhost, use it
  if (BASE_URL && !BASE_URL.includes('localhost') && !BASE_URL.includes('127.0.0.1')) {
    return BASE_URL;
  }

  // If caller connected via localhost, keep it
  if (req && req.headers.host) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    return `${proto}://${req.headers.host}`;
  }

  return `http://${primaryLanIp}:${PORT}`;
}

// Health check endpoint (used by Roku discovery & web UI)
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    name: 'tv-transcoder',
    version: '1.0.0',
    port: PORT,
    primaryIp: primaryLanIp,
    localIps: localIps.map(x => x.ip),
    ffmpeg: !!FFMPEG,
    ffmpegPath: FFMPEG,
    ffprobe: !!FFPROBE,
    authConfigured: isAuthConfigured(),
    authenticated: !!AUTH,
    activeSessions: activeHlsSessions.size,
    timestamp: Date.now()
  });
});

function servePlaylistDirect(sessionId, req, res) {
  const filePath = path.join(HLS_CACHE_DIR, sessionId, 'index.m3u8');
  let playlist = '';
  try {
    playlist = fs.readFileSync(filePath, 'utf-8');
  } catch (_) {
    return res.status(404).send('Playlist not ready');
  }
  const session = activeHlsSessions.get(sessionId);
  const isRunning = Boolean(session?.proc && session.proc.exitCode === null);
  if (!isRunning && !playlist.includes('#EXT-X-ENDLIST')) {
    playlist = playlist.trimEnd() + '\n#EXT-X-ENDLIST\n';
    try { fs.writeFileSync(filePath, playlist); } catch (_) {}
  }
  const origin = getOrigin(req);
  let rewritten = playlist.replace(/^(?:.*[\\/])?(seg_\d+\.ts)\r?$/gm, `${origin}/api/stream/hls/${sessionId}/$1`);

  // Fix RFC 8216 violation: TARGETDURATION must be >= any EXTINF duration (rounded up)
  const infMatches = [...rewritten.matchAll(/#EXTINF:([\d.]+)/g)];
  if (infMatches.length > 0) {
    const maxDur = Math.max(...infMatches.map(m => parseFloat(m[1]) || 0));
    const targetDur = Math.max(4, Math.ceil(maxDur));
    rewritten = rewritten.replace(/#EXT-X-TARGETDURATION:\d+/, `#EXT-X-TARGETDURATION:${targetDur}`);
  }

  // Downgrade EXT-X-VERSION from 6 to 3 for universal Roku hardware support
  rewritten = rewritten.replace(/#EXT-X-VERSION:\d+/, '#EXT-X-VERSION:3');
  rewritten = rewritten.replace(/#EXT-X-INDEPENDENT-SEGMENTS\r?\n?/g, '');

  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('X-Session-Id', sessionId);
  return res.send(rewritten);
}



// ---------- Stop Transcoding Route ----------
app.all(['/api/stream/drive-hls/stop', '/api/stream/stop', '/api/stream/clear'], (req, res) => {
  let fileId = (req.body && req.body.fileId) || req.query.fileId || '';
  if (fileId.endsWith('.m3u8')) fileId = fileId.replace(/\.m3u8$/, '');
  const clearAll = Boolean(req.body?.clearAll || req.query?.clearAll || !fileId);
  const targetId = clearAll ? '' : fileId;
  const stoppedCount = stopAllSessionsForFile(targetId);
  console.log(`[Drive Transcoder Stop] Stopped and cleared ${stoppedCount} transcode session(s) fileId=${targetId || 'ALL'}`);
  res.json({ success: true, stopped: true, stoppedCount });
});

app.get('/api/stream/drive-hls/status', (req, res) => {
  const sessions = [];
  for (const [sid, s] of activeHlsSessions) {
    sessions.push({
      id: sid,
      fileId: s.fileId,
      offset: s.offset,
      running: Boolean(s.proc && s.proc.exitCode === null),
      startedAt: s.startedAt,
      lastActive: s.lastActive
    });
  }
  res.json({ success: true, activeSessions: sessions });
});

// ---------- LIVE Google Drive HLS Transcoding Route ----------
app.get(['/api/stream/drive-hls/:fileId', '/api/stream/drive-hls/:fileId.m3u8'], async (req, res) => {
  let { fileId } = req.params;
  if (!fileId) return res.status(400).send('Missing fileId');
  if (fileId.endsWith('.m3u8')) fileId = fileId.replace(/\.m3u8$/, '');

  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const callerAuthToken = req.query.token || req.headers.authorization?.replace(/^Bearer\s+/i, '') || '';
  const callerGoogleToken = req.query.googleToken || '';
  const userId = req.query.user || req.query.userId || '';
  const origin = getOrigin(req);
  const lockKey = `${fileId}:${offset}`;

  console.log(`[Drive HLS] Incoming request fileId=${fileId} offset=${offset}s from ${req.ip}`);

  // Deduplication: if another request is currently starting this exact transcode, await it
  if (hlsStartingLocks.has(lockKey)) {
    try {
      const existingSid = await hlsStartingLocks.get(lockKey);
      if (existingSid && activeHlsSessions.has(existingSid)) {
        touchHlsSession(existingSid);
        return servePlaylistDirect(existingSid, req, res);
      }
    } catch (_) {}
  }

  // Check if an existing session can be reused (same fileId, offset within 5 seconds)
  for (const [sid, session] of activeHlsSessions) {
    if (session.fileId === fileId && Math.abs(session.offset - offset) <= 5) {
      const m3u8Path = path.join(session.dir, 'index.m3u8');
      if (fs.existsSync(m3u8Path)) {
        console.log(`[Drive HLS] Reusing active session=${sid} for fileId=${fileId}`);
        touchHlsSession(sid);
        return servePlaylistDirect(sid, req, res);
      }
    }
  }

  // Preempt any older running transcode sessions so this PC concentrates CPU power on the current video
  for (const [sid, session] of activeHlsSessions) {
    if (session.fileId !== fileId) {
      console.log(`[Drive HLS] Preempting background session=${sid} for new fileId=${fileId}`);
      cleanupHlsSession(sid);
    }
  }

  // Lock
  let resolveLock;
  const startPromise = new Promise((r) => { resolveLock = r; });
  hlsStartingLocks.set(lockKey, startPromise);

  const sessionId = crypto.randomUUID();
  const sessionDir = path.join(HLS_CACHE_DIR, sessionId);
  try {
    fs.mkdirSync(sessionDir, { recursive: true });
  } catch (err) {
    hlsStartingLocks.delete(lockKey);
    return res.status(500).send('Failed to create transcode cache directory');
  }

  const m3u8Path = path.join(sessionDir, 'index.m3u8');

  // Resolve Google Drive access token
  const googleToken = await resolveGoogleDriveToken(callerGoogleToken, callerAuthToken, userId);
  let inputUrl = '';
  const ffmpegArgs = [
    '-threads', '4',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-reconnect_at_eof', '1',
    '-reconnect_on_http_error', '1',
    '-reconnect_on_network_error', '1',
    '-analyzeduration', '10M',
    '-probesize', '10M'
  ];

  if (googleToken) {
    inputUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
    ffmpegArgs.push('-headers', `Authorization: Bearer ${googleToken}\r\n`);
    console.log(`[Drive HLS] Direct Google Drive input with Bearer token fileId=${fileId}`);
  } else {
    // Fallback: proxy through main server if token cannot be resolved locally
    const qParts = [];
    if (callerAuthToken) qParts.push(`token=${encodeURIComponent(callerAuthToken)}`);
    if (userId) qParts.push(`user=${encodeURIComponent(userId)}`);
    inputUrl = `${MAIN_SERVER_URL}/api/stream/drive/${fileId}${qParts.length ? '?' + qParts.join('&') : ''}`;
    console.log(`[Drive HLS] Proxied Google Drive input through main server fileId=${fileId}`);
  }

  // Probe media codecs to see if video can be stream-copied (0% CPU)
  let canCopyVideo = false;
  let canCopyAudio = false;
  const probeKey = `drive:${fileId}`;
  let probe = probeCache.get(probeKey);
  if (!probe) {
    try {
      probe = await probeMediaCodecs(inputUrl, googleToken);
      if (probe && probe.videoCodec) probeCache.set(probeKey, probe);
    } catch (_) {}
  }
  if (probe && probe.videoCodec) {
    // Roku strictly supports H.264 in MPEG-TS (.ts) container; HEVC in .ts is unsupported
    canCopyVideo = (probe.videoCodec === 'h264' && !probe.is10Bit);
    // Roku only supports stereo AAC (<= 2 channels). Multichannel (e.g. 5.1) MUST be downmixed to stereo
    canCopyAudio = (probe.audioCodec === 'aac' || probe.audioCodec === 'mp3') && (probe.channels <= 2);
  }

  // Fast seek offset
  if (offset > 0) {
    ffmpegArgs.push('-ss', offset.toString());
  }

  if (canCopyVideo) {
    console.log(`[Drive HLS] Fast remux stream-copy mode (0% CPU) session=${sessionId} video=${probe?.videoCodec} audio=${canCopyAudio ? 'copy' : 'aac'}`);
    ffmpegArgs.push(
      '-i', inputUrl,
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-sn',
      '-c:v', 'copy',
      '-c:a', canCopyAudio ? 'copy' : 'aac',
      ...(canCopyAudio ? [] : ['-b:a', '128k', '-ac', '2']),
      '-muxdelay', '0',
      '-muxpreload', '0',
      '-max_muxing_queue_size', '4096',
      '-hls_time', '4',
      '-hls_playlist_type', 'event',
      '-hls_list_size', '0',
      '-hls_flags', 'independent_segments',
      '-hls_segment_filename', 'seg_%05d.ts',
      'index.m3u8'
    );
  } else {
    console.log(`[Drive HLS] Transcoding to H.264 (VPS-matched Roku settings) session=${sessionId} srcVideo=${probe?.videoCodec || 'unknown'} srcAudio=${probe?.audioCodec || 'unknown'}`);
    ffmpegArgs.push(
      '-i', inputUrl,
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-sn',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'fastdecode',
      '-threads', '4',
      '-crf', '28',
      '-maxrate', '1500k',
      '-bufsize', '3000k',
      '-g', '48',
      '-keyint_min', '48',
      '-sc_threshold', '0',
      '-x264-params', 'repeat-headers=1:threads=2:sliced-threads=1:sync-lookahead=0:rc-lookahead=0:subme=0:me=dia',
      '-vf', "scale=-2:'min(480,ih)':flags=fast_bilinear",
      '-pix_fmt', 'yuv420p',
      '-c:a', canCopyAudio ? 'copy' : 'aac',
      ...(canCopyAudio ? [] : ['-b:a', '128k', '-ac', '2']),
      '-muxdelay', '0',
      '-muxpreload', '0',
      '-max_muxing_queue_size', '2048',
      '-hls_time', '4',
      '-hls_playlist_type', 'event',
      '-hls_list_size', '0',
      '-hls_flags', 'independent_segments',
      '-hls_segment_filename', 'seg_%05d.ts',
      'index.m3u8'
    );
  }

  const ffmpegProc = spawn(FFMPEG, ffmpegArgs, { cwd: sessionDir });
  let ffmpegErrTail = '';
  ffmpegProc.stderr.on('data', (d) => {
    ffmpegErrTail = (ffmpegErrTail + d.toString()).slice(-2000);
  });

  const sessionObj = {
    id: sessionId,
    fileId,
    offset,
    dir: sessionDir,
    proc: ffmpegProc,
    startedAt: Date.now(),
    lastActive: Date.now(),
    idleTimer: null,
  };
  activeHlsSessions.set(sessionId, sessionObj);
  touchHlsSession(sessionId);

  ffmpegProc.on('error', (err) => {
    console.error(`[Drive HLS] FFmpeg spawn error:`, err.message);
    if (resolveLock) { resolveLock(null); hlsStartingLocks.delete(lockKey); }
    cleanupHlsSession(sessionId);
    if (!res.headersSent) res.status(500).send('Transcoding failed to start: ' + err.message);
  });

  ffmpegProc.on('exit', (code) => {
    console.log(`[Drive HLS] FFmpeg finished session=${sessionId} exitCode=${code}`);
    try {
      if (fs.existsSync(m3u8Path)) {
        let content = fs.readFileSync(m3u8Path, 'utf8');
        if (!content.includes('#EXT-X-ENDLIST')) {
          content = content.trimEnd() + '\n#EXT-X-ENDLIST\n';
          fs.writeFileSync(m3u8Path, content);
        }
      }
    } catch (_) {}
  });

  // Wait for initial segments before redirecting Roku
  const waitStarted = Date.now();
  const waitForSegments = () => {
    try {
      if (fs.existsSync(m3u8Path)) {
        const content = fs.readFileSync(m3u8Path, 'utf8');
        const segCount = (content.match(/seg_\d+\.ts/g) || []).length;
        const isComplete = content.includes('#EXT-X-ENDLIST');
        const elapsed = Date.now() - waitStarted;
        const minSegs = canCopyVideo ? 2 : 3;

        if (segCount >= minSegs || isComplete || (segCount >= 1 && elapsed > 8000)) {
          if (resolveLock) { resolveLock(sessionId); hlsStartingLocks.delete(lockKey); }
          console.log(`[Drive HLS] Stream ready session=${sessionId} segments=${segCount} (${elapsed}ms)`);
          return servePlaylistDirect(sessionId, req, res);
        }
      }
    } catch (_) {}

    if (Date.now() - waitStarted > 45000) {
      if (resolveLock) { resolveLock(null); hlsStartingLocks.delete(lockKey); }
      cleanupHlsSession(sessionId);
      if (!res.headersSent) res.status(504).send('Transcoding initial buffer timed out: ' + ffmpegErrTail);
      return;
    }
    setTimeout(waitForSegments, 250);
  };
  waitForSegments();
});

// ---------- Serve HLS Files (.m3u8 playlists and .ts segments) ----------
app.get(['/api/stream/hls/:sessionId/:file', '/api/stream/hls/:sessionId'], (req, res) => {
  const { sessionId, file } = req.params;
  const targetFile = file || 'index.m3u8';
  const filePath = path.join(HLS_CACHE_DIR, sessionId, targetFile);

  touchHlsSession(sessionId);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send('HLS chunk not found');
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (targetFile.endsWith('.m3u8')) {
    let playlist = '';
    try {
      playlist = fs.readFileSync(filePath, 'utf-8');
    } catch (_) {
      return res.status(404).send('Playlist not ready');
    }
    const session = activeHlsSessions.get(sessionId);
    const isRunning = Boolean(session?.proc && session.proc.exitCode === null);
    if (!isRunning && !playlist.includes('#EXT-X-ENDLIST')) {
      playlist = playlist.trimEnd() + '\n#EXT-X-ENDLIST\n';
      try { fs.writeFileSync(filePath, playlist); } catch (_) {}
    }
    const origin = getOrigin(req);
    // Rewrite all segment references to fully-qualified absolute URLs for Roku
    let rewritten = playlist.replace(/^(?:.*[\\/])?(seg_\d+\.ts)\r?$/gm, `${origin}/api/stream/hls/${sessionId}/$1`);

    // Fix RFC 8216 violation: TARGETDURATION must be >= any EXTINF duration (rounded up)
    const infMatches = [...rewritten.matchAll(/#EXTINF:([\d.]+)/g)];
    if (infMatches.length > 0) {
      const maxDur = Math.max(...infMatches.map(m => parseFloat(m[1]) || 0));
      const targetDur = Math.max(4, Math.ceil(maxDur));
      rewritten = rewritten.replace(/#EXT-X-TARGETDURATION:\d+/, `#EXT-X-TARGETDURATION:${targetDur}`);
    }

    // Downgrade EXT-X-VERSION from 6 to 3 for universal Roku hardware support
    rewritten = rewritten.replace(/#EXT-X-VERSION:\d+/, '#EXT-X-VERSION:3');
    rewritten = rewritten.replace(/#EXT-X-INDEPENDENT-SEGMENTS\r?\n?/g, '');

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.send(rewritten);
  } else if (targetFile.endsWith('.ts')) {
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    const readStream = fs.createReadStream(filePath);
    readStream.on('error', () => {});
    return pipeline(readStream, res, () => {});
  } else {
    return res.sendFile(filePath);
  }
});



// ---------- Direct Drive Streaming Route (with Range Request Support) ----------
app.get(['/api/stream/drive/:fileId', '/api/stream/drive/:fileId/:fileName'], async (req, res) => {
  const { fileId } = req.params;
  const callerAuthToken = req.query.token || req.headers.authorization?.replace(/^Bearer\s+/i, '') || '';
  const googleToken = await resolveGoogleDriveToken(req.query.googleToken, callerAuthToken, req.query.user);
  if (!googleToken) {
    return res.status(401).send('No valid Google Drive authorization token available');
  }

  const driveUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  const headers = { Authorization: `Bearer ${googleToken}` };
  if (req.headers.range) headers['Range'] = req.headers.range;

  const ac = new AbortController();
  req.on('close', () => {
    try { ac.abort(); } catch (_) {}
  });

  try {
    const upstream = await fetch(driveUrl, { headers, signal: ac.signal });
    res.status(upstream.status);
    upstream.headers.forEach((val, key) => {
      if (['content-range', 'content-length', 'content-type', 'accept-ranges'].includes(key.toLowerCase())) {
        res.setHeader(key, val);
      }
    });
    res.setHeader('Access-Control-Allow-Origin', '*');
    const stream = upstream.body;
    if (stream) {
      const nodeStream = stream.getReader ? Readable.fromWeb(stream) : stream;
      nodeStream.on('error', () => {});
      res.on('error', () => {});
      pipeline(nodeStream, res, () => {});
    } else {
      res.end();
    }
  } catch (err) {
    if (err.name === 'AbortError' || err.message?.includes('terminated')) {
      return;
    }
    if (!res.headersSent) {
      res.status(502).send('Error streaming from Google Drive: ' + err.message);
    }
  }
});

// ---------- Subtitle Proxy Route ----------
app.get('/api/stream/drive-subtitle/:fileId', async (req, res) => {
  const { fileId } = req.params;
  const callerAuthToken = req.query.token || '';
  try {
    const r = await fetch(`${MAIN_SERVER_URL}/api/stream/drive-subtitle/${fileId}?token=${encodeURIComponent(callerAuthToken)}`);
    if (!r.ok) return res.status(r.status).send('Subtitle not found');
    res.setHeader('Content-Type', r.headers.get('content-type') || 'text/vtt');
    res.setHeader('Access-Control-Allow-Origin', '*');
    const text = await r.text();
    res.send(text);
  } catch (e) {
    res.status(500).send('Subtitle error: ' + e.message);
  }
});

// Static media & UI
app.use('/media', express.static(MEDIA_DIR, {
  acceptRanges: true,
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Accel-Buffering', 'no');
    if (filePath.endsWith('.m3u8')) res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    else if (filePath.endsWith('.ts')) res.setHeader('Content-Type', 'video/MP2T');
  }
}));

app.use('/public', express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Google OAuth routes
app.get('/auth/google', (req, res) => {
  if (!isAuthConfigured()) return res.status(400).send('Google OAuth not configured. Set GOOGLE_CLIENT_ID/SECRET in .env');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', GOOGLE_CLIENT_ID);
  url.searchParams.set('redirect_uri', GOOGLE_REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.metadata.readonly');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  res.redirect(url.toString());
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).send('OAuth error: ' + error);
  if (!code) return res.status(400).send('Missing code');
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });
    const data = await tokenRes.json();
    if (!tokenRes.ok || !data.access_token) throw new Error(data.error_description || data.error || 'token exchange failed');
    let profile = {};
    try {
      const pr = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: `Bearer ${data.access_token}` } });
      profile = await pr.json();
    } catch {}
    AUTH = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || (AUTH && AUTH.refreshToken) || null,
      expiresAt: Date.now() + (data.expires_in || 3600) * 1000 - 60000,
      user: { email: profile.email, name: profile.name, picture: profile.picture },
    };
    writeJson(AUTH_FILE, AUTH);
    res.send('<html><body><h2>Google Drive connected.</h2><p>You can close this tab and return to the app.</p><script>setTimeout(()=>window.close(),1500)</script></body></html>');
  } catch (e) {
    res.status(500).send('OAuth callback failed: ' + e.message);
  }
});

app.get('/api/auth/status', (req, res) => {
  res.json({ configured: isAuthConfigured(), authenticated: !!AUTH, user: AUTH ? AUTH.user : null });
});
app.post('/api/auth/logout', (req, res) => { AUTH = null; try { fs.unlinkSync(AUTH_FILE); } catch {} res.json({ ok: true }); });

// Drive helpers
async function driveFetch(url, opts = {}) {
  const token = await getAccessToken();
  if (!token) throw new Error('Not authenticated with Google');
  return fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` } });
}

app.get('/api/drive/files', async (req, res) => {
  try {
    const folderId = req.query.folderId;
    const qParts = ["mimeType contains 'video/'", 'trashed = false'];
    if (folderId) qParts.push(`'${folderId}' in parents`);
    const q = qParts.join(' and ');
    const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,size,modifiedTime)&pageSize=100&orderBy=modifiedTime desc`;
    const r = await driveFetch(url);
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    res.json({ files: data.files || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/drive/file/:id', async (req, res) => {
  try {
    const r = await driveFetch(`https://www.googleapis.com/drive/v3/files/${req.params.id}?fields=id,name,mimeType,size`);
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Jobs API
app.get('/api/jobs', (req, res) => {
  const list = Array.from(jobs.values()).map(({ process, accessToken, ...rest }) => rest);
  res.json({ jobs: list });
});
app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  const { process, accessToken, ...rest } = job;
  res.json(rest);
});
app.post('/api/jobs', async (req, res) => {
  try {
    const { fileId, url, title, setting } = req.body || {};
    let accessToken = null;
    if (fileId) {
      accessToken = await getAccessToken();
      if (!accessToken) return res.status(401).json({ error: 'Google Drive not authenticated' });
    }
    const job = createJob({ source: url || null, title, setting, fileId: fileId || null, accessToken });
    setTimeout(() => runJob(job), 50);
    res.json({ job: { ...job, process: undefined, accessToken: undefined } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  if (job.process) { try { job.process.kill('SIGKILL'); } catch {} }
  job.status = 'cancelled';
  saveJobs();
  try { fs.rmSync(path.join(MEDIA_DIR, job.id), { recursive: true, force: true }); } catch {}
  jobs.delete(job.id);
  saveJobs();
  res.json({ ok: true });
});

// Roku feed endpoint
app.get('/api/roku/feed', (req, res) => {
  const origin = getOrigin(req);
  const items = Array.from(jobs.values())
    .filter(j => j.status === 'completed' || j.status === 'running')
    .map(j => ({
      id: j.id,
      title: j.title,
      streamUrl: `${origin}${j.streamUrl}`,
      status: j.status,
      progress: j.progress,
    }));
  res.json({ items });
});

// ---------- SSDP Multicast Discovery Server ----------
function startSsdpServer() {
  try {
    const ssdpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    ssdpSocket.on('error', (err) => {
      console.warn(`[SSDP] Socket error (ignored): ${err.message}`);
    });
    ssdpSocket.on('message', (msg, rinfo) => {
      const text = msg.toString();
      if (text.includes('M-SEARCH')) {
        const matchesTarget = text.includes('urn:butfree:tv-transcoder:1') ||
                              text.includes('ssdp:all') ||
                              text.includes('roku:ecp');
        if (matchesTarget) {
          const loc = `http://${primaryLanIp}:${PORT}/api/health`;
          const response =
            'HTTP/1.1 200 OK\r\n' +
            'CACHE-CONTROL: max-age=1800\r\n' +
            `LOCATION: ${loc}\r\n` +
            'SERVER: Roku/9.0 UPnP/1.0 TvTranscoder/1.0\r\n' +
            'ST: urn:butfree:tv-transcoder:1\r\n' +
            `USN: uuid:tv-transcoder-${primaryLanIp}::urn:butfree:tv-transcoder:1\r\n\r\n`;
          try {
            ssdpSocket.send(Buffer.from(response), rinfo.port, rinfo.address);
          } catch (_) {}
        }
      }
    });
    ssdpSocket.bind(1900, () => {
      try {
        ssdpSocket.addMembership('239.255.255.250');
        console.log(`[SSDP] Listening on 239.255.255.250:1900 for Roku discovery queries`);
      } catch (mErr) {
        console.warn(`[SSDP] Multicast membership notice: ${mErr.message}`);
      }
    });
  } catch (err) {
    console.warn(`[SSDP] Could not bind UDP 1900 (normal if port is shared): ${err.message}`);
  }
}

// ---------- Cloud Server Registration (Heartbeat) ----------
async function registerWithCloudServer() {
  if (!MAIN_SERVER_URL) return;
  try {
    const payload = {
      port: PORT,
      localIps: localIps.map(x => x.ip),
      name: `TV Transcoder (${os.hostname()})`
    };
    const res = await fetch(`${MAIN_SERVER_URL}/api/transcoder/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000)
    });
    if (res.ok) {
      console.log(`[Transcoder] Heartbeat: Registered local IP(s) [${localIps.map(x => x.ip).join(', ')}] with ${MAIN_SERVER_URL}`);
    }
  } catch (err) {
    // Cloud registration error is non-fatal (local network discovery continues to work)
  }
}

// Start HTTP server
app.listen(PORT, HOST, () => {
  console.log(`=======================================================`);
  console.log(` TV TRANSCODER running at http://${HOST}:${PORT}`);
  console.log(` Local Network IP(s): ${localIps.map(x => `http://${x.ip}:${PORT}`).join(', ') || '127.0.0.1'}`);
  console.log(` FFmpeg: ${FFMPEG || 'NOT FOUND'}`);
  console.log(` Google OAuth: ${isAuthConfigured() ? 'Configured' : 'Not configured'}`);
  console.log(`=======================================================`);

  startSsdpServer();
  registerWithCloudServer();
  setInterval(registerWithCloudServer, 45000);
});
