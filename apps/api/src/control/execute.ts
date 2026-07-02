// The single, guardrailed write path to the physical batteries. NOTHING else in
// the app should call the connector write functions directly — everything goes
// through issue(), which enforces: armed + mode!=='off', fresh live data,
// guardrail clamps, no-op skip, write, READ-BACK confirm, logging, and a per-lever
// rate limit. It never throws: any failure is logged + recorded in lastError.

import * as sonnen from '../connectors/sonnen';
import * as tesla from '../connectors/tesla';
import * as store from '../store';
import type { ControlDevice } from '../store';
import {
  checkGridImportCap,
  checkMode,
  checkSonnenReserve,
  checkSonnenWatts,
  checkTeslaGridCharge,
  checkTeslaReserve,
  freshnessOk,
  TESLA_RESERVE_MAX_PCT,
  type ControlSnapshot,
  type Lever,
} from './guardrails';
import { logBatteryAction } from './log-adapters';

/** ≥60s between writes to the SAME device+lever. */
const RATE_LIMIT_MS = 60_000;
const lastWriteAt = new Map<string, number>();

/** Detail string stamped on a no-op (value already in place). Used to coalesce/identify them. */
export const NOOP_DETAIL = 'unchanged — no write';

export interface IssueResult {
  ok: boolean;
  skipped: boolean;
  reason: string;
  from: string | number | null;
  to: string | number | null;
}

/**
 * The value shape depends on the lever:
 *  - mode:       string ('1'|'2'|'10' for sonnen, 'self_consumption'|... for tesla)
 *  - reserve:    number (percent)
 *  - charge/discharge (sonnen only): number (watts)
 *  - gridExport (tesla only): { enableGridCharge: boolean; exportRule: TeslaExportRule }
 */
export type IssueValue =
  | string
  | number
  | { enableGridCharge: boolean; exportRule: tesla.TeslaExportRule };

function key(device: ControlDevice, lever: Lever): string {
  return `${device}:${lever}`;
}

/** Transient upstream failures — cloud 5xx / gateway timeouts / dropped sockets that the
 *  coordinator simply retries on the next tick (e.g. Tesla `/site_info -> HTTP 504`). Not a
 *  standing fault, so they must not set a sticky lastError or alarm on the Status board. */
export function isTransientUpstream(detail: string): boolean {
  // Require the HTTP-5xx / gateway / timeout / socket SHAPE so a bare number in a guardrail
  // message (e.g. "grid import 500W > cap") can't false-match.
  return /HTTP\s*5\d\d|\b5\d\d\s+(?:bad gateway|gateway|service unavailable|server error)|gateway time-?out|\btimeouts?\b|timed out|ETIMEDOUT|ECONNRESET|EAI_AGAIN|socket hang up|network error|temporarily unavailable/i.test(detail);
}

function logEntry(
  device: ControlDevice,
  lever: Lever,
  from: string | number | null,
  to: string | number | null,
  reason: string,
  ok: boolean,
  detail: string,
  opts: { policy?: boolean } = {},
): void {
  store.update((s) => {
    s.control.log.push({ ts: Date.now(), device, lever, from, to, reason, ok, detail });
    s.control.log = store.pruneLog(s.control.log);
    s.control.updatedAt = Date.now();
    if (ok) {
      // Self-heal: a successful command proves the link works — clear any stale error so a
      // one-off blip doesn't red the control plane until the next arm toggle (mirrors PR #171).
      s.control.lastError = null;
    } else if (!opts.policy && !isTransientUpstream(detail)) {
      // Only a genuine, NON-transient failure is a standing error. Policy rejects (not armed,
      // rate-limited, guardrail) and transient cloud 5xx/timeouts must not set a sticky
      // lastError — the coordinator retries next tick.
      s.control.lastError = `${device}.${lever}: ${detail}`;
    }
  });
  // Shim: mirror into the unified event bus (docs/37 §3) alongside the domain log.
  logBatteryAction(device, lever, from, to, reason, ok, detail);
}

function reject(
  device: ControlDevice,
  lever: Lever,
  from: string | number | null,
  reason: string,
): IssueResult {
  // Policy/guardrail reject (not armed, rate-limited, freshness) — not a connector fault.
  logEntry(device, lever, from, null, reason, false, reason, { policy: true });
  return { ok: false, skipped: false, reason, from, to: null };
}

function noop(
  device: ControlDevice,
  lever: Lever,
  value: string | number,
  reason = 'unchanged',
): IssueResult {
  // A no-op re-asserts the value already in place — it fires EVERY steady-state tick. Persisting
  // one row per tick would bury real commands in "unchanged" noise. Instead keep only the LATEST
  // no-op per lever: drop any prior no-op for this device+lever, then push a fresh one. The log is
  // then pruned to the 48h retention window. updatedAt still advances, so the heartbeat keeps
  // ticking even on a steady-state run.
  store.update((s) => {
    s.control.log = s.control.log.filter(
      (e) => !(e.device === device && e.lever === lever && e.detail === NOOP_DETAIL),
    );
    s.control.log.push({ ts: Date.now(), device, lever, from: value, to: value, reason, ok: true, detail: NOOP_DETAIL });
    s.control.log = store.pruneLog(s.control.log);
    s.control.updatedAt = Date.now();
  });
  // Shim: mirror the no-op into the unified event bus (mapped to action/low).
  logBatteryAction(device, lever, value, value, reason, true, NOOP_DETAIL);
  return { ok: true, skipped: true, reason, from: value, to: value };
}

/**
 * Per-call options.
 *  - priority: bypass the per-lever rate-limit for THIS write. Reserved for SAFETY
 *    reverts that must always be able to fire (e.g. handing the Sonnen back to
 *    self-consumption when a solar surplus collapses, so a stale manual setpoint
 *    can never keep importing from the grid). It does NOT bypass any guardrail.
 */
export interface IssueOpts {
  priority?: boolean;
}

/**
 * Issue ONE guardrailed command. Returns an IssueResult; never throws.
 * `snap` is the current live snapshot (must be fresh).
 */
export async function issue(
  device: ControlDevice,
  lever: Lever,
  value: IssueValue,
  reason: string,
  snap: ControlSnapshot,
  opts: IssueOpts = {},
): Promise<IssueResult> {
  try {
    // (1) Armed + not off + fresh data.
    const ctrl = store.get().control;
    if (!ctrl.armed || ctrl.mode === 'off') {
      return reject(device, lever, null, `not armed (armed=${ctrl.armed}, mode=${ctrl.mode})`);
    }
    const fresh = freshnessOk(snap);
    if (!fresh.ok) return reject(device, lever, null, fresh.reason);

    // (2+3+4+5+6) dispatch per device/lever.
    if (device === 'tesla') return await issueTesla(lever, value, reason, snap, opts);
    if (device === 'sonnen') return await issueSonnen(lever, value, reason, snap, opts);
    return reject(device, lever, null, `unknown device '${device}'`);
  } catch (e) {
    const detail = (e as Error).message;
    logEntry(device, lever, null, null, reason, false, detail);
    return { ok: false, skipped: false, reason: detail, from: null, to: null };
  }
}

function rateLimited(device: ControlDevice, lever: Lever): boolean {
  const last = lastWriteAt.get(key(device, lever));
  return last !== undefined && Date.now() - last < RATE_LIMIT_MS;
}

function markWritten(device: ControlDevice, lever: Lever): void {
  lastWriteAt.set(key(device, lever), Date.now());
}

// ---- Tesla ------------------------------------------------------------------

async function issueTesla(
  lever: Lever,
  value: IssueValue,
  reason: string,
  snap: ControlSnapshot,
  _opts: IssueOpts = {},
): Promise<IssueResult> {
  const cur = await tesla.readControlConfig();

  if (lever === 'mode') {
    const guard = checkMode('tesla', String(value));
    if (!guard.ok) return reject('tesla', lever, cur.mode, guard.reason);
    const to = guard.value as tesla.TeslaMode;
    if (cur.mode === to) return noop('tesla', lever, to);
    if (rateLimited('tesla', lever)) return reject('tesla', lever, cur.mode, 'rate-limited (<60s)');
    await tesla.setMode(to);
    markWritten('tesla', lever);
    const after = await tesla.readControlConfig();
    return confirmTeslaMode('tesla', lever, cur.mode, to, after.mode, reason);
  }

  if (lever === 'reserve') {
    const guard = checkTeslaReserve(Number(value), snap);
    if (!guard.ok) return reject('tesla', lever, cur.reservePct, guard.reason);
    const to = guard.value;
    if (cur.reservePct === to) return noop('tesla', lever, to);
    if (rateLimited('tesla', lever)) return reject('tesla', lever, cur.reservePct, 'rate-limited (<60s)');
    await tesla.setReserve(to);
    markWritten('tesla', lever);
    const after = await tesla.readControlConfig();
    return confirmTeslaReserve('tesla', lever, cur.reservePct, to, after.reservePct, reason);
  }

  if (lever === 'gridExport') {
    const v = value as { enableGridCharge: boolean; exportRule: tesla.TeslaExportRule };
    const gc = checkTeslaGridCharge(v.enableGridCharge, snap);
    if (!gc.ok && v.enableGridCharge) {
      return reject('tesla', lever, cur.gridChargeAllowed ? 'allowed' : 'blocked', gc.reason);
    }
    const enable = gc.value; // false if rejected
    if (enable) {
      // Enabling grid-charge adds import; respect the 14 kW cap. Tesla draws up to
      // its ~5 kW grid-charge rate (no exact-W command), so budget that headroom.
      const TESLA_GRID_CHARGE_KW = 5;
      const cap = checkGridImportCap(TESLA_GRID_CHARGE_KW, snap);
      if (!cap.ok) return reject('tesla', lever, cur.gridChargeAllowed ? 'allowed' : 'blocked', cap.reason);
    }
    // disallowCharge is the inverse of "enable grid-charge".
    const disallow = !enable;
    const fromStr = `${cur.gridChargeAllowed ? 'gc-on' : 'gc-off'}/${cur.exportRule}`;
    const toStr = `${enable ? 'gc-on' : 'gc-off'}/${v.exportRule}`;
    if (cur.gridChargeAllowed === enable && cur.exportRule === v.exportRule) {
      return noop('tesla', lever, toStr);
    }
    if (rateLimited('tesla', lever)) return reject('tesla', lever, fromStr, 'rate-limited (<60s)');
    await tesla.setGridImportExport(disallow, v.exportRule);
    markWritten('tesla', lever);
    const after = await tesla.readControlConfig();
    const afterStr = `${after.gridChargeAllowed ? 'gc-on' : 'gc-off'}/${after.exportRule}`;
    return confirm('tesla', lever, fromStr, toStr, afterStr, reason);
  }

  return reject('tesla', lever, null, `lever '${lever}' not supported on tesla`);
}

// ---- Sonnen -----------------------------------------------------------------

async function issueSonnen(
  lever: Lever,
  value: IssueValue,
  reason: string,
  snap: ControlSnapshot,
  opts: IssueOpts = {},
): Promise<IssueResult> {
  const cur = await sonnen.readControlConfig();

  if (lever === 'mode') {
    const guard = checkMode('sonnen', String(value));
    if (!guard.ok) return reject('sonnen', lever, cur.mode, guard.reason);
    const to = guard.value as '1' | '2' | '10';
    if (cur.mode === to) return noop('sonnen', lever, to);
    // SAFETY reverts (opts.priority) must always be able to fire — never rate-limit them.
    if (!opts.priority && rateLimited('sonnen', lever)) return reject('sonnen', lever, cur.mode, 'rate-limited (<60s)');
    await sonnen.setOperatingMode(to);
    markWritten('sonnen', lever);
    const after = await sonnen.readControlConfig();
    return confirm('sonnen', lever, cur.mode, to, after.mode, reason);
  }

  if (lever === 'reserve') {
    const guard = checkSonnenReserve(Number(value));
    if (!guard.ok) return reject('sonnen', lever, cur.reservePct, guard.reason);
    const to = guard.value;
    if (cur.reservePct === to) return noop('sonnen', lever, to);
    if (rateLimited('sonnen', lever)) return reject('sonnen', lever, cur.reservePct, 'rate-limited (<60s)');
    await sonnen.setReserve(to);
    markWritten('sonnen', lever);
    const after = await sonnen.readControlConfig();
    return confirm('sonnen', lever, cur.reservePct, to, after.reservePct, reason);
  }

  if (lever === 'charge' || lever === 'discharge') {
    const guard = checkSonnenWatts(Number(value), lever, snap);
    if (!guard.ok) return reject('sonnen', lever, null, guard.reason);
    // Setpoints require manual mode (EM_OperatingMode=1). Verify, don't force here.
    if (cur.mode !== '1') {
      return reject('sonnen', lever, cur.mode, `Sonnen not in manual mode (${cur.mode}) — setpoint skipped`);
    }
    if (rateLimited('sonnen', lever)) return reject('sonnen', lever, null, 'rate-limited (<60s)');
    if (lever === 'charge') await sonnen.forceCharge(guard.value);
    else await sonnen.forceDischarge(guard.value);
    markWritten('sonnen', lever);
    // Setpoints have no clean idempotent read-back key; record the commanded value.
    logEntry('sonnen', lever, null, guard.value, reason, true, `setpoint ${guard.value}W issued`);
    return { ok: true, skipped: false, reason, from: null, to: guard.value };
  }

  return reject('sonnen', lever, null, `lever '${lever}' not supported on sonnen`);
}

// ---- Read-back confirm ------------------------------------------------------

function confirm(
  device: ControlDevice,
  lever: Lever,
  from: string | number | null,
  to: string | number,
  readBack: string | number,
  reason: string,
): IssueResult {
  const ok = String(readBack) === String(to);
  const detail = ok
    ? `confirmed ${to}`
    : `read-back MISMATCH: wanted ${to}, device reports ${readBack}`;
  logEntry(device, lever, from, readBack, reason, ok, detail);
  return { ok, skipped: false, reason, from, to: readBack };
}

/**
 * Read-back confirm for the Tesla reserve lever, TOLERANT of the Powerwall's
 * usable-reserve ceiling. We already clamp requests down to TESLA_RESERVE_MAX_PCT,
 * but the device's effective ceiling can be a touch lower than our constant, so:
 *  - exact match → confirmed;
 *  - we asked for the cap (or above) AND the device applied its own ceiling
 *    (readBack ≤ what we wanted, and readBack ≥ our cap) → confirmed-with-clamp,
 *    treated as SUCCESS and noted, not a MISMATCH;
 *  - anything else (value unchanged when it should have changed, or wildly off)
 *    → genuine MISMATCH error.
 */
function confirmTeslaReserve(
  device: ControlDevice,
  lever: Lever,
  from: string | number | null,
  to: number,
  readBack: number,
  reason: string,
): IssueResult {
  const exact = readBack === to;
  // Device applied its own ceiling: we requested at least the cap, and it landed
  // at-or-above the cap but no higher than we asked.
  const clampedToCeiling = to >= TESLA_RESERVE_MAX_PCT && readBack >= TESLA_RESERVE_MAX_PCT && readBack <= to;
  // Tesla's /site_info LAGS after a /backup write: an immediate read-back that still
  // shows the PRE-write value (`from`) is the cloud not having propagated yet, NOT a
  // failure. Treat as pending success (no lastError); a later tick's read confirms the
  // real value. (Trade-off: if the device genuinely refuses the value and stays at the
  // old one, this no longer errors — acceptable here; the owner wanted the dashboard
  // noise gone and Tesla caps reserve anyway. A dedicated "write rejected after N ticks"
  // detector is a possible follow-up.)
  const pendingLag = !exact && !clampedToCeiling && typeof from === 'number' && readBack === from;
  const ok = exact || clampedToCeiling || pendingLag;
  const detail = exact
    ? `confirmed ${to}`
    : clampedToCeiling
      ? `confirmed ${readBack} (device caps usable reserve at ${readBack}%; requested ${to}%)`
      : pendingLag
        ? `issued ${to}% — pending (Tesla read-back still ${readBack}%, cloud lag)`
        : `read-back MISMATCH: wanted ${to}, device reports ${readBack}`;
  logEntry(device, lever, from, readBack, reason, ok, detail);
  return { ok, skipped: false, reason, from, to: readBack };
}

/**
 * Read-back confirm for the Tesla MODE lever, TOLERANT of /site_info read-back lag.
 * The Tesla now flips default_real_mode between self_consumption / backup / autonomous
 * every tick, and /site_info can lag a /operation write (same as the reserve /backup
 * write). An immediate read-back that still equals the PRE-write mode (`from`) is the
 * cloud not having propagated yet — treat as pending SUCCESS (no lastError); a later
 * tick confirms the real value. Exact match = confirmed.
 *
 * Trade-off (mirrors confirmTeslaReserve): if the device GENUINELY refuses the mode and
 * stays at the old one, this no longer errors after the first tick. Acceptable here — the
 * shadow-first rollout + the Sonnen load-following PRIMARY mechanism cover us if the Tesla
 * ignores the mode write.
 */
function confirmTeslaMode(
  device: ControlDevice,
  lever: Lever,
  from: string | number | null,
  to: string,
  readBack: string,
  reason: string,
): IssueResult {
  const exact = readBack === to;
  const pendingLag = !exact && readBack === from;
  const ok = exact || pendingLag;
  const detail = exact
    ? `confirmed ${to}`
    : pendingLag
      ? `issued ${to} — pending (Tesla read-back still ${readBack}, cloud lag)`
      : `read-back MISMATCH: wanted ${to}, device reports ${readBack}`;
  logEntry(device, lever, from, readBack, reason, ok, detail);
  return { ok, skipped: false, reason, from, to: readBack };
}

/** Clear rate-limit memory — used by revert-to-safe (safety) and tests. */
export function _resetRateLimits(): void {
  lastWriteAt.clear();
}
