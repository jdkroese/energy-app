# docs/44 — Sungrow reconnect resilience: cloud + hardened local

## Why (incident 2026-07-03)
Both WiNet-S dongles went dark: **green WiFi LED on, local web UI + our `ws://<ip>:8082` dead.**
Classic WiNet-S lockup — the dongle's internal server crashes under **repeated local polling**
(openHAB community-confirmed) and/or DHCP reassigned the IPs (static IPs were never set). Same day a
**breaker tripped on one inverter and NOBODY was alerted.**

Root design flaw: **outage detection is built on the one component that fails with the inverter.**
A breaker trip, a crashed dongle, and a DHCP move all look identical ("unreachable"), and with both
dongles down the app has **no independent source of truth**. Fix = add a LAN-independent source
(iSolarCloud) + stop our own polling from crashing the dongles + make "one inverter dark while the
other/clear-sky says it shouldn't be" a reliable, high-severity alert.

Owner decisions (2026-07-03): **Cloud + hardened local**; owner is **applying for the iSolarCloud
OpenAPI key now** (build the cloud path gated, ready to activate when key lands).

## Existing code map (all in apps/api/src unless noted)
- `connectors/sungrow.ts` — local WS+REST reader. `wsReadLive(ip)` opens `ws://<ip>:8082/ws/home/overview`,
  handshake connect→devicelist→real→fault in ONE socket (dongle rate-limits guests). `getNormalized()` =
  `cached('sungrow.normalized', 20_000, ...)` reads BOTH dongles every 20s via Promise.all. Plausibility
  guard `plausibleAcPowerW` (>5.5kW rejected). Per-inverter id = dongle IP.
- `runtime-config.ts` `sungrowConfig()` — dongles from store.integrations.sungrow.dongles → env
  SUNGROW_HOST_1/2 → defaults .67/.181. `{ip,name,ratedKw}`.
- `control/inverter-history.ts` + `db/sqlite.ts` v3 — inverter_5m(90d)/hourly(3y)/daily(forever),
  keyed by inverter_id. Only reachable inverters recorded.
- `routes/live.ts` (~178-225) — 3-way solar split: if any Sungrow reachable → arrays = per reachable
  inverter + Tesla; else fallback splits Sonnen proxy evenly (est). Site clamp 18kW.
- `routes/alerts.ts` — rules: inverter-fault (not gated), inverter-offline (daylight-gated, 5-tick),
  inverter-stall (daylight-gated, 5-tick), grid-quality (>=4 trips/1h), imbalance (<60% sibling).
  `expectMeaningfulProductionNow()` from `solar-daylight.ts` is the daylight gate.
- `alert-loop.ts` — debounce (default 2 ticks; inverter-offline/stall overridden to 5), re-notify 6h,
  recovery messages. Channels Push+WhatsApp+Email.
- `routes/health-probe.ts` — per-dongle reachability, asleep≠offline.
- `routes/inverters.ts` — GET /api/inverters + /history.
- `routes/integrations-config.ts` — dongle IP test/persist.
- web `screens/SolarInverters.tsx` (exported `<SolarGenerationSection>`, hosted in `Batteries.tsx` Energy hub),
  `components/energy/EnergyFlow.tsx`, Settings Sungrow row, deviceTypes `solar-inverter`.
- Event Viewer: EventCategory 'solar'. Node on mini v26. API tests = `node --import tsx --test` (NOT vitest).

## Deliverables

### Phase A — Hardened local + reliable "inverter dark" alert (ship first, fully testable)
1. **Stop crashing the dongle.** Reduce local pressure:
   - Raise `getNormalized` cache TTL 20s → **60s** (config-driven, `SUNGROW_POLL_SEC`, default 60).
   - **Single-flight** guard so overlapping callers never open 2 sockets to the same dongle.
   - **Exponential backoff on failure**: after a failed read, don't retry that dongle until
     backoff elapses (e.g. 60s→2m→5m cap). A locked dongle must be left alone, not hammered.
   - Keep the one-socket connect→real→fault design.
2. **Lockup vs outage classification** in the connector output per inverter:
   `state: 'producing' | 'asleep' | 'unreachable'` plus `reachableSibling: bool`, `lastGoodTs`.
3. **New reliable alert `rule-inverter-dark`** (HIGH/critical, Push+WA+Email): fire when an inverter is
   unreachable/zero **AND** (the sibling is reachable & producing **OR** clear-sky expects meaningful
   production). This catches a single-inverter breaker trip even when the other is fine, and does NOT
   depend on both-down. Debounce ~5 min, daylight-gated via `expectMeaningfulProductionNow`. Recovery msg.
   Keep existing rules; this is the safety net that today's incident needed. Make sure it can't be
   permanently silenced by the 6h re-notify when the condition persists across days — re-alert next
   daylight window if still dark.
4. **Energy-flow resilience** (`live.ts`): when ONE dongle is reachable and the other isn't, do NOT
   collapse to Tesla-only — show the reachable inverter's real kW + mark the dark one explicitly
   (0 kW + `dark:true`), so the flow still attributes per-inverter and the dark unit is visible, not hidden.
5. **Static-IP guidance surfaced in Settings**: the dongle-IP inputs already exist; add helper text
   ("set a DHCP reservation on your router for each dongle's MAC so these never change") + show
   last-seen-at per dongle so drift is visible.

### Phase B — iSolarCloud connector (build gated; verify when key lands)
6. **New `connectors/isolarcloud.ts`** — EU region (`gateway.isolarcloud.eu` / dev portal
   `developer-api.isolarcloud.com`). Auth = appkey + x-access-key + RSA/AES per the OpenAPI (use
   `bugjam/pysolarcloud` and `MickMake/GoSungrow` as protocol reference). Endpoints: plant/device list,
   per-device real-time active power + daily/total yield + device fault/run state. Poll ~5 min (respect
   rate limits). Fail-soft, cached.
7. **Config** (`runtime-config.ts`): `isolarcloudConfig()` from store.integrations.isolarcloud
   (appkey, accessKey, rsaPublicKey, account email/uid, region) → env fallback
   (ISOLARCLOUD_APPKEY / _ACCESS_KEY / _RSA_KEY / _REGION). Disabled/no-op if unconfigured.
8. **Source merge** (a small `solar-sources.ts` or inside live.ts): per inverter, prefer **local** for
   live kW resolution when fresh (<2 min), fall back to **cloud** when local is stale/unreachable.
   Match cloud device ↔ local dongle by serial (dev_sn A2160700249 etc.) or by an owner-set mapping in
   Settings. Cloud becomes the **outage source of truth**: `rule-inverter-dark` should trust cloud
   "device offline" even when local is also down (LAN outage no longer blinds us).
9. **History + energy flow + health + Settings + Connections** all read the merged source, so per-inverter
   numbers and history survive a full local-LAN outage.
10. **Settings**: iSolarCloud credentials row (appkey/accessKey/RSA/account, test+save via
    integrations-config test/setIsolarcloud), and a per-inverter cloud↔local mapping display.

## Constraints / guardrails
- **Read-only integration. No control loop. Safe deploy (no disarm).** All fetch/ws target only dongle IPs
  and the iSolarCloud host — no command/write imports. Verify this explicitly.
- Additive, idempotent DB migration (CREATE IF NOT EXISTS) — existing v3 DB untouched.
- Guard the /api/live hot path (Promise.allSettled + fail-soft); a dead cloud or dead dongle must never
  break /api/live or the armed control loop.
- Web + mobile both (branch on ctx.desktop); follow the Power design system. Room/device lists alphabetical.
- Match hand-formatting; do NOT run Prettier. Room names alphabetical.
- Tests: add `node --import tsx --test` coverage for the source-merge/dark-classification logic and the
  cloud request-signing (mock HTTP). typecheck + both builds GREEN before PR.
- Event Viewer: new dark/cloud events use EventCategory 'solar'; lift inverter-dark to critical severity.

## Workflow
- Isolated worktree off latest origin/main: `bash scripts/new-worktree.sh sungrow-resilience`.
- `git config core.hooksPath scripts/githooks` (inherited in helper worktrees).
- Branch `sungrow-resilience`. Commit the brief as `docs/44-sungrow-reconnect-resilience.md`.
- **Review-first PR, NO self-merge.** Rebase on origin/main before push. Report the PR number back.
- Cloud path (Phase B) ships gated/disabled-until-configured; note in the PR that it's unverified
  against real credentials until the owner's iSolarCloud key is issued.
