// The single, guardrailed write path to the Rain Bird controller. Nothing else
// should call the rainbird connector write functions directly — everything goes
// through issueIrrigation(), which enforces the SAME arm/admin model as the climate
// fleet: water hardware is actuated only when the Devices layer is ARMED. Every
// action is logged into the shared devices.log ring (irrigation zones live in the
// Devices fleet, so they share its command log + lastError surface). Never throws.
//
// Phase 1 is MANUAL + SCHEDULED only — there is no autonomous watering coordinator.
// Unlike climate (where a manual hand-command bypasses the arm gate), irrigation
// writes ALWAYS require armed: a sprinkler has no benign "operate by hand while
// disarmed" use, and the owner explicitly wants water writes refused when not armed.

import * as rainbird from "../connectors/rainbird";
import * as store from "../store";
import { logIrrigationAction } from "./log-adapters";

/** The irrigation levers (NOT setpoint/mode like climate). */
export type IrrigationLever = "run" | "stop" | "rainDelay";

export interface IrrigationIssueResult {
  ok: boolean;
  reason: string;
  detail: string;
}

/** The last time the APP itself opened each zone's valve. issueIrrigation() is the SINGLE
 *  write choke point — both manual commands (routes/irrigation) and the coordinator's
 *  scheduled fires flow through here — so this is the one true record of "we started this
 *  run". The coordinator's session-observer reads it to tell an app-initiated run (already
 *  logged as run/fire) from an EXTERNAL one started at the keypad or by the controller's
 *  onboard weekly program, so it can log every physical watering session without
 *  double-logging our own. Keyed by zoneId → epoch ms. */
const lastAppRunByZone = new Map<string, number>();

/** When (epoch ms) the app last issued a successful `run` for this zone, or undefined. */
export function lastAppRunTs(zoneId: string): number | undefined {
  return lastAppRunByZone.get(zoneId);
}

function logEntry(
  deviceId: string,
  lever: IrrigationLever,
  from: string | number | null,
  to: string | number | null,
  reason: string,
  ok: boolean,
  detail: string,
): void {
  store.update((s) => {
    s.devices.log.push({
      ts: Date.now(),
      deviceId,
      lever,
      from,
      to,
      reason,
      ok,
      detail,
    });
    s.devices.log = store.pruneLog(s.devices.log);
    s.devices.updatedAt = Date.now();
    if (!ok) s.devices.lastError = `${deviceId}.${lever}: ${detail}`;
  });
  // Shim: mirror into the unified event bus (docs/37 §3).
  logIrrigationAction(deviceId, lever, from, to, reason, ok, detail);
}

function reject(
  deviceId: string,
  lever: IrrigationLever,
  reason: string,
): IrrigationIssueResult {
  logEntry(deviceId, lever, null, null, reason, false, reason);
  return { ok: false, reason, detail: reason };
}

/**
 * Issue ONE guardrailed irrigation command. Returns a result; never throws.
 *  - run:       value = minutes (>0). deviceId = `rb-<station>`.
 *  - stop:      value ignored. Stops ALL irrigation. deviceId may be `rb-all`.
 *  - rainDelay: value = days (>=0). deviceId = `rb-controller`.
 */
export async function issueIrrigation(
  deviceId: string,
  lever: IrrigationLever,
  value: number,
  reason: string,
): Promise<IrrigationIssueResult> {
  try {
    if (!rainbird.isConfigured())
      return reject(deviceId, lever, "Rain Bird not connected");

    // ARM GATE — water is actuated only when the Devices layer is armed (mode != off).
    const dev = store.get().devices;
    if (!dev.armed || dev.mode === "off") {
      return reject(
        deviceId,
        lever,
        `not armed (armed=${dev.armed}, mode=${dev.mode})`,
      );
    }

    if (lever === "run") {
      const minutes = Math.round(Number(value));
      if (!Number.isFinite(minutes) || minutes <= 0)
        return reject(deviceId, lever, "minutes must be > 0");
      await rainbird.startZone(deviceId, minutes);
      lastAppRunByZone.set(deviceId, Date.now());
      logEntry(
        deviceId,
        lever,
        null,
        minutes,
        reason,
        true,
        `run ${minutes} min issued`,
      );
      return { ok: true, reason, detail: `run ${minutes} min issued` };
    }

    if (lever === "stop") {
      await rainbird.stopAll();
      logEntry(
        deviceId,
        lever,
        null,
        "stopped",
        reason,
        true,
        "stop-all issued",
      );
      return { ok: true, reason, detail: "stop-all issued" };
    }

    if (lever === "rainDelay") {
      const days = Math.round(Number(value));
      if (!Number.isFinite(days) || days < 0)
        return reject(deviceId, lever, "days must be >= 0");
      await rainbird.setRainDelay(days);
      logEntry(
        deviceId,
        lever,
        null,
        days,
        reason,
        true,
        `rain-delay ${days}d issued`,
      );
      return { ok: true, reason, detail: `rain-delay ${days}d issued` };
    }

    return reject(deviceId, lever, `unknown lever '${lever}'`);
  } catch (e) {
    const detail = (e as Error).message;
    logEntry(deviceId, lever, null, null, reason, false, detail);
    return { ok: false, reason: detail, detail };
  }
}
