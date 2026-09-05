# 53 — Home V2: the control-room redesign

Status: **shipped** (this PR). Source: the `design_handoff_home_v2` handoff from the
design agent (high-fidelity: final colours, type, spacing, motion and interaction
behaviour). This document is the build record — what the redesign is for, what it
changed, where it deviated from the handoff and why.

## The question the screens now answer first

Every surface leads with one question: **"is the coordinator doing the right thing?"**

V1 answered it last. The plan and the reasoning sat *below* six equal-weight KPI
cards, so the first thing the screen said was "here are some numbers" and the last
thing it said was "…and here is what the house is actually doing about them."

V2 leads with a **verdict**: what Autopilot is doing right now, why, how confident
it is, and what it will do if it is wrong. Numbers come after the verdict, and the
plan is a ribbon rather than a chart.

Two charts were rebuilt in depth, because in V1 each hid its own story:

1. **The day chart** — production/consumption, measured and forecast, on tariff-band
   ground, with a **scrub** that retargets the KPI row to any moment of the day.
2. **The water attribution stack** — from a smoothed stacked *area* to **stacked
   hourly columns plus a magnified overnight strip**, because a 14 L/h overnight leak
   is invisible next to a 210 L/h irrigation pulse on a shared linear scale.

## Decisions

**D1 — The verdict reads the LIVE state, never the plan.** A plan window that says
"cover the peak from 18:00" would otherwise print "running from storage" over a
0.0 kW battery flow while the house is still exporting. The plan supplies only the
label and the "since" time. The state gate (`deriveVerdict`, one function shared by
Live and the kiosk) is: discharging → charging-grid-fed → charging-solar-fed →
exporting-and-full → exporting → importing → steady.

**D2 — One aggregate serves the whole screen.** `lib/dayMetrics.ts` computes the day
once; the KPI row, the verdict chips, the insight card and the kiosk tiles all read
it. V1 computed self-sufficiency and "saved" two different ways on the same screen
and disagreed with itself. Two rules are encoded there:

- *Self-sufficiency is load met without the grid.* Grid kWh that filled the packs is
  not household import — folding a night pre-charge into the numerator makes import
  exceed household consumption and the metric collapses to 0 %.
- *"Saved · vs grid-only" must never be negative* on a night pre-charge. Booking the
  charge's cost against the whole day's avoided cost keeps it honest and positive.

Negative money is written with the typographic minus `−`, never a hyphen, and the
sign is taken from the **rounded** value so −0.001 never prints as `−€0.00`.

**D3 — Real rates, not the prototype's.** The handoff quotes P1 €0.248 / P2 €0.148 /
P3 €0.089 — those are the prototype's mock. The app uses the real 2.0TD rates from
`apps/api/src/tariff.ts` (P1 0.2093 · P2 0.1309 · P3 0.0957), now mirrored once in
`lib/dayMetrics.ts` instead of being copied per chart.

**D4 — Navigation is unchanged.** The handoff's five-item rail is the subset the
prototype modelled, not a proposal to remove Lighting / Cooling / Heating / Music /
Kitchen / Automations / Scenarios / Settings. The rail, tab bar and routes are as
they were; only the per-screen titles adopt the V2 wording.

**D5 — Nothing the design has no counterpart for was deleted.** The designer worked
from a snapshot, and the app kept growing. Where a shipped section carries
information the V2 composition does not otherwise convey, it stays, restyled to
match — see *What moved* below.

**D6 — No invented data.** Where the design asks for something the API does not
expose, the screen shows the closest real thing and says what it is, rather than a
plausible number:

| Design asks for | Shipped as |
|---|---|
| Decision log with a € value per row | The coordinator's real command audit log (`ControlStatus.log`), filtered to today: time · device + lever · the command's own reason · the value it wrote, toned solar when it stuck and grid when it failed |
| "12 decisions today · 11 as planned · 1 revised" | The same log's counts |
| Plan-ribbon capsules with kWh + € per move | `PlanAction` title · window · why (the brain does not cost individual moves yet) |
| Room cards with a kW figure | Devices-on count + the room's measured temperature when a climate device reports one (no per-device power metering exists) |
| "Mute 24 h" on the water hero | "See alerts" — a real destination; a mute button with nothing behind it would be a lie |
| Kiosk 16:10 device frame | Not reproduced — that is the prototype's device mock, not a UI element |

## Screens

| Screen | Route | Composition |
|---|---|---|
| Live | `/` | Verdict hero (+ plan ribbon + decision log) · live flow ‖ day chart · 6 KPI tiles · tariff ‖ insight · notifications |
| Reports | `/reports` | Tabs + range + period nav · 5 totals · grid import priced by band · solar value ‖ load split · production vs consumption · per-inverter history |
| Energy | `/batteries` | Storage hero (150 px gauge + SoC trace over tariff bands) · two pack cards · solar inverter rows |
| Water | `/water` | Hero (today ‖ unexplained overnight) · attribution chart (columns + magnified overnight) · zones ‖ night baseline · billing period |
| Rooms | `/devices` → By room | Summary + whole-house actions · room grid · device panel with working switches |
| Kiosk | wall tablet | Clock + verdict + 4 tiles ‖ live flow, above the unchanged Tonight / Scenes / Favorites |

Responsive: the app's own 768 px `ctx.desktop` split, plus the design's internal
**1180 px** breakpoint below which two-column rows collapse to one, the Live KPI row
goes 6 → 3, and the day chart 300 → 240 px. Phone: single column, KPI 2-up, charts
190 px, card padding 20 → 16.

## What moved (and why it wasn't deleted)

- **The 24 h forecast** — `PlanHero` (sun meter + predicted generation + SoC
  trajectory), `PlanKpis` and `TodaysMoves` now lead **Automations → Summary**. Live
  is about the present; the forecast belongs with the machinery that acts on it. The
  Summary tab's pointer note was inverted to match.
- **The kill switch** — the Live `ControlGrid` cell is gone; the verdict hero's
  `Autopilot armed / paused` button owns it (same confirm dialog, same
  `api.control.arm(false,'off')`), and the full arm/mode panel is still at
  `/settings?tab=autopilot`.
- **The water billing period** — kept below the V2 composition. AMJASA prices every
  m³ at the band the *period* total reaches, so the cliff is the one number that can
  save tens of euros, and nothing else on the screen tells that story.
- **Inverter health** — the per-inverter detail cards are gone from Energy; today's
  production split is the story there. Status still reads on each row's badge
  (Producing / Asleep / Offline / **Fault**), the night note still explains why
  "Asleep" is not a fault, and the alerting + device-health tiles on
  **Automations → Status** are untouched.
- **The Reports band chart's kWh⇄€ toggle and band-share summary** — replaced by the
  V2 readout row, which carries the band split and that bar's cost on hover and the
  period total by default. The fixed power term survives as a footnote.

## Motion

Shared keyframes live in `src/index.css` (`v2rise`, `v2amb`, `v2ping`, `v2draw`,
`v2grow`, `v2breathe`) so the global `prefers-reduced-motion` gate collapses them all
in one place — the gate's `!important` beats inline `style={{ animation }}` too.

**Entrance animations carry no fill-mode.** With a delay plus `both`, the element
sits at `opacity: 0` before the animation starts, which is also how it renders in a
static capture; with no fill mode it is visible before and after and only *moves* in
between.

Glow is reserved for live, energy-carrying elements. The ambient wash behind the
verdict hero and the kiosk board is the only decorative gradient in the system, and
it exists because glow means "live".

## Source map

| Area | Files |
|---|---|
| Derived metrics | `lib/dayMetrics.ts` (new) |
| Verdict + plan | `components/energy/VerdictHero.tsx`, `components/energy/PlanRibbon.tsx` (both new) |
| Charts | `components/energy/{DayChart,GridBandChart,BarChart}.tsx` (rebuilt), `components/water/WaterAttributionChart.tsx` (new) |
| Screens | `screens/{Live,Reports,Batteries,SolarInverters,DevicesByRoom}.tsx`, `screens/water/Overview.tsx`, `screens/tablet/TabletHome.tsx` |
| Shell | `components/shell/{AppShell,TopBar}.tsx`, `src/index.css` |
| Relocated | `components/energy/PlanSummary.tsx` → rendered by `screens/Automations.tsx` |
