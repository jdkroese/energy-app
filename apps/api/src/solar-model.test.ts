// Unit tests for the shared solar forecast model — run with the Node built-in
// test runner via tsx:
//   node --import tsx --test src/solar-model.test.ts
// (apps/api has no formal test-runner script; tsx is a devDependency.)
//
// Hermetic: SOLAR_MODEL_FILE + HISTORY_5M_FILE are pointed at throwaway paths in
// the scratchpad BEFORE importing the module under test, so nothing touches the
// real .data files and the module's first load() reads our synthetic history.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SCRATCH = resolve(
  'C:/Users/Joris/AppData/Local/Temp/claude/E--Claude-Energy-app/cbb3ae32-8ac8-4283-92f0-665deb3c1d62/scratchpad',
);
if (!existsSync(SCRATCH)) mkdirSync(SCRATCH, { recursive: true });

const HISTORY_FILE = resolve(SCRATCH, `sm-history-${process.pid}.json`);
const MODEL_FILE = resolve(SCRATCH, `sm-model-${process.pid}.json`);

// ---- Synthetic July history --------------------------------------------------
// Build N July days whose measured solarKw = clearSky(kW) × targetRatio over the
// daytime hours, so the learned per-hour roof shape converges to targetRatio.

const BUCKETS = 288;
const LAT = 38.79;
const KWP = 18.2;
const DEG = Math.PI / 180;

function solarElevationDeg(hourLocal: number, dayOfYear: number, lat: number): number {
  const decl = 23.45 * Math.sin(DEG * (360 * (284 + dayOfYear)) / 365);
  const hourAngle = 15 * (hourLocal - 13);
  const sinElev =
    Math.sin(DEG * lat) * Math.sin(DEG * decl) +
    Math.cos(DEG * lat) * Math.cos(DEG * decl) * Math.cos(DEG * hourAngle);
  return Math.asin(Math.max(-1, Math.min(1, sinElev))) / DEG;
}
function haurwitzGHI(elevationDeg: number): number {
  if (elevationDeg <= 0) return 0;
  const s = Math.sin(DEG * elevationDeg);
  if (s <= 0) return 0;
  return Math.max(0, 1098 * s * Math.exp(-0.059 / s));
}

/** day-of-year for a YYYY-MM-DD (UTC-based, adequate for July). */
function doyOf(dateKey: string): number {
  const [y, m, d] = dateKey.split('-').map(Number);
  const start = Date.UTC(y, 0, 1);
  const cur = Date.UTC(y, m - 1, d);
  return Math.floor((cur - start) / 86400000) + 1;
}

function blankDay(dateKey: string) {
  const series: Record<string, (number | null)[]> = {};
  for (const k of ['solarKw', 'homeKw', 'chargeKw', 'dischargeKw', 'gridImportKw', 'gridExportKw']) {
    series[k] = new Array<number>(BUCKETS).fill(0);
  }
  for (const k of ['sonnenSoc', 'teslaSoc', 'combinedSoc']) {
    series[k] = new Array<number | null>(BUCKETS).fill(null);
  }
  return { date: dateKey, series, seen: new Array<number>(BUCKETS).fill(1) };
}

/** Write a synthetic history file: `days` July days, measured solar = clearSky×ratio. */
function writeHistory(days: string[], ratio: number, homeKw = 0): void {
  const file = { v: 1, days: {} as Record<string, ReturnType<typeof blankDay>> };
  for (const key of days) {
    const day = blankDay(key);
    const doy = doyOf(key);
    for (let b = 0; b < BUCKETS; b++) {
      const h = Math.floor(b / 12);
      const elev = solarElevationDeg(h, doy, LAT);
      const ghiC = haurwitzGHI(elev);
      const clearKw = (ghiC / 1000) * KWP;
      day.series.solarKw[b] = clearKw > 0 ? clearKw * ratio : 0;
      day.series.homeKw[b] = homeKw;
    }
    file.days[key] = day;
  }
  writeFileSync(HISTORY_FILE, JSON.stringify(file), 'utf8');
}

function julyDays(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `2026-07-${String(i + 1).padStart(2, '0')}`);
}

// ---- Fresh-module loader -----------------------------------------------------
// The solar-model module caches its file path + parsed state on first use, so we
// reset env + module registry and dynamically re-import for each scenario.

async function freshModel(): Promise<typeof import('./solar-model')> {
  process.env.HISTORY_5M_FILE = HISTORY_FILE;
  process.env.SOLAR_MODEL_FILE = MODEL_FILE;
  // Drop the shared history5m singleton so it re-reads our freshly-written file.
  const history = await import('./history5m');
  history._resetForTest();
  // Bust the module cache so solar-model's module-level `cache`/`path` re-init and
  // its first load() re-runs the history backfill against the new files.
  const bust = `?t=${Date.now()}-${Math.random()}`;
  const solar = (await import(`./solar-model${bust}`)) as typeof import('./solar-model');
  return solar;
}

function cleanup(): void {
  for (const f of [HISTORY_FILE, MODEL_FILE]) if (existsSync(f)) rmSync(f);
}

// ---- Tests -------------------------------------------------------------------

test('learns a per-hour roof shape from synthetic history', async () => {
  cleanup();
  writeHistory(julyDays(15), 0.8);
  const solar = await freshModel();
  const shape = solar.roofShapeForMonth('2026-07');
  // Midday hours have plenty of clear-sky, so the learned ratio should sit near 0.8.
  const midday = shape[13];
  assert.ok(midday > 0.7 && midday < 0.9, `midday roof shape ~0.8, got ${midday}`);
  cleanup();
});

test('forecastSolarKw July clear-sky peak is sane (near kWp×PR)', async () => {
  cleanup();
  writeHistory(julyDays(20), 0.82);
  const solar = await freshModel();
  // No live weather → weatherFactor=1 → clear-sky × learned shape.
  const kw = solar.forecastSolarKw(null, new Date('2026-07-15T12:00:00Z'));
  const peak = Math.max(...kw);
  // Clear-sky July peak ≈ kWp × PR. Broad band: 0.55×kWp .. 0.95×kWp.
  assert.ok(peak > KWP * 0.55 && peak < KWP * 0.95, `July peak in band, got ${peak}`);
  cleanup();
});

test('weatherFactor halves output at 50% shortwave', async () => {
  cleanup();
  writeHistory(julyDays(20), 0.82);
  const solar = await freshModel();
  const date = new Date('2026-07-15T12:00:00Z');
  const clear = solar.forecastSolarKw(null, date);
  // Build a weather forecast whose shortwave is exactly half the clear-sky GHI at
  // every daytime hour → weatherFactor ≈ 0.5.
  const doy = doyOf('2026-07-15');
  const rad = Array.from({ length: 24 }, (_, h) => {
    const ghiC = haurwitzGHI(solarElevationDeg(h, doy, LAT));
    return ghiC * 0.5;
  });
  const half = solar.forecastSolarKw({ shortwaveRadiation: rad } as never, date);
  const ci = clear.indexOf(Math.max(...clear));
  assert.ok(clear[ci] > 0.1, 'clear midday output positive');
  const ratio = half[ci] / clear[ci];
  assert.ok(ratio > 0.45 && ratio < 0.55, `half-shortwave ~0.5× output, got ${ratio}`);
  cleanup();
});

test('no-weather fallback is non-null over midday', async () => {
  cleanup();
  writeHistory(julyDays(20), 0.82);
  const solar = await freshModel();
  const kw = solar.forecastSolarKw(null, new Date('2026-07-15T12:00:00Z'));
  assert.ok(kw[13] > 0.1, `midday clear-sky forecast positive, got ${kw[13]}`);
  assert.equal(kw.length, 24);
  cleanup();
});

test('output is capped at the inverter AC limit (kWp)', async () => {
  cleanup();
  // Learn an over-unity roof shape (ratio 1.5) so clearSky × shape would exceed kWp;
  // the cap must clamp it to kWp.
  writeHistory(julyDays(20), 1.5);
  const solar = await freshModel();
  // Feed brighter-than-clear-sky weather too, to push against the cap hard.
  const doy = doyOf('2026-07-15');
  const rad = Array.from({ length: 24 }, (_, h) => haurwitzGHI(solarElevationDeg(h, doy, LAT)) * 1.1);
  const kw = solar.forecastSolarKw({ shortwaveRadiation: rad } as never, new Date('2026-07-15T12:00:00Z'));
  for (const v of kw) assert.ok(v <= KWP + 1e-6, `no value exceeds kWp cap, got ${v}`);
  cleanup();
});

test('back-compat: hydrates an old scalar-only (v1) model file', async () => {
  cleanup();
  // No history so nothing gets re-learned; only the persisted v1 file drives the PR.
  writeFileSync(HISTORY_FILE, JSON.stringify({ v: 1, days: {} }), 'utf8');
  const v1 = {
    v: 1,
    months: { '2026-07': { pr: 0.7, days: 20 } },
    ingested: ['2026-07-01'],
  };
  writeFileSync(MODEL_FILE, JSON.stringify(v1), 'utf8');
  const solar = await freshModel();
  const eff = solar.effectivePR('2026-07');
  // Scalar PR preserved (fully confident → ~0.7), and no crash reading the old shape.
  assert.ok(Math.abs(eff.prEff - 0.7) < 0.05, `v1 scalar PR preserved, got ${eff.prEff}`);
  // roofShape falls back to the scalar prEff for every hour (hourlyDays seeded to 0).
  const shape = solar.roofShapeForMonth('2026-07');
  assert.ok(Math.abs(shape[13] - eff.prEff) < 1e-6, `hydrated shape falls back to prEff, got ${shape[13]}`);
  cleanup();
});
