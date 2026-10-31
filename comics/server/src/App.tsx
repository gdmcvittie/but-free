import { useState, useEffect, useCallback } from 'react';
import Sidebar from './Sidebar';
import Library, { type Comic } from './Library';
import Reader from './Reader';
import WhatsNewView from './WhatsNewView';
import SearchView from './SearchView';
import DownloadsView from './DownloadsView';
import OmnibusCreatorView from './OmnibusCreatorView';
import OmnibusSplitterView from './OmnibusSplitterView';
import SettingsView from './SettingsView';
import AuthModal, { type GoogleUserProfile } from './AuthModal';
import DrivePickerModal from './DrivePickerModal';
import LoginGate from './LoginGate';
import { apiUrl } from './api';
import './index.css';

export default function App() {
  const [currentView, setCurrentView] = useState('whats-new');
  const [activeComic, setActiveComic] = useState<Comic | null>(null);
  const [pendingDownloadUrl, setPendingDownloadUrl] = useState<string | null>(null);

  // Authentication State
  const [authChecking, setAuthChecking] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [user, setUser] = useState<GoogleUserProfile | null>(null);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [isDrivePickerOpen, setIsDrivePickerOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState<{
    text: string;
    action?: string;
    onClick?: () => void;
  } | null>(null);

  const checkDriveStatus = async () => {
    try {
      const res = await fetch(apiUrl('/api/auth/drive-status'));
      if (res.ok) {
        const data = await res.json();
        if (data.authenticated && (data.revoked || !data.valid)) {
          setToastMessage({
            text: 'Google Drive access has expired or been revoked. Click to reconnect.',
            action: 'Reconnect',
            onClick: () => setIsAuthModalOpen(true)
          });
        }
      }
    } catch (err) {
      console.warn('[App] Could not verify Google Drive token status:', err);
    }
  };

  const [progressVersion, setProgressVersion] = useState(0);
  const [omnibusInitialSeries, setOmnibusInitialSeries] = useState<string | null>(null);

  const handleNavigateToOmnibus = (seriesName?: string) => {
    setOmnibusInitialSeries(seriesName || null);
    setCurrentView('omnibus');
  };

  // Check current login session
  const fetchCurrentUser = async () => {
    try {
      const res = await fetch(apiUrl('/api/auth/me'));
      if (res.ok) {
        const data = await res.json();
        if (data.authenticated && data.user) {
          setUser(data.user);
        } else {
          setUser(null);
          if (data.code === 'VIP_ONLY') setAuthError(data.error || 'This suite is for VIPs only.');
        }
      } else {
        setUser(null);
      }
    } catch (err) {
      console.warn('[App] Could not verify authentication session:', err);
      setUser(null);
    } finally {
      setAuthChecking(false);
    }
  };

  useEffect(() => {
    fetchCurrentUser();

    // Check for auth error in URL
    const urlParams = new URLSearchParams(window.location.search);
    const authErr = urlParams.get('auth_error');
    if (authErr) {
      setAuthError(decodeURIComponent(authErr));
      // Clean query string from browser bar
      window.history.replaceState({}, document.title, window.location.pathname);
    }

    const handleUnauthorized = () => {
      setUser(null);
    };
    window.addEventListener('comix:unauthorized', handleUnauthorized);
    return () => window.removeEventListener('comix:unauthorized', handleUnauthorized);
  }, []);

  const handleLogout = async () => {
    try {
      await fetch(apiUrl('/api/auth/logout'), { method: 'POST' });
    } catch (e) {}
    setUser(null);
    setIsAuthModalOpen(false);
  };

  const handleFolderSelected = (folderId: string, folderName: string) => {
    setUser((prev) => prev ? { ...prev, driveFolderId: folderId, driveFolderName: folderName } : null);
    setProgressVersion((v) => v + 1);
  };

  const handleOpenComic = useCallback((comic: Comic) => {
    try {
      window.history.pushState({ comicReader: comic.id }, '');
    } catch {}
    setActiveComic(comic);
  }, []);

  const handleCloseReader = useCallback(() => {
    if (window.history.state && window.history.state.comicReader) {
      window.history.back();
    } else {
      setActiveComic(null);
      setProgressVersion((v) => v + 1);
    }
  }, []);

  // Listen for browser back navigation
  useEffect(() => {
    const handlePopState = (e: PopStateEvent) => {
      if (!e.state?.comicReader && activeComic) {
        setActiveComic(null);
        setProgressVersion((v) => v + 1);
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [activeComic]);

  const handleTriggerDownload = (chapterUrl: string) => {
    setPendingDownloadUrl(chapterUrl);
    setCurrentView('downloads');
  };

  // Guard 1: Checking authentication status
  if (authChecking) {
    return (
      <div className="auth-loading-screen">
        <div className="auth-loading-card">
          <div className="auth-loading-spinner" />
          <h2 className="auth-loading-title">COMIXOLOFREE</h2>
          <p className="auth-loading-text">Verifying session credentials...</p>
        </div>
      </div>
    );
  }

  // Guard 2: Not authenticated -> Lock down app content completely and show Login Gate
  if (!user) {
    return (
      <LoginGate
        authError={authError}
        onClearAuthError={() => setAuthError(null)}
      />
    );
  }

  return (
    <div className={`app-container ${activeComic ? 'reader-active' : ''}`}>
      {/* Sidebar Navigation */}
      <Sidebar
        currentView={currentView}
        setCurrentView={setCurrentView}
        user={user}
        onOpenAuthModal={() => setIsAuthModalOpen(true)}
        isReaderActive={Boolean(activeComic)}
      />

      {/* Main Content Area */}
      <main className="main-content">
        {currentView === 'library' && (
          <Library
            onOpenComic={handleOpenComic}
            user={user}
            progressVersion={progressVersion}
            onOpenDrivePicker={() => setIsDrivePickerOpen(true)}
            onOpenAuthModal={() => setIsAuthModalOpen(true)}
            onNavigateView={setCurrentView}
            onNavigateToOmnibus={handleNavigateToOmnibus}
          />
        )}

        {currentView === 'continue-reading' && (
          <Library
            onOpenComic={handleOpenComic}
            user={user}
            showContinueReadingOnly={true}
            progressVersion={progressVersion}
            onOpenDrivePicker={() => setIsDrivePickerOpen(true)}
            onOpenAuthModal={() => setIsAuthModalOpen(true)}
            onNavigateView={setCurrentView}
            onNavigateToOmnibus={handleNavigateToOmnibus}
          />
        )}

        {currentView === 'favorites' && (
          <Library
            onOpenComic={handleOpenComic}
            user={user}
            showFavoritesOnly={true}
            progressVersion={progressVersion}
            onOpenDrivePicker={() => setIsDrivePickerOpen(true)}
            onOpenAuthModal={() => setIsAuthModalOpen(true)}
            onNavigateView={setCurrentView}
            onNavigateToOmnibus={handleNavigateToOmnibus}
          />
        )}

        {currentView === 'whats-new' && (
          <WhatsNewView
            user={user}
            onOpenAuthModal={() => setIsAuthModalOpen(true)}
            onOpenDrivePicker={() => setIsDrivePickerOpen(true)}
            onNavigateToDownloads={handleTriggerDownload}
          />
        )}

        {currentView === 'search' && (
          <SearchView
            onOpenComic={handleOpenComic}
            user={user}
            onOpenAuthModal={() => setIsAuthModalOpen(true)}
            onOpenDrivePicker={() => setIsDrivePickerOpen(true)}
          />
        )}

        {currentView === 'downloads' && (
          <DownloadsView
            user={user}
            initialUrl={pendingDownloadUrl}
            onOpenAuthModal={() => setIsAuthModalOpen(true)}
            onOpenDrivePicker={() => setIsDrivePickerOpen(true)}
            onComicDownloaded={() => {
              setPendingDownloadUrl(null);
              setProgressVersion((v) => v + 1);
            }}
          />
        )}

        {currentView === 'omnibus' && (
          <OmnibusCreatorView
            user={user}
            initialSeries={omnibusInitialSeries}
            onOpenComic={handleOpenComic}
            onNavigateView={setCurrentView}
            onOpenAuthModal={() => setIsAuthModalOpen(true)}
          />
        )}

        {currentView === 'omnibus-splitter' && (
          <OmnibusSplitterView
            user={user}
            onOpenComic={handleOpenComic}
            onNavigateView={setCurrentView}
            onOpenAuthModal={() => setIsAuthModalOpen(true)}
          />
        )}

        {currentView === 'settings' && (
          <SettingsView
            user={user}
            onOpenAuthModal={() => setIsAuthModalOpen(true)}
            onOpenDrivePicker={() => setIsDrivePickerOpen(true)}
            onLibraryUpdated={() => setProgressVersion((v) => v + 1)}
            onNavigateToLibrary={() => setCurrentView('library')}
          />
        )}
      </main>

      {/* Reader Overlay */}
      {activeComic && (
        <Reader comic={activeComic} user={user} onClose={handleCloseReader} />
      )}

      {/* Google OAuth Account Modal */}
      <AuthModal
        isOpen={isAuthModalOpen}
        onClose={() => setIsAuthModalOpen(false)}
        user={user}
        onLogout={handleLogout}
        onOpenDrivePicker={() => setIsDrivePickerOpen(true)}
        onLibraryUpdated={() => setProgressVersion((v) => v + 1)}
      />

      {/* Google Drive Token Warning Toast */}
      {toastMessage && (
        <div
          role="alert"
          style={{
            position: 'fixed',
            bottom: '24px',
            right: '24px',
            zIndex: 99999,
            backgroundColor: '#1e293b',
            color: '#f8fafc',
            border: '1px solid #ef4444',
            boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5)',
            padding: '12px 16px',
            borderRadius: '12px',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            fontSize: '0.88rem',
            cursor: toastMessage.onClick ? 'pointer' : 'default',
            maxWidth: '420px',
            animation: 'fadeIn 0.2s ease-out'
          }}
          onClick={() => {
            if (toastMessage.onClick) toastMessage.onClick();
          }}
        >
          <span style={{ fontSize: '1.2rem', color: '#f59e0b' }}>⚠️</span>
          <span style={{ flex: 1, lineHeight: 1.4 }}>{toastMessage.text}</span>
          {toastMessage.action && (
            <span
              style={{
                background: '#3b82f6',
                color: '#fff',
                padding: '4px 10px',
                borderRadius: '6px',
                fontSize: '0.78rem',
                fontWeight: 600,
                whiteSpace: 'nowrap'
              }}
            >
              {toastMessage.action}
            </span>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setToastMessage(null);
            }}
            style={{
              background: 'none',
              border: 'none',
              color: '#94a3b8',
              cursor: 'pointer',
              fontSize: '1rem',
              padding: '2px 4px',
              lineHeight: 1
            }}
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {/* Google Drive Folder Selector Modal */}
      <DrivePickerModal
        isOpen={isDrivePickerOpen}
        onClose={() => setIsDrivePickerOpen(false)}
        currentFolderId={user?.driveFolderId}
        currentFolderName={user?.driveFolderName}
        onFolderSelected={handleFolderSelected}
      />
    </div>
  );
}
