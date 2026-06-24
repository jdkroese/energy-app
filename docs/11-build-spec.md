# Build Spec — Power web app (`apps/web`)

> 2026-06-24. Turns the designed screens into a buildable spec for the team that
> owns `apps/web` (React 19 + Vite 7 + Tailwind 4). **Source of truth for visuals =
> the mockups** in `docs/mockups/*` + the Power design system (`/Design system`).
> Build semantics for the brain = `docs/10-energy-brain-blueprint.md`.

---

## 0. Scope
Implement, mobile-first + responsive desktop, as an installable PWA:
**Live · Reports · Alerts · Settings · Scenarios · Brain (Today's plan)**, plus the
app shell (bottom tab bar on mobile, collapsing icon-rail on desktop). Batteries
detail is a fast-follow (not yet designed).

## 1. Stack & libraries
- React 19 + Vite 7 + Tailwind 4 (existing). API at `/api` → `:3002` (existing).
- **Routing:** React Router (file or config routes) — one route per screen (§3).
- **Data:** **TanStack Query** for fetching/polling/caching `/api/*` (cadences §7).
- **Charts:** hand-rolled SVG (port the mockups' `AreaChart`/`BarChart`/timeline) —
  no chart lib needed; keeps the exact look + bundle small.
- **Icons:** Lucide (`lucide-react`).
- **Fonts:** Space Grotesk + JetBrains Mono (self-host woff2 for offline/PWA).

## 2. Design tokens → Tailwind (do NOT invent values)
- Import the DS token CSS (`/Design system/tokens/*.css` + `base.css`) as global CSS,
  or copy the `:root` variables in. Everything keys off these CSS variables.
- Map Tailwind theme to the variables so utilities stay on-brand:
  ```js
  // tailwind.config — theme.extend
  colors: { bg:'var(--bg-0)', surface:'var(--surface-1)', surface2:'var(--surface-2)',
    border:'var(--border-1)', text:'var(--text-1)', muted:'var(--text-2)',
    solar:'var(--solar)', battery:'var(--battery)', grid:'var(--grid)',
    home:'var(--home)', ev:'var(--ev)', danger:'var(--danger)' },
  fontFamily: { sans:['Space Grotesk',...], mono:['JetBrains Mono',...] },
  borderRadius: { md:'10px', lg:'14px', xl:'20px' }
  ```
- **Rules (enforce in review):** color = meaning (solar green, battery cyan, grid
  amber, home lavender, EV violet); **every numeral in JetBrains Mono, tabular**;
  glow only on live/energy elements; sentence case; no emoji; Lucide only.

## 3. App shell & routes
| Route | Screen | Mobile nav | Desktop |
|---|---|---|---|
| `/` | Live | tab: Live | rail: Live |
| `/reports` | Reports | tab: Reports | rail: Reports |
| `/alerts` | Alerts | tab: Alerts | rail: Alerts |
| `/settings` | Settings | tab: More→Settings | rail: Settings |
| `/scenarios` | Scenarios editor | More→Scenarios | rail: Scenarios |
| `/brain` | Today's plan | More→Autopilot | rail: Autopilot |
| `/batteries` | Batteries (fast-follow) | tab: Batteries | rail: Batteries |

- **`<AppShell>`** is responsive: `< md` → `<TabBar>` (fixed bottom, glass blur,
  safe-area padding); `≥ md` → `<Rail>` (collapsing 74↔232 px, toggle persisted to
  localStorage). Content column scrolls; header per screen.
- Source: tab bar in `*-mobile.html`; rail + topbar in `desktop.html`.

## 4. Component inventory
**Primitives** — port from `/Design system/components/**` (the `.jsx` source) into the
app's React 19 + Tailwind (don't ship the DS's React-18 bundle):
`Card · StatTile · RadialGauge · Sparkline · ProgressBar · Badge · StatusDot ·
SegmentedControl · Switch · Slider · Select · Button · IconButton`.

**Signature / custom** (port from the mockups):
- **`EnergyFlow`** — the **two-battery** flow (`pwr2` SVG+CSS in `live*.html`). Props:
  `{solar, sonnen, tesla, grid, home}` each `{kw, dir, soc?}`. Animated dashes; node
  active = live; solar label above its node.
- **`PlanTimeline`** — brain day-plan chart (`energy-brain.html`): tariff-band tints,
  solar-forecast area, SoC trajectory, load line, action markers, now-marker, band strip.
- **`TariffBand`** — 24-seg P1/P2/P3 strip + current-band readout + countdown.
- **`BackupTile`** — Tesla-only kWh + autonomy hours (never includes Sonnen).
- **`AlertRow`**, **`ScenarioCard`** + editor controls, **`Rail`**, **`TabBar`**,
  **`AreaChart`**, **`BarChart`**.

## 5. Screens — layout + data binding
> "Field" = path in the API responses (§6). Build each screen to match its mockup.

### 5.1 Live  (`live-mobile.html` / `desktop.html`) — polls `/api/live`
- **Today totals** (5): `live.today.{producedKwh, consumedKwh, gridFeedInKwh,
  selfSufficiencyPct, savedEur}` (+ deltas vs yesterday).
- **EnergyFlow**: solar `live.solar.kw` (+ `arrays[]` for the A/B split), home
  `live.home.kw`, grid `live.grid.{kw,dir}`, sonnen `live.sonnen.{soc,kwh,kw,dir}`,
  tesla `live.tesla.{soc,kwh,kw,dir}`.
- **Solar now / Home load** tiles: same fields. **Tariff** card: `live.tariff.{band,
  rateEur, nextBand, minsToNext}`. **Backup**: `live.tesla.{backupKwh, backupHours}`.
- **Batteries**: per-battery soc/kwh/state. **Self-sufficiency bar**: `today.selfSufficiencyPct`.
- **Day chart**: `live.day.{solarKw[], homeKw[]}` (24×, today).
- States: `loading` (skeleton) · `stale` ("updated N min ago" if ts old) · per-device
  `offline` (StatusDot danger) · `outage` banner if `live.tesla.island===true`.

### 5.2 Reports  (`reports-mobile.html` / `desktop.html`) — `/api/history?range=`
- Range `SegmentedControl` → refetch. KPIs: `history.totals.{producedKwh, consumedKwh,
  exportedKwh, selfSufficiencyPct, savedEur, co2Kg}`.
- **Captured vs lost**: `history.solarValue.{selfUsedPct, exportedKwh, exportEur,
  worthIfSelfUsedEur}`. **Cost by band**: `history.byBand[] {band,kwh,eur,rate}` +
  `powerTermEur`. **Prod vs cons**: `history.series.{prod[],cons[],labels[]}`.
  **By load**: `history.byLoad[] {name,icon,tone,kwh,pct, estimated:true}`.

### 5.3 Alerts  (`alerts-mobile.html`) — `/api/alerts`
- Feed: `alerts[] {id,severity(danger|warning|info|ok),icon,title,sub,device,ts,
  status(new|ack|resolved)}`. Channels: `alerts.channels[] {type,detail,enabled}`.
  Rules: `alerts.rules[] {id,icon,label,enabled}`. Toggles `PATCH` later.

### 5.4 Settings  (`settings-mobile.html`) — read-only MVP
- Connections: `settings.connections[] {name,icon,tone,status,detail}`. Tariff:
  `settings.tariff.{bands[],powerTermEur,exportRange}`. Assets: `system.assets[]
  {name,icon,tone,detail}`. App: install (PWA), account, theme, version.

### 5.5 Scenarios  (`scenarios-mobile.html`) — `/api/scenarios`
- List `scenarios[] {id,name,icon,active}`. Editor binds one scenario:
  `{weights:{save,self,indep,comfort}, reserve, dynReserve, gridCharge, exportRule,
  ev, precondition, activation, trigger}`. **Projected impact** = `POST
  /api/scenarios/preview` (brain twin) returning `{selfSufficiencyPct, savedPerDayEur,
  backupHours}` — recompute on change (debounced). `POST /:id/apply` sets active;
  `PUT /:id` saves. (Edit/apply = post-MVP; render read-only first.)

### 5.6 Brain — Today's plan  (`energy-brain.html`) — `/api/brain/plan`
- Status tiles: `plan.projected.{savedEur, selfSufficiencyPct, reservePct,
  p1AvoidedKwh}`. Timeline: `plan.forecast.{solarKw[], loadKw[]}`, `plan.socPct[]`,
  `plan.tariff[]`, `plan.actions[] {h,icon,tone,title,why}`, `plan.now`. "Why now":
  `plan.whyNow.{title,body}`. This is the **shadow-mode** screen (read-only, no control).

## 6. API contract (`apps/api`)
The web consumes **normalized** JSON (don't leak raw Sonnen/Tesla shapes to the UI).
`/api/live` already returns live Sonnen+Tesla — extend/normalize to the shape in §5.1.

**MVP (read-only):**
```
GET /api/live                      → live snapshot (poll 10 s)         [extend existing]
GET /api/history?range=day|week|month|year   → reporting aggregates    [new]
GET /api/alerts                    → feed + channels + rules           [new]
GET /api/settings                  → connections + tariff + assets     [new]
```
**Phase-later (control / brain):**
```
GET  /api/brain/plan               → today's plan (shadow mode)        [new]
GET  /api/scenarios                → list + definitions                [new]
POST /api/scenarios/preview        → brain-twin projected impact       [new]
POST /api/scenarios/:id/apply      → set active                        [new]
PUT  /api/scenarios/:id            → save edits                        [new]
```
Each response: `{ ts, ...payload }`. Errors `{ error, code }`. History units: kWh, €,
%, kg. All money in EUR. Timezone Europe/Madrid for buckets.

## 7. Data layer
- TanStack Query keys per endpoint. **Poll `/api/live` @ 10 s** (background-refetch,
  keep last good on error → drive the "stale" state). History cached per range
  (staleTime ~5 min). Alerts poll ~30 s. Plan poll ~60 s.
- Show last-good data with a stale badge rather than spinners on refresh.
- Type the client; ideally share types from `apps/api` (zod schema or shared `types`).

## 8. PWA
Wire the kit in `docs/pwa-kit/` (manifest, `sw.js`, icons, head meta, register,
install-hint, safe-area CSS). See its README — 4-step copy/paste into `apps/web`.
Self-host the two fonts so the installed app works offline.

## 9. Build phasing + acceptance
- **P0 — Shell & tokens:** Tailwind token map, fonts, `<AppShell>` (TabBar/Rail
  responsive), primitives ported, PWA installable. *Done = installs on iPhone, nav works.*
- **P1 — Live:** full Live screen on real `/api/live`, 10 s polling, two-battery
  EnergyFlow, stale/offline/outage states. *Done = matches `live-mobile.html` with live data.*
- **P2 — Reports:** `/api/history`, all charts + captured-vs-lost + by-band + by-load.
- **P3 — Alerts + Settings:** feeds + connection health (read-only).
- **P4 — Brain (shadow) + Scenarios (read):** plan screen from `/api/brain/plan`;
  scenarios list + editor UI with live preview (apply/save behind a flag).
- Each screen's acceptance = pixel-and-behavior parity with its mockup + correct
  data binding + the listed states.

## 10. References
- Visual truth: `docs/mockups/*` (serve at `localhost:8777`) + `docs/mockups/README.md`.
- Tokens/voice: `/Design system` (`readme.md`).
- Brain semantics: `docs/10-energy-brain-blueprint.md`. Capability/control: `docs/05`.
- PWA: `docs/pwa-kit/README.md`. Tariff/site facts: `docs/00-project-brief.md`.
