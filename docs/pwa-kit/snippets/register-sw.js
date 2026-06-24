// Add to apps/web/src/main.tsx (after the React mount), or any entry module.
// Registers the service worker once the page has loaded.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('SW registration failed:', err);
    });
  });
}
