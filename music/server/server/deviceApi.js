import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, BIN_DIR, ROOT_DIR, config } from './config.js';
import binManager from './binManager.js';
import youtubeMusic from './youtubeMusic.js';
import abbClient from './abbClient.js';
import torrentNode from './torrentNode.js';
import { sanitizeTitle, sanitizeSegment, extensionOf } from './libraryParser.js';

const DEVICE_DOWNLOADS_DIR = path.join(DATA_DIR, 'device_downloads');
try {
  fs.mkdirSync(DEVICE_DOWNLOADS_DIR, { recursive: true });
} catch { /* best effort */ }

/** Map of jobId -> job object */
const jobs = new Map();

/** Clean up jobs older than 3 hours */
const JOB_MAX_AGE_MS = 3 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (now - job.createdAt > JOB_MAX_AGE_MS) {
      if (job.stagingDir && fs.existsSync(job.stagingDir)) {
        try { fs.rmSync(job.stagingDir, { recursive: true, force: true }); } catch {}
      }
      jobs.delete(id);
    }
  }
}, 30 * 60 * 1000).unref();

function safePart(str, fallback = 'Unknown') {
  return sanitizeSegment(str || fallback);
}

function nap(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createJob(type, meta = {}) {
  const id = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const stagingDir = path.join(DEVICE_DOWNLOADS_DIR, id);
  fs.mkdirSync(stagingDir, { recursive: true });

  const job = {
    id,
    type,
    status: 'queued', // queued | downloading | processing | ready | error
    phase: 'Queued',
    percent: 0,
    error: null,
    createdAt: Date.now(),
    meta,
    stagingDir,
    files: [] // { index, path, filename, size, localPath }
  };
  jobs.set(id, job);
  return job;
}

/** Run local yt-dlp to download and convert to MP3 */
async function downloadYoutubeToDir(videoId, targetDir, { title, artist, album } = {}) {
  const bin = await binManager.ensureYtDlp();
  const ffmpegDir = binManager.resolveFfmpegDir();
  const ffmpegLocation = ffmpegDir ? ['--ffmpeg-location', ffmpegDir] : [];

  const outTemplate = path.join(targetDir, '%(title)s.%(ext)s');
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--retries', '3',
    '--extract-audio',
    '--audio-format', 'mp3',
    '--audio-quality', '0',
    '--embed-metadata',
    '--embed-thumbnail',
    ...ffmpegLocation,
    '-o', outTemplate,
    `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`
  ];

  await new Promise((resolve, reject) => {
    let errBuf = '';
    binManager.runProcess(bin, args, {
      onStderr: (chunk) => { errBuf += chunk; }
    }).then(resolve, (err) => {
      reject(new Error(errBuf || err.message || 'yt-dlp failed'));
    });
  });

  // Find the produced audio file
  const entries = fs.readdirSync(targetDir);
  const audioFile = entries.find((f) => /\.(mp3|m4a|opus|ogg|flac)$/i.test(f));
  if (!audioFile) {
    throw new Error('yt-dlp finished but no audio file was produced.');
  }

  return path.join(targetDir, audioFile);
}

/** Background processor for single song download */
async function processSongJob(job) {
  try {
    job.status = 'downloading';
    job.phase = 'Downloading audio';
    job.percent = 20;

    const { videoId, title, artist, album } = job.meta;
    const downloadedPath = await downloadYoutubeToDir(videoId, job.stagingDir, { title, artist, album });

    job.percent = 80;
    job.phase = 'Finalizing';

    const ext = extensionOf(downloadedPath) || 'mp3';
    const artistName = safePart(artist, 'Unknown Artist');
    const albumName = safePart(album, 'Singles');
    const cleanTitle = safePart(title || path.basename(downloadedPath, `.${ext}`));
    const finalFilename = `${cleanTitle}.${ext}`;
    const finalPath = path.join(job.stagingDir, finalFilename);

    if (downloadedPath !== finalPath && fs.existsSync(downloadedPath)) {
      fs.renameSync(downloadedPath, finalPath);
    }

    const stat = fs.statSync(finalPath);
    const relPath = `Music/${artistName}/${albumName}/${finalFilename}`;

    job.files = [
      {
        index: 0,
        path: relPath,
        filename: finalFilename,
        size: stat.size,
        localPath: finalPath
      }
    ];

    job.status = 'ready';
    job.phase = 'Ready';
    job.percent = 100;
  } catch (err) {
    console.error(`[DeviceApi] Song download failed for ${job.id}:`, err);
    job.status = 'error';
    job.phase = 'Failed';
    job.error = err.message || 'Download failed';
  }
}

/** Background processor for album download */
async function processAlbumJob(job) {
  try {
    job.status = 'downloading';
    job.phase = 'Fetching tracklist';
    job.percent = 5;

    const { playlistId, browseId, title: albumTitle, artist: albumArtist } = job.meta;
    const albumRef = playlistId || browseId;
    let tracks = await youtubeMusic.albumTracks(albumRef);
    if (!tracks || !tracks.length) {
      throw new Error('No tracks found for this album.');
    }

    const artistName = safePart(albumArtist, 'Unknown Artist');
    const albumName = safePart(albumTitle, 'Album');

    const files = [];
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      const trackNum = String(i + 1).padStart(2, '0');
      job.phase = `Downloading ${i + 1}/${tracks.length}: ${track.title}`;
      job.percent = Math.round(10 + (i / tracks.length) * 80);

      const trackDir = path.join(job.stagingDir, trackNum);
      fs.mkdirSync(trackDir, { recursive: true });

      try {
        const downloadedPath = await downloadYoutubeToDir(track.videoId, trackDir, {
          title: track.title,
          artist: track.artist || albumArtist,
          album: albumTitle
        });

        const ext = extensionOf(downloadedPath) || 'mp3';
        const cleanTrackTitle = safePart(track.title);
        const finalFilename = `${trackNum} ${cleanTrackTitle}.${ext}`;
        const finalPath = path.join(job.stagingDir, finalFilename);

        fs.renameSync(downloadedPath, finalPath);
        const stat = fs.statSync(finalPath);

        files.push({
          index: i,
          path: `Music/${artistName}/${albumName}/${finalFilename}`,
          filename: finalFilename,
          size: stat.size,
          localPath: finalPath
        });
      } catch (err) {
        console.warn(`[DeviceApi] Track ${i + 1} failed: ${err.message}`);
      }
    }

    if (!files.length) {
      throw new Error('Could not download any tracks from this album.');
    }

    job.files = files;
    job.status = 'ready';
    job.phase = 'Ready';
    job.percent = 100;
  } catch (err) {
    console.error(`[DeviceApi] Album download failed for ${job.id}:`, err);
    job.status = 'error';
    job.phase = 'Failed';
    job.error = err.message || 'Album download failed';
  }
}

/** Background processor for audiobook download */
async function processAudiobookJob(job) {
  try {
    job.status = 'downloading';
    job.phase = 'Resolving audiobook';
    job.percent = 10;

    let { postUrl, infoHash, title, author } = job.meta;

    if (postUrl && !infoHash) {
      const detail = await abbClient.fetchDetail(postUrl);
      if (detail) {
        infoHash = detail.infoHash || infoHash;
        title = detail.title || title;
        author = detail.author || author;
      }
    }

    if (!infoHash) {
      throw new Error('AudioBookBay info hash could not be resolved.');
    }

    const magnet = `magnet:?xt=urn:btih:${infoHash}`;
    job.phase = 'Connecting to torrent node';
    job.percent = 20;

    // Contact torrent node to stream the audiobook files
    const targetUrl = `${config.torrent.nodeUrl.replace(/\/+$/, '')}/api/torrent/stream`;
    const res = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: magnet })
    });

    if (!res.ok) {
      throw new Error(`Torrent node failed to resolve torrent (HTTP ${res.status})`);
    }

    const streamData = await res.json();
    const torrentFiles = streamData.files || [];
    const audioFiles = torrentFiles.filter((f) => /\.(mp3|m4b|m4a|aac|flac)$/i.test(f.name));

    if (!audioFiles.length) {
      throw new Error('No audio files found in this torrent.');
    }

    const authorName = safePart(author, 'Unknown Author');
    const bookTitle = safePart(title, 'Audiobook');

    const files = [];
    const baseNodeUrl = config.torrent.nodeUrl.replace(/\/+$/, '');

    for (let i = 0; i < audioFiles.length; i++) {
      const af = audioFiles[i];
      job.phase = `Downloading ${i + 1}/${audioFiles.length}: ${af.name}`;
      job.percent = Math.round(25 + (i / audioFiles.length) * 70);

      const fileUrl = `${baseNodeUrl}/api/torrent/serve/${streamData.streamId}/${af.index}`;
      const fileRes = await fetch(fileUrl);
      if (!fileRes.ok) {
        throw new Error(`Failed to stream file from node: ${fileRes.status}`);
      }

      const cleanName = safePart(af.name);
      const localPath = path.join(job.stagingDir, cleanName);
      const dest = fs.createWriteStream(localPath);
      await new Promise((resolve, reject) => {
        const stream = fileRes.body;
        // Node 18+ web stream to node stream conversion
        const reader = stream.getReader();
        function pump() {
          reader.read().then(({ done, value }) => {
            if (done) {
              dest.end();
              resolve();
              return;
            }
            dest.write(Buffer.from(value));
            pump();
          }).catch(reject);
        }
        pump();
      });

      const stat = fs.statSync(localPath);
      files.push({
        index: i,
        path: `Audiobook/${authorName}/${bookTitle}/${cleanName}`,
        filename: cleanName,
        size: stat.size,
        localPath
      });
    }

    job.files = files;
    job.status = 'ready';
    job.phase = 'Ready';
    job.percent = 100;
  } catch (err) {
    console.error(`[DeviceApi] Audiobook download failed for ${job.id}:`, err);
    job.status = 'error';
    job.phase = 'Failed';
    job.error = err.message || 'Audiobook download failed';
  }
}

/** Mount device routes into Express app */
export function registerDeviceRoutes(app) {
  // 1. Ping
  app.get('/api/device/ping', (req, res) => {
    res.json({
      ok: true,
      name: 'FRAUDIO',
      version: '0.1.3',
      serverTime: Date.now()
    });
  });

  // 2. Search
  app.get('/api/device/search', async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      const kind = String(req.query.kind || req.query.type || 'music').toLowerCase();

      if (!q) {
        return res.json({ ok: true, songs: [], albums: [], artists: [], audiobooks: [] });
      }

      if (kind === 'audiobook' || kind === 'audiobooks') {
        const results = await abbClient.search(q);
        const audiobooks = (results || []).slice(0, 30).map((b) => ({
          id: b.postUrl || b.infoHash || '',
          title: b.title || '',
          author: b.author || '',
          narrator: b.narrator || '',
          infoHash: b.infoHash || '',
          postUrl: b.postUrl || '',
          format: b.format || 'mp3'
        }));
        return res.json({ ok: true, kind: 'audiobook', query: q, audiobooks });
      }

      // Music search via YouTube Music
      const raw = await youtubeMusic.search(q);
      const songs = (raw.songs || []).slice(0, 30).map((s) => ({
        id: s.videoId,
        title: s.title,
        artist: s.artist,
        album: s.album || '',
        duration: s.duration || ''
      }));

      const albums = (raw.albums || []).slice(0, 20).map((a) => ({
        id: a.browseId || a.id || '',
        playlistId: a.playlistId || a.id || '',
        title: a.title,
        artist: a.artist,
        year: a.year || ''
      }));

      const artists = (raw.artists || []).slice(0, 10).map((ar) => ({
        id: ar.channelId || ar.id || '',
        title: ar.title || ar.artist || ''
      }));

      return res.json({
        ok: true,
        kind: 'music',
        query: q,
        songs,
        albums,
        artists
      });
    } catch (err) {
      console.error('[DeviceApi] Search error:', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // 3. Album tracks
  app.get('/api/device/album', async (req, res) => {
    try {
      const id = String(req.query.playlistId || req.query.id || '').trim();
      if (!id) return res.status(400).json({ ok: false, error: 'Missing album or playlist id' });

      const tracks = await youtubeMusic.albumTracks(id);
      return res.json({
        ok: true,
        tracks: (tracks || []).map((t, idx) => ({
          index: t.trackNumber || (idx + 1),
          id: t.videoId,
          title: t.title,
          artist: t.artist,
          duration: t.duration || ''
        }))
      });
    } catch (err) {
      console.error('[DeviceApi] Album tracks error:', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // 4. Artist details
  app.get('/api/device/artist', async (req, res) => {
    try {
      const id = String(req.query.channelId || req.query.id || '').trim();
      if (!id) return res.status(400).json({ ok: false, error: 'Missing channelId' });

      const data = await youtubeMusic.artistBrowse(id);
      return res.json({
        ok: true,
        artist: data.artist || '',
        albums: (data.albums || []).map((a) => ({
          id: a.browseId || a.id || '',
          playlistId: a.playlistId || a.id || '',
          title: a.title,
          year: a.year || ''
        })),
        topSongs: (data.topSongs || []).map((s) => ({
          id: s.videoId,
          title: s.title,
          artist: s.artist,
          duration: s.duration || ''
        }))
      });
    } catch (err) {
      console.error('[DeviceApi] Artist browse error:', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // 5. Trigger download
  app.post('/api/device/download', (req, res) => {
    try {
      const { type, id, title, artist, album, playlistId, browseId, postUrl, infoHash } = req.body || {};
      if (!type) {
        return res.status(400).json({ ok: false, error: 'Missing download type (song, album, or audiobook)' });
      }

      let job;
      if (type === 'song') {
        const videoId = id || req.body.videoId;
        if (!videoId) return res.status(400).json({ ok: false, error: 'Missing videoId for song download' });
        job = createJob('song', { videoId, title, artist, album });
        processSongJob(job);
      } else if (type === 'album') {
        const pId = playlistId || browseId || id;
        if (!pId) return res.status(400).json({ ok: false, error: 'Missing playlistId for album download' });
        job = createJob('album', { playlistId: pId, browseId, title, artist });
        processAlbumJob(job);
      } else if (type === 'audiobook') {
        if (!postUrl && !infoHash) {
          return res.status(400).json({ ok: false, error: 'Missing postUrl or infoHash for audiobook download' });
        }
        job = createJob('audiobook', { postUrl, infoHash, title, author: req.body.author });
        processAudiobookJob(job);
      } else {
        return res.status(400).json({ ok: false, error: `Unsupported type: ${type}` });
      }

      return res.json({
        ok: true,
        jobId: job.id,
        status: job.status,
        phase: job.phase
      });
    } catch (err) {
      console.error('[DeviceApi] Download request error:', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // 6. Job status
  app.get('/api/device/jobs/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) {
      return res.status(404).json({ ok: false, error: 'Job not found' });
    }

    return res.json({
      ok: true,
      id: job.id,
      type: job.type,
      status: job.status,
      phase: job.phase,
      percent: job.percent,
      error: job.error,
      files: job.files.map((f) => ({
        index: f.index,
        path: f.path,
        filename: f.filename,
        size: f.size
      }))
    });
  });

  // 7. Download file from completed job
  app.get('/api/device/jobs/:jobId/file/:fileIndex', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) {
      return res.status(404).send('Job not found');
    }

    const fileIndex = parseInt(req.params.fileIndex, 10);
    const file = job.files.find((f) => f.index === fileIndex);
    if (!file || !file.localPath || !fs.existsSync(file.localPath)) {
      return res.status(404).send('File not found');
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.filename)}"`);
    res.setHeader('Content-Length', file.size);

    const stream = fs.createReadStream(file.localPath);
    stream.pipe(res);
  });

  // 8. Delete / cleanup job
  app.delete('/api/device/jobs/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (job) {
      if (job.stagingDir && fs.existsSync(job.stagingDir)) {
        try { fs.rmSync(job.stagingDir, { recursive: true, force: true }); } catch {}
      }
      jobs.delete(job.id);
    }
    return res.json({ ok: true });
  });
}

export default { registerDeviceRoutes };
