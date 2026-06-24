// Power desktop kit — Statistics screen.
function StatisticsScreen({ range }) {
  const { DATA } = window.PWRKit;
  const { Card, StatTile, ProgressBar, Badge } = window.PowerDesignSystem_138199;
  const { BarChart } = window.PWRCharts;

  const days = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const prod = [31,26,38,22,34,41,29];
  const cons = [22,19,24,18,21,17,20];
  const groups = days.map((d, i) => ({
    label: d, values: [prod[i], cons[i]], tones: ['var(--solar)', 'var(--home)'],
  }));

  const breakdown = [
    { name: 'EV charger', icon: 'plug-zap', tone: 'var(--ev)', kwh: 58.2, pct: 38 },
    { name: 'Heat pump', icon: 'thermometer', tone: 'var(--grid)', kwh: 42.6, pct: 28 },
    { name: 'Appliances', icon: 'washing-machine', tone: 'var(--home)', kwh: 28.1, pct: 18 },
    { name: 'Water heater', icon: 'droplet', tone: 'var(--battery)', kwh: 15.3, pct: 10 },
    { name: 'Lighting & other', icon: 'lightbulb', tone: 'var(--text-2)', kwh: 9.0, pct: 6 },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
        <Card><StatTile label="Produced" value="221" unit="kWh" tone="solar" icon={<i data-lucide="sun"></i>} delta={8} footnote="this week" /></Card>
        <Card><StatTile label="Consumed" value="141" unit="kWh" tone="home" icon={<i data-lucide="plug"></i>} delta={-3} footnote="this week" /></Card>
        <Card><StatTile label="Exported" value="96" unit="kWh" tone="grid" icon={<i data-lucide="upload"></i>} delta={14} footnote="to grid" /></Card>
        <Card><StatTile label="CO₂ avoided" value="88" unit="kg" tone="battery" icon={<i data-lucide="leaf"></i>} delta={8} footnote="this week" /></Card>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 20 }}>
        <Card title="Production vs consumption" subtitle={`This ${range === 'Day' ? 'day' : 'week'} · kWh`}
          icon={<i data-lucide="bar-chart-3"></i>}
          actions={<div style={{ display: 'flex', gap: 16, fontSize: 12, color: 'var(--text-2)' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><i style={{ width: 9, height: 9, borderRadius: 2, background: 'var(--solar)' }}></i>Produced</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><i style={{ width: 9, height: 9, borderRadius: 2, background: 'var(--home)' }}></i>Consumed</span>
          </div>}>
          <BarChart groups={groups} height={240} />
        </Card>

        <Card title="Consumption breakdown" subtitle="By device · this week" icon={<i data-lucide="pie-chart"></i>}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {breakdown.map((b) => (
              <div key={b.name} style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ width: 28, height: 28, borderRadius: 8, display: 'grid', placeItems: 'center',
                    background: 'var(--surface-3)', color: b.tone }}>
                    <i data-lucide={b.icon} style={{ width: 15, height: 15 }}></i>
                  </span>
                  <span style={{ fontSize: 14, color: 'var(--text-1)', flex: 1 }}>{b.name}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-1)' }}>{b.kwh} <span style={{ color: 'var(--text-3)' }}>kWh</span></span>
                </div>
                <ProgressBar height={6} segments={[{ value: b.pct, tone: b.tone }]} />
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
Object.assign(window, { StatisticsScreen });
