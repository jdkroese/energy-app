import { api } from './api';
import type { RoomsResponse } from './types';
import type { UnifiedDevice } from './useRoomDevices';

/* ============================================================================
 * DEV-ONLY Rooms fixture — so the By-room view, Manage-rooms screen, assignment
 * pickers, and the All-off actions can be visually verified when no live Tuya/
 * climate project is connected in dev (the dev API is a fresh instance with no
 * creds, so seeding has no real data). STRICTLY gated: only in a dev build AND
 * only when ?roomsDemo=1 is in the URL. Vite statically replaces import.meta.env.DEV
 * at build time, so this is dead-code-eliminated from the production bundle.
 *
 * Mirrors the Phase-1 ?discoverDemo=1 pattern. It includes the seed-dedupe case
 * (an AC + a light both reporting "Living room" collapse into ONE room) and an
 * Unassigned device, plus a sensitive (lock) device that All-off must skip.
 * ==========================================================================*/

export function roomsDemoActive(): boolean {
  const isDev = (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;
  if (!isDev || typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).has('roomsDemo');
}

const ROOMS = [
  { id: 'r-living', name: 'Living room', icon: 'sofa', order: 0 },
  { id: 'r-kitchen', name: 'Kitchen', icon: 'cooking-pot', order: 1 },
  { id: 'r-bedroom', name: 'Bedroom', icon: 'bed', order: 2 },
];

/** Fixture-aware rooms-list fetcher for usePolling — returns the demo set in dev when
 *  ?roomsDemo=1, else the real endpoint. */
export function roomsListFetcher(): Promise<RoomsResponse> {
  if (roomsDemoActive()) return Promise.resolve(roomsDemoResponse());
  return api.rooms.list();
}

export function roomsDemoResponse(): RoomsResponse {
  const counts: Record<string, number> = { 'r-living': 3, 'r-kitchen': 2, 'r-bedroom': 1 };
  return {
    ts: new Date().toISOString(),
    rooms: ROOMS.map((r) => ({ ...r, deviceCount: counts[r.id] ?? 0 })),
    unassignedCount: 2,
    deviceCount: 8,
    fleetError: null,
  };
}

export function roomsDemoDevices(): UnifiedDevice[] {
  const d = (id: string, name: string, kind: UnifiedDevice['kind'], roomId: string | null, power: boolean, sensitive = false): UnifiedDevice => {
    const meta: Record<UnifiedDevice['kind'], { icon: string; hue: string; href: string }> = {
      cooling: { icon: 'snowflake', hue: 'var(--solar)', href: `/devices/${id}` },
      heating: { icon: 'flame', hue: 'var(--grid)', href: `/devices/${id}` },
      lighting: { icon: 'lightbulb', hue: 'var(--home)', href: '/devices?type=lighting' },
      blinds: { icon: 'blinds', hue: 'var(--ev)', href: '/devices?type=blinds' },
      switching: { icon: 'toggle-right', hue: 'var(--battery)', href: `/devices/generic/${id}` },
    };
    return { id, name, kind, ...meta[kind], roomId, power, sensitive };
  };
  return [
    // Living room — climate + light + blind (the AC and light both said "Living room").
    d('demo-ac-living', 'AC Unit - Living room', 'cooling', 'r-living', true),
    d('demo-light-living', 'Living room lamp', 'lighting', 'r-living', true),
    d('demo-blind-living', 'Living room blind', 'blinds', 'r-living', false),
    // Kitchen — a light + a generic plug.
    d('demo-light-kitchen', 'Kitchen ceiling', 'lighting', 'r-kitchen', false),
    d('demo-plug-kitchen', 'Coffee plug', 'switching', 'r-kitchen', true),
    // Bedroom — one heating zone.
    d('demo-heat-bedroom', 'Heating - Bedroom', 'heating', 'r-bedroom', true),
    // Unassigned — a generic device + a sensitive lock (All-off must skip the lock).
    d('demo-plug-garage', 'Garage plug', 'switching', null, true),
    d('demo-lock-front', 'Front door lock', 'switching', null, false, true),
  ];
}
