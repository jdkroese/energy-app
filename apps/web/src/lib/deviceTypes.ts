/**
 * Device-type registry — the single source of truth for the Devices hub's
 * type grouping. Each device type gets a label, a brand energy-hue (wayfinding
 * only — see the design system: reuse the 5 fixed hues, never invent), and a
 * Lucide icon. Adding a type later (ev, blinds, water…) is one entry here.
 *
 * Classification is currently derived client-side from the connector's
 * `installation` string (Airzone underfloor → heating, otherwise the Intesis
 * AC fleet → cooling). When the API grows a real `type` discriminator on
 * DeviceView (tracked with the #19 schedules work that also touches the devices
 * route), swap `classifyDevice` to read `d.type` directly.
 */

export type DeviceType = 'cooling' | 'heating' | 'lighting' | 'switching';

export interface DeviceTypeMeta {
  type: DeviceType;
  label: string;
  /** Brand energy-hue CSS var — wayfinding tint for the tab dot + accents. */
  hue: string;
  /** Lucide icon name (rendered via the Icon component). */
  icon: string;
  /** Whether this type has a built control surface yet. */
  built: boolean;
}

export const DEVICE_TYPES: DeviceTypeMeta[] = [
  { type: 'cooling', label: 'Cooling', hue: 'var(--solar)', icon: 'snowflake', built: true },
  { type: 'heating', label: 'Heating', hue: 'var(--grid)', icon: 'flame', built: true },
  { type: 'lighting', label: 'Lighting', hue: 'var(--home)', icon: 'lightbulb', built: true },
  { type: 'switching', label: 'Switching', hue: 'var(--battery)', icon: 'toggle-right', built: false },
];

export const typeMeta = (t: DeviceType): DeviceTypeMeta =>
  DEVICE_TYPES.find((m) => m.type === t) ?? DEVICE_TYPES[0];

/** Map a fleet unit to its device type. Prefers the API's `type` discriminator;
 *  falls back to the installation heuristic for older payloads. The API's 'circuit'
 *  maps to the hub's 'switching' tab. */
export function classifyDevice(d: { type?: string | null; installation?: string | null }): DeviceType {
  switch (d.type) {
    case 'heating':
    case 'cooling':
    case 'lighting':
      return d.type;
    case 'circuit':
    case 'switching':
      return 'switching';
    default:
      return (d.installation ?? '').toLowerCase().includes('airzone') ? 'heating' : 'cooling';
  }
}
