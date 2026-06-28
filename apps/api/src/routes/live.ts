import * as sonnen from '../connectors/sonnen';
import * as tesla from '../connectors/tesla';
import { bandInfo } from '../tariff';
import { config } from '../config';
import * as history5m from '../history5m';
import * as voltageHistory from '../voltage-history';
import { recordEnergySample } from '../control/energy-history';
import { climateSurplusW } from '../control/climate-snapshot';
import { getMonitoredBreaker } from '../connectors/tuya-voltage';

const COMBINED_USABLE_KWH = config.assets.sonnenUsableKwh + config.assets.teslaUsableKwh;

// In-process rolling 24h day buffers for the day chart (best-effort; resets on
// restart, resets at Madrid midnight). Power series in kW, SoC series in %.
const SERIES = [
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
type DaySeriesKey = (typeof SERIES)[number];
type DaySample = Record<DaySeriesKey, number>;

function blankDay(): Record<DaySeriesKey, number[]> {
  return Object.fromEntries(SERIES.map((k) => [k, new Array<number>(24).fill(0)])) as Record<
    DaySeriesKey,
    number[]
  >;
}

const dayBuf = {
  date: madridDateKey(new Date()),
  series: blankDay(),
  seen: new Array<number>(24).fill(0),
};

function madridDateKey(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

function madridHour(d: Date): number {
  return (
    Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Madrid',
        hour: '2-digit',
        hour12: false,
      }).format(d),
    ) % 24
  );
}

/** Fractional Madrid hour right now (0–24), e.g. 10.58 at 10:35. */
function madridHourFloat(d: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Madrid',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const hh = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24;
  const mm = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return hh + mm / 60;
}

function recordSample(sample: DaySample) {
  const now = new Date();
  const key = madridDateKey(now);
  if (key !== dayBuf.date) {
    dayBuf.date = key;
    dayBuf.series = blankDay();
    dayBuf.seen.fill(0);
  }
  const h = madridHour(now);
  // Running average within the hour bucket, per series.
  const n = dayBuf.seen[h];
  for (const k of SERIES) {
    dayBuf.series[k][h] = (dayBuf.series[k][h] * n + sample[k]) / (n + 1);
  }
  dayBuf.seen[h] = n + 1;
}

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * Best-effort today totals derived from Tesla calendar_history (kind=energy, period=day).
 * Falls back to nulls when unavailable; the route fills computed estimates.
 */
async function todayFromHistory(): Promise<{
  producedKwh: number;
  consumedKwh: number;
  gridFeedInKwh: number;
  selfSufficiencyPct: number;
} | null> {
  try {
    const raw = (await tesla.getCalendarHistory('energy', 'day')) as {
      time_series?: Array<{
        solar_energy_exported?: number;
        grid_energy_imported?: number;
        grid_energy_exported_from_solar?: number;
        grid_energy_exported_from_battery?: number;
        consumer_energy_imported_from_grid?: number;
        consumer_energy_imported_from_solar?: number;
        consumer_energy_imported_from_battery?: number;
        battery_energy_imported_from_solar?: number;
        battery_energy_imported_from_grid?: number;
        total_solar_generation?: number;
      }>;
    };
    const ts = raw.time_series;
    if (!ts || ts.length === 0) return null;
    let solar = 0;
    let consumed = 0;
    let exported = 0;
    let importedGrid = 0;
    for (const r of ts) {
      solar += (r.total_solar_generation ?? r.solar_energy_exported ?? 0) || 0;
      const home =
        (r.consumer_energy_imported_from_grid ?? 0) +
        (r.consumer_energy_imported_from_solar ?? 0) +
        (r.consumer_energy_imported_from_battery ?? 0);
      consumed += home;
      exported +=
        (r.grid_energy_exported_from_solar ?? 0) + (r.grid_energy_exported_from_battery ?? 0);
      importedGrid += r.grid_energy_imported ?? r.consumer_energy_imported_from_grid ?? 0;
    }
    // Wh → kWh
    const producedKwh = round(solar / 1000, 1);
    const consumedKwh = round(consumed / 1000, 1);
    const gridFeedInKwh = round(exported / 1000, 1);
    const importedKwh = importedGrid / 1000;
    const selfSufficiencyPct =
      consumedKwh > 0
        ? Math.max(0, Math.min(100, Math.round((1 - importedKwh / consumedKwh) * 100)))
        : 0;
    return { producedKwh, consumedKwh, gridFeedInKwh, selfSufficiencyPct };
  } catch {
    return null;
  }
}

export async function getLive(): Promise<unknown> {
  const [sRes, tRes, hRes, bRes] = await Promise.allSettled([
    sonnen.getNormalized(),
    tesla.getNormalized(),
    todayFromHistory(),
    getMonitoredBreaker(),
  ]);

  const s = sRes.status === 'fulfilled' ? sRes.value : null;
  const t = tRes.status === 'fulfilled' ? tRes.value : null;
  const hist = hRes.status === 'fulfilled' ? hRes.value : null;
  const breaker = bRes.status === 'fulfilled' ? bRes.value : null;

  // Solar: Tesla solar_power is the PW3-metered array (Array B). If Sonnen reports
  // production (Array A), add it. Best-effort A/B split.
  const teslaSolar = t?.solarKw ?? 0;
  const sonnenSolar = s ? round(s.productionW / 1000) : 0;
  const solarKw = round(teslaSolar + sonnenSolar);
  // Two physical arrays: A (Sonnen/Sungrow-side) + B (Tesla PW3-metered). Returned
  // as the {name,kw}[] the web contract (LiveResponse.solar.arrays) expects.
  const arrays = [
    { name: 'A', kw: sonnenSolar },
    { name: 'B', kw: teslaSolar },
  ];

  // Home load: prefer Tesla load_power; else Sonnen consumption.
  const homeKw = t ? t.loadKw : s ? round(s.consumptionW / 1000) : 0;

  // Grid: prefer Tesla grid_power (+import / -export).
  let gridKw = 0;
  let gridDir: 'importing' | 'exporting' | 'idle' = 'idle';
  if (t) {
    gridKw = round(Math.abs(t.gridKw));
    if (t.gridKw > 0.02) gridDir = 'importing';
    else if (t.gridKw < -0.02) gridDir = 'exporting';
  } else if (s) {
    gridKw = round(Math.abs(s.gridFeedInW) / 1000);
    if (s.gridFeedInW > 20) gridDir = 'exporting';
    else if (s.gridFeedInW < -20) gridDir = 'importing';
  }

  // Battery charge/discharge, split per direction and summed across both packs.
  // Connectors report kw as a magnitude + a dir; signs are normalized there.
  const sonnenCharge = s && s.dir === 'charging' ? s.kw : 0;
  const sonnenDischarge = s && s.dir === 'discharging' ? s.kw : 0;
  const teslaCharge = t && t.dir === 'charging' ? t.kw : 0;
  const teslaDischarge = t && t.dir === 'discharging' ? t.kw : 0;
  const chargeKw = round(sonnenCharge + teslaCharge);
  const dischargeKw = round(sonnenDischarge + teslaDischarge);

  const gridImportKw = gridDir === 'importing' ? gridKw : 0;
  const gridExportKw = gridDir === 'exporting' ? gridKw : 0;

  const sonnenSoc = s ? s.soc : 0;
  const teslaSoc = t ? t.soc : 0;
  // Combined fill = stored kWh across both packs over combined usable capacity.
  const combinedSoc = round(
    Math.max(0, Math.min(100, (((s?.kwh ?? 0) + (t?.kwh ?? 0)) / COMBINED_USABLE_KWH) * 100)),
    0,
  );

  const sample = {
    solarKw,
    homeKw: round(homeKw),
    chargeKw,
    dischargeKw,
    gridImportKw,
    gridExportKw,
    sonnenSoc,
    teslaSoc,
    combinedSoc,
  };
  recordSample(sample);
  // Persistent 5-minute history (its own file) — fills as /api/live is polled.
  history5m.record(sample);
  // Durable tiered SQLite energy history (90d 5m / 3y hourly / forever daily).
  // Additive + fail-soft: a null DB / any error no-ops, and history5m's JSON above
  // remains the DayChart fallback. Never throws into the control loop.
  recordEnergySample(sample);
  // Persistent 5-minute grid-voltage history (its own file) — only when the
  // breaker reported a real voltage; the 5-min bucketing dedupes the 10s polls.
  if (breaker && breaker.voltageV > 0) {
    voltageHistory.record({
      voltageV: breaker.voltageV,
      currentA: breaker.currentA,
      powerW: breaker.powerW,
    });
  }

  const tb = bandInfo(new Date());

  // Today totals: prefer Tesla history; else compute reasonable values from flows.
  const producedKwh = hist?.producedKwh ?? round(solarKw * 5, 1); // rough
  const consumedKwh = hist?.consumedKwh ?? round(homeKw * 12, 1);
  const gridFeedInKwh = hist?.gridFeedInKwh ?? 0;
  const selfSufficiencyPct =
    hist?.selfSufficiencyPct ??
    (consumedKwh > 0
      ? Math.max(0, Math.min(100, Math.round(((consumedKwh - gridFeedInKwh) / consumedKwh) * 100)))
      : 0);
  // Saved €: solar self-used valued at avg import rate, minus what export would have earned.
  const selfUsedKwh = Math.max(0, producedKwh - gridFeedInKwh);
  const savedEur = round(selfUsedKwh * tb.rateEur + gridFeedInKwh * 0.016);

  return {
    ts: new Date().toISOString(),
    solar: { kw: solarKw, arrays },
    home: { kw: round(homeKw) },
    grid: { kw: gridKw, dir: gridDir },
    // Surplus the climate rule actually gates on (PV − load − battery intake
    // headroom) — the same number takeClimateSnapshot uses, via the shared helper.
    climateSurplusKw: round(climateSurplusW(s, t) / 1000),
    batteryDataComplete: s !== null && t !== null,
    sonnen: s
      ? { soc: s.soc, kwh: s.kwh, kw: s.kw, dir: s.dir, mode: s.mode }
      : { soc: 0, kwh: 0, kw: 0, dir: 'idle', offline: true },
    tesla: t
      ? {
          soc: t.soc,
          kwh: t.kwh,
          kw: t.kw,
          dir: t.dir,
          reservePct: t.reservePct,
          backupKwh: t.backupKwh,
          backupHours: t.backupHours,
          island: t.island,
        }
      : {
          soc: 0,
          kwh: 0,
          kw: 0,
          dir: 'idle',
          reservePct: 20,
          backupKwh: 0,
          backupHours: 0,
          island: false,
          offline: true,
        },
    tariff: {
      band: tb.band,
      rateEur: tb.rateEur,
      nextBand: tb.nextBand,
      minsToNext: tb.minsToNext,
    },
    // Live grid voltage/current/power from the monitored Tuya breaker, or null when
    // none is configured/exposing cur_voltage (the KPI box empty-states gracefully).
    breaker,
    today: {
      producedKwh,
      consumedKwh,
      gridFeedInKwh,
      selfSufficiencyPct,
      savedEur,
    },
    day: {
      solarKw: dayBuf.series.solarKw.map((v) => round(v)),
      homeKw: dayBuf.series.homeKw.map((v) => round(v)),
      chargeKw: dayBuf.series.chargeKw.map((v) => round(v)),
      dischargeKw: dayBuf.series.dischargeKw.map((v) => round(v)),
      gridImportKw: dayBuf.series.gridImportKw.map((v) => round(v)),
      gridExportKw: dayBuf.series.gridExportKw.map((v) => round(v)),
      sonnenSoc: dayBuf.series.sonnenSoc.map((v) => round(v, 0)),
      teslaSoc: dayBuf.series.teslaSoc.map((v) => round(v, 0)),
      combinedSoc: dayBuf.series.combinedSoc.map((v) => round(v, 0)),
      nowHour: round(madridHourFloat(new Date()), 2),
    },
  };
}
