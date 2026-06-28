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

// 'irrigation' is a recognized fleet type but has NO Devices-hub tab — Rain Bird
// zones live on the dedicated /irrigation screen (run/stop levers, not climate). It's
// in the union so classifyDevice can tag + EXCLUDE them from the climate hub.
export type DeviceType = 'cooling' | 'heating' | 'lighting' | 'blinds' | 'switching' | 'speakers' | 'irrigation';

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
  { type: 'blinds', label: 'Blinds', hue: 'var(--ev)', icon: 'blinds', built: true },
  { type: 'speakers', label: 'Speakers', hue: 'var(--solar)', icon: 'volume-2', built: true },
  { type: 'switching', label: 'Switching', hue: 'var(--battery)', icon: 'toggle-right', built: false },
];

export const typeMeta = (t: DeviceType): DeviceTypeMeta =>
  DEVICE_TYPES.find((m) => m.type === t) ?? DEVICE_TYPES[0];

/* ---- Onboarding (Phase 2) generic-device types -----------------------------
 * A set-up generic device's `typeId` is EITHER a built-in DeviceType key OR a
 * user-minted custom type id ('custom-…'). The setup picker offers both. Generic
 * (non-bespoke) devices land in the 'switching' tab or a custom tab — they never
 * touch the bespoke Cooling/Heating/Lighting/Blinds screens. */

import type { CustomDeviceType } from './types';

/** Resolved meta for any typeId (built-in or custom) — label, icon, hue. */
export interface ResolvedTypeMeta {
  id: string;
  label: string;
  icon: string;
  hue: string;
  /** True for a store-backed custom type (vs a built-in DeviceType). */
  custom: boolean;
}

/** Cycle the 5 brand hues for custom types so each gets a stable wayfinding tint. */
const CUSTOM_HUES = ['var(--solar)', 'var(--grid)', 'var(--home)', 'var(--ev)', 'var(--battery)'];

/** Resolve a configured device's typeId to display meta, consulting custom types. */
export function resolveTypeMeta(typeId: string, custom: CustomDeviceType[] = []): ResolvedTypeMeta {
  const builtin = DEVICE_TYPES.find((m) => m.type === typeId);
  if (builtin) return { id: builtin.type, label: builtin.label, icon: builtin.icon, hue: builtin.hue, custom: false };
  const idx = custom.findIndex((c) => c.id === typeId);
  if (idx >= 0) {
    const c = custom[idx];
    return { id: c.id, label: c.label, icon: c.icon, hue: CUSTOM_HUES[idx % CUSTOM_HUES.length], custom: true };
  }
  // Unknown typeId — fall back to the generic Switching bucket so it's never orphaned.
  const sw = typeMeta('switching');
  return { id: 'switching', label: sw.label, icon: sw.icon, hue: sw.hue, custom: false };
}

/** Built-in types offered in the setup picker. Generic devices map to Switching or
 *  a custom type; the bespoke Cooling/Heating/Lighting/Blinds screens are NOT setup
 *  targets (discovery never surfaces those categories), so we offer Switching + customs.
 *  We still list all built-ins so a mis-discovered device can be re-pointed if needed. */
export const SETUP_BUILTIN_TYPES: DeviceTypeMeta[] = DEVICE_TYPES;

/** Map a fleet unit to its device type. Prefers the API's `type` discriminator;
 *  falls back to the installation heuristic for older payloads. The API's 'circuit'
 *  maps to the hub's 'switching' tab. */
export function classifyDevice(d: { type?: string | null; installation?: string | null }): DeviceType {
  switch (d.type) {
    case 'heating':
    case 'cooling':
    case 'lighting':
      return d.type;
    case 'irrigation':
      // Rain Bird zones merge into /api/devices but are surfaced on the dedicated
      // /irrigation screen — tag them so the climate hub filters can exclude them.
      return 'irrigation';
    case 'circuit':
    case 'switching':
      return 'switching';
    default:
      return (d.installation ?? '').toLowerCase().includes('airzone') ? 'heating' : 'cooling';
  }
}
