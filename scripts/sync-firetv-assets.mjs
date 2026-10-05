import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

const firetvDist = path.join(root, 'tv', 'firetv', 'dist');
const firetvAssets = path.join(root, 'tv', 'firetv', 'android', 'app', 'src', 'main', 'assets');
const tvServerPublicFiretv = path.join(root, 'tv', 'server', 'public', 'firetv');
const tvServerDistFiretv = path.join(root, 'tv', 'server', 'dist', 'firetv');

function copyClean(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const sp = path.join(src, entry.name);
    const dp = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyClean(sp, dp);
    } else {
      fs.copyFileSync(sp, dp);
    }
  }
}

// Clean old assets folder in android
const assetsSubdir = path.join(firetvAssets, 'assets');
if (fs.existsSync(assetsSubdir)) {
  fs.rmSync(assetsSubdir, { recursive: true, force: true });
}

copyClean(firetvDist, firetvAssets);
console.log('Copied tv/firetv/dist -> tv/firetv/android/app/src/main/assets');

copyClean(firetvDist, tvServerPublicFiretv);
console.log('Copied tv/firetv/dist -> tv/server/public/firetv');

copyClean(firetvDist, tvServerDistFiretv);
console.log('Copied tv/firetv/dist -> tv/server/dist/firetv');
