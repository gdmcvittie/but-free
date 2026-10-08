/**
 * Bridge between the web player and the Android host app (mobile-client).
 *
 * The WebView exposes a `FraudioNative` object via addJavascriptInterface; it
 * mirrors playback state into a native MediaSession so the lock screen and
 * notification get real transport controls, and keeps the app alive with a
 * media-playback foreground service while audio is playing. The native side
 * calls back into `window.fraudioNativeCommand(action, value)` for user
 * interactions (play/pause/next/prev/seek). Everything is a no-op outside
 * the Android WebView so desktop browsers and plain PWA installs are
 * unaffected.
 */

const getBridge = () => {
  if (typeof window === 'undefined') return null;
  return window.FraudioNative && typeof window.FraudioNative.updateState === 'function'
    ? window.FraudioNative
    : null;
};

export function hasNativeBridge() {
  return Boolean(getBridge());
}

/**
 * Check if the host Android app detects Android Auto or Car Mode connection.
 * @returns {boolean}
 */
export function isCarConnected() {
  const bridge = getBridge();
  if (!bridge || typeof bridge.isCarConnected !== 'function') return false;
  try {
    return Boolean(bridge.isCarConnected());
  } catch {
    return false;
  }
}

/**
 * Push playback state + metadata to the native MediaSession.
 * @param {object} state
 * @param {boolean} state.playing
 * @param {number} state.positionSec
 * @param {number} state.durationSec
 * @param {boolean} [state.stop] - true when playback is finished/closed
 * @param {object} [state.meta] - { title, artist, album, coverUrl }
 */
export function pushNativeState({ playing, positionSec = 0, durationSec = 0, stop = false, meta = null }) {
  const bridge = getBridge();
  if (!bridge) return;
  try {
    bridge.updateState(JSON.stringify({
      playing: Boolean(playing),
      positionSec: Math.max(0, Math.floor(positionSec || 0)),
      durationSec: Math.max(0, Math.floor(durationSec || 0)),
      stop: Boolean(stop),
      meta: meta || undefined
    }));
  } catch {
    /* bridge unavailable or page navigating away */
  }
}

/**
 * Register handlers for transport commands coming from the native
 * notification / lock screen / Bluetooth headset.
 * @param {Record<string, (value?: number) => void>} handlers - keys: play, pause, next, prev, seek, rewind, forward
 * @returns {() => void} unregister
 */
export function registerNativeCommands(handlers) {
  if (!getBridge()) return () => {};
  window.fraudioNativeCommand = (action, value) => {
    const fn = handlers[action];
    if (fn) fn(typeof value === 'number' ? value : undefined);
  };
  return () => {
    try {
      delete window.fraudioNativeCommand;
    } catch {
      window.fraudioNativeCommand = undefined;
    }
  };
}
