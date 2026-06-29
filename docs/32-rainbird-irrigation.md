# Rain Bird irrigation — Phase 1 (connector + manual control)

**Context:** Add a Rain Bird **ESP-TM2** irrigation controller (with an **LNK / LNK2 WiFi
module**, default LAN IP `192.168.1.159`) to the Energy app. Same LAN-local pattern as the
Airzone connector — the mini reaches the controller directly. Phase 1 ships the connector +
protocol port (with tests), config/probe, store type, devices+rooms integration, and a
manual run/stop/rain-delay UI on web **and** mobile. **No autonomous watering** in Phase 1.

**Brand:** "Power" design system (dark control-room). Standing rule honored — every surface
ships for web (≥768px, `ctx.desktop`) **and** mobile (<768px); rooms listed alphabetically.

> ⚠️ This integration actuates **water hardware**. Writes are admin-gated **and** require the
> Devices layer to be **armed** (stricter than climate, where a manual hand-command bypasses
> the arm gate). The PR must be **owner-reviewed, not auto-merged**.

---

## Protocol (reverse-engineered from pyrainbird)

The LNK module speaks the Rain Bird **SIP** (Sprinkler Irrigation Protocol) over an encrypted
HTTP transport. The reference is **pyrainbird** (github.com/allenporter/pyrainbird); we ported
the relevant pieces to Node/TypeScript and validated them against pyrainbird's own test vectors
(no physical box required for CI).

### Transport (`connectors/rainbird/transport.ts`)

- `POST http://<host>/stick`, `Content-Type: application/octet-stream`, headers cloned from
  pyrainbird (`Accept-Language: en`, the RainBird `User-Agent`, etc.).
- Body = an **AES-encrypted** JSON-RPC 2.0 envelope:
  `{"id":N,"jsonrpc":"2.0","method":"tunnelSip","params":{"data":"<hex SIP cmd>","length":<bytes>}}`.
- Response is the same encrypted envelope; we decrypt, parse, and return `result.data` (hex).
- **One request at a time:** the LNK garbles concurrent requests, so _all_ calls are serialized
  through a module-level promise-chain mutex. (Commands also conflict with the Rain Bird mobile
  app being open — that surfaces as an upstream error, which we just report.)

### Encryption (`connectors/rainbird/encryption.ts`)

- AES-256-CBC. **Key = SHA256(password)** (32 bytes).
- Per request: 16 random IV bytes. Plaintext = `json + "\x00\x10"`, then right-padded with
  `0x10` to a 16-byte boundary (no padding added when already aligned).
- **Wire layout** = `SHA256(json)[32]` ++ `IV[16]` ++ `AES-CBC(ciphertext)`. The integrity hash
  is SHA256 of the **unpadded** json (matches pyrainbird's `b2 = SHA256(data)`).
- Decrypt: IV = bytes[32:48], ciphertext = bytes[48:], strip trailing `0x10/0x0a/0x00`/whitespace,
  `JSON.parse`. Implemented with Node `crypto` (`createCipheriv/createDecipheriv 'aes-256-cbc'`,
  `setAutoPadding(false)` since we pad manually, `createHash('sha256')`).

### SIP opcode table + codec (`connectors/rainbird/sip.ts`)

Ported from `pyrainbird/resources/sipcommands.yaml`. Field positions/lengths are **hex-char**
offsets, straight from the YAML. Phase-1 commands:

| Command                | Code | Req len | Resp | Notes                                      |
| ---------------------- | ---- | ------- | ---- | ------------------------------------------ |
| ModelAndVersion        | `02` | 1       | `82` | model(4) · verMajor(2) · verMinor(2)       |
| AvailableStations      | `03` | 2       | `83` | page(1) → page(2) + setStations mask(8)    |
| CurrentIrrigationState | `48` | 1       | `C8` | state(2): 1 = running                      |
| CurrentStationsActive  | `3F` | 2       | `BF` | page(1) → page(2) + activeStations mask(8) |
| ManuallyRunStation     | `39` | 4       | `01` | station(1) + minutes(2)                    |
| StopIrrigation         | `40` | 1       | `01` | stop ALL                                   |
| RainDelayGet           | `36` | 1       | `B6` | delaySetting(4) days                       |
| RainDelaySet           | `37` | 3       | `01` | days(2)                                    |
| SerialNumber           | `05` | 1       | `85` | serial(16 hex)                             |

**Station bitmask order (important):** pyrainbird's `States` parses the 32-bit mask **byte by
byte, LSB-first within each byte**. For `0x3F000000` the first byte `0x3F` → bits 0–5 → stations
**1–6**. Our `decodeStations` reproduces this exactly (verified by test vector).

### Validation without the physical box

`connectors/rainbird/rainbird.test.ts` (Node built-in test runner via tsx — `node --import tsx
--test`). 10 tests, all passing:

- **Crypto:** encrypt→decrypt round-trip; a deterministic fixed-IV vector asserting the exact
  wire layout (hash ++ IV ++ block-aligned ciphertext); wrong-password does not recover the json.
- **Codec:** request-encoding for every Phase-1 command; response decoding against pyrainbird's
  published vectors — `820006090C` (model 6, v9.12), `83003F000000` (stations 1–6), `C801` (on),
  `B60003`/`B6000E` (3/14 days), `850000000000008963` (serial), and the LSB-first active-mask case.

---

## App wiring (follows existing patterns)

- **Connector** `connectors/rainbird.ts` (modeled on `airzone.ts`):
  - `isConfigured()` is true **only when host AND password are set** — a host alone is never
    enough (we can't talk to the box without the password), so the integration stays fully inert.
  - `host()` resolves store → `RAINBIRD_HOST` → `192.168.1.159`; `password()` resolves store →
    `RAINBIRD_PASSWORD` → none. **No password is ever hardcoded or committed.**
  - Normalized `IrrigationZone` (`id: rb-<station>`, name, station, active, available).
  - Reads (cached ~10s like airzone): `getZones()`, `getActiveZone()`, `getIrrigationState()`,
    `getInfo()` (model/version/serial), `getRainDelay()`. Writes (cache-busting): `startZone(id,
minutes)`, `stopAll()`, `setRainDelay(days)`.
- **Arm/command gate** `control/irrigation-execute.ts`: `issueIrrigation(deviceId, lever, value,
reason)` — `run` / `stop` / `rainDelay`. Refuses when not armed (`armed && mode!=='off'`),
  logs every action into the shared `devices.log` ring + `devices.lastError`. Never throws.
- **Route** `routes/irrigation.ts` + registrations in `index.ts`:
  - `GET /api/irrigation` (zones + controller state), `GET /api/irrigation/:id`,
    `POST /api/irrigation/:id/command` (admin), `PUT /api/irrigation/:id/settings` (admin).
  - `GET /api/integrations/rainbird` (status; never leaks the password — only `hasPassword`),
    `POST .../rainbird/test` (probe), `PUT .../rainbird` (admin; **probes the box via
    `ModelAndVersion` before persisting**, mirroring `setAirzone`/`setSonnen`),
    `DELETE .../rainbird` (admin disconnect).
- **Store** `store.ts`: `IntegrationsState.rainbird?: { host?; password? } | null`. `DeviceType`
  union gains `'irrigation'`.
- **Devices fleet** `routes/devices.ts`: irrigation zones merge into `/api/devices` as type
  `'irrigation'` (power = "watering now"; no setpoint/mode/temp). `getDevice('rb-…')` resolves
  them too. Room assignment uses the existing `deviceSettings[id].roomId` path.
- **Rooms** `rooms.ts`: zones included in `enumerateDevices()` with kind `'irrigation'`. Room
  **all-off explicitly skips irrigation** so "turn the room off" never stops/starts watering.
- **Frontend (web + mobile):**
  - Dedicated **`/irrigation`** screen (`screens/Irrigation.tsx`) — a zone list with per-zone
    manual **Run** (pick minutes + Start), **Stop**, a controller-wide **rain-delay** set, and
    room assignment (rooms listed alphabetically). Disarmed → Start disabled + a status note.
    Branches on `ctx.desktop`. Registered in `App.tsx`, `nav.ts` (More menu), and the AppShell
    `META` title map.
  - **Integration card** "Rain Bird" added to **Settings → Connections** (host prefilled +
    password field; Test/Save; status pill; never shows the stored secret).
  - `api.irrigation.*` + `api.integrations.rainbird*` in `lib/api.ts`; types in `lib/types.ts`.
  - A standalone screen (not folded into the climate Devices hub) was chosen deliberately:
    irrigation's run/stop/rain-delay levers don't fit the climate setpoint/mode command path or
    the `DeviceView` detail UI. The zones still appear in `/api/devices` for the fleet/rooms
    model; `classifyDevice` tags them `'irrigation'` so the climate hub **excludes** them.

### Inert-when-unconfigured

With no host+password, `isConfigured()` is false everywhere: `/api/irrigation` returns
`connected:false` with empty zones, the Devices/Rooms enumerations skip Rain Bird, the Settings
card shows "not connected", and **no probes or LAN calls are made**. Existing `/api/devices`,
`/api/rooms`, and the Devices screen are unaffected.

### Done / verification

- `pnpm typecheck` (api + web) clean; `pnpm -C apps/web build` succeeds; Prettier clean on all
  touched files; `rainbird.test.ts` 10/10 pass.

---

## Phase 2 / 3 (NOT yet built) — handoff points

The Phase-1 code is intentionally a **dumb actuator + manual UI**. The smart engine is deferred.

> **Dynamic zones (already in Phase 1):** the connector derives the zone list from the live
> `AvailableStations` mask — there is **no hardcoded zone count**. An ESP-TM2 with an expansion
> module reporting 8 (or more) wired stations surfaces all of them as `rb-1…rb-N` automatically.
> Phase 2's app-defined zones key off these station ids.

### Key architecture decision — THE APP OWNS THE SCHEDULE

The reverse-engineered API's native weekly-program write path is **unreliable**, so we do NOT push
a weekly program into the controller. Instead:

- The controller's onboard program is **cleared** (so it never fires on its own and can't conflict).
- A new **`startIrrigationCoordinator()`** (shaped like `light-coordinator` /
  `device-schedule-coordinator` / `radio-coordinator`) holds the schedule in OUR backend and fires
  each zone at its scheduled minute via the local-API `ManuallyRunStation(station, minutes)` —
  exactly the Phase-1 `issueIrrigation('rb-<n>', 'run', minutes)` write path. **Shadow-first**
  (log intended runs, write nothing), then the owner flips to armed/active — like the
  battery-priority and tariff-arbitrage rollouts.
- **Rain-delay** is the one thing we MAY still write to the controller (`setRainDelay`) as a belt-
  and-braces fallback when the coordinator decides to skip a wet day.

### Expanded product (Phase 2/3)

1. **App-defined zones with garden photos.** Up to 8 (controller-reported) zones, each given a
   friendly name and a **user-uploaded photo** of that part of the garden. The photo is stored as
   an **app asset** (e.g. on disk + referenced from `deviceSettings[rb-<n>]`, or a small blob
   store) — it is **never** pushed to the controller (the LNK has no photo/program concept). The
   zone↔station binding is `rb-<station>`.
2. **Per-zone WEEKLY SCHEDULE editor.** Stored in OUR backend (new store shape, e.g.
   `irrigationSchedules: { zoneId, days[], runs: [{ start: "HH:MM", minutes }] }`). Multiple
   start-time/duration entries per zone per day. This is the **ceiling** the ET engine trims from.
3. **ET / weather engine that TRIMS the schedule.** Reuse `connectors/weather.ts` (Open-Meteo) —
   extend its hourly request to also fetch `et0_fao_evapotranspiration`, `precipitation`,
   `precipitation_probability`, `relative_humidity_2m`, `wind_speed_10m`. The scheduled duration is
   the **maximum**; weather only **reduces** it: rain-skip (high precip / probability → 0),
   cool-weather / low-ET reduction (scale minutes down by the ET deficit), with an **optional**
   heat top-up. Surface a **"saved vs plan %"** metric (minutes trimmed ÷ scheduled minutes).
4. **Per-zone agronomic config (optional refinement).** plant/turf type, emitter flow, crop
   coefficient (Kc), area, root depth — feeds a soil-water-balance so the trim is agronomic, not
   just a flat ET scale. A running per-zone deficit (ET − effective rain − applied) can gate/size
   runs more precisely.
5. **Surplus / off-peak nudging.** Within a zone's allowed window, prefer the minutes that fall in
   solar **surplus** (live `climateSurplusKw`) or the cheap **P3** band (`tariff.ts` `bandFor`) —
   irrigation pumps are a deferrable load. Avoid P1.
6. **Highly intuitive Irrigation screen (web + mobile), Power design system.** A **photo zone
   grid** (each card = the garden photo + zone name + next-run + running indicator) → tap into a
   **per-zone weekly schedule editor** (day-toggle **pills** + a time/duration list) with live
   **weather-adjustment chips** (e.g. "−40% rain", "skipped — wet"), **next-run / applied / saved**
   stats, and a clear **running-zone** indicator. Branches on `ctx.desktop`; rooms/zones listed
   alphabetically.
7. **Future soil-moisture-sensor input interface.** Define a `SoilMoistureReading { zoneId, pct,
ts }` source interface so a real sensor (or a Tuya/LAN probe) can override the modelled deficit
   when present, with the ET model as fallback.

### Opcode / field uncertainties for the owner to confirm against the REAL controller

The codec is validated against pyrainbird vectors, but the live ESP-TM2 should confirm:

- **`ManuallyRunStation` minutes field width** — we encode minutes as a **2-byte** field
  (0–65535). pyrainbird's `length: 4` total = command + station(1) + minutes(2). Confirm a 10-min
  run on the real box waters ~10 min (and that minutes, not seconds, is the unit).
- **Station numbering / `AvailableStations` page** — we request page 0 and expect the ESP-TM2's
  ≤ 8/13 stations in the first mask. Confirm the live `AvailableStations` mask matches the wired
  valves and that station N maps to `rb-N`.
- **`CurrentStationsActive`** active-mask semantics during a manual run — confirm the running
  zone shows as active in the mask (so the UI "watering" state and `activeStationId` are correct).
- **`StopIrrigation` (`40`)** stops a manual run cleanly (vs only program runs).
- **`RainDelaySet`/`Get`** units are **days** on this firmware.
