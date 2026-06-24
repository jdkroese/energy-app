import { NavLink } from 'react-router-dom';
import { Icon } from '../ui/Icon';

/** Mobile tab keys; "More" links to settings (settings/scenarios/brain live there). */
const TABS = [
  { to: '/', label: 'Live', icon: 'activity' },
  { to: '/reports', label: 'Reports', icon: 'bar-chart-3' },
  { to: '/batteries', label: 'Batteries', icon: 'battery-charging' },
  { to: '/alerts', label: 'Alerts', icon: 'bell' },
  { to: '/settings', label: 'More', icon: 'menu' },
];

/** TabBar — fixed bottom mobile nav, glass blur + safe-area padding. */
export function TabBar() {
  return (
    <nav
      style={{
        display: 'flex',
        padding: '9px 10px calc(10px + env(safe-area-inset-bottom))',
        borderTop: '1px solid var(--border-1)',
        background: 'var(--glass-fill, rgba(15,22,25,.8))',
        backdropFilter: 'blur(var(--blur-glass, 18px))',
        WebkitBackdropFilter: 'blur(var(--blur-glass, 18px))',
      }}
    >
      {TABS.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.to === '/'}
          style={({ isActive }) => ({
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 4,
            textDecoration: 'none',
            color: isActive ? 'var(--solar)' : 'var(--text-3)',
          })}
        >
          {({ isActive }) => (
            <>
              <Icon name={t.icon} size={21} />
              <span style={{ fontSize: 10, fontWeight: isActive ? 600 : 500 }}>{t.label}</span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
