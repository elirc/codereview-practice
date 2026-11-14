import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// API_TARGET picks the server instance this dev server proxies to (see the README's two-instance recipe).
const target = process.env.API_TARGET ?? 'http://localhost:8100';
const port = Number(process.env.WEB_PORT ?? 5180);

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  server: {
    port,
    strictPort: true,
    proxy: {
      '/api': { target },
      '/ws': { target, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
