import { Fragment, type CSSProperties } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { Icon } from '../ui/Icon';
import { Eyebrow } from '../ui/Eyebrow';
import { RAIL_SECTIONS, NAV_SETTINGS, navMatches, type NavItem } from './nav';
import { RailAlarmButton } from './NavAlarm';
import { useAuth } from '../../auth/AuthProvider';

type Props = {
  expanded: boolean;
  onToggle: () => void;
};

function railItem(expanded: boolean, isActive: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    height: 42,
    borderRadius: 'var(--radius-md)',
    cursor: 'pointer',
    fontSize: 14,
    fontWeight: isActive ? 600 : 500,
    textDecoration: 'none',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    justifyContent: expanded ? 'flex-start' : 'center',
    gap: expanded ? 11 : 0,
    padding: expanded ? '0 12px' : '0',
    color: isActive ? 'var(--solar)' : 'var(--text-2)',
    background: isActive ? 'var(--solar-wash)' : 'transparent',
    boxShadow: isActive ? 'inset 2px 0 0 var(--solar)' : 'none',
  };
}

/** One rail destination — active state is computed (query-param aware), not NavLink's. */
function RailLink({ item, expanded, active }: { item: NavItem; expanded: boolean; active: boolean }) {
  return (
    <NavLink to={item.to} title={item.label} style={railItem(expanded, active)}>
      <Icon name={item.icon} size={18} />
      {expanded && <span>{item.label}</span>}
    </NavLink>
  );
}

const railDivider = <div style={{ height: 1, background: 'var(--border-1)', margin: '10px 8px' }} />;

/** Rail — desktop collapsing icon-rail (74↔232 px), toggle persisted to localStorage. */
export function Rail({ expanded, onToggle }: Props) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const loc = useLocation();
  const signOut = async () => {
    await logout();
    navigate('/login', { replace: true });
  };
  return (
    <aside
      style={{
        width: expanded ? 232 : 74,
        flex: 'none',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-1)',
        borderRight: '1px solid var(--border-1)',
        padding: '18px 12px',
        transition: 'width .2s',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 11,
          padding: '4px 6px 20px',
          justifyContent: expanded ? 'flex-start' : 'center',
        }}
      >
        <Logo />
        {expanded && <span style={{ fontSize: 19, fontWeight: 700, letterSpacing: '-.02em', color: 'var(--solar)' }}>Power</span>}
      </div>

      {/* Nav list scrolls if the sections outgrow the rail; the bottom group below
          (panic · system · Settings · sign out · collapse) stays pinned. */}
      <nav className="pwr-rail-nav" style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: '1 1 auto', minHeight: 0, overflowY: 'auto' }}>
        {RAIL_SECTIONS.map((section, si) => (
          <Fragment key={si}>
            {si > 0 && railDivider}
            {section.map((n) => (
              <RailLink key={n.to} item={n} expanded={expanded} active={navMatches(n.to, loc)} />
            ))}
          </Fragment>
        ))}
      </nav>

      <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {/* Panic button — always reachable, visually set apart from the nav links. */}
        <RailAlarmButton expanded={expanded} />
        {expanded && (
          <div style={{ padding: 14, borderRadius: 'var(--radius-lg)', background: 'var(--surface-1)', border: '1px solid var(--border-1)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <Eyebrow>System</Eyebrow>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--solar)', fontSize: 12 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--solar)', boxShadow: '0 0 8px var(--solar)' }} />
                Online
              </span>
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-2)', lineHeight: 1.7 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Tesla</span>
                <span style={{ color: 'var(--solar)' }}>cloud ok</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Sonnen</span>
                <span style={{ color: 'var(--solar)' }}>LAN ok</span>
              </div>
            </div>
          </div>
        )}
        {/* Settings pinned here — next to Sign out / Collapse, away from the nav groups. */}
        <RailLink item={NAV_SETTINGS} expanded={expanded} active={navMatches(NAV_SETTINGS.to, loc)} />
        <button
          onClick={() => void signOut()}
          title={user ? `Sign out — ${user.email}` : 'Sign out'}
          style={{
            display: 'flex',
            alignItems: 'center',
            height: 42,
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            color: 'var(--text-2)',
            borderRadius: 'var(--radius-md)',
            fontSize: 14,
            fontWeight: 500,
            justifyContent: expanded ? 'flex-start' : 'center',
            gap: expanded ? 11 : 0,
            padding: expanded ? '0 12px' : '0',
          }}
        >
          <Icon name="log-out" size={18} />
          {expanded && <span>Sign out</span>}
        </button>

        <button
          onClick={onToggle}
          title={expanded ? 'Collapse' : 'Expand'}
          style={{
            display: 'flex',
            alignItems: 'center',
            height: 42,
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
            color: 'var(--text-2)',
            borderRadius: 'var(--radius-md)',
            fontSize: 14,
            fontWeight: 500,
            justifyContent: expanded ? 'flex-start' : 'center',
            gap: expanded ? 11 : 0,
            padding: expanded ? '0 12px' : '0',
          }}
        >
          <Icon name={expanded ? 'chevrons-left' : 'chevrons-right'} size={18} />
          {expanded && <span>Collapse</span>}
        </button>
      </div>
    </aside>
  );
}

function Logo() {
  return (
    <svg width="32" height="32" viewBox="0 0 44 44" fill="none" aria-label="Power">
      <rect x="1" y="1" width="42" height="42" rx="12" fill="#0F1619" stroke="#2EE6A0" strokeOpacity="0.5" strokeWidth="1.5" />
      <path d="M24.5 9 L14 24.2 h6.4 l-2.9 10.8 L31 19.4 h-6.4 z" fill="#2EE6A0" />
    </svg>
  );
}
