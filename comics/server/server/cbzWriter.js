const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// Precomputed CRC32 table for ultra-fast checksum calculation
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
  }
  CRC_TABLE[n] = c;
}

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Creates a standard .zip / .cbz buffer from a list of files in pure Node.js.
 * @param {Array<{ name: string, data: Buffer }>} files
 * @param {boolean} compress - whether to apply deflate compression (default true)
 * @returns {Buffer}
 */
function createZipBuffer(files, compress = true) {
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;

  for (const file of files) {
    const fileNameBuf = Buffer.from(file.name, 'utf8');
    const uncompressedData = file.data;
    const uncompressedSize = uncompressedData.length;
    const checksum = crc32(uncompressedData);

    let compressedData = uncompressedData;
    let compressionMethod = 0; // Stored (no compression)

    if (compress) {
      const deflated = zlib.deflateRawSync(uncompressedData);
      if (deflated.length < uncompressedSize) {
        compressedData = deflated;
        compressionMethod = 8; // Deflate
      }
    }

    const compressedSize = compressedData.length;

    // Local File Header (30 bytes + filename length)
    const localHeader = Buffer.alloc(30 + fileNameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // Signature
    localHeader.writeUInt16LE(20, 4);         // Version needed (2.0)
    localHeader.writeUInt16LE(0, 6);          // General purpose flags
    localHeader.writeUInt16LE(compressionMethod, 8); // Method
    localHeader.writeUInt16LE(0, 10);        // Mod time
    localHeader.writeUInt16LE(0, 12);        // Mod date
    localHeader.writeUInt32LE(checksum, 14);  // CRC-32
    localHeader.writeUInt32LE(compressedSize, 18);   // Compressed size
    localHeader.writeUInt32LE(uncompressedSize, 22); // Uncompressed size
    localHeader.writeUInt16LE(fileNameBuf.length, 26); // Filename length
    localHeader.writeUInt16LE(0, 28);        // Extra field length
    fileNameBuf.copy(localHeader, 30);

    localHeaders.push(localHeader, compressedData);

    // Central Directory File Header (46 bytes + filename length)
    const centralHeader = Buffer.alloc(46 + fileNameBuf.length);
    centralHeader.writeUInt32LE(0x02014b50, 0); // Signature
    centralHeader.writeUInt16LE(20, 4);         // Version made by
    centralHeader.writeUInt16LE(20, 6);         // Version needed
    centralHeader.writeUInt16LE(0, 8);          // General purpose flags
    centralHeader.writeUInt16LE(compressionMethod, 10);
    centralHeader.writeUInt16LE(0, 12);         // Mod time
    centralHeader.writeUInt16LE(0, 14);         // Mod date
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressedSize, 20);
    centralHeader.writeUInt32LE(uncompressedSize, 24);
    centralHeader.writeUInt16LE(fileNameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);         // Extra field length
    centralHeader.writeUInt16LE(0, 32);         // File comment length
    centralHeader.writeUInt16LE(0, 34);         // Disk start number
    centralHeader.writeUInt16LE(0, 36);         // Internal file attrs
    centralHeader.writeUInt32LE(0, 38);         // External file attrs
    centralHeader.writeUInt32LE(offset, 42);    // Relative offset of local header
    fileNameBuf.copy(centralHeader, 46);

    centralHeaders.push(centralHeader);

    offset += localHeader.length + compressedData.length;
  }

  const centralDirOffset = offset;
  const centralDirBuffer = Buffer.concat(centralHeaders);
  const centralDirSize = centralDirBuffer.length;

  // End of Central Directory Record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4);          // Disk number
  eocd.writeUInt16LE(0, 6);          // Start disk
  eocd.writeUInt16LE(files.length, 8);  // Entries on disk
  eocd.writeUInt16LE(files.length, 10); // Total entries
  eocd.writeUInt32LE(centralDirSize, 12); // Size of central directory
  eocd.writeUInt32LE(centralDirOffset, 16); // Offset of start of central directory
  eocd.writeUInt16LE(0, 20);         // Comment length

  return Buffer.concat([...localHeaders, centralDirBuffer, eocd]);
}

function saveCBZ(destFilePath, files, compress = true) {
  const dir = path.dirname(destFilePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const zipBuf = createZipBuffer(files, compress);
  fs.writeFileSync(destFilePath, zipBuf);
  return zipBuf.length;
}

/**
 * Creates a .zip / .cbz archive on disk by streaming files sequentially.
 * Keeps memory usage under a few megabytes even for huge 500+ page omnibus files.
 * @param {string} destFilePath - destination .cbz path
 * @param {AsyncIterable<{ name: string, data: Buffer }> | Iterable<{ name: string, data: Buffer }>} fileIterable
 * @param {boolean} compress - whether to apply deflate compression
 * @returns {Promise<{ totalFiles: number, totalBytes: number }>}
 */
async function createStreamingCBZ(destFilePath, fileIterable, compress = true) {
  const dir = path.dirname(destFilePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const outStream = fs.createWriteStream(destFilePath);
  const centralHeaders = [];
  let offset = 0;
  let fileCount = 0;

  const writeChunk = (chunk) => {
    return new Promise((resolve, reject) => {
      if (!outStream.write(chunk)) {
        outStream.once('drain', resolve);
      } else {
        process.nextTick(resolve);
      }
    });
  };

  try {
    for await (const file of fileIterable) {
      if (!file || !file.name || !file.data) continue;

      const fileNameBuf = Buffer.from(file.name, 'utf8');
      const uncompressedData = file.data;
      const uncompressedSize = uncompressedData.length;
      const checksum = crc32(uncompressedData);

      let compressedData = uncompressedData;
      let compressionMethod = 0; // Stored

      if (compress) {
        const deflated = zlib.deflateRawSync(uncompressedData);
        if (deflated.length < uncompressedSize) {
          compressedData = deflated;
          compressionMethod = 8; // Deflate
        }
      }

      const compressedSize = compressedData.length;

      // Local File Header
      const localHeader = Buffer.alloc(30 + fileNameBuf.length);
      localHeader.writeUInt32LE(0x04034b50, 0);
      localHeader.writeUInt16LE(20, 4);
      localHeader.writeUInt16LE(0, 6);
      localHeader.writeUInt16LE(compressionMethod, 8);
      localHeader.writeUInt16LE(0, 10);
      localHeader.writeUInt16LE(0, 12);
      localHeader.writeUInt32LE(checksum, 14);
      localHeader.writeUInt32LE(compressedSize, 18);
      localHeader.writeUInt32LE(uncompressedSize, 22);
      localHeader.writeUInt16LE(fileNameBuf.length, 26);
      localHeader.writeUInt16LE(0, 28);
      fileNameBuf.copy(localHeader, 30);

      await writeChunk(localHeader);
      await writeChunk(compressedData);

      // Central Directory Header
      const centralHeader = Buffer.alloc(46 + fileNameBuf.length);
      centralHeader.writeUInt32LE(0x02014b50, 0);
      centralHeader.writeUInt16LE(20, 4);
      centralHeader.writeUInt16LE(20, 6);
      centralHeader.writeUInt16LE(0, 8);
      centralHeader.writeUInt16LE(compressionMethod, 10);
      centralHeader.writeUInt16LE(0, 12);
      centralHeader.writeUInt16LE(0, 14);
      centralHeader.writeUInt32LE(checksum, 16);
      centralHeader.writeUInt32LE(compressedSize, 20);
      centralHeader.writeUInt32LE(uncompressedSize, 24);
      centralHeader.writeUInt16LE(fileNameBuf.length, 28);
      centralHeader.writeUInt16LE(0, 30);
      centralHeader.writeUInt16LE(0, 32);
      centralHeader.writeUInt16LE(0, 34);
      centralHeader.writeUInt16LE(0, 36);
      centralHeader.writeUInt32LE(0, 38);
      centralHeader.writeUInt32LE(offset, 42);
      fileNameBuf.copy(centralHeader, 46);

      centralHeaders.push(centralHeader);

      offset += localHeader.length + compressedData.length;
      fileCount++;
    }

    const centralDirOffset = offset;
    const centralDirBuffer = Buffer.concat(centralHeaders);
    const centralDirSize = centralDirBuffer.length;

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(fileCount, 8);
    eocd.writeUInt16LE(fileCount, 10);
    eocd.writeUInt32LE(centralDirSize, 12);
    eocd.writeUInt32LE(centralDirOffset, 16);
    eocd.writeUInt16LE(0, 20);

    await writeChunk(centralDirBuffer);
    await writeChunk(eocd);

    await new Promise((resolve, reject) => {
      outStream.end(() => resolve());
      outStream.on('error', reject);
    });

    const stat = fs.statSync(destFilePath);
    return {
      totalFiles: fileCount,
      totalBytes: stat.size
    };
  } catch (err) {
    outStream.destroy();
    if (fs.existsSync(destFilePath)) {
      try { fs.unlinkSync(destFilePath); } catch (e) {}
    }
    throw err;
  }
}

module.exports = { createZipBuffer, saveCBZ, createStreamingCBZ, crc32 };

