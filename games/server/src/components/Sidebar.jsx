import React, { useState } from 'react';
import { Gamepad2, Compass, Download, Heart, Settings, ChevronDown, History, Layers } from 'lucide-react';

const CONSOLE_DISPLAY_NAMES = {
  nes: 'NES',
  snes: 'SNES',
  gb: 'Game Boy',
  gbc: 'GBC',
  gba: 'GBA',
  sega: 'Genesis',
  genesis: 'Genesis',
  megadrive: 'Mega Drive',
  neo: 'Neo Geo',
  neogeo: 'Neo Geo',
  arcade: 'Arcade',
  pce: 'PC Engine',
  tg16: 'TurboGrafx-16',
  gg: 'Game Gear',
  sms: 'Master System',
  pc: 'PC Games',
  web: 'Web Games'
};

export default function Sidebar({
  currentView,
  setCurrentView,
  user,
  onOpenAuthModal,
  onOpenSettings,
  onOpenDrivePicker,
  consoles = [],
  libraryConsole = 'all',
  onSelectConsole,
  isMobileLandscape1080 = false
}) {
  const [libraryOpen, setLibraryOpen] = useState(true);

  const navItems = [
    { id: 'discover', label: "What's New", icon: Compass },
    { id: 'library', label: 'Library', icon: Gamepad2, hasConsoles: consoles.length > 0 },
    { id: 'recent', label: 'Recently played', icon: History },
    { id: 'favorites', label: 'Favorites', icon: Heart },
    { id: 'downloads', label: 'Downloads', icon: Download },
    { id: 'settings', label: 'Settings', icon: Settings },
  ];

  const navigate = (item) => {
    if (item.id === 'library' && onSelectConsole) {
      onSelectConsole(consoles.length ? (libraryConsole || consoles[0].key) : '');
    }
    setCurrentView(item.id);
  };

  const selectConsole = (consoleKey) => {
    if (onSelectConsole) onSelectConsole(consoleKey);
    setCurrentView('library');
  };

  return (
    <>
      {/* Mobile Top App Bar (Hidden in 1080p mobile landscape) */}
      <header className="mobile-header">
        <div className="mobile-title" onClick={() => setCurrentView('library')} style={{ cursor: 'pointer' }}>
          FREE<span style={{ color: '#a855f7' }}>PLAY</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
          <div
            className="mobile-profile-btn"
            onClick={onOpenAuthModal}
            title={user ? `${user.name} (${user.email || ''})` : 'Sign in with Google'}
          >
            {user?.avatar && user.avatar.startsWith('http') ? (
              <img src={user.avatar} alt={user.name || 'User'} className="mobile-profile-img" />
            ) : (
              <span className="mobile-profile-avatar">{user ? '🎮' : '👤'}</span>
            )}
          </div>
        </div>
      </header>

      {/* Sidebar Navigation */}
      <aside className={`sidebar ${isMobileLandscape1080 ? 'sidebar-handheld' : 'desktop-only'}`}>
        {/* Brand Header */}
        <div className="sidebar-header-row">
          <div
            className="sidebar-title"
            onClick={() => setCurrentView('library')}
            style={{ cursor: 'pointer' }}
          >
            FREE<span style={{ color: '#a855f7' }}>PLAY</span>
          </div>
          <span className="sidebar-cloud-badge">ARCADE</span>
        </div>

        {/* Navigation Items */}
        <nav className="sidebar-nav-scroll">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = currentView === item.id;

            // In mobile landscape 1080p, we show a dedicated consoles list directly along the side
            if (item.hasConsoles && !isMobileLandscape1080) {
              return (
                <div key={item.id} className="nav-group">
                  <div
                    className={`nav-item ${isActive ? 'active' : ''}`}
                    onClick={() => navigate(item)}
                    title={item.label}
                  >
                    <Icon size={18} style={{ marginRight: '0.75rem', flexShrink: 0 }} />
                    <span>{item.label}</span>
                    <button
                      type="button"
                      className={`nav-caret ${libraryOpen ? 'open' : ''}`}
                      aria-label={libraryOpen ? 'Hide consoles' : 'Show consoles'}
                      aria-expanded={libraryOpen}
                      onClick={(e) => {
                        e.stopPropagation();
                        setLibraryOpen((open) => !open);
                      }}
                    >
                      <ChevronDown size={15} />
                    </button>
                  </div>

                  {libraryOpen && (
                    <div className="nav-submenu">
                      {consoles.map((c) => (
                        <button
                          key={c.key}
                          type="button"
                          className={`nav-submenu-item ${
                            isActive && libraryConsole === c.key ? 'active' : ''
                          }`}
                          onClick={() => selectConsole(c.key)}
                        >
                          <span className="nav-submenu-label">{CONSOLE_DISPLAY_NAMES[c.key] || c.key}</span>
                          <span className="nav-submenu-count">{c.count}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            }

            return (
              <div
                key={item.id}
                className={`nav-item ${isActive ? 'active' : ''}`}
                onClick={() => navigate(item)}
                title={item.label}
              >
                <Icon size={18} style={{ marginRight: '0.75rem', flexShrink: 0 }} />
                <span>{item.label}</span>
              </div>
            );
          })}

          {/* Consoles listed along the side for Mobile Landscape 1920x1080 Handhelds */}
          {isMobileLandscape1080 && consoles.length > 0 && (
            <div className="handheld-consoles-section">
              <div className="handheld-consoles-header">
                <Layers size={13} className="text-purple-400" />
                <span>CONSOLES</span>
              </div>
              <div className="handheld-consoles-list">
                {consoles.map((c) => {
                  const isConsoleActive = currentView === 'library' && libraryConsole === c.key;
                  const label = CONSOLE_DISPLAY_NAMES[c.key] || c.key.toUpperCase();
                  return (
                    <button
                      key={c.key}
                      type="button"
                      className={`handheld-console-item ${isConsoleActive ? 'active' : ''}`}
                      onClick={() => selectConsole(c.key)}
                      title={`${label} (${c.count} games)`}
                    >
                      <span className="handheld-console-label">{label}</span>
                      <span className="handheld-console-count">{c.count}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </nav>

        {/* User Account / Google Sign-In Card at Bottom */}
        <div className="sidebar-user-section">
          {user ? (
            <div
              className="sidebar-user-card"
              onClick={onOpenSettings || onOpenDrivePicker || onOpenAuthModal}
              title="Click to manage account or switch Google Drive folder"
            >
              <div className="sidebar-user-avatar">
                {user.avatar && user.avatar.startsWith('http') ? (
                  <img src={user.avatar} alt={user.name || 'User'} />
                ) : (
                  <span>🎮</span>
                )}
              </div>
              <div className="sidebar-user-meta">
                <div className="sidebar-user-name">{user.name || 'Player'}</div>
                <div className="sidebar-user-folder">
                  📁 {user.gamesFolderName || 'Select folder...'}
                </div>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="sidebar-signin-btn"
              onClick={onOpenAuthModal}
            >
              <svg viewBox="0 0 24 24" width="16" height="16">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/>
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/>
              </svg>
              <span>Connect Drive</span>
            </button>
          )}
        </div>
      </aside>

      {/* Mobile Bottom Navigation Bar (icons only, hidden in 1080p landscape) */}
      <nav className="mobile-bottom-nav">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = currentView === item.id;
          return (
            <button
              key={item.id}
              type="button"
              className={`mobile-nav-btn ${isActive ? 'active' : ''}`}
              onClick={() => navigate(item)}
              title={item.label}
              aria-label={item.label}
              aria-current={isActive ? 'page' : undefined}
            >
              <Icon size={22} className="mobile-nav-icon" />
            </button>
          );
        })}
      </nav>
    </>
  );
}
