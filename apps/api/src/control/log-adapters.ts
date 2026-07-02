// World-A adapters (docs/37 §3). Each existing per-domain log writer (execute.ts,
// climate-execute.ts, irrigation-execute.ts, blinds/ev/schedule coordinators,
// arbitrage-log.ts) calls ONE of these ALONGSIDE its current log push — shim-first, so the
// old device/irrigation/arbitrage screens keep working while every action ALSO lands in the
// unified timeline. Mapping per the brief:
//   • battery no-ops → action / low
//   • surplus HVAC on/off, arbitrage engage, force-charge → medium
//   • guardrail rejections (ok=false) → high
// These are pure, synchronous mappers (no async live reads) so they're cheap to call inline
// on the write path; the richer `data` snapshot is attached by the observation monitors/alerts
// which run on their own tick. NEVER throws.

import { logEvent, type EventCategory, type Severity, type TriggerSource } from '../events';
import type { ControlDevice } from '../store';

const NOOP_DETAIL = 'unchanged — no write';

/** Battery lever write (from execute.ts). Guardrail rejections → high; no-ops/routine → low;
 *  a real charge/discharge/mode change → medium. */
export function logBatteryAction(
  device: ControlDevice,
  lever: string,
  from: string | number | null,
  to: string | number | null,
  reason: string,
  ok: boolean,
  detail: string,
): void {
  try {
    const isNoop = detail === NOOP_DETAIL;
    let severity: Severity;
    if (!ok) severity = 'high'; // guardrail rejection / read-back mismatch
    else if (isNoop) severity = 'low';
    else if (lever === 'charge' || lever === 'discharge' || lever === 'mode') severity = 'medium';
    else severity = 'low';
    logEvent({
      class: 'action',
      category: 'battery',
      severity,
      summary: `${cap(device)} · ${lever}${isNoop ? ' (no-op)' : ''}`,
      trigger: { source: 'coordinator', detail: reason },
      device: cap(device),
      entity: lever,
      change: { from, to },
      ok,
      detail,
    });
  } catch {
    /* logging never affects the control write */
  }
}

/** Climate write (from climate-execute.ts). Surplus on/off/setpoint → medium; reject → high. */
export function logClimateAction(
  deviceId: string,
  lever: string,
  from: string | number | null,
  to: string | number | null,
  reason: string,
  ok: boolean,
  detail: string,
): void {
  try {
    const isNoop = detail === NOOP_DETAIL || detail.includes('unchanged');
    // A 'shadow' lever is a decision/skip note, not a write → observation-ish low.
    const severity: Severity = !ok ? 'high' : lever === 'shadow' || isNoop ? 'low' : 'medium';
    logEvent({
      class: 'action',
      category: 'climate',
      severity,
      summary: `${deviceId} · ${lever}`,
      trigger: { source: 'surplus-rule', detail: reason },
      device: deviceId,
      entity: lever,
      change: { from, to },
      ok,
      detail,
    });
  } catch {
    /* ignore */
  }
}

/** Blind position write (from blinds-coordinator.ts). Routine %; reject → high. */
export function logBlindsAction(
  deviceId: string,
  from: number | null,
  to: number,
  reason: string,
  ok: boolean,
  detail: string,
): void {
  try {
    logEvent({
      class: 'action',
      category: 'blinds',
      severity: ok ? 'low' : 'high',
      summary: `${deviceId} · position → ${to}%`,
      trigger: { source: 'schedule', detail: reason },
      device: deviceId,
      entity: 'position',
      change: { from, to },
      ok,
      detail,
    });
  } catch {
    /* ignore */
  }
}

/** EV breaker on/off (from ev-surplus.ts). Surplus/P3 gating → medium; reject → high. */
export function logEvAction(
  deviceId: string,
  to: 'on' | 'off' | null,
  reason: string,
  ok: boolean,
  detail: string,
): void {
  try {
    logEvent({
      class: 'action',
      category: 'ev',
      severity: !ok ? 'high' : to === null ? 'low' : 'medium',
      summary: `EV breaker · ${to ?? 'evaluate'}`,
      trigger: { source: 'surplus-rule', detail: reason },
      device: deviceId,
      entity: 'ev',
      change: { from: null, to },
      ok,
      detail,
    });
  } catch {
    /* ignore */
  }
}

/** Scheduled generic-device actuation (from device-schedule-coordinator.ts). */
export function logScheduleAction(
  deviceId: string,
  lever: 'power' | 'speed' | 'direction',
  from: string | number | null,
  to: string | number,
  reason: string,
  ok: boolean,
  detail: string,
): void {
  try {
    logEvent({
      class: 'action',
      category: 'app',
      severity: ok ? 'low' : 'high',
      summary: `${deviceId} · ${lever} → ${to}`,
      trigger: { source: 'schedule', detail: reason },
      device: deviceId,
      entity: lever,
      change: { from, to },
      ok,
      detail,
    });
  } catch {
    /* ignore */
  }
}

/** Irrigation actuation (from irrigation-execute.ts) — action. */
export function logIrrigationAction(
  deviceId: string,
  lever: string,
  from: string | number | null,
  to: string | number | null,
  reason: string,
  ok: boolean,
  detail: string,
): void {
  try {
    logEvent({
      class: 'action',
      category: 'irrigation',
      severity: !ok ? 'high' : lever === 'run' ? 'medium' : 'low',
      summary: `${deviceId} · ${lever}`,
      trigger: { source: 'coordinator', detail: reason },
      device: deviceId,
      entity: lever,
      change: { from, to },
      ok,
      detail,
    });
  } catch {
    /* ignore */
  }
}

/** Irrigation coordinator decision (plan/fire/trim/skip/suppress/confirm/alert) — an
 *  'alert' is an observation; everything else is an action-side note. */
export function logIrrigationDecision(
  zoneId: string,
  action: string,
  live: boolean,
  ok: boolean,
  detail: string,
): void {
  try {
    const isObservation = action === 'alert';
    logEvent({
      class: isObservation ? 'observation' : 'action',
      category: 'irrigation',
      severity: !ok ? 'high' : isObservation ? 'medium' : 'low',
      summary: `Irrigation ${action} — ${zoneId}`,
      trigger: { source: 'coordinator', detail: live ? 'live' : 'shadow' },
      device: zoneId,
      entity: action,
      ok,
      detail,
      ...(isObservation ? { state: 'active' as const } : {}),
    });
  } catch {
    /* ignore */
  }
}

/**
 * Arbitrage event (from arbitrage-log.ts appendArbitrageEvent). `engage` → action/medium;
 * `deviation` → observation/medium; plan/revert/standdown → system/low. Carries the live
 * readings + plan headline as the reproduction payload.
 */
export function logArbitrageEvent(ev: {
  type: string;
  executionMode: 'advisory' | 'active';
  band: string;
  spreadEur: number;
  plan: unknown;
  live: unknown;
  action: unknown;
  ts: number;
}): void {
  try {
    let klass: 'action' | 'observation' | 'system';
    let severity: Severity;
    let source: TriggerSource = 'arbitrage';
    if (ev.type === 'engage') {
      klass = 'action';
      severity = 'medium';
    } else if (ev.type === 'deviation') {
      klass = 'observation';
      severity = 'medium';
      source = 'threshold';
    } else {
      klass = 'system';
      severity = 'low';
    }
    const category: EventCategory = 'arbitrage';
    logEvent({
      class: klass,
      category,
      severity,
      summary: `Arbitrage ${ev.type} (${ev.executionMode}) · ${ev.band}`,
      trigger: { source, detail: `spread €${ev.spreadEur.toFixed(3)}` },
      device: 'Battery',
      entity: ev.type,
      detail: `${ev.executionMode} mode, ${ev.band} band`,
      ts: new Date(ev.ts).toISOString(),
      ...(klass === 'observation' ? { state: 'active' as const } : {}),
      data: {
        executionMode: ev.executionMode,
        band: ev.band,
        spreadEur: ev.spreadEur,
        plan: ev.plan,
        live: ev.live,
        action: ev.action,
      },
    });
  } catch {
    /* ignore */
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
