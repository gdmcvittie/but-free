import React, { useState, useMemo } from 'react';
import { Play, Star, Search, RefreshCw, HardDrive, Globe, Download, Gamepad2 } from 'lucide-react';

export default function LibraryView({
  games = [],
  loading = false,
  onPlayGame,
  onToggleFavorite,
  onScanDrive,
  isScanning = false,
  user,
  onOpenSettings
}) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedConsole, setSelectedConsole] = useState('all');

  // Compute console breakdown
  const consoles = useMemo(() => {
    const counts = {};
    games.forEach((g) => {
      const c = g.console || 'other';
      counts[c] = (counts[c] || 0) + 1;
    });
    return counts;
  }, [games]);

  // Filter games based on console and search
  const filteredGames = useMemo(() => {
    return games.filter((g) => {
      const matchesConsole = selectedConsole === 'all' || (g.console || '').toLowerCase() === selectedConsole.toLowerCase();
      const matchesSearch = !searchQuery || 
        (g.title || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        (g.filename || '').toLowerCase().includes(searchQuery.toLowerCase());
      return matchesConsole && matchesSearch;
    });
  }, [games, selectedConsole, searchQuery]);

  return (
    <div className="flex-1 flex flex-col min-h-screen bg-[#070a12] p-8 overflow-y-auto">
      {/* Top Header Row */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="font-heading font-extrabold text-3xl text-white tracking-tight flex items-center gap-3">
            <span>Games Library</span>
            <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-purple-500/20 text-purple-300 border border-purple-500/30">
              {games.length} {games.length === 1 ? 'Game' : 'Games'}
            </span>
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            {user?.gamesFolderName ? (
              <span className="flex items-center gap-1.5">
                <HardDrive className="w-3.5 h-3.5 text-cyan-400" />
                <span>Connected to Google Drive: <strong>{user.gamesFolderName}</strong></span>
              </span>
            ) : (
              'Connect your Google Drive Games folder in Settings to play your collection'
            )}
          </p>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-3">
          <div className="relative min-w-[260px]">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              placeholder="Search your games..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 bg-slate-900/80 border border-white/10 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-purple-500 transition-colors"
            />
          </div>

          <button
            onClick={onScanDrive}
            disabled={isScanning}
            className="btn-secondary !py-2 !px-3.5 text-xs"
            title="Scan Google Drive for new games"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isScanning ? 'animate-spin text-purple-400' : ''}`} />
            <span>{isScanning ? 'Scanning...' : 'Scan Drive'}</span>
          </button>
        </div>
      </div>

      {/* Consoles / System Filter Bar */}
      <div className="flex items-center gap-2 overflow-x-auto pb-4 mb-6 scrollbar-none">
        <button
          onClick={() => setSelectedConsole('all')}
          className={`px-4 py-2 rounded-xl text-xs font-heading font-bold uppercase tracking-wider transition-all whitespace-nowrap ${
            selectedConsole === 'all'
              ? 'bg-purple-600 text-white shadow-lg shadow-purple-600/30 border border-purple-400/30'
              : 'bg-slate-900/60 hover:bg-slate-800 text-slate-400 hover:text-white border border-white/5'
          }`}
        >
          All Consoles ({games.length})
        </button>

        {Object.entries(consoles).map(([consoleKey, count]) => {
          const isSelected = selectedConsole === consoleKey;
          return (
            <button
              key={consoleKey}
              onClick={() => setSelectedConsole(consoleKey)}
              className={`px-3.5 py-2 rounded-xl text-xs font-heading font-bold uppercase tracking-wider transition-all whitespace-nowrap flex items-center gap-2 ${
                isSelected
                  ? 'bg-purple-600 text-white shadow-lg shadow-purple-600/30 border border-purple-400/30'
                  : 'bg-slate-900/60 hover:bg-slate-800 text-slate-400 hover:text-white border border-white/5'
              }`}
            >
              <span>{consoleKey}</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${isSelected ? 'bg-purple-800 text-purple-200' : 'bg-slate-800 text-slate-400'}`}>
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Game Cards Grid */}
      {loading ? (
        <div className="flex-1 flex flex-col items-center justify-center py-20 text-slate-400 gap-3">
          <div className="w-10 h-10 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm font-medium">Loading your cloud games...</p>
        </div>
      ) : filteredGames.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center py-24 text-center glass-panel p-8 rounded-2xl border border-white/5 max-w-xl mx-auto">
          <div className="w-16 h-16 rounded-2xl bg-purple-600/10 border border-purple-500/20 flex items-center justify-center text-purple-400 mb-4">
            <Gamepad2 className="w-8 h-8" />
          </div>
          <h3 className="font-heading font-bold text-xl text-white mb-2">
            {games.length === 0 ? 'No Games in Library' : 'No Games Match Filter'}
          </h3>
          <p className="text-slate-400 text-sm max-w-md mb-6 leading-relaxed">
            {games.length === 0 ? (
              user?.gamesFolderName ? (
                `We didn't find any supported ROM files in your Google Drive folder "${user.gamesFolderName}". Put your .nes, .smc, .sfc, .gba, .iso or .zip files into Google Drive and click Scan.`
              ) : (
                'Connect your Google Drive and select a "Games" folder in Settings to start playing your cloud ROM collection.'
              )
            ) : (
              'Try changing your console filter or clearing your search term.'
            )}
          </p>
          {games.length === 0 ? (
            <button
              onClick={user?.gamesFolderName ? onScanDrive : onOpenSettings}
              className="btn-primary"
            >
              {user?.gamesFolderName ? <RefreshCw className="w-4 h-4" /> : <HardDrive className="w-4 h-4" />}
              <span>{user?.gamesFolderName ? 'Scan Drive Folder' : 'Configure Games Folder'}</span>
            </button>
          ) : (
            <button
              onClick={() => { setSelectedConsole('all'); setSearchQuery(''); }}
              className="btn-secondary"
            >
              Reset Filters
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-5">
          {filteredGames.map((game) => (
            <div
              key={game.id}
              className="game-card group flex flex-col cursor-pointer"
              onClick={() => onPlayGame(game)}
            >
              {/* Box Art Container */}
              <div className="relative aspect-[3/4] bg-slate-900 overflow-hidden flex items-center justify-center">
                {game.coverUrl ? (
                  <img
                    src={game.coverUrl}
                    alt={game.title}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                    loading="lazy"
                  />
                ) : (
                  <div className="flex flex-col items-center justify-center p-4 text-center">
                    <Gamepad2 className="w-10 h-10 text-purple-400/60 mb-2 group-hover:scale-110 transition-transform" />
                    <span className="text-[11px] font-bold text-slate-400 uppercase font-heading">
                      {game.console || 'RETRO'}
                    </span>
                  </div>
                )}

                {/* Console Badge in Top-Right */}
                <div className="absolute top-2.5 right-2.5 z-10">
                  <span className={`badge-console badge-${(game.console || '').toLowerCase()}`}>
                    {game.console || 'GAME'}
                  </span>
                </div>

                {/* Favorite Star in Top-Left */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleFavorite(game.id);
                  }}
                  className={`absolute top-2.5 left-2.5 z-10 p-1.5 rounded-lg backdrop-blur-md transition ${
                    game.isFavorite
                      ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40'
                      : 'bg-black/40 text-slate-400 hover:text-white border border-white/10 opacity-0 group-hover:opacity-100'
                  }`}
                  title={game.isFavorite ? 'Remove Favorite' : 'Add to Favorites'}
                >
                  <Star className={`w-3.5 h-3.5 ${game.isFavorite ? 'fill-amber-400' : ''}`} />
                </button>

                {/* Hover Action Overlay */}
                <div className="game-card-overlay absolute inset-0 flex items-center justify-center p-4">
                  <div className="w-12 h-12 rounded-full bg-purple-600 text-white flex items-center justify-center shadow-lg shadow-purple-600/50 transform translate-y-2 group-hover:translate-y-0 transition-transform">
                    {game.console === 'pc' || game.isPcGame ? (
                      <Download className="w-5 h-5" />
                    ) : game.console === 'web' ? (
                      <Globe className="w-5 h-5" />
                    ) : (
                      <Play className="w-5 h-5 ml-0.5 fill-white" />
                    )}
                  </div>
                </div>
              </div>

              {/* Game Metadata Footer */}
              <div className="p-3 bg-slate-900/90 flex-1 flex flex-col justify-between border-t border-white/5">
                <div>
                  <h3 className="text-xs font-bold text-slate-200 group-hover:text-purple-300 transition-colors line-clamp-2 leading-tight">
                    {game.title}
                  </h3>
                </div>
                <div className="flex items-center justify-between mt-2 pt-2 border-t border-white/5 text-[10px] text-slate-500">
                  <span>{game.sizeFormatted || (game.size ? `${(game.size / 1024 / 1024).toFixed(1)} MB` : 'ROM')}</span>
                  <span className="text-purple-400 font-semibold group-hover:underline">
                    {game.console === 'pc' || game.isPcGame ? 'Files ↓' : game.console === 'web' ? 'Web Play →' : 'Play Now →'}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
