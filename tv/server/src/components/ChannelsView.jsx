import React, { useState, useEffect } from 'react';
import { Tv, Film, Radio, Play, RefreshCw, Search, AlertCircle, Heart as HeartSvg, Clock, Sparkles } from 'lucide-react';

function formatDuration(ms) {
  if (!ms || ms <= 0) return null;
  const hours = Math.floor(ms / 3600);
  const minutes = Math.floor((ms % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export default function ChannelsView({ onPlayChannel, favorites = [], onToggleFavorite }) {
  const [channels, setChannels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');

  const loadChannels = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/drive/channels');
      const data = await res.json();
      setChannels(Array.isArray(data.channels) ? data.channels : []);
    } catch (err) {
      console.error('Error loading channels:', err);
      setError('Failed to load channels from your Google Drive.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadChannels();
  }, []);

  const q = search.trim().toLowerCase();
  const filtered = q
    ? channels.filter(c => c.name.toLowerCase().includes(q))
    : channels;

  const featuredChannels = filtered.filter(c => c.channelType === 'new_episodes' || c.channelType === 'movies');
  const genreChannels = filtered.filter(c => c.channelType === 'genre');
  const showChannels = filtered.filter(c => c.channelType === 'show');

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '60px 0', gap: '12px' }}>
        <RefreshCw size={22} className="spin" style={{ color: 'var(--primary)' }} />
        <span style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>Loading your channels...</span>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: 800, margin: 0, display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Radio size={20} style={{ color: 'var(--primary)' }} /> My Drive Channels
          </h1>
          <p style={{ fontSize: '12.5px', color: 'var(--text-secondary)', margin: '4px 0 0' }}>
            Linear playlists from your Google Drive. Tune in and let it play continuously.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <button className="action-btn" onClick={loadChannels} title="Refresh channels" style={{ padding: '7px 10px', display: 'flex' }}>
            <RefreshCw size={14} className={loading ? 'spin' : ''} />
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 12px', borderRadius: '6px', border: '1px solid var(--border-color)', background: 'rgba(255,255,255,0.06)' }}>
            <Search size={14} style={{ color: 'var(--text-muted)' }} />
            <input
              type="text"
              placeholder="Search channels..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ background: 'transparent', border: 'none', outline: 'none', color: 'var(--text-primary)', fontSize: '12px', width: '170px' }}
            />
          </div>
        </div>
      </div>

      {error && (
        <div className="glass-panel" style={{ padding: '18px', display: 'flex', alignItems: 'center', gap: '10px', border: '1px solid rgba(239,68,68,0.3)', color: 'var(--text-primary)' }}>
          <AlertCircle size={18} style={{ color: 'var(--accent)' }} />
          <span style={{ fontSize: '13px', flex: 1 }}>{error}</span>
          <button className="action-btn" onClick={loadChannels}>Retry</button>
        </div>
      )}

      {!error && channels.length === 0 && (
        <div className="glass-panel" style={{ padding: '28px', textAlign: 'center', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px' }}>
          <Tv size={34} style={{ color: 'var(--primary)' }} />
          <div style={{ fontSize: '14px', fontWeight: 600 }}>
            No channels yet.
          </div>
          <div style={{ fontSize: '12.5px', maxWidth: '420px' }}>
            Scan your Google Drive in Settings to build channels. Each TV show becomes its own channel, plus movie genre channels.
          </div>
        </div>
      )}

      {/* Featured Channels - New Episodes + All Movies */}
      {featuredChannels.length > 0 && (
        <div>
          {!q && (
            <h2 style={{ fontSize: '16px', fontWeight: 700, marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Sparkles size={18} style={{ color: '#f59e0b' }} /> Featured
            </h2>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '16px' }}>
            {featuredChannels.map(ch => (
              <ChannelCard key={ch.id} channel={ch} onPlay={onPlayChannel} favorites={favorites} onToggleFavorite={onToggleFavorite} featured />
            ))}
          </div>
        </div>
      )}

      {/* Genre Channels */}
      {genreChannels.length > 0 && (
        <div>
          {!q && (
            <h2 style={{ fontSize: '16px', fontWeight: 700, marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Film size={18} style={{ color: '#22d3ee' }} /> Movie Genres ({genreChannels.length})
            </h2>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '16px' }}>
            {genreChannels.map(ch => (
              <ChannelCard key={ch.id} channel={ch} onPlay={onPlayChannel} favorites={favorites} onToggleFavorite={onToggleFavorite} />
            ))}
          </div>
        </div>
      )}

      {/* TV Show Channels */}
      {showChannels.length > 0 && (
        <div>
          {!q && (
            <h2 style={{ fontSize: '16px', fontWeight: 700, marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Tv size={18} style={{ color: 'var(--primary)' }} /> TV Shows ({showChannels.length})
            </h2>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '16px' }}>
            {showChannels.map(ch => (
              <ChannelCard key={ch.id} channel={ch} onPlay={onPlayChannel} favorites={favorites} onToggleFavorite={onToggleFavorite} />
            ))}
          </div>
        </div>
      )}

      {!error && filtered.length === 0 && channels.length > 0 && (
        <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-secondary)', fontSize: '13px' }}>
          No channels match "{search}".
        </div>
      )}
    </div>
  );
}

function ChannelCard({ channel, onPlay, favorites, onToggleFavorite, featured = false }) {
  const isMovie = channel.channelType === 'movies' || channel.channelType === 'genre';
  const isGenre = channel.channelType === 'genre';
  const isNewEpisodes = channel.channelType === 'new_episodes';
  const fav = favorites.some(f => f.title && f.title.toLowerCase() === channel.name.toLowerCase());

  const meta = (() => {
    const dur = formatDuration(channel.totalDuration) ? ` · ${formatDuration(channel.totalDuration)}` : '';
    if (isNewEpisodes) return `${channel.episodeCount || 0} episodes${dur}`;
    if (channel.channelType === 'movies') return `${channel.movieCount || 0} movies${dur}`;
    if (isGenre) return `${channel.movieCount || 0} movies${dur}`;
    return `${channel.episodeCount || 0} episodes${dur}`;
  })();

  const cardWidth = featured ? 180 : undefined;

  return (
    <div
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
        overflow: 'hidden',
        ...(featured ? { background: 'linear-gradient(135deg, rgba(245, 158, 11, 0.08) 0%, var(--bg-card, rgba(20,20,28,1)) 60%)' } : {})
      }}
      onClick={() => onPlay && onPlay(channel)}
    >
      {/* Heart Toggle */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          if (onToggleFavorite) onToggleFavorite({ title: channel.name, type: isMovie ? 'movie' : 'tv', image: channel.posterUrl });
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
        <HeartIcon fav={fav} />
      </button>

      {/* Poster / Placeholder */}
      <div
        style={{
          width: '100%',
          aspectRatio: '2/3',
          borderRadius: '8px',
          background: isNewEpisodes
            ? 'linear-gradient(135deg, rgba(245, 158, 11, 0.2) 0%, rgba(20, 20, 28, 0.8) 100%)'
            : isGenre
            ? 'linear-gradient(135deg, rgba(34, 211, 238, 0.18) 0%, rgba(20, 20, 28, 0.8) 100%)'
            : isMovie
            ? 'linear-gradient(135deg, rgba(34, 211, 238, 0.18) 0%, rgba(20, 20, 28, 0.8) 100%)'
            : 'linear-gradient(135deg, rgba(139, 92, 246, 0.2) 0%, rgba(20, 20, 28, 0.8) 100%)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: isNewEpisodes ? '#f59e0b' : isMovie ? '#22d3ee' : 'var(--primary)',
          overflow: 'hidden',
          position: 'relative'
        }}
      >
        {channel.posterUrl ? (
          <img
            src={channel.posterUrl}
            alt={channel.name}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            loading="lazy"
            onError={(e) => { e.target.style.display = 'none'; }}
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', padding: '12px', textAlign: 'center' }}>
            {isNewEpisodes ? <Clock size={36} /> : isMovie ? <Film size={36} /> : <Tv size={36} />}
            <span style={{ fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 600 }}>{channel.name}</span>
          </div>
        )}

        {/* Play overlay on hover */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(0,0,0,0.45)',
            opacity: 0,
            transition: 'opacity 0.2s ease',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: '8px'
          }}
          className="channel-play-overlay"
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'var(--primary, #f59e0b)', color: '#000', padding: '8px 16px', borderRadius: '24px', fontWeight: 700, fontSize: '13px' }}>
            <Play size={14} fill="#000" /> Tune In
          </div>
        </div>
      </div>

      <div style={{ padding: '0 4px 4px' }}>
        <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {channel.name}
        </div>
        <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px', display: 'flex', alignItems: 'center', gap: '4px' }}>
          <Radio size={10} /> {meta}
        </div>
      </div>
    </div>
  );
}

function HeartIcon({ fav }) {
  return <HeartSvg size={14} fill={fav ? 'var(--accent)' : 'none'} />;
}
