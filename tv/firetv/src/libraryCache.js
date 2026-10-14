/**
 * Local copy of the FireTV drive library.
 *
 * `/api/ondemand` returns the whole catalogue, which is the slowest part of a
 * cold start on the FireTV build. The stored copy paints the shelf immediately
 * and is revalidated against its ETag afterwards, so an unchanged library costs
 * a bodiless 304 instead of the full payload.
 *
 * localStorage matches how this build already keeps its auth token, and the
 * library is small enough for it once JSON-encoded.
 */

const LIBRARY_KEY = 'FREEVEE_drive_library';
const ETAG_KEY = 'FREEVEE_drive_library_etag';

/** Returns `{ library, etag }`, or null when nothing is stored. */
export function readCachedDriveLibrary() {
  try {
    const raw = window.localStorage.getItem(LIBRARY_KEY);
    if (!raw) return null;
    return {
      library: JSON.parse(raw),
      etag: window.localStorage.getItem(ETAG_KEY) || null
    };
  } catch {
    return null;
  }
}

export function writeCachedDriveLibrary(library, etag) {
  try {
    window.localStorage.setItem(LIBRARY_KEY, JSON.stringify(library));
    if (etag) window.localStorage.setItem(ETAG_KEY, etag);
    else window.localStorage.removeItem(ETAG_KEY);
  } catch (err) {
    // Quota or private mode: the cache is best effort, never a hard failure.
    console.warn('[LibraryCache] Could not store the drive library:', err);
  }
}

/** Drops the stored catalogue. Used when signing out. */
export function clearCachedDriveLibrary() {
  try {
    window.localStorage.removeItem(LIBRARY_KEY);
    window.localStorage.removeItem(ETAG_KEY);
  } catch {
    /* nothing to clear */
  }
}