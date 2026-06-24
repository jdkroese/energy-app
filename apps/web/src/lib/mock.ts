/**
 * Mock data mirroring the mockups' constants. Used as a graceful fallback when
 * the API isn't reachable yet, so every screen renders faithfully. Once the
 * backend is live, real data replaces these via keep-last-good polling.
 */
import type {
  AlertsResponse,
  BrainPlanResponse,
  HistoryResponse,
  LiveResponse,
  ScenariosResponse,
  SettingsResponse,
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

export const MOCK_LIVE: LiveResponse = {
  ts: new Date().toISOString(),
  solar: { kw: 11.1, arrays: [{ name: 'A', kw: 6.6 }, { name: 'B', kw: 4.5 }] },
  home: { kw: 5.5 },
  grid: { kw: 5.56, dir: 'exporting' },
  sonnen: { soc: 100, kwh: 9.2, kw: 0, dir: 'idle' },
  tesla: { soc: 100, kwh: 27, kw: 0, dir: 'idle', reservePct: 20, backupKwh: 27, backupHours: 16, island: false },
  tariff: { band: 'P2', rateEur: 0.131, nextBand: 'P1', minsToNext: 72 },
  today: { producedKwh: 42.3, consumedKwh: 28.6, gridFeedInKwh: 18.4, selfSufficiencyPct: 71, savedEur: 5.4 },
  day: { solarKw: solarDay, homeKw: homeDay },
};

export const MOCK_HISTORY: HistoryResponse = {
  ts: new Date().toISOString(),
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
    { id: 'r3', icon: 'alert-triangle', label: 'Sonnen fault or alarm', enabled: true },
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
  projected: { savedEur: 6.1, selfSufficiencyPct: 84, reservePct: 20, p1AvoidedKwh: 11.2 },
  forecast: {
    solarKw: [0, 0, 0, 0, 0, 0, 0.3, 1.5, 3.8, 6.5, 8.8, 10.2, 10.9, 11.0, 10.2, 8.6, 6.4, 4.0, 1.8, 0.4, 0, 0, 0, 0, 0],
    loadKw: [0.5, 0.4, 0.4, 0.4, 0.4, 0.5, 0.7, 1.0, 1.2, 1.4, 2.6, 3.0, 2.8, 2.4, 2.6, 2.8, 2.2, 1.8, 3.4, 3.8, 3.2, 1.6, 0.9, 0.6, 0.5],
  },
  socPct: [38, 34, 30, 28, 28, 28, 30, 42, 58, 72, 84, 92, 98, 100, 100, 100, 98, 92, 78, 58, 40, 30, 30, 32, 34],
  tariff: [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 2, 2, 1, 1, 1, 1, 2, 2, 2, 2, 1, 1],
  now: 16.8,
  actions: [
    { h: 2.0, icon: 'moon', tone: 'battery', title: 'No overnight charge', why: 'Sunny tomorrow — solar will refill the batteries for free.' },
    { h: 7.5, icon: 'sun', tone: 'solar', title: 'Charging from solar', why: 'House covered; surplus banked into both batteries.' },
    { h: 11.0, icon: 'wind', tone: 'battery', title: 'Pre-cooling the house', why: '>31 °C forecast — A/C runs on solar now so the slab coasts cool through the evening peak.' },
    { h: 13.5, icon: 'upload', tone: 'grid', title: 'Surplus to grid', why: 'Batteries full; export is unavoidable (and worth little).' },
    { h: 18.0, icon: 'battery-charging', tone: 'solar', title: 'Discharging for P1 peak', why: 'Both batteries cover the house 18:00–22:00 — near-zero grid import at €0.209.' },
    { h: 22.0, icon: 'shield-check', tone: 'battery', title: 'Holding 20% backup', why: 'Storm-free — standard Tesla reserve kept for resilience.' },
  ],
  whyNow: {
    title: 'Holding full, banking sun',
    body: 'Both batteries are full and the slab is pre-cooled. Surplus is exporting for now — there is nowhere left to store it.',
  },
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
