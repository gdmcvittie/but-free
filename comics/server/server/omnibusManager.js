const fs = require('fs');
const path = require('path');
const Database = require('./database');
const GoogleAuth = require('./googleAuth');
const GoogleDrive = require('./googleDrive');
const CacheManager = require('./cacheManager');
const CBZReader = require('./cbzReader');
const ComicCompressor = require('./comicCompressor');
const { createStreamingCBZ } = require('./cbzWriter');

/**
 * Omnibus Manager:
 * Merges multiple selected comic issues in a specified sequence into a single omnibus CBZ archive.
 * - Extracts and renames each page systematically: "0001 - issue01-page-001.jpg"
 * - Streams output into a single .cbz file to keep RAM usage minimal (< 5MB)
 * - Places the output archive in the same folder as the source issues
 * - Supports deleting single issues upon user confirmation
 *
 * Also splits a single large omnibus back into evenly sized volumes:
 * - Reads the page count, then cuts it into N contiguous ranges of near-equal size
 * - Names each output "[existing name] - Vol. 01.cbz"
 * - Gives every volume its own cover: its first page at 512px tall @ 85% JPEG,
 *   saved next to the .cbz under the same name
 */

const jobs = new Map();
const JOB_TTL_MS = 60 * 60 * 1000; // 1 hour retention

// Upper bound on volumes per omnibus, keeps a runaway request from fanning out
// into hundreds of Drive uploads.
const MAX_SPLIT_VOLUMES = 60;

// Thumbnail settings shared by the merge and split flows.
const COVER_MAX_HEIGHT = 512;
const COVER_QUALITY = 85;

function getJobsDir() {
  const baseDir = process.env.DATA_DIR
    ? (path.isAbsolute(process.env.DATA_DIR) ? process.env.DATA_DIR : path.join(__dirname, '..', process.env.DATA_DIR))
    : path.join(__dirname, '..', 'data');
  const dir = path.join(baseDir, 'jobs');
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  } catch (e) {}
  return dir;
}

function saveJobToDisk(job) {
  try {
    const dir = getJobsDir();
    const filePath = path.join(dir, `${job.id}.json`);
    const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tempPath, JSON.stringify(job, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (e) {
    console.error(`[OmnibusManager] Failed to persist job ${job.id} to disk:`, e.message);
  }
}

function getJob(id) {
  let job = jobs.get(id);
  if (job) return job;

  try {
    const dir = getJobsDir();
    const filePath = path.join(dir, `${id}.json`);
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      job = JSON.parse(raw);
      if (job && job.id) {
        jobs.set(job.id, job);
        return job;
      }
    }
  } catch (e) {}
  return null;
}

function newJobId() {
  return `omni_${Date.now().toString(36)}_${Math.random().toString(36).substr(2, 5)}`;
}

/**
 * Per-job scratch directory for temporary archives. Honours DATA_DIR so it lands
 * on the same volume as the rest of the app data on shared hosting.
 */
function getTempDir(jobId) {
  const baseDir = process.env.DATA_DIR
    ? (path.isAbsolute(process.env.DATA_DIR) ? process.env.DATA_DIR : path.join(__dirname, '..', process.env.DATA_DIR))
    : path.join(__dirname, '..', 'data');
  const dir = path.join(baseDir, 'temp_omnibus', jobId);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  } catch (e) {}
  return dir;
}

/**
 * Makes a string safe for use as a file name on both Windows and shared hosting:
 * colons become " - ", illegal characters become "_", whitespace is collapsed.
 */
function sanitizeFileBase(raw) {
  return String(raw == null ? '' : raw)
    .replace(/[:]/g, ' - ')
    .replace(/[<>"/\\|?*]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[-_\s]+|[-_\s]+$/g, '')
    .trim();
}

/**
 * Builds the volume base name from the source archive name.
 * "Batman Omnibus.cbz" + volume 3 -> "Batman Omnibus - Vol. 03"
 */
function buildVolumeBaseName(existingName, volumeNumber) {
  const stripped = String(existingName || '').replace(/\.(cbz|cbr|zip)$/i, '').trim();
  const safe = sanitizeFileBase(stripped) || 'Omnibus';
  return `${safe} - Vol. ${String(volumeNumber).padStart(2, '0')}`;
}

/**
 * Flattens an archive entry path ("vol2/ch01/003.jpg") down to a bare,
 * filesystem-safe file name. Archives are written without folder structure, so
 * two entries sharing a base name would otherwise collide inside the .cbz.
 */
function flattenPageName(entryFileName) {
  const normalized = String(entryFileName || '').replace(/\\/g, '/');
  const base = path.posix.basename(normalized);
  return sanitizeFileBase(base) || 'page.jpg';
}

/**
 * Splits totalPages into volumeCount contiguous ranges of as-equal-as-possible
 * size. Any remainder is handed out one page at a time to the earliest volumes,
 * so no volume is ever more than one page larger than the next.
 * e.g. 100 pages over 3 volumes -> [34, 33, 33]
 */
function planVolumeRanges(totalPages, volumeCount) {
  const count = Math.max(1, Math.min(Math.floor(volumeCount), totalPages));
  const base = Math.floor(totalPages / count);
  const remainder = totalPages % count;

  const ranges = [];
  let startPage = 1;
  for (let i = 0; i < count; i++) {
    const pageCount = base + (i < remainder ? 1 : 0);
    const endPage = startPage + pageCount - 1;
    ranges.push({ volume: i + 1, startPage, endPage, pageCount });
    startPage = endPage + 1;
  }
  return ranges;
}

/**
 * Resolves a library comic to a locally readable archive, the exact file name it
 * is stored under, and (for Drive comics) the folder to write the volumes into.
 */
async function resolveComicLocation(user, comic) {
  if (comic.googleFileId) {
    const cachedPath = await GoogleDrive.ensureComicCached(user, comic.googleFileId);

    let fileName = '';
    let parentFolderId = user.driveFolderId;
    try {
      const accessToken = await GoogleAuth.getValidAccessToken(user);
      const res = await fetch(
        `https://www.googleapis.com/drive/v3/files/${comic.googleFileId}?fields=name,parents`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (res.ok) {
        const data = await res.json();
        if (data.name) fileName = data.name;
        if (data.parents && data.parents[0]) parentFolderId = data.parents[0];
      }
    } catch (err) {
      console.warn('[OmnibusSplit] Could not read source file metadata, falling back to title:', err.message);
    }

    return {
      storage: 'drive',
      filePath: cachedPath,
      fileName: fileName || `${comic.title || 'Omnibus'}.cbz`,
      parentFolderId
    };
  }

  if (comic.filepath && fs.existsSync(comic.filepath)) {
    return {
      storage: 'local',
      filePath: comic.filepath,
      fileName: path.basename(comic.filepath),
      parentFolderId: null
    };
  }

  throw new Error(`Could not access the archive for "${comic.title || comic.id}".`);
}

function pruneOldJobs() {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (job.status !== 'running' && now - job.updatedAt > JOB_TTL_MS) {
      jobs.delete(id);
    }
  }
  try {
    const dir = getJobsDir();
    const files = fs.readdirSync(dir);
    for (const file of files) {
      if (!file.startsWith('omni_') || !file.endsWith('.json')) continue;
      const filePath = path.join(dir, file);
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > JOB_TTL_MS) {
          fs.unlinkSync(filePath);
        }
      } catch (e) {}
    }
  } catch (e) {}
}

const OmnibusManager = {
  /**
   * Starts a background omnibus merge job.
   */
  start(user, { issueIds, omnibusTitle, seriesName }) {
    pruneOldJobs();

    if (!user) {
      throw new Error('User authentication required.');
    }
    if (!Array.isArray(issueIds) || issueIds.length < 2) {
      throw new Error('Please select at least 2 comic issues to merge into an omnibus.');
    }

    const id = newJobId();
    const now = Date.now();
    const job = {
      id,
      type: 'merge',
      userId: user.id,
      issueIds,
      omnibusTitle: (omnibusTitle || '').trim(),
      seriesName: (seriesName || '').trim(),
      status: 'running',
      phase: 'Initializing omnibus creation...',
      percent: 0,
      createdAt: now,
      updatedAt: now,
      result: null,
      error: null
    };

    jobs.set(id, job);
    saveJobToDisk(job);

    // Launch async execution detached from the HTTP request
    this._runMergeJob(user, job).catch((err) => {
      console.error(`[OmnibusManager] Job ${id} fatal error:`, err);
      job.status = 'error';
      job.phase = 'Failed';
      job.error = err.message || 'Unknown error occurred while creating omnibus.';
      job.updatedAt = Date.now();
      saveJobToDisk(job);
    });

    return {
      id: job.id,
      status: job.status,
      phase: job.phase,
      percent: job.percent
    };
  },

  /**
   * Retrieves status of an omnibus job (merge or split).
   */
  getStatus(jobId) {
    const job = getJob(jobId);
    if (!job) return null;
    return {
      id: job.id,
      type: job.type || 'merge',
      status: job.status,
      phase: job.phase,
      percent: job.percent,
      volumes: Array.isArray(job.volumes) ? job.volumes : [],
      result: job.result,
      error: job.error,
      updatedAt: job.updatedAt
    };
  },

  /**
   * Reads the page count of a comic so the UI can offer a volume count.
   * When a valid volumeCount is supplied it also returns the exact per-volume
   * page ranges and file names, so the preview can never drift from the output.
   */
  async inspectComic(user, comicId, volumeCount) {
    if (!user) {
      throw new Error('User authentication required.');
    }
    if (comicId === undefined || comicId === null || comicId === '') {
      throw new Error('Please select an omnibus to split.');
    }

    const comic = Database.getComicById(user.id, comicId) || Database.getComic(comicId);
    if (!comic) {
      throw new Error('Comic not found in library.');
    }

    const location = await resolveComicLocation(user, comic);
    const entries = CBZReader.getArchiveEntries(location.filePath);
    const totalPages = entries.length;

    const requested = parseInt(volumeCount, 10);
    const plan = [];
    if (totalPages >= 2 && Number.isFinite(requested) && requested >= 2) {
      const sourceBase = location.fileName;
      for (const range of planVolumeRanges(totalPages, Math.min(requested, totalPages))) {
        const baseName = buildVolumeBaseName(sourceBase, range.volume);
        plan.push({
          ...range,
          fileName: `${baseName}.cbz`,
          coverFileName: `${baseName}.jpg`
        });
      }
    }

    return {
      comicId: comic.id,
      title: comic.title,
      item: comic.item,
      series: comic.series,
      fileName: location.fileName,
      storage: location.storage,
      size: comic.size || 0,
      totalPages,
      maxVolumes: Math.min(MAX_SPLIT_VOLUMES, totalPages),
      plan
    };
  },

  /**
   * Starts a background job that splits one omnibus into N evenly sized volumes.
   */
  startSplit(user, { comicId, volumeCount, baseTitle }) {
    pruneOldJobs();

    if (!user) {
      throw new Error('User authentication required.');
    }
    if (comicId === undefined || comicId === null || comicId === '') {
      throw new Error('Please select an omnibus to split.');
    }

    const requested = parseInt(volumeCount, 10);
    if (!Number.isFinite(requested) || requested < 2) {
      throw new Error('Please choose at least 2 volumes to split into.');
    }
    if (requested > MAX_SPLIT_VOLUMES) {
      throw new Error(`Please choose ${MAX_SPLIT_VOLUMES} volumes or fewer.`);
    }

    const id = newJobId();
    const now = Date.now();
    const job = {
      id,
      type: 'split',
      userId: user.id,
      comicId,
      volumeCount: requested,
      baseTitle: (baseTitle || '').trim(),
      status: 'running',
      phase: 'Initializing omnibus split...',
      percent: 0,
      volumes: [],
      createdAt: now,
      updatedAt: now,
      result: null,
      error: null
    };

    jobs.set(id, job);
    saveJobToDisk(job);

    // Launch async execution detached from the HTTP request
    this._runSplitJob(user, job).catch((err) => {
      console.error(`[OmnibusSplit] Job ${id} fatal error:`, err);
      job.status = 'error';
      job.phase = 'Split failed';
      job.error = err.message || 'Unknown error occurred while splitting the omnibus.';
      job.updatedAt = Date.now();
      saveJobToDisk(job);
    });

    return {
      id: job.id,
      status: job.status,
      phase: job.phase,
      percent: job.percent
    };
  },

  /**
   * Asynchronous background worker for merging issues.
   */
  async _runMergeJob(user, job) {
    const tempDir = path.join(__dirname, '..', 'data', 'temp_omnibus', job.id);
    fs.mkdirSync(tempDir, { recursive: true });

    try {
      // 1. Fetch comic records in the exact requested order
      job.phase = 'Locating and ordering comic issues...';
      job.percent = 5;
      job.updatedAt = Date.now();

      const issues = [];
      for (const issueId of job.issueIds) {
        const c = Database.getComicById(user.id, issueId) || Database.getComic(issueId);
        if (!c) {
          throw new Error(`Comic issue #${issueId} could not be found in library.`);
        }
        issues.push(c);
      }

      if (issues.length < 2) {
        throw new Error('At least 2 comic issues are required to create an omnibus.');
      }

      // Determine titles and series
      const firstIssue = issues[0];
      const resolvedSeries = (job.seriesName || firstIssue.series || 'Comics').trim();
      
      let baseTitle = (job.omnibusTitle || '').trim();
      if (!baseTitle) {
        baseTitle = `${resolvedSeries} Omnibus`;
      }
      // Strip any trailing archive extension the user may have included
      baseTitle = baseTitle.replace(/\.(cbz|cbr|zip)$/i, '').trim();

      const resolvedTitle = baseTitle;

      // Determine filesystem-safe filename:
      // Replace colons with " - ", remove illegal filename chars < > " / \ | ? *
      const safeFileBase = baseTitle
        .replace(/[:]/g, ' - ')
        .replace(/[<>"\/\\|?*]+/g, '_')
        .replace(/\s+/g, ' ')
        .replace(/^[-_\s]+|[-_\s]+$/g, '')
        .trim();
      const cleanFileName = `${safeFileBase || 'Omnibus'}.cbz`;
      const tempCbzPath = path.join(tempDir, cleanFileName);

      // Determine item label (e.g. "Omnibus", "Omnibus Vol. 01", etc.)
      let resolvedItem = 'Omnibus';
      const volNumMatch = resolvedTitle.match(/omnibus\s*(?:vol(?:ume)?\.?\s*)?([0-9]+|[ivxlcdm]+)/i);
      if (volNumMatch && volNumMatch[1]) {
        resolvedItem = `Omnibus Vol. ${volNumMatch[1]}`;
      }

      // 2. Ensure each comic archive is accessible (cached locally if on Google Drive)
      const cachedFilePaths = [];
      for (let i = 0; i < issues.length; i++) {
        const issue = issues[i];
        job.phase = `Verifying issue ${i + 1} of ${issues.length}: ${issue.title}...`;
        job.percent = 10 + Math.round((i / issues.length) * 25);
        job.updatedAt = Date.now();

        let filePath = null;
        if (issue.googleFileId) {
          filePath = await GoogleDrive.ensureComicCached(user, issue.googleFileId);
        } else if (issue.filepath && fs.existsSync(issue.filepath)) {
          filePath = issue.filepath;
        }

        if (!filePath || !fs.existsSync(filePath)) {
          throw new Error(`Could not access archive for issue: ${issue.title}`);
        }
        cachedFilePaths.push(filePath);
      }

      // 3. Pre-scan total pages across all issues to provide accurate progress
      let totalEstPages = 0;
      const issueArchiveEntries = [];
      for (let i = 0; i < issues.length; i++) {
        const entries = CBZReader.getArchiveEntries(cachedFilePaths[i]);
        issueArchiveEntries.push(entries);
        totalEstPages += entries.length;
      }

      if (totalEstPages === 0) {
        throw new Error('No valid image pages found in the selected comic issues.');
      }

      // 4. Sequential page generator with collision-proof renaming:
      // Format: "0001 - issue01-page-001.jpg"
      let overallPageNum = 0;
      const self = this;

      async function* generateOmnibusPages() {
        for (let i = 0; i < issues.length; i++) {
          const issue = issues[i];
          const entries = issueArchiveEntries[i];
          const filePath = cachedFilePaths[i];

          // Determine issue number label
          const numMatch = (issue.item || issue.title || '').match(/(?:issue|#|\bv)\s*([0-9]+)/i);
          const issueNum = numMatch ? String(numMatch[1]).padStart(2, '0') : String(i + 1).padStart(2, '0');
          const issueLabel = `issue${issueNum}`;

          job.phase = `Unpacking and ordering pages from Issue ${i + 1} of ${issues.length} (${issue.title})...`;
          job.updatedAt = Date.now();

          for (let p = 0; p < entries.length; p++) {
            overallPageNum++;
            const entry = entries[p];
            const originalExt = path.extname(entry.fileName) || '.jpg';
            const originalBase = path.basename(entry.fileName, originalExt);

            // Clean original base name of strange characters
            const cleanOriginalBase = originalBase.replace(/[<>:"/\\|?*]+/g, '_');
            const newName = `${String(overallPageNum).padStart(4, '0')} - ${issueLabel}-${cleanOriginalBase}${originalExt}`;

            const extracted = CBZReader.extractPage(filePath, p + 1);
            if (extracted && extracted.data) {
              yield {
                name: newName,
                data: extracted.data
              };
            }

            job.percent = 35 + Math.round((overallPageNum / totalEstPages) * 45);
            job.updatedAt = Date.now();
          }
        }
      }

      // 5. Stream all pages into the output CBZ archive
      job.phase = 'Repacking all pages into omnibus CBZ archive...';
      job.percent = 80;
      job.updatedAt = Date.now();

      const repackResult = await createStreamingCBZ(tempCbzPath, generateOmnibusPages(), true);
      const stat = fs.statSync(tempCbzPath);

      // 6. Save omnibus in the same folder as the source issues
      let savedComicRecord = null;
      job.phase = 'Saving omnibus to storage folder...';
      job.percent = 88;
      job.updatedAt = Date.now();

      if (firstIssue.googleFileId) {
        // Resolve parent folder of the first issue on Google Drive
        let targetFolderId = user.driveFolderId;
        try {
          const accessToken = await GoogleAuth.getValidAccessToken(user);
          const fileRes = await fetch(
            `https://www.googleapis.com/drive/v3/files/${firstIssue.googleFileId}?fields=parents`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );
          if (fileRes.ok) {
            const fileData = await fileRes.json();
            if (fileData.parents && fileData.parents[0]) {
              targetFolderId = fileData.parents[0];
            }
          }
        } catch (folderErr) {
          console.warn('[Omnibus] Could not query issue parent folder, using default folder:', folderErr.message);
        }

        job.phase = 'Uploading omnibus to Google Drive...';
        job.percent = 92;
        job.updatedAt = Date.now();

        savedComicRecord = await GoogleDrive.uploadComicFile(
          user,
          tempCbzPath,
          cleanFileName,
          resolvedSeries,
          null,
          targetFolderId,
          {
            title: resolvedTitle,
            fileName: cleanFileName,
            series: resolvedSeries,
            item: resolvedItem,
            isVolume: true
          }
        );
      } else if (firstIssue.filepath) {
        // Local filesystem storage: save directly in same folder
        const targetDir = path.dirname(firstIssue.filepath);
        const finalLocalPath = path.join(targetDir, cleanFileName);
        fs.copyFileSync(tempCbzPath, finalLocalPath);

        // Extract first page as cover (max 512px height @ 85% quality JPEG)
        let coverPath = null;
        try {
          const cover = CBZReader.extractPage(finalLocalPath, 1);
          if (cover && cover.data) {
            const coverJpeg = await ComicCompressor.makeCoverJpeg(cover.data, { maxHeight: 512, quality: 85 });
            coverPath = finalLocalPath.replace(/\.[a-zA-Z0-9]+$/i, '.jpg');
            fs.writeFileSync(coverPath, coverJpeg || cover.data);
          }
        } catch (e) {}

        savedComicRecord = Database.saveComic(user.id, {
          title: resolvedTitle,
          series: resolvedSeries,
          item: resolvedItem,
          isVolume: true,
          filepath: finalLocalPath,
          size: stat.size,
          totalPages: overallPageNum,
          coverImage: coverPath ? `/api/comics/cover?path=${encodeURIComponent(coverPath)}` : null,
          modifiedTime: new Date().toISOString()
        });
      } else {
        throw new Error('Unable to determine storage destination for source issues.');
      }

      // 7. Complete job
      job.status = 'done';
      job.percent = 100;
      job.phase = 'Omnibus created successfully!';
      job.updatedAt = Date.now();
      job.result = {
        comic: savedComicRecord,
        title: resolvedTitle,
        fileName: cleanFileName,
        totalPages: overallPageNum,
        fileSize: stat.size,
        issueCount: issues.length,
        issueIds: issues.map((i) => i.id),
        issueTitles: issues.map((i) => i.title)
      };
      saveJobToDisk(job);
    } finally {
      // Clean up temporary workspace directory
      try {
        if (fs.existsSync(tempDir)) {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      } catch (cleanErr) {
        console.warn('[Omnibus] Temp cleanup warning:', cleanErr.message);
      }
    }
  },

  /**
   * Deletes source single issues when confirmed by the user.
   */
  async deleteSingleIssues(user, issueIds) {
    return GoogleDrive.deleteComics(user, issueIds);
  },

  /**
   * Deletes the original omnibus (and its cover) after a successful split.
   */
  async deleteSourceOmnibus(user, comicId) {
    if (!user) {
      throw new Error('User authentication required.');
    }
    if (comicId === undefined || comicId === null || comicId === '') {
      throw new Error('No omnibus specified for deletion.');
    }
    return GoogleDrive.deleteComics(user, [comicId]);
  },

  /**
   * Asynchronous background worker that splits one omnibus into volumes.
   *
   * Each volume is streamed straight from the source archive into its own .cbz
   * (pages are never all held in memory at once), uploaded to the folder that
   * already holds the source omnibus, and given a cover thumbnail built from its
   * own first page. Volumes already written are recorded on the job as we go, so
   * a failure part way through still reports exactly what was produced.
   */
  async _runSplitJob(user, job) {
    const tempDir = getTempDir(job.id);

    try {
      // 1. Locate the source archive and read its page count
      job.phase = 'Locating omnibus archive...';
      job.percent = 2;
      job.updatedAt = Date.now();

      const comic = Database.getComicById(user.id, job.comicId) || Database.getComic(job.comicId);
      if (!comic) {
        throw new Error('The selected omnibus could no longer be found in your library.');
      }

      const location = await resolveComicLocation(user, comic);

      job.phase = 'Reading archive contents...';
      job.percent = 5;
      job.updatedAt = Date.now();

      const entries = CBZReader.getArchiveEntries(location.filePath);
      const totalPages = entries.length;
      if (totalPages < 2) {
        throw new Error('This archive does not contain enough image pages to split.');
      }
      if (job.volumeCount > totalPages) {
        throw new Error(
          `Cannot split ${totalPages} pages into ${job.volumeCount} volumes. Choose ${totalPages} or fewer.`
        );
      }

      // 2. Plan the volume ranges. The base name always comes from the source file
      //    so the outputs read "[existing name] - Vol. 01".
      const sourceBase = job.baseTitle || location.fileName;
      const series = (comic.series || 'Comics').trim();
      const volumePlans = planVolumeRanges(totalPages, job.volumeCount).map((range) => {
        const baseName = buildVolumeBaseName(sourceBase, range.volume);
        return {
          ...range,
          baseName,
          fileName: `${baseName}.cbz`,
          coverFileName: `${baseName}.jpg`
        };
      });

      // 3. Build and upload each volume in turn
      const createdVolumes = [];
      let pagesDone = 0;

      for (let v = 0; v < volumePlans.length; v++) {
        const plan = volumePlans[v];
        const repackBase = 5 + Math.round((pagesDone / totalPages) * 70);

        job.phase = `Building ${plan.fileName} (pages ${plan.startPage}-${plan.endPage})...`;
        job.percent = repackBase;
        job.updatedAt = Date.now();

        // Archives are written without folder structure, so flattened page names
        // can collide. Count occurrences first, then keep the source name only
        // when it is unique inside this volume; everything else falls back to
        // the zero-padded global page number, with a suffix if even that is taken.
        const nameCounts = new Map();
        for (let p = plan.startPage; p <= plan.endPage; p++) {
          const key = flattenPageName(entries[p - 1].fileName).toLowerCase();
          nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
        }
        const usedNames = new Set();

        const tempCbzPath = path.join(tempDir, plan.fileName);

        async function* generateVolumePages() {
          for (let p = plan.startPage; p <= plan.endPage; p++) {
            const entry = entries[p - 1];
            const flatName = flattenPageName(entry.fileName);
            const originalExt = path.extname(flatName) || '.jpg';
            const originalBase = path.basename(flatName, originalExt);
            const paddedLabel = `${String(p).padStart(4, '0')} - `;

            let name = flatName;
            if (nameCounts.get(flatName.toLowerCase()) > 1 || usedNames.has(flatName.toLowerCase())) {
              name = `${paddedLabel}${originalBase}${originalExt}`;
              let suffix = 2;
              while (usedNames.has(name.toLowerCase())) {
                name = `${paddedLabel}${originalBase} (${suffix})${originalExt}`;
                suffix++;
              }
            }
            usedNames.add(name.toLowerCase());

            const extracted = CBZReader.extractPage(location.filePath, p);
            if (extracted && extracted.data) {
              yield { name, data: extracted.data };
            }

            pagesDone++;
            job.percent = 5 + Math.round((pagesDone / totalPages) * 70);
            job.updatedAt = Date.now();
          }
        }

        await createStreamingCBZ(tempCbzPath, generateVolumePages(), true);
        const stat = fs.statSync(tempCbzPath);

        // Cover thumbnail: a copy of this volume's first page at 512px tall @ 85% JPEG
        let coverJpeg = null;
        try {
          const firstPage = CBZReader.extractPage(tempCbzPath, 1);
          if (firstPage && firstPage.data) {
            coverJpeg = await ComicCompressor.makeCoverJpeg(firstPage.data, {
              maxHeight: COVER_MAX_HEIGHT,
              quality: COVER_QUALITY
            });
          }
        } catch (coverErr) {
          console.warn(`[OmnibusSplit] Could not build cover for ${plan.fileName}:`, coverErr.message);
        }

        job.phase = `Uploading ${plan.fileName} to Google Drive...`;
        job.percent = Math.min(99, repackBase + 5);
        job.updatedAt = Date.now();

        let savedComic = null;
        if (location.storage === 'drive') {
          savedComic = await GoogleDrive.uploadComicFile(
            user,
            tempCbzPath,
            plan.fileName,
            series,
            null,
            location.parentFolderId,
            {
              title: plan.baseName,
              fileName: plan.fileName,
              series,
              item: `Vol. ${String(plan.volume).padStart(2, '0')}`,
              isVolume: true
            },
            (upload) => {
              if (upload && upload.total > 0) {
                const ratio = upload.uploaded / upload.total;
                job.percent = Math.min(99, repackBase + 5 + Math.round(ratio * 20));
                job.updatedAt = Date.now();
              }
            },
            // Reuse the thumbnail we already built instead of re-extracting it
            coverJpeg
          );
        } else {
          const targetDir = path.dirname(location.filePath);
          const finalLocalPath = path.join(targetDir, plan.fileName);
          fs.copyFileSync(tempCbzPath, finalLocalPath);

          const coverPath = path.join(targetDir, plan.coverFileName);
          if (coverJpeg) {
            fs.writeFileSync(coverPath, coverJpeg);
          }

          savedComic = Database.saveComic(user.id, {
            title: plan.baseName,
            series,
            item: `Vol. ${String(plan.volume).padStart(2, '0')}`,
            isVolume: true,
            filepath: finalLocalPath,
            size: stat.size,
            totalPages: plan.pageCount,
            coverImage: coverPath,
            modifiedTime: new Date().toISOString()
          });
        }

        // The temp archive has served its purpose
        try {
          if (fs.existsSync(tempCbzPath)) {
            fs.unlinkSync(tempCbzPath);
          }
        } catch (unlinkErr) {
          console.warn('[OmnibusSplit] Temp file cleanup note:', unlinkErr.message);
        }

        createdVolumes.push({
          volume: plan.volume,
          fileName: plan.fileName,
          coverFileName: plan.coverFileName,
          startPage: plan.startPage,
          endPage: plan.endPage,
          pageCount: plan.pageCount,
          fileSize: stat.size,
          comic: savedComic
        });

        // Persist after every volume so a crash cannot lose finished work
        job.volumes = createdVolumes.slice();
        job.updatedAt = Date.now();
        saveJobToDisk(job);
      }

      // 4. Complete
      const totalSize = createdVolumes.reduce((sum, item) => sum + item.fileSize, 0);
      job.status = 'done';
      job.percent = 100;
      job.phase = 'Omnibus split successfully!';
      job.updatedAt = Date.now();
      job.result = {
        sourceComicId: comic.id,
        sourceTitle: comic.title,
        sourceFileName: location.fileName,
        series,
        totalPages,
        volumeCount: createdVolumes.length,
        pagesPerVolume: volumePlans.map((p) => p.pageCount),
        totalSize,
        volumes: createdVolumes
      };
      saveJobToDisk(job);
    } finally {
      try {
        if (fs.existsSync(tempDir)) {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      } catch (cleanErr) {
        console.warn('[OmnibusSplit] Temp cleanup warning:', cleanErr.message);
      }
    }
  }
};

module.exports = OmnibusManager;
