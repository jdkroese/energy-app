// EV (car) solar / P3 charging rule for a metered Tuya circuit breaker (docs/33).
//
// The car charger sits on a metered circuit breaker (`type:'circuit'`, on/off only, no
// modulation). When the owner opts a breaker into "Solar / P3 charging only"
// (deviceSettings[id].solarP3Only === true) AND the devices layer is armed+auto, this rule
// owns that breaker: it turns it ON only when there is genuine solar surplus OR the cheap P3
// tariff band is active, and OFF otherwise — with hysteresis + an anti-chatter min-cycle.
//
// PRIORITY (owner decision): Battery → Car → Cooling. The surplus we reason about is
// climateSurplusW (PV − houseLoad − battery intake headroom), so the battery soak-export loop
// is unchanged. The car claims surplus FIRST and RESERVES its draw; the climate coordinator
// subtracts reservedW before evaluating surplus cooling, so cooling only runs on the leftover.
//
// SAFE BY DEFAULT: solarP3Only defaults false everywhere ⇒ deploying this changes NOTHING
// until the owner opts in per breaker. When off, or when not armed+auto, evaluateEvSurplus is a
// pure no-op: it issues no commands and returns reservedW = 0.
//
// PROVENANCE: only breakers the rule itself switched ON are ever switched OFF (evState[id].ruleOn).
// A breaker a person / schedule turned on is never fought. The auto-learned draw (learnedDrawW)
// is an EMA of the breaker's measured cur_power while on, so two cars on one breaker are handled.
//
// Best-effort + self-contained: every path is guarded; this never throws into the climate tick.

import * as store from '../store';
import * as tuya from '../connectors/tuya';
import { deriveCapabilities, applyOverrides, type Capability } from '../connectors/tuya-inference';
import { buildGenericCommands } from '../connectors/tuya-generic';
import type { TuyaDevice, TuyaSpec } from '../connectors/tuya';
import type { RichClimateSnapshot } from './climate-snapshot';

/** EMA smoothing for the learned draw (0..1). 0.2 = ~10-sample memory, robust to a noisy read. */
const LEARN_ALPHA = 0.2;

/** DP codes that are a primary power switch (prefer these for the on/off lever). Mirrors the
 *  device-schedule coordinator's set so we drive the same relay it does. */
const PRIMARY_POWER_DPS = new Set([
  'switch', 'switch_1', 'switch_2', 'switch_3', 'switch_4', 'switch_5', 'switch_6', 'fan_switch',
]);

/** The power on/off switch capability: a primary-power dp if present, else the first switch. */
function powerCapOf(caps: Capability[]): Capability | null {
  return (
    caps.find((c) => c.kind === 'switch' && PRIMARY_POWER_DPS.has(c.dp)) ??
    caps.find((c) => c.kind === 'switch') ??
    null
  );
}

function statusNum(d: TuyaDevice, code: string): number | null {
  const item = d.status.find((s) => s.code === code);
  if (!item) return null;
  const n = typeof item.value === 'number' ? item.value : Number(item.value);
  return Number.isFinite(n) ? n : null;
}

/** Scale a raw cur_power reading → W (same deci-unit heuristic as breaker-metering/tuya-voltage). */
function powerToWatts(raw: number | null): number | null {
  if (raw === null) return null;
  return Math.round((raw > 100000 ? raw / 10 : raw) * 10) / 10;
}

/** The current on/off state of the breaker's power switch (false when unknown). */
function powerStateOf(d: TuyaDevice, powerCap: Capability): boolean {
  const item = d.status.find((s) => s.code === powerCap.dp);
  return item ? Boolean(item.value) : false;
}

/** Best-effort spec fetch (cached in the connector); null on failure. */
async function specFor(id: string): Promise<TuyaSpec | null> {
  try {
    return await tuya.getSpecifications(id);
  } catch {
    return null;
  }
}

/** Append an EV-rule decision to the device/climate command log. */
function logEv(deviceId: string, to: 'on' | 'off' | null, reason: string, detail: string, ok = true): void {
  store.update((s) => {
    s.devices.log.push({ ts: Date.now(), deviceId, lever: 'ev', from: null, to, reason, ok, detail });
    s.devices.log = store.pruneLog(s.devices.log);
    if (!ok) s.devices.lastError = `EV breaker ${deviceId}: ${detail}`;
  });
}

/** Read + coerce the persisted per-breaker EV runtime state (defaults when absent). */
function evStateOf(id: string): store.EvBreakerState {
  const s = store.get().devices.evState[id];
  return s ?? { ruleOn: false, lastSwitchTs: 0, surplusClearedSince: 0, reason: 'off', reservedW: 0 };
}

/** Persist a partial update to a breaker's EV runtime state. */
function setEvState(id: string, patch: Partial<store.EvBreakerState>): void {
  store.update((s) => {
    const prev = s.devices.evState[id] ?? {
      ruleOn: false, lastSwitchTs: 0, surplusClearedSince: 0, reason: 'off' as const, reservedW: 0,
    };
    s.devices.evState[id] = { ...prev, ...patch };
  });
}

/** Switch the breaker via the dual-API Tuya path (mirrors device-schedule-coordinator). */
async function switchBreaker(d: TuyaDevice, powerCap: Capability, spec: TuyaSpec | null, on: boolean): Promise<boolean> {
  try {
    const cmds = buildGenericCommands(d, powerCap, { dp: powerCap.dp, kind: 'switch', value: on }, spec);
    await tuya.sendCommandsDual(d.id, cmds);
    tuya.invalidateFleet();
    return true;
  } catch (e) {
    logEv(d.id, on ? 'on' : 'off', 'EV solar/P3', (e as Error).message, false);
    return false;
  }
}

/** The set of configured breakers opted into the EV rule, mapped to their live device. A breaker
 *  that's opted in but missing from the bulk fleet (e.g. its cloud link blipped out of
 *  /associated-users/devices) is recovered with a direct per-device read so the rule can still
 *  act on it once it's reachable. */
async function enrolledBreakers(all: TuyaDevice[]): Promise<TuyaDevice[]> {
  const settings = store.get().deviceSettings;
  const configured = store.get().deviceOnboarding.configured;
  const byId = new Map(all.map((d) => [d.id, d]));
  const out: TuyaDevice[] = [];
  for (const id of Object.keys(configured)) {
    if (settings[id]?.solarP3Only !== true) continue;
    const d = byId.get(id) ?? (await tuya.getDeviceDirect(id));
    if (d) out.push(d);
  }
  return out;
}

/**
 * Evaluate the EV-surplus rule for ALL opted-in breakers and return the TOTAL draw (W) the
 * rule has reserved (sum across breakers it currently holds ON). The climate coordinator
 * subtracts this from the surplus the cooling/heating evaluations see, so the car claims
 * surplus before cooling. Pure no-op (returns 0, issues nothing) when no breaker is opted in.
 *
 * Gating is the caller's responsibility for armed+auto AND mirrored here defensively: if the
 * devices layer isn't armed+auto, the rule does nothing and reserves nothing.
 */
export async function evaluateEvSurplus(snap: RichClimateSnapshot): Promise<{ reservedW: number }> {
  const dev = store.get().devices;
  if (!dev.armed || dev.mode !== 'auto') return { reservedW: 0 };
  if (!tuya.isConfigured()) return { reservedW: 0 };

  let all: TuyaDevice[];
  try {
    all = await tuya.getDevices();
  } catch {
    return { reservedW: 0 }; // can't read the fleet — reserve nothing this tick
  }
  const breakers = await enrolledBreakers(all);
  if (breakers.length === 0) return { reservedW: 0 };

  const tun = dev.evSurplus;
  const configured = store.get().deviceOnboarding.configured;
  let totalReservedW = 0;

  // The surplus the EV rule may spend is the snapshot surplus minus what other EV breakers in
  // THIS tick have already reserved, so two enrolled breakers don't both claim the same surplus.
  for (const d of breakers) {
    try {
      const reserved = await evaluateOne(d, snap, tun, totalReservedW, configured[d.id]?.capOverrides);
      totalReservedW += reserved;
    } catch (e) {
      logEv(d.id, null, 'EV solar/P3', `tick error: ${(e as Error).message}`, false);
    }
  }
  return { reservedW: Math.round(totalReservedW) };
}

/** Evaluate one breaker; returns the W it reserves (0 when off). */
async function evaluateOne(
  d: TuyaDevice,
  snap: RichClimateSnapshot,
  tun: store.EvSurplusTunables,
  alreadyReservedW: number,
  capOverrides: Parameters<typeof applyOverrides>[1],
): Promise<number> {
  const spec = await specFor(d.id);
  const caps = applyOverrides(deriveCapabilities(d, spec), capOverrides);
  const powerCap = powerCapOf(caps);
  if (!powerCap) return 0; // not switchable — nothing to do

  const settings = store.get().deviceSettings[d.id] ?? {};
  const st = evStateOf(d.id);
  const now = Date.now();

  const isOn = powerStateOf(d, powerCap);
  const measuredW = powerToWatts(statusNum(d, 'cur_power'));
  const learnedDrawW = typeof settings.learnedDrawW === 'number' ? settings.learnedDrawW : tun.estimateW;

  // ---- Auto-learn the draw (EMA of measured power while on, above the learn floor). -------
  if (isOn && measuredW != null && measuredW > tun.learnFloorW) {
    const next = Math.round(LEARN_ALPHA * measuredW + (1 - LEARN_ALPHA) * learnedDrawW);
    if (next !== learnedDrawW) {
      store.update((s) => {
        const ds = s.deviceSettings[d.id] ?? {};
        s.deviceSettings[d.id] = { ...ds, learnedDrawW: next };
      });
    }
  }
  // Use the freshly-updated learned draw for this tick's thresholds.
  const draw = typeof store.get().deviceSettings[d.id]?.learnedDrawW === 'number'
    ? (store.get().deviceSettings[d.id]!.learnedDrawW as number)
    : tun.estimateW;

  // ---- Provenance reconcile: if the rule thought it owned the breaker but it reads OFF,
  // someone turned it off — release ownership so we never claim a breaker we don't hold. ----
  if (st.ruleOn && !isOn) {
    setEvState(d.id, { ruleOn: false, surplusClearedSince: 0, reason: 'off', reservedW: 0 });
    st.ruleOn = false;
  }
  // A breaker that is ON but the rule did NOT start (manual / schedule) is HANDS-OFF: never
  // switch it off, never reserve its draw against cooling (the owner is driving it directly).
  if (isOn && !st.ruleOn) {
    setEvState(d.id, { reason: 'off', reservedW: 0 });
    return 0;
  }

  // ---- Decide whether charging is ALLOWED this tick. -------------------------------------
  // Available surplus for THIS breaker = snapshot surplus minus what earlier EV breakers
  // reserved this tick. batteryDataComplete guards a START (overstated surplus otherwise).
  const availSurplusW = snap.surplusW - alreadyReservedW;
  const startThresholdW = draw + tun.startMarginW;
  const stopBandW = draw - tun.stopHysteresisW;

  const bandIsP3 = snap.band === 'P3';
  // Solar allow: to START need fresh surplus ≥ threshold (+ complete battery data). To STAY on
  // (already rule-on) tolerate surplus down to the stop band before the clear timer starts.
  const surplusStart = snap.batteryDataComplete && availSurplusW >= startThresholdW;
  const surplusHold = availSurplusW >= stopBandW;

  // minCycle anti-chatter: don't toggle faster than minCycleMin since the last switch.
  const sinceSwitchMs = now - st.lastSwitchTs;
  const minCycleMs = tun.minCycleMin * 60_000;
  const cycleLocked = st.lastSwitchTs > 0 && sinceSwitchMs < minCycleMs;

  if (!st.ruleOn) {
    // ----- Currently OFF (rule-released or never on) → consider turning ON. -----
    const allow = bandIsP3 || surplusStart;
    if (!allow) {
      setEvState(d.id, { reason: 'waiting', reservedW: 0, surplusClearedSince: 0 });
      return 0;
    }
    if (cycleLocked) {
      setEvState(d.id, { reason: 'waiting', reservedW: 0 });
      return 0; // wait out the min-cycle before switching on again
    }
    const reason = bandIsP3 ? 'P3 valley' : `surplus ${(availSurplusW / 1000).toFixed(1)}kW ≥ ${(startThresholdW / 1000).toFixed(1)}kW`;
    const ok = await switchBreaker(d, powerCap, spec, true);
    if (!ok) {
      setEvState(d.id, { reason: 'waiting', reservedW: 0 });
      return 0; // failed on — keep unowned, retry next tick
    }
    const reservedW = Math.max(measuredW ?? 0, draw);
    setEvState(d.id, {
      ruleOn: true,
      lastSwitchTs: now,
      surplusClearedSince: 0,
      reason: bandIsP3 ? 'p3' : 'surplus',
      reservedW,
    });
    logEv(d.id, 'on', 'EV solar/P3', `on — ${reason}`);
    return reservedW;
  }

  // ----- Currently rule-ON → hold or stop. -----
  // P3 keeps it on regardless of surplus (owner explicitly wants P3 grid-charging).
  // On solar, hold while surplus stays above the stop band; once it sits below for
  // surplusClearSec, stop (debounced) so a passing cloud doesn't drop the charge.
  const allowedToHold = bandIsP3 || surplusHold;

  if (allowedToHold) {
    // Clear any pending stop timer; reserve the live draw against cooling.
    const reservedW = Math.max(measuredW ?? 0, draw);
    setEvState(d.id, {
      surplusClearedSince: 0,
      reason: bandIsP3 ? 'p3' : 'surplus',
      reservedW,
    });
    return reservedW;
  }

  // Not allowed → start/continue the sustained-clear timer.
  const clearedSince = st.surplusClearedSince > 0 ? st.surplusClearedSince : now;
  const clearedForMs = now - clearedSince;
  if (st.surplusClearedSince === 0) setEvState(d.id, { surplusClearedSince: now });

  const sustainedClear = clearedForMs >= tun.surplusClearSec * 1000;
  if (!sustainedClear || cycleLocked) {
    // Still within the clear window OR cycle-locked — keep holding (and still reserving) for now.
    const reservedW = Math.max(measuredW ?? 0, draw);
    setEvState(d.id, { reason: 'surplus', reservedW });
    return reservedW;
  }

  // Sustained clear + min-cycle satisfied → switch OFF (only ever a breaker WE turned on).
  const ok = await switchBreaker(d, powerCap, spec, false);
  if (!ok) {
    // failed off — keep ownership + reservation so we retry next tick (never orphan it on).
    const reservedW = Math.max(measuredW ?? 0, draw);
    setEvState(d.id, { reason: 'surplus', reservedW });
    return reservedW;
  }
  setEvState(d.id, { ruleOn: false, lastSwitchTs: now, surplusClearedSince: 0, reason: 'off', reservedW: 0 });
  logEv(d.id, 'off', 'EV solar/P3', `off — no surplus for ${Math.round(clearedForMs / 1000)}s ≥ ${tun.surplusClearSec}s`);
  return 0;
}
