import googleAuth from './googleAuth.js';

/**
 * YouTube Data API v3, read-only, via the session's Google OAuth token.
 *
 * The auto-generated "Liked videos" playlist is reachable through plain OAuth
 * (`channels.list(mine=true)` -> `relatedPlaylists.likes`, usually the `LL`
 * pseudo-id), which is what lets Liked Music import without cookies. Song
 * likes cast in YouTube Music are likes on the underlying video, so they show
 * up here too.
 */

const YT_API = 'https://www.googleapis.com/youtube/v3';

async function ytGet(user, pathAndQuery) {
  const token = await googleAuth.getValidAccessToken(user);
  const res = await fetch(`${YT_API}/${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) {
    let message = `YouTube API returned HTTP ${res.status}`;
    let reason = '';
    try {
      const body = await res.json();
      message = body?.error?.message || message;
      reason = body?.error?.errors?.[0]?.reason || '';
    } catch { /* non-JSON error body */ }
    const err = new Error(message);
    err.status = res.status;
    err.reason = reason;
    throw err;
  }
  return res.json();
}

/** Map API failures that mean "the token lacks YouTube access" onto one shape. */
export function isMissingYoutubeAccess(err) {
  return err?.status === 401
    || err?.status === 403
    || /insufficient|unauthoriz/i.test(String(err?.message || ''));
}

export async function likedPlaylistId(user) {
  let likes = null;
  try {
    const data = await ytGet(user, 'channels?part=contentDetails&mine=true');
    likes = data.items?.[0]?.contentDetails?.relatedPlaylists?.likes || null;
  } catch {
    // No channel / lookup failed - `LL` still works below.
  }
  if (likes) return likes;
  // Accounts without a YouTube channel still expose their likes under the
  // generic `LL` id; only fall back after checking, since some channels use a
  // suffixed variant.
  return 'LL';
}

/**
 * The account's own playlists (for a quick "import one of mine" picker).
 * Accounts that never created a YouTube channel get 404 channelNotFound -
 * return an empty list rather than failing the whole dialog.
 */
export async function listOwnedPlaylists(user, { max = 50 } = {}) {
  const out = [];
  let pageToken = null;
  try {
    do {
      const qs = new URLSearchParams({
        part: 'snippet,contentDetails',
        mine: 'true',
        maxResults: '50'
      });
      if (pageToken) qs.set('pageToken', pageToken);
      const data = await ytGet(user, `playlists?${qs}`);
      for (const item of data.items || []) {
        out.push({
          playlistId: item.id,
          title: item.snippet?.title || 'Untitled',
          item_count: item.contentDetails?.itemCount ?? null,
          thumbnail: pickThumb(item.snippet?.thumbnails)
        });
        if (out.length >= max) break;
      }
      pageToken = out.length >= max ? null : (data.nextPageToken || null);
    } while (pageToken);
    return { playlists: out, hasChannel: true };
  } catch (err) {
    if (/channelNotFound/i.test(String(err.reason || ''))) return { playlists: [], hasChannel: false };
    throw err;
  }
}

function pickThumb(thumbs) {
  if (!thumbs) return null;
  const pref = ['high', 'medium', 'default', 'standard', 'maxres'];
  for (const key of pref) if (thumbs[key]?.url) return thumbs[key].url;
  return null;
}

/**
 * Liked video ids, newest first (the API lists additions oldest-first). Paginates
 * everything - the newest likes live on the *last* pages, so stopping early
 * would import the oldest ones - then trims to `max`. Requires the
 * youtube.readonly scope and YouTube Data API v3 enabled in the Cloud project;
 * missing either shows up as 403 here.
 */
const HARD_CAP = 2000;

export async function listLikedVideoIds(user, { max = 500 } = {}) {
  const playlistId = await likedPlaylistId(user);
  const ids = [];
  let pageToken = null;
  do {
    const qs = new URLSearchParams({
      part: 'contentDetails,snippet',
      playlistId,
      maxResults: '50'
    });
    if (pageToken) qs.set('pageToken', pageToken);
    const data = await ytGet(user, `playlistItems?${qs}`);
    for (const item of data.items || []) {
      const videoId = item.contentDetails?.videoId;
      if (videoId) ids.push({ videoId, title: item.snippet?.title || '' });
    }
    pageToken = ids.length >= HARD_CAP ? null : (data.nextPageToken || null);
  } while (pageToken);

  const newestFirst = ids.reverse();
  return { playlistId, videoIds: newestFirst.slice(0, max), total: ids.length };
}

export default { listLikedVideoIds, likedPlaylistId, listOwnedPlaylists, isMissingYoutubeAccess, YT_API };
