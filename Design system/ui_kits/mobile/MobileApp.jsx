// Power mobile kit — phone frame + screens.
const I = (n, s) => <i data-lucide={n} style={s}></i>;

function StatusBar() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '12px 26px 4px', fontFamily: 'var(--font-mono)', fontSize: 14, color: 'var(--text-1)', fontWeight: 600 }}>
      <span>9:41</span>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        {I('signal', { width: 16, height: 16 })}
        {I('wifi', { width: 16, height: 16 })}
        {I('battery-full', { width: 18, height: 18 })}
      </div>
    </div>
  );
}

function MHeader({ title, sub, action }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 20px 16px' }}>
      <div style={{ flex: 1 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.02em' }}>{title}</h1>
        {sub && <div style={{ fontSize: 13, color: 'var(--text-2)', marginTop: 2 }}>{sub}</div>}
      </div>
      {action}
    </div>
  );
}

function HomeScreen() {
  const { DATA } = window.PWRKit;
  const { Card, StatTile, EnergyFlow, RadialGauge, Switch, Badge } = window.PowerDesignSystem_138199;
  const t = DATA.today;
  return (
    <>
      <MHeader title="Good afternoon" sub="Home · sunny, 18°"
        action={<div style={{ width: 38, height: 38, borderRadius: '50%', background: 'linear-gradient(135deg, var(--solar-dim), var(--battery-dim))', display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 13, color: '#fff' }}>JD</div>} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '0 16px 24px' }}>
        <Card accent="solar" glow padded={false} style={{ padding: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <span className="pwr-eyebrow">Live flow</span>
            <Badge tone="solar" icon={I('radio', { width: 12, height: 12 })}>Live</Badge>
          </div>
          <EnergyFlow solar={DATA.live.solar} battery={DATA.live.battery} grid={DATA.live.grid} home={DATA.live.home} />
        </Card>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Card style={{ padding: 16 }}><StatTile size="sm" label="Solar today" value={t.produced} unit="kWh" tone="solar" icon={I('sun')} delta={12} /></Card>
          <Card style={{ padding: 16 }}><StatTile size="sm" label="Used" value={t.consumed} unit="kWh" tone="home" icon={I('plug')} delta={-6} /></Card>
        </div>

        <Card style={{ padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
            <RadialGauge value={DATA.live.battery.soc} tone="battery" label="Battery" size={104} />
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <StatTile size="sm" label="Storage" value="10.5" unit="kWh" tone="battery" footnote="charging 1.1 kW" />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                <span style={{ color: 'var(--text-2)' }}>Self-sufficiency</span>
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--solar)' }}>{t.selfSufficiency}%</span>
              </div>
            </div>
          </div>
        </Card>

        <Card title="Quick controls" style={{ padding: 0 }}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {[['plug-zap', 'EV charging', 'ev', true], ['battery-charging', 'Battery export', 'battery', true], ['cloud-lightning', 'Storm guard', 'grid', false]].map((r, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px', borderTop: i ? '1px solid var(--border-1)' : 'none' }}>
                <span style={{ color: `var(--${r[2]})` }}>{I(r[0], { width: 18, height: 18 })}</span>
                <span style={{ flex: 1, fontSize: 14.5 }}>{r[1]}</span>
                <Switch defaultChecked={r[3]} />
              </div>
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}

function FlowScreen() {
  const { DATA } = window.PWRKit;
  const { Card, EnergyFlow, StatTile, Badge } = window.PowerDesignSystem_138199;
  const rows = [
    ['sun', 'Solar', 'solar', '4.21', 'Producing'],
    ['battery-charging', 'Battery', 'battery', '1.12', 'Charging · 78%'],
    ['house', 'Home', 'home', '2.25', 'Consuming'],
    ['utility-pole', 'Grid', 'grid', '0.84', 'Exporting'],
  ];
  return (
    <>
      <MHeader title="Energy flow" sub="Real-time power balance" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '0 16px 24px' }}>
        <Card accent="solar" glow style={{ padding: 18 }}>
          <EnergyFlow solar={DATA.live.solar} battery={DATA.live.battery} grid={DATA.live.grid} home={DATA.live.home} />
        </Card>
        <Card title="Now" style={{ padding: 0 }}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {rows.map((r, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 13, padding: '15px 16px', borderTop: i ? '1px solid var(--border-1)' : 'none' }}>
                <span style={{ width: 38, height: 38, borderRadius: 10, display: 'grid', placeItems: 'center', background: 'var(--surface-3)', color: `var(--${r[2]})` }}>{I(r[0], { width: 18, height: 18 })}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14.5, fontWeight: 600 }}>{r[1]}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-2)' }}>{r[4]}</div>
                </div>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 17, fontWeight: 500, color: `var(--${r[2]})` }}>{r[3]}<span style={{ fontSize: 11, color: 'var(--text-3)' }}> kW</span></span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}

function ChargeScreen() {
  const { Card, RadialGauge, ProgressBar, Button, Badge, Select, SegmentedControl } = window.PowerDesignSystem_138199;
  const [mode, setMode] = React.useState('Solar');
  return (
    <>
      <MHeader title="EV charging" sub="Wallbox · Garage" action={<Badge tone="ev" icon={I('zap', { width: 12, height: 12 })}>Charging</Badge>} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '0 16px 24px' }}>
        <Card accent="ev" glow style={{ padding: 22, alignItems: 'center' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
            <RadialGauge value={62} tone="ev" label="Charge" size={170} thickness={12} />
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 15, color: 'var(--text-1)' }}>7.4 kW · 28 km added</div>
              <div style={{ fontSize: 13, color: 'var(--text-2)', marginTop: 2 }}>Full in 1h 45m · 80% target</div>
            </div>
          </div>
        </Card>

        <Card title="Charge source" style={{ padding: 16 }}>
          <SegmentedControl block options={['Solar', 'Cheap rate', 'Fast']} value={mode} onChange={setMode} />
          <div style={{ marginTop: 14 }}>
            <ProgressBar height={10} segments={[{ value: 68, tone: 'solar' }, { value: 32, tone: 'grid' }]} />
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 12, color: 'var(--text-2)', fontFamily: 'var(--font-mono)' }}>
              <span style={{ color: 'var(--solar)' }}>68% solar</span><span>32% grid</span>
            </div>
          </div>
        </Card>

        <div style={{ display: 'flex', gap: 10 }}>
          <Button variant="primary" iconLeft={I('zap')} block>Charge now</Button>
          <Button variant="secondary" iconLeft={I('pause')} block>Pause</Button>
        </div>
      </div>
    </>
  );
}

function StatsScreen() {
  const { DATA } = window.PWRKit;
  const { Card, StatTile, ProgressBar, SegmentedControl } = window.PowerDesignSystem_138199;
  const { AreaChart } = window.PWRCharts;
  const [range, setRange] = React.useState('Day');
  const breakdown = [
    ['EV charger', 'plug-zap', 'ev', 58.2, 38],
    ['Heat pump', 'thermometer', 'grid', 42.6, 28],
    ['Appliances', 'washing-machine', 'home', 28.1, 18],
    ['Water heater', 'droplet', 'battery', 15.3, 10],
  ];
  return (
    <>
      <MHeader title="Statistics" sub="Production & consumption" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '0 16px 24px' }}>
        <SegmentedControl block options={['Day', 'Week', 'Month', 'Year']} value={range} onChange={setRange} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Card style={{ padding: 16 }}><StatTile size="sm" label="Produced" value={DATA.today.produced} unit="kWh" tone="solar" icon={I('sun')} delta={12} /></Card>
          <Card style={{ padding: 16 }}><StatTile size="sm" label="Saved" value={`€${DATA.today.savings}`} tone="solar" icon={I('piggy-bank')} delta={9} /></Card>
        </div>
        <Card title="Today · kW" style={{ padding: 16 }}>
          <AreaChart height={150} series={[{ data: DATA.solarDay, tone: 'solar' }, { data: DATA.homeDay, tone: 'home', dash: true, fill: false }]} labels={['00','08','16','24']} />
        </Card>
        <Card title="By device" style={{ padding: 16 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {breakdown.map((b) => (
              <div key={b[0]} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ color: `var(--${b[2]})` }}>{I(b[1], { width: 16, height: 16 })}</span>
                  <span style={{ flex: 1, fontSize: 14 }}>{b[0]}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{b[3]} kWh</span>
                </div>
                <ProgressBar height={6} segments={[{ value: b[4], tone: b[2] }]} />
              </div>
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}

function PhoneApp() {
  const { drawIcons } = window.PWRKit;
  const [tab, setTab] = React.useState('home');
  React.useEffect(() => { drawIcons(); });
  const tabs = [['home', 'Home', 'house'], ['flow', 'Flow', 'zap'], ['charge', 'Charge', 'plug-zap'], ['stats', 'Stats', 'bar-chart-3']];
  let Screen;
  if (tab === 'home') Screen = <HomeScreen />;
  else if (tab === 'flow') Screen = <FlowScreen />;
  else if (tab === 'charge') Screen = <ChargeScreen />;
  else Screen = <StatsScreen />;

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 28, background: 'radial-gradient(circle at 50% 0%, #0c1418, var(--bg-0))' }}>
      <div style={{ width: 390, height: 844, borderRadius: 46, background: 'var(--bg-0)', border: '10px solid #1a2227',
        boxShadow: '0 40px 90px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(255,255,255,0.04)', overflow: 'hidden',
        display: 'flex', flexDirection: 'column', position: 'relative' }}>
        <StatusBar />
        <div style={{ flex: 1, overflowY: 'auto' }}>{Screen}</div>
        {/* bottom tab bar */}
        <div style={{ display: 'flex', padding: '10px 12px 22px', borderTop: '1px solid var(--border-1)',
          background: 'var(--glass-fill)', backdropFilter: 'blur(var(--blur-glass))' }}>
          {tabs.map((t) => {
            const on = tab === t[0];
            return (
              <button key={t[0]} onClick={() => setTab(t[0])} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
                border: 'none', background: 'transparent', cursor: 'pointer', color: on ? 'var(--solar)' : 'var(--text-3)' }}>
                {I(t[2], { width: 22, height: 22 })}
                <span style={{ fontSize: 10.5, fontWeight: on ? 600 : 500 }}>{t[1]}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<PhoneApp />);
setTimeout(() => window.lucide && window.lucide.createIcons(), 80);
