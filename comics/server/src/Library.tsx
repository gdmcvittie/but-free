import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { apiUrl } from './api';
import type { GoogleUserProfile } from './AuthModal';
import {
  getAllOfflineComics,
  saveLibraryOffline,
  getLibraryOffline,
  autoDownloadComicForOffline,
  getOfflineCoverUrl,
  getCachedOfflineCoverUrl,
  deleteOfflineComic
} from './offlineStorage';
import {
  Zap,
  BookOpen,
  Heart,
  Folder,
  Loader2,
  RefreshCw,
  Clock,
  FileText,
  FolderTree,
  Type,
  Hash,
  ChevronDown,
  ChevronUp,
  SquareCheck,
  Sparkles,
  Search,
  Trash2,
  Pencil,
  TriangleAlert,
  Save,
  CircleCheck
} from 'lucide-react';

// In-memory cache across tab switches so navigating between Library, Continue Reading, and Favorites is 0ms instant
let memoryComicsCache: Comic[] | null = null;

export interface Comic {
  id: any;
  title: string;
  type?: string;
  coverImage?: string | null;
  filepath?: string;
  googleFileId?: string;
  series?: string;
  item?: string;
  isVolume?: boolean;
  totalPages?: number;
  initialPage?: number;
  currentPage?: number;
  initialZoomNormX?: number;
  initialZoomNormY?: number;
  size?: number;
  modifiedTime?: string;
}

export interface ComicProgress {
  currentPage: number;
  totalPages?: number;
  zoomNormX?: number;
  zoomNormY?: number;
  lastRead?: string;
}

export interface SeriesGroup {
  seriesName: string;
  comics: Comic[];
  issueCount: number;
  readCount: number;
  latestId: any;
  latestRead?: string;
  sampleCoverComic?: Comic;
  isFavorite?: boolean;
}

/**
 * Robust series name extractor from comic metadata, parent directory, or title.
 */
function extractSeries(comic: Comic): string {
  if (comic.series && comic.series.trim()) {
    return comic.series.trim();
  }

  // Check parent directory from filepath if present
  if (comic.filepath) {
    try {
      const normalized = comic.filepath.replace(/\\/g, '/');
      const parts = normalized.split('/').filter(Boolean);
      if (parts.length > 1) {
        const parent = parts[parts.length - 2];
        const generic = new Set(['downloads', 'dl', 'unsorted', 'loose', 'temp', '_tmp', 'new', 'comics']);
        if (parent && !generic.has(parent.toLowerCase())) {
          return sanitizeSeriesName(parent);
        }
      }
    } catch {}
  }

  // Regex fallback from title
  return parseSeriesFromTitle(comic.title || '');
}

function sanitizeSeriesName(name: string): string {
  if (!name) return 'Comics';
  return name
    .replace(/[<>:"/\\|?*]+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[-–—\s,.]+|[-–—\s,.]+$/g, '')
    .trim() || 'Comics';
}

function parseSeriesFromTitle(rawTitle: string): string {
  if (!rawTitle) return 'Comics';
  let clean = rawTitle.replace(/\.(cbz|cbr|pdf|zip)$/i, '').trim();
  clean = clean
    .replace(/\b(digital|hd|webrip|c2c|novus|minutemen|zone-empire|empire|dcp|kresge|steam|hybrid|complete|scan)\b/gi, '')
    .replace(/\(cover\s+[a-z0-9]+\)/gi, '')
    .replace(/\[\s*\]|\(\s*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Volume patterns: e.g. "Morning Glories Vol. 1", "Morning Glories, Vol. 02"
  const volMatch = clean.match(/^(.*?)(?:[\s,–—:-]+|\s+)(?:(vol(?:ume)?|bk|book|tpb|tome|compendium|omnibus)\.?|v)\s*([0-9]+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)\b(?:\s*[:-]\s*(.*?))?(?:\s*\(.*?\))?$/i);
  if (volMatch && volMatch[1].trim().length > 1) {
    return sanitizeSeriesName(volMatch[1]);
  }

  // Issue Hashtag: e.g. "Revival #47", "Batman (2016) #125"
  const hashMatch = clean.match(/^(.*?)(?:\s*#\s*([0-9]+(?:\.[0-9]+)?))/i);
  if (hashMatch && hashMatch[1].trim().length > 1) {
    return sanitizeSeriesName(hashMatch[1]);
  }

  // Explicit issue/chapter: e.g. "Invincible Issue 100", "Batman Chapter 12"
  const wordMatch = clean.match(/^(.*?)(?:[\s,–—:-]+|\s+)(?:issue|iss|ch|chapter|no)\.?\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (wordMatch && wordMatch[1].trim().length > 1) {
    return sanitizeSeriesName(wordMatch[1]);
  }

  // Trailing digits: e.g. "Revival 47", "Daredevil 001 (2019)"
  const trailingMatch = clean.match(/^(.*?)(?:\s*[-–—]\s*|\s+)(?:0([0-9]+)|([0-9]{1,4}))(?:\s*\(.*?\))?$/);
  if (trailingMatch && trailingMatch[1].trim().length > 1) {
    return sanitizeSeriesName(trailingMatch[1]);
  }

  return sanitizeSeriesName(clean) || 'Comics';
}

/**
 * Extracts formatted issue or volume string (e.g. "47", "125", "Vol. 1").
 */
function extractIssueNumber(comic: Comic): string | null {
  const source = `${comic.title || ''} ${comic.filepath || ''} ${comic.item || ''}`;

  const hash = source.match(/#\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (hash) return String(parseFloat(hash[1]));

  const word = source.match(/\b(?:issue|iss|no|ch|chapter)\.?\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (word) return String(parseFloat(word[1]));

  const vol = source.match(/\b(?:vol(?:ume)?|v|book|bk|tpb)\.?\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (vol) return `Vol. ${parseFloat(vol[1])}`;

  const trailing = source.match(/(?:[\s\-–—:]|^)0*([1-9][0-9]{0,3})(?:\.(?:cbz|cbr|pdf|zip))?(?:\s*\([0-9]{4}\))?\s*$/i);
  if (trailing) {
    const num = parseInt(trailing[1], 10);
    if (num < 1750 || num > new Date().getFullYear() + 1) {
      return String(num);
    }
  }

  return null;
}

/**
 * Extracts a numeric value for accurate ascending/descending issue sorting.
 */
function getComicIssueNumeric(comic: Comic): number | null {
  const source = `${comic.title || ''} ${comic.filepath || ''} ${comic.item || ''}`;

  const hash = source.match(/#\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (hash) return parseFloat(hash[1]);

  const word = source.match(/\b(?:issue|iss|no|ch|chapter)\.?\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (word) return parseFloat(word[1]);

  const vol = source.match(/\b(?:vol(?:ume)?|v|book|bk|tpb)\.?\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (vol) return parseFloat(vol[1]);

  const trailing = source.match(/(?:[\s\-–—:]|^)0*([1-9][0-9]{0,3})(?:\.(?:cbz|cbr|pdf|zip))?(?:\s*\([0-9]{4}\))?\s*$/i);
  if (trailing) {
    const num = parseInt(trailing[1], 10);
    if (num < 1750 || num > new Date().getFullYear() + 1) {
      return num;
    }
  }

  return null;
}

const VIEW_PREFS_KEY = 'comix_library_view_prefs';

interface ViewPrefs {
  viewMode: 'series' | 'flat';
  sortBy: 'latest' | 'alpha' | 'issue' | 'lastRead';
  isReversed: boolean;
  seriesLayout: 'folders' | 'shelves';
}

function loadSavedPrefs(): ViewPrefs {
  try {
    const saved = localStorage.getItem(VIEW_PREFS_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      return {
        viewMode: parsed.viewMode === 'flat' ? 'flat' : 'series',
        sortBy: ['latest', 'alpha', 'issue', 'lastRead'].includes(parsed.sortBy) ? parsed.sortBy : 'latest',
        isReversed: Boolean(parsed.isReversed),
        seriesLayout: parsed.seriesLayout === 'shelves' ? 'shelves' : 'folders'
      };
    }
  } catch {}
  return {
    viewMode: 'series',
    sortBy: 'latest',
    isReversed: false,
    seriesLayout: 'folders'
  };
}

interface LibraryProps {
  onOpenComic: (comic: Comic) => void;
  showFavoritesOnly?: boolean;
  showContinueReadingOnly?: boolean;
  user?: GoogleUserProfile | null;
  currentProfile?: any;
  progressVersion?: number;
  libraryVersion?: number;
  onOpenDrivePicker?: () => void;
  onOpenAuthModal?: () => void;
  onNavigateView?: (view: string) => void;
  onNavigateToOmnibus?: (seriesName?: string) => void;
}

export default function Library({
  onOpenComic,
  showFavoritesOnly = false,
  showContinueReadingOnly = false,
  user,
  currentProfile: propProfile,
  progressVersion,
  libraryVersion,
  onOpenDrivePicker,
  onOpenAuthModal,
  onNavigateView,
  onNavigateToOmnibus
}: LibraryProps) {
  const currentProfile = propProfile || user;

  const [comics, setComics] = useState<Comic[]>(() => memoryComicsCache || []);
  const [readingProgress, setReadingProgress] = useState<Record<string, ComicProgress>>({});
  const [loading, setLoading] = useState(!memoryComicsCache || memoryComicsCache.length === 0);
  const [scanning, setScanning] = useState(false);
  const [sorting, setSorting] = useState(false);
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const [offlineCovers, setOfflineCovers] = useState<Record<string, string>>({});

  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [seriesFavorites, setSeriesFavorites] = useState<Set<string>>(new Set());
  // Tracks comics whose CBZ cover endpoint failed, allowing fallback to remote coverImage
  const [cbzCoverFailed, setCbzCoverFailed] = useState<Set<string>>(new Set());
  // Tracks comics whose remote coverImage also failed, triggering stylized card fallback
  const [allCoversFailed, setAllCoversFailed] = useState<Set<string>>(new Set());

  // --- Viewing Options State ---
  const [initialPrefs] = useState<ViewPrefs>(loadSavedPrefs);
  const [viewMode, setViewMode] = useState<'series' | 'flat'>(initialPrefs.viewMode);
  const [sortBy, setSortBy] = useState<'latest' | 'alpha' | 'issue' | 'lastRead'>(initialPrefs.sortBy);
  const [isReversed, setIsReversed] = useState<boolean>(initialPrefs.isReversed);
  const [seriesLayout, setSeriesLayout] = useState<'folders' | 'shelves'>(initialPrefs.seriesLayout);
  const [activeSeriesFolder, setActiveSeriesFolder] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'in-progress' | 'unread' | 'completed' | 'favorites' | 'offline'>('all');
  const [offlineComicIds, setOfflineComicIds] = useState<Set<string>>(new Set());
  const [collapsedShelves, setCollapsedShelves] = useState<Set<string>>(new Set());

  // --- Deletion & Selection Mode State ---
  const [comicPendingDelete, setComicPendingDelete] = useState<Comic | null>(null);
  const [seriesPendingDelete, setSeriesPendingDelete] = useState<SeriesGroup | null>(null);
  const [bulkPendingDelete, setBulkPendingDelete] = useState<boolean>(false);
  const [isSelectMode, setIsSelectMode] = useState<boolean>(false);
  const [selectedComicIds, setSelectedComicIds] = useState<Set<string>>(new Set());
  const [isDeleting, setIsDeleting] = useState<boolean>(false);
  const [deleteToast, setDeleteToast] = useState<string | null>(null);

  // --- Metadata Edit Modal State ---
  const [comicPendingEdit, setComicPendingEdit] = useState<Comic | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editSeries, setEditSeries] = useState('');
  const [editItem, setEditItem] = useState('');
  const [editIsVolume, setEditIsVolume] = useState(false);
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Folder Touch Tracking for Mobile Swipe Gestures
  const folderTouchRef = useRef<{ startX: number; startY: number; startTime: number }>({
    startX: 0,
    startY: 0,
    startTime: 0
  });

  // Open series folder and push browser history state
  const handleOpenSeriesFolder = useCallback((seriesName: string) => {
    try {
      window.history.pushState({ seriesFolder: seriesName }, '');
    } catch {}
    setActiveSeriesFolder(seriesName);
  }, []);

  // Back from series folder: pop browser history or reset state
  const handleBackFromSeriesFolder = useCallback(() => {
    if (window.history.state && window.history.state.seriesFolder) {
      window.history.back();
    } else {
      setActiveSeriesFolder(null);
    }
  }, []);

  // Listen to popstate for system / browser back button navigation
  useEffect(() => {
    const handlePopState = (e: PopStateEvent) => {
      if (e.state && e.state.seriesFolder) {
        setActiveSeriesFolder(e.state.seriesFolder);
      } else {
        setActiveSeriesFolder(null);
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Touch handlers to detect horizontal swipe gestures on mobile
  const handleFolderTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      folderTouchRef.current = {
        startX: e.touches[0].clientX,
        startY: e.touches[0].clientY,
        startTime: Date.now()
      };
    }
  }, []);

  const handleFolderTouchEnd = useCallback((e: React.TouchEvent) => {
    if (e.changedTouches.length === 1 && activeSeriesFolder) {
      const deltaX = e.changedTouches[0].clientX - folderTouchRef.current.startX;
      const deltaY = e.changedTouches[0].clientY - folderTouchRef.current.startY;
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);

      // Detect horizontal swipe (swipe left deltaX < -45 or swipe right deltaX > 45)
      // absX must dominate vertical scroll (absX > absY * 1.2)
      if (absX > 45 && absX > absY * 1.2) {
        handleBackFromSeriesFolder();
      }
    }
  }, [activeSeriesFolder, handleBackFromSeriesFolder]);

  // Save viewing preferences on changes
  useEffect(() => {
    try {
      localStorage.setItem(
        VIEW_PREFS_KEY,
        JSON.stringify({
          viewMode,
          sortBy,
          isReversed,
          seriesLayout
        })
      );
    } catch {}
  }, [viewMode, sortBy, isReversed, seriesLayout]);

  const storageKey = `comix_favorites_${currentProfile?.id || 'default'}`;
  const seriesStorageKey = `comix_series_favorites_${currentProfile?.id || 'default'}`;

  // Load favorites and series favorites for current profile
  useEffect(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        setFavorites(new Set(JSON.parse(saved).map(String)));
      } else {
        setFavorites(new Set());
      }
    } catch {
      setFavorites(new Set());
    }

    try {
      const savedSeries = localStorage.getItem(seriesStorageKey);
      if (savedSeries) {
        setSeriesFavorites(new Set(JSON.parse(savedSeries)));
      } else {
        setSeriesFavorites(new Set());
      }
    } catch {
      setSeriesFavorites(new Set());
    }

    if (currentProfile?.id) {
      fetch(apiUrl(`/api/favorites/${currentProfile.id}`))
        .then((r) => r.json())
        .then((data) => {
          if (Array.isArray(data)) {
            const set = new Set(data.map(String));
            setFavorites(set);
            try {
              localStorage.setItem(storageKey, JSON.stringify(Array.from(set)));
            } catch {}
          }
        })
        .catch(() => {});

      fetch(apiUrl(`/api/favorites/series/${currentProfile.id}`))
        .then((r) => r.json())
        .then((data) => {
          if (Array.isArray(data)) {
            const set = new Set(data);
            setSeriesFavorites(set);
            try {
              localStorage.setItem(seriesStorageKey, JSON.stringify(data));
            } catch {}
          }
        })
        .catch(() => {});
    }
  }, [storageKey, seriesStorageKey, currentProfile?.id]);

  // Track comics saved locally for offline reading
  const refreshOfflineComics = useCallback(async () => {
    try {
      const offlineList = await getAllOfflineComics();
      const completeIds = new Set(offlineList.filter((c) => c.isComplete).map((c) => String(c.id)));
      setOfflineComicIds(completeIds);
    } catch {}
  }, []);

  useEffect(() => {
    refreshOfflineComics();
    window.addEventListener('comix_offline_updated', refreshOfflineComics);
    return () => window.removeEventListener('comix_offline_updated', refreshOfflineComics);
  }, [refreshOfflineComics]);

  // Pre-resolve offline covers for downloaded comics
  useEffect(() => {
    if (offlineComicIds.size > 0) {
      offlineComicIds.forEach((id) => {
        if (!offlineCovers[id]) {
          getOfflineCoverUrl(id).then((blobUrl) => {
            if (blobUrl) {
              setOfflineCovers((prev) => (prev[id] === blobUrl ? prev : { ...prev, [id]: blobUrl }));
            }
          });
        }
      });
    }
  }, [offlineComicIds, offlineCovers]);

  // Load reading progress for current profile in background (never flashes or wipes comics)
  const fetchReadingProgress = useCallback(async () => {
    if (!currentProfile?.id) return;
    try {
      const res = await fetch(apiUrl(`/api/progress/${currentProfile.id}`));
      if (res.ok) {
        const data = await res.json();
        setReadingProgress(data || {});
      }
    } catch (e) {
      console.warn('Failed to load reading progress:', e);
    }
  }, [currentProfile?.id]);

  // progressVersion ONLY updates reading progress in the background (0ms UI latency!)
  useEffect(() => {
    fetchReadingProgress();
  }, [fetchReadingProgress, progressVersion]);

  // Automatically remove completed comics from offline storage
  useEffect(() => {
    if (offlineComicIds.size === 0) return;
    Object.entries(readingProgress).forEach(([comicId, prog]) => {
      if (prog && prog.totalPages && prog.currentPage >= prog.totalPages) {
        if (offlineComicIds.has(comicId)) {
          deleteOfflineComic(comicId);
        }
      }
    });
  }, [readingProgress, offlineComicIds]);

  // Load comics from backend with stale-while-revalidate and offline caching
  const fetchComics = useCallback(async () => {
    // If not already in memory, display cached comics from IndexedDB immediately in < 10ms
    if (!memoryComicsCache || memoryComicsCache.length === 0) {
      try {
        const offlineCached = await getLibraryOffline();
        if (offlineCached && offlineCached.length > 0) {
          memoryComicsCache = offlineCached;
          setComics(offlineCached);
          setLoading(false);
        } else {
          setLoading(true);
        }
      } catch {
        setLoading(true);
      }
    } else {
      setLoading(false);
    }

    // Background network revalidation with 15-second timeout to never block UI
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    try {
      const res = await fetch(apiUrl('/api/comics'), { signal: controller.signal });
      clearTimeout(timeoutId);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          memoryComicsCache = data;
          setComics(data);
          saveLibraryOffline(data);
          return;
        }
      }
    } catch (err) {
      clearTimeout(timeoutId);
      // Offline / network failure: ensure offline storage comics are rendered
      if (!memoryComicsCache || memoryComicsCache.length === 0) {
        try {
          const offlineCached = await getLibraryOffline();
          if (offlineCached && offlineCached.length > 0) {
            memoryComicsCache = offlineCached;
            setComics(offlineCached);
            return;
          }
          const offlineList = await getAllOfflineComics();
          if (offlineList && offlineList.length > 0) {
            const mapped = offlineList.map((c) => ({
              id: c.id,
              title: c.title,
              totalPages: c.totalPages,
              type: c.type || 'CBZ',
              series: c.series,
              coverImage: c.coverUrl
            }));
            memoryComicsCache = mapped;
            setComics(mapped);
            return;
          }
        } catch (cacheErr) {
          console.warn('Offline cache read error:', cacheErr);
        }
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchComics();
  }, [fetchComics, libraryVersion, currentProfile?.id, currentProfile?.driveFolderId]);

  useEffect(() => {
    const handleLibUpdate = () => {
      fetchComics();
    };
    window.addEventListener('comix_library_updated', handleLibUpdate);
    return () => window.removeEventListener('comix_library_updated', handleLibUpdate);
  }, [fetchComics]);

  const handleScanLibrary = async () => {
    setScanning(true);
    setScanMessage('Scanning Google Drive folder for comics...');
    try {
      const res = await fetch(apiUrl('/api/settings/scan'), { method: 'POST' });
      if (!res.ok) throw new Error('Scan request failed');
      const data = await res.json();
      const count = data.count || data.added || 0;
      setScanMessage(`Scan complete: ${count} comics active in library.`);
      await fetchComics();
      await fetchReadingProgress();
      setTimeout(() => setScanMessage(null), 5000);
    } catch (err: any) {
      setScanMessage(`Scan error: ${err.message}`);
      setTimeout(() => setScanMessage(null), 5000);
    } finally {
      setScanning(false);
    }
  };

  const handleSortLooseComics = async () => {
    setSorting(true);
    setScanMessage('Sorting loose comics into series folders...');
    try {
      const res = await fetch(apiUrl('/api/comics/sort'), { method: 'POST' });
      if (!res.ok) throw new Error('Sort request failed');
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Sort failed');
      setScanMessage(data.message || `Sorted ${data.movedCount || 0} comics.`);
      await fetchComics();
      await fetchReadingProgress();
      setTimeout(() => setScanMessage(null), 5000);
    } catch (err: any) {
      setScanMessage(`Sort error: ${err.message}`);
      setTimeout(() => setScanMessage(null), 5000);
    } finally {
      setSorting(false);
    }
  };

  const toggleFavorite = (comicId: any, e: React.MouseEvent) => {
    e.stopPropagation();
    const idStr = String(comicId);
    const isFavNow = !favorites.has(idStr);
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(idStr)) {
        next.delete(idStr);
      } else {
        next.add(idStr);
      }
      try {
        localStorage.setItem(storageKey, JSON.stringify(Array.from(next)));
      } catch {}
      return next;
    });

    fetch(apiUrl('/api/favorites'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profileId: currentProfile?.id,
        comicId: idStr,
        isFavorite: isFavNow
      })
    }).catch(() => {});
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('comix_favorites_updated'));
    }
  };

  const toggleSeriesFavorite = (seriesName: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    const cleanName = seriesName.trim();
    if (!cleanName) return;
    const isFavNow = !seriesFavorites.has(cleanName);

    setSeriesFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(cleanName)) {
        next.delete(cleanName);
      } else {
        next.add(cleanName);
      }
      try {
        localStorage.setItem(seriesStorageKey, JSON.stringify(Array.from(next)));
      } catch {}
      return next;
    });

    fetch(apiUrl('/api/favorites/series'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profileId: currentProfile?.id,
        seriesName: cleanName,
        isFavorite: isFavNow
      })
    }).catch(() => {});
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('comix_favorites_updated'));
    }
  };

  const formatTimeAgo = (isoString?: string) => {
    if (!isoString) return 'In progress';
    const diffMs = Date.now() - new Date(isoString).getTime();
    const mins = Math.floor(diffMs / (1000 * 60));
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(isoString).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  const activeComics = comics;

  // In-progress comics ordered by lastRead timestamp descending (excluding 100% read comics)
  const continueReadingList = useMemo(() => {
    return activeComics
      .filter((comic) => {
        const prog = readingProgress[String(comic.id)];
        if (!prog || prog.currentPage <= 0) return false;
        const totalPages = prog.totalPages || comic.totalPages;
        if (totalPages && totalPages > 0) {
          const isCompleted = prog.currentPage >= totalPages || Math.round((prog.currentPage / totalPages) * 100) >= 100;
          if (isCompleted) return false;
        }
        return true;
      })
      .sort((a, b) => {
        const timeA = new Date(readingProgress[String(a.id)]?.lastRead || 0).getTime();
        const timeB = new Date(readingProgress[String(b.id)]?.lastRead || 0).getTime();
        return timeB - timeA;
      });
  }, [activeComics, readingProgress]);

  // --- Base Filtering (View Scope) ---
  let scopeComics = activeComics;
  let pageTitle = 'Your Library';
  let pageSubtitle = `${activeComics.length} issues in library ready for reading`;

  if (showFavoritesOnly) {
    scopeComics = activeComics.filter((c) => favorites.has(String(c.id)) || seriesFavorites.has(extractSeries(c)));
    pageTitle = `Favorites (${currentProfile?.name || 'All'})`;
    pageSubtitle = `${scopeComics.length} favorite comics across ${seriesFavorites.size} favorited series and individual issues`;
  } else if (showContinueReadingOnly) {
    scopeComics = continueReadingList;
    pageTitle = `Continue Reading (${currentProfile?.name || 'All'})`;
    pageSubtitle = `${scopeComics.length} issues currently in progress`;
  }

  // --- Status & Instant Search Filtering ---
  const filteredComics = useMemo(() => {
    return scopeComics.filter((comic) => {
      const idStr = String(comic.id);

      // Status filter
      if (statusFilter === 'favorites') {
        const isFav = favorites.has(idStr) || seriesFavorites.has(extractSeries(comic));
        if (!isFav) return false;
      }
      if (statusFilter === 'in-progress') {
        const prog = readingProgress[idStr];
        const totalPages = prog?.totalPages || comic.totalPages;
        const isProg = prog && prog.currentPage > 0 && (!totalPages || (prog.currentPage < totalPages && Math.round((prog.currentPage / totalPages) * 100) < 100));
        if (!isProg) return false;
      }
      if (statusFilter === 'unread') {
        const prog = readingProgress[idStr];
        if (prog && prog.currentPage > 0) return false;
      }
      if (statusFilter === 'completed') {
        const prog = readingProgress[idStr];
        const totalPages = prog?.totalPages || comic.totalPages;
        const isDone = Boolean(prog && totalPages && (prog.currentPage >= totalPages || Math.round((prog.currentPage / totalPages) * 100) >= 100));
        if (!isDone) return false;
      }
      if (statusFilter === 'offline') {
        const isOffline = offlineComicIds.has(idStr);
        if (!isOffline) return false;
      }

      // Search query filter
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const seriesName = extractSeries(comic).toLowerCase();
        const titleMatch = (comic.title || '').toLowerCase().includes(q);
        const seriesMatch = seriesName.includes(q);
        if (!titleMatch && !seriesMatch) return false;
      }

      return true;
    });
  }, [scopeComics, statusFilter, favorites, seriesFavorites, readingProgress, searchQuery, offlineComicIds]);

  // --- Sorting Comparator for Comics ---
  const sortComicsList = useCallback(
    (list: Comic[], activeSort: 'latest' | 'alpha' | 'issue' | 'lastRead', reversed: boolean): Comic[] => {
      return [...list].sort((a, b) => {
        if (activeSort === 'latest') {
          // Compare modifiedTime, numeric/string ID descending
          const timeA = a.modifiedTime ? new Date(a.modifiedTime).getTime() : 0;
          const timeB = b.modifiedTime ? new Date(b.modifiedTime).getTime() : 0;
          if (timeA && timeB) {
            const diff = timeB - timeA;
            return reversed ? -diff : diff;
          }
          const cmp = String(b.id).localeCompare(String(a.id), undefined, { numeric: true });
          return reversed ? -cmp : cmp;
        }
        if (activeSort === 'alpha') {
          const cmp = (a.title || '').localeCompare(b.title || '', undefined, {
            numeric: true,
            sensitivity: 'base'
          });
          return reversed ? -cmp : cmp;
        }
        if (activeSort === 'issue') {
          const numA = getComicIssueNumeric(a);
          const numB = getComicIssueNumeric(b);
          if (numA !== null && numB !== null) {
            const diff = numA - numB;
            if (diff !== 0) return reversed ? -diff : diff;
          } else if (numA !== null) {
            return reversed ? 1 : -1;
          } else if (numB !== null) {
            return reversed ? -1 : 1;
          }
          const cmp = (a.title || '').localeCompare(b.title || '', undefined, {
            numeric: true,
            sensitivity: 'base'
          });
          return reversed ? -cmp : cmp;
        }
        if (activeSort === 'lastRead') {
          const timeA = new Date(readingProgress[String(a.id)]?.lastRead || 0).getTime();
          const timeB = new Date(readingProgress[String(b.id)]?.lastRead || 0).getTime();
          const diff = timeB - timeA;
          return reversed ? -diff : diff;
        }
        return 0;
      });
    },
    [readingProgress]
  );

  // Sorted Flat Comics List
  const displayedFlatComics = useMemo(() => {
    return sortComicsList(filteredComics, sortBy, isReversed);
  }, [filteredComics, sortBy, isReversed, sortComicsList]);

  // --- Series Groups Calculation ---
  const seriesGroups: SeriesGroup[] = useMemo(() => {
    const map = new Map<string, Comic[]>();
    for (const comic of filteredComics) {
      const s = extractSeries(comic);
      if (!map.has(s)) {
        map.set(s, []);
      }
      map.get(s)!.push(comic);
    }

    const groups: SeriesGroup[] = [];
    for (const [seriesName, groupComics] of map.entries()) {
      let readCount = 0;
      let latestReadTime = 0;
      let latestId: any = 0;

      for (const c of groupComics) {
        if (c.id > latestId) latestId = c.id;
        const prog = readingProgress[String(c.id)];
        if (prog && prog.totalPages && prog.currentPage >= prog.totalPages) {
          readCount++;
        }
        if (prog?.lastRead) {
          const t = new Date(prog.lastRead).getTime();
          if (t > latestReadTime) latestReadTime = t;
        }
      }

      // Sort comics inside this series: default to Issue order (#1 -> #N), or follow active sort inside folder
      const sortedGroupComics = sortComicsList(
        groupComics,
        activeSeriesFolder ? sortBy : 'issue',
        activeSeriesFolder ? isReversed : false
      );

      groups.push({
        seriesName,
        comics: sortedGroupComics,
        issueCount: groupComics.length,
        readCount,
        latestId,
        latestRead: latestReadTime > 0 ? new Date(latestReadTime).toISOString() : undefined,
        sampleCoverComic: sortedGroupComics[0],
        isFavorite: seriesFavorites.has(seriesName)
      });
    }

    // Sort series groups themselves
    return groups.sort((a, b) => {
      if (sortBy === 'alpha') {
        const cmp = a.seriesName.localeCompare(b.seriesName, undefined, { numeric: true, sensitivity: 'base' });
        return isReversed ? -cmp : cmp;
      }
      if (sortBy === 'latest') {
        const cmp = String(b.latestId).localeCompare(String(a.latestId), undefined, { numeric: true });
        return isReversed ? -cmp : cmp;
      }
      if (sortBy === 'issue') {
        const diff = b.issueCount - a.issueCount;
        return isReversed ? -diff : diff;
      }
      if (sortBy === 'lastRead') {
        const timeA = new Date(a.latestRead || 0).getTime();
        const timeB = new Date(b.latestRead || 0).getTime();
        const diff = timeB - timeA;
        return isReversed ? -diff : diff;
      }
      return 0;
    });
  }, [filteredComics, readingProgress, sortComicsList, activeSeriesFolder, sortBy, isReversed, seriesFavorites]);

  // Current active series folder group if drilled down
  const currentSeriesGroup = useMemo(() => {
    if (!activeSeriesFolder) return null;
    return seriesGroups.find((g) => g.seriesName.toLowerCase() === activeSeriesFolder.toLowerCase()) || null;
  }, [seriesGroups, activeSeriesFolder]);

  // Shelf collapse toggle
  const toggleShelfCollapse = (seriesName: string) => {
    setCollapsedShelves((prev) => {
      const next = new Set(prev);
      if (next.has(seriesName)) next.delete(seriesName);
      else next.add(seriesName);
      return next;
    });
  };

  const expandAllShelves = () => setCollapsedShelves(new Set());
  const collapseAllShelves = () => setCollapsedShelves(new Set(seriesGroups.map((g) => g.seriesName)));

  // Open comic and pass its saved progress so the Reader starts directly at the user's last read page
  const handleOpenComicWithProgress = useCallback(
    (comic: Comic) => {
      const prog = readingProgress[String(comic.id)];
      let resumePage = prog && prog.currentPage > 0 ? prog.currentPage : 1;
      let zoomX = prog?.zoomNormX;
      let zoomY = prog?.zoomNormY;

      if (!prog && typeof window !== 'undefined') {
        try {
          const profileKey = `comix_prog_${currentProfile?.id || 1}_${comic.id}`;
          const local = localStorage.getItem(profileKey);
          if (local) {
            if (local.trim().startsWith('{')) {
              const parsed = JSON.parse(local);
              const p = parseInt(parsed.page || parsed.currentPage, 10);
              if (p > 0) resumePage = p;
              if (typeof parsed.zoomNormX === 'number') zoomX = parsed.zoomNormX;
              if (typeof parsed.zoomNormY === 'number') zoomY = parsed.zoomNormY;
            } else {
              const p = parseInt(local, 10);
              if (p > 0) resumePage = p;
            }
          }
        } catch {}
      }

      onOpenComic({
        ...comic,
        initialPage: resumePage,
        currentPage: resumePage,
        initialZoomNormX: zoomX,
        initialZoomNormY: zoomY
      });
    },
    [readingProgress, onOpenComic, currentProfile?.id]
  );

  // Helper to determine fast cover source
  const getCoverUrl = (comic: Comic) => {
    const idStr = String(comic.id);
    if (offlineCovers[idStr]) return offlineCovers[idStr];
    const syncCover = getCachedOfflineCoverUrl(comic.id);
    if (syncCover) return syncCover;

    // Use fast Google thumbnail CDN if available, else local disk cache cover endpoint
    if (comic.coverImage && !cbzCoverFailed.has(idStr)) {
      return comic.coverImage;
    }
    if (comic.id && !cbzCoverFailed.has(idStr)) {
      return apiUrl(`/api/comics/${comic.id}/cover`);
    }
    return comic.coverImage || null;
  };

  // --- Deletion & Selection Helpers ---
  const toggleSelectComic = useCallback((id: string | number) => {
    const idStr = String(id);
    setSelectedComicIds((prev) => {
      const next = new Set(prev);
      if (next.has(idStr)) next.delete(idStr);
      else next.add(idStr);
      return next;
    });
  }, []);

  const handleSelectAllVisible = useCallback(() => {
    setSelectedComicIds((prev) => {
      const visibleIds = filteredComics.map((c) => String(c.id));
      if (prev.size === visibleIds.length && visibleIds.length > 0) {
        return new Set();
      }
      return new Set(visibleIds);
    });
  }, [filteredComics]);

  const confirmDeleteComics = async (idsToDelete: (string | number)[], successLabel: string) => {
    if (idsToDelete.length === 0) return;
    try {
      setIsDeleting(true);
      const strIds = idsToDelete.map(String);

      let res: Response;
      if (strIds.length === 1) {
        res = await fetch(apiUrl(`/api/comics/${strIds[0]}`), { method: 'DELETE' });
      } else {
        res = await fetch(apiUrl('/api/comics/delete'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ comicIds: strIds })
        });
      }

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to delete comic from storage');
      }

      // 1. Clean from client offline storage IndexedDB if present
      strIds.forEach((id) => deleteOfflineComic(id));

      // 2. Remove from active library state
      const idSet = new Set(strIds);
      setComics((prev) => prev.filter((c) => !idSet.has(String(c.id))));
      if (memoryComicsCache) {
        memoryComicsCache = memoryComicsCache.filter((c) => !idSet.has(String(c.id)));
      }

      // 3. Clear selections & close modals
      setSelectedComicIds((prev) => {
        const next = new Set(prev);
        strIds.forEach((id) => next.delete(id));
        return next;
      });
      setComicPendingDelete(null);
      setSeriesPendingDelete(null);
      setBulkPendingDelete(false);
      if (activeSeriesFolder && seriesPendingDelete) {
        setActiveSeriesFolder(null);
      }

      // 4. Feedback toast
      setDeleteToast(successLabel);
      setTimeout(() => setDeleteToast(null), 3500);
    } catch (err: any) {
      alert(`Error deleting: ${err.message}`);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleOpenEditModal = (comic: Comic) => {
    setComicPendingEdit(comic);
    setEditTitle(comic.title || '');
    setEditSeries(comic.series || extractSeries(comic) || '');
    setEditItem(comic.item || extractIssueNumber(comic) || '');
    setEditIsVolume(Boolean(comic.isVolume));
    setEditError(null);
  };

  const handleSaveEdit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!comicPendingEdit) return;
    if (!editTitle.trim()) {
      setEditError('Title cannot be empty');
      return;
    }

    setIsSavingEdit(true);
    setEditError(null);

    try {
      const res = await fetch(apiUrl(`/api/comics/${comicPendingEdit.id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: editTitle.trim(),
          series: editSeries.trim() || undefined,
          item: editItem.trim() || undefined,
          isVolume: editIsVolume
        })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Failed to update metadata (${res.status})`);
      }

      const data = await res.json();
      const updatedComic: Comic = data.comic || {
        ...comicPendingEdit,
        title: editTitle.trim(),
        series: editSeries.trim(),
        item: editItem.trim(),
        isVolume: editIsVolume
      };

      setComics((prev) => prev.map((c) => (c.id === comicPendingEdit.id ? { ...c, ...updatedComic } : c)));
      if (memoryComicsCache) {
        memoryComicsCache = memoryComicsCache.map((c) => (c.id === comicPendingEdit.id ? { ...c, ...updatedComic } : c));
      }

      try {
        await saveLibraryOffline(
          (memoryComicsCache || []).map((c) => (c.id === comicPendingEdit.id ? { ...c, ...updatedComic } : c))
        );
      } catch {}

      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('comix_library_updated'));
      }

      setDeleteToast(`✏️ Updated metadata for "${updatedComic.title}"`);
      setTimeout(() => setDeleteToast(null), 4000);

      setComicPendingEdit(null);
    } catch (err: any) {
      setEditError(err.message || 'Failed to update metadata');
    } finally {
      setIsSavingEdit(false);
    }
  };

  // --- Render Comic Card Helper ---
  const renderComicCard = (comic: Comic) => {
    const idStr = String(comic.id);
    const isFav = favorites.has(idStr);
    const isSeriesFav = seriesFavorites.has(extractSeries(comic));
    const issueNum = extractIssueNumber(comic);
    const prog = readingProgress[idStr];
    const hasProgress = prog && prog.currentPage > 0;
    const totalPages = prog?.totalPages;
    const percent = totalPages && totalPages > 0 ? Math.min(100, Math.round((prog.currentPage / totalPages) * 100)) : null;

    const totalFailed = allCoversFailed.has(idStr);
    const coverSrc = totalFailed ? null : getCoverUrl(comic);

    return (
      <div
        key={comic.id}
        className={`comic-card ${isSelectMode && selectedComicIds.has(idStr) ? 'card-selected' : ''}`}
        onClick={() => {
          if (isSelectMode) {
            toggleSelectComic(comic.id);
          } else {
            handleOpenComicWithProgress(comic);
          }
        }}
      >
        {/* Selection Checkbox in Select Mode */}
        {isSelectMode && (
          <div
            className={`card-select-checkbox ${selectedComicIds.has(idStr) ? 'selected' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              toggleSelectComic(comic.id);
            }}
            title={selectedComicIds.has(idStr) ? 'Deselect comic' : 'Select comic'}
          >
            {selectedComicIds.has(idStr) ? '✓' : ''}
          </div>
        )}
        {/* Offline Download / Ready Button in upper left corner */}
        <button
          type="button"
          className="card-download-btn"
          onClick={(e) => {
            e.stopPropagation();
            if (offlineComicIds.has(idStr)) {
              handleOpenComicWithProgress(comic);
            } else {
              autoDownloadComicForOffline(comic, comic.totalPages || totalPages);
            }
          }}
          title={offlineComicIds.has(idStr) ? 'Downloaded & ready for offline reading' : 'Download comic for offline reading'}
          aria-label={offlineComicIds.has(idStr) ? 'Downloaded & ready for offline reading' : 'Download comic for offline reading'}
          style={offlineComicIds.has(idStr) ? {
            background: 'rgba(16, 185, 129, 0.25)',
            borderColor: '#10b981',
            color: '#34d399'
          } : undefined}
        >
          {offlineComicIds.has(idStr) ? (
            <Zap size={16} />
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          )}
        </button>

        {/* Heart Toggle Button in upper right corner */}
        <button
          type="button"
          className={`favorite-btn ${isFav ? 'favorited' : ''}`}
          onClick={(e) => toggleFavorite(comic.id, e)}
          title={isFav ? 'Remove from favorites' : 'Add to favorites'}
          aria-label={isFav ? 'Remove from favorites' : 'Add to favorites'}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill={isFav ? '#ef4444' : 'none'}
            stroke={isFav ? '#ef4444' : 'currentColor'}
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
          </svg>
        </button>

        {/* Cover Image or Stylized Placeholder */}
        <div style={{ position: 'relative', width: '100%', aspectRatio: '2/3', overflow: 'hidden' }}>
          {coverSrc ? (
            <img
              src={coverSrc}
              alt={comic.title}
              className="comic-cover"
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              loading="lazy"
              onError={() => {
                getOfflineCoverUrl(comic.id).then((blobUrl) => {
                  if (blobUrl) {
                    setOfflineCovers((prev) => ({ ...prev, [idStr]: blobUrl }));
                  } else if (!cbzCoverFailed.has(idStr) && comic.coverImage) {
                    setCbzCoverFailed((prev) => new Set(prev).add(idStr));
                  } else {
                    setAllCoversFailed((prev) => new Set(prev).add(idStr));
                  }
                });
              }}
            />
          ) : (
            <div
              className="comic-cover"
              style={{
                background: `linear-gradient(145deg, #1e293b, #0f172a)`,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '1.25rem',
                textAlign: 'center',
                width: '100%',
                height: '100%'
              }}
            >
                <div style={{ marginBottom: '0.5rem', opacity: 0.85, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <BookOpen size={40} />
                </div>
              <div style={{ fontSize: '0.85rem', fontWeight: 700, color: '#f8fafc', lineHeight: 1.3 }}>
                {comic.title}
              </div>
            </div>
          )}

          {/* Progress Bar overlay on card if comic was in progress */}
          {hasProgress && (
            <div
              style={{
                position: 'absolute',
                bottom: 0,
                left: 0,
                right: 0,
                height: '4px',
                backgroundColor: 'rgba(0, 0, 0, 0.5)'
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: `${percent ?? 35}%`,
                  background: 'linear-gradient(90deg, #06b6d4, #3b82f6)',
                  boxShadow: '0 0 6px #06b6d4'
                }}
              />
            </div>
          )}

          {/* Offline Ready Badge */}
          {offlineComicIds.has(idStr) && (
            <div
              style={{
                position: 'absolute',
                top: '10px',
                right: '46px',
                background: 'rgba(16, 185, 129, 0.9)',
                backdropFilter: 'blur(6px)',
                color: '#ffffff',
                padding: '2px 7px',
                borderRadius: '8px',
                fontSize: '0.68rem',
                fontWeight: 700,
                letterSpacing: '0.02em',
                boxShadow: '0 2px 8px rgba(16, 185, 129, 0.4)',
                zIndex: 6,
                display: 'flex',
                alignItems: 'center',
                gap: '3px'
              }}
              title="Downloaded & ready for offline reading"
            >
              <Zap size={14} />
              <span>Offline</span>
            </div>
          )}

          {/* Issue Number Badge in bottom-left corner */}
          {issueNum && (
            <div
              style={{
                position: 'absolute',
                bottom: '10px',
                left: '10px',
                background: 'rgba(15, 23, 42, 0.85)',
                backdropFilter: 'blur(6px)',
                color: '#f8fafc',
                padding: '2px 8px',
                borderRadius: '8px',
                fontSize: '0.7rem',
                fontWeight: 700,
                letterSpacing: '0.02em',
                border: '1px solid rgba(255, 255, 255, 0.18)',
                boxShadow: '0 2px 6px rgba(0, 0, 0, 0.4)',
                zIndex: 5
              }}
            >
              #{issueNum}
            </div>
          )}

          {/* Resume Badge on cover if comic is in progress */}
          {hasProgress && (
            <div
              className="resume-badge"
              style={{
                position: 'absolute',
                bottom: '10px',
                right: '10px',
                display: 'flex',
                alignItems: 'center',
                gap: '0.35rem',
                background: 'linear-gradient(135deg, #2563eb, #1d4ed8)',
                color: '#fff',
                padding: '3px 9px',
                borderRadius: '16px',
                fontSize: '0.72rem',
                fontWeight: 700,
                boxShadow: '0 2px 8px rgba(0, 0, 0, 0.4)',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                zIndex: 5
              }}
            >
              <span>▶</span> Resume
            </div>
          )}

          {/* Series Favorited Indicator Badge if entire series is favorited */}
          {isSeriesFav && (
            <div
              style={{
                position: 'absolute',
                top: '10px',
                left: '46px',
                background: 'rgba(239, 68, 68, 0.25)',
                backdropFilter: 'blur(6px)',
                color: '#fca5a5',
                padding: '2px 7px',
                borderRadius: '8px',
                fontSize: '0.68rem',
                fontWeight: 700,
                border: '1px solid rgba(239, 68, 68, 0.45)',
                boxShadow: '0 2px 6px rgba(0, 0, 0, 0.4)',
                zIndex: 5,
                display: 'flex',
                alignItems: 'center',
                gap: '0.25rem'
              }}
              title={`Series "${extractSeries(comic)}" is favorited`}
            >
               <Heart size={14} />
               <span>Series</span>
            </div>
          )}
        </div>

        <div className="comic-info">
          <div className="comic-title" title={comic.title}>
            {comic.title}
          </div>
          <div className="comic-meta" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>
              {hasProgress
                ? `Pg ${prog.currentPage}${totalPages ? `/${totalPages}` : ''}`
                : `${comic.type || 'CBZ'} format`}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span
                style={{
                  color: hasProgress ? '#60a5fa' : 'var(--accent-color)',
                  fontWeight: 700,
                  fontSize: '0.76rem',
                  background: hasProgress ? 'rgba(37, 99, 235, 0.18)' : 'transparent',
                  padding: hasProgress ? '2px 7px' : '0',
                  borderRadius: '5px',
                  border: hasProgress ? '1px solid rgba(37, 99, 235, 0.35)' : 'none',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '3px'
                }}
              >
                {hasProgress ? '▶ Resume' : 'Read →'}
              </span>
              <button
                type="button"
                className="comic-card-edit-icon"
                onClick={(e) => {
                  e.stopPropagation();
                  handleOpenEditModal(comic);
                }}
                title={`Edit metadata / rename "${comic.title}"`}
                aria-label={`Edit metadata / rename "${comic.title}"`}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                </svg>
              </button>
              <button
                type="button"
                className="comic-card-delete-icon"
                onClick={(e) => {
                  e.stopPropagation();
                  setComicPendingDelete(comic);
                }}
                title={`Delete "${comic.title}" from library`}
                aria-label={`Delete "${comic.title}" from library`}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 6h18" />
                  <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                  <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  // --- Render Series Folder Card Helper ---
  const renderSeriesFolderCard = (group: SeriesGroup) => {
    const sample = group.sampleCoverComic;
    const coverSrc = sample ? getCoverUrl(sample) : null;
    const completionPercent = group.issueCount > 0 ? Math.round((group.readCount / group.issueCount) * 100) : 0;
    const isSeriesFav = seriesFavorites.has(group.seriesName);

    return (
      <div
        key={group.seriesName}
        className={`series-folder-card ${isSeriesFav ? 'series-favorited' : ''}`}
        onClick={() => handleOpenSeriesFolder(group.seriesName)}
        title={`Open folder: ${group.seriesName} (${group.issueCount} issues)`}
      >
        {/* Top Folder Tab */}
        <div className="series-folder-tab" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <span className="folder-icon"><Folder size={16} /></span>
            <span>SERIES FOLDER</span>
          </div>
          {isSeriesFav && (
            <span style={{ fontSize: '0.68rem', color: '#f87171', fontWeight: 700, letterSpacing: '0.04em', display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
               <Heart size={14} /> FAVE
            </span>
          )}
        </div>

        {/* Stacked Cover Preview */}
        <div className="series-cover-stack">
          {/* Series Favorite Toggle Heart Button */}
          <button
            type="button"
            className={`favorite-btn series-favorite-btn ${isSeriesFav ? 'favorited' : ''}`}
            onClick={(e) => toggleSeriesFavorite(group.seriesName, e)}
            title={isSeriesFav ? `Remove ${group.seriesName} from favorites` : `Add ${group.seriesName} to favorites`}
            aria-label={`Favorite ${group.seriesName}`}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill={isSeriesFav ? '#ef4444' : 'none'}
              stroke={isSeriesFav ? '#ef4444' : 'currentColor'}
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
            </svg>
          </button>
          {coverSrc ? (
            <img
              src={coverSrc}
              alt={group.seriesName}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              loading="lazy"
            />
          ) : (
            <div
              style={{
                width: '100%',
                height: '100%',
                background: `linear-gradient(135deg, #1e293b, #0f172a)`,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '1.25rem',
                textAlign: 'center'
              }}
            >
               <span style={{ marginBottom: '0.5rem', opacity: 0.8, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                 <Folder size={48} />
               </span>
              <span style={{ fontSize: '0.85rem', fontWeight: 700, color: '#f8fafc' }}>{group.seriesName}</span>
            </div>
          )}

          {/* Issue Count Tag overlaid on bottom of cover */}
          <div
            style={{
              position: 'absolute',
              bottom: '10px',
              left: '10px',
              background: 'rgba(15, 23, 42, 0.9)',
              backdropFilter: 'blur(8px)',
              color: '#f8fafc',
              padding: '3px 9px',
              borderRadius: '8px',
              fontSize: '0.72rem',
              fontWeight: 700,
              border: '1px solid rgba(255, 255, 255, 0.2)',
              boxShadow: '0 2px 8px rgba(0, 0, 0, 0.5)',
              zIndex: 3
            }}
          >
             <BookOpen size={14} style={{ marginRight: '0.2rem', display: 'inline-block', verticalAlign: 'middle' }} /> {group.issueCount} {group.issueCount === 1 ? 'issue' : 'issues'}
          </div>
        </div>

        {/* Folder Metadata */}
        <div className="series-folder-meta">
          <div className="series-folder-title" title={group.seriesName}>
            {group.seriesName}
          </div>
          <div className="series-folder-subtitle">
            <span style={{ color: group.readCount > 0 ? '#38bdf8' : 'var(--text-secondary)' }}>
              {group.readCount > 0 ? `${group.readCount}/${group.issueCount} completed` : 'Unread series'}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ color: 'var(--accent-color)', fontWeight: 600 }}>Open →</span>
              <button
                type="button"
                className="comic-card-delete-icon"
                onClick={(e) => {
                  e.stopPropagation();
                  setSeriesPendingDelete(group);
                }}
                title={`Delete all issues in "${group.seriesName}"`}
                aria-label={`Delete all issues in "${group.seriesName}"`}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 6h18" />
                  <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                  <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                </svg>
              </button>
            </div>
          </div>

          {/* Series Progress Bar */}
          {group.readCount > 0 && (
            <div style={{ width: '100%', height: '3px', background: 'rgba(255, 255, 255, 0.1)', borderRadius: '2px', overflow: 'hidden', marginTop: '0.2rem' }}>
              <div style={{ height: '100%', width: `${completionPercent}%`, background: 'linear-gradient(90deg, #06b6d4, #3b82f6)' }} />
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div>
      {/* Header Bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1 style={{ fontSize: '1.8rem', fontWeight: 700 }}>{pageTitle}</h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginTop: '0.25rem' }}>
            {pageSubtitle}
          </p>
        </div>

        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          {scanMessage && (
            <span
              style={{
                fontSize: '0.85rem',
                color: scanMessage.includes('error') ? '#ef4444' : '#10b981',
                fontWeight: 500,
                padding: '0.3rem 0.6rem',
                borderRadius: '6px',
                background: scanMessage.includes('error') ? 'rgba(239, 68, 68, 0.1)' : 'rgba(16, 185, 129, 0.1)'
              }}
            >
              {scanMessage}
            </span>
          )}
          <button
            onClick={() => {
              fetchComics();
              fetchReadingProgress();
            }}
            disabled={loading || scanning}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
              padding: '0.5rem 0.9rem',
              borderRadius: '8px',
              border: '1px solid var(--border-color)',
              background: 'rgba(255, 255, 255, 0.05)',
              color: 'var(--text-primary)',
              cursor: loading || scanning ? 'not-allowed' : 'pointer',
              fontSize: '0.85rem',
              fontWeight: 600,
              transition: 'all 0.2s'
            }}
            title="Refresh comics list"
          >
             {loading ? <><Loader2 size={16} className="animate-spin" /> Refreshing...</> : <><RefreshCw size={16} /> Refresh</>}
          </button>
          <button
            className="library-header-btn-scan"
            onClick={handleScanLibrary}
            disabled={loading || scanning}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
              padding: '0.5rem 1rem',
              borderRadius: '8px',
              border: 'none',
              background: 'linear-gradient(135deg, #2563eb, #1d4ed8)',
              color: '#fff',
              cursor: loading || scanning ? 'not-allowed' : 'pointer',
              fontSize: '0.85rem',
              fontWeight: 600,
              boxShadow: '0 2px 8px rgba(37, 99, 235, 0.3)',
              transition: 'all 0.2s'
            }}
            title="Scan Google Drive folder for comics"
          >
             {scanning ? <><Loader2 size={16} className="animate-spin" /> Scanning...</> : <><Zap size={16} /> Scan Folder</>}
          </button>
          <button
            className="library-header-btn-sort"
            onClick={handleSortLooseComics}
            disabled={loading || scanning || sorting}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
              padding: '0.5rem 0.9rem',
              borderRadius: '8px',
              border: '1px solid var(--border-color)',
              background: 'rgba(255, 255, 255, 0.05)',
              color: 'var(--text-primary)',
              cursor: loading || scanning || sorting ? 'not-allowed' : 'pointer',
              fontSize: '0.85rem',
              fontWeight: 600,
              transition: 'all 0.2s'
            }}
            title="Sort loose comics into their series folders"
          >
             {sorting ? <><Loader2 size={16} className="animate-spin" /> Sorting...</> : <><Folder size={16} /> Sort Folders</>}
          </button>
        </div>
      </div>

      {/* 1. Continue Reading Shelf on Main Library Page (hidden if inside a specific series folder) */}
      {!showFavoritesOnly && !showContinueReadingOnly && !activeSeriesFolder && continueReadingList.length > 0 && (
        <section style={{ marginBottom: '2.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
              <BookOpen size={20} />
              <h2 style={{ fontSize: '1.3rem', fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>
                Continue Reading
              </h2>
              <span
                style={{
                  background: 'rgba(59, 130, 246, 0.15)',
                  color: '#60a5fa',
                  border: '1px solid rgba(59, 130, 246, 0.3)',
                  padding: '0.15rem 0.6rem',
                  borderRadius: '12px',
                  fontSize: '0.75rem',
                  fontWeight: 700
                }}
              >
                {continueReadingList.length} in progress
              </span>
            </div>
            {continueReadingList.length > 4 && onNavigateView && (
              <button
                onClick={() => onNavigateView('continue-reading')}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--accent-color)',
                  fontSize: '0.85rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.25rem'
                }}
              >
                View all ({continueReadingList.length}) &rarr;
              </button>
            )}
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
              gap: '1.25rem'
            }}
          >
            {continueReadingList.slice(0, 4).map((comic) => {
              const idStr = String(comic.id);
              const prog = readingProgress[idStr];
              const currentPage = prog?.currentPage || 1;
              const totalPages = prog?.totalPages;
              const percent = totalPages && totalPages > 0 ? Math.min(100, Math.round((currentPage / totalPages) * 100)) : null;
              const totalFailed = allCoversFailed.has(idStr);
              const coverSrc = totalFailed ? null : getCoverUrl(comic);

              return (
                <div
                  key={`shelf_${comic.id}`}
                  className="continue-card"
                  onClick={() => handleOpenComicWithProgress(comic)}
                  style={{
                    backgroundColor: 'var(--panel-bg)',
                    borderRadius: '12px',
                    overflow: 'hidden',
                    border: '1px solid var(--border-color)',
                    cursor: 'pointer',
                    display: 'flex',
                    flexDirection: 'column',
                    boxShadow: '0 4px 14px rgba(0, 0, 0, 0.25)'
                  }}
                >
                  <div style={{ position: 'relative', width: '100%', aspectRatio: '16/9', overflow: 'hidden', background: '#0b1120' }}>
                    {coverSrc ? (
                      <img
                        src={coverSrc}
                        alt={comic.title}
                        style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'top' }}
                        loading="lazy"
                        onError={() => {
                          getOfflineCoverUrl(comic.id).then((blobUrl) => {
                            if (blobUrl) {
                              setOfflineCovers((prev) => ({ ...prev, [idStr]: blobUrl }));
                            } else if (!cbzCoverFailed.has(idStr) && comic.coverImage) {
                              setCbzCoverFailed((prev) => new Set(prev).add(idStr));
                            } else {
                              setAllCoversFailed((prev) => new Set(prev).add(idStr));
                            }
                          });
                        }}
                      />
                    ) : (
                      <div
                        style={{
                          width: '100%',
                          height: '100%',
                          background: `linear-gradient(135deg, #1e293b, #0f172a)`,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: '2rem'
                        }}
                      >
                         <BookOpen size={32} />
                      </div>
                    )}

                    <div
                      style={{
                        position: 'absolute',
                        inset: 0,
                        background: 'linear-gradient(to top, rgba(15, 23, 42, 0.85) 0%, transparent 60%)'
                      }}
                    />

                    <div
                      style={{
                        position: 'absolute',
                        top: '8px',
                        right: '8px',
                        background: 'rgba(15, 23, 42, 0.8)',
                        backdropFilter: 'blur(6px)',
                        color: '#cbd5e1',
                        padding: '2px 8px',
                        borderRadius: '10px',
                        fontSize: '0.68rem',
                        fontWeight: 600,
                        border: '1px solid rgba(255, 255, 255, 0.1)'
                      }}
                    >
                       <Clock size={12} style={{ marginRight: '0.25rem', display: 'inline-block', verticalAlign: 'middle' }} /> {formatTimeAgo(prog?.lastRead)}
                    </div>

                    <div
                      className="resume-badge"
                      style={{
                        position: 'absolute',
                        bottom: '12px',
                        left: '12px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.45rem',
                        background: 'linear-gradient(135deg, #3b82f6, #1d4ed8)',
                        color: '#fff',
                        padding: '6px 14px',
                        borderRadius: '24px',
                        fontSize: '0.85rem',
                        fontWeight: 700,
                        letterSpacing: '0.01em',
                        boxShadow: '0 4px 14px rgba(0, 0, 0, 0.5), 0 0 12px rgba(59, 130, 246, 0.4)',
                        border: '1px solid rgba(255, 255, 255, 0.25)',
                        zIndex: 4,
                        transition: 'transform 0.15s ease, box-shadow 0.15s ease'
                      }}
                    >
                      <span style={{ fontSize: '0.95rem' }}>▶</span>
                      <span>Resume</span>
                    </div>

                    <div
                      style={{
                        position: 'absolute',
                        bottom: 0,
                        left: 0,
                        right: 0,
                        height: '4px',
                        backgroundColor: 'rgba(255, 255, 255, 0.2)'
                      }}
                    >
                      <div
                        style={{
                          height: '100%',
                          width: `${percent ?? (currentPage > 1 ? 50 : 20)}%`,
                          background: 'linear-gradient(90deg, #06b6d4, #3b82f6)',
                          boxShadow: '0 0 6px #06b6d4'
                        }}
                      />
                    </div>
                  </div>

                  <div style={{ padding: '0.85rem 1rem' }}>
                    <div
                      title={comic.title}
                      style={{
                        fontSize: '0.88rem',
                        fontWeight: 700,
                        color: 'var(--text-primary)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        marginBottom: '0.35rem'
                      }}
                    >
                      {comic.title}
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: '0.75rem', color: '#38bdf8', fontWeight: 600 }}>
                        {totalPages ? `Page ${currentPage} of ${totalPages}` : `Page ${currentPage}`}
                        {percent !== null && ` (${percent}%)`}
                      </span>
                      <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', textTransform: 'uppercase', fontWeight: 600 }}>
                        {comic.type || 'CBZ'}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* 2. Comprehensive Viewing Options Toolbar */}
      <div className="library-toolbar">
        {/* Top Controls Row: View Mode, Sorting, Reverse, and Layout */}
        <div className="library-toolbar-row">
          {/* View Mode Segmented Control */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
            <div className="library-segmented-control" style={{ flexGrow: 1 }}>
              <button
                type="button"
                className={`library-segmented-btn ${viewMode === 'series' && !activeSeriesFolder ? 'active' : ''}`}
                onClick={() => {
                  setViewMode('series');
                  setActiveSeriesFolder(null);
                }}
                title="Group issues into series folders"
              >
                 <Folder size={16} /> By Series
              </button>
              <button
                type="button"
                className={`library-segmented-btn ${viewMode === 'flat' ? 'active' : ''}`}
                onClick={() => {
                  setViewMode('flat');
                  setActiveSeriesFolder(null);
                }}
                title="View all comic issues in a single flat grid"
              >
                 <FileText size={16} /> All Issues
              </button>
            </div>

            {/* Layout Toggle when in Series Mode (and not drilled into a specific folder) */}
            {viewMode === 'series' && !activeSeriesFolder && (
              <div className="library-segmented-control" style={{ flexGrow: 1 }}>
                <button
                  type="button"
                  className={`library-segmented-btn ${seriesLayout === 'folders' ? 'active' : ''}`}
                  onClick={() => setSeriesLayout('folders')}
                  title="Display series as folder cards"
                >
                   <FolderTree size={16} /> Folders
                </button>
                <button
                  type="button"
                  className={`library-segmented-btn ${seriesLayout === 'shelves' ? 'active' : ''}`}
                  onClick={() => setSeriesLayout('shelves')}
                  title="Display series as expandable shelf sections"
                >
                   <BookOpen size={16} /> Shelves
                </button>
              </div>
            )}
          </div>

          {/* Sorting and Direction Controls */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
            <div className="library-select-wrapper">
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Sort:</span>
              <select
                className="library-select"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as any)}
                aria-label="Sort library by"
              >
                <option value="latest">Latest Added</option>
                <option value="alpha">Alphabetical (A - Z)</option>
                <option value="issue">Issue Order</option>
                <option value="lastRead">Recently Read</option>
              </select>
            </div>

            {/* Reverse Order Toggle Button */}
            <button
              type="button"
              className={`library-reverse-btn ${isReversed ? 'reversed' : ''}`}
              onClick={() => setIsReversed(!isReversed)}
              title={isReversed ? 'Order is reversed (Click to restore normal order)' : 'Click to reverse sort order'}
              aria-label="Reverse sort order"
            >
               <span>{isReversed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}</span>
              <span>{isReversed ? 'Reversed' : 'Reverse'}</span>
            </button>

            {/* Select / Manage Mode Toggle Button */}
            <button
              type="button"
              className={`library-reverse-btn ${isSelectMode ? 'reversed' : ''}`}
              onClick={() => {
                setIsSelectMode(!isSelectMode);
                setSelectedComicIds(new Set());
              }}
              title={isSelectMode ? 'Exit select mode' : 'Select comics to delete or manage in bulk'}
              aria-label="Toggle select mode"
              style={isSelectMode ? {
                background: 'rgba(239, 68, 68, 0.2)',
                borderColor: '#ef4444',
                color: '#fca5a5'
              } : undefined}
            >
               <span>{isSelectMode ? '✕' : <SquareCheck size={16} />}</span>
              <span>{isSelectMode ? 'Cancel Selection' : 'Select'}</span>
            </button>
          </div>
        </div>

        {/* Bottom Controls Row: Instant Filter Search & Status Chips */}
        <div className="library-toolbar-row" style={{ paddingTop: '0.4rem', borderTop: '1px solid rgba(255, 255, 255, 0.06)' }}>
          <div className="library-search-container">
             <span className="library-search-icon"><Search size={16} /></span>
            <input
              type="text"
              className="library-search-input"
              placeholder="Filter comics or series..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Filter comics or series"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                style={{
                  position: 'absolute',
                  right: '8px',
                  top: '50%',
                  transform: 'translateY(-50%)',
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-secondary)',
                  cursor: 'pointer',
                  fontSize: '0.85rem'
                }}
                title="Clear search"
              >
                ✕
              </button>
            )}
          </div>

          <div className="library-chip-group">
            {(['all', 'in-progress', 'unread', 'completed', 'favorites', 'offline'] as const).map((chip) => (
              <button
                key={chip}
                type="button"
                className={`library-chip ${statusFilter === chip ? 'active' : ''}`}
                onClick={() => setStatusFilter(chip)}
              >
                {chip === 'all' && 'All'}
                {chip === 'in-progress' && '⏳ In Progress'}
                {chip === 'unread' && '🆕 Unread'}
                {chip === 'completed' && '✅ Completed'}
                {chip === 'favorites' && '❤️ Favorites'}
                {chip === 'offline' && `⚡ Offline (${offlineComicIds.size})`}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 3. Series Folder Drill-Down Breadcrumb Header */}
      {activeSeriesFolder && currentSeriesGroup && (
        <div
          className="series-breadcrumb-bar"
          onTouchStart={handleFolderTouchStart}
          onTouchEnd={handleFolderTouchEnd}
        >
          <div className="series-breadcrumb-nav">
            <button
              type="button"
              className="series-back-btn"
              onClick={handleBackFromSeriesFolder}
              title="Return to all series folders"
            >
              <span>←</span> All Series Folders
            </button>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{ fontSize: '1.2rem' }}>📁</span>
              <span className="series-breadcrumb-title">{currentSeriesGroup.seriesName}</span>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
            {/* Series Favorite Toggle Pill Button */}
            <button
              type="button"
              className={`series-breadcrumb-fav-btn ${seriesFavorites.has(currentSeriesGroup.seriesName) ? 'favorited' : ''}`}
              onClick={(e) => toggleSeriesFavorite(currentSeriesGroup.seriesName, e)}
              title={seriesFavorites.has(currentSeriesGroup.seriesName) ? 'Remove series from favorites' : 'Add series to favorites'}
              aria-label="Toggle series favorite"
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill={seriesFavorites.has(currentSeriesGroup.seriesName) ? '#ef4444' : 'none'}
                stroke={seriesFavorites.has(currentSeriesGroup.seriesName) ? '#ef4444' : 'currentColor'}
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
              </svg>
              <span>{seriesFavorites.has(currentSeriesGroup.seriesName) ? 'Series Favorited' : 'Favorite Series'}</span>
            </button>
            {onNavigateToOmnibus && (
              <button
                type="button"
                className="series-breadcrumb-fav-btn"
                onClick={() => onNavigateToOmnibus(currentSeriesGroup.seriesName)}
                title="Create omnibus from this series"
                style={{
                  background: 'rgba(59, 130, 246, 0.15)',
                  borderColor: 'rgba(59, 130, 246, 0.4)',
                  color: '#93c5fd'
                }}
              >
                <span>📚</span>
                <span>Create Omnibus</span>
              </button>
            )}
            <button
              type="button"
              className="series-breadcrumb-fav-btn"
              onClick={() => setSeriesPendingDelete(currentSeriesGroup)}
              title="Delete this entire series"
              style={{
                background: 'rgba(239, 68, 68, 0.15)',
                borderColor: 'rgba(239, 68, 68, 0.4)',
                color: '#fca5a5'
              }}
            >
              <span>🗑️</span>
              <span>Delete Series</span>
            </button>
            <span className="series-swipe-hint">👈 Swipe left to go back</span>
            <span className="series-count-badge">
              {currentSeriesGroup.issueCount} {currentSeriesGroup.issueCount === 1 ? 'issue' : 'issues'}
            </span>
            {currentSeriesGroup.readCount > 0 && (
              <span
                style={{
                  background: 'rgba(16, 185, 129, 0.15)',
                  color: '#34d399',
                  border: '1px solid rgba(16, 185, 129, 0.3)',
                  padding: '0.12rem 0.6rem',
                  borderRadius: '10px',
                  fontSize: '0.72rem',
                  fontWeight: 700
                }}
              >
                {currentSeriesGroup.readCount}/{currentSeriesGroup.issueCount} completed
              </span>
            )}
          </div>
        </div>
      )}

      {/* 4. Empty State */}
      {filteredComics.length === 0 ? (
        <div
          style={{
            textAlign: 'center',
            padding: '4rem 2rem',
            background: 'var(--panel-bg)',
            borderRadius: '12px',
            border: '1px solid var(--border-color)',
            marginTop: '1.5rem'
          }}
        >
          <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>
            {searchQuery ? '🔍' : showFavoritesOnly ? '🤍' : showContinueReadingOnly ? '📖' : '📚'}
          </div>
          <h2 style={{ fontSize: '1.3rem', fontWeight: 600, marginBottom: '0.5rem' }}>
            {searchQuery
              ? `No comics found matching "${searchQuery}"`
              : statusFilter !== 'all'
              ? `No comics with status "${statusFilter}"`
              : showFavoritesOnly
              ? 'No favorite comics yet'
              : showContinueReadingOnly
              ? 'No comics in progress'
              : !currentProfile?.driveFolderId
              ? 'Connect your Google Drive folder'
              : 'Your library is empty'}
          </h2>
          <p
            style={{
              color: 'var(--text-secondary)',
              maxWidth: '440px',
              margin: '0 auto',
              fontSize: '0.95rem',
              marginBottom: '1.5rem',
              lineHeight: '1.5'
            }}
          >
            {searchQuery || statusFilter !== 'all'
              ? 'Try adjusting your search query or filter chips above to see more comics.'
              : showFavoritesOnly
              ? 'Click the heart icon in the top-right corner of any comic card in your library to add it to your favorites.'
              : showContinueReadingOnly
              ? 'Start reading any issue from your library to track your progress and resume reading right where you left off.'
              : !currentProfile?.driveFolderId
              ? 'Select a Google Drive folder where your comic collection is stored or where downloaded issues should be saved.'
              : "Add comics to your library by scanning your folder or downloading issues from What's New."}
          </p>
          {(searchQuery || statusFilter !== 'all') && (
            <button
              onClick={() => {
                setSearchQuery('');
                setStatusFilter('all');
              }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.5rem',
                padding: '0.65rem 1.25rem',
                borderRadius: '8px',
                border: 'none',
                background: 'linear-gradient(135deg, #2563eb, #1d4ed8)',
                color: '#fff',
                cursor: 'pointer',
                fontSize: '0.9rem',
                fontWeight: 600
              }}
            >
              Reset Filters
            </button>
          )}
          {!searchQuery && statusFilter === 'all' && !currentProfile?.driveFolderId && onOpenDrivePicker && (
            <button
              onClick={onOpenDrivePicker}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.5rem',
                padding: '0.65rem 1.25rem',
                borderRadius: '8px',
                border: 'none',
                background: 'linear-gradient(135deg, #2563eb, #1d4ed8)',
                color: '#fff',
                cursor: 'pointer',
                fontSize: '0.9rem',
                fontWeight: 600,
                boxShadow: '0 4px 12px rgba(37, 99, 235, 0.35)'
              }}
            >
              📁 Select Google Drive Folder
            </button>
          )}
          {!searchQuery && statusFilter === 'all' && !showFavoritesOnly && !showContinueReadingOnly && currentProfile?.driveFolderId && (
            <button
              onClick={handleScanLibrary}
              disabled={scanning}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.5rem',
                padding: '0.65rem 1.25rem',
                borderRadius: '8px',
                border: 'none',
                background: 'linear-gradient(135deg, #2563eb, #1d4ed8)',
                color: '#fff',
                cursor: scanning ? 'not-allowed' : 'pointer',
                fontSize: '0.9rem',
                fontWeight: 600,
                boxShadow: '0 4px 12px rgba(37, 99, 235, 0.35)'
              }}
            >
              {scanning ? '⏳ Scanning folder...' : '⚡ Scan Library Folder Now'}
            </button>
          )}
        </div>
      ) : activeSeriesFolder && currentSeriesGroup ? (
        /* 5A. Issues Inside Active Series Folder */
        <div
          onTouchStart={handleFolderTouchStart}
          onTouchEnd={handleFolderTouchEnd}
          style={{ minHeight: '60vh' }}
        >
          <div className="library-grid">
            {currentSeriesGroup.comics.map((comic) => renderComicCard(comic))}
          </div>
        </div>
      ) : viewMode === 'series' && seriesLayout === 'folders' ? (
        /* 5B. Series Folders Grid */
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{ fontSize: '1.1rem' }}>🗂️</span>
              <h2 style={{ fontSize: '1.2rem', fontWeight: 700, color: 'var(--text-secondary)', letterSpacing: '-0.01em' }}>
                Series Folders ({seriesGroups.length})
              </h2>
            </div>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
              Click any folder to view its issues
            </span>
          </div>

          <div className="library-grid">
            {seriesGroups.map((group) => renderSeriesFolderCard(group))}
          </div>
        </div>
      ) : viewMode === 'series' && seriesLayout === 'shelves' ? (
        /* 5C. Expandable Series Shelves View */
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{ fontSize: '1.1rem' }}>📚</span>
              <h2 style={{ fontSize: '1.2rem', fontWeight: 700, color: 'var(--text-secondary)', letterSpacing: '-0.01em' }}>
                Series Shelves ({seriesGroups.length})
              </h2>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                type="button"
                onClick={expandAllShelves}
                style={{
                  background: 'rgba(255, 255, 255, 0.05)',
                  border: '1px solid var(--border-color)',
                  color: 'var(--text-primary)',
                  padding: '0.35rem 0.75rem',
                  borderRadius: '6px',
                  fontSize: '0.78rem',
                  fontWeight: 600,
                  cursor: 'pointer'
                }}
              >
                ▼ Expand All
              </button>
              <button
                type="button"
                onClick={collapseAllShelves}
                style={{
                  background: 'rgba(255, 255, 255, 0.05)',
                  border: '1px solid var(--border-color)',
                  color: 'var(--text-primary)',
                  padding: '0.35rem 0.75rem',
                  borderRadius: '6px',
                  fontSize: '0.78rem',
                  fontWeight: 600,
                  cursor: 'pointer'
                }}
              >
                ▲ Collapse All
              </button>
            </div>
          </div>

          {seriesGroups.map((group) => {
            const isCollapsed = collapsedShelves.has(group.seriesName);
            return (
              <div key={group.seriesName} className="series-shelf-section">
                <div className="series-shelf-header" onClick={() => toggleShelfCollapse(group.seriesName)}>
                  <div className="series-shelf-title-group">
                    {/* Series Shelf Favorite Toggle Button */}
                    <button
                      type="button"
                      className={`favorite-btn series-shelf-fav-btn ${seriesFavorites.has(group.seriesName) ? 'favorited' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleSeriesFavorite(group.seriesName, e);
                      }}
                      title={seriesFavorites.has(group.seriesName) ? `Remove ${group.seriesName} from favorites` : `Add ${group.seriesName} to favorites`}
                      aria-label={`Favorite ${group.seriesName}`}
                      style={{
                        position: 'static',
                        width: '28px',
                        height: '28px',
                        minWidth: '28px',
                        flexShrink: 0
                      }}
                    >
                      <svg
                        width="15"
                        height="15"
                        viewBox="0 0 24 24"
                        fill={seriesFavorites.has(group.seriesName) ? '#ef4444' : 'none'}
                        stroke={seriesFavorites.has(group.seriesName) ? '#ef4444' : 'currentColor'}
                        strokeWidth="2.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
                      </svg>
                    </button>
                    <span style={{ fontSize: '1.2rem' }}>📁</span>
                    <span className="series-shelf-title">{group.seriesName}</span>
                    <span className="series-count-badge">
                      {group.issueCount} {group.issueCount === 1 ? 'issue' : 'issues'}
                    </span>
                    {group.readCount > 0 && (
                      <span
                        style={{
                          background: 'rgba(16, 185, 129, 0.15)',
                          color: '#34d399',
                          border: '1px solid rgba(16, 185, 129, 0.3)',
                          padding: '0.1rem 0.5rem',
                          borderRadius: '10px',
                          fontSize: '0.7rem',
                          fontWeight: 700
                        }}
                      >
                        {group.readCount}/{group.issueCount} read
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setActiveSeriesFolder(group.seriesName);
                      }}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--accent-color)',
                        fontSize: '0.8rem',
                        fontWeight: 600,
                        cursor: 'pointer'
                      }}
                    >
                      Focus Folder →
                    </button>
                    <span style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                      {isCollapsed ? '▶' : '▼'}
                    </span>
                  </div>
                </div>

                {!isCollapsed && (
                  <div className="library-grid" style={{ marginTop: '0.75rem' }}>
                    {group.comics.map((comic) => renderComicCard(comic))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        /* 5D. Flat Grid View of All Issues */
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
            <span style={{ fontSize: '1.1rem' }}>📚</span>
            <h2 style={{ fontSize: '1.2rem', fontWeight: 700, color: 'var(--text-secondary)', letterSpacing: '-0.01em' }}>
              All Comics ({displayedFlatComics.length})
            </h2>
          </div>

          <div className="library-grid">
            {displayedFlatComics.map((comic) => renderComicCard(comic))}
          </div>
        </div>
      )}

      {/* Floating Bulk Action Bar in Select Mode */}
      {isSelectMode && (
        <div className="floating-bulk-bar">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <span style={{ fontWeight: 700, color: '#f8fafc', fontSize: '0.9rem' }}>
              {selectedComicIds.size} {selectedComicIds.size === 1 ? 'comic' : 'comics'} selected
            </span>
            <button
              type="button"
              className="bulk-action-text-btn"
              onClick={handleSelectAllVisible}
            >
              {selectedComicIds.size === filteredComics.length && filteredComics.length > 0 ? 'Deselect All' : 'Select All'}
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
            <button
              type="button"
              className="bulk-cancel-btn"
              onClick={() => {
                setIsSelectMode(false);
                setSelectedComicIds(new Set());
              }}
            >
              Done
            </button>
            <button
              type="button"
              className="bulk-delete-btn"
              disabled={selectedComicIds.size === 0 || isDeleting}
              onClick={() => setBulkPendingDelete(true)}
            >
              <span>🗑️</span>
              <span>Delete ({selectedComicIds.size})</span>
            </button>
          </div>
        </div>
      )}

      {/* Single Comic Delete Confirmation Modal */}
      {comicPendingDelete && (
        <div className="delete-confirm-backdrop" onClick={() => !isDeleting && setComicPendingDelete(null)}>
          <div className="delete-confirm-modal" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
              <span style={{ fontSize: '2rem' }}>🗑️</span>
              <div>
                <h3 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 800, color: '#f8fafc' }}>
                  Delete Comic?
                </h3>
                <span style={{ fontSize: '0.8rem', color: '#94a3b8' }}>Permanent storage deletion</span>
              </div>
            </div>

            <p style={{ color: '#e2e8f0', fontSize: '0.92rem', lineHeight: 1.5, margin: '0 0 1rem' }}>
              Are you sure you want to delete <strong style={{ color: '#fca5a5' }}>"{comicPendingDelete.title}"</strong>?
            </p>

            <div style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.25)', borderRadius: '8px', padding: '0.75rem', marginBottom: '1.25rem', fontSize: '0.8rem', color: '#fca5a5' }}>
              ⚠️ This will permanently delete the file from Google Drive (or storage), clear offline downloads, and remove it from your library.
            </div>

            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="bulk-cancel-btn"
                disabled={isDeleting}
                onClick={() => setComicPendingDelete(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="bulk-delete-btn"
                disabled={isDeleting}
                onClick={() => confirmDeleteComics([comicPendingDelete.id], `Deleted "${comicPendingDelete.title}"`)}
              >
                {isDeleting ? 'Deleting...' : '🗑️ Delete Comic'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Comic Metadata Modal */}
      {comicPendingEdit && (
        <div className="edit-metadata-backdrop" onClick={() => !isSavingEdit && setComicPendingEdit(null)}>
          <div className="edit-metadata-modal" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <span style={{ fontSize: '1.5rem' }}>✏️</span>
                <div>
                  <h3 style={{ margin: 0, fontSize: '1.2rem', fontWeight: 800, color: '#f8fafc' }}>
                    Edit Comic Metadata
                  </h3>
                  <span style={{ fontSize: '0.78rem', color: '#94a3b8' }}>
                    Rename and organize this comic in your library &amp; Google Drive
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => !isSavingEdit && setComicPendingEdit(null)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#64748b',
                  fontSize: '1.2rem',
                  cursor: 'pointer',
                  padding: '4px'
                }}
              >
                ✕
              </button>
            </div>

            {editError && (
              <div style={{ background: 'rgba(239, 68, 68, 0.15)', border: '1px solid rgba(239, 68, 68, 0.3)', color: '#fca5a5', padding: '0.65rem 0.9rem', borderRadius: '8px', fontSize: '0.82rem', marginBottom: '1rem' }}>
                ⚠️ {editError}
              </div>
            )}

            <form onSubmit={handleSaveEdit}>
              {/* Comic Title */}
              <div className="edit-form-group">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.35rem' }}>
                  <label className="edit-form-label" style={{ margin: 0 }}>Comic Title</label>
                  {editSeries && editItem && (
                    <button
                      type="button"
                      onClick={() => setEditTitle(`${editSeries.trim()} - ${editItem.trim()}`)}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--accent-color, #3b82f6)',
                        fontSize: '0.75rem',
                        cursor: 'pointer',
                        padding: 0,
                        fontWeight: 600,
                        textDecoration: 'underline'
                      }}
                    >
                      ⚡ Auto-format Title
                    </button>
                  )}
                </div>
                <input
                  type="text"
                  className="edit-form-input"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  placeholder="e.g. Absolute Batman - Issue 01"
                  required
                  autoFocus
                />
              </div>

              {/* Series Name */}
              <div className="edit-form-group">
                <label className="edit-form-label">Series Name</label>
                <input
                  type="text"
                  className="edit-form-input"
                  value={editSeries}
                  onChange={(e) => setEditSeries(e.target.value)}
                  placeholder="e.g. Absolute Batman"
                  list="library-series-datalist"
                />
                <datalist id="library-series-datalist">
                  {Array.from(new Set(comics.map((c) => c.series || extractSeries(c)).filter(Boolean))).map((s) => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
                <span style={{ fontSize: '0.72rem', color: '#64748b', marginTop: '0.25rem', display: 'block' }}>
                  Changing the series will automatically move the comic into that series folder.
                </span>
              </div>

              {/* Issue Number / Volume */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                <div className="edit-form-group">
                  <label className="edit-form-label">Issue / Item</label>
                  <input
                    type="text"
                    className="edit-form-input"
                    value={editItem}
                    onChange={(e) => setEditItem(e.target.value)}
                    placeholder="e.g. Issue 01 or Vol. 1"
                  />
                </div>

                <div className="edit-form-group">
                  <label className="edit-form-label">Format Type</label>
                  <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.1rem' }}>
                    <button
                      type="button"
                      onClick={() => setEditIsVolume(false)}
                      style={{
                        flex: 1,
                        background: !editIsVolume ? 'var(--accent-color, #3b82f6)' : '#0f172a',
                        border: `1px solid ${!editIsVolume ? 'var(--accent-color, #3b82f6)' : 'rgba(255, 255, 255, 0.12)'}`,
                        color: !editIsVolume ? '#fff' : '#94a3b8',
                        padding: '0.55rem 0.5rem',
                        borderRadius: '8px',
                        fontSize: '0.8rem',
                        fontWeight: 600,
                        cursor: 'pointer',
                        transition: 'all 0.15s ease'
                      }}
                    >
                      Single Issue
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditIsVolume(true)}
                      style={{
                        flex: 1,
                        background: editIsVolume ? 'var(--accent-color, #3b82f6)' : '#0f172a',
                        border: `1px solid ${editIsVolume ? 'var(--accent-color, #3b82f6)' : 'rgba(255, 255, 255, 0.12)'}`,
                        color: editIsVolume ? '#fff' : '#94a3b8',
                        padding: '0.55rem 0.5rem',
                        borderRadius: '8px',
                        fontSize: '0.8rem',
                        fontWeight: 600,
                        cursor: 'pointer',
                        transition: 'all 0.15s ease'
                      }}
                    >
                      Volume / TPB
                    </button>
                  </div>
                </div>
              </div>

              {/* Action Buttons */}
              <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end', marginTop: '1.25rem' }}>
                <button
                  type="button"
                  className="bulk-cancel-btn"
                  disabled={isSavingEdit}
                  onClick={() => setComicPendingEdit(null)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="edit-save-btn"
                  disabled={isSavingEdit}
                >
                  {isSavingEdit ? '⏳ Saving...' : '💾 Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Series Delete Confirmation Modal */}
      {seriesPendingDelete && (
        <div className="delete-confirm-backdrop" onClick={() => !isDeleting && setSeriesPendingDelete(null)}>
          <div className="delete-confirm-modal" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
              <span style={{ fontSize: '2rem' }}>🗑️</span>
              <div>
                <h3 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 800, color: '#f8fafc' }}>
                  Delete Entire Series?
                </h3>
                <span style={{ fontSize: '0.8rem', color: '#94a3b8' }}>
                  {seriesPendingDelete.issueCount} {seriesPendingDelete.issueCount === 1 ? 'issue' : 'issues'} will be deleted
                </span>
              </div>
            </div>

            <p style={{ color: '#e2e8f0', fontSize: '0.92rem', lineHeight: 1.5, margin: '0 0 1rem' }}>
              Are you sure you want to delete all <strong style={{ color: '#fca5a5' }}>{seriesPendingDelete.issueCount} issues</strong> of series <strong style={{ color: '#fca5a5' }}>"{seriesPendingDelete.seriesName}"</strong>?
            </p>

            <div style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.25)', borderRadius: '8px', padding: '0.75rem', marginBottom: '1.25rem', fontSize: '0.8rem', color: '#fca5a5' }}>
              ⚠️ All {seriesPendingDelete.issueCount} archive files will be permanently deleted from Google Drive / storage and removed from your library.
            </div>

            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="bulk-cancel-btn"
                disabled={isDeleting}
                onClick={() => setSeriesPendingDelete(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="bulk-delete-btn"
                disabled={isDeleting}
                onClick={() => confirmDeleteComics(
                  seriesPendingDelete.comics.map((c) => c.id),
                  `Deleted series "${seriesPendingDelete.seriesName}" (${seriesPendingDelete.issueCount} issues)`
                )}
              >
                {isDeleting ? 'Deleting...' : `🗑️ Delete All ${seriesPendingDelete.issueCount} Issues`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk Delete Confirmation Modal */}
      {bulkPendingDelete && (
        <div className="delete-confirm-backdrop" onClick={() => !isDeleting && setBulkPendingDelete(false)}>
          <div className="delete-confirm-modal" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
              <span style={{ fontSize: '2rem' }}>🗑️</span>
              <div>
                <h3 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 800, color: '#f8fafc' }}>
                  Delete {selectedComicIds.size} Comics?
                </h3>
                <span style={{ fontSize: '0.8rem', color: '#94a3b8' }}>Bulk permanent storage deletion</span>
              </div>
            </div>

            <p style={{ color: '#e2e8f0', fontSize: '0.92rem', lineHeight: 1.5, margin: '0 0 1rem' }}>
              Are you sure you want to permanently delete the <strong style={{ color: '#fca5a5' }}>{selectedComicIds.size} selected comics</strong>?
            </p>

            <div style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.25)', borderRadius: '8px', padding: '0.75rem', marginBottom: '1.25rem', fontSize: '0.8rem', color: '#fca5a5' }}>
              ⚠️ The files will be permanently deleted from Google Drive / storage and removed from your library.
            </div>

            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="bulk-cancel-btn"
                disabled={isDeleting}
                onClick={() => setBulkPendingDelete(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="bulk-delete-btn"
                disabled={isDeleting}
                onClick={() => confirmDeleteComics(
                  Array.from(selectedComicIds),
                  `Deleted ${selectedComicIds.size} comics from storage`
                )}
              >
                {isDeleting ? 'Deleting...' : `🗑️ Delete ${selectedComicIds.size} Comics`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast Notification */}
      {deleteToast && (
        <div
          style={{
            position: 'fixed',
            bottom: '24px',
            right: '24px',
            background: 'rgba(16, 185, 129, 0.95)',
            color: '#ffffff',
            padding: '0.75rem 1.25rem',
            borderRadius: '10px',
            fontWeight: 700,
            fontSize: '0.9rem',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.5)',
            zIndex: 1100,
            backdropFilter: 'blur(8px)',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            animation: 'slideUpBulkBar 0.2s ease-out'
          }}
        >
          <span>✓</span>
          <span>{deleteToast}</span>
        </div>
      )}
    </div>
  );
}
