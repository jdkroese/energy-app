// Unit tests for the local photo cache (docs/48 §4b): download validation (status/content-
// type/size), the independent >=10s download pacing, and the serve-side read (404/200/
// content-type sniffing). NO live network — a fake fetch stands in exactly like
// photo-providers.test.ts's; the filesystem is a real temp dir (RECIPES_DB_FILE-style
// isolation via a per-test STATE_FILE so dataDir() resolves under a scratch directory).
//   node --import tsx --test src/kitchen/photo-cache.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  cachedPhotoPath,
  downloadAndCache,
  hasCachedPhoto,
  readCachedPhoto,
  _resetThrottleForTests,
  _setClockForTests,
  _setFetchForTests,
} from './photo-cache';
import { _resetCache as _resetStoreCache } from '../store';

function freshEnv(): void {
  const dir = mkdtempSync(join(tmpdir(), 'photo-cache-test-'));
  process.env.STATE_FILE = join(dir, 'state.json');
  _resetStoreCache();
  _resetThrottleForTests();
  _setClockForTests();
  _setFetchForTests();
}

function fakeImageResponse(status: number, bytes: Buffer, contentType = 'image/jpeg') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

const BIG_ENOUGH = Buffer.alloc(11 * 1024, 1); // > the 10 KB floor
const TOO_SMALL = Buffer.alloc(100, 1);

// ---- download validation ----------------------------------------------------------------------

test('downloadAndCache: a valid image (200 + image/* + >10KB) is written and served back', async () => {
  freshEnv();
  _setFetchForTests(async () => fakeImageResponse(200, BIG_ENOUGH));
  const r = await downloadAndCache('r1', 'https://example.com/r1.jpg');
  assert.equal(r.kind, 'cached');
  if (r.kind === 'cached') assert.equal(r.route, '/api/kitchen/photos/r1');
  assert.equal(hasCachedPhoto('r1'), true);
});

test('downloadAndCache: a non-200 status is invalid, not cached', async () => {
  freshEnv();
  _setFetchForTests(async () => fakeImageResponse(404, BIG_ENOUGH));
  const r = await downloadAndCache('r1', 'https://example.com/missing.jpg');
  assert.equal(r.kind, 'invalid');
  assert.equal(hasCachedPhoto('r1'), false);
});

test('downloadAndCache: a non-image content-type is invalid, not cached', async () => {
  freshEnv();
  _setFetchForTests(async () => fakeImageResponse(200, BIG_ENOUGH, 'text/html'));
  const r = await downloadAndCache('r1', 'https://example.com/oops.html');
  assert.equal(r.kind, 'invalid');
  assert.equal(hasCachedPhoto('r1'), false);
});

test('downloadAndCache: a too-small body (<10KB) is invalid, not cached', async () => {
  freshEnv();
  _setFetchForTests(async () => fakeImageResponse(200, TOO_SMALL));
  const r = await downloadAndCache('r1', 'https://example.com/tiny.jpg');
  assert.equal(r.kind, 'invalid');
  assert.equal(hasCachedPhoto('r1'), false);
});

test('downloadAndCache: a network exception is reported as "error", not thrown', async () => {
  freshEnv();
  _setFetchForTests(async () => {
    throw new Error('ECONNRESET');
  });
  const r = await downloadAndCache('r1', 'https://example.com/r1.jpg');
  assert.equal(r.kind, 'error');
});

test('downloadAndCache: an invalid recipe id (path-traversal attempt) fails safe, never escapes the cache dir', async () => {
  freshEnv();
  _setFetchForTests(async () => fakeImageResponse(200, BIG_ENOUGH));
  const r = await downloadAndCache('../../evil', 'https://example.com/r1.jpg');
  assert.equal(r.kind, 'error');
});

// ---- pacing (independent of the search throttle) -----------------------------------------------

test('downloadAndCache: a second download inside the 10s window is throttled — no fetch at all', async () => {
  freshEnv();
  let now = 0;
  _setClockForTests(() => now);
  let calls = 0;
  _setFetchForTests(async () => {
    calls++;
    return fakeImageResponse(200, BIG_ENOUGH);
  });

  const first = await downloadAndCache('r1', 'https://example.com/r1.jpg');
  assert.equal(first.kind, 'cached');
  assert.equal(calls, 1);

  now += 5_000; // under the 10s floor
  const second = await downloadAndCache('r2', 'https://example.com/r2.jpg');
  assert.equal(second.kind, 'throttled');
  assert.equal(calls, 1, 'no network call while throttled');

  now += 5_000; // now at the 10s floor
  const third = await downloadAndCache('r2', 'https://example.com/r2.jpg');
  assert.equal(third.kind, 'cached');
  assert.equal(calls, 2);
});

// ---- serving (docs/48 §4b — GET /api/kitchen/photos/:recipeId) ---------------------------------

test('readCachedPhoto: 404-equivalent (null) when nothing has been cached for this id', () => {
  freshEnv();
  assert.equal(readCachedPhoto('never-downloaded'), null);
});

test('readCachedPhoto: returns the bytes + sniffed content-type for a cached jpeg', async () => {
  freshEnv();
  _setFetchForTests(async () => fakeImageResponse(200, BIG_ENOUGH));
  await downloadAndCache('r1', 'https://example.com/r1.jpg');
  const file = readCachedPhoto('r1');
  assert.ok(file);
  assert.equal(file?.contentType, 'image/jpeg');
  assert.equal(file?.buffer.length, BIG_ENOUGH.length);
});

test('readCachedPhoto: sniffs a PNG body correctly even though the file is always named .jpg', async () => {
  freshEnv();
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(11 * 1024, 2)]);
  _setFetchForTests(async () => fakeImageResponse(200, png, 'image/png'));
  await downloadAndCache('r2', 'https://example.com/r2.png');
  const file = readCachedPhoto('r2');
  assert.equal(file?.contentType, 'image/png');
});

test('readCachedPhoto: rejects a path-traversal id the same way — never reads outside the cache dir', () => {
  freshEnv();
  assert.equal(readCachedPhoto('../../../etc/passwd'), null);
});

test('cachedPhotoPath: stays inside the recipe-photos dir for a normal id', () => {
  freshEnv();
  const p = cachedPhotoPath('abc_123-XYZ');
  assert.match(p, /recipe-photos[\\/]abc_123-XYZ\.jpg$/);
});
