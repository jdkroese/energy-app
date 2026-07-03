// Unit tests for buildReconciledSnapshot — the D5 "load-bearing" reconciled view.
// Run: node --import tsx --test src/control/engine/reconciled-snapshot.test.ts
//
// The critical property (docs/40 D5): houseResidualW is NOT corrupted by any actuator's own
// flow. The #178 runaway happened because the legacy `drawW` counted the Sonnen's own
// discharge as house load and self-latched to 4.6 kW. Here we prove the reconciled residual
// stays pinned to load−PV regardless of what the Sonnen battery is doing.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildReconciledSnapshot } from './reconciled-snapshot';
import type { RichSnapshot } from '../snapshot';
import type { SonnenNormalized } from '../../connectors/sonnen';
import type { TeslaNormalized } from '../../connectors/tesla';

// ---- Fixture builders -------------------------------------------------------
function sonnen(p: Partial<SonnenNormalized>): SonnenNormalized {
  return {
    soc: 50,
    kwh: 5,
    kw: 0,
    dir: 'idle',
    mode: 'self-consumption',
    productionW: 0,
    gridFeedInW: 0,
    consumptionW: 0,
    uacV: 230,
    online: true,
    ...p,
  };
}

function tesla(p: Partial<TeslaNormalized>): TeslaNormalized {
  return {
    soc: 50,
    kwh: 6,
    kw: 0,
    dir: 'idle',
    reservePct: 20,
    backupKwh: 6,
    backupHours: 6,
    island: false,
    solarKw: 0,
    loadKw: 0,
    gridKw: 0,
    mode: 'self_consumption',
    online: true,
    ...p,
  };
}

function snap(p: Partial<RichSnapshot>): RichSnapshot {
  const s = (p.sonnen ?? null) as SonnenNormalized | null;
  return {
    ageMs: 0,
    band: 'P1',
    sonnenSoc: s ? s.soc : null,
    teslaSoc: p.tesla ? (p.tesla as TeslaNormalized).soc : null,
    teslaReservePct: 20,
    gridImportKw: 0,
    gridExportKw: 0,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    scenario: {} as any,
    sonnen: s,
    tesla: (p.tesla ?? null) as TeslaNormalized | null,
    ...p,
  };
}

// ---- #178 case: residual excludes the Sonnen's own discharge ----------------
test('#178: houseResidualW = load − PV, NOT corrupted by the Sonnen own discharge', () => {
  // The Sonnen is force-discharging 4.6 kW to cover a modest house load with NO PV. The Sonnen
  // meter reports load=1000W, PV=0 — the batteries' own flow does NOT appear in consumptionW.
  // The reconciled residual must be the real unmet demand (1000W), never the 4.6 kW the old
  // self-referential drawW latched to.
  const r = buildReconciledSnapshot(
    snap({
      sonnen: sonnen({ productionW: 0, consumptionW: 1000, dir: 'discharging', kw: 4.6, gridFeedInW: 0 }),
    }),
  );
  assert.equal(r.houseResidualW, 1000, 'residual is load−PV, unaffected by the 4.6kW battery discharge');
});

test('PV surplus → residual is 0 (deadband) and NOT negative', () => {
  const r = buildReconciledSnapshot(
    snap({ sonnen: sonnen({ productionW: 5000, consumptionW: 1000, gridFeedInW: 4000 }) }),
  );
  assert.equal(r.houseResidualW, 0, 'PV covers load → no residual');
  assert.equal(r.gridDirection, 'export');
  assert.equal(r.gridExportW, 4000);
  assert.equal(r.surplusW, 4000, 'surplus == export in the export regime');
});

test('small residual under the deadband collapses to 0', () => {
  const r = buildReconciledSnapshot(
    snap({ sonnen: sonnen({ productionW: 1000, consumptionW: 1200, gridFeedInW: -200 }) }),
  );
  // 200W residual ≤ 300W deadband → 0.
  assert.equal(r.houseResidualW, 0);
});

test('residual above the deadband is reported (rounded)', () => {
  const r = buildReconciledSnapshot(
    snap({ sonnen: sonnen({ productionW: 500, consumptionW: 2000, gridFeedInW: -1500 }) }),
  );
  assert.equal(r.houseResidualW, 1500);
  assert.equal(r.gridDirection, 'import');
  assert.equal(r.gridImportW, 1500);
  assert.equal(r.surplusW, 0);
});

// ---- Grid direction + domain provenance -------------------------------------
test('Sonnen live → grid direction reads the Sonnen domain', () => {
  const r = buildReconciledSnapshot(
    snap({
      sonnen: sonnen({ gridFeedInW: 800, productionW: 3000, consumptionW: 2000 }),
      tesla: tesla({ gridKw: -3 }), // Tesla domain also exporting, but Sonnen is preferred
    }),
  );
  assert.equal(r.gridSource, 'sonnen');
  assert.equal(r.gridDirection, 'export');
  assert.equal(r.gridExportW, 800);
});

test('Sonnen offline → falls back to the Tesla gateway domain; residual is null', () => {
  const r = buildReconciledSnapshot(snap({ sonnen: null, tesla: tesla({ gridKw: 2.5 }) }));
  assert.equal(r.gridSource, 'tesla');
  assert.equal(r.gridDirection, 'import');
  assert.equal(r.gridImportW, 2500);
  assert.equal(r.houseResidualW, null, 'no Sonnen meter → no trustworthy residual → discharge rules stand down');
});

test('both offline → none / neutral / null', () => {
  const r = buildReconciledSnapshot(snap({ sonnen: null, tesla: null }));
  assert.equal(r.gridSource, 'none');
  assert.equal(r.gridDirection, 'neutral');
  assert.equal(r.houseResidualW, null);
  assert.equal(r.surplusW, 0);
  assert.equal(r.meterDisagreementW, null);
});

test('near-zero grid flow is neutral (deadband)', () => {
  const r = buildReconciledSnapshot(
    snap({ sonnen: sonnen({ gridFeedInW: 100, productionW: 1000, consumptionW: 900 }) }),
  );
  assert.equal(r.gridDirection, 'neutral');
  assert.equal(r.gridImportW, 0);
  assert.equal(r.gridExportW, 0);
});

// ---- Meter disagreement (the ~7 kW balance gap becomes a first-class figure) -
test('meterDisagreementW measures the two-domain gap', () => {
  // Sonnen domain: exporting 800W. Tesla domain: importing 3 kW (gridKw +3 → −3000W export).
  // Gap = |800 − (−3000)| = 3800W.
  const r = buildReconciledSnapshot(
    snap({ sonnen: sonnen({ gridFeedInW: 800 }), tesla: tesla({ gridKw: 3 }) }),
  );
  assert.equal(r.meterDisagreementW, 3800);
});

test('domains agree → disagreement ~0', () => {
  // Sonnen exports 2000W; Tesla gridKw −2 (exports 2000W). Gap 0.
  const r = buildReconciledSnapshot(
    snap({ sonnen: sonnen({ gridFeedInW: 2000, productionW: 4000, consumptionW: 2000 }), tesla: tesla({ gridKw: -2 }) }),
  );
  assert.equal(r.meterDisagreementW, 0);
});
