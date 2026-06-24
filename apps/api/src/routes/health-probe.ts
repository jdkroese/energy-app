import * as sonnen from '../connectors/sonnen';
import * as tesla from '../connectors/tesla';
import * as weather from '../connectors/weather';

export interface ProbeResult {
  ok: boolean;
  detail: string;
}

/** Ping each source. Used by /api/settings (connection health) and /api/alerts. */
export async function probeAll(): Promise<{
  sonnen: ProbeResult;
  tesla: ProbeResult;
  weather: ProbeResult;
}> {
  const [s, t, w] = await Promise.allSettled([
    sonnen.getStatus(),
    tesla.getLiveStatus(),
    weather.getForecast(),
  ]);
  return {
    sonnen:
      s.status === 'fulfilled'
        ? { ok: true, detail: 'LAN reachable' }
        : { ok: false, detail: trim((s.reason as Error)?.message) },
    tesla:
      t.status === 'fulfilled'
        ? { ok: true, detail: 'Cloud OK' }
        : { ok: false, detail: trim((t.reason as Error)?.message) },
    weather:
      w.status === 'fulfilled' && w.value
        ? { ok: true, detail: 'Open-Meteo OK' }
        : { ok: false, detail: 'Forecast unavailable' },
  };
}

function trim(msg: string | undefined): string {
  if (!msg) return 'unreachable';
  return msg.length > 60 ? msg.slice(0, 57) + '…' : msg;
}
