import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import dotenv from 'dotenv';
import WebTorrent from 'webtorrent';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Explicitly load root .env from monorepo root, with local fallback
const rootEnv = path.resolve(__dirname, '../.env');
if (fs.existsSync(rootEnv)) {
  dotenv.config({ path: rootEnv });
}
dotenv.config();

// Global uncaught exception shields to prevent UDP / tracker malformed packet crashes
process.on('uncaughtException', (err) => {
  console.warn('[Downloader Uncaught Exception]:', err?.message || err);
});
process.on('unhandledRejection', (reason) => {
  console.warn('[Downloader Unhandled Rejection]:', reason?.stack || reason?.message || reason);
});

import {
  addDownloadJob,
  addYoutubeJob,
  cancelJob,
  clearHistory,
  cleanupOrphanedDownloads,
  deleteJob,
  getJob,
  getJobs,
  nodeStatus
} from './downloadManager.js';
import {
  addDownloadJob as addTvDownloadJob,
  getJobs as getTvJobs,
  getJob as getTvJob,
  cancelJob as cancelTvJob,
  deleteJob as deleteTvJob,
  clearHistory as clearTvHistory
} from './tvDownloadManager.js';
import { getPlaylistTracks } from './youtubeDownloader.js';
import { transcodeMediaFile, getVideoHeight, getMediaDuration } from './transcoder.js';

const PORT = parseInt(process.env.PORT || process.env.DOWNLOADER_PORT || '4000', 10);
const NODE_KEY = (process.env.NODE_KEY || process.env.DOWNLOADER_SECRET_KEY || process.env.TORRENT_NODE_KEY || '').trim();
const DASHBOARD_KEY = (process.env.DASHBOARD_KEY || process.env.TORRENT_DASHBOARD_KEY || NODE_KEY).trim();
const CACHE_DIR = process.env.DOWNLOADER_CACHE_DIR || process.env.CACHE_DIR || path.join(__dirname, 'downloads');
const DASHBOARD_HTML = path.join(__dirname, 'dashboard.html');

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

/** Shared-secret guard for protected JSON endpoints when NODE_KEY is set. */
function authorized(req) {
  if (!NODE_KEY && !DASHBOARD_KEY) return true;
  const provided = req.get('x-node-key') || req.get('x-dashboard-key') || req.query.key;
  if (!provided) return false;

  const validKeys = [NODE_KEY, DASHBOARD_KEY].filter(Boolean);
  for (const k of validKeys) {
    const a = Buffer.from(String(provided));
    const b = Buffer.from(k);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

function requireAuth(req, res, next) {
  if (authorized(req)) return next();
  return res.status(401).json({ success: false, error: 'Unauthorized: missing or invalid node key' });
}

// -------------------------------------------------------------
// WebTorrent Video Streaming Engine (Freevee TV / Movies)
// -------------------------------------------------------------
function guardTorrentDebug(torrent) {
  if (!torrent || torrent.__debugGuarded) return;
  torrent.__debugGuarded = true;
  const orig = torrent._debug;
  if (typeof orig === 'function') {
    torrent._debug = function (...args) {
      try {
        if (!this.client) return;
        return orig.apply(this, args);
      } catch (_) {}
    };
  }
}

const streamingClient = new WebTorrent({
  dht: true,
  maxConns: 150
});

streamingClient.on('error', (err) => {
  console.warn('[WebTorrent Streaming Client Error]:', err?.message || err);
});

const activeStreams = new Map();
const streamHistory = [];

function addStreamHistory(entry) {
  streamHistory.unshift({ ...entry, at: Date.now() });
  if (streamHistory.length > 50) streamHistory.pop();
}

function describeStream(id, s) {
  const t = s.torrent;
  return {
    id,
    title: s.file ? s.file.name : (t ? t.name : 'Unknown'),
    fileIndex: typeof s.fileIndex === 'number' ? s.fileIndex : 0,
    size: s.file ? s.file.length : 0,
    downloaded: t && t.downloaded ? t.downloaded : 0,
    progress: t && typeof t.progress === 'number' ? Math.min(100, Math.round(t.progress * 100)) : 0,
    downloadSpeed: t && t.downloadSpeed ? t.downloadSpeed : 0,
    uploadSpeed: t && t.uploadSpeed ? t.uploadSpeed : 0,
    peers: t && t.numPeers ? t.numPeers : 0,
    addedAt: s.addedAt,
    ageSeconds: Math.floor((Date.now() - s.addedAt) / 1000),
    idleSeconds: Math.floor((Date.now() - (s.lastActivity || s.addedAt || Date.now())) / 1000)
  };
}

// Optimized HTTP/HTTPS announce list: VPS providers (like IONOS) block outbound UDP,
// so HTTP/HTTPS trackers ensure 100% peer discovery without hanging on UDP timeouts.
const HTTP_TRACKERS = [
  'http://tracker.opentrackr.org:1337/announce',
  'http://tracker.openbittorrent.com:80/announce',
  'http://open.acgnxtracker.com:80/announce',
  'http://tracker.files.fm:6969/announce',
  'http://tracker1.bt.moack.co.kr:80/announce',
  'http://tracker.gbitt.info:80/announce',
  'https://tracker.tamersunion.org:443/announce',
  'https://tracker.moeblog.cn:443/announce',
  'https://tracker.zhuqiy.com:443/announce',
  'https://tracker1.520.jp:443/announce',
  'https://tr.burnbit.com:443/announce',
  'https://tracker.loligirl.cn:443/announce'
];

function parseMagnetToObject(url) {
  if (!url || typeof url !== 'string') return null;
  const clean = url.trim();

  const xtMatch = clean.match(/[?&]xt=urn:btih:([a-fA-F0-9]{40}|[A-Z2-7]{32})/i);
  if (!xtMatch) return null;

  let infoHashHex = xtMatch[1].toLowerCase();
  if (infoHashHex.length === 32) {
    const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
    let bits = 0, val = 0, hex = '';
    for (const c of infoHashHex) {
      val = (val << 5) | BASE32.indexOf(c);
      bits += 5;
      if (bits >= 8) { bits -= 8; hex += ((val >> bits) & 0xFF).toString(16).padStart(2, '0'); }
    }
    infoHashHex = hex;
  }

  const dnMatch = clean.match(/[?&]dn=([^&]*)/);
  const name = dnMatch ? decodeURIComponent(dnMatch[1].replace(/\+/g, ' ')) : infoHashHex;

  const trMatches = [...clean.matchAll(/[?&]tr=([^&]+)/g)];
  const existingTrackers = trMatches.map(m => decodeURIComponent(m[1]));
  const announce = [...new Set([...existingTrackers, ...HTTP_TRACKERS])];

  return { infoHashHex, name, announce };
}

// -------------------------------------------------------------
// Root & Health Status (Unauthenticated for easy monitoring)
// -------------------------------------------------------------
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'butfree Unified Downloader & Streaming Node',
    engines: ['fraudio-audiobooks', 'fraudio-youtube', 'freevee-torrent-streaming', 'video-transcoding', 'google-drive-uploader'],
    activeStreams: activeStreams.size,
    uptimeSeconds: Math.floor(process.uptime()),
    memoryUsageMB: Math.round(process.memoryUsage().rss / (1024 * 1024)),
    ...nodeStatus()
  });
});

app.get(['/health', '/api/status', '/api/torrent/status'], (req, res) => {
  const streams = [];
  for (const [id, s] of activeStreams.entries()) {
    streams.push(describeStream(id, s));
  }

  res.json({
    status: 'online',
    service: 'butfree Unified Downloader & Streaming Node',
    uptimeSeconds: Math.floor(process.uptime()),
    memoryUsageMB: Math.round(process.memoryUsage().rss / (1024 * 1024)),
    authRequired: Boolean(NODE_KEY),
    activeStreams: activeStreams.size,
    streams,
    ...nodeStatus()
  });
});

// Simple stream check alias for TV server
app.get(['/api/torrent', '/api/torrent/stream'], (req, res) => {
  res.json({
    status: 'online',
    service: 'butfree Unified Torrent Streamer',
    activeStreams: activeStreams.size,
    message: 'Torrent node is active and ready.'
  });
});

// -------------------------------------------------------------
// Freevee TV & Movie Torrent Download Endpoints
// -------------------------------------------------------------
app.post('/api/torrent/download', requireAuth, (req, res) => {
  const { magnet, title, kind, meta, driveConfig, transcodeConfig, webhookUrl, userId } = req.body || {};
  if (!magnet) {
    return res.status(400).json({ error: 'Missing magnet or torrent URL' });
  }

  try {
    const job = addTvDownloadJob({
      magnet,
      title,
      kind,
      meta,
      driveConfig,
      transcodeConfig,
      webhookUrl,
      userId
    });

    res.json({
      success: true,
      message: 'TV download job added to queue',
      job: {
        id: job.id,
        title: job.title,
        status: job.status,
        stage: job.stage
      }
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get('/api/torrent/downloads', requireAuth, (req, res) => {
  const userId = req.query.userId || null;
  const list = getTvJobs(userId).map(j => ({
    id: j.id,
    userId: j.userId,
    title: j.title,
    kind: j.kind,
    status: j.status,
    stage: j.stage,
    downloadPercent: j.downloadPercent,
    downloadSpeed: j.downloadSpeed,
    numPeers: j.numPeers,
    transcodePercent: j.transcodePercent,
    uploadPercent: j.uploadPercent,
    driveFileId: j.driveFileId,
    error: j.error,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
    queuePosition: j.queuePosition,
    queueType: j.queueType
  }));
  res.json({ success: true, downloads: list });
});

app.get('/api/torrent/download/:id', requireAuth, (req, res) => {
  const job = getTvJob(req.params.id);
  if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
  res.json({ success: true, job });
});

app.post('/api/torrent/download/:id/cancel', requireAuth, (req, res) => {
  const { id } = req.params;
  const cancelled = cancelTvJob(id);
  res.json({ success: true, cancelled });
});

app.delete('/api/torrent/downloads/history', requireAuth, (req, res) => {
  const userId = req.query.userId || req.body?.userId || null;
  const count = clearTvHistory(userId);
  res.json({ success: true, count });
});

app.post('/api/torrent/downloads/clear-history', requireAuth, (req, res) => {
  const userId = req.query.userId || req.body?.userId || null;
  const count = clearTvHistory(userId);
  res.json({ success: true, count });
});

app.delete('/api/torrent/download/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  const deleted = deleteTvJob(id);
  res.json({ success: true, deleted });
});

// -------------------------------------------------------------
// Fraudio Audiobook & YouTube Job Control
// -------------------------------------------------------------
app.post('/api/download', requireAuth, (req, res) => {
  const body = req.body || {};
  try {
    const job = addDownloadJob({
      id: body.id,
      userId: body.userId,
      magnet: body.magnet,
      source: body.source,
      infoHash: body.infoHash,
      title: body.title,
      author: body.author,
      series: body.series,
      seriesIndex: body.seriesIndex,
      narrator: body.narrator,
      format: body.format,
      bitrate: body.bitrate,
      abridged: body.abridged,
      coverUrl: body.coverUrl,
      postUrl: body.postUrl,
      postId: body.postId,
      driveConfig: body.driveConfig,
      webhookUrl: body.webhookUrl,
      webhookSecret: body.webhookSecret || body.driveConfig?.webhookSecret || null
    });

    res.json({
      success: true,
      job: {
        id: job.id,
        title: job.title,
        status: job.status,
        stage: job.stage,
        infoHash: job.infoHash
      }
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/youtube/download', requireAuth, (req, res) => {
  const body = req.body || {};
  try {
    const job = addYoutubeJob({
      id: body.id,
      userId: body.userId,
      title: body.title,
      artist: body.artist,
      album: body.album,
      entries: body.entries,
      coverUrl: body.coverUrl,
      format: body.format,
      quality: body.quality,
      cookiesContent: body.cookiesContent || null,
      driveConfig: body.driveConfig,
      webhookUrl: body.webhookUrl,
      webhookSecret: body.webhookSecret || body.driveConfig?.webhookSecret || null
    });

    res.json({
      success: true,
      job: {
        id: job.id,
        title: job.title,
        status: job.status,
        stage: job.stage,
        type: 'youtube',
        entriesCount: job.entries.length
      }
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get('/api/youtube/tracks', requireAuth, async (req, res) => {
  const playlistId = req.query.playlistId;
  if (!playlistId) return res.status(400).json({ success: false, error: 'playlistId query param is required' });
  try {
    const data = await getPlaylistTracks(playlistId);
    res.json({ success: true, ...data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/downloads', requireAuth, (req, res) => {
  res.json({ success: true, downloads: getJobs(req.query.userId || null) });
});

app.get('/api/download/:id', requireAuth, (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
  res.json({ success: true, job });
});

app.post('/api/download/:id/cancel', requireAuth, (req, res) => {
  const ok = cancelJob(req.params.id);
  res.json({ success: ok, cancelled: ok });
});

app.delete('/api/download/:id', requireAuth, (req, res) => {
  const ok = deleteJob(req.params.id);
  res.json({ success: ok, deleted: ok });
});

app.delete('/api/downloads/history', requireAuth, (req, res) => {
  res.json({ success: true, cleared: clearHistory(req.query.userId || null) });
});

app.post('/api/cleanup', requireAuth, (req, res) => {
  cleanupOrphanedDownloads();
  res.json({ success: true });
});

// -------------------------------------------------------------
// YouTube Netscape Cookies Configuration
// -------------------------------------------------------------
app.get('/api/cookies', requireAuth, (req, res) => {
  const cookiePath = path.join(__dirname, 'cookies.txt');
  if (fs.existsSync(cookiePath)) {
    try {
      const content = fs.readFileSync(cookiePath, 'utf8');
      const stats = fs.statSync(cookiePath);
      return res.json({
        success: true,
        exists: true,
        sizeBytes: stats.size,
        updatedAt: stats.mtime,
        content
      });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }
  return res.json({ success: true, exists: false, content: '', sizeBytes: 0 });
});

app.post('/api/cookies', requireAuth, (req, res) => {
  const raw = (req.body?.content || req.body?.cookies || '').trim();
  if (!raw) {
    return res.status(400).json({ success: false, error: 'cookies.txt content is required' });
  }

  const targets = [
    path.join(__dirname, 'cookies.txt'),
    path.resolve('./cookies.txt'),
    path.join(CACHE_DIR, 'cookies.txt')
  ];

  try {
    for (const target of targets) {
      const dir = path.dirname(target);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(target, raw + '\n', 'utf8');
    }
    console.log(`[FraudioStreamer] Successfully written ${raw.length} bytes to cookies.txt via /api/cookies`);
    return res.json({
      success: true,
      message: 'cookies.txt successfully written to download server',
      sizeBytes: Buffer.byteLength(raw, 'utf8')
    });
  } catch (err) {
    console.error('[FraudioStreamer] Failed to write cookies.txt:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------------
// Freevee TV: Torrent Streaming Endpoints
// -------------------------------------------------------------
app.post('/api/torrent/stream', (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing torrent URL or magnet' });
  }

  console.log(`[Stream Request Received]: ${url.substring(0, 80)}...`);

  const parsed = parseMagnetToObject(url);
  if (!parsed) {
    return res.status(400).json({ error: 'Could not parse magnet link — missing xt=urn:btih hash.' });
  }

  const { infoHashHex, name, announce } = parsed;
  const streamId = infoHashHex;

  // 1. Check if stream is already active and ready in memory
  if (activeStreams.has(streamId)) {
    const existing = activeStreams.get(streamId);
    if (existing && existing.file) {
      console.log(`[Stream Reused]: ${existing.file.name}`);
      return res.json({
        success: true,
        streamUrl: `/api/torrent/serve/${streamId}/${existing.fileIndex || 0}`,
        streamId,
        fileIndex: existing.fileIndex || 0,
        title: existing.file.name,
        size: existing.file.length,
        files: (existing.files || []).map((f, i) => ({ name: f.name, length: f.length, index: i }))
      });
    }
  }

  let responded = false;
  let torrentInstance = null;

  const timeout = setTimeout(() => {
    if (!responded) {
      responded = true;
      console.warn(`[Torrent Timeout]: 90s reached for ${url.substring(0, 60)}`);
      if (torrentInstance && !activeStreams.has(streamId)) {
        try { torrentInstance.destroy(); } catch (_) {}
      }
      res.status(504).json({ error: 'Connecting to torrent swarm timed out. The VPS may not be able to reach enough peers for this torrent. Please try another source.' });
    }
  }, 90000);

  req.on('close', () => {
    if (!responded) {
      clearTimeout(timeout);
    }
  });

  try {
    const getActiveTorrent = (hash) => {
      const lower = String(hash || '').toLowerCase();
      return (streamingClient.torrents || []).find(t => t && t.infoHash && String(t.infoHash).toLowerCase() === lower) || null;
    };

    const existingTorrent = getActiveTorrent(infoHashHex);
    if (existingTorrent) {
      console.log(`[Stream Swarm Reused]: infoHash=${infoHashHex}, ready=${!!existingTorrent.ready}`);
      torrentInstance = existingTorrent;
    } else {
      console.log(`[Adding torrent]: infoHash=${infoHashHex}, announceCount=${announce.length}`);
      try {
        torrentInstance = streamingClient.add(url, {
          path: path.join(CACHE_DIR, 'streams', streamId),
          announce,
          name,
          destroyStoreOnDestroy: true
        });
      } catch (addErr) {
        if (addErr.message && addErr.message.toLowerCase().includes('duplicate')) {
          torrentInstance = getActiveTorrent(infoHashHex);
        } else {
          throw addErr;
        }
      }
    }

    if (torrentInstance) {
      guardTorrentDebug(torrentInstance);
    }

    const onTorrentReady = () => {
      if (!torrentInstance || !torrentInstance.files || torrentInstance.files.length === 0) return;
      if (responded) return;

      const videoFiles = torrentInstance.files.filter(f => /\.(mp4|mkv|avi|webm|mov|m4v|ts|flv|wmv)$/i.test(f.name));
      const file = videoFiles.length > 0
        ? videoFiles.reduce((prev, curr) => ((curr.length || 0) > (prev.length || 0) ? curr : prev), videoFiles[0])
        : torrentInstance.files[0];

      if (file && typeof file.select === 'function') {
        file.select();
      }

      const fileIndex = torrentInstance.files.indexOf(file);
      const safeFileIndex = fileIndex >= 0 ? fileIndex : 0;
      activeStreams.set(streamId, {
        torrent: torrentInstance,
        file,
        files: torrentInstance.files,
        fileIndex: safeFileIndex,
        addedAt: Date.now(),
        lastActivity: Date.now()
      });

      addStreamHistory({ type: 'started', streamId, title: file ? file.name : torrentInstance.name, size: file ? file.length : 0 });

      // Prioritize the beginning pieces of the video file for fast initial playback
      if (typeof torrentInstance.critical === 'function' && typeof file._startPiece === 'number') {
        const criticalEnd = Math.min(file._startPiece + 2, file._endPiece || file._startPiece);
        try { torrentInstance.critical(file._startPiece, criticalEnd); } catch (_) {}
      }

      const finishStreamInit = () => {
        if (responded) return;
        clearTimeout(timeout);
        responded = true;
        const bufferedKB = Math.round((torrentInstance.downloaded || 0) / 1024);
        console.log(`[Stream Ready]: ${file?.name} (${Math.round((file?.length || 0) / (1024 * 1024))} MB, buffered ${bufferedKB} KB)`);

        res.json({
          success: true,
          streamUrl: `/api/torrent/serve/${streamId}/${safeFileIndex}`,
          streamId,
          fileIndex: safeFileIndex,
          title: file ? file.name : torrentInstance.name,
          size: file ? file.length : 0,
          files: torrentInstance.files.map((f, i) => ({ name: f.name, length: f.length, index: i }))
        });
      };

      if ((torrentInstance.downloaded || 0) >= 512 * 1024) {
        finishStreamInit();
      } else {
        const onDownload = () => {
          if ((torrentInstance.downloaded || 0) >= 512 * 1024) {
            torrentInstance.off('download', onDownload);
            finishStreamInit();
          }
        };
        torrentInstance.on('download', onDownload);
        setTimeout(() => {
          torrentInstance.off('download', onDownload);
          finishStreamInit();
        }, 4000);
      }
    };

    if (torrentInstance.ready && torrentInstance.files && torrentInstance.files.length > 0) {
      onTorrentReady();
    } else {
      torrentInstance.once('ready', onTorrentReady);
    }

    torrentInstance.on('error', (err) => {
      const msg = err?.message || String(err);
      if (msg.toLowerCase().includes('duplicate')) return;
      console.warn('[Stream Torrent Error]:', msg);
      if (!responded) {
        clearTimeout(timeout);
        responded = true;
        if (torrentInstance && !activeStreams.has(streamId)) {
          try { torrentInstance.destroy(); } catch (_) {}
        }
        res.status(500).json({ error: 'Torrent stream error: ' + msg });
      }
    });
  } catch (err) {
    console.error('[Add Torrent Exception]:', err);
    if (!responded) {
      clearTimeout(timeout);
      responded = true;
      res.status(500).json({ error: err.message || 'Streaming failed' });
    }
  }
});

// Byte-Range Video Streaming Handler
const handleServeStream = (req, res) => {
  const { streamId, fileIndex } = req.params;
  const streamInfo = activeStreams.get(streamId);
  if (!streamInfo || !streamInfo.file) {
    return res.status(404).send('Stream not found or expired');
  }

  streamInfo.lastActivity = Date.now();

  const idx = parseInt(fileIndex, 10);
  const file = (!isNaN(idx) && streamInfo.files && streamInfo.files[idx]) ? streamInfo.files[idx] : streamInfo.file;
  const fileSize = file.length;
  const ext = path.extname(file.name).toLowerCase();

  let contentType = 'video/mp4';
  if (ext === '.mkv') contentType = 'video/x-matroska';
  else if (ext === '.webm') contentType = 'video/webm';
  else if (ext === '.avi') contentType = 'video/x-msvideo';
  else if (ext === '.mov') contentType = 'video/quicktime';
  else if (ext === '.ts') contentType = 'video/mp2t';
  else if (ext === '.m4v') contentType = 'video/x-m4v';

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Type');

  const range = req.headers.range;

  if (range) {
    const rangeMatch = /bytes=(\d*)-(\d*)/.exec(range);
    let start = 0;
    let end = fileSize - 1;
    if (rangeMatch) {
      if (rangeMatch[1] === '' && rangeMatch[2] !== '') {
        start = Math.max(0, fileSize - parseInt(rangeMatch[2], 10));
      } else {
        if (rangeMatch[1] !== '') start = parseInt(rangeMatch[1], 10);
        if (rangeMatch[2] !== '') end = Math.min(parseInt(rangeMatch[2], 10), fileSize - 1);
      }
    }

    if (isNaN(start) || isNaN(end) || start > end || start >= fileSize) {
      return res.status(416).send('Requested range not satisfiable');
    }

    const chunksize = (end - start) + 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': contentType
    });

    if (req.method === 'HEAD') return res.end();

    try {
      const readStream = file.createReadStream({ start, end });
      readStream.pipe(res);
      readStream.on('error', (err) => {
        if (!res.headersSent) res.status(500).end();
        else res.end();
      });
      req.on('close', () => {
        try { readStream.destroy(); } catch (_) {}
      });
    } catch (err) {
      if (!res.headersSent) res.status(500).end();
    }
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes'
    });

    if (req.method === 'HEAD') return res.end();

    try {
      const readStream = file.createReadStream();
      readStream.pipe(res);
      readStream.on('error', (err) => {
        if (!res.headersSent) res.status(500).end();
        else res.end();
      });
      req.on('close', () => {
        try { readStream.destroy(); } catch (_) {}
      });
    } catch (err) {
      if (!res.headersSent) res.status(500).end();
    }
  }
};

app.get('/api/torrent/serve/:streamId/:fileIndex', handleServeStream);
app.head('/api/torrent/serve/:streamId/:fileIndex', handleServeStream);
app.get('/api/torrent/stream/:streamId/file/:fileIndex', handleServeStream);
app.head('/api/torrent/stream/:streamId/file/:fileIndex', handleServeStream);

// Stop stream endpoint
const stopStreamById = (streamId) => {
  const stream = activeStreams.get(streamId);
  let existed = false;
  if (stream) {
    existed = true;
    try {
      if (stream.torrent && typeof stream.torrent.destroy === 'function') {
        stream.torrent.destroy();
      }
    } catch (err) {
      console.warn('[Stream Stop Destroy Error]:', err.message);
    }
    activeStreams.delete(streamId);
    addStreamHistory({ type: 'stopped', streamId, title: stream.file ? stream.file.name : 'Unknown' });
    console.log(`[Stream Stopped]: ${streamId}`);
  }

  try {
    const streamDir = path.join(CACHE_DIR, 'streams', streamId);
    if (fs.existsSync(streamDir)) fs.rmSync(streamDir, { recursive: true, force: true });
  } catch (_) {}

  return existed;
};

const stopStreamRoute = (req, res) => {
  const { streamId } = req.params;
  const stopped = stopStreamById(streamId);
  res.json({ success: true, stopped });
};

app.post('/api/torrent/stream/:streamId/stop', stopStreamRoute);
app.delete('/api/torrent/stream/:streamId', stopStreamRoute);

// Cache management
function getDirectorySize(dirPath) {
  let size = 0;
  if (!fs.existsSync(dirPath)) return 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        size += getDirectorySize(fullPath);
      } else {
        size += fs.statSync(fullPath).size;
      }
    }
  } catch (_) {}
  return size;
}

app.get('/api/torrent/cache/size', (req, res) => {
  const sizeBytes = getDirectorySize(CACHE_DIR);
  res.json({
    success: true,
    cacheDir: CACHE_DIR,
    sizeBytes,
    sizeMB: Math.round(sizeBytes / (1024 * 1024)),
    sizeGB: (sizeBytes / (1024 * 1024 * 1024)).toFixed(2)
  });
});

app.post('/api/torrent/cache/clear', requireAuth, (req, res) => {
  try {
    const streamsDir = path.join(CACHE_DIR, 'streams');
    if (fs.existsSync(streamsDir)) {
      const activeIds = new Set(activeStreams.keys());
      const dirs = fs.readdirSync(streamsDir);
      for (const d of dirs) {
        if (!activeIds.has(d)) {
          try { fs.rmSync(path.join(streamsDir, d), { recursive: true, force: true }); } catch (_) {}
        }
      }
    }
    const freedBytes = getDirectorySize(CACHE_DIR);
    res.json({ success: true, message: 'Cleared inactive stream cache.', currentSizeBytes: freedBytes });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Periodic idle stream cleanup (10 min idle)
setInterval(() => {
  const now = Date.now();
  const idleMs = (parseInt(process.env.MAX_STREAM_IDLE_MINUTES || '10', 10)) * 60 * 1000;
  for (const [id, stream] of activeStreams.entries()) {
    const last = stream.lastActivity || stream.addedAt || now;
    if (now - last > idleMs) {
      stopStreamById(id);
      addStreamHistory({ type: 'cleaned', streamId: id, title: stream.file ? stream.file.name : 'Unknown' });
      console.log(`[Stream Cleaned (idle)]: ${id}`);
    }
  }
}, 2 * 60 * 1000);

// -------------------------------------------------------------
// Video Transcoding API Endpoint
// -------------------------------------------------------------
app.post('/api/transcode', requireAuth, async (req, res) => {
  const { inputPath, outputPath, options = {} } = req.body || {};
  if (!inputPath || !fs.existsSync(inputPath)) {
    return res.status(400).json({ success: false, error: 'inputPath does not exist on disk' });
  }
  const dest = outputPath || path.join(path.dirname(inputPath), `${path.basename(inputPath, path.extname(inputPath))}_transcoded.mp4`);

  try {
    const result = await transcodeMediaFile(inputPath, dest, options);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------------
// Unified Dashboard UI & Status
// -------------------------------------------------------------
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()) });
});

app.get(['/', '/dashboard', '/dashboard/'], (req, res) => {
  if (!fs.existsSync(DASHBOARD_HTML)) {
    return res.status(404).send('dashboard.html not found');
  }
  res.type('html').send(fs.readFileSync(DASHBOARD_HTML, 'utf-8'));
});

app.get(['/api/dashboard', '/api/torrent/dashboard'], requireAuth, (req, res) => {
  const streams = [];
  for (const [id, s] of activeStreams.entries()) {
    streams.push(describeStream(id, s));
  }

  res.json({
    success: true,
    stats: {
      uptimeSeconds: Math.floor(process.uptime()),
      memoryUsageMB: Math.round(process.memoryUsage().rss / (1024 * 1024)),
      activeStreamsCount: activeStreams.size,
      ...nodeStatus()
    },
    streams,
    streamHistory,
    downloads: getJobs()
  });
});

// Restart PM2 process
const handleRestart = (req, res) => {
  console.log('[Downloader] Process restart requested via API.');
  res.json({ success: true, message: 'Unified downloader server is restarting…' });
  setTimeout(() => {
    exec('pm2 restart butfree-downloader || pm2 restart all', { timeout: 3000 }, () => {});
    setTimeout(() => process.exit(0), 1500);
  }, 300);
};

app.post('/api/restart', requireAuth, handleRestart);
app.post('/api/torrent/restart', requireAuth, handleRestart);
app.post('/api/dashboard/restart', requireAuth, handleRestart);

app.use((err, req, res, next) => {
  console.error('[Downloader Unhandled Error]:', err.message);
  res.status(500).json({ success: false, error: err.message });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`==================================================================`);
  console.log(`🚀 butFREE Unified Downloader & Streaming Server running on :${PORT}`);
  console.log(`   • Fraudio Audiobooks & YouTube Music: ACTIVE`);
  console.log(`   • Freevee TV & Movie WebTorrent Streaming: ACTIVE`);
  console.log(`   • Cache Directory: ${CACHE_DIR}`);
  console.log(`   • Auth: ${NODE_KEY ? 'NODE_KEY enforced' : 'OPEN (no key set)'}`);
  console.log(`==================================================================`);
});