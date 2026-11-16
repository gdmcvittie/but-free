import React, { useState, useEffect, useRef } from 'react';
import {
  Tv,
  Settings,
  RefreshCw,
  AlertCircle,
  X,
  Play,
  PlayCircle,
  Download,
  Film,
  Sparkles,
  User,
  Layers,
  HardDrive,
  Search,
  LogOut,
  Heart,
  Radio,
  UploadCloud,
  Rss
} from 'lucide-react';
import { ToastProvider, useToast } from './components/Toast.jsx';
import Sidebar from './components/Sidebar.jsx';
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
import { getLibraryOfflineEntry, saveLibraryOffline } from './utils/offlineStorage.js';

function CloudAppContent() {
  const toast = useToast();
  const [authState, setAuthState] = useState({
    loading: true,
    authenticated: false,
    user: null,
    folders: null,
    error: null
  });
  const [activeTab, setActiveTab] = useState('whatson'); // 'whatson' | 'channels' | 'services' | 'ondemand' | 'faves' | 'feeds'
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
  const [isRefreshing, setIsRefreshing] = useState(false);
  const notifiedJobsRef = useRef(new Set());
  const initialDownloadsLoadedRef = useRef(false);
  const lastLibraryUpdateRef = useRef(0);
  // The catalogue is large, so a warm start paints the stored snapshot before
  // the first network load and revalidates against its ETag afterwards.
  const libraryCacheRef = useRef({ etag: null, painted: false });

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

  const handleNavTab = (tabId) => {
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
      if (res.ok) {
        const data = await res.json();
        setFavorites(Array.isArray(data.favorites) ? data.favorites : []);
        if (data.isFavorite) {
          toast.success(`Added "${item.title}" to Favorites`);
        } else {
          toast.info(`Removed "${item.title}" from Favorites`);
        }
      }
    } catch (err) {
      console.error('[Favorites] Toggle failed:', err);
    }
  };

  const checkAuth = async () => {
    setAuthState(prev => ({ ...prev, loading: true }));
    const result = await fetchCurrentUser();
    setAuthState({
      loading: false,
      authenticated: result.authenticated,
      user: result.user,
      folders: result.folders,
      error: result.error
    });

    if (result.authenticated) {
      // Warm start: paints the stored snapshot before the network fetch begins
      loadLibrary();
      loadFavorites();
    }
  };

  const handleManualRefresh = async () => {
    setIsRefreshing(true);
    try {
      await loadLibrary();
      toast.success('Library refreshed from Google Drive');
    } catch (_) {
      toast.error('Could not refresh library');
    } finally {
      setIsRefreshing(false);
    }
  };

  const loadLibrary = async () => {
    // First call of the session: show the stored catalogue straight away rather
    // than an empty shelf while the network copy is in flight. Later calls are
    // revalidations and must never replace live state with the snapshot.
    if (!libraryCacheRef.current.painted) {
      libraryCacheRef.current.painted = true;
      try {
        const entry = await getLibraryOfflineEntry();
        if (entry.library) {
          libraryCacheRef.current.etag = entry.etag;
          setLibrary(entry.library);
        }
      } catch (_) {}
    }

    try {
      const res = await fetch('/api/ondemand', {
        cache: 'no-store',
        headers: libraryCacheRef.current.etag
          ? { 'If-None-Match': libraryCacheRef.current.etag }
          : undefined
      });
      // The catalogue is unchanged, so the stored snapshot is still current.
      if (res.status === 304) return;
      const data = await res.json();
      if (!data) return;
      setLibrary(data);
      libraryCacheRef.current.etag = res.headers.get('ETag');
      saveLibraryOffline(data, libraryCacheRef.current.etag);
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

  const handlePlayChannel = (channel, startIndex = 0, offset = 0) => {
    const playlist = (channel.playlist || []).slice();
    if (playlist.length === 0) return;
    const idx = (typeof startIndex === 'number' && startIndex >= 0 && startIndex < playlist.length) ? startIndex : 0;
    if (!playlist[idx]?.path) return;
    stopTorrentStream(activeVideo);
    setChannelPlaylist({ id: channel.id, name: channel.name, items: playlist });
    setChannelIndex(idx);
    setActiveVideo(playlist[idx]);
    setVideoOffset(offset || 0);
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
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#121214' }}>
        <RefreshCw size={36} className="spin" style={{ color: 'var(--primary)' }} />
      </div>
    );
  }

  if (!authState.authenticated) {
    return <LoginScreen error={authState.error} />;
  }

  return (
    <div className="app-layout">
      {/* Unified Desktop Sidebar & Mobile Navigation */}
      <Sidebar
        currentView={activeTab}
        setCurrentView={handleNavTab}
        user={authState.user}
        folders={authState.folders}
        activeDownloadsCount={activeDownloadsCount}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onOpenLoader={() => setIsDownloadsOpen(true)}
        onOpenSearch={() => {
          const input = document.querySelector('.topbar-search-box input');
          if (input) input.focus();
          else setActiveSearch({ query: '', scope: 'unified' });
        }}
      />

      <div className="main-content-wrapper">
        {/* Main Desktop Topbar */}
        <header className="main-topbar desktop-only">
          <form onSubmit={handleSearchSubmit} className="topbar-search-box">
            <Search size={15} style={{ color: '#888', flexShrink: 0 }} />
            <input
              type="text"
              placeholder="Search movies, shows, streams, torrents..."
              value={headerSearch}
              onChange={(e) => setHeaderSearch(e.target.value)}
            />
            {headerSearch && (
              <button
                type="button"
                onClick={() => setHeaderSearch('')}
                className="topbar-search-clear"
                title="Clear search"
              >
                <X size={14} />
              </button>
            )}
          </form>

          <div className="topbar-actions">
            <div
              className="topbar-status-pill"
              onClick={() => setActiveTab('channels')}
              title="Browse 24/7 Live Channels"
            >
              <span className="live-dot-pulse" />
              <span>FREE TV LIVE</span>
            </div>

            <button
              type="button"
              className="topbar-action-btn"
              onClick={() => setIsDownloadsOpen(true)}
              title="Cloud Loader & Downloads"
            >
              <UploadCloud size={16} />
              <span>Downloads</span>
              {activeDownloadsCount > 0 && (
                <span className="topbar-badge">{activeDownloadsCount}</span>
              )}
            </button>

            <button
              type="button"
              className="topbar-action-btn"
              onClick={handleManualRefresh}
              disabled={isRefreshing}
              title="Refresh Google Drive Library"
            >
              <RefreshCw size={15} className={isRefreshing ? 'spin' : ''} />
            </button>

            <button
              type="button"
              className="topbar-action-btn icon-only"
              onClick={() => setIsSettingsOpen(true)}
              title="Cloud Settings"
            >
              <Settings size={16} />
            </button>
          </div>
        </header>

        {/* Mobile Search Input Row */}
        <div className="mobile-search-row">
          <form onSubmit={handleSearchSubmit} className="topbar-search-box" style={{ maxWidth: '100%' }}>
            <Search size={15} style={{ color: '#888', flexShrink: 0 }} />
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
                className="topbar-search-clear"
              >
                <X size={14} />
              </button>
            )}
          </form>
        </div>

        {/* Main Content Area */}
        <main className="main-content-scroll">
          {/* Active Player (Sticky docked card when playing) */}
          {activeVideo && (
            <div className="docked-player-card">
              <TvPlayer
                currentVideo={activeVideo}
                offset={videoOffset}
                onStop={() => { stopTorrentStream(activeVideo); setChannelPlaylist(null); setChannelIndex(0); setActiveVideo(null); }}
                onTimeUpdate={handleTimeUpdate}
                onEnded={handlePlayNext}
              />
              <div className="docked-player-footer">
                <div style={{ minWidth: 0, flex: 1, marginRight: '16px' }}>
                  <div className="docked-player-badge">
                    {activeVideo.isLive && <span className="live-dot-pulse" style={{ width: '6px', height: '6px' }} />}
                    {activeVideo.isLive ? `LIVE STREAM · ${activeVideo.provider || 'FREE TV'}` : (channelPlaylist ? `CHANNEL · ${channelPlaylist.name}` : 'NOW PLAYING')}
                  </div>
                  <h2 className="docked-player-title">
                    {activeVideo.currentProgram?.title && activeVideo.currentProgram.title !== activeVideo.title
                      ? `${activeVideo.title} — ${activeVideo.currentProgram.title}`
                      : (activeVideo.title || activeVideo.filename)}
                  </h2>
                  {channelPlaylist && (
                    <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
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

          {activeTab === 'channels' && (
            <ChannelsView
              onPlayChannel={handlePlayChannel}
              favorites={favorites}
              onToggleFavorite={handleToggleFavorite}
              activeVideo={activeVideo}
              channelPlaylist={channelPlaylist}
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
      </div>

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
          libraryCacheRef.current.etag = null;
          saveLibraryOffline(newLib, null);
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
