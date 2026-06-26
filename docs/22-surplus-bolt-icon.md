# Dev brief — Solar-surplus indicator = color-coded lightning bolt

**Context:** Small design-system refinement to the Devices screens. The solar-surplus
pre-condition indicator becomes **one glyph — a lightning bolt** (free solar *power*) —
**color-coded by mode**: **blue (`--battery`) = pre-cool**, **orange (`--grid`) = pre-heat**.
This replaces the earlier per-type glyphs (cooling snowflake / heating flame) for the *surplus*
indicator only. Approved 2026-06-26. Brand = "Power" design system.

**Standing rule:** web (≥768px, `ctx.desktop`) **and** mobile (<768px), both branches; verify
both viewports.

⚠️ **Sequencing — base on the Heating PR, do not branch off `origin/main` cold.** The Heating
(Airzone) screen work (`docs/21`) is in flight and edits the same files (`AutomationRow.tsx`,
`Devices.tsx`). To avoid conflicts: `gh pr list` → find the open `heating-airzone` PR/branch →
**base this branch on that branch** (`git fetch origin && git switch -c surplus-bolt-icon
origin/heating-airzone`). If that PR has already merged to `main`, base on the latest
`origin/main` instead. If it's neither open nor merged, **stop and report** rather than guessing.

---

## The change

Use the existing `Icon` component's lightning glyph (Lucide `zap` / the app's bolt icon —
confirm the exact registered name). Three visual states everywhere the indicator appears
(same as today, only the glyph + hue change):
- **lit + soft glow** — actively pre-conditioning on free surplus (`automationEnabled &&
  demand && grid exporting`).
- **dim (≈0.32 opacity)** — enrolled but on paid energy right now.
- **faint (≈0.25, `--text-3`)** — not in the surplus automation.

Hue per type: **cooling → `--battery`** (blue), **heating → `--grid`** (orange). No new colors
(both are existing energy hues).

## Where it applies

1. **Autopilot row (`components/AutomationRow.tsx`)** — the leading icon. It's shared by both
   Cooling and Heating autopilot rows, so make the **icon name + hue a prop** (don't hardcode):
   Cooling passes the blue bolt, Heating passes the orange bolt. (The Heating PR already adds the
   Heating usage — update it to pass the orange bolt instead of the flame.)
2. **Cooling autopilot row** (`Devices.tsx` cooling content) — pass blue bolt / `--battery`
   (replaces the current green bolt).
3. **Heating autopilot row** (`Devices.tsx` heating content, from the Heating PR) — pass orange
   bolt / `--grid` (replaces the flame).
4. **Per-row "Solar" column** — Heating rows (built in the Heating PR): orange bolt, 3 states.
   Cooling rows: the cooling row redesign that introduces this column is **not built yet**, so
   only update the **design/mockup spec** here — no cooling-row code change in this PR.

## Out of scope / leave alone
- **Type-tab + category icons are unchanged** — the Cooling tab stays `snowflake`, Heating stays
  `flame` (`deviceTypes.ts`). Only the *surplus* indicator becomes a bolt.
- **Mode chips unchanged** — the "Cool" mode chip keeps its snowflake, "Heat" its flame, etc.
- No logic/behavior change — purely the glyph + hue of the surplus indicator.

## Verify
Typecheck/build both apps. Run the dev server; on the Devices screen confirm the Cooling
autopilot row shows a blue bolt and (if the Heating PR is in the base) the Heating screen shows
orange bolts in the autopilot row + unit rows, at both desktop and mobile widths. Screenshot
both. Open a PR (do **not** merge to `main`); note in the description that it stacks on the
Heating PR.
