import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function copyMobileIconsPlugin() {
  return {
    name: 'copy-mobile-icons',
    buildStart() {
      try {
        const src = 'C:\\Users\\yifna\\.gemini\\antigravity-ide\\brain\\4bb77b88-8636-4147-81b9-9ef558964771\\fraudio_app_icon_1791054128607.jpg';
        const destDir = path.resolve('mobile-client/app/src/main/res/drawable');
        const pubDir = path.resolve('public');
        if (fs.existsSync(src)) {
          fs.mkdirSync(destDir, { recursive: true });
          fs.mkdirSync(pubDir, { recursive: true });
          fs.copyFileSync(src, path.join(destDir, 'ic_launcher.png'));
          fs.copyFileSync(src, path.join(destDir, 'icon_512.png'));
          fs.copyFileSync(src, path.join(destDir, 'icon_192.png'));
          fs.copyFileSync(src, path.join(pubDir, 'icon-512.png'));
          fs.copyFileSync(src, path.join(pubDir, 'icon-192.png'));
          fs.copyFileSync(src, path.join(pubDir, 'apple-touch-icon.png'));
          console.log('[VitePlugin] Copied mobile-client and PWA icons.');
        }

        // Also ensure fraudio.apk from mobile-client build is copied into public if built
        const apkSrc = path.resolve('mobile-client/app/build/outputs/apk/debug/app-debug.apk');
        const apkDest = path.join(pubDir, 'fraudio.apk');
        if (fs.existsSync(apkSrc)) {
          fs.copyFileSync(apkSrc, apkDest);
          console.log('[VitePlugin] Synced fraudio.apk to public/fraudio.apk');
        }
      } catch (err) {
        console.warn('[VitePlugin] Could not copy icons/APK:', err.message);
      }
    }
  };
}

// FRAUDIO - local Node server + Vite dev client.
// The Express API always lives on PORT (default 5100); Vite proxies to it in dev.
export default defineConfig({
  plugins: [react(), copyMobileIconsPlugin()],
  envDir: path.resolve(__dirname, '../../'),
  build: {
    outDir: 'dist',
    emptyOutDir: true
  },
  server: {
    port: 5174,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5100',
        changeOrigin: true
      },
      '/covers': {
        target: 'http://127.0.0.1:5100',
        changeOrigin: true
      },
      '/stream': {
        target: 'http://127.0.0.1:5100',
        changeOrigin: true
      }
    }
  }
});
