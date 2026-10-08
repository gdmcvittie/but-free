export const RATES = [1, 1.25, 1.5, 1.75, 2];
export const AUDIOBOOK_SPEED_STORAGE_KEY = 'fraudio.audiobookSpeed';
export const AUDIOBOOK_RATE_INDEX_STORAGE_KEY = 'fraudio.audiobookRateIndex';

/**
 * Returns the saved audiobook rate index (0 to 4 corresponding to RATES).
 * Default is 0 (1x).
 */
export function getSavedAudiobookRateIndex() {
  try {
    const savedIdx = localStorage.getItem(AUDIOBOOK_RATE_INDEX_STORAGE_KEY);
    if (savedIdx !== null) {
      const parsed = parseInt(savedIdx, 10);
      if (!isNaN(parsed) && parsed >= 0 && parsed < RATES.length) {
        return parsed;
      }
    }
    const savedSpeed = parseFloat(localStorage.getItem(AUDIOBOOK_SPEED_STORAGE_KEY) || '1');
    const matchIdx = RATES.indexOf(savedSpeed);
    return matchIdx !== -1 ? matchIdx : 0;
  } catch {
    return 0;
  }
}

/**
 * Saves the global audiobook rate index and dispatches an update event.
 */
export function saveAudiobookRateIndex(index) {
  try {
    const validIdx = Math.max(0, Math.min(RATES.length - 1, index));
    localStorage.setItem(AUDIOBOOK_RATE_INDEX_STORAGE_KEY, String(validIdx));
    localStorage.setItem(AUDIOBOOK_SPEED_STORAGE_KEY, String(RATES[validIdx]));
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('fraudio:audiobook-speed-changed', {
        detail: { rateIndex: validIdx, speed: RATES[validIdx] }
      }));
    }
    return validIdx;
  } catch {
    return index;
  }
}
