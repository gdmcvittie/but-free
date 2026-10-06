// =============================================================================
// LIBRARY EXTRAS ROUTES - ported/adapted from my-games-server:
//  • /api/games/bookmark          -> HTML5 web-game library entries (itch etc.)
//  • /api/web-game/embed          -> anti-frame-buster proxy for HTML5 games
//  • /api/proxy-image             -> cover-art hotlink proxy
//  • /api/games/:id/savestate     -> server-synced emulator save states
//  • /api/games/:id/drive-link    -> Google Drive download links for PC games
//  • /api/downloads/token-refresh -> short-lived Drive tokens for the node
// =============================================================================

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

import { GoogleAuth } from './googleAuth.js';
import { GoogleDrive } from './googleDrive.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const SAVES_DIR = path.join(DATA_DIR, 'savestates');

function requireUser(req, res) {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return false;
  }
  return true;
}

function verifyNodeKey(req) {
  const key = (process.env.NODE_KEY || process.env.DOWNLOADER_SECRET_KEY || process.env.TORRENT_NODE_KEY || '').trim();
  if (!key) return true; // open node (dev)
  const provided = req.get('x-node-key') || req.get('x-dashboard-key') || req.query.key;
  if (!provided) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function registerLibraryRoutes(app, { Database }) {
  // -------------------------------------------------------------
  // Web-game bookmark (itch.io HTML5, etc.) - stored in the user's DB
  // -------------------------------------------------------------
  app.post('/api/games/bookmark', (req, res) => {
    if (!requireUser(req, res)) return;

    const { url, webUrl, gameUrl, title, gameTitle, coverUrl, author, description } = req.body || {};
    const targetUrl = gameUrl || webUrl || url;
    if (!targetUrl) {
      return res.status(400).json({ success: false, error: 'URL is required for a web game bookmark.' });
    }

    const cleanTitle = gameTitle || title || 'Web Game';
    const normUrl = String(targetUrl).replace(/\/$/, '').toLowerCase();
    const gameId = 'web_' + crypto.createHash('md5').update(normUrl).digest('hex').substring(0, 16);

    const record = {
      id: gameId,
      userId: req.user.id,
      source: 'web',
      title: cleanTitle,
      cleanTitle,
      console: 'web',
      gameType: 'web',
      isWebGame: true,
      webUrl: targetUrl,
      playUrl: targetUrl,
      filename: `${cleanTitle}.url`,
      size: 0,
      coverUrl: coverUrl || null,
      description: description || `${cleanTitle} web game`,
      developer: author || 'itch.io Creator',
      publisher: 'Web',
      addedAt: Date.now()
    };

    Database.upsertGame(record);
    res.json({ success: true, game: record, message: `"${cleanTitle}" added to your library` });
  });

  app.delete('/api/games/:id', (req, res) => {
    if (!requireUser(req, res)) return;
    const ok = Database.removeGame(req.user.id, req.params.id);
    res.json({ success: ok });
  });

  // -------------------------------------------------------------
  // Recently played - a play history of the last 50 games (music app style)
  // -------------------------------------------------------------
  app.post('/api/games/:id/play', (req, res) => {
    if (!requireUser(req, res)) return;
    const game = Database.getGame(req.params.id);
    if (!game || game.userId !== req.user.id) {
      return res.status(404).json({ success: false, error: 'Game not found' });
    }
    const playedAt = Database.markGamePlayed(req.user.id, game.id);
    res.json({ success: true, gameId: game.id, playedAt });
  });

  app.get('/api/games/recent', (req, res) => {
    if (!requireUser(req, res)) return;
    const byId = new Map(Database.getGames(req.user.id).map((g) => [g.id, g]));
    const games = Database.getRecentlyPlayed(req.user.id)
      .map((entry) => {
        const game = byId.get(entry.gameId);
        return game ? { ...game, playedAt: entry.playedAt } : null;
      })
      .filter(Boolean);
    res.json({ success: true, count: games.length, games });
  });

  // -------------------------------------------------------------
  // -------------------------------------------------------------
  // Save states (stored in 'save_states' folder in user's Drive, with local cache)
  // -------------------------------------------------------------
  app.get('/api/games/:id/savestate', async (req, res) => {
    if (!requireUser(req, res)) return;
    const saveFileName = `${req.params.id}.state`;
    const localSavePath = path.join(SAVES_DIR, `${req.user.id}_${saveFileName}`);

    // If cached locally, send it immediately
    if (fs.existsSync(localSavePath)) {
      return res.sendFile(path.resolve(localSavePath));
    }

    // Check Drive 'save_states' folder
    if (req.user.gamesFolderId) {
      try {
        const statesFolder = await GoogleDrive.findOrCreateFolder(req.user, 'save_states', req.user.gamesFolderId);
        const stateFile = await GoogleDrive.findFileByName(req.user, statesFolder.id, saveFileName);
        if (stateFile) {
          res.setHeader('Content-Type', 'application/octet-stream');
          return await GoogleDrive.streamFile(req.user, stateFile.id, req, res);
        }
      } catch (err) {
        console.warn('[SaveState Drive Read Warning]:', err.message);
      }
    }

    return res.status(204).end();
  });

  app.post('/api/games/:id/savestate', (req, res) => {
    if (!requireUser(req, res)) return;
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      try {
        const buf = Buffer.concat(chunks);
        if (!buf.length) return res.status(400).json({ success: false, error: 'Empty save state' });
        if (buf.length > 50 * 1024 * 1024) return res.status(413).json({ success: false, error: 'Save state too large' });

        const saveFileName = `${req.params.id}.state`;

        // Cache locally for fast retrieval
        if (!fs.existsSync(SAVES_DIR)) fs.mkdirSync(SAVES_DIR, { recursive: true });
        fs.writeFileSync(path.join(SAVES_DIR, `${req.user.id}_${saveFileName}`), buf);

        // Upload directly into 'save_states' folder in user's Google Drive
        if (req.user.gamesFolderId) {
          try {
            const statesFolder = await GoogleDrive.findOrCreateFolder(req.user, 'save_states', req.user.gamesFolderId);
            await GoogleDrive.uploadBufferToDrive(req.user, buf, saveFileName, 'application/octet-stream', statesFolder.id);
          } catch (driveErr) {
            console.warn('[SaveState Drive Sync Warning]:', driveErr.message);
          }
        }

        res.json({ success: true, message: 'Save state stored in save_states folder' });
      } catch (err) {
        res.status(500).json({ success: false, error: err.message });
      }
    });
    req.on('error', () => res.status(500).json({ success: false, error: 'Upload failed' }));
  });

  app.delete('/api/games/:id/savestate', async (req, res) => {
    if (!requireUser(req, res)) return;
    const saveFileName = `${req.params.id}.state`;
    const localSavePath = path.join(SAVES_DIR, `${req.user.id}_${saveFileName}`);
    try {
      if (fs.existsSync(localSavePath)) fs.unlinkSync(localSavePath);
    } catch (_) {}

    if (req.user.gamesFolderId) {
      try {
        const statesFolder = await GoogleDrive.findOrCreateFolder(req.user, 'save_states', req.user.gamesFolderId);
        const stateFile = await GoogleDrive.findFileByName(req.user, statesFolder.id, saveFileName);
        if (stateFile) {
          await GoogleDrive.deleteFile(req.user, stateFile.id);
        }
      } catch (err) {
        console.warn('[SaveState Drive Delete Warning]:', err.message);
      }
    }

    res.json({ success: true, message: 'Save state deleted' });
  });

  // -------------------------------------------------------------
  // Drive download links for library entries (PC games & folders)
  // -------------------------------------------------------------
  app.get('/api/games/:id/drive-link', async (req, res) => {
    if (!requireUser(req, res)) return;

    const game = Database.getGame(req.params.id);
    if (!game || game.userId !== req.user.id) {
      return res.status(404).json({ success: false, error: 'Game not found' });
    }

    if (game.source && game.source !== 'drive') {
      return res.json({ success: true, type: game.source, url: game.webUrl || game.playUrl || null });
    }

    const driveId = game.isFolder ? game.driveFileId : game.driveId;
    const links = [];
    if (game.isFolder && Array.isArray(game.files)) {
      for (const f of game.files) {
        links.push({ name: f.name, url: `https://drive.google.com/uc?export=download&id=${f.driveId}` });
      }
    }

    res.json({
      success: true,
      type: 'drive',
      folderViewUrl: `https://drive.google.com/drive/folders/${game.driveId}`,
      directUrl: driveId ? `https://drive.google.com/uc?export=download&id=${driveId}` : null,
      links
    });
  });

  // -------------------------------------------------------------
  // Cover media proxy (bypasses itch.io/FitGirl hotlink protection, supports images & webm video clips)
  // -------------------------------------------------------------
  app.get(['/api/proxy-image', '/api/proxy-media'], async (req, res) => {
    try {
      let imageUrl = req.query.url;
      if (!imageUrl || typeof imageUrl !== 'string') {
        return res.status(400).send('No url provided');
      }
      imageUrl = imageUrl.trim();
      if (!imageUrl.startsWith('http://') && !imageUrl.startsWith('https://')) {
        return res.status(400).send('Invalid url');
      }

      let parsedOrigin = '';
      try {
        parsedOrigin = new URL(imageUrl).origin;
      } catch (_) {}

      const isWebm = imageUrl.toLowerCase().includes('.webm');
      const fetchHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': parsedOrigin ? `${parsedOrigin}/` : 'https://fitgirl-repacks.site/',
        'Accept': isWebm ? 'video/webm,video/*,*/*;q=0.9' : 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
      };

      if (req.headers.range) {
        fetchHeaders['Range'] = req.headers.range;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      const proxyRes = await fetch(imageUrl, {
        signal: controller.signal,
        headers: fetchHeaders
      });
      clearTimeout(timeout);

      if (!proxyRes.ok && proxyRes.status !== 206) {
        return res.status(proxyRes.status).send(`Failed to fetch media: ${proxyRes.statusText}`);
      }

      let contentType = proxyRes.headers.get('content-type') || (isWebm ? 'video/webm' : 'image/jpeg');
      if (isWebm && (!contentType || contentType === 'application/octet-stream')) {
        contentType = 'video/webm';
      }

      res.status(proxyRes.status);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=604800');
      res.setHeader('Accept-Ranges', 'bytes');

      if (proxyRes.headers.get('content-range')) {
        res.setHeader('Content-Range', proxyRes.headers.get('content-range'));
      }
      if (proxyRes.headers.get('content-length')) {
        res.setHeader('Content-Length', proxyRes.headers.get('content-length'));
      }

      const arrayBuffer = await proxyRes.arrayBuffer();
      res.send(Buffer.from(arrayBuffer));
    } catch (err) {
      res.status(500).send('Proxy error: ' + err.message);
    }
  });

  // -------------------------------------------------------------
  // HTML5 web-game embed proxy (itch.zone direct wrapper + frame-buster bypass)
  // -------------------------------------------------------------
  app.get(['/api/web-game/embed', '/api/web-proxy'], async (req, res) => {
    try {
      let targetUrl = req.query.url;
      if (!targetUrl || typeof targetUrl !== 'string') {
        return res.status(400).send('No url provided');
      }
      targetUrl = targetUrl.trim();
      if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
        return res.status(400).send('Invalid url');
      }

      const isDirectPlayer = targetUrl.includes('.itch.zone/') ||
                             targetUrl.includes('.ssl.hwcdn.net/html/') ||
                             targetUrl.includes('lexaloffle.com/bbs/widget.php');

      let directGameUrl = '';
      if (isDirectPlayer) {
        directGameUrl = targetUrl;
      } else {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 12000);

        const itchRes = await fetch(targetUrl, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
          }
        });
        clearTimeout(timeout);

        if (!itchRes.ok) {
          return res.status(itchRes.status).send(`Failed to fetch web game (HTTP ${itchRes.status})`);
        }

        const html = await itchRes.text();

        const dataIframeMatch = html.match(/data-iframe="([^"]+)"/i) || html.match(/data-iframe='([^']+)'/i);
        if (dataIframeMatch) {
          const unescaped = dataIframeMatch[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
          const srcMatch = unescaped.match(/src="([^"]+)"/i);
          if (srcMatch && srcMatch[1]) directGameUrl = srcMatch[1];
        }
        if (!directGameUrl) {
          const zoneMatch = html.match(/https:\/\/[a-zA-Z0-9.\-_]+\.itch\.zone\/[^\s"']+/i) ||
                            html.match(/https:\/\/[a-zA-Z0-9.\-_]+\.ssl\.hwcdn\.net\/html\/[^\s"']+/i);
          if (zoneMatch) directGameUrl = zoneMatch[0];
        }

        if (!directGameUrl) {
          // Serve the page itself through a frame-buster-bypassing rewrite
          let outHtml = html
            .replace(/if\s*\(\s*window\.top\s*!==\s*window\.self\s*\)[\s\S]*?\{[\s\S]*?\}/gi, '/* bypassed */')
            .replace(/if\s*\(\s*top\.location\s*!==\s*location\s*\)[\s\S]*?\{[\s\S]*?\}/gi, '/* bypassed */')
            .replace(/top\.location\s*=\s*location;/gi, '/* bypassed */');

          const baseHref = targetUrl.endsWith('/') ? targetUrl : (targetUrl + '/');
          if (!outHtml.includes('<base ') && !outHtml.includes('<base>')) {
            outHtml = outHtml.replace(/<head[^>]*>/i, `$&<base href="${baseHref}">`);
          }

          res.removeHeader('X-Frame-Options');
          res.setHeader('X-Frame-Options', 'ALLOWALL');
          res.setHeader('Content-Security-Policy', 'frame-ancestors *;');
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          return res.send(outHtml);
        }
      }

      res.removeHeader('X-Frame-Options');
      res.setHeader('X-Frame-Options', 'ALLOWALL');
      res.setHeader('Content-Security-Policy', 'frame-ancestors *;');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Game Player</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { width: 100vw; height: 100vh; overflow: hidden; background: #000; }
    iframe { width: 100%; height: 100%; border: none; outline: none; display: block; }
  </style>
</head>
<body>
  <iframe src="${directGameUrl}" allow="autoplay; fullscreen *; geolocation; microphone; camera; midi; monetization; xr-spatial-tracking; gamepad; gyroscope; accelerometer; xr; cross-origin-isolated" allowfullscreen="true" webkitallowfullscreen="true"></iframe>
</body>
</html>`);
    } catch (err) {
      res.status(500).send('Web game embed error: ' + err.message);
    }
  });

  // -------------------------------------------------------------
  // Drive access-token refresh for the Downloader node (shared key)
  // -------------------------------------------------------------
  app.post('/api/downloads/token-refresh', (req, res) => {
    if (!verifyNodeKey(req)) {
      return res.status(401).json({ error: 'Unauthorized: invalid node key' });
    }
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    const user = Database.getUser(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    GoogleAuth.getValidAccessToken(user)
      .then((accessToken) => res.json({ accessToken }))
      .catch((err) => res.status(500).json({ error: err.message }));
  });
}
