import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

const tvRokuDir = path.join(root, 'tv', 'roku');
const tvServerDir = path.join(root, 'tv', 'server');
const apksDistDir = path.join(root, 'dist', 'apks');

fs.mkdirSync(apksDistDir, { recursive: true });

const rokuZipPath = path.join(apksDistDir, 'roku.zip');
const zip = new AdmZip();

// Add all files from tv/roku preserving relative posix paths
const entries = fs.readdirSync(tvRokuDir, { withFileTypes: true });
for (const entry of entries) {
  const fullPath = path.join(tvRokuDir, entry.name);
  if (entry.isDirectory()) {
    if (entry.name !== '.git' && entry.name !== 'node_modules') {
      zip.addLocalFolder(fullPath, entry.name);
    }
  } else if (entry.isFile()) {
    const lower = entry.name.toLowerCase();
    if (!lower.endsWith('.zip') && !lower.endsWith('.tmp') && lower !== 'readme.md' && lower !== '.ds_store') {
      zip.addLocalFile(fullPath);
    }
  }
}

zip.writeZip(rokuZipPath);

const srvRoku = path.join(tvServerDir, 'public', 'roku.zip');
fs.mkdirSync(path.dirname(srvRoku), { recursive: true });
fs.copyFileSync(rokuZipPath, srvRoku);

const tvDownloadsDir = path.join(tvServerDir, 'public', 'tv', 'downloads');
fs.mkdirSync(tvDownloadsDir, { recursive: true });
fs.copyFileSync(rokuZipPath, path.join(tvDownloadsDir, 'roku.zip'));
fs.copyFileSync(rokuZipPath, path.join(tvDownloadsDir, 'roku-cloud-app.zip'));

console.log(`✓ Successfully packaged roku.zip (${(fs.statSync(rokuZipPath).size / 1024).toFixed(1)} KB) to dist/apks/ and tv/server/public/`);
