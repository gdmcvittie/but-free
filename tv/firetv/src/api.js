// API client for the FREEVEE server. Mirrors the roku-cloud app's HttpTask +
// registry usage, adapted for a browser environment (localStorage for the token).
// The main server URL is fixed (like the Roku app) and pairing is done through
// the cloud web app's /device flow.

const SERVER_URL = 'https://tv.butfree.online';
const TORRENT_SERVER_URL = 'http://download.butfree.online';
const STORAGE_KEY_TOKEN = 'FREEVEE_auth_token';
const STORAGE_KEY_USER = 'FREEVEE_auth_user';

export function getServerUrl() {
  return SERVER_URL;
}

export function getTorrentServerUrl() {
  return TORRENT_SERVER_URL;
}

export function getToken() {
  try {
    return localStorage.getItem(STORAGE_KEY_TOKEN) || '';
  } catch {
    return '';
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(STORAGE_KEY_TOKEN, token);
    else localStorage.removeItem(STORAGE_KEY_TOKEN);
  } catch {}
}

export function getStoredUser() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_USER);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setStoredUser(user) {
  try {
    if (user) localStorage.setItem(STORAGE_KEY_USER, JSON.stringify(user));
    else localStorage.removeItem(STORAGE_KEY_USER);
  } catch {}
}

export function clearAuth() {
  setToken('');
  setStoredUser(null);
}

export function isLoggedIn() {
  return !!getToken();
}

async function httpGet(path, auth = false) {
  const opts = {};
  if (auth && isLoggedIn()) {
    opts.headers = { Authorization: `Bearer ${getToken()}` };
  }
  const res = await fetch(SERVER_URL + path, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function httpSend(path, method, body, auth = false) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  if (auth && isLoggedIn()) {
    opts.headers['Authorization'] = `Bearer ${getToken()}`;
  }
  const res = await fetch(SERVER_URL + path, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

async function torrentSend(path, body) {
  const opts = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(TORRENT_SERVER_URL + path, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

export const api = {
  // ---- Pairing / Auth ----
  getPairingCode: () => httpGet('/auth/device/code'),
  getPairingStatus: (code) => httpGet(`/auth/device/status/${encodeURIComponent(code)}`),
  getPairingToken: (code) => httpGet(`/auth/device/token/${encodeURIComponent(code)}`),

  // ---- Drive library / Favorites (require auth) ----
  getOnDemand: () => httpGet('/api/ondemand', true),
  getFavorites: () => httpGet('/api/favorites', true),
  toggleFavorite: (item) => httpSend('/api/favorites/toggle', 'POST', { item }, true),
  sendPlaybackProgress: (data) => httpSend('/api/playback/progress', 'POST', data, true),

  // ---- Services ----
  getServices: () => httpGet('/api/services'),
  getServiceCatalog: (serviceId, force = false) => httpGet(`/api/services/${encodeURIComponent(serviceId)}${force ? '?force=true' : ''}`),
  getTvDetails: (title) => httpGet(`/api/services/tv-details?title=${encodeURIComponent(title)}`),

  // ---- What's On / Fresh ----
  getWhatsOn: () => httpGet('/api/whatson?roku=1'),

  // ---- Free TV ----
  getFreeTvChannels: () => httpGet('/api/freetv/channels'),

  // ---- Torrents ----
  torrentSearch: (type, q) =>
    httpGet(`/api/torrent-search?q=${encodeURIComponent(q)}&type=${encodeURIComponent(type)}`),
  startTorrentStream: async (url) => {
    try {
      return await httpSend('/api/torrent/stream', 'POST', { url });
    } catch (err) {
      console.warn('[FireTV] Proxy stream dispatch failed, attempting direct torrent node:', err.message);
      return await torrentSend('/api/torrent/stream', { url });
    }
  },
  stopTorrentHls: (streamId, fileIndex = 0) =>
    httpSend('/api/stream/torrent-hls/stop', 'POST', { streamId, fileIndex }),

  // ---- Stream URL builders ----
  // Drive content is served by the cloud byte-range proxy so the browser can
  // play it natively (no transcoding needed, unlike the Roku HLS route).
  driveStreamUrl: (driveId) => {
    const base = `${SERVER_URL}/api/stream/drive/${encodeURIComponent(driveId)}`;
    return isLoggedIn() ? `${base}?token=${encodeURIComponent(getToken())}` : base;
  },
  freeTvStreamUrl: (channel) => {
    if (!channel) return '';
    let streamKey = channel.plutoId || '';
    if (!streamKey) {
      streamKey = channel.id || '';
      if (streamKey.startsWith('freetv_')) streamKey = streamKey.slice(7);
    }
    let stream = `${SERVER_URL}/api/freetv/stream/${encodeURIComponent(streamKey)}.m3u8`;
    if (channel.streamUrl) {
      if (channel.streamUrl.startsWith('http')) stream = channel.streamUrl;
      else stream = SERVER_URL + channel.streamUrl;
    }
    return stream;
  },
  torrentHlsStreamUrl: (streamId, fileIndex = 0) => {
    return `${SERVER_URL}/api/stream/torrent-hls/${encodeURIComponent(streamId)}/${fileIndex}.m3u8`;
  },
  torrentFileUrl: (streamId, fileIndex) => {
    return `${SERVER_URL}/api/torrent/serve/${encodeURIComponent(streamId)}/${fileIndex}`;
  },
  resolvePosterUrl: (poster, fallback = 'images/no-poster.jpg') => {
    if (!poster) return fallback;
    let p = String(poster);
    if (p.startsWith('pkg:/')) {
      p = p.replace('pkg:/', '');
    }
    if (p.startsWith('/images/')) {
      p = p.replace('/images/', 'images/');
    }
    if (p.startsWith('images/')) {
      return p;
    }
    if (p.toLowerCase().startsWith('http')) return p;

    if (p.startsWith('/')) {
      let url = `${SERVER_URL}${p}`;
      if (p.includes('/api/whatson/poster') && !p.includes('thumb=1')) {
        url += p.includes('?') ? '&thumb=1' : '?thumb=1';
      }
      return url;
    }
    return `${SERVER_URL}/api/media/poster?path=${encodeURIComponent(p)}&thumb=1`;
  }
};