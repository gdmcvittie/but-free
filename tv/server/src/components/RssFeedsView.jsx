import React, { useState, useEffect, useMemo } from 'react';
import {
  Rss,
  Film,
  Tv,
  Search,
  Download,
  Check,
  RefreshCw,
  Clock,
  HardDrive,
  Copy,
  ExternalLink,
  Info,
  ChevronUp,
  SlidersHorizontal,
  Sparkles,
  AlertCircle,
  UploadCloud,
  X,
  Plus,
  Trash2,
  Edit3,
  CheckCircle2,
  Bookmark,
  History,
  Layers,
  Calendar,
  Eye,
  Play
} from 'lucide-react';
import { useToast } from './Toast.jsx';

export default function RssFeedsView({
  folders,
  onOpenSettings,
  onOpenLoader,
  onJobAdded,
  onPlayVideo
}) {
  const toast = useToast();

  // Navigation Subview: 'releases' | 'comingsoon' | 'wishlist'
  const [subView, setSubView] = useState('releases');

  // RSS Releases State
  const [items, setItems] = useState([]);
  const [feeds, setFeeds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastFetched, setLastFetched] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('all'); // 'all' | 'tv' | 'movie'
  const [qualityFilter, setQualityFilter] = useState('all'); // 'all' | '2160p' | '1080p' | '720p'
  const [selectedFeedId, setSelectedFeedId] = useState('all');
  const [selectedItem, setSelectedItem] = useState(null);
  const [visibleCount, setVisibleCount] = useState(30);

  // Download and Stream states per item
  const [queuingItems, setQueuingItems] = useState({});
  const [queuedItems, setQueuedItems] = useState({});
  const [streamingItems, setStreamingItems] = useState({});

  // Coming Soon / Upcoming State
  const [comingSoonItems, setComingSoonItems] = useState([]);
  const [comingSoonLoading, setComingSoonLoading] = useState(false);
  const [comingSoonFilter, setComingSoonFilter] = useState('all'); // 'all' | 'tv' | 'movie'
  const [comingSoonSearch, setComingSoonSearch] = useState('');
  const [comingSoonLastUpdated, setComingSoonLastUpdated] = useState(null);

  // Wish List State
  const [wishlistItems, setWishlistItems] = useState([]);
  const [wishlistSettings, setWishlistSettings] = useState({
    intervalMinutes: 30,
    enabled: true,
    lastCheckedAt: null,
    nextCheckAt: null,
    lastCheckSummary: null
  });
  const [wishlistHistory, setWishlistHistory] = useState([]);
  const [wishlistLoading, setWishlistLoading] = useState(false);
  const [wishlistChecking, setWishlistChecking] = useState(false);
  const [wishlistSearch, setWishlistSearch] = useState('');
  const [wishlistTypeFilter, setWishlistTypeFilter] = useState('all'); // 'all' | 'tv' | 'movie'
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState(null);

  // Form State for Add / Edit Modal
  const [formTitle, setFormTitle] = useState('');
  const [formType, setFormType] = useState('tv');
  const [formQuality, setFormQuality] = useState('any');
  const [formSeason, setFormSeason] = useState('');
  const [formEpisode, setFormEpisode] = useState('');
  const [formYear, setFormYear] = useState('');
  const [formAutoDownload, setFormAutoDownload] = useState(true);
  const [isSavingForm, setIsSavingForm] = useState(false);

  // -------------------------------------------------------------
  // Data Fetching: RSS Feeds
  // -------------------------------------------------------------
  const fetchRssFeeds = async (force = false) => {
    if (force) setRefreshing(true);
    else setLoading(true);

    try {
      const url = force ? '/api/rss-feeds/refresh' : '/api/rss-feeds';
      const method = force ? 'POST' : 'GET';
      const res = await fetch(url, { method });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.success) {
        setItems(data.items || []);
        setFeeds(data.feeds || []);
        if (data.lastFetched) setLastFetched(data.lastFetched);
      }
    } catch (err) {
      console.error('[RssFeedsView] Fetch error:', err);
      toast.error('Failed to load RSS feeds: ' + err.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  // -------------------------------------------------------------
  // Data Fetching: Coming Soon / Upcoming
  // -------------------------------------------------------------
  const fetchComingSoon = async (force = false) => {
    setComingSoonLoading(true);
    try {
      const res = await fetch(`/api/coming-soon${force ? '?refresh=true' : ''}`);
      if (res.ok) {
        const data = await res.json();
        if (data.success && Array.isArray(data.items)) {
          setComingSoonItems(data.items);
          if (data.lastUpdated) setComingSoonLastUpdated(data.lastUpdated);
        }
      }
    } catch (err) {
      console.error('[RssFeedsView] Coming soon fetch error:', err);
    } finally {
      setComingSoonLoading(false);
    }
  };

  // -------------------------------------------------------------
  // Data Fetching: Wish List
  // -------------------------------------------------------------
  const fetchWishlist = async () => {
    setWishlistLoading(true);
    try {
      const res = await fetch('/api/wishlist');
      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          setWishlistItems(data.items || []);
          if (data.settings) setWishlistSettings(data.settings);
          if (data.history) setWishlistHistory(data.history || []);
        }
      }
    } catch (err) {
      console.error('[RssFeedsView] Wishlist fetch error:', err);
    } finally {
      setWishlistLoading(false);
    }
  };

  useEffect(() => {
    fetchRssFeeds();
    fetchComingSoon();
    fetchWishlist();
  }, []);

  const getItemKey = (item) => {
    if (!item) return '';
    if (item.id && !item.id.endsWith('bWFnbmV0Oj94dD11cm46YnRpa')) {
      return item.id;
    }
    return item.magnet || item.link || item.title || item.id;
  };

  // -------------------------------------------------------------
  // Stream Torrent Management
  // -------------------------------------------------------------
  const handleStreamItem = async (item, e) => {
    if (e) e.stopPropagation();
    const torrentUrl = item.magnet || item.link;
    if (!torrentUrl) {
      toast.error('No torrent link available to stream.');
      return;
    }

    const key = getItemKey(item);
    setStreamingItems(prev => ({ ...prev, [key]: true }));

    try {
      const res = await fetch('/api/torrent/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: torrentUrl })
      });
      const data = await res.json();
      if (res.ok && data.streamUrl) {
        if (onPlayVideo) {
          onPlayVideo({
            title: item.title,
            cleanTitle: item.cleanTitle || item.title,
            streamUrl: data.streamUrl,
            type: item.type === 'tv' ? 'tv' : 'movie',
            show: item.type === 'tv' ? (item.cleanTitle || item.title) : undefined,
            season: item.season || undefined,
            episode: item.episode || undefined,
            poster: item.poster || undefined
          });
        }
        setSelectedItem(null);
        toast.success(`Streaming "${item.cleanTitle || item.title}"`);
      } else {
        toast.error(data.error || 'Could not start stream for this torrent.');
      }
    } catch (err) {
      console.error('[RssFeedsView] Stream error:', err);
      toast.error('Streaming request failed: ' + err.message);
    } finally {
      setStreamingItems(prev => ({ ...prev, [key]: false }));
    }
  };

  // -------------------------------------------------------------
  // Downloads Management
  // -------------------------------------------------------------
  const handleDownloadItem = async (item, e) => {
    if (e) e.stopPropagation();
    const effectiveKind = item.type === 'tv' ? 'tv' : 'movie';
    const targetFolder = effectiveKind === 'tv' ? folders?.tv : folders?.movies;

    if (!targetFolder || !targetFolder.id) {
      toast.error(
        `Please configure your ${effectiveKind === 'tv' ? 'TV Shows' : 'Movies'} folder in Drive Settings first.`,
        {
          action: onOpenSettings ? { label: 'Open Settings', onClick: onOpenSettings } : undefined
        }
      );
      return;
    }

    if (targetFolder.canAddChildren === false) {
      toast.error(
        `Cannot download: Your ${effectiveKind === 'tv' ? 'TV Shows' : 'Movies'} folder ("${targetFolder.name}") is view-only (no edit access).`,
        {
          action: onOpenSettings ? { label: 'Drive Settings', onClick: onOpenSettings } : undefined
        }
      );
      return;
    }

    const key = getItemKey(item);
    setQueuingItems(prev => ({ ...prev, [key]: true }));

    try {
      const res = await fetch('/api/downloads/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          magnet: item.magnet || item.link,
          title: item.title,
          kind: effectiveKind,
          meta: {
            showName: effectiveKind === 'tv' ? (item.cleanTitle || item.title) : undefined,
            season: item.season || undefined,
            episode: item.episode || undefined,
            year: item.year || undefined,
            genre: item.genre || undefined,
            cleanTitle: item.cleanTitle || undefined
          }
        })
      });

      const data = await res.json();
      if (res.ok && data.success) {
        toast.success(`Added to queue: "${item.cleanTitle || item.title}"`);
        setQueuedItems(prev => ({ ...prev, [key]: true }));
        if (onJobAdded) onJobAdded(data.job);
      } else {
        toast.error(data.error || 'Failed to start download');
      }
    } catch (err) {
      toast.error('Network error starting download: ' + err.message);
    } finally {
      setQueuingItems(prev => ({ ...prev, [key]: false }));
    }
  };

  const copyMagnet = (magnet, e) => {
    if (e) e.stopPropagation();
    if (!magnet) return;
    navigator.clipboard.writeText(magnet);
    toast.success('Magnet URI copied to clipboard!');
  };

  // -------------------------------------------------------------
  // Wish List Actions
  // -------------------------------------------------------------
  const openAddModal = (initialData = null) => {
    if (initialData) {
      setEditingItem(initialData);
      setFormTitle(initialData.title || '');
      setFormType(initialData.type || 'tv');
      setFormQuality(initialData.quality || 'any');
      setFormSeason(initialData.season ? String(initialData.season) : '');
      setFormEpisode(initialData.episode ? String(initialData.episode) : '');
      setFormYear(initialData.year ? String(initialData.year) : '');
      setFormAutoDownload(initialData.autoDownload !== false);
    } else {
      setEditingItem(null);
      setFormTitle('');
      setFormType('tv');
      setFormQuality('any');
      setFormSeason('');
      setFormEpisode('');
      setFormYear('');
      setFormAutoDownload(true);
    }
    setIsAddModalOpen(true);
  };

  const handleQuickAddWishlist = async (targetItem, e) => {
    if (e) e.stopPropagation();
    const titleToAdd = targetItem.cleanTitle || targetItem.title;
    if (!titleToAdd) return;

    try {
      const res = await fetch('/api/wishlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: titleToAdd,
          type: targetItem.type === 'movie' ? 'movie' : 'tv',
          quality: 'any',
          year: targetItem.year || undefined,
          autoDownload: true
        })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        toast.success(`"${titleToAdd}" added to Wish List! It will be automatically grabbed when released.`);
        fetchWishlist();
      } else {
        toast.info(data.error || `"${titleToAdd}" is already in your Wish List.`);
      }
    } catch (err) {
      toast.error('Failed to add to Wish List: ' + err.message);
    }
  };

  const handleSaveWishForm = async (e) => {
    if (e) e.preventDefault();
    const cleanT = formTitle.trim();
    if (!cleanT) {
      toast.error('Please enter a title');
      return;
    }

    setIsSavingForm(true);
    try {
      const payload = {
        title: cleanT,
        type: formType,
        quality: formQuality,
        season: formSeason ? parseInt(formSeason, 10) : null,
        episode: formEpisode ? parseInt(formEpisode, 10) : null,
        year: formYear ? parseInt(formYear, 10) : null,
        autoDownload: formAutoDownload
      };

      const url = editingItem ? `/api/wishlist/${editingItem.id}` : '/api/wishlist';
      const method = editingItem ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (res.ok && data.success) {
        toast.success(editingItem ? 'Wish List item updated!' : `Added "${cleanT}" to Wish List!`);
        setIsAddModalOpen(false);
        setEditingItem(null);
        fetchWishlist();
      } else {
        toast.error(data.error || 'Failed to save Wish List item');
      }
    } catch (err) {
      toast.error('Network error: ' + err.message);
    } finally {
      setIsSavingForm(false);
    }
  };

  const handleToggleWishItem = async (item, e) => {
    if (e) e.stopPropagation();
    try {
      const res = await fetch(`/api/wishlist/${item.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !item.enabled })
      });
      if (res.ok) {
        setWishlistItems(prev =>
          prev.map(i => (i.id === item.id ? { ...i, enabled: !item.enabled } : i))
        );
        toast.info(`"${item.title}" ${!item.enabled ? 'resumed' : 'paused'}`);
      }
    } catch (_) {
      toast.error('Could not update status');
    }
  };

  const handleDeleteWishItem = async (id, title, e) => {
    if (e) e.stopPropagation();
    try {
      const res = await fetch(`/api/wishlist/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setWishlistItems(prev => prev.filter(i => i.id !== id));
        toast.success(`Removed "${title}" from Wish List`);
      }
    } catch (_) {
      toast.error('Failed to remove item');
    }
  };

  const handleCheckWishlistNow = async () => {
    setWishlistChecking(true);
    try {
      const res = await fetch('/api/wishlist/check-now', { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.success) {
        const count = data.result?.matchedCount || 0;
        if (count > 0) {
          toast.success(`Found ${count} match(es)! Automatically queued to Google Drive.`);
          if (onJobAdded) onJobAdded();
        } else {
          toast.info(data.result?.summary || 'Wish list checked: no new releases found.');
        }
        if (data.items) setWishlistItems(data.items);
        if (data.settings) setWishlistSettings(data.settings);
        if (data.history) setWishlistHistory(data.history);
      } else {
        toast.error(data.error || 'Failed to check wish list');
      }
    } catch (err) {
      toast.error('Error running feed check: ' + err.message);
    } finally {
      setWishlistChecking(false);
    }
  };

  const handleUpdateInterval = async (minutes) => {
    try {
      const res = await fetch('/api/wishlist/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intervalMinutes: minutes })
      });
      const data = await res.json();
      if (res.ok && data.settings) {
        setWishlistSettings(data.settings);
        toast.success(`Feeds will now be checked every ${minutes} minutes`);
      }
    } catch (_) {
      toast.error('Failed to update interval');
    }
  };

  const handleToggleAutoMonitoring = async (enabled) => {
    try {
      const res = await fetch('/api/wishlist/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled })
      });
      const data = await res.json();
      if (res.ok && data.settings) {
        setWishlistSettings(data.settings);
        toast.info(enabled ? 'Wish List auto-monitoring enabled' : 'Wish List auto-monitoring paused');
      }
    } catch (_) {
      toast.error('Failed to update monitoring status');
    }
  };

  const handleClearHistory = async () => {
    try {
      const res = await fetch('/api/wishlist/history', { method: 'DELETE' });
      if (res.ok) {
        setWishlistHistory([]);
        toast.success('Match history cleared');
      }
    } catch (_) {
      toast.error('Failed to clear history');
    }
  };

  // -------------------------------------------------------------
  // Counts and Filtering
  // -------------------------------------------------------------
  const counts = useMemo(() => {
    let tv = 0;
    let movie = 0;
    items.forEach(it => {
      if (it.type === 'tv') tv++;
      else if (it.type === 'movie') movie++;
    });
    return { all: items.length, tv, movie };
  }, [items]);

  const filteredItems = useMemo(() => {
    return items.filter(it => {
      if (typeFilter !== 'all' && it.type !== typeFilter) return false;
      if (selectedFeedId !== 'all' && it.feedId !== selectedFeedId && it.feedName !== selectedFeedId) {
        return false;
      }
      if (qualityFilter !== 'all') {
        const q = (it.quality || '').toLowerCase();
        if (qualityFilter === '2160p') {
          if (!q.includes('2160') && !q.includes('4k')) return false;
        } else if (!q.includes(qualityFilter)) {
          return false;
        }
      }
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase();
        const matchTitle = (it.title || '').toLowerCase().includes(query);
        const matchClean = (it.cleanTitle || '').toLowerCase().includes(query);
        const matchDesc = (it.description || '').toLowerCase().includes(query);
        if (!matchTitle && !matchClean && !matchDesc) return false;
      }
      return true;
    });
  }, [items, typeFilter, selectedFeedId, qualityFilter, searchQuery]);

  const filteredComingSoon = useMemo(() => {
    return comingSoonItems.filter(item => {
      if (comingSoonFilter !== 'all' && item.type !== comingSoonFilter) return false;
      if (comingSoonSearch.trim()) {
        const q = comingSoonSearch.toLowerCase();
        const mTitle = (item.title || '').toLowerCase().includes(q);
        const mDesc = (item.description || '').toLowerCase().includes(q);
        const mServ = (item.services || []).some(s => s.toLowerCase().includes(q));
        if (!mTitle && !mDesc && !mServ) return false;
      }
      return true;
    });
  }, [comingSoonItems, comingSoonFilter, comingSoonSearch]);

  const filteredWishlist = useMemo(() => {
    return wishlistItems.filter(item => {
      if (wishlistTypeFilter !== 'all' && item.type !== wishlistTypeFilter) return false;
      if (wishlistSearch.trim()) {
        const q = wishlistSearch.toLowerCase();
        if (!item.title.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [wishlistItems, wishlistTypeFilter, wishlistSearch]);

  const formatRelativeTime = (dateStr) => {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '';
    const diffSec = Math.floor((Date.now() - d.getTime()) / 1000);
    if (diffSec < 60) return 'just now';
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
    if (diffSec < 86400 * 7) return `${Math.floor(diffSec / 86400)}d ago`;
    return d.toLocaleDateString();
  };

  const isItemInWishlist = (targetItem) => {
    const norm = (targetItem.cleanTitle || targetItem.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return wishlistItems.some(w => {
      const wNorm = w.title.toLowerCase().replace(/[^a-z0-9]/g, '');
      return wNorm === norm;
    });
  };

  return (
    <div className="rss-feeds-view" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* Sub-Navigation: Releases vs Coming Soon vs Wish List */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '12px',
          background: 'rgba(255, 255, 255, 0.02)',
          border: '1px solid var(--border-color)',
          borderRadius: '16px',
          padding: '16px 20px',
          backdropFilter: 'blur(12px)'
        }}
      >
        {/* View Switcher Pills */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(0, 0, 0, 0.35)', padding: '5px', borderRadius: '12px', flexWrap: 'wrap' }}>
          <button
            onClick={() => setSubView('releases')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '8px 16px',
              fontSize: '13px',
              fontWeight: 700,
              borderRadius: '9px',
              border: 'none',
              cursor: 'pointer',
              background: subView === 'releases' ? 'linear-gradient(135deg, #f59e0b 0%, #ea580c 100%)' : 'transparent',
              color: subView === 'releases' ? '#fff' : 'var(--text-secondary)',
              boxShadow: subView === 'releases' ? '0 4px 12px rgba(245, 158, 11, 0.3)' : 'none',
              transition: 'all 0.18s ease'
            }}
          >
            <Rss size={15} />
            <span>Latest Releases</span>
            <span
              style={{
                fontSize: '11px',
                padding: '1px 6px',
                borderRadius: '8px',
                background: subView === 'releases' ? 'rgba(0,0,0,0.25)' : 'rgba(255,255,255,0.08)',
                color: subView === 'releases' ? '#fff' : 'var(--text-muted)'
              }}
            >
              {counts.all}
            </span>
          </button>

          <button
            onClick={() => setSubView('comingsoon')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '8px 16px',
              fontSize: '13px',
              fontWeight: 700,
              borderRadius: '9px',
              border: 'none',
              cursor: 'pointer',
              background: subView === 'comingsoon' ? 'linear-gradient(135deg, #06b6d4 0%, #3b82f6 100%)' : 'transparent',
              color: subView === 'comingsoon' ? '#fff' : 'var(--text-secondary)',
              boxShadow: subView === 'comingsoon' ? '0 4px 12px rgba(6, 182, 212, 0.3)' : 'none',
              transition: 'all 0.18s ease'
            }}
          >
            <Calendar size={15} />
            <span>Coming Soon</span>
            <span
              style={{
                fontSize: '11px',
                padding: '1px 6px',
                borderRadius: '8px',
                background: subView === 'comingsoon' ? 'rgba(0,0,0,0.25)' : 'rgba(255,255,255,0.08)',
                color: subView === 'comingsoon' ? '#fff' : 'var(--text-muted)'
              }}
            >
              {comingSoonItems.length}
            </span>
          </button>

          <button
            onClick={() => setSubView('wishlist')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '8px 18px',
              fontSize: '13px',
              fontWeight: 700,
              borderRadius: '9px',
              border: 'none',
              cursor: 'pointer',
              background: subView === 'wishlist' ? 'linear-gradient(135deg, #a855f7 0%, #6366f1 100%)' : 'transparent',
              color: subView === 'wishlist' ? '#fff' : 'var(--text-secondary)',
              boxShadow: subView === 'wishlist' ? '0 4px 12px rgba(168, 85, 247, 0.3)' : 'none',
              transition: 'all 0.18s ease'
            }}
          >
            <Sparkles size={15} />
            <span>Wish List</span>
            <span
              style={{
                fontSize: '11px',
                padding: '1px 6px',
                borderRadius: '8px',
                background: subView === 'wishlist' ? 'rgba(0,0,0,0.25)' : 'rgba(255,255,255,0.08)',
                color: subView === 'wishlist' ? '#fff' : 'var(--text-muted)'
              }}
            >
              {wishlistItems.length}
            </span>
          </button>
        </div>

        {/* Global Toolbar Buttons */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          {subView === 'wishlist' ? (
            <>
              <button
                className="action-btn"
                onClick={handleCheckWishlistNow}
                disabled={wishlistChecking}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontSize: '12px',
                  padding: '8px 14px',
                  borderRadius: '9px',
                  background: 'rgba(168, 85, 247, 0.15)',
                  color: '#d8b4fe',
                  border: '1px solid rgba(168, 85, 247, 0.3)'
                }}
              >
                <RefreshCw size={14} className={wishlistChecking ? 'spin' : ''} />
                <span>{wishlistChecking ? 'Checking Feeds...' : 'Check Feeds Now'}</span>
              </button>

              <button
                className="action-btn primary"
                onClick={() => openAddModal()}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontSize: '12.5px',
                  padding: '8px 16px',
                  borderRadius: '9px',
                  fontWeight: 700
                }}
              >
                <Plus size={15} />
                <span>Add Show / Movie</span>
              </button>
            </>
          ) : subView === 'comingsoon' ? (
            <button
              className="action-btn"
              onClick={() => fetchComingSoon(true)}
              disabled={comingSoonLoading}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                fontSize: '12px',
                padding: '8px 14px',
                borderRadius: '9px',
                background: 'rgba(6, 182, 212, 0.12)',
                color: '#67e8f9',
                border: '1px solid rgba(6, 182, 212, 0.3)'
              }}
            >
              <RefreshCw size={14} className={comingSoonLoading ? 'spin' : ''} />
              <span>{comingSoonLoading ? 'Updating...' : 'Refresh Upcoming'}</span>
            </button>
          ) : (
            <>
              {onOpenLoader && (
                <button
                  className="action-btn"
                  onClick={onOpenLoader}
                  title="Open Cloud Loader Queue"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    fontSize: '12px',
                    padding: '8px 14px',
                    borderRadius: '9px',
                    background: 'rgba(59, 130, 246, 0.12)',
                    color: '#60a5fa',
                    border: '1px solid rgba(59, 130, 246, 0.3)'
                  }}
                >
                  <UploadCloud size={14} />
                  <span>View Loader Queue</span>
                </button>
              )}

              <button
                className="action-btn"
                onClick={() => fetchRssFeeds(true)}
                disabled={refreshing || loading}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontSize: '12px',
                  padding: '8px 14px',
                  borderRadius: '9px',
                  background: 'rgba(255, 255, 255, 0.06)'
                }}
              >
                <RefreshCw size={14} className={refreshing ? 'spin' : ''} />
                <span>{refreshing ? 'Updating Feeds...' : 'Refresh Feeds'}</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* ========================================================= */}
      {/* VIEW: COMING SOON / UPCOMING DISCOVERY                    */}
      {/* ========================================================= */}
      {subView === 'comingsoon' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {/* Header Banner */}
          <div
            className="glass-panel"
            style={{
              padding: '18px 22px',
              borderRadius: '14px',
              background: 'rgba(255, 255, 255, 0.02)',
              border: '1px solid var(--border-color)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '16px'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '14px', minWidth: '260px' }}>
              <div
                style={{
                  width: '42px',
                  height: '42px',
                  borderRadius: '12px',
                  background: 'linear-gradient(135deg, #06b6d4 0%, #3b82f6 100%)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#fff',
                  boxShadow: '0 4px 14px rgba(6, 182, 212, 0.3)'
                }}
              >
                <Calendar size={20} />
              </div>
              <div>
                <h2 style={{ fontSize: '16px', fontWeight: 800, margin: 0, color: 'var(--text-primary)' }}>
                  Coming Soon to Theaters &amp; Streaming
                </h2>
                <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '3px' }}>
                  Add upcoming titles directly to your RSS Wish List. Once a torrent release appears, it will automatically download, transcode, and upload to Google Drive!
                </div>
              </div>
            </div>

            {comingSoonLastUpdated && (
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '5px' }}>
                <Clock size={12} />
                <span>Updated {formatRelativeTime(comingSoonLastUpdated)}</span>
              </div>
            )}
          </div>

          {/* Search & Filter Bar */}
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '12px',
              justifyContent: 'space-between',
              alignItems: 'center',
              background: 'rgba(255, 255, 255, 0.02)',
              border: '1px solid var(--border-color)',
              borderRadius: '12px',
              padding: '12px 16px'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'rgba(0, 0, 0, 0.3)', padding: '3px', borderRadius: '8px' }}>
              <button
                onClick={() => setComingSoonFilter('all')}
                style={{
                  padding: '5px 12px',
                  fontSize: '12px',
                  fontWeight: 600,
                  borderRadius: '6px',
                  border: 'none',
                  cursor: 'pointer',
                  background: comingSoonFilter === 'all' ? 'var(--primary)' : 'transparent',
                  color: comingSoonFilter === 'all' ? '#000' : 'var(--text-secondary)'
                }}
              >
                All ({comingSoonItems.length})
              </button>
              <button
                onClick={() => setComingSoonFilter('tv')}
                style={{
                  padding: '5px 12px',
                  fontSize: '12px',
                  fontWeight: 600,
                  borderRadius: '6px',
                  border: 'none',
                  cursor: 'pointer',
                  background: comingSoonFilter === 'tv' ? 'var(--primary)' : 'transparent',
                  color: comingSoonFilter === 'tv' ? '#000' : 'var(--text-secondary)'
                }}
              >
                TV Shows ({comingSoonItems.filter(i => i.type === 'tv').length})
              </button>
              <button
                onClick={() => setComingSoonFilter('movie')}
                style={{
                  padding: '5px 12px',
                  fontSize: '12px',
                  fontWeight: 600,
                  borderRadius: '6px',
                  border: 'none',
                  cursor: 'pointer',
                  background: comingSoonFilter === 'movie' ? 'var(--primary)' : 'transparent',
                  color: comingSoonFilter === 'movie' ? '#000' : 'var(--text-secondary)'
                }}
              >
                Movies ({comingSoonItems.filter(i => i.type === 'movie').length})
              </button>
            </div>

            <div style={{ position: 'relative', width: '260px' }}>
              <Search size={14} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
              <input
                type="text"
                placeholder="Search upcoming titles..."
                value={comingSoonSearch}
                onChange={(e) => setComingSoonSearch(e.target.value)}
                style={{
                  width: '100%',
                  background: 'rgba(0, 0, 0, 0.4)',
                  border: '1px solid var(--border-color)',
                  borderRadius: '8px',
                  padding: '7px 10px 7px 32px',
                  color: 'var(--text-primary)',
                  fontSize: '12px',
                  outline: 'none'
                }}
              />
              {comingSoonSearch && (
                <button
                  onClick={() => setComingSoonSearch('')}
                  style={{ position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}
                >
                  <X size={13} />
                </button>
              )}
            </div>
          </div>

          {/* Coming Soon Cards Grid */}
          {comingSoonLoading ? (
            <div style={{ padding: '60px 20px', textAlign: 'center', color: 'var(--text-secondary)' }}>
              <RefreshCw size={28} className="spin" style={{ margin: '0 auto 10px', color: 'var(--primary)' }} />
              <p style={{ margin: 0, fontSize: '13px' }}>Scraping upcoming releases...</p>
            </div>
          ) : filteredComingSoon.length === 0 ? (
            <div
              style={{
                padding: '60px 20px',
                textAlign: 'center',
                background: 'rgba(255, 255, 255, 0.02)',
                border: '1px solid var(--border-color)',
                borderRadius: '16px'
              }}
            >
              <Calendar size={40} style={{ color: 'var(--text-muted)', margin: '0 auto 12px' }} />
              <h3 style={{ fontSize: '16px', margin: '0 0 6px' }}>No Upcoming Titles Found</h3>
              <p style={{ fontSize: '13px', color: 'var(--text-secondary)', maxWidth: '400px', margin: '0 auto 16px' }}>
                {comingSoonSearch ? `No matches for "${comingSoonSearch}".` : 'Click "Refresh Upcoming" to check Metacritic for the latest scheduled titles.'}
              </p>
              <button
                className="action-btn"
                onClick={() => fetchComingSoon(true)}
                style={{ padding: '6px 16px', fontSize: '12px' }}
              >
                Refresh Now
              </button>
            </div>
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))',
                gap: '16px'
              }}
            >
              {filteredComingSoon.map((item, idx) => {
                const inWishlist = isItemInWishlist(item);
                const isTv = item.type === 'tv';

                return (
                  <div
                    key={`${item.type}-${item.title}-${idx}`}
                    className="glass-panel"
                    style={{
                      borderRadius: '10px',
                      overflow: 'hidden',
                      display: 'flex',
                      flexDirection: 'column',
                      border: '1px solid var(--border-color)',
                      background: 'rgba(255, 255, 255, 0.03)',
                      transition: 'transform 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease'
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.transform = 'translateY(-3px)';
                      e.currentTarget.style.borderColor = 'rgba(6, 182, 212, 0.5)';
                      e.currentTarget.style.boxShadow = '0 8px 24px rgba(0, 0, 0, 0.4)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.transform = 'translateY(0)';
                      e.currentTarget.style.borderColor = 'var(--border-color)';
                      e.currentTarget.style.boxShadow = 'none';
                    }}
                  >
                    {/* Artwork Container */}
                    <div
                      style={{
                        position: 'relative',
                        aspectRatio: '2/3',
                        background: 'rgba(0, 0, 0, 0.45)',
                        overflow: 'hidden'
                      }}
                    >
                      {item.image ? (
                        <img
                          src={item.image}
                          alt={item.title}
                          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                          loading="lazy"
                          onError={(e) => { e.currentTarget.style.display = 'none'; }}
                        />
                      ) : (
                        <div
                          style={{
                            width: '100%',
                            height: '100%',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '8px',
                            padding: '12px',
                            textAlign: 'center',
                            background: isTv
                              ? 'linear-gradient(135deg, rgba(37, 99, 235, 0.22) 0%, rgba(15, 23, 42, 0.85) 100%)'
                              : 'linear-gradient(135deg, rgba(147, 51, 234, 0.22) 0%, rgba(15, 23, 42, 0.85) 100%)'
                          }}
                        >
                          {isTv ? (
                            <Tv size={34} style={{ color: '#60a5fa', opacity: 0.85 }} />
                          ) : (
                            <Film size={34} style={{ color: '#c084fc', opacity: 0.85 }} />
                          )}
                          <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)' }}>
                            {item.title}
                          </div>
                        </div>
                      )}

                      {/* Type Badge */}
                      <div
                        style={{
                          position: 'absolute',
                          top: '8px',
                          left: '8px',
                          zIndex: 2,
                          fontSize: '9px',
                          fontWeight: 800,
                          padding: '2px 6px',
                          borderRadius: '4px',
                          background: isTv ? 'rgba(37, 99, 235, 0.85)' : 'rgba(147, 51, 234, 0.85)',
                          color: '#fff',
                          backdropFilter: 'blur(4px)',
                          textTransform: 'uppercase'
                        }}
                      >
                        {isTv ? 'TV Show' : 'Movie'}
                      </div>

                      {/* Release Date Overlay on Poster */}
                      {item.releaseDate && (
                        <div
                          style={{
                            position: 'absolute',
                            bottom: 0,
                            left: 0,
                            right: 0,
                            padding: '20px 8px 6px',
                            background: 'linear-gradient(to top, rgba(0,0,0,0.92) 0%, rgba(0,0,0,0) 100%)',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '4px',
                            fontSize: '10.5px',
                            fontWeight: 700,
                            color: '#67e8f9'
                          }}
                        >
                          <Calendar size={11} />
                          <span>{item.releaseDate}</span>
                        </div>
                      )}
                    </div>

                    {/* Card Body */}
                    <div
                      style={{
                        padding: '10px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '8px',
                        flex: 1,
                        justifyContent: 'space-between'
                      }}
                    >
                      <div>
                        <div
                          style={{
                            fontSize: '13px',
                            fontWeight: 700,
                            color: 'var(--text-primary)',
                            lineHeight: '1.3',
                            display: '-webkit-box',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical',
                            overflow: 'hidden'
                          }}
                          title={item.title}
                        >
                          {item.title}
                        </div>

                        {/* Services / Platform info */}
                        {item.services && item.services.length > 0 && (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '6px' }}>
                            {item.services.slice(0, 2).map((s, si) => (
                              <span
                                key={si}
                                style={{
                                  fontSize: '9.5px',
                                  fontWeight: 700,
                                  background: 'rgba(255, 255, 255, 0.08)',
                                  color: 'var(--text-secondary)',
                                  padding: '1px 5px',
                                  borderRadius: '3px'
                                }}
                              >
                                {s}
                              </span>
                            ))}
                            {item.services.length > 2 && (
                              <span style={{ fontSize: '9px', color: 'var(--text-muted)' }}>
                                +{item.services.length - 2}
                              </span>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Add to Wish List Button */}
                      <button
                        className="action-btn"
                        onClick={(e) => handleQuickAddWishlist(item, e)}
                        title={inWishlist ? 'In your Wish List' : 'Add to Wish List for automatic download'}
                        style={{
                          width: '100%',
                          padding: '7px 10px',
                          borderRadius: '7px',
                          fontSize: '11.5px',
                          fontWeight: 700,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: '6px',
                          background: inWishlist ? 'rgba(168, 85, 247, 0.2)' : 'rgba(168, 85, 247, 0.12)',
                          color: inWishlist ? '#c084fc' : '#d8b4fe',
                          border: `1px solid ${inWishlist ? 'rgba(168, 85, 247, 0.45)' : 'rgba(168, 85, 247, 0.25)'}`,
                          cursor: 'pointer',
                          transition: 'all 0.15s ease'
                        }}
                      >
                        <Sparkles size={13} fill={inWishlist ? '#c084fc' : 'none'} />
                        <span>{inWishlist ? 'In Wish List ✓' : '+ Wish List'}</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ========================================================= */}
      {/* VIEW: WISH LIST                                           */}
      {/* ========================================================= */}
      {subView === 'wishlist' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {/* Wish List Status & Automation Banner */}
          <div
            className="glass-panel"
            style={{
              padding: '18px 22px',
              borderRadius: '14px',
              background: 'rgba(255, 255, 255, 0.02)',
              border: '1px solid var(--border-color)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: '16px'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '14px', minWidth: '260px' }}>
              <div
                style={{
                  width: '42px',
                  height: '42px',
                  borderRadius: '12px',
                  background: 'linear-gradient(135deg, #8b5cf6 0%, #3b82f6 100%)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#fff',
                  boxShadow: '0 4px 14px rgba(139, 92, 246, 0.3)'
                }}
              >
                <Sparkles size={20} />
              </div>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <h2 style={{ fontSize: '16px', fontWeight: 800, margin: 0, color: 'var(--text-primary)' }}>
                    Wish List Auto-Downloader
                  </h2>
                  <span
                    style={{
                      fontSize: '11px',
                      fontWeight: 700,
                      padding: '2px 8px',
                      borderRadius: '999px',
                      background: wishlistSettings.enabled ? 'rgba(34, 197, 94, 0.15)' : 'rgba(234, 179, 8, 0.15)',
                      color: wishlistSettings.enabled ? '#4ade80' : '#facc15',
                      border: `1px solid ${wishlistSettings.enabled ? 'rgba(34, 197, 94, 0.3)' : 'rgba(234, 179, 8, 0.3)'}`
                    }}
                  >
                    {wishlistSettings.enabled ? '● Active' : '● Paused'}
                  </span>
                </div>
                <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '3px' }}>
                  {wishlistSettings.lastCheckSummary || 'Monitors RSS feeds and automatically downloads new episodes or movies to Google Drive.'}
                </div>
              </div>
            </div>

            {/* Check Frequency & Controls */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Check Every:</span>
                <select
                  value={wishlistSettings.intervalMinutes || 30}
                  onChange={(e) => handleUpdateInterval(parseInt(e.target.value, 10))}
                  style={{
                    background: 'rgba(0, 0, 0, 0.4)',
                    border: '1px solid var(--border-color)',
                    borderRadius: '8px',
                    padding: '6px 10px',
                    color: 'var(--text-primary)',
                    fontSize: '12px',
                    outline: 'none',
                    cursor: 'pointer'
                  }}
                >
                  <option value="15">15 minutes</option>
                  <option value="30">30 minutes (Default)</option>
                  <option value="60">1 hour</option>
                  <option value="120">2 hours</option>
                  <option value="360">6 hours</option>
                  <option value="720">12 hours</option>
                  <option value="1440">24 hours</option>
                </select>
              </div>

              <button
                className="action-btn"
                onClick={() => handleToggleAutoMonitoring(!wishlistSettings.enabled)}
                style={{
                  padding: '6px 12px',
                  fontSize: '11.5px',
                  borderRadius: '7px',
                  color: wishlistSettings.enabled ? 'var(--text-secondary)' : '#4ade80'
                }}
              >
                {wishlistSettings.enabled ? 'Pause Auto-Check' : 'Resume Auto-Check'}
              </button>
            </div>
          </div>

          {/* Search and Filters */}
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '12px',
              justifyContent: 'space-between',
              alignItems: 'center',
              background: 'rgba(255, 255, 255, 0.02)',
              border: '1px solid var(--border-color)',
              borderRadius: '12px',
              padding: '12px 16px'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'rgba(0, 0, 0, 0.3)', padding: '3px', borderRadius: '8px' }}>
              <button
                onClick={() => setWishlistTypeFilter('all')}
                style={{
                  padding: '5px 12px',
                  fontSize: '12px',
                  fontWeight: 600,
                  borderRadius: '6px',
                  border: 'none',
                  cursor: 'pointer',
                  background: wishlistTypeFilter === 'all' ? 'var(--primary)' : 'transparent',
                  color: wishlistTypeFilter === 'all' ? '#000' : 'var(--text-secondary)'
                }}
              >
                All ({wishlistItems.length})
              </button>
              <button
                onClick={() => setWishlistTypeFilter('tv')}
                style={{
                  padding: '5px 12px',
                  fontSize: '12px',
                  fontWeight: 600,
                  borderRadius: '6px',
                  border: 'none',
                  cursor: 'pointer',
                  background: wishlistTypeFilter === 'tv' ? 'var(--primary)' : 'transparent',
                  color: wishlistTypeFilter === 'tv' ? '#000' : 'var(--text-secondary)'
                }}
              >
                TV Shows ({wishlistItems.filter(i => i.type === 'tv').length})
              </button>
              <button
                onClick={() => setWishlistTypeFilter('movie')}
                style={{
                  padding: '5px 12px',
                  fontSize: '12px',
                  fontWeight: 600,
                  borderRadius: '6px',
                  border: 'none',
                  cursor: 'pointer',
                  background: wishlistTypeFilter === 'movie' ? 'var(--primary)' : 'transparent',
                  color: wishlistTypeFilter === 'movie' ? '#000' : 'var(--text-secondary)'
                }}
              >
                Movies ({wishlistItems.filter(i => i.type === 'movie').length})
              </button>
            </div>

            <div style={{ position: 'relative', width: '240px' }}>
              <Search size={14} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
              <input
                type="text"
                placeholder="Search Wish List..."
                value={wishlistSearch}
                onChange={(e) => setWishlistSearch(e.target.value)}
                style={{
                  width: '100%',
                  background: 'rgba(0, 0, 0, 0.4)',
                  border: '1px solid var(--border-color)',
                  borderRadius: '8px',
                  padding: '7px 10px 7px 32px',
                  color: 'var(--text-primary)',
                  fontSize: '12px',
                  outline: 'none'
                }}
              />
            </div>
          </div>

          {/* Wish List Cards Grid */}
          {wishlistLoading ? (
            <div style={{ padding: '60px 20px', textAlign: 'center', color: 'var(--text-secondary)' }}>
              <RefreshCw size={28} className="spin" style={{ margin: '0 auto 10px', color: 'var(--primary)' }} />
              <p style={{ margin: 0, fontSize: '13px' }}>Loading your Wish List...</p>
            </div>
          ) : filteredWishlist.length === 0 ? (
            <div
              style={{
                padding: '60px 20px',
                textAlign: 'center',
                background: 'rgba(255, 255, 255, 0.02)',
                border: '1px solid var(--border-color)',
                borderRadius: '16px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '12px'
              }}
            >
              <div
                style={{
                  width: '56px',
                  height: '56px',
                  borderRadius: '16px',
                  background: 'rgba(168, 85, 247, 0.15)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#c084fc'
                }}
              >
                <Sparkles size={28} />
              </div>
              <h3 style={{ fontSize: '17px', margin: 0 }}>Your Wish List is Empty</h3>
              <p style={{ fontSize: '13px', color: 'var(--text-secondary)', maxWidth: '420px', margin: 0, lineHeight: 1.5 }}>
                Add TV shows or movies you want to track. Whenever a new episode or movie release appears in your RSS feeds, FREEVEE will automatically download, transcode, and upload it to Google Drive!
              </p>
              <button
                className="action-btn primary"
                onClick={() => openAddModal()}
                style={{ padding: '9px 20px', fontSize: '13px', fontWeight: 700, marginTop: '8px' }}
              >
                <Plus size={15} /> Add First Title
              </button>
            </div>
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                gap: '16px'
              }}
            >
              {filteredWishlist.map(item => {
                const isTv = item.type === 'tv';
                const isEnabled = item.enabled !== false;
                const matchCount = item.matchCount || 0;
                const downloadedEps = item.downloadedEpisodes || [];

                return (
                  <div
                    key={item.id}
                    className="glass-panel"
                    style={{
                      borderRadius: '12px',
                      background: 'rgba(255, 255, 255, 0.02)',
                      border: '1px solid var(--border-color)',
                      padding: '16px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '14px',
                      opacity: isEnabled ? 1 : 0.6,
                      transition: 'all 0.18s ease'
                    }}
                  >
                    {/* Top Row: Type Badge + Enabled Switch */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span
                          style={{
                            fontSize: '10.5px',
                            fontWeight: 800,
                            padding: '2px 8px',
                            borderRadius: '5px',
                            background: isTv ? 'rgba(59, 130, 246, 0.2)' : 'rgba(168, 85, 247, 0.2)',
                            color: isTv ? '#93c5fd' : '#d8b4fe',
                            textTransform: 'uppercase',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '4px'
                          }}
                        >
                          {isTv ? <Tv size={12} /> : <Film size={12} />}
                          <span>{isTv ? 'TV Show' : 'Movie'}</span>
                        </span>

                        {item.quality && item.quality !== 'any' && (
                          <span
                            style={{
                              fontSize: '10px',
                              fontWeight: 700,
                              padding: '2px 6px',
                              borderRadius: '4px',
                              background: 'rgba(250, 204, 21, 0.15)',
                              color: '#facc15'
                            }}
                          >
                            {item.quality.toUpperCase()}
                          </span>
                        )}
                      </div>

                      <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '11px', color: 'var(--text-muted)' }}>
                        <input
                          type="checkbox"
                          checked={isEnabled}
                          onChange={(e) => handleToggleWishItem(item, e)}
                          style={{ cursor: 'pointer', accentColor: 'var(--primary)' }}
                        />
                        <span>{isEnabled ? 'Active' : 'Paused'}</span>
                      </label>
                    </div>

                    {/* Title & Scope */}
                    <div>
                      <h3 style={{ fontSize: '16px', fontWeight: 800, margin: '0 0 4px', color: 'var(--text-primary)' }}>
                        {item.title}
                      </h3>
                      <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)' }}>
                        {isTv ? (
                          item.season ? `Season ${item.season}${item.episode ? ` Episode ${item.episode}` : ' (All episodes)'}` : 'All new episodes'
                        ) : (
                          item.year ? `Year: ${item.year}` : 'Any release'
                        )}
                      </div>
                    </div>

                    {/* Status / Matches Summary */}
                    <div
                      style={{
                        background: 'rgba(0, 0, 0, 0.25)',
                        border: '1px solid var(--border-color)',
                        borderRadius: '8px',
                        padding: '10px 12px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '6px',
                        fontSize: '11.5px'
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ color: 'var(--text-muted)' }}>Downloads to Drive:</span>
                        <strong style={{ color: matchCount > 0 ? '#4ade80' : 'var(--text-secondary)' }}>
                          {matchCount > 0 ? `${matchCount} release(s) queued` : 'Waiting for release'}
                        </strong>
                      </div>

                      {item.lastMatchedAt && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: 'var(--text-muted)', fontSize: '11px' }}>
                          <span>Last match:</span>
                          <span>{formatRelativeTime(item.lastMatchedAt)}</span>
                        </div>
                      )}

                      {/* Downloaded Episodes Tags */}
                      {isTv && downloadedEps.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '4px' }}>
                          {downloadedEps.slice(0, 8).map(ep => (
                            <span
                              key={ep}
                              style={{
                                fontSize: '10px',
                                fontWeight: 700,
                                background: 'rgba(34, 197, 94, 0.15)',
                                color: '#86efac',
                                border: '1px solid rgba(34, 197, 94, 0.3)',
                                padding: '1px 5px',
                                borderRadius: '4px'
                              }}
                            >
                              {ep}
                            </span>
                          ))}
                          {downloadedEps.length > 8 && (
                            <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                              +{downloadedEps.length - 8} more
                            </span>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Bottom Actions */}
                    <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '8px', marginTop: 'auto' }}>
                      <button
                        className="action-btn"
                        onClick={() => openAddModal(item)}
                        style={{ padding: '5px 10px', fontSize: '11.5px', display: 'flex', alignItems: 'center', gap: '4px' }}
                      >
                        <Edit3 size={12} />
                        <span>Edit</span>
                      </button>

                      <button
                        className="action-btn"
                        onClick={(e) => handleDeleteWishItem(item.id, item.title, e)}
                        style={{ padding: '5px 10px', fontSize: '11.5px', color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: '4px' }}
                      >
                        <Trash2 size={12} />
                        <span>Remove</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Activity History Section */}
          {wishlistHistory.length > 0 && (
            <div
              className="glass-panel"
              style={{
                marginTop: '10px',
                padding: '20px',
                borderRadius: '14px',
                background: 'rgba(255, 255, 255, 0.02)',
                border: '1px solid var(--border-color)',
                display: 'flex',
                flexDirection: 'column',
                gap: '14px'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <History size={16} style={{ color: 'var(--primary)' }} />
                  <span style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>
                    Recent Automated Downloads ({wishlistHistory.length})
                  </span>
                </div>
                <button
                  className="action-btn"
                  onClick={handleClearHistory}
                  style={{ fontSize: '11px', padding: '4px 10px' }}
                >
                  Clear History
                </button>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {wishlistHistory.slice(0, 10).map(hist => (
                  <div
                    key={hist.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '8px 12px',
                      background: 'rgba(0, 0, 0, 0.25)',
                      borderRadius: '8px',
                      fontSize: '12px'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                      <CheckCircle2 size={14} style={{ color: '#4ade80', flexShrink: 0 }} />
                      <span style={{ fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {hist.wishTitle}
                      </span>
                      {hist.epKey && (
                        <span style={{ fontSize: '10px', fontWeight: 700, color: '#93c5fd', background: 'rgba(59, 130, 246, 0.15)', padding: '1px 5px', borderRadius: '4px' }}>
                          {hist.epKey}
                        </span>
                      )}
                      <span style={{ fontSize: '11px', color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {hist.releaseTitle}
                      </span>
                    </div>

                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', whiteSpace: 'nowrap', marginLeft: '12px' }}>
                      {formatRelativeTime(hist.timestamp)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ========================================================= */}
      {/* VIEW: RELEASES BROWSER                                    */}
      {/* ========================================================= */}
      {subView === 'releases' && (
        <>
          {/* Top Banner / Header Row */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              flexWrap: 'wrap',
              gap: '16px',
              background: 'rgba(255, 255, 255, 0.02)',
              border: '1px solid var(--border-color)',
              borderRadius: '16px',
              padding: '20px 24px',
              backdropFilter: 'blur(12px)'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
              <div
                style={{
                  width: '44px',
                  height: '44px',
                  borderRadius: '12px',
                  background: 'linear-gradient(135deg, #f59e0b 0%, #ea580c 100%)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#fff',
                  boxShadow: '0 6px 16px rgba(245, 158, 11, 0.3)'
                }}
              >
                <Rss size={24} />
              </div>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <h1 style={{ fontSize: '20px', fontWeight: 800, margin: 0, letterSpacing: '-0.3px' }}>
                    RSS Releases
                  </h1>
                  <span
                    style={{
                      background: 'rgba(245, 158, 11, 0.15)',
                      color: '#fbbf24',
                      border: '1px solid rgba(245, 158, 11, 0.3)',
                      fontSize: '11px',
                      fontWeight: 700,
                      padding: '2px 8px',
                      borderRadius: '12px'
                    }}
                  >
                    {counts.all} items
                  </span>
                </div>
                <p style={{ margin: '4px 0 0', fontSize: '13px', color: 'var(--text-secondary)' }}>
                  Browse the latest TV show episodes and movie releases &bull; 1-click add to Wish List or queue to Drive
                </p>
              </div>
            </div>
          </div>

          {/* Filter and Search Bar */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
              background: 'rgba(255, 255, 255, 0.02)',
              border: '1px solid var(--border-color)',
              borderRadius: '14px',
              padding: '14px 18px'
            }}
          >
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', justifyContent: 'space-between', alignItems: 'center' }}>
              {/* Type Filter Pills */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'rgba(0, 0, 0, 0.3)', padding: '4px', borderRadius: '10px' }}>
                <button
                  onClick={() => { setTypeFilter('all'); setVisibleCount(30); }}
                  style={{
                    padding: '6px 14px',
                    fontSize: '12.5px',
                    fontWeight: 600,
                    borderRadius: '8px',
                    border: 'none',
                    cursor: 'pointer',
                    background: typeFilter === 'all' ? 'var(--primary)' : 'transparent',
                    color: typeFilter === 'all' ? '#000' : 'var(--text-secondary)',
                    transition: 'all 0.15s ease'
                  }}
                >
                  All Releases ({counts.all})
                </button>

                <button
                  onClick={() => { setTypeFilter('tv'); setVisibleCount(30); }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '6px 14px',
                    fontSize: '12.5px',
                    fontWeight: 600,
                    borderRadius: '8px',
                    border: 'none',
                    cursor: 'pointer',
                    background: typeFilter === 'tv' ? 'var(--primary)' : 'transparent',
                    color: typeFilter === 'tv' ? '#000' : 'var(--text-secondary)',
                    transition: 'all 0.15s ease'
                  }}
                >
                  <Tv size={14} />
                  TV Shows ({counts.tv})
                </button>

                <button
                  onClick={() => { setTypeFilter('movie'); setVisibleCount(30); }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '6px 14px',
                    fontSize: '12.5px',
                    fontWeight: 600,
                    borderRadius: '8px',
                    border: 'none',
                    cursor: 'pointer',
                    background: typeFilter === 'movie' ? 'var(--primary)' : 'transparent',
                    color: typeFilter === 'movie' ? '#000' : 'var(--text-secondary)',
                    transition: 'all 0.15s ease'
                  }}
                >
                  <Film size={14} />
                  Movies ({counts.movie})
                </button>
              </div>

              {/* Search Box */}
              <div style={{ position: 'relative', minWidth: '220px', flex: 1, maxWidth: '380px' }}>
                <Search size={15} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
                <input
                  type="text"
                  placeholder="Filter releases by name..."
                  value={searchQuery}
                  onChange={(e) => { setSearchQuery(e.target.value); setVisibleCount(30); }}
                  style={{
                    width: '100%',
                    background: 'rgba(0, 0, 0, 0.4)',
                    border: '1px solid var(--border-color)',
                    borderRadius: '9px',
                    padding: '8px 12px 8px 36px',
                    color: 'var(--text-primary)',
                    fontSize: '13px',
                    outline: 'none'
                  }}
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '2px' }}
                  >
                    <X size={14} />
                  </button>
                )}
              </div>

              {/* Quality Selector */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <SlidersHorizontal size={14} style={{ color: 'var(--text-muted)' }} />
                <select
                  value={qualityFilter}
                  onChange={(e) => { setQualityFilter(e.target.value); setVisibleCount(30); }}
                  style={{
                    background: 'rgba(0, 0, 0, 0.4)',
                    border: '1px solid var(--border-color)',
                    borderRadius: '8px',
                    padding: '7px 12px',
                    color: 'var(--text-primary)',
                    fontSize: '12.5px',
                    outline: 'none'
                  }}
                >
                  <option value="all">Any Quality</option>
                  <option value="2160p">4K / 2160p</option>
                  <option value="1080p">1080p Full HD</option>
                  <option value="720p">720p HD</option>
                </select>
              </div>
            </div>

            {/* Feeds Source Selector Row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', paddingTop: '6px', borderTop: '1px solid rgba(255, 255, 255, 0.05)', fontSize: '11.5px', color: 'var(--text-muted)' }}>
              <span>Feed Sources:</span>
              <button
                onClick={() => setSelectedFeedId('all')}
                style={{
                  padding: '3px 9px',
                  borderRadius: '6px',
                  border: '1px solid',
                  borderColor: selectedFeedId === 'all' ? 'var(--primary)' : 'rgba(255, 255, 255, 0.08)',
                  background: selectedFeedId === 'all' ? 'rgba(234, 179, 8, 0.15)' : 'transparent',
                  color: selectedFeedId === 'all' ? 'var(--primary)' : 'var(--text-secondary)',
                  fontSize: '11px',
                  fontWeight: 600,
                  cursor: 'pointer'
                }}
              >
                All Feeds
              </button>
              {feeds.map(feed => (
                <button
                  key={feed.id || feed.url}
                  onClick={() => setSelectedFeedId(feed.id || feed.name)}
                  style={{
                    padding: '3px 9px',
                    borderRadius: '6px',
                    border: '1px solid',
                    borderColor: selectedFeedId === (feed.id || feed.name) ? 'var(--primary)' : 'rgba(255, 255, 255, 0.08)',
                    background: selectedFeedId === (feed.id || feed.name) ? 'rgba(234, 179, 8, 0.15)' : 'transparent',
                    color: selectedFeedId === (feed.id || feed.name) ? 'var(--primary)' : 'var(--text-secondary)',
                    fontSize: '11px',
                    fontWeight: 600,
                    cursor: 'pointer'
                  }}
                >
                  {feed.name}
                </button>
              ))}

              {lastFetched && (
                <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '5px' }}>
                  <Clock size={12} />
                  <span>Feed updated {formatRelativeTime(lastFetched)}</span>
                </div>
              )}
            </div>
          </div>

          {/* Main List Area */}
          {loading ? (
            <div style={{ padding: '60px 20px', textAlign: 'center', color: 'var(--text-secondary)' }}>
              <RefreshCw size={32} className="spin" style={{ margin: '0 auto 12px', color: 'var(--primary)' }} />
              <p style={{ margin: 0, fontSize: '14px' }}>Fetching latest RSS feeds...</p>
            </div>
          ) : filteredItems.length === 0 ? (
            <div
              style={{
                padding: '60px 20px',
                textAlign: 'center',
                background: 'rgba(255, 255, 255, 0.02)',
                border: '1px solid var(--border-color)',
                borderRadius: '16px'
              }}
            >
              <AlertCircle size={40} style={{ color: 'var(--text-muted)', margin: '0 auto 12px' }} />
              <h3 style={{ fontSize: '16px', margin: '0 0 6px' }}>No Releases Found</h3>
              <p style={{ fontSize: '13px', color: 'var(--text-secondary)', maxWidth: '400px', margin: '0 auto 16px' }}>
                {searchQuery
                  ? `No releases matched "${searchQuery}". Try adjusting your search term or quality filters.`
                  : 'No items found in the configured RSS feeds.'}
              </p>
              {searchQuery && (
                <button
                  className="action-btn"
                  onClick={() => { setSearchQuery(''); setTypeFilter('all'); setQualityFilter('all'); }}
                  style={{ padding: '6px 16px', fontSize: '12px' }}
                >
                  Clear Filters
                </button>
              )}
            </div>
          ) : (
            <>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
                  gap: '16px'
                }}
              >
                {filteredItems.slice(0, visibleCount).map((item) => {
                  const itemKey = getItemKey(item);
                  const isQueued = queuedItems[itemKey];
                  const isQueuing = queuingItems[itemKey];
                  const isStreaming = streamingItems[itemKey];
                  const isTv = item.type === 'tv';
                  const inWishlist = isItemInWishlist(item);

                  return (
                    <div
                      key={itemKey}
                      className="glass-panel"
                      style={{
                        borderRadius: '10px',
                        overflow: 'hidden',
                        display: 'flex',
                        flexDirection: 'column',
                        border: '1px solid var(--border-color)',
                        position: 'relative',
                        transition: 'transform 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease',
                        background: 'rgba(255, 255, 255, 0.03)'
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.transform = 'translateY(-3px)';
                        e.currentTarget.style.borderColor = 'rgba(234, 179, 8, 0.5)';
                        e.currentTarget.style.boxShadow = '0 8px 24px rgba(0, 0, 0, 0.4)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.transform = 'translateY(0)';
                        e.currentTarget.style.borderColor = 'var(--border-color)';
                        e.currentTarget.style.boxShadow = 'none';
                      }}
                    >
                      {/* Poster Container */}
                      <div
                        style={{
                          position: 'relative',
                          aspectRatio: '2/3',
                          background: 'rgba(0, 0, 0, 0.45)',
                          overflow: 'hidden',
                          cursor: 'pointer'
                        }}
                        onClick={() => setSelectedItem(item)}
                      >
                        {item.poster ? (
                          <img
                            src={item.poster}
                            alt={item.cleanTitle || item.title}
                            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                            loading="lazy"
                          />
                        ) : (
                          <div
                            style={{
                              width: '100%',
                              height: '100%',
                              display: 'flex',
                              flexDirection: 'column',
                              alignItems: 'center',
                              justifyContent: 'center',
                              gap: '8px',
                              padding: '12px',
                              textAlign: 'center',
                              background: isTv
                                ? 'linear-gradient(135deg, rgba(37, 99, 235, 0.22) 0%, rgba(15, 23, 42, 0.85) 100%)'
                                : 'linear-gradient(135deg, rgba(147, 51, 234, 0.22) 0%, rgba(15, 23, 42, 0.85) 100%)'
                            }}
                          >
                            {isTv ? (
                              <Tv size={34} style={{ color: '#60a5fa', opacity: 0.85 }} />
                            ) : (
                              <Film size={34} style={{ color: '#c084fc', opacity: 0.85 }} />
                            )}
                            <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)', lineHeight: '1.2' }}>
                              {item.cleanTitle || item.title}
                            </div>
                          </div>
                        )}

                        {/* Play overlay on poster hover */}
                        <div
                          className="rss-card-play-overlay"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleStreamItem(item, e);
                          }}
                          title="Stream torrent now"
                          style={{
                            position: 'absolute',
                            inset: 0,
                            background: 'rgba(0, 0, 0, 0.45)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            zIndex: 4,
                            transition: 'opacity 0.2s ease',
                            opacity: isStreaming ? 1 : 0
                          }}
                        >
                          <div
                            className="rss-play-badge"
                            style={{
                              width: '46px',
                              height: '46px',
                              borderRadius: '50%',
                              background: 'var(--primary)',
                              color: '#000',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              boxShadow: '0 4px 18px rgba(0, 0, 0, 0.6)',
                              transition: 'transform 0.18s ease, box-shadow 0.18s ease'
                            }}
                          >
                            {isStreaming ? (
                              <RefreshCw size={20} className="spin" />
                            ) : (
                              <Play size={22} fill="#000" style={{ marginLeft: '3px' }} />
                            )}
                          </div>
                        </div>

                        {/* Top Quality Badge */}
                        {item.quality && (
                          <div
                            style={{
                              position: 'absolute',
                              top: '8px',
                              right: '8px',
                              zIndex: 2,
                              fontSize: '9px',
                              fontWeight: 800,
                              padding: '2px 6px',
                              borderRadius: '4px',
                              background: 'rgba(0, 0, 0, 0.75)',
                              color: '#facc15',
                              border: '1px solid rgba(250, 204, 21, 0.35)',
                              backdropFilter: 'blur(4px)'
                            }}
                          >
                            {item.quality.toUpperCase()}
                          </div>
                        )}

                        {/* Bottom Gradient Overlay on Poster */}
                        <div
                          style={{
                            position: 'absolute',
                            bottom: 0,
                            left: 0,
                            right: 0,
                            padding: '22px 8px 6px',
                            background: 'linear-gradient(to top, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0) 100%)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            fontSize: '11px',
                            color: '#fff'
                          }}
                        >
                          {isTv && item.season && item.episode ? (
                            <span style={{ fontWeight: 800, color: 'var(--primary)', letterSpacing: '0.2px' }}>
                              S{String(item.season).padStart(2, '0')}E{String(item.episode).padStart(2, '0')}
                            </span>
                          ) : item.year ? (
                            <span style={{ fontWeight: 700, color: 'rgba(255,255,255,0.85)' }}>
                              {item.year}
                            </span>
                          ) : <span />}

                          {item.size && (
                            <span
                              style={{
                                fontSize: '10px',
                                fontWeight: 600,
                                color: 'rgba(255,255,255,0.85)',
                                background: 'rgba(0,0,0,0.55)',
                                padding: '1px 5px',
                                borderRadius: '3px'
                              }}
                            >
                              {item.size}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Card Body */}
                      <div
                        style={{
                          padding: '10px 10px 12px',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '8px',
                          flex: 1,
                          justifyContent: 'space-between'
                        }}
                      >
                        <div>
                          <div
                            style={{
                              fontSize: '13px',
                              fontWeight: 700,
                              color: 'var(--text-primary)',
                              lineHeight: '1.3',
                              display: '-webkit-box',
                              WebkitLineClamp: 2,
                              WebkitBoxOrient: 'vertical',
                              overflow: 'hidden',
                              cursor: 'pointer'
                            }}
                            title={item.title}
                            onClick={() => setSelectedItem(item)}
                          >
                            {item.cleanTitle || item.title}
                          </div>

                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              marginTop: '5px',
                              fontSize: '11px',
                              color: 'var(--text-muted)'
                            }}
                          >
                            <span style={{ maxWidth: '90px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {item.feedName || 'Feed'}
                            </span>
                            {item.pubDate && <span>{formatRelativeTime(item.pubDate)}</span>}
                          </div>
                        </div>

                        {/* Action Row */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '5px', marginTop: '2px' }}>
                          {/* Play / Stream Button */}
                          <button
                            className="action-btn"
                            onClick={(e) => handleStreamItem(item, e)}
                            disabled={isStreaming}
                            title={isStreaming ? 'Connecting to torrent stream...' : 'Stream this torrent now'}
                            style={{
                              flex: 1,
                              minWidth: 0,
                              padding: '7px 6px',
                              fontSize: '11.5px',
                              fontWeight: 700,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              gap: '4px',
                              borderRadius: '7px',
                              background: isStreaming ? 'rgba(59, 130, 246, 0.25)' : 'var(--primary)',
                              color: isStreaming ? '#60a5fa' : '#000',
                              border: isStreaming ? '1px solid rgba(59, 130, 246, 0.4)' : 'none',
                              cursor: isStreaming ? 'wait' : 'pointer',
                              transition: 'all 0.15s ease'
                            }}
                          >
                            {isStreaming ? (
                              <>
                                <RefreshCw size={12} className="spin" />
                              </>
                            ) : (
                              <>
                                <Play size={12} fill="#000" />
                              </>
                            )}
                          </button>

                          {/* 1-Click Download Button */}
                          {(() => {
                            const cardFolder = item.type === 'tv' ? folders?.tv : folders?.movies;
                            const isFolderReadOnly = cardFolder?.canAddChildren === false;
                            return (
                              <button
                                className="action-btn"
                                onClick={(e) => handleDownloadItem(item, e)}
                                disabled={isQueuing || isQueued || isFolderReadOnly}
                                title={isFolderReadOnly ? 'Target Google Drive folder is view-only (downloads disabled)' : (isQueued ? 'Added to Download Queue' : 'Queue download to Google Drive')}
                                style={{
                                  flex: 1,
                                  minWidth: 0,
                                  padding: '7px 6px',
                                  fontSize: '11.5px',
                                  fontWeight: 700,
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  gap: '4px',
                                  borderRadius: '7px',
                                  background: isFolderReadOnly ? 'rgba(255, 255, 255, 0.03)' : (isQueued ? 'rgba(34, 197, 94, 0.2)' : 'rgba(255, 255, 255, 0.06)'),
                                  color: isFolderReadOnly ? 'var(--text-muted)' : (isQueued ? '#4ade80' : 'var(--text-primary)'),
                                  border: isFolderReadOnly ? '1px solid rgba(255, 255, 255, 0.08)' : (isQueued ? '1px solid rgba(34, 197, 94, 0.4)' : '1px solid var(--border-color)'),
                                  cursor: isFolderReadOnly ? 'not-allowed' : (isQueued ? 'default' : 'pointer'),
                                  opacity: isFolderReadOnly ? 0.6 : 1,
                                  transition: 'all 0.15s ease'
                                }}
                              >
                                {isFolderReadOnly ? (
                                  <>
                                    <Download size={12} style={{ opacity: 0.5 }} />
                                  </>
                                ) : isQueuing ? (
                                  <>
                                    <RefreshCw size={12} className="spin" />
                                  </>
                                ) : isQueued ? (
                                  <>
                                    <Check size={12} />
                                  </>
                                ) : (
                                  <>
                                    <Download size={12} />
                                  </>
                                )}
                              </button>
                            );
                          })()}

                          {/* Quick Wish List Button */}
                          <button
                            className="action-btn"
                            onClick={(e) => handleQuickAddWishlist(item, e)}
                            title={inWishlist ? 'Already in your Wish List' : 'Add to Wish List (Auto-download future releases)'}
                            style={{
                              padding: '7px 8px',
                              borderRadius: '7px',
                              background: inWishlist ? 'rgba(168, 85, 247, 0.2)' : 'rgba(255, 255, 255, 0.05)',
                              border: `1px solid ${inWishlist ? 'rgba(168, 85, 247, 0.4)' : 'var(--border-color)'}`,
                              color: inWishlist ? '#d8b4fe' : 'var(--text-secondary)',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              cursor: 'pointer',
                              flexShrink: 0
                            }}
                          >
                            <Sparkles size={13} fill={inWishlist ? '#d8b4fe' : 'none'} />
                          </button>

                          {/* Info / Detail Button */}
                          <button
                            className="action-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedItem(item);
                            }}
                            title="View release details"
                            style={{
                              padding: '7px 8px',
                              borderRadius: '7px',
                              background: 'rgba(255, 255, 255, 0.05)',
                              border: '1px solid var(--border-color)',
                              color: 'var(--text-secondary)',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              flexShrink: 0
                            }}
                          >
                            <Info size={14} />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Load More Button */}
              {filteredItems.length > visibleCount && (
                <div style={{ textAlign: 'center', marginTop: '16px' }}>
                  <button
                    className="action-btn"
                    onClick={() => setVisibleCount(prev => prev + 30)}
                    style={{ padding: '10px 24px', fontSize: '13px', fontWeight: 600 }}
                  >
                    Load More Releases ({filteredItems.length - visibleCount} remaining)
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* ========================================================= */}
      {/* MODAL: Release Detail Modal                                */}
      {/* ========================================================= */}
      {selectedItem && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.75)',
            backdropFilter: 'blur(8px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
            padding: '20px'
          }}
          onClick={() => setSelectedItem(null)}
        >
          <div
            className="glass-panel"
            style={{
              width: '100%',
              maxWidth: '560px',
              borderRadius: '16px',
              border: '1px solid rgba(255, 255, 255, 0.12)',
              background: '#121218',
              padding: '24px',
              display: 'flex',
              flexDirection: 'column',
              gap: '18px',
              boxShadow: '0 20px 50px rgba(0,0,0,0.7)',
              position: 'relative',
              maxHeight: '90vh',
              overflowY: 'auto'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                <span
                  style={{
                    fontSize: '11px',
                    fontWeight: 800,
                    textTransform: 'uppercase',
                    padding: '2px 8px',
                    borderRadius: '5px',
                    background: selectedItem.type === 'tv' ? 'rgba(37, 99, 235, 0.85)' : 'rgba(147, 51, 234, 0.85)',
                    color: '#fff'
                  }}
                >
                  {selectedItem.type === 'tv' ? 'TV Show' : 'Movie'}
                </span>
                {selectedItem.quality && (
                  <span
                    style={{
                      fontSize: '11px',
                      fontWeight: 700,
                      padding: '2px 7px',
                      borderRadius: '5px',
                      background: 'rgba(250, 204, 21, 0.15)',
                      color: '#facc15',
                      border: '1px solid rgba(250, 204, 21, 0.3)'
                    }}
                  >
                    {selectedItem.quality.toUpperCase()}
                  </span>
                )}
                {selectedItem.season && selectedItem.episode && (
                  <span
                    style={{
                      fontSize: '11.5px',
                      fontWeight: 800,
                      color: 'var(--primary)',
                      background: 'rgba(234, 179, 8, 0.12)',
                      padding: '2px 8px',
                      borderRadius: '5px'
                    }}
                  >
                    Season {selectedItem.season}, Episode {selectedItem.episode}
                  </span>
                )}
              </div>
              <button
                onClick={() => setSelectedItem(null)}
                style={{
                  background: 'rgba(255, 255, 255, 0.08)',
                  border: 'none',
                  borderRadius: '50%',
                  width: '30px',
                  height: '30px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  color: 'var(--text-secondary)'
                }}
              >
                <X size={16} />
              </button>
            </div>

            {/* Title & Preview */}
            <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start' }}>
              {selectedItem.poster && (
                <div
                  style={{
                    width: '70px',
                    aspectRatio: '2/3',
                    borderRadius: '8px',
                    overflow: 'hidden',
                    flexShrink: 0,
                    background: '#1f1f28'
                  }}
                >
                  <img
                    src={selectedItem.poster}
                    alt={selectedItem.title}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                </div>
              )}
              <div style={{ minWidth: 0, flex: 1 }}>
                <h2 style={{ fontSize: '17px', fontWeight: 800, margin: '0 0 6px', color: 'var(--text-primary)', lineHeight: '1.3' }}>
                  {selectedItem.cleanTitle || selectedItem.title}
                </h2>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)', wordBreak: 'break-all', lineHeight: '1.4' }}>
                  {selectedItem.title}
                </div>
              </div>
            </div>

            {/* Metadata Table */}
            <div
              style={{
                background: 'rgba(255, 255, 255, 0.03)',
                border: '1px solid rgba(255, 255, 255, 0.06)',
                borderRadius: '10px',
                padding: '12px 14px',
                display: 'grid',
                gridTemplateColumns: 'repeat(2, 1fr)',
                gap: '10px',
                fontSize: '12px'
              }}
            >
              <div>
                <span style={{ color: 'var(--text-muted)' }}>Feed: </span>
                <strong style={{ color: 'var(--text-primary)' }}>{selectedItem.feedName}</strong>
              </div>
              <div>
                <span style={{ color: 'var(--text-muted)' }}>Size: </span>
                <strong style={{ color: 'var(--text-primary)' }}>{selectedItem.size || 'Unknown'}</strong>
              </div>
              <div>
                <span style={{ color: 'var(--text-muted)' }}>Published: </span>
                <strong style={{ color: 'var(--text-primary)' }}>
                  {selectedItem.pubDate ? new Date(selectedItem.pubDate).toLocaleString() : 'Recent'}
                </strong>
              </div>
              <div>
                <span style={{ color: 'var(--text-muted)' }}>Target Folder: </span>
                <strong style={{ color: 'var(--text-primary)' }}>
                  {selectedItem.type === 'tv' ? (folders?.tv?.name || 'TV Folder') : (folders?.movies?.name || 'Movies Folder')}
                  {(selectedItem.type === 'tv' ? folders?.tv : folders?.movies)?.canAddChildren === false && (
                    <span style={{ color: '#fbbf24', fontSize: '11px', marginLeft: '6px', fontWeight: 600 }}>
                      (View-Only)
                    </span>
                  )}
                </strong>
              </div>
            </div>

            {selectedItem.description && (
              <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)', lineHeight: '1.5', maxHeight: '100px', overflowY: 'auto' }}>
                {selectedItem.description}
              </div>
            )}

            {/* Actions */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '10px', marginTop: '6px', flexWrap: 'wrap' }}>
              <button
                className="action-btn"
                onClick={(e) => {
                  handleQuickAddWishlist(selectedItem, e);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  fontSize: '12.5px',
                  padding: '8px 14px',
                  borderRadius: '8px',
                  background: 'rgba(168, 85, 247, 0.15)',
                  color: '#d8b4fe',
                  borderColor: 'rgba(168, 85, 247, 0.3)'
                }}
              >
                <Sparkles size={13} />
                <span>Add to Wish List</span>
              </button>

              {selectedItem.magnet && (
                <button
                  className="action-btn"
                  onClick={(e) => copyMagnet(selectedItem.magnet, e)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    fontSize: '12.5px',
                    padding: '8px 14px',
                    borderRadius: '8px',
                    background: 'rgba(255, 255, 255, 0.06)'
                  }}
                >
                  <Copy size={13} />
                  <span>Copy Magnet</span>
                </button>
              )}

              {/* Play / Stream Button */}
              {(() => {
                const selectedKey = getItemKey(selectedItem);
                const isSelectedStreaming = streamingItems[selectedKey];
                return (
                  <button
                    className="action-btn"
                    onClick={(e) => handleStreamItem(selectedItem, e)}
                    disabled={isSelectedStreaming}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      fontSize: '13px',
                      fontWeight: 700,
                      padding: '9px 18px',
                      borderRadius: '8px',
                      background: isSelectedStreaming ? 'rgba(59, 130, 246, 0.25)' : 'var(--primary)',
                      color: isSelectedStreaming ? '#60a5fa' : '#000',
                      border: isSelectedStreaming ? '1px solid rgba(59, 130, 246, 0.4)' : 'none',
                      cursor: isSelectedStreaming ? 'wait' : 'pointer',
                      transition: 'all 0.15s ease'
                    }}
                  >
                    {isSelectedStreaming ? (
                      <>
                        <RefreshCw size={14} className="spin" />
                        <span>Connecting...</span>
                      </>
                    ) : (
                      <>
                        <Play size={14} fill="#000" />
                        <span>Stream Torrent</span>
                      </>
                    )}
                  </button>
                );
              })()}

              {(() => {
                const selectedKey = getItemKey(selectedItem);
                const isSelectedQueued = queuedItems[selectedKey];
                const isSelectedQueuing = queuingItems[selectedKey];
                const detailFolder = selectedItem.type === 'tv' ? folders?.tv : folders?.movies;
                const isDetailFolderReadOnly = detailFolder?.canAddChildren === false;

                if (isDetailFolderReadOnly) {
                  return (
                    <button
                      className="action-btn"
                      disabled
                      title="Target Google Drive folder is view-only (downloads disabled)"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        fontSize: '13px',
                        fontWeight: 700,
                        padding: '9px 20px',
                        borderRadius: '8px',
                        background: 'rgba(255, 255, 255, 0.04)',
                        color: 'var(--text-muted)',
                        border: '1px solid rgba(255, 255, 255, 0.08)',
                        cursor: 'not-allowed',
                        opacity: 0.6
                      }}
                    >
                      <Download size={14} style={{ opacity: 0.5 }} />
                      <span>Folder is View-Only</span>
                    </button>
                  );
                }

                return (
                  <button
                    className="action-btn"
                    onClick={(e) => {
                      handleDownloadItem(selectedItem, e);
                      setSelectedItem(null);
                    }}
                    disabled={isSelectedQueuing || isSelectedQueued}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      fontSize: '13px',
                      fontWeight: 700,
                      padding: '9px 20px',
                      borderRadius: '8px',
                      background: isSelectedQueued ? 'rgba(34, 197, 94, 0.2)' : 'rgba(255, 255, 255, 0.08)',
                      color: isSelectedQueued ? '#4ade80' : 'var(--text-primary)',
                      border: isSelectedQueued ? '1px solid rgba(34, 197, 94, 0.4)' : '1px solid var(--border-color)',
                      cursor: isSelectedQueued ? 'default' : 'pointer'
                    }}
                  >
                    {isSelectedQueuing ? (
                      <>
                        <RefreshCw size={13} className="spin" />
                        <span>Adding...</span>
                      </>
                    ) : isSelectedQueued ? (
                      <>
                        <Check size={14} />
                        <span>Queued in Loader ✓</span>
                      </>
                    ) : (
                      <>
                        <Download size={14} />
                        <span>Download to Drive</span>
                      </>
                    )}
                  </button>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* ========================================================= */}
      {/* MODAL: Add / Edit Wish List Item                          */}
      {/* ========================================================= */}
      {isAddModalOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.75)',
            backdropFilter: 'blur(8px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10000,
            padding: '20px'
          }}
          onClick={() => setIsAddModalOpen(false)}
        >
          <div
            className="glass-panel"
            style={{
              width: '100%',
              maxWidth: '520px',
              borderRadius: '16px',
              border: '1px solid rgba(255, 255, 255, 0.12)',
              background: '#121218',
              padding: '24px',
              display: 'flex',
              flexDirection: 'column',
              gap: '18px',
              boxShadow: '0 20px 50px rgba(0,0,0,0.8)'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div style={{ background: 'rgba(168, 85, 247, 0.15)', color: '#c084fc', padding: '8px', borderRadius: '8px' }}>
                  <Sparkles size={20} />
                </div>
                <div>
                  <h3 style={{ fontSize: '17px', fontWeight: 800, margin: 0, color: 'var(--text-primary)' }}>
                    {editingItem ? 'Edit Wish List Item' : 'Add to Wish List'}
                  </h3>
                  <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                    Feeds will be monitored every {wishlistSettings.intervalMinutes || 30} minutes.
                  </div>
                </div>
              </div>
              <button
                onClick={() => setIsAddModalOpen(false)}
                style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '4px' }}
              >
                <X size={18} />
              </button>
            </div>

            <form onSubmit={handleSaveWishForm} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {/* Type Selection */}
              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                  Media Type
                </label>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                  <button
                    type="button"
                    onClick={() => setFormType('tv')}
                    style={{
                      padding: '10px',
                      borderRadius: '8px',
                      border: '1px solid',
                      borderColor: formType === 'tv' ? '#3b82f6' : 'var(--border-color)',
                      background: formType === 'tv' ? 'rgba(59, 130, 246, 0.15)' : 'rgba(0,0,0,0.3)',
                      color: formType === 'tv' ? '#93c5fd' : 'var(--text-secondary)',
                      fontWeight: 700,
                      fontSize: '13px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '8px',
                      cursor: 'pointer'
                    }}
                  >
                    <Tv size={16} />
                    <span>TV Show</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setFormType('movie')}
                    style={{
                      padding: '10px',
                      borderRadius: '8px',
                      border: '1px solid',
                      borderColor: formType === 'movie' ? '#a855f7' : 'var(--border-color)',
                      background: formType === 'movie' ? 'rgba(168, 85, 247, 0.15)' : 'rgba(0,0,0,0.3)',
                      color: formType === 'movie' ? '#d8b4fe' : 'var(--text-secondary)',
                      fontWeight: 700,
                      fontSize: '13px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '8px',
                      cursor: 'pointer'
                    }}
                  >
                    <Film size={16} />
                    <span>Movie</span>
                  </button>
                </div>
              </div>

              {/* Title Input */}
              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                  {formType === 'tv' ? 'Show Name' : 'Movie Title'}
                </label>
                <input
                  type="text"
                  placeholder={formType === 'tv' ? 'e.g. Severance, The Bear, Fallout' : 'e.g. Dune Part Two, Deadpool & Wolverine'}
                  value={formTitle}
                  onChange={(e) => setFormTitle(e.target.value)}
                  required
                  style={{
                    width: '100%',
                    background: 'rgba(0, 0, 0, 0.4)',
                    border: '1px solid var(--border-color)',
                    borderRadius: '8px',
                    padding: '10px 12px',
                    color: 'var(--text-primary)',
                    fontSize: '13px',
                    outline: 'none'
                  }}
                />
              </div>

              {/* Quality Preference */}
              <div>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                  Target Resolution / Quality
                </label>
                <select
                  value={formQuality}
                  onChange={(e) => setFormQuality(e.target.value)}
                  style={{
                    width: '100%',
                    background: 'rgba(0, 0, 0, 0.4)',
                    border: '1px solid var(--border-color)',
                    borderRadius: '8px',
                    padding: '9px 12px',
                    color: 'var(--text-primary)',
                    fontSize: '12.5px',
                    outline: 'none'
                  }}
                >
                  <option value="any">Any Quality (Recommended - grabs first available)</option>
                  <option value="1080p">1080p Full HD Only</option>
                  <option value="720p">720p HD Only</option>
                  <option value="2160p">4K / 2160p UHD Only</option>
                </select>
              </div>

              {/* Scope Filters: TV vs Movie */}
              {formType === 'tv' ? (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                      Season (optional)
                    </label>
                    <input
                      type="number"
                      placeholder="All seasons"
                      min="1"
                      value={formSeason}
                      onChange={(e) => setFormSeason(e.target.value)}
                      style={{
                        width: '100%',
                        background: 'rgba(0, 0, 0, 0.4)',
                        border: '1px solid var(--border-color)',
                        borderRadius: '8px',
                        padding: '8px 12px',
                        color: 'var(--text-primary)',
                        fontSize: '12.5px',
                        outline: 'none'
                      }}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                      Episode (optional)
                    </label>
                    <input
                      type="number"
                      placeholder="All episodes"
                      min="1"
                      value={formEpisode}
                      onChange={(e) => setFormEpisode(e.target.value)}
                      style={{
                        width: '100%',
                        background: 'rgba(0, 0, 0, 0.4)',
                        border: '1px solid var(--border-color)',
                        borderRadius: '8px',
                        padding: '8px 12px',
                        color: 'var(--text-primary)',
                        fontSize: '12.5px',
                        outline: 'none'
                      }}
                    />
                  </div>
                </div>
              ) : (
                <div>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                    Release Year (optional)
                  </label>
                  <input
                    type="number"
                    placeholder="e.g. 2024"
                    min="1900"
                    max="2099"
                    value={formYear}
                    onChange={(e) => setFormYear(e.target.value)}
                    style={{
                      width: '100%',
                      background: 'rgba(0, 0, 0, 0.4)',
                      border: '1px solid var(--border-color)',
                      borderRadius: '8px',
                      padding: '8px 12px',
                      color: 'var(--text-primary)',
                      fontSize: '12.5px',
                      outline: 'none'
                    }}
                  />
                </div>
              )}

              {/* Auto Download Option */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', paddingTop: '4px' }}>
                <input
                  type="checkbox"
                  id="autoDownloadCheck"
                  checked={formAutoDownload}
                  onChange={(e) => setFormAutoDownload(e.target.checked)}
                  style={{ cursor: 'pointer', accentColor: 'var(--primary)', width: '16px', height: '16px' }}
                />
                <label htmlFor="autoDownloadCheck" style={{ fontSize: '12.5px', color: 'var(--text-primary)', cursor: 'pointer' }}>
                  Automatically download, transcode, and upload to Google Drive
                </label>
              </div>

              {/* Form Buttons */}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '10px' }}>
                <button
                  type="button"
                  className="action-btn"
                  onClick={() => setIsAddModalOpen(false)}
                  style={{ padding: '8px 16px', fontSize: '12.5px' }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="action-btn primary"
                  disabled={isSavingForm}
                  style={{ padding: '8px 20px', fontSize: '12.5px', fontWeight: 700 }}
                >
                  {isSavingForm ? 'Saving...' : (editingItem ? 'Save Changes' : 'Add to Wish List')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
