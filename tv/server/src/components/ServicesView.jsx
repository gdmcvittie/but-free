import React, { useState, useEffect } from 'react';
import { RefreshCw, Film, Tv, Search, Download, AlertCircle, ArrowLeft, Play, X, Layers, Check, Heart, Radio, Sparkles } from 'lucide-react';
import { useToast } from './Toast.jsx';

export default function ServicesView({ onFind, onPlayVideo, favorites = [], onToggleFavorite }) {
  const toast = useToast();
  const [services, setServices] = useState([]);
  const [selectedService, setSelectedService] = useState(null);
  const [catalogItems, setCatalogItems] = useState([]);
  const [categories, setCategories] = useState(['All']);
  const [loadingServices, setLoadingServices] = useState(true);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [refreshingCatalog, setRefreshingCatalog] = useState(false);
  const [error, setError] = useState(null);
  const [serviceTypeFilter, setServiceTypeFilter] = useState('all'); // 'all' | 'live' | 'ondemand'
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [finding, setFinding] = useState({});

  // TV details modal state (for on-demand series)
  const [selectedShow, setSelectedShow] = useState(null);
  const [tvDetails, setTvDetails] = useState(null);
  const [loadingTvDetails, setLoadingTvDetails] = useState(false);
  const [selectedSeason, setSelectedSeason] = useState(1);

  const fetchServices = async () => {
    try {
      setLoadingServices(true);
      setError(null);
      const res = await fetch('/api/services');
      if (!res.ok) throw new Error('Failed to load streaming services.');
      const data = await res.json();
      if (data.success && data.services) {
        setServices(data.services);
      }
    } catch (err) {
      console.error('[ServicesView] Error loading services:', err);
      setError(err.message || 'Could not connect to the server.');
    } finally {
      setLoadingServices(false);
    }
  };

  const fetchCatalog = async (service, force = false) => {
    try {
      if (force) setRefreshingCatalog(true);
      else setLoadingCatalog(true);
      setError(null);

      const res = await fetch(`/api/services/${service.id}${force ? '?force=true' : ''}`);
      if (!res.ok) throw new Error(`Failed to load catalog for ${service.name}.`);
      const data = await res.json();
      const items = data.items || data.channels || [];
      setCatalogItems(items);

      if (data.isLive && data.categories && Array.isArray(data.categories)) {
        setCategories(data.categories);
      } else {
        const catSet = new Set(['all']);
        items.forEach(it => {
          if (it.category) catSet.add(it.category);
          if (it.type) catSet.add(it.type);
        });
        setCategories(Array.from(catSet));
      }
    } catch (err) {
      console.error(`[ServicesView] Error loading ${service.name} catalog:`, err);
      setError(err.message || `Failed to fetch ${service.name} catalog.`);
    } finally {
      setLoadingCatalog(false);
      setRefreshingCatalog(false);
    }
  };

  const fetchTvDetails = async (showTitle) => {
    try {
      setLoadingTvDetails(true);
      const res = await fetch(`/api/services/tv-details?title=${encodeURIComponent(showTitle)}`);
      if (!res.ok) throw new Error('Failed to load TV show episodes');
      const data = await res.json();
      if (data.success) {
        setTvDetails(data);
        if (data.seasons && data.seasons.length > 0) {
          setSelectedSeason(data.seasons[0].seasonNumber);
        }
      }
    } catch (err) {
      toast.error(`Could not fetch episode list for "${showTitle}".`);
    } finally {
      setLoadingTvDetails(false);
    }
  };

  useEffect(() => {
    fetchServices();
  }, []);

  const handleSelectService = (service) => {
    setSelectedService(service);
    setCategoryFilter('all');
    setSearchQuery('');
    fetchCatalog(service);
  };

  const handleBackToServices = () => {
    setSelectedService(null);
    setCatalogItems([]);
    setCategories(['All']);
    setSearchQuery('');
    setError(null);
  };

  const handleFind = async (item) => {
    if (!onFind) return;
    setSelectedShow(null);
    setFinding(prev => ({ ...prev, [item.title]: true }));
    try {
      await onFind(item.title, item.type);
    } finally {
      setFinding(prev => ({ ...prev, [item.title]: false }));
    }
  };

  const handleFindEpisode = async (showTitle, seasonNum, epNum) => {
    if (!onFind) return;
    setSelectedShow(null);
    const sPad = String(seasonNum).padStart(2, '0');
    const ePad = String(epNum).padStart(2, '0');
    const query = `${showTitle} S${sPad}E${ePad}`;
    setFinding(prev => ({ ...prev, [query]: true }));
    try {
      await onFind(query, 'tv');
    } finally {
      setFinding(prev => ({ ...prev, [query]: false }));
    }
  };

  const handlePlayLiveChannel = (channel) => {
    if (!onPlayVideo) return;
    onPlayVideo({
      title: channel.name || channel.title,
      path: channel.streamUrl,
      streamUrl: channel.streamUrl,
      isLive: true,
      isFreeTv: true,
      poster: channel.logo || channel.image || channel.featuredImage,
      logo: channel.logo || channel.image,
      currentProgram: channel.currentProgram,
      provider: selectedService?.name || channel.provider
    });
  };

  const filteredServices = services.filter(svc => {
    if (serviceTypeFilter === 'live') return !!svc.isLive;
    if (serviceTypeFilter === 'ondemand') return !svc.isLive;
    return true;
  });

  const filteredCatalog = catalogItems.filter(item => {
    const isLive = !!selectedService?.isLive;
    
    // Category match
    if (categoryFilter !== 'all' && categoryFilter !== 'All') {
      if (isLive) {
        if ((item.category || '').toLowerCase() !== categoryFilter.toLowerCase()) return false;
      } else {
        if (item.type !== categoryFilter.toLowerCase()) return false;
      }
    }

    // Search query match
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const title = (item.name || item.title || '').toLowerCase();
      const desc = (item.description || item.summary || item.currentProgram?.title || item.currentProgram?.description || '').toLowerCase();
      const cat = (item.category || '').toLowerCase();
      return title.includes(q) || desc.includes(q) || cat.includes(q);
    }
    return true;
  });

  if (loadingServices) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: '12px', padding: '48px' }}>
        <RefreshCw size={32} className="spin" style={{ animation: 'spin 2s linear infinite', color: 'var(--primary)' }} />
        <div style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>Loading Streaming Services...</div>
      </div>
    );
  }

  const liveServicesList = services.filter(s => !!s.isLive);
  const onDemandServicesList = services.filter(s => !s.isLive);

  return (
    <div className="services-page" style={{ maxWidth: '100%', width: '100%', display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <style>{`
        .service-card {
          transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.3s ease, border-color 0.3s ease;
          position: relative;
          border-radius: 12px;
          overflow: hidden;
          cursor: pointer;
          border: 1px solid var(--border-color);
          background: rgba(255, 255, 255, 0.02);
          display: flex;
          flex-direction: column;
        }
        .service-card:hover {
          transform: translateY(-4px);
          box-shadow: 0 12px 24px rgba(0, 0, 0, 0.4);
          border-color: rgba(139, 92, 246, 0.4);
        }
        .catalog-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
          gap: 14px;
        }
        .live-channel-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
          gap: 16px;
        }
        .catalog-card {
          transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.3s ease;
          position: relative;
          border-radius: 8px;
          overflow: hidden;
          cursor: pointer;
          border: 1px solid var(--border-color);
          background: rgba(255, 255, 255, 0.02);
          display: flex;
          flex-direction: column;
        }
        .catalog-card:hover {
          transform: translateY(-3px);
          border-color: rgba(139, 92, 246, 0.4) !important;
        }
        .live-channel-card {
          transition: transform 0.25s ease, border-color 0.25s ease, box-shadow 0.25s ease;
          position: relative;
          border-radius: 10px;
          overflow: hidden;
          cursor: pointer;
          border: 1px solid var(--border-color);
          background: rgba(18, 18, 24, 0.85);
          backdrop-filter: blur(8px);
          display: flex;
          flex-direction: column;
        }
        .live-channel-card:hover {
          transform: translateY(-3px);
          border-color: rgba(255, 222, 0, 0.5) !important;
          box-shadow: 0 8px 20px rgba(0, 0, 0, 0.6);
        }
        .live-dot-pulse {
          display: inline-block;
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: #ef4444;
          box-shadow: 0 0 8px #ef4444;
          animation: livePulse 1.5s infinite;
        }
        @keyframes livePulse {
          0% { transform: scale(0.95); opacity: 0.8; }
          50% { transform: scale(1.3); opacity: 1; }
          100% { transform: scale(0.95); opacity: 0.8; }
        }
        .category-chip-btn {
          padding: 6px 14px;
          font-size: 12px;
          font-weight: 600;
          border-radius: 20px;
          border: 1px solid var(--border-color);
          background: rgba(255, 255, 255, 0.04);
          color: var(--text-secondary);
          cursor: pointer;
          white-space: nowrap;
          transition: all 0.2s ease;
        }
        .category-chip-btn:hover {
          background: rgba(255, 255, 255, 0.09);
          color: var(--text-primary);
        }
        .category-chip-btn.active {
          background: var(--primary);
          color: #000;
          border-color: transparent;
          font-weight: 700;
        }
      `}</style>

      {/* Main Services View (Selector & Grids) */}
      {!selectedService && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          {/* Header Bar */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: '14px', flexWrap: 'wrap', gap: '12px' }}>
            <div>
              <h1 style={{ fontSize: '20px', fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px', margin: 0 }}>
                <Layers size={22} style={{ color: 'var(--primary)' }} />
                Streaming & Free TV Services
              </h1>
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                Browse live FAST TV channels (Pluto, Roku, Tubi) and on-demand network catalogs
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              {/* Type Filter Tabs */}
              <div style={{ display: 'flex', background: 'rgba(255, 255, 255, 0.05)', padding: '3px', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
                <button
                  onClick={() => setServiceTypeFilter('all')}
                  style={{
                    padding: '5px 12px',
                    fontSize: '11.5px',
                    fontWeight: 600,
                    borderRadius: '6px',
                    border: 'none',
                    background: serviceTypeFilter === 'all' ? 'var(--primary)' : 'transparent',
                    color: serviceTypeFilter === 'all' ? '#000' : 'var(--text-secondary)',
                    cursor: 'pointer',
                    transition: 'all 0.2s ease'
                  }}
                >
                  All
                </button>
                <button
                  onClick={() => setServiceTypeFilter('live')}
                  style={{
                    padding: '5px 12px',
                    fontSize: '11.5px',
                    fontWeight: 600,
                    borderRadius: '6px',
                    border: 'none',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '5px',
                    background: serviceTypeFilter === 'live' ? '#ef4444' : 'transparent',
                    color: serviceTypeFilter === 'live' ? '#fff' : 'var(--text-secondary)',
                    cursor: 'pointer',
                    transition: 'all 0.2s ease'
                  }}
                >
                  <span className="live-dot-pulse" style={{ background: serviceTypeFilter === 'live' ? '#fff' : '#ef4444' }} /> Free Live TV
                </button>
                <button
                  onClick={() => setServiceTypeFilter('ondemand')}
                  style={{
                    padding: '5px 12px',
                    fontSize: '11.5px',
                    fontWeight: 600,
                    borderRadius: '6px',
                    border: 'none',
                    background: serviceTypeFilter === 'ondemand' ? 'var(--primary)' : 'transparent',
                    color: serviceTypeFilter === 'ondemand' ? '#000' : 'var(--text-secondary)',
                    cursor: 'pointer',
                    transition: 'all 0.2s ease'
                  }}
                >
                  Networks
                </button>
              </div>

              <button className="action-btn" onClick={fetchServices} style={{ padding: '6px 12px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <RefreshCw size={13} /> Refresh
              </button>
            </div>
          </div>

          {/* Section 1: Free Live TV Services (Pluto, Roku, Tubi, Plex) */}
          {(serviceTypeFilter === 'all' || serviceTypeFilter === 'live') && liveServicesList.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span className="live-dot-pulse" />
                <h2 style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
                  Free Live TV Channels
                </h2>
                <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '12px', background: 'rgba(239, 68, 68, 0.15)', color: '#f87171', fontWeight: 700 }}>
                  900+ Live Channels
                </span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: '14px' }}>
                {liveServicesList.map(svc => {
                  const brandColor = svc.color || '#FFDE00';
                  return (
                    <div
                      key={svc.id}
                      className="glass-panel"
                      onClick={() => handleSelectService(svc)}
                      style={{
                        borderRadius: '10px',
                        overflow: 'hidden',
                        cursor: 'pointer',
                        display: 'flex',
                        flexDirection: 'column',
                        border: '1px solid rgba(255, 255, 255, 0.08)',
                        transition: 'transform 0.2s ease, border-color 0.2s ease',
                        background: 'rgba(20, 20, 26, 0.7)'
                      }}
                    >
                      <div style={{ position: 'relative', aspectRatio: '16/10', background: 'linear-gradient(135deg, rgba(28,28,38,0.9) 0%, rgba(12,12,16,0.95) 100%)', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <img
                          src={`/api/services/poster/${svc.id}`}
                          alt={svc.name}
                          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                          onError={(e) => {
                            e.target.style.display = 'none';
                            if (e.target.nextSibling) e.target.nextSibling.style.display = 'flex';
                          }}
                        />
                        <div style={{ display: 'none', position: 'absolute', inset: 0, flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '12px', textAlign: 'center', gap: '6px' }}>
                          <Radio size={28} style={{ color: brandColor }} />
                          <div style={{ fontSize: '13px', fontWeight: 800, color: '#fff' }}>{svc.name}</div>
                        </div>
                        {/* Live Pill on Poster */}
                        <div style={{ position: 'absolute', top: '8px', left: '8px', background: 'rgba(0, 0, 0, 0.75)', backdropFilter: 'blur(4px)', padding: '3px 8px', borderRadius: '12px', display: 'flex', alignItems: 'center', gap: '5px' }}>
                          <span className="live-dot-pulse" style={{ width: '6px', height: '6px' }} />
                          <span style={{ fontSize: '9.5px', fontWeight: 800, color: '#fff', letterSpacing: '0.5px' }}>LIVE</span>
                        </div>
                      </div>

                      <div style={{ padding: '10px', display: 'flex', flexDirection: 'column', gap: '6px', flex: 1, justifyContent: 'space-between' }}>
                        <div>
                          <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {svc.name}
                          </div>
                          <div style={{ fontSize: '11px', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '2px' }}>
                            {svc.description || 'Live streaming FAST channels'}
                          </div>
                        </div>
                        <button className="action-btn primary" style={{ width: '100%', padding: '5px 8px', fontSize: '11px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px' }}>
                          <Play size={12} fill="#000" /> Watch Live Channels
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Section 2: On-Demand Streaming Catalogs (Netflix, Disney, Prime, etc.) */}
          {(serviceTypeFilter === 'all' || serviceTypeFilter === 'ondemand') && onDemandServicesList.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Film size={18} style={{ color: 'var(--primary)' }} />
                <h2 style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
                  Streaming Network Catalogs
                </h2>
                <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '12px', background: 'rgba(139, 92, 246, 0.15)', color: 'var(--primary)', fontWeight: 700 }}>
                  Originals & Blockbusters
                </span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '14px' }}>
                {onDemandServicesList.map(svc => {
                  const brandColor = svc.color || '#8b5cf6';
                  return (
                    <div
                      key={svc.id}
                      className="glass-panel"
                      onClick={() => handleSelectService(svc)}
                      style={{
                        borderRadius: '8px',
                        overflow: 'hidden',
                        cursor: 'pointer',
                        display: 'flex',
                        flexDirection: 'column',
                        border: '1px solid var(--border-color)',
                        transition: 'transform 0.2s ease, border-color 0.2s ease'
                      }}
                    >
                      <div style={{ position: 'relative', aspectRatio: '2/3', background: 'linear-gradient(135deg, rgba(20,20,28,0.9) 0%, rgba(10,10,14,0.95) 100%)', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <img
                          src={`/api/services/poster/${svc.id}`}
                          alt={svc.name}
                          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                          onError={(e) => {
                            e.target.style.display = 'none';
                            if (e.target.nextSibling) e.target.nextSibling.style.display = 'flex';
                          }}
                        />
                        <div style={{ display: 'none', position: 'absolute', inset: 0, flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '12px', textAlign: 'center', gap: '8px' }}>
                          <Layers size={32} style={{ color: brandColor }} />
                          <div style={{ fontSize: '14px', fontWeight: 800, color: '#fff' }}>{svc.name}</div>
                        </div>
                      </div>
                      <div style={{ padding: '8px', display: 'flex', flexDirection: 'column', gap: '4px', flex: 1, justifyContent: 'space-between' }}>
                        <div>
                          <div style={{ fontSize: '12.5px', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {svc.name}
                          </div>
                          <div style={{ fontSize: '10.5px', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '2px' }}>
                            {svc.description || 'Streaming Service'}
                          </div>
                        </div>
                        <button className="action-btn primary" style={{ width: '100%', padding: '4px 6px', fontSize: '10.5px', marginTop: '4px' }}>
                          Browse Catalog
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Selected Service Detail View */}
      {selectedService && (
        <div className="page-with-sticky-filter" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* Service Header Bar */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: '12px', flexWrap: 'wrap', gap: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <button className="action-btn" onClick={handleBackToServices} style={{ padding: '6px 12px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <ArrowLeft size={14} /> All Services
              </button>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                {selectedService.isLive ? (
                  <span className="live-dot-pulse" style={{ width: '9px', height: '9px' }} />
                ) : (
                  <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: selectedService.color || '#E50914' }} />
                )}
                <h1 style={{ fontSize: '20px', fontFamily: 'var(--font-display)', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
                  {selectedService.name}
                </h1>
                <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                  ({filteredCatalog.length} {selectedService.isLive ? 'live channels' : 'titles'})
                </span>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <input
                type="text"
                placeholder={selectedService.isLive ? `Search ${selectedService.name} channels...` : `Search ${selectedService.name}...`}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{ padding: '6px 12px', fontSize: '12px', borderRadius: '6px', border: '1px solid var(--border-color)', background: 'rgba(255,255,255,0.06)', color: 'var(--text-primary)', width: '180px' }}
              />

              <button className="action-btn" onClick={() => fetchCatalog(selectedService, true)} style={{ padding: '6px 10px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                <RefreshCw size={12} className={refreshingCatalog ? 'spin' : ''} /> Refresh
              </button>
            </div>
          </div>

          {/* Category Chips Bar */}
          {categories && categories.length > 1 && (
            <div style={{ display: 'flex', gap: '8px', overflowX: 'auto', paddingBottom: '6px', scrollbarWidth: 'none' }}>
              {categories.map(cat => {
                const isSelected = categoryFilter.toLowerCase() === cat.toLowerCase();
                return (
                  <button
                    key={cat}
                    onClick={() => setCategoryFilter(cat)}
                    className={`category-chip-btn ${isSelected ? 'active' : ''}`}
                  >
                    {cat}
                  </button>
                );
              })}
            </div>
          )}

          {/* Catalog Content Loading / Empty / Grid */}
          {loadingCatalog ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '260px', gap: '10px' }}>
              <RefreshCw size={26} className="spin" style={{ color: 'var(--primary)' }} />
              <div style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>Loading {selectedService.name} {selectedService.isLive ? 'channels' : 'catalog'}...</div>
            </div>
          ) : filteredCatalog.length === 0 ? (
            <div className="empty-state" style={{ padding: '40px', textAlign: 'center' }}>
              <AlertCircle size={28} style={{ color: 'var(--text-muted)' }} />
              <h2 style={{ fontSize: '16px', marginTop: '10px' }}>No {selectedService.isLive ? 'channels' : 'titles'} found</h2>
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>Try searching with another keyword or category filter.</div>
            </div>
          ) : selectedService.isLive ? (
            /* Free Live FAST TV Channels Grid */
            <div className="live-channel-grid">
              {filteredCatalog.map((ch, idx) => {
                const fav = favorites.some(f => (f.id && f.id === ch.id) || (f.title && f.title.toLowerCase() === (ch.name || '').toLowerCase()));
                const logo = ch.logo || ch.image || ch.featuredImage;
                const progTitle = ch.currentProgram?.title || ch.name;
                const progDesc = ch.currentProgram?.description || ch.summary || 'Live streaming broadcast.';

                return (
                  <div
                    key={`${ch.id || ch.name}_${idx}`}
                    className="live-channel-card"
                    onClick={() => handlePlayLiveChannel(ch)}
                  >
                    {/* Top Row: Thumbnail + Logo */}
                    <div style={{ position: 'relative', width: '100%', aspectRatio: '16/9', background: '#0b0b10', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {logo ? (
                        <img
                          src={logo}
                          alt={ch.name}
                          style={{ maxWidth: '80%', maxHeight: '80%', objectFit: 'contain' }}
                          loading="lazy"
                          onError={(e) => {
                            e.target.style.display = 'none';
                            if (e.target.nextSibling) e.target.nextSibling.style.display = 'flex';
                          }}
                        />
                      ) : null}
                      <div style={{ display: logo ? 'none' : 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: '6px' }}>
                        <Tv size={28} style={{ color: 'var(--primary)' }} />
                        <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-secondary)' }}>{ch.name}</span>
                      </div>

                      {/* Live Badge */}
                      <div style={{ position: 'absolute', top: '8px', left: '8px', background: 'rgba(0, 0, 0, 0.75)', backdropFilter: 'blur(4px)', padding: '3px 8px', borderRadius: '12px', display: 'flex', alignItems: 'center', gap: '5px' }}>
                        <span className="live-dot-pulse" style={{ width: '6px', height: '6px' }} />
                        <span style={{ fontSize: '9px', fontWeight: 800, color: '#fff', letterSpacing: '0.5px' }}>LIVE</span>
                      </div>

                      {/* Category Badge */}
                      {ch.category && (
                        <div style={{ position: 'absolute', bottom: '8px', left: '8px', background: 'rgba(0, 0, 0, 0.7)', backdropFilter: 'blur(4px)', padding: '2px 7px', borderRadius: '4px', fontSize: '9.5px', fontWeight: 700, color: 'var(--text-secondary)' }}>
                          {ch.category}
                        </div>
                      )}

                      {/* Favorite Button */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (onToggleFavorite) onToggleFavorite({ title: ch.name, id: ch.id, type: 'live', isLive: true, image: logo });
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
                        <Heart size={13} fill={fav ? 'var(--accent)' : 'none'} />
                      </button>
                    </div>

                    {/* Bottom Row: EPG Guide Info & Play Action */}
                    <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '6px', flex: 1, justifyContent: 'space-between' }}>
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px' }}>
                          <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {ch.number ? `${ch.number} · ` : ''}{ch.name}
                          </div>
                        </div>

                        <div style={{ fontSize: '11.5px', fontWeight: 600, color: 'var(--primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '2px' }}>
                          {progTitle}
                        </div>

                        <div style={{ fontSize: '11px', color: 'var(--text-secondary)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', marginTop: '2px', lineHeight: '1.4' }}>
                          {progDesc}
                        </div>
                      </div>

                      <button
                        className="action-btn primary"
                        style={{ width: '100%', padding: '5px 8px', fontSize: '11.5px', marginTop: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
                      >
                        <Play size={12} fill="#000" /> Watch Live
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            /* On-Demand Movies/Series Catalog Grid */
            <div className="catalog-grid">
              {filteredCatalog.map((item, idx) => {
                const isMovie = item.type === 'movie';
                const isSearching = !!finding[item.title];
                const fav = favorites.some(f => f.title && f.title.toLowerCase() === (item.title || '').toLowerCase());

                return (
                  <div
                    key={`${item.title}_${idx}`}
                    className="glass-panel catalog-card"
                    style={{ position: 'relative' }}
                    onClick={() => {
                      if (isMovie) handleFind(item);
                      else {
                        setSelectedShow(item);
                        fetchTvDetails(item.title);
                      }
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

                    <div style={{ position: 'relative', aspectRatio: '2/3', width: '100%', background: 'rgba(0,0,0,0.4)', overflow: 'hidden' }}>
                      {item.image ? (
                        <img src={item.image} alt={item.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} loading="lazy" />
                      ) : (
                        <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          {isMovie ? <Film size={24} /> : <Tv size={24} />}
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
                        style={{ width: '100%', padding: '4px 6px', fontSize: '10.5px', marginTop: '4px' }}
                        disabled={isSearching}
                      >
                        {isSearching ? 'Searching...' : isMovie ? 'Stream' : 'Episodes'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* TV Details Modal (for On-Demand TV Series) */}
      {selectedShow && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', backdropFilter: 'blur(8px)' }} onClick={() => setSelectedShow(null)}>
          <div className="glass-panel" style={{ width: '100%', maxWidth: '720px', maxHeight: '85vh', display: 'flex', flexDirection: 'column', borderRadius: '12px', overflow: 'hidden', background: '#121218', border: '1px solid var(--border-color)' }} onClick={(e) => e.stopPropagation()}>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: '11px', color: 'var(--primary)', fontWeight: 700 }}>{selectedService?.name || 'SERIES'}</div>
                <h2 style={{ fontSize: '18px', fontWeight: 700, margin: '2px 0 0' }}>{selectedShow.title}</h2>
              </div>
              <button onClick={() => setSelectedShow(null)} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}><X size={20} /></button>
            </div>

            <div style={{ padding: '16px 20px', overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: '14px' }}>
              {loadingTvDetails ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '36px' }}>
                  <RefreshCw size={24} className="spin" style={{ color: 'var(--primary)' }} />
                </div>
              ) : tvDetails && tvDetails.seasons && tvDetails.seasons.length > 0 ? (
                <>
                  <div style={{ display: 'flex', gap: '8px', overflowX: 'auto', paddingBottom: '4px' }}>
                    {tvDetails.seasons.map(s => (
                      <button
                        key={s.seasonNumber}
                        onClick={() => setSelectedSeason(s.seasonNumber)}
                        style={{
                          padding: '4px 12px',
                          fontSize: '12px',
                          fontWeight: 600,
                          borderRadius: '6px',
                          border: '1px solid var(--border-color)',
                          background: selectedSeason === s.seasonNumber ? 'var(--primary)' : 'rgba(255,255,255,0.04)',
                          color: selectedSeason === s.seasonNumber ? '#000' : 'var(--text-secondary)',
                          cursor: 'pointer'
                        }}
                      >
                        Season {s.seasonNumber}
                      </button>
                    ))}
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {(tvDetails.seasons.find(s => s.seasonNumber === selectedSeason)?.episodes || []).map(ep => (
                      <div key={ep.episodeNumber} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', borderRadius: '8px', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-color)' }}>
                        <div>
                          <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--primary)', marginRight: '8px' }}>E{ep.episodeNumber}</span>
                          <span style={{ fontSize: '13px', fontWeight: 600 }}>{ep.name}</span>
                        </div>
                        <button
                          className="action-btn primary"
                          onClick={() => handleFindEpisode(selectedShow.title, selectedSeason, ep.episodeNumber)}
                          style={{ padding: '4px 10px', fontSize: '11px' }}
                        >
                          Play
                        </button>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div style={{ textAlign: 'center', padding: '24px', color: 'var(--text-muted)', fontSize: '13px' }}>
                  No episode guide found.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
