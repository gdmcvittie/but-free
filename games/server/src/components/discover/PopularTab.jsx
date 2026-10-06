import React, { useState, useEffect, useCallback } from 'react';
import { Loader2, Check, Search, RefreshCw, Flame, Download } from 'lucide-react';
import { fetchJson } from '../../utils/api';
import { useAddJob, JobStatusBanner, LinksModal, FuckingFastAssistModal, Grid } from './shared';

export default function PopularTab({ onDownloadDispatched }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [checking, setChecking] = useState(false);
  const [filter, setFilter] = useState('');
  const [onlyRepacks, setOnlyRepacks] = useState(false);

  const [linksModal, setLinksModal] = useState(null);
  const [repackBusyId, setRepackBusyId] = useState(null);

  const { add, addBatch, busyId, doneIds, status, setStatus, ffAssist, setFfAssist } = useAddJob(onDownloadDispatched);

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
        links: (scrape.links || []).map(l => ({ ...l, title: l.title || item.title })),
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

  const repackCount = items.filter(i => i.fitgirlAvailable === true).length;

  const filtered = items.filter(i => {
    if (onlyRepacks && i.fitgirlAvailable !== true) return false;
    if (filter && !i.title.toLowerCase().includes(filter.toLowerCase())) return false;
    return true;
  });

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

        {/* Repack Availability Filter Toggle */}
        <button
          type="button"
          onClick={() => setOnlyRepacks((prev) => !prev)}
          className={`steam-repack-filter-btn ${onlyRepacks ? 'active' : ''}`}
          title="Only show games with an available FitGirl repack"
        >
          <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center transition-all ${
            onlyRepacks ? 'bg-emerald-500 border-emerald-400 text-white' : 'border-slate-500 bg-transparent'
          }`}>
            {onlyRepacks && <Check className="w-3 h-3 stroke-[3.5]" />}
          </span>
          <span>Repack Available Only</span>
          {repackCount > 0 && (
            <span className="steam-repack-count-badge">{repackCount}</span>
          )}
        </button>

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
        <button onClick={() => loadPopular(true)} disabled={loading} className="btn btn-secondary btn-sm whitespace-nowrap">
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
        <Grid empty={
          filtered.length === 0
            ? (onlyRepacks
                ? 'No Steam games with available repacks match your criteria.'
                : 'Nothing came back — try reloading.')
            : ''
        }>
          {filtered.map((item) => {
            const hasRepack = item.fitgirlAvailable === true;
            return (
              <div
                key={item.appId}
                className={`game-card group ${hasRepack ? 'has-fitgirl' : ''}`}
              >
                <div className="game-card-poster">
                  {item.thumbnail && (
                    <img
                      src={item.thumbnail}
                      alt=""
                      loading="lazy"
                    />
                  )}
                  {hasRepack && (
                    <span className="badge-mint badge-top-right">
                      <Check className="w-3 h-3 stroke-[3.5]" />
                      <span>Repack</span>
                    </span>
                  )}
                  {item.fitgirlAvailable === false && (
                    <span className="badge-no-repack badge-top-right">
                      No repack
                    </span>
                  )}
                </div>
              <div className="game-card-meta">
                <div className="game-card-title" title={item.title}>{item.title}</div>
                <div className="game-card-sub">
                  <span>Steam Release</span>
                  <a
                    href={item.link}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="text-[10px] text-purple-400 hover:text-purple-300 transition font-semibold"
                  >
                    Steam ↗
                  </a>
                </div>
                <div className="pt-1 mt-auto">
                  <button
                    onClick={() => findRepack(item)}
                    disabled={repackBusyId === item.appId || doneIds.has(item.appId)}
                    className={`btn btn-xs w-full ${
                      doneIds.has(item.appId)
                        ? 'bg-emerald-600/20 text-emerald-400 border border-emerald-500/30 cursor-default'
                        : 'btn-primary'
                    }`}
                  >
                    {repackBusyId === item.appId
                      ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      : <Download className="w-3.5 h-3.5" />}
                    <span>{item.fitgirlAvailable === false ? 'Re-check' : 'Get Repack'}</span>
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
          itemTitle={linksModal.item?.cleanTitle || linksModal.item?.title}
          links={linksModal.links}
          busyId={busyId}
          doneIds={doneIds}
          onPick={pickLink}
          onAddBatch={(batchItems, title) => addBatch(batchItems, title || linksModal.item?.cleanTitle)}
        />
      )}

      <FuckingFastAssistModal assist={ffAssist} onClose={() => setFfAssist(null)} />
    </div>
  );
}
