// Unit tests for the scene-controller coordinator's docs/52 Change 3 gating. Run from
// apps/api:
//   node --import tsx --test src/control/controller-coordinator.test.ts
//
// Importing this module pulls in tuya.ts -> tuya-local.ts (module-init reads the store and,
// when local is enabled, starts a UDP discovery listener), plus routes/home-scenes.ts and
// routes/lights.ts. Same pattern as tuya.test.ts: point the store/DATA_DIR at scratch files
// and hard-disable local via the env kill-switch BEFORE the dynamic import, so this suite
// never opens sockets or touches the real state.json.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'controller-coordinator-test-'));
process.env.DATA_DIR = scratchDir;
process.env.STATE_FILE = path.join(scratchDir, 'state.json');
process.env.TUYA_LOCAL_ENABLED = '0';

const coordinator = await import('./controller-coordinator');
const store = await import('../store');
const { tick, sceneControlEnabled, startControllerCoordinator, stopControllerCoordinator } = coordinator;

function setSceneControlEnabled(enabled: boolean | undefined): void {
  store.update((s) => {
    s.integrations = s.integrations ?? { intesis: null };
    s.integrations.tuya = { ...(s.integrations.tuya ?? {}), sceneControllersEnabled: enabled };
  });
}

function setTuyaCreds(): void {
  store.update((s) => {
    s.integrations = s.integrations ?? { intesis: null };
    s.integrations.tuya = { ...(s.integrations.tuya ?? {}), region: 'eu', accessId: 'test-id', accessSecret: 'test-secret' };
  });
}

/** Any fetch at all means a cloud call was made — the coordinator's ONLY network I/O is via
 *  tuya.ts's `fetch`-based cloud calls (device-logs / per-device direct reads), so tracking
 *  every call is exactly "did this tick touch the cloud at all". */
function installFetchSpy(): { calls: string[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    calls.push(String(url));
    return { ok: true, json: async () => ({ success: false, code: 999, msg: 'unmocked in test' }) } as unknown as Response;
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('sceneControlEnabled(): defaults to false (store unset) — the new docs/52 default', () => {
  setSceneControlEnabled(undefined);
  assert.equal(sceneControlEnabled(), false);
});

test('sceneControlEnabled(): only an explicit true turns it on', () => {
  setSceneControlEnabled(true);
  assert.equal(sceneControlEnabled(), true);
  setSceneControlEnabled(false);
  assert.equal(sceneControlEnabled(), false);
});

test('tick(): scene control OFF (default) — no cloud call at all, even with an enabled controller bound (acceptance #3)', async () => {
  setSceneControlEnabled(undefined);
  setTuyaCreds();
  store.update((s) => {
    s.sceneControllers['bf-coord-off-1'] = { enabled: true, buttons: [] };
  });

  const spy = installFetchSpy();
  try {
    await tick();
    assert.equal(spy.calls.length, 0, 'zero cloud calls (no device-logs poll, no direct read) when scene control is off');
  } finally {
    spy.restore();
    stopControllerCoordinator();
  }
});

test('tick(): scene control ON resolves each enabled controller via a per-device direct read, NOT the bulk fleet endpoint', async () => {
  setSceneControlEnabled(true);
  setTuyaCreds();
  store.update((s) => {
    s.sceneControllers = {}; // isolate from the previous test's entry
    s.sceneControllers['bf-coord-on-1'] = { enabled: true, buttons: [] };
  });

  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    calls.push(u);
    const json = async (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response;
    if (u.includes('/v1.0/token')) {
      return json({ success: true, result: { access_token: 'tok', expire_time: 7200, uid: 'u1' } });
    }
    if (u.includes('/v1.0/iot-01/associated-users/devices')) {
      // If tick() ever falls back to the bulk fleet listing again, fail loudly here instead
      // of silently "working" — docs/52 Change 2 excludes wxkg from that listing, so relying
      // on it would silently break scene control the moment it's re-enabled.
      assert.fail('tick() must not call the bulk fleet endpoint — it is filtered and would never resolve a wxkg device');
    }
    if (/\/v1\.0\/devices\/bf-coord-on-1$/.test(u)) {
      return json({ success: true, result: { id: 'bf-coord-on-1', name: 'Switch', category: 'wxkg', online: false, status: [] } });
    }
    return json({ success: false, code: 999, msg: `unmocked url in test: ${u}` });
  }) as typeof fetch;

  try {
    await tick();
    assert.ok(calls.some((u) => /\/v1\.0\/devices\/bf-coord-on-1$/.test(u)), 'resolved the controller via a direct per-device read');
    // The device resolved 'online: false' above, so processController() short-circuits before
    // ever reading device logs — no /logs call should appear either.
    assert.ok(!calls.some((u) => u.includes('/logs')), 'an offline switch is never log-polled');
  } finally {
    globalThis.fetch = original;
    stopControllerCoordinator();
  }
});

test('startControllerCoordinator(): does not arm an interval when scene control is off (default) — acceptance #3', () => {
  setSceneControlEnabled(undefined);
  const originalSetInterval = globalThis.setInterval;
  let calls = 0;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    calls++;
    return originalSetInterval(...args);
  }) as typeof setInterval;
  try {
    startControllerCoordinator();
    assert.equal(calls, 0, 'setInterval must never be called while scene control is off');
  } finally {
    globalThis.setInterval = originalSetInterval;
    stopControllerCoordinator();
  }
});

test('startControllerCoordinator(): arms the interval when scene control is explicitly on', () => {
  setSceneControlEnabled(true);
  const originalSetInterval = globalThis.setInterval;
  let calls = 0;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    calls++;
    return originalSetInterval(...args);
  }) as typeof setInterval;
  try {
    startControllerCoordinator();
    assert.equal(calls, 1, 'the interval is armed exactly once when scene control is on');
  } finally {
    globalThis.setInterval = originalSetInterval;
    stopControllerCoordinator(); // unref'd or not, always clean up so the process can exit
  }
});

test('startControllerCoordinator()/stopControllerCoordinator(): idempotent — calling start twice arms only one interval, stop is safe when nothing is armed', () => {
  setSceneControlEnabled(true);
  const originalSetInterval = globalThis.setInterval;
  let calls = 0;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    calls++;
    return originalSetInterval(...args);
  }) as typeof setInterval;
  try {
    startControllerCoordinator();
    startControllerCoordinator();
    assert.equal(calls, 1, 'a second start() call is a no-op while already armed');
  } finally {
    globalThis.setInterval = originalSetInterval;
    stopControllerCoordinator();
    stopControllerCoordinator(); // safe to call again with nothing armed
  }
});
