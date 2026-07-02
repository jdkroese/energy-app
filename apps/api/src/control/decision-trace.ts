// Battery decision trace (Phase 0 rule visibility) — answers "why is the battery doing
// X right now?" without restructuring the coordinator. The coordinator calls begin/record/
// commit around its EXISTING decision points, reusing the same reason strings its commands
// already carry; nothing here decides anything.
//
// One compact DecisionRecord per tick lands in an in-state ring (last ~200, survives a
// restart like arbitrageLog) and is served by GET /api/control/decisions. An Event-Viewer
// event is emitted ONLY when the stance CHANGES (tesla.mode or the winning sonnen branch)
// — never per tick, so a steady-state run is silent.
//
// FAIL-SOFT (hard requirement): every exported function swallows its own errors, so the
// trace can NEVER throw into the control loop or block a tick.

import * as store from '../store';
import type { DecisionRecord } from '../store';
import { DECISION_TRACE_RING_MAX } from '../store';
import { logEvent } from '../events';
import type { RichSnapshot } from './snapshot';

/** Cap reason strings so a pathological message can't bloat the persisted ring. */
const REASON_MAX = 160;

function clip(s: string): string {
  return s.length > REASON_MAX ? `${s.slice(0, REASON_MAX - 1)}…` : s;
}

function r2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** The tick currently being traced (the coordinator is strictly sequential per tick). */
let draft: DecisionRecord | null = null;

/** Start tracing one tick. Overwrites any stale, uncommitted draft. */
export function beginDecision(snap: RichSnapshot, trigger: string): void {
  try {
    const ctrl = store.get().control;
    draft = {
      ts: Date.now(),
      trigger,
      armed: ctrl.armed,
      mode: ctrl.mode,
      band: snap.band,
      scenario: store.get().activeScenario,
      inputs: {
        gridImportKw: r2(snap.gridImportKw),
        gridExportKw: r2(snap.gridExportKw),
        // Which meter the import/export figures came from (mirrors control/snapshot.ts:
        // Tesla gateway first, Sonnen fallback). The domains disagree by up to several kW,
        // so record which one this decision reasoned in (audit trail for docs/40 D5).
        gridSource: snap.tesla ? 'tesla' : snap.sonnen ? 'sonnen' : 'none',
        sonnenSoc: snap.sonnenSoc,
        teslaSoc: snap.teslaSoc,
      },
      tesla: { mode: { value: '', reason: '' }, reservePct: 0 },
      sonnen: { branch: '', value: '', reason: '' },
      stoodDown: [],
      changed: [],
    };
  } catch {
    draft = null;
  }
}

/** Record the Tesla mode decision (winner + why). */
export function recordTesla(mode: string, reason: string): void {
  try {
    if (draft) draft.tesla.mode = { value: mode, reason: clip(reason) };
  } catch {
    /* fail-soft */
  }
}

/** Record the Tesla reserve floor issued this tick. */
export function recordTeslaReserve(pct: number): void {
  try {
    if (draft) draft.tesla.reservePct = pct;
  } catch {
    /* fail-soft */
  }
}

/** Record the winning Sonnen branch (each coordinateSonnen branch early-returns, so the
 *  LAST call before the return is the winner; a later call simply overwrites). */
export function recordSonnen(branch: string, value: string, reason: string): void {
  try {
    if (draft) draft.sonnen = { branch, value: clip(value), reason: clip(reason) };
  } catch {
    /* fail-soft */
  }
}

/** Record a rule that stood down this tick, with its reason (de-duped per rule). */
export function recordStandDown(rule: string, reason: string): void {
  try {
    if (draft && !draft.stoodDown.some((s) => s.rule === rule)) {
      draft.stoodDown.push({ rule, reason: clip(reason) });
    }
  } catch {
    /* fail-soft */
  }
}

/**
 * Commit the tick's record: diff against the previous record (stance change?), push onto
 * the persisted ring, and — ONLY on a stance change — emit one Event-Viewer event with the
 * record in `data`. Best-effort, never throws.
 */
export function commitDecision(): void {
  try {
    const rec = draft;
    draft = null;
    if (!rec) return;

    // Stance diff vs the last committed record (the ring survives restarts, so the
    // baseline does too — a deploy doesn't fake a "change").
    const ring = store.get().control.decisionTrace;
    const prev = ring.length > 0 ? ring[ring.length - 1] : null;
    if (prev) {
      if (prev.tesla.mode.value !== rec.tesla.mode.value) rec.changed.push('tesla.mode');
      if (prev.sonnen.branch !== rec.sonnen.branch) rec.changed.push('sonnen');
    }

    store.update((s) => {
      s.control.decisionTrace.push(rec);
      if (s.control.decisionTrace.length > DECISION_TRACE_RING_MAX) {
        s.control.decisionTrace = s.control.decisionTrace.slice(-DECISION_TRACE_RING_MAX);
      }
      s.control.updatedAt = Date.now();
    });

    // Event ONLY on a stance change (never per tick — 90s spam). Routine coordinator
    // stance moves are action/low per the docs/37 severity conventions.
    if (prev && rec.changed.length > 0) {
      const parts: string[] = [];
      if (rec.changed.includes('tesla.mode')) {
        parts.push(`Tesla ${prev.tesla.mode.value || '?'} → ${rec.tesla.mode.value || '?'}`);
      }
      if (rec.changed.includes('sonnen')) {
        parts.push(`Sonnen ${prev.sonnen.branch || '?'} → ${rec.sonnen.branch || '?'}`);
      }
      logEvent({
        class: 'action',
        category: 'battery',
        severity: 'low',
        summary: `Autopilot stance — ${parts.join(' · ')}`,
        trigger: { source: 'coordinator', detail: rec.trigger },
        device: 'Autopilot',
        entity: 'decision',
        ok: true,
        detail: rec.changed.includes('sonnen') ? rec.sonnen.reason : rec.tesla.mode.reason,
        data: rec as unknown as Record<string, unknown>,
      });
    }
  } catch (e) {
    console.error('[decision-trace] commit failed:', (e as Error).message);
  }
}

/** Test/diagnostic helper — drop any uncommitted draft. */
export function _resetDecisionTrace(): void {
  draft = null;
}
