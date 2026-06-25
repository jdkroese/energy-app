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
  day: { solarKw: number[]; homeKw: number[] };
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
  series: { prod: number[]; cons: number[]; labels: string[] };
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
  h: number;
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
  };
  forecast: { solarKw: number[]; loadKw: number[] };
  socPct: number[];
  tariff: number[];
  actions: PlanAction[];
  now: number;
  whyNow: { title: string; body: string };
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

export interface ControlStatus {
  armed: boolean;
  mode: ControlMode;
  lastError: string | null;
  current: ControlCurrent;
  guardrails: ControlGuardrails;
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
export type ClimateLever = 'power' | 'mode' | 'setpoint' | 'fan';
export type DeviceWarmth = 'cold' | 'cool' | 'comfortable' | 'warm' | 'hot' | 'unknown';

export interface DeviceView {
  id: string;
  name: string;
  zone?: string;
  installation?: string;
  power: boolean;
  mode: string;
  setpointC: number | null;
  currentTempC: number | null;
  minSetpointC: number | null;
  maxSetpointC: number | null;
  online: boolean;
  room: string;
  automationEnabled: boolean;
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
  quietHours: { start: string; end: string };
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

export interface Schedule {
  id: string;
  name: string;
  enabled: boolean;
  scope: { deviceIds: string[] };
  days: number[];
  start: string;
  end: string;
  mode: ClimateMode;
  setpointC: number;
  fan?: number;
}

export interface SchedulesResponse {
  ts: string;
  schedules: Schedule[];
}

export type AutomationAuthority = 'shadow' | 'auto';

export interface SolarSurplusPrecoolParams {
  roomTempLimitC: number;
  targetSetpointC: number;
  surplusClearSec: number;
  exitBand: Band;
  startThresholdW?: number;
}

export interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  type: 'solar_surplus_precool';
  authority: AutomationAuthority;
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
