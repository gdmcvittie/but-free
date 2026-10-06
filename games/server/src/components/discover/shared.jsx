import React, { useState, useCallback } from 'react';
import { Magnet, Download, FileArchive, X, Loader2, Check, HardDrive, ExternalLink } from 'lucide-react';
import { fetchJson } from '../../utils/api';

// -------------------------------------------------------------
// Shared hook: dispatch a source (magnet / .torrent / direct URL)
// to the games server which queues it on the Downloader node.
// -------------------------------------------------------------

export function useAddJob(onDownloadDispatched) {
  const [busyId, setBusyId] = useState(null);
  const [doneIds, setDoneIds] = useState(new Set());
  const [status, setStatus] = useState(null); // {type:'ok'|'err', message}

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
      return false;
    } finally {
      setBusyId(null);
    }
  }, [onDownloadDispatched]);

  return { add, busyId, doneIds, status, setStatus };
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
      <button onClick={onClear} className="opacity-70 hover:opacity-100 shrink-0">✕</button>
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
    <div className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div className="glass-modal rounded-2xl w-full max-w-lg max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 pb-3 border-b border-white/5">
          <div className="min-w-0">
            <h3 className="font-heading font-bold text-sm text-white truncate">{inspect.name}</h3>
            <p className="text-[11px] text-slate-400 mt-0.5">
              {(inspect.files || []).length} files • {formatBytes(inspect.totalBytes)} total
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 shrink-0">
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
            className="btn-primary !py-2 text-xs"
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
// -------------------------------------------------------------

export function LinksModal({ open, onClose, pageUrl, links, busyId, onPick }) {
  if (!open) return null;

  const iconFor = (l) => {
    if (l.isMagnet) return <Magnet className="w-3.5 h-3.5 text-pink-400 shrink-0" />;
    if (l.extension === 'TORRENT') return <FileArchive className="w-3.5 h-3.5 text-cyan-400 shrink-0" />;
    return <HardDrive className="w-3.5 h-3.5 text-purple-400 shrink-0" />;
  };

  return (
    <div className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div className="glass-modal rounded-2xl w-full max-w-lg max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 pb-3 border-b border-white/5">
          <div className="min-w-0">
            <h3 className="font-heading font-bold text-sm text-white flex items-center gap-2">
              <Download className="w-4 h-4 text-purple-400" />
              Download Mirrors
            </h3>
            <p className="text-[11px] text-slate-500 mt-1 truncate max-w-xs">{pageUrl}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
          {(links || []).length === 0 && (
            <div className="text-center text-xs text-slate-500 py-10">No download links found on this page.</div>
          )}
          {(links || []).map((l) => (
            <div key={l.id || l.url} className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-slate-900/70 border border-white/5 hover:border-purple-500/30 transition">
              {iconFor(l)}
              <div className="flex-1 min-w-0">
                <div className="text-xs text-slate-200 truncate">{l.hoster || 'Direct Link'}</div>
                <div className="text-[10px] text-slate-500 truncate">{l.filename || l.url}</div>
              </div>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 shrink-0">{l.extension}</span>
              <button
                onClick={() => onPick(l)}
                disabled={busyId === (l.id || l.url)}
                className="px-2.5 py-1.5 rounded-lg text-[11px] font-bold bg-purple-600 hover:bg-purple-500 text-white transition disabled:opacity-60 shrink-0"
              >
                {busyId === (l.id || l.url) ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Queue'}
              </button>
              <a
                href={l.isMagnet ? '#' : l.url}
                target="_blank"
                rel="noreferrer"
                className={l.isMagnet ? 'hidden' : 'p-1.5 rounded-lg text-slate-500 hover:text-white transition shrink-0'}
                title="Open in browser"
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>
          ))}
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
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {children}
      {empty && (
        <div className="md:col-span-2 lg:col-span-3 text-center py-16 glass-panel rounded-2xl border border-white/5 text-slate-500 text-xs">
          {empty}
        </div>
      )}
    </div>
  );
}

export function formatBytesPublic(bytes) {
  return formatBytes(bytes);
}
