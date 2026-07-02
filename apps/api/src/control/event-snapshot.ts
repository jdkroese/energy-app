// Reproduction-payload helper (docs/37 §2). Builds the `data` snapshot attached to an
// event — the inputs that produced it (meter W, grid V/A, SoC both packs, tariff band,
// relevant config) so an event is a self-contained replay seed. Best-effort + READ-ONLY:
// every read is wrapped, a failure just omits that field. Never throws.

import * as sonnen from '../connectors/sonnen';
import * as tesla from '../connectors/tesla';
import { bandFor } from '../tariff';
import { getMonitoredBreaker } from '../connectors/tuya-voltage';

export interface EventSnapshot {
  band?: string;
  sonnenSoc?: number;
  teslaSoc?: number;
  solarKw?: number;
  loadKw?: number;
  gridKw?: number;
  gridFeedInW?: number;
  gridVoltageV?: number;
  gridCurrentA?: number;
  breakerPowerW?: number;
  sonnenUacV?: number;
  [k: string]: unknown;
}

/**
 * Take a best-effort live snapshot for an event's reproduction payload. Reads the same
 * live surfaces the coordinators use. Any partial failure just leaves the field out.
 */
export async function takeEventSnapshot(): Promise<EventSnapshot> {
  const snap: EventSnapshot = {};
  try {
    snap.band = bandFor(new Date());
  } catch {
    /* omit */
  }
  const [sRes, tRes, bRes] = await Promise.allSettled([
    sonnen.getNormalized(),
    tesla.getNormalized(),
    getMonitoredBreaker(),
  ]);
  if (sRes.status === 'fulfilled' && sRes.value) {
    const s = sRes.value;
    snap.sonnenSoc = s.soc;
    snap.solarKw = round(s.productionW / 1000);
    snap.loadKw = round(s.consumptionW / 1000);
    snap.gridFeedInW = Math.round(s.gridFeedInW);
    if (s.uacV > 0) snap.sonnenUacV = s.uacV;
  }
  if (tRes.status === 'fulfilled' && tRes.value) {
    const t = tRes.value;
    snap.teslaSoc = t.soc;
    snap.gridKw = round(t.gridKw);
    snap.loadKw = t.loadKw;
    snap.solarKw = round((snap.solarKw ?? 0) + t.solarKw);
  }
  if (bRes.status === 'fulfilled' && bRes.value) {
    const b = bRes.value;
    if (b.voltageV > 0) snap.gridVoltageV = b.voltageV;
    if (b.currentA >= 0) snap.gridCurrentA = b.currentA;
    if (b.powerW >= 0) snap.breakerPowerW = b.powerW;
  }
  return snap;
}

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
