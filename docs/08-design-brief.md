# Design Brief — Energy App (for Claude design)

> 2026-06-24. Direction agreed: **monitor-first MVP**, **calm dark control-room**.
> Source of truth for features/pages: `07-features-and-app-proposal.md`.

## 1. Product in one line
The single "boss" of a home energy system in Jávea — consolidating 2 batteries
(Sonnen + 2× Tesla Powerwall 3), 2 solar arrays, grid and an all-electric house
into one calm, trustworthy dashboard (later: active control).

## 2. Who uses it
Primarily the owner (Joris), technical, on **mobile (PWA) and desktop**. Wants an
at-a-glance "is everything OK / what's it doing" view, plus the ability to drill
into history, savings and faults. Tone: **in control, premium, calm** — not noisy.

## 3. Visual direction — "calm dark control-room"
- **Dark-first.** Deep near-black/navy canvas; content floats on subtly elevated
  panels. Generous spacing; data-dense but never cluttered.
- **Signature element:** a live **power-flow diagram** (solar · house · each battery ·
  grid) with animated flowing energy, the emotional centre of the dashboard.
- **Color:** restrained neutral base + meaningful accents — **solar/amber** for
  production, **cool blue/teal** for battery/stored, **green** for self-use/healthy,
  **red/orange** only for grid-import/alerts. Color carries meaning, not decoration.
- **Type:** clean modern sans (e.g. Inter/Geist); big legible numerics for live values.
- **Motion:** smooth, slow, purposeful (flow animation, gentle transitions) — calm,
  never flashy. Respect reduced-motion.
- **Feel references:** Tesla app's clarity + a premium ops dashboard + the calm of a
  good smart-home app. Avoid Grafana density and avoid toy-bright consumer look.

## 4. Brand tokens (starting point — refine in design)
- bg `#0B0E14` · surface `#141A24` · surface-2 `#1C2430` · border `#26303D`
- text `#E6EAF0` · muted `#8A95A5`
- solar `#F5A623`/amber · battery `#4FC3F7`/cyan · grid-import `#FF6B5E` ·
  self-use/ok `#3DD68C` · accent `#7AA2F7`
- radius 14–18px; soft shadows/glows for the flow diagram.

## 5. MVP pages (design these first)
### ① Dashboard (Live) — the hero
- **Power-flow centerpiece**: solar(both arrays)→house→batteries→grid, animated,
  signed values, live.
- **Status tiles**: total solar (kW), house load (kW), grid (import/export kW),
  **Sonnen** SoC%, **Tesla** SoC%, **current tariff band (P1/P2/P3)** w/ €/kWh,
  **Tesla backup readiness** (kWh / hours — Sonnen excluded by design).
- **"Today so far" strip**: produced / self-consumed / imported / exported kWh + € today.
- **System health** chip (all-OK / warning) linking to Alerts.
- States: live / stale-data / device-offline / outage(island) banner.

### ② Reporting / History
- Range switcher (day/week/month/year). Charts: production vs consumption,
  self-sufficiency %, grid import/export, **€ cost & savings by P1/P2/P3**,
  battery SoC over time. Export-vs-self-consumed emphasis (the key money lever).
- Headline KPIs: self-sufficiency %, € saved, kWh exported (and "value lost" framing).

### ③ Alerts
- Event feed (Tesla dropout, faults, low reserve, offline, grid outage) with
  severity, time, device, state (new/ack/resolved). Rule list. Channel setup
  (WhatsApp + PWA) — read/preview in MVP.

### ④ Settings
- Connections health (Tesla / Sonnen / weather / Sungrow) with status dots.
- Tariff config (2.0TD bands + power term + export rates). Asset inventory
  (batteries, arrays, EV, HVAC). Account/PWA install.

### Future pages (design later, keep IA room): Batteries, Solar, Scenarios/Strategy,
Forecast, Loads & Appliances.

## 6. Real data to design around (no lorem)
Live values exist for: solar kW (e.g. 11.1 kW), house load (5.5 kW), grid ±kW,
Sonnen SoC + cell/health, Tesla SoC + backup, tariff band, history (€ & kWh).
Use realistic Jávea/all-electric numbers and the 2.0TD bands in mockups.

## 7. Non-negotiables
- **PWA**: installable, mobile-first responsive, push-ready.
- **Backup readiness = Tesla only** (never show Sonnen as backup).
- Accessibility: AA contrast on dark, reduced-motion, large tap targets.
- Near-real-time refresh without jarring reflow.

## 8. Deliverables wanted from design
1. Dashboard (mobile + desktop) — hero. 2. Reporting. 3. Alerts. 4. Settings.
Plus a small component/token set (tiles, flow diagram, charts, status dots).
