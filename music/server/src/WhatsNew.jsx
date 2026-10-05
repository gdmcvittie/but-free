import { useState, useEffect, useCallback } from 'react';
import { Download, Check, Sparkles, ExternalLink, ChevronLeft, ChevronRight } from 'lucide-react';
import { useSwipeBack } from './swipeBack';
import { api } from './api';

/**
 * Normalises the cover path the scraper returns.
 *
 * AudioBookBay serves art with a mix of absolute, protocol-relative and root
 * relative URLs, so resolve them against the host the server is actually
 * configured for rather than guessing one.
 */
function resolveCover(cover, baseUrl) {
  if (!cover) return null;
  if (cover.startsWith('https://') || cover.startsWith('http://')) return cover;
  if (!baseUrl) return null;
  if (cover.startsWith('//')) return `https:${cover}`;
  return `${baseUrl.replace(/\/$/, '')}${cover.startsWith('/') ? '' : '/'}${cover}`;
}

export default function WhatsNew({ user, libraryVersion, onOpenDrivePicker, onNavigate, notify }) {
  const [page, setPage] = useState(1);
  const [items, setItems] = useState([]);
  const [baseUrl, setBaseUrl] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const hasAudiobooksFolder = Boolean(user?.audiobooksFolderId);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const session = await api.abbSession();
        if (cancelled) return;
        setBaseUrl(session?.baseUrl || null);
      } catch {
        // Session lookup is non-critical for rendering.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const data = await api.whatsNew(page);
        if (!cancelled) setItems(Array.isArray(data.items) ? data.items : []);
      } catch (err) {
        if (!cancelled) setError(err.message || 'Could not reach AudioBookBay.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [page, libraryVersion]);

  const openDetail = useCallback(async (item) => {
    setDetail(item);
    setDetailLoading(true);
    try {
      const full = await api.abbDetail(item.url);
      setDetail({ ...item, ...full });
    } catch (err) {
      notify('Could not load release details', err.message, true);
    } finally {
      setDetailLoading(false);
    }
  }, [notify]);

  const closeDetail = useCallback(() => {
    setDetail(null);
    setDetailLoading(false);
  }, []);

  useSwipeBack(Boolean(detail), closeDetail);

  const startDownload = useCallback(async (item, releaseDetail) => {
    if (!hasAudiobooksFolder) {
      notify('Pick an audiobooks folder first', 'Downloads need a Drive folder to upload into.', true);
      onOpenDrivePicker('audiobooks');
      return;
    }
    try {
      await api.startDownload(item.url, releaseDetail || null);
      notify('Download started', item.title);
      closeDetail();
      onNavigate('downloads');
    } catch (err) {
      notify('Could not start download', err.message, true);
    }
  }, [hasAudiobooksFolder, notify, onNavigate, onOpenDrivePicker, closeDetail]);

  const markSeen = useCallback(async (ids) => {
    try {
      await api.markAbbSeen(ids);
      setItems((prev) => prev.map((i) => (ids.includes(i.id) ? { ...i, isNew: false } : i)));
    } catch {
      // Non-critical bookkeeping.
    }
  }, []);

  const newCount = items.filter((i) => i.isNew).length;

  return (
    <>
      <div className="view-header">
        <h1 className="view-title">What&apos;s New</h1>
        <p className="view-subtitle">
          Fresh releases from AudioBookBay
          {newCount > 0 ? ` · ${newCount} new to you` : ''}
        </p>
      </div>

      {!hasAudiobooksFolder && (
        <div className="job-card">
          <div className="job-head">
            <div>
              <div className="job-title">Connect your audiobooks folder</div>
              <div className="job-phase">Browsing works without it, but downloads need somewhere to land in Drive.</div>
            </div>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => onOpenDrivePicker('audiobooks')}>
              Choose folder
            </button>
          </div>
        </div>
      )}

      {error && <div className="error-banner">{error}</div>}

      {loading ? (
        <div className="loading-state">
          <div className="spinner" />
          <p>Checking AudioBookBay…</p>
        </div>
      ) : items.length === 0 ? (
        <div className="empty-state">
          <Sparkles size={40} style={{ color: 'var(--text-muted)', margin: '0 auto 1rem' }} />
          <h3>No releases listed</h3>
          <p>AudioBookBay returned no releases.</p>
        </div>
      ) : (
        <>
          <div className="media-grid">
            {items.map((item) => {
              const cover = resolveCover(item.cover, baseUrl);
              return (
              <div key={item.id} className="media-card" onClick={() => openDetail(item)}>
                <div className="media-cover">
                  {cover
                    ? <img src={cover} alt="" loading="lazy" referrerPolicy="no-referrer" />
                    : <div className="row-thumb-placeholder" style={{ width: '100%', height: '100%' }}><Sparkles size={22} /></div>}

                  <div className="media-badges">
                    {item.isNew && <span className="badge badge-new">New</span>}
                    {item.inLibrary && (
                      <span className="badge badge-success" style={{ marginLeft: 'auto' }} title="Already in your library">
                        <Check size={10} />
                      </span>
                    )}
                  </div>

                  <div className="media-play-overlay" style={{ gap: '0.6rem' }}>
                    <button
                      type="button"
                      className="media-play-button"
                      title="Download to Google Drive"
                      style={{ background: 'var(--accent-color)', color: '#000', border: 'none', cursor: 'pointer' }}
                      onClick={(e) => {
                        e.stopPropagation();
                        startDownload(item);
                      }}
                    >
                      <Download size={18} />
                    </button>
                    <div className="media-play-button" style={{ background: 'var(--panel-hover)', color: 'var(--text-primary)' }} title="View details">
                      <ExternalLink size={16} />
                    </div>
                  </div>
                </div>

                <div className="media-title">{item.title}</div>
                <div className="media-subtitle">
                  {[item.author, item.length || item.format].filter(Boolean).join(' · ')}
                </div>
              </div>
              );
            })}
          </div>

          <div className="toolbar" style={{ marginTop: '2rem', justifyContent: 'center' }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
            >
              <ChevronLeft size={15} />
              Newer
            </button>
            <span className="section-count">Page {page}</span>
            <button type="button" className="btn btn-secondary" onClick={() => setPage((p) => p + 1)}>
              Older
              <ChevronRight size={15} />
            </button>
          </div>
        </>
      )}

      {detail && (
        <div className="modal-backdrop" onClick={closeDetail}>
          <div className="modal-container wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2 style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {detail.title}
              </h2>
              <button type="button" className="modal-close-btn" onClick={closeDetail} aria-label="Close">✕</button>
            </div>

            <div className="modal-body">
              {detailLoading ? (
                <div className="loading-state">
                  <div className="spinner" />
                  <p>Reading release details…</p>
                </div>
              ) : (
                <>
                  {detail.summary && (
                    <p style={{ fontSize: '0.86rem', lineHeight: 1.65, color: 'var(--text-secondary)', marginBottom: '1.25rem' }}>
                      {detail.summary.replace(/<[^>]+>/g, ' ').slice(0, 600)}
                    </p>
                  )}

                  <div className="detail-list">
                    {detail.author && (
                      <div className="detail-row">
                        <span className="detail-label">Author</span>
                        <span className="detail-value">{detail.author}</span>
                      </div>
                    )}
                    {detail.narrator && (
                      <div className="detail-row">
                        <span className="detail-label">Narrator</span>
                        <span className="detail-value">{detail.narrator}</span>
                      </div>
                    )}
                    {detail.format && (
                      <div className="detail-row">
                        <span className="detail-label">Format</span>
                        <span className="detail-value">
                          {detail.format}
                          {detail.bitrate ? ` · ${detail.bitrate}` : ''}
                        </span>
                      </div>
                    )}
                    {detail.length && (
                      <div className="detail-row">
                        <span className="detail-label">Length</span>
                        <span className="detail-value">{detail.length}</span>
                      </div>
                    )}
                    {detail.abridged !== null && detail.abridged !== undefined && (
                      <div className="detail-row">
                        <span className="detail-label">Edition</span>
                        <span className="detail-value">{detail.abridged ? 'Abridged' : 'Unabridged'}</span>
                      </div>
                    )}
                    {detail.fileSizeMb ? (
                      <div className="detail-row">
                        <span className="detail-label">Size</span>
                        <span className="detail-value">{detail.fileSizeMb} MB</span>
                      </div>
                    ) : null}
                  </div>

                  {!detail.infoHash && (
                    <div className="error-banner" style={{ marginBottom: 0 }}>
                      This release does not publish a torrent info hash, so it cannot be added
                      automatically. Open it on AudioBookBay instead.
                    </div>
                  )}

                  {detail.files?.length > 0 && (
                    <>
                      <div className="panel-title" style={{ marginTop: '1.25rem' }}>Files</div>
                      <div className="detail-list">
                        {detail.files.map((file) => (
                          <div key={file} className="detail-row">
                            <span className="detail-value" style={{ fontSize: '0.8rem' }}>{file}</span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </>
              )}
            </div>

            <div className="modal-footer">
              <a
                className="btn btn-ghost"
                href={detail.url}
                target="_blank"
                rel="noopener noreferrer"
                style={{ marginRight: 'auto', textDecoration: 'none' }}
              >
                <ExternalLink size={14} />
                Open on AudioBookBay
              </a>
              {detail.isNew && (
                <button type="button" className="btn btn-secondary" onClick={() => markSeen([detail.id])}>
                  <Check size={14} />
                  Mark as seen
                </button>
              )}
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => startDownload(detail, detailLoading ? null : detail)}
                disabled={detailLoading}
              >
                <Download size={15} />
                Download to Drive
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}