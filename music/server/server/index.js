import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { config, ROOT_DIR, ensureDirs } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import db from './db.js';
import googleAuth from './googleAuth.js';
import googleDrive, { renderPlaceholderSvg } from './googleDrive.js';
import abbClient from './abbClient.js';
import youtubeMusic from './youtubeMusic.js';
import youtubeApi from './youtubeApi.js';
import torrentNode from './torrentNode.js';
import downloadManager from './downloadManager.js';
import metaStore from './metaStore.js';
import offlineCache, { cacheUsage, localFileFor, getOfflineItemIds } from './offlineCache.js';
import binManager from './binManager.js';
import { attachClient, broadcast, clientCount, recentEvents } from './events.js';
import { formatDuration, inferGenreFromText } from './libraryParser.js';
import { groupAudiobookItems } from './bookGrouper.js';

function isAdminUser(user) {
  const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  return !!user && !!adminEmail && String(user.email || '').trim().toLowerCase() === adminEmail;
}

/**
 * FRAUDIO HTTP API.
 *
 * Every /api route except the small auth/health whitelist requires a Google
 * session. Google Drive folders are chosen per user: one for audiobooks and one
 * for music.
 */

const app = express();
app.set('trust proxy', 1);

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(googleAuth.middleware);

app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/api') && !req.path.startsWith('/api/events')) {
      console.log(`[API] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - started}ms)`);
    }
  });
  next();
});

// =========================================================================
// Authentication
// =========================================================================

const PUBLIC_PATHS = new Set([
  '/api/auth/google/url',
  '/api/auth/google/callback',
  '/api/auth/me',
  '/api/auth/logout',
  '/api/ping',
  '/api/health',
  // Machine-to-machine callbacks from the VPS torrent node. These have no Google
  // session, so they are gated by the shared x-node-secret instead.
  '/api/downloads/webhook',
  '/api/downloads/token-refresh'
]);

app.use('/api', (req, res, next) => {
  const clean = (req.originalUrl || req.url).split('?')[0];
  if (PUBLIC_PATHS.has(clean)) return next();
  if (!req.user) {
    return res.status(401).json({ error: 'Sign in with Google to continue.', code: 'UNAUTHENTICATED' });
  }
  next();
});

app.get('/api/auth/google/url', (req, res) => {
  try {
    res.json({ url: googleAuth.getAuthUrl(req) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/auth/google/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect(`/?auth_error=${encodeURIComponent(String(error))}`);
  if (!code) return res.redirect('/?auth_error=no_code');

  try {
    const user = await googleAuth.handleCallback(String(code), req);
    res.cookie(googleAuth.SESSION_COOKIE, googleAuth.createSessionToken(user), googleAuth.cookieOptions(req));
    res.redirect('/');

    // Restore progress / favourites / playlists from the Drive JSON documents.
    // Done after the redirect so sign-in is never slowed by Drive latency.
    metaStore.loadAll(user)
      .then(() => {
        if (user.audiobooksFolderId || user.musicFolderId) {
          console.log(`[META] Restored Drive metadata for ${user.email || user.id}`);
          broadcast('library_changed', { reason: 'meta-restored' });
        }
      })
      .catch((err) => console.warn('[META] login restore failed:', err.message));
  } catch (err) {
    console.error('[Auth] Callback failed:', err.message);
    res.redirect(`/?auth_error=${encodeURIComponent(err.message)}`);
  }
});

app.get('/api/auth/me', (req, res) => {
  const user = googleAuth.publicProfile(req.user);
  res.json({
    authenticated: Boolean(req.user),
    user: user ? { ...user, isAdmin: isAdminUser(req.user) } : null,
    ...(req.vipAccessDenied ? { code: 'VIP_ONLY', error: googleAuth.vipOnlyMessage } : {})
  });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie(googleAuth.SESSION_COOKIE);
  res.json({ success: true });
});

// =========================================================================
// Events (SSE)
// =========================================================================

app.get('/api/events', attachClient);

app.get('/api/events/poll', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ events: recentEvents(Number(req.query.since) || 0), clients: clientCount() });
});

// =========================================================================
// Drive folder selection
// =========================================================================

app.get('/api/drive/status', (req, res) => {
  res.json({
    audiobooksFolderId: req.user.audiobooksFolderId,
    audiobooksFolderName: req.user.audiobooksFolderName,
    musicFolderId: req.user.musicFolderId,
    musicFolderName: req.user.musicFolderName
  });
});

app.get('/api/drive/folders', async (req, res) => {
  try {
    res.json(await googleDrive.listFolders(req.user, String(req.query.parentId || 'root')));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/drive/folders', async (req, res) => {
  try {
    const { name, parentId } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ error: 'Folder name is required.' });
    res.json(await googleDrive.createFolder(req.user, name.trim(), parentId || 'root'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** kind: 'audiobooks' | 'music' */
app.post('/api/drive/select-folder', async (req, res) => {
  try {
    const { kind = 'audiobooks', folderId, folderName } = req.body || {};
    if (!folderId) return res.status(400).json({ error: 'folderId is required.' });
    if (!['audiobooks', 'music'].includes(kind)) {
      return res.status(400).json({ error: 'kind must be "audiobooks" or "music".' });
    }

    let finalName = folderName;
    if (!finalName) {
      const info = await googleDrive.getFolderInfo(req.user, folderId);
      finalName = info.name;
    }

    const updated = db.setUserFolder(req.user.id, kind, folderId, finalName);
    // The folder may be a different one, so any cached Drive file ids are stale.
    metaStore.reset(req.user.id);
    const profile = googleAuth.publicProfile(updated);
    res.json({ success: true, kind, user: profile });

    // Pull the visible JSON document for this library, then write it back so the
    // file exists from the moment a folder is chosen.
    metaStore.loadAll(req.user)
      .then(() => metaStore.flush(req.user.id))
      .catch((err) => console.warn('[META] load after folder change failed:', err.message));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/drive/breadcrumbs/:folderId', async (req, res) => {
  try {
    const crumbs = [];
    let currentId = req.params.folderId;
    for (let depth = 0; depth < 12 && currentId && currentId !== 'root'; depth += 1) {
      const info = await googleDrive.getFolderInfo(req.user, currentId);
      crumbs.unshift({ id: info.id, name: info.name });
      currentId = info.parents?.[0];
    }
    crumbs.unshift({ id: 'root', name: 'My Drive' });
    res.json(crumbs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// Library
// =========================================================================

/** Full library for a kind, with progress/favourite flags attached. */
app.get('/api/library', (req, res) => {
  const kind = req.query.kind === 'music' ? 'music' : 'audiobooks';
  const items = db.getUserItems(req.user.id, kind === 'music' ? 'track' : 'audiobook');
  const progress = db.getProgress(req.user.id);
  const favorites = new Set(db.getFavorites(req.user.id));

  const decorated = items.map((item) => ({
    ...item,
    coverUrl: `/api/items/${item.id}/cover`,
    offline: Boolean(localFileFor(item.id)),
    progress: progress[item.id] || null,
    favorite: favorites.has(item.id)
  }));
  return res.json({
    kind,
    items: decorated,
    books: kind === 'audiobooks' ? groupAudiobookItems(decorated) : undefined
  });
  /* res.json({
    kind,
    items: items.map((item) => ({
      ...item,
      coverUrl: `/api/items/${item.id}/cover`,
      offline: Boolean(localFileFor(item.id)),
      progress: progress[item.id] || null,
      favorite: favorites.has(item.id)
    }))
  }); */
});

const activeScans = new Map();

app.post('/api/library/scan', async (req, res) => {
  const kind = req.body?.kind === 'music' ? 'music' : 'audiobooks';
  const scanKey = `${req.user?.id || 'anon'}:${kind}`;
  if (activeScans.has(scanKey)) {
    try {
      const existing = await activeScans.get(scanKey);
      return res.json({ success: true, kind, count: existing?.count || 0, smart: existing?.smart || {} });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
  let resolveScan, rejectScan;
  const currentScanPromise = new Promise((resolve, reject) => { resolveScan = resolve; rejectScan = reject; });
  activeScans.set(scanKey, currentScanPromise);
  try {
const result = await googleDrive.syncLibrary(req.user, kind, {
        protectFileIds: req.body?.protectFileIds || [],
        onProgress: (p) => broadcast('library_scan', { userId: req.user.id, kind, ...p })
      });
      // Newly discovered files are exactly what smart-playlist rules want to
      // see; the engine is music-only and idempotent so this is cheap.
      let smart = {};
      try {
        smart = db.applySmartPlaylists(req.user.id);
      } catch (err) {
        console.warn('[SmartPlaylists] post-scan apply failed:', err.message);
      }
      broadcast('library_changed', { userId: req.user.id, reason: 'scan', kind });
      broadcast('library_scan', { userId: req.user.id, kind, done: true, phase: 'done' });
      resolveScan?.({ count: result.count, smart });
      res.json({ success: true, kind, count: result.count, smart });
  } catch (err) {
    console.error('[Library] Scan failed:', err.message);
    broadcast('library_scan', { userId: req.user.id, kind, done: true, error: err.message });
    rejectScan?.(err);
    res.status(500).json({ error: err.message });
  } finally {
    activeScans.delete(scanKey);
  }
});

function collectGenres(items, isMusic = true) {
  const map = new Map();
  for (const item of items) {
    let genreStr = item.genre;
    if (!genreStr && isMusic) {
      genreStr = inferGenreFromText([item.album, item.artist, item.albumArtist, item.drivePath, item.title].filter(Boolean).join(' '));
    }
    if (!genreStr && isMusic) {
      genreStr = 'Uncategorized';
    }
    if (!genreStr) continue;
    const parts = String(genreStr)
      .split(/[,;/]+/)
      .map((g) => g.trim())
      .filter((g) => g.length > 0 && g.length < 50);
    for (const raw of parts) {
      const key = raw.toLowerCase();
      if (!map.has(key)) {
        map.set(key, {
          name: raw,
          count: 0,
          trackCount: 0,
          bookCount: 0,
          durationSec: 0,
          lastAdded: null,
          coverUrl: item.coverUrl || null
        });
      }
      const entry = map.get(key);
      entry.count += 1;
      if (isMusic) entry.trackCount += 1;
      else entry.bookCount += 1;
      entry.durationSec += item.durationSec || 0;
      if (!entry.lastAdded || (item.addedAt || '') > entry.lastAdded) {
        entry.lastAdded = item.addedAt || null;
      }
      if (!entry.coverUrl && item.coverUrl) {
        entry.coverUrl = item.coverUrl;
      }
    }
  }
  return Array.from(map.values()).sort((a, b) => {
    if (a.name === 'Uncategorized') return 1;
    if (b.name === 'Uncategorized') return -1;
    return a.name.localeCompare(b.name);
  });
}

/** Groups the library for the browse views. */
app.get('/api/library/groups', (req, res) => {
  const kind = req.query.kind === 'music' ? 'music' : 'audiobooks';
  const items = db.getUserItems(req.user.id, kind === 'music' ? 'track' : 'audiobook');
  const progress = db.getProgress(req.user.id);
  const favorites = new Set(db.getFavorites(req.user.id));

  const decorated = items.map((item) => ({
    ...item,
    genre: (!item.genre && kind === 'music')
      ? (inferGenreFromText([item.album, item.artist, item.albumArtist, item.drivePath, item.title].filter(Boolean).join(' ')) || '')
      : (item.genre || ''),
    coverUrl: `/api/items/${item.id}/cover`,
    offline: Boolean(localFileFor(item.id)),
    favorite: favorites.has(item.id),
    progressSec: progress[item.id]?.positionSec || 0,
    // The UI can sort by "recently played"; updatedAt is the resume stamp.
    lastPlayed: progress[item.id]?.updatedAt || null
  }));

  if (kind === 'music') {
    const albums = new Map();
    for (const track of decorated) {
      const key = `${track.albumArtist || track.artist}::${track.album}`;
      if (!albums.has(key)) {
        albums.set(key, {
          key,
          artist: track.albumArtist || track.artist,
          album: track.album,
          coverUrl: track.coverUrl,
          durationSec: 0,
          lastAdded: null,
          tracks: []
        });
      }
      const entry = albums.get(key);
      entry.durationSec += track.durationSec || 0;
      if (!entry.lastAdded || (track.addedAt || '') > entry.lastAdded) entry.lastAdded = track.addedAt || null;
      entry.tracks.push(track);
    }
    const artists = new Map();
    for (const track of decorated) {
      const artist = track.albumArtist || track.artist;
      if (!artists.has(artist)) artists.set(artist, { name: artist, albumCount: 0, trackCount: 0, durationSec: 0, lastAdded: null });
      const entry = artists.get(artist);
      entry.trackCount += 1;
      entry.durationSec += track.durationSec || 0;
      if (!entry.lastAdded || (track.addedAt || '') > entry.lastAdded) entry.lastAdded = track.addedAt || null;
      const albumKey = `${artist}::${track.album}`;
      if (!entry._albums) entry._albums = new Set();
      if (!entry._albums.has(albumKey)) { entry._albums.add(albumKey); entry.albumCount += 1; }
    }
    return res.json({
      kind,
      items: decorated,
      albums: Array.from(albums.values()).map((a) => ({
        ...a,
        tracks: a.tracks.sort((x, y) => (x.trackNumber || 0) - (y.trackNumber || 0) || x.title.localeCompare(y.title))
      })),
      artists: Array.from(artists.values()).map(({ _albums, ...rest }) => rest),
      genres: collectGenres(decorated, true)
    });
  }

  const books = groupAudiobookItems(decorated);
  const authors = new Map();
  for (const book of books) {
    if (!authors.has(book.author)) {
      authors.set(book.author, { name: book.author, bookCount: 0, totalSec: 0, lastAdded: null, coverUrl: book.coverUrl });
    }
    const entry = authors.get(book.author);
    entry.bookCount += 1;
    entry.totalSec += book.durationSec || 0;
    if (!entry.lastAdded || (book.addedAt || '') > entry.lastAdded) entry.lastAdded = book.addedAt || null;
    if (entry.coverUrl === book.coverUrl && !book.coverImage) entry.coverUrl = null;
  }

  const series = new Map();
  for (const book of books) {
    if (!book.series) continue;
    if (!series.has(book.series)) {
      series.set(book.series, { name: book.series, bookCount: 0, author: book.author, coverUrl: book.coverUrl, lastAdded: null, durationSec: 0, books: [] });
    }
    const entry = series.get(book.series);
    entry.bookCount += 1;
    entry.durationSec += book.durationSec || 0;
    if (!entry.lastAdded || (book.addedAt || '') > entry.lastAdded) entry.lastAdded = book.addedAt || null;
    entry.books.push(book);
  }

  for (const entry of series.values()) {
    entry.books.sort((a, b) => {
      if (a.seriesIndex != null && b.seriesIndex != null) return a.seriesIndex - b.seriesIndex;
      if (a.seriesIndex != null) return -1;
      if (b.seriesIndex != null) return 1;
      return a.title.localeCompare(b.title);
    });
  }

  return res.json({
    kind,
    items: decorated,
    books,
    authors: Array.from(authors.values()).sort((a, b) => a.name.localeCompare(b.name)),
    series: Array.from(series.values()).sort((a, b) => a.name.localeCompare(b.name)),
    genres: collectGenres(books, false)
  });
});

// =========================================================================
// YouTube Music: new releases feed
// =========================================================================

app.get('/api/music/whats-new', async (req, res) => {
  try {
    const albums = await youtubeMusic.newReleases({ force: req.query.refresh === 'true' });
    return res.json({ albums });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
});

app.get('/api/music/album/tracks', async (req, res) => {
  try {
    // Accept either the OLAK playlist id or the MPREb album id; the scraper
    // resolves the former, the album page the latter.
    const albumRef = String(req.query.playlistId || req.query.albumId || '');
    if (!albumRef) return res.status(400).json({ error: 'playlistId or albumId is required.' });
    const tracks = await youtubeMusic.albumTracks(albumRef);
    return res.json({ tracks });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/music/album/download', (req, res) => {
  const { id, playlistId, title, artist, album, coverUrl } = req.body || {};
  if (!playlistId && !id) return res.status(400).json({ error: 'playlistId is required.' });
  if (!req.user.musicFolderId) {
    return res.status(400).json({ error: 'Pick a music folder in Settings before downloading.' });
  }
  try {
    const job = youtubeMusic.startAlbumDownload(req.user, {
      id, playlistId, title, artist, album: album || title, coverUrl
    });
    return res.json({ job });
  } catch (err) {
    return res.status(409).json({ error: err.message });
  }
});

app.get('/api/music/album/download/:jobId', (req, res) => {
  const job = youtubeMusic.jobStatus(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Unknown download job.' });
  return res.json({ job });
});

app.get('/api/music/search', async (req, res) => {
  try {
    const results = await youtubeMusic.search(String(req.query.q || ''), {
      force: req.query.refresh === 'true'
    });
    return res.json(results);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
});

app.get('/api/music/artist/:channelId', async (req, res) => {
  try {
    const results = await youtubeMusic.artistBrowse(String(req.params.channelId || ''), {
      force: req.query.refresh === 'true'
    });
    return res.json(results);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
});

app.post('/api/music/song/download', (req, res) => {
  const songs = Array.isArray(req.body?.songs) ? req.body.songs : [req.body?.song];
  const usable = songs.filter((s) => s?.videoId);
  if (!usable.length) return res.status(400).json({ error: 'A song with a videoId is required.' });
  if (usable.length > 25) return res.status(400).json({ error: 'Too many songs at once (max 25).' });
  if (!req.user.musicFolderId) {
    return res.status(400).json({ error: 'Pick a music folder in Settings before downloading.' });
  }
  try {
    const job = youtubeMusic.startSongDownload(req.user, usable);
    return res.json({ job });
  } catch (err) {
    return res.status(409).json({ error: err.message });
  }
});

// =========================================================================
// Music download queue
// =========================================================================

/** Preview a pasted YouTube Music playlist URL without downloading anything. */
app.get('/api/music/playlist/info', async (req, res) => {
  try {
    const listId = youtubeMusic.parsePlaylistRef(String(req.query.url || ''));
    const info = await youtubeMusic.playlistPreview(listId, { force: req.query.refresh === 'true', userId: req.user.id });
    return res.json(info);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

/** Queue every track of a pasted playlist, creating a matching FRAUDIO playlist. */
app.post('/api/music/playlist/download', (req, res) => {
  const { url, name } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Playlist URL is required.' });
  if (!req.user.musicFolderId) {
    return res.status(400).json({ error: 'Pick a music folder in Settings before downloading.' });
  }
  try {
    // Parse before queueing so a bad URL fails with a useful message immediately.
    youtubeMusic.parsePlaylistRef(String(url));
    const job = youtubeMusic.startPlaylistDownload(req.user, { url, name });
    return res.json({ job });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

// =========================================================================
// YouTube Data API (OAuth): Liked Music without cookies
// =========================================================================

/** Count/list the account's Liked videos playlist via the session token. */
app.get('/api/youtube/liked', async (req, res) => {
  try {
    const liked = await youtubeApi.listLikedVideoIds(req.user, { max: 500 });
    return res.json({
      total: liked.total,
      count: liked.videoIds.length,
      tracks: liked.videoIds
    });
  } catch (err) {
    if (err.reason === 'accessNotConfigured') {
      return res.status(403).json({
        code: 'API_NOT_ENABLED',
        error: 'Enable "YouTube Data API v3" in the same Google Cloud project as your OAuth client: https://console.cloud.google.com/apis/library/youtube.googleapis.com'
      });
    }
    if (youtubeApi.isMissingYoutubeAccess(err)) {
      return res.status(403).json({
        code: 'YOUTUBE_SCOPE',
        error: 'YouTube rejected this session. Sign out and reconnect your Google account so the new YouTube permission is granted.'
      });
    }
    return res.status(502).json({ error: err.message });
  }
});

/**
 * The account's YouTube playlists for the import picker, each flagged with
 * whether FRAUDIO already created a playlist for it. The mapping by YouTube
 * playlist id survives renames; the name match catches playlists imported
 * before the map existed.
 */
app.get('/api/youtube/playlists', async (req, res) => {
  try {
    const { playlists, hasChannel } = await youtubeApi.listOwnedPlaylists(req.user);
    const mine = db.getPlaylists(req.user.id, 'music');
    const byId = new Map(mine.map((p) => [p.id, p]));
    const byName = new Map(mine.map((p) => [p.name.toLowerCase(), p]));
    const map = db.getSettings(req.user.id).youtubeImportMap || {};
    const enriched = playlists.map((p) => {
      const mapped = map[p.playlistId] && byId.get(map[p.playlistId]);
      const named = byName.get(p.title.toLowerCase());
      const linked = mapped || named || null;
      return { ...p, fraudioPlaylistId: linked?.id || null, imported: Boolean(linked) };
    });
    return res.json({ playlists: enriched, hasChannel });
  } catch (err) {
    if (err.reason === 'accessNotConfigured') {
      return res.status(403).json({ code: 'API_NOT_ENABLED', error: err.message });
    }
    return res.status(502).json({ error: err.message });
  }
});

/** Queue the whole Liked videos playlist as one download job. */
app.post('/api/youtube/liked/import', (req, res) => {
  if (!req.user.musicFolderId) {
    return res.status(400).json({ error: 'Pick a music folder in Settings before downloading.' });
  }
  try {
    return res.json({ job: youtubeMusic.startLikedImport(req.user) });
  } catch (err) {
    return res.status(409).json({ error: err.message });
  }
});

/** Live jobs (queued/running/done/error within a short window), newest last. */
app.get('/api/music/jobs', (req, res) => {
  res.json({ jobs: youtubeMusic.jobList() });
});

app.get('/api/music/jobs/:jobId', (req, res) => {
  const job = youtubeMusic.jobStatus(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Unknown download job.' });
  return res.json({ job });
});

app.post('/api/music/jobs/:jobId/cancel', (req, res) => {
  return res.json({ success: youtubeMusic.cancelJob(req.params.jobId) });
});

// =========================================================================
// Smart playlists (genre keyword rules, music-only)
// =========================================================================

// A starting point for the "Add starter rules" button - broad keywords, no
// genre-taxonomy pretence; users edit freely afterwards.
const SMART_PLAYLIST_PRESETS = [
  { name: 'Hip Hop / Rap', keywords: ['hip hop', 'hip-hop', 'rap', 'trap', 'drill', 'phonk', 'boom bap', 'freestyle'] },
  { name: 'Heavy Metal', keywords: ['metal', 'death metal', 'deathcore', 'metalcore', 'thrash', 'djent', 'black metal', 'power metal', 'doom metal'] },
  { name: 'Rock / Alternative', keywords: ['rock', 'alternative', 'indie', 'punk', 'grunge', 'shoegaze', 'post-hardcore'] }
];

const applyAndReport = (res, userId, extra = {}) => {
  let added = {};
  try {
    added = db.applySmartPlaylists(userId);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  return res.json({ ...extra, added });
};

app.get('/api/smart-playlists', (req, res) => {
  res.json({ rules: db.getSmartPlaylists(req.user.id) });
});

app.post('/api/smart-playlists', (req, res) => {
  try {
    const rule = db.createSmartPlaylist(req.user.id, req.body?.name, req.body?.keywords);
    return applyAndReport(res, req.user.id, { rule });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.delete('/api/smart-playlists/:id', (req, res) => {
  return res.json({ success: db.deleteSmartPlaylist(req.user.id, req.params.id) });
});

/** Re-run every rule - the "Apply to library" button. */
app.post('/api/smart-playlists/apply', (req, res) => applyAndReport(res, req.user.id));

/** Seed the starter rules (name-merge, so safe to hit twice) and apply. */
app.post('/api/smart-playlists/presets', (req, res) => {
  for (const preset of SMART_PLAYLIST_PRESETS) {
    try {
      db.createSmartPlaylist(req.user.id, preset.name, preset.keywords);
    } catch { /* keep seeding even if one is odd */ }
  }
  return applyAndReport(res, req.user.id, { rules: db.getSmartPlaylists(req.user.id) });
});

// =========================================================================
// Items: cover, stream, metadata, delete
// =========================================================================

app.get('/api/items/:id/cover', async (req, res) => {
  const item = db.getItem(req.user.id, req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found.' });

  try {
    const built = await googleDrive.buildCover(req.user, item.googleFileId, {
      hintCoverUrl: item.coverImage || null
    });
    if (!built?.file || !fs.existsSync(built.file)) {
      throw new Error('Cover build produced no file.');
    }
// buildCover falls back to an .svg placeholder, and embedded art can be
      // png/gif/webp, so derive the type from the cached file.
      const type = built.file.endsWith('.svg') ? 'image/svg+xml'
        : built.file.endsWith('.png') ? 'image/png'
          : built.file.endsWith('.gif') ? 'image/gif'
            : built.file.endsWith('.webp') ? 'image/webp'
              : 'image/jpeg';
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'private, max-age=604800');

    const stream = fs.createReadStream(built.file);
    // A mid-flight read failure would otherwise leave the response hanging,
    // which the browser reports as a broken image rather than an error.
    stream.on('error', () => { if (!res.headersSent) res.status(404).end(); else res.end(); });
    return stream.pipe(res);
  } catch (err) {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.send(renderPlaceholderSvg(item.title));
  }
});

/** Streams audio: local offline copy first, otherwise proxied from Drive. */
app.get('/api/items/:id/stream', async (req, res) => {
  const item = db.getItem(req.user.id, req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found.' });
  if (!item.googleFileId) return res.status(404).json({ error: 'This item has no file in Google Drive.' });

  try {
    if (offlineCache.stream(item.id, req, res)) return undefined;
    return await googleDrive.streamFile(req.user, item.googleFileId, req, res);
  } catch (err) {
    console.error('[Stream] Failed:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
    return undefined;
  }
});

app.head('/api/items/:id/stream', async (req, res) => {
  const item = db.getItem(req.user.id, req.params.id);
  if (!item) return res.status(404).end();
  if (offlineCache.stream(item.id, req, res)) return undefined;
  return googleDrive.streamFile(req.user, item.googleFileId, req, res);
});

app.patch('/api/items/:id', (req, res) => {
  const updated = db.updateItem(req.user.id, req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ error: 'Item not found.' });
  return res.json({ success: true, item: updated });
});

/** Removes an item from Drive (default) or just the library row. */
app.delete('/api/items/:id', async (req, res) => {
  try {
    const item = db.getItem(req.user.id, req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found.' });

    offlineCache.remove(req.user.id, item.id);
    const alsoDeleteFile = req.query.fromDrive !== 'false';
    if (alsoDeleteFile && item.googleFileId) {
      await googleDrive.deleteFile(req.user, item.googleFileId);
    }
    db.removeItem(req.user.id, item.id);
    broadcast('library_changed', { userId: req.user.id, reason: 'delete' });
    return res.json({ success: true, deletedFromDrive: alsoDeleteFile });
  } catch (err) {
    console.error('[Items] Delete failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// Playback progress
// =========================================================================

app.get('/api/progress', (req, res) => {
  res.json(db.getProgress(req.user.id));
});

app.post('/api/progress', (req, res) => {
  const { itemId, positionSec, durationSec } = req.body || {};
  if (!itemId) return res.status(400).json({ error: 'itemId is required.' });
  if (!db.getItem(req.user.id, itemId)) return res.status(404).json({ error: 'Item not found.' });
  return res.json({ success: true, progress: db.saveProgress(req.user.id, itemId, positionSec, durationSec) });
});

app.delete('/api/progress/:id', (req, res) => {
  db.clearProgress(req.user.id, req.params.id);
  res.json({ success: true });
});

/** Continue-listening payload used by the sidebar's "Continue" entry. */
app.get('/api/progress/continue', (req, res) => {
  // Scoped to one library: audiobook and music lists never mix. Audiobooks show
  // what is genuinely resumable; music is a *recently played* history - finished
  // songs stay on it, ordered newest first, capped at 50.
  const kind = req.query.kind === 'music' ? 'music' : 'audiobooks';
  const isMusic = kind === 'music';
  const items = new Map(db.getUserItems(req.user.id, isMusic ? 'track' : 'audiobook').map((i) => [i.id, i]));
  let rows = Object.values(db.getProgress(req.user.id))
    .filter((p) => {
      if (!items.has(p.itemId)) return false;
      if (isMusic) return true;
      // Treat "finished" books (>98%) as done rather than resumable.
      return !(p.durationSec > 0 && p.positionSec / p.durationSec > 0.98);
    })
    .map((p) => {
      const item = items.get(p.itemId);
      return {
        itemId: item.id,
        title: item.title,
        author: item.author || item.artist || item.albumArtist || '',
        album: item.album || '',
        series: item.series,
        kind,
        coverUrl: `/api/items/${item.id}/cover`,
        positionSec: p.positionSec,
        durationSec: p.durationSec || item.durationSec || 0,
        percent: p.durationSec ? Math.min(100, (p.positionSec / p.durationSec) * 100) : 0,
        updatedAt: p.updatedAt,
        lastPlayed: p.updatedAt,
        resumeLabel: formatDuration(p.positionSec)
      };
    })
    .sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1));
  if (isMusic) rows = rows.slice(0, 50);

  res.json(rows);
});

// =========================================================================
// Favourites / likes
// =========================================================================

/** `?kind=audiobooks|music` scopes both lists; omit it to get the combined view. */
app.get('/api/favorites', (req, res) => {
  const kind = req.query.kind === 'music' ? 'music' : req.query.kind === 'audiobooks' ? 'audiobooks' : null;
  res.json({
    itemIds: db.getFavorites(req.user.id, kind),
    authorNames: db.getAuthorFavorites(req.user.id, kind),
    // Albums are music-only groupings, so they only make sense on that side.
    albums: kind === 'music' || !kind ? db.getAlbumFavorites(req.user.id) : []
  });
});

app.post('/api/favorites', (req, res) => {
  const { itemId, itemIds, isFavorite } = req.body || {};
  if (Array.isArray(itemIds) && itemIds.length) {
    return res.json({ success: true, itemIds: db.toggleFavoritesBulk(req.user.id, itemIds, isFavorite) });
  }
  if (!itemId) return res.status(400).json({ error: 'itemId is required.' });
  return res.json({ success: true, itemIds: db.toggleFavorite(req.user.id, itemId, isFavorite) });
});

// ---------------------------------------------------------------------------
// Artist/album favourites are name-based (artists and albums aren't rows in
// `items`), and `kind` records which library they belong to so the two sides
// never share a favourites list.
// ---------------------------------------------------------------------------
app.post('/api/favorites/author', (req, res) => {
  const { name, isFavorite, kind } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required.' });
  const library = kind === 'music' ? 'music' : kind === 'audiobooks' ? 'audiobooks' : null;
  return res.json({
    success: true,
    authorNames: db.toggleAuthorFavorite(req.user.id, name, isFavorite, library)
  });
});

app.post('/api/favorites/album', (req, res) => {
  const { artist, album, isFavorite } = req.body || {};
  if (!album) return res.status(400).json({ error: 'album is required.' });
  return res.json({
    success: true,
    albums: db.toggleAlbumFavorite(req.user.id, artist, album, isFavorite)
  });
});

// =========================================================================
// Playlists
// =========================================================================

app.get('/api/playlists', (req, res) => {
  const kind = req.query.kind === 'music' ? 'music' : req.query.kind === 'audiobooks' ? 'audiobooks' : null;
  res.json(db.getPlaylists(req.user.id, kind));
});

app.post('/api/playlists', (req, res) => {
  const { name, kind } = req.body || {};
  res.status(201).json(db.createPlaylist(req.user.id, name, {
    kind: kind === 'music' ? 'music' : 'audiobooks'
  }));
});

app.get('/api/playlists/:id', (req, res) => {
  const playlist = db.getPlaylist(req.user.id, req.params.id);
  if (!playlist) return res.status(404).json({ error: 'Playlist not found.' });
  // Only ever resolve items from the playlist's own library.
  const playlistKind = playlist.kind || 'audiobooks';
  const byId = new Map(
    db.getUserItems(req.user.id, playlistKind === 'music' ? 'track' : 'audiobook').map((i) => [i.id, { ...i, coverUrl: `/api/items/${i.id}/cover`, favorite: (db.getFavorites(req.user.id) || []).includes(i.id) }])
  );
  return res.json({
    ...playlist,
    kind: playlistKind,
    items: playlist.itemIds.map((id) => byId.get(id)).filter(Boolean)
  });
});

app.patch('/api/playlists/:id', (req, res) => {
  const playlist = db.getPlaylist(req.user.id, req.params.id);
  if (!playlist) return res.status(404).json({ error: 'Playlist not found.' });
  if (req.body?.itemIds) db.setPlaylistItems(req.user.id, req.params.id, req.body.itemIds);
  const updated = req.body?.name
    ? db.renamePlaylist(req.user.id, req.params.id, req.body.name)
    : db.getPlaylist(req.user.id, req.params.id);
  return res.json(updated);
});

app.post('/api/playlists/:id/items', (req, res) => {
  const playlist = db.getPlaylist(req.user.id, req.params.id);
  if (!playlist) return res.status(404).json({ error: 'Playlist not found.' });
  const itemIds = Array.isArray(req.body?.itemIds) ? req.body.itemIds : [];
  return res.json(db.setPlaylistItems(req.user.id, req.params.id, [...playlist.itemIds, ...itemIds]));
});

app.delete('/api/playlists/:id', (req, res) => {
  res.json({ success: db.deletePlaylist(req.user.id, req.params.id) });
});

// =========================================================================
// Offline cache
// =========================================================================

app.get('/api/offline', (req, res) => {
  res.json({ items: offlineCache.list(req.user.id), usage: cacheUsage() });
});

app.post('/api/offline', async (req, res) => {
  try {
    const { itemId } = req.body || {};
    const item = db.getItem(req.user.id, itemId);
    if (!item) return res.status(404).json({ error: 'Item not found.' });
    return res.json({ success: true, ...(await offlineCache.cache(req.user, item)) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.delete('/api/offline/:id', (req, res) => {
  res.json({ success: offlineCache.remove(req.user.id, req.params.id) });
});

// =========================================================================
// What's New (AudioBookBay)
// =========================================================================

app.get('/api/whats-new', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const category = req.query.category ? String(req.query.category) : null;
    const items = await abbClient.fetchLatest({ page, category });
    const seen = new Set(db.getAbbSeen(req.user.id));
    const library = db.getUserItems(req.user.id, 'audiobook');

    res.json({
      page,
      category,
      items: items.map((item) => ({
        ...item,
        isNew: !seen.has(item.id),
        // Rough ownership signal so the grid can grey out what you already have.
        inLibrary: library.some((book) => {
          const needle = item.title.toLowerCase();
          return needle.includes(book.title.toLowerCase()) || book.title.toLowerCase().includes(needle);
        })
      }))
    });
  } catch (err) {
    console.error('[WhatsNew] Failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/whats-new/categories', async (req, res) => {
  try {
    res.json(await abbClient.fetchCategories());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Full metadata + torrent link for one release. */
app.get('/api/abb/detail', async (req, res) => {
  try {
    const url = String(req.query.url || '');
    if (!url.startsWith(config.abb.baseUrl)) {
      return res.status(400).json({ error: 'That URL is not an AudioBookBay link.' });
    }
    res.json(await abbClient.fetchDetail(url));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/abb/mark-seen', (req, res) => {
  const { ids } = req.body || {};
  if (Array.isArray(ids) && ids.length) db.markAllAbbSeen(req.user.id, ids);
  else db.markAbbSeen(req.user.id, req.body?.id);
  res.json({ success: true });
});

app.get('/api/abb/session', async (req, res) => {
  if (abbClient.isConfigured() && !abbClient.sessionStatus().loggedIn) {
    await abbClient.ensureLoggedIn();
  }
  res.json(abbClient.sessionStatus());
});

app.post('/api/abb/login', async (req, res) => {
  try {
    await abbClient.login({ force: true });
    res.json({ success: true, ...abbClient.sessionStatus() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// =========================================================================
// Downloads
// =========================================================================

app.post('/api/downloads', async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: 'url is required.' });
    const job = await downloadManager.start(req.user, url, { detail: req.body?.detail || null });
    return res.status(202).json({ success: true, job });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.get('/api/downloads', async (req, res) => {
  // Mirror the remote node's progress into our own job records so the UI shows
  // live bytes/peers without holding a second SSE channel open.
  await downloadManager.syncFromNode(req.user.id);
  res.json({ jobs: downloadManager.listForUser(req.user.id), history: downloadManager.history(req.user.id) });
});

app.get('/api/downloads/status/:jobId', (req, res) => {
  const job = downloadManager.get(req.params.jobId);
  if (!job || job.userId !== req.user.id) return res.status(404).json({ error: 'Job not found.' });
  res.setHeader('Cache-Control', 'no-store');
  return res.json(job);
});

app.post('/api/downloads/:jobId/cancel', async (req, res) => {
  res.json(await downloadManager.cancel(req.params.jobId, req.user.id));
});

app.get('/api/downloads/node', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await torrentNode.health());
});

/**
 * Node -> FRAUDIO callbacks.
 *
 * The torrent node cannot authenticate as a signed-in user, so these routes
 * accept a shared secret instead of a session cookie. Both must stay reachable
 * from the VPS, which in practice means FRAUDIO needs a public URL.
 *
 * Fails closed: an unset secret rejects every callback rather than accepting
 * anonymous ones, since these routes write directly into a user's library.
 */
function verifyNodeSecret(req) {
  const secret = process.env.TORRENT_NODE_WEBHOOK_SECRET || process.env.DOWNLOADER_SECRET_KEY || process.env.NODE_KEY || '';
  if (!secret) {
    console.error('[Download] TORRENT_NODE_WEBHOOK_SECRET is unset - rejecting node callback.');
    return false;
  }
  // Header only: a query string secret would leak into proxy/access logs.
  const provided = req.get('x-node-secret') || '';
  if (typeof provided !== 'string') return false;

  const expected = Buffer.from(secret, 'utf8');
  const actual = Buffer.from(provided, 'utf8');
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

app.post('/api/downloads/webhook', async (req, res) => {
  if (!verifyNodeSecret(req)) return res.status(401).json({ error: 'Invalid node secret.' });
  try {
    const outcome = await downloadManager.handleWebhook(req.body || {});
    return res.json(outcome);
  } catch (err) {
    console.error('[Download] Webhook failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/downloads/token-refresh', async (req, res) => {
  if (!verifyNodeSecret(req)) return res.status(401).json({ error: 'Invalid node secret.' });
  try {
    const userId = req.body?.userId;
    const user = userId ? db.getUser(userId) : null;
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const accessToken = await googleDrive.getAccessToken(user);
    if (!accessToken) return res.status(401).json({ error: 'No Drive access token available.' });
    return res.json({ accessToken });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// Search
// =========================================================================

app.get('/api/search', async (req, res) => {
const q = String(req.query.q || '').trim();
    const kind = req.query.kind === 'music' ? 'music' : 'audiobooks';
    if (!q) {
      return res.json({ query: q, kind, local: [], online: [], artists: [], albums: [], total: 0 });
    }

    const needle = q.toLowerCase();
    // Local matches are scoped to the active library so an audiobook search never
    // returns tracks (or vice versa).
    const favSet = new Set(db.getFavorites(req.user.id));
    const local = db.getUserItems(req.user.id, kind === 'music' ? 'track' : 'audiobook')
      .filter((item) =>
        item.title.toLowerCase().includes(needle) ||
        (item.author || '').toLowerCase().includes(needle) ||
        (item.series || '').toLowerCase().includes(needle) ||
        (item.album || '').toLowerCase().includes(needle) ||
        (item.artist || '').toLowerCase().includes(needle) ||
        (item.albumArtist || '').toLowerCase().includes(needle)
      )
      .map((item) => ({
        ...item,
        favorite: favSet.has(item.id),
        coverUrl: `/api/items/${item.id}/cover`
      }));

    let online = [];
    let artists = [];
    let albums = [];

    if (kind === 'music') {
      try {
        const found = await youtubeMusic.search(q);
        const owned = new Set(local.map((i) => i.title.toLowerCase()));
        artists = found.artists;
        albums = found.albums.map((a) => ({ ...a, inLibrary: owned.has(a.title.toLowerCase()) }));
        online = found.songs;
      } catch (err) {
        console.warn('[Search] YouTube Music search failed:', err.message);
      }
    } else {
      try {
        const results = await abbClient.search(q);
        const owned = new Set(local.map((i) => i.title.toLowerCase()));
        online = results.map((item) => ({ ...item, inLibrary: owned.has(item.title.toLowerCase()) }));
      } catch (err) {
        console.warn('[Search] AudioBookBay search failed:', err.message);
      }
    }

    return res.json({
      query: q,
      kind,
      local,
      online,
      artists,
      albums,
      total: local.length + online.length + artists.length + albums.length
    });
});

// =========================================================================
// Settings & diagnostics
// =========================================================================

app.get('/api/settings', (req, res) => {
  res.json({
    ...db.getSettings(req.user.id),
    drive: googleAuth.publicProfile(req.user)
  });
});

app.post('/api/settings', (req, res) => {
  res.json({ success: true, settings: db.saveSettings(req.user.id, req.body || {}) });
});

app.get('/api/ping', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, ts: Date.now() });
});

app.get('/api/health', async (req, res) => {
  if (abbClient.isConfigured() && !abbClient.sessionStatus().loggedIn) {
    await abbClient.ensureLoggedIn();
  }
  res.json({
    status: 'ok',
    version: '0.1.0',
    abb: abbClient.sessionStatus(),
    torrentNode: await torrentNode.health(),
    offline: cacheUsage(),
    tools: await binManager.toolStatus()
  });
});

// =========================================================================
// Admin controls are restricted to the server-configured ADMIN_EMAIL.
// =========================================================================

function requireAdmin(req, res, next) {
  if (!isAdminUser(req.user)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

app.post('/api/admin/restart-streamer', requireAdmin, async (req, res) => {
  try {
    const result = await torrentNode.restartNode();
    res.json({ success: true, message: 'Torrent server is restarting…', result });
  } catch (err) {
    console.error('[Admin] Torrent server restart failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/restart-app', requireAdmin, (req, res) => {
  res.json({ success: true, message: 'FRAUDIO app server is restarting…' });
  setTimeout(() => {
    console.log('[Admin] App server restart requested by admin.');
    shutdown();
  }, 600);
});

app.get('/api/admin/cookies', requireAdmin, async (req, res) => {
  try {
  let remoteData = null;
  if (torrentNode.isConfigured()) {
    try {
      remoteData = await torrentNode.getCookies();
    } catch (err) {
      console.warn('[Admin] Could not read cookies from remote download server:', err.message);
    }
  }

  // Also check local downloader directory if present on disk
  const localCandidates = [
    process.env.YOUTUBE_COOKIES_FILE,
    path.resolve(ROOT_DIR, '../../downloader/cookies.txt'),
    path.resolve(ROOT_DIR, '../downloader/cookies.txt'),
    path.resolve(ROOT_DIR, 'cookies.txt'),
    path.resolve(ROOT_DIR, '../cookies.txt'),
    path.resolve(__dirname, '../../../downloader/cookies.txt'),
    path.resolve(__dirname, '../cookies.txt'),
    path.resolve(process.cwd(), 'cookies.txt'),
    path.resolve(process.cwd(), 'downloader/cookies.txt')
  ].filter(Boolean);
  let localContent = '';
  let localFound = false;
  for (const c of localCandidates) {
    if (fs.existsSync(c)) {
      try {
        localContent = fs.readFileSync(c, 'utf8');
        localFound = true;
        break;
      } catch (_) {}
    }
  }

  const content = remoteData?.content || localContent || '';
  res.json({
    success: true,
    exists: Boolean(remoteData?.exists || localFound || content),
    content,
    sizeBytes: remoteData?.sizeBytes || (content ? Buffer.byteLength(content, 'utf8') : 0),
    remoteSynced: Boolean(remoteData?.success)
  });
  } catch (err) {
    console.error('[Admin] GET /api/admin/cookies error:', err);
    res.status(500).json({ success: false, error: err.message || 'Internal Server Error' });
  }
});

app.post('/api/admin/cookies', requireAdmin, async (req, res) => {
  try {
  const content = (req.body?.content || req.body?.cookies || '').trim();
  if (!content) {
    return res.status(400).json({ error: 'cookies.txt content is required.' });
  }

  let remoteSuccess = false;
  let remoteError = null;

  // 1. Forward to download server daemon if configured
  if (torrentNode.isConfigured()) {
    try {
      const data = await torrentNode.updateCookies(content);
      if (data?.success) remoteSuccess = true;
    } catch (err) {
      remoteError = err.message;
      console.warn('[Admin] Remote download server cookies update failed:', err.message);
    }
  }

  // 2. Also write to local downloader/cookies.txt if present
  const localTargets = [
    process.env.YOUTUBE_COOKIES_FILE,
    path.resolve(ROOT_DIR, '../../downloader/cookies.txt'),
    path.resolve(ROOT_DIR, '../downloader/cookies.txt'),
    path.resolve(ROOT_DIR, '../../downloader/downloads/cookies.txt'),
    path.resolve(ROOT_DIR, '../downloader/downloads/cookies.txt'),
    path.resolve(ROOT_DIR, 'cookies.txt'),
    path.resolve(__dirname, '../../../downloader/cookies.txt'),
    path.resolve(__dirname, '../../../downloader/downloads/cookies.txt')
  ].filter(Boolean);
  let localWritten = false;
  for (const target of localTargets) {
    try {
      const dir = path.dirname(target);
      if (fs.existsSync(dir)) {
        fs.writeFileSync(target, content + '\n', 'utf8');
        localWritten = true;
      }
    } catch (err) {
      console.warn('[Admin] Local cookies write error:', err.message);
    }
  }

  if (!remoteSuccess && !localWritten && remoteError) {
    return res.status(502).json({ error: `Failed to update download server: ${remoteError}` });
  }

  console.log(`[Admin] Successfully synced cookies.txt (${content.length} chars) to download server (remote=${remoteSuccess}, local=${localWritten})`);
    res.json({
      success: true,
      message: 'cookies.txt written to download server successfully.',
      remoteSynced: remoteSuccess,
      localSynced: localWritten,
      bytes: Buffer.byteLength(content, 'utf8')
    });
  } catch (err) {
    console.error('[Admin] POST /api/admin/cookies error:', err);
    res.status(500).json({ success: false, error: err.message || 'Internal Server Error' });
  }
});

// =========================================================================
// Static SPA
// =========================================================================

const distPath = path.join(ROOT_DIR, 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      else if (filePath.includes('assets')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }));
  app.get(/^(?!\/api\/).*/, (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
} else {
  console.warn('[Server] dist/ not found - run `npm run build` (or use `npm run dev:client`)');
}

ensureDirs();

// Mirror progress / favourites / playlists into the visible per-folder JSON
// documents on Drive. Registered here (not in db.js) to keep the import
// graph acyclic: metaStore imports db, so db must not import metaStore.
db.setMetaHook((userId, kind) => metaStore.schedulePersist(userId, kind));

const server = app.listen(config.port, () => {
  console.log(`\n  FRAUDIO listening on http://localhost:${config.port}\n`);

  // Re-arm pending YouTube Music downloads from the persisted queue (jobs
  // interrupted mid-run simply re-run; per-track overwrites keep it clean).
  try {
    youtubeMusic.resumePendingQueue();
  } catch (err) {
    console.warn('[Queue] Resume failed:', err.message);
  }

  // Re-attach Drive metadata for anyone who has folders configured, so state
  // survives a restart without requiring a fresh sign-in.
  for (const user of Object.values(db.raw().users)) {
    if (!user.audiobooksFolderId && !user.musicFolderId) continue;
    metaStore.loadAll(user)
      .then(() => console.log(`[META] Restored Drive metadata for ${user.email || user.id}`))
      .catch((err) => console.warn(`[META] startup restore failed: ${err.message}`));
  }

  if (abbClient.isConfigured()) {
    console.log(`  AudioBookBay: configured for ${config.abb.username}`);
    abbClient.ensureLoggedIn()
      .then((ok) => {
        if (ok) console.log('  AudioBookBay is signed in.');
        else console.warn(`  AudioBookBay sign-in failed: ${abbClient.sessionStatus().error || 'Check credentials'}`);
      })
      .catch(() => {});
  } else {
    console.log('  No ABB_USERNAME / ABB_PASSWORD set - AudioBookBay will be accessed anonymously.');
  }

  if (torrentNode.isConfigured()) {
    console.log(`  Torrent node: ${config.torrent.nodeUrl}`);
    torrentNode.health()
      .then((health) => {
        if (health.online) {
          console.log(`  Torrent node is online (${health.activeCount} active, ${health.queuedCount} queued)`);
          if (health.activeCount > 0 || health.queuedCount > 0) {
            downloadManager.syncFromNode(null).catch(() => {});
          }
        }
        else console.warn(`  Torrent node unreachable: ${health.error}`);
      })
      .catch(() => {});
  } else {
    console.warn('  No TORRENT_NODE_URL set - audiobook downloads are disabled.');
  }
});

async function shutdown() {
  console.log('\n[Server] Shutting down…');
  // Give any debounced metadata writes a chance to land on Drive.
  await metaStore.flush().catch(() => {});
  db.flush();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => console.error('[Server] Uncaught exception:', err));
process.on('unhandledRejection', (reason) => console.error('[Server] Unhandled rejection:', reason));

export default app;
