# 36 — Solar inverters (Sungrow SG5.0RS ×2) onboarding + outage monitoring

> **CONFIRMED LIVE (2026-07-02, via each dongle's web UI):** the hardware is **Sungrow**
> (as the owner originally said — UniFi's "SolaX Power" vendor label was a wrong fingerprint
> of the Espressif WiFi chip; ignore it). Both dongles run the **WiNet-S** local web UI and
> each serves one **Sungrow SG5.0RS** inverter (5 kW single-phase string; PV-only, no
> battery). Cloud app = **iSolarCloud**.
>
> | Dongle IP | Inverter | Live now | Today | Lifetime | Status |
> |-----------|----------|----------|-------|----------|--------|
> | `192.168.1.67`  | SG5.0RS (COM1-001) | 3.94 kW | 10.10 kWh | 26,709 kWh | Run |
> | `192.168.1.181` | SG5.0RS (COM1-001) | 4.00 kW | 17.00 kWh | 28,564 kWh | Run |
>
> Both are single-phase string inverters ⇒ they **de-energize at night and the WiNet-S
> dongle dies with them** — the night-gating logic below is REQUIRED. Both COM names are
> identical, so the connector must key on **dongle IP**, not COM address. (The ~10 vs 17 kWh
> today gap is itself a reason to want per-inverter visibility — could be shading/orientation
> or the morning undervoltage trips on `.67`; per-string comparison would surface it.)
>
> **Local API proven reachable + read-only today (no dongle config change needed):** the
> WiNet-S SPA calls a **local REST API** (`GET http://<ip>/product/list` → 200) and exposes a
> **queryable fault/alarm log** (History Data → Fault History) with structured fields:
> `Device Name · Alarm Name · Alarm Type (Fault|Alarm) · Status (Active|Closed) · Time ·
> Fault Code · Fault ID`. Live realtime values stream over the dongle's **WebSocket
> (`ws://<ip>:8082/ws/home/overview`)**. **Modbus TCP (502)** is the richer/faster option but
> must be enabled per-dongle in WiNet-S System settings (not yet verified — owner action).
>
> **The Sungrow research below is the correct one.** The SG-string register map (5031/32 AC
> power, 5003 daily, 5004/5 total, 5038 work-state, 5045+ fault) applies to the SG5.0RS.

## Live-confirmed outage signature (2026-07-01, dongle `.67` fault log)

Yesterday's "outage" was **not** a hardware fault — it was the inverter repeatedly tripping on
**Grid Undervoltage** (`Alarm Name = "Grid Undervoltage"`, `Fault Code = 2`, `Fault ID = 4`
when Active), cycling Active↔Closed 10+ times between **03:38 and 06:35** local. This is a
**grid-quality event** (weak rural-Spain grid), the low-voltage counterpart to the site's known
midday **over**-voltage export trips (Sonnen). Implications for the design:
- The **fault log is the best outage source** — it names the cause (Grid Under/Over-voltage,
  etc.), gives Active/Closed transitions with timestamps, and a stable Fault Code to map. Poll
  it per dongle and raise/clear alerts off Active/Closed.
- Voltage trips **auto-recover** (Active→Closed in seconds/minutes), so alerting must
  **debounce + aggregate** ("N undervoltage trips in the last hour"), not page on every flap.
- This corroborates + enriches the existing `rule-voltage` alert and the Sonnen over-voltage
  monitoring — the inverter fault log is an independent witness to grid-quality problems.
- **Feeds the Event Viewer** (docs/37, concurrent) as a first-class event source.

---


## Goal

Onboard the **two Sungrow inverters** (just joined to the house WiFi, visible in the
iSolarCloud app) as first-class **"Solar Inverters"** in the app: read per-inverter
production and health, and — the owner's headline requirement — **never let an inverter
outage go unnoticed**.

Today the app only sees solar as an aggregate: Sonnen's meter `productionW` (Array A, the
24×460 W / 11.04 kWp string these two Sungrows drive) plus Tesla's `solarKw` (Array B via
PW3). There is **no per-inverter visibility** and no alert if one Sungrow silently drops.

## What the inverters are

- 2× Sungrow **string (PV) inverters** driving Array A (11.04 kWp). Battery storage is
  Sonnen/Tesla, so these are almost certainly **SG-series string inverters, not SH
  hybrids** — confirm the model on the label / in iSolarCloud. This matters because
  **string inverters de-energize at night**, and the comms dongle dies with them (see
  "Night behaviour" below).
- Each inverter has its own **WiNet-S WiFi dongle** → its own IP on the LAN. Two inverters
  = two IPs to poll. Old VPN notes (`docs/03`) already flag `192.168.1.210` as a likely
  Sungrow device that answered "unauthorized user" — one of the two dongles.

## Data-path options (researched)

| Path | Transport | Freshness | Pros | Cons |
|------|-----------|-----------|------|------|
| **A. Local Modbus TCP** (recommended) | TCP 502, unit ID 1, per dongle | real-time (poll 30–60 s) | fast, free, full register set, on-LAN (the mini is already there) | must enable Modbus in each WiNet-S web UI; Sungrow has broken/restricted it via firmware before; dongle offline at night |
| **B. WiNet-S local WebSocket** | `ws://<ip>:8082/ws/home/overview`, login `admin`/`pw8888` | ~10 s | works when Modbus is firmware-blocked; auto-adapts per model | undocumented; **1 socket only** (locks out the web UI); also dies at night |
| **C. iSolarCloud OpenAPI** (backstop) | HTTPS `gateway.isolarcloud.eu`, appkey+secret | ~5 min | survives night/LAN issues; official; distinguishes "LAN down" vs "inverter down" | approval takes a few days; coarse; quota-limited |
| D. Reverse-engineered cloud (GoSungrow) | HTTPS, hardcoded appkey | ~5 min | — | **avoid** — EOL (last release Sep 2023), API changes without notice |

**Recommended architecture: local-first, cloud-verify.**
1. **Primary** — Modbus TCP poller per dongle (two IPs, port 502, unit 1, 30–60 s,
   serialized reads with a small inter-read delay, exponential-backoff reconnect).
   Node lib: `modbus-serial` or `jsmodbus` (input registers, function 0x04).
2. **Fallback** — WiNet-S WebSocket per dongle if Modbus is firmware-blocked on these units.
3. **Backstop** — iSolarCloud OpenAPI polled every 5–15 min to reconcile daily energy and
   to tell "LAN problem" apart from "inverter down". **Apply for the developer appkey now**
   — the multi-day approval is the long pole; the connector can ship on local-only first.

### Key Modbus registers (SG string inverters, 1-based protocol addresses, input regs 0x04)

| Reg | Meaning | Scale |
|-----|---------|-------|
| 5003 | Daily yield | 0.1 kWh |
| 5004–5005 | Total yield | 1 kWh (U32) |
| 5008 | Internal temp | 0.1 °C |
| 5031–5032 | Total active AC power | W (U32) |
| 5036 | Grid frequency | 0.1 Hz |
| 5038 | **Work state** | 0x0000 Run · 0x8000 Stop · 0x1400 Standby · 0x5500 **Fault** · 0x9100 Alarm-run · 0x8100 Derating |
| 5045+ | Fault / alarm code | U16 |

Verify against the model-specific Sungrow protocol PDF at build time (SunGather's per-model
register YAML is a good template). SH-hybrid maps differ (13000-block) if these turn out to
be hybrids.

## Outage detection — the hard part

**Night ≠ outage.** The WiNet-S dongle is *powered by the inverter*. A string inverter
shuts down at dusk, so its dongle goes unreachable **every single night** (Modbus AND
WebSocket) and reappears after sunrise. Naïve "unreachable → alarm" would page the owner
nightly. Rules must be gated on **expected production**, which the app already has:
Autopilot's clear-sky model + measured solar.

Three failure classes, three responses:

1. **Inverter fault** (reachable, work-state reg = Fault/Alarm or fault code ≠ 0) →
   **alert immediately**, strongest signal.
2. **Zero production in daylight** (reachable, state Run/Standby, AC power ≈ 0 while
   clear-sky expects meaningful output and/or the *other* inverter is producing) → alert;
   catches string/MPPT faults and derating.
3. **Dongle offline** (TCP connect fails) → alert **only if** clear-sky expected production
   is above a threshold (i.e. daylight). Unreachable at night = expected, suppressed.

Cross-checks that make it robust:
- **Two-inverter reference:** both dark in daylight = grid/site event; one dark = that
  inverter's fault.
- **Cloud backstop:** if iSolarCloud shows fresh data but the LAN doesn't → it's a LAN/WiFi
  problem, not an inverter down (and vice-versa: cloud is the only thing that catches an OTA
  firmware push silently disabling local Modbus).
- **Debounce:** a single failed poll is soft; alert only after N consecutive misses
  (~5 min), mirroring the existing `rule-offline` 2-tick debounce.

## How it fits the app (touch-list)

Read-only integration — **no control loop, no battery-arm interaction** → safe to deploy
without disarming.

**Server (`apps/api`)**
1. `connectors/sungrow.ts` — Modbus (+ WS fallback) reader → normalized
   `{ inverters: [{ id, name, acPowerW, dailyKwh, totalKwh, tempC, workState, faultCode, reachable }], productionW }`. Cache via `cached()`.
2. `connectors/sungrow-cloud.ts` — iSolarCloud OpenAPI client (backstop; ships when appkey lands).
3. `runtime-config.ts` — `sungrowConfig()`: two dongle IPs + optional cloud creds, from
   `store.integrations.sungrow`, env fallback (`SUNGROW_HOST_1/2`, `SUNGROW_CLOUD_*`).
4. `routes/integrations-config.ts` — `testSungrow()` probe + `setSungrow()` persist.
5. `routes/live.ts` — fold Sungrow into `getLive()`; expose per-inverter under
   `solar.arrays[]` (the `LiveResponse` type already has the slot).
6. `routes/health-probe.ts` — add Sungrow to `probeAll()`.
7. `routes/alerts.ts` — new rules `rule-inverter-fault`, `rule-inverter-stall`,
   `rule-inverter-offline` (daylight-gated as above), reusing the debounce + recovery-watch
   patterns. `alert-loop.ts` already fans out to Push / WhatsApp / Email.
8. `index.ts` — register `/api/integrations/sungrow` routes.

**Web (`apps/web`)**
9. `lib/deviceTypes.ts` — add `'solar-inverter'` to `DeviceType` + `DEVICE_TYPES` (label
   "Solar Inverters", solar hue, sun/inverter icon).
10. `lib/types.ts` + `lib/api.ts` — extend live `solar.arrays` type; `api.sungrow.test/set`.
11. `screens/Settings.tsx` — Sungrow `ConnectionRow` (mirrors Airzone/Intesis: IP inputs +
    probe + save). Replaces the current "Not yet wired — pending integration" stub.
12. A **Solar Inverters** view (per-inverter card: live kW, today kWh, state chip,
    reachable/last-seen, temp) — dedicated screen or a Devices-hub tab, both viewports.

**History (optional, follow-up)** — record per-inverter production into the SQLite energy
tiers (docs/31) with an `inverter_id` column for long-term per-string yield tracking.

## Discovery steps (must run on the Spain LAN / mini — owner-assisted)

1. Find the two dongle IPs: DHCP leases / `arp -a` after a subnet ping sweep (WiNet MACs,
   `espressif`/`WiNet` hostnames). Pin **static DHCP reservations**.
2. `curl http://<ip>` → WiNet web UI; log in (`admin`/`pw8888`); **note firmware**;
   **enable Modbus TCP** and clear/whitelist the mini's IP. Consider blocking the dongles'
   internet DNS to freeze firmware (prevents surprise OTA that re-disables Modbus).
3. `nc -vz <ip> 502` and `:8082` to see which local paths are open.
4. Test-read reg 5031 (AC power) + 5038 (work state); read the serial-number block to map
   which physical inverter is which IP; confirm SG-string vs SH-hybrid.

## Phasing

- **Phase 0 — discovery (owner-assisted, blocking):** the four steps above + apply for the
  iSolarCloud developer appkey (multi-day lead).
- **Phase 1 — local read + Settings + live display:** Modbus connector, config UI, per-inverter
  cards, folded into `/api/live`. Ships once dongle IPs + Modbus-enabled are confirmed.
- **Phase 2 — outage alerting:** the three daylight-gated rules + two-inverter cross-check +
  debounce. The core deliverable for "don't miss an outage."
- **Phase 3 — cloud backstop + history:** iSolarCloud reconcile + LAN-vs-inverter
  disambiguation + per-inverter SQLite history.

## Decisions (locked 2026-07-02)

1. **Data path — local Modbus + cloud backstop** (option A + C). Real-time LAN polling as the
   primary source; iSolarCloud OpenAPI as the ~5-min backstop to disambiguate LAN-down vs
   inverter-down. WiNet-S WebSocket kept as the firmware-blocked fallback.
2. **Approach — discovery first.** Owner runs Phase-0 discovery (below) so the connector is
   built against confirmed dongle IPs / register reads / model, testable end-to-end on first cut.

**Discovery: DONE (2026-07-02, live).** Both IPs, both models (SG5.0RS), both reachable +
read-only, live values, fault-log structure, and the undervoltage outage signature all captured
above. **Refinement to the data path:** the WiNet-S **local REST + WebSocket** path is *already
proven reachable today with no dongle reconfiguration*, and its **fault log is the richest outage
source** — so make that the **primary** (live values via WS `:8082`, health + cause via the fault
log REST query). **Modbus TCP (502)** stays the preferred *upgrade* for faster/cleaner numeric
registers, but it requires enabling per-dongle in WiNet-S System settings (owner action) — add it
once confirmed on, not a blocker. iSolarCloud OpenAPI remains the ~5-min cloud backstop.

**Alert channels — decided (2026-07-02):** outage/fault alerts use the **same fan-out as the
grid-voltage alert — Push + WhatsApp + Email** (highest visibility).

**Build status (2026-07-02): ON HOLD at owner's request** — the finalized plan is the deliverable
for now; no build yet. Resume = build Phase 1 + 2 together (per-inverter cards + night-gated,
debounced/aggregated outage+fault alerts on Push/WhatsApp/Email), read-only → safe deploy.

Remaining optional owner actions (for later, not blockers — offered 2026-07-02, owner deferred):
- (a) **Static DHCP reservations** for `192.168.1.67` + `.181` in the UniFi router (pin to the
  dongle MACs `e8:db:84:1f:a6:24` / `e8:db:84:20:63:f0`) so the configured IPs never drift on a
  router reboot. The single operational risk to the connector; cheapest hardening.
- (b) **Enable Modbus TCP** in each WiNet-S (System → Communication) → add a Modbus reader as the
  more-robust/documented primary path (the WebSocket path is reverse-engineered + firmware-fragile).
- (c) **iSolarCloud developer appkey** (self-service, ~days) → ~5-min cloud backstop that tells
  "LAN/WiFi down" apart from "inverter down" and catches a firmware update killing local access.

## Phase-0 discovery checklist (owner, on the Spain LAN)

Run these on the Mac mini (or any machine on the house WiFi). Report back the bold items.

1. **Find the two dongle IPs.** On the mini:
   ```sh
   arp -a | grep -iE 'espressif|winet' || arp -a
   ```
   The WiNet-S dongles are Espressif-based; look for two IPs in the `192.168.1.x` range
   (one is likely `192.168.1.210`). → **report the two IPs**. Then set **static DHCP
   reservations** for both in the router so they don't move.
2. **Open each dongle's web UI:** browse to `http://<ip>`, log in (`admin` / `pw8888`).
   → **report the firmware version** shown, and the **inverter model** (SG… string vs SH…
   hybrid). Consider blocking the dongles from the internet (DNS/`*.isolarcloud.*`) later to
   stop OTA updates silently re-disabling Modbus.
3. **Enable Modbus TCP** in the web UI (Settings → Communication parameters): turn on Modbus
   TCP; if there's an **IP white-list**, add the mini's IP or disable the list.
4. **Confirm the local ports are open** from the mini:
   ```sh
   nc -vz <ip> 502     # Modbus  — want "succeeded"
   nc -vz <ip> 8082    # WiNet WebSocket fallback
   ```
   → **report which ports connect** for each dongle.
5. **Apply for the iSolarCloud developer appkey now** at https://developer-api.isolarcloud.com/
   (Create Application; EU plant → `gateway.isolarcloud.eu`). Approval takes a few days — start
   it in parallel so it's ready for Phase 3. → **report appkey + secret when granted** (store in
   env, never in the repo).

Once steps 1–4 report back, Phase 1 build starts (Modbus connector against the real IPs).
