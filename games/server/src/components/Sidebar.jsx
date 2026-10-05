import React from 'react';
import { Gamepad2, Compass, Download, Star, Settings, HardDrive, LogIn, ExternalLink } from 'lucide-react';

export default function Sidebar({
  currentView,
  setCurrentView,
  user,
  onOpenAuthModal,
  onOpenSettings,
  activeConsole,
  setActiveConsole,
  consoleCounts = {}
}) {
  const navItems = [
    { id: 'library', label: 'Game Library', icon: Gamepad2 },
    { id: 'discover', label: 'Discover & Search', icon: Compass },
    { id: 'downloads', label: 'Downloads & Queue', icon: Download },
    { id: 'favorites', label: 'Favorites', icon: Star },
    { id: 'settings', label: 'Settings', icon: Settings },
  ];

  return (
    <aside className="w-64 bg-[#090d16]/90 backdrop-blur-xl border-r border-white/5 flex flex-col h-screen fixed left-0 top-0 z-30 select-none">
      {/* Brand Header */}
      <div className="p-6 border-b border-white/5 flex items-center justify-between">
        <div 
          onClick={() => setCurrentView('library')} 
          className="flex items-center gap-3 cursor-pointer group"
        >
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center text-white shadow-lg shadow-purple-500/25 group-hover:scale-105 transition-transform">
            <Gamepad2 className="w-6 h-6" />
          </div>
          <div>
            <div className="font-heading font-extrabold text-xl tracking-wide flex items-center">
              <span className="text-white">FREE</span>
              <span className="text-purple-400">PLAY</span>
            </div>
            <div className="text-[10px] uppercase font-bold text-cyan-400 tracking-wider">Cloud Arcade</div>
          </div>
        </div>
      </div>

      {/* Main Navigation */}
      <nav className="p-3 flex-1 overflow-y-auto space-y-1">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = currentView === item.id;
          return (
            <button
              key={item.id}
              onClick={() => setCurrentView(item.id)}
              className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl font-medium text-sm transition-all ${
                isActive
                  ? 'bg-purple-600/20 text-purple-300 border border-purple-500/30 shadow-sm'
                  : 'text-slate-400 hover:text-white hover:bg-slate-800/40'
              }`}
            >
              <Icon className={`w-4 h-4 ${isActive ? 'text-purple-400' : 'text-slate-400'}`} />
              <span>{item.label}</span>
            </button>
          );
        })}

        {/* Quick Umbrella Links */}
        <div className="pt-6 pb-2 px-3">
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">butfree.online</div>
        </div>
        <div className="space-y-0.5">
          <a
            href="https://comics.butfree.online"
            target="_blank"
            rel="noreferrer"
            className="flex items-center justify-between px-3.5 py-1.5 rounded-lg text-xs text-slate-400 hover:text-emerald-400 hover:bg-slate-800/30 transition-colors"
          >
            <span>📚 ComixoloFree</span>
            <ExternalLink className="w-3 h-3 opacity-60" />
          </a>
          <a
            href="https://music.butfree.online"
            target="_blank"
            rel="noreferrer"
            className="flex items-center justify-between px-3.5 py-1.5 rounded-lg text-xs text-slate-400 hover:text-pink-400 hover:bg-slate-800/30 transition-colors"
          >
            <span>🎵 Fraudio</span>
            <ExternalLink className="w-3 h-3 opacity-60" />
          </a>
          <a
            href="https://tv.butfree.online"
            target="_blank"
            rel="noreferrer"
            className="flex items-center justify-between px-3.5 py-1.5 rounded-lg text-xs text-slate-400 hover:text-red-400 hover:bg-slate-800/30 transition-colors"
          >
            <span>🎬 Freevee</span>
            <ExternalLink className="w-3 h-3 opacity-60" />
          </a>
        </div>
      </nav>

      {/* User & Google Drive Folder Section at Bottom */}
      <div className="p-3 border-t border-white/5">
        {user ? (
          <div
            onClick={onOpenSettings}
            className="p-2.5 rounded-xl bg-slate-900/60 hover:bg-slate-800/60 border border-white/5 hover:border-purple-500/30 transition-all cursor-pointer group"
          >
            <div className="flex items-center gap-3">
              {user.avatar ? (
                <img src={user.avatar} alt={user.name} className="w-8 h-8 rounded-full ring-2 ring-purple-500/40" />
              ) : (
                <div className="w-8 h-8 rounded-full bg-purple-600/30 flex items-center justify-center text-purple-300 font-bold text-xs">
                  {user.name ? user.name[0].toUpperCase() : 'G'}
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="text-xs font-semibold text-white truncate">{user.name || 'User'}</div>
                <div className="flex items-center gap-1.5 text-[11px] text-slate-400 truncate">
                  <HardDrive className="w-3 h-3 text-cyan-400 shrink-0" />
                  <span className="truncate">{user.gamesFolderName || 'Select Folder'}</span>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <button
            onClick={onOpenAuthModal}
            className="w-full flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-medium text-xs shadow-md shadow-purple-600/20 transition-all"
          >
            <LogIn className="w-3.5 h-3.5" />
            <span>Connect Google Drive</span>
          </button>
        )}
      </div>
    </aside>
  );
}
