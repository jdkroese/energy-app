# 23 — Blinds / curtains (Tuya category `cl`)

Second Tuya device category after Lights, built on the shared `tuya.ts` cloud
foundation. **Phase 1 (this doc): listing + control + config**, surfaced as a real
**Blinds** tab inside the Devices hub. Scheduling is Phase 2.

## Where it lives
A `BlindsPanel` (`apps/web/src/screens/Blinds.tsx`) embedded in the Devices hub —
the same pattern as `LightsPanel`. No standalone route/nav item.

- `deviceTypes.ts` — `blinds` is a built type (hue `--ev`, icon `blinds`).
- `Devices.tsx` — polls `api.blinds.list` for the tab count; `content('blinds') → <BlindsPanel/>`.

## Control surface (per blind card)
- Open · Stop · Close buttons (always, when online).
- Position slider (0 = closed, 100 = **open**) when the motor reports a settable position.
- Expandable admin config: room-name override + **invert direction** toggle.
- Optimistic + debounced (buttons fire immediately; the slider debounces 300 ms),
  mirroring the Lights pipeline. Writes are admin-gated server-side.

## Backend
- `apps/api/src/connectors/tuya-blinds.ts` — `isBlind()` (categories `cl`, `clkg`),
  `normalizeBlind()` → `BlindUnit`, `buildCommands(lever)`. Detects the reported DP
  codes: `control` (open/close/stop) · `percent_control`/`position` (set) ·
  `percent_state` (read). Falls back to a `switch_1` on/off for curtain switches.
- `apps/api/src/routes/blinds.ts` — `getBlinds` / `getBlind` / `commandBlind` /
  `bulkCommandBlinds`, mirroring `routes/lights.ts`.
- `apps/api/src/index.ts` — `GET /api/blinds`, `GET /api/blinds/:id`,
  `POST /api/blinds/:id/command` (admin), `POST /api/blinds/bulk-command` (admin).

## Position semantics + invert
The app's `positionPct` is **100 = fully open, 0 = closed**. Tuya motors disagree on
which way their raw `percent` runs (many report 0 = open / 100 = closed). The per-device
`invertPosition` setting (stored in `DeviceSettings`, edited from the card's config)
flips the read and write so the slider matches reality. Open/close use the unambiguous
`control` enum when present, so they work regardless of invert.

## Phase 2 (next)
Scheduling: a "Blinds" rule that opens or closes at set times, shown on a 24 h / 30-min
section bar (simpler than the climate setpoint timeline). Will extend the schedule schema
to a polymorphic action + generalize the coordinator to drive blind positions, gated on
the device-automation arm. See [21-battery-priority.md](21-battery-priority.md) for the
guarded-coordinator pattern.
