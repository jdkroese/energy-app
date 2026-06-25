export interface NavItem {
  to: string;
  label: string;
  icon: string;
  soon?: boolean;
}

/** Primary nav used by both the mobile tab bar and the desktop rail. */
export const NAV: NavItem[] = [
  { to: '/', label: 'Live', icon: 'activity' },
  { to: '/reports', label: 'Reports', icon: 'bar-chart-3' },
  { to: '/batteries', label: 'Batteries', icon: 'battery-charging' },
  { to: '/devices', label: 'Devices', icon: 'thermometer' },
  { to: '/alerts', label: 'Alerts', icon: 'bell' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
];

/** Secondary destinations surfaced in the rail (and the mobile "More" menu). */
export const NAV_MORE: NavItem[] = [
  { to: '/scenarios', label: 'Scenarios', icon: 'sliders-horizontal' },
  { to: '/brain', label: 'Autopilot', icon: 'sparkles' },
  { to: '/schedules', label: 'Schedules', icon: 'calendar-clock' },
  { to: '/automations', label: 'Automations', icon: 'workflow' },
];

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
