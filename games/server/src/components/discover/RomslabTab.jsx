import React, { useState, useEffect, useCallback } from 'react';
import {
  Gamepad2, Search, Download, Rss, RefreshCw, Layers, ExternalLink,
  Copy, Check, HardDrive, Sparkles, AlertCircle, X, ShieldAlert
} from 'lucide-react';
import { fetchJson } from '../../utils/api';
import { JobStatusBanner, Grid } from './shared';

const PLATFORM_FILTERS = [
  { key: '', label: 'All Systems' },
  { key: 'switch', label: 'Nintendo Switch' },
  { key: 'switch 2', label: 'Switch 2' },
  { key: 'playstation', label: 'PlayStation' },
];

export default function RomslabTab({ onDownloadDispatched }) {
  const [feed, setFeed] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchInput, setSearchInput] = useState('');
  const [activeQuery, setActiveQuery] = useState('');
  const [selectedPlatform, setSelectedPlatform] = useState('');
  const [status, setStatus] = useState(null);

  // Link inspector modal state
  const [inspectItem, setInspectItem] = useState(null);
  const [scraping, setScraping] = useState(false);
  const [scrapedData, setScrapedData] = useState(null);
  const [copiedId, setCopiedId] = useState(null);
  const [queueingId, setQueueingId] = useState(null);

  const loadFeed = useCallback(async (query = '', platform = '', force = false) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (query) params.set('q', query);
      if (platform) params.set('platform', platform);
      if (force) params.set('refresh', 'true');
      const qs = params.toString() ? `?${params.toString()}` : '';
      const data = await fetchJson(`/api/romslab/feed${qs}`);
      setFeed(data.feed);
    } catch (err) {
      setError(err.message || 'Failed to load Romslab feed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadFeed(activeQuery, selectedPlatform);
  }, [loadFeed, activeQuery, selectedPlatform]);

  const handleSearch = (e) => {
    e.preventDefault();
    const q = searchInput.trim();
    setActiveQuery(q);
    loadFeed(q, selectedPlatform);
  };

  const handlePlatformChange = (platKey) => {
    setSelectedPlatform(platKey);
    loadFeed(activeQuery, platKey);
  };

  const openLinksModal = async (item) => {
    setInspectItem(item);
    setScrapedData(null);
    setScraping(true);
    try {
      const data = await fetchJson(`/api/romslab/scrape?url=${encodeURIComponent(item.link)}`);
      setScrapedData(data);
    } catch (err) {
      setError('Failed to scrape download links: ' + err.message);
    } finally {
      setScraping(false);
    }
  };

  const closeLinksModal = () => {
    setInspectItem(null);
    setScrapedData(null);
    setScraping(false);
    setCopiedId(null);
    setQueueingId(null);
  };

  const handleCopyLink = (linkId, url) => {
    navigator.clipboard?.writeText(url);
    setCopiedId(linkId);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleQueueToDrive = async (link, item) => {
    setQueueingId(link.id || link.url);
    try {
      const res = await fetchJson('/api/romslab/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: link.url,
          title: item.cleanTitle || item.title,
          platform: item.platform || 'Nintendo Switch'
        })
      });
      setStatus({ type: 'ok', message: res.message || `Queued "${item.cleanTitle || item.title}" to Google Drive` });
      if (onDownloadDispatched) onDownloadDispatched(res.job);
    } catch (err) {
      setStatus({ type: 'err', message: err.message || 'Failed to queue download' });
    } finally {
      setQueueingId(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Search + controls bar */}
      <div className="flex flex-col md:flex-row md:items-center gap-3">
        <form onSubmit={handleSearch} className="flex gap-2 flex-1">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-zinc-500 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              placeholder='Search Romslab (e.g. "Zelda", "Pokemon", "Mario", "Metroid")...'
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="workstation-search-input w-full pl-10 pr-4 py-2 rounded-sm text-sm text-white placeholder-zinc-500 focus:outline-none transition-colors"
            />
          </div>
          <button type="submit" className="btn btn-primary">Search</button>
        </form>
        <button
          onClick={() => loadFeed(activeQuery, selectedPlatform, true)}
          disabled={loading}
          className="btn btn-secondary whitespace-nowrap"
          title="Refresh feed"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          <span>Refresh</span>
        </button>
      </div>

      {/* Platform Filter Pills */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {PLATFORM_FILTERS.map(pf => (
          <button
            key={pf.key}
            onClick={() => handlePlatformChange(pf.key)}
            className={`px-3 py-1 text-xs rounded-sm transition-colors border font-mono ${
              selectedPlatform === pf.key
                ? 'bg-[#31a8ff]/20 text-[#31a8ff] border-[#31a8ff]/50 font-bold'
                : 'bg-[#222222] text-slate-400 border-[#383838] hover:text-white hover:border-slate-500'
            }`}
          >
            {pf.label}
          </button>
        ))}
      </div>

      {feed && (
        <div className="flex items-center gap-2 text-[11px] text-slate-500">
          <Rss className="w-3.5 h-3.5 text-emerald-400" />
          <span className="font-semibold text-slate-400">{feed.title}</span>
          <span>• {feed.itemsCount} releases</span>
        </div>
      )}

      {/* Info Banner */}
      <div className="glass-panel p-4 flex flex-col sm:flex-row sm:items-center gap-3 border border-emerald-500/20 bg-emerald-500/5">
        <div className="flex-1 text-xs text-slate-300 leading-relaxed">
          Nintendo Switch &amp; Console ROMs from <span className="font-semibold text-white">Romslab</span>.
          Download base game, updates, and DLC packages straight via Freeplay Downloader, queue to Google Drive, or copy direct mirror links.
        </div>
        <a
          href="/FreeplayDownloader-Setup.exe"
          download
          className="btn btn-primary btn-xs whitespace-nowrap text-center"
        >
          <Download className="w-3.5 h-3.5" />
          <span>Freeplay Downloader</span>
        </a>
      </div>

      <JobStatusBanner status={status} onClear={() => setStatus(null)} />
      {error && (
        <JobStatusBanner status={{ type: 'err', message: error }} onClear={() => setError(null)} />
      )}

      {/* Items Grid */}
      {loading ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3 text-slate-400">
          <div className="w-10 h-10 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm">Fetching releases from Romslab...</p>
        </div>
      ) : (
        <Grid empty={!loading && (!feed || feed.items.length === 0) ? 'No releases found for this filter/search.' : ''}>
          {(feed?.items || []).map((item) => {
            return (
              <div key={item.id} className="game-card group flex flex-col justify-between">
                <div className="game-card-poster">
                  {item.thumbnail ? (
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
                    <Gamepad2 className="w-8 h-8 text-slate-700" />
                  )}
                  <span className="badge-mint badge-top-right !bg-emerald-600/90 !text-white">
                    {item.platform || 'SWITCH'}
                  </span>
                  {item.isUpdate && (
                    <span className="badge-update badge-top-left">UPDATE</span>
                  )}
                </div>

                <div className="game-card-meta flex-1 flex flex-col">
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
                      className="text-[10px] text-emerald-400 hover:text-emerald-300 transition font-semibold ml-auto flex items-center gap-1"
                    >
                      Post <ExternalLink className="w-2.5 h-2.5" />
                    </a>
                  </div>

                  <div className="pt-2 mt-auto flex flex-col gap-1.5">
                    <button
                      type="button"
                      onClick={() => openLinksModal(item)}
                      className="btn btn-primary btn-xs w-full text-center"
                      title="Inspect and get download links & mirrors"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>Get Links &amp; Mirrors</span>
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </Grid>
      )}

      {/* Links & Mirrors Modal */}
      {inspectItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-fade-in">
          <div
            className="glass-panel w-full max-w-2xl bg-[#1c1c1c] border border-[#383838] rounded-md shadow-2xl flex flex-col max-h-[85vh] overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between p-4 border-b border-[#2d2d2d] bg-[#222222]">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="w-8 h-8 rounded bg-emerald-500/20 text-emerald-400 flex items-center justify-center shrink-0">
                  <Gamepad2 className="w-4 h-4" />
                </div>
                <div className="min-w-0">
                  <h3 className="font-bold text-sm text-white truncate">
                    {inspectItem.cleanTitle || inspectItem.title}
                  </h3>
                  <div className="flex items-center gap-2 text-xs text-slate-400 font-mono">
                    <span className="text-emerald-400">{inspectItem.platform || 'Nintendo Switch'}</span>
                    <span>•</span>
                    <a
                      href={inspectItem.link}
                      target="_blank"
                      rel="noreferrer"
                      className="text-slate-400 hover:text-white flex items-center gap-1"
                    >
                      Romslab Post <ExternalLink className="w-2.5 h-2.5" />
                    </a>
                  </div>
                </div>
              </div>
              <button
                onClick={closeLinksModal}
                className="w-8 h-8 rounded flex items-center justify-center text-slate-400 hover:text-white hover:bg-white/10 transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-4 overflow-y-auto space-y-4">
              {scraping ? (
                <div className="flex flex-col items-center justify-center py-12 gap-3 text-slate-400">
                  <div className="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
                  <p className="text-xs">Scraping download links &amp; mirrors from Romslab...</p>
                </div>
              ) : scrapedData ? (
                <>
                  {/* Game Details Summary */}
                  <div className="flex gap-4 p-3 bg-black/30 rounded border border-white/5">
                    {scrapedData.coverImage && (
                      <img
                        src={`/api/proxy-image?url=${encodeURIComponent(scrapedData.coverImage)}`}
                        alt=""
                        className="w-16 h-22 object-cover rounded shadow border border-white/10 shrink-0"
                        onError={(e) => { e.currentTarget.style.display = 'none'; }}
                      />
                    )}
                    <div className="flex-1 min-w-0 text-xs space-y-1">
                      {scrapedData.genres && (
                        <div><span className="text-slate-500 font-mono">Genres:</span> <span className="text-slate-300">{scrapedData.genres}</span></div>
                      )}
                      {scrapedData.developer && (
                        <div><span className="text-slate-500 font-mono">Developer:</span> <span className="text-slate-300">{scrapedData.developer}</span></div>
                      )}
                      {scrapedData.publisher && (
                        <div><span className="text-slate-500 font-mono">Publisher:</span> <span className="text-slate-300">{scrapedData.publisher}</span></div>
                      )}
                      {scrapedData.releaseDate && (
                        <div><span className="text-slate-500 font-mono">Released:</span> <span className="text-slate-300">{scrapedData.releaseDate}</span></div>
                      )}
                    </div>
                  </div>

                  {/* Scraped Links */}
                  <div className="space-y-2">
                    <div className="text-xs font-mono font-bold text-slate-400 uppercase tracking-wider">
                      Available Downloads ({scrapedData.links?.length || 0})
                    </div>

                    {(!scrapedData.links || scrapedData.links.length === 0) ? (
                      <div className="text-center py-6 text-xs text-slate-400 bg-white/5 rounded">
                        No direct download buttons found on this Romslab post.
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {scrapedData.links.map((link) => {
                          const isBase = link.type === 'base';
                          const isUpdate = link.type === 'update';
                          const isDlc = link.type === 'dlc';
                          const badgeColor = isBase
                            ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
                            : isUpdate
                            ? 'bg-blue-500/20 text-blue-300 border-blue-500/30'
                            : isDlc
                            ? 'bg-purple-500/20 text-purple-300 border-purple-500/30'
                            : 'bg-amber-500/20 text-amber-300 border-amber-500/30';

                          const isCopied = copiedId === link.id;
                          const isQueueing = queueingId === (link.id || link.url);

                          return (
                            <div
                              key={link.id}
                              className="p-3 bg-[#242424] border border-[#333333] rounded flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:border-slate-500 transition"
                            >
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2 mb-1 flex-wrap">
                                  <span className={`text-[10px] font-mono px-2 py-0.5 rounded border uppercase font-bold ${badgeColor}`}>
                                    {link.label}
                                  </span>
                                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-black/40 text-slate-400 border border-white/5">
                                    {link.hoster}
                                  </span>
                                </div>
                                <div className="text-xs text-slate-200 font-medium truncate" title={link.filename}>
                                  {link.filename}
                                </div>
                                <div className="text-[11px] text-slate-500 font-mono truncate" title={link.url}>
                                  {link.url}
                                </div>
                              </div>

                              <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
                                {/* Freeplay Downloader deep link */}
                                <a
                                  href={`freeplayDL://download?url=${encodeURIComponent(link.url)}&title=${encodeURIComponent(scrapedData.cleanTitle || inspectItem.title)}`}
                                  className="btn btn-primary btn-xs flex items-center gap-1"
                                  title="Send to Freeplay Downloader"
                                >
                                  <Download className="w-3 h-3" />
                                  <span>Downloader</span>
                                </a>

                                {/* Queue to Google Drive (Downloader node) */}
                                <button
                                  type="button"
                                  onClick={() => handleQueueToDrive(link, scrapedData)}
                                  disabled={isQueueing}
                                  className="btn btn-secondary btn-xs flex items-center gap-1"
                                  title="Queue direct download into your Google Drive"
                                >
                                  <HardDrive className={`w-3 h-3 ${isQueueing ? 'animate-spin' : ''}`} />
                                  <span>{isQueueing ? 'Queueing...' : 'To Drive'}</span>
                                </button>

                                {/* Copy Link */}
                                <button
                                  type="button"
                                  onClick={() => handleCopyLink(link.id, link.url)}
                                  className="btn btn-secondary btn-xs"
                                  title="Copy URL"
                                >
                                  {isCopied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                                </button>

                                {/* Open Link */}
                                <a
                                  href={link.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="btn btn-secondary btn-xs"
                                  title="Open in new tab"
                                >
                                  <ExternalLink className="w-3 h-3" />
                                </a>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="text-center py-8 text-xs text-slate-400">
                  Unable to load details.
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="p-3 border-t border-[#2d2d2d] bg-[#222222] flex items-center justify-between text-[11px] text-slate-400">
              <span className="font-mono">Tip: DataNodes links require an interactive browser or Freeplay Downloader</span>
              <button onClick={closeLinksModal} className="btn btn-secondary btn-xs">
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
