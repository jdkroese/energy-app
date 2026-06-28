import { config } from '../config';
import { RATES, POWER_TERM_EUR_MONTH, EXPORT_RANGE } from '../tariff';
import { probeAll } from './health-probe';
import * as store from '../store';

function tone(ok: boolean): string {
  return ok ? 'ok' : 'danger';
}
function statusLabel(ok: boolean): string {
  return ok ? 'connected' : 'offline';
}

// Loose international phone validation: optional +, 8–15 digits (spaces/dashes ok).
const PHONE_RE = /^\+?[\d][\d\s().-]{6,18}\d$/;

/** PUT /api/settings/whatsapp {number} → validate + persist the WhatsApp number. */
export function setWhatsAppNumber(numberRaw: unknown): unknown {
  const number = String(numberRaw ?? '').trim();
  const digits = number.replace(/\D/g, '');
  if (!PHONE_RE.test(number) || digits.length < 8 || digits.length > 15) {
    const err = new Error('invalid phone number') as Error & { code?: string };
    err.code = 'BAD_INPUT';
    throw err;
  }
  const channels = store.update((s) => {
    s.channels.whatsapp.number = number;
    return s.channels;
  });
  return { ts: new Date().toISOString(), channels };
}

/** GET /api/settings/voltage-monitor → the grid-voltage band config + chosen breaker id. */
export function getVoltageMonitor(): unknown {
  const vm = store.get().voltageMonitor;
  return { ts: new Date().toISOString(), voltageMonitor: vm };
}

/**
 * PATCH /api/settings/voltage-monitor { enabled?, minV?, maxV? } → validate + persist the
 * grid-voltage band. Enforces minV < maxV and a sane 0–500 V range. breakerId is managed by
 * the reader (auto-pick), not user-settable here.
 */
export function setVoltageMonitor(body: unknown): unknown {
  const b = (body ?? {}) as { enabled?: unknown; minV?: unknown; maxV?: unknown };
  const cur = store.get().voltageMonitor;

  const enabled = typeof b.enabled === 'boolean' ? b.enabled : cur.enabled;
  const minV = typeof b.minV === 'number' && Number.isFinite(b.minV) ? b.minV : cur.minV;
  const maxV = typeof b.maxV === 'number' && Number.isFinite(b.maxV) ? b.maxV : cur.maxV;

  if (minV < 0 || maxV > 500 || minV >= maxV) {
    const err = new Error('minV must be ≥ 0 and < maxV (≤ 500)') as Error & { code?: string };
    err.code = 'BAD_INPUT';
    throw err;
  }

  const voltageMonitor = store.update((s) => {
    s.voltageMonitor.enabled = enabled;
    s.voltageMonitor.minV = minV;
    s.voltageMonitor.maxV = maxV;
    return s.voltageMonitor;
  });
  return { ts: new Date().toISOString(), voltageMonitor };
}

export async function getSettings(): Promise<unknown> {
  const probe = await probeAll();
  const channels = store.get().channels;

  return {
    ts: new Date().toISOString(),
    channels: {
      whatsapp: { number: channels.whatsapp.number, enabled: channels.whatsapp.enabled },
      push: { enabled: channels.push.enabled },
      email: { address: channels.email.address, enabled: channels.email.enabled },
    },
    voltageMonitor: store.get().voltageMonitor,
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
