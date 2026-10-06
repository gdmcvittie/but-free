import React, { useState, useEffect, useMemo } from 'react';
import { Play, Heart, Gamepad2, History, ArrowRight } from 'lucide-react';
import { fetchJson } from '../utils/api';

function formatAgo(timestamp) {
  if (!timestamp) return '';
  const minutes = Math.floor((Date.now() - timestamp) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

/**
 * Play history: the last 50 games, most recently played first (GET
 * /api/games/recent). Games that left the library since the last play are
 * dropped server-side.
 */
export default function RecentlyPlayedView({
  games = [],
  onPlayGame,
  onToggleFavorite,
  onNavigateToLibrary
}) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchJson('/api/games/recent')
      .then((data) => {
        if (!cancelled) setRows(data.games || []);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Could not load your play history.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, []);

  // The endpoint owns the order and playedAt stamps; the local library state
  // owns the freshest cover/favorite data.
  const recentGames = useMemo(() => {
    const byId = new Map(games.map((g) => [g.id, g]));
    return rows.map((row) => (byId.has(row.id) ? { ...row, ...byId.get(row.id) } : row));
  }, [rows, games]);

  return (
    <div className="flex-1 flex flex-col bg-[#070a12] p-3 sm:p-6 lg:p-8">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="font-heading font-extrabold text-3xl text-white tracking-tight flex items-center gap-3">
            <span>Recently played</span>
            <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-purple-500/20 text-purple-300 border border-purple-500/30">
              {recentGames.length} {recentGames.length === 1 ? 'Game' : 'Games'}
            </span>
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            {recentGames.length > 0
              ? 'Your last 50 games, most recently played first.'
              : 'Play something and it will show up here.'}
          </p>
        </div>
      </div>

      {error && (
        <div className="mb-6 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 text-sm">
          {error}
        </div>
      )}

      {/* Loading */}
      {loading ? (
        <div className="flex-1 flex flex-col items-center justify-center py-20 text-slate-400 gap-3">
          <div className="w-10 h-10 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm font-medium">Loading your play history...</p>
        </div>
      ) : recentGames.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center py-24 text-center glass-panel p-8 rounded-2xl border border-white/5 max-w-xl mx-auto">
          <div className="w-16 h-16 rounded-2xl bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-purple-400 mb-4">
            <History className="w-8 h-8" />
          </div>
          <h3 className="font-heading font-bold text-xl text-white mb-2">No Games Played Yet</h3>
          <p className="text-slate-400 text-sm max-w-md mb-6 leading-relaxed">
            Launch a game from your library and FREEPLAY keeps your last 50 played games here.
          </p>
          <button onClick={onNavigateToLibrary} className="btn btn-primary">
            <Gamepad2 className="w-4 h-4" />
            <span>Browse Game Library</span>
          </button>
        </div>
      ) : (
        <div className="games-grid">
          {recentGames.map((game) => (
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

                {/* Favorite Toggle in Top-Left */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleFavorite(game.id);
                  }}
                  className={`game-card-fav-btn ${
                    game.isFavorite ? '!opacity-100' : 'opacity-0 group-hover:opacity-100'
                  }`}
                  title={game.isFavorite ? 'Remove Favorite' : 'Add to Favorites'}
                >
                  <Heart className={`w-3.5 h-3.5 ${game.isFavorite ? 'fill-amber-400' : 'text-slate-300'}`} />
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
                  <span className="truncate">played {formatAgo(game.playedAt) || 'recently'}</span>
                  <span className="text-purple-400 font-semibold group-hover:underline shrink-0">
                    Play Again →
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Back to library */}
      {!loading && recentGames.length > 0 && (
        <button onClick={onNavigateToLibrary} className="btn btn-secondary self-start mt-6">
          <ArrowRight className="w-4 h-4 rotate-180" />
          <span>Back to Library</span>
        </button>
      )}
    </div>
  );
}
