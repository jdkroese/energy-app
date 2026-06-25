# Airzone (underfloor heating) — API research + integration plan

> 2026-06-25. Goal: bring per-room climate/temperature control of the Airzone
> underfloor-heating system into the energy app, as a new **Devices** connector
> alongside Intesis AC (`docs/15-devices-platform.md`).

## Two ways to talk to Airzone

### A. Local API (REST, LAN) — **preferred** (mirrors the Sonnen pattern)
- `http://<webserver-ip>:3000/api/v1/...` — JSON, **no auth** (LAN-trusted). The mini
  is on the LAN, so it controls Airzone directly, no cloud dependency/latency.
- **Requires:** an Airzone **Webserver Cloud** (Ethernet `AZX6WEMSCLOUDC` / Wi-Fi
  `AZX6WSCLOUDDINC`, or Aidoo) with firmware **≥ 3.1.6**, and the **Local API enabled**
  in the Airzone Cloud app.
- **Endpoints:** `POST /api/v1/version`, `POST /api/v1/webserver` (mac/firmware/
  wifi/cloud status), `POST /api/v1/hvac` (read zones — body `{"systemID":0,"zoneID":0}`
  = all), `PUT /api/v1/hvac` (write), `POST /api/v1/integration` (aerothermal/Altherma
  driver params), `/api/v1/demo`.
- **Per-zone READ** (`/hvac`): `name`, `on`, `roomTemp`, `setpoint`, `maxTemp`/`minTemp`,
  `mode` + `modes[]`, `humidity`, `air_demand`/**`floor_demand`** (is the room calling
  for heat — key for underfloor), `speed`/`speeds[]`, `sleep`, `units` (0=°C/1=°F),
  `errors[]`, wireless-thermostat **battery**, optional air-quality (`aq_*`), and for
  auto systems separate `heatsetpoint`/`coolsetpoint`.
- **Per-zone WRITE** (`PUT /hvac` with `{"systemID":n,"zoneID":m,...}`): **`on`** (0/1),
  **`setpoint`** (per-room target temp), **`mode`** (HEAT/COOL/…, only on the system's
  **master zone**), `speed`, `sleep`. Mode codes: 1=Stop, 2=Cooling, 3=Heating,
  4=Ventilation, 5=Dehumidify (+ auto on supported systems).
- **Reference:** [Airzone Local API docs](https://developers.airzonecloud.com/docs/local-api/),
  [aioairzone (HA local lib)](https://github.com/Noltari/aioairzone),
  [HA Airzone integration](https://www.home-assistant.io/integrations/airzone/).

### B. Cloud API — fallback (works without enabling anything local)
- Auth with the **Airzone Cloud app email + password** (OAuth). Cloud-dependent.
- **Parent/child zones:** one parent per HVAC system (mode set here only) + child zones
  per room (on/off + target temp only; mode change on a child errors).
- Reads temp, humidity, mode, setpoint, air-quality (PM1/2.5/10), errors; controls
  on/off, target temp, mode (parent), AQ mode, water-heater (if present).
- **Reference:** [HA Airzone Cloud](https://www.home-assistant.io/integrations/airzone_cloud/),
  [aioairzone-cloud / developers.airzonecloud.com Open API](https://developers.airzonecloud.com/docs/open-api/).

## Status (2026-06-25) — ✅ LIVE, read confirmed
Airzone **Aidoo/webserver at `192.168.1.165:3000`** (MAC `74:7A:90:52:A9:EC`,
`ws_type=ws_az`, ws_firmware **4.08**, Local API **v1.71**, Wi-Fi "Tarracasa24").
Local API is **already enabled** — no app toggle needed. (The earlier `:3000`
`/dev/tcp` scan was a false-negative over Wi-Fi; the HTTP API responds fine. The mini
reaches it directly on the LAN.)

**System 1 — 6 zones (read live):**

| zone | name | on | mode | room°C | set | range | floor_demand | thermostat |
|---|---|---|---|---|---|---|---|---|
| 1 | Living room | 1 | heat | 28.0 | 21 | 15–28 | 0 | wired |
| 2 | Kitchen | 1 | heat | 29.5 | 21 | 15–28 | 0 | radio |
| 3 | Master bed | 1 | heat | 29.8 | 19 | 15–28 | 0 | radio |
| 4 | Guest down | 0 | heat | 29.8 | 19 | 15–28 | 0 | radio |
| 5 | Office | 1 | heat | 27.0 | 20.5 | 15–28 | 0 | wired |
| 7 | Guest up | 1 | heat | 29.8 | 16.5 | 15–28 | 0 | wired |

- Modes available `[1 stop, 4 fan, 2 cool, 3 heat]` (system supports **cool** too).
  `temp_step=0.5`, `units=0` (°C). `floor_demand=0` everywhere (rooms warmer than
  setpoint in summer → no heat call, correct).
- **Read:** `POST /api/v1/hvac {"systemID":0,"zoneID":0}` → `systems[].data[]`.
- **Write:** `PUT /api/v1/hvac {"systemID":1,"zoneID":N,"setpoint":21}` /
  `{"on":0|1}` / `{"mode":3}` (mode on the master zone). 200 returns the new state.

### ✅ Connector built: `apps/api/src/connectors/airzone.ts`
Additive, mirrors `intesis.ts`. Exports: `getZones()` (rich `AirzoneZone[]`),
`getFleet()` (generic `ClimateUnit[]` for the Devices merge), `getInfo()` (webserver),
`setLever(id,'power'|'setpoint'|'mode',value)` (PUT + read-back), `isConfigured()`.
Device ids are `air-<system>-<zone>` (e.g. `air-1-5` = Office). Host from
`integrations.airzone.host` → `AIRZONE_HOST` env → default `192.168.1.165`. Reads
cached 10 s.

### ✅ Wiring APPLIED + verified (backend; frontend is automatic)
Done with surgical additive edits (the other Devices session's uncommitted work
preserved; only `devices.ts` is shared). API typechecks clean; `getDevices()` returns
all **6 rooms** as `DeviceView` live (verified against .165).
1. **Fleet merge** (`routes/devices.ts`) — new `getAllUnits()`/`anyConnected()` merge
   `airzone.getFleet()` alongside `intesis.getFleet()`; `getDevices`/`getDevice`/
   `commandDevice`/`bulkCommand` all use them. ✅
2. **Write dispatch** (`control/climate-execute.ts`) — `issueClimate` branches each of
   the 4 write sites on `id.startsWith('air-')` → `airzone.setLever`; `fan` is a no-op
   for underfloor. Guardrails unchanged (half-degree + min/max already generic). ✅
3. **Frontend** — Airzone rooms render automatically (same `DeviceView` shape); no web
   change required for monitor + control. ✅

**Not done (optional / future):** a "Connect Airzone" block in `Settings.tsx` +
`/api/integrations/airzone` status endpoint (host is hardcoded-default, so unneeded);
`DeviceDetail.tsx` badges for the extra fields (`floorDemand`, `humidity`,
`wireless`/`lowBattery`); and an Airzone **slab pre-heat** automation (winter analog of
`solar_surplus_precool` — pre-heat in P3/solar-valley hours, coast through the P1 peak).

> Not committed yet: `devices.ts` also carries the other session's uncommitted work, so
> the commit/deploy is deferred to a coordinated point (see chat).

### Connector spec (reference)
- `apps/api/src/connectors/airzone.ts`: `getFleet()` (POST /hvac → normalize each
  zone to a Device: id `air-<sys>-<zone>`, room=name, caps `{onoff, setpoint(min/max,
  step), mode(system), roomTemp, floor_demand, humidity}`), `setDatapoint(zone,
  lever, value)` (PUT /hvac, guardrailed + read-back), `getInfo()` (webserver).
- `integrations.airzone: { host }` in store (default `192.168.1.165`); `GET/POST
  /api/integrations/airzone`. No auth (LAN). Zones merge into the existing Devices
  fleet next to the Intesis AC; Schedules/Automations/guardrails apply unchanged.
- **Climate value:** slab has big thermal inertia → pre-heat rooms in P3/solar valley
  and coast through the P1 peak; pair with PV-surplus pre-heat (winter analog of the
  AC pre-cool automation).

## How it slots into the app (Devices framework)
- New connector `apps/api/src/connectors/airzone.ts` (read fleet of zones → set
  on/setpoint/mode), `integrations.airzone` in the store (local: host/IP; or cloud:
  email/password), `GET/POST /api/integrations/airzone`.
- Airzone zones become **Devices** of type `underfloor`/`climate` with capabilities
  `{ setpoint(min/max), onoff, mode(system), roomTemp, humidity, demand, battery }`
  — the generic Devices UI (`Devices.tsx`/`DeviceDetail.tsx`), Schedules, and
  Automations render from those capabilities, same as the AC.
- Same **shadow-first + Off→Manual→Auto authority + guardrails** model. Enables
  unified climate: e.g. solar-surplus pre-heat the slab in valley/solar hours, or
  hold underfloor in P3 and coast through the P1 peak (slab thermal inertia).

## To proceed — need from the user
1. **Path:** enable the **Local API** (preferred) or use **Cloud** creds.
2. If local: the Airzone webserver model + which network it's on (and enable the
   Local API in the app: *Airzone Cloud → installation → webserver → Local API*).
3. If cloud: Airzone Cloud **email + password**.
