// WebTorrent engine: magnet parsing, torrent id resolution, file inspection.
// Ported from my-games-server server.js ("PC Games Torrent Queue & WebTorrent Engine").

export const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://tracker.openbittorrent.com:80/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://glotorrents.pw:6969/announce',
  'udp://tracker.leechers-paradise.org:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://explodie.org:6969/announce',
  'http://tracker.opentrackr.org:1337/announce',
  'http://tracker.openbittorrent.com:80/announce'
];

export function parseMagnetToObject(url) {
  if (!url || typeof url !== 'string') return null;
  const clean = url.trim()
    .replace(/&#038;/g, '&')
    .replace(/&amp;/gi, '&');

  const xtMatch = clean.match(/[?&]xt=urn:btih:([a-fA-F0-9]{40}|[A-Z2-7]{32})/i);
  if (!xtMatch) return null;

  let infoHashHex = xtMatch[1].toLowerCase();
  if (infoHashHex.length === 32) {
    const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
    let bits = 0, val = 0, hex = '';
    for (const c of infoHashHex) {
      val = (val << 5) | BASE32.indexOf(c);
      bits += 5;
      if (bits >= 8) {
        bits -= 8;
        hex += ((val >> bits) & 0xFF).toString(16).padStart(2, '0');
      }
    }
    infoHashHex = hex;
  }

  const dnMatch = clean.match(/[?&]dn=([^&]*)/);
  let name = infoHashHex;
  if (dnMatch) {
    try {
      name = decodeURIComponent(dnMatch[1].replace(/\+/g, ' '));
    } catch (_) {
      name = dnMatch[1].replace(/\+/g, ' ');
    }
  }

  const trMatches = [...clean.matchAll(/[?&]tr=([^&]+)/g)];
  const existingTrackers = trMatches
    .map(m => {
      try {
        return decodeURIComponent(m[1]);
      } catch {
        return m[1];
      }
    })
    .filter(Boolean);
  const announce = [...new Set([...existingTrackers, ...DEFAULT_TRACKERS])];

  return { infoHashHex, name, announce };
}

export async function resolveTorrentId(rawUrl) {
  if (!rawUrl) throw new Error('Missing torrent URL');
  const cleanUrl = String(rawUrl).trim().replace(/&#038;/g, '&').replace(/&amp;/gi, '&');

  if (/^https?:\/\//i.test(cleanUrl)) {
    const res = await fetch(cleanUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (!res.ok) throw new Error(`Failed to fetch torrent file: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const asText = buf.toString('utf-8').trim();
    if (asText.startsWith('magnet:')) {
      const parsed = parseMagnetToObject(asText);
      if (!parsed) throw new Error('Invalid magnet link: missing info hash');
      return { kind: 'magnet', parsed };
    }
    return { kind: 'buffer', buffer: buf };
  }
  if (/^magnet:/i.test(cleanUrl)) {
    const parsed = parseMagnetToObject(cleanUrl);
    if (!parsed) throw new Error('Invalid magnet link: missing info hash');
    return { kind: 'magnet', parsed };
  }
  if (/^[a-f0-9]{40}$/i.test(cleanUrl) || /^[a-z2-7]{32}$/i.test(cleanUrl)) {
    return { kind: 'hash', hash: cleanUrl.toLowerCase() };
  }
  if (Buffer.isBuffer(rawUrl)) {
    return { kind: 'buffer', buffer: rawUrl };
  }
  throw new Error('Invalid torrent identifier: ' + String(cleanUrl).substring(0, 50));
}

// ── WebTorrent Engine ────────────────────────────────────────────────────
let WebTorrentClass = null;
let wtClientInstance = null;

export async function getWebTorrentClient() {
  if (wtClientInstance) return wtClientInstance;
  try {
    const mod = await import('webtorrent');
    WebTorrentClass = mod.default || mod;
  } catch (err) {
    console.warn('[Torrent Engine] WebTorrent import failed:', err.message);
    return null;
  }

  if (WebTorrentClass) {
    try {
      wtClientInstance = new WebTorrentClass({
        maxConns: 55,
        dht: true,
        tracker: true
      });
      wtClientInstance.on('error', (e) => {
        console.warn('[WebTorrent Client Warning]', e.message);
      });
      console.log('[Torrent Engine] WebTorrent client initialized');
      return wtClientInstance;
    } catch (e) {
      console.error('[Torrent Engine] Failed to initialize client:', e.message);
    }
  }
  return null;
}

/**
 * Fetches a torrent's file list without downloading it (deselect: true).
 * `opts.isQueued(url)` lets the download queue keep temp torrents alive
 * when the same URL is already part of the persistent queue.
 */
export async function inspectTorrentFiles(rawUrl, downloadsFolder, timeoutMs = 20000, opts = {}) {
  const client = await getWebTorrentClient();
  if (!client) throw new Error('WebTorrent engine is not initialized');

  const resolved = await resolveTorrentId(rawUrl);
  const targetHash = (resolved.kind === 'magnet')
    ? resolved.parsed.infoHashHex
    : (resolved.kind === 'hash' ? resolved.hash : null);

  let existing = targetHash && Array.isArray(client.torrents)
    ? client.torrents.find(t => t.infoHash === targetHash)
    : null;

  if (existing && Array.isArray(existing.files) && existing.files.length > 0) {
    return {
      name: existing.name || 'PC Torrent',
      infoHash: existing.infoHash,
      totalBytes: existing.length,
      files: existing.files.map((f, i) => ({
        index: i,
        name: f.name,
        path: f.path,
        length: f.length
      }))
    };
  }

  let tempTorrent = null;
  let isTemp = false;

  if (!existing || existing.destroyed) {
    isTemp = true;
    if (resolved.kind === 'magnet') {
      tempTorrent = client.add(resolved.parsed.infoHashHex, {
        path: downloadsFolder,
        announce: resolved.parsed.announce,
        name: resolved.parsed.name,
        deselect: true
      });
    } else if (resolved.kind === 'hash') {
      tempTorrent = client.add(resolved.hash, { path: downloadsFolder, deselect: true });
    } else {
      tempTorrent = client.add(resolved.buffer, { path: downloadsFolder, deselect: true });
    }
  } else {
    tempTorrent = existing;
  }

  return new Promise((resolve, reject) => {
    let timer = setTimeout(() => {
      if (isTemp && tempTorrent && !(typeof opts.isQueued === 'function' && opts.isQueued(rawUrl))) {
        try { tempTorrent.destroy({ destroyStore: false }); } catch (_) {}
      }
      reject(new Error('Timed out fetching torrent file list from DHT/trackers (peer discovery took >20s).'));
    }, timeoutMs);

    const onMetadata = () => {
      clearTimeout(timer);
      const files = (tempTorrent.files || []).map((f, i) => ({
        index: i,
        name: f.name,
        path: f.path,
        length: f.length
      }));
      resolve({
        name: tempTorrent.name,
        infoHash: tempTorrent.infoHash,
        totalBytes: tempTorrent.length,
        files
      });
    };

    if (tempTorrent.files && tempTorrent.files.length > 0) {
      onMetadata();
    } else {
      tempTorrent.once('metadata', onMetadata);
      tempTorrent.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    }
  });
}
