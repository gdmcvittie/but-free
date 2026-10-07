// Freeplay Downloader - Electron shell.
// Wraps the Express backend (server.js), provides the native folder picker,
// and registers/launches the freeplayDL:// deep link protocol so other apps
// can hand download URLs straight to this app:
//   freeplayDL://<http(s) or magnet url>
//   freeplayDL://download?url=<encoded>&title=<encoded>

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell
} from 'electron';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { electronBridge } from './lib/electron-bridge.js';

// Prevent uncaught exceptions from triggering Electron popups
process.on('uncaughtException', (err) => {
  console.error('[Electron Main Uncaught Exception]:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Electron Main Unhandled Rejection]:', reason);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEEP_LINK_PROTOCOL = 'freeplayDL';
const DEFAULT_PORT = 5055;

let mainWindow = null;
let serverPort = DEFAULT_PORT;
let pendingDeepLink = null;
let windowFinishedLoading = false;

// Hand the Electron API to non-Electron modules ( FuckingFast offscreen
// resolver, server.js native folder picker ).
electronBridge.init({ app, BrowserWindow, dialog });

function extractDeepLinkFromArgv(argv) {
  if (!Array.isArray(argv)) return null;
  for (const arg of argv) {
    if (typeof arg === 'string' && arg.toLowerCase().startsWith(`${DEEP_LINK_PROTOCOL.toLowerCase()}://`)) {
      return arg;
    }
  }
  return null;
}

async function forwardDeepLinkToServer(rawUrl) {
  try {
    const res = await fetch(`http://localhost:${serverPort}/api/deep-link/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: rawUrl })
    });
    const data = await res.json().catch(() => ({}));
    if (data && data.success && data.type === 'page-scrape') {
      console.log(`[Deep Link] Scrape page instead of queueing: ${data.pageUrl || rawUrl}`);
      notifyRendererDeepLink({
        type: 'scrape',
        url: data.pageUrl || rawUrl,
        title: data.title || '',
        message: data.message || 'Scanning page for download links...'
      });
    } else if (data && data.success) {
      console.log(`[Deep Link] Queued "${data.item ? data.item.title : rawUrl}" via ${DEEP_LINK_PROTOCOL}://`);
      notifyRendererDeepLink({
        type: 'queued',
        url: rawUrl,
        title: data.item ? data.item.title : '',
        message: data.message || `Added "${data.item ? data.item.title : 'download'}" to download queue`
      });
    } else {
      console.warn('[Deep Link] Backend rejected link:', (data && data.error) || res.status);
      notifyRendererDeepLink({
        type: 'error',
        url: rawUrl,
        message: (data && data.error) || 'Deep link could not be processed'
      });
    }
  } catch (err) {
    console.error('[Deep Link] Error forwarding to server:', err.message);
    notifyRendererDeepLink({
      type: 'error',
      url: rawUrl,
      message: 'Downloader backend is not reachable yet: ' + err.message
    });
  }
}

function notifyRendererDeepLink(payload) {
  if (mainWindow && !mainWindow.isDestroyed() && windowFinishedLoading) {
    try {
      mainWindow.webContents.executeJavaScript(
        `window.onDeepLink && window.onDeepLink(${JSON.stringify(payload)})`
      ).catch(() => {});
    } catch (_) {}
  } else {
    // Keep only the latest link; it will be surfaced once the window is ready.
    pendingDeepLink = payload;
  }
}

function handleDeepLink(rawUrl) {
  if (!rawUrl) return;
  console.log(`[Deep Link] Received: ${rawUrl}`);
  forwardDeepLinkToServer(rawUrl);
}

// Native folder picker for the renderer (downloads folder setup)
ipcMain.handle('dialog:select-downloads-folder', async (_event, defaultPath) => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Downloads Folder',
    defaultPath: defaultPath || undefined,
    properties: ['openDirectory', 'createDirectory']
  });
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

// Handle opening a path in the native OS file explorer
ipcMain.handle('shell:open-path', async (_event, targetPath) => {
  if (targetPath && fs.existsSync(targetPath)) {
    await shell.openPath(targetPath);
    return true;
  }
  return false;
});

function createWindow(port) {
  let iconPath = path.join(__dirname, 'public', 'icon.png');
  if (!fs.existsSync(iconPath)) {
    iconPath = undefined;
  }

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 800,
    minHeight: 550,
    title: 'Freeplay Downloader',
    icon: iconPath,
    autoHideMenuBar: true,
    backgroundColor: '#090d16',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  });

  try {
    mainWindow.webContents.session.clearCache();
  } catch (_) {}

  // Give server.js a handle to the main window so its native picker can be modal
  import('./server.js')
    .then((serverModule) => {
      if (typeof serverModule.setMainWindow === 'function') {
        serverModule.setMainWindow(mainWindow);
      }
    })
    .catch((err) => console.error('[Electron Main] setMainWindow failed:', err.message));

  windowFinishedLoading = false;
  mainWindow.webContents.on('did-finish-load', () => {
    windowFinishedLoading = true;
    if (pendingDeepLink) {
      const payload = pendingDeepLink;
      pendingDeepLink = null;
      notifyRendererDeepLink(payload);
    }
  });

  // Default external links open in system default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadURL(`http://localhost:${port}?electron=1`);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── Deep link protocol registration ────────────────────────────────────────
// Windows: writes an HKCU registry entry (works for portable + installed).
// macOS: Info.plist entry is handled by electron-builder "protocols" config.
if (process.defaultApp) {
  // Running via `electron .` with args: protocol args come after the script path
  if (process.argv.length >= 3) {
    const maybeLink = extractDeepLinkFromArgv(process.argv.slice(2));
    if (maybeLink) pendingDeepLink = { type: 'cold-start', url: maybeLink };
  }
  app.setAsDefaultProtocolClient(DEEP_LINK_PROTOCOL, process.execPath, [path.resolve(process.argv[1] || '.')]);
} else {
  app.setAsDefaultProtocolClient(DEEP_LINK_PROTOCOL);
}

// Windows cold start: the URL is part of process.argv when the app is
// launched through the protocol handler.
const coldStartLink = extractDeepLinkFromArgv(process.argv);
if (coldStartLink && !pendingDeepLink) {
  pendingDeepLink = { type: 'cold-start', url: coldStartLink };
}

// Ensure single instance
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  // Another instance was launched with a deep link (Windows/Linux)
  app.on('second-instance', (_event, commandLine) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    const link = extractDeepLinkFromArgv(commandLine);
    if (link) handleDeepLink(link);
  });

  // macOS deep link while running
  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });

  app.whenReady().then(async () => {
    // Import the backend server (starts Express)
    try {
      const serverModule = await import('./server.js');
      serverPort = serverModule.PORT || process.env.PORT || DEFAULT_PORT;
    } catch (err) {
      console.error('[Electron Main] Error starting server:', err.message);
    }

    // Allow Express a moment to bind before loading window
    setTimeout(() => createWindow(serverPort), 500);

    // Flush a cold-start deep link once the server + window are up
    setTimeout(() => {
      if (pendingDeepLink && pendingDeepLink.type === 'cold-start') {
        const url = pendingDeepLink.url;
        // Keep the payload for the renderer toast, and let the server add it
        handleDeepLink(url);
      }
    }, 1500);
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow(serverPort);
  }
});
