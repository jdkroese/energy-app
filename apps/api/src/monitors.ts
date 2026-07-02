// New observation monitors (docs/37 §5) folded into the alert/monitor tick. Threshold
// already-live signals with HYSTERESIS + MIN-DWELL so steady state is silent and only edges
// log:
//   • High house load — home.kw > threshold sustained ≥ dwell → observation / high.
//   • High current    — breaker.currentA > threshold → observation / high.
// Both are LOG-ONLY (locked §10.2 — noNotify:true; they never fire Push/WhatsApp). Each pairs
// an ACTIVE event with a matching CLEARED event on recovery via relatedId. READ-ONLY: it reads
// live surfaces + config and emits events; it touches no control logic and never throws.

import * as tesla from './connectors/tesla';
import { getMonitoredBreaker } from './connectors/tuya-voltage';
import { logEvent } from './events';
import { takeEventSnapshot } from './control/event-snapshot';
import * as store from './store';

/** Per-monitor edge state: tracks the active event + when the signal first crossed. */
interface EdgeState {
  /** The active event id (set while firing), else null. */
  activeId: string | null;
  /** Epoch ms the signal first went above threshold (for the dwell gate), or 0. */
  aboveSince: number;
}

const loadEdge: EdgeState = { activeId: null, aboveSince: 0 };
const currentEdge: EdgeState = { activeId: null, aboveSince: 0 };

/**
 * Evaluate one monitor with hysteresis + dwell. Emits an ACTIVE event when the value has
 * been above `threshold` for ≥ dwellMs, and a CLEARED event (relatedId → active) once it
 * drops below `threshold × (1 − hysteresisFrac)`. Both log-only (noNotify). Returns nothing.
 */
async function evalMonitor(
  edge: EdgeState,
  value: number,
  threshold: number,
  hysteresisFrac: number,
  dwellMs: number,
  now: number,
  build: () => Promise<Omit<Parameters<typeof logEvent>[0], 'state' | 'noNotify' | 'relatedId'>>,
  clearedSummary: (v: number) => string,
): Promise<void> {
  const clearAt = threshold * (1 - hysteresisFrac);
  const above = value > threshold;

  if (edge.activeId === null) {
    // Not currently firing — arm/refresh the dwell timer, fire once dwell elapses.
    if (above) {
      if (edge.aboveSince === 0) edge.aboveSince = now;
      if (now - edge.aboveSince >= dwellMs) {
        const base = await build();
        const ev = logEvent({ ...base, state: 'active', noNotify: true });
        edge.activeId = ev.id;
      }
    } else {
      edge.aboveSince = 0;
    }
    return;
  }

  // Currently firing — clear once the value falls below the hysteresis band.
  if (value < clearAt) {
    const relatedId = edge.activeId;
    edge.activeId = null;
    edge.aboveSince = 0;
    const base = await build();
    logEvent({
      ...base,
      summary: clearedSummary(value),
      severity: 'low',
      state: 'cleared',
      relatedId,
      noNotify: true,
    });
  }
}

/** Run the two log-only monitors for one tick. Best-effort; never throws. */
export async function runEventMonitors(now: number = Date.now()): Promise<void> {
  try {
    const cfg = store.get().eventsConfig;
    const dwellMs = cfg.dwellSec * 1000;

    // High house load — from the Tesla load_power (kW). Best-effort; skip if unreadable.
    if (cfg.highLoadEnabled) {
      try {
        const t = await tesla.getNormalized();
        const loadKw = t.loadKw;
        if (Number.isFinite(loadKw)) {
          await evalMonitor(
            loadEdge,
            loadKw,
            cfg.highLoadKw,
            cfg.hysteresisFrac,
            dwellMs,
            now,
            async () => ({
              class: 'observation',
              category: 'grid',
              severity: 'high',
              summary: `High house load — ${loadKw.toFixed(1)} kW`,
              trigger: { source: 'threshold', detail: `> ${cfg.highLoadKw} kW for ${cfg.dwellSec}s` },
              device: 'House',
              entity: 'home.kw',
              detail: `House load ${loadKw.toFixed(1)} kW exceeded the ${cfg.highLoadKw} kW threshold`,
              data: await takeEventSnapshot(),
            }),
            (v) => `House load back to normal — ${v.toFixed(1)} kW`,
          );
        }
      } catch {
        /* load unreadable this tick — skip */
      }
    }

    // High current — from the monitored Tuya breaker (A). Only a real reading (>0).
    if (cfg.highCurrentEnabled) {
      try {
        const breaker = await getMonitoredBreaker();
        if (breaker && breaker.currentA > 0) {
          const amps = breaker.currentA;
          await evalMonitor(
            currentEdge,
            amps,
            cfg.highCurrentA,
            cfg.hysteresisFrac,
            dwellMs,
            now,
            async () => ({
              class: 'observation',
              category: 'grid',
              severity: 'high',
              summary: `High current — ${amps.toFixed(1)} A`,
              trigger: { source: 'threshold', detail: `> ${cfg.highCurrentA} A` },
              device: breaker.name,
              entity: 'breaker.currentA',
              detail: `Breaker current ${amps.toFixed(1)} A exceeded the ${cfg.highCurrentA} A threshold`,
              data: await takeEventSnapshot(),
            }),
            (v) => `Current back to normal — ${v.toFixed(1)} A`,
          );
        }
      } catch {
        /* breaker unreadable this tick — skip */
      }
    }
  } catch (e) {
    console.error('[monitors] tick failed:', (e as Error).message);
  }
}

/** Test/diagnostic reset of the edge state. */
export function _resetMonitors(): void {
  loadEdge.activeId = null;
  loadEdge.aboveSince = 0;
  currentEdge.activeId = null;
  currentEdge.aboveSince = 0;
}

/** Expose the active event ids (diagnostics). */
export function activeMonitorEvents(): { load: string | null; current: string | null } {
  return { load: loadEdge.activeId, current: currentEdge.activeId };
}
