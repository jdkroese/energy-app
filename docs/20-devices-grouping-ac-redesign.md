# Devices page — type-tab grouping + shared autopilot row (slice 1)

Design-led redesign of the Devices section into a typed-device hub. Brand = "Power"
design system. Delivered web + mobile in one responsive screen (`ctx.desktop`).

## What shipped in this PR (frontend-only by design)
Kept deliberately frontend-only to **coordinate with the in-flight #19 work** (schedules /
device-detail refactor) which owns `routes/devices.ts`, `intesis.ts`, `store.ts`,
`control/climate-*.ts`, `Schedules.tsx`, `schedule-rules`. This PR touches none of those.

- **`lib/deviceTypes.ts`** — device-type registry (`cooling | heating | lighting | switching`)
  with label + brand hue + Lucide icon + `built` flag, and `classifyDevice()` (heuristic on the
  connector `installation` string until the API grows a real `type` discriminator).
- **`components/AutomationRow.tsx`** — the shared "Solar-surplus pre-cool · Shadow/Auto · toggle"
  row, driven by `api.automations`. **Read/write in both** the Devices hub and the Automations
  screen (same object) — `Automations.tsx` `RuleCard` now renders this same component.
- **`screens/Devices.tsx`** — retitled **Devices**; a **segmented type-tab bar** (Cooling ·
  Heating · Lighting · Switching, each with a hue dot; active = raised `--surface-3`, matching
  the Autopilot `SegmentedControl` look). Selected type renders below; only **Cooling** is built,
  the rest show a "Not set up" placeholder. Cooling content = 4 summary tiles (Cooling now ·
  Indoor avg · Warmest [red when hot] · Surplus), the shared autopilot row (dims when disarmed),
  and a **plain navigable unit list** (row → `/devices/:id`).
- **Removed** from the page: bulk editor, multi-select, row checkboxes, "Add to schedule",
  quick-select chips.

## Already on `origin/main` (not re-done)
The AC **unit detail** (`DeviceDetail.tsx`) already implements mode strip, stepped fan, vane
cards (connector-awaiting), solar-surplus toggle, schedule timeline, and config & service — so
this PR leaves it untouched.

## Deferred (needs backend — land after #19 to avoid conflicts)
- `DeviceView.type` discriminator + `vaneUpDown` / `vaneLeftRight` levers + `fanSpeed` / `filter`
  / `maintenance` read fields in `intesis.ts` + `routes/devices.ts`. Until then, `classifyDevice`
  splits cooling vs heating by `installation`, and the list shows mode/setpoint (no live fan column).

## Verification
- `pnpm --filter @energy/web typecheck` → pass. `pnpm --filter @energy/web build` → pass.
- Runtime/visual check (both viewports) to be done on a configured instance — the screen is
  auth-gated and hardware-backed, so it can't be exercised from a bare worktree.
