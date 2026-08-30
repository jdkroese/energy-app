// Device-onboarding HTTP surface (Tuya). Phase 1 was READ + TRIAGE; Phase 2 makes
// discovered devices CONTROLLABLE and adds the SET-UP flow:
//   • GET  /api/devices/discovered  — the inbox (discovered − ignored − configured)
//   • POST /api/devices/:id/ignore | keep — triage flags (Phase 1)
//   • POST /api/devices/:id/setup   — graduate a device into a type group
//   • POST /api/devices/:id/unsetup — return it to the inbox (re-classify)
//   • GET  /api/devices/configured  — set-up devices + (override-applied) caps + live values
//   • GET/POST /api/devices/custom-types — the user-minted custom type registry
//   • POST /api/devices/:id/command — generic capability write (see tuya-generic)
//
// The generic command path reuses the lights writer's scaling math via tuya-generic;
// safety-critical actions (locks/sirens/gates) are confirmed in the UI before firing.

import * as tuya from '../connectors/tuya';
import { isLight } from '../connectors/tuya-lights';
import { isBlind } from '../connectors/tuya-blinds';
import {
  toDiscovered,
  deriveCapabilities,
  applyOverrides,
  type DiscoveredDevice,
  type Capability,
} from '../connectors/tuya-inference';
import { buildGenericCommands, readLiveValue, type GenericCommandInput } from '../connectors/tuya-generic';
import { resolveConfiguredLightCaps } from '../connectors/tuya-configured-lights';
import type { TuyaDevice, TuyaSpec } from '../connectors/tuya';
import * as store from '../store';
import { resolveRoomId } from '../rooms';
import { ensureSceneController, removeSceneController } from './scene-controllers';

/** Resolve the first-class Rooms fields (assigned id + name) for a device id. */
function roomFor(id: string): { roomId: string | null; roomName: string | null } {
  const roomId = resolveRoomId(id);
  return { roomId, roomName: roomId ? store.get().rooms[roomId]?.name ?? null : null };
}

function badInput(msg: string): Error & { code: string } {
  const e = new Error(msg) as Error & { code: string };
  e.code = 'BAD_INPUT';
  return e;
}

/** True for a device a shipped category screen already surfaces (lights/blinds). */
function isAlreadyHandled(d: TuyaDevice): boolean {
  return isLight(d) || isBlind(d);
}

/** Best-effort spec fetch (cached 1h in the connector); null on failure. */
async function specFor(id: string): Promise<TuyaSpec | null> {
  try {
    return await tuya.getSpecifications(id);
  } catch {
    return null;
  }
}

/**
 * GET /api/devices/discovered — the onboarding INBOX: every paired Tuya device that is
 * (a) NOT already surfaced by a shipped connector, (b) NOT ignored, and (c) NOT yet
 * configured (set-up devices have graduated into their group). Enriched with the inferred
 * proposedType / capabilities / confidence / roomGuess. Ignored devices are returned
 * separately for the collapsible "Ignored" list.
 */
export async function getDiscovered(): Promise<unknown> {
  const connected = tuya.isConfigured();
  if (!connected) {
    return { ts: new Date().toISOString(), connected: false, fleetError: null, devices: [], ignored: [] };
  }
  const onboarding = store.get().deviceOnboarding;
  const ignoredIds = new Set(onboarding.ignored);
  const configuredIds = new Set(Object.keys(onboarding.configured));
  let all: TuyaDevice[];
  try {
    all = await tuya.getDevices();
  } catch (e) {
    return { ts: new Date().toISOString(), connected: true, fleetError: (e as Error).message, devices: [], ignored: [] };
  }

  // Candidates = paired devices not already shown by a shipped screen, AND not configured
  // (a set-up device has graduated; it lives in /api/devices/configured now).
  const candidates = all.filter((d) => !isAlreadyHandled(d) && !configuredIds.has(d.id));

  const enriched: DiscoveredDevice[] = await Promise.all(
    candidates.map(async (d) => toDiscovered(d, await specFor(d.id))),
  );

  const devices = enriched.filter((d) => !ignoredIds.has(d.id));
  const ignored = enriched.filter((d) => ignoredIds.has(d.id));

  return { ts: new Date().toISOString(), connected: true, fleetError: null, devices, ignored };
}

/** POST /api/devices/:id/ignore — hide a discovered device from the active inbox. */
export function ignoreDiscovered(id: string): unknown {
  const deviceId = String(id ?? '').trim();
  if (!deviceId) throw badInput('device id required');
  store.update((s) => {
    if (!s.deviceOnboarding.ignored.includes(deviceId)) s.deviceOnboarding.ignored.push(deviceId);
  });
  return { ts: new Date().toISOString(), id: deviceId, ignored: true };
}

/** POST /api/devices/:id/keep — un-ignore a previously ignored device. */
export function keepDiscovered(id: string): unknown {
  const deviceId = String(id ?? '').trim();
  if (!deviceId) throw badInput('device id required');
  store.update((s) => {
    s.deviceOnboarding.ignored = s.deviceOnboarding.ignored.filter((x) => x !== deviceId);
  });
  return { ts: new Date().toISOString(), id: deviceId, ignored: false };
}

// ---- Set-up / re-classify ---------------------------------------------------

function sanitizeOverrides(raw: unknown): store.CapabilityOverride[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const KINDS = new Set(['switch', 'range', 'enum', 'action', 'color', 'measure', 'status']);
  const out: store.CapabilityOverride[] = [];
  for (const r of raw) {
    const o = (r ?? {}) as Record<string, unknown>;
    if (typeof o.dp !== 'string' || !o.dp) continue;
    const ov: store.CapabilityOverride = { dp: o.dp };
    if (typeof o.kind === 'string' && KINDS.has(o.kind)) ov.kind = o.kind as store.CapabilityOverride['kind'];
    if (typeof o.label === 'string' && o.label.trim()) ov.label = o.label.trim();
    if (typeof o.hidden === 'boolean') ov.hidden = o.hidden;
    if (typeof o.readOnly === 'boolean') ov.readOnly = o.readOnly;
    out.push(ov);
  }
  return out.length ? out : undefined;
}

/**
 * POST /api/devices/:id/setup — graduate a discovered device into its type group.
 * Body: { typeId, name, capOverrides? }. `typeId` is a built-in DeviceType key or a
 * custom type id; `name` is the assigned display name; `capOverrides` carry the Advanced
 * DP-remap edits. No auto-add anywhere — a device only becomes controllable after this.
 */
export async function setupDevice(id: string, body: unknown): Promise<unknown> {
  const deviceId = String(id ?? '').trim();
  if (!deviceId) throw badInput('device id required');
  const b = (body ?? {}) as { typeId?: unknown; name?: unknown; capOverrides?: unknown };
  const typeId = String(b.typeId ?? '').trim();
  const name = String(b.name ?? '').trim();
  if (!typeId) throw badInput('typeId required');
  if (!name) throw badInput('name required');

  // Validate the device exists in the fleet (don't set up a phantom id).
  if (tuya.isConfigured()) {
    const all = await tuya.getDevices();
    if (!all.some((d) => d.id === deviceId)) throw badInput(`device ${deviceId} not found`);
  }

  const configured: store.ConfiguredDevice = {
    typeId,
    name,
    setupAt: new Date().toISOString(),
    ...(sanitizeOverrides(b.capOverrides) ? { capOverrides: sanitizeOverrides(b.capOverrides) } : {}),
  };
  store.update((s) => {
    s.deviceOnboarding.configured[deviceId] = configured;
    // A set-up device is no longer "ignored" (the two states are mutually exclusive).
    s.deviceOnboarding.ignored = s.deviceOnboarding.ignored.filter((x) => x !== deviceId);
  });
  // A scene switch (typeId 'controller') gets a default binding entry (4 empty buttons,
  // enabled) so the coordinator + binding UI have something to work with. Re-classifying
  // AWAY from controller drops the stale bindings.
  if (typeId === 'controller') ensureSceneController(deviceId);
  else removeSceneController(deviceId);
  return { ts: new Date().toISOString(), id: deviceId, configured };
}

/** PUT /api/devices/:id/name — rename a configured (set-up) device in place. */
export function renameConfiguredDevice(id: string, body: unknown): unknown {
  const deviceId = String(id ?? '').trim();
  if (!deviceId) throw badInput('device id required');
  const name = String(((body ?? {}) as { name?: unknown }).name ?? '').trim();
  if (!name) throw badInput('name required');
  let found = false;
  store.update((s) => {
    const c = s.deviceOnboarding.configured[deviceId];
    if (c) { c.name = name; found = true; }
  });
  if (!found) throw badInput(`device ${deviceId} is not set up`);
  return { ts: new Date().toISOString(), id: deviceId, name };
}

/** POST /api/devices/:id/unsetup — return a configured device to the inbox (re-classify). */
export function unsetupDevice(id: string): unknown {
  const deviceId = String(id ?? '').trim();
  if (!deviceId) throw badInput('device id required');
  store.update((s) => {
    delete s.deviceOnboarding.configured[deviceId];
  });
  // Returning a controller to the inbox drops its scene bindings (idempotent for others).
  removeSceneController(deviceId);
  return { ts: new Date().toISOString(), id: deviceId, configured: false };
}

// ---- Custom type registry ---------------------------------------------------

export function listCustomTypes(): unknown {
  return { ts: new Date().toISOString(), customDeviceTypes: store.get().deviceOnboarding.customDeviceTypes };
}

/** POST /api/devices/custom-types — mint a custom device type { label, icon }. */
export function createCustomType(body: unknown): unknown {
  const b = (body ?? {}) as { label?: unknown; icon?: unknown };
  const label = String(b.label ?? '').trim();
  const icon = String(b.icon ?? '').trim() || 'plug';
  if (!label) throw badInput('label required');
  const type: store.CustomDeviceType = {
    id: `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    label,
    icon,
  };
  store.update((s) => {
    s.deviceOnboarding.customDeviceTypes.push(type);
  });
  return { ts: new Date().toISOString(), customDeviceType: type };
}

// ---- Configured devices (controllable, live) --------------------------------

export interface ConfiguredDeviceView {
  id: string;
  name: string;
  typeId: string;
  category: string;
  online: boolean;
  capabilities: Capability[];
  /** dp → current app-facing value (override-applied scaling). */
  values: Record<string, unknown>;
  roomGuess: string | null;
  /** First-class Rooms model: assigned room id (null = Unassigned) + resolved name. */
  roomId: string | null;
  roomName: string | null;
  setupAt: string;
  /** EV (car) breaker: "Solar / P3 charging only" opt-in (docs/33). */
  solarP3Only: boolean;
  /** EV breaker: auto-learned charger draw (W), or null if none learned yet. */
  learnedDrawW: number | null;
  /** EV breaker: the rule's live state — what it's doing right now. null when not opted in. */
  evState: { reason: 'surplus' | 'p3' | 'waiting' | 'off'; ruleOn: boolean; reservedW: number } | null;
}

/** EV per-breaker view fields from deviceSettings + the rule's runtime state. */
function evViewFor(id: string): Pick<ConfiguredDeviceView, 'solarP3Only' | 'learnedDrawW' | 'evState'> {
  const ds = store.get().deviceSettings[id];
  const solarP3Only = ds?.solarP3Only === true;
  const learnedDrawW = typeof ds?.learnedDrawW === 'number' ? ds.learnedDrawW : null;
  if (!solarP3Only) return { solarP3Only: false, learnedDrawW, evState: null };
  const rt = store.get().devices.evState[id];
  return {
    solarP3Only: true,
    learnedDrawW,
    evState: rt
      ? { reason: rt.reason, ruleOn: rt.ruleOn, reservedW: rt.reservedW }
      : { reason: 'off', ruleOn: false, reservedW: 0 },
  };
}

/**
 * GET /api/devices/configured — every set-up device with its assigned typeId/name, its
 * (override-applied) capabilities, and LIVE current values read from the device status so
 * the UI can render current state. Excludes ignored and not-yet-configured devices.
 */
export async function getConfigured(): Promise<unknown> {
  const connected = tuya.isConfigured();
  const onboarding = store.get().deviceOnboarding;
  if (!connected) {
    return { ts: new Date().toISOString(), connected: false, fleetError: null, devices: [], customDeviceTypes: onboarding.customDeviceTypes };
  }
  let all: TuyaDevice[];
  try {
    all = await tuya.getDevices();
  } catch (e) {
    return { ts: new Date().toISOString(), connected: true, fleetError: (e as Error).message, devices: [], customDeviceTypes: onboarding.customDeviceTypes };
  }
  const byId = new Map(all.map((d) => [d.id, d]));

  // docs/51 Change 2: `all` already excludes sub-devices/the gateway, but a configured id
  // missing from it falls back to a direct per-device read below (self-heal for a device
  // whose cloud link dropped) — that direct read is NOT filtered, so a scene switch set up
  // BEFORE this change would otherwise reappear here through that back door. Drop it first.
  const configuredEntries = Object.entries(onboarding.configured).filter(([id]) => !tuya.isKnownExcludedId(id));

  const devices: ConfiguredDeviceView[] = await Promise.all(
    configuredEntries.map(async ([id, cfg]) => {
      // Prefer the bulk fleet entry; if this configured device is missing from it (e.g. its
      // cloud link dropped so it fell out of /associated-users/devices), recover it with a
      // direct per-device read so it still renders with its real caps + last-known state.
      const d = byId.get(id) ?? (await tuya.getDeviceDirect(id));
      if (!d) {
        // Truly not reported by the fleet OR the direct read (removed from the cloud project).
        return { id, name: cfg.name, typeId: cfg.typeId, category: '', online: false, capabilities: [], values: {}, roomGuess: null, ...roomFor(id), setupAt: cfg.setupAt, ...evViewFor(id) };
      }
      const spec = await specFor(id);
      const caps = applyOverrides(deriveCapabilities(d, spec), cfg.capOverrides);
      const values: Record<string, unknown> = {};
      for (const cap of caps) {
        const v = readLiveValue(d, cap, spec);
        if (v !== undefined) values[cap.dp] = v;
      }
      return {
        id, name: cfg.name, typeId: cfg.typeId, category: d.category, online: d.online,
        capabilities: caps, values, roomGuess: toDiscovered(d, spec).roomGuess, ...roomFor(id), setupAt: cfg.setupAt, ...evViewFor(id),
      };
    }),
  );

  return { ts: new Date().toISOString(), connected: true, fleetError: null, devices, customDeviceTypes: onboarding.customDeviceTypes };
}

// ---- Diagnostics ------------------------------------------------------------

export interface DeviceDiagnostics {
  id: string;
  name: string;
  category: string;
  productName: string | null;
  online: boolean;
  /** LAN ip + hardware MAC (best-effort; null when Tuya doesn't return them). */
  ip: string | null;
  mac: string | null;
  /** The device's assigned typeId, when it's a set-up device. */
  typeId: string | null;
  /** For typeId 'lighting': the DP the on/off toggle + scenes/schedules actually drive. */
  primarySwitchDp: string | null;
  /** Every datapoint the device exposes — code, kind, current value, writable flag. */
  dps: Array<{ dp: string; kind: Capability['kind']; label: string; readOnly: boolean; value: unknown }>;
}

/**
 * GET /api/devices/:id/diagnostics — identity + network + the full datapoint table for
 * a Tuya device, for debugging control issues (which DP the on/off drives, what the
 * device actually reports). On-demand (not polled); ip/mac are best-effort.
 */
export async function getDeviceDiagnostics(id: string): Promise<unknown> {
  const deviceId = String(id ?? '').trim();
  if (!deviceId) throw badInput('device id required');
  if (!tuya.isConfigured()) return { ts: new Date().toISOString(), connected: false, device: null };

  let all: TuyaDevice[];
  try {
    all = await tuya.getDevices();
  } catch (e) {
    return { ts: new Date().toISOString(), connected: true, fleetError: (e as Error).message, device: null };
  }
  // Fall back to a direct per-device read if it's missing from the bulk fleet list. `viaDirect`
  // tells the UI the device was recovered this way (i.e. its cloud link likely dropped); a null
  // device after the fallback means it's genuinely de-associated from the cloud project.
  const inFleet = all.find((x) => x.id === deviceId);
  const d = inFleet ?? (await tuya.getDeviceDirect(deviceId));
  if (!d) return { ts: new Date().toISOString(), connected: true, fleetError: null, viaDirect: false, device: null };

  const spec = await specFor(deviceId);
  const cfg = store.get().deviceOnboarding.configured[deviceId];
  const caps = applyOverrides(deriveCapabilities(d, spec), cfg?.capOverrides);
  const statusMap = new Map(d.status.map((s) => [s.code, s.value]));

  // Best-effort network identity — never let a missing field fail the call.
  let ip: string | null = null;
  let mac: string | null = null;
  try { ip = (await tuya.getDeviceDetail(deviceId)).ip ?? null; } catch { /* ignore */ }
  try { mac = (await tuya.getFactoryInfos([deviceId]))[0]?.mac ?? null; } catch { /* ignore */ }

  const device: DeviceDiagnostics = {
    id: d.id,
    name: cfg?.name ?? d.name,
    category: d.category,
    productName: d.productName ?? null,
    online: d.online,
    ip,
    mac,
    typeId: cfg?.typeId ?? null,
    primarySwitchDp:
      cfg?.typeId === 'lighting' ? resolveConfiguredLightCaps(d, cfg, spec).powerDp?.dp ?? null : null,
    dps: caps.map((c) => ({
      dp: c.dp,
      kind: c.kind,
      label: c.label,
      readOnly: c.readOnly,
      value: statusMap.get(c.dp) ?? null,
    })),
  };
  return { ts: new Date().toISOString(), connected: true, fleetError: null, viaDirect: !inFleet, device };
}

/**
 * POST /api/devices/:id/diagnostics/test — fire a single DP command through the chosen
 * Tuya command API (v1 legacy commands / v2 thing-model) and return the RAW response,
 * so we can see which API a stubborn device actually accepts. Admin-gated (it actuates).
 * Body: { dp, value, api }.
 */
export async function testDeviceCommand(id: string, body: unknown): Promise<unknown> {
  const deviceId = String(id ?? '').trim();
  if (!deviceId) throw badInput('device id required');
  const b = (body ?? {}) as { dp?: unknown; value?: unknown; api?: unknown };
  const dp = String(b.dp ?? '').trim();
  if (!dp) throw badInput('dp required');
  const api = b.api === 'v2' ? 'v2' : b.api === 'iot03' ? 'iot03' : 'v1';
  if (!tuya.isConfigured()) throw badInput('Tuya not connected');
  const probe = await tuya.probeCommand(deviceId, dp, b.value, api);
  return { ts: new Date().toISOString(), id: deviceId, dp, value: b.value, probe };
}

// ---- Generic capability command ---------------------------------------------

/**
 * POST /api/devices/:id/command (generic Tuya body { dp, kind, value }) — translate to a
 * Tuya DP command with the correct inverse scaling and issue it. Validates the dp belongs
 * to the device and is NOT read-only. Used by BOTH the setup-sheet Test action (device may
 * not be configured yet) and the controllable group/detail views (configured), so it
 * resolves capabilities from the override set when one exists, else raw inference.
 */
export async function commandGeneric(id: string, input: GenericCommandInput): Promise<unknown> {
  const deviceId = String(id ?? '').trim();
  if (!deviceId) throw badInput('device id required');
  if (!input || typeof input.dp !== 'string' || !input.dp) throw badInput('dp required');
  if (!input.kind) throw badInput('kind required');
  if (!tuya.isConfigured()) throw badInput('Tuya not connected');

  const all = await tuya.getDevices();
  const d = all.find((x) => x.id === deviceId);
  if (!d) throw badInput(`device ${deviceId} not found`);

  const spec = await specFor(deviceId);
  const overrides = store.get().deviceOnboarding.configured[deviceId]?.capOverrides;
  const caps = applyOverrides(deriveCapabilities(d, spec), overrides);
  const cap = caps.find((c) => c.dp === input.dp);
  if (!cap) throw badInput(`device ${deviceId} has no datapoint ${input.dp}`);
  if (cap.readOnly || cap.kind === 'measure' || cap.kind === 'status') {
    throw badInput(`datapoint ${input.dp} is read-only`);
  }

  const commands = buildGenericCommands(d, cap, input, spec); // may throw BAD_INPUT
  // Onboarded plugs/switches vary in which Tuya command API actuates them (legacy v1
  // vs v2 thing-model) — issue both (idempotent; succeeds if either is accepted).
  const sent = await tuya.sendCommandsDual(deviceId, commands);
  tuya.invalidateFleet();
  return { ts: new Date().toISOString(), ok: true, id: deviceId, commands, sent };
}
