// The climate coordinator loop. Runs every 45s but ACTS only when the devices
// layer is armed && mode==='auto'. Each tick it evaluates enabled automations
// against a fresh snapshot. In SHADOW authority it logs intended actions and
// writes NOTHING; in AUTO authority it issues guardrailed commands through
// issueClimate(). The whole tick is wrapped so it can never crash the process.
//
// First automation type: solar_surplus_precool. Run cooling in automation-enabled
// rooms when roomTemp > limit AND solar surplus exceeds battery intake headroom;
// stop when surplus clears sustained ≥ surplusClearSec, OR room ≤ target, OR band
// turns to the exit band (P1). Compressor starts are staggered under the 14 kW cap.

import * as store from '../store';
import * as intesis from '../connectors/intesis';
import type { ClimateUnit } from '../connectors/intesis';
import type { Automation, SolarSurplusPrecoolParams } from '../store';
import { issueClimate, _resetClimateRateLimits } from './climate-execute';
import { takeClimateSnapshot, type RichClimateSnapshot } from './climate-snapshot';
import { COMPRESSOR_START_KW } from './climate-guardrails';

const TICK_MS = 45_000;
let timer: ReturnType<typeof setInterval> | null = null;

// Per-device "surplus first dropped at" timestamp, for the sustained-clear debounce.
const surplusClearedSince = new Map<string, number>();

// Above this much GRID IMPORT (kW) we treat the moment as a DEFICIT regardless of
// the computed surplusW — a safety net so surplus cooling can never silently turn
// into a grid-import load (e.g. when the battery-headroom term keeps surplusW > 0
// while the house is actually pulling from the grid). 0.4 kW clears measurement noise.
const DEFICIT_IMPORT_KW = 0.4;

// Provenance: unit ids the surplus rule itself switched ON. Lets disarm/shutdown
// switch off ONLY rule-started cooling — never occupant/manual units. In-memory
// (per process); a manual command or a successful rule stop removes a unit from it.
const surplusStartedIds = new Set<string>();

// ---- Manual override ("hold") ----------------------------------------------
// A manual command (Devices screen / API) takes precedence over automation: for
// a window after it, the coordinator (schedules AND surplus pre-cool) leaves that
// unit entirely alone — it won't turn it off, on, or re-target it. The window
// refreshes on each manual touch and expires after guardrails.manualOverrideMin.

/** Record that the user just manually commanded a device — start/refresh its hold. */
export function markManualOverride(deviceId: string): void {
  const mins = store.get().devices.guardrails.manualOverrideMin ?? 120;
  store.update((s) => {
    s.devices.manualOverrides[deviceId] = Date.now() + mins * 60_000;
  });
  surplusStartedIds.delete(deviceId); // user took control — rule no longer owns it
}

/** Epoch ms the hold expires, or null if no active hold. */
export function manualOverrideUntil(deviceId: string): number | null {
  const until = store.get().devices.manualOverrides[deviceId];
  return typeof until === 'number' && until > Date.now() ? until : null;
}

/** Is automation currently deferring to a manual command on this device? */
export function isManualOverrideActive(deviceId: string): boolean {
  return manualOverrideUntil(deviceId) !== null;
}

/** Hand control back to automation immediately (clear the hold). */
export function clearManualOverride(deviceId: string): void {
  store.update((s) => {
    delete s.devices.manualOverrides[deviceId];
  });
}

function nowMadridIso(): string {
  return new Date().toISOString();
}

/** Append a coordinator decision to the climate command log (shadow-safe). */
function logDecision(deviceId: string, reason: string, detail: string, ok = true): void {
  store.update((s) => {
    s.devices.log.push({
      ts: Date.now(),
      deviceId,
      lever: 'shadow',
      from: null,
      to: null,
      reason,
      ok,
      detail,
    });
    if (s.devices.log.length > 100) s.devices.log = s.devices.log.slice(-100);
  });
}

/**
 * Evaluate a single solar_surplus_precool automation. Returns intended decisions;
 * in AUTO authority it also issues the guardrailed commands. Best-effort; never throws.
 */
export async function evaluateSolarSurplusPrecool(
  automation: Automation,
  fleet: ClimateUnit[],
  snap: RichClimateSnapshot,
): Promise<void> {
  const p: SolarSurplusPrecoolParams = automation.params;
  const startThreshold = p.startThresholdW ?? 800;
  const isAuto = automation.authority === 'auto';
  const settings = store.get().deviceSettings;

  // Optional tariff-band stand-down: when enabled, never start cooling in the exit
  // band (P1 peak) and stop any unit running in it. Off ⇒ band is ignored entirely.
  // Undefined (legacy persisted rules) defaults to ON to preserve prior behavior.
  const bandRestrictionOn = p.bandRestrictionEnabled ?? true;
  const inExitBand = bandRestrictionOn && snap.band === p.exitBand;

  // Candidate devices: automation-enabled rooms. Evaluate WARMEST-FIRST so the
  // hottest room wins the first compressor start under the 14 kW cap.
  const enabled = fleet
    .filter((u) => settings[u.id]?.automationEnabled)
    .sort((a, b) => (b.currentTempC ?? -Infinity) - (a.currentTempC ?? -Infinity));

  // Track committed import as we stagger starts within this tick.
  let pendingImportKw = 0;

  for (const u of enabled) {
    if (isManualOverrideActive(u.id)) continue; // manual control wins — hands off
    const room = u.currentTempC;
    const wantCool =
      !inExitBand &&
      snap.surplusW > startThreshold &&
      room !== null &&
      room > p.roomTempLimitC;

    // ----- STOP conditions (debounced) -----
    const roomAtTarget = room !== null && room <= p.targetSetpointC;
    // "No longer free solar" — the computed surplus is gone OR we're actually
    // importing from the grid (a deficit). Either way, after the sustained-clear
    // window the unit is stopped so cooling never becomes a grid-import load.
    const importingFromGrid = snap.gridImportKw > DEFICIT_IMPORT_KW;
    const surplusGone = snap.surplusW <= 0 || importingFromGrid;
    if (surplusGone) {
      if (!surplusClearedSince.has(u.id)) surplusClearedSince.set(u.id, Date.now());
    } else {
      surplusClearedSince.delete(u.id);
    }
    const clearedFor = surplusClearedSince.has(u.id)
      ? Date.now() - (surplusClearedSince.get(u.id) ?? Date.now())
      : 0;
    const surplusSustainedClear = clearedFor >= p.surplusClearSec * 1000;

    const shouldStop = u.power && (surplusSustainedClear || roomAtTarget || inExitBand);

    if (shouldStop) {
      const why = inExitBand
        ? `band ${snap.band} (exit)`
        : roomAtTarget
          ? `room ${room}°C ≤ target ${p.targetSetpointC}°C`
          : `${importingFromGrid ? `grid import ${snap.gridImportKw.toFixed(1)}kW` : 'no surplus'} ${Math.round(clearedFor / 1000)}s ≥ ${p.surplusClearSec}s`;
      const reason = `${automation.name}: stop — ${why}`;
      if (isAuto) {
        await issueClimate(u, 'power', false, reason, { ...snap, pendingImportKw });
        surplusStartedIds.delete(u.id);
      } else {
        logDecision(u.id, reason, 'SHADOW — would power OFF');
      }
      continue;
    }

    if (!wantCool) continue;

    // ----- START / maintain cooling -----
    const startingCompressor = !u.power;
    const projected = snap.gridImportKw + pendingImportKw + (startingCompressor ? COMPRESSOR_START_KW : 0);
    if (startingCompressor && projected > store.get().devices.guardrails.gridImportCapKw) {
      logDecision(
        u.id,
        `${automation.name}: defer start`,
        `staggering — projected ${projected.toFixed(1)}kW > cap`,
      );
      continue;
    }

    const reason = `${automation.name}: cool@${p.targetSetpointC}°C (room ${room}°C, surplus ${(snap.surplusW / 1000).toFixed(1)}kW)`;
    if (isAuto) {
      // Drive: cool mode + target setpoint + power on. Order: mode → setpoint → power.
      await issueClimate(u, 'mode', 'cool', reason, { ...snap, pendingImportKw });
      await issueClimate(u, 'setpoint', p.targetSetpointC, reason, { ...snap, pendingImportKw });
      const res = await issueClimate(u, 'power', true, reason, { ...snap, pendingImportKw });
      if (res.ok) surplusStartedIds.add(u.id); // rule owns this unit now
      if (res.ok && startingCompressor) pendingImportKw += COMPRESSOR_START_KW;
    } else {
      logDecision(u.id, reason, `SHADOW — would cool@${p.targetSetpointC}°C`);
      if (startingCompressor) pendingImportKw += COMPRESSOR_START_KW;
    }
  }

  store.update((s) => {
    const a = s.automations.find((x) => x.id === automation.id);
    if (a) a.lastEval = Date.now();
  });
}

function hhmmToMin(s: string): number {
  const [h, m] = s.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** Is the schedule's window active right now (local time)? Handles overnight wrap. */
function scheduleActiveNow(s: store.Schedule, now: Date): boolean {
  const cur = now.getHours() * 60 + now.getMinutes();
  const a = hhmmToMin(s.start);
  const b = hhmmToMin(s.end);
  const dow = now.getDay(); // 0=Sun..6=Sat (local)
  if (a <= b) return cur >= a && cur < b && s.days.includes(dow);
  // overnight window (e.g. 22:00→07:00): the active "day" is when it STARTED.
  if (cur >= a) return s.days.includes(dow); // evening part — started today
  if (cur < b) return s.days.includes((dow + 6) % 7); // morning part — started yesterday
  return false;
}

/**
 * Apply enabled schedules whose window is active now. For each in-scope device,
 * if the schedule carries a `roomTempAboveC` condition, only apply when the room
 * is ABOVE it — so scheduled cooling doesn't run on an already-cool room.
 * Conservative: sets mode/setpoint/power-on during the window; never forces a unit
 * OFF (occupants may want it). Guardrailed + compressor-staggered via issueClimate.
 */
export async function evaluateSchedules(fleet: ClimateUnit[], snap: RichClimateSnapshot): Promise<void> {
  const schedules = store.get().schedules.filter((s) => s.enabled);
  if (schedules.length === 0) return;
  const byId = new Map(fleet.map((u) => [u.id, u]));
  const now = new Date();
  let pendingImportKw = 0;

  for (const s of schedules) {
    if (!scheduleActiveNow(s, now)) continue;
    for (const id of s.scope.deviceIds) {
      const u = byId.get(id);
      if (!u) continue;
      if (isManualOverrideActive(u.id)) continue; // manual control wins — hands off
      // CONDITION: only apply when the room is above the threshold (if one is set).
      if (s.roomTempAboveC != null && (u.currentTempC === null || u.currentTempC <= s.roomTempAboveC)) {
        logDecision(u.id, `schedule ${s.name}: skip`, `room ${u.currentTempC ?? '—'}°C not above ${s.roomTempAboveC}°C`);
        continue;
      }
      const reason = `schedule ${s.name}: ${s.mode}@${s.setpointC}°C`;
      const startingCompressor = !u.power;
      const projected = snap.gridImportKw + pendingImportKw + (startingCompressor ? COMPRESSOR_START_KW : 0);
      if (startingCompressor && projected > store.get().devices.guardrails.gridImportCapKw) {
        logDecision(u.id, `schedule ${s.name}: defer start`, `staggering — projected ${projected.toFixed(1)}kW > cap`);
        continue;
      }
      await issueClimate(u, 'mode', s.mode, reason, { ...snap, pendingImportKw });
      await issueClimate(u, 'setpoint', s.setpointC, reason, { ...snap, pendingImportKw });
      const res = await issueClimate(u, 'power', true, reason, { ...snap, pendingImportKw });
      if (res.ok && startingCompressor) pendingImportKw += COMPRESSOR_START_KW;
    }
  }
}

async function tick(): Promise<void> {
  try {
    const dev = store.get().devices;
    if (!dev.armed || dev.mode !== 'auto') return; // self-gated: inert unless armed+auto
    if (!intesis.isConfigured()) return;

    const automations = store.get().automations.filter((a) => a.enabled);
    const schedules = store.get().schedules.filter((s) => s.enabled);
    if (automations.length === 0 && schedules.length === 0) return;

    const fleet = await intesis.getFleet();
    if (fleet.length === 0) return;

    const snap = await takeClimateSnapshot();
    if (snap.ageMs > 120_000) {
      store.update((s) => {
        s.devices.lastError = 'climate coordinator: live data stale — tick skipped';
      });
      return;
    }

    // Schedules are the floor; automations (surplus pre-cool) run after and may
    // pre-cool earlier or push colder when free solar is available.
    await evaluateSchedules(fleet, snap);

    for (const a of automations) {
      if (a.type === 'solar_surplus_precool') {
        await evaluateSolarSurplusPrecool(a, fleet, snap);
      }
    }
  } catch (e) {
    store.update((s) => {
      s.devices.lastError = `climate coordinator tick failed: ${(e as Error).message}`;
    });
    console.error('[climate] coordinator tick failed:', (e as Error).message);
  }
}

/**
 * Switch OFF only the units the surplus rule itself started (provenance-tracked)
 * that are still on and not under a manual hold. Best-effort and never throws.
 * Caller MUST invoke this while still armed (mode !== 'off') — issueClimate refuses
 * once disarmed. Used on explicit disarm and on graceful shutdown so rule-started
 * cooling is never stranded importing from the grid. Returns the count switched off.
 */
export async function stopSurplusStartedUnits(reason: string): Promise<number> {
  if (surplusStartedIds.size === 0) return 0;
  if (!intesis.isConfigured()) {
    surplusStartedIds.clear();
    return 0;
  }
  let fleet: ClimateUnit[];
  let snap: RichClimateSnapshot;
  try {
    fleet = await intesis.getFleet();
    snap = await takeClimateSnapshot();
  } catch {
    return 0; // can't reach the data — leave the set for a later attempt
  }
  _resetClimateRateLimits(); // safety action — bypass the inter-write debounce
  // Power-OFF only REDUCES load, so the 14 kW cap is irrelevant — run them in
  // parallel to bound wall-clock (matters on the shutdown grace window).
  const targets = fleet.filter(
    (u) => surplusStartedIds.has(u.id) && u.power && !isManualOverrideActive(u.id),
  );
  // Drop any tracked id we won't act on (already off / now manual / gone) from the set.
  for (const id of [...surplusStartedIds]) {
    if (!targets.some((u) => u.id === id)) surplusStartedIds.delete(id);
  }
  const results = await Promise.all(
    targets.map((u) =>
      issueClimate(u, 'power', false, reason, snap)
        .then((r) => ({ id: u.id, ok: r.ok }))
        .catch(() => ({ id: u.id, ok: false })),
    ),
  );
  let stopped = 0;
  for (const r of results) {
    if (r.ok) {
      surplusStartedIds.delete(r.id);
      stopped++;
    }
  }
  return stopped;
}

/**
 * REVERT-TO-SAFE for climate — issued on disarm / mode->'off'. Conservative: we do
 * NOT forcibly power occupant/manual units off; rule-started units are switched off
 * separately by stopSurplusStartedUnits() (called while still armed, just before
 * this). Here we only clear the coordinator's debounce memory and land DISARMED.
 */
export function revertClimateToSafe(): void {
  _resetClimateRateLimits();
  surplusClearedSince.clear();
  store.update((st) => {
    st.devices.armed = false;
    st.devices.mode = 'off';
    st.devices.updatedAt = Date.now();
  });
}

export function startClimateCoordinator(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), TICK_MS);
  console.log(
    `[climate] coordinator started (every ${TICK_MS / 1000}s, self-gated on armed+auto)`,
  );
}

export function stopClimateCoordinator(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

void nowMadridIso; // reserved for future ISO logging
