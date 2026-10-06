import React, { useState } from 'react';
import { User, Folder, RefreshCw, Cloud, Lock } from 'lucide-react';
import { apiUrl } from './api';

export interface GoogleUserProfile {
  id: string;
  name: string;
  email: string;
  avatar?: string;
  driveFolderId?: string | null;
  driveFolderName?: string | null;
}

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  user: GoogleUserProfile | null;
  onLogout: () => void;
  onOpenDrivePicker?: () => void;
  onLibraryUpdated?: () => void;
}

export default function AuthModal({
  isOpen,
  onClose,
  user,
  onLogout,
  onOpenDrivePicker,
  onLibraryUpdated
}: AuthModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanStatus, setScanStatus] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleScan = async () => {
    if (!user?.driveFolderId) {
      if (onOpenDrivePicker) {
        onClose();
        onOpenDrivePicker();
      } else {
        setScanStatus('Please select a Google Drive comic folder first.');
      }
      return;
    }

    setScanning(true);
    setScanStatus('Scanning Google Drive for comics...');
    try {
      const res = await fetch(apiUrl('/api/settings/scan'), { method: 'POST' });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Scan failed');

      setScanStatus(`Scan complete! Found ${data.count || 0} comic(s).`);
      if (onLibraryUpdated) onLibraryUpdated();
      setTimeout(() => setScanStatus(null), 5000);
    } catch (err: any) {
      setScanStatus(`Scan error: ${err.message || 'Failed to scan'}`);
    } finally {
      setScanning(false);
    }
  };

  const handleSignIn = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(apiUrl('/api/auth/google/url'));
      if (!res.ok) throw new Error('Could not initialize Google Sign-In');
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        throw new Error('No authorization URL received');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to start Google sign-in');
      setLoading(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-container auth-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{user ? 'Your Google Account' : 'Sign in to ComixoloFree'}</h2>
          <button className="modal-close-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="modal-body">
          {error && <div className="error-banner">{error}</div>}

          {user ? (
            <div className="auth-profile-card">
              <div className="auth-avatar-wrapper">
                {user.avatar && user.avatar.startsWith('http') ? (
                  <img src={user.avatar} alt={user.name} className="auth-user-avatar-img" />
                ) : (
                  <div className="auth-user-avatar-fallback">{user.avatar || <User size={18}/>}</div>
                )}
              </div>

              <div className="auth-user-details">
                <h3 className="auth-user-name">{user.name}</h3>
                <p className="auth-user-email">{user.email}</p>
              </div>

              <div className="auth-drive-status-badge">
                <span className="drive-icon"><Folder size={18}/></span>
                <div className="drive-text">
                  <span className="drive-label">Google Drive Library:</span>
                  <span className="drive-folder-name">
                    {user.driveFolderName || 'No folder selected'}
                  </span>
                </div>
                {onOpenDrivePicker && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => {
                      onClose();
                      onOpenDrivePicker();
                    }}
                  >
                    Change
                  </button>
                )}
              </div>

              {/* Scan Library Folder Action (especially handy on mobile portrait view) */}
              <div style={{ width: '100%', marginBottom: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <button
                  type="button"
                  className="btn btn-primary btn-block"
                  onClick={handleScan}
                  disabled={scanning}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '0.5rem',
                    padding: '0.65rem 1rem',
                    fontWeight: 600
                  }}
                >
                  <span style={{ display: 'inline-block', animation: scanning ? 'spin 1s linear infinite' : 'none' }}>
                    <RefreshCw size={16}/>
                  </span>
                  <span>{scanning ? 'Scanning Google Drive...' : 'Scan Library Folder'}</span>
                </button>
                {scanStatus && (
                  <div
                    style={{
                      fontSize: '0.82rem',
                      textAlign: 'center',
                      padding: '0.5rem 0.75rem',
                      borderRadius: '8px',
                      background: scanStatus.includes('error') || scanStatus.includes('Failed') || scanStatus.includes('Please')
                        ? 'rgba(239, 68, 68, 0.15)'
                        : 'rgba(52, 211, 153, 0.15)',
                      color: scanStatus.includes('error') || scanStatus.includes('Failed') || scanStatus.includes('Please')
                        ? '#ef4444'
                        : '#34d399',
                      border: `1px solid ${
                        scanStatus.includes('error') || scanStatus.includes('Failed') || scanStatus.includes('Please')
                          ? 'rgba(239, 68, 68, 0.3)'
                          : 'rgba(52, 211, 153, 0.3)'
                      }`
                    }}
                  >
                    {scanStatus}
                  </div>
                )}
              </div>

              <div className="auth-actions">
                <button
                  type="button"
                  className="btn btn-danger btn-block"
                  onClick={onLogout}
                >
                  Sign Out of Google
                </button>
              </div>
            </div>
          ) : (
            <div className="auth-login-prompt">
              <div className="auth-hero-icon"><Cloud size={26}/></div>
              <h3 style={{ margin: '0.5rem 0 0.25rem', fontSize: '1.25rem', fontWeight: 700 }}>
                Read Comics from Your Cloud
              </h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.5, marginBottom: '1.5rem' }}>
                Sign in with your Google account to connect your Google Drive comic library, sync your reading progress across devices, and manage your favorites.
              </p>

              <button
                type="button"
                className="google-sign-in-btn"
                onClick={handleSignIn}
                disabled={loading}
              >
                <svg className="google-icon" viewBox="0 0 24 24" width="20" height="20">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/>
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/>
                </svg>
                <span>{loading ? 'Connecting...' : 'Sign In with Google'}</span>
              </button>

              <div className="auth-privacy-note">
                <Lock size={14}/> We only access the comic folder you select in Google Drive to read and save your comics.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
