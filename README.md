# Energy App

Home energy coordinator + dashboard for **energy.hirobo.nl** — consolidates and
(later) centrally controls a Sonnen battery, 2× Tesla Powerwall 3, and two solar
arrays at a home in Jávea, Spain. See [`docs/`](docs) for the full picture
(brief, API research, VPN, deployment, features, design).

## Stack
- **apps/api** — Node 24 + TypeScript + Express 5. Connectors: Sonnen (local API
  over the WireGuard tunnel) and Tesla Fleet API (cloud). Bundled with esbuild.
- **apps/web** — React 19 + Vite 7 + Tailwind v4. Installable PWA dashboard.
- pnpm workspaces. Deployed to a TransIP VPS behind nginx via GitHub Actions.

## Local development
```bash
pnpm install
cp .env.example .env      # then fill in secrets (or use the existing .env)
pnpm dev                  # api on :3002, web on :5173 (proxies /api -> :3002)
```
Open http://localhost:5173. The API reads the repo-root `.env`.

Useful endpoints: `/api/health`, `/api/live`, `/api/sonnen/status`, `/api/tesla/live`.

> Note: live Sonnen reads only work from a machine that can reach `192.168.1.197`
> (the home LAN, or the VPS over the VPN). Tesla works from anywhere.

## Build
```bash
pnpm build     # apps/api -> dist/index.cjs (bundled), apps/web -> dist/ (static)
```

## Deployment
Push to `main` → GitHub Actions builds, rsyncs artifacts to the VPS, restarts the
`energy-api` systemd service. nginx serves the web build and proxies `/api`.
See [`docs/04-deployment.md`](docs/04-deployment.md).
