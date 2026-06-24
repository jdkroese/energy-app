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

export interface SettingsResponse {
  ts: string;
  connections: { name: string; icon: string; tone: string; status: string; detail: string }[];
  tariff: {
    bands: { band: Band; rate: number }[];
    powerTermEur: number;
    exportRange: string;
  };
  assets: { name: string; icon: string; tone: string; detail: string }[];
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
  scenarios: Scenario[];
}

export interface ScenarioPreview {
  selfSufficiencyPct: number;
  savedPerDayEur: number;
  backupHours: number;
}
