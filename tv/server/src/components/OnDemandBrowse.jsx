import React, { useState, useEffect } from 'react';
import { Film, Tv, Play, Folder, Search, HardDrive, RefreshCw, Heart, Download, Check } from 'lucide-react';
import { downloadVideoForOffline, getAllOfflineVideos, deleteOfflineVideo } from '../utils/offlineStorage.js';

const buildDownloadUrl = (item) => {
  const fileId = item.driveId || item.id;
  const name = item.filename || `${item.title || 'video'}.mp4`;
  return `/api/stream/drive/${encodeURIComponent(fileId)}/${encodeURIComponent(name)}?download=1`;
};

export default function OnDemandBrowse({ library = {}, onPlayVideo, onOpenSettings, favorites = [], onToggleFavorite }) {
  const [filter, setFilter] = useState('all'); // 'all' | 'tv' | 'movies'
  const [search, setSearch] = useState('');
  const [selectedShow, setSelectedShow] = useState(null);
  const [selectedSeason, setSelectedSeason] = useState(1);
  const [offlineMap, setOfflineMap] = useState({});

  useEffect(() => {
    let mounted = true;
    getAllOfflineVideos().then(savedList => {
      if (!mounted) return;
      const map = {};
      savedList.forEach(v => {
        map[v.id] = { isSaved: true, progress: 100 };
      });
      setOfflineMap(map);
    }).catch(() => {});

    const handleUpdate = () => {
      getAllOfflineVideos().then(savedList => {
        if (!mounted) return;
        const map = {};
        savedList.forEach(v => {
          map[v.id] = { isSaved: true, progress: 100 };
        });
        setOfflineMap(map);
      }).catch(() => {});
    };

    window.addEventListener('freevee_offline_updated', handleUpdate);
    return () => {
      mounted = false;
      window.removeEventListener('freevee_offline_updated', handleUpdate);
    };
  }, []);

  const handleSaveOffline = async (item, e) => {
    e?.stopPropagation?.();
    const id = item.driveId || item.id;
    if (offlineMap[id]?.isSaved) {
      if (confirm(`Remove "${item.title || item.filename}" from offline storage?`)) {
        await deleteOfflineVideo(id);
        setOfflineMap(prev => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
      }
      return;
    }

    setOfflineMap(prev => ({
      ...prev,
      [id]: { isDownloading: true, progress: 5, message: 'Starting...' }
    }));

    try {
      await downloadVideoForOffline(item, ({ percent, message }) => {
        setOfflineMap(prev => ({
          ...prev,
          [id]: { isDownloading: true, progress: percent, message }
        }));
      });
      setOfflineMap(prev => ({
        ...prev,
        [id]: { isSaved: true, isDownloading: false, progress: 100 }
      }));
    } catch (err) {
      alert(`Could not save video offline: ${err.message}`);
      setOfflineMap(prev => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  };

  const shows = library.shows || {};
  const showsList = library.showsList || [];
  const showsPosters = library.showsPosters || {};
  const movies = library.movies || [];

  const filteredShows = showsList.filter(s => s.toLowerCase().includes(search.toLowerCase()));
  const filteredMovies = movies.filter(m => (m.title || m.filename || '').toLowerCase().includes(search.toLowerCase()));

  const hasContent = showsList.length > 0 || movies.length > 0;

  if (!hasContent) {
    return (
      <div className="empty-state" style={{ padding: '60px 24px', textAlign: 'center' }}>
        <HardDrive size={44} style={{ color: 'var(--primary)', marginBottom: '14px' }} />
        <h2 style={{ fontSize: '20px', fontWeight: 700, margin: '0 0 8px' }}>Your Google Drive Library is Empty</h2>
        <p style={{ fontSize: '13.5px', color: 'var(--text-secondary)', maxWidth: '420px', margin: '0 auto 20px', lineHeight: 1.5 }}>
          Connect your Google Drive TV Shows and Movies folders in settings and run a scan to start streaming.
        </p>
        <button className="action-btn primary" onClick={onOpenSettings} style={{ padding: '10px 22px', fontSize: '13px' }}>
          Open Drive Settings
        </button>
      </div>
    );
  }

  return (
    <div className="page-with-sticky-filter" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* Header Bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: '12px', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <h1 style={{ fontSize: '20px', fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
            Google Drive Media
          </h1>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>
            {showsList.length} Shows · {movies.length} Movies
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {/* Desktop Filter */}
          <div className="category-filter-container desktop-only">
            {['all', 'tv', 'movies'].map(f => (
              <button
                key={f}
                onClick={() => { setFilter(f); setSelectedShow(null); }}
                className={`category-filter-btn ${filter === f ? 'active' : ''}`}
              >
                {f === 'all' ? 'All' : f === 'tv' ? 'TV Shows' : 'Movies'}
              </button>
            ))}
          </div>

          <input
            type="text"
            placeholder="Search personal library..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ padding: '6px 12px', fontSize: '12px', borderRadius: '6px', border: '1px solid var(--border-color)', background: 'rgba(255,255,255,0.06)', color: 'var(--text-primary)', width: '180px' }}
          />
        </div>
      </div>

      {/* Sticky Mobile Filter Footer */}
      <div className="sticky-mobile-filter">
        <div className="category-filter-container">
          {['all', 'tv', 'movies'].map(f => (
            <button
              key={f}
              onClick={() => { setFilter(f); setSelectedShow(null); }}
              className={`category-filter-btn ${filter === f ? 'active' : ''}`}
            >
              {f === 'all' ? 'All' : f === 'tv' ? 'TV Shows' : 'Movies'}
            </button>
          ))}
        </div>
      </div>

      {/* TV Shows Section */}
      {(filter === 'all' || filter === 'tv') && filteredShows.length > 0 && !selectedShow && (
        <div>
          <h2 style={{ fontSize: '16px', fontWeight: 700, marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Tv size={18} style={{ color: 'var(--primary)' }} /> TV Series ({filteredShows.length})
          </h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '16px' }}>
            {filteredShows.map(showName => {
              const seasons = shows[showName] || {};
              const seasonCount = Object.keys(seasons).length;
              const poster = showsPosters[showName];
              const fav = favorites.some(f => f.title && f.title.toLowerCase() === showName.toLowerCase());

              return (
                <div
                  key={showName}
                  className="glass-panel"
                  style={{
                    padding: '8px',
                    borderRadius: '12px',
                    cursor: 'pointer',
                    border: '1px solid var(--border-color)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '8px',
                    transition: 'all 0.2s ease',
                    position: 'relative',
                    overflow: 'hidden'
                  }}
                  onClick={() => { setSelectedShow(showName); setSelectedSeason(Object.keys(seasons)[0] || '1'); }}
                >
                  {/* Heart Toggle */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (onToggleFavorite) onToggleFavorite({ title: showName, type: 'tv', image: poster });
                    }}
                    title={fav ? 'Remove from favorites' : 'Add to favorites'}
                    style={{
                      position: 'absolute',
                      top: '12px',
                      right: '12px',
                      zIndex: 10,
                      background: 'rgba(0, 0, 0, 0.65)',
                      backdropFilter: 'blur(4px)',
                      border: '1px solid rgba(255, 255, 255, 0.15)',
                      borderRadius: '50%',
                      width: '28px',
                      height: '28px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer',
                      color: fav ? 'var(--accent)' : 'rgba(255,255,255,0.7)',
                      transition: 'all 0.2s ease'
                    }}
                  >
                    <Heart size={14} fill={fav ? 'var(--accent)' : 'none'} />
                  </button>

                  <div
                    style={{
                      width: '100%',
                      aspectRatio: '2/3',
                      borderRadius: '8px',
                      background: 'linear-gradient(135deg, rgba(139, 92, 246, 0.2) 0%, rgba(20, 20, 28, 0.8) 100%)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: 'var(--primary)',
                      overflow: 'hidden',
                      position: 'relative'
                    }}
                  >
                    {poster ? (
                      <img
                        src={poster}
                        alt={showName}
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                        loading="lazy"
                        onError={(e) => { e.target.style.display = 'none'; }}
                      />
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', padding: '12px', textAlign: 'center' }}>
                        <Tv size={36} />
                        <span style={{ fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 600 }}>{showName}</span>
                      </div>
                    )}
                  </div>
                  <div style={{ padding: '0 4px 4px' }}>
                    <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {showName}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                      {seasonCount} Season{seasonCount !== 1 ? 's' : ''}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Selected TV Show Episodes Drill Down */}
      {selectedShow && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <button className="action-btn" onClick={() => setSelectedShow(null)} style={{ padding: '6px 12px', fontSize: '12px' }}>
              ← All Shows
            </button>
            <h2 style={{ fontSize: '18px', fontWeight: 700, margin: 0 }}>{selectedShow}</h2>
          </div>

          <div style={{ display: 'flex', gap: '8px', overflowX: 'auto' }}>
            {Object.keys(shows[selectedShow] || {}).map(s => (
              <button
                key={s}
                onClick={() => setSelectedSeason(s)}
                style={{
                  padding: '6px 14px',
                  fontSize: '12px',
                  fontWeight: 600,
                  borderRadius: '6px',
                  border: '1px solid var(--border-color)',
                  background: selectedSeason === s ? 'var(--primary)' : 'rgba(255,255,255,0.04)',
                  color: selectedSeason === s ? '#000' : 'var(--text-secondary)',
                  cursor: 'pointer'
                }}
              >
                Season {s}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {(shows[selectedShow]?.[selectedSeason] || []).map(ep => (
              <div
                key={ep.id}
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderRadius: '8px', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-color)' }}
              >
                <div>
                  <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--primary)', marginRight: '8px' }}>E{ep.episode}</span>
                  <span style={{ fontSize: '13px', fontWeight: 600 }}>{ep.title}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <button
                    className="action-btn"
                    onClick={(e) => handleSaveOffline(ep, e)}
                    disabled={offlineMap[ep.id]?.isDownloading}
                    title={offlineMap[ep.id]?.isSaved ? 'Saved for offline (click to remove)' : 'Save video to offline storage'}
                    style={{
                      padding: '6px 12px',
                      fontSize: '12px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px',
                      color: offlineMap[ep.id]?.isSaved ? '#10b981' : 'inherit',
                      borderColor: offlineMap[ep.id]?.isSaved ? 'rgba(16, 185, 129, 0.4)' : undefined,
                      background: offlineMap[ep.id]?.isSaved ? 'rgba(16, 185, 129, 0.1)' : undefined
                    }}
                  >
                    {offlineMap[ep.id]?.isSaved ? <Check size={12} color="#10b981" /> : <Download size={12} />}
                    <span>
                      {offlineMap[ep.id]?.isDownloading
                        ? `${offlineMap[ep.id].progress}%`
                        : (offlineMap[ep.id]?.isSaved ? 'Saved Offline' : 'Save Offline')}
                    </span>
                  </button>
                  <a
                    className="action-btn"
                    href={buildDownloadUrl(ep)}
                    download={ep.filename || `${ep.title}.mp4`}
                    title="Download video file to device"
                    style={{ padding: '6px 10px', fontSize: '12px', display: 'flex', alignItems: 'center', textDecoration: 'none' }}
                  >
                    <Download size={12} />
                  </a>
                  <button className="action-btn primary" onClick={() => onPlayVideo(ep)} style={{ padding: '6px 14px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <Play size={12} fill="#000" /> Play
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Movies Section */}
      {(filter === 'all' || filter === 'movies') && filteredMovies.length > 0 && !selectedShow && (
        <div style={{ marginTop: '10px' }}>
          <h2 style={{ fontSize: '16px', fontWeight: 700, marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Film size={18} style={{ color: '#22d3ee' }} /> Movies ({filteredMovies.length})
          </h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '16px' }}>
            {filteredMovies.map(movie => {
              const fav = favorites.some(f => f.title && f.title.toLowerCase() === (movie.title || '').toLowerCase());
              return (
                <div
                  key={movie.id}
                  className="glass-panel"
                  style={{
                    padding: '8px',
                    borderRadius: '12px',
                    cursor: 'pointer',
                    border: '1px solid var(--border-color)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '8px',
                    transition: 'all 0.2s ease',
                    position: 'relative',
                    overflow: 'hidden'
                  }}
                  onClick={() => onPlayVideo(movie)}
                >
                  {/* Heart Toggle */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (onToggleFavorite) onToggleFavorite(movie);
                    }}
                    title={fav ? 'Remove from favorites' : 'Add to favorites'}
                    style={{
                      position: 'absolute',
                      top: '12px',
                      right: '12px',
                      zIndex: 10,
                      background: 'rgba(0, 0, 0, 0.65)',
                      backdropFilter: 'blur(4px)',
                      border: '1px solid rgba(255, 255, 255, 0.15)',
                      borderRadius: '50%',
                      width: '28px',
                      height: '28px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer',
                      color: fav ? 'var(--accent)' : 'rgba(255,255,255,0.7)',
                      transition: 'all 0.2s ease'
                    }}
                  >
                    <Heart size={14} fill={fav ? 'var(--accent)' : 'none'} />
                  </button>

                  {/* Save for Offline Button */}
                  <button
                    onClick={(e) => handleSaveOffline(movie, e)}
                    disabled={offlineMap[movie.driveId || movie.id]?.isDownloading}
                    title={offlineMap[movie.driveId || movie.id]?.isSaved ? 'Saved for offline (tap to remove)' : 'Save video to offline storage'}
                    style={{
                      position: 'absolute',
                      top: '12px',
                      left: '12px',
                      zIndex: 10,
                      background: offlineMap[movie.driveId || movie.id]?.isSaved ? 'rgba(16, 185, 129, 0.85)' : 'rgba(0, 0, 0, 0.65)',
                      backdropFilter: 'blur(4px)',
                      border: offlineMap[movie.driveId || movie.id]?.isSaved ? '1px solid #10b981' : '1px solid rgba(255, 255, 255, 0.15)',
                      borderRadius: '50%',
                      width: '28px',
                      height: '28px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer',
                      color: '#fff'
                    }}
                  >
                    {offlineMap[movie.driveId || movie.id]?.isSaved ? (
                      <Check size={14} />
                    ) : offlineMap[movie.driveId || movie.id]?.isDownloading ? (
                      <span style={{ fontSize: '9px', fontWeight: 'bold' }}>{offlineMap[movie.driveId || movie.id].progress}%</span>
                    ) : (
                      <Download size={14} />
                    )}
                  </button>

                  <div
                    style={{
                      width: '100%',
                      aspectRatio: '2/3',
                      borderRadius: '8px',
                      background: 'linear-gradient(135deg, rgba(34, 211, 238, 0.2) 0%, rgba(20, 20, 28, 0.8) 100%)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: '#22d3ee',
                      overflow: 'hidden',
                      position: 'relative'
                    }}
                  >
                    {movie.posterUrl ? (
                      <img
                        src={movie.posterUrl}
                        alt={movie.title}
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                        loading="lazy"
                        onError={(e) => { e.target.style.display = 'none'; }}
                      />
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', padding: '12px', textAlign: 'center' }}>
                        <Film size={36} />
                        <span style={{ fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 600 }}>{movie.title}</span>
                      </div>
                    )}
                  </div>
                  <div style={{ padding: '0 4px 4px' }}>
                    <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {movie.title}
                    </div>
                    {movie.year && (
                      <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                        {movie.year}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
