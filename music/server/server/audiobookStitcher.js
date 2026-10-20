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
        if (!file.startsWith('stitch_') || !file.endsWith('.json')) continue;
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
        mode: options.mode || 'voice', // 'voice' | 'copy' | 'standard' | 'high' | 'custom'
        bitrate: options.bitrate || (options.mode === 'voice' ? '64k' : options.mode === 'high' ? '192k' : '128k'),
        channels: options.channels || (options.mode === 'voice' ? '1' : '2'),
        sampleRate: options.sampleRate || 'original',
        normalize: Boolean(options.normalize)
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
        totalDuration: job.totalDuration
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

      // Build FFmpeg concat arguments
      const args = [
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', concatListFile
      ];

      const mode = job.options.mode || 'voice';

      if (mode === 'copy') {
        // Direct stream copy - ultra fast
        args.push('-c', 'copy');
      } else {
        // Re-encoding with selected quality / compression
        args.push('-c:a', 'libmp3lame');

        const bitrate = job.options.bitrate || (mode === 'voice' ? '64k' : mode === 'high' ? '192k' : '128k');
        args.push('-b:a', bitrate);

        if (job.options.channels === '1' || job.options.channels === 1 || mode === 'voice') {
          args.push('-ac', '1');
        } else if (job.options.channels === '2' || job.options.channels === 2 || mode === 'standard' || mode === 'high') {
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

      updateJob(
        mode === 'copy' ? 'Direct stream copying audio frames...' : 'Stitching and compressing audio chapters...',
        38
      );

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
        drivePath: uploadResult.drivePath
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
  }
};

export default audiobookStitcher;
