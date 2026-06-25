# 19 · Schedules + device-detail redesign — development brief

Design owner: design agent. Status: **concept approved, ready to build.** Brand: "Power"
design system (dark control-room). Every screen ships **web + mobile** (branch on
`ctx.desktop`) per the standing rule in `CLAUDE.md`.

This brief covers three deliverables that share one data model:

1. **Device detail (cooling)** — full Intesis control surface + a unit-grouped schedule box.
2. **Schedules page** — one box per unit/group, each holding that unit's rules.
3. **Edit-rule overlay** — replaces the separate editor page (modal on desktop, bottom sheet on mobile).

---

## 1. Data model

### 1.1 Schedule = belongs to ONE unit (or group)

The biggest change from today's `Schedule`: a schedule (now called a **rule** in the UI)
targets a **single** unit or a single named group — not a `deviceIds[]` array. This is what
makes per-unit grouping and the no-overlap guarantee clean. "Copy to units" **duplicates**
the rule into other units as independent rules.

```ts
type DeviceType = 'cooling' | 'heating' | 'lighting' | 'circuit'; // extensible

interface ScheduleWindow {
  start: string;            // "14:00"
  end: string;              // "17:00"  (end < start ⇒ wraps past midnight)
  action?: Partial<Action>; // optional per-window override; inherits rule.action
}

interface Action {                 // type-adaptive; cooling shown
  power: boolean;
  mode: 'auto' | 'cool' | 'heat' | 'dry' | 'fan';
  setpointC: number;
  fan: 'auto' | 1 | 2 | 3 | 4 | 5;
  vaneUpDown: 'auto' | 1 | 2 | 3 | 4 | 5;      // A or one of 5 positions
  vaneLeftRight: 'auto' | 1 | 2 | 3 | 4 | 5;   // independent of vaneUpDown
}

type RunCondition =
  | { kind: 'always' }
  | { kind: 'warmerThan'; thresholdC: number }  // run only if room temp > threshold (cooling)
  | { kind: 'coolerThan'; thresholdC: number }; // run only if room temp < threshold (heating)

interface Schedule {              // = "rule"
  id: string;
  name: string;                   // editable in the overlay (e.g. "Daily cooling")
  enabled: boolean;
  type: DeviceType;
  scope: { kind: 'unit'; deviceId: string } | { kind: 'group'; groupId: string };
  days: number[];                 // 0=Sun..6=Sat
  windows: ScheduleWindow[];      // ≥1; multiple allowed (morning/afternoon/evening)
  action: Action;                 // default for all windows
  condition: RunCondition;        // replaces roomTempAboveC (migrate: warmerThan)
}
```

**Migration of existing schedules:** `start`/`end` → `windows: [{start,end}]`;
`mode`+`setpointC` → `action`; `scope.deviceIds` → split into one rule per device (`scope.kind:'unit'`);
`roomTempAboveC` (non-null) → `condition: {kind:'warmerThan', thresholdC}` else `{kind:'always'}`.

### 1.2 Action levers (Intesis) for device detail

`DeviceView` (cooling) gains, and `ClimateLever` extends:

```ts
type ClimateLever = 'power' | 'mode' | 'setpoint' | 'fan' | 'vaneUpDown' | 'vaneLeftRight';
// DeviceView += fanSpeed, vaneUpDown, vaneLeftRight,
//   filter?{lifePct,daysLeft}, maintenance?{alert,reminderMonths}
```
`vaneUpDown` and `vaneLeftRight` are standard Intesis AC Cloud Control datapoints, mapped in
`connectors/intesis.ts`. Each is `'auto'` (A) or position `1..5`. The two axes are **independent**.
Airzone heating zones have no vanes/fan — the registry hides those controls for `type:'heating'`.

---

## 2. Validation — NO OVERLAPPING RULES PER UNIT (hard rule)

For any single unit, **two enabled rules may not cover the same minute on the same weekday**,
and **windows within one rule may not overlap each other**. Enforce both client-side (block
Save, show inline message) **and** server-side (reject the write).

- Overlap check expands wrap-past-midnight windows into two segments before comparing.
- A rule scoped to a **group** checks overlap against every member unit's rules.
- **Copy to units:** when duplicating, any target unit where the rule would overlap an existing
  rule is **disabled in the picker** (greyed + "overlaps" tag) and skipped on save — never
  silently dropped.

---

## 3. Components

### 3.1 `ScheduleRuleObject` (the reusable atom)

Used identically on the device-detail schedule box and the Schedules page rows.

- One-line header: rule name (+ inline edit affordance → opens overlay) · action summary
  (mono, mode/type-hued) · optional condition tag (amber "if >27°" / cyan "if <19°") · edit
  icon · enable switch.
- **Seven per-day toggle cells** (M T W T F S S) — each independently toggles that weekday;
  green = active, dark = off. Writes `days` immediately.
- **24h track, 30-minute columns** — render with two stacked CSS `repeating-linear-gradient`s
  (faint line every `100%/48`, stronger every `100%/4`); **green window bars** are absolutely
  positioned spans at `left = startMin/1440`, `width = durationMin/1440`, solar-green with a
  soft glow (green = scheduled/active, regardless of device type). Wrap-midnight ⇒ two bars.
- Optional `00 06 12 18 24` mono axis labels under the track.
- Height target: ~40% shorter than the original block.

### 3.2 `UnitScheduleBox`

Card titled **"<unit/group name> — <Device type>"** (e.g. "Bo's room — Cooling"), a `+ Add rule`
action, and a stacked list of `ScheduleRuleObject`s for that scope. Footer micro-note: rules
for one unit can't overlap. The box title is **not** editable (it's the unit); **rule names are**.

### 3.3 Device-detail control additions

Mode (auto/cool/heat/dry/fan) · stepped fan (Low→High + Auto) · **two independent vane
selectors** (`A` + positions `1–5`) · filter & maintenance status tiles. The `UnitScheduleBox`
sits between the autopilot banner and Config & service.

---

## 4. Edit-rule overlay (replaces the page)

- **Desktop:** centered modal over a `rgba(0,0,0,.5)` scrim. **Mobile:** bottom sheet with grab
  handle. (Per host constraints, do not use `position:fixed`; the production app uses its real
  modal/portal layer.)
- Contents, top → bottom: **editable name** (+ "<unit> · <type>" subtitle) · **Operation**
  (mode, setpoint, fan, up/down vanes, left/right vanes) · **Days** (+ Weekdays/Every-day
  presets) · **Time windows** (add/remove, overlap guard message) · **Run condition** (3-way
  segmented: Always / Only if warmer than / Only if cooler than + threshold input) · **Copy to
  units** (other units of the same type; overlapping targets disabled) · Save / Cancel.
- Opens from: `+ Add rule`, a rule's edit icon, or the inline name-edit affordance — on both the
  detail box and the Schedules page. Single source of truth; same overlay everywhere.

---

## 5. Routes & reuse

- `/devices/:id` — detail page renders `UnitScheduleBox` filtered to that unit's rules.
- `/schedules` — type filter (All/Cooling/Heating/Lighting/Circuits) over a list of
  `UnitScheduleBox`es (one per unit/group that has rules; grouped/sorted by type).
- The detail box and the page row are the **same** `ScheduleRuleObject` + `UnitScheduleBox`
  components — no divergent implementations.

---

## 6. Open items / confirm before build

1. **Group-scoped rules vs per-unit:** brief assumes a rule is mostly unit-scoped, with group
   scope allowed (overlap expands to members). Confirm whether lighting/heating want true group
   rules or always per-unit copies.
2. **Cross-midnight editing:** the editor must accept `end < start` (renders as two bars).
3. **Smart automations** (solar-surplus pre-cool) remain separate and run *on top of* schedules —
   schedules are the floor. Unchanged by this work.

---

## 7. Heating page — Airzone underfloor (`type: 'heating'`)

The Airzone underfloor system is a second device type on the same scaffolding, but its
hardware model differs from AC in ways the UI must respect. Source: `connectors/airzone.ts`
(validated live: webserver 192.168.1.165, system 0, 6 zones).

### 7.1 The defining constraint — mode is SYSTEM-level

`mode` (`stop/heat/cool/dry/fan/auto`, codes 1/3/2/5/4/7) is set on the **master zone** and is
**shared by every room** in the system. You cannot heat one room and cool another. Therefore:

- The **Heating overview** has a single prominent **system-mode** segmented control (Off · Heat ·
  Cool · Dry · Fan · Auto) at the top, labelled "applies to all rooms."
- The **room detail** shows the same system-mode control but framed as system-wide context
  ("changing this affects all rooms"), **not** a per-room control.
- There is **no fan speed and no vanes** on Airzone — the registry hides those controls.

### 7.2 Per-zone (room) capabilities

Each room/zone owns: `on` (on/off), `setpointC` (0.5° steps, `minTemp`–`maxTemp`), `roomTempC`,
`humidity`, `floorDemand` (loop actively calling — the live "Heating"/"Cooling" pill + glow),
`wireless` (thermos_radio), `lowBattery`. `AirzoneZone.id = air-<system>-<zone>`.

`AirzoneLever = 'power' | 'setpoint' | 'mode'` (mode applied at system master). Map into the
shared `ClimateLever` surface; the device registry entry for `heating` exposes only
power/setpoint and the system-mode control.

### 7.3 Screens

- **Heating overview** (`/devices/heating` or the Heating group): header + summary
  (Mode · Calling N/6 · Avg indoor · Band) · system-mode control · a **grid of room thermostat
  cards** (name · demand pill · room temp · inline setpoint stepper · on/off · humidity ·
  wireless/battery). Demand pill colour follows current mode: heat = grid amber, cool = battery
  cyan, idle/off = muted.
- **Room detail** (`/devices/air-0-1`): system-mode context card · per-room target stepper +
  Room-now (temp + humidity + Δ) · on/off · **floor-demand readout** (live, glowing when calling)
  · optional pre-heat automation banner · `UnitScheduleBox` titled "<Room> — Heating" · Config &
  service (Thermostat type · Battery · Setpoint range · Signal · system/zone id).

### 7.4 Schedules on Airzone — mode caveat

Because mode is system-wide, a per-room rule **must not** independently set a conflicting mode.
Decision for the editor when `type:'heating'`:

- Rule `action` = **setpoint + on/off only**; mode shows as **"follows system mode"** (read-only).
- The natural condition is **"only if cooler than"** (heat) / "only if warmer than" (floor cool).
- Per-room no-overlap rule is unchanged.
- **Open item:** seasonal/whole-system mode switching (Heat in winter, Cool in summer) is better
  modelled as a separate **system-level schedule**, not a per-room rule. Confirm whether to build
  that now or defer. Until then, system mode is set manually on the Heating page.
