// The climate coordinator loop. Runs every 45s but ACTS only when the devices
// layer is armed && mode==='auto'. Each tick it evaluates enabled automations
// against a fresh snapshot and issues guardrailed commands through issueClimate()
// for every enabled automation (there is no longer a shadow/dry-run authority —
// an enabled automation under armed+auto always acts). The whole tick is wrapped
// so it can never crash the process.
//
// Automation type: solar_surplus_precool now drives the Intesis HVAC fleet in BOTH
// directions ("solar climate"): a room ABOVE its comfort limit is COOLED, a room
// BELOW its setpoint is HEATED — both only while solar surplus exceeds battery intake
// headroom, both stopping when surplus clears sustained ≥ surplusClearSec, OR the room
// reaches target, OR the tariff turns to the exit band (P1). A cool↔heat DEADBAND
// stops a unit flip-flopping direction within a window. Starts are staggered under the
// 14 kW cap. (solar_surplus_preheat is retained as a legacy no-op type; the Airzone
// underfloor fleet is no longer surplus-eligible.)
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

const TICK_MS = 45_000;
let timer: ReturnType<typeof setInterval> | null = null;

// Per-device "surplus first dropped at" timestamp, for the sustained-clear debounce.
const surplusClearedSince = new Map<string, number>();

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

// Deadband (°C) around the cool/heat decision so a unit can't flip direction within a
// window: cool only when room > limit + half-band; heat only when room < setpoint −
// half-band. Between those, the unit holds whatever direction it's already in.
const DIRECTION_DEADBAND_C = 1.0;

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
  const mins = store.get().devices.guardrails.manualOverrideMin ?? 120;
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
    if (s.devices.log.length > 100) s.devices.log = s.devices.log.slice(-100);
  });
}

/**
 * Evaluate the unified solar_surplus_precool ("solar climate") automation against the
 * Intesis HVAC fleet. An enrolled HVAC is driven in WHICHEVER direction the room needs:
 *   • room ABOVE roomTempLimitC      → COOL toward targetSetpointC
 *   • room BELOW heatRoomFloorC      → HEAT toward heatTargetSetpointC
 * Both directions share the same surplus start threshold, exit-band stand-down,
 * import cap, sustained-clear stop and rate-limit guards. A cool↔heat DEADBAND keeps a
 * running unit from flipping direction within a window. Manual-ON units (user-owned)
 * are skipped entirely — never powered off, never retuned. An enabled automation under
 * armed+auto always acts. Best-effort; never throws.
 */
export async function evaluateSolarSurplusPrecool(
  automation: Automation,
  fleet: ClimateUnit[],
  snap: RichClimateSnapshot,
): Promise<void> {
  const p: SolarSurplusPrecoolParams = automation.params;
  const startThreshold = p.startThresholdW ?? 800;
  // Heating bounds default for legacy precool-only rules that predate the unified type.
  const heatFloor = p.heatRoomFloorC ?? 19;
  const heatTarget = p.heatTargetSetpointC ?? 21;
  const settings = store.get().deviceSettings;

  // Optional tariff-band stand-down: when enabled, never start in the exit band (P1
  // peak) and stop any unit running in it. Off ⇒ band is ignored entirely. Undefined
  // (legacy persisted rules) defaults to ON to preserve prior behavior.
  const bandRestrictionOn = p.bandRestrictionEnabled ?? true;
  const inExitBand = bandRestrictionOn && snap.band === p.exitBand;
  const half = DIRECTION_DEADBAND_C / 2;

  // Candidate devices: HVAC (NON-Airzone) rooms enrolled in EITHER surplus direction.
  // Cool and heat are now independent per-unit flags (solarCoolEnabled / solarHeatEnabled);
  // a unit is a candidate if it opts into at least one. Underfloor zones are no longer
  // surplus-eligible. Evaluate WARMEST-FIRST so the hottest room wins the first compressor
  // start under the 14 kW cap (heating starts follow).
  const coolOn = (id: string) => settings[id]?.solarCoolEnabled === true;
  const heatOn = (id: string) => settings[id]?.solarHeatEnabled === true;
  const enabled = fleet
    .filter((u) => !isAirzone(u) && (coolOn(u.id) || heatOn(u.id)))
    .sort((a, b) => (b.currentTempC ?? -Infinity) - (a.currentTempC ?? -Infinity));

  // Track committed import as we stagger starts within this tick.
  let pendingImportKw = 0;

  for (const u of enabled) {
    // Provenance reconcile: if a rule-started unit is observed OFF (someone turned it
    // off), drop it from the set so it's no longer considered rule-owned.
    if (!u.power && surplusOwns(u.id)) dropSurplusStarted(u.id);

    // Manual protection (provenance): a unit that is powered ON but the rule did NOT
    // start (dashboard, remote, or schedule) is hands-off — never auto-off, never
    // retune. This is BEFORE the stop branch and the start/retune branch, so the rule
    // only ever stops/retunes units it owns. (A unit it owns may still be retuned.)
    if (isManual(u.id, u.power)) continue;
    if (isManualOverrideActive(u.id)) continue; // timed manual hold — hands off too
    const room = u.currentTempC;

    // Direction with a deadband so a running unit won't flip cool↔heat mid-window:
    //  - cool only when clearly warm (room > limit + ½ band) AND enrolled in cooling
    //  - heat only when clearly cold (room < floor − ½ band) AND enrolled in heating
    // Each direction is an independent per-unit enrolment (solarCool/HeatEnabled).
    const surplusOk = !inExitBand && snap.surplusW > startThreshold && room !== null;
    const wantCool = surplusOk && coolOn(u.id) && room! > p.roomTempLimitC + half;
    const wantHeat = surplusOk && heatOn(u.id) && !wantCool && room! < heatFloor - half;
    const dir: 'cool' | 'heat' | null = wantCool ? 'cool' : wantHeat ? 'heat' : null;
    const targetC = dir === 'heat' ? heatTarget : p.targetSetpointC;

    // ----- STOP conditions (debounced) -----
    // Reached the comfort target for whichever direction is (or was) running. When the
    // unit is on and we have no fresh direction, judge "at target" by its current mode.
    const runningHeat = u.mode === 'heat';
    const roomAtTarget =
      room !== null &&
      ((dir === 'cool' || (dir === null && !runningHeat)) ? room <= p.targetSetpointC : room >= heatTarget);
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

    const shouldStop = u.power && (surplusSustainedClear || roomAtTarget || inExitBand);

    if (shouldStop) {
      const why = inExitBand
        ? `band ${snap.band} (exit)`
        : roomAtTarget
          ? `room ${room}°C at ${runningHeat ? `heat target ${heatTarget}` : `cool target ${p.targetSetpointC}`}°C`
          : `${importingFromGrid ? `grid import ${snap.gridImportKw.toFixed(1)}kW` : 'no surplus'} ${Math.round(clearedFor / 1000)}s ≥ ${p.surplusClearSec}s`;
      const reason = `${automation.name}: stop — ${why}`;
      await issueClimate(u, 'power', false, reason, { ...snap, pendingImportKw });
      dropSurplusStarted(u.id);
      continue;
    }

    if (dir === null) continue; // in the deadband or comfortable — hold.

    // ----- START / maintain (cool or heat) -----
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

    const verb = dir === 'heat' ? 'heat' : 'cool';
    const reason = `${automation.name}: ${verb}@${targetC}°C (room ${room}°C, surplus ${(snap.surplusW / 1000).toFixed(1)}kW)`;
    // Drive: mode + target setpoint + power on. Order: mode → setpoint → power.
    await issueClimate(u, 'mode', dir, reason, { ...snap, pendingImportKw });
    await issueClimate(u, 'setpoint', targetC, reason, { ...snap, pendingImportKw });
    const res = await issueClimate(u, 'power', true, reason, { ...snap, pendingImportKw });
    if (res.ok) addSurplusStarted(u.id); // rule owns this unit now (persisted)
    if (res.ok && startingCompressor) pendingImportKw += COMPRESSOR_START_KW;
  }

  store.update((s) => {
    const a = s.automations.find((x) => x.id === automation.id);
    if (a) a.lastEval = Date.now();
  });
}

/**
 * LEGACY no-op. The former Airzone-underfloor pre-heat automation has been retired —
 * underfloor zones are no longer surplus-eligible, and the HVAC heating side is now
 * handled by the unified evaluateSolarSurplusPrecool ("solar climate"). Kept only so a
 * persisted solar_surplus_preheat rule on an existing install parses and stays inert.
 */
export async function evaluateSolarSurplusPreheat(
  automation: Automation,
  _fleet: ClimateUnit[],
  _snap: RichClimateSnapshot,
): Promise<void> {
  // Record that we saw it, but take no action.
  store.update((s) => {
    const a = s.automations.find((x) => x.id === automation.id);
    if (a) a.lastEval = Date.now();
  });
}

function hhmmToMin(s: string): number {
  const [h, m] = s.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** 'auto' → 0 (auto/A); a 1..5 position → itself. For fan/vane datapoints. */
function levelOf(v: store.FanSetting | store.VaneSetting): number {
  return v === 'auto' ? 0 : v;
}

/**
 * Is ONE window active right now (local time)? Handles overnight wrap. `days` are
 * the RULE's weekdays; the active "day" of a wrapped window is when it started.
 */
function windowActiveNow(w: store.ScheduleWindow, days: number[], now: Date): boolean {
  const cur = now.getHours() * 60 + now.getMinutes();
  const a = hhmmToMin(w.start);
  const b = hhmmToMin(w.end);
  const dow = now.getDay(); // 0=Sun..6=Sat (local)
  if (a < b) return cur >= a && cur < b && days.includes(dow);
  // wraps past midnight (e.g. 22:00→07:00, or end===start meaning all-day):
  if (cur >= a) return days.includes(dow); // evening part — started today
  if (cur < b) return days.includes((dow + 6) % 7); // morning part — started yesterday
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

    // Schedules are the floor; the surplus automation runs after and may pre-condition
    // earlier or push harder when free solar is available. Schedules keep their prior
    // cooling-only reach (Airzone underfloor is excluded here).
    await evaluateSchedules(fleet.filter((u) => !isAirzone(u)), snap);

    for (const a of automations) {
      if (a.type === 'solar_surplus_precool') {
        await evaluateSolarSurplusPrecool(a, fleet, snap);
      } else if (a.type === 'solar_surplus_preheat') {
        await evaluateSolarSurplusPreheat(a, fleet, snap);
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
