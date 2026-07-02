import * as sonnen from '../connectors/sonnen';
import * as tesla from '../connectors/tesla';
import * as weather from '../connectors/weather';
import * as sungrow from '../connectors/sungrow';
import { isDaylightNow } from '../solar-daylight';

export interface ProbeResult {
  ok: boolean;
  detail: string;
}

/** Per-inverter probe result (dongle reachability + night-awareness). */
export interface InverterProbeResult extends ProbeResult {
  id: string;
  name: string;
  ip: string;
  /** True when the sun is up — a night miss is expected (the dongle dies with the inverter). */
  daylight: boolean;
  lastSeen: string | null;
}

/** Ping each source. Used by /api/settings (connection health) and /api/alerts. */
export async function probeAll(): Promise<{
  sonnen: ProbeResult;
  tesla: ProbeResult;
  weather: ProbeResult;
  sungrow: InverterProbeResult[];
}> {
  const [s, t, w, inv] = await Promise.allSettled([
    sonnen.getStatus(),
    tesla.getLiveStatus(),
    weather.getForecast(),
    sungrow.getInverters(),
  ]);
  const daylight = isDaylightNow();
  const inverters: InverterProbeResult[] =
    inv.status === 'fulfilled'
      ? inv.value.map((i) => ({
          id: i.id,
          name: i.name,
          ip: i.ip,
          daylight,
          lastSeen: i.lastSeen,
          // A night miss is EXPECTED (string inverter + its dongle de-energize at dusk),
          // so it reads as "ok" (asleep) — only a daylight miss is a real problem.
          ok: i.reachable || !daylight,
          detail: i.reachable
            ? 'LAN reachable'
            : daylight
              ? trim(i.detail ?? 'unreachable in daylight')
              : 'asleep (night — expected)',
        }))
      : [];
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
    sungrow: inverters,
  };
}

function trim(msg: string | undefined): string {
  if (!msg) return 'unreachable';
  return msg.length > 60 ? msg.slice(0, 57) + '…' : msg;
}
