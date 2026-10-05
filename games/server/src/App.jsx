import React, { useState, useEffect, useCallback } from 'react';
import Sidebar from './components/Sidebar';
import LibraryView from './components/LibraryView';
import DiscoverView from './components/DiscoverView';
import DownloadsView from './components/DownloadsView';
import FavoritesView from './components/FavoritesView';
import SettingsView from './components/SettingsView';
import DrivePickerModal from './components/DrivePickerModal';
import EmulatorModal from './components/EmulatorModal';
import AuthModal from './components/AuthModal';
import LoginGate from './components/LoginGate';
import { fetchJson } from './utils/api';

export default function App() {
  const [user, setUser] = useState(null);
  const [authChecking, setAuthChecking] = useState(true);
  const [authError, setAuthError] = useState(null);
  const [currentView, setCurrentView] = useState('library');
  const [games, setGames] = useState([]);
  const [loadingGames, setLoadingGames] = useState(false);
  const [isScanning, setIsScanning] = useState(false);

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
    try {
      const data = await fetchJson('/api/auth/user');
      setUser(data.user || null);
      return data.user;
    } catch {
      setUser(null);
      return null;
    } finally {
      setAuthChecking(false);
    }
  }, []);

  // Fetch games library
  const fetchGames = useCallback(async () => {
    setLoadingGames(true);
    try {
      const data = await fetchJson('/api/games');
      setGames(data.games || []);
    } catch (err) {
      console.warn('[App] Could not load games:', err.message);
    } finally {
      setLoadingGames(false);
    }
  }, []);

  useEffect(() => {
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
    // Optimistic UI update
    setGames((prev) =>
      prev.map((g) => (g.id === gameId ? { ...g, isFavorite: !g.isFavorite } : g))
    );

    try {
      await fetchJson(`/api/games/${gameId}/favorite`, { method: 'POST' });
    } catch (err) {
      console.error('[App] Could not toggle favorite:', err);
      // Revert if failed
      setGames((prev) =>
        prev.map((g) => (g.id === gameId ? { ...g, isFavorite: !g.isFavorite } : g))
      );
    }
  };

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
    <div className="flex h-screen bg-[#070a12] text-slate-200 overflow-hidden">
      {/* Sleek Sidebar Navigation */}
      <Sidebar
        currentView={currentView}
        setCurrentView={setCurrentView}
        user={user}
        onOpenAuthModal={() => setAuthModalOpen(true)}
        onOpenSettings={() => setCurrentView('settings')}
      />

      {/* Main Content Area */}
      <main className="flex-1 ml-64 flex flex-col h-screen overflow-y-auto relative">
        {currentView === 'library' && (
          <LibraryView
            games={games}
            loading={loadingGames}
            onPlayGame={(game) => setActiveGameToPlay(game)}
            onToggleFavorite={handleToggleFavorite}
            onScanDrive={handleScanDrive}
            isScanning={isScanning}
            user={user}
            onOpenSettings={() => setCurrentView('settings')}
          />
        )}

        {currentView === 'discover' && (
          <DiscoverView
            user={user}
            onOpenSettings={() => setCurrentView('settings')}
            onDownloadDispatched={() => setCurrentView('downloads')}
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
            onPlayGame={(game) => setActiveGameToPlay(game)}
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
          onClose={() => setActiveGameToPlay(null)}
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
