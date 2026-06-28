import { useMemo } from 'react';
import { usePolling } from './usePolling';
import { api } from './api';
import type {
  DevicesResponse, LightsResponse, BlindsResponse, ConfiguredResponse,
} from './types';
import { roomsDemoActive, roomsDemoDevices } from './roomsDemo';

/* ============================================================================
 * useRoomDevices — a unified, room-aware view of every device across all types
 * (climate AC/heating, Tuya lights, blinds, configured generic). Each entry carries
 * the SAME roomId the By-type views resolve, so a device shows the same room in both
 * lenses. Used by the By-room view and the Manage-rooms quick-bin.
 * ==========================================================================*/

export type UnifiedKind = 'cooling' | 'heating' | 'lighting' | 'blinds' | 'switching';

export interface UnifiedDevice {
  id: string;
  name: string;
  kind: UnifiedKind;
  /** Lucide icon for the kind. */
  icon: string;
  hue: string;
  roomId: string | null;
  /** Best-effort on/off (used to badge state in the room cards). */
  power: boolean;
  /** Detail route for tapping through. */
  href: string;
  /** True when this device carries a sensitive action cap (lock/siren/gate) — excluded
   *  from room All-off and badged in the UI. */
  sensitive: boolean;
}

const KIND_META: Record<UnifiedKind, { icon: string; hue: string }> = {
  cooling: { icon: 'snowflake', hue: 'var(--solar)' },
  heating: { icon: 'flame', hue: 'var(--grid)' },
  lighting: { icon: 'lightbulb', hue: 'var(--home)' },
  blinds: { icon: 'blinds', hue: 'var(--ev)' },
  switching: { icon: 'toggle-right', hue: 'var(--battery)' },
};

export interface RoomDevicesData {
  devices: UnifiedDevice[];
  loading: boolean;
  refetch: () => void;
}

export function useRoomDevices(pollMs = 20_000): RoomDevicesData {
  const { data: dev, loading: l1, refetch: r1 } = usePolling<DevicesResponse>(api.devices.list, pollMs);
  const { data: lights, loading: l2, refetch: r2 } = usePolling<LightsResponse>(api.lights.list, pollMs);
  const { data: blinds, loading: l3, refetch: r3 } = usePolling<BlindsResponse>(api.blinds.list, pollMs);
  const { data: configured, loading: l4, refetch: r4 } = usePolling<ConfiguredResponse>(api.devices.configured, pollMs);

  const devices = useMemo<UnifiedDevice[]>(() => {
    const out: UnifiedDevice[] = [];

    for (const d of dev?.devices ?? []) {
      const kind: UnifiedKind = d.type === 'heating' ? 'heating' : 'cooling';
      out.push({
        id: d.id, name: d.name, kind, ...KIND_META[kind],
        roomId: d.roomId ?? null, power: d.power, href: `/devices/${d.id}`, sensitive: false,
      });
    }
    for (const u of lights?.devices ?? []) {
      out.push({
        id: u.id, name: u.name, kind: 'lighting', ...KIND_META.lighting,
        roomId: u.roomId ?? null, power: u.power, href: '/devices?type=lighting', sensitive: false,
      });
    }
    for (const u of blinds?.devices ?? []) {
      out.push({
        id: u.id, name: u.name, kind: 'blinds', ...KIND_META.blinds,
        roomId: u.roomId ?? null, power: (u.positionPct ?? 0) > 2, href: '/devices?type=blinds', sensitive: false,
      });
    }
    for (const c of configured?.devices ?? []) {
      // Configured-as-lighting devices are already surfaced in the lights fleet; skip dups.
      if (c.typeId === 'lighting' && out.some((x) => x.id === c.id)) continue;
      const kind: UnifiedKind = c.typeId === 'lighting' ? 'lighting' : 'switching';
      const sw = c.capabilities.find((cap) => cap.kind === 'switch' && !cap.readOnly);
      const power = sw ? c.values[sw.dp] === true : false;
      const sensitive = c.capabilities.some((cap) => cap.sensitive === true);
      out.push({
        id: c.id, name: c.name, kind, ...KIND_META[kind],
        roomId: c.roomId ?? null, power, href: `/devices/generic/${c.id}`, sensitive,
      });
    }
    return out;
  }, [dev, lights, blinds, configured]);

  // DEV-only fixture (?roomsDemo=1): bypass the live fleets so the room views can be
  // verified with no connected project. Never runs in production (DCE'd).
  if (roomsDemoActive()) {
    return { devices: roomsDemoDevices(), loading: false, refetch: () => {} };
  }

  return {
    devices,
    loading: l1 || l2 || l3 || l4,
    refetch: () => { r1(); r2(); r3(); r4(); },
  };
}
