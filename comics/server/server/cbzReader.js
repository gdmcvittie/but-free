const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// In-memory cache for parsed archive entry lists
const archiveEntryCache = new Map();
// In-memory LRU cache for extracted page buffers
const pageBufferCache = new Map();
const MAX_PAGE_CACHE_ITEMS = 50;

class CBZReader {
  /**
   * Reads the End of Central Directory record from a ZIP buffer or file descriptor.
   */
  static findEOCD(fd, fileSize) {
    const maxRead = Math.min(fileSize, 65536 + 22);
    const buf = Buffer.alloc(maxRead);
    fs.readSync(fd, buf, 0, maxRead, fileSize - maxRead);

    for (let i = maxRead - 22; i >= 0; i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) {
        return {
          entryCount: buf.readUInt16LE(i + 10),
          centralDirSize: buf.readUInt32LE(i + 12),
          centralDirOffset: buf.readUInt32LE(i + 16)
        };
      }
    }
    return null;
  }

  /**
   * Parses the Central Directory of a ZIP file to extract all image file entries.
   */
  static getArchiveEntries(filePath) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const stat = fs.statSync(filePath);
    const cached = archiveEntryCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached.entries;
    }

    const fd = fs.openSync(filePath, 'r');
    try {
      const eocd = this.findEOCD(fd, stat.size);
      if (!eocd) {
        throw new Error('Not a valid ZIP/CBZ archive (EOCD signature not found)');
      }

      const cdBuf = Buffer.alloc(eocd.centralDirSize);
      fs.readSync(fd, cdBuf, 0, eocd.centralDirSize, eocd.centralDirOffset);

      const entries = [];
      let offset = 0;

      while (offset < eocd.centralDirSize) {
        if (cdBuf.readUInt32LE(offset) !== 0x02014b50) break;

        const compressionMethod = cdBuf.readUInt16LE(offset + 10);
        const compressedSize = cdBuf.readUInt32LE(offset + 20);
        const uncompressedSize = cdBuf.readUInt32LE(offset + 24);
        const fileNameLength = cdBuf.readUInt16LE(offset + 28);
        const extraFieldLength = cdBuf.readUInt16LE(offset + 30);
        const fileCommentLength = cdBuf.readUInt16LE(offset + 32);
        const localHeaderOffset = cdBuf.readUInt32LE(offset + 42);

        const fileName = cdBuf.toString('utf8', offset + 46, offset + 46 + fileNameLength);
        offset += 46 + fileNameLength + extraFieldLength + fileCommentLength;

        // Ignore MacOS metadata and non-image files
        if (fileName.includes('__MACOSX') || fileName.endsWith('/')) continue;
        const ext = path.extname(fileName).toLowerCase();
        if (!['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'].includes(ext)) continue;

        entries.push({
          fileName,
          compressionMethod,
          compressedSize,
          uncompressedSize,
          localHeaderOffset
        });
      }

      // Sort entries naturally (page 1, 2, 10 instead of 1, 10, 2)
      entries.sort((a, b) =>
        a.fileName.localeCompare(b.fileName, undefined, { numeric: true, sensitivity: 'base' })
      );

      archiveEntryCache.set(filePath, { entries, mtimeMs: stat.mtimeMs });
      return entries;
    } finally {
      fs.closeSync(fd);
    }
  }

  static getPageList(filePath) {
    const entries = this.getArchiveEntries(filePath);
    return {
      totalPages: entries.length,
      pages: entries.map((e, idx) => ({
        index: idx + 1,
        fileName: path.basename(e.fileName)
      }))
    };
  }

  /**
   * Extracts raw image buffer of a specific page (1-indexed).
   */
  static extractPage(filePath, pageIndex) {
    const cacheKey = `${filePath}:${pageIndex}`;
    const cached = pageBufferCache.get(cacheKey);
    if (cached) return cached;

    const entries = this.getArchiveEntries(filePath);
    if (pageIndex < 1 || pageIndex > entries.length) {
      throw new Error(`Page index ${pageIndex} out of bounds (1 - ${entries.length})`);
    }

    const entry = entries[pageIndex - 1];
    const fd = fs.openSync(filePath, 'r');
    try {
      // Read local file header to find data offset
      const localHeader = Buffer.alloc(30);
      fs.readSync(fd, localHeader, 0, 30, entry.localHeaderOffset);
      if (localHeader.readUInt32LE(0) !== 0x04034b50) {
        throw new Error(`Invalid local header for entry: ${entry.fileName}`);
      }

      const fnLen = localHeader.readUInt16LE(26);
      const extraLen = localHeader.readUInt16LE(28);
      const dataOffset = entry.localHeaderOffset + 30 + fnLen + extraLen;

      const compressedBuf = Buffer.alloc(entry.compressedSize);
      fs.readSync(fd, compressedBuf, 0, entry.compressedSize, dataOffset);

      let decompressed;
      if (entry.compressionMethod === 0) {
        // Stored (no compression)
        decompressed = compressedBuf;
      } else if (entry.compressionMethod === 8) {
        // Deflate
        decompressed = zlib.inflateRawSync(compressedBuf);
      } else {
        throw new Error(`Unsupported compression method: ${entry.compressionMethod}`);
      }

      const ext = path.extname(entry.fileName).toLowerCase();
      let mimeType = 'image/jpeg';
      if (ext === '.png') mimeType = 'image/png';
      else if (ext === '.webp') mimeType = 'image/webp';
      else if (ext === '.gif') mimeType = 'image/gif';

      const result = {
        data: decompressed,
        mimeType,
        fileName: path.basename(entry.fileName),
        pageIndex,
        totalPages: entries.length
      };

      // LRU cache insertion
      if (pageBufferCache.size >= MAX_PAGE_CACHE_ITEMS) {
        const firstKey = pageBufferCache.keys().next().value;
        if (firstKey) pageBufferCache.delete(firstKey);
      }
      pageBufferCache.set(cacheKey, result);

      return result;
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * Fast extraction of the first image directly from a ZIP file buffer (e.g. from an HTTP Range request)
   * Avoids downloading the entire archive to extract a cover.
   */
  static async extractFirstImageFromBuffer(buf, fetchMoreRange) {
    let offset = 0;
    const len = buf.length;

    while (offset + 30 <= len) {
      // Check for ZIP local file header signature 0x04034b50
      if (buf.readUInt32LE(offset) !== 0x04034b50) {
        break;
      }

      const flags = buf.readUInt16LE(offset + 6);
      const compressionMethod = buf.readUInt16LE(offset + 8);
      const compressedSize = buf.readUInt32LE(offset + 18);
      const fileNameLength = buf.readUInt16LE(offset + 26);
      const extraFieldLength = buf.readUInt16LE(offset + 28);

      if (offset + 30 + fileNameLength > len) break;
      const fileName = buf.toString('utf8', offset + 30, offset + 30 + fileNameLength);
      const dataOffset = offset + 30 + fileNameLength + extraFieldLength;

      const isMac = fileName.includes('__MACOSX') || fileName.startsWith('.');
      const isImage = /\.(jpe?g|png|webp|gif|bmp)$/i.test(fileName);

      if (!isMac && isImage) {
        let compressedBuf = null;
        if (dataOffset + compressedSize <= len && compressedSize > 0) {
          compressedBuf = buf.subarray(dataOffset, dataOffset + compressedSize);
        } else if (fetchMoreRange && compressedSize > 0) {
          try {
            compressedBuf = await fetchMoreRange(dataOffset, dataOffset + compressedSize - 1);
          } catch (e) {
            console.warn('[CBZReader] Targeted range fetch failed:', e.message);
          }
        }

        if (compressedBuf && compressedBuf.length > 0) {
          let decompressed;
          if (compressionMethod === 0) {
            decompressed = compressedBuf;
          } else if (compressionMethod === 8) {
            decompressed = zlib.inflateRawSync(compressedBuf);
          } else {
            break;
          }

          const ext = path.extname(fileName).toLowerCase();
          let mimeType = 'image/jpeg';
          if (ext === '.png') mimeType = 'image/png';
          else if (ext === '.webp') mimeType = 'image/webp';
          else if (ext === '.gif') mimeType = 'image/gif';

          return { data: decompressed, mimeType, fileName };
        }
      }

      // If data descriptor is used without size in local header, we cannot skip linearly
      if (compressedSize === 0 && (flags & 0x08)) {
        break;
      }

      offset = dataOffset + compressedSize;
    }

    return null;
  }
}

module.exports = CBZReader;

