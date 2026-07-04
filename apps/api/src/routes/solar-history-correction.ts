// Admin-gated route handlers for the one-time solar-history double-count
// correction (monitoring/data ONLY; no control coupling). Wired admin-gated in
// index.ts, same as admin Settings mutations.
//
//   GET  /api/admin/solar-history-correction  → DRY RUN (writes nothing)
//   POST /api/admin/solar-history-correction  → APPLY (idempotent, backed-up)
//
// Both are safe to call repeatedly: GET is pure; POST is marker-guarded.

import { computeCorrection, applyCorrection, type CorrectionSummary } from '../control/solar-history-correction';

/** DRY RUN: compute + return the correction summary without writing. */
export function getSolarHistoryCorrection(): CorrectionSummary {
  return computeCorrection();
}

/** APPLY: run the idempotent, backed-up, transactional correction once. */
export function postSolarHistoryCorrection(): CorrectionSummary {
  return applyCorrection();
}
