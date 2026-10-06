import https from 'https';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const publicCoresDir = path.join(rootDir, 'public', 'cores');
const publicBiosDir = path.join(rootDir, 'public', 'bios');

const CORES_TO_DOWNLOAD = [
  'fceumm_libretro.zip',
  'snes9x_libretro.zip',
  'gambatte_libretro.zip',
  'mgba_libretro.zip',
  'mednafen_pce_fast_libretro.zip',
  'genesis_plus_gx_libretro.zip',
  'gearsystem_libretro.zip',
  'picodrive_libretro.zip',
  'fbalpha2012_neogeo_libretro.zip',
  'fbneo_libretro.zip'
];

const BASE_URL = 'https://cdn.jsdelivr.net/gh/arianrhodsandlot/retroarch-emscripten-build@v1.22.2/retroarch/';

function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadBuffer(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Failed to download ${url}: HTTP ${res.statusCode}`));
      }
      const data = [];
      res.on('data', (chunk) => data.push(chunk));
      res.on('end', () => resolve(Buffer.concat(data)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function extractZip(buffer) {
  const files = [];
  let offset = 0;

  while (offset < buffer.length - 4) {
    const sig = buffer.readUInt32LE(offset);
    if (sig !== 0x04034b50) break;

    const compression = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);

    const nameStart = offset + 30;
    const fileName = buffer.toString('utf8', nameStart, nameStart + nameLen);
    const dataStart = nameStart + nameLen + extraLen;

    if (compressedSize > 0) {
      const compressedData = buffer.slice(dataStart, dataStart + compressedSize);
      let data;
      if (compression === 0) {
        data = compressedData;
      } else if (compression === 8) {
        data = zlib.inflateRawSync(compressedData);
      }
      if (data) files.push({ name: fileName, data });
    }

    offset = dataStart + compressedSize;
  }

  return files;
}

async function run() {
  if (!fs.existsSync(publicCoresDir)) fs.mkdirSync(publicCoresDir, { recursive: true });
  if (!fs.existsSync(publicBiosDir)) fs.mkdirSync(publicBiosDir, { recursive: true });

  for (const zipName of CORES_TO_DOWNLOAD) {
    const url = `${BASE_URL}${zipName}`;
    console.log(`[Cores] Downloading ${zipName}...`);
    try {
      const buffer = await downloadBuffer(url);
      const entries = extractZip(buffer);
      for (const entry of entries) {
        const base = path.basename(entry.name);
        if (base.endsWith('.js') || base.endsWith('.wasm')) {
          fs.writeFileSync(path.join(publicCoresDir, base), entry.data);
          console.log(`  -> Saved: ${base} (${(entry.data.length / 1024 / 1024).toFixed(2)} MB)`);
        }
      }
    } catch (err) {
      console.warn(`[Cores] Error downloading ${zipName}:`, err.message);
    }
  }

  const biosCandidates = [
    'https://raw.githubusercontent.com/Abdess/retroarch_system/libretro/neogeo.zip',
    'https://raw.githubusercontent.com/OpenEmu/OpenEmu-Update/master/Bios/neogeo.zip'
  ];
  for (const biosUrl of biosCandidates) {
    try {
      const buf = await downloadBuffer(biosUrl);
      if (buf.length > 100000) {
        fs.writeFileSync(path.join(publicBiosDir, 'neogeo.zip'), buf);
        fs.writeFileSync(path.join(publicCoresDir, 'neogeo.zip'), buf);
        console.log(`[BIOS] Saved neogeo.zip (${(buf.length / 1024 / 1024).toFixed(2)} MB)`);
        break;
      }
    } catch (err) {
      console.warn(`[BIOS] Failed from ${biosUrl}:`, err.message);
    }
  }

  console.log('[Cores] Done!');
}

run();
