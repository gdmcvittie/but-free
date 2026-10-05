import React, { useState } from 'react';
import { Heart, Film, Tv, Play, Search, AlertCircle, Sparkles } from 'lucide-react';

export default function FavoritesView({ favorites = [], onToggleFavorite, onFind, onPlayVideo }) {
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [search, setSearch] = useState('');

  const filtered = favorites.filter(item => {
    if (categoryFilter !== 'all' && item.type !== categoryFilter) return false;
    if (search.trim()) {
      return (item.title || '').toLowerCase().includes(search.toLowerCase());
    }
    return true;
  });

  return (
    <div className="page-with-sticky-filter" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* Header Bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: '12px', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <h1 style={{ fontSize: '20px', fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px', margin: 0 }}>
            <Heart size={22} fill="var(--accent)" color="var(--accent)" />
            Favorites & Watchlist
          </h1>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>
            {favorites.length} saved title{favorites.length !== 1 ? 's' : ''} in your collection
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {/* Desktop Filter */}
          <div className="category-filter-container desktop-only">
            {['all', 'movie', 'tv'].map(f => (
              <button
                key={f}
                onClick={() => setCategoryFilter(f)}
                className={`category-filter-btn ${categoryFilter === f ? 'active' : ''}`}
              >
                {f === 'all' ? 'All' : f === 'movie' ? 'Movies' : 'TV Shows'}
              </button>
            ))}
          </div>

          <input
            type="text"
            placeholder="Search favorites..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ padding: '6px 12px', fontSize: '12px', borderRadius: '6px', border: '1px solid var(--border-color)', background: 'rgba(255,255,255,0.06)', color: 'var(--text-primary)', width: '160px' }}
          />
        </div>
      </div>

      {/* Sticky Mobile Filter Footer */}
      <div className="sticky-mobile-filter">
        <div className="category-filter-container">
          {['all', 'movie', 'tv'].map(f => (
            <button
              key={f}
              onClick={() => setCategoryFilter(f)}
              className={`category-filter-btn ${categoryFilter === f ? 'active' : ''}`}
            >
              {f === 'all' ? 'All' : f === 'movie' ? 'Movies' : 'TV Shows'}
            </button>
          ))}
        </div>
      </div>

      {/* Empty State */}
      {favorites.length === 0 ? (
        <div className="empty-state" style={{ padding: '60px 24px', textAlign: 'center' }}>
          <Heart size={44} style={{ color: 'var(--accent)', marginBottom: '14px', opacity: 0.8 }} />
          <h2 style={{ fontSize: '20px', fontWeight: 700, margin: '0 0 8px' }}>No Favorites Saved Yet</h2>
          <p style={{ fontSize: '13.5px', color: 'var(--text-secondary)', maxWidth: '420px', margin: '0 auto', lineHeight: 1.5 }}>
            Click the heart icon on any movie or TV show across Popular, Services, or Drive to pin it to your favorites.
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-state" style={{ padding: '40px', textAlign: 'center' }}>
          <AlertCircle size={28} style={{ color: 'var(--text-muted)' }} />
          <h2 style={{ fontSize: '16px', marginTop: '10px' }}>No matching favorites found</h2>
        </div>
      ) : (
        /* Favorites Grid */
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '14px' }}>
          {filtered.map((item, idx) => {
            const isMovie = item.type === 'movie';
            const poster = item.image || item.posterUrl || item.thumbnailUrl;

            return (
              <div
                key={`${item.title}_${idx}`}
                className="glass-panel"
                style={{
                  borderRadius: '8px',
                  overflow: 'hidden',
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  border: '1px solid var(--border-color)',
                  position: 'relative'
                }}
              >
                {/* Heart Toggle Button */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (onToggleFavorite) onToggleFavorite(item);
                  }}
                  title="Remove from favorites"
                  style={{
                    position: 'absolute',
                    top: '6px',
                    right: '6px',
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
                    color: 'var(--accent)'
                  }}
                >
                  <Heart size={14} fill="var(--accent)" />
                </button>

                <div
                  style={{ position: 'relative', aspectRatio: '2/3', background: 'rgba(0,0,0,0.4)', overflow: 'hidden' }}
                  onClick={() => {
                    if (item.path && onPlayVideo) onPlayVideo(item);
                    else if (onFind) onFind(item.title, item.type);
                  }}
                >
                  {poster ? (
                    <img src={poster} alt={item.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} loading="lazy" />
                  ) : (
                    <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
                      {isMovie ? <Film size={28} /> : <Tv size={28} />}
                    </div>
                  )}
                  <div style={{ position: 'absolute', top: '6px', left: '6px' }}>
                    <span style={{ fontSize: '8px', padding: '2px 5px', borderRadius: '3px', fontWeight: 'bold', background: 'rgba(0,0,0,0.75)', color: '#fff' }}>
                      {isMovie ? 'MOVIE' : 'TV'}
                    </span>
                  </div>
                </div>

                <div style={{ padding: '8px', display: 'flex', flexDirection: 'column', gap: '4px', flex: 1, justifyContent: 'space-between' }}>
                  <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                    {item.title}
                  </div>
                  <button
                    className="action-btn primary"
                    style={{ width: '100%', padding: '4px 6px', fontSize: '10.5px' }}
                    onClick={() => {
                      if (item.path && onPlayVideo) onPlayVideo(item);
                      else if (onFind) onFind(item.title, item.type);
                    }}
                  >
                    {item.path ? 'Play Video' : 'Find & Stream'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
