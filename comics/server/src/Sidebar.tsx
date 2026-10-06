import React from 'react';
import { Flame, BookOpen, Clock, BookOpenCheck, Scissors, Search, Download, Heart, Settings, User, Folder } from 'lucide-react';
import type { GoogleUserProfile } from './AuthModal';

interface SidebarProps {
  currentView: string;
  setCurrentView: (view: string) => void;
  user: GoogleUserProfile | null;
  onOpenAuthModal: () => void;
  isReaderActive?: boolean;
}

const navItems = [
  { id: 'whats-new', label: "What's New", icon: Flame },
  { id: 'library', label: 'Library', icon: BookOpen },
  { id: 'continue-reading', label: 'Continue', icon: Clock },
  { id: 'omnibus', label: 'Omnibus Creator', icon: BookOpenCheck },
  { id: 'omnibus-splitter', label: 'Omnibus Splitter', icon: Scissors },
  { id: 'search', label: 'Search', icon: Search },
  { id: 'downloads', label: 'Downloads & Pull List', icon: Download },
  { id: 'favorites', label: 'Favorites', icon: Heart },
  { id: 'settings', label: 'Settings', icon: Settings }
];

const mobileNavItems = [
  { id: 'whats-new', label: 'New', icon: Flame },
  { id: 'library', label: 'Library', icon: BookOpen },
  { id: 'omnibus', label: 'Omnibus', icon: BookOpenCheck },
  { id: 'search', label: 'Search', icon: Search },
  { id: 'downloads', label: 'Downloads', icon: Download }
];

export default function Sidebar({
  currentView,
  setCurrentView,
  user,
  onOpenAuthModal,
  isReaderActive
}: SidebarProps) {
  return (
    <>
      {/* Mobile Top App Bar */}
      {!isReaderActive && (
        <header className="mobile-header">
          <div className="mobile-title" onClick={() => setCurrentView('whats-new')}>
            COMIXOLO<span style={{ color: '#4ade80' }}>FREE</span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
            <div
              className="mobile-profile-btn"
              onClick={onOpenAuthModal}
              title={user ? `${user.name} (${user.email})` : 'Sign in with Google'}
            >
              {user?.avatar && user.avatar.startsWith('http') ? (
                <img src={user.avatar} alt={user.name} className="mobile-profile-img" />
              ) : (
                <span className="mobile-profile-avatar">
                  <User size={18} />
                </span>
              )}
            </div>
          </div>
        </header>
      )}

      {/* Desktop Sidebar */}
      <aside className="sidebar desktop-only">
        <div className="sidebar-header-row">
          <div className="sidebar-title" onClick={() => setCurrentView('whats-new')} style={{ cursor: 'pointer' }}>
            COMIXOLO<span style={{ color: '#4ade80' }}>FREE</span>
          </div>
        </div>

        <nav>
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <div
                key={item.id}
                className={`nav-item ${currentView === item.id ? 'active' : ''}`}
                onClick={() => setCurrentView(item.id)}
              >
                <Icon size={18} style={{ marginRight: '0.75rem', flexShrink: 0 }} />
                {item.label}
              </div>
            );
          })}
        </nav>

        {/* User Account / Google Sign-In Card at Bottom */}
        <div className="sidebar-user-section">
          {user ? (
            <div
              className="sidebar-user-card"
              onClick={onOpenAuthModal}
              title="Click to manage account or switch Google Drive folder"
            >
              <div className="sidebar-user-avatar">
                {user.avatar && user.avatar.startsWith('http') ? (
                  <img src={user.avatar} alt={user.name} />
                ) : (
                  <User size={20} />
                )}
              </div>
              <div className="sidebar-user-meta">
                <div className="sidebar-user-name">{user.name}</div>
                <div className="sidebar-user-folder">
                  <Folder size={13} style={{ flexShrink: 0 }} />
                  {user.driveFolderName || 'Select folder...'}
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
              <span>Sign in with Google</span>
            </button>
          )}
        </div>
      </aside>

      {/* Mobile Bottom Navigation Bar (icons only) */}
      {!isReaderActive && (
        <nav className="mobile-bottom-nav">
          {mobileNavItems.map((item) => {
            const Icon = item.icon;
            const isActive = currentView === item.id;
            return (
              <button
                key={item.id}
                type="button"
                className={`mobile-nav-btn ${isActive ? 'active' : ''}`}
                onClick={() => setCurrentView(item.id)}
                title={item.label}
                aria-label={item.label}
                aria-current={isActive ? 'page' : undefined}
              >
                <Icon size={22} className="mobile-nav-icon" />
              </button>
            );
          })}
        </nav>
      )}
    </>
  );
}