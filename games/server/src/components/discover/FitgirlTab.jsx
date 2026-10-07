import React, { useState, useEffect, useCallback } from 'react';
import {
  Layers, Search, Download, Rss, RefreshCw
} from 'lucide-react';
import { fetchJson } from '../../utils/api';
import { JobStatusBanner, Grid } from './shared';

const DEFAULT_FEED = 'https://fitgirl-repacks.site/feed/';

export default function FitgirlTab({ onDownloadDispatched }) {
  const [feed, setFeed] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchInput, setSearchInput] = useState('');
  const [activeFeedUrl, setActiveFeedUrl] = useState(DEFAULT_FEED);

  const [status, setStatus] = useState(null);

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

      <div className="glass-panel p-4 flex flex-col sm:flex-row sm:items-center gap-3 border border-cyan-500/20 bg-cyan-500/5">
        <div className="flex-1 text-xs text-slate-300 leading-relaxed">
          PC game downloads are handled by the <span className="font-semibold text-white">Freeplay Downloader</span> desktop app.
          Install it once, then hit <span className="font-semibold text-white">Download</span> on any release below.
        </div>
        <a
          href="/FreeplayDownloader-Setup.exe"
          download
          className="btn btn-primary btn-xs whitespace-nowrap text-center"
        >
          <Download className="w-3.5 h-3.5" />
          <span>Download FreeplayDownloader-Setup.exe</span>
        </a>
      </div>

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
                    {item.size && (
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 border border-white/5 shrink-0">
                        {item.size}
                      </span>
                    )}
                    <a
                      href={item.link}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="text-[10px] text-pink-400 hover:text-pink-300 transition font-semibold ml-auto"
                    >
                      Post ↗
                    </a>
                  </div>

                  <div className="pt-1 mt-auto flex flex-col gap-1.5">
                    <a
                      href={`freeplayDL://${item.link}`}
                      className="btn btn-primary btn-xs w-full text-center"
                      title="Send this release to the Freeplay Downloader app"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>Download</span>
                    </a>
                  </div>
                </div>
              </div>
            );
          })}
        </Grid>
      )}

    </div>
  );
}
