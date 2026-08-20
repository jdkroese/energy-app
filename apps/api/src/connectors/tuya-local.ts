// Tuya LOCAL (LAN) control — Phase 2 (docs/44). A SELF-CONTAINED transport that talks
// directly to Tuya Wi-Fi devices over TCP 6668 on the LAN, so status reads and commands
// no longer have to spend cloud API quota (the free tier's ~54k calls/month wall — see
// docs/44 for the full story). This module never imports `./tuya` (the cloud connector);
// `./tuya` imports THIS module instead, one direction only, to avoid a circular import
// that could break the esbuild CJS bundle.
//
// Feature-flagged OFF by default: TUYA_LOCAL_ENABLED=1 to enable. With the flag off this
// module still loads (registry read from disk — cheap, synchronous, tolerant of a missing
// file) but NEVER opens a socket and is never consulted by `./tuya` — behaviour is
// byte-for-byte what it was before this file existed.
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

import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import path from 'node:path';
import TuyaDevice from 'tuyapi';

const DATA_DIR = process.env.DATA_DIR || '/Users/joris/sites/energy/.data';
const CACHE_FILE = path.join(DATA_DIR, 'tuya-local.json');

// The static key every Tuya device uses to encrypt its UDP discovery broadcast (NOT the
// per-device local_key). Recomputed here rather than reaching into tuyapi's internals
// (`tuyapi/lib/config`) so this module stays self-contained and immune to their internal
// layout changing across patch releases. Hardware-validated in scripts/tuya-lan-discover.mjs.
const UDP_KEY = crypto.createHash('md5').update('yGAdlopoPVldABfn').digest();

const LOCAL_ENABLED = process.env.TUYA_LOCAL_ENABLED === '1';

/** Whether local (LAN) control is switched on at all. Everything else in this module is
 *  inert when this is false — no socket is opened, and tuya.ts never calls in here. */
export function isLocalEnabled(): boolean {
  return LOCAL_ENABLED;
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

/** Pure: does this registry entry describe a device that is, IN PRINCIPLE, locally
 *  reachable (key + LAN ip known, not a gateway sub-device)? Exported for tests. */
export function computeLocalCapable(entry: LocalDeviceEntry | undefined): boolean {
  return !!entry && !entry.sub && !!entry.localKey && entry.localKey.length === 16 && !!entry.lanIp;
}

/** Whether device `id` is locally reachable in principle (static — ignores current
 *  cool-off state; see computeCanAttempt for that). */
export function isLocalCapable(id: string): boolean {
  return computeLocalCapable(registry.get(id));
}

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
  if (entry.sub) return 'gateway sub-device — never LAN-reachable';
  if (!entry.localKey || entry.localKey.length !== 16) return 'no (valid) local_key';
  if (!entry.lanIp) return 'no LAN ip discovered yet';
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

/** Drop a pooled connection (e.g. after any error) so the next attempt starts fresh. */
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
    const dev = await getConnection(entry);
    // tuyapi's own .d.ts types `data` as a narrower `Object` (string|number|boolean|...)
    // than our `value: unknown` command shape — cast at this 3rd-party boundary only;
    // translateCommands() itself stays precisely typed.
    await withTimeout(
      dev.set({ multiple: true, data: data as Record<string, string | number | boolean> }),
      RESPONSE_TIMEOUT_MS,
      'tuya-local: set timeout',
    );
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
    const dev = await getConnection(entry);
    const data = await withTimeout(dev.get({ schema: true }), RESPONSE_TIMEOUT_MS, 'tuya-local: read timeout');
    noteSuccess(id);
    const dps =
      data && typeof data === 'object' && 'dps' in (data as object)
        ? (((data as { dps?: unknown }).dps as Record<string, unknown> | undefined) ?? {})
        : {};
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
    sock.on('message', (msg) => {
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
      sockets.push(sock);
    } catch {
      /* port unavailable — degrade silently, receive-only so nothing else depends on it */
    }
  }
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
  lanIp: string;
  version: string;
  lastOk: string | null;
  failures: number;
}

export interface LocalDiagnostics {
  enabled: boolean;
  loadedAt: string | null;
  totals: { devices: number; capable: number; healthy: number };
  devices: LocalDiagnosticsDevice[];
}

/** GET /api/integrations/tuya/local — per-device local-control reachability + health, for
 *  the Settings/Connections diagnostics surface. Never includes `localKey`. */
export function getDiagnostics(): LocalDiagnostics {
  const now = Date.now();
  const devices: LocalDiagnosticsDevice[] = [...registry.values()]
    .map((d) => {
      const h = health.get(d.id);
      return {
        id: d.id,
        name: d.name,
        localCapable: computeLocalCapable(d),
        lanIp: d.lanIp,
        version: d.version,
        lastOk: h?.lastOkAt ? new Date(h.lastOkAt).toISOString() : null,
        failures: h?.consecutiveFailures ?? 0,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const capable = devices.filter((d) => d.localCapable).length;
  const healthy = [...registry.values()].filter(
    (d) => computeLocalCapable(d) && computeCanAttempt(health.get(d.id), now),
  ).length;

  return {
    enabled: isLocalEnabled(),
    loadedAt: registryLoadedAt ? new Date(registryLoadedAt).toISOString() : null,
    totals: { devices: devices.length, capable, healthy },
    devices,
  };
}

// ---- Boot ------------------------------------------------------------------------------

reloadRegistry();
if (LOCAL_ENABLED) startDiscoveryListener();
