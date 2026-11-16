import React from 'react';
import {
  Tv,
  Radio,
  Layers,
  HardDrive,
  Heart,
  Rss,
  UploadCloud,
  Settings as SettingsIcon,
  Search
} from 'lucide-react';
import { loginWithGoogle } from '../utils/auth.js';

export default function Sidebar({
  currentView,
  setCurrentView,
  user,
  folders,
  activeDownloadsCount = 0,
  onOpenSettings,
  onOpenLoader,
  onOpenSearch
}) {
  const navItems = [
    { id: 'whatson', label: "What's On", icon: Tv },
    { id: 'channels', label: 'Channels', icon: Radio },
    { id: 'services', label: 'Services', icon: Layers },
    { id: 'ondemand', label: 'Drive Library', icon: HardDrive },
    { id: 'faves', label: 'Favorites', icon: Heart },
    { id: 'feeds', label: 'RSS Releases', icon: Rss },
    { id: 'loader', label: 'Cloud Loader', icon: UploadCloud, badge: activeDownloadsCount },
    { id: 'settings', label: 'Settings', icon: SettingsIcon },
  ];

  const mobileNavItems = [
    { id: 'whatson', label: "What's On", icon: Tv },
    { id: 'channels', label: 'Channels', icon: Radio },
    { id: 'services', label: 'Services', icon: Layers },
    { id: 'ondemand', label: 'Drive', icon: HardDrive },
    { id: 'faves', label: 'Faves', icon: Heart },
    { id: 'feeds', label: 'Feeds', icon: Rss },
  ];

  const handleNavClick = (id) => {
    if (id === 'loader' && onOpenLoader) {
      onOpenLoader();
      return;
    }
    if (id === 'settings' && onOpenSettings) {
      onOpenSettings();
      return;
    }
    setCurrentView(id);
  };

  // Determine active folder name for display
  const activeFolderName = folders?.moviesFolderName || folders?.showsFolderName || (user ? 'Drive Connected' : 'Select folder...');

  return (
    <>
      {/* Mobile Top App Bar */}
      <header className="mobile-header">
        <div className="mobile-title" onClick={() => setCurrentView('whatson')} style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <div className="adobe-app-badge" style={{ width: 26, height: 26, borderRadius: 3, background: '#7c3aed', color: '#fff' }}>
            <span className="adobe-app-badge-text" style={{ fontSize: 11 }}>Ft</span>
          </div>
          <span style={{ fontWeight: 800, letterSpacing: '0.5px' }}>FREEVEE</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {onOpenSearch && (
            <button
              type="button"
              className="mobile-header-icon-btn"
              onClick={onOpenSearch}
              title="Search"
            >
              <Search size={18} />
            </button>
          )}

          <button
            type="button"
            className="mobile-header-icon-btn"
            onClick={onOpenLoader}
            title="Cloud Loader"
            style={{ position: 'relative' }}
          >
            <UploadCloud size={18} />
            {activeDownloadsCount > 0 && (
              <span className="mobile-badge-dot">{activeDownloadsCount}</span>
            )}
          </button>

          <div
            className="mobile-profile-btn"
            onClick={user ? onOpenSettings : loginWithGoogle}
            title={user ? `${user.name} (${user.email || ''})` : 'Sign in with Google'}
          >
            {user?.picture && user.picture.startsWith('http') ? (
              <img src={user.picture} alt={user.name || 'User'} className="mobile-profile-img" />
            ) : (
              <span className="mobile-profile-avatar">👤</span>
            )}
          </div>
        </div>
      </header>

      {/* Desktop Sidebar Navigation */}
      <aside className="sidebar desktop-only">
        {/* Brand Header */}
        <div className="sidebar-header-row">
          <div
            className="sidebar-brand-wrapper"
            onClick={() => setCurrentView('whatson')}
            title="Freevee Television Workstation"
          >
            <div className="adobe-app-badge" style={{ background: '#7c3aed', color: '#fff' }}>
              <span className="adobe-app-badge-text">Ft</span>
            </div>
            <div className="sidebar-brand-meta">
              <span className="sidebar-brand-title">FREEVEE</span>
              <span className="sidebar-brand-subtitle">TV</span>
            </div>
          </div>
        </div>

        {/* Navigation Items */}
        <nav className="sidebar-nav-scroll">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = currentView === item.id;
            return (
              <div
                key={item.id}
                className={`nav-item ${isActive ? 'active' : ''}`}
                onClick={() => handleNavClick(item.id)}
                title={item.label}
              >
                <Icon size={18} style={{ marginRight: '0.75rem', flexShrink: 0 }} />
                <span style={{ flex: 1 }}>{item.label}</span>
                {item.badge > 0 && (
                  <span className="nav-badge-pill">
                    {item.badge}
                  </span>
                )}
              </div>
            );
          })}
        </nav>

        {/* User Account / Google Sign-In Card at Bottom */}
        <div className="sidebar-user-section">
          {user ? (
            <div
              className="sidebar-user-card"
              onClick={onOpenSettings}
              title="Click to manage settings or Google Drive folders"
            >
              <div className="sidebar-user-avatar">
                {user.picture && user.picture.startsWith('http') ? (
                  <img src={user.picture} alt={user.name || 'User'} />
                ) : (
                  <span>👤</span>
                )}
              </div>
              <div className="sidebar-user-meta">
                <div className="sidebar-user-name">{user.name || 'User'}</div>
                <div className="sidebar-user-folder" title={activeFolderName}>
                  📁 {activeFolderName}
                </div>
              </div>
              <SettingsIcon size={14} style={{ color: '#888', flexShrink: 0 }} />
            </div>
          ) : (
            <button
              type="button"
              className="sidebar-signin-btn"
              onClick={loginWithGoogle}
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

      {/* Mobile Bottom Navigation Bar */}
      <nav className="mobile-bottom-nav">
        {mobileNavItems.map((item) => {
          const Icon = item.icon;
          const isActive = currentView === item.id;
          return (
            <button
              key={item.id}
              type="button"
              className={`mobile-nav-btn ${isActive ? 'active' : ''}`}
              onClick={() => handleNavClick(item.id)}
              title={item.label}
              aria-label={item.label}
              aria-current={isActive ? 'page' : undefined}
            >
              <Icon size={20} className="mobile-nav-icon" />
              <span className="mobile-nav-label">{item.label}</span>
            </button>
          );
        })}
      </nav>
    </>
  );
}
