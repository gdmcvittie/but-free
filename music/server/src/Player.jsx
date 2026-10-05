import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  X,
  Gauge,
  RotateCcw,
  RotateCw,
  Shuffle,
  Heart,
  Car
} from 'lucide-react';
import { api } from './api';
import { formatDuration, stripTrackNumber } from './format';
import { pushNativeState } from './nativeBridge';
import { getOfflineAudioUrl, getOfflineCoverUrl, saveOfflineProgress, getOfflineProgress } from './offlineStorage';
import NowPlayingView from './NowPlayingView';

const SAVE_INTERVAL_SEC = 30;
const TICK_MS = 5000;
const RATES = [1, 1.25, 1.5, 1.75, 2];
const SKIP_SECONDS = 15;

/**
 * Bottom playback bar.
 *
 * Owns a single hidden <audio> element pointed at /api/items/:id/stream. The
 * server serves the local offline copy when one exists, so the URL is stable
 * for the life of an item. Playback position is checkpointed to the server on a
 * timer and on teardown so "Continue listening" survives a reload or a crash.
 */
export default function Player({
  item,
  playTrigger,
  hasNext,
  hasPrev,
  shuffle = false,
  onToggleShuffle,
  onNext,
  onPrev,
  onClose,
  onOpenCarMode,
  onEnded,
  onProgressSaved,
  onToggleFavorite,
  queue = [],
  queueIndex = 0,
  onPlayQueueAt
}) {
  const audioRef = useRef(null);

  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(item.durationSec || 0);
  const [rateIndex, setRateIndex] = useState(0);
  const [scrubPosition, setScrubPosition] = useState(null);
  const [error, setError] = useState(null);
  const [isFavorite, setIsFavorite] = useState(Boolean(item.favorite));
  const [audioSrc, setAudioSrc] = useState(api.streamUrl(item.id));
  const [coverSrc, setCoverSrc] = useState(item.coverUrl || api.coverUrl(item.id));
  const [showNowPlaying, setShowNowPlaying] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const offlineAudio = await getOfflineAudioUrl(item.id);
      if (!cancelled && offlineAudio) {
        setAudioSrc(offlineAudio);
      } else if (!cancelled) {
        setAudioSrc(api.streamUrl(item.id));
      }
      const offlineCover = await getOfflineCoverUrl(item.id);
      if (!cancelled && offlineCover) {
        setCoverSrc(offlineCover);
      } else if (!cancelled) {
        setCoverSrc(item.coverUrl || api.coverUrl(item.id));
      }
    })();
    return () => { cancelled = true; };
  }, [item.id, item.coverUrl]);

  useEffect(() => {
    if (typeof item.favorite === 'boolean') {
      setIsFavorite(item.favorite);
    } else {
      let cancelled = false;
      api.favorites(item.kind === 'track' ? 'music' : 'audiobooks')
        .then((res) => {
          if (!cancelled) {
            const list = res?.itemIds || [];
            setIsFavorite(list.includes(item.id));
          }
        })
        .catch(() => {});
      return () => { cancelled = true; };
    }
  }, [item.id, item.favorite, item.kind]);

  const handleToggleFavorite = async () => {
    const next = !isFavorite;
    setIsFavorite(next);
    try {
      if (onToggleFavorite) {
        await onToggleFavorite(item, next);
      } else {
        await api.setFavorite(item.id, next);
        onProgressSaved?.();
      }
    } catch {
      setIsFavorite(!next);
    }
  };

  // Where to resume from once the browser reports the real duration.
  const resumeAtRef = useRef(0);
  // Last position we successfully told the server about.
  const savedAtRef = useRef(0);
  const itemRef = useRef(item);

  // Keep the ref pointing at the current item without reading refs during render.
  useEffect(() => {
    itemRef.current = item;
  }, [item]);

  // Reset per-item state and look up the saved position.
  useEffect(() => {
    resumeAtRef.current = 0;
    savedAtRef.current = 0;
    setPosition(0);
    setPlaying(false);
    setError(null);
    setScrubPosition(null);
    setRateIndex(0);

    let cancelled = false;
    (async () => {
      try {
        const all = await api.progress();
        if (cancelled) return;
        const saved = all?.[item.id];
        if (saved && saved.positionSec > 5) {
          resumeAtRef.current = saved.positionSec;
          savedAtRef.current = saved.positionSec;
        }
      } catch {
        // Resume from offline storage if offline
        const offlineProg = await getOfflineProgress(item.id);
        if (!cancelled && offlineProg && offlineProg.positionSec > 5) {
          resumeAtRef.current = offlineProg.positionSec;
          savedAtRef.current = offlineProg.positionSec;
        }
      }
    })();

    return () => { cancelled = true; };
  }, [item.id]);

  // When play is triggered from outside, always attempt to play immediately
  useEffect(() => {
    if (!playTrigger) return;
    const audio = audioRef.current;
    if (!audio) return;
    audio.play().catch(() => setPlaying(false));
  }, [playTrigger]);

  // Fire-and-forget checkpoint that survives the page going away: `keepalive`
  // lets the write finish during screen-off, navigation, or process kill,
  // where a timer or async fetch would be cancelled first.
  const persistKeepalive = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const positionSec = Math.floor(audio.currentTime);
    if (positionSec < 1) return;
    savedAtRef.current = positionSec;
    const body = JSON.stringify({
      itemId: itemRef.current.id,
      positionSec,
      durationSec: audio.duration || itemRef.current.durationSec
    });
    try {
      fetch(api.apiUrl('/api/progress'), {
        method: 'POST',
        credentials: 'same-origin',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body
      }).catch(() => {
        saveOfflineProgress(itemRef.current.id, positionSec, audio.duration || itemRef.current.durationSec).catch(() => {});
      });
    } catch {
      /* ignore */
    }
  }, []);

  // Media element wiring.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return undefined;

    const applyResume = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setDuration(audio.duration);
      }
      if (resumeAtRef.current > 0 && resumeAtRef.current < (audio.duration || Infinity)) {
        audio.currentTime = resumeAtRef.current;
        resumeAtRef.current = 0;
      }
      audio.play().catch(() => setPlaying(false));
    };

    const handleTimeUpdate = () => setPosition(audio.currentTime);
    const handlePlay = () => setPlaying(true);
    const handlePause = () => {
      setPlaying(false);
      // Pausing (button, lock screen, headset, focus loss) is the last moment
      // we reliably own before playback can be abandoned - checkpoint it.
      persistKeepalive();
    };
    const handleDuration = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) setDuration(audio.duration);
    };
    const handleEnded = () => {
      setPlaying(false);
      // A finished book is "done", so clear the resume point rather than saving
      // the very end of the file.
      void api.saveProgress(itemRef.current.id, 0, audio.duration || undefined).catch(() => {});
      onEnded();
    };
    const handleError = () => {
      setPlaying(false);
      setError('Could not play this item. Check the Drive connection and try again.');
    };

    if (audio.readyState >= 1) {
      applyResume();
    }

    audio.addEventListener('loadedmetadata', applyResume);
    audio.addEventListener('canplay', applyResume, { once: true });
    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('durationchange', handleDuration);
    audio.addEventListener('play', handlePlay);
    audio.addEventListener('pause', handlePause);
    audio.addEventListener('ended', handleEnded);
    audio.addEventListener('error', handleError);

    audio.load();

    return () => {
      audio.removeEventListener('loadedmetadata', applyResume);
      audio.removeEventListener('canplay', applyResume);
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('durationchange', handleDuration);
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handlePause);
      audio.removeEventListener('ended', handleEnded);
      audio.removeEventListener('error', handleError);
    };
  }, [item.id, onEnded, persistKeepalive]);

  const persist = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;
    const positionSec = Math.floor(audio.currentTime);
    if (positionSec < 1) return;
    savedAtRef.current = positionSec;
    try {
      await api.saveProgress(itemRef.current.id, positionSec, audio.duration || itemRef.current.durationSec);
      onProgressSaved?.();
    } catch {
      // Save locally to offline storage and queue for cloud sync
      await saveOfflineProgress(itemRef.current.id, positionSec, audio.duration || itemRef.current.durationSec);
    }
  }, [onProgressSaved]);

  // Periodic checkpoint while playing: saves whenever we've moved at least
  // SAVE_INTERVAL_SEC from the last written position, so a resumed/killed app
  // loses at most ~30s of listening.
  useEffect(() => {
    if (!playing) return undefined;
    const timer = setInterval(() => {
      const audio = audioRef.current;
      if (!audio) return;
      if (Math.abs(audio.currentTime - savedAtRef.current) >= SAVE_INTERVAL_SEC) void persist();
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [playing, persist]);

  // Early checkpoint: without this the first write only happens SAVE_INTERVAL_SEC in,
  // so a freshly started book/track never shows up in Continue Listening until the
  // player has been running for a while. Recording it here also seeds
  // savedAtRef so the periodic timer measures from a real checkpoint.
  useEffect(() => {
    if (!playing) return undefined;
    const timer = setTimeout(() => {
      void persist();
    }, 1500);
    return () => clearTimeout(timer);
  }, [playing, item.id, persist]);

  // Flush progress the instant the page is backgrounded (screen off / app
  // switch), before timers get throttled and before the OS can kill us.
  useEffect(() => {
    const flush = () => {
      const audio = audioRef.current;
      if (audio && !audio.paused) persistKeepalive();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
    };
  }, [persistKeepalive]);

  // Checkpoint on unmount. `keepalive` lets the write finish during navigation.
  useEffect(() => {
    const audio = audioRef.current;
    const currentId = itemRef.current.id;

    return () => {
      if (!audio) return;
      const positionSec = Math.floor(audio.currentTime);
      if (positionSec < 2) return;
      try {
        fetch(api.apiUrl('/api/progress'), {
          method: 'POST',
          credentials: 'same-origin',
          keepalive: true,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            itemId: currentId,
            positionSec,
            durationSec: audio.duration || itemRef.current.durationSec
          })
        }).catch(() => {});
      } catch {
        /* ignore */
      }
    };
  }, []);

  // OS-level media controls (lockscreen, tray, hardware keys).
  useEffect(() => {
    if (!('mediaSession' in navigator) || !window.MediaMetadata) return;
    navigator.mediaSession.metadata = new window.MediaMetadata({
      title: item.title,
      artist: item.artist || item.albumArtist || item.author || 'FRAUDIO',
      album: item.album || '',
      artwork: item.coverUrl ? [{ src: item.coverUrl, sizes: '300x300' }] : []
    });
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  }, [item, playing]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) audio.play().catch(() => setPlaying(false));
    else audio.pause();
  };

  const seekBy = (delta) => {
    const audio = audioRef.current;
    if (!audio) return;
    const limit = Number.isFinite(audio.duration) ? audio.duration : Infinity;
    audio.currentTime = Math.max(0, Math.min(limit, audio.currentTime + delta));
  };

  const commitScrub = (value) => {
    const audio = audioRef.current;
    setScrubPosition(null);
    if (audio) {
      const limit = Number.isFinite(audio.duration) ? audio.duration : value;
      audio.currentTime = Math.max(0, Math.min(value, limit));
    }
  };

  const cycleRate = () => {
    const next = (rateIndex + 1) % RATES.length;
    setRateIndex(next);
    if (audioRef.current) audioRef.current.playbackRate = RATES[next];
  };

  const handleClose = () => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      void persist();
    }
    onClose();
  };

  const effectiveDuration = duration > 0 ? duration : item.durationSec || 0;
  const shownPosition = scrubPosition ?? position;
  const subtitle = item.artist || item.albumArtist || item.author || item.narrator || '';

  // Car Mode Event Listeners & State Sync
  useEffect(() => {
    const handleToggle = () => togglePlay();
    const handleSeekBy = (e) => seekBy(e.detail);
    const handleSeekTo = (e) => commitScrub(e.detail);
    const handleCycleRate = () => cycleRate();
    const handleNativePlay = () => {
      const audio = audioRef.current;
      if (audio) audio.play().catch(() => setPlaying(false));
    };
    const handleNativePause = () => {
      const audio = audioRef.current;
      if (audio) audio.pause();
    };

    window.addEventListener('fraudio:car-toggle-play', handleToggle);
    window.addEventListener('fraudio:car-seek-by', handleSeekBy);
    window.addEventListener('fraudio:car-seek-to', handleSeekTo);
    window.addEventListener('fraudio:car-cycle-rate', handleCycleRate);
    window.addEventListener('fraudio:native-play', handleNativePlay);
    window.addEventListener('fraudio:native-pause', handleNativePause);

    return () => {
      window.removeEventListener('fraudio:car-toggle-play', handleToggle);
      window.removeEventListener('fraudio:car-seek-by', handleSeekBy);
      window.removeEventListener('fraudio:car-seek-to', handleSeekTo);
      window.removeEventListener('fraudio:car-cycle-rate', handleCycleRate);
      window.removeEventListener('fraudio:native-play', handleNativePlay);
      window.removeEventListener('fraudio:native-pause', handleNativePause);
    };
  }, [rateIndex, duration]);

  // Native (Android) media session sync: lock screen + notification controls.
  useEffect(() => {
    const audio = audioRef.current;
    pushNativeState({
      playing,
      positionSec: audio ? audio.currentTime : 0,
      durationSec: audio && Number.isFinite(audio.duration) ? audio.duration : effectiveDuration,
      meta: {
        title: item.title,
        artist: item.artist || item.albumArtist || item.author || 'FRAUDIO',
        album: item.album || '',
        coverUrl: item.coverUrl || api.coverUrl(item.id)
      }
    });
  }, [playing, item]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the native playhead reasonably fresh during long background playback.
  useEffect(() => {
    if (!playing) return undefined;
    const timer = setInterval(() => {
      const audio = audioRef.current;
      if (!audio) return;
      pushNativeState({
        playing: true,
        positionSec: audio.currentTime,
        durationSec: Number.isFinite(audio.duration) ? audio.duration : 0
      });
    }, 10000);
    return () => clearInterval(timer);
  }, [playing]);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('fraudio:player-state', {
      detail: { playing, position, duration: effectiveDuration, rateIndex }
    }));
  }, [playing, position, effectiveDuration, rateIndex]);

  return (
    <>
      <audio ref={audioRef} src={audioSrc} preload="metadata" />

      <div className="player-bar">
        <div className="player-now-playing">
          <img
            className="player-cover"
            src={coverSrc}
            alt="Open Now Playing"
            onClick={() => setShowNowPlaying(true)}
            title="Tap thumbnail to open Now Playing view"
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && setShowNowPlaying(true)}
          />
          <div
            className="player-meta player-now-playing-clickable"
            onClick={() => setShowNowPlaying(true)}
            title="Tap to open Now Playing view"
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && setShowNowPlaying(true)}
          >
            <div className="player-title">{item.kind === 'track' ? stripTrackNumber(item.title) : item.title}</div>
            <div className="player-subtitle">
              {error || (
                effectiveDuration > 0
                  ? `${formatDuration(shownPosition)} / ${formatDuration(effectiveDuration)}`
                  : subtitle
              )}
            </div>
          </div>
          <button
            type="button"
            className={`player-fav-btn ${isFavorite ? 'active' : ''}`}
            onClick={handleToggleFavorite}
            title={isFavorite ? 'Remove from favourites' : 'Add to favourites'}
            aria-label={isFavorite ? 'Remove from favourites' : 'Add to favourites'}
          >
            <Heart size={18} fill={isFavorite ? 'currentColor' : 'none'} />
          </button>
        </div>

        <div className="player-controls">
          {onToggleShuffle && (
            <button
              type="button"
              className={`player-control-btn secondary ${shuffle ? 'active' : ''}`}
              onClick={onToggleShuffle}
              title={shuffle ? 'Shuffle: On' : 'Shuffle: Off'}
              style={shuffle ? { color: 'var(--accent-color)' } : {}}
            >
              <Shuffle size={17} />
            </button>
          )}

          <button
            type="button"
            className="player-control-btn secondary player-transport"
            onClick={onPrev}
            disabled={!hasPrev}
            title="Previous in queue"
          >
            <SkipBack size={18} fill="currentColor" />
          </button>

          <button
            type="button"
            className="player-control-btn secondary player-transport"
            onClick={() => seekBy(-SKIP_SECONDS)}
            title={`Back ${SKIP_SECONDS}s`}
          >
            <RotateCcw size={18} />
          </button>

          <button
            type="button"
            className="player-control-btn primary"
            onClick={togglePlay}
            title={playing ? 'Pause' : 'Play'}
          >
            {playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
          </button>

          <button
            type="button"
            className="player-control-btn secondary player-transport"
            onClick={() => seekBy(SKIP_SECONDS)}
            title={`Forward ${SKIP_SECONDS}s`}
          >
            <RotateCw size={18} />
          </button>

          <button
            type="button"
            className="player-control-btn secondary player-transport"
            onClick={onNext}
            disabled={!hasNext}
            title="Next in queue"
          >
            <SkipForward size={18} fill="currentColor" />
          </button>
        </div>

        <div className="player-timeline">
          <input
            className="player-seek"
            type="range"
            min={0}
            max={Math.max(1, Math.floor(effectiveDuration))}
            step={1}
            value={Math.floor(shownPosition)}
            onChange={(e) => setScrubPosition(Number(e.target.value))}
            onPointerUp={(e) => commitScrub(Number(e.target.value))}
            onKeyUp={(e) => commitScrub(Number(e.target.value))}
            aria-label="Seek"
          />
          <div className="player-time-row">
            <span>{formatDuration(shownPosition)}</span>
            <span>{effectiveDuration > 0 ? formatDuration(effectiveDuration) : '--:--'}</span>
          </div>
        </div>

        <div className="player-aside">
          {onOpenCarMode && (
            <button
              type="button"
              className="player-control-btn desktop-only"
              onClick={onOpenCarMode}
              title="Car Mode (Driving UI)"
            >
              <Car size={18} />
            </button>
          )}
          {item.kind !== 'track' && (
            <button
              type="button"
              className="player-control-btn player-rate-btn"
              onClick={cycleRate}
              title={`Playback speed (${RATES[rateIndex]}x)`}
            >
              <Gauge size={17} />
              <span style={{ fontSize: '0.68rem', fontWeight: 700 }}>{RATES[rateIndex]}×</span>
            </button>
          )}
          <button type="button" className="player-control-btn" onClick={handleClose} title="Close player">
            <X size={18} />
          </button>
        </div>
      </div>

      <NowPlayingView
        isOpen={showNowPlaying}
        onClose={() => setShowNowPlaying(false)}
        item={item}
        coverSrc={coverSrc}
        playing={playing}
        position={shownPosition}
        duration={effectiveDuration}
        rateIndex={rateIndex}
        onTogglePlay={togglePlay}
        onSeekBy={seekBy}
        onCommitScrub={commitScrub}
        onNext={onNext}
        onPrev={onPrev}
        hasNext={hasNext}
        hasPrev={hasPrev}
        shuffle={shuffle}
        onToggleShuffle={onToggleShuffle}
        onCycleRate={cycleRate}
        isFavorite={isFavorite}
        onToggleFavorite={handleToggleFavorite}
        queue={queue}
        queueIndex={queueIndex}
        onPlayQueueAt={onPlayQueueAt}
      />
    </>
  );
}