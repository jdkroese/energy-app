import * as sonnen from '../connectors/sonnen';
import * as tesla from '../connectors/tesla';
import { config } from '../config';

/**
 * GET /api/batteries — per-device detail for the Batteries screens.
 *
 * Current state is REAL (from the connectors). To respect the pay-as-you-go
 * Tesla Fleet API we only ever read the CACHED endpoints here (getNormalized,
 * getLiveStatus, getSiteInfo) — never the uncached read-back. Day history is a
 * best-effort in-process rolling buffer (same pattern as routes/live.ts): it is
 * sparse right after a restart and fills in as the screen is polled. Health
 * metrics are surfaced only where a device actually reports them; everything
 * else is returned null and the UI shows "—" rather than a fabricated number.
 */

type Dir = 'charging' | 'discharging' | 'idle';

interface BatterySpec {
  label: string;
  value: string;
}

interface BatteryDetail {
  id: 'sonnen' | 'tesla';
  name: string;
  vendor: string;
  role: string;
  online: boolean;
  soc: number;
  kwh: number;
  usableKwh: number;
  nominalKwh: number;
  power: { kw: number; dir: Dir };
  maxKw: number;
  mode: string;
  hasBackup: boolean;
  reservePct: number | null;
  backupKwh: number | null;
  backupHours: number | null;
  island: boolean | null;
  stormMode: boolean | null;
  exportRule: string | null;
  gridChargeAllowed: boolean | null;
  headroomKwh: number;
  aboveReserveKwh: number | null;
  health: number | null;
  capacityKwh: number | null;
  cyclesTotal: number | null;
  throughputKwh: number | null;
  roundTripPct: number | null;
  tempC: number | null;
  warrantyPct: number | null;
  installedYear: number | null;
  todayInKwh: number;
  todayOutKwh: number;
  socDay: number[];
  chargeKwDay: number[];
  dischargeKwDay: number[];
  specs: BatterySpec[];
}

interface BatteriesResponse {
  ts: string;
  combined: { usableKwh: number; storedKwh: number; soc: number };
  batteries: BatteryDetail[];
}

// ---- Madrid-day rolling buffers (best-effort history) ----------------------

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
      new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', hour12: false }).format(d),
    ) % 24
  );
}

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

function pretty(s: string | undefined | null): string {
  return (s ?? '').replace(/_/g, ' ');
}

interface DayBuf {
  date: string;
  soc: number[];
  seen: number[];
  chargeKw: number[];
  dischargeKw: number[];
  todayIn: number;
  todayOut: number;
  lastTs: number | null;
}

function freshBuf(date: string): DayBuf {
  return {
    date,
    soc: new Array<number>(24).fill(0),
    seen: new Array<number>(24).fill(0),
    chargeKw: new Array<number>(24).fill(0),
    dischargeKw: new Array<number>(24).fill(0),
    todayIn: 0,
    todayOut: 0,
    lastTs: null,
  };
}

const bufs: Record<'sonnen' | 'tesla', DayBuf> = {
  sonnen: freshBuf(madridDateKey(new Date())),
  tesla: freshBuf(madridDateKey(new Date())),
};

/** Record a live sample into the device's day buffer + integrate throughput. */
function sample(id: 'sonnen' | 'tesla', soc: number, kw: number, dir: Dir): void {
  const now = new Date();
  const key = madridDateKey(now);
  let b = bufs[id];
  if (b.date !== key) b = bufs[id] = freshBuf(key);

  const h = madridHour(now);
  const n = b.seen[h];
  b.soc[h] = soc;
  b.chargeKw[h] = (b.chargeKw[h] * n + (dir === 'charging' ? kw : 0)) / (n + 1);
  b.dischargeKw[h] = (b.dischargeKw[h] * n + (dir === 'discharging' ? kw : 0)) / (n + 1);
  b.seen[h] = n + 1;

  // Integrate energy since the last sample, ignoring large gaps (downtime).
  if (b.lastTs != null) {
    const dtH = (now.getTime() - b.lastTs) / 3_600_000;
    if (dtH > 0 && dtH < 0.5) {
      if (dir === 'charging') b.todayIn += kw * dtH;
      else if (dir === 'discharging') b.todayOut += kw * dtH;
    }
  }
  b.lastTs = now.getTime();
}

/** Forward/back-filled SoC for the whole day so the chart spans 00→24 cleanly. */
function fillSoc(b: DayBuf): number[] {
  const h = madridHour(new Date());
  let first: number | null = null;
  for (let i = 0; i < 24; i++) {
    if (b.seen[i] > 0) {
      first = b.soc[i];
      break;
    }
  }
  const out: number[] = [];
  let last: number | null = null;
  for (let i = 0; i < 24; i++) {
    if (i <= h && b.seen[i] > 0) {
      last = b.soc[i];
      out.push(round(b.soc[i], 0));
    } else {
      out.push(round(last ?? first ?? 0, 0));
    }
  }
  return out;
}

/** Charge/discharge power per hour, zeroed for hours not yet reached. */
function powerSeries(arr: number[]): number[] {
  const h = madridHour(new Date());
  return arr.map((v, i) => (i <= h ? round(v, 2) : 0));
}

// ---- Per-device builders (never throw) -------------------------------------

async function buildSonnen(): Promise<BatteryDetail> {
  const usableKwh = config.assets.sonnenUsableKwh;
  const nominalKwh = config.assets.sonnenNominalKwh;
  const maxKw = config.assets.sonnenMaxKw;

  let soc = 0;
  let kwh = 0;
  let kw = 0;
  let dir: Dir = 'idle';
  let mode = 'self-consumption';
  let online = false;

  try {
    const s = await sonnen.getNormalized();
    soc = s.soc;
    kwh = s.kwh;
    kw = s.kw;
    dir = s.dir;
    mode = s.mode ?? 'self-consumption';
    online = true;
    sample('sonnen', soc, kw, dir);
  } catch {
    /* offline — keep zeros */
  }

  // Best-effort state-of-health from /latestdata (local API, free over VPN).
  let health: number | null = null;
  let capacityKwh: number | null = null;
  let cyclesTotal: number | null = null;
  try {
    const ld = (await sonnen.getLatestData()) as Record<string, unknown> & {
      ic_status?: Record<string, unknown>;
    };
    const fcc = num(ld.FullChargeCapacity ?? ld.FullChargeCapacity_Wh ?? ld.ic_status?.FullChargeCapacity);
    if (fcc && fcc > 0) {
      capacityKwh = round(fcc > 1000 ? fcc / 1000 : fcc, 1);
      health = Math.max(0, Math.min(100, Math.round((capacityKwh / nominalKwh) * 100)));
    }
    const cc = num(ld.CycleCount ?? ld.ic_status?.cyclecount ?? ld.ic_status?.['Cycle Count']);
    if (cc) cyclesTotal = Math.round(cc);
  } catch {
    /* health unavailable */
  }

  const b = bufs.sonnen;
  return {
    id: 'sonnen',
    name: 'Sonnen',
    vendor: 'sonnenBatterie · eco',
    role: 'Self-consumption actuator',
    online,
    soc,
    kwh,
    usableKwh,
    nominalKwh,
    power: { kw, dir },
    maxKw,
    mode: pretty(mode),
    hasBackup: false,
    reservePct: null,
    backupKwh: null,
    backupHours: null,
    island: null,
    stormMode: null,
    exportRule: null,
    gridChargeAllowed: null,
    headroomKwh: round(Math.max(0, usableKwh - kwh), 1),
    aboveReserveKwh: null,
    health,
    capacityKwh,
    cyclesTotal,
    throughputKwh: null,
    roundTripPct: null,
    tempC: null,
    warrantyPct: null,
    installedYear: null,
    todayInKwh: round(b.todayIn, 1),
    todayOutKwh: round(b.todayOut, 1),
    socDay: fillSoc(b),
    chargeKwDay: powerSeries(b.chargeKw),
    dischargeKwDay: powerSeries(b.dischargeKw),
    specs: [
      { label: 'Type', value: 'sonnenBatterie eco' },
      { label: 'Chemistry', value: 'LFP (LiFePO₄)' },
      { label: 'Usable capacity', value: `${usableKwh} kWh` },
      { label: 'Nominal capacity', value: `${nominalKwh} kWh` },
      { label: 'Max power', value: `${maxKw} kW` },
      { label: 'Backup module', value: 'Not installed' },
      { label: 'Connection', value: 'Local API · VPN' },
      { label: 'Role', value: 'Fast self-consumption actuator' },
    ],
  };
}

async function buildTesla(): Promise<BatteryDetail> {
  const usableKwh = config.assets.teslaUsableKwh;
  const maxKw = config.assets.teslaMaxKw;

  let soc = 0;
  let kwh = 0;
  let kw = 0;
  let dir: Dir = 'idle';
  let mode = 'self_consumption';
  let online = false;
  let reservePct = 20;
  let backupKwh: number | null = null;
  let backupHours: number | null = null;
  let island = false;

  try {
    const t = await tesla.getNormalized();
    soc = t.soc;
    kwh = t.kwh;
    kw = t.kw;
    dir = t.dir;
    mode = t.mode ?? 'self_consumption';
    online = true;
    reservePct = t.reservePct;
    backupKwh = t.backupKwh;
    backupHours = t.backupHours;
    island = t.island;
    sample('tesla', soc, kw, dir);
  } catch {
    /* offline — keep zeros */
  }

  let stormMode: boolean | null = null;
  let exportRule: string | null = null;
  let gridChargeAllowed: boolean | null = null;
  let batteryCount = 2;
  let nominalKwh: number = usableKwh;

  try {
    const live = (await tesla.getLiveStatus()) as { storm_mode_active?: boolean };
    if (typeof live.storm_mode_active === 'boolean') stormMode = live.storm_mode_active;
  } catch {
    /* storm unknown */
  }
  try {
    const info = (await tesla.getSiteInfo()) as {
      customer_preferred_export_rule?: string;
      disallow_charge_from_grid_with_solar_installed?: boolean;
      battery_count?: number;
      nameplate_energy?: number;
      components?: { customer_preferred_export_rule?: string; disallow_charge_from_grid_with_solar_installed?: boolean };
    };
    exportRule = info.customer_preferred_export_rule ?? info.components?.customer_preferred_export_rule ?? null;
    const disallow =
      info.disallow_charge_from_grid_with_solar_installed ??
      info.components?.disallow_charge_from_grid_with_solar_installed;
    if (typeof disallow === 'boolean') gridChargeAllowed = !disallow;
    if (typeof info.battery_count === 'number' && info.battery_count > 0) batteryCount = info.battery_count;
    if (typeof info.nameplate_energy === 'number' && info.nameplate_energy > 0) {
      nominalKwh = round(info.nameplate_energy > 1000 ? info.nameplate_energy / 1000 : info.nameplate_energy, 1);
    }
  } catch {
    /* site info unavailable */
  }

  const b = bufs.tesla;
  return {
    id: 'tesla',
    name: 'Tesla Powerwall',
    vendor: `Tesla · ${batteryCount}× Powerwall 3`,
    role: 'Backup + policy',
    online,
    soc,
    kwh,
    usableKwh,
    nominalKwh,
    power: { kw, dir },
    maxKw,
    mode: pretty(mode),
    hasBackup: true,
    reservePct,
    backupKwh,
    backupHours,
    island,
    stormMode,
    exportRule: exportRule ? pretty(exportRule) : null,
    gridChargeAllowed,
    headroomKwh: round(Math.max(0, usableKwh - kwh), 1),
    aboveReserveKwh: round(Math.max(0, ((soc - reservePct) / 100) * usableKwh), 1),
    health: null,
    capacityKwh: null,
    cyclesTotal: null,
    throughputKwh: null,
    roundTripPct: null,
    tempC: null,
    warrantyPct: null,
    installedYear: null,
    todayInKwh: round(b.todayIn, 1),
    todayOutKwh: round(b.todayOut, 1),
    socDay: fillSoc(b),
    chargeKwDay: powerSeries(b.chargeKw),
    dischargeKwDay: powerSeries(b.dischargeKw),
    specs: [
      { label: 'Type', value: `${batteryCount}× Powerwall 3` },
      { label: 'Chemistry', value: 'NMC' },
      { label: 'Usable capacity', value: `${usableKwh} kWh` },
      { label: 'Max power', value: `${maxKw} kW` },
      { label: 'Backup', value: 'Whole-home · islanding' },
      { label: 'Export rule', value: exportRule ? pretty(exportRule) : '—' },
      { label: 'Connection', value: 'Fleet API · cloud' },
      { label: 'Role', value: 'Holds backup reserve + policy' },
    ],
  };
}

export async function getBatteries(): Promise<BatteriesResponse> {
  const [s, t] = await Promise.all([buildSonnen(), buildTesla()]);
  const batteries = [s, t];
  const storedKwh = round(s.kwh + t.kwh, 1);
  const usableKwh = round(s.usableKwh + t.usableKwh, 1);
  const soc = usableKwh > 0 ? Math.round((storedKwh / usableKwh) * 100) : 0;
  return {
    ts: new Date().toISOString(),
    combined: { usableKwh, storedKwh, soc },
    batteries,
  };
}
