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
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Split the rarely-changing vendor code into its own chunks so frequent
        // app edits don't bust their cache. lucide-react is imported as a whole
        // barrel by Icon.tsx (names are resolved at runtime, so it can't be
        // tree-shaken) — isolating it means a deploy only re-downloads the small
        // app chunk, not the ~500KB icon set. Leaflet stays a lazy chunk (loaded
        // only by the Settings map), out of both this and the main bundle.
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          'icons-vendor': ['lucide-react'],
        },
      },
    },
  },
});
