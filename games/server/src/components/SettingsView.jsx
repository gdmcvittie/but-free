import React, { useState, useEffect } from 'react';
import { 
  HardDrive, 
  RefreshCw, 
  User, 
  Folder, 
  Server, 
  CheckCircle2, 
  AlertCircle, 
  ExternalLink, 
  FolderPlus,
  Sliders,
  LogOut,
  Smartphone
} from 'lucide-react';
import { fetchJson } from '../utils/api';

export default function SettingsView({
  user,
  onOpenAuthModal,
  onOpenDrivePicker,
  onLibraryUpdated
}) {
  const [organizeByConsole, setOrganizeByConsole] = useState(true);
  const [autoScan, setAutoScan] = useState(true);
  const [saving, setSaving] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [statusMessage, setStatusMessage] = useState(null);
  const [downloaderStatus, setDownloaderStatus] = useState({ checking: true, online: false, url: '' });

  useEffect(() => {
    // Check downloader node health
    checkDownloader();
    // Load user settings if available
    if (user?.settings) {
      if (user.settings.organizeByConsole !== undefined) setOrganizeByConsole(user.settings.organizeByConsole);
      if (user.settings.autoScan !== undefined) setAutoScan(user.settings.autoScan);
    }
  }, [user]);

  const checkDownloader = async () => {
    setDownloaderStatus(prev => ({ ...prev, checking: true }));
    try {
      const data = await fetchJson('/api/downloader/status');
      setDownloaderStatus({
        checking: false,
        online: data.online || false,
        url: data.url || 'http://download.butfree.online:4000',
        activeJobs: data.activeJobs || 0
      });
    } catch {
      setDownloaderStatus({
        checking: false,
        online: false,
        url: 'http://download.butfree.online:4000',
        activeJobs: 0
      });
    }
  };

  const handleSaveSettings = async (updates = {}) => {
    if (!user) return;
    setSaving(true);
    setStatusMessage(null);

    const payload = {
      organizeByConsole: updates.organizeByConsole !== undefined ? updates.organizeByConsole : organizeByConsole,
      autoScan: updates.autoScan !== undefined ? updates.autoScan : autoScan
    };

    try {
      await fetchJson('/api/settings', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      setStatusMessage('✅ Settings saved successfully.');
      setTimeout(() => setStatusMessage(null), 3500);
    } catch (err) {
      setStatusMessage(`Error saving settings: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleManualScan = async () => {
    if (!user?.gamesFolderId) {
      onOpenDrivePicker();
      return;
    }

    setScanning(true);
    setStatusMessage('Scanning your Google Drive folder for retro game ROMs...');

    try {
      const data = await fetchJson('/api/games/scan', { method: 'POST' });
      setStatusMessage(`✅ Scan complete! Found ${data.count || 0} game(s) in your Google Drive.`);
      if (onLibraryUpdated) onLibraryUpdated();
    } catch (err) {
      setStatusMessage(`Scan error: ${err.message}`);
    } finally {
      setScanning(false);
    }
  };

  const handleLogout = async () => {
    try {
      await fetchJson('/api/auth/logout', { method: 'POST' });
      window.location.reload();
    } catch {
      window.location.reload();
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-screen bg-[#070a12] p-8 overflow-y-auto">
      {/* Header */}
      <div className="mb-8">
        <h1 className="font-heading font-extrabold text-3xl text-white tracking-tight flex items-center gap-3">
          <span>Cloud Settings</span>
        </h1>
        <p className="text-sm text-slate-400 mt-1 max-w-2xl">
          Manage your Google Drive game storage, connection to the central Downloader server, and library preferences.
        </p>
      </div>

      {/* Status banner */}
      {statusMessage && (
        <div className="mb-6 p-4 rounded-xl bg-purple-600/15 border border-purple-500/30 text-purple-200 text-xs flex items-center justify-between animate-in fade-in">
          <span>{statusMessage}</span>
          <button onClick={() => setStatusMessage(null)} className="text-purple-400 hover:text-white">✕</button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 max-w-5xl">
        {/* Card 1: Google Account Profile */}
        <div className="glass-panel p-6 rounded-2xl border border-white/5 space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-white/5">
            <h3 className="font-heading font-bold text-base text-white flex items-center gap-2">
              <User className="w-4 h-4 text-purple-400" />
              <span>Google Account</span>
            </h3>
            {user && (
              <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                Connected
              </span>
            )}
          </div>

          {user ? (
            <div className="space-y-4">
              <div className="flex items-center gap-4">
                {user.avatar ? (
                  <img src={user.avatar} alt={user.name} className="w-14 h-14 rounded-full ring-2 ring-purple-500/40" />
                ) : (
                  <div className="w-14 h-14 rounded-full bg-purple-600/30 flex items-center justify-center text-purple-300 font-bold text-lg">
                    {user.name ? user.name[0].toUpperCase() : 'G'}
                  </div>
                )}
                <div>
                  <h4 className="font-semibold text-white text-base">{user.name || 'Google User'}</h4>
                  <p className="text-xs text-slate-400">{user.email}</p>
                  <p className="text-[11px] text-slate-500 mt-0.5">Authenticated via Google OAuth 2.0</p>
                </div>
              </div>

              <div className="pt-2">
                <button
                  type="button"
                  onClick={handleLogout}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-400 text-xs font-medium border border-red-500/20 transition"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>Sign Out</span>
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-slate-400">
                Sign in with Google to link your Google Drive and stream game ROMs anywhere.
              </p>
              <button
                type="button"
                onClick={onOpenAuthModal}
                className="btn-primary"
              >
                Sign In with Google
              </button>
            </div>
          )}
        </div>

        {/* Card 2: Google Drive Games Folder */}
        <div className="glass-panel p-6 rounded-2xl border border-white/5 space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-white/5">
            <h3 className="font-heading font-bold text-base text-white flex items-center gap-2">
              <HardDrive className="w-4 h-4 text-cyan-400" />
              <span>Google Drive Games Folder</span>
            </h3>
          </div>

          <p className="text-xs text-slate-400 leading-relaxed">
            Your retro ROMs (.nes, .sfc, .gba, .iso, .zip, etc.) are streamed from and downloaded into this folder.
          </p>

          <div className="p-3.5 rounded-xl bg-slate-900/80 border border-white/5 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-cyan-500/10 text-cyan-400">
              <Folder className="w-5 h-5" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">Active Folder</div>
              <div className="text-sm font-semibold text-white truncate">
                {user?.gamesFolderName || 'No folder selected'}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2.5 pt-1">
            <button
              type="button"
              onClick={onOpenDrivePicker}
              className="btn-primary !py-2 !px-3.5 text-xs"
            >
              <FolderPlus className="w-3.5 h-3.5" />
              <span>{user?.gamesFolderId ? 'Change Games Folder' : 'Select Games Folder'}</span>
            </button>

            <button
              type="button"
              onClick={handleManualScan}
              disabled={scanning || !user?.gamesFolderId}
              className="btn-secondary !py-2 !px-3.5 text-xs"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${scanning ? 'animate-spin text-purple-400' : ''}`} />
              <span>{scanning ? 'Scanning...' : 'Scan Library Now'}</span>
            </button>
          </div>
        </div>

        {/* Card 3: Downloader Server Node */}
        <div className="glass-panel p-6 rounded-2xl border border-white/5 space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-white/5">
            <h3 className="font-heading font-bold text-base text-white flex items-center gap-2">
              <Server className="w-4 h-4 text-purple-400" />
              <span>Central Downloader Server</span>
            </h3>
            <span className={`text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full border ${
              downloaderStatus.online
                ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                : 'bg-red-500/15 text-red-400 border-red-500/30'
            }`}>
              {downloaderStatus.checking ? 'Checking...' : downloaderStatus.online ? 'Online' : 'Offline'}
            </span>
          </div>

          <p className="text-xs text-slate-400 leading-relaxed">
            The shared high-speed VPS node fetches torrents, magnets, and ROM packs, and uploads them directly to your personal Google Drive Games folder.
          </p>

          <div className="p-3.5 rounded-xl bg-slate-900/80 border border-white/5 flex items-center justify-between text-xs">
            <div>
              <span className="text-slate-500 text-[11px] block">Server URL</span>
              <span className="font-mono text-slate-300">{downloaderStatus.url}</span>
            </div>
            <button
              onClick={checkDownloader}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 transition"
              title="Refresh status"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${downloaderStatus.checking ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {/* Card 4: Library & Emulation Preferences */}
        <div className="glass-panel p-6 rounded-2xl border border-white/5 space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-white/5">
            <h3 className="font-heading font-bold text-base text-white flex items-center gap-2">
              <Sliders className="w-4 h-4 text-cyan-400" />
              <span>Library Preferences</span>
            </h3>
          </div>

          <div className="space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <strong className="text-xs text-white block">Auto-Scan on Startup</strong>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  Check Google Drive for newly added ROMs when opening FREEPLAY.
                </p>
              </div>
              <input
                type="checkbox"
                checked={autoScan}
                onChange={(e) => {
                  setAutoScan(e.target.checked);
                  handleSaveSettings({ autoScan: e.target.checked });
                }}
                className="w-4 h-4 accent-purple-600 rounded cursor-pointer"
              />
            </div>

            <div className="flex items-center justify-between gap-4 pt-2 border-t border-white/5">
              <div>
                <strong className="text-xs text-white block">Organize by Console Subfolders</strong>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  Downloads are sorted into SNES, GBA, PS1, Genesis, etc. subfolders in Google Drive.
                </p>
              </div>
              <input
                type="checkbox"
                checked={organizeByConsole}
                onChange={(e) => {
                  setOrganizeByConsole(e.target.checked);
                  handleSaveSettings({ organizeByConsole: e.target.checked });
                }}
                className="w-4 h-4 accent-purple-600 rounded cursor-pointer"
              />
            </div>
          </div>
        </div>


      </div>
    </div>
  );
}
