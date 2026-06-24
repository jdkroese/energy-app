# Power PWA kit — make energy.hirobo.nl installable on iOS (no App Store)

Drop-in assets so the web app installs to the iPhone home screen via Safari →
**Share → Add to Home Screen**, launches full-screen, and supports Web Push
(iOS 16.4+, once installed). Designed for the `apps/web` Vite project.

## Files
```
public/
  manifest.webmanifest      → apps/web/public/manifest.webmanifest
  sw.js                     → apps/web/public/sw.js
  offline.html              → apps/web/public/offline.html
  icons/                    → apps/web/public/icons/   (all PNGs)
snippets/
  head.html                 → paste into apps/web/index.html <head>
  register-sw.js            → add to apps/web/src/main.tsx
  install-hint.js           → optional iOS "Add to Home Screen" bar
gen-icons.cjs               → regenerate icons (node gen-icons.cjs) if the mark changes
```

## Wire-up (4 steps)
1. **Copy** everything under `public/` into `apps/web/public/` (Vite serves
   `public/` from the web root, so `/manifest.webmanifest`, `/sw.js`, `/icons/*`
   resolve at runtime — and CI already rsyncs `apps/web/dist` → `/var/www/energy`).
2. **Head**: paste `snippets/head.html` into `apps/web/index.html` `<head>`.
3. **Register SW**: append `snippets/register-sw.js` to `apps/web/src/main.tsx`.
4. **Install hint** (optional): import `install-hint.js`, or port it to a small
   React component mounted once.

## Safe-area CSS (important for the dark control-room look on iPhone)
With `status-bar-style: black-translucent`, content sits under the status bar and
home indicator. Pad the shell with the safe-area insets (Tailwind 4 example):
```css
/* top of the app header */
.app-shell { padding-top: env(safe-area-inset-top); }
/* the bottom tab bar */
.tab-bar   { padding-bottom: calc(10px + env(safe-area-inset-bottom)); }
```
The mockups' bottom tab bar should use this so it clears the home indicator.

## iOS reality (set expectations)
- **No auto install prompt** — users add via Share → Add to Home Screen. The
  optional hint bar nudges first-time iOS Safari visitors.
- **Web Push** works only after it's installed to the home screen + permission
  granted (iOS 16.4+). Wire the actual push subscription when the alerts backend
  lands; WhatsApp remains the always-on second channel.
- **No background execution** — fine: polling, the coordinator and alert
  generation all run server-side (`energy-api`), the PWA is just the client.

## Notes
- `theme_color` / `background_color` = `#06090B` (the `--bg-0` canvas) so the
  splash + status bar match the dark theme.
- `sw.js` never caches `/api/*` (energy data must be live); it cache-firsts static
  assets and falls back to `offline.html` when a navigation can't reach the network.
- Icons are generated from the Power logomark bolt on the dark canvas; rerun
  `gen-icons.cjs` (pure Node, no deps) to regenerate after any mark change.
