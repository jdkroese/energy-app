# API Capability Matrix — Sonnen + Tesla (live-probed)

> Compiled 2026-06-24 by probing the **actual devices** (Sonnen `192.168.1.197`,
> Tesla site `1689529157873570`). This is what we can really read and control.

---

## A. SONNEN (sonnenBatterie 10) — local JSON API v2

### A1. READ
| Endpoint | What it gives |
|---|---|
| `GET /api/v2/status` *(no token)* | SoC (USOC/RSOC), `Pac_total_W`, `GridFeedIn_W`, `Production_W`, `Consumption_W`, directional flow flags, `OperatingMode`, `SystemStatus` (OnGrid/OffGrid), Uac/Ubat/Fac, `RemainingCapacity_Wh`, charging/discharging booleans |
| `GET /api/v2/latestdata` | USOC/RSOC, `Pac_total_W`, **`SetPoint_W`**, `FullChargeCapacity`, prod/cons/grid, `ic_status` (rich error/health bitfield incl. DC-shutdown reasons), UTC offset |
| `GET /api/v2/powermeter` | Per-channel meters (`WM271`): production + consumption channels, per-phase V/A, `kwh_imported`/`kwh_exported`, `w_total`, VA/var, frequency |
| `GET /api/v2/inverter` | Electrical detail: per-phase iac/uac/pac, PV strings (ppv1-4, upv), pbat/ubat/ibat, udc, **temps (temp1-5, tmax)**, sac |
| `GET /api/v2/battery` | Cell-level: `fullchargecapacitywh` (~9200 Wh actual), **`cyclecount` (882)**, charge/discharge current limits, min/max cell temp & voltage, module DC voltage, `systemalarm` |
| `GET /api/v2/io` | Digital I/O states (DI/DO) — OV/UV/CE/DE signals, DC contactor, Micro-CHP input (advanced/diagnostic) |
| `GET /api/v2/configurations` | Current values of all config keys (see A2) |
| legacy `:8080/api/v1/*` | Mirror of the above (older clients) |

→ **Live snapshot only** — no built-in history; we poll & store our own time series.

### A2. CONTROL / CONFIGURE  (`PUT /api/v2/configurations`, `POST /api/v2/setpoint/...`)
| Lever | How | Notes |
|---|---|---|
| **Operating mode** | `EM_OperatingMode` = `1` manual · `2` self-consumption · `10` time-of-use | the master switch |
| **Force charge/discharge at exact W** | `POST /api/v2/setpoint/charge/{W}` or `/discharge/{W}` (manual mode) | ⭐ **direct power control**, clamp ≤ 4600 W |
| **Backup reserve / min SoC** | `EM_USOC` (%) | currently 0% |
| **Time-of-use schedule** | `EM_ToU_Schedule` (JSON windows) + `EM_USER_INPUT_TIME_1/2/3` | grid-charge windows |
| **Forecast charging** | `EM_Prognosis_Charging` = 0/1 | currently ON |
| **Reactive power / cos φ** | `NVM_PfcFixedCosPhi`, `…IsFixedCosPhiActive/Lagging` | advanced grid support |
| Read-only nameplate | `IC_InverterMaxPower_w` 4600, `IC_BatteryModules` 2, `CM_MarketingModuleCapacity` 5500, `DE_Software` | |

**Sonnen verdict:** full, fine-grained control incl. **exact-wattage charge/discharge**.

---

## B. TESLA (2× Powerwall 3) — Fleet API (cloud, EU host)

### B1. READ
| Endpoint | What it gives |
|---|---|
| `GET /api/1/products` | site id, name, resource_type, product id |
| `GET …/energy_sites/{id}/live_status` | `solar_power`, `load_power`, `battery_power`, `grid_power`, `percentage_charged`, `grid_status`, `island_status`, `storm_mode_active`, wall_connectors, generator | 
| `GET …/site_status` | percentage_charged, battery_power, gateway_id, storm_mode_enabled |
| `GET …/site_info` | **all settings + nameplate**: `default_real_mode`, `backup_reserve_percent`, `customer_preferred_export_rule`, `edit_setting_grid_charging`, components (solar/battery/grid, tou_capable, battery_type), `nameplate_power` 10 kW, `nameplate_energy` 27 kWh, `battery_count` 2, version, install date |
| `GET …/calendar_history?kind=energy\|power\|soe\|backup\|self_consumption&period=day\|week\|month\|year` | **rich history** — solar/grid/battery/home energy with source breakdown (e.g. `grid_energy_exported_from_solar`, `battery_energy_imported_from_grid`), tz Europe/Madrid |
| `GET …/history` (legacy), wall-connector charge history | |

→ Cloud aggregates the whole site; **no per-Powerwall split** in cloud (TEDAPI-local only). History IS available server-side (unlike Sonnen).

### B2. CONTROL / CONFIGURE  (POST endpoints)
| Lever | Endpoint / field | Notes |
|---|---|---|
| **Operating mode** | `…/operation` → `default_real_mode` = `self_consumption` · `autonomous` (cost/time) · `backup` | |
| **Backup reserve** | `…/backup` → `backup_reserve_percent` (0–100) | currently 20% |
| **Grid charging on/off** | `…/grid_import_export` → `disallow_charge_from_grid_with_solar_installed` | `edit_setting_grid_charging:true` ⇒ editable |
| **Export rule** | `…/grid_import_export` → `customer_preferred_export_rule` = `pv_only` · `battery_ok` · `never` | currently `pv_only` |
| **Tariff / TOU plan** | `…/time_of_use_settings` → buy/sell schedule | feed 2.0TD → drives `autonomous` |
| **Storm watch** | `…/storm_mode` → enabled | ⚠️ `storm_mode_capable:false` on this site — verify |
| ❌ **No direct "discharge now at X kW"** | — | Tesla steered by policy, not setpoint |

**Tesla verdict:** strong **policy-level** control (mode, reserve, export, grid-charge, tariff) but **no exact-wattage command**.

---

## C. The key asymmetry → coordinator strategy
- **Sonnen = precise actuator:** can be told to charge/discharge at an exact wattage in real time. Ideal as the **fast balancer**.
- **Tesla = policy engine + big tank (27 kWh):** set mode / reserve / export / tariff and let it optimize; can't be micro-commanded. Ideal as the **bulk strategy layer**.
- ⇒ The "boss" coordinates by: setting Tesla's **mode + reserve + grid-charge + tariff** to shape the big battery's behaviour, while using Sonnen's **manual setpoints** to fill the gaps and force it to actually work (fixing "stuck at 100%"). Both expose **backup reserve** and **grid-charge control** — the two levers that directly kill the current waste.

## D. Notable gaps / to handle in the app
- Sonnen has **no history API** → we must log telemetry to our own time-series DB (Tesla has `calendar_history`, but we'll unify both in one store anyway).
- Tesla cloud = **aggregate only**; per-Powerwall detail needs local TEDAPI (optional later).
- Tesla calls are **pay-as-you-go billed** + rate-limited → poll `live_status` ~30–60 s, control event-driven.
- Tesla storm_mode capability ambiguous on this site → verify before exposing.
- Solar: Array B (16 panels) reported via Tesla; Array A (24 panels, Sungrow) historically via Sonnen but currently reads `Production_W:0` on Sonnen → **confirm where Array A is metered** (may need direct Sungrow read for full solar picture).
