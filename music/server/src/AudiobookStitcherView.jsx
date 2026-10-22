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
  FolderOpen,
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
  X,
  Search,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  RefreshCw,
  FileAudio,
  Loader2
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
    id: 'balanced',
    name: 'Balanced (96 kbps Stereo)',
    badge: 'High Quality',
    icon: '🎧',
    desc: 'Full stereo fidelity for audiobooks with background music & ambient effects (~42 MB/hr).',
    bitrate: '96k',
    channels: '2',
    sampleRate: 'original',
    normalize: false
  },
  {
    id: 'copy',
    name: 'Direct Stream Copy',
    badge: 'Fastest • Lossless',
    icon: '⚡',
    desc: 'Lossless stitching without re-encoding. Keeps original audio bitrates and finishes in seconds.',
    bitrate: 'original',
    channels: 'original',
    sampleRate: 'original',
    normalize: false
  },
  {
    id: 'standard',
    name: 'Standard Music (128 kbps Stereo)',
    badge: null,
    icon: '🎵',
    desc: 'Balanced high-quality audio with full stereo preservation for podcasts & music (~56 MB/hr).',
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

const CONVERT_PRESETS = [
  {
    id: '64k',
    name: 'Voice Audiobook (64 kbps Mono)',
    badge: 'Recommended',
    icon: '🎙️',
    desc: 'Optimized voice clarity, compact file size saves up to 70% storage (~28 MB/hr).',
    bitrate: '64k',
    channels: '1'
  },
  {
    id: '96k',
    name: 'Balanced (96 kbps Stereo)',
    badge: 'High Quality',
    icon: '🎧',
    desc: 'Preserves stereo channels for dramatized audiobooks and ambient tracks (~42 MB/hr).',
    bitrate: '96k',
    channels: '2'
  },
  {
    id: '128k',
    name: 'Standard Music (128 kbps Stereo)',
    badge: null,
    icon: '🎵',
    desc: 'Full spectrum audio clarity ideal for music, podcasts, and rich soundscapes (~56 MB/hr).',
    bitrate: '128k',
    channels: '2'
  }
];

function naturalSort(a, b) {
  const nameA = a.chapterTitle || a.title || a.name || a.fileName || '';
  const nameB = b.chapterTitle || b.title || b.name || b.fileName || '';
  return nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: 'base' });
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

export default function AudiobookStitcherView({
  user,
  initialBook = null,
  isActive = true,
  hasPlayer = false,
  hasDownloadBar = false,
  onJobActiveChange,
  onNavigate,
  onPlay,
  onRefresh,
  notify
}) {
  // Mode selection: 'stitch' | 'convert'
  const [viewMode, setViewMode] = useState('stitch');
  const [statusFooterExpanded, setStatusFooterExpanded] = useState(false);

  const [loading, setLoading] = useState(true);
  const [libraryData, setLibraryData] = useState({ books: [], items: [] });
  const [selectedBookKey, setSelectedBookKey] = useState(initialBook?.key || initialBook?.id || '');

  // ---------------------------------------------------------------------------
  // 1. Single Book Stitcher State
  // ---------------------------------------------------------------------------
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
  const [smartBitrateEnabled, setSmartBitrateEnabled] = useState(true);

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
  const [ffmpegAvailable, setFfmpegAvailable] = useState(true);

  const pollingTimerRef = useRef(null);
  const fileInputRef = useRef(null);

  // ---------------------------------------------------------------------------
  // 2. Batch Audio Converter State (Google Drive files/folders, non-stitching)
  // ---------------------------------------------------------------------------
  const [convertFiles, setConvertFiles] = useState([]);
  const [selectedConvertBookKey, setSelectedConvertBookKey] = useState('');
  const [convertFolderId, setConvertFolderId] = useState(null);
  const [convertFolderName, setConvertFolderName] = useState('');
  const [convertSearchQuery, setConvertSearchQuery] = useState('');

  // Converter Settings
  const [convertPreset, setConvertPreset] = useState('64k');
  const [convertSmartBitrate, setConvertSmartBitrate] = useState(true);
  const [convertNormalize, setConvertNormalize] = useState(false);
  const [convertDestMode, setConvertDestMode] = useState('subfolder'); // 'subfolder' | 'in-place' | 'custom-folder'
  const [convertCustomFolderId, setConvertCustomFolderId] = useState(null);
  const [convertCustomFolderName, setConvertCustomFolderName] = useState('');
  const [convertDeleteSource, setConvertDeleteSource] = useState(false);

  // Converter Job execution & polling
  const [isConverting, setIsConverting] = useState(false);
  const [activeConvertJobId, setActiveConvertJobId] = useState(null);
  const [convertJobStatus, setConvertJobStatus] = useState(null);
  const [showConvertSummaryModal, setShowConvertSummaryModal] = useState(false);
  const [convertSummary, setConvertSummary] = useState(null);

  useEffect(() => {
    onJobActiveChange?.(isStitching || isConverting);
  }, [isStitching, isConverting, onJobActiveChange]);

  const convertPollingTimerRef = useRef(null);

  // Drive Folder Browser Modal
  const [driveModalOpen, setDriveModalOpen] = useState(false);
  const [driveModalPurpose, setDriveModalPurpose] = useState('source'); // 'source' | 'destination'
  const [driveFolders, setDriveFolders] = useState([]);
  const [driveBreadcrumbs, setDriveBreadcrumbs] = useState([{ id: 'root', name: 'My Drive' }]);
  const [driveModalLoading, setDriveModalLoading] = useState(false);
  const [driveModalSelected, setDriveModalSelected] = useState(null);

  // ---------------------------------------------------------------------------
  // Library Fetching
  // ---------------------------------------------------------------------------
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
      api.health().then((h) => {
        if (h?.tools?.ffmpeg) {
          setFfmpegAvailable(Boolean(h.tools.ffmpeg.available));
        }
      }).catch(() => {});
    } catch (err) {
      console.warn('[AudiobookStitcher] Failed to load library:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAudiobooks();
  }, [fetchAudiobooks]);

  // Multi-part books from the library
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

  // Handle dropdown selection of a book for Stitcher
  const handleSelectBookDropdown = (e) => {
    const key = e.target.value;
    setSelectedBookKey(key);
    if (!key) return;
    const found = multiPartBooks.find((b) => (b.key === key || String(b.id) === String(key)));
    if (found) {
      loadBook(found);
    }
  };

  // Reordering helpers for Stitcher
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

  // Calculations for summary & estimated size for Stitcher
  const totalDurationSec = useMemo(() => {
    return tracks.reduce((sum, t) => sum + (t.durationSec || 0), 0);
  }, [tracks]);

  const totalSourceBytes = useMemo(() => {
    return tracks.reduce((sum, t) => sum + (t.sizeBytes || 0), 0);
  }, [tracks]);

  // Detect dominant source bitrate across loaded tracks
  const detectedBitrateKbps = useMemo(() => {
    const bitrates = tracks
      .map((t) => {
        if (typeof t.bitrateKbps === 'number' && t.bitrateKbps > 0) return t.bitrateKbps;
        if (t.bitrate) {
          const m = String(t.bitrate).match(/(\d+)/);
          if (m) return parseInt(m[1], 10);
        }
        if (t.sizeBytes > 0 && t.durationSec > 0) {
          const calc = Math.round((t.sizeBytes * 8) / t.durationSec / 1000);
          if (calc >= 16 && calc <= 1411) return calc;
        }
        return null;
      })
      .filter((b) => typeof b === 'number' && b > 0);
    return bitrates.length > 0 ? Math.max(...bitrates) : null;
  }, [tracks]);

  // Live hint for Smart Bitrate Detector in Stitcher
  const smartBitrateHint = useMemo(() => {
    if (!smartBitrateEnabled) return null;
    let targetKbps = 64;
    if (selectedPreset === 'voice') targetKbps = 64;
    else if (selectedPreset === 'balanced') targetKbps = 96;
    else if (selectedPreset === 'copy') {
      return {
        type: 'copy',
        text: `Direct Stream Copy: Preserves original ${detectedBitrateKbps ? `${detectedBitrateKbps} kbps` : 'audio'} bitstream losslessly without re-encoding.`
      };
    } else if (selectedPreset === 'standard') targetKbps = 128;
    else if (selectedPreset === 'high') targetKbps = 192;
    else if (selectedPreset === 'custom') targetKbps = parseInt(customBitrate, 10) || 64;

    if (!detectedBitrateKbps) {
      return {
        type: 'preserve',
        text: `Smart Bitrate Active: Will check chapter audio bitrates on Google Drive and avoid compression if already ≤ ${targetKbps} kbps.`
      };
    }

    if (detectedBitrateKbps > targetKbps) {
      return {
        type: 'compress',
        text: `Smart Bitrate: Source audio (${detectedBitrateKbps} kbps) > target (${targetKbps} kbps). Re-encoding will compress audio to ${targetKbps} kbps to reduce file size.`
      };
    } else {
      return {
        type: 'preserve',
        text: `Smart Bitrate: Source audio (${detectedBitrateKbps} kbps) is already ≤ target (${targetKbps} kbps). App will preserve original ${detectedBitrateKbps} kbps and avoid unnecessary re-compression.`
      };
    }
  }, [smartBitrateEnabled, selectedPreset, customBitrate, detectedBitrateKbps]);

  const estimatedSizeMb = useMemo(() => {
    if (totalDurationSec === 0) return 0;
    let kbps = 64;
    if (selectedPreset === 'voice') kbps = 64;
    else if (selectedPreset === 'balanced') kbps = 96;
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
            notify?.('Stitching failed', data.error || 'Audiobook stitching failed.', true);
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
  }, [activeJobId, isStitching, onRefresh, fetchAudiobooks, notify]);

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
        normalize: normalizeVolume,
        smartBitrate: smartBitrateEnabled
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

  // ---------------------------------------------------------------------------
  // 3. Batch Audio Converter Actions & Logic
  // ---------------------------------------------------------------------------

  // Load a book into Batch Converter
  const loadConvertBook = useCallback((book) => {
    if (!book) return;
    const partsList = book.parts && book.parts.length ? [...book.parts] : [book];
    const mapped = partsList.map((p, idx) => ({
      id: p.id || p.googleFileId || `cf-${idx}`,
      name: p.fileName || p.title || `Audio ${idx + 1}`,
      title: p.title || p.fileName,
      driveFolderId: p.driveFolderId || book.driveFolderId || null,
      durationSec: p.durationSec || 0,
      durationFormatted: formatLengthShort(p.durationSec || 0),
      sizeBytes: p.sizeBytes || 0,
      bitrateKbps: p.bitrateKbps || (p.sizeBytes && p.durationSec ? Math.round((p.sizeBytes * 8) / p.durationSec / 1000) : null),
      selected: true,
      status: 'ready',
      statusText: 'Ready'
    }));
    setConvertFiles(mapped);
    setConvertFolderName(book.title || 'Selected Audiobook');
    setConvertFolderId(book.driveFolderId || null);
  }, []);

  // Initialize Batch Converter from first multi-part book if empty
  useEffect(() => {
    if (multiPartBooks.length > 0 && convertFiles.length === 0 && !selectedConvertBookKey) {
      const first = multiPartBooks[0];
      if (first) {
        loadConvertBook(first);
        setSelectedConvertBookKey(first.key || first.id);
      }
    }
  }, [multiPartBooks, convertFiles.length, selectedConvertBookKey, loadConvertBook]);

  // Dropdown book selection for Converter
  const handleSelectConvertBookDropdown = (e) => {
    const key = e.target.value;
    setSelectedConvertBookKey(key);
    if (!key) return;
    const found = multiPartBooks.find((b) => (b.key === key || String(b.id) === String(key)));
    if (found) {
      loadConvertBook(found);
    }
  };

  // Toggle selection of individual file
  const toggleConvertFileSelected = (id) => {
    setConvertFiles((prev) =>
      prev.map((f) => (f.id === id ? { ...f, selected: !f.selected } : f))
    );
  };

  const selectAllConvertFiles = (select) => {
    setConvertFiles((prev) => prev.map((f) => ({ ...f, selected: select })));
  };

  // Filtered files based on search
  const filteredConvertFiles = useMemo(() => {
    const q = convertSearchQuery.toLowerCase().trim();
    if (!q) return convertFiles;
    return convertFiles.filter(
      (f) =>
        (f.name && f.name.toLowerCase().includes(q)) ||
        (f.title && f.title.toLowerCase().includes(q))
    );
  }, [convertFiles, convertSearchQuery]);

  const selectedConvertCount = useMemo(() => {
    return convertFiles.filter((f) => f.selected).length;
  }, [convertFiles]);

  const totalConvertDurationSec = useMemo(() => {
    return convertFiles.reduce((acc, f) => acc + (f.durationSec || 0), 0);
  }, [convertFiles]);

  const totalConvertSizeBytes = useMemo(() => {
    return convertFiles.reduce((acc, f) => acc + (f.sizeBytes || 0), 0);
  }, [convertFiles]);

  // Polling for Batch Converter Job
  useEffect(() => {
    if (!activeConvertJobId || !isConverting) return;

    const checkConvertStatus = async () => {
      try {
        const data = await api.convertStatus(activeConvertJobId);
        if (data) {
          setConvertJobStatus(data);
          if (data.status === 'done') {
            setIsConverting(false);
            setConvertSummary(data.result);
            setShowConvertSummaryModal(true);
            if (convertPollingTimerRef.current) clearInterval(convertPollingTimerRef.current);
            api.scanLibrary('audiobooks').catch(() => {});
            onRefresh?.();
            fetchAudiobooks();
          } else if (data.status === 'error') {
            setIsConverting(false);
            if (convertPollingTimerRef.current) clearInterval(convertPollingTimerRef.current);
            notify?.('Conversion failed', data.error || 'Batch audio conversion failed.', true);
          }
        }
      } catch (err) {
        console.warn('[AudiobookConverter] Poll error:', err.message);
      }
    };

    checkConvertStatus();
    convertPollingTimerRef.current = setInterval(checkConvertStatus, 700);

    return () => {
      if (convertPollingTimerRef.current) clearInterval(convertPollingTimerRef.current);
    };
  }, [activeConvertJobId, isConverting, onRefresh, fetchAudiobooks, notify]);

  // Start Batch Conversion
  const handleStartBatchConvert = async () => {
    const selectedFiles = convertFiles.filter((f) => f.selected);
    if (selectedFiles.length === 0) {
      notify?.('Selection needed', 'Please select at least 1 audio file to convert.', true);
      return;
    }

    try {
      setIsConverting(true);
      setConvertJobStatus({
        status: 'running',
        phase: 'Starting batch audio conversion...',
        overallPercent: 0,
        currentFileIndex: 0,
        totalFiles: selectedFiles.length,
        currentFileName: selectedFiles[0].name,
        currentPercent: 0,
        currentTime: '00:00:00',
        totalDuration: formatLengthShort(totalConvertDurationSec),
        speed: '',
        freedBytes: 0,
        smartPreservedCount: 0
      });

      const res = await api.startConvert({
        fileIds: selectedFiles.map((f) => f.id),
        preset: convertPreset,
        options: {
          preset: convertPreset,
          bitrate: convertPreset,
          channels: convertPreset === '64k' ? '1' : '2',
          smartBitrate: convertSmartBitrate,
          normalize: convertNormalize,
          destMode: convertDestMode,
          sourceFolderId: convertFolderId || selectedFiles.find((f) => f.driveFolderId)?.driveFolderId || null,
          customFolderId: convertCustomFolderId,
          deleteSource: convertDestMode === 'in-place' ? false : convertDeleteSource
        }
      });

      if (res?.jobId) {
        setActiveConvertJobId(res.jobId);
      } else {
        throw new Error(res?.error || 'Failed to start batch conversion job.');
      }
    } catch (err) {
      setIsConverting(false);
      setConvertJobStatus(null);
      notify?.('Conversion failed', err.message || 'Could not start batch conversion.', true);
    }
  };

  // Cancel Batch Conversion
  const handleCancelConvert = async () => {
    if (!activeConvertJobId) return;
    try {
      await api.cancelConvert(activeConvertJobId);
      setIsConverting(false);
      setConvertJobStatus(null);
      setActiveConvertJobId(null);
      notify?.('Cancelled', 'Batch audio conversion was cancelled.');
    } catch (e) {
      console.warn('Cancel error:', e);
    }
  };

  // Drive Folder Browser Modal Logic
  const openDriveFolderPicker = async (purpose = 'source') => {
    setDriveModalPurpose(purpose);
    setDriveModalOpen(true);
    setDriveModalLoading(true);
    setDriveBreadcrumbs([{ id: 'root', name: 'My Drive' }]);
    setDriveModalSelected(null);
    try {
      const folders = await api.listFolders('root');
      setDriveFolders(folders || []);
    } catch (err) {
      notify?.('Drive error', 'Could not list Google Drive folders: ' + err.message, true);
    } finally {
      setDriveModalLoading(false);
    }
  };

  const navigateDriveModalInto = async (folder) => {
    setDriveBreadcrumbs((prev) => [...prev, { id: folder.id, name: folder.name }]);
    setDriveModalSelected(folder);
    setDriveModalLoading(true);
    try {
      const folders = await api.listFolders(folder.id);
      setDriveFolders(folders || []);
    } catch (err) {
      notify?.('Drive error', 'Could not load folders: ' + err.message, true);
    } finally {
      setDriveModalLoading(false);
    }
  };

  const navigateDriveModalCrumb = async (index) => {
    const target = driveBreadcrumbs[index];
    setDriveBreadcrumbs((prev) => prev.slice(0, index + 1));
    setDriveModalSelected(target.id === 'root' ? null : target);
    setDriveModalLoading(true);
    try {
      const folders = await api.listFolders(target.id);
      setDriveFolders(folders || []);
    } catch (err) {
      notify?.('Drive error', err.message, true);
    } finally {
      setDriveModalLoading(false);
    }
  };

  const handleConfirmDriveModalSelection = async () => {
    const folder = driveModalSelected || driveBreadcrumbs[driveBreadcrumbs.length - 1];
    setDriveModalOpen(false);

    if (driveModalPurpose === 'destination') {
      setConvertCustomFolderId(folder.id);
      setConvertCustomFolderName(folder.name);
      notify?.('Destination chosen', `Converted files will upload to "${folder.name}".`);
    } else {
      // Source folder: load audio files inside this folder from Google Drive
      setConvertFolderName(folder.name);
      setConvertFolderId(folder.id);
      notify?.('Scanning Drive folder', `Reading audio files in "${folder.name}"...`);

      try {
        const res = await api.getFolderAudioFiles(folder.id);
        if (res?.files && res.files.length > 0) {
          const mapped = res.files.map((f, idx) => ({
            id: f.id || `df-${idx}`,
            name: f.name || f.title,
            title: f.title || f.name,
            driveFolderId: f.driveFolderId || folder.id,
            durationSec: f.durationSec || 0,
            durationFormatted: formatLengthShort(f.durationSec || 0),
            sizeBytes: f.sizeBytes || 0,
            bitrateKbps: f.bitrateKbps || (f.sizeBytes && f.durationSec ? Math.round((f.sizeBytes * 8) / f.durationSec / 1000) : null),
            selected: true,
            status: 'ready',
            statusText: 'Ready'
          }));
          setConvertFiles(mapped);
          notify?.('Files loaded', `Found ${mapped.length} audio files in "${folder.name}".`);
        } else {
          setConvertFiles([]);
          notify?.('No audio files', `No supported audio files found directly in "${folder.name}".`, true);
        }
      } catch (err) {
        notify?.('Scan failed', err.message || 'Could not read audio files in folder.', true);
      }
    }
  };

  if (!isActive && !isStitching && !isConverting) return null;

  return (
    <>
      <div className="stitcher-container" style={{ display: isActive ? undefined : 'none' }}>
        {/* Top Header & Mode Switcher */}
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
            <span>Audiobook Tools</span>
          </h1>

          {/* Mode Switcher Tabs */}
          <div className="stitcher-mode-tabs">
            <button
              type="button"
              className={`stitcher-mode-btn ${viewMode === 'stitch' ? 'active' : ''}`}
              onClick={() => setViewMode('stitch')}
            >
              <Layers size={14} />
              <span>Stitch Audiobook</span>
            </button>
            <button
              type="button"
              className={`stitcher-mode-btn ${viewMode === 'convert' ? 'active' : ''}`}
              onClick={() => setViewMode('convert')}
            >
              <Sliders size={14} />
              <span>Batch Audio Converter</span>
            </button>
          </div>

          <span
            className={`badge ${ffmpegAvailable ? 'badge-accent' : 'badge-danger'}`}
            title={ffmpegAvailable ? 'FFmpeg is installed and ready' : 'FFmpeg binary was not found.'}
          >
            {ffmpegAvailable ? 'FFmpeg Ready' : 'FFmpeg Missing'}
          </span>
        </div>

        {/* Header Right Action: Book Selector */}
        <div className="stitcher-header-actions">
          {viewMode === 'stitch' ? (
            <div className="stitcher-book-selector-wrap">
              <label htmlFor="stitcher-book-dropdown" className="stitcher-selector-label">
                Select Book:
              </label>
              <select
                id="stitcher-book-dropdown"
                className="stitcher-book-dropdown"
                value={selectedBookKey}
                onChange={handleSelectBookDropdown}
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
          ) : (
            <div className="stitcher-book-selector-wrap">
              <label htmlFor="convert-book-dropdown" className="stitcher-selector-label">
                Select Book:
              </label>
              <select
                id="convert-book-dropdown"
                className="stitcher-book-dropdown"
                value={selectedConvertBookKey}
                onChange={handleSelectConvertBookDropdown}
              >
                <option value="">-- Choose from Library --</option>
                {multiPartBooks.map((book) => {
                  const count = book.parts?.length || book.partsCount || 1;
                  return (
                    <option key={book.key || book.id} value={book.key || book.id}>
                      📚 {book.title} ({count} files)
                    </option>
                  );
                })}
              </select>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => openDriveFolderPicker('source')}
                title="Browse and select any folder from Google Drive"
              >
                <FolderOpen size={14} />
                <span>Browse Drive Folder...</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* =================================================================== */}
      {/* MODE 1: SINGLE AUDIOBOOK STITCHER WORKSPACE                        */}
      {/* =================================================================== */}
      {viewMode === 'stitch' && (
        <div className="stitcher-workspace">
          {/* Left Panel: Source Chapters & Reordering */}
          <section className="stitcher-panel chapters-panel">
            <div className="panel-header">
              <div className="panel-title-group">
                <h2>Chapter Audio Files</h2>
                <span className="badge badge-accent">{tracks.length} chapters</span>
                {detectedBitrateKbps && (
                  <span className="tag-bitrate" title="Dominant source audio bitrate detected from chapters">
                    Source: {detectedBitrateKbps} kbps
                  </span>
                )}
              </div>

              <div className="panel-actions">
                <button
                  type="button"
                  className="btn-tool"
                  onClick={sortAZ}
                  title="Sort natural chapter sequence"
                  disabled={tracks.length < 2}
                >
                  Sort A-Z
                </button>
                <button
                  type="button"
                  className="btn-tool"
                  onClick={reverseList}
                  title="Reverse sequence order"
                  disabled={tracks.length < 2}
                >
                  Reverse
                </button>
                <button
                  type="button"
                  className="btn-tool"
                  onClick={() => setTracks([])}
                  title="Clear current track list"
                  disabled={tracks.length === 0}
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
                  <p>Select an audiobook from the dropdown above to load chapter audio files from Google Drive.</p>
                </div>
              ) : (
                <ul className="chapter-list">
                  {tracks.map((track, index) => {
                    const chapterName = track.chapterTitle || track.title || track.fileName || `Chapter ${index + 1}`;
                    return (
                      <li
                        key={track.id || index}
                        className={`chapter-item ${draggedIndex === index ? 'dragging' : ''}`}
                        draggable
                        onDragStart={() => setDraggedIndex(index)}
                        onDragOver={(e) => {
                          e.preventDefault();
                          if (draggedIndex === null || draggedIndex === index) return;
                          moveTrack(draggedIndex, index);
                          setDraggedIndex(index);
                        }}
                        onDragEnd={() => setDraggedIndex(null)}
                      >
                        <div className="drag-handle" title="Drag up or down to reorder">
                          ⋮⋮
                        </div>
                        <span className="chapter-index">{index + 1}</span>
                        <div className="chapter-details">
                          <span className="chapter-title" title={chapterName}>
                            {chapterName}
                          </span>
                          <span className="chapter-meta">
                            {formatLengthShort(track.durationSec || 0)}
                            {track.sizeBytes ? ` • ${formatBytes(track.sizeBytes)}` : ''}
                            {track.bitrateKbps ? ` • ${track.bitrateKbps} kbps` : ''}
                          </span>
                        </div>
                        <div className="chapter-actions">
                          <button
                            type="button"
                            className="btn-icon"
                            onClick={() => moveTrack(index, index - 1)}
                            disabled={index === 0}
                            title="Move chapter up"
                          >
                            <ArrowUp size={14} />
                          </button>
                          <button
                            type="button"
                            className="btn-icon"
                            onClick={() => moveTrack(index, index + 1)}
                            disabled={index === tracks.length - 1}
                            title="Move chapter down"
                          >
                            <ArrowDown size={14} />
                          </button>
                          <button
                            type="button"
                            className="btn-icon btn-icon-danger"
                            onClick={() => removeTrack(index)}
                            title="Remove chapter"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {/* Chapter List Summary Footer */}
            {tracks.length > 0 && (
              <div className="chapter-list-footer">
                <span className="stat-pill">
                  <Clock size={13} />
                  <span>Total Duration: {formatLengthShort(totalDurationSec)}</span>
                </span>
                <span className="stat-pill">
                  <HardDrive size={13} />
                  <span>Source Size: {formatBytes(totalSourceBytes)}</span>
                </span>
              </div>
            )}
          </section>

          {/* Right Panel: Metadata & Quality Configuration */}
          <section className="stitcher-panel config-panel">
            {/* Metadata Form */}
            <div className="config-card">
              <div className="config-card-header">
                <h3>Audiobook Metadata & ID3 Tags</h3>
                <span className="badge badge-subtle">Tags Embedded</span>
              </div>

              <div className="metadata-form-grid">
                {/* Left: Cover Art Picker */}
                <div className="cover-picker-wrap">
                  <div className="cover-preview-box">
                    {coverPreview ? (
                      <img src={coverPreview} alt="Cover preview" className="cover-preview-img" />
                    ) : (
                      <div className="cover-placeholder">
                        <ImageIcon size={32} style={{ color: 'var(--text-muted)' }} />
                        <span>No Cover</span>
                      </div>
                    )}
                  </div>
                  <div className="cover-picker-actions">
                    <input
                      type="file"
                      ref={fileInputRef}
                      style={{ display: 'none' }}
                      accept="image/jpeg,image/png,image/webp"
                      onChange={handleCoverFileChange}
                    />
                    <button
                      type="button"
                      className="btn btn-secondary btn-xs"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Upload size={12} />
                      <span>{coverPreview ? 'Change Art' : 'Upload Art'}</span>
                    </button>
                    {coverPreview && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-xs"
                        onClick={handleRemoveCover}
                        title="Remove cover image"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>

                {/* Right: Primary Fields */}
                <div className="metadata-fields-wrap">
                  <div className="stitcher-form-group">
                    <label htmlFor="meta-stitch-title">Book Title *</label>
                    <input
                      id="meta-stitch-title"
                      type="text"
                      className="stitcher-input"
                      placeholder="e.g. Project Hail Mary"
                      value={metaTitle}
                      onChange={(e) => setMetaTitle(e.target.value)}
                    />
                  </div>

                  <div className="stitcher-form-group">
                    <label htmlFor="meta-stitch-author">Author / Artist</label>
                    <input
                      id="meta-stitch-author"
                      type="text"
                      className="stitcher-input"
                      placeholder="e.g. Andy Weir"
                      value={metaAuthor}
                      onChange={(e) => setMetaAuthor(e.target.value)}
                    />
                  </div>
                </div>
              </div>

              {/* Secondary Metadata Fields */}
              <div className="form-grid-2">
                <div className="stitcher-form-group">
                  <label htmlFor="meta-stitch-series">Series Name</label>
                  <input
                    id="meta-stitch-series"
                    type="text"
                    className="stitcher-input"
                    placeholder="e.g. The Expanse"
                    value={metaSeries}
                    onChange={(e) => setMetaSeries(e.target.value)}
                  />
                </div>

                <div className="stitcher-form-group">
                  <label htmlFor="meta-stitch-narrator">Narrator</label>
                  <input
                    id="meta-stitch-narrator"
                    type="text"
                    className="stitcher-input"
                    placeholder="e.g. Ray Porter"
                    value={metaNarrator}
                    onChange={(e) => setMetaNarrator(e.target.value)}
                  />
                </div>
              </div>

              <div className="form-grid-2">
                <div className="stitcher-form-group">
                  <label htmlFor="meta-stitch-genre">Genre</label>
                  <input
                    id="meta-stitch-genre"
                    type="text"
                    className="stitcher-input"
                    placeholder="e.g. Audiobook / Sci-Fi"
                    value={metaGenre}
                    onChange={(e) => setMetaGenre(e.target.value)}
                  />
                </div>

                <div className="stitcher-form-group">
                  <label htmlFor="meta-stitch-year">Year</label>
                  <input
                    id="meta-stitch-year"
                    type="text"
                    className="stitcher-input"
                    placeholder="e.g. 2021"
                    value={metaYear}
                    onChange={(e) => setMetaYear(e.target.value)}
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
                      >
                        <option value="32k">32 kbps (Ultra Small)</option>
                        <option value="48k">48 kbps</option>
                        <option value="64k">64 kbps (Voice)</option>
                        <option value="96k">96 kbps (Balanced)</option>
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

              {/* Smart Bitrate Detector Checkbox */}
              <div className="checkbox-wrap">
                <label className="checkbox-label-styled">
                  <input
                    type="checkbox"
                    checked={smartBitrateEnabled}
                    onChange={(e) => setSmartBitrateEnabled(e.target.checked)}
                  />
                  <div>
                    <span style={{ fontWeight: 600 }}>
                      Smart Bitrate Detector{' '}
                      <span className="badge badge-accent" style={{ fontSize: '0.68rem', padding: '1px 6px' }}>
                        Intelligent
                      </span>
                    </span>
                    <span className="checkbox-subtext">
                      Checks audio bitrate and only compresses if source bitrate exceeds target bitrate
                    </span>
                  </div>
                </label>
              </div>

              {/* Live Smart Bitrate Hint */}
              {smartBitrateHint && (
                <div className={`smart-bitrate-hint hint-${smartBitrateHint.type}`}>
                  <span className="hint-icon">💡</span>
                  <span>{smartBitrateHint.text}</span>
                </div>
              )}

              {/* Volume Normalization */}
              <div className="checkbox-wrap" style={{ marginTop: '0.75rem' }}>
                <label className="checkbox-label-styled">
                  <input
                    type="checkbox"
                    checked={normalizeVolume}
                    onChange={(e) => setNormalizeVolume(e.target.checked)}
                    disabled={selectedPreset === 'copy'}
                  />
                  <div>
                    <span style={{ fontWeight: 600 }}>EBU R128 Volume Normalization</span>
                    <span className="checkbox-subtext">
                      Equalizes loudness differences across chapters for comfortable listening
                    </span>
                  </div>
                </label>
              </div>
            </div>

            {/* Destination & Action Card */}
            <div className="config-card export-card">
              <div className="dest-box">
                <Folder size={18} className="dest-icon" />
                <div className="dest-meta">
                  <span className="dest-label">Google Drive Target:</span>
                  <span className="dest-value">
                    {user?.audiobooksFolderName || 'Audiobooks'} / {metaAuthor || 'Author'} / {metaSeries || metaTitle || 'Title'}
                  </span>
                </div>
              </div>

              <div className="stitcher-action-buttons">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={handleUpdateMetadataOnly}
                  disabled={tracks.length === 0 || isStitching || isUpdatingMetadata}
                  title="Apply metadata updates to chapters in library without merging"
                >
                  <Sparkles size={16} />
                  <span>Update Metadata Only</span>
                </button>

                <button
                  type="button"
                  className="btn btn-primary btn-stitch-run"
                  onClick={handleStartStitch}
                  disabled={tracks.length < 2 || isStitching || isUpdatingMetadata || !metaTitle.trim()}
                >
                  <Play size={18} />
                  <span>{isStitching ? 'Stitching Audiobook…' : 'Stitch & Upload to Drive'}</span>
                </button>
              </div>
            </div>
          </section>
        </div>
      )}

      {/* =================================================================== */}
      {/* MODE 2: BATCH AUDIO CONVERTER WORKSPACE (Non-stitching)             */}
      {/* =================================================================== */}
      {viewMode === 'convert' && (
        <div className="converter-workspace">
          {/* Left Panel: Files & Search */}
          <section className="converter-panel convert-files-panel">
            <div className="panel-header">
              <div className="panel-title-group">
                <h2>Audio Files to Convert</h2>
                <span className="badge badge-accent">{convertFiles.length} files</span>
                <span className="badge badge-subtle">{selectedConvertCount} selected</span>
              </div>

              <div className="panel-actions">
                <button
                  type="button"
                  className="btn-tool"
                  onClick={() => selectAllConvertFiles(true)}
                  disabled={convertFiles.length === 0}
                >
                  Select All
                </button>
                <button
                  type="button"
                  className="btn-tool"
                  onClick={() => selectAllConvertFiles(false)}
                  disabled={convertFiles.length === 0}
                >
                  Deselect All
                </button>
              </div>
            </div>

            {/* Search Toolbar */}
            <div className="convert-toolbar">
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1 }}>
                <Search size={15} style={{ color: 'var(--text-muted)' }} />
                <input
                  type="text"
                  className="convert-search-input"
                  placeholder="Filter files by title or name..."
                  value={convertSearchQuery}
                  onChange={(e) => setConvertSearchQuery(e.target.value)}
                />
              </div>
              <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                Folder: <strong>{convertFolderName || 'Audiobooks'}</strong>
              </span>
            </div>

            {/* Files List */}
            <div className="convert-files-list">
              {filteredConvertFiles.length === 0 ? (
                <div className="stitcher-empty-tracks">
                  <FileAudio size={44} style={{ color: 'var(--text-muted)', marginBottom: '0.75rem' }} />
                  <h3>No Files Found</h3>
                  <p>Select a book or browse a Google Drive folder using the buttons above to load audio files.</p>
                </div>
              ) : (
                filteredConvertFiles.map((file) => (
                  <div
                    key={file.id}
                    className={`convert-file-card ${file.selected ? 'selected' : ''} ${file.status}`}
                    onClick={() => toggleConvertFileSelected(file.id)}
                  >
                    <div className="convert-file-info">
                      <input
                        type="checkbox"
                        checked={file.selected}
                        onChange={() => {}} // handled by card click
                      />
                      <div className="convert-file-details">
                        <span className="convert-file-title" title={file.name}>
                          {file.title || file.name}
                        </span>
                        <div className="convert-file-meta">
                          <span>{file.durationFormatted}</span>
                          <span>•</span>
                          <span>{formatBytes(file.sizeBytes)}</span>
                        </div>
                      </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      {file.bitrateKbps && (
                        <span className="tag-bitrate">{file.bitrateKbps} kbps</span>
                      )}
                      <span className={`meta-chip ${file.status === 'completed' ? 'chip-emerald' : file.status === 'failed' ? 'chip-danger' : 'chip-dim'}`}>
                        {file.statusText || 'Ready'}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Converter Summary Bar */}
            <div className="convert-summary-bar">
              <span>Selected: <strong>{selectedConvertCount}</strong> of {convertFiles.length} files</span>
              <span>Total Duration: <strong>{formatLengthShort(totalConvertDurationSec)}</strong></span>
              <span>Total Size: <strong>{formatBytes(totalConvertSizeBytes)}</strong></span>
            </div>
          </section>

          {/* Right Panel: Batch Converter Configuration */}
          <section className="converter-panel convert-config-panel">
            {/* Presets Card */}
            <div className="config-card">
              <div className="config-card-header">
                <h3>Compression Preset</h3>
                <span className="badge badge-accent">Non-Stitching</span>
              </div>

              <div className="presets-list">
                {CONVERT_PRESETS.map((preset) => (
                  <label
                    key={preset.id}
                    className={`preset-card ${convertPreset === preset.id ? 'active' : ''}`}
                  >
                    <input
                      type="radio"
                      name="convert-preset"
                      value={preset.id}
                      checked={convertPreset === preset.id}
                      onChange={() => setConvertPreset(preset.id)}
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

              {/* Smart Bitrate Detector Checkbox */}
              <div className="checkbox-wrap">
                <label className="checkbox-label-styled">
                  <input
                    type="checkbox"
                    checked={convertSmartBitrate}
                    onChange={(e) => setConvertSmartBitrate(e.target.checked)}
                  />
                  <div>
                    <span style={{ fontWeight: 600 }}>
                      Smart Bitrate Detector{' '}
                      <span className="badge badge-accent" style={{ fontSize: '0.68rem', padding: '1px 6px' }}>
                        Intelligent
                      </span>
                    </span>
                    <span className="checkbox-subtext">
                      Inspects each file's bitrate and only compresses if source bitrate is higher than target
                    </span>
                  </div>
                </label>
              </div>

              {/* Volume Normalization Checkbox */}
              <div className="checkbox-wrap" style={{ marginTop: '0.75rem' }}>
                <label className="checkbox-label-styled">
                  <input
                    type="checkbox"
                    checked={convertNormalize}
                    onChange={(e) => setConvertNormalize(e.target.checked)}
                  />
                  <div>
                    <span style={{ fontWeight: 600 }}>EBU R128 Volume Normalization</span>
                    <span className="checkbox-subtext">
                      Equalizes volume across audio files for a uniform listening experience
                    </span>
                  </div>
                </label>
              </div>
            </div>

            {/* Google Drive Destination Options */}
            <div className="config-card">
              <div className="config-card-header">
                <h3>Google Drive Destination</h3>
              </div>

              <div className="radio-card-group">
                <label className={`radio-card ${convertDestMode === 'subfolder' ? 'active' : ''}`}>
                  <input
                    type="radio"
                    name="convert-dest-mode"
                    value="subfolder"
                    checked={convertDestMode === 'subfolder'}
                    onChange={() => setConvertDestMode('subfolder')}
                  />
                  <div>
                    <div className="radio-card-title">'converted' Subfolder (Recommended)</div>
                    <div className="radio-card-desc">Creates a 'converted/' folder in Google Drive and uploads new files there.</div>
                  </div>
                </label>

                <label className={`radio-card ${convertDestMode === 'in-place' ? 'active' : ''}`}>
                  <input
                    type="radio"
                    name="convert-dest-mode"
                    value="in-place"
                    checked={convertDestMode === 'in-place'}
                    onChange={() => setConvertDestMode('in-place')}
                  />
                  <div>
                    <div className="radio-card-title">In-Place Overwrite</div>
                    <div className="radio-card-desc">Safely replaces each file directly in Google Drive, preserving the same Drive ID.</div>
                  </div>
                </label>

                <label className={`radio-card ${convertDestMode === 'custom-folder' ? 'active' : ''}`}>
                  <input
                    type="radio"
                    name="convert-dest-mode"
                    value="custom-folder"
                    checked={convertDestMode === 'custom-folder'}
                    onChange={() => setConvertDestMode('custom-folder')}
                  />
                  <div style={{ flex: 1 }}>
                    <div className="radio-card-title">Custom Drive Folder</div>
                    <div className="radio-card-desc">
                      {convertCustomFolderName ? `Upload to: ${convertCustomFolderName}` : 'Choose a specific folder in Google Drive.'}
                    </div>
                  </div>
                  {convertDestMode === 'custom-folder' && (
                    <button
                      type="button"
                      className="btn btn-secondary btn-xs"
                      onClick={() => openDriveFolderPicker('destination')}
                    >
                      Choose...
                    </button>
                  )}
                </label>
              </div>

              {/* Source Cleanup (if not in-place) */}
              {convertDestMode !== 'in-place' && (
                <div className="checkbox-wrap">
                  <label className="checkbox-label-styled">
                    <input
                      type="checkbox"
                      checked={convertDeleteSource}
                      onChange={(e) => setConvertDeleteSource(e.target.checked)}
                    />
                    <div>
                      <span style={{ fontWeight: 600, color: 'var(--danger)' }}>
                        Delete source files after successful conversion
                      </span>
                      <span className="checkbox-subtext">
                        Original files in Google Drive are deleted only after the converted file is verified.
                      </span>
                    </div>
                  </label>
                </div>
              )}
            </div>

            {/* Run Button */}
            <div className="config-card export-card">
              <button
                type="button"
                className="btn btn-primary btn-stitch-run"
                onClick={handleStartBatchConvert}
                disabled={selectedConvertCount === 0 || isConverting}
              >
                <Sliders size={18} />
                <span>{isConverting ? 'Converting Audio Files…' : `Start Batch Conversion (${selectedConvertCount} Files)`}</span>
              </button>
            </div>
          </section>
        </div>
      )}
      </div>

      {/* =================================================================== */}
      {/* NON-BLOCKING STATUS FOOTER FOR STITCHING & CONVERTING               */}
      {/* =================================================================== */}
      {(isStitching || isConverting) && (
        <div
          className={`stitcher-status-footer ${hasPlayer ? 'has-player' : ''} ${hasDownloadBar ? 'has-download-bar' : ''}`}
        >
          {/* Expanded details slide-up card */}
          {statusFooterExpanded && (
            <div className="stitcher-status-details-panel">
              {isStitching && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <span className="stitcher-status-badge">Stitching</span>
                      <strong>{metaTitle || jobStatus?.title || 'Audiobook'}</strong>
                    </div>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                      {jobStatus?.speed ? `Speed: ${jobStatus.speed}` : ''}
                    </span>
                  </div>

                  <div className="stitcher-status-progress-bg" style={{ height: '8px' }}>
                    <div
                      className="stitcher-status-progress-fill"
                      style={{ width: `${jobStatus?.percent || 0}%` }}
                    />
                  </div>

                  <div className="stitcher-status-progress-meta">
                    <span>{jobStatus?.percent || 0}% complete</span>
                    <span>
                      {jobStatus?.currentTime || '00:00:00'} / {jobStatus?.totalDuration || formatLengthShort(totalDurationSec)}
                    </span>
                  </div>

                  <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                    {jobStatus?.phase}
                  </div>

                  {jobStatus?.smartBitrate && (
                    <div className={`smart-bitrate-hint hint-${jobStatus.smartBitrate.action || 'preserve'}`} style={{ marginTop: '0.2rem' }}>
                      <span className="hint-icon">💡</span>
                      <span>{jobStatus.smartBitrate.reason}</span>
                    </div>
                  )}
                </div>
              )}

              {isConverting && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <span className="stitcher-status-badge">Batch Converter</span>
                      <strong style={{ fontSize: '0.85rem' }}>
                        File {(convertJobStatus?.currentFileIndex || 0) + 1} of {convertJobStatus?.totalFiles || selectedConvertCount}: {convertJobStatus?.currentFileName || 'Processing...'}
                      </strong>
                    </div>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                      {convertJobStatus?.completedCount || 0} completed · {convertJobStatus?.failedCount || 0} failed
                    </span>
                  </div>

                  {/* Overall Bar */}
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', marginBottom: '0.25rem', color: 'var(--text-secondary)' }}>
                      <span>Overall Batch Progress</span>
                      <strong>{convertJobStatus?.overallPercent || 0}%</strong>
                    </div>
                    <div className="stitcher-status-progress-bg" style={{ height: '8px' }}>
                      <div
                        className="stitcher-status-progress-fill"
                        style={{ width: `${convertJobStatus?.overallPercent || 0}%` }}
                      />
                    </div>
                  </div>

                  {/* Current File Bar */}
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', marginBottom: '0.25rem', color: 'var(--text-secondary)' }}>
                      <span>Current File Encoding: {convertJobStatus?.speed ? `[${convertJobStatus.speed}]` : ''}</span>
                      <strong>{convertJobStatus?.currentPercent || 0}%</strong>
                    </div>
                    <div className="stitcher-status-progress-bg" style={{ height: '8px' }}>
                      <div
                        className="stitcher-status-progress-fill"
                        style={{ width: `${convertJobStatus?.currentPercent || 0}%`, backgroundColor: 'var(--accent-color)' }}
                      />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
                      <span>{convertJobStatus?.phase}</span>
                      <span>{convertJobStatus?.currentTime || '00:00:00'} / {convertJobStatus?.totalDuration || '00:00:00'}</span>
                    </div>
                  </div>

                  {convertJobStatus?.smartBitrate && (
                    <div className={`smart-bitrate-hint hint-${convertJobStatus.smartBitrate.action || 'preserve'}`} style={{ marginTop: '0.2rem' }}>
                      <span className="hint-icon">💡</span>
                      <span>{convertJobStatus.smartBitrate.reason}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Compact horizontal footer bar */}
          <div className="stitcher-status-bar-content">
            <div className="stitcher-status-left">
              <Loader2 size={18} className="spin" style={{ color: '#3ddc97', flexShrink: 0 }} />
              <div className="stitcher-status-info">
                <span
                  className="stitcher-status-title"
                  onClick={() => onNavigate?.('stitcher')}
                  title="Click to view in Audiobook Stitcher"
                >
                  {isConverting
                    ? `Converting (${(convertJobStatus?.currentFileIndex || 0) + 1}/${convertJobStatus?.totalFiles || selectedConvertCount}): ${convertJobStatus?.currentFileName || 'Audio files'}`
                    : `Stitching: ${metaTitle || jobStatus?.title || 'Audiobook'}`
                  }
                </span>
                <span className="stitcher-status-sub">
                  {isConverting
                    ? (convertJobStatus?.phase || 'Converting audio in background...')
                    : (jobStatus?.phase || 'Encoding audiobook in background...')
                  }
                </span>
              </div>
            </div>

            <div className="stitcher-status-center">
              <div className="stitcher-status-progress-meta">
                <span>
                  {isConverting
                    ? `Overall: ${convertJobStatus?.overallPercent || 0}% · File: ${convertJobStatus?.currentPercent || 0}%`
                    : `${jobStatus?.percent || 0}% · ${jobStatus?.currentTime || '00:00:00'} / ${jobStatus?.totalDuration || formatLengthShort(totalDurationSec)}`
                  }
                </span>
                <span>
                  {isConverting
                    ? (convertJobStatus?.speed || '')
                    : (jobStatus?.speed ? `Speed: ${jobStatus.speed}` : '')
                  }
                </span>
              </div>
              <div className="stitcher-status-progress-bg">
                <div
                  className="stitcher-status-progress-fill"
                  style={{
                    width: `${isConverting ? (convertJobStatus?.overallPercent || 0) : (jobStatus?.percent || 0)}%`
                  }}
                />
              </div>
            </div>

            <div className="stitcher-status-right">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setStatusFooterExpanded((prev) => !prev)}
                title={statusFooterExpanded ? 'Collapse details' : 'Expand full details'}
                style={{ padding: '0.35rem 0.6rem', fontSize: '0.78rem' }}
              >
                {statusFooterExpanded ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
                <span>{statusFooterExpanded ? 'Less' : 'Details'}</span>
              </button>

              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={isConverting ? handleCancelConvert : handleCancelStitch}
                title="Cancel ongoing operation"
                style={{ padding: '0.35rem 0.65rem', fontSize: '0.78rem', color: '#ff6b6b' }}
              >
                <X size={14} />
                <span>Cancel</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =================================================================== */}
      {/* BATCH CONVERTER SUMMARY MODAL                                       */}
      {/* =================================================================== */}
      {showConvertSummaryModal && (
        <div className="stitcher-modal-backdrop">
          <div className="stitcher-modal-card" style={{ maxWidth: '540px' }}>
            <div className="stitcher-modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
                <div style={{ color: (convertSummary?.completedCount === 0) ? '#ff6b6b' : (convertSummary?.failedCount > 0) ? '#eab308' : 'var(--accent-color)' }}>
                  {convertSummary?.completedCount === 0 ? '✕' : convertSummary?.failedCount > 0 ? '⚠️' : '✓'}
                </div>
                <h3>
                  {convertSummary?.completedCount === 0
                    ? 'Batch Conversion Failed'
                    : convertSummary?.failedCount > 0
                      ? 'Batch Conversion Finished with Warnings'
                      : 'Batch Conversion Completed!'}
                </h3>
              </div>
            </div>

            <div className="convert-stats-grid">
              <div className="convert-stat-card">
                <div className="convert-stat-val">
                  {convertSummary?.completedCount || 0} / {convertSummary?.totalFiles || 0}
                </div>
                <div className="convert-stat-lbl">Files Converted</div>
              </div>

              <div className="convert-stat-card">
                <div className="convert-stat-val">
                  {convertSummary?.totalDurationFormatted || '00:00'}
                </div>
                <div className="convert-stat-lbl">Total Audio</div>
              </div>

              <div className="convert-stat-card">
                <div className="convert-stat-val">
                  {convertSummary?.freedBytes ? formatBytes(convertSummary.freedBytes) : 'Preserved'}
                </div>
                <div className="convert-stat-lbl">Space Cleaned</div>
              </div>

              <div className="convert-stat-card">
                <div className="convert-stat-val">
                  {convertSummary?.smartPreservedCount || 0}
                </div>
                <div className="convert-stat-lbl">Smart Preserved</div>
              </div>
            </div>

            {convertSummary?.errors?.length > 0 && (
              <div className="cleanup-prompt-box" style={{ background: 'rgba(255,107,107,0.08)', borderColor: 'rgba(255,107,107,0.3)', marginTop: '0.8rem' }}>
                <div className="cleanup-header">
                  <AlertCircle size={16} style={{ color: '#ff6b6b' }} />
                  <h4 style={{ color: '#ff6b6b' }}>Failed Files ({convertSummary.errors.length})</h4>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', maxHeight: '120px', overflowY: 'auto', fontSize: '0.78rem' }}>
                  {convertSummary.errors.map((err, idx) => (
                    <div key={idx} style={{ color: 'var(--text-secondary)' }}>
                      <strong style={{ color: 'var(--text-primary)' }}>{err.fileName}</strong>: {err.error}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <p style={{ fontSize: '0.84rem', color: 'var(--text-secondary)', lineHeight: 1.45, margin: '0.75rem 0 1.25rem 0' }}>
              {convertSummary?.completedCount > 0
                ? 'Your audio files have been converted and synchronized with Google Drive. The FRAUDIO library has been updated.'
                : 'No files were converted or saved to Google Drive. Review the error details above.'}
            </p>

            <div className="stitcher-modal-footer">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setShowConvertSummaryModal(false);
                  onNavigate?.('library');
                }}
              >
                Go to Library
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setShowConvertSummaryModal(false)}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =================================================================== */}
      {/* DRIVE FOLDER BROWSER MODAL                                          */}
      {/* =================================================================== */}
      {driveModalOpen && (
        <div className="stitcher-modal-backdrop" onClick={() => setDriveModalOpen(false)}>
          <div className="stitcher-modal-card" style={{ maxWidth: '520px' }} onClick={(e) => e.stopPropagation()}>
            <div className="stitcher-modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
                <FolderOpen size={18} style={{ color: 'var(--accent-color)' }} />
                <h3>
                  {driveModalPurpose === 'destination' ? 'Select Destination Drive Folder' : 'Select Google Drive Audio Folder'}
                </h3>
              </div>
              <button
                type="button"
                className="btn-icon"
                onClick={() => setDriveModalOpen(false)}
              >
                <X size={16} />
              </button>
            </div>

            {/* Breadcrumb Path */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', padding: '0.6rem 0.85rem', background: 'rgba(0,0,0,0.25)', borderRadius: 'var(--radius-sm)', fontSize: '0.82rem', flexWrap: 'wrap' }}>
              {driveBreadcrumbs.map((crumb, idx) => (
                <span key={crumb.id} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                  <button
                    type="button"
                    className="btn-link-subtle"
                    style={{ background: 'none', border: 'none', color: idx === driveBreadcrumbs.length - 1 ? 'var(--text-primary)' : 'var(--accent-color)', cursor: 'pointer', padding: 0, fontWeight: idx === driveBreadcrumbs.length - 1 ? 600 : 400 }}
                    onClick={() => navigateDriveModalCrumb(idx)}
                  >
                    {crumb.name}
                  </button>
                  {idx < driveBreadcrumbs.length - 1 && <ChevronRight size={13} style={{ color: 'var(--text-muted)' }} />}
                </span>
              ))}
            </div>

            {/* Folder Listing */}
            <div style={{ minHeight: '220px', maxHeight: '340px', overflowY: 'auto', margin: '0.75rem 0', display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
              {driveModalLoading ? (
                <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>
                  <div className="spinner-sm" style={{ margin: '0 auto 0.5rem auto' }} />
                  <span>Loading folders from Google Drive...</span>
                </div>
              ) : driveFolders.length === 0 ? (
                <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                  No subfolders found in this directory.
                </div>
              ) : (
                driveFolders.map((folder) => {
                  const isSelected = driveModalSelected?.id === folder.id;
                  return (
                    <div
                      key={folder.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '0.55rem 0.75rem',
                        borderRadius: 'var(--radius-sm)',
                        background: isSelected ? 'rgba(61,220,151,0.08)' : 'rgba(255,255,255,0.02)',
                        border: isSelected ? '1px solid var(--accent-color)' : '1px solid var(--border-color)',
                        cursor: 'pointer'
                      }}
                      onClick={() => setDriveModalSelected(folder)}
                      onDoubleClick={() => navigateDriveModalInto(folder)}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
                        <Folder size={16} style={{ color: 'var(--accent-color)' }} />
                        <span style={{ fontSize: '0.85rem', color: 'var(--text-primary)' }}>{folder.name}</span>
                      </div>
                      <button
                        type="button"
                        className="btn btn-secondary btn-xs"
                        onClick={(e) => {
                          e.stopPropagation();
                          navigateDriveModalInto(folder);
                        }}
                      >
                        Open →
                      </button>
                    </div>
                  );
                })
              )}
            </div>

            <div className="stitcher-modal-footer">
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleConfirmDriveModalSelection}
              >
                Select Folder
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setDriveModalOpen(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =================================================================== */}
      {/* STITCH COMPLETION MODAL                                             */}
      {/* =================================================================== */}
      {showCompletionModal && (
        <div className="stitcher-modal-backdrop">
          <div className="stitcher-modal-card">
            <div className="stitcher-modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                <Check size={20} style={{ color: 'var(--accent-color)' }} />
                <h3>Audiobook Stitched Successfully!</h3>
              </div>
            </div>

            <div className="stitch-summary-card">
              <div className="sum-row">
                <span className="sum-label">Title:</span>
                <span className="sum-val">{jobStatus?.result?.title || metaTitle}</span>
              </div>
              <div className="sum-row">
                <span className="sum-label">Duration:</span>
                <span className="sum-val">{jobStatus?.result?.durationFormatted || formatLengthShort(totalDurationSec)}</span>
              </div>
              <div className="sum-row">
                <span className="sum-label">File Size:</span>
                <span className="sum-val">{formatBytes(jobStatus?.result?.fileSize || 0)}</span>
              </div>
              {jobStatus?.result?.smartBitrate && (
                <div className="sum-row">
                  <span className="sum-label">Smart Bitrate:</span>
                  <span className="sum-val" style={{ color: 'var(--accent-color)' }}>
                    {jobStatus.result.smartBitrate.reason}
                  </span>
                </div>
              )}
              <div className="sum-row">
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
    </>
  );
}
