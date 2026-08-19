// Rain Bird irrigation coordinator — the smart-watering brain (Phase 2).
//
// ARCHITECTURE (locked with the owner — dead-man's-switch reliability):
//   • The controller's ONBOARD weekly program + keypad/switch is the autonomous FLOOR.
//     We NEVER clear or disable it. The LNK cannot reliably write the program, so we don't try.
//   • When the app/mini is HEALTHY we SUPPRESS that onboard program by holding a rolling
//     1-day rain-delay on the LNK, refreshed every tick. Then we run OUR OWN per-zone,
//     weather-trimmed plan by firing each zone via ManuallyRunStation(zone, minutes) at the
//     scheduled minute (the Phase-1 issueIrrigation('rb-<n>','run',min) write path).
//   • If the app/mini/LAN/deploy FAILS, the rain-delay lapses within ≤1 day and the
//     controller's onboard program RESUMES on its own. Fail-safe — the garden never dries out.
//
// ✅ SUPPRESSION ENABLED (SUPPRESS_ONBOARD_PROGRAM=true, 2026-08-19, owner): app-issued watering was
//   verified to physically open valves (after the ManuallyRunStation encoding fix, PR #235), so the
//   coordinator now holds the rolling rain-delay to suppress the onboard program and fires its own
//   weather-trimmed plan while healthy (mode=live + armed). If the app/mini/LAN fails the delay
//   lapses within ≤1 day and the controller's onboard program resumes on its own (fail-safe).
//
// PRODUCTION: the live actuation path runs ONLY when irrigation.mode === 'live' AND the Devices
// layer is armed (the same arm/admin gate as the other coordinators — enforced again inside
// issueIrrigation). When mode is 'live' but not actuating (disarmed / box unreachable) it still
// LOGS the intended run. Mode 'off' = dormant (the controller's own program runs). The retired
// 'shadow' mode (compute-and-log-only, never actuate) was removed in docs/39 §7.
//
// RAIN BYPASS (docs/39 §6): each tick we look 2h ahead of every scheduled run and, on the
// freshest daily forecast vs the bypass thresholds, record a skip/run DECISION honoured at fire
// time — so a wet-forecast run is skipped with a visible, logged reason.
//
// SYNC (single-writer-per-thing): the app owns the OPTIMIZED plan (zones, schedules, durations,
// photos, weather rules, suppression delay) and is the only writer of those. The baseline
// program is owned by the KEYPAD — we READ & mirror it (~daily), surface drift
// non-destructively, and NEVER overwrite it. Live state (active zone, rain-delay, manual runs
// at the unit) is read & reflected every tick. The physical keypad always wins.
//
// The LNK accepts ONE request at a time; the connector's transport already serializes calls,
// and this coordinator additionally issues its reads/writes sequentially (never in parallel).

import * as store from "../store";
import * as rainbird from "../connectors/rainbird";
import * as weather from "../connectors/weather";
import { issueIrrigation, lastAppRunTs } from "./irrigation-execute";
import {
  trimZone,
  rollupDayWeather,
  precipRateMmPerMin,
  type DayWeather,
  type ZoneTrim,
} from "./irrigation-engine";
import { logIrrigationDecision, logIrrigationSession } from "./log-adapters";
import type {
  IrrigationState,
  IrrigationZoneConfig,
  IrrigationWateringTime,
  IrrigationSkipDecision,
} from "../store";

const TICK_MS = 60_000;
let timer: ReturnType<typeof setInterval> | null = null;
let last: { day: number; min: number } | null = null;

/** The zone we last OBSERVED physically running (ground truth from the controller's
 *  active-zone read), when it started, and the id of its 'start' event (to pair the 'end').
 *  Drives the session-observer so EVERY watering run lands in the event log — app-initiated,
 *  keypad, or the onboard weekly program — with its measured duration. Null = valves idle. */
let observedRun: { zoneId: string; startedAt: number; startEventId?: string } | null =
  null;

/** A physical valve open counts as APP-initiated (already logged as run/fire) only if the app
 *  issued a run for that zone within this window before we first observed it active. Two ticks
 *  covers the fire→read-back→next-tick lag; anything older reads as an external/keypad start. */
const APP_RUN_CLAIM_MS = 2 * TICK_MS;

/** The rolling rain-delay (days) we hold on the controller to SUPPRESS its onboard program
 *  while we're healthy. 1 day = the shortest fail-safe lapse; refreshed every tick. */
export const SUPPRESSION_DELAY_DAYS = 1;

/**
 * MASTER SWITCH for onboard-program suppression. Set TRUE (2026-08-19, owner) now that Home-App
 * firing is confirmed to physically open valves (ManuallyRunStation encoding fix, PR #235). While
 * true the coordinator holds the rolling 1-day rain-delay to SUPPRESS the controller's onboard
 * weekly program and fires the app's own weather-trimmed plan instead — but ONLY while healthy
 * (mode=live + Devices armed). Handing back to the Rain Bird is the runtime ModeToggle: setting
 * irrigation mode to 'off' releases the held delay so the onboard program resumes immediately.
 */
export const SUPPRESS_ONBOARD_PROGRAM = true;

/** Whether the coordinator is currently suppressing the onboard program and running its own plan
 *  (true) vs. deferring to the controller's own schedule (false). Surfaced to the UI. */
export function isSuppressingOnboard(): boolean {
  return SUPPRESS_ONBOARD_PROGRAM;
}

/** How often we re-mirror the controller's baseline program (drift detection). ~daily. */
const BASELINE_MIRROR_MS = 24 * 60 * 60 * 1000;

/** Cache the Open-Meteo forecast so a 60s tick doesn't hammer the API. */
let wxCache: { ts: number; data: weather.WeatherForecast | null } | null = null;
const WX_TTL_MS = 30 * 60 * 1000;

async function forecastCached(): Promise<weather.WeatherForecast | null> {
  const now = Date.now();
  if (wxCache && now - wxCache.ts < WX_TTL_MS) return wxCache.data;
  const data = await weather.getForecast();
  // Only cache a successful fetch; a transient null should retry next tick.
  if (data) wxCache = { ts: now, data };
  return data ?? wxCache?.data ?? null;
}

/** Cache the multi-day daily outlook (rain sum + probability + ET₀) for the forecast strip and
 *  the 2h rain-bypass decision, on the same 30-min TTL as the hourly forecast. */
let outlookCache: { ts: number; data: weather.DailyOutlook[] } | null = null;

export async function getDailyOutlookCached(): Promise<
  weather.DailyOutlook[] | null
> {
  const now = Date.now();
  if (outlookCache && now - outlookCache.ts < WX_TTL_MS) return outlookCache.data;
  const data = await weather.getDailyOutlook(6);
  if (data) outlookCache = { ts: now, data };
  return data ?? outlookCache?.data ?? null;
}

function nowDM(d = new Date()): { day: number; min: number } {
  return { day: d.getDay(), min: d.getHours() * 60 + d.getMinutes() };
}

function hhmmToMin(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** Did a scheduled (weekday, minute) fall in the half-open interval (prev, now]? Mirrors the
 *  device-schedule coordinator's edge logic, including the midnight-straddle case. */
function crossed(
  prev: { day: number; min: number },
  now: { day: number; min: number },
  day: number,
  min: number,
): boolean {
  if (prev.day === now.day) {
    return now.day === day && prev.min < min && min <= now.min;
  }
  if (prev.day === day && min > prev.min) return true;
  if (now.day === day && min <= now.min) return true;
  return false;
}

/** Sum the scheduled minutes a zone runs on a given weekday (across all its watering times). */
export function scheduledMinForDay(
  zone: IrrigationZoneConfig,
  weekday: number,
): number {
  return zone.wateringTimes
    .filter((w) => w.days[weekday])
    .reduce((sum, w) => sum + Math.max(0, w.durationMin), 0);
}

/** The watering times due in (prev, now] for a zone, each with its weekday. */
function dueWateringTimes(
  zone: IrrigationZoneConfig,
  prev: { day: number; min: number },
  now: { day: number; min: number },
): IrrigationWateringTime[] {
  const due: IrrigationWateringTime[] = [];
  for (const w of zone.wateringTimes) {
    const startMin = hhmmToMin(w.startTime);
    // Check both today and (for the midnight straddle) the previous weekday.
    for (const day of [prev.day, now.day]) {
      if (w.days[day] && crossed(prev, now, day, startMin)) {
        due.push(w);
        break;
      }
    }
  }
  return due;
}

/** Compute the per-zone trims for "today" given the day's weather + each zone's deficit. */
export function computeTrims(
  irr: IrrigationState,
  weekday: number,
  day: DayWeather,
): ZoneTrim[] {
  const trims: ZoneTrim[] = [];
  for (const zone of Object.values(irr.zones)) {
    if (zone.managedBy !== "app") continue; // controller-owned zones aren't ours to fire/trim
    const scheduled = scheduledMinForDay(zone, weekday);
    const deficit = irr.deficits[zone.zoneId]?.mm ?? 0;
    const soil = irr.soilMoisture[zone.zoneId]?.pct;
    trims.push(
      trimZone(zone, scheduled, day, {
        globalRainSkipMm: irr.globalRainSkipMm,
        rainSkipProbabilityPct: irr.rainSkipProbabilityPct,
        deficitMm: deficit,
        soilMoisturePct: soil,
      }),
    );
  }
  return trims;
}

/** Append one coordinator decision to the irrigation log (also mirrored to the event bus). */
function log(
  zoneId: string,
  action: store.IrrigationLogEntry["action"],
  live: boolean,
  ok: boolean,
  detail: string,
): void {
  store.update((s) => {
    s.irrigation.log.push({ ts: Date.now(), zoneId, action, live, ok, detail });
    s.irrigation.log = store.pruneLog(s.irrigation.log);
    s.irrigation.updatedAt = Date.now();
    if (!ok) s.irrigation.lastError = `${zoneId}.${action}: ${detail}`;
  });
  // Shim: mirror the coordinator decision into the unified event bus (docs/37 §3).
  logIrrigationDecision(zoneId, action, live, ok, detail);
}

/** Whether the live actuation path may run: irrigation in 'live' AND Devices armed. The
 *  issueIrrigation write path re-checks the arm gate, so this is defence-in-depth. */
export function liveAllowed(s: store.StoreSchema = store.get()): boolean {
  return (
    s.irrigation.mode === "live" && s.devices.armed && s.devices.mode !== "off"
  );
}

/** Per-tick suppression: refresh the rolling rain-delay so the onboard program stays suppressed
 *  while we're healthy. Only writes when the live delay has drifted below our target (avoids a
 *  pointless write every 60s) — the keypad always wins, so a manually-set LONGER delay is left. */
async function refreshSuppression(currentDelayDays: number): Promise<void> {
  if (currentDelayDays >= SUPPRESSION_DELAY_DAYS) return; // already suppressed (or owner set more)
  const r = await issueIrrigation(
    "rb-controller",
    "rainDelay",
    SUPPRESSION_DELAY_DAYS,
    "suppress onboard program",
  );
  log(
    "rb-controller",
    "suppress",
    true,
    r.ok,
    r.ok ? `rain-delay → ${SUPPRESSION_DELAY_DAYS}d` : r.detail,
  );
}

/** Clear any suppression rain-delay WE hold (exactly our SUPPRESSION_DELAY_DAYS) so the
 *  controller's onboard program resumes immediately. Used while suppression is paused. A direct
 *  connector write, NOT the arm-gated path: un-suppressing only ENABLES the controller's own
 *  program (it opens no valve of ours), so it must work even when the Devices layer is disarmed.
 *  A LONGER owner-set rain delay (> our value) is left untouched. */
async function releaseSuppressionIfHeld(currentDelayDays: number): Promise<void> {
  if (currentDelayDays <= 0 || currentDelayDays > SUPPRESSION_DELAY_DAYS) return;
  try {
    await rainbird.setRainDelay(0);
    log(
      "rb-controller",
      "suppress",
      false,
      true,
      "released onboard program (rain-delay → 0)",
    );
  } catch (e) {
    log(
      "rb-controller",
      "suppress",
      false,
      false,
      `release failed: ${(e as Error).message}`,
    );
  }
}

/** Read-back confirmation after firing a zone: the station should show active within a couple
 *  of seconds. We do a single cheap re-read (the connector's ~10s cache was busted by the write). */
async function confirmActive(zoneId: string): Promise<boolean> {
  try {
    const active = await rainbird.getActiveZone();
    return active?.id === zoneId;
  } catch {
    return false;
  }
}

/**
 * SESSION OBSERVER — reconcile the freshly-read active zone against what we last saw running and
 * log a full physical watering SESSION (start → end + duration) for EVERY run, whoever started it.
 * This closes the gap where a run started at the keypad or by the controller's onboard weekly
 * program left no trace: the coordinator read the active zone each tick but threw it away.
 *
 * Runs on every tick where mode != off (we already read the active zone — zero extra LNK traffic).
 * Called only when the controller answered this tick: an unreachable read is NOT "valves idle", so
 * we never fabricate an end — an in-flight session's end is logged once the box answers again.
 *
 * An app-initiated open (issueIrrigation recorded a run for that zone in the last ~2 ticks) is
 * already logged as run/fire, so its 'start' is suppressed to avoid a duplicate; its 'end' (with
 * the measured duration) is still logged — that end + duration is new, useful information.
 */
function observeSessions(activeId: string | null, reachable: boolean): void {
  if (!reachable) return; // a failed read ≠ valves closed — don't invent a session end
  const now = Date.now();
  const prev = observedRun;

  // A previously-running zone stopped (went idle, or handed off to a different zone).
  if (prev && prev.zoneId !== activeId) {
    const mins = Math.max(1, Math.round((now - prev.startedAt) / 60_000));
    const external = !appClaimed(prev.zoneId, prev.startedAt);
    logIrrigationSession({
      zoneId: prev.zoneId,
      phase: "end",
      external,
      detail: `watering ended — ran ~${mins} min (observed at the controller)`,
      relatedId: prev.startEventId,
    });
    observedRun = null;
  }

  // A zone just became active (idle→zone, or a hand-off to a new zone this same tick).
  if (activeId && (!prev || prev.zoneId !== activeId)) {
    const external = !appClaimed(activeId, now);
    let startEventId: string | undefined;
    if (external) {
      // Only log a 'start' for runs the app didn't initiate — an app run/fire already covers ours.
      const ev = logIrrigationSession({
        zoneId: activeId,
        phase: "start",
        external: true,
        detail: "watering started at the controller (keypad or onboard program)",
      });
      startEventId = ev?.id;
    }
    observedRun = { zoneId: activeId, startedAt: now, startEventId };
  }
}

/** True when the app issued a `run` for this zone close enough to `observedAt` to own the
 *  physical open (so we don't double-log it as an external keypad/onboard session). */
function appClaimed(zoneId: string, observedAt: number): boolean {
  const ts = lastAppRunTs(zoneId);
  return ts !== undefined && observedAt - ts < APP_RUN_CLAIM_MS && ts <= observedAt + TICK_MS;
}

// ---- Rain-bypass decisions (docs/39 §6) ------------------------------------
// 2h before every scheduled run we evaluate the run-day's freshest forecast against the bypass
// thresholds (global mm / probability, per-zone rainSkipMm override) and record a skip/run call.
// The call is keyed by the exact occurrence and honoured at fire time — so a wet run is skipped
// with a visible, logged reason, decided on data far fresher than the once-a-day trim.

const DECISION_LEAD_MS = 2 * 3600_000;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** `${zoneId}@${YYYY-MM-DD}T${HH:MM}` for a run at `runTs` (local time). */
function occurrenceKey(zoneId: string, runTs: number): string {
  const d = new Date(runTs);
  return `${zoneId}@${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(
    d.getDate(),
  )}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Local "YYYY-MM-DD" for a timestamp (to match Open-Meteo daily dates). */
function isoDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** The next future datetime (epoch ms) a watering time runs, scanning today..+2 days. */
function nextOccurrenceMs(w: IrrigationWateringTime, now: Date): number | null {
  const [h, m] = w.startTime.split(":").map(Number);
  for (let d = 0; d <= 2; d++) {
    const cand = new Date(now);
    cand.setDate(now.getDate() + d);
    if (!w.days[cand.getDay()]) continue;
    cand.setHours(h || 0, m || 0, 0, 0);
    if (cand.getTime() > now.getTime()) return cand.getTime();
  }
  return null;
}

/** The epoch ms of the occurrence that JUST fired for `w` (today at start, or yesterday on the
 *  midnight straddle) — so the fire path can look up the decision keyed 2h earlier. */
function firedOccurrenceMs(w: IrrigationWateringTime, now: Date): number {
  const [h, m] = w.startTime.split(":").map(Number);
  const d = new Date(now);
  d.setHours(h || 0, m || 0, 0, 0);
  if (d.getTime() > now.getTime()) d.setDate(d.getDate() - 1); // straddle: belonged to yesterday
  return d.getTime();
}

/** Evaluate a run-day forecast vs the bypass thresholds. Skip if EITHER the day's rain sum meets
 *  the mm threshold OR its max probability meets the % threshold (mirrors the trim's rain-skip). */
function evaluateSkip(
  dayOut: weather.DailyOutlook,
  zone: IrrigationZoneConfig,
  irr: IrrigationState,
): { decision: "skip" | "run"; reason: string; rainMm: number; prob: number } {
  const mmT = zone.rainSkipMm ?? irr.globalRainSkipMm;
  const probT = irr.rainSkipProbabilityPct;
  const rainMm = dayOut.precipMm;
  const prob = dayOut.precipProbabilityPct;
  const byMm = rainMm >= mmT;
  const byProb = prob >= probT;
  if (byMm || byProb) {
    const bits: string[] = [];
    if (byMm) bits.push(`${rainMm.toFixed(1)}mm ≥ ${mmT}mm`);
    if (byProb) bits.push(`${Math.round(prob)}% ≥ ${probT}%`);
    return { decision: "skip", reason: `rain bypass (${bits.join(", ")})`, rainMm, prob };
  }
  return {
    decision: "run",
    reason: `clear (${rainMm.toFixed(1)}mm / ${Math.round(prob)}%)`,
    rainMm,
    prob,
  };
}

/** For each app-managed zone's next occurrence within the 2h lead window, record (once) a
 *  skip/run decision on the freshest daily forecast, and prune decisions older than 2 days. */
async function evaluateUpcomingSkips(
  outlook: weather.DailyOutlook[] | null,
): Promise<void> {
  if (!outlook || outlook.length === 0) return;
  const now = new Date();
  const irr = store.get().irrigation;
  const live = liveAllowed();
  for (const zone of Object.values(irr.zones)) {
    if (zone.managedBy !== "app") continue;
    for (const w of zone.wateringTimes) {
      const runTs = nextOccurrenceMs(w, now);
      if (runTs === null) continue;
      if (runTs - now.getTime() > DECISION_LEAD_MS) continue; // not within the 2h lead yet
      const key = occurrenceKey(zone.zoneId, runTs);
      if (irr.skipDecisions[key]) continue; // already decided this occurrence
      const dayOut = outlook.find((o) => o.date === isoDate(runTs));
      if (!dayOut) continue;
      const ev = evaluateSkip(dayOut, zone, irr);
      store.update((s) => {
        s.irrigation.skipDecisions[key] = {
          key,
          zoneId: zone.zoneId,
          runTs,
          decision: ev.decision,
          reason: ev.reason,
          rainMm: ev.rainMm,
          probabilityPct: ev.prob,
          decidedAt: new Date().toISOString(),
        };
        for (const [k, d] of Object.entries(s.irrigation.skipDecisions)) {
          if (Math.abs(Date.now() - d.runTs) > 2 * 24 * 3600_000)
            delete s.irrigation.skipDecisions[k];
        }
      });
      log(
        zone.zoneId,
        "decide",
        live,
        true,
        `${w.startTime} → ${ev.decision.toUpperCase()} — ${ev.reason}`,
      );
    }
  }
}

/** The stored skip/run decision for a zone's SOONEST upcoming run, or null. Used by the plan
 *  route to show "next run will skip — 8mm/70%". */
export function nextRunSkipDecision(
  zone: IrrigationZoneConfig,
): IrrigationSkipDecision | null {
  if (zone.managedBy !== "app") return null;
  const now = new Date();
  let soonest: number | null = null;
  for (const w of zone.wateringTimes) {
    const ts = nextOccurrenceMs(w, now);
    if (ts !== null && (soonest === null || ts < soonest)) soonest = ts;
  }
  if (soonest === null) return null;
  return (
    store.get().irrigation.skipDecisions[
      occurrenceKey(zone.zoneId, soonest)
    ] ?? null
  );
}

/** Re-mirror the controller's baseline (~daily) for non-destructive drift surfacing. NEVER writes
 *  the program — only reads AvailableStations + RainDelay and snapshots them. */
async function maybeMirrorBaseline(): Promise<void> {
  const irr = store.get().irrigation;
  const lastTs = irr.baselineMirror ? Date.parse(irr.baselineMirror.ts) : 0;
  if (Number.isFinite(lastTs) && Date.now() - lastTs < BASELINE_MIRROR_MS)
    return;
  try {
    const zones = await rainbird.getZones();
    const rainDelayDays = await rainbird.getRainDelay();
    const stationIds = zones.map((z) => z.id).sort();
    store.update((s) => {
      const prev = s.irrigation.baselineMirror;
      // Drift = the set of available stations changed vs the last mirror (program edits at the
      // keypad can add/remove stations). We surface it; we never act on it.
      const drift = prev
        ? prev.availableStationIds.join(",") !== stationIds.join(",")
        : false;
      s.irrigation.baselineMirror = {
        ts: new Date().toISOString(),
        rainDelayDays,
        availableStationIds: stationIds,
      };
      s.irrigation.baselineDrift = drift;
    });
  } catch {
    /* mirror is best-effort; a failed read just retries next day */
  }
}

/** One coordinator tick. Wrapped — never throws out. */
async function tick(): Promise<void> {
  const now = nowDM();
  try {
    if (!rainbird.isConfigured()) {
      last = now;
      return;
    }
    if (!last) {
      last = now; // first tick after boot establishes a baseline — never fire on boot
      return;
    }

    const irr = store.get().irrigation;
    if (irr.mode === "off") {
      // Even when off, don't leave the onboard program suppressed by a delay WE set — clear it so
      // the Rain Bird's own schedule resumes immediately. This is how the owner hands control back
      // to the controller via the ModeToggle (Home App → Rain Bird): without it, a suppression
      // delay set while live would linger up to ≤1 day. (releaseSuppressionIfHeld leaves a longer
      // owner-set rain delay untouched.)
      if (rainbird.isConfigured()) {
        try {
          await releaseSuppressionIfHeld(await rainbird.getRainDelay());
        } catch {
          /* best-effort; retries next tick */
        }
      }
      last = now;
      return;
    }

    // ---- READ live controller state and REFLECT it (whenever mode != off). One request at a
    //      time — these run sequentially through the connector's transport mutex. ----
    let activeId: string | null = null;
    let rainDelayDays = 0;
    let reachable = true;
    try {
      const zones = await rainbird.getZones();
      activeId = zones.find((z) => z.active)?.id ?? null;
      rainDelayDays = await rainbird.getRainDelay();
    } catch (e) {
      reachable = false;
      store.update((s) => {
        s.irrigation.lastError = `controller unreachable: ${(e as Error).message}`;
      });
      log(
        "rb-controller",
        "alert",
        false,
        false,
        `unreachable: ${(e as Error).message}`,
      );
    }

    // Log the physical watering session (start/end + duration) for whatever the valves are
    // actually doing — app-fired, keypad, or the onboard weekly program. Ground truth from the
    // read above; skipped on an unreachable tick so we never fabricate a session end.
    observeSessions(activeId, reachable);

    const wf = await forecastCached();
    const day: DayWeather = wf
      ? rollupDayWeather(wf)
      : { et0Mm: 0, precipMm: 0, precipProbabilityPct: 0, peakHourEt0Mm: 0 };

    const trims = computeTrims(store.get().irrigation, now.day, day);

    // ---- RAIN BYPASS: decide skip/run for runs coming up within 2h, on the freshest outlook. ----
    const outlook = await getDailyOutlookCached();
    await evaluateUpcomingSkips(outlook);

    const live = liveAllowed(store.get()) && reachable && wf !== null;

    // ---- SUPPRESSION: hold the rolling rain-delay so the onboard program stays suppressed. ----
    if (SUPPRESS_ONBOARD_PROGRAM) {
      if (live) {
        await refreshSuppression(rainDelayDays);
      } else if (irr.mode === "live" && !reachable) {
        // Wanted to be live but the box didn't answer — alert so the owner knows suppression lapsed.
        log(
          "rb-controller",
          "alert",
          false,
          false,
          "live but controller unreachable — suppression not refreshed",
        );
      }
    } else if (reachable) {
      // Suppression PAUSED (verifying Home-App watering): never hold the delay; clear any we still
      // hold so the controller's onboard program keeps watering.
      await releaseSuppressionIfHeld(rainDelayDays);
    }

    // ---- FIRE due zones (edge-triggered at each watering time's start minute) — ONLY while
    //      suppression is ON. When paused, the controller's onboard program owns the schedule, so
    //      firing here would double-water. Manual Water-now (the route path) is unaffected. ----
    const zonesById = store.get().irrigation.zones;
    for (const zone of Object.values(zonesById)) {
      if (!SUPPRESS_ONBOARD_PROGRAM) break;
      if (zone.managedBy !== "app") continue;
      const due = dueWateringTimes(zone, last, now);
      if (due.length === 0) continue;

      const trim = trims.find((t) => t.zoneId === zone.zoneId);
      // Per-watering-time trim: scale the time's ceiling by the day's saved% so a single fired
      // run gets its share of the trim (the day-level trim sizes total minutes to the deficit).
      const dayScheduled = scheduledMinForDay(zone, now.day);
      const dayTrimmed = trim ? trim.trimmedMin : dayScheduled;
      const factor = dayScheduled > 0 ? dayTrimmed / dayScheduled : 0;

      const nowDate = new Date();
      for (const w of due) {
        const minutes = Math.round(w.durationMin * factor);
        const reasonBits = trim?.reasons.length
          ? ` [${trim.reasons.join(", ")}]`
          : "";

        // RAIN BYPASS: honour a 'skip' decision recorded ~2h ago for this exact occurrence.
        const decision =
          store.get().irrigation.skipDecisions[
            occurrenceKey(zone.zoneId, firedOccurrenceMs(w, nowDate))
          ];
        if (decision?.decision === "skip") {
          log(
            zone.zoneId,
            "skip",
            live,
            true,
            `${w.startTime}: skipped — ${decision.reason}`,
          );
          continue;
        }

        if (minutes <= 0) {
          log(
            zone.zoneId,
            "skip",
            live,
            true,
            `${w.startTime}: skipped (0 min)${reasonBits}`,
          );
          continue;
        }

        if (!live) {
          // Live-but-not-allowed/unreachable: log the intended run, fire nothing.
          log(
            zone.zoneId,
            "plan",
            false,
            true,
            `would run ${minutes}m (of ${w.durationMin}m ceiling) at ${w.startTime}${reasonBits}`,
          );
          continue;
        }

        // LIVE: fire via the arm-gated write path, then READ BACK to confirm the valve opened.
        const r = await issueIrrigation(
          zone.zoneId,
          "run",
          minutes,
          `irrigation plan ${w.startTime}`,
        );
        if (!r.ok) {
          log(
            zone.zoneId,
            "fire",
            true,
            false,
            `run ${minutes}m failed: ${r.detail}`,
          );
          continue;
        }
        log(
          zone.zoneId,
          "fire",
          true,
          true,
          `run ${minutes}m issued${reasonBits}`,
        );
        const confirmed = await confirmActive(zone.zoneId);
        log(
          zone.zoneId,
          "confirm",
          true,
          confirmed,
          confirmed
            ? "valve confirmed active"
            : "valve NOT confirmed active — check controller",
        );

        // Advance the zone's running deficit by what we actually applied (effective rain + ETc are
        // folded in at the day rollover via advanceDeficit; here we pay down by applied depth).
        store.update((s) => {
          const d = s.irrigation.deficits[zone.zoneId];
          const appliedMm = minutes * precipRateMmPerMin(zone);
          const next = Math.max(0, (d?.mm ?? 0) - appliedMm);
          s.irrigation.deficits[zone.zoneId] = {
            mm: next,
            updatedAt: new Date().toISOString(),
          };
        });
      }
    }

    // ---- Mirror the baseline program (~daily) for non-destructive drift surfacing. ----
    if (reachable) await maybeMirrorBaseline();

    store.update((s) => {
      s.irrigation.lastTickAt = new Date().toISOString();
      if (reachable) s.irrigation.lastError = s.irrigation.lastError; // keep prior alert until cleared
    });
    last = now;
  } catch (e) {
    last = now;
    store.update((s) => {
      s.irrigation.lastError = `irrigation tick failed: ${(e as Error).message}`;
    });
    console.error(
      "[irrigation] coordinator tick failed:",
      (e as Error).message,
    );
  }
}

export function startIrrigationCoordinator(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), TICK_MS);
  console.log(
    `[irrigation] coordinator started (every ${TICK_MS / 1000}s — actuates only when mode=live + armed)`,
  );
}

// Exposed for tests (pure-ish helpers that need no real box).
export const __test = {
  crossed,
  dueWateringTimes,
  scheduledMinForDay,
  evaluateSkip,
  nextOccurrenceMs,
  occurrenceKey,
  observeSessions,
  resetObserver: (): void => {
    observedRun = null;
  },
};
