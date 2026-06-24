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
