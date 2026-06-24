// Power desktop kit — App shell wiring screens together.
function App() {
  const { drawIcons } = window.PWRKit;
  const [active, setActive] = React.useState('overview');
  const [range, setRange] = React.useState('Day');

  React.useEffect(() => { drawIcons(); });

  const titles = {
    overview: ['Overview', 'Your home, right now'],
    statistics: ['Statistics', 'Production, consumption & savings'],
    devices: ['Devices', 'Monitor & control connected hardware'],
    optimization: ['Optimization', 'Automation rules & battery strategy'],
    settings: ['Settings', 'System configuration'],
  };
  const [title, sub] = titles[active] || titles.overview;

  let Screen;
  if (active === 'overview') Screen = <window.OverviewScreen />;
  else if (active === 'statistics') Screen = <window.StatisticsScreen range={range} />;
  else if (active === 'devices') Screen = <window.DevicesScreen />;
  else if (active === 'optimization') Screen = <window.OptimizationScreen />;
  else Screen = <div style={{ color: 'var(--text-2)', padding: 40 }}>Settings — configuration screens.</div>;

  const showRange = active === 'statistics';

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100%', overflow: 'hidden' }}>
      <window.Sidebar active={active} onNav={setActive} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, background: 'var(--bg-0)' }}>
        <window.TopBar title={title} subtitle={sub} range={showRange ? range : null} onRange={setRange} />
        <main style={{ flex: 1, overflowY: 'auto', padding: '24px 28px 40px' }}>
          <div style={{ maxWidth: 'var(--content-max)', margin: '0 auto' }}>{Screen}</div>
        </main>
      </div>
    </div>
  );
}
ReactDOM.createRoot(document.getElementById('root')).render(<App />);
setTimeout(() => window.lucide && window.lucide.createIcons(), 80);
