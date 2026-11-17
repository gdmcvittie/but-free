// =============================================================================
// FILEKEEPER RESOLVER (FREEPLAY DOWNLOADER)
// Resolves FileKeeper (filekeeper.net) landing pages into direct storage download URLs
// Uses pure HTTP multi-step session requests with cookie preservation
// =============================================================================

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 FreeplayDL/1.0';

/**
 * Checks if a URL belongs to FileKeeper
 */
export function isFileKeeperUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return url.toLowerCase().includes('filekeeper.net');
}

/**
 * Checks if a URL is already a resolved direct storage node URL
 */
export function isFileKeeperDirectUrl(url) {
  if (!isFileKeeperUrl(url)) return false;
  const lower = url.toLowerCase();
  return lower.includes(':8443') || lower.includes('/d/') || lower.includes('fs') || lower.includes('/download/');
}

/**
 * Checks if a URL is a FileKeeper landing page that requires resolution
 */
export function isFileKeeperLandingPage(url) {
  if (!isFileKeeperUrl(url)) return false;
  return !isFileKeeperDirectUrl(url);
}

/**
 * Extracts file code/id from a FileKeeper URL
 */
export function extractFileKeeperId(url) {
  try {
    const clean = url.split('#')[0].split('?')[0];
    const parsed = new URL(clean);
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (!parts.length) return null;
    return parts[0]; // e.g. /1bzxpzmcdwpd or /1bzxpzmcdwpd/filename.rar -> 1bzxpzmcdwpd
  } catch (_) {
    return null;
  }
}

/**
 * Resolves a FileKeeper landing page into a direct storage download URL
 */
export async function resolveFileKeeperUrl(landingUrl, referer = 'https://romslab.com/') {
  const fileId = extractFileKeeperId(landingUrl);
  if (!fileId) throw new Error('Could not parse file ID from FileKeeper URL');

  // Step 1: GET landing page with manual redirect to capture Set-Cookie: file_code=...
  const r1 = await fetch(landingUrl, {
    method: 'GET',
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

  // Step 2: GET /download page with file_code cookie
  const r2 = await fetch(loc, {
    headers: {
      'User-Agent': BROWSER_UA,
      'Referer': referer,
      'Cookie': fileCodeCookie,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }
  });

  if (!r2.ok) {
    throw new Error(`FileKeeper page responded with HTTP ${r2.status}`);
  }

  const html2 = await r2.text();
  if (html2.includes('404 File Not Found') || html2.includes('The file expired') || html2.includes('The file was deleted')) {
    throw new Error('File has expired or was removed on FileKeeper (404 Not Found)');
  }

  // Extract metadata from <div id="download-countdown">
  const cdTagMatch = html2.match(/<[^>]+id=["']download-countdown["'][^>]*>/i);
  const cdTag = cdTagMatch ? cdTagMatch[0] : '';

  const code = cdTag.match(/data-code=["']([^"']*)["']/i)?.[1] ||
               html2.match(/name=["']id["']\s+value=["']([^"']*)["']/i)?.[1] ||
               fileId;

  const rand = cdTag.match(/data-rand=["']([^"']*)["']/i)?.[1] ||
               html2.match(/name=["']rand["']\s+value=["']([^"']*)["']/i)?.[1] ||
               '';

  const postReferer = cdTag.match(/data-referer=["']([^"']*)["']/i)?.[1] ||
                      html2.match(/name=["']referer["']\s+value=["']([^"']*)["']/i)?.[1] ||
                      referer;

  const method = cdTag.match(/data-method=["']([^"']*)["']/i)?.[1] ||
                 html2.match(/name=["']method_free["']\s+value=["']([^"']*)["']/i)?.[1] ||
                 '';

  // Step 3: POST to initiate direct download with down_direct=1
  const postEndpoint = `https://filekeeper.net/${code}`;
  const params = new URLSearchParams({
    op: 'download2',
    id: code,
    rand: rand,
    referer: postReferer,
    method_free: method,
    down_direct: '1'
  });

  const r3 = await fetch(postEndpoint, {
    method: 'POST',
    headers: {
      'User-Agent': BROWSER_UA,
      'Referer': loc,
      'Origin': 'https://filekeeper.net',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': fileCodeCookie
    },
    body: params.toString(),
    redirect: 'manual'
  });

  // Check Location header for direct storage node URL (e.g., https://fs2.filekeeper.net:8443/d/...)
  const directLocation = r3.headers.get('location');
  if (directLocation) {
    return new URL(directLocation, 'https://filekeeper.net').href;
  }

  // If status is 200 and Content-Type is not HTML, the response itself is the direct file stream
  const contentType = r3.headers.get('content-type') || '';
  if (r3.ok && !contentType.includes('text/html')) {
    return postEndpoint;
  }

  // Check if direct link is embedded in the response body
  const bodyText = await r3.text().catch(() => '');
  const directMatch = bodyText.match(/https?:\/\/[a-zA-Z0-9.-]*filekeeper\.net(?::8443|\/d\/)[^\s"'<>\\]+/i);
  if (directMatch) {
    return directMatch[0];
  }

  throw new Error('FileKeeper resolution did not yield direct download link');
}
