import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

import * as Database from './server/database.js';
import { GoogleAuth } from './server/googleAuth.js';
import { GoogleDrive, cleanGameTitle, searchInternetGameArt, COVERS_DIR } from './server/googleDrive.js';
import { sanitizeFolderName, MAX_PC_REMOTE_TORRENT_BYTES, PC_REMOTE_TORRENT_LIMIT_MSG, parseSizeStringToBytes } from './server/rssDiscovery.js';
import { DownloaderClient, GameDownloaderClient } from './server/downloaderClient.js';
import { registerDiscoverRoutes } from './server/discoverRoutes.js';
import { registerLibraryRoutes } from './server/libraryRoutes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load root monorepo .env with local fallback
const rootEnv = path.resolve(__dirname, '..', '..', '.env');
if (fs.existsSync(rootEnv)) {
  dotenv.config({ path: rootEnv });
}
dotenv.config();

const PORT = parseInt(process.env.PORT_GAMES || process.env.PORT || '5500', 10);

function isAdminUser(user) {
  const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  return !!user && !!adminEmail && String(user.email || '').trim().toLowerCase() === adminEmail;
}

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(GoogleAuth.authMiddleware);

// Request logging
app.use((req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) {
    console.log(`[FREEPLAY] ${req.method} ${req.path}`);
  }
  next();
});

// -------------------------------------------------------------
// Google OAuth Authentication Endpoints
// -------------------------------------------------------------

// API to get Google Auth URL
app.get('/api/auth/google/url', (req, res) => {
  try {
    const url = GoogleAuth.getAuthUrl(req);
    res.json({ success: true, url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Direct browser redirect to Google
app.get('/auth/google', (req, res) => {
  try {
    const url = GoogleAuth.getAuthUrl(req);
    res.redirect(url);
  } catch (err) {
    res.status(500).send(`Authentication configuration error: ${err.message}`);
  }
});

// OAuth entry point used by the butfree landing-page app launcher. This flow
// returns to the landing domain after issuing the usual FREEPLAY session cookie.
app.get('/auth/google/welcome', (req, res) => {
  try {
    const state = crypto.randomBytes(32).toString('hex');
    res.cookie('freeplay_welcome_oauth_state', state, {
      httpOnly: true,
      secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
      sameSite: 'lax',
      maxAge: 10 * 60 * 1000,
      path: '/'
    });
    res.redirect(GoogleAuth.getAuthUrl(req, state));
  } catch (err) {
    res.status(500).send(`Google sign-in could not be started: ${err.message}`);
  }
});

// Google OAuth callback
const handleOAuthCallback = async (req, res) => {
  const { code, error } = req.query;
  const stateCookie = req.cookies?.freeplay_welcome_oauth_state;
  let welcomeFlow = false;

  if (stateCookie) {
    const returnedState = typeof req.query.state === 'string' ? req.query.state : '';
    const expected = Buffer.from(String(stateCookie));
    const actual = Buffer.from(returnedState);
    res.clearCookie('freeplay_welcome_oauth_state', { path: '/' });
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      return res.status(400).send('Google sign-in state validation failed. Please return to butfree.online and try again.');
    }
    welcomeFlow = true;
  }

  const welcomeUrl = (process.env.WELCOME_ORIGIN || 'https://butfree.online').replace(/\/+$/, '');
  if (error || !code) {
    if (welcomeFlow) return res.redirect(`${welcomeUrl}/?auth_status=error`);
    return res.redirect(`/?auth_error=${encodeURIComponent(error || 'Authorization was cancelled')}`);
  }

  try {
    const user = await GoogleAuth.handleCallback(code, req);
    const sessionToken = GoogleAuth.createSessionToken(user);

    // Set HTTP-only session cookie
    res.cookie('freeplay_session', sessionToken, {
      httpOnly: true,
      secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
      sameSite: 'lax',
      maxAge: 30 * 86400 * 1000, // 30 days
      path: '/'
    });

    if (welcomeFlow) return res.redirect(`${welcomeUrl}/?auth_status=connected`);
    res.redirect('/');
  } catch (err) {
    console.error('[FREEPLAY Auth Callback Error]:', err);
    if (welcomeFlow) {
      const status = err.code === 'VIP_ONLY' ? 'vip_only' : 'error';
      return res.redirect(`${welcomeUrl}/?auth_status=${status}`);
    }
    res.redirect(`/?auth_error=${encodeURIComponent(err.message || 'Authentication failed')}`);
  }
};

app.get('/auth/google/callback', handleOAuthCallback);
app.get('/api/auth/google/callback', handleOAuthCallback);

// Get current user profile
app.get('/api/auth/user', (req, res) => {
  if (!req.user) {
    return res.status(401).json({
      authenticated: false,
      user: null,
      ...(req.vipAccessDenied ? { code: 'VIP_ONLY', error: GoogleAuth.vipOnlyMessage } : {})
    });
  }
  res.json({
    authenticated: true,
    user: {
      id: req.user.id,
      name: req.user.name,
      email: req.user.email,
      avatar: req.user.avatar,
      isAdmin: isAdminUser(req.user),
      gamesFolderId: req.user.gamesFolderId,
      gamesFolderName: req.user.gamesFolderName,
      settings: req.user.settings
    }
  });
});

// A strict session check for the cross-subdomain landing-page launcher. Unlike
// the legacy app middleware fallback, this requires a real signed OAuth cookie.
app.get('/api/auth/drive-status', async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ authenticated: false, valid: false });
  }
  const status = await GoogleAuth.checkDriveToken(req.user);
  res.json({ authenticated: true, ...status });
});

app.get('/api/welcome/drive-status', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const user = GoogleAuth.verifySessionToken(req.cookies?.freeplay_session);
  if (!user) return res.status(401).json({ authenticated: false, valid: false });
  const status = await GoogleAuth.checkDriveToken(user);
  res.json({ authenticated: true, ...status });
});

app.get('/api/welcome/session', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const user = GoogleAuth.verifySessionToken(req.cookies?.freeplay_session);
  if (!user) return res.status(401).json({ authenticated: false, user: null });
  if (!GoogleAuth.isVipEmail(user.email)) {
    return res.status(403).json({ authenticated: false, user: null, code: 'VIP_ONLY', error: GoogleAuth.vipOnlyMessage });
  }
  res.json({
    authenticated: true,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      avatar: user.avatar
    }
  });
});

app.post('/api/welcome/logout', (req, res) => {
  res.clearCookie('freeplay_session', { path: '/' });
  res.json({ success: true });
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('freeplay_session');
  res.json({ success: true, message: 'Logged out successfully' });
});

// -------------------------------------------------------------
// Google Drive Folder Selection Endpoints
// -------------------------------------------------------------

// List Google Drive folders
app.get('/api/drive/folders', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const parentId = req.query.parentId || 'root';
    const folders = await GoogleDrive.listFolders(req.user, parentId);
    res.json({ success: true, folders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create folder in Google Drive
app.post('/api/drive/folders', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  const { name, parentId } = req.body || {};
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Folder name is required' });
  }

  try {
    const folder = await GoogleDrive.createFolder(req.user, name.trim(), parentId || 'root');
    res.json({ success: true, folder });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Select Google Drive Games Folder
app.post('/api/drive/select-folder', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  const { folderId, folderName } = req.body || {};
  if (!folderId) {
    return res.status(400).json({ error: 'Missing folderId' });
  }

  try {
    Database.updateUserFolder(req.user.id, folderId, folderName || 'Games');

    // Attempt quick hydration of user games and favorites from Drive if available
    try {
      const userGamesFilename = GoogleDrive.getUserMetaFilename(req.user, 'games.json');
      const gamesFile = (await GoogleDrive.findFileByName(req.user, folderId, userGamesFilename))
                     || (await GoogleDrive.findFileByName(req.user, folderId, 'games.json'));
      if (gamesFile) {
        const gamesData = await GoogleDrive.readJsonFile(req.user, gamesFile.id);
        if (gamesData && Array.isArray(gamesData.games) && gamesData.games.length > 0) {
          Database.saveGames(req.user.id, gamesData.games, 'drive');
        }
      }

      const userFavFilename = GoogleDrive.getUserMetaFilename(req.user, 'favorites.json');
      const favFile = (await GoogleDrive.findFileByName(req.user, folderId, userFavFilename))
                   || (await GoogleDrive.findFileByName(req.user, folderId, 'favorites.json'));
      if (favFile) {
        const favData = await GoogleDrive.readJsonFile(req.user, favFile.id);
        if (favData && Array.isArray(favData.favorites)) {
          Database.setFavorites(req.user.id, favData.favorites);
        }
      }
    } catch (syncErr) {
      console.warn('[Drive Folder Select Sync Warning]:', syncErr.message);
    }

    res.json({ success: true, folderId, folderName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// Games Library & Scanning Endpoints
// -------------------------------------------------------------

// Get user games library
app.get('/api/games', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  const games = Database.getGames(req.user.id);
  // The whole shelf serialises into one response, which makes it the slowest
  // part of a cold start. Hashing it once here is cheaper than re-parsing it on
  // the device, and an unchanged shelf costs a bodiless 304 instead of the full
  // listing. The explicit ETag also stops Express hashing the body again.
  const body = JSON.stringify({ success: true, count: games.length, games });
  const etag = `"${crypto.createHash('sha1').update(body).digest('base64url')}"`;
  res.set('ETag', etag);
  // "no-cache" still stores the response - it just insists on revalidating.
  res.set('Cache-Control', 'private, no-cache');
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  return res.type('application/json').send(body);
});

// Scan state tracker to support non-blocking background scans and prevent proxy timeouts
const activeScanJobs = new Map(); // userId -> { running, startedAt, finishedAt, result, error }

// Scan status endpoint
app.get('/api/games/scan/status', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const job = activeScanJobs.get(req.user.id);
  res.json({
    scanning: !!job?.running,
    finishedAt: job?.finishedAt || null,
    error: job?.error || null,
    count: job?.result?.count || null
  });
});

// Scan Google Drive Games folder
app.post('/api/games/scan', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  // If a scan is already running for this user, inform client to poll
  const existingJob = activeScanJobs.get(req.user.id);
  if (existingJob && existingJob.running) {
    return res.json({ success: true, scanning: true, inProgress: true });
  }

  // Create job tracker
  const job = {
    running: true,
    startedAt: Date.now(),
    finishedAt: null,
    result: null,
    error: null
  };
  activeScanJobs.set(req.user.id, job);

  const scanPromise = GoogleDrive.scanGamesFolder(req.user)
    .then((result) => {
      job.running = false;
      job.finishedAt = Date.now();
      job.result = result;
      job.error = null;
      return result;
    })
    .catch((err) => {
      console.error('[FREEPLAY Scan Error]:', err);
      job.running = false;
      job.finishedAt = Date.now();
      job.error = err.message;
      throw err;
    });

  // Race scan completion against an 8-second threshold to guarantee response before proxy timeout
  try {
    const fastResult = await Promise.race([
      scanPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('SCAN_BACKGROUNDED')), 8000))
    ]);
    return res.json({ success: true, scanning: false, ...fastResult });
  } catch (raceErr) {
    if (raceErr.message === 'SCAN_BACKGROUNDED') {
      // Scan is running cleanly in background on Node.js; client polls /api/games/scan/status
      return res.json({ success: true, scanning: true, inBackground: true });
    }
    return res.status(500).json({ error: raceErr.message });
  }
});

// Toggle Favorite
app.post('/api/games/:id/favorite', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  const gameId = req.params.id;
  const isFavorite = Database.toggleFavorite(req.user.id, gameId);

  // Sync favorites to user's favorites JSON in games folder on Google Drive
  if (req.user.gamesFolderId) {
    try {
      const favs = Database.getFavorites(req.user.id);
      const favFilename = GoogleDrive.getUserMetaFilename(req.user, 'favorites.json');
      await GoogleDrive.writeJsonFile(req.user, req.user.gamesFolderId, favFilename, {
        version: 1,
        updatedAt: Date.now(),
        favorites: favs
      });
    } catch (err) {
      console.warn('[Favorites Sync Error]:', err.message);
    }
  }

  res.json({ success: true, gameId, isFavorite });
});

// Optimized 256x256 PNG Game Poster Endpoint (cached locally from user's Google Drive)
app.get('/api/games/poster/:driveId', async (req, res) => {
  const { driveId } = req.params;
  const safeId = String(driveId).replace(/[^a-zA-Z0-9_-]/g, '_');
  const cachePath = path.join(COVERS_DIR, `drive_${safeId}.png`);

  // 1. If cached on disk as 256x256 PNG, serve immediately!
  if (fs.existsSync(cachePath)) {
    try {
      const stat = fs.statSync(cachePath);
      if (stat.size > 200) {
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
        return res.sendFile(cachePath);
      }
    } catch (_) {}
  }

  // 2. If not cached yet, download from Google Drive, resize to 256x256 PNG, save, and serve
  if (req.user) {
    try {
      const cached = await GoogleDrive.cacheDrivePoster(req.user, driveId);
      if (cached && fs.existsSync(cached)) {
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
        return res.sendFile(cached);
      }
    } catch (err) {
      console.warn(`[Poster Art] Failed to cache Drive poster ${driveId}:`, err.message);
    }

    // 3. Fallback: stream through GoogleDrive.streamFile
    try {
      return await GoogleDrive.streamFile(req.user, driveId, req, res);
    } catch (_) {}
  }

  res.setHeader('Content-Type', 'image/svg+xml');
  return res.status(404).send('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
});

app.head('/api/games/poster/:driveId', (req, res) => {
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
  return res.status(200).end();
});

// Stream any file from Google Drive directly (posters, ROMs, etc.)
app.get('/api/drive/file/:driveId', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { driveId } = req.params;
  const safeId = String(driveId).replace(/[^a-zA-Z0-9_-]/g, '_');
  const cachedPosterPath = path.join(COVERS_DIR, `drive_${safeId}.png`);

  // Fast-path: if this Drive file is a cached 256x256 PNG poster, serve instantly from disk!
  if (fs.existsSync(cachedPosterPath)) {
    try {
      const stat = fs.statSync(cachedPosterPath);
      if (stat.size > 200) {
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
        return res.sendFile(cachedPosterPath);
      }
    } catch (_) {}
  }

  try {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    await GoogleDrive.streamFile(req.user, req.params.driveId, req, res);
  } catch (err) {
    console.warn('[Drive File Stream Error]:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// Dynamic Game Cover Art Endpoint (on-demand art resolution with in-memory and disk caching)
if (!fs.existsSync(COVERS_DIR)) {
  try {
    fs.mkdirSync(COVERS_DIR, { recursive: true });
  } catch (_) {}
}
const coverBufferCache = new Map();

function generatePlaceholderSvg(title, consoleKey) {
  const cleanTitle = (title || 'Game')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const canonKey = String(consoleKey || 'ROM').toLowerCase().trim();
  const cBadge = canonKey.toUpperCase();

  // Thematic background gradients per console family
  let gradStart = '#18181b';
  let gradEnd = '#27272a';
  let accent = '#31a8ff';
  if (canonKey === 'switch') {
    gradStart = '#4a0808'; gradEnd = '#1a0505'; accent = '#e60012';
  } else if (canonKey === 'ps2') {
    gradStart = '#071b38'; gradEnd = '#050c18'; accent = '#0055ff';
  } else if (canonKey === 'psx' || canonKey === 'ps1') {
    gradStart = '#122544'; gradEnd = '#0b1424'; accent = '#003791';
  } else if (canonKey === 'psp') {
    gradStart = '#062638'; gradEnd = '#06131c'; accent = '#00a2ff';
  } else if (canonKey === 'pc') {
    gradStart = '#2b123d'; gradEnd = '#0f0817'; accent = '#a855f7';
  } else if (canonKey === 'snes' || canonKey === 'gba') {
    gradStart = '#241242'; gradEnd = '#0c0717'; accent = '#8b5cf6';
  } else if (canonKey === 'n64' || canonKey === 'gamecube') {
    gradStart = '#0a2e1d'; gradEnd = '#05140c'; accent = '#10b981';
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400" viewBox="0 0 300 400" fill="none">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="300" y2="400" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="${gradStart}"/>
        <stop offset="100%" stop-color="${gradEnd}"/>
      </linearGradient>
      <linearGradient id="overlay" x1="0" y1="0" x2="0" y2="400" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#ffffff" stop-opacity="0.08"/>
        <stop offset="50%" stop-color="#000000" stop-opacity="0"/>
        <stop offset="100%" stop-color="#000000" stop-opacity="0.65"/>
      </linearGradient>
    </defs>
    <rect width="300" height="400" rx="8" fill="url(#bg)"/>
    <rect width="300" height="400" rx="8" fill="url(#overlay)"/>
    <rect x="2" y="2" width="296" height="396" rx="6" stroke="${accent}" stroke-opacity="0.3" stroke-width="2"/>
    
    <!-- Console Banner -->
    <rect x="12" y="16" width="276" height="28" rx="4" fill="#000000" fill-opacity="0.6"/>
    <text x="150" y="35" font-family="system-ui, -apple-system, sans-serif" font-size="11" font-weight="800" fill="${accent}" letter-spacing="2" text-anchor="middle">${cBadge}</text>

    <!-- Art Centerpiece Icon -->
    <circle cx="150" cy="180" r="54" fill="#000000" fill-opacity="0.4"/>
    <circle cx="150" cy="180" r="50" stroke="${accent}" stroke-width="2" stroke-opacity="0.5"/>
    <path d="M132 175h36M150 157v36" stroke="#ffffff" stroke-width="5" stroke-linecap="round"/>
    <circle cx="132" cy="195" r="4" fill="${accent}"/>
    <circle cx="168" cy="195" r="4" fill="${accent}"/>

    <!-- Title and Footer -->
    <rect x="12" y="300" width="276" height="84" rx="6" fill="#000000" fill-opacity="0.75"/>
    <text x="150" y="336" font-family="system-ui, -apple-system, sans-serif" font-size="15" font-weight="800" fill="#ffffff" text-anchor="middle">${cleanTitle.slice(0, 22)}</text>
    ${cleanTitle.length > 22 ? `<text x="150" y="356" font-family="system-ui, -apple-system, sans-serif" font-size="12" font-weight="600" fill="#a1a1aa" text-anchor="middle">${cleanTitle.slice(22, 44)}</text>` : ''}
    <text x="150" y="374" font-family="system-ui, -apple-system, sans-serif" font-size="9" font-weight="700" fill="${accent}" letter-spacing="1.5" text-anchor="middle">AUTHENTIC ASSET</text>
  </svg>`;
}

app.get('/api/games/cover', async (req, res) => {
  const { title, console: consoleKey, raw } = req.query;
  if (!title || typeof title !== 'string') {
    res.setHeader('Content-Type', 'image/svg+xml');
    return res.status(400).send('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
  }

  const clean = cleanGameTitle(title, false);
  const safeFilename = `${String(consoleKey || 'gen').toLowerCase()}_${clean.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}`;
  const diskPathJpg = path.join(COVERS_DIR, `${safeFilename}.jpg`);
  const diskPathPng = path.join(COVERS_DIR, `${safeFilename}.png`);

  // 1. Check in-memory cache
  const cacheKey = `${String(consoleKey || '').toLowerCase()}:${clean.toLowerCase()}`;
  if (coverBufferCache.has(cacheKey)) {
    const item = coverBufferCache.get(cacheKey);
    res.setHeader('Content-Type', item.contentType);
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    return res.send(item.buffer);
  }

  // 2. Check disk cache
  if (fs.existsSync(diskPathJpg)) {
    try {
      const buf = fs.readFileSync(diskPathJpg);
      coverBufferCache.set(cacheKey, { buffer: buf, contentType: 'image/jpeg' });
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
      return res.send(buf);
    } catch (_) {}
  }
  if (fs.existsSync(diskPathPng)) {
    try {
      const buf = fs.readFileSync(diskPathPng);
      coverBufferCache.set(cacheKey, { buffer: buf, contentType: 'image/png' });
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
      return res.send(buf);
    } catch (_) {}
  }

  // 3. Search and fetch internet game art directly on the server (never 302 redirect!)
  try {
    const netArt = await searchInternetGameArt(clean, consoleKey, raw || '');
    if (netArt) {
      let buf = netArt.buffer;
      let mime = netArt.mime || 'image/jpeg';

      if (!buf && netArt.sourceUrl) {
        try {
          const upstream = await fetch(netArt.sourceUrl, {
            headers: {
              'User-Agent': 'FREEPLAY/1.0 (https://games.butfree.online; contact@butfree.online) Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
              'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
              'Referer': new URL(netArt.sourceUrl).origin + '/'
            },
            signal: AbortSignal.timeout(8000)
          });
          if (upstream.ok) {
            buf = Buffer.from(await upstream.arrayBuffer());
            mime = upstream.headers.get('content-type') || mime;
          }
        } catch (fetchErr) {
          console.warn(`[Cover Art] Failed to download image from ${netArt.sourceUrl}:`, fetchErr.message);
        }
      }

      if (buf && buf.length > 500) {
        let outBuf = buf;
        let outMime = 'image/png';
        try {
          const sharp = await import('sharp').then(m => m.default || m).catch(() => null);
          if (sharp) {
            outBuf = await sharp(buf, { failOn: 'none', animated: false })
              .resize(256, 256, { fit: 'cover', position: 'center' })
              .png({ compressionLevel: 8 })
              .toBuffer();
          }
        } catch (_) {}

        const savePath = path.join(COVERS_DIR, `${safeFilename}.png`);
        fs.promises.writeFile(savePath, outBuf).catch(() => {});
        coverBufferCache.set(cacheKey, { buffer: outBuf, contentType: outMime });
        res.setHeader('Content-Type', outMime);
        res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
        return res.send(outBuf);
      }
    }
  } catch (err) {
    console.warn(`[Cover Art] Lookup error for "${title}":`, err.message);
  }

  // 4. Return branded styled SVG poster
  const svg = generatePlaceholderSvg(clean, consoleKey);
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  return res.send(svg);
});

app.head('/api/games/cover', (req, res) => {
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
  return res.status(200).end();
});

// Proxy cached / remote game poster image securely
app.get(['/api/proxy-image', '/api/proxy-media'], async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl || typeof targetUrl !== 'string' || !targetUrl.startsWith('http')) {
    return res.status(400).send('Invalid image URL');
  }
  try {
    let parsedOrigin = '';
    try {
      parsedOrigin = new URL(targetUrl).origin;
    } catch (_) {}

    const upstream = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'FREEPLAY/1.0 (https://games.butfree.online; contact@butfree.online) Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Referer': parsedOrigin ? `${parsedOrigin}/` : 'https://google.com/',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
      },
      signal: AbortSignal.timeout(8000)
    });
    if (!upstream.ok) return res.status(upstream.status).send('Upstream image error');
    const contentType = upstream.headers.get('content-type') || 'image/jpeg';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    const buf = Buffer.from(await upstream.arrayBuffer());
    return res.send(buf);
  } catch (err) {
    return res.status(502).send(err.message);
  }
});

// Stream game ROM to in-browser emulator with HTTP range requests
app.get(['/api/games/stream/:driveId', '/api/games/stream/:driveId/:filename'], async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  const { driveId } = req.params;
  try {
    await GoogleDrive.streamFile(req.user, driveId, req, res);
  } catch (err) {
    console.error('[FREEPLAY Stream Error]:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.head(['/api/games/stream/:driveId', '/api/games/stream/:driveId/:filename'], async (req, res) => {
  if (!req.user) return res.status(401).end();

  const { driveId } = req.params;
  try {
    await GoogleDrive.streamFile(req.user, driveId, req, res);
  } catch {
    res.status(500).end();
  }
});

// -------------------------------------------------------------
// Downloader Server Proxy Endpoints
// -------------------------------------------------------------

// Downloader status check
app.get('/api/downloader/status', async (req, res) => {
  const [status, gameStatus] = await Promise.all([
    DownloaderClient.getStatus(),
    GameDownloaderClient.getGameStatus()
  ]);
  res.json({ ...status, gameQueue: gameStatus });
});

// List downloads (merged: classic retro jobs + PC game jobs)
app.get('/api/downloads', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  const [legacy, gameJobs] = await Promise.all([
    DownloaderClient.getDownloads(req.user.id),
    GameDownloaderClient.getGameDownloads(req.user.id)
  ]);

  const merged = [
    ...gameJobs.map(j => ({ ...j, queue: 'games' })),
    ...legacy.map(j => ({ ...j, queue: 'media' }))
  ].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  res.json({ success: true, downloads: merged });
});

// Add download to queue (magnet / .torrent URL)
app.post('/api/downloads/add', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  const { magnet, title, console: consoleKey, size, sizeBytes } = req.body || {};
  if (!magnet) {
    return res.status(400).json({ error: 'Missing magnet or torrent URL' });
  }

  const isPc = consoleKey === 'pc' || (!consoleKey && (/^pc$/i.test(consoleKey || '') || /pc/i.test(title || '')));
  const isTorrent = magnet.toLowerCase().startsWith('magnet:') || /\.torrent(\?|#|$)/i.test(magnet);
  if (isPc && isTorrent) {
    const explicitBytes = Number(sizeBytes) || parseSizeStringToBytes(size);
    if (explicitBytes && explicitBytes > MAX_PC_REMOTE_TORRENT_BYTES) {
      return res.status(400).json({ error: PC_REMOTE_TORRENT_LIMIT_MSG });
    }
  }

  // Construct webhook + token refresh URLs back to this games server
  const proto = req.headers['x-forwarded-proto'] || (req.connection?.encrypted ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const base = `${proto}://${host}`;

  try {
    const job = await GameDownloaderClient.addGameTorrent(req.user, {
      source: magnet,
      title: title || 'Retro Game',
      console: consoleKey || 'retro',
      sizeBytes: explicitBytes || undefined,
      subfolder: consoleKey === 'pc' ? `PC/${sanitizeFolderName(cleanGameTitle(title || 'PC Game'))}` : consoleKey || undefined,
      webhookUrl: `${base}/api/webhook/download-complete`,
      tokenRefreshUrl: `${base}/api/downloads/token-refresh`
    });
    res.json({ success: true, job });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cancel download
app.post('/api/downloads/:id/cancel', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  const id = req.params.id;
  let ok;
  if (id.startsWith('gme_') || id.startsWith('gdl_')) {
    ok = await GameDownloaderClient.cancelGameDownload(id);
  } else {
    ok = await DownloaderClient.cancelDownload(id);
  }
  res.json({ success: ok });
});

// Clear history
app.delete('/api/downloads/history', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  const results = await Promise.all([
    DownloaderClient.clearHistory(req.user.id),
    GameDownloaderClient.clearGameHistory(req.user.id)
  ]);
  res.json({ success: true, cleared: results.filter(Boolean).length });
});

// Webhook invoked by Downloader server when upload to Google Drive finishes
app.post('/api/webhook/download-complete', async (req, res) => {
  const body = req.body || {};
  const success = body.success === true || body.status === 'completed';
  const fileName = body.fileName || body.cleanName || 'game files';
  const { userId } = body;
  console.log(`[FREEPLAY Webhook] Download ${success ? 'completed' : 'failed'}: "${fileName}" for user ${userId} (job ${body.jobId}, kind ${body.kind || 'media'})`);

  res.json({ received: true });

  // Auto-scan user's library in background if download succeeded
  if (success && userId) {
    const user = Database.getUser(userId);
    if (user && user.gamesFolderId) {
      try {
        if (body.meta?.posterUrl) {
          const gameTitle = body.meta.title || (body.fileName ? body.fileName.replace(/\.[^.]+$/, '') : 'Game');
          const consoleKey = body.meta.console || 'pc';
          console.log(`[FREEPLAY Webhook] Ensuring poster for "${gameTitle}" (${consoleKey})...`);
          try {
            await GoogleDrive.uploadGamePoster(user, consoleKey, gameTitle, body.meta.posterUrl);
          } catch (pErr) {
            console.warn(`[FREEPLAY Webhook] Poster upload error:`, pErr.message);
          }
        }
        console.log(`[FREEPLAY Webhook] Triggering automatic library refresh for user ${user.name}...`);
        await GoogleDrive.scanGamesFolder(user);
        console.log(`[FREEPLAY Webhook] Automatic scan complete.`);
      } catch (err) {
        console.warn(`[FREEPLAY Webhook] Auto-scan error:`, err.message);
      }
    }
  }
});

// -------------------------------------------------------------
// Settings Endpoints
// -------------------------------------------------------------

app.get('/api/settings', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  res.json(req.user.settings || {});
});

app.post('/api/settings', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  Database.updateUserSettings(req.user.id, req.body || {});
  res.json({ success: true, settings: req.user.settings });
});

// -------------------------------------------------------------
// Admin controls are restricted to the server-configured ADMIN_EMAIL.
// -------------------------------------------------------------

function requireAdmin(req, res, next) {
  if (!isAdminUser(req.user)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// Reboot the Downloader node (download.butfree.online) — it restarts on /api/restart
app.post('/api/admin/restart-downloader', requireAdmin, async (req, res) => {
  try {
    const result = await DownloaderClient.restart();
    res.json({ success: true, message: 'Downloader server is restarting…', result });
  } catch (err) {
    console.error('[Admin] Downloader restart failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Soft-restart this games app server (supervisor/PMS restarts the process)
app.post('/api/admin/restart-app', requireAdmin, (req, res) => {
  res.json({ success: true, message: 'FREEPLAY game server is restarting…' });
  setTimeout(() => {
    console.log('[Admin] App server restart requested by admin.');
    shutdown();
  }, 600);
});

// Public liveness probe (no auth) — used by the admin UI to detect when the
// server is back after a restart so the page can reload.
app.get('/api/ping', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, ts: Date.now() });
});

// -------------------------------------------------------------
// Discovery: FitGirl RSS / Steam Popular / itch.io / GOG.com
// + Library extras: bookmarks, embeds, save states, token refresh
// -------------------------------------------------------------

registerDiscoverRoutes(app, { Database, GameDownloaderClient });
registerLibraryRoutes(app, { Database });

// -------------------------------------------------------------
// Production Static Client Serving
// -------------------------------------------------------------

const distDir = path.join(__dirname, 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) {
      return next();
    }
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

// Global error handler
app.use((err, req, res, next) => {
  console.error('[FREEPLAY Server Error]:', err);
  if (!res.headersSent) {
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

function shutdown() {
  console.log('\n[FREEPLAY] App server shutting down…');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`==================================================================`);
  console.log(`🎮 FREEPLAY Cloud Retro Arcade Server running on :${PORT}`);
  console.log(`   • Google Drive Storage: ACTIVE`);
  console.log(`   • Downloader Node URL: ${process.env.DOWNLOADER_URL || 'http://download.butfree.online:4000'}`);
  console.log(`   • Public Web URL: https://games.butfree.online`);
  console.log(`==================================================================`);
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
