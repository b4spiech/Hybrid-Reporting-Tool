import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Static SPA, no backend. Relative base so it works behind a Cloudflare Tunnel
// mounted at any path.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    proxy: {
      // Proxy API calls to the local backend (better-sqlite3 service).
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
});
