// Bridge World B (alerts) into the unified event bus (docs/37 §3, Phase 2). The 6 alert
// rules keep their existing debounce + ack/resolve + Push/WhatsApp/Email fan-out; here we
// ALSO emit each firing alert as an `observation` event (active), and a matching `cleared`
// event on recovery (relatedId → active). The event bus's own severity-forwarding is NOT
// used for these (they already fan out via the alert loop) — we pass noNotify:true so the
// notification isn't double-sent. READ-ONLY; never throws.

import type { Alert, Severity as AlertSeverity } from './routes/alerts';
import { logEvent, type EnergyEvent, type Severity, type EventCategory } from './events';
import { takeEventSnapshot } from './control/event-snapshot';

/** Map the alert severity scale onto the event scale (§4). Safety events lift to critical. */
function mapSeverity(a: Alert): Severity {
  // True safety events → critical (grid outage/island, over/under-voltage trip).
  // A solar inverter unreachable in daylight IS an outage, and repeated inverter
  // grid-voltage trips are the same class as rule-voltage → lift both to critical.
  if (
    a.rule === 'rule-outage' ||
    a.rule === 'rule-voltage' ||
    a.rule === 'rule-inverter-offline' ||
    a.rule === 'rule-inverter-grid-quality'
  )
    return 'critical';
  switch (a.severity) {
    case 'danger':
      return 'high';
    case 'warning':
      return 'medium';
    case 'info':
      return 'low';
    case 'ok':
      return 'low';
    default:
      return 'medium';
  }
}

/** Map an alert's rule/device onto an event category. */
function categoryFor(a: Alert): EventCategory {
  switch (a.rule) {
    case 'rule-offline':
      return 'connectivity';
    case 'rule-outage':
    case 'rule-voltage':
    case 'rule-export':
      return 'grid';
    case 'rule-grid-charge':
    case 'rule-reserve':
    case 'rule-charge-stall':
    // Sonnen hardware/comms fault (ic_status) is a battery event.
    case 'rule-sonnen-fault':
      return 'battery';
    // Solar inverters (Sungrow SG5.0RS ×2, docs/36). Grid-quality trips are a grid
    // phenomenon (like rule-voltage); the rest are solar-production events.
    case 'rule-inverter-grid-quality':
      return 'grid';
    case 'rule-inverter-fault':
    case 'rule-inverter-offline':
    case 'rule-inverter-stall':
    case 'rule-inverter-imbalance':
    // The Tesla-metered array going dark is a solar-production event.
    case 'rule-tesla-solar-dark':
      return 'solar';
    default:
      return 'grid';
  }
}

// Track the active event id per alert id, so recovery can emit a paired 'cleared'.
const activeByAlertId = new Map<string, string>();

/**
 * Emit an ACTIVE observation event for a firing alert, once per distinct firing (idempotent
 * while it stays active). Called from the alert loop for each alert that has passed its
 * debounce + is genuinely NEW (about to notify). Best-effort; never throws.
 */
export async function emitAlertActive(a: Alert): Promise<void> {
  try {
    if (activeByAlertId.has(a.id)) return; // already active — don't duplicate
    const ev: EnergyEvent = logEvent({
      class: 'observation',
      category: categoryFor(a),
      severity: mapSeverity(a),
      summary: a.title,
      trigger: { source: 'threshold', detail: a.rule ?? 'alert' },
      device: a.device,
      detail: a.sub,
      state: 'active',
      data: await takeEventSnapshot(),
      // Alerts fan out via the alert loop already — don't double-notify from the bus.
      noNotify: true,
    });
    activeByAlertId.set(a.id, ev.id);
  } catch (e) {
    console.error('[alert-events] active emit failed:', (e as Error).message);
  }
}

/**
 * Emit a CLEARED event for an alert that has stopped firing (recovery), paired to its active
 * via relatedId. Called from the alert loop's recovery pass. No-op if we never saw it active.
 */
export async function emitAlertCleared(alertId: string, device: string, title: string): Promise<void> {
  try {
    const relatedId = activeByAlertId.get(alertId);
    if (!relatedId) return;
    activeByAlertId.delete(alertId);
    logEvent({
      class: 'observation',
      category: 'grid',
      severity: 'low',
      summary: `${title} — cleared`,
      trigger: { source: 'threshold', detail: 'recovery' },
      device,
      state: 'cleared',
      relatedId,
      noNotify: true,
    });
  } catch (e) {
    console.error('[alert-events] cleared emit failed:', (e as Error).message);
  }
}

/**
 * Emit a 'cleared' event for every currently-active alert id NOT present in `firing`.
 * Called each tick so an alert that stops firing (with or without a recoveryWatch entry)
 * always gets its paired cleared event. Best-effort; never throws.
 */
export async function emitClearedForMissing(firing: Alert[]): Promise<void> {
  const firingIds = new Set(firing.map((f) => f.id));
  for (const id of [...activeByAlertId.keys()]) {
    if (firingIds.has(id)) continue;
    await emitAlertCleared(id, id, id);
  }
}

/** Which alert severities the mapper covers (re-export for callers/tests). */
export type { AlertSeverity };
