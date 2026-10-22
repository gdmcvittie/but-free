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
import {
  getOfflineAudioUrl,
  getOfflineCoverUrl,
  saveOfflineProgress,
  getOfflineProgress,
  isItemOffline,
  downloadTrack,
  downloadBook
} from './offlineStorage';
import NowPlayingView from './NowPlayingView';
import { RATES, getSavedAudiobookRateIndex, saveAudiobookRateIndex } from './audiobookSettings';

const SAVE_INTERVAL_SEC = 30;
const TICK_MS = 5000;
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
  const [rateIndex, setRateIndex] = useState(() => (item.kind !== 'track' ? getSavedAudiobookRateIndex() : 0));
  const [scrubPosition, setScrubPosition] = useState(null);
  const [error, setError] = useState(null);
  const [isFavorite, setIsFavorite] = useState(Boolean(item.favorite));
  const [audioSrc, setAudioSrc] = useState(api.streamUrl(item.id));
  const [coverSrc, setCoverSrc] = useState(item.coverUrl || api.coverUrl(item.id));
  const [showNowPlaying, setShowNowPlaying] = useState(false);
  const effectiveDuration = duration > 0 ? duration : item.durationSec || 0;

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
  const queueRef = useRef(queue);
  const queueIndexRef = useRef(queueIndex);
  const playTriggerRef = useRef(playTrigger);
  const lastSessionPersistRef = useRef(0);
  const lastNativePushRef = useRef(0);
  const playingRef = useRef(playing);

  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);

  // Keep refs pointing at current props without reading during render.
  useEffect(() => {
    itemRef.current = item;
  }, [item]);
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);
  useEffect(() => {
    queueIndexRef.current = queueIndex;
  }, [queueIndex]);
  useEffect(() => {
    playTriggerRef.current = playTrigger;
  }, [playTrigger]);

  // Save current listening item and exact progress to localStorage
  const persistSessionState = useCallback((pos) => {
    if (!itemRef.current?.id) return;
    try {
      const positionSec = typeof pos === 'number'
        ? Math.floor(pos)
        : (audioRef.current ? Math.floor(audioRef.current.currentTime) : 0);
      const state = {
        item: itemRef.current,
        queue: queueRef.current?.length ? queueRef.current : [itemRef.current],
        queueIndex: queueIndexRef.current >= 0 ? queueIndexRef.current : 0,
        positionSec,
        savedAt: Date.now()
      };
      localStorage.setItem('fraudio.lastListening', JSON.stringify(state));
    } catch {}
  }, []);

  // Automatically download and cache audiobooks and music for offline listening
  useEffect(() => {
    if (!item?.id) return;

    let cancelled = false;
    (async () => {
      try {
        const alreadyOffline = await isItemOffline(item.id);
        if (!alreadyOffline && !cancelled) {
          if (item.isMultiPart && Array.isArray(item.parts) && item.parts.length > 0) {
            await downloadBook(item, item.parts);
          } else {
            await downloadTrack(item);
          }
          if (!cancelled) {
            const offlineCover = await getOfflineCoverUrl(item.id);
            if (!cancelled && offlineCover) setCoverSrc(offlineCover);
          }
        }

        // Also pre-cache companion tracks or chapters in the queue for offline continuity
        const currentQueue = queueRef.current;
        if (Array.isArray(currentQueue) && currentQueue.length > 1) {
          for (const companion of currentQueue) {
            if (cancelled) break;
            if (!companion?.id || companion.id === item.id) continue;
            const compOffline = await isItemOffline(companion.id);
            if (!compOffline && !cancelled) {
              await downloadTrack(companion).catch(() => {});
            }
          }
        }
      } catch (err) {
        console.warn('[Player] Offline auto-download note:', err.message);
      }
    })();

    return () => { cancelled = true; };
  }, [item.id]);

  // Reset per-item state and look up the saved position.
  useEffect(() => {
    let initialSavedSec = 0;
    try {
      const savedSession = localStorage.getItem('fraudio.lastListening');
      if (savedSession) {
        const parsed = JSON.parse(savedSession);
        if (parsed?.item?.id === item.id && parsed.positionSec > 0) {
          initialSavedSec = parsed.positionSec;
        }
      }
    } catch {}

    resumeAtRef.current = initialSavedSec;
    savedAtRef.current = initialSavedSec;
    setPosition(initialSavedSec);
    setPlaying(false);
    setError(null);
    setScrubPosition(null);
    const targetRateIdx = item.kind !== 'track' ? getSavedAudiobookRateIndex() : 0;
    setRateIndex(targetRateIdx);
    if (audioRef.current) {
      audioRef.current.playbackRate = RATES[targetRateIdx];
    }

    let cancelled = false;
    (async () => {
      try {
        const all = await api.progress();
        if (cancelled) return;
        const saved = all?.[item.id];
        if (saved && saved.positionSec > 0) {
          resumeAtRef.current = saved.positionSec;
          savedAtRef.current = saved.positionSec;
          setPosition(saved.positionSec);
        }
      } catch {
        // Resume from offline storage if offline
        const offlineProg = await getOfflineProgress(item.id);
        if (!cancelled && offlineProg && offlineProg.positionSec > 0) {
          resumeAtRef.current = offlineProg.positionSec;
          savedAtRef.current = offlineProg.positionSec;
          setPosition(offlineProg.positionSec);
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
    audio.play().catch(() => {
      if (audio.paused) setPlaying(false);
    });
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
    persistSessionState(positionSec);
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
  }, [persistSessionState]);

  // Push state to native bridge with current playback rate
  const pushNative = useCallback((isPlaying, curPos) => {
    const audio = audioRef.current;
    const curItem = itemRef.current;
    if (!audio || !curItem?.id) return;
    const pos = typeof curPos === 'number' ? curPos : audio.currentTime;
    const dur = audio && Number.isFinite(audio.duration) && audio.duration > 0
      ? audio.duration
      : effectiveDuration;
    pushNativeState({
      playing: Boolean(isPlaying),
      positionSec: pos,
      durationSec: dur,
      playbackRate: curItem.kind !== 'track' ? RATES[rateIndex] || 1.0 : 1.0,
      meta: {
        title: curItem.title,
        artist: curItem.artist || curItem.albumArtist || curItem.author || 'FRAUDIO',
        album: curItem.album || '',
        coverUrl: curItem.coverUrl || api.coverUrl(curItem.id)
      }
    });
  }, [effectiveDuration, rateIndex]);

  // Update web standard MediaSession position state
  const updateMediaSessionPosition = useCallback((curPos, dur, rate) => {
    if (!('mediaSession' in navigator) || typeof navigator.mediaSession.setPositionState !== 'function') return;
    const audio = audioRef.current;
    const totalDuration = dur || (audio && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : effectiveDuration);
    if (!totalDuration || !Number.isFinite(totalDuration) || totalDuration <= 0) return;
    const pos = typeof curPos === 'number' ? curPos : (audio ? audio.currentTime : 0);
    const targetRate = rate || (audio ? audio.playbackRate : (itemRef.current.kind !== 'track' ? RATES[rateIndex] : 1.0));
    try {
      navigator.mediaSession.setPositionState({
        duration: Math.max(0, totalDuration),
        playbackRate: Math.max(0.5, Math.min(4.0, targetRate || 1.0)),
        position: Math.min(Math.max(0, pos), totalDuration)
      });
    } catch {
      /* ignore setPositionState errors */
    }
  }, [effectiveDuration, rateIndex]);

  // Media element wiring.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return undefined;

    const applyResume = () => {
      const isAudiobook = itemRef.current.kind !== 'track';
      const targetRate = isAudiobook ? RATES[getSavedAudiobookRateIndex()] : 1.0;
      audio.playbackRate = targetRate;
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setDuration(audio.duration);
      }
      if (resumeAtRef.current > 0 && resumeAtRef.current < (audio.duration || Infinity)) {
        audio.currentTime = resumeAtRef.current;
        setPosition(resumeAtRef.current);
        resumeAtRef.current = 0;
      }
      // Only auto-play if play was triggered by an explicit user action
      if (playTriggerRef.current > 0) {
        audio.play().catch(() => {
          if (audio.paused) setPlaying(false);
        });
      }
    };

    const handleTimeUpdate = () => {
      const cur = audio.currentTime;
      setPosition(cur);

      // Self-healing: if audio is actively updating position and not paused, sync state
      if (!audio.paused && !audio.ended && !playingRef.current) {
        setPlaying(true);
      }

      if (Math.abs(cur - (lastSessionPersistRef.current || 0)) >= 3) {
        lastSessionPersistRef.current = cur;
        persistSessionState(cur);
      }

      // Checkpoint progress regularly via timeupdate, which fires reliably
      // in the background even when browser throttles setInterval timers.
      if (Math.abs(cur - savedAtRef.current) >= SAVE_INTERVAL_SEC) {
        void persist();
      }

      // Keep native and MediaSession playheads fresh during background playback
      if (Math.abs(cur - (lastNativePushRef.current || 0)) >= 5) {
        lastNativePushRef.current = cur;
        pushNative(true, cur);
        updateMediaSessionPosition(cur);
      }
    };
    const handlePlay = () => {
      const isAudiobook = itemRef.current.kind !== 'track';
      const targetRate = isAudiobook ? RATES[getSavedAudiobookRateIndex()] : 1.0;
      if (audio.playbackRate !== targetRate) {
        audio.playbackRate = targetRate;
      }
      setPlaying(true);
    };
    const handlePause = () => {
      if (audio.paused) {
        setPlaying(false);
      }
      persistSessionState(audio.currentTime);
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
    audio.addEventListener('playing', handlePlay);
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
      audio.removeEventListener('playing', handlePlay);
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
  // switch), and instantly re-synchronize state with the audio element when returning to foreground.
  useEffect(() => {
    const syncFromAudio = () => {
      const audio = audioRef.current;
      if (!audio) return;
      const isActualPlaying = !audio.paused && !audio.ended && audio.readyState > 1;
      const curPos = audio.currentTime;
      setPosition(curPos);
      setPlaying(isActualPlaying);
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setDuration(audio.duration);
      }
      updateMediaSessionPosition(curPos);
      pushNative(isActualPlaying, curPos);
      window.dispatchEvent(new CustomEvent('fraudio:player-state', {
        detail: {
          playing: isActualPlaying,
          position: curPos,
          duration: Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : effectiveDuration,
          rateIndex
        }
      }));
    };

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        persistKeepalive();
      } else if (document.visibilityState === 'visible') {
        syncFromAudio();
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', persistKeepalive);
    window.addEventListener('beforeunload', persistKeepalive);
    window.addEventListener('focus', syncFromAudio);
    window.addEventListener('pageshow', syncFromAudio);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', persistKeepalive);
      window.removeEventListener('beforeunload', persistKeepalive);
      window.removeEventListener('focus', syncFromAudio);
      window.removeEventListener('pageshow', syncFromAudio);
    };
  }, [persistKeepalive, effectiveDuration, rateIndex]);

  // Checkpoint on unmount. `keepalive` lets the write finish during navigation.
  useEffect(() => {
    return () => {
      const audio = audioRef.current;
      if (!audio || !itemRef.current?.id) return;
      const positionSec = Math.floor(audio.currentTime);
      persistSessionState(positionSec);
      if (positionSec < 2) return;
      try {
        fetch(api.apiUrl('/api/progress'), {
          method: 'POST',
          credentials: 'same-origin',
          keepalive: true,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            itemId: itemRef.current.id,
            positionSec,
            durationSec: audio.duration || itemRef.current.durationSec
          })
        }).catch(() => {});
      } catch {
        /* ignore */
      }
    };
  }, [persistSessionState]);

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
    updateMediaSessionPosition(position);
  }, [item, playing, position, updateMediaSessionPosition]);

  // OS-level media action handlers (lock screen, notification, bluetooth headsets)
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const handlers = [
      ['play', () => {
        const audio = audioRef.current;
        if (audio && audio.paused) audio.play().catch(() => {});
      }],
      ['pause', () => {
        const audio = audioRef.current;
        if (audio && !audio.paused) audio.pause();
      }],
      ['seekbackward', (details) => {
        seekBy(-(details?.seekOffset || SKIP_SECONDS));
      }],
      ['seekforward', (details) => {
        seekBy(details?.seekOffset || SKIP_SECONDS);
      }],
      ['seekto', (details) => {
        if (typeof details?.seekTime === 'number') {
          commitScrub(details.seekTime);
        }
      }],
      ['previoustrack', () => {
        if (hasPrev) onPrev?.();
      }],
      ['nexttrack', () => {
        if (hasNext) onNext?.();
      }]
    ];

    for (const [action, handler] of handlers) {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {}
    }

    return () => {
      for (const [action] of handlers) {
        try {
          navigator.mediaSession.setActionHandler(action, null);
        } catch {}
      }
    };
  }, [hasNext, hasPrev, onNext, onPrev]);

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
    if (item.kind === 'track') return;
    const next = (rateIndex + 1) % RATES.length;
    saveAudiobookRateIndex(next);
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
      if (audio) {
        audio.play().catch(() => {
          if (audio.paused) setPlaying(false);
        });
      }
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

    const handleSpeedChanged = (e) => {
      if (itemRef.current.kind !== 'track') {
        const nextIdx = e.detail?.rateIndex ?? getSavedAudiobookRateIndex();
        setRateIndex(nextIdx);
        if (audioRef.current) {
          audioRef.current.playbackRate = RATES[nextIdx];
        }
      }
    };
    window.addEventListener('fraudio:audiobook-speed-changed', handleSpeedChanged);

    return () => {
      window.removeEventListener('fraudio:car-toggle-play', handleToggle);
      window.removeEventListener('fraudio:car-seek-by', handleSeekBy);
      window.removeEventListener('fraudio:car-seek-to', handleSeekTo);
      window.removeEventListener('fraudio:car-cycle-rate', handleCycleRate);
      window.removeEventListener('fraudio:native-play', handleNativePlay);
      window.removeEventListener('fraudio:native-pause', handleNativePause);
      window.removeEventListener('fraudio:audiobook-speed-changed', handleSpeedChanged);
    };
  }, [rateIndex, duration]);

  // Native (Android) media session sync: lock screen + notification controls.
  useEffect(() => {
    pushNative(playing, position);
  }, [playing, item, pushNative]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the native playhead reasonably fresh during long background playback.
  useEffect(() => {
    if (!playing) return undefined;
    const timer = setInterval(() => {
      const audio = audioRef.current;
      if (!audio) return;
      pushNative(true, audio.currentTime);
      updateMediaSessionPosition(audio.currentTime);
    }, 10000);
    return () => clearInterval(timer);
  }, [playing, pushNative, updateMediaSessionPosition]);

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