import React, { useState, useEffect } from 'react';
import { RefreshCw, Film, Tv, Sparkles, Heart } from 'lucide-react';
import { useToast } from './Toast.jsx';
import RssFeedsView from './RssFeedsView.jsx';

// What's On now hosts everything discoverable in one place:
// trending titles plus the former RSS Releases section content.
const WHATS_ON_TABS = [
  { id: 'all', label: 'All' },
  { id: 'tv', label: 'TV' },
  { id: 'movies', label: 'Movies' },
  { id: 'tvrss', label: 'TV RSS' },
  { id: 'moviesrss', label: 'Movies RSS' },
  { id: 'comingsoon', label: 'Coming Soon' },
  { id: 'wishlist', label: 'Wish List' }
];

export default function WhatsOnView({
  onFind,
  continueWatching = [],
  onPlayOnDemand,
  favorites = [],
  onToggleFavorite,
  tab = 'all',
  onTabChange,
  folders,
  onOpenSettings,
  onOpenLoader,
  onJobAdded
}) {
  const toast = useToast();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const activeTab = tab || 'all';
  const setTab = onTabChange || (() => {});
  const isTrendingTab = ['all', 'tv', 'movies'].includes(activeTab);

  // Map the active What's On tab to the RssFeedsView it should render.
  // A single persistent instance keeps RSS data loaded while switching tabs.
  const rssView =
    activeTab === 'tvrss' || activeTab === 'moviesrss'
      ? 'releases'
      : activeTab === 'comingsoon' || activeTab === 'wishlist'
        ? activeTab
        : null;
  const rssFixedType = activeTab === 'tvrss' ? 'tv' : activeTab === 'moviesrss' ? 'movie' : null;

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

  const filteredItems = items.filter(item => {
    if (activeTab === 'tv') return item.type === 'tv';
    if (activeTab === 'movies') return item.type === 'movie';
    return true;
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* Continue Watching Section */}
      {isTrendingTab && continueWatching && continueWatching.length > 0 && (
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

      {/* Tab Bar */}
      <div className="whats-on-tabs" role="tablist">
        {WHATS_ON_TABS.map(t => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={activeTab === t.id}
            className={`whats-on-tab ${activeTab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Trending Titles (All / TV / Movies) */}
      {isTrendingTab && (
        <>
          {/* Header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
            <div>
              <h1 style={{ fontSize: '20px', fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px', margin: 0 }}>
                <Sparkles size={22} style={{ color: 'var(--primary)' }} />
                Popular &amp; Trending
              </h1>
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                Top trending movies and shows worldwide
              </div>
            </div>

            <button
              className="action-btn"
              onClick={() => fetchData(true)}
              disabled={refreshing}
              title="Refresh from JustWatch"
              style={{ padding: '6px 12px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              <RefreshCw size={13} className={refreshing ? 'spin' : ''} /> Refresh
            </button>
          </div>

          {/* Grid */}
          {loading ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px', padding: '48px' }}>
              <RefreshCw size={32} className="spin" style={{ color: 'var(--primary)' }} />
              <div style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>Loading Popular Titles...</div>
            </div>
          ) : (
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
          )}
        </>
      )}

      {/* RSS Releases / Coming Soon / Wish List */}
      <RssFeedsView
        view={rssView}
        fixedType={rssFixedType}
        folders={folders}
        onOpenSettings={onOpenSettings}
        onOpenLoader={onOpenLoader}
        onJobAdded={onJobAdded}
        onPlayVideo={onPlayOnDemand}
      />
    </div>
  );
}
