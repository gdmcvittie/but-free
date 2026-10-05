import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5176,
    proxy: {
      '/api': 'http://localhost:5500',
      '/auth': 'http://localhost:5500'
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
});
