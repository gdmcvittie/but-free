/** Display helpers shared across the FRAUDIO views. */

/** `h:mm:ss` / `m:ss`, matching the server's formatDuration. */
export function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Coarse length for cards: "12h 4m" / "48m". */
export function formatLengthShort(totalSeconds) {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  if (!seconds) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${Math.max(1, m)}m`;
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const value = n / 1024 ** i;
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

/** Completion ratio as 0-100, or null when the duration is unknown. */
export function percentOf(positionSec, durationSec) {
  const pos = Number(positionSec) || 0;
  const dur = Number(durationSec) || 0;
  if (!dur) return null;
  return Math.min(100, Math.max(0, (pos / dur) * 100));
}

/** Coarse "time ago" for the music history list: "just now", "12m ago", "3d ago". */
export function formatAgo(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  return new Date(t).toLocaleDateString();
}

export function formatPercent(value) {
  return `${Math.round(Number(value) || 0)}%`;
}

export function formatAddedAt(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** "12 items" / "1 item" */
export function pluralize(count, singular, plural = `${singular}s`) {
  const n = Number(count) || 0;
  return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * Normalizes a song title or album name for fuzzy duplicate comparison.
 * Strips release tags, video qualifiers, remaster suffixes, punctuation, and diacritics.
 */
export function normalizeForCompare(str) {
  if (!str) return '';
  return String(str)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    // Remove (feat. ...) or [feat. ...]
    .replace(/[\(\[](feat\.?|ft\.?)\s+[^)\]]+[\)\]]/gi, '')
    // Remove (Official Video), [Official Audio], (Visualizer), (Lyrics), (Audio), etc.
    .replace(/[\(\[](official\s*(music\s*)?video|official\s*audio|lyrics?|visualizer|audio|video|explicit|clean|extended\s*mix|bonus\s*track)[\)\]]/gi, '')
    // Remove remaster/version tags in parens or brackets: (Remastered 2011), (2020 Remaster)
    .replace(/[\(\[](remaster(ed)?(\s*\d+)?|\d+\s*remaster(ed)?|deluxe(\s*edition)?|anniversary(\s*edition)?)[\)\]]/gi, '')
    // Remove trailing " - Remastered", " - 2011 Remaster", " - Live", etc.
    .replace(/\s*[-–—]\s*(remaster(ed)?(\s*\d+)?|\d+\s*remaster(ed)?|live(\s*at\s*[^)]+)?)\s*$/i, '')
    // Normalize & to and
    .replace(/&/g, 'and')
    // Normalize quotes / dashes
    .replace(/[’‘`"']/g, '')
    // Strip non-alphanumeric except space
    .replace(/[^a-z0-9\s]/g, ' ')
    // Collapse spaces
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
  // Strip leading "the "
  s = s.replace(/^the\s+/, '');
  // Strip trailing " feat. ..." or " ft. ..."
  s = s.replace(/\s*(feat\.?|ft\.?)\s+.*$/i, '');
  // Normalize &
  s = s.replace(/&/g, 'and');
  // Strip quotes
  s = s.replace(/[’‘`"']/g, '');
  // Strip non-alphanumeric except space
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

/**
 * Strips leading track numbers prefixed to a song title.
 * Examples: "01 - Song", "01. Song", "1. Song", "01 Song", "498 Mandingo" -> "Song", "Mandingo".
 * Preserves titles that are just years or legitimate numbers (e.g. "1985", "1999").
 */
export function stripTrackNumber(title) {
  if (!title || typeof title !== 'string') return title || '';
  const trimmed = title.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  const withSep = trimmed.match(/^(\d{1,3})\s*[-–—.]\s+(.+)$/);
  if (withSep) return withSep[2].trim();
  const withSpace = trimmed.match(/^(\d{1,3})\s+([A-Za-z#([\"'‘].*)$/);
  if (withSpace) return withSpace[2].trim();
  const withAny = trimmed.match(/^(\d{1,3})\s+(.+)$/);
  if (withAny && !/^\d{4}$/.test(withAny[1])) return withAny[2].trim();
  return trimmed;
}