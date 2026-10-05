import fs from 'fs';
import path from 'path';
import { spawn, execSync, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_DIR = path.resolve(process.env.BIN_DIR || path.join(__dirname, 'bin'));

const isWindows = process.platform === 'win32';
const ytDlpName = isWindows ? 'yt-dlp.exe' : 'yt-dlp';
const ffmpegName = isWindows ? 'ffmpeg.exe' : 'ffmpeg';
const ffprobeName = isWindows ? 'ffprobe.exe' : 'ffprobe';

// YouTube churns yt-dlp every few weeks; a binary that never updates is a
// download outage waiting to happen, so refresh on a timer and re-fetch
// immediately whenever the cached copy cannot actually execute.
const YTDL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

let ytDlpPath = null;
let ytDlpPromise = null;
let ffmpegDir = null;
let ffmpegChecked = false;

function which(cmd) {
  try {
    const probe = isWindows ? `where ${cmd}` : `which ${cmd}`;
    const out = execSync(probe, { stdio: ['pipe', 'pipe', 'ignore'], timeout: 3000 })
      .toString()
      .split(/\r?\n/)[0]
      ?.trim();
    if (out && fs.existsSync(out)) return out;
  } catch {
    /* not in PATH */
  }
  return null;
}

function hasFfmpegPair(dir) {
  if (!dir) return false;
  try {
    const f1 = path.join(dir, ffmpegName);
    const f2 = path.join(dir, ffprobeName);
    return fs.existsSync(f1) && fs.statSync(f1).size > 0 && fs.existsSync(f2) && fs.statSync(f2).size > 0;
  } catch {
    return false;
  }
}

export function resolveFfmpegDir() {
  if (ffmpegChecked) return ffmpegDir;
  ffmpegChecked = true;

  if (process.env.FFMPEG_DIR && hasFfmpegPair(process.env.FFMPEG_DIR)) {
    ffmpegDir = path.resolve(process.env.FFMPEG_DIR);
    return ffmpegDir;
  }

  // 1. Prefer a directory with BOTH ffmpeg and ffprobe so yt-dlp transcoding works
  if (hasFfmpegPair(BIN_DIR)) {
    ffmpegDir = BIN_DIR;
    return ffmpegDir;
  }

  const systemFfmpeg = which('ffmpeg');
  if (systemFfmpeg) {
    const sysDir = path.dirname(systemFfmpeg);
    if (hasFfmpegPair(sysDir)) {
      ffmpegDir = sysDir;
      return ffmpegDir;
    }
  }

  // 2. Fall back to lone ffmpeg if no pair found
  if (fs.existsSync(path.join(BIN_DIR, ffmpegName))) {
    ffmpegDir = BIN_DIR;
    return ffmpegDir;
  }

  if (systemFfmpeg) {
    ffmpegDir = path.dirname(systemFfmpeg);
    return ffmpegDir;
  }

  return null;
}

export function getCookiesFile() {
  const envPath = (process.env.YOUTUBE_COOKIES_FILE || '').trim();
  if (envPath) {
    const resolved = path.isAbsolute(envPath) ? envPath : path.resolve(envPath);
    if (fs.existsSync(resolved)) return resolved;
  }

  const candidates = [
    path.join(__dirname, 'cookies.txt'),
    path.resolve('./cookies.txt'),
    path.resolve('./downloads/cookies.txt')
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

export function isRunnable(binPath) {
  if (!binPath || !fs.existsSync(binPath)) return false;
  if (!isWindows) {
    try { fs.chmodSync(binPath, 0o755); } catch (_) {}
  }
  try {
    if (isWindows) {
      execFileSync(binPath, ['--version'], { stdio: 'ignore', timeout: 20000, windowsHide: true });
    } else {
      execSync(`${binPath} --version`, { stdio: ['ignore', 'ignore', 'ignore'], timeout: 20000 });
    }
    return true;
  } catch {
    if (!isWindows) {
      try {
        execSync(`python3 "${binPath}" --version`, { stdio: ['ignore', 'ignore', 'ignore'], timeout: 20000 });
        return true;
      } catch {}
    }
    return false;
  }
}

function ageMs(filePath) {
  try {
    return Date.now() - fs.statSync(filePath).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Downloads the current yt-dlp standalone binary into `dest`. */
async function downloadYtDlp(dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  console.log('[FraudioStreamer] Downloading yt-dlp binary from GitHub...');
  const url = isWindows
    ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
    : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`yt-dlp binary download failed (HTTP ${res.status})`);

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < 100000) throw new Error('Downloaded yt-dlp binary looks incomplete or corrupt.');

  const temp = `${dest}.part`;
  fs.writeFileSync(temp, buffer);
  if (!isWindows) {
    try { fs.chmodSync(temp, 0o755); } catch (_) {}
  }
  fs.renameSync(temp, dest);
  if (!isWindows) {
    try { fs.chmodSync(dest, 0o755); } catch (_) {}
  }
}

export async function ensureYtDlp() {
  const local = path.join(BIN_DIR, ytDlpName);
  if (ytDlpPath && fs.existsSync(ytDlpPath)) {
    // Expire the in-memory cache for our own copy too, so a long-running
    // process still picks up the 7-day refresh without a restart.
    if (ytDlpPath !== local || ageMs(ytDlpPath) <= YTDL_MAX_AGE_MS) return ytDlpPath;
    ytDlpPath = null;
  }
  if (ytDlpPromise) return ytDlpPromise;

  ytDlpPromise = (async () => {
    // 1. Use the cached local binary if runnable.
    if (fs.existsSync(local)) {
      if (!isWindows) {
        try { fs.chmodSync(local, 0o755); } catch (_) {}
      }
      const runnable = isRunnable(local);
      const stale = ageMs(local) > YTDL_MAX_AGE_MS;

      // If fresh and runnable, use it immediately
      if (!stale && runnable) {
        ytDlpPath = local;
        return local;
      }

      // If runnable but stale, attempt a safe background refresh without deleting the working binary
      if (stale && runnable) {
        try {
          const temp = `${local}.fresh`;
          await downloadYtDlp(temp);
          if (isRunnable(temp)) {
            fs.renameSync(temp, local);
            console.log('[FraudioStreamer] Refreshed yt-dlp binary to latest version');
          } else {
            try { fs.rmSync(temp, { force: true }); } catch (_) {}
            console.warn('[FraudioStreamer] Downloaded yt-dlp update was not runnable; retaining current working binary');
          }
        } catch (err) {
          console.warn('[FraudioStreamer] Failed to refresh yt-dlp from GitHub; retaining current working binary:', err.message);
        }
        ytDlpPath = local;
        return local;
      }

      // If local exists but cannot run, remove it so we can re-download
      console.warn('[FraudioStreamer] Cached yt-dlp is not runnable; refreshing…');
      try { fs.rmSync(local, { force: true }); } catch (_) {}
    }

    // 2. Fall back to a PATH install if it runs.
    const system = which('yt-dlp');
    if (system && isRunnable(system)) {
      ytDlpPath = system;
      return system;
    }

    // 3. Download the current release (fresh, since any cached copy failed).
    await downloadYtDlp(local);
    if (!isRunnable(local)) {
      try { fs.rmSync(local, { force: true }); } catch (_) {}
      throw new Error('Downloaded yt-dlp binary is not runnable on this system (missing dependencies?).');
    }

    ytDlpPath = local;
    console.log(`[FraudioStreamer] yt-dlp installed and ready at ${local}`);
    return local;
  })();

  try {
    return await ytDlpPromise;
  } finally {
    ytDlpPromise = null;
  }
}

export function runProcess(command, args, { cwd = process.cwd(), timeoutMs = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGTERM'); } catch (_) {}
      reject(new Error(`Process timed out after ${timeoutMs}ms: ${command}`));
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return;
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const allText = (stderr || stdout || '').trim();
        const lines = allText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        const errorLine = lines.filter((l) => /ERROR:/i.test(l)).pop();
        const msg = errorLine || lines.slice(-4).join(' ') || `Process exited with code ${code}`;
        reject(new Error(msg));
      }
    });
  });
}

/**
 * On a VPS / datacenter IP, anonymous requests to YouTube are routinely
 * blocked or bot-challenged, while valid cookies allow reliable extraction.
 * Try with cookies first when available, falling back to anonymous if cookies fail.
 */
const AUTH_SUSPECT_RE = /sign in|not a bot|cookies|age|private|login|premium|authentication|account|requested format is not available|http error 4(?:03|29)|video unavailable/i;

async function runWithAuthFallback(bin, args, cookies, runOpts) {
  if (!cookies) return runProcess(bin, args, runOpts);
  let lastErr = null;
  for (const useCookies of [true, false]) {
    try {
      return await runProcess(bin, useCookies ? [...args, '--cookies', cookies] : args, runOpts);
    } catch (err) {
      lastErr = err;
      console.warn(`[FraudioStreamer] yt-dlp attempt (useCookies=${useCookies}) failed:`, err.message);
      if (!useCookies && !AUTH_SUSPECT_RE.test(err.message || '')) break;
    }
  }
  throw lastErr;
}

let cachedYtdlpVersion;
let versionCheckedAt = 0;

export function ytDlpVersion() {
  if (cachedYtdlpVersion !== undefined && Date.now() - versionCheckedAt < 60000) return cachedYtdlpVersion;
  const fallback = ytDlpPath || which('yt-dlp') || (fs.existsSync(path.join(BIN_DIR, ytDlpName)) ? path.join(BIN_DIR, ytDlpName) : null);
  versionCheckedAt = Date.now();
  try {
    cachedYtdlpVersion = fallback
      ? execSync(isWindows ? `"${fallback}" --version` : `${fallback} --version`, { timeout: 15000 }).toString().trim()
      : null;
  } catch {
    cachedYtdlpVersion = null;
  }
  return cachedYtdlpVersion;
}

/**
 * Downloads a single YouTube audio track and embeds metadata/thumbnail.
 */
export async function downloadYoutubeTrack(entry, options = {}) {
  const bin = await ensureYtDlp();
  const ffmpeg = resolveFfmpegDir();
  const cookies = getCookiesFile();

  const destDir = options.destDir || path.resolve('./downloads/staging');
  fs.mkdirSync(destDir, { recursive: true });

  const format = options.format || 'mp3';
  const quality = options.quality === '320' ? '0' : (options.quality || '0');

  const args = [
    '--no-playlist',
    '--no-warnings',
    '--retries', '3',
    '--no-check-certificates',
    '--no-cache-dir',
    '--extract-audio',
    '--audio-format', format,
    '--audio-quality', quality,
    '--embed-metadata',
    '--embed-thumbnail',
    '--convert-thumbnails', 'jpg',
    // android client bypasses the web PO-token / bot check for audio streams on datacenter IPs
    '--extractor-args', 'youtube:player_client=android,web',
    '-o', path.join(destDir, '%(title)s.%(ext)s')
  ];

  if (ffmpeg) {
    args.push('--ffmpeg-location', ffmpeg);
  }

  const url = `https://www.youtube.com/watch?v=${encodeURIComponent(entry.videoId)}`;
  args.push(url);

  console.log(`[FraudioStreamer] yt-dlp downloading: ${entry.title || entry.videoId} (${format})`);
  await runWithAuthFallback(bin, args, cookies, { cwd: destDir, timeoutMs: 300000 });

  // Locate the downloaded audio file
  const files = fs.readdirSync(destDir).filter((f) => {
    const ext = path.extname(f).toLowerCase();
    return ['.mp3', '.m4a', '.opus', '.ogg', '.flac', '.aac'].includes(ext);
  });

  if (!files.length) {
    throw new Error(`yt-dlp finished but no audio file found in ${destDir}`);
  }

  const downloadedName = files[0];
  const localPath = path.join(destDir, downloadedName);
  return {
    localPath,
    fileName: downloadedName,
    ext: path.extname(downloadedName).slice(1).toLowerCase()
  };
}

/**
 * Retrieves track listing for an album auto-playlist or regular playlist.
 */
export async function getPlaylistTracks(playlistId) {
  const bin = await ensureYtDlp();
  const cookies = getCookiesFile();
  const url = `https://music.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`;

  const args = ['--flat-playlist', '-J', '--no-warnings'];
  args.push(url);

  const { stdout } = await runWithAuthFallback(bin, args, cookies, { timeoutMs: 60000 });
  const jsonStr = stdout.slice(stdout.indexOf('{'));
  const data = JSON.parse(jsonStr);

  const entries = (Array.isArray(data.entries) ? data.entries : []).map((e, idx) => ({
    videoId: e.id,
    title: e.title || `Track ${idx + 1}`,
    durationSec: Number.isFinite(e.duration) ? Math.round(e.duration) : null,
    trackNumber: idx + 1,
    thumbnail: Array.isArray(e.thumbnails) ? e.thumbnails[e.thumbnails.length - 1]?.url : null
  })).filter((e) => e.videoId && !/^\d+$/.test(e.videoId));

  return {
    playlistId,
    title: data.title || '',
    count: entries.length,
    tracks: entries
  };
}

export function toolsStatus() {
  const cookies = getCookiesFile();
  const ffmpeg = resolveFfmpegDir();
  return {
    ytDlpAvailable: Boolean(ytDlpPath || which('yt-dlp') || fs.existsSync(path.join(BIN_DIR, ytDlpName))),
    ytdlpVersion: ytDlpVersion(),
    ffmpegAvailable: Boolean(ffmpeg),
    ffprobeAvailable: Boolean(ffmpeg && hasFfmpegPair(ffmpeg)),
    ffmpegDir: ffmpeg,
    cookiesFound: Boolean(cookies),
    cookiesPath: cookies ? path.basename(cookies) : null
  };
}
