// Blinds HTTP surface (Tuya). Reads are any-authed; commands are admin-gated at
// the route in index.ts. Mirrors routes/lights.ts on the shared `tuya.ts`
// foundation, and degrades gracefully when no Tuya project is connected. Per-device
// room name + position invert come from the shared deviceSettings store.

import * as tuya from '../connectors/tuya';
import * as blinds from '../connectors/tuya-blinds';
import type { BlindLever, BlindUnit } from '../connectors/tuya-blinds';
import * as store from '../store';
import { markManualOverride } from '../control/climate-coordinator';
import { resolveRoomId } from '../rooms';

/** Attach the first-class Rooms fields (roomId + resolved name) to a normalized unit. */
function withRoom<T extends { id: string }>(u: T): T & { roomId: string | null; roomName: string | null } {
  const roomId = resolveRoomId(u.id);
  const roomName = roomId ? store.get().rooms[roomId]?.name ?? null : null;
  return { ...u, roomId, roomName };
}

function badInput(msg: string): Error & { code: string } {
  const e = new Error(msg) as Error & { code: string };
  e.code = 'BAD_INPUT';
  return e;
}

// ---- Timed positioning: server-side runtime state (docs/34) -----------------
// A blind with no native position DP but a configured `travelSec` is positioned by
// TIMING: run the motor for travelSec×|Δ|/100 then send Stop. There's no feedback, so
// we track an ASSUMED position per blind in memory. `anchored` is false after a restart
// (this map is empty) or a manual physical operation — the first partial move then
// re-anchors from a known end (full close to 0) before moving to target.
//
// This lives in-memory (NOT the persisted store): losing it on restart is exactly the
// desired "unknown → re-anchor" behaviour. `moveToken` invalidates a superseded move so a
// new command mid-travel cancels the pending Stop and starts fresh.
interface TimedPos {
  assumedPct: number;
  anchored: boolean;
  /** Monotonic token: bumped by every new command. An in-flight (detached) move captures the
   *  token at start and checks it after each leg's wait — a mismatch means it was superseded,
   *  so it skips its Stop and drops its assumedPct write. This is the cancellation mechanism. */
  moveToken: number;
}

const timedPos = new Map<string, TimedPos>();

/** Read (creating a default, unanchored) the runtime timed-position record for a blind. */
function getTimed(id: string): TimedPos {
  let t = timedPos.get(id);
  if (!t) {
    t = { assumedPct: 0, anchored: false, moveToken: 0 };
    timedPos.set(id, t);
  }
  return t;
}

/** Snapshot for the normaliser (assumedPct + anchored), or null if never tracked. */
export function timedRuntime(id: string): { assumedPct: number; anchored: boolean } | null {
  const t = timedPos.get(id);
  return t ? { assumedPct: t.assumedPct, anchored: t.anchored } : null;
}

/** Clamp a configured travel time to the sane 5–90s range. */
function clampTravelSec(n: number): number {
  return Math.max(5, Math.min(90, n));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Normalize the connected fleet down to just the blinds/curtains category. */
async function getBlindFleet(): Promise<{ units: BlindUnit[]; error: string | null }> {
  const settings = store.get().deviceSettings;
  try {
    const all = await tuya.getDevices();
    const units = all
      .filter((d) => blinds.isBlind(d))
      .map((d) =>
        blinds.normalizeBlind(d, {
          room: settings[d.id]?.room,
          invert: settings[d.id]?.invertPosition ?? false,
          travelSec: settings[d.id]?.travelSec,
          runtime: timedRuntime(d.id),
        }),
      )
      .map(withRoom);
    return { units, error: null };
  } catch (e) {
    return { units: [], error: (e as Error).message };
  }
}

/** Live blind ids (best-effort; empty when Tuya isn't connected or on a fleet error).
 *  Used by the whole-home all-off scene to close every blind without per-device IDs. */
export async function listBlindIds(): Promise<string[]> {
  if (!tuya.isConfigured()) return [];
  const { units } = await getBlindFleet();
  return units.map((u) => u.id);
}

/** GET /api/blinds — normalized blind fleet + a small context strip. */
export async function getBlinds(): Promise<unknown> {
  if (!tuya.isConfigured()) {
    return {
      ts: new Date().toISOString(),
      connected: false,
      fleetError: null,
      devices: [],
      context: { deviceCount: 0, openCount: 0 },
    };
  }
  const { units, error } = await getBlindFleet();
  return {
    ts: new Date().toISOString(),
    connected: true,
    fleetError: error,
    devices: units,
    context: {
      deviceCount: units.length,
      // "open" = position above a slim threshold (or, with no feedback, unknown→0).
      openCount: units.filter((u) => (u.positionPct ?? 0) > 2).length,
    },
  };
}

/** GET /api/blinds/:id — single blind detail. */
export async function getBlind(id: string): Promise<unknown> {
  if (!tuya.isConfigured()) {
    return { ts: new Date().toISOString(), connected: false, device: null };
  }
  const { units } = await getBlindFleet();
  const device = units.find((u) => u.id === id) ?? null;
  return { ts: new Date().toISOString(), connected: true, device };
}

// ---- Commands (admin) -------------------------------------------------------

export async function commandBlind(id: string, lever: BlindLever, value: unknown): Promise<unknown> {
  if (!blinds.BLIND_LEVERS.includes(lever)) {
    throw badInput(`lever must be one of ${blinds.BLIND_LEVERS.join('|')}`);
  }
  if (!tuya.isConfigured()) throw badInput('Tuya not connected');
  const all = await tuya.getDevices();
  const d = all.find((x) => x.id === id);
  if (!d || !blinds.isBlind(d)) throw badInput(`blind ${id} not found`);

  const settings = store.get().deviceSettings[id];
  const invert = settings?.invertPosition ?? false;
  const supportsPosition = blinds.normalizeBlind(d).supportsPosition;
  const travelSec = settings?.travelSec;
  // Timed positioning applies only to a blind WITHOUT native position, WITH a travelSec set.
  const timed = !supportsPosition && travelSec != null;

  // A brand-new command on this blind supersedes any in-flight timed move: bump the token so
  // the old detached sequence sees the change after its next wait and abandons its pending Stop.
  const t = getTimed(id);
  t.moveToken += 1;

  // ---- Timed partial positioning (server-side, cancellable) -----------------
  if (timed && lever === 'position') {
    return runTimedMove(id, d, invert, clampTravelSec(travelSec), value, t);
  }

  // ---- Full open/close/stop, and native position (existing behaviour) -------
  const commands = blinds.buildCommands(d, lever, value, invert); // may throw BAD_INPUT
  await tuya.sendCommands(id, commands);
  tuya.invalidateFleet(); // reflect the change on the next read immediately
  markManualOverride(id); // a manual move pauses any blinds schedule on this unit

  // Re-anchor bookkeeping for TIMED blinds: full open/close are the known ends; stop
  // leaves us mid-travel at an unknown position, so it drops the anchor.
  if (timed) {
    if (lever === 'open') {
      t.assumedPct = 100;
      t.anchored = true;
    } else if (lever === 'close') {
      t.assumedPct = 0;
      t.anchored = true;
    } else if (lever === 'stop') {
      t.anchored = false;
    }
  }

  return { ts: new Date().toISOString(), ok: true, id, lever, commands };
}

/**
 * Run a timed partial move to `target%` for a blind with no native position DP. Fires the
 * direction command, waits duration, then Stops — SERVER-SIDE, so a locked phone / closed
 * tab still gets the Stop. Cancellable via moveToken: if a newer command bumps the token
 * before the Stop fires, this sequence's Stop is skipped and its assumedPct write is dropped.
 *
 * Accuracy rule ("re-anchor when unknown", docs/34): when the blind isn't anchored (post-
 * restart / never moved), prepend a full CLOSE to 0 (a known end) before opening to target.
 */
function runTimedMove(
  id: string,
  d: import('../connectors/tuya').TuyaDevice,
  invert: boolean,
  travelSec: number,
  value: unknown,
  t: TimedPos,
): unknown {
  const target = Math.max(0, Math.min(100, Math.round(Number(value))));
  if (!Number.isFinite(target)) throw badInput('position must be 0–100');
  const token = t.moveToken; // captured; a supersede bumps t.moveToken and invalidates us
  markManualOverride(id); // a manual move pauses any blinds schedule on this unit

  // A helper that runs the (possibly multi-leg) motor sequence DETACHED from the HTTP
  // request, so the endpoint returns immediately (spec: return `moving:true`) yet the
  // wait+Stop still runs server-side. Cancellation is by moveToken: every leg checks it.
  const stopped = (): boolean => t.moveToken !== token;
  const send = (lever: BlindLever) =>
    tuya.sendCommands(id, blinds.buildCommands(d, lever, undefined, invert)).then(() => tuya.invalidateFleet());

  // Fast path for the exact ends — no timer, just fire + anchor.
  if (target >= 100 || target <= 0) {
    const end: BlindLever = target >= 100 ? 'open' : 'close';
    void send(end)
      .then(() => {
        if (stopped()) return;
        t.assumedPct = target >= 100 ? 100 : 0;
        t.anchored = true;
      })
      .catch(() => undefined);
    return { ts: new Date().toISOString(), ok: true, id, lever: 'position', target, moving: false, reanchored: false };
  }

  const reanchored = !t.anchored;

  void (async () => {
    try {
      // Re-anchor first when unknown: a full close to the known 0 end, timed by travelSec.
      if (!t.anchored) {
        await send('close');
        await sleep(travelSec * 1000);
        if (stopped()) return; // a newer command took over during the re-anchor close
        await send('stop');
        t.assumedPct = 0;
        t.anchored = true;
      }

      const from = t.assumedPct;
      const delta = target - from; // signed
      const durationMs = (travelSec * 1000 * Math.abs(delta)) / 100;
      if (Math.abs(delta) < 0.5) {
        // Already there (rare — e.g. re-anchored to 0 and target ~0): nothing to run.
        t.assumedPct = target;
        t.anchored = true;
        return;
      }
      await send(delta > 0 ? 'open' : 'close');
      await sleep(durationMs);
      if (stopped()) return; // superseded — a newer move owns the motor now
      await send('stop');
      t.assumedPct = target;
      t.anchored = true;
    } catch {
      // Best-effort: on any transport error, leave the anchor unknown so the next move re-anchors.
      if (!stopped()) t.anchored = false;
    }
  })();

  return {
    ts: new Date().toISOString(),
    ok: true,
    id,
    lever: 'position',
    target,
    from: t.assumedPct,
    moving: true,
    reanchored,
  };
}

export async function bulkCommandBlinds(ids: string[], lever: BlindLever, value: unknown): Promise<unknown> {
  if (!Array.isArray(ids) || ids.length === 0) throw badInput('ids[] required');
  if (!blinds.BLIND_LEVERS.includes(lever)) {
    throw badInput(`lever must be one of ${blinds.BLIND_LEVERS.join('|')}`);
  }
  if (!tuya.isConfigured()) throw badInput('Tuya not connected');
  const all = await tuya.getDevices();
  const settings = store.get().deviceSettings;
  const results: Array<{ id: string; ok: boolean; reason: string }> = [];
  for (const id of ids) {
    const d = all.find((x) => x.id === id);
    if (!d || !blinds.isBlind(d)) {
      results.push({ id, ok: false, reason: 'not found' });
      continue;
    }
    try {
      await tuya.sendCommands(id, blinds.buildCommands(d, lever, value, settings[id]?.invertPosition ?? false));
      results.push({ id, ok: true, reason: 'ok' });
    } catch (e) {
      results.push({ id, ok: false, reason: (e as Error).message });
    }
  }
  tuya.invalidateFleet();
  return { ts: new Date().toISOString(), results };
}
