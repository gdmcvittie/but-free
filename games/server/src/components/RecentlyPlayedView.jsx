import React, { useState, useEffect, useMemo } from 'react';
import { Play, Download, Globe, Heart, Gamepad2, History, ArrowRight } from 'lucide-react';
import { fetchJson } from '../utils/api';
import { isGameDownloadOnly } from '../utils/consoles';

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
    <div className="flex-1 flex flex-col bg-[#181818] p-3 sm:p-5 lg:p-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 mb-5 pb-3 border-b border-[#2b2b2b]">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="font-bold text-xl text-white tracking-tight flex items-center gap-2">
              <span className="text-xs uppercase tracking-wider text-slate-400 font-bold">HISTORY:</span>
              <span className="text-white font-extrabold">RECENTLY PLAYED</span>
            </h1>
            <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-sm bg-[#222222] text-[#31a8ff] border border-[#383838]">
              {recentGames.length} {recentGames.length === 1 ? 'RECORD' : 'RECORDS'}
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-1 font-mono">
            {recentGames.length > 0
              ? 'Workstation execution log: last 50 launched ROMs.'
              : 'Launch an asset and it will appear in your workstation history log.'}
          </p>
        </div>
      </div>

      {error && (
        <div className="mb-4 px-3 py-2 rounded-sm bg-[#2a1e1e] border border-red-500/40 text-red-300 text-xs font-mono">
          {error}
        </div>
      )}

      {/* Loading */}
      {loading ? (
        <div className="flex-1 flex flex-col items-center justify-center py-20 text-slate-400 gap-3">
          <div className="w-8 h-8 border-2 border-[#31a8ff] border-t-transparent rounded-full animate-spin" />
          <p className="text-xs font-mono">Querying execution logs...</p>
        </div>
      ) : recentGames.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center py-20 text-center glass-panel p-6 rounded-sm border border-[#383838] max-w-lg mx-auto">
          <div className="w-12 h-12 rounded-sm bg-[#222222] border border-[#383838] flex items-center justify-center text-[#31a8ff] mb-3">
            <History className="w-6 h-6" />
          </div>
          <h3 className="font-bold text-base text-white mb-1.5">No Execution Records</h3>
          <p className="text-slate-400 text-xs max-w-sm mb-5 leading-relaxed">
            Launch a game from your asset bin and Freeplay records your session history here.
          </p>
          <button onClick={onNavigateToLibrary} className="btn btn-primary">
            <Gamepad2 className="w-3.5 h-3.5" />
            <span>Browse Asset Library</span>
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
                  className={`game-card-fav-btn ${
                    game.isFavorite ? '!opacity-100' : 'opacity-0 group-hover:opacity-100'
                  }`}
                  title={game.isFavorite ? 'Remove Favorite' : 'Add to Favorites'}
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
                        <span>RESUME</span>
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
                  <span className="truncate font-mono text-[10px] text-slate-500">{formatAgo(game.playedAt) || 'recently'}</span>
                  <span className="text-[#31a8ff] font-semibold text-[10.5px] group-hover:underline shrink-0">
                    {isGameDownloadOnly(game) ? 'Files ↓' : game.console === 'web' ? 'Web Play →' : 'Launch →'}
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
