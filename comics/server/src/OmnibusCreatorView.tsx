import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { apiUrl } from './api';
import type { Comic } from './Library';
import type { GoogleUserProfile } from './AuthModal';

interface OmnibusCreatorViewProps {
  user: GoogleUserProfile | null;
  initialSeries?: string | null;
  onOpenComic?: (comic: Comic) => void;
  onNavigateView?: (view: string) => void;
  onOpenAuthModal?: () => void;
}

interface MergeJobStatus {
  id: string;
  status: 'running' | 'done' | 'error';
  phase: string;
  percent: number;
  result?: {
    comic: Comic;
    title: string;
    totalPages: number;
    fileSize: number;
    issueCount: number;
    issueIds: (string | number)[];
    issueTitles: string[];
  } | null;
  error?: string | null;
}

export default function OmnibusCreatorView({
  user,
  initialSeries,
  onOpenComic,
  onNavigateView,
  onOpenAuthModal
}: OmnibusCreatorViewProps) {
  const [comics, setComics] = useState<Comic[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [selectedSeries, setSelectedSeries] = useState<string>(initialSeries || 'all');
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Selected issues in user-defined sequence
  const [selectedIssueIds, setSelectedIssueIds] = useState<(string | number)[]>([]);
  const [omnibusTitle, setOmnibusTitle] = useState<string>('');

  // Mobile portrait responsive step tab: 'select' | 'order'
  const [mobileTab, setMobileTab] = useState<'select' | 'order'>('select');

  // Merge execution & polling state
  const [isMerging, setIsMerging] = useState<boolean>(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<MergeJobStatus | null>(null);

  // Completion modal & cleanup prompt state
  const [showCompletionModal, setShowCompletionModal] = useState<boolean>(false);
  const [deleteSinglesState, setDeleteSinglesState] = useState<'idle' | 'deleting' | 'deleted' | 'kept' | 'error'>('idle');
  const [deleteMessage, setDeleteMessage] = useState<string>('');

  const pollingTimerRef = useRef<any>(null);

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
      console.warn('[OmnibusCreator] Failed to fetch comics:', err);
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

  // 3. Filter issues available for selection
  const availableIssues = useMemo(() => {
    return comics.filter((c) => {
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
    }).sort((a, b) => {
      // Natural sort by title/item
      return (a.item || a.title || '').localeCompare(b.item || b.title || '', undefined, {
        numeric: true,
        sensitivity: 'base'
      });
    });
  }, [comics, selectedSeries, searchQuery]);

  // 4. Map of ID -> Comic for rapid lookup
  const comicMap = useMemo(() => {
    const map = new Map<string | number, Comic>();
    comics.forEach((c) => {
      map.set(c.id, c);
      map.set(String(c.id), c);
    });
    return map;
  }, [comics]);

  // 5. Selected comics in the user's customized sequence
  const selectedComics = useMemo(() => {
    return selectedIssueIds
      .map((id) => comicMap.get(id))
      .filter((c): c is Comic => Boolean(c));
  }, [selectedIssueIds, comicMap]);

  // Total pages and estimated size of selected issues
  const selectedSummary = useMemo(() => {
    let pages = 0;
    let size = 0;
    selectedComics.forEach((c) => {
      pages += c.totalPages || 0;
      size += c.size || 0;
    });
    return {
      pages,
      sizeMb: (size / 1024 / 1024).toFixed(1)
    };
  }, [selectedComics]);

  // Auto-suggest omnibus title when issues are chosen
  useEffect(() => {
    if (selectedComics.length > 0 && !omnibusTitle) {
      const primarySeries = selectedComics[0].series || (selectedSeries !== 'all' ? selectedSeries : '') || 'Comics';
      setOmnibusTitle(`${primarySeries} Omnibus`);
    }
  }, [selectedComics, omnibusTitle, selectedSeries]);

  // Real-time preview of the filename that will be created on storage
  const previewFilename = useMemo(() => {
    const primarySeries = selectedComics[0]?.series || (selectedSeries !== 'all' ? selectedSeries : '') || 'Comics';
    const raw = (omnibusTitle.trim() || `${primarySeries} Omnibus`).replace(/\.(cbz|cbr|zip)$/i, '').trim();
    const safe = raw
      .replace(/[:]/g, ' - ')
      .replace(/[<>"\/\\|?*]+/g, '_')
      .replace(/\s+/g, ' ')
      .replace(/^[-_\s]+|[-_\s]+$/g, '')
      .trim();
    return `${safe || 'Omnibus'}.cbz`;
  }, [omnibusTitle, selectedComics, selectedSeries]);

  // Update selection functions
  const toggleIssue = (id: string | number) => {
    setSelectedIssueIds((prev) => {
      if (prev.includes(id) || prev.includes(String(id))) {
        return prev.filter((x) => String(x) !== String(id));
      } else {
        return [...prev, id];
      }
    });
  };

  const selectAllVisible = () => {
    const idsToAdd = availableIssues.map((c) => c.id).filter((id) => !selectedIssueIds.includes(id));
    setSelectedIssueIds((prev) => [...prev, ...idsToAdd]);
  };

  const clearSelection = () => {
    setSelectedIssueIds([]);
  };

  const moveUp = (index: number) => {
    if (index <= 0) return;
    setSelectedIssueIds((prev) => {
      const next = [...prev];
      const temp = next[index - 1];
      next[index - 1] = next[index];
      next[index] = temp;
      return next;
    });
  };

  const moveDown = (index: number) => {
    if (index >= selectedIssueIds.length - 1) return;
    setSelectedIssueIds((prev) => {
      const next = [...prev];
      const temp = next[index + 1];
      next[index + 1] = next[index];
      next[index] = temp;
      return next;
    });
  };

  const sortNaturally = () => {
    setSelectedIssueIds((prev) => {
      const list = [...prev];
      list.sort((a, b) => {
        const itemA = comicMap.get(a)?.item || comicMap.get(a)?.title || '';
        const itemB = comicMap.get(b)?.item || comicMap.get(b)?.title || '';
        return itemA.localeCompare(itemB, undefined, { numeric: true, sensitivity: 'base' });
      });
      return list;
    });
  };

  const reverseOrder = () => {
    setSelectedIssueIds((prev) => [...prev].reverse());
  };

  // 6. Polling effect for active merge job
  useEffect(() => {
    if (!activeJobId || !isMerging) return;

    const checkStatus = async () => {
      try {
        const res = await fetch(apiUrl(`/api/omnibus/status/${activeJobId}`));
        if (res.ok) {
          const data: MergeJobStatus = await res.json();
          setJobStatus(data);

          if (data.status === 'done') {
            setIsMerging(false);
            setShowCompletionModal(true);
            setDeleteSinglesState('idle');
            if (pollingTimerRef.current) clearInterval(pollingTimerRef.current);
            fetchComics();
          } else if (data.status === 'error') {
            setIsMerging(false);
            if (pollingTimerRef.current) clearInterval(pollingTimerRef.current);
          }
        }
      } catch (err) {
        console.warn('[OmnibusCreator] Status poll note:', err);
      }
    };

    checkStatus();
    pollingTimerRef.current = setInterval(checkStatus, 800);

    return () => {
      if (pollingTimerRef.current) clearInterval(pollingTimerRef.current);
    };
  }, [activeJobId, isMerging, fetchComics]);

  // 7. Start Merge Handler
  const handleStartMerge = async () => {
    if (selectedIssueIds.length < 2) {
      alert('Please select at least 2 issues to create an omnibus.');
      return;
    }

    const primarySeries = selectedComics[0]?.series || (selectedSeries !== 'all' ? selectedSeries : '') || 'Comics';
    const title = (omnibusTitle.trim() || `${primarySeries} Omnibus`).trim();

    try {
      setIsMerging(true);
      setJobStatus({
        id: '',
        status: 'running',
        phase: 'Starting omnibus creation job...',
        percent: 0
      });

      const res = await fetch(apiUrl('/api/omnibus/merge'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          issueIds: selectedIssueIds,
          omnibusTitle: title,
          seriesName: (selectedSeries !== 'all' ? selectedSeries : '') || primarySeries
        })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to start omnibus creation job.');
      }

      const data = await res.json();
      setActiveJobId(data.jobId || data.job?.id);
    } catch (err: any) {
      alert(`Error starting omnibus creation: ${err.message}`);
      setIsMerging(false);
      setJobStatus(null);
    }
  };

  // 8. Delete Single Issues Handler
  const handleDeleteSingles = async () => {
    if (!jobStatus?.result?.issueIds || jobStatus.result.issueIds.length === 0) return;

    try {
      setDeleteSinglesState('deleting');
      const res = await fetch(apiUrl('/api/omnibus/delete-singles'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          issueIds: jobStatus.result.issueIds
        })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to delete single issues.');
      }

      const data = await res.json();
      setDeleteSinglesState('deleted');
      setDeleteMessage(`Successfully deleted ${data.deletedCount || jobStatus.result.issueIds.length} single issues.`);
      fetchComics();
      // Clear current selection
      setSelectedIssueIds([]);
    } catch (err: any) {
      setDeleteSinglesState('error');
      setDeleteMessage(err.message || 'Error occurred while deleting single issues.');
    }
  };

  const handleKeepSingles = () => {
    setDeleteSinglesState('kept');
    setShowCompletionModal(false);
    setSelectedIssueIds([]);
  };

  return (
    <div className="omnibus-view-container">
      {/* Top Banner Header */}
      <div style={{ marginBottom: '1.25rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem' }}>
        <div>
          <h1 style={{ fontSize: '1.6rem', fontWeight: 800, color: '#f8fafc', display: 'flex', alignItems: 'center', gap: '0.6rem', margin: 0 }}>
            <span style={{ fontSize: '1.8rem' }}>📚</span> Omnibus Creator
          </h1>
          <p style={{ color: '#94a3b8', fontSize: '0.85rem', margin: '0.25rem 0 0' }}>
            Select comic issues, arrange reading sequence, and merge into a single CBZ omnibus.
          </p>
        </div>

        {onNavigateView && (
          <button
            onClick={() => onNavigateView('library')}
            style={{
              background: 'rgba(255, 255, 255, 0.08)',
              border: '1px solid rgba(255, 255, 255, 0.15)',
              color: '#f8fafc',
              padding: '0.45rem 0.85rem',
              borderRadius: '8px',
              fontSize: '0.82rem',
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem'
            }}
          >
            ← Back to Library
          </button>
        )}
      </div>

      {/* Mobile Step Switcher Tabs (Visible on screens <= 860px) */}
      <div className="omnibus-mobile-tabs">
        <button
          type="button"
          className={`omnibus-mobile-tab-btn ${mobileTab === 'select' ? 'active' : ''}`}
          onClick={() => setMobileTab('select')}
        >
          <span>1️⃣ Select Issues</span>
          <span
            style={{
              background: mobileTab === 'select' ? 'rgba(255, 255, 255, 0.25)' : 'rgba(255, 255, 255, 0.1)',
              padding: '2px 7px',
              borderRadius: '10px',
              fontSize: '0.72rem'
            }}
          >
            {availableIssues.length}
          </span>
        </button>

        <button
          type="button"
          className={`omnibus-mobile-tab-btn ${mobileTab === 'order' ? 'active' : ''}`}
          onClick={() => setMobileTab('order')}
        >
          <span>2️⃣ Order & Create</span>
          {selectedIssueIds.length > 0 && (
            <span
              style={{
                background: mobileTab === 'order' ? 'rgba(255, 255, 255, 0.25)' : '#3b82f6',
                color: '#fff',
                padding: '2px 7px',
                borderRadius: '10px',
                fontSize: '0.72rem'
              }}
            >
              {selectedIssueIds.length}
            </span>
          )}
        </button>
      </div>

      {/* Main Layout Grid */}
      <div className="omnibus-layout-grid">
        
        {/* Left Column: Issue Selection */}
        <div className={`omnibus-column-card omnibus-column-select ${mobileTab === 'select' ? 'active' : ''}`}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
            <h2 style={{ fontSize: '1.15rem', fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span>1️⃣</span> Select Issues
            </h2>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                type="button"
                onClick={selectAllVisible}
                style={{
                  background: 'rgba(59, 130, 246, 0.2)',
                  border: '1px solid #3b82f6',
                  color: '#93c5fd',
                  padding: '0.35rem 0.75rem',
                  borderRadius: '6px',
                  fontSize: '0.78rem',
                  fontWeight: 600,
                  cursor: 'pointer'
                }}
              >
                Select All ({availableIssues.length})
              </button>
              <button
                type="button"
                onClick={clearSelection}
                style={{
                  background: 'rgba(255, 255, 255, 0.05)',
                  border: '1px solid rgba(255, 255, 255, 0.15)',
                  color: '#94a3b8',
                  padding: '0.35rem 0.75rem',
                  borderRadius: '6px',
                  fontSize: '0.78rem',
                  fontWeight: 600,
                  cursor: 'pointer'
                }}
              >
                Clear
              </button>
            </div>
          </div>

          {/* Series Filter & Search Bar */}
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
              <option value="all">All Series ({comics.length} issues)</option>
              {seriesList.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name} ({s.count})
                </option>
              ))}
            </select>

            <input
              type="text"
              placeholder="Filter by title or issue #..."
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

          {/* Issues List */}
          <div className="omnibus-issue-list-container">
            {loading ? (
              <div style={{ padding: '2rem', textAlign: 'center', color: '#94a3b8' }}>Loading library issues...</div>
            ) : availableIssues.length === 0 ? (
              <div style={{ padding: '2.5rem 1rem', textAlign: 'center', color: '#94a3b8' }}>
                <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>📭</div>
                No comic issues found matching the selected filter.
              </div>
            ) : (
              availableIssues.map((comic) => {
                const isSelected = selectedIssueIds.includes(comic.id) || selectedIssueIds.includes(String(comic.id));
                const orderIndex = selectedIssueIds.findIndex((id) => String(id) === String(comic.id));

                return (
                  <div
                    key={comic.id}
                    onClick={() => toggleIssue(comic.id)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.75rem',
                      padding: '0.6rem 0.75rem',
                      borderRadius: '8px',
                      background: isSelected ? 'rgba(59, 130, 246, 0.15)' : 'rgba(15, 23, 42, 0.5)',
                      border: `1px solid ${isSelected ? '#3b82f6' : '#1e293b'}`,
                      cursor: 'pointer',
                      transition: 'background 0.15s ease, border-color 0.15s ease'
                    }}
                  >
                    {/* Checkbox indicator */}
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => {}} // handled by parent onClick
                      style={{ width: '16px', height: '16px', cursor: 'pointer', accentColor: '#3b82f6' }}
                    />

                    {/* Cover Thumbnail */}
                    <div style={{ width: '38px', height: '54px', borderRadius: '4px', overflow: 'hidden', background: '#0f172a', flexShrink: 0, position: 'relative' }}>
                      {comic.coverImage ? (
                        <img
                          src={comic.coverImage}
                          alt=""
                          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                          loading="lazy"
                        />
                      ) : (
                        <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#475569', fontSize: '1rem' }}>
                          📖
                        </div>
                      )}
                    </div>

                    {/* Comic details */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '0.86rem', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: isSelected ? '#93c5fd' : '#f8fafc' }}>
                        {comic.title}
                      </div>
                      <div style={{ fontSize: '0.74rem', color: '#94a3b8', display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '2px' }}>
                        <span>{comic.item || 'Single Issue'}</span>
                        {comic.totalPages ? <span>• {comic.totalPages} pgs</span> : null}
                        {comic.series ? <span>• {comic.series}</span> : null}
                      </div>
                    </div>

                    {/* Order badge if selected */}
                    {isSelected && (
                      <span
                        style={{
                          background: '#3b82f6',
                          color: '#fff',
                          fontSize: '0.72rem',
                          fontWeight: 800,
                          padding: '2px 7px',
                          borderRadius: '12px',
                          flexShrink: 0
                        }}
                      >
                        #{orderIndex + 1}
                      </span>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right Column: Reading Order Sequence & Omnibus Packaging */}
        <div className={`omnibus-column-card omnibus-column-order ${mobileTab === 'order' ? 'active' : ''}`}>
          {/* Quick back to selection button on mobile */}
          <button
            type="button"
            className="omnibus-mobile-back-btn"
            onClick={() => setMobileTab('select')}
            style={{
              display: 'none',
              alignItems: 'center',
              gap: '0.35rem',
              marginBottom: '0.75rem',
              background: 'rgba(59, 130, 246, 0.15)',
              border: '1px solid rgba(59, 130, 246, 0.35)',
              color: '#93c5fd',
              padding: '0.4rem 0.8rem',
              borderRadius: '8px',
              fontSize: '0.82rem',
              fontWeight: 600,
              cursor: 'pointer'
            }}
          >
            ← Add / Change Selected Issues ({selectedIssueIds.length})
          </button>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
            <h2 style={{ fontSize: '1.15rem', fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span>2️⃣</span> Reading Order & Configuration
            </h2>
            {selectedComics.length > 1 && (
              <div style={{ display: 'flex', gap: '0.4rem' }}>
                <button
                  type="button"
                  onClick={sortNaturally}
                  title="Sort naturally by issue number"
                  style={{
                    background: 'rgba(255, 255, 255, 0.08)',
                    border: '1px solid rgba(255, 255, 255, 0.15)',
                    color: '#f8fafc',
                    padding: '0.3rem 0.65rem',
                    borderRadius: '6px',
                    fontSize: '0.75rem',
                    fontWeight: 600,
                    cursor: 'pointer'
                  }}
                >
                  Sort 1, 2, 3…
                </button>
                <button
                  type="button"
                  onClick={reverseOrder}
                  title="Reverse order"
                  style={{
                    background: 'rgba(255, 255, 255, 0.08)',
                    border: '1px solid rgba(255, 255, 255, 0.15)',
                    color: '#f8fafc',
                    padding: '0.3rem 0.65rem',
                    borderRadius: '6px',
                    fontSize: '0.75rem',
                    fontWeight: 600,
                    cursor: 'pointer'
                  }}
                >
                  ⇄ Reverse
                </button>
              </div>
            )}
          </div>

          {/* Omnibus Config Fields */}
          <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: '10px', padding: '1rem', marginBottom: '1rem' }}>
            <div style={{ marginBottom: '0.75rem' }}>
              <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 700, color: '#94a3b8', marginBottom: '0.35rem' }}>
                Omnibus Title
              </label>
              <input
                type="text"
                value={omnibusTitle}
                onChange={(e) => setOmnibusTitle(e.target.value)}
                placeholder="e.g. Batman: The Long Halloween Omnibus"
                style={{
                  width: '100%',
                  background: '#1e293b',
                  border: '1px solid #334155',
                  color: '#f8fafc',
                  padding: '0.6rem 0.8rem',
                  borderRadius: '6px',
                  fontSize: '0.9rem',
                  fontWeight: 600,
                  boxSizing: 'border-box'
                }}
              />
              <span style={{ display: 'block', fontSize: '0.74rem', color: '#64748b', marginTop: '0.35rem' }}>
                Storage File Name: <code style={{ color: '#38bdf8', background: 'rgba(56, 189, 248, 0.1)', padding: '0.1rem 0.35rem', borderRadius: '4px' }}>{previewFilename}</code>
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.78rem', color: '#94a3b8' }}>
              <span>Output File: <code style={{ color: '#38bdf8' }}>{omnibusTitle ? `${omnibusTitle.replace(/[<>:"/\\|?*]+/g, '').trim()}.cbz` : 'Omnibus.cbz'}</code></span>
              <span style={{ color: '#34d399' }}>📁 Saved in same folder</span>
            </div>
          </div>

          {/* Summary Metric Header */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.5rem 0.75rem', background: 'rgba(15, 23, 42, 0.6)', borderRadius: '8px', marginBottom: '0.85rem', fontSize: '0.82rem' }}>
            <span style={{ color: '#94a3b8' }}>
              Selected: <strong style={{ color: '#f8fafc' }}>{selectedComics.length} issues</strong>
            </span>
            <span style={{ color: '#94a3b8' }}>
              Est. Total: <strong style={{ color: '#38bdf8' }}>{selectedSummary.pages} pages</strong> ({selectedSummary.sizeMb} MB)
            </span>
          </div>

          {/* Reorderable Issues List */}
          <div className="omnibus-reorder-list-container">
            {selectedComics.length === 0 ? (
              <div style={{ padding: '2.5rem 1rem', textAlign: 'center', color: '#64748b', border: '2px dashed #1e293b', borderRadius: '8px' }}>
                <div style={{ fontSize: '1.8rem', marginBottom: '0.4rem' }}>👈</div>
                Select issues from the list on the left to arrange them here.
              </div>
            ) : (
              selectedComics.map((comic, index) => (
                <div
                  key={comic.id}
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
                  {/* Sequence Position */}
                  <div
                    style={{
                      width: '28px',
                      height: '28px',
                      borderRadius: '50%',
                      background: 'rgba(59, 130, 246, 0.2)',
                      border: '1px solid #3b82f6',
                      color: '#60a5fa',
                      fontSize: '0.78rem',
                      fontWeight: 800,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0
                    }}
                  >
                    {index + 1}
                  </div>

                  {/* Title & info */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '0.84rem', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {comic.title}
                    </div>
                    <div style={{ fontSize: '0.72rem', color: '#64748b' }}>
                      {comic.item || 'Issue'} {comic.totalPages ? `• ${comic.totalPages} pgs` : ''}
                    </div>
                  </div>

                  {/* Move Controls */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
                    <button
                      type="button"
                      disabled={index === 0}
                      onClick={() => moveUp(index)}
                      title="Move earlier in reading order"
                      aria-label="Move earlier in reading order"
                      className="reorder-item-btn"
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      disabled={index === selectedComics.length - 1}
                      onClick={() => moveDown(index)}
                      title="Move later in reading order"
                      aria-label="Move later in reading order"
                      className="reorder-item-btn"
                    >
                      ▼
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleIssue(comic.id)}
                      title="Remove from omnibus"
                      aria-label="Remove from omnibus"
                      className="reorder-item-btn remove-btn"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Merge Action Button */}
          <button
            type="button"
            disabled={selectedComics.length < 2 || isMerging}
            onClick={handleStartMerge}
            style={{
              width: '100%',
              background: selectedComics.length < 2 || isMerging ? '#334155' : 'linear-gradient(135deg, #2563eb, #1d4ed8)',
              border: 'none',
              color: '#ffffff',
              padding: '0.85rem',
              borderRadius: '10px',
              fontSize: '1rem',
              fontWeight: 800,
              cursor: selectedComics.length < 2 || isMerging ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.5rem',
              boxShadow: selectedComics.length < 2 ? 'none' : '0 4px 14px rgba(37, 99, 235, 0.4)',
              transition: 'all 0.2s ease'
            }}
          >
            {isMerging ? 'Creating Omnibus...' : `📚 Merge ${selectedComics.length} Issues into Omnibus`}
          </button>
        </div>
      </div>

      {/* Mobile Floating Bar in Step 1 */}
      {mobileTab === 'select' && selectedIssueIds.length > 0 && (
        <div
          className="omnibus-mobile-floating-bar"
          onClick={() => setMobileTab('order')}
          role="button"
          tabIndex={0}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span>📚</span>
            <span>{selectedIssueIds.length} {selectedIssueIds.length === 1 ? 'issue' : 'issues'} selected</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <span>Order & Create</span>
            <span style={{ fontSize: '1.1rem' }}>→</span>
          </div>
        </div>
      )}

      {/* Progress Dialog / Overlay when Merging */}
      {isMerging && jobStatus && (
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
              <div style={{ fontSize: '2.5rem', marginBottom: '0.6rem', animation: 'pulse 1.5s infinite' }}>📚</div>
              <h3 style={{ fontSize: '1.25rem', fontWeight: 800, margin: '0 0 0.4rem', color: '#f8fafc' }}>
                Creating Omnibus Archive
              </h3>
              <p style={{ fontSize: '0.86rem', color: '#94a3b8', margin: 0 }}>
                {jobStatus.phase}
              </p>
            </div>

            {/* Progress bar */}
            <div style={{ background: '#0f172a', height: '14px', borderRadius: '7px', overflow: 'hidden', marginBottom: '0.8rem', border: '1px solid #334155' }}>
              <div
                style={{
                  height: '100%',
                  width: `${jobStatus.percent}%`,
                  background: 'linear-gradient(90deg, #3b82f6, #10b981)',
                  borderRadius: '7px',
                  transition: 'width 0.3s ease'
                }}
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', color: '#64748b' }}>
              <span>Collision-proof page sequencing</span>
              <span style={{ fontWeight: 700, color: '#38bdf8' }}>{jobStatus.percent}%</span>
            </div>
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
            padding: '1rem'
          }}
        >
          <div
            style={{
              background: '#1e293b',
              border: '1px solid #10b981',
              borderRadius: '16px',
              padding: 'clamp(1.25rem, 4vw, 2rem)',
              maxWidth: '560px',
              width: '100%',
              boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.8), 0 0 25px rgba(16, 185, 129, 0.2)'
            }}
          >
            {/* Success Header */}
            <div style={{ textAlign: 'center', marginBottom: '1.25rem' }}>
              <div style={{ fontSize: '2.5rem', marginBottom: '0.4rem' }}>🎉</div>
              <h3 style={{ fontSize: '1.35rem', fontWeight: 800, margin: '0 0 0.4rem', color: '#f8fafc' }}>
                Omnibus Created Successfully!
              </h3>
              <p style={{ fontSize: '0.9rem', color: '#34d399', margin: 0, fontWeight: 600 }}>
                "{jobStatus.result.title}" is ready in your library!
              </p>
              <div style={{ fontSize: '0.78rem', color: '#94a3b8', marginTop: '0.35rem' }}>
                File: <code style={{ color: '#38bdf8', background: 'rgba(56, 189, 248, 0.1)', padding: '0.15rem 0.4rem', borderRadius: '4px', wordBreak: 'break-all' }}>{(jobStatus.result as any).fileName || `${jobStatus.result.title}.cbz`}</code>
              </div>
            </div>

            {/* Details Box */}
            <div style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: '10px', padding: '0.85rem', marginBottom: '1.25rem', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(80px, 1fr))', gap: '0.5rem', textAlign: 'center' }}>
              <div>
                <div style={{ fontSize: '0.7rem', color: '#94a3b8', textTransform: 'uppercase', fontWeight: 700 }}>Issues</div>
                <div style={{ fontSize: '1.15rem', fontWeight: 800, color: '#f8fafc', marginTop: '2px' }}>{jobStatus.result.issueCount}</div>
              </div>
              <div>
                <div style={{ fontSize: '0.7rem', color: '#94a3b8', textTransform: 'uppercase', fontWeight: 700 }}>Pages</div>
                <div style={{ fontSize: '1.15rem', fontWeight: 800, color: '#38bdf8', marginTop: '2px' }}>{jobStatus.result.totalPages}</div>
              </div>
              <div>
                <div style={{ fontSize: '0.7rem', color: '#94a3b8', textTransform: 'uppercase', fontWeight: 700 }}>Size</div>
                <div style={{ fontSize: '1.15rem', fontWeight: 800, color: '#34d399', marginTop: '2px' }}>
                  {(jobStatus.result.fileSize / 1024 / 1024).toFixed(1)} MB
                </div>
              </div>
            </div>

            {/* Prompt for Deleting Single Issues */}
            <div style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: '12px', padding: '1.1rem', marginBottom: '1.5rem' }}>
              <div style={{ display: 'flex', gap: '0.65rem' }}>
                <span style={{ fontSize: '1.4rem' }}>🗑️</span>
                <div>
                  <h4 style={{ margin: '0 0 0.25rem', fontSize: '0.98rem', fontWeight: 700, color: '#fca5a5' }}>
                    Delete the {jobStatus.result.issueCount} single issues?
                  </h4>
                  <p style={{ margin: 0, fontSize: '0.82rem', color: '#cbd5e1' }}>
                    Since all issues are now combined in the omnibus, would you like to delete the individual single issue files from storage to save space?
                  </p>
                </div>
              </div>

              {deleteMessage && (
                <div style={{ marginTop: '0.75rem', padding: '0.5rem 0.75rem', borderRadius: '6px', background: deleteSinglesState === 'deleted' ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)', fontSize: '0.82rem', fontWeight: 600, color: deleteSinglesState === 'deleted' ? '#34d399' : '#fca5a5' }}>
                  {deleteMessage}
                </div>
              )}
            </div>

            {/* Action Buttons */}
            <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
              {deleteSinglesState !== 'deleted' ? (
                <>
                  <button
                    type="button"
                    disabled={deleteSinglesState === 'deleting'}
                    onClick={handleDeleteSingles}
                    style={{
                      flex: 1,
                      minWidth: '160px',
                      background: '#ef4444',
                      border: 'none',
                      color: '#ffffff',
                      padding: '0.75rem 1rem',
                      borderRadius: '8px',
                      fontSize: '0.9rem',
                      fontWeight: 700,
                      cursor: deleteSinglesState === 'deleting' ? 'not-allowed' : 'pointer'
                    }}
                  >
                    {deleteSinglesState === 'deleting' ? 'Deleting singles...' : '🗑️ Delete Single Issues'}
                  </button>

                  <button
                    type="button"
                    disabled={deleteSinglesState === 'deleting'}
                    onClick={handleKeepSingles}
                    style={{
                      flex: 1,
                      minWidth: '160px',
                      background: 'rgba(255, 255, 255, 0.1)',
                      border: '1px solid rgba(255, 255, 255, 0.2)',
                      color: '#f8fafc',
                      padding: '0.75rem 1rem',
                      borderRadius: '8px',
                      fontSize: '0.9rem',
                      fontWeight: 700,
                      cursor: 'pointer'
                    }}
                  >
                    💾 Keep Single Issues
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowCompletionModal(false)}
                  style={{
                    flex: 1,
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
              )}

              {onOpenComic && jobStatus.result.comic && (
                <button
                  type="button"
                  onClick={() => {
                    setShowCompletionModal(false);
                    onOpenComic(jobStatus.result!.comic);
                  }}
                  style={{
                    width: '100%',
                    background: 'linear-gradient(135deg, #3b82f6, #2563eb)',
                    border: 'none',
                    color: '#ffffff',
                    padding: '0.75rem 1rem',
                    borderRadius: '8px',
                    fontSize: '0.92rem',
                    fontWeight: 800,
                    cursor: 'pointer',
                    marginTop: '0.35rem'
                  }}
                >
                  📖 Read Omnibus Now
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
