// Archive extraction for downloaded PC game repacks.
// Ported from my-games-server stream/archive.js.
//
// 7-Zip is tried first because it is the only thing that reliably handles
// .rar/.7z/.iso; AdmZip is a last-resort fallback for small .zip files only.

import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import AdmZip from 'adm-zip';
import sevenZip from '7zip-min';
import sevenZipBin from '7zip-bin';

const __dirname = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

export const ARCHIVE_EXTENSIONS = ['.zip', '.7z', '.rar', '.iso', '.tar', '.gz', '.bz2', '.xz', '.cab', '.msi'];

export function detectArchiveBufferType(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  // ZIP: PK\x03\x04, PK\x05\x06 (empty zip), PK\x07\x08 (spanned)
  if (buffer[0] === 0x50 && buffer[1] === 0x4B) {
    if ((buffer[2] === 0x03 && buffer[3] === 0x04) ||
        (buffer[2] === 0x05 && buffer[3] === 0x06) ||
        (buffer[2] === 0x07 && buffer[3] === 0x08)) {
      return '.zip';
    }
  }
  // 7Z: 7z\xBC\xAF\x27\x1C
  if (buffer.length >= 6 &&
      buffer[0] === 0x37 && buffer[1] === 0x7A && buffer[2] === 0xBC &&
      buffer[3] === 0xAF && buffer[4] === 0x27 && buffer[5] === 0x1C) {
    return '.7z';
  }
  // RAR: Rar!\x1A\x07 (v5 or v4)
  if (buffer.length >= 7 &&
      buffer[0] === 0x52 && buffer[1] === 0x61 && buffer[2] === 0x72 &&
      buffer[3] === 0x21 && buffer[4] === 0x1A && buffer[5] === 0x07) {
    return '.rar';
  }
  // GZ: \x1F\x8B
  if (buffer[0] === 0x1F && buffer[1] === 0x8B) {
    return '.gz';
  }
  // TAR: "ustar" at offset 257
  if (buffer.length >= 262) {
    const magic = buffer.slice(257, 262).toString('ascii');
    if (magic === 'ustar') return '.tar';
  }
  return null;
}

export function detectArchiveFileType(filePath) {
  if (!filePath || typeof filePath !== 'string') return null;
  try {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 4) return null;
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(300);
    const bytesRead = fs.readSync(fd, buf, 0, 300, 0);
    fs.closeSync(fd);
    if (bytesRead >= 4) {
      return detectArchiveBufferType(buf.slice(0, bytesRead));
    }
  } catch (_) {}
  return null;
}

export function isArchivePath(p) {
  if (!p) return false;
  const ext = path.extname(String(p || '')).toLowerCase();
  if (ARCHIVE_EXTENSIONS.includes(ext)) return true;
  if (typeof p === 'string') {
    const detected = detectArchiveFileType(p);
    if (detected) return true;
  }
  return false;
}

export function get7zaBinaryPath() {
  const binName = process.platform === 'win32' ? '7za.exe' : '7za';
  const candidates = [
    path.join(process.cwd(), 'bin', binName),
    path.join(__dirname, 'bin', binName),
    path.join(__dirname, '..', 'bin', binName)
  ];

  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '7zip-bin', 'win', 'x64', binName));
    candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '7zip-bin', 'win', 'ia32', binName));
  }

  if (sevenZipBin && sevenZipBin.path7za) {
    candidates.push(sevenZipBin.path7za);
  }

  for (const cPath of candidates) {
    if (cPath && fs.existsSync(cPath)) {
      return cPath;
    }
  }
  return sevenZipBin?.path7za;
}

export async function flattenExtractedFolder(targetDir) {
  try {
    const ignoredFiles = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);

    async function collectAndMoveFiles(currentDir) {
      const items = await fs.promises.readdir(currentDir, { withFileTypes: true });
      for (const item of items) {
        const fullPath = path.join(currentDir, item.name);
        if (item.isDirectory()) {
          await collectAndMoveFiles(fullPath);
          try {
            const remaining = await fs.promises.readdir(fullPath);
            if (remaining.length === 0) await fs.promises.rmdir(fullPath);
          } catch (_) {}
        } else if (item.isFile()) {
          if (!ignoredFiles.has(item.name.toLowerCase()) && currentDir !== targetDir) {
            const destPath = path.join(targetDir, item.name);
            try {
              await fs.promises.rename(fullPath, destPath);
            } catch (_) {}
          }
        }
      }
    }

    await collectAndMoveFiles(targetDir);
    const topItems = await fs.promises.readdir(targetDir, { withFileTypes: true });
    for (const item of topItems) {
      if (item.isDirectory()) {
        const subPath = path.join(targetDir, item.name);
        try {
          const contents = await fs.promises.readdir(subPath);
          if (contents.length === 0) {
            await fs.promises.rm(subPath, { recursive: true, force: true });
          }
        } catch (_) {}
      }
    }
  } catch (e) {
    console.error(`[Unpack] Error flattening directory ${targetDir}:`, e.message);
  }
}

export async function unpack7z(archivePath, targetDir) {
  if (!fs.existsSync(archivePath)) {
    throw new Error(`Archive path does not exist on disk: ${archivePath}`);
  }
  await fs.promises.mkdir(targetDir, { recursive: true });

  let currentArchivePath = archivePath;
  let ext = path.extname(currentArchivePath).toLowerCase();
  const detectedExt = detectArchiveFileType(currentArchivePath);

  // If archive has no extension or an unknown extension, but matches archive magic bytes,
  // rename it on disk so that 7-zip CLI, 7zip-min, and AdmZip know how to parse it.
  if (!ext && detectedExt) {
    const renamedPath = `${currentArchivePath}${detectedExt}`;
    try {
      fs.renameSync(currentArchivePath, renamedPath);
      currentArchivePath = renamedPath;
      ext = detectedExt;
      console.log(`[Unpack] Added missing extension ${detectedExt} to archive: ${archivePath} -> ${renamedPath}`);
    } catch (_) {}
  }

  const stat = fs.statSync(currentArchivePath);

  // Priority 1: 7za CLI
  const binaryPath = get7zaBinaryPath();
  if (binaryPath && fs.existsSync(binaryPath)) {
    try {
      await new Promise((resolve, reject) => {
        const outArg = `-o${targetDir}${path.sep}`;
        execFile(binaryPath, ['x', currentArchivePath, outArg, '-y', '-aoa'], {
          cwd: targetDir,
          windowsHide: true,
          maxBuffer: 50 * 1024 * 1024
        }, (err) => {
          if (err) return reject(err);
          resolve();
        });
      });
      return { path: currentArchivePath, ext };
    } catch (err1) {
      console.warn('[Unpack] 7za CLI failed, falling back:', err1.message);
    }
  }

  // Priority 2: 7zip-min module fallback
  if (sevenZip && typeof sevenZip.unpack === 'function') {
    try {
      await new Promise((resolve, reject) => {
        sevenZip.unpack(currentArchivePath, targetDir, (err) => {
          if (err) return reject(err);
          resolve();
        });
      });
      const itemsMin = await fs.promises.readdir(targetDir);
      if (itemsMin.length > 0) return { path: currentArchivePath, ext };
    } catch (err2) {
      console.warn('[Unpack] 7zip-min failed, falling back:', err2.message);
    }
  }

  // Priority 3: Native AdmZip for smaller .zip files
  if ((ext === '.zip' || detectedExt === '.zip') && stat.size < 1500 * 1024 * 1024) {
    try {
      const zip = new AdmZip(currentArchivePath);
      zip.extractAllTo(targetDir, true);
      return { path: currentArchivePath, ext };
    } catch (errZip) {
      console.error('[Unpack] AdmZip extraction error:', errZip.message);
    }
  }

  throw new Error(`Extraction failed for ${currentArchivePath}`);
}
