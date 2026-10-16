const fs = require('fs');
const path = require('path');

/**
 * Cache Manager:
 * Manages local disk caching for downloaded Google Drive comics and extracted cover thumbnails.
 * Ensures fast page reading and minimizes external bandwidth usage.
 */

let cacheBaseDir = path.join(__dirname, '..', 'cache');

function getCacheDir(sub = '') {
  const custom = process.env.CACHE_DIR;
  if (custom) {
    cacheBaseDir = path.isAbsolute(custom)
      ? custom
      : path.join(__dirname, '..', custom);
  }
  const target = sub ? path.join(cacheBaseDir, sub) : cacheBaseDir;
  if (!fs.existsSync(target)) {
    try {
      fs.mkdirSync(target, { recursive: true });
    } catch (err) {
      console.warn('[Cache] Could not create cache directory:', err.message);
    }
  }
  return target;
}

function purgeOldComicCache() {
  try {
    const comicsDir = getCacheDir('comics');
    if (fs.existsSync(comicsDir)) {
      const files = fs.readdirSync(comicsDir);
      for (const f of files) {
        try {
          fs.unlinkSync(path.join(comicsDir, f));
        } catch (e) {}
      }
    }
  } catch (err) {
    console.warn('[Cache] Error during comic cache purge:', err.message);
  }
}

// Purge server comic archive cache immediately on startup to reclaim disk space
purgeOldComicCache();

const CacheManager = {
  purgeOldComicCache,

  getComicCachePath(googleFileId) {
    const comicsDir = getCacheDir('comics');
    const safeId = String(googleFileId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(comicsDir, `${safeId}.cbz`);
  },

  hasComic(googleFileId) {
    // Server should not cache comics to disk
    return false;
  },

  saveComicStream(googleFileId, stream) {
    // No-op: Do not download or cache comic files to server disk
    return Promise.resolve(null);
  },

  saveComicBuffer(googleFileId, bufferOrPath) {
    // No-op: Do not download or cache comic files to server disk
    return null;
  },

  getCoverCachePath(googleFileId) {
    const coversDir = getCacheDir('covers');
    const safeId = String(googleFileId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(coversDir, `${safeId}.jpg`);
  },

  hasCover(googleFileId) {
    if (!googleFileId) return false;
    const p = this.getCoverCachePath(googleFileId);
    return fs.existsSync(p) && fs.statSync(p).size > 0;
  },

  saveCoverBuffer(googleFileId, buffer) {
    const filePath = this.getCoverCachePath(googleFileId);
    fs.writeFileSync(filePath, buffer);
    return filePath;
  },

  cleanOldCache(maxSizeBytes = 1024 * 1024 * 1024) { // Default 1GB
    try {
      const comicsDir = getCacheDir('comics');
      const files = fs.readdirSync(comicsDir).map((f) => {
        const full = path.join(comicsDir, f);
        const stat = fs.statSync(full);
        return { path: full, size: stat.size, mtime: stat.mtimeMs };
      });

      let totalSize = files.reduce((acc, f) => acc + f.size, 0);
      if (totalSize > maxSizeBytes) {
        // Sort oldest first
        files.sort((a, b) => a.mtime - b.mtime);
        for (const file of files) {
          if (totalSize <= maxSizeBytes) break;
          try {
            fs.unlinkSync(file.path);
            totalSize -= file.size;
          } catch (e) {}
        }
      }
    } catch (err) {
      console.warn('[Cache] Cleanup note:', err.message);
    }
  },

  deleteComicCache(googleFileId) {
    if (!googleFileId) return;
    try {
      const p = this.getComicCachePath(googleFileId);
      if (fs.existsSync(p)) fs.unlinkSync(p);
      const cp = this.getCoverCachePath(googleFileId);
      if (fs.existsSync(cp)) fs.unlinkSync(cp);
    } catch (e) {}
  }
};

module.exports = CacheManager;
