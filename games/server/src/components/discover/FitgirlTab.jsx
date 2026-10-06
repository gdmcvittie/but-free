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

  const { add, addBatch, busyId, doneIds, status, setStatus } = useAddJob(onDownloadDispatched);

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

  const openMirrors = async (item) => {
    setLinksModal({
      pageUrl: item.link,
      itemTitle: item.cleanTitle || item.title,
      links: item.downloads || [],
      loading: true,
      item
    });

    try {
      const data = await fetchJson(`/api/pc/scrape-links?url=${encodeURIComponent(item.link)}`);
      setLinksModal((prev) => {
        if (!prev || prev.item?.id !== item.id) return prev;
        return {
          ...prev,
          links: data.links || [],
          loading: false
        };
      });
    } catch (err) {
      setLinksModal((prev) => {
        if (!prev || prev.item?.id !== item.id) return prev;
        return {
          ...prev,
          loading: false,
          error: err.message
        };
      });
    }
  };

  const pickLink = async (l) => {
    const item = linksModal?.item;
    await add(l.id || l.url, {
      source: l.url,
      title: item?.cleanTitle || item?.title || l.filename || 'PC Game',
      filename: l.filename,
      console: 'pc'
    });
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
          <button type="submit" className="btn btn-primary">Search</button>
        </form>
        <button
          onClick={() => loadFeed(activeFeedUrl)}
          disabled={loading}
          className="btn btn-secondary whitespace-nowrap"
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
            return (
              <div key={item.id} className="game-card group">
                <div className="game-card-poster">
                  {item.isVideoThumbnail || (item.thumbnail && item.thumbnail.toLowerCase().includes('.webm')) ? (
                    <video
                      src={`/api/proxy-image?url=${encodeURIComponent(item.thumbnail)}`}
                      autoPlay
                      loop
                      muted
                      playsInline
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                      onError={(e) => {
                        if (!e.currentTarget.dataset.fallback && item.thumbnail) {
                          e.currentTarget.dataset.fallback = '1';
                          e.currentTarget.src = item.thumbnail;
                        }
                      }}
                    />
                  ) : item.thumbnail ? (
                    <img
                      src={`/api/proxy-image?url=${encodeURIComponent(item.thumbnail)}`}
                      alt=""
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                      loading="lazy"
                      onError={(e) => {
                        if (!e.currentTarget.dataset.fallback && item.thumbnail) {
                          e.currentTarget.dataset.fallback = '1';
                          e.currentTarget.src = item.thumbnail;
                        }
                      }}
                    />
                  ) : (
                    <Layers className="w-8 h-8 text-slate-700" />
                  )}
                  <span className="badge-mint badge-top-right">FitGirl</span>
                  {item.isUpdate && (
                    <span className="badge-update badge-top-left">UPDATE</span>
                  )}
                </div>

                <div className="game-card-meta">
                  <div className="game-card-title" title={item.cleanTitle || item.title}>
                    {item.cleanTitle || item.title}
                  </div>
                  <div className="game-card-sub">
                    <span className="truncate">{(item.pubDate || '').replace(/GMT.*/, '').trim()}</span>
                    <a
                      href={item.link}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="text-[10px] text-pink-400 hover:text-pink-300 transition font-semibold"
                    >
                      Post ↗
                    </a>
                  </div>

                  <div className="pt-1 mt-auto flex flex-col gap-1.5">
                    {item.hasMagnet ? (
                      <div className="flex gap-1.5">
                        <button
                          onClick={() => add(key, { source: item.magnetUrl, title: item.cleanTitle || item.title, console: 'pc' })}
                          disabled={busyId === key || doneIds.has(key)}
                          className={`btn btn-xs flex-1 ${
                            doneIds.has(key)
                              ? 'bg-emerald-600/20 text-emerald-400 border border-emerald-500/30 cursor-default'
                              : 'btn-primary'
                          }`}
                        >
                          {busyId === key ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : doneIds.has(key) ? <Check className="w-3.5 h-3.5" /> : <Magnet className="w-3.5 h-3.5" />}
                          <span>{doneIds.has(key) ? 'Queued' : 'Magnet'}</span>
                        </button>
                        <button
                          onClick={() => inspectMagnet(item)}
                          disabled={inspectingId === item.id}
                          className="btn btn-secondary btn-xs"
                          title="Pick files inside torrent"
                        >
                          {inspectingId === item.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ListChecks className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                    ) : null}

                    <button
                      onClick={() => openMirrors(item)}
                      className="btn btn-secondary btn-xs w-full"
                      title="Deep scan webpage for all download mirrors, FuckingFast links & magnets"
                    >
                      <FileArchive className="w-3.5 h-3.5 text-cyan-400" />
                      <span>Mirrors & Links</span>
                    </button>
                  </div>
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
          itemTitle={linksModal.itemTitle || linksModal.item?.cleanTitle || linksModal.item?.title}
          links={linksModal.links}
          loading={linksModal.loading}
          busyId={busyId}
          doneIds={doneIds}
          onPick={pickLink}
          onAddBatch={(batchItems, title) => addBatch(batchItems, title || linksModal.itemTitle)}
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
