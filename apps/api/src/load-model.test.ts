// Unit tests for the learned consumption forecast — run with the Node built-in
// test runner via tsx:
//   node --import tsx --test src/load-model.test.ts
//
// Hermetic: HISTORY_5M_FILE is pointed at a throwaway scratchpad path BEFORE
// importing the module under test, so it reads only our synthetic history.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SCRATCH = resolve(
  'C:/Users/Joris/AppData/Local/Temp/claude/E--Claude-Energy-app/cbb3ae32-8ac8-4283-92f0-665deb3c1d62/scratchpad',
);
if (!existsSync(SCRATCH)) mkdirSync(SCRATCH, { recursive: true });
const HISTORY_FILE = resolve(SCRATCH, `lm-history-${process.pid}.json`);

const BUCKETS = 288;

/** True when a Madrid date key (YYYY-MM-DD) is Sat/Sun. */
function isWeekend(dateKey: string): boolean {
  const day = new Date(`${dateKey}T12:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
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

/**
 * Write a synthetic history where every hour's homeKw is `weekdayKw` on weekdays
 * and `weekendKw` on weekends, over the given day keys.
 */
function writeHistory(days: string[], weekdayKw: number, weekendKw: number): void {
  const file = { v: 1, days: {} as Record<string, ReturnType<typeof blankDay>> };
  for (const key of days) {
    const day = blankDay(key);
    const kw = isWeekend(key) ? weekendKw : weekdayKw;
    for (let b = 0; b < BUCKETS; b++) day.series.homeKw[b] = kw;
    file.days[key] = day;
  }
  writeFileSync(HISTORY_FILE, JSON.stringify(file), 'utf8');
}

/** A run of consecutive calendar days ending 2026-07-28 (a Tuesday). */
function recentDays(n: number): string[] {
  const out: string[] = [];
  const end = Date.UTC(2026, 6, 28);
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(end - i * 86400000);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

async function freshModel(): Promise<typeof import('./load-model')> {
  process.env.HISTORY_5M_FILE = HISTORY_FILE;
  // Drop the shared history5m singleton so it re-reads the file we just wrote.
  const history = await import('./history5m');
  history._resetForTest();
  const bust = `?t=${Date.now()}-${Math.random()}`;
  return (await import(`./load-model${bust}`)) as typeof import('./load-model');
}
function cleanup(): void {
  if (existsSync(HISTORY_FILE)) rmSync(HISTORY_FILE);
}

// A known weekday / weekend date to forecast for (July 2026).
const A_WEEKDAY = new Date('2026-07-15T12:00:00Z'); // Wednesday
const A_WEEKEND = new Date('2026-07-18T12:00:00Z'); // Saturday

test('falls back to the base curve with no history', async () => {
  cleanup();
  writeHistory([], 0, 0); // empty days map
  const lm = await freshModel();
  const load = lm.forecastLoadKw(A_WEEKDAY, null);
  assert.equal(load.length, 24);
  // With zero learned days the forecast equals the hardcoded base curve.
  for (let h = 0; h < 24; h++) {
    assert.ok(Math.abs(load[h] - lm.BASE_LOAD_KW[h]) < 1e-6, `hour ${h} equals base`);
  }
  cleanup();
});

test('learned blend pulls the forecast toward measured with enough days', async () => {
  cleanup();
  // 20 recent days at a flat 3.0 kW — well past the 14-day full-confidence point.
  writeHistory(recentDays(20), 3.0, 3.0);
  const lm = await freshModel();
  const load = lm.forecastLoadKw(A_WEEKDAY, null);
  // A base hour far from 3.0 (e.g. the 0.5 kW overnight trough) should be dragged
  // most of the way to 3.0 at full confidence.
  assert.ok(load[3] > 2.7, `overnight hour pulled toward learned 3.0, got ${load[3]}`);
  cleanup();
});

test('confidence ramps: fewer days blend less toward learned', async () => {
  cleanup();
  writeHistory(recentDays(3), 3.0, 3.0); // only 3 weekday-ish days → low confidence
  const lm = await freshModel();
  const lowConf = lm.forecastLoadKw(A_WEEKDAY, null);
  cleanup();

  writeHistory(recentDays(20), 3.0, 3.0); // many days → high confidence
  const lm2 = await freshModel();
  const highConf = lm2.forecastLoadKw(A_WEEKDAY, null);
  // Both learn the same 3.0 kW target, but the high-confidence forecast should be
  // closer to it than the low-confidence one at the overnight trough.
  const target = 3.0;
  assert.ok(
    Math.abs(highConf[3] - target) < Math.abs(lowConf[3] - target),
    `more days → closer to learned target (${highConf[3]} vs ${lowConf[3]})`,
  );
  cleanup();
});

test('weekday and weekend profiles differ', async () => {
  cleanup();
  // Distinct weekday vs weekend levels; enough of each day-type for confidence.
  writeHistory(recentDays(28), 2.0, 5.0);
  const lm = await freshModel();
  const wd = lm.forecastLoadKw(A_WEEKDAY, null);
  const we = lm.forecastLoadKw(A_WEEKEND, null);
  // The weekend forecast should sit clearly above the weekday one where learned.
  assert.ok(we[13] > wd[13] + 1.0, `weekend (${we[13]}) exceeds weekday (${wd[13]})`);
  cleanup();
});

test('thermal nudge adds cooling load above 26 C', async () => {
  cleanup();
  writeHistory([], 0, 0);
  const lm = await freshModel();
  const temp = new Array<number>(24).fill(30); // hot day, +0.4 kW/hour (0.1×4)
  const cool = lm.forecastLoadKw(A_WEEKDAY, temp);
  const neutral = lm.forecastLoadKw(A_WEEKDAY, null);
  assert.ok(cool[13] > neutral[13], `cooling nudge raises load (${cool[13]} > ${neutral[13]})`);
  cleanup();
});
