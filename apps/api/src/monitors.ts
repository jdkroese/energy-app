// New observation monitors (docs/37 §5) folded into the alert/monitor tick. Threshold
// already-live signals with HYSTERESIS + MIN-DWELL so steady state is silent and only edges
// log:
//   • High house load — home.kw > threshold sustained ≥ dwell → observation / high.
//   • High current    — breaker.currentA > threshold → observation / high.
// Both are LOG-ONLY (locked §10.2 — noNotify:true; they never fire Push/WhatsApp). Each pairs
// an ACTIVE event with a matching CLEARED event on recovery via relatedId. READ-ONLY: it reads
// live surfaces + config and emits events; it touches no control logic and never throws.
//
// Plus (Phase 0 rule visibility): the EXPENSIVE-BAND IMPORT watchdog — importing P1/P2 grid
// while the batteries hold usable energy and sit idle, sustained ≥ 10 min. Also log-only
// (no control writes), but its ACTIVE event is high severity WITHOUT noNotify so it rides
// the existing alert fan-out (the owner explicitly wants to hear about this one).

import * as tesla from './connectors/tesla';
import * as sonnen from './connectors/sonnen';
import { getMonitoredBreaker } from './connectors/tuya-voltage';
import { logEvent } from './events';
import { takeEventSnapshot } from './control/event-snapshot';
import * as store from './store';
import { config } from './config';
import { bandInfo, type Band } from './tariff';

/** Per-monitor edge state: tracks the active event + when the signal first crossed. */
interface EdgeState {
  /** The active event id (set while firing), else null. */
  activeId: string | null;
  /** Epoch ms the signal first went above threshold (for the dwell gate), or 0. */
  aboveSince: number;
}

const loadEdge: EdgeState = { activeId: null, aboveSince: 0 };
const currentEdge: EdgeState = { activeId: null, aboveSince: 0 };
const expensiveImportEdge: EdgeState = { activeId: null, aboveSince: 0 };

// ---- Expensive-band import watchdog (Phase 0 rule visibility) ----------------
// "Buying P1/P2 grid power while the batteries hold usable energy and sit idle" —
// the exact failure the owner watched on 2026-07-02 (3.7 kW P2 import, Tesla idle at
// 100%, Sonnen 0%). LOG-ONLY (no control writes); the ACTIVE event is high severity
// and rides the EXISTING alert fan-out (no noNotify — logEvent forwards high/critical
// active observations as-is). Thresholds are named constants (tunable):

/** Grid import (kW) above which the watchdog considers us "buying" (meter noise floor). */
export const EXPENSIVE_IMPORT_GRID_KW = 0.5;
/** Combined battery discharge (kW) BELOW which the batteries count as idle. */
export const EXPENSIVE_IMPORT_IDLE_DISCHARGE_KW = 0.3;
/** SoC headroom (percentage points) above the reserve/floor that counts as usable energy. */
export const EXPENSIVE_IMPORT_HEADROOM_PP = 5;
/** The condition must hold this long before the event fires (sustained, not a blip). */
export const EXPENSIVE_IMPORT_DWELL_MS = 10 * 60_000;

/** Everything the watchdog condition reads — a plain bag so the check stays pure/testable. */
export interface ExpensiveImportInputs {
  /** Current tariff band. */
  band: Band;
  /** Net grid import (kW, ≥0). */
  gridImportKw: number;
  /** Combined Sonnen+Tesla discharge (kW, ≥0; charging counts as 0). */
  batteryDischargeKw: number;
  /** Tesla SoC / backup reserve (%), null when offline. */
  teslaSoc: number | null;
  teslaReservePct: number | null;
  /** Sonnen SoC (%), null when offline. */
  sonnenSoc: number | null;
  /** guardrails.socFloorPct — the Sonnen's discharge floor. */
  sonnenFloorPct: number;
}

/**
 * PURE watchdog condition (unit-tested): true when we're importing expensive-band grid
 * while the batteries idle DESPITE holding usable energy — i.e. band is P1/P2, import
 * exceeds the noise floor, combined discharge is negligible, and at least one battery
 * sits ≥ EXPENSIVE_IMPORT_HEADROOM_PP above its reserve/floor.
 */
export function expensiveImportCondition(i: ExpensiveImportInputs): boolean {
  if (i.band !== 'P1' && i.band !== 'P2') return false;
  if (!(i.gridImportKw > EXPENSIVE_IMPORT_GRID_KW)) return false;
  if (!(i.batteryDischargeKw < EXPENSIVE_IMPORT_IDLE_DISCHARGE_KW)) return false;
  const teslaHasEnergy =
    i.teslaSoc !== null && i.teslaReservePct !== null && i.teslaSoc > i.teslaReservePct + EXPENSIVE_IMPORT_HEADROOM_PP;
  const sonnenHasEnergy = i.sonnenSoc !== null && i.sonnenSoc > i.sonnenFloorPct + EXPENSIVE_IMPORT_HEADROOM_PP;
  return teslaHasEnergy || sonnenHasEnergy;
}

/** Usable idle energy (kWh) above the reserve/floor across both batteries (for the summary). */
export function idleUsableKwh(i: ExpensiveImportInputs): number {
  let kwh = 0;
  if (i.teslaSoc !== null && i.teslaReservePct !== null) {
    kwh += (Math.max(0, i.teslaSoc - i.teslaReservePct) / 100) * config.assets.teslaUsableKwh;
  }
  if (i.sonnenSoc !== null) {
    kwh += (Math.max(0, i.sonnenSoc - i.sonnenFloorPct) / 100) * config.assets.sonnenUsableKwh;
  }
  return Math.round(kwh * 10) / 10;
}

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

/** Run the invariant monitors for one tick. Best-effort; never throws. */
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

    // Expensive-band import watchdog — importing P1/P2 grid while the batteries hold
    // usable energy and sit idle, sustained ≥ EXPENSIVE_IMPORT_DWELL_MS. Log-only
    // observation; the high-severity ACTIVE event rides the existing alert fan-out.
    try {
      await evalExpensiveImport(now);
    } catch {
      /* devices unreadable this tick — skip */
    }
  } catch (e) {
    console.error('[monitors] tick failed:', (e as Error).message);
  }
}

/** Read the live inputs + run the expensive-import edge for one tick. Never throws into
 *  the caller (runEventMonitors wraps it); a device read failure just skips the tick. */
async function evalExpensiveImport(now: number): Promise<void> {
  const [tRes, sRes] = await Promise.allSettled([tesla.getNormalized(), sonnen.getNormalized()]);
  const t = tRes.status === 'fulfilled' ? tRes.value : null;
  const s = sRes.status === 'fulfilled' ? sRes.value : null;
  if (!t && !s) return; // both offline — nothing to judge

  // Net grid import (kW): prefer Tesla's grid meter (+import); fall back to the Sonnen
  // (GridFeedIn_W: +export / −import). Mirrors control/snapshot.ts.
  const gridImportKw = t ? Math.max(0, t.gridKw) : Math.max(0, -(s?.gridFeedInW ?? 0) / 1000);
  const dischargeKw = (t && t.dir === 'discharging' ? t.kw : 0) + (s && s.dir === 'discharging' ? s.kw : 0);

  const inputs: ExpensiveImportInputs = {
    band: bandInfo().band,
    gridImportKw,
    batteryDischargeKw: dischargeKw,
    teslaSoc: t ? t.soc : null,
    teslaReservePct: t ? t.reservePct : null,
    sonnenSoc: s ? s.soc : null,
    sonnenFloorPct: store.get().control.guardrails.socFloorPct,
  };
  const firing = expensiveImportCondition(inputs);
  const edge = expensiveImportEdge;

  const payload = () => ({
    band: inputs.band,
    importKw: Math.round(inputs.gridImportKw * 100) / 100,
    batteryDischargeKw: Math.round(inputs.batteryDischargeKw * 100) / 100,
    teslaSoc: inputs.teslaSoc,
    teslaReservePct: inputs.teslaReservePct,
    sonnenSoc: inputs.sonnenSoc,
    sonnenFloorPct: inputs.sonnenFloorPct,
    teslaMode: t?.mode ?? null,
    sonnenMode: s?.mode ?? null,
    idleUsableKwh: idleUsableKwh(inputs),
  });

  if (edge.activeId === null) {
    // Not firing — arm/refresh the dwell timer; fire once the condition holds ≥ dwell.
    if (firing) {
      if (edge.aboveSince === 0) edge.aboveSince = now;
      if (now - edge.aboveSince >= EXPENSIVE_IMPORT_DWELL_MS) {
        const kwh = idleUsableKwh(inputs);
        const ev = logEvent({
          class: 'observation',
          category: 'battery',
          severity: 'high',
          summary: `Buying ${inputs.band} grid power while ${kwh} kWh sits idle`,
          trigger: {
            source: 'threshold',
            detail: `import > ${EXPENSIVE_IMPORT_GRID_KW} kW in ${inputs.band} with idle batteries for ${EXPENSIVE_IMPORT_DWELL_MS / 60_000} min`,
          },
          device: 'Batteries',
          entity: 'grid.importKw',
          detail: `Importing ${inputs.gridImportKw.toFixed(1)} kW from the grid in the ${inputs.band} band while the batteries hold ~${kwh} kWh above their floors and discharge ${inputs.batteryDischargeKw.toFixed(2)} kW`,
          data: payload(),
          state: 'active',
        });
        edge.activeId = ev.id;
      }
    } else {
      edge.aboveSince = 0;
    }
    return;
  }

  // Currently firing — clear once the condition stops holding.
  if (!firing) {
    const relatedId = edge.activeId;
    edge.activeId = null;
    edge.aboveSince = 0;
    logEvent({
      class: 'observation',
      category: 'battery',
      severity: 'low',
      summary: `Expensive-band import cleared — batteries covering the house again`,
      trigger: { source: 'threshold', detail: 'condition cleared' },
      device: 'Batteries',
      entity: 'grid.importKw',
      detail: `Band ${inputs.band}, import ${inputs.gridImportKw.toFixed(1)} kW, battery discharge ${inputs.batteryDischargeKw.toFixed(2)} kW`,
      data: payload(),
      state: 'cleared',
      relatedId,
      noNotify: true,
    });
  }
}

