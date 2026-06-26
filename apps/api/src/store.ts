// JSON file state store with atomic writes (write tmp + rename) and an
// in-memory cache. The brain/back-end persists settings, alert state, scenario
// definitions, push subscriptions, VAPID keys and a (possibly rotated) Tesla
// refresh token here. No databases — a single JSON document is plenty for one site.
//
// Path resolution:
//   STATE_FILE env override, else
//   production → /opt/energy/state.json (writable by the jdkroese01 service user)
//   dev        → <repoRoot>/.data/state.json

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Band } from './tariff';

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

export type AlertStatus = 'new' | 'ack' | 'resolved';
export interface AlertOverride {
  status: AlertStatus;
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
  exportRule: 'never' | 'surplus' | 'always';
  /** EV charging policy hint. */
  ev: 'solar-only' | 'cheap-grid' | 'asap';
  /** Thermal pre-conditioning before P1 peaks. */
  precondition: boolean;
  /** How the scenario is activated. */
  activation: 'manual' | 'auto';
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

export type UserRole = 'admin' | 'user';
export type TwoFactorChannel = 'whatsapp' | 'email';
export type OtpPurpose = 'login' | 'reset';

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

export type ControlMode = 'off' | 'manual' | 'auto';
export type ControlDevice = 'sonnen' | 'tesla';

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

export type BatteryPriorityAuthority = 'shadow' | 'auto';

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
  /** Tuya Cloud project (datacenter region + Access ID/Secret). Unlocks the
   *  whole linked device fleet — lights first, more categories to come. */
  tuya?: { region?: string; accessId?: string; accessSecret?: string };
}

/** Per-device user-facing settings, merged onto the connector's normalized view. */
export interface DeviceSettings {
  /** Friendly room override (falls back to the device's reported zone/name). */
  room?: string;
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
}

export type ClimateMode = 'auto' | 'heat' | 'dry' | 'fan' | 'cool';

/** Device categories a rule can target. Extensible (lighting/circuit land later). */
export type DeviceType = 'cooling' | 'heating' | 'lighting' | 'circuit' | 'blinds';

/** Fan / vane settings: 'auto' (A) or a discrete 1..5 position. */
export type FanSetting = 'auto' | 1 | 2 | 3 | 4 | 5;
export type VaneSetting = 'auto' | 1 | 2 | 3 | 4 | 5;

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
}

export interface ScheduleWindow {
  /** Local "HH:MM". `end <= start` ⇒ the window wraps past midnight. */
  start: string;
  end: string;
  /** Optional per-window override; inherits the rule's `action`. */
  action?: Partial<Action>;
}

export type RunCondition =
  | { kind: 'always' }
  | { kind: 'warmerThan'; thresholdC: number } // run only if room temp > threshold (cooling)
  | { kind: 'coolerThan'; thresholdC: number }; // run only if room temp < threshold (heating)

/** A rule targets ONE unit (or a single named group), never an array of devices. */
export type ScheduleScope =
  | { kind: 'unit'; deviceId: string }
  | { kind: 'group'; groupId: string };

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
export type AutomationType = 'solar_surplus_precool' | 'solar_surplus_preheat' | 'tariff_arbitrage';

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
}

/** Discriminated automation params: the surplus rules carry the climate shape; the
 *  tariff-arbitrage rule carries the battery shape. The coordinator narrows on `type`. */
export type AutomationParams = SolarSurplusPrecoolParams | TariffArbitrageParams;

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
  return a.type === 'tariff_arbitrage';
}

/**
 * STABLE canonical ids for the two seeded solar-surplus defaults — one per direction.
 * Pinned so future relabels/retargets never drift the id; the dismissal + de-dupe logic
 * keys off these. Older installs may carry a different persisted id for the same rule;
 * the de-dupe collapses by `type` so a relabeled instance is treated as the same rule.
 */
export const SOLAR_SURPLUS_COOL_AUTOMATION_ID = 'solar-surplus-cool';
export const SOLAR_SURPLUS_HEAT_AUTOMATION_ID = 'solar-surplus-heat';
/** @deprecated kept for back-compat with any importers of the pre-split single id. */
export const SOLAR_SURPLUS_AUTOMATION_ID = SOLAR_SURPLUS_COOL_AUTOMATION_ID;

/** STABLE canonical id for the seeded tariff-arbitrage default (task #15). Pinned so a
 *  relabel never drifts the id; the dismissal + de-dupe logic keys off it (and its type). */
export const TARIFF_ARBITRAGE_AUTOMATION_ID = 'tariff-arbitrage';

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
    valleyBand: 'P3',
    peakBand: 'P1',
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
  members: LightSceneMember[];
}

export type LightScheduleTarget =
  | { kind: 'scene'; sceneId: string }
  | { kind: 'lights'; members: LightSceneMember[] };

export interface LightSchedule {
  id: string;
  name: string;
  enabled: boolean;
  /** Days of week the schedule runs on (0=Sun..6=Sat). */
  days: number[];
  /** Local "HH:MM" — apply the target (turn on / apply scene). */
  onTime: string;
  /** Optional local "HH:MM" — switch the target's lights off. null = no auto-off. */
  offTime?: string | null;
  target: LightScheduleTarget;
}

export interface StoreSchema {
  channels: Channels;
  rules: RuleState[];
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
}

// ---- Defaults -----------------------------------------------------------

export const DEFAULT_RULES: RuleState[] = [
  { id: 'rule-grid-charge', enabled: true },
  { id: 'rule-reserve', enabled: true },
  { id: 'rule-offline', enabled: true },
  { id: 'rule-outage', enabled: true },
  { id: 'rule-export', enabled: false },
];

export const DEFAULT_SCENARIOS: Record<string, ScenarioDef> = {
  balanced: {
    name: 'Balanced',
    icon: 'scale',
    weights: { save: 0.4, self: 0.3, indep: 0.2, comfort: 0.1 },
    reserve: 20,
    dynReserve: false,
    gridCharge: false,
    exportRule: 'surplus',
    ev: 'solar-only',
    precondition: true,
    activation: 'manual',
    trigger: '',
  },
  'max-savings': {
    name: 'Max savings',
    icon: 'piggy-bank',
    weights: { save: 0.7, self: 0.2, indep: 0.05, comfort: 0.05 },
    reserve: 10,
    dynReserve: false,
    gridCharge: true,
    exportRule: 'surplus',
    ev: 'cheap-grid',
    precondition: true,
    activation: 'manual',
    trigger: '',
  },
  'self-sufficient': {
    name: 'Self-sufficient',
    icon: 'leaf',
    weights: { save: 0.2, self: 0.5, indep: 0.25, comfort: 0.05 },
    reserve: 20,
    dynReserve: true,
    gridCharge: false,
    exportRule: 'never',
    ev: 'solar-only',
    precondition: true,
    activation: 'manual',
    trigger: '',
  },
  'storm-ready': {
    name: 'Storm-ready',
    icon: 'shield',
    weights: { save: 0.15, self: 0.25, indep: 0.5, comfort: 0.1 },
    reserve: 50,
    dynReserve: true,
    gridCharge: true,
    exportRule: 'never',
    ev: 'asap',
    precondition: false,
    activation: 'auto',
    trigger: 'Storm watch or red weather warning for the area',
  },
};

/** DISARMED, mode 'off' — the safe default. Nothing is written until armed. */
export function defaultControl(): ControlState {
  return {
    armed: false,
    mode: 'off',
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
  };
}

/** Sonnen-first / Tesla-first defaults — ENABLED but SHADOW, so they log
 *  intended actions and write nothing until promoted to 'auto' in the UI. */
export function defaultBatteryPriority(): BatteryPriority {
  return {
    dischargeSonnenFirst: { enabled: true, authority: 'shadow', throughputKw: 3.0 },
    chargeTeslaFirst: { enabled: true, authority: 'shadow', throughputKw: 3.0 },
  };
}

/** Surplus-soak defaults — the values that were hardcoded in the coordinator.
 *  ENABLED so a deploy preserves today's live behaviour. */
export function defaultSoakExport(): SoakExportRule {
  return { enabled: true, startW: 400, stopW: 150, socCeilingPct: 98 };
}

/** DISARMED, mode 'off' — the safe default for the devices/climate layer. */
export function defaultDevices(): DevicesState {
  return {
    armed: false,
    mode: 'off',
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
      name: 'Solar-surplus cooling',
      enabled: false,
      type: 'solar_surplus_precool',
      params: {
        roomTempLimitC: 25,
        targetSetpointC: 23,
        heatRoomFloorC: 19,
        heatTargetSetpointC: 21,
        surplusClearSec: 120,
        bandRestrictionEnabled: true,
        exitBand: 'P1',
        startThresholdW: 800,
      },
      lastEval: null,
    },
    {
      id: SOLAR_SURPLUS_HEAT_AUTOMATION_ID,
      name: 'Solar-surplus heating',
      enabled: false,
      type: 'solar_surplus_preheat',
      params: {
        roomTempLimitC: 25,
        targetSetpointC: 23,
        heatRoomFloorC: 19,
        heatTargetSetpointC: 21,
        surplusClearSec: 120,
        bandRestrictionEnabled: true,
        exitBand: 'P1',
        startThresholdW: 800,
      },
      lastEval: null,
    },
    {
      // Tariff arbitrage (task #15) — battery rule. SEEDED DISABLED: shipping it must NOT
      // change battery behavior. It only ever acts when enabled && armed && mode==='auto'.
      id: TARIFF_ARBITRAGE_AUTOMATION_ID,
      name: 'Tariff arbitrage',
      enabled: false,
      type: 'tariff_arbitrage',
      params: defaultTariffArbitrageParams(),
      lastEval: null,
    },
  ];
}

function defaults(): StoreSchema {
  return {
    channels: {
      whatsapp: { number: '+34 612 345 197', enabled: true },
      push: { enabled: true },
      email: { address: 'j.kroese@levante.nl', enabled: false },
    },
    rules: DEFAULT_RULES.map((r) => ({ ...r })),
    alertOverrides: {},
    activeScenario: 'balanced',
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
  if (process.env.NODE_ENV === 'production') return '/opt/energy/state.json';
  // repoRoot = three levels up from apps/api/src in the CJS prod bundle. Under
  // tsx/ESM dev __dirname is undefined, so derive it from cwd (apps/api).
  const repoRoot =
    typeof __dirname !== 'undefined'
      ? resolve(__dirname, '..', '..', '..')
      : resolve(process.cwd(), '..', '..');
  return resolve(repoRoot, '.data', 'state.json');
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
  return v === 1 || v === 2 || v === 3 || v === 4 || v === 5 ? v : 'auto';
}
function coerceVane(v: unknown): VaneSetting {
  return v === 1 || v === 2 || v === 3 || v === 4 || v === 5 ? v : 'auto';
}
function coerceMode(v: unknown): ClimateMode {
  return v === 'auto' || v === 'heat' || v === 'dry' || v === 'fan' || v === 'cool' ? v : 'cool';
}
function coerceAction(raw: unknown): Action {
  const a = (raw ?? {}) as Partial<Action>;
  return {
    power: typeof a.power === 'boolean' ? a.power : true,
    mode: coerceMode(a.mode),
    setpointC: typeof a.setpointC === 'number' ? a.setpointC : 24,
    fan: coerceFan(a.fan),
    vaneUpDown: coerceVane(a.vaneUpDown),
    vaneLeftRight: coerceVane(a.vaneLeftRight),
    ...(typeof a.positionPct === 'number'
      ? { positionPct: Math.min(100, Math.max(0, Math.round(a.positionPct))) }
      : {}),
  };
}
function coerceCondition(raw: unknown): RunCondition {
  const c = raw as { kind?: string; thresholdC?: number } | undefined;
  if (c?.kind === 'warmerThan' && typeof c.thresholdC === 'number') return { kind: 'warmerThan', thresholdC: c.thresholdC };
  if (c?.kind === 'coolerThan' && typeof c.thresholdC === 'number') return { kind: 'coolerThan', thresholdC: c.thresholdC };
  return { kind: 'always' };
}
function coerceDays(v: unknown): number[] {
  return Array.isArray(v) ? v.filter((d) => typeof d === 'number' && d >= 0 && d <= 6) : [1, 2, 3, 4, 5];
}
function coerceWindows(v: unknown): ScheduleWindow[] {
  const list = Array.isArray(v) ? v : [];
  const out: ScheduleWindow[] = [];
  for (const w of list) {
    if (w && typeof w.start === 'string' && typeof w.end === 'string') {
      out.push({ start: w.start, end: w.end, ...(w.action ? { action: w.action as Partial<Action> } : {}) });
    }
  }
  return out.length ? out : [{ start: '08:00', end: '22:00' }];
}

/** True for a legacy (pre-rule) schedule shape that must be migrated. */
function isLegacySchedule(s: Record<string, unknown>): boolean {
  return !Array.isArray(s.windows) && (typeof s.start === 'string' || Array.isArray((s.scope as { deviceIds?: unknown })?.deviceIds));
}

/** Migrate one legacy schedule into 0..N unit-scoped rules (one per device). */
function migrateLegacySchedule(s: Record<string, unknown>): Schedule[] {
  const scope = s.scope as { deviceIds?: unknown } | undefined;
  const ids = Array.isArray(scope?.deviceIds) ? (scope!.deviceIds as string[]) : [];
  if (ids.length === 0) return []; // bound to no unit — it did nothing; drop on migrate.
  const action: Action = {
    power: true,
    mode: coerceMode(s.mode),
    setpointC: typeof s.setpointC === 'number' ? s.setpointC : 24,
    fan: coerceFan(s.fan),
    vaneUpDown: 'auto',
    vaneLeftRight: 'auto',
  };
  const condition: RunCondition =
    typeof s.roomTempAboveC === 'number' ? { kind: 'warmerThan', thresholdC: s.roomTempAboveC } : { kind: 'always' };
  const windows: ScheduleWindow[] = [
    { start: typeof s.start === 'string' ? s.start : '08:00', end: typeof s.end === 'string' ? s.end : '22:00' },
  ];
  const baseId = typeof s.id === 'string' ? s.id : genId('sched');
  return ids.map((deviceId, i) => ({
    id: ids.length > 1 ? `${baseId}-${i}` : baseId,
    name: typeof s.name === 'string' ? s.name : 'Schedule',
    enabled: typeof s.enabled === 'boolean' ? s.enabled : true,
    type: 'cooling' as DeviceType,
    scope: { kind: 'unit', deviceId },
    days: coerceDays(s.days),
    windows,
    action,
    condition,
  }));
}

/** Coerce one already-migrated rule, defaulting any missing fields. */
function coerceSchedule(s: Record<string, unknown>): Schedule | null {
  const rawScope = s.scope as { kind?: string; deviceId?: string; groupId?: string } | undefined;
  let scope: ScheduleScope;
  if (rawScope?.kind === 'group' && typeof rawScope.groupId === 'string') scope = { kind: 'group', groupId: rawScope.groupId };
  else if (rawScope?.kind === 'unit' && typeof rawScope.deviceId === 'string') scope = { kind: 'unit', deviceId: rawScope.deviceId };
  else return null;
  const type = s.type === 'heating' || s.type === 'lighting' || s.type === 'circuit' || s.type === 'blinds' ? s.type : 'cooling';
  return {
    id: typeof s.id === 'string' ? s.id : genId('sched'),
    name: typeof s.name === 'string' ? s.name : 'Rule',
    enabled: typeof s.enabled === 'boolean' ? s.enabled : true,
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
    if (!item || typeof item !== 'object') continue;
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
const LEGACY_UNIFIED_AUTOMATION_ID = 'solar-surplus-precool';

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
  const hasPreheat = persisted.some((a) => a.type === 'solar_surplus_preheat');
  const out: Automation[] = [];
  for (const a of persisted) {
    const isLegacyUnified =
      a.type === 'solar_surplus_precool' && a.id === LEGACY_UNIFIED_AUTOMATION_ID && !hasPreheat;
    if (!isLegacyUnified) {
      out.push(a);
      continue;
    }
    // Split: re-key the cooling half to the new canonical cool id, and add a heating half
    // (same params + enabled state) so the prior bidirectional behaviour is preserved.
    out.push({ ...a, id: SOLAR_SURPLUS_COOL_AUTOMATION_ID, name: 'Solar-surplus cooling', type: 'solar_surplus_precool' });
    out.push({
      ...a,
      id: SOLAR_SURPLUS_HEAT_AUTOMATION_ID,
      name: 'Solar-surplus heating',
      type: 'solar_surplus_preheat',
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
function mergeAutomations(raw: unknown, base: Automation[], dismissed: string[]): Automation[] {
  // 0. SPLIT migration — convert a legacy unified precool into the two split rules first,
  //    so de-dupe/re-seed below see the post-split shape.
  const persisted = migrateSplitSurplus(Array.isArray(raw) ? (raw as Automation[]) : []);
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
    (b) => !dismissedSet.has(b.id) && !deduped.some((a) => sameRuleAsDefault(a, b)),
  );
  return [...deduped, ...toSeed];
}

/** Merge persisted JSON onto defaults so new fields appear with sane values. */
function hydrate(raw: unknown): StoreSchema {
  const base = defaults();
  if (!raw || typeof raw !== 'object') return base;
  const p = raw as Partial<StoreSchema>;
  return {
    channels: {
      whatsapp: { ...base.channels.whatsapp, ...(p.channels?.whatsapp ?? {}) },
      push: { ...base.channels.push, ...(p.channels?.push ?? {}) },
      email: { ...base.channels.email, ...(p.channels?.email ?? {}) },
    },
    rules: Array.isArray(p.rules) && p.rules.length ? p.rules : base.rules,
    alertOverrides: p.alertOverrides ?? base.alertOverrides,
    activeScenario: p.activeScenario ?? base.activeScenario,
    scenarios:
      p.scenarios && Object.keys(p.scenarios).length ? p.scenarios : base.scenarios,
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
        typeof p.integrations.intesis.username === 'string' &&
        typeof p.integrations.intesis.password === 'string'
          ? p.integrations.intesis
          : base.integrations.intesis,
      // Carry over Settings-configured overrides so they survive a restart.
      ...(p.integrations?.sonnen ? { sonnen: p.integrations.sonnen } : {}),
      ...(p.integrations?.tesla ? { tesla: p.integrations.tesla } : {}),
      ...(p.integrations?.weather ? { weather: p.integrations.weather } : {}),
      ...(p.integrations?.airzone ? { airzone: p.integrations.airzone } : {}),
      ...(p.integrations?.tuya ? { tuya: p.integrations.tuya } : {}),
    },
    deviceSettings: hydrateDeviceSettings(p.deviceSettings, base.deviceSettings),
    schedules: migrateSchedules(p.schedules),
    dismissedDefaultAutomationIds: Array.isArray(p.dismissedDefaultAutomationIds)
      ? [...new Set(p.dismissedDefaultAutomationIds.filter((id): id is string => typeof id === 'string'))]
      : base.dismissedDefaultAutomationIds,
    automations: mergeAutomations(
      p.automations,
      base.automations,
      Array.isArray(p.dismissedDefaultAutomationIds)
        ? p.dismissedDefaultAutomationIds.filter((id): id is string => typeof id === 'string')
        : [],
    ),
    devices: hydrateDevices(p.devices, base.devices),
    lightScenes: Array.isArray(p.lightScenes) ? p.lightScenes : base.lightScenes,
    lightSchedules: Array.isArray(p.lightSchedules) ? p.lightSchedules : base.lightSchedules,
  };
}

/**
 * Force a DISARMED boot regardless of persisted state. OFF by default, so a
 * restart/deploy now PRESERVES the last armed state (set via the arm endpoints) —
 * an ordinary release no longer silently disarms control. Set ENERGY_BOOT_DISARMED=1
 * for a deliberately-safe boot when a release changes control logic; confirm that
 * with the owner before shipping it (see CLAUDE.md §5).
 */
const FORCE_DISARM_ON_BOOT = process.env.ENERGY_BOOT_DISARMED === '1';
const isControlMode = (m: unknown): m is ControlMode => m === 'off' || m === 'manual' || m === 'auto';

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
  if (!p || typeof p !== 'object') return base;
  const out: Record<string, DeviceSettings> = {};
  for (const [id, raw] of Object.entries(p)) {
    if (!raw || typeof raw !== 'object') continue;
    const legacyOn = raw.automationEnabled === true;
    out[id] = {
      ...raw,
      solarCoolEnabled:
        typeof raw.solarCoolEnabled === 'boolean' ? raw.solarCoolEnabled : legacyOn,
      solarHeatEnabled:
        typeof raw.solarHeatEnabled === 'boolean' ? raw.solarHeatEnabled : legacyOn,
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
function hydrateDevices(p: Partial<DevicesState> | undefined, base: DevicesState): DevicesState {
  if (!p || typeof p !== 'object') return base;
  return {
    armed: FORCE_DISARM_ON_BOOT ? false : typeof p.armed === 'boolean' ? p.armed : base.armed,
    mode: FORCE_DISARM_ON_BOOT ? 'off' : isControlMode(p.mode) ? p.mode : base.mode,
    updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : base.updatedAt,
    lastError: typeof p.lastError === 'string' ? p.lastError : null,
    log: Array.isArray(p.log) ? p.log.slice(-100) : base.log,
    guardrails: {
      ...base.guardrails,
      ...(p.guardrails ?? {}),
    },
    manualOverrides:
      p.manualOverrides && typeof p.manualOverrides === 'object' ? p.manualOverrides : {},
    // Rule provenance persists across restarts: a unit the surplus rule started stays
    // rule-owned (auto-managed) on boot, while everything else powered-on is treated as
    // manual. (Legacy installs that persisted a `manualOn` map carry nothing forward —
    // ownership is now derived purely from this provenance set.)
    surplusStartedIds: Array.isArray(p.surplusStartedIds)
      ? [...new Set(p.surplusStartedIds.filter((id): id is string => typeof id === 'string'))]
      : [],
  };
}

/**
 * Rehydrate the control section. Restores the persisted armed state + mode across
 * restarts so a deploy doesn't silently disarm the battery coordinator; an explicit
 * disarm persists armed=false and stays that way. FORCE_DISARM_ON_BOOT overrides to
 * a safe DISARMED/'off' boot. Guardrails + log are preserved.
 */
function hydrateControl(p: Partial<ControlState> | undefined, base: ControlState): ControlState {
  if (!p || typeof p !== 'object') return base;
  return {
    armed: FORCE_DISARM_ON_BOOT ? false : typeof p.armed === 'boolean' ? p.armed : base.armed,
    mode: FORCE_DISARM_ON_BOOT ? 'off' : isControlMode(p.mode) ? p.mode : base.mode,
    updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : base.updatedAt,
    lastError: typeof p.lastError === 'string' ? p.lastError : null,
    log: Array.isArray(p.log) ? p.log.slice(-100) : base.log,
    guardrails: { ...base.guardrails, ...(p.guardrails ?? {}) },
    batteryPriority: hydrateBatteryPriority(p.batteryPriority, base.batteryPriority),
    soakExport: hydrateSoakExport(p.soakExport, base.soakExport),
  };
}

function hydrateSoakExport(
  p: Partial<SoakExportRule> | undefined,
  base: SoakExportRule,
): SoakExportRule {
  if (!p || typeof p !== 'object') return base;
  return {
    enabled: typeof p.enabled === 'boolean' ? p.enabled : base.enabled,
    startW: typeof p.startW === 'number' ? p.startW : base.startW,
    stopW: typeof p.stopW === 'number' ? p.stopW : base.stopW,
    socCeilingPct: typeof p.socCeilingPct === 'number' ? p.socCeilingPct : base.socCeilingPct,
  };
}

function hydrateRule(
  p: Partial<BatteryPriorityRule> | undefined,
  base: BatteryPriorityRule,
): BatteryPriorityRule {
  if (!p || typeof p !== 'object') return base;
  return {
    enabled: typeof p.enabled === 'boolean' ? p.enabled : base.enabled,
    authority: p.authority === 'auto' || p.authority === 'shadow' ? p.authority : base.authority,
    throughputKw: typeof p.throughputKw === 'number' ? p.throughputKw : base.throughputKw,
  };
}

function hydrateBatteryPriority(
  p: Partial<BatteryPriority> | undefined,
  base: BatteryPriority,
): BatteryPriority {
  if (!p || typeof p !== 'object') return base;
  return {
    dischargeSonnenFirst: hydrateRule(p.dischargeSonnenFirst, base.dischargeSonnenFirst),
    chargeTeslaFirst: hydrateRule(p.chargeTeslaFirst, base.chargeTeslaFirst),
  };
}

function hydrateAuth(p: Partial<AuthState> | undefined, base: AuthState): AuthState {
  if (!p || typeof p !== 'object') return base;
  return {
    users: Array.isArray(p.users) ? p.users : base.users,
    sessions: Array.isArray(p.sessions) ? p.sessions : base.sessions,
    trustedDevices: Array.isArray(p.trustedDevices) ? p.trustedDevices : base.trustedDevices,
    otps: Array.isArray(p.otps) ? p.otps : base.otps,
    resetTokens: Array.isArray(p.resetTokens) ? p.resetTokens : base.resetTokens,
    setupTokens: Array.isArray(p.setupTokens) ? p.setupTokens : base.setupTokens,
    loginAttempts:
      p.loginAttempts && typeof p.loginAttempts === 'object'
        ? p.loginAttempts
        : base.loginAttempts,
  };
}

function load(): StoreSchema {
  if (cache) return cache;
  const f = file();
  try {
    if (existsSync(f)) {
      cache = hydrate(JSON.parse(readFileSync(f, 'utf8')));
    } else {
      cache = defaults();
      persist(cache);
    }
  } catch (e) {
    console.error('[store] load failed, using defaults:', (e as Error).message);
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
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    renameSync(tmp, f); // atomic on the same filesystem
  } catch (e) {
    console.error('[store] persist failed:', (e as Error).message);
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
