import React, { useState, useEffect } from 'react';
import { Search, X, Film, Tv, Play, RefreshCw, AlertCircle, HardDrive, Download, UploadCloud, Sparkles } from 'lucide-react';
import { useToast } from './Toast.jsx';

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

export default function SearchResults({ query, scope = 'unified', onClose, onPlayVideo, onOpenDownloads, library = {}, folders = null }) {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [results, setResults] = useState([]);
  const [error, setError] = useState(null);
  const [streamingId, setStreamingId] = useState(null);
  const [downloadingId, setDownloadingId] = useState(null);

  const handleAddToWishlist = async (item) => {
    try {
      const res = await fetch('/api/wishlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: item.title,
          type: scope === 'movies' ? 'movie' : 'tv',
          quality: 'any',
          autoDownload: true
        })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        toast.success(`"${item.title}" added to Wish List! Feeds will be automatically monitored.`);
      } else {
        toast.info(data.error || `"${item.title}" is already in your Wish List.`);
      }
    } catch (err) {
      toast.error('Failed to add to Wish List: ' + err.message);
    }
  };

  const fetchResults = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch(`/api/torrent-search?q=${encodeURIComponent(query)}&type=${encodeURIComponent(scope === 'movies' ? 'movie' : 'tv')}`);
      if (!res.ok) throw new Error('Search failed');
      const data = await res.json();
      const list = (data.results || []).sort((a, b) => (b.seeds || 0) - (a.seeds || 0));
      setResults(list);
    } catch (err) {
      console.error('[Search] Error:', err);
      setError(err.message || 'Search failed');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (query) fetchResults();
  }, [query, scope]);

  const handleStreamTorrent = async (item) => {
    setStreamingId(item.id);
    try {
      const res = await fetch('/api/torrent/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: item.link || item.magnet })
      });
      const data = await res.json();
      if (res.ok && data.streamUrl) {
        onPlayVideo({
          title: item.title,
          streamUrl: data.streamUrl,
          type: scope === 'movies' ? 'movie' : 'tv'
        });
        if (onClose) onClose();
      } else {
        toast.error(data.error || 'Could not start stream for this torrent.');
      }
    } catch (err) {
      toast.error('Streaming request failed.');
    } finally {
      setStreamingId(null);
    }
  };

  const handleDownloadTorrent = async (item) => {
    const magnet = item.link || item.magnet;
    if (!magnet) {
      toast.error('No magnet link available for this release.');
      return;
    }

    const targetFolder = scope === 'movies' ? folders?.movies : folders?.tv;
    if (targetFolder?.canAddChildren === false) {
      toast.error(`Cannot download to Drive: Your ${scope === 'movies' ? 'Movies' : 'TV Shows'} folder ("${targetFolder.name || 'folder'}") is view-only (no edit access).`);
      return;
    }

    setDownloadingId(item.id);
    try {
      const res = await fetch('/api/downloads/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          magnet,
          title: item.title,
          kind: scope === 'movies' ? 'movie' : 'tv',
          meta: {
            genre: item.genre || undefined,
            year: item.year || undefined,
            cleanTitle: item.title || undefined
          },
          transcodeConfig: { enabled: true, targetHeight: '720', codec: 'h264', preset: 'veryfast', crf: '22' }
        })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        toast.success(`Started cloud download: "${item.title}". It will transcode and save to Google Drive!`);
        if (onOpenDownloads) {
          onOpenDownloads();
          if (onClose) onClose();
        }
      } else {
        toast.error(data.error || 'Failed to start cloud download.');
      }
    } catch (err) {
      toast.error('Network error requesting download: ' + err.message);
    } finally {
      setDownloadingId(null);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.85)',
        backdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        padding: '16px'
      }}
      onClick={onClose}
    >
      <div
        className="glass-panel"
        style={{
          width: '100%',
          maxWidth: '760px',
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: '16px',
          overflow: 'hidden',
          background: '#121218',
          border: '1px solid var(--border-color)',
          boxShadow: '0 24px 64px rgba(0, 0, 0, 0.9)'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: '11px', color: 'var(--primary)', fontWeight: 700, textTransform: 'uppercase' }}>Available Streams</div>
            <h2 style={{ fontSize: '18px', fontWeight: 700, margin: '2px 0 0', color: 'var(--text-primary)' }}>{query}</h2>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
            <X size={20} />
          </button>
        </div>

        {/* Results List */}
        <div style={{ padding: '16px 20px', flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {loading ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '48px 0', gap: '10px' }}>
              <RefreshCw size={24} className="spin" style={{ color: 'var(--primary)' }} />
              <div style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>Searching available streams for "{query}"...</div>
            </div>
          ) : error ? (
            <div style={{ textAlign: 'center', padding: '36px', color: 'var(--accent)' }}>
              <AlertCircle size={28} style={{ marginBottom: '8px' }} />
              <div>{error}</div>
              <button className="action-btn" onClick={fetchResults} style={{ marginTop: '12px' }}>Retry Search</button>
            </div>
          ) : results.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--text-muted)', fontSize: '13.5px' }}>
              No active streams found for "{query}". Try checking your Google Drive library or searching for the exact release title.
            </div>
          ) : (
            results.map(item => (
              <div
                key={item.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '12px 16px',
                  borderRadius: '10px',
                  background: 'rgba(255, 255, 255, 0.03)',
                  border: '1px solid var(--border-color)',
                  gap: '12px'
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: '13.5px', fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.title}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                    {item.quality && <span style={{ padding: '1px 5px', borderRadius: '3px', background: 'rgba(139, 92, 246, 0.15)', color: 'var(--primary)', fontWeight: 700 }}>{item.quality}</span>}
                    {item.size > 0 && <span>{formatBytes(item.size)}</span>}
                    {item.seeds !== undefined && <span style={{ color: item.seeds > 0 ? '#34d399' : 'var(--text-muted)' }}>{item.seeds} seeders</span>}
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                  <button
                    className="action-btn"
                    onClick={() => handleAddToWishlist(item)}
                    title="Add to Wish List for automatic download and transcoding"
                    style={{
                      padding: '6px 10px',
                      fontSize: '12px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '5px',
                      background: 'rgba(168, 85, 247, 0.15)',
                      color: '#d8b4fe',
                      border: '1px solid rgba(168, 85, 247, 0.3)',
                      borderRadius: '8px'
                    }}
                  >
                    <Sparkles size={13} />
                    <span>Wish List</span>
                  </button>

                  {(() => {
                    const targetFolder = scope === 'movies' ? folders?.movies : folders?.tv;
                    const isFolderReadOnly = targetFolder?.canAddChildren === false;
                    return (
                      <button
                        className="action-btn"
                        onClick={() => handleDownloadTorrent(item)}
                        disabled={downloadingId === item.id || streamingId === item.id || isFolderReadOnly}
                        title={isFolderReadOnly ? 'Target Google Drive folder is view-only (downloads disabled)' : 'Download, transcode, and save to your Google Drive library'}
                        style={{
                          padding: '6px 12px',
                          fontSize: '12px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '5px',
                          background: isFolderReadOnly ? 'rgba(255, 255, 255, 0.04)' : 'rgba(59, 130, 246, 0.15)',
                          color: isFolderReadOnly ? 'var(--text-muted)' : '#60a5fa',
                          border: isFolderReadOnly ? '1px solid rgba(255, 255, 255, 0.08)' : '1px solid rgba(59, 130, 246, 0.3)',
                          borderRadius: '8px',
                          fontWeight: 600,
                          cursor: isFolderReadOnly ? 'not-allowed' : 'pointer',
                          opacity: isFolderReadOnly ? 0.6 : 1
                        }}
                      >
                        {isFolderReadOnly ? (
                          <>
                            <UploadCloud size={13} style={{ opacity: 0.5 }} />
                            <span>View-Only</span>
                          </>
                        ) : (
                          <>
                            <UploadCloud size={13} />
                            {downloadingId === item.id ? 'Adding...' : 'Save to Drive'}
                          </>
                        )}
                      </button>
                    );
                  })()}

                  <button
                    className="action-btn primary"
                    onClick={() => handleStreamTorrent(item)}
                    disabled={streamingId === item.id || downloadingId === item.id}
                    style={{ padding: '6px 14px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}
                  >
                    <Play size={12} fill="#000" />
                    {streamingId === item.id ? 'Connecting...' : 'Stream'}
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
