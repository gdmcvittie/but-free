import React, { useState, useEffect } from 'react';
import { Download, Plus, RefreshCw, XCircle, CheckCircle, Clock, HardDrive, AlertCircle, Loader2, ArrowUpRight } from 'lucide-react';
import { fetchJson } from '../utils/api';

export default function DownloadsView({ user, onOpenSettings }) {
  const [downloads, setDownloads] = useState([]);
  const [loading, setLoading] = useState(false);
  const [inputMagnet, setInputMagnet] = useState('');
  const [inputTitle, setInputTitle] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const fetchDownloads = async () => {
    try {
      const data = await fetchJson('/api/downloads');
      setDownloads(data.downloads || []);
    } catch (_) {}
  };

  useEffect(() => {
    fetchDownloads();
    const interval = setInterval(fetchDownloads, 2500);
    return () => clearInterval(interval);
  }, []);

  const handleAddDownload = async (e) => {
    e.preventDefault();
    if (!inputMagnet.trim()) return;
    if (!user?.gamesFolderId) {
      onOpenSettings();
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await fetchJson('/api/downloads/add', {
        method: 'POST',
        body: JSON.stringify({
          magnet: inputMagnet.trim(),
          title: inputTitle.trim() || 'Custom Game Download',
          kind: 'game'
        })
      });
      setInputMagnet('');
      setInputTitle('');
      fetchDownloads();
    } catch (err) {
      setError(err.message || 'Failed to dispatch download');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async (id) => {
    try {
      await fetchJson(`/api/downloads/${id}/cancel`, { method: 'POST' });
      fetchDownloads();
    } catch (_) {}
  };

  const handleClearHistory = async () => {
    try {
      await fetchJson('/api/downloads/history', { method: 'DELETE' });
      fetchDownloads();
    } catch (_) {}
  };

  return (
    <div className="flex-1 flex flex-col bg-[#070a12] p-6 sm:p-8">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="font-heading font-extrabold text-3xl text-white tracking-tight flex items-center gap-3">
            <span>Downloader & Swarm</span>
            <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
              VPS Downloader
            </span>
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Game torrents and direct downloads are fetched by the cloud downloader and transferred directly to your Google Drive Games folder.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleClearHistory}
            className="btn btn-secondary btn-sm"
            title="Clear completed and cancelled jobs"
          >
            Clear History
          </button>
          <button
            onClick={fetchDownloads}
            className="icon-btn"
            title="Refresh queue"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Manual Add Download Box */}
      <div className="glass-panel p-5 mb-8 border border-white/10">
        <h2 className="font-heading font-bold text-sm text-white mb-3 flex items-center gap-2">
          <Plus className="w-4 h-4 text-purple-400" />
          <span>Add Custom Magnet or Torrent Link</span>
        </h2>
        <form onSubmit={handleAddDownload} className="flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            placeholder="magnet:?xt=urn:btih:... or .torrent URL"
            value={inputMagnet}
            onChange={(e) => setInputMagnet(e.target.value)}
            className="flex-1 px-4 py-2.5 bg-slate-900 border border-white/10 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-purple-500"
          />
          <input
            type="text"
            placeholder="Game Name (Optional)"
            value={inputTitle}
            onChange={(e) => setInputTitle(e.target.value)}
            className="w-full sm:w-60 px-4 py-2.5 bg-slate-900 border border-white/10 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-purple-500"
          />
          <button
            type="submit"
            disabled={submitting || !inputMagnet.trim()}
            className="btn btn-primary whitespace-nowrap text-xs"
          >
            {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            <span>Send to Downloader</span>
          </button>
        </form>

        {error && (
          <div className="mt-3 p-3 rounded-lg bg-red-500/15 border border-red-500/30 text-xs text-red-300">
            {error}
          </div>
        )}
      </div>

      {/* Queue Items */}
      <div className="space-y-3">
        <h2 className="font-heading font-bold text-base text-white flex items-center gap-2 mb-2">
          <Clock className="w-4 h-4 text-cyan-400" />
          <span>Active & Recent Transfers ({downloads.length})</span>
        </h2>

        {downloads.length === 0 ? (
          <div className="text-center py-16 glass-panel rounded-2xl border border-white/5 text-slate-500 text-xs">
            No active downloads. Add a magnet link above or pick a featured game in Discover.
          </div>
        ) : (
          downloads.map((item) => {
            const isCompleted = item.status === 'completed' || item.stage === 'completed';
            const isError = item.status === 'error';
            const isDownloading = item.stage === 'downloading';
            const isUploading = item.stage === 'uploading';

            return (
              <div
                key={item.id}
                className="glass-panel p-4 flex flex-col gap-3 border border-white/5 hover:border-white/15 transition-all"
              >
                <div className="flex items-center justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="font-heading font-bold text-sm text-white truncate">{item.title}</h3>
                      {item.kind === 'game-torrent' && (
                        <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-pink-500/15 text-pink-300 border border-pink-500/30 shrink-0">Repack</span>
                      )}
                      {item.kind === 'game-direct' && (
                        <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 shrink-0">Direct</span>
                      )}
                      <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${
                        isCompleted
                          ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                          : isError
                          ? 'bg-red-500/20 text-red-400 border border-red-500/30'
                          : isUploading
                          ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30'
                          : 'bg-purple-500/20 text-purple-300 border border-purple-500/30'
                      }`}>
                        {item.stage === 'queued' ? (item.queuePosition ? `Queued #${item.queuePosition}` : 'Queued') : (item.stage || item.status)}
                      </span>
                    </div>

                    <div className="flex items-center gap-4 text-[11px] text-slate-400 mt-1">
                      {isDownloading && (
                        <>
                          <span>Speed: {item.downloadSpeed ? `${(item.downloadSpeed / 1024 / 1024).toFixed(1)} MB/s` : '0 MB/s'}</span>
                          <span>Peers: {item.numPeers || 0}</span>
                        </>
                      )}
                      {isUploading && (
                        <span className="flex items-center gap-1 text-cyan-300">
                          <HardDrive className="w-3 h-3" />
                          <span>Uploading to Google Drive Games folder...</span>
                        </span>
                      )}
                      {isCompleted && (
                        <span className="text-emerald-400 font-medium">Successfully saved to your Google Drive</span>
                      )}
                      {isError && (
                        <span className="text-red-400">{item.error || 'Transfer failed'}</span>
                      )}
                    </div>
                  </div>

                  {!isCompleted && !isError && (
                    <button
                      onClick={() => handleCancel(item.id)}
                      className="icon-btn icon-btn-sm danger"
                      title="Cancel download"
                    >
                      <XCircle className="w-4 h-4" />
                    </button>
                  )}
                </div>

                {/* Progress Bar */}
                {!isCompleted && !isError && (
                  <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
                    <div
                      className={`h-full transition-all duration-300 ${
                        isUploading ? 'bg-cyan-400' : 'bg-purple-500'
                      }`}
                      style={{
                        width: `${isUploading ? item.uploadPercent || 50 : item.downloadPercent || 5}%`
                      }}
                    />
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
