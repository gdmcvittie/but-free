import React, { useState, useEffect, useCallback } from 'react';
import { Loader2, Check, Search, RefreshCw, Flame, Download } from 'lucide-react';
import { fetchJson } from '../../utils/api';
import { useAddJob, JobStatusBanner, LinksModal, Grid } from './shared';

export default function PopularTab({ onDownloadDispatched }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [checking, setChecking] = useState(false);
  const [filter, setFilter] = useState('');

  const [linksModal, setLinksModal] = useState(null);
  const [repackBusyId, setRepackBusyId] = useState(null);

  const { add, busyId, doneIds, status, setStatus } = useAddJob(onDownloadDispatched);

  const loadPopular = useCallback(async (force = false) => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchJson(`/api/pc/popular${force ? '?refresh=true' : ''}`);
      setItems(data.items || []);
    } catch (err) {
      setError(err.message || 'Failed to load popular releases');
    } finally {
      setLoading(false);
    }
  }, []);

  // Batch-check FitGirl availability for all titles
  const runFitgirlCheck = useCallback(async (list) => {
    if (!list.length) return;
    setChecking(true);
    try {
      const data = await fetchJson('/api/pc/check-fitgirl-batch', {
        method: 'POST',
        body: JSON.stringify({ titles: list.map(i => i.title) })
      });
      setItems((prev) => prev.map(it => {
        const r = data.results?.[it.title];
        if (!r) return it;
        return {
          ...it,
          fitgirlAvailable: r.available,
          fitgirlMatchTitle: r.matchTitle || null,
          fitgirlLink: r.matchLink || null
        };
      }));
    } catch (err) {
      setError(`FitGirl availability check failed: ${err.message}`);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    loadPopular();
  }, [loadPopular]);

  useEffect(() => {
    if (items.length > 0 && items.some(i => i.fitgirlAvailable === undefined)) {
      runFitgirlCheck(items.filter(i => i.fitgirlAvailable === undefined));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length]);

  const findRepack = async (item) => {
    setRepackBusyId(item.appId);
    setError(null);
    try {
      let link = item.fitgirlLink;
      if (!link) {
        const check = await fetchJson(`/api/pc/check-fitgirl?title=${encodeURIComponent(item.title)}`);
        if (!check.available || !check.matchLink) {
          setError(`No FitGirl repack found for "${item.title}" (yet).`);
          return;
        }
        link = check.matchLink;
        setItems((prev) => prev.map(it => it.appId === item.appId
          ? { ...it, fitgirlAvailable: true, fitgirlLink: link, fitgirlMatchTitle: check.matchTitle }
          : it));
      }

      const scrape = await fetchJson(`/api/pc/scrape-links?url=${encodeURIComponent(link)}`);
      setLinksModal({
        pageUrl: link,
        links: (scrape.links || []).map(l => ({ ...l, title }),
        ),
        item: { cleanTitle: item.title }
      });
    } catch (err) {
      setError(err.message || 'Could not load repack mirrors');
    } finally {
      setRepackBusyId(null);
    }
  };

  const pickLink = async (l) => {
    const ok = await add(l.id || l.url, {
      source: l.url,
      title: l.title || linksModal?.item?.cleanTitle || l.filename || 'PC Game',
      console: 'pc'
    });
    if (ok) setLinksModal(null);
  };

  const filtered = items.filter(i => !filter || i.title.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center gap-3">
        <div className="flex items-center gap-2 text-xs text-slate-400 flex-1">
          <Flame className="w-4 h-4 text-amber-400" />
          <span>
            <strong className="text-slate-200">Popular Steam releases</strong> — automatically matched against FitGirl repacks.
            {checking && <span className="text-amber-300 ml-2">Checking repack availability...</span>}
          </span>
        </div>
        <div className="relative">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            placeholder="Filter titles..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="pl-9 pr-3 py-2 bg-slate-900 border border-white/10 rounded-xl text-xs text-white placeholder-slate-500 focus:outline-none focus:border-purple-500 w-48"
          />
        </div>
        <button onClick={() => loadPopular(true)} disabled={loading} className="btn-secondary !py-2 text-xs whitespace-nowrap">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span>Reload</span>
        </button>
      </div>

      <JobStatusBanner status={status} onClear={() => setStatus(null)} />
      {error && <JobStatusBanner status={{ type: 'err', message: error }} onClear={() => setError(null)} />}

      {loading ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3 text-slate-400">
          <div className="w-10 h-10 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm">Scanning Steam for popular & new releases...</p>
        </div>
      ) : (
        <Grid empty={filtered.length === 0 ? 'Nothing came back — try reloading.' : ''}>
          {filtered.map((item) => (
            <div key={item.appId} className="glass-panel overflow-hidden flex flex-col hover:border-purple-500/25 transition">
              <div className="h-[110px] bg-slate-900 overflow-hidden relative">
                {item.thumbnail && (
                  <img src={item.thumbnail} alt="" className="w-full h-full object-cover" loading="lazy" />
                )}
                {item.fitgirlAvailable === true && (
                  <span className="absolute top-2 right-2 text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/25 border border-emerald-500/40 text-emerald-300 flex items-center gap-1">
                    <Check className="w-3 h-3" /> Repack available
                  </span>
                )}
                {item.fitgirlAvailable === false && (
                  <span className="absolute top-2 right-2 text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-800/80 border border-white/10 text-slate-400">
                    No repack yet
                  </span>
                )}
              </div>
              <div className="p-4 flex-1 flex flex-col">
                <h3 className="font-heading font-bold text-[13px] text-white leading-snug line-clamp-2">{item.title}</h3>
                <div className="mt-auto pt-3 flex items-center gap-2">
                  <button
                    onClick={() => findRepack(item)}
                    disabled={repackBusyId === item.appId || doneIds.has(item.appId)}
                    className={`px-3 py-1.5 rounded-lg text-[11px] font-bold flex items-center gap-1.5 transition ${
                      doneIds.has(item.appId)
                        ? 'bg-emerald-600/20 text-emerald-400 border border-emerald-500/30 cursor-default'
                        : 'bg-purple-600 hover:bg-purple-500 text-white'
                    }`}
                  >
                    {repackBusyId === item.appId
                      ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      : <Download className="w-3.5 h-3.5" />}
                    <span>{item.fitgirlAvailable === false ? 'Re-check repack' : 'Get Repack'}</span>
                  </button>
                  <a
                    href={item.link}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[11px] text-slate-500 hover:text-purple-300 transition font-semibold ml-auto"
                  >
                    Steam ↗
                  </a>
                </div>
              </div>
            </div>
          ))}
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
    </div>
  );
}
