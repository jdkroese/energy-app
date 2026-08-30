# docs/49 — Tuya local independence (survive a cloud quota blackout)

## Problem

Local-LAN control (docs/44) was meant to make a Tuya IoT-Core cloud-quota blackout
irrelevant. It isn't. When the quota is exhausted (error `28841004`, the quota guard in
`tuya.ts`), **every** device tile shows *"Tuya API quota exhausted"* within ~1 hour —
because the "local-first" path still has **two hidden hard cloud dependencies**, and once
the in-memory caches age out during a blackout the whole thing collapses back to cloud:

1. **The device list is cloud-only.** `getDevices()` → `listDevices()` hits
   `/v1.0/iot-01/associated-users/devices`. That inline-status list is what fills every
   tile (names, categories, online, status) AND what the voltage KPI + coordinators read.
   There is a 5-min stale snapshot (`staleMs: 300_000`) but **no local fallback** after it
   expires, even though `tuya-local.json` already holds `{id,name,category,localKey,lanIp,
   version,sub}` for all 43 devices.

2. **The dp-map is cloud-only.** Before `getStatus`/`sendCommands` can touch a device on
   the LAN they call `dpMapsFor(id)`, which fetches the cloud **thing model**
   (`/v2.0/cloud/thing/{id}/model`, `abilityId` = local dp number), cached 1h. When that
   cache expires mid-blackout the local branch can't build its map → throws → falls back to
   cloud → quota error. **The dp layout is immutable** (`thingModelDpMap` comment) — it
   never needs re-fetching, it's just **never persisted**.

Because the fleet refresh is the one cloud call every subsystem funnels through, it is also
the dominant **burn** source — which is why a fresh dev account's monthly call quota was
exhausted in ~10 days even with local control "on".

## Goal

A cloud (IoT-Core) blackout becomes a **non-event** for LAN-capable devices, and routine
cloud burn drops sharply. Zigbee/BLE **sub-devices** (scene switches, sensors — never
LAN-reachable, `sub:true`) may degrade gracefully during a blackout; that's acceptable.

## Design

### Change 1 — Persist the dp-map in the registry (removes cloud dep #2)

`tuya-local.ts`:
- Extend `LocalDeviceEntry` with `dpMap?: Record<string, number>` (cloud-`code` → local
  `dp`). Persisted in `tuya-local.json`.
- `loadRegistryFromFile`: parse `dpMap` when present — object of string→finite-number only,
  tolerant (bad/missing → `undefined`, never throw). Add a unit test.
- `schedulePersist`: include `dpMap` in each written device object (alongside the existing
  fields). Do **not** drop it on rewrite.
- New pure-ish exports (no network):
  - `getDpMap(id): { codeToDp: Map<string,number>; dpToCode: Map<number,string> } | null`
    — built from the persisted `dpMap`; `null` when absent/empty.
  - `setDpMap(id, codeToDp: Map<string,number>): void` — store on the entry (invert not
    needed for storage; store code→dp) and `schedulePersist()`. No-op if empty or unchanged.
  - `listRegistry(): LocalDeviceEntry[]` — snapshot of registry values (for the local fleet
    builder in `tuya.ts`); or reuse an existing accessor if cleaner. Never expose `localKey`
    to any client-facing caller (this is server-internal only, so returning the entry is
    fine — just never serialize it out through an API route).

`tuya.ts` `dpMapsFor(id)`:
- **First**: `const p = tuyaLocal.getDpMap(id); if (p) { dpMapCache.set(id, p); return p; }`
  — zero cloud calls once captured.
- **Else**: build from cloud exactly as today. On success (`codeToDp.size > 0`), call
  `tuyaLocal.setDpMap(id, codeToDp)` to persist for next time, then cache + return.
- Keep the "never cache an empty map" rule.

### Change 2 — Local fleet fallback (removes cloud dep #1; enables blackout survival)

`tuya.ts`:
- New `localFleetSnapshot(): Promise<TuyaDevice[]>`:
  - Iterate `tuyaLocal.listRegistry()`.
  - For each **locally-capable** entry (`tuyaLocal.isLocalCapable(id)`) that has a persisted
    dp-map: `readStatus(id)` → `translateStatus(dps, dpToCode)` → `status`. `online = true`
    on success. On per-device failure: `online:false`, `status:[]`.
  - `name`/`category` from the registry entry. `localKey` omitted from the returned shape
    (or left on the internal `TuyaDevice.localKey` field, which is already never sent to the
    client).
  - **Bounded concurrency** (~6 at a time) — do not open 40 LAN sockets at once.
- `getDevices()`:
  - When cloud is usable (configured AND `Date.now() >= quotaBlockedUntil`): cloud path as
    today (`cached(FLEET_KEY, …, listDevices)`).
  - When cloud is quota-blocked or `listDevices` throws (wrap in try/catch): return
    `localFleetSnapshot()` (only when `tuyaLocal.isLocalEnabled()`), cached briefly
    (~20s) under a distinct key so it doesn't clobber the cloud snapshot.
  - When not configured but local enabled: also serve `localFleetSnapshot()`.
  - Sub-devices / non-local devices simply don't appear in the local snapshot during a
    blackout — acceptable (note in code). If a recent **stale cloud** snapshot exists, it's
    fine to union it in for those ids, but that's optional polish, not required for P1.

### Change 3 — Cut routine cloud burn when local is healthy

- Once dp-maps are persisted and the local snapshot works, **prefer local for the fleet**
  when `isLocalEnabled()` and the local snapshot covers the locally-capable devices, and
  fall back to cloud only:
  - to enumerate/refresh **sub-devices** and newly-added devices, at a **slow cadence**
    (e.g. every 5–10 min instead of 20s), and
  - opportunistically to (re)capture any missing dp-map.
- Concretely: keep cloud `listDevices` as a *supplementary* refresh on a longer TTL when
  local is serving the interactive fleet; the interactive hot paths (`getStatus`,
  `sendCommands`) are already local-first, so the fleet no longer needs 20s cloud freshness.
- Be conservative: this must **not** make sub-devices (scene switches — the app's only input
  devices) disappear during normal operation. If in doubt, keep cloud as fleet-primary when
  healthy and treat Change 3 as "raise the fleet TTL + serve local on any cloud failure",
  which already removes the blackout failure without risking sub-device regressions. Flag
  the exact cadence you chose in the PR so I can verify it on the mini.

### Change 4 — One-shot dp-map capture (guarantee coverage before the next blackout)

The chicken-and-egg: capturing a device's dp-map needs one successful cloud thing-model
fetch. So front-load it while cloud is briefly alive (right after the owner extends the
trial):
- Admin-gated `POST /api/integrations/tuya/local/capture-dpmaps` — iterate the fleet, call
  `dpMapsFor(id)` for each (forcing cloud fetch + persist via Change 1), return
  `{ total, captured, alreadyHad, failed }`. Bounded concurrency; never throw the whole
  thing on one device's failure.
- Surface it in **Settings → Tuya**: a small "Capture LAN control maps" action + a line
  *"dp-maps captured: N / M devices"* (read from `getDiagnostics()` extended with a
  `dpMapCaptured` count, or a dedicated field). **One responsive component** — handle the
  `wide` and narrow branches per the repo's web+mobile rule; no separate mobile file.

### Diagnostics

Extend `getDiagnostics()` (`tuya-local.ts`) so each device row reports whether it has a
persisted dp-map (`dpMapCaptured: boolean`), and add a totals field
`dpMapsCaptured: number`. This is what the Settings line and my verification read.

## Non-goals / constraints

- No change to the v3.3/3.4 (tuyapi) or v3.5 (native GCM) transports themselves.
- Never log or client-expose `localKey` or dp values that could leak keys.
- **Do not run Prettier** — match the surrounding hand-formatting (single quotes, semicolons,
  ~120-col wrapping).
- Tests: API suite is `node --import tsx --test` (NOT vitest). Add focused unit tests for:
  `dpMap` load/persist round-trip, `getDpMap/setDpMap`, `dpMapsFor` persisted-first +
  capture-on-cloud-success (mock the cloud request), and `localFleetSnapshot` shape (mock
  `readStatus`). Both `apps/api` and `apps/web` must typecheck clean.
- Keep everything **reversible/safe**: with local disabled (`TUYA_LOCAL_ENABLED=0` or the
  store toggle off) behaviour must be byte-for-byte the current cloud-only path.

## Acceptance

1. With the cloud quota-blocked (simulate: set `quotaBlockedUntil` in a test, or point creds
   at a dead endpoint) and dp-maps persisted, `getDevices()` returns the LAN-capable fleet
   with live status, and `getStatus`/`sendCommands` work — **zero cloud calls**.
2. `POST …/capture-dpmaps` populates `tuya-local.json` dp-maps for all cloud-reachable
   devices; a subsequent process restart serves local with no cloud dependency.
3. Settings → Tuya shows the capture count on web and mobile.
4. All API + web tests green; both typecheck clean; no Prettier churn.
