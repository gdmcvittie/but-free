#!/usr/bin/env node
// Downloads the static FFmpeg Linux x64 binary and bundles it into cloud/bin
// so Drive-HLS transcoding works on the server regardless of whether system
// ffmpeg is installed or npm postinstall scripts are enabled.
//
// The cloud app's .npmrc sets ignore-scripts=true, which skips ffmpeg-static's
// install script and leaves it without a binary. This downloads the same
// binary (release b6.1.1) directly from the ffmpeg-static GitHub releases.
import fs from 'fs';
import path from 'path';
import https from 'https';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const binDir = path.join(__dirname, '..', 'bin');
// The downloaded binary is always the Linux x64 build (that's what the cloud
// server runs), so always name it "ffmpeg" even when run on Windows for bundling.
const binPath = path.join(binDir, 'ffmpeg');

// Mirrors the binary ffmpeg-static v5.3.0 would download for Linux x64.
const DEFAULT_URL = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-linux-x64';

async function download(url, dest) {
  const res = await new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'FREEVEE-cloud-installer' } }, resolve);
    req.on('error', reject);
  });
  if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
    res.resume();
    return download(res.headers.location, dest);
  }
  if (res.statusCode !== 200) {
    throw new Error(`Download failed: HTTP ${res.statusCode} for ${url}`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    res.pipe(file);
    file.on('finish', resolve);
    file.on('error', reject);
    res.on('error', reject);
  });
}

function isValidBinary(bin) {
  try {
    const out = execFileSync(bin, ['-version'], { stdio: 'pipe', timeout: 15000 }).toString().toLowerCase();
    return out.includes('ffmpeg');
  } catch {
    return false;
  }
}

async function main() {
  const envBin = process.env.FFMPEG_BIN;
  if (envBin && fs.existsSync(envBin) && isValidBinary(envBin)) {
    console.log(`[FFmpeg] Using FFMPEG_BIN=${envBin}`);
    return;
  }
  if (fs.existsSync(binPath) && isValidBinary(binPath)) {
    console.log(`[FFmpeg] Already installed: ${binPath}`);
    return;
  }
  console.log(`[FFmpeg] Downloading static ffmpeg -> ${binPath}`);
  await download(DEFAULT_URL, binPath);
  try { fs.chmodSync(binPath, 0o755); } catch {}
  if (isValidBinary(binPath)) {
    console.log(`[FFmpeg] Installed: ${binPath}`);
  } else {
    console.warn(`[FFmpeg] Wrote ${binPath} but could not verify it here (downloaded the Linux binary)`);
  }
}

main().catch((err) => {
  console.error('[FFmpeg] Install failed:', err.message);
  process.exit(1);
});