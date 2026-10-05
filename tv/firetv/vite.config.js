import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Fire TV build. The app is opened in the Fire TV WebView/Amazon Web App and
// talks to the FREEVEE server (tv.butfree.online). Pairing login is done
// through the cloud web app at /device.
export default defineConfig({
  // Served under /firetv and /firetv-cloud, so asset URLs must be relative to that base.
  base: './',
  envDir: path.resolve(__dirname, '../../..'),
  plugins: [react()],
  server: {
    host: true,
    port: 5175
  },
  build: {
    outDir: 'dist',
    target: 'es2015',
    cssCodeSplit: false,
    minify: false,
    rollupOptions: {
      output: {
        format: 'iife',
        inlineDynamicImports: true
      }
    }
  }
})