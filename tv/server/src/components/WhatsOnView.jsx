import React, { useState, useEffect } from 'react';
import { RefreshCw, Film, Tv, Play, AlertCircle, Sparkles, Heart } from 'lucide-react';
import { useToast } from './Toast.jsx';

export default function WhatsOnView({ onFind, continueWatching = [], onPlayOnDemand, favorites = [], onToggleFavorite }) {
  const toast = useToast();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState('all');

  const fetchData = async (force = false) => {
    try {
      if (force) setRefreshing(true);
      else setLoading(true);
      const res = await fetch(`/api/whatson${force ? '?force=true' : ''}`);
      const data = await res.json();
      setItems(data.items || []);
    } catch (err) {
      console.error('Error loading What\'s On:', err);
      if (force && toast) toast.error('Could not refresh What\'s On');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const isFavorite = (title) => {
    return favorites.some(f => f.title && f.title.toLowerCase() === (title || '').toLowerCase());
  };

  const filteredItems = items.filter(item => categoryFilter === 'all' || item.type === categoryFilter);

  if (loading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: '12px', padding: '48px' }}>
        <RefreshCw size={32} className="spin" style={{ color: 'var(--primary)' }} />
        <div style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>Loading Popular Titles...</div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* Continue Watching Section */}
      {continueWatching && continueWatching.length > 0 && (
        <div style={{ paddingBottom: '16px', borderBottom: '1px solid var(--border-color)' }}>
          <h2 style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '12px' }}>
            Continue Watching ({continueWatching.length})
          </h2>
          <div style={{ display: 'flex', gap: '14px', overflowX: 'auto', paddingBottom: '6px' }}>
            {continueWatching.map(item => (
              <div
                key={item.path}
                onClick={() => onPlayOnDemand(item)}
                className="glass-panel"
                style={{ flex: '0 0 150px', padding: '10px', borderRadius: '10px', cursor: 'pointer', border: '1px solid var(--border-color)' }}
              >
                <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {item.title}
                </div>
                <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                  {item.show ? `${item.show} · S${item.season}E${item.episode}` : 'Movie'}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Header & Filter */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: '12px' }}>
        <div>
          <h1 style={{ fontSize: '20px', fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px', margin: 0 }}>
            <Sparkles size={22} style={{ color: 'var(--primary)' }} />
            Popular & Trending
          </h1>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>
            Top trending movies and shows worldwide
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button
            className="action-btn"
            onClick={() => fetchData(true)}
            disabled={refreshing}
            title="Refresh from JustWatch"
            style={{ padding: '6px 12px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            <RefreshCw size={13} className={refreshing ? 'spin' : ''} /> Refresh
          </button>

          {/* Desktop Filter */}
          <div className="category-filter-container desktop-only">
            {['all', 'movie', 'tv'].map(filter => (
              <button
                key={filter}
                onClick={() => setCategoryFilter(filter)}
                className={`category-filter-btn ${categoryFilter === filter ? 'active' : ''}`}
              >
                {filter === 'all' ? 'All' : filter === 'movie' ? 'Movies' : 'TV Shows'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Sticky Mobile Filter Footer */}
      <div className="sticky-mobile-filter">
        <div className="category-filter-container">
          {['all', 'movie', 'tv'].map(filter => (
            <button
              key={filter}
              onClick={() => setCategoryFilter(filter)}
              className={`category-filter-btn ${categoryFilter === filter ? 'active' : ''}`}
            >
              {filter === 'all' ? 'All' : filter === 'movie' ? 'Movies' : 'TV Shows'}
            </button>
          ))}
        </div>
      </div>

      {/* Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '14px' }}>
        {filteredItems.map((item, idx) => {
          const fav = isFavorite(item.title);
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
              {/* Heart Toggle */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (onToggleFavorite) onToggleFavorite(item);
                }}
                title={fav ? 'Remove from favorites' : 'Add to favorites'}
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
                  color: fav ? 'var(--accent)' : 'rgba(255,255,255,0.7)',
                  transition: 'all 0.2s ease'
                }}
              >
                <Heart size={14} fill={fav ? 'var(--accent)' : 'none'} />
              </button>

              <div
                style={{ position: 'relative', aspectRatio: '2/3', background: 'rgba(0,0,0,0.4)', overflow: 'hidden' }}
                onClick={() => onFind && onFind(item.title, item.type)}
              >
                {item.image ? (
                  <img src={item.image} alt={item.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} loading="lazy" />
                ) : (
                  <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {item.type === 'movie' ? <Film size={24} /> : <Tv size={24} />}
                  </div>
                )}
              </div>
              <div style={{ padding: '8px', display: 'flex', flexDirection: 'column', gap: '4px', flex: 1, justifyContent: 'space-between' }}>
                <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                  {item.title}
                </div>
                <button
                  className="action-btn primary"
                  style={{ width: '100%', padding: '4px 6px', fontSize: '10.5px' }}
                  onClick={() => onFind && onFind(item.title, item.type)}
                >
                  Find & Stream
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
