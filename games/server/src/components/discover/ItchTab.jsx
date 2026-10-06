import React, { useState, useEffect, useCallback } from 'react';
import {
  Loader2, Check, Search, Download, Heart, KeyRound, RefreshCw,
  BookMarked, ChevronLeft, ChevronRight, Gamepad2, User, ExternalLink
} from 'lucide-react';
import { fetchJson } from '../../utils/api';
import { JobStatusBanner, Grid } from './shared';

const PLATFORMS = [
  { key: 'all', label: 'Retro ROMs' },
  { key: 'gb', label: 'Game Boy' },
  { key: 'gbc', label: 'GBC' },
  { key: 'gba', label: 'GBA' },
  { key: 'nes', label: 'NES' },
  { key: 'snes', label: 'SNES' },
  { key: 'sega', label: 'Genesis' },
  { key: 'pce', label: 'PCE' },
  { key: 'pc', label: 'PC / Windows' },
  { key: 'web', label: 'HTML5 Web' }
];

export default function ItchTab({ user, onDownloadDispatched, onLibraryUpdated }) {
  const [subTab, setSubTab] = useState('store'); // store | library
  const [platform, setPlatform] = useState('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('new-and-popular');
  const [page, setPage] = useState(1);

  const [games, setGames] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [doneIds, setDoneIds] = useState(new Set());

  const [account, setAccount] = useState({ checked: false, connected: false, user: null });
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [connecting, setConnecting] = useState(false);

  const [status, setStatus] = useState(null);

  const loadGames = useCallback(async (plat, q, s, p) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ platform: plat, sort: s, page: String(p) });
      if (q) params.set('q', q);
      const data = await fetchJson(`/api/itch/games?${params.toString()}`);
      setGames(data.games || []);
    } catch (err) {
      setError(err.message || 'Failed to browse itch.io');
      setGames([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadGames(platform, query, sort, page);
  }, [platform, sort, page]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetchJson('/api/itch/account')
      .then((data) => setAccount({ checked: true, ...data }))
      .catch(() => setAccount({ checked: true, connected: false, user: null }));
  }, []);

  const connectAccount = async (e) => {
    e.preventDefault();
    if (!apiKeyInput.trim()) return;
    setConnecting(true);
    setError(null);
    try {
      const data = await fetchJson('/api/itch/account', {
        method: 'POST',
        body: JSON.stringify({ apiKey: apiKeyInput.trim() })
      });
      setAccount({ checked: true, connected: true, user: data.user });
      setApiKeyInput('');
      setStatus({ type: 'ok', message: `Connected itch.io account "${data.user.username}"` });
    } catch (err) {
      setError(err.message);
    } finally {
      setConnecting(false);
    }
  };

  const disconnectAccount = async () => {
    try {
      await fetchJson('/api/itch/account', { method: 'DELETE' });
      setAccount({ checked: true, connected: false, user: null });
      setSubTab('store');
    } catch { /* ignore */ }
  };

  const downloadStoreGame = async (g) => {
    setBusyId(`store_${g.id}`);
    setStatus(null);
    try {
      const isWeb = g.console === 'web';
      if (isWeb) {
        await fetchJson('/api/games/bookmark', {
          method: 'POST',
          body: JSON.stringify({
            url: g.url,
            title: g.title,
            coverUrl: g.rawCoverUrl || g.coverUrl,
            author: g.author,
            description: g.description
          })
        });
        setDoneIds((prev) => new Set([...prev, `store_${g.id}`]));
        setStatus({ type: 'ok', message: `"${g.title}" added to your library — open it from Games to play in-browser!` });
        if (onLibraryUpdated) onLibraryUpdated();
        return;
      }

      const data = await fetchJson('/api/itch/download', {
        method: 'POST',
        body: JSON.stringify({
          gameUrl: g.url,
          consoleId: g.console || 'gb',
          gameTitle: g.title
        })
      });

      if (data.isPaid) {
        setStatus({ type: 'err', message: data.message || 'This game requires purchase.' });
      } else {
        setDoneIds((prev) => new Set([...prev, `store_${g.id}`]));
        setStatus({ type: 'ok', message: data.message });
        if (onDownloadDispatched) onDownloadDispatched();
      }
    } catch (err) {
      setStatus({ type: 'err', message: err.message });
    } finally {
      setBusyId(null);
    }
  };

  const [libraryGames, setLibraryGames] = useState([]);
  const [libraryLoading, setLibraryLoading] = useState(false);

  const loadLibrary = useCallback(async () => {
    setLibraryLoading(true);
    setError(null);
    try {
      const data = await fetchJson('/api/itch/my-library');
      setLibraryGames(data.games || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLibraryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (subTab === 'library' && account.connected && libraryGames.length === 0) {
      loadLibrary();
    }
  }, [subTab, account.connected]); // eslint-disable-line react-hooks/exhaustive-deps

  const downloadOwned = async (g) => {
    setBusyId(`own_${g.id}`);
    setStatus(null);
    try {
      if (g.console === 'web') {
        await fetchJson('/api/games/bookmark', {
          method: 'POST',
          body: JSON.stringify({ url: g.url, title: g.title, coverUrl: g.coverUrl, author: g.author })
        });
        setDoneIds((prev) => new Set([...prev, `own_${g.id}`]));
        setStatus({ type: 'ok', message: `"${g.title}" bookmarked as a Web Game` });
        if (onLibraryUpdated) onLibraryUpdated();
        return;
      }
      const data = await fetchJson('/api/itch/my-library/download', {
        method: 'POST',
        body: JSON.stringify({
          gameId: g.id,
          downloadKeyId: g.downloadKeyId,
          consoleHint: g.console,
          gameTitle: g.title
        })
      });
      setDoneIds((prev) => new Set([...prev, `own_${g.id}`]));
      setStatus({ type: 'ok', message: data.message });
      if (onDownloadDispatched) onDownloadDispatched();
    } catch (err) {
      setStatus({ type: 'err', message: err.message });
    } finally {
      setBusyId(null);
    }
  };

  const actionButton = (prefix, g, onClick) => {
    const key = `${prefix}_${g.id}`;
    const inLib = g.console === 'web' ? false : !!g.inLibrary;
    const done = doneIds.has(key);
    const busy = busyId === key;
    if (inLib) {
      return (
        <span className="btn btn-xs w-full bg-emerald-600/15 text-emerald-400 border border-emerald-500/25 cursor-default justify-center">
          <Check className="w-3.5 h-3.5" /><span>In Library</span>
        </span>
      );
    }

    // If game is not free, render a "Check it out" button that opens the game page in a new window
    const isFree = prefix === 'own' || (!g.isPaid && (!g.price || ['free', '$0', '$0.00', '0', '0.00'].includes(String(g.price).trim().toLowerCase())));
    if (!isFree) {
      return (
        <a
          href={g.url || g.webUrl}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="btn btn-secondary btn-xs w-full justify-center"
        >
          <ExternalLink className="w-3.5 h-3.5" />
          <span>Check it out</span>
        </a>
      );
    }

    const label = g.console === 'web' ? 'Add' : 'Download';
    const Icon = g.console === 'web' ? Heart : Download;
    return (
      <button
        onClick={onClick}
        disabled={busy || done}
        className={`btn btn-xs w-full ${
          done
            ? 'bg-emerald-600/20 text-emerald-400 border border-emerald-500/30 cursor-default'
            : 'btn-primary'
        }`}
      >
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : done ? <Check className="w-3.5 h-3.5" /> : <Icon className="w-3.5 h-3.5" />}
        <span>{done ? (g.console === 'web' ? 'Added' : 'Queued') : label}</span>
      </button>
    );
  };

  const cardFor = (prefix, g, onClick) => (
    <div key={`${prefix}_${g.id}`} className="game-card group">
      {/* Poster Container */}
      <div className="game-card-poster">
        {g.coverUrl ? (
          <img
            src={g.rawCoverUrl ? `/api/proxy-image?url=${encodeURIComponent(g.rawCoverUrl)}` : g.coverUrl}
            alt=""
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
            loading="lazy"
          />
        ) : (
          <div className="flex flex-col items-center justify-center p-3 text-center">
            <Gamepad2 className="w-8 h-8 text-purple-400/60 mb-1 group-hover:scale-110 transition-transform" />
            <span className="text-[10px] font-bold text-slate-400 uppercase font-heading">
              {g.console === 'web' ? 'HTML5' : (g.console || '').toUpperCase()}
            </span>
          </div>
        )}
        <span className={`badge-console badge-${(g.console || 'gb').toLowerCase()} badge-top-left`}>
          {g.console === 'web' ? 'HTML5' : (g.console || '').toUpperCase()}
        </span>
        {!g.isPaid && g.price && prefix === 'store' && (
          <span className="badge-price-free badge-top-right">
            FREE
          </span>
        )}
        {g.isPaid && (
          <span className="badge-price-paid badge-top-right">
            {g.price}
          </span>
        )}
      </div>

      {/* Metadata & Actions */}
      <div className="game-card-meta">
        <div className="game-card-title" title={g.title}>{g.title}</div>
        <div className="game-card-sub">
          <span className="truncate">{g.author ? `by ${g.author}` : (g.console || '').toUpperCase()}</span>
          <a
            href={g.url}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-[10px] text-purple-400 hover:text-purple-300 font-semibold transition shrink-0"
          >
            itch ↗
          </a>
        </div>
        <div className="pt-1 mt-auto">
          {actionButton(prefix, g, () => onClick(g))}
        </div>
      </div>
    </div>
  );

  return (
    <div className="space-y-5">
      {/* Account panel */}
      <div className="glass-panel p-4">
        {account.checked && !account.connected ? (
          <form onSubmit={connectAccount} className="flex flex-col md:flex-row md:items-center gap-3">
            <div className="flex items-center gap-2 text-xs text-slate-400 flex-1">
              <KeyRound className="w-4 h-4 text-purple-400 shrink-0" />
              <span>
                Connect your <strong className="text-slate-200">itch.io account</strong> to browse & download your purchased games.
                Create a key at <a href="https://itch.io/user/settings/api-keys" target="_blank" rel="noreferrer" className="text-purple-300 hover:underline">itch.io API settings</a>.
              </span>
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="itch.io API key (k_...)"
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                className="px-3.5 py-2 bg-slate-900 border border-white/10 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-purple-500 w-56"
              />
              <button type="submit" disabled={connecting || !apiKeyInput.trim()} className="btn btn-primary btn-sm whitespace-nowrap">
                {connecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <User className="w-3.5 h-3.5" />}
                <span>Connect</span>
              </button>
            </div>
          </form>
        ) : account.connected ? (
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-9 h-9 rounded-xl bg-purple-600/30 border border-purple-500/40 flex items-center justify-center text-purple-300 shrink-0 overflow-hidden">
                {account.user?.coverUrl ? <img src={account.user.coverUrl} alt="" className="w-full h-full object-cover" /> : <User className="w-4 h-4" />}
              </div>
              <div className="min-w-0">
                <div className="text-sm font-bold text-white truncate">{account.user?.displayName || account.user?.username}</div>
                <div className="text-[11px] text-emerald-400">itch.io account connected</div>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => { setSubTab(subTab === 'library' ? 'store' : 'library'); if (subTab !== 'library') loadLibrary(); }}
                className="btn btn-secondary btn-sm"
              >
                <BookMarked className="w-3.5 h-3.5" />
                <span>{subTab === 'library' ? 'Browse Store' : 'My Purchases'}</span>
              </button>
              <button onClick={disconnectAccount} className="btn btn-danger btn-sm">
                Disconnect
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {/* Store controls */}
      {subTab === 'store' && (
        <>
          <div className="flex items-center gap-2 overflow-x-auto scrollbar-none pb-1">
            {PLATFORMS.map((p) => (
              <button
                key={p.key}
                onClick={() => { setPlatform(p.key); setPage(1); }}
                className={`filter-chip ${platform === p.key ? 'active' : ''}`}
              >
                {p.label}
              </button>
            ))}
            <select
              value={sort}
              onChange={(e) => { setSort(e.target.value); setPage(1); }}
              className="ml-auto px-3 py-1.5 bg-slate-900 border border-white/10 rounded-xl text-xs text-slate-300 focus:outline-none focus:border-purple-500 shrink-0"
            >
              <option value="new-and-popular">New &amp; Popular</option>
              <option value="top-rated">Top Rated</option>
              <option value="newest">Newest</option>
              <option value="popular">Most Popular</option>
            </select>
          </div>

          <form onSubmit={(e) => { e.preventDefault(); setPage(1); loadGames(platform, query, sort, 1); }} className="flex gap-2">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                placeholder="Search itch.io games, homebrew ROMs..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 bg-slate-900 border border-white/10 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-purple-500 transition-colors"
              />
            </div>
            <button type="submit" className="btn btn-primary">Search</button>
          </form>
        </>
      )}

      <JobStatusBanner status={status} onClear={() => setStatus(null)} />
      {error && <JobStatusBanner status={{ type: 'err', message: error }} onClear={() => setError(null)} />}

      {subTab === 'store' ? (
        <>
          {loading ? (
            <div className="flex flex-col items-center justify-center py-20 gap-3 text-slate-400">
              <div className="w-10 h-10 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
              <p className="text-sm">Browsing itch.io...</p>
            </div>
          ) : (
            <Grid empty={games.length === 0 ? 'No games found for this filter.' : ''}>
              {games.map((g) => cardFor('store', g, downloadStoreGame))}
            </Grid>
          )}

          {!loading && (
            <div className="flex items-center justify-center gap-3 pt-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="icon-btn icon-btn-sm"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-xs text-slate-500 font-semibold">Page {page}</span>
              <button
                onClick={() => setPage((p) => p + 1)}
                disabled={games.length === 0}
                className="icon-btn icon-btn-sm"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <Gamepad2 className="w-4 h-4 text-purple-400" />
              <span>{libraryGames.length} purchased game(s) on itch.io</span>
            </div>
            <button onClick={loadLibrary} disabled={libraryLoading} className="btn btn-secondary btn-sm">
              <RefreshCw className={`w-3.5 h-3.5 ${libraryLoading ? 'animate-spin' : ''}`} />
              <span>Refresh</span>
            </button>
          </div>
          {libraryLoading ? (
            <div className="flex flex-col items-center justify-center py-20 gap-3 text-slate-400">
              <div className="w-10 h-10 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
              <p className="text-sm">Fetching your itch.io purchases...</p>
            </div>
          ) : (
            <Grid empty={libraryGames.length === 0 ? 'No purchases found (only retro/PC/web-targeted games are listed).' : ''}>
              {libraryGames.map((g) => cardFor('own', g, downloadOwned))}
            </Grid>
          )}
        </>
      )}
    </div>
  );
}
