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

async function request(path, { method = 'GET', body, timeoutMs } = {}) {
  const url = `${baseUrl()}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? config.torrent.requestTimeoutMs);

  try {
    let currentUrl = url;
    let res;
    for (let hop = 0; hop < 5; hop++) {
      res = await fetch(currentUrl, {
        method,
        headers: headers(),
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
        // If download.butfree.online returned an HTML page (cPanel local loopback / unpropagated DNS),
        // fallback to VPS IP with Host header to reach Nginx on the VPS directly
        if (currentUrl.includes('download.butfree.online')) {
          try {
            const directUrl = currentUrl.replace('download.butfree.online', '74.208.22.119');
            const fallbackRes = await fetch(directUrl, {
              method,
              headers: headers({ Host: 'download.butfree.online' }),
              body: body === undefined ? undefined : JSON.stringify(body),
              signal: controller.signal
            });
            const fallbackText = await fallbackRes.text();
            data = JSON.parse(fallbackText);
            if (fallbackRes.ok) return data;
          } catch (_) {}
        }
        throw new Error(`Torrent node returned a non-JSON response (HTTP ${res.status}).`);
      }
    }

    if (!res.ok) {
      if (currentUrl.includes('download.butfree.online')) {
        try {
          const directUrl = currentUrl.replace('download.butfree.online', '74.208.22.119');
          const fallbackRes = await fetch(directUrl, {
            method,
            headers: headers({ Host: 'download.butfree.online' }),
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: controller.signal
          });
          const fallbackText = await fallbackRes.text();
          const fallbackData = JSON.parse(fallbackText);
          if (fallbackRes.ok) return fallbackData;
        } catch (_) {}
      }
      throw new Error(data?.error || `Torrent node error: HTTP ${res.status}`);
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Torrent node at ${baseUrl()} did not respond in time.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Lightweight reachability probe for the Settings screen. */
export async function health() {
  // `configured` reflects FRAUDIO's own env, while `online` is the live probe.
  // Both are placed after the spread so the node's payload cannot override them.
  if (!isConfigured()) {
    return { online: false, configured: false, error: 'No torrent node is configured (set TORRENT_NODE_URL).' };
  }
  try {
    const data = await request('/api/status', { timeoutMs: 6000 });
    return { ...data, online: true, configured: true, targetUrl: baseUrl() };
  } catch (err) {
    const causeInfo = err.cause?.code || err.cause?.message || '';
    const detail = causeInfo ? `${err.message} (${causeInfo})` : err.message;
    return { online: false, configured: true, error: detail, targetUrl: baseUrl() };
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

export default { isConfigured, health, enqueue, enqueueYoutube, getRemoteTracks, listJobs, getJob, cancelJob, restartNode };