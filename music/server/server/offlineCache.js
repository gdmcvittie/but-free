import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { OFFLINE_DIR } from './config.js';
import db from './db.js';
import googleDrive from './googleDrive.js';
import { broadcast } from './events.js';

/**
 * Offline audio cache.
 *
 * Keeps a copy of Drive audio on local disk so playback works without a network
 * round-trip (and without spending Drive bandwidth on every listen).
 * `itemId -> jobId` guards against double-starting the same copy.
 */

const inFlight = new Map(); // itemId -> Promise

function cachePathFor(itemId, fileName) {
  const ext = (fileName.match(/\.([a-z0-9]+)$/i)?.[1] || 'm4b').toLowerCase();
  return path.join(OFFLINE_DIR, `${itemId}.${ext}`);
}

let cacheMap = null;
let cacheMapTimestamp = 0;
const CACHE_TTL_MS = 5000;

export function invalidateOfflineCache() {
  cacheMap = null;
  cacheMapTimestamp = 0;
}

function ensureCacheMap() {
  const now = Date.now();
  if (cacheMap && (now - cacheMapTimestamp < CACHE_TTL_MS)) {
    return cacheMap;
  }
  const nextMap = new Map();
  if (fs.existsSync(OFFLINE_DIR)) {
    try {
      const names = fs.readdirSync(OFFLINE_DIR);
      for (const name of names) {
        if (name.endsWith('.part')) continue;
        const dotIndex = name.indexOf('.');
        if (dotIndex > 0) {
          const id = name.slice(0, dotIndex);
          const full = path.join(OFFLINE_DIR, name);
          try {
            const stat = fs.statSync(full);
            if (stat.isFile() && stat.size > 0) {
              nextMap.set(id, { full, size: stat.size });
            }
          } catch {
            /* ignore stat errors */
          }
        }
      }
    } catch {
      /* ignore readdir errors */
    }
  }
  cacheMap = nextMap;
  cacheMapTimestamp = now;
  return cacheMap;
}

export function getOfflineItemIds() {
  const map = ensureCacheMap();
  return new Set(map.keys());
}

export function localFileFor(itemId) {
  if (!itemId) return null;
  const map = ensureCacheMap();
  const entry = map.get(String(itemId));
  return entry ? entry.full : null;
}

export function isOffline(itemId) {
  if (!itemId) return false;
  const map = ensureCacheMap();
  return map.has(String(itemId));
}

/** Total bytes used by the offline cache. */
export function cacheUsage() {
  const map = ensureCacheMap();
  let bytes = 0;
  for (const entry of map.values()) {
    bytes += entry.size;
  }
  return { bytes, files: map.size };
}

export const offlineCache = {
  getOfflineItemIds,
  invalidateOfflineCache,

  list(userId) {
    const map = ensureCacheMap();
    return db.getOffline(userId).map((record) => {
      const entry = map.get(String(record.itemId));
      return {
        ...record,
        exists: Boolean(entry),
        bytes: entry ? entry.size : (record.bytes || 0)
      };
    });
  },

  /**
   * Copies a Drive file to the local cache.
   * Resolves with `{ itemId, bytes, localPath }`; concurrent callers share one job.
   */
  async cache(user, item) {
    if (inFlight.has(item.id)) return inFlight.get(item.id);

    const task = (async () => {
      const existing = localFileFor(item.id);
      if (existing) {
        const bytes = fs.statSync(existing).size;
        db.setOffline(user.id, item.id, { fileName: path.basename(existing), bytes });
        return { itemId: item.id, bytes, localPath: existing, cached: true };
      }

      broadcast('offline_progress', { itemId: item.id, status: 'starting', percent: 0 });

      const meta = await googleDrive.getFileMetadata(user, item.googleFileId, 'id,name,mimeType,size');
      const total = Number(meta.size) || item.sizeBytes || 0;
      const target = cachePathFor(item.id, meta.name || item.title || 'audio.m4b');
      fs.mkdirSync(OFFLINE_DIR, { recursive: true });
      const temp = `${target}.part`;

      const accessToken = (await import('./googleAuth.js')).default;
      let token;
      try {
        token = await accessToken.getValidAccessToken(user);
      } catch {
        token = null;
      }

      const upstream = await fetch(
        `https://www.googleapis.com/drive/v3/files/${item.googleFileId}?alt=media`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} }
      );
      if (!upstream.ok && upstream.status !== 206) {
        throw new Error(`Drive download failed (HTTP ${upstream.status})`);
      }

      let received = 0;
      let lastPercent = -1;
      const source = Readable.fromWeb(upstream.body);
      source.on('data', (chunk) => {
        received += chunk.length;
        const percent = total ? Math.min(99, Math.round((received / total) * 100)) : 0;
        if (percent !== lastPercent) {
          lastPercent = percent;
          broadcast('offline_progress', { itemId: item.id, status: 'downloading', percent, received, total });
        }
      });

      await pipeline(source, fs.createWriteStream(temp));

      // A truncated cache file is worse than no cache file.
      if (total > 0 && received < total * 0.98) {
        fs.rmSync(temp, { force: true });
        throw new Error('Offline copy was incomplete - please try again.');
      }

      fs.renameSync(temp, target);
      invalidateOfflineCache();
      const bytes = fs.statSync(target).size;
      db.setOffline(user.id, item.id, { fileName: path.basename(target), bytes });
      broadcast('offline_progress', { itemId: item.id, status: 'done', percent: 100, bytes });
      return { itemId: item.id, bytes, localPath: target, cached: false };
    })();

    inFlight.set(item.id, task);
    try {
      return await task;
    } finally {
      inFlight.delete(item.id);
    }
  },

  /** Removes one item's local copy. */
  remove(userId, itemId) {
    const existing = localFileFor(itemId);
    if (existing) fs.rmSync(existing, { force: true });
    fs.rmSync(`${cachePathFor(itemId, 'x.m4b')}.part`, { force: true });
    invalidateOfflineCache();
    db.removeOffline(userId, itemId);
    broadcast('offline_progress', { itemId, status: 'removed', percent: 0 });
    return true;
  },

  /** Evicts the oldest cached items until the cache fits under `maxBytes`. */
  async evict(userId, maxBytes) {
    if (!maxBytes || maxBytes <= 0) return { freed: 0, removed: [] };

    const records = db.getOffline(userId).sort((a, b) => (a.addedAt > b.addedAt ? 1 : -1));
    const removed = [];
    let freed = 0;

    for (const record of records) {
      const usage = cacheUsage();
      if (usage.bytes <= maxBytes) break;
      const file = localFileFor(record.itemId);
      if (file) {
        try { freed += fs.statSync(file).size; } catch { /* ignore */ }
        fs.rmSync(file, { force: true });
      }
      db.removeOffline(userId, record.itemId);
      removed.push(record.itemId);
    }

    if (removed.length) {
      invalidateOfflineCache();
      broadcast('offline_changed', { userId, removed });
    }
    return { freed, removed };
  },

  /** Streams a cached file with Range support. */
  stream(itemId, req, res) {
    const file = localFileFor(itemId);
    if (!file) return false;

    const stat = fs.statSync(file);
    const mimeType = file.endsWith('.mp3') ? 'audio/mpeg'
      : file.endsWith('.ogg') ? 'audio/ogg'
      : file.endsWith('.flac') ? 'audio/flac'
      : file.endsWith('.m4a') ? 'audio/mp4'
      : 'audio/mp4';

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Accept-Ranges', 'bytes');

    const range = req.headers.range;
    const match = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;

    if (match) {
      const start = match[1] ? parseInt(match[1], 10) : 0;
      const end = match[2] ? parseInt(match[2], 10) : stat.size - 1;
      if (Number.isNaN(start) || start >= stat.size) {
        res.status(416).setHeader('Content-Range', `bytes */${stat.size}`);
        res.end();
        return true;
      }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      res.setHeader('Content-Length', String(end - start + 1));
      if (req.method === 'HEAD') { res.end(); return true; }
      fs.createReadStream(file, { start, end }).pipe(res);
      return true;
    }

    res.setHeader('Content-Length', String(stat.size));
    if (req.method === 'HEAD') { res.end(); return true; }
    fs.createReadStream(file).pipe(res);
    return true;
  },

  /** Discards cached files for items that no longer exist. */
  async reconcile(userId) {
    const owned = new Set(db.getUserItems(userId).map((i) => i.id));
    const removed = [];
    for (const record of db.getOffline(userId)) {
      if (!owned.has(record.itemId)) {
        const file = localFileFor(record.itemId);
        if (file) fs.rmSync(file, { force: true });
        db.removeOffline(userId, record.itemId);
        removed.push(record.itemId);
      }
    }
    if (removed.length) invalidateOfflineCache();
    return removed;
  }
};

export default offlineCache;
