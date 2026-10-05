if (!process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = '16';
}
const zlib = require('zlib');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, execFileSync, spawnSync } = require('child_process');
const { createZipBuffer, createStreamingCBZ } = require('./cbzWriter');

/**
 * ComicCompressor:
 * - Unpacks .cbz / .cbr / .zip archives
 * - Compresses all image pages to 75% JPEG quality with Sharp (or pure JS fallback)
 * - Repacks into a clean, compact .cbz archive before uploading to Google Drive
 */

// Optional engines are loaded LAZILY. Requiring a native module like `sharp` at
// startup can hard-crash the process (native abort, not a catchable JS error) on
// hosts whose CPU/libc can't run its prebuilt binary. Lazy loading guarantees the
// server always boots; a bad engine only affects the compression path.
let _sharp; let _sharpTried = false;
function getSharp() {
  if (_sharpTried) return _sharp;
  _sharpTried = true;
  try {
    _sharp = require('sharp');
    try { _sharp.cache(false); } catch (e) {}
    try { _sharp.simd(true); } catch (e) {}
    try { _sharp.concurrency(1); } catch (e) {}
    console.log('[ComicCompressor] Sharp engine loaded successfully.');
  } catch (e) {
    _sharp = null;
    console.warn('[ComicCompressor] Sharp could not be loaded:', e.message);
  }
  return _sharp;
}

let _jpegJs; let _jpegJsTried = false;
function getJpegJs() {
  if (_jpegJsTried) return _jpegJs;
  _jpegJsTried = true;
  try { _jpegJs = require('jpeg-js'); } catch (e) { _jpegJs = null; }
  return _jpegJs;
}

let _pngJs; let _pngJsTried = false;
function getPngJs() {
  if (_pngJsTried) return _pngJs;
  _pngJsTried = true;
  try { _pngJs = require('pngjs'); } catch (e) { _pngJs = null; }
  return _pngJs;
}

let _unrarJs; let _unrarJsTried = false;
function getUnrarJs() {
  if (_unrarJsTried) return _unrarJs;
  _unrarJsTried = true;
  try {
    _unrarJs = require('node-unrar-js');
    console.log('[ComicCompressor] node-unrar-js loaded successfully (in-process RAR/CBR extraction).');
  } catch (e) {
    _unrarJs = null;
    console.warn('[ComicCompressor] node-unrar-js could not be loaded:', e.message);
  }
  return _unrarJs;
}

// Checks whether a module is installed WITHOUT loading it (avoids native crashes).
function moduleResolvable(name) {
  try { require.resolve(name); return true; } catch (e) { return false; }
}

// Simple nearest-neighbour downscale for RGBA pixel data (pure-JS fallback).
function downscaleNearest(data, sw, sh, dw, dh) {
  const out = Buffer.allocUnsafe(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor(((y + 0.5) * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.floor(((x + 0.5) * sw) / dw));
      const si = (sy * sw + sx) * 4;
      const di = (y * dw + x) * 4;
      out[di] = data[si];
      out[di + 1] = data[si + 1];
      out[di + 2] = data[si + 2];
      out[di + 3] = 255;
    }
  }
  return out;
}

class ComicCompressor {
  /**
   * Locates 7-Zip or Windows/Linux tar executable on the system if available
   */
  static findExtractorTool() {
    // Resolve once and cache: spawning processes is synchronous and could stall
    // the single-threaded event loop if a candidate misbehaves.
    if (ComicCompressor._extractorToolResolved) {
      return ComicCompressor._extractorToolCache;
    }

    const candidates = [
      '7z',
      '7za',
      '7zr',
      'C:\\Program Files\\7-Zip\\7z.exe',
      'C:\\Program Files (x86)\\7-Zip\\7z.exe',
      path.join(process.env['ProgramFiles'] || 'C:\\Program Files', '7-Zip', '7z.exe'),
      path.join(process.env['LOCALAPPDATA'] || '', 'Programs', '7-Zip', '7z.exe'),
      'C:\\Windows\\System32\\tar.exe',
      'bsdtar',
      'tar',
      'unrar',
      'unzip',
      'busybox'
    ];

    let found = null;
    for (const p of candidates) {
      try {
        if (p.includes('\\')) {
          if (fs.existsSync(p)) { found = p; break; }
          continue;
        }
        // Bare command: probe PATH. SIGKILL + short timeout guarantee we never
        // wait indefinitely on a child that ignores termination.
        const check = spawnSync(p, ['--help'], {
          timeout: 1000,
          killSignal: 'SIGKILL',
          windowsHide: true,
          stdio: 'ignore'
        });
        if (!check.error) { found = p; break; }
      } catch (e) {}
    }

    ComicCompressor._extractorToolResolved = true;
    ComicCompressor._extractorToolCache = found;
    return found;
  }

  /**
   * Extracts RAR/CBR or complex archives using system tool (7z or tar)
   */
  static extractWithSystemTool(buffer, ext = '.cbr') {
    const tool = this.findExtractorTool();
    if (!tool) {
      throw new Error(
        'No system archive extractor (7-Zip, unrar, or tar) available on this host for RAR/CBR/7z archives. ' +
        'Compression is only supported for regular ZIP/CBZ archives here; the original file is being kept.'
      );
    }

    const tmpDir = path.join(os.tmpdir(), `cmx_ext_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
    const tmpArchive = path.join(os.tmpdir(), `cmx_archive_${Date.now()}${ext}`);
    fs.writeFileSync(tmpArchive, buffer);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
      console.log(`[ComicCompressor] Extracting with system tool: ${tool}`);
      if (tool.toLowerCase().includes('7z')) {
        execFileSync(tool, ['x', '-y', `-o${tmpDir}`, tmpArchive], { maxBuffer: 100 * 1024 * 1024, stdio: 'pipe' });
      } else {
        execFileSync(tool, ['-xf', tmpArchive, '-C', tmpDir], { maxBuffer: 100 * 1024 * 1024, stdio: 'pipe' });
      }

      const extractedFiles = [];
      const walk = (dir, relPrefix = '') => {
        const items = fs.readdirSync(dir, { withFileTypes: true });
        for (const item of items) {
          const full = path.join(dir, item.name);
          const rel = relPrefix ? `${relPrefix}/${item.name}` : item.name;
          if (item.isDirectory()) {
            walk(full, rel);
          } else if (item.isFile()) {
            const isHidden = rel.includes('__MACOSX') || path.basename(rel).startsWith('.');
            if (!isHidden) {
              extractedFiles.push({
                name: rel.replace(/\\/g, '/'),
                data: fs.readFileSync(full)
              });
            }
          }
        }
      };
      walk(tmpDir);
      extractedFiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
      return extractedFiles;
    } finally {
      try { if (fs.existsSync(tmpArchive)) fs.unlinkSync(tmpArchive); } catch (e) {}
      try { if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    }
  }

  /**
   * Lazily unpacks a ZIP/CBZ buffer, yielding one page at a time. The central
   * directory is parsed first (cheap metadata only); each page is decompressed
   * on demand so the whole uncompressed book never lives in memory at once.
   * Prefer this over unpackCBZ on memory-constrained shared hosting.
   */
  static async *iterUnpackCBZ(zipBuf) {
    if (!Buffer.isBuffer(zipBuf) || zipBuf.length < 22) {
      throw new Error('Invalid or corrupted CBZ archive buffer');
    }

    // Check if buffer is actually RAR/CBR or 7z
    const magic = zipBuf.toString('ascii', 0, 4);
    const isRar = magic === 'Rar!';
    const is7z = zipBuf.slice(0, 6).toString('hex') === '377abcaf271c';
    if (isRar || is7z) {
      // RAR/CBR: prefer in-process WASM extraction (works without system binaries)
      if (isRar && getUnrarJs()) {
        try {
          const entries = await this.extractWithRarJs(zipBuf);
          if (entries && entries.length > 0) {
            for (const e of entries) yield e;
            return;
          }
        } catch (rarErr) {
          console.warn('[ComicCompressor] In-memory RAR extraction failed:', rarErr.message);
        }
      }
      const entries = this.extractWithSystemTool(zipBuf, isRar ? '.cbr' : '.7z');
      for (const e of entries) yield e;
      return;
    }

    // 1. Locate End of Central Directory (EOCD)
    let eocdOffset = -1;
    const maxSearch = Math.min(zipBuf.length, 65536 + 22);
    const searchStart = zipBuf.length - maxSearch;

    for (let i = zipBuf.length - 22; i >= searchStart; i--) {
      if (zipBuf.readUInt32LE(i) === 0x06054b50) {
        eocdOffset = i;
        break;
      }
    }

    // Scan full buffer backwards if not in the last 64KB
    if (eocdOffset === -1) {
      for (let i = searchStart - 1; i >= 0; i--) {
        if (zipBuf.readUInt32LE(i) === 0x06054b50) {
          eocdOffset = i;
          break;
        }
      }
    }

    if (eocdOffset === -1) {
      try {
        const entries = this.extractWithSystemTool(zipBuf, '.cbz');
        for (const e of entries) yield e;
        return;
      } catch (sysErr) {
        throw new Error('Not a valid ZIP/CBZ archive (EOCD signature missing)');
      }
    }

    const cdSize = zipBuf.readUInt32LE(eocdOffset + 12);
    const cdOffset = zipBuf.readUInt32LE(eocdOffset + 16);

    // Detect if archive has preamble offset (e.g. self-extracting or prepended comment)
    let preambleOffset = 0;
    const firstLocalSig = zipBuf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    if (firstLocalSig > 0 && firstLocalSig < cdOffset) {
      preambleOffset = firstLocalSig;
    }

    // 2. Parse Central Directory headers into lightweight metadata (no decompression).
    const metas = [];
    let offset = cdOffset + preambleOffset;
    const cdEnd = cdOffset + cdSize + preambleOffset;
    let parsedCount = 0;

    while (offset < cdEnd && offset + 46 <= zipBuf.length) {
      // Yield to the event loop periodically so a large archive never blocks
      // the process long enough for Passenger to consider it unresponsive.
      if ((parsedCount++ % 8) === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      if (zipBuf.readUInt32LE(offset) !== 0x02014b50) break;

      const compressionMethod = zipBuf.readUInt16LE(offset + 10);
      const compressedSize = zipBuf.readUInt32LE(offset + 20);
      const fnLen = zipBuf.readUInt16LE(offset + 28);
      const extraLen = zipBuf.readUInt16LE(offset + 30);
      const commentLen = zipBuf.readUInt16LE(offset + 32);
      let localHeaderOffset = zipBuf.readUInt32LE(offset + 42) + preambleOffset;

      const fileName = zipBuf.toString('utf8', offset + 46, offset + 46 + fnLen);
      offset += 46 + fnLen + extraLen + commentLen;

      // Skip directory entries and OS metadata
      if (fileName.endsWith('/') || fileName.includes('__MACOSX') || path.basename(fileName).startsWith('.')) continue;

      // 3. Locate local file data
      if (localHeaderOffset + 30 > zipBuf.length) continue;
      if (zipBuf.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
        // Search near localHeaderOffset if slightly misaligned
        const nearIdx = zipBuf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), Math.max(0, localHeaderOffset - 128));
        if (nearIdx !== -1 && Math.abs(nearIdx - localHeaderOffset) < 512) {
          localHeaderOffset = nearIdx;
        } else {
          continue;
        }
      }

      const localFnLen = zipBuf.readUInt16LE(localHeaderOffset + 26);
      const localExtraLen = zipBuf.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localFnLen + localExtraLen;
      const dataEnd = dataStart + compressedSize;

      if (dataEnd > zipBuf.length) continue;

      metas.push({
        name: fileName.replace(/\\/g, '/'),
        compressionMethod,
        dataStart,
        dataEnd
      });
    }

    if (metas.length === 0) {
      try {
        const entries = this.extractWithSystemTool(zipBuf, '.cbz');
        for (const e of entries) yield e;
        return;
      } catch (e) {}
    }

    // Sort naturally by filename before yielding
    metas.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

    // 4. Decompress and yield one page at a time.
    let yieldedCount = 0;
    for (const meta of metas) {
      if ((yieldedCount++ % 4) === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      const rawChunk = zipBuf.subarray(meta.dataStart, meta.dataEnd);
      let decompressed = null;
      try {
        if (meta.compressionMethod === 0) {
          decompressed = Buffer.from(rawChunk);
        } else if (meta.compressionMethod === 8) {
          decompressed = zlib.inflateRawSync(rawChunk);
        } else {
          continue;
        }
      } catch (decompressErr) {
        console.warn(`[ComicCompressor] Failed to decompress ${meta.name}:`, decompressErr.message);
        continue;
      }
      yield { name: meta.name, data: decompressed };
    }
  }

  /**
   * Unpacks a ZIP/CBZ buffer into an array of { name: string, data: Buffer } entries.
   * NOTE: holds every page in memory; prefer iterUnpackCBZ for large archives.
   */
  static async unpackCBZ(zipBuf) {
    const entries = [];
    for await (const entry of this.iterUnpackCBZ(zipBuf)) {
      entries.push(entry);
    }
    return entries;
  }

  /**
   * Detects the archive container type from its magic bytes.
   */
  static detectArchiveType(filePath) {
    try {
      const fd = fs.openSync(filePath, 'r');
      const head = Buffer.alloc(8);
      fs.readSync(fd, head, 0, head.length, 0);
      fs.closeSync(fd);
      if (head.slice(0, 4).toString('ascii') === 'Rar!') return 'rar';
      if (head.slice(0, 6).toString('hex') === '377abcaf271c') return '7z';
      if (head.slice(0, 4).toString('hex') === '504b0304') return 'zip';
      return 'unknown';
    } catch (e) {
      return 'unknown';
    }
  }

  /**
   * Asynchronously extracts an archive to a temp directory using the system
   * extractor (7z/tar). Runs as a child process so it never blocks the event
   * loop, and writes pages to disk so memory stays flat.
   * Resolves with { dir, files: [{ name, path }] }.
   */
  static extractToDirWithSystemToolAsync(archivePath, ext = '.cbz') {
    const tool = this.findExtractorTool();
    if (!tool) return Promise.reject(new Error('no system extractor available'));

    const tmpDir = path.join(os.tmpdir(), `cmx_ext_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    const args = tool.toLowerCase().includes('7z')
      ? ['x', '-y', `-o${tmpDir}`, archivePath]
      : ['-xf', archivePath, '-C', tmpDir];

    return new Promise((resolve, reject) => {
      execFile(tool, args, { maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err) => {
        if (err) {
          try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
          return reject(err);
        }
        const files = [];
        const walk = (dir, relPrefix = '') => {
          const items = fs.readdirSync(dir, { withFileTypes: true });
          for (const item of items) {
            const full = path.join(dir, item.name);
            const rel = relPrefix ? `${relPrefix}/${item.name}` : item.name;
            if (item.isDirectory()) {
              walk(full, rel);
            } else if (item.isFile()) {
              const isHidden = rel.includes('__MACOSX') || path.basename(rel).startsWith('.');
              if (!isHidden) files.push({ name: rel.replace(/\\/g, '/'), path: full });
            }
          }
        };
        try {
          walk(tmpDir);
        } catch (walkErr) {
          try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
          return reject(walkErr);
        }
        resolve({ dir: tmpDir, files });
      });
    });
  }

  /**
   * Extracts a RAR/CBR directly to a temp directory using node-unrar-js's
   * file-based extractor, which reads the archive from disk and writes pages to
   * disk. Unlike the data-based extractor it does NOT hold the archive or every
   * extracted page in memory (which gets the process OOM-killed on shared hosts).
   * Returns { dir, files: [{ name, path }] }.
   */
  static async extractRarToDirWithUnrarJs(inputPath) {
    const mod = getUnrarJs();
    if (!mod || typeof mod.createExtractorFromFile !== 'function') {
      throw new Error('node-unrar-js file extractor is not available');
    }
    const tmpDir = path.join(os.tmpdir(), `cmx_rar_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
      const extractor = await mod.createExtractorFromFile({ filepath: inputPath, targetPath: tmpDir });
      // Iterating the generator drives extraction; each page is written to disk.
      const listing = extractor.extract();
      for (const _f of listing.files) { /* consume to force extraction */ }

      const files = [];
      const walk = (dir, relPrefix = '') => {
        for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, item.name);
          const rel = relPrefix ? `${relPrefix}/${item.name}` : item.name;
          if (item.isDirectory()) {
            walk(full, rel);
          } else if (item.isFile()) {
            const isHidden = rel.includes('__MACOSX') || path.basename(rel).startsWith('.');
            if (!isHidden) files.push({ name: rel.replace(/\\/g, '/'), path: full });
          }
        }
      };
      walk(tmpDir);
      if (files.length === 0) throw new Error('RAR extraction produced no pages');
      return { dir: tmpDir, files };
    } catch (e) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e2) {}
      throw e;
    }
  }

  /**
   * Memory-safe replacement for compressCBZBuffer on shared hosting:
   * extracts the archive to a temp directory, re-encodes each page one at a
   * time, and streams the repacked CBZ to `outputPath` on disk. At no point is
   * the whole book held in memory.
   * Returns { filePath, originalSize, compressedSize, savedBytes, percentSaved, isCompressed, pages }.
   */
  static async compressArchiveFileToFile(inputPath, outputPath, options = {}) {
    const quality = options.quality || 75;
    const onProgress = options.onProgress;
    const originalSize = fs.statSync(inputPath).size;
    const type = this.detectArchiveType(inputPath);
    const isRar = type === 'rar';
    const is7z = type === '7z';
    console.log(`[ComicCompressor] Streaming compression start (${type}, ${(originalSize / (1024 * 1024)).toFixed(2)} MB)...`);

    let tempDir = null;
    let fileEntries = null; // [{ name, path }]
    const extractorTool = this.findExtractorTool();

    if (isRar) {
      // 7za cannot read RAR. Use node-unrar-js's disk-streaming extractor.
      if (getUnrarJs()) {
        try {
          const res = await this.extractRarToDirWithUnrarJs(inputPath);
          tempDir = res.dir;
          fileEntries = res.files;
          console.log(`[ComicCompressor] Extracted RAR via node-unrar-js (${fileEntries.length} files).`);
        } catch (e) {
          console.warn('[ComicCompressor] node-unrar-js RAR extraction failed:', e.message);
        }
      }
      // Only try a system tool for RAR if it is not the RAR-incapable 7za/7zr.
      if ((!fileEntries || fileEntries.length === 0) && extractorTool && !/7za|7zr/i.test(extractorTool)) {
        try {
          const res = await this.extractToDirWithSystemToolAsync(inputPath, '.cbr');
          tempDir = res.dir;
          fileEntries = res.files;
        } catch (e) {
          console.warn('[ComicCompressor] System RAR extraction failed:', e.message);
        }
      }
    } else if (extractorTool) {
      // System extractor writes pages straight to disk (handles zip/cbz/7z).
      try {
        const res = await this.extractToDirWithSystemToolAsync(inputPath, is7z ? '.7z' : '.cbz');
        tempDir = res.dir;
        fileEntries = res.files;
      } catch (e) {
        console.warn('[ComicCompressor] System extraction failed:', e.message);
        if (tempDir) { try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e2) {} }
        tempDir = null;
      }
    }

    // Pure-JS fallback (ZIP only). NEVER use this for RAR/7z: the in-memory RAR
    // extractor materialises the whole book at once and gets OOM-killed.
    if ((!fileEntries || fileEntries.length === 0) && !isRar && !is7z) {
      const buf = fs.readFileSync(inputPath);
      tempDir = path.join(os.tmpdir(), `cmx_ext_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
      fs.mkdirSync(tempDir, { recursive: true });
      fileEntries = [];
      let spillCount = 0;
      for await (const entry of this.iterUnpackCBZ(buf)) {
        const safeRel = String(entry.name).replace(/\.\.+/g, '').replace(/^[\\/]+/, '');
        const full = path.join(tempDir, safeRel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, entry.data);
        entry.data = null;
        fileEntries.push({ name: entry.name, path: full });
        if ((spillCount++ % 4) === 0) await new Promise((r) => setImmediate(r));
      }
    }

    if (!fileEntries || fileEntries.length === 0) {
      if (tempDir) { try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {} }
      if (isRar || is7z) {
        throw new Error(`Could not extract the ${type.toUpperCase()} archive on this host (no compatible extractor available).`);
      }
      // ZIP/unknown: keep the original archive as the output.
      fs.copyFileSync(inputPath, outputPath);
      const size = fs.statSync(outputPath).size;
      return { filePath: outputPath, originalSize, compressedSize: size, savedBytes: 0, percentSaved: 0, isCompressed: false, pages: 0 };
    }

    {
      const m = process.memoryUsage();
      console.log(`[ComicCompressor] Extracted ${fileEntries.length} pages. mem rss=${(m.rss / 1048576).toFixed(0)}MB`);
    }

    fileEntries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    const totalFiles = fileEntries.length;
    let done = 0;
    const self = this;

    // Capture first image (cover thumbnail, max 512px tall @ 85% JPEG) before repacking to .cbz
    let coverJpeg = null;
    let firstPageBuffer = null;
    if (fileEntries.length > 0) {
      try {
        firstPageBuffer = fs.readFileSync(fileEntries[0].path);
        coverJpeg = await this.makeCoverJpeg(firstPageBuffer, { maxHeight: 512, quality: 85 });
      } catch (covErr) {
        console.warn('[ComicCompressor] First page cover thumbnail creation note:', covErr.message);
      }
    }

    async function* compressedPages() {
      for (const f of fileEntries) {
        let data = null;
        try {
          data = fs.readFileSync(f.path);
          let res;
          let timer;
          try {
            const pagePromise = self.compressImageBuffer(data, f.name, quality);
            const timeoutPromise = new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error('page compression timed out')), 12000);
            });
            res = await Promise.race([pagePromise, timeoutPromise]);
            clearTimeout(timer);
          } catch (pageErr) {
            clearTimeout(timer);
            console.warn(`[ComicCompressor] Page compression skipped for ${f.name}:`, pageErr.message);
            res = { data, name: f.name, compressed: false };
          }
          yield { name: res.name, data: res.data };
        } catch (readErr) {
          console.warn(`[ComicCompressor] Skipping unreadable page ${f.name}:`, readErr.message);
          continue;
        } finally {
          data = null;
        }
        done++;
        if (onProgress) {
          onProgress({
            current: done,
            total: totalFiles,
            percent: Math.round((done / totalFiles) * 100),
            step: `Compressing page ${done} of ${totalFiles}`
          });
        }
        if (done % 20 === 0) {
          const m = process.memoryUsage();
          console.log(`[ComicCompressor] mem rss=${(m.rss / 1048576).toFixed(0)}MB heapUsed=${(m.heapUsed / 1048576).toFixed(0)}MB (page ${done}/${totalFiles})`);
        }
        await new Promise((r) => setImmediate(r));
      }
    }

    await createStreamingCBZ(outputPath, compressedPages(), false);

    const compressedSize = fs.statSync(outputPath).size;
    const savedBytes = Math.max(0, originalSize - compressedSize);
    const percentSaved = originalSize > 0 ? Math.round((savedBytes / originalSize) * 1000) / 10 : 0;

    // Save cover thumbnail file directly alongside output archive if cover was generated
    const coverLocalPath = outputPath.replace(/\.[a-zA-Z0-9]+$/i, '.jpg');
    if (coverJpeg) {
      try {
        fs.writeFileSync(coverLocalPath, coverJpeg);
        console.log(`[ComicCompressor] Saved cover thumbnail alongside comic: ${path.basename(coverLocalPath)} (max 512px)`);
      } catch (err) {
        console.warn(`[ComicCompressor] Could not save local cover thumbnail ${coverLocalPath}:`, err.message);
      }
    }

    if (tempDir) { try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {} }

    console.log(`[ComicCompressor] Streaming compression complete: ${(originalSize / (1024 * 1024)).toFixed(2)} MB -> ${(compressedSize / (1024 * 1024)).toFixed(2)} MB (${percentSaved}% saved)`);

    return {
      filePath: outputPath,
      originalSize,
      compressedSize,
      savedBytes,
      percentSaved,
      isCompressed: percentSaved > 0,
      pages: totalFiles,
      coverJpeg,
      coverLocalPath,
      firstPageBuffer
    };
  }

  /**
   * Compresses a single image buffer to JPEG format with specified quality (default 75%).
   * Returns: { data: Buffer, name: string, compressed: boolean }
   */
  static async compressImageBuffer(imgBuffer, fileName, quality = 75) {
    const ext = path.extname(fileName).toLowerCase();
    const isImage = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif'].includes(ext);
    if (!isImage || !imgBuffer || !Buffer.isBuffer(imgBuffer) || imgBuffer.length < 32) {
      return { data: imgBuffer, name: fileName, compressed: false };
    }

    // 1. Try Sharp if available
    const sharp = getSharp();
    if (sharp) {
      let timer;
      try {
        const compressPromise = (async () => {
          return await sharp(imgBuffer, { failOn: 'none', animated: false })
            .rotate() // Auto-orient based on EXIF
            .resize({ width: 2048, height: 2560, fit: 'inside', withoutEnlargement: true }) // Capped to 2.5K to prevent massive RAM spikes on shared hosting
            .flatten({ background: '#ffffff' }) // Ensure PNG/WebP with alpha converts cleanly to JPEG
            .toColorspace('srgb') // Normalize CMYK/grayscale/custom ICC to sRGB
            .jpeg({ quality, mozjpeg: false, chromaSubsampling: '4:2:0' })
            .toBuffer();
        })();

        // 10-second timeout per page for Sharp so a stuck/corrupted page never blocks the job
        const timeoutPromise = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Sharp compression timed out')), 10000);
        });

        const compressed = await Promise.race([compressPromise, timeoutPromise]);
        clearTimeout(timer);

        const newName = fileName.replace(/\.[a-zA-Z0-9]+$/i, '.jpg');

        // Accept compressed buffer if it's smaller, or if converting from png/webp/bmp
        if (compressed && (compressed.length < imgBuffer.length || ['.png', '.webp', '.bmp'].includes(ext))) {
          return { data: compressed, name: newName, compressed: true };
        }
        return { data: imgBuffer, name: newName, compressed: false };
      } catch (sharpErr) {
        clearTimeout(timer);
        console.warn(`[ComicCompressor] Sharp compression note for ${fileName}:`, sharpErr.message);
        // CRITICAL: When Sharp is available, DO NOT fall back to jpeg-js.
        // jpeg-js cannot handle progressive JPEGs and will freeze or infinite-loop.
        return { data: imgBuffer, name: fileName, compressed: false };
      }
    }

    // 2. Pure JS fallback ONLY when Sharp is NOT installed on this host
    const jpegJs = getJpegJs();
    const pngJs = getPngJs();
    if (jpegJs) {
      try {
        if (['.jpg', '.jpeg'].includes(ext)) {
          const raw = jpegJs.decode(imgBuffer, { useTArray: true });
          if (raw && raw.data && raw.width && raw.height) {
            const encoded = jpegJs.encode(raw, quality);
            if (encoded && encoded.data && encoded.data.length < imgBuffer.length) {
              return {
                data: encoded.data,
                name: fileName.replace(/\.[a-zA-Z0-9]+$/i, '.jpg'),
                compressed: true
              };
            }
          }
        } else if (ext === '.png' && pngJs) {
          const png = pngJs.PNG.sync.read(imgBuffer);
          if (png && png.data && png.width && png.height) {
            const raw = { data: png.data, width: png.width, height: png.height };
            const encoded = jpegJs.encode(raw, quality);
            if (encoded && encoded.data && encoded.data.length < imgBuffer.length) {
              return {
                data: encoded.data,
                name: fileName.replace(/\.[a-zA-Z0-9]+$/i, '.jpg'),
                compressed: true
              };
            }
          }
          // JPEG conversion not smaller: keep the PNG untouched
          return { data: imgBuffer, name: fileName, compressed: false };
        }
      } catch (pureJsErr) {
        console.warn(`[ComicCompressor] Pure-JS compression note for ${fileName}:`, pureJsErr.message);
      }
    }

    // Fallback: keep original image
    return { data: imgBuffer, name: fileName, compressed: false };
  }

  /**
   * Builds a JPEG cover thumbnail from a page image: at most `maxHeight` px tall
   * (never enlarged) at the given JPEG quality. Uses sharp when available, else a
   * pure-JS decode + nearest-neighbour downscale.
   */
  static async makeCoverJpeg(imageBuffer, options = {}) {
    const maxHeight = options.maxHeight || 512;
    const quality = options.quality || 85;
    if (!imageBuffer || !Buffer.isBuffer(imageBuffer) || imageBuffer.length < 32) return null;

    const sharp = getSharp();
    if (sharp) {
      try {
        return await sharp(imageBuffer, { failOn: 'none', animated: false })
          .rotate()
          .resize({ height: maxHeight, fit: 'inside', withoutEnlargement: true })
          .flatten({ background: '#ffffff' })
          .toColorspace('srgb')
          .jpeg({ quality, mozjpeg: false, chromaSubsampling: '4:2:0' })
          .toBuffer();
      } catch (e) {
        console.warn('[ComicCompressor] sharp cover generation failed:', e.message);
      }
    }

    // Pure-JS fallback
    const jpegJs = getJpegJs();
    const pngJs = getPngJs();
    const magic = imageBuffer.slice(0, 4).toString('hex');
    let raw = null;
    try {
      if (jpegJs && magic === 'ffd8ff') {
        raw = jpegJs.decode(imageBuffer, { useTArray: true });
      } else if (jpegJs && magic.startsWith('ffd8')) {
        raw = jpegJs.decode(imageBuffer, { useTArray: true });
      } else if (pngJs && magic === '89504e47') {
        const png = pngJs.PNG.sync.read(imageBuffer);
        raw = { data: png.data, width: png.width, height: png.height };
      }
    } catch (e) {
      console.warn('[ComicCompressor] Pure-JS cover decode failed:', e.message);
    }
    if (!raw || !raw.data || !raw.width || !raw.height || !jpegJs) return null;

    let { data, width, height } = raw;
    if (height > maxHeight) {
      const dw = Math.max(1, Math.round((width * maxHeight) / height));
      data = downscaleNearest(data, width, height, dw, maxHeight);
      width = dw;
      height = maxHeight;
    }
    try {
      return Buffer.from(jpegJs.encode({ data, width, height }, quality).data);
    } catch (e) {
      console.warn('[ComicCompressor] Pure-JS cover encode failed:', e.message);
      return null;
    }
  }

  /**
   * Extracts the first page image from any archive (CBZ, CBR, ZIP, RAR) and generates
   * a thumbnail scaled to max 512px height at 85% JPEG quality.
   */
  static async extractCoverThumbnail(archivePathOrBuffer, options = {}) {
    const maxHeight = options.maxHeight || 512;
    const quality = options.quality || 85;

    let firstImageData = null;
    let firstImageName = 'cover.jpg';

    const isPath = typeof archivePathOrBuffer === 'string';
    let type = 'unknown';

    if (isPath) {
      if (!fs.existsSync(archivePathOrBuffer)) return null;
      type = this.detectArchiveType(archivePathOrBuffer);
    } else if (Buffer.isBuffer(archivePathOrBuffer)) {
      if (archivePathOrBuffer.slice(0, 4).toString('ascii') === 'Rar!') type = 'rar';
      else if (archivePathOrBuffer.slice(0, 4).toString('hex') === '504b0304') type = 'zip';
    }

    // 1. Try RAR extraction
    if (type === 'rar') {
      const mod = getUnrarJs();
      if (mod) {
        try {
          let extractor;
          if (isPath && typeof mod.createExtractorFromFile === 'function') {
            extractor = await mod.createExtractorFromFile({ filepath: archivePathOrBuffer });
          } else {
            const buf = isPath ? fs.readFileSync(archivePathOrBuffer) : archivePathOrBuffer;
            extractor = await mod.createExtractorFromData({ data: new Uint8Array(buf) });
          }

          const fileList = extractor.getFileList();
          const imageHeaders = [...fileList.fileHeaders]
            .filter((h) => !(h.flags & 0x01) && /\.(jpe?g|png|webp|gif|bmp)$/i.test(h.name) && !h.name.includes('__MACOSX'))
            .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

          if (imageHeaders.length > 0) {
            firstImageName = path.basename(imageHeaders[0].name);
            const extracted = extractor.extract({ files: [imageHeaders[0].name] });
            if (extracted && extracted.files && extracted.files.length > 0 && extracted.files[0].extraction) {
              firstImageData = Buffer.from(extracted.files[0].extraction);
            }
          }
        } catch (e) {
          console.warn('[ComicCompressor] RAR cover extraction failed:', e.message);
        }
      }
    }

    // 2. Try ZIP / CBZ extraction
    if (!firstImageData && (type === 'zip' || type === 'unknown')) {
      if (isPath) {
        try {
          const CBZReader = require('./cbzReader');
          const page1 = CBZReader.extractPage(archivePathOrBuffer, 1);
          if (page1 && page1.data) {
            firstImageData = page1.data;
            firstImageName = page1.fileName || 'cover.jpg';
          }
        } catch (e) {
          try {
            const buf = fs.readFileSync(archivePathOrBuffer);
            for await (const entry of this.iterUnpackCBZ(buf)) {
              if (/\.(jpe?g|png|webp|gif|bmp)$/i.test(entry.name)) {
                firstImageData = entry.data;
                firstImageName = path.basename(entry.name);
                break;
              }
            }
          } catch (e2) {}
        }
      } else {
        try {
          const CBZReader = require('./cbzReader');
          const first = await CBZReader.extractFirstImageFromBuffer(archivePathOrBuffer);
          if (first && first.data) {
            firstImageData = first.data;
            firstImageName = first.fileName || 'cover.jpg';
          }
        } catch (e) {}
      }
    }

    if (!firstImageData || !Buffer.isBuffer(firstImageData) || firstImageData.length < 32) {
      return null;
    }

    const coverJpeg = await this.makeCoverJpeg(firstImageData, { maxHeight, quality });
    if (!coverJpeg) return null;

    return {
      coverJpeg,
      rawImage: firstImageData,
      name: firstImageName
    };
  }

  /**
   * Extracts a RAR/CBR archive in-process using node-unrar-js (WASM), with no
   * system binaries required. Returns entries as [{ name, data }].
   */
  static async extractWithRarJs(rarBuffer) {
    const unrarJsModule = getUnrarJs();
    if (!unrarJsModule) {
      throw new Error('node-unrar-js is not available on this host');
    }
    const { createExtractorFromData } = unrarJsModule;
    const extractor = await createExtractorFromData({ data: new Uint8Array(rarBuffer) });
    const fileList = extractor.getFileList();
    const names = [...fileList.fileHeaders].map((h) => h.name);
    const result = extractor.extract({ files: names });

    if (!result) {
      throw new Error('In-memory RAR extraction returned no result');
    }
    if (result.passRequired) {
      throw new Error('Encrypted RAR archive requires a password');
    }
    if (!result.files) {
      throw new Error('In-memory RAR extraction returned no files');
    }

    const entries = [];
    for (const f of result.files) {
      if (!f || !f.extraction) continue;
      const header = f.fileHeader || {};
      let name = String(header.name || '').replace(/[\\/]+/g, '/').replace(/^\/+/, '');
      if (!name) continue;
      if (header.flags & 0x01) continue; // directory entry
      entries.push({ name, data: Buffer.from(f.extraction) });
    }
    return entries;
  }

  /**
   * Unpacks a .cbz/.cbr archive, compresses all contained images to 75% JPEG quality,
   * and repacks into a clean .cbz buffer.
   */
  static async compressCBZBuffer(cbzBuffer, options = {}) {
    const quality = options.quality || 75;
    const onProgress = options.onProgress;

    const originalSize = cbzBuffer.length;
    console.log(`[ComicCompressor] Starting unpacking for compression (original size: ${(originalSize / (1024 * 1024)).toFixed(2)} MB)...`);

    // 1. Unpack all files
    const entries = await this.unpackCBZ(cbzBuffer);
    if (!entries || entries.length === 0) {
      console.warn('[ComicCompressor] No files found inside archive, returning original');
      return {
        buffer: cbzBuffer,
        originalSize,
        compressedSize: originalSize,
        savedBytes: 0,
        percentSaved: 0,
        isCompressed: false
      };
    }

    console.log(`[ComicCompressor] Unpacked ${entries.length} files. Compressing image pages at ${quality}% quality...`);

    // 2. Compress each image to 75% JPEG quality
    const compressedFiles = [];
    const totalFiles = entries.length;

    for (let i = 0; i < totalFiles; i++) {
      const entry = entries[i];
      if (onProgress) {
        onProgress({
          current: i + 1,
          total: totalFiles,
          percent: Math.round(((i + 1) / totalFiles) * 100),
          step: `Compressing page ${i + 1} of ${totalFiles}`
        });
      }

      let res;
      let pageTimer;
      try {
        const pagePromise = this.compressImageBuffer(entry.data, entry.name, quality);
        const timeoutPromise = new Promise((_, reject) => {
          pageTimer = setTimeout(() => reject(new Error(`Page ${i + 1} (${entry.name}) compression timed out after 12s`)), 12000);
        });
        res = await Promise.race([pagePromise, timeoutPromise]);
        clearTimeout(pageTimer);
      } catch (pageErr) {
        clearTimeout(pageTimer);
        console.warn(`[ComicCompressor] Page compression skipped for ${entry.name}:`, pageErr.message);
        res = { data: entry.data, name: entry.name, compressed: false };
      }
      compressedFiles.push({
        name: res.name,
        data: res.data
      });

      // Free uncompressed raw page buffer immediately to prevent RAM buildup on shared hosting
      entry.data = null;

      // Yield to the event loop between pages so API requests stay responsive
      // even when falling back to the slower pure-JS encoder.
      await new Promise((resolve) => setImmediate(resolve));
    }

    // 3. Repack into new CBZ archive (store mode: instant, avoids redundant re-deflating of JPEGs)
    console.log(`[ComicCompressor] Repacking ${compressedFiles.length} pages into clean CBZ archive...`);
    const repackedBuffer = createZipBuffer(compressedFiles, false);
    const compressedSize = repackedBuffer.length;
    const savedBytes = Math.max(0, originalSize - compressedSize);
    const percentSaved = originalSize > 0
      ? Math.round((savedBytes / originalSize) * 1000) / 10
      : 0;

    console.log(
      `[ComicCompressor] Compression complete: ${(originalSize / (1024 * 1024)).toFixed(2)} MB -> ${(compressedSize / (1024 * 1024)).toFixed(2)} MB (${percentSaved}% saved at ${quality}% JPEG quality)`
    );

    return {
      buffer: repackedBuffer,
      originalSize,
      compressedSize,
      savedBytes,
      percentSaved,
      isCompressed: percentSaved > 0
    };
  }
/**
   * Returns which compression engines are available on this host.
   */
  static getStatus() {
    let extractor = null;
    try {
      extractor = this.findExtractorTool();
    } catch (e) {}
    // Report installability via require.resolve() only — never load a native
    // module here, since doing so could crash the process on a bad host.
    const sharpInstalled = moduleResolvable('sharp');
    const jpegInstalled = moduleResolvable('jpeg-js');
    const pngInstalled = moduleResolvable('pngjs');
    const unrarInstalled = moduleResolvable('node-unrar-js');
    return {
      available: sharpInstalled || jpegInstalled,
      sharpAvailable: sharpInstalled,
      pureJsAvailable: jpegInstalled,
      pngJsAvailable: pngInstalled,
      unrarJsAvailable: unrarInstalled,
      engine: sharpInstalled ? 'sharp' : jpegInstalled ? 'jpeg-js' : null,
      archiveExtractor: extractor,
      archiveSupport: [
        'zip/cbz (built-in pure JS parser)',
        'rar/cbr (node-unrar-js, in-process)'
      ].concat(extractor ? ['7z/other (system extractor)'] : []).join(', ')
    };
  }
}

module.exports = ComicCompressor;
