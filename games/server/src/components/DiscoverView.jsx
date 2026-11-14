import React, { useState, useEffect } from 'react';
import { Sparkles, Layers, Flame, Gamepad2, ShoppingBag, HardDrive } from 'lucide-react';
import FitgirlTab from './discover/FitgirlTab';
import PopularTab from './discover/PopularTab';
import ItchTab from './discover/ItchTab';
import GogTab from './discover/GogTab';

// =============================================================================
// Discover & Download hub (ported from my-games-server):
// FitGirl repack RSS, popular Steam releases w/ repack matching,
// itch.io store + purchases, and GOG.com offline installers.
// Everything queues on the central Downloader node and lands in Google Drive.
// =============================================================================

const TABS = [
  { key: 'fitgirl', label: 'Latest Repacks', icon: Layers },
  { key: 'popular', label: 'Popular', icon: Flame },
  { key: 'itch', label: 'itch.io', icon: Gamepad2 },
  { key: 'gog', label: 'GOG.com', icon: ShoppingBag }
];

function checkIsMobile() {
  if (typeof window === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const isMobileUA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|mobile|Silk/i.test(ua);
  const isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  const isNarrowScreen = window.innerWidth <= 768;
  const isHandheldLandscape = isTouchDevice && (window.innerWidth <= 1024 || window.innerHeight <= 600);
  return isMobileUA || isNarrowScreen || isHandheldLandscape;
}

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(checkIsMobile);
  useEffect(() => {
    const onResize = () => setIsMobile(checkIsMobile());
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);
  return isMobile;
}

export default function DiscoverView({ user, onOpenSettings, onDownloadDispatched, onLibraryUpdated }) {
  const [activeTab, setActiveTab] = useState('fitgirl');
  const isMobile = useIsMobile();
  const visibleTabs = isMobile ? TABS.filter((t) => t.key === 'itch') : TABS;
  const effectiveTab = isMobile ? 'itch' : activeTab;

  if (!user?.gamesFolderId) {
    return (
      <div className="flex-1 flex flex-col min-h-screen bg-[#181818] p-8 items-center justify-center">
        <div className="glass-panel p-8 max-w-md text-center space-y-4 rounded-sm border border-[#383838] bg-[#222222]">
          <div className="w-12 h-12 rounded-sm bg-[#14283d] border border-[#31a8ff] flex items-center justify-center text-[#31a8ff] mx-auto">
            <HardDrive className="w-6 h-6" />
          </div>
          <h2 className="font-bold text-base text-white">Select your Games folder first</h2>
          <p className="text-xs text-slate-400 leading-relaxed font-mono">
            Repacks, itch.io and GOG downloads are fetched by the cloud Downloader node and saved straight into
            your Google Drive Games folder. Pick that folder to get started.
          </p>
          <button onClick={onOpenSettings} className="btn btn-primary">
            <span>Open Settings</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-[#181818] p-3 sm:p-5 lg:p-6">
      {/* Sticky Section Nav Header */}
      <div className="sticky top-0 z-20 bg-[#181818] pt-2 pb-3 border-b border-[#2b2b2b] mb-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-3">
          <div>
            <div className="flex items-center gap-2 text-xs uppercase font-bold text-[#31a8ff] font-mono tracking-wider">
              <Sparkles className="w-3.5 h-3.5" />
              <span>{isMobile ? 'Indie & Homebrew Games' : 'PC & Homebrew Download Hub'}</span>
            </div>
            <h1 className="font-bold text-xl sm:text-2xl text-white tracking-tight mt-0.5">
              Discover &amp; Download to Drive
            </h1>
          </div>
        </div>

        {/* Section Tabs (only show switcher if multiple tabs available) */}
        {visibleTabs.length > 1 && (
          <div className="discover-tabs">
            {visibleTabs.map((t) => {
              const Icon = t.icon;
              return (
                <button
                  key={t.key}
                  onClick={() => setActiveTab(t.key)}
                  className={`discover-tab-btn ${effectiveTab === t.key ? 'active' : ''}`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span>{t.label}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {effectiveTab === 'fitgirl' && <FitgirlTab onDownloadDispatched={onDownloadDispatched} />}
      {effectiveTab === 'popular' && <PopularTab onDownloadDispatched={onDownloadDispatched} />}
      {effectiveTab === 'itch' && <ItchTab user={user} onDownloadDispatched={onDownloadDispatched} onLibraryUpdated={onLibraryUpdated} />}
      {effectiveTab === 'gog' && <GogTab onDownloadDispatched={onDownloadDispatched} onLibraryUpdated={onLibraryUpdated} />}
    </div>
  );
}
