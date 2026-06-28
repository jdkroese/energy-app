// Builds the ClimateSnapshot the climate guardrails + coordinator reason about:
// freshness, tariff band, grid import (for the 14 kW cap), and the solar surplus
// available for opportunistic cooling. Reuses the cached connectors so a snapshot
// is cheap to take each tick.

import * as sonnen from '../connectors/sonnen';
import * as tesla from '../connectors/tesla';
import { config } from '../config';
import { bandFor } from '../tariff';
import type { ClimateSnapshot } from './climate-guardrails';

export interface RichClimateSnapshot extends ClimateSnapshot {
  /** PV production (W) across both arrays. */
  pvW: number;
  /** House load (W). */
  houseLoadW: number;
  /**
   * Surplus available for cooling (W): PV − houseLoad − how much the batteries
   * could still absorb. Positive ⇒ otherwise-exported solar we can spend on AC.
   */
  surplusW: number;
  /** Combined battery SoC headroom (%). */
  batteryHeadroomPct: number;
  /**
   * false when a configured battery's live read is missing — surplus starts are
   * suppressed (the headroom term would be under-counted ⇒ surplus overstated).
   */
  batteryDataComplete: boolean;
}

/** Approximate how much charge power (W) the batteries can still absorb. */
export function batteryIntakeHeadroomW(
  s: sonnen.SonnenNormalized | null,
  t: tesla.TeslaNormalized | null,
): number {
  let w = 0;
  // Each battery can absorb up to its max kW when below ~98% SoC; taper near full.
  if (s && s.soc < 98) w += config.assets.sonnenMaxKw * 1000 * Math.min(1, (98 - s.soc) / 20);
  if (t && t.soc < 98) w += config.assets.teslaMaxKw * 1000 * Math.min(1, (98 - t.soc) / 20);
  return Math.max(0, w);
}

/** The surplus (W) the surplus rule reasons about: PV − house load − battery intake headroom. */
export function climateSurplusW(
  s: sonnen.SonnenNormalized | null,
  t: tesla.TeslaNormalized | null,
): number {
  const pvW = (t ? t.solarKw * 1000 : 0) + (s ? s.productionW : 0);
  const houseLoadW = t ? t.loadKw * 1000 : s ? s.consumptionW : 0;
  return Math.round(pvW - houseLoadW - batteryIntakeHeadroomW(s, t));
}

export async function takeClimateSnapshot(): Promise<RichClimateSnapshot> {
  const t0 = Date.now();
  const [sRes, tRes] = await Promise.allSettled([sonnen.getNormalized(), tesla.getNormalized()]);
  const s = sRes.status === 'fulfilled' ? sRes.value : null;
  const t = tRes.status === 'fulfilled' ? tRes.value : null;

  const anyLive = s !== null || t !== null;
  const ageMs = anyLive ? Date.now() - t0 : Number.POSITIVE_INFINITY;

  // PV: Tesla solar (Array B) + Sonnen production (Array A).
  const pvW = (t ? t.solarKw * 1000 : 0) + (s ? s.productionW : 0);
  // House load: prefer Tesla load; else Sonnen consumption.
  const houseLoadW = t ? t.loadKw * 1000 : s ? s.consumptionW : 0;

  // Grid import in kW (+import). Prefer Tesla; fall back to Sonnen feed-in sign.
  let gridImportKw = 0;
  if (t) gridImportKw = Math.max(0, t.gridKw);
  else if (s) gridImportKw = Math.max(0, -s.gridFeedInW / 1000);

  // Compute surplus via the shared helper so the snapshot and the /api/live route
  // can never drift (both = PV − houseLoad − battery intake headroom).
  const surplusW = climateSurplusW(s, t);

  const socs: number[] = [];
  if (s) socs.push(s.soc);
  if (t) socs.push(t.soc);
  const avgSoc = socs.length ? socs.reduce((a, b) => a + b, 0) / socs.length : 100;

  return {
    ageMs,
    band: bandFor(new Date()),
    gridImportKw,
    pendingImportKw: 0,
    pvW: Math.round(pvW),
    houseLoadW: Math.round(houseLoadW),
    surplusW: Math.round(surplusW),
    batteryHeadroomPct: Math.round(100 - avgSoc),
    // This deployment runs BOTH a Sonnen and a Tesla; the connectors expose no
    // isConfigured(), so "complete" requires both live reads. A missing read means
    // the headroom term is under-counted ⇒ surplus would be overstated.
    batteryDataComplete: s !== null && t !== null,
  };
}
