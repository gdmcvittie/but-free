import { useState, useEffect } from 'react';
import { api } from './api';

/**
 * Picks one or more playlists to append `items` to.
 *
 * `kind` scopes the list: a book can only be added to an audiobook playlist and a
 * track to a music playlist, so the two never cross.
 */
export default function AddToPlaylistModal({ isOpen, items, kind = 'audiobooks', onClose, notify }) {
  const [playlists, setPlaylists] = useState([]);
  const [selected, setSelected] = useState(null);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await api.playlists(kind);
        if (!cancelled) setPlaylists(Array.isArray(data) ? data : []);
      } catch (err) {
        if (!cancelled) notify('Could not load playlists', err.message, true);
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen, kind, notify]);

  if (!isOpen) return null;

  const itemIds = (Array.isArray(items) ? items : [items]).map((i) => i.id);

  const toggle = (id) => {
    setSelected((prev) => {
      if (!prev) return new Set([id]);
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const commit = async (playlistIds) => {
    if (!playlistIds.length) return;
    setBusy(true);
    try {
      for (const id of playlistIds) {
        await api.addToPlaylist(id, itemIds);
      }
      notify('Added to playlist', `${itemIds.length} item${itemIds.length === 1 ? '' : 's'} added.`);
      onClose();
    } catch (err) {
      notify('Could not update playlist', err.message, true);
    } finally {
      setBusy(false);
    }
  };

  const handleCreateAndAdd = async (event) => {
    event.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const created = await api.createPlaylist(name, kind);
      await api.addToPlaylist(created.id, itemIds);
      setNewName('');
      notify('Playlist created', `"${created.name}" now holds ${itemIds.length} item(s).`);
      onClose();
    } catch (err) {
      notify('Could not create playlist', err.message, true);
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-container narrow" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Add to playlist</h2>
          <button type="button" className="modal-close-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="modal-body">
          <div className="row-list">
            {playlists.length === 0 && (
              <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                No playlists yet. Create one below.
              </p>
            )}
            {playlists.map((playlist) => (
              <div
                key={playlist.id}
                className={`row-item ${selected?.has(playlist.id) ? 'selected' : ''}`}
                onClick={() => toggle(playlist.id)}
              >
                <div className="row-meta">
                  <div className="row-title">{playlist.name}</div>
                  <div className="row-subtitle">{playlist.count} items</div>
                </div>
              </div>
            ))}
          </div>

          <form onSubmit={handleCreateAndAdd} style={{ marginTop: '1.25rem', display: 'flex', gap: '0.5rem' }}>
            <input
              type="text"
              className="input-field"
              placeholder="New playlist name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <button type="submit" className="btn btn-primary" disabled={!newName.trim() || busy}>
              Create
            </button>
          </form>
        </div>

        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => commit(Array.from(selected || []))}
            disabled={busy || !selected?.size}
          >
            {selected?.size ? `Add to ${selected.size}` : 'Select a playlist'}
          </button>
        </div>
      </div>
    </div>
  );
}