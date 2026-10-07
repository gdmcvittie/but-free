import React, { useState, useEffect, useCallback, useMemo } from 'react';
import Sidebar from './components/Sidebar';
import LibraryView from './components/LibraryView';
import DiscoverView from './components/DiscoverView';
import DownloadsView from './components/DownloadsView';
import FavoritesView from './components/FavoritesView';
import RecentlyPlayedView from './components/RecentlyPlayedView';
import SettingsView from './components/SettingsView';
import DrivePickerModal from './components/DrivePickerModal';
import EmulatorModal from './components/EmulatorModal';
import AuthModal from './components/AuthModal';
import LoginGate from './components/LoginGate';
import { fetchJson } from './utils/api';
import {
  cacheGameForOffline,
  isAndroidOfflineMode,
  loadOfflineLibrary,
  requestOfflineStorage,
  saveOfflineLibrary
} from './utils/offlineGames';

export default function App() {
  const [user, setUser] = useState(null);
  const [authChecking, setAuthChecking] = useState(true);
  const [authError, setAuthError] = useState(null);
  const [currentView, setCurrentView] = useState('library');
  const [libraryConsole, setLibraryConsole] = useState('');
  const [games, setGames] = useState([]);
  const [loadingGames, setLoadingGames] = useState(false);
  const [isScanning, setIsScanning] = useState(false);

  // Console breakdown of the library, drives the Library sidebar dropdown
  const consoles = useMemo(() => {
    const counts = {};
    games.forEach((g) => {
      const key = (g.console || 'other').toLowerCase();
      counts[key] = (counts[key] || 0) + 1;
    });
    return Object.entries(counts)
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }, [games]);

  // There is no "all consoles" tab anymore, so the library always opens on the
  // first alphabetical console (kept as-is while it still exists in the library).
  useEffect(() => {
    if (consoles.length === 0) return;
    setLibraryConsole((cur) =>
      cur && consoles.some((c) => c.key === cur) ? cur : consoles[0].key
    );
  }, [consoles]);

  // Modals state
  const [drivePickerOpen, setDrivePickerOpen] = useState(false);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [activeGameToPlay, setActiveGameToPlay] = useState(null);

  // Check URL params for auth errors or successful redirects
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const err = params.get('auth_error') || params.get('error');
    if (err) {
      setAuthError(err);
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, []);

  // Fetch current authenticated user
  const fetchUser = useCallback(async () => {
    if (isAndroidOfflineMode()) {
      const cached = loadOfflineLibrary();
      setUser(cached.user);
      setAuthChecking(false);
      return cached.user;
    }
    try {
      const data = await fetchJson('/api/auth/user');
      setUser(data.user || null);
      if (data.user) saveOfflineLibrary(data.user, null);
      return data.user;
    } catch (err) {
      if (err.code === 'VIP_ONLY') setAuthError(err.message || 'This suite is for VIPs only.');
      const cached = loadOfflineLibrary();
      const offlineUser = err.code === 'VIP_ONLY' ? null : (isAndroidOfflineMode() || !navigator.onLine ? cached.user : null);
      setUser(offlineUser);
      return offlineUser;
    } finally {
      setAuthChecking(false);
    }
  }, []);

  // Fetch games library
  const fetchGames = useCallback(async () => {
    setLoadingGames(true);
    if (isAndroidOfflineMode()) {
      const cached = loadOfflineLibrary();
      setGames(cached.games);
      setLoadingGames(false);
      return;
    }
    try {
      const data = await fetchJson('/api/games');
      const nextGames = data.games || [];
      setGames(nextGames);
      saveOfflineLibrary(null, nextGames);
    } catch (err) {
      console.warn('[App] Could not load games:', err.message);
      if (!navigator.onLine) setGames(loadOfflineLibrary().games);
    } finally {
      setLoadingGames(false);
    }
  }, []);

  useEffect(() => {
    requestOfflineStorage();
    fetchUser().then((currentUser) => {
      if (currentUser) {
        fetchGames();
      }
    });

    const handleUnauthorized = () => {
      setUser(null);
    };

    window.addEventListener('freeplay:unauthorized', handleUnauthorized);
    return () => window.removeEventListener('freeplay:unauthorized', handleUnauthorized);
  }, [fetchUser, fetchGames]);

  // Scan Google Drive folder for ROMs
  const handleScanDrive = async () => {
    if (!user?.gamesFolderId) {
      setDrivePickerOpen(true);
      return;
    }
    setIsScanning(true);
    try {
      await fetchJson('/api/games/scan', { method: 'POST' });
      await fetchGames();
    } catch (err) {
      console.error('[App] Scan error:', err);
    } finally {
      setIsScanning(false);
    }
  };

  // Toggle favorite status
  const handleToggleFavorite = async (gameId) => {
    const currentGame = games.find((game) => game.id === gameId);
    const favoritedGame = currentGame ? { ...currentGame, isFavorite: !currentGame.isFavorite } : null;
    // Optimistic UI update
    setGames((prev) => {
      const next = prev.map((g) => g.id === gameId && favoritedGame ? favoritedGame : g);
      saveOfflineLibrary(null, next);
      return next;
    });

    if (favoritedGame?.isFavorite) cacheGameForOffline(favoritedGame, user?.id);
    if (isAndroidOfflineMode()) return;

    try {
      await fetchJson(`/api/games/${gameId}/favorite`, { method: 'POST' });
    } catch (err) {
      console.error('[App] Could not toggle favorite:', err);
      // Revert if failed
      setGames((prev) => {
        const next = prev.map((g) => (g.id === gameId ? { ...g, isFavorite: !g.isFavorite } : g));
        saveOfflineLibrary(null, next);
        return next;
      });
    }
  };

  // Launch a game: open the player and record it in the play history
  const handlePlayGame = useCallback((game) => {
    if (!game?.id) return;
    setActiveGameToPlay(game);
    cacheGameForOffline(game, user?.id);
    if (isAndroidOfflineMode()) return;
    fetchJson(`/api/games/${encodeURIComponent(game.id)}/play`, { method: 'POST' }).catch((err) => {
      console.warn('[App] Could not record play:', err.message);
    });
  }, [user]);

  // Callback when user picks a folder in DrivePickerModal
  const handleFolderSelected = (folderId, folderName) => {
    setUser((prev) => (prev ? { ...prev, gamesFolderId: folderId, gamesFolderName: folderName } : prev));
    setDrivePickerOpen(false);
    // Kick off an initial scan of the newly selected folder
    handleScanDrive();
  };

  if (authChecking) {
    return (
      <div className="min-h-screen bg-[#070a12] flex flex-col items-center justify-center gap-3 text-slate-400">
        <div className="w-10 h-10 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
        <p className="text-xs font-semibold tracking-wider uppercase text-slate-500 font-heading">
          Initializing FREEPLAY...
        </p>
      </div>
    );
  }

  // If not logged in, show LoginGate matching ComixoloFree & Fraudio
  if (!user) {
    return (
      <LoginGate
        authError={authError}
        onClearAuthError={() => setAuthError(null)}
      />
    );
  }

  return (
    <div className="flex flex-col md:flex-row h-screen bg-[#070a12] text-slate-200 overflow-hidden">
      {/* Sleek Sidebar Navigation */}
      <Sidebar
        currentView={currentView}
        setCurrentView={setCurrentView}
        user={user}
        consoles={consoles}
        libraryConsole={libraryConsole}
        onSelectConsole={setLibraryConsole}
        onOpenAuthModal={() => setAuthModalOpen(true)}
        onOpenSettings={() => setCurrentView('settings')}
      />

      {/* Main Content Area */}
      <main className="flex-1 min-w-0 flex flex-col h-screen overflow-y-auto relative">
        {currentView === 'library' && (
          <LibraryView
            games={games}
            loading={loadingGames}
            selectedConsole={libraryConsole}
            onSelectConsole={setLibraryConsole}
            onPlayGame={handlePlayGame}
            onToggleFavorite={handleToggleFavorite}
            onScanDrive={handleScanDrive}
            isScanning={isScanning}
            user={user}
            onOpenSettings={() => setCurrentView('settings')}
          />
        )}

        {currentView === 'recent' && (
          <RecentlyPlayedView
            games={games}
            onPlayGame={handlePlayGame}
            onToggleFavorite={handleToggleFavorite}
            onNavigateToLibrary={() => setCurrentView('library')}
          />
        )}

        {currentView === 'discover' && (
          <DiscoverView
            user={user}
            onOpenSettings={() => setCurrentView('settings')}
            onDownloadDispatched={() => setCurrentView('downloads')}
            onLibraryUpdated={fetchGames}
          />
        )}

        {currentView === 'downloads' && (
          <DownloadsView
            user={user}
            onOpenSettings={() => setCurrentView('settings')}
          />
        )}

        {currentView === 'favorites' && (
          <FavoritesView
            games={games}
            onPlayGame={handlePlayGame}
            onToggleFavorite={handleToggleFavorite}
            onNavigateToLibrary={() => setCurrentView('library')}
          />
        )}

        {currentView === 'settings' && (
          <SettingsView
            user={user}
            onOpenAuthModal={() => setAuthModalOpen(true)}
            onOpenDrivePicker={() => setDrivePickerOpen(true)}
            onLibraryUpdated={fetchGames}
          />
        )}
      </main>

      {/* In-Browser Emulator Modal */}
      {activeGameToPlay && (
        <EmulatorModal
          game={activeGameToPlay}
          user={user}
          onClose={() => setActiveGameToPlay(null)}
          onToggleFavorite={handleToggleFavorite}
        />
      )}

      {/* Google Drive Folder Picker Modal */}
      <DrivePickerModal
        isOpen={drivePickerOpen}
        onClose={() => setDrivePickerOpen(false)}
        onFolderSelected={handleFolderSelected}
        currentFolderId={user?.gamesFolderId}
      />

      {/* Auth Modal */}
      <AuthModal
        isOpen={authModalOpen}
        onClose={() => setAuthModalOpen(false)}
      />
    </div>
  );
}
