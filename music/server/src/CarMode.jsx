import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  RotateCcw,
  RotateCw,
  X,
  Gauge,
  BookOpen,
  Music,
  ListMusic,
  Loader2,
  Search,
  Shuffle,
  WifiOff,
  Zap
} from 'lucide-react';
import { api } from './api';
import { formatDuration } from './format';
import { useSwipeBack } from './swipeBack';
import { getOfflineStats } from './offlineStorage';

const RATES = [1, 1.25, 1.5, 1.75, 2];

function shuffleInto(items) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function CarListRow({ emoji, coverUrl, title, subtitle, onPlay }) {
  return (
    <div className="car-row" onClick={onPlay}>
      <div className="car-row-thumb">
        {coverUrl ? (
          <img src={coverUrl} alt="" loading="lazy" />
        ) : (
          <span>{emoji}</span>
        )}
      </div>
      <div className="car-row-meta">
        <div className="car-row-title">{title}</div>
        <div className="car-row-subtitle">{subtitle}</div>
      </div>
      <button type="button" className="car-row-play" aria-label={`Play ${title}`}>
        <Play size={20} fill="currentColor" style={{ marginLeft: 2 }} />
      </button>
    </div>
  );
}

export default function CarMode({
  activeItem,
  playing,
  position,
  duration,
  onTogglePlay,
  onSeekBy,
  onSeekTo,
  onNext,
  onPrev,
  hasNext,
  hasPrev,
  rateIndex = 0,
  onCycleRate,
  onPlayItem,
  onClose,
  notify
}) {
  const [activeTab, setActiveTab] = useState('player'); // 'player' | 'audiobooks' | 'music' | 'playlists' | 'offline'
  const [audiobooks, setAudiobooks] = useState([]);
  const [musicTracks, setMusicTracks] = useState([]);
  const [playlists, setPlaylists] = useState([]);
  const [playlistTracks, setPlaylistTracks] = useState({});
  const [startingId, setStartingId] = useState(null);
  const [offlineStats, setOfflineStats] = useState(null);
  const [loadingList, setLoadingList] = useState(false);
  const [scrubValue, setScrubValue] = useState(null);
  const [query, setQuery] = useState('');

  // Search filters the already-loaded library so it works instantly and
  // offline (important while driving), instead of hitting the network.
  const search = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const match = (...fields) => fields.some((f) => (f || '').toLowerCase().includes(q));
    return {
      books: audiobooks.filter((b) => match(b.title, b.author, b.series, b.narrator)).slice(0, 60),
      tracks: musicTracks.filter((t) => match(t.title, t.artist, t.album)).slice(0, 60)
    };
  }, [query, audiobooks, musicTracks]);

  const searching = Boolean(search);

  const selectTab = (id) => {
    setQuery('');
    setActiveTab(id);
  };

  // Screen WakeLock API: keep car screen awake while in Car Mode
  const wakeLockRef = useRef(null);

  // Right-edge swipe exits Car Mode like the close button.
  useSwipeBack(true, onClose);

  useEffect(() => {
    let released = false;
    const requestWakeLock = async () => {
      try {
        if ('wakeLock' in navigator && !released) {
          wakeLockRef.current = await navigator.wakeLock.request('screen');
        }
      } catch {
        /* WakeLock optional */
      }
    };

    requestWakeLock();

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        requestWakeLock();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      released = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (wakeLockRef.current) {
        wakeLockRef.current.release().catch(() => {});
        wakeLockRef.current = null;
      }
    };
  }, []);

  // Pre-load library items for instant car-friendly access
  const loadMedia = useCallback(async () => {
    setLoadingList(true);
    try {
      const [booksRes, musicRes, plRes, offStats] = await Promise.all([
        api.library('audiobooks').catch(() => ({ items: [] })),
        api.library('music').catch(() => ({ items: [] })),
        api.playlists('music').catch(() => []),
        getOfflineStats().catch(() => null)
      ]);

      setAudiobooks(Array.isArray(booksRes?.items) ? booksRes.items : []);
      setMusicTracks(Array.isArray(musicRes?.items) ? musicRes.items : []);
      setOfflineStats(offStats);

      // Prefetch every playlist's tracks so a tap can start playback
      // synchronously (autoplay grants only live inside the gesture window).
      const plList = Array.isArray(plRes) ? plRes : [];
      setPlaylists(plList);
      setPlaylistTracks({});
      Promise.all(
        plList.map((pl) =>
          api
            .playlist(pl.id)
            .then((full) => [pl.id, Array.isArray(full?.items) ? full.items : []])
            .catch(() => [pl.id, null])
        )
      ).then((entries) => {
        const map = {};
        for (const [id, items] of entries) {
          if (items) map[id] = items;
        }
        setPlaylistTracks(map);
      });
    } catch {
      /* offline or network error */
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    loadMedia();
  }, [loadMedia]);

  const [localPlaying, setLocalPlaying] = useState(playing);
  const [localPosition, setLocalPosition] = useState(position);
  const [localDuration, setLocalDuration] = useState(duration);
  const [localRateIndex, setLocalRateIndex] = useState(rateIndex);

  useEffect(() => {
    const handleState = (e) => {
      if (e.detail) {
        if (e.detail.playing !== undefined) setLocalPlaying(e.detail.playing);
        if (e.detail.position !== undefined) setLocalPosition(e.detail.position);
        if (e.detail.duration !== undefined) setLocalDuration(e.detail.duration);
        if (e.detail.rateIndex !== undefined) setLocalRateIndex(e.detail.rateIndex);
      }
    };
    window.addEventListener('fraudio:player-state', handleState);
    return () => window.removeEventListener('fraudio:player-state', handleState);
  }, []);

  const handleTogglePlay = () => {
    if (onTogglePlay) onTogglePlay();
    else window.dispatchEvent(new CustomEvent('fraudio:car-toggle-play'));
  };

  const handleSeekBy = (delta) => {
    if (onSeekBy) onSeekBy(delta);
    else window.dispatchEvent(new CustomEvent('fraudio:car-seek-by', { detail: delta }));
  };

  const handleSeekTo = (pos) => {
    if (onSeekTo) onSeekTo(pos);
    else window.dispatchEvent(new CustomEvent('fraudio:car-seek-to', { detail: pos }));
  };

  const handleCycleRate = () => {
    if (onCycleRate) onCycleRate();
    else window.dispatchEvent(new CustomEvent('fraudio:car-cycle-rate'));
  };

  const effectiveDuration = localDuration || duration || activeItem?.durationSec || 0;
  const currentPos = scrubValue !== null ? scrubValue : (localPosition ?? position);

  const handleCommitScrub = (val) => {
    setScrubValue(null);
    handleSeekTo(val);
  };

  const coverUrl = activeItem?.coverUrl || (activeItem ? api.coverUrl(activeItem.id) : null);
  const openWithPlayer = (item, context) => {
    onPlayItem(item, context);
    setActiveTab('player');
  };

  const playFromItems = (playlist, items, shuffle) => {
    if (!Array.isArray(items) || !items.length) {
      notify?.('Playlist is empty', `Add tracks to "${playlist.name}" first.`);
      return;
    }
    const queue = shuffle ? shuffleInto(items) : items;
    onPlayItem(queue[0], queue, { shuffle: Boolean(shuffle) });
    setActiveTab('player');
  };

  // Taps play straight from the prefetched cache: play() stays inside the
  // click handler, so the browser's autoplay grace period still applies and
  // the queue starts without pressing play again.
  const startPlaylist = (playlist, shuffle) => {
    const cached = playlistTracks[playlist.id];
    if (cached) {
      playFromItems(playlist, cached, shuffle);
      return;
    }
    if (startingId) return;
    setStartingId(playlist.id);
    api.playlist(playlist.id)
      .then((full) => {
        const items = Array.isArray(full?.items) ? full.items : [];
        setPlaylistTracks((prev) => ({ ...prev, [playlist.id]: items }));
        playFromItems(playlist, items, shuffle);
      })
      .catch((err) => {
        notify?.('Could not load playlist', err.message || 'Unknown error', true);
      })
      .finally(() => setStartingId(null));
  };

  const shuffleAllMusic = () => {
    if (musicTracks.length < 2) return;
    const queue = shuffleInto(musicTracks);
    onPlayItem(queue[0], queue, { shuffle: true });
    setActiveTab('player');
  };

  return (
    <div className="car-shell">
      {/* Left rail in landscape; top bar in portrait */}
      <nav className="car-rail" aria-label="Car Mode menu">
        <div className="car-rail-brand">
          <span>CAR MODE</span>
          {typeof navigator !== 'undefined' && !navigator.onLine && (
            <span className="car-offline-badge">
              <WifiOff size={13} />
              Offline
            </span>
          )}
        </div>

        <div className="car-rail-tabs">
          <button
            type="button"
            className={`car-rail-btn ${activeTab === 'player' ? 'active' : ''}`}
            onClick={() => selectTab('player')}
          >
            <Play size={17} fill={activeTab === 'player' ? 'currentColor' : 'none'} />
            <span>Now Playing</span>
          </button>
          <button
            type="button"
            className={`car-rail-btn ${activeTab === 'audiobooks' ? 'active' : ''}`}
            onClick={() => selectTab('audiobooks')}
          >
            <BookOpen size={17} />
            <span>Audiobooks</span>
          </button>
          <button
            type="button"
            className={`car-rail-btn ${activeTab === 'music' ? 'active' : ''}`}
            onClick={() => selectTab('music')}
          >
            <Music size={17} />
            <span>Music</span>
          </button>
          <button
            type="button"
            className={`car-rail-btn ${activeTab === 'playlists' ? 'active' : ''}`}
            onClick={() => selectTab('playlists')}
          >
            <ListMusic size={17} />
            <span>Playlists</span>
          </button>
          <button
            type="button"
            className={`car-rail-btn ${activeTab === 'offline' ? 'active' : ''}`}
            onClick={() => selectTab('offline')}
          >
            <Zap size={17} />
            <span>Offline</span>
          </button>
        </div>

        <button type="button" className="car-rail-close" onClick={onClose} aria-label="Exit Car Mode">
          <X size={20} />
        </button>
      </nav>

      <div className="car-body">
        {/* Search runs across the top of every page */}
        <div className="car-searchbar">
          <div className="car-search">
            <Search size={16} />
            <input
              type="search"
              placeholder="Search books & music…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search books and music"
              enterKeyHint="search"
            />
            {query && (
              <button
                type="button"
                className="car-search-clear"
                onClick={() => setQuery('')}
                aria-label="Clear search"
              >
                <X size={14} />
              </button>
            )}
          </div>
        </div>

        <main className="car-content">
          {searching && (
          <section className="car-list-pane">
            <div className="car-pane-toolbar">
              <h2 className="car-list-heading">Search</h2>
              <span className="car-search-count">
                {search.books.length + search.tracks.length} results
              </span>
            </div>
            {search.books.length === 0 && search.tracks.length === 0 ? (
              <p className="car-list-note">
                Nothing matches “{query.trim()}”. Try fewer letters or another word.
              </p>
            ) : (
              <>
                {search.books.length > 0 && (
                  <>
                    <h3 className="car-list-group">Audiobooks</h3>
                    <div className="car-list">
                      {search.books.map((book) => (
                        <CarListRow
                          key={book.id}
                          emoji="📖"
                          coverUrl={book.coverUrl}
                          title={book.title}
                          subtitle={`${book.author || 'Unknown Author'}${book.parts ? ` · ${book.parts.length} parts` : ''}`}
                          onPlay={() => openWithPlayer(book)}
                        />
                      ))}
                    </div>
                  </>
                )}
                {search.tracks.length > 0 && (
                  <>
                    <h3 className="car-list-group">Music</h3>
                    <div className="car-list">
                      {search.tracks.map((track) => (
                        <CarListRow
                          key={track.id}
                          emoji="🎵"
                          coverUrl={track.coverUrl}
                          title={track.title}
                          subtitle={`${track.artist || 'Unknown Artist'} · ${formatDuration(track.durationSec)}`}
                          onPlay={() => openWithPlayer(track, search.tracks)}
                        />
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
          </section>
        )}

        {!searching && activeTab === 'player' && (
          activeItem ? (
            <div className="car-player">
              <div className="car-player-row">
                {/* Thumbnail: left in landscape, above in portrait */}
                <div className="car-cover">
                  {coverUrl ? (
                    <img src={coverUrl} alt={activeItem.title} />
                  ) : (
                    <span>{activeItem.kind === 'track' ? '🎵' : '📖'}</span>
                  )}
                </div>

                <div className="car-player-info">
                  <div className="car-titles">
                    <h1 className="car-title">{activeItem.title}</h1>
                    <div className="car-subtitle">
                      {activeItem.author || activeItem.artist || 'Unknown'}
                      {activeItem.album ? ` · ${activeItem.album}` : ''}
                    </div>
                  </div>

                  <div className="car-scrub">
                    <input
                      type="range"
                      min={0}
                      max={Math.max(1, Math.floor(effectiveDuration))}
                      step={1}
                      value={Math.floor(currentPos)}
                      onChange={(e) => setScrubValue(Number(e.target.value))}
                      onPointerUp={(e) => handleCommitScrub(Number(e.target.value))}
                      onKeyUp={(e) => handleCommitScrub(Number(e.target.value))}
                      aria-label="Seek"
                    />
                    <div className="car-time-row">
                      <span>{formatDuration(currentPos)}</span>
                      <span>{effectiveDuration > 0 ? formatDuration(effectiveDuration) : '--:--'}</span>
                    </div>
                  </div>

                  <div className="car-controls">
                    <button
                      type="button"
                      className="car-btn-round"
                      onClick={() => handleSeekBy(-15)}
                      title="Rewind 15 seconds"
                    >
                      <RotateCcw size={22} />
                      <span>-15s</span>
                    </button>

                    <button
                      type="button"
                      className="car-btn-skip"
                      onClick={onPrev}
                      disabled={!hasPrev}
                      title="Previous track"
                    >
                      <SkipBack size={26} fill="currentColor" />
                    </button>

                    <button
                      type="button"
                      className="car-btn-play"
                      onClick={handleTogglePlay}
                      title={localPlaying ? 'Pause' : 'Play'}
                    >
                      {localPlaying
                        ? <Pause size={38} fill="currentColor" />
                        : <Play size={38} fill="currentColor" style={{ marginLeft: 4 }} />}
                    </button>

                    <button
                      type="button"
                      className="car-btn-skip"
                      onClick={onNext}
                      disabled={!hasNext}
                      title="Next track"
                    >
                      <SkipForward size={26} fill="currentColor" />
                    </button>

                    <button
                      type="button"
                      className="car-btn-round"
                      onClick={() => handleSeekBy(30)}
                      title="Forward 30 seconds"
                    >
                      <RotateCw size={22} />
                      <span>+30s</span>
                    </button>
                  </div>

                  {activeItem.kind !== 'track' && (
                    <button type="button" className="car-speed-pill" onClick={handleCycleRate}>
                      <Gauge size={15} />
                      <span>Speed: {RATES[localRateIndex]}×</span>
                    </button>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="car-empty">
              <div className="car-empty-emoji">🚗</div>
              <h2>Ready to Drive</h2>
              <p>Select an audiobook or music track from the menu.</p>
              <button type="button" className="car-empty-cta" onClick={() => selectTab('audiobooks')}>
                Browse Audiobooks
              </button>
            </div>
          )
        )}

        {!searching && activeTab === 'audiobooks' && (
          <section className="car-list-pane">
            <h2 className="car-list-heading">Select an Audiobook</h2>
            {loadingList ? (
              <p className="car-list-note">Loading audiobooks…</p>
            ) : audiobooks.length === 0 ? (
              <p className="car-list-note">No audiobooks found in your library.</p>
            ) : (
              <div className="car-list">
                {audiobooks.map((book) => (
                  <CarListRow
                    key={book.id}
                    emoji="📖"
                    coverUrl={book.coverUrl}
                    title={book.title}
                    subtitle={`${book.author || 'Unknown Author'}${book.parts ? ` · ${book.parts.length} parts` : ''}`}
                    onPlay={() => openWithPlayer(book)}
                  />
                ))}
              </div>
            )}
          </section>
        )}

        {!searching && activeTab === 'music' && (
          <section className="car-list-pane">
            <div className="car-pane-toolbar">
              <h2 className="car-list-heading">Select Music</h2>
              {musicTracks.length > 1 && (
                <button type="button" className="car-shuffle-all-btn" onClick={shuffleAllMusic}>
                  <Shuffle size={15} />
                  Shuffle All
                </button>
              )}
            </div>
            {loadingList ? (
              <p className="car-list-note">Loading music tracks…</p>
            ) : musicTracks.length === 0 ? (
              <p className="car-list-note">No music found in your library.</p>
            ) : (
              <div className="car-list">
                {musicTracks.slice(0, 30).map((track) => (
                  <CarListRow
                    key={track.id}
                    emoji="🎵"
                    coverUrl={track.coverUrl}
                    title={track.title}
                    subtitle={`${track.artist || 'Unknown Artist'} · ${formatDuration(track.durationSec)}`}
                    onPlay={() => openWithPlayer(track, musicTracks)}
                  />
                ))}
              </div>
            )}
          </section>
        )}

        {!searching && activeTab === 'playlists' && (
          <section className="car-list-pane">
            <h2 className="car-list-heading">Playlists</h2>
            {loadingList ? (
              <p className="car-list-note">Loading playlists…</p>
            ) : playlists.length === 0 ? (
              <p className="car-list-note">No music playlists yet.</p>
            ) : (
              <div className="car-list">
                {playlists.map((pl) => (
                  <div
                    key={pl.id}
                    className="car-row"
                    onClick={() => startPlaylist(pl, true)}
                  >
                    <div className="car-row-thumb">
                      <span>📋</span>
                    </div>
                    <div className="car-row-meta">
                      <div className="car-row-title">{pl.name}</div>
                      <div className="car-row-subtitle">
                        {`${pl.count ?? 0} tracks · plays shuffled`}
                      </div>
                    </div>
                    <div className="car-row-actions">
                      <button
                        type="button"
                        className="car-row-play ghost"
                        title="Play in order"
                        aria-label={`Play ${pl.name} in order`}
                        onClick={(e) => {
                          e.stopPropagation();
                          startPlaylist(pl, false);
                        }}
                      >
                        <Play size={18} fill="currentColor" style={{ marginLeft: 1 }} />
                      </button>
                      <button
                        type="button"
                        className="car-row-play"
                        title="Shuffle play"
                        aria-label={`Shuffle ${pl.name}`}
                        disabled={Boolean(startingId)}
                        onClick={(e) => {
                          e.stopPropagation();
                          startPlaylist(pl, true);
                        }}
                      >
                        {startingId === pl.id
                          ? <Loader2 size={18} className="spin" />
                          : <Shuffle size={18} />}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {!searching && activeTab === 'offline' && (
          <section className="car-list-pane">
            <h2 className="car-list-heading">Offline Saved Media (No Data Usage)</h2>
            {offlineStats?.tracks?.length ? (
              <div className="car-list">
                {offlineStats.tracks.map((track) => (
                  <CarListRow
                    key={track.id}
                    emoji="⚡"
                    title={track.title}
                    subtitle={`${track.artist || 'Unknown'} · ${formatDuration(track.durationSec)}`}
                    onPlay={() => openWithPlayer(track, offlineStats.tracks)}
                  />
                ))}
              </div>
            ) : (
              <p className="car-list-note car-list-note-spaced">
                No offline media saved on this device.
              </p>
            )}
          </section>
        )}
        </main>
      </div>
    </div>
  );
}
