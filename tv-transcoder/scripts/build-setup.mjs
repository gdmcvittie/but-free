import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const distElectron = path.join(root, 'dist_electron');

console.log('=======================================================');
console.log(' Building TV Transcoder Windows Setup (.exe)...');
console.log('=======================================================');

// Ensure bin/ has ffmpeg and ffprobe before packaging
const binDir = path.join(root, 'bin');
fs.mkdirSync(binDir, { recursive: true });
const ffmpegExe = path.join(binDir, 'ffmpeg.exe');
const ffprobeExe = path.join(binDir, 'ffprobe.exe');

if (!fs.existsSync(ffmpegExe)) {
  const fallbackFfmpeg = 'C:\\_code\\but-free\\node_modules\\ffmpeg-static\\ffmpeg.exe';
  if (fs.existsSync(fallbackFfmpeg)) {
    console.log('[Build] Bundling ffmpeg.exe from node_modules...');
    fs.copyFileSync(fallbackFfmpeg, ffmpegExe);
  }
}

if (!fs.existsSync(ffprobeExe)) {
  const fallbackFfprobe = 'C:\\_code\\but-free\\downloader\\bin\\ffprobe.exe';
  if (fs.existsSync(fallbackFfprobe)) {
    console.log('[Build] Bundling ffprobe.exe from downloader/bin...');
    fs.copyFileSync(fallbackFfprobe, ffprobeExe);
  }
}

// Ensure .env is present
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) {
  console.log('[Build] Bundling .env with Google OAuth configuration...');
} else {
  console.warn('[Build] WARNING: .env not found in project root!');
}

// Run electron-builder
try {
  execSync('npx electron-builder --win', { cwd: root, stdio: 'inherit' });
} catch (err) {
  console.error('[Build] electron-builder failed:', err.message);
  process.exit(1);
}

// Locate the generated setup exe
if (!fs.existsSync(distElectron)) {
  console.error('[Build] dist_electron directory not found!');
  process.exit(1);
}

const files = fs.readdirSync(distElectron);
const setupExes = files
  .filter(f => f.toLowerCase().endsWith('.exe') && !f.toLowerCase().includes('elevate'))
  .map(f => {
    const fullPath = path.join(distElectron, f);
    return { name: f, path: fullPath, size: fs.statSync(fullPath).size, mtime: fs.statSync(fullPath).mtimeMs };
  })
  .sort((a, b) => b.mtime - a.mtime);

if (setupExes.length === 0) {
  console.warn('[Build] No setup exe found in dist_electron.');
  process.exit(0);
}

const mainSetup = setupExes[0];
console.log('=======================================================');
console.log(`✓ Setup executable successfully built:`);
console.log(`  File: ${mainSetup.name}`);
console.log(`  Size: ${(mainSetup.size / 1024 / 1024).toFixed(1)} MB`);
console.log(`  Path: ${mainSetup.path}`);

// Also copy to root workspace dist/ if available
const workspaceDist = path.resolve(root, '..', 'dist');
try {
  fs.mkdirSync(workspaceDist, { recursive: true });
  const exportPath = path.join(workspaceDist, 'tv-transcoder-setup-win64.exe');
  fs.copyFileSync(mainSetup.path, exportPath);
  console.log(`  Exported: ${exportPath}`);
} catch (_) {}

console.log('=======================================================');

