// Solar-inverter routes (Sungrow SG5.0RS ×2; docs/36). READ-ONLY.
//   GET /api/inverters          — live per-inverter snapshot for the Solar Inverters view.
//   GET /api/inverters/history  — per-inverter production history (Reports chart), by range.

import * as sungrow from '../connectors/sungrow';
import { probeAll } from './health-probe';
import { sungrowConfig } from '../runtime-config';
import { readInverterBuckets, type InverterRange } from '../control/inverter-history';

const TZ = 'Europe/Madrid';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** Live per-inverter snapshot + a combined summary. */
export async function getInverters(): Promise<unknown> {
  const [norm, probe] = await Promise.all([
    sungrow.getNormalized().catch(() => ({ inverters: [], productionW: 0 } as sungrow.SungrowNormalized)),
    probeAll().catch(() => null),
  ]);
  const daylight = probe?.sungrow?.[0]?.daylight ?? false;

  const inverters = norm.inverters.map((i) => {
    const active = sungrow.activeFaults(i.faults);
    return {
      id: i.id,
      name: i.name,
      ip: i.ip,
      model: i.model,
      kw: round(i.acPowerW / 1000),
      dailyKwh: round(i.dailyKwh, 1),
      totalKwh: round(i.totalKwh, 0),
      tempC: i.tempC,
      workState: i.workState,
      reachable: i.reachable,
      lastSeen: i.lastSeen,
      // "asleep" = not reachable but it's night (expected); "offline" = daylight miss.
      status: i.reachable ? 'online' : daylight ? 'offline' : 'asleep',
      faults: i.faults.slice(0, 8),
      activeFaultCount: active.length,
    };
  });

  return {
    ts: new Date().toISOString(),
    daylight,
    productionKw: round(norm.productionW / 1000),
    todayKwh: round(inverters.reduce((s, i) => s + (i.reachable ? i.dailyKwh : 0), 0), 1),
    count: inverters.length,
    inverters,
  };
}

// ---- History ---------------------------------------------------------------

const VALID: InverterRange[] = ['hour', 'day', 'week', 'month', 'year'];

function madridParts(d: Date) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return { year: g('year'), month: g('month'), day: g('day'), hour: g('hour'), minute: g('minute') };
}

/** Bucket a ts to its chart bucket key+label for a range (mirrors history.ts). */
function bucketOf(d: Date, range: InverterRange): { key: string; label: string } {
  const { year, month, day, hour, minute } = madridParts(d);
  if (range === 'hour') {
    const m5 = String(Math.floor(Number(minute) / 5) * 5).padStart(2, '0');
    return { key: `${day}-${hour}-${m5}`, label: `${hour}:${m5}` };
  }
  if (range === 'day') return { key: `${year}-${month}-${day}-${hour}`, label: `${hour}:00` };
  if (range === 'year') return { key: `${year}-${month}`, label: MONTHS[Number(month) - 1] ?? month };
  return { key: `${year}-${month}-${day}`, label: `${day}/${month}` };
}

/**
 * Per-inverter production history for a range. Returns aligned labels + a per-inverter
 * kWh series so the Reports chart can render one line/bar group per inverter. Reads the
 * durable per-inverter store; returns empty series (not an error) when the store is
 * unavailable or holds no rows yet (fresh boot before samples accrue).
 */
export function getInvertersHistory(rangeRaw: string): unknown {
  const range = (VALID as string[]).includes(rangeRaw) ? (rangeRaw as InverterRange) : 'day';
  const buckets = readInverterBuckets(range);

  // Group into ordered chart buckets, summing per inverter.
  const order: string[] = [];
  const labelByKey = new Map<string, string>();
  const perInverter = new Map<string, Map<string, number>>(); // inverterId → key → kWh
  const nameById = new Map<string, string>();

  for (const b of buckets) {
    const d = new Date(b.ts * 1000);
    const { key, label } = bucketOf(d, range);
    if (!labelByKey.has(key)) {
      labelByKey.set(key, label);
      order.push(key);
    }
    let m = perInverter.get(b.inverterId);
    if (!m) {
      m = new Map();
      perInverter.set(b.inverterId, m);
    }
    m.set(key, (m.get(key) ?? 0) + b.acKwh);
  }

  // Friendly names from the live config (fall back to the id).
  for (const d of sungrowConfig()) {
    if (d.name) nameById.set(d.ip, d.name);
  }

  const labels = order.map((k) => labelByKey.get(k) ?? k);
  const series = [...perInverter.entries()].map(([id, m], idx) => ({
    id,
    name: nameById.get(id) ?? `Solar Inverter ${idx + 1}`,
    kwh: order.map((k) => round(m.get(k) ?? 0, 2)),
    totalKwh: round([...m.values()].reduce((s, v) => s + v, 0), 1),
  }));

  return { ts: new Date().toISOString(), range, labels, series };
}
