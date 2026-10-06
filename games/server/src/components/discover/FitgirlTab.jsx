import React, { useState, useEffect, useCallback } from 'react';
import {
  Magnet, Layers, Search, Loader2, Download, Check, FileArchive,
  Rss, RefreshCw, ListChecks, ArrowRight
} from 'lucide-react';
import { fetchJson } from '../../utils/api';
import { useAddJob, JobStatusBanner, LinksModal, TorrentFilesModal, Grid } from './shared';

const DEFAULT_FEED = 'https://fitgirl-repacks.site/feed/';

export default function FitgirlTab({ onDownloadDispatched }) {
  const [feed, setFeed] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchInput, setSearchInput] = useState('');
  const [activeFeedUrl, setActiveFeedUrl] = useState(DEFAULT_FEED);

  const [linksModal, setLinksModal] = useState(null); // {pageUrl, links, item}
  const [filesModal, setFilesModal] = useState(null); // {inspect, item, source}
  const [inspectingId, setInspectingId] = useState(null);

  const { add, busyId, doneIds, status, setStatus } = useAddJob(onDownloadDispatched);

  const loadFeed = useCallback(async (url) => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchJson(`/api/pc/feed?url=${encodeURIComponent(url)}`);
      setFeed(data.feed);
    } catch (err) {
      setError(err.message || 'Failed to load feed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadFeed(DEFAULT_FEED);
  }, [loadFeed]);

  const handleSearch = (e) => {
    e.preventDefault();
    const q = searchInput.trim();
    if (!q) {
      setActiveFeedUrl(DEFAULT_FEED);
      loadFeed(DEFAULT_FEED);
      return;
    }
    const url = `https://fitgirl-repacks.site/feed/?s=${encodeURIComponent(q)}`;
    setActiveFeedUrl(url);
    loadFeed(url);
  };

  const openMirrors = (item) => {
    setLinksModal({ pageUrl: item.link, links: item.downloads || [], item });
  };

  const pickLink = async (l) => {
    const item = linksModal?.item;
    const ok = await add(l.id || l.url, {
      source: l.url,
      title: item?.cleanTitle || item?.title || l.filename || 'PC Game',
      console: 'pc'
    });
    if (ok) setLinksModal(null);
  };

  const inspectMagnet = async (item) => {
    if (!item.magnetUrl) return;
    setInspectingId(item.id);
    setError(null);
    try {
      const inspect = await fetchJson('/api/pc/inspect', {
        method: 'POST',
        body: JSON.stringify({ url: item.magnetUrl })
      });
      setFilesModal({ inspect, item });
    } catch (err) {
      setError(`Inspect failed: ${err.message}`);
    } finally {
      setInspectingId(null);
    }
  };

  const confirmFiles = async (selectedFiles) => {
    const { inspect, item } = filesModal;
    const allSelected = selectedFiles.length === (inspect.files || []).length;
    const ok = await add(`files_${item.id}`, {
      source: item.magnetUrl,
      title: item.cleanTitle || item.title,
      console: 'pc',
      selectedFiles: allSelected ? undefined : selectedFiles
    });
    if (ok) setFilesModal(null);
  };

  return (
    <div className="space-y-6">
      {/* Search + feed bar */}
      <div className="flex flex-col md:flex-row md:items-center gap-3">
        <form onSubmit={handleSearch} className="flex gap-2 flex-1">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              placeholder='Search FitGirl repacks (e.g. "GTA V")...'
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 bg-slate-900 border border-white/10 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-purple-500 transition-colors"
            />
          </div>
          <button type="submit" className="btn-primary !py-2.5 text-sm">Search</button>
        </form>
        <button
          onClick={() => loadFeed(activeFeedUrl)}
          disabled={loading}
          className="btn-secondary !py-2.5 text-sm whitespace-nowrap"
          title="Refresh feed"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          <span>Refresh</span>
        </button>
      </div>

      {feed && (
        <div className="flex items-center gap-2 text-[11px] text-slate-500">
          <Rss className="w-3.5 h-3.5 text-pink-400" />
          <span className="font-semibold text-slate-400">{feed.title}</span>
          <span>• {feed.itemsCount} releases</span>
        </div>
      )}

      <JobStatusBanner status={status} onClear={() => setStatus(null)} />
      {error && (
        <JobStatusBanner status={{ type: 'err', message: error }} onClear={() => setError(null)} />
      )}

      {/* Items */}
      {loading ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3 text-slate-400">
          <div className="w-10 h-10 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm">Fetching the repack feed...</p>
        </div>
      ) : (
        <Grid empty={!loading && (!feed || feed.items.length === 0) ? 'No releases found for this feed/search.' : ''}>
          {(feed?.items || []).map((item) => {
            const key = item.id;
            const queued = doneIds.has(key) || doneIds.has(`files_${key}`) || busyId === key;
            return (
              <div key={item.id} className="glass-panel p-4 flex flex-col gap-3 hover:border-purple-500/25 transition">
                <div className="flex gap-3.5">
                  <div className="w-[84px] h-[118px] rounded-lg bg-slate-900 border border-white/5 overflow-hidden flex items-center justify-center shrink-0">
                    {item.thumbnail && !item.isVideoThumbnail ? (
                      <img src={`/api/proxy-image?url=${encodeURIComponent(item.thumbnail)}`} alt="" className="w-full h-full object-cover" loading="lazy" />
                    ) : (
                      <Layers className="w-7 h-7 text-slate-700" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 flex-wrap mb-1">
                      <span className="badge-fitgirl">FitGirl</span>
                      {item.isUpdate && (
                        <span className="badge-console" style={{ background: 'rgba(245,158,11,0.2)', color: '#fcd34d', border: '1px solid rgba(245,158,11,0.35)' }}>UPDATE</span>
                      )}
                      {item.hasMagnet && <span className="text-[10px] text-slate-500 font-semibold">MAGNET</span>}
                    </div>
                    <h3 className="font-heading font-bold text-[13px] text-white leading-snug line-clamp-2">
                      {item.cleanTitle || item.title}
                    </h3>
                    <p className="text-[10px] text-slate-500 mt-1">{(item.pubDate || '').replace(/GMT.*/, '').trim()}</p>
                    <p className="text-[11px] text-slate-400 mt-1.5 line-clamp-3 leading-relaxed">{item.excerpt}</p>
                  </div>
                </div>

                <div className="flex items-center gap-2 pt-1 border-t border-white/5">
                  {item.hasMagnet ? (
                    <>
                      <button
                        onClick={() => add(key, { source: item.magnetUrl, title: item.cleanTitle || item.title, console: 'pc' })}
                        disabled={busyId === key || doneIds.has(key)}
                        className={`px-3 py-1.5 rounded-lg text-[11px] font-bold flex items-center gap-1.5 transition ${
                          doneIds.has(key)
                            ? 'bg-emerald-600/20 text-emerald-400 border border-emerald-500/30 cursor-default'
                            : 'bg-purple-600 hover:bg-purple-500 text-white'
                        }`}
                      >
                        {busyId === key ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : doneIds.has(key) ? <Check className="w-3.5 h-3.5" /> : <Magnet className="w-3.5 h-3.5" />}
                        <span>{doneIds.has(key) ? 'Queued' : 'Magnet → Drive'}</span>
                      </button>
                      <button
                        onClick={() => inspectMagnet(item)}
                        disabled={inspectingId === item.id}
                        className="px-2.5 py-1.5 rounded-lg text-[11px] font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 border border-white/10 transition flex items-center gap-1.5"
                        title="Pick files inside the torrent"
                      >
                        {inspectingId === item.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ListChecks className="w-3.5 h-3.5" />}
                        <span>Files</span>
                      </button>
                    </>
                  ) : null}

                  {item.downloads?.length > 0 && (
                    <button
                      onClick={() => openMirrors(item)}
                      className="px-2.5 py-1.5 rounded-lg text-[11px] font-semibold bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-300 border border-cyan-500/30 transition flex items-center gap-1.5"
                    >
                      <FileArchive className="w-3.5 h-3.5" />
                      <span>Mirrors ({item.downloads.length})</span>
                    </button>
                  )}

                  <a
                    href={item.link}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-auto p-1.5 rounded-lg text-slate-500 hover:text-white transition"
                    title="Open original post"
                  >
                    <ArrowRight className="w-4 h-4" />
                  </a>
                </div>
              </div>
            );
          })}
        </Grid>
      )}

      {linksModal && (
        <LinksModal
          open
          onClose={() => setLinksModal(null)}
          pageUrl={linksModal.pageUrl}
          links={linksModal.links}
          busyId={busyId}
          onPick={pickLink}
        />
      )}

      {filesModal && (
        <TorrentFilesModal
          open
          onClose={() => setFilesModal(null)}
          inspect={filesModal.inspect}
          busy={busyId === `files_${filesModal.item.id}`}
          onConfirm={confirmFiles}
        />
      )}
    </div>
  );
}
