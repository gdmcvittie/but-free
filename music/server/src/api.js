/**
 * FRAUDIO API client.
 *
 * One place that knows how to talk to the Express server. Every call is same-origin
 * (`API_BASE` is empty) because the server serves the built SPA and the API from
 * the same Express process in both dev (via the Vite proxy) and the Electron shell.
 *
 * A 401 anywhere means the session cookie expired, so we raise a single global
 * event rather than making every caller handle it.
 */

export const API_BASE = '';

export function apiUrl(path) {
  const clean = path.startsWith('/') ? path : `/${path}`;
  return `${API_BASE}${clean}`;
}

async function request(path, { method = 'GET', body, signal } = {}) {
  const res = await fetch(apiUrl(path), {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const data = await res.json().catch(() => ({}));

  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('fraudio:unauthorized'));
  }

  if (!res.ok) {
    throw new Error(data.error || `Request failed: HTTP ${res.status}`);
  }
  return data;
}

const get = (path, options) => request(path, options);
const post = (path, body, options) => request(path, { ...options, method: 'POST', body: body ?? {} });
const patch = (path, body) => request(path, { method: 'PATCH', body: body ?? {} });
const del = (path) => request(path, { method: 'DELETE' });

export const api = {
  // ---- auth ----------------------------------------------------------
  me: () => get('/api/auth/me'),
  googleUrl: () => get('/api/auth/google/url'),
  logout: () => post('/api/auth/logout'),

  // ---- drive ---------------------------------------------------------
  driveStatus: () => get('/api/drive/status'),
  listFolders: (parentId = 'root') => get(`/api/drive/folders?parentId=${encodeURIComponent(parentId)}`),
  createFolder: (name, parentId = 'root') => post('/api/drive/folders', { name, parentId }),
  selectFolder: (kind, folderId, folderName) =>
    post('/api/drive/select-folder', { kind, folderId, folderName }),

  // ---- library -------------------------------------------------------
  library: (kind) => get(`/api/library?kind=${encodeURIComponent(kind)}`),
  libraryGroups: (kind) => get(`/api/library/groups?kind=${encodeURIComponent(kind)}`),
  scanLibrary: (kind) => post('/api/library/scan', { kind }),

  // ---- items ---------------------------------------------------------
  coverUrl: (itemId) => apiUrl(`/api/items/${encodeURIComponent(itemId)}/cover`),
  streamUrl: (itemId) => apiUrl(`/api/items/${encodeURIComponent(itemId)}/stream`),
  updateItem: (itemId, updates) => patch(`/api/items/${encodeURIComponent(itemId)}`, updates),
  deleteItem: (itemId, fromDrive = true) =>
    del(`/api/items/${encodeURIComponent(itemId)}?fromDrive=${fromDrive ? 'true' : 'false'}`),

  // ---- progress ------------------------------------------------------
  progress: () => get('/api/progress'),
  // Scoped to one library - audiobooks and music never share a continue list.
  continueListening: (kind) => get(`/api/progress/continue?kind=${encodeURIComponent(kind)}`),
  saveProgress: (itemId, positionSec, durationSec) =>
    post('/api/progress', { itemId, positionSec, durationSec }),
  clearProgress: (itemId) => del(`/api/progress/${encodeURIComponent(itemId)}`),

  // ---- favourites ----------------------------------------------------
  favorites: (kind) => get(`/api/favorites?kind=${encodeURIComponent(kind)}`),
  setFavorite: (itemId, isFavorite) => post('/api/favorites', { itemId, isFavorite }),
  setFavoritesBulk: (itemIds, isFavorite) => post('/api/favorites', { itemIds, isFavorite }),
  setAuthorFavorite: (name, isFavorite, kind) => post('/api/favorites/author', { name, isFavorite, kind }),
  setAlbumFavorite: (artist, album, isFavorite) => post('/api/favorites/album', { artist, album, isFavorite }),

  // ---- playlists -----------------------------------------------------
  playlists: (kind) => get(`/api/playlists?kind=${encodeURIComponent(kind)}`),
  createPlaylist: (name, kind) => post('/api/playlists', { name, kind }),
  playlist: (id) => get(`/api/playlists/${encodeURIComponent(id)}`),
  renamePlaylist: (id, name) => patch(`/api/playlists/${encodeURIComponent(id)}`, { name }),
  addToPlaylist: (id, itemIds) => post(`/api/playlists/${encodeURIComponent(id)}/items`, { itemIds }),
  deletePlaylist: (id) => del(`/api/playlists/${encodeURIComponent(id)}`),

  // ---- offline -------------------------------------------------------
  offline: () => get('/api/offline'),
  cacheOffline: (itemId) => post('/api/offline', { itemId }),
  removeOffline: (itemId) => del(`/api/offline/${encodeURIComponent(itemId)}`),

  // ---- what's new (AudioBookBay) -------------------------------------
  whatsNew: (page = 1, category = null) => {
    const params = new URLSearchParams({ page: String(page) });
    if (category) params.set('category', category);
    return get(`/api/whats-new?${params.toString()}`);
  },
  whatsNewCategories: () => get('/api/whats-new/categories'),
  abbDetail: (url) => get(`/api/abb/detail?url=${encodeURIComponent(url)}`),
  markAbbSeen: (ids) => post('/api/abb/mark-seen', Array.isArray(ids) ? { ids } : { id: ids }),
  abbSession: () => get('/api/abb/session'),
  abbLogin: () => post('/api/abb/login'),

  // ---- music: YouTube Music new releases --------------------------------
  musicWhatsNew: (refresh = false) =>
    get(`/api/music/whats-new${refresh ? '?refresh=true' : ''}`),
  albumTracks: (playlistId) =>
    get(`/api/music/album/tracks?playlistId=${encodeURIComponent(playlistId)}`),
  downloadAlbum: (album) => post('/api/music/album/download', album),
  albumDownload: (jobId) => get(`/api/music/album/download/${encodeURIComponent(jobId)}`),

  // ---- music: search & artists ------------------------------------------
  musicSearch: (q, refresh = false, signal) =>
    get(`/api/music/search?q=${encodeURIComponent(q)}${refresh ? '&refresh=true' : ''}`, { signal }),
  musicArtist: (channelId, refresh = false, signal) =>
    get(`/api/music/artist/${encodeURIComponent(channelId)}${refresh ? '?refresh=true' : ''}`, { signal }),
  downloadSongs: (songs) => post('/api/music/song/download', { songs }),

  // ---- music: playlist imports ---------------------------------------
  musicPlaylistInfo: (url, refresh = false, signal) =>
    get(`/api/music/playlist/info?url=${encodeURIComponent(url)}${refresh ? '&refresh=true' : ''}`, { signal }),
  downloadPlaylist: ({ url, name }) => post('/api/music/playlist/download', { url, name }),

  // ---- music: Liked Music via the YouTube Data API (OAuth, no cookies) --
  youtubeLiked: () => get('/api/youtube/liked'),
  youtubePlaylists: () => get('/api/youtube/playlists'),
  importLikedMusic: () => post('/api/youtube/liked/import', {}),

  // ---- music: smart playlists (keyword rules) -------------------------
  smartPlaylists: () => get('/api/smart-playlists'),
  createSmartPlaylist: (name, keywords) => post('/api/smart-playlists', { name, keywords }),
  deleteSmartPlaylist: (id) => del(`/api/smart-playlists/${encodeURIComponent(id)}`),
  applySmartPlaylists: () => post('/api/smart-playlists/apply', {}),
  seedSmartPlaylists: () => post('/api/smart-playlists/presets', {}),

  // ---- music: download queue ----------------------------------------
  musicJobs: () => get('/api/music/jobs'),
  musicJob: (jobId) => get(`/api/music/jobs/${encodeURIComponent(jobId)}`),
  cancelMusicJob: (jobId) => post(`/api/music/jobs/${encodeURIComponent(jobId)}/cancel`, {}),

  // ---- downloads -----------------------------------------------------
  startDownload: (url, detail = null) => post('/api/downloads', { url, detail }),
  downloads: () => get('/api/downloads'),
  downloadStatus: (jobId) => get(`/api/downloads/status/${encodeURIComponent(jobId)}`),
  cancelDownload: (jobId) => post(`/api/downloads/${encodeURIComponent(jobId)}/cancel`),
  torrentNode: () => get('/api/downloads/node'),

  // ---- misc ----------------------------------------------------------
  search: (q, kind, signal) =>
    get(`/api/search?q=${encodeURIComponent(q)}&kind=${encodeURIComponent(kind)}`, { signal }),
  settings: () => get('/api/settings'),
  saveSettings: (patchBody) => post('/api/settings', patchBody),
  health: () => get('/api/health'),

  // ---- admin ---------------------------------------------------------
  restartStreamer: () => post('/api/admin/restart-streamer'),
  restartAppServer: () => post('/api/admin/restart-app')
};

/**
 * Subscribes to the server's SSE stream.
 *
 * Returns an unsubscribe function. The server replays a short ring buffer on
 * reconnect, so a dropped connection self-heals without extra bookkeeping here.
 */
export function subscribeToEvents(handlers) {
  if (typeof EventSource === 'undefined') return () => {};

  const source = new EventSource(apiUrl('/api/events'));
  const entries = Object.entries(handlers).filter(([, fn]) => typeof fn === 'function');

  for (const [type, fn] of entries) {
    source.addEventListener(type, (event) => {
      let payload = {};
      try {
        payload = JSON.parse(event.data);
      } catch {
        payload = {};
      }
      fn(payload, event);
    });
  }

  return () => source.close();
}