// Scene-controller HTTP surface — list + save the per-button scene bindings for a
// wireless scene switch (Tuya category 'wxkg', set up as a 'controller'). The
// controller-coordinator reads these bindings + the device logs to toggle scenes on
// press. Reads are any-authed; the save is admin-gated at the route in index.ts.

import * as store from '../store';
import * as tuya from '../connectors/tuya';
import type { TuyaDevice } from '../connectors/tuya';
import { startControllerCoordinator, stopControllerCoordinator } from '../control/controller-coordinator';

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
  const byId = new Map<string, TuyaDevice>();
  if (tuya.isConfigured() && ids.length > 0) {
    // docs/52 Change 2 drops the wxkg scene switch from the bulk tuya.getDevices() listing
    // unconditionally, so it would never resolve via the bulk map any more — this admin page
    // is the one place that's WRONG for (it's the binding UI for a device the app otherwise
    // hides). Resolve each controller id directly instead — getDeviceDirect() is per-id and
    // not filtered, mirroring the same fix in controller-coordinator.ts's tick().
    await Promise.all(
      ids.map(async (id) => {
        try {
          const d = await tuya.getDeviceDirect(id);
          if (d) byId.set(id, d);
        } catch {
          /* leave unresolved (online:false) — still return the bindings below */
        }
      }),
    );
  }
  const list = ids.map((id) => viewFor(id, controllers[id], byId.get(id)));
  return { ts: new Date().toISOString(), connected: tuya.isConfigured(), controllers: list };
}

/** Sanitize one gesture binding (single/double/long) from the PUT body. Returns undefined
 *  when no scene is bound. Preserves the toggle `on` state only when the bound target
 *  (kind + scene) is unchanged; a new or re-pointed binding starts "off". */
function sanitizePress(
  raw: { kind?: unknown; sceneId?: unknown } | null | undefined,
  prev: store.SceneButtonPress | undefined,
): store.SceneButtonPress | undefined {
  const sceneId = typeof raw?.sceneId === 'string' ? raw.sceneId.trim() : '';
  if (!sceneId) return undefined;
  // Target store: 'light' (a Lights scene) or 'home' (whole-home). Default 'home' so old
  // clients that omit `kind` keep their existing behaviour.
  const kind: store.SceneButtonPress['kind'] = raw?.kind === 'light' ? 'light' : 'home';
  const keepOn = prev?.sceneId === sceneId && (prev.kind ?? 'home') === kind ? prev.on : false;
  return { kind, sceneId, on: keepOn };
}

/** Sanitize one button binding (all gestures) from the PUT body. `prev` is the existing
 *  binding for this index. */
function sanitizeButton(raw: unknown, prev: store.SceneButtonBinding | undefined): store.SceneButtonBinding {
  const o = (raw ?? {}) as {
    index?: unknown;
    label?: unknown;
    single?: { kind?: unknown; sceneId?: unknown } | null;
    double?: { kind?: unknown; sceneId?: unknown } | null;
    long?: { kind?: unknown; sceneId?: unknown } | null;
  };
  const idx = Number(o.index);
  const index = Number.isInteger(idx) && idx >= 1 && idx <= 4 ? idx : prev?.index ?? 1;
  const out: store.SceneButtonBinding = { index };
  if (typeof o.label === 'string' && o.label.trim()) out.label = o.label.trim();

  const single = sanitizePress(o.single, prev?.single);
  if (single) out.single = single;
  const double = sanitizePress(o.double, prev?.double);
  if (double) out.double = double;
  const long = sanitizePress(o.long, prev?.long);
  if (long) out.long = long;
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

/** PUT /api/integrations/tuya/scene-controllers — docs/52 Change 3: reversible on/off for the
 *  scene-controller coordinator's cloud device-logs poll. Persisted, default OFF. Starts/stops
 *  the coordinator's interval immediately (idempotent either way) so the toggle takes effect
 *  without an app restart — see sceneControlEnabled()/startControllerCoordinator() in
 *  controller-coordinator.ts. Bindings + watermarks are never touched — only the poll. */
export function setSceneControllersEnabled(enabledRaw: unknown): unknown {
  if (typeof enabledRaw !== 'boolean') throw badInput('enabled must be a boolean');
  store.update((s) => {
    s.integrations = s.integrations ?? { intesis: null };
    s.integrations.tuya = { ...(s.integrations.tuya ?? {}), sceneControllersEnabled: enabledRaw };
  });
  if (enabledRaw) startControllerCoordinator();
  else stopControllerCoordinator();
  return { ts: new Date().toISOString(), sceneControllersEnabled: enabledRaw };
}
