// Download queue engine: 1-at-a-time processing of BitTorrent (magnet/.torrent)
// and direct HTTP downloads into the user-configured downloads folder, with
// automatic archive extraction afterwards.
// Ported from my-games-server server.js ("PC Games Torrent Queue", "Direct
// Download Queue" and "Automatic Archive Extraction" sections); downloads now
// target a user-selected downloads folder instead of ROMs/PC and finished
// downloads are no longer registered into a games library.

import path from 'path';
import fs from 'fs';
import http from 'http';
import https from 'https';
import { execFile } from 'child_process';
import { unpack7z, detectArchiveFileType } from './archive.js';
import { isFuckingFastLandingPage, resolveFuckingFastUrl } from './fuckingfast-resolver.js';
import { classifyDownloadUrl, extractMagnetName } from './link-utils.js';
import { getWebTorrentClient, resolveTorrentId, inspectTorrentFiles } from './torrent-engine.js';

export function cleanPcGameTitle(rawTitle) {
  if (!rawTitle) return '';
  let str = String(rawTitle)
    .replace(/&#8211;/g, '–')
    .replace(/&#8212;/g, '—')
    .replace(/&#8217;/g, "'")
    .replace(/&#8216;/g, "'")
    .replace(/&#038;/g, '&')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");

  // 1. Remove bracketed tags: [FitGirl Repack], [DODI Repack], [GOG], [Monkey Repack], [FLT], etc.
  str = str.replace(/\[[^\]]*\]/g, ' ');

  // 2. Remove parenthesized version / update / dlc info
  str = str.replace(/\((?:v\d|build\b|update\b|patch\b|multilingual|multi\d|inc|incl|\+|all dlc).*?\)/gi, ' ');
  str = str.replace(/\(\s*v?[\d\.]+[^\)]*\)/gi, ' ');

  // 3. Remove trailing separator followed by version, build, repack, or DLC notes (including comma separator)
  str = str.replace(/\s*[,–—:\-]\s*(?:v\d|build\b|update\b|patch\b|\+\s*\d|all dlc|bonus).*$/gi, ' ');
  str = str.replace(/\s*,\s*v?\d+(?:\.\d+)*.*$/gi, ' ');

  // 4. Remove standalone version strings like "v1.0.1", "v2.12"
  str = str.replace(/\bv\d+(?:\.\d+)+[a-z0-9_]*\b/gi, ' ');

  // 5. Remove repacker and release terms
  str = str.replace(/\b(?:FitGirl|DODI|Monkey|ElAmigos|TENOKE|RUNE|SKIDROW|CODEX|FLT|TiNYiSO|Razor1911)\b/gi, ' ');
  str = str.replace(/\b(?:Repack|Steam-Rip|GOG-Rip|Portable|Lossless|Rip)\b/gi, ' ');

  // 6. Clean up title aliases like "Game Name / Alias" -> keep primary title
  if (str.includes(' / ')) {
    const parts = str.split(' / ').map(p => p.trim()).filter(Boolean);
    if (parts.length > 1 && parts[0].length >= 3) {
      str = parts[0];
    }
  }

  // 7. Replace colons and invalid Windows filesystem chars with clean dashes
  str = str.replace(/\s*:\s*/g, ' - ');
  str = str.replace(/[*?"<>|\\\/]/g, ' ');

  // 8. Strip trailing and leading punctuation and multiple spaces
  str = str.replace(/[\s\-_–—:,]+$/, '').replace(/^[\s\-_–—:,]+/, '');
  str = str.replace(/\s+/g, ' ').trim();

  // Fallback if stripped excessively
  if (str.length < 2) {
    str = String(rawTitle).replace(/\[[^\]]*\]/g, '').replace(/[:*?"<>|\\\/]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  return str;
}

export function sanitizeFolderName(name) {
  if (!name) return 'Game';
  return String(name)
    .replace(/[:*?"<>|\\\/]/g, ' - ')
    .replace(/\s+/g, ' ')
    .replace(/\s*-\s*-\s*/g, ' - ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
}

export function sanitizeFilename(name) {
  return String(name || 'download')
    .replace(/[/\\?%*:|"<>]/g, '_')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
}

// ── Automatic Archive Extraction & Cleanup ─────────────────────────────────

// Module-level broadcast hook, bound by createDownloadQueue(). Kept at module
// scope because autoExtractAndCleanGameFolder is defined before the factory.
let _broadcastEvent = () => {};

function getDirSizeBytes(dirPath) {
  let total = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dirPath, e.name);
      if (e.isFile()) {
        try { total += fs.statSync(full).size; } catch (_) {}
      } else if (e.isDirectory()) {
        total += getDirSizeBytes(full);
      }
    }
  } catch (_) {}
  return total;
}

function findArchiveSetsInDir(dirPath) {
  let fileNames = [];
  try {
    fileNames = fs.readdirSync(dirPath);
  } catch (e) {
    return [];
  }

  const archiveSets = [];
  const handledFiles = new Set();

  // 1. Multipart RAR with .part<num>.rar (e.g. Game.part1.rar, Game.part01.rar)
  const partRarMap = new Map();
  for (const name of fileNames) {
    const match = name.match(/^(.+?)\.part(\d+)\.rar$/i);
    if (match) {
      const baseKey = match[1].toLowerCase();
      if (!partRarMap.has(baseKey)) partRarMap.set(baseKey, []);
      partRarMap.get(baseKey).push({ file: name, num: parseInt(match[2], 10) });
      handledFiles.add(name);
    }
  }
  for (const [baseKey, items] of partRarMap.entries()) {
    items.sort((a, b) => a.num - b.num);
    const entryPoint = items[0].file;
    const sourceFiles = items.map(i => path.join(dirPath, i.file));
    archiveSets.push({
      type: 'multipart_rar_part',
      entryPoint: path.join(dirPath, entryPoint),
      sourceFiles,
      dir: dirPath
    });
  }

  // 2. Split numeric volumes (e.g. Game.7z.001 or Game.001)
  const numSplitMap = new Map();
  for (const name of fileNames) {
    if (handledFiles.has(name)) continue;
    const match = name.match(/^(.+?)\.(\d{3})$/i);
    if (match) {
      const baseKey = match[1].toLowerCase();
      if (!numSplitMap.has(baseKey)) numSplitMap.set(baseKey, []);
      numSplitMap.get(baseKey).push({ file: name, num: parseInt(match[2], 10) });
      handledFiles.add(name);
    }
  }
  for (const [baseKey, items] of numSplitMap.entries()) {
    items.sort((a, b) => a.num - b.num);
    const entryPoint = items[0].file;
    const sourceFiles = items.map(i => path.join(dirPath, i.file));
    archiveSets.push({
      type: 'split_numeric',
      entryPoint: path.join(dirPath, entryPoint),
      sourceFiles,
      dir: dirPath
    });
  }

  // 3. Old style RAR with .rar and .r00, .r01...
  const oldRarMap = new Map();
  for (const name of fileNames) {
    if (handledFiles.has(name)) continue;
    const match = name.match(/^(.+?)\.r(\d{2})$/i);
    if (match) {
      const baseKey = match[1].toLowerCase();
      if (!oldRarMap.has(baseKey)) oldRarMap.set(baseKey, []);
      oldRarMap.get(baseKey).push(name);
      handledFiles.add(name);
    }
  }
  for (const [baseKey, rFiles] of oldRarMap.entries()) {
    const mainRar = fileNames.find(n => n.toLowerCase() === baseKey + '.rar');
    const sourceFiles = rFiles.map(f => path.join(dirPath, f));
    let entryPoint = rFiles[0];
    if (mainRar) {
      handledFiles.add(mainRar);
      sourceFiles.unshift(path.join(dirPath, mainRar));
      entryPoint = mainRar;
    }
    archiveSets.push({
      type: 'old_multipart_rar',
      entryPoint: path.join(dirPath, entryPoint),
      sourceFiles,
      dir: dirPath
    });
  }

  // 4. Split ZIP with .zip and .z01, .z02...
  const splitZipMap = new Map();
  for (const name of fileNames) {
    if (handledFiles.has(name)) continue;
    const match = name.match(/^(.+?)\.z(\d{2})$/i);
    if (match) {
      const baseKey = match[1].toLowerCase();
      if (!splitZipMap.has(baseKey)) splitZipMap.set(baseKey, []);
      splitZipMap.get(baseKey).push(name);
      handledFiles.add(name);
    }
  }
  for (const [baseKey, zFiles] of splitZipMap.entries()) {
    const mainZip = fileNames.find(n => n.toLowerCase() === baseKey + '.zip');
    const sourceFiles = zFiles.map(f => path.join(dirPath, f));
    let entryPoint = zFiles[0];
    if (mainZip) {
      handledFiles.add(mainZip);
      sourceFiles.unshift(path.join(dirPath, mainZip));
      entryPoint = mainZip;
    }
    archiveSets.push({
      type: 'split_zip',
      entryPoint: path.join(dirPath, entryPoint),
      sourceFiles,
      dir: dirPath
    });
  }

  // 5. Standalone archives: .zip, .rar, .7z
  for (const name of fileNames) {
    if (handledFiles.has(name)) continue;
    const lower = name.toLowerCase();
    if (lower.endsWith('.zip') || lower.endsWith('.rar') || lower.endsWith('.7z')) {
      handledFiles.add(name);
      archiveSets.push({
        type: 'single',
        entryPoint: path.join(dirPath, name),
        sourceFiles: [path.join(dirPath, name)],
        dir: dirPath
      });
    }
  }

  // 6. Standalone archives without extensions or with unfamiliar extensions (detected via magic bytes)
  for (const name of fileNames) {
    if (handledFiles.has(name)) continue;
    const fullP = path.join(dirPath, name);
    try {
      const stat = fs.statSync(fullP);
      if (stat.isFile() && stat.size > 20) {
        const detected = detectArchiveFileType(fullP);
        if (detected) {
          handledFiles.add(name);
          archiveSets.push({
            type: 'single',
            entryPoint: fullP,
            sourceFiles: [fullP],
            dir: dirPath
          });
        }
      }
    } catch (_) {}
  }

  return archiveSets;
}

async function autoExtractAndCleanGameFolder(gameFolder, gameTitle = '') {
  if (!gameFolder || !fs.existsSync(gameFolder)) {
    return false;
  }

  console.log(`[Auto-Extract] Checking for archives in "${gameTitle || path.basename(gameFolder)}": ${gameFolder}`);

  let sets = findArchiveSetsInDir(gameFolder);

  // Check 1 level of subdirectories if no archives found at top level
  if (sets.length === 0) {
    try {
      const subEntries = fs.readdirSync(gameFolder, { withFileTypes: true });
      for (const sub of subEntries) {
        if (sub.isDirectory()) {
          const subDir = path.join(gameFolder, sub.name);
          const subSets = findArchiveSetsInDir(subDir);
          if (subSets.length > 0) {
            sets = sets.concat(subSets);
          }
        }
      }
    } catch (_) {}
  }

  if (sets.length === 0) {
    console.log(`[Auto-Extract] No archives (.zip, .rar, .7z) found in "${gameFolder}". Skipping extraction.`);
    return false;
  }

  console.log(`[Auto-Extract] Found ${sets.length} archive set(s) for "${gameTitle}". Starting extraction...`);
  _broadcastEvent('torrent_extracting', {
    title: gameTitle || path.basename(gameFolder),
    folder: gameFolder,
    totalSets: sets.length
  });

  let anyExtracted = false;

  for (let i = 0; i < sets.length; i++) {
    const s = sets[i];
    console.log(`[Auto-Extract] Extracting set ${i + 1}/${sets.length}: ${path.basename(s.entryPoint)} (${s.sourceFiles.length} file(s)) -> ${s.dir}`);

    try {
      await unpack7z(s.entryPoint, s.dir);
      console.log(`[Auto-Extract] Extraction completed successfully for: ${path.basename(s.entryPoint)}`);
      anyExtracted = true;

      // Completely extracted! Delete the source zip/rar file(s)
      for (const srcFile of s.sourceFiles) {
        try {
          if (fs.existsSync(srcFile)) {
            fs.unlinkSync(srcFile);
            console.log(`[Auto-Extract] Deleted source archive: ${path.basename(srcFile)}`);
          }
        } catch (delErr) {
          console.warn(`[Auto-Extract] Notice: Could not delete ${srcFile}: ${delErr.message}`);
        }
      }
    } catch (extractErr) {
      console.error(`[Auto-Extract] Extraction failed for ${s.entryPoint}: ${extractErr.message}`);
      console.warn(`[Auto-Extract] Preserving source files due to extraction failure.`);
    }
  }

  // Second pass: handle nested archives (e.g. zip containing rar or secondary zips)
  if (anyExtracted) {
    const secondPassSets = findArchiveSetsInDir(gameFolder);
    if (secondPassSets.length > 0) {
      console.log(`[Auto-Extract] Nested archives found (${secondPassSets.length} sets). Extracting second pass...`);
      for (const s of secondPassSets) {
        try {
          await unpack7z(s.entryPoint, s.dir);
          for (const srcFile of s.sourceFiles) {
            try {
              if (fs.existsSync(srcFile)) {
                fs.unlinkSync(srcFile);
                console.log(`[Auto-Extract] Deleted nested source archive: ${path.basename(srcFile)}`);
              }
            } catch (_) {}
          }
        } catch (nestErr) {
          console.warn(`[Auto-Extract] Nested archive extraction notice: ${nestErr.message}`);
        }
      }
    }
  }

  console.log(`[Auto-Extract] Extraction workflow finished for "${gameTitle}".`);
  return anyExtracted;
}

// ── Download Queue Factory ────────────────────────────────────────────────

export function createDownloadQueue({ getDownloadsFolder, broadcastEvent: broadcast, torrentQueuePath }) {
  // Bind the module-level broadcast hook used by autoExtractAndCleanGameFolder.
  _broadcastEvent = broadcast || (() => {});
  let broadcastEvent = _broadcastEvent;
  let torrentQueue = [];
  let activeTorrentItem = null;
  let activeTorrentHandle = null;
  let activeDirectDownloadRequest = null;

  // A direct download only assigns activeDirectDownloadRequest once the host
  // sends response headers. A fast 404/429 therefore leaves that null for the
  // whole request, which used to look like a dead item and restart the download
  // in a tight loop until the host rate-limited us.
  let activeDirectPending = null;
  // Ids the user explicitly removed while a request was in flight.
  const cancelledDirectIds = new Set();
  // Re-entrancy guard: processTorrentQueue() fans out from a dozen call sites.
  let queueTickActive = false;

  // Direct-download retry policy. Permanent failures are never retried; transient
  // ones back off exponentially so a rate-limited host is not hammered.
  const DIRECT_MAX_ATTEMPTS = 4;
  const DIRECT_RETRY_BASE_MS = 30000;
  const DIRECT_RETRY_MAX_MS = 10 * 60 * 1000;
  // Statuses that will never succeed no matter how long we wait.
  const DIRECT_PERMANENT_STATUS = new Set([400, 401, 403, 404, 405, 410, 451]);

  function classifyDirectFailure(err) {
    const status = err && typeof err.statusCode === 'number' ? err.statusCode : null;
    if (status && DIRECT_PERMANENT_STATUS.has(status)) {
      return { permanent: true, reason: `HTTP ${status}` };
    }
    if (status === 429) {
      // Honour Retry-After when the host sends one, otherwise back off hard.
      const retryAfter = err.retryAfter;
      let wait = DIRECT_RETRY_BASE_MS;
      if (retryAfter) {
        const seconds = Number(retryAfter);
        if (Number.isFinite(seconds) && seconds > 0) wait = Math.max(wait, seconds * 1000);
      }
      return { permanent: false, wait, reason: 'HTTP 429 rate limited' };
    }
    if (status && status >= 500) {
      return { permanent: false, wait: DIRECT_RETRY_BASE_MS, reason: `HTTP ${status} server error` };
    }
    // Connection resets, timeouts and TLS problems are usually transient.
    return { permanent: false, wait: DIRECT_RETRY_BASE_MS, reason: (err && err.message) || 'Network error' };
  }

  function loadTorrentQueue() {
    if (fs.existsSync(torrentQueuePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(torrentQueuePath, 'utf-8'));
        if (Array.isArray(data)) {
          torrentQueue = data.map(item => ({
            ...item,
            title: (item.title || '')
              .replace(/&#8211;/g, '–')
              .replace(/&#8212;/g, '—')
              .replace(/&#8217;/g, "'")
              .replace(/&#8216;/g, "'")
              .replace(/&#038;/g, '&')
              .replace(/&amp;/gi, '&'),
            url: (item.url || '').replace(/&#038;/g, '&').replace(/&amp;/gi, '&'),
            status: (item.status === 'downloading' || item.status === 'error') ? 'queued' : item.status,
            errorMessage: null,
            downloadSpeed: 0,
            uploadSpeed: 0,
            numPeers: 0,
            // The backoff deadline is meaningless across a restart, but the
            // attempt count must survive so an exhausted link stays exhausted
            // instead of hammering the host once per launch.
            nextAttemptAt: null
          }));

          // Anything that already used up its direct-download attempts is parked
          // as a terminal error rather than silently requeued.
          for (const item of torrentQueue) {
            if (item.isDirect && Number(item.attempts) >= DIRECT_MAX_ATTEMPTS && item.status === 'queued') {
              item.status = 'error';
              item.errorMessage = item.errorMessage || 'Download link failed repeatedly. Remove it and re-add a fresh link.';
            }
          }
        }
      } catch (e) {
        console.warn('[Torrent Queue] Error loading queue:', e.message);
      }
    }
  }

  function saveTorrentQueue() {
    try {
      const cleanQueue = torrentQueue.map(({ handle, ...rest }) => rest);
      fs.writeFileSync(torrentQueuePath, JSON.stringify(cleanQueue, null, 2), 'utf-8');
    } catch (e) {
      console.error('[Torrent Queue] Error saving queue:', e.message);
    }
  }

  function addTorrentToQueue({ url, title, magnet, filename, selectedFiles, files, isDirect, hoster }) {
    let targetUrl = (url || magnet || '').trim().replace(/&#038;/g, '&').replace(/&amp;/gi, '&');
    if (!targetUrl) throw new Error('Download URL or magnet link is required');

    const existing = torrentQueue.find(t => t.url === targetUrl);
    if (existing) {
      if (Array.isArray(selectedFiles) && selectedFiles.length > 0) {
        existing.selectedFiles = selectedFiles;
      }
      if (Array.isArray(files) && files.length > 0) {
        existing.files = files;
      }
      if (existing.status === 'error') {
        existing.status = 'queued';
        existing.errorMessage = null;
      }
      saveTorrentQueue();
      setTimeout(() => processTorrentQueue(), 100);
      return existing;
    }

    const isMagnet = targetUrl.toLowerCase().startsWith('magnet:');
    const isTorrentFile = !isMagnet && (targetUrl.toLowerCase().includes('.torrent') || (filename && filename.toLowerCase().endsWith('.torrent')));
    const isDirectDl = isDirect !== undefined ? Boolean(isDirect) : (!isMagnet && !isTorrentFile);

    const rawTitle = (title || filename || extractMagnetName(targetUrl) || (isMagnet ? 'BitTorrent Magnet' : null) || 'PC Game Download').trim();
    const cleanTitle = rawTitle
      .replace(/&#8211;/g, '–')
      .replace(/&#8212;/g, '—')
      .replace(/&#8217;/g, "'")
      .replace(/&#8216;/g, "'")
      .replace(/&#038;/g, '&')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'");

    const classification = isDirectDl ? classifyDownloadUrl(targetUrl, filename || cleanTitle) : null;
    const detectedHoster = hoster || (classification && classification.hoster) || (isDirectDl ? 'Direct File' : (isMagnet ? 'BitTorrent Magnet' : 'Torrent File'));

    const item = {
      id: (isDirectDl ? 'dl_' : 'tor_') + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
      title: cleanTitle,
      url: targetUrl,
      filename: filename || cleanTitle,
      isMagnet,
      isDirect: isDirectDl,
      hoster: detectedHoster,
      status: 'queued',
      progress: 0,
      downloadSpeed: 0,
      uploadSpeed: 0,
      numPeers: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      files: Array.isArray(files) ? files : [],
      selectedFiles: Array.isArray(selectedFiles) && selectedFiles.length > 0 ? selectedFiles : null,
      addedAt: new Date().toISOString(),
      errorMessage: null
    };

    torrentQueue.push(item);
    saveTorrentQueue();
    broadcastEvent('torrent_queue_update', { queue: torrentQueue, active: activeTorrentItem });

    // Trigger queue runner (ensuring 1 download at a time)
    setTimeout(() => processTorrentQueue(), 100);
    return item;
  }

  function deleteTorrentFromQueue(id) {
    const index = torrentQueue.findIndex(t => t.id === id);
    if (index === -1) return false;

    const item = torrentQueue[index];
    if (activeTorrentItem && activeTorrentItem.id === id) {
      if (activeTorrentHandle) {
        try {
          activeTorrentHandle.destroy({ destroyStore: false });
        } catch (_) {}
      }
      if (activeDirectDownloadRequest) {
        try {
          activeDirectDownloadRequest.destroy();
        } catch (_) {}
        activeDirectDownloadRequest = null;
      }
      // A user cancel must not be treated as a network failure, or the pending
      // promise's rejection would schedule a retry for a deleted item.
      cancelledDirectIds.add(id);
      activeDirectPending = null;
      activeTorrentHandle = null;
      activeTorrentItem = null;
    }

    torrentQueue.splice(index, 1);
    saveTorrentQueue();
    broadcastEvent('torrent_queue_update', { queue: torrentQueue, active: activeTorrentItem });

    // Process next item in queue
    setTimeout(() => processTorrentQueue(), 200);
    return true;
  }

  function startDirectFileDownloadStream({ url, itemTitle, preferredFilename, gameFolder, itemId, onStart, onProgress, maxRedirects = 6 }) {
    return new Promise((resolve, reject) => {
      if (maxRedirects <= 0) return reject(new Error('Too many HTTP redirects'));

      try {
        const parsedUrl = new URL(url);
        const client = parsedUrl.protocol === 'https:' ? https : http;

        const reqHeaders = {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 FreeplayDL/1.0',
          'Accept': '*/*'
        };
        if (parsedUrl.hostname && parsedUrl.hostname.includes('fuckingfast.co')) {
          reqHeaders['Referer'] = 'https://fuckingfast.co/';
        }

        const req = client.get(parsedUrl, {
          headers: reqHeaders,
          timeout: 25000
        }, (res) => {
          // Handle HTTP 3xx Redirects
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            const nextUrl = new URL(res.headers.location, parsedUrl).href;
            return resolve(startDirectFileDownloadStream({
              url: nextUrl,
              itemTitle,
              preferredFilename,
              gameFolder,
              itemId,
              onStart,
              onProgress,
              maxRedirects: maxRedirects - 1
            }));
          }

          if (res.statusCode < 200 || res.statusCode >= 300) {
            // Drain and discard the error body so the socket is released instead
            // of lingering; a 404 page can be large.
            res.resume();
            const httpError = new Error(`Server returned HTTP ${res.statusCode}: ${res.statusMessage || ''}`);
            httpError.statusCode = res.statusCode;
            httpError.retryAfter = res.headers['retry-after'] || null;
            return reject(httpError);
          }

          const contentType = (res.headers['content-type'] || '').toLowerCase();
          const contentLength = parseInt(res.headers['content-length'], 10) || 0;
          if (contentType.includes('text/html') && (contentLength === 0 || contentLength < 500000)) {
            res.resume();
            const htmlError = new Error('Received HTML webpage instead of downloadable file (link may have expired or requires a fresh link)');
            htmlError.statusCode = 404;
            return reject(htmlError);
          }

          // Determine real filename from Content-Disposition or URL path
          let finalFilename = preferredFilename;
          const cd = res.headers['content-disposition'];
          if (cd) {
            const match = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)["']?/i);
            if (match && match[1]) {
              try { finalFilename = decodeURIComponent(match[1]); } catch (_) { finalFilename = match[1]; }
            }
          }
          if (!finalFilename || finalFilename.length < 3 || finalFilename === 'download') {
            const cleanPath = parsedUrl.pathname.split('#')[0].split('?')[0];
            const lastPart = cleanPath.substring(cleanPath.lastIndexOf('/') + 1);
            if (lastPart && lastPart.length >= 3) {
              try { finalFilename = decodeURIComponent(lastPart); } catch (_) { finalFilename = lastPart; }
            } else {
              finalFilename = (itemTitle || 'pc_game').replace(/[^a-zA-Z0-9_-]/g, '_') + '.zip';
            }
          }

          finalFilename = sanitizeFilename(finalFilename);

          // Ensure gameFolder is guaranteed to exist before creating write stream
          if (!fs.existsSync(gameFolder)) {
            try {
              fs.mkdirSync(gameFolder, { recursive: true });
            } catch (mkdirErr) {
              console.error(`[Direct Download Queue] Failed to create destination folder "${gameFolder}":`, mkdirErr.message);
            }
          }

          const destPath = path.join(gameFolder, finalFilename);

          const totalBytes = parseInt(res.headers['content-length'], 10) || 0;
          let downloadedBytes = 0;
          let lastReport = Date.now();
          let lastBytes = 0;

          const fileStream = fs.createWriteStream(destPath);
          res.pipe(fileStream);

          if (typeof onStart === 'function') {
            onStart(req, finalFilename, totalBytes);
          }

          res.on('data', (chunk) => {
            downloadedBytes += chunk.length;
            const now = Date.now();
            if (now - lastReport >= 350) {
              const deltaBytes = downloadedBytes - lastBytes;
              const speed = deltaBytes / ((now - lastReport) / 1000);
              const percent = totalBytes > 0 ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)) : 0;
              if (typeof onProgress === 'function') {
                onProgress({
                  id: itemId,
                  downloadedBytes,
                  totalBytes,
                  percent,
                  speed
                });
              }
              lastReport = now;
              lastBytes = downloadedBytes;
            }
          });

          fileStream.on('finish', () => {
            fileStream.close();
            resolve(destPath);
          });

          fileStream.on('error', (err) => {
            try { fs.unlinkSync(destPath); } catch (_) {}
            reject(err);
          });
        });

        req.on('error', (err) => {
          reject(err);
        });

        req.on('timeout', () => {
          req.destroy();
          reject(new Error('Direct download connection timed out'));
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  async function processDirectDownload(item, downloadsFolder) {
    const attempt = Number(item.attempts) || 0;
    console.log(
      `[Direct Download Queue] Starting download for "${item.title}"` +
      (attempt > 0 ? ` (attempt ${attempt + 1}/${DIRECT_MAX_ATTEMPTS})` : '') +
      `: ${item.url}`
    );

    // Claim the slot synchronously, before any await, so a concurrent
    // processTorrentQueue() call cannot mistake this for an abandoned item.
    activeDirectPending = { itemId: item.id, startedAt: Date.now() };
    item.nextAttemptAt = null;

    // Preserve original URL in item if user needs to open it later
    if (!item.originalUrl) {
      item.originalUrl = item.url;
    }

    // 1. If this is a DataNodes web landing page rather than a resolved direct storage node link
    const isDataNodesLanding = (item.url || '').toLowerCase().includes('datanodes.to') &&
      !(item.url.includes(':8443') || item.url.includes('/d/'));

    if (isDataNodesLanding) {
      console.warn(`[Direct Download Queue] "${item.title}" is a DataNodes landing page. Direct node link required.`);
      item.status = 'error';
      item.errorMessage = 'DataNodes landing page. Click ↗ Open in Browser to get the direct file link, then click 🔗 Paste Link.';
      item.nextAttemptAt = null;
      activeDirectPending = null;
      activeTorrentItem = null;
      saveTorrentQueue();
      broadcastEvent('torrent_queue_update', { queue: torrentQueue, active: null });
      broadcastEvent('torrent_failed', { id: item.id, title: item.title, message: item.errorMessage });
      setTimeout(() => { processTorrentQueue(); }, 500);
      return;
    }

    // 2. If this is a FuckingFast landing page, automatically resolve to direct download link
    if (isFuckingFastLandingPage(item.url)) {
      console.log(`[Direct Download Queue] Resolving FuckingFast landing page for "${item.title}": ${item.url}`);
      item.status = 'downloading';
      item.errorMessage = 'Resolving FuckingFast direct download link...';
      saveTorrentQueue();
      broadcastEvent('torrent_queue_update', { queue: torrentQueue, active: activeTorrentItem });

      try {
        const resolvedDirectUrl = await resolveFuckingFastUrl(item.url);
        if (cancelledDirectIds.has(item.id)) {
          cancelledDirectIds.delete(item.id);
          console.log(`[Direct Download Queue] Download cancelled during resolution for "${item.title}"`);
          activeDirectPending = null;
          activeTorrentItem = null;
          setTimeout(() => { processTorrentQueue(); }, 200);
          return;
        }
        if (resolvedDirectUrl && resolvedDirectUrl !== item.url) {
          console.log(`[Direct Download Queue] Resolved FuckingFast direct URL: ${resolvedDirectUrl}`);
          item.url = resolvedDirectUrl;
          item.errorMessage = null;
          saveTorrentQueue();
          broadcastEvent('torrent_queue_update', { queue: torrentQueue, active: activeTorrentItem });
        }
      } catch (resolveErr) {
        console.warn(`[Direct Download Queue] FuckingFast auto-resolution failed for "${item.title}": ${resolveErr.message}`);
        item.status = 'error';
        item.errorMessage = 'FuckingFast link resolution failed. Click ↗ Open in Browser (click download twice to skip ad) then click 🔗 Paste Link.';
        item.nextAttemptAt = null;
        activeDirectPending = null;
        activeTorrentItem = null;
        saveTorrentQueue();
        broadcastEvent('torrent_queue_update', { queue: torrentQueue, active: null });
        broadcastEvent('torrent_failed', { id: item.id, title: item.title, message: item.errorMessage });
        setTimeout(() => { processTorrentQueue(); }, 500);
        return;
      }
    }

    const cleanGameTitle = sanitizeFolderName(cleanPcGameTitle(item.title) || item.title);
    const gameFolder = path.join(downloadsFolder, cleanGameTitle);
    if (!fs.existsSync(gameFolder)) {
      try {
        fs.mkdirSync(gameFolder, { recursive: true });
      } catch (mkdirErr) {
        console.error(`[Direct Download Queue] Failed to create gameFolder "${gameFolder}":`, mkdirErr.message);
      }
    }

    startDirectFileDownloadStream({
      url: item.url,
      itemTitle: item.title,
      preferredFilename: item.filename,
      gameFolder,
      itemId: item.id,
      onStart: (req, derivedFilename, totalBytes) => {
        activeDirectDownloadRequest = req;
        item.filename = derivedFilename;
        item.totalBytes = totalBytes || item.totalBytes || 0;
        saveTorrentQueue();
        broadcastEvent('torrent_queue_update', { queue: torrentQueue, active: activeTorrentItem });
      },
      onProgress: (progData) => {
        item.progress = progData.percent !== null ? progData.percent : item.progress;
        item.downloadedBytes = progData.downloadedBytes || 0;
        item.totalBytes = progData.totalBytes || item.totalBytes || 0;
        item.downloadSpeed = progData.speed || 0;
        broadcastEvent('torrent_progress', {
          id: item.id,
          title: item.title,
          progress: item.progress,
          downloadSpeed: item.downloadSpeed,
          numPeers: 0,
          downloadedBytes: item.downloadedBytes,
          totalBytes: item.totalBytes,
          isDirect: true,
          hoster: item.hoster
        });
      }
    })
    .then(async (savedPath) => {
      activeDirectDownloadRequest = null;
      activeDirectPending = null;
      console.log(`[Direct Download Queue] Download complete: ${savedPath}`);
      item.status = 'completed';
      item.progress = 100;
      saveTorrentQueue();

      const finishedId = item.id;
      const finishedTitle = cleanGameTitle;
      let statSize = item.totalBytes;
      try {
        if (fs.existsSync(savedPath)) statSize = fs.statSync(savedPath).size;
      } catch (_) {}

      activeTorrentItem = null;

      // Remove finished download from the queue
      const idx = torrentQueue.findIndex(t => t.id === finishedId);
      if (idx !== -1) {
        torrentQueue.splice(idx, 1);
      }
      saveTorrentQueue();

      // Check if there are other parts still queued or downloading for this same game in the queue
      const remainingPartsForGame = torrentQueue.filter(t =>
        t.id !== finishedId &&
        (sanitizeFolderName(cleanPcGameTitle(t.title)) === finishedTitle || cleanPcGameTitle(t.title) === finishedTitle || t.title === item.title) &&
        t.status !== 'completed' && t.status !== 'error'
      );

      if (remainingPartsForGame.length > 0) {
        console.log(
          `[Direct Download Queue] Downloaded part for "${finishedTitle}". ` +
          `${remainingPartsForGame.length} more part(s) remaining in queue.`
        );
        broadcastEvent('torrent_queue_update', { queue: torrentQueue, active: null });
        setTimeout(() => {
          processTorrentQueue();
        }, 500);
        return;
      }

      // ALL files for this game in the queue have finished downloading!
      console.log(`[Direct Download Queue] All files for "${finishedTitle}" have finished downloading!`);

      // Auto-extract archives (.zip, .rar, multipart rar) into the same folder and delete source archives
      try {
        await autoExtractAndCleanGameFolder(gameFolder, finishedTitle);
      } catch (extractErr) {
        console.error(`[PC Games] Error during auto-extract for "${finishedTitle}":`, extractErr.message);
      }

      broadcastEvent('torrent_completed', {
        id: finishedId,
        title: finishedTitle,
        folder: downloadsFolder,
        message: `Finished downloading and extracting "${finishedTitle}" into your Downloads folder!`
      });
      broadcastEvent('torrent_queue_update', { queue: torrentQueue, active: null });

      // Automatically process next queued download (1 at a time!)
      setTimeout(() => {
        processTorrentQueue();
      }, 500);
    })
    .catch((err) => {
      activeDirectDownloadRequest = null;
      activeDirectPending = null;

      // The user deleted this item mid-flight; destroying the socket surfaces as
      // an error here, but it is not a failure and must not be retried.
      if (cancelledDirectIds.has(item.id)) {
        cancelledDirectIds.delete(item.id);
        console.log(`[Direct Download Queue] Download cancelled for "${item.title}"`);
        setTimeout(() => { processTorrentQueue(); }, 200);
        return;
      }

      const attempts = (Number(item.attempts) || 0) + 1;
      item.attempts = attempts;
      const { permanent, wait, reason } = classifyDirectFailure(err);
      const giveUp = permanent || attempts >= DIRECT_MAX_ATTEMPTS;

      if (giveUp) {
        console.error(
          `[Direct Download Queue] Download failed for "${item.title}": ${err.message}` +
          (permanent ? ' (permanent - not retrying)' : ` (giving up after ${attempts} attempts)`)
        );
        item.status = 'error';
        item.errorMessage = permanent
          ? `${err.message} - link is dead, remove it and re-add a fresh link`
          : `${err.message} - failed after ${attempts} attempts`;
        item.nextAttemptAt = null;
        activeTorrentItem = null;
        saveTorrentQueue();
        broadcastEvent('torrent_queue_update', { queue: torrentQueue, active: null });
        broadcastEvent('torrent_failed', { id: item.id, title: item.title, message: item.errorMessage });
      } else {
        const backoff = Math.min(wait * Math.pow(2, attempts - 1), DIRECT_RETRY_MAX_MS);
        const retryAt = Date.now() + backoff;
        console.warn(
          `[Direct Download Queue] Attempt ${attempts}/${DIRECT_MAX_ATTEMPTS} failed for "${item.title}": ${reason}. ` +
          `Retrying in ${Math.round(backoff / 1000)}s.`
        );
        item.status = 'queued';
        item.errorMessage = `${reason} - retrying in ${Math.round(backoff / 1000)}s`;
        item.nextAttemptAt = retryAt;
        activeTorrentItem = null;
        saveTorrentQueue();
        broadcastEvent('torrent_queue_update', { queue: torrentQueue, active: null });
        setTimeout(() => { processTorrentQueue(); }, backoff);
      }
    });
  }

  async function processTorrentQueue() {
    // processTorrentQueue() is fanned out from a dozen call sites (queue edits,
    // SSE-driven UI refreshes, completion handlers). Without this guard two
    // invocations interleave and each starts its own request for the same item.
    if (queueTickActive) return;
    queueTickActive = true;
    try {
      await runTorrentQueue();
    } finally {
      queueTickActive = false;
    }
  }

  async function runTorrentQueue() {
    // If activeTorrentItem is set but there's no handle or active direct request
    // running, clear it! activeDirectPending means a request is still in flight
    // and has not produced headers yet, so it is NOT a zombie.
    if (activeTorrentItem && !activeDirectDownloadRequest && !activeDirectPending &&
        (!activeTorrentHandle || activeTorrentHandle.destroyed)) {
      console.warn('[Torrent Queue] Recovering from zombie activeTorrentItem:', activeTorrentItem.title);
      activeTorrentItem = null;
      activeTorrentHandle = null;
      activeDirectDownloadRequest = null;
    }

    // Only allow 1 download at a time!
    if (activeTorrentItem) return;

    // Recover any orphan 'downloading' status if there is no active download running
    const orphan = torrentQueue.find(t => t.status === 'downloading');
    if (orphan) {
      orphan.status = 'queued';
      saveTorrentQueue();
    }

    const now = Date.now();
    // Skip items still serving a backoff penalty from an earlier failure, and give
    // up on items that already burned through their attempt budget.
    const next = torrentQueue.find(t =>
      t.status === 'queued' &&
      !(Number(t.attempts) > 0 && t.isDirect && Number(t.attempts) >= DIRECT_MAX_ATTEMPTS) &&
      (!t.nextAttemptAt || Number(t.nextAttemptAt) <= now)
    );
    if (!next) return;

    activeTorrentItem = next;
    next.status = 'downloading';
    next.startedAt = new Date().toISOString();
    saveTorrentQueue();
    broadcastEvent('torrent_queue_update', { queue: torrentQueue, active: activeTorrentItem });

    const downloadsFolder = getDownloadsFolder();

    // ── Handle Direct HTTP/HTTPS Download ──
    if (next.isDirect) {
      processDirectDownload(next, downloadsFolder);
      return;
    }

    // ── Handle BitTorrent Magnet / .torrent Download ──
    try {
      const client = await getWebTorrentClient();
      if (!client) {
        throw new Error('WebTorrent engine is not available.');
      }

      // Resolve magnet to hex infoHash + announce list, bypassing WebTorrent remote parser bug
      const resolved = await resolveTorrentId(next.url);
      const targetHash = (resolved.kind === 'magnet')
        ? resolved.parsed.infoHashHex
        : (resolved.kind === 'hash' ? resolved.hash : null);

      let torrent = null;
      if (targetHash && Array.isArray(client.torrents)) {
        const existing = client.torrents.find(t => t.infoHash === targetHash);
        if (existing) {
          if (existing.destroyed) {
            try { client.remove(existing); } catch (_) {}
          } else {
            torrent = existing;
          }
        }
      }

      if (!torrent || typeof torrent.on !== 'function') {
        if (resolved.kind === 'magnet') {
          torrent = client.add(resolved.parsed.infoHashHex, {
            path: downloadsFolder,
            announce: resolved.parsed.announce,
            name: resolved.parsed.name || next.title
          });
        } else if (resolved.kind === 'hash') {
          torrent = client.add(resolved.hash, { path: downloadsFolder });
        } else {
          torrent = client.add(resolved.buffer, { path: downloadsFolder });
        }
      }

      if (!torrent || typeof torrent.on !== 'function') {
        throw new Error('WebTorrent engine failed to initialize active torrent instance');
      }

      activeTorrentHandle = torrent;
      if (torrent.name && (!next.title || next.title === 'PC Game Torrent')) {
        next.title = torrent.name;
      }
      next.totalBytes = torrent.length || next.totalBytes || 0;
      saveTorrentQueue();

      let isTorrentDone = false;
      const handleTorrentDone = async () => {
        if (isTorrentDone) return;
        isTorrentDone = true;
        clearInterval(progressTicker);
        console.log(`[Torrent Engine] Torrent download finished: "${torrent.name || next.title}"`);

        const finishedId = next.id;
        const finishedTitle = torrent.name || next.title;
        const allFiles = (torrent.files || []).map(f => ({
          name: f.name,
          path: f.path,
          length: f.length
        }));
        let torrentFiles = allFiles;
        if (Array.isArray(next.selectedFiles) && next.selectedFiles.length > 0) {
          const selSet = new Set(next.selectedFiles.map(p => p.toLowerCase().replace(/\\/g, '/')));
          torrentFiles = allFiles.filter(f =>
            selSet.has(f.path.toLowerCase().replace(/\\/g, '/')) || selSet.has(f.name.toLowerCase())
          );
        }
        const totalLength = torrentFiles.reduce((s, f) => s + f.length, 0) || next.totalBytes || 0;

        // Stop WebTorrent download/seed session without deleting files on disk
        try {
          torrent.destroy({ destroyStore: false });
        } catch (_) {}

        activeTorrentHandle = null;
        activeTorrentItem = null;

        // Remove the finished torrent from the queue
        const idx = torrentQueue.findIndex(t => t.id === finishedId);
        if (idx !== -1) {
          torrentQueue.splice(idx, 1);
        }
        saveTorrentQueue();

        // Automatically extract archives (.zip, .rar, multipart rar) in the torrent's folder if any are present
        const torrentFolder = path.join(downloadsFolder, sanitizeFolderName(torrent.name || cleanPcGameTitle(next.title) || next.title));
        const targetExtractFolder = fs.existsSync(torrentFolder) ? torrentFolder : downloadsFolder;
        try {
          await autoExtractAndCleanGameFolder(targetExtractFolder, finishedTitle);
        } catch (extractErr) {
          console.error(`[PC Games] Error during auto-extract for torrent "${finishedTitle}":`, extractErr.message);
        }

        broadcastEvent('torrent_completed', {
          id: finishedId,
          title: finishedTitle,
          folder: downloadsFolder,
          message: `Finished downloading and extracting "${finishedTitle}" into your Downloads folder!`
        });
        broadcastEvent('torrent_queue_update', { queue: torrentQueue, active: null });

        // Continue to next queued torrent
        setTimeout(() => {
          processTorrentQueue();
        }, 500);
      };

      // Heartbeat ticker to send live peer counts & speed updates even while fetching metadata
      const progressTicker = setInterval(() => {
        if (!activeTorrentHandle || activeTorrentHandle !== torrent) {
          clearInterval(progressTicker);
          return;
        }

        let downloaded = 0;
        let total = 0;

        if (Array.isArray(next.selectedFiles) && next.selectedFiles.length > 0 && Array.isArray(torrent.files) && torrent.files.length > 0) {
          const selSet = new Set(next.selectedFiles.map(p => p.toLowerCase().replace(/\\/g, '/')));
          const selectedList = torrent.files.filter(f =>
            selSet.has(f.path.toLowerCase().replace(/\\/g, '/')) || selSet.has(f.name.toLowerCase())
          );
          downloaded = selectedList.reduce((sum, f) => sum + (f.downloaded || 0), 0);
          total = selectedList.reduce((sum, f) => sum + (f.length || 0), 0) || next.totalBytes || 0;

          // If all selected files are done, trigger completion
          if (selectedList.length > 0 && selectedList.every(f => f.done || (f.length > 0 && f.downloaded >= f.length))) {
            handleTorrentDone();
            return;
          }
        } else {
          downloaded = torrent.downloaded || 0;
          total = torrent.length || next.totalBytes || 0;
        }

        const numPeers = torrent.numPeers || (torrent.wires ? torrent.wires.length : 0);
        const prog = total > 0 ? Math.min(100, Math.round((downloaded / total) * 1000) / 10) : 0;
        const speed = torrent.downloadSpeed || 0;
        const upSpeed = torrent.uploadSpeed || 0;

        next.numPeers = numPeers;
        next.progress = prog;
        next.downloadSpeed = speed;
        next.uploadSpeed = upSpeed;
        next.downloadedBytes = downloaded;
        if (total > 0) next.totalBytes = total;

        broadcastEvent('torrent_progress', {
          id: next.id,
          title: next.title,
          progress: next.progress,
          downloadSpeed: next.downloadSpeed,
          numPeers: next.numPeers,
          downloadedBytes: next.downloadedBytes,
          totalBytes: next.totalBytes
        });
      }, 1000);

      torrent.on('metadata', () => {
        console.log(`[Torrent Engine] Metadata received for: "${torrent.name || next.title}"`);
        if (torrent.name) next.title = torrent.name;

        // Cache file list on queue item
        next.files = (torrent.files || []).map((f, i) => ({
          index: i,
          name: f.name,
          path: f.path,
          length: f.length
        }));

        // Apply selective download if user selected specific files
        if (Array.isArray(next.selectedFiles) && next.selectedFiles.length > 0) {
          const selSet = new Set(next.selectedFiles.map(p => p.toLowerCase().replace(/\\/g, '/')));
          torrent.files.forEach(f => {
            const normP = f.path.toLowerCase().replace(/\\/g, '/');
            const normN = f.name.toLowerCase();
            if (selSet.has(normP) || selSet.has(normN)) {
              f.select();
            } else {
              f.deselect();
            }
          });
          const selectedTotal = torrent.files
            .filter(f => selSet.has(f.path.toLowerCase().replace(/\\/g, '/')) || selSet.has(f.name.toLowerCase()))
            .reduce((sum, f) => sum + f.length, 0);
          if (selectedTotal > 0) next.totalBytes = selectedTotal;
          console.log(`[Torrent Engine] Selective download active: ${next.selectedFiles.length} of ${torrent.files.length} files selected`);
        } else {
          next.totalBytes = torrent.length || next.totalBytes;
        }
        saveTorrentQueue();
        broadcastEvent('torrent_queue_update', { queue: torrentQueue, active: activeTorrentItem });
      });

      torrent.on('download', () => {
        if (Array.isArray(next.selectedFiles) && next.selectedFiles.length > 0 && Array.isArray(torrent.files)) {
          const selSet = new Set(next.selectedFiles.map(p => p.toLowerCase().replace(/\\/g, '/')));
          const selectedList = torrent.files.filter(f =>
            selSet.has(f.path.toLowerCase().replace(/\\/g, '/')) || selSet.has(f.name.toLowerCase())
          );
          const downloaded = selectedList.reduce((sum, f) => sum + (f.downloaded || 0), 0);
          const total = selectedList.reduce((sum, f) => sum + (f.length || 0), 0) || next.totalBytes || 1;
          next.progress = Math.min(100, Math.round((downloaded / total) * 1000) / 10);
          next.downloadedBytes = downloaded;
          next.totalBytes = total;
        } else {
          next.progress = Math.round((torrent.progress || 0) * 1000) / 10;
          next.downloadedBytes = torrent.downloaded || 0;
          next.totalBytes = torrent.length || next.totalBytes;
        }
        next.downloadSpeed = torrent.downloadSpeed || 0;
        next.uploadSpeed = torrent.uploadSpeed || 0;
        next.numPeers = torrent.numPeers || (torrent.wires ? torrent.wires.length : 0);
      });

      torrent.on('done', handleTorrentDone);

      torrent.on('error', (err) => {
        clearInterval(progressTicker);
        console.error(`[Torrent Engine] Error downloading "${next.title}":`, err.message);
        try { torrent.destroy({ destroyStore: false }); } catch (_) {}
        activeTorrentHandle = null;
        activeTorrentItem = null;
        next.status = 'error';
        next.errorMessage = err.message;
        saveTorrentQueue();
        broadcastEvent('torrent_queue_update', { queue: torrentQueue, active: null });

        setTimeout(() => {
          processTorrentQueue();
        }, 1000);
      });

    } catch (err) {
      console.error('[Torrent Engine] Error starting torrent:', err.message);
      next.status = 'error';
      next.errorMessage = err.message;
      activeTorrentHandle = null;
      activeTorrentItem = null;
      saveTorrentQueue();
      broadcastEvent('torrent_queue_update', { queue: torrentQueue, active: null });

      setTimeout(() => {
        processTorrentQueue();
      }, 1500);
    }
  }

  loadTorrentQueue();
  setTimeout(() => processTorrentQueue(), 2500);

  const queueApi = {
    getQueue: () => torrentQueue,
    getActive: () => activeTorrentItem,
    addTorrentToQueue,
    deleteTorrentFromQueue,
    processTorrentQueue,
    isUrlQueued: (url) => torrentQueue.some(t => t.url === url),
    inspectTorrent: (rawUrl, timeoutMs) => inspectTorrentFiles(rawUrl, getDownloadsFolder(), timeoutMs, { isQueued: queueApi.isUrlQueued }),

    registerRoutes(app) {
      // 3. Add Torrent or Direct Download to Queue: POST /api/pc-rss/torrent/add & /api/pc-rss/download/add
      const handleAddDownloadToQueue = (req, res) => {
        try {
          const { url, title, magnet, filename, selectedFiles, files, isDirect, hoster } = req.body || {};
          const item = addTorrentToQueue({ url: url || magnet, title, filename, selectedFiles, files, isDirect, hoster });
          res.json({
            success: true,
            message: `Added "${item.title}" to download queue`,
            item,
            queue: torrentQueue
          });
        } catch (err) {
          res.status(400).json({ success: false, error: err.message });
        }
      };
      app.post('/api/pc-rss/torrent/add', handleAddDownloadToQueue);
      app.post('/api/pc-rss/download/add', handleAddDownloadToQueue);

      // 3b. Batch Add Downloads to Queue: POST /api/pc-rss/torrent/add-batch
      app.post('/api/pc-rss/torrent/add-batch', (req, res) => {
        try {
          const { items: batchItems } = req.body || {};
          if (!Array.isArray(batchItems) || batchItems.length === 0) {
            return res.status(400).json({ success: false, error: 'No items provided in batch' });
          }
          const added = [];
          for (const entry of batchItems) {
            const { url, title, magnet, filename, selectedFiles, files, isDirect, hoster } = entry || {};
            if (url || magnet) {
              const item = addTorrentToQueue({ url: url || magnet, title, filename, selectedFiles, files, isDirect, hoster });
              added.push(item);
            }
          }
          saveTorrentQueue();
          broadcastEvent('torrent_queue_update', { queue: torrentQueue, active: activeTorrentItem });
          setTimeout(() => processTorrentQueue(), 100);

          res.json({
            success: true,
            count: added.length,
            message: `Added ${added.length} download(s) to queue`,
            items: added,
            queue: torrentQueue
          });
        } catch (err) {
          res.status(400).json({ success: false, error: err.message });
        }
      });

      // 3b. Inspect Torrent Files: POST /api/pc-rss/torrent/inspect
      app.post('/api/pc-rss/torrent/inspect', async (req, res) => {
        try {
          const { id, url, magnet } = req.body || {};

          // 1. If torrent ID provided, check queue cache or active handle first
          if (id) {
            const item = torrentQueue.find(t => t.id === id);
            if (item && Array.isArray(item.files) && item.files.length > 0) {
              return res.json({
                success: true,
                id: item.id,
                name: item.title,
                files: item.files,
                selectedFiles: item.selectedFiles || null,
                totalBytes: item.totalBytes
              });
            }
            if (activeTorrentItem && activeTorrentItem.id === id && activeTorrentHandle && Array.isArray(activeTorrentHandle.files) && activeTorrentHandle.files.length > 0) {
              const files = activeTorrentHandle.files.map((f, i) => ({
                index: i,
                name: f.name,
                path: f.path,
                length: f.length
              }));
              if (item) item.files = files;
              return res.json({
                success: true,
                id: item ? item.id : id,
                name: activeTorrentHandle.name || (item && item.title),
                files,
                selectedFiles: item ? item.selectedFiles : null,
                totalBytes: activeTorrentHandle.length
              });
            }
            if (item && item.url) {
              const inspected = await queueApi.inspectTorrent(item.url);
              item.files = inspected.files;
              saveTorrentQueue();
              return res.json({
                success: true,
                id: item.id,
                name: inspected.name || item.title,
                files: inspected.files,
                selectedFiles: item.selectedFiles || null,
                totalBytes: inspected.totalBytes
              });
            }
          }

          const targetUrl = url || magnet;
          if (!targetUrl) {
            return res.status(400).json({ success: false, error: 'url or id is required' });
          }

          const inspected = await queueApi.inspectTorrent(targetUrl);
          res.json({
            success: true,
            name: inspected.name,
            files: inspected.files,
            selectedFiles: null,
            totalBytes: inspected.totalBytes
          });
        } catch (err) {
          console.warn('[PC Torrent Inspect] Error:', err.message);
          res.status(500).json({ success: false, error: err.message });
        }
      });

      // 3c. Select / Deselect Files in Torrent: POST /api/pc-rss/torrent/select-files
      app.post('/api/pc-rss/torrent/select-files', (req, res) => {
        try {
          const { id, selectedFiles } = req.body || {};
          if (!id) return res.status(400).json({ success: false, error: 'Torrent ID required' });
          if (!Array.isArray(selectedFiles)) {
            return res.status(400).json({ success: false, error: 'selectedFiles must be an array' });
          }

          const item = torrentQueue.find(t => t.id === id);
          if (!item) return res.status(404).json({ success: false, error: 'Torrent not found in queue' });

          item.selectedFiles = selectedFiles.length > 0 ? selectedFiles : null;

          // If currently active in WebTorrent, apply live selection/deselection immediately
          if (activeTorrentItem && activeTorrentItem.id === id && activeTorrentHandle && Array.isArray(activeTorrentHandle.files)) {
            const selSet = new Set(selectedFiles.map(p => p.toLowerCase().replace(/\\/g, '/')));
            activeTorrentHandle.files.forEach(file => {
              const p = file.path.toLowerCase().replace(/\\/g, '/');
              const n = file.name.toLowerCase();
              if (selSet.size === 0 || selSet.has(p) || selSet.has(n)) {
                file.select();
              } else {
                file.deselect();
              }
            });

            if (selSet.size > 0) {
              const selectedTotal = activeTorrentHandle.files
                .filter(f => selSet.has(f.path.toLowerCase().replace(/\\/g, '/')) || selSet.has(f.name.toLowerCase()))
                .reduce((sum, f) => sum + f.length, 0);
              if (selectedTotal > 0) item.totalBytes = selectedTotal;
            } else {
              item.totalBytes = activeTorrentHandle.length;
            }
          } else if (item.files && item.files.length > 0) {
            if (selectedFiles.length > 0) {
              const selSet = new Set(selectedFiles.map(p => p.toLowerCase().replace(/\\/g, '/')));
              const selectedTotal = item.files
                .filter(f => selSet.has(f.path.toLowerCase().replace(/\\/g, '/')) || selSet.has(f.name.toLowerCase()))
                .reduce((sum, f) => sum + f.length, 0);
              if (selectedTotal > 0) item.totalBytes = selectedTotal;
            }
          }

          saveTorrentQueue();
          broadcastEvent('torrent_queue_update', { queue: torrentQueue, active: activeTorrentItem });

          res.json({
            success: true,
            message: `Updated file selection for "${item.title}"`,
            item,
            queue: torrentQueue
          });
        } catch (err) {
          res.status(500).json({ success: false, error: err.message });
        }
      });

      // 4. Delete / Remove Torrent from Queue: POST /api/pc-rss/torrent/delete & DELETE /api/pc-rss/torrent/:id
      app.post('/api/pc-rss/torrent/delete', (req, res) => {
        const { id } = req.body || {};
        if (!id) return res.status(400).json({ success: false, error: 'ID is required' });

        const deleted = deleteTorrentFromQueue(id);
        res.json({ success: deleted, queue: torrentQueue });
      });

      app.delete('/api/pc-rss/torrent/:id', (req, res) => {
        const id = req.params.id;
        const deleted = deleteTorrentFromQueue(id);
        res.json({ success: deleted, queue: torrentQueue });
      });

      // 4b. Update Download URL in Queue: POST /api/pc-rss/torrent/update-url
      app.post('/api/pc-rss/torrent/update-url', (req, res) => {
        const { id, url } = req.body || {};
        if (!id || !url) return res.status(400).json({ success: false, error: 'id and url are required' });
        const item = torrentQueue.find(t => t.id === id);
        if (!item) return res.status(404).json({ success: false, error: 'Queue item not found' });
        item.url = url.trim();
        item.status = 'queued';
        item.errorMessage = null;
        item.attempts = 0;
        item.nextAttemptAt = null;
        saveTorrentQueue();
        broadcastEvent('torrent_queue_update', { queue: torrentQueue, active: activeTorrentItem });
        setTimeout(() => processTorrentQueue(), 100);
        res.json({ success: true, item, queue: torrentQueue });
      });

      // 5. Get Torrent Queue Status: GET /api/pc-rss/torrent/queue
      app.get('/api/pc-rss/torrent/queue', (req, res) => {
        // If active lock is set but handle is dead or missing, clear it.
        // A direct download has no handle and sets activeDirectDownloadRequest only
        // once headers arrive, so both of those must be ignored here or this poll
        // would restart the download on every request.
        if (activeTorrentItem &&
            !activeDirectDownloadRequest && !activeDirectPending &&
            (!activeTorrentHandle || activeTorrentHandle.destroyed)) {
          activeTorrentItem = null;
          activeTorrentHandle = null;
        }
        // If queue has items and runner is idle, start processing
        if (!activeTorrentItem && torrentQueue.some(t => t.status === 'queued' || t.status === 'downloading')) {
          setTimeout(() => processTorrentQueue(), 50);
        }
        res.json({
          success: true,
          queue: torrentQueue,
          activeTorrent: activeTorrentItem,
          isDownloading: !!activeTorrentItem,
          downloadsFolder: getDownloadsFolder()
        });
      });
    }
  };

  return queueApi;
}

export { autoExtractAndCleanGameFolder };
