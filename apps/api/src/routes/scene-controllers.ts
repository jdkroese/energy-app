// Scene-controller HTTP surface — list + save the per-button scene bindings for a
// wireless scene switch (Tuya category 'wxkg', set up as a 'controller'). The
// controller-coordinator reads these bindings + the device logs to toggle scenes on
// press. Reads are any-authed; the save is admin-gated at the route in index.ts.

import * as store from '../store';
import * as tuya from '../connectors/tuya';
import type { TuyaDevice } from '../connectors/tuya';

function badInput(msg: string): Error & { code: string } {
  const e = new Error(msg) as Error & { code: string };
  e.code = 'BAD_INPUT';
  return e;
}

export interface SceneControllerView {
  deviceId: string;
  /** Resolved display name (configured name → device name → id). */
  name: string;
  online: boolean;
  /** True when the device is present in the live fleet as a 'wxkg' scene switch. */
  resolved: boolean;
  enabled: boolean;
  buttons: store.SceneButtonBinding[];
}

/** Build the per-button view, joining the live fleet for name/online. */
function viewFor(deviceId: string, ctrl: store.SceneController, d: TuyaDevice | undefined): SceneControllerView {
  const configuredName = store.get().deviceOnboarding.configured[deviceId]?.name;
  return {
    deviceId,
    name: configuredName ?? d?.name ?? deviceId,
    online: d?.online ?? false,
    resolved: Boolean(d) && d?.category === 'wxkg',
    enabled: ctrl.enabled,
    buttons: ctrl.buttons,
  };
}

/**
 * GET /api/scene-controllers — every configured scene controller with its bindings and
 * resolved name/online (joined against the live Tuya fleet, best-effort).
 */
export async function listSceneControllers(): Promise<unknown> {
  const controllers = store.get().sceneControllers;
  const ids = Object.keys(controllers);
  let byId = new Map<string, TuyaDevice>();
  if (tuya.isConfigured() && ids.length > 0) {
    try {
      const all = await tuya.getDevices();
      byId = new Map(all.map((d) => [d.id, d]));
    } catch {
      /* fleet read failed — still return bindings, just unresolved (online:false). */
    }
  }
  const list = ids.map((id) => viewFor(id, controllers[id], byId.get(id)));
  return { ts: new Date().toISOString(), connected: tuya.isConfigured(), controllers: list };
}

/** Sanitize one button binding from the PUT body, preserving the persisted toggle `on`
 *  state where the scene is unchanged. `prev` is the existing binding for this index. */
function sanitizeButton(raw: unknown, prev: store.SceneButtonBinding | undefined): store.SceneButtonBinding {
  const o = (raw ?? {}) as {
    index?: unknown;
    label?: unknown;
    single?: { kind?: unknown; sceneId?: unknown } | null;
  };
  const idx = Number(o.index);
  const index = Number.isInteger(idx) && idx >= 1 && idx <= 4 ? idx : prev?.index ?? 1;
  const out: store.SceneButtonBinding = { index };
  if (typeof o.label === 'string' && o.label.trim()) out.label = o.label.trim();

  const sceneId = typeof o.single?.sceneId === 'string' ? o.single.sceneId.trim() : '';
  // Target store: 'light' (a Lights scene) or 'home' (whole-home). Default 'home' so old
  // clients that omit `kind` keep their existing behaviour.
  const kind: store.SceneButtonPress['kind'] = o.single?.kind === 'light' ? 'light' : 'home';
  if (sceneId) {
    // Preserve the toggle state only when the bound target (kind + scene) is unchanged; a
    // new or re-pointed binding starts "off" so the first press turns it ON.
    const keepOn =
      prev?.single?.sceneId === sceneId && (prev.single.kind ?? 'home') === kind ? prev.single.on : false;
    out.single = { kind, sceneId, on: keepOn };
  }
  // Phase 2 double/long bindings are carried through if present (no UI yet).
  if (prev?.double) out.double = prev.double;
  if (prev?.long) out.long = prev.long;
  return out;
}

/**
 * PUT /api/scene-controllers/:deviceId — save the controller's enabled flag + 4 button
 * bindings. Creates the entry if it doesn't exist yet. The toggle `on` state is preserved
 * per button where the bound scene is unchanged (so editing an unrelated button doesn't
 * flip a scene's state); a newly-bound button starts off. The log watermark is preserved.
 */
export function saveSceneController(deviceId: string, body: unknown): unknown {
  const id = String(deviceId ?? '').trim();
  if (!id) throw badInput('deviceId required');
  const b = (body ?? {}) as { enabled?: unknown; buttons?: unknown };
  const enabled = b.enabled !== false;
  const rawButtons = Array.isArray(b.buttons) ? b.buttons : [];

  const saved = store.update((s) => {
    const prev = s.sceneControllers[id] ?? store.defaultSceneController();
    const prevByIndex = new Map(prev.buttons.map((x) => [x.index, x]));
    // Normalize to exactly 4 buttons (index 1..4), pulling from the body by index.
    const incomingByIndex = new Map<number, unknown>();
    for (const rb of rawButtons) {
      const ri = Number((rb as { index?: unknown })?.index);
      if (Number.isInteger(ri) && ri >= 1 && ri <= 4) incomingByIndex.set(ri, rb);
    }
    const buttons: store.SceneButtonBinding[] = [1, 2, 3, 4].map((index) =>
      sanitizeButton(incomingByIndex.get(index) ?? { index }, prevByIndex.get(index)),
    );
    const next: store.SceneController = {
      enabled,
      buttons,
      ...(prev.watermarkMs != null ? { watermarkMs: prev.watermarkMs } : {}),
    };
    s.sceneControllers[id] = next;
    return next;
  });

  return { ts: new Date().toISOString(), deviceId: id, controller: saved };
}

/** Create a default scene-controller entry for a freshly-onboarded device (idempotent —
 *  never clobbers an existing binding). Called from the device setup flow. */
export function ensureSceneController(deviceId: string): void {
  const id = String(deviceId ?? '').trim();
  if (!id) return;
  store.update((s) => {
    if (!s.sceneControllers[id]) s.sceneControllers[id] = store.defaultSceneController();
  });
}

/** Drop a controller's bindings (e.g. when it's unset / re-classified away from controller). */
export function removeSceneController(deviceId: string): void {
  const id = String(deviceId ?? '').trim();
  if (!id) return;
  store.update((s) => {
    delete s.sceneControllers[id];
  });
}
