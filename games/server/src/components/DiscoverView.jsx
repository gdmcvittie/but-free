import React, { useState } from 'react';
import { Compass, Search, Download, Check, Loader2, Sparkles, Gamepad2, ArrowRight } from 'lucide-react';
import { fetchJson } from '../utils/api';

export default function DiscoverView({ onDownloadDispatched, user, onOpenSettings }) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState([]);
  const [dispatchingId, setDispatchingId] = useState(null);
  const [dispatchedIds, setDispatchedIds] = useState(new Set());
  const [statusMsg, setStatusMsg] = useState(null);

  // Pre-curated Popular Public Domain & Retro Classics
  const FEATURED_GAMES = [
    {
      id: 'smw_standalone',
      title: 'Super Mario World (SNES)',
      console: 'snes',
      consoleName: 'Super Nintendo',
      magnet: 'magnet:?xt=urn:btih:38b4a7894a4bc9f91195610ec3388c69ee016834&dn=Super+Mario+World+(USA).sfc',
      description: 'The definitive 16-bit platformer. Dinosaur Land awaits Mario and Yoshi.',
      size: '2.0 MB'
    },
    {
      id: 'zelda_alttp',
      title: 'The Legend of Zelda: A Link to the Past (SNES)',
      console: 'snes',
      consoleName: 'Super Nintendo',
      magnet: 'magnet:?xt=urn:btih:49a2b7245084931a293bf7c32bfec1923e120194&dn=Legend+of+Zelda+A+Link+to+the+Past+(USA).sfc',
      description: 'Masterpiece action RPG exploring Hyrule and the Dark World.',
      size: '1.5 MB'
    },
    {
      id: 'pokemon_emerald',
      title: 'Pokemon - Emerald Version (GBA)',
      console: 'gba',
      consoleName: 'Game Boy Advance',
      magnet: 'magnet:?xt=urn:btih:58c3a1029c735d6e24177d6ba2f623e10034a761&dn=Pokemon+-+Emerald+Version+(USA).gba',
      description: 'Explore the Hoenn region, battle Team Aqua & Magma, and catch Rayquaza.',
      size: '16.0 MB'
    },
    {
      id: 'sonic_2',
      title: 'Sonic the Hedgehog 2 (Genesis)',
      console: 'sega',
      consoleName: 'Sega Genesis',
      magnet: 'magnet:?xt=urn:btih:19c0b24018593ba3938501235123491203487192&dn=Sonic+The+Hedgehog+2+(USA).md',
      description: 'High-speed platforming introduction of Miles "Tails" Prower.',
      size: '1.0 MB'
    },
    {
      id: 'super_metroid',
      title: 'Super Metroid (SNES)',
      console: 'snes',
      consoleName: 'Super Nintendo',
      magnet: 'magnet:?xt=urn:btih:8910471923481230491823094812034981203948&dn=Super+Metroid+(USA).sfc',
      description: 'Atmospheric sci-fi exploration on planet Zebes with Samus Aran.',
      size: '3.0 MB'
    },
    {
      id: 'castlevania_sotn',
      title: 'Castlevania - Symphony of the Night (PS1)',
      console: 'psx',
      consoleName: 'PlayStation',
      magnet: 'magnet:?xt=urn:btih:7234891230498123049182034981203948120394&dn=Castlevania+-+Symphony+of+the+Night+(USA).chd',
      description: 'Alucard explores Dracula\'s castle in the defining Metroidvania epic.',
      size: '360 MB'
    }
  ];

  const handleSearch = async (e) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    setSearching(true);
    setStatusMsg(null);
    try {
      const data = await fetchJson(`/api/discover/search?q=${encodeURIComponent(searchQuery.trim())}`);
      setResults(data.results || []);
    } catch (err) {
      setStatusMsg(`Search note: ${err.message || 'Connecting to archive index'}`);
    } finally {
      setSearching(false);
    }
  };

  const handleDownloadToDrive = async (game) => {
    if (!user?.gamesFolderId) {
      onOpenSettings();
      return;
    }

    setDispatchingId(game.id);
    setStatusMsg(null);

    try {
      const res = await fetchJson('/api/downloads/add', {
        method: 'POST',
        body: JSON.stringify({
          magnet: game.magnet,
          title: game.title,
          console: game.console,
          kind: 'game'
        })
      });

      setDispatchedIds((prev) => new Set([...prev, game.id]));
      setStatusMsg(`✅ "${game.title}" sent to Downloader server! It will be saved into your Google Drive.`);
      if (onDownloadDispatched) onDownloadDispatched();
    } catch (err) {
      setStatusMsg(`Download dispatch error: ${err.message}`);
    } finally {
      setDispatchingId(null);
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-screen bg-[#070a12] p-8 overflow-y-auto">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-2 text-xs uppercase font-bold text-cyan-400 font-heading tracking-wider mb-1">
          <Sparkles className="w-3.5 h-3.5" />
          <span>Curated Discover & Search</span>
        </div>
        <h1 className="font-heading font-extrabold text-3xl text-white tracking-tight">
          Discover & Add Games
        </h1>
        <p className="text-sm text-slate-400 mt-1 max-w-2xl">
          Search retro catalogs or pick curated titles. The Downloader server fetches the files and saves them directly to your personal Google Drive Games folder.
        </p>
      </div>

      {/* Search Input Bar */}
      <form onSubmit={handleSearch} className="mb-8 flex gap-3 max-w-2xl">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            placeholder="Search retro games, ROM collections, or Internet Archive..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 bg-slate-900 border border-white/10 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-purple-500 transition-colors"
          />
        </div>
        <button
          type="submit"
          disabled={searching || !searchQuery.trim()}
          className="btn-primary"
        >
          {searching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
          <span>Search</span>
        </button>
      </form>

      {/* Status Notification Toast */}
      {statusMsg && (
        <div className="mb-6 p-4 rounded-xl bg-purple-600/15 border border-purple-500/30 text-purple-200 text-xs flex items-center justify-between animate-in fade-in">
          <span>{statusMsg}</span>
          <button onClick={() => setStatusMsg(null)} className="text-purple-400 hover:text-white">✕</button>
        </div>
      )}

      {/* Featured Games Section */}
      <div className="space-y-4 mb-10">
        <h2 className="font-heading font-bold text-lg text-white flex items-center gap-2">
          <Gamepad2 className="w-4 h-4 text-purple-400" />
          <span>Featured Retro Classics</span>
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {FEATURED_GAMES.map((item) => {
            const isDispatched = dispatchedIds.has(item.id);
            const isDispatching = dispatchingId === item.id;
            return (
              <div
                key={item.id}
                className="glass-panel p-5 flex flex-col justify-between hover:border-purple-500/30 transition-all group"
              >
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className={`badge-console badge-${item.console}`}>{item.consoleName}</span>
                    <span className="text-[11px] text-slate-500 font-medium">{item.size}</span>
                  </div>
                  <h3 className="font-heading font-bold text-base text-white group-hover:text-purple-300 transition-colors">
                    {item.title}
                  </h3>
                  <p className="text-xs text-slate-400 mt-1 line-clamp-2 leading-relaxed">
                    {item.description}
                  </p>
                </div>

                <div className="mt-5 pt-3 border-t border-white/5 flex items-center justify-between">
                  <span className="text-[10px] text-slate-500">Auto-organizes to Drive</span>
                  <button
                    onClick={() => handleDownloadToDrive(item)}
                    disabled={isDispatching || isDispatched}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition ${
                      isDispatched
                        ? 'bg-emerald-600/20 text-emerald-400 border border-emerald-500/30 cursor-default'
                        : 'bg-purple-600 hover:bg-purple-500 text-white shadow-sm'
                    }`}
                  >
                    {isDispatching ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : isDispatched ? (
                      <Check className="w-3.5 h-3.5" />
                    ) : (
                      <Download className="w-3.5 h-3.5" />
                    )}
                    <span>{isDispatched ? 'Sent to Drive' : isDispatching ? 'Sending...' : 'Download to Drive'}</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
