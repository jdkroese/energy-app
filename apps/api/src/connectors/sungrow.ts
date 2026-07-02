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
import { logEvent } from '../events';

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
  /**
   * True when THIS poll's raw AC-power reading was physically impossible (> the
   * plausibility ceiling for this inverter, e.g. a WiNet-S catch-up spike after a
   * brief reconnect) and was therefore dropped. acPowerW is forced to 0 so the bad
   * value never inflates the production sum, and callers skip it when writing
   * per-inverter power history. Yield/temp/faults/work-state from the poll are kept.
   */
  powerRejected?: boolean;
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

// ---- Per-inverter plausibility bound --------------------------------------
// The WiNet-S dongle occasionally emits a garbage/doubled active-power value after a
// brief reconnect (a "catch-up" sample), which — with no bound in the pipeline — got
// summed into solarKw and drawn verbatim (e.g. a physically-impossible ~15.6 kW single
// sample at 18:25 with the sun already low). Each SG5.0RS is rated 5.0 kW AC, so any
// reading more than 10% over rated is impossible and must be dropped for that poll.
const DEFAULT_RATED_KW = 5.0; // SG5.0RS nameplate AC rating.
const PLAUSIBILITY_MARGIN = 1.1; // Allow a 10% over-rated headroom (brief boost) before rejecting.

/**
 * Is this AC-power reading (W) physically plausible for an inverter of `ratedKw`?
 * A reading at/under ratedKw × 1.1 is accepted; anything higher is a bad sample.
 * Pure + side-effect-free so it can be unit-tested directly.
 */
export function plausibleAcPowerW(acPowerW: number, ratedKw = DEFAULT_RATED_KW): boolean {
  if (!Number.isFinite(acPowerW)) return false;
  return acPowerW <= ratedKw * PLAUSIBILITY_MARGIN * 1000;
}

/** Round to 1 decimal (for the rejection-event payload). */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

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
interface LiveVals {
  acPowerW: number;
  dailyKwh: number;
  totalKwh: number;
  tempC: number | null;
  workState: string;
}

/** Grace after `real` arrives to also collect the `fault` list before resolving. */
const FAULT_GRACE_MS = 2500;

async function wsReadLive(ip: string): Promise<LiveVals & { faults: InverterFault[] }> {
  const url = `ws://${ip}:${WS_PORT}/ws/home/overview`;

  return await new Promise((resolve, reject) => {
    const ws = new WsWebSocket(url);
    let settled = false;
    let token = '';
    let devId: number | null = null;
    let liveVals: LiveVals | null = null;
    let faultGrace: ReturnType<typeof setTimeout> | null = null;

    const done = (err: Error | null, val?: LiveVals & { faults: InverterFault[] }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (faultGrace) clearTimeout(faultGrace);
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
        // Parse live values, then ask for the fault log on the SAME session (the dongle
        // rate-limits guest sessions, so we don't open a second socket). Resolve when
        // faults arrive, or after a short grace if they don't.
        liveVals = parseRealList(data.list);
        send({ lang: 'en_us', token, service: 'fault', dev_id: String(devId ?? 1), type: '0', count: '20' });
        faultGrace = setTimeout(() => {
          if (liveVals) done(null, { ...liveVals, faults: [] });
        }, FAULT_GRACE_MS);
        return;
      }

      if (service === 'fault') {
        const faults = Array.isArray(data.list) ? parseFaultList(data.list) : [];
        if (liveVals) done(null, { ...liveVals, faults });
        return;
      }

      // Dongle rate-limit / other notice — resolve with the live values we already have.
      if ((service === 'notice' || msg.result_code === 100) && liveVals) {
        done(null, { ...liveVals, faults: [] });
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
function parseRealList(list: Array<Record<string, unknown>>): LiveVals {
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

  return { acPowerW: Math.max(0, Math.round(acPowerW)), dailyKwh, totalKwh, tempC, workState };
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

// ---- Fault/alarm log (WiNet-S WebSocket `service:'fault'`) ------------------
// Live-confirmed (2026-07-02): faults come over the SAME WebSocket, not REST —
// `{service:'connect'}` → `{service:'devicelist'}` → `{service:'fault', dev_id}` →
// `result_data.list` of fault rows (empty when healthy). wsReadLive() issues the
// fault query in-session and hands the rows here. Fields (docs/36): Alarm Name ·
// Type · Status (Active/Closed) · Fault Code · Fault ID · Time — parsed tolerantly
// since the exact row keys weren't observable while the list was empty.

const REST_TIMEOUT_MS = 8000;

/** Parse the WS `fault` list into InverterFaults (fail-soft, tolerant). */
function parseFaultList(rows: unknown[]): InverterFault[] {
  const faults: InverterFault[] = [];
  for (const r of rows) {
    if (r && typeof r === 'object') {
      const f = parseFaultRow(r as Record<string, unknown>);
      if (f) faults.push(f);
    }
  }
  return faults;
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
  const rawName = g('faultName', 'alarmName', 'name', 'faulttype', 'dataname');
  if (rawName == null) return null;
  const type = String(g('faultType', 'alarmType', 'type') ?? 'Fault');
  const status = String(g('status', 'faultStatus', 'dealStatus') ?? 'Active');
  const code = num(g('faultCode', 'code'));
  const id = num(g('faultId', 'faultID', 'id'));
  const timeRaw = g('faultTime', 'time', 'occurTime', 'happenTime', 'timestamp');
  let time: string;
  if (typeof timeRaw === 'number') time = new Date(timeRaw < 1e12 ? timeRaw * 1000 : timeRaw).toISOString();
  else time = String(timeRaw ?? new Date().toISOString());
  return { name: prettyFaultName(String(rawName)), type, status, code, id, time };
}

/** WiNet often returns names as raw I18N keys (e.g. "I18N_COMMON_GRID_UNDERVOLTAGE").
 *  Prettify to "Grid Undervoltage"; pass through already-human strings unchanged. */
function prettyFaultName(raw: string): string {
  if (!/^i18n[_a-z0-9]*$/i.test(raw)) return raw;
  const words = raw
    .replace(/^I18N[_]?/i, '')
    .replace(/^COMMON[_]?/i, '')
    .split(/[_\s]+/)
    .filter(Boolean);
  if (words.length === 0) return raw;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
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

  // Live values + fault log come from ONE WebSocket session (fail-soft; a throw =
  // unreachable). The dongle rate-limits guest sockets, so we never open a second one.
  try {
    const v = await wsReadLive(ip);
    // Per-inverter plausibility guard: a WiNet-S catch-up spike can report an AC power
    // far above the inverter's rating. Keep everything ELSE from the poll (yield/temp/
    // faults/work-state are unaffected by the bad power field) but drop this power
    // sample so it can't inflate the production sum or land in per-inverter history.
    const ratedKw = dongle.ratedKw ?? DEFAULT_RATED_KW;
    if (plausibleAcPowerW(v.acPowerW, ratedKw)) {
      base.acPowerW = v.acPowerW;
    } else {
      base.acPowerW = 0;
      base.powerRejected = true;
      const ceilingKw = ratedKw * PLAUSIBILITY_MARGIN;
      // Fail-soft: a logging hiccup must never make a healthy inverter read unreachable.
      try {
        logEvent({
          class: 'observation',
          category: 'solar',
          severity: 'medium',
          summary: `Implausible solar reading dropped — ${name} ${(v.acPowerW / 1000).toFixed(1)} kW`,
          trigger: {
            source: 'threshold',
            detail: `> ${ceilingKw.toFixed(1)} kW (rated ${ratedKw} kW ×${PLAUSIBILITY_MARGIN})`,
          },
          device: name,
          entity: 'inverter.acKw',
          detail:
            `Sungrow ${name} (${ip}) reported ${(v.acPowerW / 1000).toFixed(2)} kW AC — above the ` +
            `${ceilingKw.toFixed(1)} kW plausibility ceiling (likely a WiNet-S catch-up spike). ` +
            `This poll's power was excluded from production; yield/temp/faults kept.`,
          data: { ip, reportedKw: round1(v.acPowerW / 1000), ceilingKw: round1(ceilingKw), ratedKw },
          noNotify: true,
        });
      } catch {
        /* logging is best-effort — never block or fail the read */
      }
    }
    base.dailyKwh = v.dailyKwh;
    base.totalKwh = v.totalKwh;
    base.tempC = v.tempC;
    base.workState = v.workState;
    base.faults = v.faults;
    base.reachable = true;
    const now = new Date().toISOString();
    base.lastSeen = now;
    lastSeenByIp.set(ip, now);
  } catch (e) {
    base.detail = (e as Error)?.message ?? 'unreachable';
  }

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
