// Shadow-compare (docs/40 D6 — "migration by shadow-compare").
//
// Each battery tick, diff the engine's would-issue intents against what the LEGACY coordinator
// actually issued this tick, and record only the DIVERGENCES (agreements aren't stored — the
// signal for P1b is where the two disagree). Divergences land in an in-state ring (mirrors the
// arbitrageLog hydration) and are summarized on the latest decision-trace record. An
// Event-Viewer `observation/low` is emitted ONLY when a NEW divergence CLASS first appears —
// never per tick — so a steady mismatch is announced once, not every 90s.
//
// FAIL-SOFT (hard requirement): every export swallows its own errors so the comparator can
// NEVER throw into the control loop. It reads and records; it issues nothing.

import * as store from '../../store';
import type { ShadowDivergence } from '../../store';
import { SHADOW_DIVERGENCE_RING_MAX } from '../../store';
import { logEvent } from '../../events';
import type { Band } from '../../tariff';
import type { Actuator, Claim } from './types';
import { ACTUATORS } from './types';

// ---- What the legacy coordinator issued this tick ---------------------------
// The coordinator records its own issued battery intents into this compact shape (a minimal,
// non-invasive tap — it does NOT change execute/guardrail behaviour). Only the actuators the
// engine also models are captured; anything else is ignored.
export interface LegacyIssued {
  /** Sonnen stance: '2' = self-consumption; '1' = manual (with the signed setpoint). */
  sonnenMode?: '1' | '2';
  sonnenChargeW?: number;
  sonnenDischargeW?: number;
  teslaMode?: 'autonomous' | 'backup' | 'self_consumption';
  teslaReservePct?: number;
  teslaGridCharge?: boolean;
}

/** Render an engine claim's value as a compact comparable string. */
function engineValueStr(actuator: Actuator, claim: Claim): string {
  switch (claim.actuator) {
    case 'sonnen.stance': {
      const v = claim.value;
      if (v.mode === '2') return 'self-consumption';
      if ((v.dischargeW ?? 0) > 0) return `manual discharge ${v.dischargeW}W`;
      if ((v.chargeW ?? 0) > 0) return `manual charge ${v.chargeW}W`;
      return 'manual idle 0W';
    }
    case 'tesla.mode':
      return claim.value;
    case 'tesla.reserve':
      return `${claim.value}%`;
    case 'tesla.gridCharge':
      return claim.value ? 'on' : 'off';
    default:
      return String((claim as { value: unknown }).value);
  }
}

/** Render the legacy-issued value for one actuator (or null when legacy issued nothing). */
function legacyValueStr(actuator: Actuator, issued: LegacyIssued): string | null {
  switch (actuator) {
    case 'sonnen.stance': {
      if (issued.sonnenMode === undefined) return null;
      if (issued.sonnenMode === '2') return 'self-consumption';
      if ((issued.sonnenDischargeW ?? 0) > 0) return `manual discharge ${issued.sonnenDischargeW}W`;
      if ((issued.sonnenChargeW ?? 0) > 0) return `manual charge ${issued.sonnenChargeW}W`;
      return 'manual idle 0W';
    }
    case 'tesla.mode':
      return issued.teslaMode ?? null;
    case 'tesla.reserve':
      return issued.teslaReservePct === undefined ? null : `${issued.teslaReservePct}%`;
    case 'tesla.gridCharge':
      return issued.teslaGridCharge === undefined ? null : issued.teslaGridCharge ? 'on' : 'off';
    default:
      return null;
  }
}

/**
 * A coarse CLASS label for a divergence, so a NEW class of disagreement fires ONE event on
 * first appearance. Deliberately drops exact watt values (which vary continuously and would
 * make every tick a "new" class) and keeps the categorical shape of the disagreement:
 *   • sonnen.stance: the mode pair + whether the setpoint direction differs.
 *   • others: the value pair.
 */
function divergenceClass(actuator: Actuator, engineStr: string, legacyStr: string): string {
  if (actuator === 'sonnen.stance') {
    // Reduce "manual charge 3200W" → "charge", etc., so magnitude noise doesn't spawn classes.
    const shape = (s: string): string =>
      s.startsWith('manual charge')
        ? 'charge'
        : s.startsWith('manual discharge')
          ? 'discharge'
          : s.startsWith('manual idle')
            ? 'idle'
            : 'self-consumption';
    return `sonnen.stance:${shape(engineStr)}-vs-${shape(legacyStr)}`;
  }
  return `${actuator}:${engineStr}-vs-${legacyStr}`;
}

/**
 * Compare the engine's would-issue intents against what the legacy coordinator issued this
 * tick. Records divergences into the ring, returns the compact list (for the decision-trace
 * field), and emits a first-appearance event per new class. Best-effort, never throws.
 *
 * @param intents  the engine's would-issue set (arbiter output; missing actuator ⇒ engine
 *                 wanted the safe default for it — see below)
 * @param issued   what the legacy coordinator actually issued this tick
 * @param band     the tariff band (for the record)
 */
export function compareAndRecord(
  intents: Partial<Record<Actuator, Claim>>,
  issued: LegacyIssued,
  band: Band,
): ShadowDivergence[] {
  try {
    const now = Date.now();
    const divergences: ShadowDivergence[] = [];

    for (const actuator of ACTUATORS) {
      const claim = intents[actuator];
      const legacyStr = legacyValueStr(actuator, issued);

      // The engine's intent for this actuator: a winning claim, or the declared safe default
      // when no rule claimed it (docs/40 §3 — the fallback is explicit, not the bottom of a
      // function). We only compare an actuator when the LEGACY side issued something for it;
      // if legacy issued nothing this tick, there's nothing to diff against.
      if (legacyStr === null) continue;

      const engineStr = claim ? engineValueStr(actuator, claim) : safeDefaultStr(actuator);
      if (engineStr === legacyStr) continue; // agreement — not stored

      const cls = divergenceClass(actuator, engineStr, legacyStr);
      divergences.push({
        ts: now,
        band,
        actuator,
        divergenceClass: cls,
        engine: engineStr,
        legacy: legacyStr,
        engineReason: claim ? claim.reason : `engine safe default (${engineStr})`,
      });
    }

    if (divergences.length === 0) return [];

    // Persist into the ring + detect first-appearance classes (for the one-time event).
    const newClasses: string[] = [];
    store.update((s) => {
      const ring = s.control.engineShadowDivergences ?? [];
      const seen = new Set(s.control.engineShadowSeenClasses ?? []);
      for (const d of divergences) {
        ring.push(d);
        if (!seen.has(d.divergenceClass)) {
          seen.add(d.divergenceClass);
          newClasses.push(d.divergenceClass);
        }
      }
      s.control.engineShadowDivergences = ring.slice(-SHADOW_DIVERGENCE_RING_MAX);
      s.control.engineShadowSeenClasses = [...seen];
      s.control.updatedAt = Date.now();
    });

    // ONE Event-Viewer observation per NEW class (never per tick). Steady-state mismatch is
    // announced once; the ring + endpoint carry the detail.
    for (const cls of newClasses) {
      const d = divergences.find((x) => x.divergenceClass === cls);
      if (!d) continue;
      logEvent({
        class: 'observation',
        category: 'battery',
        severity: 'low',
        summary: `Rule-engine shadow divergence — ${d.actuator}`,
        trigger: { source: 'engine-shadow', detail: cls },
        device: 'Rule engine (shadow)',
        entity: d.actuator,
        ok: true,
        detail: `engine would ${d.engine}; legacy did ${d.legacy}. ${d.engineReason}`,
        data: d as unknown as Record<string, unknown>,
      });
    }

    return divergences;
  } catch (e) {
    console.error('[engine-shadow] compare failed:', (e as Error).message);
    return [];
  }
}

/** The declared safe default per actuator (docs/40 §3): sonnen self-consumption, tesla
 *  self_consumption. Used when the engine claimed nothing for an actuator. */
function safeDefaultStr(actuator: Actuator): string {
  switch (actuator) {
    case 'sonnen.stance':
      return 'self-consumption';
    case 'tesla.mode':
      return 'self_consumption';
    case 'tesla.reserve':
      return '—'; // no engine rule claims reserve in P1a; never equal to a numeric legacy value
    case 'tesla.gridCharge':
      return '—';
    default:
      return '—';
  }
}

// ---- Read side --------------------------------------------------------------
/** Per-actuator agreement rate over the recorded window. Since only DIVERGENCES are stored,
 *  we report the divergence COUNT per actuator + total; a UI can pair it with tick counts if
 *  needed. Also returns the recent divergences (newest first) and the seen-class set. */
export function getShadowReport(limit = 50): unknown {
  const ctrl = store.get().control;
  const ring = ctrl.engineShadowDivergences ?? [];
  const n = Math.min(200, Math.max(1, Math.round(limit)));
  const perActuator: Record<string, number> = {};
  for (const d of ring) perActuator[d.actuator] = (perActuator[d.actuator] ?? 0) + 1;
  return {
    ts: new Date().toISOString(),
    totalDivergences: ring.length,
    perActuatorDivergenceCount: perActuator,
    seenClasses: ctrl.engineShadowSeenClasses ?? [],
    recent: ring.slice(-n).reverse(),
  };
}
