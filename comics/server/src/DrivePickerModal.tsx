import React, { useState, useEffect } from 'react';
import { Folder, Plus, FolderOpen } from 'lucide-react';
import { apiUrl } from './api';

interface DriveFolder {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  parents?: string[];
}

interface BreadcrumbItem {
  id: string;
  name: string;
}

interface DrivePickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentFolderId?: string | null;
  currentFolderName?: string | null;
  onFolderSelected: (folderId: string, folderName: string) => void;
}

export default function DrivePickerModal({
  isOpen,
  onClose,
  currentFolderId,
  currentFolderName,
  onFolderSelected
}: DrivePickerModalProps) {
  const [folders, setFolders] = useState<DriveFolder[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Breadcrumb navigation stack: [{ id: 'root', name: 'My Drive' }, ...]
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbItem[]>([
    { id: 'root', name: 'My Drive' }
  ]);

  const activeFolder = breadcrumbs[breadcrumbs.length - 1];
  const [selectedFolderId, setSelectedFolderId] = useState<string>(activeFolder?.id || 'root');
  const [selectedFolderName, setSelectedFolderName] = useState<string>(activeFolder?.name || 'My Drive');

  // New folder creation state
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [savingSelection, setSavingSelection] = useState(false);

  useEffect(() => {
    if (isOpen) {
      loadFolders(activeFolder.id);
    }
  }, [isOpen, activeFolder.id]);

  const loadFolders = async (parentId: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(apiUrl(`/api/gdrive/folders?parentId=${encodeURIComponent(parentId)}`));
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }
      const data: DriveFolder[] = await res.json();
      setFolders(Array.isArray(data) ? data : []);
      setSelectedFolderId(parentId);
      setSelectedFolderName(activeFolder.name);
    } catch (err: any) {
      setError(err.message || 'Could not load folders from Google Drive');
    } finally {
      setLoading(false);
    }
  };

  const handleNavigateInto = (folder: DriveFolder) => {
    setBreadcrumbs((prev) => [...prev, { id: folder.id, name: folder.name }]);
    setSelectedFolderId(folder.id);
    setSelectedFolderName(folder.name);
  };

  const handleBreadcrumbClick = (index: number) => {
    setBreadcrumbs((prev) => prev.slice(0, index + 1));
  };

  const handleCreateFolder = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newFolderName.trim();
    if (!name) return;

    setLoading(true);
    setError(null);
    try {
      const res = await fetch(apiUrl('/api/gdrive/folders'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, parentId: activeFolder.id })
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to create folder');
      }
      const createdFolder: DriveFolder = await res.json();
      setFolders((prev) => [createdFolder, ...prev]);
      setSelectedFolderId(createdFolder.id);
      setSelectedFolderName(createdFolder.name);
      setNewFolderName('');
      setIsCreatingFolder(false);
    } catch (err: any) {
      setError(err.message || 'Could not create folder');
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmSelection = async () => {
    setSavingSelection(true);
    setError(null);
    try {
      const res = await fetch(apiUrl('/api/gdrive/select-folder'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          folderId: selectedFolderId,
          folderName: selectedFolderName
        })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to select folder');
      }

      onFolderSelected(selectedFolderId, selectedFolderName);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to save Google Drive folder selection');
    } finally {
      setSavingSelection(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-container drive-picker-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <Folder size={22}/>
            <h2>Select Comic Folder in Google Drive</h2>
          </div>
          <button className="modal-close-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="modal-body">
          {error && <div className="error-banner">{error}</div>}

          {/* Breadcrumb Trail */}
          <nav className="drive-breadcrumbs" aria-label="Breadcrumbs">
            {breadcrumbs.map((crumb, idx) => {
              const isLast = idx === breadcrumbs.length - 1;
              return (
                <span key={crumb.id} className="drive-breadcrumb-item">
                  {idx > 0 && <span className="drive-breadcrumb-separator">/</span>}
                  {isLast ? (
                    <span className="drive-breadcrumb-current">{crumb.name}</span>
                  ) : (
                    <button
                      type="button"
                      className="drive-breadcrumb-link"
                      onClick={() => handleBreadcrumbClick(idx)}
                    >
                      {crumb.name}
                    </button>
                  )}
                </span>
              );
            })}
          </nav>

          {/* New Folder Creation Bar */}
          <div className="drive-toolbar">
            {!isCreatingFolder ? (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setIsCreatingFolder(true)}
              >
                <Plus size={16}/>
                New Folder
              </button>
            ) : (
              <form onSubmit={handleCreateFolder} className="drive-new-folder-form">
                <input
                  type="text"
                  className="input-field drive-new-folder-input"
                  placeholder="Folder name (e.g. Comics)"
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  autoFocus
                />
                <button type="submit" className="btn btn-primary btn-sm" disabled={!newFolderName.trim()}>
                  Create
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setIsCreatingFolder(false)}
                >
                  Cancel
                </button>
              </form>
            )}
          </div>

          {/* Folder List */}
          <div className="drive-folder-list-container">
            {loading ? (
              <div className="drive-loading-state">
                <div className="spinner" />
                <p>Loading folders from Google Drive...</p>
              </div>
            ) : folders.length === 0 ? (
              <div className="drive-empty-state">
                <p>No subfolders found in this directory.</p>
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  You can select this folder as your comic library or create a new "Comics" folder above.
                </p>
              </div>
            ) : (
              <div className="drive-folder-list">
                {folders.map((folder) => {
                  const isSelected = selectedFolderId === folder.id;
                  const isCurrentSaved = currentFolderId === folder.id;
                  return (
                    <div
                      key={folder.id}
                      className={`drive-folder-item ${isSelected ? 'selected' : ''}`}
                      onClick={() => {
                        setSelectedFolderId(folder.id);
                        setSelectedFolderName(folder.name);
                      }}
                      onDoubleClick={() => handleNavigateInto(folder)}
                    >
                      <div className="drive-folder-left">
                        <span className="drive-folder-icon"><FolderOpen size={18}/></span>
                        <div className="drive-folder-name-col">
                          <span className="drive-folder-title">{folder.name}</span>
                          {isCurrentSaved && <span className="badge badge-success">Active Library</span>}
                        </div>
                      </div>

                      <div className="drive-folder-right">
                        <button
                          type="button"
                          className="btn btn-secondary btn-xs"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleNavigateInto(folder);
                          }}
                          title="Open folder to see subfolders"
                        >
                          Open ➔
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Current Selection Summary */}
          <div className="drive-selected-summary">
            <span className="drive-selected-label">Selected Folder:</span>
            <strong className="drive-selected-value">{selectedFolderName}</strong>
          </div>
        </div>

        <div className="modal-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={savingSelection}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleConfirmSelection}
            disabled={savingSelection || loading}
          >
            {savingSelection ? 'Saving & Scanning...' : `Select "${selectedFolderName}"`}
          </button>
        </div>
      </div>
    </div>
  );
}
