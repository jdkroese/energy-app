/**
 * API contract types for the Power web app. The backend is built to the same
 * shape in parallel (see docs/11-build-spec.md §6). Units: kWh, kW, €, %, kg.
 */

export type FlowDir =
  | "idle"
  | "charging"
  | "discharging"
  | "importing"
  | "exporting";
export type Band = "P1" | "P2" | "P3";

export interface LiveResponse {
  ts: string;
  solar: { kw: number; arrays?: { name: string; kw: number; est?: boolean; dark?: boolean }[] };
  home: { kw: number };
  grid: { kw: number; dir: "importing" | "exporting" | "idle" };
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
  /** Surplus the climate rule gates on = grid export (solar spilling to the grid), kW. ≥ 0. */
  climateSurplusKw?: number;
  /** False when a battery's live read is missing — the surplus rule will not START this tick. */
  batteryDataComplete?: boolean;
  tariff: { band: Band; rateEur: number; nextBand: Band; minsToNext: number };
  /**
   * Live grid voltage/current/power from the monitored Tuya breaker (category `tdq`),
   * or null when none is configured/exposing `cur_voltage`. Drives the Live "GRID
   * VOLTAGE" KPI box. Fluctuates a lot — polled every 10s with /api/live.
   */
  breaker?: {
    id: string;
    name: string;
    voltageV: number;
    currentA: number;
    powerW: number;
  } | null;
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
  /** Period navigator (Reports): which period this payload is for + bounds. */
  offset?: number;
  isCurrent?: boolean;
  hasPrev?: boolean;
  hasNext?: boolean;
  periodLabel?: string | null;
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
  series: {
    prod: number[];
    cons: number[];
    labels: string[];
    autonomy?: number[];
    /** Real per-bucket grid import (kWh) split by tariff band (time-of-use). */
    bandKwh?: { P1: number[]; P2: number[]; P3: number[] };
  };
  byLoad: HistoryByLoad[];
}

export type AlertSeverity = "danger" | "warning" | "info" | "ok";
export type AlertStatus = "new" | "ack" | "resolved";

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

export type ChannelType = "whatsapp" | "push" | "email";

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
  /** Sonnen inverter AC terminal voltage (V), when recorded. Runs higher than the
   *  breaker meter and governs the over-voltage trip; absent/0 where unavailable. */
  sonnenUacV?: number;
}

/** GET /api/voltage/history — 48h grid-voltage history for the Live tile overlay. */
export interface VoltageHistoryResponse {
  samples: VoltageSample[];
  band: { minV: number; maxV: number };
  breaker: { id: string; name: string } | null;
}

/** GET /api/weather/current — cheap current-conditions read for the TopBar weather
 *  pill. Null fields mean the upstream fetch failed — fail soft, never show a fake
 *  reading. */
export interface CurrentWeatherResponse {
  ts: string;
  temperatureC: number | null;
  windSpeedKmh: number | null;
}

// ---- Circuit-breaker usage metering (docs/28) ------------------------------

export type BreakerUsageGranularity = "raw" | "hour" | "day";

/** One point in a per-breaker usage series. `ts` is unix SECONDS. */
export interface BreakerUsagePoint {
  ts: number;
  energyWh: number;
  powerAvgW: number | null;
  powerMaxW?: number | null;
  voltageAvgV?: number | null;
  samples?: number;
}

/** GET /api/breakers/:id/usage — per-breaker time-series + total kWh. */
export interface BreakerUsageResponse {
  breaker: { id: string; name: string };
  granularity: BreakerUsageGranularity;
  /** False when metering is disabled/unavailable (UI empty-states gracefully). */
  available: boolean;
  points: BreakerUsagePoint[];
  totalKwh: number;
}

/** GET /api/breakers/usage/summary — per-breaker kWh + share for a period. */
export interface BreakerUsageSummaryResponse {
  period: "today" | "week" | "month";
  available: boolean;
  breakers: Array<{ id: string; name: string; kwh: number; sharePct: number }>;
  totalKwh: number;
}

export interface SettingsResponse {
  ts: string;
  connections: {
    name: string;
    icon: string;
    tone: string;
    status: string;
    detail: string;
  }[];
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
  weather: { source: "live" | "synthetic"; cloudAvgPct: number };
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
export type ScenarioDef = Omit<Scenario, "id" | "name" | "icon" | "active">;

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

export type ControlMode = "off" | "manual" | "auto";

/** Lever payloads accepted by POST /api/control/command. */
export type TeslaMode = "self_consumption" | "autonomous" | "backup";
export type SonnenMode = "self_consumption" | "manual" | "time_of_use";

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
  device: "tesla" | "sonnen" | string;
  lever: string;
  from: string | number | boolean | null;
  to: string | number | boolean | null;
  reason: string;
  ok: boolean;
  detail?: string | null;
}

/** A single battery-priority rule (Sonnen-first discharge / Tesla-first charge). */
export type BatteryPriorityAuthority = "shadow" | "auto";
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
    input: "solar" | "load" | "solar+load";
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
export type ControlDevice = "tesla" | "sonnen";
export type ControlLever = "reserve" | "mode" | "gridCharge";
export type ControlCommandValue = string | number | boolean;

/* ============================================================================
 * Battery decision trace (GET /api/control/decisions) — Phase 0 rule visibility.
 * One compact record per coordinator tick: what each battery actuator was told
 * and why. Mirrors the API's DecisionRecord.
 * ==========================================================================*/

export interface DecisionActuator {
  /** e.g. 'self_consumption' / 'backup' (tesla.mode) or 'soak-export 3200W' (sonnen). */
  value: string;
  /** One-line reason — the same string the command/log used. */
  reason: string;
}

export interface DecisionRecord {
  ts: number;
  /** What ran the tick ('auto' coordinator tick / 'apply-scenario'). */
  trigger: string;
  armed: boolean;
  mode: ControlMode;
  band: Band;
  scenario: string;
  inputs: {
    gridImportKw: number;
    gridExportKw: number;
    /** Which meter the import/export came from (different metering domains). */
    gridSource: "tesla" | "sonnen" | "none";
    sonnenSoc: number | null;
    teslaSoc: number | null;
  };
  tesla: { mode: DecisionActuator; reservePct: number };
  sonnen: DecisionActuator & { branch: string };
  stoodDown: { rule: string; reason: string }[];
  /** Actuator stances that changed vs the previous record ('tesla.mode' | 'sonnen'). */
  changed: string[];
}

export interface DecisionsResponse {
  ts: string;
  /** The latest record — the live stance per actuator (null before the first tick). */
  current: DecisionRecord | null;
  /** Recent records, newest first. */
  decisions: DecisionRecord[];
}

/* ============================================================================
 * Batteries — per-device detail (GET /api/batteries).
 * Current state is real; day history is a best-effort rolling buffer; health
 * fields are null where the device/API doesn't expose them (UI shows "—").
 * ==========================================================================*/

export type BatteryId = "sonnen" | "tesla";

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

/** Matches the API's UserRole exactly (apps/api/src/store.ts) — "user" is a
 *  regular member; the UI labels it "Member". */
export type UserRole = "admin" | "user" | "kiosk";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}

/** Row shape for the admin Users list (GET /api/auth/users) — a superset of
 *  AuthUser with the fields only an admin needs to see. */
export interface AdminUser extends AuthUser {
  twoFactor: { enabled: boolean; channel: OtpChannel };
  hasPassword: boolean;
  createdAt: number;
}

export interface MeResponse {
  user: AuthUser;
  /** The signed-in user's real 2FA state (so the Settings toggle seeds from truth). */
  twoFactor?: { enabled: boolean; channel: OtpChannel };
  /** Whether a WhatsApp provider is configured (so the UI can gate that channel). */
  whatsappAvailable?: boolean;
}

export type OtpChannel = "whatsapp" | "email";

/** POST /api/auth/login → user (done) | otp step | (401 throws). */
export type LoginResponse =
  | { user: AuthUser }
  | { step: "otp"; channel: OtpChannel };

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
  users: AdminUser[];
}

export interface CreateUserResponse {
  /** one-time URL the new user opens to set their password */
  setupUrl: string;
}

/* ============================================================================
 * Devices / Climate (GET /api/devices). AC is the first device type. Reads are
 * any-authed; command/arm/CRUD writes are admin-gated server-side. Boots DISARMED.
 * ==========================================================================*/

export type ClimateMode = "auto" | "heat" | "dry" | "fan" | "cool";
export type ClimateLever =
  | "power"
  | "mode"
  | "setpoint"
  | "fan"
  | "vaneUpDown"
  | "vaneLeftRight";
export type DeviceWarmth =
  | "cold"
  | "cool"
  | "comfortable"
  | "warm"
  | "hot"
  | "unknown";

/** Device categories a rule can target. Extensible (lighting/circuit land later).
 *  'controller' = a wireless scene switch (INPUT device, no actuatable load). */
export type DeviceType =
  | "cooling"
  | "heating"
  | "lighting"
  | "circuit"
  | "blinds"
  | "speakers"
  | "irrigation"
  | "controller";

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

/** Live Sonos transport state — what's actually playing across the fleet (any source). */
export interface SonosPlayback {
  isPlaying: boolean;
  title: string | null;
  source: string | null;
  coordinator: string | null;
  speakerIds: string[];
}

export interface SpeakersResponse {
  ts: string;
  enabled: boolean;
  seedIp: string | null;
  discoveredCount: number;
  lastError: string | null;
  speakers: SonosSpeaker[];
  /** Present when at least one group is playing; null/absent when idle. */
  playback?: SonosPlayback | null;
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

/** A non-radio Sonos favourite (Spotify/SoundCloud playlist etc.) that can't be imported. */
export interface SonosSkippedFavorite {
  title: string;
  service: string | null;
}

export interface SonosFavoritesResponse {
  ts: string;
  favorites: SonosFavorite[];
  skipped?: SonosSkippedFavorite[];
}

/** The active radio session (with the real target speakers) — for the now-playing banner. */
export interface RadioNowPlaying {
  name: string;
  stationId: string | null;
  speakerIds: string[];
  wholeHouse: boolean;
  coordinator: string | null;
  startedAt: string;
}

export interface RadioNowPlayingResponse {
  ts: string;
  nowPlaying: RadioNowPlaying | null;
}

export interface RadioPlayResponse {
  ts: string;
  ok: boolean;
  playedOn: string[];
  coordinator: string;
}

/** A Spotify context a music schedule can play (playlist/album/liked/track). */
export interface SpotifyScheduleTarget {
  contextUri: string;
  contextName: string;
  contextImage?: string | null;
  kind: 'playlist' | 'album' | 'track' | 'liked';
}

/** A music schedule — plays a radio station OR a Spotify context. `source` selects the target. */
export interface RadioSchedule {
  id: string;
  name: string;
  enabled: boolean;
  days: number[];
  onTime: string;
  offTime?: string | null;
  /** Which source this schedule plays. Legacy entries default to 'radio'. */
  source: 'radio' | 'spotify';
  /** Radio target (source='radio'). */
  stationId: string;
  /** Spotify target (source='spotify'). */
  spotify?: SpotifyScheduleTarget | null;
  speakerIds: string[];
  volumePct: number;
}

/* ---- Spotify (Music) — Web API + Spotify Connect ---- */

/** Safe client-facing Spotify status — NEVER carries the secret or tokens. */
export interface SpotifyStatus {
  ts: string;
  /** Client id + secret have been entered. */
  configured: boolean;
  /** OAuth consent completed (a refresh token exists). */
  connected: boolean;
  premium: boolean;
  displayName: string | null;
  /** The redirect URI the owner must register in their Spotify app dashboard. */
  redirectUri: string;
}

export interface SpotifyBrowseItem {
  /** The Spotify URI to play (context_uri for playlists, track uri for tracks/liked). */
  uri: string;
  name: string;
  subtitle: string;
  image: string | null;
  kind: 'playlist' | 'track' | 'liked';
}

export interface SpotifyBrowseResponse {
  ts: string;
  items: SpotifyBrowseItem[];
}
export interface SpotifySearchResponse {
  ts: string;
  query: string;
  items: SpotifyBrowseItem[];
}

/** A Spotify Connect device mapped (by name) to a Sonos zone. */
export interface SpotifyConnectDevice {
  id: string | null;
  name: string;
  type: string;
  isActive: boolean;
  sonosId: string | null;
}
export interface SpotifyDevicesResponse {
  ts: string;
  devices: SpotifyConnectDevice[];
}

export interface SpotifyNowPlaying {
  isPlaying: boolean;
  track: string | null;
  artist: string | null;
  album: string | null;
  image: string | null;
  progressMs: number;
  durationMs: number;
  shuffle: boolean;
  repeat: 'off' | 'context' | 'track';
  deviceName: string | null;
  sonosIds: string[];
}
export interface SpotifyNowPlayingResponse {
  ts: string;
  nowPlaying: SpotifyNowPlaying | null;
}

export interface SpotifyPlayResponse {
  ts: string;
  ok: boolean;
  playedOn: string[];
  coordinator: string;
  deviceId: string;
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
export type FanSetting = "auto" | 1 | 2 | 3 | 4 | 5;
export type VaneSetting = "auto" | 1 | 2 | 3 | 4 | 5;

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
  | { kind: "warmerThan"; thresholdC: number }
  | { kind: "coolerThan"; thresholdC: number };

export type ScheduleScope =
  | { kind: "unit"; deviceId: string }
  | { kind: "group"; groupId: string };

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
  /** Minimum on-time (s) after a start before the rule may soft-stop the unit (anti-chatter). */
  minRunSec?: number;
  /** Fan speed the rule sets when it switches a unit on (0=auto, 1..5). */
  fanLevel?: number;
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
  executionMode: "advisory" | "active";
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
export type AutomationType =
  | "solar_surplus_precool"
  | "solar_surplus_preheat"
  | "tariff_arbitrage";

/** Shape depends on `type`: climate params for the surplus rules, battery params for arbitrage. */
export type AutomationParams =
  | SolarSurplusPrecoolParams
  | TariffArbitrageParams;

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
  return a.type === "tariff_arbitrage";
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
  /** Sungrow solar inverters — the two WiNet-S dongles (docs/36). `lastSeen` surfaces
   *  IP drift (a DHCP move) between polls. */
  sungrow: { dongles: { ip: string; name: string; lastSeen: string | null }[]; overridden: boolean };
  /** iSolarCloud cloud backstop (docs/44, Phase B). Secrets never returned — only
   *  whether each is set + whether the integration is fully configured. */
  isolarcloud?: {
    configured: boolean;
    region: string;
    account: string;
    hasAppkey: boolean;
    hasAccessKey: boolean;
    hasRsaKey: boolean;
  };
}

/** iSolarCloud credential payload (Phase B). Any omitted field keeps the stored one;
 *  password is write-only. serialMap optionally maps cloud serial → local dongle IP. */
export interface IsolarcloudCreds {
  appkey?: string;
  accessKey?: string;
  rsaPublicKey?: string;
  account?: string;
  password?: string;
  region?: string;
  serialMap?: Record<string, string>;
}

/** Result of a connection test / save. */
export interface ProbeResult {
  ok: boolean;
  detail: string;
  /** A LAN scan located the controller at this IP — the UI offers to switch to it. */
  suggestedHost?: string;
}

/* ============================================================================
 * Solar inverters (Sungrow SG5.0RS ×2; docs/36). READ-ONLY monitoring — live
 * per-inverter production + health + fault log, and per-inverter production history.
 * ==========================================================================*/

export interface InverterFault {
  name: string;
  type: string;
  status: string;
  code: number | null;
  id: number | null;
  time: string;
}

export interface InverterView {
  id: string;
  name: string;
  ip: string;
  model: string;
  kw: number;
  dailyKwh: number;
  totalKwh: number;
  tempC: number | null;
  workState: string;
  reachable: boolean;
  lastSeen: string | null;
  /** 'online' (producing/reachable), 'asleep' (night — expected), 'offline' (daylight miss). */
  status: 'online' | 'asleep' | 'offline';
  faults: InverterFault[];
  activeFaultCount: number;
}

export interface InvertersResponse {
  ts: string;
  daylight: boolean;
  productionKw: number;
  todayKwh: number;
  count: number;
  inverters: InverterView[];
}

export interface InvertersHistoryResponse {
  ts: string;
  range: string;
  labels: string[];
  series: { id: string; name: string; kwh: number[]; totalKwh: number }[];
}

/* ============================================================================
 * Irrigation (Rain Bird ESP-TM2 + LNK/LNK2). Reads any-authed; run/stop/rain-delay
 * writes are admin-gated AND require the Devices layer to be armed. Zones also merge
 * into /api/devices under type 'irrigation'.
 * ==========================================================================*/

export interface IrrigationZone {
  id: string; // `rb-<station>`
  name: string;
  station: number;
  active: boolean;
  available: boolean;
  roomId: string | null;
  roomName: string | null;
}

export interface IrrigationResponse {
  ts: string;
  connected: boolean;
  armed: boolean;
  mode: ControlMode;
  zones: IrrigationZone[];
  activeStationId: string | null;
  rainDelayDays: number;
  running: boolean;
  lastError: string | null;
}

export interface IrrigationZoneDetailResponse {
  ts: string;
  connected: boolean;
  zone: IrrigationZone | null;
  rainDelayDays: number;
}

export type IrrigationLever = "run" | "stop" | "rainDelay";

/** Rain Bird integration status (host + whether a password is set; never the value). */
export interface RainbirdIntegrationStatus {
  ts: string;
  connected: boolean;
  host: string;
  hasPassword: boolean;
  overridden: boolean;
  status: ProbeResult | null;
  info: { model: string; version: string; serialNumber: string } | null;
}

/* ---- Irrigation Phase 2 (smart-watering plan) ----------------------------- */

export type IrrigationMode = "off" | "live";
export type IrrigationPlantType =
  | "lawn"
  | "shrubs"
  | "flowers"
  | "vegetables"
  | "trees"
  | "groundcover"
  | "succulents"
  | "hedge";
export type IrrigationEmitterType =
  | "spray"
  | "rotor"
  | "drip"
  | "bubbler"
  | "soaker";
export type IrrigationManagedBy = "app" | "controller";

/** One watering time on a zone's weekly schedule (start + duration ceiling + weekdays). */
export interface IrrigationWateringTime {
  id: string;
  startTime: string; // "HH:MM"
  durationMin: number;
  days: boolean[]; // 0=Sun..6=Sat
}

/** A zone in the plan: config + live state + today's ET-trim figures (from /api/irrigation/plan). */
export interface IrrigationPlanZone {
  zoneId: string;
  name: string;
  station: number;
  available: boolean;
  active: boolean;
  runningRemainingMin: number | null;
  plantType: IrrigationPlantType;
  emitterType: IrrigationEmitterType;
  flowLpm: number;
  kc: number;
  areaM2: number | null;
  sunExposure: number | null;
  managedBy: IrrigationManagedBy;
  heatTopupEnabled: boolean;
  rainSkipMm: number | null;
  photoId: string | null;
  photoUrl: string | null;
  wateringTimes: IrrigationWateringTime[];
  deficitMm: number;
  scheduledMinToday: number;
  trimmedMinToday: number;
  savedPctToday: number;
  litersToday: number;
  trimReasons: string[];
  nextRun: { startTime: string; weekday: number } | null;
  nextRunSkip: {
    decision: "skip" | "run";
    reason: string;
    rainMm: number;
    probabilityPct: number;
  } | null;
}

/** A zone currently watering (from GET /api/irrigation/active — the light nav poll). */
export interface IrrigationActiveZone {
  zoneId: string;
  name: string;
  station: number;
  /** Minutes left in the app-initiated run, or null (e.g. an external/keypad run). */
  remainingMin: number | null;
}

export interface IrrigationActiveResponse {
  ts: string;
  connected: boolean;
  active: IrrigationActiveZone[];
}

/** One day of the multi-day forecast outlook (from /api/irrigation/plan). */
export interface IrrigationDailyOutlook {
  date: string; // "YYYY-MM-DD"
  precipMm: number;
  precipProbabilityPct: number;
  et0Mm: number;
  tMaxC: number;
  sunshineHours: number;
  humidityPct: number;
  cloudCoverPct: number;
}

export interface IrrigationLogEntry {
  ts: number;
  zoneId: string;
  action:
    | "plan"
    | "fire"
    | "trim"
    | "skip"
    | "suppress"
    | "confirm"
    | "alert"
    | "decide";
  live: boolean;
  ok: boolean;
  detail: string;
}

export interface IrrigationPlanResponse {
  ts: string;
  connected: boolean;
  mode: IrrigationMode;
  liveAllowed: boolean;
  /** False while onboard-program suppression is paused (verifying Home-App watering). */
  suppressingOnboard: boolean;
  armed: boolean;
  devicesMode: ControlMode;
  globalRainSkipMm: number;
  rainSkipProbabilityPct: number;
  zones: IrrigationPlanZone[];
  baselineMirror: {
    ts: string;
    rainDelayDays: number;
    availableStationIds: string[];
  } | null;
  baselineDrift: boolean;
  weather: {
    et0Mm: number;
    precipMm: number;
    precipProbabilityPct: number;
  } | null;
  outlook: IrrigationDailyOutlook[];
  stats: {
    zoneCount: number;
    plannedTodayMin: number;
    savedPctToday: number;
    nextRun: { startTime: string; weekday: number } | null;
  };
  log: IrrigationLogEntry[];
  lastError: string | null;
  lastTickAt: string | null;
}

/** A patch for a zone's agronomic + schedule config (all fields optional). */
export type IrrigationZonePatch = Partial<{
  name: string;
  plantType: IrrigationPlantType;
  emitterType: IrrigationEmitterType;
  flowLpm: number;
  areaM2: number;
  sunExposure: number;
  kc: number;
  managedBy: IrrigationManagedBy;
  heatTopupEnabled: boolean;
  rainSkipMm: number;
  wateringTimes: IrrigationWateringTime[];
}>;

/* ============================================================================
 * Lights (GET /api/lights) — first Tuya device CATEGORY. Reads are any-authed;
 * command writes are admin-gated server-side. Built on the shared Tuya cloud
 * foundation; more categories (covers/switches/breakers/fans) follow this shape.
 * ==========================================================================*/

export type LightLever = "power" | "brightness" | "colorTemp" | "color";

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

export type BlindLever = "open" | "close" | "stop" | "position";

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
  /** How this blind can be positioned: 'native' (hardware DP), 'timed' (travelSec configured),
   *  or null (open/stop/close only — no slider). */
  positionMode?: "native" | "timed" | null;
  /** Configured full-travel seconds for a timed blind (undefined for native/none). */
  travelSec?: number;
  /** Best-known position for a timed blind (server's assumed %); mirrors positionPct for native. */
  assumedPct?: number | null;
  /** Timed blind: false when the assumed position is unknown (post-restart / never moved). */
  anchored?: boolean;
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
  /** docs/51 Change 1 — manual (LAN-only) fleet listing: default ON, undefined/true = on,
   *  explicit false = off (cloud-primary, docs/49 behaviour). */
  fleetManual?: boolean;
}

/** POST /api/integrations/tuya/sync — docs/51 Change 1's "Sync from Tuya cloud" button: one
 *  explicit cloud fleet refresh. */
export interface TuyaFleetSyncResult {
  ts: string;
  devices: number;
  /** Cloud device ids the local registry doesn't know about yet — still need the harvest ops
   *  flow (key capture) before they can go local. */
  newIds: string[];
}

/** GET/PUT /api/integrations/tuya/local — LOCAL (LAN) control diagnostics + the reversible
 *  Settings toggle (docs/44 Phase 2). Never includes a device's local_key. */
export interface TuyaLocalStatus {
  /** Effective on/off right now (env kill-switch, then the persisted store setting —
   *  see isLocalEnabled() in tuya-local.ts). */
  enabled: boolean;
  loadedAt: string | null;
  totals: {
    devices: number;
    capable: number;
    healthy: number;
    unsupportedVersion: number;
    /** Devices with a persisted cloud/local dp-map (docs/49 Change 1/4) — what Settings
     *  → Tuya's "dp-maps captured: N / M devices" line shows. */
    dpMapsCaptured: number;
  };
  v35SightingsUncorrelated: string[];
}

/** POST /api/integrations/tuya/local/capture-dpmaps — docs/49 Change 4 one-shot capture. */
export interface TuyaCaptureDpMapsResult {
  ts: string;
  total: number;
  captured: number;
  alreadyHad: number;
  failed: number;
  failedIds: string[];
}

/* ============================================================================
 * Discovered devices (onboarding inbox — Devices → Needs setup). Phase 1 is
 * READ + TRIAGE: a device the Tuya fleet reports but no shipped screen renders.
 * ==========================================================================*/

export type CapabilityKind =
  | "switch"
  | "range"
  | "enum"
  | "action"
  | "color"
  | "measure"
  | "status";

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
  /** EV (car) breaker: "Solar / P3 charging only" opt-in (docs/33). */
  solarP3Only?: boolean;
  /** EV breaker: auto-learned charger draw (W), or null if none learned yet. */
  learnedDrawW?: number | null;
  /** EV breaker: live rule state — null when not opted in. */
  evState?: { reason: 'surplus' | 'p3' | 'waiting' | 'off'; ruleOn: boolean; reservedW: number } | null;
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
  /** True when the device was recovered via a direct per-device read (i.e. it had fallen out
   *  of the bulk fleet list — usually because its Tuya cloud link dropped). */
  viaDirect?: boolean;
  device: DeviceDiagnostics | null;
}

/** Raw result of a single test command fired through a chosen Tuya API. */
export interface DeviceCommandProbe {
  api: "v1" | "iot03" | "v2";
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

export type DiscoveredConfidence = "high" | "monitor" | "review";

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
  scope: "all" | "lights";
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
  /** Starred by the owner — favorites surface first in the Scenes grid. */
  favorite?: boolean;
  members: LightSceneMember[];
}

export type LightScheduleTarget =
  | { kind: "scene"; sceneId: string }
  | { kind: "lights"; members: LightSceneMember[] };

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

/* ---- Home scenes (whole-home: lights + climate + blinds in one tap) ---- */

export interface HomeSceneClimateMember {
  deviceId: string;
  power: boolean;
  mode?: string;
  setpointC?: number | null;
}

export interface HomeSceneBlindMember {
  blindId: string;
  action: "open" | "close" | "position";
  positionPct?: number | null;
}

export interface HomeScene {
  id: string;
  name: string;
  icon?: string;
  /** Starred by the owner — favorites surface first (e.g. the wall-tablet Home). */
  favorite?: boolean;
  /** 'all-off' = the built-in everything-off scene (lights/climate/blinds all off). */
  special?: "all-off";
  lights: LightSceneMember[];
  climate: HomeSceneClimateMember[];
  blinds: HomeSceneBlindMember[];
}

export interface HomeScenesResponse {
  ts: string;
  scenes: HomeScene[];
}

/* ---- Scene controllers (wireless scene switches) ---- */
/** A press binding's target: a Light scene ('light') or a whole-home scene ('home').
 *  `kind` defaults to 'home' for records written before this field existed. */
export interface SceneButtonPress {
  kind: "light" | "home";
  sceneId: string;
  on: boolean;
}

export interface SceneButtonBinding {
  /** 1-based physical button index (1..4). */
  index: number;
  label?: string;
  /** Single-click binding: scene to toggle + persisted current toggle state. */
  single?: SceneButtonPress;
  /** RESERVED (Phase 2). */
  double?: SceneButtonPress;
  long?: SceneButtonPress;
}

export interface SceneControllerView {
  deviceId: string;
  name: string;
  online: boolean;
  /** True when present in the live fleet as a 'wxkg' scene switch. */
  resolved: boolean;
  enabled: boolean;
  buttons: SceneButtonBinding[];
}

export interface SceneControllersResponse {
  ts: string;
  connected: boolean;
  controllers: SceneControllerView[];
}

export interface LightSchedulesResponse {
  ts: string;
  schedules: LightSchedule[];
}

// ---- Invoice vault (Bills) -------------------------------------------------

export type InvoiceBand = "P1" | "P2" | "P3";

export interface InvoiceBandLine {
  kwh?: number;
  rate?: number;
  amount?: number;
}
export interface InvoicePowerLine {
  kw?: number;
  days?: number;
  rate?: number;
  amount?: number;
}
export interface InvoiceIeeLine {
  amount?: number;
  basis?: number;
  pct?: number;
  mwh?: number;
  eurPerMwh?: number;
}

/** The full parsed invoice struct returned by the API (every field optional). */
export interface ParsedInvoice {
  facturaNum?: string;
  fechaFactura?: string;
  cups?: string;
  nif?: string;
  comercializadora?: string;
  periodStart?: string;
  periodEnd?: string;
  days?: number;
  contractedKw?: { P1?: number; P2?: number };
  maxPowerKw?: { P1?: number; P2?: number; P3?: number };
  meterRegister?: Record<InvoiceBand, number | undefined>;
  energy?: Record<InvoiceBand, InvoiceBandLine | undefined>;
  power?: { P1?: InvoicePowerLine; P2?: InvoicePowerLine };
  excedentes?: Record<InvoiceBand, InvoiceBandLine | undefined>;
  adjustments?: Array<{
    label: string;
    kwh?: number;
    rate?: number;
    amount?: number;
  }>;
  subtotal?: number;
  iee?: InvoiceIeeLine;
  meterRental?: number;
  bonoSocial?: { days?: number; rate?: number; amount?: number };
  baseImponible?: number;
  ivaPct?: number;
  iva?: number;
  total?: number;
  warnings: string[];
}

/** Compact metered-energy vs other-costs split carried on each list row (Phase 1.5). */
export interface CostSplit {
  energyEur: number;
  fixedEur: number;
  regTaxEur: number;
  creditsEur: number;
  otherEur: number;
  total: number;
}

export interface InvoiceSummary {
  id: string;
  uploadedAt: string;
  sourceFile: string;
  confirmed: boolean;
  facturaNum?: string;
  periodStart?: string;
  periodEnd?: string;
  total?: number;
  bandKwh: { P1: number | null; P2: number | null; P3: number | null };
  /** Metered-energy vs other-costs decomposition split (Phase 1.5). */
  split: CostSplit;
  flagged: boolean;
  flagReason?: string;
}

/** One labelled sub-line inside a cost group (Phase 1.5). */
export interface CostLine {
  key: string;
  label: string;
  eur: number;
  source: "billed" | "modelled";
  unpredictable?: boolean;
}

/** A named cost group + its € subtotal (Phase 1.5). */
export interface CostGroup {
  key: "energy" | "fixed" | "regTax" | "credits";
  label: string;
  eur: number;
  lines: CostLine[];
}

/** Full per-invoice cost decomposition (4 groups) + energy/other split (Phase 1.5). */
export interface CostBreakdown {
  groups: CostGroup[];
  energyEur: number;
  fixedEur: number;
  regTaxEur: number;
  creditsEur: number;
  otherEur: number;
  total: number;
  billedTotal: number | null;
  energyPct: number | null;
  otherPct: number | null;
  usedModelFallback: boolean;
  hasUnpredictable: boolean;
  notes: string[];
}

export interface ReconcileRow {
  key: string;
  label: string;
  billed: number | null;
  modelled: number | null;
  deltaEur: number | null;
  deltaPct: number | null;
}
export interface Reconciliation {
  rows: ReconcileRow[];
  billedTotal: number | null;
  modelledTotal: number | null;
  totalDeltaEur: number | null;
  totalDeltaPct: number | null;
  pricingLabel?: string;
  notes: string[];
}

export interface InvoiceDetail {
  id: string;
  uploadedAt: string;
  sourceFile: string;
  confirmed: boolean;
  parsed: ParsedInvoice;
  reconciliation: Reconciliation;
  /** Phase 1.5 — metered-energy vs other-costs decomposition (4 groups). */
  breakdown: CostBreakdown;
}

export interface InvoicesListResponse {
  invoices: InvoiceSummary[];
}
export interface InvoiceParseResponse {
  parsed: ParsedInvoice;
  sourceFile: string;
}
export interface InvoiceSaveResponse {
  id: string;
  invoice: InvoiceSummary;
}

/* ---- Unified Event Viewer (docs/37) --------------------------------------- */

export type EventClass = 'action' | 'observation' | 'system';
export type EventSeverity = 'low' | 'medium' | 'high' | 'critical';
export type EventCategory =
  | 'battery'
  | 'climate'
  | 'blinds'
  | 'ev'
  | 'irrigation'
  | 'water'
  | 'arbitrage'
  | 'grid'
  | 'solar'
  | 'connectivity'
  | 'security'
  | 'kitchen'
  | 'app';
export type EventTriggerSource =
  | 'surplus-rule'
  | 'schedule'
  | 'arbitrage'
  | 'manual'
  | 'user'
  | 'threshold'
  | 'guardrail'
  | 'health-probe'
  | 'coordinator'
  | 'boot'
  | 'deploy';
export type EventStateKind = 'active' | 'cleared';
export type EventAckStatus = 'new' | 'ack' | 'resolved';

export interface EnergyEvent {
  id: string;
  ts: string;
  class: EventClass;
  category: EventCategory;
  severity: EventSeverity;
  summary: string;
  trigger: { source: EventTriggerSource; detail?: string };
  device?: string;
  /** Server-resolved friendly/user-assigned device name (falls back to the raw id). */
  deviceName?: string;
  /** Server-resolved device category/type routing hint (climate/lighting/battery/…). */
  deviceType?: string;
  entity?: string;
  change?: { from: unknown; to: unknown };
  ok?: boolean;
  detail?: string;
  data?: Record<string, unknown>;
  state?: EventStateKind;
  relatedId?: string;
  ackStatus?: EventAckStatus;
  notified?: EventTriggerSource[];
}

export interface EventsListResponse {
  ts: string;
  events: EnergyEvent[];
  nextCursor: string | null;
}

export interface EventsConfig {
  highLoadEnabled: boolean;
  highLoadKw: number;
  highCurrentEnabled: boolean;
  highCurrentA: number;
  dwellSec: number;
  hysteresisFrac: number;
}

export interface EventsConfigResponse {
  ts: string;
  eventsConfig: EventsConfig;
}

/** Query params for GET /api/events (all optional; multi-values comma-joined). */
export interface EventsQuery {
  class?: EventClass[];
  category?: EventCategory[];
  severity?: EventSeverity[];
  source?: EventTriggerSource[];
  device?: string;
  state?: EventStateKind;
  q?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}

/* ---- Kitchen Hub (Cooking + Groceries, docs/38 + docs/39) ------------------
 * Mirrors apps/api/src/kitchen/types.ts — the server is the source of truth. */

export type KitchenCuisine = 'spanish' | 'dutch' | 'japanese' | 'italian' | 'global';
export type KitchenSeason = 'spring' | 'summer' | 'autumn' | 'winter';

export interface RecipeIngredient {
  name: string;
  /** Canonical Spanish name — drives Mercadona SKU search. */
  es: string;
  qty: number | null;
  unit: string;
  pantryStaple?: boolean;
}

export interface RecipeStep {
  phase: 'mise' | 'cook';
  text: string;
  timerSec?: number;
}

export interface RecipeNutrition {
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  estimated: boolean;
}

export interface Recipe {
  id: string;
  title: string;
  photo?: string | null;
  /** Attribution for an enrichment-fetched photo (docs/47 §3b, docs/48 §4a) — shown as a
   *  subtle credit line in the quick-view; absent for seed/url photos. */
  photoCredit?: { name: string; url: string; provider: 'openverse' | 'pexels' | 'commons'; license?: string } | null;
  source: 'seed' | 'url' | 'manual' | 'ai';
  sourceUrl?: string;
  servingsBase: number;
  prepMin: number;
  cookMin: number;
  tags: string[];
  cuisine: KitchenCuisine;
  kidScore?: number;
  season?: KitchenSeason[];
  nutrition?: RecipeNutrition;
  tools: string[];
  ingredients: RecipeIngredient[];
  steps: RecipeStep[];
  lastCookedAt?: string | null;
  ratings?: Record<string, number>;
  createdAt: string;
  updatedAt: string;
}

/**
 * Slim recipe shape (docs/46 §2a P2): everything EXCEPT `steps` (the bulky cook-instruction
 * text) — what the shelf/search/planner surfaces work with at scale. Fetch the full Recipe
 * (with steps) by id via api.kitchen.recipe(id) only when actually cooking/quick-viewing one.
 */
export type RecipeSlim = Omit<Recipe, 'steps'>;

export interface MealPlanDay {
  date: string;
  recipeId?: string | null;
  servings: number;
  skip?: boolean;
  pinned?: boolean;
  note?: string;
  /** Swap rotation memory — recipe ids recently swapped away (server-managed). */
  recentSwapIds?: string[];
}

export interface MealPlan {
  weekStart: string;
  days: MealPlanDay[];
}

export interface StaplesItem {
  id: string;
  productId?: string | null;
  name: string;
  defaultQty: number;
  cadence: 'weekly' | 'biweekly' | 'monthly';
  lastOrderedAt?: string | null;
  priceEur?: number | null;
}

export interface OrderSuggestion {
  id: string;
  kind: 'pack' | 'merge' | 'cadence';
  text: string;
  state: 'open' | 'confirmed' | 'ignored';
  auto?: boolean;
  subject?: string;
}

export interface OrderLine {
  id: string;
  source: 'recipe' | 'staple' | 'manual' | 'tablet' | 'regular';
  recipeIds?: string[];
  productId?: string | null;
  ingredientKey: string;
  label: string;
  qty: number;
  unit: string;
  packsNeeded?: number;
  coverageNote?: string;
  needsMapping?: boolean;
  checked: boolean;
  priceEur?: number | null;
  /** True when priceEur is a preserved last-known estimate (live re-check unavailable),
   *  not live-confirmed — the UI shows a muted "est." marker. */
  priceEst?: boolean;
  pantry?: boolean;
  /** Mixed units were aggregated across recipes — the qty needs a human check (P2). */
  incomparable?: boolean;
}

export interface OrderDraft {
  weekStart?: string;
  lines: OrderLine[];
  suggestions: OrderSuggestion[];
  status: 'draft' | 'filled' | 'submitted';
  targetSlot?: { day: string; window: string };
  submitBy?: string;
  pushedAt?: string | null;
  totalEur: number;
  updatedAt: string;
}

export interface OrderHistoryEntry {
  id: string;
  date: string;
  lines: OrderLine[];
  totalEur: number;
  deliveredAt?: string | null;
  source?: 'checklist' | 'cart' | 'mercadona';
  orderId?: string | null;
  slot?: { start: string; end: string } | null;
}

export interface KitchenHouseholdGoals {
  mode: 'weight-loss' | 'maintain' | 'high-protein' | null;
  kcalPerDinner: number | null;
  notes?: string;
}

/** Dietary guardrail sliders (docs/46 §1a) — all 1–10, 5 = neutral/no bias. */
export interface KitchenNutritionScales {
  calories: number;
  carbs: number;
  fish: number;
  veg: number;
  protein: number;
}

export interface KitchenHousehold {
  adults: number;
  kids: number;
  allergies: string[];
  /** Hard filter — preset slugs ('vegetarian', 'no-pork', …) or free text, matched like allergies. */
  dietRestrictions: string[];
  dislikes: string[];
  loves: string[];
  weeknightMaxMin: number;
  cuisineWeights: Record<KitchenCuisine, number>;
  goals: KitchenHouseholdGoals;
  showNutritionOnCards: boolean;
  nutritionScales: KitchenNutritionScales;
  /** Prefer in-season/local produce for our location (Jávea, Costa Blanca). */
  seasonalLocal: boolean;
  /** Free-text ingredient chips to boost (garden surplus). */
  boostIngredients: string[];
}

export interface KitchenReminders {
  planWeekDow: number;
  planWeekHour: number;
  submitByDow: number;
  submitByHour: number;
  targetSlotLabel: string;
}

export interface KitchenProductHit {
  id: string;
  name: string;
  photo: string | null;
  unitPrice: number | null;
  packSizeDisplay: string | null;
  packSize: { qty: number; unit: string } | null;
  referencePrice: string | null;
}

export interface KitchenIntelligence {
  enabled: boolean;
  features: {
    importParsing: boolean;
    cookingSuggestions: boolean;
    plannerRequestBox: boolean;
    weeklyPlanAssist: boolean;
    /** AI generates complete structured candidate recipes → saved into the library (docs/43). */
    recipeGeneration: boolean;
  };
  usage: { month: string; inputTokens: number; outputTokens: number; eur: number };
  keyMasked: string | null;
  envKey: boolean;
  configured: boolean;
  /** Optional Pexels key (docs/47 §3b) — write-only, same masking pattern as keyMasked. */
  pexelsKeyMasked: string | null;
}

export interface MercadonaStatus {
  ok: boolean;
  warehouse: string | null;
  products: number | null;
  searchOk: boolean;
  latencyMs: number;
  detail?: string;
}

/* ---- Kitchen Hub P2 (docs/41): account link · cart fill · slots · regulars ---- */

export interface MercadonaAccountStatus {
  linked: boolean;
  label: string | null;
  customerIdMasked: string | null;
  tokenMasked: string | null;
  linkedAt: string | null;
  lastRefreshAt: string | null;
  lastRefreshOk: boolean | null;
  dryRun: boolean;
  spendCapEur: number;
  warehouse: string | null;
}

export interface MercadonaSlot {
  id: string;
  start: string | null;
  end: string | null;
  day: string | null;
  available: boolean;
  priceEur: number | null;
}

export interface CartPlanItem {
  product_id: string;
  quantity: number;
  label: string;
  priceEur: number | null;
  /** priceEur is a preserved last-known estimate, not live-confirmed. */
  estimated?: boolean;
}

export interface FillCartResponse {
  ts: string;
  ok: boolean;
  dryRun: boolean;
  linked: boolean;
  payload?: { lines: Array<{ product_id: string; quantity: number }> };
  added?: number;
  cartLines?: number;
  items: CartPlanItem[];
  /** Checked lines that didn't ship: 'unmapped' (no product) or 'unpriced' (obsolete/no price). */
  skipped: Array<{ label: string; reason: 'unmapped' | 'unpriced' | string }>;
  totalEur: number;
  unpricedCount: number;
  /** Items priced from a last-known estimate (Mercadona flaky) — included in totalEur. */
  estimatedCount: number;
  capEur: number;
  cartUrl?: string;
}

export interface KitchenRegularHit {
  id: string;
  name: string;
  photo: string | null;
  unitPrice: number | null;
  packSizeDisplay: string | null;
  /** True when this product is already a line in the current order draft (greyed, not re-addable). */
  inDraft: boolean;
  /** Mercadona's recommended_quantity for this regular (1..99) — seeds the added order line's qty. */
  recommendedQty: number;
}

/** GET /recipes (docs/46 §2b): paginated + filtered + FTS-backed by default; `total` is the
 *  FULL match count (not just this page). `?all=slim` returns the whole slim index unpaginated
 *  (page/pageSize are then absent) — see api.kitchen.recipesAll(). */
export interface RecipesResponse { ts: string; recipes: RecipeSlim[]; total: number; page?: number; pageSize?: number }
export interface RecipeResponse { ts: string; recipe: Recipe }
export interface RecipeImportResponse {
  ts: string;
  ok: boolean;
  recipe?: Recipe;
  prefill?: { title?: string; photo?: string | null; sourceUrl: string };
  detail?: string;
}
export interface MealPlanResponse {
  ts: string;
  plan: MealPlan;
  /** Suggest only: set when a re-suggest changed nothing (library too small to vary). */
  note?: string;
}
export interface PlanAskResponse { ts: string; ok: boolean; reason?: string; candidateIds: string[]; note?: string }
/** POST /plan/request candidate (docs/46 §1c): a scored recipe + a short human reason. */
export interface PlanRequestCandidate { recipe: RecipeSlim; why: string }
export interface PlanRequestResponse { ts: string; ok: boolean; aiUsed: boolean; candidates: PlanRequestCandidate[] }
export interface StaplesResponse { ts: string; staples: StaplesItem[] }
export interface OrderDraftResponse { ts: string; draft: OrderDraft }
export interface OrderHistoryResponse { ts: string; history: OrderHistoryEntry[] }
export interface ChecklistResponse { ts: string; ok: boolean; text: string; entry: OrderHistoryEntry }
export interface KitchenSearchResponse { ts: string; available: boolean; products: KitchenProductHit[] }
export interface KitchenPickResponse { ts: string; entry: unknown; draft: OrderDraft }
export interface KitchenHouseholdResponse { ts: string; household: KitchenHousehold }
export interface KitchenRemindersResponse { ts: string; reminders: KitchenReminders }
export interface KitchenIntelligenceResponse { ts: string; intelligence: KitchenIntelligence }
export interface MercadonaAccountResponse { ts: string; account: MercadonaAccountStatus }
export interface MercadonaLinkResponse { ts: string; ok: boolean; account: MercadonaAccountStatus }
export interface KitchenSlotsResponse { ts: string; linked: boolean; available: boolean; slots: MercadonaSlot[] }
export interface KitchenSuggestionActionResponse { ts: string; draft: OrderDraft; suppressed: boolean }
export interface KitchenOrderSyncResponse {
  ts: string;
  checked: boolean;
  matched: boolean;
  order?: { id: string; slotStart: string | null; slotEnd: string | null; totalEur: number | null };
  draft: OrderDraft;
}
export interface KitchenRegularsResponse { ts: string; linked: boolean; available: boolean; products: KitchenRegularHit[] }

/* ---- Kitchen Hub P3 (docs/42): cooked feedback · what-can-I-make ---- */

export type CookedRating = 'up' | 'meh' | 'down';
export interface KitchenCookedResponse { ts: string; recipe: Recipe }

/** Deterministic ingredient-coverage hit ("7 of 9 on hand"). */
export interface WhatCanIMakeResult {
  recipeId: string;
  have: number;
  total: number;
  matchedFresh: number;
  missing: string[];
}
export interface WhatCanIMakeResponse { ts: string; results: WhatCanIMakeResult[] }
export interface WhatCanIMakeIdeasResponse {
  ts: string;
  ok: boolean;
  reason?: 'intelligence-off' | 'no-ideas';
  ideas: Array<{ title: string; note: string }>;
}
/** AI free-form answer: cited library recipes + fresh off-library ideas (P3, docs/42). */
export interface WhatCanIMakeAnswerResponse {
  ts: string;
  ok: boolean;
  reason?: 'intelligence-off' | 'no-answer';
  libraryIds: string[];
  ideas: Array<{ title: string; note: string }>;
}

/**
 * AI-generated candidate recipes (docs/43): COMPLETE structured recipes (source:'ai',
 * temporary gen_<n> ids, unsaved) the owner saves into the library via createRecipe. Fails
 * soft to ok:false / empty recipes when Intelligence is off or generation fails.
 */
export interface GenerateRecipesResponse {
  ts: string;
  ok: boolean;
  reason?: 'intelligence-off' | 'no-recipes';
  cached?: boolean;
  recipes: Recipe[];
}

/* ---- Bulk recipe-library generation (docs/46 P2 §2c) — admin only ---- */

export interface LibraryGenerationJob {
  status: 'idle' | 'running' | 'done' | 'error' | 'cancelled';
  target: number;
  capEur: number;
  startedAt: string | null;
  updatedAt: string;
  batchIds: string[];
  queued: number;
  insertedCount: number;
  duplicateCount: number;
  failedCount: number;
  spentEur: number;
  error: string | null;
  /** Self-filling target (docs/47 §3a) — 0 = auto-fill disabled. */
  autoTarget: number;
  monthlyBudgetEur: number;
}

export interface LibraryPhotoCoverage {
  total: number;
  /** Durably cached (local, served from /api/kitchen/photos/:id, or a bundled seed). */
  cached: number;
  /** Has a photo, but it's still a remote hotlink (provider or og:image) not yet cached. */
  linked: number;
  provider: 'pexels' | 'commons+openverse';
  pexelsConfigured: boolean;
  pexelsWouldHelp: boolean;
}

export interface LibraryGenerateStatusResponse {
  ts: string;
  job: LibraryGenerationJob;
  libraryCount: number;
  configured: boolean;
  autoIdleReason: string | null;
  photos: LibraryPhotoCoverage;
}

export interface LibraryGenerateStartResponse extends LibraryGenerateStatusResponse {
  ok: boolean;
  reason?: string;
}

/* ============================================================================
 * Water (docs/51) — BI-WATER / Contazara CZ3000 NB-IoT meter. Attribution-first:
 * every litre the meter measures is split into irrigation (reconciled against
 * logged Rain Bird zone sessions) / household / unexplained — unexplained litres
 * are the product. Reads any-authed; Settings writes are admin. Mirrors the
 * contract in apps/api/src/routes/water.ts (built by a separate agent — the
 * inner shapes of `thresholds`/`tariff` aren't spelled out in the contract, so
 * they're defined here to the shape the Settings/Alerts tabs need).
 * ==========================================================================*/

export interface WaterMeter {
  serial: string;
  model: string;
  address: string;
  indexL: number;
  lastReadingIso: string | null;
  /** Hours since the meter last reported — the connector is a ~daily-upload feed,
   *  not live, so this (not a green dot) is the honest freshness signal. */
  staleHours: number | null;
}

/** One hour of GET /api/water `today.hours` — the meter's own hourly buckets. */
export interface WaterHourBucket {
  h: number; // 0–23
  totalL: number;
  householdL: number;
  irrigationL: number;
  unexplainedL: number;
  /** False for hours the meter hasn't uploaded yet (hourly-read, ~daily-upload cadence). */
  reported: boolean;
}

export interface WaterToday {
  dateIso: string;
  totalL: number;
  householdL: number;
  irrigationL: number;
  unexplainedL: number;
  hours: WaterHourBucket[];
}

/** The leak detector's core signal (docs/51 §1): the lowest single-hour reading
 *  in the rolling 24h window. A healthy house hits ~0 at some point every night;
 *  a leaking one has a floor that never clears. */
export interface WaterQuietHour {
  lowestLph: number;
  atHour: number | null;
  hoursSinceBelowFloor: number | null;
  floorLph: number;
  ok: boolean;
}

export interface WaterMonth {
  m3: number;
  householdM3: number;
  irrigationM3: number;
  unexplainedM3: number;
  expectedM3: number;
  costEur: number;
  budgetM3: number;
  projectedM3: number;
}

/** A Rain Bird zone's learned flow rate, from hours where exactly one zone ran
 *  alone (docs/51 §3 P2). `learned=false` means it's still the configured default. */
export interface WaterZoneAttribution {
  id: string;
  name: string;
  lpm: number;
  samples: number;
  learned: boolean;
}

export type WaterAlertSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface WaterActiveAlert {
  id: string;
  rule: string;
  severity: WaterAlertSeverity;
  title: string;
  sub: string;
  sinceIso: string;
}

export interface WaterResponse {
  ts: string;
  /** False until credentials are saved in Settings — the owner hasn't connected
   *  yet, so this is the state the app is actually in on first deploy. */
  configured: boolean;
  connected: boolean;
  lastError: string | null;
  meter: WaterMeter | null;
  today: WaterToday;
  quietHour: WaterQuietHour;
  month: WaterMonth;
  zones: WaterZoneAttribution[];
  activeAlerts: WaterActiveAlert[];
}

export type WaterHistoryRange = 'day' | 'week' | 'month' | 'year';

/** Fixed stack order irrigation -> household -> unexplained (index.css comment) —
 *  keep every consumer of this series in that order. */
export interface WaterHistorySeries {
  total: number[];
  household: number[];
  irrigation: number[];
  unexplained: number[];
}

/** Cumulative "measured vs accounted for" curve for the Overview chart. */
export interface WaterCumulative {
  actual: number[];
  expected: number[];
}

export interface WaterDayparts {
  night: number[];
  morning: number[];
  afternoon: number[];
  evening: number[];
}

export interface WaterHistoryTotals {
  totalL: number;
  householdL: number;
  irrigationL: number;
  unexplainedL: number;
  costEur: number;
}

export interface WaterHistoryResponse {
  ts: string;
  range: WaterHistoryRange;
  offset: number;
  label: string;
  labels: string[];
  series: WaterHistorySeries;
  cumulative: WaterCumulative;
  dayparts: WaterDayparts;
  nightBaseline: number[];
  totals: WaterHistoryTotals;
}

/** Detection-rule thresholds (docs/51 §3 P2's five detectors), each independently
 *  enable-able — the Alerts tab's per-rule switches read/write this object. */
/* Mirrors WaterThresholds in apps/api/src/store.ts — keep the two in step.
 * Flat, with no per-detector `enabled` flag: enable/disable already lives in the
 * `rule-water-*` entries in RULE_META (routes/alerts.ts), so duplicating it here
 * would give one switch two sources of truth. */
export interface WaterThresholds {
  /** Hourly litres floor below which a house counts as "quiet" at least once a night. */
  quietHourFloorLph: number;
  /** Consecutive hours the floor must stay uncrossed before the leak alert fires. */
  continuousFlowHours: number;
  /** Night-slot (00:00–05:59) litres, AFTER subtracting attributed irrigation. */
  nightToleranceL: number;
  monthlyBudgetM3: number;
  dailySpikeFactor: number;
  meterSilentHours: number;
}

/** Spain/AMJASA tariff (docs/51 §3 P3) — every default is a placeholder pending
 *  a real bill (docs/51 D5); the Settings tab labels cost figures as estimates. */
export interface WaterTariff {
  fixedEurMonth: number;
  block1: { upToM3: number; eurM3: number };
  block2: { upToM3: number; eurM3: number };
  /** The top/marginal block — what a leak actually costs. */
  block3: { eurM3: number };
  sewerEurM3: number;
  canonEurM3: number;
  ivaPct: number;
}

export interface WaterSettingsResponse {
  ts: string;
  configured: boolean;
  connected: boolean;
  hasPassword: boolean;
  email: string;
  serial: string;
  pollHours: number;
  thresholds: WaterThresholds;
  tariff: WaterTariff;
}

/** PATCH-style save body — all fields optional, password omitted keeps the
 *  stored one (same convention as RainbirdConnection/setSonnen/etc). */
export type WaterSettingsPatch = Partial<{
  email: string;
  password: string;
  serial: string;
  pollHours: number;
  thresholds: Partial<WaterThresholds>;
  tariff: Partial<Omit<WaterTariff, 'block1' | 'block2' | 'block3'>> & {
    block1?: Partial<WaterTariff['block1']>;
    block2?: Partial<WaterTariff['block2']>;
    block3?: Partial<WaterTariff['block3']>;
  };
}>;

export interface WaterSettingsSaveResponse {
  ok: boolean;
  detail: string;
}

/** POST /api/integrations/water(/test) — same ProbeResult shape as every other
 *  connector, plus an optional meter probe echo on success. */
export interface WaterIntegrationTestResponse {
  ok: boolean;
  detail: string;
  meter?: { serial: string; indexL: number } | null;
}
