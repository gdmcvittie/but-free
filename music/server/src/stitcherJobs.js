/**
 * Client-side persistence for Audio Tools jobs.
 *
 * Stitching and batch conversion run entirely inside the server process, so
 * closing the tab does not stop them. Remembering the active job id lets the
 * UI re-attach to the live progress after a reload instead of losing it along
 * with the React state.
 */

export const ACTIVE_STITCH_JOB_KEY = 'fraudio.stitcher.activeStitchJob';
export const ACTIVE_CONVERT_JOB_KEY = 'fraudio.stitcher.activeConvertJob';

export function readActiveJob(key) {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.jobId === 'string' && parsed.jobId ? parsed : null;
  } catch {
    return null;
  }
}

export function writeActiveJob(key, jobId) {
  try {
    if (!jobId) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, JSON.stringify({ jobId, savedAt: Date.now() }));
  } catch {
    /* storage can be unavailable (private mode, quota) */
  }
}

export function clearActiveJob(key) {
  writeActiveJob(key, null);
}

export function hasActiveJob() {
  return Boolean(readActiveJob(ACTIVE_STITCH_JOB_KEY) || readActiveJob(ACTIVE_CONVERT_JOB_KEY));
}
