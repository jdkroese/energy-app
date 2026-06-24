import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Dev: Vite serves the UI on :5173 and proxies /api -> the API on :3002.
// Prod: nginx serves the built static files and proxies /api itself.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3002', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
