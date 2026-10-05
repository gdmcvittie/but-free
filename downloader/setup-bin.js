import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_DIR = path.join(__dirname, 'bin');
const isWindows = process.platform === 'win32';
const EXE = isWindows ? '.exe' : '';

async function setup() {
  fs.mkdirSync(BIN_DIR, { recursive: true });

  // 1. ffmpeg & ffprobe from npm packages
  try {
    const ffmpegPkg = await import('@ffmpeg-installer/ffmpeg');
    const ffprobePkg = await import('@ffprobe-installer/ffprobe');

    const ffmpegSrc = ffmpegPkg.default?.path || ffmpegPkg.path;
    const ffprobeSrc = ffprobePkg.default?.path || ffprobePkg.path;

    if (ffmpegSrc && fs.existsSync(ffmpegSrc)) {
      const destFfmpeg = path.join(BIN_DIR, `ffmpeg${EXE}`);
      if (!fs.existsSync(destFfmpeg) || fs.statSync(destFfmpeg).size === 0) {
        fs.copyFileSync(ffmpegSrc, destFfmpeg);
        console.log(`[setup-bin] Copied ffmpeg to ${destFfmpeg}`);
      }
      if (!isWindows && fs.existsSync(destFfmpeg)) {
        try { fs.chmodSync(destFfmpeg, 0o755); } catch (_) {}
      }
    }

    if (ffprobeSrc && fs.existsSync(ffprobeSrc)) {
      const destFfprobe = path.join(BIN_DIR, `ffprobe${EXE}`);
      if (!fs.existsSync(destFfprobe) || fs.statSync(destFfprobe).size === 0) {
        fs.copyFileSync(ffprobeSrc, destFfprobe);
        console.log(`[setup-bin] Copied ffprobe to ${destFfprobe}`);
      }
      if (!isWindows && fs.existsSync(destFfprobe)) {
        try { fs.chmodSync(destFfprobe, 0o755); } catch (_) {}
      }
    }
  } catch (err) {
    console.warn('[setup-bin] Notice: ffmpeg npm packages not found or could not be copied:', err.message);
  }

  // 2. yt-dlp binary
  const destYt = path.join(BIN_DIR, `yt-dlp${EXE}`);
  if (!fs.existsSync(destYt) || fs.statSync(destYt).size < 100000) {
    console.log('[setup-bin] Downloading latest yt-dlp binary...');
    const url = isWindows
      ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
      : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`Failed to download yt-dlp: HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(destYt, buffer);
    if (!isWindows) fs.chmodSync(destYt, 0o755);
    console.log(`[setup-bin] Installed yt-dlp at ${destYt}`);
  } else {
    console.log(`[setup-bin] yt-dlp already present at ${destYt}`);
  }

  console.log('[setup-bin] Tools setup complete!');
}

setup().catch((err) => {
  console.warn('[setup-bin] Warning during setup:', err.message);
});
