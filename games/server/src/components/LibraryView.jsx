import React, { useState, useMemo } from 'react';
import { Play, Heart, Search, RefreshCw, HardDrive, Globe, Download, Gamepad2 } from 'lucide-react';
import { isGameDownloadOnly } from '../utils/consoles';

export default function LibraryView({
  games = [],
  loading = false,
  selectedConsole = 'all',
  onSelectConsole,
  onPlayGame,
  onToggleFavorite,
  onScanDrive,
  isScanning = false,
  user,
  onOpenSettings,
  isMobileLandscape1080 = false
}) {
  const [searchQuery, setSearchQuery] = useState('');
  const selectConsole = onSelectConsole || (() => {});

  // Compute console breakdown
  const consoles = useMemo(() => {
    const counts = {};
    games.forEach((g) => {
      const key = (g.console || 'other').toLowerCase();
      counts[key] = (counts[key] || 0) + 1;
    });
    return Object.entries(counts)
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }, [games]);

  // Filter games based on console and search
  const filteredGames = useMemo(() => {
    return games.filter((g) => {
      const matchesConsole = !selectedConsole || (g.console || '').toLowerCase() === String(selectedConsole).toLowerCase();
      const matchesSearch = !searchQuery || 
        (g.title || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
        (g.filename || '').toLowerCase().includes(searchQuery.toLowerCase());
      return matchesConsole && matchesSearch;
    });
  }, [games, selectedConsole, searchQuery]);

  return (
    <div className={`flex-1 flex flex-col bg-[#181818] ${isMobileLandscape1080 ? 'p-2 sm:p-3' : 'p-3 sm:p-5 lg:p-6'}`}>
      {/* Top Header Row (Photoshop Application / Shelf Bar) */}
      <div className={`flex flex-col md:flex-row md:items-center justify-between gap-3 ${isMobileLandscape1080 ? 'mb-2.5' : 'mb-5 pb-3 border-b border-[#2b2b2b]'}`}>
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className={`font-bold ${isMobileLandscape1080 ? 'text-base sm:text-lg' : 'text-xl'} text-white tracking-tight flex items-center gap-2`}>
              <span className="text-xs uppercase tracking-wider text-slate-400 font-bold">ASSET BIN:</span>
              <span className="text-white font-extrabold">{selectedConsole ? selectedConsole.toUpperCase() : 'ALL FORMATS'}</span>
            </h1>
            <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-sm bg-[#222222] text-[#31a8ff] border border-[#383838]">
              {filteredGames.length} {filteredGames.length === 1 ? 'ITEM' : 'ITEMS'}
            </span>
          </div>
          {!isMobileLandscape1080 && (
            <p className="text-xs text-slate-400 mt-1 flex items-center gap-2">
              {user?.gamesFolderName ? (
                <span className="flex items-center gap-1.5 font-mono text-[11px]">
                  <HardDrive className="w-3.5 h-3.5 text-[#31a8ff]" />
                  <span>MOUNT: <strong>/{user.gamesFolderName}</strong></span>
                </span>
              ) : (
                <span>No Google Drive folder linked. Connect your collection in Settings.</span>
              )}
            </p>
          )}
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2">
          <div className={`relative ${isMobileLandscape1080 ? 'min-w-[170px] max-w-[260px]' : 'min-w-[240px]'}`}>
            <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              placeholder="Filter assets (Ctrl+K)..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="workstation-search-input w-full pl-8 pr-10 py-1.5 rounded-sm text-xs text-white placeholder-zinc-500 focus:outline-none transition-colors"
            />
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[9px] font-mono text-zinc-500 border border-[#2a2a2a] px-1 rounded bg-[#141414] pointer-events-none">
              ⌘K
            </span>
          </div>

          <button
            onClick={onScanDrive}
            disabled={isScanning}
            className="btn btn-secondary btn-sm"
            title="Scan Google Drive for new games"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isScanning ? 'animate-spin text-[#31a8ff]' : ''}`} />
            <span>{isScanning ? 'Syncing...' : 'Sync Drive'}</span>
          </button>
        </div>
      </div>

      {/* Consoles / System Filter Bar (Hidden in 1080p landscape since consoles are along the sidebar) */}
      {!isMobileLandscape1080 && (
        <div className="flex items-center gap-1.5 overflow-x-auto pb-3 mb-4 scrollbar-none">
          {consoles.map(({ key, count }) => {
            const isSelected = selectedConsole === key;
            return (
              <button
                key={key}
                onClick={() => selectConsole(key)}
                className={`filter-chip ${isSelected ? 'active' : ''}`}
              >
                <span className="console-key font-mono text-[11px]">{key}</span>
                <span className="filter-chip-count">
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Game Cards Grid */}
      {loading ? (
        <div className="flex-1 flex flex-col items-center justify-center py-20 text-slate-400 gap-3">
          <div className="w-8 h-8 border-2 border-[#31a8ff] border-t-transparent rounded-full animate-spin" />
          <p className="text-xs font-mono">Indexing cloud assets...</p>
        </div>
      ) : filteredGames.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center py-20 text-center glass-panel p-6 rounded-sm border border-[#383838] max-w-lg mx-auto">
          <div className="w-12 h-12 rounded-sm bg-[#222222] border border-[#383838] flex items-center justify-center text-[#31a8ff] mb-3">
            <Gamepad2 className="w-6 h-6" />
          </div>
          <h3 className="font-bold text-base text-white mb-1.5">
            {games.length === 0 ? 'No Assets in Mounted Folder' : 'No Assets Match Query'}
          </h3>
          <p className="text-slate-400 text-xs max-w-sm mb-5 leading-relaxed">
            {games.length === 0 ? (
              user?.gamesFolderName ? (
                `No supported ROM or game files found in Google Drive folder "${user.gamesFolderName}". Add your ROM files (.nes, .smc, .sfc, .gba, .z64, .iso, .zip) and sync.`
              ) : (
                'Mount your Google Drive games folder in Settings to populate your workstation library.'
              )
            ) : (
              'Adjust your console filter tab or clear your search term.'
            )}
          </p>
          {games.length === 0 ? (
            <button
              onClick={user?.gamesFolderName ? onScanDrive : onOpenSettings}
              className="btn btn-primary"
            >
              {user?.gamesFolderName ? <RefreshCw className="w-3.5 h-3.5" /> : <HardDrive className="w-3.5 h-3.5" />}
              <span>{user?.gamesFolderName ? 'Sync Drive Folder' : 'Configure Mount'}</span>
            </button>
          ) : (
            <button
              onClick={() => { selectConsole(consoles[0]?.key || ''); setSearchQuery(''); }}
              className="btn btn-secondary"
            >
              Reset Filters
            </button>
          )}
        </div>
      ) : (
        <div className="games-grid">
          {filteredGames.map((game) => (
            <div
              key={game.id}
              className="game-card group"
              onClick={() => onPlayGame(game)}
            >
              {/* Poster Container */}
              <div className="game-card-poster">
                {game.coverUrl ? (
                  <img
                    src={game.coverUrl}
                    alt={game.title}
                    className="w-full h-full object-cover transition-opacity duration-200"
                    loading="lazy"
                  />
                ) : (
                  <div className="flex flex-col items-center justify-center p-3 text-center">
                    <Gamepad2 className="w-7 h-7 text-slate-600 mb-1" />
                    <span className="text-[9.5px] font-bold text-slate-500 uppercase font-mono">
                      {game.console || 'ROM'}
                    </span>
                  </div>
                )}

                {/* Console Badge in Top-Right */}
                <span className={`badge-console badge-${(game.console || '').toLowerCase()} badge-top-right`}>
                  {game.console || 'GAME'}
                </span>

                {/* Favorite Toggle in Top-Left */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleFavorite(game.id);
                  }}
                  className="game-card-fav-btn"
                  title={game.isFavorite ? 'Remove Favorite' : 'Add to Favorites'}
                  aria-label={game.isFavorite ? `Remove ${game.title} from favorites` : `Add ${game.title} to favorites`}
                >
                  <Heart className={`w-3 h-3 ${game.isFavorite ? 'fill-amber-400 text-amber-400' : 'fill-transparent text-slate-400'}`} />
                </button>

                {/* Hover Play Overlay */}
                <div className="game-card-overlay absolute inset-0 flex items-center justify-center p-2">
                  <div className="px-3 py-1 rounded-sm bg-[#31a8ff] hover:bg-[#52c5ff] text-black flex items-center gap-1.5 font-bold text-xs shadow-md">
                    {isGameDownloadOnly(game) ? (
                      <>
                        <Download className="w-3.5 h-3.5" />
                        <span>DOWNLOAD</span>
                      </>
                    ) : game.console === 'web' ? (
                      <>
                        <Globe className="w-3.5 h-3.5" />
                        <span>OPEN</span>
                      </>
                    ) : (
                      <>
                        <Play className="w-3.5 h-3.5 fill-black" />
                        <span>LAUNCH</span>
                      </>
                    )}
                  </div>
                </div>
              </div>

              {/* Game Metadata Footer */}
              <div className="game-card-meta">
                <div className="game-card-title" title={game.title}>
                  {game.title}
                </div>
                <div className="game-card-sub">
                  <span className="truncate font-mono text-[10px] text-slate-500">{game.sizeFormatted || (game.size ? `${(game.size / 1024 / 1024).toFixed(1)} MB` : 'ROM')}</span>
                  <span className="text-[#31a8ff] font-semibold text-[10.5px] group-hover:underline shrink-0">
                    {isGameDownloadOnly(game) ? 'Files ↓' : game.console === 'web' ? 'Web Play →' : 'Play →'}
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
