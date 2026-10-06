import { useState, useEffect, useMemo, useCallback, useDeferredValue, useRef } from 'react';
import {
  Search,
  RefreshCw,
  FolderOpen,
  FolderPlus,
  ChevronLeft,
  Play,
  Music,
  BookOpen,
  Mic2,
  Heart,
  ListPlus,
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  Shuffle,
  HardDrive,
  HardDriveDownload,
  Check,
  Tag,
  X,
  ListMusic
} from 'lucide-react';
import { api } from './api';
import MediaCard from './MediaCard';
import AddToPlaylistModal from './AddToPlaylistModal';
import { useSwipeBack } from './swipeBack';
import { formatDuration, formatLengthShort, percentOf, pluralize } from './format';
import {
  getOfflineIds,
  downloadTrack,
  downloadAlbum,
  downloadBook,
  downloadPlaylist,
  removeOfflineTrack,
  removeOfflineAlbum,
  removeOfflineBook,
  removeOfflinePlaylist
} from './offlineStorage';

/** "Artist::Album" - the album-favourite key shared with the server. */
const albumKey = (artist, album) => `${artist || 'Unknown Artist'}::${album}`;

const DESC_DEFAULTS = new Set(['duration', 'added', 'played', 'count', 'albums']);

const ITEM_FIELDS = {
  title: (i) => i.title || '',
  artist: (i) => i.albumArtist || i.artist || i.author || '',
  album: (i) => i.album || i.series || '',
  duration: (i) => i.durationSec || 0,
  added: (i) => i.addedAt || '',
  played: (i) => i.lastPlayed || ''
};

const GROUP_FIELDS = {
  name: (g) => g.name || g.album || g.title || '',
  artist: (g) => g.artist || '',
  count: (g) => g.count ?? g.tracks?.length ?? g.bookCount ?? g.trackCount ?? 0,
  albums: (g) => g.albumCount ?? 0,
  duration: (g) => g.durationSec || g.totalSec || (g.books || []).reduce((s, b) => s + (b.durationSec || 0), 0),
  added: (g) => g.updatedAt || g.createdAt || g.lastAdded || ''
};

const ITEM_OPTIONS = [
  ['title', 'Title'], ['artist', 'Artist'], ['album', 'Album'],
  ['duration', 'Length'], ['added', 'Recently added'], ['played', 'Last played']
];

const SORT_OPTIONS = {
  'items': ITEM_OPTIONS,
  'music.items': ITEM_OPTIONS,
  'audiobooks.items': [
    ['title', 'Title'], ['artist', 'Author'], ['album', 'Series'],
    ['duration', 'Length'], ['added', 'Recently added'], ['played', 'Last played']
  ],
  'music.album': [['artist', 'Artist'], ['name', 'Album'], ['count', 'Tracks'], ['duration', 'Length'], ['added', 'Recently added']],
  'music.artist': [['name', 'Artist'], ['albums', 'Albums'], ['count', 'Tracks'], ['duration', 'Length'], ['added', 'Recently added']],
  'music.playlist': [['name', 'Name'], ['count', 'Tracks'], ['added', 'Recently added']],
  'music.genre': [['name', 'Name'], ['count', 'Tracks'], ['duration', 'Length']],
  'audiobooks.author': [['name', 'Author'], ['count', 'Books'], ['duration', 'Length'], ['added', 'Recently added']],
  'audiobooks.series': [['name', 'Series'], ['count', 'Books'], ['duration', 'Length'], ['added', 'Recently added']],
  'audiobooks.playlist': [['name', 'Name'], ['count', 'Items'], ['added', 'Recently added']],
  'audiobooks.genre': [['name', 'Name'], ['count', 'Books'], ['duration', 'Length']]
};

const DEFAULT_SORTS = {
  'music.album': 'artist',
  'music.artist': 'name',
  'music.playlist': 'name',
  'music.genre': 'name',
  'audiobooks.author': 'name',
  'audiobooks.series': 'name',
  'audiobooks.playlist': 'name',
  'audiobooks.genre': 'name',
  items: 'title'
};

function compareBy(getter, dir, tiebreak) {
  return (a, b) => {
    const x = getter(a);
    const y = getter(b);
    let out = 0;
    if (typeof x === 'number' || typeof y === 'number') out = (x || 0) - (y || 0);
    else out = String(x || '').localeCompare(String(y || ''), undefined, { numeric: true });
    if (out === 0 && tiebreak) return tiebreak(a, b);
    return dir * out;
  };
}

const byName = (a, b) => String(a.name || a.album || a.title || '').localeCompare(String(b.name || b.album || b.title || ''), undefined, { numeric: true });
const byTitle = (a, b) => String(a.title || '').localeCompare(String(b.title || ''), undefined, { numeric: true });
const byTrack = (a, b) => (a.trackNumber || 0) - (b.trackNumber || 0) || byTitle(a, b);
const artistOf = (i) => String(i.albumArtist || i.artist || i.author || '');
const byArtistName = (a, b) => String(a.artist || '').localeCompare(String(b.artist || ''), undefined, { numeric: true }) || byName(a, b);
const byAlbumThenTrack = (a, b) => String(a.album || '').localeCompare(String(b.album || ''), undefined, { numeric: true }) || byTrack(a, b);
const byArtistThenAlbum = (a, b) => artistOf(a).localeCompare(artistOf(b), undefined, { numeric: true }) || byAlbumThenTrack(a, b);

// Tie-breakers make secondary ordering predictable: sorting tracks by artist
// walks into album then track number; albums by artist keep album order.
const ITEM_TIEBREAKS = {
  title: byArtistThenAlbum,
  artist: byAlbumThenTrack,
  album: byArtistThenAlbum,
  duration: byTitle,
  added: byTitle,
  played: byTitle
};

const GROUP_TIEBREAKS = {
  name: byArtistName,
  artist: byName,
  count: byName,
  albums: byName,
  duration: byName,
  added: byName
};

function getBookStartingPart(book) {
  if (!book?.parts || !book.parts.length) return book;
  const inProgress = book.parts.find((p) => p.progressSec > 0 && !p.completed);
  if (inProgress) return inProgress;
  const uncompleted = book.parts.find((p) => !p.completed);
  if (uncompleted) return uncompleted;
  return book.parts[0];
}

const GENRE_PATTERNS = [
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

function inferGenre(item, isMusic) {
  if (item?.genre) return item.genre;
  if (!isMusic) return '';
  const text = [item?.album, item?.artist, item?.albumArtist, item?.drivePath, item?.title].filter(Boolean).join(' ');
  for (const [pattern, genreName] of GENRE_PATTERNS) {
    if (pattern.test(text)) return genreName;
  }
  return '';
}

/**
 * The main browse view for both libraries.
 *
 * For audiobooks the server groups by author and series; for music by album and
 * artist. We fetch the grouped payload once per library version and let the user
 * drill into any group.
 */
export default function Library({
  kind,
  user,
  libraryVersion,
  scanState,
  onScan,
  onOpenDrivePicker,
  onPlay,
  onToggleFavorite,
  onRefresh,
  favoritesOnly = false,
  notify
}) {
  const isMusic = kind === 'music';

  const [data, setData] = useState(null);
  const [favAlbums, setFavAlbums] = useState(() => new Set());
  const [favNames, setFavNames] = useState(() => new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [displayLimit, setDisplayLimit] = useState(80);
  const loadMoreRef = useRef(null);
  const groupLoadMoreRef = useRef(null);

  const [grouping, setGrouping] = useState('all');
  const [drill, setDrill] = useState(null);
  const [playlistTarget, setPlaylistTarget] = useState(null);
  const [busyIds, setBusyIds] = useState(() => new Set());
  const [playlists, setPlaylists] = useState([]);
  const [selectedGenre, setSelectedGenre] = useState('');

  useEffect(() => {
    setDisplayLimit(80);
  }, [kind, grouping, drill, favoritesOnly, selectedGenre, deferredQuery]);

  useEffect(() => {
    const el = loadMoreRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setDisplayLimit((prev) => prev + 60);
        }
      },
      { rootMargin: '400px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [displayLimit]);

  useEffect(() => {
    const el = groupLoadMoreRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setDisplayLimit((prev) => prev + 60);
        }
      },
      { rootMargin: '400px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [displayLimit]);

  // Right-edge swipe unwinds drill-downs (album, artist, book chapters...)
  // the same way the Back button does.
  useSwipeBack(Boolean(drill), () => setDrill((d) => (d ? d.parent || null : null)));

  // ---- sorting -------------------------------------------------------
  // Preferences are remembered per view ("Albums by artist" and "Tracks by last
  // played" don't fight each other), keyed by kind + the current grouping.
  const viewKey = drill || favoritesOnly || grouping === 'all' ? 'items' : grouping;
  const [sort, setSortState] = useState({ field: 'title', dir: 1 });
  useEffect(() => {
    let restored = null;
    try {
      const saved = JSON.parse(localStorage.getItem(`fraudio.library.sort.${kind}.${viewKey}`) || 'null');
      if (saved?.field) restored = { field: saved.field, dir: saved.dir === -1 ? -1 : 1 };
    } catch { /* corrupt storage entry */ }
    setSortState(restored || { field: DEFAULT_SORTS[`${kind}.${viewKey}`] || DEFAULT_SORTS.items, dir: 1 });
  }, [kind, viewKey]);

  const setSort = useCallback((view, next) => {
    setSortState(next);
    try { localStorage.setItem(`fraudio.library.sort.${kind}.${view}`, JSON.stringify(next)); } catch { /* storage can be full */ }
  }, [kind]);

  const isGroupView = viewKey !== 'items';
  const sortFields = isGroupView ? GROUP_FIELDS : ITEM_FIELDS;
  const sortOptions = SORT_OPTIONS[`${kind}.${viewKey}`] || SORT_OPTIONS['items'];
  // A saved field from another view may not exist here; fall back to the first.
  const sortField = sortOptions.some(([f]) => f === sort.field) ? sort.field : sortOptions[0][0];

  const setSortField = useCallback((field) => {
    if (field === sortField) setSort(viewKey, { field, dir: -sort.dir });
    else setSort(viewKey, { field, dir: DESC_DEFAULTS.has(field) ? -1 : 1 });
  }, [setSort, viewKey, sort, sortField]);

  const flipSortDir = useCallback(() => setSort(viewKey, { ...sort, dir: -sort.dir }), [setSort, viewKey, sort]);

  const sortGetter = sortFields[sortField] || Object.values(sortFields)[0];

  const folderId = isMusic ? user?.musicFolderId : user?.audiobooksFolderId;
  const folderName = isMusic ? user?.musicFolderName : user?.audiobooksFolderName;

  // Reset view state when the library switches sides.
  useEffect(() => {
    setDrill(null);
    setQuery('');
    setGrouping('all');
    setSelectedGenre('');
  }, [kind]);

  const loadPlaylists = useCallback(async () => {
    try {
      const pl = await api.playlists(kind);
      setPlaylists(Array.isArray(pl) ? pl : []);
    } catch {
      /* ignore */
    }
  }, [kind]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const [result, favorites, pl] = await Promise.all([
          api.libraryGroups(kind),
          api.favorites(kind),
          api.playlists(kind).catch(() => [])
        ]);
        if (cancelled) return;
        setData(result);
        setFavAlbums(new Set(favorites?.albums || []));
        setFavNames(new Set(favorites?.authorNames || []));
        setPlaylists(Array.isArray(pl) ? pl : []);
      } catch (err) {
        if (!cancelled) setError(err.message || 'Could not load your library.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [kind, libraryVersion]);

  const toggleAlbumFavorite = useCallback(async (artist, album, nextValue) => {
    try {
      const res = await api.setAlbumFavorite(artist, album, nextValue);
      setFavAlbums(new Set(res.albums || []));
    } catch (err) {
      notify('Could not update favourite', err.message, true);
    }
  }, [notify]);

  const toggleNameFavorite = useCallback(async (name, nextValue) => {
    try {
      const res = await api.setAuthorFavorite(name, nextValue, kind);
      setFavNames(new Set(res.authorNames || []));
    } catch (err) {
      notify('Could not update favourite', err.message, true);
    }
  }, [kind, notify]);

  const [offlineIds, setOfflineIds] = useState(new Set());
  const [offlineProgress, setOfflineProgress] = useState(null);

  const refreshOfflineIds = useCallback(async () => {
    const ids = await getOfflineIds();
    setOfflineIds(ids);
  }, []);

  useEffect(() => {
    refreshOfflineIds();
    window.addEventListener('fraudio:offline-changed', refreshOfflineIds);
    return () => window.removeEventListener('fraudio:offline-changed', refreshOfflineIds);
  }, [refreshOfflineIds]);

  const items = useMemo(() => data?.items || [], [data]);
  const books = useMemo(() => (isMusic ? [] : (data?.books || items)), [isMusic, data, items]);

  const genres = useMemo(() => {
    if (data?.genres && Array.isArray(data.genres) && data.genres.length > 0) {
      return data.genres;
    }
    const list = isMusic ? items : books;
    const map = new Map();
    for (const item of list) {
      const genreRaw = item.genre || inferGenre(item, isMusic) || (isMusic ? 'Uncategorized' : '');
      if (!genreRaw) continue;
      const parts = String(genreRaw)
        .split(/[,;/]+/)
        .map((g) => g.trim())
        .filter((g) => g.length > 0 && g.length < 50);
      for (const raw of parts) {
        const key = raw.toLowerCase();
        if (!map.has(key)) {
          map.set(key, {
            name: raw,
            count: 0,
            trackCount: 0,
            bookCount: 0,
            durationSec: 0,
            lastAdded: null,
            coverUrl: item.coverUrl || null,
            items: []
          });
        }
        const entry = map.get(key);
        entry.count += 1;
        if (isMusic) entry.trackCount += 1;
        else entry.bookCount += 1;
        entry.durationSec += item.durationSec || 0;
        if (!entry.lastAdded || (item.addedAt || '') > entry.lastAdded) {
          entry.lastAdded = item.addedAt || null;
        }
        if (!entry.coverUrl && item.coverUrl) {
          entry.coverUrl = item.coverUrl;
        }
        entry.items.push(item);
      }
    }
    return Array.from(map.values()).sort((a, b) => {
      if (a.name === 'Uncategorized') return 1;
      if (b.name === 'Uncategorized') return -1;
      return a.name.localeCompare(b.name);
    });
  }, [data?.genres, isMusic, items, books]);

  const handlePlayBook = useCallback((book, startPart = null) => {
    if (!book) return;
    const parts = book.parts && book.parts.length ? book.parts : [book];
    const target = startPart || getBookStartingPart(book);
    onPlay(target, parts);
  }, [onPlay]);

  const handlePlayCard = useCallback((item, context) => {
    if (item.isMultiPart && item.parts?.length) {
      handlePlayBook(item);
    } else {
      onPlay(item, context);
    }
  }, [handlePlayBook, onPlay]);

  const handleShufflePlay = useCallback((list) => {
    if (!Array.isArray(list) || !list.length) return;
    const itemsToPlay = !isMusic ? list.flatMap((b) => (b.parts?.length ? b.parts : [b])) : list;
    const shuffled = [...itemsToPlay];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    onPlay(shuffled[0], shuffled, { shuffle: true });
  }, [isMusic, onPlay]);

  const handlePlayAll = useCallback((list) => {
    if (!Array.isArray(list) || !list.length) return;
    const itemsToPlay = !isMusic ? list.flatMap((b) => (b.parts?.length ? b.parts : [b])) : list;
    if (itemsToPlay.length) onPlay(itemsToPlay[0], itemsToPlay, { shuffle: false });
  }, [isMusic, onPlay]);

  const handleAddToPlaylist = useCallback((item) => {
    if (item.isMultiPart && item.parts?.length) {
      setPlaylistTarget(item.parts);
    } else {
      setPlaylistTarget([item]);
    }
  }, []);

  const allFavoriteItems = useMemo(() => {
    if (!favoritesOnly || !data) return [];
    if (!isMusic) {
      const favBooks = books.filter((b) => b.favorite || (b.author && favNames.has(b.author)));
      return favBooks.flatMap((b) => (b.parts?.length ? b.parts : [b]));
    }
    const explicitTracks = items.filter((i) => i.favorite);
    const albumTracks = (data.albums || [])
      .filter((a) => favAlbums.has(a.key))
      .flatMap((a) => a.tracks || []);
    const artistTracks = items.filter((i) => favNames.has(i.albumArtist || i.artist));

    const seen = new Set();
    const result = [];
    for (const t of [...explicitTracks, ...albumTracks, ...artistTracks]) {
      if (t && t.id && !seen.has(t.id)) {
        seen.add(t.id);
        result.push(t);
      }
    }
    return result;
  }, [favoritesOnly, data, isMusic, books, favNames, items, favAlbums]);

  const visibleItems = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase();

    // 1. Inside a multi-part book drill-down
    if (drill?.type === 'book') {
      let list = drill.book?.parts || [];
      if (needle) {
        list = list.filter((p) =>
          [p.title, p.chapterTitle, p.author, p.narrator]
            .filter(Boolean)
            .some((f) => f.toLowerCase().includes(needle))
        );
      }
      return list;
    }

    // 1b. Inside a playlist drill-down
    if (drill?.type === 'playlist') {
      let list = drill.items || [];
      if (needle) {
        list = list.filter((p) =>
          [p.title, p.chapterTitle, p.author, p.narrator, p.artist, p.album, p.albumArtist]
            .filter(Boolean)
            .some((f) => f.toLowerCase().includes(needle))
        );
      }
      return list.map((i) => ({
        ...i,
        coverUrl: i.coverUrl || api.coverUrl(i.id),
        offline: offlineIds.has(i.id) || Boolean(i.offline)
      }));
    }

    // 1c. Inside a genre drill-down
    if (drill?.type === 'genre') {
      const gLower = drill.name.toLowerCase();
      const baseList = isMusic ? items : books;
      let list = baseList.filter((item) => {
        const gRaw = item.genre || inferGenre(item, isMusic) || (isMusic ? 'Uncategorized' : '');
        if (!gRaw) return false;
        const genresList = String(gRaw)
          .split(/[,;/]+/)
          .map((g) => g.trim().toLowerCase());
        return genresList.includes(gLower) || String(gRaw).toLowerCase().includes(gLower);
      });
      if (needle) {
        list = list.filter((i) =>
          [i.title, i.album, i.artist, i.albumArtist, i.author, i.narrator, i.series]
            .filter(Boolean)
            .some((f) => f.toLowerCase().includes(needle))
        );
      }
      return list.map((i) => ({
        ...i,
        offline: offlineIds.has(i.id) || (i.parts?.length ? i.parts.every((p) => offlineIds.has(p.id)) : false) || Boolean(i.offline)
      })).sort(compareBy(sortGetter, sort.dir, ITEM_TIEBREAKS[sortField]));
    }

    // 2. Audiobooks library: browse consolidated books
    if (!isMusic) {
      let list = favoritesOnly && !drill ? books.filter((b) => b.favorite) : books;

      if (drill) {
        if (drill.type === 'series') list = list.filter((b) => b.series === drill.name);
        else if (drill.type === 'author') list = list.filter((b) => b.author === drill.name);
      }

      if (selectedGenre) {
        const gLower = selectedGenre.toLowerCase();
        list = list.filter((b) => {
          if (!b.genre) return false;
          const genresList = String(b.genre)
            .split(/[,;/]+/)
            .map((g) => g.trim().toLowerCase());
          return genresList.includes(gLower) || String(b.genre).toLowerCase().includes(gLower);
        });
      }

      if (needle) {
        list = list.filter((b) =>
          [b.title, b.author, b.narrator, b.series]
            .filter(Boolean)
            .some((field) => field.toLowerCase().includes(needle)) ||
          (b.parts || []).some((p) => [p.title, p.chapterTitle].filter(Boolean).some((f) => f.toLowerCase().includes(needle)))
        );
      }

      return [...list].sort(compareBy(sortGetter, sort.dir, ITEM_TIEBREAKS[sortField]));
    }

    // 3. Music library: browse individual tracks
    let list = favoritesOnly && !drill ? items.filter((i) => i.favorite) : items;

    if (drill) {
      if (drill.type === 'album') list = list.filter((i) => `${i.albumArtist || i.artist}::${i.album}` === drill.key);
      else if (drill.type === 'artist') list = list.filter((i) => (i.albumArtist || i.artist) === drill.name);
    }

    if (selectedGenre) {
      const gLower = selectedGenre.toLowerCase();
      list = list.filter((i) => {
        const gRaw = i.genre || inferGenre(i, true) || 'Uncategorized';
        if (!gRaw) return false;
        const genresList = String(gRaw)
          .split(/[,;/]+/)
          .map((g) => g.trim().toLowerCase());
        return genresList.includes(gLower) || String(gRaw).toLowerCase().includes(gLower);
      });
    }

    if (needle) {
      list = list.filter((i) =>
        [i.title, i.album, i.artist, i.albumArtist]
          .filter(Boolean)
          .some((field) => field.toLowerCase().includes(needle))
      );
    }

    return [...list]
      .map((i) => ({
        ...i,
        offline: offlineIds.has(i.id) || (i.parts?.length ? i.parts.every((p) => offlineIds.has(p.id)) : false) || Boolean(i.offline)
      }))
      .sort(compareBy(sortGetter, sort.dir, ITEM_TIEBREAKS[sortField]));
  }, [drill, isMusic, favoritesOnly, books, items, deferredQuery, selectedGenre, sortGetter, sort.dir, sortField, offlineIds]);

  const displayedItems = useMemo(() => {
    return visibleItems.slice(0, displayLimit);
  }, [visibleItems, displayLimit]);

  const favesListToPlay = useMemo(() => {
    return allFavoriteItems.length > 0 ? allFavoriteItems : visibleItems;
  }, [allFavoriteItems, visibleItems]);

  const sortedGroups = useMemo(() => {
    if (grouping === 'playlist') {
      let list = playlists;
      if (deferredQuery.trim()) {
        const needle = deferredQuery.trim().toLowerCase();
        list = list.filter((p) => p.name.toLowerCase().includes(needle));
      }
      return [...(list || [])].sort(compareBy(GROUP_FIELDS[sortField] || GROUP_FIELDS.name, sort.dir, GROUP_TIEBREAKS[sortField]));
    }
    if (grouping === 'genre') {
      let list = genres;
      if (deferredQuery.trim()) {
        const needle = deferredQuery.trim().toLowerCase();
        list = list.filter((g) => g.name.toLowerCase().includes(needle));
      }
      return [...(list || [])].sort(compareBy(GROUP_FIELDS[sortField] || GROUP_FIELDS.name, sort.dir, GROUP_TIEBREAKS[sortField]));
    }
    if (!data) return [];
    const list = grouping === 'album' ? data.albums
      : grouping === 'artist' ? data.artists
        : grouping === 'author' ? data.authors
          : grouping === 'series' ? data.series
            : [];
    return [...(list || [])].sort(compareBy(GROUP_FIELDS[sortField] || GROUP_FIELDS.name, sort.dir, GROUP_TIEBREAKS[sortField]));
  }, [data, playlists, genres, grouping, deferredQuery, sortField, sort.dir]);

  const displayedGroups = useMemo(() => {
    return sortedGroups.slice(0, displayLimit);
  }, [sortedGroups, displayLimit]);

  const matchingPlaylists = useMemo(() => {
    if (!deferredQuery.trim() || grouping !== 'all' || drill || favoritesOnly || !playlists.length) return [];
    const needle = deferredQuery.trim().toLowerCase();
    return playlists.filter((p) => p.name.toLowerCase().includes(needle));
  }, [deferredQuery, grouping, drill, favoritesOnly, playlists]);

  const markBusy = useCallback((id, busy) => {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const handleCacheOffline = useCallback(async (item) => {
    const isOffline = offlineIds.has(item.id) || (item.parts?.length ? item.parts.every((p) => offlineIds.has(p.id)) : false) || Boolean(item.offline);
    markBusy(item.id, true);
    try {
      if (isOffline) {
        if (item.isMultiPart || item.parts?.length) {
          await removeOfflineBook(item);
        } else {
          await removeOfflineTrack(item.id);
        }
        notify('Removed from device', item.title);
      } else {
        notify('Downloading for offline...', item.title);
        if (item.isMultiPart || item.parts?.length) {
          await downloadBook(item, item.parts, (p) => {
            setOfflineProgress({ title: item.title, percent: p.overallPercent });
          });
        } else {
          await downloadTrack(item, (p) => {
            setOfflineProgress({ title: item.title, percent: p.percent });
          });
        }
        notify('Available offline', `${item.title} downloaded to device.`);
      }
      refreshOfflineIds();
      onRefresh();
    } catch (err) {
      notify('Download failed', err.message, true);
    } finally {
      markBusy(item.id, false);
      setOfflineProgress(null);
    }
  }, [offlineIds, markBusy, notify, onRefresh, refreshOfflineIds]);

  const handleToggleOfflineAlbum = useCallback(async (albumName, artistName, tracks) => {
    const allOffline = tracks.length > 0 && tracks.every((t) => offlineIds.has(t.id));
    try {
      if (allOffline) {
        await removeOfflineAlbum(albumName, artistName);
        notify('Removed from device', `${albumName} removed.`);
      } else {
        notify('Downloading album...', `Saving ${tracks.length} tracks to device`);
        await downloadAlbum(albumName, artistName, tracks, (p) => {
          setOfflineProgress({ title: `${albumName} (${p.current}/${p.total})`, percent: p.overallPercent });
        });
        notify('Album downloaded', `${albumName} is now available offline.`);
      }
      refreshOfflineIds();
      onRefresh();
    } catch (err) {
      notify('Album download failed', err.message, true);
    } finally {
      setOfflineProgress(null);
    }
  }, [offlineIds, notify, onRefresh, refreshOfflineIds]);

  const handleToggleOfflinePlaylist = useCallback(async (playlist, tracks) => {
    const allOffline = tracks.length > 0 && tracks.every((t) => offlineIds.has(t.id));
    try {
      if (allOffline) {
        await removeOfflinePlaylist(playlist.id);
        notify('Removed from device', `${playlist.name} removed.`);
      } else {
        notify('Downloading playlist...', `Saving ${tracks.length} tracks to device`);
        await downloadPlaylist(playlist, tracks, (p) => {
          setOfflineProgress({ title: `${playlist.name} (${p.current}/${p.total})`, percent: p.overallPercent });
        });
        notify('Playlist downloaded', `${playlist.name} is now available offline.`);
      }
      refreshOfflineIds();
      onRefresh();
    } catch (err) {
      notify('Playlist download failed', err.message, true);
    } finally {
      setOfflineProgress(null);
    }
  }, [offlineIds, notify, onRefresh, refreshOfflineIds]);

  const handlePlayPlaylist = useCallback(async (playlist, shuffle = false) => {
    try {
      const full = await api.playlist(playlist.id);
      const playlistItems = (full.items || []).map((i) => ({
        ...i,
        coverUrl: i.coverUrl || api.coverUrl(i.id),
        offline: offlineIds.has(i.id) || Boolean(i.offline)
      }));
      if (!playlistItems.length) {
        notify('Empty playlist', 'This playlist has no items to play.', true);
        return;
      }
      if (shuffle) {
        handleShufflePlay(playlistItems);
      } else {
        onPlay(playlistItems[0], playlistItems, { shuffle: false });
      }
    } catch (err) {
      notify('Could not play playlist', err.message, true);
    }
  }, [handleShufflePlay, onPlay, notify, offlineIds]);

  const handleOpenPlaylist = useCallback(async (playlist) => {
    try {
      const full = await api.playlist(playlist.id);
      const items = (full.items || []).map((i) => ({
        ...i,
        coverUrl: i.coverUrl || api.coverUrl(i.id),
        offline: offlineIds.has(i.id) || Boolean(i.offline)
      }));
      setDrill({
        type: 'playlist',
        id: playlist.id,
        name: playlist.name,
        label: playlist.name,
        playlist: full,
        items
      });
    } catch (err) {
      notify('Could not open playlist', err.message, true);
    }
  }, [notify, offlineIds]);

  const groups = useMemo(() => {
    if (isMusic) {
      return [
        { key: 'all', label: 'All tracks', count: items.length },
        { key: 'album', label: 'Albums', count: data?.albums?.length || 0 },
        { key: 'artist', label: 'Artists', count: data?.artists?.length || 0 },
        { key: 'genre', label: 'Genres', count: genres.length },
        { key: 'playlist', label: 'Playlists', count: playlists.length }
      ];
    }
    return [
      { key: 'all', label: 'All books', count: books.length },
      { key: 'author', label: 'Authors', count: data?.authors?.length || 0 },
      { key: 'series', label: 'Series', count: data?.series?.length || 0 },
      { key: 'genre', label: 'Genres', count: genres.length },
      { key: 'playlist', label: 'Playlists', count: playlists.length }
    ];
  }, [data, items.length, books.length, genres.length, isMusic, playlists.length]);

  // ---- rendering --------------------------------------------------------

  if (!folderId && !favoritesOnly) {
    return (
      <>
        <div className="view-header">
          <h1 className="view-title">{isMusic ? 'Music' : 'Audiobooks'}</h1>
          <p className="view-subtitle">Connect a Drive folder to start listening.</p>
        </div>
        <div className="empty-state">
          <FolderPlus size={40} style={{ color: 'var(--text-muted)', margin: '0 auto 1rem' }} />
          <h3>No {isMusic ? 'music' : 'audiobooks'} folder connected</h3>
          <p>
            Choose the Google Drive folder that holds your{' '}
            {isMusic ? 'albums and tracks' : 'audiobook files'}. FRAUDIO scans it and builds
            your library.
          </p>
          <button type="button" className="btn btn-primary btn-lg" onClick={() => onOpenDrivePicker(kind)}>
            <FolderOpen size={17} />
            Choose folder
          </button>
        </div>
      </>
    );
  }

  if (loading && !data) {
    return (
      <div className="loading-state">
        <div className="spinner" />
        <p>Loading your library…</p>
      </div>
    );
  }

  const totalDuration = visibleItems.reduce((sum, i) => sum + (i.durationSec || 0), 0);

  return (
    <>
      <div className="view-header">
        <h1 className="view-title">
          {favoritesOnly ? 'Favourites' : isMusic ? 'Music' : 'Audiobooks'}
        </h1>
        <p className="view-subtitle">
          {folderName ? `${folderName} · ` : ''}
          {pluralize(visibleItems.length, isMusic ? 'track' : drill?.type === 'book' ? 'chapter' : 'book')}
          {totalDuration > 0 ? ` · ${formatLengthShort(totalDuration)}` : ''}
        </p>
      </div>

      <div className="toolbar">
        <div className="toolbar-search">
          <Search className="toolbar-search-icon" size={16} />
          <input
            type="search"
            className="input-field"
            placeholder={isMusic ? 'Search tracks, albums, artists…' : 'Search titles, authors, series…'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {!favoritesOnly && (
          <button type="button" className="btn btn-secondary" onClick={() => onScan()} disabled={Boolean(scanState)}>
            <RefreshCw size={15} className={scanState ? 'spin' : ''} />
            {scanState ? 'Scanning…' : 'Rescan Drive'}
          </button>
        )}

        {!favoritesOnly && (
          <button type="button" className="btn btn-secondary" onClick={() => onOpenDrivePicker(kind)}>
            <FolderOpen size={15} />
            Folder
          </button>
        )}

        {favoritesOnly && favesListToPlay.length > 0 && (
          <>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => handlePlayAll(favesListToPlay)}
              title="Play all favourites in order"
            >
              <Play size={14} fill="currentColor" />
              Play all ({favesListToPlay.length})
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => handleShufflePlay(favesListToPlay)}
              title="Shuffle all favourites"
            >
              <Shuffle size={14} />
              Shuffle
            </button>
          </>
        )}

        <div className="library-sort" title="Sort order">
          <ArrowUpNarrowWide size={14} className="library-sort-icon" />
          <select
            className="input-field library-sort-select"
            value={sortField}
            onChange={(e) => setSortField(e.target.value)}
            aria-label="Sort by"
          >
            {sortOptions.map(([field, label]) => (
              <option key={field} value={field}>{label}</option>
            ))}
          </select>
          <button
            type="button"
            className="icon-btn"
            onClick={flipSortDir}
            title={sort.dir === 1 ? 'Ascending - click for descending' : 'Descending - click for ascending'}
          >
            {sort.dir === 1 ? <ArrowUpNarrowWide size={15} /> : <ArrowDownWideNarrow size={15} />}
          </button>
        </div>

        {genres.length > 0 && (
          <div className="library-genre-filter" title="Filter by genre">
            <Tag size={14} className="library-sort-icon" />
            <select
              className="input-field library-genre-select"
              value={selectedGenre}
              onChange={(e) => setSelectedGenre(e.target.value)}
              aria-label="Filter by genre"
            >
              <option value="">All genres</option>
              {genres.map((g) => (
                <option key={g.name} value={g.name}>
                  {g.name} ({isMusic ? g.trackCount : g.bookCount})
                </option>
              ))}
            </select>
            {selectedGenre && (
              <button
                type="button"
                className="icon-btn"
                onClick={() => setSelectedGenre('')}
                title="Clear genre filter"
              >
                <X size={14} />
              </button>
            )}
          </div>
        )}
      </div>

      {scanState && (
        <div className="job-card">
          <div className="job-head">
            <div>
              <div className="job-title">Scanning {folderName || 'your Drive folder'}</div>
              <div className="job-phase">
                {scanState.current || 'Reading folder metadata…'}
                {scanState.total > 0 ? ` (${scanState.processed}/${scanState.total})` : ''}
              </div>
            </div>
          </div>
          <div className="job-bar">
            <div
              className="job-bar-fill"
              style={{ width: `${scanState.total > 0 ? Math.min(100, Math.max(0, Math.round((scanState.processed / scanState.total) * 100))) : 40}%` }}
            />
          </div>
        </div>
      )}

      {error && <div className="error-banner">{error}</div>}

      {!favoritesOnly && (
        <div className="filter-chips">
          {groups.map((group) => (
            <button
              key={group.key}
              type="button"
              className={`filter-chip ${grouping === group.key && !drill ? 'active' : ''}`}
              onClick={() => { setGrouping(group.key); setDrill(null); }}
            >
              {group.label} ({group.count})
            </button>
          ))}
        </div>
      )}

      {selectedGenre && !drill && (
        <div className="active-filter-indicator">
          <span>Genre: <strong>{selectedGenre}</strong></span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setSelectedGenre('')}
            title="Clear genre filter"
          >
            <X size={13} />
            Clear
          </button>
        </div>
      )}

      {drill && (
        <div className="drill-banner">
          <div className="drill-banner-top">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDrill(drill.parent || null)}>
              <ChevronLeft size={15} />
              Back
            </button>
            <span className="drill-banner-title">{drill.name}</span>
            <span className="section-count">
              {pluralize(visibleItems.length, drill.type === 'book' ? 'chapter' : isMusic ? 'track' : 'item')}
            </span>
            {drill.type === 'album' && visibleItems.length > 0 && (
              <button
                type="button"
                className={`icon-btn ${favAlbums.has(albumKey(visibleItems[0].albumArtist || visibleItems[0].artist, drill.name)) ? 'active' : ''}`}
                title="Favourite this album"
                onClick={() => {
                  const artist = visibleItems[0].albumArtist || visibleItems[0].artist;
                  const faved = favAlbums.has(albumKey(artist, drill.name));
                  toggleAlbumFavorite(artist, drill.name, !faved);
                }}
              >
                <Heart size={15} fill={favAlbums.has(albumKey(visibleItems[0].albumArtist || visibleItems[0].artist, drill.name)) ? 'currentColor' : 'none'} />
              </button>
            )}
            {(drill.type === 'artist' || drill.type === 'author') && (
              <button
                type="button"
                className={`icon-btn ${favNames.has(drill.name) ? 'active' : ''}`}
                title={drill.type === 'artist' ? 'Favourite this artist' : 'Favourite this author'}
                onClick={() => toggleNameFavorite(drill.name, !favNames.has(drill.name))}
              >
                <Heart size={15} fill={favNames.has(drill.name) ? 'currentColor' : 'none'} />
              </button>
            )}
          </div>

          {((drill.type === 'album' && visibleItems.length > 0) ||
            drill.type === 'book' ||
            (drill.type === 'artist' && visibleItems.length > 0) ||
            (drill.type === 'playlist' && visibleItems.length > 0) ||
            (drill.type === 'genre' && visibleItems.length > 0)) && (
            <div className="drill-banner-actions">
              {drill.type === 'genre' && (
                <>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => handlePlayAll(visibleItems)}
                  >
                    <Play size={13} fill="currentColor" />
                    Play all
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => handleShufflePlay(visibleItems)}
                  >
                    <Shuffle size={13} />
                    Shuffle
                  </button>
                </>
              )}
              {drill.type === 'playlist' && (
                <>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => onPlay(visibleItems[0], visibleItems, { shuffle: false })}
                  >
                    <Play size={13} fill="currentColor" />
                    Play all
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => handleShufflePlay(visibleItems)}
                  >
                    <Shuffle size={13} />
                    Shuffle
                  </button>
                  {(() => {
                    const isPlaylistOffline = visibleItems.length > 0 && visibleItems.every((t) => offlineIds.has(t.id));
                    return (
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => handleToggleOfflinePlaylist(drill.playlist || { id: drill.id, name: drill.name }, visibleItems)}
                        title={isPlaylistOffline ? 'Remove playlist from device' : 'Download playlist for offline listening'}
                        style={isPlaylistOffline ? { color: 'var(--success, #22c55e)' } : {}}
                      >
                        {isPlaylistOffline ? <HardDrive size={13} /> : <HardDriveDownload size={13} />}
                        {isPlaylistOffline ? 'Downloaded' : 'Download playlist'}
                      </button>
                    );
                  })()}
                </>
              )}
              {drill.type === 'album' && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setPlaylistTarget(visibleItems)}
                >
                  <ListPlus size={13} />
                  Album to playlist
                </button>
              )}
              {drill.type === 'album' && (() => {
                const isAlbumOffline = visibleItems.length > 0 && visibleItems.every((t) => offlineIds.has(t.id));
                return (
                  <button
                    type="button"
                    className={`btn btn-sm ${isAlbumOffline ? 'btn-secondary' : 'btn-secondary'}`}
                    onClick={() => handleToggleOfflineAlbum(drill.name, visibleItems[0]?.albumArtist || visibleItems[0]?.artist, visibleItems)}
                    title={isAlbumOffline ? 'Remove album from device storage' : 'Download entire album for offline listening'}
                    style={isAlbumOffline ? { color: 'var(--success, #22c55e)' } : {}}
                  >
                    {isAlbumOffline ? <HardDrive size={13} /> : <HardDriveDownload size={13} />}
                    {isAlbumOffline ? 'Downloaded' : 'Download album'}
                  </button>
                );
              })()}
              {drill.type === 'album' && (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => onPlay(visibleItems[0], visibleItems)}
                >
                  <Play size={13} fill="currentColor" />
                  Play all
                </button>
              )}
              {drill.type === 'book' && (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => handlePlayBook(drill.book)}
                >
                  <Play size={13} fill="currentColor" />
                  {drill.book?.progressSec > 0 ? 'Resume book' : 'Play book'}
                </button>
              )}
              {drill.type === 'artist' && (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => onPlay(visibleItems[0], visibleItems)}
                >
                  <Play size={13} fill="currentColor" />
                  Play all
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {visibleItems.length === 0 && (grouping === 'all' || drill || favoritesOnly) && matchingPlaylists.length === 0 && !(favoritesOnly && !drill && (favAlbums.size > 0 || favNames.size > 0)) ? (
        <div className="empty-state">
          <Music size={40} style={{ color: 'var(--text-muted)', margin: '0 auto 1rem' }} />
          <h3>{query ? 'Nothing matched' : 'Nothing here yet'}</h3>
          <p>
            {query
              ? `No items match "${query}". Try a different search.`
              : favoritesOnly
                ? 'Tap the heart on any item, album or artist to keep it here.'
                : 'Run a rescan to pull your latest files from Drive.'}
          </p>
        </div>
      ) : grouping === 'all' || drill || favoritesOnly ? (
        <>
          {favoritesOnly && !drill && (data?.albums || [])
            .filter((a) => favAlbums.has(a.key))
            .map((album) => (
              <div key={`fav-${album.key}`} className="row-item" style={{ marginBottom: '0.4rem' }} onClick={() => setDrill({ type: 'album', key: album.key, name: album.album, label: album.album })}>
                <img className="row-thumb" src={album.coverUrl} alt="" loading="lazy" />
                <div className="row-meta">
                  <div className="row-title">{album.album}</div>
                  <div className="row-subtitle">{album.artist} · {pluralize(album.tracks.length, 'track')}</div>
                </div>
                <div className="row-aside">
                  <button
                    type="button"
                    className="icon-btn active"
                    title="Remove from favourites"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleAlbumFavorite(album.artist, album.album, false);
                    }}
                  >
                    <Heart size={15} fill="currentColor" />
                  </button>
                </div>
                <ChevronLeft size={15} style={{ transform: 'rotate(180deg)' }} />
              </div>
            ))}

          {favoritesOnly && !drill && favNames.size > 0 && (
            <div className="filter-chips" style={{ margin: '0.5rem 0 1.25rem' }}>
              {Array.from(favNames).map((name) => (
                <button
                  key={name}
                  type="button"
                  className="filter-chip active"
                  onClick={() => setDrill(isMusic
                    ? { type: 'artist', name, label: name }
                    : { type: 'author', name, label: name })}
                >
                  {name}
                </button>
              ))}
            </div>
          )}

          {drill?.type === 'book' ? (
            <div className="book-drill-container">
              <div className="book-drill-header">
                <img
                  className="book-drill-cover"
                  src={drill.book.coverUrl || api.coverUrl(drill.book.id || drill.book.parts?.[0]?.id)}
                  alt=""
                  loading="lazy"
                />
                <div className="book-drill-info">
                  <h2 className="book-drill-title">{drill.book.title}</h2>
                  <div className="book-drill-author">
                    {drill.book.author && <span>By <strong>{drill.book.author}</strong></span>}
                    {drill.book.narrator && <span> · Narrated by {drill.book.narrator}</span>}
                    {drill.book.series && <span> · Series: {drill.book.series}</span>}
                  </div>
                  <div className="book-drill-meta">
                    <span>{pluralize(drill.book.parts?.length || 0, 'chapter')}</span>
                    {drill.book.durationSec > 0 && <span>· {formatLengthShort(drill.book.durationSec)} total</span>}
                    {drill.book.progressSec > 0 && (
                      <span>· {percentOf(drill.book.progressSec, drill.book.durationSec)}% listened</span>
                    )}
                  </div>
                  {drill.book.progressSec > 0 && (
                    <div className="media-progress" style={{ maxWidth: 320, marginBottom: '0.85rem' }}>
                      <div
                        className="media-progress-fill"
                        style={{ width: `${percentOf(drill.book.progressSec, drill.book.durationSec)}%` }}
                      />
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => handlePlayBook(drill.book)}
                    >
                      <Play size={14} fill="currentColor" />
                      {drill.book.progressSec > 0 ? 'Resume book' : 'Play book'}
                    </button>
                    <button
                      type="button"
                      className={`btn btn-secondary ${drill.book.favorite ? 'active' : ''}`}
                      onClick={() => onToggleFavorite(drill.book, !drill.book.favorite)}
                    >
                      <Heart size={14} fill={drill.book.favorite ? 'currentColor' : 'none'} />
                      {drill.book.favorite ? 'Favourited' : 'Favourite book'}
                    </button>
                    {(() => {
                      const isBookOffline = Boolean(drill.book.offline) || offlineIds.has(drill.book.id) || (drill.book.parts?.length && drill.book.parts.every((p) => offlineIds.has(p.id)));
                      return (
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => handleCacheOffline(drill.book)}
                          style={isBookOffline ? { color: 'var(--success, #22c55e)' } : {}}
                        >
                          <HardDrive size={14} />
                          {isBookOffline ? 'Downloaded' : 'Download book'}
                        </button>
                      );
                    })()}
                  </div>
                </div>
              </div>

              <div className="section-head">
                <span className="section-title">Chapters</span>
                <span className="section-count">{visibleItems.length}</span>
              </div>

              <div className="row-list">
                {visibleItems.map((part, index) => {
                  const partDuration = part.durationSec || 0;
                  const partProgress = part.progressSec ?? part.progress?.positionSec ?? 0;
                  const partPercent = percentOf(partProgress, partDuration);
                  const isPartCompleted = part.completed || (partPercent !== null && partPercent >= 98);
                  return (
                    <div
                      key={part.id}
                      className="row-item"
                      onClick={() => onPlay(part, drill.book.parts)}
                    >
                      <div className="row-number">
                        {part.trackNumber || index + 1}
                      </div>
                      <div className="row-meta">
                        <div className="row-title">
                          {part.chapterTitle || part.title}
                          {isPartCompleted && (
                            <span className="badge badge-success" style={{ marginLeft: '0.5rem', fontSize: '0.68rem' }}>
                              Done
                            </span>
                          )}
                        </div>
                        <div className="row-subtitle">
                          {partDuration > 0 ? formatLengthShort(partDuration) : ''}
                          {partProgress > 0 && !isPartCompleted && ` · resume at ${formatDuration(partProgress)} (${Math.round(partPercent)}%)`}
                        </div>
                        {partPercent > 0 && !isPartCompleted && (
                          <div className="media-progress" style={{ maxWidth: 200, marginTop: '0.25rem' }}>
                            <div className="media-progress-fill" style={{ width: `${partPercent}%` }} />
                          </div>
                        )}
                      </div>
                      <div className="row-aside">
                        <button
                          type="button"
                          className={`icon-btn ${part.favorite ? 'active' : ''}`}
                          title={part.favorite ? 'Remove from favourites' : 'Add to favourites'}
                          onClick={(e) => {
                            e.stopPropagation();
                            onToggleFavorite(part, !part.favorite);
                          }}
                        >
                          <Heart size={14} fill={part.favorite ? 'currentColor' : 'none'} />
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          title="Play chapter"
                          onClick={(e) => {
                            e.stopPropagation();
                            onPlay(part, drill.book.parts);
                          }}
                        >
                          <Play size={14} fill="currentColor" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <>
              {matchingPlaylists.length > 0 && (
                <div className="library-shelf-section">
                  <div className="section-head" style={{ marginBottom: '0.65rem' }}>
                    <span className="section-title">Matching Playlists</span>
                    <span className="section-count">{matchingPlaylists.length}</span>
                  </div>
                  <div className="library-playlists-shelf">
                    {matchingPlaylists.map((pl) => (
                      <div
                        key={pl.id}
                        className="playlist-shelf-card"
                        onClick={() => handleOpenPlaylist(pl)}
                      >
                        <div className="playlist-shelf-thumb">
                          {pl.coverUrl ? (
                            <img src={pl.coverUrl} alt="" loading="lazy" />
                          ) : (
                            <div className="playlist-shelf-placeholder">
                              <ListMusic size={24} />
                            </div>
                          )}
                          <div className="playlist-shelf-actions">
                            <button
                              type="button"
                              className="playlist-shelf-btn"
                              title="Play playlist"
                              onClick={(e) => {
                                e.stopPropagation();
                                handlePlayPlaylist(pl, false);
                              }}
                            >
                              <Play size={13} fill="currentColor" />
                            </button>
                            <button
                              type="button"
                              className="playlist-shelf-btn"
                              title="Shuffle playlist"
                              onClick={(e) => {
                                e.stopPropagation();
                                handlePlayPlaylist(pl, true);
                              }}
                            >
                              <Shuffle size={13} />
                            </button>
                          </div>
                        </div>
                        <div className="playlist-shelf-info">
                          <div className="playlist-shelf-title" title={pl.name}>{pl.name}</div>
                          <div className="playlist-shelf-sub">
                            {pluralize(pl.count, isMusic ? 'track' : 'item')}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {grouping === 'all' && !drill && !favoritesOnly && !query && playlists.length > 0 && (
                <div className="library-shelf-section">
                  <div className="section-head" style={{ marginBottom: '0.65rem' }}>
                    <span className="section-title">Playlists</span>
                    <span className="section-count">{playlists.length}</span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      style={{ marginLeft: 'auto', fontSize: '0.78rem' }}
                      onClick={() => setGrouping('playlist')}
                    >
                      See all
                    </button>
                  </div>
                  <div className="library-playlists-shelf">
                    {playlists.map((pl) => (
                      <div
                        key={pl.id}
                        className="playlist-shelf-card"
                        onClick={() => handleOpenPlaylist(pl)}
                      >
                        <div className="playlist-shelf-thumb">
                          {pl.coverUrl ? (
                            <img src={pl.coverUrl} alt="" loading="lazy" />
                          ) : (
                            <div className="playlist-shelf-placeholder">
                              <ListMusic size={24} />
                            </div>
                          )}
                          <div className="playlist-shelf-actions">
                            <button
                              type="button"
                              className="playlist-shelf-btn"
                              title="Play playlist"
                              onClick={(e) => {
                                e.stopPropagation();
                                handlePlayPlaylist(pl, false);
                              }}
                            >
                              <Play size={13} fill="currentColor" />
                            </button>
                            <button
                              type="button"
                              className="playlist-shelf-btn"
                              title="Shuffle playlist"
                              onClick={(e) => {
                                e.stopPropagation();
                                handlePlayPlaylist(pl, true);
                              }}
                            >
                              <Shuffle size={13} />
                            </button>
                          </div>
                        </div>
                        <div className="playlist-shelf-info">
                          <div className="playlist-shelf-title" title={pl.name}>{pl.name}</div>
                          <div className="playlist-shelf-sub">
                            {pluralize(pl.count, isMusic ? 'track' : 'item')}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {(visibleItems.length > 0 || !matchingPlaylists.length) && (
                <>
                  <div className="section-head">
                    <span className="section-title">
                      {drill
                        ? drill.label || 'Items'
                        : favoritesOnly
                          ? (isMusic ? 'Favourite tracks' : 'Favourite books')
                          : (isMusic ? 'All tracks' : 'All books')}
                    </span>
                    <span className="section-count">{visibleItems.length}</span>
                    {favoritesOnly && !drill && favesListToPlay.length > 0 && (
                      <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.4rem' }}>
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          onClick={() => handlePlayAll(favesListToPlay)}
                          title="Play all favourites in order"
                        >
                          <Play size={13} fill="currentColor" />
                          Play all
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => handleShufflePlay(favesListToPlay)}
                          title="Shuffle all favourites"
                        >
                          <Shuffle size={13} />
                          Shuffle
                        </button>
                      </div>
                    )}
                  </div>
                  <div className={`media-grid ${isMusic ? 'dense' : ''}`}>
                    {displayedItems.map((item) => (
                      <MediaCard
                        key={item.id}
                        item={item}
                        context={visibleItems}
                        busy={busyIds.has(item.id)}
                        onPlay={handlePlayCard}
                        onOpenBook={(book) => setDrill({ type: 'book', book, name: book.title, label: book.title, parent: drill })}
                        onToggleFavorite={onToggleFavorite}
                        onCacheOffline={handleCacheOffline}
                        onAddToPlaylist={handleAddToPlaylist}
                      />
                    ))}
                  </div>
                  {visibleItems.length > displayLimit && (
                    <div ref={loadMoreRef} className="library-load-more" style={{ textAlign: 'center', padding: '1.25rem 0' }}>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => setDisplayLimit((prev) => prev + 60)}
                      >
                        Show more ({visibleItems.length - displayLimit} remaining)
                      </button>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </>
      ) : grouping === 'genre' ? (
        sortedGroups.length === 0 ? (
          <div className="empty-state">
            <Tag size={40} style={{ color: 'var(--text-muted)', margin: '0 auto 1rem' }} />
            <h3>{query ? 'No matching genres' : 'No genres found'}</h3>
            <p>
              {query
                ? `No genres match "${query}".`
                : 'Items with genre metadata will show up here.'}
            </p>
          </div>
        ) : (
          <div className="row-list">
            {sortedGroups.map((g) => (
              <div
                key={g.name}
                className="row-item"
                onClick={() => setDrill({ type: 'genre', name: g.name, label: g.name })}
              >
                {g.coverUrl ? (
                  <img className="row-thumb" src={g.coverUrl} alt="" loading="lazy" />
                ) : (
                  <div className="row-thumb-placeholder">
                    <Tag size={16} />
                  </div>
                )}
                <div className="row-meta">
                  <div className="row-title">{g.name}</div>
                  <div className="row-subtitle">
                    {pluralize(isMusic ? g.trackCount : g.bookCount, isMusic ? 'track' : 'book')}
                    {g.durationSec ? ` · ${formatLengthShort(g.durationSec)}` : ''}
                  </div>
                </div>
                <div className="row-aside">
                  <button
                    type="button"
                    className="icon-btn"
                    title={`Play all in ${g.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      const gLower = g.name.toLowerCase();
                      const list = (isMusic ? items : books).filter((item) => {
                        const gRaw = item.genre || inferGenre(item, isMusic) || (isMusic ? 'Uncategorized' : '');
                        if (!gRaw) return false;
                        const glist = String(gRaw).split(/[,;/]+/).map((x) => x.trim().toLowerCase());
                        return glist.includes(gLower) || String(gRaw).toLowerCase().includes(gLower);
                      });
                      if (list.length) handlePlayAll(list);
                    }}
                  >
                    <Play size={15} fill="currentColor" />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    title={`Shuffle ${g.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      const gLower = g.name.toLowerCase();
                      const list = (isMusic ? items : books).filter((item) => {
                        const gRaw = item.genre || inferGenre(item, isMusic) || (isMusic ? 'Uncategorized' : '');
                        if (!gRaw) return false;
                        const glist = String(gRaw).split(/[,;/]+/).map((x) => x.trim().toLowerCase());
                        return glist.includes(gLower) || String(gRaw).toLowerCase().includes(gLower);
                      });
                      if (list.length) handleShufflePlay(list);
                    }}
                  >
                    <Shuffle size={15} />
                  </button>
                  <ChevronLeft size={15} style={{ transform: 'rotate(180deg)', color: 'var(--text-muted)' }} />
                </div>
              </div>
            ))}
          </div>
        )
      ) : grouping === 'playlist' ? (
        sortedGroups.length === 0 ? (
          <div className="empty-state">
            <ListMusic size={40} style={{ color: 'var(--text-muted)', margin: '0 auto 1rem' }} />
            <h3>{query ? 'No matching playlists' : 'No playlists yet'}</h3>
            <p>
              {query
                ? `No playlists match "${query}".`
                : 'Group tracks into playlists to play them back-to-back in one queue.'}
            </p>
          </div>
        ) : (
          <div className="row-list">
            {sortedGroups.map((pl) => (
              <div
                key={pl.id}
                className="row-item"
                onClick={() => handleOpenPlaylist(pl)}
              >
                {pl.coverUrl ? (
                  <img className="row-thumb" src={pl.coverUrl} alt="" loading="lazy" />
                ) : (
                  <div className="row-thumb-placeholder">
                    <ListMusic size={16} />
                  </div>
                )}
                <div className="row-meta">
                  <div className="row-title">{pl.name}</div>
                  <div className="row-subtitle">
                    {pluralize(pl.count, isMusic ? 'track' : 'item')}
                  </div>
                </div>
                <div className="row-aside">
                  <button
                    type="button"
                    className="icon-btn"
                    title="Play playlist"
                    onClick={(e) => {
                      e.stopPropagation();
                      handlePlayPlaylist(pl, false);
                    }}
                  >
                    <Play size={15} fill="currentColor" />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    title="Shuffle playlist"
                    onClick={(e) => {
                      e.stopPropagation();
                      handlePlayPlaylist(pl, true);
                    }}
                  >
                    <Shuffle size={15} />
                  </button>
                  <ChevronLeft size={15} style={{ transform: 'rotate(180deg)' }} />
                </div>
              </div>
            ))}
          </div>
        )
      ) : grouping === 'series' ? (
        <div className="row-list">
          {sortedGroups.map((entry) => (
            <div key={entry.name} className="row-item" onClick={() => setDrill({ type: 'series', name: entry.name, label: entry.name })}>
              {entry.coverUrl
                ? <img className="row-thumb" src={entry.coverUrl} alt="" loading="lazy" />
                : <div className="row-thumb-placeholder"><BookOpen size={16} /></div>}
              <div className="row-meta">
                <div className="row-title">{entry.name}</div>
                <div className="row-subtitle">
                  {entry.author ? `${entry.author} · ` : ''}{pluralize(entry.bookCount, 'book')}
                </div>
              </div>
              <div className="row-aside">
                {formatLengthShort(entry.books.reduce((s, b) => s + (b.durationSec || 0), 0))}
                <ChevronLeft size={15} style={{ transform: 'rotate(180deg)' }} />
              </div>
            </div>
          ))}
        </div>
      ) : grouping === 'author' ? (
        <div className="row-list">
          {sortedGroups.map((entry) => (
            <div key={entry.name} className="row-item" onClick={() => setDrill({ type: 'author', name: entry.name, label: entry.name })}>
              {entry.coverUrl
                ? <img className="row-thumb" src={entry.coverUrl} alt="" loading="lazy" />
                : <div className="row-thumb-placeholder"><Mic2 size={16} /></div>}
              <div className="row-meta">
                <div className="row-title">{entry.name}</div>
                <div className="row-subtitle">
                  {pluralize(entry.bookCount, 'book')}
                  {entry.totalSec ? ` · ${formatLengthShort(entry.totalSec)}` : ''}
                </div>
              </div>
              <div className="row-aside">
                <button
                  type="button"
                  className={`icon-btn ${favNames.has(entry.name) ? 'active' : ''}`}
                  title={favNames.has(entry.name) ? 'Remove favourite' : 'Favourite this author'}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleNameFavorite(entry.name, !favNames.has(entry.name));
                  }}
                >
                  <Heart size={15} fill={favNames.has(entry.name) ? 'currentColor' : 'none'} />
                </button>
              </div>
              <ChevronLeft size={15} style={{ transform: 'rotate(180deg)', color: 'var(--text-muted)' }} />
            </div>
          ))}
        </div>
      ) : grouping === 'album' ? (
        <>
          <div className="row-list">
            {displayedGroups.map((album) => {
              const key = albumKey(album.artist, album.album);
              const faved = favAlbums.has(key);
              return (
                <div key={album.key} className="row-item" onClick={() => setDrill({ type: 'album', key: album.key, name: album.album, label: album.album })}>
                  <img className="row-thumb" src={album.coverUrl} alt="" loading="lazy" />
                  <div className="row-meta">
                    <div className="row-title">{album.album}</div>
                    <div className="row-subtitle">
                      {album.artist} · {pluralize(album.tracks.length, 'track')}
                    </div>
                  </div>
                  <div className="row-aside">
                    <button
                      type="button"
                      className={`icon-btn ${faved ? 'active' : ''}`}
                      title={faved ? 'Remove from favourites' : 'Favourite album'}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleAlbumFavorite(album.artist, album.album, !faved);
                      }}
                    >
                      <Heart size={15} fill={faved ? 'currentColor' : 'none'} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      title="Add whole album to a playlist"
                      onClick={(e) => {
                        e.stopPropagation();
                        setPlaylistTarget(album.tracks);
                      }}
                    >
                      <ListPlus size={15} />
                    </button>
                    <span>{formatLengthShort(album.tracks.reduce((s, t) => s + (t.durationSec || 0), 0))}</span>
                  </div>
                  <ChevronLeft size={15} style={{ transform: 'rotate(180deg)' }} />
                </div>
              );
            })}
          </div>
          {sortedGroups.length > displayLimit && (
            <div ref={groupLoadMoreRef} className="library-load-more" style={{ textAlign: 'center', padding: '1.25rem 0' }}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setDisplayLimit((prev) => prev + 60)}
              >
                Show more ({sortedGroups.length - displayLimit} remaining)
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="row-list">
            {displayedGroups.map((artist) => {
              const faved = favNames.has(artist.name);
              return (
                <div key={artist.name} className="row-item" onClick={() => setDrill({ type: 'artist', name: artist.name, label: artist.name })}>
                  <div className="row-thumb-placeholder"><Mic2 size={16} /></div>
                  <div className="row-meta">
                    <div className="row-title">{artist.name}</div>
                    <div className="row-subtitle">
                      {pluralize(artist.albumCount, 'album')} · {pluralize(artist.trackCount, 'track')}
                    </div>
                  </div>
                  <div className="row-aside">
                    <button
                      type="button"
                      className={`icon-btn ${faved ? 'active' : ''}`}
                      title={faved ? 'Remove favourite' : 'Favourite this artist'}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleNameFavorite(artist.name, !faved);
                      }}
                    >
                      <Heart size={15} fill={faved ? 'currentColor' : 'none'} />
                    </button>
                  </div>
                  <ChevronLeft size={15} style={{ transform: 'rotate(180deg)', color: 'var(--text-muted)' }} />
                </div>
              );
            })}
          </div>
          {sortedGroups.length > displayLimit && (
            <div ref={groupLoadMoreRef} className="library-load-more" style={{ textAlign: 'center', padding: '1.25rem 0' }}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setDisplayLimit((prev) => prev + 60)}
              >
                Show more ({sortedGroups.length - displayLimit} remaining)
              </button>
            </div>
          )}
        </>
      )}

      <AddToPlaylistModal
        isOpen={Boolean(playlistTarget)}
        items={playlistTarget || []}
        kind={kind}
        onClose={() => {
          setPlaylistTarget(null);
          loadPlaylists();
        }}
        notify={notify}
      />

      {offlineProgress && (
        <div style={{
          position: 'fixed',
          bottom: '5.5rem',
          right: '1.5rem',
          background: 'var(--bg-panel, #18181b)',
          border: '1px solid var(--border-color, #27272a)',
          borderRadius: '12px',
          padding: '0.75rem 1rem',
          boxShadow: '0 8px 30px rgba(0,0,0,0.5)',
          zIndex: 9999,
          minWidth: '260px'
        }}>
          <div style={{ fontSize: '0.82rem', fontWeight: 600, marginBottom: '0.4rem', color: 'var(--text-bright, #fff)' }}>
            {offlineProgress.title}
          </div>
          <div className="media-progress" style={{ height: '4px', margin: 0 }}>
            <div className="media-progress-fill" style={{ width: `${offlineProgress.percent}%` }} />
          </div>
        </div>
      )}
    </>
  );
}
