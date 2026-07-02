import { Fragment, type CSSProperties } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { Icon } from '../ui/Icon';
import { Eyebrow } from '../ui/Eyebrow';
import { RAIL_SECTIONS, NAV_SETTINGS, navMatches, type NavItem } from './nav';
import { RailAlarmButton } from './NavAlarm';
import { RailMiniPlayer } from './NavMiniPlayer';
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
        {expanded && <span style={{ fontSize: 19, fontWeight: 700, letterSpacing: '-.02em', color: 'var(--solar)' }}>Home</span>}
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
        {/* Global now-playing mini player — sits above the footer controls, shows
            whatever's playing (Spotify/radio); renders nothing when idle. */}
        <RailMiniPlayer expanded={expanded} />
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
        {/* Footer controls — one icon-only line: Settings · Sign out · Pin. The pin
            keeps the old collapse/expand behaviour (pinned-open ↔ collapsed); only
            its icon + inline placement changed. Expanded → a horizontal row; the
            narrow collapsed rail stacks them into a single icon column. */}
        <div
          style={{
            display: 'flex',
            flexDirection: expanded ? 'row' : 'column',
            alignItems: 'center',
            justifyContent: expanded ? 'space-between' : 'center',
            gap: expanded ? 4 : 6,
            padding: expanded ? '0 4px' : 0,
          }}
        >
          <NavLink
            to={NAV_SETTINGS.to}
            aria-label="Settings"
            title="Settings"
            style={{ ...footerIconBtn, ...(navMatches(NAV_SETTINGS.to, loc) ? footerIconActive : null) }}
          >
            <Icon name="settings" size={18} />
          </NavLink>
          <button
            type="button"
            onClick={() => void signOut()}
            aria-label="Log out"
            title={user ? `Log out — ${user.email}` : 'Log out'}
            style={footerIconBtn}
          >
            <Icon name="log-out" size={18} />
          </button>
          <button
            type="button"
            onClick={onToggle}
            aria-label={expanded ? 'Unpin the sidebar' : 'Pin the sidebar open'}
            title={expanded ? 'Unpin the sidebar' : 'Pin the sidebar open'}
            aria-pressed={expanded}
            style={{ ...footerIconBtn, ...(expanded ? footerIconActive : null) }}
          >
            <Icon name={expanded ? 'pin' : 'pin-off'} size={18} />
          </button>
        </div>
      </div>
    </aside>
  );
}

/** Shared icon-only footer button (settings / logout / pin). */
const footerIconBtn: CSSProperties = {
  display: 'grid',
  placeItems: 'center',
  width: 38,
  height: 38,
  flex: 'none',
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  color: 'var(--text-2)',
  borderRadius: 'var(--radius-md)',
  textDecoration: 'none',
};
const footerIconActive: CSSProperties = { color: 'var(--solar)', background: 'var(--solar-wash)' };

function Logo() {
  return (
    <svg width="32" height="32" viewBox="0 0 44 44" fill="none" aria-label="Home">
      <rect x="1" y="1" width="42" height="42" rx="12" fill="#0F1619" stroke="#2EE6A0" strokeOpacity="0.5" strokeWidth="1.5" />
      {/* House glyph: pitched roof + body, matching the green control-room accent. */}
      <path
        d="M22 10 L33 19.4 V21 h-2.4 v12.2 a1.4 1.4 0 0 1 -1.4 1.4 h-4.6 v-7.4 h-5.2 v7.4 h-4.6 a1.4 1.4 0 0 1 -1.4 -1.4 V21 H11 v-1.6 z"
        fill="#2EE6A0"
      />
    </svg>
  );
}
