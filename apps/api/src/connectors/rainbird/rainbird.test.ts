// Unit tests for the Rain Bird protocol port — run with the Node built-in test
// runner via tsx:  node --import tsx --test src/connectors/rainbird/rainbird.test.ts
// (apps/api has no formal test-runner script; tsx is a devDependency.)
//
// These validate the crypto + SIP codec WITHOUT the physical controller, using:
//  - a self-consistent encrypt→decrypt round-trip (and a deterministic fixed-IV vector
//    we can byte-assert), and
//  - the request/response hex vectors published in pyrainbird's test data
//    (tests/testdata/*.yaml), so our decoders match the reference implementation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { encrypt, decrypt } from "./encryption";
import {
  encode,
  decodeModelAndVersion,
  decodeStations,
  decodeIrrigationState,
  decodeRainDelay,
  decodeSerialNumber,
} from "./sip";

// ---- Encryption round-trip --------------------------------------------------

test("encrypt → decrypt round-trips arbitrary JSON", () => {
  const password = "secret-test-pw";
  const json = JSON.stringify({
    id: 1,
    jsonrpc: "2.0",
    method: "tunnelSip",
    params: { data: "02", length: 1 },
  });
  const wire = encrypt(json, password);
  assert.equal(decrypt(wire, password), json);
});

test("wire layout = SHA256(json)[32] ++ IV[16] ++ ciphertext, with fixed IV", () => {
  const password = "pw";
  const json = '{"hello":"world"}';
  const iv = Buffer.alloc(16, 0x01); // deterministic IV for a byte-exact assertion
  const wire = encrypt(json, password, iv);

  // First 32 bytes are SHA256 of the UNPADDED json (pyrainbird's b2 = SHA256(data)).
  assert.deepEqual(
    wire.subarray(0, 32),
    createHash("sha256").update(json, "utf8").digest(),
  );
  // Next 16 bytes are the IV we supplied.
  assert.deepEqual(wire.subarray(32, 48), iv);
  // Ciphertext is a whole number of 16-byte blocks.
  assert.equal((wire.length - 48) % 16, 0);
  // And it decrypts back to the original json.
  assert.equal(decrypt(wire, password), json);
});

test("decrypt with the wrong password does NOT return the original json", () => {
  const json = '{"a":1}';
  const wire = encrypt(json, "right-pw");
  let decoded: string | null = null;
  try {
    decoded = decrypt(wire, "wrong-pw");
  } catch {
    decoded = null; // padding/bad-block error is an acceptable outcome
  }
  assert.notEqual(decoded, json);
});

// ---- SIP request encoding ---------------------------------------------------

test("encode produces the documented request hex", () => {
  assert.equal(encode("ModelAndVersion"), "02");
  assert.equal(encode("SerialNumber"), "05");
  assert.equal(encode("CurrentIrrigationState"), "48");
  assert.equal(encode("StopIrrigation"), "40");
  // AvailableStations(page 0) — len 2 → "03" + "00".
  assert.equal(encode("AvailableStations", [0]), "0300");
  // CurrentStationsActive(page 0) — len 2 → "3F" + "00".
  assert.equal(encode("CurrentStationsActive", [0]), "3F00");
  // RainDelaySet(14 days) — len 3 → "37" + days(4 hex) = "37000E".
  assert.equal(encode("RainDelaySet", [14]), "37000E");
  // ManuallyRunStation — pyrainbird layout: "39" + station(2 bytes) + minutes(1 byte).
  // Verified against pyrainbird encode_command (old-style: slack → FIRST arg, so the
  // station gets the wide field). The station MUST land in byte 3, not byte 2, or the
  // controller runs a bogus station and no valve opens.
  assert.equal(encode("ManuallyRunStation", [2, 10]), "3900020A");
  assert.equal(encode("ManuallyRunStation", [6, 30]), "3900061E");
  assert.equal(encode("ManuallyRunStation", [1, 255]), "390001FF");
});

// ---- Response decoding (pyrainbird test vectors) ----------------------------

test('decodeModelAndVersion matches pyrainbird vector "820006090C"', () => {
  const m = decodeModelAndVersion("820006090C");
  assert.equal(m.modelId, 0x0006);
  assert.equal(m.versionMajor, 9);
  assert.equal(m.versionMinor, 12);
  assert.equal(m.version, "9.12");
});

test('decodeStations matches pyrainbird vector "83003F000000" → stations 1-6', () => {
  const s = decodeStations("83003F000000");
  assert.equal(s.page, 0);
  assert.equal(s.mask >>> 0, 0x3f000000);
  assert.deepEqual(s.stations, [1, 2, 3, 4, 5, 6]);
});

test("decodeStations LSB-first within each byte (CurrentStationsActive, station 3 active)", () => {
  // page 0, mask 0x04000000: first byte 0x04 = bit 2 → station 3 only.
  const s = decodeStations("BF0004000000");
  assert.equal(s.page, 0);
  assert.deepEqual(s.stations, [3]);
});

test('decodeIrrigationState matches pyrainbird vector "C801" → true', () => {
  assert.equal(decodeIrrigationState("C801"), true);
  assert.equal(decodeIrrigationState("C800"), false);
});

test('decodeRainDelay matches pyrainbird vectors "B60003"→3, "B6000E"→14', () => {
  assert.equal(decodeRainDelay("B60003"), 3);
  assert.equal(decodeRainDelay("B6000E"), 14);
});

test('decodeSerialNumber matches pyrainbird vector "850000000000008963"', () => {
  assert.equal(decodeSerialNumber("850000000000008963"), "0000000000008963");
});
