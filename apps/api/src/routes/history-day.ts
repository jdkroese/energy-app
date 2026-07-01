// GET /api/history/day?offset=0 — the Live day chart's data source.
//
// offset 0 = today, -1 = yesterday, … clamped to the available 30-day range.
// Today returns MEASURED 5-min series (from history5m) PLUS a 288-pt FORECAST
// (solar from weather, load + combined SoC from the brain plan) whose values are
// only present from nowIndex..287 (null before). Past days return measured only:
// forecast null, nowIndex null, no now-line.

import { config } from '../config';
import * as weather from '../connectors/weather';
import * as sonnen from '../connectors/sonnen';
import * as tesla from '../connectors/tesla';
import * as store from '../store';
import { bandForHour, type Band } from '../tariff';
import * as history5m from '../history5m';
import { BUCKETS_PER_DAY, type HistorySeriesKey } from '../history5m';
import { forecastSolarKw } from '../solar-model';
import { forecastLoadKw } from '../load-model';

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function madridBucketIndex(d: Date): number {
  return history5m.madridBucketIndex(d);
}

function madridWeekday(d: Date): number {
  const wdName = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Madrid',
    weekday: 'short',
  }).format(d);
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[wdName] ?? 1;
}

/**
 * Combined-SoC trajectory (% per hour) plus per-hour battery flow — a light
 * version of the brain plan: charge from solar surplus, discharge harder in P1,
 * hold a reserve floor. Returns the SoC track and, split from the per-hour battery
 * delta, chargeKw[h] = max(0, delta) and dischargeKw[h] = max(0, -delta).
 */
function socTrajectory(
  solarKw: number[],
  loadKw: number[],
  bandCodes: number[],
  startSoc: number,
  reservePct: number,
): { socPct: number[]; chargeKw: number[]; dischargeKw: number[] } {
  const capKwh = config.assets.sonnenUsableKwh + config.assets.teslaUsableKwh;
  const maxKw = config.assets.sonnenMaxKw + config.assets.teslaMaxKw;
  const socPct: number[] = [];
  const chargeKw: number[] = [];
  const dischargeKw: number[] = [];
  let soc = startSoc;
  for (let h = 0; h < 24; h++) {
    const surplus = solarKw[h] - loadKw[h];
    const band = bandCodes[h];
    let deltaKwh = 0;
    if (surplus > 0) {
      const headroomKwh = ((100 - soc) / 100) * capKwh;
      deltaKwh = Math.min(surplus, maxKw, headroomKwh);
    } else {
      const deficit = -surplus;
      const availKwh = Math.max(0, ((soc - reservePct) / 100) * capKwh);
      let discharge = 0;
      if (band === 2) discharge = Math.min(deficit, maxKw, availKwh);
      else if (band === 1) discharge = Math.min(deficit * 0.7, maxKw, availKwh);
      else discharge = Math.min(deficit * 0.2, maxKw, availKwh);
      deltaKwh = -discharge;
    }
    soc = Math.max(0, Math.min(100, soc + (deltaKwh / capKwh) * 100));
    socPct.push(Math.round(soc));
    // deltaKwh over a 1-hour step ≈ kW; split into charge / discharge series.
    chargeKw.push(round(Math.max(0, deltaKwh), 2));
    dischargeKw.push(round(Math.max(0, -deltaKwh), 2));
  }
  return { socPct, chargeKw, dischargeKw };
}

/** Expand a 24-hour array to a 288-bucket (5-min) array by linear interpolation. */
function hourlyTo288(hourly: number[]): number[] {
  const out = new Array<number>(BUCKETS_PER_DAY).fill(0);
  for (let i = 0; i < BUCKETS_PER_DAY; i++) {
    const h = i / 12; // fractional hour
    const h0 = Math.floor(h);
    const h1 = Math.min(23, h0 + 1);
    const frac = h - h0;
    const a = hourly[h0] ?? 0;
    const b = hourly[h1] ?? a;
    out[i] = round(a + (b - a) * frac, 2);
  }
  return out;
}

interface TariffBandSeg {
  startH: number;
  endH: number;
  band: Band;
}

/** Compress 24 hourly bands into contiguous {startH,endH,band} segments. */
function tariffBands(weekday: number): TariffBandSeg[] {
  const segs: TariffBandSeg[] = [];
  let curBand: Band | null = null;
  let start = 0;
  for (let h = 0; h < 24; h++) {
    const b = bandForHour(h, weekday);
    if (b !== curBand) {
      if (curBand !== null) segs.push({ startH: start, endH: h, band: curBand });
      curBand = b;
      start = h;
    }
  }
  if (curBand !== null) segs.push({ startH: start, endH: 24, band: curBand });
  return segs;
}

const FORECAST_KEYS = [
  'solarKw',
  'homeKw',
  'chargeKw',
  'dischargeKw',
  'gridImportKw',
  'gridExportKw',
  'sonnenSoc',
  'teslaSoc',
  'combinedSoc',
] as const;

type ForecastSeries = Record<HistorySeriesKey, (number | null)[]>;

function blankForecast(): ForecastSeries {
  return Object.fromEntries(
    FORECAST_KEYS.map((k) => [k, new Array<number | null>(BUCKETS_PER_DAY).fill(null)]),
  ) as ForecastSeries;
}

/** Madrid date key for "today minus n days". */
function dateKeyForOffset(offset: number): string {
  const d = new Date(Date.now() + offset * 24 * 60 * 60 * 1000);
  return history5m.madridDateKey(d);
}

export interface HistoryDayResponse {
  date: string;
  offset: number;
  nowIndex: number | null;
  series: Record<HistorySeriesKey, number[]>;
  forecast: ForecastSeries | null;
  tariffBands: TariffBandSeg[];
  hasPrev: boolean;
  hasNext: boolean;
}

/**
 * Build the day-chart payload for a given offset (0=today, negative=past).
 * The offset is clamped to the available history range. Forecast + now-line are
 * only produced for today.
 */
export async function getHistoryDay(rawOffset: number): Promise<HistoryDayResponse> {
  const keys = history5m.availableDayKeys();
  const todayKey = history5m.madridDateKey(new Date());

  // Range of selectable offsets: today (0) back to the oldest stored day.
  // oldestOffset is negative (or 0). Clamp the requested offset into it.
  let oldestOffset = 0;
  if (keys.length > 0) {
    const oldestKey = keys[0];
    // Count days between oldestKey and today (both Madrid YYYY-MM-DD).
    const ms = Date.parse(`${todayKey}T00:00:00Z`) - Date.parse(`${oldestKey}T00:00:00Z`);
    oldestOffset = -Math.max(0, Math.round(ms / (24 * 60 * 60 * 1000)));
  }
  const offset = Math.max(oldestOffset, Math.min(0, Math.round(rawOffset)));
  const isToday = offset === 0;
  const dateKey = dateKeyForOffset(offset);

  // Measured series (0/null-filled to 288 if we have no record for the day).
  const measured = history5m.getDay(dateKey);
  const series = (measured ??
    (Object.fromEntries(
      FORECAST_KEYS.map((k) => [k, new Array<number>(BUCKETS_PER_DAY).fill(0)]),
    ) as Record<HistorySeriesKey, number[]>)) as Record<HistorySeriesKey, number[]>;

  const refDate = new Date(`${dateKey}T12:00:00Z`); // noon-anchored to avoid DST edges
  const weekday = madridWeekday(refDate);
  const bands = tariffBands(weekday);

  let forecast: ForecastSeries | null = null;
  let nowIndex: number | null = null;

  if (isToday) {
    nowIndex = madridBucketIndex(new Date());
    forecast = await buildForecast(weekday, new Date());
    // Forecast values only exist from nowIndex..287; null everything before.
    if (forecast) {
      for (const k of FORECAST_KEYS) {
        for (let i = 0; i < nowIndex; i++) forecast[k][i] = null;
      }
    }
  }

  return {
    date: dateKey,
    offset,
    nowIndex,
    series,
    forecast,
    tariffBands: bands,
    hasPrev: offset > oldestOffset,
    hasNext: offset < 0,
  };
}

/** Compute the 288-pt forecast series for today from the shared forecast model. */
async function buildForecast(weekday: number, date: Date): Promise<ForecastSeries> {
  const fc = blankForecast();
  const [wRes, tRes, sRes] = await Promise.allSettled([
    weather.getForecast(),
    tesla.getNormalized(),
    sonnen.getNormalized(),
  ]);
  const wf = wRes.status === 'fulfilled' ? wRes.value : null;
  const t = tRes.status === 'fulfilled' ? tRes.value : null;
  const s = sRes.status === 'fulfilled' ? sRes.value : null;

  const temp = wf?.temperature ?? null;
  // Shared self-improving model: clear-sky × learned per-hour roof shape × live
  // weather (solar), learned household profile (load). Same functions the
  // Autopilot plan uses, so the two surfaces agree.
  const solarKw = forecastSolarKw(wf, date);
  const loadKw = forecastLoadKw(date, temp);

  const bandCodes = Array.from({ length: 24 }, (_, h) => {
    const b = bandForHour(h, weekday);
    return b === 'P1' ? 2 : b === 'P2' ? 1 : 0;
  });

  // Active scenario reserve floor + combined starting SoC (energy-weighted).
  const state = store.get();
  const scenario = state.scenarios[state.activeScenario] ?? store.DEFAULT_SCENARIOS.balanced;
  const sonnenKwh = config.assets.sonnenUsableKwh;
  const teslaKwh = config.assets.teslaUsableKwh;
  const startSoc =
    s && t
      ? Math.round((s.soc * sonnenKwh + t.soc * teslaKwh) / (sonnenKwh + teslaKwh))
      : t?.soc ?? s?.soc ?? 50;
  const deviceReserve = t?.reservePct ?? 20;
  const reservePct = scenario.dynReserve
    ? Math.max(scenario.reserve, deviceReserve)
    : scenario.reserve;

  const { socPct, chargeKw, dischargeKw } = socTrajectory(
    solarKw,
    loadKw,
    bandCodes,
    startSoc,
    reservePct,
  );

  // Production (solar) → area/line; consumption (home load); combined SoC plan;
  // battery charge/discharge derived from the SoC-trajectory per-hour deltas.
  fc.solarKw = hourlyTo288(solarKw);
  fc.homeKw = hourlyTo288(loadKw);
  fc.combinedSoc = hourlyTo288(socPct).map((v) => Math.round(v));
  fc.chargeKw = hourlyTo288(chargeKw);
  fc.dischargeKw = hourlyTo288(dischargeKw);
  // Remaining series have no meaningful forecast; leave null.
  return fc;
}
