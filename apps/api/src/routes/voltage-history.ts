// GET /api/voltage/history — the Live "Grid voltage" tile's 48h chart overlay.
//
// Returns the persisted 5-min voltage samples (last 48h, ascending by ts) plus
// the configured alert band and the currently-monitored breaker's id/name. The
// samples are filled by getLive() → voltageHistory.record() (see voltage-history.ts);
// this handler is read-only.

import * as voltageHistory from '../voltage-history';
import * as store from '../store';
import { getMonitoredBreaker } from '../connectors/tuya-voltage';

export interface VoltageHistoryResponse {
  samples: Array<{ ts: number; voltageV: number; currentA: number; powerW: number; sonnenUacV?: number }>;
  band: { minV: number; maxV: number };
  breaker: { id: string; name: string } | null;
}

export async function getVoltageHistory(): Promise<VoltageHistoryResponse> {
  const vm = store.get().voltageMonitor;
  // Best-effort breaker identity (null when Tuya is down / no breaker configured);
  // the samples + band still render so the chart never hard-fails on this.
  let breaker: { id: string; name: string } | null = null;
  try {
    const b = await getMonitoredBreaker();
    if (b) breaker = { id: b.id, name: b.name };
  } catch {
    breaker = null;
  }
  return {
    samples: voltageHistory.getRecent(48),
    band: { minV: vm.minV, maxV: vm.maxV },
    breaker,
  };
}
