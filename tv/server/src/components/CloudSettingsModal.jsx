import React, { useState, useRef, useEffect } from 'react';
import { X, HardDrive, RefreshCw, Check, AlertCircle, Film, Tv, User, LogOut, ShieldCheck, PlayCircle, Settings, Download, Clock, Server, Power, Rss, Plus, Trash2, Sparkles, Eye, Radio, Smartphone } from 'lucide-react';
import GoogleDrivePickerModal from './GoogleDrivePickerModal.jsx';
import { useToast } from './Toast.jsx';
import { logoutUser, loginWithGoogle } from '../utils/auth.js';

function formatUptime(seconds) {
  if (!seconds || seconds <= 0) return 'Just started';
  const d = Math.floor(seconds / (3600 * 24));
  const h = Math.floor((seconds % (3600 * 24)) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (parts.length === 0) parts.push(`${s}s`);
  return parts.join(' ');
}

export default function CloudSettingsModal({ isOpen, onClose, user, folders, onUpdateFolders, onScanComplete }) {
  const toast = useToast();
  const isAdmin = (user?.email || '').trim().toLowerCase() === 'gdmcvittie@gmail.com' || Boolean(user?.isAdmin);
  const [activeTab, setActiveTab] = useState('drive');
  const [pickerType, setPickerType] = useState(null); // 'tv' | 'movies' | null

  useEffect(() => {
    if (!isAdmin && (activeTab === 'rss' || activeTab === 'server')) {
      setActiveTab('drive');
    }
  }, [isAdmin, activeTab]);
  const [isScanning, setIsScanning] = useState(false);
  const [scanResult, setScanResult] = useState(null);
  const [scanProgress, setScanProgress] = useState(null);
  const [scanMeta, setScanMeta] = useState({ lastScannedAt: null, nextAutoScanAt: null });
  const scanPollRef = useRef(null);

  // Server management state
  const [serverStatus, setServerStatus] = useState(null);
  const [isLoadingStatus, setIsLoadingStatus] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const restartPollRef = useRef(null);

  // Torrent streamer remote node state
  const [torrentNodeStatus, setTorrentNodeStatus] = useState(null);
  const [isLoadingTorrentStatus, setIsLoadingTorrentStatus] = useState(false);
  const [isRestartingTorrent, setIsRestartingTorrent] = useState(false);
  const [confirmRestartTorrent, setConfirmRestartTorrent] = useState(false);
  const torrentRestartPollRef = useRef(null);

  // Torrent cache state
  const [torrentCache, setTorrentCache] = useState(null);
  const [isClearingCache, setIsClearingCache] = useState(false);

  const fetchTorrentCache = async () => {
    try {
      const res = await fetch('/api/torrent/cache/size');
      if (res.ok) {
        const data = await res.json();
        setTorrentCache(data);
      }
    } catch (_) {}
  };

  const handleClearCache = async (force = false) => {
    setIsClearingCache(true);
    try {
      const res = await fetch('/api/torrent/cache/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        toast.success(`Cache cleared! Freed ${data.freedMB || 0} MB (${data.freedGB || 0} GB)`);
        fetchTorrentCache();
      } else {
        toast.error(data.error || 'Failed to clear cache');
      }
    } catch (err) {
      toast.error('Network error clearing cache: ' + err.message);
    } finally {
      setIsClearingCache(false);
    }
  };

  // Transcoding settings state
  const [transcodeSettings, setTranscodeSettings] = useState({
    enabled: true,
    targetHeight: '480',
    codec: 'h265',
    preset: 'veryfast',
    crf: '20',
    audioCodec: 'aac',
    audioBitrate: '128k'
  });
  const [isSavingTranscode, setIsSavingTranscode] = useState(false);

  const fetchTranscodeSettings = async () => {
    try {
      const res = await fetch('/api/settings/transcode');
      if (res.ok) {
        const data = await res.json();
        if (data.settings) setTranscodeSettings(data.settings);
      }
    } catch (_) {}
  };

  const handleSaveTranscodeSettings = async () => {
    setIsSavingTranscode(true);
    try {
      const res = await fetch('/api/settings/transcode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(transcodeSettings)
      });
      const data = await res.json();
      if (res.ok && data.success) {
        toast.success('Transcoding settings saved successfully');
      } else {
        toast.error('Failed to save transcoding settings');
      }
    } catch (err) {
      toast.error('Network error saving settings: ' + err.message);
    } finally {
      setIsSavingTranscode(false);
    }
  };

  // RSS settings state
  const [rssFeeds, setRssFeeds] = useState([]);
  const [newFeedUrl, setNewFeedUrl] = useState('');
  const [newFeedName, setNewFeedName] = useState('');
  const [newFeedType, setNewFeedType] = useState('tv');
  const [isSavingRss, setIsSavingRss] = useState(false);
  const [wishlistInterval, setWishlistInterval] = useState(30);
  const [wishlistEnabled, setWishlistEnabled] = useState(true);
  const [isSavingWishlistSettings, setIsSavingWishlistSettings] = useState(false);

  const fetchRssSettings = async () => {
    try {
      const res = await fetch('/api/settings/rss');
      if (res.ok) {
        const data = await res.json();
        if (data.feeds) setRssFeeds(data.feeds);
        if (data.intervalMinutes) setWishlistInterval(data.intervalMinutes);
        if (data.wishlistEnabled !== undefined) setWishlistEnabled(data.wishlistEnabled);
      }
    } catch (_) {}
  };

  const handleSaveWishlistConfig = async (newInterval, newEnabled) => {
    setIsSavingWishlistSettings(true);
    try {
      const res = await fetch('/api/settings/rss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intervalMinutes: newInterval !== undefined ? newInterval : wishlistInterval,
          wishlistEnabled: newEnabled !== undefined ? newEnabled : wishlistEnabled
        })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.intervalMinutes) setWishlistInterval(data.intervalMinutes);
        if (data.wishlistEnabled !== undefined) setWishlistEnabled(data.wishlistEnabled);
        toast.success('Wish List monitoring settings updated');
      } else {
        toast.error('Failed to update Wish List settings');
      }
    } catch (err) {
      toast.error('Network error saving Wish List settings: ' + err.message);
    } finally {
      setIsSavingWishlistSettings(false);
    }
  };

  const handleSaveRssFeeds = async (updatedFeeds) => {
    setIsSavingRss(true);
    try {
      const res = await fetch('/api/settings/rss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feeds: updatedFeeds })
      });
      if (res.ok) {
        setRssFeeds(updatedFeeds);
        toast.success('RSS feeds updated successfully');
      } else {
        toast.error('Failed to update RSS feeds');
      }
    } catch (err) {
      toast.error('Error saving RSS feeds: ' + err.message);
    } finally {
      setIsSavingRss(false);
    }
  };

  const handleAddRssFeed = (e) => {
    if (e) e.preventDefault();
    const url = newFeedUrl.trim();
    if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
      toast.error('Please enter a valid HTTP/HTTPS RSS feed URL');
      return;
    }
    const name = newFeedName.trim() || new URL(url).hostname;
    const newFeed = {
      id: 'feed_' + Date.now().toString(36),
      url,
      name,
      defaultType: newFeedType,
      enabled: true
    };
    const updated = [...rssFeeds, newFeed];
    handleSaveRssFeeds(updated);
    setNewFeedUrl('');
    setNewFeedName('');
  };

  const handleRemoveRssFeed = (id) => {
    const updated = rssFeeds.filter(f => (f.id || f.url) !== id);
    handleSaveRssFeeds(updated);
  };

  const handleToggleRssFeed = (id) => {
    const updated = rssFeeds.map(f => {
      if ((f.id || f.url) === id) {
        return { ...f, enabled: f.enabled === false ? true : false };
      }
      return f;
    });
    handleSaveRssFeeds(updated);
  };

  useEffect(() => {
    if (isOpen) {
      fetchTranscodeSettings();
      if (isAdmin) {
        fetchRssSettings();
      }
    }
  }, [isOpen, isAdmin]);

  const fetchServerStatus = async () => {
    setIsLoadingStatus(true);
    try {
      const res = await fetch('/api/server/status');
      const data = await res.json();
      if (data?.success) {
        setServerStatus(data);
      }
    } catch (_) {}
    finally {
      setIsLoadingStatus(false);
    }
  };

  const fetchTorrentNodeStatus = async () => {
    setIsLoadingTorrentStatus(true);
    try {
      const res = await fetch('/api/torrent/status', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setTorrentNodeStatus(data);
      }
    } catch (_) {}
    finally {
      setIsLoadingTorrentStatus(false);
    }
  };

  const handleRestartTorrentServer = async () => {
    setConfirmRestartTorrent(false);
    setIsRestartingTorrent(true);
    try {
      const res = await fetch('/api/torrent/restart', { method: 'POST' });
      const data = await res.json();
      if (data?.success) {
        toast.info('Restart signal sent to torrent streamer node. Waiting for it to reboot...');
      } else {
        toast.error(data?.error || 'Failed to send restart signal to torrent streamer node');
      }
    } catch (_) {
      toast.info('Restart signal delivered. Waiting for torrent streamer node to come back online...');
    }

    let attempts = 0;
    const maxAttempts = 20;
    if (torrentRestartPollRef.current) clearInterval(torrentRestartPollRef.current);
    torrentRestartPollRef.current = setInterval(async () => {
      attempts++;
      try {
        const check = await fetch('/api/torrent/status', { cache: 'no-store' });
        if (check.ok) {
          const statusData = await check.json();
          if (statusData?.status === 'online') {
            clearInterval(torrentRestartPollRef.current);
            torrentRestartPollRef.current = null;
            setIsRestartingTorrent(false);
            setTorrentNodeStatus(statusData);
            fetchTorrentCache();
            toast.success('Remote torrent streamer is back online!');
          }
        }
      } catch (_) {}

      if (attempts >= maxAttempts) {
        clearInterval(torrentRestartPollRef.current);
        torrentRestartPollRef.current = null;
        setIsRestartingTorrent(false);
        toast.warning('Torrent server restart took longer than expected. Please check node status.');
        fetchTorrentNodeStatus();
      }
    }, 2000);
  };

  useEffect(() => {
    if (isAdmin && activeTab === 'server' && isOpen) {
      fetchServerStatus();
      fetchTorrentCache();
      fetchTorrentNodeStatus();
    }
  }, [activeTab, isOpen, isAdmin]);

  const handleRestartServer = async () => {
    setConfirmRestart(false);
    setIsRestarting(true);
    try {
      const res = await fetch('/api/server/restart', { method: 'POST' });
      const data = await res.json();
      if (data?.success) {
        toast.info('Restart signal sent. Waiting for server to come back up...');
      }
    } catch (_) {
      // Immediate network disconnect during process exit is normal
    }

    let attempts = 0;
    const maxAttempts = 20;
    if (restartPollRef.current) clearInterval(restartPollRef.current);
    restartPollRef.current = setInterval(async () => {
      attempts++;
      try {
        const check = await fetch('/api/server/status', { cache: 'no-store' });
        if (check.ok) {
          const statusData = await check.json();
          if (statusData?.success) {
            clearInterval(restartPollRef.current);
            restartPollRef.current = null;
            setIsRestarting(false);
            setServerStatus(statusData);
            toast.success('Server restarted and back online!');
          }
        }
      } catch (_) {
        // Server still restarting
      }

      if (attempts >= maxAttempts) {
        clearInterval(restartPollRef.current);
        restartPollRef.current = null;
        setIsRestarting(false);
        toast.warning('Server restart took longer than expected. Please refresh the page in a moment.');
      }
    }, 1500);
  };

  useEffect(() => {
    // Check initial scan progress and auto-scan schedule
    fetch('/api/drive/scan/progress')
      .then(r => r.json())
      .then(data => {
        if (data?.progress) setScanProgress(data.progress);
        if (data?.lastScannedAt || data?.nextAutoScanAt) {
          setScanMeta({ lastScannedAt: data.lastScannedAt, nextAutoScanAt: data.nextAutoScanAt });
        }
      })
      .catch(() => {});

    return () => {
      if (scanPollRef.current) clearInterval(scanPollRef.current);
      if (restartPollRef.current) clearInterval(restartPollRef.current);
      if (torrentRestartPollRef.current) clearInterval(torrentRestartPollRef.current);
    };
  }, []);

  if (!isOpen) return null;

  const handleOpenPicker = (type) => {
    setPickerType(type);
  };

  const handleSavePickerFolder = async (folder) => {
    const payload = {};
    const folderObj = {
      id: folder.id,
      name: folder.name,
      canAddChildren: folder.canAddChildren !== false,
      ownedByMe: folder.ownedByMe !== false
    };
    if (pickerType === 'tv') {
      payload.tvFolder = folderObj;
    } else {
      payload.moviesFolder = folderObj;
    }

    try {
      const res = await fetch('/api/drive/set-folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.success && onUpdateFolders) {
        onUpdateFolders(data.folders);
        toast.success(`Updated ${pickerType === 'tv' ? 'TV Shows' : 'Movies'} folder to "${folder.name}".`);
      }
    } catch (err) {
      toast.error('Failed to update Google Drive folder setting.');
    }
  };

  const handleScanDrive = async () => {
    setIsScanning(true);
    setScanResult(null);
    setScanProgress({ stage: 'starting', scanning: true, message: 'Starting scan...' });
    // Begin polling progress
    if (scanPollRef.current) clearInterval(scanPollRef.current);
    scanPollRef.current = setInterval(async () => {
      try {
        const resp = await fetch('/api/drive/scan/progress');
        const data = await resp.json();
        if (data?.progress) setScanProgress(data.progress);
        if (data?.lastScannedAt || data?.nextAutoScanAt) {
          setScanMeta({ lastScannedAt: data.lastScannedAt, nextAutoScanAt: data.nextAutoScanAt });
        }
      } catch (_) {}
    }, 800);

    try {
      const res = await fetch('/api/drive/scan', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setScanResult(data.library?.counts || null);
        toast.success(`Google Drive library scan completed! Found ${data.library?.counts?.tvEpisodes || 0} episodes and ${data.library?.counts?.movies || 0} movies.`);
        if (onScanComplete) onScanComplete(data.library);
      } else {
        setScanProgress({ stage: 'error', scanning: false, message: data.error || 'Scan failed.' });
        toast.error(data.error || 'Scan failed.');
      }
    } catch (err) {
      setScanProgress({ stage: 'error', scanning: false, message: 'Error scanning Google Drive library.' });
      toast.error('Error scanning Google Drive library.');
    } finally {
      if (scanPollRef.current) clearInterval(scanPollRef.current);
      scanPollRef.current = null;
      setIsScanning(false);
    }
  };

  const scanPercent = (() => {
    if (!scanProgress) return 0;
    if (scanProgress.stage === 'posters') {
      const total = scanProgress.totalShows + scanProgress.totalMovies;
      const done = scanProgress.showsProcessed + scanProgress.moviesProcessed;
      if (total > 0) return Math.round((done / total) * 100);
      return 5;
    }
    if (scanProgress.stage === 'walking' || scanProgress.stage === 'parse') return 10;
    if (scanProgress.stage === 'complete') return 100;
    if (scanProgress.stage === 'error') return 0;
    return 0;
  })();

  return (
    <div
      className="settings-modal-wrapper"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.85)',
        backdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9990,
        padding: '16px'
      }}
      onClick={onClose}
    >
      <div
        className="glass-panel settings-modal-panel"
        style={{
          width: '100%',
          maxWidth: '720px',
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
        <div className="settings-modal-header" style={{ padding: '16px 24px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(255,255,255,0.02)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{ background: 'rgba(139, 92, 246, 0.15)', padding: '8px', borderRadius: '8px', color: 'var(--primary)' }}>
              <Settings size={20} />
            </div>
            <div>
              <h2 style={{ fontSize: '18px', fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>Cloud Settings</h2>
              <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)' }}>
                Google Drive media configuration and account management
              </div>
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '6px' }}>
            <X size={20} />
          </button>
        </div>

        {/* Tabs */}
        <div className="settings-tabs-container">
          {[
            { id: 'drive', label: 'Drive', icon: <HardDrive size={14} /> },
            { id: 'transcode', label: 'Transcoder', icon: <Film size={14} /> },
            ...(isAdmin ? [
              { id: 'rss', label: 'RSS', icon: <Rss size={14} /> },
              { id: 'server', label: 'Server', icon: <Server size={14} /> }
            ] : []),
            { id: 'account', label: 'Account', icon: <User size={14} /> },
            { id: 'downloads', label: 'Apps', icon: <Download size={14} /> }
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`settings-tab-btn ${activeTab === tab.id ? 'active' : ''}`}
            >
              {tab.icon}
              <span>{tab.label}</span>
            </button>
          ))}
        </div>

        {/* Tab Body */}
        <div className="settings-tab-body" style={{ padding: '24px', flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {activeTab === 'drive' && (
            <>
              {/* Google Account Summary Card */}
              <div className="glass-panel" style={{ padding: '16px', borderRadius: '12px', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                  {user?.picture ? (
                    <img src={user.picture} alt={user.name} style={{ width: '44px', height: '44px', borderRadius: '50%', border: '2px solid var(--primary)' }} />
                  ) : (
                    <div style={{ width: '44px', height: '44px', borderRadius: '50%', background: 'rgba(139,92,246,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--primary)' }}>
                      <User size={22} />
                    </div>
                  )}
                  <div>
                    <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>{user?.name || 'Google User'}</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{user?.email || 'Connected'}</div>
                  </div>
                </div>
                <button
                  className="action-btn"
                  onClick={loginWithGoogle}
                  style={{ padding: '6px 12px', fontSize: '12px' }}
                >
                  Reconnect Drive
                </button>
              </div>

              {/* Folders Selection Card */}
              <div className="glass-panel" style={{ padding: '18px', borderRadius: '12px', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>Media Folders in Google Drive</div>

                {/* TV Shows Folder */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px', borderRadius: '8px', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-color)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <div style={{ background: 'rgba(139, 92, 246, 0.15)', padding: '8px', borderRadius: '6px', color: 'var(--primary)' }}>
                      <Tv size={18} />
                    </div>
                    <div>
                      <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>TV Shows Folder</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', marginTop: '2px' }}>
                        <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                          {folders?.tv?.name ? `📁 ${folders.tv.name}` : 'Not set (browse and select folder)'}
                        </span>
                        {folders?.tv?.canAddChildren === false && (
                          <span style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '3px',
                            fontSize: '10px',
                            padding: '1px 6px',
                            borderRadius: '4px',
                            background: 'rgba(245, 158, 11, 0.15)',
                            color: '#fbbf24',
                            border: '1px solid rgba(245, 158, 11, 0.3)',
                            fontWeight: 600
                          }}>
                            <Eye size={10} />
                            View-Only (Downloads Disabled)
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <button className="action-btn primary" onClick={() => handleOpenPicker('tv')} style={{ padding: '6px 14px', fontSize: '12px' }}>
                    {folders?.tv ? 'Change' : 'Select Folder'}
                  </button>
                </div>

                {/* Movies Folder */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px', borderRadius: '8px', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-color)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <div style={{ background: 'rgba(34, 211, 238, 0.15)', padding: '8px', borderRadius: '6px', color: '#22d3ee' }}>
                      <Film size={18} />
                    </div>
                    <div>
                      <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>Movies Folder</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', marginTop: '2px' }}>
                        <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                          {folders?.movies?.name ? `📁 ${folders.movies.name}` : 'Not set (browse and select folder)'}
                        </span>
                        {folders?.movies?.canAddChildren === false && (
                          <span style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '3px',
                            fontSize: '10px',
                            padding: '1px 6px',
                            borderRadius: '4px',
                            background: 'rgba(245, 158, 11, 0.15)',
                            color: '#fbbf24',
                            border: '1px solid rgba(245, 158, 11, 0.3)',
                            fontWeight: 600
                          }}>
                            <Eye size={10} />
                            View-Only (Downloads Disabled)
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <button className="action-btn primary" onClick={() => handleOpenPicker('movies')} style={{ padding: '6px 14px', fontSize: '12px' }}>
                    {folders?.movies ? 'Change' : 'Select Folder'}
                  </button>
                </div>

                {/* Auto-Scan Status & Info */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 14px', borderRadius: '8px', background: 'rgba(139, 92, 246, 0.08)', border: '1px solid rgba(139, 92, 246, 0.2)', fontSize: '12px', color: 'var(--text-secondary)' }}>
                  <Clock size={16} style={{ color: 'var(--primary)', flexShrink: 0 }} />
                  <div>
                    <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>Automatic 4-Hour Scanning Active:</span> Your Google Drive folders are automatically scanned every 4 hours so newly uploaded media appears on your Roku and Web apps without manual effort.
                    {scanMeta.lastScannedAt && (
                      <span style={{ display: 'block', marginTop: '2px', fontSize: '11px', color: 'var(--text-secondary)' }}>
                        Last scanned: {new Date(scanMeta.lastScannedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    )}
                  </div>
                </div>

                {/* Scan Button & Results */}
                <div style={{ marginTop: '8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: '1px solid var(--border-color)', paddingTop: '14px' }}>
                  <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                    Add new media to Drive anytime, or scan immediately now.
                  </div>
                  <button
                    className="action-btn primary"
                    onClick={handleScanDrive}
                    disabled={isScanning || scanProgress?.scanning || (!folders?.tv && !folders?.movies)}
                    style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 16px', fontSize: '12.5px' }}
                  >
                    <RefreshCw size={13} className={isScanning || scanProgress?.scanning ? 'spin' : ''} />
                    {isScanning || scanProgress?.scanning ? 'Scanning Drive...' : 'Scan Google Drive Now'}
                  </button>
                </div>

                {scanProgress && scanProgress.scanning && (
                  <div style={{ marginTop: '12px', padding: '12px 14px', borderRadius: '8px', background: 'rgba(139,92,246,0.08)', border: '1px solid var(--border-color)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                      <div style={{ fontSize: '12px', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <RefreshCw size={12} className="spin" style={{ color: 'var(--primary)' }} />
                        <span>{scanProgress.message || 'Scanning Google Drive...'}</span>
                      </div>
                      <span style={{ fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 700 }}>{scanPercent}%</span>
                    </div>
                    <div style={{ width: '100%', height: '8px', borderRadius: '999px', background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                      <div style={{ width: `${scanPercent}%`, height: '100%', borderRadius: '999px', background: 'linear-gradient(90deg, #a78bfa, #22d3ee)', transition: 'width 0.4s ease' }} />
                    </div>
                  </div>
                )}

                {scanProgress && scanProgress.stage === 'error' && (
                  <div style={{ marginTop: '12px', padding: '10px 14px', borderRadius: '8px', background: 'rgba(244, 63, 94, 0.12)', border: '1px solid rgba(244, 63, 94, 0.3)', color: '#fca5a5', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <AlertCircle size={14} />
                    <span>{scanProgress.message || 'Scan failed.'}</span>
                  </div>
                )}

                {scanResult && (
                  <div style={{ padding: '10px 14px', borderRadius: '8px', background: 'rgba(16, 185, 129, 0.15)', border: '1px solid rgba(16, 185, 129, 0.3)', color: '#6ee7b7', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <Check size={14} />
                    <span>Indexed {scanResult.shows || 0} shows ({scanResult.tvEpisodes || 0} episodes) and {scanResult.movies || 0} movies.</span>
                  </div>
                )}
              </div>

              {/* Cloud Guardrails Notice */}
              <div style={{ padding: '12px 16px', borderRadius: '10px', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)', fontSize: '11.5px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '10px' }}>
                <ShieldCheck size={16} style={{ color: 'var(--primary)', flexShrink: 0 }} />
                <span>Cloud VPS Resource Optimization: Video streams are proxied with direct byte ranges with 1 concurrent download stream limit.</span>
              </div>
            </>
          )}

          {activeTab === 'transcode' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div className="glass-panel" style={{ padding: '20px', borderRadius: '12px', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <div style={{ background: 'rgba(139, 92, 246, 0.15)', padding: '8px', borderRadius: '8px', color: 'var(--primary)' }}>
                      <Film size={18} />
                    </div>
                    <div>
                      <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>Cloud Transcoder Settings</div>
                      <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)' }}>FFmpeg transcoding preferences for downloads on download.butfree.online.</div>
                    </div>
                  </div>
                  <button
                    className="action-btn primary"
                    onClick={handleSaveTranscodeSettings}
                    disabled={isSavingTranscode}
                    style={{ padding: '7px 16px', fontSize: '12.5px', display: 'flex', alignItems: 'center', gap: '6px' }}
                  >
                    {isSavingTranscode ? <RefreshCw size={13} className="spin" /> : <Check size={13} />}
                    {isSavingTranscode ? 'Saving...' : 'Save Settings'}
                  </button>
                </div>

                <div style={{ padding: '12px 14px', borderRadius: '8px', background: 'rgba(59, 130, 246, 0.08)', border: '1px solid rgba(59, 130, 246, 0.2)', fontSize: '12px', color: '#93c5fd', lineHeight: 1.5 }}>
                  <strong>Smart Skip:</strong> If a downloaded video is already an MP4 file at or below your target resolution, transcoding is automatically skipped so your video uploads to Google Drive immediately!
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <input
                    type="checkbox"
                    id="enableTranscodeToggle"
                    checked={transcodeSettings.enabled !== false}
                    onChange={(e) => setTranscodeSettings(prev => ({ ...prev, enabled: e.target.checked }))}
                    style={{ width: '16px', height: '16px', cursor: 'pointer' }}
                  />
                  <label htmlFor="enableTranscodeToggle" style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', cursor: 'pointer' }}>
                    Enable automatic transcoding before uploading to Google Drive
                  </label>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px', opacity: transcodeSettings.enabled !== false ? 1 : 0.5, pointerEvents: transcodeSettings.enabled !== false ? 'auto' : 'none' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                      Target Resolution
                    </label>
                    <select
                      className="select"
                      value={transcodeSettings.targetHeight || '480'}
                      onChange={(e) => setTranscodeSettings(prev => ({ ...prev, targetHeight: e.target.value }))}
                      style={{ width: '100%', background: 'rgba(0,0,0,0.4)', border: '1px solid var(--border-color)', borderRadius: '8px', padding: '9px 12px', color: 'var(--text-primary)', fontSize: '12.5px' }}
                    >
                      <option value="480">480p SD (Fastest / Lowest File Size - Recommended)</option>
                      <option value="720">720p HD (Roku/Mobile/FireTV)</option>
                      <option value="1080">1080p Full HD</option>
                      <option value="original">Original (Keep Source Resolution)</option>
                    </select>
                  </div>

                  <div>
                    <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                      Video Codec
                    </label>
                    <select
                      className="select"
                      value={transcodeSettings.codec || 'h265'}
                      onChange={(e) => setTranscodeSettings(prev => ({ ...prev, codec: e.target.value }))}
                      style={{ width: '100%', background: 'rgba(0,0,0,0.4)', border: '1px solid var(--border-color)', borderRadius: '8px', padding: '9px 12px', color: 'var(--text-primary)', fontSize: '12.5px' }}
                    >
                      <option value="h265">H.265 / HEVC (Higher Efficiency - Recommended)</option>
                      <option value="h264">H.264 / AVC (Legacy Compatibility)</option>
                    </select>
                  </div>

                  <div>
                    <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                      FFmpeg Speed Preset
                    </label>
                    <select
                      className="select"
                      value={transcodeSettings.preset || 'veryfast'}
                      onChange={(e) => setTranscodeSettings(prev => ({ ...prev, preset: e.target.value }))}
                      style={{ width: '100%', background: 'rgba(0,0,0,0.4)', border: '1px solid var(--border-color)', borderRadius: '8px', padding: '9px 12px', color: 'var(--text-primary)', fontSize: '12.5px' }}
                    >
                      <option value="ultrafast">ultrafast (Fastest transcode)</option>
                      <option value="superfast">superfast</option>
                      <option value="veryfast">veryfast (Recommended balance)</option>
                      <option value="faster">faster</option>
                      <option value="fast">fast</option>
                      <option value="medium">medium (Best compression, slower)</option>
                    </select>
                  </div>

                  <div>
                    <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                      Quality CRF ({transcodeSettings.crf || '20'})
                    </label>
                    <input
                      type="range"
                      min="16"
                      max="28"
                      step="1"
                      value={transcodeSettings.crf || '20'}
                      onChange={(e) => setTranscodeSettings(prev => ({ ...prev, crf: e.target.value }))}
                      style={{ width: '100%', cursor: 'pointer', accentColor: 'var(--primary)', marginTop: '8px' }}
                    />
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10.5px', color: 'var(--text-muted)', marginTop: '2px' }}>
                      <span>16 (Crisp / Larger)</span>
                      <span>22 (Balanced)</span>
                      <span>28 (Smaller File)</span>
                    </div>
                  </div>

                  <div>
                    <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                      Audio Codec
                    </label>
                    <select
                      className="select"
                      value={transcodeSettings.audioCodec || 'aac'}
                      onChange={(e) => setTranscodeSettings(prev => ({ ...prev, audioCodec: e.target.value }))}
                      style={{ width: '100%', background: 'rgba(0,0,0,0.4)', border: '1px solid var(--border-color)', borderRadius: '8px', padding: '9px 12px', color: 'var(--text-primary)', fontSize: '12.5px' }}
                    >
                      <option value="aac">AAC Stereo (Recommended for TV/Web)</option>
                      <option value="libmp3lame">MP3</option>
                      <option value="copy">Copy (Keep original audio stream)</option>
                    </select>
                  </div>

                  <div>
                    <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                      Audio Bitrate
                    </label>
                    <select
                      className="select"
                      value={transcodeSettings.audioBitrate || '128k'}
                      onChange={(e) => setTranscodeSettings(prev => ({ ...prev, audioBitrate: e.target.value }))}
                      disabled={transcodeSettings.audioCodec === 'copy'}
                      style={{ width: '100%', background: 'rgba(0,0,0,0.4)', border: '1px solid var(--border-color)', borderRadius: '8px', padding: '9px 12px', color: 'var(--text-primary)', fontSize: '12.5px' }}
                    >
                      <option value="96k">96 kbps</option>
                      <option value="128k">128 kbps (Standard)</option>
                      <option value="192k">192 kbps (High Quality)</option>
                      <option value="256k">256 kbps (Maximum)</option>
                    </select>
                  </div>
                </div>
              </div>
            </div>
          )}

          {isAdmin && activeTab === 'rss' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              {/* Wish List Auto-Monitor Settings Card */}
              <div className="glass-panel" style={{ padding: '20px', borderRadius: '12px', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <div style={{ background: 'rgba(139, 92, 246, 0.15)', color: '#c084fc', padding: '8px', borderRadius: '8px' }}>
                      <Sparkles size={20} />
                    </div>
                    <div>
                      <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)' }}>RSS Wish List Auto-Monitor</div>
                      <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                        Automatically checks feeds, downloads matched TV shows and movies, transcodes to MP4, and uploads to Google Drive.
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
                      <input
                        type="checkbox"
                        checked={wishlistEnabled}
                        onChange={(e) => {
                          const val = e.target.checked;
                          setWishlistEnabled(val);
                          handleSaveWishlistConfig(undefined, val);
                        }}
                        style={{ cursor: 'pointer', accentColor: 'var(--primary)', width: '16px', height: '16px' }}
                      />
                      <span>Auto-Check Active</span>
                    </label>
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '14px', alignItems: 'center', background: 'rgba(0,0,0,0.25)', border: '1px solid var(--border-color)', borderRadius: '10px', padding: '14px' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                      Feed Check Frequency
                    </label>
                    <select
                      value={wishlistInterval}
                      onChange={(e) => {
                        const val = parseInt(e.target.value, 10);
                        setWishlistInterval(val);
                        handleSaveWishlistConfig(val, undefined);
                      }}
                      disabled={isSavingWishlistSettings}
                      style={{
                        width: '100%',
                        background: 'rgba(0,0,0,0.4)',
                        border: '1px solid var(--border-color)',
                        borderRadius: '8px',
                        padding: '9px 12px',
                        color: 'var(--text-primary)',
                        fontSize: '12.5px',
                        outline: 'none'
                      }}
                    >
                      <option value="15">Every 15 minutes</option>
                      <option value="30">Every 30 minutes (Default - Recommended)</option>
                      <option value="60">Every 1 hour</option>
                      <option value="120">Every 2 hours</option>
                      <option value="360">Every 6 hours</option>
                      <option value="720">Every 12 hours</option>
                      <option value="1440">Every 24 hours</option>
                    </select>
                  </div>

                  <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                    💡 <strong>Smart Grab:</strong> New episodes are tracked to prevent duplicate downloads. Once queued, videos are automatically converted into direct-streaming MP4s and organized into your configured Drive folders.
                  </div>
                </div>
              </div>

              <div className="glass-panel" style={{ padding: '20px', borderRadius: '12px', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <div style={{ background: 'rgba(245, 158, 11, 0.15)', color: '#fbbf24', padding: '8px', borderRadius: '8px' }}>
                      <Rss size={20} />
                    </div>
                    <div>
                      <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)' }}>Configured RSS Feeds</div>
                      <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Torrents from these feeds appear in the Feeds view and can be queued directly into Drive.</div>
                    </div>
                  </div>
                </div>

                {/* Add Feed Form */}
                <form onSubmit={handleAddRssFeed} style={{ background: 'rgba(0,0,0,0.25)', border: '1px solid var(--border-color)', borderRadius: '10px', padding: '14px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>Add Custom Feed URL</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 100px auto', gap: '10px', alignItems: 'center' }}>
                    <input
                      type="text"
                      placeholder="Feed URL (https://...)"
                      value={newFeedUrl}
                      onChange={(e) => setNewFeedUrl(e.target.value)}
                      style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid var(--border-color)', borderRadius: '8px', padding: '8px 12px', color: 'var(--text-primary)', fontSize: '12.5px', outline: 'none' }}
                    />
                    <input
                      type="text"
                      placeholder="Display Name (optional)"
                      value={newFeedName}
                      onChange={(e) => setNewFeedName(e.target.value)}
                      style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid var(--border-color)', borderRadius: '8px', padding: '8px 12px', color: 'var(--text-primary)', fontSize: '12.5px', outline: 'none' }}
                    />
                    <select
                      value={newFeedType}
                      onChange={(e) => setNewFeedType(e.target.value)}
                      style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid var(--border-color)', borderRadius: '8px', padding: '8px 10px', color: 'var(--text-primary)', fontSize: '12px' }}
                    >
                      <option value="tv">TV Shows</option>
                      <option value="movie">Movies</option>
                    </select>
                    <button
                      type="submit"
                      className="action-btn primary"
                      style={{ display: 'flex', alignItems: 'center', gap: '5px', padding: '8px 16px', fontSize: '12px', borderRadius: '8px' }}
                    >
                      <Plus size={14} /> Add
                    </button>
                  </div>
                </form>

                {/* Feeds List */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {rssFeeds.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '24px', color: 'var(--text-muted)', fontSize: '13px' }}>
                      No RSS feeds configured.
                    </div>
                  ) : (
                    rssFeeds.map(feed => {
                      const id = feed.id || feed.url;
                      const isEnabled = feed.enabled !== false;
                      return (
                        <div
                          key={id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '12px 14px',
                            background: 'rgba(255,255,255,0.02)',
                            border: '1px solid var(--border-color)',
                            borderRadius: '10px',
                            opacity: isEnabled ? 1 : 0.6
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0, flex: 1 }}>
                            <input
                              type="checkbox"
                              checked={isEnabled}
                              onChange={() => handleToggleRssFeed(id)}
                              style={{ cursor: 'pointer', accentColor: 'var(--primary)' }}
                              title={isEnabled ? 'Disable feed' : 'Enable feed'}
                            />
                            <div style={{ minWidth: 0 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <span style={{ fontSize: '13.5px', fontWeight: 600, color: 'var(--text-primary)' }}>{feed.name || 'Custom Feed'}</span>
                                <span style={{ fontSize: '10px', fontWeight: 700, padding: '1px 6px', borderRadius: '4px', background: feed.defaultType === 'tv' ? 'rgba(59, 130, 246, 0.2)' : 'rgba(168, 85, 247, 0.2)', color: feed.defaultType === 'tv' ? '#93c5fd' : '#d8b4fe', textTransform: 'uppercase' }}>
                                  {feed.defaultType === 'tv' ? 'TV' : 'Movie'}
                                </span>
                              </div>
                              <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '2px' }}>
                                {feed.url}
                              </div>
                            </div>
                          </div>

                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <button
                              type="button"
                              className="action-btn"
                              onClick={() => handleRemoveRssFeed(id)}
                              title="Remove feed"
                              style={{ color: 'var(--accent)', padding: '6px 10px', borderRadius: '6px', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px' }}
                            >
                              <Trash2 size={13} />
                              <span>Remove</span>
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          )}

          {isAdmin && activeTab === 'server' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {/* Server Status Header Card */}
              <div className="glass-panel" style={{ padding: '18px', borderRadius: '12px', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <div style={{ background: isRestarting ? 'rgba(234, 179, 8, 0.15)' : 'rgba(16, 185, 129, 0.15)', padding: '10px', borderRadius: '8px', color: isRestarting ? '#facc15' : '#10b981' }}>
                    <Server size={22} className={isRestarting ? 'spin' : ''} />
                  </div>
                  <div>
                    <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span>FREEVEE Server</span>
                      <span style={{ fontSize: '11px', fontWeight: 600, padding: '2px 8px', borderRadius: '999px', background: isRestarting ? 'rgba(234,179,8,0.2)' : 'rgba(16,185,129,0.2)', color: isRestarting ? '#fde047' : '#6ee7b7', border: `1px solid ${isRestarting ? 'rgba(234,179,8,0.4)' : 'rgba(16,185,129,0.4)'}` }}>
                        {isRestarting ? '● Restarting...' : '● Online'}
                      </span>
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                      Process ID: {serverStatus?.pid || '—'} · Platform: {serverStatus?.platform || 'Node.js'} · Runtime: {serverStatus?.nodeVersion || 'v20+'}
                    </div>
                  </div>
                </div>

                <button
                  className="action-btn"
                  onClick={fetchServerStatus}
                  disabled={isLoadingStatus || isRestarting}
                  style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 12px', fontSize: '12px' }}
                >
                  <RefreshCw size={12} className={isLoadingStatus ? 'spin' : ''} />
                  Refresh
                </button>
              </div>

              {/* Server Stats Grid */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '12px' }}>
                <div style={{ padding: '14px', borderRadius: '10px', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase' }}>Uptime</div>
                  <div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)' }}>
                    {serverStatus ? formatUptime(serverStatus.uptime) : '—'}
                  </div>
                </div>

                <div style={{ padding: '14px', borderRadius: '10px', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase' }}>Memory (RSS)</div>
                  <div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)' }}>
                    {serverStatus?.memory?.rssMb ? `${serverStatus.memory.rssMb} MB` : '—'}
                  </div>
                </div>

                <div style={{ padding: '14px', borderRadius: '10px', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase' }}>Heap Used</div>
                  <div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)' }}>
                    {serverStatus?.memory?.heapUsedMb ? `${serverStatus.memory.heapUsedMb} MB` : '—'}
                  </div>
                </div>

                <div style={{ padding: '14px', borderRadius: '10px', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase' }}>Node Runtime</div>
                  <div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)' }}>
                    {serverStatus?.nodeVersion || 'Node.js'}
                  </div>
                </div>
              </div>

              {/* cPanel / Passenger Notice */}
              <div style={{ padding: '12px 16px', borderRadius: '10px', background: 'rgba(139, 92, 246, 0.08)', border: '1px solid rgba(139, 92, 246, 0.2)', fontSize: '12px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
                <ShieldCheck size={16} style={{ color: 'var(--primary)', flexShrink: 0, marginTop: '2px' }} />
                <div>
                  <strong style={{ color: 'var(--text-primary)' }}>cPanel & VPS Recycling:</strong> Restarting signals Phusion Passenger via <code>tmp/restart.txt</code> and recycles the Node process. Updated <code>.env</code> settings and new server code take effect automatically without needing to log in to cPanel.
                </div>
              </div>

              {/* Restart Control Card */}
              <div className="glass-panel" style={{ padding: '20px', borderRadius: '12px', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
                  <div>
                    <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>Restart Server Process</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                      Gracefully reboot the background Node.js server to apply updates or free memory.
                    </div>
                  </div>

                  {!confirmRestart && (
                    <button
                      className="action-btn"
                      onClick={() => setConfirmRestart(true)}
                      disabled={isRestarting}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        padding: '9px 18px',
                        fontSize: '13px',
                        fontWeight: 600,
                        color: '#f87171',
                        borderColor: 'rgba(244, 63, 94, 0.3)',
                        background: 'rgba(244, 63, 94, 0.1)'
                      }}
                    >
                      <Power size={14} />
                      {isRestarting ? 'Restarting...' : 'Restart Server'}
                    </button>
                  )}
                </div>

                {confirmRestart && (
                  <div style={{ padding: '14px', borderRadius: '8px', background: 'rgba(244, 63, 94, 0.12)', border: '1px solid rgba(244, 63, 94, 0.3)', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#fca5a5', fontSize: '13px', fontWeight: 600 }}>
                      <AlertCircle size={16} />
                      Are you sure you want to restart the server now?
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                      Any active streams will briefly pause while the process reboots (typically takes 2–5 seconds).
                    </div>
                    <div style={{ display: 'flex', gap: '10px', marginTop: '4px' }}>
                      <button
                        className="action-btn"
                        onClick={handleRestartServer}
                        style={{ padding: '6px 16px', fontSize: '12.5px', background: '#ef4444', color: '#fff', borderColor: '#ef4444', fontWeight: 600 }}
                      >
                        Yes, Restart Server
                      </button>
                      <button
                        className="action-btn"
                        onClick={() => setConfirmRestart(false)}
                        style={{ padding: '6px 14px', fontSize: '12.5px' }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {isRestarting && (
                  <div style={{ padding: '14px', borderRadius: '8px', background: 'rgba(234, 179, 8, 0.1)', border: '1px solid rgba(234, 179, 8, 0.3)', display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <RefreshCw size={16} className="spin" style={{ color: '#facc15' }} />
                    <div style={{ fontSize: '12.5px', color: '#fef08a' }}>
                      Restart signal delivered. Reconnecting to the new process...
                    </div>
                  </div>
                )}
              </div>

              {/* Remote Torrent Streamer (VPS) Card */}
              <div className="glass-panel" style={{ padding: '20px', borderRadius: '12px', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <div style={{ background: isRestartingTorrent ? 'rgba(234, 179, 8, 0.15)' : (torrentNodeStatus?.status === 'online' ? 'rgba(59, 130, 246, 0.15)' : 'rgba(239, 68, 68, 0.15)'), padding: '10px', borderRadius: '8px', color: isRestartingTorrent ? '#facc15' : (torrentNodeStatus?.status === 'online' ? '#60a5fa' : '#f87171') }}>
                      <Radio size={22} className={isRestartingTorrent ? 'spin' : ''} />
                    </div>
                    <div>
                      <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span>Remote Torrent Streamer (VPS)</span>
                        <span style={{
                          fontSize: '11px',
                          fontWeight: 600,
                          padding: '2px 8px',
                          borderRadius: '999px',
                          background: isRestartingTorrent ? 'rgba(234,179,8,0.2)' : (torrentNodeStatus?.status === 'online' ? 'rgba(16,185,129,0.2)' : 'rgba(239,68,68,0.2)'),
                          color: isRestartingTorrent ? '#fde047' : (torrentNodeStatus?.status === 'online' ? '#6ee7b7' : '#fca5a5'),
                          border: `1px solid ${isRestartingTorrent ? 'rgba(234,179,8,0.4)' : (torrentNodeStatus?.status === 'online' ? 'rgba(16,185,129,0.4)' : 'rgba(239,68,68,0.4)')}`
                        }}>
                          {isRestartingTorrent ? '● Restarting...' : (torrentNodeStatus?.status === 'online' ? '● Online' : '● Offline')}
                        </span>
                      </div>
                      <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                        Target: <code>{torrentNodeStatus?.vpsServer || 'Configured via TORRENT_STREAM_SERVER'}</code>
                        {torrentNodeStatus?.details?.activeStreams !== undefined && (
                          <span> · Active Streams: {torrentNodeStatus.details.activeStreams}</span>
                        )}
                        {torrentNodeStatus?.details?.uptimeSeconds !== undefined && (
                          <span> · Uptime: {formatUptime(torrentNodeStatus.details.uptimeSeconds)}</span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <button
                      className="action-btn"
                      onClick={() => { fetchTorrentNodeStatus(); fetchTorrentCache(); }}
                      disabled={isLoadingTorrentStatus || isRestartingTorrent}
                      style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 12px', fontSize: '12px' }}
                      title="Refresh status of the remote torrent streamer node"
                    >
                      <RefreshCw size={12} className={isLoadingTorrentStatus ? 'spin' : ''} />
                      Refresh
                    </button>

                    {!confirmRestartTorrent && (
                      <button
                        className="action-btn"
                        onClick={() => setConfirmRestartTorrent(true)}
                        disabled={isRestartingTorrent}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                          padding: '6px 14px',
                          fontSize: '12px',
                          fontWeight: 600,
                          color: '#f87171',
                          borderColor: 'rgba(244, 63, 94, 0.3)',
                          background: 'rgba(244, 63, 94, 0.1)'
                        }}
                      >
                        <Power size={13} />
                        {isRestartingTorrent ? 'Restarting...' : 'Restart Torrent Server'}
                      </button>
                    )}
                  </div>
                </div>

                <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                  This remote VPS handles WebTorrent peer downloads and video stream transcoding independently of the main web app. Restarting sends a PM2 restart signal to the node daemon.
                </div>

                {confirmRestartTorrent && (
                  <div style={{ padding: '14px', borderRadius: '8px', background: 'rgba(244, 63, 94, 0.12)', border: '1px solid rgba(244, 63, 94, 0.3)', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#fca5a5', fontSize: '13px', fontWeight: 600 }}>
                      <AlertCircle size={16} />
                      Are you sure you want to restart the remote torrent streamer node?
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                      Any in-progress torrent streams on the remote VPS will pause briefly while PM2 reboots the daemon (takes ~2–5 seconds).
                    </div>
                    <div style={{ display: 'flex', gap: '10px', marginTop: '4px' }}>
                      <button
                        className="action-btn"
                        onClick={handleRestartTorrentServer}
                        style={{ padding: '6px 16px', fontSize: '12.5px', background: '#ef4444', color: '#fff', borderColor: '#ef4444', fontWeight: 600 }}
                      >
                        Yes, Restart Torrent Server
                      </button>
                      <button
                        className="action-btn"
                        onClick={() => setConfirmRestartTorrent(false)}
                        style={{ padding: '6px 14px', fontSize: '12.5px' }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {isRestartingTorrent && (
                  <div style={{ padding: '14px', borderRadius: '8px', background: 'rgba(234, 179, 8, 0.1)', border: '1px solid rgba(234, 179, 8, 0.3)', display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <RefreshCw size={16} className="spin" style={{ color: '#facc15' }} />
                    <div style={{ fontSize: '12.5px', color: '#fef08a' }}>
                      Restart signal delivered to remote VPS. Waiting for the torrent streamer daemon to come back online...
                    </div>
                  </div>
                )}
              </div>

              {/* Torrent Streamer Cache Card */}
              <div className="glass-panel" style={{ padding: '20px', borderRadius: '12px', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <div style={{ background: 'rgba(245, 158, 11, 0.15)', color: '#fbbf24', padding: '10px', borderRadius: '8px' }}>
                      <Trash2 size={20} />
                    </div>
                    <div>
                      <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>Torrent Streamer Cache</div>
                      <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                        Temporary video chunks stored on the streaming node while torrents stream.
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)' }}>
                        {torrentCache ? (torrentCache.sizeGB >= 1 ? `${torrentCache.sizeGB} GB` : `${torrentCache.sizeMB || 0} MB`) : '—'}
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                        {torrentCache ? `${torrentCache.itemCount || 0} items · ${torrentCache.activeStreamsCount || 0} active` : 'Loading...'}
                      </div>
                    </div>

                    <button
                      className="action-btn"
                      onClick={() => handleClearCache(false)}
                      disabled={isClearingCache}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        padding: '8px 14px',
                        fontSize: '12.5px',
                        fontWeight: 600,
                        color: '#fbbf24',
                        borderColor: 'rgba(245, 158, 11, 0.3)',
                        background: 'rgba(245, 158, 11, 0.1)'
                      }}
                      title="Clear cached torrents that are not currently being watched"
                    >
                      <Trash2 size={13} className={isClearingCache ? 'spin' : ''} />
                      {isClearingCache ? 'Clearing...' : 'Clear Unwatched Cache'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'account' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div className="glass-panel" style={{ padding: '20px', borderRadius: '12px', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>Logged in as</div>
                <div style={{ fontSize: '15px', color: 'var(--text-primary)', fontWeight: 600 }}>{user?.name}</div>
                <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{user?.email}</div>
                <div style={{ marginTop: '12px' }}>
                  <button
                    className="action-btn"
                    onClick={logoutUser}
                    style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 16px', fontSize: '12px', color: 'var(--accent)', borderColor: 'rgba(244, 63, 94, 0.3)', background: 'rgba(244, 63, 94, 0.1)' }}
                  >
                    <LogOut size={14} /> Sign Out of FREEVEE
                  </button>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'downloads' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div className="glass-panel" style={{ padding: '20px', borderRadius: '12px', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <div style={{ background: 'rgba(139, 92, 246, 0.15)', padding: '8px', borderRadius: '8px', color: 'var(--primary)' }}>
                    <Download size={18} />
                  </div>
                  <div>
                    <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>Download Apps for Mobile & TV</div>
                    <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)' }}>Install FREEVEE on Android Phone/Tablet, Fire TV, or Roku.</div>
                  </div>
                </div>

                {/* Android Mobile Client APK */}
                <div style={{ padding: '16px', borderRadius: '10px', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <div style={{ background: 'rgba(16, 185, 129, 0.15)', padding: '10px', borderRadius: '8px', color: '#34d399' }}>
                        <Smartphone size={20} />
                      </div>
                      <div>
                        <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>FREEVEE – Android Mobile App</div>
                        <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)' }}>freevee.apk (Phone &amp; Tablet)</div>
                      </div>
                    </div>
                    <a
                      className="action-btn primary"
                      href="/freevee.apk"
                      download
                      style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '8px 16px', fontSize: '12.5px' }}
                    >
                      <Download size={14} /> Download Mobile APK
                    </a>
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                    <strong style={{ color: 'var(--text-primary)' }}>Install:</strong> Sideload the APK onto your Android phone or tablet. Enable{' '}
                    <strong>Install Unknown Apps</strong> in your browser or file manager when prompted, then tap to install. Enjoy full-screen cloud media streaming and live TV everywhere.
                  </div>
                </div>

                {/* Fire TV Cloud APK */}
                <div style={{ padding: '16px', borderRadius: '10px', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <div style={{ background: 'rgba(244, 63, 94, 0.15)', padding: '10px', borderRadius: '8px', color: '#f87171' }}>
                        <Tv size={20} />
                      </div>
                      <div>
                        <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>FREEVEE – Fire TV</div>
                        <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)' }}>firetv.apk (Fire TV &amp; Android TV)</div>
                      </div>
                    </div>
                    <a
                      className="action-btn primary"
                      href="/tv/downloads/firetv.apk"
                      download
                      style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '8px 16px', fontSize: '12.5px' }}
                    >
                      <Download size={14} /> Download Fire TV APK
                    </a>
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                    <strong style={{ color: 'var(--text-primary)' }}>Install:</strong> Sideload the APK onto your Fire TV. Enable{' '}
                    <strong>Apps from Unknown Sources</strong> under <em>Settings → My Fire TV → Developer options</em>, then install it using the{' '}
                    <strong>Downloader</strong> app or with <code>adb install firetv.apk</code>. Open the app and pair it with your FREEVEE account using the on-screen code.
                  </div>
                </div>

                {/* Roku Cloud channel */}
                <div style={{ padding: '16px', borderRadius: '10px', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <div style={{ background: 'rgba(34, 211, 238, 0.15)', padding: '10px', borderRadius: '8px', color: '#22d3ee' }}>
                        <PlayCircle size={20} />
                      </div>
                      <div>
                        <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>FREEVEE – Roku Channel</div>
                        <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)' }}>roku.zip (Roku Streaming Players &amp; TV)</div>
                      </div>
                    </div>
                    <a
                      className="action-btn primary"
                      href="/tv/downloads/roku.zip"
                      download
                      style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '8px 16px', fontSize: '12.5px' }}
                    >
                      <Download size={14} /> Download Roku Channel
                    </a>
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                    <strong style={{ color: 'var(--text-primary)' }}>Install:</strong> Enable <strong>Developer Mode</strong> on your Roku
                    (Home ×3, Up ×2, Right, Left, Right, Right → enable, enter the code at <code>my.roku.com/developer</code>, and restart).
                    Open <code>http://&lt;roku-ip&gt;</code> in a browser, sign in with your dev username/password, and upload this zip.
                    Open the app and pair it using the on-screen code.
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Picker Modal */}
        <GoogleDrivePickerModal
          isOpen={!!pickerType}
          onClose={() => setPickerType(null)}
          folderType={pickerType}
          currentFolder={pickerType === 'tv' ? folders?.tv : folders?.movies}
          onSave={handleSavePickerFolder}
        />
      </div>
    </div>
  );
}
