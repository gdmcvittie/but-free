import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Music4, Download, FolderOpen, RefreshCw, Check, AlertTriangle, Search as SearchIcon, X, User, Heart, ListMusic, Loader2, Zap, Disc, Users, Settings as SettingsIcon } from 'lucide-react';
import { api, subscribeToEvents } from './api';
import { useSwipeBack } from './swipeBack';
import { formatDuration, formatLengthShort, isSameTrack, isSameAlbum, stripTrackNumber } from './format';

/**
 * "What's New" for music: new-release albums from YouTube Music, plus search for
 * songs, artists, and albums.
 *
 * The server scrapes the album grid and downloads via yt-dlp, so this view only
 * ever deals with album/song metadata plus a background job it polls for progress.
 */
export default function MusicWhatsNew({ user, libraryVersion, initialQuery = '', onOpenDrivePicker, onNavigate, notify }) {
  const [albums, setAlbums] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const [detail, setDetail] = useState(null);
  const [tracks, setTracks] = useState([]);
  const [detailLoading, setDetailLoading] = useState(false);

  const [queue, setQueue] = useState([]);
  const [entityJobs, setEntityJobs] = useState({});

  // ---- torrent feeds --------------------------------------------------
  const [feedType, setFeedType] = useState('yt'); // 'yt' | 'flac' | 'mp3'
  const [torrentReleases, setTorrentReleases] = useState([]);
  const [torrentLoading, setTorrentLoading] = useState(false);
  const [torrentRefreshing, setTorrentRefreshing] = useState(false);
  const [torrentError, setTorrentError] = useState(null);
  const [torrentDetail, setTorrentDetail] = useState(null);

  // ---- torrent feed settings & retention -------------------------------
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [torrentSettings, setTorrentSettings] = useState({
    intervalMinutes: 30,
    retentionMonths: 3,
    countFlac: 0,
    countMp3: 0,
    lastSwept: 0
  });
  const [savingTorrentSettings, setSavingTorrentSettings] = useState(false);

  // ---- search ---------------------------------------------------------
  const [query, setQuery] = useState(initialQuery);
  const [searched, setSearched] = useState(Boolean(initialQuery));
  const [searching, setSearching] = useState(false);
  const [songs, setSongs] = useState([]);
  const [searchArtists, setSearchArtists] = useState([]);
  const [searchAlbums, setSearchAlbums] = useState([]);
  const [searchError, setSearchError] = useState(null);
  const [artist, setArtist] = useState(null);
  const abortRef = useRef(null);

  // Favourited artists/albums (album keys are "Artist::Album"), shared with the
  // library's favourites list.
  const [favAlbums, setFavAlbums] = useState(() => new Set());
  const [favNames, setFavNames] = useState(() => new Set());

  // ---- playlist import --------------------------------------------------
  const [plOpen, setPlOpen] = useState(false);
  const [plUrl, setPlUrl] = useState('');
  const [plName, setPlName] = useState('');
  const [plInfo, setPlInfo] = useState(null);
  const [plLoading, setPlLoading] = useState(false);
  const [plError, setPlError] = useState('');
  const plAbortRef = useRef(null);

  // ---- Liked Music via the YouTube Data API (no cookies needed) ----------
  const [likedBusy, setLikedBusy] = useState(false);
  const [likedInfo, setLikedInfo] = useState(null);
  const [likedError, setLikedError] = useState('');
  const [likedLoaded, setLikedLoaded] = useState(false);

  // ---- the account's own YouTube playlists (same OAuth, no cookies) ------
  const [ytLists, setYtLists] = useState(null);
  const [ytError, setYtError] = useState('');
  const [ytImportBusy, setYtImportBusy] = useState('');

  const loadFavorites = useCallback(async () => {
    try {
      const favorites = await api.favorites('music');
      setFavAlbums(new Set(favorites?.albums || []));
      setFavNames(new Set(favorites?.authorNames || []));
    } catch { /* favourites are decoration; browsing works without them */ }
  }, []);

  useEffect(() => { loadFavorites(); }, [loadFavorites]);

  const [libraryTracks, setLibraryTracks] = useState([]);

  const loadLibrary = useCallback(async () => {
    try {
      const res = await api.library('music');
      setLibraryTracks(Array.isArray(res?.items) ? res.items : []);
    } catch { /* best effort */ }
  }, []);

  useEffect(() => { loadLibrary(); }, [loadLibrary, libraryVersion]);

  const isSongInLib = useCallback((song) => {
    return libraryTracks.some((t) => isSameTrack(song, t));
  }, [libraryTracks]);

  const isAlbumInLib = useCallback((album) => {
    return libraryTracks.some((t) => isSameAlbum(album, t));
  }, [libraryTracks]);

  const hasMusicFolder = Boolean(user?.musicFolderId);

  const load = useCallback(async (force = false) => {
    if (force) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const data = await api.musicWhatsNew(force);
      setAlbums(Array.isArray(data?.albums) ? data.albums : []);
    } catch (err) {
      setError(err.message || 'Could not load new releases.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const loadTorrents = useCallback(async (feed = feedType, force = false, searchQ = '') => {
    if (force) setTorrentRefreshing(true);
    else setTorrentLoading(true);
    setTorrentError(null);
    try {
      const data = await api.musicWhatsNewTorrents(feed, force, searchQ);
      setTorrentReleases(Array.isArray(data?.releases) ? data.releases : []);
    } catch (err) {
      setTorrentError(err.message || 'Could not load torrent releases.');
    } finally {
      setTorrentLoading(false);
      setTorrentRefreshing(false);
    }
  }, [feedType]);

  const loadTorrentSettings = useCallback(async () => {
    try {
      const res = await api.musicTorrentSettings();
      if (res && res.success) {
        setTorrentSettings((prev) => ({ ...prev, ...res }));
      }
    } catch { /* best effort */ }
  }, []);

  useEffect(() => {
    loadTorrentSettings();
  }, [loadTorrentSettings]);

  const saveTorrentSettings = async (refreshNow = false) => {
    setSavingTorrentSettings(true);
    try {
      const res = await api.saveMusicTorrentSettings({
        intervalMinutes: torrentSettings.intervalMinutes,
        retentionMonths: torrentSettings.retentionMonths,
        refreshNow
      });
      if (res && res.success) {
        setTorrentSettings((prev) => ({ ...prev, ...res }));
      }
      notify('Settings saved', 'Music torrent feed schedule and retention updated.');
      if (refreshNow && feedType !== 'yt') {
        loadTorrents(feedType, true, query);
      }
      setSettingsModalOpen(false);
    } catch (err) {
      notify('Failed to save settings', err.message, true);
    } finally {
      setSavingTorrentSettings(false);
    }
  };

  useEffect(() => {
    if (feedType !== 'yt') {
      loadTorrents(feedType, false, query);
    }
  }, [feedType, loadTorrents]);

  useEffect(() => { load(); }, [load, libraryVersion]);

  useEffect(() => {
    setQuery(initialQuery);
    if (initialQuery) setSearched(true);
  }, [initialQuery]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Debounced search; out-of-order responses are dropped via AbortController.
  const runSearch = useCallback(async (raw) => {
    const trimmed = raw.trim();
    setQuery(raw);
    setArtist(null);

    if (feedType !== 'yt') {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setTorrentLoading(true);
      setTorrentError(null);
      try {
        const data = await api.musicWhatsNewTorrents(feedType, false, trimmed, controller.signal);
        if (controller.signal.aborted) return;
        setTorrentReleases(Array.isArray(data?.releases) ? data.releases : []);
      } catch (err) {
        if (err.name === 'AbortError' || controller.signal.aborted) return;
        setTorrentError(err.message || 'Search failed.');
      } finally {
        if (!controller.signal.aborted) setTorrentLoading(false);
      }
      return;
    }

    if (trimmed.length < 2) {
      abortRef.current?.abort();
      setSongs([]);
      setSearchArtists([]);
      setSearchAlbums([]);
      setSearched(false);
      setSearching(false);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setSearching(true);
    setSearchError(null);
    try {
      const data = await api.musicSearch(trimmed, false, controller.signal);
      if (controller.signal.aborted) return;
      setSongs(Array.isArray(data?.songs) ? data.songs : []);
      setSearchArtists(Array.isArray(data?.artists) ? data.artists : []);
      setSearchAlbums(Array.isArray(data?.albums) ? data.albums : []);
      setSearched(true);
    } catch (err) {
      if (err.name === 'AbortError' || controller.signal.aborted) return;
      setSearchError(err.message || 'Search failed.');
    } finally {
      if (!controller.signal.aborted) setSearching(false);
    }
  }, [feedType]);

  const isTorrentInLib = useCallback((rel) => {
    if (!rel?.artist || !rel?.album) return false;
    const a = rel.artist.toLowerCase().trim();
    const alb = rel.album.toLowerCase().trim();
    return libraryTracks.some((t) => {
      const ta = (t.author || t.artist || '').toLowerCase().trim();
      const talb = (t.album || '').toLowerCase().trim();
      return (ta === a || (ta && a && (ta.includes(a) || a.includes(ta)))) &&
             (talb === alb || (talb && alb && (talb.includes(alb) || alb.includes(talb))));
    });
  }, [libraryTracks]);

  const isTorrentDownloading = useCallback((rel) => {
    if (!rel) return false;
    const hash = rel.infoHash || rel.id;
    if (entityJobs[`torrent:${hash}`]) return true;
    return queue.some((j) =>
      ['queued', 'downloading', 'uploading'].includes(j.status) &&
      ((j.infoHash && rel.infoHash && j.infoHash.toLowerCase() === rel.infoHash.toLowerCase()) ||
       (j.title && rel.title && j.title.toLowerCase() === rel.title.toLowerCase()))
    );
  }, [entityJobs, queue]);

  const startTorrentDownload = useCallback(async (rel) => {
    if (!hasMusicFolder) {
      onOpenDrivePicker('music');
      return;
    }
    const hash = rel.infoHash || rel.id;
    try {
      setEntityJobs((prev) => ({ ...prev, [`torrent:${hash}`]: 'pending' }));
      const res = await api.downloadMusicTorrent(rel);
      const jId = res?.job?.id || res?.id;
      if (jId) {
        setEntityJobs((prev) => ({ ...prev, [`torrent:${hash}`]: jId }));
      }
      notify('Download started', `Queued "${rel.album || rel.title}" for download.`);
    } catch (err) {
      setEntityJobs((prev) => {
        const copy = { ...prev };
        delete copy[`torrent:${hash}`];
        return copy;
      });
      notify('Download failed', err.message || 'Could not queue torrent.', true);
    }
  }, [hasMusicFolder, onOpenDrivePicker, notify]);

  useEffect(() => {
    if (!searched && !initialQuery) return undefined;
    const timer = setTimeout(() => runSearch(query), 400);
    return () => clearTimeout(timer);
  }, [query, runSearch, searched, initialQuery]);

  const openArtist = useCallback(async (channelId, title) => {
    setArtist({ channelId, title, songs: [], albums: [] });
    try {
      const data = await api.musicArtist(channelId);
      setArtist({
        channelId,
        title: data?.artist?.title || title,
        thumbnail: data?.artist?.thumbnail,
        subscribers: data?.artist?.subscribers,
        songs: Array.isArray(data?.songs) ? data.songs : [],
        albums: Array.isArray(data?.albums) ? data.albums : []
      });
    } catch (err) {
      notify('Could not load artist', err.message, true);
    }
  }, [notify]);

  const closeArtist = useCallback(() => {
    setArtist(null);
    abortRef.current?.abort();
  }, []);

  const MUSIC_ACTIVE = ['queued', 'running'];

  const startSongDownload = useCallback(async (song) => {
    if (isSongInLib(song)) {
      notify('Already in library', song.title);
      return;
    }
    if (!hasMusicFolder) {
      notify('Pick a music folder first', 'Downloads need somewhere to land in Drive.', true);
      onOpenDrivePicker('music');
      return;
    }
    try {
      const data = await api.downloadSongs([song]);
      if (data.job?.id) setEntityJobs((prev) => ({ ...prev, [`song:${song.videoId}`]: data.job.id }));
      notify('Added to queue', song.title);
    } catch (err) {
      notify('Could not queue download', err.message, true);
    }
  }, [hasMusicFolder, notify, onOpenDrivePicker]);

  const toggleArtistFavorite = useCallback(async (name) => {
    try {
      const res = await api.setAuthorFavorite(name, !favNames.has(name), 'music');
      setFavNames(new Set(res.authorNames || []));
    } catch (err) {
      notify('Could not update favourite', err.message, true);
    }
  }, [favNames, notify]);

  const toggleAlbumFavorite = useCallback(async (album) => {
    const key = `${album.artist || 'Unknown Artist'}::${album.title || album.album}`;
    try {
      const res = await api.setAlbumFavorite(album.artist, album.title || album.album, !favAlbums.has(key));
      setFavAlbums(new Set(res.albums || []));
    } catch (err) {
      notify('Could not update favourite', err.message, true);
    }
  }, [favAlbums, notify]);

  // ---- download queue --------------------------------------------------
  const loadQueue = useCallback(async () => {
    try {
      const data = await api.musicJobs();
      setQueue(Array.isArray(data?.jobs) ? data.jobs : []);
    } catch { /* transient */ }
  }, []);

  useEffect(() => {
    loadQueue();
    const timer = setInterval(loadQueue, 8000);
    const off = subscribeToEvents({
      music_jobs: (payload) => { if (Array.isArray(payload.jobs)) setQueue(payload.jobs); else loadQueue(); },
      ytm_progress: (payload) => {
        if (!payload?.jobId) return;
        setQueue((prev) => prev.map((j) => (j.id === payload.jobId ? { ...j, ...payload } : j)));
      }
    });
    return () => { clearInterval(timer); off(); };
  }, [loadQueue]);

  const jobByKey = useCallback((key) => {
    const id = entityJobs[key];
    if (!id) return null;
    const job = queue.find((j) => j.id === id);
    // Jobs drop out of the server snapshot ten minutes after finishing; treat a
    // missing id as "no active job".
    return job && MUSIC_ACTIVE.includes(job.status) ? job : null;
  }, [entityJobs, queue]);

  // Announce completion of downloads started from this view. Statuses are diffed
  // against the previous snapshot so each job notifies exactly once.
  const lastStatusRef = useRef({});
  useEffect(() => {
    const prev = lastStatusRef.current;
    const next = {};
    for (const job of queue) {
      next[job.id] = job.status;
      if (prev[job.id] && MUSIC_ACTIVE.includes(prev[job.id]) && job.status === 'done') {
        if (job.where?.alreadyInLibrary) {
          notify('Already in library', `${job.artist ? `${job.artist} — ` : ''}${job.title}`);
        } else {
          notify('Saved to Drive', `${job.artist ? `${job.artist} — ` : ''}${job.title}${job.where?.skipped ? ` · ${job.where.skipped} skipped (already in library / unavailable)` : ''}`);
        }
        if (detail && entityJobs[`album:${detail.id}`] === job.id) {
          setDetail(null);
          setTracks([]);
        }
      } else if (prev[job.id] && MUSIC_ACTIVE.includes(prev[job.id]) && job.status === 'error') {
        notify('Download failed', job.error || 'Unknown error', true);
      }
    }
    lastStatusRef.current = next;
  }, [queue, notify, detail, entityJobs]);

  const openAlbum = useCallback(async (album) => {
    const rawArtist = album.artist || '';
    const isYear = /^\(?\b(18|19|20)\d{2}\b\)?$/.test(rawArtist.trim());
    const enrichedAlbum = {
      ...album,
      artist: (!isYear && rawArtist && rawArtist !== 'Unknown Artist')
        ? rawArtist
        : (artist?.title || rawArtist || 'Unknown Artist')
    };
    setDetail(enrichedAlbum);
    setTracks([]);
    setDetailLoading(true);
    try {
      const data = await api.albumTracks(album.playlistId || album.id);
      setTracks(Array.isArray(data?.tracks) ? data.tracks : []);
    } catch (err) {
      notify('Could not load tracks', err.message, true);
    } finally {
      setDetailLoading(false);
    }
  }, [notify, artist?.title]);

  const closeDetail = useCallback(() => {
    setDetail(null);
    setTracks([]);
    setDetailLoading(false);
  }, []);

  // Album/torrent/settings takeover view swipe back
  useSwipeBack(Boolean(detail || torrentDetail || settingsModalOpen), () => {
    if (detail) closeDetail();
    else if (torrentDetail) setTorrentDetail(null);
    else setSettingsModalOpen(false);
  });

  const startDownload = useCallback(async (album) => {
    if (tracks.length > 0 && tracks.every((t) => isSongInLib(t))) {
      notify('Already in library', `${album.artist} — ${album.title}`);
      return;
    }
    if (!hasMusicFolder) {
      notify('Pick a music folder first', 'Downloads need somewhere to land in Drive.', true);
      onOpenDrivePicker('music');
      return;
    }
    try {
      const data = await api.downloadAlbum({
        id: album.id,
        playlistId: album.playlistId,
        title: album.title,
        artist: album.artist,
        album: album.title,
        coverUrl: album.coverUrl
      });
      if (data.job?.id) setEntityJobs((prev) => ({ ...prev, [`album:${album.id}`]: data.job.id }));
      notify('Added to queue', `${album.artist} — ${album.title}`);
    } catch (err) {
      notify('Could not queue download', err.message, true);
    }
  }, [hasMusicFolder, notify, onOpenDrivePicker]);

  const lookUpPlaylist = useCallback(async () => {
    const raw = plUrl.trim();
    if (!raw) return;
    plAbortRef.current?.abort();
    const controller = new AbortController();
    plAbortRef.current = controller;
    setPlLoading(true);
    setPlError('');
    setPlInfo(null);
    try {
      const info = await api.musicPlaylistInfo(raw, false, controller.signal);
      if (controller.signal.aborted) return;
      setPlInfo(info);
      if (!plName.trim()) setPlName(info.title || '');
    } catch (err) {
      if (!controller.signal.aborted) setPlError(err.message || 'Could not read that playlist.');
    } finally {
      if (!controller.signal.aborted) setPlLoading(false);
    }
  }, [plUrl, plName]);

  const importPlaylist = useCallback(async () => {
    const raw = plUrl.trim();
    if (!raw) return;
    if (!hasMusicFolder) {
      notify('Pick a music folder first', 'Downloads need somewhere to land in Drive.', true);
      onOpenDrivePicker('music');
      return;
    }
    setPlLoading(true);
    setPlError('');
    try {
      const data = await api.downloadPlaylist({ url: raw, name: plName.trim() || undefined });
      if (data.job?.id) setEntityJobs((prev) => ({ ...prev, [`playlist:${raw}`]: data.job.id }));
      notify('Playlist queued', plName.trim() || plInfo?.title || 'YouTube playlist');
      setPlOpen(false);
      setPlInfo(null);
      setPlUrl('');
      setPlName('');
    } catch (err) {
      setPlError(err.message || 'Could not queue the playlist.');
    } finally {
      setPlLoading(false);
    }
  }, [plUrl, plName, plInfo, hasMusicFolder, notify, onOpenDrivePicker]);

  useEffect(() => () => plAbortRef.current?.abort(), []);

  const loadLiked = useCallback(async () => {
    setLikedBusy(true);
    setLikedError('');
    try {
      setLikedInfo(await api.youtubeLiked());
      setLikedLoaded(true);
    } catch (err) {
      setLikedError(err.message || 'Could not read your Liked videos.');
      setLikedLoaded(true);
    } finally {
      setLikedBusy(false);
    }
  }, []);

  const importLiked = useCallback(async () => {
    setLikedBusy(true);
    setLikedError('');
    try {
      const data = await api.importLikedMusic();
      if (data.job?.id) setEntityJobs((prev) => ({ ...prev, 'liked:import': data.job.id }));
      notify('Liked Music queued', `${likedInfo?.count ?? 'All'} tracks added to the download queue.`);
      setPlOpen(false);
    } catch (err) {
      setLikedError(err.message || 'Could not queue the import.');
    } finally {
      setLikedBusy(false);
    }
  }, [notify, likedInfo]);

  const loadYtLists = useCallback(async () => {
    try {
      setYtLists(await api.youtubePlaylists());
    } catch (err) {
      setYtError(err.message || 'Could not list your YouTube playlists.');
      setYtLists({ playlists: [], hasChannel: true });
    }
  }, []);

  const importYtPlaylist = useCallback(async (p) => {
    setYtImportBusy(p.playlistId);
    setYtError('');
    try {
      const data = await api.downloadPlaylist({ url: p.playlistId, name: p.title });
      if (data.job?.id) setEntityJobs((prev) => ({ ...prev, [`playlist:${p.playlistId}`]: data.job.id }));
      notify('Playlist queued', `${p.title} - added to the download queue.`);
    } catch (err) {
      setYtError(err.message || 'Could not queue that playlist.');
    } finally {
      setYtImportBusy('');
    }
  }, [notify]);

  useEffect(() => {
    if (!plOpen) return;
    if (!likedLoaded && !likedBusy) loadLiked();
    if (!ytLists) loadYtLists();
  }, [plOpen, likedLoaded, likedBusy, ytLists, loadLiked, loadYtLists]);

  const albumFavKey = (album) => `${album.artist || 'Unknown Artist'}::${album.title || album.album}`;

  const detailJob = detail ? jobByKey(`album:${detail.id}`) : null;
  const plJob = jobByKey(`playlist:${plUrl.trim()}`);

  const FavHeart = ({ faved, onToggle, title }) => (
    <button
      type="button"
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      style={{
        position: 'absolute',
        top: 6,
        right: 6,
        zIndex: 2,
        width: 28,
        height: 28,
        borderRadius: '50%',
        border: 'none',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.55)',
        color: faved ? 'var(--accent-color)' : '#fff'
      }}
    >
      <Heart size={14} fill={faved ? 'currentColor' : 'none'} />
    </button>
  );

  return (
    <>
      <div className="view-header">
        <div>
          <h1 className="view-title">What&apos;s New</h1>
          <p className="view-subtitle">
            {artist
              ? `Top tracks and albums from ${artist.title}`
              : feedType === 'flac'
                ? 'Lossless FLAC and Hi-Res studio releases from The Pirate Bay'
                : feedType === 'mp3'
                  ? 'Top seeded MP3 and full album collections'
                  : 'Fresh albums from YouTube Music, or search for songs and artists'}
          </p>
        </div>
        {!artist && (
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {feedType === 'yt' && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setPlOpen(true)}
              >
                <ListMusic size={14} />
                Playlist
              </button>
            )}
            {feedType !== 'yt' && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setSettingsModalOpen(true)}
                title="Configure feed check frequency and release retention"
              >
                <SettingsIcon size={14} />
                Feed Settings
              </button>
            )}
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => {
                if (feedType === 'yt') load(true);
                else loadTorrents(feedType, true, query);
              }}
              disabled={refreshing || loading || torrentLoading || torrentRefreshing}
            >
              <RefreshCw size={14} className={refreshing || torrentRefreshing ? 'spin' : undefined} />
              Refresh
            </button>
          </div>
        )}
      </div>

      {!artist && (
        <div className="stitcher-mode-tabs" style={{ marginBottom: '1.25rem', display: 'inline-flex', flexWrap: 'wrap', gap: '0.4rem' }}>
          <button
            type="button"
            className={`stitcher-mode-btn ${feedType === 'yt' ? 'active' : ''}`}
            onClick={() => { setFeedType('yt'); setQuery(''); }}
          >
            <Music4 size={14} />
            YouTube Music
          </button>
          <button
            type="button"
            className={`stitcher-mode-btn ${feedType === 'flac' ? 'active' : ''}`}
            onClick={() => { setFeedType('flac'); setQuery(''); }}
          >
            <Zap size={14} style={{ color: '#3ddc97' }} />
            Lossless (FLAC)
          </button>
          <button
            type="button"
            className={`stitcher-mode-btn ${feedType === 'mp3' ? 'active' : ''}`}
            onClick={() => { setFeedType('mp3'); setQuery(''); }}
          >
            <Disc size={14} />
            Top MP3
          </button>
        </div>
      )}

      {!artist && (
        <div className="toolbar" style={{ marginBottom: '1.5rem' }}>
          <div className="toolbar-search">
            <SearchIcon className="toolbar-search-icon" size={16} />
            <input
              type="search"
              className="input-field"
              placeholder={feedType === 'yt' ? 'Search songs, artists, albums…' : 'Search torrent releases…'}
              value={query}
              onChange={(e) => runSearch(e.target.value)}
              autoFocus={Boolean(initialQuery)}
            />
          </div>
        </div>
      )}

      {searchError && !artist && (
        <div className="error-banner">
          <AlertTriangle size={15} style={{ verticalAlign: '-2px', marginRight: '0.4rem' }} />
          {searchError}
        </div>
      )}

      {!hasMusicFolder && (
        <div className="job-card">
          <div className="job-head">
            <div>
              <div className="job-title">Connect your music folder</div>
              <div className="job-phase">Browsing works without it, but saving an album needs somewhere to land in Drive.</div>
            </div>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => onOpenDrivePicker('music')}>
              <FolderOpen size={14} />
              Choose folder
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="error-banner">
          <AlertTriangle size={15} style={{ verticalAlign: '-2px', marginRight: '0.4rem' }} />
          {error}
          <button type="button" className="btn btn-secondary btn-xs" style={{ marginLeft: '0.75rem' }} onClick={() => load(true)}>
            Retry
          </button>
        </div>
      )}

      {torrentError && !artist && feedType !== 'yt' && (
        <div className="error-banner">
          <AlertTriangle size={15} style={{ verticalAlign: '-2px', marginRight: '0.4rem' }} />
          {torrentError}
          <button type="button" className="btn btn-secondary btn-xs" style={{ marginLeft: '0.75rem' }} onClick={() => loadTorrents(feedType, true, query)}>
            Retry
          </button>
        </div>
      )}

      {feedType !== 'yt' ? (
        torrentLoading ? (
          <div className="loading-state">
            <div className="spinner" />
            <p>Loading {feedType === 'mp3' ? 'Top MP3 Releases' : 'Lossless FLAC Releases'}…</p>
          </div>
        ) : torrentReleases.length === 0 && !torrentError ? (
          <div className="empty-state">
            <Music4 size={40} style={{ color: 'var(--text-muted)', margin: '0 auto 1rem' }} />
            <p>No releases found.</p>
          </div>
        ) : (
          <>
            <div className="section-head">
              <span className="section-title">
                {feedType === 'mp3'
                  ? 'Top MP3 Releases'
                  : 'Lossless FLAC Releases'}
              </span>
              <span className="section-count">{torrentReleases.length}</span>
            </div>
            <div className="media-grid">
              {torrentReleases.map((rel) => {
                const inLib = isTorrentInLib(rel);
                const downloading = isTorrentDownloading(rel);
                return (
                  <div key={rel.id} className="media-card" onClick={() => setTorrentDetail(rel)}>
                    <div className="media-cover">
                      {rel.coverUrl ? (
                        <img src={rel.coverUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
                      ) : (
                        <div className="row-thumb-placeholder" style={{ width: '100%', height: '100%' }}>
                          <Music4 size={24} />
                        </div>
                      )}
                      <div className="media-badges">
                        <span className="badge badge-accent" style={{ fontWeight: 600 }}>{rel.format}</span>
                        {inLib && (
                          <span className="badge badge-success" style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
                            <Check size={10} /> In library
                          </span>
                        )}
                      </div>
                      <div className="media-play-overlay">
                        <div className="media-play-button" onClick={(e) => {
                          e.stopPropagation();
                          if (!inLib && !downloading) startTorrentDownload(rel);
                        }}>
                          <Download size={19} />
                        </div>
                      </div>
                    </div>
                    <div className="media-title">{rel.album || rel.title}</div>
                    <div className="media-subtitle">
                      {rel.artist}{rel.year ? ` • ${rel.year}` : ''}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '0.4rem', fontSize: '0.72rem' }}>
                      <span className="tag-bitrate">{rel.size}</span>
                      <span style={{ color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
                        <Users size={11} style={{ color: '#3ddc97' }} />
                        {rel.seeders}
                      </span>
                      <button
                        type="button"
                        className={`btn ${inLib ? 'btn-secondary' : 'btn-primary'} btn-xs`}
                        style={{ padding: '2px 8px', fontSize: '0.72rem' }}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!inLib && !downloading) startTorrentDownload(rel);
                        }}
                        disabled={downloading || inLib}
                      >
                        {downloading ? (
                          <Loader2 size={11} className="spin" />
                        ) : inLib ? (
                          <Check size={11} />
                        ) : (
                          <Download size={11} />
                        )}
                        {downloading ? 'Queued' : inLib ? 'Saved' : 'Get'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )
      ) : artist ? (
        <>
          <div className="section-head">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={closeArtist}
              style={{ marginBottom: '0.5rem' }}
            >
              <X size={14} />
              Back to results
            </button>
            <button
              type="button"
              className={`btn btn-sm ${favNames.has(artist.title) ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => toggleArtistFavorite(artist.title)}
              style={{ marginBottom: '0.5rem', marginLeft: '0.5rem' }}
            >
              <Heart size={13} fill={favNames.has(artist.title) ? 'currentColor' : 'none'} />
              {favNames.has(artist.title) ? 'Favourited' : 'Favourite artist'}
            </button>
          </div>

          {artist.songs.length > 0 && (
            <>
              <div className="section-head">
                <span className="section-title">Songs</span>
                <span className="section-count">{artist.songs.length}</span>
              </div>
              <div className="track-list">
                {artist.songs.map((song) => (
                  <div key={song.videoId} className="track-row">
                    <span className="track-title">{stripTrackNumber(song.title)}</span>
                    <span className="track-duration">
                      {song.durationSec ? formatLengthShort(song.durationSec) : '--:--'}
                    </span>
                    {isSongInLib(song) ? (
                      <button
                        type="button"
                        className="btn btn-secondary btn-xs"
                        disabled
                        title="Already in your library"
                        style={{ opacity: 0.9, color: 'var(--accent-color)', borderColor: 'var(--accent-border)' }}
                      >
                        <Check size={13} />
                        In library
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-secondary btn-xs"
                        onClick={() => startSongDownload(song)}
                        disabled={Boolean(jobByKey(`song:${song.videoId}`))}
                        title={jobByKey(`song:${song.videoId}`) ? 'In the download queue' : 'Save this song to Drive'}
                      >
                        <Download size={13} />
                        {jobByKey(`song:${song.videoId}`) ? 'Queued' : 'Save'}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="section-head">
            <span className="section-title">Albums &amp; singles</span>
            <span className="section-count">{artist.albums.length}</span>
          </div>
          {artist.albums.length === 0 ? (
            <div className="empty-state">
              <User size={36} style={{ color: 'var(--text-muted)', margin: '0 auto 1rem' }} />
              <p>No albums listed for this artist.</p>
            </div>
          ) : (
            <div className="media-grid">
              {artist.albums.map((album) => (
                <div key={album.id} className="media-card" onClick={() => openAlbum(album)}>
                  <div className="media-cover">
                    {album.coverUrl
                      ? <img src={album.coverUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
                      : <div className="row-thumb-placeholder" style={{ width: '100%', height: '100%' }}>
                          <Music4 size={22} />
                        </div>}
                    {isAlbumInLib(album) && (
                      <div className="media-badges">
                        <span className="badge badge-success" style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
                          <Check size={10} /> In library
                        </span>
                      </div>
                    )}
                    <FavHeart
                      faved={favAlbums.has(albumFavKey(album))}
                      onToggle={() => toggleAlbumFavorite(album)}
                      title={favAlbums.has(albumFavKey(album)) ? 'Remove from favourites' : 'Favourite album'}
                    />
                    <div className="media-play-overlay">
                      <div className="media-play-button">
                        <Download size={19} />
                      </div>
                    </div>
                  </div>
                  <div className="media-title">{album.title}</div>
                  <div className="media-subtitle">
                    {album.artist && !/^\(?\b(18|19|20)\d{2}\b\)?$/.test(album.artist.trim())
                      ? `${album.artist}${album.year ? ` • ${album.year}` : ''}`
                      : (album.year ? `${artist?.title || 'Album'} • ${album.year}` : (artist?.title || 'Album'))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      ) : searching && !searched ? (
        <div className="loading-state">
          <div className="spinner" />
          <p>Searching YouTube Music…</p>
        </div>
      ) : searched ? (
        <>
          {searchArtists.length > 0 && (
            <>
              <div className="section-head">
                <span className="section-title">Artists</span>
                <span className="section-count">{searchArtists.length}</span>
              </div>
              <div className="media-grid">
                {searchArtists.map((row) => (
                  <div key={row.channelId} className="media-card" onClick={() => openArtist(row.channelId, row.title)}>
                    <div className="media-cover">
                      {row.thumbnail
                        ? <img src={row.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" />
                        : <div className="row-thumb-placeholder" style={{ width: '100%', height: '100%' }}>
                            <User size={22} />
                          </div>}
                      <div className="media-play-overlay">
                        <div className="media-play-button">
                          <User size={19} />
                        </div>
                      </div>
                    </div>
                    <div className="media-title">{row.title}</div>
                    <div className="media-subtitle">{row.subscribers || 'Artist'}</div>
                  </div>
                ))}
              </div>
            </>
          )}

          {searchAlbums.length > 0 && (
            <>
              <div className="section-head">
                <span className="section-title">Albums</span>
                <span className="section-count">{searchAlbums.length}</span>
              </div>
              <div className="media-grid">
                {searchAlbums.map((album) => (
                  <div key={album.id} className="media-card" onClick={() => openAlbum(album)}>
                    <div className="media-cover">
                      {album.coverUrl
                        ? <img src={album.coverUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
                        : <div className="row-thumb-placeholder" style={{ width: '100%', height: '100%' }}>
                            <Music4 size={22} />
                          </div>}
                      {isAlbumInLib(album) && (
                        <div className="media-badges">
                          <span className="badge badge-success" style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
                            <Check size={10} /> In library
                          </span>
                        </div>
                      )}
                      <FavHeart
                        faved={favAlbums.has(albumFavKey(album))}
                        onToggle={() => toggleAlbumFavorite(album)}
                        title={favAlbums.has(albumFavKey(album)) ? 'Remove from favourites' : 'Favourite album'}
                      />
                      <div className="media-play-overlay">
                        <div className="media-play-button">
                          <Download size={19} />
                        </div>
                      </div>
                    </div>
                    <div className="media-title">{album.title}</div>
                    <div className="media-subtitle">
                      {album.artist && !/^\(?\b(18|19|20)\d{2}\b\)?$/.test(album.artist.trim())
                        ? `${album.artist}${album.year ? ` • ${album.year}` : ''}`
                        : (album.year || 'Album')}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {songs.length > 0 && (
            <>
              <div className="section-head">
                <span className="section-title">Songs</span>
                <span className="section-count">{songs.length}</span>
              </div>
              <div className="track-list">
                {songs.map((song) => (
                  <div key={song.videoId} className="track-row">
                    <span className="track-title">{stripTrackNumber(song.title)}</span>
                    <span className="track-duration">
                      {song.durationSec ? formatLengthShort(song.durationSec) : '--:--'}
                    </span>
                    {isSongInLib(song) ? (
                      <button
                        type="button"
                        className="btn btn-secondary btn-xs"
                        disabled
                        title="Already in your library"
                        style={{ opacity: 0.9, color: 'var(--accent-color)', borderColor: 'var(--accent-border)' }}
                      >
                        <Check size={13} />
                        In library
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-secondary btn-xs"
                        onClick={() => startSongDownload(song)}
                        disabled={Boolean(jobByKey(`song:${song.videoId}`))}
                        title={jobByKey(`song:${song.videoId}`) ? 'In the download queue' : 'Save this song to Drive'}
                      >
                        <Download size={13} />
                        {jobByKey(`song:${song.videoId}`) ? 'Queued' : 'Save'}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}

          {songs.length === 0 && searchArtists.length === 0 && searchAlbums.length === 0 && !searching && (
            <div className="empty-state">
              <Music4 size={40} style={{ color: 'var(--text-muted)', margin: '0 auto 1rem' }} />
              <h3>No matches for &ldquo;{query.trim()}&rdquo;</h3>
              <p>Try fewer words, or check the spelling of the song, artist, or album.</p>
            </div>
          )}
        </>
      ) : loading ? (
        <div className="loading-state">
          <div className="spinner" />
          <p>Loading new releases…</p>
        </div>
      ) : albums.length === 0 && !error ? (
        <div className="empty-state">
          <Music4 size={40} style={{ color: 'var(--text-muted)', margin: '0 auto 1rem' }} />
          <p>No new releases right now.</p>
        </div>
      ) : (
        <>
          <div className="section-head">
            <span className="section-title">New releases</span>
            <span className="section-count">{albums.length}</span>
          </div>
          <div className="media-grid">
            {albums.map((album) => (
              <div key={album.id} className="media-card" onClick={() => openAlbum(album)}>
                <div className="media-cover">
                  {album.coverUrl
                    ? <img src={album.coverUrl} alt="" loading="lazy" />
                    : <div className="row-thumb-placeholder" style={{ width: '100%', height: '100%' }}>
                        <Music4 size={22} />
                      </div>}
                  {isAlbumInLib(album) && (
                    <div className="media-badges">
                      <span className="badge badge-success" style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
                        <Check size={10} /> In library
                      </span>
                    </div>
                  )}
                  <FavHeart
                    faved={favAlbums.has(albumFavKey(album))}
                    onToggle={() => toggleAlbumFavorite(album)}
                    title={favAlbums.has(albumFavKey(album)) ? 'Remove from favourites' : 'Favourite album'}
                  />
                  <div className="media-play-overlay">
                    <div className="media-play-button">
                      <Download size={19} />
                    </div>
                  </div>
                </div>
                <div className="media-title">{album.title}</div>
                <div className="media-subtitle">
                  {album.artist && !/^\(?\b(18|19|20)\d{2}\b\)?$/.test(album.artist.trim())
                    ? `${album.artist}${album.year ? ` • ${album.year}` : ''}`
                    : (album.year || 'Album')}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {detail && (
        <div className="modal-backdrop" onClick={closeDetail}>
          <div className="modal-container" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', minWidth: 0 }}>
                {detail.coverUrl && (
                  <img
                    src={detail.coverUrl}
                    alt=""
                    style={{ width: 48, height: 48, borderRadius: 6, objectFit: 'cover', flexShrink: 0 }}
                  />
                )}
                <div style={{ minWidth: 0 }}>
                  <h2 style={{ margin: 0 }}>{detail.title}</h2>
                  <div className="media-subtitle">
                    {detail.artist && !/^\(?\b(18|19|20)\d{2}\b\)?$/.test(detail.artist.trim())
                      ? `${detail.artist}${detail.year ? ` • ${detail.year}` : ''}`
                      : (detail.year || 'Album')}
                  </div>
                </div>
                <button
                  type="button"
                  className={`btn btn-sm ${favAlbums.has(albumFavKey(detail)) ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => toggleAlbumFavorite(detail)}
                  title={favAlbums.has(albumFavKey(detail)) ? 'Remove from favourites' : 'Favourite album'}
                >
                  <Heart size={13} fill={favAlbums.has(albumFavKey(detail)) ? 'currentColor' : 'none'} />
                  {favAlbums.has(albumFavKey(detail)) ? 'Favourited' : 'Favourite'}
                </button>
              </div>
              <button type="button" className="modal-close-btn" onClick={closeDetail} aria-label="Close">✕</button>
            </div>

            <div className="modal-body">
              {detailLoading ? (
                <div className="loading-state">
                  <div className="spinner" />
                  <p>Loading tracks…</p>
                </div>
              ) : tracks.length === 0 ? (
                <div className="drive-empty-state">
                  <p>No tracks could be listed for this album.</p>
                </div>
              ) : (
                <div className="track-list">
                  {tracks.map((track) => (
                    <div key={track.videoId} className="track-row">
                      <span className="track-title" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
                        {stripTrackNumber(track.title)}
                        {isSongInLib(track) && (
                          <span className="badge badge-success" style={{ fontSize: '0.68rem', padding: '1px 6px', display: 'inline-flex', alignItems: 'center', gap: '2px' }}>
                            <Check size={10} /> In library
                          </span>
                        )}
                      </span>
                      <span className="track-duration" style={{marginLeft: '0.4rem'}}>
                        {track.durationSec ? formatDuration(track.durationSec) : '--:--'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={closeDetail}>Close</button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => startDownload(detail)}
                disabled={Boolean(detailJob) || tracks.length === 0 || !hasMusicFolder || (tracks.length > 0 && tracks.every((t) => isSongInLib(t)))}
              >
                {hasMusicFolder ? <Check size={15} /> : <FolderOpen size={15} />}
                {detailJob
                  ? (detailJob.status === 'running'
                    ? `${detailJob.phase || 'Downloading'} ${Math.round(detailJob.percent || 0)}%`
                    : `Queued ( ${detailJob.position || '?'})`)
                  : (tracks.length > 0 && tracks.every((t) => isSongInLib(t)))
                    ? 'Album in library'
                    : tracks.filter((t) => !isSongInLib(t)).length < tracks.length
                      ? `Save album`
                      : `Save album`}
              </button>
            </div>
          </div>
        </div>
      )}

      {torrentDetail && (
        <div className="modal-backdrop" onClick={() => setTorrentDetail(null)}>
          <div className="modal-container" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', minWidth: 0 }}>
                {torrentDetail.coverUrl ? (
                  <img
                    src={torrentDetail.coverUrl}
                    alt=""
                    style={{ width: 52, height: 52, borderRadius: 6, objectFit: 'cover', flexShrink: 0 }}
                  />
                ) : (
                  <div className="row-thumb-placeholder" style={{ width: 52, height: 52, borderRadius: 6, flexShrink: 0 }}>
                    <Music4 size={24} />
                  </div>
                )}
                <div style={{ minWidth: 0 }}>
                  <h2 style={{ margin: 0, fontSize: '1.1rem' }}>{torrentDetail.album || torrentDetail.title}</h2>
                  <div className="media-subtitle" style={{ marginTop: '0.2rem' }}>
                    {torrentDetail.artist}{torrentDetail.year ? ` • ${torrentDetail.year}` : ''}
                  </div>
                </div>
              </div>
              <button type="button" className="modal-close-btn" onClick={() => setTorrentDetail(null)} aria-label="Close">✕</button>
            </div>

            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                <span className="badge badge-accent" style={{ fontWeight: 600 }}>{torrentDetail.format}</span>
                <span className="tag-bitrate">{torrentDetail.size}</span>
                <span className="badge" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                  <Users size={12} style={{ color: '#3ddc97' }} /> {torrentDetail.seeders} seeds ({torrentDetail.leechers} leechers)
                </span>
                <span className="badge">The Pirate Bay</span>
              </div>

              <div style={{ background: 'rgba(255,255,255,0.03)', padding: '0.75rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)' }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>Release Title</div>
                <div style={{ fontSize: '0.85rem', wordBreak: 'break-all' }}>{torrentDetail.title}</div>
              </div>

              {torrentDetail.infoHash && (
                <div style={{ background: 'rgba(255,255,255,0.03)', padding: '0.75rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)' }}>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>Torrent Info Hash</div>
                  <code style={{ fontSize: '0.75rem', color: 'var(--accent-color)' }}>{torrentDetail.infoHash}</code>
                </div>
              )}

              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                Files download directly to your Google Drive music library:
                <div style={{ color: 'var(--text-primary)', fontWeight: 500, marginTop: '0.2rem' }}>
                  Music / {torrentDetail.artist} / {torrentDetail.album || 'Singles'}
                </div>
              </div>
            </div>

            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={() => setTorrentDetail(null)}>Close</button>
              {isTorrentInLib(torrentDetail) ? (
                <button type="button" className="btn btn-secondary" disabled>
                  <Check size={14} /> In Library
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    startTorrentDownload(torrentDetail);
                    setTorrentDetail(null);
                  }}
                  disabled={isTorrentDownloading(torrentDetail)}
                >
                  <Download size={14} />
                  {isTorrentDownloading(torrentDetail) ? 'Queued / Downloading' : 'Download to Drive'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {settingsModalOpen && (
        <div className="modal-backdrop" onClick={() => setSettingsModalOpen(false)}>
          <div className="modal-container" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <SettingsIcon size={18} style={{ color: 'var(--accent-color)' }} />
                <h2 style={{ margin: 0, fontSize: '1.1rem' }}>Feed &amp; Retention Settings</h2>
              </div>
              <button type="button" className="modal-close-btn" onClick={() => setSettingsModalOpen(false)} aria-label="Close">✕</button>
            </div>

            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '1.1rem' }}>
              <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)', lineHeight: '1.4' }}>
                Configure background check frequency and release retention. Releases are accumulated across overnight background checks and stored locally in disk cache.
              </div>

              <div style={{ background: 'rgba(255,255,255,0.03)', padding: '0.8rem 1rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                <div style={{ fontSize: '0.8rem', display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Cached Releases:</span>
                  <strong style={{ color: 'var(--text-primary)' }}>
                    {torrentSettings.countFlac || 0} FLAC &bull; {torrentSettings.countMp3 || 0} MP3
                  </strong>
                </div>
                <div style={{ fontSize: '0.76rem', display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Last Background Sweep:</span>
                  <span>{torrentSettings.lastSwept ? new Date(torrentSettings.lastSwept).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Pending'}</span>
                </div>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '0.4rem' }}>
                  Feed Check Frequency
                </label>
                <select
                  value={torrentSettings.intervalMinutes || 30}
                  onChange={(e) => setTorrentSettings((prev) => ({ ...prev, intervalMinutes: parseInt(e.target.value, 10) }))}
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    fontSize: '0.85rem',
                    borderRadius: 'var(--radius-sm)',
                    background: 'rgba(0,0,0,0.4)',
                    border: '1px solid var(--border-color)',
                    color: 'var(--text-primary)'
                  }}
                >
                  <option value="15">Every 15 minutes</option>
                  <option value="30">Every 30 minutes (Default - Recommended)</option>
                  <option value="60">Every 1 hour</option>
                  <option value="120">Every 2 hours</option>
                  <option value="360">Every 6 hours</option>
                  <option value="720">Every 12 hours</option>
                  <option value="1440">Every 24 hours</option>
                </select>
                <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
                  How often the background worker sweeps for new music releases.
                </div>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '0.4rem' }}>
                  Release Retention Period
                </label>
                <select
                  value={torrentSettings.retentionMonths || 3}
                  onChange={(e) => setTorrentSettings((prev) => ({ ...prev, retentionMonths: parseInt(e.target.value, 10) }))}
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    fontSize: '0.85rem',
                    borderRadius: 'var(--radius-sm)',
                    background: 'rgba(0,0,0,0.4)',
                    border: '1px solid var(--border-color)',
                    color: 'var(--text-primary)'
                  }}
                >
                  <option value="1">1 Month</option>
                  <option value="2">2 Months</option>
                  <option value="3">3 Months (Default - Recommended)</option>
                  <option value="6">6 Months</option>
                  <option value="12">12 Months (1 Year)</option>
                </select>
                <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
                  Releases are accumulated across refreshes and retained up to this cutoff.
                </div>
              </div>
            </div>

            <div className="modal-footer" style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-secondary" onClick={() => setSettingsModalOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => saveTorrentSettings(true)}
                disabled={savingTorrentSettings}
                title="Save settings and sweep feeds immediately"
              >
                {savingTorrentSettings ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
                Save &amp; Sweep Now
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => saveTorrentSettings(false)}
                disabled={savingTorrentSettings}
              >
                {savingTorrentSettings ? <Loader2 size={13} className="spin" /> : null}
                Save Settings
              </button>
            </div>
          </div>
        </div>
      )}

      {plOpen && (
        <div className="modal-backdrop" onClick={() => setPlOpen(false)}>
          <div className="modal-container" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 style={{ margin: 0 }}>Import a YouTube Music playlist</h2>
              <button type="button" className="modal-close-btn" onClick={() => setPlOpen(false)} aria-label="Close">✕</button>
            </div>

<div className="modal-body">
                <div className="section-head" style={{ marginTop: 0 }}>
                  <span className="section-title">Liked Music</span>
                  {likedInfo && <span className="section-count">{likedInfo.count} tracks</span>}
                </div>
                <p style={{ marginTop: '0.25rem', color: 'var(--text-muted)' }}>
                  Import every hearted song through your existing Google sign-in - no cookies
                  needed. Tracks land in Drive and in a FRAUDIO playlist called "Liked Music".
                </p>
                {likedError && (
                  <div className="error-banner" style={{ marginBottom: '0.75rem' }}>
                    <AlertTriangle size={15} style={{ verticalAlign: '-2px', marginRight: '0.4rem' }} />
                    {likedError}
                  </div>
                )}
                <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.25rem' }}>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={loadLiked} disabled={likedBusy}>
                    <RefreshCw size={13} className={likedBusy && !likedInfo ? 'spin' : undefined} />
                    {likedBusy ? 'Checking…' : likedError ? 'Retry' : 'Refresh'}
                  </button>
                  {likedInfo && (
                    <button type="button" className="btn btn-primary btn-sm" onClick={importLiked} disabled={likedBusy}>
                      <Download size={13} />
                      Import {likedInfo.count} liked track{likedInfo.count === 1 ? '' : 's'}
                      {likedInfo.total > likedInfo.count ? ` (of ${likedInfo.total})` : ''}
                    </button>
                  )}
                </div>

                {ytLists && ytLists.playlists.length > 0 && (
                  <>
                    <div className="section-head">
                      <span className="section-title">Your YouTube playlists</span>
                      <span className="section-count">{ytLists.playlists.length}</span>
                    </div>
                    {ytError && (
                      <div className="error-banner" style={{ marginBottom: '0.75rem' }}>
                        <AlertTriangle size={15} style={{ verticalAlign: '-2px', marginRight: '0.4rem' }} />
                        {ytError}
                      </div>
                    )}
                    <div className="row-list" style={{ maxHeight: 260, overflowY: 'auto', marginBottom: '1.25rem' }}>
                      {ytLists.playlists.map((p) => {
                        const rowJob = jobByKey(`playlist:${p.playlistId}`);
                        return (
                          <div key={p.playlistId} className="row-item">
                            {p.thumbnail
                              ? <img className="row-thumb" src={p.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" />
                              : <div className="row-thumb-placeholder"><ListMusic size={16} /></div>}
                            <div className="row-meta">
                              <div className="row-title">{p.title}</div>
                              <div className="row-subtitle">
                                {p.item_count != null ? `${p.item_count} tracks` : 'Playlist'}
                                {p.imported ? ' · in your library' : ''}
                              </div>
                            </div>
                            <div className="row-aside">
                              <button
                                type="button"
                                className={`btn btn-sm ${p.imported ? 'btn-secondary' : 'btn-primary'}`}
                                onClick={() => importYtPlaylist(p)}
                                disabled={Boolean(rowJob) || ytImportBusy === p.playlistId || !hasMusicFolder}
                                title={hasMusicFolder
                                  ? (p.imported ? 'Re-check and add any new songs' : 'Download every track into a FRAUDIO playlist')
                                  : 'Pick a music folder first'}
                              >
                                {rowJob
                                  ? <><Loader2 size={13} className="spin" /> Queued</>
                                  : <><Download size={13} /> {p.imported ? 'Update' : 'Import'}</>}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}

                {ytLists && ytLists.hasChannel === false && (
                  <p style={{ color: 'var(--text-muted)', fontSize: '0.78rem', marginTop: 0, marginBottom: '1rem' }}>
                    YouTube reports no channel for this account, so created playlists can't be
                    listed yet - the Liked Music import above works regardless.
                  </p>
                )}

                <div className="library-divider" style={{ borderTop: '1px solid var(--border-color)', margin: '0 0 1.25rem' }} />

                <p style={{ marginTop: 0, color: 'var(--text-muted)' }}>
                  Or paste a playlist URL from music.youtube.com (or just its list id). Every track is
                  saved to Drive and added to a FRAUDIO playlist of the same name. For private lists
                  like Liked Music (<code>list=LM</code>) this route needs cookies from Settings →
                  YouTube Music.
                </p>
              <div className="form-field" style={{ marginBottom: '0.75rem' }}>
                <label className="form-label" htmlFor="pl-url">Playlist URL</label>
                <input
                  id="pl-url"
                  className="input-field"
                  type="url"
                  placeholder="https://music.youtube.com/playlist?list=…"
                  value={plUrl}
                  onChange={(e) => { setPlUrl(e.target.value); setPlInfo(null); setPlError(''); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); lookUpPlaylist(); } }}
                  autoFocus
                />
              </div>
              {plInfo && (
                <div className="form-field" style={{ marginBottom: '0.75rem' }}>
                  <label className="form-label" htmlFor="pl-name">Playlist name</label>
                  <input
                    id="pl-name"
                    className="input-field"
                    value={plName}
                    onChange={(e) => setPlName(e.target.value)}
                    placeholder={plInfo.title}
                  />
                </div>
              )}
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={lookUpPlaylist}
                disabled={plLoading || !plUrl.trim()}
              >
                <SearchIcon size={13} />
                {plLoading ? 'Reading…' : 'Look up'}
              </button>
              {plInfo && (
                <div style={{ marginTop: '1rem' }}>
                  <div className="row-title">{plInfo.title}</div>
                  <div className="row-subtitle">
                    {plInfo.uploader ? `${plInfo.uploader} · ` : ''}{plInfo.count} tracks
                    {plInfo.truncated ? ` · importing first ${plInfo.tracks.length}` : ''}
                  </div>
                  <div className="track-list" style={{ marginTop: '0.5rem', maxHeight: 220, overflowY: 'auto' }}>
                    {plInfo.tracks.slice(0, 12).map((t) => (
                      <div key={t.videoId} className="track-row">
                        <span className="track-title">{stripTrackNumber(t.title)}</span>
                        <span className="track-duration">
                          {t.durationSec ? formatLengthShort(t.durationSec) : '--:--'}
                        </span>
                      </div>
                    ))}
                    {plInfo.count > 12 && (
                      <div className="row-subtitle" style={{ padding: '0.4rem 0' }}>
                        …and {plInfo.count - 12} more
                      </div>
                    )}
                  </div>
                </div>
              )}
              {plError && (
                <div className="error-banner" style={{ marginTop: '0.75rem' }}>
                  <AlertTriangle size={15} style={{ verticalAlign: '-2px', marginRight: '0.4rem' }} />
                  {plError}
                </div>
              )}
            </div>

            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={() => setPlOpen(false)}>Cancel</button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={importPlaylist}
                disabled={plLoading || !plUrl.trim() || Boolean(plJob) || !hasMusicFolder}
                title={hasMusicFolder ? undefined : 'Pick a music folder first'}
              >
                {hasMusicFolder ? <Download size={15} /> : <FolderOpen size={15} />}
                {plJob
                  ? (plJob.status === 'running'
                    ? `${plJob.phase || 'Downloading'} ${Math.round(plJob.percent || 0)}%`
                    : `Queued (position ${plJob.position || '?'})`)
                  : `Download all (${plInfo ? plInfo.tracks.length : 'all'})`}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
