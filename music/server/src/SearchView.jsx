import { useState, useEffect, useRef, useCallback } from 'react';
import { Search as SearchIcon, Play, Download } from 'lucide-react';
import { api } from './api';
import MediaCard from './MediaCard';
import AddToPlaylistModal from './AddToPlaylistModal';
import { formatLengthShort, stripTrackNumber } from './format';

const DEBOUNCE_MS = 350;

/**
 * Searches both sides at once: the local library (instant) and the matching online
 * catalogue (AudioBookBay for books, YouTube Music for music), proxied by the server.
 * Out-of-order responses are discarded with an AbortController so fast typing can't
 * leave stale results on screen.
 */
export default function SearchView({ kind = 'audiobooks', user, onOpenDrivePicker, onPlay, onToggleFavorite, onNavigate, notify }) {
  const [query, setQuery] = useState('');
  const [local, setLocal] = useState([]);
  const [online, setOnline] = useState([]);
  const [artists, setArtists] = useState([]);
  const [albums, setAlbums] = useState([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState(null);
  const [playlistTarget, setPlaylistTarget] = useState(null);
  const abortRef = useRef(null);

  const isMusic = kind === 'music';

  const run = useCallback(async (q) => {
    const trimmed = q.trim();
    if (trimmed.length < 2) {
      setLocal([]);
      setOnline([]);
      setArtists([]);
      setAlbums([]);
      setSearching(false);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setSearching(true);
    setError(null);

    try {
      const data = await api.search(trimmed, kind, controller.signal);
      if (controller.signal.aborted) return;
      setLocal(Array.isArray(data.local) ? data.local : []);
      setOnline(Array.isArray(data.online) ? data.online : []);
      setArtists(Array.isArray(data.artists) ? data.artists : []);
      setAlbums(Array.isArray(data.albums) ? data.albums : []);
    } catch (err) {
      if (err.name === 'AbortError' || controller.signal.aborted) return;
      setError(err.message || 'Search failed.');
    } finally {
      if (!controller.signal.aborted) setSearching(false);
    }
  }, [kind]);

  useEffect(() => {
    const timer = setTimeout(() => run(query), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, run]);

  const handleStartDownload = useCallback(async (item) => {
    if (!user?.audiobooksFolderId) {
      notify('Pick an audiobooks folder first', 'Downloads need a Drive folder to upload into.', true);
      onOpenDrivePicker('audiobooks');
      return;
    }
    if (!item?.url) {
      onNavigate('whats-new');
      return;
    }
    try {
      await api.startDownload(item.url);
      notify('Download started', item.title || 'Audiobook');
      onNavigate('downloads');
    } catch (err) {
      notify('Could not start download', err.message, true);
    }
  }, [user?.audiobooksFolderId, notify, onOpenDrivePicker, onNavigate]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const localWithCovers = local.map((item) => ({ ...item, coverUrl: item.coverUrl || api.coverUrl(item.id) }));

  const total = local.length + online.length + artists.length + albums.length;
  const sourceName = isMusic ? 'YouTube Music' : 'AudioBookBay';

  return (
    <>
      <div className="view-header">
        <h1 className="view-title">Search</h1>
        <p className="view-subtitle">
          {isMusic
            ? 'Your music library and YouTube Music, at the same time.'
            : 'Your library and AudioBookBay, at the same time.'}
        </p>
      </div>

      <div className="toolbar">
        <div className="toolbar-search">
          <SearchIcon className="toolbar-search-icon" size={16} />
          <input
            type="search"
            className="input-field"
            placeholder={isMusic
              ? 'Search songs, artists, albums…'
              : 'Search titles, authors, narrators, albums…'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {query.trim().length < 2 ? (
        <div className="empty-state">
          <SearchIcon size={40} style={{ color: 'var(--text-muted)', margin: '0 auto 1rem' }} />
          <h3>Type at least two characters</h3>
          <p>Results from your Drive library appear instantly; {sourceName} matches show alongside.</p>
        </div>
      ) : searching ? (
        <div className="loading-state">
          <div className="spinner" />
          <p>Searching…</p>
        </div>
      ) : total === 0 ? (
        <div className="empty-state">
          <SearchIcon size={40} style={{ color: 'var(--text-muted)', margin: '0 auto 1rem' }} />
          <h3>No matches for &ldquo;{query.trim()}&rdquo;</h3>
          <p>Try fewer words, or check the spelling of the title and author.</p>
        </div>
      ) : (
        <>
          {local.length > 0 && (
            <>
              <div className="section-head">
                <span className="section-title">In your library</span>
                <span className="section-count">{local.length}</span>
              </div>
              <div className="media-grid dense">
                {localWithCovers.map((item) => (
                  <MediaCard
                    key={item.id}
                    item={item}
                    context={localWithCovers}
                    onPlay={onPlay}
                    onToggleFavorite={onToggleFavorite}
                    onAddToPlaylist={(single) => setPlaylistTarget([single])}
                  />
                ))}
              </div>
            </>
          )}

          {artists.length > 0 && (
            <>
              <div className="section-head">
                <span className="section-title">Artists on YouTube Music</span>
                <span className="section-count">{artists.length}</span>
              </div>
              <div className="media-grid">
                {artists.map((artist) => (
                  <div key={artist.channelId} className="media-card">
                    <div className="media-cover">
                      {artist.thumbnail
                        ? <img src={artist.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" />
                        : null}
                      <div className="media-play-overlay">
                        <button
                          type="button"
                          className="media-play-button"
                          style={{ background: 'var(--panel-hover)', color: 'var(--accent-color)' }}
                          onClick={() => onNavigate('whats-new', { searchQuery: artist.title })}
                          title={`See ${artist.title}'s albums`}
                        >
                          <SearchIcon size={19} />
                        </button>
                      </div>
                    </div>
                    <div className="media-title">{artist.title}</div>
                    <div className="media-subtitle">
                      {artist.subscribers || 'Artist'}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {online.length > 0 && (
            <>
              <div className="section-head">
                <span className="section-title">On {sourceName}</span>
                <span className="section-count">{online.length}</span>
              </div>
              {isMusic ? (
                <div className="media-grid">
                  {online.map((song) => (
                    <div key={song.videoId} className="media-card">
                      <div className="media-cover">
                        {song.thumbnail
                          ? <img src={song.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" />
                          : null}
                        <div className="media-badges">
                          {song.durationSec
                            ? <span className="badge">{formatLengthShort(song.durationSec)}</span>
                            : null}
                        </div>
                      </div>
                      <div className="media-title">{stripTrackNumber(song.title)}</div>
                      <div className="media-subtitle">
                        {[song.artist, song.album].filter(Boolean).join(' · ') || 'Song'}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="media-grid">
                  {online.map((item) => (
                    <div key={item.id || item.url} className="media-card">
                      <div className="media-cover">
                        {item.cover
                          ? <img src={item.cover} alt="" loading="lazy" referrerPolicy="no-referrer" />
                          : null}
                        <div className="media-badges">
                          {item.inLibrary && <span className="badge badge-success">Owned</span>}
                        </div>
                        <div className="media-play-overlay">
                          <button
                            type="button"
                            className="media-play-button"
                            style={{ background: 'var(--panel-hover)', color: 'var(--accent-color)' }}
                            onClick={() => handleStartDownload(item)}
                          >
                            <Download size={19} />
                          </button>
                        </div>
                      </div>
                      <div className="media-title">{item.title}</div>
                      <div className="media-subtitle">
                        {[item.author, item.length].filter(Boolean).join(' · ') || 'View on AudioBookBay'}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <p style={{ marginTop: '1.5rem' }}>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => onNavigate(isMusic ? 'music-whats-new' : 'whats-new')}
                >
                  <Play size={13} />
                  {isMusic ? 'Browse New Releases to download' : "Browse What's New to download"}
                </button>
              </p>
            </>
          )}
        </>
      )}

      {!user?.audiobooksFolderId && !user?.musicFolderId && (
        <div className="job-card" style={{ marginTop: '2rem' }}>
          <div className="job-head">
            <div>
              <div className="job-title">No Drive folder connected</div>
              <div className="job-phase">Your library is empty until you point FRAUDIO at a folder.</div>
            </div>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => onOpenDrivePicker('audiobooks')}>
              Choose folder
            </button>
          </div>
        </div>
      )}

      <AddToPlaylistModal
        isOpen={Boolean(playlistTarget)}
        items={playlistTarget || []}
        onClose={() => setPlaylistTarget(null)}
        kind={kind}
        notify={notify}
      />
    </>
  );
}