/**
 * Filename + tag parsing for the FRAUDIO library.
 *
 * AudioBookBay releases follow a few recurring shapes, e.g.
 *   "Zenith Academy 4_ Zenith Academy, Book 4 [B0HFZMFFS9].m4b"
 *   "Monster Smash Agency Series [Books 1-3] - Kathryn Moon.m4b"
 *   "A Series Name 03 - The Third Book - Jane Author.m4b"
 * Drive folders carry strong hints too (Author / Series / Book), so parsing is
 * a best-effort layered guess: Drive path first, embedded tags next, filename last.
 */

// `webm` appears here because YouTube Music's best-audio Opus stream is served in
// a webm container; the scanner treats it as audio so imported tracks are found.
export const AUDIO_EXTENSIONS = new Set(['m4b', 'm4a', 'mp3', 'aac', 'flac', 'ogg', 'opus', 'wav', 'wma', 'webm']);
export const ARCHIVE_EXTENSIONS = new Set(['zip', 'rar', 'cbz', 'cbr', '7z']);
export const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp']);
export const TORRENT_AUDIO_EXTENSIONS = new Set(['m4b', 'm4a', 'mp3', 'aac', 'flac', 'ogg', 'opus']);

const ROMAN = {
  i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10,
  xi: 11, xii: 12, xiii: 13, xiv: 14, xv: 15, xvi: 16, xvii: 17, xviii: 18, xix: 19, xx: 20
};

const WORD_NUMBERS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20
};

/** Generic folders whose name carries no author/series meaning. */
const GENERIC_FOLDERS = new Set([
  'audiobooks', 'audio books', 'audiobook', 'audio book', 'books', 'book audio',
  'music', 'songs', 'albums', 'mp3', 'downloads', 'download', 'dl', 'new',
  'unsorted', 'loose', 'temp', 'tmp', 'misc', 'incoming'
]);

export function extensionOf(name = '') {
  const match = String(name).match(/\.([a-z0-9]+)$/i);
  return match ? match[1].toLowerCase() : '';
}

export function stripExtension(name = '') {
  return String(name).replace(/\.[a-z0-9]+$/i, '');
}

export function isAudioFile(name) {
  return AUDIO_EXTENSIONS.has(extensionOf(name));
}

export function isImageFile(name) {
  return IMAGE_EXTENSIONS.has(extensionOf(name));
}

export function isArchiveFile(name) {
  return ARCHIVE_EXTENSIONS.has(extensionOf(name));
}

export function isGenericFolder(name) {
  return GENERIC_FOLDERS.has(String(name || '').trim().toLowerCase());
}

/** Strips characters Google Drive (and Windows) refuse in folder/file names. */
export function sanitizeSegment(name, fallback = 'Unknown') {
  const cleaned = String(name || '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[-–—\s,.]+|[-–—\s,.]+$/g, '')
    .trim();
  return cleaned || fallback;
}

export function sanitizeTitle(name) {
  return sanitizeSegment(name, 'Untitled');
}

/** Drops a trailing "[ABC123]" ASIN / "[ID]" marker and other release-group noise. */
function stripReleaseNoise(value) {
  return String(value || '')
    .replace(/\[[^\]]{1,40}\]/g, ' ')
    .replace(/\([^)]*\b(unabridged|abridged|retail|repost|64kbps|128kbps|192kbps)\b[^)]*\)/gi, ' ')
    .replace(/\b(unabridged|abridged)\b/gi, ' ')
    .replace(/[_.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toNumber(token) {
  if (token == null) return null;
  const raw = String(token).trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return parseInt(raw, 10);
  const lower = raw.toLowerCase();
  if (ROMAN[lower] != null) return ROMAN[lower];
  if (WORD_NUMBERS[lower] != null) return WORD_NUMBERS[lower];
  const num = parseInt(raw, 10);
  return Number.isFinite(num) ? num : null;
}

/** "Series, Book 4" / "Series #4" / "Series 04 - Title" -> { series, index, title } */
function matchSeriesIndex(value) {
  const input = String(value || '');

  // "Title (Series, Book 2) - Author" - the parenthesised series marker.
  const paren = input.match(/^(.*?)\s*\(([^()]*)\)\s*(?:[-–—]\s*(.+))?$/);
  if (paren && paren[1].trim().length > 1) {
    const inner = paren[2].match(/^(?:(.*?)[,;]\s*)?(?:book|vol(?:ume)?|part)\s*\.?\s*([0-9]+|[ivxlcdm]+)$/i);
    const index = inner ? toNumber(inner[2]) : null;
    if (index != null && index > 0 && index < 200) {
      const outerTitle = paren[1].trim();
      return {
        series: (inner[1] || outerTitle).trim(),
        index,
        title: paren[3] ? `${outerTitle} - ${paren[3].trim()}` : outerTitle
      };
    }
  }

  // "Series Name, Book 4"
  const commaBook = input.match(/^(.*?),\s*(?:book|vol(?:ume)?|part)\s*\.?\s*([0-9]+|[ivxlcdm]+)\b\s*(.*)$/i);
  if (commaBook && commaBook[1].trim().length > 1) {
    return {
      series: commaBook[1].trim(),
      index: toNumber(commaBook[2]),
      title: commaBook[3].trim()
    };
  }

  // "Series Name Book 4"
  const inlineBook = input.match(/^(.*?)\s+(?:book|vol(?:ume)?|part)\s*\.?\s*([0-9]+|[ivxlcdm]+)\b\s*(.*)$/i);
  if (inlineBook && inlineBook[1].trim().length > 1) {
    return {
      series: inlineBook[1].trim(),
      index: toNumber(inlineBook[2]),
      title: inlineBook[3].trim()
    };
  }

  // "Series Name #4" / "Series Name 04"
  const hashIndex = input.match(/^(.*?)\s*[#]\s*([0-9]+)\s*(.*)$/);
  if (hashIndex && hashIndex[1].trim().length > 1) {
    return {
      series: hashIndex[1].trim(),
      index: toNumber(hashIndex[2]),
      title: hashIndex[3].trim()
    };
  }

  const trailingIndex = input.match(/^(.*?)[\s_-]+(\d{1,3})(?:\s+[-–—]\s*(.*))?$/);
  if (trailingIndex && trailingIndex[1].trim().length > 1) {
    const candidate = toNumber(trailingIndex[2]);
    // Only treat small integers as series positions, not as a year or word count.
    if (candidate != null && candidate > 0 && candidate < 200) {
      return {
        series: trailingIndex[1].trim(),
        index: candidate,
        title: (trailingIndex[3] || '').trim()
      };
    }
  }

  return null;
}

/**
 * Parses an audiobook file name.
 * @returns {{title:string, author:string, series:string, seriesIndex:number|null, subtitle:string}}
 */
export function parseAudiobookName(rawName) {
  const result = { title: '', author: '', series: '', seriesIndex: null, subtitle: '' };

  // ABB multi-book releases: "Monster Smash Agency Series [Books 1-3] - Kathryn Moon".
  // This has to run before stripReleaseNoise, which would drop the [Books 1-3]
  // marker and leave us unable to tell a series from a standalone title.
  const multiBook = stripExtension(rawName)
    .match(/^(.*?)\s*\[?\s*books?\s*(\d+)\s*[-–]\s*(\d+)\s*\]?\s*[-–—]\s*(.+)$/i);
  if (multiBook && multiBook[1].trim().length > 1) {
    const series = stripReleaseNoise(multiBook[1]);
    result.series = series;
    result.seriesIndex = toNumber(multiBook[2]);
    result.author = stripReleaseNoise(multiBook[4]);
    // Until a part filename is known, label the release by its series.
    result.title = `${series} (Books ${multiBook[2]}-${multiBook[3]})`;
    return result;
  }

  const cleaned = stripReleaseNoise(stripExtension(rawName));
  result.title = cleaned || 'Untitled';
  if (!cleaned) return result;

  // "Series 04 - The Title - Jane Author" (index in the middle)
  const indexed = cleaned.match(/^(.+?)\s+(\d{1,3}|\d{1,3}\.\d+)\s+[-–—]\s+(.+)$/);
  if (indexed) {
    const index = toNumber(indexed[2]);
    if (index != null && index > 0 && index < 200) {
      const remainder = indexed[3];
      // Trailing segment is the author when it looks like a name (2-4 capitalised words).
      const authorMatch = remainder.match(/^(.*)\s[-–—]\s*([A-Z][\w.'-]+(?:\s+[A-Z][\w.'-]+){0,3})$/);
      result.series = indexed[1].trim();
      result.seriesIndex = index;
      if (authorMatch && authorMatch[1].trim().length > 2) {
        result.title = authorMatch[1].trim();
        result.author = authorMatch[2].trim();
      } else {
        result.title = remainder.trim();
      }
      return result;
    }
  }

  // Series position either leading or trailing.
  const seriesMatch = matchSeriesIndex(cleaned);
  if (seriesMatch && seriesMatch.series) {
    result.series = seriesMatch.series;
    result.seriesIndex = seriesMatch.index;
    const leftover = seriesMatch.title || '';
    const authorMatch = leftover.match(/^(.*)\s+[-–—]\s+([A-Z][\w.'-]+(?:\s+[A-Z][\w.'-]+){0,3})$/);
    if (authorMatch && authorMatch[1].trim().length > 2) {
      result.title = authorMatch[1].trim();
      result.author = authorMatch[2].trim();
    } else {
      result.title = leftover || result.title;
    }
    return result;
  }

  // "Title - Author" or "Author - Title": prefer the reading where the last
  // segment is person-shaped and the first is not.
  const parts = cleaned.split(/\s+[-–—]\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const isChapter = (s) => /^(?:chapter|part|pt|section|sec|track|disc|cd)\s*\d+/i.test(s) || /^\d{1,3}$/.test(s);
    const looksLikeName = (s) => !isChapter(s) && /^[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,3}$/.test(s);
    if (looksLikeName(parts[parts.length - 1]) && !looksLikeName(parts[0])) {
      result.author = parts[parts.length - 1];
      result.title = parts.slice(0, -1).join(' - ');
    } else {
      result.title = parts.join(' - ');
    }
  }

  return result;
}

/**
 * Strips leading track numbers prefixed to a song title.
 * Examples: "01 - Song", "01. Song", "1. Song", "01 Song", "498 Mandingo" -> "Song", "Mandingo".
 * Preserves titles that are just years or legitimate numbers (e.g. "1985", "1999").
 */
export function stripTrackNumberPrefix(title) {
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

/**
 * Parses a music file name such as "04 - Track Name.mp3" or "Artist - Album - 07 Song.mp3".
 */
export function parseMusicName(rawName) {
  let cleaned = stripReleaseNoise(stripExtension(rawName));
  const result = { title: cleaned || 'Untitled', artist: '', album: '', trackNumber: null, discNumber: null };
  if (!cleaned) return result;

  // Leading track number. Both "01 - Title" and "01 Title" (the format FRAUDIO
  // itself uploads) are accepted; requiring a letter/symbol start means a track named
  // "1985" is not mistaken for one.
  const leadingSep = cleaned.match(/^(\d{1,3})\s*[-–—.]\s+(.+)$/);
  if (leadingSep) {
    result.trackNumber = toNumber(leadingSep[1]);
    cleaned = leadingSep[2];
  } else {
    const leadingSpace = cleaned.match(/^(\d{1,3})\s+([A-Za-z#([\"'‘].*)$/);
    if (leadingSpace) {
      result.trackNumber = toNumber(leadingSpace[1]);
      cleaned = leadingSpace[2];
    } else {
      const leadingAny = cleaned.match(/^(\d{1,3})\s+(.+)$/);
      if (leadingAny && leadingAny[1].length <= 3 && !/^\d{4}$/.test(leadingAny[1])) {
        result.trackNumber = toNumber(leadingAny[1]);
        cleaned = leadingAny[2];
      }
    }
  }

  // Disc number folder/file hint: "CD2 - 03 Song"
  const disc = cleaned.match(/^(?:cd|disc)\s*(\d{1,2})\s*[-.–]\s*(.+)$/i);
  if (disc) {
    result.discNumber = toNumber(disc[1]);
    cleaned = disc[2];
  }

  const parts = cleaned.split(/\s+[-–—]\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 3) {
    result.artist = parts[0];
    result.album = parts[1];
    result.title = parts[2];
  } else if (parts.length === 2) {
    result.artist = parts[0];
    result.title = parts[1];
  } else {
    result.title = cleaned;
  }

  const trailingNum = result.title.match(/^(.*?)\s+[-–—]\s*(\d{1,3})$/);
  if (trailingNum && result.trackNumber == null) {
    result.title = trailingNum[1];
    result.trackNumber = toNumber(trailingNum[2]);
  }

  result.title = stripTrackNumberPrefix(result.title);
  return result;
}

/**
 * Merges the signals available for one Drive file into a library record.
 *
 * @param {object} args
 * @param {string[]} args.pathSegments folder names from the Drive root down
 * @param {string} args.fileName
 * @param {object|null} args.tags parsed music-metadata output
 */
export function buildAudiobookRecord({ pathSegments = [], fileName, tags = null, googleFileId, driveFolderId, sizeBytes, modifiedTime, coverImage }) {
  const meaningfulFolders = pathSegments.filter((s) => s && !isGenericFolder(s));
  const fromName = parseAudiobookName(fileName);

  let author = tags?.artist || fromName.author || '';
  let title = tags?.title || fromName.title;
  let series = tags?.album || fromName.series || '';
  let seriesIndex = fromName.seriesIndex;

  // A Drive folder structure of Author / Series / Book is the strongest signal.
  if (meaningfulFolders.length >= 1) {
    if (meaningfulFolders.length >= 2) {
      if (!author) author = meaningfulFolders[0];
      if (!series) series = meaningfulFolders[1];
    } else if (!series && !author) {
      // Single folder: treat as the series, author comes from tags/name.
      series = meaningfulFolders[0];
    }
  }

  // "Title (Series, Book 4)" style tags.
  if (tags?.title) {
    const embedded = matchSeriesIndex(tags.title);
    if (embedded) {
      if (!title || title === tags.title) title = embedded.title || embedded.series;
      if (!series) series = embedded.series;
      if (seriesIndex == null) seriesIndex = embedded.index;
    }
  }

  return {
    id: null,
    kind: 'audiobook',
    googleFileId,
    driveFolderId,
    title: sanitizeTitle(title),
    author: sanitizeSegment(author, 'Unknown Author'),
    series: series ? sanitizeSegment(series, 'Unsorted') : '',
    seriesIndex: seriesIndex ?? null,
    narrator: (tags?.comment && /read by/i.test(tags.comment)
      ? tags.comment.replace(/^.*read by\s*/i, '').trim()
      : '') || '',
    genre: tags?.genre ? (Array.isArray(tags.genre) ? tags.genre.join(', ') : String(tags.genre)) : (tags?.common?.genre ? (Array.isArray(tags.common.genre) ? tags.common.genre.join(', ') : String(tags.common.genre)) : ''),
    durationSec: Number.isFinite(tags?.duration) ? Math.round(tags.duration) : null,
    format: (typeof tags?.format === 'string' && tags.format.toUpperCase()) || (fileName.match(/\.([a-z0-9]+)$/i)?.[1] || '').toUpperCase(),
    bitrateKbps: Number.isFinite(tags?.bitrate) ? Math.round(tags.bitrate / 1000) : null,
    sizeBytes: sizeBytes || 0,
    coverImage: coverImage || null,
    drivePath: [...pathSegments, fileName].join('/'),
    modifiedTime: modifiedTime || new Date().toISOString()
  };
}

export const GENRE_PATTERNS = [
  [/\bdeathcore\b/i, 'Deathcore'],
  [/\bmetalcore\b/i, 'Metalcore'],
  [/\b(death\s*metal|brutal\s*death)\b/i, 'Death Metal'],
  [/\b(black\s*metal|atmospheric\s*black)\b/i, 'Black Metal'],
  [/\b(thrash\s*metal|thrash)\b/i, 'Thrash Metal'],
  [/\bdjent\b/i, 'Djent'],
  [/\b(heavy\s*metal|metal)\b/i, 'Metal'],
  [/\b(pop\s*punk|punk\s*rock|punk)\b/i, 'Punk'],
  [/\bgrunge\b/i, 'Grunge'],
  [/\b(alt\s*rock|alternative\s*rock|alternative)\b/i, 'Alternative'],
  [/\b(indie\s*rock|indie\s*pop|indie)\b/i, 'Indie'],
  [/\b(hard\s*rock|rock\s*n\s*roll|rock)\b/i, 'Rock'],
  [/\b(hip[\s-]*hop|rap|trap|phonk|drill)\b/i, 'Hip Hop'],
  [/\b(r&b|rhythm\s*and\s*blues|soul)\b/i, 'R&B'],
  [/\b(electronic|edm|techno|house|trance|dubstep|synthwave|drum\s*&?\s*bass|dnb)\b/i, 'Electronic'],
  [/\b(pop|synthpop|dance\s*pop)\b/i, 'Pop'],
  [/\b(classical|symphony|orchestral)\b/i, 'Classical'],
  [/\b(jazz|smooth\s*jazz|bebop)\b/i, 'Jazz'],
  [/\b(blues)\b/i, 'Blues'],
  [/\b(country|bluegrass|folk|americana)\b/i, 'Country'],
  [/\b(reggae|dub|dancehall)\b/i, 'Reggae'],
  [/\b(soundtrack|ost|score)\b/i, 'Soundtrack'],
  [/\b(lo[\s-]*fi|chillhop)\b/i, 'Lo-Fi'],
  [/\b(acoustic)\b/i, 'Acoustic'],
  [/\b(podcast)\b/i, 'Podcast'],
  [/\b(audiobook)\b/i, 'Audiobook']
];

export function inferGenreFromText(text) {
  if (!text) return '';
  for (const [pattern, genreName] of GENRE_PATTERNS) {
    if (pattern.test(text)) return genreName;
  }
  return '';
}

export function buildTrackRecord({ pathSegments = [], fileName, tags = null, googleFileId, driveFolderId, sizeBytes, modifiedTime, coverImage }) {
  const meaningfulFolders = pathSegments.filter((s) => s && !isGenericFolder(s));
  const fromName = parseMusicName(fileName);

  const common = tags?.common || tags || {};
  const format = tags?.rawFormat || tags?.format || {};

  const isYearCandidate = (v) => /^\(?\b(18|19|20)\d{2}\b\)?$/.test(String(v || '').trim());
  const artist = [common.artist, common.albumartist, tags?.artist, fromName.artist, meaningfulFolders[0]]
    .find((c) => c && !isYearCandidate(c)) || '';
  const album = common.album || tags?.album || fromName.album || meaningfulFolders[1] || '';

  const rawGenre = common.genre || tags?.genre;
  let genre = rawGenre ? (Array.isArray(rawGenre) ? rawGenre.join(', ') : String(rawGenre)) : '';
  if (!genre) {
    genre = inferGenreFromText([album, fromName.album, ...meaningfulFolders, fileName, artist].filter(Boolean).join(' '));
  }

  const durationVal = Number.isFinite(format.duration) ? format.duration : (Number.isFinite(tags?.duration) ? tags.duration : null);
  const bitrateVal = Number.isFinite(format.bitrate) ? format.bitrate : (Number.isFinite(tags?.bitrate) ? tags.bitrate : null);
  const formatStr = typeof tags?.format === 'string'
    ? tags.format.toUpperCase()
    : (typeof format.container === 'string' ? format.container.toUpperCase() : (fileName.match(/\.([a-z0-9]+)$/i)?.[1] || '').toUpperCase());

  return {
    id: null,
    kind: 'track',
    googleFileId,
    driveFolderId,
    title: sanitizeTitle(stripTrackNumberPrefix(common.title || tags?.title || fromName.title)),
    artist: sanitizeSegment(artist, 'Unknown Artist'),
    // TCON/TAGS genre when present - the raw material for smart playlists.
    genre: genre || '',
    album: album ? sanitizeSegment(album, 'Unsorted') : '',
    albumArtist: common.albumartist || tags?.albumartist || '',
    trackNumber: Number.isFinite(common.track?.no) ? common.track.no : (Number.isFinite(tags?.track?.no) ? tags.track.no : fromName.trackNumber),
    discNumber: Number.isFinite(common.disk?.no) ? common.disk.no : (Number.isFinite(tags?.disk?.no) ? tags.disk.no : fromName.discNumber),
    durationSec: Number.isFinite(durationVal) ? Math.round(durationVal) : null,
    format: formatStr,
    bitrateKbps: Number.isFinite(bitrateVal) ? Math.round(bitrateVal / 1000) : null,
    sizeBytes: sizeBytes || 0,
    coverImage: coverImage || null,
    drivePath: [...pathSegments, fileName].join('/'),
    modifiedTime: modifiedTime || new Date().toISOString()
  };
}

export function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
