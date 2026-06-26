// Blinds schedule evaluator. Part of the devices coordinator tick (gated on
// devices.armed && mode==='auto'), but INDEPENDENT of the Intesis climate fleet —
// blinds are Tuya devices. Each tick: for every enabled blinds rule whose window
// is active now, drive that blind toward the rule's target position via the
// guarded Tuya write path. Conservative + best-effort: never throws, respects a
// manual-override hold, skips when already at target, and rate-limits writes.

import * as store from '../store';
import * as tuya from '../connectors/tuya';
import * as blinds from '../connectors/tuya-blinds';
import { isManualOverrideActive } from './climate-coordinator';

/** ≥60s between scheduled writes to the SAME blind (motors are slow; avoid spam). */
const WRITE_COOLDOWN_MS = 60_000;
/** Treat positions within this many %-points of target as "already there". */
const POS_TOLERANCE = 3;

const lastWriteAt = new Map<string, number>();

function hhmmToMin(s: string): number {
  const [h, m] = s.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** Is ONE window active now (local time)? Handles overnight wrap. Mirrors the climate helper. */
function windowActiveNow(w: store.ScheduleWindow, days: number[], now: Date): boolean {
  const cur = now.getHours() * 60 + now.getMinutes();
  const a = hhmmToMin(w.start);
  const b = hhmmToMin(w.end);
  const dow = now.getDay();
  if (a < b) return cur >= a && cur < b && days.includes(dow);
  if (cur >= a) return days.includes(dow);
  if (cur < b) return days.includes((dow + 6) % 7);
  return false;
}

function activeWindow(s: store.Schedule, now: Date): store.ScheduleWindow | null {
  for (const w of s.windows) if (windowActiveNow(w, s.days, now)) return w;
  return null;
}

function logBlind(
  deviceId: string,
  from: number | null,
  to: number,
  reason: string,
  ok: boolean,
  detail: string,
): void {
  store.update((st) => {
    st.devices.log.push({ ts: Date.now(), deviceId, lever: 'position', from, to, reason, ok, detail });
    if (st.devices.log.length > 100) st.devices.log = st.devices.log.slice(-100);
    st.devices.updatedAt = Date.now();
    if (!ok) st.devices.lastError = `blind ${deviceId}: ${detail}`;
  });
}

/**
 * Apply enabled blinds rules whose window is active now. Each rule targets ONE
 * blind; during its window the blind is driven to the rule's `positionPct`
 * (0 = closed … 100 = open). Outside the window the rule does nothing (a separate
 * rule may set the opposite). Never throws.
 */
export async function evaluateBlindSchedules(): Promise<void> {
  try {
    const schedules = store
      .get()
      .schedules.filter((s) => s.enabled && s.type === 'blinds' && s.scope.kind === 'unit');
    if (schedules.length === 0) return;
    if (!tuya.isConfigured()) return;

    const all = await tuya.getDevices();
    const byId = new Map(all.filter((d) => blinds.isBlind(d)).map((d) => [d.id, d]));
    const settings = store.get().deviceSettings;
    const now = new Date();

    for (const s of schedules) {
      const w = activeWindow(s, now);
      if (!w) continue;
      const deviceId = (s.scope as { kind: 'unit'; deviceId: string }).deviceId;
      const d = byId.get(deviceId);
      if (!d || !d.online) continue;
      if (isManualOverrideActive(deviceId)) continue; // manual move wins — hands off

      const target = Math.min(100, Math.max(0, Math.round(s.action.positionPct ?? 0)));
      const invert = settings[deviceId]?.invertPosition ?? false;
      const norm = blinds.normalizeBlind(d, { invert });
      const cur = norm.positionPct;

      // Already at target (within tolerance) → nothing to do.
      if (cur !== null && Math.abs(cur - target) <= POS_TOLERANCE) continue;
      // Rate-limit repeated writes while the motor travels.
      const last = lastWriteAt.get(deviceId);
      if (last !== undefined && Date.now() - last < WRITE_COOLDOWN_MS) continue;

      const verb = target >= 50 ? 'open' : 'close';
      const reason = `rule ${s.name}: ${verb} → ${target}%`;
      try {
        const lever = norm.supportsPosition ? 'position' : verb;
        const cmds = blinds.buildCommands(d, lever, target, invert);
        await tuya.sendCommands(deviceId, cmds);
        tuya.invalidateFleet();
        lastWriteAt.set(deviceId, Date.now());
        logBlind(deviceId, cur, target, reason, true, `set ${verb} (${target}%)`);
      } catch (e) {
        logBlind(deviceId, cur, target, reason, false, (e as Error).message);
      }
    }
  } catch (e) {
    store.update((st) => {
      st.devices.lastError = `blinds schedule tick failed: ${(e as Error).message}`;
    });
  }
}

/** Clear the rate-limit memory (used by revert-to-safe / tests). */
export function _resetBlindRateLimits(): void {
  lastWriteAt.clear();
}
