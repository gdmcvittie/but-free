export function apiUrl(path = '') {
  if (!path.startsWith('/')) path = `/${path}`;
  return path;
}

export async function fetchJson(path, options = {}) {
  const res = await fetch(apiUrl(path), {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('freeplay:unauthorized'));
  }
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    if (data.code) err.code = data.code;
    if (data.fileId) err.fileId = data.fileId;
    throw err;
  }
  return data;
}

/**
 * Conditional GET, used for the (large) library payload.
 *
 * Sends If-None-Match so an unchanged shelf comes back as a bodiless 304.
 * Resolves to `{ data, etag, notModified }` so the caller can persist the ETag
 * and revalidate cheaply next time.
 */
export async function fetchJsonConditional(path, etag, options = {}) {
  const res = await fetch(apiUrl(path), {
    ...options,
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      ...(etag ? { 'If-None-Match': etag } : {}),
      ...(options.headers || {})
    }
  });
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('freeplay:unauthorized'));
  }
  // The conditional hit itself: nothing to parse, nothing to send.
  if (res.status === 304) {
    return { data: null, etag: etag || null, notModified: true };
  }

  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    if (data.code) err.code = data.code;
    if (data.fileId) err.fileId = data.fileId;
    throw err;
  }
  return { data, etag: res.headers.get('ETag'), notModified: false };
}
