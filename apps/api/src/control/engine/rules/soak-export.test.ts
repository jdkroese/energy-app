// Soak-export PARITY tests — the engine RuleDef's claims must match the LEGACY soak-export
// decision (coordinator.ts::coordinateSonnen "(A) FREE SOLAR" block) across engage / hold /
// revert / hysteresis / ceiling.
// Run: node --import tsx --test src/control/engine/rules/soak-export.test.ts
//
// Strategy: a small `legacySoak()` reference replicates the exact legacy branch (mode + charge
// setpoint, or a revert to self-consumption, or a stand-down). We drive the SAME sequence of
// snapshots through both the reference (carrying the legacy `inManual` device-mode latch) and
// the engine rule (carrying its own `soaking` memory latch) and assert they agree tick-for-tick.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decideSoakExport, type SoakExportParams } from './soak-export';
import type { ReconciledSnapshot } from '../reconciled-snapshot';
import type { RuleMemory } from '../types';

const PARAMS: SoakExportParams = {
  enabled: true,
  startW: 400,
  stopW: 150,
  socCeilingPct: 98,
  sonnenMaxW: 4600,
};

// ---- Legacy reference (mirrors coordinator.ts soak-export branch) ----------
// State the legacy branch reads from the LIVE device: `inManual` (s.mode === 'manual') is the
// hysteresis latch. We thread it explicitly here.
type LegacyResult =
  | { kind: 'engage'; chargeW: number }
  | { kind: 'revert' }
  | { kind: 'standdown' };

function legacySoak(exportW: number, socPct: number, inManual: boolean, p: SoakExportParams): LegacyResult {
  const exporting = exportW > p.stopW;
  // The legacy branch only enters on `exporting || (inManual && exportW > 0)`.
  if (!(exporting || (inManual && exportW > 0))) return { kind: 'standdown' };
  // REVERT: in manual and export ≤ stopW OR SoC ≥ ceiling.
  if (inManual && (exportW <= p.stopW || socPct >= p.socCeilingPct)) return { kind: 'revert' };
  // ENGAGE/HOLD: hysteresis threshold + headroom.
  const engageThreshold = inManual ? p.stopW : p.startW;
  if (exportW > engageThreshold && socPct < p.socCeilingPct) {
    return { kind: 'engage', chargeW: Math.min(exportW, p.sonnenMaxW) };
  }
  return { kind: 'standdown' };
}

// ---- Engine adapter: run the rule and reduce the claim to a comparable result ----
function recon(exportW: number, socPct: number): ReconciledSnapshot {
  return {
    band: 'P1',
    ageMs: 0,
    gridDirection: exportW > 0 ? 'export' : 'neutral',
    gridSource: 'sonnen',
    gridImportW: 0,
    gridExportW: Math.max(0, exportW),
    houseResidualW: 0,
    surplusW: Math.max(0, exportW),
    sonnenSoc: socPct,
    teslaSoc: 50,
    meterDisagreementW: null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    raw: {} as any,
  };
}

function engineSoak(exportW: number, socPct: number, mem: RuleMemory): LegacyResult {
  const claims = decideSoakExport(recon(exportW, socPct), PARAMS, mem);
  if (claims.length === 0) return { kind: 'standdown' };
  const c = claims[0];
  // Soak-export always claims sonnen.stance; narrow so the value is typed as SonnenStance.
  assert.equal(c.actuator, 'sonnen.stance');
  if (c.actuator !== 'sonnen.stance') return { kind: 'standdown' };
  if (c.value.mode === '2') return { kind: 'revert' };
  return { kind: 'engage', chargeW: c.value.chargeW ?? 0 };
}

// ---- Point parity (single-tick, matched latch state) -----------------------
test('engage: export over startW, not yet soaking → both charge min(export,max)', () => {
  const mem: RuleMemory = { soaking: false };
  assert.deepEqual(engineSoak(830, 60, mem), { kind: 'engage', chargeW: 830 });
  assert.deepEqual(legacySoak(830, 60, false, PARAMS), { kind: 'engage', chargeW: 830 });
});

test('hysteresis HOLD: soaking + export between stop and start → keep charging (both)', () => {
  const mem: RuleMemory = { soaking: true };
  // 300W is below startW (400) but above stopW (150): a fresh engage would NOT fire, but a
  // held soak continues.
  assert.deepEqual(engineSoak(300, 60, mem), { kind: 'engage', chargeW: 300 });
  assert.deepEqual(legacySoak(300, 60, true, PARAMS), { kind: 'engage', chargeW: 300 });
});

test('hysteresis GAP: NOT soaking + export between stop and start → stand down (both)', () => {
  const mem: RuleMemory = { soaking: false };
  assert.deepEqual(engineSoak(300, 60, mem), { kind: 'standdown' });
  assert.deepEqual(legacySoak(300, 60, false, PARAMS), { kind: 'standdown' });
});

test('revert on export collapse: soaking + export ≤ stopW → revert (both)', () => {
  const mem: RuleMemory = { soaking: true };
  assert.deepEqual(engineSoak(100, 60, mem), { kind: 'revert' });
  assert.deepEqual(legacySoak(100, 60, true, PARAMS), { kind: 'revert' });
});

test('revert on ceiling: soaking + SoC ≥ ceiling → revert (both)', () => {
  const mem: RuleMemory = { soaking: true };
  assert.deepEqual(engineSoak(2000, 98, mem), { kind: 'revert' });
  assert.deepEqual(legacySoak(2000, 98, true, PARAMS), { kind: 'revert' });
});

test('setpoint clamped to sonnenMaxW (both)', () => {
  const mem: RuleMemory = { soaking: false };
  assert.deepEqual(engineSoak(9000, 50, mem), { kind: 'engage', chargeW: 4600 });
  assert.deepEqual(legacySoak(9000, 50, false, PARAMS), { kind: 'engage', chargeW: 4600 });
});

// ---- Sequence parity (the latch must track identically across a run) --------
test('a full engage→hold→revert→re-engage sequence agrees tick-for-tick', () => {
  // Each step: [exportW, socPct]. We evolve BOTH latches from the SAME decisions.
  const steps: [number, number][] = [
    [0, 60], // no export → standdown
    [500, 60], // engage (over start)
    [300, 62], // hold (hysteresis band, soaking)
    [200, 64], // hold (still > stop)
    [120, 66], // export ≤ stop → revert
    [120, 66], // not soaking now → standdown
    [450, 66], // engage again
    [450, 98], // ceiling reached → revert
  ];

  const mem: RuleMemory = { soaking: false };
  let inManual = false; // legacy device-mode latch

  for (const [exportW, soc] of steps) {
    const eng = engineSoak(exportW, soc, mem);
    const leg = legacySoak(exportW, soc, inManual, PARAMS);
    assert.deepEqual(eng, leg, `divergence at export=${exportW} soc=${soc} (inManual=${inManual})`);
    // Advance the legacy device-mode latch the way the coordinator's issue() would: manual
    // after an engage, self-consumption after a revert, unchanged on stand-down.
    if (leg.kind === 'engage') inManual = true;
    else if (leg.kind === 'revert') inManual = false;
    // stand-down: legacy leaves the device as-is; the coordinator's fall-through self-consumption
    // path would set mode '2', so a stand-down clears inManual too (matches the engine latch,
    // which also clears `soaking` on stand-down).
    else inManual = false;
  }
});

test('disabled while soaking → one revert claim, then nothing', () => {
  const mem: RuleMemory = { soaking: true };
  const off: SoakExportParams = { ...PARAMS, enabled: false };
  const first = decideSoakExport(recon(2000, 60), off, mem);
  assert.equal(first.length, 1);
  assert.equal(first[0].actuator, 'sonnen.stance');
  if (first[0].actuator === 'sonnen.stance') assert.equal(first[0].value.mode, '2');
  const second = decideSoakExport(recon(2000, 60), off, mem);
  assert.equal(second.length, 0, 'latch cleared → no repeat revert');
});

test('Sonnen offline (soc null) → stand down, latch cleared', () => {
  const mem: RuleMemory = { soaking: true };
  const s: ReconciledSnapshot = { ...recon(2000, 60), sonnenSoc: null };
  const claims = decideSoakExport(s, PARAMS, mem);
  assert.equal(claims.length, 0);
  assert.equal(mem.soaking, false);
});
