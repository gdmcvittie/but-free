import { app, BrowserWindow, shell, dialog } from 'electron';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Guard against normal socket/stream terminations and client disconnects
process.on('uncaughtException', (err) => {
  const msg = err?.message || '';
  const code = err?.code || '';
  if (
    msg.includes('terminated') ||
    msg.includes('premature close') ||
    msg.includes('aborted') ||
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === 'ERR_STREAM_PREMATURE_CLOSE'
  ) {
    return;
  }
  console.error('[Electron] Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  const msg = (reason && typeof reason === 'object' && reason.message) || String(reason || '');
  if (
    msg.includes('terminated') ||
    msg.includes('premature close') ||
    msg.includes('aborted') ||
    msg.includes('ECONNRESET')
  ) {
    return;
  }
  console.error('[Electron] Unhandled rejection:', reason);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from dev, asar, or extraResources
const envPaths = [
  path.join(__dirname, '.env'),
  process.resourcesPath ? path.join(process.resourcesPath, '.env') : null,
  path.join(process.cwd(), '.env'),
  path.join(__dirname.replace(/app\.asar$/, ''), '.env')
].filter(Boolean);

for (const ep of envPaths) {
  if (fs.existsSync(ep)) {
    dotenv.config({ path: ep });
    break;
  }
}

app.name = 'TV Transcoder';

// Ensure stable persistent data directory across launches and installations
const stableUserData = path.join(app.getPath('appData'), 'TV Transcoder');
try {
  fs.mkdirSync(stableUserData, { recursive: true });
  app.setPath('userData', stableUserData);
} catch (_) {}

if (!process.env.DATA_DIR) process.env.DATA_DIR = path.join(stableUserData, 'data');
if (!process.env.MEDIA_DIR) process.env.MEDIA_DIR = path.join(stableUserData, 'media');
if (!process.env.TMP_DIR) process.env.TMP_DIR = path.join(stableUserData, 'tmp');

for (const d of [process.env.DATA_DIR, process.env.MEDIA_DIR, process.env.TMP_DIR]) {
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
}

const PORT = parseInt(process.env.PORT || '4300', 10);
let mainWindow = null;

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

async function waitForServer(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

function createWindow() {
  const iconPath = path.join(__dirname, 'public', 'icon-512.png');
  mainWindow = new BrowserWindow({
    width: 1060,
    height: 820,
    minWidth: 840,
    minHeight: 620,
    title: 'TV Transcoder',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    autoHideMenuBar: true,
    backgroundColor: '#0f1115',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadURL(`http://127.0.0.1:${PORT}`);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  try {
    // Start backend server
    await import('./server.js');
    await waitForServer(`http://127.0.0.1:${PORT}/api/health`, 12000);
    createWindow();
  } catch (err) {
    console.error('[Electron] Failed to start server:', err);
    dialog.showErrorBox('TV Transcoder Error', 'Failed to start local transcoder server: ' + err.message);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

