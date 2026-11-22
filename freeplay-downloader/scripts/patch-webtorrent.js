// Auto-patch uint8-util and webtorrent to fix ERR_INVALID_ARG_TYPE crash on Node 24
// In Node 24 / webtorrent 2.6.2, webtorrent/lib/torrent.js passes parsedTorrent.infoHash
// (which is already a hex string) to arr2hex(data). uint8-util's arr2hex attempts Buffer.from(data.buffer)
// which throws TypeError [ERR_INVALID_ARG_TYPE] because data.buffer is undefined.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const baseDir = path.resolve(__dirname, '..');

export function patchWebTorrent() {
  let changed = false;

  // 1. Patch uint8-util/dist/src/node.js
  const nodeUtilPath = path.join(baseDir, 'node_modules', 'uint8-util', 'dist', 'src', 'node.js');
  if (fs.existsSync(nodeUtilPath)) {
    try {
      let content = fs.readFileSync(nodeUtilPath, 'utf8');
      const target = "export const arr2hex = (data) => Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('hex');";
      const replacement = "export const arr2hex = (data) => {\n    if (typeof data === 'string') return data;\n    if (!data) return '';\n    return Buffer.from(data.buffer || data, data.byteOffset, data.byteLength).toString('hex');\n};";
      if (content.includes(target)) {
        content = content.replace(target, replacement);
        fs.writeFileSync(nodeUtilPath, content, 'utf8');
        console.log('[Patch] Successfully patched uint8-util node.js');
        changed = true;
      }
    } catch (err) {
      console.warn('[Patch] Failed to patch uint8-util node.js:', err.message);
    }
  }

  // 2. Patch uint8-util/dist/src/browser.js
  const browserUtilPath = path.join(baseDir, 'node_modules', 'uint8-util', 'dist', 'src', 'browser.js');
  if (fs.existsSync(browserUtilPath)) {
    try {
      let content = fs.readFileSync(browserUtilPath, 'utf8');
      const target = "export const arr2hex = (data) => data.toHex();";
      const replacement = "export const arr2hex = (data) => {\n    if (typeof data === 'string') return data;\n    if (!data) return '';\n    return data.toHex ? data.toHex() : '';\n};";
      if (content.includes(target)) {
        content = content.replace(target, replacement);
        fs.writeFileSync(browserUtilPath, content, 'utf8');
        console.log('[Patch] Successfully patched uint8-util browser.js');
        changed = true;
      }
    } catch (err) {
      console.warn('[Patch] Failed to patch uint8-util browser.js:', err.message);
    }
  }

  // 3. Patch webtorrent/lib/torrent.js line 281 and line 302 defensively
  const wtTorrentPath = path.join(baseDir, 'node_modules', 'webtorrent', 'lib', 'torrent.js');
  if (fs.existsSync(wtTorrentPath)) {
    try {
      let content = fs.readFileSync(wtTorrentPath, 'utf8');
      const target = "this._debugId = arr2hex(parsedTorrent.infoHash).substring(0, 7)";
      const replacement = "this._debugId = (typeof parsedTorrent.infoHash === 'string' ? parsedTorrent.infoHash : arr2hex(parsedTorrent.infoHash)).substring(0, 7)";
      if (content.includes(target)) {
        content = content.replaceAll(target, replacement);
        fs.writeFileSync(wtTorrentPath, content, 'utf8');
        console.log('[Patch] Successfully patched webtorrent lib/torrent.js');
        changed = true;
      }
    } catch (err) {
      console.warn('[Patch] Failed to patch webtorrent lib/torrent.js:', err.message);
    }
  }

  return changed;
}

// Run immediately if executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  patchWebTorrent();
}
