// JSON file state store with atomic writes (write tmp + rename) and an
// in-memory cache. The brain/back-end persists settings, alert state, scenario
// definitions, push subscriptions, VAPID keys and a (possibly rotated) Tesla
// refresh token here. No databases — a single JSON document is plenty for one site.
//
// Path resolution:
//   STATE_FILE env override, else
//   production → /opt/energy/state.json (writable by the jdkroese01 service user)
//   dev        → <repoRoot>/.data/state.json

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import type { Band } from "./tariff";

// ---- Types --------------------------------------------------------------

export interface ChannelWhatsApp {
  number: string;
  enabled: boolean;
}
export interface ChannelPush {
  enabled: boolean;
}
export interface ChannelEmail {
  address: string;
  enabled: boolean;
}
export interface Channels {
  whatsapp: ChannelWhatsApp;
  push: ChannelPush;
  email: ChannelEmail;
}

export interface RuleState {
  id: string;
  enabled: boolean;
}

export type AlertStatus = "new" | "ack" | "resolved";
export interface AlertOverride {
  status: AlertStatus;
}

/**
 * Grid-voltage monitor config — drives the Live KPI box AND the `rule-voltage`
 * alert. A Tuya breaker (category `tdq`) exposes `cur_voltage` (V); when the live
 * voltage leaves [minV, maxV] the alert loop fires a `danger` notification. The
 * monitored breaker is auto-picked (first configured breaker exposing `cur_voltage`)
 * and its id persisted here so the choice is stable; a manual `breakerId` is honoured
 * while that device is still present.
 */
export interface VoltageMonitor {
  /** Master toggle for the band alert (the KPI box always renders when data exists). */
  enabled: boolean;
  /** Low voltage threshold (V) — below this the breaker reads as out-of-band. */
  minV: number;
  /** High voltage threshold (V) — above this the breaker reads as out-of-band. */
  maxV: number;
  /** Tuya device id of the monitored breaker (auto-picked + persisted; manual override honoured). */
  breakerId?: string;
}

export interface ScenarioWeights {
  save: number;
  self: number;
  indep: number;
  comfort: number;
}

export interface ScenarioDef {
  name: string;
  icon: string;
  weights: ScenarioWeights;
  /** Backup reserve floor (%). */
  reserve: number;
  /** Whether the reserve floor adapts to weather/outage risk. */
  dynReserve: boolean;
  /** Allow charging the battery from the grid (cheap P3 windows). */
  gridCharge: boolean;
  /** Export policy hint shown in the UI / used by the shadow plan. */
  exportRule: "never" | "surplus" | "always";
  /** EV charging policy hint. */
  ev: "solar-only" | "cheap-grid" | "asap";
  /** Thermal pre-conditioning before P1 peaks. */
  precondition: boolean;
  /** How the scenario is activated. */
  activation: "manual" | "auto";
  /** Optional auto-activation trigger description. */
  trigger: string;
}

export interface PushSubscriptionKeys {
  p256dh: string;
  auth: string;
}
export interface StoredPushSubscription {
  endpoint: string;
  expirationTime?: number | null;
  keys: PushSubscriptionKeys;
}

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

// ---- Auth ---------------------------------------------------------------

export type UserRole = "admin" | "user" | "kiosk";
export type TwoFactorChannel = "whatsapp" | "email";
export type OtpPurpose = "login" | "reset";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  /** bcrypt hash, or null for a pre-seeded account awaiting first-time setup. */
  passwordHash: string | null;
  twoFactor: {
    enabled: boolean;
    channel: TwoFactorChannel;
  };
  createdAt: number;
}

export interface AuthSession {
  /** sha256(rawToken) — the raw token only ever lives in the `sid` cookie. */
  tokenHash: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  ua: string;
  ip: string;
}

export interface AuthTrustedDevice {
  id: string;
  /** sha256(rawToken) — the raw token only ever lives in the `tdid` cookie. */
  tokenHash: string;
  userId: string;
  label: string;
  createdAt: number;
  expiresAt: number;
  lastUsed: number;
}

export interface AuthOtp {
  userId: string;
  /** sha256(6-digit code). */
  codeHash: string;
  purpose: OtpPurpose;
  createdAt: number;
  expiresAt: number;
  attempts: number;
}

export interface AuthResetToken {
  /** sha256(rawToken). */
  tokenHash: string;
  userId: string;
  expiresAt: number;
}

export interface AuthSetupToken {
  /** sha256(rawToken). */
  tokenHash: string;
  userId: string;
  email: string;
  expiresAt: number;
}

export interface LoginAttempt {
  count: number;
  /** epoch ms until which the email is locked, or 0 when not locked. */
  lockedUntil: number;
}

export interface AuthState {
  users: AuthUser[];
  sessions: AuthSession[];
  trustedDevices: AuthTrustedDevice[];
  otps: AuthOtp[];
  resetTokens: AuthResetToken[];
  setupTokens: AuthSetupToken[];
  loginAttempts: Record<string, LoginAttempt>;
}

// ---- Battery control --------------------------------------------------------

export type ControlMode = "off" | "manual" | "auto";
export type ControlDevice = "sonnen" | "tesla";

export interface ControlLogEntry {
  ts: number;
  device: ControlDevice;
  lever: string;
  from: string | number | null;
  to: string | number | null;
  reason: string;
  ok: boolean;
  detail: string;
}

export interface ControlGuardrails {
  /** Never discharge a battery below this SoC (%). */
  socFloorPct: number;
  /** Tesla backup_reserve_percent floor (%). */
  teslaReserveMinPct: number;
  /** Sonnen setpoint ceiling (W). */
  sonnenMaxW: number;
  /** Hard grid-import cap (kW). */
  gridImportCapKw: number;
}

// ---- Battery-priority rules -------------------------------------------------
// Two coordinator policies that decide WHICH battery acts first, so the Tesla
// (the only one with a backup feature) is kept full for outages:
//   • dischargeSonnenFirst — cover the house from Sonnen first; hold Tesla until
//     Sonnen is depleted OR grid import exceeds the throughput cap.
//   • chargeTeslaFirst — when both are low, fill Tesla first to restore backup;
//     hold Sonnen until Tesla is full OR surplus exceeds the throughput cap.
// Each has its own enable + authority (shadow logs only / auto writes) and a
// throughput cap (kW) beyond which the OTHER battery is allowed to join in.

export type BatteryPriorityAuthority = "shadow" | "auto";

export interface BatteryPriorityRule {
  enabled: boolean;
  /** shadow = compute + log intended action, write nothing; auto = issue commands. */
  authority: BatteryPriorityAuthority;
  /** Throughput (kW) the priority battery handles alone; beyond it the other joins. */
  throughputKw: number;
}

export interface BatteryPriority {
  /** Discharge Sonnen first; keep Tesla full for backup (Sonnen has no backup mode). */
  dischargeSonnenFirst: BatteryPriorityRule;
  /** Charge Tesla first when both depleted; restore backup capacity before Sonnen. */
  chargeTeslaFirst: BatteryPriorityRule;
}

// ---- Surplus-soak (force-charge-to-soak-export) rule ------------------------
// When solar exports to the grid (worthless in Spain), force-charge the Sonnen to
// absorb the would-be-export before it spills. A hysteresis deadband (startW high /
// stopW low) stops flapping; socCeilingPct keeps it off a near-full battery. These
// were hardcoded constants in the coordinator — now tunable + toggleable from the UI.
export interface SoakExportRule {
  /** Master toggle. Default true — the rule is live today, must stay live on deploy. */
  enabled: boolean;
  /** Engage once net grid export exceeds this (W). */
  startW: number;
  /** Revert to self-consumption once export drops below this (W). Must be < startW. */
  stopW: number;
  /** Don't force-charge a battery at/above this SoC (%). */
  socCeilingPct: number;
}

// ---- EV (car) solar / P3 charging tunables (docs/33) ------------------------
// Global tunables for the EV-surplus rule that gates a metered circuit breaker (the car
// charger) on solar surplus OR the cheap P3 band. Per-device opt-in via
// deviceSettings[id].solarP3Only; auto-learned draw in deviceSettings[id].learnedDrawW.
export interface EvSurplusTunables {
  /** Conservative seed for a charger's draw (W) before any is learned. */
  estimateW: number;
  /** Start margin (W): solar start threshold = learnedDrawW + this. */
  startMarginW: number;
  /** Stop hysteresis (W): once on for the solar reason, stay on until surplus < learnedDrawW − this. */
  stopHysteresisW: number;
  /** Surplus must stay below the stop band for this long (s) before switching off. */
  surplusClearSec: number;
  /** Minimum minutes between breaker on→off / off→on toggles (anti-chatter). */
  minCycleMin: number;
  /** Only update learnedDrawW from measured power above this floor (W) — ignore standby. */
  learnFloorW: number;
}

export interface ControlState {
  /** Master safety switch — DISARMED by default; nothing is ever written until armed. */
  armed: boolean;
  mode: ControlMode;
  updatedAt: number;
  lastError: string | null;
  /** Ring buffer of the last 100 control actions. */
  log: ControlLogEntry[];
  guardrails: ControlGuardrails;
  /** Sonnen-first / Tesla-first battery-priority rules. */
  batteryPriority: BatteryPriority;
  /** Force-charge-to-soak-export rule (absorb surplus before it spills to grid). */
  soakExport: SoakExportRule;
  /** Tariff-arbitrage effectiveness log — in-state ring buffer (last ~200 events). The
   *  durable record is the JSONL file; this survives a restart for the UI history list. */
  arbitrageLog: ArbitrageEvent[];
  /** Cumulative tariff-arbitrage headline stats (advisory vs active). */
  arbitrageStats: ArbitrageStats;
  /** One-time migration flag: when the Sonnen-first discharge actuation changed (load-following
   *  + Tesla backup hold, replacing the reserve-raise hold), the rule is forced back to SHADOW
   *  once so the new actuation re-validates before going live. Set true after that runs; the
   *  user's authority toggle is then respected thereafter. */
  dischargeV2Shadowed?: boolean;
}

/** Max in-state arbitrage events kept (the JSONL file is the unbounded durable record). */
export const ARBITRAGE_LOG_RING_MAX = 200;

/**
 * Command/device log retention. The battery command log (control.log) and the device/climate log
 * (devices.log) are kept by TIME, not count: entries from the last 48h are retained, the rest are
 * dropped on each write (and on load). LOG_MAX_ENTRIES is a safety ceiling so a pathological
 * error-storm can't bloat state.json beyond a bounded size even inside the 48h window.
 */
export const LOG_RETENTION_MS = 48 * 60 * 60 * 1000;
export const LOG_MAX_ENTRIES = 5000;

/** Prune a ts-stamped log to the 48h retention window, with a hard safety ceiling on count. */
export function pruneLog<T extends { ts: number }>(
  log: T[],
  now: number = Date.now(),
): T[] {
  const cutoff = now - LOG_RETENTION_MS;
  const recent = log.filter((e) => e.ts >= cutoff);
  return recent.length > LOG_MAX_ENTRIES
    ? recent.slice(-LOG_MAX_ENTRIES)
    : recent;
}

// ---- Devices / Climate ------------------------------------------------------
// A generic devices layer; AC (Intesis/Panasonic Etherea) is the first type. The
// store holds: integration creds, per-device user settings, schedules, automations,
// climate guardrails, a master arm flag, and a ring-buffer command log. The armed
// state PERSISTS across restarts (a deploy resumes where it left off); a fresh install
// with no state defaults to disarmed, and ENERGY_BOOT_DISARMED=1 forces a safe boot.

/** Third-party integration credentials/config (set in Settings; env is a fallback). */
export interface IntegrationsState {
  intesis: { username: string; password: string } | null;
  /** Sonnen local API override (host/IP + auth token). */
  sonnen?: { host?: string; token?: string };
  /** Tesla Fleet API override (energy site id). Token lives in teslaRefreshToken. */
  tesla?: { siteId?: string };
  /** Weather forecast location override. */
  weather?: { lat?: number; lon?: number };
  /** Airzone Local API override (webserver host/IP; port is fixed at 3000). */
  airzone?: { host?: string } | null;
  /** Rain Bird LNK / LNK2 irrigation controller (LAN-local SIP). Host defaults to the
   *  known module IP; the password is REQUIRED and persisted here (never in the repo). */
  rainbird?: { host?: string; password?: string } | null;
  /** Tuya Cloud project (datacenter region + Access ID/Secret). Unlocks the
   *  whole linked device fleet — lights first, more categories to come. */
  tuya?: { region?: string; accessId?: string; accessSecret?: string };
  /** Panasonic Comfort Cloud — native WiFi AC modules (CS-Z / CS-XZ series). */
  panasonic?: { username: string; password: string } | null;
  /** Sonos house-alarm. Local UPnP discovery (zero-config on the LAN); `seedIp` is a
   *  fallback for networks where SSDP multicast is blocked. Enabled by default. */
  sonos?: { enabled: boolean; seedIp?: string } | null;
}

/** A live house-alarm session (siren + light-blink). Persisted so the UI shows an
 *  active banner and the engine can resume/auto-stop across a restart. `null` = idle. */
export interface AlarmActive {
  /** ISO timestamp the alarm was triggered. */
  startedAt: string;
  /** Auto-stop after this many ms, or null for run-until-stopped. */
  durationMs: number | null;
  /** Light ids enrolled in the blink (snapshotted at trigger time). */
  lightIds: string[];
  /** Whether the siren leg was requested. */
  siren: boolean;
}

/** Hard floor for the blink half-period (ms). Tuya is CLOUD (~0.2–0.8s/cmd + rate limits),
 *  so a faster cadence just drops commands; enforced in BOTH the UI and the API. */
export const ALARM_BLINK_FLOOR_MS = 400;

/**
 * Owner-configurable house-alarm defaults (Settings → Alarm / Panic). The trigger uses
 * these unless a per-call override is supplied. Persisted in app state.
 */
export interface AlarmConfig {
  /** Master enable for the panic button. When false the trigger endpoint refuses. */
  enabled: boolean;
  /** Speaker UUIDs to sound; empty = ALL discovered speakers. */
  speakerIds: string[];
  /** Siren volume 0–100. */
  volumePct: number;
  /** Light ids to blink; empty = ALL discovered lights. */
  lightIds: string[];
  /** Blink HALF-period (ms): on for this long, off for this long. Floor ALARM_BLINK_FLOOR_MS. */
  blinkMs: number;
  /** Safety auto-stop after this many seconds; 0 = no cap (manual stop only). */
  autoStopSec: number;
  /** One-time migration flag: the default siren volume was raised 70 → 80. On first
   *  hydrate after that change, a persisted config still sitting on the OLD default (70)
   *  is bumped to 80 once; set true so it runs exactly once and never overrides a future
   *  deliberate owner change. */
  volumeBumpedTo80?: boolean;
}

/** Sensible defaults: enabled, all speakers + all lights, 80% volume, ~1 Hz blink
 *  (500 ms half-period), 10-min safety cap. */
export function defaultAlarmConfig(): AlarmConfig {
  return {
    enabled: true,
    speakerIds: [],
    volumePct: 80,
    lightIds: [],
    blinkMs: 500,
    autoStopSec: 600,
    volumeBumpedTo80: true,
  };
}

/** Per-device user-facing settings, merged onto the connector's normalized view. */
export interface DeviceSettings {
  /** Friendly room override (falls back to the device's reported zone/name). Kept as a
   *  display fallback; the first-class Rooms model (rooms + roomId below) supersedes it. */
  room?: string;
  /** First-class Rooms assignment: the id of the {@link Room} this device belongs to,
   *  or undefined/null = Unassigned. Spans EVERY device type (climate, lights, blinds,
   *  generic) because deviceSettings is keyed by the globally-unique device id. */
  roomId?: string | null;
  /** Custom display name override (lights; falls back to the device's reported name). */
  name?: string;
  /**
   * LEGACY single solar-surplus enrolment flag. Superseded by the two independent
   * direction flags below (solarCoolEnabled / solarHeatEnabled). Kept readable for
   * back-compat: a persisted `automationEnabled === true` migrates to BOTH new flags on,
   * preserving the prior bidirectional behavior. New writes set the split flags directly.
   * @deprecated use solarCoolEnabled / solarHeatEnabled
   */
  automationEnabled?: boolean;
  /** Solar-surplus COOLING enrolment: cool this HVAC on surplus when the room is warm. */
  solarCoolEnabled?: boolean;
  /** Solar-surplus HEATING enrolment: heat this HVAC on surplus when the room is cold. */
  solarHeatEnabled?: boolean;
  /** Hard comfort bounds for automations (°C). */
  comfortCeilingC?: number;
  comfortFloorC?: number;
  /** Blinds only: flip 0/100 so the app's "% open" matches the motor's direction. */
  invertPosition?: boolean;
  /**
   * Blinds only: full-travel time in seconds (a full open OR close take the same time).
   * When set, enables TIMED partial positioning for a blind that has no native position DP
   * (open/stop/close only): a move to target% runs the motor for travelSec×|Δ|/100 then Stop.
   * Clamped 5–90s at the write. Unset/undefined = no timed positioning. See docs/34.
   */
  travelSec?: number;
  /**
   * Circuit breaker (EV charger) only: when true, the EV-surplus rule owns this breaker —
   * it turns the breaker ON only on solar surplus OR the cheap P3 band (armed+auto), and OFF
   * otherwise. Default/undefined = false = MAX charging (rule never touches the breaker, today's
   * manual/schedule behaviour). See control/ev-surplus.ts.
   */
  solarP3Only?: boolean;
  /**
   * Circuit breaker (EV charger) only: auto-learned charger draw (W), an EMA of the breaker's
   * measured power while it was on (above evSurplus.learnFloorW). Seeded from evSurplus.estimateW.
   * Used as the surplus start threshold and the reserved draw the cooling rule must yield.
   */
  learnedDrawW?: number;
}

export type ClimateMode = "auto" | "heat" | "dry" | "fan" | "cool";

/** Device categories a rule can target. Extensible (lighting/circuit land later).
 *  'controller' is an INPUT device (a wireless scene switch) — it has no actuatable
 *  load; its buttons are bound to whole-home scenes (see sceneControllers). */
export type DeviceType =
  | "cooling"
  | "heating"
  | "lighting"
  | "circuit"
  | "blinds"
  | "speakers"
  | "irrigation"
  | "controller";

/** Fan / vane settings: 'auto' (A) or a discrete 1..5 position. */
export type FanSetting = "auto" | 1 | 2 | 3 | 4 | 5;
export type VaneSetting = "auto" | 1 | 2 | 3 | 4 | 5;

/** The device action a rule applies during its windows. Type-adaptive: climate
 *  units read mode/setpoint/fan/vanes; blinds read only positionPct (the climate
 *  fields are present-but-ignored on a blinds rule). */
export interface Action {
  power: boolean;
  mode: ClimateMode;
  setpointC: number;
  fan: FanSetting;
  vaneUpDown: VaneSetting;
  vaneLeftRight: VaneSetting;
  /** Blinds only: target position 0 = closed … 100 = open. */
  positionPct?: number;
  /** Circuit (generic switchable device) only: fan speed in DEVICE units (e.g. 1..5)
   *  to set at ON. Omit = leave the device's current speed as-is. */
  speed?: number;
  /** Circuit only: direction enum value (e.g. 'forward'/'reverse') to set at ON.
   *  Omit = leave the device's current direction as-is. */
  direction?: string;
}

export type TimeAnchor = "fixed" | "sunrise" | "sunset";

export interface ScheduleWindow {
  /** Local "HH:MM". Used when anchor is 'fixed'; kept as display/fallback for solar anchors. */
  start: string;
  end: string;
  /** Anchor for start time. 'fixed' (default) uses `start` HH:MM directly. */
  startAnchor?: TimeAnchor;
  /** Minutes added to solar anchor (negative = before). Default 0. */
  startOffsetMin?: number;
  /** Anchor for end time. 'fixed' (default) uses `end` HH:MM directly. */
  endAnchor?: TimeAnchor;
  /** Minutes added to solar anchor (negative = before). Default 0. */
  endOffsetMin?: number;
  /** Optional per-window override; inherits the rule's `action`. */
  action?: Partial<Action>;
}

export type RunCondition =
  | { kind: "always" }
  | { kind: "warmerThan"; thresholdC: number } // run only if room temp > threshold (cooling)
  | { kind: "coolerThan"; thresholdC: number }; // run only if room temp < threshold (heating)

/** A rule targets ONE unit (or a single named group), never an array of devices. */
export type ScheduleScope =
  | { kind: "unit"; deviceId: string }
  | { kind: "group"; groupId: string };

/**
 * A scheduling RULE (called a "rule" in the UI). Belongs to a single unit/group
 * of one device type. Windows may overlap midnight; per the no-overlap rule, two
 * enabled rules on a unit may not cover the same minute on the same weekday.
 */
export interface Schedule {
  id: string;
  name: string;
  enabled: boolean;
  type: DeviceType;
  scope: ScheduleScope;
  /** Days of week the rule runs on (0=Sun..6=Sat). */
  days: number[];
  /** ≥1 window; multiple allowed (morning/afternoon/evening). */
  windows: ScheduleWindow[];
  /** Default action for all windows (a window may override parts of it). */
  action: Action;
  condition: RunCondition;
}

// The solar-surplus automation is SPLIT into two single-direction rules:
//   • solar_surplus_precool — COOLING ONLY: cool an enrolled HVAC when its room is warm.
//   • solar_surplus_preheat — HEATING ONLY: heat an enrolled HVAC when its room is cold.
// Each is independently enabled and gated on its own per-unit enrolment flag
// (solarCoolEnabled / solarHeatEnabled). Airzone underfloor (`air-*`) is NOT eligible for
// either. The two rules share ONE param shape (below) to minimise churn: a cooling rule
// reads the cooling fields (roomTempLimitC → targetSetpointC) and a heating rule reads the
// heating fields (heatRoomFloorC → heatTargetSetpointC).
export type AutomationType =
  | "solar_surplus_precool"
  | "solar_surplus_preheat"
  | "tariff_arbitrage";

/**
 * Params shared by both single-direction solar-surplus rules. A rule reads only the
 * fields for its own direction:
 *  - COOLING rule (solar_surplus_precool): COOL while room is ABOVE roomTempLimitC,
 *    down toward targetSetpointC.
 *  - HEATING rule (solar_surplus_preheat): HEAT while room is BELOW heatRoomFloorC,
 *    up toward heatTargetSetpointC.
 * (The shape carries both directions so the API/serialisation and a migrated legacy
 * unified rule never drop a target; the coordinator only consults its own direction.)
 */
export interface SolarSurplusPrecoolParams {
  /** Cooling trigger (°C): cooling runs while room > this limit. */
  roomTempLimitC: number;
  /** Cooling target setpoint to drive the room down toward (°C). */
  targetSetpointC: number;
  /**
   * Heating trigger (°C): heating runs while room < this floor. Optional so legacy
   * cooling-only rules keep parsing; the coordinator/heat rule defaults it when absent.
   */
  heatRoomFloorC?: number;
  /** Heating target setpoint to drive the room up toward (°C). Defaults when absent. */
  heatTargetSetpointC?: number;
  /** Stop only after surplus has cleared for this long (s). */
  surplusClearSec: number;
  /** Whether the tariff-band stand-down applies at all. Default true (undefined ⇒ on). */
  bandRestrictionEnabled?: boolean;
  /** Band at which automation stands down when bandRestrictionEnabled (P1 peak). */
  exitBand: Band;
  /** Surplus (W) above which a compressor start is permitted. */
  startThresholdW?: number;
  /**
   * Minimum on-time (s) once the rule STARTS a unit: for this window the rule will not
   * soft-stop it (room-reached-target or surplus-cleared) so a fluctuating surplus can't
   * chatter it on/off. The tariff-band (P1 peak) stand-down still overrides immediately.
   * Absent ⇒ coordinator default (900s = 15 min).
   */
  minRunSec?: number;
  /** Fan speed the rule sets when it switches a unit on (0=auto, 1..5). Absent ⇒ 2. */
  fanLevel?: number;
}

/**
 * Params for the TARIFF-ARBITRAGE battery automation (task #15). A weather/forecast-aware
 * rule that shifts grid purchases from the P1 peak to the P3 valley: pre-charge the batteries
 * from cheap grid when the day's solar won't cover the peak, discharge through P1 to avoid
 * pricey imports. SOLAR-FIRST (only buy the forecast shortfall) and LIVE-self-correcting (if
 * solar surges and we're exporting, the planned buy stands down and the #34 soak-export takes
 * over). Seeded DISABLED; only ever acts when enabled && armed && mode==='auto'.
 */
export interface TariffArbitrageParams {
  /** Pre-peak SoC target ceiling (%): never grid-charge above this. */
  peakTargetSocPct: number;
  /** Max grid-charge power into the Sonnen during the valley (kW; clamped to sonnenMaxW). */
  maxGridChargeKw: number;
  /** Minimum P1−P3 price spread (€/kWh) for the arbitrage to be worthwhile. */
  minSpreadEur: number;
  /** Discharge floor (%) the peak discharge respects (≥ Tesla reserve / SoC floor). */
  dischargeFloorPct: number;
  /** Only buy the shortfall the forecast solar won't provide (true = solar-first). */
  solarShortfallOnly: boolean;
  /** When exporting (live surplus), defer to #34 soak-export and DON'T grid-buy. */
  surplusOverridesGridCharge: boolean;
  /**
   * Valley band for grid-charging (cheap window). Derived from the live tariff (P3),
   * overridable. Grid-charge is permitted ONLY while the live band equals this.
   */
  valleyBand: Band;
  /**
   * Peak band to discharge through (expensive window). Derived from the live tariff (P1),
   * overridable. Grid-charge is NEVER permitted in this band (nor in P2).
   */
  peakBand: Band;
  /**
   * SAFETY GATE — execution mode. 'advisory' (default): observe & log only; the rule
   * computes its plan, detects deviations, and accrues MODELLED savings stats, but NEVER
   * commands the battery (no issue() from the arbitrage path). 'active': executes the
   * valley grid-charge (spends money). The owner reviews the captured advisory data, then
   * flips to 'active'. Any persisted rule missing this field hydrates to 'advisory'.
   */
  executionMode: "advisory" | "active";
  /**
   * CERTAINTY GATE (item 2): only pre-buy when ≥ this % sure the next peak's solar falls short.
   * The forecast solar over the peak is inflated to its optimistic percentile (z(p)·σ above the
   * mean) and a deficit must remain even then. Higher = more conservative (buys less often).
   * Default 70; clamp 50–95.
   */
  solarConfidencePct: number;
  /**
   * PRE-PEAK SURPLUS GUARD (item 3): when the next P1 is within this many hours AND the house is
   * already in strong live solar surplus, don't grid-buy this tick. Default 2; clamp 0–6.
   */
  prePeakSurplusGuardHours: number;
  /**
   * Pre-peak surplus margin (%): live solar must exceed live load by at least this % to trip the
   * pre-peak surplus stand-down (item 3). Default 30; clamp 0–200.
   */
  prePeakSurplusMarginPct: number;
  /**
   * Deviation threshold — repurposed (item 4) as a % of the FORECAST value. Each tick the live
   * solar/load are compared to the hour's forecast; when |live − forecast| ≥ max(deviationMinKw,
   * this%·forecast) on EITHER input, the plan cache is invalidated and the rule re-plans (emits a
   * `deviation` event). Default 30; clamp 1–100.
   */
  deviationThresholdPct: number;
  /**
   * Deviation floor (kW, item 4): a minimum absolute gap so a tiny forecast doesn't trip the
   * deviation re-plan on noise. Default 0.8; clamp 0–5.
   */
  deviationMinKw: number;
}

// ---- Tariff-arbitrage effectiveness logging --------------------------------
// Durable, reproducible record of what the arbitrage rule did (active) or WOULD have
// done (advisory) each tick. Events are appended to a JSONL file (off-state, survives a
// state-reset) AND kept as an in-state ring + headline stats (survives a restart via
// state.json). See control/arbitrage-log.ts for the writer. Advisory (modelled) vs active
// (realized) savings are tracked apart so the UI can label them.

export type ArbitrageEventType =
  | "plan"
  | "engage"
  | "revert"
  | "standdown"
  | "deviation";

export interface ArbitrageEvent {
  ts: number;
  type: ArbitrageEventType;
  executionMode: "advisory" | "active";
  band: Band;
  /** P1−P3 spread (€/kWh) at the event. */
  spreadEur: number;
  /** The plan headline (null when no forecast plan was available). */
  plan: {
    active: boolean;
    targetSocPct: number;
    valleyBuyKwh: number;
    peakDeficitKwh: number;
    reason: string;
  } | null;
  /** Live readings at the event. */
  live: {
    combinedSoc: number | null;
    sonnenSoc: number | null;
    teslaSoc: number | null;
    solarKw: number;
    loadKw: number;
    gridExportKw: number;
    /** Plan's expected combined SoC for the current hour (null when no plan). */
    expectedSocFromPlan: number | null;
    /** combinedSoc − expectedSocFromPlan (null when no plan / no SoC). */
    socDeviationPct: number | null;
  };
  /** The battery write taken this tick (null in advisory / no-op). */
  action: { mode: string; chargeW: number } | null;
  /** Forecast-vs-actual divergence that triggered a re-plan (item 4). Only set on `deviation`
   *  events; null otherwise. `input` = which forecast input crossed its tolerance. */
  deviation?: {
    input: "solar" | "load" | "solar+load";
    solarForecastKw: number;
    solarLiveKw: number;
    loadForecastKw: number;
    loadLiveKw: number;
  } | null;
  /** Energy bought this tick (active) or would-buy (advisory), kWh. */
  chargedKwhTick: number;
  /** MODELLED €saved this tick = chargedKwhTick × spreadEur. */
  estSavedEurTick: number;
}

/** Cumulative headline stats over the arbitrage history (survives restart via state.json).
 *  Advisory (modelled) and active (realized) are tracked apart so the UI labels them. */
export interface ArbitrageStats {
  /** Epoch ms the stats window opened (first event / default-creation). */
  sinceTs: number;
  /** Epoch ms of the most recent recorded event. */
  lastEventTs: number | null;
  /** Count of `engage` events while in active mode. */
  engagementsActive: number;
  /** Count of `engage` events while in advisory mode (would-have-engaged). */
  engagementsAdvisory: number;
  /** Valley kWh actually shifted (active engagements). */
  valleyKwhActive: number;
  /** Valley kWh that WOULD have been shifted (advisory engagements). */
  valleyKwhAdvisory: number;
  /** MODELLED €saved, realized (active engagements). */
  estSavedEurActive: number;
  /** MODELLED €saved, advisory (would-have-saved). */
  estSavedEurAdvisory: number;
}

/** Discriminated automation params: the surplus rules carry the climate shape; the
 *  tariff-arbitrage rule carries the battery shape. The coordinator narrows on `type`. */
export type AutomationParams =
  | SolarSurplusPrecoolParams
  | TariffArbitrageParams;

export interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  type: AutomationType;
  /** Shape depends on `type`: SolarSurplusPrecoolParams for the surplus rules,
   *  TariffArbitrageParams for `tariff_arbitrage`. Narrow on `type` before reading. */
  params: AutomationParams;
  /** Epoch ms of the last coordinator evaluation. */
  lastEval: number | null;
}

/** Type guard: a tariff-arbitrage automation (battery rule), narrowing its params shape. */
export function isTariffArbitrage(
  a: Automation,
): a is Automation & { params: TariffArbitrageParams } {
  return a.type === "tariff_arbitrage";
}

/**
 * STABLE canonical ids for the two seeded solar-surplus defaults — one per direction.
 * Pinned so future relabels/retargets never drift the id; the dismissal + de-dupe logic
 * keys off these. Older installs may carry a different persisted id for the same rule;
 * the de-dupe collapses by `type` so a relabeled instance is treated as the same rule.
 */
export const SOLAR_SURPLUS_COOL_AUTOMATION_ID = "solar-surplus-cool";
export const SOLAR_SURPLUS_HEAT_AUTOMATION_ID = "solar-surplus-heat";
/** @deprecated kept for back-compat with any importers of the pre-split single id. */
export const SOLAR_SURPLUS_AUTOMATION_ID = SOLAR_SURPLUS_COOL_AUTOMATION_ID;

/** STABLE canonical id for the seeded tariff-arbitrage default (task #15). Pinned so a
 *  relabel never drifts the id; the dismissal + de-dupe logic keys off it (and its type). */
export const TARIFF_ARBITRAGE_AUTOMATION_ID = "tariff-arbitrage";

/** Conservative default params for the tariff-arbitrage rule. Defaults match the
 *  owner-approved proposal; valley/peak default to the live tariff bands (P3/P1). */
export function defaultTariffArbitrageParams(): TariffArbitrageParams {
  return {
    peakTargetSocPct: 90,
    maxGridChargeKw: 4.6,
    minSpreadEur: 0.1,
    dischargeFloorPct: 20,
    solarShortfallOnly: true,
    surplusOverridesGridCharge: true,
    valleyBand: "P3",
    peakBand: "P1",
    // Production rollout: ship in ADVISORY (shadow) mode — observe & log, never command
    // the battery. The owner flips to 'active' after reviewing the captured data.
    executionMode: "advisory",
    solarConfidencePct: 70,
    prePeakSurplusGuardHours: 2,
    prePeakSurplusMarginPct: 30,
    // Item 4: deviation is now forecast-vs-actual on a % of the forecast value (was % SoC gap).
    deviationThresholdPct: 30,
    deviationMinKw: 0.8,
  };
}

/** Fresh (empty) arbitrage stats — the window opens now. */
export function defaultArbitrageStats(): ArbitrageStats {
  return {
    sinceTs: Date.now(),
    lastEventTs: null,
    engagementsActive: 0,
    engagementsAdvisory: 0,
    valleyKwhActive: 0,
    valleyKwhAdvisory: 0,
    estSavedEurActive: 0,
    estSavedEurAdvisory: 0,
  };
}

export interface ClimateGuardrails {
  setpointMinC: number;
  setpointMaxC: number;
  gridImportCapKw: number;
  minCycleMin: number;
  /** After a manual command, automation defers on that unit for this long (min). */
  manualOverrideMin: number;
}

export interface ClimateLogEntry {
  ts: number;
  deviceId: string;
  lever: string;
  from: string | number | null;
  to: string | number | null;
  reason: string;
  ok: boolean;
  detail: string;
}

export interface DevicesState {
  /** Master safety switch — DISARMED by default; nothing is ever written until armed. */
  armed: boolean;
  mode: ControlMode;
  updatedAt: number;
  lastError: string | null;
  /** Ring buffer of the last 100 climate command actions. */
  log: ClimateLogEntry[];
  guardrails: ClimateGuardrails;
  /** deviceId → epoch ms until which automation defers to a manual command. */
  manualOverrides: Record<string, number>;
  /**
   * PERSISTED provenance: the ids of units the solar-surplus rule itself switched ON.
   * This is the SINGLE SOURCE OF TRUTH for ownership and survives a restart/deploy:
   *   • A unit IN this set is rule-owned — the surplus rule may stop/retune it.
   *   • A unit that is powered ON but NOT in this set (dashboard, physical remote, or a
   *     schedule turned it on) is treated as MANUAL — the rule never powers it off and
   *     never retunes its mode/setpoint, and the UI shows the manual (hand) marker.
   * The rule adds an id when it starts a unit, and drops it when it stops the unit, the
   * unit is observed OFF, or the user takes manual control of it. (Replaces the former
   * `manualOn` map — manual is now derived as "powered on AND not rule-started", which
   * also protects remote-/schedule-started units that never touched our API.)
   */
  surplusStartedIds: string[];
  /** Global EV (car) solar/P3-charging tunables (docs/33). */
  evSurplus: EvSurplusTunables;
  /** Per-breaker runtime state for the EV-surplus rule (provenance + timestamps + live state).
   *  Keyed by Tuya device id. Persisted so minCycle / provenance survive a restart. */
  evState: Record<string, EvBreakerState>;
}

/** Per-breaker runtime state the EV-surplus rule tracks. */
export interface EvBreakerState {
  /** True iff the EV-surplus rule itself switched this breaker ON (provenance — only the
   *  rule's own ON's are ever switched off; manual/schedule control is never fought). */
  ruleOn: boolean;
  /** Epoch ms of the last on→off OR off→on toggle the rule made (for minCycleMin). */
  lastSwitchTs: number;
  /** Epoch ms the surplus first dropped below the stop band (for surplusClearSec), or 0. */
  surplusClearedSince: number;
  /** Last live decision, for the UI status line. */
  reason: 'surplus' | 'p3' | 'waiting' | 'off';
  /** Last reserved draw (W) the rule subtracted from the cooling surplus (0 when off). */
  reservedW: number;
}

// ---- Lights: scenes + schedules --------------------------------------------
// A dedicated, self-contained subsystem for the Tuya light fleet (kept separate
// from the climate Schedule/Action model). A SCENE is a named set of per-light
// targets (on/off + optional brightness). A light SCHEDULE applies a target
// (a scene, or an ad-hoc set of lights) at an on-time and optionally switches
// the involved lights off at an off-time, on chosen weekdays.

export interface LightSceneMember {
  lightId: string;
  on: boolean;
  /** Brightness % (1–100) to set when turning on; null/undefined = leave as-is. */
  brightnessPct?: number | null;
}

export interface LightScene {
  id: string;
  name: string;
  /** Lucide icon name (UI wayfinding). */
  icon?: string;
  /** Starred by the owner — favorites surface first in the Scenes grid. */
  favorite?: boolean;
  members: LightSceneMember[];
}

// ---- Whole-home scenes -----------------------------------------------------
// A cross-domain scene: one named "moment" that fans out across lights, climate
// and blinds at once (reusing the per-light member shape). Applying a scene is
// best-effort — each device is wrapped in try/catch so one failure never aborts
// the rest. The `special:'all-off'` variant needs no explicit member IDs: it
// turns the whole live light + climate fleet off and (if a blinds intent is
// present) closes the blinds, so it works on any install without per-device setup.

export interface HomeSceneClimateMember {
  deviceId: string;
  power: boolean;
  /** Climate mode to set when power on (e.g. 'cool'/'heat'); omit to leave as-is. */
  mode?: string;
  /** Target setpoint °C when power on (clamped 10–32); null/undefined = leave as-is. */
  setpointC?: number | null;
}

export interface HomeSceneBlindMember {
  /** Tuya blind id, OR the sentinel '*' meaning "all blinds" (used by all-off scenes). */
  blindId: string;
  action: "open" | "close" | "position";
  /** Target % open (0–100) when action is 'position'; null/undefined otherwise. */
  positionPct?: number | null;
}

export interface HomeScene {
  id: string;
  name: string;
  /** Lucide icon name (UI wayfinding). */
  icon?: string;
  /** Starred by the owner — favorites surface first (e.g. the wall-tablet Home). */
  favorite?: boolean;
  /** When set, apply turns ALL lights + climate off and (optionally) closes blinds —
   *  no explicit member IDs needed (works on any install). 'all-off' is the only kind. */
  special?: "all-off";
  /** Per-light targets (reuses the existing light-scene member shape). */
  lights: LightSceneMember[];
  /** Per-climate-unit targets (power + optional mode/setpoint). */
  climate: HomeSceneClimateMember[];
  /** Per-blind targets; a single `{ blindId: '*', action: 'close' }` member means "all blinds". */
  blinds: HomeSceneBlindMember[];
}

// ---- Scene controllers (wireless scene switches) ---------------------------
// A Tuya wireless scene switch (category 'wxkg') is an INPUT device: each of its
// N buttons emits a `switch_mode{N}` DP event on press (single_click / double_click /
// long_press). We can't see repeated presses via status polling, so the coordinator
// reads the device LOGS and, for each new single-click on a bound button, TOGGLES the
// bound whole-home scene on/off. Double/long are reserved for Phase 2 (fields present,
// no engine yet). Phase 1 acts on single-click only. Persisted so the toggle state +
// log watermark survive restarts.

/** A press binding's target: either a Light scene (from the Lights feature) or a
 *  whole-home scene. `kind` defaults to 'home' for records written before this field
 *  existed. `on` is the persisted current toggle state. */
export interface SceneButtonPress {
  /** Which scene store the sceneId refers to. */
  kind: "light" | "home";
  sceneId: string;
  on: boolean;
}

export interface SceneButtonBinding {
  /** 1-based physical button index (1..4). */
  index: number;
  /** Optional friendly label for this button. */
  label?: string;
  /** Single-click binding: the scene to toggle, plus the persisted current toggle state. */
  single?: SceneButtonPress;
  /** RESERVED (Phase 2) — double-click binding. No engine yet. */
  double?: SceneButtonPress;
  /** RESERVED (Phase 2) — long-press binding. No engine yet. */
  long?: SceneButtonPress;
}

export interface SceneController {
  /** Master per-controller gate — only an enabled controller's presses are acted on. */
  enabled: boolean;
  /** The 4 button bindings (index 1..4). Always length 4 after hydration. */
  buttons: SceneButtonBinding[];
  /** Highest log event_time (epoch ms) already processed — events at/below this never replay. */
  watermarkMs?: number;
}

export type LightScheduleTarget =
  | { kind: "scene"; sceneId: string }
  | { kind: "lights"; members: LightSceneMember[] };

export interface LightSchedule {
  id: string;
  name: string;
  enabled: boolean;
  /** Days of week the schedule runs on (0=Sun..6=Sat). */
  days: number[];
  /** Local "HH:MM" fallback — used when onAnchor is 'fixed' or as display fallback. */
  onTime: string;
  /** Anchor for turn-on time. Default 'fixed' = use onTime directly. */
  onAnchor?: TimeAnchor;
  /** Minutes offset from the solar anchor (±). Default 0. */
  onOffsetMin?: number;
  /** Optional local "HH:MM" — switch the target's lights off. null = no auto-off. */
  offTime?: string | null;
  /** Anchor for turn-off time. Default 'fixed' = use offTime directly. */
  offAnchor?: TimeAnchor;
  /** Minutes offset from the solar anchor (±). Default 0. */
  offOffsetMin?: number;
  /** Variation window for on-time (minutes); actual offset = ±(onVariationMin/2). */
  onVariationMin?: number;
  /** Variation window for off-time (minutes); actual offset = ±(offVariationMin/2). */
  offVariationMin?: number;
  target: LightScheduleTarget;
}

// ---- Rooms ------------------------------------------------------------------
// A first-class, cross-cutting Rooms concept that spans EVERY device type. A device's
// room is stored on deviceSettings[deviceId].roomId (a single map keyed by the globally-
// unique device id), so climate/lights/blinds/generic all resolve their room the same way.

/** A room — a flat (no floors/zones hierarchy) named bucket devices are assigned to. */
export interface Room {
  id: string;
  name: string;
  /** Lucide icon name (UI wayfinding). */
  icon: string;
  /** Sort order in the By-room view + manage list (first-seen on seed; user-reorderable). */
  order: number;
}

// ---- Sonos radio: favourite stations + schedules ---------------------------
// A self-contained internet-radio subsystem for the Sonos fleet (separate from the
// house-alarm path, which uses the non-destructive PlayNotification). A FAVOURITE is
// a saved station in one of 10 slots (name + stream URL, optional logo/codec). A radio
// SCHEDULE plays a station on chosen speakers at a chosen volume at an on-time, and
// optionally stops at an off-time, on chosen weekdays — mirrors the light schedule model.

/** Hard cap on favourite radio slots surfaced in the UI grid. */
export const RADIO_FAVORITE_SLOTS = 10;

export interface RadioStation {
  id: string;
  /** Slot index 0..RADIO_FAVORITE_SLOTS-1 (position in the favourites grid). */
  slot: number;
  name: string;
  /** The HTTP(S) stream URL (the connector strips the scheme + applies x-rincon-mp3radio://). */
  streamUrl: string;
  /** Optional station logo/favicon URL (from the directory or import). */
  logo?: string;
  /** Optional codec hint (e.g. 'MP3', 'AAC') surfaced in the UI. */
  codec?: string;
}

export interface RadioSchedule {
  id: string;
  name: string;
  enabled: boolean;
  /** Days of week the schedule runs on (0=Sun..6=Sat). */
  days: number[];
  /** Local "HH:MM" — when to start the station. */
  onTime: string;
  /** Optional local "HH:MM" — stop the speakers. null = no auto-stop. */
  offTime?: string | null;
  /** The favourite station to play (by id). */
  stationId: string;
  /** Speaker UUIDs to play on; empty = ALL discovered speakers. */
  speakerIds: string[];
  /** Playback volume 0–100. */
  volumePct: number;
}

/**
 * The currently-playing radio station (or null when idle). Persisted so the now-playing
 * banner — with the ACTUAL target speakers — survives a restart and reflects what's really
 * sounding. `speakerIds` is the resolved set the station was played on (empty = whole house
 * was targeted explicitly). Set on play, cleared on stop.
 */
export interface RadioNowPlaying {
  /** Station label (for the banner). */
  name: string;
  /** Favourite station id when played from a slot; null for an ad-hoc URL play. */
  stationId: string | null;
  /** Resolved speaker UUIDs the station is playing on. */
  speakerIds: string[];
  /** True when the play targeted the WHOLE house (no/empty speaker selection). */
  wholeHouse: boolean;
  /** Coordinator UUID for the play group. */
  coordinator: string | null;
  /** ISO timestamp the play started. */
  startedAt: string;
}

// ---- Irrigation (Rain Bird Phase 2: smart-watering brain) -----------------
// The APP owns the optimized plan; the controller's onboard weekly program is the
// autonomous reliability FLOOR. When healthy the coordinator SUPPRESSES that program
// with a rolling 1-day rain-delay and fires each zone itself; if the app/mini fails
// the delay lapses and the controller resumes on its own (dead-man's switch).

/** Mode of the irrigation coordinator:
 *  - 'off'    : coordinator does nothing (no suppression, no firing). Controller's onboard
 *               program runs (whatever the keypad set). Default.
 *  - 'shadow' : computes + LOGS the full plan every tick but actuates NOTHING (no delay
 *               refresh, no zone firing). SHADOW-FIRST safety — ships here.
 *  - 'live'   : refreshes the suppression rain-delay and fires zones per the trimmed plan.
 *               Gated behind the SAME arm model as the other coordinators (armed+mode!=off). */
export type IrrigationMode = "off" | "shadow" | "live";

/** Plant / crop type → drives the crop coefficient (Kc) used in the ETc calc. */
export type IrrigationPlantType =
  | "lawn"
  | "shrubs"
  | "flowers"
  | "vegetables"
  | "trees"
  | "groundcover"
  | "succulents"
  | "hedge";

/** Emitter type → a rough default flow (L/min) when the owner hasn't measured one. */
export type IrrigationEmitterType =
  | "spray"
  | "rotor"
  | "drip"
  | "bubbler"
  | "soaker";

/** Who owns a zone's schedule: the APP (we fire it) or the CONTROLLER baseline (keypad). */
export type IrrigationManagedBy = "app" | "controller";

/** One watering time on a zone's weekly schedule: a start time, a duration CEILING, and
 *  the weekdays it runs. The ET engine only ever TRIMS the duration down from here. */
export interface IrrigationWateringTime {
  id: string;
  /** Local "HH:MM" start. */
  startTime: string;
  /** Scheduled (max) duration in minutes — the ceiling the ET engine trims from. */
  durationMin: number;
  /** Weekdays this time runs on (index 0=Sun..6=Sat). */
  days: boolean[];
}

/** Per-zone agronomic + scheduling config, keyed by station id (`rb-<n>`). */
export interface IrrigationZoneConfig {
  /** Station device id (`rb-<station>`). */
  zoneId: string;
  /** Friendly zone name (overrides the bare "Zone N"). */
  name: string;
  plantType: IrrigationPlantType;
  emitterType: IrrigationEmitterType;
  /** Emitter flow in L/min. When undefined the emitter-type default is used. */
  flowLpm?: number;
  /** Zone area in m² (optional; used for volume/precip-rate context). */
  areaM2?: number;
  /** Sun exposure 0..1 (1 = full sun) — scales the ET demand. */
  sunExposure?: number;
  /** Crop coefficient override. When undefined the plant-type default Kc is used. */
  kc?: number;
  /** App fires this zone, or the controller baseline owns it (we never fire it). */
  managedBy: IrrigationManagedBy;
  /** Allow a HEAT top-up (add minutes back) on very hot/high-ET days. Default off. */
  heatTopupEnabled: boolean;
  /** Per-zone rain-skip threshold (mm of forecast precip). Falls back to the global one. */
  rainSkipMm?: number;
  /** Photo asset id (served from /api/irrigation/photos/<id>). Never sent to the controller. */
  photoId?: string;
  /** The zone's weekly watering times (the ceiling schedule). */
  wateringTimes: IrrigationWateringTime[];
}

/** A rolling per-zone soil-water-balance deficit (mm), updated as runs are applied/logged. */
export interface IrrigationDeficit {
  /** Current modelled deficit in mm (Σ ETc − effective rain − applied irrigation; ≥ 0). */
  mm: number;
  /** ISO timestamp the deficit was last advanced. */
  updatedAt: string;
}

/** A future soil-moisture-sensor reading interface (not yet wired to hardware). When
 *  present for a zone it OVERRIDES the modelled deficit; the ET model is the fallback. */
export interface SoilMoistureReading {
  zoneId: string;
  /** Volumetric moisture 0..100 (%). */
  pct: number;
  ts: string;
}

/** A non-destructive snapshot of the controller's baseline program, mirrored ~daily so
 *  we can surface drift ("baseline changed — update mirror?") without ever overwriting it. */
export interface IrrigationBaselineMirror {
  /** ISO timestamp the mirror was last refreshed from the controller. */
  ts: string;
  /** Rain-delay days the controller reported (our suppression delay shows up here too). */
  rainDelayDays: number;
  /** Station ids the controller reported as available, for drift detection. */
  availableStationIds: string[];
}

/** Preferred window to bias watering into (never at the expense of plant health). */
export type IrrigationWindow =
  | "early-morning"
  | "solar-surplus"
  | "off-peak-P3"
  | "none";

/** One logged coordinator decision (shadow or live) for the irrigation activity feed. */
export interface IrrigationLogEntry {
  ts: number;
  zoneId: string;
  /** What the coordinator did / would do. */
  action: "plan" | "fire" | "trim" | "skip" | "suppress" | "confirm" | "alert";
  /** True = actually actuated (live); false = shadow / would-do / informational. */
  live: boolean;
  ok: boolean;
  detail: string;
}

/** The whole irrigation Phase-2 state block. Additive + defensively migrated. */
export interface IrrigationState {
  mode: IrrigationMode;
  /** Global rain-skip threshold (mm forecast precip ⇒ skip). Per-zone may override. */
  globalRainSkipMm: number;
  /** Global precip-probability skip threshold (%). */
  rainSkipProbabilityPct: number;
  /** Preferred watering window the coordinator biases into. */
  window: IrrigationWindow;
  /** Per-zone configs keyed by zoneId (`rb-<n>`). */
  zones: Record<string, IrrigationZoneConfig>;
  /** Per-zone rolling soil-water-balance deficit (mm). */
  deficits: Record<string, IrrigationDeficit>;
  /** Latest soil-moisture sensor readings by zoneId (future hardware; usually empty). */
  soilMoisture: Record<string, SoilMoistureReading>;
  /** Mirror of the controller's baseline program + a drift flag. */
  baselineMirror: IrrigationBaselineMirror | null;
  /** True when the last baseline re-read differed from the mirror (surfaced, non-destructive). */
  baselineDrift: boolean;
  /** Coordinator activity log (shadow + live decisions), pruned like devices.log. */
  log: IrrigationLogEntry[];
  /** Last error surfaced from a coordinator tick (e.g. box unreachable), or null. */
  lastError: string | null;
  /** ISO timestamp of the last successful coordinator tick. */
  lastTickAt: string | null;
  updatedAt: number;
}

export interface StoreSchema {
  channels: Channels;
  rules: RuleState[];
  /** Grid-voltage band monitor (Live KPI + `rule-voltage` alert). */
  voltageMonitor: VoltageMonitor;
  alertOverrides: Record<string, AlertOverride>;
  activeScenario: string;
  scenarios: Record<string, ScenarioDef>;
  pushSubscriptions: StoredPushSubscription[];
  vapid: VapidKeys | null;
  teslaRefreshToken: string | null;
  /** alert id -> first-seen epoch ms, for notification dedupe. */
  seenAlerts: Record<string, number>;
  auth: AuthState;
  control: ControlState;
  // ---- Devices / Climate ----
  integrations: IntegrationsState;
  deviceSettings: Record<string, DeviceSettings>;
  schedules: Schedule[];
  automations: Automation[];
  /**
   * Ids of SEEDED DEFAULT automations the owner has deleted. `mergeAutomations` will
   * not re-add a default whose id is listed here, so deleting a default rule makes it
   * stay gone across restarts/deploys (previously a default was re-seeded every boot).
   */
  dismissedDefaultAutomationIds: string[];
  devices: DevicesState;
  /** Tuya light scenes + schedules (self-contained; see types above). */
  lightScenes: LightScene[];
  lightSchedules: LightSchedule[];
  /** Whole-home (cross-domain) scenes — lights + climate + blinds in one moment. */
  homeScenes: HomeScene[];
  /** Wireless scene-switch bindings, keyed by Tuya device id — each button → a scene
   *  (single-click toggle). Created when a device is set up as a 'controller'. */
  sceneControllers: Record<string, SceneController>;
  /** Device-onboarding triage state (the "Discovered devices" inbox). Phase 1
   *  persists only the list of ignored device ids; later phases extend this. */
  deviceOnboarding: DeviceOnboardingState;
  /** Active house-alarm session (siren + light-blink), or null when idle. Persisted
   *  so the UI banner survives a restart and the engine can resume/auto-stop. */
  alarmActive: AlarmActive | null;
  /** Owner-configurable house-alarm defaults (Settings → Alarm / Panic). */
  alarmConfig: AlarmConfig;
  /** First-class Rooms: roomId → Room. Devices map to a room via deviceSettings[id].roomId. */
  rooms: Record<string, Room>;
  /** One-time guard: once true the auto-seed/pre-assign migration never runs again, so it
   *  can't clobber the owner's room edits/assignments on a later boot. */
  roomsSeeded: boolean;
  /** Sonos internet-radio favourites (10 slots) + schedules (self-contained). */
  radioFavorites: RadioStation[];
  radioSchedules: RadioSchedule[];
  /** The active radio now-playing session (with the real target speakers), or null. */
  radioNowPlaying: RadioNowPlaying | null;
  /** Rain Bird Phase-2 smart-watering state (zones, schedules, deficits, mode). The
   *  coordinator ships in 'shadow' by default — it actuates nothing until the owner
   *  flips it to 'live' AND the Devices layer is armed. */
  irrigation: IrrigationState;
}

/**
 * A per-DP override applied on top of inference (the Advanced "datapoints" editor in
 * the setup sheet). Lets the user correct a misclassified DP: change its capability
 * kind, relabel it, hide it, or force it read-only. Only the fields the user changed
 * are stored; everything else falls through to the inferred capability.
 */
export interface CapabilityOverride {
  /** The Tuya DP code this override targets. */
  dp: string;
  /** Force a different capability kind (e.g. an `action` the user knows is a `switch`). */
  kind?:
    | "switch"
    | "range"
    | "enum"
    | "action"
    | "color"
    | "measure"
    | "status";
  /** Custom label (replaces the inferred one). */
  label?: string;
  /** Hide this capability from the control surface entirely. */
  hidden?: boolean;
  /** Force read-only (never write this DP) even if inference thought it writable. */
  readOnly?: boolean;
}

/** A device the user has SET UP (graduated from the inbox into its type group). */
export interface ConfiguredDevice {
  /** Built-in DeviceType key (e.g. 'switching') OR a custom type id ('custom-…'). */
  typeId: string;
  /** User-assigned display name (prefilled from the device name during setup). */
  name: string;
  /** Per-DP overrides from the Advanced datapoints editor; applied over inference. */
  capOverrides?: CapabilityOverride[];
  /** ISO timestamp the device was set up. */
  setupAt: string;
}

/** A user-minted device type (e.g. "Smart lock") — a label + an icon, store-backed. */
export interface CustomDeviceType {
  /** Stable id, 'custom-…'. A ConfiguredDevice.typeId may reference this. */
  id: string;
  label: string;
  /** Lucide icon name. */
  icon: string;
}

/** Persisted onboarding/triage state for discovered (not-yet-set-up) Tuya devices. */
export interface DeviceOnboardingState {
  /** Device ids the user has chosen to ignore (hidden from the inbox; un-ignorable). */
  ignored: string[];
  /** Set-up devices keyed by device id (graduated out of the inbox into a group). */
  configured: Record<string, ConfiguredDevice>;
  /** User-minted custom device types (label + icon). */
  customDeviceTypes: CustomDeviceType[];
}

// ---- Defaults -----------------------------------------------------------

export const DEFAULT_RULES: RuleState[] = [
  { id: "rule-grid-charge", enabled: true },
  { id: "rule-reserve", enabled: true },
  { id: "rule-offline", enabled: true },
  { id: "rule-outage", enabled: true },
  { id: "rule-export", enabled: false },
  // The voltage rule's enable-state is owned by voltageMonitor.enabled (its own config),
  // but it appears in the rules list so it surfaces in the feed/labels like the others.
  { id: "rule-voltage", enabled: true },
];

/** Grid-voltage monitor defaults — ENABLED, band 190–240 V, breaker auto-picked. */
export function defaultVoltageMonitor(): VoltageMonitor {
  return { enabled: true, minV: 190, maxV: 240 };
}

export const DEFAULT_SCENARIOS: Record<string, ScenarioDef> = {
  balanced: {
    name: "Balanced",
    icon: "scale",
    weights: { save: 0.4, self: 0.3, indep: 0.2, comfort: 0.1 },
    reserve: 20,
    dynReserve: false,
    gridCharge: false,
    exportRule: "surplus",
    ev: "solar-only",
    precondition: true,
    activation: "manual",
    trigger: "",
  },
  "max-savings": {
    name: "Max savings",
    icon: "piggy-bank",
    weights: { save: 0.7, self: 0.2, indep: 0.05, comfort: 0.05 },
    reserve: 10,
    dynReserve: false,
    gridCharge: true,
    exportRule: "surplus",
    ev: "cheap-grid",
    precondition: true,
    activation: "manual",
    trigger: "",
  },
  "self-sufficient": {
    name: "Self-sufficient",
    icon: "leaf",
    weights: { save: 0.2, self: 0.5, indep: 0.25, comfort: 0.05 },
    reserve: 20,
    dynReserve: true,
    gridCharge: false,
    exportRule: "never",
    ev: "solar-only",
    precondition: true,
    activation: "manual",
    trigger: "",
  },
  "storm-ready": {
    name: "Storm-ready",
    icon: "shield",
    weights: { save: 0.15, self: 0.25, indep: 0.5, comfort: 0.1 },
    reserve: 50,
    dynReserve: true,
    gridCharge: true,
    exportRule: "never",
    ev: "asap",
    precondition: false,
    activation: "auto",
    trigger: "Storm watch or red weather warning for the area",
  },
};

/** DISARMED, mode 'off' — the safe default. Nothing is written until armed. */
export function defaultControl(): ControlState {
  return {
    armed: false,
    mode: "off",
    updatedAt: Date.now(),
    lastError: null,
    log: [],
    guardrails: {
      socFloorPct: 10,
      teslaReserveMinPct: 15,
      sonnenMaxW: 4600,
      gridImportCapKw: 14,
    },
    batteryPriority: defaultBatteryPriority(),
    soakExport: defaultSoakExport(),
    arbitrageLog: [],
    arbitrageStats: defaultArbitrageStats(),
    dischargeV2Shadowed: false,
  };
}

/** Sonnen-first / Tesla-first defaults — ENABLED but SHADOW, so they log
 *  intended actions and write nothing until promoted to 'auto' in the UI. */
export function defaultBatteryPriority(): BatteryPriority {
  return {
    dischargeSonnenFirst: {
      enabled: true,
      authority: "shadow",
      throughputKw: 3.0,
    },
    chargeTeslaFirst: { enabled: true, authority: "shadow", throughputKw: 3.0 },
  };
}

/** Surplus-soak defaults — the values that were hardcoded in the coordinator.
 *  ENABLED so a deploy preserves today's live behaviour. */
export function defaultSoakExport(): SoakExportRule {
  return { enabled: true, startW: 400, stopW: 150, socCeilingPct: 98 };
}

/** EV (car) solar/P3-charging tunables — docs/33 owner defaults. The rule is OPT-IN
 *  per breaker (deviceSettings[id].solarP3Only, default false) so these are inert until used. */
export function defaultEvSurplus(): EvSurplusTunables {
  return {
    estimateW: 3700,
    startMarginW: 300,
    stopHysteresisW: 300,
    surplusClearSec: 180,
    minCycleMin: 5,
    learnFloorW: 500,
  };
}

/** DISARMED, mode 'off' — the safe default for the devices/climate layer. */
export function defaultDevices(): DevicesState {
  return {
    armed: false,
    mode: "off",
    updatedAt: Date.now(),
    lastError: null,
    log: [],
    guardrails: {
      setpointMinC: 16,
      setpointMaxC: 30,
      gridImportCapKw: 14,
      minCycleMin: 8,
      manualOverrideMin: 120,
    },
    manualOverrides: {},
    surplusStartedIds: [],
    evSurplus: defaultEvSurplus(),
    evState: {},
  };
}

/** The two flagship solar-surplus automations — one per direction — seeded DISABLED so
 *  neither acts until enabled + armed:
 *   • Solar-surplus cooling — cool an enrolled HVAC when its room is warm > 25 → to 23°C.
 *   • Solar-surplus heating — heat an enrolled HVAC when its room is cold < 19 → to 21°C.
 *  (Airzone underfloor is excluded from both — it is no longer surplus-eligible.) Both
 *  carry the full param shape so the migration of a legacy unified rule preserves every
 *  target; each rule's coordinator only consults its own direction's fields. */
export function defaultAutomations(): Automation[] {
  return [
    {
      id: SOLAR_SURPLUS_COOL_AUTOMATION_ID,
      name: "Solar-surplus cooling",
      enabled: false,
      type: "solar_surplus_precool",
      params: {
        roomTempLimitC: 25,
        targetSetpointC: 24,
        heatRoomFloorC: 19,
        heatTargetSetpointC: 21,
        surplusClearSec: 120,
        bandRestrictionEnabled: true,
        exitBand: "P1",
        startThresholdW: 3000,
        minRunSec: 900,
        fanLevel: 2,
      },
      lastEval: null,
    },
    {
      id: SOLAR_SURPLUS_HEAT_AUTOMATION_ID,
      name: "Solar-surplus heating",
      enabled: false,
      type: "solar_surplus_preheat",
      params: {
        roomTempLimitC: 25,
        targetSetpointC: 23,
        heatRoomFloorC: 19,
        heatTargetSetpointC: 21,
        surplusClearSec: 120,
        bandRestrictionEnabled: true,
        exitBand: "P1",
        startThresholdW: 3000,
        minRunSec: 900,
        fanLevel: 2,
      },
      lastEval: null,
    },
    {
      // Tariff arbitrage (task #15) — battery rule. SEEDED DISABLED: shipping it must NOT
      // change battery behavior. It only ever acts when enabled && armed && mode==='auto'.
      id: TARIFF_ARBITRAGE_AUTOMATION_ID,
      name: "Tariff arbitrage",
      enabled: false,
      type: "tariff_arbitrage",
      params: defaultTariffArbitrageParams(),
      lastEval: null,
    },
  ];
}

/**
 * Starter whole-home scenes seeded on first run. Member IDs are install-specific, so we
 * only seed ID-FREE scenes that work everywhere via the `special:'all-off'` path: it turns
 * the whole live light + climate fleet off and closes blinds. The single sentinel blind
 * member `{ blindId: '*', action: 'close' }` is interpreted by applyHomeScene as "all blinds".
 * Named scenes that need real member IDs (Good morning/Cooking/Movie night) are created later
 * via the admin builder, so they're NOT seeded here.
 */
export function defaultHomeScenes(): HomeScene[] {
  return [
    {
      id: "home-scene-good-night",
      name: "Good night",
      icon: "moon",
      special: "all-off",
      lights: [],
      climate: [],
      blinds: [{ blindId: "*", action: "close" }],
    },
    {
      id: "home-scene-away",
      name: "Away",
      icon: "door-exit",
      special: "all-off",
      lights: [],
      climate: [],
      blinds: [{ blindId: "*", action: "close" }],
    },
  ];
}

function defaults(): StoreSchema {
  return {
    channels: {
      whatsapp: { number: "+34 612 345 197", enabled: true },
      push: { enabled: true },
      email: { address: "j.kroese@levante.nl", enabled: false },
    },
    rules: DEFAULT_RULES.map((r) => ({ ...r })),
    voltageMonitor: defaultVoltageMonitor(),
    alertOverrides: {},
    activeScenario: "balanced",
    scenarios: structuredClone(DEFAULT_SCENARIOS),
    pushSubscriptions: [],
    vapid: null,
    teslaRefreshToken: null,
    seenAlerts: {},
    auth: defaultAuth(),
    control: defaultControl(),
    integrations: { intesis: null },
    deviceSettings: {},
    schedules: [],
    automations: defaultAutomations(),
    dismissedDefaultAutomationIds: [],
    devices: defaultDevices(),
    lightScenes: [],
    lightSchedules: [],
    homeScenes: defaultHomeScenes(),
    sceneControllers: {},
    deviceOnboarding: { ignored: [], configured: {}, customDeviceTypes: [] },
    alarmActive: null,
    alarmConfig: defaultAlarmConfig(),
    rooms: {},
    roomsSeeded: false,
    radioFavorites: [],
    radioSchedules: [],
    radioNowPlaying: null,
    irrigation: defaultIrrigation(),
  };
}

/** Irrigation Phase-2 defaults — SHADOW-FIRST and inert: mode 'off' (the coordinator does
 *  nothing), no zones configured, no deficits. The owner adds zones + flips to shadow/live. */
export function defaultIrrigation(): IrrigationState {
  return {
    mode: "off",
    globalRainSkipMm: 5,
    rainSkipProbabilityPct: 60,
    window: "early-morning",
    zones: {},
    deficits: {},
    soilMoisture: {},
    baselineMirror: null,
    baselineDrift: false,
    log: [],
    lastError: null,
    lastTickAt: null,
    updatedAt: Date.now(),
  };
}

export function defaultAuth(): AuthState {
  return {
    users: [],
    sessions: [],
    trustedDevices: [],
    otps: [],
    resetTokens: [],
    setupTokens: [],
    loginAttempts: {},
  };
}

// ---- Path ---------------------------------------------------------------

function statePath(): string {
  if (process.env.STATE_FILE) return process.env.STATE_FILE;
  if (process.env.NODE_ENV === "production") return "/opt/energy/state.json";
  // repoRoot = three levels up from apps/api/src in the CJS prod bundle. Under
  // tsx/ESM dev __dirname is undefined, so derive it from cwd (apps/api).
  const repoRoot =
    typeof __dirname !== "undefined"
      ? resolve(__dirname, "..", "..", "..")
      : resolve(process.cwd(), "..", "..");
  return resolve(repoRoot, ".data", "state.json");
}

/** The writable data DIRECTORY holding state.json (and sibling app assets, e.g. irrigation
 *  garden photos). Same resolution as statePath() so on-disk assets land beside the state. */
export function dataDir(): string {
  return dirname(statePath());
}

// ---- Load / persist -----------------------------------------------------

let cache: StoreSchema | null = null;
let path: string | null = null;

function file(): string {
  if (!path) path = statePath();
  return path;
}

// ---- Schedule normalization / legacy migration -------------------------
// Persisted state may hold legacy schedules (flat start/end/mode/setpointC +
// scope.deviceIds[]). On load we migrate them to the unit-scoped rule shape:
// one rule per device, start/end → windows[], mode/setpoint → action,
// roomTempAboveC → warmerThan. Already-migrated rules pass through coerced.

function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function coerceFan(v: unknown): FanSetting {
  return v === 1 || v === 2 || v === 3 || v === 4 || v === 5 ? v : "auto";
}
function coerceVane(v: unknown): VaneSetting {
  return v === 1 || v === 2 || v === 3 || v === 4 || v === 5 ? v : "auto";
}
function coerceMode(v: unknown): ClimateMode {
  return v === "auto" ||
    v === "heat" ||
    v === "dry" ||
    v === "fan" ||
    v === "cool"
    ? v
    : "cool";
}
function coerceAction(raw: unknown): Action {
  const a = (raw ?? {}) as Partial<Action>;
  return {
    power: typeof a.power === "boolean" ? a.power : true,
    mode: coerceMode(a.mode),
    setpointC: typeof a.setpointC === "number" ? a.setpointC : 24,
    fan: coerceFan(a.fan),
    vaneUpDown: coerceVane(a.vaneUpDown),
    vaneLeftRight: coerceVane(a.vaneLeftRight),
    ...(typeof a.positionPct === "number"
      ? { positionPct: Math.min(100, Math.max(0, Math.round(a.positionPct))) }
      : {}),
    ...(typeof a.speed === "number" ? { speed: Math.round(a.speed) } : {}),
    ...(typeof a.direction === "string" && a.direction
      ? { direction: a.direction }
      : {}),
  };
}
function coerceCondition(raw: unknown): RunCondition {
  const c = raw as { kind?: string; thresholdC?: number } | undefined;
  if (c?.kind === "warmerThan" && typeof c.thresholdC === "number")
    return { kind: "warmerThan", thresholdC: c.thresholdC };
  if (c?.kind === "coolerThan" && typeof c.thresholdC === "number")
    return { kind: "coolerThan", thresholdC: c.thresholdC };
  return { kind: "always" };
}
function coerceDays(v: unknown): number[] {
  return Array.isArray(v)
    ? v.filter((d) => typeof d === "number" && d >= 0 && d <= 6)
    : [1, 2, 3, 4, 5];
}
function coerceWindows(v: unknown): ScheduleWindow[] {
  const list = Array.isArray(v) ? v : [];
  const out: ScheduleWindow[] = [];
  for (const w of list) {
    if (w && typeof w.start === "string" && typeof w.end === "string") {
      const win: ScheduleWindow = {
        start: w.start,
        end: w.end,
        ...(w.action ? { action: w.action as Partial<Action> } : {}),
      };
      if (w.startAnchor === "sunrise" || w.startAnchor === "sunset") {
        win.startAnchor = w.startAnchor;
        win.startOffsetMin =
          typeof w.startOffsetMin === "number"
            ? Math.round(w.startOffsetMin)
            : 0;
      }
      if (w.endAnchor === "sunrise" || w.endAnchor === "sunset") {
        win.endAnchor = w.endAnchor;
        win.endOffsetMin =
          typeof w.endOffsetMin === "number" ? Math.round(w.endOffsetMin) : 0;
      }
      out.push(win);
    }
  }
  return out.length ? out : [{ start: "08:00", end: "22:00" }];
}

/** True for a legacy (pre-rule) schedule shape that must be migrated. */
function isLegacySchedule(s: Record<string, unknown>): boolean {
  return (
    !Array.isArray(s.windows) &&
    (typeof s.start === "string" ||
      Array.isArray((s.scope as { deviceIds?: unknown })?.deviceIds))
  );
}

/** Migrate one legacy schedule into 0..N unit-scoped rules (one per device). */
function migrateLegacySchedule(s: Record<string, unknown>): Schedule[] {
  const scope = s.scope as { deviceIds?: unknown } | undefined;
  const ids = Array.isArray(scope?.deviceIds)
    ? (scope!.deviceIds as string[])
    : [];
  if (ids.length === 0) return []; // bound to no unit — it did nothing; drop on migrate.
  const action: Action = {
    power: true,
    mode: coerceMode(s.mode),
    setpointC: typeof s.setpointC === "number" ? s.setpointC : 24,
    fan: coerceFan(s.fan),
    vaneUpDown: "auto",
    vaneLeftRight: "auto",
  };
  const condition: RunCondition =
    typeof s.roomTempAboveC === "number"
      ? { kind: "warmerThan", thresholdC: s.roomTempAboveC }
      : { kind: "always" };
  const windows: ScheduleWindow[] = [
    {
      start: typeof s.start === "string" ? s.start : "08:00",
      end: typeof s.end === "string" ? s.end : "22:00",
    },
  ];
  const baseId = typeof s.id === "string" ? s.id : genId("sched");
  return ids.map((deviceId, i) => ({
    id: ids.length > 1 ? `${baseId}-${i}` : baseId,
    name: typeof s.name === "string" ? s.name : "Schedule",
    enabled: typeof s.enabled === "boolean" ? s.enabled : true,
    type: "cooling" as DeviceType,
    scope: { kind: "unit", deviceId },
    days: coerceDays(s.days),
    windows,
    action,
    condition,
  }));
}

/** Coerce one already-migrated rule, defaulting any missing fields. */
function coerceSchedule(s: Record<string, unknown>): Schedule | null {
  const rawScope = s.scope as
    | { kind?: string; deviceId?: string; groupId?: string }
    | undefined;
  let scope: ScheduleScope;
  if (rawScope?.kind === "group" && typeof rawScope.groupId === "string")
    scope = { kind: "group", groupId: rawScope.groupId };
  else if (rawScope?.kind === "unit" && typeof rawScope.deviceId === "string")
    scope = { kind: "unit", deviceId: rawScope.deviceId };
  else return null;
  const type =
    s.type === "heating" ||
    s.type === "lighting" ||
    s.type === "circuit" ||
    s.type === "blinds"
      ? s.type
      : "cooling";
  return {
    id: typeof s.id === "string" ? s.id : genId("sched"),
    name: typeof s.name === "string" ? s.name : "Rule",
    enabled: typeof s.enabled === "boolean" ? s.enabled : true,
    type: type as DeviceType,
    scope,
    days: coerceDays(s.days),
    windows: coerceWindows(s.windows),
    action: coerceAction(s.action),
    condition: coerceCondition(s.condition),
  };
}

function migrateSchedules(raw: unknown): Schedule[] {
  if (!Array.isArray(raw)) return [];
  const out: Schedule[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const s = item as Record<string, unknown>;
    if (isLegacySchedule(s)) out.push(...migrateLegacySchedule(s));
    else {
      const c = coerceSchedule(s);
      if (c) out.push(c);
    }
  }
  return out;
}

/** Default ids of the same logical rule as `b`: the canonical id for the surplus rule,
 *  PLUS any persisted instance sharing its `type` (so a relabeled/retargeted older id is
 *  recognized as the same rule and de-duped rather than left as a stale duplicate). */
function sameRuleAsDefault(a: Automation, b: Automation): boolean {
  return a.id === b.id || a.type === b.type;
}

/** The old (pre-split) unified canonical id. A persisted rule under this id is the former
 *  bidirectional "solar climate" automation and is migrated into the two split rules. */
const LEGACY_UNIFIED_AUTOMATION_ID = "solar-surplus-precool";

/**
 * MIGRATION (split): convert a legacy persisted UNIFIED solar-surplus rule — the old
 * single `solar_surplus_precool` that drove BOTH directions — into the two new
 * single-direction rules (cooling `solar-surplus-cool` + heating `solar-surplus-heat`),
 * preserving the original `enabled` state and all four targets. A rule is treated as the
 * legacy unified one iff it is a `solar_surplus_precool` carrying the old unified id
 * (`solar-surplus-precool`); already-split installs (whose precool is `solar-surplus-cool`
 * and/or already have a `solar_surplus_preheat`) are left untouched. Returns the input
 * unchanged when there's nothing to migrate.
 */
function migrateSplitSurplus(persisted: Automation[]): Automation[] {
  const hasPreheat = persisted.some((a) => a.type === "solar_surplus_preheat");
  const out: Automation[] = [];
  for (const a of persisted) {
    const isLegacyUnified =
      a.type === "solar_surplus_precool" &&
      a.id === LEGACY_UNIFIED_AUTOMATION_ID &&
      !hasPreheat;
    if (!isLegacyUnified) {
      out.push(a);
      continue;
    }
    // Split: re-key the cooling half to the new canonical cool id, and add a heating half
    // (same params + enabled state) so the prior bidirectional behaviour is preserved.
    out.push({
      ...a,
      id: SOLAR_SURPLUS_COOL_AUTOMATION_ID,
      name: "Solar-surplus cooling",
      type: "solar_surplus_precool",
    });
    out.push({
      ...a,
      id: SOLAR_SURPLUS_HEAT_AUTOMATION_ID,
      name: "Solar-surplus heating",
      type: "solar_surplus_preheat",
      params: { ...a.params },
      lastEval: null,
    });
  }
  return out;
}

/**
 * Reconcile persisted automations with the seeded defaults:
 *  1. DE-DUPE migration — collapse multiple instances of the same `type` (e.g. two
 *     `solar_surplus_precool` left over from a relabel/retarget) into ONE: keep the
 *     user-ENABLED instance if any, else the canonical-id instance, else the first.
 *     This cleans a live state.json that already holds a duplicate.
 *  2. RE-SEED only the missing, NON-dismissed defaults — a default the owner DELETED
 *     (its id recorded in `dismissedDefaultAutomationIds`) is NOT re-added, so deleting
 *     a default keeps it gone across restarts. Newly shipped defaults still appear on
 *     existing installs (seeded disabled, so a re-appearing card never acts on its own).
 */
function mergeAutomations(
  raw: unknown,
  base: Automation[],
  dismissed: string[],
): Automation[] {
  // 0. SPLIT migration — convert a legacy unified precool into the two split rules first,
  //    so de-dupe/re-seed below see the post-split shape.
  const persisted = migrateSplitSurplus(
    Array.isArray(raw) ? (raw as Automation[]) : [],
  );
  const dismissedSet = new Set(dismissed);
  // A dismissed LEGACY unified id suppresses BOTH split defaults — dismissing the old
  // single card keeps the split pair gone too (don't resurrect it as two new cards).
  if (dismissedSet.has(LEGACY_UNIFIED_AUTOMATION_ID)) {
    dismissedSet.add(SOLAR_SURPLUS_COOL_AUTOMATION_ID);
    dismissedSet.add(SOLAR_SURPLUS_HEAT_AUTOMATION_ID);
  }

  // 1. De-dupe persisted instances by type. Within each type-group, prefer an enabled
  //    instance, then the canonical-default id, then the first seen.
  const byType = new Map<string, Automation[]>();
  for (const a of persisted) {
    const group = byType.get(a.type) ?? [];
    group.push(a);
    byType.set(a.type, group);
  }
  const deduped: Automation[] = [];
  for (const group of byType.values()) {
    if (group.length === 1) {
      deduped.push(group[0]);
      continue;
    }
    const defaultIds = new Set(base.map((b) => b.id));
    const winner =
      group.find((a) => a.enabled) ??
      group.find((a) => defaultIds.has(a.id)) ??
      group[0];
    deduped.push(winner);
  }

  // 2. Re-seed defaults that are neither present (by canonical id or type) nor dismissed.
  const toSeed = base.filter(
    (b) =>
      !dismissedSet.has(b.id) && !deduped.some((a) => sameRuleAsDefault(a, b)),
  );
  return [...deduped, ...toSeed].map(tuneSurplusDefaults);
}

/**
 * ONE-TIME tune of the persisted surplus rules to the new anti-chatter baseline. Keyed off
 * the ABSENCE of `minRunSec` (the field shipped with this change) so it runs exactly once per
 * rule and then never touches the owner's later edits:
 *   • BOTH rules: start only above >3 kW export, and add the 15-min min-run + fan-speed-2.
 *   • COOLING (solar_surplus_precool): additionally set to cool@24°C. Heating keeps its own
 *     heat target (it drives up to heatTargetSetpointC, not the cooling setpoint).
 * A freshly-seeded rule already carries `minRunSec`, so this is a no-op for new installs.
 */
function tuneSurplusDefaults(a: Automation): Automation {
  if (a.type !== "solar_surplus_precool" && a.type !== "solar_surplus_preheat") return a;
  const p = a.params as SolarSurplusPrecoolParams;
  if (p.minRunSec != null) return a; // already tuned — respect any later owner edits
  const base: Partial<SolarSurplusPrecoolParams> = {
    minRunSec: 900,
    fanLevel: 2,
    startThresholdW: 3000,
  };
  if (a.type === "solar_surplus_precool") base.targetSetpointC = 24;
  return { ...a, params: { ...p, ...base } };
}

/** Keep persisted rule enable-states but append any newly-shipped default rules
 *  (e.g. `rule-voltage`) that aren't in the persisted list yet, so existing installs
 *  pick up new rules with their default enable-state. */
function mergeRules(raw: unknown, base: RuleState[]): RuleState[] {
  if (!Array.isArray(raw) || raw.length === 0)
    return base.map((r) => ({ ...r }));
  const persisted = raw.filter(
    (r): r is RuleState =>
      !!r && typeof r === "object" && typeof (r as RuleState).id === "string",
  );
  const have = new Set(persisted.map((r) => r.id));
  const missing = base.filter((r) => !have.has(r.id)).map((r) => ({ ...r }));
  return [...persisted, ...missing];
}

/** Coerce persisted voltage-monitor config, clamping the band to a sane range and
 *  guaranteeing minV < maxV (falls back to defaults when invalid). */
function hydrateVoltageMonitor(
  p: Partial<VoltageMonitor> | undefined,
  base: VoltageMonitor,
): VoltageMonitor {
  if (!p || typeof p !== "object") return { ...base };
  const minV =
    typeof p.minV === "number" && Number.isFinite(p.minV) ? p.minV : base.minV;
  const maxV =
    typeof p.maxV === "number" && Number.isFinite(p.maxV) ? p.maxV : base.maxV;
  const valid = minV >= 0 && maxV > minV;
  return {
    enabled: typeof p.enabled === "boolean" ? p.enabled : base.enabled,
    minV: valid ? minV : base.minV,
    maxV: valid ? maxV : base.maxV,
    ...(typeof p.breakerId === "string" && p.breakerId
      ? { breakerId: p.breakerId }
      : {}),
  };
}

/** Merge persisted JSON onto defaults so new fields appear with sane values. */
function hydrate(raw: unknown): StoreSchema {
  const base = defaults();
  if (!raw || typeof raw !== "object") return base;
  const p = raw as Partial<StoreSchema>;
  return {
    channels: {
      whatsapp: { ...base.channels.whatsapp, ...(p.channels?.whatsapp ?? {}) },
      push: { ...base.channels.push, ...(p.channels?.push ?? {}) },
      email: { ...base.channels.email, ...(p.channels?.email ?? {}) },
    },
    rules: mergeRules(p.rules, base.rules),
    voltageMonitor: hydrateVoltageMonitor(
      p.voltageMonitor,
      base.voltageMonitor,
    ),
    alertOverrides: p.alertOverrides ?? base.alertOverrides,
    activeScenario: p.activeScenario ?? base.activeScenario,
    scenarios:
      p.scenarios && Object.keys(p.scenarios).length
        ? p.scenarios
        : base.scenarios,
    pushSubscriptions: Array.isArray(p.pushSubscriptions)
      ? p.pushSubscriptions
      : base.pushSubscriptions,
    vapid: p.vapid ?? base.vapid,
    teslaRefreshToken: p.teslaRefreshToken ?? base.teslaRefreshToken,
    seenAlerts: p.seenAlerts ?? base.seenAlerts,
    auth: hydrateAuth(p.auth, base.auth),
    control: hydrateControl(p.control, base.control),
    integrations: {
      intesis:
        p.integrations?.intesis &&
        typeof p.integrations.intesis.username === "string" &&
        typeof p.integrations.intesis.password === "string"
          ? p.integrations.intesis
          : base.integrations.intesis,
      // Carry over Settings-configured overrides so they survive a restart.
      ...(p.integrations?.sonnen ? { sonnen: p.integrations.sonnen } : {}),
      ...(p.integrations?.tesla ? { tesla: p.integrations.tesla } : {}),
      ...(p.integrations?.weather ? { weather: p.integrations.weather } : {}),
      ...(p.integrations?.airzone ? { airzone: p.integrations.airzone } : {}),
      // Carry over the Rain Bird config (host + password) so a connected controller
      // survives a restart/deploy (Phase 1 omitted this, so the config was lost on reboot).
      ...(p.integrations?.rainbird
        ? { rainbird: p.integrations.rainbird }
        : {}),
      ...(p.integrations?.tuya ? { tuya: p.integrations.tuya } : {}),
      ...(p.integrations?.panasonic
        ? { panasonic: p.integrations.panasonic }
        : {}),
      ...(p.integrations?.sonos ? { sonos: p.integrations.sonos } : {}),
    },
    deviceSettings: hydrateDeviceSettings(
      p.deviceSettings,
      base.deviceSettings,
    ),
    schedules: migrateSchedules(p.schedules),
    dismissedDefaultAutomationIds: Array.isArray(
      p.dismissedDefaultAutomationIds,
    )
      ? [
          ...new Set(
            p.dismissedDefaultAutomationIds.filter(
              (id): id is string => typeof id === "string",
            ),
          ),
        ]
      : base.dismissedDefaultAutomationIds,
    automations: mergeAutomations(
      p.automations,
      base.automations,
      Array.isArray(p.dismissedDefaultAutomationIds)
        ? p.dismissedDefaultAutomationIds.filter(
            (id): id is string => typeof id === "string",
          )
        : [],
    ),
    devices: hydrateDevices(p.devices, base.devices),
    lightScenes: Array.isArray(p.lightScenes)
      ? p.lightScenes
      : base.lightScenes,
    lightSchedules: Array.isArray(p.lightSchedules)
      ? p.lightSchedules
      : base.lightSchedules,
    // Back-compat: an on-disk state.json predating whole-home scenes lacks the key —
    // fall back to the seeded starter set (an existing array, even empty, is preserved).
    homeScenes: Array.isArray(p.homeScenes) ? p.homeScenes : base.homeScenes,
    sceneControllers: hydrateSceneControllers(p.sceneControllers),
    deviceOnboarding: hydrateDeviceOnboarding(
      p.deviceOnboarding,
      base.deviceOnboarding,
    ),
    alarmActive: hydrateAlarmActive(p.alarmActive),
    alarmConfig: hydrateAlarmConfig(p.alarmConfig, base.alarmConfig),
    rooms: hydrateRooms(p.rooms),
    roomsSeeded: typeof p.roomsSeeded === "boolean" ? p.roomsSeeded : false,
    radioFavorites: hydrateRadioFavorites(p.radioFavorites),
    radioSchedules: hydrateRadioSchedules(p.radioSchedules),
    radioNowPlaying: hydrateRadioNowPlaying(p.radioNowPlaying),
    irrigation: hydrateIrrigation(p.irrigation),
  };
}

/** Coerce + migrate persisted irrigation state onto fresh defaults. Defensive: an on-disk
 *  state.json predating Phase 2 lacks the key → returns clean defaults (mode 'off'). Every
 *  field is validated/clamped so a malformed persisted blob can never break the coordinator. */
function hydrateIrrigation(p: unknown): IrrigationState {
  const base = defaultIrrigation();
  if (!p || typeof p !== "object") return base;
  const r = p as Partial<IrrigationState>;
  const mode: IrrigationMode =
    r.mode === "shadow" || r.mode === "live" || r.mode === "off"
      ? r.mode
      : base.mode;
  const window: IrrigationWindow =
    r.window === "solar-surplus" ||
    r.window === "off-peak-P3" ||
    r.window === "none" ||
    r.window === "early-morning"
      ? r.window
      : base.window;

  const zones: Record<string, IrrigationZoneConfig> = {};
  if (r.zones && typeof r.zones === "object") {
    for (const [id, raw] of Object.entries(
      r.zones as Record<string, unknown>,
    )) {
      const z = hydrateIrrigationZone(id, raw);
      if (z) zones[id] = z;
    }
  }

  const deficits: Record<string, IrrigationDeficit> = {};
  if (r.deficits && typeof r.deficits === "object") {
    for (const [id, raw] of Object.entries(
      r.deficits as Record<string, unknown>,
    )) {
      const d = (raw ?? {}) as Partial<IrrigationDeficit>;
      if (typeof d.mm === "number" && Number.isFinite(d.mm)) {
        deficits[id] = {
          mm: Math.max(0, d.mm),
          updatedAt:
            typeof d.updatedAt === "string"
              ? d.updatedAt
              : new Date().toISOString(),
        };
      }
    }
  }

  const soilMoisture: Record<string, SoilMoistureReading> = {};
  if (r.soilMoisture && typeof r.soilMoisture === "object") {
    for (const [id, raw] of Object.entries(
      r.soilMoisture as Record<string, unknown>,
    )) {
      const s = (raw ?? {}) as Partial<SoilMoistureReading>;
      if (typeof s.pct === "number" && Number.isFinite(s.pct)) {
        soilMoisture[id] = {
          zoneId: id,
          pct: Math.max(0, Math.min(100, s.pct)),
          ts: typeof s.ts === "string" ? s.ts : new Date().toISOString(),
        };
      }
    }
  }

  let baselineMirror: IrrigationBaselineMirror | null = null;
  const bm = r.baselineMirror as
    | Partial<IrrigationBaselineMirror>
    | null
    | undefined;
  if (bm && typeof bm === "object" && typeof bm.ts === "string") {
    baselineMirror = {
      ts: bm.ts,
      rainDelayDays:
        typeof bm.rainDelayDays === "number" ? bm.rainDelayDays : 0,
      availableStationIds: Array.isArray(bm.availableStationIds)
        ? bm.availableStationIds.filter(
            (x): x is string => typeof x === "string",
          )
        : [],
    };
  }

  const log = Array.isArray(r.log)
    ? pruneLog(
        r.log.filter(
          (e): e is IrrigationLogEntry =>
            Boolean(e) && typeof (e as IrrigationLogEntry).ts === "number",
        ),
      )
    : [];

  return {
    mode,
    globalRainSkipMm: clampNum(
      r.globalRainSkipMm,
      base.globalRainSkipMm,
      0,
      100,
    ),
    rainSkipProbabilityPct: clampNum(
      r.rainSkipProbabilityPct,
      base.rainSkipProbabilityPct,
      0,
      100,
    ),
    window,
    zones,
    deficits,
    soilMoisture,
    baselineMirror,
    baselineDrift:
      typeof r.baselineDrift === "boolean" ? r.baselineDrift : false,
    log,
    lastError: typeof r.lastError === "string" ? r.lastError : null,
    lastTickAt: typeof r.lastTickAt === "string" ? r.lastTickAt : null,
    updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : Date.now(),
  };
}

/** A freshly-onboarded scene controller: 4 empty buttons (index 1..4), enabled. */
export function defaultSceneController(): SceneController {
  return {
    enabled: true,
    buttons: [1, 2, 3, 4].map((index) => ({ index })),
  };
}

/** Coerce a single button binding's optional press target from disk. An existing record
 *  without `kind` is treated as a whole-home scene (the only Phase-1 target). */
function hydratePress(raw: unknown): SceneButtonPress | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as { kind?: unknown; sceneId?: unknown; on?: unknown };
  if (typeof o.sceneId !== "string" || !o.sceneId) return undefined;
  const kind = o.kind === "light" ? "light" : "home";
  return { kind, sceneId: o.sceneId, on: o.on === true };
}

/** Coerce persisted scene-controller bindings onto clean defaults. Always normalizes to
 *  exactly 4 buttons (index 1..4); a missing/old blob → empty map. Defensive so a
 *  malformed entry can never break the coordinator. */
function hydrateSceneControllers(p: unknown): Record<string, SceneController> {
  const out: Record<string, SceneController> = {};
  if (!p || typeof p !== "object") return out;
  for (const [id, raw] of Object.entries(p as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Partial<SceneController>;
    const byIndex = new Map<number, SceneButtonBinding>();
    if (Array.isArray(r.buttons)) {
      for (const b of r.buttons) {
        const o = (b ?? {}) as Partial<SceneButtonBinding>;
        const idx = Number(o.index);
        if (!Number.isInteger(idx) || idx < 1 || idx > 4) continue;
        byIndex.set(idx, {
          index: idx,
          ...(typeof o.label === "string" && o.label.trim()
            ? { label: o.label.trim() }
            : {}),
          ...(hydratePress(o.single) ? { single: hydratePress(o.single) } : {}),
          ...(hydratePress(o.double) ? { double: hydratePress(o.double) } : {}),
          ...(hydratePress(o.long) ? { long: hydratePress(o.long) } : {}),
        });
      }
    }
    const buttons: SceneButtonBinding[] = [1, 2, 3, 4].map(
      (index) => byIndex.get(index) ?? { index },
    );
    out[id] = {
      enabled: r.enabled !== false,
      buttons,
      ...(typeof r.watermarkMs === "number" && Number.isFinite(r.watermarkMs)
        ? { watermarkMs: r.watermarkMs }
        : {}),
    };
  }
  return out;
}

function clampNum(
  v: unknown,
  fallback: number,
  lo: number,
  hi: number,
): number {
  return typeof v === "number" && Number.isFinite(v)
    ? Math.max(lo, Math.min(hi, v))
    : fallback;
}

const PLANT_TYPES: IrrigationPlantType[] = [
  "lawn",
  "shrubs",
  "flowers",
  "vegetables",
  "trees",
  "groundcover",
  "succulents",
  "hedge",
];
const EMITTER_TYPES: IrrigationEmitterType[] = [
  "spray",
  "rotor",
  "drip",
  "bubbler",
  "soaker",
];

/** Coerce one persisted zone config; null if structurally unusable. */
function hydrateIrrigationZone(
  zoneId: string,
  raw: unknown,
): IrrigationZoneConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const z = raw as Partial<IrrigationZoneConfig>;
  const plantType = PLANT_TYPES.includes(z.plantType as IrrigationPlantType)
    ? (z.plantType as IrrigationPlantType)
    : "shrubs";
  const emitterType = EMITTER_TYPES.includes(
    z.emitterType as IrrigationEmitterType,
  )
    ? (z.emitterType as IrrigationEmitterType)
    : "spray";
  const wateringTimes: IrrigationWateringTime[] = Array.isArray(z.wateringTimes)
    ? z.wateringTimes
        .map((w) => hydrateWateringTime(w))
        .filter((w): w is IrrigationWateringTime => w !== null)
    : [];
  return {
    zoneId,
    name:
      typeof z.name === "string" && z.name.trim()
        ? z.name
        : `Zone ${zoneId.replace("rb-", "")}`,
    plantType,
    emitterType,
    flowLpm:
      typeof z.flowLpm === "number" && z.flowLpm > 0 ? z.flowLpm : undefined,
    areaM2: typeof z.areaM2 === "number" && z.areaM2 > 0 ? z.areaM2 : undefined,
    sunExposure:
      typeof z.sunExposure === "number"
        ? Math.max(0, Math.min(1, z.sunExposure))
        : undefined,
    kc: typeof z.kc === "number" && z.kc > 0 ? z.kc : undefined,
    managedBy: z.managedBy === "controller" ? "controller" : "app",
    heatTopupEnabled: z.heatTopupEnabled === true,
    rainSkipMm:
      typeof z.rainSkipMm === "number" && z.rainSkipMm >= 0
        ? z.rainSkipMm
        : undefined,
    photoId: typeof z.photoId === "string" && z.photoId ? z.photoId : undefined,
    wateringTimes,
  };
}

function hydrateWateringTime(raw: unknown): IrrigationWateringTime | null {
  if (!raw || typeof raw !== "object") return null;
  const w = raw as Partial<IrrigationWateringTime>;
  if (typeof w.startTime !== "string" || !/^\d{1,2}:\d{2}$/.test(w.startTime))
    return null;
  const days =
    Array.isArray(w.days) && w.days.length === 7
      ? w.days.map((d) => d === true)
      : [false, true, true, true, true, true, false];
  return {
    id:
      typeof w.id === "string" && w.id
        ? w.id
        : `wt-${Math.random().toString(36).slice(2, 9)}`,
    startTime: w.startTime,
    durationMin:
      typeof w.durationMin === "number" && w.durationMin > 0
        ? Math.min(600, Math.round(w.durationMin))
        : 10,
    days,
  };
}

/** Rehydrate the rooms map, coercing each entry + dropping malformed ones. */
function hydrateRooms(p: unknown): Record<string, Room> {
  if (!p || typeof p !== "object") return {};
  const out: Record<string, Room> = {};
  let i = 0;
  for (const [id, raw] of Object.entries(p as Record<string, unknown>)) {
    const r = (raw ?? {}) as Partial<Room>;
    if (typeof r.name !== "string" || !r.name.trim()) continue;
    out[id] = {
      id,
      name: r.name.trim(),
      icon: typeof r.icon === "string" && r.icon ? r.icon : "home",
      order: typeof r.order === "number" ? r.order : i,
    };
    i++;
  }
  return out;
}

/** Coerce persisted radio favourites; drops malformed entries + clamps slots. */
function hydrateRadioFavorites(raw: unknown): RadioStation[] {
  if (!Array.isArray(raw)) return [];
  const out: RadioStation[] = [];
  for (const item of raw) {
    const r = (item ?? {}) as Partial<RadioStation>;
    if (
      typeof r.id !== "string" ||
      typeof r.streamUrl !== "string" ||
      !r.streamUrl
    )
      continue;
    const slot =
      typeof r.slot === "number"
        ? Math.max(0, Math.min(RADIO_FAVORITE_SLOTS - 1, Math.round(r.slot)))
        : 0;
    out.push({
      id: r.id,
      slot,
      name: typeof r.name === "string" && r.name ? r.name : "Station",
      streamUrl: r.streamUrl,
      ...(typeof r.logo === "string" && r.logo ? { logo: r.logo } : {}),
      ...(typeof r.codec === "string" && r.codec ? { codec: r.codec } : {}),
    });
  }
  return out;
}

/** Coerce persisted radio schedules; drops malformed entries. */
function hydrateRadioSchedules(raw: unknown): RadioSchedule[] {
  if (!Array.isArray(raw)) return [];
  const out: RadioSchedule[] = [];
  const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
  for (const item of raw) {
    const r = (item ?? {}) as Partial<RadioSchedule>;
    if (typeof r.id !== "string" || typeof r.stationId !== "string") continue;
    if (typeof r.onTime !== "string" || !HHMM.test(r.onTime)) continue;
    out.push({
      id: r.id,
      name: typeof r.name === "string" && r.name ? r.name : "Radio schedule",
      enabled: typeof r.enabled === "boolean" ? r.enabled : true,
      days: Array.isArray(r.days)
        ? r.days.filter((d) => typeof d === "number" && d >= 0 && d <= 6)
        : [1, 2, 3, 4, 5],
      onTime: r.onTime,
      offTime:
        typeof r.offTime === "string" && HHMM.test(r.offTime)
          ? r.offTime
          : null,
      stationId: r.stationId,
      speakerIds: Array.isArray(r.speakerIds)
        ? r.speakerIds.filter((x): x is string => typeof x === "string")
        : [],
      volumePct:
        typeof r.volumePct === "number"
          ? Math.max(0, Math.min(100, Math.round(r.volumePct)))
          : 25,
    });
  }
  return out;
}

/** Coerce the persisted radio now-playing session; null when absent/malformed. */
function hydrateRadioNowPlaying(raw: unknown): RadioNowPlaying | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<RadioNowPlaying>;
  if (typeof r.name !== "string") return null;
  return {
    name: r.name,
    stationId: typeof r.stationId === "string" ? r.stationId : null,
    speakerIds: Array.isArray(r.speakerIds)
      ? r.speakerIds.filter((x): x is string => typeof x === "string")
      : [],
    wholeHouse: typeof r.wholeHouse === "boolean" ? r.wholeHouse : false,
    coordinator: typeof r.coordinator === "string" ? r.coordinator : null,
    startedAt:
      typeof r.startedAt === "string" ? r.startedAt : new Date().toISOString(),
  };
}

/** Rehydrate the alarm config, clamping the blink floor and coercing types. */
function hydrateAlarmConfig(p: unknown, base: AlarmConfig): AlarmConfig {
  if (!p || typeof p !== "object") return base;
  const a = p as Partial<AlarmConfig>;
  const strArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const result: AlarmConfig = {
    enabled: typeof a.enabled === "boolean" ? a.enabled : base.enabled,
    speakerIds: strArr(a.speakerIds),
    volumePct:
      typeof a.volumePct === "number"
        ? Math.max(0, Math.min(100, Math.round(a.volumePct)))
        : base.volumePct,
    lightIds: strArr(a.lightIds),
    blinkMs:
      typeof a.blinkMs === "number"
        ? Math.max(ALARM_BLINK_FLOOR_MS, Math.round(a.blinkMs))
        : base.blinkMs,
    autoStopSec:
      typeof a.autoStopSec === "number" && a.autoStopSec >= 0
        ? Math.round(a.autoStopSec)
        : base.autoStopSec,
    volumeBumpedTo80:
      typeof a.volumeBumpedTo80 === "boolean" ? a.volumeBumpedTo80 : false,
  };
  // ONE-TIME migration: the default siren volume was raised 70 → 80. If this config
  // predates the change (flag absent) and is still sitting on the OLD default (70) —
  // i.e. the owner never deliberately changed it — bump it to 80 once. A deliberate
  // value (anything other than 70) is left untouched. Flag flips true so it runs once.
  if (!result.volumeBumpedTo80) {
    if (result.volumePct === 70) result.volumePct = 80;
    result.volumeBumpedTo80 = true;
  }
  return result;
}

/** Rehydrate a persisted alarm session, dropping anything malformed (→ idle). */
function hydrateAlarmActive(p: unknown): AlarmActive | null {
  if (!p || typeof p !== "object") return null;
  const a = p as Partial<AlarmActive>;
  if (typeof a.startedAt !== "string") return null;
  return {
    startedAt: a.startedAt,
    durationMs: typeof a.durationMs === "number" ? a.durationMs : null,
    lightIds: Array.isArray(a.lightIds)
      ? a.lightIds.filter((x): x is string => typeof x === "string")
      : [],
    siren: a.siren !== false,
  };
}

/** Rehydrate device-onboarding state, tolerant of the Phase-1 shape (`{ ignored }`
 *  only). Coerces the `configured` map and `customDeviceTypes` list, dropping junk. */
function hydrateDeviceOnboarding(
  p: Partial<DeviceOnboardingState> | undefined,
  base: DeviceOnboardingState,
): DeviceOnboardingState {
  if (!p || typeof p !== "object") return base;
  const ignored = Array.isArray(p.ignored)
    ? [
        ...new Set(
          p.ignored.filter((id): id is string => typeof id === "string"),
        ),
      ]
    : base.ignored;

  const configured: Record<string, ConfiguredDevice> = {};
  if (p.configured && typeof p.configured === "object") {
    for (const [id, raw] of Object.entries(p.configured)) {
      const c = raw as Partial<ConfiguredDevice> | undefined;
      if (!c || typeof c.typeId !== "string" || typeof c.name !== "string")
        continue;
      configured[id] = {
        typeId: c.typeId,
        name: c.name,
        setupAt:
          typeof c.setupAt === "string" ? c.setupAt : new Date().toISOString(),
        ...(Array.isArray(c.capOverrides)
          ? { capOverrides: c.capOverrides.filter(isCapOverride) }
          : {}),
      };
    }
  }

  const customDeviceTypes: CustomDeviceType[] = Array.isArray(
    p.customDeviceTypes,
  )
    ? p.customDeviceTypes
        .filter(
          (t): t is CustomDeviceType =>
            !!t &&
            typeof t === "object" &&
            typeof (t as CustomDeviceType).id === "string" &&
            typeof (t as CustomDeviceType).label === "string",
        )
        .map((t) => ({
          id: t.id,
          label: t.label,
          icon: typeof t.icon === "string" ? t.icon : "plug",
        }))
    : base.customDeviceTypes;

  return { ignored, configured, customDeviceTypes };
}

function isCapOverride(o: unknown): o is CapabilityOverride {
  return (
    !!o &&
    typeof o === "object" &&
    typeof (o as CapabilityOverride).dp === "string"
  );
}

/**
 * Force a DISARMED boot regardless of persisted state. OFF by default, so a
 * restart/deploy now PRESERVES the last armed state (set via the arm endpoints) —
 * an ordinary release no longer silently disarms control. Set ENERGY_BOOT_DISARMED=1
 * for a deliberately-safe boot when a release changes control logic; confirm that
 * with the owner before shipping it (see CLAUDE.md §5).
 */
const FORCE_DISARM_ON_BOOT = process.env.ENERGY_BOOT_DISARMED === "1";
const isControlMode = (m: unknown): m is ControlMode =>
  m === "off" || m === "manual" || m === "auto";

/**
 * Coerce + migrate persisted per-device settings. MIGRATION: the single legacy
 * `automationEnabled` flag is split into two independent direction flags —
 * `solarCoolEnabled` and `solarHeatEnabled`. A legacy `automationEnabled === true`
 * enables BOTH (preserving the prior bidirectional surplus behavior); false/absent ⇒
 * both off. Explicit new-shape flags, when present, win over the legacy one. The legacy
 * field is retained on the record (back-compat reads) but is no longer authoritative.
 */
function hydrateDeviceSettings(
  p: Record<string, DeviceSettings> | undefined,
  base: Record<string, DeviceSettings>,
): Record<string, DeviceSettings> {
  if (!p || typeof p !== "object") return base;
  const out: Record<string, DeviceSettings> = {};
  for (const [id, raw] of Object.entries(p)) {
    if (!raw || typeof raw !== "object") continue;
    const legacyOn = raw.automationEnabled === true;
    out[id] = {
      ...raw,
      solarCoolEnabled:
        typeof raw.solarCoolEnabled === "boolean"
          ? raw.solarCoolEnabled
          : legacyOn,
      solarHeatEnabled:
        typeof raw.solarHeatEnabled === "boolean"
          ? raw.solarHeatEnabled
          : legacyOn,
    };
  }
  return out;
}

/**
 * Rehydrate the devices/climate section. Restores the persisted armed state + mode
 * across restarts; a graceful shutdown switches off rule-started units but does NOT
 * persist a disarm, so a deploy resumes where it left off. FORCE_DISARM_ON_BOOT
 * overrides to a safe DISARMED/'off' boot. Guardrails + log are preserved.
 */
function hydrateDevices(
  p: Partial<DevicesState> | undefined,
  base: DevicesState,
): DevicesState {
  if (!p || typeof p !== "object") return base;
  return {
    armed: FORCE_DISARM_ON_BOOT
      ? false
      : typeof p.armed === "boolean"
        ? p.armed
        : base.armed,
    mode: FORCE_DISARM_ON_BOOT
      ? "off"
      : isControlMode(p.mode)
        ? p.mode
        : base.mode,
    updatedAt: typeof p.updatedAt === "number" ? p.updatedAt : base.updatedAt,
    lastError: typeof p.lastError === "string" ? p.lastError : null,
    log: Array.isArray(p.log) ? pruneLog(p.log) : base.log,
    guardrails: {
      ...base.guardrails,
      ...(p.guardrails ?? {}),
    },
    manualOverrides:
      p.manualOverrides && typeof p.manualOverrides === "object"
        ? p.manualOverrides
        : {},
    // Rule provenance persists across restarts: a unit the surplus rule started stays
    // rule-owned (auto-managed) on boot, while everything else powered-on is treated as
    // manual. (Legacy installs that persisted a `manualOn` map carry nothing forward —
    // ownership is now derived purely from this provenance set.)
    surplusStartedIds: Array.isArray(p.surplusStartedIds)
      ? [
          ...new Set(
            p.surplusStartedIds.filter(
              (id): id is string => typeof id === "string",
            ),
          ),
        ]
      : [],
    // EV-surplus tunables: merge persisted over defaults so a new field gains its default
    // and a deploy preserves any owner-tuned values.
    evSurplus: { ...base.evSurplus, ...(p.evSurplus ?? {}) },
    evState:
      p.evState && typeof p.evState === 'object' ? hydrateEvState(p.evState) : {},
  };
}

/** Coerce persisted EV per-breaker runtime state; drops malformed entries. */
function hydrateEvState(p: Record<string, unknown>): Record<string, EvBreakerState> {
  const out: Record<string, EvBreakerState> = {};
  for (const [id, raw] of Object.entries(p)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Partial<EvBreakerState>;
    out[id] = {
      ruleOn: r.ruleOn === true,
      lastSwitchTs: typeof r.lastSwitchTs === 'number' ? r.lastSwitchTs : 0,
      surplusClearedSince: typeof r.surplusClearedSince === 'number' ? r.surplusClearedSince : 0,
      reason:
        r.reason === 'surplus' || r.reason === 'p3' || r.reason === 'waiting' ? r.reason : 'off',
      reservedW: typeof r.reservedW === 'number' ? r.reservedW : 0,
    };
  }
  return out;
}

/**
 * Rehydrate the control section. Restores the persisted armed state + mode across
 * restarts so a deploy doesn't silently disarm the battery coordinator; an explicit
 * disarm persists armed=false and stays that way. FORCE_DISARM_ON_BOOT overrides to
 * a safe DISARMED/'off' boot. Guardrails + log are preserved.
 */
function hydrateControl(
  p: Partial<ControlState> | undefined,
  base: ControlState,
): ControlState {
  if (!p || typeof p !== "object") return base;
  const result: ControlState = {
    armed: FORCE_DISARM_ON_BOOT
      ? false
      : typeof p.armed === "boolean"
        ? p.armed
        : base.armed,
    mode: FORCE_DISARM_ON_BOOT
      ? "off"
      : isControlMode(p.mode)
        ? p.mode
        : base.mode,
    updatedAt: typeof p.updatedAt === "number" ? p.updatedAt : base.updatedAt,
    lastError: typeof p.lastError === "string" ? p.lastError : null,
    log: Array.isArray(p.log) ? pruneLog(p.log) : base.log,
    guardrails: { ...base.guardrails, ...(p.guardrails ?? {}) },
    batteryPriority: hydrateBatteryPriority(
      p.batteryPriority,
      base.batteryPriority,
    ),
    soakExport: hydrateSoakExport(p.soakExport, base.soakExport),
    arbitrageLog: Array.isArray(p.arbitrageLog)
      ? p.arbitrageLog.slice(-ARBITRAGE_LOG_RING_MAX)
      : base.arbitrageLog,
    arbitrageStats: hydrateArbitrageStats(
      p.arbitrageStats,
      base.arbitrageStats,
    ),
    dischargeV2Shadowed:
      typeof p.dischargeV2Shadowed === "boolean"
        ? p.dischargeV2Shadowed
        : false,
  };
  // ONE-TIME migration: the Sonnen-first discharge actuation changed materially
  // (load-following force-discharge + Tesla backup hold, replacing the reserve-raise).
  // Force the rule back to SHADOW once so the new actuation re-validates before going
  // live, even if the persisted authority was 'auto'. Runs exactly once (flag flips true).
  if (!result.dischargeV2Shadowed) {
    result.batteryPriority.dischargeSonnenFirst.authority = "shadow";
    result.dischargeV2Shadowed = true;
  }
  return result;
}

function hydrateArbitrageStats(
  p: Partial<ArbitrageStats> | undefined,
  base: ArbitrageStats,
): ArbitrageStats {
  if (!p || typeof p !== "object") return base;
  const num = (v: unknown, fb: number) =>
    typeof v === "number" && Number.isFinite(v) ? v : fb;
  return {
    sinceTs: num(p.sinceTs, base.sinceTs),
    lastEventTs:
      typeof p.lastEventTs === "number" ? p.lastEventTs : base.lastEventTs,
    engagementsActive: num(p.engagementsActive, base.engagementsActive),
    engagementsAdvisory: num(p.engagementsAdvisory, base.engagementsAdvisory),
    valleyKwhActive: num(p.valleyKwhActive, base.valleyKwhActive),
    valleyKwhAdvisory: num(p.valleyKwhAdvisory, base.valleyKwhAdvisory),
    estSavedEurActive: num(p.estSavedEurActive, base.estSavedEurActive),
    estSavedEurAdvisory: num(p.estSavedEurAdvisory, base.estSavedEurAdvisory),
  };
}

function hydrateSoakExport(
  p: Partial<SoakExportRule> | undefined,
  base: SoakExportRule,
): SoakExportRule {
  if (!p || typeof p !== "object") return base;
  return {
    enabled: typeof p.enabled === "boolean" ? p.enabled : base.enabled,
    startW: typeof p.startW === "number" ? p.startW : base.startW,
    stopW: typeof p.stopW === "number" ? p.stopW : base.stopW,
    socCeilingPct:
      typeof p.socCeilingPct === "number"
        ? p.socCeilingPct
        : base.socCeilingPct,
  };
}

function hydrateRule(
  p: Partial<BatteryPriorityRule> | undefined,
  base: BatteryPriorityRule,
): BatteryPriorityRule {
  if (!p || typeof p !== "object") return base;
  return {
    enabled: typeof p.enabled === "boolean" ? p.enabled : base.enabled,
    authority:
      p.authority === "auto" || p.authority === "shadow"
        ? p.authority
        : base.authority,
    throughputKw:
      typeof p.throughputKw === "number" ? p.throughputKw : base.throughputKw,
  };
}

function hydrateBatteryPriority(
  p: Partial<BatteryPriority> | undefined,
  base: BatteryPriority,
): BatteryPriority {
  if (!p || typeof p !== "object") return base;
  return {
    dischargeSonnenFirst: hydrateRule(
      p.dischargeSonnenFirst,
      base.dischargeSonnenFirst,
    ),
    chargeTeslaFirst: hydrateRule(p.chargeTeslaFirst, base.chargeTeslaFirst),
  };
}

function hydrateAuth(
  p: Partial<AuthState> | undefined,
  base: AuthState,
): AuthState {
  if (!p || typeof p !== "object") return base;
  return {
    users: Array.isArray(p.users) ? p.users : base.users,
    sessions: Array.isArray(p.sessions) ? p.sessions : base.sessions,
    trustedDevices: Array.isArray(p.trustedDevices)
      ? p.trustedDevices
      : base.trustedDevices,
    otps: Array.isArray(p.otps) ? p.otps : base.otps,
    resetTokens: Array.isArray(p.resetTokens)
      ? p.resetTokens
      : base.resetTokens,
    setupTokens: Array.isArray(p.setupTokens)
      ? p.setupTokens
      : base.setupTokens,
    loginAttempts:
      p.loginAttempts && typeof p.loginAttempts === "object"
        ? p.loginAttempts
        : base.loginAttempts,
  };
}

function load(): StoreSchema {
  if (cache) return cache;
  const f = file();
  try {
    if (existsSync(f)) {
      cache = hydrate(JSON.parse(readFileSync(f, "utf8")));
    } else {
      cache = defaults();
      persist(cache);
    }
  } catch (e) {
    console.error("[store] load failed, using defaults:", (e as Error).message);
    cache = defaults();
  }
  return cache;
}

function persist(state: StoreSchema): void {
  const f = file();
  try {
    const dir = dirname(f);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    renameSync(tmp, f); // atomic on the same filesystem
  } catch (e) {
    console.error("[store] persist failed:", (e as Error).message);
  }
}

/** Read the current state (in-memory cache, lazily loaded). */
export function get(): StoreSchema {
  return load();
}

/**
 * Mutate the state in place and persist atomically. The mutator may return a
 * value, which is forwarded to the caller (handy for "return the new thing").
 */
export function update<T = void>(mutator: (state: StoreSchema) => T): T {
  const state = load();
  const result = mutator(state);
  persist(state);
  return result;
}

/** Test/diagnostic helper — drop the cache so the next get() re-reads disk. */
export function _resetCache(): void {
  cache = null;
}
