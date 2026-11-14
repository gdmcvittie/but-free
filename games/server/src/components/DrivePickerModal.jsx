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
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="glass-modal w-full max-w-xl rounded-sm border border-[#444444] bg-[#222222] overflow-hidden flex flex-col max-h-[85vh] animate-in fade-in duration-150">
        {/* Header */}
        <div className="p-4 border-b border-[#303030] bg-[#1c1c1c] flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-sm bg-[#14283d] text-[#31a8ff]">
              <HardDrive className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-bold text-sm text-white">Select Games Folder</h3>
              <p className="text-[11px] text-slate-400 font-mono">Choose the Google Drive directory where your game ROMs are stored</p>
            </div>
          </div>
          <button onClick={onClose} className="icon-btn icon-btn-sm">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Breadcrumb Navigation */}
        <div className="px-4 py-2 bg-[#191919] border-b border-[#2c2c2c] flex items-center gap-1.5 overflow-x-auto text-xs text-slate-300 font-mono">
          {breadcrumbs.map((crumb, idx) => (
            <React.Fragment key={crumb.id}>
              {idx > 0 && <ChevronRight className="w-3.5 h-3.5 text-slate-600 shrink-0" />}
              <button
                onClick={() => handleBreadcrumbClick(idx)}
                className={`hover:text-[#31a8ff] font-medium truncate max-w-[140px] ${
                  idx === breadcrumbs.length - 1 ? 'text-[#31a8ff] font-semibold' : 'text-slate-400'
                }`}
              >
                {crumb.name}
              </button>
            </React.Fragment>
          ))}
        </div>

        {/* Error Notice */}
        {error && (
          <div className="mx-4 mt-3 p-2.5 rounded-sm bg-[#2a1a1a] border border-red-500/30 text-xs text-red-300 font-mono">
            {error}
          </div>
        )}

        {/* Folder List */}
        <div className="flex-1 overflow-y-auto p-4 space-y-1.5 min-h-[240px]">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-16 gap-2 text-slate-400">
              <Loader2 className="w-5 h-5 animate-spin text-[#31a8ff]" />
              <span className="text-xs font-mono">Querying Drive directories...</span>
            </div>
          ) : folders.length === 0 ? (
            <div className="text-center py-12 text-slate-500 text-xs font-mono">
              No subfolders found in this directory. You can create a "Games" folder below.
            </div>
          ) : (
            folders.map((f) => {
              const isSelected = f.id === currentFolderId;
              return (
                <div
                  key={f.id}
                  className={`flex items-center justify-between p-2.5 rounded-sm border transition-colors ${
                    isSelected
                      ? 'bg-[#14283d] border-[#31a8ff]'
                      : 'bg-[#1c1c1c] hover:bg-[#262626] border-[#303030]'
                  }`}
                >
                  <div
                    onClick={() => handleNavigate(f)}
                    className="flex items-center gap-2.5 flex-1 min-w-0 cursor-pointer group"
                  >
                    <Folder className="w-4 h-4 text-[#31a8ff]" />
                    <span className="text-xs font-medium text-slate-200 group-hover:text-white truncate font-mono">
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
        <div className="p-3.5 bg-[#1a1a1a] border-t border-[#303030] flex flex-col gap-2.5">
          <form onSubmit={handleCreateFolder} className="flex gap-2">
            <input
              type="text"
              placeholder="Create new folder (e.g. Games)..."
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              className="flex-1 px-3 py-1.5 text-xs bg-[#151515] border border-[#383838] rounded-sm text-white placeholder-slate-500 focus:outline-none focus:border-[#31a8ff]"
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
