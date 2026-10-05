import { useState, useEffect, useCallback } from 'react';
import { Download, X, Server, RefreshCw, FolderOpen, Music4 } from 'lucide-react';
import { api, subscribeToEvents } from './api';

const ACTIVE_STATUSES = ['queued', 'resolving', 'downloading', 'uploading', 'indexing'];
const MUSIC_ACTIVE = ['queued', 'running'];

/**
 * Downloads, split by library like everything else:
 *
 * - Audiobooks arrive via the remote torrent node, so this side shows the
 *   node's health, its active jobs and history.
 * - Music arrives via the YouTube Music queue (yt-dlp in this process), so
 *   that side shows only the queue - a torrent node has nothing to do with it.
 */
export default function Downloads({ kind = 'audiobooks', user, libraryVersion, onOpenDrivePicker, onNavigate, notify }) {
  const isMusic = kind === 'music';
  const userId = user?.id;
  const hasFolder = isMusic ? Boolean(user?.musicFolderId) : Boolean(user?.audiobooksFolderId);

  // ---- audiobooks: torrent jobs + node ----
  const [jobs, setJobs] = useState([]);
  const [history, setHistory] = useState([]);
  const [node, setNode] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // ---- music: the download queue ----
  const [musicJobs, setMusicJobs] = useState([]);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const data = await api.downloads();
      setJobs(Array.isArray(data.jobs) ? data.jobs : []);
      setHistory(Array.isArray(data.history) ? data.history : []);
      setError(null);
    } catch (err) {
      if (!quiet) setError(err.message || 'Could not load downloads.');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  const loadMusic = useCallback(async () => {
    try {
      const data = await api.musicJobs();
      setMusicJobs(Array.isArray(data?.jobs) ? data.jobs : []);
    } catch { /* the event stream recovers it */ }
  }, []);

  useEffect(() => {
    if (isMusic) {
      loadMusic();
      return undefined;
    }
    load();
    let cancelled = false;
    (async () => {
      try {
        const health = await api.torrentNode();
        if (!cancelled) setNode(health);
      } catch {
        if (!cancelled) setNode({ online: false, error: 'Unreachable' });
      }
    })();
    return () => { cancelled = true; };
  }, [isMusic, load, loadMusic, libraryVersion]);

  // Live progress straight off the server's event stream.
  useEffect(() => {
    if (!userId) return undefined;
    return subscribeToEvents({
      download_status: (payload) => {
        if (payload.userId !== userId) return;
        setJobs((prev) => {
          const index = prev.findIndex((j) => j.id === payload.jobId);
          const merged = { ...(index >= 0 ? prev[index] : {}), ...payload, id: payload.jobId };
          if (index >= 0) {
            const next = [...prev];
            next[index] = merged;
            return next;
          }
          return [merged, ...prev];
        });
      },
      music_jobs: (payload) => {
        if (Array.isArray(payload.jobs)) setMusicJobs(payload.jobs);
        else loadMusic();
      },
      ytm_progress: (payload) => {
        if (!payload?.jobId) return;
        setMusicJobs((prev) => {
          const index = prev.findIndex((j) => j.id === payload.jobId);
          if (index < 0) return prev;
          const next = [...prev];
          next[index] = { ...next[index], ...payload };
          return next;
        });
      }
    });
  }, [userId, loadMusic]);

  const cancel = useCallback(async (job) => {
    try {
      await api.cancelDownload(job.id);
      await load(true);
    } catch (err) {
      notify('Could not cancel download', err.message, true);
    }
  }, [load, notify]);

  const cancelMusic = useCallback(async (job) => {
    try {
      await api.cancelMusicJob(job.id);
      await loadMusic();
    } catch (err) {
      notify('Could not cancel download', err.message, true);
    }
  }, [loadMusic, notify]);

  if (isMusic) {
    const musicActive = musicJobs.filter((j) => MUSIC_ACTIVE.includes(j.status));
    const musicFinished = musicJobs.filter((j) => !MUSIC_ACTIVE.includes(j.status));

    return (
      <>
        <div className="view-header">
          <h1 className="view-title">Downloads</h1>
          <p className="view-subtitle">YouTube Music queue - songs and playlists downloaded straight into Drive.</p>
        </div>

        {!hasFolder && (
          <div className="job-card">
            <div className="job-head">
              <div>
                <div className="job-title">No music folder connected</div>
                <div className="job-phase">Finished downloads need a Drive folder to be written into.</div>
              </div>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => onOpenDrivePicker('music')}>
                <FolderOpen size={14} />
                Choose folder
              </button>
            </div>
          </div>
        )}

        <div className="toolbar">
          <button type="button" className="btn btn-secondary btn-sm" onClick={loadMusic}>
            <RefreshCw size={14} />
            Refresh
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => onNavigate('whats-new')}>
            <Music4 size={14} />
            Find music
          </button>
        </div>

        {musicActive.length === 0 && musicFinished.length === 0 ? (
          <div className="empty-state">
            <Music4 size={40} style={{ color: 'var(--text-muted)', margin: '0 auto 1rem' }} />
            <h3>Queue is empty</h3>
            <p>Save an album, song or playlist from What&apos;s New and it will appear here with live progress.</p>
          </div>
        ) : (
          <div className="row-list">
            {[...musicActive, ...musicFinished].map((job) => (
              <div className="row-item" key={job.id}>
                <div className="row-thumb-placeholder"><Music4 size={16} /></div>
                <div className="row-meta">
                  <div className="row-title">{job.artist ? `${job.artist} — ${job.title}` : job.title}</div>
                  <div className="row-subtitle">
                    {job.status === 'queued' ? `Queued${job.position ? ` · #${job.position}` : ''}`
                      : job.status === 'running' ? `${job.phase || 'Working'}${job.current ? ` · ${job.current}` : ''} · ${Math.round(job.percent || 0)}%`
                        : job.status === 'done' ? 'Saved to Drive'
                          : (job.error || 'Failed')}
                    {job.status === 'done' && job.where?.skipped ? ` · ${job.where.skipped} skipped` : ''}
                  </div>
                  {job.status === 'running' && (
                    <div className="job-bar" style={{ marginTop: 4 }}>
                      <div className="job-bar-fill" style={{ width: `${Math.max(2, job.percent || 0)}%` }} />
                    </div>
                  )}
                </div>
                {MUSIC_ACTIVE.includes(job.status) ? (
                  <button type="button" className="btn btn-danger btn-sm" onClick={() => cancelMusic(job)}>
                    <X size={13} />
                    Cancel
                  </button>
                ) : (
                  <span className={`badge ${job.status === 'done' ? 'badge-success' : 'badge-danger'}`}>
                    {job.status === 'done' ? 'Saved' : 'Failed'}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </>
    );
  }

  // ---- audiobooks ----
  const activeJobs = jobs.filter((j) => ACTIVE_STATUSES.includes(j.status));
  const finishedJobs = jobs.filter((j) => !ACTIVE_STATUSES.includes(j.status));

  return (
    <>
      <div className="view-header">
        <h1 className="view-title">Downloads</h1>
        <p className="view-subtitle">Torrents fetched by your node, uploaded straight into Drive.</p>
      </div>

      {!hasFolder && (
        <div className="job-card">
          <div className="job-head">
            <div>
              <div className="job-title">No audiobooks folder connected</div>
              <div className="job-phase">Finished downloads need a Drive folder to be written into.</div>
            </div>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => onOpenDrivePicker('audiobooks')}>
              <FolderOpen size={14} />
              Choose folder
            </button>
          </div>
        </div>
      )}

      <div className="panel">
        <div className="panel-title">Torrent node</div>
        <div className="stat-grid">
          <div className="stat-card">
            <div className="stat-value" style={{ fontSize: '1rem', color: node?.online ? 'var(--accent-color)' : 'var(--danger)' }}>
              {node ? (node.online ? 'Online' : 'Offline') : 'Checking…'}
            </div>
            <div className="stat-label">Status</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{node?.activeCount ?? 0}</div>
            <div className="stat-label">Active</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{node?.queuedCount ?? 0}</div>
            <div className="stat-label">Queued</div>
          </div>
          <div className="stat-card">
            <div className="stat-value" style={{ fontSize: '1rem' }}>
              {node?.error || (node?.online ? <Server size={18} /> : '—')}
            </div>
            <div className="stat-label">Detail</div>
          </div>
        </div>
      </div>

      <div className="toolbar">
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => load()}>
          <RefreshCw size={14} />
          Refresh
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => onNavigate('whats-new')}>
          <Download size={14} />
          Find releases
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {loading ? (
        <div className="loading-state">
          <div className="spinner" />
          <p>Loading downloads…</p>
        </div>
      ) : (
        <>
          <div className="section-head">
            <span className="section-title">In progress</span>
            <span className="section-count">{activeJobs.length}</span>
          </div>

          {activeJobs.length === 0 ? (
            <div className="empty-state">
              <Download size={40} style={{ color: 'var(--text-muted)', margin: '0 auto 1rem' }} />
              <h3>No active downloads</h3>
              <p>Pick a release from What&apos;s New and it will appear here with live progress.</p>
            </div>
          ) : (
            activeJobs.map((job) => (
              <div className="job-card" key={job.id}>
                <div className="job-head">
                  <div style={{ minWidth: 0 }}>
                    <div className="job-title">{job.title || 'Resolving release…'}</div>
                    <div className="job-phase">
                      {job.phase || job.status}
                      {job.message ? ` · ${job.message}` : ''}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    onClick={() => cancel(job)}
                    title="Cancel download"
                  >
                    <X size={13} />
                    Cancel
                  </button>
                </div>
                <div className="job-bar">
                  <div className="job-bar-fill" style={{ width: `${Math.max(2, job.percent || 0)}%` }} />
                </div>
              </div>
            ))
          )}

          {finishedJobs.length > 0 && (
            <>
              <div className="section-head">
                <span className="section-title">Recent</span>
                <span className="section-count">{finishedJobs.length}</span>
              </div>
              <div className="row-list">
                {finishedJobs.slice(0, 12).map((job) => (
                  <div className="row-item" key={job.id}>
                    <div className="row-meta">
                      <div className="row-title">{job.title || 'Untitled release'}</div>
                      <div className="row-subtitle">{job.error || job.message || job.status}</div>
                    </div>
                    <span className={`badge ${job.status === 'done' ? 'badge-success' : 'badge-danger'}`}>
                      {job.status}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}

          {history.length > 0 && (
            <>
              <div className="section-head">
                <span className="section-title">History</span>
                <span className="section-count">{history.length}</span>
              </div>
              <div className="row-list">
                {history.slice(0, 20).map((entry) => (
                  <div className="row-item" key={entry.jobId}>
                    <div className="row-meta">
                      <div className="row-title">{entry.title || 'Untitled release'}</div>
                      <div className="row-subtitle">{entry.error || 'Completed'}</div>
                    </div>
                    <span className={`badge ${entry.status === 'done' ? 'badge-success' : 'badge-danger'}`}>
                      {entry.status}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}
