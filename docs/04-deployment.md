# Deployment & Infrastructure

> Last updated: 2026-06-24

## VPS (TransIP)
- Name: `jdkroese01-vps` — Ubuntu 26.04, **1 core / 1 GB RAM + 2 GB swap**, Amsterdam (AMS0).
- **Public IP: `149.210.189.239`**. VPS firewall: disabled. Ports open: 22, 80, 443.
- SSH: key-based as **`jdkroese01`** (passwordless sudo). Key on Joris's PC at `~/.ssh/id_ed25519`.
- ⚠️ Small box, has shown OOM-killer activity during build spikes. Fine for nginx +
  light services; **the full energy app (control loop + time-series DB + dashboards)
  will likely need a RAM upgrade** or careful resource limits. Revisit before deploy.

## What already runs on the VPS (do not disturb)
- **nginx 1.28.3** (system web server, certbot-managed).
- **`app.hirobo.nl`** — the "holding-tracker" app: static React at
  `/var/hirobo/artifacts/holding-tracker/dist/public` + Node API on `127.0.0.1:3001`,
  **PostgreSQL** on `127.0.0.1:5432`. Has its own LE cert (expires 2026-09-20).
- certbot 4.0.0 with auto-renew timer.

## DNS (TransIP, domain hirobo.nl)
- Nameservers: ns0.transip.net / ns1.transip.nl / ns2.transip.eu. DNSSEC enabled.
- ⚠️ Public site `hirobo.nl` + `www` → **`34.111.179.208` (Google Cloud / Replit)**,
  NOT the VPS. The marketing/site front-end appears to live on **Replit**, while the
  VPS hosts `app.hirobo.nl`. Worth clarifying with Joris which is canonical.
- **Added 2026-06-24:** `energy` A → `149.210.189.239` (TTL 86400). Verified on
  authoritative NS + public resolvers (1.1.1.1 / 8.8.8.8).

## energy.hirobo.nl (this project)
- nginx vhost `/etc/nginx/sites-available/energy` (enabled), root `/var/www/energy`
  (owned www-data), placeholder `index.html` live.
- **Let's Encrypt cert issued 2026-06-24** (CN=energy.hirobo.nl, expires 2026-09-22,
  auto-renew). HTTP→HTTPS redirect configured by certbot.
- `https://energy.hirobo.nl` → **200 OK, valid cert, direct to VPS (no reverse proxy)**.
- Tesla `.well-known` path pre-created: `/var/www/energy/.well-known/appspecific/`
  — drop `com.tesla.3p.public-key.pem` here during Fleet API partner registration.

## Tesla Fleet API app (LIVE as of 2026-06-24)
- **Status:** App created, API access live.
- **Credentials:** `TESLA_CLIENT_ID` + `TESLA_CLIENT_SECRET` stored in **`.env`**
  (gitignored — never commit). Secret is NOT recorded in any committed file.
- OAuth grant: Authorization code. Source URL `https://energy.hirobo.nl`.
- Redirect URI `https://energy.hirobo.nl/api/auth/tesla/callback`
  (+ `http://localhost:3000/api/auth/tesla/callback` for dev). Return URL `https://energy.hirobo.nl`.
- **Fleet API host (EU):** `https://fleet-api.prd.eu.vn.cloud.tesla.com`
- **Scopes:** `openid offline_access energy_device_data energy_cmds`
- **API docs:** https://developer.tesla.com/docs/fleet-api/getting-started/what-is-fleet-api
- **Onboarding COMPLETE (2026-06-24):**
  - EC key pair generated; private key at `/opt/energy/secrets/tesla-private-key.pem`
    (600, on VPS); public key published + reachable (HTTP 200) at
    `https://energy.hirobo.nl/.well-known/appspecific/com.tesla.3p.public-key.pem`.
  - Partner-token host: `https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token`.
  - Domain **registered** via `POST {AUDIENCE}/api/1/partner_accounts {"domain":"energy.hirobo.nl"}`
    → account tier `pay_as_you_go`.
  - OAuth authorization-code flow completed; **refresh token** stored in `.env`
    (`TESLA_REFRESH_TOKEN`). Access tokens (~8 h) are minted from it; not stored.
- **Energy site:** `TESLA_ENERGY_SITE_ID=1689529157873570`
  (site "Joris Kroese calle tarac 11 javea", product STE20251125-00871).
- **Live read verified:** `GET {AUDIENCE}/api/1/products` and
  `…/energy_sites/{id}/live_status` return solar/load/grid/battery + SoC.
  Sample 2026-06-24 16:17: solar 11.1 kW, load 5.5 kW, Powerwall 100%/idle,
  grid exporting 5.56 kW (both batteries full mid-afternoon → cheap export, nothing
  left for the P1 evening peak — the core problem to coordinate away).

## Deployment pipeline (TODO)
- GitHub repo → publish local DEV → LIVE on the VPS (energy.hirobo.nl). Not yet set up.
- Decide app runtime (likely Node service behind nginx, like app.hirobo.nl) + DB
  (can reuse the existing Postgres instance or a separate DB).
