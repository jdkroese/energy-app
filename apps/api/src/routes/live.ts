import * as sonnen from '../connectors/sonnen';
import * as tesla from '../connectors/tesla';
import { bandInfo } from '../tariff';

// In-process rolling 24h power buffers for the day chart (best-effort; resets on restart).
const dayBuf = {
  date: madridDateKey(new Date()),
  solarKw: new Array<number>(24).fill(0),
  homeKw: new Array<number>(24).fill(0),
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

function recordSample(solarKw: number, homeKw: number) {
  const now = new Date();
  const key = madridDateKey(now);
  if (key !== dayBuf.date) {
    dayBuf.date = key;
    dayBuf.solarKw.fill(0);
    dayBuf.homeKw.fill(0);
    dayBuf.seen.fill(0);
  }
  const h = madridHour(now);
  // Running average within the hour bucket.
  const n = dayBuf.seen[h];
  dayBuf.solarKw[h] = (dayBuf.solarKw[h] * n + solarKw) / (n + 1);
  dayBuf.homeKw[h] = (dayBuf.homeKw[h] * n + homeKw) / (n + 1);
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
  const [sRes, tRes, hRes] = await Promise.allSettled([
    sonnen.getNormalized(),
    tesla.getNormalized(),
    todayFromHistory(),
  ]);

  const s = sRes.status === 'fulfilled' ? sRes.value : null;
  const t = tRes.status === 'fulfilled' ? tRes.value : null;
  const hist = hRes.status === 'fulfilled' ? hRes.value : null;

  // Solar: Tesla solar_power is the PW3-metered array (Array B). If Sonnen reports
  // production (Array A), add it. Best-effort A/B split.
  const teslaSolar = t?.solarKw ?? 0;
  const sonnenSolar = s ? round(s.productionW / 1000) : 0;
  const solarKw = round(teslaSolar + sonnenSolar);
  const arrays =
    sonnenSolar > 0 || teslaSolar > 0 ? { a: sonnenSolar, b: teslaSolar } : undefined;

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

  recordSample(solarKw, homeKw);

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
    solar: { kw: solarKw, ...(arrays ? { arrays } : {}) },
    home: { kw: round(homeKw) },
    grid: { kw: gridKw, dir: gridDir },
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
    today: {
      producedKwh,
      consumedKwh,
      gridFeedInKwh,
      selfSufficiencyPct,
      savedEur,
    },
    day: {
      solarKw: dayBuf.solarKw.map((v) => round(v)),
      homeKw: dayBuf.homeKw.map((v) => round(v)),
    },
  };
}
