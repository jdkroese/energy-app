# API Research — Sonnen & Tesla (control capabilities)

> Status: **DRAFT** — compiled 2026-06-24 from API/community knowledge.
> ⚠️ The research ran without live web access, so **exact endpoint field names,
> Tesla rate-limit/billing numbers, and source URLs must be re-verified live**
> before implementation. Treated as directional, not final.

This document answers the question that decides our architecture: *what CONTROL
does each system actually allow, and from where (cloud vs LAN)?*

---

## TL;DR — the decisive conclusion

| | **Sonnen** | **Tesla Powerwall 3** |
|---|---|---|
| Cloud control for an individual owner? | ❌ No (cloud API is partner/utility-gated) | ✅ Yes (Fleet API) |
| Local control? | ✅ Local REST `/api/v2/` (the only real path) | ⚠️ TEDAPI — read-rich, write-poor, LAN-only |
| Where the controller must sit | **Must reach the Spain home LAN** | Cloud is fine from the NL VPS |

➡️ **Because Sonnen can only be controlled on the local LAN, and the LAN is in
Spain, the app cannot be purely cloud-hosted. We need a small always-on
"home bridge" device at the Spain home (or a VPN into it).** This is the single
most important architectural takeaway and it overrides the earlier "cloud-first"
hope — at least for Sonnen.

---

## 1. Sonnen (sonnenBatterie 10, SW 1.31.x) — LOCAL control only

**Control path:** local REST API `http://<battery-ip>/api/v2/`.
- **Force charge/discharge:** set `EM_OperatingMode=1` (Manual) via
  `PUT /api/v2/configurations`, then `POST /api/v2/setpoint/charge/{watt}` or
  `/setpoint/discharge/{watt}` (clamp ≤ 4600 W). Revert to mode `2`
  (self-consumption) or `10` (time-of-use) to hand control back.
- **Backup reserve / target SoC:** `EM_USOC` via `PUT /api/v2/configurations`.
- **Auth:** `Auth-Token` header; token is generated in the battery's **local web
  UI → Software Integration / API** (must enable API access first). Single
  read-write token; protect it.
- **Telemetry (read):** `/api/v2/status`, `/latestdata`, `/powermeter`,
  `/inverter`, `/battery` — SoC (USOC/RSOC), power flows, PV production, grid
  feed-in/out, consumption, cycles. **Live snapshot only → we must poll & store
  our own history.**
- **Cloud:** no self-service control API for individual owners. Monitoring only.

**Verdict:** central scheduled control is fully feasible — exactly the
manual-mode + setpoint + revert primitive the coordinator needs — **but only from
inside the home LAN.** This is what fixes the "Sonnen stuck at 100%" problem.

## 2. Tesla Powerwall 3 — CLOUD control (Fleet API), no command signing

**Control path:** Tesla **Fleet API**, **EU regional host**
`https://fleet-api.prd.eu.vn.cloud.tesla.com`. Energy endpoints are **plain
authenticated REST** — **no Vehicle-Command signing, no proxy, no BLE** (that's
vehicles only). Public-key hosting at
`/.well-known/appspecific/com.tesla.3p.public-key.pem` is still required during
partner onboarding.
- **Auth:** OAuth authorization-code grant; scopes `energy_device_data` +
  `energy_cmds` (+ `openid offline_access`). Access token ~8 h, refresh token for
  renewal. One-time partner-token step registers the public key/domain.
- **Control levers (POST):**
  - `…/operation` → `default_real_mode`: `self_consumption` | `autonomous`
    (time/price-based) | `backup`.
  - `…/backup` → `backup_reserve_percent` (0–100).
  - `…/grid_import_export` → grid-charge enable + export rule
    (`battery_ok`/`pv_only`/`never`).
  - `…/time_of_use_settings` → feed the 2.0TD tariff so `autonomous` optimizes on
    cost; `optimization_strategy: economics`.
  - `…/storm_mode`.
  - ⚠️ **No direct "discharge now at X kW" cloud command** — behaviour is steered
    indirectly via mode + reserve + grid-charge + TOU tariff.
- **Telemetry:** `…/live_status` (solar/battery/load/grid W, SoC) ~seconds-fresh;
  `…/calendar_history` for binned history (energy/power/soe/self-consumption/
  savings/backup). **Aggregate only — no per-Powerwall breakdown in cloud.**
- **Rate limits / cost:** minute-scale, not a 5 s loop. Poll `live_status` at
  **30–60 s**; make control calls **event-driven**. Free tier + per-call billing
  exist; ⚠️ **verify current numbers live**.

**Local option (TEDAPI):** PW3 dropped the old local REST API; only **TEDAPI**
(protobuf, via the Gateway, auth = gateway Wi-Fi password) remains. It's
**read-rich** (per-Powerwall SoC/temps/strings, sub-second, free) but
**write-poor** (mode + reserve only; no TOU/export/storm) and LAN-only. Reference:
`jasonacox/pypowerwall` + `Powerwall-Dashboard`.

**Verdict:** scheduled control via **cloud Fleet API** is sufficient and is the
right primary plane for Tesla. Add local TEDAPI later only for per-unit
diagnostics / fast telemetry / offline fallback.

---

## 3. Architecture (chosen: VPN site-to-site)

**Decision (2026-06-24):** a **VPN tunnel** terminated on the **UniFi gateway** in
Spain — no separate bridge device. The VPS reaches the home LAN directly.

```
  SPAIN home LAN (UniFi)                  VPN tunnel              NL VPS (TransIP)
  ┌───────────────────────────┐                          ┌──────────────────────────┐
  │ Sonnen  ──/api/v2/ (local)│                          │  Web app (energy.hirobo) │
  │ Tesla GW ─ TEDAPI (local) │   WireGuard / Tailscale   │  Coordinator/scheduler   │
  │ Sungrow ─ Modbus/local    │ ◄═══════════════════════► │  Time-series DB + UI     │
  │ UniFi gateway (VPN peer) ─┼──────────────────────────┤  Tesla Fleet API (cloud) │
  └───────────────────────────┘                          └──────────────────────────┘
        the gateway IS the bridge          Tesla cloud: VPS → internet (direct)
```

- The **UniFi gateway** terminates the VPN and routes the home LAN subnet to the
  VPS. The VPS polls/commands **Sonnen** (and optionally Tesla **TEDAPI** /
  **Sungrow**) across the tunnel as if local.
- **Tesla scheduling/control** still goes **VPS → Tesla cloud** directly (no tunnel
  needed for that path).
- Implementation options + steps: see `docs/03-vpn-setup.md`.

---

## 5. LIVE VALIDATION — Sonnen (2026-06-24) ✅
Verified directly against the unit at **`192.168.1.197`** (this PC is on the Spain LAN):
- Local UI login: **User** account (initial password from type plate). Token page:
  **Software-Integration → JSON API**; **Read API + Write API toggled ON**.
- **Auth-Token obtained** (stored in `.env` as `SONNEN_API_TOKEN`, never committed).
- Confirmed working endpoints w/ `Auth-Token` header: `/api/v2/status` (open),
  `/latestdata`, `/powermeter` (meter `WM271`, production+consumption channels),
  `/configurations`. Control surface present: `EM_OperatingMode` (1 manual / 2 auto /
  10 ToU), `EM_USOC` (reserve), `EM_ToU_Schedule`, `EM_Prognosis_Charging`,
  `IC_InverterMaxPower_w=4600`, `IC_BatteryModules=2`, nominal ~11 kWh.
- **Live misbehavior captured:** auto mode + prognosis-charging ON + reserve 0% →
  charging from grid to 99% SoC. This is the target behavior for the coordinator to override.
- ⚠️ Enabling **Write API** means anyone on the LAN holding the token can charge/
  discharge the battery — treat the token as a secret; rotate via "Create New" if leaked.

## 4. To verify live (web access was blocked during research)
- [ ] Exact Tesla `time_of_use_settings` tariff body schema; TEDAPI write stability on FW 26.x.
- [ ] Current Tesla Fleet API rate limits & billing tiers.
- [ ] Sonnen v2 exact JSON field names on SW 1.31.x; confirm which PV/grid channels it meters.
- [ ] Sungrow inverter API/Modbus access for direct solar read of Array A.
