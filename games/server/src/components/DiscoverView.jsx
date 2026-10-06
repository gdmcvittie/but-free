import React, { useState } from 'react';
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

export default function DiscoverView({ user, onOpenSettings, onDownloadDispatched, onLibraryUpdated }) {
  const [activeTab, setActiveTab] = useState('fitgirl');

  if (!user?.gamesFolderId) {
    return (
      <div className="flex-1 flex flex-col min-h-screen bg-[#070a12] p-8 items-center justify-center">
        <div className="glass-panel p-10 max-w-md text-center space-y-4">
          <div className="w-14 h-14 rounded-2xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-cyan-400 mx-auto">
            <HardDrive className="w-7 h-7" />
          </div>
          <h2 className="font-heading font-bold text-xl text-white">Select your Games folder first</h2>
          <p className="text-xs text-slate-400 leading-relaxed">
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
    <div className="flex-1 flex flex-col bg-[#070a12] p-3 sm:p-6 lg:p-8">
      {/* Sticky Section Nav Header */}
      <div className="sticky top-0 z-20 bg-[#070a12]/95 backdrop-blur-md pt-2 pb-3 border-b border-white/5 mb-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-3">
          <div>
            <div className="flex items-center gap-2 text-xs uppercase font-bold text-pink-400 font-heading tracking-wider">
              <Sparkles className="w-3.5 h-3.5" />
              <span>PC &amp; Homebrew Download Hub</span>
            </div>
            <h1 className="font-heading font-extrabold text-2xl sm:text-3xl text-white tracking-tight mt-0.5">
              Discover &amp; Download to Drive
            </h1>
          </div>
        </div>

        {/* Section Tabs */}
        <div className="discover-tabs">
          {TABS.map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.key}
                onClick={() => setActiveTab(t.key)}
                className={`discover-tab-btn ${activeTab === t.key ? 'active' : ''}`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{t.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {activeTab === 'fitgirl' && <FitgirlTab onDownloadDispatched={onDownloadDispatched} />}
      {activeTab === 'popular' && <PopularTab onDownloadDispatched={onDownloadDispatched} />}
      {activeTab === 'itch' && <ItchTab user={user} onDownloadDispatched={onDownloadDispatched} onLibraryUpdated={onLibraryUpdated} />}
      {activeTab === 'gog' && <GogTab onDownloadDispatched={onDownloadDispatched} onLibraryUpdated={onLibraryUpdated} />}
    </div>
  );
}
