/**
 * API contract types for the Power web app. The backend is built to the same
 * shape in parallel (see docs/11-build-spec.md §6). Units: kWh, kW, €, %, kg.
 */

export type FlowDir = 'idle' | 'charging' | 'discharging' | 'importing' | 'exporting';
export type Band = 'P1' | 'P2' | 'P3';

export interface LiveResponse {
  ts: string;
  solar: { kw: number; arrays?: { name: string; kw: number }[] };
  home: { kw: number };
  grid: { kw: number; dir: 'importing' | 'exporting' | 'idle' };
  sonnen: { soc: number; kwh: number; kw: number; dir: FlowDir; mode?: string };
  tesla: {
    soc: number;
    kwh: number;
    kw: number;
    dir: FlowDir;
    reservePct: number;
    backupKwh: number;
    backupHours: number;
    island: boolean;
  };
  /** Surplus the climate rule gates on (PV − load − battery intake headroom), kW. May be negative. */
  climateSurplusKw?: number;
  /** False when a battery's live read is missing — the surplus rule will not START this tick. */
  batteryDataComplete?: boolean;
  tariff: { band: Band; rateEur: number; nextBand: Band; minsToNext: number };
  /**
   * Live grid voltage/current/power from the monitored Tuya breaker (category `tdq`),
   * or null when none is configured/exposing `cur_voltage`. Drives the Live "GRID
   * VOLTAGE" KPI box. Fluctuates a lot — polled every 10s with /api/live.
   */
  breaker?: { id: string; name: string; voltageV: number; currentA: number; powerW: number } | null;
  today: {
    producedKwh: number;
    consumedKwh: number;
    gridFeedInKwh: number;
    selfSufficiencyPct: number;
    savedEur: number;
  };
  /**
   * Rolling today curves, 24 hourly buckets (Madrid time). Power series in kW,
   * SoC series in %. Buckets past `nowHour` are 0 (the day hasn't happened yet) —
   * the chart truncates there. Best-effort in-process buffer; resets on restart.
   */
  day: {
    solarKw: number[]; // production
    homeKw: number[]; // consumption
    chargeKw: number[]; // batteries charging (Sonnen + Tesla, combined)
    dischargeKw: number[]; // batteries discharging (combined)
    gridImportKw: number[]; // bought from grid
    gridExportKw: number[]; // fed into grid
    sonnenSoc: number[]; // %
    teslaSoc: number[]; // %
    combinedSoc: number[]; // % of combined usable capacity
    /** Fractional Madrid hour right now (0–24) for the "now" marker. */
    nowHour: number;
  };
}

/* ============================================================================
 * Live day chart — 5-minute measured + forecast (GET /api/history/day).
 * 288 buckets/day (5-min, Madrid). Today = measured + forecast; past days =
 * measured only (forecast null, nowIndex null, no now-line).
 * ==========================================================================*/

/** The nine series the day chart can draw. Power in kW, SoC in %. */
export interface DayChartSeries {
  solarKw: number[]; // production
  homeKw: number[]; // consumption
  chargeKw: number[]; // batteries charging (combined)
  dischargeKw: number[]; // batteries discharging (combined)
  gridImportKw: number[]; // bought from grid
  gridExportKw: number[]; // fed into grid
  sonnenSoc: number[]; // %
  teslaSoc: number[]; // %
  combinedSoc: number[]; // % of combined usable capacity
}

/**
 * Forecast series: same nine keys, each length 288 with values only from
 * nowIndex..287 (null/0 before "now"). Only present for today.
 */
export interface DayChartForecast {
  solarKw: (number | null)[];
  homeKw: (number | null)[];
  chargeKw: (number | null)[];
  dischargeKw: (number | null)[];
  gridImportKw: (number | null)[];
  gridExportKw: (number | null)[];
  sonnenSoc: (number | null)[];
  teslaSoc: (number | null)[];
  combinedSoc: (number | null)[];
}

export interface TariffBandSegment {
  startH: number;
  endH: number;
  band: Band;
}

export interface HistoryDayResponse {
  /** Madrid calendar day (YYYY-MM-DD). */
  date: string;
  /** 0 = today, -1 = yesterday, … (clamped server-side to available range). */
  offset: number;
  /** 5-min bucket index of "now" (0..287), or null for past days. */
  nowIndex: number | null;
  /** Measured 5-min series, each length 288. */
  series: DayChartSeries;
  /** Forecast series (today only), each length 288 with values only ≥ nowIndex. */
  forecast: DayChartForecast | null;
  /** Day's tariff segments for the bottom strip. */
  tariffBands: TariffBandSegment[];
  /** Whether an older / newer day is available to page to. */
  hasPrev: boolean;
  hasNext: boolean;
}

export interface HistoryByBand {
  band: Band;
  kwh: number;
  eur: number;
  rate: number;
}

export interface HistoryByLoad {
  name: string;
  icon: string;
  tone: string;
  kwh: number;
  pct: number;
}

export interface HistoryResponse {
  ts: string;
  totals: {
    producedKwh: number;
    consumedKwh: number;
    exportedKwh: number;
    selfSufficiencyPct: number;
    savedEur: number;
    co2Kg: number;
  };
  solarValue: {
    selfUsedPct: number;
    exportedKwh: number;
    exportEur: number;
    worthIfSelfUsedEur: number;
  };
  byBand: HistoryByBand[];
  powerTermEur: number;
  series: { prod: number[]; cons: number[]; labels: string[]; autonomy?: number[] };
  byLoad: HistoryByLoad[];
}

export type AlertSeverity = 'danger' | 'warning' | 'info' | 'ok';
export type AlertStatus = 'new' | 'ack' | 'resolved';

export interface Alert {
  id: string;
  severity: AlertSeverity;
  icon: string;
  title: string;
  sub: string;
  device: string;
  ts: string;
  status: AlertStatus;
}

export interface AlertsResponse {
  ts: string;
  alerts: Alert[];
  channels: { type: string; detail: string; enabled: boolean }[];
  rules: { id: string; icon: string; label: string; enabled: boolean }[];
}

/** Notification channel config (shared by Settings + Alerts contract). */
export interface Channels {
  whatsapp: { number: string; enabled: boolean };
  push: { enabled: boolean };
  email: { address: string; enabled: boolean };
}

export type ChannelType = 'whatsapp' | 'push' | 'email';

/** Grid-voltage band monitor config (Live KPI + `rule-voltage` alert). */
export interface VoltageMonitor {
  enabled: boolean;
  minV: number;
  maxV: number;
  /** Auto-picked + persisted breaker id (read-only from the UI's perspective). */
  breakerId?: string;
}

/** One 5-minute grid-voltage history bucket (ts = bucket-start epoch ms). */
export interface VoltageSample {
  ts: number;
  voltageV: number;
  currentA: number;
  powerW: number;
}

/** GET /api/voltage/history — 48h grid-voltage history for the Live tile overlay. */
export interface VoltageHistoryResponse {
  samples: VoltageSample[];
  band: { minV: number; maxV: number };
  breaker: { id: string; name: string } | null;
}

export interface SettingsResponse {
  ts: string;
  connections: { name: string; icon: string; tone: string; status: string; detail: string }[];
  /** Grid-voltage band monitor (present so Settings can seed the band controls). */
  voltageMonitor?: VoltageMonitor;
  tariff: {
    bands: { band: Band; rate: number }[];
    powerTermEur: number;
    exportRange: string;
  };
  assets: { name: string; icon: string; tone: string; detail: string }[];
  channels: Channels;
}

export interface PlanAction {
  /** Legacy point-in-time hour (kept for back-compat: marker placement). */
  h: number;
  /** Fractional start hour (0–24) for the duration bar. */
  startH: number;
  /** Fractional end hour (0–24) for the duration bar. Overlaps allowed. */
  endH: number;
  icon: string;
  tone: string;
  title: string;
  why: string;
}

export interface BrainPlanResponse {
  ts: string;
  projected: {
    savedEur: number;
    selfSufficiencyPct: number;
    reservePct: number;
    p1AvoidedKwh: number;
    /** Surplus-solar kWh spent on HVAC during pre-cool/heat windows ("free" climatization). */
    freeClimatizationKwh: number;
  };
  forecast: {
    solarKw: number[];
    loadKw: number[];
    cloudPct: number[];
    /** 25-length 0..24 hourly sun-intensity (% of clear-sky), 0 below horizon. */
    sunIntensityPct: number[];
    /** 25-length predicted generation per hour (kWh, 1dp) = GHI/1000·kWp·PR_eff. */
    genKwh: number[];
    /** 25-length predicted usage per hour (kWh) from the load forecast. */
    usageKwh: number[];
  };
  /** The learned-roof model summary for the active month. */
  model: { month: string; confidencePct: number; days: number };
  socPct: number[];
  tariff: number[];
  actions: PlanAction[];
  now: number;
  whyNow: { title: string; body: string };
  weather: { source: 'live' | 'synthetic'; cloudAvgPct: number };
}

export interface Scenario {
  id: string;
  name: string;
  icon: string;
  active: boolean;
  weights: { save: number; self: number; indep: number; comfort: number };
  reserve: number;
  dynReserve: boolean;
  gridCharge: boolean;
  exportRule: string;
  ev: string;
  precondition: boolean;
  activation: string;
  trigger: string;
}

export interface ScenariosResponse {
  ts: string;
  /** id of the currently-active scenario. */
  active?: string;
  scenarios: Scenario[];
}

/** Editable definition of a scenario (everything but identity/active flag). */
export type ScenarioDef = Omit<Scenario, 'id' | 'name' | 'icon' | 'active'>;

export interface ScenarioPreview {
  selfSufficiencyPct: number;
  savedPerDayEur: number;
  backupHours: number;
}

/** VAPID public key for Web Push subscription. */
export interface VapidPublicResponse {
  publicKey: string;
}

/* ============================================================================
 * Autopilot / battery-control contract (see prompt §backend).
 * Every arm/command/apply call is cookie-authed AND admin-gated server-side.
 * ==========================================================================*/

export type ControlMode = 'off' | 'manual' | 'auto';

/** Lever payloads accepted by POST /api/control/command. */
export type TeslaMode = 'self_consumption' | 'autonomous' | 'backup';
export type SonnenMode = 'self_consumption' | 'manual' | 'time_of_use';

/** The live, on-device state Power reads back from each battery. */
export interface ControlCurrent {
  tesla: {
    mode: TeslaMode | string;
    reservePct: number;
    gridChargeAllowed: boolean;
    exportRule: string;
  };
  sonnen: {
    mode: SonnenMode | string;
  };
}

/** Hard limits the backend always enforces, shown read-only in the UI. */
export interface ControlGuardrails {
  socFloorPct: number;
  teslaReserveMinPct: number;
  sonnenMaxW: number;
  gridImportCapKw: number;
}

/** One row of "what the boss did" — newest first in the response. */
export interface ControlLogEntry {
  ts: string;
  device: 'tesla' | 'sonnen' | string;
  lever: string;
  from: string | number | boolean | null;
  to: string | number | boolean | null;
  reason: string;
  ok: boolean;
  detail?: string | null;
}

/** A single battery-priority rule (Sonnen-first discharge / Tesla-first charge). */
export type BatteryPriorityAuthority = 'shadow' | 'auto';
export interface BatteryPriorityRule {
  enabled: boolean;
  authority: BatteryPriorityAuthority;
  /** Throughput (kW) the priority battery handles alone; beyond it the other joins. */
  throughputKw: number;
}
export interface BatteryPriority {
  dischargeSonnenFirst: BatteryPriorityRule;
  chargeTeslaFirst: BatteryPriorityRule;
}
export type BatteryPriorityKey = keyof BatteryPriority;

/** Force-charge-to-soak-export rule — absorb solar surplus before it spills to grid. */
export interface SoakExportRule {
  enabled: boolean;
  /** Engage once net grid export exceeds this (W). */
  startW: number;
  /** Revert to self-consumption once export drops below this (W). Always < startW. */
  stopW: number;
  /** Don't force-charge a battery at/above this SoC (%). */
  socCeilingPct: number;
}

/** A tariff-arbitrage effectiveness event (mirrors the API's ArbitrageEvent). */
export type ArbitrageEventType = 'plan' | 'engage' | 'revert' | 'standdown' | 'deviation';
export interface ArbitrageEvent {
  ts: number;
  type: ArbitrageEventType;
  executionMode: 'advisory' | 'active';
  band: Band;
  spreadEur: number;
  plan: {
    active: boolean;
    targetSocPct: number;
    valleyBuyKwh: number;
    peakDeficitKwh: number;
    reason: string;
  } | null;
  live: {
    combinedSoc: number | null;
    sonnenSoc: number | null;
    teslaSoc: number | null;
    solarKw: number;
    loadKw: number;
    gridExportKw: number;
    expectedSocFromPlan: number | null;
    socDeviationPct: number | null;
  };
  action: { mode: string; chargeW: number } | null;
  /** Forecast-vs-actual divergence that triggered a re-plan (only on `deviation` events). */
  deviation?: {
    input: 'solar' | 'load' | 'solar+load';
    solarForecastKw: number;
    solarLiveKw: number;
    loadForecastKw: number;
    loadLiveKw: number;
  } | null;
  chargedKwhTick: number;
  estSavedEurTick: number;
}

/** Cumulative tariff-arbitrage stats (advisory modelled vs active realized). */
export interface ArbitrageStats {
  sinceTs: number;
  lastEventTs: number | null;
  engagementsActive: number;
  engagementsAdvisory: number;
  valleyKwhActive: number;
  valleyKwhAdvisory: number;
  estSavedEurActive: number;
  estSavedEurAdvisory: number;
}

export interface ControlStatus {
  armed: boolean;
  mode: ControlMode;
  lastError: string | null;
  current: ControlCurrent;
  guardrails: ControlGuardrails;
  batteryPriority: BatteryPriority;
  soakExport: SoakExportRule;
  log: ControlLogEntry[];
  /** Cumulative arbitrage stats + recent events (the in-state ring; JSONL is the durable record). */
  arbitrageStats?: ArbitrageStats;
  arbitrageLog?: ArbitrageEvent[];
}

/** Lever a manual command can target on each device. */
export type ControlDevice = 'tesla' | 'sonnen';
export type ControlLever = 'reserve' | 'mode' | 'gridCharge';
export type ControlCommandValue = string | number | boolean;

/* ============================================================================
 * Batteries — per-device detail (GET /api/batteries).
 * Current state is real; day history is a best-effort rolling buffer; health
 * fields are null where the device/API doesn't expose them (UI shows "—").
 * ==========================================================================*/

export type BatteryId = 'sonnen' | 'tesla';

export interface BatterySpec {
  label: string;
  value: string;
}

export interface BatteryDetail {
  id: BatteryId;
  name: string;
  vendor: string;
  role: string;
  online: boolean;
  soc: number;
  kwh: number;
  usableKwh: number;
  nominalKwh: number;
  power: { kw: number; dir: FlowDir };
  maxKw: number;
  mode: string;
  hasBackup: boolean;
  reservePct: number | null;
  backupKwh: number | null;
  backupHours: number | null;
  island: boolean | null;
  stormMode: boolean | null;
  exportRule: string | null;
  gridChargeAllowed: boolean | null;
  headroomKwh: number;
  aboveReserveKwh: number | null;
  health: number | null;
  capacityKwh: number | null;
  cyclesTotal: number | null;
  throughputKwh: number | null;
  roundTripPct: number | null;
  tempC: number | null;
  warrantyPct: number | null;
  installedYear: number | null;
  todayInKwh: number;
  todayOutKwh: number;
  socDay: number[];
  chargeKwDay: number[];
  dischargeKwDay: number[];
  specs: BatterySpec[];
}

export interface BatteriesResponse {
  ts: string;
  combined: { usableKwh: number; storedKwh: number; soc: number };
  batteries: BatteryDetail[];
}

/* ============================================================================
 * Auth contract (see prompt §backend). Cookies carry the session.
 * ==========================================================================*/

export type UserRole = 'admin' | 'member';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}

export interface MeResponse {
  user: AuthUser;
  /** The signed-in user's real 2FA state (so the Settings toggle seeds from truth). */
  twoFactor?: { enabled: boolean; channel: OtpChannel };
  /** Whether a WhatsApp provider is configured (so the UI can gate that channel). */
  whatsappAvailable?: boolean;
}

export type OtpChannel = 'whatsapp' | 'email';

/** POST /api/auth/login → user (done) | otp step | (401 throws). */
export type LoginResponse = { user: AuthUser } | { step: 'otp'; channel: OtpChannel };

export interface SessionInfo {
  id: string;
  /** human label, e.g. "Chrome · macOS" */
  device: string;
  /** e.g. "Jávea, ES" or an IP */
  location?: string;
  /** ISO timestamp of last activity */
  lastSeen?: string;
  /** true for the session making this request */
  current?: boolean;
}

export interface TrustedDevice {
  id: string;
  device: string;
  /** ISO timestamp the trust expires */
  expiresAt?: string;
  /** true if this is the device making the request */
  current?: boolean;
}

export interface SessionsResponse {
  sessions: SessionInfo[];
  trusted: TrustedDevice[];
}

export interface UsersResponse {
  users: AuthUser[];
}

export interface CreateUserResponse {
  /** one-time URL the new user opens to set their password */
  setupUrl: string;
}

/* ============================================================================
 * Devices / Climate (GET /api/devices). AC is the first device type. Reads are
 * any-authed; command/arm/CRUD writes are admin-gated server-side. Boots DISARMED.
 * ==========================================================================*/

export type ClimateMode = 'auto' | 'heat' | 'dry' | 'fan' | 'cool';
export type ClimateLever = 'power' | 'mode' | 'setpoint' | 'fan' | 'vaneUpDown' | 'vaneLeftRight';
export type DeviceWarmth = 'cold' | 'cool' | 'comfortable' | 'warm' | 'hot' | 'unknown';

/** Device categories a rule can target. Extensible (lighting/circuit land later). */
export type DeviceType = 'cooling' | 'heating' | 'lighting' | 'circuit' | 'blinds' | 'speakers';

// ---- Sonos speakers + house alarm ------------------------------------------

export interface SonosSpeaker {
  id: string;
  name: string;
  group: string;
  groupName: string;
  coordinator: boolean;
  volumePct: number | null;
  online: boolean;
}

export interface SpeakersResponse {
  ts: string;
  enabled: boolean;
  seedIp: string | null;
  discoveredCount: number;
  lastError: string | null;
  speakers: SonosSpeaker[];
  context: { deviceCount: number };
}

export interface AlarmStatus {
  ts: string;
  active: boolean;
  startedAt: string | null;
  durationMs: number | null;
  remainingSec: number | null;
  lightIds: string[];
  siren: boolean;
}

export interface SonosIntegrationStatus {
  ts: string;
  configured: boolean;
  enabled: boolean;
  seedIp: string | null;
  discoveredCount: number;
  names: string[];
  lastError: string | null;
}

/* ---- Sonos internet radio (favourites + directory + schedules) ---- */

export const RADIO_FAVORITE_SLOTS = 10;

export interface RadioStation {
  id: string;
  slot: number;
  name: string;
  streamUrl: string;
  logo?: string;
  codec?: string;
}

export interface RadioFavoritesResponse {
  ts: string;
  slots: number;
  favorites: RadioStation[];
}

export interface RadioSearchResult {
  name: string;
  streamUrl: string;
  logo: string | null;
  codec: string | null;
  bitrate: number | null;
  countryCode: string | null;
  tags: string[];
}

export interface RadioSearchResponse {
  ts: string;
  query: string;
  results: RadioSearchResult[];
  error?: string;
}

export interface SonosFavorite {
  title: string;
  uri: string;
  streamUrl: string | null;
}

export interface SonosFavoritesResponse {
  ts: string;
  favorites: SonosFavorite[];
}

export interface RadioPlayResponse {
  ts: string;
  ok: boolean;
  playedOn: string[];
  coordinator: string;
}

export interface RadioSchedule {
  id: string;
  name: string;
  enabled: boolean;
  days: number[];
  onTime: string;
  offTime?: string | null;
  stationId: string;
  speakerIds: string[];
  volumePct: number;
}

export interface RadioSchedulesResponse {
  ts: string;
  schedules: RadioSchedule[];
}

/** Hard floor for the blink half-period (ms) — enforced in UI + API. */
export const ALARM_BLINK_FLOOR_MS = 400;

export interface AlarmConfig {
  enabled: boolean;
  /** Speaker UUIDs to sound; empty = all. */
  speakerIds: string[];
  volumePct: number;
  /** Light ids to blink; empty = all. */
  lightIds: string[];
  /** Blink half-period (ms); floored at ALARM_BLINK_FLOOR_MS. */
  blinkMs: number;
  /** Safety auto-stop (s); 0 = no cap. */
  autoStopSec: number;
}

export interface AlarmConfigResponse {
  ts: string;
  config: AlarmConfig;
}

export interface DeviceView {
  id: string;
  name: string;
  zone?: string;
  installation?: string;
  type: DeviceType;
  power: boolean;
  mode: string;
  setpointC: number | null;
  currentTempC: number | null;
  minSetpointC: number | null;
  maxSetpointC: number | null;
  online: boolean;
  /** Current fan step: 0 = auto, 1..5 = manual. null if not reported. */
  fanLevel?: number | null;
  /** Vane positions: 0 = auto (A), 1..5 = fixed, 10 = swing. null if not reported. */
  vaneUpDown?: number | null;
  vaneLeftRight?: number | null;
  /** Heating (Airzone) read fields; null/absent for cooling (Intesis) units. */
  /** Room is actively calling for heat (underfloor loop open) → drives the flame. */
  floorDemand?: boolean | null;
  /** Relative humidity (%), shown on the detail page. */
  humidity?: number | null;
  /** Radio (wireless) thermostat. */
  wireless?: boolean | null;
  /** Radio thermostat reporting a low battery. */
  lowBattery?: boolean | null;
  room: string;
  /** First-class Rooms model: assigned room id (null = Unassigned) + resolved name. */
  roomId: string | null;
  roomName: string | null;
  /** LEGACY: true iff EITHER solar direction is enrolled. */
  automationEnabled: boolean;
  /** Solar-surplus COOLING enrolment (independent per-direction flag). */
  solarCoolEnabled: boolean;
  /** Solar-surplus HEATING enrolment (independent per-direction flag). */
  solarHeatEnabled: boolean;
  /** Epoch ms a manual-control hold expires on this unit, or null if none active. */
  manualOverrideUntil: number | null;
  /** Sticky: user manually switched this unit ON → excluded from the surplus auto-stop. */
  manualOn: boolean;
  comfortCeilingC: number | null;
  comfortFloorC: number | null;
  warmth: DeviceWarmth;
  governedBy: { schedules: string[]; automations: string[] };
}

export interface DevicesContext {
  indoorAvgC: number | null;
  band: Band;
  deviceCount: number;
  onCount: number;
}

export interface ClimateGuardrails {
  setpointMinC: number;
  setpointMaxC: number;
  gridImportCapKw: number;
  minCycleMin: number;
}

export interface DevicesResponse {
  ts: string;
  connected: boolean;
  fleetError: string | null;
  armed: boolean;
  mode: ControlMode;
  lastError: string | null;
  guardrails: ClimateGuardrails;
  context: DevicesContext;
  devices: DeviceView[];
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

export interface DevicesStatus {
  ts: string;
  armed: boolean;
  mode: ControlMode;
  lastError: string | null;
  guardrails: ClimateGuardrails;
  log: ClimateLogEntry[];
}

export interface DeviceDetailResponse {
  ts: string;
  connected: boolean;
  device: DeviceView | null;
  schedules?: Schedule[];
  automations?: Automation[];
}

/** Fan / vane settings: 'auto' (A) or a discrete 1..5 position. */
export type FanSetting = 'auto' | 1 | 2 | 3 | 4 | 5;
export type VaneSetting = 'auto' | 1 | 2 | 3 | 4 | 5;

/** The device action a rule applies during its windows. Type-adaptive; cooling shown. */
export interface Action {
  power: boolean;
  mode: ClimateMode;
  setpointC: number;
  fan: FanSetting;
  vaneUpDown: VaneSetting;
  vaneLeftRight: VaneSetting;
  /** Blinds only: target position 0 = closed … 100 = open. */
  positionPct?: number;
  /** Circuit (generic switchable device) only: fan speed in DEVICE units to set at
   *  ON. Omit = leave the device's current speed as-is. */
  speed?: number;
  /** Circuit only: direction enum value (e.g. 'forward'/'reverse') to set at ON.
   *  Omit = leave as-is. */
  direction?: string;
}

export type TimeAnchor = 'fixed' | 'sunrise' | 'sunset';

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
  | { kind: 'always' }
  | { kind: 'warmerThan'; thresholdC: number }
  | { kind: 'coolerThan'; thresholdC: number };

export type ScheduleScope =
  | { kind: 'unit'; deviceId: string }
  | { kind: 'group'; groupId: string };

/** A scheduling RULE — belongs to a single unit (or named group) of one device type. */
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

export interface SchedulesResponse {
  ts: string;
  schedules: Schedule[];
}

/**
 * Params shared by both single-direction solar-surplus rules. A rule reads only its own
 * direction's fields: a COOLING rule (solar_surplus_precool) uses roomTempLimitC →
 * targetSetpointC; a HEATING rule (solar_surplus_preheat) uses heatRoomFloorC →
 * heatTargetSetpointC. Both are serialised so a save never drops the other direction's
 * target (matches the API sanitiser).
 */
export interface SolarSurplusPrecoolParams {
  /** Cooling trigger (°C): cooling runs while room > this limit. */
  roomTempLimitC: number;
  /** Cooling target setpoint to drive the room down toward (°C). */
  targetSetpointC: number;
  /** Heating trigger (°C): heating runs while room < this floor. */
  heatRoomFloorC?: number;
  /** Heating target setpoint to drive the room up toward (°C). */
  heatTargetSetpointC?: number;
  surplusClearSec: number;
  /** Whether the tariff-band stand-down applies at all. Default true (undefined ⇒ on). */
  bandRestrictionEnabled?: boolean;
  exitBand: Band;
  startThresholdW?: number;
}

/**
 * Params for the TARIFF-ARBITRAGE battery automation (task #15). Mirrors the API's
 * TariffArbitrageParams. Seeded DISABLED; only acts when enabled && battery Autopilot
 * is armed in Auto.
 */
export interface TariffArbitrageParams {
  /** Pre-peak SoC target ceiling (%): never grid-charge above this. */
  peakTargetSocPct: number;
  /** Max grid-charge power into the Sonnen during the valley (kW). */
  maxGridChargeKw: number;
  /** Minimum P1−P3 price spread (€/kWh) for the arbitrage to be worthwhile. */
  minSpreadEur: number;
  /** Discharge floor (%) the peak discharge respects (≥ Tesla reserve / SoC floor). */
  dischargeFloorPct: number;
  /** Only buy the shortfall the forecast solar won't provide. */
  solarShortfallOnly: boolean;
  /** When exporting (live surplus), defer to #34 soak-export and don't grid-buy. */
  surplusOverridesGridCharge: boolean;
  /** Valley band for grid-charging (cheap window; P3). */
  valleyBand: Band;
  /** Peak band to discharge through (expensive window; P1). Never grid-charge here or in P2. */
  peakBand: Band;
  /** SAFETY GATE: 'advisory' = observe & log only, no battery commands; 'active' = executes
   *  the valley grid-charge (spends money). Default 'advisory'. */
  executionMode: 'advisory' | 'active';
  /** Certainty gate: only pre-buy when ≥ this % sure the next peak's solar falls short.
   *  Default 70; clamp 50–95. */
  solarConfidencePct: number;
  /** Pre-peak surplus guard: stand down if the next P1 is within this many hours and the house
   *  is already in strong live solar surplus. Default 2; clamp 0–6. */
  prePeakSurplusGuardHours: number;
  /** Pre-peak surplus margin (%): live solar must exceed live load by this % to trip the guard.
   *  Default 30; clamp 0–200. */
  prePeakSurplusMarginPct: number;
  /** Deviation threshold as % of the FORECAST value (forecast-vs-actual). Default 30; clamp 1–100. */
  deviationThresholdPct: number;
  /** Deviation floor (kW) so tiny forecasts don't trip on noise. Default 0.8; clamp 0–5. */
  deviationMinKw: number;
}

/** COOLING = solar_surplus_precool · HEATING = solar_surplus_preheat · BATTERY = tariff_arbitrage. */
export type AutomationType = 'solar_surplus_precool' | 'solar_surplus_preheat' | 'tariff_arbitrage';

/** Shape depends on `type`: climate params for the surplus rules, battery params for arbitrage. */
export type AutomationParams = SolarSurplusPrecoolParams | TariffArbitrageParams;

export interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  type: AutomationType;
  params: AutomationParams;
  lastEval: number | null;
}

/** Type guard narrowing an automation to the tariff-arbitrage (battery) shape. */
export function isTariffArbitrage(
  a: Automation,
): a is Automation & { params: TariffArbitrageParams } {
  return a.type === 'tariff_arbitrage';
}

export interface AutomationsResponse {
  ts: string;
  automations: Automation[];
}

export interface IntegrationStatus {
  ts: string;
  connected: boolean;
  deviceCount: number;
  username: string | null;
  error: string | null;
}

/** Effective config of the server-managed connections (token never included). */
export interface IntegrationsConfig {
  ts: string;
  sonnen: { host: string; hasToken: boolean; overridden: boolean };
  tesla: { siteId: string; overridden: boolean };
  weather: { lat: number; lon: number; overridden: boolean };
  airzone: { host: string; overridden: boolean };
}

/** Result of a connection test / save. */
export interface ProbeResult {
  ok: boolean;
  detail: string;
}

/* ============================================================================
 * Lights (GET /api/lights) — first Tuya device CATEGORY. Reads are any-authed;
 * command writes are admin-gated server-side. Built on the shared Tuya cloud
 * foundation; more categories (covers/switches/breakers/fans) follow this shape.
 * ==========================================================================*/

export type LightLever = 'power' | 'brightness' | 'colorTemp' | 'color';

export interface LightHsv {
  /** Hue 0–360. */
  h: number;
  /** Saturation 0–100 (percent). */
  s: number;
  /** Value 0–100 (percent). */
  v: number;
}

export interface LightUnit {
  id: string;
  name: string;
  room: string;
  /** First-class Rooms model: assigned room id (null = Unassigned) + resolved name. */
  roomId?: string | null;
  roomName?: string | null;
  category: string;
  online: boolean;
  power: boolean;
  /** Brightness percent 1–100, or null if not dimmable. */
  brightnessPct: number | null;
  /** Colour-temperature percent 0–100 (0 = warmest, 100 = coolest), or null. */
  colorTempPct: number | null;
  color: LightHsv | null;
  workMode: string | null;
  dimmable: boolean;
  tunable: boolean;
  colorable: boolean;
  /** True when this unit is a user-SET-UP device (typeId 'lighting'), not a native
   *  Tuya light. The card shows a "details" affordance that opens its edit screen. */
  configured?: boolean;
}

export interface LightsResponse {
  ts: string;
  connected: boolean;
  fleetError: string | null;
  devices: LightUnit[];
  context: { deviceCount: number; onCount: number };
}

export interface LightDetailResponse {
  ts: string;
  connected: boolean;
  device: LightUnit | null;
}

/* ============================================================================
 * Blinds / curtains (Tuya, category 'cl'/'clkg'). positionPct is 100 = fully OPEN.
 * ==========================================================================*/

export type BlindLever = 'open' | 'close' | 'stop' | 'position';

export interface BlindUnit {
  id: string;
  name: string;
  room: string;
  /** First-class Rooms model: assigned room id (null = Unassigned) + resolved name. */
  roomId?: string | null;
  roomName?: string | null;
  category: string;
  online: boolean;
  /** Current position, 0 = closed, 100 = open; null if the motor has no feedback. */
  positionPct: number | null;
  /** Whether the motor is currently travelling. */
  moving: boolean;
  /** Device exposes a settable target position (vs. open/close/stop only). */
  supportsPosition: boolean;
  /** Echo of the per-device invert setting that was applied. */
  inverted: boolean;
}

export interface BlindsResponse {
  ts: string;
  connected: boolean;
  fleetError: string | null;
  devices: BlindUnit[];
  context: { deviceCount: number; openCount: number };
}

export interface BlindDetailResponse {
  ts: string;
  connected: boolean;
  device: BlindUnit | null;
}

/** Tuya Cloud connection status + discovered category breakdown. */
export interface TuyaIntegrationStatus {
  ts: string;
  connected: boolean;
  region: string;
  deviceCount: number;
  lightCount: number;
  categories: Array<{ label: string; count: number }>;
  error: string | null;
  /** Count of paired devices not yet surfaced by a shipped category screen. */
  needsSetupCount?: number;
}

/* ============================================================================
 * Discovered devices (onboarding inbox — Devices → Needs setup). Phase 1 is
 * READ + TRIAGE: a device the Tuya fleet reports but no shipped screen renders.
 * ==========================================================================*/

export type CapabilityKind =
  | 'switch' | 'range' | 'enum' | 'action' | 'color' | 'measure' | 'status';

export interface Capability {
  kind: CapabilityKind;
  key: string;
  label: string;
  dp: string;
  unit?: string;
  min?: number;
  max?: number;
  options?: string[];
  readOnly: boolean;
  /** True for safety-critical `action` capabilities (locks/sirens/gates) — the
   *  generic renderer requires a confirm tap before firing these. */
  sensitive?: boolean;
}

/** A per-DP override from the setup sheet's Advanced datapoints editor. */
export interface CapabilityOverride {
  dp: string;
  kind?: CapabilityKind;
  label?: string;
  hidden?: boolean;
  readOnly?: boolean;
}

/** A user-minted custom device type (label + icon), store-backed. */
export interface CustomDeviceType {
  id: string;
  label: string;
  icon: string;
}

/** A set-up (configured) generic device + its live capability values. */
export interface ConfiguredDeviceView {
  id: string;
  name: string;
  typeId: string;
  category: string;
  online: boolean;
  capabilities: Capability[];
  /** dp → current app-facing value. */
  values: Record<string, unknown>;
  roomGuess: string | null;
  /** First-class Rooms model: assigned room id (null = Unassigned) + resolved name. */
  roomId?: string | null;
  roomName?: string | null;
  setupAt: string;
}

export interface ConfiguredResponse {
  ts: string;
  connected: boolean;
  fleetError: string | null;
  devices: ConfiguredDeviceView[];
  customDeviceTypes: CustomDeviceType[];
}

export interface CustomTypesResponse {
  ts: string;
  customDeviceTypes: CustomDeviceType[];
}

/** A single datapoint row in the diagnostics table. */
export interface DiagnosticDp {
  dp: string;
  kind: CapabilityKind;
  label: string;
  readOnly: boolean;
  value: unknown;
}

/** Device identity + network + datapoint table, for debugging control issues. */
export interface DeviceDiagnostics {
  id: string;
  name: string;
  category: string;
  productName: string | null;
  online: boolean;
  ip: string | null;
  mac: string | null;
  typeId: string | null;
  /** For typeId 'lighting': the DP the on/off toggle + scenes/schedules drive. */
  primarySwitchDp: string | null;
  dps: DiagnosticDp[];
}

export interface DeviceDiagnosticsResponse {
  ts: string;
  connected: boolean;
  fleetError?: string | null;
  device: DeviceDiagnostics | null;
}

/** Raw result of a single test command fired through a chosen Tuya API. */
export interface DeviceCommandProbe {
  api: 'v1' | 'iot03' | 'v2';
  httpOk: boolean;
  success: boolean;
  result: unknown;
  code?: number;
  msg?: string;
}
export interface DeviceCommandTestResponse {
  ts: string;
  id: string;
  dp: string;
  value: unknown;
  probe: DeviceCommandProbe;
}

export type DiscoveredConfidence = 'high' | 'monitor' | 'review';

export interface DiscoveredDevice {
  id: string;
  name: string;
  category: string;
  productName: string | null;
  online: boolean;
  proposedType: { label: string; icon: string };
  capabilities: Capability[];
  confidence: DiscoveredConfidence;
  roomGuess: string | null;
  readout: string | null;
}

export interface DiscoveredResponse {
  ts: string;
  connected: boolean;
  fleetError: string | null;
  devices: DiscoveredDevice[];
  ignored: DiscoveredDevice[];
}

/* ============================================================================
 * Rooms — a first-class, cross-cutting location concept spanning every device type.
 * ==========================================================================*/

export interface Room {
  id: string;
  name: string;
  icon: string;
  order: number;
}

/** A room with its live device count (from GET /api/rooms). */
export interface RoomWithCount extends Room {
  deviceCount: number;
}

export interface RoomsResponse {
  ts: string;
  rooms: RoomWithCount[];
  unassignedCount: number;
  deviceCount: number;
  fleetError: string | null;
}

/** One device's result in a room-level All-off. */
export interface RoomAllOffResult {
  id: string;
  name: string;
  kind: string;
  ok: boolean;
  reason: string;
}

export interface RoomAllOffResponse {
  ts: string;
  id: string;
  scope: 'all' | 'lights';
  results: RoomAllOffResult[];
}

/* ---- Light scenes + schedules (self-contained light subsystem) ---- */

export interface LightSceneMember {
  lightId: string;
  on: boolean;
  /** Brightness % (1–100) to set when on; null = leave as-is / not dimmable. */
  brightnessPct?: number | null;
}

export interface LightScene {
  id: string;
  name: string;
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
  days: number[];
  onTime: string;
  onAnchor?: TimeAnchor;
  onOffsetMin?: number;
  offTime?: string | null;
  offAnchor?: TimeAnchor;
  offOffsetMin?: number;
  /** Variation window for on-time (minutes); actual offset = ±(onVariationMin/2). */
  onVariationMin?: number;
  /** Variation window for off-time (minutes); actual offset = ±(offVariationMin/2). */
  offVariationMin?: number;
  target: LightScheduleTarget;
}

export interface ScenesResponse {
  ts: string;
  scenes: LightScene[];
}

export interface LightSchedulesResponse {
  ts: string;
  schedules: LightSchedule[];
}
