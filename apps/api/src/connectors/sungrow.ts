// Sungrow SG5.0RS string-inverter connector (2× units, each behind its own WiNet-S
// WiFi dongle). READ-ONLY: reads live production + health + the fault/alarm log per
// dongle and normalizes them for /api/live, the alerts subsystem, and per-inverter
// history. Touches NO control/armed/battery path — a fault here can never crash the
// armed control loop (every entry point is fail-soft and cached()).
//
// Data path (docs/36): the WiNet-S dongle serves BOTH
//   • a local REST envelope `{ result_code, result_msg, result_data }` — used for the
//     product probe and the queryable fault/alarm log, and
//   • a local WebSocket `ws://<ip>:8082/ws/home/overview` — the realtime values
//     (active power, daily/total yield, temp, work-state).
// Modbus TCP (502) is the documented richer path but is not enabled on these dongles
// yet (owner action). We build the WS+REST path as primary and keep the normalized
// shape Modbus-ready so a Modbus reader can slot in behind the same interface later.
//
// Live-calibrate on the mini after deploy: the build env can't reach the Spain LAN,
// so parsing is deliberately tolerant/fail-soft and keyed off the confirmed shapes
// (docs/36 live discovery 2026-07-02). See the PR checklist.

import { WebSocket as WsWebSocket } from 'ws';
import { cached } from '../cache';
import { sungrowConfig, type SungrowDongle } from '../runtime-config';

// ---- Normalized shapes (also the Modbus-ready interface) -------------------

export interface InverterFault {
  /** e.g. "Grid Undervoltage". */
  name: string;
  /** 'Fault' (protection trip) or 'Alarm' (soft). */
  type: string;
  /** 'Active' (currently raised) or 'Closed' (auto-recovered). */
  status: string;
  /** Stable numeric fault code (e.g. 2 for Grid Undervoltage), or null. */
  code: number | null;
  /** Fault ID (e.g. 4), or null. */
  id: number | null;
  /** ISO timestamp of the transition, or the raw string the dongle reported. */
  time: string;
}

export interface InverterNormalized {
  /** Stable id = the dongle IP (both COM names are identical "SG5.0RS(COM1-001)"). */
  id: string;
  /** Friendly name (config label, else "Solar Inverter <n>"). */
  name: string;
  ip: string;
  model: string;
  /** Live AC active power (W). 0 when reachable but not producing. */
  acPowerW: number;
  /** Today's yield (kWh). */
  dailyKwh: number;
  /** Lifetime yield (kWh). */
  totalKwh: number;
  /** Internal temp (°C), or null when not reported. */
  tempC: number | null;
  /** Device work-state label: 'Run' | 'Stop' | 'Standby' | 'Fault' | 'Alarm' | 'Derating' | 'Unknown'. */
  workState: string;
  /** Whether the dongle answered this poll. */
  reachable: boolean;
  /** ISO timestamp of the last successful read, or null if never seen this process. */
  lastSeen: string | null;
  /** Currently-Active faults/alarms from the dongle fault log (empty when healthy). */
  faults: InverterFault[];
  /** Short reason when unreachable / parse failed (for the UI + probe). */
  detail?: string;
}

export interface SungrowNormalized {
  inverters: InverterNormalized[];
  /** Sum of reachable inverters' AC power (W). */
  productionW: number;
}

// ---- WiNet-S WebSocket protocol -------------------------------------------
// Reverse-engineered open protocol (PyPI `sungrow-websocket`, bohdan-s/
// SungrowModbusWebClient, nItroTools/sungrow-go): connect → {service:'connect'}
// returns a token → {service:'devicelist'} lists devices → {service:'real'} per
// dev_id returns the live value list (localized name + value + unit). We reconnect
// with backoff and re-fetch the token on expiry; a single failed poll is soft.

interface WsEnvelope {
  result_code?: number;
  result_msg?: string;
  result_data?: {
    service?: string;
    token?: string;
    list?: Array<Record<string, unknown>>;
    count?: number;
    // real-data services return { list: [{ data_name, data_value, data_unit }] }
  } & Record<string, unknown>;
}

const WS_PORT = 8082;
const WS_TIMEOUT_MS = 9000;

// We use the `ws` package's WebSocket rather than a runtime global: the mini's
// launchd Node runtime does not expose a global `WebSocket` (Node < 21), so the old
// `globalThis.WebSocket` path threw on every poll → both dongles read "offline"
// despite REST /product/list succeeding. `ws` works on any Node and is bundled by
// esbuild (pure JS, no native binary → no vendoring needed). (2026-07-02 live debug.)

/** Pick a numeric value out of a WiNet real-data item, tolerating "3.94"/"--"/units. */
function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '' || t === '--' || t.toLowerCase() === 'n/a') return null;
    const n = Number(t.replace(/[^\d.+-]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Run one WiNet-S WebSocket session against a dongle: connect, get a token, list
 * devices, and pull the real-data list for the first (only) inverter device. Returns
 * the parsed live values or throws (caller treats a throw as "unreachable"). The
 * socket is always closed before returning. Bounded by WS_TIMEOUT_MS end-to-end.
 */
async function wsReadLive(ip: string): Promise<{
  acPowerW: number;
  dailyKwh: number;
  totalKwh: number;
  tempC: number | null;
  workState: string;
}> {
  const url = `ws://${ip}:${WS_PORT}/ws/home/overview`;

  return await new Promise((resolve, reject) => {
    const ws = new WsWebSocket(url);
    let settled = false;
    let token = '';
    let devId: number | null = null;

    const done = (err: Error | null, val?: Awaited<ReturnType<typeof wsReadLive>>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else resolve(val!);
    };

    const timer = setTimeout(() => done(new Error(`WS timeout after ${WS_TIMEOUT_MS}ms`)), WS_TIMEOUT_MS);

    const send = (obj: Record<string, unknown>) => {
      try {
        ws.send(JSON.stringify(obj));
      } catch (e) {
        done(e as Error);
      }
    };

    ws.onopen = () => send({ lang: 'en_us', token: '', service: 'connect' });

    ws.onerror = () => done(new Error('WS error'));
    ws.onclose = () => done(new Error('WS closed before data'));

    ws.onmessage = (ev: { data: unknown }) => {
      let msg: WsEnvelope;
      try {
        // `ws` delivers text frames as a Buffer (or string); normalize to string.
        const text = typeof ev.data === 'string' ? ev.data : String(ev.data);
        msg = JSON.parse(text) as WsEnvelope;
      } catch {
        return; // ignore unparseable frames
      }
      const data = msg.result_data ?? {};
      const service = String(data.service ?? '');

      if (service === 'connect' && typeof data.token === 'string') {
        token = data.token;
        send({ lang: 'en_us', token, service: 'devicelist', type: '0', is_check_token: '0' });
        return;
      }

      if (service === 'devicelist' && Array.isArray(data.list)) {
        // Pick the first inverter-ish device; the SG5.0RS is the only device on the dongle.
        const dev = data.list.find((d) => d && (d.dev_type != null || d.dev_id != null)) ?? data.list[0];
        const id = dev ? num(dev.dev_id ?? dev.id) : null;
        devId = id;
        send({ lang: 'en_us', token, service: 'real', dev_id: String(id ?? 1) });
        return;
      }

      if ((service === 'real' || service === 'real_battery') && Array.isArray(data.list)) {
        resolveFromRealList(data.list, done, devId);
        return;
      }
    };
  });
}

/** Match a WiNet real-data item by a set of localized data_name substrings. */
function pick(list: Array<Record<string, unknown>>, keys: string[]): Record<string, unknown> | null {
  for (const item of list) {
    const name = String(item.data_name ?? item.name ?? '').toLowerCase();
    if (keys.some((k) => name.includes(k))) return item;
  }
  return null;
}

/** Parse the WiNet `real` value list into normalized live values. */
function resolveFromRealList(
  list: Array<Record<string, unknown>>,
  done: (err: Error | null, val?: { acPowerW: number; dailyKwh: number; totalKwh: number; tempC: number | null; workState: string }) => void,
  _devId: number | null,
): void {
  const valOf = (item: Record<string, unknown> | null) => (item ? num(item.data_value ?? item.value) : null);
  const unitOf = (item: Record<string, unknown> | null) => String(item?.data_unit ?? item?.unit ?? '').toLowerCase();

  // The WiNet `real` service returns raw I18N keys as data_name (e.g.
  // "I18N_COMMON_ACTIVE_POWER"), NOT localized labels (confirmed by live capture
  // 2026-07-02). Match the exact I18N key first, keep human-label substrings as a
  // fallback for other firmwares. `pick` lowercases, so keys are lowercase here.

  // Active power — reported in kW (unit field) on the SG5.0RS; scaled to W.
  // Exact key avoids matching I18N_COMMON_REACTIVE_POWER / _APPARENT_POWER.
  const powerItem = pick(list, ['i18n_common_active_power', 'active power', 'ac power', 'output power']);
  let acPowerW = valOf(powerItem) ?? 0;
  if (unitOf(powerItem).startsWith('kw')) acPowerW *= 1000;

  const dailyItem = pick(list, ['i18n_common_daily_power_yield', 'daily yield', 'today yield', 'daily energy']);
  const dailyKwh = valOf(dailyItem) ?? 0;

  const totalItem = pick(list, ['i18n_common_total_yield', 'total yield', 'total energy', 'lifetime']);
  const totalKwh = valOf(totalItem) ?? 0;

  const tempItem = pick(list, ['i18n_common_air_tem_inside_machine', 'air_tem', 'internal temperature', 'temperature']);
  const tempC = valOf(tempItem);

  // Running state value is itself an I18N key, e.g. "I18N_COMMON_STATUS_RUN".
  const stateItem = pick(list, ['i18n_common_running_state', 'running state', 'work state', 'device state', 'system state', 'state']);
  const workState = normalizeWorkState(stateItem ? String(stateItem.data_value ?? stateItem.value ?? '') : '');

  done(null, { acPowerW: Math.max(0, Math.round(acPowerW)), dailyKwh, totalKwh, tempC, workState });
}

/** Map a raw work-state string (or hex code) to a canonical label. */
function normalizeWorkState(raw: string): string {
  const t = raw.trim().toLowerCase();
  if (!t) return 'Unknown';
  if (t.includes('run')) return 'Run';
  if (t.includes('stop')) return 'Stop';
  if (t.includes('standby') || t.includes('wait')) return 'Standby';
  if (t.includes('fault')) return 'Fault';
  if (t.includes('alarm')) return 'Alarm';
  if (t.includes('derat')) return 'Derating';
  // Modbus-style hex codes (reg 5038), tolerated in case a future path passes them raw.
  const hex: Record<string, string> = {
    '0x0': 'Run', '0': 'Run',
    '0x8000': 'Stop', '32768': 'Stop',
    '0x1400': 'Standby', '5120': 'Standby',
    '0x5500': 'Fault', '21760': 'Fault',
    '0x9100': 'Alarm', '37120': 'Alarm',
    '0x8100': 'Derating', '33024': 'Derating',
  };
  return hex[t] ?? (raw.trim() || 'Unknown');
}

// ---- REST fault/alarm log --------------------------------------------------
// The WiNet-S SPA exposes the fault history under a local REST path returning the
// standard `{ result_code, result_msg, result_data }` envelope. The exact query path
// varies by firmware, so we try a small set of known candidates and parse tolerantly.
// Confirmed fields (docs/36): Device Name · Alarm Name · Alarm Type · Status · Time ·
// Fault Code · Fault ID. We keep only currently-Active entries + a bounded recent set.

const REST_TIMEOUT_MS = 8000;
const FAULT_PATHS = [
  '/device/faultList?lang=en_us',
  '/history/faultList?lang=en_us',
  '/device/getFaultList?lang=en_us',
  '/fault/list?lang=en_us',
];

async function getJson(url: string): Promise<WsEnvelope | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(REST_TIMEOUT_MS) });
    if (!res.ok) return null;
    return (await res.json()) as WsEnvelope;
  } catch {
    return null;
  }
}

/** Product probe — the confirmed-reachable open endpoint. Throws on failure. */
export async function probeProduct(ip: string): Promise<{ productName: string }> {
  const res = await fetch(`http://${ip}/product/list`, { signal: AbortSignal.timeout(REST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`product/list HTTP ${res.status}`);
  const j = (await res.json()) as WsEnvelope;
  if (j.result_code !== 1) throw new Error(`product/list result_code ${j.result_code}`);
  const name = String((j.result_data as { product_name?: unknown })?.product_name ?? 'WiNet-S');
  return { productName: name };
}

/** Parse one fault-log row (tolerant to field-name casing/localization) → InverterFault. */
function parseFaultRow(row: Record<string, unknown>): InverterFault | null {
  const g = (...keys: string[]): unknown => {
    for (const k of keys) {
      for (const rk of Object.keys(row)) {
        if (rk.toLowerCase().replace(/[_\s]/g, '') === k.toLowerCase().replace(/[_\s]/g, '')) return row[rk];
      }
    }
    return undefined;
  };
  const name = g('faultName', 'alarmName', 'name', 'faulttype', 'dataname');
  if (name == null) return null;
  const type = String(g('faultType', 'alarmType', 'type') ?? 'Fault');
  const status = String(g('status', 'faultStatus', 'dealStatus') ?? 'Active');
  const code = num(g('faultCode', 'code'));
  const id = num(g('faultId', 'faultID', 'id'));
  const timeRaw = g('faultTime', 'time', 'occurTime', 'happenTime', 'timestamp');
  let time: string;
  if (typeof timeRaw === 'number') time = new Date(timeRaw < 1e12 ? timeRaw * 1000 : timeRaw).toISOString();
  else time = String(timeRaw ?? new Date().toISOString());
  return { name: String(name), type, status, code, id, time };
}

/** Read the dongle fault log; returns [] on any failure (fail-soft). */
async function restReadFaults(ip: string): Promise<InverterFault[]> {
  for (const path of FAULT_PATHS) {
    const j = await getJson(`http://${ip}${path}`);
    if (!j || j.result_code !== 1) continue;
    const data = j.result_data ?? {};
    const rows =
      (Array.isArray(data.list) && data.list) ||
      (Array.isArray((data as { faultList?: unknown[] }).faultList) && (data as { faultList: unknown[] }).faultList) ||
      null;
    if (!rows) continue;
    const faults: InverterFault[] = [];
    for (const r of rows) {
      if (r && typeof r === 'object') {
        const f = parseFaultRow(r as Record<string, unknown>);
        if (f) faults.push(f);
      }
    }
    return faults;
  }
  return [];
}

/** Currently-Active faults only (case-insensitive on the status field). */
export function activeFaults(faults: InverterFault[]): InverterFault[] {
  return faults.filter((f) => f.status.toLowerCase().includes('active'));
}

// ---- Per-dongle read + normalize ------------------------------------------

const lastSeenByIp = new Map<string, string>();

async function readOne(dongle: SungrowDongle, index: number): Promise<InverterNormalized> {
  const { ip } = dongle;
  const name = dongle.name?.trim() || `Solar Inverter ${index + 1}`;
  const base: InverterNormalized = {
    id: ip,
    name,
    ip,
    model: 'SG5.0RS',
    acPowerW: 0,
    dailyKwh: 0,
    totalKwh: 0,
    tempC: null,
    workState: 'Unknown',
    reachable: false,
    lastSeen: lastSeenByIp.get(ip) ?? null,
    faults: [],
  };

  // Live values (WS) + fault log (REST) in parallel; each is independently fail-soft.
  const [liveRes, faultRes] = await Promise.allSettled([wsReadLive(ip), restReadFaults(ip)]);

  if (liveRes.status === 'fulfilled') {
    const v = liveRes.value;
    base.acPowerW = v.acPowerW;
    base.dailyKwh = v.dailyKwh;
    base.totalKwh = v.totalKwh;
    base.tempC = v.tempC;
    base.workState = v.workState;
    base.reachable = true;
    const now = new Date().toISOString();
    base.lastSeen = now;
    lastSeenByIp.set(ip, now);
  } else {
    base.detail = (liveRes.reason as Error)?.message ?? 'unreachable';
  }

  if (faultRes.status === 'fulfilled') base.faults = faultRes.value;

  return base;
}

/**
 * Read both dongles (parallel, independent) and normalize. cached() bounds upstream
 * volume regardless of how often /api/live + the alert loop poll. Never throws — a
 * per-dongle failure degrades that inverter to unreachable, the other still reports.
 */
export function getNormalized(): Promise<SungrowNormalized> {
  return cached('sungrow.normalized', 20_000, async () => {
    const dongles = sungrowConfig();
    const results = await Promise.all(dongles.map((d, i) => readOne(d, i)));
    const productionW = results.reduce((sum, inv) => sum + (inv.reachable ? inv.acPowerW : 0), 0);
    return { inverters: results, productionW };
  });
}

/** Invalidate-free lightweight read used by the health probe (reuses the cache). */
export async function getInverters(): Promise<InverterNormalized[]> {
  return (await getNormalized()).inverters;
}
