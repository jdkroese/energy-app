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

export interface ControlState {
  /** Master safety switch — DISARMED by default; nothing is ever written until armed. */
  armed: boolean;
  mode: ControlMode;
  updatedAt: number;
  lastError: string | null;
  /** Ring buffer of the last 100 control actions. */
  log: ControlLogEntry[];
  guardrails: ControlGuardrails;
}

// ---- Devices / Climate ------------------------------------------------------
// A generic devices layer; AC (Intesis/Panasonic Etherea) is the first type. The
// store holds: integration creds, per-device user settings, schedules, automations,
// climate guardrails, a master arm flag, and a ring-buffer command log. Like the
// battery control, devices BOOT DISARMED — nothing is ever written until armed.

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
}

/** Per-device user-facing settings, merged onto the connector's normalized view. */
export interface DeviceSettings {
  /** Friendly room override (falls back to the device's reported zone/name). */
  room?: string;
  /** Whether automations may command this device. */
  automationEnabled: boolean;
  /** Hard comfort bounds for automations (°C). */
  comfortCeilingC?: number;
  comfortFloorC?: number;
}

export type ClimateMode = 'auto' | 'heat' | 'dry' | 'fan' | 'cool';

export interface Schedule {
  id: string;
  name: string;
  enabled: boolean;
  scope: { deviceIds: string[] };
  /** Days of week the schedule runs on (0=Sun..6=Sat). */
  days: number[];
  /** Local "HH:MM" start/end. */
  start: string;
  end: string;
  mode: ClimateMode;
  setpointC: number;
  fan?: number;
  /**
   * Optional condition: only apply this schedule to a device when its room
   * temperature is ABOVE this (°C). null/undefined = no condition (always apply
   * during the window). So "cool 24° 18:00–23:00, only if room > 26°" won't run
   * the AC on a cool evening.
   */
  roomTempAboveC?: number | null;
}

export type AutomationType = 'solar_surplus_precool';
export type AutomationAuthority = 'shadow' | 'auto';

export interface SolarSurplusPrecoolParams {
  /** Run cooling when a room is above this (°C). */
  roomTempLimitC: number;
  /** Target setpoint to drive the room toward (°C). */
  targetSetpointC: number;
  /** Stop only after surplus has cleared for this long (s). */
  surplusClearSec: number;
  /** Whether the tariff-band stand-down applies at all. Default true (undefined ⇒ on). */
  bandRestrictionEnabled?: boolean;
  /** Band at which automation stands down when bandRestrictionEnabled (P1 peak). */
  exitBand: Band;
  /** Surplus (W) above which a compressor start is permitted. */
  startThresholdW?: number;
}

export interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  type: AutomationType;
  authority: AutomationAuthority;
  params: SolarSurplusPrecoolParams;
  /** Epoch ms of the last coordinator evaluation. */
  lastEval: number | null;
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
  devices: DevicesState;
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
  };
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
  };
}

/** The flagship automation, seeded disabled + shadow so it never acts until armed. */
export function defaultAutomations(): Automation[] {
  return [
    {
      id: 'solar-surplus-precool',
      name: 'Solar-surplus pre-cool',
      enabled: false,
      type: 'solar_surplus_precool',
      authority: 'shadow',
      params: {
        roomTempLimitC: 25,
        targetSetpointC: 23,
        surplusClearSec: 120,
        bandRestrictionEnabled: true,
        exitBand: 'P1',
        startThresholdW: 800,
      },
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
    devices: defaultDevices(),
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
  // repoRoot = two levels up from apps/api/src.
  const repoRoot = resolve(__dirname, '..', '..', '..');
  return resolve(repoRoot, '.data', 'state.json');
}

// ---- Load / persist -----------------------------------------------------

let cache: StoreSchema | null = null;
let path: string | null = null;

function file(): string {
  if (!path) path = statePath();
  return path;
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
    },
    deviceSettings:
      p.deviceSettings && typeof p.deviceSettings === 'object'
        ? p.deviceSettings
        : base.deviceSettings,
    schedules: Array.isArray(p.schedules) ? p.schedules : base.schedules,
    automations:
      Array.isArray(p.automations) && p.automations.length ? p.automations : base.automations,
    devices: hydrateDevices(p.devices, base.devices),
  };
}

/**
 * Rehydrate the devices/climate section. SAFETY: a fresh process always boots
 * DISARMED in mode 'off' regardless of what was persisted — the climate
 * coordinator must never resume issuing commands without an explicit re-arm.
 */
function hydrateDevices(p: Partial<DevicesState> | undefined, base: DevicesState): DevicesState {
  if (!p || typeof p !== 'object') return base;
  return {
    armed: false,
    mode: 'off',
    updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : base.updatedAt,
    lastError: typeof p.lastError === 'string' ? p.lastError : null,
    log: Array.isArray(p.log) ? p.log.slice(-100) : base.log,
    guardrails: {
      ...base.guardrails,
      ...(p.guardrails ?? {}),
    },
    manualOverrides:
      p.manualOverrides && typeof p.manualOverrides === 'object' ? p.manualOverrides : {},
  };
}

/**
 * Rehydrate the control section. SAFETY: a fresh process always boots DISARMED in
 * mode 'off' regardless of what was persisted — the coordinator must never resume
 * issuing commands without an explicit re-arm. Guardrails + log are preserved.
 */
function hydrateControl(p: Partial<ControlState> | undefined, base: ControlState): ControlState {
  if (!p || typeof p !== 'object') return base;
  return {
    armed: false,
    mode: 'off',
    updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : base.updatedAt,
    lastError: typeof p.lastError === 'string' ? p.lastError : null,
    log: Array.isArray(p.log) ? p.log.slice(-100) : base.log,
    guardrails: { ...base.guardrails, ...(p.guardrails ?? {}) },
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
