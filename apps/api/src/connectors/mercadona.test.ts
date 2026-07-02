// Unit tests for the tightened Algolia key scrape (docs/41 hardening #4): the 32-hex
// search key must sit within ~200 chars of an algolia/apiKey/searchKey mention —
// a bare 32-hex match anywhere in a bundle happily grabs a webpack chunk hash.
// Run with the Node built-in test runner via tsx:
//   node --import tsx --test src/connectors/mercadona.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.STATE_FILE = join(mkdtempSync(join(tmpdir(), 'mercadona-test-')), 'state.json');

import { extractAlgolia } from './mercadona';

const APP_ID = '7UZJKL1DJ0';
const KEY = '9d8f2e39e90df472b4f2e559a116fe17';
const WEBPACK_HASH = 'c0ffee00deadbeef1234567890abcdef';

test('key adjacent to an algolia mention is extracted', () => {
  const js = `var client = algoliasearch("${APP_ID}", "${KEY}");`;
  assert.deepEqual(extractAlgolia(js), { appId: APP_ID, apiKey: KEY });
});

test('key near an apiKey/searchKey token (but away from "algolia") is extracted', () => {
  const js = `cfg={algoliaAppId:"${APP_ID}"};` + 'x'.repeat(300) + `;search={apiKey:"${KEY}"}`;
  assert.deepEqual(extractAlgolia(js), { appId: APP_ID, apiKey: KEY });
});

test('a webpack chunk hash far from any key token is NOT mistaken for the key', () => {
  // App id present, but the only 32-hex string is a chunk hash in unrelated code.
  const js =
    `var client = algoliasearch("${APP_ID}", SEARCH_KEY);` +
    'y'.repeat(500) +
    `__webpack_require__.u=function(e){return "static/chunks/"+e+"."+"${WEBPACK_HASH}"+".js"}`;
  assert.equal(extractAlgolia(js), null);
});

test('the real key wins even when a chunk hash appears first', () => {
  const js =
    `chunkMap={"main":"${WEBPACK_HASH}"}` +
    'z'.repeat(500) +
    `var client = algoliasearch("${APP_ID}", "${KEY}");`;
  assert.deepEqual(extractAlgolia(js), { appId: APP_ID, apiKey: KEY });
});

test('no app id → no result at all', () => {
  assert.equal(extractAlgolia(`searchKey:"${KEY}"`), null);
});
