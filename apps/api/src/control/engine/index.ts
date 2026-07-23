// Engine orchestration entry (Phase 1a) — the ONE call the legacy coordinator makes.
//
// runEngineShadow() is the whole shadow path behind a single fail-soft door: it builds the
// reconciled snapshot, seeds each rule's params from live config so the shadow decision uses
// the SAME params the legacy branch used, ticks the engine (issues NOTHING), and hands the
// would-issue intents to the comparator to diff against what legacy actually issued.
//
// SHADOW-ONLY GUARANTEE: this module (and everything it calls) never writes to a device, never
// touches guardrails.ts / execute.ts, and is wrapped so any throw is swallowed — it can NEVER
// break a legacy tick. The legacy coordinator remains the sole writer.

import * as store from '../../store';
import * as sungrow from '../../connectors/sungrow';
import type { RichSnapshot } from '../snapshot';
import { registerRule, tick, setRuleParams } from './engine';
import { buildReconciledSnapshot } from './reconciled-snapshot';
import { compareAndRecord, type LegacyIssued } from './shadow-compare';
import { soakExportRule } from './rules/soak-export';
import type { SoakExportParams } from './rules/soak-export';

let registered = false;

/** Register the P1a rule set once (idempotent). Ported rules go here as they land. */
function ensureRegistered(): void {
  if (registered) return;
  registerRule(soakExportRule);
  registered = true;
}

/** Seed each rule's params from live config so the shadow decision reasons with the SAME
 *  numbers the legacy path used this tick. */
function seedParams(): void {
  const ctrl = store.get().control;
  const soak = ctrl.soakExport;
  const params: SoakExportParams = {
    enabled: soak.enabled,
    startW: soak.startW,
    stopW: soak.stopW,
    socCeilingPct: soak.socCeilingPct,
    sonnenMaxW: ctrl.guardrails.sonnenMaxW,
  };
  setRuleParams('soak-export', params);
}

/**
 * Run the engine in SHADOW for one battery tick and compare to what the legacy coordinator
 * issued. Best-effort — the caller ALSO wraps this, but we belt-and-braces it here so a fault
 * in snapshot reconciliation / a connector read can never surface into the tick.
 *
 * @param snap    the SAME RichSnapshot the legacy tick used (both meter domains + band)
 * @param issued  what the legacy coordinator actually issued this tick (the non-invasive tap)
 */
export async function runEngineShadow(snap: RichSnapshot, issued: LegacyIssued): Promise<void> {
  try {
    ensureRegistered();
    seedParams();

    // Sungrow production (second PV source in the Sonnen domain) for the meter-disagreement
    // reconciliation — best-effort, cached at the connector, and optional (null on any error).
    let sungrowProductionW: number | null = null;
    try {
      const sg = await sungrow.getNormalized();
      sungrowProductionW = sg.productionW;
    } catch {
      sungrowProductionW = null;
    }

    const reconciled = buildReconciledSnapshot(snap, sungrowProductionW);
    const result = tick(reconciled);
    compareAndRecord(result.arbiter.intents, issued, snap.band);
  } catch (e) {
    // FAIL-SOFT: the shadow engine can never break a legacy tick.
    console.error('[engine] shadow run failed:', (e as Error).message);
  }
}
