# docs/51 — Tuya: manual (LAN-only) fleet + drop sub-devices from the app

## Context

docs/49 made LAN control survive a cloud blackout, but cloud is still used routinely:
- `getDevices()` stays cloud-PRIMARY (5-min refresh while local is healthy) → ~288 calls/day.
- The **scene-controller coordinator** (`apps/api/src/control/controller-coordinator.ts`)
  polls the cloud **device-logs** endpoint every **5s per enabled controller** (~17k
  calls/day each — the file's own comment says it "helped exhaust the account"). Scene
  switches are Zigbee **sub-devices** behind the gateway → they can NEVER go local.

Owner decision (2026-08-30): the Home app should make **no routine cloud calls**. The scene
switch + gateway stay in the Tuya app only ("they work through there — I accept that"), so
they should be dropped from the Home app entirely, and the fleet list should be **manual**
(local-first, cloud only on an explicit "Sync" press).

## Goal

Steady-state Home-app cloud usage ≈ **zero**. Cloud is touched only when the owner presses
"Sync from Tuya cloud", plus the existing per-write on-failure safety fallback (which only
fires when a LAN write fails — keep it). LAN control of the ~38 capable devices is unchanged.

## Change 1 — Manual (LAN-only) fleet

Add a persisted, reversible setting `integrations.tuya.fleetManual?: boolean`
(store.ts, round-trips through the existing hydration spread). **Default ON** — this is the
owner's explicit request; it's a visible toggle so it's reversible.

`tuya.ts getDevices()`:
- When `fleetManual` is ON **and** local control is enabled: return
  `localFleetSnapshotCached()` **always** — never touch cloud automatically, regardless of
  cloud health. (Reuse the existing localFleetSnapshot from docs/49.)
- When OFF: unchanged docs/49 behaviour (cloud-primary, local fallback).
- Guard: if `fleetManual` is ON but local is DISABLED, fall back to the current cloud path
  (manual+local-off is contradictory; don't silently show an empty fleet).

Manual sync:
- Admin route `POST /api/integrations/tuya/sync` → `invalidateFleet()` + one `listDevices()`
  (a single cloud refresh), reconciling names / newly-appeared devices into the normal
  surfaces. Returns a small summary `{ ts, devices, newIds? }`. This is the ONLY routine
  cloud fleet call, and only on demand.
- Note in the response/UI that fully LAN-enabling a brand-new device still needs the existing
  harvest ops flow (key capture) — out of scope here.

UI — **Settings → Tuya** (extend the existing card, one responsive component, web+mobile):
- A toggle "Manual device sync (LAN-only)" bound to `fleetManual`.
- A "Sync from Tuya cloud" button (admin) calling the new endpoint, with a small last-synced
  timestamp + result line. Match the existing capture-button styling right above it.

## Change 2 — Drop sub-devices (scene switch + gateway) from the app

Define ONE shared predicate and apply it at the fleet boundary so every surface (Devices,
onboarding/"needs setup", rooms) honours it:

- Exclude any device the local registry marks `sub === true` (Zigbee/BLE children — the scene
  switch and any long-id orphans). The local snapshot ALREADY excludes these (isLocalCapable
  → `gateway-sub-device`); this change is about the CLOUD-sourced and onboarding surfaces too.
- Exclude **gateway** categories. Confirm the exact code(s) against this fleet — the Settings
  chip shows "Other (wg2)", so `wg2` is the gateway; exclude a small set (default `['wg2']`,
  plus any other hub category you find) so the gateway never appears as a device or as "needs
  setup".
- Cross-reference by id where the cloud `TuyaDevice` shape lacks a `sub` flag: build the
  sub-id set from `tuyaLocal.listRegistry()` (it has `sub`) and filter the cloud fleet by it,
  in addition to the category rule.

Apply the filter in `listDevices()`/`getDevices()` normalization (so it flows everywhere) and
verify the onboarding "needs setup" count (`discovered`/inference routes) drops the scene
switch + gateway. The "7 not yet set up" should no longer include them.

## Change 3 — Stop the scene-controller cloud poll

The scene switch is leaving the app, so its 5s cloud poll must stop:
- Gate `controller-coordinator.ts` so it does **not** poll when scene control is disabled.
  Simplest robust approach: a setting `integrations.tuya.sceneControllersEnabled?: boolean`
  **default OFF**, checked in the tick's early-return (alongside the existing
  `tuya.isConfigured()` / `ids.length === 0` guards) AND at `start*()` so the interval isn't
  even armed when off. With it off, ZERO device-logs calls are made.
- Hide the scene-controller UI/section when disabled (or leave the settings entry but dormant)
  — don't break existing `sceneControllers` store data; just stop acting on it. Keep the
  binding data intact so re-enabling later is lossless.

## Non-goals / constraints

- Do NOT delete `sceneControllers` store data or the scene-switch device from the registry —
  just stop surfacing/polling. Reversible via the two new toggles.
- Keep the per-write on-failure cloud fallback (docs/44) — it only fires on a LAN failure.
- Do NOT run Prettier; match hand-formatting (single quotes, semicolons, ~120-col).
- Tests: `node --import tsx --test` (NOT vitest). Cover: getDevices manual-mode branching
  (manual+local-on → local snapshot, never cloud; manual+local-off → cloud; off → unchanged),
  the sub-device/gateway exclusion predicate (sub flag + category), and the coordinator gate
  (off → no poll / interval not armed). Both packages typecheck clean.
- Any UI is web AND mobile in one responsive component.

## Acceptance

1. With `fleetManual` ON + local on, `getDevices()` makes **zero** cloud calls (assert the
   cloud `request`/`listDevices` path is never hit — mock/spy), returns the LAN fleet.
2. The scene switch + gateway do not appear in the device list or the onboarding "needs
   setup" count on web or mobile.
3. With `sceneControllersEnabled` OFF, the coordinator arms no interval and issues no
   device-logs call.
4. "Sync from Tuya cloud" performs exactly one cloud fleet refresh and reconciles the view.
5. All API + web tests green; both typecheck clean; no Prettier churn.
6. `fleetManual` OFF + scene controllers ON = byte-for-byte the pre-docs/51 behaviour.
