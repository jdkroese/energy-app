export interface NavItem {
  to: string;
  label: string;
  icon: string;
  soon?: boolean;
}

/* ============================================================================
 * Navigation model. The menu is grouped into ordered sections; the desktop Rail
 * draws a divider between each section and pins Settings + Sign out at the bottom.
 * The mobile bottom bar shows a compact set of tabs and folds the rest into the
 * grouped "More" sheet. Add a destination to a section here and it shows up in
 * both surfaces.
 * ==========================================================================*/

/** Top section — the at-a-glance screens, above the first divider. */
export const NAV_TOP: NavItem[] = [
  { to: '/', label: 'Live', icon: 'activity' },
  { to: '/reports', label: 'Reports', icon: 'chart-column' },
];

/** Devices section — Energy (solar + batteries) + per-category shortcuts, then the all-devices hub.
 *  The category links carry a ?type= query that the Devices screen reads to open
 *  straight onto that category's listing. "Other devices" (no query) lands on the
 *  category-tile overview. Icons/hues mirror the device-type registry. */
export const NAV_DEVICES: NavItem[] = [
  // Energy hub = solar generation (Sungrow inverters) + battery storage (Sonnen + Tesla).
  { to: '/batteries', label: 'Energy', icon: 'zap' },
  // Water hub (docs/51) = the BI-WATER meter + Irrigation (merged from the former
  // standalone /irrigation page — same pattern as Solar Inverters -> Energy).
  // A resource hub like Energy, so it sits right after it — not a device category.
  // 'waves', NOT 'droplet'/'droplets' — droplets was the old Irrigating icon and
  // two near-identical drop glyphs this close in the rail would misread.
  { to: '/water', label: 'Water', icon: 'waves' },
  { to: '/devices?type=lighting', label: 'Lighting', icon: 'lightbulb' },
  { to: '/devices?type=cooling', label: 'Cooling', icon: 'snowflake' },
  { to: '/devices?type=heating', label: 'Heating', icon: 'flame' },
  { to: '/devices', label: 'Other devices', icon: 'layout-grid' },
];

/** Media section — the Music (Spotify + radio) experience, its own dedicated route. */
export const NAV_MEDIA: NavItem[] = [
  { to: '/music', label: 'Music', icon: 'music' },
];

/** Kitchen section — the Cooking + Groceries hub (docs/38 D4), between Media and Automation. */
export const NAV_KITCHEN: NavItem[] = [
  { to: '/cooking', label: 'Cooking', icon: 'chef-hat' },
  { to: '/groceries', label: 'Groceries', icon: 'shopping-basket' },
];

/** Automation section — below a second divider. */
export const NAV_AUTOMATION: NavItem[] = [
  // Autopilot folded into Automations (Summary · Schedules · Smart Rules · Events ·
  // Status); /brain redirects there. Keeps Autopilot's sparkles icon. Its Settings
  // panel (arm/mode + manual controls) lives on /settings?tab=autopilot.
  { to: '/automations', label: 'Automations', icon: 'sparkles' },
  { to: '/scenarios', label: 'Scenarios', icon: 'sliders-horizontal' },
];

/** Settings — pinned to the bottom of the rail next to Sign out / Collapse. */
export const NAV_SETTINGS: NavItem = { to: '/settings', label: 'Settings', icon: 'settings' };

/** Ordered rail sections — a divider is drawn between each. */
export const RAIL_SECTIONS: NavItem[][] = [NAV_TOP, NAV_DEVICES, NAV_MEDIA, NAV_KITCHEN, NAV_AUTOMATION];

/**
 * Active-state match for a nav `to` that may carry a ?type= query (the device
 * shortcuts). NavLink only compares pathname, so the category links would all
 * light up together on /devices — this disambiguates by the `type` param, and
 * treats the query-less "Other devices" link as the overview (no type) only.
 */
export function navMatches(to: string, loc: { pathname: string; search: string }): boolean {
  const qIdx = to.indexOf('?');
  const path = qIdx === -1 ? to : to.slice(0, qIdx);
  const wantType = qIdx === -1 ? null : new URLSearchParams(to.slice(qIdx)).get('type');
  if (path === '/devices') {
    // Category shortcut (?type=…) lights up only on its own type's listing.
    if (wantType) return loc.pathname === '/devices' && new URLSearchParams(loc.search).get('type') === wantType;
    // "Other devices" (no type) = the overview, and the fallback for any device
    // detail page (/devices/:id), whose category isn't known from the URL alone.
    if (loc.pathname.startsWith('/devices/')) return true;
    return loc.pathname === '/devices' && !new URLSearchParams(loc.search).get('type');
  }
  if (path === '/') return loc.pathname === '/';
  return loc.pathname === path || loc.pathname.startsWith(`${path}/`);
}

/* ---- Mobile ----------------------------------------------------------------
 * The bottom bar stays compact (Live · Reports · Energy · Devices + More); the
 * category shortcuts, automation group and Settings live in the grouped More
 * sheet so the whole app is reachable on a phone. */
export const MOBILE_TABS: NavItem[] = [
  NAV_TOP[0], // Live
  NAV_TOP[1], // Reports
  NAV_DEVICES[0], // Energy (solar + batteries)
  { to: '/devices', label: 'Devices', icon: 'layout-grid' },
];

/** Paths already covered by a bottom tab — excluded from the More sheet. */
const MOBILE_BOTTOM_PATHS = MOBILE_TABS.map((t) => t.to);

/** Grouped destinations in the More sheet (each rendered under a section header). */
export const MOBILE_MORE_SECTIONS: { title: string; items: NavItem[] }[] = [
  // Category shortcuts (Energy + the all-devices hub are on the bottom bar already).
  { title: 'Devices', items: NAV_DEVICES.filter((n) => !MOBILE_BOTTOM_PATHS.includes(n.to)) },
  { title: 'Media', items: NAV_MEDIA },
  { title: 'Kitchen', items: NAV_KITCHEN },
  { title: 'Automation', items: NAV_AUTOMATION },
  { title: 'Account', items: [NAV_SETTINGS] },
];

/** Flat list of every More destination — used to highlight the bottom "More" tab. */
export const MOBILE_MORE: NavItem[] = MOBILE_MORE_SECTIONS.flatMap((s) => s.items);

/** Paths a route can live "behind" the More tab (excludes anything on the bottom bar). */
export const MOBILE_MORE_PATHS: string[] = MOBILE_MORE.map((n) => n.to.split('?')[0]).filter(
  (p) => !MOBILE_BOTTOM_PATHS.includes(p),
);

/**
 * Settings sub-tabs — rendered Reports-style in the desktop TopBar (active tab is
 * the title; the tab strip is the TopBar action), and as a SegmentedControl on
 * mobile. Shared by AppShell + the Settings screen so both agree on the set.
 * 'Users' is admin-only. Autopilot (the battery arm/mode + manual-controls panel,
 * relocated from /automations) leads the strip — it's the home's control authority.
 * Tabs deep-link as /settings?tab=<lowercase label>, e.g. /settings?tab=autopilot.
 */
export const SETTINGS_TABS = ['Autopilot', 'Connections', 'Notifications', 'Security', 'Users', 'System'] as const;
export type SettingsTabLabel = (typeof SETTINGS_TABS)[number];
export function settingsTabsFor(isAdmin: boolean): SettingsTabLabel[] {
  return SETTINGS_TABS.filter((t) => t !== 'Users' || isAdmin);
}

/** Map a ?tab= query value (lowercase, e.g. 'autopilot') to its tab label; null when unknown. */
export function settingsTabFromParam(param: string | null): SettingsTabLabel | null {
  if (!param) return null;
  return SETTINGS_TABS.find((t) => t.toLowerCase() === param.toLowerCase()) ?? null;
}
