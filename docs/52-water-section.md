# 52 — Water section

Design brief and scope for a new **Water** hub in the Energy app, fed by the house's
Contazara CZ3000 NB-IoT meter on the AMJASA telelectura network.

Status: **design only.** Nothing built. Interactive screen designs (desktop + mobile,
dark + light) are published as an artifact; this document is the plan behind them.

---

## 1. The thesis

The obvious build is "show me my water use". That build would be nearly useless here,
and the captured data says so plainly.

In August 2026 the house drew ~77.7 m³. **About 77% of it was irrigation.** A single
night (28 Aug) drew 10,767 L. Against that noise floor, a serious household leak —
0.6 L/min, ~864 L/day, ~€71/month — is a 1% wobble. No volume threshold, no
month-over-month comparison, and no "your usage is up 9%" nudge will ever surface it.

So the Water section is not a usage dashboard with alerts bolted on. Its organising
idea is **attribution**:

> Every litre the meter measures is either explained by something the app already
> knows about — a Rain Bird zone that ran, normal household rhythm — or it is not.
> **Unexplained litres are the product.**

We are uniquely able to do this because the app already owns the irrigation
controller and already logs every zone session to the Event Viewer (docs/39, PR #174).
The BI-WATER app cannot draw this chart. Neither can AMJASA.

### The detector that follows from it

A leak's true signature is not volume, it is **persistence**: a house with a running
cistern or a weeping valve never reaches zero flow. The meter reports hourly totals
(`cmh`), so this is directly computable:

**The quiet hour** — the lowest single-hour reading in a rolling 24 h window.
A healthy house hits 0–5 L/h at some point every night. A leaking one has a floor.
When the floor stays above the threshold for N consecutive hours, that is a leak,
regardless of how much irrigation ran on top of it.

---

## 2. What we actually have

API fully captured 2026-08-30 (mitmproxy; no cert pinning; capture files destroyed).
Details in the `energy-app-water-meter` memory. Base `https://api.contazara.es/api/2019-06-01/`,
Keycloak password grant, **no CAPTCHA**, public client `service-iot-api`, no client secret.
Access token ~10 min, refresh ~30 min — for a 6-hourly poll, just re-do the password grant.

| Endpoint | Gives us | Used for |
|---|---|---|
| `subscribers/info` | meter index, serial, address, last reading, AMJASA's own monthly/nightly thresholds | Settings, meter card, index |
| `consumption/hourly?date=` | 24 × `cmh` litres/hour | **quiet-hour + continuous-flow detection**, today's chart |
| `consumption/daily?from&to` | `cmd` litres/day | daily bars, month totals |
| `consumption/accumulatedDaily?from&to` | cumulative litres | measured-vs-accounted curve |
| `consumption/timeslot?from&to` | morning/afternoon/evening/night litres | day-part rows |

**All volumes are LITERS.** `indexVol` is the lifetime running total (÷1000 = m³).

### Two things verified during this design pass

1. **The night slot is 00:00–05:59, not 00:00–06:59.** The first six hourly values on
   29 Aug (121 + 1717 + 1271 + 1500 + 1428 = 6,037 L) match the 6,036 L the timeslot
   endpoint reported for that night. Worth asserting in a test — the detector's
   irrigation subtraction depends on aligning to the same window.
2. **Data cadence is hourly reads, ~daily upload.** This is *not* a live feed. Every
   screen must be honest that it is showing yesterday-to-a-few-hours-ago, and leak
   alerts carry an inherent detection lag of up to ~24 h. Design accordingly — no
   fake "live" glow on water numbers.

---

## 3. Phasing

### P1 — Read-only usage and reporting

Connector, storage, and the Overview + History screens. No alerting yet.

- `connectors/contazara.ts` following the `isolarcloud.ts` shape: `isConfigured()`,
  cached `getWaterSnapshot()`, `probe()`, `diagnose()`, `setFetchForTest()`. Fail-soft
  absolutely — it shares a process with the armed control loop and must never throw.
- Config in `store.ts` `IntegrationsState.contazara` + `runtime-config.ts` gating
  (returns `null` until complete), env fallback.
- SQLite: bump `SCHEMA_VERSION` in `db/sqlite.ts`, add `water_hourly` (PK `bucket_ts`)
  and `water_daily` (PK `day`, Madrid local). No 5-min table — the source is hourly.
  A `control/water-history.ts` mirroring `control/inverter-history.ts` (record →
  rollup → prune → `readWaterBuckets(range)` → `startWaterHistory()` registered in
  `index.ts` inside a try/catch).
- Backfill on first connect: pull the last 24 months of `daily` so the year view and
  same-month-last-year comparison work from day one.
- Routes `GET /api/water` and `GET /api/water/history?range=` via `routes/water.ts`.
- Screens: Overview + History tabs. Reuse `ShellContext.range` + local `offset` +
  `PeriodNav` + `lib/periods.ts` exactly as Reports does; do not invent a new period
  abstraction.

**Ships useful on its own** — the owner has never had a hourly view of this meter.

### P2 — Attribution and anomaly alerts

The actual point of the feature.

- **Irrigation reconciliation.** Join hourly meter buckets against logged Rain Bird
  sessions (`category:'irrigation'` events already carry zone + measured duration).
  Learn per-zone L/min from hours where exactly one zone ran and nothing else did;
  store on the zone. Attributed = Σ(zone L/min × minutes in that hour).
- **Detectors**, all as `monitors.ts`-style edge state with hysteresis + min-dwell:
  - *Continuous flow* — no hour below the quiet-hour floor for N hours. Critical.
  - *Night use* — night slot above tolerance **after** subtracting attribution.
  - *Daily spike* — day above k × 30-day median, unattributed.
  - *Monthly budget* — projection, not arrival, so it warns while it still matters.
  - *Meter silent* — no new reading for N hours (connector health, not water).
- Add `'water'` to `EventCategory` in `events.ts` (it does not exist today).
- Alerts fan out through the existing path: a `critical` observation event auto-forwards
  via `maybeForward()`, so Push/WhatsApp/Email need no new plumbing. A `rule-water-*`
  entry in `RULE_META` + `evaluateLiveAlerts()` gives per-rule enable/disable.

### P3 — Cost, and closing the loop with irrigation

- Configurable Spain/AMJASA tariff: service charge, three consumption blocks,
  sewerage, canon de saneamiento, IVA. Cost shown per period and — the useful bit —
  **cost attributed to the leak specifically**, at the marginal top block, because
  that is what the waste actually costs.
- Feed learned per-zone L/min back into the irrigation ET engine, replacing assumed
  flow rates with measured ones. This makes the water meter a *sensor for the
  irrigation system*, not just a bill tracker.
- Optional: reconcile against real AMJASA invoices, joining docs/30 (invoice tracking).

---

## 4. Where it slots into nav

Water is a **resource hub**, like Energy at `/batteries` — not a device category.
So: new route `/water`, added to `NAV_DEVICES` in `nav.ts` **directly after Energy**,
before the device categories.

```ts
export const NAV_DEVICES: NavItem[] = [
  { to: '/batteries', label: 'Energy', icon: 'zap' },
  { to: '/water',     label: 'Water',  icon: 'waves' },   // new
  { to: '/devices?type=lighting', label: 'Lighting', icon: 'lightbulb' },
  ...
];
```

`waves`, not `droplet`/`droplets` — **`droplets` is already Irrigating**, and two
near-identical drop glyphs three rows apart would be a genuine misread.

Also needs: a `META['/water']` entry in `AppShell.tsx` (otherwise the TopBar falls
back to a generic title), a `lazy()` import + `<Route>` in `App.tsx`, and an entry in
`MOBILE_MORE_SECTIONS`. In-screen tabs (Overview / History / Alerts / Settings) follow
the `Automations.tsx` `?tab=` + `useSearchParams` pattern so they are deep-linkable.

**Note:** `MOBILE_TABS` is a deliberately fixed set of four (Live, Reports, Energy,
Devices). Water therefore lives in the More sheet on the phone. The mockup shows this
honestly — see open decision D2.

---

## 5. Design system notes

Follows Power throughout; tokens lifted from `apps/web/src/index.css`, both themes.

**One new hue.** Water needs a section colour and every existing one is spoken for
(solar green, battery cyan, grid amber, home purple, EV indigo). Added:

```css
--water: #4aa3ff;   /* dark  */   --water: #1f6fd0;   /* light */
```

An azure 22° off battery cyan. Validated with the dataviz palette validator against
`--surface-1`: ΔE 14.7 (deutan) / 15.2 (normal) vs battery — comfortably separable.

**Series colours**, in fixed stack order irrigation → household → unexplained:

| Series | Dark | Light | Why |
|---|---|---|---|
| Irrigation | `#8bd450` | `#4f8f1e` | reuses the existing soc-sonnen yellow-green family |
| Household | `--home` `#c4a6ff` | `#6d44d1` | `--home` already means "the house's own draw" |
| Unexplained | `--danger` `#ff5d5d` | `#cf2a2a` | it is a status, and ships with icon + label, never colour alone |

The order matters: an earlier ordering put irrigation-green adjacent to danger-red,
which collapses to **ΔE 1.3 under deuteranopia** — indistinguishable. Reordered so red
neighbours purple instead: ΔE 21.5. Keep this order in the build.

> **Incidental finding, not fixed here:** the app's *existing* series palette fails the
> same check — `--series-charge` (battery cyan) against `--series-consumption` (home
> purple) is **ΔE 4.4 under deuteranopia**, and they appear together in DayChart. Worth
> a separate look; out of scope for Water.

Charts are hand-rolled SVG per house convention (no chart library). Note there is **no
`Sparkline` primitive** in `components/ui/` — the day-part small-multiple rows need one
built, and it is likely reusable elsewhere.

---

## 6. Open decisions — for the owner

**D1 · Credential storage.** The brief assumed connector credentials are "encrypted at
rest, same as other connectors". **They are not.** All integration credentials —
Tuya, Sungrow, Rain Bird, Mercadona — are plain fields in `state.json`, protected by
filesystem permissions only. There is no secrets vault. Options: (a) store the
Contazara password the same way as everything else and accept the existing posture;
(b) build real at-rest encryption as a separate piece of work covering *all*
connectors. **Recommend (a) now, (b) as its own task** — doing it for one connector
only would be security theatre.

**D2 · Mobile nav.** `MOBILE_TABS` is a fixed four. Water in the More sheet is two taps
from anywhere. Given leak alerts are the reason this exists, is that acceptable, or
should Water replace one of the four (Devices is the weakest) — or should the tab bar
grow to five?

**D3 · Alert aggressiveness before attribution exists.** P1 ships without irrigation
reconciliation. Do we (a) ship P1 alert-free and wait for P2, or (b) ship a
night-only continuous-flow alert in P1, accepting that irrigation nights will produce
false positives until P2 lands? **Recommend (a).** A leak detector that cries wolf on
every watering night gets muted within a week, and then it is worth nothing.

**D4 · AMJASA's own thresholds.** `subscribers/info` shows AMJASA already stores
`monthlyConsumption` and `nightlyConsumption` alert thresholds server-side, and the
BI-WATER app can push notifications. Do we mirror those values, ignore them, or write
to them? (Writing is unverified — we only captured reads.) **Recommend: read and
display them for reference, own our own thresholds, do not write.**

**D5 · Tariff figures.** Every rate in the mockup is a **placeholder**, not a published
AMJASA rate. Need a real bill to populate blocks, sewerage, canon and IVA. Until then
cost figures should be labelled as estimates in the UI.

**D6 · Poll cadence.** Data is hourly-read, ~daily-upload. Every 6 h is plenty and
cheap. Worth confirming there is no rate limit we should respect — we have no
documentation, only captured traffic.

---

## 7. Risks

- **Unofficial API.** No contract, no notice of change. Same class of risk as Tuya
  (see docs/49) and Mercadona. Mitigation: fail-soft everywhere, treat the meter as
  optional, alert on *silence* so a breakage is visible rather than silent. Note that
  unlike Tuya there is no local fallback — if Contazara changes, water goes dark.
- **Password grant.** Credentials must be re-entered if the account password changes;
  surface a clear "reconnect" state rather than a generic error.
- **Detection lag.** Up to ~24 h from leak start to alert, bounded by upload cadence.
  Should be stated in the UI, not hidden.
- **Attribution quality.** Learned zone flow rates depend on hours where exactly one
  zone ran. If the Rain Bird schedule overlaps zones, learning is slower. Fall back to
  a manual per-zone L/min entry.

---

## 8. Build order

1. P1 connector + storage + backfill, tests hermetic via `setFetchForTest()`
   (`node --import tsx --test`, not vitest).
2. P1 Overview + History screens, both viewports.
3. Owner connects the account, verify real data on the mini.
4. P2 attribution + detectors, shadow-log for one irrigation cycle before enabling
   fan-out — same discipline as the rule engine (docs/40).
5. P3 tariff + ET feedback.
