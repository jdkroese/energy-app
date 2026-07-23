# 28 — Circuit-breaker usage logging & consumption calculator

**Status:** proposed (spec) · **Owner ask:** "log usage of all circuit breakers (1-min interval, up to 3 years), calculate consumption per breaker; scaling 3 → ~40 metered CBs."
**Author:** design/orchestration agent · 2026-06-28

---

## 1. Goal & scope

Continuously sample every **metered** Tuya circuit breaker, persist a time-series at
1-minute resolution, and compute **per-breaker energy consumption (kWh)** over any
range (today / week / month / arbitrary) for up to **3 years** of history — designed
to scale cleanly from today's 3 breakers to ~40.

**In scope (v1):** collector, storage, rollups, retention, consumption calc, query
API, and a per-breaker usage surface (chart + kWh totals) on the breaker detail page.

**Out of scope (v1, see §11 phasing):** € cost overlay via the P1/P2/P3 tariff
(Phase 2), local-LAN polling for sub-cloud-cadence resolution (Phase 3), migrating
the existing `history5m`/`voltage-history` JSON stores into the same DB (later
unification), CSV export.

**Non-goals:** billing-grade certified metering; sub-minute sampling; integrating
non-Tuya meters.

---

## 2. Why the current storage won't do (decision: add SQLite)

Time-series today is **JSON files loaded fully into memory** (`history5m.ts`,
`voltage-history.ts`), bounded to ~48 h. At 40 breakers × 1-min × 3 y that is **~63 M
samples** — a multi-GB JSON file rehydrated into RAM on every read. Dead end.

**Volume:**

| | rows |
|---|---|
| 1 breaker/day | 1,440 |
| 40 breakers/day | 57,600 |
| 40 breakers/year | ~21 M |
| 40 breakers × 3 y (raw) | **~63 M** |

**Decision:** introduce **SQLite via `better-sqlite3`** (synchronous, embedded, WAL
mode, zero external service — ideal on the mini). DB file at **`.data/metering.db`**
(`.data/` is already git-ignored, same place as `state.json`). Single process owns it.

**Decision:** don't keep 1-min raw for 3 years. Use **retention tiers** (RRD/Prometheus
pattern):

| tier | resolution | retention | rows @ 40 CB | approx size |
|---|---|---|---|---|
| `raw` | 1-min | **30 days** | ~1.7 M | ~120 MB |
| `hourly` | 1-hour rollup | **3 years** | ~1.05 M | ~65 MB |
| `daily` | 1-day rollup | **forever** | ~44 k / 3 y | <5 MB |

Full 3-year consumption history in **well under 200 MB**, with instant indexed
queries and minute detail retained for the recent window. Write load is **~0.7
writes/s** — a non-issue.

---

## 3. Data model (SQLite schema)

```sql
-- 1-minute raw samples (30-day retention)
CREATE TABLE cb_raw (
  breaker_id   TEXT    NOT NULL,
  ts           INTEGER NOT NULL,        -- unix seconds, minute-aligned (UTC)
  power_w      REAL,                    -- instantaneous, scaled to real W
  voltage_v    REAL,
  current_a    REAL,
  energy_wh    REAL,                    -- consumption attributed to THIS interval
  energy_total_wh REAL,                 -- cumulative counter snapshot (if device has one)
  PRIMARY KEY (breaker_id, ts)
) WITHOUT ROWID;

-- hourly rollup (3-year retention)
CREATE TABLE cb_hourly (
  breaker_id   TEXT    NOT NULL,
  bucket_ts    INTEGER NOT NULL,        -- start of hour, UTC unix seconds
  energy_wh    REAL    NOT NULL,        -- Σ interval consumption
  power_avg_w  REAL, power_max_w REAL,
  voltage_avg_v REAL, voltage_min_v REAL, voltage_max_v REAL,
  samples      INTEGER NOT NULL,        -- coverage (detect gaps)
  PRIMARY KEY (breaker_id, bucket_ts)
) WITHOUT ROWID;

-- daily rollup (forever) — bucket aligned to LOCAL midnight (Europe/Madrid)
CREATE TABLE cb_daily (
  breaker_id   TEXT    NOT NULL,
  day          TEXT    NOT NULL,        -- 'YYYY-MM-DD' local
  energy_wh    REAL    NOT NULL,
  power_avg_w  REAL, power_max_w REAL,
  voltage_avg_v REAL, voltage_min_v REAL, voltage_max_v REAL,
  samples      INTEGER NOT NULL,
  PRIMARY KEY (breaker_id, day)
);

CREATE TABLE cb_meta (k TEXT PRIMARY KEY, v TEXT);  -- schema version, last-rollup cursor
```

Notes:
- `breaker_id` = the **Tuya device id** (stable across renames; the display name is
  resolved at query time from `store.deviceOnboarding.configured`).
- `WITHOUT ROWID` + composite PK gives a clustered `(breaker_id, ts)` index → range
  scans for "breaker X between t0 and t1" are sequential and fast.
- Times stored **UTC**; daily buckets keyed by **local** date (Europe/Madrid, reusing
  `tariff.ts` `TZ`) so "a day" matches the tariff/day boundaries the rest of the app
  already uses.

---

## 4. The collector (sampler)

A new module `apps/api/src/control/breaker-metering.ts`, started from `index.ts`
(mirrors `startDeviceScheduleCoordinator`), `start/stop` exported.

- **Cadence:** every **60 s** (configurable `meteringIntervalSec`, default 60), aligned
  to the wall-minute. One `tuya.getDevices()` returns the **whole fleet in a single
  call** — 40 breakers is *not* 40 API calls, so cost barely changes from today's poll.
  (Could later piggyback the existing fleet poll to avoid a second read.)
- **Per tick:** for each **configured breaker** (`deviceOnboarding.configured`, category
  `dlq`/`tdq`/`zndb`) that is **metered** (exposes `cur_power` or an energy counter),
  read its status, scale to real units (reuse the `readLiveValue`/spec-`scale` path
  shipped in the gauge-scaling fix), compute the interval's `energy_wh` (§5), and
  insert one `cb_raw` row. All inserts for the tick run in **one prepared transaction**.
- **Gaps, not zeros:** if the breaker is offline / status missing, **skip** (write
  nothing) — never write `0`, which would understate consumption. Rollups carry a
  `samples` count so coverage is visible.
- **Never throws / best-effort:** a tick failure logs to `devices.lastError` and
  continues (same contract as the schedule coordinators). No control authority.

---

## 5. Consumption calculation (counter-diff, not power integration)

Energy attributed to each interval, in priority order per breaker:

1. **Cumulative energy counter (preferred).** Metered Tuya breakers expose a lifetime
   forward-energy total (commonly `add_ele` and/or a `*_forward_energy`/`total`-style
   DP — **exact code + scale to be confirmed on real hardware**, see §9). Consumption =
   `max(0, total_now − total_prev)`. **Miss-tolerant:** a skipped poll just widens the
   next diff; nothing is lost.
   - Guard **resets/rollover:** if the delta is negative (counter reset after power
     loss) or implausibly large (> a configurable ceiling, e.g. > breaker rating ×
     interval), attribute the fallback (#2) for that interval instead.
2. **Power integration (fallback)** when no counter exists: `energy_wh ≈ power_w ×
   (Δt_hours)`. Simple, but drifts and misses sub-minute spikes — acceptable as a
   backstop only.
3. **Neither** (non-metered breaker, e.g. "CB - Heatpump") → **not logged at all**;
   it has no consumption series (consistent with the card hiding its gauges).

Period consumption (any range) = **Σ `energy_wh`** over the chosen tier's buckets.

**Energy-source abstraction:** resolve a per-breaker `EnergySource =
{ kind: 'counter', dp, scale } | { kind: 'power' } | 'none'` once (auto-detected from
capabilities, cached, manual override possible). This isolates the one hardware-specific
unknown behind a single resolver.

---

## 6. Rollups & retention (idempotent jobs)

- **Hourly rollup:** every hour (and on boot for any missed hours via the `cb_meta`
  cursor), aggregate completed hours of `cb_raw` → `cb_hourly` (`Σ energy_wh`,
  avg/max power, avg/min/max voltage, `samples`). `INSERT … ON CONFLICT … UPDATE`
  (re-runnable).
- **Daily rollup:** roll completed local-days of `cb_hourly` → `cb_daily`.
- **Retention prune:** delete `cb_raw` older than 30 d, `cb_hourly` older than 3 y.
  `cb_daily` kept indefinitely.
- All jobs are **idempotent** and survive restarts (boot reconciles from the cursor +
  raw coverage) — a deploy mid-hour loses nothing.

---

## 7. Query API (read-only)

```
GET /api/breakers/:id/usage?from=<iso>&to=<iso>&granularity=raw|hour|day
  → { breaker: {id,name}, granularity, points: [{ts, energyWh, powerAvgW, ...}], totalKwh }

GET /api/breakers/usage/summary?period=today|week|month|year|custom&from=&to=
  → { period, breakers: [{ id, name, kwh, sharePct }], totalKwh }   // dashboard table
```

- Auto-pick the tier when `granularity` omitted: ≤ 36 h → `raw`, ≤ 90 d → `hour`, else
  `day` (keeps payloads small).
- Read-only; no admin gate for reads (consistent with other read endpoints). The
  collector/config toggles are admin.

---

## 8. Frontend surface (web + mobile, Power design system)

**Phase-1 minimum — per-breaker, on the breaker detail page**
(`GenericDeviceDetail` / the breaker detail) for any metered breaker:
- **kWh stat row:** Today · This week · This month (mono numerals, `StatTile` style).
- **Usage chart:** power over a selectable window (24 h / 7 d / 30 d), hand-rolled SVG
  in the established chart style (cf. the voltage-history chart from #85), with the
  bucket tier following the window. Empty-state "Collecting data…" until enough points.
- Both viewports: desktop full-width chart; mobile single-column. Non-metered breakers
  show no usage section at all.

**Phase-1 optional — fleet view:** a "Consumption" panel (Reports or a new Energy tab)
with the `usage/summary` table — per-breaker kWh + share for the period, sortable,
plus a stacked daily bar. Decide in §12 whether this lands in v1 or Phase 2.

---

## 9. Tuya specifics & the one real unknown

- Breakers are category **`dlq`** (also handle `tdq`/`zndb`). The screenshots show
  `cur_power`, `cur_voltage`, `cur_current`, **`add_ele`**, and `*_coe` (calibration
  **coefficients**, *not* energy — ignore for consumption).
- **The single hardware-specific risk:** the exact semantics of the energy DP —
  `add_ele` may be a *lifetime cumulative* counter **or** a *per-report increment*, and
  its scale (×0.01 kWh vs ×0.001 kWh) varies by firmware. **Implementation gate:** on a
  real metered breaker (CB - up WCD's / CB car charger), confirm whether `add_ele`
  monotonically increases (→ counter-diff) or arrives as deltas (→ accumulate), and the
  scale, by cross-checking the device's own app total over a known interval. The
  `EnergySource` resolver (§5) is built to absorb whichever it is.
- **Cloud cadence caveat:** Tuya's cloud refreshes some DPs slower than 60 s, so
  effective live-power resolution is "whatever the cloud has at sample time." Energy via
  the **counter-diff is unaffected** (it's cumulative). Local-LAN polling (Phase 3)
  could tighten live power later.

---

## 10. Edge cases

- **Offline / missing status** → skip (gap), never write 0.
- **Counter reset / rollover** → clamp negative/implausible deltas to the power-integ
  fallback for that interval.
- **Breaker renamed** → id-keyed storage is unaffected; name resolved at query time.
- **Breaker removed / re-paired** → history retained under the old id; surfaced as an
  "archived" breaker in summary if it has rows but is no longer configured.
- **DST / day boundaries** → daily buckets use local (Europe/Madrid) dates via
  `tariff.ts`'s tz logic, so they line up with tariff days; raw/hourly stay UTC.
- **DB durability** → WAL mode; sync writes are sub-millisecond at this volume and don't
  meaningfully block the loop. Schema migrations gated by `cb_meta` version.

---

## 11. Module layout & rollout

```
apps/api/src/db/sqlite.ts            # better-sqlite3 handle + migrations (new dep)
apps/api/src/control/breaker-metering.ts   # sampler + EnergySource + rollups + prune
apps/api/src/routes/breaker-usage.ts # query endpoints
apps/web/src/screens/...             # usage section on breaker detail (+ optional fleet panel)
```

- **New dependency:** `better-sqlite3` (prebuilt binaries; confirm it builds on the
  mini's Node/arch in CI — the one supply-chain/build check to do early).
- **Deploy safety:** entirely **additive + read-only** (no control logic, no arm
  changes) → ordinary web/api deploy, **armed state preserved**.
- **No backfill:** history accrues from first deploy forward (the 3-year horizon starts
  now). Call this out to the owner.
- **Scales to 40 by construction** — nothing in the design is per-breaker-coded.

---

## 12. Decisions needed (recommended defaults in **bold**)

1. **Base interval** — **60 s** (vs 30 s / 5 min). 60 s matches the ask and cloud cadence.
2. **Retention tiers** — **raw 30 d / hourly 3 y / daily forever** (table §2).
3. **v1 surface** — **breaker detail page (kWh stats + usage chart)**; add the fleet
   "Consumption" summary table in the same PR or defer to Phase 2?
4. **€ cost overlay (Phase 2)** — apply the existing **P1/P2/P3 tariff** (`tariff.ts`
   `bandFor`/`RATES`) to per-breaker kWh for cost-per-breaker and "what's costing me
   most"? High value, reuses shipped code. Recommend **yes, Phase 2**.
5. **Local-LAN polling (Phase 3)** — pursue later only if cloud cadence proves too
   coarse for live power. Recommend **defer**.

## 13. Phasing

- **Phase 1 (this spec):** SQLite + sampler + rollups + retention + consumption calc +
  query API + per-breaker detail usage section. (+ optional fleet summary — decision §12.3)
- **Phase 2:** tariff € cost overlay (per-breaker cost, peak/valley split) + fleet
  Consumption dashboard if deferred.
- **Phase 3:** local-LAN polling; unify `history5m`/`voltage-history` into the same DB.
