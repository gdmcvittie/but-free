import { memo } from 'react';
import { Play, Heart, HardDriveDownload, HardDrive, ListPlus } from 'lucide-react';
import { api } from './api';
import { formatLengthShort, percentOf, stripTrackNumber } from './format';

/**
 * One library item: cover, title, progress bar and hover actions.
 *
 * Supports both single tracks/audiobooks and multi-part consolidated books.
 * `context` is the full list the user is browsing, so starting playback queues
 * everything they can see rather than just this card.
 */
function MediaCard({
  item,
  context,
  onPlay,
  onToggleFavorite,
  onCacheOffline,
  onAddToPlaylist,
  onOpenBook,
  busy
}) {
  const durationSec = item.durationSec || 0;
  const positionSec = item.progressSec ?? item.progress?.positionSec ?? 0;
  const percent = percentOf(positionSec, durationSec);
  const isTrack = item.kind === 'track';
  const isMultiPart = Boolean(item.isMultiPart || (item.partsCount && item.partsCount > 1));

  const baseSubtitle = isTrack
    ? [item.artist || item.albumArtist, item.title === item.album ? null : item.album]
        .filter(Boolean)
        .join(' — ') || 'Unknown artist'
    : item.narrator
      ? `Read by ${item.narrator}`
      : item.author || 'Unknown author';

  const subtitle = isMultiPart
    ? `${baseSubtitle} · ${item.partsCount} chapters`
    : baseSubtitle;

  const handleCardClick = () => {
    if (isMultiPart && onOpenBook) {
      onOpenBook(item);
    } else {
      onPlay(item, context);
    }
  };

  const handlePlayOverlay = (e) => {
    e.stopPropagation();
    onPlay(item, context);
  };

  return (
    <div className={`media-card ${isMultiPart ? 'media-card-multipart' : ''}`}>
      <div className="media-cover" onClick={handleCardClick} title={item.title}>
        <img src={item.coverUrl || api.coverUrl(item.id)} alt="" loading="lazy" />

        <div className="media-badges">
          {item.offline && (
            <span className="badge badge-success" title="Available offline">
              <HardDrive size={10} />
            </span>
          )}
          {item.abridged === true && <span className="badge badge-warning">Abridged</span>}
          {isTrack && item.trackNumber ? (
            <span className="badge badge-muted" style={{ marginLeft: 'auto' }}>{item.trackNumber}</span>
          ) : null}
          {isMultiPart && (
            <span className="badge badge-primary" style={{ marginLeft: 'auto' }} title={`${item.partsCount} chapters`}>
              {item.partsCount} chapters
            </span>
          )}
        </div>

        <div className="media-play-overlay" onClick={handlePlayOverlay} title={`Play ${item.title}`}>
          <div className="media-play-button">
            <Play size={20} fill="currentColor" />
          </div>
        </div>
      </div>

      {percent !== null && percent > 0 && percent < 98 && (
        <div className="media-progress" title={`${Math.round(percent)}% complete`}>
          <div className="media-progress-fill" style={{ width: `${percent}%` }} />
        </div>
      )}

      <div className="media-title" onClick={handleCardClick} title={isTrack ? stripTrackNumber(item.title) : item.title}>
        {isTrack ? stripTrackNumber(item.title) : item.title}
      </div>
      <div className="media-subtitle" title={subtitle}>
        {subtitle}
        {formatLengthShort(durationSec) ? ` · ${formatLengthShort(durationSec)}` : ''}
      </div>

      <div className="media-actions">
        <button
          type="button"
          className={`icon-btn ${item.favorite ? 'active' : ''}`}
          title={item.favorite ? 'Remove from favourites' : 'Add to favourites'}
          disabled={busy}
          onClick={() => onToggleFavorite?.(item, !item.favorite)}
        >
          <Heart size={13} fill={item.favorite ? 'currentColor' : 'none'} />
        </button>

        <button
          type="button"
          className="icon-btn"
          title={item.offline ? 'Remove offline copy' : 'Download for offline play'}
          disabled={busy}
          onClick={() => onCacheOffline?.(item)}
        >
          {item.offline ? <HardDrive size={13} /> : <HardDriveDownload size={13} />}
        </button>

        <button
          type="button"
          className="icon-btn"
          title="Add to playlist"
          disabled={busy}
          onClick={() => onAddToPlaylist?.(item)}
        >
          <ListPlus size={13} />
        </button>
      </div>
    </div>
  );
}

export default memo(MediaCard);