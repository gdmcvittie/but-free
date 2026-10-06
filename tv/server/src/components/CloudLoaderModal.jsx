import React, { useState, useEffect, useRef } from 'react';
import {
  X,
  Download,
  UploadCloud,
  Film,
  Tv,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  HardDrive,
  Trash2,
  Clock,
  Sparkles,
  ArrowRight,
  ChevronRight,
  ExternalLink,
  Plus,
  Sliders,
  Settings,
  Rss
} from 'lucide-react';
import { useToast } from './Toast.jsx';

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return '0 KB/s';
  if (bytesPerSec < 1024 * 1024) {
    return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
  }
  return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
}

function formatTimeAgo(ts) {
  if (!ts) return '';
  const diffSec = Math.floor((Date.now() - ts) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

export default function CloudLoaderModal({ isOpen, onClose, folders, onJobAdded, onNavigateToFeeds }) {
  const toast = useToast();
  const [downloads, setDownloads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [showTranscodeOptions, setShowTranscodeOptions] = useState(false);

  // Form State
  const [magnetInput, setMagnetInput] = useState('');
  const [titleInput, setTitleInput] = useState('');
  const [kindInput, setKindInput] = useState('movie'); // 'movie' | 'tv'

  // Transcoding State
  const [enableTranscode, setEnableTranscode] = useState(true);
  const [targetHeight, setTargetHeight] = useState('720'); // '480' | '720' | '1080' | 'original'
  const [codec, setCodec] = useState('h264');
  const [preset, setPreset] = useState('veryfast');
  const [crf, setCrf] = useState('22');
  const [audioCodec, setAudioCodec] = useState('aac');
  const [audioBitrate, setAudioBitrate] = useState('128k');
  const [saveAsDefault, setSaveAsDefault] = useState(false);

  const pollIntervalRef = useRef(null);

  const fetchDefaultTranscode = async () => {
    try {
      const res = await fetch('/api/settings/transcode');
      if (res.ok) {
        const data = await res.json();
        if (data.settings) {
          setEnableTranscode(data.settings.enabled !== false);
          setTargetHeight(data.settings.targetHeight || '480');
          setCodec(data.settings.codec || 'h265');
          setPreset(data.settings.preset || 'veryfast');
          setCrf(data.settings.crf || '20');
          setAudioCodec(data.settings.audioCodec || 'aac');
          setAudioBitrate(data.settings.audioBitrate || '128k');
        }
      }
    } catch (_) {}
  };

  const fetchDownloads = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch('/api/downloads');
      if (res.ok) {
        const data = await res.json();
        setDownloads(Array.isArray(data.downloads) ? data.downloads : []);
      }
    } catch (err) {
      console.warn('[Cloud Loader] Failed to poll downloads:', err.message);
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchDefaultTranscode();
      fetchDownloads();
      pollIntervalRef.current = setInterval(() => {
        fetchDownloads(true);
      }, 2500);
    } else {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    }
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, [isOpen]);

  const handleAddDownload = async (e) => {
    if (e) e.preventDefault();
    const magnet = magnetInput.trim();
    if (!magnet) {
      toast.error('Please enter a magnet link or torrent URL');
      return;
    }

    const currentFolder = kindInput === 'tv' ? folders?.tv : folders?.movies;
    if (!currentFolder || !currentFolder.id) {
      toast.error(`Please configure your ${kindInput === 'tv' ? 'TV' : 'Movies'} folder in Settings first.`);
      return;
    }
    if (currentFolder.canAddChildren === false) {
      toast.error(`Cannot download to "${currentFolder.name}": this folder is view-only (no edit access).`);
      return;
    }

    setIsSubmitting(true);
    try {
      const transcodeConfig = {
        enabled: enableTranscode,
        targetHeight: targetHeight === 'original' ? 'original' : targetHeight,
        codec,
        preset,
        crf,
        audioCodec,
        audioBitrate
      };

      if (saveAsDefault) {
        fetch('/api/settings/transcode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(transcodeConfig)
        }).catch(() => {});
      }

      const res = await fetch('/api/downloads/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          magnet,
          title: titleInput.trim() || undefined,
          kind: kindInput,
          transcodeConfig
        })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        toast.success(`Started cloud download: "${data.job?.title || 'Torrent'}"`);
        setMagnetInput('');
        setTitleInput('');
        setShowAddForm(false);
        fetchDownloads();
        if (onJobAdded) onJobAdded(data.job);
      } else {
        toast.error(data.error || 'Failed to start download');
      }
    } catch (err) {
      toast.error('Network error starting download: ' + err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const [isClearingHistory, setIsClearingHistory] = useState(false);

  const handleClearHistory = async () => {
    if (isClearingHistory) return;
    setIsClearingHistory(true);
    try {
      const res = await fetch('/api/downloads/history', { method: 'DELETE' });
      const data = await res.json();
      if (res.ok && data.success) {
        toast.success(`Cleared download history`);
        setDownloads(prev => prev.filter(d => !['completed', 'error', 'cancelled'].includes(d.stage || d.status)));
        fetchDownloads(true);
      } else {
        toast.error('Failed to clear history');
      }
    } catch (err) {
      toast.error('Network error clearing history: ' + err.message);
    } finally {
      setIsClearingHistory(false);
    }
  };

  const handleRemoveHistoryItem = async (jobId) => {
    try {
      setDownloads(prev => prev.filter(d => d.id !== jobId));
      await fetch(`/api/downloads/${jobId}`, { method: 'DELETE' });
      toast.info('Item removed from history');
      fetchDownloads(true);
    } catch (_) {
      toast.error('Could not remove history item');
    }
  };

  const handleCancelJob = async (jobId) => {
    try {
      const res = await fetch(`/api/downloads/${jobId}/cancel`, { method: 'POST' });
      if (res.ok) {
        toast.info('Download cancelled');
        fetchDownloads(true);
      }
    } catch (_) {
      toast.error('Could not cancel download');
    }
  };

  if (!isOpen) return null;

  const activeJobs = downloads.filter(d => ['queued', 'queued_download', 'downloading', 'queued_transcode', 'transcoding', 'uploading'].includes(d.stage || d.status));
  const finishedJobs = downloads.filter(d => ['completed', 'error', 'cancelled'].includes(d.stage || d.status));

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
          maxWidth: '820px',
          maxHeight: '88vh',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: '16px',
          overflow: 'hidden',
          background: '#0e0e14',
          border: '1px solid var(--border-color)',
          boxShadow: '0 24px 64px rgba(0, 0, 0, 0.95)'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid var(--border-color)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            background: 'linear-gradient(180deg, rgba(255, 255, 255, 0.03) 0%, transparent 100%)'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div
              style={{
                width: '36px',
                height: '36px',
                borderRadius: '10px',
                background: 'linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#fff',
                boxShadow: '0 4px 12px rgba(59, 130, 246, 0.3)'
              }}
            >
              <UploadCloud size={20} />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <h2 style={{ fontSize: '17px', fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>Cloud Loader</h2>
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {onNavigateToFeeds && (
              <button
                className="action-btn"
                onClick={onNavigateToFeeds}
                title="Browse RSS Feeds"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontSize: '12px',
                  padding: '6px 12px',
                  borderRadius: '8px',
                  background: 'rgba(245, 158, 11, 0.12)',
                  color: '#fbbf24',
                  border: '1px solid rgba(245, 158, 11, 0.25)',
                  fontWeight: 600
                }}
              >
                <Rss size={13} />
                <span>RSS Feeds</span>
              </button>
            )}

            <button
              className="action-btn"
              onClick={() => setShowAddForm(!showAddForm)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                fontSize: '12px',
                padding: '6px 12px',
                borderRadius: '8px',
                background: showAddForm ? 'rgba(255, 255, 255, 0.08)' : 'var(--primary)',
                color: showAddForm ? 'var(--text-primary)' : '#000',
                border: showAddForm ? '1px solid var(--border-color)' : 'none',
                fontWeight: 600
              }}
            >
              {showAddForm ? <X size={14} /> : <Plus size={14} />}
              {showAddForm ? 'Close Form' : 'Add Magnet'}
            </button>
            <button
              onClick={onClose}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--text-muted)',
                cursor: 'pointer',
                display: 'flex',
                padding: '4px',
                borderRadius: '6px'
              }}
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Add Magnet Form (Collapsible) */}
        {showAddForm && (
          <form
            onSubmit={handleAddDownload}
            style={{
              padding: '16px 20px',
              background: 'rgba(255, 255, 255, 0.02)',
              borderBottom: '1px solid var(--border-color)',
              display: 'flex',
              flexDirection: 'column',
              gap: '12px'
            }}
          >
            <div>
              <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                Magnet URI or Torrent URL
              </label>
              <input
                type="text"
                placeholder="magnet:?xt=urn:btih:..."
                value={magnetInput}
                onChange={(e) => setMagnetInput(e.target.value)}
                style={{
                  width: '100%',
                  background: 'rgba(0, 0, 0, 0.4)',
                  border: '1px solid var(--border-color)',
                  borderRadius: '8px',
                  padding: '9px 12px',
                  color: 'var(--text-primary)',
                  fontSize: '13px'
                }}
                required
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                  Media Type
                </label>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <button
                    type="button"
                    onClick={() => setKindInput('movie')}
                    style={{
                      flex: 1,
                      padding: '8px',
                      borderRadius: '8px',
                      border: '1px solid',
                      borderColor: kindInput === 'movie' ? 'var(--primary)' : 'var(--border-color)',
                      background: kindInput === 'movie' ? 'rgba(139, 92, 246, 0.15)' : 'rgba(255, 255, 255, 0.02)',
                      color: kindInput === 'movie' ? 'var(--primary)' : 'var(--text-secondary)',
                      fontSize: '12px',
                      fontWeight: 600,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '4px'
                    }}
                  >
                    <Film size={13} />
                    Movie
                  </button>
                  <button
                    type="button"
                    onClick={() => setKindInput('tv')}
                    style={{
                      flex: 1,
                      padding: '8px',
                      borderRadius: '8px',
                      border: '1px solid',
                      borderColor: kindInput === 'tv' ? 'var(--primary)' : 'var(--border-color)',
                      background: kindInput === 'tv' ? 'rgba(139, 92, 246, 0.15)' : 'rgba(255, 255, 255, 0.02)',
                      color: kindInput === 'tv' ? 'var(--primary)' : 'var(--text-secondary)',
                      fontSize: '12px',
                      fontWeight: 600,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '4px'
                    }}
                  >
                    <Tv size={13} />
                    TV Show
                  </button>
                </div>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                  Resolution Preset
                </label>
                <select
                  value={targetHeight}
                  onChange={(e) => setTargetHeight(e.target.value)}
                  style={{
                    width: '100%',
                    background: 'rgba(0, 0, 0, 0.4)',
                    border: '1px solid var(--border-color)',
                    borderRadius: '8px',
                    padding: '8.5px 10px',
                    color: 'var(--text-primary)',
                    fontSize: '12px'
                  }}
                >
                  <option value="480">480p SD (Fastest / Lowest File Size - Recommended)</option>
                  <option value="720">720p HD (Roku/Mobile Optimized)</option>
                  <option value="1080">1080p Full HD</option>
                  <option value="original">Original (No Transcode)</option>
                </select>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                  Optional Title / Release Name
                </label>
                <input
                  type="text"
                  placeholder="e.g. Inception (2010)"
                  value={titleInput}
                  onChange={(e) => setTitleInput(e.target.value)}
                  style={{
                    width: '100%',
                    background: 'rgba(0, 0, 0, 0.4)',
                    border: '1px solid var(--border-color)',
                    borderRadius: '8px',
                    padding: '8px 10px',
                    color: 'var(--text-primary)',
                    fontSize: '12px'
                  }}
                />
              </div>
            </div>

            {/* Advanced Transcode Settings Toggle */}
            <div style={{ marginTop: '2px' }}>
              <button
                type="button"
                onClick={() => setShowTranscodeOptions(!showTranscodeOptions)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--primary)',
                  fontSize: '12px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '4px 0'
                }}
              >
                <Sliders size={13} />
                {showTranscodeOptions ? 'Hide Transcoding Settings' : 'Configure Transcoding Settings (Codec, CRF, Audio)'}
              </button>

              {showTranscodeOptions && (
                <div
                  style={{
                    marginTop: '8px',
                    padding: '14px',
                    borderRadius: '10px',
                    background: 'rgba(0, 0, 0, 0.3)',
                    border: '1px solid var(--border-color)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '12px'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <input
                      type="checkbox"
                      id="modalEnableTranscode"
                      checked={enableTranscode}
                      onChange={(e) => setEnableTranscode(e.target.checked)}
                      style={{ cursor: 'pointer' }}
                    />
                    <label htmlFor="modalEnableTranscode" style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)', cursor: 'pointer' }}>
                      Enable transcoding for this download
                    </label>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px', opacity: enableTranscode ? 1 : 0.4, pointerEvents: enableTranscode ? 'auto' : 'none' }}>
                    <div>
                      <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '4px' }}>Video Codec</label>
                      <select
                        value={codec}
                        onChange={(e) => setCodec(e.target.value)}
                        style={{ width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border-color)', borderRadius: '6px', padding: '6px 8px', color: 'var(--text-primary)', fontSize: '11.5px' }}
                      >
                        <option value="h264">H.264 (Most Compatible)</option>
                        <option value="h265">H.265 / HEVC</option>
                      </select>
                    </div>

                    <div>
                      <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '4px' }}>Speed Preset</label>
                      <select
                        value={preset}
                        onChange={(e) => setPreset(e.target.value)}
                        style={{ width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border-color)', borderRadius: '6px', padding: '6px 8px', color: 'var(--text-primary)', fontSize: '11.5px' }}
                      >
                        <option value="ultrafast">ultrafast</option>
                        <option value="superfast">superfast</option>
                        <option value="veryfast">veryfast (Default)</option>
                        <option value="faster">faster</option>
                        <option value="fast">fast</option>
                        <option value="medium">medium</option>
                      </select>
                    </div>

                    <div>
                      <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '4px' }}>CRF Quality: {crf}</label>
                      <input
                        type="range"
                        min="16"
                        max="28"
                        step="1"
                        value={crf}
                        onChange={(e) => setCrf(e.target.value)}
                        style={{ width: '100%', cursor: 'pointer', accentColor: 'var(--primary)', marginTop: '4px' }}
                      />
                    </div>

                    <div>
                      <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '4px' }}>Audio Codec</label>
                      <select
                        value={audioCodec}
                        onChange={(e) => setAudioCodec(e.target.value)}
                        style={{ width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border-color)', borderRadius: '6px', padding: '6px 8px', color: 'var(--text-primary)', fontSize: '11.5px' }}
                      >
                        <option value="aac">AAC Stereo</option>
                        <option value="copy">Copy Original</option>
                        <option value="libmp3lame">MP3</option>
                      </select>
                    </div>

                    <div>
                      <label style={{ display: 'block', fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '4px' }}>Audio Bitrate</label>
                      <select
                        value={audioBitrate}
                        onChange={(e) => setAudioBitrate(e.target.value)}
                        disabled={audioCodec === 'copy'}
                        style={{ width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border-color)', borderRadius: '6px', padding: '6px 8px', color: 'var(--text-primary)', fontSize: '11.5px' }}
                      >
                        <option value="96k">96 kbps</option>
                        <option value="128k">128 kbps</option>
                        <option value="192k">192 kbps</option>
                        <option value="256k">256 kbps</option>
                      </select>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', paddingTop: '16px' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={saveAsDefault}
                          onChange={(e) => setSaveAsDefault(e.target.checked)}
                          style={{ cursor: 'pointer' }}
                        />
                        Save as default for future downloads
                      </label>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {(() => {
              const currentFolder = kindInput === 'tv' ? folders?.tv : folders?.movies;
              const isFolderReadOnly = currentFolder?.canAddChildren === false;
              return (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '8px', marginTop: '4px' }}>
                  {isFolderReadOnly && (
                    <div style={{
                      padding: '8px 12px',
                      borderRadius: '8px',
                      background: 'rgba(245, 158, 11, 0.12)',
                      border: '1px solid rgba(245, 158, 11, 0.3)',
                      color: '#fbbf24',
                      fontSize: '12px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      alignSelf: 'stretch'
                    }}>
                      <AlertCircle size={15} style={{ flexShrink: 0 }} />
                      <span>
                        Target {kindInput === 'tv' ? 'TV Shows' : 'Movies'} folder (<strong>{currentFolder?.name}</strong>) is view-only. Downloads to this folder are disabled.
                      </span>
                    </div>
                  )}
                  <button
                    type="submit"
                    disabled={isSubmitting || isFolderReadOnly}
                    className="action-btn primary"
                    style={{
                      padding: '8px 20px',
                      fontSize: '13px',
                      fontWeight: 600,
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      background: isFolderReadOnly ? 'rgba(255, 255, 255, 0.05)' : undefined,
                      color: isFolderReadOnly ? 'var(--text-muted)' : undefined,
                      border: isFolderReadOnly ? '1px solid rgba(255, 255, 255, 0.1)' : undefined,
                      cursor: isFolderReadOnly ? 'not-allowed' : 'pointer',
                      opacity: isFolderReadOnly ? 0.6 : 1
                    }}
                  >
                    {isSubmitting ? (
                      <>
                        <RefreshCw size={14} className="spin" />
                        Sending to VPS...
                      </>
                    ) : isFolderReadOnly ? (
                      <>
                        <AlertCircle size={14} />
                        Folder is View-Only
                      </>
                    ) : (
                      <>
                        <Download size={14} />
                        Start Download to Drive
                      </>
                    )}
                  </button>
                </div>
              );
            })()}
          </form>
        )}

        {/* Content Body: Jobs List */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {/* Target Folder Reminder */}
          <div
            style={{
              padding: '10px 14px',
              borderRadius: '10px',
              background: 'rgba(255, 255, 255, 0.02)',
              border: '1px solid var(--border-color)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              fontSize: '12px',
              color: 'var(--text-secondary)'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <HardDrive size={15} style={{ color: 'var(--primary)' }} />
              <span>
                <strong>Drive Destinations:</strong> TV:{' '}
                <span style={{ color: 'var(--text-primary)' }}>
                  {folders?.tv?.name || 'Not set'}
                  {folders?.tv?.canAddChildren === false && (
                    <span style={{ color: '#fbbf24', fontSize: '10.5px', marginLeft: '4px', fontWeight: 600 }}>(View-Only)</span>
                  )}
                </span>
                {' '}&bull; Movies:{' '}
                <span style={{ color: 'var(--text-primary)' }}>
                  {folders?.movies?.name || 'Not set'}
                  {folders?.movies?.canAddChildren === false && (
                    <span style={{ color: '#fbbf24', fontSize: '10.5px', marginLeft: '4px', fontWeight: 600 }}>(View-Only)</span>
                  )}
                </span>
              </span>
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              Completed downloads automatically scan into your library
            </div>
          </div>

          {/* Active Queue Section */}
          <div>
            <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' }}>
              Active Queue ({activeJobs.length})
            </div>

            {loading && downloads.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '36px 0', color: 'var(--text-muted)', fontSize: '13px' }}>
                <RefreshCw size={22} className="spin" style={{ color: 'var(--primary)', marginBottom: '8px' }} />
                <div>Checking torrent streamer node...</div>
              </div>
            ) : activeJobs.length === 0 ? (
              <div
                style={{
                  padding: '28px 20px',
                  borderRadius: '10px',
                  border: '1px dashed var(--border-color)',
                  textAlign: 'center',
                  color: 'var(--text-muted)',
                  fontSize: '13px',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '10px'
                }}
              >
                <div>No active downloads right now. Paste a magnet link above or browse new releases from RSS feeds!</div>
                {onNavigateToFeeds && (
                  <button
                    className="action-btn"
                    onClick={onNavigateToFeeds}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      fontSize: '12px',
                      padding: '7px 14px',
                      borderRadius: '8px',
                      background: 'rgba(245, 158, 11, 0.15)',
                      color: '#fbbf24',
                      border: '1px solid rgba(245, 158, 11, 0.3)',
                      fontWeight: 600,
                      cursor: 'pointer'
                    }}
                  >
                    <Rss size={13} />
                    <span>Browse TV & Movie Feeds</span>
                  </button>
                )}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {activeJobs.map(job => (
                  <div
                    key={job.id}
                    style={{
                      background: 'rgba(255, 255, 255, 0.03)',
                      border: '1px solid var(--border-color)',
                      borderRadius: '12px',
                      padding: '14px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '10px'
                    }}
                  >
                    {/* Top Row: Title + Stage Pill + Cancel Button */}
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {job.title}
                        </div>
                        <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px' }}>
                          <span style={{ textTransform: 'capitalize' }}>{job.kind === 'tv' ? 'TV Show' : 'Movie'}</span>
                          <span>&bull;</span>
                          <span>{formatTimeAgo(job.createdAt)}</span>
                          {job.numPeers > 0 && (
                            <>
                              <span>&bull;</span>
                              <span style={{ color: '#34d399' }}>{job.numPeers} peers</span>
                            </>
                          )}
                          {job.downloadSpeed > 0 && (
                            <>
                              <span>&bull;</span>
                              <span style={{ color: '#60a5fa' }}>{formatSpeed(job.downloadSpeed)}</span>
                            </>
                          )}
                        </div>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        {/* Status Stage Pill */}
                        <div
                          style={{
                            padding: '4px 10px',
                            borderRadius: '20px',
                            fontSize: '11px',
                            fontWeight: 700,
                            display: 'flex',
                            alignItems: 'center',
                            gap: '5px',
                            background:
                              job.stage === 'downloading' ? 'rgba(59, 130, 246, 0.15)' :
                              job.stage === 'queued_transcode' ? 'rgba(234, 179, 8, 0.15)' :
                              job.stage === 'transcoding' ? 'rgba(168, 85, 247, 0.15)' :
                              job.stage === 'uploading' ? 'rgba(16, 185, 129, 0.15)' :
                              'rgba(255, 255, 255, 0.08)',
                            color:
                              job.stage === 'downloading' ? '#60a5fa' :
                              job.stage === 'queued_transcode' ? '#fde047' :
                              job.stage === 'transcoding' ? '#c084fc' :
                              job.stage === 'uploading' ? '#34d399' :
                              'var(--text-secondary)',
                            border: '1px solid',
                            borderColor:
                              job.stage === 'downloading' ? 'rgba(59, 130, 246, 0.3)' :
                              job.stage === 'queued_transcode' ? 'rgba(234, 179, 8, 0.3)' :
                              job.stage === 'transcoding' ? 'rgba(168, 85, 247, 0.3)' :
                              job.stage === 'uploading' ? 'rgba(16, 185, 129, 0.3)' :
                              'transparent'
                          }}
                        >
                          <RefreshCw size={11} className={['downloading', 'transcoding', 'uploading'].includes(job.stage) ? 'spin' : ''} />
                          {job.stage === 'downloading' ? `Downloading ${job.downloadPercent}%` :
                           job.stage === 'queued_transcode' ? (job.queuePosition ? `Transcode Queue (#${job.queuePosition})` : 'Queued for Transcode') :
                           job.stage === 'transcoding' ? `Transcoding ${job.transcodePercent}%` :
                           job.stage === 'uploading' ? `Uploading to Drive ${job.uploadPercent}%` :
                           (job.queuePosition ? `Download Queue (#${job.queuePosition})` : 'Queued for Download')}
                        </div>

                        <button
                          onClick={() => handleCancelJob(job.id)}
                          title="Cancel Job"
                          style={{
                            background: 'transparent',
                            border: '1px solid rgba(244, 63, 94, 0.3)',
                            color: '#fb7185',
                            padding: '5px 8px',
                            borderRadius: '6px',
                            cursor: 'pointer',
                            fontSize: '11px',
                            display: 'flex',
                            alignItems: 'center'
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>

                    {/* Progress Bar (3 Phase indicator) */}
                    <div>
                      <div
                        style={{
                          width: '100%',
                          height: '6px',
                          background: 'rgba(255, 255, 255, 0.08)',
                          borderRadius: '3px',
                          overflow: 'hidden',
                          position: 'relative'
                        }}
                      >
                        <div
                          style={{
                            height: '100%',
                            transition: 'width 0.4s ease',
                            background:
                              job.stage === 'downloading' ? 'linear-gradient(90deg, #3b82f6, #60a5fa)' :
                              job.stage === 'queued_transcode' ? '#eab308' :
                              job.stage === 'transcoding' ? 'linear-gradient(90deg, #8b5cf6, #c084fc)' :
                              job.stage === 'uploading' ? 'linear-gradient(90deg, #10b981, #34d399)' :
                              '#71717a',
                            width:
                              job.stage === 'downloading' ? `${job.downloadPercent || 5}%` :
                              job.stage === 'queued_transcode' ? '100%' :
                              job.stage === 'transcoding' ? `${job.transcodePercent || 5}%` :
                              job.stage === 'uploading' ? `${job.uploadPercent || 5}%` :
                              '3%'
                          }}
                        />
                      </div>

                      {/* 3 Step Footprint */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10.5px', marginTop: '6px', color: 'var(--text-muted)' }}>
                        <span style={{ color: job.downloadPercent >= 100 ? '#34d399' : (job.stage === 'downloading' ? '#60a5fa' : (job.stage === 'queued_download' ? '#fde047' : 'inherit')) }}>
                          1. Torrent Swarm {job.downloadPercent >= 100 ? '✓' : (job.stage === 'queued_download' ? '(Queued)' : `(${job.downloadPercent}%)`)}
                        </span>
                        <span style={{ color: job.transcodePercent >= 100 ? '#34d399' : (job.stage === 'transcoding' ? '#c084fc' : (job.stage === 'queued_transcode' ? '#fde047' : 'inherit')) }}>
                          2. Transcode {job.transcodePercent >= 100 ? '✓' : (job.stage === 'queued_transcode' ? `(Queued #${job.queuePosition || 1})` : `(${job.transcodePercent}%)`)}
                        </span>
                        <span style={{ color: job.uploadPercent >= 100 ? '#34d399' : (job.stage === 'uploading' ? '#34d399' : 'inherit') }}>
                          3. Google Drive Upload {job.uploadPercent >= 100 ? '✓' : `(${job.uploadPercent}%)`}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Finished & History Section */}
          {finishedJobs.length > 0 && (
            <div style={{ marginTop: '10px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  Completed & History ({finishedJobs.length})
                </div>
                <button
                  type="button"
                  onClick={handleClearHistory}
                  disabled={isClearingHistory}
                  className="action-btn"
                  title="Clear all completed and failed downloads from history"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '5px',
                    fontSize: '11px',
                    fontWeight: 600,
                    padding: '4px 10px',
                    borderRadius: '6px',
                    background: 'rgba(239, 68, 68, 0.1)',
                    color: '#f87171',
                    border: '1px solid rgba(239, 68, 68, 0.25)',
                    cursor: isClearingHistory ? 'not-allowed' : 'pointer',
                    transition: 'all 0.15s ease'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'rgba(239, 68, 68, 0.2)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'rgba(239, 68, 68, 0.1)';
                  }}
                >
                  {isClearingHistory ? (
                    <RefreshCw size={12} className="spin" />
                  ) : (
                    <Trash2 size={12} />
                  )}
                  <span>Clear History</span>
                </button>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {finishedJobs.slice(0, 25).map(job => (
                  <div
                    key={job.id}
                    style={{
                      background: 'rgba(255, 255, 255, 0.02)',
                      border: '1px solid var(--border-color)',
                      borderRadius: '10px',
                      padding: '10px 14px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '12px'
                    }}
                  >
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {job.title}
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span>{formatTimeAgo(job.updatedAt || job.createdAt)}</span>
                        {job.error && <span style={{ color: '#f87171' }}>&bull; {job.error}</span>}
                      </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      {job.status === 'completed' ? (
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '5px',
                            color: '#34d399',
                            fontSize: '11.5px',
                            fontWeight: 600,
                            padding: '3px 8px',
                            borderRadius: '6px',
                            background: 'rgba(52, 211, 153, 0.1)'
                          }}
                        >
                          <CheckCircle2 size={13} />
                          Saved to Drive
                        </div>
                      ) : job.status === 'error' ? (
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '5px',
                            color: '#f87171',
                            fontSize: '11.5px',
                            fontWeight: 600,
                            padding: '3px 8px',
                            borderRadius: '6px',
                            background: 'rgba(248, 113, 113, 0.1)'
                          }}
                        >
                          <AlertCircle size={13} />
                          Failed
                        </div>
                      ) : (
                        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Cancelled</span>
                      )}

                      <button
                        type="button"
                        onClick={() => handleRemoveHistoryItem(job.id)}
                        title="Remove from history"
                        style={{
                          background: 'transparent',
                          border: 'none',
                          color: 'var(--text-muted)',
                          cursor: 'pointer',
                          padding: '4px',
                          borderRadius: '4px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          transition: 'color 0.15s ease'
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.color = '#f87171'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
