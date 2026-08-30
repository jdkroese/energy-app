// Water observation detectors (docs/52 P2) — follows the monitors.ts edge-state pattern:
// hysteresis-free but MIN-DWELL-free too here, because each condition already encodes its
// own persistence requirement (a trailing-N-hours window, a full night, a full month-to-
// date) — see the pure condition functions below. Active/cleared events are paired by
// relatedId exactly like monitors.ts. READ-ONLY: reads the water SQLite store + config and
// emits events; touches no control logic and NEVER throws (runWaterDetectors is the single
// entry point, called after every successful water poll — new hourly data only).

import { logEvent } from '../events';
import * as store from '../store';
import type { WaterThresholds } from '../store';
import { readHourly, readDaily, readWaterAttribution, latestHourlyTs } from './water-history';
import { madridDayKey, madridLocalToEpochSec } from '../connectors/contazara';

// ---- Pure conditions (unit-testable) -----------------------------------------

/** True when NONE of the trailing hourly readings dropped to/below the quiet-hour floor —
 *  i.e. the house never went quiet, the leak detector's flagship signal (docs/52 §1). */
export function continuousFlowCondition(trailingHourlyLitres: number[], floorLph: number): boolean {
  if (trailingHourlyLitres.length === 0) return false;
  return trailingHourlyLitres.every((l) => l > floorLph);
}

/** Night-use condition: night-slot litres AFTER subtracting attributed irrigation exceed
 *  tolerance. A watering night has nightAttributedIrrigationL ≈ nightMeasuredL, so the
 *  residual stays low and this does NOT fire — the false-positive suppression the owner
 *  asked for (docs/52). An equivalent UNattributed night (irrigation = 0) fires. */
export function nightUseCondition(nightMeasuredL: number, nightAttributedIrrigationL: number, toleranceL: number): boolean {
  return Math.max(0, nightMeasuredL - nightAttributedIrrigationL) > toleranceL;
}

/** Daily-spike condition: a day's UNEXPLAINED litres exceed `factor` × the trailing
 *  30-day median of unexplained-per-day. A thin history floors the median at `floorL`
 *  litres so day 1 of the feature can't spuriously fire on any nonzero residual. */
export function dailySpikeCondition(dayUnexplainedL: number, medianUnexplainedL30d: number, factor: number, floorL = 20): boolean {
  const denom = Math.max(medianUnexplainedL30d, floorL);
  return dayUnexplainedL > factor * denom;
}

/** Project the FULL month's m³ from the month-to-date total, evenly paced. */
export function projectMonthM3(monthToDateL: number, dayOfMonth: number, daysInMonth: number): number {
  if (dayOfMonth <= 0 || daysInMonth <= 0) return 0;
  return (monthToDateL / 1000) * (daysInMonth / dayOfMonth);
}

export function monthlyBudgetCondition(projectedM3: number, budgetM3: number): boolean {
  return projectedM3 > budgetM3;
}

/** Meter-silent condition: no new reading for `silentHours`. `lastReadingMs === null`
 *  (we've never had a reading) also counts as silent. */
export function meterSilentCondition(lastReadingMs: number | null, nowMs: number, silentHours: number): boolean {
  if (lastReadingMs === null) return true;
  return nowMs - lastReadingMs > silentHours * 3600_000;
}

// ---- Edge state (active/cleared paired by relatedId, mirrors monitors.ts) ----

export type WaterRuleId =
  | 'rule-water-continuous-flow'
  | 'rule-water-night-use'
  | 'rule-water-daily-spike'
  | 'rule-water-monthly-budget'
  | 'rule-water-meter-silent';

interface EdgeState {
  activeId: string | null;
  title: string;
  sub: string;
  severity: 'critical' | 'high' | 'medium';
  sinceIso: string | null;
}

const RULE_SEVERITY: Record<WaterRuleId, 'critical' | 'high' | 'medium'> = {
  'rule-water-continuous-flow': 'critical',
  'rule-water-night-use': 'high',
  'rule-water-daily-spike': 'medium',
  'rule-water-monthly-budget': 'medium',
  'rule-water-meter-silent': 'medium',
};

const edges: Record<WaterRuleId, EdgeState> = {
  'rule-water-continuous-flow': { activeId: null, title: '', sub: '', severity: 'critical', sinceIso: null },
  'rule-water-night-use': { activeId: null, title: '', sub: '', severity: 'high', sinceIso: null },
  'rule-water-daily-spike': { activeId: null, title: '', sub: '', severity: 'medium', sinceIso: null },
  'rule-water-monthly-budget': { activeId: null, title: '', sub: '', severity: 'medium', sinceIso: null },
  'rule-water-meter-silent': { activeId: null, title: '', sub: '', severity: 'medium', sinceIso: null },
};

/** TEST ONLY: reset all detector edge state. */
export function resetWaterDetectorsForTest(): void {
  for (const id of Object.keys(edges) as WaterRuleId[]) {
    edges[id] = { activeId: null, title: '', sub: '', severity: RULE_SEVERITY[id], sinceIso: null };
  }
}

function fireOrClear(
  ruleId: WaterRuleId,
  firing: boolean,
  title: string,
  sub: string,
  detail: string,
  clearedSummary: string,
): void {
  const edge = edges[ruleId];
  if (edge.activeId === null) {
    if (!firing) return;
    const ev = logEvent({
      class: 'observation',
      category: 'water',
      severity: RULE_SEVERITY[ruleId],
      summary: title,
      trigger: { source: 'threshold', detail: ruleId },
      device: 'Water meter',
      entity: ruleId,
      detail,
      state: 'active',
    });
    edge.activeId = ev.id;
    edge.title = title;
    edge.sub = sub;
    edge.sinceIso = ev.ts;
    return;
  }
  if (firing) {
    // Still firing — keep the sub/detail fresh without minting a new event.
    edge.title = title;
    edge.sub = sub;
    return;
  }
  const relatedId = edge.activeId;
  edge.activeId = null;
  edge.sinceIso = null;
  logEvent({
    class: 'observation',
    category: 'water',
    severity: 'low',
    summary: clearedSummary,
    trigger: { source: 'threshold', detail: 'condition cleared' },
    device: 'Water meter',
    entity: ruleId,
    detail: clearedSummary,
    state: 'cleared',
    relatedId,
  });
}

/** Currently-active water alerts, Alert-shaped for GET /api/water and evaluateLiveAlerts(). */
export interface WaterAlert {
  id: string;
  rule: WaterRuleId;
  severity: 'critical' | 'high' | 'medium';
  title: string;
  sub: string;
  sinceIso: string;
}

export function activeWaterAlerts(): WaterAlert[] {
  const out: WaterAlert[] = [];
  for (const id of Object.keys(edges) as WaterRuleId[]) {
    const e = edges[id];
    if (e.activeId && e.sinceIso) out.push({ id: e.activeId, rule: id, severity: e.severity, title: e.title, sub: e.sub, sinceIso: e.sinceIso });
  }
  return out;
}

// ---- Orchestrator (side-effecting; fail-soft) --------------------------------

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Most recently COMPLETED local day (yesterday, Madrid), as a YYYY-MM-DD key. */
function yesterdayKey(now: Date): string {
  return madridDayKey(new Date(now.getTime() - 86_400_000));
}

/** Run every water detector once against the current store. Best-effort; NEVER throws. */
export function runWaterDetectors(now: number = Date.now()): void {
  try {
    const t: WaterThresholds = store.get().water.thresholds;
    const nowDate = new Date(now);
    const nowSec = Math.floor(now / 1000);

    // ---- Continuous flow ----
    const trailingFrom = nowSec - t.continuousFlowHours * 3600;
    const trailing = readHourly(trailingFrom, nowSec);
    const trailingLitres = trailing.map((h) => h.litres);
    const cfFiring =
      trailingLitres.length >= t.continuousFlowHours && continuousFlowCondition(trailingLitres, t.quietHourFloorLph);
    const lowest = trailing.length > 0 ? Math.min(...trailingLitres) : 0;
    fireOrClear(
      'rule-water-continuous-flow',
      cfFiring,
      'Continuous flow — possible leak',
      `No hour below ${t.quietHourFloorLph} L/h for ${t.continuousFlowHours}h (lowest ${round1(lowest)} L/h)`,
      `Every hourly reading over the last ${t.continuousFlowHours}h exceeded the ${t.quietHourFloorLph} L/h quiet-hour floor — the house never went quiet.`,
      'Continuous flow cleared — the house went quiet again',
    );

    // ---- Night use (attribution-aware) ----
    const nightDayKey = yesterdayKey(nowDate);
    const [ny, nm, nd] = nightDayKey.split('-').map(Number);
    const nightFromSec = madridLocalToEpochSec(ny, nm, nd, 0, 0, 0);
    const nightToSec = nightFromSec + 6 * 3600 - 1; // 00:00–05:59 inclusive
    const nightHourly = readHourly(nightFromSec, nightToSec);
    const nightMeasuredL = nightHourly.reduce((s, h) => s + h.litres, 0);
    const nightAttrib = readWaterAttribution(nightFromSec, nightToSec);
    const nightIrrigationL = nightAttrib.reduce((s, a) => s + a.irrigationL, 0);
    const nuFiring = nightHourly.length > 0 && nightUseCondition(nightMeasuredL, nightIrrigationL, t.nightToleranceL);
    fireOrClear(
      'rule-water-night-use',
      nuFiring,
      'Unexplained night water use',
      `${round1(Math.max(0, nightMeasuredL - nightIrrigationL))} L overnight (00:00–05:59), above ${t.nightToleranceL} L after irrigation`,
      `Night slot (00:00–05:59, ${nightDayKey}) measured ${round1(nightMeasuredL)} L, ${round1(nightIrrigationL)} L attributed to irrigation, leaving ${round1(Math.max(0, nightMeasuredL - nightIrrigationL))} L unexplained.`,
      'Night use back to normal',
    );

    // ---- Daily spike (unattributed) ----
    const dayAttrib = readWaterAttribution(nightFromSec, nightFromSec + 86_400 - 1);
    const dayUnexplainedL = dayAttrib.reduce((s, a) => s + a.unexplainedL, 0);
    const histFrom = nightFromSec - 30 * 86_400;
    const histAttrib = readWaterAttribution(histFrom, nightFromSec - 1);
    const perDay = new Map<string, number>();
    for (const a of histAttrib) {
      const day = madridDayKey(new Date(a.bucketTs * 1000));
      perDay.set(day, (perDay.get(day) ?? 0) + a.unexplainedL);
    }
    const medianUnexplained = medianOf([...perDay.values()]);
    const dsFiring = dayAttrib.length > 0 && dailySpikeCondition(dayUnexplainedL, medianUnexplained, t.dailySpikeFactor);
    fireOrClear(
      'rule-water-daily-spike',
      dsFiring,
      'Unexplained daily spike',
      `${round1(dayUnexplainedL)} L unexplained on ${nightDayKey} (30-day median ${round1(medianUnexplained)} L)`,
      `${nightDayKey} unexplained litres (${round1(dayUnexplainedL)} L) exceeded ${t.dailySpikeFactor}× the 30-day median (${round1(medianUnexplained)} L).`,
      'Daily unexplained use back to normal',
    );

    // ---- Monthly budget (projection) ----
    const cal = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(nowDate)
      .split('-')
      .map(Number);
    const [cy, cm, cd] = cal;
    const daysInMonth = new Date(Date.UTC(cy, cm, 0)).getUTCDate();
    const monthFromKey = `${cy}-${String(cm).padStart(2, '0')}-01`;
    const monthToKey = madridDayKey(nowDate);
    const monthDaily = readDaily(monthFromKey, monthToKey);
    const monthToDateL = monthDaily.reduce((s, d) => s + d.litres, 0);
    const projectedM3 = projectMonthM3(monthToDateL, cd, daysInMonth);
    const mbFiring = monthDaily.length > 0 && monthlyBudgetCondition(projectedM3, t.monthlyBudgetM3);
    fireOrClear(
      'rule-water-monthly-budget',
      mbFiring,
      'On track to exceed the monthly budget',
      `Projected ${round1(projectedM3)} m³ this month vs a ${t.monthlyBudgetM3} m³ budget`,
      `Month-to-date ${round1(monthToDateL / 1000)} m³ over ${cd} of ${daysInMonth} days projects to ${round1(projectedM3)} m³, above the ${t.monthlyBudgetM3} m³ budget.`,
      'Monthly projection back under budget',
    );

    // ---- Meter silent (connector health) ----
    const lastTs = latestHourlyTs();
    const lastMs = lastTs !== null ? lastTs * 1000 : null;
    const msFiring = meterSilentCondition(lastMs, now, t.meterSilentHours);
    const hoursSince = lastMs !== null ? round1((now - lastMs) / 3600_000) : null;
    fireOrClear(
      'rule-water-meter-silent',
      msFiring,
      'Water meter not reporting',
      hoursSince !== null ? `No new reading for ${hoursSince}h (threshold ${t.meterSilentHours}h)` : 'No reading has ever been received',
      hoursSince !== null
        ? `The last hourly reading is ${hoursSince}h old, past the ${t.meterSilentHours}h silence threshold.`
        : 'No hourly reading has been received since the integration was configured.',
      'Water meter reporting again',
    );
  } catch (e) {
    console.error('[water-detectors] tick failed:', (e as Error).message);
  }
}

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
