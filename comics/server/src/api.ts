/**
 * Centralized API routing utility.
 */
export const API_BASE = '';

export function apiUrl(path: string): string {
  const clean = path.startsWith('/') ? path : `/${path}`;
  return `${API_BASE}${clean}`;
}

export type DownloadJobStatusValue =
  | 'queued'
  | 'downloading'
  | 'compressing'
  | 'uploading'
  | 'done'
  | 'error';

export interface DownloadJobStatus {
  id: string;
  status: DownloadJobStatusValue;
  phase?: string;
  percent?: number;
  message?: string;
  error?: string | null;
  result?: any;
}

export interface DownloadProgressOptions {
  onProgress?: (status: DownloadJobStatus) => void;
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Kicks off a download on the server and resolves with the raw POST response.
 * New servers return `{ jobId }` immediately; older servers return the finished
 * result inline once the request completes.
 */
async function postDownload(url: string, seriesName?: string): Promise<any> {
  const res = await fetch(apiUrl('/api/scrape/download'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, seriesName })
  });

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new Error(`Download failed: HTTP ${res.status} (server did not return JSON)`);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error(data.error || `Download failed: HTTP ${res.status}`);
  }
  return data;
}

/**
 * Polls a background download job until it finishes, then resolves with the result.
 */
export async function pollComicDownload(
  jobId: string,
  options: DownloadProgressOptions = {}
): Promise<any> {
  const intervalMs = options.intervalMs ?? 2500;
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
  const startedAt = Date.now();
  let consecutiveTransientErrors = 0;

  for (;;) {
    if (options.signal?.aborted) throw new Error('Download cancelled');

    let res: Response;
    let data: DownloadJobStatus;

    try {
      res = await fetch(apiUrl(`/api/scrape/download/status/${encodeURIComponent(jobId)}`), {
        cache: 'no-store'
      });
      data = await res.json().catch(() => ({} as DownloadJobStatus));
    } catch (fetchErr: any) {
      consecutiveTransientErrors++;
      if (consecutiveTransientErrors > 5) {
        throw new Error(`Download status unreachable: ${fetchErr.message || fetchErr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      continue;
    }

    if (!res.ok || (data as any).error) {
      // If the backend has an explicit failed state (e.g. mirror failure, upload failure)
      if (data.status === 'error') {
        throw new Error(data.error || data.message || 'Download failed');
      }

      // Tolerates brief 404/502/503 during multi-process job registration or filesystem sync
      if ((res.status === 404 || res.status >= 500) && consecutiveTransientErrors < 5) {
        consecutiveTransientErrors++;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        continue;
      }

      throw new Error((data as any).error || `Download status failed: HTTP ${res.status}`);
    }

    consecutiveTransientErrors = 0;
    options.onProgress?.(data);

    if (data.status === 'done') return data.result;
    if (data.status === 'error') throw new Error(data.error || data.message || 'Download failed');

    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Download timed out. Please try again.');
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Starts a download and waits for it to complete.
 *
 * New servers reply immediately with a job id which we poll. Older servers process
 * the whole download inline and return the finished result directly, so we accept
 * that result too (avoids rejecting a download that actually succeeded).
 */
export async function downloadComic(
  url: string,
  seriesName?: string,
  options: DownloadProgressOptions = {}
): Promise<any> {
  const data = await postDownload(url, seriesName);

  if (data.jobId) {
    return pollComicDownload(data.jobId, options);
  }

  // Legacy inline response: the download already finished.
  if (data.success || data.title || data.comic) {
    options.onProgress?.({ id: 'inline', status: 'done', percent: 100, message: data.message });
    return data;
  }

  throw new Error('Server did not start a download job. Please update and restart the cloud server.');
}
