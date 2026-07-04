// Solar source-merge (docs/44) — reconcile the LOCAL WiNet-S read (per-dongle) with the
// LAN-INDEPENDENT iSolarCloud backstop into one resilient per-inverter view.
//
// Policy:
//   • Prefer LOCAL for live kW when it's FRESH (a good read within LOCAL_FRESH_MS) — the
//     dongle is the fastest, highest-resolution source.
//   • Fall back to CLOUD when local is stale/unreachable, so per-inverter numbers +
//     history survive a full local-LAN outage.
//   • CLOUD is the OUTAGE SOURCE OF TRUTH: when the cloud says a device is offline we set
//     `cloudConfirmedDark`, so the dark-inverter alert fires even when the LAN is also
//     down (a dongle/router outage no longer blinds outage detection).
//
// Matching cloud device ↔ local dongle: by an owner-set serial→dongle-IP map
// (isolarcloud.serialMap), else 1:1 positional when the counts line up. READ-ONLY + pure;
// unit-tested directly. No control coupling.

import type { InverterNormalized } from './connectors/sungrow';
import type { CloudDevice, CloudSnapshot } from './connectors/isolarcloud';

/** A local read is "fresh" if its last good sample is within this window. */
export const LOCAL_FRESH_MS = 2 * 60_000;

/**
 * Merge the local inverter list with an optional cloud snapshot. Returns a NEW list (does
 * not mutate the inputs) with cloud-derived fields filled where local is missing/stale.
 *
 * @param local   the per-dongle normalized inverters (may include unreachable ones)
 * @param cloud   the cloud snapshot, or null when the backstop is disabled/unavailable
 * @param serialMap owner map cloud-serial → local-dongle-IP (id). Empty = positional.
 * @param nowMs   current time (injectable for tests)
 */
export function mergeSolarSources(
  local: InverterNormalized[],
  cloud: CloudSnapshot | null,
  serialMap: Record<string, string> | undefined,
  nowMs: number = Date.now(),
): InverterNormalized[] {
  // No cloud data → pass local through untouched (source annotated).
  if (!cloud || cloud.devices.length === 0) {
    return local.map((i) => ({ ...i, source: i.reachable ? 'local' : 'none' }));
  }

  return local.map((inv, idx) => {
    const cloudDev = matchCloudDevice(inv, idx, cloud.devices, serialMap);
    const merged: InverterNormalized = { ...inv };
    const localFresh = inv.reachable && inv.lastGoodTs != null && nowMs - inv.lastGoodTs < LOCAL_FRESH_MS;

    if (localFresh) {
      merged.source = 'local';
      // Even with fresh local, let cloud CORROBORATE an outage flag (never override live kW).
      if (cloudDev) merged.cloudConfirmedDark = cloudDev.offline && merged.acPowerW <= 0 ? true : merged.cloudConfirmedDark;
      return merged;
    }

    // Local is stale/unreachable — fall back to the cloud reading where it has one.
    if (cloudDev) {
      merged.source = 'cloud';
      merged.cloudConfirmedDark = cloudDev.offline;
      if (!inv.reachable || inv.acPowerW <= 0) {
        if (cloudDev.acPowerW != null) merged.acPowerW = Math.max(0, Math.round(cloudDev.acPowerW));
        if (cloudDev.dailyKwh != null) merged.dailyKwh = cloudDev.dailyKwh;
        if (cloudDev.totalKwh != null) merged.totalKwh = cloudDev.totalKwh;
      }
      if (!cloudDev.offline) {
        // Cloud says it's ONLINE → treat the inverter as live even though the LAN read
        // failed: every consumer that keys off `reachable` (the per-inverter cards, the
        // online-count, the issues/health rollup, history recording) must reflect the
        // cloud-supplied truth instead of showing a producing inverter as offline.
        merged.reachable = true;
        merged.lastGoodTs = nowMs;
        merged.lastSeen = new Date(nowMs).toISOString();
        // Adopt a running work-state label when the local read left it empty/Unknown, so
        // the card chip + health reason read "Run" rather than "Unknown".
        if (!merged.workState || merged.workState === 'Unknown') merged.workState = 'Run';
        if (merged.acPowerW > 0) merged.state = 'producing';
      } else {
        // Cloud confirms an OUTAGE → keep it unreachable + cloudConfirmedDark so the
        // dark-inverter alert still fires (a dongle/router outage no longer blinds it).
        merged.state = 'unreachable';
      }
      return merged;
    }

    // No cloud match either → local outage stands.
    merged.source = inv.reachable ? 'local' : 'none';
    return merged;
  });
}

/**
 * Find the cloud device for a local inverter: prefer the owner serial→ip map (match a
 * cloud serial whose mapped ip equals this inverter's id), else positional (same index)
 * when the two lists are the same length. Returns null when no confident match exists.
 */
export function matchCloudDevice(
  inv: InverterNormalized,
  idx: number,
  devices: CloudDevice[],
  serialMap: Record<string, string> | undefined,
): CloudDevice | null {
  if (serialMap && Object.keys(serialMap).length > 0) {
    for (const [serial, ip] of Object.entries(serialMap)) {
      if (ip === inv.id || ip === inv.ip) {
        const d = devices.find((x) => x.serial === serial || x.psKey.startsWith(serial));
        if (d) return d;
      }
    }
    return null; // an explicit map that doesn't match → don't guess
  }
  // Positional fallback only when the counts line up (unambiguous).
  return devices[idx] ?? null;
}
