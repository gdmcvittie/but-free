import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, BIN_DIR, ROOT_DIR, config } from './config.js';
import binManager from './binManager.js';
import youtubeMusic from './youtubeMusic.js';
import abbClient from './abbClient.js';
import torrentNode from './torrentNode.js';
import db from './db.js';
import googleAuth from './googleAuth.js';
import googleDrive from './googleDrive.js';
import { sanitizeTitle, sanitizeSegment, extensionOf, formatPlaylistM3u8 } from './libraryParser.js';

const DEVICE_DOWNLOADS_DIR = path.join(DATA_DIR, 'device_downloads');
try {
  fs.mkdirSync(DEVICE_DOWNLOADS_DIR, { recursive: true });
} catch { /* best effort */ }

/** Map of jobId -> job object */
const jobs = new Map();

/** Clean up jobs older than 3 hours */
const JOB_MAX_AGE_MS = 3 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (now - job.createdAt > JOB_MAX_AGE_MS) {
      if (job.stagingDir && fs.existsSync(job.stagingDir)) {
        try { fs.rmSync(job.stagingDir, { recursive: true, force: true }); } catch {}
      }
      jobs.delete(id);
    }
  }
}, 30 * 60 * 1000).unref();

function safePart(str, fallback = 'Unknown') {
  return sanitizeSegment(str || fallback);
}

function nap(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


// ---------------------------------------------------------------------------
// Device Pairing & Auth Store (for portable players / Roku / embedded clients)
// ---------------------------------------------------------------------------
const PAIRING_FILE = path.join(DATA_DIR, 'device_pairing.json');
let devicePairingStore = {};

function loadPairingStore() {
  try {
    if (fs.existsSync(PAIRING_FILE)) {
      return JSON.parse(fs.readFileSync(PAIRING_FILE, 'utf8'));
    }
  } catch {}
  return {};
}

function savePairingStore(store) {
  try {
    fs.writeFileSync(PAIRING_FILE, JSON.stringify(store, null, 2), 'utf8');
  } catch {}
}

function cleanupPairingStore() {
  const now = Date.now();
  let changed = false;
  for (const [code, entry] of Object.entries(devicePairingStore)) {
    if (now - entry.createdAt > 5 * 60 * 1000) {
      delete devicePairingStore[code];
      changed = true;
    }
  }
  if (changed) savePairingStore(devicePairingStore);
}

const PAIRING_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
function generatePairingCode() {
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += PAIRING_CHARS[Math.floor(Math.random() * PAIRING_CHARS.length)];
  }
  return code;
}

function createDeviceToken(user, ttl = 10 * 365 * 24 * 60 * 60 * 1000) {
  if (!user || !user.id) return null;
  const exp = Date.now() + ttl;
  const payload = `${user.id}:${exp}`;
  const hmac = crypto.createHmac('sha256', config.google.sessionSecret).update(payload).digest('hex');
  return `dt.${user.id}.${exp}.${hmac}`;
}

function verifyDeviceToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'dt') return null;
  const [_, userId, expStr, hmac] = parts;
  const exp = Number(expStr);
  if (!exp || Date.now() > exp) return null;
  const payload = `${userId}:${expStr}`;
  const expected = crypto.createHmac('sha256', config.google.sessionSecret).update(payload).digest('hex');
  if (hmac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expected))) {
    return null;
  }
  return db.getUser(userId);
}

function authenticateDevice(req) {
  let token = null;
  if (req.headers.authorization) {
    const [scheme, val] = req.headers.authorization.split(' ');
    if (scheme?.toLowerCase() === 'bearer' && val) token = val;
  }
  if (!token && req.query.token) token = String(req.query.token);
  if (!token && req.query.deviceToken) token = String(req.query.deviceToken);
  if (!token && req.body?.token) token = String(req.body.token);

  if (!token) return null;
  token = token.trim();

  if (token.startsWith('dt.')) {
    return verifyDeviceToken(token);
  }

  // Fallback for standard session tokens (handling '+' converted to space)
  const parts = token.split('.');
  if (parts.length === 2) {
    token = parts[0].replace(/ /g, '+') + '.' + parts[1];
  }
  return googleAuth.verifySessionToken(token);
}

function createJob(type, meta = {}) {
  const id = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const stagingDir = path.join(DEVICE_DOWNLOADS_DIR, id);
  fs.mkdirSync(stagingDir, { recursive: true });

  const job = {
    id,
    type,
    status: 'queued', // queued | downloading | processing | ready | error
    phase: 'Queued',
    percent: 0,
    error: null,
    createdAt: Date.now(),
    meta,
    stagingDir,
    files: [] // { index, path, filename, size, localPath }
  };
  jobs.set(id, job);
  return job;
}

/** Run local yt-dlp to download and convert to MP3 */
async function downloadYoutubeToDir(videoId, targetDir, { title, artist, album } = {}) {
  const bin = await binManager.ensureYtDlp();
  const ffmpegDir = binManager.resolveFfmpegDir();
  const ffmpegLocation = ffmpegDir ? ['--ffmpeg-location', ffmpegDir] : [];

  const outTemplate = path.join(targetDir, '%(title)s.%(ext)s');
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--retries', '3',
    '--extract-audio',
    '--audio-format', 'mp3',
    '--audio-quality', '0',
    '--embed-metadata',
    '--embed-thumbnail',
    ...ffmpegLocation,
    '-o', outTemplate,
    `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
  ];

  await new Promise((resolve, reject) => {
    let errBuf = '';
    binManager.runProcess(bin, args, {
      onStderr: (chunk) => { errBuf += chunk; }
    }).then(resolve, (err) => {
      reject(new Error(errBuf || err.message || 'yt-dlp failed'));
    });
  });

  // Find the produced audio file
  const entries = fs.readdirSync(targetDir);
  const audioFile = entries.find((f) => /\.(mp3|m4a|opus|ogg|flac)$/i.test(f));
  if (!audioFile) {
    throw new Error('yt-dlp finished but no audio file was produced.');
  }

  return path.join(targetDir, audioFile);
}

/** Background processor for single song download */
async function processSongJob(job) {
  try {
    job.status = 'downloading';
    job.phase = 'Downloading audio';
    job.percent = 20;

    const { videoId, title, artist, album } = job.meta;
    const downloadedPath = await downloadYoutubeToDir(videoId, job.stagingDir, { title, artist, album });

    job.percent = 80;
    job.phase = 'Finalizing';

    const ext = extensionOf(downloadedPath) || 'mp3';
    const artistName = safePart(artist, 'Unknown Artist');
    const albumName = safePart(album, 'Singles');
    const cleanTitle = safePart(title || path.basename(downloadedPath, `.${ext}`));
    const finalFilename = `${cleanTitle}.${ext}`;
    const finalPath = path.join(job.stagingDir, finalFilename);

    if (downloadedPath !== finalPath && fs.existsSync(downloadedPath)) {
      fs.renameSync(downloadedPath, finalPath);
    }

    const stat = fs.statSync(finalPath);
    const relPath = `Music/${artistName}/${albumName}/${finalFilename}`;

    job.files = [
      {
        index: 0,
        path: relPath,
        filename: finalFilename,
        size: stat.size,
        localPath: finalPath
      }
    ];

    job.status = 'ready';
    job.phase = 'Ready';
    job.percent = 100;
  } catch (err) {
    console.error(`[DeviceApi] Song download failed for ${job.id}:`, err);
    job.status = 'error';
    job.phase = 'Failed';
    job.error = err.message || 'Download failed';
  }
}

/** Background processor for album download */
async function processAlbumJob(job) {
  try {
    job.status = 'downloading';
    job.phase = 'Fetching tracklist';
    job.percent = 5;

    const { playlistId, browseId, title: albumTitle, artist: albumArtist } = job.meta;
    const albumRef = playlistId || browseId;
    let tracks = await youtubeMusic.albumTracks(albumRef);
    if (!tracks || !tracks.length) {
      throw new Error('No tracks found for this album.');
    }

    const artistName = safePart(albumArtist, 'Unknown Artist');
    const albumName = safePart(albumTitle, 'Album');

    const files = [];
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      const trackNum = String(i + 1).padStart(2, '0');
      job.phase = `Downloading ${i + 1}/${tracks.length}: ${track.title}`;
      job.percent = Math.round(10 + (i / tracks.length) * 80);

      const trackDir = path.join(job.stagingDir, trackNum);
      fs.mkdirSync(trackDir, { recursive: true });

      try {
        const downloadedPath = await downloadYoutubeToDir(track.videoId, trackDir, {
          title: track.title,
          artist: track.artist || albumArtist,
          album: albumTitle
        });

        const ext = extensionOf(downloadedPath) || 'mp3';
        const cleanTrackTitle = safePart(track.title);
        const finalFilename = `${trackNum} ${cleanTrackTitle}.${ext}`;
        const finalPath = path.join(job.stagingDir, finalFilename);

        fs.renameSync(downloadedPath, finalPath);
        const stat = fs.statSync(finalPath);

        files.push({
          index: i,
          path: `Music/${artistName}/${albumName}/${finalFilename}`,
          filename: finalFilename,
          size: stat.size,
          localPath: finalPath
        });
      } catch (err) {
        console.warn(`[DeviceApi] Track ${i + 1} failed: ${err.message}`);
      }
    }

    if (!files.length) {
      throw new Error('Could not download any tracks from this album.');
    }

    job.files = files;
    job.status = 'ready';
    job.phase = 'Ready';
    job.percent = 100;
  } catch (err) {
    console.error(`[DeviceApi] Album download failed for ${job.id}:`, err);
    job.status = 'error';
    job.phase = 'Failed';
    job.error = err.message || 'Album download failed';
  }
}

/** Background processor for audiobook download */
async function processAudiobookJob(job) {
  try {
    job.status = 'downloading';
    job.phase = 'Resolving audiobook';
    job.percent = 10;

    let { postUrl, infoHash, title, author } = job.meta;

    if (postUrl && !infoHash) {
      const detail = await abbClient.fetchDetail(postUrl);
      if (detail) {
        infoHash = detail.infoHash || infoHash;
        title = detail.title || title;
        author = detail.author || author;
      }
    }

    if (!infoHash) {
      throw new Error('AudioBookBay info hash could not be resolved.');
    }

    const magnet = `magnet:?xt=urn:btih:${infoHash}`;
    job.phase = 'Connecting to torrent node';
    job.percent = 20;

    // Contact torrent node to stream the audiobook files
    const targetUrl = `${config.torrent.nodeUrl.replace(/\/+$/, '')}/api/torrent/stream`;
    const res = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: magnet })
    });

    if (!res.ok) {
      throw new Error(`Torrent node failed to resolve torrent (HTTP ${res.status})`);
    }

    const streamData = await res.json();
    const torrentFiles = streamData.files || [];
    const audioFiles = torrentFiles.filter((f) => /\.(mp3|m4b|m4a|aac|flac)$/i.test(f.name));

    if (!audioFiles.length) {
      throw new Error('No audio files found in this torrent.');
    }

    const authorName = safePart(author, 'Unknown Author');
    const bookTitle = safePart(title, 'Audiobook');

    const files = [];
    const baseNodeUrl = config.torrent.nodeUrl.replace(/\/+$/, '');

    for (let i = 0; i < audioFiles.length; i++) {
      const af = audioFiles[i];
      job.phase = `Downloading ${i + 1}/${audioFiles.length}: ${af.name}`;
      job.percent = Math.round(25 + (i / audioFiles.length) * 70);

      const fileUrl = `${baseNodeUrl}/api/torrent/serve/${streamData.streamId}/${af.index}`;
      const fileRes = await fetch(fileUrl);
      if (!fileRes.ok) {
        throw new Error(`Failed to stream file from node: ${fileRes.status}`);
      }

      const cleanName = safePart(af.name);
      const localPath = path.join(job.stagingDir, cleanName);
      const dest = fs.createWriteStream(localPath);
      await new Promise((resolve, reject) => {
        const stream = fileRes.body;
        // Node 18+ web stream to node stream conversion
        const reader = stream.getReader();
        function pump() {
          reader.read().then(({ done, value }) => {
            if (done) {
              dest.end();
              resolve();
              return;
            }
            dest.write(Buffer.from(value));
            pump();
          }).catch(reject);
        }
        pump();
      });

      const stat = fs.statSync(localPath);
      files.push({
        index: i,
        path: `Audiobook/${authorName}/${bookTitle}/${cleanName}`,
        filename: cleanName,
        size: stat.size,
        localPath
      });
    }

    job.files = files;
    job.status = 'ready';
    job.phase = 'Ready';
    job.percent = 100;
  } catch (err) {
    console.error(`[DeviceApi] Audiobook download failed for ${job.id}:`, err);
    job.status = 'error';
    job.phase = 'Failed';
    job.error = err.message || 'Audiobook download failed';
  }
}

function decodeXml(str = '') {
  return String(str)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&#x0*27;/gi, "'")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/<[^>]+>/g, '')
    .trim();
}

/** Background processor for podcast episode download */
async function processPodcastJob(job) {
  try {
    job.status = 'downloading';
    job.phase = 'Downloading episode';
    job.percent = 10;

    const { audioUrl, title, show } = job.meta;
    const res = await fetch(audioUrl, {
      headers: { 'User-Agent': 'FRAUDIO/1.0' },
      redirect: 'follow'
    });
    if (!res.ok) {
      throw new Error(`Podcast feed returned HTTP ${res.status}`);
    }

    const contentType = String(res.headers.get('content-type') || '').toLowerCase();
    let ext = 'mp3';
    if (contentType.includes('mp4') || contentType.includes('m4a') || /\.m4a(\?|$)/i.test(audioUrl)) ext = 'm4a';
    else if (contentType.includes('aac') || /\.aac(\?|$)/i.test(audioUrl)) ext = 'aac';
    else if (contentType.includes('ogg') || /\.ogg(\?|$)/i.test(audioUrl)) ext = 'ogg';

    const showName = safePart(show, 'Podcasts');
    const cleanTitle = safePart(title || 'Episode');
    const finalFilename = `${cleanTitle}.${ext}`;
    const localPath = path.join(job.stagingDir, finalFilename);

    const totalBytes = Number(res.headers.get('content-length')) || 0;
    let receivedBytes = 0;

    const dest = fs.createWriteStream(localPath);
    await new Promise((resolve, reject) => {
      const reader = res.body.getReader();
      function pump() {
        reader.read().then(({ done, value }) => {
          if (done) {
            dest.end();
            resolve();
            return;
          }
          const buf = Buffer.from(value);
          dest.write(buf);
          receivedBytes += buf.length;
          if (totalBytes > 0) {
            job.percent = Math.min(95, Math.round(10 + (receivedBytes / totalBytes) * 85));
          }
          pump();
        }).catch(reject);
      }
      pump();
    });

    const stat = fs.statSync(localPath);
    job.files = [
      {
        index: 0,
        path: `Podcast/${showName}/${finalFilename}`,
        filename: finalFilename,
        size: stat.size,
        localPath
      }
    ];
    job.status = 'ready';
    job.phase = 'Ready';
    job.percent = 100;
  } catch (err) {
    console.error(`[DeviceApi] Podcast download failed for ${job.id}:`, err);
    job.status = 'error';
    job.phase = 'Failed';
    job.error = err.message || 'Podcast download failed';
  }
}

/** Mount device routes into Express app */
export function registerDeviceRoutes(app) {
  // 1. Ping
  app.get('/api/device/ping', (req, res) => {
    res.json({
      ok: true,
      name: 'FRAUDIO',
      version: '0.1.3',
      serverTime: Date.now()
    });
  });

  // -------------------------------------------------------------------------
  // Device Pairing & Connect UI
  // -------------------------------------------------------------------------

  // Web page: music.butfree.online/device
  app.get('/device', (req, res) => {
    const deviceCode = String(req.query.code || '').trim().toUpperCase();
    const user = req.user;

    let loginUrl = '#';
    if (!user) {
      try {
        const dest = '/device' + (deviceCode ? `?code=${encodeURIComponent(deviceCode)}` : '');
        loginUrl = googleAuth.getAuthUrl(req, `redirect:${dest}`);
      } catch (err) {
        loginUrl = `/?auth_error=${encodeURIComponent(err.message)}`;
      }
    }

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>FRAUDIO - Connect Device</title>
  <link rel="icon" type="image/svg+xml" href="/vite.svg" />
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      background: #0E1119;
      color: #E7EAF0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      background: #141824;
      border: 1px solid #1F263B;
      border-radius: 20px;
      padding: 40px 32px;
      max-width: 440px;
      width: 100%;
      text-align: center;
      box-shadow: 0 20px 40px rgba(0,0,0,0.5);
    }
    .logo-badge {
      width: 64px;
      height: 64px;
      background: #1B2033;
      border: 2px solid #3DDC97;
      border-radius: 18px;
      margin: 0 auto 20px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .logo-badge svg {
      width: 32px;
      height: 32px;
      fill: none;
      stroke: #3DDC97;
      stroke-width: 2.5;
    }
    h1 {
      font-size: 24px;
      font-weight: 700;
      color: #FFFFFF;
      margin-bottom: 8px;
      letter-spacing: -0.5px;
    }
    .subtitle {
      color: #8C96AD;
      font-size: 14px;
      line-height: 1.5;
      margin-bottom: 24px;
    }
    .user-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: #1B2236;
      border: 1px solid #28334E;
      border-radius: 30px;
      padding: 6px 14px;
      font-size: 13px;
      color: #3DDC97;
      margin-bottom: 24px;
    }
    .code-input-wrap {
      margin-bottom: 20px;
    }
    input.code-input {
      width: 100%;
      padding: 14px 16px;
      background: #0B0E15;
      border: 2px solid #28334E;
      border-radius: 12px;
      color: #FFFFFF;
      font-size: 32px;
      text-align: center;
      letter-spacing: 12px;
      text-transform: uppercase;
      font-weight: 700;
      outline: none;
      transition: all 0.2s;
    }
    input.code-input:focus {
      border-color: #3DDC97;
      box-shadow: 0 0 0 3px rgba(61, 220, 151, 0.2);
    }
    input.code-input::placeholder {
      color: #2F3B56;
      letter-spacing: 8px;
    }
    .btn {
      width: 100%;
      padding: 14px;
      border: none;
      border-radius: 12px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
    }
    .btn-primary {
      background: #3DDC97;
      color: #0E1119;
    }
    .btn-primary:hover {
      background: #4ae8a3;
      transform: translateY(-1px);
    }
    .btn-primary:disabled {
      background: #252D3F;
      color: #5A6682;
      cursor: not-allowed;
      transform: none;
    }
    .btn-google {
      background: #FFFFFF;
      color: #1F2937;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    }
    .btn-google:hover {
      background: #F3F4F6;
    }
    .btn-google svg {
      width: 20px;
      height: 20px;
    }
    .msg-box {
      margin-top: 18px;
      font-size: 14px;
      border-radius: 10px;
      padding: 12px;
      display: none;
    }
    .msg-box.error {
      background: rgba(239, 68, 68, 0.12);
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: #F87171;
    }
    .msg-box.success {
      background: rgba(61, 220, 151, 0.12);
      border: 1px solid rgba(61, 220, 151, 0.3);
      color: #3DDC97;
    }
    .success-panel {
      display: none;
    }
    .success-icon {
      width: 72px;
      height: 72px;
      border-radius: 50%;
      background: rgba(61, 220, 151, 0.15);
      border: 2px solid #3DDC97;
      margin: 0 auto 20px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .success-icon svg {
      width: 36px;
      height: 36px;
      stroke: #3DDC97;
      stroke-width: 3;
      fill: none;
    }
  </style>
</head>
<body>
  <div class="card">
    <div id="pairView">
      <div class="logo-badge">
        <svg viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="10"></circle>
          <polygon points="10 8 16 12 10 16 10 8" fill="#3DDC97"></polygon>
        </svg>
      </div>
      <h1>Connect Player</h1>
      ${user ? `
        <div class="user-pill">
          <span>●</span>
          <span>${user.email || user.name || 'Signed In'}</span>
        </div>
        <p class="subtitle">Enter the 4-character code shown on your portable player to link your Google Drive audio library.</p>
        <div class="code-input-wrap">
          <input id="codeInput" class="code-input" maxlength="4" placeholder="----" autofocus autocomplete="off" spellcheck="false" value="${deviceCode}">
        </div>
        <button id="pairBtn" class="btn btn-primary">Pair Device</button>
        <div id="msgBox" class="msg-box"></div>
      ` : `
        <p class="subtitle">Sign in with Google to connect your portable player to your personal Google Drive audio library.</p>
        <a href="${loginUrl}" class="btn btn-google">
          <svg viewBox="0 0 24 24">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/>
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/>
          </svg>
          Sign in with Google
        </a>
      `}
    </div>

    <div id="successView" class="success-panel">
      <div class="success-icon">
        <svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg>
      </div>
      <h1>Device Connected!</h1>
      <p class="subtitle" id="successDesc">Your portable player is now linked to your Google Drive library. You can now sync your Music and Audiobooks directly on the player.</p>
    </div>
  </div>

  ${user ? `
  <script>
    const input = document.getElementById('codeInput');
    const btn = document.getElementById('pairBtn');
    const msg = document.getElementById('msgBox');
    const pairView = document.getElementById('pairView');
    const successView = document.getElementById('successView');

    function showError(text) {
      msg.className = 'msg-box error';
      msg.textContent = text;
      msg.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Pair Device';
    }

    async function submitPair() {
      const code = (input.value || '').trim().toUpperCase();
      if (!code || code.length < 4) {
        showError('Please enter a valid 4-character code.');
        input.focus();
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Connecting…';
      msg.style.display = 'none';

      try {
        const res = await fetch('/api/device/pair/confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code })
        });
        let data = null;
        try {
          data = await res.json();
        } catch {
          showError('Server returned an unexpected error (' + res.status + '). Please try again.');
          return;
        }
        if (data && data.ok) {
          pairView.style.display = 'none';
          successView.style.display = 'block';
        } else {
          showError((data && data.error) || 'Pairing failed. The code may have expired.');
        }
      } catch (err) {
        showError('Network error connecting to server: ' + (err.message || ''));
      }
    }

    btn.addEventListener('click', submitPair);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitPair();
    });
    input.addEventListener('input', () => {
      input.value = input.value.toUpperCase();
      if (input.value.length === 4) {
        submitPair();
      }
    });
  </script>
  ` : ''}
</body>
</html>`;

    res.type('html').send(html);
  });

  // 1a. Generate pairing code (called by DAP device)
  app.get('/api/device/pair/code', (req, res) => {
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
    res.json({
      ok: true,
      code,
      expiresIn: 300,
      pairUrl: 'https://music.butfree.online/device'
    });
  });

  // 1b. Poll pairing status (called by DAP device)
  app.get('/api/device/pair/status/:code', (req, res) => {
    devicePairingStore = loadPairingStore();
    const code = String(req.params.code || '').toUpperCase();
    const entry = devicePairingStore[code];

    if (!entry) {
      return res.json({ ok: false, status: 'expired' });
    }
    if (Date.now() - entry.createdAt > 5 * 60 * 1000) {
      delete devicePairingStore[code];
      savePairingStore(devicePairingStore);
      return res.json({ ok: false, status: 'expired' });
    }
    if (!entry.completed || !entry.token) {
      return res.json({ ok: true, status: 'pending' });
    }

    // Hand over token and delete code
    const payload = {
      ok: true,
      status: 'complete',
      token: entry.token,
      user: {
        id: entry.userId,
        email: entry.email || '',
        name: entry.name || ''
      }
    };
    delete devicePairingStore[code];
    savePairingStore(devicePairingStore);
    return res.json(payload);
  });

  // 1c. Confirm pairing code (called by web page after user signs in)
  app.post('/api/device/pair/confirm', (req, res) => {
    try {
      if (!req.user) {
        return res.status(401).json({ ok: false, error: 'Sign in with Google first.' });
      }

      devicePairingStore = loadPairingStore();
      cleanupPairingStore();
      const code = String(req.body?.code || '').trim().toUpperCase();
      const entry = devicePairingStore[code];

      if (!entry) {
        return res.status(400).json({ ok: false, error: 'Pairing code not found or expired. Please check your screen.' });
      }
      if (Date.now() - entry.createdAt > 5 * 60 * 1000) {
        delete devicePairingStore[code];
        savePairingStore(devicePairingStore);
        return res.status(400).json({ ok: false, error: 'Code expired. Please request a new code on your device.' });
      }

      // Generate compact 10-year device token
      const token = createDeviceToken(req.user, 10 * 365 * 24 * 60 * 60 * 1000);
      entry.completed = true;
      entry.userId = req.user.id;
      entry.token = token;
      entry.email = req.user.email;
      entry.name = req.user.name;
      savePairingStore(devicePairingStore);

      return res.json({
        ok: true,
        email: req.user.email,
        name: req.user.name
      });
    } catch (err) {
      console.error('[DeviceApi] Error in /api/device/pair/confirm:', err);
      return res.status(500).json({ ok: false, error: err.message || 'Server error' });
    }
  });

  // -------------------------------------------------------------------------
  // Google Drive Device Sync Endpoints (requires device token)
  // -------------------------------------------------------------------------

  // Check device auth & Drive sync status
  app.get('/api/device/drive/status', (req, res) => {
    try {
      const user = authenticateDevice(req);
      if (!user) {
        return res.status(401).json({ ok: false, error: 'Unauthorized device. Please re-pair in Settings.' });
      }

      const tracks = db.getUserItems(user.id, 'track') || [];
      const audiobooks = db.getUserItems(user.id, 'audiobook') || [];

      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.json({
        ok: true,
        connected: true,
        user: {
          id: user.id,
          email: user.email || '',
          name: user.name || '',
          musicFolder: user.musicFolderName || null,
          audiobooksFolder: user.audiobooksFolderName || null
        },
        counts: {
          tracks: tracks.length,
          audiobooks: audiobooks.length
        }
      });
    } catch (err) {
      console.error('[DeviceApi] Error in /api/device/drive/status:', err);
      return res.status(500).json({ ok: false, error: err.message || 'Server error' });
    }
  });

  // Get full Drive library catalog for syncing
  app.get('/api/device/drive/library', (req, res) => {
    try {
      const user = authenticateDevice(req);
      if (!user) {
        return res.status(401).json({ ok: false, error: 'Unauthorized device. Please re-pair in Settings.' });
      }

      const kind = String(req.query.kind || '').toLowerCase();
      const limitParam = req.query.limit;
      const limit = (limitParam === 'all' || !limitParam)
        ? 10000
        : Math.min(Math.max(parseInt(limitParam, 10) || 5000, 1), 10000);
      let tracks = [];
      let audiobooks = [];

      const rawTracks = (kind !== 'audiobooks' && kind !== 'audiobook')
        ? (db.getUserItems(user.id, 'track') || [])
        : [];
      const rawBooks = (kind !== 'music' && kind !== 'songs')
        ? (db.getUserItems(user.id, 'audiobook') || [])
        : [];
      const rawPlaylists = (kind !== 'audiobooks' && kind !== 'audiobook')
        ? (db.getPlaylists(user.id, 'music') || [])
        : [];

      tracks = rawTracks.slice(0, limit).map((t) => {
        const artist = safePart(t.artist || 'Unknown Artist');
        const album = safePart(t.album || 'Unknown Album');
        const filename = t.fileName || `${safePart(t.title || 'Track')}.mp3`;
        return {
          id: String(t.id || ''),
          title: String(t.title || 'Untitled').replace(/[\x00-\x1F\x7F]/g, ' ').trim(),
          artist: String(t.artist || '').replace(/[\x00-\x1F\x7F]/g, ' ').trim(),
          album: String(t.album || '').replace(/[\x00-\x1F\x7F]/g, ' ').trim(),
          size: Number(t.sizeBytes) || 0,
          filename,
          path: `Music/${artist}/${album}/${filename}`,
          googleFileId: t.googleFileId || null
        };
      });

      audiobooks = rawBooks.slice(0, limit).map((b) => {
        const author = safePart(b.author || 'Unknown Author');
        const series = b.series ? safePart(b.series) : null;
        const filename = b.fileName || `${safePart(b.title || 'Audiobook')}.m4b`;
        const dir = series ? `Audiobook/${author}/${series}` : `Audiobook/${author}`;
        return {
          id: String(b.id || ''),
          title: String(b.title || 'Untitled').replace(/[\x00-\x1F\x7F]/g, ' ').trim(),
          author: String(b.author || '').replace(/[\x00-\x1F\x7F]/g, ' ').trim(),
          series: String(b.series || '').replace(/[\x00-\x1F\x7F]/g, ' ').trim(),
          narrator: String(b.narrator || '').replace(/[\x00-\x1F\x7F]/g, ' ').trim(),
          size: Number(b.sizeBytes) || 0,
          filename,
          path: `${dir}/${filename}`,
          googleFileId: b.googleFileId || null
        };
      });

      const playlists = rawPlaylists.map((p) => {
        const full = db.getPlaylist(user.id, p.id);
        const safeName = safePart(p.name || 'Playlist');
        return {
          id: String(p.id),
          name: String(p.name || 'Untitled'),
          count: full?.itemIds?.length || p.count || 0,
          filename: `${safeName}.m3u8`,
          path: `Music/FRAUDIO/${safeName}.m3u8`,
          updatedAt: p.updatedAt
        };
      });

      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.json({
        ok: true,
        counts: {
          tracks: rawTracks.length,
          audiobooks: rawBooks.length,
          playlists: playlists.length
        },
        tracks,
        audiobooks,
        playlists
      });
    } catch (err) {
      console.error('[DeviceApi] Error in /api/device/drive/library:', err);
      return res.status(500).json({ ok: false, error: err.message || 'Server error' });
    }
  });

  // Get music playlists for paired device
  app.get('/api/device/drive/playlists', (req, res) => {
    try {
      const user = authenticateDevice(req);
      if (!user) return res.status(401).json({ ok: false, error: 'Unauthorized device' });
      const playlists = db.getPlaylists(user.id, 'music').map((p) => {
        const full = db.getPlaylist(user.id, p.id);
        const safeName = safePart(p.name || 'Playlist');
        return {
          id: String(p.id),
          name: String(p.name || 'Untitled'),
          count: full?.itemIds?.length || p.count || 0,
          filename: `${safeName}.m3u8`,
          path: `Music/FRAUDIO/${safeName}.m3u8`,
          updatedAt: p.updatedAt
        };
      });
      return res.json({ ok: true, playlists });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Get details and tracks for a single playlist
  app.get('/api/device/drive/playlists/:id', (req, res) => {
    try {
      const user = authenticateDevice(req);
      if (!user) return res.status(401).json({ ok: false, error: 'Unauthorized device' });
      const playlist = db.getPlaylist(user.id, req.params.id);
      if (!playlist) return res.status(404).json({ ok: false, error: 'Playlist not found' });
      const allTracks = db.getUserItems(user.id, 'track');
      const byId = new Map(allTracks.map((t) => [t.id, t]));
      const tracks = (playlist.itemIds || []).map((id) => byId.get(id)).filter(Boolean).map((t) => {
        const artist = safePart(t.artist || 'Unknown Artist');
        const album = safePart(t.album || 'Unknown Album');
        const filename = t.fileName || `${safePart(t.title || 'Track')}.mp3`;
        return {
          id: String(t.id || ''),
          title: String(t.title || 'Untitled').replace(/[\x00-\x1F\x7F]/g, ' ').trim(),
          artist: String(t.artist || '').replace(/[\x00-\x1F\x7F]/g, ' ').trim(),
          album: String(t.album || '').replace(/[\x00-\x1F\x7F]/g, ' ').trim(),
          size: Number(t.sizeBytes) || 0,
          filename,
          path: `Music/${artist}/${album}/${filename}`,
          googleFileId: t.googleFileId || null
        };
      });
      const safeName = safePart(playlist.name || 'Playlist');
      return res.json({
        ok: true,
        playlist: {
          id: playlist.id,
          name: playlist.name,
          count: tracks.length,
          filename: `${safeName}.m3u8`,
          path: `Music/FRAUDIO/${safeName}.m3u8`
        },
        tracks
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Stream raw .m3u8 playlist file to device
  app.get('/api/device/drive/playlists/:id/m3u8', (req, res) => {
    try {
      const user = authenticateDevice(req);
      if (!user) return res.status(401).send('Unauthorized device');
      const playlist = db.getPlaylist(user.id, req.params.id);
      if (!playlist) return res.status(404).send('Playlist not found');
      const allTracks = db.getUserItems(user.id, 'track');
      const byId = new Map(allTracks.map((t) => [t.id, t]));
      const items = (playlist.itemIds || []).map((id) => byId.get(id)).filter(Boolean);
      const m3u = formatPlaylistM3u8(playlist, items);
      const safeName = safePart(playlist.name || 'Playlist');
      res.setHeader('Content-Type', 'audio/x-mpegurl; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeName)}.m3u8"`);
      return res.send(m3u);
    } catch (err) {
      return res.status(500).send(err.message || 'Server error');
    }
  });

  // Download/stream Drive audio file directly to player
  app.get('/api/device/drive/file/:id', async (req, res) => {
    const user = authenticateDevice(req);
    if (!user) {
      return res.status(401).send('Unauthorized device');
    }

    const item = db.getItem(user.id, req.params.id);
    if (!item || !item.googleFileId) {
      return res.status(404).send('Item not found in Google Drive library');
    }

    try {
      const filename = item.fileName || `${item.title || 'file'}.mp3`;
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
      return await googleDrive.streamFile(user, item.googleFileId, req, res);
    } catch (err) {
      console.error(`[DeviceApi] Drive file stream error for ${req.params.id}:`, err);
      if (!res.headersSent) res.status(500).send(err.message || 'Drive stream error');
    }
  });


  // 2. Search
  app.get('/api/device/search', async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      const kind = String(req.query.kind || req.query.type || 'music').toLowerCase();

      if (!q) {
        return res.json({ ok: true, songs: [], albums: [], artists: [], audiobooks: [], podcasts: [] });
      }

      if (kind === 'podcast' || kind === 'podcasts') {
        const itunesUrl = `https://itunes.apple.com/search?media=podcast&entity=podcast&limit=25&term=${encodeURIComponent(q)}`;
        const itRes = await fetch(itunesUrl, { headers: { 'User-Agent': 'FRAUDIO/1.0' } });
        if (!itRes.ok) {
          throw new Error(`Podcast directory returned HTTP ${itRes.status}`);
        }
        const data = await itRes.json();
        const podcasts = (data.results || [])
          .filter((r) => r.feedUrl)
          .slice(0, 25)
          .map((r) => ({
            id: String(r.collectionId || r.feedUrl),
            title: r.collectionName || r.trackName || '',
            author: r.artistName || '',
            feedUrl: r.feedUrl || '',
            episodes: String(r.trackCount || '')
          }));
        return res.json({ ok: true, kind: 'podcast', query: q, podcasts });
      }

      if (kind === 'audiobook' || kind === 'audiobooks') {
        const results = await abbClient.search(q);
        const audiobooks = (results || []).slice(0, 30).map((b) => ({
          id: b.postUrl || b.infoHash || '',
          title: b.title || '',
          author: b.author || '',
          narrator: b.narrator || '',
          infoHash: b.infoHash || '',
          postUrl: b.postUrl || '',
          format: b.format || 'mp3'
        }));
        return res.json({ ok: true, kind: 'audiobook', query: q, audiobooks });
      }

      // Music search via YouTube Music
      const raw = await youtubeMusic.search(q);
      const songs = (raw.songs || []).slice(0, 30).map((s) => ({
        id: s.videoId,
        title: s.title,
        artist: s.artist,
        album: s.album || '',
        duration: s.duration || ''
      }));

      const albums = (raw.albums || []).slice(0, 20).map((a) => ({
        id: a.browseId || a.id || '',
        playlistId: a.playlistId || a.id || '',
        title: a.title,
        artist: a.artist,
        year: a.year || ''
      }));

      const artists = (raw.artists || []).slice(0, 10).map((ar) => ({
        id: ar.channelId || ar.id || '',
        title: ar.title || ar.artist || ''
      }));

      return res.json({
        ok: true,
        kind: 'music',
        query: q,
        songs,
        albums,
        artists
      });
    } catch (err) {
      console.error('[DeviceApi] Search error:', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // 3. Album tracks
  app.get('/api/device/album', async (req, res) => {
    try {
      const id = String(req.query.playlistId || req.query.id || '').trim();
      if (!id) return res.status(400).json({ ok: false, error: 'Missing album or playlist id' });

      const tracks = await youtubeMusic.albumTracks(id);
      return res.json({
        ok: true,
        tracks: (tracks || []).map((t, idx) => ({
          index: t.trackNumber || (idx + 1),
          id: t.videoId,
          title: t.title,
          artist: t.artist,
          duration: t.duration || ''
        }))
      });
    } catch (err) {
      console.error('[DeviceApi] Album tracks error:', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // 4. Artist details
  app.get('/api/device/artist', async (req, res) => {
    try {
      const id = String(req.query.channelId || req.query.id || '').trim();
      if (!id) return res.status(400).json({ ok: false, error: 'Missing channelId' });

      const data = await youtubeMusic.artistBrowse(id);
      return res.json({
        ok: true,
        artist: data.artist || '',
        albums: (data.albums || []).map((a) => ({
          id: a.browseId || a.id || '',
          playlistId: a.playlistId || a.id || '',
          title: a.title,
          year: a.year || ''
        })),
        topSongs: (data.topSongs || []).map((s) => ({
          id: s.videoId,
          title: s.title,
          artist: s.artist,
          duration: s.duration || ''
        }))
      });
    } catch (err) {
      console.error('[DeviceApi] Artist browse error:', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // 4b. Podcast feed episodes
  app.get('/api/device/podcast', async (req, res) => {
    try {
      const feedUrl = String(req.query.feedUrl || '').trim();
      if (!feedUrl) return res.status(400).json({ ok: false, error: 'Missing feedUrl' });

      const feedRes = await fetch(feedUrl, { headers: { 'User-Agent': 'FRAUDIO/1.0' } });
      if (!feedRes.ok) {
        throw new Error(`Feed returned HTTP ${feedRes.status}`);
      }
      const xml = await feedRes.text();
      const channelHeader = xml.split(/<item[\s>]/i)[0] || '';
      const show = decodeXml(channelHeader.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || 'Podcast');
      const author = decodeXml(
        channelHeader.match(/<itunes:author>([\s\S]*?)<\/itunes:author>/i)?.[1]
        || channelHeader.match(/<author>([\s\S]*?)<\/author>/i)?.[1]
        || ''
      );

      const episodes = [];
      for (const m of xml.matchAll(/<item[\s>]([\s\S]*?)<\/item>/gi)) {
        if (episodes.length >= 35) break;
        const itemXml = m[1];
        const audioUrl = itemXml.match(/<enclosure[^>]+url=["']([^"']+)["']/i)?.[1];
        if (!audioUrl) continue;
        const title = decodeXml(itemXml.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || 'Episode');
        const duration = decodeXml(itemXml.match(/<itunes:duration>([\s\S]*?)<\/itunes:duration>/i)?.[1] || '');
        episodes.push({
          id: audioUrl,
          title,
          show,
          author,
          duration,
          audioUrl
        });
      }

      return res.json({ ok: true, show, author, episodes });
    } catch (err) {
      console.error('[DeviceApi] Podcast feed error:', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // 5. Trigger download
  app.post('/api/device/download', (req, res) => {
    try {
      const { type, id, title, artist, album, playlistId, browseId, postUrl, infoHash, audioUrl, show } = req.body || {};
      if (!type) {
        return res.status(400).json({ ok: false, error: 'Missing download type (song, album, audiobook, or podcast)' });
      }

      let job;
      if (type === 'song') {
        const videoId = id || req.body.videoId;
        if (!videoId) return res.status(400).json({ ok: false, error: 'Missing videoId for song download' });
        job = createJob('song', { videoId, title, artist, album });
        processSongJob(job);
      } else if (type === 'album') {
        const pId = playlistId || browseId || id;
        if (!pId) return res.status(400).json({ ok: false, error: 'Missing playlistId for album download' });
        job = createJob('album', { playlistId: pId, browseId, title, artist });
        processAlbumJob(job);
      } else if (type === 'audiobook') {
        if (!postUrl && !infoHash) {
          return res.status(400).json({ ok: false, error: 'Missing postUrl or infoHash for audiobook download' });
        }
        job = createJob('audiobook', { postUrl, infoHash, title, author: req.body.author });
        processAudiobookJob(job);
      } else if (type === 'podcast') {
        const epUrl = audioUrl || id;
        if (!epUrl) {
          return res.status(400).json({ ok: false, error: 'Missing audioUrl for podcast episode download' });
        }
        job = createJob('podcast', { audioUrl: epUrl, title, show: show || artist });
        processPodcastJob(job);
      } else {
        return res.status(400).json({ ok: false, error: `Unsupported type: ${type}` });
      }

      return res.json({
        ok: true,
        jobId: job.id,
        status: job.status,
        phase: job.phase
      });
    } catch (err) {
      console.error('[DeviceApi] Download request error:', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // 6. Job status
  app.get('/api/device/jobs/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) {
      return res.status(404).json({ ok: false, error: 'Job not found' });
    }

    return res.json({
      ok: true,
      id: job.id,
      type: job.type,
      status: job.status,
      phase: job.phase,
      percent: job.percent,
      error: job.error,
      files: job.files.map((f) => ({
        index: f.index,
        path: f.path,
        filename: f.filename,
        size: f.size
      }))
    });
  });

  // 7. Download file from completed job
  app.get('/api/device/jobs/:jobId/file/:fileIndex', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) {
      return res.status(404).send('Job not found');
    }

    const fileIndex = parseInt(req.params.fileIndex, 10);
    const file = job.files.find((f) => f.index === fileIndex);
    if (!file || !file.localPath || !fs.existsSync(file.localPath)) {
      return res.status(404).send('File not found');
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.filename)}"`);
    res.setHeader('Content-Length', file.size);

    const stream = fs.createReadStream(file.localPath);
    stream.pipe(res);
  });

  // 8. Delete / cleanup job
  app.delete('/api/device/jobs/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (job) {
      if (job.stagingDir && fs.existsSync(job.stagingDir)) {
        try { fs.rmSync(job.stagingDir, { recursive: true, force: true }); } catch {}
      }
      jobs.delete(job.id);
    }
    return res.json({ ok: true });
  });
}

export default { registerDeviceRoutes };
