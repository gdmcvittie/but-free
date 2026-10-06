import React, { useState, useEffect } from 'react';
import { X, Folder, FolderPlus, ChevronRight, Check, Loader2, HardDrive } from 'lucide-react';
import { fetchJson } from '../utils/api';

export default function DrivePickerModal({ isOpen, onClose, onFolderSelected, currentFolderId }) {
  const [folders, setFolders] = useState([]);
  const [currentParentId, setCurrentParentId] = useState('root');
  const [breadcrumbs, setBreadcrumbs] = useState([{ id: 'root', name: 'My Drive' }]);
  const [loading, setLoading] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (isOpen) {
      loadFolders('root');
    }
  }, [isOpen]);

  const loadFolders = async (parentId) => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchJson(`/api/drive/folders?parentId=${encodeURIComponent(parentId)}`);
      setFolders(data.folders || []);
      setCurrentParentId(parentId);
    } catch (err) {
      setError(err.message || 'Failed to load folders from Google Drive');
    } finally {
      setLoading(false);
    }
  };

  const handleNavigate = (folder) => {
    setBreadcrumbs((prev) => [...prev, { id: folder.id, name: folder.name }]);
    loadFolders(folder.id);
  };

  const handleBreadcrumbClick = (idx) => {
    const target = breadcrumbs[idx];
    setBreadcrumbs((prev) => prev.slice(0, idx + 1));
    loadFolders(target.id);
  };

  const handleCreateFolder = async (e) => {
    e.preventDefault();
    if (!newFolderName.trim()) return;
    setCreating(true);
    try {
      const res = await fetchJson('/api/drive/folders', {
        method: 'POST',
        body: JSON.stringify({ name: newFolderName.trim(), parentId: currentParentId })
      });
      setNewFolderName('');
      loadFolders(currentParentId);
    } catch (err) {
      setError(err.message || 'Failed to create folder');
    } finally {
      setCreating(false);
    }
  };

  const handleSelectCurrent = async (folder) => {
    try {
      await fetchJson('/api/drive/select-folder', {
        method: 'POST',
        body: JSON.stringify({ folderId: folder.id, folderName: folder.name })
      });
      onFolderSelected(folder.id, folder.name);
      onClose();
    } catch (err) {
      setError(err.message || 'Could not select folder');
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
      <div className="glass-modal w-full max-w-xl rounded-2xl overflow-hidden flex flex-col max-h-[85vh] animate-in fade-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="p-5 border-b border-white/10 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-purple-500/20 text-purple-400">
              <HardDrive className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-heading font-bold text-lg text-white">Select Games Folder</h3>
              <p className="text-xs text-slate-400">Choose the Google Drive folder where your game ROMs are stored</p>
            </div>
          </div>
          <button onClick={onClose} className="icon-btn icon-btn-sm">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Breadcrumb Navigation */}
        <div className="px-5 py-3 bg-slate-900/50 border-b border-white/5 flex items-center gap-1.5 overflow-x-auto text-xs text-slate-300">
          {breadcrumbs.map((crumb, idx) => (
            <React.Fragment key={crumb.id}>
              {idx > 0 && <ChevronRight className="w-3.5 h-3.5 text-slate-600 shrink-0" />}
              <button
                onClick={() => handleBreadcrumbClick(idx)}
                className={`hover:text-purple-400 font-medium truncate max-w-[140px] ${
                  idx === breadcrumbs.length - 1 ? 'text-purple-300 font-semibold' : 'text-slate-400'
                }`}
              >
                {crumb.name}
              </button>
            </React.Fragment>
          ))}
        </div>

        {/* Error Notice */}
        {error && (
          <div className="mx-5 mt-3 p-3 rounded-lg bg-red-500/15 border border-red-500/30 text-xs text-red-300">
            {error}
          </div>
        )}

        {/* Folder List */}
        <div className="flex-1 overflow-y-auto p-5 space-y-2 min-h-[260px]">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-slate-400">
              <Loader2 className="w-6 h-6 animate-spin text-purple-400" />
              <span className="text-xs">Loading Google Drive folders...</span>
            </div>
          ) : folders.length === 0 ? (
            <div className="text-center py-12 text-slate-500 text-xs">
              No subfolders found in this directory. You can create a "Games" folder below.
            </div>
          ) : (
            folders.map((f) => {
              const isSelected = f.id === currentFolderId;
              return (
                <div
                  key={f.id}
                  className={`flex items-center justify-between p-3 rounded-xl border transition-all ${
                    isSelected
                      ? 'bg-purple-600/15 border-purple-500/40'
                      : 'bg-slate-900/40 hover:bg-slate-800/50 border-white/5'
                  }`}
                >
                  <div
                    onClick={() => handleNavigate(f)}
                    className="flex items-center gap-3 flex-1 min-w-0 cursor-pointer group"
                  >
                    <Folder className="w-5 h-5 text-purple-400 group-hover:scale-110 transition-transform" />
                    <span className="text-sm font-medium text-slate-200 group-hover:text-white truncate">
                      {f.name}
                    </span>
                  </div>
                  <button
                    onClick={() => handleSelectCurrent(f)}
                    className={isSelected ? 'btn btn-primary btn-xs' : 'btn btn-secondary btn-xs'}
                  >
                    {isSelected ? <Check className="w-3 h-3" /> : null}
                    <span>{isSelected ? 'Active' : 'Select'}</span>
                  </button>
                </div>
              );
            })
          )}
        </div>

        {/* Create New Folder Row & Current Selection */}
        <div className="p-4 bg-slate-950/60 border-t border-white/10 flex flex-col gap-3">
          <form onSubmit={handleCreateFolder} className="flex gap-2">
            <input
              type="text"
              placeholder="Create new folder (e.g. Games)..."
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              className="flex-1 px-3 py-2 text-xs bg-slate-900 border border-white/10 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-purple-500"
            />
            <button
              type="submit"
              disabled={creating || !newFolderName.trim()}
              className="btn btn-secondary btn-sm"
            >
              {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FolderPlus className="w-3.5 h-3.5" />}
              <span>New Folder</span>
            </button>
          </form>

          {currentParentId !== 'root' && (
            <button
              onClick={() => handleSelectCurrent(breadcrumbs[breadcrumbs.length - 1])}
              className="btn btn-primary w-full"
            >
              <Check className="w-4 h-4" />
              <span>Use Current Folder: "{breadcrumbs[breadcrumbs.length - 1]?.name}"</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
