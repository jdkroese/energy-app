/**
 * Mock data mirroring the mockups' constants. Used as a graceful fallback when
 * the API isn't reachable yet, so every screen renders faithfully. Once the
 * backend is live, real data replaces these via keep-last-good polling.
 */
import type {
  AlertsResponse,
  BatteriesResponse,
  BrainPlanResponse,
  DayChartForecast,
  DayChartSeries,
  HistoryDayResponse,
  HistoryResponse,
  LiveResponse,
  ScenariosResponse,
  SettingsResponse,
  WaterResponse,
  WaterHistoryResponse,
  WaterSettingsResponse,
} from './types';

function series(n: number, base: number, amp: number, seed: number): number[] {
  let s = seed || 1;
  const r = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  const o: number[] = [];
  for (let i = 0; i < n; i++) {
    const d = Math.sin((i / n) * Math.PI);
    o.push(Math.max(0, base + d * amp + (r() - 0.5) * amp * 0.3));
  }
  return o;
}
const solarDay = series(24, 0.2, 9.6, 7).map((v, i) => (i < 7 || i > 21 ? 0 : v));
const homeDay = series(24, 0.7, 2.6, 13);

// SoC-over-day curves: rise through the solar midday, drain through the P1 evening.
const sonnenSoc = [44, 40, 36, 33, 31, 30, 32, 41, 58, 76, 90, 98, 100, 100, 100, 98, 94, 86, 70, 56, 52, 50, 48, 46];
const teslaSoc = [62, 58, 54, 51, 49, 48, 49, 55, 68, 82, 92, 98, 100, 100, 100, 99, 96, 90, 78, 64, 58, 56, 54, 52];
const sonnenCharge = [0, 0, 0, 0, 0, 0, 0, 0.6, 2.1, 3.4, 4.1, 3.2, 1.4, 0.4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const sonnenDischarge = [0.3, 0.3, 0.2, 0.2, 0.2, 0.3, 0.4, 0, 0, 0, 0, 0, 0, 0, 0.3, 0.6, 0.9, 1.4, 2.6, 1.8, 0.6, 0.4, 0.3, 0.3];
const teslaCharge = [0, 0, 0, 0, 0, 0, 0, 0.8, 3.1, 5.2, 6.4, 4.8, 2.2, 0.6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const teslaDischarge = [0.5, 0.4, 0.4, 0.4, 0.4, 0.5, 0.6, 0, 0, 0, 0, 0, 0, 0, 0.4, 0.9, 1.6, 2.8, 4.4, 3.2, 1.1, 0.7, 0.5, 0.4];
// Combined fill weighted by usable capacity (Sonnen 9.2 kWh + Tesla 27 kWh).
const combinedSocDay = sonnenSoc.map((sv, i) => Math.round((sv * 9.2 + teslaSoc[i] * 27) / 36.2));
const chargeDay = sonnenCharge.map((v, i) => Math.round((v + teslaCharge[i]) * 100) / 100);
const dischargeDay = sonnenDischarge.map((v, i) => Math.round((v + teslaDischarge[i]) * 100) / 100);
const gridExportDay = [0, 0, 0, 0, 0, 0, 0, 0, 1.2, 3.5, 5.1, 4.2, 2.1, 0.6, 0.2, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const gridImportDay = [0.4, 0.4, 0.3, 0.3, 0.3, 0.4, 0.5, 0.3, 0, 0, 0, 0, 0, 0, 0, 0, 0.2, 0.5, 0.8, 0.6, 0.5, 0.4, 0.4, 0.4];
const nowHourLocal = (() => {
  const n = new Date();
  return Math.round((n.getHours() + n.getMinutes() / 60) * 100) / 100;
})();

export const MOCK_LIVE: LiveResponse = {
  ts: new Date().toISOString(),
  solar: {
    kw: 11.1,
    arrays: [
      { name: 'Solar Inverter 1', kw: 4.9 },
      { name: 'Solar Inverter 2', kw: 4.2 },
      { name: 'Tesla', kw: 2.0 },
    ],
  },
  home: { kw: 5.5 },
  grid: { kw: 5.56, dir: 'exporting' },
  sonnen: { soc: 100, kwh: 9.2, kw: 0, dir: 'idle' },
  tesla: { soc: 100, kwh: 27, kw: 0, dir: 'idle', reservePct: 20, backupKwh: 27, backupHours: 16, island: false },
  tariff: { band: 'P2', rateEur: 0.131, nextBand: 'P1', minsToNext: 72 },
  breaker: { id: 'mock-breaker', name: 'Main breaker', voltageV: 231, currentA: 12.4, powerW: 2860 },
  today: { producedKwh: 42.3, consumedKwh: 28.6, gridFeedInKwh: 18.4, selfSufficiencyPct: 71, savedEur: 5.4 },
  day: {
    solarKw: solarDay,
    homeKw: homeDay,
    chargeKw: chargeDay,
    dischargeKw: dischargeDay,
    gridImportKw: gridImportDay,
    gridExportKw: gridExportDay,
    sonnenSoc,
    teslaSoc,
    combinedSoc: combinedSocDay,
    nowHour: nowHourLocal,
  },
};

/* ---- Live day chart (5-min, 288 buckets) ---------------------------------
 * Expand the 24-hour mock day arrays to 288 buckets by linear interpolation so
 * the new DayChart has a faithful fallback when the API isn't reachable. */
function to288(hourly: number[]): number[] {
  const out = new Array<number>(288).fill(0);
  for (let i = 0; i < 288; i++) {
    const h = i / 12;
    const h0 = Math.floor(h);
    const h1 = Math.min(23, h0 + 1);
    const frac = h - h0;
    const a = hourly[h0] ?? 0;
    const b = hourly[h1] ?? a;
    out[i] = Math.round((a + (b - a) * frac) * 100) / 100;
  }
  return out;
}

const mockNowIndex = (() => {
  const n = new Date();
  return Math.min(287, n.getHours() * 12 + Math.floor(n.getMinutes() / 5));
})();

const mockDaySeries: DayChartSeries = {
  solarKw: to288(solarDay),
  homeKw: to288(homeDay),
  chargeKw: to288(chargeDay),
  dischargeKw: to288(dischargeDay),
  gridImportKw: to288(gridImportDay),
  gridExportKw: to288(gridExportDay),
  sonnenSoc: to288(sonnenSoc).map((v) => Math.round(v)),
  teslaSoc: to288(teslaSoc).map((v) => Math.round(v)),
  combinedSoc: to288(combinedSocDay).map((v) => Math.round(v)),
};

// Measured = up to now; forecast = from now onward (null before).
const mockMeasured: DayChartSeries = {
  solarKw: mockDaySeries.solarKw.map((v, i) => (i <= mockNowIndex ? v : 0)),
  homeKw: mockDaySeries.homeKw.map((v, i) => (i <= mockNowIndex ? v : 0)),
  chargeKw: mockDaySeries.chargeKw.map((v, i) => (i <= mockNowIndex ? v : 0)),
  dischargeKw: mockDaySeries.dischargeKw.map((v, i) => (i <= mockNowIndex ? v : 0)),
  gridImportKw: mockDaySeries.gridImportKw.map((v, i) => (i <= mockNowIndex ? v : 0)),
  gridExportKw: mockDaySeries.gridExportKw.map((v, i) => (i <= mockNowIndex ? v : 0)),
  sonnenSoc: mockDaySeries.sonnenSoc.map((v, i) => (i <= mockNowIndex ? v : 0)),
  teslaSoc: mockDaySeries.teslaSoc.map((v, i) => (i <= mockNowIndex ? v : 0)),
  combinedSoc: mockDaySeries.combinedSoc.map((v, i) => (i <= mockNowIndex ? v : 0)),
};

const fcOnward = (arr: number[]): (number | null)[] =>
  arr.map((v, i) => (i >= mockNowIndex ? v : null));

const mockForecast: DayChartForecast = {
  solarKw: fcOnward(mockDaySeries.solarKw),
  homeKw: fcOnward(mockDaySeries.homeKw),
  chargeKw: mockDaySeries.chargeKw.map(() => null),
  dischargeKw: mockDaySeries.dischargeKw.map(() => null),
  gridImportKw: mockDaySeries.gridImportKw.map(() => null),
  gridExportKw: mockDaySeries.gridExportKw.map(() => null),
  sonnenSoc: mockDaySeries.sonnenSoc.map(() => null),
  teslaSoc: mockDaySeries.teslaSoc.map(() => null),
  combinedSoc: fcOnward(mockDaySeries.combinedSoc),
};

export const MOCK_HISTORY_DAY: HistoryDayResponse = {
  date: nowHourLocal >= 0 ? new Date().toISOString().slice(0, 10) : '',
  offset: 0,
  nowIndex: mockNowIndex,
  series: mockMeasured,
  forecast: mockForecast,
  tariffBands: [
    { startH: 0, endH: 8, band: 'P3' },
    { startH: 8, endH: 10, band: 'P2' },
    { startH: 10, endH: 14, band: 'P1' },
    { startH: 14, endH: 18, band: 'P2' },
    { startH: 18, endH: 22, band: 'P1' },
    { startH: 22, endH: 24, band: 'P2' },
  ],
  hasPrev: true,
  hasNext: false,
};

export const MOCK_BATTERIES: BatteriesResponse = {
  ts: new Date().toISOString(),
  combined: { usableKwh: 36.2, storedKwh: 33.4, soc: 92 },
  batteries: [
    {
      id: 'sonnen',
      name: 'Sonnen',
      vendor: 'sonnenBatterie · eco',
      role: 'Self-consumption actuator',
      online: true,
      soc: 100,
      kwh: 9.2,
      usableKwh: 9.2,
      nominalKwh: 11,
      power: { kw: 0, dir: 'idle' },
      maxKw: 4.6,
      mode: 'self consumption',
      hasBackup: false,
      reservePct: null,
      backupKwh: null,
      backupHours: null,
      island: null,
      stormMode: null,
      exportRule: null,
      gridChargeAllowed: null,
      headroomKwh: 0,
      aboveReserveKwh: null,
      health: 96,
      capacityKwh: 10.6,
      cyclesTotal: 1240,
      throughputKwh: 13150,
      roundTripPct: 90,
      tempC: 27,
      warrantyPct: 84,
      installedYear: 2021,
      todayInKwh: 14.8,
      todayOutKwh: 9.6,
      socDay: sonnenSoc,
      chargeKwDay: sonnenCharge,
      dischargeKwDay: sonnenDischarge,
      specs: [
        { label: 'Type', value: 'sonnenBatterie eco' },
        { label: 'Chemistry', value: 'LFP (LiFePO₄)' },
        { label: 'Usable capacity', value: '9.2 kWh' },
        { label: 'Nominal capacity', value: '11 kWh' },
        { label: 'Max power', value: '4.6 kW' },
        { label: 'Backup module', value: 'Not installed' },
        { label: 'Connection', value: 'Local API · VPN' },
        { label: 'Role', value: 'Fast self-consumption actuator' },
      ],
    },
    {
      id: 'tesla',
      name: 'Tesla Powerwall',
      vendor: 'Tesla · 2× Powerwall 3',
      role: 'Backup + policy',
      online: true,
      soc: 100,
      kwh: 27,
      usableKwh: 27,
      nominalKwh: 27,
      power: { kw: 0, dir: 'idle' },
      maxKw: 10,
      mode: 'self consumption',
      hasBackup: true,
      reservePct: 20,
      backupKwh: 21.6,
      backupHours: 16,
      island: false,
      stormMode: false,
      exportRule: 'pv only',
      gridChargeAllowed: false,
      headroomKwh: 0,
      aboveReserveKwh: 21.6,
      health: 98,
      capacityKwh: 26.5,
      cyclesTotal: 410,
      throughputKwh: 11070,
      roundTripPct: 89,
      tempC: 29,
      warrantyPct: 96,
      installedYear: 2024,
      todayInKwh: 22.4,
      todayOutKwh: 15.1,
      socDay: teslaSoc,
      chargeKwDay: teslaCharge,
      dischargeKwDay: teslaDischarge,
      specs: [
        { label: 'Type', value: '2× Powerwall 3' },
        { label: 'Chemistry', value: 'NMC' },
        { label: 'Usable capacity', value: '27 kWh' },
        { label: 'Max power', value: '10 kW' },
        { label: 'Backup', value: 'Whole-home · islanding' },
        { label: 'Export rule', value: 'pv only' },
        { label: 'Connection', value: 'Fleet API · cloud' },
        { label: 'Role', value: 'Holds backup reserve + policy' },
      ],
    },
  ],
};

export const MOCK_HISTORY: HistoryResponse = {
  ts: new Date().toISOString(),
  offset: 0,
  isCurrent: true,
  hasPrev: true,
  hasNext: false,
  periodLabel: null,
  totals: { producedKwh: 1050, consumedKwh: 444, exportedKwh: 625, selfSufficiencyPct: 71, savedEur: 84, co2Kg: 412 },
  solarValue: { selfUsedPct: 68, exportedKwh: 625, exportEur: 13.72, worthIfSelfUsedEur: 131 },
  byBand: [
    { band: 'P1', kwh: 35, eur: 6.8, rate: 0.209 },
    { band: 'P2', kwh: 77, eur: 9.88, rate: 0.131 },
    { band: 'P3', kwh: 332, eur: 31.42, rate: 0.096 },
  ],
  powerTermEur: 36.19,
  series: {
    prod: [268, 241, 290, 251],
    cons: [104, 118, 96, 126],
    labels: ['W1', 'W2', 'W3', 'W4'],
    // Real per-bucket grid import split by band (kWh); sums ≈ byBand totals above.
    bandKwh: {
      P1: [9, 9, 8, 9],
      P2: [19, 20, 18, 20],
      P3: [82, 84, 80, 86],
    },
  },
  byLoad: [
    { name: 'Heat pump + floor', icon: 'thermometer', tone: 'var(--grid)', kwh: 128, pct: 34 },
    { name: 'A/C cooling', icon: 'wind', tone: 'var(--battery)', kwh: 79, pct: 21 },
    { name: 'EV · 2× BMW i3', icon: 'plug-zap', tone: 'var(--ev)', kwh: 71, pct: 19 },
    { name: 'Water heating', icon: 'droplet', tone: 'var(--home)', kwh: 45, pct: 12 },
    { name: 'Appliances', icon: 'washing-machine', tone: 'var(--solar)', kwh: 34, pct: 9 },
    { name: 'Lighting & other', icon: 'lightbulb', tone: 'var(--text-2)', kwh: 19, pct: 5 },
  ],
};

export const MOCK_ALERTS: AlertsResponse = {
  ts: new Date().toISOString(),
  alerts: [
    { id: '1', severity: 'danger', icon: 'power', title: 'Tesla Powerwall powered off', sub: 'Powerwall · voltage fluctuation', device: 'Tesla', ts: '12 min ago', status: 'new' },
    { id: '2', severity: 'warning', icon: 'battery-warning', title: 'Backup reserve low', sub: 'Tesla · 14% (target 20%)', device: 'Tesla', ts: '1h ago', status: 'new' },
    { id: '3', severity: 'warning', icon: 'plug-zap', title: 'Sonnen charging from grid', sub: 'Sonnen · drawing 3.2 kW at 100%', device: 'Sonnen', ts: '2h ago', status: 'ack' },
    { id: '4', severity: 'info', icon: 'cloud-sun', title: 'Overnight charge planned', sub: 'Optimizer · dull day tomorrow', device: 'Optimizer', ts: '3h ago', status: 'new' },
    { id: '5', severity: 'ok', icon: 'circle-check', title: 'Tesla reconnected', sub: 'Powerwall · back online', device: 'Tesla', ts: 'Yesterday', status: 'resolved' },
    { id: '6', severity: 'warning', icon: 'wifi-off', title: 'Sungrow inverter offline', sub: 'Array A · no response 20 min', device: 'Sungrow', ts: 'Yesterday', status: 'resolved' },
  ],
  channels: [
    { type: 'WhatsApp', detail: '+34 ··· ··· 89', enabled: true },
    { type: 'Push notifications', detail: 'This iPhone · installed', enabled: true },
    { type: 'Email', detail: 'j.kroese@levante.nl', enabled: false },
  ],
  rules: [
    { id: 'r1', icon: 'power', label: 'Tesla power-off / dropout', enabled: true },
    { id: 'r2', icon: 'battery-warning', label: 'Backup reserve below 15%', enabled: true },
    { id: 'r3', icon: 'triangle-alert', label: 'Sonnen fault or alarm', enabled: true },
    { id: 'r4', icon: 'plug-zap', label: 'Abnormal grid-charging', enabled: true },
    { id: 'r5', icon: 'cloud-sun', label: 'Optimizer notices', enabled: false },
  ],
};

export const MOCK_SETTINGS: SettingsResponse = {
  ts: new Date().toISOString(),
  connections: [
    { name: 'Tesla Fleet API', icon: 'cloud', tone: 'cloud', status: 'Connected', detail: '' },
    { name: 'Sonnen local API', icon: 'battery-charging', tone: 'battery', status: 'Connected · VPN', detail: '' },
    { name: 'Weather · Jávea', icon: 'cloud-sun', tone: 'grid', status: 'Open-Meteo', detail: '' },
    { name: 'Sungrow inverters', icon: 'sun', tone: 'home', status: 'Pending', detail: '' },
  ],
  tariff: {
    bands: [
      { band: 'P1', rate: 0.209 },
      { band: 'P2', rate: 0.131 },
      { band: 'P3', rate: 0.096 },
    ],
    powerTermEur: 36.19,
    exportRange: '€0.003–0.029',
  },
  assets: [
    { name: 'Sonnen battery', icon: 'battery-charging', tone: 'battery', detail: '11 kWh · 4.6 kW' },
    { name: 'Tesla · 2× Powerwall 3', icon: 'battery-charging', tone: 'battery', detail: '27 kWh · backup' },
    { name: 'Solar · 2 arrays', icon: 'sun', tone: 'solar', detail: '18.2 kWp' },
    { name: 'EV · 2× BMW i3', icon: 'plug-zap', tone: 'ev', detail: '~42 kWh each' },
    { name: 'Heat pump + A/C', icon: 'thermometer', tone: 'grid', detail: 'all-electric' },
    { name: 'Grid connection', icon: 'utility-pole', tone: 'grid', detail: '1-phase · 14 kW' },
  ],
  channels: {
    whatsapp: { number: '+34 600 123 489', enabled: true },
    push: { enabled: true },
    email: { address: 'j.kroese@levante.nl', enabled: false },
  },
};

export const MOCK_PLAN: BrainPlanResponse = {
  ts: new Date().toISOString(),
  projected: { savedEur: 6.1, selfSufficiencyPct: 84, reservePct: 20, p1AvoidedKwh: 11.2, freeClimatizationKwh: 4.3 },
  forecast: {
    solarKw: [0, 0, 0, 0, 0, 0, 0.3, 1.5, 3.8, 6.5, 8.8, 10.2, 10.9, 11.0, 10.2, 8.6, 6.4, 4.0, 1.8, 0.4, 0, 0, 0, 0, 0],
    loadKw: [0.5, 0.4, 0.4, 0.4, 0.4, 0.5, 0.7, 1.0, 1.2, 1.4, 2.6, 3.0, 2.8, 2.4, 2.6, 2.8, 2.2, 1.8, 3.4, 3.8, 3.2, 1.6, 0.9, 0.6, 0.5],
    cloudPct: [12, 10, 8, 8, 10, 14, 18, 22, 20, 16, 12, 10, 14, 24, 30, 28, 22, 18, 16, 20, 24, 22, 18, 14, 12],
    sunIntensityPct: [0, 0, 0, 0, 0, 0, 18, 42, 64, 80, 90, 96, 100, 98, 90, 76, 58, 36, 14, 4, 0, 0, 0, 0, 0],
    genKwh: [0, 0, 0, 0, 0, 0, 0.3, 1.5, 3.8, 6.5, 8.8, 10.2, 10.9, 11.0, 10.2, 8.6, 6.4, 4.0, 1.8, 0.4, 0, 0, 0, 0, 0],
    usageKwh: [0.5, 0.4, 0.4, 0.4, 0.4, 0.5, 0.7, 1.0, 1.2, 1.4, 2.6, 3.0, 2.8, 2.4, 2.6, 2.8, 2.2, 1.8, 3.4, 3.8, 3.2, 1.6, 0.9, 0.6, 0.5],
  },
  model: { month: 'Jun', confidencePct: 55, days: 11 },
  socPct: [38, 34, 30, 28, 28, 28, 30, 42, 58, 72, 84, 92, 98, 100, 100, 100, 98, 92, 78, 58, 40, 30, 30, 32, 34],
  tariff: [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 2, 2, 1, 1, 1, 1, 2, 2, 2, 2, 1, 1],
  now: 16.8,
  actions: [
    { h: 7.5, startH: 7.5, endH: 18, icon: 'sun', tone: 'solar', title: 'Charge from surplus solar', why: 'House covered; surplus banked into both batteries instead of exporting for near-zero credit.' },
    { h: 11.0, startH: 11, endH: 18, icon: 'snowflake', tone: 'home', title: 'Pre-cool the house', why: '>31 °C forecast — A/C runs on solar now so the slab coasts cool through the evening peak.' },
    { h: 18.0, startH: 18, endH: 22, icon: 'battery-charging', tone: 'battery', title: 'Discharge through P1', why: 'Both batteries cover the house 18:00–22:00 — near-zero grid import at €0.209/kWh.' },
    { h: 0, startH: 0, endH: 24, icon: 'shield', tone: 'grid', title: 'Hold 20% reserve', why: 'Storm-free — standard Tesla backup floor kept for resilience.' },
  ],
  whyNow: {
    title: 'Holding full, banking sun',
    body: 'Both batteries are full and the slab is pre-cooled. Surplus is exporting for now — there is nowhere left to store it.',
  },
  weather: { source: 'live', cloudAvgPct: 19 },
};

export const MOCK_SCENARIOS: ScenariosResponse = {
  ts: new Date().toISOString(),
  active: 'selfuse',
  scenarios: [
    { id: 'selfuse', name: 'Max self-consumption', icon: 'leaf', active: true, weights: { save: 55, self: 90, indep: 70, comfort: 50 }, reserve: 20, dynReserve: true, gridCharge: false, exportRule: 'PV only', ev: 'Solar', precondition: true, activation: 'Auto', trigger: 'Active May–Sep, sunny days' },
    { id: 'savings', name: 'Max savings', icon: 'piggy-bank', active: false, weights: { save: 95, self: 60, indep: 40, comfort: 40 }, reserve: 15, dynReserve: false, gridCharge: true, exportRule: 'PV only', ev: 'P3 night', precondition: true, activation: 'Manual', trigger: 'You switch it on' },
    { id: 'independ', name: 'Max independence', icon: 'unplug', active: false, weights: { save: 50, self: 80, indep: 100, comfort: 45 }, reserve: 25, dynReserve: true, gridCharge: false, exportRule: 'PV only', ev: 'Solar', precondition: true, activation: 'Manual', trigger: 'You switch it on' },
    { id: 'storm', name: 'Storm / backup', icon: 'cloud-lightning', active: false, weights: { save: 30, self: 50, indep: 60, comfort: 55 }, reserve: 80, dynReserve: true, gridCharge: true, exportRule: 'Never', ev: 'Off', precondition: true, activation: 'Auto', trigger: 'Auto-activates on a storm forecast' },
    { id: 'evnight', name: 'Cheap-night EV', icon: 'plug-zap', active: false, weights: { save: 80, self: 55, indep: 45, comfort: 45 }, reserve: 18, dynReserve: false, gridCharge: true, exportRule: 'PV only', ev: 'P3 night', precondition: false, activation: 'Schedule', trigger: 'Nightly 00:00–08:00 (P3)' },
  ],
};

/* ---- Water (docs/52) — attribution-first mock, shaped by the real captured
 * August 2026 pattern: irrigation dominates (~77% of the month), a healthy quiet
 * hour clears near-zero every night, and unexplained litres stay a small residual
 * rather than a headline number. Used only until the owner connects the meter
 * (WaterResponse.configured=false is the real first-deploy state — see Water.tsx). */
const WATER_NIGHT_IRRIGATION_LPH = [1620, 1840, 1710, 1490, 260, 40]; // 00:00–05:59
const WATER_DAY_HOUSEHOLD_LPH = [8, 14, 46, 92, 118, 74, 58, 96, 142, 168, 121, 66, 41, 22, 12, 9, 6, 3];
const mockWaterHours = Array.from({ length: 24 }, (_, h) => {
  const irrigationL = h < 6 ? WATER_NIGHT_IRRIGATION_LPH[h] : 0;
  const householdL = h < 6 ? Math.round(4 + h * 2) : WATER_DAY_HOUSEHOLD_LPH[h - 6];
  const unexplainedL = h === 23 ? 2 : Math.round(householdL * 0.03);
  return { h, totalL: irrigationL + householdL + unexplainedL, householdL, irrigationL, unexplainedL, reported: true };
});
const mockWaterTotals = mockWaterHours.reduce(
  (acc, b) => ({ totalL: acc.totalL + b.totalL, householdL: acc.householdL + b.householdL, irrigationL: acc.irrigationL + b.irrigationL, unexplainedL: acc.unexplainedL + b.unexplainedL }),
  { totalL: 0, householdL: 0, irrigationL: 0, unexplainedL: 0 },
);

export const MOCK_WATER: WaterResponse = {
  ts: new Date().toISOString(),
  configured: true,
  connected: true,
  lastError: null,
  meter: { serial: 'P23EA822644C', model: 'Contazara CZ3000', address: 'Cami de la Fontana, Jávea', indexL: 812_430_000, lastReadingIso: new Date(Date.now() - 4 * 3_600_000).toISOString(), staleHours: 4 },
  today: { dateIso: new Date().toISOString().slice(0, 10), ...mockWaterTotals, hours: mockWaterHours },
  quietHour: { lowestLph: 40, atHour: 5, hoursSinceBelowFloor: 0, floorLph: 60, ok: true },
  month: { m3: 77.7, householdM3: 16.9, irrigationM3: 59.8, unexplainedM3: 1.0, expectedM3: 17.4, costEur: 118.4, budgetM3: 85, projectedM3: 80.2 },
  zones: [
    { id: 'rb-1', name: 'Front lawn', lpm: 14.2, samples: 22, learned: true },
    { id: 'rb-2', name: 'Olive grove', lpm: 9.6, samples: 18, learned: true },
    { id: 'rb-3', name: 'Herb beds', lpm: 4.1, samples: 6, learned: true },
    { id: 'rb-4', name: 'Back terrace pots', lpm: 3.0, samples: 0, learned: false },
  ],
  activeAlerts: [],
  period: {
    startIso: '2026-07-01',
    endIso: '2026-09-01',
    months: 2,
    daysElapsed: 31,
    daysTotal: 62,
    m3ToDate: 140.2,
    projectedM3: 280.4,
    bandRateEurM3: 1.86,
    projectedCostEur: 706.3,
    cliff: { m3ToNextBandDown: 210.4, savingEur: 480.9, nextM3CostEur: 2.46 },
  },
};

function waterHistoryLabels(range: string, n: number): string[] {
  if (range === 'day') return Array.from({ length: n }, (_, i) => `${String(i).padStart(2, '0')}:00`);
  if (range === 'week') return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  if (range === 'year') return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return Array.from({ length: n }, (_, i) => String(i + 1));
}

/** Builds a plausible 30-ish-day mock series: mostly modest household use, a
 *  handful of big irrigation nights (every 3rd day), and a persistently-small
 *  unexplained residual (the "healthy house" case — see docs/52 §1). */
function mockWaterSeries(n: number): { total: number[]; household: number[]; irrigation: number[]; unexplained: number[] } {
  const household: number[] = [];
  const irrigation: number[] = [];
  const unexplained: number[] = [];
  for (let i = 0; i < n; i++) {
    const h = 380 + Math.round(60 * Math.sin(i / 2.3));
    const irr = i % 3 === 0 ? 5400 + Math.round(900 * Math.cos(i)) : 0;
    const u = Math.round(h * 0.03);
    household.push(h);
    irrigation.push(irr);
    unexplained.push(u);
  }
  const total = household.map((h, i) => h + irrigation[i] + unexplained[i]);
  return { total, household, irrigation, unexplained };
}

export function mockWaterHistory(range: string, offset = 0): WaterHistoryResponse {
  const n = range === 'day' ? 24 : range === 'week' ? 7 : range === 'year' ? 12 : 30;
  const series = mockWaterSeries(n);
  const cumActual: number[] = [];
  const cumExpected: number[] = [];
  let ra = 0;
  let re = 0;
  for (let i = 0; i < n; i++) {
    ra += series.total[i];
    re += series.household[i] + (i % 3 === 0 ? series.irrigation[i] * 0.97 : 0); // expected trails actual by ~the unexplained sliver
    cumActual.push(ra);
    cumExpected.push(Math.round(re));
  }
  const totals = {
    totalL: series.total.reduce((a, b) => a + b, 0),
    householdL: series.household.reduce((a, b) => a + b, 0),
    irrigationL: series.irrigation.reduce((a, b) => a + b, 0),
    unexplainedL: series.unexplained.reduce((a, b) => a + b, 0),
    costEur: 0,
  };
  totals.costEur = Math.round((totals.totalL / 1000) * 1.6 * 100) / 100;
  return {
    ts: new Date().toISOString(),
    range: (range as WaterHistoryResponse['range']) ?? 'week',
    offset,
    label: range === 'day' ? 'Today' : range === 'week' ? 'This week' : range === 'year' ? 'This year' : 'This month',
    labels: waterHistoryLabels(range, n),
    series,
    cumulative: { actual: cumActual, expected: cumExpected },
    dayparts: {
      night: series.household.map((_, i) => 40 + (i % 3 === 0 ? 30 : 0)),
      morning: series.household.map((h) => Math.round(h * 0.32)),
      afternoon: series.household.map((h) => Math.round(h * 0.28)),
      evening: series.household.map((h) => Math.round(h * 0.4)),
    },
    nightBaseline: series.household.map((_, i) => 40 + (i % 7 === 5 ? 55 : 0)),
    totals,
  };
}

export const MOCK_WATER_HISTORY: WaterHistoryResponse = mockWaterHistory('week', 0);

/* The Settings tab seeds its editable connection form from this until the real
 * response lands, so the credential fields MUST be blank here — a mock email or
 * meter serial would render as though it were configured, and could be saved
 * for real. Only the non-credential defaults below are safe to populate. */
export const MOCK_WATER_SETTINGS: WaterSettingsResponse = {
  ts: new Date().toISOString(),
  configured: false,
  connected: false,
  hasPassword: false,
  email: '',
  serial: '',
  pollHours: 6,
  thresholds: {
    quietHourFloorLph: 5,
    continuousFlowHours: 24,
    nightToleranceL: 60,
    monthlyBudgetM3: 80,
    dailySpikeFactor: 3,
    meterSilentHours: 36,
  },
  // Real AMJASA rates from factura 3/1836657 (Jul–Aug 2026), mirroring
  // defaultWaterTariff() in apps/api/src/store.ts.
  tariff: {
    periodMonths: 2,
    supplyFixedEurPeriod: 27.34,
    blockMode: 'all-at-last',
    supplyBlocks: [
      { upToM3: 10, eurM3: 0.15 },
      { upToM3: 40, eurM3: 0.63 },
      { upToM3: 70, eurM3: 1.37 },
      { upToM3: null, eurM3: 1.86 },
    ],
    sanitationFixedEurPeriod: 7.3,
    sanitationEurM3: 0.412,
    ivaPct: 10,
  },
  billingAnchorDay: '2026-07-01',
  history: { backfillDailyMonths: 24, backfillHourlyDays: 90, retainHourlyDays: 400 },
  backfill: { dailyDone: false, hourlyCursor: null, oldestDay: null, dailyRows: 0, hourlyRows: 0 },
};
