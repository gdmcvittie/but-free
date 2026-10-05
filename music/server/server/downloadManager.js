import path from 'node:path';
import { config, COVERS_DIR } from './config.js';
import db, { newId } from './db.js';
import abbClient from './abbClient.js';
import torrentNode from './torrentNode.js';
import googleDrive from './googleDrive.js';
import googleAuth from './googleAuth.js';
import { broadcast } from './events.js';
import {
  parseAudiobookName,
  sanitizeSegment,
  sanitizeTitle,
  extensionOf
} from './libraryParser.js';

/**
 * Audiobook download pipeline:
 *
 *   AudioBookBay page -> magnet -> remote torrent node -> Google Drive -> library
 *
 * FRAUDIO never runs webtorrent itself. It resolves the release, builds a magnet
 * from the info hash, and hands the job to the audiobook node, which performs
 * the download and the Drive upload. The node reports back over
 * /api/downloads/webhook, and this module turns that into library entries.
 */

/** jobId -> job record */
const jobs = new Map();
/** userId -> [finished job summaries], newest first. */
const history = new Map();
const HISTORY_LIMIT = 60;
const JOB_TTL_MS = 6 * 60 * 60 * 1000;

/** ABB categories that describe genre/language, not a story series. */
const GENRE_CATEGORIES = new Set([
  'adults', 'teen-young-adult', 'teen & young adult', 'children', 'new', 'general-fiction',
  'postapocalyptic', 'action', 'adventure', 'art', 'autobiography-biographies', 'biography',
  'business', 'computer', 'contemporary', 'crime', 'detective', 'education', 'fantasy',
  'historical', 'horror', 'humor', 'language', 'literary fiction', 'literary-fiction',
  'mystery', 'non-fiction', 'philosophy', 'poetry', 'politics', 'psychology', 'religion',
  'romance', 'science', 'science fiction', 'science-fiction', 'self help', 'self-help',
  'short stories', 'short-stories', 'sports', 'technology', 'thriller', 'thriller-suspense',
  'travel', 'true crime', 'true-crime', 'western', 'english', 'erotica', 'smut', 'bdsm',
  'lgbt', 'lgbtq', 'lgbtq+', 'monster romance', 'reverse harem', 'why choose', 'multi-pov',
  'dark romance', 'paranormal', 'urban fantasy', 'epic fantasy', 'fantasy romance',
  // ABB's catch-all buckets, which name no real series.
  'other', 'misc', 'miscellaneous', 'uncategorized', 'various'
]);

/** Category names that are too generic to be a believable series title. */
const WEAK_SERIES = new Set([
  'series', 'book', 'books', 'audiobook', 'audiobooks', 'collection', 'collections',
  'boxset', 'box set', 'trilogy', 'duology', 'saga', 'novel', 'novels', 'fiction',
  'the series', 'complete series'
]);

/** Language labels ABB exposes as categories/tags ("Popular Language" sidebar). */
const LANGUAGE_CATEGORIES = new Set([
  'english', 'dutch', 'french', 'german', 'spanish', 'portuguese', 'italian',
  'polish', 'russian', 'arabic', 'chinese', 'japanese', 'korean', 'hindi',
  'turkish', 'swedish', 'norwegian', 'danish', 'finnish', 'icelandic', 'greek',
  'hebrew', 'czech', 'romanian', 'ukrainian', 'vietnamese', 'thai', 'indonesian',
  'malay', 'tagalog', 'afrikaans', 'latin'
]);

function isSeriesCandidate(value, detail, extraPeople = []) {
  const name = String(value || '').trim();
  if (!name) return false;
  const lower = name.toLowerCase();
  if (GENRE_CATEGORIES.has(lower) || LANGUAGE_CATEGORIES.has(lower) || WEAK_SERIES.has(lower)) return false;
  // "Something Series" is the series marker, not the series name.
  if (/\bseries\b\s*$/i.test(lower)) return false;
  // ABB keywords repeat the author/narrator as tags - those are people, not series.
  const people = [detail?.author, detail?.narrator, ...extraPeople];
  for (const person of people) {
    const p = String(person || '').trim().toLowerCase();
    if (p && p === lower) return false;
  }
  return true;
}

function guessSeries(detail, extraPeople = []) {
  // ABB "Keywords" are the post's own tags - the series tag lives there.
  const fromKeywords = (detail?.keywords || [])
    .map((c) => String(c).trim())
    .filter((c) => isSeriesCandidate(c, detail, extraPeople));
  if (fromKeywords.length) {
    fromKeywords.sort((a, b) => a.length - b.length);
    return fromKeywords[0];
  }
  const candidates = (detail?.categories || [])
    .map((c) => String(c).trim())
    .filter((c) => isSeriesCandidate(c, detail, extraPeople));
  // Prefer the shortest non-genre category: series names are usually terse.
  candidates.sort((a, b) => a.length - b.length);
  return candidates[0] || '';
}

/** "Monster Smash Agency Series" is a marker; the folder should read cleanly. */
function tidySeriesName(value) {
  return String(value || '')
    .replace(/\s*\bseries\b\s*$/i, '')
    .trim();
}

/**
 * AudioBookBay titles are "<Series> <N> - <Author>" and the author repeats as
 * the final dash-separated segment, which the filename parser cannot tell from
 * a real title. Because the ABB page gives us the authoritative author we can
 * strip that trailing segment and fall back to the series name.
 */
function titleWithoutAuthor(parsedTitle, author) {
  const title = String(parsedTitle || '').trim();
  const authorName = String(author || '').trim();
  if (!authorName) return title;

  const lowerTitle = title.toLowerCase();
  const lowerAuthor = authorName.toLowerCase();

  if (lowerTitle === lowerAuthor) return '';
  if (lowerTitle.endsWith(` - ${authorName}`)) {
    return title.slice(0, -(authorName.length + 3)).trim();
  }
  // "Books with the Orc, Kathryn Moon" style leftovers
  if (lowerTitle.endsWith(`, ${authorName}`)) {
    return title.slice(0, -(authorName.length + 2)).trim();
  }
  // "... - Anjet Daanje, David McKay (Translator)" - compare on the leading
  // segment so multi-author releases strip correctly too.
  if (lowerTitle.includes(` - ${lowerAuthor}`)) {
    return title.slice(0, title.toLowerCase().indexOf(` - ${lowerAuthor}`)).trim();
  }
  return title;
}

/**
 * Derives the Drive destination (Author / Series) and display metadata for a
 * release. `partTitle` lets a multi-book torrent override the book title.
 */
export function planUpload(detail, partTitle = '') {
  const fromTitle = parseAudiobookName(detail?.title || '');

  const author = sanitizeSegment(detail?.author || fromTitle.author || 'Unknown Author');
  const parsedSeries = fromTitle.series || guessSeries(detail, [fromTitle.author, fromTitle.title]);
  const series = parsedSeries ? tidySeriesName(parsedSeries) : '';

  // A series release can legitimately be titled just "Series Name 4", in which
  // case the folder already conveys the book and the title should read as the
  // series. Standalone books keep their full title.
  const isSeriesBook = Boolean(series) && fromTitle.seriesIndex != null;

  // Explicit per-part titles (multi-book torrents) win; otherwise derive one.
  // A series book titled just "Series Name 4" adds nothing over the series,
  // so fall back to the series label; a real book title ("Vows of Blood and
  // Deception (The Hirathean Path, Book 2)") must survive.
  let baseTitle = titleWithoutAuthor(fromTitle.title, author);
  if (isSeriesBook && !partTitle && (!baseTitle || baseTitle.toLowerCase() === series.toLowerCase())) baseTitle = '';

  const title = sanitizeTitle(
    partTitle || baseTitle || (isSeriesBook ? series : '') || detail?.title || 'Untitled'
  );

  const seriesIndex = fromTitle.seriesIndex ?? null;
  const narrator = sanitizeSegment(detail?.narrator || '', '');

  return {
    author,
    series,
    title,
    seriesIndex,
    narrator,
    format: String(detail?.format || extensionOf(partTitle) || '').toUpperCase(),
    bitrateKbps: parseInt(String(detail?.bitrate || '').replace(/[^\d]/g, ''), 10) || null,
    abridged: detail?.abridged ?? null
  };
}

function setStatus(jobId, patch) {
  const job = jobs.get(jobId);
  if (!job) return null;
  const isTerminal = (s) => s === 'done' || s === 'error' || s === 'cancelled';
  if (isTerminal(job.status) && patch.status && isTerminal(patch.status) && job.status === patch.status) {
    return job;
  }
  Object.assign(job, patch, { updatedAt: Date.now() });
  broadcast('download_status', { jobId, userId: job.userId, ...publicJob(job) });
  return job;
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    phase: job.phase,
    percent: job.percent,
    message: job.message,
    error: job.error,
    result: job.result,
    postId: job.postId,
    postUrl: job.postUrl,
    title: job.title,
    nodeJobId: job.nodeJobId,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
}

function pushHistory(userId, entry) {
  const list = history.get(userId) || [];
  list.unshift({ ...entry, at: Date.now() });
  history.set(userId, list.slice(0, HISTORY_LIMIT));
}

function prune() {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.status === 'done' || job.status === 'error') {
      if (job.updatedAt < cutoff) jobs.delete(id);
    }
  }
}

/** Finds the local job that is waiting on a given node job id. */
function findByNodeJob(nodeJobId) {
  if (!nodeJobId) return null;
  for (const job of jobs.values()) {
    if (job.nodeJobId === nodeJobId) return job;
  }
  return null;
}

/**
 * Rebuilds a local job for a webhook that arrived after a restart (or after the
 * in-memory record was pruned). The node still remembers the release, so we
 * recover the ABB detail from the stored post URL rather than losing the upload
 * - the bytes are already in Drive by this point and must still be indexed.
 */
async function rehydrateJob(nodeJobId, userId) {
  if (!torrentNode.isConfigured()) return null;

  let remote;
  try {
    remote = await torrentNode.getJob(nodeJobId);
  } catch {
    return null;
  }
  if (!remote || remote.userId !== userId) return null;

  const detail = remote.postUrl
    ? await abbClient.fetchDetail(remote.postUrl).catch(() => null)
    : null;

  const id = newId('dl');
  const job = {
    id,
    userId,
    nodeJobId,
    title: detail?.title || remote.title || 'Audiobook',
    postUrl: remote.postUrl || null,
    postId: remote.postId || null,
    detail,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'downloading',
    percent: 90,
    phase: 'Finishing',
    message: 'Reconnected to the torrent node after a restart…'
  };
  jobs.set(id, job);
  console.warn(`[Download] Recovered job ${nodeJobId} from the torrent node as ${id}.`);
  return job;
}

/** Strips the node's `01 - ` ordering prefix so the library shows a clean title. */
function partDisplayName(fileName) {
  return String(fileName || '')
    .replace(/^\d+\s*-\s*/, '')
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[_.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

let activePollTimer = null;
function ensureActivePolling() {
  if (activePollTimer) return;
  activePollTimer = setInterval(async () => {
    let hasActive = false;
    const userIds = new Set();
    for (const job of jobs.values()) {
      if (job.status !== 'done' && job.status !== 'error' && job.status !== 'cancelled') {
        hasActive = true;
        userIds.add(job.userId);
      }
    }
    if (!hasActive) {
      clearInterval(activePollTimer);
      activePollTimer = null;
      return;
    }
    for (const uid of userIds) {
      await downloadManager.syncFromNode(uid).catch(() => {});
    }
  }, 3000);
}

export const downloadManager = {
  get(jobId) {
    prune();
    return jobs.get(jobId) || null;
  },

  listForUser(userId) {
    prune();
    return Array.from(jobs.values())
      .filter((job) => !userId || job.userId === userId || !job.userId || job.userId === 'default')
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(publicJob);
  },

  history(userId) {
    return history.get(userId) || [];
  },

  /** Mirrors node progress into our own job records so the UI stays live. */
  async syncFromNode(userId) {
    if (!torrentNode.isConfigured()) return;
    let remote;
    try {
      remote = await torrentNode.listJobs(userId);
      if ((!remote || !remote.length) && userId) {
        const all = await torrentNode.listJobs();
        if (all && all.length) {
          remote = all.filter((j) => !j.userId || j.userId === 'default' || j.userId === userId);
        }
      }
    } catch (err) {
      console.warn('[Download] Could not reach the torrent node:', err.message);
      return;
    }

    if (!Array.isArray(remote)) return;

    for (const remoteJob of remote) {
      let job = findByNodeJob(remoteJob.id);

      // If the job isn't in memory (e.g. after server restart), adopt active/queued jobs from node
      if (!job) {
        const isRemoteActive = remoteJob.status === 'downloading'
          || remoteJob.status === 'uploading'
          || remoteJob.status === 'queued'
          || remoteJob.status === 'resolving';

        if (!isRemoteActive) continue;

        const id = newId('dl');
        const phase = remoteJob.status === 'downloading'
          ? 'Downloading'
          : remoteJob.status === 'uploading'
            ? 'Uploading to Drive'
            : remoteJob.status === 'queued'
              ? 'Queued'
              : 'Working';

        job = {
          id,
          userId: userId || remoteJob.userId || 'default',
          nodeJobId: remoteJob.id,
          postId: remoteJob.postId || null,
          postUrl: remoteJob.postUrl || null,
          title: remoteJob.title || 'Audiobook',
          status: remoteJob.status,
          phase,
          percent: remoteJob.percent ?? (remoteJob.status === 'downloading' ? 10 : 0),
          message: remoteJob.message || remoteJob.stage || phase,
          error: remoteJob.error || null,
          result: null,
          detail: {
            title: remoteJob.title,
            author: remoteJob.author,
            series: remoteJob.series,
            seriesIndex: remoteJob.seriesIndex,
            narrator: remoteJob.narrator,
            format: remoteJob.format,
            bitrate: remoteJob.bitrate,
            abridged: remoteJob.abridged,
            cover: remoteJob.coverUrl
          },
          createdAt: remoteJob.createdAt || Date.now(),
          updatedAt: Date.now()
        };
        jobs.set(id, job);
      }

      if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') continue;

      if (remoteJob.status === 'completed') {
        await this.handleWebhook(remoteJob);
        continue;
      }

      if (remoteJob.status === 'error' || remoteJob.status === 'cancelled') {
        await this.handleWebhook(remoteJob);
        continue;
      }

      const phase = remoteJob.status === 'downloading'
        ? 'Downloading'
        : remoteJob.status === 'uploading'
          ? 'Uploading to Drive'
          : remoteJob.status === 'queued'
            ? 'Queued'
            : 'Working';

      setStatus(job.id, {
        status: remoteJob.status,
        phase,
        percent: remoteJob.percent ?? job.percent,
        message: remoteJob.message || remoteJob.stage || phase
      });
    }

    ensureActivePolling();
  },

  /**
   * Starts an audiobook download from an AudioBookBay post URL.
   * Returns immediately with a local job id.
   */
  async start(user, postUrl, { detail: providedDetail = null } = {}) {
    if (!user.audiobooksFolderId) {
      throw new Error('Pick an audiobooks folder in Settings before downloading.');
    }
    if (!torrentNode.isConfigured()) {
      throw new Error('No audiobook torrent node is configured. Set TORRENT_NODE_URL in .env.');
    }
    if (!postUrl) throw new Error('No AudioBookBay post URL was provided.');

    const id = newId('job');
    const job = {
      id,
      userId: user.id,
      nodeJobId: null,
      postId: null,
      postUrl,
      title: 'Resolving release…',
      status: 'queued',
      phase: 'Queued',
      percent: 0,
      message: 'Queued for download…',
      error: null,
      result: null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    jobs.set(id, job);
    broadcast('download_status', { jobId: id, userId: user.id, ...publicJob(job) });

    this._run(job, providedDetail).catch((err) => {
      console.error('[Download] Job crashed:', err.message);
      setStatus(id, {
        status: 'error',
        phase: 'Failed',
        percent: 0,
        message: err.message,
        error: err.message
      });
      pushHistory(job.userId, { jobId: id, title: job.title, status: 'error', error: err.message, postUrl });
    });

    return publicJob(job);
  },

  async _run(job, providedDetail) {
    const { id } = job;

    // ---- 1. Resolve the release -------------------------------------------
    setStatus(id, { status: 'resolving', phase: 'Reading release', percent: 2, message: 'Reading the AudioBookBay release…' });
    const detail = providedDetail || await abbClient.fetchDetail(job.postUrl);
    job.postId = detail.id || null;
    job.title = detail.title || job.title;
    setStatus(id, { title: job.title, percent: 5 });

    if (!detail.infoHash) {
      throw new Error('This release does not expose a torrent info hash, so it cannot be downloaded.');
    }

    // Keep the resolved release so the webhook can build library entries
    // without re-scraping the page.
    job.detail = detail;

    // ---- 2. Hand off to the torrent node ----------------------------------
    setStatus(id, { phase: 'Sending to torrent node', percent: 8, message: 'Sending the download to the torrent node…' });

    const plan = planUpload(detail);
    const user = db.getUser(job.userId);
    const accessToken = await googleAuth.getValidAccessToken(user);
    if (!accessToken) {
      throw new Error('Could not get a Google Drive access token. Reconnect your Drive account in Settings.');
    }

    const callbackOrigin = resolveCallbackOrigin();
    const webhookSecret = process.env.TORRENT_NODE_WEBHOOK_SECRET || (callbackOrigin ? 'fraudio-secret' : null);
    const webhookUrl = publicUrl('/api/downloads/webhook');
    const tokenRefreshUrl = publicUrl('/api/downloads/token-refresh');

    const remoteJob = await torrentNode.enqueue({
      userId: job.userId,
      infoHash: detail.infoHash,
      title: plan.title,
      author: plan.author,
      series: plan.series,
      seriesIndex: plan.seriesIndex,
      narrator: plan.narrator,
      format: plan.format,
      bitrate: detail.bitrate || '',
      abridged: plan.abridged,
      coverUrl: detail.cover || null,
      postUrl: job.postUrl,
      postId: job.postId,
      driveConfig: {
        accessToken,
        rootFolderId: user.audiobooksFolderId,
        ...(tokenRefreshUrl ? { tokenRefreshUrl, webhookSecret } : {})
      },
      ...(webhookUrl ? { webhookUrl, webhookSecret } : {})
    });

    job.nodeJobId = remoteJob.id;
    ensureActivePolling();
    setStatus(id, {
      nodeJobId: remoteJob.id,
      status: 'downloading',
      phase: 'Downloading',
      percent: 10,
      message: 'The torrent node is downloading this audiobook…'
    });

    return { jobId: id, plan };
  },

  /**
   * Called by the node when a job finishes. Turns the uploaded Drive files into
   * library entries - one per uploaded part, so multi-book torrents become
   * separate playable books.
   */
  async handleWebhook(payload) {
    const nodeJobId = payload?.jobId || payload?.id;
    const userId = payload?.userId;
    if (!nodeJobId || !userId) return { handled: false, reason: 'missing jobId/userId' };

    const job = findByNodeJob(nodeJobId) || (await rehydrateJob(nodeJobId, userId));
    if (!job) return { handled: false, reason: 'no matching job' };
    if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') {
      return { handled: true, reason: 'already handled' };
    }

    if (payload.status === 'error') {
      const message = payload.error || 'The torrent node could not finish this download.';
      setStatus(job.id, {
        status: 'error',
        phase: 'Failed',
        percent: 0,
        message,
        error: message
      });
      pushHistory(userId, {
        jobId: job.id,
        title: job.title,
        status: 'error',
        error: message,
        postUrl: job.postUrl
      });
      return { handled: true };
    }

    const results = Array.isArray(payload.results) ? payload.results : [];
    if (!results.length) {
      setStatus(job.id, {
        status: 'error',
        phase: 'Failed',
        message: 'The torrent node finished but uploaded nothing.',
        error: 'No files were uploaded.'
      });
      return { handled: true };
    }

    setStatus(job.id, { status: 'indexing', phase: 'Updating library', percent: 92, message: 'Adding to your library…' });

    const detail = job.detail || {};
    const user = db.getUser(userId);
    if (!user) {
      const message = 'The account that started this download no longer exists.';
      setStatus(job.id, { status: 'error', phase: 'Failed', percent: 100, message, error: message });
      return { handled: true, reason: 'unknown user' };
    }
    const itemIds = [];

    for (const uploaded of results) {
      const partTitle = partDisplayName(uploaded.fileName);
      // For single-file uploads the release title is more accurate than the
      // torrent's raw filename, so only trust the part name for multi-part jobs.
      const partPlan = planUpload(detail, results.length > 1 ? partTitle : '');

      // A "[Books 1-3]" release carries one shared index; offset it per part so
      // each book lands at its true position in the series.
      let seriesIndex = partPlan.seriesIndex;
      if (results.length > 1 && uploaded.partIndex != null && partPlan.seriesIndex != null) {
        seriesIndex = partPlan.seriesIndex + uploaded.partIndex;
      }

      const item = db.upsertItem(userId, {
        kind: 'audiobook',
        googleFileId: uploaded.driveFileId,
        driveFolderId: uploaded.driveFolderId,
        title: partPlan.title,
        author: partPlan.author,
        series: partPlan.series,
        seriesIndex,
        narrator: partPlan.narrator,
        format: partPlan.format || extensionOf(uploaded.fileName).toUpperCase(),
        bitrateKbps: partPlan.bitrateKbps,
        abridged: partPlan.abridged,
        sizeBytes: uploaded.sizeBytes || null,
        drivePath: uploaded.drivePath || partPlan.title,
        coverImage: detail.cover || null
      });
      itemIds.push(item.id);

      if (detail.cover) {
        try {
          await googleDrive.cacheRemoteCover(
            detail.cover,
            `${item.id}-cover`,
            cacheCoverPath(item.id)
          );
        } catch { /* cover art is optional */ }
      }
    }

    const first = db.getItem(itemIds[0]);
    const result = {
      success: true,
      itemIds,
      itemId: itemIds[0],
      googleFileId: first?.googleFileId || null,
      title: first?.title || job.title,
      author: first?.author || '',
      series: first?.series || '',
      drivePath: first?.drivePath || '',
      message: itemIds.length > 1
        ? `Saved ${itemIds.length} books to Drive: ${payload.drivePath || ''}`
        : `Saved to Drive: ${first?.drivePath || ''}`
    };

    setStatus(job.id, {
      status: 'done',
      phase: 'Complete',
      percent: 100,
      message: result.message,
      result
    });

    pushHistory(userId, {
      jobId: job.id,
      title: result.title,
      author: result.author,
      series: result.series,
      status: 'done',
      postUrl: job.postUrl,
      drivePath: result.drivePath,
      itemCount: itemIds.length
    });

    broadcast('library_changed', { userId, reason: 'download' });
    return { handled: true, itemIds };
  },

  /** Cancels a job, both locally and on the node. */
  async cancel(jobId, userId) {
    const job = jobs.get(jobId);
    if (!job) return { cancelled: false, reason: 'Job not found.' };
    if (userId && job.userId !== userId) return { cancelled: false, reason: 'Not your job.' };

    if (job.nodeJobId) {
      try {
        await torrentNode.cancelJob(job.nodeJobId);
      } catch (err) {
        console.warn('[Download] Node cancel failed:', err.message);
      }
    }

    setStatus(jobId, {
      status: 'error',
      phase: 'Cancelled',
      message: 'Download cancelled.',
      error: 'Cancelled by user.'
    });
    return { cancelled: true };
  },

  nodeStatus() {
    if (!torrentNode.isConfigured()) {
      return { configured: false, online: false };
    }
    return { configured: true, url: config.torrent.nodeUrl };
  }
};

/**
 * Absolute URL the node should call back on.
 *
 * A loopback fallback is worse than useless here: the node runs on another
 * machine, so it would accept the job, download for hours, and then fail to
 * deliver the upload. Fail fast instead.
 */
function publicUrl(pathSuffix) {
  const origin = resolveCallbackOrigin();
  if (!origin) return null;
  return `${origin.replace(/\/+$/, '')}${pathSuffix}`;
}

/** Hostnames/addresses the remote torrent node can never reach. */
const UNREACHABLE_HOSTS = new Set([
  'localhost', '0.0.0.0', '::', '[::]',
  '127.0.0.1', '::1', '[::1]',          // node normalises IPv6 hostnames to bracketed form
  '192.168.0.1',                        // documented "no route" address
  '10.0.0.1', '172.16.0.1'              // common router admin pages
]);

function isUnreachableHost(host) {
  const h = String(host || '').trim().toLowerCase();
  if (!h) return true;
  if (UNREACHABLE_HOSTS.has(h)) return true;
  // Any other address inside a private range: LAN-only, so not reachable from
  // the VPS unless the node happens to share that network.
  return (
    /^10\./.test(h)
    || /^192\.168\./.test(h)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
    || /^169\.254\./.test(h)             // link-local
    || /\.local$/.test(h)                // mDNS
  );
}

function resolveCallbackOrigin() {
  let origin = process.env.PUBLIC_URL;
  if (!origin && config.google.redirectUri) {
    try {
      origin = new URL(config.google.redirectUri).origin;
    } catch {
      origin = null;
    }
  }

  if (!origin) return null;

  let host;
  try {
    host = new URL(origin).hostname;
  } catch {
    return null;
  }
  if (isUnreachableHost(host)) {
    return null;
  }
  return origin;
}

function cacheCoverPath(itemId) {
  return path.join(COVERS_DIR, `${itemId}.jpg`);
}

export default downloadManager;