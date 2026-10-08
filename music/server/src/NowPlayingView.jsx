import { useState, useEffect, useRef } from 'react';
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  RotateCcw,
  RotateCw,
  X,
  ChevronDown,
  Shuffle,
  Heart,
  ListMusic,
  Gauge,
  Music2,
  Disc
} from 'lucide-react';
import { formatDuration, stripTrackNumber } from './format';
import { RATES } from './audiobookSettings';

export default function NowPlayingView({
  isOpen,
  onClose,
  item,
  coverSrc,
  playing,
  position,
  duration,
  rateIndex = 0,
  onTogglePlay,
  onSeekBy,
  onCommitScrub,
  onNext,
  onPrev,
  hasNext,
  hasPrev,
  shuffle = false,
  onToggleShuffle,
  onCycleRate,
  isFavorite = false,
  onToggleFavorite,
  queue = [],
  queueIndex = 0,
  onPlayQueueAt
}) {
  const [showQueue, setShowQueue] = useState(false);
  const [scrubPosition, setScrubPosition] = useState(null);
  const activeRowRef = useRef(null);
  const queueListRef = useRef(null);

  // Auto-scroll to currently playing song whenever the queue view opens or track changes
  useEffect(() => {
    if (showQueue && activeRowRef.current) {
      // Smoothly bring the currently playing song into view at the start/top
      activeRowRef.current.scrollIntoView({
        block: 'start',
        behavior: 'smooth'
      });
    }
  }, [showQueue, queueIndex]);

  // Handle escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        if (showQueue) {
          setShowQueue(false);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, showQueue, onClose]);

  if (!isOpen || !item) return null;

  const effectiveDuration = duration > 0 ? duration : item.durationSec || 0;
  const currentPos = scrubPosition !== null ? scrubPosition : position;

  const handleCommitScrub = (val) => {
    setScrubPosition(null);
    onCommitScrub(val);
  };

  const title = item.kind === 'track' ? stripTrackNumber(item.title) : item.title;
  const subtitle = item.artist || item.author || (item.kind === 'track' ? 'Unknown Artist' : 'Unknown Author');
  const album = item.album || item.series || '';

  const hasPlaylistQueue = Array.isArray(queue) && queue.length > 0;

  return (
    <div className="now-playing-overlay" role="dialog" aria-modal="true" aria-label="Now Playing">
      <div className="now-playing-shell">
        {/* Top Header Navigation */}
        <header className="now-playing-header">
          <button
            type="button"
            className="now-playing-icon-btn"
            onClick={onClose}
            title="Minimize Now Playing"
            aria-label="Minimize Now Playing"
          >
            <ChevronDown size={26} />
          </button>

          <div className="now-playing-header-info">
            <span className="now-playing-header-badge">
              {showQueue ? 'PLAYLIST QUEUE' : 'NOW PLAYING'}
            </span>
            <span className="now-playing-header-context">
              {hasPlaylistQueue && `${queueIndex + 1} of ${queue.length}`}
            </span>
          </div>

          <div className="now-playing-header-actions">
            {hasPlaylistQueue && (
              <button
                type="button"
                className={`now-playing-queue-toggle-btn ${showQueue ? 'active' : ''}`}
                onClick={() => setShowQueue(!showQueue)}
                title={showQueue ? 'View Album Art' : 'View Queue'}
                aria-label={showQueue ? 'View Album Art' : 'View Queue'}
              >
                <ListMusic size={20} />
                <span className="queue-btn-label">{showQueue ? 'Player' : 'Queue'}</span>
              </button>
            )}
            <button
              type="button"
              className="now-playing-icon-btn"
              onClick={onClose}
              title="Close"
              aria-label="Close"
            >
              <X size={20} />
            </button>
          </div>
        </header>

        {/* Main Content Area */}
        <div className="now-playing-body">
          {showQueue && hasPlaylistQueue ? (
            /* Queue / Playlist View */
            <div className="now-playing-queue-pane">
              <div className="now-playing-queue-toolbar">
                <div>
                  <h2 className="now-playing-queue-title">Playing Queue</h2>
                  <p className="now-playing-queue-subtitle">
                    Starting at current track ({queueIndex + 1} of {queue.length})
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setShowQueue(false)}
                >
                  <Disc size={15} style={{ marginRight: 6 }} />
                  Now Playing
                </button>
              </div>

              <div className="now-playing-queue-list" ref={queueListRef}>
                {queue.map((track, idx) => {
                  const isCurrent = idx === queueIndex;
                  const trackTitle = track.kind === 'track' ? stripTrackNumber(track.title) : track.title;
                  const trackArtist = track.artist || track.author || 'Unknown Artist';

                  return (
                    <div
                      key={track.id || idx}
                      ref={isCurrent ? activeRowRef : null}
                      className={`now-playing-queue-row ${isCurrent ? 'active' : ''}`}
                      onClick={() => onPlayQueueAt && onPlayQueueAt(idx)}
                    >
                      <div className="now-playing-queue-idx">
                        {isCurrent ? (
                          <div className="now-playing-equalizer" title="Currently playing">
                            <span className="eq-bar bar-1"></span>
                            <span className="eq-bar bar-2"></span>
                            <span className="eq-bar bar-3"></span>
                          </div>
                        ) : (
                          <span>{idx + 1}</span>
                        )}
                      </div>

                      <div className="now-playing-queue-thumb">
                        {track.coverUrl ? (
                          <img src={track.coverUrl} alt="" loading="lazy" />
                        ) : (
                          <div className="queue-thumb-placeholder">
                            <Music2 size={16} />
                          </div>
                        )}
                      </div>

                      <div className="now-playing-queue-meta">
                        <div className="now-playing-queue-song">{trackTitle}</div>
                        <div className="now-playing-queue-artist">{trackArtist}</div>
                      </div>

                      <div className="now-playing-queue-duration">
                        {track.durationSec ? formatDuration(track.durationSec) : '--:--'}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            /* Standard Now Playing View (Car-Mode inspired large artwork layout) */
            <div className="now-playing-main-card">
              {/* Large Cover Art with Glow */}
              <div className="now-playing-artwork-wrap">
                <div className="now-playing-cover-glow" style={{ backgroundImage: `url(${coverSrc})` }} />
                <div className="now-playing-cover-box">
                  {coverSrc ? (
                    <img src={coverSrc} alt={title} className="now-playing-cover-img" />
                  ) : (
                    <div className="now-playing-cover-fallback">
                      <Music2 size={72} />
                    </div>
                  )}
                </div>
              </div>

              {/* Song & Artist Info */}
              <div className="now-playing-info-box">
                <div className="now-playing-text-row">
                  <div className="now-playing-title-wrap">
                    <h1 className="now-playing-title" title={title}>{title}</h1>
                    <p className="now-playing-subtitle">
                      {subtitle}{album ? ` • ${album}` : ''}
                    </p>
                  </div>

                  <button
                    type="button"
                    className={`now-playing-heart-btn ${isFavorite ? 'active' : ''}`}
                    onClick={onToggleFavorite}
                    title={isFavorite ? 'Remove from favourites' : 'Add to favourites'}
                    aria-label={isFavorite ? 'Remove from favourites' : 'Add to favourites'}
                  >
                    <Heart size={26} fill={isFavorite ? 'currentColor' : 'none'} />
                  </button>
                </div>

                {/* Scrubber / Progress Bar */}
                <div className="now-playing-scrub-box">
                  <input
                    type="range"
                    className="now-playing-slider"
                    min={0}
                    max={Math.max(1, Math.floor(effectiveDuration))}
                    step={1}
                    value={Math.floor(currentPos)}
                    onChange={(e) => setScrubPosition(Number(e.target.value))}
                    onPointerUp={(e) => handleCommitScrub(Number(e.target.value))}
                    onKeyUp={(e) => handleCommitScrub(Number(e.target.value))}
                    aria-label="Seek"
                  />
                  <div className="now-playing-time-row">
                    <span>{formatDuration(currentPos)}</span>
                    <span>{effectiveDuration > 0 ? formatDuration(effectiveDuration) : '--:--'}</span>
                  </div>
                </div>

                {/* Primary Transport Controls */}
                <div className="now-playing-controls">
                  {onToggleShuffle && (
                    <button
                      type="button"
                      className={`now-playing-btn-sub ${shuffle ? 'active' : ''}`}
                      onClick={onToggleShuffle}
                      title={shuffle ? 'Shuffle: On' : 'Shuffle: Off'}
                    >
                      <Shuffle size={20} />
                    </button>
                  )}

                  <button
                    type="button"
                    className="now-playing-btn-round"
                    onClick={() => onSeekBy(-15)}
                    title="Rewind 15s"
                  >
                    <RotateCcw size={20} />
                    <span>-15s</span>
                  </button>

                  <button
                    type="button"
                    className="now-playing-btn-skip"
                    onClick={onPrev}
                    disabled={!hasPrev}
                    title="Previous track"
                  >
                    <SkipBack size={26} fill="currentColor" />
                  </button>

                  <button
                    type="button"
                    className="now-playing-btn-play"
                    onClick={onTogglePlay}
                    title={playing ? 'Pause' : 'Play'}
                  >
                    {playing ? (
                      <Pause size={36} fill="currentColor" />
                    ) : (
                      <Play size={36} fill="currentColor" style={{ marginLeft: 3 }} />
                    )}
                  </button>

                  <button
                    type="button"
                    className="now-playing-btn-skip"
                    onClick={onNext}
                    disabled={!hasNext}
                    title="Next track"
                  >
                    <SkipForward size={26} fill="currentColor" />
                  </button>

                  <button
                    type="button"
                    className="now-playing-btn-round"
                    onClick={() => onSeekBy(30)}
                    title="Forward 30s"
                  >
                    <RotateCw size={20} />
                    <span>+30s</span>
                  </button>

                  {item.kind !== 'track' && onCycleRate && (
                    <button
                      type="button"
                      className="now-playing-btn-sub"
                      onClick={onCycleRate}
                      title={`Speed (${RATES[rateIndex]}x)`}
                    >
                      <Gauge size={18} />
                      <span style={{ fontSize: '0.7rem', fontWeight: 800 }}>{RATES[rateIndex]}×</span>
                    </button>
                  )}
                </div>

                {/* Queue Pill / Switcher Button */}
                {hasPlaylistQueue && (
                  <div className="now-playing-queue-pill-wrap">
                    <button
                      type="button"
                      className="now-playing-queue-pill"
                      onClick={() => setShowQueue(true)}
                    >
                      <ListMusic size={18} />
                      <span>
                        Open Playlist Queue <strong>({queueIndex + 1} of {queue.length})</strong>
                      </span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
