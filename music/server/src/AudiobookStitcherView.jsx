import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  Layers,
  ArrowLeft,
  Play,
  Trash2,
  ArrowUp,
  ArrowDown,
  Sparkles,
  Check,
  AlertCircle,
  Folder,
  Upload,
  Image as ImageIcon,
  RotateCcw,
  Sliders,
  Radio,
  Volume2,
  HardDrive,
  Clock,
  Mic,
  Disc,
  X
} from 'lucide-react';
import { api } from './api';
import { formatLengthShort } from './format';

const PRESETS = [
  {
    id: 'voice',
    name: 'Voice Audiobook (64k Mono)',
    badge: 'Recommended',
    icon: '🎙️',
    desc: 'High speech clarity, mono voice optimization. Reduces file size up to 70% (~28 MB/hr).',
    bitrate: '64k',
    channels: '1',
    sampleRate: 'original',
    normalize: false
  },
  {
    id: 'copy',
    name: 'Direct Stream Copy',
    badge: 'Fastest',
    icon: '⚡',
    desc: 'Lossless stitching without re-encoding. Keeps original audio bitrates and finishes in seconds.',
    bitrate: 'original',
    channels: 'original',
    sampleRate: 'original',
    normalize: false
  },
  {
    id: 'standard',
    name: 'Standard (128 kbps Stereo)',
    badge: null,
    icon: '🎧',
    desc: 'Balanced high-quality audio with full stereo preservation for background music & ambient effects.',
    bitrate: '128k',
    channels: '2',
    sampleRate: 'original',
    normalize: false
  },
  {
    id: 'high',
    name: 'High Fidelity (192 kbps)',
    badge: null,
    icon: '✨',
    desc: 'Maximum fidelity for full-cast audiobooks, dramatized productions, or multi-voice audio.',
    bitrate: '192k',
    channels: '2',
    sampleRate: '44100',
    normalize: false
  },
  {
    id: 'custom',
    name: 'Custom Settings',
    badge: null,
    icon: '⚙️',
    desc: 'Manually configure target bitrate, audio channels, and sample rate.',
    bitrate: '128k',
    channels: '2',
    sampleRate: 'original',
    normalize: false
  }
];

function naturalSort(a, b) {
  const nameA = a.chapterTitle || a.title || a.fileName || '';
  const nameB = b.chapterTitle || b.title || b.fileName || '';
  return nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: 'base' });
}

export default function AudiobookStitcherView({
  user,
  initialBook = null,
  onNavigate,
  onPlay,
  onRefresh,
  notify
}) {
  const [loading, setLoading] = useState(true);
  const [libraryData, setLibraryData] = useState({ books: [], items: [] });
  const [selectedBookKey, setSelectedBookKey] = useState(initialBook?.key || initialBook?.id || '');

  // Ordered list of tracks to stitch
  const [tracks, setTracks] = useState([]);

  // Metadata form state
  const [metaTitle, setMetaTitle] = useState('');
  const [metaAuthor, setMetaAuthor] = useState('');
  const [metaSeries, setMetaSeries] = useState('');
  const [metaNarrator, setMetaNarrator] = useState('');
  const [metaYear, setMetaYear] = useState('');
  const [metaGenre, setMetaGenre] = useState('Audiobook');
  const [metaComment, setMetaComment] = useState('');
  const [coverPreview, setCoverPreview] = useState(null);
  const [coverBase64, setCoverBase64] = useState(null);

  // Compression options
  const [selectedPreset, setSelectedPreset] = useState('voice');
  const [customBitrate, setCustomBitrate] = useState('64k');
  const [customChannels, setCustomChannels] = useState('1');
  const [customSampleRate, setCustomSampleRate] = useState('original');
  const [normalizeVolume, setNormalizeVolume] = useState(false);

  // Drag and drop reordering
  const [draggedIndex, setDraggedIndex] = useState(null);

  // Merge job execution & polling
  const [isStitching, setIsStitching] = useState(false);
  const [isUpdatingMetadata, setIsUpdatingMetadata] = useState(false);
  const [activeJobId, setActiveJobId] = useState(null);
  const [jobStatus, setJobStatus] = useState(null);

  // Completion modal & cleanup state
  const [showCompletionModal, setShowCompletionModal] = useState(false);
  const [deleteSinglesState, setDeleteSinglesState] = useState('idle');
  const [deleteMessage, setDeleteMessage] = useState('');

  const pollingTimerRef = useRef(null);
  const fileInputRef = useRef(null);

  // 1. Fetch library audiobooks
  const fetchAudiobooks = useCallback(async () => {
    try {
      setLoading(true);
      const res = await api.library('audiobooks');
      if (res) {
        setLibraryData({
          books: res.books || [],
          items: res.items || []
        });
      }
    } catch (err) {
      console.warn('[AudiobookStitcher] Failed to load library:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAudiobooks();
  }, [fetchAudiobooks]);

  // Multi-part books from the library (sorted with multi-part books first)
  const multiPartBooks = useMemo(() => {
    const list = [...(libraryData.books || [])];
    return list.sort((a, b) => {
      const aMulti = a.isMultiPart || (a.parts?.length > 1);
      const bMulti = b.isMultiPart || (b.parts?.length > 1);
      if (aMulti && !bMulti) return -1;
      if (!aMulti && bMulti) return 1;
      return (a.title || '').localeCompare(b.title || '');
    });
  }, [libraryData.books]);

  // Load a book into the stitcher workspace
  const loadBook = useCallback((book) => {
    if (!book) return;
    const partsList = book.parts && book.parts.length ? [...book.parts] : [book];
    setTracks(partsList);
    setMetaTitle(book.title || '');
    setMetaAuthor(book.author || '');
    setMetaSeries(book.series || '');
    setMetaNarrator(book.narrator || '');
    setMetaGenre(book.genre || 'Audiobook');
    setMetaComment('');

    const cover = book.coverUrl || (partsList[0]?.id ? api.coverUrl(partsList[0].id) : null);
    setCoverPreview(cover);
    setCoverBase64(null);
  }, []);

  // Initialize from initialBook or first multi-part book
  useEffect(() => {
    if (initialBook) {
      loadBook(initialBook);
      setSelectedBookKey(initialBook.key || initialBook.id);
    } else if (multiPartBooks.length > 0 && tracks.length === 0 && !selectedBookKey) {
      const firstMulti = multiPartBooks.find((b) => b.isMultiPart || (b.parts?.length > 1));
      if (firstMulti) {
        loadBook(firstMulti);
        setSelectedBookKey(firstMulti.key || firstMulti.id);
      }
    }
  }, [initialBook, multiPartBooks, loadBook, tracks.length, selectedBookKey]);

  // Handle dropdown selection of a book
  const handleSelectBookDropdown = (e) => {
    const key = e.target.value;
    setSelectedBookKey(key);
    if (!key) return;
    const found = multiPartBooks.find((b) => (b.key === key || String(b.id) === String(key)));
    if (found) {
      loadBook(found);
    }
  };

  // Reordering helpers
  const moveTrack = (fromIndex, toIndex) => {
    if (toIndex < 0 || toIndex >= tracks.length) return;
    setTracks((prev) => {
      const next = [...prev];
      const [item] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, item);
      return next;
    });
  };

  const removeTrack = (index) => {
    setTracks((prev) => prev.filter((_, i) => i !== index));
  };

  const sortAZ = () => {
    setTracks((prev) => [...prev].sort(naturalSort));
  };

  const reverseList = () => {
    setTracks((prev) => [...prev].reverse());
  };

  // Cover image file selection
  const handleCoverFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const base64 = event.target?.result;
      if (typeof base64 === 'string') {
        setCoverPreview(base64);
        setCoverBase64(base64);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleRemoveCover = () => {
    setCoverPreview(null);
    setCoverBase64(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // Calculations for summary & estimated size
  const totalDurationSec = useMemo(() => {
    return tracks.reduce((sum, t) => sum + (t.durationSec || 0), 0);
  }, [tracks]);

  const totalSourceBytes = useMemo(() => {
    return tracks.reduce((sum, t) => sum + (t.sizeBytes || 0), 0);
  }, [tracks]);

  const estimatedSizeMb = useMemo(() => {
    if (totalDurationSec === 0) return 0;
    let kbps = 64;
    if (selectedPreset === 'voice') kbps = 64;
    else if (selectedPreset === 'standard') kbps = 128;
    else if (selectedPreset === 'high') kbps = 192;
    else if (selectedPreset === 'custom') {
      kbps = parseInt(customBitrate, 10) || 64;
    } else if (selectedPreset === 'copy') {
      return (totalSourceBytes / 1024 / 1024).toFixed(1);
    }
    const bytes = (kbps * 1000 / 8) * totalDurationSec;
    return (bytes / 1024 / 1024).toFixed(1);
  }, [totalDurationSec, selectedPreset, customBitrate, totalSourceBytes]);

  // Polling effect for active stitch job
  useEffect(() => {
    if (!activeJobId || !isStitching) return;

    const checkStatus = async () => {
      try {
        const data = await api.stitchStatus(activeJobId);
        if (data) {
          setJobStatus(data);
          if (data.status === 'done') {
            setIsStitching(false);
            setShowCompletionModal(true);
            setDeleteSinglesState('idle');
            if (pollingTimerRef.current) clearInterval(pollingTimerRef.current);
            api.scanLibrary('audiobooks').catch(() => {});
            onRefresh?.();
            fetchAudiobooks();
          } else if (data.status === 'error') {
            setIsStitching(false);
            if (pollingTimerRef.current) clearInterval(pollingTimerRef.current);
          }
        }
      } catch (err) {
        console.warn('[AudiobookStitcher] Status poll note:', err.message);
      }
    };

    checkStatus();
    pollingTimerRef.current = setInterval(checkStatus, 700);

    return () => {
      if (pollingTimerRef.current) clearInterval(pollingTimerRef.current);
    };
  }, [activeJobId, isStitching, onRefresh, fetchAudiobooks]);

  // Start Stitching Handler
  const handleStartStitch = async () => {
    if (tracks.length < 2) {
      notify?.('Selection needed', 'Please select at least 2 chapter audio files to stitch.', true);
      return;
    }
    if (!metaTitle.trim()) {
      notify?.('Title required', 'Please enter a title for the stitched audiobook.', true);
      return;
    }

    try {
      setIsStitching(true);
      setJobStatus({
        status: 'running',
        phase: 'Starting audiobook stitching job...',
        percent: 0,
        currentTime: '00:00:00',
        totalDuration: formatLengthShort(totalDurationSec)
      });

      const options = {
        mode: selectedPreset,
        bitrate: selectedPreset === 'custom' ? customBitrate : undefined,
        channels: selectedPreset === 'custom' ? customChannels : undefined,
        sampleRate: selectedPreset === 'custom' ? customSampleRate : undefined,
        normalize: normalizeVolume
      };

      const res = await api.startStitch({
        fileIds: tracks.map((t) => t.id),
        title: metaTitle.trim(),
        author: metaAuthor.trim(),
        series: metaSeries.trim(),
        narrator: metaNarrator.trim(),
        year: metaYear.trim(),
        genre: metaGenre.trim(),
        comment: metaComment.trim(),
        coverUrl: coverBase64 ? null : coverPreview,
        coverBase64: coverBase64,
        options
      });

      if (res?.jobId) {
        setActiveJobId(res.jobId);
      } else {
        throw new Error(res?.error || 'Failed to start stitching job.');
      }
    } catch (err) {
      setIsStitching(false);
      setJobStatus(null);
      notify?.('Stitching failed', err.message || 'Could not initiate stitch job.', true);
    }
  };

  // Update Metadata Only Handler
  const handleUpdateMetadataOnly = async () => {
    if (tracks.length === 0) {
      notify?.('No tracks selected', 'Please select an audiobook or chapters to update metadata.', true);
      return;
    }
    if (!metaTitle.trim()) {
      notify?.('Title required', 'Please enter a title for the audiobook.', true);
      return;
    }

    try {
      setIsUpdatingMetadata(true);
      notify?.('Updating metadata...', 'Applying metadata updates and rescanning audiobooks folder...');

      const res = await api.updateAudiobookMetadata({
        fileIds: tracks.map((t) => t.id),
        title: metaTitle.trim(),
        author: metaAuthor.trim(),
        series: metaSeries.trim(),
        narrator: metaNarrator.trim(),
        year: metaYear.trim(),
        genre: metaGenre.trim(),
        comment: metaComment.trim(),
        coverBase64: coverBase64
      });

      if (res?.success) {
        // Trigger library rescan and UI refresh
        await api.scanLibrary('audiobooks').catch(() => {});
        onRefresh?.();
        await fetchAudiobooks();
        notify?.('Metadata updated', `Successfully updated metadata for "${metaTitle.trim()}" and rescanned audiobooks folder.`);
      } else {
        throw new Error(res?.error || 'Failed to update metadata.');
      }
    } catch (err) {
      notify?.('Update failed', err.message || 'Could not update metadata.', true);
    } finally {
      setIsUpdatingMetadata(false);
    }
  };

  // Cancel Stitch Handler
  const handleCancelStitch = async () => {
    if (!activeJobId) return;
    try {
      await api.cancelStitch(activeJobId);
      setIsStitching(false);
      setJobStatus(null);
      setActiveJobId(null);
      notify?.('Cancelled', 'Stitching process was cancelled.');
    } catch (e) {
      console.warn('Cancel error:', e);
    }
  };

  // Delete Source Chapter Files Handler
  const handleDeleteSourceChapters = async () => {
    if (!jobStatus?.result?.sourceFileIds || jobStatus.result.sourceFileIds.length === 0) return;

    try {
      setDeleteSinglesState('deleting');
      const res = await api.deleteStitchSources(jobStatus.result.sourceFileIds);
      if (res.success) {
        setDeleteSinglesState('deleted');
        setDeleteMessage(`Successfully deleted ${res.deletedCount || jobStatus.result.sourceFileIds.length} source chapter files from Google Drive.`);
        await api.scanLibrary('audiobooks').catch(() => {});
        onRefresh?.();
        fetchAudiobooks();
        setTracks([]);
      } else {
        throw new Error(res.error || 'Failed to delete source chapter files.');
      }
    } catch (err) {
      setDeleteSinglesState('error');
      setDeleteMessage(err.message || 'Error occurred while deleting source chapters.');
    }
  };

  const handleKeepSourceChapters = () => {
    setDeleteSinglesState('kept');
    setShowCompletionModal(false);
  };

  return (
    <div className="stitcher-container">
      {/* Top Banner / Breadcrumb */}
      <div className="stitcher-header">
        <div className="stitcher-header-left">
          {onNavigate && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => onNavigate('library')}
              title="Return to library"
            >
              <ArrowLeft size={16} />
              <span>Library</span>
            </button>
          )}
          <h1 className="stitcher-title">
            <Layers size={24} className="stitcher-title-icon" />
            <span>Audiobook Stitcher</span>
          </h1>
          <span className="badge badge-accent">FFmpeg Pro</span>
        </div>

        <div className="stitcher-header-actions">
          <div className="stitcher-book-selector-wrap">
            <label htmlFor="stitcher-book-dropdown" className="stitcher-selector-label">
              Select Book:
            </label>
            <select
              id="stitcher-book-dropdown"
              className="stitcher-book-dropdown"
              value={selectedBookKey}
              onChange={handleSelectBookDropdown}
              disabled={isStitching}
            >
              <option value="">-- Choose an Audiobook from Library --</option>
              {multiPartBooks.map((book) => {
                const count = book.parts?.length || book.partsCount || 1;
                const isMulti = book.isMultiPart || count > 1;
                return (
                  <option key={book.key || book.id} value={book.key || book.id}>
                    {isMulti ? `📚 [${count} chapters] ` : '📖 '}
                    {book.title} {book.author ? `— ${book.author}` : ''}
                  </option>
                );
              })}
            </select>
          </div>
        </div>
      </div>

      {/* Main Two-Column Layout */}
      <div className="stitcher-workspace">
        {/* Left Panel: Source Chapters & Reordering */}
        <section className="stitcher-panel chapters-panel">
          <div className="panel-header">
            <div className="panel-title-group">
              <h2>Chapter Audio Files</h2>
              <span className="badge badge-accent">{tracks.length} chapters</span>
            </div>

            <div className="panel-actions">
              <button
                type="button"
                className="btn-tool"
                onClick={sortAZ}
                title="Sort natural chapter sequence"
                disabled={tracks.length < 2 || isStitching}
              >
                Sort A-Z
              </button>
              <button
                type="button"
                className="btn-tool"
                onClick={reverseList}
                title="Reverse sequence order"
                disabled={tracks.length < 2 || isStitching}
              >
                Reverse
              </button>
              <button
                type="button"
                className="btn-tool"
                onClick={() => setTracks([])}
                title="Clear current track list"
                disabled={tracks.length === 0 || isStitching}
              >
                Clear
              </button>
            </div>
          </div>

          {/* Chapter List */}
          <div className="chapter-list-wrap">
            {tracks.length === 0 ? (
              <div className="stitcher-empty-tracks">
                <Disc size={44} style={{ color: 'var(--text-muted)', marginBottom: '0.75rem' }} />
                <h3>No Chapters Loaded</h3>
                <p>Pick an audiobook with multiple chapters from the dropdown above to load and stitch its files.</p>
              </div>
            ) : (
              <ul className="chapter-list">
                {tracks.map((track, idx) => (
                  <li
                    key={track.id || `track-${idx}`}
                    className={`chapter-item ${draggedIndex === idx ? 'dragging' : ''}`}
                    draggable={!isStitching}
                    onDragStart={() => setDraggedIndex(idx)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => {
                      if (draggedIndex !== null && draggedIndex !== idx) {
                        moveTrack(draggedIndex, idx);
                      }
                      setDraggedIndex(null);
                    }}
                  >
                    <span className="chapter-index">{idx + 1}</span>
                    <div className="chapter-info">
                      <div className="chapter-title" title={track.title || track.fileName}>
                        {track.title || track.fileName}
                      </div>
                      <div className="chapter-sub">
                        <span>{formatLengthShort(track.durationSec || 0)}</span>
                        {track.sizeBytes ? <span> · {(track.sizeBytes / 1024 / 1024).toFixed(1)} MB</span> : null}
                      </div>
                    </div>
                    <div className="chapter-actions">
                      <button
                        type="button"
                        className="btn-icon-subtle"
                        title="Move Up"
                        disabled={idx === 0 || isStitching}
                        onClick={() => moveTrack(idx, idx - 1)}
                      >
                        <ArrowUp size={14} />
                      </button>
                      <button
                        type="button"
                        className="btn-icon-subtle"
                        title="Move Down"
                        disabled={idx === tracks.length - 1 || isStitching}
                        onClick={() => moveTrack(idx, idx + 1)}
                      >
                        <ArrowDown size={14} />
                      </button>
                      <button
                        type="button"
                        className="btn-icon-subtle danger"
                        title="Remove chapter"
                        disabled={isStitching}
                        onClick={() => removeTrack(idx)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Chapters Summary Footer */}
          <div className="chapter-summary-footer">
            <div className="summary-col">
              <span className="summary-label">Chapters</span>
              <span className="summary-val">{tracks.length}</span>
            </div>
            <div className="summary-col">
              <span className="summary-label">Total Duration</span>
              <span className="summary-val">{formatLengthShort(totalDurationSec) || '00:00'}</span>
            </div>
            <div className="summary-col">
              <span className="summary-label">Source Size</span>
              <span className="summary-val">{(totalSourceBytes / 1024 / 1024).toFixed(1)} MB</span>
            </div>
          </div>
        </section>

        {/* Right Panel: Metadata & Compression Options */}
        <section className="stitcher-panel config-panel">
          <div className="config-scroll-area">
            {/* Metadata Card */}
            <div className="config-card">
              <div className="config-card-header">
                <h3>Audiobook Metadata (ID3v2)</h3>
                <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
                  <button
                    type="button"
                    className="btn btn-secondary btn-xs"
                    onClick={handleUpdateMetadataOnly}
                    disabled={tracks.length === 0 || !metaTitle.trim() || isStitching || isUpdatingMetadata}
                    title="Save edited metadata for selected book/chapters and rescan library"
                  >
                    <Check size={12} />
                    <span>{isUpdatingMetadata ? 'Updating…' : 'Update Metadata Only'}</span>
                  </button>
                  <span className="sub-badge">Embedded in MP3</span>
                </div>
              </div>

              <div className="meta-grid">
                {/* Cover Art Box */}
                <div className="cover-picker-box">
                  <div
                    className="cover-thumb-preview"
                    onClick={() => fileInputRef.current?.click()}
                    title="Click to select new cover image"
                  >
                    {coverPreview ? (
                      <img src={coverPreview} alt="Cover Preview" />
                    ) : (
                      <div className="cover-placeholder">
                        <ImageIcon size={30} />
                        <span>No Cover</span>
                      </div>
                    )}
                    <div className="cover-hover-tag">Change Cover</div>
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    style={{ display: 'none' }}
                    onChange={handleCoverFileChange}
                  />
                  <div className="cover-btn-row">
                    <button
                      type="button"
                      className="btn btn-secondary btn-xs"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Upload size={12} />
                      <span>Browse...</span>
                    </button>
                    {coverPreview && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-xs"
                        onClick={handleRemoveCover}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>

                {/* Primary Inputs */}
                <div className="meta-fields-main">
                  <div className="stitcher-form-group">
                    <label htmlFor="meta-stitch-title">Book Title *</label>
                    <input
                      id="meta-stitch-title"
                      type="text"
                      className="stitcher-input"
                      placeholder="e.g. Dune"
                      value={metaTitle}
                      onChange={(e) => setMetaTitle(e.target.value)}
                      disabled={isStitching}
                    />
                  </div>

                  <div className="stitcher-form-group">
                    <label htmlFor="meta-stitch-author">Author / Artist</label>
                    <input
                      id="meta-stitch-author"
                      type="text"
                      className="stitcher-input"
                      placeholder="e.g. Frank Herbert"
                      value={metaAuthor}
                      onChange={(e) => setMetaAuthor(e.target.value)}
                      disabled={isStitching}
                    />
                  </div>
                </div>
              </div>

              {/* Secondary Inputs Row */}
              <div className="form-grid-2">
                <div className="stitcher-form-group">
                  <label htmlFor="meta-stitch-series">Series / Album</label>
                  <input
                    id="meta-stitch-series"
                    type="text"
                    className="stitcher-input"
                    placeholder="e.g. Dune Chronicles"
                    value={metaSeries}
                    onChange={(e) => setMetaSeries(e.target.value)}
                    disabled={isStitching}
                  />
                </div>
                <div className="stitcher-form-group">
                  <label htmlFor="meta-stitch-narrator">Narrator / Voice</label>
                  <input
                    id="meta-stitch-narrator"
                    type="text"
                    className="stitcher-input"
                    placeholder="e.g. George Guidall"
                    value={metaNarrator}
                    onChange={(e) => setMetaNarrator(e.target.value)}
                    disabled={isStitching}
                  />
                </div>
              </div>

              <div className="form-grid-2">
                <div className="stitcher-form-group">
                  <label htmlFor="meta-stitch-year">Year</label>
                  <input
                    id="meta-stitch-year"
                    type="text"
                    className="stitcher-input"
                    placeholder="e.g. 2026"
                    maxLength={4}
                    value={metaYear}
                    onChange={(e) => setMetaYear(e.target.value)}
                    disabled={isStitching}
                  />
                </div>
                <div className="stitcher-form-group">
                  <label htmlFor="meta-stitch-genre">Genre</label>
                  <input
                    id="meta-stitch-genre"
                    type="text"
                    className="stitcher-input"
                    placeholder="e.g. Audiobook, Sci-Fi"
                    value={metaGenre}
                    onChange={(e) => setMetaGenre(e.target.value)}
                    disabled={isStitching}
                  />
                </div>
              </div>

              <div className="stitcher-form-group">
                <label htmlFor="meta-stitch-comment">Synopsis / Notes</label>
                <textarea
                  id="meta-stitch-comment"
                  className="stitcher-textarea"
                  rows={2}
                  placeholder="Summary or chapter notes..."
                  value={metaComment}
                  onChange={(e) => setMetaComment(e.target.value)}
                  disabled={isStitching}
                />
              </div>
            </div>

            {/* Quality & Compression Options */}
            <div className="config-card">
              <div className="config-card-header">
                <h3>Quality & Compression</h3>
                <span className="est-size-tag">Est. output: ~{estimatedSizeMb} MB</span>
              </div>

              <div className="presets-list">
                {PRESETS.map((preset) => (
                  <label
                    key={preset.id}
                    className={`preset-card ${selectedPreset === preset.id ? 'active' : ''}`}
                  >
                    <input
                      type="radio"
                      name="stitch-preset"
                      value={preset.id}
                      checked={selectedPreset === preset.id}
                      onChange={() => setSelectedPreset(preset.id)}
                      disabled={isStitching}
                    />
                    <div className="preset-card-content">
                      <div className="preset-top-row">
                        <span className="preset-icon">{preset.icon}</span>
                        <span className="preset-name">{preset.name}</span>
                        {preset.badge && (
                          <span className="badge badge-accent" style={{ marginLeft: 'auto' }}>
                            {preset.badge}
                          </span>
                        )}
                      </div>
                      <p className="preset-desc">{preset.desc}</p>
                    </div>
                  </label>
                ))}
              </div>

              {/* Custom Drawer */}
              {selectedPreset === 'custom' && (
                <div className="custom-drawer">
                  <div className="form-grid-3">
                    <div className="stitcher-form-group">
                      <label htmlFor="custom-bitrate-sel">Bitrate</label>
                      <select
                        id="custom-bitrate-sel"
                        className="stitcher-select"
                        value={customBitrate}
                        onChange={(e) => setCustomBitrate(e.target.value)}
                        disabled={isStitching}
                      >
                        <option value="32k">32 kbps (Ultra Small)</option>
                        <option value="48k">48 kbps</option>
                        <option value="64k">64 kbps (Voice)</option>
                        <option value="96k">96 kbps</option>
                        <option value="128k">128 kbps (Standard)</option>
                        <option value="192k">192 kbps (High)</option>
                        <option value="320k">320 kbps (Max)</option>
                      </select>
                    </div>

                    <div className="stitcher-form-group">
                      <label htmlFor="custom-channels-sel">Channels</label>
                      <select
                        id="custom-channels-sel"
                        className="stitcher-select"
                        value={customChannels}
                        onChange={(e) => setCustomChannels(e.target.value)}
                        disabled={isStitching}
                      >
                        <option value="1">Mono (Voice)</option>
                        <option value="2">Stereo</option>
                        <option value="original">Keep Original</option>
                      </select>
                    </div>

                    <div className="stitcher-form-group">
                      <label htmlFor="custom-samplerate-sel">Sample Rate</label>
                      <select
                        id="custom-samplerate-sel"
                        className="stitcher-select"
                        value={customSampleRate}
                        onChange={(e) => setCustomSampleRate(e.target.value)}
                        disabled={isStitching}
                      >
                        <option value="original">Keep Original</option>
                        <option value="44100">44.1 kHz</option>
                        <option value="22050">22.05 kHz</option>
                        <option value="16000">16 kHz</option>
                      </select>
                    </div>
                  </div>
                </div>
              )}

              {/* Volume Normalization */}
              <div className="checkbox-wrap">
                <label className="checkbox-label-styled">
                  <input
                    type="checkbox"
                    checked={normalizeVolume}
                    onChange={(e) => setNormalizeVolume(e.target.checked)}
                    disabled={isStitching || selectedPreset === 'copy'}
                  />
                  <span>
                    <strong>EBU R128 Volume Normalization</strong>
                    <span className="checkbox-subtext">Balances loudness across differing chapters for smooth listening</span>
                  </span>
                </label>
              </div>
            </div>

            {/* Target Destination & Execution */}
            <div className="config-card export-card">
              <div className="dest-box">
                <Folder size={18} className="dest-icon" />
                <div className="dest-meta">
                  <span className="dest-label">Google Drive Target:</span>
                  <span className="dest-value">
                    Audiobooks / {metaAuthor || 'Author'} / {metaSeries || 'Series'} / {metaTitle || 'Book'}.mp3
                  </span>
                </div>
              </div>

              <div className="stitcher-action-buttons">
                <button
                  type="button"
                  className="btn btn-primary btn-large btn-stitch-run"
                  disabled={tracks.length < 2 || !metaTitle.trim() || isStitching || isUpdatingMetadata}
                  onClick={handleStartStitch}
                >
                  <Sparkles size={18} />
                  <span>Stitch & Save to Google Drive</span>
                </button>

                <button
                  type="button"
                  className="btn btn-secondary btn-large btn-metadata-update"
                  disabled={tracks.length === 0 || !metaTitle.trim() || isStitching || isUpdatingMetadata}
                  onClick={handleUpdateMetadataOnly}
                  title="Update metadata and cover art for this book/chapters without stitching, and rescan audiobooks folder"
                >
                  <Check size={18} />
                  <span>{isUpdatingMetadata ? 'Updating & Rescanning…' : 'Update Metadata Only'}</span>
                </button>
              </div>
            </div>
          </div>
        </section>
      </div>

      {/* Progress Overlay Modal */}
      {isStitching && (
        <div className="stitcher-modal-backdrop">
          <div className="stitcher-modal-card">
            <div className="stitcher-modal-header">
              <h3>Stitching Audiobook...</h3>
              <span className="badge badge-accent">Processing</span>
            </div>

            <div className="stitcher-progress-box">
              <div className="stitcher-progress-bar-bg">
                <div
                  className="stitcher-progress-bar-fill"
                  style={{ width: `${jobStatus?.percent || 0}%` }}
                />
              </div>
              <div className="stitcher-progress-meta">
                <span className="stitcher-percent">{jobStatus?.percent || 0}%</span>
                <span className="stitcher-time">
                  {jobStatus?.currentTime || '00:00:00'} / {formatLengthShort(totalDurationSec)}
                </span>
              </div>
            </div>

            <p className="stitcher-phase-text">
              {jobStatus?.phase || 'Processing audio files...'}
            </p>

            <div className="stitcher-modal-footer">
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={handleCancelStitch}
              >
                Cancel Operation
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Success & Source Cleanup Modal */}
      {showCompletionModal && (
        <div className="stitcher-modal-backdrop">
          <div className="stitcher-modal-card success-card">
            <div className="success-badge-icon">
              <Check size={36} />
            </div>

            <h2>Audiobook Stitched Successfully!</h2>
            <p className="success-subtext">
              Your joined audio file has been created, tagged with metadata, and saved to Google Drive.
            </p>

            <div className="success-summary-card">
              <div className="summary-row">
                <span className="sum-label">Title:</span>
                <span className="sum-val">{jobStatus?.result?.title || metaTitle}</span>
              </div>
              <div className="summary-row">
                <span className="sum-label">Duration:</span>
                <span className="sum-val">{jobStatus?.result?.durationFormatted || formatLengthShort(totalDurationSec)}</span>
              </div>
              <div className="summary-row">
                <span className="sum-label">File Size:</span>
                <span className="sum-val">
                  {jobStatus?.result?.fileSize ? (jobStatus.result.fileSize / 1024 / 1024).toFixed(1) + ' MB' : `${estimatedSizeMb} MB`}
                </span>
              </div>
              <div className="summary-row">
                <span className="sum-label">Saved to:</span>
                <span className="sum-val drive-path">{jobStatus?.result?.drivePath || 'Google Drive'}</span>
              </div>
            </div>

            {/* Storage Cleanup Prompt */}
            <div className="cleanup-prompt-box">
              <div className="cleanup-header">
                <Trash2 size={18} style={{ color: 'var(--danger)' }} />
                <h4>Source Files Storage Cleanup</h4>
              </div>
              <p>
                The {jobStatus?.result?.sourceFileIds?.length || tracks.length} individual chapter files are still in your Google Drive.
                Would you like to delete the source files now to free up storage space?
              </p>

              {deleteSinglesState === 'idle' && (
                <div className="cleanup-actions">
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    onClick={handleDeleteSourceChapters}
                  >
                    <Trash2 size={14} />
                    <span>Delete Source Chapter Files</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={handleKeepSourceChapters}
                  >
                    Keep Source Files
                  </button>
                </div>
              )}

              {deleteSinglesState === 'deleting' && (
                <div className="cleanup-status deleting">
                  <div className="spinner-sm" />
                  <span>Deleting source chapter files from Google Drive...</span>
                </div>
              )}

              {deleteSinglesState === 'deleted' && (
                <div className="cleanup-status deleted">
                  <Check size={16} />
                  <span>{deleteMessage}</span>
                </div>
              )}

              {deleteSinglesState === 'kept' && (
                <div className="cleanup-status kept">
                  <span>Source chapter files retained on Google Drive.</span>
                </div>
              )}

              {deleteSinglesState === 'error' && (
                <div className="cleanup-status error">
                  <AlertCircle size={16} />
                  <span>{deleteMessage}</span>
                </div>
              )}
            </div>

            <div className="stitcher-modal-footer">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setShowCompletionModal(false);
                  onNavigate?.('library');
                }}
              >
                Go to Library
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
