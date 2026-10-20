import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { BIN_DIR, ROOT_DIR } from './config.js';

/**
 * yt-dlp + ffmpeg resolution for the music pipeline.
 *
 * Both tools are resolved in this order:
 *   1. an explicit user-configured path in settings / env (FFMPEG_PATH, FFMPEG_BIN)
 *   2. ./bin (populated by scripts/setup-tools.mjs) or ROOT_DIR/bin
 *   3. the bundled @ffmpeg-installer binary (ffmpeg only) or ffmpeg-static
 *   4. whatever is on the system PATH or common system directories
 *
 * yt-dlp is fetched on demand from its GitHub releases - same approach the my-tv
 * app uses - so nothing large is committed to the repo.
 */

const isWindows = process.platform === 'win32';
const ffmpegName = isWindows ? 'ffmpeg.exe' : 'ffmpeg';
const ytDlpName = isWindows ? 'yt-dlp.exe' : 'yt-dlp';

// YouTube breaks extraction every few weeks: refresh the managed yt-dlp
// binary on a timer, and immediately whenever the cached copy cannot execute.
const YTDL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

let ffmpegPath = null;
let ffmpegCheckedAt = 0;
let ytDlpPath = null;
let ytDlpPromise = null;

function ytdlpRunnable(binPath) {
  try {
    execFileSync(binPath, ['--version'], { stdio: 'ignore', timeout: 20000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function ytdlpAgeMs(binPath) {
  try {
    return Date.now() - fs.statSync(binPath).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function which(command) {
  const finder = isWindows ? 'where' : 'which';
  try {
    const result = spawnSync(finder, [command], { encoding: 'utf8' });
    if (result.status !== 0) return null;
    const first = String(result.stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    return first || null;
  } catch {
    return null;
  }
}

function fromInstaller() {
  try {
    const require = createRequire(import.meta.url);
    const mod = require('@ffmpeg-installer/ffmpeg');
    if (mod?.path) {
      const unpacked = String(mod.path).replace('app.asar', 'app.asar.unpacked');
      if (fs.existsSync(unpacked)) return unpacked;
      if (fs.existsSync(mod.path)) return mod.path;
    }
  } catch { /* not installed */ }

  try {
    const require = createRequire(import.meta.url);
    const mod = require('ffmpeg-static');
    const binPath = typeof mod === 'string' ? mod : mod?.path;
    if (binPath && fs.existsSync(binPath)) return binPath;
  } catch { /* not installed */ }

  const platform = `${process.platform}-${process.arch}`;
  const binName = isWindows ? 'ffmpeg.exe' : 'ffmpeg';
  const nodeModuleCandidates = [
    path.join(ROOT_DIR, 'node_modules', '@ffmpeg-installer', platform, binName),
    path.resolve(ROOT_DIR, '..', '..', 'node_modules', '@ffmpeg-installer', platform, binName),
    path.join(ROOT_DIR, 'node_modules', 'ffmpeg-static', binName),
    path.resolve(ROOT_DIR, '..', '..', 'node_modules', 'ffmpeg-static', binName)
  ];
  for (const cand of nodeModuleCandidates) {
    try {
      if (fs.existsSync(cand) && fs.statSync(cand).size > 0) return cand;
    } catch {}
  }

  return null;
}

/**
 * Directory holding BOTH ffmpeg and ffprobe, or null.
 *
 * yt-dlp postprocessing (`-x --audio-format mp3`) needs ffprobe as well as ffmpeg
 * and only looks for it next to the binary given via --ffmpeg-location, so a lone
 * ffmpeg (e.g. the ffprobe-less @ffmpeg-installer package) is not enough here.
 */
export function resolveFfmpegDir() {
  const dirs = [
    BIN_DIR,
    path.join(ROOT_DIR, 'bin'),
    path.resolve(ROOT_DIR, '..', '..', 'music', 'server', 'bin'),
    path.resolve(ROOT_DIR, '..', '..', 'bin'),
    process.env.FFMPEG_PATH ? path.dirname(process.env.FFMPEG_PATH) : null,
    process.env.FFMPEG_BIN ? path.dirname(process.env.FFMPEG_BIN) : null,
    which('ffmpeg') ? path.dirname(which('ffmpeg')) : null
  ].filter(Boolean);

  for (const dir of dirs) {
    try {
      if (fs.statSync(path.join(dir, ffmpegName)).size > 0
        && fs.statSync(path.join(dir, `ffprobe${isWindows ? '.exe' : ''}`)).size > 0) {
        return dir;
      }
    } catch { /* pair incomplete in this dir */ }
  }

  // If resolveFfmpeg found a binary, check if ffprobe is next to it
  const resolved = resolveFfmpeg();
  if (resolved) {
    const parent = path.dirname(resolved);
    try {
      if (fs.statSync(path.join(parent, `ffprobe${isWindows ? '.exe' : ''}`)).size > 0) {
        return parent;
      }
    } catch {}
  }

  return null;
}

/** Looks in ./bin, config candidates, npm-installed binary, then PATH. */
export function resolveFfmpeg() {
  const now = Date.now();
  if (ffmpegPath && now - ffmpegCheckedAt < 60000) return ffmpegPath;

  const candidates = [
    process.env.FFMPEG_PATH,
    process.env.FFMPEG_BIN,
    path.join(BIN_DIR, ffmpegName),
    path.join(ROOT_DIR, 'bin', ffmpegName),
    path.resolve(ROOT_DIR, '..', '..', 'music', 'server', 'bin', ffmpegName),
    path.resolve(ROOT_DIR, '..', '..', 'bin', ffmpegName),
    fromInstaller(),
    which('ffmpeg'),
    isWindows ? 'C:\\ffmpeg\\bin\\ffmpeg.exe' : null,
    isWindows ? 'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe' : null,
    isWindows ? 'C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe' : null,
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/opt/homebrew/bin/ffmpeg'
  ].filter(Boolean);

  ffmpegPath = candidates.find((candidate) => {
    try { return fs.existsSync(candidate) && fs.statSync(candidate).size > 0; } catch { return false; }
  }) || null;
  ffmpegCheckedAt = now;
  return ffmpegPath;
}

/** Downloads yt-dlp from GitHub releases the first time it is needed. */
export async function ensureYtDlp() {
  const localCandidates = [
    path.join(BIN_DIR, ytDlpName),
    path.join(ROOT_DIR, 'bin', ytDlpName),
    path.resolve(ROOT_DIR, '..', '..', 'music', 'server', 'bin', ytDlpName)
  ];
  const local = localCandidates.find((c) => {
    try { return fs.existsSync(c) && fs.statSync(c).size > 0; } catch { return false; }
  }) || path.join(BIN_DIR, ytDlpName);

  if (ytDlpPath) {
    // Re-resolve once our managed copy passes the refresh age, so a long-lived
    // server self-heals after a YouTube change instead of failing forever.
    if (ytDlpPath !== local || ytdlpAgeMs(ytDlpPath) <= YTDL_MAX_AGE_MS) return ytDlpPath;
    ytDlpPath = null;
  }
  if (ytDlpPromise) return ytDlpPromise;

  ytDlpPromise = (async () => {
    if (fs.existsSync(local)) {
      try {
        if (fs.statSync(local).size > 0) {
          if (!isWindows) fs.chmodSync(local, 0o755);
        }
      } catch { /* ignore */ }
    }
    if (fs.existsSync(local) && fs.statSync(local).size > 0) {
      const stale = ytdlpAgeMs(local) > YTDL_MAX_AGE_MS;
      const runnable = ytdlpRunnable(local);
      if (!stale && runnable) {
        ytDlpPath = local;
        return local;
      }
      if (stale && runnable) {
        try {
          const temp = `${local}.fresh`;
          const url = isWindows
            ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
            : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
          const res = await fetch(url, { redirect: 'follow' });
          if (res.ok) {
            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.length >= 100000) {
              fs.writeFileSync(temp, buf);
              if (!isWindows) fs.chmodSync(temp, 0o755);
              if (ytdlpRunnable(temp)) {
                fs.renameSync(temp, local);
              } else {
                try { fs.rmSync(temp, { force: true }); } catch (_) {}
              }
            }
          }
        } catch (_) {}
        ytDlpPath = local;
        return local;
      }
      console.warn(`[Bin] Cached yt-dlp is not runnable; refreshing…`);
      try { fs.rmSync(local, { force: true }); } catch { /* ignore */ }
    }

    // A PATH install is fine only if it actually runs.
    const system = which('yt-dlp');
    if (system && ytdlpRunnable(system)) {
      ytDlpPath = system;
      return system;
    }

    console.log('[Bin] Downloading yt-dlp…');
    fs.mkdirSync(BIN_DIR, { recursive: true });

    const url = isWindows
      ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
      : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`yt-dlp download failed (HTTP ${res.status})`);

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length < 100000) throw new Error('Downloaded yt-dlp binary looks corrupt.');

    const temp = `${local}.part`;
    fs.writeFileSync(temp, buffer);
    if (!isWindows) {
      try { fs.chmodSync(temp, 0o755); } catch (_) {}
    }
    fs.renameSync(temp, local);
    if (!isWindows) {
      try { fs.chmodSync(local, 0o755); } catch (_) {}
    }

    if (!ytdlpRunnable(local)) {
      try { fs.rmSync(local, { force: true }); } catch { /* ignore */ }
      throw new Error('Downloaded yt-dlp binary is not runnable on this system (missing dependencies?).');
    }

    ytDlpPath = local;
    console.log(`[Bin] yt-dlp ready at ${local}`);
    return local;
  })();

  try {
    return await ytDlpPromise;
  } finally {
    ytDlpPromise = null;
  }
}

/** Spawns a process and resolves with its exit code, streaming stderr for logs. */
export function runProcess(command, args, { onStdout, onStderr, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    let errBuf = '';
    child.stdout?.on('data', (chunk) => onStdout?.(chunk.toString()));
    child.stderr?.on('data', (chunk) => {
      const s = chunk.toString();
      errBuf += s;
      onStderr?.(s);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ code });
      else {
        const lines = errBuf.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        const errorLine = lines.filter((l) => /ERROR:/i.test(l)).pop();
        reject(new Error(errorLine || `${path.basename(command)} exited with code ${code}`));
      }
    });
  });
}

/** `ffmpeg -y -i in.m4b -c:a copy -metadata ... out.m4b` style helpers. */
export async function ffmpegVersion() {
  const bin = resolveFfmpeg();
  if (!bin) return null;
  try {
    const out = execFileSync(bin, ['-version'], { encoding: 'utf8', timeout: 10000 });
    return out.split(/\r?\n/)[0];
  } catch {
    return null;
  }
}

export async function ytDlpVersion() {
  try {
    const bin = await ensureYtDlp();
    const out = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 20000 });
    return out.split(/\r?\n/)[0];
  } catch {
    return null;
  }
}

export async function toolStatus() {
  const ffmpeg = resolveFfmpeg();
  const ffmpegDir = resolveFfmpegDir();
  // Only report a yt-dlp version if the binary is already present. Calling
  // ensureYtDlp() here would download it, which turns a /api/health probe into
  // a slow network call; the download belongs on first real music use.
  const existingYtDlp = ytDlpPath || which('yt-dlp') || (fs.existsSync(path.join(BIN_DIR, ytDlpName)) ? path.join(BIN_DIR, ytDlpName) : null);

  return {
    ffmpeg: { available: Boolean(ffmpeg), path: ffmpeg, version: ffmpeg ? await ffmpegVersion() : null },
    // yt-dlp needs both binaries side by side for mp3 transcoding; `setup` tells
    // the UI what the user has to do to make downloads work.
    ffprobe: {
      available: Boolean(ffmpegDir),
      path: ffmpegDir ? path.join(ffmpegDir, `ffprobe${isWindows ? '.exe' : ''}`) : null,
      setup: ffmpegDir ? null : 'Run: node scripts/setup-tools.mjs'
    },
    ytdlp: {
      available: Boolean(existingYtDlp),
      path: existingYtDlp,
      version: existingYtDlp ? await ytDlpVersion() : null
    }
  };
}

export default { resolveFfmpeg, resolveFfmpegDir, ensureYtDlp, runProcess, toolStatus, ffmpegVersion, ytDlpVersion };
