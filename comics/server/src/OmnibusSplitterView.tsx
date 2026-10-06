import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { apiUrl } from './api';
import type { Comic } from './Library';
import type { GoogleUserProfile } from './AuthModal';
import { BookOpen, Inbox, ArrowLeft, Folder, Image, PartyPopper, Scissors, Trash2, TriangleAlert } from 'lucide-react';

interface OmnibusSplitterViewProps {
  user: GoogleUserProfile | null;
  onOpenComic?: (comic: Comic) => void;
  onNavigateView?: (view: string) => void;
  onOpenAuthModal?: () => void;
}

/** What the server reports about a candidate archive. */
interface SplitInspectInfo {
  comicId: any;
  title: string;
  item?: string;
  series?: string;
  fileName: string;
  storage: 'drive' | 'local';
  size: number;
  totalPages: number;
  maxVolumes: number;
  plan: SplitPlanEntry[];
}

interface SplitPlanEntry {
  volume: number;
  startPage: number;
  endPage: number;
  pageCount: number;
  fileName: string;
  coverFileName: string;
}

interface SplitVolumeResult {
  volume: number;
  fileName: string;
  coverFileName: string;
  startPage: number;
  endPage: number;
  pageCount: number;
  fileSize: number;
  comic: Comic;
}

interface SplitJobStatus {
  id: string;
  type: string;
  status: 'running' | 'done' | 'error';
  phase: string;
  percent: number;
  volumes: any[];
  result?: {
    sourceComicId: any;
    sourceTitle: string;
    sourceFileName: string;
    series: string;
    totalPages: number;
    volumeCount: number;
    pagesPerVolume: number[];
    totalSize: number;
    volumes: SplitVolumeResult[];
  } | null;
  error?: string | null;
}

/**
 * Quick volume-count shortcuts. Anything else can be typed straight into the
 * field; these just cover the sizes people actually reach for.
 */
const VOLUME_PRESETS = [2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24];

export default function OmnibusSplitterView({
  user,
  onOpenComic,
  onNavigateView,
  onOpenAuthModal
}: OmnibusSplitterViewProps) {
  const [comics, setComics] = useState<Comic[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [selectedSeries, setSelectedSeries] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');

  // The archive being split
  const [sourceComicId, setSourceComicId] = useState<any>(null);
  const [inspect, setInspect] = useState<SplitInspectInfo | null>(null);
  const [inspecting, setInspecting] = useState<boolean>(false);
  const [inspectError, setInspectError] = useState<string>('');

  // Desired output volume count
  const [volumeCount, setVolumeCount] = useState<number>(3);
  const [volumeInput, setVolumeInput] = useState<string>('3');

  // Mobile portrait step tab: 'select' | 'configure'
  const [mobileTab, setMobileTab] = useState<'select' | 'configure'>('select');

  // Split execution & polling state
  const [isSplitting, setIsSplitting] = useState<boolean>(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<SplitJobStatus | null>(null);

  // Completion modal & source cleanup prompt state
  const [showCompletionModal, setShowCompletionModal] = useState<boolean>(false);
  const [deleteSourceState, setDeleteSourceState] = useState<
    'idle' | 'deleting' | 'deleted' | 'kept' | 'error'
  >('idle');
  const [deleteMessage, setDeleteMessage] = useState<string>('');

  const pollingTimerRef = useRef<any>(null);
  const inspectTokenRef = useRef<number>(0);

  // 1. Fetch library comics
  const fetchComics = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch(apiUrl('/api/comics'));
      if (res.ok) {
        const data = await res.json();
        setComics(Array.isArray(data) ? data : []);
      }
    } catch (err) {
      console.warn('[OmnibusSplitter] Failed to fetch comics:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchComics();
  }, [fetchComics]);

  // 2. Discover series list
  const seriesList = useMemo(() => {
    const map = new Map<string, number>();
    comics.forEach((c) => {
      const s = c.series || 'Unsorted';
      map.set(s, (map.get(s) || 0) + 1);
    });
    return Array.from(map.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [comics]);

  // 3. Candidate archives: the biggest books in the library, since those are the
  //    ones worth breaking up. Anything can still be searched for by name.
  const candidates = useMemo(() => {
    const filtered = comics.filter((c) => {
      if (selectedSeries !== 'all' && (c.series || 'Unsorted') !== selectedSeries) {
        return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const matchTitle = (c.title || '').toLowerCase().includes(q);
        const matchItem = (c.item || '').toLowerCase().includes(q);
        const matchSeries = (c.series || '').toLowerCase().includes(q);
        if (!matchTitle && !matchItem && !matchSeries) return false;
      }
      return true;
    });

    return filtered.sort((a, b) => {
      // Largest page count first
      const pagesDiff = (b.totalPages || 0) - (a.totalPages || 0);
      if (pagesDiff !== 0) return pagesDiff;
      return (a.item || a.title || '').localeCompare(b.item || b.title || '', undefined, {
        numeric: true,
        sensitivity: 'base'
      });
    });
  }, [comics, selectedSeries, searchQuery]);

  // 4. Read the true page count of the chosen archive
  useEffect(() => {
    if (sourceComicId === null || sourceComicId === undefined) {
      setInspect(null);
      setInspectError('');
      return;
    }

    const token = ++inspectTokenRef.current;
    setInspecting(true);
    setInspectError('');

    (async () => {
      try {
        const res = await fetch(apiUrl(`/api/omnibus/split/inspect/${sourceComicId}`));
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) {
          throw new Error(data.error || 'Could not read that archive.');
        }
        if (token !== inspectTokenRef.current) return; // superseded by a newer pick

        setInspect(data);
        if (data.totalPages < 2) {
          setInspectError('This archive has fewer than 2 pages, so there is nothing to split.');
        } else {
          // Clamp the desired count into a range that actually produces volumes
          setVolumeCount((prev) => Math.min(Math.max(2, prev), data.maxVolumes));
        }
      } catch (err: any) {
        if (token !== inspectTokenRef.current) return;
        setInspect(null);
        setInspectError(err.message || 'Could not read that archive.');
      } finally {
        if (token === inspectTokenRef.current) setInspecting(false);
      }
    })();
  }, [sourceComicId]);

  // 5. Ask the server for the authoritative volume plan whenever the count changes.
  //    The server owns the even-split math so the preview always matches output.
  const [plan, setPlan] = useState<SplitPlanEntry[]>([]);
  const [planLoading, setPlanLoading] = useState<boolean>(false);

  useEffect(() => {
    if (!inspect || inspect.totalPages < 2) {
      setPlan([]);
      return;
    }

    const clamped = Math.min(Math.max(2, volumeCount), inspect.maxVolumes);
    if (clamped !== volumeCount) {
      setVolumeCount(clamped);
      return;
    }

    let cancelled = false;
    setPlanLoading(true);

    (async () => {
      try {
        const res = await fetch(
          apiUrl(`/api/omnibus/split/inspect/${sourceComicId}?volumes=${clamped}`)
        );
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.ok && Array.isArray(data.plan)) {
          setPlan(data.plan);
        } else {
          setPlan([]);
        }
      } catch (err) {
        if (!cancelled) setPlan([]);
      } finally {
        if (!cancelled) setPlanLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [inspect, volumeCount, sourceComicId]);

  // Reset any stale job output when a different archive is picked
  const selectSource = (comicId: any) => {
    if (String(comicId) === String(sourceComicId)) return;
    setSourceComicId(comicId);
    setJobStatus(null);
    setActiveJobId(null);
    setShowCompletionModal(false);
    setDeleteSourceState('idle');
    setDeleteMessage('');
    setPlan([]);
    setMobileTab('configure');
  };

  const clearSource = () => {
    setSourceComicId(null);
    setInspect(null);
    setPlan([]);
    setJobStatus(null);
    setActiveJobId(null);
    setShowCompletionModal(false);
    setDeleteSourceState('idle');
    setDeleteMessage('');
    setMobileTab('select');
  };

  // Keep the text field in sync while the user types
  const handleVolumeInputChange = (raw: string) => {
    const digits = raw.replace(/[^0-9]/g, '');
    setVolumeInput(digits);
    if (digits === '') return;
    const parsed = parseInt(digits, 10);
    if (Number.isFinite(parsed)) setVolumeCount(parsed);
  };

  const effectiveVolumeCount = useMemo(() => {
    if (!inspect || inspect.totalPages < 2) return 0;
    return Math.min(Math.max(2, volumeCount), inspect.maxVolumes);
  }, [inspect, volumeCount]);

  const canSplit = Boolean(
    inspect && inspect.totalPages >= 2 && plan.length >= 2 && !isSplitting && !planLoading
  );

  // 6. Poll the running split job
  useEffect(() => {
    if (!activeJobId || !isSplitting) return;

    const checkStatus = async () => {
      try {
        const res = await fetch(apiUrl(`/api/omnibus/split/status/${activeJobId}`));
        if (res.ok) {
          const data: SplitJobStatus = await res.json();
          setJobStatus(data);

          if (data.status === 'done') {
            setIsSplitting(false);
            setShowCompletionModal(true);
            setDeleteSourceState('idle');
            if (pollingTimerRef.current) clearInterval(pollingTimerRef.current);
            fetchComics();
          } else if (data.status === 'error') {
            setIsSplitting(false);
            if (pollingTimerRef.current) clearInterval(pollingTimerRef.current);
          }
        }
      } catch (err) {
        console.warn('[OmnibusSplitter] Status poll note:', err);
      }
    };

    checkStatus();
    pollingTimerRef.current = setInterval(checkStatus, 800);

    return () => {
      if (pollingTimerRef.current) clearInterval(pollingTimerRef.current);
    };
  }, [activeJobId, isSplitting, fetchComics]);

  // 7. Start the split
  const handleStartSplit = async () => {
    if (!canSplit || !inspect) return;

    try {
      setIsSplitting(true);
      setDeleteSourceState('idle');
      setDeleteMessage('');
      setJobStatus({
        id: '',
        type: 'split',
        status: 'running',
        phase: 'Starting split job...',
        percent: 0,
        volumes: []
      });

      const res = await fetch(apiUrl('/api/omnibus/split'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          comicId: sourceComicId,
          volumeCount: effectiveVolumeCount
        })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to start the split job.');
      }

      const data = await res.json();
      setActiveJobId(data.jobId || data.job?.id);
    } catch (err: any) {
      alert(`Error starting split: ${err.message}`);
      setIsSplitting(false);
      setJobStatus(null);
    }
  };

  // 8. Delete the original omnibus after the user confirms
  const handleDeleteSource = async () => {
    if (!sourceComicId) return;

    try {
      setDeleteSourceState('deleting');
      const res = await fetch(apiUrl('/api/omnibus/split/delete-source'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comicId: sourceComicId })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to delete the original omnibus.');
      }

      const data = await res.json();
      setDeleteSourceState('deleted');
      setDeleteMessage(
        `Successfully deleted "${inspect?.title || 'the original omnibus'}"${
          data.deletedCount ? ` (${data.deletedCount} file removed)` : ''
        }.`
      );
      fetchComics();
    } catch (err: any) {
      setDeleteSourceState('error');
      setDeleteMessage(err.message || 'Error occurred while deleting the original omnibus.');
    }
  };

  const handleKeepSource = () => {
    setDeleteSourceState('kept');
    setShowCompletionModal(false);
  };

  const sourceComic = useMemo(() => {
    if (sourceComicId === null) return null;
    return comics.find((c) => String(c.id) === String(sourceComicId)) || null;
  }, [comics, sourceComicId]);

  const sizeMb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

  return (
    <div className="omnibus-view-container">
      {/* Top Banner Header */}
      <div style={{ marginBottom: '1.25rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem' }}>
        <div>
          <h1 style={{ fontSize: '1.6rem', fontWeight: 800, color: '#f8fafc', display: 'flex', alignItems: 'center', gap: '0.6rem', margin: 0 }}>
            <span style={{ display: 'inline-flex', marginRight: '0.4rem' }}><Scissors size={30}/></span> Omnibus Splitter
          </h1>
          <p style={{ color: '#94a3b8', fontSize: '0.85rem', margin: '0.25rem 0 0' }}>
            Break a large omnibus into evenly sized volumes, each with its own cover.
          </p>
        </div>

        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {onNavigateView && (
            <button
              type="button"
              onClick={() => onNavigateView('omnibus')}
              style={{
                background: 'rgba(255, 255, 255, 0.08)',
                border: '1px solid rgba(255, 255, 255, 0.15)',
                color: '#f8fafc',
                padding: '0.45rem 0.85rem',
                borderRadius: '8px',
                fontSize: '0.82rem',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              Merge Issues Instead
            </button>
          )}
          {onNavigateView && (
            <button
              type="button"
              onClick={() => onNavigateView('library')}
              style={{
                background: 'rgba(255, 255, 255, 0.08)',
                border: '1px solid rgba(255, 255, 255, 0.15)',
                color: '#f8fafc',
                padding: '0.45rem 0.85rem',
                borderRadius: '8px',
                fontSize: '0.82rem',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              ← Back to Library
            </button>
          )}
        </div>
      </div>

      {/* Mobile Step Switcher Tabs (Visible on screens <= 860px) */}
      <div className="omnibus-mobile-tabs">
        <button
          type="button"
          className={`omnibus-mobile-tab-btn ${mobileTab === 'select' ? 'active' : ''}`}
          onClick={() => setMobileTab('select')}
        >
          <span>1️⃣ Choose Omnibus</span>
          <span
            style={{
              background: mobileTab === 'select' ? 'rgba(255, 255, 255, 0.25)' : 'rgba(255, 255, 255, 0.1)',
              padding: '2px 7px',
              borderRadius: '10px',
              fontSize: '0.72rem'
            }}
          >
            {candidates.length}
          </span>
        </button>

        <button
          type="button"
          className={`omnibus-mobile-tab-btn ${mobileTab === 'configure' ? 'active' : ''}`}
          onClick={() => setMobileTab('configure')}
        >
          <span>2️⃣ Split Settings</span>
          {inspect && (
            <span
              style={{
                background: mobileTab === 'configure' ? 'rgba(255, 255, 255, 0.25)' : '#7c3aed',
                color: '#fff',
                padding: '2px 7px',
                borderRadius: '10px',
                fontSize: '0.72rem'
              }}
            >
              {inspect.totalPages}
            </span>
          )}
        </button>
      </div>

      {/* Main Layout Grid */}
      <div className="omnibus-layout-grid">
        {/* Left Column: Pick the omnibus to split */}
        <div className={`omnibus-column-card omnibus-column-select ${mobileTab === 'select' ? 'active' : ''}`}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
            <h2 style={{ fontSize: '1.15rem', fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span>1️⃣</span> Choose an Omnibus
            </h2>
            {sourceComicId !== null && (
              <button
                type="button"
                onClick={clearSource}
                className="reorder-item-btn remove-btn"
                style={{ width: 'auto', height: 'auto', padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}
              >
                ✕ Clear
              </button>
            )}
          </div>

          <div className="omnibus-filter-row">
            <select
              value={selectedSeries}
              onChange={(e) => setSelectedSeries(e.target.value)}
              style={{
                flex: 1,
                minWidth: '150px',
                background: '#0f172a',
                border: '1px solid #334155',
                color: '#f8fafc',
                padding: '0.55rem 0.8rem',
                borderRadius: '8px',
                fontSize: '0.85rem'
              }}
            >
              <option value="all">All Series ({comics.length})</option>
              {seriesList.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name} ({s.count})
                </option>
              ))}
            </select>

            <input
              type="text"
              placeholder="Filter by title or series..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                flex: 1.2,
                minWidth: '160px',
                background: '#0f172a',
                border: '1px solid #334155',
                color: '#f8fafc',
                padding: '0.55rem 0.8rem',
                borderRadius: '8px',
                fontSize: '0.85rem'
              }}
            />
          </div>

          <div className="omnibus-issue-list-container">
            {loading ? (
              <div style={{ padding: '2rem', textAlign: 'center', color: '#94a3b8' }}>Loading library...</div>
            ) : candidates.length === 0 ? (
              <div style={{ padding: '2.5rem 1rem', textAlign: 'center', color: '#94a3b8' }}>
                <div style={{ marginBottom: '0.5rem' }}><Inbox size={32}/></div>
                No comics found matching the selected filter.
              </div>
            ) : (
              candidates.map((comic) => {
                const isSelected = String(comic.id) === String(sourceComicId);

                return (
                  <div
                    key={comic.id}
                    onClick={() => selectSource(comic.id)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.75rem',
                      padding: '0.6rem 0.75rem',
                      borderRadius: '8px',
                      background: isSelected ? 'rgba(124, 58, 237, 0.18)' : 'rgba(15, 23, 42, 0.5)',
                      border: `1px solid ${isSelected ? '#7c3aed' : '#1e293b'}`,
                      cursor: 'pointer',
                      transition: 'background 0.15s ease, border-color 0.15s ease'
                    }}
                  >
                    <div style={{ width: '38px', height: '54px', borderRadius: '4px', overflow: 'hidden', background: '#0f172a', flexShrink: 0 }}>
                      {comic.coverImage ? (
                        <img
                          src={comic.coverImage}
                          alt=""
                          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                          loading="lazy"
                        />
                      ) : (
                        <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#475569' }}>
                          <BookOpen size={16}/>
                        </div>
                      )}
                    </div>

                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '0.86rem', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: isSelected ? '#c4b5fd' : '#f8fafc' }}>
                        {comic.title}
                      </div>
                      <div style={{ fontSize: '0.74rem', color: '#94a3b8', display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '2px' }}>
                        <span>{comic.item || 'Single Issue'}</span>
                        {comic.totalPages ? <span>• {comic.totalPages} pgs</span> : null}
                        {comic.size ? <span>• {sizeMb(comic.size)} MB</span> : null}
                      </div>
                    </div>

                    {isSelected && (
                      <span
                        style={{
                          background: '#7c3aed',
                          color: '#fff',
                          fontSize: '0.72rem',
                          fontWeight: 800,
                          padding: '2px 7px',
                          borderRadius: '12px',
                          flexShrink: 0
                        }}
                      >
                        Splitting
                      </span>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right Column: Split configuration & volume plan */}
        <div className={`omnibus-column-card omnibus-column-order ${mobileTab === 'configure' ? 'active' : ''}`}>
          <button
            type="button"
            className="omnibus-mobile-back-btn"
            onClick={() => setMobileTab('select')}
            style={{
              display: 'none',
              alignItems: 'center',
              gap: '0.35rem',
              marginBottom: '0.75rem',
              background: 'rgba(124, 58, 237, 0.15)',
              border: '1px solid rgba(124, 58, 237, 0.35)',
              color: '#c4b5fd',
              padding: '0.4rem 0.8rem',
              borderRadius: '8px',
              fontSize: '0.82rem',
              fontWeight: 600,
              cursor: 'pointer'
            }}
          >
            ← Change Omnibus ({candidates.length})
          </button>

          <h2 style={{ fontSize: '1.15rem', fontWeight: 700, margin: '0 0 1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span>2️⃣</span> Split Settings
          </h2>

          {/* Source summary */}
          {inspecting ? (
            <div style={{ padding: '2rem', textAlign: 'center', color: '#94a3b8' }}>Reading archive contents...</div>
          ) : inspectError ? (
            <div style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: '10px', padding: '1rem', color: '#fca5a5', fontSize: '0.85rem', marginBottom: '1rem' }}>
              {inspectError}
            </div>
          ) : !inspect ? (
            <div style={{ padding: '2.5rem 1rem', textAlign: 'center', color: '#64748b', border: '2px dashed #1e293b', borderRadius: '8px' }}>
              <div style={{ marginBottom: '0.4rem' }}><ArrowLeft size={30}/></div>
              Choose an omnibus from the list on the left to read its page count and plan the split.
            </div>
          ) : (
            <>
              {/* Page count readout */}
              <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: '10px', padding: '1rem', marginBottom: '1rem' }}>
                <div style={{ fontSize: '0.7rem', color: '#94a3b8', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '0.6px' }}>
                  Source Archive
                </div>
                <div style={{ fontSize: '0.95rem', fontWeight: 700, color: '#f8fafc', marginTop: '0.3rem', wordBreak: 'break-word' }}>
                  {inspect.title}
                </div>
                <div style={{ fontSize: '0.76rem', color: '#64748b', marginTop: '0.25rem', wordBreak: 'break-all' }}>
                  {inspect.fileName}
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem', marginTop: '0.9rem' }}>
                  <div style={{ background: 'rgba(56, 189, 248, 0.08)', border: '1px solid rgba(56, 189, 248, 0.2)', borderRadius: '8px', padding: '0.5rem', textAlign: 'center' }}>
                    <div style={{ fontSize: '0.64rem', color: '#94a3b8', textTransform: 'uppercase', fontWeight: 700 }}>Pages</div>
                    <div style={{ fontSize: '1.2rem', fontWeight: 800, color: '#38bdf8', fontFamily: 'var(--font-mono, monospace)' }}>
                      {inspect.totalPages}
                    </div>
                  </div>
                  <div style={{ background: 'rgba(124, 58, 237, 0.08)', border: '1px solid rgba(124, 58, 237, 0.25)', borderRadius: '8px', padding: '0.5rem', textAlign: 'center' }}>
                    <div style={{ fontSize: '0.64rem', color: '#94a3b8', textTransform: 'uppercase', fontWeight: 700 }}>Volumes</div>
                    <div style={{ fontSize: '1.2rem', fontWeight: 800, color: '#c4b5fd', fontFamily: 'var(--font-mono, monospace)' }}>
                      {effectiveVolumeCount}
                    </div>
                  </div>
                  <div style={{ background: 'rgba(16, 185, 129, 0.08)', border: '1px solid rgba(16, 185, 129, 0.2)', borderRadius: '8px', padding: '0.5rem', textAlign: 'center' }}>
                    <div style={{ fontSize: '0.64rem', color: '#94a3b8', textTransform: 'uppercase', fontWeight: 700 }}>
                      ~Pages Each
                    </div>
                    <div style={{ fontSize: '1.2rem', fontWeight: 800, color: '#34d399', fontFamily: 'var(--font-mono, monospace)' }}>
                      {plan.length > 0 ? plan[0].pageCount : '—'}
                    </div>
                  </div>
                </div>
              </div>

              {/* Volume count control */}
              <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: '10px', padding: '1rem', marginBottom: '1rem' }}>
                <label
                  htmlFor="split-volume-count"
                  style={{ display: 'block', fontSize: '0.8rem', fontWeight: 700, color: '#94a3b8', marginBottom: '0.4rem' }}
                >
                  Split into how many volumes?
                </label>

                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  <button
                    type="button"
                    onClick={() => handleVolumeInputChange(String(Math.max(2, (parseInt(volumeInput, 10) || 2) - 1)))}
                    disabled={isSplitting || effectiveVolumeCount <= 2}
                    style={{
                      width: '40px',
                      height: '40px',
                      flexShrink: 0,
                      background: 'rgba(255, 255, 255, 0.08)',
                      border: '1px solid #334155',
                      color: '#f8fafc',
                      borderRadius: '8px',
                      fontSize: '1.2rem',
                      fontWeight: 800,
                      cursor: 'pointer'
                    }}
                    aria-label="Fewer volumes"
                  >
                    −
                  </button>

                  <input
                    id="split-volume-count"
                    type="number"
                    min={2}
                    max={inspect.maxVolumes}
                    value={volumeInput}
                    onChange={(e) => handleVolumeInputChange(e.target.value)}
                    disabled={isSplitting}
                    style={{
                      flex: 1,
                      background: '#1e293b',
                      border: '1px solid #334155',
                      color: '#f8fafc',
                      padding: '0.6rem 0.8rem',
                      borderRadius: '8px',
                      fontSize: '1.1rem',
                      fontWeight: 800,
                      textAlign: 'center',
                      boxSizing: 'border-box'
                    }}
                  />

                  <button
                    type="button"
                    onClick={() => handleVolumeInputChange(String((parseInt(volumeInput, 10) || 2) + 1))}
                    disabled={isSplitting || effectiveVolumeCount >= inspect.maxVolumes}
                    style={{
                      width: '40px',
                      height: '40px',
                      flexShrink: 0,
                      background: 'rgba(255, 255, 255, 0.08)',
                      border: '1px solid #334155',
                      color: '#f8fafc',
                      borderRadius: '8px',
                      fontSize: '1.2rem',
                      fontWeight: 800,
                      cursor: 'pointer'
                    }}
                    aria-label="More volumes"
                  >
                    +
                  </button>
                </div>

                <div style={{ fontSize: '0.74rem', color: '#64748b', marginTop: '0.4rem', textAlign: 'center' }}>
                  Between 2 and {inspect.maxVolumes} volumes
                </div>

                {/* Quick presets */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', marginTop: '0.7rem' }}>
                  {VOLUME_PRESETS.filter((n) => n <= inspect.maxVolumes).map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => handleVolumeInputChange(String(n))}
                      disabled={isSplitting}
                      className={`split-preset-btn ${effectiveVolumeCount === n ? 'active' : ''}`}
                    >
                      {n}
                    </button>
                  ))}
                </div>

                <div style={{ marginTop: '0.9rem', fontSize: '0.76rem', color: '#94a3b8' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span>Output naming</span>
                    <code style={{ color: '#38bdf8', background: 'rgba(56, 189, 248, 0.1)', padding: '0.1rem 0.35rem', borderRadius: '4px', wordBreak: 'break-all', textAlign: 'right' }}>
                      {plan.length > 0 ? plan[0].fileName : '[name] - Vol. 01.cbz'}
                    </code>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.35rem' }}>
                    <span>Each cover</span>
                    <span style={{ color: '#34d399' }}>First page · 512px · 85% JPEG</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.35rem' }}>
                    <span>Destination</span>
                    <span style={{ color: '#34d399', display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
                      <Folder size={14}/> {inspect.storage === 'drive' ? 'Same Google Drive folder' : 'Same folder as source'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Volume plan */}
              <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', marginBottom: '0.5rem' }}>
                Volume Plan ({plan.length} {plan.length === 1 ? 'volume' : 'volumes'})
              </div>

              <div className="omnibus-reorder-list-container">
                {planLoading ? (
                  <div style={{ padding: '1.5rem', textAlign: 'center', color: '#64748b', fontSize: '0.82rem' }}>
                    Calculating even split...
                  </div>
                ) : plan.length === 0 ? (
                  <div style={{ padding: '1.5rem', textAlign: 'center', color: '#64748b', fontSize: '0.82rem' }}>
                    Choose a volume count to see the split.
                  </div>
                ) : (
                  plan.map((entry) => (
                    <div
                      key={entry.volume}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.65rem',
                        padding: '0.45rem 0.7rem',
                        borderRadius: '8px',
                        background: '#0f172a',
                        border: '1px solid #1e293b'
                      }}
                    >
                      <div
                        style={{
                          minWidth: '34px',
                          height: '28px',
                          borderRadius: '14px',
                          background: 'rgba(124, 58, 237, 0.2)',
                          border: '1px solid #7c3aed',
                          color: '#c4b5fd',
                          fontSize: '0.72rem',
                          fontWeight: 800,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                          padding: '0 8px'
                        }}
                      >
                        {String(entry.volume).padStart(2, '0')}
                      </div>

                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: '0.8rem', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {entry.fileName}
                        </div>
                        <div style={{ fontSize: '0.7rem', color: '#64748b' }}>
                          Pages {entry.startPage}–{entry.endPage} · {entry.pageCount} pages
                        </div>
                      </div>

                      <span style={{ display: 'inline-flex', alignItems: 'center', color: '#34d399', flexShrink: 0 }} title={`Cover: ${entry.coverFileName}`}>
                        <Image size={16}/>
                      </span>
                    </div>
                  ))
                )}
              </div>

              {/* Split button */}
              <button
                type="button"
                disabled={!canSplit}
                onClick={handleStartSplit}
                style={{
                  width: '100%',
                  background: !canSplit
                    ? '#334155'
                    : 'linear-gradient(135deg, #7c3aed, #5b21b6)',
                  border: 'none',
                  color: '#ffffff',
                  padding: '0.85rem',
                  borderRadius: '10px',
                  fontSize: '1rem',
                  fontWeight: 800,
                  cursor: canSplit ? 'pointer' : 'not-allowed',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '0.5rem',
                  boxShadow: canSplit ? '0 4px 14px rgba(124, 58, 237, 0.4)' : 'none',
                  transition: 'all 0.2s ease'
                }}
              >
                {isSplitting
                  ? 'Splitting...'
                  : plan.length > 0
                    ? `Split into ${plan.length} Volumes`
                    : 'Split Omnibus'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Progress Overlay */}
      {isSplitting && jobStatus && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.85)',
            backdropFilter: 'blur(8px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '1.5rem'
          }}
        >
          <div
            style={{
              background: '#1e293b',
              border: '1px solid #334155',
              borderRadius: '16px',
              padding: '2rem',
              maxWidth: '540px',
              width: '100%',
              boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.7)'
            }}
          >
            <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
              <div style={{ marginBottom: '0.6rem', animation: 'pulse 1.5s infinite' }}><Scissors size={40}/></div>
              <h3 style={{ fontSize: '1.25rem', fontWeight: 800, margin: '0 0 0.4rem', color: '#f8fafc' }}>
                Splitting Omnibus
              </h3>
              <p style={{ fontSize: '0.86rem', color: '#94a3b8', margin: 0, wordBreak: 'break-word' }}>
                {jobStatus.phase}
              </p>
            </div>

            <div style={{ background: '#0f172a', height: '14px', borderRadius: '7px', overflow: 'hidden', marginBottom: '0.8rem', border: '1px solid #334155' }}>
              <div
                style={{
                  height: '100%',
                  width: `${Math.min(100, Math.max(0, jobStatus.percent))}%`,
                  background: 'linear-gradient(90deg, #7c3aed, #10b981)',
                  borderRadius: '7px',
                  transition: 'width 0.3s ease'
                }}
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', color: '#64748b' }}>
              <span>
                {jobStatus.volumes.length > 0
                  ? `${jobStatus.volumes.length} of ${plan.length} volumes saved`
                  : 'Repacking and uploading pages'}
              </span>
              <span style={{ fontWeight: 700, color: '#38bdf8' }}>{jobStatus.percent}%</span>
            </div>
          </div>
        </div>
      )}

      {/* Error toast when the job fails */}
      {jobStatus?.status === 'error' && !isSplitting && (
        <div
          style={{
            position: 'fixed',
            bottom: 'calc(24px + env(safe-area-inset-bottom, 0px))',
            left: '50%',
            transform: 'translateX(-50%)',
            maxWidth: '560px',
            width: 'calc(100% - 32px)',
            background: '#1e293b',
            border: '1px solid #ef4444',
            borderRadius: '12px',
            padding: '1rem 1.15rem',
            zIndex: 1000,
            boxShadow: '0 18px 40px rgba(0, 0, 0, 0.6)'
          }}
        >
          <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-start' }}>
            <span style={{ display: 'inline-flex' }}><TriangleAlert size={16}/></span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '0.88rem', fontWeight: 700, color: '#fca5a5', marginBottom: '0.2rem' }}>
                Split failed
              </div>
              <div style={{ fontSize: '0.82rem', color: '#cbd5e1', wordBreak: 'break-word' }}>
                {jobStatus.error}
              </div>
              {jobStatus.volumes.length > 0 && (
                <div style={{ fontSize: '0.8rem', color: '#34d399', marginTop: '0.4rem' }}>
                  {jobStatus.volumes.length} volume{jobStatus.volumes.length === 1 ? '' : 's'} were saved before the
                  error — check your Drive folder before retrying.
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() => setJobStatus(null)}
              className="reorder-item-btn remove-btn"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Completion & Delete Confirmation Modal */}
      {showCompletionModal && jobStatus?.result && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.88)',
            backdropFilter: 'blur(10px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '1rem',
            overflowY: 'auto'
          }}
        >
          <div
            style={{
              background: '#1e293b',
              border: '1px solid #10b981',
              borderRadius: '16px',
              padding: 'clamp(1.25rem, 4vw, 2rem)',
              maxWidth: '580px',
              width: '100%',
              boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.8), 0 0 25px rgba(16, 185, 129, 0.2)'
            }}
          >
            <div style={{ textAlign: 'center', marginBottom: '1.25rem' }}>
              <div style={{ marginBottom: '0.4rem' }}><PartyPopper size={40}/></div>
              <h3 style={{ fontSize: '1.35rem', fontWeight: 800, margin: '0 0 0.4rem', color: '#f8fafc' }}>
                Split Complete!
              </h3>
              <p style={{ fontSize: '0.9rem', color: '#34d399', margin: 0, fontWeight: 600 }}>
                {jobStatus.result.volumeCount} volumes created from {jobStatus.result.totalPages} pages
              </p>
              <div style={{ fontSize: '0.78rem', color: '#94a3b8', marginTop: '0.35rem' }}>
                From: <code style={{ color: '#38bdf8', background: 'rgba(56, 189, 248, 0.1)', padding: '0.15rem 0.4rem', borderRadius: '4px', wordBreak: 'break-all' }}>{jobStatus.result.sourceFileName}</code>
              </div>
            </div>

            <div style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: '10px', padding: '0.85rem', marginBottom: '1.25rem', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(80px, 1fr))', gap: '0.5rem', textAlign: 'center' }}>
              <div>
                <div style={{ fontSize: '0.7rem', color: '#94a3b8', textTransform: 'uppercase', fontWeight: 700 }}>Volumes</div>
                <div style={{ fontSize: '1.15rem', fontWeight: 800, color: '#f8fafc', marginTop: '2px' }}>
                  {jobStatus.result.volumeCount}
                </div>
              </div>
              <div>
                <div style={{ fontSize: '0.7rem', color: '#94a3b8', textTransform: 'uppercase', fontWeight: 700 }}>Pages</div>
                <div style={{ fontSize: '1.15rem', fontWeight: 800, color: '#38bdf8', marginTop: '2px' }}>
                  {jobStatus.result.totalPages}
                </div>
              </div>
              <div>
                <div style={{ fontSize: '0.7rem', color: '#94a3b8', textTransform: 'uppercase', fontWeight: 700 }}>Size</div>
                <div style={{ fontSize: '1.15rem', fontWeight: 800, color: '#34d399', marginTop: '2px' }}>
                  {(jobStatus.result.totalSize / 1024 / 1024).toFixed(1)} MB
                </div>
              </div>
            </div>

            {/* Volume list */}
            <div style={{ maxHeight: '180px', overflowY: 'auto', marginBottom: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
              {jobStatus.result.volumes.map((v) => (
                <div
                  key={v.volume}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    padding: '0.35rem 0.55rem',
                    background: 'rgba(15, 23, 42, 0.7)',
                    borderRadius: '6px',
                    fontSize: '0.76rem'
                  }}
                >
                  <span style={{ color: '#c4b5fd', fontWeight: 800, fontFamily: 'var(--font-mono, monospace)', flexShrink: 0 }}>
                    {String(v.volume).padStart(2, '0')}
                  </span>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#e2e8f0' }}>
                    {v.fileName}
                  </span>
                  <span style={{ color: '#64748b', flexShrink: 0 }}>{v.pageCount} pgs</span>
                </div>
              ))}
            </div>

            {/* Prompt for deleting the original omnibus */}
            {deleteSourceState !== 'deleted' ? (
              <div style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: '12px', padding: '1.1rem', marginBottom: '1.5rem' }}>
                <div style={{ display: 'flex', gap: '0.65rem' }}>
                  <span style={{ display: 'inline-flex' }}><Trash2 size={22}/></span>
                  <div>
                    <h4 style={{ margin: '0 0 0.25rem', fontSize: '0.98rem', fontWeight: 700, color: '#fca5a5' }}>
                      Delete the original omnibus?
                    </h4>
                    <p style={{ margin: 0, fontSize: '0.82rem', color: '#cbd5e1' }}>
                      Its pages are now spread across {jobStatus.result.volumeCount} volumes. Would you like to remove the
                      original file and its cover from storage to reclaim the space?
                    </p>
                  </div>
                </div>

                {deleteMessage && (
                  <div style={{ marginTop: '0.75rem', padding: '0.5rem 0.75rem', borderRadius: '6px', background: deleteSourceState === 'error' ? 'rgba(239, 68, 68, 0.2)' : 'rgba(16, 185, 129, 0.2)', fontSize: '0.82rem', fontWeight: 600, color: deleteSourceState === 'error' ? '#fca5a5' : '#34d399' }}>
                    {deleteMessage}
                  </div>
                )}

                <div style={{ display: 'flex', gap: '0.6rem', marginTop: '0.9rem', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    disabled={deleteSourceState === 'deleting'}
                    onClick={handleDeleteSource}
                    style={{
                      flex: 1,
                      minWidth: '150px',
                      background: '#ef4444',
                      border: 'none',
                      color: '#ffffff',
                      padding: '0.7rem 1rem',
                      borderRadius: '8px',
                      fontSize: '0.88rem',
                      fontWeight: 700,
                      cursor: deleteSourceState === 'deleting' ? 'not-allowed' : 'pointer'
                    }}
                  >
                    {deleteSourceState === 'deleting' ? 'Deleting...' : 'Delete Original'}
                  </button>
                  <button
                    type="button"
                    disabled={deleteSourceState === 'deleting'}
                    onClick={handleKeepSource}
                    style={{
                      flex: 1,
                      minWidth: '150px',
                      background: 'rgba(255, 255, 255, 0.1)',
                      border: '1px solid rgba(255, 255, 255, 0.2)',
                      color: '#f8fafc',
                      padding: '0.7rem 1rem',
                      borderRadius: '8px',
                      fontSize: '0.88rem',
                      fontWeight: 700,
                      cursor: 'pointer'
                    }}
                  >
                    Keep Original
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ background: 'rgba(16, 185, 129, 0.1)', border: '1px solid rgba(16, 185, 129, 0.3)', borderRadius: '12px', padding: '1rem', marginBottom: '1.5rem' }}>
                <div style={{ fontSize: '0.85rem', fontWeight: 600, color: '#34d399' }}>
                  {deleteMessage}
                </div>
              </div>
            )}

            {/* Read / Done actions */}
            <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
              {onOpenComic && jobStatus.result.volumes[0]?.comic && (
                <button
                  type="button"
                  onClick={() => {
                    setShowCompletionModal(false);
                    onOpenComic(jobStatus.result!.volumes[0].comic);
                  }}
                  style={{
                    flex: 1,
                    minWidth: '170px',
                    background: 'linear-gradient(135deg, #7c3aed, #5b21b6)',
                    border: 'none',
                    color: '#ffffff',
                    padding: '0.75rem 1rem',
                    borderRadius: '8px',
                    fontSize: '0.9rem',
                    fontWeight: 800,
                    cursor: 'pointer'
                  }}
                >
                  Read Volume 01
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setShowCompletionModal(false);
                  setJobStatus(null);
                  clearSource();
                }}
                style={{
                  flex: 1,
                  minWidth: '170px',
                  background: '#10b981',
                  border: 'none',
                  color: '#ffffff',
                  padding: '0.75rem 1rem',
                  borderRadius: '8px',
                  fontSize: '0.9rem',
                  fontWeight: 700,
                  cursor: 'pointer'
                }}
              >
                ✓ Done
              </button>
            </div>

            {onOpenAuthModal && deleteSourceState === 'error' && (
              <div style={{ marginTop: '0.9rem', textAlign: 'center' }}>
                <button
                  type="button"
                  onClick={onOpenAuthModal}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#93c5fd',
                    fontSize: '0.8rem',
                    cursor: 'pointer',
                    textDecoration: 'underline'
                  }}
                >
                  Reconnect your Google account
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
