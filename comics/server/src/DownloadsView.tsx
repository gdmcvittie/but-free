import React, { useState, useEffect, useRef } from 'react';
import { apiUrl, downloadComic } from './api';
import type { GoogleUserProfile } from './AuthModal';

interface LibrarySeries {
  series: string;
  count: number;
  ownedSummary: string;
}

interface PullListIssue {
  series: string;
  title: string;
  chapterUrl: string;
  size: string;
  year: string;
  status: 'pending' | 'downloaded' | 'skipped' | 'error';
  error?: string;
}

interface PullListResults {
  checked: number;
  downloaded: number;
  skipped: number;
  errors: number;
  issues: PullListIssue[];
  timestamp: string;
  message: string;
}

interface PullListStatus {
  series: string[];
  enabled: boolean;
  lastCheck: string | null;
  lastResults: PullListResults | null;
}

interface ScrapeInfo {
  title: string;
  coverUrl: string | null;
  downloadUrl?: string;
  size?: string;
  year?: string;
  chapterUrl: string;
}

interface DownloadsViewProps {
  user: GoogleUserProfile | null;
  initialUrl?: string | null;
  onOpenAuthModal: () => void;
  onOpenDrivePicker: () => void;
  onComicDownloaded?: () => void;
}

export default function DownloadsView({
  user,
  initialUrl,
  onOpenAuthModal,
  onOpenDrivePicker,
  onComicDownloaded
}: DownloadsViewProps) {
  const [activeTab, setActiveTab] = useState<'pullList' | 'direct'>(initialUrl ? 'direct' : 'pullList');

  // --- Pull List State ---
  const [librarySeries, setLibrarySeries] = useState<LibrarySeries[]>([]);
  const [loadingSeries, setLoadingSeries] = useState(false);
  const [seriesFilter, setSeriesFilter] = useState('');
  const [selectedSeries, setSelectedSeries] = useState<Set<string>>(new Set());
  const [pullListStatus, setPullListStatus] = useState<PullListStatus | null>(null);
  const [savingPullList, setSavingPullList] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkMessage, setCheckMessage] = useState<string | null>(null);

  // --- Direct URL Downloader State ---
  const [url, setUrl] = useState(initialUrl || '');
  const [inspecting, setInspecting] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [inspectData, setInspectData] = useState<ScrapeInfo | null>(null);
  const [directMessage, setDirectMessage] = useState<string | null>(null);
  const [isSuccess, setIsSuccess] = useState(false);

  // Load series & pull list status
  useEffect(() => {
    setLoadingSeries(true);
    fetch(apiUrl('/api/library/series'))
      .then((res) => res.json())
      .then((data) => {
        setLibrarySeries(Array.isArray(data) ? data : []);
      })
      .catch(() => {})
      .finally(() => setLoadingSeries(false));

    fetch(apiUrl('/api/pull-list/status'))
      .then((res) => res.json())
      .then((data: PullListStatus) => {
        setPullListStatus(data);
        if (Array.isArray(data.series)) {
          setSelectedSeries(new Set(data.series));
        }
      })
      .catch(() => {});
  }, [user?.id]);

  // Sync initialUrl
  useEffect(() => {
    if (initialUrl) {
      setUrl(initialUrl);
      setActiveTab('direct');
      handleInspectUrl(initialUrl);
    }
  }, [initialUrl]);

  const isSeriesSelected = (seriesName: string) => {
    if (selectedSeries.has(seriesName)) return true;
    const lower = seriesName.toLowerCase().trim();
    for (const item of selectedSeries) {
      if (item.toLowerCase().trim() === lower) return true;
    }
    return false;
  };

  const handleToggleSeries = (seriesName: string) => {
    const next = new Set<string>();
    const lowerName = seriesName.toLowerCase().trim();
    let found = false;
    for (const item of selectedSeries) {
      if (item === seriesName || item.toLowerCase().trim() === lowerName) {
        found = true;
      } else {
        next.add(item);
      }
    }
    if (!found) {
      next.add(seriesName);
    }
    setSelectedSeries(next);
  };

  const handleSavePullList = async () => {
    setSavingPullList(true);
    try {
      const res = await fetch(apiUrl('/api/pull-list'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ series: Array.from(selectedSeries) })
      });
      if (res.ok) {
        const data = await res.json();
        setPullListStatus(data);
        setCheckMessage('✅ Pull list saved successfully!');
        setTimeout(() => setCheckMessage(null), 3500);
      }
    } catch (err: any) {
      setCheckMessage(`Error saving: ${err.message}`);
    } finally {
      setSavingPullList(false);
    }
  };

  const handleAddAllFavorites = async () => {
    try {
      const candidates = new Set<string>();

      // 1. Scan localStorage for series favorites (all profiles & defaults)
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && (key.startsWith('comix_series_favorites') || key.includes('series_favorites'))) {
            const raw = localStorage.getItem(key);
            if (raw) {
              const parsed = JSON.parse(raw);
              if (Array.isArray(parsed)) {
                for (const item of parsed) {
                  if (typeof item === 'string' && item.trim()) {
                    candidates.add(item.trim());
                  }
                }
              }
            }
          }
        }
      } catch (e) {
        console.warn('[DownloadsView] Error reading localStorage series favorites:', e);
      }

      // 2. Fetch server series favorites
      try {
        const endpoints = ['/api/favorites/series'];
        if (user?.id) endpoints.push(`/api/favorites/series/${user.id}`);
        for (const ep of endpoints) {
          const res = await fetch(apiUrl(ep));
          if (res.ok) {
            const favSeries: string[] = await res.json();
            if (Array.isArray(favSeries)) {
              for (const s of favSeries) {
                if (typeof s === 'string' && s.trim()) {
                  candidates.add(s.trim());
                }
              }
            }
          }
        }
      } catch (e) {
        console.warn('[DownloadsView] Error fetching server series favorites:', e);
      }

      // 3. Scan for favorited comic issues (localStorage & server) to extract their series
      try {
        const favoriteComicIds = new Set<string>();
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && (key.startsWith('comix_favorites_') || key === 'comix_favorites')) {
            const raw = localStorage.getItem(key);
            if (raw) {
              const parsed = JSON.parse(raw);
              if (Array.isArray(parsed)) {
                for (const id of parsed) {
                  favoriteComicIds.add(String(id));
                }
              }
            }
          }
        }

        // Also check server comic favorites
        const resFavs = await fetch(apiUrl('/api/favorites')).catch(() => null);
        if (resFavs && resFavs.ok) {
          const serverFavs = await resFavs.json().catch(() => []);
          if (Array.isArray(serverFavs)) {
            for (const id of serverFavs) {
              favoriteComicIds.add(String(id));
            }
          }
        }

        // If we have favorite comic IDs, map them to series using /api/comics
        if (favoriteComicIds.size > 0) {
          const comicsRes = await fetch(apiUrl('/api/comics')).catch(() => null);
          if (comicsRes && comicsRes.ok) {
            const comicsList = await comicsRes.json().catch(() => []);
            if (Array.isArray(comicsList)) {
              for (const c of comicsList) {
                if (c && favoriteComicIds.has(String(c.id))) {
                  const s = (c.series || c.title || '').trim();
                  if (s && s !== 'Unsorted') {
                    candidates.add(s);
                  }
                }
              }
            }
          }
        }
      } catch (e) {
        console.warn('[DownloadsView] Error resolving comic issue favorites:', e);
      }

      if (candidates.size === 0) {
        setCheckMessage('ℹ️ No favorite series found. Click the heart (❤️) on any series or comic in your Library first!');
        setTimeout(() => setCheckMessage(null), 5000);
        return;
      }

      // 4. Smart canonical matching against librarySeries
      const resolved = new Set<string>();
      const addedNames: string[] = [];

      for (const cand of candidates) {
        const candLower = cand.toLowerCase();
        // Exact match
        const exactMatch = librarySeries.find((ls) => ls.series === cand);
        if (exactMatch) {
          resolved.add(exactMatch.series);
          continue;
        }

        // Case-insensitive match
        const caseMatch = librarySeries.find((ls) => ls.series.toLowerCase() === candLower);
        if (caseMatch) {
          resolved.add(caseMatch.series);
          continue;
        }

        // Substring / prefix match
        const subMatch = librarySeries.find(
          (ls) => ls.series.toLowerCase().includes(candLower) || candLower.includes(ls.series.toLowerCase())
        );
        if (subMatch) {
          resolved.add(subMatch.series);
          continue;
        }

        // Keep raw candidate if not in librarySeries
        resolved.add(cand);
      }

      const next = new Set(selectedSeries);
      for (const s of resolved) {
        if (!isSeriesSelected(s)) {
          next.add(s);
          addedNames.push(s);
        }
      }

      setSelectedSeries(next);

      // 5. Persist to pull list
      try {
        const saveRes = await fetch(apiUrl('/api/pull-list'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ series: Array.from(next) })
        });
        if (saveRes.ok) {
          const statusData = await saveRes.json().catch(() => null);
          if (statusData) setPullListStatus(statusData);
        }
      } catch (e) {
        console.warn('[DownloadsView] Pull list save warning:', e);
      }

      // 6. User feedback
      if (addedNames.length > 0) {
        const preview = addedNames.slice(0, 3).join(', ') + (addedNames.length > 3 ? ` +${addedNames.length - 3} more` : '');
        setCheckMessage(`❤️ Added ${addedNames.length} favorite series to your pull list (${preview})!`);
      } else {
        setCheckMessage(`ℹ️ All ${resolved.size} favorite series are already tracked on your pull list.`);
      }
      setTimeout(() => setCheckMessage(null), 5000);
    } catch (err: any) {
      setCheckMessage(`Error adding favorite series: ${err.message}`);
    }
  };

  const handleScanPullList = async (autoDownload = false) => {
    if (!user) {
      onOpenAuthModal();
      return;
    }
    if (!user.driveFolderId) {
      onOpenDrivePicker();
      return;
    }

    setChecking(true);
    setCheckMessage(null);
    try {
      // First save current selection
      await fetch(apiUrl('/api/pull-list'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ series: Array.from(selectedSeries) })
      });

      const res = await fetch(apiUrl('/api/pull-list/check'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoDownload })
      });

      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Scan failed');

      setCheckMessage(data.message || `Scan finished: found ${data.issues?.length || 0} issue(s).`);
      setPullListStatus((prev) => prev ? { ...prev, lastResults: data } : null);

      if (autoDownload && onComicDownloaded) {
        onComicDownloaded();
      }
    } catch (err: any) {
      setCheckMessage(`Scan failed: ${err.message}`);
    } finally {
      setChecking(false);
    }
  };

  // Direct URL inspect
  const handleInspectUrl = async (targetUrl?: string) => {
    const target = (targetUrl || url).trim();
    if (!target) return;

    setInspecting(true);
    setDirectMessage(null);
    setInspectData(null);

    try {
      const res = await fetch(apiUrl('/api/scrape/inspect'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: target })
      });

      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Could not inspect page');

      setInspectData(data);
    } catch (err: any) {
      setDirectMessage(`Error: ${err.message}`);
    } finally {
      setInspecting(false);
    }
  };

  const handleDownloadDirect = async () => {
    if (!user) {
      onOpenAuthModal();
      return;
    }
    if (!user.driveFolderId) {
      onOpenDrivePicker();
      return;
    }

    setDownloading(true);
    setDirectMessage('Downloading from GetComics mirror and uploading to Google Drive...');
    setIsSuccess(false);

    try {
      const data = await downloadComic(url, undefined, {
        onProgress: (s) => {
          if (s.message) {
            setDirectMessage(`⏳ ${s.message}${s.percent ? ` (${s.percent}%)` : ''}`);
          }
        }
      });

      setIsSuccess(true);
      setDirectMessage(`✅ Successfully saved "${data.title || inspectData?.title || 'Comic'}" to your Google Drive library!`);

      if (onComicDownloaded) {
        onComicDownloaded();
      }
    } catch (err: any) {
      setIsSuccess(false);
      setDirectMessage(`Download failed: ${err.message}`);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="downloads-view-container">
      {/* Header Tabs */}
      <div className="downloads-header">
        <div>
          <h1>⬇️ Downloads & Pull List</h1>
          <p className="downloads-subtitle">
            Manage your pull list for automatic issue tracking or download specific issues directly into Google Drive.
          </p>
        </div>

        <div className="downloads-tabs">
          <button
            type="button"
            className={`downloads-tab-btn ${activeTab === 'pullList' ? 'active' : ''}`}
            onClick={() => setActiveTab('pullList')}
          >
            📋 My Pull List
          </button>
          <button
            type="button"
            className={`downloads-tab-btn ${activeTab === 'direct' ? 'active' : ''}`}
            onClick={() => setActiveTab('direct')}
          >
            ⚡ Direct URL
          </button>
        </div>
      </div>

      {/* ========================================================================= */}
      {/* TAB 1: MY PULL LIST                                                       */}
      {/* ========================================================================= */}
      {activeTab === 'pullList' && (
        <div className="pull-list-tab-content">
          <div className="pull-list-controls-card">
            <div className="pull-list-controls-left">
              <h3>Series Tracking</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', margin: '0.25rem 0 1rem' }}>
                Select series to automatically check for new releases on GetComics.
              </p>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={handleAddAllFavorites}
                >
                  ❤️ Add Favorite Series
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setSelectedSeries(new Set(librarySeries.map((s) => s.series)))}
                >
                  Select All
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setSelectedSeries(new Set())}
                >
                  Deselect All
                </button>
              </div>
            </div>

            <div className="pull-list-controls-right">
              <div style={{ textAlign: 'right' }}>
                <span className="badge badge-success">
                  {selectedSeries.size} of {librarySeries.length} tracked
                </span>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={handleSavePullList}
                  disabled={savingPullList}
                >
                  {savingPullList ? 'Saving...' : 'Save List'}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => handleScanPullList(false)}
                  disabled={checking || selectedSeries.size === 0}
                >
                  {checking ? '⏳ Scanning...' : '🔍 Scan for New Issues'}
                </button>
              </div>
            </div>
          </div>

          {checkMessage && (
            <div className="info-banner" style={{ marginTop: '1rem' }}>
              {checkMessage}
            </div>
          )}

          {/* Series Selection Grid */}
          <div className="pull-list-series-section">
            <div style={{ marginBottom: '1rem' }}>
              <input
                type="text"
                className="input-field"
                placeholder="Filter series..."
                value={seriesFilter}
                onChange={(e) => setSeriesFilter(e.target.value)}
              />
            </div>

            {loadingSeries ? (
              <div className="library-loading-state">
                <div className="spinner" />
                <p>Loading library series...</p>
              </div>
            ) : librarySeries.length === 0 ? (
              <div className="library-empty-state">
                <p>No series in your library yet. Download some comics first!</p>
              </div>
            ) : (
              <div className="pull-list-series-grid">
                {librarySeries
                  .filter((s) => s.series.toLowerCase().includes(seriesFilter.toLowerCase()))
                  .map((s) => {
                    const isChecked = isSeriesSelected(s.series);
                    return (
                      <div
                        key={s.series}
                        className={`pull-list-item-card ${isChecked ? 'checked' : ''}`}
                        onClick={() => handleToggleSeries(s.series)}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => handleToggleSeries(s.series)}
                          onClick={(e) => e.stopPropagation()}
                          className="pull-list-checkbox"
                        />
                        <div className="pull-list-item-meta">
                          <span className="pull-list-series-title">{s.series}</span>
                          <span className="pull-list-series-count">{s.ownedSummary}</span>
                        </div>
                      </div>
                    );
                  })}
              </div>
            )}
          </div>

          {/* Scan Results Display */}
          {pullListStatus?.lastResults && (
            <div className="pull-list-results-section">
              <div className="pull-list-results-header">
                <h3>Latest Scan Results</h3>
                <span className="pull-list-timestamp">
                  Checked: {new Date(pullListStatus.lastResults.timestamp).toLocaleString()}
                </span>
              </div>

              {pullListStatus.lastResults.issues.length === 0 ? (
                <p style={{ color: 'var(--text-secondary)' }}>You're all caught up! No missing issues found.</p>
              ) : (
                <div className="pull-list-issues-list">
                  {pullListStatus.lastResults.issues.map((issue) => (
                    <div key={issue.chapterUrl} className="pull-list-issue-row">
                      <div className="pull-list-issue-info">
                        <strong>{issue.title}</strong>
                        <span className="pull-list-issue-meta">
                          Series: {issue.series} {issue.size ? `• ${issue.size}` : ''}
                        </span>
                      </div>

                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={async () => {
                          try {
                            setCheckMessage(`Downloading "${issue.title}" to Google Drive...`);
                            await downloadComic(issue.chapterUrl, issue.series);
                            setCheckMessage(`Saved "${issue.title}" to Google Drive!`);
                            if (typeof window !== 'undefined') {
                              window.dispatchEvent(new CustomEvent('comix_library_updated'));
                            }
                            if (onComicDownloaded) {
                              onComicDownloaded();
                            }
                          } catch (err: any) {
                            setCheckMessage(`Download failed: ${err.message}`);
                          }
                        }}
                      >
                        ⬇️ Download to Drive
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 2: DIRECT URL DOWNLOADER                                              */}
      {/* ========================================================================= */}
      {activeTab === 'direct' && (
        <div className="direct-downloader-tab-content">
          <div className="direct-downloader-card">
            <h3>Download GetComics Issue</h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', margin: '0.25rem 0 1.25rem' }}>
              Paste any comic issue page link from GetComics. The server will package it and save it straight into your Google Drive comic folder.
            </p>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleInspectUrl();
              }}
              className="direct-input-form"
            >
              <input
                type="url"
                className="input-field direct-url-input"
                placeholder="https://getcomics.org/other-comics/..."
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                required
              />
              <button
                type="submit"
                className="btn btn-secondary"
                disabled={inspecting || !url.trim()}
              >
                {inspecting ? 'Inspecting...' : 'Inspect Link'}
              </button>
            </form>

            {inspectData && (
              <div className="direct-preview-box">
                {inspectData.coverUrl && (
                  <img src={inspectData.coverUrl} alt={inspectData.title} className="direct-preview-cover" />
                )}
                <div className="direct-preview-details">
                  <h4>{inspectData.title}</h4>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                    {inspectData.year ? `Year: ${inspectData.year} • ` : ''}
                    {inspectData.size ? `Size: ${inspectData.size}` : ''}
                  </p>

                  <div style={{ marginTop: '1rem' }}>
                    <button
                      type="button"
                      className="btn btn-primary btn-lg"
                      onClick={handleDownloadDirect}
                      disabled={downloading}
                    >
                      {downloading ? '⏳ Downloading & Uploading to Drive...' : '⬇️ Save to Google Drive'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {directMessage && (
              <div className={isSuccess ? 'info-banner' : 'error-banner'} style={{ marginTop: '1.25rem' }}>
                {directMessage}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
