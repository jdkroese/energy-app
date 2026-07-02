// Builds the ClimateSnapshot the climate guardrails + coordinator reason about:
// freshness, tariff band, grid import (for the 14 kW cap), and the solar surplus
// available for opportunistic loads — grid export (the solar we're actually spilling
// to the grid). Reuses the cached connectors so a snapshot is cheap to take each tick.

import * as sonnen from '../connectors/sonnen';
import * as tesla from '../connectors/tesla';
import { bandFor } from '../tariff';
import type { ClimateSnapshot } from './climate-guardrails';

export interface RichClimateSnapshot extends ClimateSnapshot {
  /** PV production (W) across both arrays. */
  pvW: number;
  /** House load (W). */
  houseLoadW: number;
  /**
   * Surplus available for opportunistic loads (W) = solar we are ACTUALLY spilling to the
   * grid right now (feed-in). Positive ⇒ exported solar we can spend on AC / EV / irrigation.
   */
  surplusW: number;
  /** Combined battery SoC headroom (%). */
  batteryHeadroomPct: number;
  /**
   * false when we have NO live meter to read grid export from — surplus starts are then
   * suppressed (we can't prove there is spare solar). A single live source (Tesla gateway or
   * Sonnen) is enough: grid export is a direct meter reading, not a two-battery estimate.
   */
  batteryDataComplete: boolean;
}

/**
 * The surplus (W) the opportunistic-load rules (surplus cooling/heating, EV, irrigation)
 * reason about = solar we are ACTUALLY exporting to the grid right now (feed-in).
 *
 * Why grid export and not "PV − load − battery headroom": by energy balance,
 *   grid export = PV − house load − (the batteries' ACTUAL charge draw),
 * so export already reserves whatever the batteries are absorbing — batteries-first, WITHOUT
 * guessing a nameplate max-charge. It self-corrects when a battery is charge-rate- or grid-
 * limited (e.g. the PW3s / Sonnen won't absorb during a midday grid over-voltage): that
 * un-absorbed solar shows up as export and becomes spendable, which the old theoretical-
 * headroom model (nameplate reserve) wrongly held back. Prefer the Tesla gateway meter
 * (whole-home grid_power; <0 = export), fall back to the Sonnen feed-in meter.
 */
export function climateSurplusW(
  s: sonnen.SonnenNormalized | null,
  t: tesla.TeslaNormalized | null,
): number {
  const exportW =
    t != null ? Math.max(0, -t.gridKw * 1000) : s != null ? Math.max(0, s.gridFeedInW) : 0;
  return Math.round(exportW);
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
  // can never drift (both = grid export, the solar we're actually spilling to the grid).
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
    // Surplus now comes from a direct grid-export meter, so one live source is enough — we no
    // longer need BOTH batteries. This matters precisely during a midday over-voltage, when the
    // Sonnen read can drop out yet the Tesla gateway still reports the (large) export we want to
    // spend. Only truly-no-data blocks starts (freshness also guards via ageMs above).
    batteryDataComplete: s !== null || t !== null,
  };
}
