// Lights HTTP surface (Tuya). Reads are any-authed; commands + the integration
// connect/disconnect are admin-gated at the route in index.ts. Everything
// degrades gracefully when no Tuya project is connected (empty list / "not
// connected"). This is the first Tuya CATEGORY screen; covers/switches/breakers/
// fans will follow the same shape on the shared `tuya.ts` foundation.

import * as tuya from '../connectors/tuya';
import * as lights from '../connectors/tuya-lights';
import { isBlind } from '../connectors/tuya-blinds';
import type { LightLever, LightUnit } from '../connectors/tuya-lights';
import {
  resolveConfiguredLightCaps,
  normalizeConfiguredLight,
  buildConfiguredLightCommands,
} from '../connectors/tuya-configured-lights';
import type { TuyaDevice, TuyaSpec } from '../connectors/tuya';
import * as store from '../store';
import { resolveRoomId } from '../rooms';

/** Attach the first-class Rooms fields (roomId + resolved name) to a normalized unit. */
function withRoom<T extends { id: string }>(u: T): T & { roomId: string | null; roomName: string | null } {
  const roomId = resolveRoomId(u.id);
  const roomName = roomId ? store.get().rooms[roomId]?.name ?? null : null;
  return { ...u, roomId, roomName };
}

function badInput(msg: string): Error & { code: string } {
  const e = new Error(msg) as Error & { code: string };
  e.code = 'BAD_INPUT';
  return e;
}

/** Best-effort device spec (cached in the connector); null on failure. */
async function specFor(id: string): Promise<TuyaSpec | null> {
  try {
    return await tuya.getSpecifications(id);
  } catch {
    return null;
  }
}

/** The user-SET-UP devices that were configured as lighting (typeId 'lighting').
 *  These graduate into the light fleet alongside the native Tuya light categories. */
function configuredLightingMap(): Record<string, store.ConfiguredDevice> {
  const out: Record<string, store.ConfiguredDevice> = {};
  for (const [id, cfg] of Object.entries(store.get().deviceOnboarding.configured)) {
    if (cfg.typeId === 'lighting') out[id] = cfg;
  }
  return out;
}

/** Resolve the DP commands for a light lever against EITHER a native Tuya light or a
 *  configured-lighting device (which carries inferred + override capabilities). Throws
 *  BAD_INPUT when the id isn't a light at all. */
async function buildAnyLightCommands(
  d: TuyaDevice,
  lever: LightLever,
  value: unknown,
  cfgMap: Record<string, store.ConfiguredDevice>,
): Promise<Array<{ code: string; value: unknown }>> {
  const cfg = cfgMap[d.id];
  if (cfg) {
    const caps = resolveConfiguredLightCaps(d, cfg, await specFor(d.id));
    return buildConfiguredLightCommands(d, caps, lever, value);
  }
  if (lights.isLight(d)) return lights.buildCommands(d, lever, value);
  throw badInput(`light ${d.id} not found`);
}

/** Normalize the connected fleet down to lights — native categories PLUS any device
 *  the user set up as lighting (rendered with the same LightUnit shape + card). */
export async function getLightFleet(): Promise<{ units: LightUnit[]; error: string | null }> {
  const settings = store.get().deviceSettings;
  try {
    const all = await tuya.getDevices();
    const byId = new Map(all.map((d) => [d.id, d]));
    const units = all
      .filter((d) => lights.isLight(d))
      .map((d) => lights.normalizeLight(d, settings[d.id]?.name));

    // Append user-set-up lighting devices (typeId 'lighting') as first-class lights.
    // Skip ones that are already a native light (no double-up) or no longer reported.
    const cfgLighting = configuredLightingMap();
    const nativeIds = new Set(units.map((u) => u.id));
    const extras = await Promise.all(
      Object.entries(cfgLighting).map(async ([id, cfg]) => {
        if (nativeIds.has(id)) return null;
        const d = byId.get(id);
        if (!d) return null;
        return normalizeConfiguredLight(d, cfg, await specFor(id), settings[id]?.name);
      }),
    );
    for (const u of extras) if (u) units.push(u);

    return { units: units.map(withRoom), error: null };
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
  if (!d) throw badInput(`light ${id} not found`);

  // Native light OR a device set up as lighting; buildAnyLightCommands routes both.
  const cfgMap = configuredLightingMap();
  const commands = await buildAnyLightCommands(d, lever, value, cfgMap); // may throw BAD_INPUT
  // Set-up plugs/switches vary in which Tuya command API actuates them — issue both
  // (idempotent). Native Tuya lights are well-behaved on the legacy API.
  if (cfgMap[id]) await tuya.sendCommandsDual(id, commands);
  else await tuya.sendCommands(id, commands);
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
  const cfgMap = configuredLightingMap();
  const results: Array<{ id: string; ok: boolean; reason: string }> = [];
  for (const id of ids) {
    const d = all.find((x) => x.id === id);
    if (!d || (!lights.isLight(d) && !cfgMap[id])) {
      results.push({ id, ok: false, reason: 'not found' });
      continue;
    }
    try {
      const cmds = await buildAnyLightCommands(d, lever, value, cfgMap);
      if (cfgMap[id]) await tuya.sendCommandsDual(id, cmds);
      else await tuya.sendCommands(id, cmds);
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
  const onboarding = store.get().deviceOnboarding;
  const ignored = new Set(onboarding.ignored);
  let deviceCount = 0;
  let lightCount = 0;
  let needsSetupCount = 0;
  let categories: Array<{ label: string; count: number }> = [];
  let error: string | null = null;
  if (connected) {
    try {
      const all = await tuya.getDevices();
      deviceCount = all.length;
      lightCount = all.filter((d) => lights.isLight(d)).length;
      // "Needs setup" = paired devices no shipped screen renders, minus ignored AND minus
      // already-set-up devices — the same membership as the Discovered inbox, so the
      // Connections card's "N devices not yet set up" matches what the inbox shows.
      needsSetupCount = all.filter(
        (d) => !lights.isLight(d) && !isBlind(d) && !ignored.has(d.id) && !onboarding.configured[d.id],
      ).length;
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
    needsSetupCount,
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

// ---- Scenes -----------------------------------------------------------------
// A scene = a named set of per-light targets (on/off + optional brightness).
// Applying a scene sends the matching Tuya commands to each member light.

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function sanitizeMembers(raw: unknown): store.LightSceneMember[] {
  if (!Array.isArray(raw)) return [];
  const out: store.LightSceneMember[] = [];
  for (const m of raw) {
    const o = (m ?? {}) as Record<string, unknown>;
    if (typeof o.lightId !== 'string' || !o.lightId) continue;
    const pct = Number(o.brightnessPct);
    out.push({
      lightId: o.lightId,
      on: Boolean(o.on),
      brightnessPct: Number.isFinite(pct) ? Math.max(1, Math.min(100, pct)) : null,
    });
  }
  return out;
}

export function listScenes(): unknown {
  return { ts: new Date().toISOString(), scenes: store.get().lightScenes };
}

export function createScene(body: Partial<store.LightScene>): unknown {
  const scene: store.LightScene = {
    id: newId('scene'),
    name: body.name?.trim() || 'New scene',
    icon: typeof body.icon === 'string' ? body.icon : 'sparkles',
    ...(body.favorite ? { favorite: true as const } : {}),
    members: sanitizeMembers(body.members),
  };
  store.update((s) => {
    s.lightScenes.push(scene);
  });
  return { ts: new Date().toISOString(), scene };
}

export function updateScene(id: string, body: Partial<store.LightScene>): unknown {
  const saved = store.update((s) => {
    const idx = s.lightScenes.findIndex((x) => x.id === id);
    if (idx < 0) return null;
    const cur = s.lightScenes[idx];
    const favorite = body.favorite !== undefined ? Boolean(body.favorite) : cur.favorite;
    const merged: store.LightScene = {
      ...cur,
      name: body.name?.trim() || cur.name,
      icon: typeof body.icon === 'string' ? body.icon : cur.icon,
      ...(favorite ? { favorite: true as const } : {}),
      members: body.members !== undefined ? sanitizeMembers(body.members) : cur.members,
    };
    // Un-starring must drop the key, not leave a stale `true` (spread only adds it).
    if (!favorite) delete merged.favorite;
    s.lightScenes[idx] = merged;
    return merged;
  });
  if (!saved) throw badInput(`scene ${id} not found`);
  return { ts: new Date().toISOString(), scene: saved };
}

/** Star / un-star a light scene — a lightweight write (kiosk-or-admin) so a quick
 *  star tap need not re-send the whole scene. `favorite` defaults to true if omitted. */
export function favoriteScene(id: string, favorite: boolean): unknown {
  const saved = store.update((s) => {
    const idx = s.lightScenes.findIndex((x) => x.id === id);
    if (idx < 0) return null;
    const cur = s.lightScenes[idx];
    if (favorite) cur.favorite = true;
    else delete cur.favorite;
    return cur;
  });
  if (!saved) throw badInput(`scene ${id} not found`);
  return { ts: new Date().toISOString(), scene: saved };
}

export function deleteScene(id: string): unknown {
  store.update((s) => {
    s.lightScenes = s.lightScenes.filter((x) => x.id !== id);
    // Drop schedules that pointed at this scene (no dangling targets).
    s.lightSchedules = s.lightSchedules.filter(
      (sc) => !(sc.target.kind === 'scene' && sc.target.sceneId === id),
    );
  });
  return { ts: new Date().toISOString(), ok: true };
}

/** Push a set of member targets to the real lights. Best-effort per light.
 *  Exported so the whole-home scene apply can reuse the exact light-apply path. */
export async function applyMembers(members: store.LightSceneMember[]): Promise<{ applied: number; failed: number }> {
  if (!tuya.isConfigured() || members.length === 0) return { applied: 0, failed: 0 };
  const all = await tuya.getDevices();
  const cfgMap = configuredLightingMap();
  let applied = 0;
  let failed = 0;
  for (const m of members) {
    const d = all.find((x) => x.id === m.lightId);
    if (!d || (!lights.isLight(d) && !cfgMap[d.id])) {
      failed++;
      continue;
    }
    try {
      const cfg = !!cfgMap[d.id];
      const sendCmds = (cmds: Array<{ code: string; value: unknown }>) =>
        cfg ? tuya.sendCommandsDual(d.id, cmds) : tuya.sendCommands(d.id, cmds);
      await sendCmds(await buildAnyLightCommands(d, 'power', m.on, cfgMap));
      if (m.on && m.brightnessPct != null) {
        // Only set brightness on dimmable lights; ignore if unsupported.
        try {
          await sendCmds(await buildAnyLightCommands(d, 'brightness', m.brightnessPct, cfgMap));
        } catch {
          /* not dimmable — power already applied */
        }
      }
      applied++;
    } catch {
      failed++;
    }
  }
  tuya.invalidateFleet();
  return { applied, failed };
}

export async function applyScene(id: string, on = true): Promise<unknown> {
  const scene = store.get().lightScenes.find((x) => x.id === id);
  if (!scene) throw badInput(`scene ${id} not found`);
  if (!tuya.isConfigured()) throw badInput('Tuya not connected');
  // on=true → apply the scene's saved states; on=false → switch its lights off.
  const members = on ? scene.members : scene.members.map((m) => ({ ...m, on: false }));
  const res = await applyMembers(members);
  return { ts: new Date().toISOString(), id, on, ...res };
}

/** Set a custom display name for a light (stored in deviceSettings). */
export function renameLight(id: string, nameRaw: unknown): unknown {
  const name = String(nameRaw ?? '').trim();
  store.update((s) => {
    const existing = s.deviceSettings[id] ?? { automationEnabled: false };
    s.deviceSettings[id] = { ...existing, name: name || undefined };
  });
  tuya.invalidateFleet();
  return { ts: new Date().toISOString(), id, name };
}

// ---- Light schedules --------------------------------------------------------

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function sanitizeTarget(raw: unknown): store.LightScheduleTarget {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (o.kind === 'scene' && typeof o.sceneId === 'string') return { kind: 'scene', sceneId: o.sceneId };
  return { kind: 'lights', members: sanitizeMembers(o.members) };
}

function sanitizeSchedule(body: Partial<store.LightSchedule>, base?: store.LightSchedule): store.LightSchedule {
  const onTime = typeof body.onTime === 'string' && HHMM_RE.test(body.onTime) ? body.onTime : base?.onTime ?? '18:00';
  const offRaw = body.offTime;
  const offTime =
    offRaw === null
      ? null
      : typeof offRaw === 'string' && HHMM_RE.test(offRaw)
        ? offRaw
        : base?.offTime ?? null;

  const result: store.LightSchedule = {
    id: base?.id ?? newId('lsched'),
    name: body.name?.trim() || base?.name || 'New light schedule',
    enabled: typeof body.enabled === 'boolean' ? body.enabled : base?.enabled ?? true,
    days: Array.isArray(body.days) ? body.days.filter((d) => d >= 0 && d <= 6) : base?.days ?? [1, 2, 3, 4, 5],
    onTime,
    offTime,
    target: body.target !== undefined ? sanitizeTarget(body.target) : base?.target ?? { kind: 'lights', members: [] },
  };

  if (body.onAnchor === 'sunrise' || body.onAnchor === 'sunset') {
    result.onAnchor = body.onAnchor;
    result.onOffsetMin = typeof body.onOffsetMin === 'number' ? Math.round(body.onOffsetMin) : 0;
  }
  if (offTime !== null && (body.offAnchor === 'sunrise' || body.offAnchor === 'sunset')) {
    result.offAnchor = body.offAnchor;
    result.offOffsetMin = typeof body.offOffsetMin === 'number' ? Math.round(body.offOffsetMin) : 0;
  }
  if (typeof body.onVariationMin === 'number' && body.onVariationMin > 0) {
    result.onVariationMin = Math.min(60, Math.round(body.onVariationMin));
  }
  if (typeof body.offVariationMin === 'number' && body.offVariationMin > 0) {
    result.offVariationMin = Math.min(60, Math.round(body.offVariationMin));
  }

  return result;
}

export function listLightSchedules(): unknown {
  return { ts: new Date().toISOString(), schedules: store.get().lightSchedules };
}

export function createLightSchedule(body: Partial<store.LightSchedule>): unknown {
  const sched = sanitizeSchedule(body);
  store.update((s) => {
    s.lightSchedules.push(sched);
  });
  return { ts: new Date().toISOString(), schedule: sched };
}

export function updateLightSchedule(id: string, body: Partial<store.LightSchedule>): unknown {
  const saved = store.update((s) => {
    const idx = s.lightSchedules.findIndex((x) => x.id === id);
    if (idx < 0) return null;
    const merged = sanitizeSchedule(body, s.lightSchedules[idx]);
    s.lightSchedules[idx] = merged;
    return merged;
  });
  if (!saved) throw badInput(`light schedule ${id} not found`);
  return { ts: new Date().toISOString(), schedule: saved };
}

export function deleteLightSchedule(id: string): unknown {
  store.update((s) => {
    s.lightSchedules = s.lightSchedules.filter((x) => x.id !== id);
  });
  return { ts: new Date().toISOString(), ok: true };
}

/** Resolve a schedule's target to the concrete member set (scene → its members). */
function membersForSchedule(sched: store.LightSchedule): store.LightSceneMember[] {
  if (sched.target.kind === 'scene') {
    const sceneId = sched.target.sceneId;
    return store.get().lightScenes.find((x) => x.id === sceneId)?.members ?? [];
  }
  return sched.target.members;
}

/** Apply a schedule's ON edge (turn on / apply scene). Used by the coordinator. */
export async function applyScheduleOn(sched: store.LightSchedule): Promise<void> {
  await applyMembers(membersForSchedule(sched));
}

/** Apply a schedule's OFF edge (switch the involved lights off). */
export async function applyScheduleOff(sched: store.LightSchedule): Promise<void> {
  await applyMembers(membersForSchedule(sched).map((m) => ({ ...m, on: false })));
}
