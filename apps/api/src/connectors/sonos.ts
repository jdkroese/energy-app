// Sonos connector — local UPnP discovery + control of the home's Sonos speakers
// for the HOUSE ALARM (Phase 1: a siren). Pure-LAN, no cloud/OAuth: the API runs
// on the Mac mini on the SAME network as the speakers, so discovery is SSDP
// multicast (239.255.255.250:1900) with a seed-IP fallback when multicast is
// blocked (Docker/VLAN). Mirrors the shape of `airzone.ts` (isConfigured / getFleet
// / getInfo + a small set of control primitives) so it slots into the same patterns.
//
// Library: @svrooij/sonos (node-sonos-ts) — pure-JS, no native deps.
//
// The siren uses PlayNotification (UPnP takeover): it snapshots the current playback,
// plays the clip at a forced volume, and RESTORES the prior track/queue/volume after —
// so it is non-destructive to the owner's Sonos/Spotify setup. The clip is served by
// this API over the LAN (see routes/media.ts); the speakers fetch it by URL.
//
// NOT VALIDATED against real hardware in this build (no Sonos on the CI LAN). Live
// discovery + siren must be smoke-tested on the mini — see scripts/sonos-discover.mjs
// and scripts/sonos-siren-test.mjs.

import { SonosManager } from '@svrooij/sonos';
import type SonosDevice from '@svrooij/sonos/lib/sonos-device';
import * as store from '../store';

// ---- Config -----------------------------------------------------------------

/** Sonos is enabled by default — discovery is zero-config on the LAN. A seed IP can
 *  be set (store first, then env SONOS_SEED_IP) for networks where multicast is blocked. */
function cfg(): { enabled: boolean; seedIp?: string } {
  const integrations = store.get().integrations as {
    sonos?: { enabled?: boolean; seedIp?: string } | null;
  };
  const s = integrations.sonos ?? null;
  const enabled = s?.enabled ?? true; // default ENABLED
  const seedIp = (s?.seedIp || process.env.SONOS_SEED_IP || '').trim() || undefined;
  return { enabled, seedIp };
}

/** Sonos is "configured" when enabled. Discovery itself is automatic on the LAN. */
export function isConfigured(): boolean {
  return cfg().enabled;
}

// ---- Normalized shapes ------------------------------------------------------

export interface SonosSpeaker {
  /** Stable Sonos UUID (RINCON_…). */
  id: string;
  name: string;
  /** Group UUID this speaker belongs to. */
  group: string;
  /** Friendly group name (usually the coordinator's room name). */
  groupName: string;
  /** True when this speaker is its group's coordinator. */
  coordinator: boolean;
  /** Current volume 0–100, or null when not yet read. */
  volumePct: number | null;
  online: boolean;
}

// ---- Manager cache ----------------------------------------------------------
// One SonosManager is kept alive (it holds UPnP event subscriptions for group
// tracking). The device list is refreshed lazily (~30s) so reads stay cheap and a
// single bad read never blanks the fleet (soft-fail: keep the last good snapshot).

const REFRESH_MS = 30_000;

let manager: SonosManager | null = null;
let initPromise: Promise<SonosManager | null> | null = null;
let lastFleet: SonosSpeaker[] = [];
let lastFleetAt = 0;
let lastError: string | null = null;
let discoveredCount = 0;

/** Lazily create + initialize the manager (discovery, or seed-IP fallback). Returns
 *  null when Sonos is disabled or no device could be found. Concurrent callers share
 *  the same in-flight init. */
async function getManager(): Promise<SonosManager | null> {
  if (!isConfigured()) return null;
  if (manager) return manager;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const m = new SonosManager();
    const { seedIp } = cfg();
    try {
      // PRIMARY (robust): topology-based init from one known speaker. On multi-NIC hosts
      // (the mini may carry a Hyper-V/Docker vSwitch) SSDP multicast can leave the wrong
      // interface and discover NOTHING, whereas InitializeFromDevice queries that one
      // speaker's ZoneGroupTopology and reliably learns ALL zones. Owner-validated against
      // the real 8-zone / 13-player system. FALLBACK: multicast discovery when no seed IP
      // is configured (zero-config on a simple single-NIC LAN).
      let ok = false;
      if (seedIp) {
        ok = await m.InitializeFromDevice(seedIp);
      } else {
        ok = await m.InitializeWithDiscovery(5);
      }
      if (!ok || m.Devices.length === 0) {
        lastError = seedIp
          ? `no Sonos device reachable at seed ${seedIp}`
          : 'no Sonos devices discovered on the LAN — multicast may be blocked on a multi-NIC host; set a seed IP (SONOS_SEED_IP / Settings) for the robust topology-based path';
        try {
          m.CancelSubscription();
        } catch {
          /* nothing to clean up */
        }
        return null;
      }
      manager = m;
      lastError = null;
      return m;
    } catch (e) {
      lastError = (e as Error).message || 'Sonos init failed';
      try {
        m.CancelSubscription();
      } catch {
        /* ignore */
      }
      return null;
    } finally {
      initPromise = null;
    }
  })();
  return initPromise;
}

/** Drop the cached manager (forces a fresh discovery on the next call). Used by the
 *  Settings "Re-scan" action and when the seed IP / enabled flag changes. */
export function resetManager(): void {
  if (manager) {
    try {
      manager.CancelSubscription();
    } catch {
      /* ignore */
    }
  }
  manager = null;
  initPromise = null;
  lastFleet = [];
  lastFleetAt = 0;
}

function normalize(d: SonosDevice): SonosSpeaker {
  const coordUuid = (() => {
    try {
      return d.Coordinator?.Uuid;
    } catch {
      return d.Uuid;
    }
  })();
  return {
    id: d.Uuid,
    name: d.Name,
    group: coordUuid || d.Uuid,
    groupName: d.GroupName || d.Name,
    coordinator: coordUuid === d.Uuid,
    // `.Volume` is populated by event subscriptions; may be undefined until the
    // first event/read. We refresh it explicitly in refreshFleet().
    volumePct: typeof d.Volume === 'number' ? d.Volume : null,
    online: true,
  };
}

/** Refresh the cached fleet (volume read per speaker, best-effort). Soft-fails to the
 *  last good snapshot so a transient error doesn't blank the UI. */
async function refreshFleet(force = false): Promise<SonosSpeaker[]> {
  const m = await getManager();
  if (!m) {
    discoveredCount = 0;
    return lastFleet; // keep last snapshot; lastError carries the reason
  }
  if (!force && Date.now() - lastFleetAt < REFRESH_MS && lastFleet.length > 0) {
    return lastFleet;
  }
  try {
    const devices = m.Devices;
    discoveredCount = devices.length;
    const speakers = await Promise.all(
      devices.map(async (d) => {
        const s = normalize(d);
        // Pull a live volume so the slider reflects reality even before an event lands.
        try {
          const r = await d.RenderingControlService.GetVolume({ InstanceID: 0, Channel: 'Master' });
          if (typeof r.CurrentVolume === 'number') s.volumePct = r.CurrentVolume;
        } catch {
          /* keep whatever .Volume gave us */
        }
        return s;
      }),
    );
    lastFleet = speakers;
    lastFleetAt = Date.now();
    lastError = null;
    return speakers;
  } catch (e) {
    lastError = (e as Error).message || 'Sonos read failed';
    return lastFleet;
  }
}

// ---- Reads ------------------------------------------------------------------

/** All discovered speakers (cached ~30s). */
export async function getFleet(): Promise<SonosSpeaker[]> {
  if (!isConfigured()) return [];
  return refreshFleet();
}

/** Integration status for the Settings panel. */
export async function getInfo(): Promise<{
  configured: boolean;
  enabled: boolean;
  seedIp: string | null;
  discoveredCount: number;
  names: string[];
  lastError: string | null;
}> {
  const c = cfg();
  if (!c.enabled) {
    return { configured: false, enabled: false, seedIp: c.seedIp ?? null, discoveredCount: 0, names: [], lastError: null };
  }
  const fleet = await getFleet();
  return {
    configured: true,
    enabled: true,
    seedIp: c.seedIp ?? null,
    discoveredCount: discoveredCount || fleet.length,
    names: fleet.map((s) => s.name),
    lastError,
  };
}

/** Force a fresh discovery + fleet read (Settings "Re-scan"). */
export async function rescan(): Promise<{ discoveredCount: number; names: string[]; lastError: string | null }> {
  resetManager();
  const fleet = await refreshFleet(true);
  return { discoveredCount: discoveredCount || fleet.length, names: fleet.map((s) => s.name), lastError };
}

// ---- Control primitives -----------------------------------------------------

function deviceByUuid(m: SonosManager, uuid: string): SonosDevice | undefined {
  return m.Devices.find((d) => d.Uuid === uuid);
}

/** Set one speaker's volume (0–100). */
export async function setVolume(uuid: string, pct: number): Promise<void> {
  const m = await getManager();
  if (!m) throw new Error(lastError || 'Sonos not available');
  const d = deviceByUuid(m, uuid);
  if (!d) throw new Error(`speaker ${uuid} not found`);
  const v = Math.max(0, Math.min(100, Math.round(pct)));
  await d.SetVolume(v);
  lastFleetAt = 0; // force the next read to reflect it
}

/** Join every speaker into a single group (coordinated by the first device) so a
 *  notification plays in sync across the whole house. Best-effort; per-speaker errors
 *  are swallowed so one stubborn speaker doesn't abort the rest. Returns how many
 *  speakers were (attempted to be) joined. */
export async function groupAll(): Promise<number> {
  const m = await getManager();
  if (!m) throw new Error(lastError || 'Sonos not available');
  const devices = m.Devices;
  if (devices.length <= 1) return devices.length;
  const coordinator = devices[0];
  let joined = 1;
  for (const d of devices.slice(1)) {
    try {
      await d.JoinGroup(coordinator.Name);
      joined++;
    } catch {
      /* leave this speaker where it is; the others still group */
    }
  }
  lastFleetAt = 0;
  return joined;
}

/** The distinct group coordinators (one device per group). Firing a notification at each
 *  coordinator covers EVERY speaker — including stereo pairs (one logical coordinator per
 *  pair). Owner-validated: 8 coordinators cover the 8-zone / 13-player system.
 *
 *  When `onlyUuids` is given, restrict to the groups that CONTAIN one of those speaker
 *  UUIDs (per-zone targeting): a member's coordinator is included so the chosen zone sounds.
 *  Empty/undefined = all groups (whole house). */
function groupCoordinators(m: SonosManager, onlyUuids?: string[]): SonosDevice[] {
  const filter = onlyUuids && onlyUuids.length ? new Set(onlyUuids) : null;
  const seen = new Set<string>();
  const out: SonosDevice[] = [];
  for (const d of m.Devices) {
    if (filter && !filter.has(d.Uuid)) continue;
    let coord: SonosDevice = d;
    try {
      coord = d.Coordinator ?? d;
    } catch {
      coord = d;
    }
    if (seen.has(coord.Uuid)) continue;
    seen.add(coord.Uuid);
    out.push(coord);
  }
  return out;
}

export interface SirenOptions {
  /** The LAN-reachable URL of the alarm clip (served by this API). */
  trackUri: string;
  /** Forced volume 0–100 while the siren plays (restored afterward). */
  volumePct: number;
  /** How long (seconds) one notification holds before reverting playback. */
  durationSec: number;
  /** Restrict the siren to these speaker UUIDs (per-zone targeting); empty = whole house. */
  speakerIds?: string[];
}

// A monotonically-increasing token. Each playSiren() loop captures the token it was
// started with; stopSiren() bumps it so an in-flight loop sees the mismatch and breaks.
let sirenToken = 0;

/**
 * Play the siren across the whole house via PlayNotification (UPnP takeover), fired ONCE
 * PER GROUP COORDINATOR (deduped) — this covers every speaker incl. stereo pairs WITHOUT
 * regrouping (so each group's own playback is snapshotted + restored independently and
 * non-destructively). The library sets `volume` for the clip and restores prior
 * track/queue/volume after each notification returns.
 *
 * For a SUSTAINED siren we LOOP the notification (each call ≈ clip length) until stopSiren()
 * is called or the optional overall budget elapses. Per-coordinator errors are swallowed so
 * one offline speaker never aborts the rest. Throws only if Sonos isn't reachable at all —
 * the caller logs it but must NOT let it abort the light side of the alarm.
 *
 * @param overallBudgetSec optional ceiling for the whole looping siren; null = until stopped.
 */
export async function playSiren(opts: SirenOptions, overallBudgetSec: number | null = null): Promise<void> {
  const m = await getManager();
  if (!m) throw new Error(lastError || 'Sonos not available');
  const myToken = ++sirenToken; // starting a new siren supersedes any prior loop
  const vol = Math.max(0, Math.min(100, Math.round(opts.volumePct)));
  const clipSec = Math.max(2, Math.round(opts.durationSec));
  const deadline = overallBudgetSec != null ? Date.now() + overallBudgetSec * 1000 : null;

  do {
    const coords = groupCoordinators(m, opts.speakerIds);
    // Fire all coordinators in parallel so the siren is roughly in sync across groups.
    await Promise.all(
      coords.map(async (d) => {
        try {
          await d.PlayNotification({
            trackUri: opts.trackUri,
            onlyWhenPlaying: false,
            volume: vol,
            timeout: clipSec, // fallback revert if the UPnP "done" event is missed
            delayMs: 100,
          });
        } catch {
          /* this group is offline / busy — the others still sound */
        }
      }),
    );
    // Loop only while WE are still the active siren and within any budget.
  } while (myToken === sirenToken && (deadline == null || Date.now() < deadline));
}

/**
 * Stop the siren immediately: bump the token so any looping playSiren() breaks, then stop
 * transport on each group coordinator so the current clip is cut short now (PlayNotification
 * would otherwise run to its own timeout). Best-effort; swallows per-speaker errors.
 */
export async function stopSiren(): Promise<void> {
  sirenToken++; // break any in-flight loop
  const m = await getManager();
  if (!m) return; // nothing reachable to stop
  const coordinators = m.Devices.filter((d) => {
    try {
      return (d.Coordinator?.Uuid ?? d.Uuid) === d.Uuid;
    } catch {
      return true;
    }
  });
  await Promise.all(
    coordinators.map(async (d) => {
      try {
        await d.Stop();
      } catch {
        /* best-effort */
      }
    }),
  );
}
