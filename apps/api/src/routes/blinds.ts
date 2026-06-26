// Blinds HTTP surface (Tuya). Reads are any-authed; commands are admin-gated at
// the route in index.ts. Mirrors routes/lights.ts on the shared `tuya.ts`
// foundation, and degrades gracefully when no Tuya project is connected. Per-device
// room name + position invert come from the shared deviceSettings store.

import * as tuya from '../connectors/tuya';
import * as blinds from '../connectors/tuya-blinds';
import type { BlindLever, BlindUnit } from '../connectors/tuya-blinds';
import * as store from '../store';

function badInput(msg: string): Error & { code: string } {
  const e = new Error(msg) as Error & { code: string };
  e.code = 'BAD_INPUT';
  return e;
}

/** Normalize the connected fleet down to just the blinds/curtains category. */
async function getBlindFleet(): Promise<{ units: BlindUnit[]; error: string | null }> {
  const settings = store.get().deviceSettings;
  try {
    const all = await tuya.getDevices();
    const units = all
      .filter((d) => blinds.isBlind(d))
      .map((d) =>
        blinds.normalizeBlind(d, {
          room: settings[d.id]?.room,
          invert: settings[d.id]?.invertPosition ?? false,
        }),
      );
    return { units, error: null };
  } catch (e) {
    return { units: [], error: (e as Error).message };
  }
}

/** GET /api/blinds — normalized blind fleet + a small context strip. */
export async function getBlinds(): Promise<unknown> {
  if (!tuya.isConfigured()) {
    return {
      ts: new Date().toISOString(),
      connected: false,
      fleetError: null,
      devices: [],
      context: { deviceCount: 0, openCount: 0 },
    };
  }
  const { units, error } = await getBlindFleet();
  return {
    ts: new Date().toISOString(),
    connected: true,
    fleetError: error,
    devices: units,
    context: {
      deviceCount: units.length,
      // "open" = position above a slim threshold (or, with no feedback, unknown→0).
      openCount: units.filter((u) => (u.positionPct ?? 0) > 2).length,
    },
  };
}

/** GET /api/blinds/:id — single blind detail. */
export async function getBlind(id: string): Promise<unknown> {
  if (!tuya.isConfigured()) {
    return { ts: new Date().toISOString(), connected: false, device: null };
  }
  const { units } = await getBlindFleet();
  const device = units.find((u) => u.id === id) ?? null;
  return { ts: new Date().toISOString(), connected: true, device };
}

// ---- Commands (admin) -------------------------------------------------------

export async function commandBlind(id: string, lever: BlindLever, value: unknown): Promise<unknown> {
  if (!blinds.BLIND_LEVERS.includes(lever)) {
    throw badInput(`lever must be one of ${blinds.BLIND_LEVERS.join('|')}`);
  }
  if (!tuya.isConfigured()) throw badInput('Tuya not connected');
  const all = await tuya.getDevices();
  const d = all.find((x) => x.id === id);
  if (!d || !blinds.isBlind(d)) throw badInput(`blind ${id} not found`);

  const invert = store.get().deviceSettings[id]?.invertPosition ?? false;
  const commands = blinds.buildCommands(d, lever, value, invert); // may throw BAD_INPUT
  await tuya.sendCommands(id, commands);
  tuya.invalidateFleet(); // reflect the change on the next read immediately
  return { ts: new Date().toISOString(), ok: true, id, lever, commands };
}

export async function bulkCommandBlinds(ids: string[], lever: BlindLever, value: unknown): Promise<unknown> {
  if (!Array.isArray(ids) || ids.length === 0) throw badInput('ids[] required');
  if (!blinds.BLIND_LEVERS.includes(lever)) {
    throw badInput(`lever must be one of ${blinds.BLIND_LEVERS.join('|')}`);
  }
  if (!tuya.isConfigured()) throw badInput('Tuya not connected');
  const all = await tuya.getDevices();
  const settings = store.get().deviceSettings;
  const results: Array<{ id: string; ok: boolean; reason: string }> = [];
  for (const id of ids) {
    const d = all.find((x) => x.id === id);
    if (!d || !blinds.isBlind(d)) {
      results.push({ id, ok: false, reason: 'not found' });
      continue;
    }
    try {
      await tuya.sendCommands(id, blinds.buildCommands(d, lever, value, settings[id]?.invertPosition ?? false));
      results.push({ id, ok: true, reason: 'ok' });
    } catch (e) {
      results.push({ id, ok: false, reason: (e as Error).message });
    }
  }
  tuya.invalidateFleet();
  return { ts: new Date().toISOString(), results };
}
