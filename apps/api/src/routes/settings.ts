import { config } from '../config';
import { RATES, POWER_TERM_EUR_MONTH, EXPORT_RANGE } from '../tariff';
import { probeAll } from './health-probe';

function tone(ok: boolean): string {
  return ok ? 'ok' : 'danger';
}
function statusLabel(ok: boolean): string {
  return ok ? 'connected' : 'offline';
}

export async function getSettings(): Promise<unknown> {
  const probe = await probeAll();

  return {
    ts: new Date().toISOString(),
    connections: [
      {
        name: 'Tesla cloud',
        icon: 'cloud',
        tone: tone(probe.tesla.ok),
        status: statusLabel(probe.tesla.ok),
        detail: probe.tesla.detail,
      },
      {
        name: 'Sonnen LAN',
        icon: 'battery-charging',
        tone: tone(probe.sonnen.ok),
        status: statusLabel(probe.sonnen.ok),
        detail: probe.sonnen.detail,
      },
      {
        name: 'Weather',
        icon: 'cloud-sun',
        tone: tone(probe.weather.ok),
        status: statusLabel(probe.weather.ok),
        detail: probe.weather.detail,
      },
      {
        name: 'Sungrow',
        icon: 'sun',
        tone: 'warning',
        status: 'pending',
        detail: 'Array A direct read not yet wired',
      },
    ],
    tariff: {
      bands: [
        { band: 'P1', rate: RATES.P1 },
        { band: 'P2', rate: RATES.P2 },
        { band: 'P3', rate: RATES.P3 },
      ],
      powerTermEur: POWER_TERM_EUR_MONTH,
      exportRange: `€${EXPORT_RANGE.min.toFixed(3)}–${EXPORT_RANGE.max.toFixed(3)}/kWh`,
    },
    assets: [
      {
        name: 'Sonnen Batterie 10',
        icon: 'battery-charging',
        tone: 'battery',
        detail: `${config.assets.sonnenUsableKwh} kWh usable · ${config.assets.sonnenMaxKw} kW`,
      },
      {
        name: 'Tesla Powerwall 3 ×2',
        icon: 'battery-full',
        tone: 'battery',
        detail: `${config.assets.teslaUsableKwh} kWh · ${config.assets.teslaMaxKw} kW`,
      },
      {
        name: 'Solar arrays',
        icon: 'sun',
        tone: 'solar',
        detail: `${config.site.solarKwp} kWp · 2 arrays`,
      },
      {
        name: 'Grid connection',
        icon: 'plug',
        tone: 'grid',
        detail: 'Single-phase 14 kW · 2.0TD',
      },
    ],
  };
}
