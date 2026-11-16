import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  X,
  Search,
  Check,
  CheckSquare,
  Square,
  User,
  Disc,
  Tag,
  Music,
  Shuffle,
  Trash2,
  ArrowUp,
  ArrowDown,
  Cloud,
  Download,
  ListMusic,
  ChevronDown,
  ChevronRight,
  Layers,
  Sparkles
} from 'lucide-react';
import { api } from './api';
import { formatDuration, formatLengthShort, pluralize } from './format';

export default function PlaylistBuilderModal({
  isOpen,
  initialPlaylist = null,
  kind = 'music',
  onClose,
  onSaved,
  notify
}) {
  const [name, setName] = useState('');
  const [tab, setTab] = useState('artists'); // 'artists' | 'albums' | 'genres' | 'songs'
  const [search, setSearch] = useState('');
  const [libraryItems, setLibraryItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]); // array to maintain order
  const [expandedGroups, setExpandedGroups] = useState(new Set());
  const [saving, setSaving] = useState(false);
  const [syncStatus, setSyncStatus] = useState(null);

  // Initialize or reset when modal opens or playlist changes
  useEffect(() => {
    if (!isOpen) return;

    if (initialPlaylist) {
      setName(initialPlaylist.name || '');
      setSelectedIds(Array.isArray(initialPlaylist.itemIds) ? [...initialPlaylist.itemIds] : []);
    } else {
      setName('');
      setSelectedIds([]);
    }
    setSearch('');
    setSyncStatus(null);

    // Fetch library items
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const data = await api.library(kind);
        if (!cancelled) {
          setLibraryItems(Array.isArray(data) ? data : []);
        }
      } catch (err) {
        if (!cancelled) notify?.('Could not load library', err.message, true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [isOpen, initialPlaylist, kind, notify]);

  // Map of all items by ID for fast lookup
  const itemsById = useMemo(() => {
    const map = new Map();
    for (const item of libraryItems) {
      map.set(item.id, item);
    }
    return map;
  }, [libraryItems]);

  // Set of selected IDs for O(1) membership check
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  // List of resolved selected track items in order
  const selectedItems = useMemo(() => {
    return selectedIds.map((id) => itemsById.get(id)).filter(Boolean);
  }, [selectedIds, itemsById]);

  // Total runtime and size of selected tracks
  const totalDuration = useMemo(() => {
    return selectedItems.reduce((acc, t) => acc + (t.durationSec || 0), 0);
  }, [selectedItems]);

  // Group library items by Artist
  const artistGroups = useMemo(() => {
    const map = new Map();
    for (const item of libraryItems) {
      const art = item.artist || item.author || 'Unknown Artist';
      if (!map.has(art)) {
        map.set(art, []);
      }
      map.get(art).push(item);
    }
    return Array.from(map.entries())
      .map(([artist, tracks]) => ({
        name: artist,
        tracks,
        trackCount: tracks.length,
        duration: tracks.reduce((sum, t) => sum + (t.durationSec || 0), 0)
      }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }, [libraryItems]);

  // Group library items by Album
  const albumGroups = useMemo(() => {
    const map = new Map();
    for (const item of libraryItems) {
      const album = item.album || 'Unsorted';
      const artist = item.artist || item.author || 'Unknown Artist';
      const key = `${artist}::${album}`;
      if (!map.has(key)) {
        map.set(key, { title: album, artist, coverUrl: item.coverUrl || api.coverUrl(item.id), tracks: [] });
      }
      map.get(key).tracks.push(item);
    }
    return Array.from(map.values())
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
  }, [libraryItems]);

  // Group library items by Genre
  const genreGroups = useMemo(() => {
    const map = new Map();
    for (const item of libraryItems) {
      const raw = item.genre || 'Unspecified';
      const genres = raw.split(/[,/;&]+/).map((g) => g.trim()).filter(Boolean);
      const list = genres.length ? genres : ['Unspecified'];
      for (const g of list) {
        if (!map.has(g)) map.set(g, []);
        map.get(g).push(item);
      }
    }
    return Array.from(map.entries())
      .map(([genre, tracks]) => ({
        name: genre,
        tracks,
        trackCount: tracks.length,
        duration: tracks.reduce((sum, t) => sum + (t.durationSec || 0), 0)
      }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }, [libraryItems]);

  // Filtered Artists
  const filteredArtists = useMemo(() => {
    if (!search.trim()) return artistGroups;
    const q = search.toLowerCase();
    return artistGroups.filter((g) => g.name.toLowerCase().includes(q));
  }, [artistGroups, search]);

  // Filtered Albums
  const filteredAlbums = useMemo(() => {
    if (!search.trim()) return albumGroups;
    const q = search.toLowerCase();
    return albumGroups.filter(
      (a) => a.title.toLowerCase().includes(q) || a.artist.toLowerCase().includes(q)
    );
  }, [albumGroups, search]);

  // Filtered Genres
  const filteredGenres = useMemo(() => {
    if (!search.trim()) return genreGroups;
    const q = search.toLowerCase();
    return genreGroups.filter((g) => g.name.toLowerCase().includes(q));
  }, [genreGroups, search]);

  // Filtered Songs
  const filteredSongs = useMemo(() => {
    if (!search.trim()) return libraryItems;
    const q = search.toLowerCase();
    return libraryItems.filter(
      (t) =>
        (t.title && t.title.toLowerCase().includes(q)) ||
        (t.artist && t.artist.toLowerCase().includes(q)) ||
        (t.album && t.album.toLowerCase().includes(q)) ||
        (t.genre && t.genre.toLowerCase().includes(q))
    );
  }, [libraryItems, search]);

  // Toggle group expansion
  const toggleExpand = (key) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Add / Remove a single track
  const toggleTrack = useCallback((trackId) => {
    setSelectedIds((prev) => {
      if (prev.includes(trackId)) {
        return prev.filter((id) => id !== trackId);
      }
      return [...prev, trackId];
    });
  }, []);

  // Add / Remove a collection of tracks (batch toggle)
  const toggleTracksBatch = useCallback((trackList) => {
    const ids = trackList.map((t) => t.id);
    setSelectedIds((prev) => {
      const prevSet = new Set(prev);
      const allSelected = ids.every((id) => prevSet.has(id));
      if (allSelected) {
        // Deselect all
        const removeSet = new Set(ids);
        return prev.filter((id) => !removeSet.has(id));
      } else {
        // Add only those not already in list
        const toAdd = ids.filter((id) => !prevSet.has(id));
        return [...prev, ...toAdd];
      }
    });
  }, []);

  // Select all filtered items in active tab
  const handleSelectAllFiltered = () => {
    let toSelect = [];
    if (tab === 'artists') {
      toSelect = filteredArtists.flatMap((a) => a.tracks);
    } else if (tab === 'albums') {
      toSelect = filteredAlbums.flatMap((a) => a.tracks);
    } else if (tab === 'genres') {
      toSelect = filteredGenres.flatMap((g) => g.tracks);
    } else {
      toSelect = filteredSongs;
    }
    const ids = toSelect.map((t) => t.id);
    setSelectedIds((prev) => {
      const prevSet = new Set(prev);
      const toAdd = ids.filter((id) => !prevSet.has(id));
      return [...prev, ...toAdd];
    });
  };

  // Deselect all filtered items in active tab
  const handleDeselectAllFiltered = () => {
    let toDeselect = [];
    if (tab === 'artists') {
      toDeselect = filteredArtists.flatMap((a) => a.tracks);
    } else if (tab === 'albums') {
      toDeselect = filteredAlbums.flatMap((a) => a.tracks);
    } else if (tab === 'genres') {
      toDeselect = filteredGenres.flatMap((g) => g.tracks);
    } else {
      toDeselect = filteredSongs;
    }
    const removeSet = new Set(toDeselect.map((t) => t.id));
    setSelectedIds((prev) => prev.filter((id) => !removeSet.has(id)));
  };

  // Queue actions
  const handleMoveUp = (index) => {
    if (index <= 0) return;
    setSelectedIds((prev) => {
      const next = [...prev];
      [next[index - 1], next[index]] = [next[index], next[index - 1]];
      return next;
    });
  };

  const handleMoveDown = (index) => {
    if (index >= selectedIds.length - 1) return;
    setSelectedIds((prev) => {
      const next = [...prev];
      [next[index + 1], next[index]] = [next[index], next[index + 1]];
      return next;
    });
  };

  const handleRemoveFromQueue = (trackId) => {
    setSelectedIds((prev) => prev.filter((id) => id !== trackId));
  };

  const handleShuffle = () => {
    setSelectedIds((prev) => {
      const next = [...prev];
      for (let i = next.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [next[i], next[j]] = [next[j], next[i]];
      }
      return next;
    });
  };

  const handleClearAll = () => {
    setSelectedIds([]);
  };

  // Save playlist and trigger Google Drive M3U8 sync
  const handleSave = async (e) => {
    e?.preventDefault();
    const cleanName = name.trim();
    if (!cleanName) {
      notify?.('Name required', 'Please provide a playlist name.', true);
      return;
    }
    if (!selectedIds.length) {
      notify?.('No tracks selected', 'Please select at least one song for the playlist.', true);
      return;
    }

    setSaving(true);
    setSyncStatus('Saving and syncing to Google Drive (.m3u8)…');
    try {
      let savedPlaylist = null;
      if (initialPlaylist?.id) {
        // Update existing
        await api.renamePlaylist(initialPlaylist.id, cleanName);
        savedPlaylist = await api.setPlaylistItems(initialPlaylist.id, selectedIds);
      } else {
        // Create new with items
        savedPlaylist = await api.createPlaylist(cleanName, kind, selectedIds);
      }

      // Sync playlist as .m3u8 file directly to Google Drive main music folder
      try {
        await api.syncPlaylistToDrive(savedPlaylist.id);
        notify?.(
          'Playlist saved & synced',
          `"${cleanName}" synced to Google Drive as .m3u8 for Compás Player / HiBy R1.`
        );
      } catch (syncErr) {
        console.warn('[Builder] Drive sync notice:', syncErr.message);
        notify?.('Playlist saved', `"${cleanName}" saved locally. Drive sync will retry.`);
      }

      onSaved?.(savedPlaylist);
      onClose();
    } catch (err) {
      notify?.('Save failed', err.message, true);
    } finally {
      setSaving(false);
      setSyncStatus(null);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" onClick={onClose} style={{ zIndex: 10000 }}>
      <div
        className="modal-container"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '95vw',
          maxWidth: '1050px',
          height: '88vh',
          maxHeight: '900px',
          display: 'flex',
          flexDirection: 'column',
          padding: 0,
          overflow: 'hidden',
          boxShadow: '0 24px 60px rgba(0, 0, 0, 0.7)'
        }}
      >
        {/* Header */}
        <div
          className="modal-header"
          style={{
            padding: '1rem 1.25rem',
            borderBottom: '1px solid var(--border-color)',
            background: 'var(--bg-panel, #18181b)'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
            <div
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '8px',
                background: 'rgba(61, 220, 151, 0.12)',
                color: 'var(--accent, #3ddc97)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              <Sparkles size={18} />
            </div>
            <div>
              <h2 style={{ fontSize: '1.1rem', margin: 0, lineHeight: 1.2 }}>
                {initialPlaylist ? 'Edit Playlist' : 'Fast Playlist Builder'}
              </h2>
              <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                Batch add by artist, album, genre, or song · Auto-syncs to Google Drive (.m3u8) for Compás Player
              </div>
            </div>
          </div>
          <button type="button" className="modal-close-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {/* Name Bar */}
        <div
          style={{
            padding: '0.75rem 1.25rem',
            background: 'rgba(255, 255, 255, 0.02)',
            borderBottom: '1px solid var(--border-color)',
            display: 'flex',
            alignItems: 'center',
            gap: '1rem',
            flexWrap: 'wrap'
          }}
        >
          <div style={{ flex: 1, minWidth: '220px' }}>
            <input
              type="text"
              className="input-field"
              placeholder="Playlist name (e.g. Best of 80s Rock, Workout Beats)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={{ width: '100%', fontSize: '0.92rem', padding: '0.5rem 0.8rem' }}
              autoFocus={!initialPlaylist}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.35rem',
                padding: '0.3rem 0.65rem',
                borderRadius: '999px',
                background: 'rgba(61, 220, 151, 0.1)',
                border: '1px solid rgba(61, 220, 151, 0.25)',
                color: 'var(--accent, #3ddc97)',
                fontSize: '0.75rem',
                fontWeight: 600
              }}
            >
              <Cloud size={12} />
              Compás / HiBy R1 Drive Sync
            </span>
            {initialPlaylist && (
              <a
                href={api.playlistExportUrl(initialPlaylist.id)}
                download={`${name || 'playlist'}.m3u8`}
                className="btn btn-secondary btn-sm"
                title="Download raw .m3u8 file"
                style={{ padding: '0.4rem 0.65rem' }}
              >
                <Download size={13} />
                Export .m3u8
              </a>
            )}
          </div>
        </div>

        {/* Main Body (Split View) */}
        <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
          {/* Left Column: Fast Selection Browser */}
          <div
            style={{
              flex: '1 1 60%',
              minWidth: 0,
              display: 'flex',
              flexDirection: 'column',
              borderRight: '1px solid var(--border-color)'
            }}
          >
            {/* Tabs & Search Toolbar */}
            <div
              style={{
                padding: '0.65rem 1rem',
                borderBottom: '1px solid var(--border-color)',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.5rem',
                background: 'rgba(0, 0, 0, 0.15)'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
                {/* Tabs */}
                <div className="stitcher-mode-tabs" style={{ margin: 0 }}>
                  <button
                    type="button"
                    className={`stitcher-mode-btn ${tab === 'artists' ? 'active' : ''}`}
                    onClick={() => { setTab('artists'); setSearch(''); }}
                  >
                    <User size={13} />
                    Artists ({artistGroups.length})
                  </button>
                  <button
                    type="button"
                    className={`stitcher-mode-btn ${tab === 'albums' ? 'active' : ''}`}
                    onClick={() => { setTab('albums'); setSearch(''); }}
                  >
                    <Disc size={13} />
                    Albums ({albumGroups.length})
                  </button>
                  <button
                    type="button"
                    className={`stitcher-mode-btn ${tab === 'genres' ? 'active' : ''}`}
                    onClick={() => { setTab('genres'); setSearch(''); }}
                  >
                    <Tag size={13} />
                    Genres ({genreGroups.length})
                  </button>
                  <button
                    type="button"
                    className={`stitcher-mode-btn ${tab === 'songs' ? 'active' : ''}`}
                    onClick={() => { setTab('songs'); setSearch(''); }}
                  >
                    <Music size={13} />
                    Songs ({libraryItems.length})
                  </button>
                </div>

                {/* Batch Select / Deselect for active filter */}
                <div style={{ display: 'flex', gap: '0.35rem' }}>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={handleSelectAllFiltered}
                    title="Select all currently filtered items"
                    style={{ fontSize: '0.75rem', padding: '0.3rem 0.55rem' }}
                  >
                    <CheckSquare size={12} />
                    Select Filtered
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={handleDeselectAllFiltered}
                    title="Deselect all currently filtered items"
                    style={{ fontSize: '0.75rem', padding: '0.3rem 0.55rem' }}
                  >
                    <Square size={12} />
                    Deselect
                  </button>
                </div>
              </div>

              {/* Search input */}
              <div className="toolbar-search" style={{ margin: 0, width: '100%' }}>
                <Search size={14} style={{ position: 'absolute', left: '10px', top: '10px', color: 'var(--text-muted)' }} />
                <input
                  type="text"
                  className="input-field"
                  placeholder={`Search ${tab}…`}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  style={{ width: '100%', paddingLeft: '2.2rem', height: '34px', fontSize: '0.84rem' }}
                />
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch('')}
                    style={{
                      position: 'absolute',
                      right: '8px',
                      top: '7px',
                      background: 'transparent',
                      border: 'none',
                      color: 'var(--text-muted)',
                      cursor: 'pointer'
                    }}
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
            </div>

            {/* List / Grid Content */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '0.5rem' }}>
              {loading ? (
                <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>
                  Loading library…
                </div>
              ) : null}

              {/* TAB 1: ARTISTS */}
              {!loading && tab === 'artists' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                  {filteredArtists.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>
                      No artists match &quot;{search}&quot;
                    </div>
                  ) : (
                    filteredArtists.map((artist) => {
                      const isExpanded = expandedGroups.has(artist.name);
                      const selectedCount = artist.tracks.filter((t) => selectedSet.has(t.id)).length;
                      const allSelected = selectedCount === artist.tracks.length;
                      const partialSelected = selectedCount > 0 && !allSelected;

                      return (
                        <div
                          key={artist.name}
                          style={{
                            background: allSelected
                              ? 'rgba(61, 220, 151, 0.08)'
                              : partialSelected
                              ? 'rgba(255, 255, 255, 0.04)'
                              : 'var(--card-bg, #202024)',
                            border: `1px solid ${
                              allSelected
                                ? 'rgba(61, 220, 151, 0.3)'
                                : partialSelected
                                ? 'rgba(255, 255, 255, 0.12)'
                                : 'var(--border-color)'
                            }`,
                            borderRadius: '8px',
                            overflow: 'hidden',
                            transition: 'background 0.15s ease'
                          }}
                        >
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              padding: '0.55rem 0.75rem',
                              cursor: 'pointer',
                              gap: '0.65rem'
                            }}
                            onClick={() => toggleTracksBatch(artist.tracks)}
                          >
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleExpand(artist.name);
                              }}
                              style={{
                                background: 'transparent',
                                border: 'none',
                                color: 'var(--text-muted)',
                                cursor: 'pointer',
                                padding: '2px',
                                display: 'flex'
                              }}
                              title="Expand/collapse songs"
                            >
                              {isExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                            </button>

                            <div
                              style={{
                                width: '20px',
                                height: '20px',
                                borderRadius: '4px',
                                border: allSelected
                                  ? 'none'
                                  : `1px solid ${partialSelected ? 'var(--accent, #3ddc97)' : 'var(--border-color)'}`,
                                background: allSelected
                                  ? 'var(--accent, #3ddc97)'
                                  : partialSelected
                                  ? 'rgba(61, 220, 151, 0.2)'
                                  : 'transparent',
                                color: '#000',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                fontSize: '11px',
                                fontWeight: 'bold'
                              }}
                            >
                              {allSelected && <Check size={14} strokeWidth={3} />}
                              {partialSelected && '—'}
                            </div>

                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontWeight: 600, fontSize: '0.88rem', color: 'var(--text-bright, #fff)' }}>
                                {artist.name}
                              </div>
                              <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>
                                {pluralize(artist.trackCount, 'song')} · {formatLengthShort(artist.duration)}
                                {selectedCount > 0 && (
                                  <span style={{ color: 'var(--accent, #3ddc97)', marginLeft: '6px' }}>
                                    ({selectedCount}/{artist.trackCount} selected)
                                  </span>
                                )}
                              </div>
                            </div>

                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              style={{ fontSize: '0.72rem', padding: '0.2rem 0.5rem' }}
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleTracksBatch(artist.tracks);
                              }}
                            >
                              {allSelected ? 'Remove all' : 'Add all'}
                            </button>
                          </div>

                          {/* Expanded individual tracks list */}
                          {isExpanded && (
                            <div
                              style={{
                                borderTop: '1px solid var(--border-color)',
                                background: 'rgba(0, 0, 0, 0.2)',
                                padding: '0.35rem 0.75rem 0.5rem 2.5rem'
                              }}
                            >
                              {artist.tracks.map((track) => {
                                const isSelected = selectedSet.has(track.id);
                                return (
                                  <div
                                    key={track.id}
                                    onClick={() => toggleTrack(track.id)}
                                    style={{
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: '0.5rem',
                                      padding: '0.35rem 0.5rem',
                                      borderRadius: '4px',
                                      cursor: 'pointer',
                                      background: isSelected ? 'rgba(61, 220, 151, 0.1)' : 'transparent',
                                      fontSize: '0.82rem'
                                    }}
                                  >
                                    <input
                                      type="checkbox"
                                      checked={isSelected}
                                      onChange={() => {}}
                                      style={{ cursor: 'pointer' }}
                                    />
                                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                      {track.title || 'Untitled'}
                                      {track.album && (
                                        <span style={{ color: 'var(--text-muted)', marginLeft: '6px', fontSize: '0.75rem' }}>
                                          · {track.album}
                                        </span>
                                      )}
                                    </span>
                                    <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>
                                      {formatDuration(track.durationSec)}
                                    </span>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              )}

              {/* TAB 2: ALBUMS */}
              {!loading && tab === 'albums' && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '0.65rem' }}>
                  {filteredAlbums.length === 0 ? (
                    <div style={{ gridColumn: '1/-1', textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>
                      No albums match &quot;{search}&quot;
                    </div>
                  ) : (
                    filteredAlbums.map((album) => {
                      const selectedCount = album.tracks.filter((t) => selectedSet.has(t.id)).length;
                      const allSelected = selectedCount === album.tracks.length;
                      const partialSelected = selectedCount > 0 && !allSelected;

                      return (
                        <div
                          key={`${album.artist}-${album.title}`}
                          onClick={() => toggleTracksBatch(album.tracks)}
                          style={{
                            background: allSelected
                              ? 'rgba(61, 220, 151, 0.08)'
                              : 'var(--card-bg, #202024)',
                            border: `1px solid ${
                              allSelected
                                ? 'var(--accent, #3ddc97)'
                                : partialSelected
                                ? 'rgba(61, 220, 151, 0.4)'
                                : 'var(--border-color)'
                            }`,
                            borderRadius: '8px',
                            padding: '0.65rem',
                            cursor: 'pointer',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '0.5rem',
                            position: 'relative',
                            transition: 'all 0.15s ease'
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
                            <div
                              style={{
                                width: '48px',
                                height: '48px',
                                borderRadius: '6px',
                                background: '#111',
                                overflow: 'hidden',
                                flexShrink: 0,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center'
                              }}
                            >
                              {album.coverUrl ? (
                                <img
                                  src={album.coverUrl}
                                  alt=""
                                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                                  loading="lazy"
                                />
                              ) : (
                                <Disc size={24} style={{ color: 'var(--text-muted)' }} />
                              )}
                            </div>

                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div
                                style={{
                                  fontWeight: 600,
                                  fontSize: '0.84rem',
                                  color: 'var(--text-bright, #fff)',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap'
                                }}
                              >
                                {album.title}
                              </div>
                              <div
                                style={{
                                  fontSize: '0.74rem',
                                  color: 'var(--text-muted)',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap'
                                }}
                              >
                                {album.artist}
                              </div>
                              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                                {pluralize(album.tracks.length, 'track')}
                              </div>
                            </div>
                          </div>

                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              paddingTop: '0.35rem',
                              borderTop: '1px solid rgba(255, 255, 255, 0.05)',
                              fontSize: '0.75rem'
                            }}
                          >
                            <span style={{ color: selectedCount > 0 ? 'var(--accent, #3ddc97)' : 'var(--text-muted)' }}>
                              {selectedCount > 0 ? `${selectedCount}/${album.tracks.length} selected` : 'None selected'}
                            </span>
                            <span
                              style={{
                                padding: '2px 8px',
                                borderRadius: '4px',
                                background: allSelected ? 'var(--accent, #3ddc97)' : 'rgba(255, 255, 255, 0.08)',
                                color: allSelected ? '#000' : 'var(--text-bright, #fff)',
                                fontWeight: 600,
                                fontSize: '0.7rem'
                              }}
                            >
                              {allSelected ? '✓ Added' : '+ Add Album'}
                            </span>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              )}

              {/* TAB 3: GENRES */}
              {!loading && tab === 'genres' && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '0.5rem' }}>
                  {filteredGenres.length === 0 ? (
                    <div style={{ gridColumn: '1/-1', textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>
                      No genres match &quot;{search}&quot;
                    </div>
                  ) : (
                    filteredGenres.map((genre) => {
                      const selectedCount = genre.tracks.filter((t) => selectedSet.has(t.id)).length;
                      const allSelected = selectedCount === genre.tracks.length && genre.tracks.length > 0;
                      const partialSelected = selectedCount > 0 && !allSelected;

                      return (
                        <div
                          key={genre.name}
                          onClick={() => toggleTracksBatch(genre.tracks)}
                          style={{
                            background: allSelected
                              ? 'rgba(61, 220, 151, 0.1)'
                              : 'var(--card-bg, #202024)',
                            border: `1px solid ${
                              allSelected
                                ? 'var(--accent, #3ddc97)'
                                : partialSelected
                                ? 'rgba(61, 220, 151, 0.4)'
                                : 'var(--border-color)'
                            }`,
                            borderRadius: '8px',
                            padding: '0.75rem',
                            cursor: 'pointer',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '0.35rem',
                            transition: 'all 0.15s ease'
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <Tag size={15} style={{ color: allSelected ? 'var(--accent, #3ddc97)' : 'var(--text-muted)' }} />
                            <span
                              style={{
                                fontSize: '0.72rem',
                                padding: '1px 6px',
                                borderRadius: '999px',
                                background: allSelected ? 'var(--accent, #3ddc97)' : 'rgba(255, 255, 255, 0.08)',
                                color: allSelected ? '#000' : 'var(--text-muted)',
                                fontWeight: 600
                              }}
                            >
                              {genre.trackCount}
                            </span>
                          </div>

                          <div style={{ fontWeight: 600, fontSize: '0.88rem', color: 'var(--text-bright, #fff)' }}>
                            {genre.name}
                          </div>

                          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                            {formatLengthShort(genre.duration)}
                            {selectedCount > 0 && (
                              <span style={{ color: 'var(--accent, #3ddc97)', marginLeft: '4px' }}>
                                · {selectedCount} added
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              )}

              {/* TAB 4: SONGS */}
              {!loading && tab === 'songs' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  {filteredSongs.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>
                      No songs match &quot;{search}&quot;
                    </div>
                  ) : (
                    filteredSongs.map((track) => {
                      const isSelected = selectedSet.has(track.id);
                      return (
                        <div
                          key={track.id}
                          onClick={() => toggleTrack(track.id)}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.65rem',
                            padding: '0.45rem 0.65rem',
                            borderRadius: '6px',
                            cursor: 'pointer',
                            background: isSelected ? 'rgba(61, 220, 151, 0.09)' : 'transparent',
                            border: `1px solid ${isSelected ? 'rgba(61, 220, 151, 0.25)' : 'transparent'}`,
                            fontSize: '0.82rem',
                            transition: 'background 0.1s ease'
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => {}}
                            style={{ cursor: 'pointer' }}
                          />

                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 500, color: 'var(--text-bright, #fff)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {track.title || 'Untitled'}
                            </div>
                            <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {track.artist || 'Unknown Artist'} {track.album ? `· ${track.album}` : ''}
                            </div>
                          </div>

                          {track.genre && (
                            <span
                              style={{
                                fontSize: '0.7rem',
                                color: 'var(--text-muted)',
                                background: 'rgba(255, 255, 255, 0.05)',
                                padding: '2px 6px',
                                borderRadius: '4px'
                              }}
                            >
                              {track.genre}
                            </span>
                          )}

                          <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem', minWidth: '40px', textAlign: 'right' }}>
                            {formatDuration(track.durationSec)}
                          </span>
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Right Column: Selected Playlist Queue & Reorder Tray */}
          <div
            style={{
              flex: '1 1 40%',
              minWidth: '280px',
              maxWidth: '420px',
              display: 'flex',
              flexDirection: 'column',
              background: 'rgba(0, 0, 0, 0.25)'
            }}
          >
            {/* Queue Header & Actions */}
            <div
              style={{
                padding: '0.75rem 1rem',
                borderBottom: '1px solid var(--border-color)',
                background: 'rgba(0, 0, 0, 0.2)'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.35rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <ListMusic size={16} style={{ color: 'var(--accent, #3ddc97)' }} />
                  <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>Playlist Queue</span>
                </div>
                <span
                  style={{
                    fontSize: '0.78rem',
                    fontWeight: 600,
                    color: 'var(--accent, #3ddc97)',
                    background: 'rgba(61, 220, 151, 0.1)',
                    padding: '2px 8px',
                    borderRadius: '999px'
                  }}
                >
                  {pluralize(selectedIds.length, 'track')}
                </span>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                <span>Total length: {formatLengthShort(totalDuration) || '0m'}</span>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={handleShuffle}
                    disabled={selectedIds.length < 2}
                    title="Shuffle order"
                    style={{ padding: '3px 6px', fontSize: '0.74rem', display: 'flex', alignItems: 'center', gap: '3px' }}
                  >
                    <Shuffle size={12} /> Shuffle
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={handleClearAll}
                    disabled={selectedIds.length === 0}
                    title="Clear queue"
                    style={{ padding: '3px 6px', fontSize: '0.74rem', display: 'flex', alignItems: 'center', gap: '3px' }}
                  >
                    <Trash2 size={12} /> Clear
                  </button>
                </div>
              </div>
            </div>

            {/* Queue Items List */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '0.5rem' }}>
              {selectedItems.length === 0 ? (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    height: '100%',
                    color: 'var(--text-muted)',
                    textAlign: 'center',
                    padding: '1rem'
                  }}
                >
                  <Layers size={36} style={{ opacity: 0.3, marginBottom: '0.75rem' }} />
                  <div style={{ fontWeight: 500, fontSize: '0.85rem' }}>Queue is empty</div>
                  <div style={{ fontSize: '0.75rem', marginTop: '4px' }}>
                    Click an artist, album, genre, or song on the left to add tracks.
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                  {selectedItems.map((track, idx) => (
                    <div
                      key={`${track.id}-${idx}`}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.4rem',
                        padding: '0.35rem 0.5rem',
                        borderRadius: '4px',
                        background: 'rgba(255, 255, 255, 0.03)',
                        fontSize: '0.8rem'
                      }}
                    >
                      <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', width: '22px', textAlign: 'right' }}>
                        {idx + 1}.
                      </span>

                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ color: 'var(--text-bright, #fff)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {track.title || 'Untitled'}
                        </div>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {track.artist || 'Unknown Artist'}
                        </div>
                      </div>

                      <span style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>
                        {formatDuration(track.durationSec)}
                      </span>

                      <div style={{ display: 'flex', gap: '1px' }}>
                        <button
                          type="button"
                          className="icon-btn"
                          disabled={idx === 0}
                          onClick={() => handleMoveUp(idx)}
                          title="Move up"
                          style={{ padding: '2px', opacity: idx === 0 ? 0.3 : 0.8 }}
                        >
                          <ArrowUp size={12} />
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          disabled={idx === selectedItems.length - 1}
                          onClick={() => handleMoveDown(idx)}
                          title="Move down"
                          style={{ padding: '2px', opacity: idx === selectedItems.length - 1 ? 0.3 : 0.8 }}
                        >
                          <ArrowDown size={12} />
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          onClick={() => handleRemoveFromQueue(track.id)}
                          title="Remove from playlist"
                          style={{ padding: '2px', color: 'var(--danger, #ef4444)' }}
                        >
                          <X size={12} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Modal Footer / Save Bar */}
        <div
          style={{
            padding: '0.85rem 1.25rem',
            borderTop: '1px solid var(--border-color)',
            background: 'var(--bg-panel, #18181b)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '1rem'
          }}
        >
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
            {syncStatus ? (
              <span style={{ color: 'var(--accent, #3ddc97)' }}>{syncStatus}</span>
            ) : (
              <span>
                {selectedIds.length > 0
                  ? `${selectedIds.length} tracks will be compiled into an .m3u8 playlist file on Google Drive.`
                  : 'Select tracks to build your playlist.'}
              </span>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleSave}
              disabled={saving || !name.trim() || selectedIds.length === 0}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.45rem',
                fontWeight: 600,
                padding: '0.5rem 1.1rem'
              }}
            >
              <Cloud size={15} />
              {saving ? 'Saving & Syncing…' : 'Save & Sync to Drive (.m3u8)'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
