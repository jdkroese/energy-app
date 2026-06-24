# Energy App — Project Brief

> Status: **MVP scaffolded & deployed (energy.hirobo.nl); monitoring build next**
> Owner: Joris Kroese
> Last updated: 2026-06-24

A home energy-management web app that consolidates reporting **and** centrally
coordinates two battery systems (Sonnen + Tesla Powerwall 3) plus solar, becoming
the single "boss" of the household energy system.

---

## 1. Vision

One web app that becomes **"the boss"** of the household energy system —
coordinating two battery systems + solar + EV charging, and providing a beautiful
**consolidated dashboard**. Today each battery tries to be master, causing
conflicts, idle capacity, and silent failures.

The app should:
1. **Centrally coordinate** charging (solar/grid), discharging, and backup reserve
   across both batteries as one system (scheduled automation with safety limits).
2. **Consolidate reporting** — unified dashboards across both batteries + solar +
   grid + EV, state of charge, power flows, and history.
3. **Monitor & alert** — notify on faults/dropouts (e.g. Tesla powering off on
   voltage fluctuation) that today go unnoticed.

---

## 2. Problems to solve

- **Conflicting masters:** Both Sonnen and Tesla want to control the home. The
  Sonnen (11 kWh) often sits at 100% SoC instead of discharging, because the
  larger Tesla (27 kWh) dominates self-consumption/discharge — Sonnen never gets
  its turn.
- **Silent Tesla dropouts:** A Powerwall sometimes powers off on voltage
  fluctuation with **no notification**.
- **No unified view:** Reporting is split across vendor apps; no single picture of
  solar (two arrays) + both batteries + house + EV.
- **No coordinated optimization:** Charge/discharge/backup/EV decisions aren't
  coordinated for cost, self-consumption, or resilience.

---

## 3. Site & systems

**Location:** Calle del Tarrec 11, 03730 Jávea (Xàbia), Alicante, **Spain**.
(The home + all hardware are in Spain; the hosting VPS is in NL — see §6.)
**Grid:** Single-phase, **14 kW** contracted power (measured peak 13.79 kW).
Tesla site limits: **import 14 kW, export 9 kW**.

### 3.1 Sonnen battery
- Model: **sonnenBatterie 10**, serial **192184**.
- 2× **sonnenModule 4** ≈ **11 kWh**; max output **4.6 kW**; LiFePO4.
- Software **1.31.11.4252546**; installed 2022-09-14; 882 charge cycles.
- Historically measured/managed the 24-panel Sungrow solar (now unclear whether
  Sonnen or Tesla owns that metering — to confirm).
- On the home LAN in Spain. Installer: Proyecciones AQUA SLU (Xàbia).

### 3.2 Tesla Powerwall
- **2× Powerwall 3** (whole-home backup), ≈ **27 kWh** total (13.5 kWh each).
- Serial **TG1251200022M5**; firmware **26.18.2**.
- **Backup Gateway 2** (TPN 1152100-13-L); Neurio W2 meter + CT clamps.
- PW3 has an **integrated solar inverter** driving the 16-panel array.
- On the LAN, wired + Wi-Fi, fixed IPs **192.168.1.170** and **192.168.1.175**
  (Unifi network; one unit mislabelled "Powerwall 2" by Unifi — both are PW3).
- Local gateway credentials captured in `docs/inbox/` images → must move to a
  secrets store, never commit.

### 3.3 Solar PV (two arrays, ≈ 18.2 kWp total)
- **Array A:** 24× 460 Wp ≈ **11.04 kWp**, **2× Sungrow inverters**; historically
  measured via Sonnen.
- **Array B:** 16× 450 Wp ≈ **7.2 kWp**, via the **Tesla PW3 integrated inverters**.

### 3.4 EV (owned today)
- **2× BMW i3** (120 Ah / ~42 kWh extended-range), currently scheduled to charge
  **10:00–19:00 at low speed** (solar hours) — a key controllable load.
- ⚠️ BMW i3 does **not** support V2G/V2H. A future **V2G/V2H/V2X** asset would
  require a compatible car + bidirectional charger; design the architecture so it
  slots in cleanly later.

---

## 4. Energy market & optimization

### 4.1 Tariff — Spain 2.0TD (from user's analysis doc)
Three time bands (Peninsula time, year-round):

| Period | When | Buy rate |
|---|---|---|
| **P1** peak | Mon–Fri 10:00–14:00 & 18:00–22:00 | €0.2093/kWh |
| **P2** shoulder | Mon–Fri 08:00–10:00, 14:00–18:00, 22:00–24:00 | €0.1309/kWh |
| **P3** valley | Mon–Fri 00:00–08:00 + all weekend + holidays | €0.0957/kWh |

- **Power term:** ~€36.19/month for 14 kW (P1/P2), independent of usage.
- **Surplus export (excedentes):** compensated at only **€0.0038–0.0289/kWh** —
  a fraction of the buy price.

### 4.2 Key insight → optimization priority
Because export pays ~€0.003–0.029 but P1 import costs €0.2093, **maximizing
self-consumption is the single highest-value lever** (each self-consumed P1 kWh
saves ~€0.21). Secondary: shift flexible loads (EV, appliances, pool/irrigation,
HVAC pre-cool) into **P3 / solar hours**, and arbitrage charge in P3 / discharge
in P1. Watch the 14 kW peak (power term) so combined loads don't exceed it.

### 4.3 Objectives (all matter; balanced via scenario profiles)
1. Maximize solar self-consumption (highest ROI here).
2. Lower energy bill (P1↔P3 arbitrage, peak management).
3. Backup resilience (reserve, prevent dropouts).
4. Unified monitoring & alerting.

**Configurable scenarios:** user-definable profiles to switch between (e.g.
"max self-consumption summer", "storm/backup", "P3-charge arbitrage",
"cheap-night EV charging"), each with its own targets and safety limits.

### 4.4 Control philosophy (confirmed)
**Scheduled automation** — time/price-based schedules with safety guardrails. The
app is the master coordinator; both batteries follow its plan. (Not continuous
real-time control, not advisory-only.)

---

## 5. Architecture (to be designed)

- **Coordinator/scheduler** — the "boss": reads telemetry, computes the plan per
  active scenario + tariff bands, issues commands within safety limits.
- **Connectors** — Tesla (Fleet API and/or local), Sonnen (local API), Sungrow,
  EV/charger (future control).
- **Time-series store** — telemetry history for reporting.
- **Web UI** — dashboards, history, scenario config, alerts, manual overrides.
- **Notifications** — WhatsApp + PWA push.
- Safety: fail-safe defaults, guardrails, conflict resolution between batteries.

Reference dashboard the user likes: **jasonacox Powerwall-Dashboard**
(Grafana + InfluxDB + pypowerwall) — `docs/inbox/Monitoring_dashboard_example_github.txt`.

---

## 6. Hosting, connectivity & deployment

- **Host:** existing **TransIP VPS** that already runs the **Hirobo app** (also
  Claude-managed) → shared host; coexist with it.
- **Domain:** **energy.hirobo.nl** (subdomain of Hirobo.nl).
- **Workflow:** GitHub repo; publish local **DEV → LIVE**.

### 6.1 Connectivity — RESOLVED: VPN site-to-site (chosen 2026-06-24)
The **hardware is in Spain**; the **VPS is in the Netherlands**.
- **Tesla:** controllable from the **cloud** (Fleet API, EU host) → direct from the VPS.
- **Sonnen:** **no cloud control** — local LAN only (`/api/v2/`), LAN is in Spain.

➡️ **Decision:** instead of a separate home-bridge device, run a **VPN
site-to-site tunnel** terminated on the **UniFi gateway** in Spain, so the VPS can
reach the home LAN devices directly. No extra always-on box to maintain — the
gateway *is* the bridge. **Tesla via cloud from the VPS; Sonnen + optional
Tesla-TEDAPI/Sungrow over the VPN.** Setup guide: `docs/03-vpn-setup.md`.

### 6.2 Notifications
**WhatsApp** + **PWA push**. WhatsApp needs the WhatsApp Business/Cloud API or a
gateway (e.g. Twilio) — to confirm at build time.

---

## 7. Tesla Fleet API app registration (in progress)

User is registering a Fleet API app. Settings entered:
- **OAuth grant:** Authorization code ("Authorization and inter-system
  communication code") — correct for owner-on-behalf access.
- **Allowed source URL:** `https://energy.hirobo.nl`
- **Redirect URI:** `https://energy.hirobo.nl/api/auth/tesla/callback`
- **Return URL:** `https://energy.hirobo.nl`
- One app serves prod + dev (no separate Tesla envs); add
  `http://localhost:3000/api/auth/tesla/callback` for local dev. Requires hosting
  a public key at `/.well-known/appspecific/com.tesla.3p.public-key.pem` and a
  partner-token registration step (confirming in research).

---

## 8. Tech stack (decided + built)

pnpm monorepo mirroring the proven `app.hirobo.nl` setup on the same VPS:
- **apps/api** — Node 24 + TypeScript + Express 5; Sonnen (local, over the VPN) and
  Tesla Fleet (cloud) connectors; bundled with esbuild → single `dist/index.cjs`.
- **apps/web** — React 19 + Vite 7 + Tailwind v4 (dark control-room tokens); PWA-ready.
- **Deploy** — GitHub Actions build → rsync artifacts → systemd `energy-api` behind
  nginx. DB (Postgres + Drizzle) to be added when history/reporting lands.
- Repo: https://github.com/jdkroese/energy-app. Full detail: `docs/04-deployment.md`.

---

## 9. Status & open items
**Done:** API research (Tesla Fleet + Sonnen); **VPN** Spain↔VPS live; Sonnen read
+ control verified over the tunnel; Tesla Fleet API onboarded; **app scaffolded &
deployed** to https://energy.hirobo.nl (live Sonnen + Tesla on `/api/live`); GitHub
repo + CI/CD pipeline; secrets in `/opt/energy/.env` + GH Actions secrets (not git).

**Open:**
- [ ] Build out MVP pages (Dashboard, Reporting, Alerts, Settings) per `08`/`09` design.
- [ ] Add Postgres (`energy` DB) + Drizzle for telemetry history & reporting.
- [ ] Confirm which system meters Array A (Sungrow) post-migration; wire Sungrow read
      (likely `192.168.1.210`).
- [ ] EV charger make/model + smart-charge API (controllable load).
- [ ] Coordinator/control engine + scenario profiles (V1, after monitoring MVP).
- [ ] Notifications (WhatsApp + PWA push).
