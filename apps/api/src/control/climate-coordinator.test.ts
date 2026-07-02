// Regression tests for the surplus coordinator's MANUAL-protection invariant — run with
// the Node built-in test runner via tsx (from apps/api):
//   node --import tsx --test src/control/climate-coordinator.test.ts
// (apps/api has no formal test-runner script; tsx is a devDependency.)
//
// Core invariant under test (docs the file header promises): a unit that is powered ON but
// NOT in surplusStartedIds is treated as MANUAL — the surplus rule NEVER powers it off and
// never adopts it, EVEN when its mode/setpoint happen to match the rule's target and there
// is no active manual-override hold. This is exactly the case the old "reclaim orphaned
// rule-started units" block violated (owner turns a bedroom AC on at cool@24 — the shipped
// default target — reclaim re-adopts it after the 2h hold lapses, then the surplus-cleared
// soft-stop powers it off overnight). Removing that block restores the invariant.

// Isolate persistence to a throwaway file so the test never touches the dev .data/state.json.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.STATE_FILE = join(
  mkdtempSync(join(tmpdir(), "energy-cc-test-")),
  "state.json",
);

import { test } from "node:test";
import assert from "node:assert/strict";

import * as store from "../store";
import type { Automation, SolarSurplusPrecoolParams } from "../store";
import type { ClimateUnit } from "../connectors/intesis";
import type { RichClimateSnapshot } from "./climate-snapshot";
import {
  evaluateSolarSurplusPrecool,
  surplusOwns,
  dropSurplusStarted,
  isManual,
  markManualOverride,
  clearManualOverride,
  isManualOverrideActive,
} from "./climate-coordinator";

const DEVICE_ID = "ac-bedroom";

function unit(p: Partial<ClimateUnit> = {}): ClimateUnit {
  return {
    id: DEVICE_ID,
    name: "Bedroom",
    power: true, // manually ON
    mode: "cool",
    setpointC: 24, // == the rule's shipped default targetSetpointC
    currentTempC: 22, // BELOW the cooling trigger — nothing for the rule to do anyway
    minSetpointC: 16,
    maxSetpointC: 30,
    online: true,
    ...p,
  } as ClimateUnit;
}

/** The cooling surplus rule with the shipped defaults (target 24°C). */
function coolRule(): Automation {
  const params: SolarSurplusPrecoolParams = {
    roomTempLimitC: 25,
    targetSetpointC: 24,
    surplusClearSec: 120,
    exitBand: "P1",
    startThresholdW: 3000,
  };
  return {
    id: "auto-precool",
    name: "Solar surplus pre-cool",
    enabled: true,
    type: "solar_surplus_precool",
    params,
    lastEval: null,
  };
}

/** A snapshot with NO solar surplus (and a clean band), so the rule has no reason to run. */
function noSurplusSnap(): RichClimateSnapshot {
  return {
    ageMs: 0,
    band: "P2", // not the exit band
    gridImportKw: 0,
    pendingImportKw: 0,
    pvW: 0,
    houseLoadW: 0,
    surplusW: 0, // no free solar
    batteryHeadroomPct: 0,
    batteryDataComplete: true,
  };
}

/** Reset the persisted provenance + enroll the device for cooling before each scenario. */
function resetStore(): void {
  store.update((s) => {
    s.devices.surplusStartedIds = [];
    s.devices.manualOverrides = {};
    s.deviceSettings[DEVICE_ID] = {
      ...(s.deviceSettings[DEVICE_ID] ?? {}),
      solarCoolEnabled: true,
    };
  });
}

test("manual-on AC at cool@24 with no surplus is NOT reclaimed or powered off", async () => {
  resetStore();
  const u = unit();

  // Precondition: the unit is genuinely MANUAL — on but unowned, no hold active.
  assert.equal(surplusOwns(u.id), false, "starts unowned");
  assert.equal(
    isManual(u.id, u.power),
    true,
    "a powered-on unowned unit is MANUAL",
  );
  assert.equal(
    isManualOverrideActive(u.id),
    false,
    "no timed hold — this is the vulnerable case",
  );

  // Run the real cooling evaluator with no solar surplus.
  await evaluateSolarSurplusPrecool(coolRule(), [u], noSurplusSnap());

  // The INVARIANT: the rule must not have adopted the manual unit. (With the old reclaim
  // block this flipped to true — mode=cool, setpoint≈24, no hold — and the unit would then
  // be soft-stopped when the surplus is clear.) It must remain MANUAL and unowned.
  assert.equal(
    surplusOwns(u.id),
    false,
    "manual unit was NOT re-adopted (no reclaim)",
  );
  assert.equal(
    isManual(u.id, u.power),
    true,
    "unit stays MANUAL after evaluation",
  );
});

test("reclaim does not fire even after a manual-override hold has lapsed", async () => {
  resetStore();
  const u = unit();

  // Simulate the real-world failure timeline: the owner touched it (hold set) then the hold
  // expired. markManualOverride also drops any ownership, so the unit is on + unowned + no hold —
  // precisely the state the old reclaim block would grab.
  markManualOverride(u.id);
  clearManualOverride(u.id); // hold lapses
  assert.equal(isManualOverrideActive(u.id), false, "hold has lapsed");
  assert.equal(surplusOwns(u.id), false, "still unowned");

  await evaluateSolarSurplusPrecool(coolRule(), [u], noSurplusSnap());

  assert.equal(
    surplusOwns(u.id),
    false,
    "lapsed-hold manual unit is still not reclaimed",
  );
});

test("helper invariant: a manually-on unit is isManual and not owned, and stays so", () => {
  resetStore();
  // Nobody started it via the rule ⇒ manual.
  assert.equal(surplusOwns(DEVICE_ID), false);
  assert.equal(isManual(DEVICE_ID, true), true);
  // A spurious drop is a no-op and keeps it manual (never accidentally owned).
  dropSurplusStarted(DEVICE_ID);
  assert.equal(surplusOwns(DEVICE_ID), false);
  assert.equal(isManual(DEVICE_ID, true), true);
  // An OFF unit is owned by nobody (manual requires power).
  assert.equal(isManual(DEVICE_ID, false), false);
});
