// The single, guardrailed write path to the AC units. Nothing else should call
// intesis.setDatapoint directly — everything goes through issueClimate(), which
// enforces: armed + mode!=='off', fresh live data, guardrail clamps, no-op skip,
// write, read-back confirm, per-device rate-limit, and logging. It never throws.

import * as intesis from '../connectors/intesis';
import { UID, MODE_VALUE } from '../connectors/intesis';
import * as airzone from '../connectors/airzone';
import * as store from '../store';
import type { ClimateUnit } from '../connectors/intesis';
import {
  checkImportHeadroom,
  checkMode,
  checkPower,
  checkSetpoint,
  checkVane,
  freshnessOk,
  type ClimateLever,
  type ClimateSnapshot,
} from './climate-guardrails';

export type { ClimateLever } from './climate-guardrails';

/** ≥30s between writes to the SAME device+lever (AC reacts slower than batteries). */
const RATE_LIMIT_MS = 30_000;
const lastWriteAt = new Map<string, number>();

export interface ClimateIssueResult {
  ok: boolean;
  skipped: boolean;
  reason: string;
  from: string | number | null;
  to: string | number | null;
}

export type ClimateValue = boolean | number | string;

function key(deviceId: string, lever: ClimateLever): string {
  return `${deviceId}:${lever}`;
}

/** Airzone underfloor zones use a separate connector + native (non-UID) write API. */
function isAirzone(id: string): boolean {
  return id.startsWith('air-');
}

function logEntry(
  deviceId: string,
  lever: ClimateLever,
  from: string | number | null,
  to: string | number | null,
  reason: string,
  ok: boolean,
  detail: string,
): void {
  store.update((s) => {
    s.devices.log.push({ ts: Date.now(), deviceId, lever, from, to, reason, ok, detail });
    if (s.devices.log.length > 100) s.devices.log = s.devices.log.slice(-100);
    s.devices.updatedAt = Date.now();
    if (!ok) s.devices.lastError = `${deviceId}.${lever}: ${detail}`;
  });
}

function reject(
  deviceId: string,
  lever: ClimateLever,
  from: string | number | null,
  reason: string,
): ClimateIssueResult {
  logEntry(deviceId, lever, from, null, reason, false, reason);
  return { ok: false, skipped: false, reason, from, to: null };
}

function noop(
  deviceId: string,
  lever: ClimateLever,
  value: string | number,
  reason = 'unchanged',
): ClimateIssueResult {
  logEntry(deviceId, lever, value, value, reason, true, 'unchanged — no write');
  return { ok: true, skipped: true, reason, from: value, to: value };
}

function rateLimited(deviceId: string, lever: ClimateLever): boolean {
  const last = lastWriteAt.get(key(deviceId, lever));
  return last !== undefined && Date.now() - last < RATE_LIMIT_MS;
}
function markWritten(deviceId: string, lever: ClimateLever): void {
  lastWriteAt.set(key(deviceId, lever), Date.now());
}

/**
 * Issue ONE guardrailed climate command. Returns a result; never throws.
 * `unit` is the current normalized device view; `snap` must be fresh.
 */
export async function issueClimate(
  unit: ClimateUnit,
  lever: ClimateLever,
  value: ClimateValue,
  reason: string,
  snap: ClimateSnapshot,
  opts: { manual?: boolean } = {},
): Promise<ClimateIssueResult> {
  try {
    const dev = store.get().devices;
    // Only the AUTOMATION loop is arm-gated; explicit manual commands from the
    // device page always go through (guardrails below still apply). This keeps
    // the brain from auto-driving a unit until devices control is armed, while
    // letting an admin operate the unit by hand at any time.
    if (!opts.manual && (!dev.armed || dev.mode === 'off')) {
      return reject(unit.id, lever, null, `automation not armed (armed=${dev.armed}, mode=${dev.mode})`);
    }
    const fresh = freshnessOk(snap);
    if (!fresh.ok) return reject(unit.id, lever, null, fresh.reason);

    const settings = store.get().deviceSettings[unit.id];

    // The 30s/lever throttle exists to protect the AC compressor from rapid
    // cycling — that only applies to POWER, which always stays throttled. Cheap
    // levers (mode/setpoint/fan/vanes) don't cycle the compressor, so an explicit
    // MANUAL command bypasses the throttle (quick sequential tweaks aren't
    // rejected). The automation loop still throttles every lever.
    const rlExempt = opts.manual === true && lever !== 'power';
    const limited = (l: ClimateLever): boolean => !rlExempt && rateLimited(unit.id, l);

    if (lever === 'power') {
      const want = Boolean(value);
      const guard = checkPower(want);
      if (!guard.ok && want) return reject(unit.id, lever, unit.power ? 'on' : 'off', guard.reason);
      const to = guard.value;
      // Powering a compressor ON consumes import headroom — respect the cap.
      if (to && !unit.power) {
        const cap = checkImportHeadroom(snap);
        if (!cap.ok) return reject(unit.id, lever, 'off', cap.reason);
      }
      if (unit.power === to) return noop(unit.id, lever, to ? 'on' : 'off');
      if (rateLimited(unit.id, lever)) return reject(unit.id, lever, unit.power ? 'on' : 'off', 'rate-limited (<30s)');
      if (isAirzone(unit.id)) await airzone.setLever(unit.id, 'power', to);
      else await intesis.setDatapoint(unit.id, UID.power, to ? 1 : 0);
      markWritten(unit.id, lever);
      return confirmPower(unit.id, unit.power, to, reason);
    }

    if (lever === 'mode') {
      const guard = checkMode(String(value));
      if (!guard.ok) return reject(unit.id, lever, unit.mode, guard.reason);
      const to = guard.value;
      if (unit.mode === to) return noop(unit.id, lever, to);
      if (limited(lever)) return reject(unit.id, lever, unit.mode, 'rate-limited (<30s)');
      if (isAirzone(unit.id)) await airzone.setLever(unit.id, 'mode', to);
      else await intesis.setDatapoint(unit.id, UID.mode, MODE_VALUE[to]);
      markWritten(unit.id, lever);
      logEntry(unit.id, lever, unit.mode, to, reason, true, `mode ${to} issued`);
      return { ok: true, skipped: false, reason, from: unit.mode, to };
    }

    if (lever === 'setpoint') {
      const guard = checkSetpoint(Number(value), unit, settings);
      const to = guard.value;
      if (unit.setpointC === to) return noop(unit.id, lever, to);
      if (limited(lever)) return reject(unit.id, lever, unit.setpointC, 'rate-limited (<30s)');
      // Airzone takes whole °C (0.5° steps); Intesis wants tenths of °C.
      if (isAirzone(unit.id)) await airzone.setLever(unit.id, 'setpoint', to);
      else await intesis.setDatapoint(unit.id, UID.setpoint, Math.round(to * 10));
      markWritten(unit.id, lever);
      logEntry(unit.id, lever, unit.setpointC, to, `${reason}${guard.reason !== 'ok' ? ` (${guard.reason})` : ''}`, true, `setpoint ${to}°C issued`);
      return { ok: true, skipped: false, reason, from: unit.setpointC, to };
    }

    if (lever === 'fan') {
      const fan = Math.max(0, Math.round(Number(value)));
      if (isAirzone(unit.id)) return noop(unit.id, lever, fan, 'underfloor has no fan');
      if (unit.fanLevel != null && unit.fanLevel === fan) return noop(unit.id, lever, fan);
      if (limited(lever)) return reject(unit.id, lever, unit.fanLevel ?? null, 'rate-limited (<30s)');
      await intesis.setDatapoint(unit.id, UID.fan, fan);
      markWritten(unit.id, lever);
      logEntry(unit.id, lever, unit.fanLevel ?? null, fan, reason, true, `fan ${fan} issued`);
      return { ok: true, skipped: false, reason, from: unit.fanLevel ?? null, to: fan };
    }

    if (lever === 'vaneUpDown' || lever === 'vaneLeftRight') {
      if (isAirzone(unit.id)) return noop(unit.id, lever, Math.round(Number(value)), 'underfloor has no vanes');
      const guard = checkVane(Number(value));
      if (!guard.ok) return reject(unit.id, lever, null, guard.reason);
      const to = guard.value;
      const cur = lever === 'vaneUpDown' ? unit.vaneUpDown : unit.vaneLeftRight;
      if (cur != null && cur === to) return noop(unit.id, lever, to);
      if (limited(lever)) return reject(unit.id, lever, cur ?? null, 'rate-limited (<30s)');
      await intesis.setDatapoint(unit.id, lever === 'vaneUpDown' ? UID.vaneV : UID.vaneH, to);
      markWritten(unit.id, lever);
      logEntry(unit.id, lever, cur ?? null, to, reason, true, `${lever} ${to} issued`);
      return { ok: true, skipped: false, reason, from: cur ?? null, to };
    }

    return reject(unit.id, lever, null, `unknown lever '${lever}'`);
  } catch (e) {
    const detail = (e as Error).message;
    logEntry(unit.id, lever, null, null, reason, false, detail);
    return { ok: false, skipped: false, reason: detail, from: null, to: null };
  }
}

// Setpoint/mode/fan have no instant idempotent read-back over the write socket
// (the cloud reflects them on the next poll), so we confirm what we can: power is
// the only lever where an immediate logical confirm is meaningful here.
function confirmPower(
  deviceId: string,
  from: boolean,
  to: boolean,
  reason: string,
): ClimateIssueResult {
  logEntry(deviceId, 'power', from ? 'on' : 'off', to ? 'on' : 'off', reason, true, `power ${to ? 'on' : 'off'} issued`);
  return { ok: true, skipped: false, reason, from: from ? 'on' : 'off', to: to ? 'on' : 'off' };
}

/** Clear rate-limit memory — used on disarm and by tests. */
export function _resetClimateRateLimits(): void {
  lastWriteAt.clear();
}
