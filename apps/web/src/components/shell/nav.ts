export interface NavItem {
  to: string;
  label: string;
  icon: string;
  soon?: boolean;
}

/** Primary nav used by both the mobile tab bar and the desktop rail. */
export const NAV: NavItem[] = [
  { to: '/', label: 'Live', icon: 'activity' },
  { to: '/reports', label: 'Reports', icon: 'chart-column' },
  { to: '/batteries', label: 'Batteries', icon: 'battery-charging' },
  { to: '/devices', label: 'Devices', icon: 'thermometer' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
];

/** Secondary destinations surfaced in the rail (and the mobile "More" menu). */
export const NAV_MORE: NavItem[] = [
  { to: '/irrigation', label: 'Irrigation', icon: 'droplets' },
  { to: '/scenarios', label: 'Scenarios', icon: 'sliders-horizontal' },
  // Autopilot folded into Automations (Summary · Schedules · Smart Rules · Events ·
  // Status · Settings); /brain redirects there. Keeps Autopilot's sparkles icon.
  { to: '/automations', label: 'Automations', icon: 'sparkles' },
  { to: '/button-test', label: 'Button test', icon: 'radio' },
];

/**
 * Mobile navigation. The bottom bar shows these four primary tabs plus a "More"
 * button; everything else lives in the More menu. Both lists derive from
 * NAV + NAV_MORE so the mobile nav can never silently drop a page the desktop
 * rail exposes — add a destination once and it shows up in both.
 */
const MOBILE_PRIMARY_PATHS = ['/', '/reports', '/batteries', '/devices'];
export const MOBILE_TABS: NavItem[] = MOBILE_PRIMARY_PATHS.map(
  (p) => NAV.find((n) => n.to === p)!,
).filter(Boolean);
export const MOBILE_MORE: NavItem[] = [...NAV, ...NAV_MORE].filter(
  (n) => !MOBILE_PRIMARY_PATHS.includes(n.to),
);

/**
 * Settings sub-tabs — rendered Reports-style in the desktop TopBar (active tab is
 * the title; the tab strip is the TopBar action), and as a SegmentedControl on
 * mobile. Shared by AppShell + the Settings screen so both agree on the set.
 * 'Users' is admin-only.
 */
export const SETTINGS_TABS = ['Connections', 'Notifications', 'Security', 'Users', 'System'] as const;
export type SettingsTabLabel = (typeof SETTINGS_TABS)[number];
export function settingsTabsFor(isAdmin: boolean): SettingsTabLabel[] {
  return SETTINGS_TABS.filter((t) => t !== 'Users' || isAdmin);
}
