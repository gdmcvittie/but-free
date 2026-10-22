import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DATA_DIR, COVERS_DIR } from './config.js';
import db, { newId } from './db.js';
import googleAuth from './googleAuth.js';
import googleDrive from './googleDrive.js';
import binManager, { resolveFfmpeg } from './binManager.js';
import offlineCache, { localFileFor } from './offlineCache.js';
import { broadcast } from './events.js';
import { stripExtension } from './libraryParser.js';

/**
 * Audiobook Stitcher Manager:
 * Merges multiple chapter audio files (MP3/M4A/etc.) into a single unified audiobook MP3.
 * - Downloads / resolves source chapters from Google Drive or local offline cache.
 * - Encodes or stream-copies via FFmpeg with real-time time/progress tracking.
 * - Injects ID3v2 metadata (Title, Author, Series, Narrator, Year, Genre, Synopsis).
 * - Embeds front cover art into the final file.
 * - Uploads the stitched audiobook to Google Drive (in the author/series folder or source folder).
 * - Registers the stitched audiobook in FRAUDIO's library.
 * - Supports deleting source chapter files from Google Drive upon user confirmation.
 */

const jobs = new Map();
const activeProcesses = new Map(); // jobId -> ChildProcess
const JOB_TTL_MS = 60 * 60 * 1000; // 1 hour

function newJobId() {
  return `stitch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function newConvertJobId() {
  return `convert_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function getJobsDir() {
  const dir = path.join(DATA_DIR, 'jobs');
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e) {}
  return dir;
}

function saveJobToDisk(job) {
  try {
    const dir = getJobsDir();
    const filePath = path.join(dir, `${job.id}.json`);
    const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    const cleanJob = { ...job };
    fs.writeFileSync(tempPath, JSON.stringify(cleanJob, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (e) {
    console.error(`[AudiobookStitcher] Failed to persist job ${job.id}:`, e.message);
  }
}

function pruneOldJobs() {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (job.status !== 'running' && now - job.updatedAt > JOB_TTL_MS) {
      jobs.delete(id);
      activeProcesses.delete(id);
    }
  }
  try {
    const dir = getJobsDir();
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if ((!file.startsWith('stitch_') && !file.startsWith('convert_')) || !file.endsWith('.json')) continue;
        const filePath = path.join(dir, file);
        try {
          const stat = fs.statSync(filePath);
          if (now - stat.mtimeMs > JOB_TTL_MS) {
            fs.unlinkSync(filePath);
          }
        } catch (e) {}
      }
    }
  } catch (e) {}
}

function formatDuration(sec) {
  if (!sec || isNaN(sec)) return '00:00';
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const seconds = Math.floor(sec % 60);
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function parseTimeToSeconds(timeStr) {
  if (!timeStr) return 0;
  const parts = timeStr.trim().split(':');
  if (parts.length === 3) {
    return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
  } else if (parts.length === 2) {
    return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
  }
  return parseFloat(timeStr) || 0;
}

function sanitizeFileBase(raw) {
  return String(raw == null ? '' : raw)
    .replace(/[:]/g, ' - ')
    .replace(/[<>"/\\|?*]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[-_\s]+|[-_\s]+$/g, '')
    .trim();
}

/**
 * Parses any bitrate representation (e.g. '64k', '128 kbps', '192k', 128000, 128) into numeric kbps.
 */
function parseBitrateToKbps(val) {
  if (!val) return 64;
  if (typeof val === 'number') {
    return val > 1000 ? Math.round(val / 1000) : Math.round(val);
  }
  const str = String(val).trim().toLowerCase();
  const match = str.match(/^(\d+(?:\.\d+)?)\s*(k|kbps|m|mbps)?$/);
  if (match) {
    const num = parseFloat(match[1]);
    const unit = match[2];
    if (unit && unit.startsWith('m')) {
      return Math.round(num * 1000);
    }
    return Math.round(num);
  }
  const parsed = parseInt(str, 10);
  return isNaN(parsed) ? 64 : (parsed > 1000 ? Math.round(parsed / 1000) : parsed);
}

/**
 * Smart bitrate detector: inspects audio files to accurately detect current source bitrate in kbps.
 */
async function detectAudioBitrate(items = [], localPaths = []) {
  const detectedBitrates = [];

  // 1. Check if bitrate was already cataloged in database item metadata
  for (const item of items) {
    if (!item) continue;
    if (typeof item.bitrateKbps === 'number' && item.bitrateKbps > 0) {
      detectedBitrates.push(item.bitrateKbps);
    } else if (item.bitrate) {
      const parsed = parseBitrateToKbps(item.bitrate);
      if (parsed > 0) detectedBitrates.push(parsed);
    } else if (item.sizeBytes > 0 && item.durationSec > 0) {
      // Direct bitrate formula: (bytes * 8) / seconds / 1000
      const calc = Math.round((item.sizeBytes * 8) / item.durationSec / 1000);
      if (calc >= 16 && calc <= 1411) {
        detectedBitrates.push(calc);
      }
    }
  }

  if (detectedBitrates.length > 0 && detectedBitrates.length >= Math.min(items.length, 3)) {
    return Math.max(...detectedBitrates);
  }

  // 2. Inspect downloaded local files directly with music-metadata or stat/duration fallback
  try {
    const { parseFile } = await import('music-metadata');
    for (const filePath of localPaths.slice(0, 5)) {
      if (!filePath || !fs.existsSync(filePath)) continue;
      try {
        const meta = await parseFile(filePath, { duration: true, skipCovers: true });
        if (meta?.format?.bitrate) {
          detectedBitrates.push(Math.round(meta.format.bitrate / 1000));
        }
      } catch (_) {}
    }
  } catch (_) {}

  return detectedBitrates.length > 0 ? Math.max(...detectedBitrates) : null;
}

export const audiobookStitcher = {
  /**
   * Starts a background stitching job.
   */
  start(user, {
    fileIds,
    title,
    author,
    series,
    narrator,
    year,
    genre,
    comment,
    coverUrl,
    coverBase64,
    options = {}
  }) {
    pruneOldJobs();

    if (!user) {
      throw new Error('User authentication required.');
    }
    if (!Array.isArray(fileIds) || fileIds.length < 2) {
      throw new Error('Please select at least 2 chapter audio files to stitch.');
    }

    const ffmpegCandidate = (binManager && typeof binManager.resolveFfmpeg === 'function')
      ? binManager.resolveFfmpeg()
      : resolveFfmpeg();
    if (!ffmpegCandidate) {
      throw new Error('FFmpeg binary could not be found. Please ensure FFmpeg is installed or run tools setup.');
    }

    const id = newJobId();
    const now = Date.now();
    const cleanTitle = (title || '').trim() || 'Stitched Audiobook';

    const job = {
      id,
      userId: user.id,
      fileIds,
      title: cleanTitle,
      author: (author || '').trim(),
      series: (series || '').trim(),
      narrator: (narrator || '').trim(),
      year: year ? String(year).trim() : '',
      genre: (genre || 'Audiobook').trim(),
      comment: (comment || '').trim(),
      coverUrl: coverUrl || null,
      coverBase64: coverBase64 || null,
      options: {
        mode: options.mode || 'voice', // 'voice' | 'balanced' | 'copy' | 'standard' | 'high' | 'custom'
        bitrate: options.bitrate || (options.mode === 'voice' ? '64k' : options.mode === 'balanced' ? '96k' : options.mode === 'high' ? '192k' : '128k'),
        channels: options.channels || (options.mode === 'voice' ? '1' : '2'),
        sampleRate: options.sampleRate || 'original',
        normalize: Boolean(options.normalize),
        smartBitrate: options.smartBitrate !== false
      },
      status: 'running',
      phase: 'Initializing audiobook stitcher...',
      percent: 0,
      currentTime: '00:00:00',
      totalDuration: '00:00:00',
      createdAt: now,
      updatedAt: now,
      result: null,
      error: null
    };

    jobs.set(id, job);
    saveJobToDisk(job);

    // Run async in background
    this._runStitchJob(user, job).catch((err) => {
      console.error(`[AudiobookStitcher] Job ${id} error:`, err);
      job.status = 'error';
      job.phase = 'Failed';
      job.error = err.message || 'An unexpected error occurred during stitching.';
      job.updatedAt = Date.now();
      saveJobToDisk(job);
      broadcast('stitch_progress', { jobId: id, ...job });
    });

    return job;
  },

  /**
   * Retrieves status of a stitching job.
   */
  getStatus(jobId) {
    let job = jobs.get(jobId);
    if (!job) {
      try {
        const filePath = path.join(getJobsDir(), `${jobId}.json`);
        if (fs.existsSync(filePath)) {
          job = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          if (job && job.id) jobs.set(job.id, job);
        }
      } catch (e) {}
    }
    return job || null;
  },

  /**
   * Cancels a running stitching job and cleans up child processes.
   */
  cancel(jobId) {
    const proc = activeProcesses.get(jobId);
    if (proc) {
      try {
        proc.kill('SIGKILL');
      } catch (e) {}
      activeProcesses.delete(jobId);
    }
    const job = this.getStatus(jobId);
    if (job && job.status === 'running') {
      job.status = 'error';
      job.phase = 'Cancelled by user';
      job.error = 'Operation was cancelled.';
      job.updatedAt = Date.now();
      saveJobToDisk(job);
      broadcast('stitch_progress', { jobId, ...job });
      return true;
    }
    return false;
  },

  /**
   * Deletes source chapter files from Google Drive and updates the library database.
   */
  async deleteSourceChapters(user, fileIds) {
    if (!user) throw new Error('User authentication required.');
    if (!Array.isArray(fileIds) || fileIds.length === 0) {
      throw new Error('No files specified for deletion.');
    }

    let deletedCount = 0;
    const errors = [];

    for (const id of fileIds) {
      try {
        const item = db.getItem(user.id, id);
        if (item) {
          if (item.googleFileId) {
            try {
              await googleDrive.deleteFile(user, item.googleFileId);
            } catch (err) {
              console.warn(`[AudiobookStitcher] Could not delete Drive file ${item.googleFileId}:`, err.message);
            }
          }
          offlineCache.remove(user.id, item.id);
          db.removeItem(user.id, item.id, { silent: true });
          deletedCount++;
        }
      } catch (e) {
        errors.push(e.message);
      }
    }

    broadcast('library_changed', { userId: user.id, reason: 'stitch_delete_sources' });

    return {
      success: true,
      deletedCount,
      errors: errors.length ? errors : undefined
    };
  },

  /**
   * Updates metadata for selected audiobook chapter/book records and rescans the audiobooks folder.
   */
  async updateMetadata(user, {
    fileIds,
    title,
    author,
    series,
    narrator,
    year,
    genre,
    comment,
    coverBase64
  }) {
    if (!user) throw new Error('User authentication required.');
    if (!Array.isArray(fileIds) || fileIds.length === 0) {
      throw new Error('No files specified for metadata update.');
    }

    let coverImagePath = null;
    if (coverBase64 && coverBase64.startsWith('data:')) {
      const matches = coverBase64.match(/^data:([^;]+);base64,(.+)$/);
      if (matches) {
        const ext = matches[1].includes('png') ? '.png' : '.jpg';
        const key = `custom_cover_${Date.now()}`;
        coverImagePath = path.join(COVERS_DIR, `${key}${ext}`);
        fs.mkdirSync(COVERS_DIR, { recursive: true });
        fs.writeFileSync(coverImagePath, Buffer.from(matches[2], 'base64'));
      }
    }

    let updatedCount = 0;
    const isSingle = fileIds.length === 1;

    for (const id of fileIds) {
      const item = db.getItem(user.id, id);
      if (!item) continue;

      const updates = {};
      if (author !== undefined && author !== null) {
        updates.author = author.trim();
        updates.artist = author.trim();
        updates.albumArtist = author.trim();
      }
      if (series !== undefined && series !== null) updates.series = series.trim();
      if (narrator !== undefined && narrator !== null) updates.narrator = narrator.trim();
      if (genre !== undefined && genre !== null) updates.genre = genre.trim();
      if (comment !== undefined && comment !== null) updates.subtitle = comment.trim();
      if (year) updates.year = String(year).trim();
      if (coverImagePath) updates.coverImage = coverImagePath;

      if (isSingle && title && title.trim()) {
        updates.title = title.trim();
      } else if (!isSingle && (title?.trim() || series?.trim())) {
        updates.album = (title?.trim() || series?.trim());
      }

      db.updateItem(user.id, item.id, updates);
      updatedCount++;
    }

    // Rescan audiobooks folder in Google Drive to update library
    try {
      await googleDrive.syncLibrary(user, 'audiobooks');
    } catch (err) {
      console.warn('[AudiobookStitcher] Rescan after metadata update note:', err.message);
    }

    broadcast('library_changed', { userId: user.id, reason: 'metadata_update', kind: 'audiobooks' });
    broadcast('library_scan', { userId: user.id, kind: 'audiobooks', done: true, phase: 'done' });

    return {
      success: true,
      updatedCount
    };
  },

  /**
   * Asynchronous background worker that downloads, stitches, tags, and uploads the audiobook.
   */
  async _runStitchJob(user, job) {
    const tempDir = path.join(DATA_DIR, 'temp_stitch', job.id);
    fs.mkdirSync(tempDir, { recursive: true });

    const updateJob = (phase, percent, extra = {}) => {
      job.phase = phase;
      job.percent = Math.min(100, Math.max(0, Math.round(percent)));
      job.updatedAt = Date.now();
      Object.assign(job, extra);
      saveJobToDisk(job);
      broadcast('stitch_progress', {
        jobId: job.id,
        status: job.status,
        phase: job.phase,
        percent: job.percent,
        currentTime: job.currentTime,
        totalDuration: job.totalDuration,
        speed: job.speed,
        smartBitrate: job.smartBitrate
      });
    };

    try {
      // 1. Locate and verify chapter items
      updateJob('Locating chapter audio files...', 2);
      const chapters = [];
      for (const fileId of job.fileIds) {
        const item = db.getItem(user.id, fileId);
        if (!item) {
          throw new Error(`Audio chapter #${fileId} could not be found in library.`);
        }
        chapters.push(item);
      }

      if (chapters.length < 2) {
        throw new Error('At least 2 chapter audio files are required for stitching.');
      }

      // 2. Download / resolve local paths for all chapters
      const localChapterPaths = [];
      let totalDurationSec = 0;
      let totalSourceBytes = 0;

      for (let i = 0; i < chapters.length; i++) {
        const chapter = chapters[i];
        const chapterLabel = chapter.title || `Chapter ${i + 1}`;
        const downloadBase = 5 + Math.round((i / chapters.length) * 30); // 5% - 35%

        updateJob(`Downloading chapter ${i + 1} of ${chapters.length}: ${chapterLabel}...`, downloadBase);

        totalDurationSec += (chapter.durationSec || 0);
        totalSourceBytes += (chapter.sizeBytes || 0);

        // Check if offline cache has it already
        const cached = localFileFor(chapter.id);
        if (cached && fs.existsSync(cached) && fs.statSync(cached).size > 0) {
          localChapterPaths.push(cached);
          continue;
        }

        if (!chapter.googleFileId) {
          throw new Error(`Chapter "${chapterLabel}" has no Google Drive file ID.`);
        }

        // Download chapter from Google Drive into temp directory
        const ext = path.extname(chapter.fileName || chapter.drivePath || '') || '.mp3';
        const destPath = path.join(tempDir, `chapter_${String(i + 1).padStart(4, '0')}${ext}`);

        const accessToken = await googleAuth.getValidAccessToken(user);
        const res = await fetch(`https://www.googleapis.com/drive/v3/files/${chapter.googleFileId}?alt=media`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });

        if (!res.ok) {
          throw new Error(`Failed to download "${chapterLabel}" from Google Drive (HTTP ${res.status}).`);
        }

        const destStream = fs.createWriteStream(destPath);
        await pipeline(Readable.fromWeb(res.body), destStream);
        localChapterPaths.push(destPath);
      }

      job.totalDuration = formatDuration(totalDurationSec);

      // 3. Resolve FFmpeg
      const ffmpegPath = (binManager && typeof binManager.resolveFfmpeg === 'function')
        ? binManager.resolveFfmpeg()
        : resolveFfmpeg();
      if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
        throw new Error('FFmpeg binary could not be found. Please ensure FFmpeg is installed or run tools setup.');
      }
      console.log(`[AudiobookStitcher] Stitching job ${job.id} using FFmpeg: ${ffmpegPath}`);

      // 4. Create FFmpeg concat list
      const concatListFile = path.join(tempDir, 'concat_list.txt');
      const concatContent = localChapterPaths.map((p) => {
        const escaped = p.replace(/\\/g, '/').replace(/'/g, "'\\''");
        return `file '${escaped}'`;
      }).join('\n');
      fs.writeFileSync(concatListFile, concatContent, 'utf8');

      const intermediateOutput = path.join(tempDir, 'intermediate_stitched.mp3');

      // Smart Bitrate Detector: Check current source audio bitrate and only compress
      // if current source bitrate is strictly higher than target desired bitrate
      let mode = job.options.mode || 'voice';
      const isSmartBitrate = job.options.smartBitrate !== false;
      const desiredBitrateRaw = job.options.bitrate || (mode === 'voice' ? '64k' : mode === 'balanced' ? '96k' : mode === 'high' ? '192k' : '128k');
      const desiredBitrateKbps = parseBitrateToKbps(desiredBitrateRaw);

      let effectiveBitrate = desiredBitrateRaw;
      let smartBitrateInfo = null;

      const allMp3 = localChapterPaths.every((p) => path.extname(p).toLowerCase() === '.mp3');
      const canDirectCopy = allMp3 && !job.options.normalize;

      if (isSmartBitrate && mode !== 'copy') {
        const detectedKbps = await detectAudioBitrate(chapters, localChapterPaths);
        if (detectedKbps && detectedKbps > 0) {
          const shouldCompress = detectedKbps > desiredBitrateKbps;
          if (shouldCompress) {
            effectiveBitrate = `${desiredBitrateKbps}k`;
            smartBitrateInfo = {
              enabled: true,
              detectedBitrate: detectedKbps,
              desiredBitrate: desiredBitrateKbps,
              shouldCompress: true,
              action: 'compress',
              effectiveBitrate: effectiveBitrate,
              reason: `Source (${detectedKbps} kbps) > Target (${desiredBitrateKbps} kbps). Re-encoding to compress audio.`
            };
          } else {
            // Source is already <= desired bitrate -> DO NOT COMPRESS
            if (canDirectCopy) {
              mode = 'copy';
              smartBitrateInfo = {
                enabled: true,
                detectedBitrate: detectedKbps,
                desiredBitrate: desiredBitrateKbps,
                shouldCompress: false,
                action: 'copy',
                effectiveBitrate: `${detectedKbps}k`,
                reason: `Source (${detectedKbps} kbps) ≤ Target (${desiredBitrateKbps} kbps). Lossless stream copy applied.`
              };
            } else {
              effectiveBitrate = `${detectedKbps}k`;
              smartBitrateInfo = {
                enabled: true,
                detectedBitrate: detectedKbps,
                desiredBitrate: desiredBitrateKbps,
                shouldCompress: false,
                action: 'preserve',
                effectiveBitrate: effectiveBitrate,
                reason: `Source (${detectedKbps} kbps) ≤ Target (${desiredBitrateKbps} kbps). Preserving original ${effectiveBitrate} without compression.`
              };
            }
          }
        }
      }

      job.smartBitrate = smartBitrateInfo;

      // Build FFmpeg concat arguments
      const args = [
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', concatListFile
      ];

      if (mode === 'copy') {
        // Direct stream copy - ultra fast
        args.push('-c', 'copy');
      } else {
        // Re-encoding with selected quality / compression
        args.push('-c:a', 'libmp3lame');
        args.push('-b:a', effectiveBitrate);

        if (job.options.channels === '1' || job.options.channels === 1 || mode === 'voice') {
          args.push('-ac', '1');
        } else if (job.options.channels === '2' || job.options.channels === 2 || mode === 'standard' || mode === 'high' || mode === 'balanced') {
          args.push('-ac', '2');
        }

        if (job.options.sampleRate && job.options.sampleRate !== 'original') {
          args.push('-ar', String(job.options.sampleRate));
        }

        if (job.options.normalize) {
          args.push('-af', 'loudnorm=I=-16:TP=-1.5:LRA=11');
        }
      }

      args.push(intermediateOutput);

      let initialPhase = mode === 'copy'
        ? 'Direct stream copying audio frames (lossless)...'
        : `Stitching and compressing audio chapters (${effectiveBitrate})...`;

      if (smartBitrateInfo) {
        if (smartBitrateInfo.action === 'copy') {
          initialPhase = `Smart Bitrate: Source (${smartBitrateInfo.detectedBitrate}k) ≤ Target (${smartBitrateInfo.desiredBitrate}k) → Lossless stream copy`;
        } else if (smartBitrateInfo.action === 'preserve') {
          initialPhase = `Smart Bitrate: Source (${smartBitrateInfo.detectedBitrate}k) ≤ Target (${smartBitrateInfo.desiredBitrate}k) → Preserving ${smartBitrateInfo.effectiveBitrate}`;
        } else if (smartBitrateInfo.action === 'compress') {
          initialPhase = `Smart Bitrate: Source (${smartBitrateInfo.detectedBitrate}k) > Target (${smartBitrateInfo.desiredBitrate}k) → Compressing to ${smartBitrateInfo.effectiveBitrate}`;
        }
      }

      updateJob(initialPhase, 38, { smartBitrate: smartBitrateInfo });

      // Execute FFmpeg concat process
      await new Promise((resolve, reject) => {
        let lastProgressTime = 0;
        let proc = null;
        try {
          proc = spawn(ffmpegPath, args, { windowsHide: true });
          activeProcesses.set(job.id, proc);
        } catch (spawnErr) {
          return reject(new Error(`Failed to start FFmpeg: ${spawnErr.message}`));
        }

        proc.stderr.on('data', (data) => {
          const line = data.toString();

          if (totalDurationSec === 0) {
            const durMatch = line.match(/Duration:\s*(\d+:\d+:\d+\.\d+)/);
            if (durMatch) totalDurationSec = parseTimeToSeconds(durMatch[1]);
          }

          const timeMatch = line.match(/time=(\d+:\d+:\d+\.\d+)/);
          const speedMatch = line.match(/speed=\s*([\d\.]+x)/);

          if (timeMatch) {
            const currentSec = parseTimeToSeconds(timeMatch[1]);
            const encodePercent = totalDurationSec > 0
              ? Math.min(100, Math.round((currentSec / totalDurationSec) * 100))
              : 0;

            const now = Date.now();
            if (now - lastProgressTime > 250) {
              lastProgressTime = now;
              const overallPercent = 38 + Math.round(encodePercent * 0.42); // 38% - 80%
              updateJob(
                `Encoding chapters: ${encodePercent}% (${timeMatch[1].split('.')[0]} / ${formatDuration(totalDurationSec)})${speedMatch ? ` [${speedMatch[1]}]` : ''}`,
                overallPercent,
                {
                  currentTime: timeMatch[1].split('.')[0],
                  speed: speedMatch ? speedMatch[1] : ''
                }
              );
            }
          }
        });

        proc.on('error', (err) => {
          activeProcesses.delete(job.id);
          reject(new Error(`FFmpeg failed: ${err.message}`));
        });

        proc.on('close', (code) => {
          activeProcesses.delete(job.id);
          if (code === 0) resolve();
          else reject(new Error(`FFmpeg exited with error code ${code}`));
        });
      });

      // 5. Handle Cover Art
      updateJob('Writing ID3 metadata tags and embedding cover art...', 81);

      let coverPath = null;

      if (job.coverBase64 && job.coverBase64.startsWith('data:')) {
        const matches = job.coverBase64.match(/^data:([^;]+);base64,(.+)$/);
        if (matches) {
          const ext = matches[1].includes('png') ? '.png' : '.jpg';
          coverPath = path.join(tempDir, `cover_art${ext}`);
          fs.writeFileSync(coverPath, Buffer.from(matches[2], 'base64'));
        }
      } else if (job.coverUrl) {
        try {
          let coverBuf = null;
          if (job.coverUrl.startsWith('/api/items/')) {
            const match = job.coverUrl.match(/\/api\/items\/([^/]+)\/cover/);
            if (match && match[1]) {
              const item = db.getItem(user.id, match[1]);
              if (item?.googleFileId) {
                const coverInfo = await googleDrive.buildCover(user, item.googleFileId);
                if (coverInfo?.file && fs.existsSync(coverInfo.file)) {
                  coverBuf = fs.readFileSync(coverInfo.file);
                }
              }
            }
          } else if (job.coverUrl.startsWith('http')) {
            const res = await fetch(job.coverUrl);
            if (res.ok) coverBuf = Buffer.from(await res.arrayBuffer());
          }

          if (coverBuf && coverBuf.length > 100) {
            coverPath = path.join(tempDir, 'cover_art.jpg');
            fs.writeFileSync(coverPath, coverBuf);
          }
        } catch (coverErr) {
          console.warn('[AudiobookStitcher] Cover download note:', coverErr.message);
        }
      }

      // If still no cover, check if first chapter has cover
      if (!coverPath && chapters[0]?.googleFileId) {
        try {
          const coverInfo = await googleDrive.buildCover(user, chapters[0].googleFileId);
          if (coverInfo?.file && fs.existsSync(coverInfo.file)) {
            coverPath = coverInfo.file;
          }
        } catch (e) {}
      }

      // 6. Apply ID3 Metadata and attach Cover Art using FFmpeg
      const finalFileName = `${sanitizeFileBase(job.title) || 'Audiobook'}.mp3`;
      const finalStitchedPath = path.join(tempDir, finalFileName);

      const tagArgs = [
        '-y',
        '-i', intermediateOutput
      ];

      if (coverPath && fs.existsSync(coverPath)) {
        tagArgs.push('-i', coverPath, '-map', '0:a', '-map', '1:0');
      }

      tagArgs.push(
        '-c', 'copy',
        '-id3v2_version', '3',
        '-metadata', `title=${job.title}`,
        '-metadata', `artist=${job.author || ''}`,
        '-metadata', `album_artist=${job.author || ''}`,
        '-metadata', `album=${job.series || job.title}`,
        '-metadata', `composer=${job.narrator || ''}`,
        '-metadata', `date=${job.year || ''}`,
        '-metadata', `genre=${job.genre || 'Audiobook'}`,
        '-metadata', `comment=${job.comment || ''}`
      );

      if (coverPath && fs.existsSync(coverPath)) {
        tagArgs.push(
          '-metadata:s:v', 'title=Album cover',
          '-metadata:s:v', 'comment=Cover (front)'
        );
      }

      tagArgs.push(finalStitchedPath);

      await new Promise((resolve, reject) => {
        let tagProc = null;
        try {
          tagProc = spawn(ffmpegPath, tagArgs, { windowsHide: true });
          activeProcesses.set(job.id, tagProc);
        } catch (err) {
          return reject(err);
        }

        tagProc.on('error', (err) => {
          activeProcesses.delete(job.id);
          reject(err);
        });

        tagProc.on('close', (code) => {
          activeProcesses.delete(job.id);
          if (code === 0 && fs.existsSync(finalStitchedPath)) resolve();
          else {
            // Fallback: copy intermediate directly if tagging failed
            try {
              fs.copyFileSync(intermediateOutput, finalStitchedPath);
              resolve();
            } catch (e) {
              reject(new Error(`Tagging failed with exit code ${code}`));
            }
          }
        });
      });

      // 7. Upload to Google Drive
      updateJob('Uploading stitched audiobook to Google Drive...', 85);

      const firstChapter = chapters[0];
      let uploadResult = null;

      uploadResult = await googleDrive.uploadAudiobook(user, finalStitchedPath, {
        fileName: finalFileName,
        author: job.author || firstChapter.author,
        series: job.series || firstChapter.series,
        onProgress: ({ uploaded, total }) => {
          if (total > 0) {
            const ratio = uploaded / total;
            const uploadPercent = 85 + Math.round(ratio * 12); // 85% - 97%
            updateJob(`Uploading to Google Drive: ${Math.round(ratio * 100)}%...`, uploadPercent);
          }
        }
      });

      // 8. Register stitched book into FRAUDIO database
      updateJob('Registering audiobook in library...', 98);

      const finalStat = fs.statSync(finalStitchedPath);

      const newBookItem = db.upsertItem(user.id, {
        id: newId('abk'),
        kind: 'audiobook',
        title: job.title,
        author: job.author || firstChapter.author || 'Unknown Author',
        series: job.series || firstChapter.series || '',
        narrator: job.narrator || firstChapter.narrator || '',
        genre: job.genre || 'Audiobook',
        format: 'mp3',
        fileName: finalFileName,
        googleFileId: uploadResult.driveFileId,
        driveFolderId: uploadResult.driveFolderId,
        drivePath: uploadResult.drivePath,
        sizeBytes: uploadResult.sizeBytes || finalStat.size,
        durationSec: totalDurationSec,
        addedAt: new Date().toISOString()
      });

      broadcast('library_changed', { userId: user.id, reason: 'stitch_completed' });

      // Automatically update/rescan audiobooks folder to sync the new file and library state
      try {
        updateJob('Rescanning audiobooks folder to update library...', 99);
        await googleDrive.syncLibrary(user, 'audiobooks');
        broadcast('library_changed', { userId: user.id, reason: 'scan', kind: 'audiobooks' });
        broadcast('library_scan', { userId: user.id, kind: 'audiobooks', done: true, phase: 'done' });
      } catch (scanErr) {
        console.warn('[AudiobookStitcher] Post-stitch sync note:', scanErr.message);
      }

      // 9. Done!
      job.status = 'done';
      job.percent = 100;
      job.phase = 'Audiobook stitched successfully!';
      job.updatedAt = Date.now();
      job.result = {
        item: newBookItem,
        sourceFileIds: job.fileIds,
        sourceTitles: chapters.map((c) => c.title || c.fileName),
        title: job.title,
        author: job.author,
        series: job.series,
        fileName: finalFileName,
        fileSize: finalStat.size,
        durationSec: totalDurationSec,
        durationFormatted: formatDuration(totalDurationSec),
        driveFolderId: uploadResult.driveFolderId,
        drivePath: uploadResult.drivePath,
        smartBitrate: job.smartBitrate
      };

      saveJobToDisk(job);
      broadcast('stitch_progress', { jobId: job.id, ...job });
    } finally {
      // Clean up scratch files
      try {
        if (fs.existsSync(tempDir)) {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      } catch (cleanErr) {
        console.warn('[AudiobookStitcher] Temp cleanup note:', cleanErr.message);
      }
    }
  },

  /**
   * Starts a batch audio conversion job (converts audio files in a folder/selection without stitching).
   */
  startConvert(user, {
    fileIds,
    preset = '64k',
    options = {}
  }) {
    pruneOldJobs();

    if (!user) throw new Error('User authentication required.');
    if (!Array.isArray(fileIds) || fileIds.length === 0) {
      throw new Error('Please select at least 1 audio file to convert.');
    }

    const ffmpegCandidate = (binManager && typeof binManager.resolveFfmpeg === 'function')
      ? binManager.resolveFfmpeg()
      : resolveFfmpeg();
    if (!ffmpegCandidate) {
      throw new Error('FFmpeg binary could not be found. Please ensure FFmpeg is installed.');
    }

    const id = newConvertJobId();
    const now = Date.now();

    const job = {
      id,
      type: 'convert',
      userId: user.id,
      fileIds,
      preset,
      options: {
        preset: preset || '64k',
        bitrate: options.bitrate || (preset === 'voice' || preset === '64k' ? '64k' : preset === 'balanced' || preset === '96k' ? '96k' : '128k'),
        channels: options.channels || (preset === 'voice' || preset === '64k' ? '1' : '2'),
        sampleRate: options.sampleRate || 'original',
        normalize: Boolean(options.normalize),
        smartBitrate: options.smartBitrate !== false,
        destMode: options.destMode || 'subfolder', // 'in-place' | 'subfolder' | 'custom-folder'
        customFolderId: options.customFolderId || null,
        deleteSource: Boolean(options.deleteSource)
      },
      status: 'running',
      phase: 'Starting batch audio conversion...',
      overallPercent: 0,
      currentFileIndex: 0,
      totalFiles: fileIds.length,
      currentFileName: '',
      currentPercent: 0,
      currentTime: '00:00:00',
      totalDuration: '00:00:00',
      speed: '',
      freedBytes: 0,
      smartPreservedCount: 0,
      completedCount: 0,
      failedCount: 0,
      createdAt: now,
      updatedAt: now,
      result: null,
      error: null
    };

    jobs.set(id, job);
    saveJobToDisk(job);

    this._runConvertJob(user, job).catch((err) => {
      console.error(`[AudiobookConverter] Job ${id} error:`, err);
      job.status = 'error';
      job.phase = 'Batch conversion failed';
      job.error = err.message || 'An error occurred during batch conversion.';
      job.updatedAt = Date.now();
      saveJobToDisk(job);
      broadcast('convert_progress', { jobId: id, ...job });
    });

    return job;
  },

  /**
   * Asynchronous background worker for Batch Audio Conversion.
   */
  async _runConvertJob(user, job) {
    const tempDir = path.join(DATA_DIR, 'temp_convert', job.id);
    fs.mkdirSync(tempDir, { recursive: true });

    const updateJob = (phase, extra = {}) => {
      job.phase = phase;
      job.updatedAt = Date.now();
      Object.assign(job, extra);
      saveJobToDisk(job);
      broadcast('convert_progress', {
        jobId: job.id,
        status: job.status,
        phase: job.phase,
        overallPercent: job.overallPercent,
        currentFileIndex: job.currentFileIndex,
        totalFiles: job.totalFiles,
        currentFileName: job.currentFileName,
        currentPercent: job.currentPercent,
        currentTime: job.currentTime,
        totalDuration: job.totalDuration,
        speed: job.speed,
        smartBitrate: job.smartBitrate,
        freedBytes: job.freedBytes,
        smartPreservedCount: job.smartPreservedCount,
        completedCount: job.completedCount,
        failedCount: job.failedCount
      });
    };

    try {
      const ffmpegPath = (binManager && typeof binManager.resolveFfmpeg === 'function')
        ? binManager.resolveFfmpeg()
        : resolveFfmpeg();

      const desiredBitrateRaw = job.options.bitrate || '64k';
      const desiredBitrateKbps = parseBitrateToKbps(desiredBitrateRaw);
      const isSmartBitrate = job.options.smartBitrate !== false;

      let completedCount = 0;
      let failedCount = 0;
      let totalFreedBytes = 0;
      let smartPreservedCount = 0;
      let totalDurationSec = 0;
      const convertedResults = [];

      for (let i = 0; i < job.fileIds.length; i++) {
        if (job.status === 'cancelled') break;

        const fileId = job.fileIds[i];
        let item = db.getItem(user.id, fileId);

        // Fallback: If not in DB, probe Google Drive file info
        let driveFileMeta = null;
        if (!item) {
          try {
            driveFileMeta = await googleDrive.getFileMetadata(user, fileId);
          } catch (_) {}
          if (!driveFileMeta) {
            failedCount++;
            continue;
          }
          item = {
            id: fileId,
            googleFileId: fileId,
            fileName: driveFileMeta.name,
            title: stripExtension(driveFileMeta.name),
            sizeBytes: Number(driveFileMeta.size) || 0,
            driveFolderId: driveFileMeta.parents?.[0] || user.audiobooksFolderId
          };
        }

        const fileName = item.fileName || `${item.title || 'audio'}.mp3`;
        const baseName = stripExtension(fileName);
        const originalExt = path.extname(fileName).toLowerCase() || '.mp3';

        updateJob(`Processing file ${i + 1} of ${job.fileIds.length}: ${fileName}`, {
          currentFileIndex: i,
          currentFileName: fileName,
          currentPercent: 0,
          overallPercent: Math.round((i / job.fileIds.length) * 100)
        });

        // 1. Download file to temp
        const rawLocalPath = path.join(tempDir, `src_${i}_${fileName}`);
        const cached = localFileFor(item.id);
        let srcPath = rawLocalPath;

        if (cached && fs.existsSync(cached) && fs.statSync(cached).size > 0) {
          srcPath = cached;
        } else {
          if (!item.googleFileId) {
            failedCount++;
            continue;
          }
          const accessToken = await googleAuth.getValidAccessToken(user);
          const res = await fetch(`https://www.googleapis.com/drive/v3/files/${item.googleFileId}?alt=media`, {
            headers: { Authorization: `Bearer ${accessToken}` }
          });
          if (!res.ok) {
            failedCount++;
            continue;
          }
          const writeStream = fs.createWriteStream(rawLocalPath);
          await pipeline(Readable.fromWeb(res.body), writeStream);
          srcPath = rawLocalPath;
        }

        // 2. Detect source bitrate
        let detectedKbps = null;
        if (isSmartBitrate) {
          detectedKbps = await detectAudioBitrate([item], [srcPath]);
        }

        // Determine effective bitrate and whether to compress or copy
        let effectiveBitrate = desiredBitrateRaw;
        let convMode = 'compress';
        let smartInfo = null;
        const sameExt = originalExt === '.mp3';
        const canDirectCopy = sameExt && !job.options.normalize;

        if (isSmartBitrate && detectedKbps && detectedKbps > 0) {
          const shouldCompress = detectedKbps > desiredBitrateKbps;
          if (shouldCompress) {
            effectiveBitrate = `${desiredBitrateKbps}k`;
            smartInfo = {
              enabled: true,
              detectedBitrate: detectedKbps,
              desiredBitrate: desiredBitrateKbps,
              shouldCompress: true,
              action: 'compress',
              effectiveBitrate: effectiveBitrate,
              reason: `Source (${detectedKbps}k) > Target (${desiredBitrateKbps}k) → Compressing`
            };
          } else {
            // Source is already <= target -> Do not compress!
            if (canDirectCopy) {
              convMode = 'copy';
              smartInfo = {
                enabled: true,
                detectedBitrate: detectedKbps,
                desiredBitrate: desiredBitrateKbps,
                shouldCompress: false,
                action: 'copy',
                effectiveBitrate: `${detectedKbps}k`,
                reason: `Source (${detectedKbps}k) ≤ Target (${desiredBitrateKbps}k) → Lossless stream copy`
              };
            } else {
              effectiveBitrate = `${detectedKbps}k`;
              smartInfo = {
                enabled: true,
                detectedBitrate: detectedKbps,
                desiredBitrate: desiredBitrateKbps,
                shouldCompress: false,
                action: 'preserve',
                effectiveBitrate: effectiveBitrate,
                reason: `Source (${detectedKbps}k) ≤ Target (${desiredBitrateKbps}k) → Preserving ${detectedKbps}k`
              };
            }
            smartPreservedCount++;
          }
        }

        // 3. Output file path (temp converted file)
        const convertedTempPath = path.join(tempDir, `out_${i}_${baseName}.mp3`);

        const ffmpegArgs = ['-y', '-i', srcPath];
        if (convMode === 'copy') {
          ffmpegArgs.push('-c', 'copy');
          ffmpegArgs.push('-map', '0:a');
          ffmpegArgs.push('-map', '0:v?');
          ffmpegArgs.push('-map_metadata', '0');
        } else {
          ffmpegArgs.push('-c:a', 'libmp3lame', '-b:a', effectiveBitrate);
          if (job.options.channels === '1' || job.options.channels === 1) ffmpegArgs.push('-ac', '1');
          else if (job.options.channels === '2' || job.options.channels === 2) ffmpegArgs.push('-ac', '2');
          if (job.options.sampleRate && job.options.sampleRate !== 'original') {
            ffmpegArgs.push('-ar', String(job.options.sampleRate));
          }
          if (job.options.normalize) {
            ffmpegArgs.push('-af', 'loudnorm=I=-16:TP=-1.5:LRA=11');
          }
          ffmpegArgs.push('-map', '0:a', '-map', '0:v?', '-c:v', 'copy', '-id3v2_version', '3', '-map_metadata', '0');
        }
        ffmpegArgs.push(convertedTempPath);

        let fileDurationSec = item.durationSec || 0;
        let lastThrottle = 0;

        await new Promise((resolveConv, rejectConv) => {
          let proc = null;
          try {
            proc = spawn(ffmpegPath, ffmpegArgs, { windowsHide: true });
            activeProcesses.set(job.id, proc);
          } catch (e) {
            return rejectConv(e);
          }

          proc.stderr.on('data', (chunk) => {
            const line = chunk.toString();
            if (fileDurationSec === 0) {
              const durMatch = line.match(/Duration:\s*(\d+:\d+:\d+\.\d+)/);
              if (durMatch) fileDurationSec = parseTimeToSeconds(durMatch[1]);
            }
            const timeMatch = line.match(/time=(\d+:\d+:\d+\.\d+)/);
            const speedMatch = line.match(/speed=\s*([\d\.]+x)/);
            if (timeMatch) {
              const currentSec = parseTimeToSeconds(timeMatch[1]);
              const percent = fileDurationSec > 0 ? Math.min(99, Math.round((currentSec / fileDurationSec) * 100)) : 0;
              const nowMs = Date.now();
              if (nowMs - lastThrottle > 250) {
                lastThrottle = nowMs;
                updateJob(`Converting ${fileName}: ${percent}%`, {
                  currentPercent: percent,
                  currentTime: timeMatch[1].split('.')[0],
                  totalDuration: formatDuration(fileDurationSec),
                  speed: speedMatch ? speedMatch[1] : '',
                  smartBitrate: smartInfo
                });
              }
            }
          });

          proc.on('error', (err) => {
            activeProcesses.delete(job.id);
            rejectConv(err);
          });

          proc.on('close', (code) => {
            activeProcesses.delete(job.id);
            if (code === 0 && fs.existsSync(convertedTempPath)) resolveConv();
            else rejectConv(new Error(`FFmpeg exited with code ${code}`));
          });
        });

        totalDurationSec += fileDurationSec;
        const convertedStat = fs.statSync(convertedTempPath);
        const originalSize = item.sizeBytes || (fs.existsSync(srcPath) ? fs.statSync(srcPath).size : 0);

        // 4. Destination Handling (Google Drive)
        let finalDriveFileId = item.googleFileId;
        const destMode = job.options.destMode || 'subfolder';

        if (destMode === 'in-place') {
          // In-place: replace file content in Drive directly
          updateJob(`Updating "${fileName}" in Google Drive...`);
          const updatedResult = await googleDrive.updateFileContent(user, item.googleFileId, convertedTempPath);
          finalDriveFileId = updatedResult.driveFileId || item.googleFileId;

          // Calculate freed bytes if file became smaller
          if (originalSize > convertedStat.size) {
            totalFreedBytes += (originalSize - convertedStat.size);
          }

          db.updateItem(user.id, item.id, {
            sizeBytes: convertedStat.size,
            format: 'mp3',
            bitrateKbps: smartInfo?.effectiveBitrate ? parseBitrateToKbps(smartInfo.effectiveBitrate) : desiredBitrateKbps
          });
        } else {
          // Subfolder ('converted') or Custom folder
          let targetFolderId = user.audiobooksFolderId;
          if (destMode === 'custom-folder' && job.options.customFolderId) {
            targetFolderId = job.options.customFolderId;
          } else {
            // 'converted' subfolder inside the source folder
            const parentFolderId = item.driveFolderId || user.audiobooksFolderId;
            const subfolder = await googleDrive.getOrCreateSubfolder(user, 'converted', parentFolderId);
            targetFolderId = subfolder.id;
          }

          updateJob(`Uploading converted "${baseName}.mp3" to Google Drive...`);
          const uploadRes = await googleDrive.uploadFile(user, convertedTempPath, {
            name: `${baseName}.mp3`,
            folderId: targetFolderId
          });
          finalDriveFileId = uploadRes.id || uploadRes.driveFileId;

          // Register new converted item
          db.upsertItem(user.id, {
            ...item,
            id: newId('abk'),
            fileName: `${baseName}.mp3`,
            format: 'mp3',
            googleFileId: finalDriveFileId,
            driveFolderId: targetFolderId,
            sizeBytes: convertedStat.size,
            bitrateKbps: smartInfo?.effectiveBitrate ? parseBitrateToKbps(smartInfo.effectiveBitrate) : desiredBitrateKbps,
            addedAt: new Date().toISOString()
          });

          // Delete source file if requested
          if (job.options.deleteSource && item.googleFileId && item.googleFileId !== finalDriveFileId) {
            try {
              await googleDrive.deleteFile(user, item.googleFileId);
              totalFreedBytes += originalSize;
              db.removeItem(user.id, item.id, { silent: true });
            } catch (delErr) {
              console.warn('[AudiobookConverter] Delete source note:', delErr.message);
            }
          }
        }

        completedCount++;
        convertedResults.push({
          fileId: item.id,
          fileName,
          originalSize,
          convertedSize: convertedStat.size,
          driveFileId: finalDriveFileId,
          smartBitrate: smartInfo
        });

        // Clean up individual temp file
        try { fs.unlinkSync(convertedTempPath); } catch (_) {}
        if (srcPath === rawLocalPath) {
          try { fs.unlinkSync(rawLocalPath); } catch (_) {}
        }
      }

      // Sync library to update Google Drive view
      try {
        await googleDrive.syncLibrary(user, 'audiobooks');
        broadcast('library_changed', { userId: user.id, reason: 'convert_completed' });
      } catch (_) {}

      job.status = 'done';
      job.overallPercent = 100;
      job.currentPercent = 100;
      job.phase = `Batch conversion completed (${completedCount} of ${job.fileIds.length} files converted).`;
      job.completedCount = completedCount;
      job.failedCount = failedCount;
      job.freedBytes = totalFreedBytes;
      job.smartPreservedCount = smartPreservedCount;
      job.result = {
        completedCount,
        failedCount,
        totalFiles: job.fileIds.length,
        totalDurationSec,
        totalDurationFormatted: formatDuration(totalDurationSec),
        freedBytes: totalFreedBytes,
        smartPreservedCount,
        files: convertedResults
      };
      job.updatedAt = Date.now();
      saveJobToDisk(job);
      broadcast('convert_progress', { jobId: job.id, ...job });
    } finally {
      try {
        if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (_) {}
    }
  }
};

export default audiobookStitcher;
