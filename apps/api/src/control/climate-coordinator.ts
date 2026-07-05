// The climate coordinator loop. Runs every 45s but ACTS only when the devices
// layer is armed && mode==='auto'. Each tick it evaluates enabled automations
// against a fresh snapshot and issues guardrailed commands through issueClimate()
// for every enabled automation (there is no longer a shadow/dry-run authority —
// an enabled automation under armed+auto always acts). The whole tick is wrapped
// so it can never crash the process.
//
// Automation types — TWO single-direction solar-surplus rules over the Intesis HVAC fleet:
//   • solar_surplus_precool — COOLING ONLY: a room ABOVE roomTempLimitC is COOLED toward
//     targetSetpointC. Acts on units enrolled via solarCoolEnabled.
//   • solar_surplus_preheat — HEATING ONLY: a room BELOW heatRoomFloorC is HEATED toward
//     heatTargetSetpointC. Acts on units enrolled via solarHeatEnabled.
// Each runs only while there is genuine solar surplus (grid export above the rule's start
// threshold), stops when surplus clears sustained ≥ surplusClearSec, OR the room reaches
// target, OR the tariff turns to the exit band (P1). Starts are staggered under the 14 kW
// cap. The Airzone underfloor fleet (`air-*`) is excluded from both.
//
// Manual protection is PROVENANCE-BASED and persisted (store.devices.surplusStartedIds):
// the rule owns ONLY the units it switched on itself. ANY powered-on unit NOT in that set
// — dashboard, a physical REMOTE, or a schedule turned it on — is treated as MANUAL: the
// surplus rule never powers it off and never retunes its mode/setpoint. (False-negative by
// design: the rule would rather leave a unit alone than risk switching off one a person
// turned on outside our API.) The rule still freely starts/stops the units it owns.

import * as store from '../store';
import * as intesis from '../connectors/intesis';
import * as airzone from '../connectors/airzone';
import type { ClimateUnit } from '../connectors/intesis';
import type { Automation, SolarSurplusPrecoolParams } from '../store';
import { issueClimate, _resetClimateRateLimits } from './climate-execute';
import { takeClimateSnapshot, type RichClimateSnapshot } from './climate-snapshot';
import { COMPRESSOR_START_KW } from './climate-guardrails';
import { evaluateBlindSchedules } from './blinds-coordinator';
import { evaluateEvSurplus } from './ev-surplus';
import { sunriseSunsetMin } from '../solar-model';
import { config } from '../config';

const TICK_MS = 45_000;
let timer: ReturnType<typeof setInterval> | null = null;

// Per-device "surplus first dropped at" timestamp, for the sustained-clear debounce.
const surplusClearedSince = new Map<string, number>();
// Per-device count of CONSECUTIVE ticks a rule-owned unit has been observed OFF, for the
// release debounce (so one stale `power=false` read from the flaky cloud can't orphan a
// still-running unit). Reset to 0 the moment it reads ON again.
const offSeenCount = new Map<string, number>();
// Consecutive OFF reads required before the rule releases ownership of a unit.
const OFF_RELEASE_TICKS = 2;

// Per-device epoch ms the rule STARTED the unit, for the minimum-run floor (anti-chatter):
// for minRunSec after a start the rule won't soft-stop the unit (room-at-target / surplus
// cleared), so a fluctuating surplus can't switch it on/off repeatedly. In-memory only — a
// restart forgets it (a just-rebooted unit may then stop at once, which is safe). Set on a
// true start, cleared whenever ownership is dropped (see dropSurplusStarted).
const surplusStartedAt = new Map<string, number>();
// Default minimum on-time (s) when a rule omits minRunSec — 15 min, the owner's anti-chatter floor.
const MIN_RUN_DEFAULT_SEC = 900;
// Default fan speed the rule sets on switch-on when a rule omits fanLevel.
const FAN_LEVEL_DEFAULT = 2;

// Above this much GRID IMPORT (kW) we treat the moment as a DEFICIT regardless of
// the computed surplusW — a safety net so surplus cooling can never silently turn
// into a grid-import load (e.g. when the battery-headroom term keeps surplusW > 0
// while the house is actually pulling from the grid). 0.4 kW clears measurement noise.
const DEFICIT_IMPORT_KW = 0.4;

// Airzone underfloor zones (id `air-*`) are the underfloor HEATING fleet — NO LONGER
// surplus-eligible. The surplus automation now targets only the Intesis HVAC fleet
// (everything that is NOT `air-*`), which it can drive in either direction.
function isAirzone(u: ClimateUnit): boolean {
  return u.id.startsWith('air-');
}

// Start hysteresis (°C) so a unit doesn't chatter on/off right at its trigger: cooling
// starts only when room > limit + half-band; heating only when room < floor − half-band.
// (Each rule is single-direction now, so this is comfort hysteresis, not a cool↔heat flip
// guard.) The stop condition uses the bare target so a unit still switches off at target.
const TRIGGER_HYSTERESIS_C = 1.0;

// ---- Provenance: rule-started units (persisted) ----------------------------
// The single source of truth for ownership. A unit's id is in surplusStartedIds iff the
// surplus rule itself switched it ON. PERSISTED in store.devices.surplusStartedIds so it
// survives a restart/deploy: an auto-started unit stays rule-managed across reboots, and
// a remote-/dashboard-/schedule-started unit stays MANUAL (rule never touches it).

/** Does the surplus rule currently own (it started) this unit? */
export function surplusOwns(deviceId: string): boolean {
  return store.get().devices.surplusStartedIds.includes(deviceId);
}

/** Record that the rule started this unit (idempotent). */
function addSurplusStarted(deviceId: string): void {
  store.update((s) => {
    if (!s.devices.surplusStartedIds.includes(deviceId)) s.devices.surplusStartedIds.push(deviceId);
  });
}

/** Drop this unit from rule provenance — the rule stopped it, it was observed OFF, or
 *  the user took manual control of it. Exported so the manual command path can release a
 *  rule-started unit when the user powers it off. */
export function dropSurplusStarted(deviceId: string): void {
  surplusStartedAt.delete(deviceId); // ownership gone ⇒ forget its min-run start time
  store.update((s) => {
    const i = s.devices.surplusStartedIds.indexOf(deviceId);
    if (i >= 0) s.devices.surplusStartedIds.splice(i, 1);
  });
}

/**
 * Is this unit MANUAL (user-/remote-/schedule-owned), given its current power state?
 * Manual ⇔ powered ON but NOT rule-started. A unit that is OFF is owned by nobody. The
 * surplus rule must never power-off or retune a manual unit.
 */
export function isManual(deviceId: string, poweredOn: boolean): boolean {
  return poweredOn && !surplusOwns(deviceId);
}

// ---- Manual override ("hold") ----------------------------------------------
// A manual command (Devices screen / API) takes precedence over automation: for
// a window after it, the coordinator (schedules AND surplus pre-cool) leaves that
// unit entirely alone — it won't turn it off, on, or re-target it. The window
// refreshes on each manual touch and expires after guardrails.manualOverrideMin.

/** Record that the user just manually commanded a device — start/refresh its hold. */
export function markManualOverride(deviceId: string): void {
  const mins = store.get().devices.guardrails.manualOverrideMin ?? 480;
  store.update((s) => {
    s.devices.manualOverrides[deviceId] = Date.now() + mins * 60_000;
  });
  dropSurplusStarted(deviceId); // user took control — rule no longer owns it
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
    s.devices.log = store.pruneLog(s.devices.log);
  });
}

/**
 * Shared single-direction surplus evaluator. `dir` selects COOL or HEAT; the rule acts
 * ONLY on units enrolled in that direction (solarCoolEnabled / solarHeatEnabled) and only
 * pushes the room in that one direction:
 *   • COOL: room ABOVE roomTempLimitC → cool toward targetSetpointC.
 *   • HEAT: room BELOW heatRoomFloorC → heat toward heatTargetSetpointC.
 * Surplus start threshold, exit-band stand-down, import cap, sustained-clear stop and
 * rate-limit guards are shared. Manual/remote/schedule-owned units are skipped entirely
 * (never powered off, never retuned) via the persisted provenance set. Best-effort; never
 * throws. An enabled automation under armed+auto always acts.
 */
async function evaluateSurplusDirection(
  automation: Automation,
  dir: 'cool' | 'heat',
  fleet: ClimateUnit[],
  snap: RichClimateSnapshot,
): Promise<void> {
  // This evaluator is only ever reached for the surplus rules, so the battery
  // (tariff-arbitrage) shape can't appear here. Bail defensively, then read the climate shape.
  if (automation.type === 'tariff_arbitrage') return;
  const p = automation.params as SolarSurplusPrecoolParams;
  const startThreshold = p.startThresholdW ?? 800;
  const heatFloor = p.heatRoomFloorC ?? 19;
  const heatTarget = p.heatTargetSetpointC ?? 21;
  const minRunMs = (p.minRunSec ?? MIN_RUN_DEFAULT_SEC) * 1000;
  const fanLevel = p.fanLevel ?? FAN_LEVEL_DEFAULT;
  const settings = store.get().deviceSettings;

  // This direction's trigger + target. Cooling triggers when warm (room > limit) and
  // drives down to coolTarget; heating triggers when cold (room < floor) and drives up
  // to heatTarget.
  const triggerC = dir === 'cool' ? p.roomTempLimitC : heatFloor;
  const targetC = dir === 'cool' ? p.targetSetpointC : heatTarget;

  // Optional tariff-band stand-down: when enabled, never start in the exit band (P1
  // peak) and stop any unit running in it. Off ⇒ band is ignored entirely. Undefined
  // (legacy persisted rules) defaults to ON to preserve prior behavior.
  const bandRestrictionOn = p.bandRestrictionEnabled ?? true;
  const inExitBand = bandRestrictionOn && snap.band === p.exitBand;
  const half = TRIGGER_HYSTERESIS_C / 2;

  // Candidate devices: HVAC (NON-Airzone) rooms enrolled in THIS direction only.
  // Cooling sorts warmest-first (hottest room wins the first compressor start under the
  // 14 kW cap); heating sorts coldest-first (the coldest room goes first).
  const enrolled = (id: string) =>
    dir === 'cool' ? settings[id]?.solarCoolEnabled === true : settings[id]?.solarHeatEnabled === true;
  const candidates = fleet
    .filter((u) => !isAirzone(u) && enrolled(u.id))
    .sort((a, b) =>
      dir === 'cool'
        ? (b.currentTempC ?? -Infinity) - (a.currentTempC ?? -Infinity)
        : (a.currentTempC ?? Infinity) - (b.currentTempC ?? Infinity),
    );

  // Track committed import as we stagger starts within this tick.
  let pendingImportKw = 0;

  for (const u of candidates) {
    // Provenance reconcile: if a rule-started unit is observed OFF (someone turned it off),
    // release it — but DEBOUNCED. A single stale/transient `power=false` read from the flaky
    // Intesis cloud must not orphan a unit that is actually still running, so require the unit
    // to read OFF for OFF_RELEASE_TICKS consecutive ticks before dropping ownership. Any ON
    // reading resets the counter.
    if (surplusOwns(u.id)) {
      if (!u.power) {
        const n = (offSeenCount.get(u.id) ?? 0) + 1;
        if (n >= OFF_RELEASE_TICKS) {
          dropSurplusStarted(u.id);
          offSeenCount.delete(u.id);
        } else {
          offSeenCount.set(u.id, n);
        }
      } else {
        offSeenCount.delete(u.id);
      }
    }

    // Manual protection (provenance): a unit that is powered ON but the rule did NOT
    // start (dashboard, remote, or schedule) is hands-off — never auto-off, never
    // retune. (A unit it owns may still be retuned.)
    if (isManual(u.id, u.power)) continue;
    if (isManualOverrideActive(u.id)) continue; // timed manual hold — hands off too
    const room = u.currentTempC;

    // Demand for THIS direction, with start hysteresis so a unit doesn't chatter at the
    // trigger: cool only when room > limit + ½ band; heat only when room < floor − ½ band.
    // Incomplete battery data ⇒ headroom is under-counted ⇒ surplus may be overstated, so
    // refuse to START (stops are unaffected below — stopping is always safe).
    const surplusOk =
      !inExitBand && snap.batteryDataComplete && snap.surplusW > startThreshold && room !== null;
    const wantAction =
      surplusOk && (dir === 'cool' ? room! > triggerC + half : room! < triggerC - half);

    // ----- STOP conditions (debounced) -----
    // Reached the comfort target for this direction.
    const roomAtTarget =
      room !== null && (dir === 'cool' ? room <= targetC : room >= targetC);
    // "No longer free solar" — surplus gone OR actually importing from the grid (a
    // deficit). After the sustained-clear window the unit is stopped so it never
    // becomes a grid-import load.
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

    // Minimum-run floor (anti-chatter): while a rule-owned unit is inside its min-run window,
    // suppress the SOFT stops (room reached target / surplus cleared) so a fluctuating surplus
    // can't switch it on/off repeatedly. The tariff-band (P1 peak) stand-down is NOT held —
    // entering the expensive band always stops immediately. Tradeoff: if solar collapses right
    // after a start the unit may draw from the grid for up to minRun; bounded by that window.
    const startedAt = surplusStartedAt.get(u.id);
    const withinMinRun =
      u.power && surplusOwns(u.id) && startedAt != null && Date.now() - startedAt < minRunMs;
    const softStop = surplusSustainedClear || roomAtTarget;

    const shouldStop = u.power && (inExitBand || (softStop && !withinMinRun));

    if (shouldStop) {
      const why = inExitBand
        ? `band ${snap.band} (exit)`
        : roomAtTarget
          ? `room ${room}°C at ${dir} target ${targetC}°C`
          : `${importingFromGrid ? `grid import ${snap.gridImportKw.toFixed(1)}kW` : 'no surplus'} ${Math.round(clearedFor / 1000)}s ≥ ${p.surplusClearSec}s`;
      const reason = `${automation.name}: stop — ${why}`;
      const res = await issueClimate(u, 'power', false, reason, { ...snap, pendingImportKw });
      // Only release ownership if the off ACTUALLY succeeded. issueClimate returns ok:false
      // (never throws) on a cloud error, rate-limit, or guardrail reject. Dropping a unit on a
      // FAILED off would orphan a still-running unit (on + unowned ⇒ falsely "manual" ⇒ never
      // stopped again — the all-night-runner bug). Keep it owned so the next tick retries the off.
      // Mirrors the start path's `if (res.ok) addSurplusStarted(...)` guard below.
      if (res.ok) dropSurplusStarted(u.id);
      continue;
    }

    if (!wantAction) continue; // within hysteresis or comfortable — hold.

    // ----- START / maintain -----
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

    const reason = `${automation.name}: ${dir}@${targetC}°C (room ${room}°C, surplus ${(snap.surplusW / 1000).toFixed(1)}kW)`;
    // Drive a COMPLETE, consistent setting on every unit the rule runs:
    // mode + target setpoint + fan speed + vanes(auto) + power on.
    // Order: mode → setpoint → fan → vanes → power. All of mode/setpoint/fan/vanes are
    // re-issued each maintain tick (issueClimate no-ops when already in place), so the unit
    // stays pinned at the configured mode/setpoint/fan and both vanes stay on AUTO (0) —
    // the rule never leaves a vane stuck in a fixed position it inherited from a remote/schedule.
    await issueClimate(u, 'mode', dir, reason, { ...snap, pendingImportKw });
    await issueClimate(u, 'setpoint', targetC, reason, { ...snap, pendingImportKw });
    await issueClimate(u, 'fan', fanLevel, reason, { ...snap, pendingImportKw });
    await issueClimate(u, 'vaneUpDown', 0, reason, { ...snap, pendingImportKw }); // 0 = auto
    await issueClimate(u, 'vaneLeftRight', 0, reason, { ...snap, pendingImportKw }); // 0 = auto
    const res = await issueClimate(u, 'power', true, reason, { ...snap, pendingImportKw });
    if (res.ok) addSurplusStarted(u.id); // rule owns this unit now (persisted)
    // Stamp the min-run start ONLY on a true compressor start (not maintain ticks, which would
    // otherwise keep resetting the floor and stop it ever elapsing).
    if (res.ok && startingCompressor) {
      surplusStartedAt.set(u.id, Date.now());
      pendingImportKw += COMPRESSOR_START_KW;
    }
  }

  store.update((s) => {
    const a = s.automations.find((x) => x.id === automation.id);
    if (a) a.lastEval = Date.now();
  });
}

/** COOLING-ONLY solar-surplus rule (solar_surplus_precool): cool warm rooms on surplus. */
export async function evaluateSolarSurplusPrecool(
  automation: Automation,
  fleet: ClimateUnit[],
  snap: RichClimateSnapshot,
): Promise<void> {
  await evaluateSurplusDirection(automation, 'cool', fleet, snap);
}

/** HEATING-ONLY solar-surplus rule (solar_surplus_preheat): heat cold rooms on surplus. */
export async function evaluateSolarSurplusPreheat(
  automation: Automation,
  fleet: ClimateUnit[],
  snap: RichClimateSnapshot,
): Promise<void> {
  await evaluateSurplusDirection(automation, 'heat', fleet, snap);
}

function hhmmToMin(s: string): number {
  const [h, m] = s.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** 'auto' → 0 (auto/A); a 1..5 position → itself. For fan/vane datapoints. */
function levelOf(v: store.FanSetting | store.VaneSetting): number {
  return v === 'auto' ? 0 : v;
}

function resolveAnchorMin(
  fixedHHMM: string,
  anchor: store.TimeAnchor | undefined,
  offsetMin: number,
  sunriseMin: number,
  sunsetMin: number,
): number {
  if (!anchor || anchor === 'fixed') return hhmmToMin(fixedHHMM);
  return (anchor === 'sunrise' ? sunriseMin : sunsetMin) + offsetMin;
}

/**
 * Is ONE window active right now (local time)? Handles overnight wrap. `days` are
 * the RULE's weekdays; the active "day" of a wrapped window is when it started.
 */
function windowActiveNow(w: store.ScheduleWindow, days: number[], now: Date): boolean {
  const cur = now.getHours() * 60 + now.getMinutes();
  const { sunriseMin, sunsetMin } = sunriseSunsetMin(config.site.lat, config.site.lon, now);
  const a = resolveAnchorMin(w.start, w.startAnchor, w.startOffsetMin ?? 0, sunriseMin, sunsetMin);
  const b = resolveAnchorMin(w.end, w.endAnchor, w.endOffsetMin ?? 0, sunriseMin, sunsetMin);
  // normalise resolved times to [0, 1440)
  const aN = ((Math.round(a) % 1440) + 1440) % 1440;
  const bN = ((Math.round(b) % 1440) + 1440) % 1440;
  const dow = now.getDay(); // 0=Sun..6=Sat (local)
  if (aN < bN) return cur >= aN && cur < bN && days.includes(dow);
  // overnight wrap (or degenerate aN===bN = all-day)
  if (cur >= aN) return days.includes(dow); // evening part — started today
  if (cur < bN) return days.includes((dow + 6) % 7); // morning part — started yesterday
  return false;
}

/** The first active window of a rule, or null if none is active now. */
function activeWindow(s: store.Schedule, now: Date): store.ScheduleWindow | null {
  for (const w of s.windows) if (windowActiveNow(w, s.days, now)) return w;
  return null;
}

/** Effective action for a window = rule.action with the window's overrides merged on top. */
function effectiveAction(s: store.Schedule, w: store.ScheduleWindow): store.Action {
  return { ...s.action, ...(w.action ?? {}) };
}

/** Does the rule's run-condition allow it to act given the current room temp? */
function conditionMet(c: store.RunCondition, roomTempC: number | null): boolean {
  if (c.kind === 'always') return true;
  if (roomTempC === null) return false; // a temp-gated rule can't act without a reading
  if (c.kind === 'warmerThan') return roomTempC > c.thresholdC;
  return roomTempC < c.thresholdC; // coolerThan
}

/**
 * Apply enabled rules whose window is active now. Each rule targets a single unit;
 * the effective action (rule.action + window override) sets mode/setpoint/fan/vanes
 * and powers the unit on. A run-condition (warmer/cooler than) gates whether it acts
 * at all. Conservative: never forces a unit OFF. Guardrailed + compressor-staggered.
 */
export async function evaluateSchedules(fleet: ClimateUnit[], snap: RichClimateSnapshot): Promise<void> {
  const schedules = store.get().schedules.filter((s) => s.enabled && s.scope.kind === 'unit');
  if (schedules.length === 0) return;
  const byId = new Map(fleet.map((u) => [u.id, u]));
  const now = new Date();
  let pendingImportKw = 0;

  for (const s of schedules) {
    const w = activeWindow(s, now);
    if (!w) continue;
    const u = byId.get((s.scope as { kind: 'unit'; deviceId: string }).deviceId);
    if (!u) continue;
    if (isManualOverrideActive(u.id)) continue; // manual control wins — hands off
    if (!conditionMet(s.condition, u.currentTempC)) {
      logDecision(u.id, `rule ${s.name}: skip`, `condition ${s.condition.kind} not met (room ${u.currentTempC ?? '—'}°C)`);
      continue;
    }
    const act = effectiveAction(s, w);
    const reason = `rule ${s.name}: ${act.mode}@${act.setpointC}°C`;
    const startingCompressor = !u.power && act.power;
    const projected = snap.gridImportKw + pendingImportKw + (startingCompressor ? COMPRESSOR_START_KW : 0);
    if (startingCompressor && projected > store.get().devices.guardrails.gridImportCapKw) {
      logDecision(u.id, `rule ${s.name}: defer start`, `staggering — projected ${projected.toFixed(1)}kW > cap`);
      continue;
    }
    await issueClimate(u, 'mode', act.mode, reason, { ...snap, pendingImportKw });
    await issueClimate(u, 'setpoint', act.setpointC, reason, { ...snap, pendingImportKw });
    await issueClimate(u, 'fan', levelOf(act.fan), reason, { ...snap, pendingImportKw });
    await issueClimate(u, 'vaneUpDown', levelOf(act.vaneUpDown), reason, { ...snap, pendingImportKw });
    await issueClimate(u, 'vaneLeftRight', levelOf(act.vaneLeftRight), reason, { ...snap, pendingImportKw });
    if (act.power) {
      const res = await issueClimate(u, 'power', true, reason, { ...snap, pendingImportKw });
      if (res.ok && startingCompressor) pendingImportKw += COMPRESSOR_START_KW;
    }
  }
}

async function tick(): Promise<void> {
  try {
    const dev = store.get().devices;
    if (!dev.armed || dev.mode !== 'auto') return; // self-gated: inert unless armed+auto

    // Blinds schedules (Tuya) run independently of the climate fleet — do them
    // first so they still fire when no AC/underfloor integration is configured.
    await evaluateBlindSchedules();

    if (!intesis.isConfigured() && !airzone.isConfigured()) return;

    const automations = store.get().automations.filter((a) => a.enabled);
    const schedules = store.get().schedules.filter((s) => s.enabled);
    if (automations.length === 0 && schedules.length === 0) return;

    // Combined fleet across both connectors (cooling = Intesis, heating = Airzone).
    // Soft-fail per connector so one being unreachable doesn't starve the other.
    const fleet: ClimateUnit[] = [];
    if (intesis.isConfigured()) {
      try { fleet.push(...(await intesis.getFleet())); } catch (e) { console.error('[climate] intesis fleet:', (e as Error).message); }
    }
    if (airzone.isConfigured()) {
      try { fleet.push(...(await airzone.getFleet())); } catch (e) { console.error('[climate] airzone fleet:', (e as Error).message); }
    }
    if (fleet.length === 0) return;

    const snap = await takeClimateSnapshot();
    if (snap.ageMs > 120_000) {
      store.update((s) => {
        s.devices.lastError = 'climate coordinator: live data stale — tick skipped';
      });
      return;
    }

    // EV (car) solar/P3 charging runs FIRST (docs/33): the car claims surplus before cooling.
    // It returns the draw it has reserved on the breaker(s) it holds ON; we subtract that from
    // the surplus the cooling/heating evaluations see, so AC only runs on the leftover. A no-op
    // (reservedW = 0) unless a breaker is opted into solarP3Only. Never throws into the tick.
    let reservedW = 0;
    try {
      ({ reservedW } = await evaluateEvSurplus(snap));
    } catch (e) {
      console.error('[climate] ev-surplus eval failed:', (e as Error).message);
    }
    // The surplus the cooling/heating rules reason about, net of the car's reserved draw.
    const coolingSnap: RichClimateSnapshot =
      reservedW > 0 ? { ...snap, surplusW: snap.surplusW - reservedW } : snap;

    // Schedules are the floor; the surplus automation runs after and may pre-condition
    // earlier or push harder when free solar is available. Schedules keep their prior
    // cooling-only reach (Airzone underfloor is excluded here).
    await evaluateSchedules(fleet.filter((u) => !isAirzone(u)), snap);

    for (const a of automations) {
      if (a.type === 'solar_surplus_precool') {
        await evaluateSolarSurplusPrecool(a, fleet, coolingSnap);
      } else if (a.type === 'solar_surplus_preheat') {
        await evaluateSolarSurplusPreheat(a, fleet, coolingSnap);
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
  const owned = store.get().devices.surplusStartedIds;
  if (owned.length === 0) return 0;
  if (!intesis.isConfigured()) {
    store.update((s) => { s.devices.surplusStartedIds = []; });
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
  // parallel to bound wall-clock (matters on the shutdown grace window). Only act on
  // units the rule still owns that are on and not under a manual hold.
  const targets = fleet.filter(
    (u) => surplusOwns(u.id) && u.power && !isManualOverrideActive(u.id),
  );
  // Drop any tracked id we won't act on (already off / now manual / gone) from the set.
  for (const id of owned) {
    if (!targets.some((u) => u.id === id)) dropSurplusStarted(id);
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
      dropSurplusStarted(r.id);
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
  offSeenCount.clear();
  surplusStartedAt.clear();
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
