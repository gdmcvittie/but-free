import { GoogleAuth } from './googleAuth.js';

function getDownloaderUrl() {
  return (
    process.env.DOWNLOADER_URL ||
    process.env.TORRENT_STREAM_SERVER ||
    'http://download.butfree.online:4000'
  ).replace(/\/+$/, '');
}

function getNodeHeaders() {
  const key = (
    process.env.NODE_KEY ||
    process.env.DOWNLOADER_SECRET_KEY ||
    process.env.TORRENT_NODE_KEY ||
    ''
  ).trim();
  const headers = { 'Content-Type': 'application/json' };
  if (key) {
    headers['x-node-key'] = key;
    headers['x-dashboard-key'] = key;
  }
  return headers;
}

export const DownloaderClient = {
  async getStatus() {
    const url = `${getDownloaderUrl()}/api/torrent`;
    try {
      const res = await fetch(url, {
        headers: getNodeHeaders(),
        signal: AbortSignal.timeout(4000)
      });
      const data = await res.json().catch(() => ({}));
      return {
        online: res.ok,
        url: getDownloaderUrl(),
        activeJobs: data.activeStreams || 0,
        service: data.service || 'butfree Downloader'
      };
    } catch {
      return {
        online: false,
        url: getDownloaderUrl(),
        activeJobs: 0
      };
    }
  },

  async addDownload(user, { magnet, title, console: consoleKey, webhookUrl }) {
    if (!user.gamesFolderId) {
      throw new Error('Please select a Google Drive Games folder in Settings before downloading.');
    }

    const accessToken = await GoogleAuth.getValidAccessToken(user);
    const url = `${getDownloaderUrl()}/api/torrent/download`;

    const payload = {
      magnet,
      title: title || 'Retro Game',
      kind: 'game',
      meta: {
        console: consoleKey || 'retro',
        title: title || 'Retro Game'
      },
      driveConfig: {
        accessToken,
        rootFolderId: user.gamesFolderId
      },
      transcodeConfig: {
        enabled: false // Game ROMs are raw files, never transcode!
      },
      webhookUrl: webhookUrl || '',
      userId: user.id
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: getNodeHeaders(),
      body: JSON.stringify(payload)
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      throw new Error(data.error || `Downloader node error (HTTP ${res.status})`);
    }

    return data;
  },

  async getDownloads(userId) {
    const url = `${getDownloaderUrl()}/api/torrent/downloads?userId=${encodeURIComponent(userId || '')}`;
    try {
      const res = await fetch(url, {
        headers: getNodeHeaders(),
        signal: AbortSignal.timeout(5000)
      });
      const data = await res.json().catch(() => ({}));
      return data.downloads || [];
    } catch {
      return [];
    }
  },

  async cancelDownload(jobId) {
    const url = `${getDownloaderUrl()}/api/torrent/download/${encodeURIComponent(jobId)}/cancel`;
    const res = await fetch(url, {
      method: 'POST',
      headers: getNodeHeaders()
    });
    return res.ok;
  },

  async clearHistory(userId) {
    const url = `${getDownloaderUrl()}/api/torrent/downloads/history?userId=${encodeURIComponent(userId || '')}`;
    const res = await fetch(url, {
      method: 'DELETE',
      headers: getNodeHeaders()
    });
    return res.ok;
  },

  async restart() {
    const url = `${getDownloaderUrl()}/api/restart`;
    const res = await fetch(url, {
      method: 'POST',
      headers: getNodeHeaders(),
      signal: AbortSignal.timeout(8000)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && data.error) {
      throw new Error(data.error || `Restart request failed (HTTP ${res.status})`);
    }
    return data;
  }
};

// -------------------------------------------------------------
// PC GAMES pipeline (additive): dedicated /api/game/* endpoints on the
// Downloader node - game torrents with file selection + direct HTTP
// downloads (itch.io / GOG installers), uploaded to Google Drive.
// -------------------------------------------------------------

export const GameDownloaderClient = {
  async addGameTorrent(user, { source, title, subfolder, selectedFiles, console: consoleKey, webhookUrl, tokenRefreshUrl }) {
    if (!user.gamesFolderId) {
      throw new Error('Please select a Google Drive Games folder in Settings before downloading.');
    }

    const accessToken = await GoogleAuth.getValidAccessToken(user);
    const url = `${getDownloaderUrl()}/api/game/torrent/download`;

    const safePcFolder = `PC/${(title || 'PC Game').replace(/[/\\:*?"<>|]/g, '_').trim()}`;
    const targetSubfolder = subfolder || (consoleKey === 'pc' || !consoleKey ? safePcFolder : undefined);

    const payload = {
      magnet: source,
      title: title || 'PC Game',
      kind: 'game',
      meta: { console: consoleKey || 'pc', title: title || 'PC Game', subfolder: targetSubfolder },
      subfolder: targetSubfolder,
      selectedFiles: Array.isArray(selectedFiles) && selectedFiles.length > 0 ? selectedFiles : undefined,
      driveConfig: {
        accessToken,
        rootFolderId: user.gamesFolderId,
        subfolder: targetSubfolder,
        tokenRefreshUrl: tokenRefreshUrl || undefined
      },
      webhookUrl: webhookUrl || '',
      userId: user.id
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: getNodeHeaders(),
      body: JSON.stringify(payload)
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      throw new Error(data.error || `Downloader node error (HTTP ${res.status})`);
    }
    return data.job || data;
  },

  async addDirectDownload(user, { url, headers, fileName, title, subfolder, console: consoleKey, webhookUrl, tokenRefreshUrl }) {
    if (!user.gamesFolderId) {
      throw new Error('Please select a Google Drive Games folder in Settings before downloading.');
    }

    const accessToken = await GoogleAuth.getValidAccessToken(user);
    const endpoint = `${getDownloaderUrl()}/api/game/direct/download`;

    const safePcFolder = `PC/${(title || 'PC Game').replace(/[/\\:*?"<>|]/g, '_').trim()}`;
    const targetSubfolder = subfolder || (consoleKey === 'pc' ? safePcFolder : undefined);

    const payload = {
      url,
      headers: headers && Object.keys(headers).length ? headers : undefined,
      fileName: fileName || undefined,
      title: title || 'Game Download',
      meta: { console: consoleKey || 'pc', title: title || 'Game Download', subfolder: targetSubfolder },
      subfolder: targetSubfolder,
      driveConfig: {
        accessToken,
        rootFolderId: user.gamesFolderId,
        subfolder: targetSubfolder,
        tokenRefreshUrl: tokenRefreshUrl || undefined
      },
      webhookUrl: webhookUrl || '',
      userId: user.id
    };

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: getNodeHeaders(),
      body: JSON.stringify(payload)
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      throw new Error(data.error || `Downloader node error (HTTP ${res.status})`);
    }
    return data.job || data;
  },

  async inspectTorrent(source, timeoutMs = 25000) {
    const url = `${getDownloaderUrl()}/api/game/torrent/inspect`;
    const res = await fetch(url, {
      method: 'POST',
      headers: getNodeHeaders(),
      body: JSON.stringify({ url: source, timeoutMs })
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      throw new Error(data.error || `Torrent inspect failed (HTTP ${res.status})`);
    }
    return data;
  },

  async resolveLink(sourceUrl) {
    const url = `${getDownloaderUrl()}/api/game/resolve-link`;
    const res = await fetch(url, {
      method: 'POST',
      headers: getNodeHeaders(),
      body: JSON.stringify({ url: sourceUrl })
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      throw new Error(data.error || `Link resolve failed (HTTP ${res.status})`);
    }
    return data.directUrl;
  },

  async getGameDownloads(userId) {
    const url = `${getDownloaderUrl()}/api/game/downloads${userId ? `?userId=${encodeURIComponent(userId)}` : ''}`;
    try {
      const res = await fetch(url, {
        headers: getNodeHeaders(),
        signal: AbortSignal.timeout(6000)
      });
      const data = await res.json().catch(() => ({}));
      return data.downloads || [];
    } catch {
      return [];
    }
  },

  async cancelGameDownload(jobId) {
    const url = `${getDownloaderUrl()}/api/game/download/${encodeURIComponent(jobId)}/cancel`;
    const res = await fetch(url, { method: 'POST', headers: getNodeHeaders() });
    return res.ok;
  },

  async clearGameHistory(userId) {
    const url = `${getDownloaderUrl()}/api/game/downloads/history?userId=${encodeURIComponent(userId || '')}`;
    const res = await fetch(url, { method: 'DELETE', headers: getNodeHeaders() });
    return res.ok;
  },

  async getGameStatus() {
    const url = `${getDownloaderUrl()}/api/game/status`;
    try {
      const res = await fetch(url, { headers: getNodeHeaders(), signal: AbortSignal.timeout(4000) });
      const data = await res.json().catch(() => ({}));
      return { online: res.ok, ...data };
    } catch {
      return { online: false };
    }
  }
};
