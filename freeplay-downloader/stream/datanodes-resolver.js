// =============================================================================
// DATANODES RESOLVER (FREEPLAY DOWNLOADER)
// Resolves DataNodes (datanodes.to) landing pages into direct storage download URLs
// Combines HTTP multi-step session resolution and offscreen Electron automation
// =============================================================================

import { electronBridge } from '../lib/electron-bridge.js';

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 FreeplayDL/1.0';

/**
 * Checks if a URL is from DataNodes
 */
export function isDataNodesUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return url.toLowerCase().includes('datanodes.to');
}

/**
 * Checks if a URL is already a resolved direct storage node URL
 */
export function isDataNodesDirectUrl(url) {
  if (!isDataNodesUrl(url)) return false;
  const lower = url.toLowerCase();
  return lower.includes(':8443') || lower.includes('/d/') || /node\d*\./i.test(lower);
}

/**
 * Checks if a URL is a DataNodes landing page that requires resolution
 */
export function isDataNodesLandingPage(url) {
  if (!isDataNodesUrl(url)) return false;
  return !isDataNodesDirectUrl(url);
}

/**
 * Extracts file code/id from a DataNodes URL
 */
export function extractDataNodesId(url) {
  try {
    const clean = url.split('#')[0].split('?')[0];
    const parsed = new URL(clean);
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (!parts.length) return null;
    return parts[0];
  } catch (_) {
    return null;
  }
}

/**
 * Resolves a DataNodes landing page via HTTP 4-step session requests.
 * Uses the site's official X-Dn-Dl direct download API.
 */
export async function resolveDataNodesHttp(landingUrl, referer = 'https://romslab.com/') {
  const fileId = extractDataNodesId(landingUrl);
  if (!fileId) throw new Error('Could not parse file ID from DataNodes URL');

  // Step 1: GET landing page to capture 302 redirect and file_code session cookie
  const r1 = await fetch(landingUrl, {
    headers: {
      'User-Agent': BROWSER_UA,
      'Referer': referer,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    },
    redirect: 'manual'
  });

  const cookieHeader = r1.headers.get('set-cookie');
  const fileCodeCookie = cookieHeader ? cookieHeader.split(';')[0] : `file_code=${fileId}`;
  const loc = new URL(r1.headers.get('location') || landingUrl, landingUrl).href;

  // Step 2: GET /download page with file_code cookie to get the real download form
  const r2 = await fetch(loc, {
    headers: {
      'User-Agent': BROWSER_UA,
      'Referer': referer,
      'Cookie': fileCodeCookie,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }
  });

  if (!r2.ok) {
    throw new Error(`DataNodes page responded with HTTP ${r2.status}`);
  }

  const html2 = await r2.text();
  if (html2.includes('File Not Found') || html2.includes('deadfile')) {
    throw new Error('File has expired or was deleted from DataNodes (deadfile)');
  }

  // Extract real form fields specifically from #downloadForm (ignoring dummy deceptive inputs)
  const formMatch = html2.match(/<form[^>]*id=["']downloadForm["'][^>]*>([\s\S]*?)<\/form>/i);
  const formHtml = formMatch ? formMatch[1] : html2;

  const realId = formHtml.match(/name=["']id["']\s+value=["']([^"']*)["']/i)?.[1] || fileId;
  const realFname = formHtml.match(/name=["']fname["']\s+value=["']([^"']*)["']/i)?.[1] || '';

  // Step 3: POST step 1 form (Continue to Download)
  const r3 = await fetch(loc, {
    method: 'POST',
    headers: {
      'User-Agent': BROWSER_UA,
      'Referer': loc,
      'Cookie': fileCodeCookie,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      op: 'download1',
      usr_login: '',
      id: realId,
      fname: realFname,
      referer: referer,
      method_free: 'Free Download >>'
    }).toString()
  });

  if (!r3.ok) {
    throw new Error(`DataNodes Step 1 failed with HTTP ${r3.status}`);
  }

  const html3 = await r3.text();
  const cdTagMatch = html3.match(/<download-countdown[\s\S]*?>/i);
  if (!cdTagMatch) {
    // If no countdown tag, check if direct link is in HTML
    const dlLinkMatch = html3.match(/https?:\/\/[a-zA-Z0-9.-]*datanodes\.to(?::8443|\/d\/)[^\s"'<>\\]+/i);
    if (dlLinkMatch) return dlLinkMatch[0];
    throw new Error('DataNodes Step 1 did not return countdown metadata');
  }

  const cdTag = cdTagMatch[0];
  const rand = cdTag.match(/rand=["']([^"']*)["']/i)?.[1] || '';
  const dlToken = cdTag.match(/dl-token=["']([^"']*)["']/i)?.[1] || '';
  const freeMethod = cdTag.match(/free-method=["']([^"']*)["']/i)?.[1] || 'Free Download >>';
  const hasCaptcha = cdTag.includes(':has-captcha="true"');

  // Step 4: POST Step 2 with official X-Dn-Dl JSON API header
  const params = new URLSearchParams({
    op: 'download2',
    id: realId,
    rand: rand,
    referer: referer,
    method_free: freeMethod,
    method_premium: '',
    dl_token: dlToken,
    down_direct: '1'
  });

  const r4 = await fetch(loc, {
    method: 'POST',
    headers: {
      'User-Agent': BROWSER_UA,
      'Referer': loc,
      'Origin': 'https://datanodes.to',
      'X-Dn-Dl': '1',
      'Cookie': fileCodeCookie,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString(),
    redirect: 'manual'
  });

  const loc4 = r4.headers.get('location');
  if (loc4 && isDataNodesDirectUrl(loc4)) {
    return new URL(loc4, 'https://datanodes.to').href;
  }

  const contentType4 = r4.headers.get('content-type') || '';
  if (contentType4.includes('application/json')) {
    try {
      const json = await r4.json();
      if (json && json.url) {
        return decodeURIComponent(json.url);
      }
      if (json && json.error) {
        throw new Error(`DataNodes error: ${json.error}`);
      }
    } catch (parseErr) {
      if (parseErr.message && parseErr.message.includes('DataNodes error:')) throw parseErr;
    }
  }

  const text4 = await r4.text();
  const directLink = text4.match(/https?:\/\/[a-zA-Z0-9.-]*datanodes\.to(?::8443|\/d\/)[^\s"'<>\\]+/i);
  if (directLink) {
    return directLink[0];
  }

  if (hasCaptcha) {
    throw new Error('DataNodes requires browser verification (Cloudflare Turnstile)');
  }

  throw new Error('DataNodes HTTP resolution did not return direct download link');
}

/**
 * Resolves a DataNodes landing page using an offscreen Electron BrowserWindow.
 * Executes the 3-step download flow (Continue -> Free Download -> Start Download)
 * and captures the final storage node URL via will-download.
 */
export function resolveDataNodesElectron(url, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const electron = electronBridge?.electron;
    if (!electron || !electron.BrowserWindow) {
      return reject(new Error('Electron BrowserWindow is not available in standalone mode'));
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
          event.preventDefault(); // Stop native browser file dialog
          finish(itemUrl);
        }
      }
    };

    try {
      win = new electron.BrowserWindow({
        show: false,
        width: 1024,
        height: 768,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: false,
          javascript: true,
          webSecurity: false
        }
      });

      win.webContents.session.on('will-download', onWillDownload);

      // Block popups and external ad windows
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

      // Set timeout
      timeoutTimer = setTimeout(() => {
        fail(new Error(`DataNodes resolution timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);

      // Automated 3-stage clicker injected into the page
      const autoClickerScript = `
        (function() {
          if (window.__dnAutoClickerActive) return;
          window.__dnAutoClickerActive = true;

          var step1Done = false;
          var step2Done = false;
          var step3Done = false;

          var timer = setInterval(function() {
            // Stage 1: "Continue to Download" (#method_free)
            if (!step1Done) {
              var btn1 = document.getElementById('method_free');
              if (btn1 && !btn1.disabled) {
                btn1.click();
                step1Done = true;
              }
            }

            // Stage 2: "Free Download" (triggers countdown & turnstile)
            if (!step2Done) {
              var buttons = document.querySelectorAll('button');
              for (var i = 0; i < buttons.length; i++) {
                var b = buttons[i];
                if ((b.textContent || '').includes('Free Download') && !b.disabled) {
                  b.click();
                  step2Done = true;
                  break;
                }
              }
            }

            // Stage 3: "Start Download" (starts actual download)
            if (!step3Done) {
              var btns = document.querySelectorAll('button');
              for (var j = 0; j < btns.length; j++) {
                var btn = btns[j];
                if ((btn.textContent || '').includes('Start Download') && !btn.disabled) {
                  btn.click();
                  step3Done = true;
                  clearInterval(timer);
                  break;
                }
              }
            }
          }, 1000);
        })();
      `;

      win.webContents.on('did-finish-load', () => {
        win.webContents.executeJavaScript(autoClickerScript).catch(() => {});
      });

      // Poll periodically to re-inject in case of dynamic DOM/SPA changes
      pollInterval = setInterval(() => {
        if (!win || win.isDestroyed()) return;
        win.webContents.executeJavaScript(autoClickerScript).catch(() => {});
      }, 2000);

      win.loadURL(url, {
        userAgent: BROWSER_UA,
        httpReferrer: 'https://romslab.com/'
      }).catch(err => {
        fail(new Error(`Failed to load DataNodes URL in browser: ${err.message}`));
      });

    } catch (err) {
      fail(err);
    }
  });
}

/**
 * Main DataNodes URL resolver:
 * Tries HTTP session resolution first; falls back to Electron BrowserWindow automation.
 */
export async function resolveDataNodesUrl(url, referer = 'https://romslab.com/') {
  if (!isDataNodesLandingPage(url)) return url;

  // 1. Try lightweight HTTP resolution
  try {
    const directUrl = await resolveDataNodesHttp(url, referer);
    if (directUrl && isDataNodesDirectUrl(directUrl)) {
      return directUrl;
    }
  } catch (httpErr) {
    // If not Turnstile blocked or if Electron is available, proceed to fallback
    if (electronBridge?.electron?.BrowserWindow) {
      try {
        const electronUrl = await resolveDataNodesElectron(url);
        if (electronUrl) return electronUrl;
      } catch (electronErr) {
        throw new Error(`DataNodes resolution failed: ${electronErr.message}`);
      }
    }
    throw httpErr;
  }

  throw new Error('Could not resolve DataNodes download URL');
}
