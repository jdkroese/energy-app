import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Dev: Vite serves the UI on :5173 and proxies /api -> the API on :3002.
// The proxy target is overridable via VITE_API_PROXY so a worktree can point at
// its own API instance on a non-default port when :3002 is taken by another
// checkout (multi-agent dev). Prod: nginx serves the built files + proxies /api.
const API_PROXY = process.env.VITE_API_PROXY ?? 'http://127.0.0.1:3002';
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API_PROXY, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
