import { useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { Rail } from './Rail';
import { TabBar } from './TabBar';
import { TopBar } from './TopBar';
import { SegmentedControl } from '../ui/SegmentedControl';
import { useMediaQuery } from './useMediaQuery';
import { settingsTabsFor } from './nav';
import { useAuth } from '../../auth/AuthProvider';

/** Per-route desktop TopBar metadata. */
const META: Record<string, { eyebrow: string; title: string }> = {
  '/': { eyebrow: 'Live overview', title: 'Your home, right now' },
  '/reports': { eyebrow: 'Reports', title: 'Reports' },
  '/batteries': { eyebrow: 'Batteries', title: 'Sonnen + Tesla' },
  '/devices': { eyebrow: 'Home', title: 'Devices' },
  '/alerts': { eyebrow: 'Alerts', title: 'Notifications' },
  '/settings': { eyebrow: 'Settings', title: 'System' },
  '/scenarios': { eyebrow: 'Scenarios', title: 'Strategy profiles' },
};

const RAIL_KEY = 'power.rail.expanded';

export interface ShellContext {
  /** true on desktop (≥ md) */
  desktop: boolean;
  /** reports range, shared so the TopBar control drives the screen */
  range: string;
  setRange: (r: string) => void;
  /** active Settings sub-tab, shared so the TopBar tab strip drives the screen */
  settingsTab: string;
  setSettingsTab: (t: string) => void;
}

/** AppShell — responsive frame: TabBar on mobile, collapsing Rail on desktop. */
export function AppShell({ children }: { children: (ctx: ShellContext) => ReactNode }) {
  const desktop = useMediaQuery('(min-width: 768px)');
  const location = useLocation();
  const [expanded, setExpanded] = useState<boolean>(() => {
    try {
      return localStorage.getItem(RAIL_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [range, setRange] = useState('Month');
  const { user } = useAuth();
  const settingsTabs = settingsTabsFor(user?.role === 'admin');
  const [settingsTab, setSettingsTab] = useState<string>('Connections');
  const activeSettingsTab = (settingsTabs as readonly string[]).includes(settingsTab) ? settingsTab : 'Connections';

  useEffect(() => {
    try {
      localStorage.setItem(RAIL_KEY, expanded ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [expanded]);

  const meta =
    META[location.pathname] ||
    (location.pathname.startsWith('/batteries/') ? { eyebrow: 'Batteries', title: 'Battery detail' } : { eyebrow: 'Power', title: '' });
  const ctx: ShellContext = { desktop, range, setRange, settingsTab: activeSettingsTab, setSettingsTab };

  if (desktop) {
    return (
      <div style={{ display: 'flex', height: '100%' }}>
        <Rail expanded={expanded} onToggle={() => setExpanded((v) => !v)} />
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', height: '100%' }}>
          <TopBar
            eyebrow={meta.eyebrow}
            title={
              location.pathname === '/reports'
                ? range === 'Hour'
                  ? 'Past hour'
                  : range === 'Day'
                    ? 'Today'
                    : `This ${range.toLowerCase()}`
                : meta.title
            }
            actions={
              location.pathname === '/reports' ? (
                <SegmentedControl options={['Hour', 'Day', 'Week', 'Month', 'Year']} value={range} onChange={setRange} size="sm" />
              ) : null
            }
          />
          <div style={{ flex: 1, overflowY: 'auto', padding: '22px 28px 40px' }}>{children(ctx)}</div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', paddingTop: 'env(safe-area-inset-top)' }}>
      <div style={{ flex: 1, overflowY: 'auto' }}>{children(ctx)}</div>
      <TabBar />
    </div>
  );
}
