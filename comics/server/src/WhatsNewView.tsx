import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { apiUrl, downloadComic } from './api';
import type { GoogleUserProfile } from './AuthModal';
import { RefreshCw, Heart, Star, Loader2, Save, PartyPopper } from 'lucide-react';

interface LatestRelease {
  title: string;
  cover: string | null;
  chapterUrl: string;
  publisher?: string;
  size?: string;
  year?: string;
}

interface WhatsNewViewProps {
  user?: GoogleUserProfile | null;
  onOpenAuthModal?: () => void;
  onOpenDrivePicker?: () => void;
  onNavigateToDownloads?: (url: string) => void;
  onDownloadUrl?: (url: string) => void;
}

/**
 * Strips release tags, extensions, parenthetical groups, and returns a clean string.
 */
function cleanReleaseTitle(title: string): string {
  if (!title) return '';
  return title
    .replace(/\.(cbz|cbr|pdf|zip)$/i, '')
    .replace(/\b(digital|hd|webrip|c2c|novus|minutemen|zone-empire|empire|dcp|kresge|steam|hybrid|complete|scan)\b/gi, '')
    .replace(/\(cover\s+[a-z0-9]+\)/gi, '')
    .replace(/\[\s*\]|\(\s*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A comic is either a single issue, a collected volume, or a special
 * (annual / one-shot). Those three live in separate key namespaces, which is
 * what stops a collected "Detective Comics Vol. 05" from masking a brand new
 * "Detective Comics #5" and blocking its download.
 */
type ComicKind = 'issue' | 'volume' | 'special' | 'unknown';

interface ComicIdentity {
  series: string;
  seriesKey: string;
  kind: ComicKind;
  number: number | null;
  /** Unique, kind-aware identity. Empty when the title cannot be identified. */
  key: string;
}

function toNumber(raw?: string): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const parsed = parseInt(raw, 10);
  return isNaN(parsed) ? null : parsed;
}

/**
 * Builds the identity for a series + kind + number. When there is no number the
 * remainder of the title (tail) distinguishes one-shots from each other.
 * An identity with no series or no discriminator is left keyless on purpose:
 * an unidentifiable title can never be proven owned, so it stays downloadable.
 */
function buildIdentity(series: string, kind: ComicKind, number: number | null, tail = ''): ComicIdentity {
  const seriesKey = canonicalSeriesKey(series);
  const tailKey = canonicalSeriesKey(tail);
  const kindTag = kind === 'issue' ? 'i' : kind === 'volume' ? 'v' : kind === 'special' ? 's' : 'u';
  const slot = number !== null ? String(number) : tailKey;
  return {
    series: sanitizeSeries(series),
    seriesKey,
    kind,
    number,
    key: seriesKey && slot ? `${seriesKey}:${kindTag}${slot}` : ''
  };
}

/**
 * Strips a trailing release year: "Batman #5 (2024)" -> "Batman #5".
 * A bare year is intentionally left alone so titles like "Spider-Man 2099" survive.
 */
function stripTrailingYear(value: string): string {
  return value.replace(/\s*(?:\([12][90]\d\d\)|[-–—]\s*[12][90]\d\d)\s*$/i, '').trim();
}

/**
 * Extracts series, kind and number from any release title. Branch order mirrors
 * the server's parseComicTitle so a downloaded release is stored and re-matched
 * the same way on both sides.
 */
function parseComicIdentity(rawTitle: string): ComicIdentity {
  const base = stripTrailingYear(cleanReleaseTitle(rawTitle));
  // Every branch below captures the series as a prefix of `base`, so whatever
  // follows it is the tail that distinguishes numberless volumes/one-shots.
  const tailFrom = (matchedSeries: string) => base.slice(matchedSeries.length).trim();

  // 1. Numbered volume / book / TPB: "Morning Glories Vol. 1", "Batman TPB 2"
  const volMatch = base.match(/^(.*?)(?:[\s,–—:-]+|\s+)(?:(vol(?:ume)?|bk|book|tpb|tome|compendium|omnibus)\.?|v)\s*([0-9]+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)\b(?:\s*[:-]\s*(.*?))?(?:\s*\(.*?\))?$/i);
  if (volMatch && volMatch[1].trim().length > 1) {
    const rawSeries = volMatch[1];
    return buildIdentity(rawSeries, 'volume', toNumber(volMatch[3]), tailFrom(rawSeries));
  }

  // 2. Standalone collection without a number: "Batman Omnibus", "Saga Compendium",
  //    "Civil War Collection", "Saga Deluxe Edition"
  const standaloneVolMatch = base.match(/^(.*?)(?:[\s,–—:-]+|\s+)(omnibus|compendium|tpb|tome|collection|deluxe(?:\s+edition)?|absolute)\b(?:\s*[:-]\s*(.*?))?(?:\s*\(.*?\))?$/i);
  if (standaloneVolMatch && standaloneVolMatch[1].trim().length > 1) {
    const rawSeries = standaloneVolMatch[1];
    return buildIdentity(rawSeries, 'volume', null, tailFrom(rawSeries));
  }

  // 3. Title is only a collection marker: "Omnibus - Batman"
  if (/^omnibus\b/i.test(base)) {
    return buildIdentity('Comics', 'volume', null, base);
  }

  // 4. Issue hashtag: e.g. "Absolute Batman #01", "Batman (2016) #125"
  const hashMatch = base.match(/^(.*?)(?:\s*#\s*([0-9]+(?:\.[0-9]+)?))/i);
  if (hashMatch && hashMatch[1].trim().length > 1) {
    const rawSeries = hashMatch[1];
    const num = parseFloat(hashMatch[2]);
    return buildIdentity(rawSeries, 'issue', isNaN(num) ? null : num);
  }

  // 5. Explicit issue word: e.g. "Batman Issue 100", "Invincible Chapter 12"
  const wordMatch = base.match(/^(.*?)(?:[\s,–—:-]+|\s+)(?:issue|iss|ch|chapter|no)\.?\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (wordMatch && wordMatch[1].trim().length > 1) {
    const rawSeries = wordMatch[1];
    const num = parseFloat(wordMatch[2]);
    return buildIdentity(rawSeries, 'issue', isNaN(num) ? null : num);
  }

  // 6. Trailing issue number: e.g. "Batman 150", "Spawn 358"
  const trailingMatch = base.match(/^(.*?)(?:\s*[-–—]\s*|\s+)(?:0([0-9]+)|([0-9]{1,4}))(?:\s*\(.*?\))?$/);
  if (trailingMatch && trailingMatch[1].trim().length > 1) {
    const numVal = parseInt(trailingMatch[2] || trailingMatch[3], 10);
    if (numVal < 1940 || numVal > 2035) {
      const rawSeries = trailingMatch[1];
      return buildIdentity(rawSeries, 'issue', numVal);
    }
  }

  // 7. Annual / special / one-shot: e.g. "Detective Comics Annual", "Spawn One-Shot"
  const specialMatch = base.match(/^(.*?)(?:[\s,–—:-]+|\s+)(annual|special|one-shot|oneshot|giant-size)\b(?:\s*#?\s*([0-9]+))?/i);
  if (specialMatch && specialMatch[1].trim().length > 1) {
    const rawSeries = specialMatch[1];
    return buildIdentity(rawSeries, 'special', toNumber(specialMatch[3]), tailFrom(rawSeries));
  }

  return buildIdentity(base, 'unknown', null);
}

/**
 * Library records are stored as { series, item, isVolume } where `item` is
 * already normalized by the server ("Issue 07", "Vol. 02", "Annual", ...).
 * Reads that shape directly so an owned issue can never be confused with an
 * owned volume or with a similarly named sibling series.
 */
const ITEM_VOLUME_PATTERN = /^(?:omnibus|vol(?:ume)?|book|bk|tpb|tome|compendium)[\s.]*(?:vol(?:ume)?[\s.]*)?([0-9]+)?/i;
const ITEM_ISSUE_PATTERN = /^(?:issue|iss|ch|chapter|no)[\s.]*([0-9]+(?:\.[0-9]+)?)/i;
const ITEM_SPECIAL_PATTERN = /^(annual|special|one-shot|oneshot|giant-size)\b[\s.]*(?:no[\s.]*)?([0-9]+)?/i;

function libraryComicIdentity(comic: any): ComicIdentity {
  const title = (comic?.title || '').trim();
  const parsedTitle = parseComicIdentity(title);
  const series = (comic?.series || '').trim() || parsedTitle.series;
  const item = typeof comic?.item === 'string' ? comic.item.trim() : '';

  if (series && item) {
    const volumeMatch = item.match(ITEM_VOLUME_PATTERN);
    if (volumeMatch) return buildIdentity(series, 'volume', toNumber(volumeMatch[1]), item);

    const issueMatch = item.match(ITEM_ISSUE_PATTERN);
    if (issueMatch) {
      const num = parseFloat(issueMatch[1]);
      return buildIdentity(series, 'issue', isNaN(num) ? null : num);
    }

    const specialMatch = item.match(ITEM_SPECIAL_PATTERN);
    if (specialMatch) return buildIdentity(series, 'special', toNumber(specialMatch[2]), item);

    // Free-form item (edited metadata or a built omnibus): keep it as the tail.
    if (comic?.isVolume) return buildIdentity(series, 'volume', null, item);
    const freeform = buildIdentity(series, 'unknown', null, item);
    if (freeform.key) return freeform;
  }

  return parsedTitle;
}

function sanitizeSeries(name: string): string {
  if (!name) return '';
  return name
    .replace(/\s*\([12][90]\d\d\)\s*/g, '')
    .replace(/[<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[-–—\s,.]+|[-–—\s,.]+$/g, '')
    .trim();
}

/**
 * Normalizes a series name into a canonical alphanumeric string for comparison:
 * e.g. "Spider-Man: Reign II" -> "spidermanreignii"
 * "The Amazing Spider-Man" -> "amazingspiderman"
 */
function canonicalSeriesKey(name: string): string {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/^the\s+/i, '')
    .replace(/\s*\([12][90]\d\d\)\s*/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Loose series comparison used for the "tracked / favorite series" highlight
 * only. It intentionally allows prefix matches ("Spider-Man" inside "The
 * Amazing Spider-Man") but must never be used to decide that a release is
 * already owned - sibling series such as "Batman Beyond 2.0" or "Invincible
 * Presents" would otherwise swallow unrelated issues.
 */
function isSeriesMatch(releaseSeries: string, targetSeries: string): boolean {
  if (!releaseSeries || !targetSeries) return false;
  const k1 = canonicalSeriesKey(releaseSeries);
  const k2 = canonicalSeriesKey(targetSeries);
  if (!k1 || !k2) return false;
  if (k1 === k2) return true;
  if (k1.length >= 5 && k2.length >= 5) {
    if (k1.includes(k2) || k2.includes(k1)) return true;
  }
  return false;
}

export default function WhatsNewView({
  user,
  onOpenAuthModal,
  onOpenDrivePicker,
  onNavigateToDownloads: _onNavigateToDownloads,
  onDownloadUrl: _onDownloadUrl
}: WhatsNewViewProps) {
  const [releases, setReleases] = useState<LatestRelease[]>([]);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedPublisher, setSelectedPublisher] = useState<string>('All');
  const [statusFilter, setStatusFilter] = useState<'all' | 'favorites' | 'librarySeries' | 'inLibrary'>('all');
  const [error, setError] = useState<string | null>(null);

  // Inline background downloading state tracking
  const [downloadStates, setDownloadStates] = useState<Record<string, { status: 'downloading' | 'done' | 'error'; error?: string; percent?: number; message?: string }>>({});
  
  // Library Comics & Series State
  const [libraryComics, setLibraryComics] = useState<any[]>([]);
  const libraryComicsRef = useRef<any[]>([]);
  const [librarySeriesNames, setLibrarySeriesNames] = useState<Set<string>>(new Set());
  const [favoriteSeriesNames, setFavoriteSeriesNames] = useState<Set<string>>(new Set());

  // Locally persisted downloaded records (instant 0ms retention across visits)
  const userId = user?.id || 'default';
  const urlsStorageKey = `comix_downloaded_urls_${userId}`;
  const keysStorageKey = `comix_downloaded_keys_v2_${userId}`;

  const [downloadedUrls, setDownloadedUrls] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem(urlsStorageKey);
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch {
      return new Set();
    }
  });

  const [downloadedCanonicalKeys, setDownloadedCanonicalKeys] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem(keysStorageKey);
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch {
      return new Set();
    }
  });

  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Fetch already downloaded library comics & favorite series
  const refreshLibraryData = useCallback(() => {
    // 1. Fetch library comics
    fetch(apiUrl('/api/comics'))
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => {
        if (Array.isArray(data)) {
          libraryComicsRef.current = data;
          setLibraryComics(data);

          const sSet = new Set<string>();
          data.forEach((c: any) => {
            const s = (c.series || '').trim();
            if (s && s !== 'Comics' && s !== 'Unsorted') {
              sSet.add(s);
            }
          });

          // Also pull curated series list from /api/library/series
          fetch(apiUrl('/api/library/series'))
            .then((r) => (r.ok ? r.json() : []))
            .then((seriesList) => {
              if (Array.isArray(seriesList)) {
                seriesList.forEach((item: any) => {
                  if (item.series && item.series !== 'Comics' && item.series !== 'Unsorted') {
                    sSet.add(item.series);
                  }
                });
              }
              setLibrarySeriesNames(new Set(sSet));
            })
            .catch(() => {
              setLibrarySeriesNames(new Set(sSet));
            });
        }
      })
      .catch(() => {});

    // 2. Fetch series favorites
    const loadFavorites = (remoteList?: string[], libraryList: any[] = []) => {
      const favSet = new Set<string>();

      // Check localStorage first
      try {
        const savedSeries = localStorage.getItem(`comix_series_favorites_${userId}`);
        if (savedSeries) {
          JSON.parse(savedSeries).forEach((s: string) => favSet.add(s));
        }
      } catch {}

      if (Array.isArray(remoteList)) {
        remoteList.forEach((s) => favSet.add(s));
      }

      // Also check if any comic favorites imply a favorite series
      try {
        const savedComicFavs = localStorage.getItem(`comix_favorites_${userId}`);
        if (savedComicFavs) {
          const favComicIds = new Set(JSON.parse(savedComicFavs).map(String));
          libraryList.forEach((c: any) => {
            if (c && favComicIds.has(String(c.id))) {
              const s = (c.series || '').trim();
              if (s && s !== 'Comics' && s !== 'Unsorted') {
                favSet.add(s);
              }
            }
          });
        }
      } catch {}

      setFavoriteSeriesNames(favSet);
    };

    fetch(apiUrl(`/api/favorites/series/${userId}`))
      .then((res) => (res.ok ? res.json() : []))
      .then((remoteFavorites) => {
        loadFavorites(Array.isArray(remoteFavorites) ? remoteFavorites : [], libraryComicsRef.current);
      })
      .catch(() => {
        loadFavorites(undefined, libraryComicsRef.current);
      });
  }, [userId]);

  // Pre-calculate kind-aware identity keys for all library comics for instant O(1) matching.
  // Both the stored { series, item } pair and the file title are indexed so that
  // records with hand-edited metadata (or omnibus builds, which store an
  // "Omnibus Vol. N" item under the plain series name) are still recognised.
  const libraryIdentityKeys = useMemo(() => {
    const keys = new Set<string>();
    libraryComics.forEach((c: any) => {
      const fromItem = libraryComicIdentity(c);
      if (fromItem.key) keys.add(fromItem.key);
      const fromTitle = parseComicIdentity(c.title || '');
      if (fromTitle.key) keys.add(fromTitle.key);
    });
    return keys;
  }, [libraryComics]);

  // Check if a specific release is already downloaded & in library.
  // Every check is an exact identity match (series + kind + number), so owning
  // one issue - or a collected volume - of a tracked series never marks the
  // other issues of that series as already owned.
  const checkIsComicInLibrary = useCallback(
    (item: LatestRelease): boolean => {
      // 1. In-flight or completed download in current session
      if (downloadStates[item.chapterUrl]?.status === 'done') return true;

      // 2. Persisted chapterUrl in localStorage
      if (downloadedUrls.has(item.chapterUrl)) return true;

      const itemIdentity = parseComicIdentity(item.title);
      if (!itemIdentity.key) return false;

      // 3. Persisted identity key in localStorage
      if (downloadedCanonicalKeys.has(itemIdentity.key)) return true;

      // 4. Exact identity match against library comics
      return libraryIdentityKeys.has(itemIdentity.key);
    },
    [downloadStates, downloadedUrls, downloadedCanonicalKeys, libraryIdentityKeys]
  );

  // Check whether a release belongs to a favorite series or a library series
  const checkSeriesStatus = useCallback(
    (item: LatestRelease): { isFavoriteSeries: boolean; isLibrarySeries: boolean; matchedSeries: string | null } => {
      const releaseSeries = parseComicIdentity(item.title).series;
      if (!releaseSeries) {
        return { isFavoriteSeries: false, isLibrarySeries: false, matchedSeries: null };
      }

      // Check favorite series first
      for (const fav of favoriteSeriesNames) {
        if (isSeriesMatch(releaseSeries, fav)) {
          return { isFavoriteSeries: true, isLibrarySeries: true, matchedSeries: fav };
        }
      }

      // Check library series
      for (const lib of librarySeriesNames) {
        if (isSeriesMatch(releaseSeries, lib)) {
          return { isFavoriteSeries: false, isLibrarySeries: true, matchedSeries: lib };
        }
      }

      return { isFavoriteSeries: false, isLibrarySeries: false, matchedSeries: null };
    },
    [favoriteSeriesNames, librarySeriesNames]
  );

  const handleInlineDownload = async (item: LatestRelease) => {
    if (user === null && onOpenAuthModal) {
      onOpenAuthModal();
      return;
    }
    if (user && !user.driveFolderId && onOpenDrivePicker) {
      onOpenDrivePicker();
      return;
    }

    const url = item.chapterUrl;
    setDownloadStates((prev) => ({
      ...prev,
      [url]: { status: 'downloading' }
    }));

    try {
      const data = await downloadComic(url, undefined, {
        onProgress: (s) => {
          setDownloadStates((prev) => ({
            ...prev,
            [url]: { status: 'downloading', percent: s.percent, message: s.message }
          }));
        }
      });

      setDownloadStates((prev) => ({
        ...prev,
        [url]: { status: 'done' }
      }));

      // Persist downloaded URL and identity key permanently across future visits
      const comicKey = parseComicIdentity(item.title).key;
      setDownloadedUrls((prev) => {
        const next = new Set(prev).add(url);
        try {
          localStorage.setItem(urlsStorageKey, JSON.stringify(Array.from(next)));
        } catch {}
        return next;
      });

      if (comicKey) {
        setDownloadedCanonicalKeys((prev) => {
          const next = new Set(prev).add(comicKey);
          try {
            localStorage.setItem(keysStorageKey, JSON.stringify(Array.from(next)));
          } catch {}
          return next;
        });
      }

      // Trigger app-wide library cache updates
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('comix_library_updated'));
      }
      refreshLibraryData();

      // Show toast
      const compText = data.isCompressed
        ? ` [Compressed ${data.percentSaved || ''}%]`
        : data.compressionError
          ? ` [Not compressed: ${data.compressionError}]`
          : '';
      setToastMessage(`Downloaded "${data.title || item.title}"${compText} directly to your Google Drive library!`);
      setTimeout(() => {
        setToastMessage((cur) => (cur?.includes(item.title) ? null : cur));
      }, 4500);
    } catch (err: any) {
      console.error('Download error:', err);
      setDownloadStates((prev) => ({
        ...prev,
        [url]: { status: 'error', error: err.message || 'Download failed' }
      }));
    }
  };

  const fetchReleases = (pageNum: number, append = false) => {
    if (append) setLoadingMore(true);
    else setLoading(true);
    setError(null);

    fetch(apiUrl(`/api/latest-releases?page=${pageNum}`))
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (Array.isArray(data) && data.length > 0) {
          setReleases((prev) => (append ? [...prev, ...data] : data));
        } else if (!append) {
          setReleases([]);
        }
        setLoading(false);
        setLoadingMore(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
        setLoadingMore(false);
      });
  };

  useEffect(() => {
    fetchReleases(1, false);
  }, [user?.id]);

  useEffect(() => {
    refreshLibraryData();

    // Listen for library and favorites changes from other tabs or components
    const handleLibraryEvent = () => refreshLibraryData();
    window.addEventListener('comix_library_updated', handleLibraryEvent);
    window.addEventListener('comix_favorites_updated', handleLibraryEvent);
    return () => {
      window.removeEventListener('comix_library_updated', handleLibraryEvent);
      window.removeEventListener('comix_favorites_updated', handleLibraryEvent);
    };
  }, [refreshLibraryData]);

  const handleLoadMore = () => {
    const nextPage = page + 1;
    setPage(nextPage);
    fetchReleases(nextPage, true);
  };

  // Filter out any news/announcements
  const comicReleases = useMemo(() => {
    return releases.filter((r) => {
      const pub = (r.publisher || '').toLowerCase();
      const title = (r.title || '').toLowerCase();
      return !pub.includes('news') && !title.includes('site update') && !title.includes('weekly update');
    });
  }, [releases]);

  // Unique publishers for quick pill filtering
  const publishers = useMemo(() => {
    return [
      'All',
      ...Array.from(
        new Set(
          comicReleases
            .map((r) => r.publisher)
            .filter((p): p is string => typeof p === 'string' && !p.toLowerCase().includes('news'))
        )
      )
    ];
  }, [comicReleases]);

  // Pre-calculate status flags for all releases
  const releaseStatusMap = useMemo(() => {
    const map = new Map<
      string,
      {
        isInLibrary: boolean;
        isFavoriteSeries: boolean;
        isLibrarySeries: boolean;
        matchedSeries: string | null;
        identity: ComicIdentity;
      }
    >();
    comicReleases.forEach((item) => {
      const isInLib = checkIsComicInLibrary(item);
      const seriesInfo = checkSeriesStatus(item);
      map.set(item.chapterUrl, {
        isInLibrary: isInLib,
        isFavoriteSeries: seriesInfo.isFavoriteSeries,
        isLibrarySeries: seriesInfo.isLibrarySeries,
        matchedSeries: seriesInfo.matchedSeries,
        identity: parseComicIdentity(item.title)
      });
    });
    return map;
  }, [comicReleases, checkIsComicInLibrary, checkSeriesStatus]);

  // Counts for status filters
  const counts = useMemo(() => {
    let faveCount = 0;
    let libSeriesCount = 0;
    let inLibCount = 0;

    comicReleases.forEach((r) => {
      const status = releaseStatusMap.get(r.chapterUrl);
      if (status?.isInLibrary) inLibCount++;
      if (status?.isFavoriteSeries) faveCount++;
      if (status?.isLibrarySeries) libSeriesCount++;
    });

    return { faveCount, libSeriesCount, inLibCount };
  }, [comicReleases, releaseStatusMap]);

  // Apply search query, publisher, and status filters
  const filteredReleases = useMemo(() => {
    return comicReleases.filter((r) => {
      const matchesQuery = r.title.toLowerCase().includes(searchQuery.toLowerCase());
      const matchesPublisher = selectedPublisher === 'All' || r.publisher?.toLowerCase() === selectedPublisher.toLowerCase();
      
      const status = releaseStatusMap.get(r.chapterUrl);
      let matchesStatus = true;
      if (statusFilter === 'favorites') {
        matchesStatus = Boolean(status?.isFavoriteSeries);
      } else if (statusFilter === 'librarySeries') {
        matchesStatus = Boolean(status?.isLibrarySeries);
      } else if (statusFilter === 'inLibrary') {
        matchesStatus = Boolean(status?.isInLibrary);
      }

      return matchesQuery && matchesPublisher && matchesStatus;
    });
  }, [comicReleases, searchQuery, selectedPublisher, statusFilter, releaseStatusMap]);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '1rem', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ fontSize: '1.8rem', fontWeight: 700, marginBottom: '0.5rem' }}>
            What's New &amp; Latest Releases
          </h1>
          <p style={{ color: 'var(--text-secondary)' }}>
            Showing {releases.length} live digital comic releases from GetComics. Comics in your library or tracked series are automatically highlighted below.
          </p>
        </div>

        {/* Quick Filter Search */}
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="search"
            placeholder="Filter releases by title..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              background: '#1e293b',
              border: '1px solid var(--border-color)',
              color: 'var(--text-primary)',
              padding: '0.6rem 1rem',
              borderRadius: '8px',
              fontSize: '0.9rem',
              width: '260px',
              outline: 'none'
            }}
          />
          <button
            onClick={() => { setPage(1); fetchReleases(1, false); refreshLibraryData(); }}
            disabled={loading}
            style={{
              background: 'rgba(59, 130, 246, 0.15)',
              border: '1px solid var(--accent-color)',
              color: 'var(--accent-color)',
              padding: '0.6rem 1rem',
              borderRadius: '8px',
              fontSize: '0.85rem',
              fontWeight: 600,
              cursor: loading ? 'not-allowed' : 'pointer'
            }}
          >
            <RefreshCw size={16} style={{ marginRight: '0.4rem' }} /> Refresh
          </button>
        </div>
      </div>

      {/* Primary Category & Collection Filter Tabs */}
      <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', marginBottom: '1.25rem' }}>
        <button
          onClick={() => setStatusFilter('all')}
          style={{
            background: statusFilter === 'all' ? 'var(--accent-color)' : 'rgba(255, 255, 255, 0.05)',
            border: `1px solid ${statusFilter === 'all' ? 'var(--accent-color)' : 'var(--border-color)'}`,
            color: statusFilter === 'all' ? '#fff' : 'var(--text-secondary)',
            padding: '0.45rem 1rem',
            borderRadius: '20px',
            fontSize: '0.84rem',
            fontWeight: 600,
            cursor: 'pointer',
            transition: 'all 0.15s ease'
          }}
        >
          All Releases ({comicReleases.length})
        </button>

        {counts.faveCount > 0 && (
          <button
            onClick={() => setStatusFilter(statusFilter === 'favorites' ? 'all' : 'favorites')}
            style={{
              background: statusFilter === 'favorites' ? '#e11d48' : 'rgba(225, 29, 72, 0.15)',
              border: `1px solid ${statusFilter === 'favorites' ? '#e11d48' : 'rgba(225, 29, 72, 0.35)'}`,
              color: statusFilter === 'favorites' ? '#fff' : '#fb7185',
              padding: '0.45rem 1rem',
              borderRadius: '20px',
              fontSize: '0.84rem',
              fontWeight: 600,
              cursor: 'pointer',
              transition: 'all 0.15s ease',
              display: 'flex',
              alignItems: 'center',
              gap: '0.35rem'
            }}
          >
            <Heart size={14} /> Favorite Series ({counts.faveCount})
          </button>
        )}

        {counts.libSeriesCount > 0 && (
          <button
            onClick={() => setStatusFilter(statusFilter === 'librarySeries' ? 'all' : 'librarySeries')}
            style={{
              background: statusFilter === 'librarySeries' ? '#d97706' : 'rgba(245, 158, 11, 0.15)',
              border: `1px solid ${statusFilter === 'librarySeries' ? '#d97706' : 'rgba(245, 158, 11, 0.35)'}`,
              color: statusFilter === 'librarySeries' ? '#fff' : '#fbbf24',
              padding: '0.45rem 1rem',
              borderRadius: '20px',
              fontSize: '0.84rem',
              fontWeight: 600,
              cursor: 'pointer',
              transition: 'all 0.15s ease',
              display: 'flex',
              alignItems: 'center',
              gap: '0.35rem'
            }}
          >
            <Star size={14} /> In Library Series ({counts.libSeriesCount})
          </button>
        )}

        {counts.inLibCount > 0 && (
          <button
            onClick={() => setStatusFilter(statusFilter === 'inLibrary' ? 'all' : 'inLibrary')}
            style={{
              background: statusFilter === 'inLibrary' ? '#059669' : 'rgba(16, 185, 129, 0.15)',
              border: `1px solid ${statusFilter === 'inLibrary' ? '#059669' : 'rgba(16, 185, 129, 0.35)'}`,
              color: statusFilter === 'inLibrary' ? '#fff' : '#34d399',
              padding: '0.45rem 1rem',
              borderRadius: '20px',
              fontSize: '0.84rem',
              fontWeight: 600,
              cursor: 'pointer',
              transition: 'all 0.15s ease',
              display: 'flex',
              alignItems: 'center',
              gap: '0.35rem'
            }}
          >
            <span>&#10003;</span> In Library ({counts.inLibCount})
          </button>
        )}
      </div>

      {/* Publisher Category Pills */}
      {publishers.length > 2 && (
        <div style={{ display: 'flex', gap: '0.45rem', flexWrap: 'wrap', marginBottom: '2rem' }}>
          {publishers.map((pub) => (
            <button
              key={pub}
              onClick={() => setSelectedPublisher(pub)}
              style={{
                background: selectedPublisher === pub ? 'rgba(59, 130, 246, 0.25)' : 'rgba(255, 255, 255, 0.03)',
                border: `1px solid ${selectedPublisher === pub ? 'var(--accent-color)' : 'rgba(255, 255, 255, 0.08)'}`,
                color: selectedPublisher === pub ? 'var(--accent-color)' : 'var(--text-secondary)',
                padding: '0.3rem 0.8rem',
                borderRadius: '16px',
                fontSize: '0.78rem',
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'all 0.15s ease'
              }}
            >
              {pub}
            </button>
          ))}
        </div>
      )}

      {loading && (
        <div style={{ color: 'var(--accent-color)', padding: '3rem', textAlign: 'center', fontSize: '1.1rem' }}>
          <Loader2 size={16} style={{ marginRight: '0.4rem' }} /> Fetching live GetComics releases...
        </div>
      )}

      {error && (
        <div style={{ color: '#ef4444', padding: '1rem', background: 'rgba(239, 68, 68, 0.1)', borderRadius: '8px', marginBottom: '1.5rem' }}>
          Could not fetch releases: {error}
        </div>
      )}

      {!loading && filteredReleases.length === 0 && (
        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>
          No releases match the selected filters.
        </div>
      )}

      <div className="library-grid">
        {filteredReleases.map((item, idx) => {
          const status = releaseStatusMap.get(item.chapterUrl) || {
            isInLibrary: false,
            isFavoriteSeries: false,
            isLibrarySeries: false,
            matchedSeries: null,
            identity: parseComicIdentity(item.title)
          };

          const state = downloadStates[item.chapterUrl];
          const isDownloading = state?.status === 'downloading';
          const isDone = status.isInLibrary || state?.status === 'done';
          const isErr = state?.status === 'error';

          // Names what exactly is missing from the library, e.g. "#7" or "Vol. 3"
          const identity = status.identity;
          const missingLabel =
            !isDone && (status.isFavoriteSeries || status.isLibrarySeries) && identity.number !== null
              ? identity.kind === 'volume'
                ? `Vol. ${identity.number}`
                : `#${identity.number}`
              : '';

          return (
            <div key={idx} className="comic-card">
              <div style={{ position: 'relative' }}>
                <img
                  src={item.cover || 'https://getcomics.org/share/uploads/2020/04/cropped-GetComics-Favicon.png'}
                  alt={item.title}
                  className="comic-cover"
                  loading="lazy"
                  onError={(e: any) => {
                    e.target.style.opacity = '0.5';
                  }}
                />

                {/* Status Badges on Top Corners of Cover */}
                {isDone ? (
                  <div
                    style={{
                      position: 'absolute',
                      top: '8px',
                      left: '8px',
                      background: 'rgba(16, 185, 129, 0.92)',
                      backdropFilter: 'blur(6px)',
                      color: '#fff',
                      padding: '3px 8px',
                      borderRadius: '5px',
                      fontSize: '0.68rem',
                      fontWeight: 700,
                      letterSpacing: '0.02em',
                      boxShadow: '0 2px 8px rgba(0, 0, 0, 0.4)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px'
                    }}
                  >
                    <span>&#10003;</span> IN LIBRARY
                  </div>
                ) : status.isFavoriteSeries ? (
                  <div
                    style={{
                      position: 'absolute',
                      top: '8px',
                      left: '8px',
                      background: 'linear-gradient(135deg, rgba(244, 63, 94, 0.95), rgba(225, 29, 72, 0.95))',
                      backdropFilter: 'blur(6px)',
                      color: '#fff',
                      padding: '3px 8px',
                      borderRadius: '5px',
                      fontSize: '0.68rem',
                      fontWeight: 700,
                      letterSpacing: '0.02em',
                      boxShadow: '0 2px 10px rgba(225, 29, 72, 0.45)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px'
                    }}
                  >
                    <Heart size={14} /> FAVORITE SERIES
                  </div>
                ) : status.isLibrarySeries ? (
                  <div
                    style={{
                      position: 'absolute',
                      top: '8px',
                      left: '8px',
                      background: 'linear-gradient(135deg, rgba(245, 158, 11, 0.95), rgba(217, 119, 6, 0.95))',
                      backdropFilter: 'blur(6px)',
                      color: '#fff',
                      padding: '3px 8px',
                      borderRadius: '5px',
                      fontSize: '0.68rem',
                      fontWeight: 700,
                      letterSpacing: '0.02em',
                      boxShadow: '0 2px 10px rgba(245, 158, 11, 0.45)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px'
                    }}
                  >
                    <Star size={14} /> IN YOUR SERIES
                  </div>
                ) : null}

                {/* Secondary Heart Indicator on Top Right if already downloaded */}
                {isDone && status.isFavoriteSeries && (
                  <div
                    title="In your Favorite Series"
                    style={{
                      position: 'absolute',
                      top: '8px',
                      right: '8px',
                      background: 'rgba(0, 0, 0, 0.75)',
                      backdropFilter: 'blur(6px)',
                      padding: '3px 6px',
                      borderRadius: '5px',
                      fontSize: '0.8rem',
                      lineHeight: 1
                    }}
                  >
                    <Heart size={14} />
                  </div>
                )}

                {/* Secondary Star Indicator on Top Right if already downloaded */}
                {isDone && !status.isFavoriteSeries && status.isLibrarySeries && (
                  <div
                    title="In your Library Series"
                    style={{
                      position: 'absolute',
                      top: '8px',
                      right: '8px',
                      background: 'rgba(0, 0, 0, 0.75)',
                      backdropFilter: 'blur(6px)',
                      padding: '3px 6px',
                      borderRadius: '5px',
                      fontSize: '0.8rem',
                      lineHeight: 1
                    }}
                  >
                    <Star size={14} />
                  </div>
                )}

                {item.size && (
                  <div
                    style={{
                      position: 'absolute',
                      bottom: '8px',
                      right: '8px',
                      background: 'rgba(0, 0, 0, 0.75)',
                      backdropFilter: 'blur(4px)',
                      color: '#93c5fd',
                      padding: '2px 7px',
                      borderRadius: '4px',
                      fontSize: '0.72rem',
                      fontWeight: 600
                    }}
                  >
                    <Save size={14} /> {item.size}
                  </div>
                )}
              </div>

              <div className="comic-info">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem', gap: '0.5rem' }}>
                  {item.publisher && (
                    <div style={{ fontSize: '0.72rem', color: 'var(--accent-color)', fontWeight: 600, textTransform: 'uppercase' }}>
                      {item.publisher} {item.year ? `• ${item.year}` : ''}
                    </div>
                  )}

                  {/* Micro indicator tag in info section */}
                  {status.isInLibrary ? null : status.isFavoriteSeries ? (
                    <span
                      title={`Belongs to your favorite series: ${status.matchedSeries || 'Favorite'} - missing from your library`}
                      style={{
                        fontSize: '0.7rem',
                        fontWeight: 700,
                        color: '#fb7185',
                        whiteSpace: 'nowrap'
                      }}
                    >
                      <Heart size={12} style={{ marginRight: '0.4rem' }} /> Fave Series{missingLabel ? ` • ${missingLabel}` : ''}
                    </span>
                  ) : status.isLibrarySeries ? (
                    <span
                      title={`Belongs to your collected series: ${status.matchedSeries || 'Series'} - missing from your library`}
                      style={{
                        fontSize: '0.7rem',
                        fontWeight: 700,
                        color: '#fbbf24',
                        whiteSpace: 'nowrap'
                      }}
                    >
                      <Star size={12} style={{ marginRight: '0.4rem' }} /> Tracked Series{missingLabel ? ` • ${missingLabel}` : ''}
                    </span>
                  ) : null}
                </div>

                <div className="comic-title" title={item.title}>
                  {item.title}
                </div>

                <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
                  {isDone ? (
                    <div
                      style={{
                        flex: 1,
                        background: 'rgba(16, 185, 129, 0.15)',
                        border: '1px solid rgba(16, 185, 129, 0.35)',
                        color: '#34d399',
                        padding: '0.48rem 0',
                        borderRadius: '6px',
                        fontSize: '0.8rem',
                        fontWeight: 700,
                        textAlign: 'center',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '0.35rem',
                        letterSpacing: '0.01em',
                        boxShadow: '0 2px 8px rgba(16, 185, 129, 0.1)'
                      }}
                    >
                      <span>&#10003;</span> In Library
                    </div>
                  ) : (
                    <button
                      onClick={() => handleInlineDownload(item)}
                      disabled={isDownloading}
                      style={{
                        flex: 1,
                        background: isDownloading
                          ? 'rgba(59, 130, 246, 0.3)'
                          : isErr
                          ? 'rgba(239, 68, 68, 0.85)'
                          : status.isFavoriteSeries
                          ? 'linear-gradient(135deg, #e11d48, #be123c)'
                          : 'var(--accent-color)',
                        border: status.isFavoriteSeries ? '1px solid rgba(251, 113, 133, 0.4)' : 'none',
                        color: '#fff',
                        padding: '0.48rem 0',
                        borderRadius: '6px',
                        fontSize: '0.8rem',
                        fontWeight: 600,
                        cursor: isDownloading ? 'wait' : 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '0.35rem',
                        transition: 'all 0.2s ease',
                        boxShadow: status.isFavoriteSeries && !isDownloading ? '0 3px 12px rgba(225, 29, 72, 0.3)' : 'none'
                      }}
                      title={isErr ? state.error : 'Download CBZ to Google Drive library'}
                    >
                      {isDownloading ? (
                        <>
                          <span style={{ display: 'inline-block', animation: 'spin 1s linear infinite' }}>
                            <Loader2 size={16} />
                          </span>
                          {state?.percent ? `Downloading ${state.percent}%` : 'Downloading...'}
                        </>
                      ) : isErr ? (
                        'Retry'
                      ) : (
                        'Download CBZ'
                      )}
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Pagination / Load More */}
      {!loading && releases.length > 0 && (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: '3rem', marginBottom: '2rem' }}>
          <button
            onClick={handleLoadMore}
            disabled={loadingMore}
            style={{
              background: 'rgba(59, 130, 246, 0.15)',
              border: '1px solid var(--accent-color)',
              color: 'var(--accent-color)',
              padding: '0.75rem 2rem',
              borderRadius: '8px',
              fontSize: '1rem',
              fontWeight: 600,
              cursor: loadingMore ? 'not-allowed' : 'pointer'
            }}
          >
            {loadingMore ? 'Fetching More Releases...' : `Load More Comics (Page ${page + 1})`}
          </button>
        </div>
      )}

      {/* Background Download Toast Notification */}
      {toastMessage && (
        <div
          style={{
            position: 'fixed',
            bottom: '24px',
            right: '24px',
            background: '#1e293b',
            border: '1px solid #10b981',
            borderRadius: '10px',
            padding: '0.85rem 1.25rem',
            color: '#fff',
            boxShadow: '0 8px 30px rgba(0, 0, 0, 0.6)',
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem',
            zIndex: 1000
          }}
        >
          <span>
            <PartyPopper size={20} />
          </span>
          <span style={{ fontSize: '0.88rem', fontWeight: 600 }}>{toastMessage}</span>
          <button
            onClick={() => setToastMessage(null)}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              marginLeft: '0.5rem',
              fontSize: '1rem'
            }}
          >
            &#10005;
          </button>
        </div>
      )}
    </div>
  );
}
