// Power desktop kit — Sidebar + TopBar chrome.
function Sidebar({ active, onNav }) {
  const { DATA } = window.PWRKit;
  const { StatusDot } = window.PowerDesignSystem_138199;
  return (
    <aside style={{
      width: 'var(--sidebar-w)', flex: 'none', height: '100%', display: 'flex', flexDirection: 'column',
      background: 'var(--bg-1)', borderRight: '1px solid var(--border-1)', padding: '20px 14px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '4px 8px 22px' }}>
        <img src="../../assets/logo-mark.svg" width="34" height="34" alt="" />
        <span style={{ fontSize: 19, fontWeight: 700, letterSpacing: '-0.02em' }}>
          <span style={{ color: 'var(--solar)' }}>Power</span>
        </span>
      </div>

      <nav style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {DATA.nav.map((n) => {
          const on = active === n.id;
          return (
            <button key={n.id} onClick={() => onNav(n.id)} style={{
              display: 'flex', alignItems: 'center', gap: 11, height: 42, padding: '0 12px',
              border: 'none', cursor: 'pointer', borderRadius: 'var(--radius-md)', textAlign: 'left',
              background: on ? 'var(--solar-wash)' : 'transparent',
              color: on ? 'var(--solar)' : 'var(--text-2)',
              fontFamily: 'var(--font-sans)', fontSize: 14, fontWeight: on ? 600 : 500,
              boxShadow: on ? 'inset 2px 0 0 var(--solar)' : 'none',
              transition: 'background .12s, color .12s',
            }}>
              <i data-lucide={n.icon} style={{ width: 18, height: 18 }}></i>
              {n.label}
            </button>
          );
        })}
      </nav>

      <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{
          padding: '14px', borderRadius: 'var(--radius-lg)', background: 'var(--surface-1)',
          border: '1px solid var(--border-1)',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span className="pwr-eyebrow">System</span>
            <StatusDot tone="solar" live>Online</StatusDot>
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-2)', lineHeight: 1.7 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Uptime</span><span style={{ color: 'var(--text-1)' }}>41d 6h</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Firmware</span><span style={{ color: 'var(--text-1)' }}>v3.8.1</span></div>
          </div>
        </div>
        <button onClick={() => onNav('settings')} style={{
          display: 'flex', alignItems: 'center', gap: 11, height: 40, padding: '0 12px', border: 'none',
          cursor: 'pointer', borderRadius: 'var(--radius-md)', background: 'transparent', color: 'var(--text-2)',
          fontFamily: 'var(--font-sans)', fontSize: 14, fontWeight: 500,
        }}>
          <i data-lucide="settings" style={{ width: 18, height: 18 }}></i>Settings
        </button>
      </div>
    </aside>
  );
}

function TopBar({ title, subtitle, range, onRange, right }) {
  const { SegmentedControl, IconButton } = window.PowerDesignSystem_138199;
  return (
    <header style={{
      display: 'flex', alignItems: 'center', gap: 20, padding: '20px 28px',
      borderBottom: '1px solid var(--border-1)',
    }}>
      <div style={{ minWidth: 0 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.01em' }}>{title}</h1>
        {subtitle && <div style={{ fontSize: 13, color: 'var(--text-2)', marginTop: 2 }}>{subtitle}</div>}
      </div>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14 }}>
        {right}
        {range && <SegmentedControl options={['Day','Week','Month','Year']} value={range} onChange={onRange} size="sm" />}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderRadius: 'var(--radius-pill)',
          background: 'var(--surface-1)', border: '1px solid var(--border-1)', fontSize: 13, color: 'var(--text-2)',
        }}>
          <i data-lucide="cloud-sun" style={{ width: 16, height: 16, color: 'var(--grid)' }}></i>
          <span style={{ fontFamily: 'var(--font-mono)' }}>18°</span>
          <span style={{ color: 'var(--text-3)' }}>· Partly sunny</span>
        </div>
        <IconButton label="Notifications" variant="solid"><i data-lucide="bell"></i></IconButton>
        <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'linear-gradient(135deg, var(--solar-dim), var(--battery-dim))',
          display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 13, color: '#fff' }}>JD</div>
      </div>
    </header>
  );
}

Object.assign(window, { Sidebar, TopBar });
