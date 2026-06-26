# Solar-surplus indicator = color-coded lightning bolt

Solar-surplus indicator = color-coded lightning bolt. The solar-surplus pre-condition
indicator becomes ONE glyph — a lightning bolt (Lucide `zap` / the app's registered bolt
icon; the Icon component renders it via `name="zap"`) — color-coded by mode: BLUE
(`--battery`) = pre-cool, ORANGE (`--grid`) = pre-heat. Replaces the earlier per-type glyphs
(cooling snowflake / heating flame) for the SURPLUS indicator only.

Three visual states (unchanged from today, only glyph + hue change):

- **lit + soft glow** = actively pre-conditioning on free surplus;
- **dim (≈0.32 opacity)** = enrolled but on paid energy now;
- **faint (≈0.25, `--text-3`)** = not in the surplus automation.

## Where it applies

1. **`components/AutomationRow.tsx`** — the leading icon is shared by Cooling + Heating
   autopilot rows. The icon name + hue are now PROPS (`icon`, `iconColor`; defaults
   `zap` / `--battery`), so each caller passes its own (Cooling = blue bolt, Heating =
   orange bolt). Not hardcoded.
2. **Cooling autopilot row** (`Devices.tsx` cooling content) — passes blue bolt /
   `--battery` (replaces the previous `--solar` green bolt).
3. **Heating autopilot row** (`Devices.tsx` heating content) — pass orange bolt /
   `--grid` (replaces the flame).
4. **Per-row "Solar" column** — Heating rows: orange bolt, 3 states. Cooling rows: that
   column's redesign is NOT built yet, so only the design spec is updated — no cooling-row
   code change.

### Cooling-row "Solar" column — design spec (deferred, not built)

When the cooling unit list gains a per-row "Solar" column, it uses the same bolt glyph as
the autopilot row, hue `--battery` (blue = pre-cool), with the three states above:

- enrolled + actively pre-cooling on surplus → lit blue bolt + soft glow;
- enrolled but on paid energy now → blue bolt at ≈0.32 opacity;
- not enrolled in the surplus automation → bolt at ≈0.25 opacity, `--text-3`.

This mirrors the heating-row Solar column (orange / `--grid`). No code lands for the
cooling column in this slice because the cooling-row redesign is not built yet.

## Out of scope

Type-tab/category icons stay (Cooling snowflake, Heating flame in `deviceTypes.ts`); mode
chips keep their own icons; no behavior/logic change — purely glyph + hue.

## Implementation status (branch `surplus-bolt-icon`, based on `origin/main`)

The in-flight Heating PR was NOT found on `origin` when this branch was cut, so only the
conflict-isolated parts landed:

- **Done — point 1:** `AutomationRow` icon name + hue are configurable props.
- **Done — point 2:** Cooling autopilot row passes the blue bolt (`zap` / `--battery`).
- **Deferred — point 3:** Heating autopilot orange bolt — heating content does not exist
  in this base (`Devices.tsx` renders a "Coming soon" placeholder for the Heating tab).
  Apply when the Heating PR lands: pass `icon="zap" iconColor="var(--grid)"` to the
  heating `AutomationRow`.
- **Deferred — point 4:** Heating-row Solar column orange bolt — heating unit rows do not
  exist in this base. Cooling-row Solar column = spec only (above), per the brief.

## Verification

- `pnpm --filter @energy/web typecheck` and `build` → pass.
- Cooling autopilot row shows a blue bolt at desktop and mobile widths (screenshots in PR).
