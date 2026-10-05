import React, { useState, useEffect } from 'react';
import { Folder, ChevronRight, Check, X, RefreshCw, AlertCircle, HardDrive, ArrowLeft, Eye } from 'lucide-react';
import { useToast } from './Toast.jsx';

export default function GoogleDrivePickerModal({ isOpen, onClose, folderType, currentFolder, onSave }) {
  const toast = useToast();
  const [folders, setFolders] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [currentParent, setCurrentParent] = useState({ id: 'root', name: 'My Drive', canAddChildren: true, ownedByMe: true });
  const [history, setHistory] = useState([]);
  const [selectedFolder, setSelectedFolder] = useState(currentFolder || null);

  const fetchFolders = async (parentId = 'root') => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch(`/api/drive/folders?parentId=${encodeURIComponent(parentId)}`);
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to list folders');
      }
      setFolders(data.folders || []);
    } catch (err) {
      console.error('[Drive Picker] Error:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      setCurrentParent({ id: 'root', name: 'My Drive', canAddChildren: true, ownedByMe: true });
      setHistory([]);
      setSelectedFolder(currentFolder || null);
      fetchFolders('root');
    }
  }, [isOpen, currentFolder]);

  const handleNavigateFolder = (folder) => {
    setHistory(prev => [...prev, currentParent]);
    setCurrentParent(folder);
    fetchFolders(folder.id);
  };

  const handleBack = () => {
    if (history.length === 0) return;
    const prev = history[history.length - 1];
    setHistory(h => h.slice(0, h.length - 1));
    setCurrentParent(prev);
    fetchFolders(prev.id);
  };

  const handleSelectCurrent = () => {
    setSelectedFolder(currentParent);
  };

  const handleConfirm = () => {
    if (selectedFolder && onSave) {
      onSave({
        id: selectedFolder.id,
        name: selectedFolder.name,
        canAddChildren: selectedFolder.canAddChildren !== false,
        ownedByMe: selectedFolder.ownedByMe !== false
      });
      onClose();
    }
  };

  if (!isOpen) return null;

  const isCurrentParentReadOnly = currentParent.canAddChildren === false;
  const isSelectedReadOnly = selectedFolder?.canAddChildren === false;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.85)',
        backdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        padding: '16px'
      }}
      onClick={onClose}
    >
      <div
        className="glass-panel"
        style={{
          width: '100%',
          maxWidth: '560px',
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
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(255,255,255,0.02)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{ background: 'rgba(139, 92, 246, 0.15)', padding: '8px', borderRadius: '8px', color: 'var(--primary)' }}>
              <HardDrive size={20} />
            </div>
            <div>
              <h2 style={{ fontSize: '16px', fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>
                Select {folderType === 'tv' ? 'TV Shows' : 'Movies'} Folder
              </h2>
              <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                Browse your Google Drive to pick your media root
              </div>
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
            <X size={18} />
          </button>
        </div>

        {/* Navigation Breadcrumbs */}
        <div style={{ padding: '10px 20px', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', background: 'rgba(255,255,255,0.01)' }}>
          {history.length > 0 && (
            <button
              onClick={handleBack}
              style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'rgba(255,255,255,0.06)', border: '1px solid var(--border-color)', color: 'var(--text-primary)', padding: '3px 8px', borderRadius: '4px', cursor: 'pointer', fontSize: '11px' }}
            >
              <ArrowLeft size={12} /> Back
            </button>
          )}
          <span style={{ color: 'var(--text-secondary)' }}>{currentParent.name}</span>
          {isCurrentParentReadOnly && (
            <span style={{ fontSize: '10px', padding: '1px 5px', borderRadius: '4px', background: 'rgba(245, 158, 11, 0.15)', color: '#fbbf24', border: '1px solid rgba(245, 158, 11, 0.3)', fontWeight: 600 }}>
              View Only
            </span>
          )}
          <button
            onClick={handleSelectCurrent}
            style={{ marginLeft: 'auto', background: selectedFolder?.id === currentParent.id ? 'var(--primary)' : 'rgba(255,255,255,0.06)', color: selectedFolder?.id === currentParent.id ? '#000' : 'var(--text-secondary)', border: '1px solid var(--border-color)', borderRadius: '4px', padding: '3px 8px', fontSize: '11px', fontWeight: 600, cursor: 'pointer' }}
          >
            {selectedFolder?.id === currentParent.id ? '✓ Selected This Folder' : 'Select This Folder'}
          </button>
        </div>

        {/* Folder List */}
        <div style={{ padding: '12px 20px', flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {loading ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '40px 0', gap: '10px' }}>
              <RefreshCw size={24} className="spin" style={{ animation: 'spin 2s linear infinite', color: 'var(--primary)' }} />
              <div style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>Loading Google Drive folders...</div>
            </div>
          ) : error ? (
            <div style={{ textAlign: 'center', padding: '32px 16px', color: 'var(--accent)', fontSize: '13px' }}>
              <AlertCircle size={24} style={{ marginBottom: '8px' }} />
              <div style={{ marginBottom: '14px' }}>{error}</div>
              {(error.toLowerCase().includes('refresh token') || error.toLowerCase().includes('re-authentication') || error.toLowerCase().includes('sign in')) ? (
                <button
                  className="action-btn"
                  onClick={() => { window.location.href = '/auth/google'; }}
                  style={{ background: 'var(--primary)', color: '#fff', border: 'none', padding: '8px 18px', borderRadius: '8px', cursor: 'pointer', fontWeight: 600 }}
                >
                  Sign In with Google
                </button>
              ) : (
                <button className="action-btn" onClick={() => fetchFolders(currentParent.id)}>Retry</button>
              )}
            </div>
          ) : folders.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)', fontSize: '13px' }}>
              No subfolders inside "{currentParent.name}".
            </div>
          ) : (
            folders.map(f => {
              const isSelected = selectedFolder?.id === f.id;
              const isReadOnly = f.canAddChildren === false;
              return (
                <div
                  key={f.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '10px 14px',
                    borderRadius: '8px',
                    background: isSelected ? 'rgba(139, 92, 246, 0.15)' : 'rgba(255, 255, 255, 0.03)',
                    border: isSelected ? '1px solid var(--primary)' : '1px solid var(--border-color)',
                    cursor: 'pointer',
                    transition: 'all 0.2s ease'
                  }}
                  onClick={() => setSelectedFolder(f)}
                  onDoubleClick={() => handleNavigateFolder(f)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
                    <Folder size={18} style={{ color: isSelected ? 'var(--primary)' : (isReadOnly ? '#f59e0b' : '#22d3ee'), flexShrink: 0 }} />
                    <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {f.name}
                    </span>
                    {isReadOnly && (
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
                        fontWeight: 600,
                        flexShrink: 0
                      }}>
                        <Eye size={10} />
                        View Only
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleNavigateFolder(f);
                      }}
                      style={{ padding: '4px 8px', fontSize: '11px', background: 'rgba(255,255,255,0.06)', border: '1px solid var(--border-color)', color: 'var(--text-secondary)', borderRadius: '4px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '2px' }}
                    >
                      Open <ChevronRight size={12} />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* View-Only Folder Notice */}
        {isSelectedReadOnly && (
          <div style={{
            padding: '8px 12px',
            margin: '0 20px 8px',
            borderRadius: '8px',
            background: 'rgba(245, 158, 11, 0.12)',
            border: '1px solid rgba(245, 158, 11, 0.3)',
            color: '#fcd34d',
            fontSize: '11.5px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px'
          }}>
            <AlertCircle size={15} style={{ flexShrink: 0, color: '#f59e0b' }} />
            <span>
              <strong>Shared Folder (View-Only):</strong> You can stream media from this folder, but downloading and auto-saving new torrents will be disabled for it.
            </span>
          </div>
        )}

        {/* Footer */}
        <div style={{ padding: '14px 20px', borderTop: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(255,255,255,0.02)' }}>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
            Selected: <strong style={{ color: selectedFolder ? 'var(--primary)' : 'var(--text-muted)' }}>{selectedFolder?.name || 'None'}</strong>
            {isSelectedReadOnly && (
              <span style={{ marginLeft: '6px', color: '#fbbf24', fontSize: '11px', fontWeight: 600 }}>
                (View-Only)
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button className="action-btn" onClick={onClose} style={{ padding: '6px 14px', fontSize: '12px' }}>
              Cancel
            </button>
            <button
              className="action-btn primary"
              onClick={handleConfirm}
              disabled={!selectedFolder}
              style={{ padding: '6px 16px', fontSize: '12px' }}
            >
              Confirm Folder
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
