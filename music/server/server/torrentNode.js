import { config } from './config.js';

/**
 * Thin HTTP client for the remote audiobook torrent node
 * (see ___MY-TV/cloud-only/fraudio-streamer).
 *
 * The node owns peer discovery, the download, and the Google Drive upload.
 * FRAUDIO only dispatches the job and waits for the webhook, which keeps the
 * audio bytes from being copied over the network twice.
 */

export function isConfigured() {
  return Boolean(config.torrent.nodeUrl);
}

function baseUrl() {
  const url = config.torrent.nodeUrl;
  if (!url) throw new Error('No torrent node is configured (set TORRENT_NODE_URL).');
  return url;
}

function headers(extra) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...(config.torrent.nodeKey ? { 'x-node-key': config.torrent.nodeKey } : {}),
    ...extra
  };
}

let cachedBaseUrl = null;
let lastBaseUrlCheck = 0;

function getCandidateUrls() {
  const configured = (config.torrent.nodeUrl || '').replace(/\/+$/, '');
  const candidates = [];
  if (configured) {
    candidates.push(configured);
    if (!configured.includes(':4000')) candidates.push(`${configured}:4000`);
    if (configured.includes(':4000')) candidates.push(configured.replace(':4000', ''));
    if (configured.includes('download.butfree.online')) {
      candidates.push(configured.replace('download.butfree.online', '74.208.22.119'));
    }
  }
  candidates.push('http://74.208.22.119:4000');
  candidates.push('http://74.208.22.119');
  candidates.push('http://download.butfree.online:4000');
  candidates.push('http://download.butfree.online');
  return [...new Set(candidates.filter(Boolean))];
}

async function fetchFromUrl(targetUrl, { method = 'GET', body, timeoutMs } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? config.torrent.requestTimeoutMs);

  try {
    let currentUrl = targetUrl;
    let res;
    for (let hop = 0; hop < 5; hop++) {
      res = await fetch(currentUrl, {
        method,
        headers: headers(currentUrl.includes('74.208.22.119') ? { Host: 'download.butfree.online' } : undefined),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        redirect: 'manual'
      });

      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location');
        if (loc) {
          currentUrl = new URL(loc, currentUrl).href;
          continue;
        }
      }
      break;
    }

    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`Torrent node returned a non-JSON response (HTTP ${res.status}).`);
      }
    }

    if (!res.ok) {
      throw new Error(data?.error || `Torrent node error: HTTP ${res.status}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function request(path, options = {}) {
  const candidates = getCandidateUrls();
  const orderedUrls = [];

  if (cachedBaseUrl && candidates.includes(cachedBaseUrl)) {
    orderedUrls.push(cachedBaseUrl);
  }
  for (const c of candidates) {
    if (!orderedUrls.includes(c)) orderedUrls.push(c);
  }

  let lastErr = null;
  for (const base of orderedUrls) {
    try {
      const fullUrl = `${base}${path}`;
      const data = await fetchFromUrl(fullUrl, options);
      cachedBaseUrl = base;
      lastBaseUrlCheck = Date.now();
      return data;
    } catch (err) {
      lastErr = err;
      // If this candidate was refused or timed out, try the next candidate
      continue;
    }
  }

  if (lastErr?.name === 'AbortError') {
    throw new Error(`Torrent node at ${cachedBaseUrl || baseUrl()} did not respond in time.`);
  }
  throw lastErr || new Error('No candidate torrent node responded.');
}

/** Lightweight reachability probe for the Settings screen. */
export async function health() {
  if (!isConfigured()) {
    return { online: false, configured: false, error: 'No torrent node is configured (set TORRENT_NODE_URL).' };
  }
  try {
    const data = await request('/api/status', { timeoutMs: 6000 });
    return { ...data, online: true, configured: true, targetUrl: cachedBaseUrl || baseUrl() };
  } catch (err) {
    const causeInfo = err.cause?.code || err.cause?.message || '';
    const detail = causeInfo ? `${err.message} (${causeInfo})` : err.message;
    return { online: false, configured: true, error: detail, targetUrl: cachedBaseUrl || baseUrl() };
  }
}

/**
 * Queues a download. The node performs the Drive upload using the supplied
 * credentials, calling `webhookUrl` when finished.
 */
export async function enqueue(payload) {
  const data = await request('/api/download', { method: 'POST', body: payload });
  return data?.job || data;
}

export async function enqueueYoutube(payload) {
  const data = await request('/api/youtube/download', { method: 'POST', body: payload });
  return data?.job || data;
}

export async function getRemoteTracks(playlistId) {
  const data = await request(`/api/youtube/tracks?playlistId=${encodeURIComponent(playlistId)}`);
  return data?.tracks || [];
}

export async function listJobs(userId) {
  const query = userId ? `?userId=${encodeURIComponent(userId)}` : '';
  const data = await request(`/api/downloads${query}`, { timeoutMs: 10000 });
  return data?.downloads || [];
}

export async function getJob(jobId) {
  const data = await request(`/api/download/${encodeURIComponent(jobId)}`);
  return data?.job || null;
}

export async function cancelJob(jobId) {
  return request(`/api/download/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
}

export async function restartNode() {
  return request('/api/restart', { method: 'POST', timeoutMs: 8000 });
}

export async function getCookies() {
  return request('/api/cookies', { method: 'GET', timeoutMs: 10000 });
}

export async function updateCookies(content) {
  return request('/api/cookies', { method: 'POST', body: { content }, timeoutMs: 15000 });
}

export default { isConfigured, health, enqueue, enqueueYoutube, getRemoteTracks, listJobs, getJob, cancelJob, restartNode, getCookies, updateCookies };