# 37 — Event Viewer (unified, filterable, reproducible event log)

## Goal

Turn the current **Automations ▸ Events** tab (today just the battery *command log*) into a
proper **event viewer**: one searchable, filterable, severity-tagged timeline that captures
**everything** the system does *and* everything it detects, so any incident — a surplus-cooling
run, a force-charge, a grid outage, an over-voltage trip, a high-load spike — can be **found and
reproduced** after the fact.

Owner's asks (verbatim), mapped to the design:

| Ask | Design answer |
|-----|---------------|
| "make sure all events are captured" | Single `logEvent()` bus every coordinator + every alert rule writes to (§3); new monitors for the gaps (§5) |
| "see for each event what happened / what triggered it" | `summary` + structured `trigger {source, detail}` + `data` payload (§2) |
| "distinguish *information only* from *actions*" | `class`: `action` / `observation` / `system`; default view hides low-severity info (§2, §6) |
| "severity / importance flag (low/med/high/critical)" | `severity` enum, auto-derived at emit, override-able (§2, §4) |
| "record high current / high load / outages / system-triggered (charging / surplus cooling)" | Fold action-logs + alerts into events; add high-load / high-current monitors (§5) |
| "so we can reproduce everything" | Every event carries a `data` reproduction payload + config snapshot; durable JSONL (§2, §7) |

## 1. Why this is a merge, not a new feature

The app already has **two parallel, unmerged worlds**:

**World A — action logs (what the app *did*).** Four separate ring buffers, four shapes,
four screens:
- `control.log` — battery commands → *Autopilot ▸ Command log* (the current "Events" tab). Only 1 of 4 surfaces.
- `control.arbitrageLog` — tariff-arbitrage → *Automations* (color-coded by type).
- `devices.log` — climate / blinds / EV-breaker → device screens.
- `irrigation.log` — irrigation coordinator.

**World B — alerts (what the app *detected*).** A real, working subsystem
(`routes/alerts.ts`, `alert-loop.ts`): 6 debounced rules (`rule-offline`, `rule-outage`,
`rule-grid-charge`, `rule-export`, `rule-reserve`, `rule-voltage`), each with `severity`
(`danger|warning|info|ok`), recovery-watch, ack/resolve state, and Push/WhatsApp/Email
fan-out. Surfaced as a notifications feed (moving to the Live widget per docs/25).

The Event Viewer is the **union** of A and B behind one model, one API, one screen. Alerts
become *a subset of events* (`class: observation`, high/critical severity) — they keep their
delivery fan-out, but now live in the same timeline as the actions they relate to. That
adjacency is what makes incidents reproducible: "over-voltage at 14:02 → force-charge stalled
at 14:03 → surplus cooling cut at 14:05" reads as one story instead of three disconnected logs.

## 2. The unified Event model

```ts
type EventClass    = 'action' | 'observation' | 'system';
type Severity      = 'low' | 'medium' | 'high' | 'critical';
type EventCategory =
  | 'battery' | 'climate' | 'blinds' | 'ev' | 'irrigation'
  | 'arbitrage' | 'grid' | 'connectivity' | 'security' | 'app';
type TriggerSource =
  | 'surplus-rule' | 'schedule' | 'arbitrage' | 'manual' | 'user'
  | 'threshold' | 'guardrail' | 'health-probe' | 'coordinator'
  | 'boot' | 'deploy';

interface Event {
  id: string;                 // sortable ULID (time-ordered, unique)
  ts: string;                 // ISO timestamp
  class: EventClass;          // action = we commanded HW · observation = we detected a condition · system = app lifecycle
  category: EventCategory;    // which subsystem
  severity: Severity;         // auto-derived (§4), emitter may override
  summary: string;            // human title: "Surplus cooling started — Living room"
  trigger: { source: TriggerSource; detail?: string };  // WHAT caused it
  device?: string;            // "Living room AC", "Sonnen", breaker id
  entity?: string;            // lever / zone / unit
  change?: { from: unknown; to: unknown };  // state transition (from → to)
  ok?: boolean;               // actions only: succeeded / rejected
  detail?: string;            // longer reason or error message
  data?: Record<string, unknown>;  // REPRODUCTION payload — see below
  // observation lifecycle (conditions that clear):
  state?: 'active' | 'cleared';
  relatedId?: string;         // a 'cleared' points back to its 'active'
  // delivery (inherited from the alert model, observations only):
  ackStatus?: 'new' | 'ack' | 'resolved';
  notified?: TriggerSource[]; // which channels fired
}
```

**The three classes** (this *is* the "info vs action" split the owner asked for):
- **action** — the app wrote to hardware (battery mode/reserve/charge, HVAC on/off/setpoint/fan,
  blind position, EV breaker on/off, irrigation zone fire). `ok` distinguishes success from a
  guardrail rejection.
- **observation** — the app measured a condition that crossed a threshold or changed state
  (grid outage/restored, over/under-voltage, high current, high load, inverter fault/stall,
  device offline/online, reserve low, export-in-peak, forecast deviation). Carries
  `state: active|cleared` so a spike and its recovery pair up.
- **system** — app lifecycle (boot, deploy, arm/disarm, mode change, config edit, rule
  toggled, forecast re-plan). Low-noise but essential for "what changed before the incident".

**`data` is the reproduction key.** Every event snapshots the inputs that produced it — meter
W, grid V/A, SoC (both batteries), tariff band, clear-sky forecast, the rule's thresholds, and
the relevant config at that instant. The detail drawer renders it as a "context at the time"
panel with copy-as-JSON. Without this, "reproduce everything" is impossible; with it, an event
is a self-contained replay seed.

## 3. Ingestion — one bus, `logEvent()`

A single `logEvent(evt)` in the API is the only writer:
1. Assign `id` (ULID) + `severity` (via §4 if not supplied); append to the in-memory ring
   (~1000) **and** durable `.data/events.jsonl`.
2. If `class === 'observation'` and `severity >= high` and `state === 'active'`, forward to the
   existing `alert-loop` fan-out (Push/WhatsApp/Email) — so alerts are *emitted as events*, not
   a separate path. `rule-voltage`-style recovery-watch emits the matching `state:'cleared'` event.

**Adapters, not a rewrite.** Each existing emit site gains a thin `logEvent()` call alongside
its current per-domain log write (shim-first, low risk — the old device/irrigation/arbitrage
screens keep working). Emit sites to wrap:

| Source file | Emits | class / category |
|---|---|---|
| `execute.ts` | battery lever writes + rejections | action / battery |
| `coordinator.ts` | arm/disarm; arbitrage plan/engage/revert/standdown/deviation | system + action + observation / battery, arbitrage |
| `climate-coordinator.ts`, `climate-execute.ts` | surplus HVAC on/off, setpoint, manual-override detect | action / climate |
| `blinds-coordinator.ts` | blind position | action / blinds |
| `ev-surplus.ts` | breaker on/off | action / ev |
| `device-schedule-coordinator.ts` | scheduled actuations | action / (device type) |
| `irrigation-coordinator.ts` | plan/fire/trim/skip/suppress/confirm/alert | action + observation / irrigation |
| `alert-loop.ts` / rules | offline, outage, grid-charge, export, reserve, voltage | observation / grid, connectivity, battery |

## 4. Severity — auto-derived at emit

A central `severityFor(evt)` map keeps the scale consistent; emitters can override. Alert
severities map in: `info→low`, `warning→medium`, `danger→high`, and true safety events get
`critical`.

| Event | class | severity |
|---|---|---|
| steady-state no-op, routine setpoint nudge, blind %, fan change | action | **low** |
| surplus cooling/heating start/stop, arbitrage engage, force-charge | action | **medium** |
| arm / disarm / mode change / config edit | system | **medium** (low for config) |
| export during P1 peak, reserve < 20% | observation | **medium** |
| guardrail rejection (action failed) | action | **high** |
| device / inverter offline (daylight), high house load, high current, inverter fault | observation | **high** |
| grid outage / island, over-voltage / under-voltage trip, breaker trip | observation | **critical** |
| boot / deploy | system | **low** |

## 5. Capture the gaps — new monitors

The observation side is where "all events captured" needs net-new work. A `monitor` tick
(fold into `alert-loop`) thresholds already-live signals with **hysteresis + min-dwell +
debounce** so steady state is silent and only edges log:

- **High house load** — `home.kw > loadThreshold` (config, e.g. 5 kW) sustained ≥ 60 s →
  observation / high; clears on return below threshold − hysteresis.
- **High current** — `breaker.currentA > currentThreshold` (config, e.g. 32 A) → observation /
  high. (`currentA` + `powerW` are *already read* by the Tuya breaker connector, just not yet
  thresholded — cheap win.)
- **Grid outage / over-voltage** — already exist as `rule-outage` / `rule-voltage`; routed into
  events as `critical` with active/cleared pairing.
- **Inverter fault / stall / offline** — lands with the Sungrow work (docs/36); daylight-gated.
- **Connectivity** — Sonnen/Tesla offline/online transitions (from `rule-offline`).

Thresholds live in `store` config, editable in Settings ▸ Notifications alongside the existing
voltage band — one place for all "what counts as an event" knobs.

## 6. API

```
GET /api/events
    ?class=action,observation           # multi
    &category=battery,climate           # multi
    &severity=high,critical             # multi
    &source=surplus-rule                # trigger source
    &device=<id>
    &state=active|cleared
    &q=<free text over summary/detail/device/trigger>
    &from=<iso>&to=<iso>
    &cursor=<opaque>&limit=100          # cursor pagination for infinite scroll
GET /api/events/:id                     # full record incl. data payload
```

Server-side filter + search + cursor pagination (the log grows unbounded, so filtering can't be
client-only). Live tail via the app's existing client-side SWR poll. Ack/resolve reuse the
alert endpoints (observation events only). `GET /api/events/export?…` streams filtered JSONL/CSV
for sharing an incident.

## 7. Storage & retention (ties docs/31)

- **Durable** append-only `.data/events.jsonl` + in-memory ring (~1000) for instant reads.
- **Tiered retention** by severity so the forensic tail survives without unbounded growth:
  `critical/high` 90 d · `medium` 30 d · `low` 7 d. Pruned on the existing log-prune pass.
- ⚠️ **Known blocker:** durable JSONL writes on the mini have hit `EACCES /opt/energy`
  (see the arbitrage-events.jsonl issue). Reproducibility depends on durable writes, so fix the
  data-dir ownership/path first — otherwise the ring is all we keep across restarts.

## 8. UI — the Event Viewer (single responsive component, web + mobile)

Replaces the *Automations ▸ Events* tab; the *Autopilot ▸ Command log* and the *Automations*
arbitrage log both fold in (they become a pre-filtered view of the same stream). Follows the
Power dark control-room system. Screen designs: `docs/mockups/event-viewer-*.html` + the
Imagine mockups in the handoff message.

**Shared anatomy**
- **Filter bar** — free-text search; **Class** segmented (All · Actions · Observations · System);
  **Severity** multi-chips with color dots (Low/Med/High/Critical); **Category** multi-select;
  **Time range** (Live · 24h · 7d · 30d · custom). Default view = *Actions + Observations,
  medium+*, hiding low/info noise (directly answers "the information is overflowing").
- **Severity strip** — a thin 24 h heat-band above the list: one tick per event colored by
  severity, so you *see* when things clustered. Click-drag to scrub the time window.
- **Event row** — severity left-rail color · category icon · mono timestamp (relative, absolute
  on hover) · **class badge** (Action / Alert / System) · **summary** (bold) · **trigger chip**
  ("via surplus-rule", "threshold", "manual") · inline `from → to` · expand affordance. Grouped
  under date headers; repeated events collapse to "×N similar".
- **Detail** — the reproduction view: full `data` payload (context at the time), `trigger`,
  related active/cleared pair, ack/resolve for observations, copy-as-JSON, "export this incident".

**Desktop (≥768px)** — sticky filter bar + severity strip; **two-pane**: event list left, detail
drawer right (opens on row select). Density like the current command log but richer.

**Mobile (<768px)** — search + a horizontally-scrolling chip row; **Filters** opens a bottom
sheet (class, severity, category, range). Single-column list with the severity left-rail; tap a
row → full-screen detail sheet. Export from the sheet's overflow.

## 9. Phasing

- **Phase 1 — model + bus + read API + viewer UI.** `Event` type, `logEvent()`, adapters at the
  action emit sites (World A into events), `GET /api/events` with filter/search/pagination, the
  responsive viewer replacing the Events tab. Ships the "one searchable timeline of actions" win
  with no control-logic risk (read + logging only → deploy without disarm).
- **Phase 2 — observations in.** Route the 6 alert rules through `logEvent()` (alerts become
  events), active/cleared pairing, ack/resolve in the viewer, the severity strip.
- **Phase 3 — new monitors.** High-load + high-current thresholds (config in Settings),
  connectivity transitions; over-voltage/outage already arrive via Phase 2.
- **Phase 4 — reproduction polish.** `data` snapshots enriched to full replay seeds, incident
  export (JSONL/CSV), retention tiering + the `EACCES` durable-write fix, "×N similar" collapse.

## 10. Decisions

**Locked (owner, 2026-07-02):**
1. **Default filter** — viewer opens on *Actions + Observations, medium+* (hides low/info noise);
   one tap reveals everything. ✅
2. **High-load / high-current** — **log only, no notification.** The monitors record events into
   the timeline but do *not* fire Push/WhatsApp (unlike outage/over-voltage, which stay notifying).
   Thresholds still config-editable; wiring notifications later is a one-line change if wanted. ✅
3. **Placement** — stays the *Automations ▸ Events* tab; the arbitrage log + battery command log
   fold into it. No new top-level nav item. ✅
4. **Status** — **plan + designs only for now.** No build yet; owner reviews docs/37 + the desktop
   & mobile mockups and gives the go before Phase 1 starts (in an isolated worktree).

**Still open (pick before/at build):**
- Starting threshold values — high load (5 kW?) and high current (32 A?), plus dwell/hysteresis.
- Retention window — 90/30/7 d by severity as proposed, or a single flat window.
