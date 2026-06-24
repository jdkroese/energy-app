// Power desktop kit — Devices screen.
function DevicesScreen() {
  const { DATA } = window.PWRKit;
  const { Card, StatusDot, Switch, Badge, Button, IconButton, RadialGauge, StatTile, ProgressBar } = window.PowerDesignSystem_138199;
  const [selected, setSelected] = React.useState('ev');
  const dev = DATA.devices.find((d) => d.id === selected) || DATA.devices[0];
  const toneVar = { solar: 'var(--solar)', battery: 'var(--battery)', grid: 'var(--grid)', home: 'var(--home)', ev: 'var(--ev)' };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: 20, alignItems: 'start' }}>
      <Card title="Connected devices" subtitle={`${DATA.devices.length} devices · 4 active`} icon={<i data-lucide="cpu"></i>}
        actions={<Button variant="secondary" size="sm" iconLeft={<i data-lucide="plus"></i>}>Add</Button>}>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {DATA.devices.map((d, i) => {
            const on = d.id === selected;
            return (
              <button key={d.id} onClick={() => setSelected(d.id)} style={{
                display: 'flex', alignItems: 'center', gap: 14, padding: '14px 8px', cursor: 'pointer',
                background: on ? 'var(--surface-2)' : 'transparent', border: 'none', textAlign: 'left',
                borderTop: i === 0 ? 'none' : '1px solid var(--border-1)', borderRadius: on ? 'var(--radius-md)' : 0,
              }}>
                <span style={{ width: 40, height: 40, borderRadius: 11, display: 'grid', placeItems: 'center',
                  background: 'var(--surface-3)', color: toneVar[d.tone], flex: 'none' }}>
                  <i data-lucide={d.icon} style={{ width: 19, height: 19 }}></i>
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--text-1)' }}>{d.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-2)' }}>{d.sub}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 15, fontWeight: 500, color: d.kw > 0 ? toneVar[d.tone] : 'var(--text-3)' }}>
                    {d.kw.toFixed(2)}<span style={{ fontSize: 10, color: 'var(--text-3)' }}> kW</span>
                  </div>
                  <StatusDot tone={d.live ? d.tone : 'offline'} live={d.live}>{d.state.split(' · ')[0]}</StatusDot>
                </div>
              </button>
            );
          })}
        </div>
      </Card>

      {/* detail panel */}
      <Card accent={dev.tone} glow={dev.live}
        title={dev.name} subtitle={dev.sub}
        icon={<i data-lucide={dev.icon}></i>}
        actions={<IconButton label="Device settings"><i data-lucide="settings-2"></i></IconButton>}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
            {(dev.id === 'ev' || dev.id === 'bat') ? (
              <RadialGauge value={dev.id === 'ev' ? 62 : 78} tone={dev.tone} label={dev.id === 'ev' ? 'Charge' : 'SOC'} size={120} />
            ) : (
              <div style={{ width: 120, textAlign: 'center' }}>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 40, fontWeight: 500, color: toneVar[dev.tone] }}>{dev.kw.toFixed(1)}</div>
                <div style={{ fontSize: 12, color: 'var(--text-2)' }}>kW now</div>
              </div>
            )}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 14, color: 'var(--text-2)' }}>Power</span>
                <Switch defaultChecked={dev.on} label={dev.on ? 'On' : 'Off'} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 14, color: 'var(--text-2)' }}>Status</span>
                <Badge tone={dev.live ? dev.tone : 'neutral'} variant={dev.live ? 'soft' : 'soft'}>{dev.state}</Badge>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 14, color: 'var(--text-2)' }}>Today</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 14, color: 'var(--text-1)' }}>14.2 kWh</span>
              </div>
            </div>
          </div>

          {dev.id === 'ev' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 16, borderTop: '1px solid var(--border-1)' }}>
              <ProgressBar label="Charge to 80%" value={62} max={80} tone="ev" showValue glow />
              <div style={{ display: 'flex', gap: 10 }}>
                <Button variant="primary" size="sm" iconLeft={<i data-lucide="zap"></i>} block>Charge now</Button>
                <Button variant="secondary" size="sm" iconLeft={<i data-lucide="clock"></i>} block>Schedule</Button>
              </div>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
Object.assign(window, { DevicesScreen });
