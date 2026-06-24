// Builds the ControlSnapshot the guardrails + coordinator reason about: live
// device state, current tariff band, and the active scenario. The live reads go
// through the cached connectors, so a snapshot is cheap to take each tick.

import * as sonnen from '../connectors/sonnen';
import * as tesla from '../connectors/tesla';
import * as store from '../store';
import { bandFor } from '../tariff';
import type { ControlSnapshot } from './guardrails';

export interface RichSnapshot extends ControlSnapshot {
  /** Raw normalized device views (null when offline) for the coordinator logic. */
  sonnen: sonnen.SonnenNormalized | null;
  tesla: tesla.TeslaNormalized | null;
}

/**
 * Take a fresh control snapshot. `ageMs` reflects the OLDEST successful live read
 * used; if BOTH devices are unreachable we report a stale (Infinity) age so every
 * command is aborted by the freshness guard.
 */
export async function takeSnapshot(): Promise<RichSnapshot> {
  const t0 = Date.now();
  const [sRes, tRes] = await Promise.allSettled([sonnen.getNormalized(), tesla.getNormalized()]);
  const s = sRes.status === 'fulfilled' ? sRes.value : null;
  const t = tRes.status === 'fulfilled' ? tRes.value : null;

  const state = store.get();
  const scenario = state.scenarios[state.activeScenario] ?? store.DEFAULT_SCENARIOS.balanced;

  // ageMs: 0 when at least one device answered (reads just completed), Infinity
  // when neither did so the freshness guard aborts every command this tick.
  const anyLive = s !== null || t !== null;
  const ageMs = anyLive ? Date.now() - t0 : Number.POSITIVE_INFINITY;

  // Grid import in kW (+import). Prefer Tesla's grid meter; fall back to Sonnen.
  let gridImportKw = 0;
  if (t) gridImportKw = Math.max(0, t.gridKw);
  else if (s) gridImportKw = Math.max(0, -s.gridFeedInW / 1000); // GridFeedIn_W: + export / - import

  return {
    ageMs,
    band: bandFor(new Date()),
    sonnenSoc: s ? s.soc : null,
    teslaSoc: t ? t.soc : null,
    teslaReservePct: t ? t.reservePct : store.get().control.guardrails.teslaReserveMinPct,
    gridImportKw,
    scenario,
    sonnen: s,
    tesla: t,
  };
}
