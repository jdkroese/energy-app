// Water section routes (docs/52). GATED: GET /api/water always returns a well-shaped
// payload (configured:false + empty-but-shaped data) when Contazara isn't configured —
// never a 500 — so the web onboarding screen has something to render immediately.

import * as store from '../store';
import * as contazara from '../connectors/contazara';
import { contazaraConfig, type ContazaraConfig } from '../runtime-config';
import { readHourly, readDaily, readWaterAttribution, readZoneFlow, lastPollStatus, pollNowForTest, resetBackfill, backfillStatus } from '../control/water-history';
import { MIN_TRUSTED_SAMPLES } from '../control/water-attribution';
import { projectMonthM3, activeWaterAlerts } from '../control/water-detectors';
import { costFor, bandFor, bandCliff } from '../control/water-tariff';
import { billingPeriodFor, projectPeriodM3 } from '../control/water-billing';
import { madridDayKey, madridLocalToEpochSec } from '../connectors/contazara';
import type { WaterThresholds, WaterTariff } from '../store';

function badInput(msg: string): never {
  const e = new Error(msg) as Error & { code?: string };
  e.code = 'BAD_INPUT';
  throw e;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ---- Madrid calendar helpers (mirrors routes/history.ts's period-navigator pattern) ----

const TZ = 'Europe/Madrid';
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function madridCal(d: Date): { y: number; m: number; day: number; wd: number } {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  const wmap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { y: Number(g('year')), m: Number(g('month')), day: Number(g('day')), wd: wmap[g('weekday')] ?? 1 };
}

const DAY_MS = 86_400_000;

export type WaterRange = 'day' | 'week' | 'month' | 'year';
export const MAX_BACK: Record<WaterRange, number> = { day: 60, week: 26, month: 24, year: 5 };

interface PeriodWindow {
  fromSec: number;
  toSec: number;
  label: string;
}

/** The [fromSec,toSec] window + display label for a range+offset (0 = current period,
 *  negative = into the past). Offset/MAX_BACK semantics mirror routes/history.ts. */
function periodWindow(range: WaterRange, offset: number): PeriodWindow {
  const today = madridCal(new Date());

  if (range === 'year') {
    const y = today.y + offset;
    return {
      fromSec: madridLocalToEpochSec(y, 1, 1, 0, 0, 0),
      toSec: madridLocalToEpochSec(y, 12, 31, 23, 59, 59),
      label: String(y),
    };
  }
  if (range === 'month') {
    const base = today.m - 1 + offset;
    const y = today.y + Math.floor(base / 12);
    const m = (((base % 12) + 12) % 12) + 1;
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return {
      fromSec: madridLocalToEpochSec(y, m, 1, 0, 0, 0),
      toSec: madridLocalToEpochSec(y, m, lastDay, 23, 59, 59),
      label: `${MONTHS[m - 1]} ${y}`,
    };
  }
  const anchorMs = madridLocalToEpochSec(today.y, today.m, today.day, 12, 0, 0) * 1000;
  if (range === 'day') {
    const c = madridCal(new Date(anchorMs + offset * DAY_MS));
    return {
      fromSec: madridLocalToEpochSec(c.y, c.m, c.day, 0, 0, 0),
      toSec: madridLocalToEpochSec(c.y, c.m, c.day, 23, 59, 59),
      label: `${WD[c.wd]} ${c.day} ${MONTHS[c.m - 1]} ${c.y}`,
    };
  }
  // week — Monday..Sunday, shifted by `offset` weeks.
  const isoWd = today.wd === 0 ? 7 : today.wd;
  const mondayMs = anchorMs + (offset * 7 - (isoWd - 1)) * DAY_MS;
  const monday = madridCal(new Date(mondayMs));
  const sunday = madridCal(new Date(mondayMs + 6 * DAY_MS));
  const label =
    monday.m === sunday.m
      ? `${monday.day}–${sunday.day} ${MONTHS[monday.m - 1]} ${monday.y}`
      : `${monday.day} ${MONTHS[monday.m - 1]} – ${sunday.day} ${MONTHS[sunday.m - 1]} ${sunday.y}`;
  return {
    fromSec: madridLocalToEpochSec(monday.y, monday.m, monday.day, 0, 0, 0),
    toSec: madridLocalToEpochSec(sunday.y, sunday.m, sunday.day, 23, 59, 59),
    label,
  };
}

// ---- Attribution helpers -------------------------------------------------------

interface Split {
  totalL: number;
  householdL: number;
  irrigationL: number;
  unexplainedL: number;
}

/** Sum attribution rows in [fromSec,toSec]; falls back to household=total when there's
 *  no attribution coverage for the window (older-than-hourly-retention history). */
function splitFor(fromSec: number, toSec: number, totalL: number): Split {
  const rows = readWaterAttribution(fromSec, toSec);
  if (rows.length === 0) return { totalL, householdL: totalL, irrigationL: 0, unexplainedL: 0 };
  const irrigationL = rows.reduce((s, r) => s + r.irrigationL, 0);
  const householdL = rows.reduce((s, r) => s + r.householdL, 0);
  const unexplainedL = rows.reduce((s, r) => s + r.unexplainedL, 0);
  return { totalL, householdL, irrigationL, unexplainedL };
}

// ---- Empty (not-configured) shapes, so the web onboarding state always has data ----

function emptyGetWater(lastError: string | null): unknown {
  return {
    ts: new Date().toISOString(),
    configured: false,
    connected: false,
    lastError,
    meter: { serial: null, model: null, address: null, indexL: null, lastReadingIso: null, staleHours: null },
    today: { dateIso: madridDayKey(new Date()), totalL: 0, householdL: 0, irrigationL: 0, unexplainedL: 0, hours: [] },
    quietHour: { lowestLph: null, atHour: null, hoursSinceBelowFloor: null, floorLph: store.get().water.thresholds.quietHourFloorLph, ok: true },
    month: { m3: 0, householdM3: 0, irrigationM3: 0, unexplainedM3: 0, expectedM3: 0, costEur: 0, budgetM3: store.get().water.thresholds.monthlyBudgetM3, projectedM3: 0 },
    zones: [],
    activeAlerts: [],
  };
}

// ---- GET /api/water -------------------------------------------------------------

export async function getWater(): Promise<unknown> {
  const cfg = contazaraConfig();
  const poll = lastPollStatus();
  if (!cfg) return emptyGetWater(null);

  const now = new Date();
  const nowSec = Math.floor(now.getTime() / 1000);
  const t: WaterThresholds = store.get().water.thresholds;

  // Meter info (best-effort live snapshot; the poll/DB path is authoritative for history).
  const snap = await contazara.getSnapshot().catch(() => null);
  const meter = snap?.meter ?? null;
  const lastReadingIso = meter?.lastReading ? isoFromRaw(meter.lastReading) : null;
  const staleHours = lastReadingIso ? round1((now.getTime() - Date.parse(lastReadingIso)) / 3600_000) : null;

  // Today.
  const todayKey = madridDayKey(now);
  const [ty, tm, td] = todayKey.split('-').map(Number);
  const todayFromSec = madridLocalToEpochSec(ty, tm, td, 0, 0, 0);
  const todayHourly = readHourly(todayFromSec, nowSec);
  const todayAttrib = readWaterAttribution(todayFromSec, nowSec);
  const attribByHour = new Map(todayAttrib.map((a) => [a.bucketTs, a]));
  const hours = [];
  for (let h = 0; h < 24; h++) {
    const bucketTs = todayFromSec + h * 3600;
    const hourly = todayHourly.find((x) => x.bucketTs === bucketTs);
    const a = attribByHour.get(bucketTs);
    hours.push({
      h,
      totalL: hourly ? round1(hourly.litres) : 0,
      householdL: a ? round1(a.householdL) : hourly ? round1(hourly.litres) : 0,
      irrigationL: a ? round1(a.irrigationL) : 0,
      unexplainedL: a ? round1(a.unexplainedL) : 0,
      reported: Boolean(hourly),
    });
  }
  const todayTotalL = todayHourly.reduce((s, x) => s + x.litres, 0);
  const todaySplit = splitFor(todayFromSec, nowSec, todayTotalL);

  // Quiet hour — scan the trailing 7 days for the lowest hourly reading + how long ago the
  // house last dropped to/below the floor (the leak signal's own raw numbers, docs/52 §1).
  const trailing = readHourly(nowSec - 7 * 86_400, nowSec);
  let lowestLph: number | null = null;
  let atHour: number | null = null;
  let hoursSinceBelowFloor: number | null = null;
  for (const b of trailing) {
    if (lowestLph === null || b.litres < lowestLph) {
      lowestLph = b.litres;
      atHour = hourOfDayMadrid(b.bucketTs);
    }
  }
  for (let i = trailing.length - 1; i >= 0; i--) {
    if (trailing[i].litres <= t.quietHourFloorLph) {
      hoursSinceBelowFloor = round1((nowSec - trailing[i].bucketTs) / 3600);
      break;
    }
  }
  const quietHour = {
    lowestLph: lowestLph === null ? null : round1(lowestLph),
    atHour,
    hoursSinceBelowFloor,
    floorLph: t.quietHourFloorLph,
    ok: hoursSinceBelowFloor === null ? trailing.length < t.continuousFlowHours : hoursSinceBelowFloor <= t.continuousFlowHours,
  };

  // Month.
  const daysInMonth = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  const monthFromKey = `${ty}-${String(tm).padStart(2, '0')}-01`;
  const monthDaily = readDaily(monthFromKey, todayKey);
  const monthToDateL = monthDaily.reduce((s, d) => s + d.litres, 0);
  const monthFromSec = madridLocalToEpochSec(ty, tm, 1, 0, 0, 0);
  const monthSplit = splitFor(monthFromSec, nowSec, monthToDateL);
  const projectedM3 = round3(projectMonthM3(monthToDateL, td, daysInMonth));
  const budgetM3 = t.monthlyBudgetM3;
  const expectedM3 = round3((budgetM3 * td) / daysInMonth);
  const tariff = store.get().water.tariff;
  const costEur = costFor(monthToDateL / 1000, tariff).totalEur;

  // Zones.
  const flow = readZoneFlow();
  const overrides = store.get().water.zoneFlowOverrides;
  const irrZones = store.get().irrigation?.zones ?? {};
  const zoneIds = new Set([...Object.keys(flow), ...Object.keys(overrides)]);
  const zones = [...zoneIds].map((id) => {
    const f = flow[id];
    const lpm = overrides[id] ?? f?.lpm ?? null;
    return {
      id,
      name: irrZones[id]?.name ?? id,
      lpm: lpm === null ? null : round1(lpm),
      samples: f?.samples ?? 0,
      learned: Boolean(f && f.samples >= MIN_TRUSTED_SAMPLES) && overrides[id] === undefined,
    };
  });

  /* ---- Billing period (docs/52) --------------------------------------------
   * AMJASA bills bimonthly and prices EVERY m³ at the band the period total reaches,
   * so the calendar month is the wrong unit here: the band — and therefore the price of
   * ALL the water — is decided across two months. Project it early enough to still act. */
  const wcfg = store.get().water;
  const bp = billingPeriodFor(now, wcfg.billingAnchorDay, wcfg.tariff.periodMonths);
  const periodDaily = readDaily(bp.startDay, todayKey);
  const periodL = periodDaily.reduce((sum, d) => sum + d.litres, 0);
  const periodM3 = periodL / 1000;
  const projectedPeriodM3 = projectPeriodM3(periodM3, bp);
  const cliff = bandCliff(projectedPeriodM3, wcfg.tariff);
  const period = {
    startIso: bp.startDay,
    endIso: bp.endDay,
    months: bp.months,
    daysElapsed: bp.daysElapsed,
    daysTotal: bp.daysTotal,
    m3ToDate: round3(periodM3),
    projectedM3: projectedPeriodM3,
    bandRateEurM3: bandFor(projectedPeriodM3, wcfg.tariff).block.eurM3,
    projectedCostEur: costFor(projectedPeriodM3, wcfg.tariff, bp.months).totalEur,
    cliff: {
      m3ToNextBandDown: cliff.m3ToNextBandDown,
      savingEur: cliff.savingEur,
      nextM3CostEur: cliff.nextM3CostEur,
    },
  };

  return {
    ts: now.toISOString(),
    configured: true,
    connected: poll.ok,
    lastError: poll.error || null,
    meter: {
      serial: meter?.serialNumber ?? cfg.serial,
      model: meter?.model ?? null,
      address: meter?.address ?? null,
      indexL: meter?.indexVol ?? null,
      lastReadingIso,
      staleHours,
    },
    today: {
      dateIso: todayKey,
      totalL: round1(todaySplit.totalL),
      householdL: round1(todaySplit.householdL),
      irrigationL: round1(todaySplit.irrigationL),
      unexplainedL: round1(todaySplit.unexplainedL),
      hours,
    },
    quietHour,
    period,
    month: {
      m3: round3(monthToDateL / 1000),
      householdM3: round3(monthSplit.householdL / 1000),
      irrigationM3: round3(monthSplit.irrigationL / 1000),
      unexplainedM3: round3(monthSplit.unexplainedL / 1000),
      expectedM3,
      costEur,
      budgetM3,
      projectedM3,
    },
    zones,
    activeAlerts: activeWaterAlerts().map((a) => ({ id: a.id, rule: a.rule, severity: a.severity, title: a.title, sub: a.sub, sinceIso: a.sinceIso })),
  };
}

function hourOfDayMadrid(bucketTs: number): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(new Date(bucketTs * 1000)));
}

/** meter.lastReading is the raw "YYYYMMDDHHmmss" string — reuse the connector's parser. */
function isoFromRaw(raw: string): string | null {
  const parsed = contazara.parseMeterTimestamp(raw);
  return parsed ? new Date(parsed.epochSec * 1000).toISOString() : null;
}

// ---- GET /api/water/history -------------------------------------------------------

function daypartOf(hour: number): 'night' | 'morning' | 'afternoon' | 'evening' {
  if (hour < 6) return 'night';
  if (hour < 12) return 'morning';
  if (hour < 18) return 'afternoon';
  return 'evening';
}

export function getWaterHistory(rangeRaw: unknown, offsetRaw: unknown): unknown {
  const range: WaterRange = ['day', 'week', 'month', 'year'].includes(String(rangeRaw)) ? (String(rangeRaw) as WaterRange) : 'day';
  const offset = Math.max(-MAX_BACK[range], Math.min(0, Math.round(Number(offsetRaw) || 0)));
  const win = periodWindow(range, offset);
  const cfg = contazaraConfig();

  if (!cfg) {
    return {
      ts: new Date().toISOString(),
      range,
      offset,
      label: win.label,
      labels: [],
      series: { total: [], household: [], irrigation: [], unexplained: [] },
      cumulative: { actual: [], expected: [] },
      dayparts: { night: [], morning: [], afternoon: [], evening: [] },
      nightBaseline: [],
      totals: { totalL: 0, householdL: 0, irrigationL: 0, unexplainedL: 0, costEur: 0 },
    };
  }

  const t = store.get().water.thresholds;
  const tariff = store.get().water.tariff;

  // Label-buckets: day -> 24 hourly; week/month -> daily; year -> monthly.
  const labels: string[] = [];
  const total: number[] = [];
  const household: number[] = [];
  const irrigation: number[] = [];
  const unexplained: number[] = [];
  const nightBaseline: number[] = [];
  const dayparts = { night: [] as number[], morning: [] as number[], afternoon: [] as number[], evening: [] as number[] };

  if (range === 'day') {
    const hourly = readHourly(win.fromSec, win.toSec);
    const byTs = new Map(hourly.map((h) => [h.bucketTs, h.litres]));
    for (let h = 0; h < 24; h++) {
      const bucketTs = win.fromSec + h * 3600;
      const litres = byTs.get(bucketTs) ?? 0;
      const split = splitFor(bucketTs, bucketTs + 3599, litres);
      labels.push(`${String(h).padStart(2, '0')}:00`);
      total.push(round1(split.totalL));
      household.push(round1(split.householdL));
      irrigation.push(round1(split.irrigationL));
      unexplained.push(round1(split.unexplainedL));
      const dp = daypartOf(h);
      for (const k of Object.keys(dayparts) as Array<keyof typeof dayparts>) dayparts[k].push(k === dp ? round1(litres) : 0);
      nightBaseline.push(dp === 'night' ? round1(Math.max(0, litres - split.irrigationL)) : 0);
    }
  } else {
    const daily = readDaily(dayKeyOf(win.fromSec), dayKeyOf(win.toSec));
    const byDay = new Map(daily.map((d) => [d.day, d.litres]));
    if (range === 'year') {
      // Aggregate daily rows into 12 monthly buckets.
      const [y] = dayKeyOf(win.fromSec).split('-').map(Number);
      for (let m = 1; m <= 12; m++) {
        const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
        const fromSec = madridLocalToEpochSec(y, m, 1, 0, 0, 0);
        const toSec = madridLocalToEpochSec(y, m, lastDay, 23, 59, 59);
        let litres = 0;
        for (const [day, l] of byDay) {
          const [dy, dm] = day.split('-').map(Number);
          if (dy === y && dm === m) litres += l;
        }
        const split = splitFor(fromSec, toSec, litres);
        labels.push(MONTHS[m - 1]);
        total.push(round1(split.totalL));
        household.push(round1(split.householdL));
        irrigation.push(round1(split.irrigationL));
        unexplained.push(round1(split.unexplainedL));
        const dp = daypartsForRange(fromSec, toSec);
        dayparts.night.push(round1(dp.night));
        dayparts.morning.push(round1(dp.morning));
        dayparts.afternoon.push(round1(dp.afternoon));
        dayparts.evening.push(round1(dp.evening));
        nightBaseline.push(round1(dp.nightUnexplained));
      }
    } else {
      // week/month — one bucket per day.
      let cursorSec = win.fromSec;
      while (cursorSec <= win.toSec) {
        const day = dayKeyOf(cursorSec);
        const litres = byDay.get(day) ?? 0;
        const dayFromSec = cursorSec;
        const dayToSec = Math.min(cursorSec + 86_400 - 1, win.toSec);
        const split = splitFor(dayFromSec, dayToSec, litres);
        labels.push(day.slice(5)); // MM-DD
        total.push(round1(split.totalL));
        household.push(round1(split.householdL));
        irrigation.push(round1(split.irrigationL));
        unexplained.push(round1(split.unexplainedL));
        const dp = daypartsForRange(dayFromSec, dayToSec);
        dayparts.night.push(round1(dp.night));
        dayparts.morning.push(round1(dp.morning));
        dayparts.afternoon.push(round1(dp.afternoon));
        dayparts.evening.push(round1(dp.evening));
        nightBaseline.push(round1(dp.nightUnexplained));
        cursorSec += 86_400;
      }
    }
  }

  // Cumulative actual vs an evenly-paced expected line toward the monthly budget
  // (scaled to however many buckets this range/period holds). Documented approximation —
  // "expected" is a flat pace toward the budget, not a learned seasonal curve.
  let running = 0;
  const actualCum = total.map((v) => (running += v));
  const dailyBudgetL = (t.monthlyBudgetM3 * 1000) / 30;
  let expectedPerBucket: number;
  if (range === 'day') expectedPerBucket = dailyBudgetL / 24;
  else if (range === 'week') expectedPerBucket = dailyBudgetL;
  else if (range === 'month') expectedPerBucket = dailyBudgetL;
  else expectedPerBucket = dailyBudgetL * 30; // year -> per month
  const expectedCum = total.map((_, i) => round1(expectedPerBucket * (i + 1)));

  const totalL = total.reduce((s, v) => s + v, 0);
  const householdL = household.reduce((s, v) => s + v, 0);
  const irrigationL = irrigation.reduce((s, v) => s + v, 0);
  const unexplainedL = unexplained.reduce((s, v) => s + v, 0);

  return {
    ts: new Date().toISOString(),
    range,
    offset,
    label: win.label,
    labels,
    series: { total, household, irrigation, unexplained },
    cumulative: { actual: actualCum.map(round1), expected: expectedCum },
    dayparts,
    nightBaseline,
    totals: {
      totalL: round1(totalL),
      householdL: round1(householdL),
      irrigationL: round1(irrigationL),
      unexplainedL: round1(unexplainedL),
      costEur: costFor(totalL / 1000, tariff).totalEur,
    },
  };
}

function dayKeyOf(sec: number): string {
  return madridDayKey(new Date(sec * 1000));
}

/** Split a [fromSec,toSec] span's litres into the 4 dayparts using stored hourly rows
 *  (falls back to all-zero when no hourly coverage — e.g. a day older than the hourly
 *  backfill/retention window). Also returns the night slot's unexplained residual. */
function daypartsForRange(fromSec: number, toSec: number): { night: number; morning: number; afternoon: number; evening: number; nightUnexplained: number } {
  const hourly = readHourly(fromSec, toSec);
  const out = { night: 0, morning: 0, afternoon: 0, evening: 0, nightUnexplained: 0 };
  if (hourly.length === 0) return out;
  let nightMeasured = 0;
  for (const h of hourly) {
    const hod = hourOfDayMadrid(h.bucketTs);
    out[daypartOf(hod)] += h.litres;
    if (hod < 6) nightMeasured += h.litres;
  }
  const nightAttrib = readWaterAttribution(fromSec, fromSec + 6 * 3600 - 1);
  const nightIrrigation = nightAttrib.reduce((s, a) => s + a.irrigationL, 0);
  out.nightUnexplained = Math.max(0, nightMeasured - nightIrrigation);
  return out;
}

// ---- Settings ---------------------------------------------------------------

export function getWaterSettings(): unknown {
  const w = store.get().water;
  const i = store.get().integrations?.contazara;
  return {
    ts: new Date().toISOString(),
    thresholds: w.thresholds,
    tariff: w.tariff,
    billingAnchorDay: w.billingAnchorDay,
    history: w.history,
    backfill: backfillStatus(),
    hasPassword: Boolean(i?.password),
    email: i?.email?.trim() || '',
    serial: i?.serial?.trim() || '',
    pollHours: contazaraConfig()?.pollHours ?? i?.pollHours ?? 6,
  };
}

export function setWaterSettings(body: unknown): unknown {
  const b = (body ?? {}) as {
    thresholds?: Partial<WaterThresholds>;
    tariff?: Partial<WaterTariff>;
    billingAnchorDay?: string;
    history?: Partial<store.WaterHistoryConfig>;
  };
  const water = store.update((s) => {
    if (b.thresholds) {
      const th = b.thresholds;
      const c = s.water.thresholds;
      if (isNum(th.quietHourFloorLph)) c.quietHourFloorLph = clamp(th.quietHourFloorLph, 0, 200);
      if (isNum(th.continuousFlowHours)) c.continuousFlowHours = clamp(th.continuousFlowHours, 1, 168);
      if (isNum(th.nightToleranceL)) c.nightToleranceL = clamp(th.nightToleranceL, 0, 5000);
      if (isNum(th.monthlyBudgetM3)) c.monthlyBudgetM3 = clamp(th.monthlyBudgetM3, 1, 2000);
      if (isNum(th.dailySpikeFactor)) c.dailySpikeFactor = clamp(th.dailySpikeFactor, 1, 20);
      if (isNum(th.meterSilentHours)) c.meterSilentHours = clamp(th.meterSilentHours, 1, 720);
    }
    if (b.tariff) {
      const tf = b.tariff;
      const c = s.water.tariff;
      if (isNum(tf.periodMonths)) c.periodMonths = clamp(tf.periodMonths, 1, 12);
      if (tf.blockMode === 'all-at-last' || tf.blockMode === 'progressive') c.blockMode = tf.blockMode;
      if (isNum(tf.supplyFixedEurPeriod)) c.supplyFixedEurPeriod = clamp(tf.supplyFixedEurPeriod, 0, 1000);
      if (isNum(tf.sanitationFixedEurPeriod)) c.sanitationFixedEurPeriod = clamp(tf.sanitationFixedEurPeriod, 0, 1000);
      if (isNum(tf.sanitationEurM3)) c.sanitationEurM3 = clamp(tf.sanitationEurM3, 0, 100);
      if (isNum(tf.ivaPct)) c.ivaPct = clamp(tf.ivaPct, 0, 100);
      // Blocks are replaced wholesale (not merged) — a partial merge could leave the
      // list unordered or without an open-ended final block, which would silently stop
      // billing above the last bound. Normalised on read by hydrateWater().
      if (Array.isArray(tf.supplyBlocks) && tf.supplyBlocks.length > 0) {
        const bounded = tf.supplyBlocks
          .filter((x) => x && typeof x === 'object' && isNum(x.eurM3))
          .map((x) => ({
            upToM3: isNum(x.upToM3) && x.upToM3 > 0 ? clamp(x.upToM3, 0, 100000) : null,
            eurM3: clamp(x.eurM3, 0, 100),
          }));
        if (bounded.length > 0) {
          const withBound = bounded.filter((x) => x.upToM3 !== null).sort((a, z) => (a.upToM3 as number) - (z.upToM3 as number));
          const open = bounded.find((x) => x.upToM3 === null) ?? { upToM3: null, eurM3: bounded[bounded.length - 1].eurM3 };
          c.supplyBlocks = [...withBound, open];
        }
      }
    }
    if (typeof b.billingAnchorDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.billingAnchorDay)) {
      s.water.billingAnchorDay = b.billingAnchorDay;
    }
    if (b.history) {
      const h = b.history;
      const c = s.water.history;
      if (isNum(h.backfillDailyMonths)) c.backfillDailyMonths = clamp(h.backfillDailyMonths, 1, 120);
      if (isNum(h.backfillHourlyDays)) c.backfillHourlyDays = clamp(h.backfillHourlyDays, 1, 1000);
      if (isNum(h.retainHourlyDays)) c.retainHourlyDays = clamp(h.retainHourlyDays, 7, 3650);
    }
    return s.water;
  });
  return { ok: true, detail: 'water settings saved', water };
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// ---- Integrations: connect / test --------------------------------------------

/** Build a candidate config from raw input, keeping the stored password when omitted
 *  (write-only field — never echoed back). Mirrors isolarcloudCandidate(). */
function contazaraCandidate(raw: Record<string, unknown>): ContazaraConfig {
  const cur = store.get().integrations?.contazara ?? {};
  const str = (v: unknown, keep: string | undefined) => {
    const s = v === undefined || v === null ? '' : String(v).trim();
    return s || (keep ?? '');
  };
  const pollHoursRaw = raw.pollHours;
  const pollHours = isNum(pollHoursRaw) ? clamp(pollHoursRaw, 1, 24) : (cur.pollHours ?? 6);
  return {
    email: str(raw.email, cur.email),
    password: raw.password ? String(raw.password) : (cur.password ?? ''),
    serial: str(raw.serial, cur.serial),
    pollHours,
  };
}

function requireComplete(c: ContazaraConfig): void {
  const missing: string[] = [];
  if (!c.email) missing.push('email');
  if (!c.password) missing.push('password');
  if (!c.serial) missing.push('meter serial');
  if (missing.length) badInput(`Missing ${missing.join(', ')}`);
}

/** POST /api/integrations/water/test → full read-chain diagnostic, never persists. */
export async function testContazara(raw?: unknown): Promise<unknown> {
  const c = contazaraCandidate((raw ?? {}) as Record<string, unknown>);
  requireComplete(c);
  const { ok, detail, meter } = await contazara.diagnose(c);
  return { ok, detail, meter };
}

/** POST /api/integrations/water → validate then persist (admin only). */
export async function setContazara(raw?: unknown): Promise<unknown> {
  const input = (raw ?? {}) as Record<string, unknown>;
  const c = contazaraCandidate(input);
  requireComplete(c);
  const probe = await contazara.probe(c);
  if (!probe.ok) badInput(`Contazara did not authenticate — ${probe.detail}`);
  store.update((s) => {
    s.integrations = s.integrations ?? { intesis: null };
    s.integrations.contazara = { email: c.email, password: c.password, serial: c.serial, pollHours: c.pollHours };
  });
  // Kick an immediate poll in the background so the owner sees data without waiting for
  // the next scheduled cycle. Best-effort; never blocks the response.
  void pollNowForTest().catch((e) => console.error('[water] post-connect poll failed:', (e as Error).message));
  return { ok: true, detail: probe.detail };
}

/** POST /api/water/history/reimport — pull history again with the current window. */
export function reimportWaterHistory(): unknown {
  if (!contazaraConfig()) badInput('Connect the BI-WATER account first');
  return resetBackfill();
}
