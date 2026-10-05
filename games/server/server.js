import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

import * as Database from './server/database.js';
import { GoogleAuth } from './server/googleAuth.js';
import { GoogleDrive } from './server/googleDrive.js';
import { DownloaderClient } from './server/downloaderClient.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load root monorepo .env with local fallback
const rootEnv = path.resolve(__dirname, '..', '..', '.env');
if (fs.existsSync(rootEnv)) {
  dotenv.config({ path: rootEnv });
}
dotenv.config();

const PORT = parseInt(process.env.PORT_GAMES || process.env.PORT || '5500', 10);

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

// Google OAuth callback
const handleOAuthCallback = async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) {
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
      maxAge: 30 * 86400 * 1000 // 30 days
    });

    res.redirect('/');
  } catch (err) {
    console.error('[FREEPLAY Auth Callback Error]:', err);
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
      gamesFolderId: req.user.gamesFolderId,
      gamesFolderName: req.user.gamesFolderName,
      settings: req.user.settings
    }
  });
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
app.post('/api/games/:id/favorite', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  const gameId = req.params.id;
  const isFavorite = Database.toggleFavorite(req.user.id, gameId);
  res.json({ success: true, gameId, isFavorite });
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
  const status = await DownloaderClient.getStatus();
  res.json(status);
});

// List downloads
app.get('/api/downloads', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  const list = await DownloaderClient.getDownloads(req.user.id);
  res.json({ success: true, downloads: list });
});

// Add download to queue
app.post('/api/downloads/add', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  const { magnet, title, console: consoleKey } = req.body || {};
  if (!magnet) {
    return res.status(400).json({ error: 'Missing magnet or torrent URL' });
  }

  // Construct webhook URL back to this games server
  const proto = req.headers['x-forwarded-proto'] || (req.connection?.encrypted ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const webhookUrl = `${proto}://${host}/api/webhook/download-complete`;

  try {
    const job = await DownloaderClient.addDownload(req.user, {
      magnet,
      title,
      console: consoleKey,
      webhookUrl
    });
    res.json({ success: true, job });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cancel download
app.post('/api/downloads/:id/cancel', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  const ok = await DownloaderClient.cancelDownload(req.params.id);
  res.json({ success: ok });
});

// Clear history
app.delete('/api/downloads/history', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  const ok = await DownloaderClient.clearHistory(req.user.id);
  res.json({ success: ok });
});

// Webhook invoked by Downloader server when upload to Google Drive finishes
app.post('/api/webhook/download-complete', async (req, res) => {
  const { success, userId, fileName, fileId } = req.body || {};
  console.log(`[FREEPLAY Webhook] Download completed: "${fileName}" for user ${userId} (success: ${success})`);

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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`==================================================================`);
  console.log(`🎮 FREEPLAY Cloud Retro Arcade Server running on :${PORT}`);
  console.log(`   • Google Drive Storage: ACTIVE`);
  console.log(`   • Downloader Node URL: ${process.env.DOWNLOADER_URL || 'http://download.butfree.online:4000'}`);
  console.log(`   • Public Web URL: https://games.butfree.online`);
  console.log(`==================================================================`);
});
