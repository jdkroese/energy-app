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

/** Decode the XML entities Sonos uses to escape the embedded ZoneGroupState document
 *  (&lt; &gt; &quot; &amp; &apos;) so we can regex the inner ZoneGroupMember tags. */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
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
// UUIDs of the HIDDEN half of stereo pairs / surround satellites (ZoneGroupTopology
// Invisible="1"). Cached alongside the fleet (~30s) so we don't re-read the topology on
// every fleet read. We DROP these from getFleet() so each bonded zone shows ONCE (the
// visible primary controls both units). Empty until the first topology read.
let invisibleUuids: Set<string> = new Set();

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
  invisibleUuids = new Set();
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

/**
 * Read the set of INVISIBLE player UUIDs from ZoneGroupTopology — the hidden half of each
 * stereo pair (and any surround satellite) is marked `Invisible="1"`. We drop these so a
 * bonded zone shows once (its visible primary controls both units). Best-effort: on any
 * parse/read error we return the previously-cached set so the list never spuriously
 * doubles. Validated against the owner's 5-pair / 8-zone system.
 */
async function readInvisibleUuids(m: SonosManager): Promise<Set<string>> {
  const d = m.Devices[0];
  if (!d) return invisibleUuids;
  try {
    const r = await d.ZoneGroupTopologyService.GetZoneGroupState();
    const xml = typeof r?.ZoneGroupState === 'string' ? decodeEntities(r.ZoneGroupState) : '';
    if (!xml) return invisibleUuids;
    const out = new Set<string>();
    // Each ZoneGroupMember is a self-contained tag; pull the ones flagged Invisible="1".
    const memberRe = /<ZoneGroupMember\b[^>]*>/gi;
    for (const tag of xml.match(memberRe) ?? []) {
      if (/\bInvisible="1"/i.test(tag)) {
        const uuid = tag.match(/\bUUID="([^"]+)"/i)?.[1];
        if (uuid) out.add(uuid);
      }
    }
    return out;
  } catch {
    return invisibleUuids; // keep the last good set on a transient topology read failure
  }
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
    // Refresh the invisible-member set (stereo-pair satellites) before filtering the fleet.
    invisibleUuids = await readInvisibleUuids(m);
    // Drop the hidden half of stereo pairs / surround satellites so each zone shows once.
    const devices = m.Devices.filter((d) => !invisibleUuids.has(d.Uuid));
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

/**
 * Group the given speakers under ONE coordinator (the first id) so playback is synced across
 * them, and return that coordinator's Sonos id plus the full set of joined ids. Used by the
 * Spotify (Music) path: it groups the chosen rooms, then starts Connect playback on the
 * coordinator's Connect device. A single speaker is a no-op group (it's its own coordinator).
 * Best-effort per JoinGroup so one stubborn speaker doesn't abort the rest. Throws only when
 * Sonos is unreachable or none of the requested ids are present.
 */
export async function groupSpeakers(
  speakerIds: string[],
): Promise<{ coordinator: string; joined: string[] }> {
  const m = await getManager();
  if (!m) throw new Error(lastError || 'Sonos not available');
  const want = new Set(speakerIds);
  const targets = m.Devices.filter((d) => want.has(d.Uuid));
  if (targets.length === 0) throw new Error('no matching speakers found');
  const coordinator = targets[0];
  const joined: string[] = [coordinator.Uuid];
  for (const d of targets.slice(1)) {
    try {
      await d.JoinGroup(coordinator.Name);
      joined.push(d.Uuid);
    } catch {
      /* leave this speaker where it is; the rest still group */
    }
  }
  lastFleetAt = 0; // force the next fleet read to reflect the new grouping
  return { coordinator: coordinator.Uuid, joined };
}

/**
 * Reconcile the speaker set of an ALREADY-PLAYING group to `targetIds`, without interrupting the
 * stream on the coordinator. Used by the "Playing on" control to add/remove zones live:
 *   • ADD    — a target zone not currently in the group JoinGroup()s the coordinator (starts in sync).
 *   • REMOVE — a currently-grouped zone that's no longer wanted is unjoined (Sonos "Leave") + stopped
 *              so it goes silent. The coordinator itself is never removed (its stream keeps running).
 * `currentIds` is the set the group is believed to be playing on (the persisted now-playing set). The
 * coordinator is kept as the group's anchor; if the coordinator would be removed, the FIRST remaining
 * target becomes the new coordinator is NOT attempted here — callers guarantee ≥1 target and keep the
 * coordinator in-scope (remove-last is handled one level up as a Stop). Best-effort per speaker.
 *
 * Returns the resolved set of ids now in the group (coordinator + successfully-joined members).
 */
export async function reconcileGroup(
  coordinatorId: string,
  currentIds: string[],
  targetIds: string[],
): Promise<{ coordinator: string; joined: string[] }> {
  const m = await getManager();
  if (!m) throw new Error(lastError || 'Sonos not available');
  const coordinator = deviceByUuid(m, coordinatorId);
  if (!coordinator) throw new Error(`coordinator ${coordinatorId} not found`);

  const want = new Set(targetIds);
  want.add(coordinatorId); // the coordinator is always in-scope while playing
  const have = new Set(currentIds);
  have.add(coordinatorId);

  const toAdd = [...want].filter((id) => !have.has(id) && id !== coordinatorId);
  const toRemove = [...have].filter((id) => !want.has(id) && id !== coordinatorId);

  // Add: join each new zone to the coordinator's group (plays the same stream in sync).
  const joined: string[] = [coordinatorId];
  for (const id of [...want].filter((x) => x !== coordinatorId)) {
    // Only actively JoinGroup the newly-added ones; ones already grouped are assumed in sync.
    if (toAdd.includes(id)) {
      const d = deviceByUuid(m, id);
      if (!d) continue;
      try {
        await d.JoinGroup(coordinator.Name);
        joined.push(id);
      } catch {
        /* couldn't join this zone — the rest still play */
      }
    } else {
      joined.push(id); // already in the group
    }
  }

  // Remove: leave the group (become a standalone) + stop, so the zone goes silent.
  for (const id of toRemove) {
    const d = deviceByUuid(m, id);
    if (!d) continue;
    try {
      // Leaving the group makes the player its own standalone coordinator; then stop it.
      await d.AVTransportService.BecomeCoordinatorOfStandaloneGroup({ InstanceID: 0 });
    } catch {
      /* some firmware/lib versions lack the standalone call — fall through to Stop */
    }
    try {
      await d.Stop();
    } catch {
      /* best-effort */
    }
  }

  lastFleetAt = 0; // force the next fleet read to reflect the new grouping
  return { coordinator: coordinatorId, joined: [...new Set(joined)] };
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

// ---- Internet radio (takeover playback) ------------------------------------
// Radio playback is a TAKEOVER (unlike the alarm's non-destructive PlayNotification):
// it groups the chosen speakers under one coordinator, points its AVTransport at the
// stream and plays, then sets each member's volume. Owner-validated facts:
//   • A station plays via the `x-rincon-mp3radio://` URI scheme with the http(s):// prefix
//     STRIPPED. A plain http:// URL is rejected by Sonos (UPnPError 714 Illegal MIME-Type).
//   • Metadata MUST be empty — a DIDL metadata string makes Sonos reject the play with
//     UPnPError 402 (Invalid args). https-only hosts that 701 when the scheme is stripped
//     play via the scheme-preserving variant (see startRadioStream).

/** Build the Sonos radio URI from a stream URL (strip the http(s):// prefix). */
function radioUri(streamUrl: string): string {
  return 'x-rincon-mp3radio://' + streamUrl.replace(/^https?:\/\//i, '');
}

/** The scheme-preserving variant: prepend x-rincon-mp3radio:// WITHOUT stripping, so the
 *  original https:// is kept for TLS-only hosts (e.g. icecast on :8443) that 701 when the
 *  scheme is dropped to plain http. */
function radioUriKeep(streamUrl: string): string {
  return 'x-rincon-mp3radio://' + streamUrl;
}

/** Start a radio stream on a coordinator, robust across stream types (owner-validated live).
 *  EMPTY metadata is used DELIBERATELY — passing a DIDL metadata string makes Sonos reject
 *  the call with UPnPError 402 (Invalid args) on EVERY play. Do not "add a title" here.
 *  Strategy: try the stripped URI first (works for most http/https MP3 + many AAC/HLS), then
 *  fall back to the scheme-preserving URI for https-only hosts. Confirms the transport
 *  actually started (PLAYING/TRANSITIONING) rather than trusting SetAVTransportURI's return. */
async function startRadioStream(coordinator: SonosDevice, streamUrl: string): Promise<void> {
  const candidates = [radioUri(streamUrl)];
  const keep = radioUriKeep(streamUrl);
  if (keep !== candidates[0]) candidates.push(keep);
  let lastErr: unknown = null;
  for (const uri of candidates) {
    try {
      await coordinator.AVTransportService.SetAVTransportURI({ InstanceID: 0, CurrentURI: uri, CurrentURIMetaData: '' });
      await coordinator.AVTransportService.Play({ InstanceID: 0, Speed: '1' });
      const info = await coordinator.AVTransportService.GetTransportInfo({ InstanceID: 0 });
      if (info.CurrentTransportState === 'PLAYING' || info.CurrentTransportState === 'TRANSITIONING') return;
      lastErr = new Error(`stream did not start (${info.CurrentTransportState})`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`could not start stream: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

export interface PlayStationOptions {
  /** The HTTP(S) stream URL of the station. */
  streamUrl: string;
  /** Station name (label only — used for logging/UI; not sent as Sonos metadata, see above). */
  name: string;
  /** Speaker UUIDs to play on. Empty = ALL discovered speakers (whole house). */
  speakerIds?: string[];
  /** Playback volume 0–100 applied to every targeted speaker. */
  volumePct: number;
}

/** Resolve the target devices for a radio play: the named speakers, or the whole fleet
 *  when none are named. */
function targetDevices(m: SonosManager, speakerIds?: string[]): SonosDevice[] {
  if (!speakerIds || speakerIds.length === 0) return m.Devices.slice();
  const want = new Set(speakerIds);
  return m.Devices.filter((d) => want.has(d.Uuid));
}

/**
 * Play an internet-radio station on the chosen speakers (synced) at a chosen volume.
 * Picks the first target as the GROUP COORDINATOR, joins the rest into its group, points
 * the coordinator's AVTransport at the radio URI and plays, then sets each member's volume.
 * Returns the speaker ids that were played on. Throws when Sonos isn't reachable or no
 * targeted speaker is present.
 */
export async function playStation(opts: PlayStationOptions): Promise<{ playedOn: string[]; coordinator: string }> {
  const m = await getManager();
  if (!m) throw new Error(lastError || 'Sonos not available');
  const targets = targetDevices(m, opts.speakerIds);
  if (targets.length === 0) throw new Error('no matching speakers found');
  const vol = Math.max(0, Math.min(100, Math.round(opts.volumePct)));

  const coordinator = targets[0];
  // Join the other targets into the coordinator's group so they play the stream in sync.
  for (const d of targets.slice(1)) {
    try {
      await d.JoinGroup(coordinator.Name);
    } catch {
      /* leave this speaker where it is; the rest still group + play */
    }
  }

  // Point the coordinator at the radio stream and play (empty metadata + strip→keep fallback).
  await startRadioStream(coordinator, opts.streamUrl);

  // Set volume on every target (best-effort per speaker).
  await Promise.all(
    targets.map(async (d) => {
      try {
        await d.RenderingControlService.SetVolume({ InstanceID: 0, Channel: 'Master', DesiredVolume: vol });
      } catch {
        /* one speaker's volume failed — playback still holds */
      }
    }),
  );

  lastFleetAt = 0; // force the next read to reflect the new volumes
  return { playedOn: targets.map((d) => d.Uuid), coordinator: coordinator.Uuid };
}

/**
 * Stop playback on the chosen speakers (or the whole fleet when none are named). Stops the
 * coordinator of each targeted speaker's group so the stream actually ends. Best-effort.
 */
export async function stopSpeakers(speakerIds?: string[]): Promise<void> {
  const m = await getManager();
  if (!m) return; // nothing reachable to stop
  const coords = groupCoordinators(m, speakerIds && speakerIds.length ? speakerIds : undefined);
  await Promise.all(
    coords.map(async (d) => {
      try {
        await d.Stop();
      } catch {
        /* best-effort */
      }
    }),
  );
  lastFleetAt = 0;
}

// ---- Live playback state (what's actually playing on Sonos) -----------------
// The Music/Radio surfaces only know about playback THIS app started (the radio store /
// the Spotify Web API). Anything started elsewhere — the Sonos app, AirPlay, TV, line-in,
// a Sonos favourite — is invisible to them, so it can't be shown or stopped. getPlaybackState()
// reads the REAL transport state off each group coordinator so any current playback is
// surfaced (mini-player + Speakers section) and stoppable. Cached briefly so the 5s
// now-playing poll doesn't hammer the UPnP transport.

export interface SonosPlayback {
  /** At least one group is actively PLAYING (or transitioning into play). */
  isPlaying: boolean;
  /** Best-effort current-track / source label of the primary playing group. */
  title: string | null;
  /** Best-effort source name derived from the transport URI (TV, Line-in, Spotify, Radio…). */
  source: string | null;
  /** The primary playing group's coordinator id (anchors live re-grouping). */
  coordinator: string | null;
  /** Visible member ids that are currently playing (union across playing groups). */
  speakerIds: string[];
}

const PLAYBACK_TTL_MS = 4_000;
let lastPlayback: SonosPlayback | null = null;
let lastPlaybackAt = 0;

/** Pull a friendly title from a GetPositionInfo TrackMetaData (parsed Track object or raw DIDL). */
function titleFromMeta(meta: unknown): string | null {
  if (!meta) return null;
  if (typeof meta === 'object') {
    const t = meta as { Title?: unknown; Artist?: unknown };
    const title = typeof t.Title === 'string' ? t.Title.trim() : '';
    const artist = typeof t.Artist === 'string' ? t.Artist.trim() : '';
    if (title && artist) return `${title} · ${artist}`;
    return title || artist || null;
  }
  if (typeof meta === 'string') {
    const m = decodeEntities(meta).match(/<dc:title>([^<]*)<\/dc:title>/i);
    const title = m?.[1]?.trim();
    return title || null;
  }
  return null;
}

/** Best-effort human source name from a Sonos transport URI. */
function sourceFromUri(uri: string): string | null {
  const u = (uri || '').toLowerCase();
  if (!u) return null;
  if (u.startsWith('x-sonos-htastream:')) return 'TV';
  if (u.startsWith('x-rincon-stream:') || u.startsWith('x-sonos-vli:')) return 'Line-in';
  if (u.startsWith('x-sonosapi-radio:') || u.includes('airplay')) return 'AirPlay';
  if (u.includes('spotify')) return 'Spotify';
  if (u.startsWith('x-rincon-mp3radio:') || u.startsWith('x-sonosapi-stream:')) return 'Radio';
  if (u.includes('soundcloud')) return 'SoundCloud';
  if (u.includes('tidal')) return 'Tidal';
  return null;
}

/**
 * Read the live transport state across all group coordinators and summarise the ACTIVE
 * playback (or null when nothing is playing). Cached ~4s (soft-fails to the last snapshot on a
 * transient read error) so the shared now-playing poll stays cheap. Only PLAYING/TRANSITIONING
 * groups count as "playing" (a paused/stopped group is treated as idle).
 */
export async function getPlaybackState(force = false): Promise<SonosPlayback | null> {
  if (!isConfigured()) return null;
  if (!force && Date.now() - lastPlaybackAt < PLAYBACK_TTL_MS) return lastPlayback;
  const m = await getManager();
  if (!m) return lastPlayback;
  try {
    if (invisibleUuids.size === 0) invisibleUuids = await readInvisibleUuids(m);
    const coords = groupCoordinators(m);
    const groups: { coord: SonosDevice; members: string[]; title: string | null; source: string | null }[] = [];
    await Promise.all(
      coords.map(async (c) => {
        try {
          const info = await c.AVTransportService.GetTransportInfo({ InstanceID: 0 });
          const state = info.CurrentTransportState;
          if (state !== 'PLAYING' && state !== 'TRANSITIONING') return;
          // Visible members of this coordinator's group (drop stereo-pair satellites).
          const members = m.Devices.filter((d) => {
            let cu: string;
            try {
              cu = d.Coordinator?.Uuid ?? d.Uuid;
            } catch {
              cu = d.Uuid;
            }
            return cu === c.Uuid && !invisibleUuids.has(d.Uuid);
          }).map((d) => d.Uuid);
          let title: string | null = null;
          let source: string | null = null;
          try {
            const pos = await c.AVTransportService.GetPositionInfo({ InstanceID: 0 });
            title = titleFromMeta(pos.TrackMetaData);
            source = sourceFromUri(String(pos.TrackURI ?? ''));
          } catch {
            /* keep title/source null */
          }
          groups.push({ coord: c, members, title, source });
        } catch {
          /* this coordinator didn't answer — the others still report */
        }
      }),
    );
    if (groups.length === 0) {
      lastPlayback = null;
      lastPlaybackAt = Date.now();
      return null;
    }
    // Primary = the playing group with the most speakers (the "main" zone in a mixed system).
    groups.sort((a, b) => b.members.length - a.members.length);
    const primary = groups[0];
    const speakerIds = [...new Set(groups.flatMap((g) => g.members))];
    lastPlayback = {
      isPlaying: true,
      title: primary.title,
      source: primary.source,
      coordinator: primary.coord.Uuid,
      speakerIds,
    };
    lastPlaybackAt = Date.now();
    return lastPlayback;
  } catch {
    return lastPlayback; // keep the last good snapshot on a transient read failure
  }
}

/**
 * Reconcile an already-playing NATIVE Sonos session (one not started via the app's radio/Spotify
 * paths) to `targetIds`, live — the "Playing on" checkboxes call this. Reads the current playback
 * to find the coordinator + in-scope zones, then adds/removes zones (JoinGroup / leave+stop). An
 * empty target stops everything. Returns the resolved coordinator + joined ids. Throws when nothing
 * is playing or Sonos is unreachable.
 */
export async function setPlayingSpeakers(
  targetIds: string[],
): Promise<{ coordinator: string; joined: string[]; stopped?: boolean }> {
  const pb = await getPlaybackState(true);
  if (!pb || !pb.coordinator) throw new Error('nothing is playing');
  if (targetIds.length === 0) {
    await stopSpeakers();
    lastPlaybackAt = 0;
    return { coordinator: pb.coordinator, joined: [], stopped: true };
  }
  const coordinator = pb.coordinator;
  // Always keep the coordinator in-scope (its stream anchors the group).
  const withCoord = targetIds.includes(coordinator) ? targetIds : [coordinator, ...targetIds];
  const res = await reconcileGroup(coordinator, pb.speakerIds, withCoord);
  lastPlaybackAt = 0;
  return res;
}

/** A Sonos system radio favourite (from GetFavorites / GetFavoriteRadioStations). */
export interface SonosFavorite {
  title: string;
  /** The stream URI as Sonos stores it (often x-rincon-mp3radio:// or x-sonosapi-stream:). */
  uri: string;
  /** Best-effort plain stream URL (http(s)://…) derived from the Sonos URI; null if not derivable. */
  streamUrl: string | null;
}

/** A Sonos `x-rincon-mp3radio://host/path` URI back to a plain http URL (best-effort). */
function favoriteStreamUrl(uri: string): string | null {
  if (/^https?:\/\//i.test(uri)) return uri;
  const m = uri.match(/^x-rincon-mp3radio:\/\/(.+)$/i);
  if (m) return 'http://' + m[1];
  return null; // x-sonosapi-stream / service URIs can't be replayed as a plain stream
}

/** A non-radio favourite the owner has saved (e.g. a Spotify/SoundCloud playlist) that we
 *  CANNOT add as a radio station — surfaced so the Import tab can explain the empty list. */
export interface SonosSkippedFavorite {
  title: string;
  /** Best-effort service label derived from the container URI (Spotify / SoundCloud / …). */
  service: string | null;
}

/** Derive a friendly service name from a Sonos favourite URI (best-effort, for the UI hint). */
function favoriteServiceName(uri: string): string | null {
  const u = uri.toLowerCase();
  if (u.includes('spotify')) return 'Spotify';
  if (u.includes('soundcloud')) return 'SoundCloud';
  if (u.includes('tidal')) return 'Tidal';
  if (u.includes('deezer')) return 'Deezer';
  if (u.includes('amazon') || u.includes('prime')) return 'Amazon Music';
  if (u.includes('apple')) return 'Apple Music';
  if (u.includes('youtube')) return 'YouTube Music';
  if (/^x-rincon-cpcontainer:/i.test(uri)) return 'a streaming service';
  return null;
}

export interface SonosRadioFavoritesResult {
  /** The radio-type favourites that CAN be imported. */
  radio: SonosFavorite[];
  /** The non-radio favourites (playlists etc.) that were skipped — to explain an empty list. */
  skipped: SonosSkippedFavorite[];
}

/**
 * Read the Sonos system's own radio favourites (for the "Import from Sonos" feature).
 * Merges GetFavoriteRadioStations + the audioBroadcast entries of GetFavorites, deduped by
 * title. ALSO reports the non-radio favourites it skipped (Spotify/SoundCloud playlists,
 * `x-rincon-cpcontainer:` URIs that Sonos rejects over local control — UPnPError 402) so
 * the UI can explain a legitimately-empty radio list instead of looking broken. Returns
 * empty lists when Sonos isn't reachable.
 */
export async function getSonosRadioFavorites(): Promise<SonosRadioFavoritesResult> {
  const m = await getManager();
  if (!m || m.Devices.length === 0) return { radio: [], skipped: [] };
  const d = m.Devices[0];
  const radio: SonosFavorite[] = [];
  const skipped: SonosSkippedFavorite[] = [];
  const seen = new Set<string>();
  const add = (title: unknown, uri: unknown) => {
    if (typeof title !== 'string' || typeof uri !== 'string' || !uri) return;
    const key = title.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    radio.push({ title: title || 'Station', uri, streamUrl: favoriteStreamUrl(uri) });
  };
  // Radio favourites (R: container).
  try {
    const r = await d.GetFavoriteRadioStations();
    if (Array.isArray(r.Result)) for (const t of r.Result) add(t.Title, t.TrackUri);
  } catch {
    /* not all systems expose this; fall through to GetFavorites */
  }
  // General favourites — keep the radio/audioBroadcast ones; report everything else as skipped.
  try {
    const f = await d.GetFavorites();
    if (Array.isArray(f.Result)) {
      for (const t of f.Result) {
        const uri = t.TrackUri ?? '';
        const isRadio = (t.UpnpClass ?? '').includes('audioBroadcast') || /^x-rincon-mp3radio:|^x-sonosapi-stream:/i.test(uri);
        if (isRadio) {
          add(t.Title, uri);
        } else if (typeof t.Title === 'string' && t.Title) {
          skipped.push({ title: t.Title, service: favoriteServiceName(uri) });
        }
      }
    }
  } catch {
    /* best-effort */
  }
  return { radio, skipped };
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
