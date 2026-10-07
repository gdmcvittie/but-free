import { useState, useEffect, useCallback, useRef } from 'react';
import { WifiOff } from 'lucide-react';
import { api, subscribeToEvents } from './api';
import Sidebar from './Sidebar';
import LoginGate from './LoginGate';
import DrivePickerModal from './DrivePickerModal';
import AccountModal from './AccountModal';
import Library from './Library';
import ContinueListening from './ContinueListening';
import Playlists from './Playlists';
import WhatsNew from './WhatsNew';
import MusicWhatsNew from './MusicWhatsNew';
import SearchView from './SearchView';
import Downloads from './Downloads';
import Settings from './Settings';
import Player from './Player';
import DownloadBar from './DownloadBar';
import CarMode from './CarMode';
import { registerNativeCommands, pushNativeState } from './nativeBridge';

const AUDIOBOOK_FOLDERS = ['audiobooksFolderId', 'audiobooksFolderName'];

export default function App() {
  const [currentView, setCurrentView] = useState('whats-new');
  const [kind, setKindState] = useState(() => {
    try {
      const saved = localStorage.getItem('fraudio.activeSection') || localStorage.getItem('fraudio.activeKind');
      if (saved === 'audiobooks' || saved === 'music') return saved;
    } catch {
      // Storage unavailable or disabled
    }
    return 'audiobooks';
  });

  const setKind = useCallback((nextKind) => {
    setKindState(nextKind);
    try {
      localStorage.setItem('fraudio.activeSection', nextKind);
    } catch {
      // Storage error
    }
  }, []);

  const [whatsNewSeed, setWhatsNewSeed] = useState('');

  const [authChecking, setAuthChecking] = useState(true);
  const [authError, setAuthError] = useState(null);
  const [user, setUser] = useState(null);

  const [isAccountOpen, setIsAccountOpen] = useState(false);
  const [drivePickerKind, setDrivePickerKind] = useState(null);

  // Bumped whenever the library changes so every view refetches in one place.
  const [libraryVersion, setLibraryVersion] = useState(0);
  const [toasts, setToasts] = useState([]);
  const [scanState, setScanState] = useState(null);
  const [queueBarActive, setQueueBarActive] = useState(false);

  // Stable handle so effects that run before runScan is defined (folder
  // connect) can still kick off a scan.
  const runScanRef = useRef(null);
  const autoScannedRef = useRef(false);

  const [queue, setQueue] = useState([]);
  const [queueIndex, setQueueIndex] = useState(-1);
  const activeItem = queueIndex >= 0 ? queue[queueIndex] || null : null;

  const bumpLibrary = useCallback(() => setLibraryVersion((v) => v + 1), []);

  const [isCarMode, setIsCarMode] = useState(false);

  // One "What's New" view for both libraries: `music-whats-new` is a legacy alias
  // so older links still land on the music feed.
  const navigate = useCallback((view, opts = {}) => {
    if (view === 'car') {
      setIsCarMode(true);
      return;
    }
    setCurrentView(view === 'music-whats-new' ? 'whats-new' : view);
    if (opts?.searchQuery) setWhatsNewSeed(opts.searchQuery);
  }, []);

  const recentToastsRef = useRef(new Map());
  const notify = useCallback((title, body = '', isError = false) => {
    const key = `${title}:${body}`;
    const now = Date.now();
    const lastTime = recentToastsRef.current.get(key) || 0;
    if (now - lastTime < 4000) return;
    recentToastsRef.current.set(key, now);
    if (recentToastsRef.current.size > 50) {
      for (const [k, t] of recentToastsRef.current.entries()) {
        if (now - t > 10000) recentToastsRef.current.delete(k);
      }
    }

    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    setToasts((prev) => [...prev, { id, title, body, isError }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5200);
  }, []);

  const dismissToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // ---- network & offline state -------------------------------------------
  const [isOnline, setIsOnline] = useState(() => (typeof navigator !== 'undefined' ? navigator.onLine : true));

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      notify('Back Online', 'Reconnected to server. Listening progress synced.');
    };
    const handleOffline = () => {
      setIsOnline(false);
      notify('Offline Mode', 'Internet connection lost. You can play your downloaded media.', false);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [notify]);

  // ---- auth ---------------------------------------------------------------

  const fetchCurrentUser = useCallback(async () => {
    try {
      const data = await api.me();
      if (data.authenticated && data.user) {
        setUser(data.user);
        try { localStorage.setItem('fraudio.cachedUser', JSON.stringify(data.user)); } catch {}
      } else {
        setUser(null);
        try { localStorage.removeItem('fraudio.cachedUser'); } catch {}
        if (data.code === 'VIP_ONLY') setAuthError(data.error || 'This suite is for VIPs only.');
      }
    } catch (err) {
      console.warn('[App] Could not verify session:', err);
      // If offline or network error, attempt to use cached user
      try {
        const cached = localStorage.getItem('fraudio.cachedUser');
        if (cached) {
          const parsed = JSON.parse(cached);
          setUser(parsed);
          setAuthChecking(false);
          return;
        }
      } catch {}
      setUser(null);
    } finally {
      setAuthChecking(false);
    }
  }, []);

  useEffect(() => {
    fetchCurrentUser();

    const params = new URLSearchParams(window.location.search);
    const err = params.get('auth_error');
    if (err) {
      setAuthError(decodeURIComponent(err));
      window.history.replaceState({}, document.title, window.location.pathname);
    }

    const handleUnauthorized = () => setUser(null);
    window.addEventListener('fraudio:unauthorized', handleUnauthorized);
    return () => window.removeEventListener('fraudio:unauthorized', handleUnauthorized);
  }, [fetchCurrentUser]);

  const handleLogout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // The cookie is cleared server-side on success; a failure here still
      // means we should drop to the login gate.
    }
    try { localStorage.removeItem('fraudio.cachedUser'); } catch {}
    setUser(null);
    setIsAccountOpen(false);
    setQueue([]);
    setQueueIndex(-1);
    // Re-arm the launch auto-scan for the next sign-in.
    autoScannedRef.current = false;
  }, []);

const handleFolderSelected = useCallback((folderKind, folderId, folderName) => {
    setUser((prev) => {
      if (!prev) return prev;
      const [idKey, nameKey] = AUDIOBOOK_FOLDERS;
      return folderKind === 'music'
        ? { ...prev, musicFolderId: folderId, musicFolderName: folderName }
        : { ...prev, [idKey]: folderId, [nameKey]: folderName };
    });
    setDrivePickerKind(null);
    setKind(folderKind === 'music' ? 'music' : 'audiobooks');
    bumpLibrary();
    notify('Folder connected', `Your ${folderKind === 'music' ? 'music' : 'audiobooks'} folder is now "${folderName}".`);
    // Pointing FRAUDIO at a folder should fill the library immediately.
    runScanRef.current?.(folderKind === 'music' ? 'music' : 'audiobooks');
  }, [bumpLibrary, notify]);

  // ---- live server events -------------------------------------------------

  const userIdRef = useRef(null);
  const notifiedJobErrorsRef = useRef(new Set());
  useEffect(() => {
    userIdRef.current = user?.id || null;
  }, [user]);

  useEffect(() => {
    if (!user) return undefined;

    return subscribeToEvents({
      library_changed: (payload) => {
        if (payload.userId && payload.userId !== userIdRef.current) return;
        bumpLibrary();
      },
      library_scan: (payload) => {
        if (payload.userId && payload.userId !== userIdRef.current) return;
        if (payload.done) {
          setScanState(null);
          return;
        }
        setScanState({
          processed: payload.processed ?? (typeof payload.current === 'number' ? payload.current : 0),
          total: payload.total ?? 0,
          current: payload.name || payload.message || (typeof payload.current === 'string' ? payload.current : '') || ''
        });
      },
      download_status: (payload) => {
        if (payload.userId && payload.userId !== userIdRef.current) return;
        if (payload.status === 'done') bumpLibrary();
        if (payload.status === 'error') {
          const jobId = payload.jobId || payload.id;
          if (jobId) {
            if (notifiedJobErrorsRef.current.has(jobId)) return;
            notifiedJobErrorsRef.current.add(jobId);
          }
          notify('Download failed', payload.error || payload.message || 'Unknown error', true);
        }
      },
      offline_changed: () => bumpLibrary()
    });
  }, [user, bumpLibrary, notify]);

  // Scan progress arrives on its own event; clear it once the scan POST returns.
  // Pass an explicit kind for background passes (launch/folder connect); the
  // Library button uses the current section.
  const runScan = useCallback(async (scanKind = kind) => {
    setScanState({ processed: 0, total: 0, current: 'Starting…' });
    try {
      const result = await api.scanLibrary(scanKind);
      notify('Library scanned', `${result.count} item${result.count === 1 ? '' : 's'} indexed.`);
      bumpLibrary();
      return result;
    } catch (err) {
      notify('Scan failed', err.message, true);
      return null;
    } finally {
      setScanState(null);
    }
  }, [kind, bumpLibrary, notify]);

  // Keep the latest runScan without re-triggering the launch effect.
  useEffect(() => { runScanRef.current = runScan; }, [runScan]);

  // Auto-scan once per session when Drive folders are connected - the library
  // should never look stale right after launch.
  useEffect(() => {
    if (!user || authChecking || autoScannedRef.current) return undefined;
    const sessionKey = `fraudio.autoScanned.${user.id || 'me'}`;
    try {
      if (sessionStorage.getItem(sessionKey)) {
        autoScannedRef.current = true;
        return undefined;
      }
    } catch {}

    const connected = [];
    if (user.audiobooksFolderId) connected.push('audiobooks');
    if (user.musicFolderId) connected.push('music');
    if (!connected.length) return undefined;

    let cancelled = false;
    autoScannedRef.current = true;
    (async () => {
      try {
        const settings = await api.settings();
        if (cancelled) return;
        if (settings?.autoScanOnLaunch === false) return;
      } catch { /* unknown setting: scan anyway, it is the safe default */ }
      if (cancelled) return;
      try { sessionStorage.setItem(sessionKey, 'true'); } catch {}
      for (const scanKind of connected) {
        if (cancelled) return;
        await runScanRef.current?.(scanKind);
      }
    })();
    return () => { cancelled = true; };
  }, [user, authChecking]);

  // ---- playback queue -----------------------------------------------------

  const [shuffle, setShuffle] = useState(false);
  const [playTrigger, setPlayTrigger] = useState(0);
  const historyRef = useRef([]);

  const play = useCallback((item, context, opts = {}) => {
    if (!item) return;
    if (opts?.shuffle !== undefined) {
      setShuffle(Boolean(opts.shuffle));
    }
    historyRef.current = [];
    if (Array.isArray(context) && context.length) {
      const idx = context.findIndex((i) => i.id === item.id);
      setQueue(context);
      setQueueIndex(idx >= 0 ? idx : 0);
    } else {
      setQueue([item]);
      setQueueIndex(0);
    }
    setPlayTrigger((t) => t + 1);
  }, []);

  const playQueueAt = useCallback((index) => {
    if (index < 0 || index >= queue.length) return;
    setQueueIndex(index);
  }, [queue.length]);

  const skipNext = useCallback(() => {
    if (!queue.length) return;
    if (shuffle && queue.length > 1) {
      historyRef.current.push(queueIndex);
      let nextIdx = Math.floor(Math.random() * queue.length);
      if (nextIdx === queueIndex) {
        nextIdx = (nextIdx + 1) % queue.length;
      }
      playQueueAt(nextIdx);
    } else {
      playQueueAt(queueIndex + 1);
    }
  }, [queue.length, queueIndex, shuffle, playQueueAt]);

  const skipPrev = useCallback(() => {
    if (shuffle && historyRef.current.length > 0) {
      const prevIdx = historyRef.current.pop();
      playQueueAt(prevIdx);
    } else {
      playQueueAt(queueIndex - 1);
    }
  }, [shuffle, playQueueAt, queueIndex]);

  const stopPlayback = useCallback(() => {
    pushNativeState({ playing: false, stop: true });
    setQueue([]);
    setQueueIndex(-1);
    historyRef.current = [];
  }, []);

  // Route native (Android lock screen / notification / headset) transport
  // commands into the same handlers the UI uses.
  useEffect(() => {
    return registerNativeCommands({
      play: () => window.dispatchEvent(new Event('fraudio:native-play')),
      pause: () => window.dispatchEvent(new Event('fraudio:native-pause')),
      next: () => skipNext(),
      prev: () => skipPrev(),
      seek: (value) =>
        window.dispatchEvent(new CustomEvent('fraudio:car-seek-to', { detail: value })),
      rewind: () =>
        window.dispatchEvent(new CustomEvent('fraudio:car-seek-by', { detail: -15 })),
      forward: () =>
        window.dispatchEvent(new CustomEvent('fraudio:car-seek-by', { detail: 30 }))
    });
  }, [skipNext, skipPrev]);

  const toggleFavorite = useCallback(async (item, nextValue) => {
    try {
      if (item.isMultiPart && Array.isArray(item.parts) && item.parts.length) {
        await api.setFavoritesBulk(item.parts.map((p) => p.id), nextValue);
        const partIds = new Set(item.parts.map((p) => p.id));
        setQueue((prev) => prev.map((q) => (partIds.has(q.id) ? { ...q, favorite: nextValue } : q)));
      } else {
        await api.setFavorite(item.id, nextValue);
        setQueue((prev) => prev.map((q) => (q.id === item.id ? { ...q, favorite: nextValue } : q)));
      }
      bumpLibrary();
    } catch (err) {
      notify('Could not update favourite', err.message, true);
    }
  }, [bumpLibrary, notify]);

  // ---- guards -------------------------------------------------------------

  if (authChecking) {
    return (
      <div className="auth-loading-screen">
        <div className="auth-loading-card">
          <div className="auth-loading-spinner" />
          <h2 className="auth-loading-title">FRAUDIO</h2>
          <p className="auth-loading-text">Verifying session…</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <LoginGate
        authError={authError}
        onClearAuthError={() => setAuthError(null)}
      />
    );
  }

  return (
    <div className="app-container">
      <Sidebar
        currentView={currentView}
        setCurrentView={navigate}
        kind={kind}
        onKindChange={setKind}
        user={user}
        onOpenAccount={() => setIsAccountOpen(true)}
        onOpenDrivePicker={setDrivePickerKind}
      />

      <main className={`main-content ${activeItem ? 'has-player' : ''} ${queueBarActive ? 'has-download-bar' : ''}`}>
        {!isOnline && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.5rem',
              padding: '0.5rem 1rem',
              marginBottom: '1rem',
              borderRadius: '8px',
              backgroundColor: 'rgba(234, 179, 8, 0.12)',
              border: '1px solid rgba(234, 179, 8, 0.35)',
              color: '#eab308',
              fontSize: '0.82rem',
              fontWeight: 500
            }}
          >
            <WifiOff size={15} />
            <span>Offline mode — playing downloaded content from this device</span>
          </div>
        )}
        {currentView === 'whats-new' && (
          kind === 'music' ? (
            <MusicWhatsNew
              user={user}
              libraryVersion={libraryVersion}
              initialQuery={whatsNewSeed}
              onOpenDrivePicker={setDrivePickerKind}
              onNavigate={navigate}
              notify={notify}
            />
          ) : (
            <WhatsNew
              user={user}
              libraryVersion={libraryVersion}
              onOpenDrivePicker={setDrivePickerKind}
              onPlay={play}
              onNavigate={navigate}
              notify={notify}
            />
          )
        )}

        {currentView === 'library' && (
          <Library
            kind={kind}
            user={user}
            libraryVersion={libraryVersion}
            scanState={scanState}
            onScan={runScan}
            onOpenDrivePicker={setDrivePickerKind}
            onPlay={play}
            onToggleFavorite={toggleFavorite}
            onRefresh={bumpLibrary}
            notify={notify}
          />
        )}

        {currentView === 'continue' && (
          <ContinueListening
            kind={kind}
            libraryVersion={libraryVersion}
            onPlay={play}
            onNavigate={navigate}
          />
        )}

        {currentView === 'playlists' && (
          <Playlists
            kind={kind}
            libraryVersion={libraryVersion}
            onPlay={play}
            onNavigate={navigate}
            notify={notify}
          />
        )}

        {currentView === 'favorites' && (
          <Library
            kind={kind}
            user={user}
            libraryVersion={libraryVersion}
            favoritesOnly
            onOpenDrivePicker={setDrivePickerKind}
            onPlay={play}
            onToggleFavorite={toggleFavorite}
            onRefresh={bumpLibrary}
            notify={notify}
          />
        )}

        {currentView === 'search' && (
          <SearchView
            kind={kind}
            user={user}
            onOpenDrivePicker={setDrivePickerKind}
            onPlay={play}
            onToggleFavorite={toggleFavorite}
            onNavigate={navigate}
            notify={notify}
          />
        )}

        {currentView === 'downloads' && (
          <Downloads
            kind={kind}
            user={user}
            libraryVersion={libraryVersion}
            onOpenDrivePicker={setDrivePickerKind}
            onNavigate={navigate}
            notify={notify}
          />
        )}

        {currentView === 'settings' && (
          <Settings
            user={user}
            libraryVersion={libraryVersion}
            onOpenDrivePicker={setDrivePickerKind}
            onLogout={handleLogout}
            notify={notify}
          />
        )}
      </main>

      <DownloadBar
        hasPlayer={Boolean(activeItem)}
        onOpenQueue={() => { setKind('music'); navigate('downloads'); }}
        onActiveChange={setQueueBarActive}
      />

      {activeItem && (
        <Player
          key={activeItem.id}
          item={activeItem}
          playTrigger={playTrigger}
          hasNext={shuffle ? queue.length > 1 : queueIndex < queue.length - 1}
          hasPrev={shuffle ? (historyRef.current.length > 0 || queueIndex > 0) : queueIndex > 0}
          shuffle={shuffle}
          onToggleShuffle={() => setShuffle((s) => !s)}
          onNext={skipNext}
          onPrev={skipPrev}
          onClose={stopPlayback}
          onOpenCarMode={() => setIsCarMode(true)}
          onEnded={skipNext}
          onProgressSaved={bumpLibrary}
          onToggleFavorite={toggleFavorite}
          queue={queue}
          queueIndex={queueIndex}
          onPlayQueueAt={playQueueAt}
        />
      )}

      {isCarMode && (
        <CarMode
          activeItem={activeItem}
          hasNext={shuffle ? queue.length > 1 : queueIndex < queue.length - 1}
          hasPrev={shuffle ? (historyRef.current.length > 0 || queueIndex > 0) : queueIndex > 0}
          onNext={skipNext}
          onPrev={skipPrev}
          onPlayItem={play}
          onClose={() => {
            setIsCarMode(false);
            if (currentView === 'car') setCurrentView('library');
          }}
          notify={notify}
        />
      )}

      <AccountModal
        isOpen={isAccountOpen}
        onClose={() => setIsAccountOpen(false)}
        user={user}
        onLogout={handleLogout}
        onOpenDrivePicker={setDrivePickerKind}
        onOpenSettings={() => {
          setIsAccountOpen(false);
          navigate('settings');
        }}
      />

      <DrivePickerModal
        isOpen={Boolean(drivePickerKind)}
        kind={drivePickerKind || 'audiobooks'}
        currentFolderId={
          drivePickerKind === 'music' ? user.musicFolderId : user.audiobooksFolderId
        }
        currentFolderName={
          drivePickerKind === 'music' ? user.musicFolderName : user.audiobooksFolderName
        }
        onFolderSelected={handleFolderSelected}
        onClose={() => setDrivePickerKind(null)}
      />

      <div className="toast-stack">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`toast ${toast.isError ? 'error' : ''}`}
            onClick={() => dismissToast(toast.id)}
            role="status"
          >
            <div className="toast-title">{toast.title}</div>
            {toast.body && <div className="toast-body">{toast.body}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
