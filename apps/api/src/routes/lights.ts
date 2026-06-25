// Lights HTTP surface (Tuya). Reads are any-authed; commands + the integration
// connect/disconnect are admin-gated at the route in index.ts. Everything
// degrades gracefully when no Tuya project is connected (empty list / "not
// connected"). This is the first Tuya CATEGORY screen; covers/switches/breakers/
// fans will follow the same shape on the shared `tuya.ts` foundation.

import * as tuya from '../connectors/tuya';
import * as lights from '../connectors/tuya-lights';
import type { LightLever, LightUnit } from '../connectors/tuya-lights';
import * as store from '../store';

function badInput(msg: string): Error & { code: string } {
  const e = new Error(msg) as Error & { code: string };
  e.code = 'BAD_INPUT';
  return e;
}

/** Normalize the connected fleet down to just the light category. */
async function getLightFleet(): Promise<{ units: LightUnit[]; error: string | null }> {
  const settings = store.get().deviceSettings;
  try {
    const all = await tuya.getDevices();
    const units = all
      .filter((d) => lights.isLight(d))
      .map((d) => lights.normalizeLight(d, settings[d.id]?.room));
    return { units, error: null };
  } catch (e) {
    return { units: [], error: (e as Error).message };
  }
}

/** GET /api/lights — normalized light fleet + a small context strip. */
export async function getLights(): Promise<unknown> {
  const connected = tuya.isConfigured();
  if (!connected) {
    return {
      ts: new Date().toISOString(),
      connected: false,
      fleetError: null,
      devices: [],
      context: { deviceCount: 0, onCount: 0 },
    };
  }
  const { units, error } = await getLightFleet();
  return {
    ts: new Date().toISOString(),
    connected: true,
    fleetError: error,
    devices: units,
    context: {
      deviceCount: units.length,
      onCount: units.filter((u) => u.power).length,
    },
  };
}

/** GET /api/lights/:id — single light detail. */
export async function getLight(id: string): Promise<unknown> {
  if (!tuya.isConfigured()) {
    return { ts: new Date().toISOString(), connected: false, device: null };
  }
  const { units } = await getLightFleet();
  const device = units.find((u) => u.id === id) ?? null;
  return { ts: new Date().toISOString(), connected: true, device };
}

// ---- Commands (admin) -------------------------------------------------------

export async function commandLight(id: string, lever: LightLever, value: unknown): Promise<unknown> {
  if (!lights.LIGHT_LEVERS.includes(lever)) {
    throw badInput(`lever must be one of ${lights.LIGHT_LEVERS.join('|')}`);
  }
  if (!tuya.isConfigured()) throw badInput('Tuya not connected');
  const all = await tuya.getDevices();
  const d = all.find((x) => x.id === id);
  if (!d || !lights.isLight(d)) throw badInput(`light ${id} not found`);

  const commands = lights.buildCommands(d, lever, value); // may throw BAD_INPUT
  await tuya.sendCommands(id, commands);
  tuya.invalidateFleet(); // reflect the change on the next read immediately
  return { ts: new Date().toISOString(), ok: true, id, lever, commands };
}

export async function bulkCommandLights(ids: string[], lever: LightLever, value: unknown): Promise<unknown> {
  if (!Array.isArray(ids) || ids.length === 0) throw badInput('ids[] required');
  if (!lights.LIGHT_LEVERS.includes(lever)) {
    throw badInput(`lever must be one of ${lights.LIGHT_LEVERS.join('|')}`);
  }
  if (!tuya.isConfigured()) throw badInput('Tuya not connected');
  const all = await tuya.getDevices();
  const results: Array<{ id: string; ok: boolean; reason: string }> = [];
  for (const id of ids) {
    const d = all.find((x) => x.id === id);
    if (!d || !lights.isLight(d)) {
      results.push({ id, ok: false, reason: 'not found' });
      continue;
    }
    try {
      await tuya.sendCommands(id, lights.buildCommands(d, lever, value));
      results.push({ id, ok: true, reason: 'ok' });
    } catch (e) {
      results.push({ id, ok: false, reason: (e as Error).message });
    }
  }
  tuya.invalidateFleet();
  return { ts: new Date().toISOString(), results };
}

// ---- Integration: Tuya Cloud (admin) ----------------------------------------

/** GET /api/integrations/tuya — connection status + discovered category breakdown. */
export async function getTuyaIntegration(): Promise<unknown> {
  const connected = tuya.isConfigured();
  const t = store.get().integrations.tuya;
  let deviceCount = 0;
  let lightCount = 0;
  let categories: Array<{ label: string; count: number }> = [];
  let error: string | null = null;
  if (connected) {
    try {
      const all = await tuya.getDevices();
      deviceCount = all.length;
      lightCount = all.filter((d) => lights.isLight(d)).length;
      categories = tuya.categorize(all);
    } catch (e) {
      error = (e as Error).message;
    }
  }
  return {
    ts: new Date().toISOString(),
    connected,
    region: t?.region ?? 'eu',
    deviceCount,
    lightCount,
    categories,
    error,
  };
}

/** POST /api/integrations/tuya — validate creds (token + discovery) then persist. */
export async function setTuyaIntegration(
  regionRaw: unknown,
  accessIdRaw: unknown,
  accessSecretRaw: unknown,
): Promise<unknown> {
  const region = String(regionRaw ?? 'eu').trim().toLowerCase();
  const accessId = String(accessIdRaw ?? '').trim();
  const accessSecret = String(accessSecretRaw ?? '').trim();
  if (!tuya.REGIONS.includes(region)) throw badInput(`region must be one of ${tuya.REGIONS.join('|')}`);
  if (!accessId || !accessSecret) throw badInput('Access ID and Access Secret are required');

  // Validate by fetching a token BEFORE persisting; never log the secret.
  try {
    await tuya.probe({ region, accessId, accessSecret });
  } catch (e) {
    throw badInput(`Tuya connection failed: ${(e as Error).message}`);
  }

  store.update((s) => {
    s.integrations = s.integrations ?? { intesis: null };
    s.integrations.tuya = { region, accessId, accessSecret };
  });
  tuya.invalidateFleet();
  return getTuyaIntegration();
}

export function disconnectTuyaIntegration(): unknown {
  store.update((s) => {
    if (s.integrations) s.integrations.tuya = undefined;
  });
  tuya.invalidateFleet();
  return { ts: new Date().toISOString(), connected: false };
}
