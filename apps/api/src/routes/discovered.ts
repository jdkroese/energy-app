// Discovered-devices HTTP surface (Tuya onboarding, Phase 1 — READ + TRIAGE only).
//
// The Tuya connector enumerates the WHOLE paired fleet, but the shipped category
// screens (lights, blinds) only render a whitelist of categories — so plugs, fans,
// sensors, locks, sirens, thermostats etc. exist in the system but are invisible.
// This route surfaces those "not yet set up" devices so the Devices → Needs-setup
// inbox can show + triage them. It writes NOTHING to any device; the only mutations
// are the ignore/keep triage flags persisted in the store.

import * as tuya from '../connectors/tuya';
import { isLight } from '../connectors/tuya-lights';
import { isBlind } from '../connectors/tuya-blinds';
import { toDiscovered, type DiscoveredDevice } from '../connectors/tuya-inference';
import type { TuyaDevice } from '../connectors/tuya';
import * as store from '../store';

function badInput(msg: string): Error & { code: string } {
  const e = new Error(msg) as Error & { code: string };
  e.code = 'BAD_INPUT';
  return e;
}

/** True for a device a shipped category screen already surfaces (lights/blinds). */
function isAlreadyHandled(d: TuyaDevice): boolean {
  return isLight(d) || isBlind(d);
}

/**
 * GET /api/devices/discovered — every paired Tuya device that is (a) NOT already
 * surfaced by a shipped connector and (b) not ignored, enriched with the inferred
 * proposedType / capabilities / confidence / roomGuess. Specs are fetched per device
 * (cached 1h in the connector) to derive writable-vs-readable + bounds; a spec failure
 * degrades gracefully to status-only inference. Ignored devices are returned separately
 * so the inbox can render the collapsible "Ignored" list with a Keep action.
 */
export async function getDiscovered(): Promise<unknown> {
  const connected = tuya.isConfigured();
  if (!connected) {
    return { ts: new Date().toISOString(), connected: false, fleetError: null, devices: [], ignored: [] };
  }
  const ignoredIds = new Set(store.get().deviceOnboarding.ignored);
  let all: TuyaDevice[];
  try {
    all = await tuya.getDevices();
  } catch (e) {
    return { ts: new Date().toISOString(), connected: true, fleetError: (e as Error).message, devices: [], ignored: [] };
  }

  // Candidates = paired devices not already shown by a shipped screen.
  const candidates = all.filter((d) => !isAlreadyHandled(d));

  // Enrich each with its spec (best-effort, in parallel — bounded fleet size).
  const enriched: DiscoveredDevice[] = await Promise.all(
    candidates.map(async (d) => {
      let spec = null;
      try {
        spec = await tuya.getSpecifications(d.id);
      } catch {
        /* no spec — fall back to status-only inference */
      }
      return toDiscovered(d, spec);
    }),
  );

  const devices = enriched.filter((d) => !ignoredIds.has(d.id));
  const ignored = enriched.filter((d) => ignoredIds.has(d.id));

  return { ts: new Date().toISOString(), connected: true, fleetError: null, devices, ignored };
}

/** POST /api/devices/:id/ignore — hide a discovered device from the active inbox. */
export function ignoreDiscovered(id: string): unknown {
  const deviceId = String(id ?? '').trim();
  if (!deviceId) throw badInput('device id required');
  store.update((s) => {
    if (!s.deviceOnboarding.ignored.includes(deviceId)) s.deviceOnboarding.ignored.push(deviceId);
  });
  return { ts: new Date().toISOString(), id: deviceId, ignored: true };
}

/** POST /api/devices/:id/keep — un-ignore a previously ignored device. */
export function keepDiscovered(id: string): unknown {
  const deviceId = String(id ?? '').trim();
  if (!deviceId) throw badInput('device id required');
  store.update((s) => {
    s.deviceOnboarding.ignored = s.deviceOnboarding.ignored.filter((x) => x !== deviceId);
  });
  return { ts: new Date().toISOString(), id: deviceId, ignored: false };
}
