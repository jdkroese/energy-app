# Handoff — Mac mini hosting + Cloudflare (fresh-context pickup)

> 2026-06-25. State at end of the mini-hosting session. Goal: move hosting from the
> tiny TransIP VPS to a home **Mac mini** and serve apps publicly via Cloudflare
> Tunnel. **Both sites already run + validated on the mini (LAN); public exposure +
> Tesla cutover are the remaining steps.** No secret values are stored in this file
> (only their locations).

## Access / network (Spain home LAN, behind CGNAT)
- **Mac mini:** `joris@192.168.1.138` — SSH key `~/.ssh/id_ed25519`, **passwordless
  sudo** (`/etc/sudoers.d/claude-setup`). macOS 15.7.7, M4, 16 GB.
  - Homebrew at `/opt/homebrew/bin` — **NOT on the non-interactive SSH PATH**; use
    full paths or `eval "$(/opt/homebrew/bin/brew shellenv)"`.
- **VPS:** `jdkroese01@149.210.189.239` — passwordless sudo. Still LIVE (energy +
  Hirobo) until cutover.
- **Devices:** Sonnen `192.168.1.197`, Teslas `192.168.1.170`/`.175`, UDM `192.168.1.1`.
- **WAN:** UDM is double-NAT/CGNAT (WAN `192.168.18.2`, carrier public
  `212.121.235.197`) → **no inbound**; only outbound tunnels work (why we chose
  Cloudflare Tunnel).
- **VPN (still live):** WireGuard VPS↔UDM so the VPS reaches the LAN; once the mini
  hosts everything, this VPN can be retired with the VPS. (`docs/03-vpn-setup.md`)

## Cloudflare (DNS migrated)
- **hirobo.nl moved to Cloudflare.** Assigned NS: **`celeste.ns.cloudflare.com`,
  `trevor.ns.cloudflare.com`** (the user switched them at TransIP).
- **Zone ID:** `f16e5480045a3f01953f4a432962485f`.
- **All 14 records replicated, all DNS-only (un-proxied)** — incl. all M365 email
  (MX/SPF/`MS=`/DMARC/2× `x-transip-mail-auth`/autodiscover/autoconfig/3× DKIM) and
  `www`/`energy`/root. Full list + values: `docs/13-dns-migration.md`.
- **API token:** a scoped "Edit DNS – hirobo.nl" token was created and used via the
  REST API (the dashboard won't render in the automated browser). It was pasted into
  the old chat → **treat as exposed: REVOKE it, and create a fresh token** when the
  tunnel step needs to add a DNS record.
- **TODO now:** verify the zone is **Active** (NS propagated):
  `dig +short NS hirobo.nl` should return the cloudflare NS; or check the dashboard.

## Mac mini — what's running (all launchd daemons, reboot-proof)
| Daemon | Bind | Notes |
|---|---|---|
| `nl.hirobo.postgres` | :5432 | PG16, data `/opt/homebrew/var/postgresql@16`, plist sets `LC_ALL=en_US.UTF-8` (macOS locale bug) |
| `nl.hirobo.energy-api` | 127.0.0.1:3002 | **Sonnen-only, NO Tesla token** (protects VPS); state `~/sites/energy/.data/state.json` |
| `nl.hirobo.hirobo-api` | 127.0.0.1:3001 | env `~/sites/hirobo/artifacts/api-server/.env`; DB → local |
| `homebrew.mxcl.caddy` (root) | :8080, :8081 | Caddyfile `/opt/homebrew/etc/Caddyfile`. :8080→energy, :8081→hirobo |
- Plists in `/Library/LaunchDaemons/nl.hirobo.*.plist` (root:wheel). Restart a
  service: `sudo launchctl kickstart -k system/<label>`.
- Sites: `~/sites/energy` (commit `32276bd`), `~/sites/hirobo` (`be42a51`), both
  deployed as `git archive HEAD` snapshots. Hirobo DB url: `~/sites/hirobo-db.url`.
- **Validated on LAN:** `http://192.168.1.138:8080` (energy login) and `:8081`
  (Hirobo login); energy reads Sonnen directly; Hirobo serves the restored prod DB.

## Next steps (in order)
1. **Verify Cloudflare zone Active** (NS propagated). If not yet, wait.
2. **Cloudflare Tunnel (public exposure):**
   - On the mini: `cloudflared` is installed. Create a named tunnel
     (`cloudflared tunnel login` then `tunnel create mini`), install it as a service
     (`sudo cloudflared service install` or a LaunchDaemon).
   - **Switch Caddy to hostname vhosts** so it routes by Host: `energy.hirobo.nl`→
     energy (web+:3002), `app.hirobo.nl`→hirobo (web+:3001). cloudflared ingress →
     `http://localhost:80` (Caddy) for both hostnames, or map each hostname directly.
   - Add DNS via the (fresh) API token: `CNAME energy → <tunnel-id>.cfargotunnel.com`
     (proxied), same for `app`. Then the sites are public over HTTPS (Cloudflare TLS).
   - Keep Tesla `.well-known` reachable if energy still needs Fleet API partner checks.
3. **Energy Tesla cutover (single-writer — careful):** the Tesla **refresh token
   ROTATES on every refresh**; never run two energy connectors at once.
   - Stop the **VPS** `energy-api` (`sudo systemctl stop energy-api`).
   - Copy the *current valid* Tesla token from the VPS state
     (`/opt/energy/state.json` → `teslaRefreshToken`) + the `TESLA_*` env
     (`/opt/energy/.env`) and `CALLMEBOT_KEY=9183882` into the mini's energy daemon
     (add to the `nl.hirobo.energy-api` plist EnvironmentVariables / state), set
     `NODE_ENV=production` + a STATE_FILE, restart, verify `/api/live` shows Tesla.
   - Then the mini's energy app is the single source; **retire/repurpose the VPS**
     (and the WireGuard VPN).
4. **Point energy DNS** at the tunnel (replace the `energy → VPS IP` A record with the
   tunnel CNAME) once the mini serves it publicly.
5. **Optional:** UDM — put the mini on its own VLAN + zone-firewall (least-privilege).
   Tailscale — approve `mac-mini-energy` for private admin.

## Gotchas (learned this session)
- **Tesla token rotates** → only ONE energy instance may hold it. Mini is Sonnen-only
  until cutover.
- **macOS Postgres** needs `LC_ALL` set or it dies "postmaster became multithreaded".
- **VPS PG 18 vs mini PG 16** → binary dumps fail; use **plain-SQL** `pg_dump
  --no-privileges` → `psql` restore.
- **pnpm on the mini doesn't fetch macOS native binaries** (rollup/lightningcss) for
  the Hirobo frontend → we **copied the VPS's pre-built `dist`**. Energy + the Hirobo
  *API* build fine on the mini.
- **Cloudflare dashboard won't render** under the automated browser → use the REST API.
- Email is **Microsoft 365** — never proxy MX/CNAME/DKIM (keep DNS-only).
