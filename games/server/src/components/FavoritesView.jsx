import React, { useState, useMemo } from 'react';
import { Star, Play, Gamepad2, Search, ArrowRight } from 'lucide-react';

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
    <div className="flex-1 flex flex-col min-h-screen bg-[#070a12] p-8 overflow-y-auto">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="font-heading font-extrabold text-3xl text-white tracking-tight flex items-center gap-3">
            <span>Starred Favorites</span>
            <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30">
              {favoriteGames.length} {favoriteGames.length === 1 ? 'Game' : 'Games'}
            </span>
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Quickly jump back into your most-played retro classics and favorite ROMs.
          </p>
        </div>

        {favoriteGames.length > 0 && (
          <div className="relative min-w-[260px]">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              placeholder="Search your favorites..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 bg-slate-900/80 border border-white/10 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-purple-500 transition-colors"
            />
          </div>
        )}
      </div>

      {/* Grid or Empty State */}
      {favoriteGames.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center py-24 text-center glass-panel p-8 rounded-2xl border border-white/5 max-w-xl mx-auto">
          <div className="w-16 h-16 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400 mb-4">
            <Star className="w-8 h-8" />
          </div>
          <h3 className="font-heading font-bold text-xl text-white mb-2">No Favorites Yet</h3>
          <p className="text-slate-400 text-sm max-w-md mb-6 leading-relaxed">
            Click the star icon on any game in your library to pin it here for instant one-click play.
          </p>
          <button onClick={onNavigateToLibrary} className="btn-primary">
            <Gamepad2 className="w-4 h-4" />
            <span>Browse Game Library</span>
          </button>
        </div>
      ) : filteredGames.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center py-24 text-center">
          <p className="text-slate-400 text-sm">No starred games match "{searchQuery}"</p>
          <button
            onClick={() => setSearchQuery('')}
            className="btn-secondary mt-3 text-xs"
          >
            Clear Search
          </button>
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

                {/* Star Button in Top-Left */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleFavorite(game.id);
                  }}
                  className="absolute top-2.5 left-2.5 z-10 p-1.5 rounded-lg bg-amber-500/20 text-amber-400 border border-amber-500/40 backdrop-blur-md transition hover:scale-110"
                  title="Remove from favorites"
                >
                  <Star className="w-3.5 h-3.5 fill-amber-400" />
                </button>

                {/* Hover Play Overlay */}
                <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center backdrop-blur-xs">
                  <div className="w-12 h-12 rounded-full bg-purple-600 text-white flex items-center justify-center shadow-lg shadow-purple-600/50 group-hover:scale-110 transition-transform">
                    <Play className="w-5 h-5 ml-0.5 fill-white" />
                  </div>
                </div>
              </div>

              {/* Game Metadata Footer */}
              <div className="p-3 bg-slate-900/60 flex-1 flex flex-col justify-between border-t border-white/5">
                <h4 className="font-heading font-semibold text-xs text-white truncate group-hover:text-purple-300 transition-colors">
                  {game.title}
                </h4>
                <div className="flex items-center justify-between text-[11px] text-slate-500 mt-1">
                  <span className="uppercase font-semibold tracking-wider">{game.console}</span>
                  <span>{game.sizeFormatted || ''}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
