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
  Smartphone,
  Download,
  Shield,
  Power
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
  const [adminMessage, setAdminMessage] = useState(null);
  const [adminBusy, setAdminBusy] = useState(null); // null | 'app' | 'downloader'

  const isAdmin = Boolean(user?.isAdmin);

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

  const reloadWhenServerBack = (timeoutMs = 20000) => {
    let sawDown = false;
    const started = Date.now();
    const ping = async () => {
      try {
        const res = await fetch('/api/ping', { cache: 'no-store' });
        if (res.ok) {
          if (sawDown || Date.now() - started > timeoutMs) {
            window.location.reload();
            return;
          }
        } else {
          sawDown = true;
        }
      } catch {
        sawDown = true;
      }
      setTimeout(ping, 1200);
    };
    ping();
  };

  const runAdminAction = async (action) => {
    setAdminBusy(action);
    setAdminMessage(null);
    try {
      const data = await fetchJson(`/api/admin/${action === 'app' ? 'restart-app' : 'restart-downloader'}`, { method: 'POST' });
      setAdminMessage(data.message || (action === 'app' ? 'App server restarting…' : 'Downloader server restarting…'));
      if (action === 'app') {
        setTimeout(() => reloadWhenServerBack(), 1500);
      }
    } catch (err) {
      setAdminMessage(`Admin action failed: ${err.message}`);
    } finally {
      setAdminBusy(null);
    }
  };

  return (
    <div className="flex-1 flex flex-col bg-[#181818] p-4 sm:p-6 lg:p-7">
      {/* Header */}
      <div className="mb-6 pb-3 border-b border-[#2b2b2b]">
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wider text-slate-400 font-bold font-mono">PREFERENCES:</span>
          <h1 className="font-bold text-xl text-white tracking-tight">
            <span>WORKSTATION SETTINGS</span>
          </h1>
        </div>
        <p className="text-xs text-slate-400 mt-1 max-w-2xl font-mono">
          Manage mounted Google Drive game storage, connection to the central Downloader server, and library preferences.
        </p>
      </div>

      {/* Status banner */}
      {statusMessage && (
        <div className="mb-5 p-3 rounded-sm bg-[#16293d] border border-[#31a8ff] text-[#52c5ff] text-xs flex items-center justify-between font-mono animate-in fade-in">
          <span>{statusMessage}</span>
          <button onClick={() => setStatusMessage(null)} className="icon-btn icon-btn-sm">✕</button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 max-w-5xl">
        {/* Card 1: Google Account Profile */}
        <div className="glass-panel p-5 rounded-sm border border-[#383838] bg-[#222222] space-y-4">
          <div className="flex items-center justify-between pb-2.5 border-b border-[#2e2e2e]">
            <h3 className="font-bold text-sm text-white flex items-center gap-2">
              <User className="w-4 h-4 text-[#31a8ff]" />
              <span>Google Account</span>
            </h3>
            {user && (
              <span className="text-[9.5px] uppercase font-mono font-bold tracking-wider px-1.5 py-0.5 rounded-sm bg-[#162e20] text-emerald-400 border border-emerald-500/30">
                Connected
              </span>
            )}
          </div>

          {user ? (
            <div className="space-y-4">
              <div className="flex items-center gap-3.5">
                {user.avatar ? (
                  <img src={user.avatar} alt={user.name} className="w-12 h-12 rounded-sm ring-1 ring-[#31a8ff]" />
                ) : (
                  <div className="w-12 h-12 rounded-sm bg-[#1c2e3d] flex items-center justify-center text-[#31a8ff] font-bold text-base">
                    {user.name ? user.name[0].toUpperCase() : 'G'}
                  </div>
                )}
                <div>
                  <h4 className="font-semibold text-white text-sm">{user.name || 'Google User'}</h4>
                  <p className="text-xs text-slate-400 font-mono">{user.email}</p>
                  <p className="text-[10px] text-slate-500 mt-0.5 font-mono">Authenticated via Google OAuth 2.0</p>
                </div>
              </div>

              <div className="pt-1">
                <button
                  type="button"
                  onClick={handleLogout}
                  className="btn btn-danger btn-sm"
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
                className="btn btn-primary"
              >
                Sign In with Google
              </button>
            </div>
          )}
        </div>

        {/* Card 2: Google Drive Games Folder */}
        <div className="glass-panel p-5 rounded-sm border border-[#383838] bg-[#222222] space-y-4">
          <div className="flex items-center justify-between pb-2.5 border-b border-[#2e2e2e]">
            <h3 className="font-bold text-sm text-white flex items-center gap-2">
              <HardDrive className="w-4 h-4 text-[#31a8ff]" />
              <span>Google Drive Games Folder</span>
            </h3>
          </div>

          <p className="text-xs text-slate-400 leading-relaxed font-mono">
            ROM assets (.nes, .sfc, .gba, .z64, .iso, .zip) are mounted from this folder.
          </p>

          <div className="p-3 rounded-sm bg-[#1c1c1c] border border-[#333333] flex items-center gap-3">
            <div className="p-1.5 rounded-sm bg-[#14283d] text-[#31a8ff]">
              <Folder className="w-4 h-4" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[9.5px] uppercase font-mono font-bold text-slate-500 tracking-wider">Mount Path</div>
              <div className="text-xs font-semibold text-white font-mono truncate">
                {user?.gamesFolderName ? `/${user.gamesFolderName}` : 'No folder mounted'}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              onClick={onOpenDrivePicker}
              className="btn btn-primary btn-sm"
            >
              <FolderPlus className="w-3.5 h-3.5" />
              <span>{user?.gamesFolderId ? 'Change Mount Folder' : 'Select Mount Folder'}</span>
            </button>

            <button
              type="button"
              onClick={handleManualScan}
              disabled={scanning || !user?.gamesFolderId}
              className="btn btn-secondary btn-sm"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${scanning ? 'animate-spin text-[#31a8ff]' : ''}`} />
              <span>{scanning ? 'Syncing...' : 'Sync Assets'}</span>
            </button>
          </div>
        </div>

        {/* Card 3: Downloader Server Node */}
        <div className="glass-panel p-5 rounded-sm border border-[#383838] bg-[#222222] space-y-4">
          <div className="flex items-center justify-between pb-2.5 border-b border-[#2e2e2e]">
            <h3 className="font-bold text-sm text-white flex items-center gap-2">
              <Server className="w-4 h-4 text-[#31a8ff]" />
              <span>Central Downloader Server</span>
            </h3>
            <span className={`text-[9.5px] uppercase font-mono font-bold tracking-wider px-1.5 py-0.5 rounded-sm border ${
              downloaderStatus.online
                ? 'bg-[#162e20] text-emerald-400 border-emerald-500/30'
                : 'bg-[#2a1616] text-red-400 border-red-500/30'
            }`}>
              {downloaderStatus.checking ? 'Checking...' : downloaderStatus.online ? 'Online' : 'Offline'}
            </span>
          </div>

          <p className="text-xs text-slate-400 leading-relaxed font-mono">
            Shared VPS node fetches torrents & magnets, uploading directly to your Google Drive Games folder.
          </p>

          <div className="p-3 rounded-sm bg-[#1c1c1c] border border-[#333333] flex items-center justify-between text-xs font-mono">
            <div>
              <span className="text-slate-500 text-[10px] block">Server Endpoint</span>
              <span className="text-slate-300 text-xs">{downloaderStatus.url}</span>
            </div>
            <button
              onClick={checkDownloader}
              className="icon-btn icon-btn-sm"
              title="Refresh status"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${downloaderStatus.checking ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {/* Card 4: Library & Emulation Preferences */}
        <div className="glass-panel p-5 rounded-sm border border-[#383838] bg-[#222222] space-y-4">
          <div className="flex items-center justify-between pb-2.5 border-b border-[#2e2e2e]">
            <h3 className="font-bold text-sm text-white flex items-center gap-2">
              <Sliders className="w-4 h-4 text-[#31a8ff]" />
              <span>Library Preferences</span>
            </h3>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <div>
                <strong className="text-xs text-white block">Auto-Sync on Startup</strong>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  Check Google Drive for newly added ROMs when opening the Freeplay workstation.
                </p>
              </div>
              <input
                type="checkbox"
                checked={autoScan}
                onChange={(e) => {
                  setAutoScan(e.target.checked);
                  handleSaveSettings({ autoScan: e.target.checked });
                }}
                className="w-4 h-4 accent-[#0078d4] rounded-sm cursor-pointer"
              />
            </div>

            <div className="flex items-center justify-between gap-4 pt-2 border-t border-[#2e2e2e]">
              <div>
                <strong className="text-xs text-white block">Organize by Console Subfolders</strong>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  Downloads are sorted into SNES, GBA, PS1, N64 subfolders in Google Drive.
                </p>
              </div>
              <input
                type="checkbox"
                checked={organizeByConsole}
                onChange={(e) => {
                  setOrganizeByConsole(e.target.checked);
                  handleSaveSettings({ organizeByConsole: e.target.checked });
                }}
                className="w-4 h-4 accent-[#0078d4] rounded-sm cursor-pointer"
              />
            </div>
          </div>
        </div>

        {/* Android app download */}
        <div className="glass-panel p-5 rounded-sm border border-[#383838] bg-[#222222] space-y-4">
          <div className="flex items-center justify-between pb-2.5 border-b border-[#2e2e2e]">
            <h3 className="font-bold text-sm text-white flex items-center gap-2">
              <Smartphone className="w-4 h-4 text-emerald-400" />
              <span>FREEPLAY for Android</span>
            </h3>
          </div>
          <p className="text-xs text-slate-400 leading-relaxed font-mono">
            Install the Android client to connect to your cloud library and play offline.
          </p>
          <a href="/freeplay.apk" download="freeplay.apk" className="btn btn-primary btn-sm self-start">
            <Download className="w-3.5 h-3.5" />
            <span>Download Android APK</span>
          </a>
        </div>
      </div>

      {/* Admin Server Controls (owner only) */}
      {isAdmin && (
        <div className="glass-panel p-6 rounded-2xl border border-red-500/25 space-y-4 max-w-5xl mt-6">
          <div className="flex items-center justify-between pb-3 border-b border-red-500/15">
            <h3 className="font-heading font-bold text-base text-white flex items-center gap-2">
              <Shield className="w-4 h-4 text-red-400" />
              <span>Admin Server Controls</span>
            </h3>
            <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-red-500/15 text-red-400 border border-red-500/30">
              Owner
            </span>
          </div>

          <p className="text-xs text-slate-400 leading-relaxed">
            Reboot the FREEPLAY app server or the shared Downloader node (download.butfree.online — PM2
            restarts it). Both drain gracefully; the Downloader keeps monitored jobs and finishes uploads
            to Google Drive after coming back.
          </p>

          {adminMessage && (
            <div className="p-2.5 rounded-sm bg-[#16293d] border border-[#31a8ff] text-[#52c5ff] text-xs font-mono flex items-center justify-between">
              <span>{adminMessage}</span>
              <button onClick={() => setAdminMessage(null)} className="icon-btn icon-btn-sm">✕</button>
            </div>
          )}

          <div className="flex flex-wrap gap-2.5">
            <button
              type="button"
              onClick={() => runAdminAction('app')}
              disabled={adminBusy !== null}
              className="btn btn-danger btn-sm"
            >
              {adminBusy === 'app' ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Power className="w-3.5 h-3.5" />}
              <span>{adminBusy === 'app' ? 'Restarting…' : 'Restart App Server'}</span>
            </button>

            <button
              type="button"
              onClick={() => runAdminAction('downloader')}
              disabled={adminBusy !== null}
              className="btn btn-secondary btn-sm"
            >
              {adminBusy === 'downloader' ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Server className="w-3.5 h-3.5" />}
              <span>{adminBusy === 'downloader' ? 'Restarting…' : 'Restart Downloader Server'}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
