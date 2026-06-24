# Mac mini home-server hosting

> Status: **PLANNED** (2026-06-24) — decisions made; build pending SSH access.

Re-home hosting from the tiny TransIP VPS (1 GB, OOMs on builds) to a home
**Mac mini (M4, 2024 — 10-core CPU, 16 GB, Gigabit Ethernet, TB4)** as a general
home server. Apps are **not business-critical** (home internet/power acceptable).

## Decisions (2026-06-24)
- **Location:** the **Spain home LAN** (same network as the Sonnen + 2× Powerwall).
  ⇒ the mini reaches the batteries **directly — no VPN needed** for control.
- **Scope:** **general home server** — energy app + Hirobo app + headroom (DBs,
  more apps, backups).
- **Public exposure:** **Cloudflare Tunnel** (Option A). The home is behind
  **carrier-grade NAT** (UDM WAN `192.168.18.2` private; carrier public
  `212.121.235.197` shared) so **UDM port-forwarding cannot work**. `cloudflared`
  dials *out* to Cloudflare → CGNAT-proof, free, auto-HTTPS, stable hostnames,
  Cloudflare DDoS/WAF + optional **Access** (SSO) for admin apps. Requires moving
  **hirobo.nl DNS to Cloudflare** (free).
  - *Alternative (B), not chosen:* ask Altecom for a public IPv4 → then UDM
    port-forward + UDM firewall/IPS. More exposure/hardening; revisit if wanted.
- **Admin access:** **SSH** from Claude (key added to the mini); **Tailscale** for
  private remote admin (SSH + dashboards never exposed publicly).

## Target architecture
```
  Internet ──► Cloudflare (DNS + TLS + WAF + Access)
                   │  Cloudflare Tunnel (outbound from mini)
                   ▼
  Mac mini (Spain LAN, own UDM VLAN)
    cloudflared ─► Caddy (reverse proxy, local TLS) ─► app containers
      ├─ energy-api (Node)         ─┐ reaches Sonnen 192.168.1.197 + Tesla直接
      ├─ energy web (static)        │ (LAN, no VPN) + Tesla Fleet cloud
      ├─ hirobo (api + web)         │
      └─ Postgres (volume)          │
    Tailscale (private admin: SSH, internal dashboards)
  UDM: mini on a dedicated VLAN; zone-firewall = mini may reach batteries +
       internet only (not the whole LAN).
```

## Build plan (once SSH is in)
1. **Base:** Xcode CLT, **Homebrew**; `pmset` no-sleep + auto-restart after power
   loss; create a service user/launchd setup so services run without login.
2. **Containers:** **OrbStack** (Docker for Apple Silicon) — clean per-app
   containers; **Postgres** container + persistent volume + backups.
3. **Reverse proxy:** **Caddy** (Caddyfile per host).
4. **Tunnel:** install `cloudflared`; create the tunnel; map hostnames; move
   hirobo.nl DNS to Cloudflare; publish energy.hirobo.nl (+ others).
5. **Tailscale:** install + join tailnet; gate admin via Access/Tailscale.
6. **Energy app:** deploy here (reads batteries on the LAN directly); keep the
   Tesla `.well-known` key reachable; point CI/CD at the mini (deploy over
   Tailscale SSH or a pull-on-webhook).
7. **Hirobo app:** migrate from the VPS (Postgres dump/restore into the mini DB).
8. **UDM:** create the server VLAN + zone-firewall policy.
9. **Decommission/repurpose** the VPS once both apps are stable on the mini
   (keep DNS pointers updated).

## ✅ Built & validated on localhost (2026-06-25)
Mac mini `joris@192.168.1.138` (macOS 15.7.7, M4, 16 GB). Base: Homebrew, Node 26,
pnpm 11.8; `pmset` no-sleep + auto-restart; **Tailscale** running (pending the
`mac-mini-energy` approval). All services are **launchd daemons** (RunAtLoad +
KeepAlive → survive reboot, no login):

| Service (launchd) | What |
|---|---|
| `nl.hirobo.postgres` | Postgres 16 (data `/opt/homebrew/var/postgresql@16`; `LC_ALL=en_US.UTF-8` to dodge the macOS "multithreaded" bug) |
| `nl.hirobo.energy-api` | Energy API on `127.0.0.1:3002`, **Sonnen-only** (no Tesla token → VPS unaffected), state at `~/sites/energy/.data/state.json` |
| `nl.hirobo.hirobo-api` | Hirobo API on `127.0.0.1:3001`, env at `~/sites/hirobo/artifacts/api-server/.env` (DATABASE_URL → local DB) |
| `homebrew.mxcl.caddy` (root) | Caddy reverse proxy: `:8080`→energy, `:8081`→hirobo (serve web build + proxy `/api`) |

**Validated** over the LAN: both login pages render (`http://192.168.1.138:8080`,
`:8081`), APIs respond 200, energy reads the Sonnen directly, Hirobo serves the
**restored prod DB** (1,765 txns etc.).

### Migration notes / gotchas
- **DB:** VPS Postgres is **18**, mini is **16** → binary dumps don't restore; used a
  **plain-SQL** `pg_dump --no-privileges` → `psql` restore (one orphaned FK skipped,
  harmless). `hirobo` role+db on the mini; fresh local password in `~/sites/hirobo-db.url`.
- **Frontend build:** pnpm wouldn't pull macOS native binaries (rollup/lightningcss)
  for Hirobo → **copied the pre-built `dist` from the VPS** instead (static, portable).
  Energy + the Hirobo *API* build fine on the mini.
- Repos deployed as clean `git archive HEAD` snapshots to `~/sites/{energy,hirobo}`.

## Open items
- [ ] Cloudflare account + move hirobo.nl DNS (needed for the tunnel).
- [ ] SSH: Remote Login on + key added (in progress) + mini username/IP.
- [ ] macOS version (for tooling) — check on first login.
- [ ] Decide CI deploy mechanism to the mini (Tailscale SSH vs pull).
- [ ] Migrate Hirobo Postgres + app; verify, then retire the VPS.
