import { useState, useEffect } from 'react';
import { FolderOpen, FolderPlus, ChevronRight } from 'lucide-react';
import { api } from './api';

/**
 * Google Drive folder browser.
 *
 * Walks down the folder tree with a breadcrumb stack, lets you create a folder
 * inline, then commits the choice with POST /api/drive/select-folder for the
 * given kind ('audiobooks' | 'music').
 */
export default function DrivePickerModal({
  isOpen,
  kind,
  currentFolderId,
  currentFolderName,
  onFolderSelected,
  onClose
}) {
  const [folders, setFolders] = useState([]);
  const [breadcrumbs, setBreadcrumbs] = useState([{ id: 'root', name: 'My Drive' }]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState({ id: currentFolderId || 'root', name: currentFolderName || 'My Drive' });
  const [creating, setCreating] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [saving, setSaving] = useState(false);

  const activeFolder = breadcrumbs[breadcrumbs.length - 1];

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setSelected({ id: currentFolderId || 'root', name: currentFolderName || 'My Drive' });
    let cancelled = false;

    (async () => {
      setLoading(true);
      try {
        const data = await api.listFolders(activeFolder.id);
        if (!cancelled) setFolders(Array.isArray(data) ? data : []);
      } catch (err) {
        if (!cancelled) setError(err.message || 'Could not load folders from Google Drive.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [isOpen, activeFolder.id, currentFolderId, currentFolderName]);

  const navigateInto = (folder) => {
    setBreadcrumbs((prev) => [...prev, { id: folder.id, name: folder.name }]);
  };

  const navigateToCrumb = (index) => {
    setBreadcrumbs((prev) => prev.slice(0, index + 1));
  };

  const handleCreateFolder = async (event) => {
    event.preventDefault();
    const name = newFolderName.trim();
    if (!name) return;

    setLoading(true);
    setError(null);
    try {
      const created = await api.createFolder(name, activeFolder.id);
      setFolders((prev) => [created, ...prev]);
      setNewFolderName('');
      setCreating(false);
    } catch (err) {
      setError(err.message || 'Could not create the folder.');
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.selectFolder(kind, selected.id, selected.name);
      onFolderSelected(kind, selected.id, selected.name);
      onClose();
    } catch (err) {
      setError(err?.message || 'Could not save the folder selection.');
    } finally {
      // Always release the button. Leaving `saving` set on the success path
      // strands the modal on "Saving…" and blocks every later folder change.
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  const label = kind === 'music' ? 'Music' : 'Audiobooks';

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-container" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <FolderOpen size={18} />
            <h2>Select your {label} folder</h2>
          </div>
          <button type="button" className="modal-close-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="modal-body">
          {error && <div className="error-banner">{error}</div>}

          <nav className="drive-breadcrumbs" aria-label="Folder path">
            {breadcrumbs.map((crumb, index) => {
              const isLast = index === breadcrumbs.length - 1;
              return (
                <span key={`${crumb.id}_${index}`} className="drive-breadcrumb-item">
                  {index > 0 && <span className="drive-breadcrumb-separator">/</span>}
                  {isLast ? (
                    <span className="drive-breadcrumb-current">{crumb.name}</span>
                  ) : (
                    <button type="button" className="drive-breadcrumb-link" onClick={() => navigateToCrumb(index)}>
                      {crumb.name}
                    </button>
                  )}
                </span>
              );
            })}
          </nav>

          <div className="drive-toolbar">
            {creating ? (
              <form onSubmit={handleCreateFolder} className="drive-new-folder-form">
                <input
                  type="text"
                  className="input-field drive-new-folder-input"
                  placeholder="New folder name"
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  autoFocus
                />
                <button type="submit" className="btn btn-primary btn-sm" disabled={!newFolderName.trim()}>Create</button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setCreating(false)}>Cancel</button>
              </form>
            ) : (
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setCreating(true)}>
                <FolderPlus size={14} />
                New folder
              </button>
            )}
          </div>

          <div className="drive-folder-list-container">
            {loading ? (
              <div className="drive-loading-state">
                <div className="spinner" style={{ margin: '0 auto 1rem' }} />
                <p>Loading folders…</p>
              </div>
            ) : folders.length === 0 ? (
              <div className="drive-empty-state">
                <p>No subfolders here.</p>
                <p style={{ fontSize: '0.8rem' }}>
                  You can pick this folder as-is, or create a new one above.
                </p>
              </div>
            ) : (
              <div className="drive-folder-list">
                {folders.map((folder) => {
                  const isSelected = selected.id === folder.id;
                  const isCurrent = currentFolderId === folder.id;
                  return (
                    <div
                      key={folder.id}
                      className={`drive-folder-item ${isSelected ? 'selected' : ''}`}
                      onClick={() => setSelected({ id: folder.id, name: folder.name })}
                      onDoubleClick={() => navigateInto(folder)}
                    >
                      <div className="drive-folder-left">
                        <FolderOpen size={17} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
                        <div className="drive-folder-name-col">
                          <span className="drive-folder-title">{folder.name}</span>
                          {isCurrent && <span className="badge badge-success">Active</span>}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="btn btn-secondary btn-xs btn-sm"
                        onClick={(e) => { e.stopPropagation(); navigateInto(folder); }}
                        title="Open folder"
                      >
                        Open
                        <ChevronRight size={13} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="drive-selected-summary">
            <span>Selected folder:</span>
            <strong className="drive-selected-value">{selected.name}</strong>
          </div>
        </div>

        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={handleConfirm} disabled={saving || loading}>
            {saving ? 'Saving…' : `Use "${selected.name}"`}
          </button>
        </div>
      </div>
    </div>
  );
}