import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { Magnet, Download, FileArchive, X, Loader2, Check, HardDrive, ExternalLink, Copy, Search, Zap } from 'lucide-react';
import { fetchJson } from '../../utils/api';

// -------------------------------------------------------------
// Shared hook: dispatch a source (magnet / .torrent / direct URL)
// to the games server which queues it on the Downloader node.
// -------------------------------------------------------------

export function useAddJob(onDownloadDispatched) {
  const [busyId, setBusyId] = useState(null);
  const [doneIds, setDoneIds] = useState(new Set());
  const [status, setStatus] = useState(null); // {type:'ok'|'err', message}
  const [ffAssist, setFfAssist] = useState(null); // {fileIds, links, totalBlocked, totalFailed, onRetry, batchTitle}

  const add = useCallback(async (key, { source, title, console: consoleKey, selectedFiles, subfolder }) => {
    setBusyId(key);
    setStatus(null);
    try {
      await fetchJson('/api/pc/add', {
        method: 'POST',
        body: JSON.stringify({
          source,
          title,
          console: consoleKey || 'pc',
          selectedFiles: selectedFiles || undefined,
          subfolder: subfolder || undefined
        })
      });
      setDoneIds((prev) => new Set([...prev, key]));
      setStatus({ type: 'ok', message: `Queued "${title}" on the Downloader node — files will land in your Google Drive.` });
      if (onDownloadDispatched) onDownloadDispatched();
      return true;
    } catch (err) {
      setStatus({ type: 'err', message: err.message || 'Failed to queue download' });
      if (err.code === 'ff-captcha') {
        setFfAssist({
          fileIds: [err.fileId].filter(Boolean),
          links: [{ url: source, note: err.message }],
          totalBlocked: 1,
          totalFailed: 1,
          batchTitle: title,
          onRetry: () => add(key, { source, title, console: consoleKey, selectedFiles, subfolder })
        });
      }
      return false;
    } finally {
      setBusyId(null);
    }
  }, [onDownloadDispatched]);

  const addBatch = useCallback(async (batchItems, defaultTitle) => {
    if (!Array.isArray(batchItems) || batchItems.length === 0) return false;
    setBusyId('__batch__');
    setStatus(null);
    try {
      const payload = batchItems.map(l => ({
        source: l.url,
        title: defaultTitle || l.filename || 'PC Game',
        filename: l.filename,
        hoster: l.hoster,
        console: 'pc'
      }));
      const res = await fetchJson('/api/pc/add-batch', {
        method: 'POST',
        body: JSON.stringify({ items: payload, title: defaultTitle })
      });
      const count = res.count || 0;
      const errors = Array.isArray(res.errors) ? res.errors : [];
      const blocked = res.blocked || errors.some((e) => e.code === 'ff-captcha');

      // Only mark links that actually reached the downloader as queued.
      const failedTargets = new Set(errors.map((e) => e.target));
      setDoneIds((prev) => {
        const next = new Set(prev);
        batchItems.forEach(l => {
          if (!failedTargets.has(l.url)) next.add(l.id || l.url);
        });
        return next;
      });

      if (count > 0) {
        setStatus({
          type: 'ok',
          message: `Queued ${count} download(s) for "${defaultTitle || 'PC Game'}" on the Downloader node — files will land in your Google Drive.`
        });
        if (onDownloadDispatched) onDownloadDispatched();
        return true;
      }

      if (blocked) {
        const ffErrors = errors.filter((e) => e.code === 'ff-captcha');
        setFfAssist({
          fileIds: [...new Set((res.ffFileIds || []).concat(ffErrors.map((e) => e.fileId)).filter(Boolean))],
          links: ffErrors.map((e) => ({ url: e.target, note: e.error })).slice(0, 12),
          totalBlocked: ffErrors.length,
          totalFailed: errors.length,
          batchTitle: defaultTitle || 'PC Game',
          onRetry: () => addBatch(batchItems, defaultTitle)
        });
        setStatus({
          type: 'err',
          message: `FuckingFast blocked ${ffErrors.length} of ${batchItems.length} link(s) with a Cloudflare check. Pass the check in a popup, then retry — or queue another mirror.`
        });
      } else if (errors.length > 0) {
        setStatus({
          type: 'err',
          message: `Queued 0 — ${errors.length} link(s) failed (${errors[0]?.error || 'unknown error'}).`
        });
      } else {
        setStatus({ type: 'err', message: 'Queued 0 — the downloader did not accept any of the links.' });
      }
      return false;
    } catch (err) {
      setStatus({ type: 'err', message: err.message || 'Failed to queue batch downloads' });
      return false;
    } finally {
      setBusyId(null);
    }
  }, [onDownloadDispatched]);

  return { add, addBatch, busyId, doneIds, status, setStatus, ffAssist, setFfAssist };
}

export function JobStatusBanner({ status, onClear }) {
  if (!status) return null;
  return (
    <div className={`p-3.5 rounded-xl text-xs flex items-center justify-between gap-3 border ${
      status.type === 'ok'
        ? 'bg-emerald-600/10 border-emerald-500/30 text-emerald-300'
        : 'bg-red-500/10 border-red-500/30 text-red-300'
    }`}>
      <span>{status.message}</span>
      <button onClick={onClear} className="icon-btn icon-btn-sm shrink-0">✕</button>
    </div>
  );
}

// -------------------------------------------------------------
// Torrent file list modal (inspect via node, pick files)
// -------------------------------------------------------------

function formatBytes(bytes) {
  if (!bytes || isNaN(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = Number(bytes);
  let i = 0;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function TorrentFilesModal({ open, onClose, inspect, defaultSelected, onConfirm, busy }) {
  const [selected, setSelected] = useState(() => new Set(inspect?.files?.map(f => f.path) || []));

  if (!open || !inspect) return null;

  const toggle = (path) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const selectedBytes = (inspect.files || [])
    .filter(f => selected.has(f.path))
    .reduce((sum, f) => sum + (f.length || 0), 0);

  return (
    <div className="pc-rss-modal-backdrop" onClick={onClose}>
      <div className="pc-rss-modal-content" style={{ maxWidth: '620px' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 pb-3 border-b border-white/5">
          <div className="min-w-0">
            <h3 className="font-heading font-bold text-sm text-white truncate">{inspect.name}</h3>
            <p className="text-[11px] text-slate-400 mt-0.5">
              {(inspect.files || []).length} files • {formatBytes(inspect.totalBytes)} total
            </p>
          </div>
          <button onClick={onClose} className="icon-btn icon-btn-sm shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-1">
          {(inspect.files || []).map((f) => {
            const isSel = selected.has(f.path);
            return (
              <button
                key={f.path}
                onClick={() => toggle(f.path)}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left text-xs transition border ${
                  isSel
                    ? 'bg-purple-600/15 border-purple-500/30 text-purple-200'
                    : 'bg-slate-900/60 border-white/5 text-slate-400 hover:border-white/15'
                }`}
              >
                <span className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${isSel ? 'bg-purple-600 border-purple-500' : 'border-slate-600'}`}>
                  {isSel && <Check className="w-3 h-3 text-white" />}
                </span>
                <span className="flex-1 min-w-0 truncate">{f.path}</span>
                <span className="text-[10px] font-mono shrink-0 opacity-70">{formatBytes(f.length)}</span>
              </button>
            );
          })}
        </div>

        <div className="p-4 border-t border-white/5 flex items-center justify-between gap-3">
          <span className="text-[11px] text-slate-400">
            {selected.size} selected • <strong className="text-white">{formatBytes(selectedBytes)}</strong>
          </span>
          <button
            onClick={() => onConfirm(Array.from(selected))}
            disabled={busy || selected.size === 0}
            className="btn btn-primary btn-sm"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            <span>Download to Drive</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// -------------------------------------------------------------
// Scrape-links modal: all mirrors from a repack/post page
// Ported directly from C:\_code\my-games\my-games-server
// -------------------------------------------------------------

export function LinksModal({
  open,
  onClose,
  pageUrl,
  itemTitle,
  links = [],
  loading = false,
  busyId,
  doneIds = new Set(),
  onPick,
  onAddBatch
}) {
  const [hosterFilter, setHosterFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [batchBusy, setBatchBusy] = useState(false);
  const [copiedId, setCopiedId] = useState(null);

  // Group and count hosters
  const { hosterCounts, magnetCount, torrentCount, ffCount, directCount } = useMemo(() => {
    const counts = {};
    let magnets = 0;
    let torrents = 0;
    let ff = 0;
    let direct = 0;

    (links || []).forEach((l) => {
      const isMag = l.isMagnet || (l.url && l.url.startsWith('magnet:'));
      const isTorr = !isMag && l.extension === 'TORRENT';
      if (isMag) {
        magnets++;
      } else if (isTorr) {
        torrents++;
      } else {
        const h = l.hoster || 'Direct File';
        counts[h] = (counts[h] || 0) + 1;
        if (h === 'FuckingFast') ff++;
        else direct++;
      }
    });

    return { hosterCounts: counts, magnetCount: magnets, torrentCount: torrents, ffCount: ff, directCount: direct };
  }, [links]);

  // Default to FuckingFast if present on initial load or link arrival
  useEffect(() => {
    if (hosterCounts['FuckingFast']) {
      setHosterFilter('FuckingFast');
    } else {
      setHosterFilter('all');
    }
  }, [hosterCounts]);

  if (!open) return null;

  // Filter links by hoster and search query
  const filteredLinks = (links || []).filter((l) => {
    const isMag = l.isMagnet || (l.url && l.url.startsWith('magnet:'));
    if (hosterFilter !== 'all') {
      if (hosterFilter === 'magnet') {
        if (!isMag) return false;
      } else {
        if (isMag || (l.hoster !== hosterFilter)) return false;
      }
    }
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      const nameMatch = l.filename && l.filename.toLowerCase().includes(q);
      const hosterMatch = l.hoster && l.hoster.toLowerCase().includes(q);
      const extMatch = l.extension && l.extension.toLowerCase().includes(q);
      const urlMatch = l.url && l.url.toLowerCase().includes(q);
      if (!nameMatch && !hosterMatch && !extMatch && !urlMatch) return false;
    }
    return true;
  });

  const handleQueueAll = async () => {
    if (!onAddBatch || filteredLinks.length === 0) return;
    setBatchBusy(true);
    try {
      await onAddBatch(filteredLinks, itemTitle);
    } finally {
      setBatchBusy(false);
    }
  };

  const handleCopy = (l) => {
    if (!l.url) return;
    navigator.clipboard?.writeText(l.url);
    setCopiedId(l.id || l.url);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const iconFor = (l) => {
    if (l.isMagnet) return <Magnet className="w-3.5 h-3.5 text-pink-400 shrink-0" />;
    if (l.extension === 'TORRENT') return <FileArchive className="w-3.5 h-3.5 text-cyan-400 shrink-0" />;
    if (l.hoster === 'FuckingFast') return <Zap className="w-3.5 h-3.5 text-emerald-400 shrink-0" />;
    return <HardDrive className="w-3.5 h-3.5 text-purple-400 shrink-0" />;
  };

  return (
    <div className="pc-rss-modal-backdrop" onClick={onClose}>
      <div className="pc-rss-modal-content" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="pc-modal-header">
          <div className="min-w-0">
            <h3 className="font-heading font-bold text-base text-white flex items-center gap-2">
              <Download className="w-4 h-4 text-emerald-400" />
              <span>{itemTitle ? `Webpage Links: ${itemTitle}` : 'Download Mirrors & Links'}</span>
            </h3>
            <p className="text-[11px] text-slate-400 mt-1 truncate max-w-md">
              {loading ? '🔍 Deep scanning webpage for all download mirrors, FuckingFast & magnets...' : pageUrl}
            </p>
          </div>
          <button onClick={onClose} className="icon-btn icon-btn-sm shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Filter Bar (matching my-games-server) */}
        <div className="pc-modal-filter-bar">
          {/* Hoster dropdown */}
          <select
            value={hosterFilter}
            onChange={(e) => setHosterFilter(e.target.value)}
            className="pc-modal-select"
          >
            <option value="all">All Mirrors ({(links || []).length})</option>
            {hosterCounts['FuckingFast'] > 0 && (
              <option value="FuckingFast">⚡ FuckingFast ({hosterCounts['FuckingFast']})</option>
            )}
            {magnetCount > 0 && (
              <option value="magnet">🧲 BitTorrent Magnet ({magnetCount})</option>
            )}
            {Object.keys(hosterCounts).sort().filter(h => h !== 'FuckingFast').map(h => (
              <option key={h} value={h}>{h} ({hosterCounts[h]})</option>
            ))}
          </select>

          {/* Add All Button */}
          {onAddBatch && (
            <button
              onClick={handleQueueAll}
              disabled={batchBusy || filteredLinks.length === 0}
              className="pc-modal-add-all-btn"
              title="Add all currently filtered links to download queue"
            >
              {batchBusy ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Download className="w-3.5 h-3.5" />
              )}
              <span>
                {hosterFilter === 'FuckingFast'
                  ? `📥 Add All FuckingFast Links (${filteredLinks.length})`
                  : `📥 Add All Links (${filteredLinks.length})`}
              </span>
            </button>
          )}

          {/* Search filter input */}
          <div className="pc-modal-search-wrapper">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              placeholder="Filter mirrors & links..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pc-modal-search"
            />
          </div>
        </div>

        {/* Stats summary banner */}
        {!loading && (links || []).length > 0 && (
          <div className="pc-modal-stats-banner">
            <span>
              ⚡ <strong>{(links || []).length} download links found</strong>
              {magnetCount > 0 && ` • 🧲 ${magnetCount} Magnet${magnetCount > 1 ? 's' : ''}`}
              {torrentCount > 0 && ` • 📦 ${torrentCount} Torrent${torrentCount > 1 ? 's' : ''}`}
              {ffCount > 0 && ` • ⚡ ${ffCount} FuckingFast`}
              {directCount > 0 && ` • ⬇️ ${directCount} Other Mirror${directCount > 1 ? 's' : ''}`}
            </span>
            <span className="text-slate-400 font-mono text-[10px]">
              Showing {filteredLinks.length}
            </span>
          </div>
        )}

        {/* Links list */}
        <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-slate-400">
              <div className="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
              <p className="text-xs">Deep scanning webpage for FuckingFast links, mirrors & magnets...</p>
            </div>
          ) : filteredLinks.length === 0 ? (
            <div className="text-center text-xs text-slate-400 py-12">
              No download links match the selected filter.
            </div>
          ) : (
            filteredLinks.map((l) => {
              const isQueued = doneIds.has(l.id || l.url);
              const isBusy = busyId === (l.id || l.url);
              const isFf = l.hoster === 'FuckingFast';

              return (
                <div
                  key={l.id || l.url}
                  className={`pc-rss-link-row ${isFf ? 'is-ff' : ''}`}
                >
                  {iconFor(l)}
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold text-slate-200 truncate flex items-center gap-2">
                      <span className="truncate">{l.filename || l.url}</span>
                    </div>
                    <div className="text-[10px] text-slate-500 truncate mt-0.5">{l.url}</div>
                  </div>

                  {/* Badge */}
                  {isFf ? (
                    <span
                      style={{
                        background: '#10b981',
                        color: '#ffffff',
                        fontWeight: 900,
                        fontSize: '10px',
                        padding: '2px 6px',
                        borderRadius: '4px',
                        letterSpacing: '0.3px',
                        flexShrink: 0
                      }}
                    >
                      ⚡ FuckingFast
                    </span>
                  ) : l.isMagnet ? (
                    <span className="badge-console badge-snes" style={{ position: 'static', flexShrink: 0 }}>
                      🧲 MAGNET
                    </span>
                  ) : l.extension === 'TORRENT' ? (
                    <span className="badge-console badge-arcade" style={{ position: 'static', flexShrink: 0 }}>
                      📦 TORRENT
                    </span>
                  ) : (
                    <span className="badge-console badge-pc" style={{ position: 'static', flexShrink: 0 }}>
                      {l.hoster || l.extension || 'MIRROR'}
                    </span>
                  )}

                  {/* Copy Link */}
                  <button
                    onClick={() => handleCopy(l)}
                    className="icon-btn icon-btn-sm shrink-0"
                    title="Copy download link"
                  >
                    {copiedId === (l.id || l.url) ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>

                  {/* Queue Button */}
                  <button
                    onClick={() => onPick(l)}
                    disabled={isBusy || isQueued}
                    className={`btn btn-xs shrink-0 ${
                      isQueued
                        ? 'bg-emerald-600/20 text-emerald-400 border border-emerald-500/30 cursor-default'
                        : isFf
                        ? 'btn-primary'
                        : 'btn-secondary'
                    }`}
                  >
                    {isBusy ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : isQueued ? (
                      <span className="flex items-center gap-1"><Check className="w-3 h-3" /> Queued</span>
                    ) : (
                      'Queue'
                    )}
                  </button>

                  {/* External link */}
                  {!l.isMagnet && (
                    <a
                      href={l.url}
                      target="_blank"
                      rel="noreferrer"
                      className="icon-btn icon-btn-sm shrink-0"
                      title="Open mirror in browser"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

// -------------------------------------------------------------
// Generic card grid shell
// -------------------------------------------------------------

export function Grid({ children, empty }) {
  return (
    <>
      <div className="games-grid">
        {children}
      </div>
      {empty && (
        <div className="text-center py-16 glass-panel rounded-2xl border border-white/5 text-slate-500 text-xs">
          {empty}
        </div>
      )}
    </>
  );
}

// -------------------------------------------------------------
// FuckingFast Cloudflare / Turnstile assist modal.
// The download host now challenges automation (and datacenter IPs) with a
// Cloudflare captcha that only the user's browser can pass. Direct downloads
// from dl.fuckingfast.co are NOT blocked, so once the user passes the check we
// can't read the page cross-origin — the reliable path back is a server retry
// (the block is often rate-based/transient) or pasting the direct file URL.
// -------------------------------------------------------------

export function FuckingFastAssistModal({ assist, onClose }) {
  const [retrying, setRetrying] = useState(false);

  if (!assist) return null;

  const fileIds = Array.isArray(assist.fileIds) ? assist.fileIds : [];
  const links = Array.isArray(assist.links) ? assist.links : [];
  const totalBlocked = assist.totalBlocked || links.length || fileIds.length;

  const openPopup = () => {
    const fileId = fileIds[0];
    const url = fileId ? `https://fuckingfast.co/${fileId}` : (links[0]?.url || 'https://fuckingfast.co/');
    window.open(url, '_ff_popup', 'popup=yes,width=640,height=780,top=80,left=160');
  };

  const handleRetry = async () => {
    setRetrying(true);
    try {
      const ok = await assist.onRetry?.();
      if (ok) onClose();
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="pc-rss-modal-backdrop" onClick={onClose}>
      <div className="pc-rss-modal-content" style={{ maxWidth: '520px' }} onClick={(e) => e.stopPropagation()}>
        <div className="pc-modal-header">
          <div className="min-w-0">
            <h3 className="font-heading font-bold text-sm text-white flex items-center gap-2">
              <Zap className="w-4 h-4 text-emerald-400" />
              <span>FuckingFast needs a human check</span>
            </h3>
            <p className="text-[11px] text-slate-400 mt-1">
              {totalBlocked} of {assist.totalFailed || totalBlocked} link(s) blocked by a Cloudflare captcha for “{assist.batchTitle || 'PC Game'}”.
            </p>
          </div>
          <button onClick={onClose} className="icon-btn icon-btn-sm shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div className="rounded-lg bg-slate-900/60 border border-white/5 p-3 text-[11px] text-slate-400 leading-relaxed">
            The download host now runs a Cloudflare/Turnstile captcha before issuing direct
            file links, and it refuses automated requests from the server. Your browser can
            pass it easily:
            <ol className="mt-2 space-y-1 list-decimal list-inside">
              <li>Open a popup to the file page.</li>
              <li>Tick the “I’m not a robot” box if it appears.</li>
              <li>Come back and press <strong className="text-white">Retry queue</strong>.</li>
            </ol>
            If it still can’t extract the link, open the file page directly, then paste the
            direct <span className="font-mono text-emerald-300">dl.fuckingfast.co/dl/…</span> file URL.
          </div>

          {links.length > 0 && (
            <div className="space-y-1.5 max-h-44 overflow-y-auto pr-1">
              {links.map((l) => (
                <div key={l.url} className="flex items-center gap-2 rounded-lg bg-slate-900/40 border border-white/5 px-3 py-1.5">
                  <span className="flex-1 min-w-0 text-[11px] text-slate-300 font-mono truncate">{l.url}</span>
                  <a
                    href={l.url}
                    target="_blank"
                    rel="noreferrer"
                    className="icon-btn icon-btn-sm shrink-0"
                    title="Open file page in browser"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
            <button onClick={openPopup} className="btn btn-secondary btn-sm flex-1" title="Opens the file page in a popup so the Cloudflare check can be passed in your browser">
              <ExternalLink className="w-3.5 h-3.5" />
              <span>Open popup &amp; pass check</span>
            </button>
            <button
              onClick={handleRetry}
              disabled={retrying || !assist.onRetry}
              className="btn btn-primary btn-sm flex-1"
              title="After passing the check, retry queueing these links"
            >
              {retrying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
              <span>{retrying ? 'Retrying…' : `Retry (${totalBlocked})`}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function formatBytesPublic(bytes) {
  return formatBytes(bytes);
}
