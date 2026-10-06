import React, { useState, useEffect, useRef } from 'react';
import { Tv, Settings, RefreshCw, AlertCircle, X, Play, PlayCircle, Download, Film, Sparkles, User, Layers, HardDrive, Search, LogOut, Heart, Radio, UploadCloud, Rss, Menu } from 'lucide-react';
import { ToastProvider, useToast } from './components/Toast.jsx';
import LoginScreen from './components/LoginScreen.jsx';
import CloudSettingsModal from './components/CloudSettingsModal.jsx';
import CloudLoaderModal from './components/CloudLoaderModal.jsx';
import ServicesView from './components/ServicesView.jsx';
import WhatsOnView from './components/WhatsOnView.jsx';
import OnDemandBrowse from './components/OnDemandBrowse.jsx';
import FavoritesView from './components/FavoritesView.jsx';
import ChannelsView from './components/ChannelsView.jsx';
import RssFeedsView from './components/RssFeedsView.jsx';
import TvPlayer from './components/TvPlayer.jsx';
import SearchResults from './components/SearchResults.jsx';
import InstallBanner from './components/InstallBanner.jsx';
import { fetchCurrentUser, logoutUser } from './utils/auth.js';

function CloudAppContent() {
  const toast = useToast();
  const [authState, setAuthState] = useState({
    loading: true,
    authenticated: false,
    user: null,
    folders: null,
    error: null
  });
  const [activeTab, setActiveTab] = useState('whatson'); // 'whatson' | 'services' | 'ondemand' | 'faves' | 'channels'
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isDownloadsOpen, setIsDownloadsOpen] = useState(false);
  const [activeDownloadsCount, setActiveDownloadsCount] = useState(0);
  const [activeSearch, setActiveSearch] = useState(null); // { query: string, scope: 'movies' | 'tv' | 'unified' } | null
  const [library, setLibrary] = useState({ shows: {}, showsList: [], movies: [], continueWatching: [] });
  const [favorites, setFavorites] = useState([]);
  const [activeVideo, setActiveVideo] = useState(null);
  const [videoOffset, setVideoOffset] = useState(0);
  const [channelPlaylist, setChannelPlaylist] = useState(null);
  const [channelIndex, setChannelIndex] = useState(0);
  const [headerSearch, setHeaderSearch] = useState('');
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const notifiedJobsRef = useRef(new Set());
  const initialDownloadsLoadedRef = useRef(false);
  const lastLibraryUpdateRef = useRef(0);

  const requestNotificationPermission = async () => {
    if ('Notification' in window && Notification.permission === 'default') {
      try {
        await Notification.requestPermission();
      } catch (_) {}
    }
  };

  const notifyCompletedJob = (job) => {
    const title = 'Ready to Watch!';
    const name = job.cleanName || job.title || 'Your download';
    const body = `"${name}" is now in your Google Drive library and ready to stream.`;

    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.ready.then((reg) => {
        reg.showNotification(title, {
          body,
          icon: '/favicon.svg',
          badge: '/favicon.svg',
          tag: `ready_${job.id}`,
          data: { url: '/?tab=ondemand' }
        });
      }).catch(() => {
        if ('Notification' in window && Notification.permission === 'granted') {
          try { new Notification(title, { body, icon: '/favicon.svg' }); } catch (_) {}
        }
      });
    } else if ('Notification' in window && Notification.permission === 'granted') {
      try { new Notification(title, { body, icon: '/favicon.svg' }); } catch (_) {}
    }

    toast.success(`Ready to Watch: "${name}"`, { duration: 6000 });
  };

  // Close mobile drawer on desktop resize
  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth >= 768 && isMobileMenuOpen) {
        setIsMobileMenuOpen(false);
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [isMobileMenuOpen]);

  // Lock body scroll when mobile drawer is open
  useEffect(() => {
    if (isMobileMenuOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isMobileMenuOpen]);

  const handleNavTab = (tabId) => {
    if (isMobileMenuOpen) setIsMobileMenuOpen(false);
    if (tabId === 'loader') {
      setIsDownloadsOpen(true);
    } else {
      setActiveTab(tabId);
    }
  };

  const handleSearchSubmit = (e) => {
    if (e) e.preventDefault();
    const q = headerSearch.trim();
    if (!q) return;
    if (isMobileMenuOpen) setIsMobileMenuOpen(false);
    handleStreamFind(q, 'unified');
  };

  const loadFavorites = async () => {
    try {
      const res = await fetch('/api/favorites');
      if (res.ok) {
        const data = await res.json();
        setFavorites(Array.isArray(data.favorites) ? data.favorites : []);
      }
    } catch (err) {
      console.warn('[Favorites] Failed to load:', err);
    }
  };

  const handleToggleFavorite = async (item) => {
    if (!item || !item.title) return;
    try {
      const res = await fetch('/api/favorites/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item })
      });
      const data = await res.json();
      if (res.ok && data.favorites) {
        setFavorites(data.favorites);
        if (data.isFavorite) {
          toast.success(`"${item.title}" added to Favorites`);
        } else {
          toast.info(`"${item.title}" removed from Favorites`);
        }
      }
    } catch (err) {
      toast.error('Could not update favorites');
    }
  };

  const checkAuth = async () => {
    const params = new URLSearchParams(window.location.search);
    const authError = params.get('auth_error');
    try {
      const data = await fetchCurrentUser();
      if (data && data.authenticated) {
        setAuthState({
          loading: false,
          authenticated: true,
          user: data.user || null,
          folders: data.folders || null,
          error: null
        });
      } else {
        setAuthState((prev) => ({
          ...prev,
          loading: false,
          authenticated: false,
          error: authError || data?.error || null
        }));
      }
    } catch (_) {
      setAuthState((prev) => ({ ...prev, loading: false, authenticated: false, error: authError || null }));
    }
    loadLibrary();
    loadFavorites();
  };

  const loadLibrary = async () => {
    try {
      const res = await fetch('/api/ondemand');
      const data = await res.json();
      setLibrary(data || { shows: {}, showsList: [], movies: [], continueWatching: [] });
    } catch (err) {
      console.error('Error loading library:', err);
    }
  };

  const checkActiveDownloads = async () => {
    try {
      const res = await fetch('/api/downloads');
      if (res.ok) {
        const data = await res.json();
        const allDownloads = data.downloads || [];
        const active = allDownloads.filter(d => ['queued', 'downloading', 'transcoding', 'uploading'].includes(d.stage || d.status));
        setActiveDownloadsCount(active.length);

        // Check if backend signaled a library update
        if (data.libraryUpdatedAt && data.libraryUpdatedAt > lastLibraryUpdateRef.current) {
          lastLibraryUpdateRef.current = data.libraryUpdatedAt;
          loadLibrary();
        }

        if (!initialDownloadsLoadedRef.current) {
          // Seed completed jobs on first load to prevent notification spam
          for (const d of allDownloads) {
            if (d.status === 'completed' || d.stage === 'completed') {
              notifiedJobsRef.current.add(d.id);
            }
          }
          initialDownloadsLoadedRef.current = true;
        } else {
          // Detect newly completed jobs
          let hasNewCompletion = false;
          for (const d of allDownloads) {
            if ((d.status === 'completed' || d.stage === 'completed') && !notifiedJobsRef.current.has(d.id)) {
              notifiedJobsRef.current.add(d.id);
              notifyCompletedJob(d);
              hasNewCompletion = true;
            }
          }
          if (hasNewCompletion) {
            // Automatically update library so new content appears in the Drive tab immediately!
            loadLibrary();
          }
        }
      }
    } catch (_) {}
  };

  useEffect(() => {
    checkAuth();
    requestNotificationPermission();
  }, []);

  useEffect(() => {
    if (authState.authenticated) {
      checkActiveDownloads();
      const pollInterval = activeDownloadsCount > 0 ? 4000 : 8000;
      const interval = setInterval(checkActiveDownloads, pollInterval);
      return () => clearInterval(interval);
    }
  }, [authState.authenticated, activeDownloadsCount]);

  const handlePlayVideo = (video) => {
    stopTorrentStream(activeVideo);
    setChannelPlaylist(null);
    setChannelIndex(0);
    setActiveVideo(video);
    setVideoOffset(video.currentTime || 0);
    setActiveSearch(null);
    setIsSettingsOpen(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handlePlayChannel = (channel) => {
    const playlist = (channel.playlist || []).slice();
    if (playlist.length === 0) return;
    if (!playlist[0].path) return;
    stopTorrentStream(activeVideo);
    setChannelPlaylist({ id: channel.id, name: channel.name, items: playlist });
    setChannelIndex(0);
    setActiveVideo(playlist[0]);
    setVideoOffset(0);
    setActiveSearch(null);
    setIsSettingsOpen(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handlePlayNext = () => {
    if (!channelPlaylist || !channelPlaylist.items) return;
    const next = channelIndex + 1;
    if (next < channelPlaylist.items.length) {
      setChannelIndex(next);
      setActiveVideo(channelPlaylist.items[next]);
      setVideoOffset(0);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      stopTorrentStream(activeVideo);
      setActiveVideo(null);
      setChannelPlaylist(null);
      setChannelIndex(0);
    }
  };

  const handleTimeUpdate = (currentTime, duration) => {
    if (!activeVideo) return;
    if (Math.floor(currentTime) % 10 === 0 && currentTime > 5) {
      fetch('/api/playback/progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: activeVideo.path || `drive://${activeVideo.id}`,
          currentTime,
          duration,
          title: activeVideo.title || activeVideo.filename,
          show: activeVideo.show,
          season: activeVideo.season,
          episode: activeVideo.episode
        })
      }).catch(() => {});
    }
  };

  const handleStreamFind = (title, type) => {
    // 1. Check if the item is in Google Drive library
    const q = (title || '').toLowerCase();
    if (type === 'movie') {
      const match = (library.movies || []).find(m => (m.title || m.filename || '').toLowerCase().includes(q));
      if (match) {
        toast.success(`Playing "${match.title}" from your Google Drive!`);
        handlePlayVideo(match);
        return;
      }
    } else {
      // Check TV shows in Google Drive
      for (const showName in (library.shows || {})) {
        if (q.includes(showName.toLowerCase())) {
          const seasons = library.shows[showName];
          const firstSeason = Object.keys(seasons)[0];
          if (firstSeason && seasons[firstSeason].length > 0) {
            toast.success(`Playing "${showName}" from your Google Drive!`);
            handlePlayVideo(seasons[firstSeason][0]);
            return;
          }
        }
      }
    }

    // 2. Open Stream search modal
    setActiveSearch({ query: title, scope: type === 'movie' ? 'movies' : 'tv' });
  };

  // Tell the torrent streamer to stop and clear a torrent stream when it is no longer being watched.
  const stopTorrentStream = (video) => {
    if (!video) return;
    const src = video.streamUrl || '';
    const m = String(src).match(/\/api\/torrent\/serve\/([^/]+)\//);
    if (!m) return;
    const streamId = m[1];
    fetch(`/api/torrent/stream/${encodeURIComponent(streamId)}/stop`, { method: 'POST' }).catch(() => {});
  };

  if (authState.loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#09090b' }}>
        <RefreshCw size={36} className="spin" style={{ color: 'var(--primary)' }} />
      </div>
    );
  }

  if (!authState.authenticated) {
    return <LoginScreen error={authState.error} />;
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg-darker)', color: 'var(--text-primary)' }}>
      {/* Top Navbar */}
      <header className="app-header">
        <div className="header-inner">
          {/* Line 1: Branding on Left, Google User Badge & Settings on Right */}
          <div className="header-top-row">
            <div className="header-brand" onClick={() => { setActiveTab('whatson'); if (isMobileMenuOpen) setIsMobileMenuOpen(false); }}>
              <div className="brand-icon">
                <Tv size={20} color="#fff" />
              </div>
              <div className="brand-title">
                FREE<span style={{ color: 'var(--primary)' }}>VEE</span>
              </div>
            </div>

            <div className="header-user-actions">
              <button
                className="action-btn desktop-only"
                onClick={() => setIsSettingsOpen(true)}
                title="Settings"
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '7px 8px', borderRadius: '8px' }}
              >
                <Settings size={15} />
              </button>

              <div
                className="user-badge desktop-only"
                onClick={() => setIsSettingsOpen(true)}
              >
                {authState.user?.picture ? (
                  <img src={authState.user.picture} alt={authState.user.name} style={{ width: '24px', height: '24px', borderRadius: '50%' }} />
                ) : (
                  <User size={16} />
                )}
                <span style={{ fontSize: '12px', fontWeight: 600 }}>{authState.user?.name?.split(' ')[0] || 'User'}</span>
              </div>

              {/* Hamburger Button for Mobile */}
              <button
                className="hamburger-btn"
                onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
                aria-label="Toggle navigation menu"
                aria-expanded={isMobileMenuOpen}
              >
                {isMobileMenuOpen ? <X size={20} /> : <Menu size={20} />}
                {activeDownloadsCount > 0 && !isMobileMenuOpen && (
                  <span className="hamburger-badge">{activeDownloadsCount}</span>
                )}
              </button>
            </div>
          </div>

          {/* Line 2: Full Width Menu */}
          <nav className="header-nav">
            {[
              { id: 'services', label: 'Services', icon: <Layers size={14} /> },
              { id: 'channels', label: 'Channels', icon: <Radio size={14} /> },
              { id: 'faves', label: 'Faves', icon: <Heart size={14} fill={activeTab === 'faves' ? '#000' : 'none'} /> },
              { id: 'ondemand', label: 'Drive', icon: <HardDrive size={14} /> },
              { id: 'feeds', label: 'Feeds', icon: <Rss size={14} /> },
              { id: 'loader', label: 'Loader', icon: <UploadCloud size={14} />, badge: activeDownloadsCount }
            ].map(tab => (
              <button
                key={tab.id}
                className={`nav-item ${activeTab === tab.id ? 'active' : ''}`}
                onClick={() => {
                  if (tab.id === 'loader') {
                    setIsDownloadsOpen(true);
                  } else {
                    setActiveTab(tab.id);
                  }
                }}
              >
                {tab.icon}
                {tab.label}
                {tab.badge > 0 && (
                  <span
                    style={{
                      marginLeft: '4px',
                      background: 'var(--primary)',
                      color: '#000',
                      borderRadius: '10px',
                      padding: '0 5px',
                      fontSize: '10px',
                      fontWeight: 800,
                      lineHeight: '14px'
                    }}
                  >
                    {tab.badge}
                  </span>
                )}
              </button>
            ))}
          </nav>

          {/* Line 3: Search Bar */}
          <div className="header-search-row">
            <form onSubmit={handleSearchSubmit} className="header-search-box">
              <Search size={15} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
              <input
                type="text"
                placeholder="Search movies, shows, streams..."
                value={headerSearch}
                onChange={(e) => setHeaderSearch(e.target.value)}
              />
              {headerSearch && (
                <button
                  type="button"
                  onClick={() => setHeaderSearch('')}
                  style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', padding: '2px' }}
                >
                  <X size={14} />
                </button>
              )}
            </form>
          </div>
        </div>
      </header>

      {/* Mobile Drawer Backdrop & Menu */}
      <div
        className={`mobile-drawer-overlay ${isMobileMenuOpen ? 'open' : ''}`}
        onClick={() => setIsMobileMenuOpen(false)}
      />

      <aside className={`mobile-drawer ${isMobileMenuOpen ? 'open' : ''}`} aria-hidden={!isMobileMenuOpen}>
        {/* Drawer Header */}
        <div className="mobile-drawer-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div className="brand-icon" style={{ width: '32px', height: '32px', borderRadius: '8px' }}>
              <Tv size={17} color="#fff" />
            </div>
            <div className="brand-title" style={{ fontSize: '16px' }}>
              FREE<span style={{ color: 'var(--primary)' }}>VEE</span>
            </div>
          </div>
          <button
            onClick={() => setIsMobileMenuOpen(false)}
            style={{
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid var(--border-color)',
              color: 'var(--text-secondary)',
              borderRadius: '8px',
              padding: '6px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
            aria-label="Close menu"
          >
            <X size={18} />
          </button>
        </div>

        {/* User Card if Authenticated */}
        {authState.user && (
          <div
            onClick={() => {
              setIsMobileMenuOpen(false);
              setIsSettingsOpen(true);
            }}
            style={{
              margin: '12px 14px 6px',
              padding: '12px',
              borderRadius: '12px',
              background: 'rgba(255, 255, 255, 0.03)',
              border: '1px solid var(--border-color)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              cursor: 'pointer'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
              {authState.user.picture ? (
                <img src={authState.user.picture} alt={authState.user.name} style={{ width: '36px', height: '36px', borderRadius: '50%', border: '2px solid var(--primary)', flexShrink: 0 }} />
              ) : (
                <div style={{ width: '36px', height: '36px', borderRadius: '50%', background: 'rgba(139,92,246,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--primary)', flexShrink: 0 }}>
                  <User size={18} />
                </div>
              )}
              <div style={{ minWidth: 0, overflow: 'hidden' }}>
                <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{authState.user.name || 'User'}</div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{authState.user.email}</div>
              </div>
            </div>
            <Settings size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
          </div>
        )}

        {/* Navigation Links */}
        <nav className="mobile-drawer-nav">
          <div style={{ fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-muted)', padding: '6px 8px 4px' }}>
            Navigation
          </div>
          {[
            { id: 'whatson', label: "What's On", icon: <Tv size={17} /> },
            { id: 'services', label: 'Services', icon: <Layers size={17} /> },
            { id: 'channels', label: 'Channels', icon: <Radio size={17} /> },
            { id: 'faves', label: 'Favorites', icon: <Heart size={17} fill={activeTab === 'faves' ? 'var(--primary)' : 'none'} /> },
            { id: 'ondemand', label: 'Drive Library', icon: <HardDrive size={17} /> },
            { id: 'feeds', label: 'RSS Releases', icon: <Rss size={17} /> },
            { id: 'loader', label: 'Cloud Loader', icon: <UploadCloud size={17} />, badge: activeDownloadsCount }
          ].map(tab => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                className={`mobile-nav-item ${isActive ? 'active' : ''}`}
                onClick={() => handleNavTab(tab.id)}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <span className="mobile-nav-icon">{tab.icon}</span>
                  <span>{tab.label}</span>
                </div>
                {tab.badge > 0 && (
                  <span
                    style={{
                      background: 'var(--primary)',
                      color: '#000',
                      borderRadius: '10px',
                      padding: '1px 7px',
                      fontSize: '11px',
                      fontWeight: 800
                    }}
                  >
                    {tab.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Drawer Footer Actions */}
        <div className="mobile-drawer-footer">
          <button
            className="action-btn"
            onClick={() => {
              setIsMobileMenuOpen(false);
              setIsSettingsOpen(true);
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
              padding: '10px 14px',
              fontSize: '13px',
              fontWeight: 600,
              width: '100%',
              borderRadius: '8px'
            }}
          >
            <Settings size={15} />
            Cloud Settings
          </button>

          <button
            className="action-btn"
            onClick={() => {
              setIsMobileMenuOpen(false);
              logoutUser();
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
              padding: '10px 14px',
              fontSize: '13px',
              fontWeight: 600,
              width: '100%',
              borderRadius: '8px',
              color: '#f87171',
              borderColor: 'rgba(244, 63, 94, 0.25)',
              background: 'rgba(244, 63, 94, 0.08)'
            }}
          >
            <LogOut size={15} />
            Log Out
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <main style={{ flex: 1, padding: '24px', maxWidth: '1440px', width: '100%', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '20px' }}>
        {/* Active Player (Sticky when playing) */}
        {activeVideo && (
          <div
            style={{
              position: 'sticky',
              top: '64px',
              zIndex: 80,
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
              background: 'rgba(9, 9, 11, 0.94)',
              backdropFilter: 'blur(16px)',
              padding: '14px',
              borderRadius: '16px',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              boxShadow: '0 20px 48px rgba(0, 0, 0, 0.85)',
              marginBottom: '12px'
            }}
          >
            <TvPlayer
              currentVideo={activeVideo}
              offset={videoOffset}
              onStop={() => { stopTorrentStream(activeVideo); setChannelPlaylist(null); setChannelIndex(0); setActiveVideo(null); }}
              onTimeUpdate={handleTimeUpdate}
              onEnded={handlePlayNext}
            />
            <div style={{ padding: '4px 6px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ minWidth: 0, flex: 1, marginRight: '16px' }}>
                <div style={{ fontSize: '10.5px', color: activeVideo.isLive ? '#f87171' : 'var(--primary)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  {activeVideo.isLive && <span className="live-dot-pulse" style={{ width: '6px', height: '6px' }} />}
                  {activeVideo.isLive ? `LIVE STREAM · ${activeVideo.provider || 'FREE TV'}` : (channelPlaylist ? `CHANNEL · ${channelPlaylist.name}` : 'NOW PLAYING')}
                </div>
                <h2 style={{ fontSize: '16px', fontWeight: 700, margin: '2px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {activeVideo.currentProgram?.title && activeVideo.currentProgram.title !== activeVideo.title
                    ? `${activeVideo.title} — ${activeVideo.currentProgram.title}`
                    : (activeVideo.title || activeVideo.filename)}
                </h2>
                {channelPlaylist && (
                  <div style={{ fontSize: '10.5px', color: 'var(--text-secondary)' }}>
                    {(channelIndex + 1)} / {channelPlaylist.items.length} · playing next automatically
                  </div>
                )}
                {activeVideo.currentProgram?.description ? (
                  <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {activeVideo.currentProgram.description}
                  </div>
                ) : activeVideo.show ? (
                  <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)' }}>{activeVideo.show} (Season {activeVideo.season}, Episode {activeVideo.episode})</div>
                ) : null}
              </div>
              <button
                className="action-btn"
                onClick={() => { stopTorrentStream(activeVideo); setChannelPlaylist(null); setChannelIndex(0); setActiveVideo(null); }}
                style={{ padding: '6px 14px', fontSize: '12px', color: 'var(--accent)', borderColor: 'rgba(244, 63, 94, 0.3)', flexShrink: 0 }}
              >
                Close Player
              </button>
            </div>
          </div>
        )}

        {/* View Routing */}
        {activeTab === 'whatson' && (
          <WhatsOnView
            continueWatching={library.continueWatching || []}
            onPlayOnDemand={handlePlayVideo}
            onFind={handleStreamFind}
            favorites={favorites}
            onToggleFavorite={handleToggleFavorite}
          />
        )}

        {activeTab === 'services' && (
          <ServicesView
            onPlayVideo={handlePlayVideo}
            onFind={handleStreamFind}
            favorites={favorites}
            onToggleFavorite={handleToggleFavorite}
          />
        )}

        {activeTab === 'faves' && (
          <FavoritesView
            favorites={favorites}
            onToggleFavorite={handleToggleFavorite}
            onFind={handleStreamFind}
            onPlayVideo={handlePlayVideo}
          />
        )}

        {activeTab === 'ondemand' && (
          <OnDemandBrowse
            library={library}
            onPlayVideo={handlePlayVideo}
            onOpenSettings={() => setIsSettingsOpen(true)}
            favorites={favorites}
            onToggleFavorite={handleToggleFavorite}
          />
        )}

        {activeTab === 'channels' && (
          <ChannelsView
            onPlayChannel={handlePlayChannel}
            favorites={favorites}
            onToggleFavorite={handleToggleFavorite}
          />
        )}

        {activeTab === 'feeds' && (
          <RssFeedsView
            folders={authState.folders}
            onOpenSettings={() => setIsSettingsOpen(true)}
            onOpenLoader={() => setIsDownloadsOpen(true)}
            onJobAdded={checkActiveDownloads}
            onPlayVideo={handlePlayVideo}
          />
        )}
      </main>

      {/* Stream Search Modal */}
      {activeSearch && (
        <SearchResults
          query={activeSearch.query}
          scope={activeSearch.scope}
          library={library}
          folders={authState.folders}
          onClose={() => setActiveSearch(null)}
          onPlayVideo={handlePlayVideo}
          onOpenDownloads={() => setIsDownloadsOpen(true)}
        />
      )}

      {/* Mobile Portrait Footer Nav (icon-only) — complements the hamburger drawer */}
      <nav className="mobile-footer-nav" aria-label="Primary navigation">
        {[
          { id: 'whatson', label: "What's On", icon: <Tv size={20} /> },
          { id: 'services', label: 'Services', icon: <Layers size={20} /> },
          { id: 'channels', label: 'Channels', icon: <Radio size={20} /> },
          { id: 'faves', label: 'Faves', icon: <Heart size={20} fill={activeTab === 'faves' ? 'currentColor' : 'none'} /> },
          { id: 'ondemand', label: 'Drive', icon: <HardDrive size={20} /> }
        ].map(tab => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              className={`mobile-footer-nav-item ${isActive ? 'active' : ''}`}
              onClick={() => handleNavTab(tab.id)}
              title={tab.label}
              aria-label={tab.label}
              aria-current={isActive ? 'page' : undefined}
            >
              {tab.icon}
            </button>
          );
        })}
      </nav>

      <InstallBanner />

      {/* Cloud Loader / Downloads Modal */}
      <CloudLoaderModal
        isOpen={isDownloadsOpen}
        onClose={() => {
          setIsDownloadsOpen(false);
          checkActiveDownloads();
        }}
        folders={authState.folders}
        onJobAdded={() => {
          checkActiveDownloads();
        }}
        onNavigateToFeeds={() => {
          setIsDownloadsOpen(false);
          setActiveTab('feeds');
        }}
      />

      {/* Settings Modal */}
      <CloudSettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        user={authState.user}
        folders={authState.folders}
        onUpdateFolders={(newFolders) => {
          setAuthState(prev => ({ ...prev, folders: newFolders }));
        }}
        onScanComplete={(newLib) => {
          setLibrary(newLib);
        }}
      />
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <CloudAppContent />
    </ToastProvider>
  );
}
