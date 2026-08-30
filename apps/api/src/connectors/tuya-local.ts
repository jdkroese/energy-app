// Tuya LOCAL (LAN) control — Phase 2 (docs/44). A SELF-CONTAINED transport that talks
// directly to Tuya Wi-Fi devices over TCP 6668 on the LAN, so status reads and commands
// no longer have to spend cloud API quota (the free tier's ~54k calls/month wall — see
// docs/44 for the full story). This module never imports `./tuya` (the cloud connector);
// `./tuya` imports THIS module instead, one direction only, to avoid a circular import
// that could break the esbuild CJS bundle.
//
// Enabled by DEFAULT (docs/44 Phase 2 is hardware-verified): a persisted store setting
// (Settings → Tuya → "Local LAN control", store.ts integrations.tuya.localControl) is the
// normal on/off switch, since the production mini's launchd plist can't be edited remotely.
// TUYA_LOCAL_ENABLED remains a hard override on top of the store: '0' force-disables
// (kill switch), '1' force-enables; any other/unset value defers to the store setting
// (undefined/true = on, explicit false = off). See isLocalEnabled() below. With local
// disabled (by either mechanism) this module still loads (registry read from disk — cheap,
// synchronous, tolerant of a missing file) but never opens a socket and is never consulted
// by `./tuya` — behaviour is byte-for-byte what it was before this file existed.
//
// Cloud vs local DP naming: the cloud API and the local LAN protocol both describe a
// device's datapoints, but under different keys — the cloud uses human-readable `code`
// strings (e.g. "switch_1"), the local protocol uses small numeric `dp` indices (e.g. "1").
// Translating between them needs the per-device `dp_id` mapping the cloud's specifications
// endpoint returns — this module does NOT fetch that itself (that would reintroduce a cloud
// dependency into a file whose whole point is to work without one). Instead `sendCommands`
// takes an already-resolved `code -> dp` map, and `translateStatus` takes a `dp -> code`
// map; `./tuya` builds both from its own (already cloud-cached) getSpecifications() and
// passes them in. If a code can't be resolved, sendCommands throws BEFORE touching the
// network — the caller's fallback-to-cloud path is what makes an unresolvable/wrong
// mapping merely inconvenient rather than unsafe (see `sendCommandsDual` in tuya.ts).
//
// Registry: seeded once at import from DATA_DIR/tuya-local.json (the file
// scripts/tuya-harvest.mjs + scripts/tuya-lan-discover.mjs produce — id, name, category,
// the cloud's WAN `ip` (kept only for reference, NEVER used to connect), `localKey`,
// `lanIp`, `version`, `sub`, `online`, `productId`). A long-lived UDP listener (started
// only when the flag is on) then keeps `lanIp`/`version` fresh as DHCP moves devices
// around, without ever discarding an `lanIp` this process didn't personally hear — some
// devices are local-reachable over TCP but never answer the UDP broadcast (AP isolation),
// so a `lanIp` loaded from the file (persisted by a past discovery run) is just as valid a
// source as a live broadcast, and live discovery only ever ADDS to what was loaded.
//
// Protocol version support: this fleet is NOT uniformly 3.3/3.4. A live tinytuya probe
// (coordinator-verified 2026-08-20, see scripts/tuya-v35-probe.py) found the real split is
// v3.3 x3, v3.4 x20, v3.5 x11 (AES-GCM framing, magic 0x00006699), unreachable x2. tuyapi@7
// cannot decode v3.5 at all, so those 11 devices — including the car charger and the
// "up WCD's"/"Bomba interruptor" breakers — get a hand-rolled native client instead (see
// "Native v3.5 (AES-GCM) transport" below, ported from tinytuya's actual source). Any
// version genuinely outside what EITHER client can speak still fails CLOSED exactly as
// before: a FIRST-CLASS, non-retrying "no" — never attempted, never counted as a health
// failure, never allowed to eat a connect/response timeout on the hot path — distinct from
// "device offline" or "no LAN ip yet". See SUPPORTED_LOCAL_VERSIONS, capabilityBlockReason(),
// pickLocalTransport(), and isV35DiscoveryFrame() below. A version that silently fails to
// parse used to look indistinguishable from "device asleep/unplugged"; it still doesn't.

import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import TuyaDevice from 'tuyapi';
// One-directional: store.ts never imports this module, so importing it here (for the
// localControl toggle) can't create a cycle. See the module banner above.
import * as store from '../store';

const DATA_DIR = process.env.DATA_DIR || '/Users/joris/sites/energy/.data';
const CACHE_FILE = path.join(DATA_DIR, 'tuya-local.json');

// The static key every Tuya device uses to encrypt its UDP discovery broadcast (NOT the
// per-device local_key). Recomputed here rather than reaching into tuyapi's internals
// (`tuyapi/lib/config`) so this module stays self-contained and immune to their internal
// layout changing across patch releases. Hardware-validated in scripts/tuya-lan-discover.mjs.
const UDP_KEY = crypto.createHash('md5').update('yGAdlopoPVldABfn').digest();

/** Whether local (LAN) control is switched on at all. Everything else in this module is
 *  inert when this is false — no socket is opened, and tuya.ts never calls in here.
 *  Precedence: TUYA_LOCAL_ENABLED='0' is a hard kill switch (always off, regardless of the
 *  store setting) — TUYA_LOCAL_ENABLED='1' is a hard force-on. Any other value, including
 *  unset, defers to the persisted store setting (see store.ts integrations.tuya.localControl),
 *  which defaults ON (undefined/true) — only an explicit `false` turns it off. Reads the
 *  store fresh on every call (cheap — store.get() is an in-memory cache, not file I/O after
 *  the first load) so a runtime Settings toggle takes effect on the very next command/status
 *  call, not just after a restart. */
export function isLocalEnabled(): boolean {
  const env = process.env.TUYA_LOCAL_ENABLED;
  if (env === '0') return false;
  if (env === '1') return true;
  return store.get().integrations.tuya?.localControl !== false;
}

// ---- Registry -----------------------------------------------------------------------

export interface LocalDeviceEntry {
  id: string;
  name: string;
  category: string;
  /** The cloud's WAN/public ip. Reference only — NEVER used to open a connection. */
  wanIp: string;
  /** The real LAN ip — from UDP discovery, or carried over from a prior discovery run
   *  that was persisted to the cache file. Empty until known. */
  lanIp: string;
  localKey: string;
  version: string;
  /** Zigbee/BLE sub-device behind a gateway — never reachable at TCP 6668. */
  sub: boolean;
  online: boolean;
  productId: string;
  /** Cloud `code` -> local LAN `dp` index (docs/49 Change 1) — captured once via
   *  tuya.ts's dpMapsFor() (a cloud thing-model fetch) and persisted here so the mapping
   *  never needs the cloud again: the DP layout is immutable per device. Absent until
   *  captured; `getDpMap`/`setDpMap` below are the only accessors — this field is never
   *  read directly outside this module. */
  dpMap?: Record<string, number>;
}

function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

/** Tolerant parse of a persisted `dpMap` field: an object of string code -> finite-number
 *  dp, dropping any non-finite/malformed entry rather than throwing. Returns `undefined`
 *  (never an empty object) when nothing usable survives, so `getDpMap` can treat "absent"
 *  and "empty" the same way. Exported for tests. */
export function parseDpMap(v: unknown): Record<string, number> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, number> = {};
  let any = false;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    // Only an actual number, or a string that IS one — never coerce null/boolean/
    // object/array (Number(null) === 0 would otherwise silently manufacture a fake dp 0).
    if (typeof val !== 'number' && typeof val !== 'string') continue;
    const n = Number(val);
    if (Number.isFinite(n)) {
      out[k] = n;
      any = true;
    }
  }
  return any ? out : undefined;
}

/**
 * Parse a tuya-local.json cache file into registry entries. Pure (no module state) and
 * tolerant — a missing file, a non-JSON file, a missing `devices` array, or a malformed
 * individual entry all degrade to "skip it" rather than throwing. Exported for tests.
 */
export function loadRegistryFromFile(file: string): LocalDeviceEntry[] {
  const raw = readJsonFile(file) as { devices?: unknown[] } | null;
  const list = Array.isArray(raw?.devices) ? (raw as { devices: unknown[] }).devices : [];
  const out: LocalDeviceEntry[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const id = str(rec.id);
    if (!id) continue;
    out.push({
      id,
      name: str(rec.name) || id,
      category: str(rec.category),
      wanIp: str(rec.ip),
      lanIp: str(rec.lanIp),
      localKey: str(rec.localKey),
      version: str(rec.version),
      sub: rec.sub === true,
      online: rec.online === true,
      productId: str(rec.productId),
      dpMap: parseDpMap(rec.dpMap),
    });
  }
  return out;
}

const registry = new Map<string, LocalDeviceEntry>();
let registryLoadedAt: number | null = null;

/** (Re)load the registry from CACHE_FILE into module state. Called once at import, and
 *  safe to call again later (e.g. after an ops harvest/discover run updates the file). */
export function reloadRegistry(): void {
  registry.clear();
  for (const entry of loadRegistryFromFile(CACHE_FILE)) registry.set(entry.id, entry);
  registryLoadedAt = Date.now();
}

/** Snapshot of every registry entry — server-internal only (never route this straight out
 *  to a client; it carries `localKey`). Used by tuya.ts's local fleet fallback (docs/49
 *  Change 2) and dp-map capture (Change 4) to enumerate the harvested fleet without this
 *  module reaching back into `./tuya` (see the module banner's one-directional-import note). */
export function listRegistry(): LocalDeviceEntry[] {
  return [...registry.values()];
}

// ---- Persisted dp-map (docs/49 Change 1) -----------------------------------------------
// The cloud/local dp mapping never changes for a given device, so once captured (via a
// single cloud thing-model fetch — see tuya.ts's dpMapsFor) it is stored here and persisted
// to CACHE_FILE, removing the SECOND hidden cloud dependency a blackout used to hit (the
// first being the fleet listing itself — see localFleetSnapshot in tuya.ts). Pure map<->
// record conversion; no network I/O anywhere in this section.

function dpMapToRecord(codeToDp: Map<string, number>): Record<string, number> {
  const rec: Record<string, number> = {};
  for (const [code, dp] of codeToDp) rec[code] = dp;
  return rec;
}

function sameDpMap(a: Record<string, number> | undefined, b: Record<string, number>): boolean {
  if (!a) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return bKeys.every((k) => a[k] === b[k]);
}

/** The persisted dp-map for a device, in both directions — `null` when nothing has been
 *  captured yet (an absent or empty map are treated the same). No network I/O; tuya.ts's
 *  dpMapsFor() is the only thing that ever populates this (via setDpMap below). */
export function getDpMap(id: string): { codeToDp: Map<string, number>; dpToCode: Map<number, string> } | null {
  const rec = registry.get(id)?.dpMap;
  if (!rec || Object.keys(rec).length === 0) return null;
  const codeToDp = new Map<string, number>();
  const dpToCode = new Map<number, string>();
  for (const [code, dp] of Object.entries(rec)) {
    codeToDp.set(code, dp);
    dpToCode.set(dp, code);
  }
  return { codeToDp, dpToCode };
}

/** Persist a freshly-resolved dp-map (cloud `code` -> local `dp`) onto the registry entry
 *  and schedule a write-back to CACHE_FILE. No-op for an unknown device, an empty map (a
 *  transient cloud miss must never wedge a device with a blank persisted map), or a map
 *  that's unchanged from what's already stored (avoids a needless disk write on every
 *  process-lifetime cache warm). Storage direction is code->dp only — `getDpMap` derives
 *  the reverse direction on read, so there is exactly one source of truth on disk. */
export function setDpMap(id: string, codeToDp: Map<string, number>): void {
  if (codeToDp.size === 0) return;
  const entry = registry.get(id);
  if (!entry) return;
  const rec = dpMapToRecord(codeToDp);
  if (sameDpMap(entry.dpMap, rec)) return;
  registry.set(id, { ...entry, dpMap: rec });
  schedulePersist();
}

// ---- Health / circuit breaker --------------------------------------------------------
// Mirrors the cloud connector's quota cool-off (tuya.ts): after repeated local failures for
// one device, stop spending a connection attempt + timeout on it every hot-path call and
// let it cool off, retrying only occasionally. Per-device, not fleet-wide — one dead plug
// must never block local control for the rest of the fleet.

export interface LocalHealthEntry {
  consecutiveFailures: number;
  lastOkAt: number | null;
  lastFailAt: number | null;
  lastError: string | null;
}

const FAILURE_THRESHOLD = 3;
const COOLDOWN_MS = 5 * 60_000;

const health = new Map<string, LocalHealthEntry>();

/** Pure: whether a device with this health record may be attempted right now. Exported
 *  for tests; `now` is injectable so tests never depend on real elapsed time. */
export function computeCanAttempt(h: LocalHealthEntry | undefined, now = Date.now()): boolean {
  if (!h || h.consecutiveFailures < FAILURE_THRESHOLD) return true;
  return h.lastFailAt !== null && now - h.lastFailAt >= COOLDOWN_MS;
}

function noteSuccess(id: string): void {
  const prev = health.get(id);
  health.set(id, { consecutiveFailures: 0, lastOkAt: Date.now(), lastFailAt: prev?.lastFailAt ?? null, lastError: null });
}

function noteFailure(id: string, err: unknown): void {
  const prev = health.get(id);
  health.set(id, {
    consecutiveFailures: (prev?.consecutiveFailures ?? 0) + 1,
    lastOkAt: prev?.lastOkAt ?? null,
    lastFailAt: Date.now(),
    lastError: err instanceof Error ? err.message : String(err),
  });
}

// ---- Capability / preflight -----------------------------------------------------------

/** Local protocol versions this transport can actually speak: tuyapi@7 handles 3.1-3.4,
 *  and the hand-rolled AES-GCM client (see "Native v3.5" below) handles 3.5. Kept as an
 *  explicit allowlist (not "whatever this fleet mostly is") so any future/older version
 *  neither client can speak still fails CLOSED — routed straight to cloud, never retried on
 *  the hot path — instead of being attempted and burning a connect/response timeout every
 *  time. Extending local support to a new version later is a one-line change here PLUS a
 *  transport that can actually speak it (see pickLocalTransport) — adding the version alone
 *  would just make this module attempt (and fail) against devices it still can't talk to. */
const SUPPORTED_LOCAL_VERSIONS = new Set(['3.3', '3.4', '3.5']);

/** Why (if at all) a registry entry is not CAPABLE of local control, independent of
 *  current health/cooldown — that's a separate, transient axis (see computeCanAttempt).
 *  null means fully capable. An entry with no version recorded yet is NOT treated as
 *  unsupported (falls through to the '3.3' default at connect time) — only a version we
 *  positively know is unsupported blocks here. */
export type LocalBlockReason = 'gateway-sub-device' | 'no-key' | 'no-lan-ip' | 'unsupported-version';

export function capabilityBlockReason(entry: LocalDeviceEntry): LocalBlockReason | null {
  if (entry.sub) return 'gateway-sub-device';
  if (!entry.localKey || entry.localKey.length !== 16) return 'no-key';
  if (!entry.lanIp) return 'no-lan-ip';
  if (entry.version && !SUPPORTED_LOCAL_VERSIONS.has(entry.version)) return 'unsupported-version';
  return null;
}

/** Pure: does this registry entry describe a device that is, IN PRINCIPLE, locally
 *  reachable? Exported for tests. */
export function computeLocalCapable(entry: LocalDeviceEntry | undefined): boolean {
  return !!entry && capabilityBlockReason(entry) === null;
}

/** Whether device `id` is locally reachable in principle (static — ignores current
 *  cool-off state; see computeCanAttempt for that). */
export function isLocalCapable(id: string): boolean {
  return computeLocalCapable(registry.get(id));
}

const BLOCK_REASON_TEXT: Record<LocalBlockReason, string> = {
  'gateway-sub-device': 'gateway sub-device — never LAN-reachable',
  'no-key': 'no (valid) local_key',
  'no-lan-ip': 'no LAN ip discovered yet',
  'unsupported-version': 'unsupported protocol version',
};

/**
 * Pure preflight check shared by sendCommands/readStatus: why (if at all) a local attempt
 * must NOT be made right now. Returns null when it's safe to proceed. Exported so the
 * "local fails -> caller falls back to cloud" boundary is directly testable without any
 * network I/O or seeded module state.
 */
export function localAttemptBlockedReason(
  entry: LocalDeviceEntry | undefined,
  h: LocalHealthEntry | undefined,
  now = Date.now(),
): string | null {
  if (!entry) return 'unknown device';
  const cap = capabilityBlockReason(entry);
  if (cap === 'unsupported-version') {
    return `unsupported protocol version "${entry.version}" (this transport speaks ${[...SUPPORTED_LOCAL_VERSIONS].join('/')})`;
  }
  if (cap) return BLOCK_REASON_TEXT[cap];
  if (!computeCanAttempt(h, now)) return 'in cooldown after repeated local failures';
  return null;
}

// ---- DP <-> cloud code translation (pure; caller supplies the map) --------------------

/** Turn cloud-shaped commands into a local `{dp: value}` set using a caller-supplied
 *  code->dp map (from the cloud's cached specifications — see tuya.ts). Throws BEFORE any
 *  network I/O if any command's code has no known local dp, so a bad/incomplete mapping
 *  can never send a PARTIAL or wrong-DP command — it just fails closed to cloud. */
export function translateCommands(
  commands: Array<{ code: string; value: unknown }>,
  dpForCode: Map<string, number>,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const c of commands) {
    const dp = dpForCode.get(c.code);
    if (dp === undefined) throw new Error(`tuya-local: no local datapoint mapping for code "${c.code}"`);
    data[String(dp)] = c.value;
  }
  return data;
}

/** Reverse direction for reads: translate whatever raw numeric dps a device answered with
 *  back into cloud-style {code, value} using a caller-supplied dp->code map. Lenient — a dp
 *  with no known code is simply dropped (status is inherently sparse; callers already treat
 *  a missing code as "unknown", never as an error). */
export function translateStatus(
  dps: Record<string, unknown>,
  codeForDp: Map<number, string>,
): Array<{ code: string; value: unknown }> {
  const out: Array<{ code: string; value: unknown }> = [];
  for (const [k, v] of Object.entries(dps ?? {})) {
    const n = Number(k);
    const code = Number.isFinite(n) ? codeForDp.get(n) : undefined;
    if (code) out.push({ code, value: v });
  }
  return out;
}

// ---- Connection pool ------------------------------------------------------------------
// A Tuya device accepts only ONE local session at a time — a second concurrent connection
// attempt doesn't queue, it makes BOTH look like failures (coordinator field report,
// 2026-08-20: probing one device with several held keys at once produced flaky timeouts
// that had nothing to do with the device being unreachable). One pooled TuyaDevice instance
// per id, reused for every read/write, is what prevents that: getConnection() below does
// `pool.get` -> (miss) `new TuyaDevice` + `pool.set` -> `await connect()` with NO await in
// between the get and the set, so two calls that both find the pool empty can't each create
// a competing connection — whichever runs first synchronously claims the pool slot before
// either yields, and the second reuses that SAME instance (and tuyapi's own `connect()`
// coalesces a concurrent call into the first one's in-flight promise on top of that).

const pool = new Map<string, TuyaDevice>();
const CONNECT_TIMEOUT_MS = 7_000;
const RESPONSE_TIMEOUT_MS = 7_000;

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/** Drop a pooled connection (e.g. after any error) so the next attempt starts fresh.
 *  Clears BOTH pools unconditionally (tuyapi's `pool` and the native v3.5 `poolV35`
 *  declared further below) — a given id only ever lives in one of them, so this is cheap
 *  and it means every existing call site (already calling `evict()` on any failure) needs
 *  no change to also cover the new v3.5 path. */
function evict(id: string): void {
  const dev = pool.get(id);
  pool.delete(id);
  if (dev) {
    try {
      dev.disconnect();
    } catch {
      /* already down */
    }
  }
  const sess = poolV35.get(id);
  poolV35.delete(id);
  if (sess) {
    try {
      sess.disconnect();
    } catch {
      /* already down */
    }
  }
}

async function getConnection(entry: LocalDeviceEntry): Promise<TuyaDevice> {
  let dev = pool.get(entry.id);
  if (!dev) {
    dev = new TuyaDevice({
      id: entry.id,
      key: entry.localKey,
      ip: entry.lanIp,
      version: entry.version || '3.3',
      issueGetOnConnect: false,
    });
    // tuyapi emits an unhandled 'error' on socket timeout / parse errors and Node throws
    // (and crashes the process) if an EventEmitter's 'error' event has no listener — this
    // listener's only job is to prevent that. Also evict on error so a poisoned socket is
    // never reused, and record it in health so the diagnostics surface can see it.
    dev.on('error', (err: Error) => {
      noteFailure(entry.id, err);
      evict(entry.id);
    });
    pool.set(entry.id, dev);
  }
  if (!dev.isConnected()) {
    await withTimeout(dev.connect(), CONNECT_TIMEOUT_MS, 'tuya-local: connect timeout');
  }
  return dev;
}

// ---- Native v3.5 (AES-GCM) transport ---------------------------------------------------
// tuyapi@7 (used for 3.3/3.4 above) has no AES-GCM support at all, so v3.5 devices need a
// purpose-built client. Ported from tinytuya (jasonacox/tinytuya, read from source
// 2026-08-20 — specifically core/{header,command_types,message_helper,crypto_helper,
// XenonDevice}.py — not guessed) — the same library whose live probe against this exact
// fleet (scripts/tuya-v35-probe.py) proved these 11 devices' keys/ips are good and their
// local_key-based session handshake works. Frame shape:
//
//   prefix(4)=0x00006699 | reserved(2)=0x0000 | seqno(4) | cmd(4) | length(4) |
//   IV(12) | ciphertext(length-28) | GCM tag(16) | suffix(4)=0x00009966
//
// `length` covers IV+ciphertext+tag but NOT the 4-byte suffix (confirmed against tinytuya's
// message_helper.py pack_message()/parse_header()). The GCM AAD is the 14 bytes between the
// prefix and the IV (reserved+seqno+cmd+length) — the prefix itself is authenticated by
// neither the tag nor anything else, matching tinytuya exactly. A fresh random 12-byte IV
// is generated per frame — GCM with a reused (key, IV) pair leaks the authentication key.
//
// Session key negotiation (cmd bytes 3/4/5 — "SESS_KEY_NEG_START/RESP/FINISH") happens once
// per TCP connection, encrypted with the device's real local_key, before any command can be
// sent: the client sends a random 16-byte nonce, the device replies with its own nonce plus
// an HMAC proving it holds the same local_key, the client replies with its own HMAC of the
// device's nonce, and both sides derive a per-session AES key from the two nonces (see
// deriveSessionKey35). Every later frame is encrypted with that session key, never the raw
// local_key — losing the connection means renegotiating from scratch, never a resume.

// @types/node (v22+) makes Buffer generic over its backing ArrayBuffer type: Buffer.alloc()/
// Buffer.from() return the narrower Buffer<ArrayBuffer>, but Buffer.concat()/.subarray()
// return the wider Buffer<ArrayBufferLike> — assignable FROM the narrow one but not the
// other way around. Frames in this section flow through both (fresh allocations AND
// concatenation/slicing), so every Buffer here is typed via this alias, not bare `Buffer`,
// to avoid a spurious mismatch between the two.
type Bytes = Buffer<ArrayBufferLike>;

const V35_SUFFIX = 0x00009966;
const GCM_IV_LEN = 12;
const GCM_TAG_LEN = 16;
const V35_HEADER_LEN = 18; // prefix(4) + reserved(2) + seqno(4) + cmd(4) + length(4)

const CMD_SESS_KEY_NEG_START = 3;
const CMD_SESS_KEY_NEG_RESP = 4;
const CMD_SESS_KEY_NEG_FINISH = 5;
const CMD_CONTROL_NEW = 13;
const CMD_DP_QUERY_NEW = 16;

// '<version>' + 12 null bytes. tinytuya prepends this to CONTROL_NEW payloads (but NOT to
// DP_QUERY_NEW or the session-negotiation messages — see NO_PROTOCOL_HEADER_CMDS in
// tinytuya's header.py) before encryption, and strips it back off (if present) when
// decoding a response. Ported verbatim for the one command this transport sends that needs
// it (CONTROL_NEW — see TuyaGcm35Device.setDps() below); decodeGcm35Json() is what strips
// it back off on the way in.
const V35_VERSION_HEADER = Buffer.concat([Buffer.from('3.5', 'latin1'), Buffer.alloc(12)]);

// NOTE: V35_MAGIC (the 0x00006699 frame prefix, shared with packGcm35Frame/parseGcm35Frame
// below) is declared further down in the existing "v3.5 (AES-GCM) sighting detection"
// section, which predates this one and already owns it — a plain top-level `const` is
// visible to every function in this module regardless of declaration order, so this is
// just a pointer for readers, not a forward-reference problem.

export interface Gcm35Frame {
  seqno: number;
  cmd: number;
  iv: Bytes;
  ciphertext: Bytes;
  tag: Bytes;
  /** The 14 authenticated-but-unencrypted header bytes (reserved+seqno+cmd+length) — the
   *  GCM Additional Authenticated Data. */
  aad: Bytes;
  /** Bytes consumed from the front of the input buffer — for streaming reassembly. */
  consumed: number;
}

/** Pure: encrypt+frame one v3.5 (AES-GCM) message. `key` is the raw local_key during
 *  session negotiation, the derived session key for every message after. Exported for
 *  tests (round-tripped against parseGcm35Frame/decryptGcm35Frame with synthetic data). */
export function packGcm35Frame(seqno: number, cmd: number, plaintext: Bytes, key: Bytes): Bytes {
  const iv = crypto.randomBytes(GCM_IV_LEN);
  const length = GCM_IV_LEN + plaintext.length + GCM_TAG_LEN;
  const header = Buffer.alloc(V35_HEADER_LEN);
  header.writeUInt32BE(V35_MAGIC, 0);
  header.writeUInt16BE(0, 4);
  header.writeUInt32BE(seqno >>> 0, 6);
  header.writeUInt32BE(cmd >>> 0, 10);
  header.writeUInt32BE(length, 14);
  const aad = header.subarray(4);

  const cipher = crypto.createCipheriv('aes-128-gcm', key, iv, { authTagLength: GCM_TAG_LEN });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const suffix = Buffer.alloc(4);
  suffix.writeUInt32BE(V35_SUFFIX, 0);
  return Buffer.concat([header, iv, ciphertext, tag, suffix]);
}

/** Pure: extract ONE v3.5 frame from the front of `buf`, if a complete one is present.
 *  Returns null (never throws) when more bytes are needed — TCP can deliver a frame split
 *  across reads, or several frames in one read. Throws only for a structurally malformed
 *  frame (bad prefix/suffix/length); never inspects — let alone decrypts — the ciphertext,
 *  so a wrong key or corrupted body is reported by decryptGcm35Frame(), not here. Exported
 *  for tests. */
export function parseGcm35Frame(buf: Bytes): Gcm35Frame | null {
  if (buf.length < V35_HEADER_LEN) return null;
  if (buf.readUInt32BE(0) !== V35_MAGIC) throw new Error('tuya-local(v3.5): bad frame prefix');
  const length = buf.readUInt32BE(14);
  if (length < GCM_IV_LEN + GCM_TAG_LEN) throw new Error('tuya-local(v3.5): frame length too short for iv+tag');
  const total = V35_HEADER_LEN + length + 4;
  if (buf.length < total) return null;
  const suffix = buf.readUInt32BE(V35_HEADER_LEN + length);
  if (suffix !== V35_SUFFIX) throw new Error('tuya-local(v3.5): bad frame suffix');

  return {
    seqno: buf.readUInt32BE(6),
    cmd: buf.readUInt32BE(10),
    aad: buf.subarray(4, V35_HEADER_LEN),
    iv: buf.subarray(V35_HEADER_LEN, V35_HEADER_LEN + GCM_IV_LEN),
    ciphertext: buf.subarray(V35_HEADER_LEN + GCM_IV_LEN, V35_HEADER_LEN + length - GCM_TAG_LEN),
    tag: buf.subarray(V35_HEADER_LEN + length - GCM_TAG_LEN, V35_HEADER_LEN + length),
    consumed: total,
  };
}

/** Pure: decrypt+authenticate one already-parsed frame. Throws if the GCM tag doesn't
 *  verify — a tampered frame, the wrong key (e.g. a stale session key after a device
 *  reboot), or a desynced stream. Callers must treat that as a hard failure, never fall
 *  back to treating the ciphertext as plaintext. Exported for tests. */
export function decryptGcm35Frame(key: Bytes, frame: Gcm35Frame): Bytes {
  const decipher = crypto.createDecipheriv('aes-128-gcm', key, frame.iv, { authTagLength: GCM_TAG_LEN });
  decipher.setAAD(frame.aad);
  decipher.setAuthTag(frame.tag);
  return Buffer.concat([decipher.update(frame.ciphertext), decipher.final()]);
}

/** Pure: every DEVICE -> CLIENT v3.5 payload carries a leading 4-byte return code (0 =
 *  success) ahead of the real body. tinytuya hardcodes this assumption rather than sniffing
 *  for it (its own `no_retcode` auto-detect path is dead code in the current release), so
 *  this does the same. Exported for tests. */
export function stripV35Retcode(plaintext: Bytes): Bytes {
  return plaintext.length >= 4 ? plaintext.subarray(4) : plaintext;
}

/** Pure: decode a retcode-stripped v3.5 JSON command response. Some responses echo the
 *  version header (see V35_VERSION_HEADER) — stripped if present. Returns null for an empty
 *  (ack-only) payload rather than throwing, so the caller can keep reading the next frame
 *  instead of treating a keepalive as a parse failure. Exported for tests. */
export function decodeGcm35Json(body: Bytes): unknown {
  let b = body;
  if (b.length >= V35_VERSION_HEADER.length && b.subarray(0, 3).toString('latin1') === '3.5') {
    b = b.subarray(V35_VERSION_HEADER.length);
  }
  if (b.length === 0) return null;
  return JSON.parse(b.toString('utf8'));
}

/** Pure: message 1 of the session-key handshake (SESS_KEY_NEG_START) — just the random
 *  client nonce, no envelope. Exported for tests/documentation of the wire shape. */
export function buildSessionNegStart(localNonce: Bytes): Bytes {
  return localNonce;
}

/** Pure: validate message 2 (SESS_KEY_NEG_RESP) and extract the device's nonce. `payload`
 *  is the ALREADY decrypted+retcode-stripped response: a 16-byte device nonce followed by a
 *  32-byte HMAC-SHA256(local_key, client_nonce) that proves the device holds the same
 *  local_key we do. Throws on a short payload or an HMAC mismatch — both must hard-fail the
 *  negotiation rather than proceed with an unverified nonce (a mismatch here means either a
 *  wrong/rotated local_key or a reply from the wrong device). Exported for tests. */
export function verifySessionNegResp(payload: Bytes, localKey: Bytes, localNonce: Bytes): Bytes {
  if (payload.length < 48) throw new Error('tuya-local(v3.5): session key negotiation response too short');
  const remoteNonce = payload.subarray(0, 16);
  const gotHmac = payload.subarray(16, 48);
  const wantHmac = crypto.createHmac('sha256', localKey).update(localNonce).digest();
  if (!crypto.timingSafeEqual(gotHmac, wantHmac)) {
    throw new Error('tuya-local(v3.5): session key negotiation HMAC mismatch');
  }
  return remoteNonce;
}

/** Pure: message 3 (SESS_KEY_NEG_FINISH) — HMAC-SHA256(local_key, device_nonce), proving
 *  back to the device that the client derived the same shared secret. Exported for tests. */
export function buildSessionNegFinish(localKey: Bytes, remoteNonce: Bytes): Bytes {
  return crypto.createHmac('sha256', localKey).update(remoteNonce).digest();
}

/** Pure: derive the AES-GCM session key, ported from tinytuya's
 *  `_negotiate_session_key_generate_finalize` (version >= 3.5 branch): XOR the two 16-byte
 *  nonces, AES-128-GCM-encrypt the result with the REAL (static) local_key using the first
 *  12 bytes of the LOCAL nonce as the IV, and keep only the 16-byte ciphertext — the GCM
 *  auth tag this produces is intentionally discarded (never sent or checked anywhere; GCM
 *  is being reused here purely as a keyed PRF, not as a transport frame). Exported for
 *  tests. */
export function deriveSessionKey35(localKey: Bytes, localNonce: Bytes, remoteNonce: Bytes): Bytes {
  const xored = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) xored[i] = localNonce[i] ^ remoteNonce[i];
  const iv = localNonce.subarray(0, GCM_IV_LEN);
  const cipher = crypto.createCipheriv('aes-128-gcm', localKey, iv, { authTagLength: GCM_TAG_LEN });
  return Buffer.concat([cipher.update(xored), cipher.final()]);
}

/** Which internal client speaks a device's local protocol version — pure so the dispatch
 *  itself is unit-testable without a socket. Only distinguishes between the two SUPPORTED
 *  paths; capabilityBlockReason() is what actually gates a genuinely-unsupported version
 *  out before this is ever consulted on the hot path. Exported for tests. */
export function pickLocalTransport(version: string): 'tuyapi' | 'native-gcm' {
  return version === '3.5' ? 'native-gcm' : 'tuyapi';
}

const TCP_PORT_V35 = 6668;

/** A hand-rolled client for exactly the v3.5 (AES-GCM) subset this fleet needs: connect,
 *  negotiate a session key, read status, send commands. One instance per device, pooled
 *  below exactly like tuyapi's TuyaDevice is for 3.3/3.4 — including the single-in-flight-
 *  request assumption the rest of this module already relies on (see the pool comment above
 *  getConnection()). Never logs `localKey` or the derived session key; every error message
 *  below is deliberately generic. */
class TuyaGcm35Device {
  private readonly lanIp: string;
  private readonly localKey: Bytes;
  private socket: net.Socket | null = null;
  private sessionKey: Bytes | null = null;
  private seqno = 1;
  private recvBuf: Bytes = Buffer.alloc(0);
  private pending: { resolve: (f: Gcm35Frame) => void; reject: (e: Error) => void } | null = null;
  private dead = false;

  constructor(lanIp: string, localKey: string) {
    this.lanIp = lanIp;
    this.localKey = Buffer.from(localKey, 'utf8');
  }

  isConnected(): boolean {
    return !this.dead && this.socket !== null && this.sessionKey !== null;
  }

  disconnect(): void {
    this.dead = true;
    this.failPending(new Error('tuya-local(v3.5): disconnected'));
    if (this.socket) {
      try {
        this.socket.destroy();
      } catch {
        /* already down */
      }
    }
    this.socket = null;
    this.sessionKey = null;
    this.recvBuf = Buffer.alloc(0);
  }

  private failPending(err: Error): void {
    const p = this.pending;
    this.pending = null;
    if (p) p.reject(err);
  }

  private nextSeqno(): number {
    const s = this.seqno;
    this.seqno += 1;
    return s;
  }

  private onData(chunk: Bytes): void {
    this.recvBuf = this.recvBuf.length ? Buffer.concat([this.recvBuf, chunk]) : chunk;
    if (!this.pending) return; // nothing waiting yet — keep bytes buffered for the next awaitFrame()
    let frame: Gcm35Frame | null;
    try {
      frame = parseGcm35Frame(this.recvBuf);
    } catch (e) {
      this.recvBuf = Buffer.alloc(0);
      this.failPending(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    if (!frame) return; // need more bytes
    this.recvBuf = this.recvBuf.subarray(frame.consumed);
    const p = this.pending;
    this.pending = null;
    p.resolve(frame);
  }

  /** Write one frame. Never waits for a reply — see awaitFrame(). */
  private send(cmd: number, plaintext: Bytes, key: Bytes): Promise<void> {
    if (!this.socket) return Promise.reject(new Error('tuya-local(v3.5): not connected'));
    const frame = packGcm35Frame(this.nextSeqno(), cmd, plaintext, key);
    return new Promise((resolve, reject) => {
      this.socket!.write(frame, (err) => (err ? reject(err) : resolve()));
    });
  }

  /** Wait for the next inbound frame. v3.5 devices reply with their own
   *  globally-incrementing seqno rather than echoing ours (mirrors tinytuya's
   *  `_get_retcode` comment on why it skips the seqno check for >= 3.5), so this never
   *  tries to match a specific request — it relies on the pool's single-in-flight-request
   *  rule, same as tuyapi's connection is relied on above. */
  private awaitFrame(): Promise<Gcm35Frame> {
    if (this.dead) return Promise.reject(new Error('tuya-local(v3.5): connection closed'));
    if (this.pending) return Promise.reject(new Error('tuya-local(v3.5): a request is already in flight'));
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.onData(Buffer.alloc(0)); // deliver immediately if a full frame is already buffered
    });
  }

  async connect(): Promise<void> {
    this.dead = false;
    this.recvBuf = Buffer.alloc(0);
    this.seqno = 1;
    try {
      await new Promise<void>((resolve, reject) => {
        const sock = net.createConnection({ host: this.lanIp, port: TCP_PORT_V35 });
        let settled = false;
        sock.on('connect', () => {
          this.socket = sock;
          settled = true;
          resolve();
        });
        sock.on('data', (chunk: Bytes) => this.onData(chunk));
        sock.on('error', (err: Error) => {
          this.dead = true;
          this.failPending(err);
          if (!settled) {
            settled = true;
            reject(err);
          }
        });
        sock.on('close', () => {
          this.dead = true;
          this.failPending(new Error('tuya-local(v3.5): connection closed'));
        });
      });

      // Session key negotiation (messages 0x03/0x04/0x05) — see the module banner above.
      const localNonce = crypto.randomBytes(16);
      await this.send(CMD_SESS_KEY_NEG_START, buildSessionNegStart(localNonce), this.localKey);
      const respFrame = await this.awaitFrame();
      if (respFrame.cmd !== CMD_SESS_KEY_NEG_RESP) {
        throw new Error(`tuya-local(v3.5): unexpected reply (cmd ${respFrame.cmd}) during session key negotiation`);
      }
      const plain = decryptGcm35Frame(this.localKey, respFrame);
      const remoteNonce = verifySessionNegResp(stripV35Retcode(plain), this.localKey, localNonce);
      // Finish is fire-and-forget — tinytuya does not wait for (or expect) a reply to it.
      await this.send(CMD_SESS_KEY_NEG_FINISH, buildSessionNegFinish(this.localKey, remoteNonce), this.localKey);
      this.sessionKey = deriveSessionKey35(this.localKey, localNonce, remoteNonce);
    } catch (e) {
      this.disconnect();
      throw e instanceof Error ? e : new Error(String(e));
    }
  }

  /** Send one JSON command and return its decoded response body, transparently skipping any
   *  empty ack-only frame(s) the device sends before the real answer (mirrors tinytuya's
   *  null-payload retry in `_send_receive`). `allowNonJson` is for CONTROL_NEW, whose
   *  response body this transport does not need to parse — a successfully decrypted and
   *  authenticated frame already proves the device received the command. */
  private async requestJson(cmd: number, plaintext: Bytes, allowNonJson: boolean): Promise<unknown> {
    if (!this.sessionKey) throw new Error('tuya-local(v3.5): not connected');
    const key = this.sessionKey;
    await this.send(cmd, plaintext, key);
    for (let attempt = 0; attempt < 3; attempt++) {
      const frame = await this.awaitFrame();
      const plain = decryptGcm35Frame(key, frame);
      const stripped = stripV35Retcode(plain);
      let body: unknown;
      try {
        body = decodeGcm35Json(stripped);
      } catch (e) {
        if (allowNonJson) return null;
        throw e instanceof Error ? e : new Error(String(e));
      }
      if (body === null) continue; // ack-only frame — keep waiting for the real one
      return body;
    }
    throw new Error('tuya-local(v3.5): no data response after ack frame(s)');
  }

  /** Raw numeric-keyed dps, same shape readStatus() returns for the tuyapi path. */
  async getStatus(): Promise<Record<string, unknown>> {
    const body = await this.requestJson(CMD_DP_QUERY_NEW, Buffer.from('{}', 'utf8'), false);
    if (!body || typeof body !== 'object') {
      throw new Error('tuya-local(v3.5): empty or non-JSON status response');
    }
    const rec = body as Record<string, unknown>;
    const nested = rec.data as Record<string, unknown> | undefined;
    const dps = (rec.dps as Record<string, unknown> | undefined) ?? nested?.dps;
    return (dps as Record<string, unknown> | undefined) ?? {};
  }

  /** `data` is already-translated raw numeric-keyed dps (same shape sendCommands() builds
   *  for the tuyapi path via translateCommands()). */
  async setDps(data: Record<string, unknown>): Promise<void> {
    const envelope = { protocol: 5, t: Math.floor(Date.now() / 1000), data: { dps: data } };
    const plaintext = Buffer.concat([V35_VERSION_HEADER, Buffer.from(JSON.stringify(envelope), 'utf8')]);
    await this.requestJson(CMD_CONTROL_NEW, plaintext, true);
  }
}

const poolV35 = new Map<string, TuyaGcm35Device>();

/** Mirrors getConnection() above (including the synchronous pool-slot claim — see that
 *  function's comment for why the ordering matters) for the native v3.5 client. */
async function getConnectionV35(entry: LocalDeviceEntry): Promise<TuyaGcm35Device> {
  let sess = poolV35.get(entry.id);
  if (!sess) {
    sess = new TuyaGcm35Device(entry.lanIp, entry.localKey);
    poolV35.set(entry.id, sess);
  }
  if (!sess.isConnected()) {
    await withTimeout(sess.connect(), CONNECT_TIMEOUT_MS, 'tuya-local: connect timeout');
  }
  return sess;
}

// ---- Public transport: read / write ---------------------------------------------------

/** Send DP commands to a device over the LAN. `dpForCode` maps cloud codes (e.g.
 *  "switch_1") to local DP indices; defaults to empty, which makes every command
 *  untranslatable and therefore fails closed (safe, just useless without a real map —
 *  see tuya.ts's sendCommandsDual for where the real map comes from). */
export async function sendCommands(
  id: string,
  commands: Array<{ code: string; value: unknown }>,
  dpForCode: Map<string, number> = new Map(),
): Promise<void> {
  const entry = registry.get(id);
  const reason = localAttemptBlockedReason(entry, health.get(id));
  if (reason || !entry) throw new Error(`tuya-local: ${id} — ${reason ?? 'unknown device'}`);
  if (!commands.length) throw new Error(`tuya-local: ${id} — no commands to send`);
  const data = translateCommands(commands, dpForCode);

  try {
    if (pickLocalTransport(entry.version) === 'native-gcm') {
      const sess = await getConnectionV35(entry);
      await withTimeout(sess.setDps(data), RESPONSE_TIMEOUT_MS, 'tuya-local: set timeout');
    } else {
      const dev = await getConnection(entry);
      // tuyapi's own .d.ts types `data` as a narrower `Object` (string|number|boolean|...)
      // than our `value: unknown` command shape — cast at this 3rd-party boundary only;
      // translateCommands() itself stays precisely typed.
      await withTimeout(
        dev.set({ multiple: true, data: data as Record<string, string | number | boolean> }),
        RESPONSE_TIMEOUT_MS,
        'tuya-local: set timeout',
      );
    }
    noteSuccess(id);
  } catch (e) {
    noteFailure(id, e);
    evict(id);
    throw e instanceof Error ? e : new Error(String(e));
  }
}

/** Read every datapoint a device reports, over the LAN. Returns the RAW numeric-keyed dps
 *  (e.g. {"1": true, "20": 3940}) — translate with translateStatus() using a caller-
 *  supplied dp->code map to get cloud-shaped {code, value} pairs. */
export async function readStatus(id: string): Promise<Record<string, unknown>> {
  const entry = registry.get(id);
  const reason = localAttemptBlockedReason(entry, health.get(id));
  if (reason || !entry) throw new Error(`tuya-local: ${id} — ${reason ?? 'unknown device'}`);

  try {
    let dps: Record<string, unknown>;
    if (pickLocalTransport(entry.version) === 'native-gcm') {
      const sess = await getConnectionV35(entry);
      dps = await withTimeout(sess.getStatus(), RESPONSE_TIMEOUT_MS, 'tuya-local: read timeout');
    } else {
      const dev = await getConnection(entry);
      const data = await withTimeout(dev.get({ schema: true }), RESPONSE_TIMEOUT_MS, 'tuya-local: read timeout');
      dps =
        data && typeof data === 'object' && 'dps' in (data as object)
          ? (((data as { dps?: unknown }).dps as Record<string, unknown> | undefined) ?? {})
          : {};
    }
    noteSuccess(id);
    return dps;
  } catch (e) {
    noteFailure(id, e);
    evict(id);
    throw e instanceof Error ? e : new Error(String(e));
  }
}

// ---- UDP discovery (long-lived; keeps lanIp/version fresh) ----------------------------

export interface DiscoveryInfo {
  id: string;
  ip: string;
  version: string;
}

/**
 * Pull the JSON announcement out of a Tuya discovery datagram. Tolerant by design:
 * firmware varies in whether the payload is plaintext (older v3.1 on 6666) or AES-ECB
 * encrypted (v3.3+ on 6667), and in whether a 4-byte return code sits between the 16-byte
 * header and the body. Ported verbatim from the hardware-validated
 * scripts/tuya-lan-discover.mjs. Exported for tests (built from synthetic packets).
 */
export function parseDiscoveryFrame(buf: Buffer): DiscoveryInfo | null {
  // (a) Plaintext JSON somewhere in the frame (older v3.1 broadcasts).
  const open = buf.indexOf(0x7b); // '{'
  const close = buf.lastIndexOf(0x7d); // '}'
  if (open !== -1 && close > open) {
    try {
      return normalizeDiscovery(JSON.parse(buf.subarray(open, close + 1).toString('utf8')));
    } catch {
      /* fall through to the encrypted paths */
    }
  }

  // (b) AES-128-ECB with the static UDP key. Offset 20 covers frames carrying a return
  //     code; offset 16 covers those that don't.
  for (const start of [20, 16]) {
    if (buf.length <= start + 8) continue;
    const body = buf.subarray(start, buf.length - 8);
    if (body.length === 0 || body.length % 16 !== 0) continue;
    try {
      const d = crypto.createDecipheriv('aes-128-ecb', UDP_KEY, null);
      d.setAutoPadding(true);
      const out = Buffer.concat([d.update(body), d.final()]).toString('utf8');
      return normalizeDiscovery(JSON.parse(out));
    } catch {
      /* try the next offset */
    }
  }
  return null;
}

function normalizeDiscovery(info: unknown): DiscoveryInfo | null {
  if (!info || typeof info !== 'object') return null;
  const rec = info as Record<string, unknown>;
  const id = str(rec.gwId) || str(rec.devId);
  if (!id) return null;
  return { id, ip: str(rec.ip), version: str(rec.version) };
}

/** Pure: fold a discovery observation into a registry entry. Returns a NEW entry object
 *  (never mutates its input) plus whether anything actually changed. An empty/unchanged
 *  field in `info` never overwrites a good value already on the entry — e.g. a broadcast
 *  that's missing `version` doesn't blank out a version we already knew. Exported for tests. */
export function mergeDiscoveryInfo(entry: LocalDeviceEntry, info: DiscoveryInfo): { entry: LocalDeviceEntry; changed: boolean } {
  const lanIp = info.ip || entry.lanIp;
  const version = info.version || entry.version;
  const changed = lanIp !== entry.lanIp || version !== entry.version;
  return { entry: changed ? { ...entry, lanIp, version } : entry, changed };
}

let discoveryStarted = false;
const sockets: dgram.Socket[] = [];
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function onDiscovered(info: DiscoveryInfo): void {
  const entry = registry.get(info.id);
  if (!entry) return; // heard a device we never harvested a key for — nothing to do with it
  const { entry: next, changed } = mergeDiscoveryInfo(entry, info);
  if (!changed) return;
  registry.set(info.id, next);
  evict(info.id); // ip/version moved — any pooled socket is now stale
  schedulePersist();
}

// ---- v3.5 (AES-GCM) sighting detection ------------------------------------------------
// v3.5 discovery broadcasts are encrypted end-to-end and start with a different frame
// magic than the v3.1-3.4 frames parseDiscoveryFrame() handles — 0x00006699 vs the legacy
// 0x000055AA. Without GCM support we cannot decrypt the body to learn the device id, but
// recognizing the magic still turns "this broadcast silently failed to parse" (which used
// to be indistinguishable from "no device there at all") into a positive, visible signal:
// something IS alive at this source ip, it's just speaking a version this transport can't
// use yet. Coordinator-verified 2026-08-20 via a live UDP capture.

const V35_MAGIC = 0x00006699;

/** Pure: does this buffer start with the v3.5 discovery frame magic? Exported for tests. */
export function isV35DiscoveryFrame(buf: Buffer): boolean {
  return buf.length >= 4 && buf.readUInt32BE(0) === V35_MAGIC;
}

/** Source ips heard broadcasting a v3.5-shaped frame, and when we last heard one. */
const v35SightingsByIp = new Map<string, number>();

/** Pure: which registry entries (if any) should be tagged version='3.5' because their
 *  lanIp matches a source just seen broadcasting a v3.5-shaped frame. We can't decrypt the
 *  payload to learn the id ourselves, but if some entry's lanIp ALREADY matches this
 *  broadcast's source (e.g. identified by the ops harvest workflow's MAC-based TCP sweep —
 *  see the ops(tuya) commits on this branch), correlating by ip upgrades isLocalCapable()
 *  from "no LAN ip discovered yet" to the more useful, permanent "unsupported-version".
 *  Exported for tests. */
export function correlateV35Sighting(entries: LocalDeviceEntry[], ip: string): LocalDeviceEntry[] {
  return entries.filter((e) => e.lanIp === ip && e.version !== '3.5').map((e) => ({ ...e, version: '3.5' }));
}

function onV35Sighting(ip: string): void {
  if (!ip) return;
  v35SightingsByIp.set(ip, Date.now());
  const updated = correlateV35Sighting([...registry.values()], ip);
  if (!updated.length) return;
  for (const e of updated) registry.set(e.id, e);
  schedulePersist();
}

/** Best-effort, debounced write-back of the live registry to CACHE_FILE, so a restart
 *  starts warm instead of dark until the next broadcast. Never throws — DATA_DIR may not
 *  be writable from this process even when the ops harvest workflow could write it (it
 *  may run as a different user), and that must never take the API down. */
function schedulePersist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const prior = (readJsonFile(CACHE_FILE) as Record<string, unknown>) ?? {};
      const devices = [...registry.values()].map((d) => ({
        id: d.id,
        name: d.name,
        category: d.category,
        ip: d.wanIp,
        localKey: d.localKey,
        lanIp: d.lanIp,
        version: d.version,
        sub: d.sub,
        online: d.online,
        productId: d.productId,
        ...(d.dpMap && Object.keys(d.dpMap).length > 0 ? { dpMap: d.dpMap } : {}),
      }));
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(CACHE_FILE, JSON.stringify({ ...prior, discoveredAt: new Date().toISOString(), devices }, null, 2));
    } catch {
      /* best-effort only — in-memory freshness still works even if the write failed */
    }
  }, 5_000);
  persistTimer.unref?.();
}

/** Start the long-lived UDP discovery listener (ports 6666 + 6667, receive-only). Safe to
 *  call more than once (no-op after the first). Never throws — a bind failure on one or
 *  both ports just means discovery doesn't self-heal; the registry loaded from disk still
 *  works for whatever lanIps it already has. */
export function startDiscoveryListener(): void {
  if (discoveryStarted) return;
  discoveryStarted = true;
  for (const port of [6666, 6667]) {
    let sock: dgram.Socket;
    try {
      sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    } catch {
      continue;
    }
    sock.on('error', () => {
      try {
        sock.close();
      } catch {
        /* already closed */
      }
    });
    sock.on('message', (msg, rinfo) => {
      if (isV35DiscoveryFrame(msg)) {
        onV35Sighting(rinfo.address);
        return;
      }
      const info = parseDiscoveryFrame(msg);
      if (info) onDiscovered(info);
    });
    try {
      sock.bind(port, () => {
        try {
          sock.setBroadcast(true);
        } catch {
          /* not fatal — we only ever receive */
        }
      });
      // Receive-only: this listener must never be the reason the process stays alive. In
      // production the HTTP server holds the event loop open, so unref() changes nothing
      // there; it only means a short-lived process (a test, an ops one-shot) that happened
      // to start discovery can still exit on its own.
      sock.unref?.();
      sockets.push(sock);
    } catch {
      /* port unavailable — degrade silently, receive-only so nothing else depends on it */
    }
  }
}

/** Whether the UDP discovery listener has been started in this process. Read-only; the
 *  only thing that flips it is startDiscoveryListener(). Exists so a test can assert that
 *  merely IMPORTING this module never starts it — see tuya-local-boot.test.ts and docs/53.
 *  (An active-handle check can't answer that: the sockets are unref'd, and unref'd handles
 *  are invisible to process.getActiveResourcesInfo().) */
export function isDiscoveryRunning(): boolean {
  return discoveryStarted;
}

// ---- Boot ------------------------------------------------------------------------------
// Called explicitly from index.ts at startup — NOT as an import side effect. Importing this
// module (which anything touching Tuya, lights, climate or /api/live does, transitively)
// must not open sockets or start loops: that used to keep the event loop alive forever and
// hung seven `node --test` files that never got anywhere near Tuya. See docs/53.
//
// isLocalEnabled() (not a raw env check) so the store's default-ON setting starts discovery
// at boot too — the production mini restarts on every deploy (no env var needed there), so
// this is what actually activates local control without touching the launchd plist.
//
// A later RUNTIME toggle (PUT /api/integrations/tuya/local, i.e. the Settings switch) flips
// isLocalEnabled()'s return value immediately — sendCommands/readStatus re-check it on every
// call, so disabling stops new local attempts right away. Re-enabling on a process that
// booted with discovery already running (the common case: production boots enabled by
// default) just resumes using the listener that's been running the whole time, no gap. The
// one asymmetric case: a process that booted with local OFF (TUYA_LOCAL_ENABLED='0', or the
// store already had localControl:false before this process's first boot) never called
// startDiscoveryListener() here, so re-enabling later via the Settings toggle makes tuya.ts
// start consulting this module again but WITHOUT a live discovery listener — already-known
// devices (lanIp persisted in tuya-local.json from a prior run) still work, but a lanIp that
// moved (DHCP) or a newly-harvested device won't be picked up until the process restarts.
export function bootLocalDiscovery(): void {
  if (isLocalEnabled()) startDiscoveryListener();
}

/** Stop the discovery listener and release its sockets (tests / graceful shutdown). */
export function stopDiscoveryListener(): void {
  for (const s of sockets.splice(0)) {
    try {
      s.close();
    } catch {
      /* already closed */
    }
  }
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  discoveryStarted = false;
}

// ---- Diagnostics (read-only) ------------------------------------------------------------

export interface LocalDiagnosticsDevice {
  id: string;
  name: string;
  localCapable: boolean;
  /** Why it's not capable (null when it is) — e.g. 'unsupported-version' for the fleet's
   *  v3.5 breakers, so it's obvious AT A GLANCE why a device is still cloud-only instead of
   *  it looking like an unexplained "silent"/dead device. */
  reason: LocalBlockReason | null;
  lanIp: string;
  version: string;
  /** Which internal client handles this device locally — null when it is not locally
   *  capable at all (see `reason`); 'tuyapi' for 3.1-3.4, 'native-gcm' for 3.5. */
  transport: 'tuyapi' | 'native-gcm' | null;
  lastOk: string | null;
  failures: number;
  /** Whether a cloud/local dp-map has been captured + persisted for this device (docs/49
   *  Change 1/4) — the second hidden cloud dependency a blackout used to hit. True here
   *  means getStatus/sendCommands for this device need zero cloud calls once it's also
   *  `localCapable`. */
  dpMapCaptured: boolean;
}

export interface LocalDiagnostics {
  enabled: boolean;
  loadedAt: string | null;
  totals: {
    devices: number;
    capable: number;
    healthy: number;
    unsupportedVersion: number;
    /** How many registry devices have a persisted dp-map — what Settings → Tuya's
     *  "dp-maps captured: N / M devices" line reads (docs/49 Change 4). */
    dpMapsCaptured: number;
  };
  /** Source ips heard broadcasting a v3.5-shaped (AES-GCM) discovery frame that don't
   *  (yet) match any known device's lanIp — i.e. "something is alive here" even though the
   *  payload can't be decrypted to learn which device it is. */
  v35SightingsUncorrelated: string[];
  devices: LocalDiagnosticsDevice[];
}

/** GET /api/integrations/tuya/local — per-device local-control reachability + health, for
 *  the Settings/Connections diagnostics surface. Never includes `localKey`. */
export function getDiagnostics(): LocalDiagnostics {
  const now = Date.now();
  const devices: LocalDiagnosticsDevice[] = [...registry.values()]
    .map((d) => {
      const h = health.get(d.id);
      const capable = computeLocalCapable(d);
      return {
        id: d.id,
        name: d.name,
        localCapable: capable,
        reason: capabilityBlockReason(d),
        lanIp: d.lanIp,
        version: d.version,
        transport: capable ? pickLocalTransport(d.version) : null,
        lastOk: h?.lastOkAt ? new Date(h.lastOkAt).toISOString() : null,
        failures: h?.consecutiveFailures ?? 0,
        dpMapCaptured: !!(d.dpMap && Object.keys(d.dpMap).length > 0),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const capable = devices.filter((d) => d.localCapable).length;
  const healthy = [...registry.values()].filter(
    (d) => computeLocalCapable(d) && computeCanAttempt(health.get(d.id), now),
  ).length;
  const unsupportedVersion = devices.filter((d) => d.reason === 'unsupported-version').length;
  const dpMapsCaptured = devices.filter((d) => d.dpMapCaptured).length;
  const knownLanIps = new Set([...registry.values()].map((d) => d.lanIp).filter(Boolean));
  const v35SightingsUncorrelated = [...v35SightingsByIp.keys()].filter((ip) => !knownLanIps.has(ip));

  return {
    enabled: isLocalEnabled(),
    loadedAt: registryLoadedAt ? new Date(registryLoadedAt).toISOString() : null,
    totals: { devices: devices.length, capable, healthy, unsupportedVersion, dpMapsCaptured },
    v35SightingsUncorrelated,
    devices,
  };
}

reloadRegistry();
