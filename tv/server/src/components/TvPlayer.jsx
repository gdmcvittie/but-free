import React, { useRef, useState, useEffect } from 'react';
import { RefreshCw, AlertCircle, Maximize, Minimize, Radio, X } from 'lucide-react';

import { getOfflineVideoUrl } from '../utils/offlineStorage.js';

export default function TvPlayer({ currentVideo, offset = 0, onStop, onTimeUpdate, onEnded }) {
  const containerRef = useRef(null);
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const [isBuffering, setIsBuffering] = useState(true);
  const [videoError, setVideoError] = useState(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [offlineSrc, setOfflineSrc] = useState(currentVideo?.offlineUrl || null);

  useEffect(() => {
    let active = true;
    const vidId = currentVideo?.id || currentVideo?.driveId;
    if (vidId) {
      getOfflineVideoUrl(vidId).then(url => {
        if (active && url) setOfflineSrc(url);
      }).catch(() => {});
    }
    return () => { active = false; };
  }, [currentVideo]);

  // Fullscreen state listener
  useEffect(() => {
    const handleFsChange = () => {
      const isFs = !!(
        document.fullscreenElement ||
        document.webkitFullscreenElement ||
        document.mozFullScreenElement ||
        document.msFullscreenElement
      );
      setIsFullscreen(isFs);
    };

    document.addEventListener('fullscreenchange', handleFsChange);
    document.addEventListener('webkitfullscreenchange', handleFsChange);
    document.addEventListener('mozfullscreenchange', handleFsChange);
    document.addEventListener('MSFullscreenChange', handleFsChange);

    return () => {
      document.removeEventListener('fullscreenchange', handleFsChange);
      document.removeEventListener('webkitfullscreenchange', handleFsChange);
      document.removeEventListener('mozfullscreenchange', handleFsChange);
      document.removeEventListener('MSFullscreenChange', handleFsChange);
    };
  }, []);

  const toggleFullscreen = () => {
    const el = containerRef.current || videoRef.current;
    if (!el) return;

    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
      if (el.requestFullscreen) {
        el.requestFullscreen().catch(() => {});
      } else if (el.webkitRequestFullscreen) {
        el.webkitRequestFullscreen();
      } else if (videoRef.current && videoRef.current.webkitEnterFullscreen) {
        // iOS Safari support
        videoRef.current.webkitEnterFullscreen();
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      } else if (document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
      }
    }
  };

  // Keyboard shortcut 'F' for fullscreen, 'Escape' to stop
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        toggleFullscreen();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Compute stream URL (prefers offline cached blob if saved)
  let videoSrc = offlineSrc || '';
  if (!videoSrc && currentVideo) {
    if (currentVideo.driveId) {
      videoSrc = `/api/stream/drive/${currentVideo.driveId}`;
    } else if (currentVideo.path && currentVideo.path.startsWith('drive://')) {
      const fileId = currentVideo.path.replace('drive://', '');
      videoSrc = `/api/stream/drive/${fileId}`;
    } else if (currentVideo.streamUrl) {
      videoSrc = currentVideo.streamUrl;
    } else if (currentVideo.path) {
      videoSrc = currentVideo.path.startsWith('http') || currentVideo.path.startsWith('/api/')
        ? currentVideo.path
        : `/api/stream?path=${encodeURIComponent(currentVideo.path || '')}`;
    }
  }

  const isHls = !!(
    videoSrc &&
    (videoSrc.includes('.m3u8') ||
     videoSrc.includes('/api/freetv/stream') ||
     currentVideo?.isLive ||
     currentVideo?.isFreeTv)
  );

  // Load HLS library if needed and attach to video element
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !videoSrc) return;

    setIsBuffering(true);
    setVideoError(null);

    // Clean up previous HLS instance
    if (hlsRef.current) {
      try {
        hlsRef.current.destroy();
      } catch (_) {}
      hlsRef.current = null;
    }

    if (isHls) {
      const initHls = (HlsClass) => {
        if (HlsClass && HlsClass.isSupported()) {
          const hls = new HlsClass({
            enableWorker: true,
            lowLatencyMode: false,
            liveSyncDurationCount: 3,
            liveMaxLatencyDurationCount: 6,
            backBufferLength: 30,
            maxBufferLength: 30,
            manifestLoadingTimeOut: 15000,
            manifestLoadingMaxRetry: 4,
            levelLoadingTimeOut: 15000,
            levelLoadingMaxRetry: 4,
            fragLoadingTimeOut: 20000,
            fragLoadingMaxRetry: 5
          });
          hlsRef.current = hls;

          hls.loadSource(videoSrc);
          hls.attachMedia(video);

          hls.on(HlsClass.Events.MANIFEST_PARSED, () => {
            const playPromise = video.play();
            if (playPromise !== undefined) {
              playPromise.catch(() => {
                video.muted = true;
                video.play().catch(() => {});
              });
            }
          });

          hls.on(HlsClass.Events.ERROR, (_, data) => {
            if (data.fatal) {
              switch (data.type) {
                case HlsClass.ErrorTypes.NETWORK_ERROR:
                  hls.startLoad();
                  break;
                case HlsClass.ErrorTypes.MEDIA_ERROR:
                  hls.recoverMediaError();
                  break;
                default:
                  hls.destroy();
                  setVideoError('Unable to connect to live stream feed.');
                  break;
              }
            }
          });
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          // Native Safari HLS
          video.src = videoSrc;
          video.play().catch(() => {
            video.muted = true;
            video.play().catch(() => {});
          });
        } else {
          setVideoError('HLS live streaming is not supported by your browser.');
        }
      };

      if (window.Hls) {
        initHls(window.Hls);
      } else {
        // Dynamically load Hls.js from CDN
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js';
        script.async = true;
        script.onload = () => {
          if (window.Hls) initHls(window.Hls);
        };
        script.onerror = () => {
          if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = videoSrc;
            video.play().catch(() => {});
          } else {
            setVideoError('Could not load HLS player engine.');
          }
        };
        document.head.appendChild(script);
      }
    } else {
      // Standard video
      video.src = videoSrc;
      if (offset > 0) {
        video.currentTime = offset;
      }
      video.play().catch(() => {});
    }

    const handleUpdate = () => {
      if (onTimeUpdate && video) {
        onTimeUpdate(video.currentTime, video.duration);
      }
    };

    const handleEnded = () => {
      if (onEnded) onEnded();
    };

    const handleWaiting = () => setIsBuffering(true);
    const handlePlaying = () => {
      setIsBuffering(false);
      setVideoError(null);
    };
    const handleCanPlay = () => setIsBuffering(false);
    const handleError = () => {
      setIsBuffering(false);
      const err = video.error;
      if (err) {
        console.warn('[TvPlayer] Video error:', err.code, err.message);
        if (err.code === 4) {
          setVideoError('Media source stream connection lost or format unsupported.');
        } else {
          setVideoError('Error connecting to video stream.');
        }
      }
    };

    video.addEventListener('timeupdate', handleUpdate);
    video.addEventListener('ended', handleEnded);
    video.addEventListener('waiting', handleWaiting);
    video.addEventListener('playing', handlePlaying);
    video.addEventListener('canplay', handleCanPlay);
    video.addEventListener('error', handleError);

    return () => {
      video.removeEventListener('timeupdate', handleUpdate);
      video.removeEventListener('ended', handleEnded);
      video.removeEventListener('waiting', handleWaiting);
      video.removeEventListener('playing', handlePlaying);
      video.removeEventListener('canplay', handleCanPlay);
      video.removeEventListener('error', handleError);
      if (hlsRef.current) {
        try {
          hlsRef.current.destroy();
        } catch (_) {}
        hlsRef.current = null;
      }
    };
  }, [videoSrc, isHls]);

  if (!currentVideo) return null;

  const isLive = !!(currentVideo.isLive || currentVideo.isFreeTv);

  return (
    <div
      ref={containerRef}
      onDoubleClick={toggleFullscreen}
      style={{
        position: 'relative',
        width: '100%',
        aspectRatio: isFullscreen ? 'unset' : '16/9',
        height: isFullscreen ? '100vh' : 'auto',
        maxHeight: isFullscreen ? '100vh' : '48vh',
        background: '#000',
        borderRadius: isFullscreen ? 0 : '12px',
        overflow: 'hidden',
        boxShadow: isFullscreen ? 'none' : '0 8px 24px rgba(0,0,0,0.8)'
      }}
    >
      <video
        ref={videoRef}
        controls
        autoPlay
        playsInline
        style={{ width: '100%', height: '100%', objectFit: 'contain' }}
      />

      {/* Floating Header Info on Hover / Live Stream Indicator */}
      {isLive && (
        <div
          style={{
            position: 'absolute',
            top: '12px',
            left: '12px',
            zIndex: 10,
            background: 'rgba(0, 0, 0, 0.75)',
            backdropFilter: 'blur(8px)',
            border: '1px solid rgba(255, 255, 255, 0.15)',
            padding: '5px 12px',
            borderRadius: '20px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            color: '#fff',
            fontSize: '12px',
            fontWeight: 700
          }}
        >
          <span className="live-dot-pulse" style={{ width: '8px', height: '8px' }} />
          <span>LIVE BROADCAST · {currentVideo.provider || currentVideo.title}</span>
        </div>
      )}

      {/* Close/Stop Button */}
      {onStop && (
        <button
          onClick={onStop}
          title="Stop Playback"
          style={{
            position: 'absolute',
            top: '12px',
            right: '54px',
            zIndex: 10,
            background: 'rgba(0, 0, 0, 0.6)',
            backdropFilter: 'blur(8px)',
            border: '1px solid rgba(255, 255, 255, 0.2)',
            color: '#fff',
            width: '36px',
            height: '36px',
            borderRadius: '8px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            transition: 'all 0.2s ease'
          }}
        >
          <X size={18} />
        </button>
      )}

      {/* Floating Fullscreen Action Button */}
      <button
        onClick={toggleFullscreen}
        title={isFullscreen ? 'Exit Fullscreen (F)' : 'Fullscreen (F)'}
        style={{
          position: 'absolute',
          top: '12px',
          right: '12px',
          zIndex: 10,
          background: 'rgba(0, 0, 0, 0.6)',
          backdropFilter: 'blur(8px)',
          border: '1px solid rgba(255, 255, 255, 0.2)',
          color: '#fff',
          width: '36px',
          height: '36px',
          borderRadius: '8px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          transition: 'all 0.2s ease'
        }}
      >
        {isFullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
      </button>

      {/* Buffering Indicator */}
      {isBuffering && !videoError && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0, 0, 0, 0.45)',
            backdropFilter: 'blur(2px)',
            gap: '10px'
          }}
        >
          <RefreshCw size={36} className="spin" style={{ color: 'var(--primary)' }} />
          <div style={{ color: '#fff', fontSize: '13px', fontWeight: 600, textShadow: '0 2px 4px rgba(0,0,0,0.8)' }}>
            {isLive ? 'Connecting to live broadcast...' : 'Buffering stream...'}
          </div>
        </div>
      )}

      {/* Error Overlay */}
      {videoError && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(15, 15, 20, 0.95)',
            gap: '12px',
            padding: '24px',
            textAlign: 'center'
          }}
        >
          <AlertCircle size={40} style={{ color: 'var(--accent)' }} />
          <div style={{ color: '#fff', fontSize: '14px', fontWeight: 600 }}>{videoError}</div>
          <button
            className="action-btn"
            onClick={() => {
              if (videoRef.current) {
                videoRef.current.load();
                videoRef.current.play().catch(() => {});
              }
            }}
          >
            Retry Stream
          </button>
        </div>
      )}
    </div>
  );
}
