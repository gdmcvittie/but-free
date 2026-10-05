import {
  Sparkles,
  Library,
  Clock,
  Heart,
  ListMusic,
  Search,
  Download,
  Settings as SettingsIcon,
  Car,
  Smartphone
} from 'lucide-react';
import { hasNativeBridge } from './nativeBridge';

const NAV_ITEMS = [
  // What's New is context-aware: it shows AudioBookBay for books and YouTube Music
  // for music, so there is only ever one entry.
  { id: 'whats-new', label: "What's New", icon: Sparkles },
  { id: 'library', label: 'Library', icon: Library },
  { id: 'continue', label: 'Continue', icon: Clock, musicLabel: 'Recently played' },
  { id: 'favorites', label: 'Favourites', icon: Heart },
  { id: 'playlists', label: 'Playlists', icon: ListMusic },
  { id: 'search', label: 'Search', icon: Search },
  { id: 'downloads', label: 'Downloads', icon: Download },
  { id: 'car', label: 'Car Mode', icon: Car },
  { id: 'settings', label: 'Settings', icon: SettingsIcon }
];

const MOBILE_NAV_IDS = ['whats-new', 'library', 'continue', 'favorites', 'search', 'downloads'];

function GoogleIcon({ size = 16 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
    </svg>
  );
}

export default function Sidebar({
  currentView,
  setCurrentView,
  kind,
  onKindChange,
  user,
  onOpenAccount
}) {
  const activeFolderName = kind === 'music' ? user?.musicFolderName : user?.audiobooksFolderName;
  const hasFolder = kind === 'music' ? user?.musicFolderId : user?.audiobooksFolderId;
  // The FRAUDIO Android app injects FraudioNative into its WebView; no point
  // offering the APK download from inside the app itself.
  const inAndroidApp = hasNativeBridge();
  // Favourites exist in both sections now: books have item/author favourites,
  // music has item/artist/album favourites.
  // Music has no books to continue - its history is "Recently played".
  const labelFor = (item) => (kind === 'music' && item.musicLabel ? item.musicLabel : item.label);
  const items = NAV_ITEMS;
  const mobileItems = NAV_ITEMS.filter((item) => MOBILE_NAV_IDS.includes(item.id));

  return (
    <>
      <header className="mobile-header">
        <div className="mobile-title" onClick={() => setCurrentView('whats-new')}>
          FR<span>AUDIO</span>
        </div>
        <div className="mobile-header-actions">
          <div className="sidebar-kind-toggle sidebar-kind-toggle-sm">
            <button
              type="button"
              className={`sidebar-kind-btn ${kind === 'audiobooks' ? 'active' : ''}`}
              onClick={() => onKindChange('audiobooks')}
            >
              Books
            </button>
            <button
              type="button"
              className={`sidebar-kind-btn ${kind === 'music' ? 'active' : ''}`}
              onClick={() => onKindChange('music')}
            >
              Music
            </button>
          </div>
          <button
            type="button"
            className="sidebar-signin-btn"
            style={{ width: 'auto', padding: '0.4rem 0.6rem' }}
            onClick={() => setCurrentView('car')}
            title="Car Mode"
          >
            <Car size={16} />
          </button>
          {!inAndroidApp && (
            <a
              href="/fraudio.apk"
              download="fraudio.apk"
              className="sidebar-signin-btn"
              style={{ width: 'auto', padding: '0.4rem 0.6rem', color: 'var(--accent-color)', textDecoration: 'none' }}
              title="Download Android APK"
            >
              <Smartphone size={16} />
            </a>
          )}
          <button type="button" className="sidebar-signin-btn" style={{ width: 'auto', padding: '0.4rem 0.7rem' }} onClick={onOpenAccount}>
            {user?.avatar ? <img src={user.avatar} alt="" style={{ width: 20, height: 20, borderRadius: '50%' }} /> : <GoogleIcon size={16} />}
          </button>
        </div>
      </header>

      <aside className="sidebar desktop-only">
        <div className="sidebar-header-row">
          <div className="sidebar-title" onClick={() => setCurrentView('whats-new')}>
            FR<span>AUDIO</span>
          </div>
        </div>

        <div className="sidebar-kind-toggle">
          <button
            type="button"
            className={`sidebar-kind-btn ${kind === 'audiobooks' ? 'active' : ''}`}
            onClick={() => onKindChange('audiobooks')}
          >
            Audiobooks
          </button>
          <button
            type="button"
            className={`sidebar-kind-btn ${kind === 'music' ? 'active' : ''}`}
            onClick={() => onKindChange('music')}
          >
            Music
          </button>
        </div>

        <nav>
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <div
                key={item.id}
                className={`nav-item ${currentView === item.id ? 'active' : ''}`}
                onClick={() => setCurrentView(item.id)}
              >
                <Icon size={17} style={{ marginRight: '0.65rem' }} />
                {labelFor(item)}
              </div>
            );
          })}
        </nav>

        {!inAndroidApp && (
          <div style={{ padding: '0.4rem 1rem 0.6rem 1rem' }}>
            <a
              href="/fraudio.apk"
              download="fraudio.apk"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                padding: '0.45rem 0.75rem',
                borderRadius: '8px',
                backgroundColor: 'rgba(61, 220, 151, 0.08)',
                border: '1px solid rgba(61, 220, 151, 0.25)',
                color: 'var(--accent-color)',
                fontSize: '0.78rem',
                fontWeight: 600,
                textDecoration: 'none'
              }}
              title="Download FRAUDIO Android APK"
            >
              <Smartphone size={15} />
              <span>Download APK</span>
            </a>
          </div>
        )}

        <div className="sidebar-user-section">
          <div className="sidebar-user-card" onClick={onOpenAccount} title="Account and Drive folders">
            <div className="sidebar-user-avatar">
              {user?.avatar ? <img src={user.avatar} alt="" /> : <GoogleIcon size={18} />}
            </div>
            <div className="sidebar-user-meta">
              <div className="sidebar-user-name">{user?.name || 'Listener'}</div>
              <div className="sidebar-user-folder">
                {hasFolder ? activeFolderName : `Select ${kind === 'music' ? 'music' : 'audiobooks'} folder…`}
              </div>
            </div>
          </div>
        </div>
      </aside>

      {/* Always rendered: when the player is open the CSS lifts it below it. */}
      <nav className="mobile-bottom-nav">
        {mobileItems.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              className={`mobile-nav-btn ${currentView === item.id ? 'active' : ''}`}
              onClick={() => setCurrentView(item.id)}
              title={labelFor(item)}
              aria-label={labelFor(item)}
              aria-current={currentView === item.id ? 'page' : undefined}
            >
              <Icon size={20} className="mobile-nav-icon" />
              <span className="mobile-nav-label">{labelFor(item)}</span>
            </button>
          );
        })}
      </nav>
    </>
  );
}