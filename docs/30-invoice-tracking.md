# 30 — Energy invoice tracking, reconciliation & prediction

**Owner ask (2026-06-28):** track/predict the electricity invoice; upload + store real invoices;
compare them against our calculated cost. Owner set up a **Datadis** account for authoritative
per-band history, and supplied **4 real invoices** + CUPS + NIF.

Single responsive React app + Node/TS API. Follow CLAUDE.md: **web AND mobile**, Power design
system, typecheck + build before merge. **Standing git rule:** one worktree = one branch; never
push to `main`; PR only. This is **additive + read-only** (no battery/control/armed logic touched)
→ a normal web/API deploy preserves armed state.

## Supply identity (from the invoices)

- **CUPS:** `ES0021000019162369LP0P`
- **Titular / NIF:** JORIS DANIEL KROESE — `X6200215J` (Datadis verification in process as of 2026-06-28)
- **Comercializadora:** ADX Renovables, S.L. (mercado **libre**)
- **Distribuidora:** IBERDROLA DISTRIBUCIÓN ELÉCTRICA (i‑DE) — Datadis `distributorCode` likely `2`
  (do NOT hardcode — resolve via `get-supplies`)
- **Tarifa de acceso:** 2.0TD, contracted power **14 kW / 14 kW** (P1/P2)
- **Datadis credentials live ONLY in the API host env** (`DATADIS_USERNAME` = the NIF,
  `DATADIS_PASSWORD`), never in the repo, never in state. Password communicated out of band;
  treat as exposed → owner to rotate after first successful auth.

## What we already have (do not rebuild)

- **Tariff/band logic** `apps/api/src/tariff.ts`: `RATES {P1:0.2093,P2:0.1309,P3:0.0957}`,
  `bandForHour(hour,weekday)`, `bandCodesForDay`, `bandHourWeights`, `POWER_TERM_EUR_MONTH=36.19`,
  `EXPORT_MID=0.016`. Energy rates verified accurate vs the real bills (invoice P1 0.209285 ≈ ours).
- **Reports cost calc** `apps/api/src/routes/history.ts`: pulls Tesla `calendar_history`, sums grid
  import, splits to bands by `bandHourWeights()` — **a weekly-average APPROXIMATION, not metered
  per-band**. This is the thing invoices expose for real.
- **SQLite handle** `apps/api/src/db/sqlite.ts` (fail-soft, migrations) + `.data/metering.db` from
  PR #92 — available if we want a table instead of JSON.
- **Atomic JSON store** `apps/api/src/store.ts` (`statePath()` resolver) and the `history5m.ts`
  pattern (dedicated `.data/*.json` file, atomic write, never throws) — the template for an
  invoices store that must NOT bloat `state.json`.

## Real invoice anatomy (ADX Renovables, confirmed stable across all 4 months)

Digital-text PDFs (not scans) → server-side text extraction works. Layout is stable; parse by
labelled regex. Confirmed fields (example = factura 260060754, period 31‑03 → 30‑04‑2026):

| Field | Example | Notes |
|---|---|---|
| `facturaNum` | 260060754 | `Factura núm: (\d+)` |
| `fechaFactura` | 06‑05‑2026 | `Fecha factura:(DD-MM-YYYY)` |
| `periodStart`/`periodEnd` | 31‑03‑2026 / 30‑04‑2026 | `Periodo de facturación: Del (…) al (…)` |
| `days` | 30 | from power-term line |
| `meterRegister` per band | P1 19 / P2 58 / P3 246 (TOTAL 323) | **gross register diff** (`Lectura de contador` block) |
| `energyBilled` per band | P1 17.40 / P2 57.35 / P3 243.37 kWh | **billed term** — differs from register (hourly self-consumption netting); reconcile against THIS |
| `energyRate` per band | 0.209285 / 0.130948 / 0.095709 €/kWh | `Término Energía Px` line |
| `powerTerm` per band | P1 14 kW × 30 d × 0.077205 = 32.43€; P2 × 0.006165 = 2.59€ | **per‑kW‑per‑day split**, NOT our flat 36.19 |
| `excedentes` per band | P1 −174.67 @ 0.006025; P2 −5.83 @ 0.027652; P3 −183.62 @ 0.025221 | **per‑band export comp, rates vary MONTH to MONTH**, not our flat 0.016 |
| `bonoSocial` | 30 d × 0.019121 = 0.57€ | Financiación Bono Social TED/733/2022 |
| `subtotal` | 64.19€ | |
| `iee` (electricity tax) | 64.19 × 0.005 = 0.32€ | Impuesto sobre la electricidad, 0.5% |
| `meterRental` | 0.80€ | Alquiler de equipos |
| `baseImponible` | 65.31€ | |
| `iva` | 21% = 13.72€ | |
| `total` | 79.03€ | TOTAL FACTURA |
| `maxPowerKw` | 13.27 / 13.79 / 10.88 kW | maxímetro — for a future power-term right-sizing tip |

Cross-month sanity (parsed live, all 4):

| Factura | Period→ | Register P1/P2/P3 | Total € | Flag |
|---|---|---|---|---|
| 260033515 | 06‑Mar | 84 / 203 / 678 | 174.20 | winter |
| 260045310 | 08‑Apr | 338 / 372 / **1** | 315.05 | **anomaly — P3=1, almost certainly an estimated read** |
| 260060754 | 30‑Apr | 19 / 58 / 246 | 79.03 | |
| 260077750 | 09‑Jun | 35 / 77 / 332 | 127.95 | |

Sample PDFs for building/testing the parser (owner's machine, not in repo):
`C:\Users\Joris\Downloads\Factura--2600{33515,45310,60754,77750}*.pdf`.

## Model gaps the bills reveal (what prediction must add to match reality)

Our current cost model is ~80% of the bill. To predict an invoice we must model the rest:
1. **Power term** as P1/P2 **€/kW/day × contracted kW × days** (not a flat monthly constant).
2. **Excedentes** as **per‑band export rates that change every month** (store per invoice; for
   forward prediction use a recent average + label as estimate).
3. **IEE** (0.5% of subtotal), **meter rental** (~0.80€/mo), **Bono Social** financing (~0.019€/day),
   **IVA 21%** on the base.
4. **Register vs billed-energy** divergence (hourly self-consumption netting) — reconcile the
   **billed** term; surface the register too.

---

## Phase 1 — Invoice vault + reconciliation (BUILD NOW — fully unblocked, no Datadis)

### 1.1 Parser  `apps/api/src/invoices/parse.ts`
- Extract text from a PDF buffer (use `pdfjs-dist` legacy build, or `pdf-parse`; pick the lighter
  one that bundles cleanly into the existing esbuild `dist` — verify it vendors like better-sqlite3
  did, or is pure-JS). Parse the labelled fields above into a typed `ParsedInvoice`.
- **Tolerant:** Spanish decimals use `,`; mojibake (`ñ`→`�`) in extracted text — match on stable
  ASCII anchors (`Término Energía Px`, `TOTAL FACTURA`, `Base Imponible`). Every field optional +
  a `confidence`/`warnings[]` list; never throw on a missing field.
- Return the parsed struct for owner review BEFORE saving (owner confirms/corrects → then persist).
  This is the "OCR/LLM auto-extract + confirm" intake the owner chose. (Pure text-regex first; an
  LLM-assisted fallback for unknown layouts is a later option — ADX is the only format for now.)

### 1.2 Store  `apps/api/src/invoices/store.ts`
- Dedicated `.data/invoices.json` (mirror `history5m.ts`: atomic write, never throw) — do NOT bloat
  `state.json`. PDFs saved as blobs at `.data/invoices/<id>.pdf` (path resolver mirrors `statePath()`,
  env `INVOICES_DIR` override). `Invoice` = `{ id, uploadedAt, sourceFile, parsed: ParsedInvoice,
  confirmed: boolean, edits?: Partial<ParsedInvoice> }`.

### 1.3 Cost model  `apps/api/src/invoices/model.ts`
- `modelInvoice(input)` → reproduce the full bill structure from metered per-band kWh + contracted
  power + days + period: energy (per-band rate), power term (per-band €/kW/day), excedentes
  (per-band), IEE, meter rental, bono social, base, IVA, total. Rates come from a **versioned
  pricing config** (see 1.4) so historical months use the rates that applied then.
- `reconcile(invoice)` → line-by-line **billed vs modelled** with € + % deltas, plus a headline
  total delta. For Phase 1 the "modelled" side prices the **invoice's own metered kWh** with our
  config → validates the model and exposes each gap. (Once Datadis lands, also reconcile the
  invoice's per-band kWh against Datadis hourly-bucketed kWh → catches estimated-read anomalies
  like the P3=1 invoice.)

### 1.4 Pricing config  (extend `tariff.ts` or new `apps/api/src/invoices/pricing.ts`)
- Versioned: `{ validFrom, energy{P1,P2,P3}, powerEurKwDay{P1,P2}, exportEurKwh{P1,P2,P3},
  ieePct, meterRentalEurDay, bonoSocialEurDay, ivaPct }`. Seed the first version(s) from the
  parsed invoices' actual rates. Keep `RATES`/`bandHourWeights` for the existing Reports approximation.

### 1.5 API  `apps/api/src/routes/invoices.ts` (mount where routes are mounted)
- `POST /api/invoices/parse` (multipart upload → parse, return `ParsedInvoice` for review, do NOT save yet)
- `POST /api/invoices` (confirm/save: stores PDF + parsed/edited record)
- `GET /api/invoices` (list, newest first) · `GET /api/invoices/:id` (detail + reconciliation)
- `GET /api/invoices/:id/pdf` (serve stored PDF) · `DELETE /api/invoices/:id`
- Admin-gated like other mutating routes. Multipart via `multer`/`busboy` (verify it bundles).

### 1.6 Web — new **Bills** screen (web AND mobile, Power design system)
- Nav entry (Rail + TabBar) — or a tab under Reports; pick whichever fits the IA, prefer a Reports
  sub-tab to avoid nav crowding. Confirm both viewports.
- **List:** invoices as cards (period, total €, per-band kWh sparkline/chips, a ⚠️ badge when
  reconciliation delta is large or a read looks estimated). Upload button → drag/drop or file pick.
- **Upload flow:** pick PDF → `POST /parse` → **review screen** pre-filled with parsed fields, owner
  edits anything wrong → Save.
- **Detail / reconciliation:** the billed-vs-modelled table (P1/P2/P3 energy, power term, excedentes,
  IEE, rental, bono social, IVA, total) with delta + % columns; link to view the original PDF.
- Trend view across saved invoices (total €, kWh, per-band) — small, reuse chart primitives.

### 1.7 Acceptance (Phase 1)
- `pnpm --filter @energy/api typecheck` + `pnpm --filter @energy/web typecheck && build` clean.
- The 4 sample PDFs parse into correct per-band kWh, rates, and totals (spot-check vs the table above).
- Saving persists PDF + record across restart (JSON store survives); list + detail + reconcile render
  on desktop AND mobile.
- Reconciliation surfaces the known gaps (power-term split, per-band export, IEE/rental/IVA) as
  explicit deltas rather than silently mismatching.
- **Zero** changes to control/coordinator/guardrail/armed code paths (additive + read-only).

---

## Phase 1.5 — "Other costs" tracking (owner request 2026-06-29, post-#103)

**Owner:** upload works well; "the only thing missing perhaps is the other cost (aside from metered
usage) as this might vary over time and is good to track separately to predict the total invoice."

Today the Bills UI trends only the **invoice total** (`TrendChart` in `apps/web/src/screens/Bills.tsx`)
and the per-component figures live only inside the billed-vs-modelled reconciliation table. The
`modelInvoice()`/`reconcile()` model (`apps/api/src/invoices/model.ts`) already computes every
component — this is decomposition + aggregation + UI, not new modelling.

**Decomposition (for prediction, not just display) — 4 groups:**
- **Metered energy (usage):** energy term P1/P2/P3 (`energy.total`). Scales with kWh — the forecastable part.
- **Fixed / capacity:** power term + meter rental + Bono Social. ~constant per day.
- **Regulatory & tax:** IEE (% of subtotal, regime-varying) + IVA (21% of base).
- **Credits & settlements:** excedentes (export credit, negative) + SSAA/system-cost adjustments
  (retroactive true-ups — flag as unpredictable).

"**Other costs**" = the latter three groups (everything that is not metered energy). Prefer the
**billed** figures parsed off the PDF; fall back to modelled when a billed line is absent.

**Build:**
1. **API** — add a per-invoice cost decomposition (a `costBreakdown` on the detail response and a
   compact `{energyEur, fixedEur, regTaxEur, creditsEur, otherEur, total}` on the list `InvoiceSummary`)
   derived in `model.ts` from the effective parsed bill. Keep it pure/derived (no new store fields).
2. **Web — detail:** a **"Cost breakdown"** card splitting the total into Metered energy vs Other
   costs (with the Other sub-lines), distinct from the reconciliation card. A headline "X% energy /
   Y% other" split. Power-design-system, both viewports.
3. **Web — trend:** extend the trend area to show **other costs over time** (stacked by group, oldest
   → newest) alongside the existing total trend, so drift in IEE/SSAA/power-term/IVA is visible.
4. **Prediction seam (note, don't fully build — that's Phase 3):** the tracked other-costs become the
   predictor — `predictedTotal = predictedEnergy(consumption forecast) + carried-forward fixed
   (last-known €/day × days) + regulatory % applied + export credit(forecast) + SSAA(flagged ±)`.
   Leave a typed helper stub + a code comment pointing at Phase 3; don't wire live forecasts yet.

Additive + read-only; no control paths. Verify both viewports. Acceptance: api+web typecheck/build
clean; breakdown sums back to the bill total (±rounding) on all 4 sample invoices; trend renders with
≥2 invoices on desktop AND mobile.

## Phase 2 — Datadis backfill (when NIF verification clears)

`apps/api/src/connectors/datadis.ts`:
- `POST https://datadis.es/nikola-auth/tokens/login` (username+password form) → bearer token,
  cached ~24h. `GET /api-private/api/get-supplies` → CUPS + `distributorCode` + `pointType` +
  supply start. `GET /api-private/api/get-consumption-data` month-by-month from **2026‑01** →
  present, `measurementType=0` → **hourly kWh** rows.
- Bucket each hour into exact **P1/P2/P3** via `bandForHour` (Europe/Madrid, weekends/holidays = P3)
  → persist a durable `consumption_history` (metered, per-band) — the billing-truth backbone that
  replaces the 30‑day-pruned, band-less `history-5m` for cost reporting.
- Replace the `bandHourWeights` approximation in Reports `byBand` with metered per-band when present
  (keep approximation as a labelled fallback). Cross-check invoices vs Datadis → flag estimated reads.
- **Lag:** Datadis updates ~1–2 days behind and is monthly-batched → it's the *billing-truth* layer;
  live `history-5m` stays for real-time. Smoke-test = auth + get-supplies resolves the CUPS first.

## Phase 3 — Live invoice prediction
- Project current/next billing cycle: month-to-date metered per-band (Datadis) + forecast remainder
  (reuse `solarForecast`/`loadForecast` from the arbitrage planner) → full modelled € total
  (energy + power term + excedentes + IEE + rental + bono social + IVA) with a confidence band,
  shown live and validated against the next real invoice as it arrives. Editable pricing config UI.

## Out of scope (this round)
- No Datadis code until NIF verification clears (Phase 1 needs no external integration).
- No control/battery/guardrail/armed changes anywhere.
- No LLM-OCR path yet (ADX text-regex covers the only current format; add later if a new
  comercializadora layout appears).
