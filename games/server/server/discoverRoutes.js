// =============================================================================
// DISCOVERY ROUTES - FitGirl RSS, Steam popular, itch.io, GOG.com
// All downloads are dispatched to the central Downloader node
// (download.butfree.online) which fetches & uploads to the user's Drive.
// =============================================================================

import crypto from 'crypto';

import {
  FITGIRL_FEED_URL,
  fetchFeed,
  fetchPopularGames,
  checkFitgirlAvailability,
  checkFitgirlBatch,
  scrapeLinksFromPage,
  cleanPcGameTitle,
  sanitizeFolderName,
  isFuckingFastLandingPage,
  resolveFuckingFastUrl,
  isDataNodesLandingPage
} from './rssDiscovery.js';

import {
  fetchItchStoreGames,
  fetchItchProfile,
  fetchItchMyLibrary,
  listItchUploads,
  resolveOwnedItchFileUrl,
  resolveStoreItchFileUrl
} from './itchApi.js';

import {
  GOG_LOGIN_URL,
  connectGogAccount,
  ensureGogToken,
  fetchGogLibrary,
  fetchGogCatalog,
  fetchGogGameDetails,
  resolveGogDownloadUrl
} from './gogApi.js';

// -------------------------------------------------------------
// Helpers
// -------------------------------------------------------------

function requireUser(req, res) {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return false;
  }
  return true;
}

function requireGamesFolder(req, res) {
  if (!requireUser(req, res)) return false;
  if (!req.user.gamesFolderId) {
    res.status(400).json({ success: false, error: 'Please select a Google Drive Games folder in Settings first.' });
    return false;
  }
  return true;
}

function buildDispatchContext(req) {
  const proto = req.headers['x-forwarded-proto'] || (req.connection?.encrypted ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const base = `${proto}://${host}`;
  return {
    webhookUrl: `${base}/api/webhook/download-complete`,
    tokenRefreshUrl: `${base}/api/downloads/token-refresh`
  };
}

function normTitle(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// -------------------------------------------------------------
// Registration
// -------------------------------------------------------------

export function registerDiscoverRoutes(app, { Database, GameDownloaderClient }) {
  const getUserGames = (user) => Database.getGames(user.id);

  const findLocalGame = (user, { title = '', gogId = null, itchGameId = null, steamAppId = null }) => {
    const cleanT = normTitle(cleanPcGameTitle(title) || title);
    for (const g of getUserGames(user)) {
      if (gogId && (String(g.gogId || '') === String(gogId) || g.id === `gog_${gogId}`)) return g;
      if (itchGameId && (String(g.itchGameId || '') === String(itchGameId) || g.id === `itch_${itchGameId}`)) return g;
      if (steamAppId && String(g.steamAppId || '') === String(steamAppId)) return g;
      const localClean = normTitle(g.title || g.cleanTitle || '');
      if (cleanT && localClean.length >= 4 && (localClean === cleanT || localClean.includes(cleanT) || cleanT.includes(localClean))) {
        return g;
      }
    }
    return null;
  };

  // ===========================================================================
  // FITGIRL / PC RSS DISCOVERY
  // ===========================================================================

  // GET /api/pc/feed?url=...  (defaults to the FitGirl repacks feed)
  app.get('/api/pc/feed', async (req, res) => {
    if (!requireUser(req, res)) return;
    const feedUrl = (req.query.url || '').trim() || FITGIRL_FEED_URL;
    try {
      const feed = await fetchFeed(feedUrl);
      res.json({ success: true, feed });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // GET /api/pc/popular?refresh=true
  app.get('/api/pc/popular', async (req, res) => {
    if (!requireUser(req, res)) return;
    try {
      const result = await fetchPopularGames({ forceRefresh: req.query.refresh === 'true' });
      res.json({ success: !result.error, items: result.items, cached: result.cached, error: result.error });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message, items: [] });
    }
  });

  // GET /api/pc/check-fitgirl?title=...
  app.get('/api/pc/check-fitgirl', async (req, res) => {
    if (!requireUser(req, res)) return;
    const title = (req.query.title || '').trim();
    if (!title) return res.status(400).json({ success: false, error: 'Title is required' });
    const result = await checkFitgirlAvailability(title);
    res.json({ success: true, title, ...result });
  });

  // POST /api/pc/check-fitgirl-batch { titles: [] }
  app.post('/api/pc/check-fitgirl-batch', async (req, res) => {
    if (!requireUser(req, res)) return;
    const titles = Array.isArray(req.body?.titles) ? req.body.titles : [];
    if (titles.length === 0) return res.json({ success: true, results: {} });
    const results = await checkFitgirlBatch(titles.slice(0, 50));
    res.json({ success: true, results });
  });

  // GET /api/pc/scrape-links?url=<repack post page>
  app.get('/api/pc/scrape-links', async (req, res) => {
    if (!requireUser(req, res)) return;
    try {
      const result = await scrapeLinksFromPage((req.query.url || '').trim());
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/pc/inspect { url } - torrent file list via the Downloader node
  app.post('/api/pc/inspect', async (req, res) => {
    if (!requireUser(req, res)) return;
    const { url, timeoutMs } = req.body || {};
    if (!url) return res.status(400).json({ success: false, error: 'url is required' });
    try {
      const result = await GameDownloaderClient.inspectTorrent(url, parseInt(timeoutMs || '25000', 10));
      res.json(result);
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/pc/add { source, title, console, subfolder, selectedFiles }
  app.post('/api/pc/add', async (req, res) => {
    if (!requireGamesFolder(req, res)) return;

    const { source, url: altUrl, title, console: consoleKey, subfolder, selectedFiles } = req.body || {};
    let target = String(source || altUrl || '').trim().replace(/&#038;/g, '&').replace(/&amp;/gi, '&');
    if (!target) {
      return res.status(400).json({ success: false, error: 'A magnet, .torrent URL or direct download URL is required' });
    }

    const cleanTitle = cleanPcGameTitle(title || '') || title || 'PC Game';
    const isMagnet = target.toLowerCase().startsWith('magnet:');
    const isTorrentFile = /\.torrent(\?|#|$)/i.test(target) || /ia[0-9]+_archive\.torrent/i.test(target);
    let isDirect = !isMagnet && !isTorrentFile;

    try {
      const ctx = buildDispatchContext(req);

      if (isDirect && isFuckingFastLandingPage(target)) {
        target = await resolveFuckingFastUrl(target);
      } else if (isDirect && isDataNodesLandingPage(target)) {
        return res.status(400).json({
          success: false,
          error: 'DataNodes links require an interactive browser (Cloudflare Turnstile). Pick the Magnet or another mirror instead.'
        });
      }

      let job;
      if (isMagnet || isTorrentFile) {
        job = await GameDownloaderClient.addGameTorrent(req.user, {
          source: target,
          title: cleanTitle,
          console: consoleKey || 'pc',
          subfolder: subfolder || `PC Games/${sanitizeFolderName(cleanTitle)}`,
          selectedFiles: Array.isArray(selectedFiles) && selectedFiles.length > 0 ? selectedFiles : null,
          webhookUrl: ctx.webhookUrl,
          tokenRefreshUrl: ctx.tokenRefreshUrl
        });
      } else {
        const fileName = (target.split('#')[1] || '').split('?')[0];
        job = await GameDownloaderClient.addDirectDownload(req.user, {
          url: target,
          title: cleanTitle,
          console: consoleKey || 'pc',
          fileName: fileName && fileName.length > 3 ? fileName : undefined,
          subfolder: subfolder || `PC Games/${sanitizeFolderName(cleanTitle)}`,
          webhookUrl: ctx.webhookUrl,
          tokenRefreshUrl: ctx.tokenRefreshUrl
        });
      }

      res.json({ success: true, job, message: `"${cleanTitle}" queued on the downloader node` });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ===========================================================================
  // ITCH.IO
  // ===========================================================================

  // Store browsing (public catalog scrape, but behind login to avoid abuse)
  app.get('/api/itch/games', async (req, res) => {
    if (!requireUser(req, res)) return;
    try {
      const result = await fetchItchStoreGames({
        platform: req.query.platform || 'all',
        query: (req.query.q || req.query.query || '').trim(),
        sort: req.query.sort || 'new-and-popular',
        page: parseInt(req.query.page || '1', 10) || 1
      });
      const user = req.user;
      result.games = result.games.map(g => {
        const local = findLocalGame(user, { title: g.title, itchGameId: g.id });
        return { ...g, inLibrary: !!local, localGameId: local ? local.id : null };
      });
      res.json({ success: true, ...result, count: result.games.length });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Account (per-user API key stored in the games DB)
  app.get('/api/itch/account', async (req, res) => {
    if (!requireUser(req, res)) return;
    const apiKey = (req.user.integrations?.itch?.apiKey || '').trim();
    if (!apiKey) return res.json({ connected: false });
    try {
      const profile = await fetchItchProfile(apiKey);
      res.json({ connected: true, user: profile });
    } catch (err) {
      res.json({ connected: false, error: err.message });
    }
  });

  app.post('/api/itch/account', async (req, res) => {
    if (!requireUser(req, res)) return;
    const apiKey = String(req.body?.apiKey || '').trim();
    if (!apiKey) return res.status(400).json({ success: false, error: 'itch.io API Key is required' });
    try {
      const profile = await fetchItchProfile(apiKey);
      Database.updateUserIntegrations(req.user.id, { itch: { apiKey, username: profile.username } });
      res.json({ success: true, connected: true, user: profile });
    } catch (err) {
      res.status(401).json({ success: false, error: `Invalid itch.io API Key. ${err.message}` });
    }
  });

  app.delete('/api/itch/account', (req, res) => {
    if (!requireUser(req, res)) return;
    Database.updateUserIntegrations(req.user.id, { itch: null });
    res.json({ success: true, connected: false });
  });

  // Purchased library
  app.get('/api/itch/my-library', async (req, res) => {
    if (!requireUser(req, res)) return;
    const apiKey = (req.user.integrations?.itch?.apiKey || '').trim();
    if (!apiKey) {
      return res.status(401).json({ success: false, authenticated: false, error: 'itch.io account is not connected. Enter your API Key in Settings.' });
    }
    try {
      const games = await fetchItchMyLibrary(apiKey, (title, gameId) => {
        const local = findLocalGame(req.user, { title, itchGameId: gameId });
        return { inLibrary: !!local, game: local };
      });
      res.json({ success: true, authenticated: true, count: games.length, games });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/itch/my-library/uploads', async (req, res) => {
    if (!requireUser(req, res)) return;
    const apiKey = (req.user.integrations?.itch?.apiKey || '').trim();
    if (!apiKey) return res.status(401).json({ success: false, error: 'itch.io account not connected' });
    const { gameId, downloadKeyId } = req.query;
    if (!gameId) return res.status(400).json({ success: false, error: 'gameId is required' });
    try {
      const data = await listItchUploads(apiKey, gameId, downloadKeyId || null);
      const uploads = (data.uploads || []).map(u => {
        const fn = u.filename || u.display_name || `file_${u.id}`;
        const ext = fn.includes('.') ? fn.slice(fn.lastIndexOf('.')).toLowerCase() : '';
        return {
          id: u.id,
          filename: fn,
          displayName: u.display_name || fn,
          size: u.size || 0,
          type: u.type || '',
          ext,
          traits: u.traits || []
        };
      });
      res.json({ success: true, gameId, uploads });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Download an OWNED itch game -> Downloader node -> Google Drive
  app.post('/api/itch/my-library/download', async (req, res) => {
    if (!requireGamesFolder(req, res)) return;
    const apiKey = (req.user.integrations?.itch?.apiKey || '').trim();
    if (!apiKey) return res.status(401).json({ success: false, error: 'itch.io account is not connected.' });

    const { gameId, downloadKeyId, uploadId, consoleHint, gameTitle } = req.body || {};
    if (!gameId) return res.status(400).json({ success: false, error: 'gameId is required' });

    try {
      const resolved = await resolveOwnedItchFileUrl({
        apiKey,
        gameId,
        downloadKeyId: downloadKeyId || null,
        uploadId: uploadId || null,
        consoleHint: consoleHint || ''
      });

      const cleanTitle = cleanPcGameTitle(gameTitle || '') || gameTitle || `itch_${gameId}`;
      const consoleKey = (consoleHint || 'pc').toLowerCase();
      const subfolder = consoleKey === 'pc'
        ? `PC Games/${sanitizeFolderName(cleanTitle)}`
        : `itch.io/${consoleKey.toUpperCase()}/${sanitizeFolderName(cleanTitle)}`;

      const ctx = buildDispatchContext(req);
      const job = await GameDownloaderClient.addDirectDownload(req.user, {
        url: resolved.fileUrl,
        fileName: resolved.fileName,
        title: cleanTitle,
        console: consoleKey,
        subfolder,
        webhookUrl: ctx.webhookUrl,
        tokenRefreshUrl: ctx.tokenRefreshUrl
      });

      res.json({ success: true, job, message: `"${cleanTitle}" queued for download to your Drive` });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Download a FREE store itch item (name-your-price / openly downloadable)
  app.post('/api/itch/download', async (req, res) => {
    if (!requireGamesFolder(req, res)) return;
    const { gameUrl, consoleId, gameTitle } = req.body || {};
    if (!gameUrl) return res.status(400).json({ success: false, error: 'gameUrl is required' });

    try {
      const resolved = await resolveStoreItchFileUrl({ gameUrl, consoleId: consoleId || 'gb' });

      if (!resolved.success) {
        return res.json(resolved); // { isPaid, purchaseUrl, message }
      }

      const cleanTitle = cleanPcGameTitle(gameTitle || '') || gameTitle || 'itch Game';
      const consoleKey = (consoleId || 'gb').toLowerCase();
      const subfolder = consoleKey === 'pc'
        ? `PC Games/${sanitizeFolderName(cleanTitle)}`
        : `itch.io/${consoleKey.toUpperCase()}/${sanitizeFolderName(cleanTitle)}`;

      const ctx = buildDispatchContext(req);
      const job = await GameDownloaderClient.addDirectDownload(req.user, {
        url: resolved.fileUrl,
        fileName: resolved.fileName,
        title: cleanTitle,
        console: consoleKey,
        subfolder,
        webhookUrl: ctx.webhookUrl,
        tokenRefreshUrl: ctx.tokenRefreshUrl
      });

      res.json({ success: true, job, message: `"${cleanTitle}" queued for download to your Drive` });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ===========================================================================
  // GOG.COM (per-user account)
  // ===========================================================================

  const getGogAuth = (user) => user.integrations?.gog || null;

  app.get('/api/gog/account', async (req, res) => {
    if (!requireUser(req, res)) return;
    const gogAuth = getGogAuth(req.user);
    if (!gogAuth || !gogAuth.refreshToken) {
      return res.json({ connected: false, loginUrl: GOG_LOGIN_URL });
    }
    const onRenewed = (renewed) => Database.updateUserIntegrations(req.user.id, { gog: renewed });
    const token = await ensureGogToken(gogAuth, onRenewed);
    if (!token) {
      return res.json({ connected: false, loginUrl: GOG_LOGIN_URL, error: 'Session expired. Please reconnect.' });
    }
    res.json({
      connected: true,
      loginUrl: GOG_LOGIN_URL,
      user: {
        userId: gogAuth.userId,
        username: gogAuth.username || 'GOG User',
        avatar: gogAuth.avatar || ''
      }
    });
  });

  app.post('/api/gog/account', async (req, res) => {
    if (!requireUser(req, res)) return;
    try {
      const auth = await connectGogAccount(req.body?.code);
      Database.updateUserIntegrations(req.user.id, { gog: auth });
      console.log(`[GOG] Account connected for user "${auth.username}" (${req.user.id})`);
      res.json({ success: true, connected: true, user: { userId: auth.userId, username: auth.username, avatar: auth.avatar } });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete('/api/gog/account', (req, res) => {
    if (!requireUser(req, res)) return;
    Database.updateUserIntegrations(req.user.id, { gog: null });
    res.json({ success: true, connected: false });
  });

  app.get('/api/gog/my-library', async (req, res) => {
    if (!requireUser(req, res)) return;
    const gogAuth = getGogAuth(req.user);
    if (!gogAuth || !gogAuth.refreshToken) {
      return res.status(401).json({ success: false, authenticated: false, error: 'GOG account not connected' });
    }
    const token = await ensureGogToken(gogAuth, (renewed) => Database.updateUserIntegrations(req.user.id, { gog: renewed }));
    if (!token) {
      return res.status(401).json({ success: false, authenticated: false, error: 'GOG session expired. Please reconnect.' });
    }
    try {
      const games = await fetchGogLibrary(token);
      const decorated = games.map(p => {
        const local = findLocalGame(req.user, { title: p.title, gogId: p.id });
        return {
          ...p,
          inLibrary: !!local,
          localGameId: local ? local.id : null
        };
      });
      res.json({ success: true, authenticated: true, count: decorated.length, games: decorated });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/gog/catalog', async (req, res) => {
    if (!requireUser(req, res)) return;
    try {
      const result = await fetchGogCatalog({
        tab: req.query.tab || 'new',
        page: parseInt(req.query.page || '1', 10) || 1,
        search: (req.query.search || '').trim()
      });
      const user = req.user;
      const decorated = result.products.map(p => {
        const local = findLocalGame(user, { title: p.title, gogId: p.id });
        return { ...p, inLibrary: !!local, localGameId: local ? local.id : null };
      });
      res.json({ success: true, tab: result.tab, page: result.page, totalPages: result.totalPages, count: decorated.length, games: decorated });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/gog/game-details/:id', async (req, res) => {
    if (!requireUser(req, res)) return;
    const gogAuth = getGogAuth(req.user);
    const token = gogAuth ? await ensureGogToken(gogAuth, (renewed) => Database.updateUserIntegrations(req.user.id, { gog: renewed })) : null;
    if (!token) return res.status(401).json({ success: false, error: 'GOG account not connected' });

    try {
      const details = await fetchGogGameDetails(token, req.params.id);
      res.json({ success: true, ...details });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/gog/download', async (req, res) => {
    if (!requireGamesFolder(req, res)) return;
    const gogAuth = getGogAuth(req.user);
    const token = gogAuth ? await ensureGogToken(gogAuth, (renewed) => Database.updateUserIntegrations(req.user.id, { gog: renewed })) : null;
    if (!token) return res.status(401).json({ success: false, error: 'GOG account not connected' });

    const { gameId, downlinkUrl, downlink, manualUrl, gameTitle, fileName } = req.body || {};
    const finalDownlink = (downlinkUrl || downlink || manualUrl || '').trim();
    if (!finalDownlink) {
      return res.status(400).json({ success: false, error: 'downlinkUrl is required' });
    }

    try {
      const cdnUrl = await resolveGogDownloadUrl(token, finalDownlink);
      const cleanTitle = cleanPcGameTitle(gameTitle || '') || gameTitle || `GOG Game ${gameId || ''}`.trim();
      const ctx = buildDispatchContext(req);

      const job = await GameDownloaderClient.addDirectDownload(req.user, {
        url: cdnUrl,
        fileName: fileName || undefined,
        title: cleanTitle,
        console: 'pc',
        subfolder: `PC Games/${sanitizeFolderName(cleanTitle)}`,
        webhookUrl: ctx.webhookUrl,
        tokenRefreshUrl: ctx.tokenRefreshUrl
      });

      // Tag the Drive-scan grouping id so my-library re-fetch can show installed
      res.json({ success: true, job, gogId: String(gameId || ''), message: `"${cleanTitle}" queued for download to your Drive` });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
}
