import fs from 'node:fs';
import path from 'node:path';
import { DOWNLOADS_DIR, config } from './config.js';
import db from './db.js';
import googleDrive from './googleDrive.js';
import { ensureYtDlp, resolveFfmpegDir, runProcess } from './binManager.js';
import youtubeApi from './youtubeApi.js';
import { parseBuffer } from 'music-metadata';
import { sanitizeSegment, sanitizeTitle, isImageFile, extensionOf, stripTrackNumberPrefix, inferGenreFromText } from './libraryParser.js';
import { broadcast } from './events.js';
import torrentNode from './torrentNode.js';

/**
 * YouTube Music "New releases" feed for the music library.
 *
 * YouTube Music browse pages are not extractable by yt-dlp (it reports
 * "Unsupported URL" for /browse and misreads /new_releases/albums as a channel
 * tab), so the album grid is scraped out of the server-rendered page instead.
 *
 * The page embeds its state as `initialData.push({ ... data: '\x7b...' })`:
 * an unquoted-key JS object literal whose `data` value is a hex-escaped JSON
 * string. We decode that string and walk the tree for `musicTwoRowItemRenderer`.
 *
 * Downloads then use yt-dlp against the album's OLAK5uy auto-playlist, which
 * yt-dlp does understand -- so only the *listing* is scraped, never the audio.
 */

const FEED_URL = process.env.YTM_NEW_RELEASES_URL
  || 'https://music.youtube.com/new_releases/albums';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const FEED_TTL_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 25000;

let feedCache = { at: 0, albums: null };
let inFlight = null;

// ---------------------------------------------------------------------------
// Page scraping
// ---------------------------------------------------------------------------

/**
 * Decodes a JavaScript string literal in a single pass. Chained `.replace()`
 * calls corrupt escapes here, because decoding `\x5c` emits a backslash that a
 * later pass then re-interprets.
 */
function decodeJsString(literal) {
  return literal.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|[\s\S])/g, (_, g) => {
    if (g[0] === 'x' || g[0] === 'u') return String.fromCharCode(parseInt(g.slice(1), 16));
    return { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' }[g] ?? g;
  });
}

/** Pulls every embedded JSON blob out of the page's initialData payloads. */
function extractEmbeddedJson(html) {
  const roots = [];
  const re = /\bdata:\s*'((?:[^'\\]|\\.)*)'/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      roots.push(JSON.parse(decodeJsString(m[1])));
    } catch {
      // Not every `data:` literal on the page is JSON.
    }
  }
  return roots;
}

/** Depth-first search that returns the first match for `predicate`. */
function findFirst(node, predicate, seen = new WeakSet()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return null;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const entry of node) {
      const hit = findFirst(entry, predicate, seen);
      if (hit) return hit;
    }
    return null;
  }
  if (predicate(node)) return node;
  for (const value of Object.values(node)) {
    const hit = findFirst(value, predicate, seen);
    if (hit) return hit;
  }
  return null;
}

function collectAll(node, predicate, out = [], seen = new WeakSet()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return out;
  seen.add(node);
  if (Array.isArray(node)) {
    node.forEach((entry) => collectAll(entry, predicate, out, seen));
    return out;
  }
  if (predicate(node)) out.push(node);
  Object.values(node).forEach((value) => collectAll(value, predicate, out, seen));
  return out;
}

function textOf(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node.runs)) return node.runs.map((r) => r.text || '').join('').trim();
  if (node.simpleText) return node.simpleText.trim();
  return '';
}

/** YouTube Music orders subtitle runs as [type, " • ", artist]. */
function artistFromSubtitle(subtitle) {
  const runs = subtitle?.runs || [];
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const run = runs[i];
    if (run.navigationEndpoint?.browseEndpoint?.browseId && run.text?.trim()) {
      return { name: run.text.trim(), id: run.navigationEndpoint.browseEndpoint.browseId };
    }
  }
  const plain = textOf(subtitle).replace(/^[^•]+•\s*/, '').trim();
  return { name: plain, id: null };
}

function largestThumb(item) {
  const list = item?.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
  if (!list.length) return null;
  return list.reduce((best, t) => ((t.width || 0) > (best.width || 0) ? t : best), list[0]).url;
}

/** OLAK5uy_... is the album's auto-playlist; yt-dlp can enumerate it. */
function albumPlaylistId(item) {
  const hit = findFirst(item.menu, (n) => typeof n.watchPlaylistEndpoint?.playlistId === 'string');
  return hit?.watchPlaylistId || hit?.watchPlaylistEndpoint?.playlistId || null;
}

function toAlbum(item) {
  const albumId = item.title?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || null;
  const title = textOf(item.title);
  if (!albumId || !title) return null;

  const { name: artist, id: artistId } = artistFromSubtitle(item.subtitle);
  return {
    kind: 'album',
    id: albumId,
    title,
    album: title,
    artist: artist || 'Unknown Artist',
    artistId,
    thumbnail: largestThumb(item),
    coverUrl: largestThumb(item),
    playlistId: albumPlaylistId(item),
    albumUrl: `https://music.youtube.com/browse/${albumId}`
  };
}

// ---------------------------------------------------------------------------
// Search / artist browsing
// ---------------------------------------------------------------------------

/** Search pages are scraped per query and cached briefly so back/forward is cheap. */
const searchCache = new Map();   // query -> { at, result }
const artistCache = new Map();   // channelId -> { at, result }
const SEARCH_TTL_MS = 10 * 60 * 1000;

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`YouTube Music returned HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('YouTube Music did not respond in time.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const KNOWN_TYPES = new Set(['Song', 'Album', 'Artist', 'Video', 'Podcast', 'Episode']);

/** "3:45" / "1:02:03" -> seconds, or null when the run is not a duration. */
function asDuration(label) {
  const text = String(label || '').trim();
  if (!/^\d{1,2}(:\d{2}){1,2}$/.test(text)) return null;
  const parts = text.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((total, n) => total * 60 + n, 0);
}

/** Largest thumbnail from any of the renderer shapes YouTube Music mixes together. */
function bestThumb(renderer) {
  const lists = [
    renderer?.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails,
    renderer?.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails,
    renderer?.thumbnail?.thumbnails
  ].filter(Array.isArray);
  if (!lists.length) return null;
  const all = lists.flat();
  if (!all.length) return null;
  return all.reduce((best, t) => ((t.width || 0) > (best.width || 0) ? t : best), all[0]).url || null;
}

/** The row's own video id, wherever this particular shape happens to put it. */
function rowVideoId(renderer) {
  return renderer?.playlistItemData?.videoId
    || renderer?.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer
      ?.playNavigationEndpoint?.watchEndpoint?.videoId
    || renderer?.navigationEndpoint?.watchEndpoint?.videoId
    || renderer?.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]
      ?.navigationEndpoint?.watchEndpoint?.videoId
    || null;
}

/** The album auto-playlist, which is what yt-dlp can actually enumerate. */
function rowPlaylistId(renderer) {
  const overlay = renderer?.overlay?.musicItemThumbnailOverlayRenderer?.content
    ?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchPlaylistEndpoint?.playlistId;
  if (typeof overlay === 'string' && overlay) return overlay;
  const hit = findFirst(renderer.menu, (n) => typeof n.watchPlaylistEndpoint?.playlistId === 'string');
  return hit?.watchPlaylistId || hit?.watchPlaylistEndpoint?.playlistId || null;
}

/**
 * The MPREb album id, which lives on the row's own navigationEndpoint.
 * Deliberately *not* searched for deeper in the row: "more from this album" links
 * would otherwise be matched and paired with the wrong playlist.
 */
function rowAlbumId(renderer) {
  const own = renderer?.navigationEndpoint?.browseEndpoint?.browseId;
  return typeof own === 'string' && own.startsWith('MPREb') ? own : null;
}

/** The UC channel id, present on the artist run of a subtitle or title link. */
function rowChannelId(renderer) {
  const hit = findFirst(
    renderer?.flexColumns || [],
    (n) => typeof n.browseId === 'string' && n.browseId.startsWith('UC')
  );
  return hit?.browseId || null;
}

/**
 * Parses one `musicResponsiveListItemRenderer` (the shape used for songs, albums and
 * artists in search results) into whichever kind it actually is.
 *
 * The result type is the first run of the second flex column that names a known
 * type - "Song", "Album", "Artist". Artist pages omit it entirely, so rows that
 * carry a video id are treated as songs.
 */
function toListItem(renderer) {
  const columns = (renderer.flexColumns || [])
    .map((c) => c.musicResponsiveListItemFlexColumnRenderer?.text)
    .filter(Boolean);
  const metaRuns = columns[1]?.runs || [];
  const titleRuns = columns[0]?.runs || [];
  const title = textOf(columns[0]);
  if (!title) return null;

  const typeRun = metaRuns.find((r) => KNOWN_TYPES.has(String(r.text || '').trim()));
  const videoId = rowVideoId(renderer);
  const type = typeRun ? String(typeRun.text).trim() : (videoId ? 'Song' : '');

  // Runs after the type run hold the artist, the year and/or the duration.
  const afterType = typeRun ? metaRuns.slice(metaRuns.indexOf(typeRun) + 1) : metaRuns;
  const channelId = rowChannelId(renderer);
  const artistRun = afterType.find((r) => r.navigationEndpoint?.browseEndpoint?.browseId?.startsWith('UC'))
    || metaRuns.find((r) => r.navigationEndpoint?.browseEndpoint?.browseId?.startsWith('UC'));
  const durationSec = afterType.reduce((best, r) => asDuration(r.text) ?? best, null);
  const albumId = rowAlbumId(renderer);
  const albumRun = (columns[2]?.runs || []).find(
    (r) => r.navigationEndpoint?.browseEndpoint?.browseId?.startsWith('MPREb')
  ) || metaRuns.find((r) => r.navigationEndpoint?.browseEndpoint?.browseId?.startsWith('MPREb'));
  const textOnly = (runs) => (runs || [])
    .filter((r) => !r.navigationEndpoint && !KNOWN_TYPES.has(String(r.text || '').trim()) && r.text?.trim() !== '•')
    .map((r) => r.text.trim());

  const base = {
    title,
    type,
    thumbnail: bestThumb(renderer),
    durationSec,
    videoId
  };

  if (type === 'Song') {
    return {
      ...base,
      kind: 'song',
      // Search song rows carry no artist link - YouTube Music only shows
      // title/type/duration/plays. The real artist arrives from the file's own
      // tags when the track is downloaded.
      artist: artistRun?.text?.trim() || '',
      artistId: channelId || artistRun?.navigationEndpoint?.browseEndpoint?.browseId || null,
      album: albumRun?.text?.trim() || textOnly(columns[2]?.runs).filter(Boolean)[0] || '',
      albumId: albumRun?.navigationEndpoint?.browseEndpoint?.browseId || albumId || null,
      playlistId: rowPlaylistId(renderer)
    };
  }

  if (type === 'Artist' && channelId) {
    return {
      ...base,
      kind: 'artist',
      channelId,
      subscribers: textOnly(afterType).join(' ') || null
    };
  }

  if (type === 'Album' && albumId) {
    return {
      ...base,
      kind: 'album',
      id: albumId,
      album: title,
      artist: pickName(artistRun?.text, ...textOnly(afterType)) || '',
      artistId: channelId || artistRun?.navigationEndpoint?.browseEndpoint?.browseId || null,
      year: textOnly(afterType).find((t) => isYearLike(t)) || null,
      playlistId: rowPlaylistId(renderer)
    };
  }

  return null;
}

/** The "Top result" card: an artist (or album/song) plus one featured track. */
function toCard(renderer) {
  const shelf = renderer.musicCardShelfRenderer;
  if (!shelf) return null;

  const titleRuns = shelf.title?.runs || [];
  const heading = textOf(shelf.title);
  const browseId = titleRuns[0]?.navigationEndpoint?.browseEndpoint?.browseId || null;
  const pageType =
    titleRuns[0]?.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs
      ?.browseEndpointContextMusicConfig?.pageType || '';

  const subtitleRuns = shelf.subtitle?.runs || [];
  const isArtist = pageType.endsWith('ARTIST') || subtitleRuns[0]?.text?.trim() === 'Artist';
  const featured = (shelf.contents || [])
    .map((c) => toListItem(c.musicResponsiveListItemRenderer))
    .find(Boolean);

  if (isArtist && browseId?.startsWith('UC')) {
    return {
      kind: 'artist',
      channelId: browseId,
      title: heading,
      thumbnail: bestThumb(shelf),
      subscribers: subtitleRuns.map((r) => r.text).join('').replace(/^[^•]*•\s*/, '').trim(),
      featured
    };
  }

  // A card that is really an album or song - fold it into the normal lists.
  if (browseId?.startsWith('MPREb')) {
    return {
      kind: 'album',
      id: browseId,
      title: heading,
      artist: subtitleRuns.find((r) => r.navigationEndpoint)?.text?.trim() || '',
      thumbnail: bestThumb(shelf),
      playlistId: featured?.playlistId || null
    };
  }
  if (featured) return featured;
  return null;
}

/** Splits scraped results into deduped songs / artists / albums. */
function partition(roots) {
  const songs = [];
  const artists = [];
  const albums = [];
  const seen = { song: new Set(), artist: new Set(), album: new Set() };

  const push = (item) => {
    if (!item) return;
    const key = item.kind === 'song' ? item.videoId
      : item.kind === 'artist' ? item.channelId
        : item.id;
    if (!key || seen[item.kind].has(key)) return;
    seen[item.kind].add(key);
    ({ song: songs, artist: artists, album: albums })[item.kind].push(item);
  };

  for (const root of roots) {
    for (const wrapper of collectAll(root, (n) => Boolean(n.musicResponsiveListItemRenderer))) {
      push(toListItem(wrapper.musicResponsiveListItemRenderer));
    }
    for (const wrapper of collectAll(root, (n) => Boolean(n.musicCardShelfRenderer))) {
      const card = toCard(wrapper);
      // The card's featured track is already returned by the list pass above.
      if (card?.kind !== 'song') push(card);
    }
    for (const wrapper of collectAll(root, (n) => Boolean(n.musicTwoRowItemRenderer))) {
      push(toAlbum(wrapper.musicTwoRowItemRenderer));
    }
  }

  return {
    songs: songs.filter((s) => s.videoId),
    artists: artists.filter((a) => a.channelId),
    // An MPREb album id is enough - the album page is resolved to its OLAK
    // playlist lazily when the tracks are first listed.
    albums: albums.map((a) => ({ ...a, downloadable: Boolean(a.playlistId || a.id) }))
  };
}

/** Searches YouTube Music for songs, artists and albums. */
export async function search(query, { force = false } = {}) {
  const q = String(query || '').trim();
  if (!q) throw new Error('Enter something to search for.');
  if (q.length > 120) throw new Error('Search text is too long.');

  const key = q.toLowerCase();
  const cached = searchCache.get(key);
  if (!force && cached && Date.now() - cached.at < SEARCH_TTL_MS) return cached.result;

  const html = await fetchHtml(`https://music.youtube.com/search?q=${encodeURIComponent(q)}`);
  const result = partition(extractEmbeddedJson(html));
  searchCache.set(key, { at: Date.now(), result });

  console.log(`[YouTubeMusic] search "${q}": ${result.songs.length} songs, ${result.artists.length} artists, ${result.albums.length} albums`);
  return result;
}

/**
 * An artist's page: their songs and albums. Artists live at /channel/<UC…>, which
 * server-renders the same renderer shapes as search.
 */
export async function artistBrowse(channelId, { force = false } = {}) {
  const id = String(channelId || '').trim();
  if (!/^UC[\w-]{20,}$/.test(id)) throw new Error('That does not look like a channel id.');

  const cached = artistCache.get(id);
  if (!force && cached && Date.now() - cached.at < SEARCH_TTL_MS) return cached.result;

  const html = await fetchHtml(`https://music.youtube.com/channel/${encodeURIComponent(id)}`);
  const roots = extractEmbeddedJson(html);
  const result = partition(roots);
  // The channel page has no artist row like search does, so the name comes from the
  // page title ("... - YouTube Music") or from the most common credited artist.
  const pageTitle = /<title[^>]*>([^<]+)<\/title>/i.exec(html)?.[1] || '';
  const fromTitle = pageTitle.replace(/\s*-\s*YouTube Music\s*$/i, '').trim();
  const credited = (result.songs[0]?.artist || result.albums[0]?.artist || '').trim();
  result.artist = {
    channelId: id,
    title: fromTitle && !/^YouTube Music$/i.test(fromTitle) ? fromTitle : (credited || id),
    thumbnail: result.albums[0]?.coverUrl || result.songs[0]?.thumbnail || null,
    subscribers: result.artists[0]?.subscribers || null
  };

  artistCache.set(id, { at: Date.now(), result });
  return result;
}

async function fetchFeedHtml() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(FEED_URL, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`YouTube Music returned HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('YouTube Music did not respond in time.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Newest-release albums, cached briefly so scrolling does not re-scrape. */
export async function newReleases({ force = false } = {}) {
  if (!force && feedCache.albums && Date.now() - feedCache.at < FEED_TTL_MS) {
    return feedCache.albums;
  }
  // Collapse concurrent refreshes into one request.
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const html = await fetchFeedHtml();
    const roots = extractEmbeddedJson(html);
    const renderers = collectAll(roots, (n) => Boolean(n.musicTwoRowItemRenderer));
    const albums = [];
    const seen = new Set();
    for (const wrapper of renderers) {
      const album = toAlbum(wrapper.musicTwoRowItemRenderer);
      if (!album || seen.has(album.id)) continue;
      seen.add(album.id);
      albums.push(album);
    }
    if (!albums.length) {
      throw new Error('No albums found in the YouTube Music new-releases page. The page layout may have changed.');
    }
    feedCache = { at: Date.now(), albums };
    return albums;
  })().finally(() => { inFlight = null; });

  return inFlight;
}

// ---------------------------------------------------------------------------
// Track listing + download (yt-dlp)
// ---------------------------------------------------------------------------

function parseJsonLines(stdout) {
  return (stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

/**
 * Runs a yt-dlp command and collects stdout.
 *
 * `runProcess` resolves with only `{ code }` and streams stdout to the
 * `onStdout` callback, so anything that needs the output has to buffer it here.
 * yt-dlp interleaves progress lines, which `parseJsonLines` filters out.
 */
async function collectJson(bin, args) {
  let buffer = '';
  try {
    await runProcess(bin, args, { onStdout: (chunk) => { buffer += chunk; } });
  } catch (err) {
    throw new Error(`yt-dlp failed: ${err.message}`);
  }
  return parseJsonLines(buffer);
}

function albumArgs(playlistId) {
  return [
    '--flat-playlist', '--dump-json', '--no-warnings',
    `https://music.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`
  ];
}

/**
 * Some search rows expose only the MPREb album id and no OLAK playlist. Resolve
 * the playlist by fetching the album page and reading the first OLAK5uy id out of
 * the embedded JSON; yt-dlp can't browse these pages directly but the id is plain
 * text in the initialData blob.
 */
const playlistIdCache = new Map(); // MPREb -> OLAK5uy

async function resolvePlaylistId(albumOrPlaylistId) {
  const value = String(albumOrPlaylistId || '').trim();
  if (/^OLAK5uy_/i.test(value)) return value;
  if (!/^MPREb_/.test(value)) return value;
  if (playlistIdCache.has(value)) return playlistIdCache.get(value);
  try {
    const html = await fetchHtml(`https://music.youtube.com/browse/${encodeURIComponent(value)}`);
    const m = /OLAK5uy_[A-Za-z0-9_-]{10,}/.exec(html);
    const found = m ? m[0] : null;
    if (found) playlistIdCache.set(value, found);
    return found;
  } catch {
    return null;
  }
}

/** Track listing for one album, via its OLAK5uy auto-playlist. */
export async function albumTracks(playlistId) {
  if (!playlistId) throw new Error('playlistId is required.');
  const resolved = await resolvePlaylistId(playlistId);
  if (!resolved) throw new Error('Could not find a track list for this album.');
  if (torrentNode.isConfigured()) {
    try {
      const remote = await torrentNode.getRemoteTracks(resolved);
      if (remote && remote.length) return remote;
    } catch (err) {
      console.warn('[YouTubeMusic] Remote node tracks listing fallback to local:', err.message);
    }
  }
  const bin = await ensureYtDlp();
  const entries = await collectJson(bin, albumArgs(resolved));

  return entries.map((entry, index) => ({
    videoId: entry.id,
    title: stripTrackNumberPrefix(entry.title) || `Track ${index + 1}`,
    durationSec: Number.isFinite(entry.duration) ? entry.duration : null,
    trackNumber: index + 1,
    thumbnail: entry.thumbnail || null
  }));
}

// ---------------------------------------------------------------------------
// YouTube Music playlists (paste-a-URL imports)
// ---------------------------------------------------------------------------

// `LM` (Liked Music) is a two-character id, so it must stay short.
const PLAYLIST_ID_RE = /^[A-Za-z][\w-]{1,}$/;
// Safety cap so a giant "likes" playlist cannot flood the queue or Drive.
const MAX_PLAYLIST_TRACKS = 500;

/**
 * yt-dlp auth args for a signed-in user. The Liked Music playlist (`LM`) and
 * age/region-gated tracks only resolve when YouTube recognises the request as
 * coming from the account, i.e. with cookies. A per-account file (Settings)
 * wins over the server-wide `YTM_COOKIES_FILE`; `--cookies-from-browser` is the
 * convenience fallback where it works (Chrome can lock its cookie DB while
 * running, and Edge encrypts with DPAPI app-bound, so a cookies.txt file is the
 * portable answer).
 */
function ytAuthArgs(userId) {
  const settings = userId ? db.getSettings(userId) : {};
  const file = String(settings.youtubeCookiesFile || config.music.cookiesFile || '').trim();
  if (file) {
    const resolved = path.resolve(file);
    if (!fs.existsSync(resolved)) {
      throw new Error(`YouTube cookies file not found: ${resolved}`);
    }
    return ['--cookies', resolved];
  }
  const browser = String(settings.youtubeCookiesBrowser || '').trim().toLowerCase();
  return browser ? ['--cookies-from-browser', browser] : [];
}

// An auth-shaped yt-dlp error: something a plain request could never answer.
// "does not exist" - YouTube reports private/`LM` playlists that way to
// anonymous callers. "requested format is not available" is how a bot-check
// or age gate surfaces after the player response came back filtered - the same
// video resolves fine with cookies.
const AUTH_SUSPECT_RE = /sign in|not a bot|cookies|age|private|does not exist|login|premium|authentication|account|requested format is not available/i;

// Transient failures: rate limiting / PO-token churn that a short wait clears.
// A resumed queue firing right after a crash is the classic trigger.
const TRANSIENT_RE = /requested format is not available|not a bot|http error 4(?:03|29)|throttl/i;

const nap = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Once an anonymous attempt has been bot-checked and cookies fixed it, start
// subsequent attempts signed for a while: re-probing anonymously per track just
// burns time on the same wall. Time-boxed in case the session ages out.
let cookiesWorkHintUntil = 0;
const COOKIES_HINT_MS = 15 * 60 * 1000;

/**
 * Runs yt-dlp with an anonymous attempt first and a cookie attempt second,
 * escalating only when the failure looks auth-shaped (bot check, age gate,
 * private playlist, "no formats"). A stale/partial signed-in context can
 * itself be gated, so cookies never lead by default - unless a recent cookie
 * rescue proved this IP is being bot-checked anonymously, in which case
 * attempts start with cookies for a while (`forceAuth` skips straight there,
 * e.g. private `LM` listings that never answer anonymously).
 * Resolves with full stdout; throws with the real ERROR line.
 */
async function runYt(bin, args, { authArgs = [], onStdout, forceAuth = false } = {}) {
  const attempt = (withAuth) => new Promise((resolve, reject) => {
    let out = '';
    let errBuf = '';
    runProcess(bin, [...args, ...(withAuth ? authArgs : [])], {
      onStdout: (chunk) => { out += chunk; onStdout?.(chunk); },
      onStderr: (chunk) => { errBuf += chunk; }
    }).then(
      () => resolve(out),
      () => {
        const detail = errBuf.split(/\r?\n/).map((l) => l.trim()).filter((l) => /ERROR/i.test(l)).pop() || 'yt-dlp failed';
        const err = new Error(detail);
        err.authSuspect = AUTH_SUSPECT_RE.test(detail);
        reject(err);
      }
    );
  });

  const cookieFirst = authArgs.length > 0 && (forceAuth || Date.now() < cookiesWorkHintUntil);
  const order = cookieFirst ? [true, false] : [false, true];

  let lastErr = null;
  for (const withAuth of order) {
    if (withAuth && !authArgs.length) continue;
    try {
      const out = await attempt(withAuth);
      if (withAuth && lastErr?.authSuspect) {
        // The fallback is what worked - ride it for a while.
        cookiesWorkHintUntil = Date.now() + COOKIES_HINT_MS;
      }
      return out;
    } catch (err) {
      lastErr = err;
      // "Video unavailable" and friends won't change shape between passes -
      // don't burn a second attempt on them.
      if (!err.authSuspect) break;
    }
  }
  throw lastErr;
}

/** Extract the `list=` id from a pasted URL, or accept a bare id. */
export function parsePlaylistRef(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Paste a YouTube Music playlist URL.');
  if (raw.length <= 64 && PLAYLIST_ID_RE.test(raw)) return raw;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('That does not look like a playlist URL.');
  }
  const list = url.searchParams.get('list');
  if (!list || !PLAYLIST_ID_RE.test(list)) throw new Error('No playlist id found in that URL.');
  return list;
}

/**
 * Resolves a playlist for preview: title plus a cheap flat track list (ids and
 * names only - yt-dlp does not open every video, so this stays fast even for
 * 500-track playlists). Private catalogs like Liked Music (`LM`) need the
 * account's cookies, so the caller's settings are consulted here.
 */
export async function playlistPreview(listId, { force = false, userId = null } = {}) {
  // Keyed by user as well: `LM` resolves to a different list per account, and
  // cookies make even public-looking results account-specific.
  const key = `pl:${userId || 'anon'}:${listId}`;
  if (!force) {
    const cached = searchCache.get(key);
    if (cached && Date.now() - cached.at < SEARCH_TTL_MS) return cached.result;
  }
const authArgs = ytAuthArgs(userId);
  if (!authArgs.length && listId === 'LM') {
    throw new Error('Liked Music is private to your YouTube account - add YouTube cookies in Settings to import it.');
  }
  if (torrentNode.isConfigured() && listId !== 'LM') {
    try {
      const remote = await torrentNode.getRemoteTracks(listId);
      if (remote && remote.length) {
        const result = {
          playlistId: listId,
          title: 'YouTube playlist',
          uploader: '',
          count: remote.length,
          tracks: remote
        };
        searchCache.set(key, { at: Date.now(), result });
        return result;
      }
    } catch (err) {
      console.warn('[YouTubeMusic] Remote node playlist preview fallback to local:', err.message);
    }
  }

  const bin = await ensureYtDlp();
  const url = `https://music.youtube.com/playlist?list=${encodeURIComponent(listId)}`;
  // Anonymous first; `LM` reports "does not exist" without a session, which
  // the retry recognises as auth-shaped and presents cookies.
  let out;
  try {
    out = await runYt(bin, ['--flat-playlist', '-J', '--no-warnings', url], { authArgs });
  } catch (err) {
    const hint = /DPAPI|copy Chrome|could not copy|app-bound/i.test(err.message)
      ? ' - Chrome/Edge encrypt their cookie store against Windows, so "cookies from browser" fails; export a cookies.txt file and use the Cookies file setting instead.'
      : '';
    throw new Error(`Could not read that playlist: ${err.message}${hint}`);
  }

let data;
  try {
    // yt-dlp can print stray noise before the JSON blob; parse from the first brace.
    data = JSON.parse(out.slice(out.indexOf('{')));
  } catch {
    throw new Error('Could not read that playlist - it may be private or deleted.');
  }

  const seen = new Set();
  const allTracks = (Array.isArray(data.entries) ? data.entries : [])
    .map((entry, index) => {
      const videoId = typeof entry?.id === 'string' ? entry.id : null;
      if (!videoId || /^\d+$/.test(videoId) || seen.has(videoId)) return null;
      seen.add(videoId);
      return {
        videoId,
        title: entry.title || `Track ${index + 1}`,
        durationSec: Number.isFinite(entry.duration) ? entry.duration : null,
        thumbnail: Array.isArray(entry.thumbnails) ? entry.thumbnails[entry.thumbnails.length - 1]?.url : null
      };
    })
    .filter(Boolean);
  const tracks = allTracks.slice(0, MAX_PLAYLIST_TRACKS);

  const result = {
    playlistId: listId,
    title: data.title || 'YouTube playlist',
    uploader: data.uploader || data.channel?.name || '',
    count: allTracks.length,
    // Liked libraries can be huge; the import is capped so one paste cannot
    // flood the queue or Drive. The UI says so rather than silently shorting.
    truncated: allTracks.length > tracks.length,
    tracks
  };
  if (!tracks.length) throw new Error('That playlist has no downloadable tracks.');
  searchCache.set(key, { at: Date.now(), result });
  return result;
}

function safeName(value, fallback) {
  const cleaned = sanitizeSegment(value, fallback);
  return cleaned.replace(/[<>:"/\\|?*]/g, '_').slice(0, 120) || fallback;
}

// A bare "2013" is a release year, not an artist or album name. Search rows and
// album subtitles expose years in the same slots the parser reads artists from,
// so every name that ends up in a folder path is screened with this.
function isYearLike(value) {
  return /^(19|20)\d{2}$/.test(String(value || '').trim());
}

/** First candidate that is neither empty nor a year, or null. */
function pickName(...candidates) {
  for (const value of candidates) {
    const text = String(value || '').trim();
    if (text && !isYearLike(text)) return text;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Download quality: yt-dlp's --audio-quality goes straight through to the
// LAME encoder we already invoke for mp3 - it accepts the VBR scale
// ('0' best/largest .. '9' smallest, roughly '4' ~165k) or a plain bitrate
// like '160K'. Non-mp3 modes keep yt-dlp's native best stream untouched.
// ---------------------------------------------------------------------------

const MP3_QUALITY_ARGS = {
  v0: '0', v2: '2', v4: '4', v6: '6', v8: '8',
  '320k': '320K', '192k': '192K', '160k': '160K', '128k': '128K', '96k': '96K'
};

const AUDIO_FORMAT_ARGS = {
  mp3: ['-x', '--audio-format', 'mp3'],
  m4a: ['-f', 'bestaudio[ext=m4a]/bestaudio'],
  opus: ['-f', 'bestaudio'],
  best: ['-f', 'bestaudio']
};

const DOWNLOAD_AUDIO_EXT = new Set(['mp3', 'm4a', 'mp4', 'aac', 'opus', 'ogg', 'webm']);

const AUDIO_MIME_BY_EXT = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  opus: 'audio/ogg',
  ogg: 'audio/ogg',
  webm: 'audio/webm'
};

/** Resolve the two download settings into concrete yt-dlp args. */
function audioFormatArgs(userId) {
  const settings = db.getSettings(userId);
  const fmt = AUDIO_FORMAT_ARGS[settings.musicAudioFormat] ? settings.musicAudioFormat : 'mp3';
  if (fmt !== 'mp3') return { fmt, args: AUDIO_FORMAT_ARGS[fmt] };
  const quality = MP3_QUALITY_ARGS[settings.musicAudioQuality] || MP3_QUALITY_ARGS.v4;
  return { fmt, args: [...AUDIO_FORMAT_ARGS.mp3, '--audio-quality', quality] };
}

/**
 * Downloads a set of tracks with yt-dlp and uploads them into the user's music
 * Drive folder as `Artist/Album/NN Title.<ext>` - mp3 at the configured LAME
 * quality (Settings), or the native opus/m4a stream with no re-encode.
 *
 * Shared by album downloads and single-song saves. `meta` supplies the folder
 * path and the fallback tags; per-track tags from the file always win.
 *
 * Returns the destination folders. Throws if no music folder is selected.
 */
/**
 * Normalizes a song title or album name for fuzzy duplicate comparison.
 * Strips release tags, video qualifiers, remaster suffixes, punctuation, and diacritics.
 */
export function normalizeForCompare(str) {
  if (!str) return '';
  return String(str)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[\(\[](feat\.?|ft\.?)\s+[^)\]]+[\)\]]/gi, '')
    .replace(/[\(\[](official\s*(music\s*)?video|official\s*audio|lyrics?|visualizer|audio|video|explicit|clean|extended\s*mix|bonus\s*track)[\)\]]/gi, '')
    .replace(/[\(\[](remaster(ed)?(\s*\d+)?|\d+\s*remaster(ed)?|deluxe(\s*edition)?|anniversary(\s*edition)?)[\)\]]/gi, '')
    .replace(/\s*[-–—]\s*(remaster(ed)?(\s*\d+)?|\d+\s*remaster(ed)?|live(\s*at\s*[^)]+)?)\s*$/i, '')
    .replace(/&/g, 'and')
    .replace(/[’‘`"']/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalizes artist name for duplicate comparison.
 */
export function normalizeArtist(str) {
  if (!str) return '';
  let s = String(str)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  s = s.replace(/^the\s+/, '');
  s = s.replace(/\s*(feat\.?|ft\.?)\s+.*$/i, '');
  s = s.replace(/&/g, 'and');
  s = s.replace(/[’‘`"']/g, '');
  s = s.replace(/[^a-z0-9\s]/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Checks if a candidate track matches a library track.
 */
export function isSameTrack(candidate, libraryTrack, meta = {}) {
  if (!candidate || !libraryTrack) return false;
  const candTitle = normalizeForCompare(candidate.title);
  const libTitle = normalizeForCompare(libraryTrack.title);
  if (!candTitle || !libTitle) return false;

  const titleMatches = candTitle === libTitle;
  if (!titleMatches) return false;

  const candArtist = normalizeArtist(candidate.artist || meta.artist);
  const libArtist = normalizeArtist(libraryTrack.artist || libraryTrack.albumArtist || libraryTrack.author);

  const candAlbum = normalizeForCompare(candidate.album || meta.album);
  const libAlbum = normalizeForCompare(libraryTrack.album);

  const artistMatches = !candArtist || !libArtist
    || candArtist === libArtist
    || candArtist.includes(libArtist)
    || libArtist.includes(candArtist);

  const albumMatches = Boolean(
    candAlbum && libAlbum && (
      candAlbum === libAlbum ||
      candAlbum.includes(libAlbum) ||
      libAlbum.includes(candAlbum)
    )
  );

  if (candArtist && libArtist && artistMatches) return true;
  if (albumMatches) return true;

  if (Number.isFinite(candidate.durationSec) && Number.isFinite(libraryTrack.durationSec)) {
    if (Math.abs(candidate.durationSec - libraryTrack.durationSec) <= 4 && artistMatches) {
      return true;
    }
  }

  if ((!candArtist || !libArtist) && titleMatches) {
    return true;
  }

  return false;
}

/**
 * Checks if a candidate album matches a library track.
 */
export function isSameAlbum(candidate, libraryTrack) {
  if (!candidate || !libraryTrack) return false;
  const candAlbum = normalizeForCompare(candidate.album || candidate.title);
  const libAlbum = normalizeForCompare(libraryTrack.album);
  if (!candAlbum || !libAlbum || candAlbum !== libAlbum) return false;

  const candArtist = normalizeArtist(candidate.artist);
  const libArtist = normalizeArtist(libraryTrack.albumArtist || libraryTrack.artist || libraryTrack.author);
  if (!candArtist || !libArtist) return true;
  return candArtist === libArtist || candArtist.includes(libArtist) || libArtist.includes(candArtist);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function downloadTracksRemote(user, entries, meta = {}, onProgress = () => {}) {
  const folderId = user?.musicFolderId;
  const albumDir = safeName(meta.album || 'Singles', 'Album');
  const artistDir = safeName(meta.artist || 'Unknown Artist', 'Unknown Artist');

  // Check for tracks already in library
  const libraryTracks = db.getUserItems(user.id, 'track');
  const existingMap = new Map();
  for (const entry of entries) {
    const hit = libraryTracks.find((libTrack) => isSameTrack(entry, libTrack, meta));
    if (hit) existingMap.set(entry.videoId || entry.title, hit);
  }

  if (entries.length > 0 && existingMap.size === entries.length) {
    console.log(`[YouTubeMusic] All ${entries.length} track(s) already in library, skipping.`);
    onProgress({ phase: 'All items already in library', percent: 100 });
    return {
      artist: artistDir,
      album: albumDir,
      uploaded: 0,
      skipped: entries.length,
      alreadyInLibrary: true,
      itemIds: entries.map((e) => existingMap.get(e.videoId || e.title)?.id).filter(Boolean),
      smart: {}
    };
  }

  const needed = entries.filter((e) => !existingMap.has(e.videoId || e.title));
  onProgress({ phase: 'Connecting to VPS download node', percent: 5 });

  const accessToken = await googleDrive.getAccessToken(user);
  if (!accessToken) throw new Error('Could not obtain Google Drive access token.');

  const settings = db.getSettings(user.id) || {};
  const remoteJobId = `ytm_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  let cookiesContent = null;
  const cookiePath = settings.youtubeCookiesFile || config.music.cookiesFile;
  if (cookiePath) {
    try {
      const resolved = path.isAbsolute(cookiePath) ? cookiePath : path.resolve(ROOT_DIR, cookiePath);
      if (fs.existsSync(resolved)) {
        cookiesContent = fs.readFileSync(resolved, 'utf8');
      }
    } catch (_) {}
  }

  let refreshUrl = null;
  if (config.google.redirectUri) {
    try {
      refreshUrl = `${new URL(config.google.redirectUri).origin}/api/downloads/token-refresh`;
    } catch (_) {}
  }

  await torrentNode.enqueueYoutube({
    id: remoteJobId,
    userId: user.id,
    title: meta.album || meta.artist || needed[0]?.title || 'Music',
    artist: meta.artist || needed[0]?.artist || 'Unknown Artist',
    album: meta.album || 'Singles',
    coverUrl: meta.coverUrl || needed[0]?.thumbnail || null,
    format: (settings.musicAudioFormat || 'mp3').toLowerCase(),
    quality: settings.musicAudioBitrate || '320',
    entries: needed,
    cookiesContent,
    driveConfig: {
      accessToken,
      rootFolderId: folderId,
      tokenRefreshUrl: refreshUrl,
      webhookSecret: config.torrent.nodeKey || null
    }
  });

  onProgress({ phase: 'Queued on VPS node', percent: 10 });

  let lastStage = '';
  while (true) {
    await sleep(2500);
    const remote = await torrentNode.getJob(remoteJobId).catch(() => null);
    if (!remote) continue;

    if (remote.stage !== lastStage || remote.percent) {
      lastStage = remote.stage;
      try {
        onProgress({
          phase: remote.message || remote.stage || 'Downloading on VPS',
          current: remote.currentTrack || '',
          percent: remote.percent || 10
        });
      } catch (err) {
        if (/cancel/i.test(err.message)) {
          await torrentNode.cancelJob(remoteJobId).catch(() => {});
          throw err;
        }
      }
    }

    if (remote.status === 'completed') {
      onProgress({ phase: 'Saving to library', percent: 98 });
      const results = Array.isArray(remote.results) ? remote.results : [];
      const itemIds = [];

      for (const track of results) {
        const saved = db.upsertItem(user.id, {
          kind: 'track',
          googleFileId: track.driveFileId,
          driveFolderId: track.driveFolderId,
          title: stripTrackNumberPrefix(track.title),
          author: track.artist || meta.artist || 'Unknown Artist',
          artist: track.artist || meta.artist || 'Unknown Artist',
          album: track.album || meta.album || 'Singles',
          genre: track.genre || meta.genre || inferGenreFromText([meta.album, track.album, track.artist, meta.artist, track.title].filter(Boolean).join(' ')) || '',
          albumArtist: track.artist || meta.artist || 'Unknown Artist',
          trackNumber: track.trackNumber,
          durationSec: track.durationSec,
          format: track.format || 'MP3',
          sizeBytes: track.sizeBytes || null,
          coverImage: meta.coverUrl || null,
          drivePath: track.drivePath
        });
        if (saved?.id) itemIds.push(saved.id);
      }

      broadcast('library_changed', { userId: user.id, reason: 'youtube-music' });
      onProgress({ phase: 'Complete', percent: 100 });

      const existingIds = entries.filter((e) => existingMap.has(e.videoId || e.title)).map((e) => existingMap.get(e.videoId || e.title)?.id).filter(Boolean);

      return {
        artist: meta.artist || 'Unknown Artist',
        album: meta.album || 'Singles',
        uploaded: results.length,
        skipped: existingMap.size,
        itemIds: [...itemIds, ...existingIds],
        smart: {}
      };
    }

    if (remote.status === 'error') {
      throw new Error(remote.error || 'VPS download node encountered an error');
    }

    if (remote.status === 'cancelled') {
      throw new Error('Download was cancelled');
    }
  }
}

export async function downloadTracks(user, entries, meta = {}, onProgress = () => {}) {
  const folderId = user?.musicFolderId;
  if (!folderId) {
    throw new Error('Pick a music folder in Settings before downloading.');
  }
  if (!entries?.length) {
    throw new Error('Nothing to download.');
  }

  const settings = db.getSettings(user?.id) || {};
  const downloadRunner = settings.youtubeDownloadLocation || process.env.YTM_DOWNLOAD_LOCATION || 'auto';
  if (torrentNode.isConfigured() && downloadRunner !== 'local') {
    return downloadTracksRemote(user, entries, meta, onProgress);
  }

  const bin = await ensureYtDlp();

  // MP3 transcoding (and metadata/thumbnail embedding) shells out to ffmpeg
  // *and* ffprobe, found via --ffmpeg-location. Resolve the pair up-front, but
  // only fail for modes that need it: 'opus'/'best' stream-copy only.

  const needsFfmpeg = settings.musicAudioFormat !== 'opus' && settings.musicAudioFormat !== 'best';
  const ffmpegDir = resolveFfmpegDir();
  if (needsFfmpeg && !ffmpegDir) {
    throw new Error('ffmpeg and ffprobe are not installed. Run: node scripts/setup-tools.mjs');
  }

  // Resolve cookies once per run. A liked or purchased track can be age or
  // region gated, and the per-video download then needs the account too - the
  // same cookies that unlock `LM` in the preview.
  const authArgs = ytAuthArgs(user.id);

  // 'mp3' transcodes at the configured LAME quality; other modes keep the
  // native best stream. Thumbnail embedding only works for mp3/m4a.
  const audio = audioFormatArgs(user.id);
  const embedThumbnail = audio.fmt === 'mp3' || audio.fmt === 'm4a' ? ['--embed-thumbnail'] : [];
  const ffmpegLocation = ffmpegDir ? ['--ffmpeg-location', ffmpegDir] : [];

  const staging = path.join(DOWNLOADS_DIR, `ytm-${Date.now()}`);
  fs.mkdirSync(staging, { recursive: true });

  onProgress({ phase: 'Listing tracks', percent: 5 });

  const albumDir = safeName(meta.album || 'Singles', 'Album');
  const artistDir = safeName(meta.artist || 'Unknown Artist', 'Unknown Artist');

  // Check for tracks that already exist in the user's library so we don't re-download them
  const libraryTracks = db.getUserItems(user.id, 'track');
  const existingMap = new Map();
  for (const entry of entries) {
    const hit = libraryTracks.find((libTrack) => isSameTrack(entry, libTrack, meta));
    if (hit) {
      existingMap.set(entry.videoId || entry.title, hit);
    }
  }

  // If every track in this batch is already in the library, skip the entire download cleanly
  if (entries.length > 0 && existingMap.size === entries.length) {
    console.log(`[YouTubeMusic] All ${entries.length} track(s) already in library, skipping download.`);
    onProgress({ phase: 'All items already in library', percent: 100 });
    const existingIds = entries.map((e) => existingMap.get(e.videoId || e.title)?.id).filter(Boolean);
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* best effort */ }
    return {
      artist: artistDir,
      album: albumDir,
      uploaded: 0,
      skipped: entries.length,
      alreadyInLibrary: true,
      itemIds: existingIds,
      smart: {}
    };
  }

  // Download sequentially: parallel yt-dlp runs on one channel trip rate limits.
  let uploaded = 0;
  let skipped = 0;
  let lastError = null;
  let landed = { artist: null, album: null };
  const itemIds = [];
  for (const [index, entry] of entries.entries()) {
    const percent = 10 + Math.round(((index + 1) / entries.length) * 80);

    // Skip tracks already present in the user's library
    const existing = existingMap.get(entry.videoId || entry.title);
    if (existing) {
      console.log(`[YouTubeMusic] Skipping "${entry.title}" - already in library (ID: ${existing.id})`);
      skipped += 1;
      itemIds.push(existing.id);
      onProgress({
        phase: `Skipped ${entry.title} (already in library)`,
        current: entry.title || '',
        percent
      });
      continue;
    }
    onProgress({
      phase: `Downloading ${index + 1}/${entries.length}`,
      current: entry.title || '',
      percent
    });

    const trackDir = path.join(staging, String(index + 1).padStart(2, '0'));
    fs.mkdirSync(trackDir, { recursive: true });

    // Anonymous attempt first: a stale/partial signed-in context can itself be
    // gated (returns zero formats), so cookies are only the retry.
    const dlArgs = [
      '--no-playlist', '--no-warnings', '--retries', '3',
      // YouTube Music carries proper metadata (artist/album/title) in the
      // video record; without this yt-dlp leaves the file mostly untagged and
      // every consumer - our tag read, the Drive scanner, the player UI - sees
      // an empty artist and falls back to folder names.
      '--embed-metadata', ...embedThumbnail,
      ...audio.args,
      // No pinned `player_client` list: the tv/android/web_embedded bypasses
      // hardcoded here in 2024/2025 were shut by YouTube, and pinning clients
      // blocks the fixes that ship in current yt-dlp defaults. Let the
      // (auto-refreshed) binary use its own maintained strategy.
      ...ffmpegLocation,
      '-o', path.join(trackDir, '%(title)s.%(ext)s'),
      `https://www.youtube.com/watch?v=${encodeURIComponent(entry.videoId)}`
    ];

    let dlError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await runYt(bin, dlArgs, { authArgs });
        dlError = null;
        break;
      } catch (err) {
        // Transient (a resumed queue hammering YouTube right after a crash,
        // say): wait once, retry once. Anything else - or a second failure -
        // skips this track and moves on.
        if (attempt === 0 && TRANSIENT_RE.test(err.message || '')) {
          console.warn(`[YouTubeMusic] Transient failure on "${entry.title}", retrying in 15s: ${err.message}`);
          await nap(15000);
          dlError = err;
          continue;
        }
        dlError = err;
        break;
      }
    }
    if (dlError) {
      // Skip the odd unavailable track rather than failing the whole run.
      // runYt has already fallen back to cookies when the error looked gated,
      // so anything still failing here is genuinely unavailable.
      lastError = dlError.message;
      skipped += 1;
      console.warn(`[YouTubeMusic] Skipped "${entry.title}": ${dlError.message}`);
      continue;
    }

    const fileName = fs.readdirSync(trackDir).find((f) => !isImageFile(f) && DOWNLOAD_AUDIO_EXT.has(extensionOf(f)));
    if (!fileName) { skipped += 1; continue; }
    const fileExt = extensionOf(fileName);
    const localPath = path.join(trackDir, fileName);

    let tags = null;
    try {
      const parsed = await parseBuffer(fs.readFileSync(localPath), {}, { duration: true });
      tags = parsed.common || null;
    } catch { /* tags are a bonus, the Drive scan will re-read them */ }

    const displayTitle = sanitizeTitle(stripTrackNumberPrefix(entry.title || tags?.title || fileName.replace(new RegExp(`\\.${fileExt}$`, 'i'), '')));
    const uploadName = `${String(index + 1).padStart(2, '0')} ${displayTitle}.${fileExt}`;

    // Folder layout is `Artist/Album/NN Title.<ext>`. The file's own tags win
    // over the search row: rows carry a bare year where the artist belongs, and
    // the track artist is often a "feat." list. TPE2 (albumartist) keys the
    // folder so the tree groups by the primary artist.
    const performer = pickName(tags?.albumartist, tags?.artist, entry.artist, meta.artist) || 'Unknown Artist';
    const trackArtistDir = safeName(performer, 'Unknown Artist');
    const trackAlbum = pickName(tags?.album, entry.album, meta.album) || 'Singles';
    const trackAlbumDir = safeName(trackAlbum, 'Album');

    onProgress({ phase: `Uploading ${index + 1}/${entries.length}`, current: displayTitle, percent });

    // Create the real Artist/Album folders on Drive rather than only recording a
    // path string - otherwise everything piles up flat in the music root and the
    // next library scan rebuilds a different drivePath anyway.
    const destFolderId = await googleDrive.ensureFolderPath(user, folderId, [trackArtistDir, trackAlbumDir]);

    // Upload is "last write wins": every file already sitting at this path is
    // trashed before the new one is written, so a resumed (or repeated) job
    // can never leave duplicates - even when a crash desynced the Drive file
    // from its library row. The row cleanup follows the same path.
    const expectedPath = [trackArtistDir, trackAlbumDir, uploadName].join('/');
    const stale = await googleDrive.findFilesByName(user, destFolderId, uploadName).catch(() => []);
    for (const file of stale) {
      try {
        await googleDrive.deleteFile(user, file.id);
      } catch (err) {
        console.warn(`[YouTubeMusic] Could not replace "${expectedPath}": ${err.message}`);
      }
    }
    const previous = db.findItemByDrivePath(user.id, expectedPath);
    if (previous) db.removeItem(user.id, previous.id);

    const result = await googleDrive.uploadFile(user, localPath, {
      name: uploadName,
      mimeType: AUDIO_MIME_BY_EXT[fileExt] || 'application/octet-stream',
      folderId: destFolderId
    }).catch((err) => {
      throw new Error(`Drive upload failed for "${displayTitle}": ${err.message}`);
    });
    uploaded += 1;
    landed = { artist: trackArtistDir, album: trackAlbumDir };

    // The file tags win where present: they carry the real artist/album, while
    // search rows may hold a bare year in the album slot.
    const saved = db.upsertItem(user.id, {
      kind: 'track',
      googleFileId: result.id,
      driveFolderId: destFolderId,
      title: displayTitle,
      author: performer,
      artist: pickName(tags?.artist, tags?.albumartist, entry.artist, meta.artist) || performer,
      album: trackAlbum,
      genre: tags?.genre ? (Array.isArray(tags.genre) ? tags.genre.join(', ') : String(tags.genre)) : '',
      albumArtist: performer,
      trackNumber: Number.isFinite(entry.trackNumber) ? entry.trackNumber : index + 1,
      durationSec: Number.isFinite(entry.durationSec)
        ? Math.round(entry.durationSec)
        : (Number.isFinite(tags?.duration) ? Math.round(tags.duration) : null),
      format: (fileExt || 'mp3').toUpperCase(),
      bitrateKbps: Number.isFinite(tags?.bitrate) ? Math.round(tags.bitrate / 1000) : null,
      sizeBytes: result.sizeBytes || null,
      coverImage: meta.coverUrl || entry.thumbnail || null,
      drivePath: [trackArtistDir, trackAlbumDir, uploadName].join('/')
    });
    if (saved?.id) itemIds.push(saved.id);
  }

  if (!uploaded) {
    if (skipped > 0 && !lastError) {
      onProgress({ phase: 'All items already in library', percent: 100 });
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* best effort */ }
      return {
        artist: landed.artist || artistDir,
        album: landed.album || albumDir,
        uploaded: 0,
        skipped,
        alreadyInLibrary: true,
        itemIds,
        smart: {}
      };
    }
    throw new Error(`None of the tracks could be downloaded${lastError ? `: ${lastError}` : '.'}`);
  }

  // Smart-playlist rules run over the whole track library after any import -
  // cheap, idempotent, and catches tracks added by album/playlist/liked flows
  // through this single choke point.
  let smart = {};
  try {
    smart = db.applySmartPlaylists(user.id);
  } catch (err) {
    console.warn('[SmartPlaylists] Apply failed:', err.message);
  }

  onProgress({ phase: 'Complete', percent: 100 });
  broadcast('library_changed', { userId: user.id, reason: 'youtube-music' });

  try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* best effort */ }
  return { artist: landed.artist || artistDir, album: landed.album || albumDir, uploaded, skipped, itemIds, smart };
}

/** Every track of an album, resolved from its OLAK5uy auto-playlist. */
export async function downloadAlbum(user, album, onProgress = () => {}) {
  const resolved = await resolvePlaylistId(album?.playlistId || album?.id);
  if (!resolved) {
    throw new Error('This album has no downloadable playlist.');
  }
  let entries = [];
  if (torrentNode.isConfigured()) {
    try {
      const remote = await torrentNode.getRemoteTracks(resolved);
      if (remote && remote.length) entries = remote;
    } catch (err) {
      console.warn('[YouTubeMusic] Remote node tracks listing fallback to local:', err.message);
    }
  }
  const bin = entries.length ? null : await ensureYtDlp();
  const raw = bin ? await collectJson(bin, albumArgs(resolved)) : [];
  if (!entries.length) entries = raw.map((entry, index) => ({
    videoId: entry.id,
    title: entry.title || `Track ${index + 1}`,
    durationSec: Number.isFinite(entry.duration) ? entry.duration : null,
    trackNumber: index + 1,
    thumbnail: entry.thumbnail || null
  }));
  if (!entries.length) throw new Error('yt-dlp returned no tracks for this album.');

  return downloadTracks(user, entries, {
    album: album.album || album.title,
    artist: album.artist,
    coverUrl: album.coverUrl || album.thumbnail
  }, onProgress);
}

/** Saves one or more individual songs found via search. */
export function downloadSongs(user, songs, onProgress = () => {}) {
  const list = (Array.isArray(songs) ? songs : [songs]).filter((s) => s?.videoId);
  if (!list.length) throw new Error('No song selected.');

  const single = list.length === 1 ? list[0] : null;
  return downloadTracks(user, list.map((song) => ({
    videoId: song.videoId,
    title: song.title,
    artist: song.artist,
    album: song.album,
    durationSec: song.durationSec,
    thumbnail: song.thumbnail,
    trackNumber: song.trackNumber ?? null
  })), {
    artist: single?.artist || list[0].artist,
    album: single?.album || 'Singles',
    coverUrl: null
  }, onProgress);
}

/**
 * Imports a pasted YouTube Music playlist: downloads every track into Drive
 * (folder layout keyed by each file's own tags, so mixed-artist playlists split
 * naturally) and mirrors the playlist into the user's FRAUDIO playlists - by
 * creating one named after the playlist, or appending to a same-named one.
 */
export async function downloadPlaylist(user, { url, name }, onProgress = () => {}) {
  if (!user?.musicFolderId) {
    throw new Error('Pick a music folder in Settings before downloading.');
  }
  const listId = parsePlaylistRef(url);
  onProgress({ phase: 'Reading playlist', percent: 3 });
  const preview = await playlistPreview(listId, { userId: user.id });
  const title = String(name || preview.title || 'YouTube playlist').trim().slice(0, 120) || 'YouTube playlist';
  // Surface the resolved playlist in the queue entry so the footer and Downloads
  // view show something meaningful before the first track starts.
  onProgress({ title, artist: preview.uploader, current: `${preview.count} tracks` });

  const result = await downloadTracks(user, preview.tracks.map((t, i) => ({
    videoId: t.videoId,
    title: t.title,
    durationSec: t.durationSec,
    thumbnail: t.thumbnail,
    trackNumber: i + 1
  })), { album: '', artist: '', coverUrl: null }, onProgress);

  const savedIds = (result.itemIds || []).filter(Boolean);
  onProgress({ phase: 'Updating playlist', percent: 96 });
  const playlist = attachPlaylist(user, title, savedIds);
  // Remember which FRAUDIO playlist this YouTube playlist became, so the picker
  // can show "imported" even after a rename.
  db.saveSettings(user.id, {
    youtubeImportMap: { ...(db.getSettings(user.id).youtubeImportMap || {}), [listId]: playlist.id }
  });

  return {
    ...result,
    playlist: { id: playlist.id, name: playlist.name, added: savedIds.length },
    source: preview.title
  };
}

/** Create-or-append the same-named FRAUDIO music playlist with these tracks. */
function attachPlaylist(user, title, itemIds) {
  const existing = db.getPlaylists(user.id, 'music').find((p) => p.name === title);
  const playlist = existing || db.createPlaylist(user.id, title, { kind: 'music' });
  const current = existing ? (db.getPlaylist(user.id, playlist.id)?.itemIds || []) : [];
  db.setPlaylistItems(user.id, playlist.id, Array.from(new Set([...current, ...itemIds])));
  return playlist;
}

/**
 * Liked Music without cookies: the YouTube Data API exposes the account's
 * "Liked videos" playlist over the session's own OAuth token, and song hearts
 * from YouTube Music land there too. Age-gated likes still fail the download
 * step (those are what the cookies capture in Settings is for).
 */
export async function downloadLiked(user, onProgress = () => {}) {
  if (!user?.musicFolderId) {
    throw new Error('Pick a music folder in Settings before downloading.');
  }
  onProgress({ phase: 'Reading Liked videos', percent: 3 });
  let liked;
  try {
    liked = await youtubeApi.listLikedVideoIds(user, { max: MAX_PLAYLIST_TRACKS });
  } catch (err) {
    if (youtubeApi.isMissingYoutubeAccess(err)) {
      throw new Error('YouTube access missing - sign out and reconnect your Google account (and enable "YouTube Data API v3" in the Cloud project).');
    }
    throw err;
  }
  onProgress({ title: 'Liked Music', current: `${liked.videoIds.length} tracks` });

  const result = await downloadTracks(user, liked.videoIds.map((v, i) => ({
    videoId: v.videoId,
    title: v.title || '',
    trackNumber: i + 1
  })), { album: '', artist: '', coverUrl: null }, onProgress);

  const savedIds = (result.itemIds || []).filter(Boolean);
  onProgress({ phase: 'Updating playlist', percent: 96 });
  const playlist = attachPlaylist(user, 'Liked Music', savedIds);

  return {
    ...result,
    playlist: { id: playlist.id, name: playlist.name, added: savedIds.length },
    source: 'Liked videos (YouTube Data API)'
  };
}

// ---------------------------------------------------------------------------
// Background download queue
// ---------------------------------------------------------------------------

const jobs = new Map();
let jobSeq = 0;
// yt-dlp on one channel is easy to rate-limit, so only one job runs at a time;
// anything added meanwhile queues (status 'queued') and the pump drains it.
const queue = [];   // job ids waiting for the runner
let activeJobId = null;
const MAX_QUEUED = 50;

// Rebuilds a runner closure from persisted arguments, so a queued job survives
// an app restart. The serialisable `args` is everything the download function
// needs; nothing here holds live handles (sockets, processes).
const QUEUE_BUILDERS = {
  album: (user, args) => (onProgress) => downloadAlbum(user, args, onProgress),
  songs: (user, args) => (onProgress) => downloadSongs(user, args, onProgress),
  playlist: (user, args) => (onProgress) => downloadPlaylist(user, args, onProgress),
  liked: (user) => (onProgress) => downloadLiked(user, onProgress)
};

/** Mirror of the in-memory queue (pending jobs only) into the db store. */
function syncQueueStore(userId) {
  if (!userId) return;
  const pending = {};
  for (const job of jobs.values()) {
    if (job.userId !== userId) continue;
    if (job.status !== 'queued' && job.status !== 'running') continue;
    pending[job.id] = {
      id: job.id,
      kind: job.kind,
      title: job.title,
      artist: job.artist,
      args: job._spec?.args ?? {},
      queuedAt: job.queuedAt
    };
  }
  db.saveMusicQueue(userId, pending);
}

export function jobStatus(id) {
  return jobs.get(id) || null;
}

/** All live jobs, newest last - what the UI footer and Downloads view render. */
export function jobList() {
  return Array.from(jobs.values(), publicJob);
}

export function cancelJob(id) {
  const job = jobs.get(id);
  if (!job || job.status === 'done' || job.status === 'error') return false;
  if (job.status === 'queued') {
    const at = queue.indexOf(id);
    if (at >= 0) queue.splice(at, 1);
    jobs.delete(id);
    syncQueueStore(job.userId);
    broadcast('music_jobs', { jobs: jobList() });
    return true;
  }
  job.cancelRequested = true;
  return true;
}

function pump() {
  if (activeJobId) return;
  const nextId = queue.shift();
  if (!nextId) return;
  const job = jobs.get(nextId);
  if (!job || job.status !== 'queued') { pump(); return; }
  activeJobId = nextId;
  Object.assign(job, { status: 'running', phase: 'Starting' });

  const runner = job._run;
  delete job._run;
  (async () => {
    try {
      // Throwing from onProgress is how a cancel reaches the per-track loop in
      // downloadTracks: the next checkpoint aborts the run cleanly.
      const where = await runner((progress) => {
        Object.assign(job, progress);
        if (job.cancelRequested) throw new Error('Cancelled.');
        broadcast('ytm_progress', { jobId: job.id, ...progress });
      });
      if (job.cancelRequested) throw new Error('Cancelled.');
      Object.assign(job, { status: 'done', phase: 'Complete', percent: 100, where });
    } catch (err) {
      Object.assign(job, { status: 'error', error: err.message });
    } finally {
      activeJobId = null;
      syncQueueStore(job.userId);
      broadcast('ytm_progress', {
        jobId: job.id,
        status: job.status,
        phase: job.phase,
        percent: job.percent,
        current: job.current,
        error: job.error
      });
      broadcast('music_jobs', { jobs: jobList() });
      // Keep finished jobs around briefly so a late poll still sees the result.
      setTimeout(() => jobs.delete(job.id), 10 * 60 * 1000).unref?.();
      pump();
    }
  })();
}

/**
 * Enqueues a download and returns immediately. Progress is broadcast over SSE as
 * `ytm_progress` (per-job) and `music_jobs` (whole queue); the snapshot is also
 * pollable via `jobList`/`jobStatus`. `run` is the live closure; `spec` is its
 * serialisable twin ({ kind, args }) used to rebuild it after a restart.
 */
function startDownload(user, { title, artist, kind }, run, spec) {
  if (queue.length >= MAX_QUEUED) {
    throw new Error(`The download queue is full (${MAX_QUEUED} waiting). Try again when it drains.`);
  }

  const id = `ytm_${Date.now()}_${(jobSeq += 1)}`;
  const job = {
    id,
    kind,
    userId: user.id,
    title: title || '',
    artist: artist || '',
    status: 'queued',
    phase: 'Queued',
    percent: 0,
    current: '',
    error: null,
    queuedAt: new Date().toISOString(),
    position: queue.length + (activeJobId ? 1 : 0) + 1,
    _run: run,
    _spec: spec || null
  };
  jobs.set(id, job);
  queue.push(id);
  syncQueueStore(user.id);
  broadcast('music_jobs', { jobs: jobList() });
  setImmediate(pump);
  return publicJob(job);
}

/** Strips the private runner closure before anything leaves the module. */
function publicJob(job) {
  if (!job) return job;
  const { _run, _spec, ...rest } = job;
  return rest;
}

/**
 * Called on server boot: re-queues any job that was pending when the app
 * died. A job interrupted mid-run re-runs from track one; downloadTracks
 * overwrites the partial Drive file per track, so no duplicates appear.
 * Stale staging directories from dead runs are swept first.
 */
export function resumePendingQueue() {
  try {
    for (const name of fs.readdirSync(DOWNLOADS_DIR)) {
      if (name.startsWith('ytm-')) {
        fs.rmSync(path.join(DOWNLOADS_DIR, name), { recursive: true, force: true });
      }
    }
  } catch { /* fresh installs have no staging dir yet */ }

  let resumed = 0;
  // Iterate the persisted queue itself, so entries belonging to a since-deleted
  // user are pruned too.
  for (const userId of Object.keys(db.raw().musicQueue || {})) {
    const entries = db.getMusicQueue(userId);
    const pending = Object.values(entries || {}).sort((a, b) => String(a.queuedAt).localeCompare(String(b.queuedAt)));
    if (!pending.length) continue;
    const user = db.getUser(userId);
    if (!user?.musicFolderId) {
      // User/folder gone - drop the orphaned entries.
      db.saveMusicQueue(userId, {});
      continue;
    }
    for (const entry of pending) {
      const build = QUEUE_BUILDERS[entry.kind];
      if (!build) {
        console.warn(`[Queue] Unknown job kind "${entry.kind}" - dropped.`);
        continue;
      }
      try {
        startDownload(
          user,
          { title: entry.title, artist: entry.artist, kind: entry.kind },
          build(user, entry.args || {}),
          { kind: entry.kind, args: entry.args || {} }
        );
        resumed += 1;
      } catch (err) {
        console.warn(`[Queue] Could not re-queue "${entry.title}": ${err.message}`);
      }
    }
  }
  if (resumed) {
    console.log(`[Queue] Resumed ${resumed} pending music download(s)`);
    broadcast('music_jobs', { jobs: jobList() });
  }
  return resumed;
}

export function startAlbumDownload(user, album) {
  return startDownload(
    user,
    { title: album?.title, artist: album?.artist, kind: 'album' },
    (onProgress) => downloadAlbum(user, album, onProgress),
    { kind: 'album', args: album }
  );
}

export function startSongDownload(user, songs) {
  const list = (Array.isArray(songs) ? songs : [songs]).filter((s) => s?.videoId);
  if (!list.length) throw new Error('No song selected.');
  const first = list[0] || {};
  return startDownload(
    user,
    {
      title: list.length === 1 ? first.title : `${list.length} songs`,
      artist: first.artist,
      kind: 'songs'
    },
    (onProgress) => downloadSongs(user, list, onProgress),
    { kind: 'songs', args: list }
  );
}

/** Enqueues a pasted-playlist import. The title is resolved inside the job. */
export function startPlaylistDownload(user, { url, name }) {
  return startDownload(
    user,
    { title: name || 'YouTube playlist', artist: '', kind: 'playlist' },
    (onProgress) => downloadPlaylist(user, { url, name }, onProgress),
    { kind: 'playlist', args: { url, name } }
  );
}

/** Enqueues a Liked-Music import over the YouTube Data API (no cookies). */
export function startLikedImport(user) {
  return startDownload(
    user,
    { title: 'Liked Music', artist: '', kind: 'liked' },
    (onProgress) => downloadLiked(user, onProgress),
    { kind: 'liked', args: {} }
  );
}

export default {
  newReleases,
  search,
  artistBrowse,
  albumTracks,
  parsePlaylistRef,
  playlistPreview,
  downloadAlbum,
  downloadSongs,
  downloadPlaylist,
  downloadLiked,
  startAlbumDownload,
  startSongDownload,
  startPlaylistDownload,
  startLikedImport,
  resumePendingQueue,
  jobStatus,
  jobList,
  cancelJob
};
