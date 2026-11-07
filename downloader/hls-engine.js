import dns from 'node:dns';
try { dns.setDefaultResultOrder('ipv4first'); } catch (_) {}
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { resolveFfmpeg } from './transcoder.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const cpuCount = os.cpus()?.length || 2;
const CPU_THREADS = String(process.env.MAX_TRANSCODE_THREADS || '0');

const CACHE_DIR = process.env.DOWNLOADER_CACHE_DIR || process.env.CACHE_DIR || path.join(__dirname, 'downloads');
const HLS_CACHE_DIR = path.join(CACHE_DIR, 'hls');
if (!fs.existsSync(HLS_CACHE_DIR)) fs.mkdirSync(HLS_CACHE_DIR, { recursive: true });

const HLS_CHUNK_SECONDS = parseInt(process.env.HLS_CHUNK_SECONDS, 10) || 7200;
const HLS_IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes of inactivity before pruning

export const activeHlsSessions = new Map();
const hlsActiveByKey = new Map();
const hlsStartingByKeyOffset = new Map();

function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function getHostOrigin(req) {
  const forwardedProto = req.get('x-forwarded-proto');
  const forwardedHost = req.get('x-forwarded-host');
  if (forwardedHost) {
    return `${forwardedProto || 'http'}://${forwardedHost}`;
  }
  const host = req.get('host') || 'download.butfree.online:4000';
  const proto = req.protocol === 'https' ? 'https' : 'http';
  return `${proto}://${host}`;
}

function parseFfmpegDuration(text) {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  if (!m) return null;
  const hours = parseInt(m[1], 10);
  const minutes = parseInt(m[2], 10);
  const seconds = parseFloat(m[3]);
  return Math.round(hours * 3600 + minutes * 60 + seconds);
}

function computePlaylistStats(m3u8Path) {
  try {
    if (!fs.existsSync(m3u8Path)) return { segmentCount: 0, durationSec: 0 };
    const content = fs.readFileSync(m3u8Path, 'utf-8');
    const matches = [...content.matchAll(/#EXTINF:([\d.]+),/g)];
    const segmentCount = matches.length;
    const durationSec = matches.reduce((sum, m) => sum + parseFloat(m[1]), 0);
    return { segmentCount, durationSec };
  } catch (_) {
    return { segmentCount: 0, durationSec: 0 };
  }
}

export function cleanupHlsSession(sessionId, killFfmpeg = true) {
  const session = activeHlsSessions.get(sessionId);
  let pidToKill = session?.ffmpegProcess?.pid || null;
  if (!pidToKill) {
    const sessionJsonFile = path.join(HLS_CACHE_DIR, sessionId, 'session.json');
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
    activeHlsSessions.delete(sessionId);
  }
  try { fs.rmSync(path.join(HLS_CACHE_DIR, sessionId), { recursive: true, force: true }); } catch (_) {}
}

export function touchHlsSession(sessionId) {
  const session = activeHlsSessions.get(sessionId);
  if (session) session.lastActive = Date.now();
  if (!session) return;
  if (session.timer) clearTimeout(session.timer);
  session.timer = setTimeout(() => cleanupHlsSession(sessionId), HLS_IDLE_TIMEOUT_MS);
}

// -------------------------------------------------------------
// Google Drive HLS Transcoding Route Handler
// -------------------------------------------------------------
export async function handleDriveHls(req, res) {
  let { fileId } = req.params;
  if (fileId && fileId.endsWith('.m3u8')) fileId = fileId.replace(/\.m3u8$/, '');

  // Guard against relative segment requests (e.g. seg_00000.ts) mistakenly hitting this route
  if (!fileId || /^seg_\d+\.ts$/.test(fileId)) {
    if (fileId) {
      for (const [sid, s] of activeHlsSessions) {
        if (s && s.dir) {
          const segPath = path.join(s.dir, fileId);
          if (fs.existsSync(segPath)) {
            touchHlsSession(sid);
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', '*');
            res.setHeader('Content-Type', 'video/mp2t');
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            return fs.createReadStream(segPath).pipe(res);
          }
        }
      }
    }
    return res.status(404).send('Invalid fileId or segment not found');
  }

  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const token = req.query.token || req.headers.authorization?.replace('Bearer ', '') || req.headers['x-auth-token'] || '';
  const user = req.query.user || req.query.userId || '';
  const inputOrigin = (req.query.inputOrigin || 'https://tv.butfree.online').replace(/\/+$/, '');
  const origin = getHostOrigin(req);
  const sessionKey = `drive:${fileId}`;
  const lockKey = `${sessionKey}:${offset}`;

  // Deduplication: if another request is currently initializing this exact transcode
  if (hlsStartingByKeyOffset.has(lockKey)) {
    try {
      const waitSessionId = await hlsStartingByKeyOffset.get(lockKey);
      if (waitSessionId) {
        res.setHeader('X-Session-Id', waitSessionId);
        res.writeHead(302, {
          'Location': `${origin}/api/stream/hls/${waitSessionId}/index.m3u8`,
          'Cache-Control': 'no-cache'
        });
        return res.end();
      }
    } catch (_) {}
  }

  // Check in-memory activeHlsSessions for any session of this fileId matching offset (within 5 seconds)
  let reusableSessionId = null;
  for (const [sid, s] of activeHlsSessions) {
    if (s && s.type === 'drive' && s.fileId === fileId && typeof s.offset === 'number' && Math.abs(s.offset - offset) <= 5) {
      const isRunning = Boolean(s.ffmpegProcess && s.ffmpegProcess.exitCode === null);
      const m3u8Path = path.join(s.dir, 'index.m3u8');
      if (fs.existsSync(m3u8Path)) {
        try {
          const m3u8Content = fs.readFileSync(m3u8Path, 'utf-8');
          const hasSegments = (m3u8Content.match(/seg_\d+\.ts/g) || []).length >= 1;
          const isComplete = m3u8Content.includes('#EXT-X-ENDLIST');
          if (isRunning || isComplete || hasSegments) {
            reusableSessionId = sid;
            break;
          }
        } catch (_) {}
      }
    }
  }

  if (reusableSessionId) {
    console.log(`[VPS Drive HLS] Reusing active transcode session=${reusableSessionId} fileId=${fileId} offset=${offset}s`);
    touchHlsSession(reusableSessionId);
    res.setHeader('X-Session-Id', reusableSessionId);
    res.writeHead(302, {
      'Location': `${origin}/api/stream/hls/${reusableSessionId}/index.m3u8`,
      'Cache-Control': 'no-cache'
    });
    return res.end();
  }

  // Preempt any existing transcode session for other content so 100% of the VPS CPU is focused
  for (const [sid, s] of activeHlsSessions) {
    if (s && s.fileId !== fileId) {
      console.log(`[VPS Drive HLS] Preempting session=${sid} for new playback fileId=${fileId}`);
      cleanupHlsSession(sid);
    }
  }

  let resolveLock;
  const startPromise = new Promise((resolve) => { resolveLock = resolve; });
  hlsStartingByKeyOffset.set(lockKey, startPromise);

  const sessionId = crypto.randomUUID();
  const hlsDir = path.join(HLS_CACHE_DIR, sessionId);
  try {
    fs.mkdirSync(hlsDir, { recursive: true });
  } catch (err) {
    hlsStartingByKeyOffset.delete(lockKey);
    return res.status(500).send('Failed to create transcode cache directory');
  }

  const m3u8Path = path.join(hlsDir, 'index.m3u8');
  let sessionTotalDurationSec = null;
  const ffmpegCmd = resolveFfmpeg();

  let googleToken = req.query.googleToken || '';
  if (!googleToken) {
    try {
      const qParts = [];
      if (token) qParts.push(`token=${encodeURIComponent(token)}`);
      if (user) qParts.push(`user=${encodeURIComponent(user)}`);
      const q = qParts.length > 0 ? `?${qParts.join('&')}` : '';
      const tRes = await fetch(`${inputOrigin}/api/drive/token${q}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(4000)
      });
      if (tRes.ok) {
        const tData = await tRes.json();
        if (tData?.googleToken) googleToken = tData.googleToken;
      }
    } catch (_) {}
  }

  let inputUrl;
  const ffmpegArgs = [
    '-threads', CPU_THREADS,
    '-thread_type', 'frame+slice',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-reconnect_at_eof', '1',
    '-reconnect_on_http_error', '1',
    '-reconnect_on_network_error', '1',
    '-analyzeduration', '5M',
    '-probesize', '5M'
  ];

  if (googleToken) {
    inputUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
    ffmpegArgs.push('-headers', `Authorization: Bearer ${googleToken}\r\n`);
    console.log(`[VPS Drive HLS] Starting DIRECT Google Drive transcode session=${sessionId} fileId=${fileId} offset=${offset}s`);
  } else {
    const queryParts = [];
    if (token) queryParts.push(`token=${encodeURIComponent(token)}`);
    if (user) queryParts.push(`user=${encodeURIComponent(user)}`);
    const tokenQuery = queryParts.length > 0 ? `?${queryParts.join('&')}` : '';
    inputUrl = `${inputOrigin}/api/stream/drive/${fileId}${tokenQuery}`;
    console.log(`[VPS Drive HLS] Starting transcode session=${sessionId} fileId=${fileId} offset=${offset}s inputUrl=${inputOrigin}/api/stream/drive/${fileId}`);
  }

  if (offset > 0) {
    ffmpegArgs.push('-ss', offset.toString());
  }

  ffmpegArgs.push(
    '-i', inputUrl,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-sn',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-threads', CPU_THREADS,
    '-crf', '26',
    '-maxrate', '1500k',
    '-bufsize', '2500k',
    '-force_key_frames', 'expr:gte(t,n_forced*4)',
    '-sc_threshold', '0',
    '-x264-params', 'repeat-headers=1',
    '-vf', "scale=w='min(640,iw)':h='min(360,ih)':force_original_aspect_ratio=decrease:flags=fast_bilinear,scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=fast_bilinear",
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ac', '2',
    '-max_muxing_queue_size', '2048',
    '-hls_time', '4',
    '-t', String(HLS_CHUNK_SECONDS),
    '-hls_playlist_type', 'event',
    '-hls_list_size', '0',
    '-hls_flags', 'independent_segments',
    '-hls_segment_filename', 'seg_%05d.ts',
    'index.m3u8'
  );

  const ffmpegProcess = spawn(ffmpegCmd, ffmpegArgs, { cwd: hlsDir });
  let ffmpegErrTail = '';
  const ffmpegLogPath = path.join(hlsDir, 'ffmpeg.log');
  let logStream = null;
  try {
    logStream = fs.createWriteStream(ffmpegLogPath, { flags: 'a' });
    logStream.write(`[${new Date().toISOString()}] spawn ${ffmpegCmd} ${ffmpegArgs.join(' ')}\n`);
  } catch (_) {}

  ffmpegProcess.stderr.on('data', (d) => {
    ffmpegErrTail = (ffmpegErrTail + d.toString()).slice(-2000);
    if (logStream) { try { logStream.write(d); } catch (_) {} }
    if (sessionTotalDurationSec === null) {
      const parsedDur = parseFfmpegDuration(d.toString());
      if (parsedDur) {
        sessionTotalDurationSec = parsedDur;
        console.log(`[VPS Drive HLS] Parsed duration session=${sessionId} duration=${parsedDur}s`);
      }
    }
  });

  activeHlsSessions.set(sessionId, {
    type: 'drive',
    dir: hlsDir,
    ffmpegProcess,
    timer: null,
    fileId,
    key: sessionKey,
    offset,
    startedAt: Date.now(),
    lastActive: Date.now()
  });
  hlsActiveByKey.set(sessionKey, sessionId);
  touchHlsSession(sessionId);

  ffmpegProcess.on('error', (err) => {
    console.error(`[VPS Drive HLS] FFmpeg launch error: ${err.message}`);
    if (resolveLock) { resolveLock(null); hlsStartingByKeyOffset.delete(lockKey); }
    cleanupHlsSession(sessionId);
    if (!res.headersSent) res.status(500).send('Transcoding failed to start');
  });

  let ffmpegExited = false;
  let ffmpegExitCode = null;
  ffmpegProcess.on('exit', (code, signal) => {
    ffmpegExited = true;
    ffmpegExitCode = code;
    if (logStream) { try { logStream.end(); } catch (_) {} }
    console.log(`[VPS Drive HLS] FFmpeg exited session=${sessionId} code=${code} signal=${signal}`);
    try {
      if (fs.existsSync(m3u8Path)) {
        let m3u8Content = fs.readFileSync(m3u8Path, 'utf-8');
        if (!m3u8Content.includes('#EXT-X-ENDLIST')) {
          m3u8Content = m3u8Content.trimEnd() + '\n#EXT-X-ENDLIST\n';
          fs.writeFileSync(m3u8Path, m3u8Content);
        }
      }
    } catch (_) {}
  });

  // Poll for first segments to be generated before returning 302 redirect
  const waitStarted = Date.now();
  const waitForPlaylist = () => {
    if (ffmpegExited && ffmpegExitCode !== 0 && ffmpegExitCode !== null) {
      console.error(`[VPS Drive HLS] FFmpeg failed session=${sessionId} code=${ffmpegExitCode}`);
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
        const elapsed = Date.now() - waitStarted;
        if (segCount >= 2 || isComplete || (segCount >= 1 && elapsed > 5000)) {
          if (resolveLock) { resolveLock(sessionId); hlsStartingByKeyOffset.delete(lockKey); }
          console.log(`[VPS Drive HLS] Ready session=${sessionId} segments=${segCount} (${elapsed}ms)`);
          res.setHeader('X-Session-Id', sessionId);
          res.writeHead(302, {
            'Location': `${origin}/api/stream/hls/${sessionId}/index.m3u8`,
            'Cache-Control': 'no-cache'
          });
          return res.end();
        }
      }
    } catch (_) {}

    if (Date.now() - waitStarted > 60000) {
      if (resolveLock) { resolveLock(null); hlsStartingByKeyOffset.delete(lockKey); }
      cleanupHlsSession(sessionId);
      if (!res.headersSent) res.status(504).send('Transcoding initial buffer timed out');
      return;
    }
    setTimeout(waitForPlaylist, 250);
  };
  waitForPlaylist();
}

// -------------------------------------------------------------
// Torrent HLS Transcoding Route Handler
// -------------------------------------------------------------
export async function handleTorrentHls(req, res, activeStreams) {
  let { streamId, fileIndex } = req.params;
  if (fileIndex && fileIndex.endsWith('.m3u8')) fileIndex = fileIndex.replace(/\.m3u8$/, '');

  // Guard against relative segment requests mistakenly hitting torrent-hls
  if (streamId && /^seg_\d+\.ts$/.test(streamId)) {
    for (const [sid, s] of activeHlsSessions) {
      if (s && s.dir) {
        const segPath = path.join(s.dir, streamId);
        if (fs.existsSync(segPath)) {
          touchHlsSession(sid);
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', '*');
          res.setHeader('Content-Type', 'video/mp2t');
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          return fs.createReadStream(segPath).pipe(res);
        }
      }
    }
    return res.status(404).send('Invalid streamId or segment not found');
  }

  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const origin = getHostOrigin(req);
  const sessionKey = `torrent:${streamId}:${fileIndex || '0'}`;
  const lockKey = `${sessionKey}:${offset}`;

  if (hlsStartingByKeyOffset.has(lockKey)) {
    try {
      const waitSessionId = await hlsStartingByKeyOffset.get(lockKey);
      if (waitSessionId) {
        res.setHeader('X-Session-Id', waitSessionId);
        res.writeHead(302, {
          'Location': `${origin}/api/stream/hls/${waitSessionId}/index.m3u8`,
          'Cache-Control': 'no-cache'
        });
        return res.end();
      }
    } catch (_) {}
  }

  let reusableSessionId = null;
  for (const [sid, s] of activeHlsSessions) {
    if (s && s.type === 'torrent' && s.streamId === streamId && String(s.fileIndex) === String(fileIndex) && typeof s.offset === 'number' && Math.abs(s.offset - offset) <= 5) {
      const isRunning = Boolean(s.ffmpegProcess && s.ffmpegProcess.exitCode === null);
      const m3u8Path = path.join(s.dir, 'index.m3u8');
      if (fs.existsSync(m3u8Path)) {
        try {
          const m3u8Content = fs.readFileSync(m3u8Path, 'utf-8');
          const hasSegments = (m3u8Content.match(/seg_\d+\.ts/g) || []).length >= 1;
          const isComplete = m3u8Content.includes('#EXT-X-ENDLIST');
          if (isRunning || isComplete || hasSegments) {
            reusableSessionId = sid;
            break;
          }
        } catch (_) {}
      }
    }
  }

  if (reusableSessionId) {
    console.log(`[VPS Torrent HLS] Reusing active transcode session=${reusableSessionId} streamId=${streamId} offset=${offset}s`);
    touchHlsSession(reusableSessionId);
    res.setHeader('X-Session-Id', reusableSessionId);
    res.writeHead(302, {
      'Location': `${origin}/api/stream/hls/${reusableSessionId}/index.m3u8`,
      'Cache-Control': 'no-cache'
    });
    return res.end();
  }

  let resolveLock;
  const startPromise = new Promise((resolve) => { resolveLock = resolve; });
  hlsStartingByKeyOffset.set(lockKey, startPromise);

  const sessionId = crypto.randomUUID();
  const hlsDir = path.join(HLS_CACHE_DIR, sessionId);
  try {
    fs.mkdirSync(hlsDir, { recursive: true });
  } catch (err) {
    hlsStartingByKeyOffset.delete(lockKey);
    return res.status(500).send('Failed to create transcode cache directory');
  }

  const m3u8Path = path.join(hlsDir, 'index.m3u8');
  let sessionTotalDurationSec = null;
  const ffmpegCmd = resolveFfmpeg();

  const port = process.env.PORT || '4000';
  const inputUrl = `http://127.0.0.1:${port}/api/torrent/serve/${streamId}/${fileIndex || '0'}`;
  console.log(`[VPS Torrent HLS] Starting transcode session=${sessionId} streamId=${streamId} offset=${offset}s inputUrl=${inputUrl}`);

  const ffmpegArgs = [
    '-threads', CPU_THREADS,
    '-thread_type', 'frame+slice',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-reconnect_at_eof', '1',
    '-reconnect_on_http_error', '1',
    '-reconnect_on_network_error', '1',
    '-analyzeduration', '5M',
    '-probesize', '5M'
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
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-threads', CPU_THREADS,
    '-crf', '26',
    '-maxrate', '1500k',
    '-bufsize', '2500k',
    '-force_key_frames', 'expr:gte(t,n_forced*4)',
    '-sc_threshold', '0',
    '-x264-params', 'repeat-headers=1',
    '-vf', "scale=w='min(640,iw)':h='min(360,ih)':force_original_aspect_ratio=decrease:flags=fast_bilinear,scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=fast_bilinear",
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ac', '2',
    '-max_muxing_queue_size', '2048',
    '-hls_time', '4',
    '-t', String(HLS_CHUNK_SECONDS),
    '-hls_playlist_type', 'event',
    '-hls_list_size', '0',
    '-hls_flags', 'independent_segments',
    '-hls_segment_filename', 'seg_%05d.ts',
    'index.m3u8'
  );

  const ffmpegProcess = spawn(ffmpegCmd, ffmpegArgs, { cwd: hlsDir });
  let ffmpegErrTail = '';

  ffmpegProcess.stderr.on('data', (d) => {
    ffmpegErrTail = (ffmpegErrTail + d.toString()).slice(-2000);
    if (sessionTotalDurationSec === null) {
      const parsedDur = parseFfmpegDuration(d.toString());
      if (parsedDur) {
        sessionTotalDurationSec = parsedDur;
      }
    }
  });

  activeHlsSessions.set(sessionId, {
    type: 'torrent',
    dir: hlsDir,
    ffmpegProcess,
    timer: null,
    streamId,
    fileIndex,
    key: sessionKey,
    offset,
    startedAt: Date.now(),
    lastActive: Date.now()
  });
  hlsActiveByKey.set(sessionKey, sessionId);
  touchHlsSession(sessionId);

  ffmpegProcess.on('error', (err) => {
    console.error(`[VPS Torrent HLS] FFmpeg launch error: ${err.message}`);
    if (resolveLock) { resolveLock(null); hlsStartingByKeyOffset.delete(lockKey); }
    cleanupHlsSession(sessionId);
    if (!res.headersSent) res.status(500).send('Torrent transcoding failed to start');
  });

  let ffmpegExited = false;
  let ffmpegExitCode = null;
  ffmpegProcess.on('exit', (code, signal) => {
    ffmpegExited = true;
    ffmpegExitCode = code;
    try {
      if (fs.existsSync(m3u8Path)) {
        let m3u8Content = fs.readFileSync(m3u8Path, 'utf-8');
        if (!m3u8Content.includes('#EXT-X-ENDLIST')) {
          m3u8Content = m3u8Content.trimEnd() + '\n#EXT-X-ENDLIST\n';
          fs.writeFileSync(m3u8Path, m3u8Content);
        }
      }
    } catch (_) {}
  });

  const waitStarted = Date.now();
  const waitForPlaylist = () => {
    if (ffmpegExited && ffmpegExitCode !== 0 && ffmpegExitCode !== null) {
      if (resolveLock) { resolveLock(null); hlsStartingByKeyOffset.delete(lockKey); }
      cleanupHlsSession(sessionId);
      if (!res.headersSent) res.status(500).send('Torrent transcoding failed: ' + ffmpegErrTail);
      return;
    }
    try {
      if (fs.existsSync(m3u8Path)) {
        const content = fs.readFileSync(m3u8Path, 'utf-8');
        const segCount = (content.match(/seg_\d+\.ts/g) || []).length;
        const isComplete = content.includes('#EXT-X-ENDLIST');
        const elapsed = Date.now() - waitStarted;
        if (segCount >= 2 || isComplete || (segCount >= 1 && elapsed > 5000)) {
          if (resolveLock) { resolveLock(sessionId); hlsStartingByKeyOffset.delete(lockKey); }
          res.setHeader('X-Session-Id', sessionId);
          res.writeHead(302, {
            'Location': `${origin}/api/stream/hls/${sessionId}/index.m3u8`,
            'Cache-Control': 'no-cache'
          });
          return res.end();
        }
      }
    } catch (_) {}

    if (Date.now() - waitStarted > 60000) {
      if (resolveLock) { resolveLock(null); hlsStartingByKeyOffset.delete(lockKey); }
      cleanupHlsSession(sessionId);
      if (!res.headersSent) res.status(504).send('Torrent transcode initial buffer timed out');
      return;
    }
    setTimeout(waitForPlaylist, 250);
  };
  waitForPlaylist();
}

// -------------------------------------------------------------
// Serve HLS Files (.m3u8 playlists and .ts segments)
// -------------------------------------------------------------
export function handleServeHlsFile(req, res) {
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
    const isRunning = Boolean(session?.ffmpegProcess && session.ffmpegProcess.exitCode === null);
    if (!isRunning && !playlist.includes('#EXT-X-ENDLIST')) {
      playlist = playlist.trimEnd() + '\n#EXT-X-ENDLIST\n';
      try { fs.writeFileSync(filePath, playlist); } catch (_) {}
    }
    const origin = getHostOrigin(req);
    // Rewrite all segment references to fully-qualified absolute URLs so clients (especially Roku)
    // resolve segments directly to this VPS and never misroute relative paths
    const rewritten = playlist.replace(/^(?:.*[\\/])?(seg_\d+\.ts)\r?$/gm, `${origin}/api/stream/hls/${sessionId}/$1`);
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.send(rewritten);
  } else if (targetFile.endsWith('.ts')) {
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }

  const stream = fs.createReadStream(filePath);
  stream.on('error', () => {
    if (!res.headersSent) res.status(500).end();
  });
  stream.pipe(res);
}

// -------------------------------------------------------------
// Stop Route Handlers
// -------------------------------------------------------------
export function handleDriveHlsStop(req, res) {
  let fileId = (req.body && req.body.fileId) || req.query.fileId || '';
  if (fileId.endsWith('.m3u8')) fileId = fileId.replace(/\.m3u8$/, '');
  let stoppedCount = 0;
  for (const [sid, s] of activeHlsSessions) {
    if (s && s.type === 'drive' && (!fileId || s.fileId === fileId)) {
      cleanupHlsSession(sid);
      stoppedCount++;
    }
  }
  res.json({ success: true, stopped: stoppedCount > 0, stoppedCount });
}

export function handleTorrentHlsStop(req, res) {
  let streamId = (req.body && req.body.streamId) || req.query.streamId || '';
  let stoppedCount = 0;
  for (const [sid, s] of activeHlsSessions) {
    if (s && s.type === 'torrent' && (!streamId || s.streamId === streamId)) {
      cleanupHlsSession(sid);
      stoppedCount++;
    }
  }
  res.json({ success: true, stopped: stoppedCount > 0, stoppedCount });
}

// -------------------------------------------------------------
// Media Probe for Native Playability vs Transcode Detection
// -------------------------------------------------------------
export async function probeMediaCodecs(inputUrl, googleToken = '') {
  return new Promise((resolve) => {
    const cmd = resolveFfmpeg();
    const args = [
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '2',
      '-analyzeduration', '2M',
      '-probesize', '2M'
    ];
    if (googleToken) {
      args.push('-headers', `Authorization: Bearer ${googleToken}\r\n`);
    }
    args.push('-i', inputUrl);
    const probe = spawn(cmd, args);
    let stderr = '';
    const timer = setTimeout(() => {
      try { probe.kill('SIGKILL'); } catch (_) {}
      resolve({ videoCodec: '', audioCodec: '', nativelyPlayable: false, needsTranscode: true, reason: 'timeout' });
    }, 6000);

    probe.stderr.on('data', d => { stderr += d.toString(); });
    probe.on('close', () => {
      clearTimeout(timer);
      const vMatch = stderr.match(/Stream #\d+:\d+(?:\[.*?\])?(?:\(.*?\))?: Video: ([a-zA-Z0-9_-]+)/i);
      const aMatch = stderr.match(/Stream #\d+:\d+(?:\[.*?\])?(?:\(.*?\))?: Audio: ([a-zA-Z0-9_-]+)/i);
      const is10Bit = /yuv420p10|10-bit|high 10/i.test(stderr);

      const videoCodec = vMatch ? vMatch[1].toLowerCase() : '';
      const audioCodec = aMatch ? aMatch[1].toLowerCase() : '';

      const isNativeVideo = (videoCodec === 'h264' && !is10Bit);
      const isNativeAudio = ['aac', 'mp3'].includes(audioCodec);

      const nativelyPlayable = isNativeVideo && isNativeAudio;
      const needsTranscode = !nativelyPlayable;

      resolve({
        videoCodec,
        audioCodec,
        is10Bit,
        nativelyPlayable,
        needsTranscode,
        reason: nativelyPlayable ? 'native' : (!isNativeVideo ? `video_${videoCodec || 'unknown'}` : `audio_${audioCodec || 'unknown'}`)
      });
    });
    probe.on('error', () => {
      clearTimeout(timer);
      resolve({ videoCodec: '', audioCodec: '', nativelyPlayable: false, needsTranscode: true, reason: 'spawn_error' });
    });
  });
}

export async function handleStreamProbe(req, res) {
  const fileId = req.query.fileId || req.params.fileId;
  if (!fileId) return res.status(400).json({ success: false, error: 'Missing fileId' });
  const token = req.query.token || req.headers.authorization?.replace('Bearer ', '') || '';
  const user = req.query.user || '';
  const inputOrigin = (req.query.inputOrigin || 'https://tv.butfree.online').replace(/\/+$/, '');
  const queryParts = ['raw=1'];
  if (token) queryParts.push(`token=${encodeURIComponent(token)}`);
  if (user) queryParts.push(`user=${encodeURIComponent(user)}`);
  const inputUrl = `${inputOrigin}/api/stream/drive/${fileId}?${queryParts.join('&')}`;

  const result = await probeMediaCodecs(inputUrl);
  return res.json({ success: true, fileId, ...result });
}

// -------------------------------------------------------------
// Status Helper for Node Dashboard
// -------------------------------------------------------------
export function getHlsStatus() {
  const sessions = [];
  for (const [sid, s] of activeHlsSessions.entries()) {
    const isRunning = Boolean(s.ffmpegProcess && s.ffmpegProcess.exitCode === null);
    sessions.push({
      sessionId: sid,
      type: s.type,
      fileId: s.fileId || null,
      streamId: s.streamId || null,
      offset: s.offset,
      running: isRunning,
      pid: s.ffmpegProcess?.pid || null,
      uptimeSeconds: Math.floor((Date.now() - s.startedAt) / 1000)
    });
  }
  return {
    activeHlsCount: sessions.length,
    hlsSessions: sessions
  };
}

