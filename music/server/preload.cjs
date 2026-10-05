// Preload for the FRAUDIO shell. Written as CommonJS (.cjs): Electron's sandboxed
// preload can only `require('electron')`, and this project's package.json sets
// "type": "module", which would force a .js preload down the ESM path Electron
// rejects in the sandbox.
const { contextBridge, ipcRenderer } = require('electron');

/**
 * Minimal, explicit bridge for the desktop-only extras. The renderer uses
 * `window.fraudioDesktop` existing at all to decide whether the app runs
 * inside the Electron shell; nothing else is exposed.
 */
contextBridge.exposeInMainWorld('fraudioDesktop', {
  /**
   * Opens a real YouTube Music window for the user to sign in, then captures
   * the session cookies (including httpOnly ones no page script can read) and
   * writes them as a Netscape cookies.txt for yt-dlp.
   * Resolves { ok, path?, count?, reason? } - never rejects.
   */
  ytmCaptureCookies: () => ipcRenderer.invoke('ytm:capture-cookies'),
  ytmClearCookies: () => ipcRenderer.invoke('ytm:clear-cookies')
});
