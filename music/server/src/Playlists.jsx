import { useState, useEffect, useCallback } from 'react';
import { Plus, Play, Trash2, Pencil, ListMusic, Shuffle, HardDrive, HardDriveDownload } from 'lucide-react';
import { api } from './api';
import MediaCard from './MediaCard';
import AddToPlaylistModal from './AddToPlaylistModal';
import { formatLengthShort, pluralize } from './format';
import {
  getOfflineIds,
  downloadTrack,
  downloadPlaylist,
  removeOfflineTrack,
  removeOfflinePlaylist
} from './offlineStorage';

export default function Playlists({ kind = 'audiobooks', libraryVersion, onPlay, onNavigate, notify }) {
  const [playlists, setPlaylists] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [openItems, setOpenItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [playlistTarget, setPlaylistTarget] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.playlists(kind);
      setPlaylists(Array.isArray(data) ? data : []);
    } catch (err) {
      notify('Could not load playlists', err.message, true);
    } finally {
      setLoading(false);
    }
  }, [kind, notify]);

  useEffect(() => {
    load();
  }, [load, libraryVersion]);

  const handleCreate = async (event) => {
    event.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      await api.createPlaylist(name, kind);
      setNewName('');
      await load();
    } catch (err) {
      notify('Could not create playlist', err.message, true);
    } finally {
      setBusy(false);
    }
  };

  const handleOpen = async (playlist) => {
    if (openId === playlist.id) {
      setOpenId(null);
      setOpenItems([]);
      return;
    }
    try {
      const full = await api.playlist(playlist.id);
      setOpenId(playlist.id);
      setOpenItems(full.items || []);
    } catch (err) {
      notify('Could not open playlist', err.message, true);
    }
  };

  const handleDelete = async (playlist) => {
    setBusy(true);
    try {
      await api.deletePlaylist(playlist.id);
      if (openId === playlist.id) {
        setOpenId(null);
        setOpenItems([]);
      }
      await load();
    } catch (err) {
      notify('Could not delete playlist', err.message, true);
    } finally {
      setBusy(false);
    }
  };

  const handleRename = async (event) => {
    event.preventDefault();
    const name = renameValue.trim();
    if (!name || !renaming) return;
    setBusy(true);
    try {
      await api.renamePlaylist(renaming, name);
      setRenaming(null);
      setRenameValue('');
      await load();
    } catch (err) {
      notify('Could not rename playlist', err.message, true);
    } finally {
      setBusy(false);
    }
  };

  const handleShufflePlay = (items) => {
    if (!Array.isArray(items) || !items.length) return;
    const shuffled = [...items];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    onPlay(shuffled[0], shuffled, { shuffle: true });
  };

  const [offlineIds, setOfflineIds] = useState(new Set());
  const [offlineProgress, setOfflineProgress] = useState(null);

  const refreshOfflineIds = useCallback(async () => {
    const ids = await getOfflineIds();
    setOfflineIds(ids);
  }, []);

  useEffect(() => {
    refreshOfflineIds();
    window.addEventListener('fraudio:offline-changed', refreshOfflineIds);
    return () => window.removeEventListener('fraudio:offline-changed', refreshOfflineIds);
  }, [refreshOfflineIds]);

  const handleCacheOffline = useCallback(async (item) => {
    const isOffline = offlineIds.has(item.id) || Boolean(item.offline);
    try {
      if (isOffline) {
        await removeOfflineTrack(item.id);
        notify('Removed from device', item.title);
      } else {
        notify('Downloading for offline...', item.title);
        await downloadTrack(item, (p) => {
          setOfflineProgress({ title: item.title, percent: p.percent });
        });
        notify('Available offline', `${item.title} downloaded to device.`);
      }
      refreshOfflineIds();
    } catch (err) {
      notify('Download failed', err.message, true);
    } finally {
      setOfflineProgress(null);
    }
  }, [offlineIds, notify, refreshOfflineIds]);

  const handleToggleOfflinePlaylist = useCallback(async (playlist, items) => {
    const allOffline = items.length > 0 && items.every((t) => offlineIds.has(t.id));
    try {
      if (allOffline) {
        await removeOfflinePlaylist(playlist.id);
        notify('Removed from device', `${playlist.name} removed.`);
      } else {
        notify('Downloading playlist...', `Saving ${items.length} tracks to device`);
        await downloadPlaylist(playlist, items, (p) => {
          setOfflineProgress({ title: `${playlist.name} (${p.current}/${p.total})`, percent: p.overallPercent });
        });
        notify('Playlist downloaded', `${playlist.name} is now available offline.`);
      }
      refreshOfflineIds();
    } catch (err) {
      notify('Playlist download failed', err.message, true);
    } finally {
      setOfflineProgress(null);
    }
  }, [offlineIds, notify, refreshOfflineIds]);

  const openTotal = openItems.reduce((sum, i) => sum + (i.durationSec || 0), 0);

  return (
    <>
      <div className="view-header">
        <h1 className="view-title">Playlists</h1>
        <p className="view-subtitle">
          {loading ? 'Loading…' : pluralize(playlists.length, 'playlist')}
        </p>
      </div>

      <form onSubmit={handleCreate} className="toolbar">
        <div className="toolbar-search">
          <input
            type="text"
            className="input-field"
            placeholder="New playlist name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
        </div>
        <button type="submit" className="btn btn-primary" disabled={!newName.trim() || busy}>
          <Plus size={15} />
          Create
        </button>
      </form>

      {!loading && playlists.length === 0 ? (
        <div className="empty-state">
          <ListMusic size={40} style={{ color: 'var(--text-muted)', margin: '0 auto 1rem' }} />
          <h3>No playlists yet</h3>
          <p>Group books and albums together, then play them back-to-back in one queue.</p>
        </div>
      ) : (
        <div className="row-list">
          {playlists.map((playlist) => {
            const isOpen = openId === playlist.id;
            return (
              <div key={playlist.id}>
                <div className="row-item" onClick={() => handleOpen(playlist)}>
                  <div className="row-thumb-placeholder"><ListMusic size={16} /></div>
                  <div className="row-meta">
                    <div className="row-title">{playlist.name}</div>
                    <div className="row-subtitle">{pluralize(playlist.count, 'item')}</div>
                  </div>
                  <div className="row-aside">
                    <button
                      type="button"
                      className="icon-btn"
                      title="Rename"
                      onClick={(e) => {
                        e.stopPropagation();
                        setRenaming(playlist.id);
                        setRenameValue(playlist.name);
                      }}
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      title="Delete playlist"
                      disabled={busy}
                      onClick={(e) => { e.stopPropagation(); handleDelete(playlist); }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>

                {isOpen && (
                  <div style={{ padding: '0.5rem 0 1rem 3.25rem' }}>
                    <div className="toolbar" style={{ marginBottom: '1rem' }}>
                      {openItems.length > 0 && (
                        <>
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            onClick={() => onPlay(openItems[0], openItems, { shuffle: false })}
                          >
                            <Play size={13} fill="currentColor" />
                            Play all
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => handleShufflePlay(openItems)}
                            title="Shuffle and play playlist"
                          >
                            <Shuffle size={13} />
                            Shuffle
                          </button>
                          {(() => {
                            const isPlaylistOffline = openItems.length > 0 && openItems.every((t) => offlineIds.has(t.id));
                            return (
                              <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                onClick={() => handleToggleOfflinePlaylist(playlist, openItems)}
                                title={isPlaylistOffline ? 'Remove playlist from device' : 'Download playlist for offline listening'}
                                style={isPlaylistOffline ? { color: 'var(--success, #22c55e)' } : {}}
                              >
                                {isPlaylistOffline ? <HardDrive size={13} /> : <HardDriveDownload size={13} />}
                                {isPlaylistOffline ? 'Downloaded' : 'Download playlist'}
                              </button>
                            );
                          })()}
                        </>
                      )}
                      <span className="section-count">
                        {pluralize(openItems.length, 'item')}
                        {openTotal > 0 ? ` · ${formatLengthShort(openTotal)}` : ''}
                      </span>
                    </div>

                    {openItems.length === 0 ? (
                      <p style={{ color: 'var(--text-muted)', fontSize: '0.83rem' }}>
                        This playlist is empty. Add items from your library with the{' '}
                        <ListMusic size={12} style={{ verticalAlign: 'middle' }} /> button on any card.
                      </p>
                    ) : (
                      <div className="media-grid dense">
                        {openItems.map((item) => (
                          <MediaCard
                            key={item.id}
                            item={{ ...item, offline: offlineIds.has(item.id) || Boolean(item.offline), coverUrl: item.coverUrl || api.coverUrl(item.id) }}
                            context={openItems}
                            onPlay={onPlay}
                            onCacheOffline={handleCacheOffline}
                            onAddToPlaylist={setPlaylistTarget}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {renaming === playlist.id && (
                  <form onSubmit={handleRename} className="toolbar" style={{ padding: '0 0 1rem 3.25rem', marginBottom: 0 }}>
                    <div className="toolbar-search">
                      <input
                        type="text"
                        className="input-field"
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        autoFocus
                      />
                    </div>
                    <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !renameValue.trim()}>Save</button>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => setRenaming(null)}>Cancel</button>
                  </form>
                )}
              </div>
            );
          })}
        </div>
      )}

      {openItems.length === 0 && (
        <p style={{ marginTop: '1.5rem' }}>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => onNavigate('library')}>
            Go to library
          </button>
        </p>
      )}

      <AddToPlaylistModal
        isOpen={Boolean(playlistTarget)}
        items={playlistTarget ? [playlistTarget] : []}
        kind={kind}
        onClose={() => setPlaylistTarget(null)}
        notify={notify}
      />

      {offlineProgress && (
        <div style={{
          position: 'fixed',
          bottom: '5.5rem',
          right: '1.5rem',
          background: 'var(--bg-panel, #18181b)',
          border: '1px solid var(--border-color, #27272a)',
          borderRadius: '12px',
          padding: '0.75rem 1rem',
          boxShadow: '0 8px 30px rgba(0,0,0,0.5)',
          zIndex: 9999,
          minWidth: '260px'
        }}>
          <div style={{ fontSize: '0.82rem', fontWeight: 600, marginBottom: '0.4rem', color: 'var(--text-bright, #fff)' }}>
            {offlineProgress.title}
          </div>
          <div className="media-progress" style={{ height: '4px', margin: 0 }}>
            <div className="media-progress-fill" style={{ width: `${offlineProgress.percent}%` }} />
          </div>
        </div>
      )}
    </>
  );
}