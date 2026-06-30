// Scene-controller coordinator (wireless scene switches, Tuya category 'wxkg').
//
// A scene switch's buttons emit a momentary `switch_mode{N}` datapoint event on press
// (value 'single_click' | 'double_click' | 'long_press'). Status polling CANNOT see
// repeated presses, so every ~3s we read each enabled controller's DEVICE LOGS (type=7
// DP-report history) and act on any NEW single-click whose event_time is past the
// per-controller watermark. Each bound button TOGGLES its scene — a Light scene (from the
// Lights feature, single.kind==='light') or a whole-home scene (single.kind==='home'):
//   • single.on false → apply the scene (applyHomeScene / applyScene(id,true)),  set on = true
//   • single.on true  → switch it off (applyHomeSceneOff / applyScene(id,false)), set on = false
// The watermark advances to the max processed event_time so old history never replays
// (on first sight a controller's watermark is seeded to "now" so boot doesn't fire).
//
// Phase 1 acts on single-click ONLY (double/long are ignored). This fires LIVE on press
// and is NOT battery-arm gated — the per-controller `enabled` flag is the only gate. It
// touches NO battery-control logic. Best-effort: every device + every scene apply is
// wrapped in try/catch so one failure never blocks the others. Modelled on the
// device-schedule + irrigation coordinators (a setInterval loop started at boot).

import * as store from '../store';
import * as tuya from '../connectors/tuya';
import { applyHomeScene, applyHomeSceneOff } from '../routes/home-scenes';
import { applyScene as applyLightScene } from '../routes/lights';

const TICK_MS = 3_000;
/** Cap on how far back the first log read reaches (ms) — we seed the watermark to now,
 *  but the API requires start<end; this is just the read window for the very first tick. */
const LOG_LOOKBACK_MS = 60_000;
let timer: ReturnType<typeof setInterval> | null = null;

/** Match a `switch_mode{N}` DP code → its 1-based button index, or null. */
function buttonIndexOf(code: string): number | null {
  const m = /^switch_mode(\d+)$/.exec(code);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 1 && n <= 4 ? n : null;
}

/** Process one controller: read its new single-click logs and toggle bound scenes. */
async function processController(deviceId: string, online: boolean): Promise<void> {
  const ctrl = store.get().sceneControllers[deviceId];
  if (!ctrl || !ctrl.enabled) return;
  if (!online) return; // offline switch can't report anything new

  const now = Date.now();
  // First sight (no watermark) → seed to now so historical presses never replay.
  if (ctrl.watermarkMs == null) {
    store.update((s) => {
      const c = s.sceneControllers[deviceId];
      if (c && c.watermarkMs == null) c.watermarkMs = now;
    });
    return;
  }

  const since = ctrl.watermarkMs;
  // Read a little before the watermark window opened; the API needs start<end.
  const start = Math.min(since, now - LOG_LOOKBACK_MS);
  let logs: tuya.TuyaDeviceLog[];
  try {
    const res = await tuya.getDeviceLogs(deviceId, start, now, 100);
    logs = res.logs ?? [];
  } catch (e) {
    console.error(`[scene-controller] log read failed for ${deviceId}:`, (e as Error).message);
    return;
  }

  // Only NEW single-clicks on a bound button, oldest-first so toggles apply in order.
  const events = logs
    .filter((l) => l.event_time > since && l.value === 'single_click' && buttonIndexOf(l.code) != null)
    .sort((a, b) => a.event_time - b.event_time);

  let maxTs = since;
  for (const ev of events) {
    if (ev.event_time > maxTs) maxTs = ev.event_time;
    const index = buttonIndexOf(ev.code);
    if (index == null) continue;
    // Re-read the binding fresh (it may have been edited mid-loop).
    const cur = store.get().sceneControllers[deviceId];
    const btn = cur?.buttons.find((b) => b.index === index);
    const single = btn?.single;
    if (!single || !single.sceneId) continue;

    // Light scenes live in store.lightScenes; whole-home scenes in store.homeScenes.
    // A binding without an explicit kind (legacy) is treated as 'home'.
    const isLight = single.kind === 'light';
    const scene = isLight
      ? store.get().lightScenes.find((x) => x.id === single.sceneId)
      : store.get().homeScenes.find((x) => x.id === single.sceneId);
    if (!scene) {
      console.error(`[scene-controller] btn ${index} single_click -> ${isLight ? 'light' : 'home'} scene ${single.sceneId} missing — skipped`);
      continue;
    }
    const turnOn = !single.on;
    try {
      if (isLight) {
        // applyScene(id, on): on=true applies saved states, on=false switches its lights off.
        await applyLightScene(single.sceneId, turnOn);
      } else if (turnOn) {
        await applyHomeScene(single.sceneId);
      } else {
        await applyHomeSceneOff(single.sceneId);
      }
      // Persist the new toggle state.
      store.update((s) => {
        const b = s.sceneControllers[deviceId]?.buttons.find((x) => x.index === index);
        if (b?.single) b.single.on = turnOn;
      });
      console.log(`[scene-controller] btn ${index} single_click -> ${isLight ? 'light' : 'home'} scene "${scene.name}" on=${turnOn}`);
    } catch (e) {
      console.error(`[scene-controller] btn ${index} apply failed for scene "${scene.name}":`, (e as Error).message);
    }
  }

  // Advance the watermark past everything we just saw (even unbound presses) so we never
  // re-scan the same window.
  if (maxTs > since) {
    store.update((s) => {
      const c = s.sceneControllers[deviceId];
      if (c && (c.watermarkMs == null || maxTs > c.watermarkMs)) c.watermarkMs = maxTs;
    });
  }
}

async function tick(): Promise<void> {
  try {
    if (!tuya.isConfigured()) return;
    const ids = Object.keys(store.get().sceneControllers).filter(
      (id) => store.get().sceneControllers[id]?.enabled,
    );
    if (ids.length === 0) return;

    // Resolve the live fleet so we only poll logs for switches that exist + are 'wxkg'.
    const all = await tuya.getDevices();
    const byId = new Map(all.map((d) => [d.id, d]));

    for (const id of ids) {
      const d = byId.get(id);
      // Only a real, category-'wxkg' device gets log-polled (defensive — a binding could
      // outlive its device or be mis-targeted). Each controller is independently guarded.
      if (!d || d.category !== 'wxkg') continue;
      await processController(id, d.online);
    }
  } catch (e) {
    console.error('[scene-controller] coordinator tick failed:', (e as Error).message);
  }
}

export function startControllerCoordinator(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), TICK_MS);
  console.log(`[scene-controller] coordinator started (every ${TICK_MS / 1000}s, gated on per-controller enabled)`);
}

export function stopControllerCoordinator(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
