import { useState, useEffect, useCallback } from 'react';
import { FolderOpen, LogOut, RefreshCw, Trash2, HardDrive, Activity, KeyRound, Music, Disc, ListMusic, BookOpen, Download, Smartphone, Server, RotateCcw, Cookie, Save } from 'lucide-react';
import { api } from './api';
import { hasNativeBridge } from './nativeBridge';
import { formatBytes, pluralize } from './format';
import { getOfflineStats, removeOfflineTrack, removeOfflineCollection, clearAllOffline } from './offlineStorage';

function Switch({ checked, onChange }) {
  return (
    <button
      type="button"
      className={`switch-track ${checked ? 'active' : ''}`}
      onClick={() => onChange(!checked)}
      role="switch"
      aria-checked={checked}
    >
      <span className="switch-thumb" />
    </button>
  );
}

export default function Settings({ user, libraryVersion, onOpenDrivePicker, onLogout, notify }) {
  const inAndroidApp = hasNativeBridge();
  const [settings, setSettings] = useState(null);
  const [offline, setOffline] = useState({ items: [], usage: { bytes: 0, files: 0 } });
  const [deviceOffline, setDeviceOffline] = useState({
    totalBytes: 0,
    trackCount: 0,
    albumCount: 0,
    playlistCount: 0,
    bookCount: 0,
    tracks: [],
    albums: [],
    playlists: [],
    books: []
  });
  const [health, setHealth] = useState(null);
  const [abbSession, setAbbSession] = useState(null);
  const [abbBusy, setAbbBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState(null);
  const [restartingStreamer, setRestartingStreamer] = useState(false);
  const [restartingApp, setRestartingApp] = useState(false);
  const [adminCookies, setAdminCookies] = useState('');
  const [adminCookiesLoading, setAdminCookiesLoading] = useState(false);
  const [adminCookiesSaving, setAdminCookiesSaving] = useState(false);
  const [adminCookiesStatus, setAdminCookiesStatus] = useState(null);

  const handleFetchAdminCookies = useCallback(async () => {
    setAdminCookiesLoading(true);
    setAdminCookiesStatus(null);
    try {
      const res = await api.getAdminCookies();
      if (res?.content) {
        setAdminCookies(res.content);
        setAdminCookiesStatus({ success: true, message: `Loaded ${res.sizeBytes || res.content.length} bytes from server.` });
      } else if (res?.exists === false) {
        setAdminCookiesStatus({ success: true, message: 'No cookies.txt currently found on download server.' });
      }
    } catch (err) {
      setAdminCookiesStatus({ success: false, message: `Failed to load: ${err.message}` });
    } finally {
      setAdminCookiesLoading(false);
    }
  }, []);

  const handleSaveAdminCookies = async () => {
    if (!adminCookies.trim()) {
      notify('Empty cookies', 'Please paste the contents of your cookies.txt first.', true);
      return;
    }
    setAdminCookiesSaving(true);
    setAdminCookiesStatus(null);
    try {
      const res = await api.saveAdminCookies(adminCookies);
      setAdminCookiesStatus({ success: true, message: res.message || 'Saved to download server!' });
      notify('Cookies Updated', 'cookies.txt was successfully written to the download server.');
    } catch (err) {
      setAdminCookiesStatus({ success: false, message: err.message || 'Failed to save cookies' });
      notify('Save Failed', err.message, true);
    } finally {
      setAdminCookiesSaving(false);
    }
  };

  useEffect(() => {
    if (user?.email?.toLowerCase() === 'gdmcvittie@gmail.com') {
      handleFetchAdminCookies();
    }
  }, [user?.email, handleFetchAdminCookies]);

  const handleRestartStreamer = async () => {
    if (!window.confirm('Restart the torrent / streamer daemon? Active transfers will reconnect.')) return;
    setRestartingStreamer(true);
    try {
      await api.restartStreamer();
      notify('Restarting Torrent Server', 'The torrent/streamer daemon is restarting…');
      setTimeout(() => {
        load();
        setRestartingStreamer(false);
      }, 3500);
    } catch (err) {
      notify('Restart Failed', err.message, true);
      setRestartingStreamer(false);
    }
  };

  const handleRestartApp = async () => {
    if (!window.confirm('Restart the FRAUDIO app server? The web interface will briefly reconnect.')) return;
    setRestartingApp(true);
    try {
      await api.restartAppServer();
      notify('Restarting App Server', 'FRAUDIO app server is restarting. Reconnecting…');
      setTimeout(() => {
        window.location.reload();
      }, 3000);
    } catch (err) {
      notify('Restart Failed', err.message, true);
      setRestartingApp(false);
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, o, h] = await Promise.all([
        api.settings(),
        api.offline(),
        api.health().catch(() => null)
      ]);
      setSettings(s);
      setOffline(o || { items: [], usage: { bytes: 0, files: 0 } });
      setHealth(h);
      setAbbSession(h?.abb || null);
    } catch (err) {
      notify('Could not load settings', err.message, true);
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    load();
  }, [load, libraryVersion]);

  const update = useCallback(async (key, value) => {
    setSavingKey(key);
    setSettings((prev) => ({ ...prev, [key]: value }));
    try {
      const result = await api.saveSettings({ [key]: value });
      setSettings((prev) => ({ ...prev, ...result.settings }));
    } catch (err) {
      notify('Could not save setting', err.message, true);
      load();
    } finally {
      setSavingKey(null);
    }
  }, [notify, load]);

  const removeOffline = useCallback(async (itemId) => {
    try {
      await api.removeOffline(itemId);
      setOffline((prev) => ({ ...prev, items: prev.items.filter((i) => i.itemId !== itemId) }));
    } catch (err) {
      notify('Could not remove offline copy', err.message, true);
    }
  }, [notify]);

  const refreshDeviceOffline = useCallback(async () => {
    try {
      const stats = await getOfflineStats();
      if (stats) setDeviceOffline(stats);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    refreshDeviceOffline();
    if (typeof window !== 'undefined') {
      window.addEventListener('fraudio:offline-changed', refreshDeviceOffline);
      return () => window.removeEventListener('fraudio:offline-changed', refreshDeviceOffline);
    }
  }, [refreshDeviceOffline]);

  const handleRemoveDeviceCollection = async (collectionId, title) => {
    try {
      await removeOfflineCollection(collectionId);
      await refreshDeviceOffline();
      notify('Removed from device', `"${title}" has been deleted from offline storage.`);
    } catch (err) {
      notify('Could not remove offline item', err.message, true);
    }
  };

  const handleRemoveDeviceTrack = async (trackId, title) => {
    try {
      await removeOfflineTrack(trackId);
      await refreshDeviceOffline();
      notify('Removed from device', `"${title}" has been deleted from offline storage.`);
    } catch (err) {
      notify('Could not remove offline track', err.message, true);
    }
  };

  const handleClearAllDeviceOffline = async () => {
    if (!window.confirm('Delete all offline songs, albums, and books from this device?')) return;
    try {
      await clearAllOffline();
      await refreshDeviceOffline();
      notify('Device storage cleared', 'All downloaded offline audio files have been removed.');
    } catch (err) {
      notify('Could not clear offline storage', err.message, true);
    }
  };

  const handleAbbLogin = useCallback(async () => {
    setAbbBusy(true);
    try {
      const result = await api.abbLogin();
      setAbbSession(result);
      notify('Signed in to AudioBookBay', 'Scraping is ready.');
    } catch (err) {
      notify('AudioBookBay sign-in failed', err.message, true);
    } finally {
      setAbbBusy(false);
    }
  }, [notify]);

  // ---- YouTube Music: sign-in cookie capture (Electron only) -------------
  const desktop = typeof window !== 'undefined' ? window.fraudioDesktop : null;
  const [ytmBusy, setYtmBusy] = useState(false);
  const [ytmError, setYtmError] = useState('');

  const captureYtmCookies = useCallback(async () => {
    if (!desktop?.ytmCaptureCookies) return;
    setYtmBusy(true);
    setYtmError('');
    try {
      const res = await desktop.ytmCaptureCookies();
      if (res.ok) {
        await update('youtubeCookiesFile', res.path);
        notify('YouTube linked', `${res.count} cookies saved. Liked Music imports are ready.`);
      } else if (res.reason === 'cancelled') {
        setYtmError('The sign-in window was closed before finishing.');
      } else {
        setYtmError(res.message || 'Could not capture YouTube cookies.');
      }
    } catch (err) {
      setYtmError(err.message || 'Could not capture YouTube cookies.');
    } finally {
      setYtmBusy(false);
    }
  }, [desktop, update, notify]);

  const clearYtmCookies = useCallback(async () => {
    if (!desktop?.ytmClearCookies) return;
    const res = await desktop.ytmClearCookies().catch((err) => ({ ok: false, message: err.message }));
    if (res.ok) {
      await update('youtubeCookiesFile', '');
      notify('YouTube cookies removed');
    } else {
      setYtmError(res.message || 'Could not remove YouTube cookies.');
    }
  }, [desktop, update, notify]);

  // ---- Smart playlists (music-only keyword rules) -----------------------
  const [smartRules, setSmartRules] = useState(null);
  const [smartBusy, setSmartBusy] = useState(false);
  const [smartName, setSmartName] = useState('');
  const [smartKeywords, setSmartKeywords] = useState('');
  const [smartMsg, setSmartMsg] = useState('');

  const reloadSmart = useCallback(async () => {
    try {
      const data = await api.smartPlaylists();
      setSmartRules(Array.isArray(data?.rules) ? data.rules : []);
    } catch {
      setSmartRules([]);
    }
  }, []);

  useEffect(() => { reloadSmart(); }, [reloadSmart]);

  const summarizeAdded = (added) => {
    const parts = Object.entries(added || {}).filter(([, n]) => n > 0).map(([name, n]) => `+${n} ${name}`);
    return parts.length ? `Filed: ${parts.join(', ')}.` : 'No new matches.';
  };

  const addSmartRule = useCallback(async () => {
    if (!smartName.trim() || !smartKeywords.trim() || smartBusy) return;
    setSmartBusy(true);
    setSmartMsg('');
    try {
      const res = await api.createSmartPlaylist(smartName.trim(), smartKeywords.split(','));
      setSmartName('');
      setSmartKeywords('');
      setSmartMsg(`${res.rule?.name || ''}: ${summarizeAdded(res.added)}`);
      await reloadSmart();
    } catch (err) {
      setSmartMsg(err.message || 'Could not save the rule.');
    } finally {
      setSmartBusy(false);
    }
  }, [smartName, smartKeywords, smartBusy, reloadSmart]);

  const removeSmartRule = useCallback(async (rule) => {
    try {
      await api.deleteSmartPlaylist(rule.id);
      setSmartMsg(`Rule "${rule.name}" removed - the playlist stays in your library.`);
      await reloadSmart();
    } catch (err) {
      setSmartMsg(err.message || 'Could not remove the rule.');
    }
  }, [reloadSmart]);

  const runSmartApply = useCallback(async () => {
    setSmartBusy(true);
    setSmartMsg('');
    try {
      const res = await api.applySmartPlaylists();
      setSmartMsg(summarizeAdded(res.added));
    } catch (err) {
      setSmartMsg(err.message || 'Could not apply the rules.');
    } finally {
      setSmartBusy(false);
    }
  }, []);

  const seedSmartPresets = useCallback(async () => {
    setSmartBusy(true);
    setSmartMsg('');
    try {
      const res = await api.seedSmartPlaylists();
      setSmartMsg(summarizeAdded(res.added));
      await reloadSmart();
    } catch (err) {
      setSmartMsg(err.message || 'Could not seed the starter rules.');
    } finally {
      setSmartBusy(false);
    }
  }, [reloadSmart]);

  if (loading && !settings) {
    return (
      <div className="loading-state">
        <div className="spinner" />
        <p>Loading settings…</p>
      </div>
    );
  }

  return (
    <>
      <div className="view-header">
        <h1 className="view-title">Settings</h1>
        <p className="view-subtitle">Folders, offline storage and diagnostics.</p>
      </div>

      {/* Drive folders */}
      <div className="panel">
        <div className="panel-title">Google Drive folders</div>

        <div className="setting-row">
          <div>
            <div className="setting-label">Audiobooks folder</div>
            <div className="setting-help">
              {user?.audiobooksFolderName || 'Not connected. FRAUDIO will not find any books until you pick one.'}
            </div>
          </div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => onOpenDrivePicker('audiobooks')}>
            <FolderOpen size={14} />
            {user?.audiobooksFolderId ? 'Change' : 'Connect'}
          </button>
        </div>

        <div className="setting-row">
          <div>
            <div className="setting-label">Music folder</div>
            <div className="setting-help">
              {user?.musicFolderName || 'Not connected. Point this at the folder holding your albums.'}
            </div>
          </div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => onOpenDrivePicker('music')}>
            <FolderOpen size={14} />
            {user?.musicFolderId ? 'Change' : 'Connect'}
          </button>
        </div>
      </div>

      {/* Behaviour */}
      <div className="panel">
        <div className="panel-title">Behaviour</div>

        <div className="setting-row">
          <div>
            <div className="setting-label">Auto-scan on launch</div>
            <div className="setting-help">Rescan your Drive folders each time FRAUDIO starts.</div>
          </div>
          <Switch
            checked={Boolean(settings?.autoScanOnLaunch)}
            onChange={(v) => update('autoScanOnLaunch', v)}
          />
        </div>

        {/* <div className="setting-row">
          <div>
            <div className="setting-label">Keep local copy</div>
            <div className="setting-help">Retain downloaded files on disk after they land in Drive.</div>
          </div>
          <Switch
            checked={Boolean(settings?.keepLocalCopy)}
            onChange={(v) => update('keepLocalCopy', v)}
          />
        </div> */}

        {/* <div className="setting-row">
          <div>
            <div className="setting-label">Delete torrent after upload</div>
            <div className="setting-help">Remove the local torrent once the book is safely in Drive.</div>
          </div>
          <Switch
            checked={Boolean(settings?.deleteAfterUpload)}
            onChange={(v) => update('deleteAfterUpload', v)}
          />
        </div> */}

        <div className="setting-row">
          <div>
            <div className="setting-label">Cover cache lifetime</div>
            <div className="setting-help">How long extracted cover art is reused before being rebuilt.</div>
          </div>
          <select
            className="input-field"
            style={{ width: 130 }}
            value={settings?.coverCacheDays ?? 30}
            onChange={(e) => update('coverCacheDays', Number(e.target.value))}
          >
            <option value={1}>1 day</option>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
          </select>
        </div>

        {savingKey && <div className="setting-help" style={{ marginTop: '0.5rem' }}>Saving…</div>}
      </div>

      {/* YouTube Music */}
      <div className="panel">
        <div className="panel-title">YouTube Music</div>

        <div className="setting-row">
          <div>
            <div className="setting-label">Download format</div>
            <div className="setting-help">
              MP3 re-encodes every track (plays everywhere). Opus is YouTube's own
              best stream with no re-encode - smallest files at the same quality.
            </div>
          </div>
          <select
            className="input-field"
            style={{ width: 150 }}
            value={settings?.musicAudioFormat ?? 'mp3'}
            onChange={(e) => update('musicAudioFormat', e.target.value)}
          >
            <option value="mp3">MP3</option>
            <option value="opus">Opus (no transcode)</option>
          </select>
        </div>

        <div className="setting-row" style={{ opacity: (settings?.musicAudioFormat ?? 'mp3') === 'mp3' ? 1 : 0.45 }}>
          <div>
            <div className="setting-label">MP3 quality</div>
            <div className="setting-help">
              Variable bitrate - the best size:quality trade-off. V4 (~165k VBR) is
              smaller than what YouTube itself streams at and effectively transparent
              from a lossy source. Pick a fixed kbps if you need a predictable size.
            </div>
          </div>
          <select
            className="input-field"
            style={{ width: 220 }}
            value={settings?.musicAudioQuality ?? 'v4'}
            onChange={(e) => update('musicAudioQuality', e.target.value)}
          >
            <option value="v0">V0 - very high (~245k VBR)</option>
            <option value="v2">V2 - high (~190k VBR)</option>
            <option value="v4">V4 - good (~165k VBR)</option>
            <option value="v6">V6 - decent (~130k VBR)</option>
            <option value="v8">V8 - small (~100k VBR)</option>
            <option value="192k">CBR 192 kbps</option>
            <option value="160k">CBR 160 kbps</option>
            <option value="128k">CBR 128 kbps</option>
          </select>
        </div>

        <div style={{ borderTop: '1px solid var(--border-color)', marginTop: '1.1rem', paddingTop: '1rem' }}>
          <div className="setting-label">Smart playlists</div>
          <div className="setting-help" style={{ marginBottom: '0.6rem' }}>
            Keyword rules that auto-file tracks into music playlists. A keyword matches
            as a whole word in the artist, album, title or genre tag - e.g.
            <em> rap, trap </em> fills <em>Hip Hop / Rap</em>. Rules run on every import
            and scan; they only ever add, so manual removals stick.
          </div>

          {smartRules && smartRules.map((rule) => (
            <div key={rule.id} className="smart-rule">
              <div className="smart-rule-main">
                <div className="smart-rule-name">{rule.name}</div>
                <div className="smart-rule-keywords">{rule.keywords.join(', ')}</div>
              </div>
              <button type="button" className="icon-btn" title="Remove rule (keeps the playlist)" onClick={() => removeSmartRule(rule)}>
                <Trash2 size={14} />
              </button>
            </div>
          ))}

          {smartMsg && <div className="setting-help" style={{ margin: '0.5rem 0' }}>{smartMsg}</div>}

          <div className="smart-rule-form">
            <input
              className="input-field"
              placeholder="Playlist name (e.g. Hip Hop / Rap)"
              value={smartName}
              onChange={(e) => setSmartName(e.target.value)}
            />
            <input
              className="input-field"
              placeholder="Keywords, comma separated (rap, trap, drill)"
              value={smartKeywords}
              onChange={(e) => setSmartKeywords(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addSmartRule(); }}
            />
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={addSmartRule}
              disabled={smartBusy || !smartName.trim() || !smartKeywords.trim()}
            >
              Add rule
            </button>
          </div>

          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.6rem' }}>
            {!smartRules || smartRules.length === 0 ? (
              <button type="button" className="btn btn-secondary btn-sm" onClick={seedSmartPresets} disabled={smartBusy}>
                <Activity size={13} />
                Add starter rules
              </button>
            ) : (
              <button type="button" className="btn btn-secondary btn-sm" onClick={runSmartApply} disabled={smartBusy}>
                <RefreshCw size={13} className={smartBusy ? 'spin' : undefined} />
                Apply to library now
              </button>
            )}
          </div>
        </div>

        {desktop && (
          <div className="setting-row">
            <div>
              <div className="setting-label">YouTube account</div>
              <div className="setting-help">
                Opens a YouTube Music window to sign in, then keeps the session
                cookies yt-dlp needs for Liked Music and age-gated tracks. Nothing is
                shared with Google beyond the normal sign-in.
              </div>
              {ytmError && <div className="setting-help" style={{ color: 'var(--danger)' }}>{ytmError}</div>}
            </div>
            {settings?.youtubeCookiesFile ? (
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <span className="badge badge-success">Linked</span>
                <button type="button" className="btn btn-secondary btn-sm" onClick={captureYtmCookies} disabled={ytmBusy}>
                  <RefreshCw size={13} className={ytmBusy ? 'spin' : undefined} />
                  Refresh
                </button>
                <button type="button" className="icon-btn" onClick={clearYtmCookies} title="Remove cookies and sign out">
                  <Trash2 size={14} />
                </button>
              </div>
            ) : (
              <button type="button" className="btn btn-primary btn-sm" onClick={captureYtmCookies} disabled={ytmBusy}>
                <KeyRound size={14} />
                {ytmBusy ? 'Waiting for sign-in…' : 'Sign in'}
              </button>
            )}
          </div>
        )}

        {/* <div className="setting-row">
          <div>
            <div className="setting-label">Cookies file</div>
            <div className="setting-help">
              Path to a Netscape cookies.txt exported while signed in to music.youtube.com.
              Required to import private lists like Liked Music (<code>list=LM</code>) and to
              unlock age-gated tracks. This stays on this device only.
            </div>
          </div>
          <input
            className="input-field"
            style={{ width: 280 }}
            type="text"
            placeholder="C:\\secrets\\youtube-cookies.txt"
            value={settings?.youtubeCookiesFile ?? ''}
            onChange={(e) => update('youtubeCookiesFile', e.target.value)}
          />
        </div> */}

        {/* <div className="setting-row">
          <div>
            <div className="setting-label">…or read cookies from browser</div>
            <div className="setting-help">
              Easier, but browsers often block it: Chrome locks its cookie database while
              running, Edge encrypts against Windows. Use the file above if this fails.
            </div>
          </div>
          <select
            className="input-field"
            style={{ width: 150 }}
            value={settings?.youtubeCookiesBrowser ?? ''}
            onChange={(e) => update('youtubeCookiesBrowser', e.target.value)}
          >
            <option value="">Off</option>
            <option value="chrome">Chrome</option>
            <option value="edge">Edge</option>
            <option value="firefox">Firefox</option>
            <option value="brave">Brave</option>
          </select>
        </div> */}

        {/* <div className="setting-row">
          <div>
            <div className="setting-label">Download runner</div>
            <div className="setting-help">
              Where yt-dlp executes. VPS Node downloads directly on your remote torrent server, while Local Machine runs yt-dlp locally using your home IP and browser cookies (avoids datacenter IP bot-checks).
            </div>
          </div>
          <select
            className="input-field"
            style={{ width: 170 }}
            value={settings?.youtubeDownloadLocation ?? 'auto'}
            onChange={(e) => update('youtubeDownloadLocation', e.target.value)}
          >
            <option value="auto">VPS Node (Auto)</option>
            <option value="local">Local Machine</option>
          </select>
        </div> */}
      </div>

      {/* Offline storage */}
      <div className="panel">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem', flexWrap: 'wrap', gap: '0.5rem' }}>
          <div className="panel-title" style={{ margin: 0 }}>Device Offline Storage</div>
          {deviceOffline.trackCount > 0 && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              style={{ color: 'var(--danger)', borderColor: 'var(--danger)', fontSize: '0.75rem', padding: '0.25rem 0.6rem' }}
              onClick={handleClearAllDeviceOffline}
            >
              <Trash2 size={13} />
              Clear Device Storage
            </button>
          )}
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', lineHeight: 1.5, marginBottom: '1rem' }}>
          Audio saved directly onto this device for playback without an internet connection.
        </p>

        <div className="stat-grid" style={{ marginBottom: deviceOffline.trackCount > 0 ? '1rem' : 0 }}>
          <div className="stat-card">
            <div className="stat-value">{formatBytes(deviceOffline.totalBytes || 0)}</div>
            <div className="stat-label">Device space</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{deviceOffline.trackCount}</div>
            <div className="stat-label">Tracks</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{deviceOffline.albumCount}</div>
            <div className="stat-label">Albums</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{deviceOffline.playlistCount}</div>
            <div className="stat-label">Playlists</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{deviceOffline.bookCount}</div>
            <div className="stat-label">Audiobooks</div>
          </div>
        </div>

        {deviceOffline.trackCount === 0 ? (
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', lineHeight: 1.6, marginTop: '0.5rem' }}>
            No media saved offline. Tap the download icon on any album, playlist, track, or audiobook in your library to listen offline.
          </p>
        ) : (
          <div className="row-list" style={{ marginTop: '0.75rem', maxHeight: 320, overflowY: 'auto' }}>
            {/* Albums */}
            {deviceOffline.albums.map((album) => (
              <div className="row-item" key={album.id}>
                <div className="row-thumb-placeholder"><Disc size={16} /></div>
                <div className="row-meta">
                  <div className="row-title">{album.title}</div>
                  <div className="row-subtitle">
                    Album · {album.artist || 'Unknown'} · {pluralize(album.trackIds?.length || album.totalTracks || 0, 'track')}
                  </div>
                </div>
                <button
                  type="button"
                  className="icon-btn"
                  title="Delete from device"
                  onClick={() => handleRemoveDeviceCollection(album.id, album.title)}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}

            {/* Playlists */}
            {deviceOffline.playlists.map((pl) => (
              <div className="row-item" key={pl.id}>
                <div className="row-thumb-placeholder"><ListMusic size={16} /></div>
                <div className="row-meta">
                  <div className="row-title">{pl.title}</div>
                  <div className="row-subtitle">
                    Playlist · {pluralize(pl.trackIds?.length || pl.totalTracks || 0, 'track')}
                  </div>
                </div>
                <button
                  type="button"
                  className="icon-btn"
                  title="Delete from device"
                  onClick={() => handleRemoveDeviceCollection(pl.id, pl.title)}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}

            {/* Books */}
            {deviceOffline.books.map((book) => (
              <div className="row-item" key={book.id}>
                <div className="row-thumb-placeholder"><BookOpen size={16} /></div>
                <div className="row-meta">
                  <div className="row-title">{book.title}</div>
                  <div className="row-subtitle">
                    Audiobook · {book.author || 'Unknown'}
                  </div>
                </div>
                <button
                  type="button"
                  className="icon-btn"
                  title="Delete from device"
                  onClick={() => handleRemoveDeviceCollection(book.id, book.title)}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}

            {/* Standalone Tracks */}
            {deviceOffline.tracks.filter((t) => {
              const inAlbum = deviceOffline.albums.some((a) => a.trackIds?.includes(t.id));
              const inPlaylist = deviceOffline.playlists.some((p) => p.trackIds?.includes(t.id));
              const inBook = deviceOffline.books.some((b) => b.trackIds?.includes(t.id));
              return !inAlbum && !inPlaylist && !inBook;
            }).map((track) => (
              <div className="row-item" key={track.id}>
                <div className="row-thumb-placeholder"><Music size={16} /></div>
                <div className="row-meta">
                  <div className="row-title">{track.title}</div>
                  <div className="row-subtitle">
                    {track.artist || 'Unknown'} · {formatBytes(track.sizeBytes || 0)}
                  </div>
                </div>
                <button
                  type="button"
                  className="icon-btn"
                  title="Delete from device"
                  onClick={() => handleRemoveDeviceTrack(track.id, track.title)}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Server cache (shown if present) */}
        {offline.usage?.files > 0 && (
          <div style={{ marginTop: '1.5rem', paddingTop: '1rem', borderTop: '1px solid var(--border-color)' }}>
            <div className="panel-title" style={{ fontSize: '0.85rem', marginBottom: '0.5rem' }}>Server-side Disk Cache</div>
            <div className="stat-grid" style={{ marginBottom: offline.items.length ? '1rem' : 0 }}>
              <div className="stat-card">
                <div className="stat-value">{formatBytes(offline.usage?.bytes || 0)}</div>
                <div className="stat-label">Server disk</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{offline.usage?.files ?? 0}</div>
                <div className="stat-label">Files</div>
              </div>
            </div>
            <div className="row-list">
              {offline.items.map((entry) => (
                <div className="row-item" key={entry.itemId}>
                  <div className="row-thumb-placeholder"><HardDrive size={16} /></div>
                  <div className="row-meta">
                    <div className="row-title">{entry.fileName || entry.itemId}</div>
                    <div className="row-subtitle">
                      {formatBytes(entry.bytes || 0)}
                      {entry.exists ? '' : ' · missing on disk'}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="icon-btn"
                    title="Delete server copy"
                    onClick={() => removeOffline(entry.itemId)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Diagnostics */}
      <div className="panel">
        <div className="panel-title">Diagnostics</div>

        <div className="stat-grid">
          <div className="stat-card">
            <div className="stat-value" style={{ fontSize: '1rem', color: health?.status === 'ok' ? 'var(--accent-color)' : 'var(--danger)' }}>
              {health?.status || 'unknown'}
            </div>
            <div className="stat-label">App Server</div>
          </div>
          <div className="stat-card">
            <div className="stat-value" style={{ fontSize: '1rem', color: abbSession?.loggedIn ? 'var(--accent-color)' : 'var(--text-muted)' }}>
              {abbSession?.loggedIn ? 'Signed in' : 'Signed out'}
            </div>
            <div className="stat-label">AudioBookBay</div>
          </div>
          <div className="stat-card">
            <div className="stat-value" style={{ fontSize: '1rem', color: health?.torrentNode?.online ? 'var(--accent-color)' : 'var(--text-muted)' }}>
              {health?.torrentNode?.online ? 'Online' : 'Offline'}
            </div>
            <div className="stat-label">Download Server</div>
          </div>
        </div>

        {abbSession && !abbSession.loggedIn && (
          <button type="button" className="btn btn-secondary btn-sm" style={{ marginTop: '1rem' }} onClick={handleAbbLogin} disabled={abbBusy}>
            <Activity size={14} />
            {abbBusy ? 'Signing in to AudioBookBay…' : 'Sign in to AudioBookBay'}
          </button>
        )}

        {abbSession?.error && !abbSession?.loggedIn && (
          <p style={{ marginTop: '0.75rem', fontSize: '0.78rem', color: 'var(--danger)', lineHeight: 1.6 }}>
            {abbSession.error}
          </p>
        )}

        {health?.torrentNode?.error && (
          <p style={{ marginTop: '1rem', fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
            {health.torrentNode.error}
          </p>
        )}

        {health?.tools && (
          <p style={{ marginTop: '1rem', fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
{Object.entries(health.tools)
               .map(([name, state]) => `${name}: ${state?.available ? 'ready' : state?.setup || state?.reason || 'missing'}`)
               .join(' · ')}
          </p>
        )}

        <button type="button" className="btn btn-secondary btn-sm" style={{ marginTop: '1rem' }} onClick={load}>
          <RefreshCw size={14} />
          Refresh diagnostics
        </button>
      </div>

      {/* Mobile App & Android Auto (the app itself has no reason to advertise its own APK) */}
      {!inAndroidApp && (
      <div className="panel">
        <div className="panel-title" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Smartphone size={16} />
          Mobile App & Android Auto
        </div>
        <div className="setting-row">
          <div>
            <div className="setting-label">FRAUDIO Android APK</div>
            <div className="setting-help">
              Native Android client with offline sync, background playback, and Android Auto dashboard media service support.
            </div>
          </div>
          <a
            href="/fraudio.apk"
            download="fraudio.apk"
            className="btn btn-primary btn-sm"
            style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '0.4rem', whiteSpace: 'nowrap' }}
          >
            <Download size={14} />
            Download APK
          </a>
        </div>
        <div style={{ marginTop: '0.75rem', fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
          Tip: You can also install FRAUDIO as a standalone Progressive Web App (PWA) directly from Chrome, Edge, or Safari on any device.
        </div>
      </div>
      )}

      {/* Account */}
      <div className="panel">
        <div className="panel-title">Account</div>
        <div className="setting-row">
          <div>
            <div className="setting-label">{user?.name}</div>
            <div className="setting-help">{user?.email}</div>
          </div>
          <button type="button" className="btn btn-danger btn-sm" onClick={onLogout}>
            <LogOut size={14} />
            Sign out
          </button>
        </div>
      </div>

      {/* Admin Server Controls (Only visible to gdmcvittie@gmail.com) */}
      {user?.email?.toLowerCase() === 'gdmcvittie@gmail.com' && (
        <div className="panel" style={{ border: '1px solid rgba(var(--accent-rgb, 120, 180, 255), 0.35)' }}>
          <div className="panel-title" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--accent-color)' }}>
            <Server size={16} />
            Server Controls (Admin)
          </div>
          <div className="setting-help" style={{ marginBottom: '1rem' }}>
            Administrative daemon process controls. Only visible to <strong>{user.email}</strong>.
          </div>

          <div className="setting-row">
            <div>
              <div className="setting-label">Download Server</div>
              <div className="setting-help">
                Restart the download node daemon ({health?.torrentNode?.targetUrl || 'download server'}). Flushes stuck queue locks and re-initializes tools.
              </div>
            </div>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={handleRestartStreamer}
              disabled={restartingStreamer || restartingApp}
              style={{ minWidth: 160 }}
            >
              <RotateCcw size={14} className={restartingStreamer ? 'spin' : ''} />
              {restartingStreamer ? 'Restarting…' : 'Restart Download Server'}
            </button>
          </div>

          <div className="setting-row" style={{ marginTop: '0.85rem', paddingTop: '0.85rem', borderTop: '1px solid var(--border-color)' }}>
            <div>
              <div className="setting-label">App Server</div>
              <div className="setting-help">
                Restart the core FRAUDIO Node.js API server process. The web app will automatically reconnect.
              </div>
            </div>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={handleRestartApp}
              disabled={restartingApp || restartingStreamer}
              style={{ minWidth: 160, color: 'var(--danger)', borderColor: 'rgba(239, 68, 68, 0.4)' }}
            >
              <RotateCcw size={14} className={restartingApp ? 'spin' : ''} />
              {restartingApp ? 'Restarting…' : 'Restart App Server'}
            </button>
          </div>

          {/* Download Server YouTube Cookies (cookies.txt) */}
          <div style={{ marginTop: '1.25rem', paddingTop: '1rem', borderTop: '1px solid var(--border-color)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.4rem', flexWrap: 'wrap', gap: '0.5rem' }}>
              <div>
                <div className="setting-label" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <Cookie size={15} style={{ color: 'var(--accent-color)' }} />
                  <span>Download Server Cookies (<code>cookies.txt</code>)</span>
                </div>
                <div className="setting-help">
                  Paste the Netscape-format <code>cookies.txt</code> exported from your signed-in browser for <code>music.youtube.com</code>.
                  Saving this writes directly to <code>cookies.txt</code> on the download server ({health?.torrentNode?.targetUrl || 'download server'}) to unlock age-gated tracks, private playlists (e.g. Liked Music), and prevent YouTube bot-checks.
                </div>
              </div>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={handleFetchAdminCookies}
                disabled={adminCookiesLoading || adminCookiesSaving}
                title="Reload the current cookies.txt from the download server"
              >
                <RefreshCw size={13} className={adminCookiesLoading ? 'spin' : ''} />
                {adminCookiesLoading ? 'Loading…' : 'Load from Server'}
              </button>
            </div>

            <textarea
              className="input-field"
              rows={8}
              value={adminCookies}
              onChange={(e) => setAdminCookies(e.target.value)}
              placeholder={`# Netscape HTTP Cookie File\n# http://curl.haxx.se/rfc/cookie_spec.html\n# This file is generated by yt-dlp or exported from your browser.\n.youtube.com\tTRUE\t/\tTRUE\t...\tSID\t...\n.youtube.com\tTRUE\t/\tTRUE\t...\tHSID\t...`}
              style={{
                width: '100%',
                fontFamily: 'monospace',
                fontSize: '0.78rem',
                lineHeight: 1.4,
                padding: '0.65rem 0.85rem',
                borderRadius: '8px',
                resize: 'vertical',
                minHeight: '130px',
                marginTop: '0.4rem',
                background: 'rgba(0, 0, 0, 0.25)',
                color: 'var(--text-main, #f8fafc)',
                border: '1px solid var(--border-color)'
              }}
            />

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '0.65rem', flexWrap: 'wrap', gap: '0.5rem' }}>
              <div style={{ fontSize: '0.8rem', color: adminCookiesStatus?.success ? '#34d399' : 'var(--danger, #ef4444)' }}>
                {adminCookiesStatus && (
                  <span>{adminCookiesStatus.success ? '✅ ' : '❌ '}{adminCookiesStatus.message}</span>
                )}
                {!adminCookiesStatus && adminCookies && (
                  <span style={{ color: 'var(--text-muted)' }}>
                    {pluralize(adminCookies.split('\n').filter(l => l.trim() && !l.startsWith('#')).length, 'cookie')} detected ({formatBytes(new Blob([adminCookies]).size)})
                  </span>
                )}
              </div>

              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={handleSaveAdminCookies}
                disabled={adminCookiesSaving || adminCookiesLoading || !adminCookies.trim()}
                style={{ minWidth: 160 }}
              >
                {adminCookiesSaving ? (
                  <>
                    <RefreshCw size={14} className="spin" />
                    <span>Writing to Server…</span>
                  </>
                ) : (
                  <>
                    <Save size={14} />
                    <span>Save to Download Server</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      <p style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>
        FRAUDIO {health?.version ? `v${health.version}` : ''} · {pluralize(offline.usage?.files ?? 0, 'offline file')} cached
      </p>
    </>
  );
}