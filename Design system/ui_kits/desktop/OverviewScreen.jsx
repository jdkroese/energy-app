// Power desktop kit — Overview screen.
function OverviewScreen() {
  const { DATA } = window.PWRKit;
  const { Card, StatTile, RadialGauge, EnergyFlow, ProgressBar, Sparkline, Badge } = window.PowerDesignSystem_138199;
  const { AreaChart } = window.PWRCharts;
  const t = DATA.today;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* hero: flow + live readouts */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.15fr 1fr', gap: 20 }}>
        <Card title="Live energy flow" subtitle="Updated just now" accent="solar"
          icon={<i data-lucide="zap"></i>}
          actions={<Badge tone="solar" variant="soft" icon={<i data-lucide="radio"></i>}>Live</Badge>}>
          <EnergyFlow solar={DATA.live.solar} battery={DATA.live.battery} grid={DATA.live.grid} home={DATA.live.home} />
        </Card>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <Card glow accent="solar"><StatTile label="Solar now" value="4.21" unit="kW" tone="solar" icon={<i data-lucide="sun"></i>} footnote="6.2 kW peak today" /></Card>
          <Card accent="home"><StatTile label="Home load" value="2.25" unit="kW" tone="home" icon={<i data-lucide="house"></i>} delta={-4} footnote="vs 1h ago" /></Card>
          <Card style={{ gridColumn: 'span 2' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 22 }}>
              <RadialGauge value={DATA.live.battery.soc} tone="battery" label="Battery" size={120} />
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12 }}>
                <StatTile size="sm" label="Storage" value="10.5" unit="kWh" tone="battery" footnote="of 13.5 kWh · charging 1.1 kW" />
                <ProgressBar height={6} segments={[
                  { value: t.selfSufficiency, tone: 'solar' }, { value: 100 - t.selfSufficiency, tone: 'grid' }]} />
                <div style={{ fontSize: 12, color: 'var(--text-2)', fontFamily: 'var(--font-mono)' }}>
                  <span style={{ color: 'var(--solar)' }}>{t.selfSufficiency}% solar</span> · {100 - t.selfSufficiency}% grid
                </div>
              </div>
            </div>
          </Card>
        </div>
      </div>

      {/* KPI row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
        <Card><StatTile label="Produced today" value={t.produced} unit="kWh" tone="solar" icon={<i data-lucide="sun"></i>} delta={12} footnote="vs yesterday"><Sparkline data={DATA.solarDay.filter((_,i)=>i%2===0)} tone="solar" width={220} height={34} /></StatTile></Card>
        <Card><StatTile label="Consumed" value={t.consumed} unit="kWh" tone="home" icon={<i data-lucide="plug"></i>} delta={-6} footnote="vs yesterday"><Sparkline data={DATA.homeDay.filter((_,i)=>i%2===0)} tone="home" width={220} height={34} /></StatTile></Card>
        <Card><StatTile label="Self-sufficiency" value={t.selfSufficiency} unit="%" tone="battery" icon={<i data-lucide="leaf"></i>} delta={5} footnote="vs avg" /></Card>
        <Card><StatTile label="Saved today" value={`€${t.savings}`} tone="solar" icon={<i data-lucide="piggy-bank"></i>} delta={9} footnote="vs grid-only" /></Card>
      </div>

      {/* day chart */}
      <Card title="Production & consumption" subtitle="Today · kW"
        icon={<i data-lucide="area-chart"></i>}
        actions={<div style={{ display: 'flex', gap: 16, fontSize: 12, color: 'var(--text-2)' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><i style={{ width: 9, height: 9, borderRadius: 2, background: 'var(--solar)' }}></i>Solar</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><i style={{ width: 9, height: 9, borderRadius: 2, background: 'var(--home)' }}></i>Home</span>
        </div>}>
        <AreaChart height={200} series={[
          { data: DATA.solarDay, tone: 'solar' },
          { data: DATA.homeDay, tone: 'home', dash: true, fill: false },
        ]} labels={['00','04','08','12','16','20','24']} />
      </Card>
    </div>
  );
}
Object.assign(window, { OverviewScreen });
