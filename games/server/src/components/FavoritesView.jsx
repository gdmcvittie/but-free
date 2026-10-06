import React, { useState, useMemo } from 'react';
import { Heart, Play, Gamepad2, Search, ArrowRight } from 'lucide-react';

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
    <div className="flex-1 flex flex-col bg-[#070a12] p-3 sm:p-6 lg:p-8">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="font-heading font-extrabold text-3xl text-white tracking-tight flex items-center gap-3">
            <span>Favorite Games</span>
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
            <Heart className="w-8 h-8" />
          </div>
          <h3 className="font-heading font-bold text-xl text-white mb-2">No Favorites Yet</h3>
          <p className="text-slate-400 text-sm max-w-md mb-6 leading-relaxed">
            Click the heart icon on any game in your library to pin it here for instant one-click play.
          </p>
          <button onClick={onNavigateToLibrary} className="btn btn-primary">
            <Gamepad2 className="w-4 h-4" />
            <span>Browse Game Library</span>
          </button>
        </div>
      ) : filteredGames.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center py-24 text-center">
          <p className="text-slate-400 text-sm">No favorite games match "{searchQuery}"</p>
          <button
            onClick={() => setSearchQuery('')}
            className="btn btn-secondary btn-sm mt-3"
          >
            Clear Search
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
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                    loading="lazy"
                  />
                ) : (
                  <div className="flex flex-col items-center justify-center p-3 text-center">
                    <Gamepad2 className="w-8 h-8 text-purple-400/60 mb-1 group-hover:scale-110 transition-transform" />
                    <span className="text-[10px] font-bold text-slate-400 uppercase font-heading">
                      {game.console || 'RETRO'}
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
                  <Heart className="w-3.5 h-3.5 fill-amber-400" />
                </button>

                {/* Hover Play Overlay */}
                <div className="game-card-overlay absolute inset-0 flex items-center justify-center p-2">
                  <div className="w-10 h-10 rounded-full bg-purple-600 text-white flex items-center justify-center shadow-lg shadow-purple-600/50 transform translate-y-1 group-hover:translate-y-0 transition-transform">
                    <Play className="w-4 h-4 ml-0.5 fill-white" />
                  </div>
                </div>
              </div>

              {/* Game Metadata Footer */}
              <div className="game-card-meta">
                <div className="game-card-title" title={game.title}>
                  {game.title}
                </div>
                <div className="game-card-sub">
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
