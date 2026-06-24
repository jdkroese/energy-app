// Power desktop kit — Optimization screen.
function OptimizationScreen() {
  const { DATA } = window.PWRKit;
  const { Card, Switch, Slider, Select, Badge, Button } = window.PowerDesignSystem_138199;
  const [rules, setRules] = React.useState(DATA.rules);
  const [reserve, setReserve] = React.useState(20);
  const [mode, setMode] = React.useState('Self-use');
  const toggle = (id) => setRules((rs) => rs.map((r) => r.id === id ? { ...r, on: !r.on } : r));

  const tariffColor = ['var(--solar)', 'var(--surface-4)', 'var(--grid)'];
  const tariffName = ['Cheap', 'Normal', 'Peak'];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 20, alignItems: 'start' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <Card title="Automation rules" subtitle="3 of 5 active" icon={<i data-lucide="workflow"></i>}
          actions={<Button variant="secondary" size="sm" iconLeft={<i data-lucide="plus"></i>}>New rule</Button>}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {rules.map((r, i) => (
              <div key={r.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 14, padding: '16px 4px',
                borderTop: i === 0 ? 'none' : '1px solid var(--border-1)' }}>
                <span style={{ width: 38, height: 38, borderRadius: 10, display: 'grid', placeItems: 'center', flex: 'none',
                  background: r.on ? 'var(--solar-wash)' : 'var(--surface-3)', color: r.on ? 'var(--solar)' : 'var(--text-3)' }}>
                  <i data-lucide={r.icon} style={{ width: 18, height: 18 }}></i>
                </span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--text-1)' }}>{r.name}</div>
                  <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginTop: 2, lineHeight: 1.5 }}>{r.desc}</div>
                </div>
                <Switch checked={r.on} onChange={() => toggle(r.id)} />
              </div>
            ))}
          </div>
        </Card>

        <Card title="Grid tariff · today" subtitle="Optimizer shifts loads to cheap windows" icon={<i data-lucide="clock"></i>}>
          <div style={{ display: 'flex', gap: 2, height: 56, alignItems: 'stretch', marginBottom: 10 }}>
            {DATA.tariff.map((t, h) => (
              <div key={h} title={`${h}:00 · ${tariffName[t]}`} style={{ flex: 1, background: tariffColor[t],
                borderRadius: 3, opacity: t === 1 ? 0.5 : 1,
                boxShadow: t === 0 ? '0 0 8px color-mix(in srgb, var(--solar) 40%, transparent)' : 'none' }} />
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-3)' }}>
            <span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span>
          </div>
          <div style={{ display: 'flex', gap: 16, marginTop: 14, fontSize: 12, color: 'var(--text-2)' }}>
            {tariffName.map((n, i) => (
              <span key={n} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <i style={{ width: 10, height: 10, borderRadius: 3, background: tariffColor[i], opacity: i === 1 ? 0.5 : 1 }}></i>{n}
              </span>
            ))}
          </div>
        </Card>
      </div>

      <Card title="Battery strategy" subtitle="How storage charges & discharges" icon={<i data-lucide="battery-charging"></i>}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
          <Select label="Charge mode" options={['Self-use', 'Time-of-use', 'Backup', 'Manual']} value={mode} onChange={(e) => setMode(e.target.value)} />
          <Slider label="Reserve for backup" unit="%" value={reserve} onChange={setReserve} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingTop: 6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div><div style={{ fontSize: 14, color: 'var(--text-1)' }}>Charge from grid</div>
                <div style={{ fontSize: 12, color: 'var(--text-2)' }}>Top up at cheap rate overnight</div></div>
              <Switch defaultChecked />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div><div style={{ fontSize: 14, color: 'var(--text-1)' }}>Sell surplus to grid</div>
                <div style={{ fontSize: 12, color: 'var(--text-2)' }}>Export above {reserve}% reserve</div></div>
              <Switch defaultChecked />
            </div>
          </div>
          <div style={{ padding: 14, borderRadius: 'var(--radius-md)', background: 'var(--solar-wash)',
            border: '1px solid rgba(46,230,160,0.2)', display: 'flex', gap: 11, alignItems: 'flex-start' }}>
            <i data-lucide="sparkles" style={{ width: 18, height: 18, color: 'var(--solar)', flex: 'none', marginTop: 1 }}></i>
            <div style={{ fontSize: 13, color: 'var(--text-1)', lineHeight: 1.5 }}>
              Optimizer estimates <b style={{ color: 'var(--solar)' }}>€41/mo</b> saved with the current strategy.
            </div>
          </div>
          <Button variant="primary" iconLeft={<i data-lucide="check"></i>} block>Apply strategy</Button>
        </div>
      </Card>
    </div>
  );
}
Object.assign(window, { OptimizationScreen });
