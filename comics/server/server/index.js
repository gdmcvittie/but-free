if (!process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = '16';
}

process.on('uncaughtException', (err) => {
  console.error('[Index] Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Index] Unhandled Rejection at:', promise, 'reason:', reason);
});

const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rootEnv = path.resolve(__dirname, '../../../.env');
if (fs.existsSync(rootEnv)) {
  require('dotenv').config({ path: rootEnv });
}
require('dotenv').config();

// Logging is configured by app.js (patches console + sets global.__comixLog).
function logger(...args) {
  if (typeof global.__comixLog === 'function') {
    global.__comixLog('INFO', args);
  } else {
    console.log(...args);
  }
}
logger.log = (level, ...args) => {
  if (typeof global.__comixLog === 'function') {
    global.__comixLog(level, args);
  } else {
    console.log(`[${level}]`, ...args);
  }
};

const Database = require('./database');
const GoogleAuth = require('./googleAuth');
const GoogleDrive = require('./googleDrive');
const ComicScraper = require('./scraper');
const PullListManager = require('./pullListManager');
const CacheManager = require('./cacheManager');
const ComicCompressor = require('./comicCompressor');
const DownloadManager = require('./downloadManager');
const OmnibusManager = require('./omnibusManager');

const app = express();

function isAdminUser(user) {
  const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  return !!user && !!adminEmail && String(user.email || '').trim().toLowerCase() === adminEmail;
}

app.use(cors());
app.use(express.json());
app.use(cookieParser());
app.use(GoogleAuth.authMiddleware);

// Request logging to the log file (method, path, status, duration)
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.log('REQ', `${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

// =========================================================================
// Authentication Endpoints
// =========================================================================

app.get('/api/auth/google/url', (req, res) => {
  try {
    const url = GoogleAuth.getAuthUrl(req);
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/auth/google/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) {
    return res.redirect(`/?auth_error=${encodeURIComponent(error)}`);
  }
  if (!code) {
    return res.redirect('/?auth_error=no_code');
  }

  try {
    const user = await GoogleAuth.handleCallback(code, req);
    const token = GoogleAuth.createSessionToken(user);

    // Set 30-day session cookie
    res.cookie('comix_session', token, {
      maxAge: 30 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: 'lax',
      secure: req.secure || req.headers['x-forwarded-proto'] === 'https'
    });

    res.redirect('/');
  } catch (err) {
    console.error('[Auth] Callback error:', err.message);
    res.redirect(`/?auth_error=${encodeURIComponent(err.message)}`);
  }
});

app.get('/api/auth/me', (req, res) => {
  if (!req.user) {
    return res.json({
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
      driveFolderId: req.user.driveFolderId,
      driveFolderName: req.user.driveFolderName
    }
  });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('comix_session');
  res.json({ success: true });
});

// =========================================================================
// Global API Route Protection Middleware
// =========================================================================

// Whitelist of public endpoints that unauthenticated users can access
const PUBLIC_API_PATHS = new Set([
  '/api/auth/google/url',
  '/api/auth/google/callback',
  '/api/auth/me',
  '/api/auth/logout',
  '/api/ping',
  '/api/status',
  '/api/health'
]);

// All other /api routes strictly require Google authentication
app.use('/api', (req, res, next) => {
  const cleanPath = (req.originalUrl || req.url).split('?')[0];
  if (PUBLIC_API_PATHS.has(cleanPath)) {
    return next();
  }
  if (!req.user) {
    return res.status(401).json({
      error: 'Authentication required. Please sign in with Google.',
      code: 'UNAUTHENTICATED'
    });
  }
  next();
});

// Middleware to protect user-specific API routes
function requireLogin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      error: 'Please sign in with Google to access this feature.',
      code: 'UNAUTHENTICATED'
    });
  }
  next();
}

// =========================================================================
// Google Drive Folder Selection & Management Endpoints
// =========================================================================

app.get('/api/gdrive/status', (req, res) => {
  if (!req.user) {
    return res.json({ connected: false });
  }
  res.json({
    connected: Boolean(req.user.driveFolderId),
    folderId: req.user.driveFolderId,
    folderName: req.user.driveFolderName
  });
});

app.get('/api/gdrive/folders', requireLogin, async (req, res) => {
  try {
    const parentId = req.query.parentId || 'root';
    const folders = await GoogleDrive.listFolders(req.user, parentId);
    res.json(folders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/gdrive/folders', requireLogin, async (req, res) => {
  try {
    const { name, parentId } = req.body;
    if (!name) return res.status(400).json({ error: 'Folder name is required' });
    const newFolder = await GoogleDrive.createFolder(req.user, name, parentId);
    res.json(newFolder);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/gdrive/select-folder', requireLogin, async (req, res) => {
  try {
    const { folderId, folderName } = req.body;
    if (!folderId) return res.status(400).json({ error: 'folderId is required' });

    let finalName = folderName;
    if (!finalName) {
      const info = await GoogleDrive.getFolderInfo(req.user, folderId);
      finalName = info.name || 'Comics';
    }

    const updatedUser = Database.updateUserDriveFolder(req.user.id, folderId, finalName);

    // Attempt hydration of user comics library, favorites, and progress from Drive
    try {
      const userLibFile = GoogleDrive.getUserMetaFilename(req.user, 'comics-library.json');
      const libFile = (await GoogleDrive.findFileByName(req.user, folderId, userLibFile))
                   || (await GoogleDrive.findFileByName(req.user, folderId, 'comics-library.json'));
      if (libFile) {
        const libData = await GoogleDrive.readJsonFile(req.user, libFile.id);
        if (libData && Array.isArray(libData.comics) && libData.comics.length > 0) {
          Database.batchSyncComics(req.user.id, libData.comics);
        }
      }

      const userFavFile = GoogleDrive.getUserMetaFilename(req.user, 'comics-favorites.json');
      const favFile = (await GoogleDrive.findFileByName(req.user, folderId, userFavFile))
                   || (await GoogleDrive.findFileByName(req.user, folderId, 'comics-favorites.json'));
      if (favFile) {
        const favData = await GoogleDrive.readJsonFile(req.user, favFile.id);
        if (favData && Array.isArray(favData.favorites)) {
          Database.saveFavorites(req.user.id, favData.favorites);
        }
        if (favData && Array.isArray(favData.seriesFavorites)) {
          Database.saveSeriesFavorites(req.user.id, favData.seriesFavorites);
        }
      }

      const userProgFile = GoogleDrive.getUserMetaFilename(req.user, 'comics-progress.json');
      const progFile = (await GoogleDrive.findFileByName(req.user, folderId, userProgFile))
                    || (await GoogleDrive.findFileByName(req.user, folderId, 'comics-progress.json'));
      if (progFile) {
        const progData = await GoogleDrive.readJsonFile(req.user, progFile.id);
        if (progData && typeof progData === 'object') {
          for (const [cId, p] of Object.entries(progData)) {
            if (p && p.currentPage) {
              Database.saveReadingProgress(req.user.id, cId, p.currentPage, p.totalPages, p.zoomNormX, p.zoomNormY);
            }
          }
        }
      }
    } catch (syncErr) {
      console.warn('[Comics Folder Select Sync Warning]:', syncErr.message);
    }
    res.json({ success: true, folderId, folderName: finalName, user: updatedUser });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings/scan', requireLogin, async (req, res) => {
  try {
    const result = await GoogleDrive.syncLibrary(req.user);
    res.json({ success: true, count: result.count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// Comics Library & Reader Endpoints
// =========================================================================

app.get('/api/comics', (req, res) => {
  const userId = req.user.id;
  const comics = Database.getUserComics(userId);
  res.json(comics);
});

app.get('/api/library/series', (req, res) => {
  const userId = req.user.id;
  const comics = Database.getUserComics(userId);

  // Group by series
  const seriesMap = new Map();
  for (const c of comics) {
    const sName = c.series || c.title || 'Unsorted';
    if (!seriesMap.has(sName)) {
      seriesMap.set(sName, {
        series: sName,
        count: 0,
        ownedItems: [],
        ownedNumbers: [],
        ownedVolumes: [],
        sampleComics: [],
        coverUrl: `/api/comics/${c.id}/cover`
      });
    }
    const entry = seriesMap.get(sName);
    entry.count++;
    entry.ownedItems.push(c.item || c.title);
    entry.sampleComics.push(c.title);
  }

  const seriesList = Array.from(seriesMap.values()).map((s) => ({
    ...s,
    ownedSummary: `${s.count} issues`
  }));

  res.json(seriesList);
});

app.get('/api/comics/:id/pages', async (req, res) => {
  try {
    const comicId = req.params.id;
    let comic = req.user ? Database.getComicById(req.user.id, comicId) : null;
    if (!comic) {
      comic = Database.getComic(comicId);
    }
    if (!comic) return res.status(404).json({ error: 'Comic not found in library' });

    const user = req.user || Database.getUser(comic.userId);
    if (!user) return res.status(401).json({ error: 'Authentication required' });

    const pageInfo = await GoogleDrive.getComicPages(user, comic);
    res.json({
      comicId: comic.id,
      title: comic.title,
      totalPages: pageInfo.totalPages,
      pages: pageInfo.pages
    });
  } catch (err) {
    console.error('[Pages] Error loading comic pages:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/comics/:id/page/:page', async (req, res) => {
  try {
    const comicId = req.params.id;
    let comic = req.user ? Database.getComicById(req.user.id, comicId) : null;
    if (!comic) {
      comic = Database.getComic(comicId);
    }
    if (!comic) return res.status(404).json({ error: 'Comic not found' });

    const user = req.user || Database.getUser(comic.userId);
    if (!user) return res.status(401).json({ error: 'Authentication required' });

    const pageNum = parseInt(req.params.page, 10) || 1;
    const pageData = await GoogleDrive.getComicPage(user, comic, pageNum);

    const etag = `"${comic.id}-${pageNum}-${pageData.data.length}"`;
    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }

    res.setHeader('Content-Type', pageData.mimeType);
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.setHeader('ETag', etag);
    res.setHeader('Content-Length', pageData.data.length);
    res.end(pageData.data);
  } catch (err) {
    console.error('[Page] Error loading comic page:', err.message);
    res.status(404).json({ error: err.message });
  }
});

// Concurrency limiter for cover extractions to respect shared hosting limits
class Semaphore {
  constructor(max) {
    this.max = max;
    this.current = 0;
    this.queue = [];
  }
  async acquire() {
    if (this.current < this.max) {
      this.current++;
      return;
    }
    await new Promise((resolve) => this.queue.push(resolve));
    this.current++;
  }
  release() {
    this.current--;
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      next();
    }
  }
}
const coverExtractionSemaphore = new Semaphore(3);

function generateFallbackCoverSvg(title, series) {
  const cleanTitle = (title || 'Comic').replace(/[<>&"]/g, '');
  const cleanSeries = (series || '').replace(/[<>&"]/g, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450">
    <defs>
      <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#1e1e2f"/>
        <stop offset="100%" stop-color="#11111a"/>
      </linearGradient>
    </defs>
    <rect width="300" height="450" fill="url(#g)" rx="10"/>
    <rect x="15" y="15" width="270" height="420" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="2" rx="8"/>
    <text x="150" y="180" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="38" fill="#4f46e5" text-anchor="middle">📖</text>
    <text x="150" y="240" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="16" font-weight="bold" fill="#f1f5f9" text-anchor="middle">${cleanSeries || cleanTitle}</text>
    <text x="150" y="270" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="13" fill="#94a3b8" text-anchor="middle">${cleanSeries ? cleanTitle : ''}</text>
  </svg>`;
}

app.get('/api/comics/:id/cover', async (req, res) => {
  const comicId = req.params.id;
  try {
    // 1. Check local disk cache directly first (<1ms response)
    if (CacheManager.hasCover(comicId)) {
      const coverPath = CacheManager.getCoverCachePath(comicId);
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
      const stream = fs.createReadStream(coverPath);
      stream.on('error', () => { if (!res.headersSent) res.status(404).end(); });
      return stream.pipe(res);
    }

    // Find comic metadata across users or current user
    let comic = req.user ? Database.getComicById(req.user.id, comicId) : null;
    if (!comic) {
      comic = Database.getComic(comicId);
    }

    // 2. Check disk cover cache by googleFileId
    if (comic && comic.googleFileId && CacheManager.hasCover(comic.googleFileId)) {
      const coverPath = CacheManager.getCoverCachePath(comic.googleFileId);
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
      const stream = fs.createReadStream(coverPath);
      stream.on('error', () => { if (!res.headersSent) res.status(404).end(); });
      return stream.pipe(res);
    }

    if (!comic) {
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.send(generateFallbackCoverSvg('Comic', ''));
    }

    const user = req.user || Database.getUser(comic.userId);

    // 3. If comic has a remote thumbnailLink/coverImage, fetch with auth if available, cache on disk, and stream
    if (comic.coverImage && comic.coverImage.startsWith('http')) {
      try {
        const headers = {};
        if (user) {
          try {
            const accessToken = await GoogleAuth.getValidAccessToken(user);
            headers['Authorization'] = `Bearer ${accessToken}`;
          } catch (e) {}
        }
        const thumbRes = await fetch(comic.coverImage, { headers });
        if (thumbRes.ok) {
          const thumbBuf = Buffer.from(await thumbRes.arrayBuffer());
          CacheManager.saveCoverBuffer(comicId, thumbBuf);
          if (comic.googleFileId) CacheManager.saveCoverBuffer(comic.googleFileId, thumbBuf);
          res.setHeader('Content-Type', 'image/jpeg');
          res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
          return res.end(thumbBuf);
        }
      } catch (e) {
        console.warn('[Cover] Error fetching thumbnail link:', e.message);
      }
    }

    if (!user) {
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.send(generateFallbackCoverSvg(comic.title, comic.series));
    }

    // Limit concurrent cover extractions to 3 at a time to prevent server overload
    await coverExtractionSemaphore.acquire();
    try {
      const cover = await GoogleDrive.getComicCover(user, comic);
      CacheManager.saveCoverBuffer(comicId, cover.data);
      if (comic.googleFileId) CacheManager.saveCoverBuffer(comic.googleFileId, cover.data);
      res.setHeader('Content-Type', cover.mimeType);
      res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
      res.end(cover.data);
    } finally {
      coverExtractionSemaphore.release();
    }
  } catch (err) {
    console.warn('[Cover] Error loading cover for', comicId, ':', err.message);
    const comic = Database.getComic(comicId);
    const svg = generateFallbackCoverSvg(comic?.title, comic?.series);
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(svg);
  }
});

app.delete('/api/comics/:id', requireLogin, async (req, res) => {
  try {
    const result = await GoogleDrive.deleteComic(req.user, req.params.id);
    res.json({ success: true, ...result });
  } catch (err) {
    logger.log('ERROR', `[DELETE /api/comics/:id] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/comics/delete', requireLogin, async (req, res) => {
  try {
    const { comicIds } = req.body;
    const result = await GoogleDrive.deleteComics(req.user, comicIds);
    res.json({ success: true, ...result });
  } catch (err) {
    logger.log('ERROR', `[POST /api/comics/delete] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/comics/:id', requireLogin, async (req, res) => {
  try {
    const { title, series, item, isVolume } = req.body || {};
    const updated = await GoogleDrive.updateComicMetadata(req.user, req.params.id, {
      title,
      series,
      item,
      isVolume
    });
    res.json({ success: true, comic: updated });
  } catch (err) {
    logger.log('ERROR', `[PATCH /api/comics/:id] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/comics/:id/edit', requireLogin, async (req, res) => {
  try {
    const { title, series, item, isVolume } = req.body || {};
    const updated = await GoogleDrive.updateComicMetadata(req.user, req.params.id, {
      title,
      series,
      item,
      isVolume
    });
    res.json({ success: true, comic: updated });
  } catch (err) {
    logger.log('ERROR', `[POST /api/comics/:id/edit] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// Favorites & Reading Progress Endpoints
// =========================================================================

app.get(['/api/favorites', '/api/favorites/:profileId'], (req, res) => {
  const userId = req.user.id;
  res.json(Database.getFavorites(userId));
});

app.post('/api/favorites', (req, res) => {
  const userId = req.user.id;
  const { comicId, isFavorite, favorites } = req.body || {};
  if (Array.isArray(favorites)) {
    const updated = Database.saveFavorites(userId, favorites);
    return res.json({ success: true, favorites: updated });
  }
  const updated = Database.toggleFavorite(userId, comicId, isFavorite);
  if (req.user?.driveFolderId) {
    const favFileName = GoogleDrive.getUserMetaFilename(req.user, 'comics-favorites.json');
    GoogleDrive.writeJsonFile(req.user, req.user.driveFolderId, favFileName, {
      version: 1,
      updatedAt: Date.now(),
      favorites: Database.getFavorites(userId),
      seriesFavorites: Database.getSeriesFavorites(userId)
    }).catch(() => {});
  }
  res.json({ success: true, favorites: updated });
});

app.get(['/api/favorites/series', '/api/favorites/series/:profileId'], (req, res) => {
  const userId = req.user.id;
  res.json(Database.getSeriesFavorites(userId));
});

app.post('/api/favorites/series', (req, res) => {
  const userId = req.user.id;
  const { seriesName, isFavorite, seriesFavorites } = req.body || {};
  if (Array.isArray(seriesFavorites)) {
    const updated = Database.saveSeriesFavorites(userId, seriesFavorites);
    return res.json({ success: true, seriesFavorites: updated });
  }
  const updated = Database.toggleSeriesFavorite(userId, seriesName, isFavorite);
  if (req.user?.driveFolderId) {
    const favFileName = GoogleDrive.getUserMetaFilename(req.user, 'comics-favorites.json');
    GoogleDrive.writeJsonFile(req.user, req.user.driveFolderId, favFileName, {
      version: 1,
      updatedAt: Date.now(),
      favorites: Database.getFavorites(userId),
      seriesFavorites: Database.getSeriesFavorites(userId)
    }).catch(() => {});
  }
  res.json({ success: true, seriesFavorites: updated });
});

app.get('/api/progress/:id', (req, res) => {
  if (!req.user) return res.json({});
  const id = req.params.id;
  if (id === req.user.id || id === '1' || id === 'default') {
    return res.json(Database.getReadingProgress(req.user.id));
  }
  const comicProgress = Database.getReadingProgress(req.user.id, id);
  if (comicProgress) {
    return res.json({
      ...comicProgress,
      [id]: comicProgress
    });
  }
  // Fallback to all user progress
  res.json(Database.getReadingProgress(req.user.id));
});

app.get('/api/progress', (req, res) => {
  if (!req.user) return res.json({});
  res.json(Database.getReadingProgress(req.user.id));
});

app.post('/api/progress', requireLogin, (req, res) => {
  const { comicId, page, totalPages, zoomNormX, zoomNormY } = req.body || {};
  if (!comicId) return res.status(400).json({ error: 'comicId is required' });
  const updated = Database.saveReadingProgress(req.user.id, comicId, page, totalPages, zoomNormX, zoomNormY);
  if (req.user?.driveFolderId) {
    const progFileName = GoogleDrive.getUserMetaFilename(req.user, 'comics-progress.json');
    GoogleDrive.writeJsonFile(req.user, req.user.driveFolderId, progFileName, Database.getReadingProgress(req.user.id)).catch(() => {});
  }
  res.json({ success: true, progress: updated });
});

// =========================================================================
// GetComics Scraper & Downloads Endpoints
// =========================================================================

app.get('/api/latest-releases', async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const releases = await ComicScraper.scrapeLatestReleases(page);
    res.json(releases);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/search', async (req, res) => {
  try {
    const q = req.query.q || '';
    if (!q.trim()) {
      return res.json({ local: [], online: [], total: 0 });
    }

    // 1. Search local Google Drive comics
    const ownedComics = req.user ? Database.getUserComics(req.user.id) : [];
    const local = ownedComics.filter((c) =>
      (c.title || '').toLowerCase().includes(q.toLowerCase()) ||
      (c.series || '').toLowerCase().includes(q.toLowerCase())
    );

    // 2. Search GetComics catalog
    const online = await ComicScraper.searchGetComics(q);

    // Mark online items if already in library
    const ownedTitles = new Set(ownedComics.map((c) => (c.title || '').toLowerCase().trim()));
    const enrichedOnline = online.map((o) => ({
      ...o,
      inLibrary: ownedTitles.has((o.title || '').toLowerCase().trim())
    }));

    res.json({
      query: q,
      local,
      online: enrichedOnline,
      total: local.length + online.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/scrape/inspect', async (req, res) => {
  try {
    const { url } = req.body;
    const info = await ComicScraper.inspectChapter(url);
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Starts a BACKGROUND download job. Returns immediately so the shared-hosting proxy
// never times out with a 503. The client then polls /api/scrape/download/status/:jobId.
app.post('/api/scrape/download', requireLogin, (req, res) => {
  try {
    const { url, seriesName } = req.body || {};
    if (!url) return res.status(400).json({ error: 'url is required' });

    if (!req.user.driveFolderId) {
      return res.status(400).json({ error: 'Please select a Google Drive comics folder in Settings first.' });
    }

    const job = DownloadManager.start(req.user, url, seriesName || '');
    res.status(202).json({
      success: true,
      jobId: job.id,
      status: job.status,
      message: 'Download started.'
    });
  } catch (err) {
    console.error('[Download] Failed to start download:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Polls the status of a background download job.
app.get('/api/scrape/download/status/:jobId', requireLogin, (req, res) => {
  const job = DownloadManager.status(req.params.jobId, req.user.id);
  if (!job) return res.status(404).json({ error: 'Download job not found or expired.' });
  res.setHeader('Cache-Control', 'no-store');
  res.json(job);
});

// =========================================================================
// Omnibus Creator Endpoints
// =========================================================================

// Starts a background omnibus creation and packaging job
app.post('/api/omnibus/merge', requireLogin, (req, res) => {
  try {
    const { issueIds, omnibusTitle, seriesName } = req.body || {};
    if (!Array.isArray(issueIds) || issueIds.length < 2) {
      return res.status(400).json({ error: 'Please select at least 2 comic issues to merge into an omnibus.' });
    }

    const job = OmnibusManager.start(req.user, { issueIds, omnibusTitle, seriesName });
    res.status(202).json({
      success: true,
      jobId: job.id,
      status: job.status,
      phase: job.phase
    });
  } catch (err) {
    console.error('[Omnibus] Failed to start omnibus creation:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Polls the status of an omnibus creation job
app.get('/api/omnibus/status/:jobId', requireLogin, (req, res) => {
  const job = OmnibusManager.getStatus(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Omnibus job not found or expired.' });
  res.setHeader('Cache-Control', 'no-store');
  res.json(job);
});

// Deletes the source single issues after user confirms
app.post('/api/omnibus/delete-singles', requireLogin, async (req, res) => {
  try {
    const { issueIds } = req.body || {};
    if (!Array.isArray(issueIds) || issueIds.length === 0) {
      return res.status(400).json({ error: 'No issue IDs provided for deletion.' });
    }
    const result = await OmnibusManager.deleteSingleIssues(req.user, issueIds);
    res.json(result);
  } catch (err) {
    console.error('[Omnibus] Error deleting single issues:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// Omnibus Splitter Endpoints
// =========================================================================

// Reads the page count of a comic for the splitter UI. Pass ?volumes=N to also
// get back the exact per-volume page ranges and file names that would be written.
app.get('/api/omnibus/split/inspect/:comicId', requireLogin, async (req, res) => {
  try {
    const info = await OmnibusManager.inspectComic(
      req.user,
      req.params.comicId,
      req.query.volumes
    );
    res.json(info);
  } catch (err) {
    console.error('[OmnibusSplit] Failed to inspect comic:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Starts a background job that splits one omnibus into evenly sized volumes
app.post('/api/omnibus/split', requireLogin, (req, res) => {
  try {
    const { comicId, volumeCount, baseTitle } = req.body || {};
    const job = OmnibusManager.startSplit(req.user, { comicId, volumeCount, baseTitle });
    res.status(202).json({
      success: true,
      jobId: job.id,
      status: job.status,
      phase: job.phase
    });
  } catch (err) {
    console.error('[OmnibusSplit] Failed to start split job:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// Polls the status of an omnibus split job
app.get('/api/omnibus/split/status/:jobId', requireLogin, (req, res) => {
  const job = OmnibusManager.getStatus(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Omnibus split job not found or expired.' });
  res.setHeader('Cache-Control', 'no-store');
  res.json(job);
});

// Deletes the original omnibus after the user confirms the split worked out
app.post('/api/omnibus/split/delete-source', requireLogin, async (req, res) => {
  try {
    const { comicId } = req.body || {};
    const result = await OmnibusManager.deleteSourceOmnibus(req.user, comicId);
    res.json(result);
  } catch (err) {
    console.error('[OmnibusSplit] Error deleting source omnibus:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// =========================================================================
// My Pull List Endpoints
// =========================================================================

app.get(['/api/pull-list', '/api/pull-list/status'], (req, res) => {
  const userId = req.user.id;
  res.json(Database.getPullList(userId));
});

app.post('/api/pull-list', (req, res) => {
  const userId = req.user.id;
  const { series } = req.body || {};
  const updated = Database.savePullList(userId, series);
  res.json({ success: true, ...updated });
});

app.post('/api/pull-list/toggle', (req, res) => {
  const userId = req.user.id;
  const { enabled } = req.body || {};
  const updated = Database.setPullListEnabled(userId, enabled);
  res.json({ success: true, ...updated });
});

app.post('/api/pull-list/check', requireLogin, async (req, res) => {
  try {
    const { autoDownload } = req.body || {};
    const results = await PullListManager.scanPullList(req.user, Boolean(autoDownload));
    res.json({ success: true, ...results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// Settings Endpoints
// =========================================================================

app.get('/api/settings', (req, res) => {
  if (!req.user) {
    return res.json({
      driveFolderId: null,
      driveFolderName: null,
      organizeBySeries: true,
      autoScan: true
    });
  }
  const settings = Database.getUserSettings(req.user.id);
  res.json({
    ...settings,
    driveFolderId: req.user.driveFolderId,
    driveFolderName: req.user.driveFolderName
  });
});

app.post('/api/settings', requireLogin, (req, res) => {
  const updated = Database.saveUserSettings(req.user.id, req.body);
  res.json({
    success: true,
    ...updated,
    driveFolderId: req.user.driveFolderId,
    driveFolderName: req.user.driveFolderName
  });
});

// =========================================================================
// Admin endpoints are restricted to the server-configured ADMIN_EMAIL.
// =========================================================================

function requireAdmin(req, res, next) {
  if (!isAdminUser(req.user)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// Requeue in-flight downloads and restart the detached download worker.
app.post('/api/admin/restart-downloader', requireAdmin, (req, res) => {
  try {
    const result = DownloadManager.restartWorker();
    logger.log('INFO', `[Admin] Download worker restarted: ${JSON.stringify(result)}`);
    res.json({
      success: true,
      message: 'Download worker restarted.',
      ...result
    });
  } catch (err) {
    logger.log('ERROR', `[Admin] Restart downloader failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Soft-restart this app server. Passenger respawns the worker when it exits.
app.post('/api/admin/restart-app', requireAdmin, (req, res) => {
  logger.log('INFO', '[Admin] App server restart requested by admin.');
  res.json({ success: true, message: 'COMIXOLOFREE server is restarting…' });
  setTimeout(() => {
    try { process.exit(0); } catch (e) {}
  }, 600);
});

// Lightweight liveness probe (no dependencies): confirms the Node app is running.
app.get('/api/ping', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, ts: Date.now() });
});

// Legacy status check endpoint
app.get(['/api/status', '/api/health'], (req, res) => {
  let compressor = null;
  try { compressor = ComicCompressor.getStatus(); } catch (e) {}
  res.json({
    status: 'ok',
    version: '1.0.0',
    mode: 'cloud',
    storage: 'google_drive',
    userCount: Object.keys(Database.getUserComics('')).length,
    compression: {
      enabledByDefault: true,
      defaultQuality: 75,
      engines: compressor
    }
  });
});


// =========================================================================
// Static Assets & SPA Client Serving
// =========================================================================

const distPath = path.join(__dirname, '..', 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath, {
    maxAge: '30d',
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
      } else if (filePath.includes('assets')) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (filePath.endsWith('sw.js') || filePath.endsWith('manifest.webmanifest')) {
        // Service worker + manifest must never be stale-cached, or updates get stuck.
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
    }
  }));

  app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    if (req.path.startsWith('/api/')) return next();
    const indexPath = path.join(distPath, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
      res.sendFile(indexPath);
    } else {
      next();
    }
  });
} else {
  logger.log('WARN', `dist/ not found at ${distPath} — frontend will not be served by Express`);
}

// Startup breadcrumbs: makes it obvious in the log that the app fully configured.
try {
  logger.log('INFO', `Compression engines: ${JSON.stringify(ComicCompressor.getStatus())}`);
} catch (e) {
  logger.log('WARN', `Could not read compression status: ${e.message}`);
}

// Probe the native sharp binary in a CHILD process. If sharp is broken on this
// host (bad CPU/glibc), the child dies but the server keeps running, and the log
// records exactly what happened.
try {
  const { execFileSync } = require('child_process');
  let sharpResolvable = true;
  try { require.resolve('sharp'); } catch (e) { sharpResolvable = false; }
  if (sharpResolvable) {
    const out = execFileSync(
      process.execPath,
      ['-e', "require('sharp'); process.stdout.write('sharp-probe-ok');"],
      { timeout: 15000, stdio: 'pipe', cwd: __dirname }
    ).toString();
    logger.log('INFO', `Sharp native probe: ${out.includes('sharp-probe-ok') ? 'OK (sharp will be used)' : 'unexpected output: ' + out}`);
  } else {
    logger.log('WARN', 'Sharp is not installed; compression will use the pure-JS encoder (slower).');
  }
} catch (e) {
  const detail = (e && e.status !== undefined) ? `exit code ${e.status}` : (e && e.message) || String(e);
  logger.log('WARN', `Sharp native probe FAILED (${detail}). Sharp will be avoided; pure-JS will be used.`);
}
logger.log('INFO', 'Express app configured: all routes registered. Startup complete.');

module.exports = app;
