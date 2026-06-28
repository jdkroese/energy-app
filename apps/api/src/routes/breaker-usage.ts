// Read-only query API for per-breaker usage (spec docs/28 §7).
//
//   GET /api/breakers/:id/usage?from=&to=&granularity=raw|hour|day
//   GET /api/breakers/usage/summary?period=today|week|month
//
// Reads only the metering SQLite store — never a device. When metering is disabled
// (DB unavailable / native module missing) the routes return an empty, clearly
// "unavailable" payload rather than erroring, so the UI degrades gracefully.

import * as store from '../store';
import { TZ } from '../tariff';
import { db, isMeteringEnabled } from '../db/sqlite';
import { meteringLocalDay } from '../control/breaker-metering';

type Granularity = 'raw' | 'hour' | 'day';

export interface UsagePoint {
  ts: number; // unix seconds (raw/hour) — day points use the day's local-midnight-ish bucket
  energyWh: number;
  powerAvgW: number | null;
  powerMaxW?: number | null;
  voltageAvgV?: number | null;
  samples?: number;
}

export interface UsageResponse {
  breaker: { id: string; name: string };
  granularity: Granularity;
  available: boolean;
  points: UsagePoint[];
  totalKwh: number;
}

/** Resolve a configured device's display name (id-keyed; names are display-only). */
function breakerName(id: string): string {
  return store.get().deviceOnboarding.configured[id]?.name ?? id;
}

function isoToSec(v: unknown, fallback: number): number {
  if (typeof v !== 'string' || !v) return fallback;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : fallback;
}

/** Auto-pick the tier from the window when granularity is omitted (spec §7). */
function pickGranularity(fromSec: number, toSec: number): Granularity {
  const spanH = (toSec - fromSec) / 3600;
  if (spanH <= 36) return 'raw';
  if (spanH <= 90 * 24) return 'hour';
  return 'day';
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * GET /api/breakers/:id/usage — usage time-series for one breaker over [from,to]
 * at the requested (or auto-picked) tier, plus the total kWh.
 */
export function getBreakerUsage(
  id: string,
  query: { from?: unknown; to?: unknown; granularity?: unknown },
): UsageResponse {
  const name = breakerName(id);
  const handle = db();
  const toSec = isoToSec(query.to, Math.floor(Date.now() / 1000));
  const fromSec = isoToSec(query.from, toSec - 24 * 3600);
  const reqGran = query.granularity;
  const granularity: Granularity =
    reqGran === 'raw' || reqGran === 'hour' || reqGran === 'day'
      ? reqGran
      : pickGranularity(fromSec, toSec);

  if (!handle || !isMeteringEnabled()) {
    return { breaker: { id, name }, granularity, available: false, points: [], totalKwh: 0 };
  }

  let points: UsagePoint[] = [];
  try {
    if (granularity === 'raw') {
      const rows = handle
        .prepare(
          `SELECT ts, energy_wh, power_w, voltage_v FROM cb_raw
            WHERE breaker_id = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC`,
        )
        .all(id, fromSec, toSec) as Array<{ ts: number; energy_wh: number | null; power_w: number | null; voltage_v: number | null }>;
      points = rows.map((r) => ({
        ts: r.ts,
        energyWh: r.energy_wh ?? 0,
        powerAvgW: r.power_w,
        voltageAvgV: r.voltage_v,
      }));
    } else if (granularity === 'hour') {
      const rows = handle
        .prepare(
          `SELECT bucket_ts, energy_wh, power_avg_w, power_max_w, voltage_avg_v, samples
             FROM cb_hourly WHERE breaker_id = ? AND bucket_ts >= ? AND bucket_ts <= ?
            ORDER BY bucket_ts ASC`,
        )
        .all(id, fromSec, toSec) as Array<{ bucket_ts: number; energy_wh: number; power_avg_w: number | null; power_max_w: number | null; voltage_avg_v: number | null; samples: number }>;
      points = rows.map((r) => ({
        ts: r.bucket_ts,
        energyWh: r.energy_wh,
        powerAvgW: r.power_avg_w,
        powerMaxW: r.power_max_w,
        voltageAvgV: r.voltage_avg_v,
        samples: r.samples,
      }));
    } else {
      // day — bound by the local-day strings spanning [from,to].
      const fromDay = meteringLocalDay(fromSec);
      const toDay = meteringLocalDay(toSec);
      const rows = handle
        .prepare(
          `SELECT day, energy_wh, power_avg_w, power_max_w, voltage_avg_v, samples
             FROM cb_daily WHERE breaker_id = ? AND day >= ? AND day <= ? ORDER BY day ASC`,
        )
        .all(id, fromDay, toDay) as Array<{ day: string; energy_wh: number; power_avg_w: number | null; power_max_w: number | null; voltage_avg_v: number | null; samples: number }>;
      points = rows.map((r) => ({
        ts: Math.floor(Date.parse(`${r.day}T00:00:00`) / 1000),
        energyWh: r.energy_wh,
        powerAvgW: r.power_avg_w,
        powerMaxW: r.power_max_w,
        voltageAvgV: r.voltage_avg_v,
        samples: r.samples,
      }));
    }
  } catch {
    return { breaker: { id, name }, granularity, available: false, points: [], totalKwh: 0 };
  }

  const totalWh = points.reduce((s, p) => s + (p.energyWh || 0), 0);
  return { breaker: { id, name }, granularity, available: true, points, totalKwh: round3(totalWh / 1000) };
}

// ---- Fleet summary (spec §7) ------------------------------------------------

export interface UsageSummaryResponse {
  period: 'today' | 'week' | 'month';
  available: boolean;
  breakers: Array<{ id: string; name: string; kwh: number; sharePct: number }>;
  totalKwh: number;
}

/** Local-day string N days before today (Europe/Madrid). */
function localDayMinus(days: number): string {
  return meteringLocalDay(Math.floor(Date.now() / 1000) - days * 24 * 3600);
}

/**
 * GET /api/breakers/usage/summary — per-breaker kWh + share for the period. Uses
 * the daily rollup for week/month and combines today's hourly/raw for the current
 * (incomplete) day so "today" isn't blank before the daily roll.
 */
export function getUsageSummary(periodRaw: unknown): UsageSummaryResponse {
  const period: UsageSummaryResponse['period'] =
    periodRaw === 'week' || periodRaw === 'month' ? periodRaw : 'today';
  const handle = db();
  if (!handle || !isMeteringEnabled()) {
    return { period, available: false, breakers: [], totalKwh: 0 };
  }

  const today = meteringLocalDay(Math.floor(Date.now() / 1000));
  const fromDay = period === 'today' ? today : period === 'week' ? localDayMinus(6) : localDayMinus(29);
  const nowSec = Math.floor(Date.now() / 1000);

  try {
    const wh = new Map<string, number>();

    // Completed days from cb_daily (excludes today, which the daily roll hasn't sealed).
    const dailyRows = handle
      .prepare(`SELECT breaker_id, SUM(energy_wh) AS wh FROM cb_daily WHERE day >= ? AND day < ? GROUP BY breaker_id`)
      .all(fromDay, today) as Array<{ breaker_id: string; wh: number }>;
    for (const r of dailyRows) wh.set(r.breaker_id, (wh.get(r.breaker_id) ?? 0) + (r.wh ?? 0));

    // Today's partial energy from cb_hourly (sealed hours) + cb_raw (active hour),
    // restricted to today's local-day window.
    const todayStartSec = Math.floor(Date.parse(`${today}T00:00:00`) / 1000);
    const hourlyToday = handle
      .prepare(`SELECT breaker_id, SUM(energy_wh) AS wh FROM cb_hourly WHERE bucket_ts >= ? AND bucket_ts <= ? GROUP BY breaker_id`)
      .all(todayStartSec, nowSec) as Array<{ breaker_id: string; wh: number }>;
    const sealedHourStart = Math.floor(nowSec / 3600) * 3600;
    const rawActive = handle
      .prepare(`SELECT breaker_id, SUM(COALESCE(energy_wh,0)) AS wh FROM cb_raw WHERE ts >= ? AND ts <= ? GROUP BY breaker_id`)
      .all(sealedHourStart, nowSec) as Array<{ breaker_id: string; wh: number }>;
    for (const r of hourlyToday) wh.set(r.breaker_id, (wh.get(r.breaker_id) ?? 0) + (r.wh ?? 0));
    for (const r of rawActive) wh.set(r.breaker_id, (wh.get(r.breaker_id) ?? 0) + (r.wh ?? 0));

    const configured = store.get().deviceOnboarding.configured;
    const breakers = [...wh.entries()]
      .map(([id, energyWh]) => ({ id, name: configured[id]?.name ?? id, kwh: round3(energyWh / 1000) }))
      .filter((b) => b.kwh > 0)
      .sort((a, b) => b.kwh - a.kwh);
    const totalKwh = round3(breakers.reduce((s, b) => s + b.kwh, 0));
    const withShare = breakers.map((b) => ({ ...b, sharePct: totalKwh > 0 ? Math.round((b.kwh / totalKwh) * 1000) / 10 : 0 }));
    return { period, available: true, breakers: withShare, totalKwh };
  } catch {
    return { period, available: false, breakers: [], totalKwh: 0 };
  }
}
