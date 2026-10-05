import { app, BrowserWindow, ipcMain, session } from 'electron';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// FRAUDIO - Electron shell. The Express API is imported into the main process
// (same file as `node server.js`) and the window simply points at it.
process.on('uncaughtException', (err) => {
  console.error('[Electron Main] Uncaught exception intercepted:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Electron Main] Unhandled rejection intercepted:', reason);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;

function resolvePort() {
  return Number(process.env.PORT || 5100);
}

function createWindow() {
  const iconPath = path.join(__dirname, 'public', 'favicon.svg');
  const icon = fs.existsSync(iconPath) ? iconPath : undefined;

  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    title: 'FRAUDIO',
    icon,
    autoHideMenuBar: true,
    backgroundColor: '#0B0D12',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs')
    }
  });

  try {
    mainWindow.webContents.session.clearCache();
  } catch (_) {}

  mainWindow.loadURL(`http://127.0.0.1:${resolvePort()}`);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// YouTube Music sign-in + cookie capture
//
// Private catalogs like the auto-generated Liked Music playlist (`LM`) and
// age-gated tracks only resolve when yt-dlp presents YouTube session cookies.
// Chrome's own cookie store is DPAPI/app-bound encrypted on Windows (yt-dlp
// cannot read it), but Electron *created* this partition's cookies itself, so
// `session.cookies.get` can read them - including the httpOnly ones a browser
// page or DevTools copy would miss. The user signs in in a real window and we
// write a Netscape cookies.txt that the server (running in this same process)
// hands to yt-dlp.
// ---------------------------------------------------------------------------

const YTM_PARTITION = 'persist:fraudio-ytm';
const YTM_URL = 'https://music.youtube.com';
// Set only once a real Google session exists on the account.
const YTM_AUTH_COOKIES = ['__Secure-1PSID', 'SAPISID'];
const YTM_POLL_MS = 1500;
const YTM_TIMEOUT_MS = 10 * 60 * 1000;

let captureInFlight = null;

function cookiesFilePath() {
  return path.join(app.getPath('userData'), 'youtube-cookies.txt');
}

function toNetscape(cookies) {
  const lines = [
    '# Netscape HTTP Cookie File',
    '# Exported by FRAUDIO - do not share this file.',
    ''
  ];
  for (const c of cookies) {
    const tailmatch = c.domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const secure = c.secure ? 'TRUE' : 'FALSE';
    const expiry = c.expirationDate ? Math.floor(c.expirationDate) : 0;
    lines.push([c.domain, tailmatch, c.path || '/', secure, String(expiry), c.name, c.value].join('\t'));
  }
  return `${lines.join('\n')}\n`;
}

async function youtubeCookies(ytmSession) {
  const all = await ytmSession.cookies.get({});
  return all.filter((c) => /(^|\.)youtube\.com$/i.test(c.domain.replace(/^\./, '')));
}

async function hasYouTubeSession(ytmSession) {
  const cookies = await youtubeCookies(ytmSession);
  const names = new Set(cookies.map((c) => c.name));
  return YTM_AUTH_COOKIES.some((n) => names.has(n));
}

function registerYtmCookieCapture() {
  ipcMain.handle('ytm:capture-cookies', async () => {
    if (captureInFlight) return captureInFlight;

    captureInFlight = (async () => {
      const ytmSession = session.fromPartition(YTM_PARTITION);
      const win = new BrowserWindow({
        width: 1020,
        height: 780,
        title: 'Sign in to YouTube Music',
        autoHideMenuBar: true,
        parent: mainWindow || undefined,
        modal: Boolean(mainWindow),
        webPreferences: {
          partition: YTM_PARTITION,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true
        }
      });

      const closedEarly = new Promise((resolve) => win.once('closed', () => resolve('closed')));

      try {
        await win.loadURL(YTM_URL);

        // Fast path: the persisted partition already holds a session (e.g. a
        // re-capture after the cookies aged out) - no click-through needed.
        const deadline = Date.now() + YTM_TIMEOUT_MS;
        let signedIn = await hasYouTubeSession(ytmSession);
        while (!signedIn && Date.now() < deadline && win.isDestroyed() === false) {
          const outcome = await Promise.race([
            new Promise((resolve) => setTimeout(() => resolve('pending'), YTM_POLL_MS)),
            closedEarly
          ]);
          if (outcome === 'closed') break;
          signedIn = await hasYouTubeSession(ytmSession).catch(() => false);
        }

        if (!signedIn) {
          if (!win.isDestroyed()) win.close();
          return { ok: false, reason: 'cancelled' };
        }

        // Let the remaining cookies (PSIDTS, consent, PREF...) settle after login.
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const cookies = await youtubeCookies(ytmSession);
        const file = cookiesFilePath();
        fs.writeFileSync(file, toNetscape(cookies), { mode: 0o600 });
        if (!win.isDestroyed()) win.close();

        console.log(`[Electron] Captured ${cookies.length} YouTube cookies -> ${file}`);
        return { ok: true, path: file, count: cookies.length };
      } catch (err) {
        console.error('[Electron] YouTube cookie capture failed:', err);
        if (!win.isDestroyed()) win.close();
        return { ok: false, reason: 'error', message: err.message };
      }
    })();

    try {
      return await captureInFlight;
    } finally {
      captureInFlight = null;
    }
  });

  ipcMain.handle('ytm:clear-cookies', async () => {
    try {
      const file = cookiesFilePath();
      if (fs.existsSync(file)) fs.rmSync(file);
      // Signing out too, so the next capture starts from a clean slate.
      await session.fromPartition(YTM_PARTITION).clearStorageData();
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  });
}

app.whenReady().then(async () => {
  // Start the bundled Express server inside this process.
  await import('./server.js');

  registerYtmCookieCapture();

  // Give Express a moment to bind before the window requests the SPA.
  setTimeout(createWindow, 700);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
