import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { Rail } from './Rail';
import { TabBar } from './TabBar';
import { TopBar } from './TopBar';
import { PageTransition } from './PageTransition';
// Kiosk frame + its 4 tablet screens (~1k lines) only load when wall-tablet mode
// is on — lazy so normal web/mobile users never download them.
const TabletShell = lazy(() => import('./TabletShell').then((m) => ({ default: m.TabletShell })));
import { MobileAlarmFab } from './NavAlarm';
import { MobileMiniPlayer } from './NavMiniPlayer';
import { MobileWatering } from './NavIrrigation';
import { SegmentedControl } from '../ui/SegmentedControl';
import { useMediaQuery } from './useMediaQuery';
import { settingsTabsFor, settingsTabFromParam } from './nav';
import { useKiosk } from '../../lib/kiosk';
import { useAuth } from '../../auth/AuthProvider';

/** Per-route desktop TopBar metadata. */
const META: Record<string, { eyebrow: string; title: string }> = {
  '/': { eyebrow: 'Live overview', title: 'Your home, right now' },
  '/reports': { eyebrow: 'Reports', title: 'Reports' },
  '/batteries': { eyebrow: 'Energy', title: 'Solar & batteries' },
  '/devices': { eyebrow: 'Home', title: 'Devices' },
  '/irrigation': { eyebrow: 'Home', title: 'Irrigation' },
  '/rooms': { eyebrow: 'Home', title: 'Rooms' },
  '/alerts': { eyebrow: 'Alerts', title: 'Notifications' },
  // /settings title is dynamic — the TopBar shows the active Settings tab (Reports-style).
  '/settings': { eyebrow: 'Settings', title: 'Settings' },
  '/scenarios': { eyebrow: 'Scenarios', title: 'Strategy profiles' },
  '/automations': { eyebrow: 'Home', title: 'Automations' },
  '/music': { eyebrow: 'Media', title: 'Music' },
  '/cooking': { eyebrow: 'Kitchen', title: 'Cooking' },
  '/groceries': { eyebrow: 'Kitchen', title: 'Groceries' },
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
  const kiosk = useKiosk();
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
  // Deep-links win: /settings?tab=autopilot (lowercase param → tab label) selects the
  // tab directly; otherwise the last state-selected tab, falling back to Connections.
  const urlSettingsTab =
    location.pathname === '/settings' ? settingsTabFromParam(new URLSearchParams(location.search).get('tab')) : null;
  const activeSettingsTab =
    urlSettingsTab && (settingsTabs as readonly string[]).includes(urlSettingsTab)
      ? urlSettingsTab
      : (settingsTabs as readonly string[]).includes(settingsTab)
        ? settingsTab
        : 'Connections';

  useEffect(() => {
    try {
      localStorage.setItem(RAIL_KEY, expanded ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [expanded]);

  const meta =
    META[location.pathname] ||
    (location.pathname.startsWith('/batteries/')
      ? { eyebrow: 'Energy', title: 'Battery detail' }
      : location.pathname.startsWith('/cook/')
        ? { eyebrow: 'Kitchen', title: 'Cooking mode' }
        : { eyebrow: 'Home', title: '' });
  const ctx: ShellContext = { desktop, range, setRange, settingsTab: activeSettingsTab, setSettingsTab };

  // Wall-tablet (kiosk) mode swaps the whole frame — its own nav + routes, so it
  // renders standalone (no children render-prop). Checked before desktop/mobile.
  if (kiosk)
    return (
      <Suspense fallback={null}>
        <TabletShell />
      </Suspense>
    );

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
                : location.pathname === '/settings'
                  ? activeSettingsTab
                  : meta.title
            }
            actions={
              location.pathname === '/reports' ? (
                <SegmentedControl options={['Hour', 'Day', 'Week', 'Month', 'Year']} value={range} onChange={setRange} size="sm" />
              ) : null
            }
          />
          <div style={{ flex: 1, overflowY: 'auto', padding: '22px 28px 40px' }}>
            {/* Keyed on pathname so the body re-animates on each navigation. The
                persistent shell (Rail / TopBar) above stays steady — only this
                scroll-container body fades+rises in. */}
            <PageTransition key={location.pathname}>{children(ctx)}</PageTransition>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', paddingTop: 'env(safe-area-inset-top)' }}>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {/* Mobile: same shared transition; TabBar / FAB below stay steady. */}
        <PageTransition key={location.pathname}>{children(ctx)}</PageTransition>
      </div>
      <MobileAlarmFab />
      {/* Slim bars above the TabBar (clear of the alarm FAB); each hidden when idle:
          watering-now (active irrigation) then now-playing (music). */}
      <MobileWatering />
      <MobileMiniPlayer />
      <TabBar />
    </div>
  );
}
