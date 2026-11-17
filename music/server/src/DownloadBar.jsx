import { useState, useEffect, useCallback, useRef } from 'react';
import { Loader2, ListMusic, X, ChevronDown } from 'lucide-react';
import { api, subscribeToEvents } from './api';

const ACTIVE = new Set(['queued', 'running', 'downloading', 'uploading', 'resolving', 'indexing']);
const RUNNING_STATUSES = new Set(['running', 'downloading', 'uploading', 'resolving', 'indexing']);

/**
 * Persistent footer strip for the YouTube Music download queue.
 *
 * Progress is merged from the `ytm_progress` stream; the queue snapshot comes
 * from `music_jobs` events plus a slow poll so a missed SSE frame never leaves
 * the bar stuck.
 */
export default function DownloadBar({ hasPlayer, onOpenQueue, onActiveChange }) {
  const [jobs, setJobs] = useState([]);
  const [dismissed, setDismissed] = useState(false);
  const jobsRef = useRef([]);
  jobsRef.current = jobs;

  const refresh = useCallback(async () => {
    try {
      const data = await api.musicJobs();
      setJobs(Array.isArray(data?.jobs) ? data.jobs : []);
    } catch { /* transient; the next event or poll recovers */ }
  }, []);

  useEffect(() => {
    refresh();
    const off = subscribeToEvents({
      music_jobs: (payload) => {
        if (Array.isArray(payload.jobs)) setJobs(payload.jobs);
        else refresh();
      },
      download_status: (payload) => {
        if (payload?.kind === 'music') {
          setJobs((prev) => {
            const index = prev.findIndex((j) => j.id === payload.jobId);
            const isRun = ['downloading', 'uploading', 'indexing', 'resolving'].includes(payload.status);
            const mapped = {
              ...(index >= 0 ? prev[index] : {}),
              id: payload.jobId,
              type: 'torrent',
              kind: 'music',
              title: payload.album || payload.title || 'Music Release',
              artist: payload.artist || 'Unknown Artist',
              album: payload.album || payload.title,
              coverUrl: payload.coverUrl || prev[index]?.coverUrl || null,
              status: isRun ? 'running' : payload.status,
              rawStatus: payload.status,
              phase: payload.phase || payload.message || 'Downloading',
              percent: payload.percent || 0,
              current: payload.message || ''
            };
            if (index >= 0) {
              const next = [...prev];
              next[index] = mapped;
              return next;
            }
            return [mapped, ...prev];
          });
        }
      },
      ytm_progress: (payload) => {
        if (!payload?.jobId) return;
        setJobs((prev) => prev.map((j) => (j.id === payload.jobId ? { ...j, ...payload } : j)));
      }
    });
    const timer = setInterval(refresh, 8000);
    return () => {
      off();
      clearInterval(timer);
    };
  }, [refresh]);

  // Once the queue drains, allow the bar to reappear for the next batch.
  useEffect(() => { if (!jobs.some((j) => ACTIVE.has(j.status))) setDismissed(false); }, [jobs]);

  const active = jobs.filter((j) => ACTIVE.has(j.status));

  useEffect(() => {
    onActiveChange?.(active.length > 0 && !dismissed);
  }, [active.length, dismissed, onActiveChange]);

  if (!active.length || dismissed) return null;

  const running = active.find((j) => RUNNING_STATUSES.has(j.status));
  const waiting = active.filter((j) => j.status === 'queued');
  const focus = running || waiting[0];
  const percent = running ? Math.min(100, Math.max(0, Number(running.percent) || 0)) : 0;
  const label = running
    ? (running.current ? `${running.phase} · ${running.current}` : running.phase || 'Downloading')
    : `Queued · ${waiting.length} item${waiting.length === 1 ? '' : 's'} waiting`;

  const cancel = () => {
    if (running) api.cancelMusicJob(running.id).catch(() => {});
    else if (focus) api.cancelMusicJob(focus.id).catch(() => {});
  };

  return (
    <div className={`download-bar ${hasPlayer ? 'has-player' : ''}`}>
      <button type="button" className="download-bar-open" onClick={onOpenQueue} title="Open downloads">
        <ListMusic size={15} />
      </button>
      <div className="download-bar-info">
        <span className="download-bar-title">{focus.artist ? `${focus.artist} — ${focus.title}` : focus.title || 'Music download'}</span>
        <span className="download-bar-phase">{label}</span>
      </div>
      <div className="download-bar-progress">
        <div className="download-bar-fill" style={{ width: `${percent}%` }} />
      </div>
      <span className="download-bar-percent">{running ? `${Math.round(percent)}%` : ''}</span>
      <Loader2 size={15} className="spin" />
      <button type="button" className="icon-btn" onClick={cancel} title="Cancel current download">
        <X size={14} />
      </button>
      <button
        type="button"
        className="icon-btn"
        onClick={() => setDismissed(true)}
        title="Hide the download bar (downloads keep running)"
      >
        <ChevronDown size={14} />
      </button>
    </div>
  );
}