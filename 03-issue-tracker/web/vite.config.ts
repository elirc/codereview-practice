import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The dev server proxies /api so the browser sees one origin (APP_ORIGIN on the server).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5303,
    strictPort: true,
    proxy: {
      '/api': { target: process.env.API_URL ?? 'http://127.0.0.1:3003' },
    },
  },
});
