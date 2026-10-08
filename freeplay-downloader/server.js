// Freeplay Downloader - slimmed down version of my-games-server that keeps
// ONLY the PC FitGirl / Steam repack downloading features. The user picks a
// downloads folder once; every torrent / direct download lands there and is
// auto-extracted when it finishes.

import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { registerPcRssRoutes } from './stream/pc-rss.js';
import { createDownloadQueue } from './stream/download-queue.js';
import { electronBridge } from './lib/electron-bridge.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Paths & Portable Data Directory ────────────────────────────────────────
// If running from a portable Electron .exe, PORTABLE_EXECUTABLE_DIR points to
// the folder containing the .exe. Otherwise defaults to process.cwd().
const appBaseDir = process.env.PORTABLE_EXECUTABLE_DIR || (process.pkg ? path.dirname(process.execPath) : process.cwd());
const dataDir = process.env.DATA_DIR || appBaseDir;
const CONFIG_PATH = path.join(dataDir, 'config.json');
const TORRENT_QUEUE_PATH = path.join(dataDir, 'torrent_queue.json');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// ── Configuration State ────────────────────────────────────────────────────
let config = {
  port: parseInt(process.env.PORT || '5055', 10),
  downloadsFolder: ''
};

function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const loaded = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      config = { ...config, ...loaded };
    } catch (e) {
      console.warn('[Freeplay Downloader] Error loading config.json:', e.message);
    }
  }
}
loadConfig();

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  } catch (e) {
    console.error('[Freeplay Downloader] Error saving config.json:', e.message);
  }
}

function getDownloadsFolder() {
  const folder = config.downloadsFolder;
  if (folder && folder.trim()) {
    const abs = path.isAbsolute(folder) ? folder : path.resolve(appBaseDir, folder);
    if (!fs.existsSync(abs)) {
      try {
        fs.mkdirSync(abs, { recursive: true });
      } catch (e) {
        console.warn('[Freeplay Downloader] Error creating downloads folder:', e.message);
      }
    }
    return abs;
  }
  // Default: <dataDir>/downloads
  const fallback = path.join(dataDir, 'downloads');
  if (!fs.existsSync(fallback)) {
    try {
      fs.mkdirSync(fallback, { recursive: true });
    } catch (e) {
      console.warn('[Freeplay Downloader] Error creating default downloads folder:', e.message);
    }
  }
  return fallback;
}

function isDownloadsFolderConfigured() {
  return Boolean(config.downloadsFolder && config.downloadsFolder.trim());
}

// ── SSE Broadcast System ───────────────────────────────────────────────────
const sseClients = new Set();

function broadcastEvent(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify({ type, data, timestamp: Date.now() })}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch (_) {
      sseClients.delete(client);
    }
  }
}

// ── Express App ────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '5mb' }));

// ── Download Queue Engine (FitGirl / Steam repack downloader) ─────────────
const downloadQueue = createDownloadQueue({
  getDownloadsFolder,
  broadcastEvent,
  torrentQueuePath: TORRENT_QUEUE_PATH
});

registerPcRssRoutes(app);
downloadQueue.registerRoutes(app);

// ── SSE Events Endpoint ────────────────────────────────────────────────────
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  sseClients.add(res);
  res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: Date.now() })}\n\n`);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

// ── Downloads Folder Endpoints ─────────────────────────────────────────────
app.get('/api/downloads-folder', (_req, res) => {
  res.json({
    success: true,
    folder: getDownloadsFolder(),
    configured: isDownloadsFolderConfigured()
  });
});

app.post('/api/downloads-folder', (req, res) => {
  const raw = (req.body && req.body.folder) || '';
  const folder = String(raw).trim();
  if (!folder) {
    return res.status(400).json({ success: false, error: 'folder is required' });
  }
  const abs = path.isAbsolute(folder) ? path.resolve(folder) : path.resolve(appBaseDir, folder);
  try {
    if (!fs.existsSync(abs)) {
      fs.mkdirSync(abs, { recursive: true });
    }
    if (!fs.statSync(abs).isDirectory()) {
      throw new Error('Path is not a directory');
    }
  } catch (err) {
    return res.status(400).json({ success: false, error: `Cannot use folder: ${err.message}` });
  }
  config.downloadsFolder = abs;
  saveConfig();
  broadcastEvent('downloads_folder_changed', { folder: abs });
  res.json({ success: true, folder: abs, configured: true });
});

// Native folder picker (Electron only; the browser UI falls back to typing a path)
app.post('/api/downloads-folder/pick', async (_req, res) => {
  const electron = electronBridge.electron;
  if (!electron || !electron.dialog || !electronBrowserWindow()) {
    return res.json({ success: false, available: false, error: 'Native folder picker requires the desktop app' });
  }
  try {
    const result = await electron.dialog.showOpenDialog(electronBrowserWindow(), {
      title: 'Select Downloads Folder',
      defaultPath: config.downloadsFolder || appBaseDir,
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled || result.filePaths.length === 0) {
      return res.json({ success: true, canceled: true });
    }
    return res.json({ success: true, folder: result.filePaths[0] });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// The main window reference is injected by electron-main.js so the native
// dialog can attach to it (modal parenting).
let _mainWindow = null;
export function setMainWindow(win) {
  _mainWindow = win;
}
function electronBrowserWindow() {
  return _mainWindow && !_mainWindow.isDestroyed() ? _mainWindow : null;
}

// ── Open Downloads Folder in Explorer ──────────────────────────────────────
app.post('/api/pc-rss/open-folder', (req, res) => {
  const downloadsFolder = req.body && req.body.folder ? path.resolve(req.body.folder) : getDownloadsFolder();
  if (!fs.existsSync(downloadsFolder)) {
    try { fs.mkdirSync(downloadsFolder, { recursive: true }); } catch (_) {}
  }
  try {
    if (process.platform === 'win32') {
      execFile('explorer.exe', [downloadsFolder], () => {});
    } else if (process.platform === 'darwin') {
      execFile('open', [downloadsFolder], () => {});
    } else {
      execFile('xdg-open', [downloadsFolder], () => {});
    }
    res.json({ success: true, folder: downloadsFolder });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Image Proxy (RSS thumbnails that block hotlinking) ─────────────────────
app.get('/api/proxy-image', async (req, res) => {
  try {
    let imageUrl = req.query.url;
    if (!imageUrl || typeof imageUrl !== 'string') {
      return res.status(400).send('No url provided');
    }
    imageUrl = imageUrl.trim();
    if (!imageUrl.startsWith('http://') && !imageUrl.startsWith('https://')) {
      return res.status(400).send('Invalid url');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const proxyRes = await fetch(imageUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
      }
    });
    clearTimeout(timeout);

    if (!proxyRes.ok) {
      return res.status(proxyRes.status).send(`Failed to fetch image: ${proxyRes.statusText}`);
    }

    const contentType = proxyRes.headers.get('content-type') || 'image/jpeg';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=604800');
    const arrayBuffer = await proxyRes.arrayBuffer();
    res.send(Buffer.from(arrayBuffer));
  } catch (err) {
    res.status(500).send('Proxy error: ' + err.message);
  }
});

// ── Deep Link Processing (freeplayDL://...) ────────────────────────────────
export const DEEP_LINK_PROTOCOL = 'freeplayDL';

export function parseFreeplayDeepLink(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  let rest = rawUrl.trim();

  const schemeMatch = rest.match(/^freeplaydl:\/\//i);
  if (schemeMatch) {
    rest = rest.slice(schemeMatch[0].length);
  } else if (!/^(https?:\/\/|magnet:)/i.test(rest)) {
    // Not a deep link and not a plain URL - reject.
    return null;
  }

  // Support freeplayDL://download?url=<encoded>&title=<encoded>
  let title = null;
  if (/^download\?/i.test(rest)) {
    try {
      const qs = new URLSearchParams(rest.slice('download?'.length));
      const u = qs.get('url');
      const t = qs.get('title');
      if (u) {
        rest = u;
        title = t || null;
      }
    } catch (_) {}
  }

  // The remainder is the target URL (possibly URI-encoded)
  let url = rest;
  try {
    if (/^https?%3a/i.test(url) || /%2f/i.test(url)) {
      url = decodeURIComponent(url);
    }
  } catch (_) {}

  // Browsers/OS protocol handlers sometimes mangle the nested URL
  // (e.g. freeplayDL://https:/example.com or freeplayDL://https//example.com).
  // Restore a proper scheme separator before validating.
  url = url.replace(/^(https?):?\/*/i, '$1://');
  if (/^magnet:(?!\?)/i.test(url)) url = url.replace(/^magnet:/i, 'magnet:?');

  if (!/^(https?:\/\/|magnet:)/i.test(url)) return null;

  // Derive a friendly title from magnet dn= or the URL itself
  if (!title) {
    if (url.toLowerCase().startsWith('magnet:')) {
      const dn = url.match(/[?&]dn=([^&]+)/);
      if (dn) {
        try { title = decodeURIComponent(dn[1].replace(/\+/g, ' ')); } catch (_) { title = dn[1]; }
      }
    } else {
      try {
        const u = new URL(url);
        const last = u.pathname.split('/').filter(Boolean).pop();
        if (last) title = decodeURIComponent(last);
      } catch (_) {}
    }
  }

  return { url, title };
}

function deepLinkLooksLikeDirectFile(url) {
  if (/^magnet:/i.test(url)) return true;
  if (/\.torrent([?#].*)?$/i.test(url)) return true;
  try {
    const p = new URL(url);
    const path = (p.pathname || '').toLowerCase();
    if (/\.(rar|zip|7z|iso|exe|msi|bin|img|apk|dmg|patch|rom|tar|gz|bz2|xz)([?#].*)?$/i.test(path)) return true;
    if (/\/dl\//i.test(path)) return true;
    if (/:8443\/d\//.test(url) || /datanodes\.to/.test(url) || /fuckingfast\.co/i.test(url) ||
        /mediafire\.com|mega\.nz|1fichier\.com|rapidgator\.net|gofile\.io|krakenfiles\.com|pixeldrain\.com|buzzheavier\.com|multiupload\.io|multiupload\.biz|mirrorace\.org|dropgalaxy\.com|uploadhaven\.com|send\.cm|bowfile\.com|hexupload\.net|qiwi\.gg|filekeeper\.net/i.test(url)) return true;
  } catch (_) {}
  return false;
}

app.post('/api/deep-link/add', (req, res) => {
  const raw = (req.body && (req.body.url || req.body.link)) || '';
  const parsed = parseFreeplayDeepLink(raw);
  if (!parsed) {
    return res.status(400).json({ success: false, error: 'Unsupported link. Use freeplayDL://<http(s)|magnet url> or freeplayDL://download?url=...' });
  }

  const { url, title } = parsed;

  // A link that points at a web page (e.g. a FitGirl repack post or a
  // paste page full of mirrors) is not itself a downloadable file. Instead
  // scan the page for download links, exactly like the feed item's "Links"
  // button does.
  if (/^https?:\/\//i.test(url) && !deepLinkLooksLikeDirectFile(url)) {
    broadcastEvent('deep_link_scrape', { pageUrl: url, title: title || '' });
    return res.json({
      success: true,
      type: 'page-scrape',
      pageUrl: url,
      title: title || '',
      message: `Scanning ${url} for download links...`
    });
  }

  const isMagnet = url.toLowerCase().startsWith('magnet:');
  const isTorrentFile = !isMagnet && url.toLowerCase().includes('.torrent');
  const isDirect = !isMagnet && !isTorrentFile;

  try {
    const item = downloadQueue.addTorrentToQueue({
      url,
      title: title || undefined,
      isDirect,
      hoster: isMagnet ? 'BitTorrent Magnet' : (isDirect ? 'Direct File' : 'Torrent File')
    });
    broadcastEvent('deep_link_received', { url, title: item.title, itemId: item.id });
    res.json({ success: true, message: `Added "${item.title}" to download queue`, item, queue: downloadQueue.getQueue() });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get('/api/deep-link', (_req, res) => {
  res.json({ success: true, protocol: DEEP_LINK_PROTOCOL, example: 'freeplayDL://magnet:?xt=urn:btih:...' });
});

// ── Health & Info ──────────────────────────────────────────────────────────
function getLocalIpAddresses() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

app.get(['/api/health', '/health', '/api/status', '/api/ping'], (req, res) => {
  res.json({
    status: 'ok',
    app: 'freeplay-downloader',
    version: '1.0.0',
    port: PORT,
    downloadsFolder: getDownloadsFolder(),
    downloadsFolderConfigured: isDownloadsFolderConfigured(),
    deepLinkProtocol: DEEP_LINK_PROTOCOL,
    queueItems: downloadQueue.getQueue().length,
    isDownloading: Boolean(downloadQueue.getActive()),
    localIps: getLocalIpAddresses(),
    uptime: process.uptime()
  });
});

// ── Favicon ────────────────────────────────────────────────────────────────
app.get(['/favicon.ico', '/favicon.svg'], (req, res) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">⬇️</svg>`;
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(svg);
});

// ── Static UI ──────────────────────────────────────────────────────────────
const PUBLIC_DIR = path.join(__dirname, 'public');
if (!fs.existsSync(PUBLIC_DIR)) {
  try { fs.mkdirSync(PUBLIC_DIR, { recursive: true }); } catch (_) {}
}
app.use(express.static(PUBLIC_DIR));

app.get('/', (req, res) => {
  if (req.headers.accept && req.headers.accept.includes('application/json')) {
    return res.json({ app: 'freeplay-downloader', status: 'running', port: PORT });
  }
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ── Server Startup ─────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || config.port || '5055', 10);
const server = app.listen(PORT, '0.0.0.0', () => {
  const localIps = getLocalIpAddresses();
  const primaryIp = localIps[0] || '127.0.0.1';
  console.log(`\n==================================================`);
  console.log(`⬇️  Freeplay Downloader running at:`);
  console.log(`   - Local:   http://localhost:${PORT}`);
  console.log(`   - Network: http://${primaryIp}:${PORT}`);
  console.log(`📁 Data Directory:    ${dataDir}`);
  console.log(`📥 Downloads Folder:  ${getDownloadsFolder()}${isDownloadsFolderConfigured() ? '' : ' (default - not set yet)'}`);
  console.log(`🔗 Deep Links:        ${DEEP_LINK_PROTOCOL}://<url>`);
  console.log(`==================================================\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[Freeplay Downloader] Port ${PORT} is already in use.`);
  } else {
    console.error(`[Freeplay Downloader] Startup error:`, err);
  }
});

export { PORT, app, server, broadcastEvent, downloadQueue, getDownloadsFolder, config };
