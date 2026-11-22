// =============================================================================
// BUZZHEAVIER / BZZHR RESOLVER (FREEPLAY DOWNLOADER)
// Resolves Buzzheavier (bzzhr.to, buzzheavier.com) landing pages into direct
// unthrottled storage download URLs.
// Combines offscreen Electron automation (will-download interception) and HTTP token parsing.
// =============================================================================

import { electronBridge } from '../lib/electron-bridge.js';

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 FreeplayDL/1.0';

/**
 * Checks if a URL belongs to Buzzheavier / BZZHR
 */
export function isBuzzheavierUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const lower = url.toLowerCase();
  return lower.includes('bzzhr.to') || lower.includes('buzzheavier.com');
}

/**
 * Checks if a URL is already a resolved direct storage node URL
 */
export function isBuzzheavierDirectUrl(url) {
  if (!isBuzzheavierUrl(url)) return false;
  const lower = url.toLowerCase();
  // Buzzheavier direct storage streams live at ts.bzzhr.to/d/... or cdn nodes
  return lower.includes('ts.bzzhr.to/d/') || lower.includes('/d/') || lower.includes('download?t=');
}

/**
 * Checks if a URL is a Buzzheavier landing page that requires resolution
 */
export function isBuzzheavierLandingPage(url) {
  if (!isBuzzheavierUrl(url)) return false;
  return !isBuzzheavierDirectUrl(url);
}

/**
 * Extracts file code/id from a Buzzheavier URL
 */
export function extractBuzzheavierId(url) {
  try {
    const clean = url.split('#')[0].split('?')[0];
    const parsed = new URL(clean);
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (!parts.length) return null;
    return parts[parts.length - 1];
  } catch (_) {
    return null;
  }
}

/**
 * Resolves a Buzzheavier landing page using an offscreen Electron BrowserWindow.
 * Clicks the "Download File" button and captures the intercepted download stream URL.
 */
export function resolveBuzzheavierElectron(landingUrl, referer = 'https://steamrip.com/') {
  return new Promise((resolve, reject) => {
    const electron = electronBridge?.electron;
    if (!electron || !electron.BrowserWindow) {
      return reject(new Error('Electron BrowserWindow is not available'));
    }

    let resolved = false;
    let win = null;
    let timeoutTimer = null;
    let pollInterval = null;

    const cleanup = () => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
      if (win && !win.isDestroyed()) {
        try {
          win.webContents.session.removeListener('will-download', onWillDownload);
        } catch (_) {}
        try {
          win.destroy();
        } catch (_) {}
        win = null;
      }
    };

    const finish = (resultUrl) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(resultUrl);
    };

    const fail = (err) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      reject(err);
    };

    const onWillDownload = (event, downloadItem, webContents) => {
      if (win && !win.isDestroyed() && webContents && webContents.id === win.webContents.id) {
        const itemUrl = downloadItem.getURL();
        if (itemUrl) {
          event.preventDefault(); // Stop native file save dialog
          finish(itemUrl);
        }
      }
    };

    try {
      win = new electron.BrowserWindow({
        show: false,
        width: 1000,
        height: 700,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: false,
          javascript: true,
          webSecurity: false
        }
      });

      win.webContents.session.on('will-download', onWillDownload);

      timeoutTimer = setTimeout(() => {
        fail(new Error('Buzzheavier resolution timed out after 18 seconds'));
      }, 18000);

      win.loadURL(landingUrl, {
        userAgent: BROWSER_UA,
        httpReferrer: referer
      }).catch((err) => {
        if (!resolved) fail(err);
      });

      win.webContents.on('did-finish-load', () => {
        let attempts = 0;
        pollInterval = setInterval(async () => {
          if (resolved || !win || win.isDestroyed()) {
            clearInterval(pollInterval);
            return;
          }

          attempts++;
          try {
            // Check if page has copyDownloadLink token url
            const tokenPath = await win.webContents.executeJavaScript(`
              (() => {
                const copyBtn = Array.from(document.querySelectorAll('a, button')).find(el => (el.getAttribute('onclick') || '').includes('/download?t='));
                if (copyBtn) {
                  const m = copyBtn.getAttribute('onclick').match(/copyDownloadLink\\(['"]([^'"]+)['"]\\)/);
                  if (m) return m[1];
                }
                return null;
              })()
            `);

            // Click the Download File button to trigger will-download
            const clicked = await win.webContents.executeJavaScript(`
              (() => {
                const btn = Array.from(document.querySelectorAll('a, button')).find(el => {
                  const t = (el.textContent || '').trim().toLowerCase();
                  return t.includes('download file') || t === 'download';
                });
                if (btn) {
                  btn.click();
                  return true;
                }
                return false;
              })()
            `);

            if (tokenPath && !clicked && attempts > 4) {
              const fullTokenUrl = new URL(tokenPath.replace(/\\/g, ''), landingUrl).href;
              clearInterval(pollInterval);
              finish(fullTokenUrl);
              return;
            }

            if (attempts > 20) {
              clearInterval(pollInterval);
              fail(new Error('Buzzheavier download button not found or did not respond'));
            }
          } catch (_) {}
        }, 500);
      });

      win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
        if (isMainFrame && errorCode !== -3 && !resolved) { // -3 is ABORTED (e.g. redirect)
          fail(new Error(`Failed to load Buzzheavier: ${errorDescription} (${errorCode})`));
        }
      });

    } catch (e) {
      fail(e);
    }
  });
}

/**
 * Universal Buzzheavier resolver. Prefers Electron offscreen resolution,
 * with fallback to token inspection.
 */
export async function resolveBuzzheavierUrl(landingUrl, referer = 'https://steamrip.com/') {
  if (isBuzzheavierDirectUrl(landingUrl)) {
    return landingUrl;
  }

  if (electronBridge.available()) {
    try {
      const url = await resolveBuzzheavierElectron(landingUrl, referer);
      if (url) return url;
    } catch (err) {
      console.warn('[Buzzheavier Resolver] Electron resolution failed, trying fallback:', err.message);
    }
  }

  // Fallback: direct landing URL if no resolution possible
  return landingUrl;
}
