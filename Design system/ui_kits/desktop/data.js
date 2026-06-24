// Power desktop kit — mock data + helpers. Plain JS, exposes globals.
(function () {
  const NS = window.PowerDesignSystem_138199 || {};

  // Re-run Lucide after React renders (icons use <i data-lucide>).
  function drawIcons() {
    if (window.lucide) window.lucide.createIcons();
  }

  // Smooth-ish series generator
  function series(n, base, amp, seed) {
    let s = seed || 1;
    const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
    const out = [];
    for (let i = 0; i < n; i++) {
      const day = Math.sin((i / n) * Math.PI); // bell over the day
      out.push(Math.max(0, base + day * amp + (rnd() - 0.5) * amp * 0.3));
    }
    return out;
  }

  const hours = Array.from({ length: 24 }, (_, i) => i);

  const DATA = {
    live: {
      solar: { kw: 4.21 },
      battery: { kw: 1.12, dir: 'charging', soc: 78 },
      grid: { kw: 0.84, dir: 'exporting' },
      home: { kw: 2.25 },
    },
    today: {
      produced: 28.4,
      consumed: 19.7,
      selfSufficiency: 74,
      savings: 6.85,
      exported: 9.1,
      imported: 4.3,
      co2: 12.6,
    },
    solarDay: series(24, 0.2, 5.4, 7).map((v, i) => (i < 6 || i > 20 ? 0 : v)),
    homeDay: series(24, 0.4, 1.6, 13),
    hours,
    devices: [
      { id: 'pv', name: 'Solar inverter', sub: 'SolarEdge SE7600', icon: 'sun', tone: 'solar', kw: 4.21, state: 'Producing', live: true, on: true },
      { id: 'bat', name: 'Home battery', sub: 'Powerwall · 13.5 kWh', icon: 'battery-charging', tone: 'battery', kw: 1.12, state: 'Charging · 78%', live: true, on: true },
      { id: 'ev', name: 'EV charger', sub: 'Wallbox · Garage', icon: 'plug-zap', tone: 'ev', kw: 7.4, state: 'Charging · 62%', live: true, on: true },
      { id: 'hp', name: 'Heat pump', sub: 'Daikin Altherma', icon: 'thermometer', tone: 'grid', kw: 0.9, state: 'Heating · 21°C', live: true, on: true },
      { id: 'wh', name: 'Water heater', sub: 'Boiler · 200 L', icon: 'droplet', tone: 'home', kw: 0, state: 'Idle', live: false, on: true },
      { id: 'grid', name: 'Grid connection', sub: 'Liander · 3×25 A', icon: 'utility-pole', tone: 'grid', kw: 0.84, state: 'Exporting', live: true, on: true },
    ],
    rules: [
      { id: 'r1', name: 'Battery-first charging', desc: 'Charge the battery from surplus solar before exporting to the grid.', on: true, icon: 'battery-charging' },
      { id: 'r2', name: 'Cheap-rate EV top-up', desc: 'Charge the car between 02:00–05:00 when grid tariff is lowest.', on: true, icon: 'plug-zap' },
      { id: 'r3', name: 'Storm guard', desc: 'Reserve 100% battery capacity when a storm warning is issued.', on: false, icon: 'cloud-lightning' },
      { id: 'r4', name: 'Peak shaving', desc: 'Discharge battery to cap grid import below 4 kW during peak hours.', on: true, icon: 'activity' },
      { id: 'r5', name: 'Heat-pump preheat', desc: 'Pre-heat the house on solar surplus before the evening peak.', on: false, icon: 'thermometer' },
    ],
    // 24h tariff: 0 cheap, 1 normal, 2 peak
    tariff: [0,0,0,0,0,0,1,1,2,2,1,1,1,1,1,1,1,2,2,2,1,1,0,0],
    nav: [
      { id: 'overview', label: 'Overview', icon: 'layout-dashboard' },
      { id: 'statistics', label: 'Statistics', icon: 'bar-chart-3' },
      { id: 'devices', label: 'Devices', icon: 'cpu' },
      { id: 'optimization', label: 'Optimization', icon: 'sliders-horizontal' },
    ],
  };

  window.PWRKit = Object.assign(window.PWRKit || {}, { DATA, drawIcons, series });
})();
