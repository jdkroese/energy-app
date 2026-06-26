# Dev brief — Heating (Airzone) screen + drop Shadow/Auto authority

Context: Second slice of the Devices grouping work (follows docs/20). Builds the Heating type in the Devices hub — the Airzone underfloor fleet (6 rooms, local API, already merged into /api/devices). Sibling of the Cooling screen, same component language, --grid (orange) hue. Design approved 2026-06-26. Brand = "Power" design system (dark control-room).

This brief also carries one cross-cutting change: the Shadow/Auto authority selector is removed from the whole system (heating, cooling, and the Automations screen). See §5 — it has a real backend behavior consequence.

Standing rule: ship web (≥768px, ctx.desktop) AND mobile (<768px) — both branches in the same responsive screen. Verify both viewports before calling it done.

Affected files:
- apps/web/src/screens/Devices.tsx (heating branch + inline row controls)
- apps/web/src/screens/DeviceDetail.tsx (heating variant)
- apps/web/src/lib/types.ts (DeviceView heating fields; remove authority)
- apps/web/src/lib/deviceTypes.ts (heating.built = true)
- apps/web/src/components/AutomationRow.tsx (remove Shadow/Auto buttons)
- apps/web/src/screens/Automations.tsx (remove authority state/UI)
- apps/api/src/connectors/airzone.ts (per-zone mode; surface heating fields)
- apps/api/src/routes/devices.ts (merge heating fields; drop authority parse)
- apps/api/src/store.ts (remove AutomationAuthority + field + default)
- apps/api/src/control/climate-coordinator.ts (remove shadow/auto branch)

1. Data model
DeviceView (types.ts:442) already has type, power, mode, setpointC, currentTempC, min/maxSetpointC, warmth, automationEnabled, manualOverrideUntil. Add the heating-specific read fields (null/absent for cooling units):
  floorDemand?: boolean | null;   // room actively calling for heat (loop open) → drives the flame
  humidity?:    number | null;    // % RH, detail page
  wireless?:    boolean | null;   // radio thermostat
  lowBattery?:  boolean | null;   // radio thermostat low battery
These already exist on AirzoneZone (airzone.ts:95) but toClimateUnit drops them — surface them through (see §2). Airzone levers stay power | setpoint | mode (no fan/vane — underfloor has none). Setpoint is whole/0.5° (step), clamped to min/maxSetpointC.
Removed model: AutomationAuthority and Automation.authority (see §5).

2. Backend
- connectors/airzone.ts — mode is PER-ZONE, not system-level. The current setLever(…,'mode') writes on the system master zone and the comment calls mode "SYSTEM-level" (airzone.ts:13, :229). User-confirmed 2026-06-26: mode is per-room. Change the mode write to target the specific zoneID (same as power/setpoint), and fix the comment.
- Surface heating fields: extend ClimateUnit (or pass through in the devices route) with floorDemand/humidity/wireless/lowBattery from AirzoneZone so they reach DeviceView.
- routes/devices.ts — map the new fields into DeviceView for air-* units; leave them null for Intesis. Drop the authority parse/persist (§5).
- Gating unchanged: command writes stay admin + armed; reads any-authed. Setpoint/mode/power clamp + validate server-side as today.

3. Devices page — Heating content (Devices.tsx)
Flip heating.built = true (deviceTypes.ts:29) so the hub renders this instead of ComingSoon. Reuse the existing TypeTabs, SummaryTile, and list Card. Heating uses the --grid hue.
Summary tiles (4): Heating now (n/total — count floorDemand) · Indoor avg · Coldest room (cyan/--battery when cold) · Surplus (orange --grid/--grid-wash accent — pre-heat headroom kW).
Autopilot row — single on/off: use AutomationRow (now simplified, §5): flame icon (--grid), title "Solar-surplus pre-heat", subtitle "Automation · heating", master toggle only. When globally disarmed, dim the row + toggle off (same as Cooling).
Unit row — inherits the new inline controls. Desktop grid (Room/zone · State · Mode · Solar · Setpoint · Room · Power · ›):
- Room / zone — name + floor subtitle.
- State pill — HEATING (--grid/--grid-wash) when power && floorDemand; IDLE (--surface-3/--text-2) when on at setpoint; OFF (--text-3). Tint follows active mode (cool → --battery).
- Mode chip — CLICKABLE. Bordered pill, mode text + selector affordance, hue-coded (heat --grid, cool --battery, auto --text-2). Cycles heat → cool → auto on click and writes the mode lever (per-zone). Clamp to the zone's availableModes.
- Solar flame — flame icon, three states: lit + soft glow = heating on free surplus (automationEnabled && floorDemand && grid exporting); dim (≈0.32) = enrolled but on paid energy now; faint (≈0.25, --text-3) = not in pre-heat. (Surplus from the live grid export, same surplusKw(live) already in Devices.tsx:35.)
- Setpoint — CONFIGURABLE inline. − value + steppers, mono value, 0.5° steps, clamped min/maxSetpointC. Dimmed/disabled when the room is off. Writes the setpoint lever.
- Room — currentTempC, mono, warmth-colored.
- Power — inline toggle. Pill switch, writes the power lever.
- chevron → /devices/:id detail.
Mobile — 2-line row: line 1 = name · flame · room temp · power toggle; line 2 = mode chip + setpoint steppers (right-aligned). Tiles collapse to 2-up; autopilot is icon · title · toggle.
Row writes must reuse the optimistic + debounced lever-command path already built for the AC detail (commits 260ed1b / 9f8c5a9 — debounce setpoint, exempt manual non-power levers from the 30s rate-limit). Admin + armed gated; non-admin or disarmed → controls render disabled.

4. Heating unit detail (DeviceDetail.tsx)
Parallel to the AC detail, trimmed for underfloor:
- Setpoint + Ambient two-card block (same layout), Mode segmented (only the zone's availableModes — typically Heat/Cool/Fan/Stop; no Dry/vanes/fan-steps).
- No fan-speed / vane controls — the registry already gates those to type:'cooling'; keep that gate.
- Heating-only readouts Cooling lacks: humidity, wireless / low-battery chips, floor-demand ("calling for heat") indicator.
- Autopilot banner (include/exclude this room from solar-surplus pre-heat) — single toggle.
- Schedule card per the schedules brief (out of scope here if not yet landed).

5. Cross-cutting — remove Shadow/Auto authority (whole system)
Per 2026-06-26 decision, the Shadow/Auto authority selector is dropped entirely.
BEHAVIOR CONSEQUENCE — read this. authority is not just UI. climate-coordinator.ts only issues real commands when authority === 'auto'; in shadow it logs intended actions and writes nothing (a dry-run safety mode). Removing authority means: when an automation is enabled (and control is armed), it acts — there is no more dry-run. The only gates left are the per-automation enabled toggle and the global arm. This is intended; surface it in the PR description.
Changes:
- components/AutomationRow.tsx — remove the Shadow/Auto buttons (:48–49); row becomes icon · title/subtitle · master toggle. Used by both Cooling and Heating autopilot rows.
- screens/Automations.tsx — remove authority state, setAuthAndSave, and the selector wiring (:71,:78–79,:96,:99).
- lib/types.ts — remove AutomationAuthority (:576) and Automation.authority (:593).
- api/store.ts — remove AutomationAuthority (:299), the field (:321), default (:490).
- api/routes/devices.ts — drop the authority parse on create/update (:464,:483).
- api/control/climate-coordinator.ts — remove the isAuto branch (:102); when invoked for an enabled+armed automation, always issue the guardrailed commands (drop the shadow log-only path).

6. Notes / out of scope
- Reuse components/ui primitives (Card, Icon, Button, IconButton) and the 5 energy hues only — no new colors. Numerals in .pwr-mono.
- Cooling row inline controls (mode chip / setpoint steppers / power toggle on the Cooling list rows) are a separate, design-approved-but-not-yet-built slice — do NOT add them to the Cooling rows in this PR. This PR only touches Cooling via the shared authority removal (§5).
- Lighting / Switching remain placeholders.
