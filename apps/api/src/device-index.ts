// Server-side device-name index for the Event Viewer (docs/37 follow-up). Events store the
// STABLE device id; friendly names are resolved at read time so they stay fresh and the
// already-logged backlog gets names too. This module aggregates id → {name, type} from the
// SAME cached connector fleets the existing routes serve — it does NOT trigger fresh live
// fetches beyond what those routes already do, and it SOFT-FAILS per source (each wrapped in
// try/catch, skipped on error) so one unreachable connector never blanks the whole index.
//
// READ-ONLY: this touches no control logic, no store writes, no event writes.

import { cached } from './cache';
import { getDevices } from './routes/devices';
import { getLights } from './routes/lights';
import { getBlinds } from './routes/blinds';
import { getConfigured } from './routes/discovered';
import { getBatteries } from './routes/batteries';
import { getLive } from './routes/live';

/** What we resolve for each device id. `type` is a routing hint for the client. */
export interface DeviceIndexEntry {
  name: string;
  /** Routing/category hint (climate 'cooling'|'heating', 'lighting', 'switching',
   *  'controller', 'blinds', 'irrigation', 'battery', 'grid'). Best-effort. */
  type: string;
}

type DeviceIndex = Map<string, DeviceIndexEntry>;

// Loosely-typed row shapes — we only read id/name/type/typeId/category defensively.
interface DeviceRow {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  typeId?: unknown;
  category?: unknown;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

function add(idx: DeviceIndex, id: unknown, name: unknown, type: string): void {
  const sid = str(id);
  const sname = str(name);
  if (!sid || !sname) return;
  // First writer wins (fleets are added in priority order), so a climate/battery entry
  // isn't overwritten by a generic configured-device duplicate of the same id.
  if (!idx.has(sid)) idx.set(sid, { name: sname, type });
}

/** Pull a `devices: [...]` array out of a route response, tolerating unknown. */
function rows(res: unknown): DeviceRow[] {
  const d = (res as { devices?: unknown })?.devices;
  return Array.isArray(d) ? (d as DeviceRow[]) : [];
}

/** Wrap a source fetch so a failure skips that source instead of throwing. */
async function soft<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

async function build(): Promise<DeviceIndex> {
  const idx: DeviceIndex = new Map();

  // Fetch all sources concurrently; each soft-fails to null.
  const [devicesRes, lightsRes, blindsRes, configuredRes, batteriesRes, liveRes] =
    await Promise.all([
      soft(getDevices),
      soft(getLights),
      soft(getBlinds),
      soft(getConfigured),
      soft(getBatteries),
      soft(getLive),
    ]);

  // Climate fleet + irrigation zones (each row carries a real `type`: cooling/heating/irrigation).
  for (const d of rows(devicesRes)) {
    add(idx, d.id, d.name, str(d.type) ?? 'climate');
  }
  // Native lights.
  for (const d of rows(lightsRes)) add(idx, d.id, d.name, 'lighting');
  // Blinds / covers.
  for (const d of rows(blindsRes)) add(idx, d.id, d.name, 'blinds');
  // Configured/generic Tuya devices carry a `typeId` (lighting|switching|controller|…).
  for (const d of rows(configuredRes)) add(idx, d.id, d.name, str(d.typeId) ?? 'switching');

  // Batteries — ids 'sonnen' / 'tesla', names from the fleet ({ id, name }).
  const batteries = (batteriesRes as { batteries?: DeviceRow[] } | null)?.batteries;
  if (Array.isArray(batteries)) {
    for (const b of batteries) add(idx, b.id, b.name, 'battery');
  }

  // Grid breaker from /api/live — { breaker: { id, name } } (or null when unmonitored).
  const breaker = (liveRes as { breaker?: DeviceRow | null } | null)?.breaker;
  if (breaker) add(idx, breaker.id, breaker.name, 'grid');

  return idx;
}

/**
 * Cached device-name index (~30s TTL) keyed by a constant. The `cached()` helper coalesces
 * concurrent builds, so per-request cost is one Map lookup once warm. NEVER throws — a total
 * build failure degrades to an empty index (callers fall back to the raw id).
 */
export async function deviceNameIndex(): Promise<DeviceIndex> {
  try {
    return await cached('device-name-index', 30_000, build);
  } catch {
    return new Map();
  }
}
