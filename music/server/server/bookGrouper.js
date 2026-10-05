/**
 * Groups audiobook files into cohesive book records.
 *
 * Audiobooks frequently come as multiple chapter MP3 files (e.g. "01 - Chapter 1.mp3",
 * "Book Title - Part 01.mp3", or subfolders containing chapter files).
 *
 * This module detects chapter patterns, resolves the true book title and author,
 * and groups multi-part files into a single unified book entry with ordered chapters.
 */

const AUDIO_EXT_REGEX = /\.(mp3|m4b|m4a|aac|flac|ogg|opus|wma)$/i;

// Words that indicate a chapter / part rather than an author or standalone title
const CHAPTER_WORD_REGEX = /^(?:chapter|part|pt|section|sec|track|disc|cd|side|book|ep|episode)\b/i;

function stripExtension(filename) {
  return String(filename || '').replace(AUDIO_EXT_REGEX, '').trim();
}

/** Returns true if string looks like "Chapter 1", "Part 02", "Disc 1", etc. */
export function isChapterOrPart(str) {
  if (!str) return false;
  const s = String(str).trim();
  return (
    CHAPTER_WORD_REGEX.test(s) ||
    /^(?:ch|pt|cd)[\s._-]*\d+/i.test(s) ||
    /^\d{1,3}$/.test(s)
  );
}

/** Extracts a numeric index from a chapter title/filename for natural ordering. */
export function extractPartNumber(str) {
  if (!str) return null;
  const s = String(str);
  // Match "Chapter 5", "Part 02", "05", etc.
  const m = s.match(/(?:ch(?:apter)?|part|pt|section|sec|track|cd|disc)[\s._-]*(\d+)/i)
    || s.match(/[-–—._\s](\d{1,3})(?:[-–—._\s]|$)/)
    || s.match(/^(\d{1,3})[-–—._\s]/);
  return m ? parseInt(m[1], 10) : null;
}

/** Cleans up an author string and discards false positives like "Chapter 5". */
export function cleanAuthor(item) {
  let author = String(item.author || '').trim();
  if (isChapterOrPart(author) || /unknown author/i.test(author)) {
    author = '';
  }

  // If author is missing or invalid, try recovering from drivePath
  if (!author && item.drivePath) {
    const segments = item.drivePath.split('/').filter(Boolean);
    if (segments.length >= 2 && !/^(?:audiobooks|books|downloads|music)$/i.test(segments[0])) {
      author = segments[0];
    }
  }

  if (!author && item.artist && !isChapterOrPart(item.artist)) {
    author = item.artist;
  }
  if (!author && item.albumArtist && !isChapterOrPart(item.albumArtist)) {
    author = item.albumArtist;
  }

  return author || 'Unknown Author';
}

/**
 * Analyzes an audiobook item and derives:
 * - bookTitle: the overall title of the book
 * - chapterTitle: the title of this specific chapter/part (if multi-part)
 * - partNumber: numeric chapter sequence index (if detectable)
 * - isChapter: boolean indicating if this file has chapter markers
 */
export function parseBookAndChapter(item) {
  const author = cleanAuthor(item);
  const rawPath = item.drivePath || '';
  const segments = rawPath.split('/').filter(Boolean);
  const fileName = item.fileName || (segments.length ? segments[segments.length - 1] : '') || item.title || '';
  const folderName = segments.length >= 2 ? segments[segments.length - 2] : '';

  const baseName = stripExtension(fileName);
  let cleaned = baseName
    .replace(/\[(?:[^\]]*\b(?:mp3|kbps|m4b|audiobook|unabridged|abridged)\b[^\]]*)\]/gi, '')
    .trim();

  let bookTitle = '';
  let chapterTitle = '';
  let isChapter = false;

  // Pattern 1: Multi-part with explicit chapter marker:
  // e.g. "29 - Whirlwind: The X-Files, Book 2 - 05 - Chapter 5"
  // or "The Shining - Chapter 01"
  // or "Dune - Part 1"
  const chapterSuffixMatch = cleaned.match(
    /^(.*?)(?:[\s._-]+(?:(\d+[\s._-]+)?(?:ch(?:apter)?|part|pt|section|sec|track|cd|disc)[\s._-]*(\d+)[^.]*))$/i
  );

  if (chapterSuffixMatch) {
    isChapter = true;
    let candidateBook = chapterSuffixMatch[1].trim();
    // Strip leading track number if present: "29 - Whirlwind..." -> "Whirlwind..."
    candidateBook = candidateBook.replace(/^\d+[\s._-]+/, '').trim();
    if (candidateBook && !isChapterOrPart(candidateBook)) {
      bookTitle = candidateBook;
    }
    // Extract the chapter portion: e.g. "Chapter 5"
    const suffix = cleaned.slice(chapterSuffixMatch[1].length).replace(/^[\s._-]+/, '').trim();
    chapterTitle = suffix || `Part ${extractPartNumber(cleaned) || 1}`;
  }

  // Pattern 2: Trailing part number: "Book Title - 01", "Book Title - 02"
  if (!bookTitle) {
    const trailingNumMatch = cleaned.match(/^(.*?)\s*[-–—]\s*(\d{1,3})$/);
    if (trailingNumMatch) {
      const candidateBook = trailingNumMatch[1].replace(/^\d+[\s._-]+/, '').trim();
      if (candidateBook && !isChapterOrPart(candidateBook)) {
        isChapter = true;
        bookTitle = candidateBook;
        chapterTitle = `Part ${parseInt(trailingNumMatch[2], 10)}`;
      }
    }
  }

  // Pattern 3: Leading chapter number: "01 - Chapter 1", "Chapter 01", "01 The Beginning"
  // In this case, the filename alone doesn't have the book title, but the parent folder or album does!
  if (!bookTitle) {
    const isLeadingChapter = /^(?:\d+[\s._-]+)?(?:ch(?:apter)?|part|pt|section)[\s._-]*\d+/i.test(cleaned)
      || /^\d{1,2}[\s._-]+[a-z0-9]/i.test(cleaned);

    if (isLeadingChapter) {
      isChapter = true;
      chapterTitle = cleaned;
      if (item.album && !isChapterOrPart(item.album)) {
        bookTitle = item.album;
      } else if (folderName && !/^(?:audiobooks|books|downloads)$/i.test(folderName)) {
        bookTitle = folderName;
      }
    }
  }

  // Fallback if not matched as a chapter:
  if (!bookTitle) {
    bookTitle = item.album || item.title || cleaned || 'Untitled Audiobook';
    // Remove author prefix/suffix from title if present
    if (author && author !== 'Unknown Author') {
      const authorEsc = author.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      bookTitle = bookTitle
        .replace(new RegExp(`^${authorEsc}\\s*[-–—:]\\s*`, 'i'), '')
        .replace(new RegExp(`\\s*[-–—:]\\s*${authorEsc}$`, 'i'), '')
        .trim();
    }
  }

  // Clean trailing punctuation
  bookTitle = bookTitle.replace(/^[-\s._:]+|[-\s._:]+$/g, '').trim();

  const partNumber = extractPartNumber(chapterTitle || cleaned) ?? item.trackNumber ?? null;

  return {
    bookTitle: bookTitle || item.title || 'Untitled Audiobook',
    chapterTitle: chapterTitle || item.title || 'Chapter 1',
    partNumber,
    isChapter,
    author
  };
}

/**
 * Groups an array of raw/decorated audiobook items into consolidated book objects.
 * Single-part books remain clean 1-part books; multi-chapter books are merged.
 */
export function groupAudiobookItems(items) {
  if (!Array.isArray(items) || !items.length) return [];

  const bookMap = new Map();

  for (const item of items) {
    const info = parseBookAndChapter(item);
    const author = info.author;
    const bookTitle = info.bookTitle;

    // Use folderId or folderName as an extra discriminator so two different books
    // with the same title don't collide.
    const folderKey = item.driveFolderId || '';
    const bookKey = `${author.toLowerCase()}::${bookTitle.toLowerCase()}::${folderKey}`;

    if (!bookMap.has(bookKey)) {
      bookMap.set(bookKey, {
        key: bookKey,
        title: bookTitle,
        author: author,
        series: item.series || '',
        seriesIndex: item.seriesIndex ?? null,
        narrator: item.narrator || '',
        genre: item.genre || '',
        format: item.format || '',
        coverUrl: item.coverUrl || null,
        coverImage: item.coverImage || null,
        driveFolderId: item.driveFolderId || null,
        durationSec: 0,
        sizeBytes: 0,
        progressSec: 0,
        lastPlayed: null,
        lastAdded: null,
        abridged: item.abridged ?? null,
        parts: []
      });
    }

    const group = bookMap.get(bookKey);

    // Keep best metadata
    if (!group.series && item.series) group.series = item.series;
    if (group.seriesIndex == null && item.seriesIndex != null) group.seriesIndex = item.seriesIndex;
    if (!group.narrator && item.narrator) group.narrator = item.narrator;
    if (!group.genre && item.genre) group.genre = item.genre;
    if (!group.coverUrl && item.coverUrl) group.coverUrl = item.coverUrl;
    if (!group.coverImage && item.coverImage) group.coverImage = item.coverImage;

    const dur = item.durationSec || 0;
    group.durationSec += dur;
    group.sizeBytes += (item.sizeBytes || 0);

    const prog = item.progressSec || (item.progress?.positionSec) || 0;
    group.progressSec += prog;

    const played = item.lastPlayed || item.progress?.updatedAt || null;
    if (played && (!group.lastPlayed || played > group.lastPlayed)) {
      group.lastPlayed = played;
    }

    const added = item.addedAt || null;
    if (added && (!group.lastAdded || added > group.lastAdded)) {
      group.lastAdded = added;
    }

    group.parts.push({
      ...item,
      author,
      chapterTitle: info.chapterTitle,
      partNumber: info.partNumber
    });
  }

  // Post-process each book: sort parts in natural chapter order
  const books = [];
  for (const group of bookMap.values()) {
    group.parts.sort((a, b) => {
      if (a.partNumber != null && b.partNumber != null && a.partNumber !== b.partNumber) {
        return a.partNumber - b.partNumber;
      }
      return String(a.fileName || a.drivePath || a.title || '').localeCompare(
        String(b.fileName || b.drivePath || b.title || ''),
        undefined,
        { numeric: true }
      );
    });

    const isMultiPart = group.parts.length > 1;
    const firstPart = group.parts[0];

    // Book ID: use first part's id for single files, or stable hash for multi-part
    const id = isMultiPart ? `book_${firstPart.id}` : firstPart.id;

    const favorite = group.parts.some((p) => p.favorite);
    const offline = group.parts.length > 0 && group.parts.every((p) => p.offline);

    const percent = group.durationSec > 0
      ? Math.min(100, Math.round((group.progressSec / group.durationSec) * 100))
      : 0;

    books.push({
      id,
      kind: 'audiobook',
      key: group.key,
      title: group.title,
      author: group.author,
      series: group.series,
      seriesIndex: group.seriesIndex,
      narrator: group.narrator,
      genre: group.genre || firstPart.genre || '',
      format: group.format,
      coverUrl: group.coverUrl || `/api/items/${firstPart.id}/cover`,
      coverImage: group.coverImage,
      durationSec: group.durationSec,
      sizeBytes: group.sizeBytes,
      partsCount: group.parts.length,
      isMultiPart,
      parts: group.parts,
      favorite,
      offline,
      progressSec: group.progressSec,
      percent,
      lastPlayed: group.lastPlayed,
      addedAt: group.lastAdded || firstPart.addedAt,
      // For MediaCard compatibility
      googleFileId: firstPart.googleFileId,
      driveFolderId: group.driveFolderId
    });
  }

  return books;
}

export default {
  parseBookAndChapter,
  groupAudiobookItems,
  cleanAuthor,
  isChapterOrPart,
  extractPartNumber
};
