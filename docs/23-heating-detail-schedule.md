# Dev brief — Heating detail + schedule (align to capabilities)

**Context:** Refinement slice on top of the Heating (Airzone) screen (`docs/21`, PR #14) and the
surplus-bolt icon (`docs/22`, PR #13). The heating **detail page** and the **schedule** system
already largely exist and are type-aware — this brief tightens them to the approved heating
capability set: **modes cool / heat / auto only, no fan, no vanes, no dry**, and confirms heating
schedules surface on the Schedules page beside cooling. Designs approved 2026-06-26. Brand =
"Power" design system.

**Depends on:** PR #14 (heating screen/detail) and PR #13 (bolt icon) merged first — this stacks
on both. Base the branch on the merge result (or on #14 if #13 is delayed; reconcile the bolt
glyph then).

**Standing rule:** web (≥768px, `ctx.desktop`) **and** mobile (<768px), both branches; verify both.

**Affected files (all small, type-gated edits):**
- `apps/web/src/screens/DeviceDetail.tsx` (heating mode set; pre-heat banner glyph)
- `apps/web/src/components/schedules/EditRuleOverlay.tsx` (heating mode set in the rule editor)
- (No change needed: `Schedules.tsx`, `UnitScheduleBox.tsx`, `ScheduleRuleObject.tsx`,
  `scheduleRules.ts` — already heating-aware. See §3.)

---

## 1. Detail page — restrict the mode strip (`DeviceDetail.tsx`)

PR #14 renders the heating mode strip as Heat/Cool/Auto/Fan/Stop. **Reduce it to exactly
`Cool · Heat · Auto`** for `type === 'heating'`. Drop Fan and Stop from the strip — power on/off
already covers "stop", and underfloor has no fan. Keep the heat→`--grid`, cool→`--battery`,
auto→neutral accents. Cooling keeps its full 5-mode strip unchanged.

Implement by deriving the heating mode list from the zone's `availableModes` **intersected with
`{cool, heat, auto}`** rather than a hardcoded 5 — so the strip never offers a mode the box
rejects. (See the open question in §4 about `auto`.)

Everything else on the heating detail from PR #14 stays: setpoint + ambient cards, no fan/vane
sections, humidity / floor-demand / thermostat readouts, filter+maintenance hidden, "Airzone"
subtitle, the shared `UnitScheduleBox`, and the meta tiles.

**Pre-heat banner glyph:** make the solar-surplus banner use the **orange bolt** (`zap` /
`--grid`) to match the unified surplus-icon system (`docs/22`), not the flame. (If #13 landed
first, this is consistent already — just confirm.)

## 2. Schedule rule editor — restrict modes (`EditRuleOverlay.tsx`)

The overlay already sets `hideFanVanes = rule.type === 'heating'` (hides Fan + both vane rows) and
seeds heating-aware defaults. The remaining gap: its `MODES` operation selector still lists all 5
(auto/cool/heat/dry/fan). **For `rule.type === 'heating'`, show only `Auto · Cool · Heat`.** Keep
the full 5 for cooling. The rest of the editor (Setpoint stepper, Days, Time windows, Run
condition with `--grid` threshold, Copy-to-units) is already correct for heating — leave as-is.

## 3. Schedules page — already done, just verify

No code change expected. Confirm in the running app that:
- The `Heat` filter (already in `FILTERS`/`TYPE_ORDER`) shows heating unit boxes.
- A heating rule created from the detail page's schedule box (or via "New schedule") appears on
  the Schedules page, grouped under its room with the orange (`--grid`) type dot, **alongside**
  cooling boxes — `scheduleRules.ts` already defines `TYPE_COLOR.heating = --grid`,
  `TYPE_LABEL.heating`, and `newRuleDraft` heating defaults (heat · 21° · 06:00–08:00).
- The schedule runs through the same coordinator; "Copy to units" offers other heating rooms.

If any of these fail, fix in the relevant component — but the read of the code says they work.

## 4. Notes / open question

- **Modes:** the live Airzone system reports `availableModes ≈ [stop, fan, cool, heat]` (no
  `auto`) per `docs/16`/the connector. The approved design is `cool/heat/auto`. Deriving from
  `availableModes ∩ {cool,heat,auto}` means **`auto` may not appear** on this hardware, and the
  row/detail mode cycle should skip it if absent. **Confirm with product:** is `auto` actually
  writable on these zones? If not, the heating mode set is effectively `cool/heat` + power. To
  expose `auto`, `availableModes` must be plumbed onto `DeviceView` (it currently isn't — PR #14's
  inline row chip cycles a fixed heat→cool→auto and relies on the server to clamp).
- Reuse `components/ui` primitives + the 5 energy hues only. Numerals in `.pwr-mono`.
- The schedule window track bars stay `--solar` green across all types (shared visual) — only the
  unit dot is type-colored. Keep that for visual consistency unless product wants type-colored bars.

## Verify
Typecheck/build both apps. In the dev server: heating detail shows a 3-button Cool/Heat/Auto
strip and no fan/vanes; the rule editor for a heating unit offers only Auto/Cool/Heat; a new
heating rule appears on the Schedules page under Heat, next to cooling. Screenshot both viewports.
Open a PR; do not merge to `main`.
