/* ============================================================================
 * health.ts — one shared client-side health derivation for the System Status
 * board (docs/36 §3). Device shapes differ per subsystem, so we normalize each
 * subsystem into a common { id, name, state, reason } item rather than forcing a
 * single union. Every row + the summary banner reuse these.
 *
 * State severity (worst wins on a rollup):
 *   error  — subsystem lastError/fleetError, connector offline, rejected command
 *   offline — online:false / zone available:false
 *   warning — lowBattery, voltage out-of-band, stale snapshot, stuck override
 *   nosetup — discovered-but-not-configured (dim)
 *   ok     — online, no error, data fresh
 * ==========================================================================*/

import type {
  DeviceView,
  LightUnit,
  BlindUnit,
  SonosSpeaker,
  IrrigationZone,
  BatteryDetail,
  ConfiguredDeviceView,
} from './types';

export type HealthState = 'ok' | 'warning' | 'error' | 'offline' | 'nosetup';

export interface Health {
  state: HealthState;
  reason: string;
}

export interface HealthItem {
  id: string;
  name: string;
  state: HealthState;
  reason: string;
}

export interface SubsystemRollup {
  worst: HealthState;
  online: number;
  total: number;
  issues: HealthItem[];
}

/** Rank for "worst wins". Higher = more severe. `nosetup` sits below `ok` so a
 *  fleet of fine devices with one un-set-up one still reads healthy overall. */
const SEVERITY: Record<HealthState, number> = {
  nosetup: 0,
  ok: 1,
  warning: 2,
  offline: 3,
  error: 4,
};

/** True for any state that should surface as an "issue" (floats to top of a row). */
export function isIssue(state: HealthState): boolean {
  return state === 'warning' || state === 'offline' || state === 'error';
}

/** Map a health state → a StatusDot tone. Offline is a problem the owner should
 *  see, so it gets the amber `grid` tone (not the muted grey) — only `nosetup`
 *  (discovered-but-not-configured, not a fault) stays muted. Hard faults (fleet
 *  error / rejected command) are red `danger`. */
export function healthTone(
  state: HealthState,
): 'solar' | 'grid' | 'danger' | 'offline' {
  switch (state) {
    case 'ok':
      return 'solar';
    case 'warning':
    case 'offline':
      return 'grid';
    case 'error':
      return 'danger';
    case 'nosetup':
    default:
      return 'offline';
  }
}

/** Worst (most severe) of a set of states; defaults to `ok` when empty. */
export function worstState(states: HealthState[]): HealthState {
  return states.reduce<HealthState>(
    (worst, s) => (SEVERITY[s] > SEVERITY[worst] ? s : worst),
    'ok',
  );
}

/* ---- per-subsystem normalizers → Health -----------------------------------
 * Each takes a device-shaped value and returns { state, reason }. A subsystem
 * level error (fleetError / lastError) is layered on in subsystemRollup, since
 * it applies to the whole fleet, not a single device. */

/** Climate (Intesis/Panasonic + Airzone) — DeviceView. */
export function climateHealth(d: DeviceView): Health {
  if (!d.online) return { state: 'offline', reason: 'Offline' };
  if (d.lowBattery) return { state: 'warning', reason: 'Thermostat low battery' };
  return { state: 'ok', reason: 'Online' };
}

/** Lighting — LightUnit. */
export function lightHealth(d: LightUnit): Health {
  if (!d.online) return { state: 'offline', reason: 'Offline' };
  return { state: 'ok', reason: d.power ? 'On' : 'Off' };
}

/** Blinds — BlindUnit. */
export function blindHealth(d: BlindUnit): Health {
  if (!d.online) return { state: 'offline', reason: 'Offline' };
  if (d.positionMode === 'timed' && d.anchored === false)
    return { state: 'warning', reason: 'Position unknown — re-anchor needed' };
  return { state: 'ok', reason: 'Online' };
}

/** Speakers — SonosSpeaker. */
export function speakerHealth(d: SonosSpeaker): Health {
  if (!d.online) return { state: 'offline', reason: 'Offline' };
  return { state: 'ok', reason: 'Online' };
}

/** Irrigation — IrrigationZone (uses `available` as the reachability signal). */
export function irrigationHealth(d: IrrigationZone): Health {
  if (!d.available) return { state: 'offline', reason: 'Unavailable' };
  return { state: 'ok', reason: d.active ? 'Running' : 'Idle' };
}

/** Batteries — BatteryDetail. */
export function batteryHealth(d: BatteryDetail): Health {
  if (!d.online) return { state: 'offline', reason: 'Offline' };
  if (d.health != null && d.health < 70)
    return { state: 'warning', reason: `Health ${Math.round(d.health)}%` };
  return { state: 'ok', reason: 'Online' };
}

/** Circuits — configured Tuya generic devices. */
export function circuitHealth(d: ConfiguredDeviceView): Health {
  if (!d.online) return { state: 'offline', reason: 'Offline' };
  return { state: 'ok', reason: 'Online' };
}

/* ---- rollup ---------------------------------------------------------------- */

export interface RollupInput {
  id: string;
  name: string;
  health: Health;
}

/**
 * Roll a subsystem's per-device items up to a { worst, online, total, issues }.
 * A subsystem-level `fleetError`/`lastError` is passed as `fleetError` — it forces
 * the worst to at least `error` and is surfaced as a synthetic top issue.
 */
export function subsystemRollup(
  items: RollupInput[],
  opts: { fleetError?: string | null; online?: number; total?: number } = {},
): SubsystemRollup {
  const total = opts.total ?? items.length;
  const online = opts.online ?? items.filter((i) => i.health.state !== 'offline').length;
  const issues: HealthItem[] = items
    .filter((i) => isIssue(i.health.state))
    .map((i) => ({ id: i.id, name: i.name, state: i.health.state, reason: i.health.reason }));

  let worst = worstState(items.map((i) => i.health.state));

  if (opts.fleetError) {
    worst = worstState([worst, 'error']);
    // Surface the fleet error as the first issue so the row header reflects it.
    issues.unshift({
      id: '__fleet__',
      name: 'Connector',
      state: 'error',
      reason: opts.fleetError,
    });
  }

  // Issues sorted worst-first for the "float to top" behaviour.
  issues.sort((a, b) => SEVERITY[b.state] - SEVERITY[a.state]);

  return { worst, online, total, issues };
}
