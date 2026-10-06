import React, { useState, useEffect } from 'react';
import { Settings, User, Folder, FolderOpen, Loader2, RefreshCw, BookOpen, Cloud, Smartphone, Package } from 'lucide-react';
import { apiUrl } from './api';
import type { GoogleUserProfile } from './AuthModal';

interface UserSettings {
  organizeBySeries?: boolean;
  autoScan?: boolean;
  compressLibrary?: boolean;
  compressionQuality?: number;
  driveFolderId?: string | null;
  driveFolderName?: string | null;
}

interface SettingsViewProps {
  user: GoogleUserProfile | null;
  onOpenAuthModal: () => void;
  onOpenDrivePicker: () => void;
  onLibraryUpdated?: () => void;
  onNavigateToLibrary?: () => void;
}

export default function SettingsView({
  user,
  onOpenAuthModal,
  onOpenDrivePicker,
  onLibraryUpdated,
  onNavigateToLibrary
}: SettingsViewProps) {
  const [organizeBySeries, setOrganizeBySeries] = useState(true);
  const [autoScan, setAutoScan] = useState(true);
  const [compressLibrary, setCompressLibrary] = useState(true);
  const [compressionQuality, setCompressionQuality] = useState(75);
  const [saving, setSaving] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    fetch(apiUrl('/api/settings'))
      .then((res) => res.json())
      .then((data: UserSettings) => {
        if (data.organizeBySeries !== undefined) setOrganizeBySeries(data.organizeBySeries);
        if (data.autoScan !== undefined) setAutoScan(data.autoScan);
        if (data.compressLibrary !== undefined) setCompressLibrary(data.compressLibrary);
        if (data.compressionQuality !== undefined) setCompressionQuality(data.compressionQuality);
      })
      .catch(() => {});
  }, [user?.id]);

  const handleSaveSettings = async (updates: Partial<UserSettings> = {}) => {
    if (!user) return;
    setSaving(true);
    setStatusMessage(null);

    const payload = {
      organizeBySeries: updates.organizeBySeries !== undefined ? updates.organizeBySeries : organizeBySeries,
      autoScan: updates.autoScan !== undefined ? updates.autoScan : autoScan,
      compressLibrary: updates.compressLibrary !== undefined ? updates.compressLibrary : compressLibrary,
      compressionQuality: updates.compressionQuality !== undefined ? updates.compressionQuality : compressionQuality
    };

    try {
      const res = await fetch(apiUrl('/api/settings'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        setStatusMessage('Settings saved successfully.');
        setTimeout(() => setStatusMessage(null), 3500);
      }
    } catch (err: any) {
      setStatusMessage(`Error: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleManualScan = async () => {
    if (!user?.driveFolderId) {
      onOpenDrivePicker();
      return;
    }

    setScanning(true);
    setStatusMessage('Scanning your Google Drive folder for comics...');

    try {
      const res = await fetch(apiUrl('/api/settings/scan'), { method: 'POST' });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Scan failed');

      setStatusMessage(`Scan complete! Found ${data.count || 0} comic(s) in your Google Drive.`);
      if (onLibraryUpdated) onLibraryUpdated();
    } catch (err: any) {
      setStatusMessage(`Scan error: ${err.message}`);
    } finally {
      setScanning(false);
    }
  };

  return (
    <div className="settings-view-container">
      <div className="settings-header">
        <h1><Settings size={16} style={{ marginRight: '0.4rem' }} /> Cloud Settings</h1>
        <p className="settings-subtitle">
          Configure Google Drive integration, account profile, and library preferences.
        </p>
      </div>

      {statusMessage && (
        <div className="info-banner" style={{ marginBottom: '1.5rem' }}>
          {statusMessage}
        </div>
      )}

      <div className="settings-grid">
        {/* Card 1: Google Account Profile */}
        <div className="settings-card">
          <div className="settings-card-header">
            <h3><User size={16} style={{ marginRight: '0.4rem' }} /> Google Account</h3>
          </div>

          <div className="settings-card-body">
            {user ? (
              <div className="settings-profile-info">
                <div className="settings-profile-avatar">
                  {user.avatar && user.avatar.startsWith('http') ? (
                    <img src={user.avatar} alt={user.name} />
                  ) : (
                    <User size={16}/>
                  )}
                </div>
                <div className="settings-profile-meta">
                  <h4>{user.name}</h4>
                  <p>{user.email}</p>
                  <span className="badge badge-success" style={{ marginTop: '0.25rem' }}>
                    Authenticated via Google OAuth
                  </span>
                </div>
              </div>
            ) : (
              <div>
                <p style={{ color: 'var(--text-secondary)', marginBottom: '1rem' }}>
                  You are not currently signed in. Sign in to link your Google Drive comic collection.
                </p>
                <button type="button" className="btn btn-primary" onClick={onOpenAuthModal}>
                  Sign In with Google
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Card 2: Google Drive Comic Folder */}
        <div className="settings-card">
          <div className="settings-card-header">
            <h3><Folder size={16} style={{ marginRight: '0.4rem' }} /> Google Drive Comic Folder</h3>
          </div>

          <div className="settings-card-body">
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '1rem' }}>
              Your comic files (.cbz, .cbr, .zip) are read from and saved to this Google Drive directory.
            </p>

            <div className="settings-folder-box">
              <FolderOpen size={24}/>
              <div className="settings-folder-text">
                <span className="settings-folder-label">Selected Folder:</span>
                <strong className="settings-folder-name">
                  {user?.driveFolderName || 'No folder selected'}
                </strong>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1.25rem', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={onOpenDrivePicker}
              >
                <Folder size={15}/> {user?.driveFolderId ? 'Change Drive Folder' : 'Select Drive Folder'}
              </button>

              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleManualScan}
                disabled={scanning || !user?.driveFolderId}
              >
                {scanning ? <><Loader2 size={15}/> Scanning...</> : <><RefreshCw size={15}/> Scan Library Now</>}
              </button>
            </div>
          </div>
        </div>

        {/* Card 3: Library Preferences */}
        <div className="settings-card">
          <div className="settings-card-header">
            <h3><BookOpen size={16} style={{ marginRight: '0.4rem' }} /> Library Preferences</h3>
          </div>

          <div className="settings-card-body">
            <div className="settings-toggle-row">
              <div>
                <strong>Organize by Series in Google Drive</strong>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: '0.2rem 0 0' }}>
                  Automatically creates series subfolders in your Google Drive when downloading new comics.
                </p>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={organizeBySeries}
                  onChange={(e) => {
                    setOrganizeBySeries(e.target.checked);
                    handleSaveSettings({ organizeBySeries: e.target.checked });
                  }}
                />
                <span className="slider round"></span>
              </label>
            </div>

            <div className="settings-toggle-row" style={{ marginTop: '1.25rem' }}>
              <div>
                <strong>Auto-Scan on Startup</strong>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: '0.2rem 0 0' }}>
                  Automatically checks Google Drive for new comic files when accessing the library.
                </p>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={autoScan}
                  onChange={(e) => {
                    setAutoScan(e.target.checked);
                    handleSaveSettings({ autoScan: e.target.checked });
                  }}
                />
                <span className="slider round"></span>
              </label>
            </div>

            {/* CBZ Unpack, 75% Image Compression & Repack */}
            <div className="settings-toggle-row" style={{ marginTop: '1.25rem' }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <strong>Compress Downloaded Comics (75% JPEG)</strong>
                  <span className="badge badge-success">Recommended</span>
                </div>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: '0.2rem 0 0' }}>
                  Unpacks downloaded .cbz, re-encodes images at 75% JPEG quality, and repacks into a clean .cbz before saving to Google Drive. Saves up to 60–75% cloud space and accelerates reading!
                </p>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={compressLibrary}
                  onChange={(e) => {
                    setCompressLibrary(e.target.checked);
                    handleSaveSettings({ compressLibrary: e.target.checked });
                  }}
                />
                <span className="slider round"></span>
              </label>
            </div>

            {compressLibrary && (
              <div style={{ marginTop: '1rem', padding: '0.85rem 1rem', background: 'rgba(0,0,0,0.2)', borderRadius: '10px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.4rem', fontSize: '0.85rem' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>Compression Quality:</span>
                  <strong style={{ color: 'var(--accent-color)' }}>{compressionQuality}% JPEG</strong>
                </div>
                <input
                  type="range"
                  min={50}
                  max={95}
                  step={5}
                  value={compressionQuality}
                  onChange={(e) => {
                    const q = parseInt(e.target.value, 10);
                    setCompressionQuality(q);
                    handleSaveSettings({ compressionQuality: q });
                  }}
                  className="reader-slider"
                  style={{ width: '100%' }}
                />
              </div>
            )}
          </div>
        </div>

        {/* Card 4: Shared Hosting Environment */}
        {/* <div className="settings-card">
          <div className="settings-card-header">
            <h3><Cloud size={16} style={{ marginRight: '0.4rem' }} /> Namecheap Server Info</h3>
          </div>

          <div className="settings-card-body">
            <div className="server-info-list">
              <div className="server-info-item">
                <span className="server-info-label">Environment:</span>
                <span className="server-info-val">cPanel Node.js App (Passenger)</span>
              </div>
              <div className="server-info-item">
                <span className="server-info-label">Storage Backend:</span>
                <span className="server-info-val">Google Drive REST API v3</span>
              </div>
              <div className="server-info-item">
                <span className="server-info-label">Compression / Reader:</span>
                <span className="server-info-val">Native Node.js zlib (Pure JS)</span>
              </div>
              <div className="server-info-item">
                <span className="server-info-label">GetComics Integration:</span>
                <span className="server-info-val">Active (What's New, Search, Pull List)</span>
              </div>
            </div>
          </div>
        </div> */}
      {/* Card 5: Mobile App (APK Download) */}
        <div className="settings-card" style={{ border: '1px solid rgba(255,255,255,0.08)' }}>
          <div className="settings-card-header">
            <h3><Smartphone size={16} style={{ marginRight: '0.4rem' }} /> Android Mobile App</h3>
          </div>

          <div className="settings-card-body">
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '1rem' }}>
              Install the COMIXOLOFREE Android app to read on the go. It supports connecting to this
              cloud instance or scanning for a local server, plus downloading comics for offline reading.
            </p>

            <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center' }}>
              <a
                className="btn btn-primary"
                href="/comix.apk"
                download
                style={{ textDecoration: 'none', display: 'inline-block' }}
              >
                <Package size={15}/> Download APK (comix.apk)
              </a>
              <span className="badge badge-info" style={{ fontSize: '0.75rem' }}>
                Android 5.0+
              </span>
            </div>

            <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', marginTop: '0.9rem' }}>
              Tip: allow "Install unknown apps" for your browser on Android, then open the downloaded
              .apk to install. The app shares the same Google Drive library as this cloud server.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
