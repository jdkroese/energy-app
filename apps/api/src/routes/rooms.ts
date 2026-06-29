// Rooms HTTP surface. Reads are any-authed; writes (create/rename/reorder/delete, assign,
// all-off) are admin-gated at the route in index.ts. The Rooms model is cross-cutting: a
// device's room lives on deviceSettings[id].roomId and spans every device type.
//
//   GET    /api/rooms                 — rooms (+ per-room device counts) ; lazily seeds once
//   POST   /api/rooms                 — create a room
//   PATCH  /api/rooms/:id             — rename / icon / reorder
//   DELETE /api/rooms/:id             — delete (cascade: its devices fall back to Unassigned)
//   POST   /api/devices/:id/room      — assign / clear a device's room { roomId | null }
//   POST   /api/rooms/:id/all-off     — bulk power-off the room's devices { scope?: 'all'|'lights' }

import * as store from '../store';
import type { Room } from '../store';
import {
  enumerateDevices,
  seedRoomsIfNeeded,
  resolveRoomId,
  type RoomDevice,
} from '../rooms';
import { commandDevice } from './devices';
import { commandLight } from './lights';
import { commandGeneric } from './discovered';

function badInput(msg: string): Error & { code: string } {
  const e = new Error(msg) as Error & { code: string };
  e.code = 'BAD_INPUT';
  return e;
}

function newId(): string {
  return `room-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Rooms in display order — always alphabetical by name (numeric-aware, case-insensitive),
 *  matching how every other device list in the app is ordered. */
function orderedRooms(): Room[] {
  return Object.values(store.get().rooms).sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

/**
 * GET /api/rooms — the rooms list (ordered) with a per-room device count, plus the
 * Unassigned count. Lazily runs the one-time seed migration first (idempotent), so the
 * first read after a fresh connect auto-creates rooms from existing device locations.
 */
export async function getRooms(): Promise<unknown> {
  await seedRoomsIfNeeded();

  let devices: RoomDevice[] = [];
  let fleetError: string | null = null;
  try {
    devices = await enumerateDevices();
  } catch (e) {
    fleetError = (e as Error).message;
  }

  // Count devices per resolved roomId (+ Unassigned).
  const counts = new Map<string, number>();
  let unassigned = 0;
  for (const dev of devices) {
    const roomId = resolveRoomId(dev.id);
    if (roomId) counts.set(roomId, (counts.get(roomId) ?? 0) + 1);
    else unassigned++;
  }

  const rooms = orderedRooms().map((r) => ({ ...r, deviceCount: counts.get(r.id) ?? 0 }));
  return { ts: new Date().toISOString(), rooms, unassignedCount: unassigned, deviceCount: devices.length, fleetError };
}

// ---- CRUD -------------------------------------------------------------------

const ICON_FALLBACK = 'home';

export function createRoom(body: unknown): unknown {
  const b = (body ?? {}) as { name?: unknown; icon?: unknown };
  const name = String(b.name ?? '').trim();
  if (!name) throw badInput('name required');
  const icon = String(b.icon ?? '').trim() || ICON_FALLBACK;
  const room: Room = store.update((s) => {
    const order = Object.values(s.rooms).reduce((m, r) => Math.max(m, r.order), -1) + 1;
    const r: Room = { id: newId(), name, icon, order };
    s.rooms[r.id] = r;
    return r;
  });
  return { ts: new Date().toISOString(), room };
}

export function updateRoom(id: string, body: unknown): unknown {
  const b = (body ?? {}) as { name?: unknown; icon?: unknown; order?: unknown };
  const saved = store.update((s) => {
    const cur = s.rooms[id];
    if (!cur) return null;
    const next: Room = {
      ...cur,
      name: typeof b.name === 'string' && b.name.trim() ? b.name.trim() : cur.name,
      icon: typeof b.icon === 'string' && b.icon.trim() ? b.icon.trim() : cur.icon,
      order: typeof b.order === 'number' && Number.isFinite(b.order) ? b.order : cur.order,
    };
    s.rooms[id] = next;
    return next;
  });
  if (!saved) throw badInput(`room ${id} not found`);
  return { ts: new Date().toISOString(), room: saved };
}

/** DELETE /api/rooms/:id — remove the room; cascade its devices back to Unassigned. */
export function deleteRoom(id: string): unknown {
  store.update((s) => {
    delete s.rooms[id];
    // Cascade: any device pointing at this room becomes Unassigned (roomId cleared).
    for (const ds of Object.values(s.deviceSettings)) {
      if (ds.roomId === id) ds.roomId = null;
    }
  });
  return { ts: new Date().toISOString(), ok: true };
}

/** POST /api/devices/:id/room — assign or clear a device's room. Body { roomId|null }.
 *  Creating-and-assigning a brand-new room is done client-side via createRoom first. */
export function assignDeviceRoom(deviceId: string, body: unknown): unknown {
  const id = String(deviceId ?? '').trim();
  if (!id) throw badInput('device id required');
  const b = (body ?? {}) as { roomId?: unknown };
  const roomId = b.roomId == null ? null : String(b.roomId);
  if (roomId && !store.get().rooms[roomId]) throw badInput(`room ${roomId} not found`);
  store.update((s) => {
    const existing = s.deviceSettings[id] ?? {};
    s.deviceSettings[id] = { ...existing, roomId };
  });
  return { ts: new Date().toISOString(), id, roomId };
}

// ---- Room-level All-off -----------------------------------------------------
// Owner decision 3: each room gets "All off" and "All lights off". SCOPE STRICTLY to
// off/power capabilities (climate power off, light off, generic switch→false). EXCLUDE
// sensitive devices entirely (a device with ANY sensitive action cap — locks/sirens/
// gates): a room "all off" must NEVER lock a door or fire a siren. Turning OFF is
// reversible → no confirm needed. Blinds are NOT in scope (closing isn't "off").

/** True when a generic device carries any sensitive action capability (lock/siren/gate). */
function isSensitiveDevice(dev: RoomDevice): boolean {
  return (dev.capabilities ?? []).some((c) => c.sensitive === true);
}

interface AllOffResult {
  id: string;
  name: string;
  kind: string;
  ok: boolean;
  reason: string;
}

/**
 * POST /api/rooms/:id/all-off — power off the room's devices through the EXISTING per-type
 * writers. Body { scope?: 'all'|'lights' }: 'lights' only touches lights; 'all' also powers
 * off climate + generic switches. Sensitive devices are skipped entirely; blinds are out of
 * scope. Returns a per-device result summary. Only acts on devices currently ON.
 */
export async function roomAllOff(id: string, body: unknown): Promise<unknown> {
  const roomId = String(id ?? '').trim();
  if (!store.get().rooms[roomId]) throw badInput(`room ${roomId} not found`);
  const scope = ((body ?? {}) as { scope?: unknown }).scope === 'lights' ? 'lights' : 'all';

  const devices = (await enumerateDevices()).filter((d) => resolveRoomId(d.id) === roomId);
  const results: AllOffResult[] = [];

  for (const dev of devices) {
    // Never touch a sensitive device, regardless of scope.
    if (isSensitiveDevice(dev)) {
      results.push({ id: dev.id, name: dev.name, kind: dev.kind, ok: false, reason: 'skipped — sensitive' });
      continue;
    }
    // Irrigation is not swept by room all-off — water is actuated only via explicit
    // run/stop on the Irrigation screen, never as a side effect of "turn the room off".
    if (dev.kind === 'irrigation') {
      results.push({ id: dev.id, name: dev.name, kind: dev.kind, ok: false, reason: 'skipped — irrigation' });
      continue;
    }
    // Blinds are not "off"-able in scope.
    if (dev.kind === 'blind') {
      results.push({ id: dev.id, name: dev.name, kind: dev.kind, ok: false, reason: 'skipped — not a power device' });
      continue;
    }
    // 'lights' scope: lights only.
    if (scope === 'lights' && dev.kind !== 'light') {
      results.push({ id: dev.id, name: dev.name, kind: dev.kind, ok: false, reason: 'skipped — not a light' });
      continue;
    }
    // Already off → nothing to do (reversible, but avoid needless writes).
    if (!dev.power) {
      results.push({ id: dev.id, name: dev.name, kind: dev.kind, ok: true, reason: 'already off' });
      continue;
    }
    try {
      if (dev.kind === 'climate') {
        await commandDevice(dev.id, 'power', false);
      } else if (dev.kind === 'light') {
        await commandLight(dev.id, 'power', false);
      } else {
        // generic — find an off/power switch capability and set it false. Skip if none.
        const sw = (dev.capabilities ?? []).find((c) => c.kind === 'switch' && !c.readOnly);
        if (!sw) {
          results.push({ id: dev.id, name: dev.name, kind: dev.kind, ok: false, reason: 'no power switch' });
          continue;
        }
        await commandGeneric(dev.id, { dp: sw.dp, kind: 'switch', value: false });
      }
      results.push({ id: dev.id, name: dev.name, kind: dev.kind, ok: true, reason: 'off' });
    } catch (e) {
      results.push({ id: dev.id, name: dev.name, kind: dev.kind, ok: false, reason: (e as Error).message });
    }
  }

  return { ts: new Date().toISOString(), id: roomId, scope, results };
}
