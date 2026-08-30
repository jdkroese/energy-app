// Regression guard for docs/53: importing tuya-local must NOT open a socket.
//
// tuya-local.ts used to end with `if (isLocalEnabled()) startDiscoveryListener()`, which ran
// the moment the module was imported. Because ./tuya, ./tuya-lights, routes/live, the climate
// coordinator and the alert loop all reach tuya-local transitively, that import side effect
// bound two UDP sockets in ANY process that touched almost anything — including `node --test`.
// The sockets kept the event loop alive forever, so seven test files passed every assertion
// and then hung until the runner was killed (60s timeout, exit 124). Nothing in those files
// was Tuya-related; the handle just came along for the ride.
//
// The fix moved the gate into an explicit bootLocalDiscovery(), called once from index.ts.
// This test locks that in: with local control FORCE-ENABLED (the setting that used to start
// discovery at import), importing the module still opens nothing. It deliberately never calls
// bootLocalDiscovery() itself — binding real ports 6666/6667 from a test would be exactly the
// invasiveness this whole exercise is removing. It asserts on isDiscoveryRunning() rather than
// on process.getActiveResourcesInfo(): the sockets are unref'd, so they never show up there.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tuya-local-boot-test-'));
process.env.DATA_DIR = scratchDir;
process.env.STATE_FILE = path.join(scratchDir, 'state.json');
// '1' is the hard force-ON override — the worst case for an import side effect. If importing
// is inert under this, it is inert under the store-driven default too.
process.env.TUYA_LOCAL_ENABLED = '1';

const tuyaLocal = await import('./tuya-local');

test('importing tuya-local does not start discovery, even with local control force-enabled', () => {
  assert.equal(tuyaLocal.isLocalEnabled(), true, 'precondition: the force-ON override is in effect');
  assert.equal(
    tuyaLocal.isDiscoveryRunning(),
    false,
    'importing tuya-local started the UDP discovery listener — it must only start via bootLocalDiscovery()',
  );
});

test('discovery is still startable explicitly (the index.ts boot hook exists)', () => {
  assert.equal(typeof tuyaLocal.bootLocalDiscovery, 'function');
  assert.equal(typeof tuyaLocal.startDiscoveryListener, 'function');
});
