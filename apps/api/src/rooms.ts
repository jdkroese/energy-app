// Rooms model — a first-class, cross-cutting location concept that spans EVERY device
// type (climate AC, underfloor heating, Tuya lights, blinds, generic onboarded Tuya
// devices, and any future type). Location was previously fragmented: climate merged a
// `zone`/name into a "room" string, lights/blinds defaulted `room` to the device name,
// and generic devices had only a name-parsed `roomGuess`. This module unifies all that
// into one model: a `rooms` map plus a per-device `deviceSettings[id].roomId`.
//
// Responsibilities:
//   • name normalization + the seed-dedupe rule (collapse "Living room" from a light
//     and from an AC into ONE room);
//   • device enumeration across all connected types with each device's raw location
//     (for the seed) and its kind (for the room-level All-off scoping);
//   • the idempotent auto-seed/pre-assign migration (runs once, guarded by roomsSeeded).

import * as intesis from './connectors/intesis';
import * as airzone from './connectors/airzone';
import * as panasonic from './connectors/panasonic';
import * as rainbird from './connectors/rainbird';
import type { ClimateUnit } from './connectors/intesis';
import * as tuya from './connectors/tuya';
import { isLight, normalizeLight } from './connectors/tuya-lights';
import { isBlind, normalizeBlind } from './connectors/tuya-blinds';
import { guessRoom } from './connectors/tuya-inference';
import * as store from './store';
import type { Room } from './store';

/** The coarse kind of a device, for the room-level All-off scoping. `generic` carries
 *  its capability set so the all-off can find an off/power switch + skip sensitive ones. */
export type RoomDeviceKind = 'climate' | 'light' | 'blind' | 'generic' | 'irrigation';

export interface RoomDevice {
  id: string;
  /** Display name (override-applied where available). */
  name: string;
  kind: RoomDeviceKind;
  /** The device's RAW reported location (pre-normalization), used by the seed. For climate
   *  this is the merged zone/name with the "AC Unit -"/"Heating -" prefix already stripped. */
  rawLocation: string;
  /** Currently powered on? (best-effort; used so All-off only acts on what's on). */
  power: boolean;
  /** Generic devices only: their resolved capability set (for the All-off switch lookup). */
  capabilities?: import('./connectors/tuya-inference').Capability[];
}

// ---- Name normalization + seed dedupe ---------------------------------------

const CLIMATE_PREFIXES = ['AC Unit -', 'Heating -'];

/** Strip the display-only "AC Unit -"/"Heating -" climate prefix from a location name. */
export function stripClimatePrefix(name: string): string {
  let out = name.trim();
  for (const p of CLIMATE_PREFIXES) {
    if (out.startsWith(p)) out = out.slice(p.length).trim();
  }
  return out;
}

/** Canonical key for de-duping room names: trimmed, collapsed whitespace, lowercased,
 *  climate prefix stripped. Two device types reporting "Living room" → the SAME key. */
export function roomKey(name: string): string {
  return stripClimatePrefix(name).replace(/\s+/g, ' ').trim().toLowerCase();
}

/** A friendly display form of a seeded room name: prefix stripped, whitespace tidied,
 *  first letter capitalized. (roomGuess words like "living" → "Living".) */
export function prettyRoomName(name: string): string {
  const s = stripClimatePrefix(name).replace(/\s+/g, ' ').trim();
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---- Device enumeration across all types ------------------------------------

/** Best-effort device spec (cached in the connector); null on failure. */
async function specFor(id: string): Promise<import('./connectors/tuya').TuyaSpec | null> {
  try {
    return await tuya.getSpecifications(id);
  } catch {
    return null;
  }
}

/** The merged "room" a climate unit reports — the same source mergeView() uses, minus the
 *  display prefix: an explicit deviceSettings.room, else the unit's zone, else its name. */
function climateRawLocation(u: ClimateUnit, room?: string): string {
  return stripClimatePrefix(room ?? u.zone ?? u.name);
}

/**
 * Enumerate EVERY device across all connected types with its raw location + kind, soft-
 * failing per connector so one being unreachable doesn't blank the rest. Used by both the
 * seed (needs each device's raw location) and the room-level All-off (needs each device's
 * kind + capabilities). Generic (set-up) devices carry their resolved capabilities.
 */
export async function enumerateDevices(): Promise<RoomDevice[]> {
  const settings = store.get().deviceSettings;
  const out: RoomDevice[] = [];

  // Climate (Intesis AC + Airzone underfloor + Panasonic), per-connector soft-fail.
  const climateConnectors = [intesis, airzone, panasonic];
  for (const c of climateConnectors) {
    if (!c.isConfigured()) continue;
    try {
      for (const u of await c.getFleet()) {
        out.push({
          id: u.id,
          name: u.name,
          kind: 'climate',
          rawLocation: climateRawLocation(u, settings[u.id]?.room),
          power: u.power === true,
        });
      }
    } catch {
      /* connector unreachable — skip its fleet */
    }
  }

  // Irrigation (Rain Bird) zones — soft-fail so an unreachable controller doesn't
  // blank the rest. Each zone seeds/assigns a room like any other device; its raw
  // location falls back to the zone name (no inherent room) so the seed leaves it
  // Unassigned until the owner places it.
  if (rainbird.isConfigured()) {
    try {
      for (const z of await rainbird.getZones()) {
        out.push({
          id: z.id,
          name: settings[z.id]?.name ?? z.name,
          kind: 'irrigation',
          rawLocation: settings[z.id]?.room ?? '',
          power: z.active,
        });
      }
    } catch {
      /* controller unreachable — skip its zones */
    }
  }

  // Tuya fleet (lights / blinds / generic configured). One getDevices() call.
  if (tuya.isConfigured()) {
    try {
      const all = await tuya.getDevices();
      const configured = store.get().deviceOnboarding.configured;
      const { deriveCapabilities, applyOverrides } = await import('./connectors/tuya-inference');
      for (const d of all) {
        if (isLight(d)) {
          const u = normalizeLight(d, settings[d.id]?.name);
          out.push({ id: d.id, name: u.name, kind: 'light', rawLocation: settings[d.id]?.room ?? d.name, power: u.power === true });
        } else if (isBlind(d)) {
          const u = normalizeBlind(d, { room: settings[d.id]?.room, invert: settings[d.id]?.invertPosition ?? false });
          out.push({ id: d.id, name: d.name, kind: 'blind', rawLocation: settings[d.id]?.room ?? u.room ?? d.name, power: (u.positionPct ?? 0) > 2 });
        }
      }
      // Configured (set-up) generic devices — by their assigned typeId. 'lighting' devices
      // are surfaced as lights above when native; otherwise they live here. We classify a
      // configured device as a light when typeId==='lighting', else generic.
      for (const [id, cfg] of Object.entries(configured)) {
        if (out.some((x) => x.id === id)) continue; // already enumerated (native light/blind)
        const d = all.find((x) => x.id === id);
        if (!d) continue;
        const spec = await specFor(id);
        const caps = applyOverrides(deriveCapabilities(d, spec), cfg.capOverrides);
        const kind: RoomDeviceKind = cfg.typeId === 'lighting' ? 'light' : 'generic';
        // power: best-effort from a switch DP's live value.
        const switchCap = caps.find((c) => c.kind === 'switch' && !c.readOnly);
        const live = switchCap ? d.status.find((s) => s.code === switchCap.dp)?.value : undefined;
        out.push({
          id,
          name: cfg.name,
          kind,
          rawLocation: settings[id]?.room ?? guessRoom(cfg.name) ?? guessRoom(d.name) ?? d.name,
          power: live === true,
          capabilities: caps,
        });
      }
    } catch {
      /* Tuya unreachable — skip */
    }
  }

  return out;
}

// ---- Seed migration (idempotent, run once) ----------------------------------

function genId(): string {
  return `room-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * AUTO-SEED + PRE-ASSIGN (owner decision 1): on first run, create rooms from the DISTINCT
 * normalized location names across all device types and pre-assign every device to its
 * seeded room. Idempotent — guarded by store.roomsSeeded so it runs exactly once and never
 * clobbers later user edits. Devices whose location normalizes to empty are left Unassigned.
 *
 * Returns the number of rooms created (0 when already seeded / nothing to seed).
 */
export async function seedRoomsIfNeeded(): Promise<number> {
  if (store.get().roomsSeeded) return 0;

  let devices: RoomDevice[];
  try {
    devices = await enumerateDevices();
  } catch {
    return 0; // can't enumerate (no connectors) — leave unseeded so it retries next boot
  }

  // Don't burn the one-shot seed on an empty fleet: enumerateDevices() soft-fails to []
  // when a connector is momentarily unreachable OR before any device type is connected. If
  // we marked roomsSeeded now, a user who opens Rooms before onboarding their devices would
  // never get auto-seeded rooms. Leave it unseeded so the seed fires the first time there's
  // actually a fleet to organize.
  if (devices.length === 0) return 0;

  // Build distinct rooms by normalized key, first-seen order. Map each device → its room id.
  const byKey = new Map<string, Room>();
  const assign = new Map<string, string>(); // deviceId → roomId
  let order = 0;
  for (const dev of devices) {
    const key = roomKey(dev.rawLocation);
    if (!key) continue; // empty location → leave Unassigned
    let room = byKey.get(key);
    if (!room) {
      room = { id: genId(), name: prettyRoomName(dev.rawLocation), icon: 'home', order: order++ };
      byKey.set(key, room);
    }
    assign.set(dev.id, room.id);
  }

  store.update((s) => {
    // Re-check inside the transaction so two concurrent callers can't double-seed.
    if (s.roomsSeeded) return;
    for (const room of byKey.values()) s.rooms[room.id] = room;
    for (const [deviceId, roomId] of assign) {
      const existing = s.deviceSettings[deviceId] ?? {};
      // Never clobber a roomId a user somehow already set; only fill the gap.
      if (existing.roomId == null) s.deviceSettings[deviceId] = { ...existing, roomId };
    }
    s.roomsSeeded = true;
  });

  return byKey.size;
}

// ---- Room resolution for views ----------------------------------------------

/** Resolve a device's effective room id (the assigned roomId, validated against the
 *  rooms map) — null when unassigned or pointing at a deleted room. */
export function resolveRoomId(deviceId: string): string | null {
  const ds = store.get().deviceSettings[deviceId];
  const roomId = ds?.roomId ?? null;
  if (!roomId) return null;
  return store.get().rooms[roomId] ? roomId : null;
}
