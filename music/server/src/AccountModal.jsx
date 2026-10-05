import { FolderOpen, LogOut, User, Settings as SettingsIcon } from 'lucide-react';

export default function AccountModal({ isOpen, onClose, user, onLogout, onOpenDrivePicker, onOpenSettings }) {
  if (!isOpen) return null;

  const handleOpenSettings = () => {
    onClose();
    onOpenSettings?.();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-container narrow" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Account</h2>
          <button type="button" className="modal-close-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="modal-body">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.9rem', marginBottom: '1.5rem' }}>
            <div className="sidebar-user-avatar" style={{ width: 48, height: 48 }}>
              {user?.avatar ? <img src={user.avatar} alt="" /> : <User size={22} />}
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontWeight: 700 }}>{user?.name}</div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{user?.email}</div>
            </div>
          </div>

          <div className="panel-title">Drive folders</div>

          <div className="setting-row">
            <div>
              <div className="setting-label">Audiobooks</div>
              <div className="setting-help">
                {user?.audiobooksFolderName || 'Not connected yet.'}
              </div>
            </div>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => onOpenDrivePicker('audiobooks')}>
              <FolderOpen size={14} />
              {user?.audiobooksFolderId ? 'Change' : 'Connect'}
            </button>
          </div>

          <div className="setting-row">
            <div>
              <div className="setting-label">Music</div>
              <div className="setting-help">
                {user?.musicFolderName || 'Not connected yet.'}
              </div>
            </div>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => onOpenDrivePicker('music')}>
              <FolderOpen size={14} />
              {user?.musicFolderId ? 'Change' : 'Connect'}
            </button>
          </div>
        </div>

        <div className="modal-footer" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <button type="button" className="btn btn-secondary" onClick={handleOpenSettings}>
            <SettingsIcon size={15} />
            Settings
          </button>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button type="button" className="btn btn-danger" onClick={onLogout}>
              <LogOut size={15} />
              Sign out
            </button>
            <button type="button" className="btn btn-secondary" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    </div>
  );
}