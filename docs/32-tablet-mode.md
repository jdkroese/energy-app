# Tablet mode — wall-mounted kitchen control surface

_Owner request (2026-06-29): a "tablet mode" with big buttons and only a selection of
frequently-used features, for the tablet mounted on the kitchen wall. This doc is the
initial scope + design proposal (mockups delivered separately in-chat). No build started._

## The problem this solves

The full app is a control-room: dense dashboards, deep nav (Live · Reports · Batteries ·
Devices · Rooms · Settings · Scenarios · Automations), tariff charts, voltage history,
scenario weight sliders. That's right for a phone-in-hand or a desktop, and wrong for a
fixed kitchen tablet glanced at from across the room and tapped with one (possibly wet,
possibly oily) finger.

A wall tablet has a different physics:
- **Glanceable from 1–3 m**, not held at reading distance → big type, high contrast.
- **One-handed, imprecise taps** → large touch targets (≥56–72 px), generous spacing.
- **Shared / always-unlocked** → no per-person login; only safe, reversible controls.
- **Landscape, fixed** → design for ~1280×800, never re-oriented.
- **Always-on display** → needs a dimmed idle/ambient state (burn-in + night glare).
- **Frequent, repetitive actions** → lights, climate, blinds, scenes, "all off", panic.
  Nobody edits scenario weights or reads voltage history from the kitchen wall.

## Scope — what's in, what's out

**In (the frequently-used set):**
1. **Glance status** — clock + weather, solar now, battery SoC, grid import/export,
   tariff band, saved/self-sufficiency today. Read-only, big.
2. **Scenes** — one-tap whole-home presets (Good morning · Cooking · Movie night · Away ·
   Good night). The single highest-value tablet affordance.
3. **Lights** — per-area on/off + brightness, light scenes. (`api.lights.command`,
   `api.lights.applyScene`)
4. **Climate** — per-room current temp, setpoint ±, on/off, mode, solar-heat indicator.
   (`api.devices.command(id,'power'|'setpoint'|'mode', …)`)
5. **Shades/blinds** — per-area open/stop/close + position. (`api.blinds.command`)
6. **Favorites** — a small, configurable set of the above pinned to the home screen.
7. **Panic** — always-present alarm trigger/stop. (`api.alarm.trigger` / `.stop`)
8. **Room "all off"** — kill lights / all devices in a room. (`api.rooms.allOff`)
9. _(optional)_ **Kitchen radio/speakers** — play/pause a favorite station, volume.

**Out (kept in the full app only):**
- Reports / charts / voltage history / day chart.
- Battery arm/disarm + mode, scenario editing + weight sliders, soak-export tuning,
  battery-priority rules — **control-authority settings stay off the wall** (safety: a
  guest shouldn't disarm the batteries or re-weight the optimizer from the kitchen).
- Settings, Connections, Users, onboarding/discovery, schedules/automations editing.
- Anything destructive or hard to reverse.

Tablet mode is a **launcher over the existing control APIs**, not new control logic — it
reuses every `api.*` mutation the full app already ships. Lower risk, no new backend.

## Activation model (recommended)

Tablet mode must **not** trigger by viewport — a tablet at ≥768 px would otherwise just get
the desktop Rail, and we don't want every iPad/desktop forced into kiosk mode. Instead:

- A **device-local opt-in**, persisted to `localStorage` (e.g. `power.tablet.kiosk = '1'`),
  toggled once on that specific tablet via Settings → "Use this device as a wall tablet"
  (and an obvious "Exit tablet mode" affordance behind a long-press or a corner gesture so
  a kid can't trivially escape it). Same single responsive codebase — a new top-level
  branch in `AppShell` (alongside `desktop` / mobile) that swaps Rail/TabBar for the big
  tablet shell and routes to a reduced screen set.
- **Kiosk session**: the tablet holds a long-lived, low-privilege session (a "kiosk"/guest
  role) so it survives reboots without a login prompt and is API-limited to the safe
  control set. New role + token; the existing admin-gating already present on mutations
  (`api.control.arm`, `api.alarm.*` are admin-only today) gives us the enforcement seam.
- **Idle → ambient**: after N minutes of no touch, fade to the dimmed clock/status screen
  (mockup 3); any tap wakes to the dashboard.

## Layout & design system

Same **"Power"** dark control-room language (tokens in `apps/web/src/index.css`), reusing
the existing primitives (`Card`, `StatTile`, `RadialGauge`, `EnergyFlow`, `Icon`, `Button`,
`SegmentedControl`) at larger sizes. Three surfaces, all landscape:

1. **Home dashboard** — top status bar (clock · weather · tariff · online) → 4 glance
   tiles (solar / batteries / grid / saved) → **Scenes** row (5 big buttons) →
   **Favorites** grid (per-area light/climate/blind/radio tiles) → big bottom nav
   (Home · Lights · Climate · Shades) + persistent **Panic** button.
2. **Control sub-page** (Lights / Climate / Shades) — a grid of **one big tile per room**:
   current state large, ±/on-off/mode as ≥46 px targets, solar-heat & manual-on markers
   carried over from the existing Devices semantics.
3. **Idle / ambient** — oversized clock, weather, one status line; "tap to wake".

Touch-target floor: **56 px** for primary actions, **46 px** for steppers (vs the full
app's 26–46 px). Dark theme is the default on the wall (night glare); the light theme from
Track B remains available. Honors `prefers-reduced-motion` like the rest of the app.

## Decisions (locked 2026-06-29)

1. **Feature set** — in-scope list confirmed, **plus** kitchen radio/speakers
   (`api.radio` / `api.speakers`) **and** a live `EnergyFlow` on the home dashboard (not
   status-tiles-only). Control-authority + settings stay off the wall as scoped.
2. **Auth posture** — **kiosk/guest role, no login.** Long-lived low-privilege token that
   survives reboots, API-limited to the safe control set. (Backend: new role + token.)
3. **Scenes** — **in v1, as per the designs** (Good morning · Cooking · Movie night ·
   Away · Good night). These span lights + climate + blinds, so they need a **whole-home
   scene model** (a saved set of per-device target states + a one-tap apply that fans out
   to `api.lights/devices/blinds.*`). Light-only scenes exist (`api.lights.scenes`); the
   cross-domain model + a simple builder are new. Ships with a small starter set we define;
   owner can rename/edit later.
4. **Activation** — device-local `localStorage` opt-in via Settings (recommended), **not**
   a viewport breakpoint.

Still open (not blocking v1): **Favorites** fixed-by-us vs. owner-configurable — start
fixed, make configurable in a later phase.

## Revised v1 build shape (radio + flow + Scenes in)

- **Phase 1 (front-end, no backend)** — tablet shell + Home dashboard: top status bar,
  4 glance tiles, **live EnergyFlow**, **Scenes** row, **Favorites** grid (lights / climate /
  blinds / radio), big bottom nav + Panic; per-area **Lights / Climate / Shades** sub-pages;
  idle/ambient screen. Per-area control + Favorites run over existing APIs behind the
  `localStorage` opt-in. Favorites fixed. _Scenes row renders against the new model from P2;
  until then it can drive light-only scenes via the existing `api.lights.scenes`._
- **Phase 2 (backend)** — (a) **whole-home Scene model** + apply endpoint + a builder UI;
  (b) kiosk/guest role + long-lived token (no-login posture) + the Settings "use this device
  as a wall tablet" toggle + API privilege limiting.
- **Phase 3** — owner-configurable Favorites + Scene editing from the tablet itself.

## Rough build shape (once decisions land)

- **Phase 1** — tablet shell + Home dashboard (status tiles + bottom nav + panic) behind
  the `localStorage` opt-in, reusing existing live/devices/lights/blinds APIs. Ships value
  immediately, no backend change.
- **Phase 2** — Scenes (whole-home presets) + Favorites config.
- **Phase 3** — kiosk/guest role + token (no-login posture) + idle/ambient screen + auto
  screen-dim.

Effort: P1 ~2–3 days (pure front-end over existing APIs), P2 ~2–4 days (depends on whether
whole-home scenes are new), P3 ~3–5 days (new role/token + idle infra). All independently
shippable.
