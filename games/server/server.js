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
import { GoogleDrive, cleanGameTitle } from './server/googleDrive.js';
import { sanitizeFolderName } from './server/rssDiscovery.js';
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
const ADMIN_EMAIL = 'gdmcvittie@gmail.com';

function isAdminUser(user) {
  return !!user && String(user.email || '').trim().toLowerCase() === ADMIN_EMAIL;
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
    if (welcomeFlow) return res.redirect(`${welcomeUrl}/?auth_status=error`);
    res.redirect(`/?auth_error=${encodeURIComponent(err.message || 'Authentication failed')}`);
  }
};

app.get('/auth/google/callback', handleOAuthCallback);
app.get('/api/auth/google/callback', handleOAuthCallback);

// Get current user profile
app.get('/api/auth/user', (req, res) => {
  if (!req.user) {
    return res.status(401).json({ authenticated: false, user: null });
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
app.get('/api/welcome/session', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const user = GoogleAuth.verifySessionToken(req.cookies?.freeplay_session);
  if (!user) return res.status(401).json({ authenticated: false, user: null });
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
  res.json({ success: true, count: games.length, games });
});

// Scan Google Drive Games folder
app.post('/api/games/scan', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const result = await GoogleDrive.scanGamesFolder(req.user);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[FREEPLAY Scan Error]:', err);
    res.status(500).json({ error: err.message });
  }
});

// Toggle Favorite
app.post('/api/games/:id/favorite', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  const gameId = req.params.id;
  const isFavorite = Database.toggleFavorite(req.user.id, gameId);

  // Sync favorites.json to user's games folder on Google Drive
  if (req.user.gamesFolderId) {
    try {
      const favs = Database.getFavorites(req.user.id);
      await GoogleDrive.writeJsonFile(req.user, req.user.gamesFolderId, 'favorites.json', {
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

// Stream any file from Google Drive directly (posters, ROMs, etc.)
app.get('/api/drive/file/:driveId', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  try {
    await GoogleDrive.streamFile(req.user, req.params.driveId, req, res);
  } catch (err) {
    console.warn('[Drive File Stream Error]:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// Stream game ROM to in-browser emulator with HTTP range requests
app.get('/api/games/stream/:driveId', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  const { driveId } = req.params;
  try {
    await GoogleDrive.streamFile(req.user, driveId, req, res);
  } catch (err) {
    console.error('[FREEPLAY Stream Error]:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.head('/api/games/stream/:driveId', async (req, res) => {
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

  const { magnet, title, console: consoleKey } = req.body || {};
  if (!magnet) {
    return res.status(400).json({ error: 'Missing magnet or torrent URL' });
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
// Admin Controls (restricted to gdmcvittie@gmail.com)
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
