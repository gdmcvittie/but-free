// FuckingFast (fuckingfast.co) landing-page resolver.
// Ported from my-games-server stream/fuckingfast-resolver.js; the Electron
// access now goes through lib/electron-bridge.js instead of the stream manager.

import { electronBridge } from '../lib/electron-bridge.js';

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 FreeplayDL/1.0';

/**
 * Checks if a given URL belongs to fuckingfast.co
 */
export function isFuckingFastUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return url.toLowerCase().includes('fuckingfast.co');
}

/**
 * Checks if a URL is already a direct download link.
 * Direct links on fuckingfast contain '/dl/' in the pathname or point directly to a file archive.
 * NOTE: Strips hash fragments (#...) so that landing pages like '.../abc#game.part1.rar'
 * are correctly identified as landing pages, not direct links.
 */
export function isFuckingFastDirectUrl(url) {
  if (!isFuckingFastUrl(url)) return false;
  const cleanPath = url.split('#')[0].split('?')[0].toLowerCase();
  if (cleanPath.includes('/dl/')) return true;
  const lastSegment = cleanPath.substring(cleanPath.lastIndexOf('/') + 1);
  return /\.(rar|zip|7z|bin|iso|exe)$/i.test(lastSegment);
}

/**
 * Checks if a URL is a FuckingFast landing page that needs resolution.
 */
export function isFuckingFastLandingPage(url) {
  if (!isFuckingFastUrl(url)) return false;
  return !isFuckingFastDirectUrl(url);
}

/**
 * Extracts the file ID from a FuckingFast URL.
 * Examples:
 *   https://fuckingfast.co/w0rjak7wfvnh#filename.part1.rar -> w0rjak7wfvnh
 *   https://fuckingfast.co/f/w0rjak7wfvnh -> w0rjak7wfvnh
 */
export function extractFuckingFastId(url) {
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
 * Resolves a FuckingFast landing page via lightweight HTTP requests.
 * Uses the site's HTMX POST endpoint (/f/{id}/go) or parses direct download hints.
 */
export async function resolveFuckingFastHttp(url) {
  const cleanUrl = url.split('#')[0];
  const fileId = extractFuckingFastId(cleanUrl);
  if (!fileId) throw new Error('Could not parse file ID from FuckingFast URL');

  // Strategy 1: Direct HTMX POST to /f/{id}/go
  try {
    const postEndpoint = `https://fuckingfast.co/f/${fileId}/go`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);

    const postRes = await fetch(postEndpoint, {
      method: 'POST',
      signal: controller.signal,
      redirect: 'manual',
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept': '*/*',
        'Referer': cleanUrl,
        'Origin': 'https://fuckingfast.co',
        'HX-Request': 'true',
        'HX-Current-URL': cleanUrl
      }
    });
    clearTimeout(timeout);

    const redirectUrl = postRes.headers.get('hx-redirect') ||
                        postRes.headers.get('hx-location') ||
                        postRes.headers.get('location');

    if (redirectUrl) {
      const fullUrl = new URL(redirectUrl, 'https://fuckingfast.co').href;
      if (isFuckingFastDirectUrl(fullUrl)) {
        return fullUrl;
      }
    }

    const postBody = await postRes.text().catch(() => '');
    const bodyMatch = postBody.match(/https:\/\/[a-zA-Z0-9.-]*fuckingfast\.co\/dl\/[^\s"'<>\\]+/i) ||
                      postBody.match(/window\.open\(\s*["']([^"']+)["']/i) ||
                      postBody.match(/(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/i);
    if (bodyMatch && bodyMatch[1]) {
      const candidate = new URL(bodyMatch[1], 'https://fuckingfast.co').href;
      if (isFuckingFastDirectUrl(candidate)) {
        return candidate;
      }
    }
  } catch (_) {
    // Fall through to Strategy 2
  }

  // Strategy 2: Fetch landing page HTML and inspect for download action or embedded link
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const pageRes = await fetch(cleanUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });
    clearTimeout(timeout);

    if (pageRes.ok) {
      const html = await pageRes.text();

      const inlineDlMatch = html.match(/https:\/\/[a-zA-Z0-9.-]*fuckingfast\.co\/dl\/[^\s"'<>\\]+/i) ||
                            html.match(/window\.open\(\s*["'](https?:\/\/[^"']+)["']/i) ||
                            html.match(/(?:window\.)?location(?:\.href)?\s*=\s*["'](https?:\/\/[^"']+)["']/i);
      if (inlineDlMatch && inlineDlMatch[1]) {
        const fullUrl = new URL(inlineDlMatch[1], 'https://fuckingfast.co').href;
        if (isFuckingFastDirectUrl(fullUrl)) {
          return fullUrl;
        }
      }

      const hxEndpointMatch = html.match(/(?:hx-post|data-hx-post)=["']([^"']+)["']/i) ||
                              html.match(/(?:hx-get|data-hx-get)=["']([^"']+)["']/i);
      if (hxEndpointMatch && hxEndpointMatch[1]) {
        const endpoint = new URL(hxEndpointMatch[1], 'https://fuckingfast.co').href;
        const method = html.includes('hx-get') ? 'GET' : 'POST';

        const subRes = await fetch(endpoint, {
          method,
          redirect: 'manual',
          headers: {
            'User-Agent': BROWSER_UA,
            'Accept': '*/*',
            'Referer': cleanUrl,
            'Origin': 'https://fuckingfast.co',
            'HX-Request': 'true',
            'HX-Current-URL': cleanUrl
          }
        });

        const subRedirect = subRes.headers.get('hx-redirect') ||
                            subRes.headers.get('hx-location') ||
                            subRes.headers.get('location');
        if (subRedirect) {
          const resolved = new URL(subRedirect, 'https://fuckingfast.co').href;
          if (isFuckingFastDirectUrl(resolved)) {
            return resolved;
          }
        }
      }
    }
  } catch (_) {
    // Strategy 2 failed
  }

  throw new Error('HTTP resolution did not yield direct download link');
}

/**
 * Resolves a FuckingFast landing page using an offscreen Electron BrowserWindow.
 * Bypasses the initial ad-click by simulating the dual-click flow while blocking
 * all popup ad windows.
 */
export function resolveFuckingFastElectron(url) {
  return new Promise((resolve, reject) => {
    const electron = electronBridge?.electron;
    if (!electron || !electron.BrowserWindow) {
      return reject(new Error('Electron BrowserWindow is not available'));
    }

    const cleanUrl = url.split('#')[0];
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
          event.preventDefault(); // Stop native browser file save dialog
          finish(itemUrl);
        }
      }
    };

    try {
      win = new electron.BrowserWindow({
        show: false,
        width: 800,
        height: 600,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: false,
          javascript: true,
          webSecurity: false
        }
      });

      // 1. Block any ad popups triggered by clicks
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

      // 2. Intercept will-download on this session
      win.webContents.session.on('will-download', onWillDownload);

      // 3. Intercept navigation / redirects to direct download
      win.webContents.on('will-navigate', (event, targetUrl) => {
        if (isFuckingFastDirectUrl(targetUrl)) {
          event.preventDefault();
          finish(targetUrl);
        }
      });

      win.webContents.on('will-redirect', (event, targetUrl) => {
        if (isFuckingFastDirectUrl(targetUrl)) {
          event.preventDefault();
          finish(targetUrl);
        }
      });

      // 4. On page load finish, automate the two-click flow
      win.webContents.on('did-finish-load', async () => {
        try {
          await new Promise(r => setTimeout(r, 600));
          if (resolved || !win || win.isDestroyed()) return;

          // Inject script that hooks network requests and simulates the 2 clicks
          await win.webContents.executeJavaScript(`
            (() => {
              try { window.open = () => null; } catch (_) {}
              try { if ('dynamic' in window) window.dynamic = ''; } catch (_) {}

              if (!window.__ffHooked) {
                window.__ffHooked = true;
                const origFetch = window.fetch;
                if (typeof origFetch === 'function') {
                  window.fetch = async function(...args) {
                    const res = await origFetch.apply(this, args);
                    try {
                      const redir = res.headers.get('hx-redirect') || res.headers.get('hx-location') || res.headers.get('location');
                      if (redir) window.__capturedDirectUrl = redir;
                    } catch (_) {}
                    return res;
                  };
                }

                if (window.XMLHttpRequest) {
                  const origOpen = XMLHttpRequest.prototype.open;
                  XMLHttpRequest.prototype.open = function(method, url) {
                    this.addEventListener('load', function() {
                      try {
                        const redir = this.getResponseHeader('hx-redirect') || this.getResponseHeader('hx-location') || this.getResponseHeader('location');
                        if (redir) window.__capturedDirectUrl = redir;
                      } catch (_) {}
                    });
                    return origOpen.apply(this, arguments);
                  };
                }
              }

              // Check existing anchors for direct download link
              const directLink = Array.from(document.querySelectorAll('a[href*="/dl/"]')).map(a => a.href)[0];
              if (directLink) {
                window.__capturedDirectUrl = directLink;
                return;
              }

              // Find download trigger element
              const targets = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"], [role="button"]'))
                .filter(el => {
                  const txt = (el.textContent || el.value || el.getAttribute('aria-label') || '').toLowerCase();
                  const hx = (el.getAttribute('hx-post') || el.getAttribute('data-hx-post') || el.getAttribute('href') || '').toLowerCase();
                  return txt.includes('download') || txt.includes('fast') || txt.includes('file') || hx.includes('/go') || hx.includes('/dl/');
                });

              const btn = targets[0] || document.querySelector('[hx-post], [data-hx-post], button');
              if (btn) {
                // First click: disarms ad trigger
                btn.click();
                // Second click: triggers real download
                setTimeout(() => {
                  try {
                    const btn2 = targets[0] || document.querySelector('[hx-post], [data-hx-post], button');
                    if (btn2) btn2.click();
                  } catch (_) {}
                }, 450);
              }
            })()
          `);

          // Poll for captured URL
          let pollCount = 0;
          pollInterval = setInterval(async () => {
            pollCount++;
            if (resolved || !win || win.isDestroyed() || pollCount > 35) {
              if (pollInterval) {
                clearInterval(pollInterval);
                pollInterval = null;
              }
              return;
            }
            try {
              const captured = await win.webContents.executeJavaScript(`
                (() => {
                  if (window.__capturedDirectUrl) return window.__capturedDirectUrl;
                  const dl = Array.from(document.querySelectorAll('a[href*="/dl/"]')).map(a => a.href)[0];
                  return dl || null;
                })()
              `);
              if (captured && isFuckingFastDirectUrl(captured)) {
                finish(captured);
              }
            } catch (_) {}
          }, 350);

        } catch (_) {}
      });

      win.webContents.on('did-fail-load', (_e, errorCode, errorDescription) => {
        if (errorCode === -3) return; // ABORTED
        console.warn(`[FuckingFast Electron Resolver] Load failed: ${errorDescription} (${errorCode})`);
      });

      // Timeout safety: 14 seconds max
      timeoutTimer = setTimeout(() => {
        fail(new Error('Timed out waiting for FuckingFast download trigger in Electron'));
      }, 14000);

      win.loadURL(cleanUrl);
    } catch (e) {
      fail(e);
    }
  });
}

/**
 * Main resolver entry point.
 * Attempts fast HTTP resolution first, then falls back to Electron BrowserWindow automation.
 */
export async function resolveFuckingFastUrl(url) {
  if (!isFuckingFastUrl(url)) return url;
  if (isFuckingFastDirectUrl(url)) return url;

  console.log(`[FuckingFast Resolver] Resolving landing page URL: ${url}`);

  // 1. Try fast HTTP resolution first
  try {
    const directHttpUrl = await resolveFuckingFastHttp(url);
    if (directHttpUrl && isFuckingFastDirectUrl(directHttpUrl)) {
      console.log(`[FuckingFast Resolver] Successfully resolved via HTTP: ${directHttpUrl}`);
      return directHttpUrl;
    }
  } catch (httpErr) {
    console.log(`[FuckingFast Resolver] HTTP resolution attempt note: ${httpErr.message}`);
  }

  // 2. Try Electron offscreen resolver fallback
  if (electronBridge?.electron?.BrowserWindow) {
    console.log(`[FuckingFast Resolver] Attempting Electron offscreen resolver...`);
    try {
      const directElectronUrl = await resolveFuckingFastElectron(url);
      if (directElectronUrl && isFuckingFastDirectUrl(directElectronUrl)) {
        console.log(`[FuckingFast Resolver] Successfully resolved via Electron: ${directElectronUrl}`);
        return directElectronUrl;
      }
    } catch (elecErr) {
      console.warn(`[FuckingFast Resolver] Electron resolver failed: ${elecErr.message}`);
    }
  }

  throw new Error('Unable to automatically extract direct download link from FuckingFast');
}
