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

const CacheManager = {
  getComicCachePath(googleFileId) {
    const comicsDir = getCacheDir('comics');
    const safeId = String(googleFileId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(comicsDir, `${safeId}.cbz`);
  },

  hasComic(googleFileId) {
    if (!googleFileId) return false;
    const p = this.getComicCachePath(googleFileId);
    return fs.existsSync(p) && fs.statSync(p).size > 0;
  },

  saveComicStream(googleFileId, stream) {
    const filePath = this.getComicCachePath(googleFileId);
    const tempPath = `${filePath}.tmp`;
    const out = fs.createWriteStream(tempPath);
    return new Promise((resolve, reject) => {
      stream.pipe(out);
      out.on('finish', () => {
        fs.renameSync(tempPath, filePath);
        resolve(filePath);
      });
      out.on('error', (err) => {
        try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (e) {}
        reject(err);
      });
    });
  },

  saveComicBuffer(googleFileId, bufferOrPath) {
    const filePath = this.getComicCachePath(googleFileId);
    if (typeof bufferOrPath === 'string') {
      fs.copyFileSync(bufferOrPath, filePath);
    } else {
      fs.writeFileSync(filePath, bufferOrPath);
    }
    return filePath;
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
