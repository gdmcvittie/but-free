import React, { useState, useEffect, useCallback } from 'react';
import {
  Loader2, Check, Search, Download, RefreshCw, ExternalLink,
  Link2, X, Package, BookMarked
} from 'lucide-react';
import { fetchJson } from '../../utils/api';
import { JobStatusBanner, Grid } from './shared';

export default function GogTab({ onDownloadDispatched, onLibraryUpdated }) {
  const [tab, setTab] = useState('new'); // new | sales | purchased
  const [games, setGames] = useState([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [account, setAccount] = useState({ checked: false, connected: false, user: null, loginUrl: '' });
  const [authInput, setAuthInput] = useState('');
  const [connecting, setConnecting] = useState(false);

  const [detailsModal, setDetailsModal] = useState(null); // {game, installers, loading}
  const [busyId, setBusyId] = useState(null);
  const [doneIds, setDoneIds] = useState(new Set());
  const [status, setStatus] = useState(null);

  useEffect(() => {
    fetchJson('/api/gog/account')
      .then((data) => setAccount({ checked: true, ...data }))
      .catch(() => setAccount({ checked: true, connected: false, user: null, loginUrl: '' }));
  }, []);

  const loadCatalog = useCallback(async (t, p) => {
    setLoading(true);
    setError(null);
    try {
      if (t === 'purchased') {
        const data = await fetchJson('/api/gog/my-library');
        setGames((data.games || []).filter(g => !g.isDlc));
        setTotalPages(1);
      } else {
        const data = await fetchJson(`/api/gog/catalog?tab=${t}&page=${p}`);
        setGames((data.games || []).filter(g => !g.isDlc));
        setTotalPages(data.totalPages || 1);
      }
    } catch (err) {
      setError(err.message || 'Failed to load GOG games');
      setGames([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCatalog(tab, page);
  }, [tab, page, loadCatalog]);

  const connectAccount = async (e) => {
    e.preventDefault();
    if (!authInput.trim()) return;
    setConnecting(true);
    setError(null);
    try {
      const data = await fetchJson('/api/gog/account', {
        method: 'POST',
        body: JSON.stringify({ code: authInput.trim() })
      });
      setAccount({ checked: true, connected: true, user: data.user, loginUrl: account.loginUrl });
      setAuthInput('');
      setStatus({ type: 'ok', message: `Connected GOG account "${data.user.username}"` });
      if (tab !== 'purchased') setTab('purchased');
    } catch (err) {
      setError(err.message);
    } finally {
      setConnecting(false);
    }
  };

  const disconnectAccount = async () => {
    try {
      await fetchJson('/api/gog/account', { method: 'DELETE' });
      setAccount((prev) => ({ ...prev, connected: false, user: null }));
      setTab('new');
    } catch { /* ignore */ }
  };

  const openDetails = async (g) => {
    setDetailsModal({ game: g, installers: [], loading: true });
    try {
      const data = await fetchJson(`/api/gog/game-details/${g.id}`);
      setDetailsModal((prev) => prev ? { ...prev, installers: data.installers || [], loading: false } : prev);
    } catch (err) {
      setDetailsModal(null);
      setStatus({ type: 'err', message: err.message });
    }
  };

  const downloadInstaller = async (installer) => {
    setBusyId(`${detailsModal.game.id}_${installer.fileName}`);
    try {
      const data = await fetchJson('/api/gog/download', {
        method: 'POST',
        body: JSON.stringify({
          gameId: detailsModal.game.id,
          downlinkUrl: installer.downlink,
          gameTitle: detailsModal.game.title,
          coverUrl: detailsModal.game.coverUrl,
          fileName: installer.fileName
        })
      });
      setDoneIds((prev) => new Set([...prev, `${detailsModal.game.id}_${installer.fileName}`]));
      setStatus({ type: 'ok', message: data.message });
      if (onDownloadDispatched) onDownloadDispatched();
      setDetailsModal(null);
      void onLibraryUpdated;
    } catch (err) {
      setStatus({ type: 'err', message: err.message });
    } finally {
      setBusyId(null);
    }
  };

  const actionFor = (g) => {
    if (g.inLibrary) {
      return (
        <span className="btn btn-xs w-full bg-emerald-600/15 text-emerald-400 border border-emerald-500/25 cursor-default justify-center">
          <Check className="w-3.5 h-3.5" /><span>In Library</span>
        </span>
      );
    }
    if (tab === 'purchased') {
      return (
        <button
          onClick={() => openDetails(g)}
          className="btn btn-primary btn-xs w-full"
        >
          <Package className="w-3.5 h-3.5" />
          <span>Installers</span>
        </button>
      );
    }
    return (
      <a
        href={g.url}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="btn btn-secondary btn-xs w-full justify-center"
      >
        <ExternalLink className="w-3.5 h-3.5" />
        <span>Check it out</span>
      </a>
    );
  };

  return (
    <div className="space-y-5">
      {/* Account panel */}
      <div className="glass-panel p-4">
        {account.checked && !account.connected ? (
          <div className="space-y-3">
            <div className="flex items-start gap-2 text-xs text-slate-400">
              <Link2 className="w-4 h-4 text-purple-400 shrink-0 mt-0.5" />
              <div>
                Connect your <strong className="text-slate-200">GOG.com account</strong> to download your owned DRM-free offline installers to Drive.
                <ol className="mt-2 space-y-1 text-[11px] text-slate-500 list-decimal list-inside">
                  <li>Click <em>Open GOG Login</em> and sign in.</li>
                  <li>You'll land on a <code className="text-purple-300">embed.gog.com/on_login_success?...code=...</code> URL (error page is fine).</li>
                  <li>Copy the full URL (or just the code) and paste it below.</li>
                </ol>
              </div>
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <a
                href={account.loginUrl || 'https://login.gog.com/auth?client_id=46899977096215655&layout=galaxy&redirect_uri=https%3A%2F%2Fembed.gog.com%2Fon_login_success%3Forigin%3Dclient&response_type=code'}
                target="_blank"
                rel="noreferrer"
                className="btn btn-secondary btn-sm whitespace-nowrap justify-center"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                <span>Open GOG Login</span>
              </a>
              <form onSubmit={connectAccount} className="flex gap-2 flex-1">
                <input
                  type="text"
                  placeholder="Paste redirect URL or authorization code..."
                  value={authInput}
                  onChange={(e) => setAuthInput(e.target.value)}
                  className="flex-1 px-3.5 py-2 bg-slate-900 border border-white/10 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-purple-500 min-w-0"
                />
                <button type="submit" disabled={connecting || !authInput.trim()} className="btn btn-primary btn-sm whitespace-nowrap">
                  {connecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Link2 className="w-3.5 h-3.5" />}
                  <span>Connect</span>
                </button>
              </form>
            </div>
          </div>
        ) : account.connected ? (
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-9 h-9 rounded-xl bg-purple-600/30 border border-purple-500/40 flex items-center justify-center text-purple-300 font-bold shrink-0 overflow-hidden">
                {account.user?.avatar ? <img src={account.user.avatar} alt="" className="w-full h-full object-cover" /> : 'G'}
              </div>
              <div className="min-w-0">
                <div className="text-sm font-bold text-white truncate">{account.user?.username || 'GOG Gamer'}</div>
                <div className="text-[11px] text-emerald-400">GOG account connected</div>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => {
                  setTab(tab === 'purchased' ? 'new' : 'purchased');
                  setPage(1);
                }}
                className="btn btn-secondary btn-sm"
              >
                <BookMarked className="w-3.5 h-3.5" />
                <span>{tab === 'purchased' ? 'Browse Catalog' : 'My Purchases'}</span>
              </button>
              <button onClick={disconnectAccount} className="btn btn-danger btn-sm">
                Disconnect
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {/* Tabs */}
      {tab !== 'purchased' ? (
        <div className="flex items-center gap-2 overflow-x-auto scrollbar-none">
          {[
            { key: 'new', label: 'New Releases' },
            { key: 'sales', label: 'Deals' }
          ].map((t) => (
            <button
              key={t.key}
              onClick={() => { setTab(t.key); setPage(1); }}
              className={`filter-chip ${tab === t.key ? 'active' : ''}`}
            >
              {t.label}
            </button>
          ))}
          <button onClick={() => loadCatalog(tab, page)} disabled={loading} className="icon-btn ml-auto shrink-0" title="Refresh">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <BookMarked className="w-4 h-4 text-purple-400" />
            <span className="font-bold text-white">Your GOG Library</span>
            <span>• {games.length} owned games ready for Drive download</span>
          </div>
          <button onClick={() => loadCatalog('purchased', 1)} disabled={loading} className="icon-btn" title="Refresh Library">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      )}

      <JobStatusBanner status={status} onClear={() => setStatus(null)} />
      {error && <JobStatusBanner status={{ type: 'err', message: error }} onClear={() => setError(null)} />}

      {loading ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3 text-slate-400">
          <div className="w-10 h-10 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm">Loading GOG catalog...</p>
        </div>
      ) : (
        <Grid empty={games.length === 0 ? 'Nothing here right now.' : ''}>
          {games.map((g) => (
            <div key={`${tab}_${g.id}`} className="game-card group">
              <div className="game-card-poster">
                {g.coverUrl && (
                  <img src={g.coverUrl} alt="" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" loading="lazy" />
                )}
                <span className="badge-console badge-pc badge-top-left">GOG</span>
                {(!g.price || (typeof g.price === 'string' && g.price.toUpperCase() === 'FREE')) ? (
                  <span className="badge-price-free badge-top-right">FREE</span>
                ) : (
                  <span className="badge-price-paid badge-top-right">
                    {g.discount && (
                      <span className="badge-discount">
                        {g.discount}
                      </span>
                    )}
                    <span>{g.price}</span>
                  </span>
                )}
              </div>
              <div className="game-card-meta">
                <div className="game-card-title" title={g.title}>{g.title}</div>
                <div className="game-card-sub">
                  <span className="truncate">{g.category || 'PC Game'}{g.rating ? ` • ★${g.rating}` : ''}</span>
                  <a href={g.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="text-[10px] text-purple-400 hover:text-purple-300 font-semibold transition shrink-0">
                    gog ↗
                  </a>
                </div>
                <div className="pt-1 mt-auto">
                  {actionFor(g)}
                </div>
              </div>
            </div>
          ))}
        </Grid>
      )}

      {!loading && tab !== 'purchased' && totalPages > 1 && (
        <div className="flex items-center justify-center gap-4 pt-2">
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="btn btn-secondary btn-sm">← Prev</button>
          <span className="text-xs text-slate-500 font-semibold">Page {page} / {totalPages}</span>
          <button onClick={() => setPage((p) => p + 1)} disabled={page >= totalPages} className="btn btn-secondary btn-sm">Next →</button>
        </div>
      )}

      {/* Installers modal */}
      {detailsModal && (
        <div className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setDetailsModal(null)}>
          <div className="glass-modal rounded-2xl w-full max-w-md max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-5 pb-3 border-b border-white/5">
              <div className="min-w-0">
                <h3 className="font-heading font-bold text-sm text-white flex items-center gap-2">
                  <Package className="w-4 h-4 text-purple-400 shrink-0" />
                  <span className="truncate">{detailsModal.game.title}</span>
                </h3>
                <p className="text-[11px] text-slate-500 mt-1">Offline installers (DRM-free)</p>
              </div>
              <button onClick={() => setDetailsModal(null)} className="icon-btn icon-btn-sm shrink-0">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
              {detailsModal.loading && (
                <div className="flex items-center justify-center gap-2 py-10 text-xs text-slate-400">
                  <Loader2 className="w-4 h-4 animate-spin" /> Fetching installers...
                </div>
              )}
              {!detailsModal.loading && detailsModal.installers.length === 0 && (
                <div className="text-center text-xs text-slate-500 py-10">No Windows installers found.</div>
              )}
              {detailsModal.installers.map((inst, i) => {
                const key = `${detailsModal.game.id}_${inst.fileName}`;
                return (
                  <div key={`${key}_${i}`} className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg bg-slate-900/70 border border-white/5">
                    <Download className="w-3.5 h-3.5 text-purple-400 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-slate-200 truncate">{inst.fileName}</div>
                      <div className="text-[10px] text-slate-500">
                        {inst.version ? `v${inst.version} • ` : ''}{inst.size || ''}{inst.language && inst.language !== 'English' ? ` • ${inst.language}` : ''}
                      </div>
                    </div>
                    <button
                      onClick={() => downloadInstaller(inst)}
                      disabled={busyId === key || doneIds.has(key)}
                      className={`btn btn-xs shrink-0 ${
                        doneIds.has(key)
                          ? 'bg-emerald-600/20 text-emerald-400 border border-emerald-500/30 cursor-default'
                          : 'btn-primary'
                      }`}
                    >
                      {busyId === key ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : doneIds.has(key) ? <Check className="w-3.5 h-3.5" /> : <Download className="w-3.5 h-3.5" />}
                      <span>{doneIds.has(key) ? 'Queued' : 'Queue'}</span>
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
