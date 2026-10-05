import { useState, useEffect, useCallback } from 'react';
import { Play, Clock, History, Trash2 } from 'lucide-react';
import { api } from './api';
import { formatDuration, formatLengthShort, formatAgo, percentOf } from './format';

/**
 * "Continue listening" for audiobooks and "Recently played" for music, backed
 * by GET /api/progress/continue.
 *
 * Audiobooks show only genuinely resumable items (the server excludes anything
 * past 98%). Music is a play history: the last 50 songs, most recently played
 * first - a finished song stays on the list because it is still "recently
 * played", not because it needs resuming.
 */
export default function ContinueListening({ kind = 'audiobooks', libraryVersion, onPlay, onNavigate }) {
  const isMusic = kind === 'music';
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [context, setContext] = useState([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const list = await api.continueListening(kind);
        if (cancelled) return;
        const safe = Array.isArray(list) ? list : [];
        setRows(safe);

        // The continue payload has no coverUrl-tagged items usable for the queue,
        // so rebuild the playable context from this library only.
        const data = await api.library(kind);
        if (!cancelled) setContext(data?.items || []);
      } catch (err) {
        if (!cancelled) setError(err.message || 'Could not load your progress.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [kind, libraryVersion]);

  const remove = useCallback(async (row) => {
    try {
      await api.clearProgress(row.itemId);
      setRows((prev) => prev.filter((r) => r.itemId !== row.itemId));
    } catch {
      // The row stays put; the next refresh will reconcile it.
    }
  }, []);

  const playRow = useCallback((row) => {
    const full = context.find((i) => i.id === row.itemId) || row;
    onPlay(
      { ...full, id: row.itemId, coverUrl: full.coverUrl || api.coverUrl(row.itemId) },
      context.length ? context : undefined
    );
  }, [context, onPlay]);

  if (loading) {
    return (
      <div className="loading-state">
        <div className="spinner" />
        <p>Loading your progress…</p>
      </div>
    );
  }

  return (
    <>
      <div className="view-header">
        <h1 className="view-title">{isMusic ? 'Recently played' : 'Continue listening'}</h1>
        <p className="view-subtitle">
          {isMusic
            ? (rows.length > 0 ? 'Your last 50 songs, most recently played first.' : 'Play something and it will show up here.')
            : (rows.length > 0 ? 'Pick up exactly where you stopped.' : 'Nothing half-finished yet.')}
        </p>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {rows.length === 0 ? (
        <div className="empty-state">
          {isMusic
            ? <History size={40} style={{ color: 'var(--text-muted)', margin: '0 auto 1rem' }} />
            : <Clock size={40} style={{ color: 'var(--text-muted)', margin: '0 auto 1rem' }} />}
          <h3>{isMusic ? 'No songs played yet' : 'No books in progress'}</h3>
          <p>
            {isMusic
              ? 'Play something from your library or New Releases and FRAUDIO keeps your last 50 songs here.'
              : 'Start something from your library and FRAUDIO will remember your place automatically.'}
          </p>
          <button type="button" className="btn btn-primary" onClick={() => onNavigate('library')}>
            Browse library
          </button>
        </div>
      ) : (
        <div className="row-list">
          {rows.map((row) => {
            const remaining = Math.max(0, (row.durationSec || 0) - row.positionSec);
            return (
              <div key={row.itemId} className="row-item">
                <img className="row-thumb" src={row.coverUrl} alt="" loading="lazy" />
                <div className="row-meta" onClick={() => playRow(row)} style={{ cursor: 'pointer' }}>
                  <div className="row-title">{row.title}</div>
                  <div className="row-subtitle">
                    {row.author || (isMusic ? 'Unknown artist' : 'Unknown author')}
                    {isMusic && row.album ? ` · ${row.album}` : ''}
                    {isMusic
                      ? ` · played ${formatAgo(row.lastPlayed) || 'recently'}`
                      : (remaining > 0 ? ` · ${formatLengthShort(remaining)} left` : '')}
                    {!isMusic ? ` · resume at ${formatDuration(row.positionSec)}` : ''}
                  </div>
                  {!isMusic && (
                    <div className="media-progress" style={{ maxWidth: 260 }}>
                      <div className="media-progress-fill" style={{ width: `${percentOf(row.positionSec, row.durationSec) || 0}%` }} />
                    </div>
                  )}
                </div>
                <div className="row-aside">
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => playRow(row)}>
                    <Play size={13} fill="currentColor" />
                    {isMusic ? 'Play' : 'Resume'}
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    title={isMusic ? 'Remove from history' : 'Remove from Continue listening'}
                    onClick={() => remove(row)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}