import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { FileText, BookOpen, ScrollText, Scissors, Search, CircleCheck, Download, Monitor, Smartphone, TriangleAlert, RefreshCw, Zap, Loader2 } from 'lucide-react';
import { apiUrl } from './api';
import {
  autoDownloadComicForOffline,
  getOfflinePageUrl,
  getOfflineComic,
  getCachedOfflinePageUrl,
  deleteOfflineComic
} from './offlineStorage';

export type ReadingMode = 'single' | 'double' | 'webtoon';
export type FitMode = 'height' | 'width' | 'fill';
export type ReadingDirection = 'ltr' | 'rtl';

interface ReaderProps {
  comic: any;
  currentProfile?: any;
  user?: any;
  onClose: () => void;
}

export default function Reader({ comic, currentProfile: propProfile, user, onClose }: ReaderProps) {
  const currentProfile = propProfile || user;

  // Page state - initialize immediately from comic progress or local storage to resume reading
  const [currentPage, setCurrentPage] = useState<number>(() => {
    if (comic?.initialPage && comic.initialPage > 0) return comic.initialPage;
    if (comic?.currentPage && comic.currentPage > 0) return comic.currentPage;
    if (typeof window !== 'undefined' && comic?.id) {
      try {
        const profileKey = `comix_prog_${currentProfile?.id || 1}_${comic.id}`;
        const local = localStorage.getItem(profileKey);
        if (local) {
          if (local.trim().startsWith('{')) {
            const parsed = JSON.parse(local);
            const p = parseInt(parsed.page || parsed.currentPage, 10);
            if (p > 0) return p;
          } else {
            const p = parseInt(local, 10);
            if (p > 0) return p;
          }
        }
      } catch {}
    }
    return 1;
  });
  const progressLoadedRef = useRef<boolean>(Boolean((comic?.initialPage && comic.initialPage > 0) || (comic?.currentPage && comic.currentPage > 0)));
  const [totalPages, setTotalPages] = useState<number>(1);
  const [_loadingPages, setLoadingPages] = useState(true);
  const [backendError, setBackendError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  // Reading preferences (persisted in localStorage)
  const [readingMode, setReadingMode] = useState<ReadingMode>(() => {
    const isPortraitOrNarrow = typeof window !== 'undefined' && (
      window.innerHeight >= window.innerWidth ||
      window.innerWidth < 900 ||
      (window.screen && window.screen.height > window.screen.width)
    );
    const saved = localStorage.getItem('comic_readingMode') as ReadingMode;
    if (saved === 'double' && isPortraitOrNarrow) {
      return 'single';
    }
    return saved || 'single';
  });
  const [fitMode, setFitMode] = useState<FitMode>(() => {
    const saved = localStorage.getItem('comic_fitMode') as FitMode;
    if (saved === 'height' || saved === 'width' || saved === 'fill') return saved;
    return 'height';
  });
  const [readingDirection, setReadingDirection] = useState<ReadingDirection>(() => {
    return (localStorage.getItem('comic_readingDirection') as ReadingDirection) || 'ltr';
  });
  const [doublePageCoverSolo, setDoublePageCoverSolo] = useState<boolean>(() => {
    const saved = localStorage.getItem('comic_doubleCoverSolo');
    return saved !== null ? saved === 'true' : true;
  });
  const [splitSpreads, setSplitSpreads] = useState<boolean>(() => {
    const saved = localStorage.getItem('comic_splitSpreads');
    return saved !== null ? saved === 'true' : true;
  });
  const [subPage, setSubPage] = useState<0 | 1>(0);
  const [widePages, setWidePages] = useState<Record<number, { width: number; height: number; isWide: boolean }>>({});

  // Helper to check if current device/screen is mobile app or mobile portrait
  const checkIsMobilePortrait = useCallback(() => {
    if (typeof window === 'undefined') return false;
    const isAndroidApp = typeof navigator !== 'undefined' && /COMIXOLOFREE-Android/i.test(navigator.userAgent);
    const isPortraitQuery = window.matchMedia && window.matchMedia('(max-width: 768px) and (orientation: portrait)').matches;
    const isPortraitDim = window.innerWidth <= 768 && (
      window.innerHeight >= window.innerWidth ||
      (window.screen && window.screen.height > window.screen.width)
    );
    if (isAndroidApp) {
      const isAppPortrait = window.innerHeight >= window.innerWidth || (window.screen && window.screen.height > window.screen.width);
      return isAppPortrait || window.innerWidth <= 768;
    }
    return Boolean(isPortraitQuery || isPortraitDim);
  }, []);

  // Helper to check if current screen is desktop (wider than 1024px and landscape)
  const checkIsDesktop = useCallback(() => {
    if (typeof window === 'undefined') return false;
    const isWiderThan1024 = window.innerWidth > 1024;
    const isLandscape = window.innerWidth > window.innerHeight;
    return Boolean(isWiderThan1024 && isLandscape);
  }, []);

  // Mobile portrait / mobile app detection state
  const [isMobilePortrait, setIsMobilePortrait] = useState<boolean>(() => checkIsMobilePortrait());

  // Desktop layout detection state (> 1024px and landscape)
  const [isDesktopLayout, setIsDesktopLayout] = useState<boolean>(() => checkIsDesktop());
  const [desktopModeEnabled, setDesktopModeEnabled] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const saved = localStorage.getItem('comic_desktopMode');
    return saved !== null ? saved === 'true' : true;
  });

  const updateDesktopMode = useCallback((val: boolean) => {
    setDesktopModeEnabled(val);
    if (typeof window !== 'undefined') {
      localStorage.setItem('comic_desktopMode', String(val));
    }
  }, []);

  useEffect(() => {
    const handleResizeOrOrientation = () => {
      setIsMobilePortrait(checkIsMobilePortrait());
      setIsDesktopLayout(checkIsDesktop());
    };
    window.addEventListener('resize', handleResizeOrOrientation);
    window.addEventListener('orientationchange', handleResizeOrOrientation);
    const mediaQueryPortrait = window.matchMedia ? window.matchMedia('(max-width: 768px) and (orientation: portrait)') : null;
    const mediaQueryDesktop = window.matchMedia ? window.matchMedia('(min-width: 1025px) and (orientation: landscape)') : null;
    if (mediaQueryPortrait && mediaQueryPortrait.addEventListener) {
      mediaQueryPortrait.addEventListener('change', handleResizeOrOrientation);
    }
    if (mediaQueryDesktop && mediaQueryDesktop.addEventListener) {
      mediaQueryDesktop.addEventListener('change', handleResizeOrOrientation);
    }
    return () => {
      window.removeEventListener('resize', handleResizeOrOrientation);
      window.removeEventListener('orientationchange', handleResizeOrOrientation);
      if (mediaQueryPortrait && mediaQueryPortrait.removeEventListener) {
        mediaQueryPortrait.removeEventListener('change', handleResizeOrOrientation);
      }
      if (mediaQueryDesktop && mediaQueryDesktop.removeEventListener) {
        mediaQueryDesktop.removeEventListener('change', handleResizeOrOrientation);
      }
    };
  }, [checkIsMobilePortrait, checkIsDesktop]);

  // Add reader-open class to body while reader is mounted
  useEffect(() => {
    document.body.classList.add('reader-open');
    return () => {
      document.body.classList.remove('reader-open');
    };
  }, []);

  // Zoom Panel Visibility Preference (persisted in localStorage)
  const [zoomAlwaysVisible, setZoomAlwaysVisible] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('comic_zoomAlwaysVisible') === 'true';
  });

  // Effective Zoom Visibility: Always visible on mobile app / mobile portrait regardless of user setting!
  const effectiveZoomAlwaysVisible = isMobilePortrait || zoomAlwaysVisible;

  // Phone Mode: zoom panel fills the page area and the page shrinks into a draggable thumbnail
  const [phoneMode, setPhoneMode] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('comic_phoneMode') === 'true';
  });
  const [phoneLeftHanded, setPhoneLeftHanded] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('comic_phoneLeftHanded') === 'true';
  });

  const updatePhoneMode = useCallback((val: boolean) => {
    setPhoneMode(val);
    if (typeof window !== 'undefined') {
      localStorage.setItem('comic_phoneMode', String(val));
    }
  }, []);

  const updatePhoneLeftHanded = useCallback((val: boolean) => {
    setPhoneLeftHanded(val);
    if (typeof window !== 'undefined') {
      localStorage.setItem('comic_phoneLeftHanded', String(val));
    }
  }, []);

  // Desktop Mode: screen > 1024px and landscape (page 2/3 width full height, zoom panel last 1/3)
  const isDesktopMode = Boolean(isDesktopLayout && desktopModeEnabled && !phoneMode);

  // Measure the bottom navigation height so the phone-mode thumbnail can sit above it
  useEffect(() => {
    if (!phoneMode) return;
    const measure = () => {
      const el = controlsBarRef.current;
      if (el) setFooterOffset(el.getBoundingClientRect().height);
    };
    measure();
    const t = setTimeout(measure, 120);
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && controlsBarRef.current) {
      ro = new ResizeObserver(measure);
      ro.observe(controlsBarRef.current);
    }
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    return () => {
      clearTimeout(t);
      if (ro) ro.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
    };
  }, [phoneMode, totalPages, isMobilePortrait]);

  // UI state
  const [controlsVisible, setControlsVisible] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isSlowLoading, setIsSlowLoading] = useState(false);
  // Track which page images have completed loading
  const [loadedPages, setLoadedPages] = useState<Set<number>>(new Set());

  // Offline download & storage state
  const [offlineStatus, setOfflineStatus] = useState<{ downloaded: number; total: number; isComplete: boolean } | null>(null);
  const [offlinePageUrls, setOfflinePageUrls] = useState<Record<number, string>>({});
  const [completedOfflineNotice, setCompletedOfflineNotice] = useState<boolean>(false);
  const cancelDownloadRef = useRef<(() => void) | null>(null);
  const hasDeletedOfflineRef = useRef<boolean>(false);

  // Zoom & Pan state
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isTransitioning, setIsTransitioning] = useState(false);

  // 3-Slide Interactive Touch Carousel (1:1 Touch Dragging & Smooth Animation)
  const [dragOffset, setDragOffset] = useState<number>(0);
  const [isDraggingTrack, setIsDraggingTrack] = useState<boolean>(false);
  const [slideTransition, setSlideTransition] = useState<'none' | 'forward' | 'backward' | 'revert'>('none');
  const isAnimatingRef = useRef<boolean>(false);

  // Refs
  const containerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const webtoonContainerRef = useRef<HTMLDivElement>(null);
  const autoHideTimerRef = useRef<any>(null);
  const preloadCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const touchOccurredRef = useRef<number>(0);
  const slowLoadTimerRef = useRef<any>(null);

  // Mobile portrait refs
  const mobilePortraitImgRef = useRef<HTMLImageElement | null>(null);
  const mobilePortraitFrameRef = useRef<HTMLDivElement | null>(null);
  const isPortraitDraggingRef = useRef<boolean>(false);
  const portraitTouchStartPos = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const isPortraitMouseDownRef = useRef<boolean>(false);
  const portraitViewportRef = useRef<HTMLDivElement | null>(null);
  const portraitZoomImgRef = useRef<HTMLImageElement | null>(null);
  const portraitZoomViewportRef = useRef<HTMLDivElement | null>(null);
  const portraitZoomHighlightRef = useRef<HTMLDivElement | null>(null);
  const controlsBarRef = useRef<HTMLDivElement | null>(null);
  const [footerOffset, setFooterOffset] = useState<number>(0);

  // Zoom position persistence refs
  const lastZoomRef = useRef<{ normX: number; normY: number } | null>(null);
  const savedZoomRef = useRef<{ normX: number; normY: number } | null>((() => {
    if (typeof comic?.initialZoomNormX === 'number' && typeof comic?.initialZoomNormY === 'number') {
      return { normX: comic.initialZoomNormX, normY: comic.initialZoomNormY };
    }
    if (typeof comic?.zoomNormX === 'number' && typeof comic?.zoomNormY === 'number') {
      return { normX: comic.zoomNormX, normY: comic.zoomNormY };
    }
    if (typeof window !== 'undefined' && comic?.id) {
      try {
        const profileKey = `comix_prog_${currentProfile?.id || 1}_${comic.id}`;
        const local = localStorage.getItem(profileKey);
        if (local && local.trim().startsWith('{')) {
          const parsed = JSON.parse(local);
          if (typeof parsed.zoomNormX === 'number' && typeof parsed.zoomNormY === 'number') {
            return { normX: parsed.zoomNormX, normY: parsed.zoomNormY };
          }
        }
      } catch {}
    }
  })());
  const lastNavigatedPageRef = useRef<{ page: number; subPage: number }>({ page: currentPage, subPage: 0 });
  const saveZoomProgressTimerRef = useRef<any>(null);

  // Gesture tracking refs
  const touchStartRef = useRef<{
    x: number;
    y: number;
    time: number;
    initialDistance: number;
    initialScale: number;
    initialPan: { x: number; y: number };
    isPinching: boolean;
    hasMoved: boolean;
  }>({
    x: 0,
    y: 0,
    time: 0,
    initialDistance: 0,
    initialScale: 1,
    initialPan: { x: 0, y: 0 },
    isPinching: false,
    hasMoved: false
  });
  const lastTapRef = useRef<{ time: number; x: number; y: number }>({ time: 0, x: 0, y: 0 });
  const mouseDragRef = useRef<{ isDragging: boolean; startX: number; startY: number; startPan: { x: number; y: number } }>({
    isDragging: false,
    startX: 0,
    startY: 0,
    startPan: { x: 0, y: 0 }
  });

  // Live Zoom Preview ("Reverse Minimap" Magnifier)
  const [previewState, setPreviewState] = useState<{
    active: boolean;
    src: string;
    touchX: number;
    touchY: number;
    imgX: number;
    imgY: number;
    normX: number;
    normY: number;
    boxSide: 'right' | 'left';
    scaledWidth: number;
    scaledHeight: number;
    isTouch: boolean;
  }>({
    active: false,
    src: '',
    touchX: 0,
    touchY: 0,
    imgX: 0,
    imgY: 0,
    normX: 0.5,
    normY: 0.5,
    boxSide: 'right',
    scaledWidth: 0,
    scaledHeight: 0,
    isTouch: false
  });
  const isPreviewActiveRef = useRef<boolean>(false);
  const isTouchRef = useRef<boolean>(false);
  const holdTimerRef = useRef<any>(null);
  const holdStartPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const suppressTapRef = useRef<boolean>(false);

  // Optical Character Recognition (OCR) & Text-to-Speech (TTS) State
  const [ttsStatus, setTtsStatus] = useState<'idle' | 'scanning' | 'speaking' | 'error'>('idle');
  const [_recognizedText, setRecognizedText] = useState<string | null>(null);
  const [ttsSpeed, setTtsSpeed] = useState<number>(() => {
    const saved = localStorage.getItem('comic_ttsSpeed');
    return saved ? parseFloat(saved) : 1.0;
  });
  const [ttsAutoRead, setTtsAutoRead] = useState<boolean>(() => {
    const saved = localStorage.getItem('comic_ttsAutoRead');
    return saved === 'true';
  });
  const tesseractWorkerRef = useRef<any>(null);
  const isWorkerLoadingRef = useRef<boolean>(false);
  const autoReadTimerRef = useRef<any>(null);
  const isHoveringPreviewRef = useRef<boolean>(false);

  // Helper to persist preferences
  const updateReadingMode = (mode: ReadingMode) => {
    setReadingMode(mode);
    localStorage.setItem('comic_readingMode', mode);
    resetZoom();
  };

  const updateFitMode = (fit: FitMode) => {
    setFitMode(fit);
    localStorage.setItem('comic_fitMode', fit);
    resetZoom();
  };

  const updateReadingDirection = (dir: ReadingDirection) => {
    setReadingDirection(dir);
    localStorage.setItem('comic_readingDirection', dir);
  };

  const updateDoublePageCoverSolo = (solo: boolean) => {
    setDoublePageCoverSolo(solo);
    localStorage.setItem('comic_doubleCoverSolo', String(solo));
  };

  const updateSplitSpreads = (split: boolean) => {
    setSplitSpreads(split);
    localStorage.setItem('comic_splitSpreads', String(split));
  };

  const updateTtsSpeed = (speed: number) => {
    setTtsSpeed(speed);
    localStorage.setItem('comic_ttsSpeed', String(speed));
  };

  const updateTtsAutoRead = (auto: boolean) => {
    setTtsAutoRead(auto);
    localStorage.setItem('comic_ttsAutoRead', String(auto));
  };

  const stopSpeech = useCallback(() => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    setTtsStatus('idle');
  }, []);

  // Reset zoom & pan to default
  const resetZoom = useCallback(() => {
    setScale((prevScale) => {
      if (prevScale !== 1) {
        setIsTransitioning(true);
        setTimeout(() => setIsTransitioning(false), 220);
      }
      return 1;
    });
    setPan((prevPan) => {
      if (prevPan.x !== 0 || prevPan.y !== 0) {
        return { x: 0, y: 0 };
      }
      return prevPan;
    });
  }, []);

  // Controls auto-hide timer (disabled on mobile portrait where header/controls are permanent)
  const resetControlsTimeout = useCallback(() => {
    if (isMobilePortrait) return;
    if (autoHideTimerRef.current) clearTimeout(autoHideTimerRef.current);
    autoHideTimerRef.current = setTimeout(() => {
      setControlsVisible(false);
      setSettingsOpen(false);
    }, 4000);
  }, [isMobilePortrait]);

  useEffect(() => {
    if (isMobilePortrait) {
      setControlsVisible(true);
      if (autoHideTimerRef.current) clearTimeout(autoHideTimerRef.current);
      return;
    }
    if (controlsVisible) {
      resetControlsTimeout();
    } else if (autoHideTimerRef.current) {
      clearTimeout(autoHideTimerRef.current);
    }
    return () => {
      if (autoHideTimerRef.current) clearTimeout(autoHideTimerRef.current);
    };
  }, [controlsVisible, resetControlsTimeout, isMobilePortrait]);


  // Fetch comic page metadata from backend or offline storage
  const fetchPages = useCallback(() => {
    if (!comic?.id) return;
    setLoadingPages(true);
    setBackendError(null);

    // 1. Immediately check offline storage so offline comics load in < 5ms
    getOfflineComic(comic.id).then((offRecord) => {
      if (offRecord && offRecord.totalPages > 0) {
        setTotalPages(offRecord.totalPages);
        setOfflineStatus({
          downloaded: offRecord.downloadedPages,
          total: offRecord.totalPages,
          isComplete: offRecord.isComplete
        });
        setBackendError(null);
        setLoadingPages(false);
      }
    }).catch(() => {});

    // 2. Network fetch with 60-second timeout for remote Google Drive download
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    fetch(apiUrl(`/api/comics/${comic.id}/pages?t=${Date.now()}`), { signal: controller.signal })
      .then(async (res) => {
        clearTimeout(timeoutId);
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || `Server responded with HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((data) => {
        if (data && data.totalPages > 0) {
          setTotalPages(data.totalPages);
        }
        setBackendError(null);
        setLoadingPages(false);
      })
      .catch((err) => {
        clearTimeout(timeoutId);
        console.warn('Network comic page load failed, verifying offline storage:', err.message);
        getOfflineComic(comic.id).then((offRecord) => {
          if (offRecord && offRecord.totalPages > 0) {
            setTotalPages(offRecord.totalPages);
            setOfflineStatus({
              downloaded: offRecord.downloadedPages,
              total: offRecord.totalPages,
              isComplete: offRecord.isComplete
            });
            setBackendError(null);
          } else {
            setBackendError(err.message);
          }
          setLoadingPages(false);
        }).catch(() => {
          setBackendError(err.message);
          setLoadingPages(false);
        });
      });
  }, [comic?.id]);

  useEffect(() => {
    fetchPages();
  }, [fetchPages]);

  // Restore saved reading progress for profile
  useEffect(() => {
    if (currentProfile?.id && comic?.id) {
      fetch(apiUrl(`/api/progress/${currentProfile.id}`))
        .then((res) => res.json())
        .then((data) => {
          if (data && data[comic.id]?.currentPage) {
            const saved = data[comic.id].currentPage;
            if (typeof data[comic.id].zoomNormX === 'number' && typeof data[comic.id].zoomNormY === 'number') {
              savedZoomRef.current = { normX: data[comic.id].zoomNormX, normY: data[comic.id].zoomNormY };
            }
            if (saved > 0) {
              lastNavigatedPageRef.current.page = saved;
              setCurrentPage(saved);
            }
          }
          progressLoadedRef.current = true;
        })
        .catch(() => {
          const profileKey = `comix_prog_${currentProfile?.id || 1}_${comic.id}`;
          const localSaved = localStorage.getItem(profileKey);
          if (localSaved) {
            try {
              const parsed = JSON.parse(localSaved);
              if (parsed && typeof parsed === 'object') {
                const p = parseInt(parsed.page || parsed.currentPage, 10);
                if (typeof parsed.zoomNormX === 'number' && typeof parsed.zoomNormY === 'number') {
                  savedZoomRef.current = { normX: parsed.zoomNormX, normY: parsed.zoomNormY };
                }
                if (p > 0) {
                  lastNavigatedPageRef.current.page = p;
                  setCurrentPage(p);
                }
              } else {
                const p = parseInt(localSaved, 10);
                if (p > 0) {
                  lastNavigatedPageRef.current.page = p;
                  setCurrentPage(p);
                }
              }
            } catch {
              const p = parseInt(localSaved, 10);
              if (p > 0) {
                lastNavigatedPageRef.current.page = p;
                setCurrentPage(p);
              }
            }
          }
          progressLoadedRef.current = true;
        });
    } else {
      progressLoadedRef.current = true;
    }
  }, [comic?.id, currentProfile?.id]);

  // Unified reading progress and zoom persistence helper
  const persistProgress = useCallback((page: number, zoom?: { normX: number; normY: number } | null) => {
    if (!progressLoadedRef.current && page === 1) return;
    if (!comic?.id || page < 1) return;

    const zoomToSave = zoom !== undefined ? zoom : lastZoomRef.current;
    const profileKey = `comix_prog_${currentProfile?.id || 1}_${comic.id}`;

    try {
      localStorage.setItem(
        profileKey,
        JSON.stringify({
          page,
          currentPage: page,
          zoomNormX: zoomToSave?.normX ?? null,
          zoomNormY: zoomToSave?.normY ?? null,
          timestamp: Date.now()
        })
      );
    } catch {}

    if (currentProfile?.id) {
      fetch(apiUrl('/api/progress'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profileId: currentProfile.id,
          comicId: comic.id,
          page,
          totalPages: totalPages > 1 ? totalPages : undefined,
          zoomNormX: zoomToSave?.normX ?? null,
          zoomNormY: zoomToSave?.normY ?? null
        })
      }).catch(() => {});
    }

    if ((window as any).ReactNativeWebView) {
      try {
        (window as any).ReactNativeWebView.postMessage(
          JSON.stringify({
            type: 'PROGRESS_UPDATE',
            comicId: comic.id,
            title: comic.title,
            page,
            totalPages: totalPages > 1 ? totalPages : undefined,
            zoomNormX: zoomToSave?.normX ?? null,
            zoomNormY: zoomToSave?.normY ?? null,
            timestamp: Date.now()
          })
        );
      } catch (e) {}
    }
  }, [comic?.id, comic?.title, currentProfile?.id, totalPages]);

  // Persist reading progress locally for offline reading
  useEffect(() => {
    if (!progressLoadedRef.current && currentPage === 1) return;
    if (comic?.id && currentPage > 0) {
      persistProgress(currentPage);
    }
  }, [comic?.id, currentPage, persistProgress]);

  // Automatically download comic pages for offline reading when opened (unless already completed)
  useEffect(() => {
    if (!comic?.id || totalPages <= 0) return;
    if (currentPage >= totalPages) return;
    const cancelDownload = autoDownloadComicForOffline(comic, totalPages, (downloaded, total, isComplete) => {
      setOfflineStatus({ downloaded, total, isComplete });
    });
    cancelDownloadRef.current = cancelDownload;
    return () => {
      cancelDownload();
      cancelDownloadRef.current = null;
    };
  }, [comic?.id, totalPages]);

  // When a comic downloaded for offline reading is completed, automatically delete it from offline storage
  useEffect(() => {
    if (!comic?.id || totalPages <= 0) return;
    const isCompleted = currentPage >= totalPages && (!splitSpreads || !widePages[currentPage]?.isWide || subPage === 1);
    if (isCompleted && !hasDeletedOfflineRef.current) {
      hasDeletedOfflineRef.current = true;
      if (cancelDownloadRef.current) {
        try { cancelDownloadRef.current(); } catch {}
      }
      const activeKey = `${comic.id}_${currentPage}`;
      deleteOfflineComic(comic.id, activeKey).then(() => {
        setOfflineStatus(null);
        setCompletedOfflineNotice(true);
        setTimeout(() => setCompletedOfflineNotice(false), 4000);
      }).catch(() => {});
    }
  }, [comic?.id, currentPage, totalPages, splitSpreads, widePages, subPage]);

  // Persist reading progress whenever page changes
  useEffect(() => {
    // Avoid resetting saved progress to page 1 on initial mount before progress is ready
    if (!progressLoadedRef.current && currentPage === 1) {
      return;
    }

    const isSamePage = lastNavigatedPageRef.current.page === currentPage && lastNavigatedPageRef.current.subPage === subPage;
    if (isSamePage) {
      // Do NOT reset zoom on initial mount or re-render of current page!
      return;
    }
    lastNavigatedPageRef.current = { page: currentPage, subPage };

    // When navigating pages, reset ongoing speech and active zoom point
    savedZoomRef.current = null;
    lastZoomRef.current = null;
    persistProgress(currentPage, null);
    resetZoom();
    stopSpeech();
  }, [currentPage, subPage, comic?.id, comic?.title, currentProfile?.id, totalPages, resetZoom, stopSpeech, persistProgress]);

  // Clean up worker and audio on unmount
  useEffect(() => {
    return () => {
      stopSpeech();
      if (tesseractWorkerRef.current) {
        try {
          tesseractWorkerRef.current.terminate().catch(() => {});
        } catch {}
      }
    };
  }, [stopSpeech]);

  // Smart Preloader: Prefetches surrounding pages into memory & detects wide spreads
  const preloadPage = useCallback(
    (pageNum: number) => {
      if (pageNum < 1 || pageNum > totalPages || !comic?.id) return;
      const syncUrl = getCachedOfflinePageUrl(comic.id, pageNum);
      const url = syncUrl || offlinePageUrls[pageNum] || apiUrl(`/api/comics/${comic.id}/page/${pageNum}`);
      if (!preloadCacheRef.current.has(url)) {
        const img = new Image();
        img.src = url;
        img.onload = () => {
          if (img.naturalWidth && img.naturalHeight) {
            const ratio = img.naturalWidth / img.naturalHeight;
            setWidePages((prev) => {
              if (prev[pageNum]?.width === img.naturalWidth && prev[pageNum]?.height === img.naturalHeight) {
                return prev;
              }
              return {
                ...prev,
                [pageNum]: {
                  width: img.naturalWidth,
                  height: img.naturalHeight,
                  isWide: ratio >= 1.15
                }
              };
            });
          }
        };
        img.onerror = () => {
          if (!syncUrl && !offlinePageUrls[pageNum]) {
            getOfflinePageUrl(comic.id, pageNum).then((blobUrl) => {
              if (blobUrl) {
                setOfflinePageUrls((prev) => ({ ...prev, [pageNum]: blobUrl }));
              }
            });
          }
        };
        preloadCacheRef.current.set(url, img);
      }
    },
    [comic?.id, totalPages, offlinePageUrls]
  );

  useEffect(() => {
    if (totalPages <= 1) return;
    // Preload current, surrounding 3 forward, and 1 backward
    preloadPage(currentPage);
    preloadPage(currentPage + 1);
    preloadPage(currentPage + 2);
    preloadPage(currentPage + 3);
    preloadPage(currentPage - 1);
    if (readingMode === 'double') {
      preloadPage(currentPage + 4);
      preloadPage(currentPage + 5);
    }
  }, [currentPage, totalPages, readingMode, preloadPage]);

  // Determine current page pair for Double Page Spread
  const doublePages = useMemo(() => {
    // In portrait orientation or narrow screens, double page spreads cannot fit readable text.
    // Always force single page on portrait (height >= width) or screens narrower than 900px.
    const isPortraitOrNarrow = typeof window !== 'undefined' && (
      window.innerHeight >= window.innerWidth ||
      window.innerWidth < 900 ||
      (window.screen && window.screen.height > window.screen.width)
    );
    if (readingMode !== 'double' || isPortraitOrNarrow) return [currentPage];

    // If current page is already a wide 2-page spread, display it solo (never pair it!)
    if (widePages[currentPage]?.isWide) {
      return [currentPage];
    }

    if (doublePageCoverSolo && currentPage === 1) {
      return [1]; // Cover alone
    }
    // Pair pages (e.g. 2 & 3, 4 & 5)
    let p1 = currentPage;
    if (doublePageCoverSolo && p1 % 2 !== 0) {
      p1 = Math.max(1, p1 - 1);
    }

    if (widePages[p1]?.isWide) {
      return [p1];
    }

    const p2 = p1 + 1 <= totalPages ? p1 + 1 : null;
    if (p2 !== null && widePages[p2]?.isWide) {
      return [p1];
    }

    return p2 !== null ? [p1, p2] : [p1];
  }, [currentPage, readingMode, doublePageCoverSolo, totalPages, widePages]);

  const handleCloseReader = useCallback(() => {
    if (lastZoomRef.current && currentPage >= 1) {
      persistProgress(currentPage, lastZoomRef.current);
    }
    if (comic?.id && totalPages > 0 && currentPage >= totalPages) {
      deleteOfflineComic(comic.id).catch(() => {});
    }
    onClose();
  }, [comic?.id, totalPages, currentPage, onClose, persistProgress]);

  // Clean up any remaining offline blob URLs on unmount if comic was completed
  useEffect(() => {
    return () => {
      if (comic?.id && totalPages > 0 && currentPage >= totalPages) {
        deleteOfflineComic(comic.id).catch(() => {});
      }
    };
  }, [comic?.id, totalPages, currentPage]);

  // Reading direction & subpage aware navigation
  const navigateForward = useCallback(() => {
    const isAtEnd =
      readingMode === 'double'
        ? currentPage >= totalPages || doublePages.includes(totalPages)
        : currentPage >= totalPages && (!splitSpreads || !widePages[currentPage]?.isWide || subPage === 1);

    if (isAtEnd && totalPages > 0) {
      setCompletedOfflineNotice(true);
      setTimeout(() => setCompletedOfflineNotice(false), 3500);
      resetControlsTimeout();
      return;
    }

    if (readingMode === 'double') {
      if (doublePages.length === 1) {
        setCurrentPage((prev) => Math.min(totalPages, prev + 1));
      } else {
        setCurrentPage((prev) => Math.min(totalPages, prev + 2));
      }
    } else {
      // Single mode
      const isWide = Boolean(splitSpreads && widePages[currentPage]?.isWide);
      if (isWide && subPage === 0) {
        setSubPage(1);
      } else {
        setSubPage(0);
        setCurrentPage((prev) => Math.min(totalPages, prev + 1));
      }
    }
    resetControlsTimeout();
  }, [readingMode, doublePages, currentPage, totalPages, splitSpreads, widePages, subPage, resetControlsTimeout]);

  const navigateBackward = useCallback(() => {
    if (readingMode === 'double') {
      if (doublePages.length === 1) {
        setCurrentPage((prev) => Math.max(1, prev - 1));
      } else {
        const prevPage = Math.max(1, currentPage - 1);
        if (widePages[prevPage]?.isWide) {
          setCurrentPage(prevPage);
        } else if (currentPage <= 3 && doublePageCoverSolo) {
          setCurrentPage(1);
        } else {
          setCurrentPage((prev) => Math.max(1, prev - 2));
        }
      }
    } else {
      // Single mode
      const isWide = Boolean(splitSpreads && widePages[currentPage]?.isWide);
      if (isWide && subPage === 1) {
        setSubPage(0);
      } else {
        const prevPage = Math.max(1, currentPage - 1);
        const prevIsWide = Boolean(splitSpreads && widePages[prevPage]?.isWide);
        setSubPage(prevIsWide ? 1 : 0);
        setCurrentPage(prevPage);
      }
    }
    resetControlsTimeout();
  }, [readingMode, doublePages.length, currentPage, doublePageCoverSolo, splitSpreads, widePages, subPage, resetControlsTimeout]);

  // Smooth slide navigation transition handler
  const animatePageTransition = useCallback(
    (direction: 'forward' | 'backward') => {
      if (readingMode === 'webtoon') return;
      if (isAnimatingRef.current) return;

      const isForward = direction === 'forward';
      const isWide = Boolean(splitSpreads && readingMode === 'single' && widePages[currentPage]?.isWide);
      const canTurn = isForward
        ? (isWide && subPage === 0) || currentPage < totalPages
        : (isWide && subPage === 1) || currentPage > 1;

      if (!canTurn) {
        // Boundary rubber-band tactile bounce
        const bounce = (isForward ? -1 : 1) * (readingDirection === 'rtl' ? -28 : 28);
        setDragOffset(bounce);
        setSlideTransition('revert');
        setTimeout(() => {
          setDragOffset(0);
          setSlideTransition('none');
        }, 200);
        return;
      }

      isAnimatingRef.current = true;

      if (readingMode === 'double' && doublePages.length === 2) {
        if (isForward) navigateForward();
        else navigateBackward();
        isAnimatingRef.current = false;
        return;
      }

      setSlideTransition(direction);
      setTimeout(() => {
        if (isForward) {
          navigateForward();
        } else {
          navigateBackward();
        }
        setSlideTransition('none');
        setDragOffset(0);
        isAnimatingRef.current = false;
      }, 220);
    },
    [readingMode, splitSpreads, widePages, currentPage, subPage, totalPages, readingDirection, navigateForward, navigateBackward]
  );

  // Virtual carousel pages for 3-slide track [Slide 0: Left, Slide 1: Center, Slide 2: Right]
  const { leftSlide } = useMemo(() => {
    const isRtl = readingDirection === 'rtl';

    const getPageWideInfo = (p: number | null) => {
      if (!p || !comic?.id) return undefined;
      if (widePages[p]) return widePages[p];
      const preloaded = preloadCacheRef.current.get(apiUrl(`/api/comics/${comic.id}/page/${p}`));
      if (preloaded && preloaded.naturalWidth > 0 && preloaded.naturalHeight > 0) {
        return {
          width: preloaded.naturalWidth,
          height: preloaded.naturalHeight,
          isWide: (preloaded.naturalWidth / preloaded.naturalHeight) >= 1.15
        };
      }
      return undefined;
    };

    const currentWide = getPageWideInfo(currentPage);
    const isWide = Boolean(splitSpreads && readingMode === 'single' && currentWide?.isWide);

    const center = {
      page: currentPage,
      subPage: (isWide ? subPage : 0) as 0 | 1
    };

    let nextSlide = { page: null as number | null, subPage: 0 as 0 | 1 };
    let prevSlide = { page: null as number | null, subPage: 0 as 0 | 1 };

    // Next Slide (Forward in reading order)
    if (isWide && subPage === 0) {
      nextSlide = { page: currentPage, subPage: 1 };
    } else if (currentPage < totalPages) {
      nextSlide = { page: currentPage + 1, subPage: 0 };
    }

    // Previous Slide (Backward in reading order)
    if (isWide && subPage === 1) {
      prevSlide = { page: currentPage, subPage: 0 };
    } else if (currentPage > 1) {
      const prvPage = currentPage - 1;
      const prvWide = getPageWideInfo(prvPage);
      const prvIsWide = Boolean(splitSpreads && readingMode === 'single' && prvWide?.isWide);
      prevSlide = { page: prvPage, subPage: (prvIsWide ? 1 : 0) as 0 | 1 };
    }

    if (isRtl) {
      return {
        leftSlide: nextSlide,
        centerSlide: center,
        rightSlide: prevSlide
      };
    } else {
      return {
        leftSlide: prevSlide,
        centerSlide: center,
        rightSlide: nextSlide
      };
    }
  }, [currentPage, totalPages, subPage, splitSpreads, readingMode, widePages, readingDirection, comic?.id]);

  // Compute CSS transform and transition for 3-slide track
  const carouselTrackStyle = useMemo(() => {
    let transform = 'translate3d(-33.333333%, 0, 0)';
    let transition = 'none';

    if (isDraggingTrack) {
      transform = `translate3d(calc(-33.333333% + ${dragOffset}px), 0, 0)`;
      transition = 'none';
    } else if (slideTransition === 'forward') {
      const target = readingDirection === 'rtl' ? '0%' : '-66.666667%';
      transform = `translate3d(${target}, 0, 0)`;
      transition = 'transform 0.22s cubic-bezier(0.2, 0.9, 0.3, 1)';
    } else if (slideTransition === 'backward') {
      const target = readingDirection === 'rtl' ? '-66.666667%' : '0%';
      transform = `translate3d(${target}, 0, 0)`;
      transition = 'transform 0.22s cubic-bezier(0.2, 0.9, 0.3, 1)';
    } else if (slideTransition === 'revert') {
      transform = 'translate3d(-33.333333%, 0, 0)';
      transition = 'transform 0.2s cubic-bezier(0.25, 1, 0.5, 1)';
    }

    return {
      display: 'flex',
      flexDirection: 'row' as const,
      width: '300%',
      minWidth: '300%',
      maxWidth: '300%',
      flexBasis: '300%',
      flexShrink: 0,
      height: '100%',
      transform,
      transition,
      willChange: 'transform'
    };
  }, [isDraggingTrack, dragOffset, slideTransition, readingDirection]);

  // Jump to specific page
  const handleJumpToPage = (target: number) => {
    const clamped = Math.max(1, Math.min(totalPages, target));
    setCurrentPage(clamped);
    setDragOffset(0);
    setSlideTransition('none');
    isAnimatingRef.current = false;
    if (readingMode === 'webtoon' && webtoonContainerRef.current) {
      const el = document.getElementById(`webtoon-page-${clamped}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
    resetControlsTimeout();
  };

  // Fullscreen toggle
  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  };

  // Boundary clamp helper for pan
  const clampPan = useCallback(
    (newX: number, newY: number, targetScale: number) => {
      if (!viewportRef.current) return { x: 0, y: 0 };
      const vw = viewportRef.current.clientWidth;
      const vh = viewportRef.current.clientHeight;
      const maxPanX = Math.max(0, (vw * (targetScale - 1)) / 2);

      let extraY = 0;
      const img = viewportRef.current.querySelector('img.comic-page') as HTMLImageElement | null;
      if (img && img.clientHeight * targetScale > vh) {
        extraY = (img.clientHeight * targetScale - vh) / 2;
      }
      const maxPanY = Math.max(0, (vh * (targetScale - 1)) / 2, extraY);

      return {
        x: Math.max(-maxPanX, Math.min(maxPanX, newX)),
        y: Math.max(-maxPanY, Math.min(maxPanY, newY))
      };
    },
    []
  );

  // --- Live Zoom Preview ("Reverse Minimap" Magnifier) Helpers ---
  const findTargetComicImage = useCallback((clientX: number, clientY: number): HTMLImageElement | null => {
    if (readingMode === 'single') {
      const centerImg = viewportRef.current?.querySelector<HTMLImageElement>(
        '.reader-carousel-track > .reader-slide:nth-child(2) img'
      );
      if (centerImg && centerImg.src) return centerImg;
    }

    if (readingMode === 'double') {
      const doubleImgs = Array.from(viewportRef.current?.querySelectorAll<HTMLImageElement>('.reader-double-img') || []);
      if (doubleImgs.length === 1) return doubleImgs[0];
      if (doubleImgs.length >= 2) {
        const rect0 = doubleImgs[0].getBoundingClientRect();
        const rect1 = doubleImgs[1].getBoundingClientRect();
        if (clientX >= rect0.left && clientX <= rect0.right) return doubleImgs[0];
        if (clientX >= rect1.left && clientX <= rect1.right) return doubleImgs[1];
        const d0 = Math.abs(clientX - (rect0.left + rect0.width / 2));
        const d1 = Math.abs(clientX - (rect1.left + rect1.width / 2));
        return d0 < d1 ? doubleImgs[0] : doubleImgs[1];
      }
    }

    if (readingMode === 'webtoon') {
      const webtoonImgs = Array.from(document.querySelectorAll<HTMLImageElement>('.webtoon-page-img'));
      for (const img of webtoonImgs) {
        const rect = img.getBoundingClientRect();
        if (clientY >= rect.top && clientY <= rect.bottom) {
          return img;
        }
      }
    }

    const fallback = viewportRef.current?.querySelector<HTMLImageElement>(
      'img.comic-page, img.split-comic-img, img.reader-double-img, img.webtoon-page-img, img'
    );
    return fallback || null;
  }, [readingMode]);

  const calculatePreviewOffset = useCallback((img: HTMLImageElement, clientX: number, clientY: number) => {
    const isMobPortrait = checkIsMobilePortrait();
    const isSmall = typeof window !== 'undefined' && window.innerWidth <= 600;
    const boxWidth = isMobPortrait
      ? (typeof window !== 'undefined' ? window.innerWidth : 380)
      : (isSmall ? 240 : 380);
    const boxHeight = isMobPortrait ? 190 : (isSmall ? 200 : 260);
    const ZOOM = 2.8;

    const rect = img.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return {
        src: img.src,
        scaledWidth: boxWidth,
        scaledHeight: boxHeight,
        imgX: 0,
        imgY: 0,
        normX: 0.5,
        normY: 0.5,
        boxSide: 'right' as const
      };
    }

    const normX = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const normY = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));

    const natW = img.naturalWidth || rect.width;
    // Natural-scale-aware magnification: ensures we never downscale high-res pages,
    // and scales low-res / compressed scans to a comfortable, clear reading size
    const naturalScaleFactor = natW > 0 ? (natW * 1.6) / rect.width : ZOOM;
    const scaleFactor = Math.min(5.5, Math.max(ZOOM, naturalScaleFactor));

    const scaledWidth = rect.width * scaleFactor;
    const scaledHeight = rect.height * scaleFactor;

    let targetImgX = (boxWidth / 2) - (normX * scaledWidth);
    let targetImgY = (boxHeight / 2) - (normY * scaledHeight);

    if (scaledWidth > boxWidth) {
      targetImgX = Math.min(0, Math.max(boxWidth - scaledWidth, targetImgX));
    } else {
      targetImgX = (boxWidth - scaledWidth) / 2;
    }

    if (scaledHeight > boxHeight) {
      targetImgY = Math.min(0, Math.max(boxHeight - scaledHeight, targetImgY));
    } else {
      targetImgY = (boxHeight - scaledHeight) / 2;
    }

    const screenW = typeof window !== 'undefined' ? window.innerWidth : 800;
    const boxSide: 'right' | 'left' = (clientX > screenW - (boxWidth + 40) && clientY < boxHeight + 60)
      ? 'left'
      : 'right';

    return {
      src: img.src,
      scaledWidth: Math.round(scaledWidth),
      scaledHeight: Math.round(scaledHeight),
      imgX: Math.round(targetImgX),
      imgY: Math.round(targetImgY),
      normX,
      normY,
      boxSide
    };
  }, [checkIsMobilePortrait]);

  const activateZoomPreview = useCallback((clientX: number, clientY: number, isTouch = false) => {
    const img = findTargetComicImage(clientX, clientY);
    if (!img || !img.src) return;

    if (isTouch) {
      try {
        if (typeof navigator !== 'undefined' && navigator.vibrate) {
          navigator.vibrate(35);
        }
      } catch {}
    }

    isPreviewActiveRef.current = true;
    setIsDraggingTrack(false);
    setDragOffset(0);

    const calc = calculatePreviewOffset(img, clientX, clientY);
    setPreviewState({
      active: true,
      touchX: clientX,
      touchY: clientY,
      isTouch,
      ...calc
    });
  }, [findTargetComicImage, calculatePreviewOffset]);

  // Optical Character Recognition (OCR) & Text-to-Speech (TTS) for speech bubbles
  const readZoomDialogue = useCallback(async () => {
    if (!previewState.active || !previewState.src) return;

    // If currently speaking, clicking/pressing stops speech
    if (ttsStatus === 'speaking') {
      stopSpeech();
      return;
    }

    setTtsStatus('scanning');
    setRecognizedText(null);

    try {
      // Find the active comic image matching the preview
      let img = findTargetComicImage(previewState.touchX, previewState.touchY);
      if (!img || img.src !== previewState.src) {
        const matchingImgs = Array.from(document.querySelectorAll<HTMLImageElement>('img'));
        const found = matchingImgs.find(
          (i) => i.src === previewState.src && ((i.naturalWidth || (i as any).width || 0) > 0)
        );
        if (found) img = found;
      }

      if (!img) throw new Error('Comic image element not found');

      const natW = img.naturalWidth || (img as any).width || 800;
      const natH = img.naturalHeight || (img as any).height || 1200;

      const isSmall = typeof window !== 'undefined' && window.innerWidth <= 600;
      const boxWidth = isSmall ? 240 : 380;
      const boxHeight = isSmall ? 200 : 260;

      // Calculate the exact source rectangle currently displayed inside the preview viewport
      const scaleFactorX = (previewState.scaledWidth > 0 ? previewState.scaledWidth : boxWidth) / natW;
      const scaleFactorY = (previewState.scaledHeight > 0 ? previewState.scaledHeight : boxHeight) / natH;

      // Exactly what is visible inside the previewer viewport (strictly inside, no outer padding)
      const visibleNaturalX = -previewState.imgX / scaleFactorX;
      const visibleNaturalY = -previewState.imgY / scaleFactorY;
      const visibleNaturalW = boxWidth / scaleFactorX;
      const visibleNaturalH = boxHeight / scaleFactorY;

      // Only what is strictly inside the zoom previewer
      const sx = Math.max(0, Math.min(natW, visibleNaturalX));
      const sy = Math.max(0, Math.min(natH, visibleNaturalY));
      const sw = Math.max(1, Math.min(natW - sx, visibleNaturalW));
      const sh = Math.max(1, Math.min(natH - sy, visibleNaturalH));

      // Upscale 2.5x with high-quality smoothing so letter x-height reaches 30-40px for Tesseract LSTM
      const targetW = Math.round(sw * 2.5);
      const targetH = Math.round(sh * 2.5);

      const canvas = document.createElement('canvas');
      canvas.width = targetW;
      canvas.height = targetH;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('Canvas 2D context unavailable');

      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, targetW, targetH);

      // Preprocessing: contrast boost with smooth S-curve (preserves anti-aliased font edges)
      try {
        const imgData = ctx.getImageData(0, 0, targetW, targetH);
        const data = imgData.data;

        let totalLum = 0;
        const totalPixels = data.length / 4;
        for (let i = 0; i < data.length; i += 4) {
          totalLum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        }
        const avgLum = totalLum / totalPixels;
        const isDarkBackground = avgLum < 110; // Handle inverted narration boxes

        for (let i = 0; i < data.length; i += 4) {
          let lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          if (isDarkBackground) {
            lum = 255 - lum;
          }

          const norm = lum / 255;
          let boosted: number;

          if (norm > 0.75) {
            // Whiten bubble background & eliminate faint paper tint or snow
            boosted = 1.0;
          } else if (norm < 0.28) {
            // Darken ink text strokes
            boosted = 0.0;
          } else {
            // Smooth Hermite curve to keep character curves smooth and connected
            const t = (norm - 0.28) / (0.75 - 0.28);
            boosted = t * t * (3 - 2 * t);
          }

          const v = Math.round(boosted * 255);
          data[i] = v;
          data[i + 1] = v;
          data[i + 2] = v;
        }
        ctx.putImageData(imgData, 0, 0);
      } catch {
        // Fallback to raw canvas if getImageData is restricted
      }

      // Lazily initialize Tesseract worker
      if (!tesseractWorkerRef.current && !isWorkerLoadingRef.current) {
        isWorkerLoadingRef.current = true;
        try {
          let createWorkerFn: any = null;
          try {
            const pkgName = 'tesseract.js';
            const tMod = await import(/* @vite-ignore */ pkgName);
            createWorkerFn = tMod.createWorker || tMod.default?.createWorker;
          } catch {
            if ((window as any).Tesseract) {
              createWorkerFn = (window as any).Tesseract.createWorker;
            }
          }
          if (createWorkerFn) {
            const worker = await createWorkerFn('eng');
            tesseractWorkerRef.current = worker;
          }
        } catch (loadErr) {
          console.warn('Tesseract OCR library could not be loaded:', loadErr);
        } finally {
          isWorkerLoadingRef.current = false;
        }
      }

      const worker = tesseractWorkerRef.current;
      if (!worker) throw new Error('OCR Worker not installed or unavailable');

      // Set PSM 6 (Single Uniform Block of Text) and comic lettering whitelist
      await worker.setParameters({
        tessedit_pageseg_mode: '6' as any,
        tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.,!?\'"-:;() $%/&'
      });

      let result = await worker.recognize(canvas);
      let raw = result?.data?.text || '';

      // Fallback to PSM 11 (Sparse Text) if single block produces no dialogue
      if (!raw.trim() || raw.trim().length < 2) {
        await worker.setParameters({
          tessedit_pageseg_mode: '11' as any
        });
        result = await worker.recognize(canvas);
        raw = result?.data?.text || '';
      }

      // Clean up common comic OCR artifacts
      let cleaned = raw
        .replace(/[\r\n]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      // Filter out isolated punctuation or non-word symbols
      cleaned = cleaned
        .split(' ')
        .filter((word: string) => /[a-zA-Z0-9]/.test(word))
        .join(' ')
        .trim();

      if (!cleaned || cleaned.length < 2) {
        setRecognizedText('No dialogue detected in this area.');
        setTtsStatus('idle');
        return;
      }

      setRecognizedText(cleaned);

      // Web Speech API
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(cleaned);
        utterance.rate = ttsSpeed;
        utterance.pitch = 1.0;

        const voices = window.speechSynthesis.getVoices();
        const preferredVoice = voices.find(
          (v) => (v.lang.startsWith('en') || v.lang.startsWith('en-US')) && !v.name.includes('eSpeak')
        );
        if (preferredVoice) utterance.voice = preferredVoice;

        utterance.onstart = () => {
          setTtsStatus('speaking');
        };
        utterance.onend = () => {
          setTtsStatus('idle');
        };
        utterance.onerror = () => {
          setTtsStatus('idle');
        };

        window.speechSynthesis.speak(utterance);
      } else {
        setTtsStatus('idle');
      }
    } catch (err: any) {
      console.warn('OCR / TTS Error:', err);
      setTtsStatus('error');
      setRecognizedText('Unable to read text (OCR error)');
      setTimeout(() => setTtsStatus('idle'), 2500);
    }
  }, [previewState, ttsStatus, ttsSpeed, findTargetComicImage, stopSpeech]);

  const updateZoomPreview = useCallback((clientX: number, clientY: number, isTouch = false) => {
    const img = findTargetComicImage(clientX, clientY);
    if (!img || !img.src) {
      if (!isTouch && isPreviewActiveRef.current) {
        setPreviewState((prev) => ({ ...prev, active: false }));
        isPreviewActiveRef.current = false;
        if (autoReadTimerRef.current) clearTimeout(autoReadTimerRef.current);
      }
      return;
    }

    isPreviewActiveRef.current = true;
    const calc = calculatePreviewOffset(img, clientX, clientY);
    setPreviewState({
      active: true,
      touchX: clientX,
      touchY: clientY,
      isTouch,
      ...calc
    });

    if (ttsAutoRead && ttsStatus !== 'speaking') {
      if (autoReadTimerRef.current) clearTimeout(autoReadTimerRef.current);
      autoReadTimerRef.current = setTimeout(() => {
        if (isPreviewActiveRef.current) {
          readZoomDialogue();
        }
      }, 700);
    }
  }, [findTargetComicImage, calculatePreviewOffset, ttsAutoRead, ttsStatus, readZoomDialogue]);

  const deactivateZoomPreview = useCallback((isFromTouch = false) => {
    isHoveringPreviewRef.current = false;
    if (autoReadTimerRef.current) {
      clearTimeout(autoReadTimerRef.current);
      autoReadTimerRef.current = null;
    }
    if (isPreviewActiveRef.current) {
      isPreviewActiveRef.current = false;
      if (!effectiveZoomAlwaysVisible) {
        setPreviewState((prev) => ({ ...prev, active: false }));
      } else {
        setPreviewState((prev) => ({ ...prev, isTouch: false }));
      }
      if (isFromTouch) {
        suppressTapRef.current = true;
        setTimeout(() => {
          suppressTapRef.current = false;
        }, 250);
      }
    }
  }, [effectiveZoomAlwaysVisible]);

  const updateZoomAlwaysVisible = useCallback((val: boolean) => {
    setZoomAlwaysVisible(val);
    if (typeof window !== 'undefined') {
      localStorage.setItem('comic_zoomAlwaysVisible', String(val));
    }
    const shouldBeActive = isMobilePortrait || val;
    if (shouldBeActive) {
      const img = findTargetComicImage(window.innerWidth / 2, window.innerHeight * 0.45);
      if (img && img.src) {
        const rect = img.getBoundingClientRect();
        const clientX = rect.width > 0 ? rect.left + rect.width / 2 : window.innerWidth / 2;
        const clientY = rect.height > 0 ? rect.top + rect.height * 0.35 : window.innerHeight * 0.45;
        const offset = calculatePreviewOffset(img, clientX, clientY);
        setPreviewState({
          active: true,
          src: img.src,
          scaledWidth: offset.scaledWidth,
          scaledHeight: offset.scaledHeight,
          imgX: offset.imgX,
          imgY: offset.imgY,
          normX: offset.normX,
          normY: offset.normY,
          boxSide: offset.boxSide,
          isTouch: false,
          touchX: 0,
          touchY: 0
        });
      }
    } else {
      if (!isPreviewActiveRef.current) {
        setPreviewState((prev) => ({ ...prev, active: false }));
      }
    }
  }, [findTargetComicImage, calculatePreviewOffset, isMobilePortrait]);

  const refreshPreviewRef = useRef<() => void>(() => {});
  useEffect(() => {
    refreshPreviewRef.current = () => {
      if (!effectiveZoomAlwaysVisible) return;
      const img = findTargetComicImage(window.innerWidth / 2, window.innerHeight * 0.45);
      if (img && img.src) {
        const rect = img.getBoundingClientRect();
        const clientX = rect.width > 0 ? rect.left + rect.width / 2 : window.innerWidth / 2;
        const clientY = rect.height > 0 ? rect.top + rect.height * 0.35 : window.innerHeight * 0.45;
        const offset = calculatePreviewOffset(img, clientX, clientY);
        setPreviewState((prev) => ({
          ...prev,
          active: true,
          src: img.src,
          scaledWidth: offset.scaledWidth,
          scaledHeight: offset.scaledHeight,
          imgX: offset.imgX,
          imgY: offset.imgY,
          normX: offset.normX,
          normY: offset.normY,
          boxSide: offset.boxSide,
          isTouch: false
        }));
      }
    };
  }, [effectiveZoomAlwaysVisible, findTargetComicImage, calculatePreviewOffset]);

  useEffect(() => {
    if (!effectiveZoomAlwaysVisible) return;
    refreshPreviewRef.current();
    const t1 = setTimeout(() => {
      refreshPreviewRef.current();
    }, 120);
    const t2 = setTimeout(() => {
      refreshPreviewRef.current();
    }, 450);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [currentPage, subPage, effectiveZoomAlwaysVisible]);

  // Mobile Portrait Zoom & Inspection Calculation (Direct DOM manipulation for 120fps zero-flicker performance)
  const updateMobilePortraitZoom = useCallback((clientX: number, clientY: number) => {
    const img = mobilePortraitImgRef.current;
    if (!img || !img.src) return;

    const isWide = !phoneMode && Boolean(splitSpreads && readingMode === 'single' && widePages[currentPage]?.isWide);
    const frame = mobilePortraitFrameRef.current;
    const targetEl = isWide && frame ? frame : img;
    const rect = targetEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const ZOOM = 2.8;
    const panelRect = portraitZoomViewportRef.current?.getBoundingClientRect();
    let boxWidth = (panelRect && panelRect.width > 0) ? panelRect.width : (typeof window !== 'undefined' ? window.innerWidth : 380);
    let boxHeight = (panelRect && panelRect.height > 0) ? panelRect.height : 190;

    let normX = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    let normY = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));

    if (isWide) {
      const isRightHalf = readingDirection === 'rtl' ? (subPage === 0) : (subPage === 1);
      if (!isRightHalf) {
        normX = normX * 0.5;
      } else {
        normX = 0.5 + (normX * 0.5);
      }
    }

    const natW = img.naturalWidth || (isWide ? rect.width * 2 : rect.width);
    const effectiveDisplayWidth = isWide ? rect.width * 2 : rect.width;
    const naturalScaleFactor = natW > 0 ? (natW * 1.6) / effectiveDisplayWidth : ZOOM;
    const phoneNaturalCap = natW > 0 && effectiveDisplayWidth > 0
      ? (natW / effectiveDisplayWidth) * 2.2
      : 45;
    const scaleFactor = phoneMode
      ? Math.min(45, Math.max(ZOOM, Math.min(phoneNaturalCap, (boxWidth * 7.5) / (effectiveDisplayWidth || 1))))
      : Math.min(5.5, Math.max(ZOOM, naturalScaleFactor));

    const scaledWidth = effectiveDisplayWidth * scaleFactor;
    const scaledHeight = (isWide && img.naturalHeight && img.naturalWidth
      ? (img.naturalHeight / img.naturalWidth) * scaledWidth
      : rect.height * scaleFactor);

    let targetImgX = (boxWidth / 2) - (normX * scaledWidth);
    let targetImgY = (boxHeight / 2) - (normY * scaledHeight);

    if (scaledWidth > boxWidth) {
      targetImgX = Math.min(0, Math.max(boxWidth - scaledWidth, targetImgX));
    } else {
      targetImgX = (boxWidth - scaledWidth) / 2;
    }

    if (scaledHeight > boxHeight) {
      targetImgY = Math.min(0, Math.max(boxHeight - scaledHeight, targetImgY));
    } else {
      targetImgY = (boxHeight - scaledHeight) / 2;
    }

    // Direct DOM manipulation on the zoom preview image: eliminates React re-renders while dragging
    const zoomImg = portraitZoomImgRef.current;
    if (zoomImg) {
      zoomImg.style.width = `${Math.round(scaledWidth)}px`;
      zoomImg.style.height = `${Math.round(scaledHeight)}px`;
      zoomImg.style.transform = `translate3d(${Math.round(targetImgX)}px, ${Math.round(targetImgY)}px, 0)`;
      if (!zoomImg.src || zoomImg.src !== img.src) {
        zoomImg.src = img.src;
      }
    }

    // Direct DOM manipulation on the blue tint zoom highlight box
    const highlightEl = portraitZoomHighlightRef.current;
    const viewportEl = portraitViewportRef.current;
    if (highlightEl && viewportEl) {
      const viewportRect = viewportEl.getBoundingClientRect();
      const targetRect = targetEl.getBoundingClientRect();
      const highlightW = boxWidth / scaleFactor;
      const highlightH = boxHeight / scaleFactor;
      let hX = (-targetImgX) / scaleFactor;
      let hY = (-targetImgY) / scaleFactor;

      if (isWide) {
        const isRightHalf = readingDirection === 'rtl' ? (subPage === 0) : (subPage === 1);
        hX = hX - (isRightHalf ? rect.width : 0);
      }

      const offsetLeft = targetRect.left - viewportRect.left;
      const offsetTop = targetRect.top - viewportRect.top;
      const finalLeft = Math.max(offsetLeft, Math.min(offsetLeft + targetRect.width - highlightW, offsetLeft + hX));
      const finalTop = Math.max(offsetTop, Math.min(offsetTop + targetRect.height - highlightH, offsetTop + hY));

      highlightEl.style.display = 'block';
      highlightEl.style.left = `${Math.round(finalLeft)}px`;
      highlightEl.style.top = `${Math.round(finalTop)}px`;
      highlightEl.style.width = `${Math.round(Math.max(8, Math.min(targetRect.width, highlightW)))}px`;
      highlightEl.style.height = `${Math.round(Math.max(8, Math.min(targetRect.height, highlightH)))}px`;
    }

    savedZoomRef.current = null;
    lastZoomRef.current = { normX, normY };

    // Debounced persist zoom progress so users resume right where they left off
    if (progressLoadedRef.current && comic?.id && currentPage >= 1) {
      clearTimeout(saveZoomProgressTimerRef.current);
      saveZoomProgressTimerRef.current = setTimeout(() => {
        persistProgress(currentPage, { normX, normY });
      }, 500);
    }
  }, [splitSpreads, readingMode, widePages, currentPage, readingDirection, subPage, phoneMode, persistProgress]);

  const initMobilePortraitZoom = useCallback(() => {
    const img = mobilePortraitImgRef.current;
    if (!img || !img.src) return;

    const isWide = !phoneMode && Boolean(splitSpreads && readingMode === 'single' && widePages[currentPage]?.isWide);
    const frame = mobilePortraitFrameRef.current;
    const targetEl = isWide && frame ? frame : img;
    const rect = targetEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const ZOOM = 2.8;
    const panelRect = portraitZoomViewportRef.current?.getBoundingClientRect();
    let boxWidth = (panelRect && panelRect.width > 0) ? panelRect.width : (typeof window !== 'undefined' ? window.innerWidth : 380);
    let boxHeight = (panelRect && panelRect.height > 0) ? panelRect.height : 190;
    // On page change, reset the zoomed preview to the page's top-left corner,
    // but inset a little on both top and left (not glued to the exact 0,0 edge).
    const cornerInsetX = 20;
    const cornerInsetY = 14;

    const natW = img.naturalWidth || (isWide ? rect.width * 2 : rect.width);
    const effectiveDisplayWidth = isWide ? rect.width * 2 : rect.width;
    const naturalScaleFactor = natW > 0 ? (natW * 1.6) / effectiveDisplayWidth : ZOOM;
    const phoneNaturalCap = natW > 0 && effectiveDisplayWidth > 0
      ? (natW / effectiveDisplayWidth) * 2.2
      : 45;
    const scaleFactor = phoneMode
      ? Math.min(45, Math.max(ZOOM, Math.min(phoneNaturalCap, (boxWidth * 7.5) / (effectiveDisplayWidth || 1))))
      : Math.min(5.5, Math.max(ZOOM, naturalScaleFactor));

    const scaledWidth = effectiveDisplayWidth * scaleFactor;
    const scaledHeight = (isWide && img.naturalHeight && img.naturalWidth
      ? (img.naturalHeight / img.naturalWidth) * scaledWidth
      : rect.height * scaleFactor);

    let normX = ((boxWidth / 2) - cornerInsetX) / scaledWidth;
    let normY = ((boxHeight / 2) - cornerInsetY) / scaledHeight;

    // Check if we have a saved zoom coordinate or active zoom on this page
    const activeZoom = savedZoomRef.current || lastZoomRef.current;
    if (activeZoom) {
      normX = activeZoom.normX;
      normY = activeZoom.normY;
      lastZoomRef.current = { normX, normY };
    } else if (isWide) {
      const isRightHalf = readingDirection === 'rtl' ? (subPage === 0) : (subPage === 1);
      normX = isRightHalf ? 0.75 : 0.25;
    }

    let targetImgX = (boxWidth / 2) - (normX * scaledWidth);
    let targetImgY = (boxHeight / 2) - (normY * scaledHeight);

    if (scaledWidth > boxWidth) {
      targetImgX = Math.min(scaledWidth, Math.max(boxWidth - scaledWidth, targetImgX));
    } else {
      targetImgX = (boxWidth - scaledWidth) / 2;
    }

    if (scaledHeight > boxHeight) {
      targetImgY = Math.min(scaledHeight, Math.max(boxHeight - scaledHeight, targetImgY));
    } else {
      targetImgY = (boxHeight - scaledHeight) / 2;
    }

    const zoomImg = portraitZoomImgRef.current;
    if (zoomImg) {
      zoomImg.style.width = `${Math.round(scaledWidth)}px`;
      zoomImg.style.height = `${Math.round(scaledHeight)}px`;
      zoomImg.style.transform = `translate3d(${Math.round(targetImgX)}px, ${Math.round(targetImgY)}px, 0)`;
      if (!zoomImg.src || zoomImg.src !== img.src) {
        zoomImg.src = img.src;
      }
    }

    // Position the blue tint zoom highlight box
    const highlightEl = portraitZoomHighlightRef.current;
    const viewportEl = portraitViewportRef.current;
    if (highlightEl && viewportEl) {
      const viewportRect = viewportEl.getBoundingClientRect();
      const targetRect = targetEl.getBoundingClientRect();
      const highlightW = boxWidth / scaleFactor;
      const highlightH = boxHeight / scaleFactor;
      let hX = (-targetImgX) / scaleFactor;
      let hY = (-targetImgY) / scaleFactor;

      if (isWide) {
        const isRightHalf = readingDirection === 'rtl' ? (subPage === 0) : (subPage === 1);
        hX = hX - (isRightHalf ? rect.width : 0);
      }

      const offsetLeft = targetRect.left - viewportRect.left;
      const offsetTop = targetRect.top - viewportRect.top;
      const finalLeft = Math.max(offsetLeft, Math.min(offsetLeft + targetRect.width - highlightW, offsetLeft + hX));
      const finalTop = Math.max(offsetTop, Math.min(offsetTop + targetRect.height - highlightH, offsetTop + hY));

      highlightEl.style.display = 'block';
      highlightEl.style.left = `${Math.round(finalLeft)}px`;
      highlightEl.style.top = `${Math.round(finalTop)}px`;
      highlightEl.style.width = `${Math.round(Math.max(8, Math.min(targetRect.width, highlightW)))}px`;
      highlightEl.style.height = `${Math.round(Math.max(8, Math.min(targetRect.height, highlightH)))}px`;
    }

    setPreviewState({
      active: true,
      src: img.src,
      touchX: 0,
      touchY: 0,
      imgX: Math.round(targetImgX),
      imgY: Math.round(targetImgY),
      normX,
      normY,
      boxSide: 'right',
      scaledWidth: Math.round(scaledWidth),
      scaledHeight: Math.round(scaledHeight),
      isTouch: false
    });
  }, [splitSpreads, readingMode, widePages, currentPage, readingDirection, subPage, phoneMode]);

  // Sync zoom panel on page changes or desktop mode change
  useEffect(() => {
    initMobilePortraitZoom();
    const t1 = setTimeout(initMobilePortraitZoom, 60);
    const t2 = setTimeout(initMobilePortraitZoom, 200);
    const t3 = setTimeout(initMobilePortraitZoom, 450);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, [currentPage, subPage, isDesktopMode, initMobilePortraitZoom]);

  // Native non-passive touch listeners on comic page viewport
  // This GUARANTEES e.preventDefault() prevents native scroll, gestures, and layout displacement
  useEffect(() => {
    const el = portraitViewportRef.current;
    if (!el) return;

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        e.preventDefault();
        e.stopPropagation();
        const t = e.touches[0];
        portraitTouchStartPos.current = { x: t.clientX, y: t.clientY };
        isPortraitDraggingRef.current = true;
        updateMobilePortraitZoom(t.clientX, t.clientY);
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.touches.length === 1) {
        const t = e.touches[0];
        updateMobilePortraitZoom(t.clientX, t.clientY);
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      e.preventDefault();
      e.stopPropagation();
      isPortraitDraggingRef.current = false;
    };

    el.addEventListener('touchstart', onTouchStart, { passive: false });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: false });
    el.addEventListener('touchcancel', onTouchEnd, { passive: false });

    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [updateMobilePortraitZoom, currentPage, subPage, settingsOpen]);

  // Mouse drag listeners for testing in desktop responsive mode
  const handlePortraitMouseDown = (e: React.MouseEvent) => {
    isPortraitMouseDownRef.current = true;
    portraitTouchStartPos.current = { x: e.clientX, y: e.clientY };
    updateMobilePortraitZoom(e.clientX, e.clientY);
  };

  const handlePortraitMouseMove = (e: React.MouseEvent) => {
    if (isPortraitMouseDownRef.current || isDesktopMode) {
      updateMobilePortraitZoom(e.clientX, e.clientY);
    }
  };

  const handlePortraitMouseUp = () => {
    isPortraitMouseDownRef.current = false;
  };

  // Keyboard navigation & Shortcuts (Arrows, Fullscreen, Read Aloud with R/S)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') {
        e.preventDefault();
        animatePageTransition('forward');
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        animatePageTransition('backward');
      } else if (e.key === 'Home') {
        e.preventDefault();
        handleJumpToPage(1);
      } else if (e.key === 'End') {
        e.preventDefault();
        handleJumpToPage(totalPages);
      } else if (e.key === 'f' || e.key === 'F') {
        toggleFullscreen();
      } else if (e.key === 'm' || e.key === 'M') {
        // Toggle reading mode cycle
        setReadingMode((prev) => (prev === 'single' ? 'double' : prev === 'double' ? 'webtoon' : 'single'));
      } else if (e.key === 'w' || e.key === 'W') {
        // Toggle fit mode cycle (Fit Page -> Fit Width -> Fill Screen)
        const nextFitMap: Record<FitMode, FitMode> = { height: 'width', width: 'fill', fill: 'height' };
        setFitMode((prev) => {
          const next = nextFitMap[prev];
          localStorage.setItem('comic_fitMode', next);
          resetZoom();
          return next;
        });
      } else if (e.key === 'r' || e.key === 'R' || e.key === 's' || e.key === 'S') {
        if (isPreviewActiveRef.current) {
          e.preventDefault();
          readZoomDialogue();
        }
      } else if (e.key === 'Escape') {
        stopSpeech();
        if (!document.fullscreenElement) {
          handleCloseReader();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [animatePageTransition, totalPages, handleCloseReader, readZoomDialogue, stopSpeech]);

  useEffect(() => {
    setLoadedPages(new Set());
  }, [comic.id, retryCount]);

  // Global pointer release listener: ensures preview always closes if finger lifts outside viewport
  useEffect(() => {
    const handleGlobalPointerRelease = () => {
      if (holdTimerRef.current) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
      if (isMobilePortrait) {
        if (isPortraitDraggingRef.current) {
          isPortraitDraggingRef.current = false;
          setPreviewState((prev) => ({ ...prev, isTouch: false }));
        }
        return;
      }
      if (isPreviewActiveRef.current && isTouchRef.current) {
        deactivateZoomPreview(true);
      }
    };

    window.addEventListener('touchend', handleGlobalPointerRelease);
    window.addEventListener('touchcancel', handleGlobalPointerRelease);

    return () => {
      window.removeEventListener('touchend', handleGlobalPointerRelease);
      window.removeEventListener('touchcancel', handleGlobalPointerRelease);
      if (holdTimerRef.current) {
        clearTimeout(holdTimerRef.current);
      }
    };
  }, [deactivateZoomPreview, isMobilePortrait]);

  // Touch handlers for Desktop/Landscape (Tapping Navigation, Tap-Hold-Drag Preview, 1:1 Carousel)
  const handleTouchStart = (e: React.TouchEvent) => {
    if (isMobilePortrait) return;
    touchOccurredRef.current = Date.now();
    isTouchRef.current = true;

    if (isAnimatingRef.current) {
      isAnimatingRef.current = false;
      setSlideTransition('none');
    }

    if (e.touches.length === 2) {
      // Two-finger pinch start: cancel hold timer
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
      if (isPreviewActiveRef.current) {
        deactivateZoomPreview(true);
      }

      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);

      touchStartRef.current = {
        x: (t1.clientX + t2.clientX) / 2,
        y: (t1.clientY + t2.clientY) / 2,
        time: Date.now(),
        initialDistance: dist,
        initialScale: scale,
        initialPan: { ...pan },
        isPinching: true,
        hasMoved: false
      };
      setIsTransitioning(false);
      setIsDraggingTrack(false);
      setDragOffset(0);
    } else if (e.touches.length === 1) {
      // One-finger touch start: schedule tap-and-hold preview
      const t = e.touches[0];
      holdStartPosRef.current = { x: t.clientX, y: t.clientY };
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = setTimeout(() => {
        activateZoomPreview(t.clientX, t.clientY, true);
      }, 320);

      touchStartRef.current = {
        x: t.clientX,
        y: t.clientY,
        time: Date.now(),
        initialDistance: 0,
        initialScale: scale,
        initialPan: { ...pan },
        isPinching: false,
        hasMoved: false
      };
      setIsTransitioning(false);
      setIsDraggingTrack(false);
      setDragOffset(0);
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (isMobilePortrait) return;
    touchOccurredRef.current = Date.now();
    isTouchRef.current = true;

    // If live zoom preview is active, direct finger movement exclusively to preview!
    if (isPreviewActiveRef.current) {
      if (e.touches.length === 1) {
        const t = e.touches[0];
        updateZoomPreview(t.clientX, t.clientY, true);
      }
      return;
    }

    // If hold timer is pending and user moved finger > 8px, cancel hold (user is swiping/scrolling)
    if (holdTimerRef.current && e.touches.length === 1) {
      const t = e.touches[0];
      const dist = Math.hypot(t.clientX - holdStartPosRef.current.x, t.clientY - holdStartPosRef.current.y);
      if (dist > 8) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
    }

    if (touchStartRef.current.isPinching && e.touches.length === 2) {
      // Pinch to zoom
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      const ratio = dist / (touchStartRef.current.initialDistance || 1);
      const targetScale = Math.max(1, Math.min(8, touchStartRef.current.initialScale * ratio));

      setScale(targetScale);
      setPan(clampPan(touchStartRef.current.initialPan.x, touchStartRef.current.initialPan.y, targetScale));
      touchStartRef.current.hasMoved = true;
    } else if (!touchStartRef.current.isPinching && e.touches.length === 1) {
      const t = e.touches[0];
      const deltaX = t.clientX - touchStartRef.current.x;
      const deltaY = t.clientY - touchStartRef.current.y;
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);

      if (Math.hypot(deltaX, deltaY) > 8) {
        touchStartRef.current.hasMoved = true;
      }

      if (scale > 1.05) {
        // Panning while zoomed
        const targetX = touchStartRef.current.initialPan.x + deltaX;
        const targetY = touchStartRef.current.initialPan.y + deltaY;
        setPan(clampPan(targetX, targetY, scale));
      } else {
        // Not zoomed: check if user is scrolling vertically in fit-width mode
        const scrollEl = viewportRef.current?.querySelector('img.comic-page, .reader-split-page-frame') as HTMLElement | null;
        const hasVerticalOverflow = Boolean(scrollEl && viewportRef.current && scrollEl.clientHeight > viewportRef.current.clientHeight);
        const isVerticalScroll = fitMode === 'width' && hasVerticalOverflow && absY > absX * 1.25;

        if (isVerticalScroll) {
          const targetY = touchStartRef.current.initialPan.y + deltaY;
          setPan(clampPan(0, targetY, 1));
        } else if (readingMode === 'single' && absX > 6) {
          // 1:1 Horizontal Drag on Carousel Track
          const isRtl = readingDirection === 'rtl';
          let resistance = 1;

          // Tactile rubber-band resistance at comic boundaries
          const isWide = Boolean(splitSpreads && readingMode === 'single' && widePages[currentPage]?.isWide);
          const isAtStart = currentPage <= 1 && (!isWide || subPage === 0);
          const isAtEnd = currentPage >= totalPages && (!isWide || subPage === 1);

          if (!isRtl) {
            if (deltaX > 0 && isAtStart) resistance = 0.25;
            if (deltaX < 0 && isAtEnd) resistance = 0.25;
          } else {
            if (deltaX > 0 && isAtEnd) resistance = 0.25;
            if (deltaX < 0 && isAtStart) resistance = 0.25;
          }

          setDragOffset(deltaX * resistance);
          setIsDraggingTrack(true);
        }
      }
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (isMobilePortrait) return;
    touchOccurredRef.current = Date.now();
    clearTimeout(holdTimerRef.current);
    holdTimerRef.current = null;

    if (isPreviewActiveRef.current) {
      deactivateZoomPreview(true);
      return;
    }

    if (suppressTapRef.current) {
      return;
    }

    if (touchStartRef.current.isPinching) {
      if (scale < 1.08) {
        resetZoom();
      }
      touchStartRef.current.isPinching = false;
      return;
    }

    if (isDraggingTrack) {
      setIsDraggingTrack(false);
      const elapsed = Date.now() - touchStartRef.current.time;
      const viewportWidth = viewportRef.current?.clientWidth || window.innerWidth || 360;
      const threshold = viewportWidth * 0.18;
      const isFlick = elapsed < 280 && Math.abs(dragOffset) > 35;
      const shouldTurn = Math.abs(dragOffset) > threshold || isFlick;

      if (shouldTurn) {
        const isRtl = readingDirection === 'rtl';
        const direction: 'forward' | 'backward' = (!isRtl)
          ? (dragOffset < 0 ? 'forward' : 'backward')
          : (dragOffset > 0 ? 'forward' : 'backward');

        const isWide = Boolean(splitSpreads && readingMode === 'single' && widePages[currentPage]?.isWide);
        const canTurn = direction === 'forward'
          ? (isWide && subPage === 0) || currentPage < totalPages
          : (isWide && subPage === 1) || currentPage > 1;

        if (canTurn) {
          setSlideTransition(direction);
          setTimeout(() => {
            if (direction === 'forward') {
              navigateForward();
            } else {
              navigateBackward();
            }
            setSlideTransition('none');
            setDragOffset(0);
          }, 220);
        } else {
          // Snap back to center
          setSlideTransition('revert');
          setTimeout(() => {
            setSlideTransition('none');
            setDragOffset(0);
          }, 200);
        }
      } else {
        // Drag was less than threshold: spring back to center
        setSlideTransition('revert');
        setTimeout(() => {
          setSlideTransition('none');
          setDragOffset(0);
        }, 200);
      }
      return;
    }

    // Single touch ended without carousel drag:
    if (e.changedTouches.length === 1) {
      const t = e.changedTouches[0];

      // If finger moved significantly while zoomed or panning, ignore tap
      if (touchStartRef.current.hasMoved) {
        return;
      }

      // Double-tap detection
      const now = Date.now();
      const timeSinceLast = now - lastTapRef.current.time;
      const distFromLast = Math.hypot(t.clientX - lastTapRef.current.x, t.clientY - lastTapRef.current.y);
      lastTapRef.current = { time: now, x: t.clientX, y: t.clientY };

      if (timeSinceLast < 320 && distFromLast < 40) {
        // Double-tap: toggle zoom at tap point
        if (scale > 1.2) {
          resetZoom();
        } else {
          setIsTransitioning(true);
          const targetScale = 2.5;
          setScale(targetScale);
          if (viewportRef.current) {
            const rect = viewportRef.current.getBoundingClientRect();
            const tapX = t.clientX - rect.left - rect.width / 2;
            const tapY = t.clientY - rect.top - rect.height / 2;
            setPan(clampPan(-tapX * 1.2, -tapY * 1.2, targetScale));
          }
          setTimeout(() => setIsTransitioning(false), 220);
        }
        return;
      }

      // Single-tap zone navigation (when not zoomed)
      if (scale <= 1.05 && viewportRef.current) {
        const rect = viewportRef.current.getBoundingClientRect();
        const tapX = t.clientX - rect.left;
        const width = rect.width;

        if (tapX < width * 0.25) {
          animatePageTransition(readingDirection === 'rtl' ? 'forward' : 'backward');
        } else if (tapX > width * 0.75) {
          animatePageTransition(readingDirection === 'rtl' ? 'backward' : 'forward');
        } else {
          setControlsVisible((prev) => !prev);
        }
      } else if (scale > 1.05) {
        setControlsVisible((prev) => !prev);
      }
    }
  };

  // Mouse drag to pan when zoomed on desktop
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if (Date.now() - touchOccurredRef.current < 500) return;

    if (scale > 1.05) {
      mouseDragRef.current = {
        isDragging: true,
        startX: e.clientX,
        startY: e.clientY,
        startPan: { ...pan }
      };
    }
  };

  // On desktop: automatically show live zoom preview wherever mouse moves!
  const handleMouseMove = (e: React.MouseEvent) => {
    if (isMobilePortrait) return;
    if (isHoveringPreviewRef.current) return;
    if (Date.now() - touchOccurredRef.current < 500) return;
    isTouchRef.current = false;

    if (mouseDragRef.current.isDragging && scale > 1.05) {
      const deltaX = e.clientX - mouseDragRef.current.startX;
      const deltaY = e.clientY - mouseDragRef.current.startY;
      setPan(clampPan(mouseDragRef.current.startPan.x + deltaX, mouseDragRef.current.startPan.y + deltaY, scale));
    }

    // Hide preview when hovering over controls bars if visible
    if (controlsVisible && (e.clientY < 65 || e.clientY > window.innerHeight - 85)) {
      if (isPreviewActiveRef.current) {
        deactivateZoomPreview(false);
      }
      return;
    }

    updateZoomPreview(e.clientX, e.clientY, false);
  };

  const handleMouseUp = () => {
    mouseDragRef.current.isDragging = false;
  };

  const handleMouseLeave = () => {
    mouseDragRef.current.isDragging = false;
    if (!isTouchRef.current) {
      deactivateZoomPreview(false);
    }
  };

  // Double-click on desktop
  const handleDoubleClick = (e: React.MouseEvent) => {
    if (isMobilePortrait) return;
    if (scale > 1.2) {
      resetZoom();
    } else {
      setIsTransitioning(true);
      const targetScale = 2.5;
      setScale(targetScale);
      if (viewportRef.current) {
        const rect = viewportRef.current.getBoundingClientRect();
        const clickX = e.clientX - rect.left - rect.width / 2;
        const clickY = e.clientY - rect.top - rect.height / 2;
        setPan(clampPan(-clickX * 1.2, -clickY * 1.2, targetScale));
      }
      setTimeout(() => setIsTransitioning(false), 220);
    }
  };

  // Mouse wheel zoom (Ctrl + wheel or precision trackpad pinch)
  const handleWheel = (e: React.WheelEvent) => {
    if (readingMode === 'webtoon') return; // Let webtoon scroll naturally

    if (e.ctrlKey) {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.25 : 0.25;
      const targetScale = Math.max(1, Math.min(8, scale + delta));
      setScale(targetScale);
      if (targetScale === 1) {
        setPan({ x: 0, y: 0 });
      } else {
        setPan((prev) => clampPan(prev.x, prev.y, targetScale));
      }
    }
  };

  // Click on viewport (suppressed if touch event recently fired or preview active)
  const handleViewportClick = (e: React.MouseEvent) => {
    if (isMobilePortrait) return;
    if (suppressTapRef.current || isPreviewActiveRef.current) return;
    // If a touch gesture recently completed, ignore synthetic click
    if (Date.now() - touchOccurredRef.current < 450) return;
    if (scale > 1.05) return; // Allow panning without turning page

    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const width = rect.width;

    if (clickX < width * 0.25) {
      animatePageTransition(readingDirection === 'rtl' ? 'forward' : 'backward');
    } else if (clickX > width * 0.75) {
      animatePageTransition(readingDirection === 'rtl' ? 'backward' : 'forward');
    } else {
      setControlsVisible((prev) => !prev);
    }
  };

  // Continuous Vertical (Webtoon) mode: track page visibility
  useEffect(() => {
    if (readingMode !== 'webtoon' || !webtoonContainerRef.current) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const pageNum = Number(entry.target.getAttribute('data-page'));
            if (pageNum && pageNum !== currentPage) {
              setCurrentPage(pageNum);
            }
          }
        }
      },
      {
        root: webtoonContainerRef.current,
        threshold: 0.5
      }
    );

    const elements = webtoonContainerRef.current.querySelectorAll('.webtoon-page-wrapper');
    elements.forEach((el) => observer.observe(el));

    return () => observer.disconnect();
  }, [readingMode, totalPages, currentPage]);

  const handleAutoLocateAndRescan = async () => {
    setLoadingPages(true);
    setBackendError('Scanning library folder to locate comic archive...');
    try {
      await fetch(apiUrl('/api/settings/scan'), { method: 'POST' });
      fetchPages();
    } catch (err: any) {
      setBackendError(`Scan error: ${err.message}`);
      setLoadingPages(false);
    }
  };

  // Image load handlers
  const handleImageLoad = (e?: React.SyntheticEvent<HTMLImageElement>, pageNum?: number) => {
    if (slowLoadTimerRef.current) clearTimeout(slowLoadTimerRef.current);
    setIsSlowLoading(false);
    const pNum = pageNum || currentPage;
    if (pNum) {
      setLoadedPages((prev) => {
        if (prev.has(pNum)) return prev;
        const next = new Set(prev);
        next.add(pNum);
        return next;
      });
    }
    if (e && e.currentTarget) {
      const img = e.currentTarget;
      if (img.naturalWidth && img.naturalHeight && pNum) {
        const ratio = img.naturalWidth / img.naturalHeight;
        setWidePages((prev) => {
          if (prev[pNum]?.width === img.naturalWidth && prev[pNum]?.height === img.naturalHeight) {
            return prev;
          }
          return {
            ...prev,
            [pNum]: {
              width: img.naturalWidth,
              height: img.naturalHeight,
              isWide: ratio >= 1.15
            }
          };
        });
      }
    }
    if (effectiveZoomAlwaysVisible && pNum === currentPage) {
      setTimeout(() => {
        refreshPreviewRef.current();
      }, 50);
    }
  };

  const checkImageCached = useCallback((imgEl: HTMLImageElement | null, pageNum: number) => {
    if (imgEl && imgEl.complete && imgEl.naturalWidth > 0) {
      setLoadedPages((prev) => {
        if (prev.has(pageNum)) return prev;
        const next = new Set(prev);
        next.add(pageNum);
        return next;
      });
      if (imgEl.naturalHeight > 0) {
        const ratio = imgEl.naturalWidth / imgEl.naturalHeight;
        setWidePages((prev) => {
          if (prev[pageNum]?.width === imgEl.naturalWidth && prev[pageNum]?.height === imgEl.naturalHeight) {
            return prev;
          }
          return {
            ...prev,
            [pageNum]: {
              width: imgEl.naturalWidth,
              height: imgEl.naturalHeight,
              isWide: ratio >= 1.15
            }
          };
        });
      }
      if (effectiveZoomAlwaysVisible && pageNum === currentPage) {
        setTimeout(() => {
          refreshPreviewRef.current();
        }, 50);
      }
    }
  }, [effectiveZoomAlwaysVisible, currentPage]);

  const handleImageLoadStart = () => {
    if (slowLoadTimerRef.current) clearTimeout(slowLoadTimerRef.current);
    slowLoadTimerRef.current = setTimeout(() => {
      setIsSlowLoading(true);
    }, 120);
  };

  const handleImageError = (pageNum: number) => {
    if (!comic?.id) return;
    getOfflinePageUrl(comic.id, pageNum).then((blobUrl) => {
      if (blobUrl) {
        setOfflinePageUrls((prev) => (prev[pageNum] === blobUrl ? prev : { ...prev, [pageNum]: blobUrl }));
      }
    });
  };

  const pageImageUrl = (pageNum: number) => {
    if (offlinePageUrls[pageNum]) {
      return offlinePageUrls[pageNum];
    }
    if (comic?.id) {
      const syncUrl = getCachedOfflinePageUrl(comic.id, pageNum);
      if (syncUrl) {
        return syncUrl;
      }
      // Attempt background resolution if cached offline
      getOfflinePageUrl(comic.id, pageNum).then((blobUrl) => {
        if (blobUrl) {
          setOfflinePageUrls((prev) => (prev[pageNum] === blobUrl ? prev : { ...prev, [pageNum]: blobUrl }));
        }
      });
    }
    return apiUrl(`/api/comics/${comic.id}/page/${pageNum}?t=${retryCount}`);
  };

  // Helper to render carousel slide content (handles single pages and split 2-in-1 spreads)
  const renderSlide = (slide: { page: number | null; subPage: 0 | 1 }, isCenter: boolean) => {
    if (slide.page === null) {
      return (
        <div className="reader-edge-slide">
          <span className="reader-edge-slide-pill">
            {readingDirection === 'rtl'
              ? isCenter
                ? 'Edge'
                : slide === leftSlide
                ? 'Last Page'
                : 'First Page'
              : slide === leftSlide
              ? 'First Page'
              : 'Last Page'}
          </span>
        </div>
      );
    }

    const cachedPreload = slide.page && comic?.id
      ? preloadCacheRef.current.get(apiUrl(`/api/comics/${comic.id}/page/${slide.page}`))
      : null;
    const spreadInfo = widePages[slide.page] || (cachedPreload && cachedPreload.naturalWidth > 0 ? {
      width: cachedPreload.naturalWidth,
      height: cachedPreload.naturalHeight,
      isWide: (cachedPreload.naturalWidth / cachedPreload.naturalHeight) >= 1.15
    } : undefined);
    const isSpread = Boolean(splitSpreads && readingMode === 'single' && spreadInfo?.isWide);
    const halfAspectRatio = spreadInfo && spreadInfo.height > 0
      ? (spreadInfo.width / 2) / spreadInfo.height
      : 0.72;

    if (isSpread) {
      const isRightHalf = readingDirection === 'rtl' ? (slide.subPage === 0) : (slide.subPage === 1);
      const imgTransform = isRightHalf ? 'translateX(-50%)' : 'translateX(0%)';

      return (
        <div
          className={`reader-split-page-frame fit-${fitMode}`}
          style={{
            aspectRatio: fitMode === 'fill' ? 'auto' : `${halfAspectRatio}`,
            ['--split-aspect' as any]: `${halfAspectRatio}`,
            position: 'relative',
            width: fitMode === 'width' || fitMode === 'fill' ? '100%' : undefined,
            minWidth: fitMode === 'width' || fitMode === 'fill' ? '100%' : undefined,
            height: fitMode === 'fill' ? '100%' : undefined,
            minHeight: fitMode === 'fill' ? '100%' : undefined,
            maxHeight: fitMode === 'width' ? 'none' : undefined
          }}
        >
          <img
            ref={(el) => checkImageCached(el, slide.page!)}
            src={pageImageUrl(slide.page)}
            alt={`Page ${slide.page} (${slide.subPage + 1}/2)`}
            loading="eager"
            decoding="async"
            crossOrigin="anonymous"
            onLoadStart={isCenter ? handleImageLoadStart : undefined}
            onLoad={(e) => handleImageLoad(e, slide.page!)}
            onError={() => handleImageError(slide.page!)}
            className="split-comic-img"
            style={{
              transform: imgTransform
            }}
          />
          {isCenter && !loadedPages.has(slide.page) && (
            <div className="reader-page-loading-overlay">
              <div className="reader-loading-spinner-ring" />
              <div className="reader-loading-text-group">
                <span className="reader-loading-title">Loading Page {slide.page}</span>
                <span className="reader-loading-subtitle">({slide.subPage + 1}/2)</span>
              </div>
              <div className="reader-page-loading-progress-bar">
                <div className="reader-page-loading-progress-fill" />
              </div>
            </div>
          )}
        </div>
      );
    }

    return (
      <>
        <img
          ref={(el) => checkImageCached(el, slide.page!)}
          src={pageImageUrl(slide.page)}
          alt={`Page ${slide.page}`}
          loading="eager"
          decoding="async"
          crossOrigin="anonymous"
          onLoadStart={isCenter ? handleImageLoadStart : undefined}
          onLoad={(e) => handleImageLoad(e, slide.page!)}
          onError={() => handleImageError(slide.page!)}
          className="comic-page"
        />
        {isCenter && !loadedPages.has(slide.page) && (
          <div className="reader-page-loading-overlay">
            <div className="reader-loading-spinner-ring" />
            <div className="reader-loading-text-group">
              <span className="reader-loading-title">Loading Page {slide.page}</span>
              <span className="reader-loading-subtitle">of {totalPages}</span>
            </div>
            <div className="reader-page-loading-progress-bar">
              <div className="reader-page-loading-progress-fill" />
            </div>
          </div>
        )}
      </>
    );
  };

  // Retained legacy desktop carousel/gesture handlers — referenced here so `noUnusedLocals`
  // doesn't strip them. Kept for potential desktop-UI revival; otherwise dead.
  void [isTransitioning, updateFitMode, carouselTrackStyle, handleTouchStart, handleTouchMove,
    handleTouchEnd, handleMouseDown, handleMouseMove, handleMouseLeave, handleDoubleClick,
    handleWheel, handleViewportClick, renderSlide];

  const renderSettingsContent = () => (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontWeight: 700, fontSize: '0.92rem' }}>Reader Settings</span>
        <button
          onClick={() => setSettingsOpen(false)}
          style={{
            background: 'none',
            border: 'none',
            color: '#94a3b8',
            cursor: 'pointer',
            fontSize: '1.1rem',
            padding: '4px 8px'
          }}
        >
          ✕
        </button>
      </div>

      {/* Reading Mode Selection */}
      <div>
        <div style={{ fontSize: '0.75rem', color: '#94a3b8', fontWeight: 600, marginBottom: '0.35rem' }}>
          READING MODE
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.35rem' }}>
          <button
            className={`reader-mode-toggle-btn ${readingMode === 'single' ? 'active' : ''}`}
            onClick={() => updateReadingMode('single')}
          >
            <FileText size={15}/> Single
          </button>
          <button
            className={`reader-mode-toggle-btn ${readingMode === 'double' ? 'active' : ''}`}
            onClick={() => updateReadingMode('double')}
          >
            <BookOpen size={15}/> Double
          </button>
          <button
            className={`reader-mode-toggle-btn ${readingMode === 'webtoon' ? 'active' : ''}`}
            onClick={() => updateReadingMode('webtoon')}
          >
            <ScrollText size={15}/> Strip
          </button>
        </div>
      </div>

      {/* Reading Direction Selection */}
      <div>
        <div style={{ fontSize: '0.75rem', color: '#94a3b8', fontWeight: 600, marginBottom: '0.35rem' }}>
          READING DIRECTION
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.35rem' }}>
          <button
            className={`reader-mode-toggle-btn ${readingDirection === 'ltr' ? 'active' : ''}`}
            onClick={() => updateReadingDirection('ltr')}
          >
            &rarr; Western (LTR)
          </button>
          <button
            className={`reader-mode-toggle-btn ${readingDirection === 'rtl' ? 'active' : ''}`}
            onClick={() => updateReadingDirection('rtl')}
          >
            &larr; Manga (RTL)
          </button>
        </div>
      </div>

      {/* Split Wide 2-in-1 Spreads Toggle */}
      <div>
        <div style={{ fontSize: '0.75rem', color: '#94a3b8', fontWeight: 600, marginBottom: '0.35rem' }}>
          TWO-PAGE SCANS (2-IN-1)
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.35rem' }}>
          <button
            className={`reader-mode-toggle-btn ${splitSpreads ? 'active' : ''}`}
            onClick={() => {
              updateSplitSpreads(true);
              setSubPage(0);
            }}
            title="Automatically split two-page spreads into single pages"
          >
            <Scissors size={15}/> Split (Single)
          </button>
          <button
            className={`reader-mode-toggle-btn ${!splitSpreads ? 'active' : ''}`}
            onClick={() => {
              updateSplitSpreads(false);
              setSubPage(0);
            }}
            title="View full two-page spread together"
          >
            ◫ Full Spread
          </button>
        </div>
      </div>

      {/* Text-To-Speech (TTS) & OCR Controls */}
      <div>
        <div style={{ fontSize: '0.75rem', color: '#94a3b8', fontWeight: 600, marginBottom: '0.35rem' }}>
          SPEECH BUBBLE TTS & OCR
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: '0.78rem', color: '#cbd5e1' }}>Auto-Read on Hover</span>
            <input
              type="checkbox"
              checked={ttsAutoRead}
              onChange={(e) => updateTtsAutoRead(e.target.checked)}
              style={{ accentColor: '#3b82f6', cursor: 'pointer', width: '16px', height: '16px' }}
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: '0.78rem', color: '#cbd5e1' }}>Voice Speed</span>
            <div style={{ display: 'flex', gap: '0.25rem' }}>
              {[0.8, 1.0, 1.2].map((spd) => (
                <button
                  key={spd}
                  onClick={() => updateTtsSpeed(spd)}
                  className={`reader-mode-toggle-btn ${ttsSpeed === spd ? 'active' : ''}`}
                  style={{ padding: '2px 7px', fontSize: '0.72rem' }}
                >
                  {spd}x
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Double Page Cover Solo toggle */}
      {readingMode === 'double' && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '0.2rem' }}>
          <span style={{ fontSize: '0.78rem', color: '#cbd5e1' }}>Page 1 Solo Cover</span>
          <input
            type="checkbox"
            checked={doublePageCoverSolo}
            onChange={(e) => updateDoublePageCoverSolo(e.target.checked)}
            style={{ accentColor: '#3b82f6', cursor: 'pointer', width: '16px', height: '16px' }}
          />
        </div>
      )}

      {/* Live Zoom Panel Options */}
      <div>
        <div style={{ fontSize: '0.75rem', color: '#94a3b8', fontWeight: 600, marginBottom: '0.35rem' }}>
          LIVE ZOOM PANEL
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: '0.78rem', color: '#cbd5e1' }}>Always Visible</div>
            <div style={{ fontSize: '0.68rem', color: '#64748b' }}>
              {isMobilePortrait ? 'Always active on mobile portrait' : 'Pin zoom lens on screen'}
            </div>
          </div>
          <input
            type="checkbox"
            checked={effectiveZoomAlwaysVisible}
            disabled={isMobilePortrait}
            onChange={(e) => updateZoomAlwaysVisible(e.target.checked)}
            style={{
              accentColor: '#38bdf8',
              cursor: isMobilePortrait ? 'default' : 'pointer',
              width: '16px',
              height: '16px',
              opacity: isMobilePortrait ? 0.8 : 1
            }}
          />
        </div>
      </div>

      {/* Quick Zoom Reset */}
      {scale > 1.05 && (
        <button
          onClick={resetZoom}
          style={{
            background: 'rgba(59, 130, 246, 0.2)',
            border: '1px solid rgba(59, 130, 246, 0.4)',
            color: '#60a5fa',
            padding: '0.45rem',
            borderRadius: '8px',
            fontWeight: 600,
            fontSize: '0.8rem',
            cursor: 'pointer'
          }}
        >
          <Search size={15}/> Reset Zoom ({scale.toFixed(1)}x)
        </button>
      )}
    </>
  );

  const isZoomPanelVisible = isMobilePortrait || isDesktopMode || Boolean(effectiveZoomAlwaysVisible || previewState.active);
  const effectiveControlsVisible = isMobilePortrait || isDesktopMode || controlsVisible;

  return (
    <div
      ref={containerRef}
      className={`reader-container ${isDesktopMode ? 'desktop-mode' : ''} ${isMobilePortrait ? 'is-mobile-portrait' : ''} ${readingMode === 'webtoon' ? 'mode-webtoon' : ''} ${phoneMode ? 'phone-mode' : ''} ${phoneLeftHanded ? 'phone-left-handed' : ''} ${isZoomPanelVisible ? 'has-top-zoom' : ''} ${effectiveZoomAlwaysVisible ? 'zoom-always-visible' : ''} ${effectiveControlsVisible ? 'controls-visible' : 'controls-hidden'}`}
      style={{ '--reader-footer-offset': `${footerOffset || 64}px` } as React.CSSProperties}
      onMouseUp={handleMouseUp}
    >
      {/* Top Loading Progress Line */}
      {(!loadedPages.has(currentPage) || isSlowLoading) && (
        <div className="reader-top-loading-bar" />
      )}

      {/* Top Header HUD Overlay */}
      <div className={`reader-header ${effectiveControlsVisible ? 'visible' : ''}`}>
        <button className="close-btn" onClick={handleCloseReader} title="Back to Library (Esc)">
          &larr; <span className="desktop-btn-label">Back</span>
        </button>

        <div
          style={{
            marginLeft: '0.6rem',
            marginRight: '0.6rem',
            color: '#fff',
            fontWeight: 700,
            fontSize: '0.88rem',
            flex: 1,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            display: 'flex',
            alignItems: 'center',
            gap: '0.45rem'
          }}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{comic.title}</span>
          {completedOfflineNotice && (
            <span
              style={{
                background: 'rgba(16, 185, 129, 0.25)',
                border: '1px solid #10b981',
                color: '#34d399',
                padding: '2px 8px',
                borderRadius: '12px',
                fontSize: '0.72rem',
                fontWeight: 700,
                whiteSpace: 'nowrap',
                flexShrink: 0,
                marginLeft: 'auto',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px'
              }}
              title="Comic completed and removed from offline storage"
            >
              ✓ Completed • Offline storage cleared
            </span>
          )}
          {!completedOfflineNotice && offlineStatus && (
            <span
              style={{
                background: offlineStatus.isComplete ? 'rgba(16, 185, 129, 0.2)' : 'rgba(56, 189, 248, 0.2)',
                border: `1px solid ${offlineStatus.isComplete ? '#10b981' : '#38bdf8'}`,
                color: offlineStatus.isComplete ? '#34d399' : '#38bdf8',
                padding: '2px 8px',
                borderRadius: '12px',
                fontSize: '0.72rem',
                fontWeight: 700,
                whiteSpace: 'nowrap',
                flexShrink: 0,
                marginLeft: 'auto',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px'
              }}
              title={offlineStatus.isComplete ? 'All pages saved for offline reading' : 'Downloading pages for offline reading in background'}
            >
              {offlineStatus.isComplete ? <><CircleCheck size={14}/> Offline</> : <><Download size={14}/> Offline: {offlineStatus.downloaded}/{offlineStatus.total}</>}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexShrink: 0 }}>
          {isDesktopLayout && !phoneMode && (
            <button
              className={`reader-header-btn ${desktopModeEnabled ? 'primary' : ''}`}
              onClick={() => updateDesktopMode(!desktopModeEnabled)}
              title={desktopModeEnabled ? 'Desktop Mode Active (2/3 Page, 1/3 Zoom)' : 'Switch to Desktop Mode'}
              style={{ padding: '0.4rem 0.55rem', fontSize: '0.9rem', lineHeight: 1 }}
            >
              <Monitor size={16}/>
            </button>
          )}
          {phoneMode && (
            <button
              className="reader-header-btn"
              onClick={() => updatePhoneLeftHanded(!phoneLeftHanded)}
              title={phoneLeftHanded ? 'Thumbnail on bottom-left (tap for right)' : 'Thumbnail on bottom-right (tap for left)'}
              style={{ padding: '0.4rem 0.55rem', fontSize: '0.9rem', lineHeight: 1 }}
            >
              {phoneLeftHanded ? '◀' : '▶'}
            </button>
          )}
          <button
            className={`reader-header-btn ${phoneMode ? 'primary' : ''}`}
            onClick={() => updatePhoneMode(!phoneMode)}
            title={phoneMode ? 'Disable Phone Mode' : 'Phone Mode: drag the page thumbnail to pan the zoom'}
            style={{ padding: '0.4rem 0.55rem', fontSize: '0.9rem', lineHeight: 1 }}
          >
            <Smartphone size={16}/>
          </button>
        </div>
      </div>

      {/* Chunk 2: Zoom Panel (Always visible directly below header) */}
      <div className="reader-zoom-panel">
        <div className="reader-zoom-preview-viewport" ref={portraitZoomViewportRef}>
          <img
            ref={portraitZoomImgRef}
            src={previewState.src || pageImageUrl(currentPage)}
            alt="Zoomed Preview"
            className="reader-zoom-preview-img"
            style={{
              width: `${previewState.scaledWidth > 0 ? previewState.scaledWidth : 800}px`,
              height: `${previewState.scaledHeight > 0 ? previewState.scaledHeight : 180 * 2.8}px`,
              transform: `translate3d(${previewState.imgX}px, ${previewState.imgY}px, 0)`
            }}
          />
          </div>
      </div>

      {/* Chunk 3: Comic Page Viewport (Fills remaining space with the comic page image) */}
      <div className="reader-middle">
        {settingsOpen ? (
          <div className="reader-settings-panel-middle">
            {renderSettingsContent()}
          </div>
        ) : backendError ? (
          <div style={{ flex: 1, height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#ef4444', padding: '2rem 1rem', textAlign: 'center' }}>
            <div style={{ marginBottom: '0.75rem' }}><TriangleAlert size={40}/></div>
            <div style={{ fontWeight: 700, fontSize: '1.2rem', marginBottom: '0.5rem' }}>Unable to Open Comic Archive</div>
            <div style={{ background: 'rgba(239, 68, 68, 0.15)', border: '1px solid rgba(239, 68, 68, 0.4)', borderRadius: '8px', padding: '0.75rem 1rem', color: '#fca5a5', fontSize: '0.85rem', fontFamily: 'monospace', wordBreak: 'break-all', margin: '1rem 0', maxWidth: '600px' }}>
              {backendError}
            </div>
            <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', justifyContent: 'center' }}>
              <button onClick={() => { setBackendError(null); setRetryCount((c) => c + 1); fetchPages(); }} className="control-btn" style={{ background: 'var(--accent-color)' }}>
                <RefreshCw size={16}/> Retry Loading
              </button>
              <button onClick={handleAutoLocateAndRescan} className="control-btn">
                <Zap size={16}/> Auto-Locate / Rescan Library
              </button>
            </div>
          </div>
        ) : (
          <div
            ref={portraitViewportRef}
            className="reader-page-viewport"
            onMouseDown={handlePortraitMouseDown}
            onMouseMove={handlePortraitMouseMove}
            onMouseUp={handlePortraitMouseUp}
            onMouseLeave={handlePortraitMouseUp}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            {/* Blue Tint Zoom Highlight Overlay */}
            <div
              ref={portraitZoomHighlightRef}
              className="reader-zoom-highlight"
            />
            {!phoneMode && splitSpreads && readingMode === 'single' && widePages[currentPage]?.isWide ? (
              <div
                ref={mobilePortraitFrameRef}
                className="reader-split-page-frame"
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: '100%',
                  height: '100%',
                  maxWidth: '100%',
                  maxHeight: '100%',
                  margin: 0,
                  padding: 0,
                  overflow: 'hidden'
                }}
              >
                <img
                  ref={mobilePortraitImgRef}
                  src={pageImageUrl(currentPage)}
                  alt={`Page ${currentPage} (${subPage + 1}/2)`}
                  loading="eager"
                  decoding="async"
                  crossOrigin="anonymous"
                  onLoad={(e) => {
                    handleImageLoad(e, currentPage);
                    setTimeout(initMobilePortraitZoom, 40);
                  }}
                  onError={() => handleImageError(currentPage)}
                  className="split-comic-img"
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '250%',
                    height: '100%',
                    maxWidth: 'none',
                    maxHeight: 'none',
                    objectFit: 'fill',
                    pointerEvents: 'none',
                    transform: (readingDirection === 'rtl' ? subPage === 0 : subPage === 1)
                      ? 'translateX(-50%)'
                      : 'translateX(-10%)'
                  }}
                />
                {!loadedPages.has(currentPage) && (
                  <div className="reader-page-loading-overlay">
                    <div className="reader-loading-spinner-ring" />
                    <div className="reader-loading-text-group">
                      <span className="reader-loading-title">Loading Page {currentPage}</span>
                      <span className="reader-loading-subtitle">({subPage + 1}/2)</span>
                    </div>
                    <div className="reader-page-loading-progress-bar">
                      <div className="reader-page-loading-progress-fill" />
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <>
                <img
                  ref={mobilePortraitImgRef}
                  src={pageImageUrl(currentPage)}
                  alt={`Page ${currentPage}`}
                  loading="eager"
                  decoding="async"
                  crossOrigin="anonymous"
                  onLoad={(e) => {
                    handleImageLoad(e, currentPage);
                    setTimeout(initMobilePortraitZoom, 40);
                  }}
                  onError={() => handleImageError(currentPage)}
                  className="comic-page"
                  style={{
                    width: isDesktopMode ? 'auto' : '100%',
                    height: '100%',
                    maxWidth: '100%',
                    maxHeight: '100%',
                    objectFit: isDesktopMode ? 'contain' : 'fill',
                    margin: isDesktopMode ? '0 auto' : 0,
                    padding: 0,
                    display: 'block',
                    pointerEvents: 'none'
                  }}
                />
                {!loadedPages.has(currentPage) && (
                  <div className="reader-page-loading-overlay">
                    <div className="reader-loading-spinner-ring" />
                    <div className="reader-loading-text-group">
                      <span className="reader-loading-title">Loading Page {currentPage}</span>
                      <span className="reader-loading-subtitle">of {totalPages}</span>
                    </div>
                    <div className="reader-page-loading-progress-bar">
                      <div className="reader-page-loading-progress-fill" />
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Chunk 4: Bottom Footer Navigation Bar (Always visible!) */}
      <div
        ref={controlsBarRef}
        className="reader-controls visible"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="reader-controls-inner">
          {/* Page Scrubber Slider */}
          <div className="reader-scrubber-row">
            <button
              className="scrubber-edge-btn"
              onClick={() => handleJumpToPage(1)}
              title="First Page"
              disabled={currentPage <= 1 && (readingMode === 'single' && splitSpreads && widePages[currentPage]?.isWide ? subPage === 0 : true)}
              style={{
                background: 'none',
                border: 'none',
                color: currentPage <= 1 && (readingMode === 'single' && splitSpreads && widePages[currentPage]?.isWide ? subPage === 0 : true) ? '#475569' : '#94a3b8',
                cursor: currentPage <= 1 && (readingMode === 'single' && splitSpreads && widePages[currentPage]?.isWide ? subPage === 0 : true) ? 'not-allowed' : 'pointer',
                fontSize: '0.85rem',
                padding: '0 4px',
                fontWeight: 700
              }}
            >
              ⇤
            </button>

            <input
              type="range"
              min={1}
              max={totalPages}
              value={currentPage}
              onChange={(e) => handleJumpToPage(Number(e.target.value))}
              className="reader-scrubber-slider"
              style={{
                flex: 1,
                accentColor: 'var(--accent-color)',
                cursor: 'pointer',
                borderRadius: '4px'
              }}
              aria-label="Comic page scrubber"
            />

            <button
              className="scrubber-edge-btn"
              onClick={() => handleJumpToPage(totalPages)}
              title="Last Page"
              disabled={currentPage >= totalPages && (readingMode === 'single' && splitSpreads && widePages[currentPage]?.isWide ? subPage === 1 : true)}
              style={{
                background: 'none',
                border: 'none',
                color: currentPage >= totalPages && (readingMode === 'single' && splitSpreads && widePages[currentPage]?.isWide ? subPage === 1 : true) ? '#475569' : '#94a3b8',
                cursor: currentPage >= totalPages && (readingMode === 'single' && splitSpreads && widePages[currentPage]?.isWide ? subPage === 1 : true) ? 'not-allowed' : 'pointer',
                fontSize: '0.85rem',
                padding: '0 4px',
                fontWeight: 700
              }}
            >
              ⇥
            </button>

            <span
              style={{
                color: '#fff',
                fontSize: '0.84rem',
                fontWeight: 700,
                whiteSpace: 'nowrap',
                minWidth: '64px',
                textAlign: 'right',
                fontVariantNumeric: 'tabular-nums'
              }}
            >
              {!loadedPages.has(currentPage) ? <><Loader2 size={14}/>{' '}</> : ''}
              {readingMode === 'single' && splitSpreads && widePages[currentPage]?.isWide
                ? `${currentPage} (${subPage + 1}/2) / ${totalPages}`
                : `${currentPage} / ${totalPages}`}
            </span>
          </div>

          {/* Action Navigation Buttons Row */}
          <div className="reader-actions-row">
            <button
              className="control-btn"
              onClick={() => animatePageTransition('backward')}
              disabled={currentPage <= 1 && (readingMode === 'single' && splitSpreads && widePages[currentPage]?.isWide ? subPage === 0 : true)}
              title={`Previous Page (${readingDirection === 'rtl' ? 'Right Tap' : 'Left Tap'})`}
            >
              &larr; Prev
            </button>

            {/* Split Spread Quick Toggle (Shown whenever current page is a 2-in-1 wide scan) */}
            {readingMode === 'single' && widePages[currentPage]?.isWide && (
              <button
                className="control-btn"
                onClick={() => {
                  updateSplitSpreads(!splitSpreads);
                  setSubPage(0);
                }}
                title={splitSpreads ? 'Show Full 2-Page Spread' : 'Split Spread into Single Pages'}
                style={{
                  background: splitSpreads ? 'rgba(59, 130, 246, 0.25)' : undefined,
                  borderColor: splitSpreads ? '#3b82f6' : undefined,
                  color: splitSpreads ? '#60a5fa' : undefined
                }}
              >
                {splitSpreads ? `◧ Part ${subPage + 1}/2` : '◫ Full Spread'}
              </button>
            )}

            <button
              className="control-btn"
              onClick={() => animatePageTransition('forward')}
              disabled={currentPage >= totalPages && (readingMode === 'single' && splitSpreads && widePages[currentPage]?.isWide ? subPage === 1 : true)}
              title={`Next Page (${readingDirection === 'rtl' ? 'Left Tap' : 'Right Tap'})`}
            >
              Next &rarr;
            </button>
          </div>
        </div>
      </div>

    </div>
  );
}
