# 36 — System Status board (whole-home health · load · use)

**Status:** proposed (design + plan) · **Owner ask (2026-07-02):** "enhance the status
page showing health / load and use and status of all devices."
**Author:** design/orchestration agent · **Surface:** `/automations?tab=status`

---

## 1. The problem

Today `/automations?tab=status` is the embedded **Autopilot Status tab**
(`apps/web/src/screens/Autopilot.tsx:347-400`). It only shows the **battery control
plane**: Tesla targets, Sonnen mode, the four guardrails, and the Tesla-backup card.
It says nothing about the ~8 other subsystems and dozens of devices that actually run
the house — no connectivity truth, no live load, no per-device health.

The owner wants this page to become the **control-room "is everything OK, and what's
it doing?"** view across the *whole* home: **health** (is each device/subsystem
reachable and error-free), **load & use** (what's producing/drawing power right now +
today's energy), and **status** (operating mode / armed state / guardrails).

## 2. What data already exists (grounding)

All of the following is already served — the board mostly *composes* it (see §6 for the
one backend add). Field references are real.

**Per-device connectivity** — every connector exposes `online: boolean`:
Intesis/Panasonic + Airzone climate (`currentTempC, mode, power, setpointC, fanLevel,
lowBattery`), Tuya lights (`brightnessPct, online`), Tuya blinds (`positionPct, moving,
online`), Tuya generic circuits (`values{dp}, online, learnedDrawW, evState`), Sonos
(`online, volumePct`), Rain Bird zones (`available`), batteries
(`online, soc, kwh, health%, tempC, cyclesTotal, warrantyPct`). Sonnen/Tesla report
`online:true` from their normalizers.

**Subsystem-level errors** — `DevicesResponse.lastError`, `LightsResponse.fleetError`,
`BlindsResponse.fleetError`, `IrrigationResponse.lastError`, Sonos `lastError`,
`ControlStatus.lastError`, `DevicesStatus.lastError`.

**Connector health probes** — `/api/settings` → `probeAll()`
(`apps/api/src/routes/settings.ts`, `health-probe.ts`) returns per-connector
`{ name, tone: ok|danger, status: connected|offline, detail }` (today: Tesla, Sonnen,
Weather — extend to the rest, §6).

**Live load / flow** — `/api/live` (`LiveResponse`): `solar.kw` (+ per-array
`arrays[]`), `home.kw`, `grid.kw+dir`, `sonnen.kw+dir+soc`, `tesla.kw+dir+soc+backup*`,
`climateSurplusKw`, `batteryDataComplete`, `tariff.band+rateEur+minsToNext`, and the
optional metered **`breaker{voltageV,currentA,powerW}`**. Today totals: `today.
{producedKwh, consumedKwh, gridFeedInKwh, selfSufficiencyPct, savedEur}`.

**Per-circuit energy** — `/api/breakers/:id/usage` + summary (doc 28, metering) — the
future backbone of the "use" breakdown as it scales 3→40 metered breakers.

**Control truth** — `ControlStatus.current.{tesla,sonnen}`, `.guardrails`
(`socFloorPct, teslaReserveMinPct, sonnenMaxW, gridImportCapKw`), `.armed/.mode`, the
command `log[]`; climate arm from `DevicesStatus.armed/mode`.

**Grid quality** — voltage monitor (`voltageMonitor{enabled,minV,maxV,breakerId}` +
live breaker voltage) — directly relevant to the recurring **Sonnen over-voltage trip**
issue; belongs on this board.

**Alerts** — `Alert{severity: danger|warning|info|ok, title, sub, device, ts, status}`.

## 3. Health model (one shared derivation)

A small client helper `deviceHealth(device) → { state, reason }` (promote to
`apps/web/src/lib/health.ts`), reused by every subsystem row and the summary:

| state | tone | trigger |
|---|---|---|
| `ok` | `--solar` | `online` true, no error, data fresh |
| `warning` | `--grid` (amber) | `lowBattery`, voltage out-of-band, stale snapshot, stuck manual-override |
| `error` | `--danger` | subsystem `lastError`/`fleetError`, connector offline, command rejection |
| `offline` | `--text-3` | `online:false` / zone `available:false` |
| `nosetup` | dim | discovered but not configured |

A subsystem rolls up to its **worst** child state. The page-level health score =
`devicesOnline / devicesTotal` with worst-state escalation.

## 4. Information architecture

Keep the URL `/automations?tab=status` (deep-link stability; the Summary tile already
links here). **Reframe** the tab from "battery control truth" → "whole-home System
Status", with battery control kept as one section. Order top→bottom (desktop: 2-col
grid where noted; mobile: single column):

1. **System health banner** — one-line verdict + counts + worst-issue callout.
2. **Connectivity** — per-connector reachability grid (the 8 subsystems + infra).
3. **Live load & flow** — the "use" section: live power KPIs + live-draw breakdown.
4. **Device health matrix** — per-subsystem rows, dense StatusDot grid, issues first.
5. **Battery control & guardrails** — the existing Status content, retained.
6. **Grid quality** — voltage KPI + over-voltage guard state.
7. **Alerts & recent errors** — active alerts + rejected commands.

## 5. Section specs

### 5.1 System health banner
Full-width card. Left: big status pill — `All systems nominal` (solar) /
`N warnings` (amber) / `N offline` (red), driven by the worst rolled-up state. Right:
mono counts `— / — devices online · — subsystems · — alerts`. If any error/offline,
a one-line "worst issue" summary ("Airzone webserver unreachable · 3 lights offline").
Reuses `StatusDot` (live pulse) + `Badge`.

### 5.2 Connectivity grid
Grid of small tiles (desktop `repeat(4,1fr)`, mobile `1fr 1fr`), one per connector:
Climate (Intesis), Underfloor (Airzone), Batteries (Sonnen), Batteries (Tesla), Tuya
Cloud, Speakers (Sonos), Irrigation (Rain Bird), Weather. Each tile: icon + name +
`StatusDot` tone + `detail` line (`Cloud OK` / `LAN reachable` / last error) + relative
last-seen. Data: extend `probeAll()` to cover all connectors (§6) — until then, derive
tone from each list endpoint's `fleetError`/`lastError` + child `online` counts.

### 5.3 Live load & flow ("use")
The heart of the "load and use" ask. Two parts:

**(a) Live power strip** — KPI tiles from `/api/live`: Solar `+X.X kW` (arrays A/B
split on tap), Home load `X.X kW`, Grid `import/export X.X kW` (tone by dir), Batteries
`±X.X kW · SoC%`, Self-sufficiency `today %`, Tariff `P_ · €/kWh`. Mono numerals,
`StatTile` style. A compact `EnergyFlow`-style glyph on desktop.

**(b) Live-draw breakdown** — "where the power is going right now": a ranked
horizontal-bar list of known consumers — each **metered breaker** (`breaker.powerW`,
scaling to the doc-28 fleet), the **car charger** (`evState.reservedW`/`learnedDrawW`
when its rule is on), **HVAC units currently running** (cooling/heating devices with
`power:on`, labelled by mode+setpoint; power estimated until metered), plus a computed
**"other / unaccounted"** = `home.kw − Σ known`. Today this is partial (one metered
breaker + learned draws); it becomes a full per-circuit bar as breaker metering lands —
call that out. Below it: today totals row (produced / consumed / grid feed-in / saved €).

### 5.4 Device health matrix
One collapsible row per subsystem (Climate, Batteries, Lighting, Circuits, Blinds,
Speakers, Irrigation), **rooms alphabetical** within each (standing rule). Row header:
icon + name + `online/total` + worst-state `StatusDot`. Expanded: a dense wrap of
per-device chips (name + `StatusDot` + key telemetry: temp/mode, brightness, position,
SoC, volume). **Issues float to the top** — offline/warning/error devices shown first
and always, even when the row is collapsed. Low-battery thermostats (Airzone
`lowBattery`) surface here.

### 5.5 Battery control & guardrails
Retain the current Status content verbatim (Tesla targets, Sonnen mode, the 4
`GuardTile`s, Tesla-backup kWh/hours card). It's the "status" of the control plane and
already good — just now nested under the broader board.

### 5.6 Grid quality
Voltage KPI: live breaker voltage vs `[minV,maxV]` band with an in-band/out-of-band
`StatusDot`; when out of band, the over-voltage guard note (ties to the known Spain grid
over-voltage → Sonnen trip issue). Only shown when a voltage-capable breaker exists.

### 5.7 Alerts & recent errors
Active `danger|warning` alerts (title/sub/device/relative-time) + the last few **rejected**
control commands from `ControlStatus.log` (`!ok`). Empty-state: "All clear."

## 6. Backend (one add, rest composes)

**v1 can ship with zero backend** by composing existing endpoints client-side
(`/api/live`, `/api/devices` + `.status`, `/api/lights`, `/api/blinds`, `/api/sonos`,
`/api/irrigation`, `/api/batteries`, `/api/settings`, `/api/control/status`). That's a
lot of parallel polls, so **recommended**:

**`GET /api/system/status`** — a read-only aggregator that merges connector health +
device online/total per subsystem + a `/live` subset + guardrails/armed + voltage +
alerts into **one payload** the board polls (~10 s). Shape:
```
{ ts,
  health:     { state, devicesOnline, devicesTotal, subsystems, alerts },
  connectors: [{ key, name, tone, status, detail, lastSeenTs, lastError }],
  subsystems: [{ type, label, online, total, worst, issues:[{id,name,state,reason}] }],
  live:       { solar, home, grid, sonnen, tesla, climateSurplusKw, today, tariff, breaker },
  control:    { armed, mode, climateArmed, guardrails, current },
  voltage:    { v, min, max, ok } | null,
  alerts:     [Alert] }
```
Plus: **extend `probeAll()`** to cover Airzone, Intesis, Tuya, Sonos, Rain Bird (each
already has a health path per the connector map) and stamp a `lastSeenTs` per connector.
Entirely additive + read-only → ordinary deploy, **armed state preserved**.

## 7. Components (reuse first)

Reuse: `StatusDot` (tone+live), `Badge`, `StatTile`, `Card`, `SegmentedControl`,
`ProgressBar`/`RadialGauge`, `States` (Empty/Loading), `Icon`, `EnergyFlow`.
New (small, in `components/status/`): `SystemHealthBanner`, `ConnectivityGrid`,
`LiveLoadStrip`, `LiveDrawBreakdown`, `SubsystemHealthRow`, `GridQualityCard`, and the
`lib/health.ts` `deviceHealth()` helper. Both viewports handled by branching on
`ctx.desktop` (grid columns + collapse behaviour), per the standing web+mobile rule.

## 8. Phasing

- **Phase 1 — compose (no backend):** health banner, connectivity grid (from
  fleetError/online), live-load strip + today totals, device health matrix,
  keep battery control + guardrails, alerts. Ships the whole *look* + most of the value.
- **Phase 2 — aggregator + probes:** `/api/system/status` + `probeAll()` coverage +
  `lastSeenTs`; swap the board onto the single poll; adds real per-connector reachability
  + stale detection.
- **Phase 3 — full "use":** per-circuit live-draw breakdown powered by breaker metering
  (doc 28); optional health uptime/history sparkline per subsystem.

## 9. Open decisions (recommended in **bold**)

1. **Home for it** — keep it as the **Status tab under /automations** (reframed
   whole-home) vs promote to a top-level "System" screen in the Rail/TabBar. Recommend
   **keep the tab now**, revisit promotion once it earns its weight.
2. **v1 scope** — **Phase 1 (compose, no backend)** first to validate the layout, then
   Phase 2 aggregator — vs build the aggregator up front. Recommend **Phase 1 first**.
3. **Live-draw estimation** — show **estimated** HVAC/other draw (labelled "est.") in
   v1, or only show truly-metered draws until doc-28 lands? Recommend **estimated,
   clearly labelled**, so the section isn't empty.
