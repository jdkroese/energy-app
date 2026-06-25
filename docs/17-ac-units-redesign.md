# Dev brief — AC units (Cooling group) redesign

**Context:** First slice of the Devices grouping work. Devices becomes a hub of typed
groups (Cooling/AC, Heating, Lighting, Circuits…). This brief covers the **Cooling group
list screen** + the **per-unit detail**, both upgraded to the full Intesis control surface.
Design mockups approved 2026-06-25. Brand = "Power" design system (dark control-room).

**Standing rule:** ship web (≥768px, `ctx.desktop`) **and** mobile (<768px) — both branches in
the same responsive screen. Verify both viewports.

---

## 1. Data model

`apps/web/src/lib/types.ts` + `apps/api/src/routes/devices.ts` (`DeviceView`):

```ts
type ClimateLever = 'power' | 'mode' | 'setpoint' | 'fan'
  | 'vaneUpDown' | 'vaneLeftRight';            // + 2 new levers

// DeviceView additions (cooling units; null/undefined for non-AC types):
fanSpeed:      'auto' | 1 | 2 | 3 | 4 | 5;
vaneUpDown:    'auto' | 'swing' | 1 | 2 | 3 | 4 | 5;
vaneLeftRight: 'auto' | 'swing' | 1 | 2 | 3 | 4 | 5;
filter?:       { lifePct: number; daysLeft: number | null };   // read-only
maintenance?:  { alert: boolean; reminderMonths: number | null };
```

Also add the `type: 'cooling' | 'heating' | 'lighting' | 'circuit'` discriminator that the
grouping hub depends on (set per connector: Intesis→`cooling`, Airzone→`heating`).

## 2. Backend

- `apps/api/src/connectors/intesis.ts` — map the two vane datapoints + multi-step fan to
  read fields and add them as writable levers (standard AC Cloud Control datapoints).
  Surface `filter`/`maintenance` status fields where the API exposes them; omit otherwise.
- `apps/api/src/routes/devices.ts` — extend the lever allow-list + `parseValue` for
  `fan` (1–5 | 'auto'), `vaneUpDown`, `vaneLeftRight`. Clamp/validate server-side.
- **Gating unchanged:** all command/bulk writes stay **admin + armed**. Reads any-authed.
  Bulk = existing `api.devices.bulkCommand(ids, lever, value)`; setpoint nudge loops per-id.

## 3. AC units — list screen  (was `Devices.tsx`)

- **Header:** breadcrumb `Devices › AC units`, title **AC units**, subtitle `N units ·
  <installation>`. Right: list/grid view toggle (grid is a later enhancement, ship list).
- **Summary tiles (replace the old strip):** *Cooling now (n/total)* · *Indoor avg* ·
  *Warmest room* (value red when hot) · *Surplus* (precool headroom kW). Drop Batteries + Band.
- **Autopilot banner — state-honest:** when disarmed show "Autopilot · Disarmed — pre-cool
  paused, units run manually" + **Arm** button. When armed + cooling, the green active state.
  (Removes today's contradictory "active · Disarmed".)
- **Quick-select chips:** `All · Cooling · Warm · Off` — each selects the matching subset.
- **Bulk editor (key feature):** when ≥1 selected, render a panel using the **same controls
  as the detail page** — Power on/off, Mode segmented, Setpoint stepper (set-all or ±0.5°
  nudge), stepped Fan. Footer: `Apply to N units` (primary) + `Add to schedule` (creates a
  schedule scoped to the selection — see schedules refactor) + Clear.
- **Rows:** checkbox · name/room · state pill · mode · **fan** (mini bars / Auto) · set ·
  room (warmth-colored: comfortable=text, warm=`--grid`, hot=`--danger`) · power/open.
- **Mobile:** summary 2×2; chips scroll; bulk panel as a compact sheet; rows 2-line.

## 4. AC unit detail  (`DeviceDetail.tsx`)

Adds to the existing setpoint/room/power/mode layout:
- **Mode:** Auto · Cool · Heat · Dry · Fan (icon segmented).
- **Fan:** stepped Low→High bar + Auto chip (replaces the 4 plain chips).
- **Vanes:** two compact controls — Up/down and Left/right — each `Auto · 1–5 · Swing`.
- **Autopilot banner** (include/exclude from solar-surplus pre-cool) — unchanged.
- **Schedule object:** this unit's schedule shown inline as a timeline card; "inherits group"
  + per-unit overrides; `+ Add`. (Backed by schedules refactor.)
- **Config & service block (read-only, gear-configurable):** Filter cleaning (life % / days
  + Reset), Maintenance (alert state / reminder months), plus Temp limit / Comfort band /
  Installation / Signal tiles.
- Registry renders vanes/fan-steps **only for `type:'cooling'`** (Airzone heating has none).

## 5. Notes / out of scope

- Use existing `components/ui` primitives (Card, Icon, Button, IconButton, SegmentedControl);
  reuse the 5 energy hues only — no new colors. Numerals in `.pwr-mono`.
- Schedules refactor (schedules target any group; appear as objects on detail pages) is a
  **separate brief** — here, only the `Add to schedule` entry point + the detail schedule card.
- Heating / Lighting / Circuits group + detail screens are later slices.

**Open questions for product:** does Intesis expose filter-life/maintenance on this account
(else hide the block)? Confirm fan step count per unit (4 vs 5).
