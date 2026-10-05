import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

let ffmpegCmd = null;

export function resolveFfmpeg() {
  if (ffmpegCmd) return ffmpegCmd;
  const candidates = [];
  try {
    const ffmpegStatic = require('ffmpeg-static');
    if (ffmpegStatic && fs.existsSync(ffmpegStatic)) candidates.push(ffmpegStatic);
  } catch (_) {}
  candidates.push('ffmpeg');

  for (const c of candidates) {
    try {
      if (c === 'ffmpeg') {
        ffmpegCmd = 'ffmpeg';
        return ffmpegCmd;
      }
      if (fs.existsSync(c)) {
        if (process.platform !== 'win32') {
          try { fs.chmodSync(c, 0o755); } catch (_) {}
        }
        ffmpegCmd = c;
        return c;
      }
    } catch (_) {}
  }
  ffmpegCmd = 'ffmpeg';
  return ffmpegCmd;
}

export async function getMediaDuration(filePath) {
  return new Promise((resolve) => {
    const cmd = resolveFfmpeg();
    const probe = spawn(cmd, ['-i', filePath]);
    let stderr = '';
    probe.stderr.on('data', d => { stderr += d.toString(); });
    probe.on('close', () => {
      const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (m) {
        resolve(parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]));
      } else {
        resolve(0);
      }
    });
    probe.on('error', () => resolve(0));
  });
}

export async function getVideoHeight(filePath) {
  return new Promise((resolve) => {
    try {
      const cmd = resolveFfmpeg();
      const probe = spawn(cmd, ['-i', filePath]);
      let stderr = '';
      probe.stderr.on('data', d => { stderr += d.toString(); });
      probe.on('close', () => {
        const m = stderr.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
        if (m) {
          resolve(parseInt(m[2], 10));
        } else {
          resolve(0);
        }
      });
      probe.on('error', () => resolve(0));
    } catch (_) {
      resolve(0);
    }
  });
}

export async function transcodeMediaFile(filePath, targetOutputPath, options = {}, onProgress = null) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`Source file does not exist: ${filePath}`);
  }

  const heightOpt = String(options.targetHeight || '480');
  let scaleFilter = null;
  let targetHeight = null;
  if (/^\d+$/.test(heightOpt)) {
    targetHeight = parseInt(heightOpt, 10);
    scaleFilter = `scale=w=-2:h=${targetHeight}:force_original_aspect_ratio=decrease:flags=lanczos,pad=ceil(iw/2)*2:ceil(ih/2)*2`;
  }

  // Skip transcode if source is already at or below target resolution
  if (targetHeight && options.force !== true) {
    const sourceHeight = await getVideoHeight(filePath);
    const ext = path.extname(filePath).toLowerCase();
    if (sourceHeight > 0 && sourceHeight <= targetHeight && ext === '.mp4') {
      console.log(`[Transcoder] Skipping transcode: source is ${sourceHeight}p MP4, target is ${targetHeight}p`);
      return { outputPath: filePath, skipped: true, sourceHeight };
    }
  }

  const cmd = resolveFfmpeg();
  const vEncoder = String(options.codec || 'h265').toLowerCase() === 'h264' ? 'libx264' : 'libx265';
  const crf = String(options.crf || '20');
  const aCodec = options.audioCodec || 'aac';
  const aBitrate = options.audioBitrate || '128k';
  const aChannels = options.audioChannels || '2';
  const preset = options.preset || 'veryfast';

  const duration = await getMediaDuration(filePath);

  const outDir = path.dirname(targetOutputPath);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const tempOut = path.join(outDir, `${path.basename(targetOutputPath, '.mp4')}.transcoding_${Date.now()}.mp4`);

  const args = [
    '-y',
    '-i', filePath,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c:v', vEncoder,
    ...(vEncoder === 'libx265' ? ['-tag:v', 'hvc1', '-x265-params', 'no-sao=1:aq-mode=2'] : []),
    '-preset', preset,
    '-crf', crf,
    ...(scaleFilter ? ['-vf', scaleFilter] : []),
    '-pix_fmt', 'yuv420p',
    '-c:a', aCodec,
    ...(aCodec === 'copy' ? [] : ['-ar', '44100', '-ac', aChannels, '-b:a', aBitrate]),
    '-max_muxing_queue_size', '1024',
    '-sn',
    '-movflags', '+faststart',
    tempOut
  ];

  console.log(`[Transcoder] Starting transcode: ${path.basename(filePath)} -> ${path.basename(tempOut)}`);

  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    if (typeof options.onProcess === 'function') options.onProcess(proc);
    let stderr = '';
    let lastPercent = -1;

    proc.stderr.on('data', (data) => {
      const str = data.toString();
      stderr += str;
      const timeMatch = str.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (timeMatch) {
        const secs = parseInt(timeMatch[1], 10) * 3600 + parseInt(timeMatch[2], 10) * 60 + parseFloat(timeMatch[3]);
        let percent = 0;
        if (duration > 0) percent = Math.min(99, Math.round((secs / duration) * 100));
        if (percent !== lastPercent) {
          lastPercent = percent;
          if (onProgress) onProgress(percent);
        }
      }
    });

    proc.on('error', (err) => {
      try { if (fs.existsSync(tempOut)) fs.unlinkSync(tempOut); } catch (_) {}
      reject(err);
    });

    proc.on('exit', (code) => {
      if (code === 0 && fs.existsSync(tempOut) && fs.statSync(tempOut).size > 1000) {
        try {
          if (fs.existsSync(targetOutputPath)) fs.unlinkSync(targetOutputPath);
          fs.renameSync(tempOut, targetOutputPath);
          if (onProgress) onProgress(100);
          console.log(`[Transcoder] Completed: ${targetOutputPath} (${(fs.statSync(targetOutputPath).size / 1024 / 1024).toFixed(1)} MB)`);
          resolve({ outputPath: targetOutputPath, skipped: false });
        } catch (renErr) {
          reject(renErr);
        }
      } else {
        try { if (fs.existsSync(tempOut)) fs.unlinkSync(tempOut); } catch (_) {}
        reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-300)}`));
      }
    });
  });
}
