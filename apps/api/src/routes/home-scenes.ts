// Whole-home (cross-domain) scenes HTTP surface. A scene = one named "moment" that fans
// out across lights, climate and blinds at once. Mirrors the light-scene CRUD in
// routes/lights.ts; applying a scene is BEST-EFFORT — each device is wrapped in try/catch
// so one failure never aborts the rest (we never throw the whole apply because one device
// failed). Reads are any-authed; create/update/delete are admin-gated; apply is gated to
// kiosk-or-admin (a wall tablet may trigger a scene) — all enforced at the route in index.ts.

import * as store from '../store';
import { applyMembers, getLightFleet } from './lights';
import { commandDevice, listClimateDeviceIds } from './devices';
import { commandBlind, listBlindIds } from './blinds';
import type { ClimateLever } from '../control/climate-execute';
import type { BlindLever } from '../connectors/tuya-blinds';

function badInput(msg: string): Error & { code: string } {
  const e = new Error(msg) as Error & { code: string };
  e.code = 'BAD_INPUT';
  return e;
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// ---- Input sanitization -----------------------------------------------------

/** Light members reuse the light-scene shape: id + on + clamped brightness 1–100. */
function sanitizeLights(raw: unknown): store.LightSceneMember[] {
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

/** Climate members: deviceId + power, with optional mode + clamped setpoint (10–32°C). */
function sanitizeClimate(raw: unknown): store.HomeSceneClimateMember[] {
  if (!Array.isArray(raw)) return [];
  const out: store.HomeSceneClimateMember[] = [];
  for (const m of raw) {
    const o = (m ?? {}) as Record<string, unknown>;
    if (typeof o.deviceId !== 'string' || !o.deviceId) continue;
    const sp = Number(o.setpointC);
    out.push({
      deviceId: o.deviceId,
      power: Boolean(o.power),
      ...(typeof o.mode === 'string' && o.mode ? { mode: o.mode } : {}),
      setpointC: Number.isFinite(sp) ? Math.max(10, Math.min(32, sp)) : null,
    });
  }
  return out;
}

/** Blind members: blindId (or '*' sentinel) + action, with clamped position 0–100. */
function sanitizeBlinds(raw: unknown): store.HomeSceneBlindMember[] {
  if (!Array.isArray(raw)) return [];
  const out: store.HomeSceneBlindMember[] = [];
  for (const m of raw) {
    const o = (m ?? {}) as Record<string, unknown>;
    if (typeof o.blindId !== 'string' || !o.blindId) continue;
    const action = o.action === 'open' || o.action === 'close' || o.action === 'position' ? o.action : 'close';
    const pct = Number(o.positionPct);
    out.push({
      blindId: o.blindId,
      action,
      positionPct: action === 'position' && Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : null,
    });
  }
  return out;
}

/** Coerce the optional 'all-off' special flag (the only kind today). */
function sanitizeSpecial(raw: unknown): 'all-off' | undefined {
  return raw === 'all-off' ? 'all-off' : undefined;
}

// ---- CRUD -------------------------------------------------------------------

export function listHomeScenes(): unknown {
  return { ts: new Date().toISOString(), scenes: store.get().homeScenes };
}

export function createHomeScene(body: Partial<store.HomeScene>): unknown {
  const scene: store.HomeScene = {
    id: newId('home-scene'),
    name: body.name?.trim() || 'New scene',
    icon: typeof body.icon === 'string' ? body.icon : 'sparkles',
    ...(body.favorite ? { favorite: true as const } : {}),
    ...(sanitizeSpecial(body.special) ? { special: 'all-off' as const } : {}),
    lights: sanitizeLights(body.lights),
    climate: sanitizeClimate(body.climate),
    blinds: sanitizeBlinds(body.blinds),
  };
  store.update((s) => {
    s.homeScenes.push(scene);
  });
  return { ts: new Date().toISOString(), scene };
}

export function updateHomeScene(id: string, body: Partial<store.HomeScene>): unknown {
  const saved = store.update((s) => {
    const idx = s.homeScenes.findIndex((x) => x.id === id);
    if (idx < 0) return null;
    const cur = s.homeScenes[idx];
    const special = body.special !== undefined ? sanitizeSpecial(body.special) : cur.special;
    const favorite = body.favorite !== undefined ? Boolean(body.favorite) : cur.favorite;
    const merged: store.HomeScene = {
      ...cur,
      name: body.name?.trim() || cur.name,
      icon: typeof body.icon === 'string' ? body.icon : cur.icon,
      ...(favorite ? { favorite: true as const } : {}),
      ...(special ? { special: 'all-off' as const } : {}),
      lights: body.lights !== undefined ? sanitizeLights(body.lights) : cur.lights,
      climate: body.climate !== undefined ? sanitizeClimate(body.climate) : cur.climate,
      blinds: body.blinds !== undefined ? sanitizeBlinds(body.blinds) : cur.blinds,
    };
    // Clearing the special flag must actually drop it (the spread above only adds it).
    if (!special) delete merged.special;
    // Same for favorite — un-starring must remove the key, not leave a stale `true`.
    if (!favorite) delete merged.favorite;
    s.homeScenes[idx] = merged;
    return merged;
  });
  if (!saved) throw badInput(`home scene ${id} not found`);
  return { ts: new Date().toISOString(), scene: saved };
}

/** Star / un-star a scene — a lightweight write so the wall tablet (kiosk) can toggle
 *  a favorite without sending the whole scene. `favorite` defaults to true if omitted. */
export function favoriteHomeScene(id: string, favorite: boolean): unknown {
  const saved = store.update((s) => {
    const idx = s.homeScenes.findIndex((x) => x.id === id);
    if (idx < 0) return null;
    const cur = s.homeScenes[idx];
    if (favorite) cur.favorite = true;
    else delete cur.favorite;
    return cur;
  });
  if (!saved) throw badInput(`home scene ${id} not found`);
  return { ts: new Date().toISOString(), scene: saved };
}

export function deleteHomeScene(id: string): unknown {
  store.update((s) => {
    s.homeScenes = s.homeScenes.filter((x) => x.id !== id);
  });
  return { ts: new Date().toISOString(), ok: true };
}

// ---- Apply (best-effort fan-out) --------------------------------------------

/** Push one climate member: power first, then (if powering on) mode + setpoint. Best-effort. */
async function applyClimateMember(m: store.HomeSceneClimateMember): Promise<boolean> {
  try {
    await commandDevice(m.deviceId, 'power' as ClimateLever, m.power);
    if (m.power) {
      if (m.mode) {
        try {
          await commandDevice(m.deviceId, 'mode' as ClimateLever, m.mode);
        } catch {
          /* mode unsupported — power already applied */
        }
      }
      if (m.setpointC != null) {
        try {
          await commandDevice(m.deviceId, 'setpoint' as ClimateLever, m.setpointC);
        } catch {
          /* setpoint unsupported — power already applied */
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Push one blind member; '*' is expanded by the caller, so here it's a concrete id. */
async function applyBlindMember(m: store.HomeSceneBlindMember): Promise<boolean> {
  try {
    if (m.action === 'position') {
      await commandBlind(m.blindId, 'position' as BlindLever, m.positionPct ?? 0);
    } else {
      await commandBlind(m.blindId, m.action as BlindLever, undefined);
    }
    return true;
  } catch {
    return false;
  }
}

export async function applyHomeScene(id: string): Promise<unknown> {
  const scene = store.get().homeScenes.find((x) => x.id === id);
  if (!scene) throw badInput(`home scene ${id} not found`);

  let applied = 0;
  let failed = 0;

  if (scene.special === 'all-off') {
    // ALL-OFF: turn the whole live light + climate fleet off, and close blinds if the
    // scene carries a blinds intent (e.g. the '*' sentinel or any blind member). No
    // explicit member IDs are needed — we fetch the live fleets here.
    const lightUnits = (await getLightFleet().catch(() => ({ units: [] }))).units;
    const lightRes = await applyMembers(lightUnits.map((u) => ({ lightId: u.id, on: false })));
    applied += lightRes.applied;
    failed += lightRes.failed;

    const climateIds = await listClimateDeviceIds().catch(() => []);
    for (const deviceId of climateIds) {
      if (await applyClimateMember({ deviceId, power: false })) applied++;
      else failed++;
    }

    if (scene.blinds.length > 0) {
      const blindIds = await listBlindIds().catch(() => []);
      for (const blindId of blindIds) {
        if (await applyBlindMember({ blindId, action: 'close', positionPct: null })) applied++;
        else failed++;
      }
    }

    return { ts: new Date().toISOString(), id, applied, failed };
  }

  // Explicit scene: fan out to the named members across all three domains.
  const lightRes = await applyMembers(scene.lights);
  applied += lightRes.applied;
  failed += lightRes.failed;

  for (const m of scene.climate) {
    if (await applyClimateMember(m)) applied++;
    else failed++;
  }

  for (const m of scene.blinds) {
    // A '*' sentinel in an explicit scene also means "all blinds" — expand it live.
    if (m.blindId === '*') {
      const blindIds = await listBlindIds().catch(() => []);
      for (const blindId of blindIds) {
        if (await applyBlindMember({ ...m, blindId })) applied++;
        else failed++;
      }
      continue;
    }
    if (await applyBlindMember(m)) applied++;
    else failed++;
  }

  return { ts: new Date().toISOString(), id, applied, failed };
}

/**
 * Turn a scene's members OFF — the inverse of {@link applyHomeScene}, used by the
 * scene-switch single-click TOGGLE (press once = apply, press again = off). Mirrors the
 * apply fan-out shape (best-effort per device): every light member → off, every climate
 * member → power off, every blind member → close (a '*' member expands to all blinds).
 * An 'all-off' special scene is already an "off" scene, so off == apply for it.
 */
export async function applyHomeSceneOff(id: string): Promise<unknown> {
  const scene = store.get().homeScenes.find((x) => x.id === id);
  if (!scene) throw badInput(`home scene ${id} not found`);

  // An all-off scene's "on" IS off — reuse the apply path so the semantics match.
  if (scene.special === "all-off") return applyHomeScene(id);

  let applied = 0;
  let failed = 0;

  // Lights → off (ignore brightness; just cut them).
  const lightRes = await applyMembers(scene.lights.map((m) => ({ lightId: m.lightId, on: false })));
  applied += lightRes.applied;
  failed += lightRes.failed;

  // Climate → power off.
  for (const m of scene.climate) {
    if (await applyClimateMember({ deviceId: m.deviceId, power: false })) applied++;
    else failed++;
  }

  // Blinds → close (a '*' member means "all blinds").
  for (const m of scene.blinds) {
    if (m.blindId === "*") {
      const blindIds = await listBlindIds().catch(() => []);
      for (const blindId of blindIds) {
        if (await applyBlindMember({ blindId, action: "close", positionPct: null })) applied++;
        else failed++;
      }
      continue;
    }
    if (await applyBlindMember({ blindId: m.blindId, action: "close", positionPct: null })) applied++;
    else failed++;
  }

  return { ts: new Date().toISOString(), id, applied, failed };
}
