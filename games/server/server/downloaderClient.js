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
  }
};
