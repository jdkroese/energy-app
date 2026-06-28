// Battery-control HTTP surface. All handlers require auth (mounted after the
// requireAuth gate); arm/command/apply are additionally admin-gated at the route.

import * as sonnen from '../connectors/sonnen';
import * as tesla from '../connectors/tesla';
import * as store from '../store';
import type { ControlDevice, ControlMode } from '../store';
import { issue, type IssueValue } from '../control/execute';
import { applyActiveScenario, revertToSafe } from '../control/coordinator';
import { takeSnapshot } from '../control/snapshot';
import type { Lever } from '../control/guardrails';

function badInput(msg: string): Error & { code: string } {
  const e = new Error(msg) as Error & { code: string };
  e.code = 'BAD_INPUT';
  return e;
}

/** Current arm state + device read-back + guardrails + log. */
export async function getStatus(): Promise<unknown> {
  const ctrl = store.get().control;
  const [tRes, sRes] = await Promise.allSettled([
    tesla.readControlConfig(),
    sonnen.readControlConfig(),
  ]);
  const t = tRes.status === 'fulfilled' ? tRes.value : null;
  const s = sRes.status === 'fulfilled' ? sRes.value : null;

  return {
    ts: new Date().toISOString(),
    armed: ctrl.armed,
    mode: ctrl.mode,
    lastError: ctrl.lastError,
    current: {
      tesla: t
        ? {
            mode: t.mode,
            reservePct: t.reservePct,
            gridChargeAllowed: t.gridChargeAllowed,
            exportRule: t.exportRule,
          }
        : { offline: true },
      sonnen: s ? { mode: s.mode } : { offline: true },
    },
    guardrails: ctrl.guardrails,
    batteryPriority: ctrl.batteryPriority,
    soakExport: ctrl.soakExport,
    log: ctrl.log,
    // Tariff-arbitrage effectiveness: cumulative headline stats + recent events (the durable
    // unbounded record is the JSONL file; this is the in-state ring for the UI history).
    arbitrageStats: ctrl.arbitrageStats,
    arbitrageLog: ctrl.arbitrageLog.slice(-50),
  };
}

/** Recent tariff-arbitrage events + cumulative stats (reads the in-state ring). The optional
 *  `limit` (1..200) trims the returned events; defaults to 50. Any authed user (read-only). */
export function getArbitrageLog(limit?: number): unknown {
  const ctrl = store.get().control;
  const n = typeof limit === 'number' && Number.isFinite(limit) ? Math.min(200, Math.max(1, Math.round(limit))) : 50;
  return {
    ts: new Date().toISOString(),
    stats: ctrl.arbitrageStats,
    events: ctrl.arbitrageLog.slice(-n),
  };
}

/** Update one battery-priority rule (admin). Returns the full control status. */
export async function setBatteryPriority(
  rule: 'dischargeSonnenFirst' | 'chargeTeslaFirst',
  patch: Partial<store.BatteryPriorityRule>,
): Promise<unknown> {
  if (rule !== 'dischargeSonnenFirst' && rule !== 'chargeTeslaFirst') {
    throw badInput('rule must be dischargeSonnenFirst|chargeTeslaFirst');
  }
  store.update((st) => {
    const r = st.control.batteryPriority[rule];
    if (typeof patch.enabled === 'boolean') r.enabled = patch.enabled;
    if (patch.authority === 'auto' || patch.authority === 'shadow') r.authority = patch.authority;
    if (typeof patch.throughputKw === 'number' && Number.isFinite(patch.throughputKw)) {
      r.throughputKw = Math.min(14, Math.max(0, patch.throughputKw));
    }
    st.control.updatedAt = Date.now();
  });
  return getStatus();
}

/** Update the surplus-soak (force-charge-to-soak-export) rule (admin). Clamps each
 *  field and enforces the hysteresis invariant startW > stopW. Returns full status. */
export async function setSoakExport(patch: Partial<store.SoakExportRule>): Promise<unknown> {
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  store.update((st) => {
    const r = st.control.soakExport;
    if (typeof patch.enabled === 'boolean') r.enabled = patch.enabled;
    if (typeof patch.startW === 'number' && Number.isFinite(patch.startW)) {
      r.startW = clamp(Math.round(patch.startW), 0, 4600);
    }
    if (typeof patch.stopW === 'number' && Number.isFinite(patch.stopW)) {
      r.stopW = clamp(Math.round(patch.stopW), 0, 4600);
    }
    if (typeof patch.socCeilingPct === 'number' && Number.isFinite(patch.socCeilingPct)) {
      r.socCeilingPct = clamp(Math.round(patch.socCeilingPct), 50, 100);
    }
    // Invariant: stop must sit below start (hysteresis deadband). Gently pull stopW
    // under startW rather than rejecting the whole patch.
    if (r.stopW >= r.startW) r.stopW = Math.max(0, r.startW - 1);
    st.control.updatedAt = Date.now();
  });
  return getStatus();
}

/** Set arm state. Disarming (or mode->'off') triggers revert-to-safe. */
export async function setArm(armed: boolean, mode?: ControlMode): Promise<unknown> {
  const validModes: ControlMode[] = ['off', 'manual', 'auto'];
  const nextMode: ControlMode = mode && validModes.includes(mode) ? mode : armed ? 'manual' : 'off';

  const disarming = !armed || nextMode === 'off';

  if (disarming) {
    // revertToSafe handles the writes and forces the store to DISARMED/off.
    await revertToSafe('disarm: revert-to-safe');
  } else {
    store.update((st) => {
      st.control.armed = true;
      st.control.mode = nextMode;
      st.control.updatedAt = Date.now();
      st.control.lastError = null;
    });
  }
  return getStatus();
}

/** One guardrailed manual command. */
export async function command(
  device: ControlDevice,
  lever: Lever,
  rawValue: unknown,
): Promise<unknown> {
  if (device !== 'sonnen' && device !== 'tesla') throw badInput('device must be sonnen|tesla');
  const levers: Lever[] = ['mode', 'reserve', 'charge', 'discharge', 'gridExport'];
  if (!levers.includes(lever)) throw badInput(`lever must be one of ${levers.join('|')}`);

  let value: IssueValue;
  if (lever === 'gridExport') {
    const v = (rawValue ?? {}) as { enableGridCharge?: boolean; exportRule?: string };
    const exportRule = (v.exportRule ?? 'pv_only') as tesla.TeslaExportRule;
    value = { enableGridCharge: Boolean(v.enableGridCharge), exportRule };
  } else if (lever === 'mode') {
    value = String(rawValue);
  } else {
    value = Number(rawValue);
    if (Number.isNaN(value)) throw badInput('value must be a number');
  }

  const snap = await takeSnapshot();
  const result = await issue(device, lever, value, 'manual command', snap);
  // Return the full control status (same shape as /arm) so the web client can
  // setStatus() the response without crashing on a missing `current`/`guardrails`.
  // The issue `result` rides along so the UI can toast confirm/reject + reason.
  const status = (await getStatus()) as Record<string, unknown>;
  return { ...status, result };
}

/** Push the ACTIVE scenario's target settings to the devices. Requires armed+!off. */
export async function applyScenarioToDevices(): Promise<unknown> {
  const ctrl = store.get().control;
  if (!ctrl.armed || ctrl.mode === 'off') {
    throw badInput('control is disarmed — arm (mode manual|auto) before applying a scenario');
  }
  const snap = await takeSnapshot();
  await applyActiveScenario(snap, 'apply-scenario');
  return getStatus();
}
