# Devices platform — implementation spec (AC first, extensible)

> 2026-06-25. Build contract for the Devices/Climate feature. Approved scope + screens.
> Connector validated live (9 Panasonic Etherea units). Build on branch `intesis-climate`.

## 0. Principle
A generic **Devices** layer; **AC is the first device type**. UI renders from each device's
**capabilities**; each type plugs a **connector**. Adding EV/pool/water-heater/switches later
= "connector + capability descriptor", not a redesign. Everything is **shadow-first** and reuses
the battery **guardrail / authority (Off→Manual→Auto)** model.

## 1. Validated Intesis protocol (source of truth)
- Login: `POST https://user.intesishome.com/api.php/get/control`, form `username,password,version=1.8.5,cmd={"status":{"hash":"x"},"config":{"deviceFetch":1,"hash":"x"}}` → 200.
- Response: `config.inst[].devices[]` (id,name,zoneId,modelId,widgets) + `status.status[]` `{deviceId,uid,value}` + push socket `config.serverIP/serverPort/token`.
- UIDs: power=1, mode=2 (0 auto/1 heat/2 dry/3 fan/4 cool), fan=4, vaneV=5, vaneH=6, setpoint=9, currentTemp=10, setpointMin=35, setpointMax=36. **Temps in tenths °C** (240→24.0).
- CONTROL (build now): open TCP to `serverIP:serverPort`, send `{"command":"connect_req","data":{"token":<token>}}`, then `{"command":"set","data":{"deviceId":<id>,"uid":<uid>,"value":<v>,"seqNo":<0-255>}}`; expect `set_ack`. Connector: `apps/api/src/connectors/intesis.ts` (read path done — add `setDatapoint()` + a small socket client).
- Fleet (live): Bo, MBR, Living TV, Kitchen 2, Guest up, Office, Guest down, Living dining, Kitchen_1 (inst id 92281, account `jdkroese`).

## 2. Store additions (`apps/api/src/store.ts`, persisted to state.json)
- `integrations.intesis: { username, password }` — set via Settings; connector reads store → env fallback.
- `deviceSettings: Record<deviceId, { room?: string; automationEnabled: boolean; comfortCeilingC?: number; comfortFloorC?: number }>`.
- `schedules: Schedule[]` — `{ id, name, enabled, scope: { deviceIds: string[] }, days: number[0-6], start:"HH:MM", end:"HH:MM", mode, setpointC, fan? }`.
- `automations: Automation[]` — generic: `{ id, name, enabled, type, authority:'shadow'|'auto', params, lastEval }`. First type `solar_surplus_precool` params `{ roomTempLimitC, targetSetpointC, surplusClearSec:120, bandRestrictionEnabled:true, exitBand:'P1' }`. `bandRestrictionEnabled:false` ⇒ pre-cool in any tariff band (no P1 stand-down).
- `climateGuardrails: { setpointMinC:16, setpointMaxC:30, gridImportCapKw:14, minCycleMin:8 }` — quiet-hours hard limit removed; time-of-day stand-down is now per-rule via the tariff-band restriction.
- App **boots devices DISARMED** like batteries; climate writes are admin+arm gated.

## 3. API (`apps/api/src/routes/devices.ts` etc., mount in index.ts)
- `GET /api/devices` → normalized fleet (`intesis.getFleet()` + deviceSettings merge).
- `GET /api/devices/:id` → detail (+ governing schedules/automations).
- `POST /api/devices/:id/command` (admin, arm) → `{ lever:'power'|'mode'|'setpoint'|'fan', value }` guardrailed → `intesis.setDatapoint`.
- `POST /api/devices/bulk-command` (admin, arm) → `{ ids:[], lever, value }`.
- CRUD `GET/POST/PUT/DELETE /api/schedules`, `/api/automations`.
- `GET /api/integrations/intesis` (configured? device count), `POST` (set creds → validate by `login()` → store; never log password).

## 4. Guardrails (`apps/api/src/control/climate-guardrails.ts`) — never throw, clamp+reason
- setpoint clamp to device min/max (16–30); mode allow-list; **14 kW cap** → stagger concurrent compressor starts (don't issue starts that would push projected import over cap); quiet-hours block in bedroom zones; min on/off (no short-cycle); comfort ceiling/floor hard stop. Read-back confirm + per-device rate-limit like `execute.ts`.

## 5. Rules engine (`apps/api/src/control/climate-coordinator.ts`)
- 30–60s tick, self-gated on `devices.armed && mode==='auto'`. Shadow mode logs intended actions, writes nothing.
- `solar_surplus_precool`: `surplus = pv_W − houseLoad_W − batteryChargeHeadroom_W` (from /api/live + battery SoC). For each automation-enabled device where `roomTemp > roomTempLimit` and `surplus > startThreshold`: command cool@target, coolest/warmest-first, staggered under the 14 kW cap. Maintain per-rule debounce: stop a device when `surplus ≤ 0` **sustained ≥ surplusClearSec (120s)** or room ≤ target or band==exitBand. Log every decision to a climate command log (like control.log).

## 6. Frontend (match Power DS — clone patterns from `screens/Batteries.tsx`, `BatteryDetail.tsx`; tokens in `index.css`; primitives in `components/ui`)
- `nav.ts`: add `{ to:'/devices', label:'Devices', icon:'thermometer' }` to NAV.
- `screens/Devices.tsx` — overview: context strip (indoor avg, solar surplus, batteries, band), smart banner, **bulk action bar** (multi-select → power/mode/setpoint±/save-scene), fleet rows (name/room, state pill, mode, setpoint, room temp colored by warmth, smart-badge). Poll `/api/devices`.
- `screens/DeviceDetail.tsx` — setpoint stepper, mode + fan segmented, room-temp trend, governing automation/override, advanced (nanoe/remote-lock/temp-limit/runtime).
- `screens/Schedules.tsx` — weekly timeline per scope + schedule cards (CRUD).
- `screens/Automations.tsx` — list + WHEN/DO/UNTIL/LIMITS builder for `solar_surplus_precool`, live preview, Shadow/Auto toggle.
- `screens/Settings.tsx` — add "Connect AC Cloud" integration block (username+password → POST /api/integrations/intesis).
- Routes in `App.tsx`. Reuse `usePolling`, `api.ts`, `Card`, `SegmentedControl`, `Switch`, `StatTile`, mono numerals.

## 7. Phasing (all in scope; keep each compiling/committed)
1 Monitor (devices read + overview/detail + Settings connect) → 2 Control (single+bulk, guardrailed) → 3 Schedule → 4 Automate (rules engine, shadow→auto) → 5 platform generalization (capability descriptors so non-AC types slot in).

## 8. Ops / deploy (mini is production — see [[energy-app-mac-mini]])
- Backend `joris@192.168.1.138`, energy at `~/sites/energy`, daemon `nl.hirobo.energy-api` (:3002), node `/opt/homebrew/bin/node`. **NEVER start the VPS energy-api** (Tesla single-writer). Re-copy Tesla `.well-known` after any web redeploy. Re-arm battery **L2 Auto** after deploys (boots disarmed). Deploy-safety hook: keep branch synced with origin/main before SSH.
