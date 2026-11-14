import React, { useState, useMemo } from 'react';
import { Heart, Play, Download, Globe, Gamepad2, Search, ArrowRight } from 'lucide-react';
import { isGameDownloadOnly } from '../utils/consoles';

export default function FavoritesView({
  games = [],
  onPlayGame,
  onToggleFavorite,
  onNavigateToLibrary
}) {
  const [searchQuery, setSearchQuery] = useState('');

  const favoriteGames = useMemo(() => {
    return games.filter((g) => g.isFavorite);
  }, [games]);

  const filteredGames = useMemo(() => {
    if (!searchQuery.trim()) return favoriteGames;
    const q = searchQuery.toLowerCase();
    return favoriteGames.filter(
      (g) =>
        (g.title || '').toLowerCase().includes(q) ||
        (g.console || '').toLowerCase().includes(q) ||
        (g.filename || '').toLowerCase().includes(q)
    );
  }, [favoriteGames, searchQuery]);

  return (
    <div className="flex-1 flex flex-col bg-[#181818] p-3 sm:p-5 lg:p-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 mb-5 pb-3 border-b border-[#2b2b2b]">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="font-bold text-xl text-white tracking-tight flex items-center gap-2">
              <span className="text-xs uppercase tracking-wider text-slate-400 font-bold">COLLECTION:</span>
              <span className="text-white font-extrabold">FAVORITES</span>
            </h1>
            <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-sm bg-[#222222] text-amber-400 border border-[#383838]">
              {favoriteGames.length} {favoriteGames.length === 1 ? 'PINNED' : 'PINNED'}
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-1 font-mono">
            Pinned ROM assets and high-priority bookmarks.
          </p>
        </div>

        {favoriteGames.length > 0 && (
          <div className="relative min-w-[240px]">
            <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              placeholder="Filter favorites (Ctrl+K)..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 bg-[#1f1f1f] border border-[#383838] rounded-sm text-xs text-white placeholder-slate-500 focus:outline-none focus:border-[#31a8ff] transition-colors"
            />
          </div>
        )}
      </div>

      {/* Grid or Empty State */}
      {favoriteGames.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center py-20 text-center glass-panel p-6 rounded-sm border border-[#383838] max-w-lg mx-auto">
          <div className="w-12 h-12 rounded-sm bg-[#222222] border border-[#383838] flex items-center justify-center text-amber-400 mb-3">
            <Heart className="w-6 h-6" />
          </div>
          <h3 className="font-bold text-base text-white mb-1.5">No Pinned Favorites</h3>
          <p className="text-slate-400 text-xs max-w-sm mb-5 leading-relaxed">
            Click the bookmark icon on any asset card in your library to pin it to this workspace view.
          </p>
          <button onClick={onNavigateToLibrary} className="btn btn-primary">
            <Gamepad2 className="w-3.5 h-3.5" />
            <span>Browse Asset Library</span>
          </button>
        </div>
      ) : filteredGames.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center py-20 text-center">
          <p className="text-slate-400 text-xs font-mono">No favorites match "{searchQuery}"</p>
          <button
            onClick={() => setSearchQuery('')}
            className="btn btn-secondary btn-sm mt-3"
          >
            Clear Filter
          </button>
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

                {/* Heart Button in Top-Left */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleFavorite(game.id);
                  }}
                  className="game-card-fav-btn"
                  title="Remove from favorites"
                >
                  <Heart className="w-3 h-3 fill-amber-400 text-amber-400" />
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
                  <span className="uppercase font-mono text-[10px] text-slate-500">{game.console}</span>
                  <span className="font-mono text-[10px] text-slate-500">{game.sizeFormatted || ''}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
