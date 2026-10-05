import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

console.log('╔══════════════════════════════════════════════════════════════════╗');
console.log('║        butfree.online - Monorepo File Migration Tool            ║');
console.log('╚══════════════════════════════════════════════════════════════════╝\n');

// Exclusion filters to keep repos clean
const EXCLUDE_NAMES = new Set([
  'node_modules',
  '.git',
  '.gradle',
  'dist',
  'dist_electron',
  'build',
  '.idea',
  '.vscode',
  'server.log',
  'stderr.log',
  'java_pid31208.hprof'
]);

function shouldCopy(src) {
  const base = path.basename(src);
  if (EXCLUDE_NAMES.has(base)) return false;
  if (base.endsWith('.hprof')) return false;
  if (base.endsWith('.log') && base !== 'package-lock.json') return false;
  return true;
}

function copyDirectory(src, dst, extraExclude = []) {
  if (!fs.existsSync(src)) {
    console.warn(`[WARN] Source directory not found: ${src}`);
    return 0;
  }
  fs.mkdirSync(dst, { recursive: true });

  let fileCount = 0;
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);

    if (!shouldCopy(srcPath)) continue;
    if (extraExclude.includes(entry.name)) continue;

    if (entry.isDirectory()) {
      fileCount += copyDirectory(srcPath, dstPath, extraExclude);
    } else {
      fs.copyFileSync(srcPath, dstPath);
      fileCount++;
    }
  }
  return fileCount;
}

const TASKS = [
  {
    name: 'Comics Cloud Server (comixolofree)',
    src: 'C:\\_code\\free-comics\\cloud-server',
    dst: path.join(root, 'comics', 'server'),
    extraExclude: []
  },
  {
    name: 'Comics Mobile App (comixolofree)',
    src: 'C:\\_code\\free-comics\\mobile-client',
    dst: path.join(root, 'comics', 'android'),
    extraExclude: []
  },
  {
    name: 'Music & Audiobooks Server (fraudio)',
    src: 'C:\\_code\\fraudio',
    dst: path.join(root, 'music', 'server'),
    extraExclude: ['mobile-client', 'fraudio-streamer']
  },
  {
    name: 'Music Mobile App (fraudio)',
    src: 'C:\\_code\\fraudio\\mobile-client',
    dst: path.join(root, 'music', 'android'),
    extraExclude: []
  },
  {
    name: 'TV & Movies Server (freevee)',
    src: 'C:\\_code\\___MY-TV\\cloud-only\\server',
    dst: path.join(root, 'tv', 'server'),
    extraExclude: []
  },
  {
    name: 'TV Roku App (freevee)',
    src: 'C:\\_code\\___MY-TV\\cloud-only\\tvs\\roku',
    dst: path.join(root, 'tv', 'roku'),
    extraExclude: []
  },
  {
    name: 'TV FireTV App (freevee)',
    src: 'C:\\_code\\___MY-TV\\cloud-only\\tvs\\firetv',
    dst: path.join(root, 'tv', 'firetv'),
    extraExclude: []
  }
];

let totalCopied = 0;

for (const task of TASKS) {
  console.log(`Copying ${task.name}...`);
  console.log(`  Source: ${task.src}`);
  console.log(`  Dest:   ${task.dst}`);
  const count = copyDirectory(task.src, task.dst, task.extraExclude);
  console.log(`  ✓ Copied ${count} files.\n`);
  totalCopied += count;
}

// Android Toolchain Setup
console.log('Configuring Android Toolchain...');
const toolchainSrc = 'C:\\_code\\___MY-TV\\my-tv\\toolchain';
const toolchainDst = path.join(root, 'toolchain');

let isToolchainEmpty = false;
if (fs.existsSync(toolchainDst)) {
  const files = fs.readdirSync(toolchainDst);
  if (files.length === 0) {
    fs.rmdirSync(toolchainDst);
    isToolchainEmpty = true;
  }
}

if (!fs.existsSync(toolchainDst) || isToolchainEmpty) {
  try {
    // Attempt junction first (instant, 0 disk waste)
    fs.symlinkSync(toolchainSrc, toolchainDst, 'junction');
    console.log(`  ✓ Linked Android toolchain via NTFS junction: ${toolchainDst} -> ${toolchainSrc}\n`);
  } catch (err) {
    console.log(`  [INFO] Junction failed (${err.message}). Copying toolchain files directly...`);
    const count = copyDirectory(toolchainSrc, toolchainDst);
    console.log(`  ✓ Copied ${count} toolchain files.\n`);
  }
} else {
  console.log(`  ✓ Toolchain directory already configured at ${toolchainDst}\n`);
}

// Shared Downloader Setup
console.log('Setting up Combined Downloader App (/downloader)...');
const downloaderDst = path.join(root, 'downloader');
fs.mkdirSync(downloaderDst, { recursive: true });

const tvStreamerSrc = 'C:\\_code\\___MY-TV\\cloud-only\\torrent-streamer';
const musicStreamerSrc = 'C:\\_code\\fraudio\\fraudio-streamer';

if (!fs.existsSync(path.join(downloaderDst, 'tvDownloadManager.js'))) {
  copyDirectory(tvStreamerSrc, downloaderDst);
  copyDirectory(musicStreamerSrc, downloaderDst);
  console.log(`  ✓ Consolidated torrent, audio, and video downloader into /downloader.\n`);
} else {
  console.log(`  ✓ Combined Downloader (/downloader) already configured.\n`);
}

// Post-Migration Path and Branding Adjustments
console.log('Applying Monorepo Branding and Toolchain Path Patches...');

// 1. Patch comics/android/build.bat
const comicsBat = path.join(root, 'comics', 'android', 'build.bat');
if (fs.existsSync(comicsBat)) {
  let content = fs.readFileSync(comicsBat, 'utf-8');
  content = content.replace(
    'set "TOOLCHAIN=C:\\_code\\___MY-TV\\my-tv\\toolchain"',
    'if not defined TOOLCHAIN set "TOOLCHAIN=%~dp0..\\..\\toolchain"\r\nif not exist "%TOOLCHAIN%" set "TOOLCHAIN=C:\\_code\\___MY-TV\\my-tv\\toolchain"'
  );
  fs.writeFileSync(comicsBat, content, 'utf-8');
  console.log('  ✓ Patched comics/android/build.bat to use monorepo toolchain.');
}

// 2. Patch music/android/build.bat
const musicBat = path.join(root, 'music', 'android', 'build.bat');
if (fs.existsSync(musicBat)) {
  let content = fs.readFileSync(musicBat, 'utf-8');
  content = content.replace(
    'set "TOOLCHAIN=C:\\_code\\___MY-TV\\my-tv\\toolchain"',
    'if not defined TOOLCHAIN set "TOOLCHAIN=%~dp0..\\..\\toolchain"\r\nif not exist "%TOOLCHAIN%" set "TOOLCHAIN=C:\\_code\\___MY-TV\\my-tv\\toolchain"'
  );
  fs.writeFileSync(musicBat, content, 'utf-8');
  console.log('  ✓ Patched music/android/build.bat to use monorepo toolchain.');
}

// 3. Patch tv/firetv build scripts
const fireTvBuildJs = path.join(root, 'tv', 'firetv', 'scripts', 'build-firetv.js');
if (fs.existsSync(fireTvBuildJs)) {
  let content = fs.readFileSync(fireTvBuildJs, 'utf-8');
  content = content.replace(
    "const DEFAULT_TOOLCHAIN_DIR = 'C:\\\\_code\\\\___MY-TV\\\\my-tv\\\\toolchain';",
    "const DEFAULT_TOOLCHAIN_DIR = path.resolve(__dirname, '../../../toolchain');"
  );
  fs.writeFileSync(fireTvBuildJs, content, 'utf-8');
  console.log('  ✓ Patched tv/firetv build scripts to use monorepo toolchain.');
}

console.log('\n══════════════════════════════════════════════════════════════════');
console.log(`✓ Monorepo migration complete! Total files processed: ${totalCopied}`);
console.log('══════════════════════════════════════════════════════════════════\n');

