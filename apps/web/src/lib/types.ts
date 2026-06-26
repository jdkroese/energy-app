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
  tariff: { band: Band; rateEur: number; nextBand: Band; minsToNext: number };
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

export interface SettingsResponse {
  ts: string;
  connections: { name: string; icon: string; tone: string; status: string; detail: string }[];
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

export interface ControlStatus {
  armed: boolean;
  mode: ControlMode;
  lastError: string | null;
  current: ControlCurrent;
  guardrails: ControlGuardrails;
  batteryPriority: BatteryPriority;
  log: ControlLogEntry[];
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
export type DeviceType = 'cooling' | 'heating' | 'lighting' | 'circuit' | 'blinds';

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
  automationEnabled: boolean;
  /** Epoch ms a manual-control hold expires on this unit, or null if none active. */
  manualOverrideUntil: number | null;
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

export interface SolarSurplusPrecoolParams {
  /** Comfort limit (°C): cooling runs while room > limit; heating while room < limit. */
  roomTempLimitC: number;
  targetSetpointC: number;
  surplusClearSec: number;
  /** Whether the tariff-band stand-down applies at all. Default true (undefined ⇒ on). */
  bandRestrictionEnabled?: boolean;
  exitBand: Band;
  startThresholdW?: number;
}

export interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  type: 'solar_surplus_precool' | 'solar_surplus_preheat';
  params: SolarSurplusPrecoolParams;
  lastEval: number | null;
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
  offTime?: string | null;
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
