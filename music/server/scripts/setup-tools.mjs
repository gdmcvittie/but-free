#!/usr/bin/env node
/**
 * Fetches the external binaries the music pipeline needs into ./bin.
 *
 *   - yt-dlp  : single .exe from its GitHub releases (also fetched on demand by
 *               server/binManager.js, but running this keeps things explicit).
 *   - ffmpeg  : required for `-x --audio-format mp3`.
 *   - ffprobe : yt-dlp shells out to ffprobe for postprocessing and refuses to
 *               transcode without it, so it has to be installed alongside ffmpeg.
 *
 * Only the two .exe files are extracted - the full archive is ~190MB but the
 * binaries we keep are a fraction of that and nothing large is committed.
 *
 * Usage: node scripts/setup-tools.mjs [--force] [--skip-ytdlp]
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN_DIR = path.join(ROOT, 'bin');
const UA = 'fraudio-setup-tools';

const force = process.argv.includes('--force');
const skipYtDlp = process.argv.includes('--skip-ytdlp');

const isWindows = process.platform === 'win32';
const EXE = isWindows ? '.exe' : '';

function log(...args) {
  console.log('[setup-tools]', ...args);
}

async function download(url, dest, label) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') || 0);
  const tmp = `${dest}.part`;

  const out = fs.createWriteStream(tmp);
  let seen = 0;
  let lastPct = -1;

  for await (const chunk of res.body) {
    seen += chunk.length;
    out.write(chunk);
    if (total) {
      const pct = Math.floor((seen / total) * 100);
      if (pct >= lastPct + 10) {
        lastPct = pct;
        process.stdout.write(`\r[setup-tools] ${label}: ${pct}%   `);
      }
    }
  }
  out.end();
  await new Promise((resolve, reject) => {
    out.on('finish', resolve);
    out.on('error', reject);
  });
  fs.renameSync(tmp, dest);
  process.stdout.write('\n');
  return seen;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

async function ensureYtDlp() {
  const dest = path.join(BIN_DIR, `yt-dlp${EXE}`);
  if (!force && fs.existsSync(dest)) {
    log('yt-dlp already present');
    return;
  }

  const release = await fetch('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest', {
    headers: { 'User-Agent': UA }
  }).then((r) => r.json());

  const asset = release.assets?.find((a) => a.name === `yt-dlp${EXE}`);
  if (!asset) throw new Error('Could not find a yt-dlp release asset for this platform.');

  log(`downloading yt-dlp ${release.tag_name}`);
  await download(asset.browser_download_url, dest, 'yt-dlp');
  if (isWindows) fs.chmodSync(dest, 0o755);
}

/**
 * ffmpeg + ffprobe as a matched pair from one archive. Both come from the same
 * static build so their versions line up, which is what yt-dlp expects when given
 * a single --ffmpeg-location.
 */
async function ensureFfmpeg() {
  const targets = ['ffmpeg', 'ffprobe'];
  const missing = targets.filter((name) => force || !fs.existsSync(path.join(BIN_DIR, `${name}${EXE}`)));
  if (!missing.length) {
    log('ffmpeg + ffprobe already present');
    return;
  }

  const platform = process.platform === 'darwin' ? 'osx' : process.platform === 'linux' ? 'linux' : 'win';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const asset = isWindows ? 'ffmpeg-master-latest-win64-gpl.zip' : `ffmpeg-master-latest-${platform}${arch === 'arm64' ? '-arm64' : ''}.tar.xz`;

  const release = await fetch('https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest', {
    headers: { 'User-Agent': UA }
  }).then((r) => r.json());

  const file = release.assets?.find((a) => a.name === asset);
  if (!file) throw new Error(`Could not find a static ffmpeg build "${asset}" for ${platform}/${arch}.`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fraudio-ffmpeg-'));
  const archive = path.join(tmpDir, asset);

  try {
    log(`downloading ${asset} (${(file.size / 1048576).toFixed(1)}MB)`);
    await download(file.browser_download_url, archive, 'ffmpeg build');

    if (isWindows) {
      // .NET is present on any Windows box with PowerShell 5+, so Expand-Archive is
      // the one unzip path we can rely on without another dependency.
      await run('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${tmpDir}\\x' -Force`]);
    } else {
      await run('tar', ['-xf', archive, '-C', tmpDir]);
    }

    for (const name of missing) {
      const found = findBinary(tmpDir, name);
      if (!found) throw new Error(`${name} was not present in the downloaded archive.`);
      const dest = path.join(BIN_DIR, `${name}${EXE}`);
      fs.copyFileSync(found, dest);
      if (!isWindows) fs.chmodSync(dest, 0o755);
      log(`installed ${name} -> ${path.relative(ROOT, dest)}`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function findBinary(dir, name) {
  const want = `${name}${EXE}`.toLowerCase();
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.toLowerCase() === want) return full;
    }
  }
  return null;
}

fs.mkdirSync(BIN_DIR, { recursive: true });

if (!skipYtDlp) await ensureYtDlp();
await ensureFfmpeg();

log('done - run `npm run tools:check` to verify');