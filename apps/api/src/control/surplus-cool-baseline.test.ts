// Tests the ONE-TIME re-baseline of the COOLING surplus rule to the owner-requested applied
// spec (cool @ 24°C, fan 2). Runs through the PUBLIC store-load path — the migration itself
// (baselineCoolSurplus) is internal, so we assert its effect on the hydrated automations.
//   node --import tsx --test src/control/surplus-cool-baseline.test.ts
//
// Contract:
//   • A persisted cool rule that predates the change (no `cool24Fan2Baselined` flag) is forced
//     to targetSetpointC=24 + fanLevel=2 exactly once, regardless of its drifted values.
//   • After the flag is set, a later deliberate owner edit is PRESERVED (never re-clobbered).

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the store at a throwaway state file BEFORE any store access (load() reads it lazily).
const dir = mkdtempSync(join(tmpdir(), "energy-cool-baseline-"));
const STATE_FILE = join(dir, "state.json");
process.env.STATE_FILE = STATE_FILE;

import { test } from "node:test";
import assert from "node:assert/strict";

import { SOLAR_SURPLUS_COOL_AUTOMATION_ID } from "../store";
import type { SolarSurplusPrecoolParams } from "../store";

/** Seed the state file with one cool rule carrying the given params, then load the store fresh. */
async function loadWith(params: Partial<SolarSurplusPrecoolParams>) {
  writeFileSync(
    STATE_FILE,
    JSON.stringify({
      automations: [
        {
          id: SOLAR_SURPLUS_COOL_AUTOMATION_ID,
          name: "Solar-surplus cooling",
          enabled: true,
          type: "solar_surplus_precool",
          // minRunSec present ⇒ the older anti-chatter tune is a no-op, isolating the baseline.
          params: { roomTempLimitC: 25, surplusClearSec: 120, exitBand: "P1", minRunSec: 900, ...params },
          lastEval: null,
        },
      ],
    }),
  );
  // Fresh module instance so load() re-reads the file we just wrote.
  const mod = await import(`../store?cool-baseline=${Math.random()}`);
  return mod.get().automations.find(
    (a: { type: string }) => a.type === "solar_surplus_precool",
  ).params as SolarSurplusPrecoolParams;
}

test("un-flagged cool rule is force-baselined to cool@24 / fan 2 once", async () => {
  const p = await loadWith({ targetSetpointC: 21, fanLevel: 4 }); // drifted away from spec
  assert.equal(p.targetSetpointC, 24, "setpoint forced to 24°C");
  assert.equal(p.fanLevel, 2, "fan forced to 2");
  assert.equal(p.cool24Fan2Baselined, true, "flag set so it never re-runs");
});

test("already-flagged cool rule keeps a later deliberate owner edit", async () => {
  const p = await loadWith({ targetSetpointC: 22, fanLevel: 3, cool24Fan2Baselined: true });
  assert.equal(p.targetSetpointC, 22, "owner's 22°C preserved");
  assert.equal(p.fanLevel, 3, "owner's fan 3 preserved");
});
