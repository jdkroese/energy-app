import { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { Icon } from '../ui/Icon';
import { MOBILE_TABS, MOBILE_MORE_PATHS } from './nav';
import { MoreMenu } from './MoreMenu';

const itemStyle = (active: boolean) => ({
  flex: 1,
  display: 'flex',
  flexDirection: 'column' as const,
  alignItems: 'center',
  gap: 4,
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  textDecoration: 'none',
  color: active ? 'var(--solar)' : 'var(--text-3)',
});

/** TabBar — fixed bottom mobile nav: primary tabs + a More menu, glass blur + safe-area. */
export function TabBar() {
  const [moreOpen, setMoreOpen] = useState(false);
  const { pathname } = useLocation();

  // Highlight "More" whenever the current route lives behind it (incl. detail pages).
  // Paths shared with a bottom tab (e.g. /devices) are excluded — those light up the
  // bottom tab itself, not "More".
  const onMoreRoute = MOBILE_MORE_PATHS.some(
    (p) => pathname === p || (p !== '/' && pathname.startsWith(`${p}/`)),
  );

  return (
    <>
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
        {MOBILE_TABS.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.to === '/'} style={({ isActive }) => itemStyle(isActive)}>
            {({ isActive }) => (
              <>
                <Icon name={t.icon} size={21} />
                <span style={{ fontSize: 10, fontWeight: isActive ? 600 : 500 }}>{t.label}</span>
              </>
            )}
          </NavLink>
        ))}

        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          aria-label="More"
          aria-expanded={moreOpen}
          style={itemStyle(moreOpen || onMoreRoute)}
        >
          <Icon name="menu" size={21} />
          <span style={{ fontSize: 10, fontWeight: moreOpen || onMoreRoute ? 600 : 500 }}>More</span>
        </button>
      </nav>

      <MoreMenu open={moreOpen} onClose={() => setMoreOpen(false)} />
    </>
  );
}
