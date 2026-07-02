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
// SHADOW-FIRST (non-negotiable): the coordinator ships in mode 'off' and the live actuation
// path runs ONLY when irrigation.mode === 'live' AND the Devices layer is armed (the same
// arm/admin gate as the other coordinators — enforced again inside issueIrrigation). In
// 'shadow' it computes the full plan and LOGS what it WOULD do, but refreshes nothing and
// fires nothing. It never opens a valve autonomously on first ship.
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
import { issueIrrigation } from "./irrigation-execute";
import {
  trimZone,
  rollupDayWeather,
  precipRateMmPerMin,
  type DayWeather,
  type ZoneTrim,
} from "./irrigation-engine";
import { bandFor } from "../tariff";
import { logIrrigationDecision } from "./log-adapters";
import { climateSurplusW } from "./climate-snapshot";
import * as sonnen from "../connectors/sonnen";
import * as tesla from "../connectors/tesla";
import type {
  IrrigationState,
  IrrigationZoneConfig,
  IrrigationWateringTime,
} from "../store";

const TICK_MS = 60_000;
let timer: ReturnType<typeof setInterval> | null = null;
let last: { day: number; min: number } | null = null;

/** The rolling rain-delay (days) we hold on the controller to SUPPRESS its onboard program
 *  while we're healthy. 1 day = the shortest fail-safe lapse; refreshed every tick. */
export const SUPPRESSION_DELAY_DAYS = 1;

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

/** Append one coordinator decision to the irrigation log (shadow-safe — also used for shadow). */
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

/** Prefer the owner's watering window — but only as a tie-breaker, NEVER at the expense of plant
 *  health. We return whether NOW is a "good" time; the coordinator still fires a due run regardless
 *  (deferring water risks the plant). This only annotates the log / future nudging. */
function windowFavorable(
  s: store.StoreSchema,
  surplusW: number,
): { ok: boolean; why: string } {
  switch (s.irrigation.window) {
    case "solar-surplus":
      return surplusW > 300
        ? { ok: true, why: "solar surplus" }
        : { ok: false, why: "no surplus" };
    case "off-peak-P3":
      return bandFor() === "P3"
        ? { ok: true, why: "P3 off-peak" }
        : { ok: false, why: `band ${bandFor()}` };
    case "early-morning": {
      const h = new Date().getHours();
      return h >= 4 && h < 9
        ? { ok: true, why: "early morning" }
        : { ok: false, why: "outside morning" };
    }
    default:
      return { ok: true, why: "no window pref" };
  }
}

async function liveSurplusW(): Promise<number> {
  try {
    const [s, t] = await Promise.allSettled([
      sonnen.getNormalized(),
      tesla.getNormalized(),
    ]);
    return climateSurplusW(
      s.status === "fulfilled" ? s.value : null,
      t.status === "fulfilled" ? t.value : null,
    );
  } catch {
    return 0;
  }
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
      last = now;
      return;
    }

    // ---- READ live controller state and REFLECT it (both shadow + live). One request at a
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

    const wf = await forecastCached();
    const day: DayWeather = wf
      ? rollupDayWeather(wf)
      : { et0Mm: 0, precipMm: 0, precipProbabilityPct: 0, peakHourEt0Mm: 0 };

    const trims = computeTrims(store.get().irrigation, now.day, day);
    const surplusW = irr.mode === "live" ? await liveSurplusW() : 0;

    const live = liveAllowed(store.get()) && reachable && wf !== null;

    // ---- SUPPRESSION: hold the rolling rain-delay so the onboard program stays suppressed. ----
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

    // ---- FIRE due zones (edge-triggered at each watering time's start minute). ----
    const zonesById = store.get().irrigation.zones;
    for (const zone of Object.values(zonesById)) {
      if (zone.managedBy !== "app") continue;
      const due = dueWateringTimes(zone, last, now);
      if (due.length === 0) continue;

      const trim = trims.find((t) => t.zoneId === zone.zoneId);
      // Per-watering-time trim: scale the time's ceiling by the day's saved% so a single fired
      // run gets its share of the trim (the day-level trim sizes total minutes to the deficit).
      const dayScheduled = scheduledMinForDay(zone, now.day);
      const dayTrimmed = trim ? trim.trimmedMin : dayScheduled;
      const factor = dayScheduled > 0 ? dayTrimmed / dayScheduled : 0;

      for (const w of due) {
        const minutes = Math.round(w.durationMin * factor);
        const fav = windowFavorable(store.get(), surplusW);
        const reasonBits = trim?.reasons.length
          ? ` [${trim.reasons.join(", ")}]`
          : "";

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
          // SHADOW (or live-but-not-allowed/unreachable): log the intended run, fire nothing.
          log(
            zone.zoneId,
            "plan",
            false,
            true,
            `would run ${minutes}m (of ${w.durationMin}m ceiling) at ${w.startTime}${reasonBits} · window ${fav.why}`,
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
          `run ${minutes}m issued (${fav.why})${reasonBits}`,
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
    `[irrigation] coordinator started (every ${TICK_MS / 1000}s, SHADOW-first — actuates only when mode=live + armed)`,
  );
}

export function stopIrrigationCoordinator(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

// Exposed for tests (pure-ish helpers that need no real box).
export const __test = {
  crossed,
  dueWateringTimes,
  scheduledMinForDay,
  windowFavorable,
};
