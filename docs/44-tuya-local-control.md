# 44 — Tuya local (LAN) control

**Status:** **Phase 1 COMPLETE and proven on real hardware (2026-08-20).** Cloud access was
restored via a new developer account, all 43 `local_key`s are harvested, and devices answer
full datapoint reads over the LAN with zero cloud calls. Phase 2 (local-first command path,
flag-gated, cloud fallback) is in build. See "Phase 1 results" below for what actually
happened — two findings materially change the design and supersede assumptions above.

## Phase 1 results (2026-08-20) — measured, not assumed

Cloud access was restored with a **new developer account** (the free base-pack block is
account-level, so a fresh account gets its own ~54k-call trial pack; the existing Smart Life
account was linked to it, so **device ids were preserved** and app config reattached).

| Measure | Result |
|---|---|
| `local_key` harvested | **43 / 43** (8 cloud calls) |
| Devices with key + LAN ip | **36 / 43** |
| Locally readable (read-only probe) | **24** |
| Gateway sub-devices (cloud-only by design) | 2 |

### Three findings that change the design

1. **The cloud's `ip` field is the PUBLIC/WAN address, not the LAN address.** Ours came back
   as five different historical ISP addresses. It is useless for local control. The LAN ip
   must come from **UDP discovery** (6666/6667), whose broadcast is encrypted with a
   **well-known STATIC key** (`md5("yGAdlopoPVldABfn")`), not the per-device `local_key` —
   so it costs nothing and self-heals on DHCP drift. Keep `ip` and `lanIp` as separate fields.

2. **UDP discovery under-reports on a mesh network.** A subnet scan found 38 hosts with 6668
   open while only 28 had ever broadcast to us — roughly ten devices are AP-isolated
   (broadcast swallowed, TCP fine). "Silent on UDP" ≠ "powered off". Locate them by **MAC**:
   the cloud supplies it via `factory-infos`, and matching against the ARP table costs no
   connections. Do NOT identify by guessing `local_key`s against open ports — a Tuya device
   accepts only **one local session at a time**, so mass probing locks devices out and
   produces false failures (it identified 0/15 and broke reads that had worked minutes before).

3. **⚠ The fleet contains protocol v3.5, and `tuyapi` cannot speak it.** Confirmed live: frame
   magic `0x00006699` (v3.5, AES-GCM) from `192.168.1.183` and `192.168.1.40` — the
   **CB car charger** and **CB - up WCD's** breakers — versus `0x000055AA` (v3.1–3.4, AES-ECB)
   from the other 28 hosts. Because v3.5 encrypts discovery under a different magic, an
   ECB-only decoder fails silently and the device merely looks "silent"; it then also times
   out against tuyapi on every version. Phase 2 therefore treats **unsupported-version as a
   first-class, non-retrying state** that routes straight to cloud, rather than eating an
   8s timeout per command. Adding real 3.5 support (AES-GCM + session negotiation, as
   `tinytuya` implements) is a follow-up — it matters because the breakers are among the
   most valuable devices to control.

## Problem — the cloud free tier is a dead end for polling

Our Tuya integration is 100% cloud today: every status read and every command signs an HTTP call to
Tuya OpenAPI (`apps/api/src/connectors/tuya.ts`). That path keeps hitting the free-tier quota wall:

- The free plan is a **$0.20/month base resource pack** — roughly **54,000 "foreign" API calls** at
  the metered rate of **$3.71 per million calls**. Our polling (fleet reads + per-device SWR reads +
  button polls) burns that allotment in **~8 days**, after which every Tuya call returns the quota
  code and the whole fleet goes dark (see MEMORY: *Tuya fleet dropout* — the 2026-07-03 blackout that
  the quota guard in PR #193 now cushions but cannot cure).
- **Paid billing is not reachable** for this account. Metered/committed billing is gated behind Tuya
  **Enterprise Verification**; our account is an **unverified Individual Developer**. The only edition
  Tuya offers to convert into is a **$25k/yr Flagship** plan. A ~$1/month metered top-up simply is not
  on the menu — both options are non-starters.
- The base resource pack is currently **Suspended**. Even the free allotment is not flowing right now;
  it refreshes roughly monthly, or the owner can re-subscribe (un-suspend) it manually.

**Local LAN control removes the cloud from the hot path entirely.** Once we know each device's
`{id, ip, local_key, version}` we can read status and send DP (datapoint) commands directly over the
LAN with **zero cloud calls** — polling as often as we like, indefinitely, for free.

## How the Tuya local protocol works

Every Wi-Fi Tuya device runs a local control server on the LAN:

- **Transport:** TCP on **port 6668**. The device speaks a framed binary protocol (magic prefix,
  sequence, command byte, payload, CRC).
- **Protocol versions:** **3.1 → 3.5**. 3.1/3.3 are the common older firmware; **3.4 and 3.5** use
  stronger session negotiation and encryption. The probe reports which version each device speaks so we
  know what the transport layer must support.
- **Encryption:** payloads are **AES**, keyed per-device by the device's **`local_key`** (a 16-char
  secret). Without the correct `local_key` you cannot decrypt status or issue commands — this is the one
  secret that makes local control possible.
- **Discovery:** devices **UDP-broadcast** an announcement (id + encrypted payload) on **ports 6666
  (v3.1) and 6667 (v3.3+)**. Passively listening yields the **id → ip** map without any cloud call, so a
  device that moved on DHCP re-announces itself.

Given `{id, ip, local_key, version}`, a local client (we use the `tuyapi` library for the spike) opens
the TCP session, reads the status DPS, and can set DPs — all on the LAN, no internet round-trip.

## Constraints & caveats

- **Must run on the mini.** Only the mini shares the devices' LAN, and it is CGNAT'd (no inbound SSH).
  The vehicle is the **self-hosted GitHub Actions runner** on the mini (`runs-on: [self-hosted, mini]`),
  exactly like the read-only `ops-device-forensics` workflow.
- **`local_key` rotates on re-pair.** If a device is removed and re-added to the Tuya/Smart-Life app, its
  `local_key` changes. Local control then fails for that device until we refresh its key from the cloud.
  So the cloud is still needed **occasionally** (key refresh), just not on the hot path.
- **v3.4 / v3.5 need stronger crypto.** The probe reports the negotiated version per device; some very
  new firmware may need transport support we should confirm before relying on it.
- **DHCP ip drift.** A device's LAN ip can change on lease renewal. Mitigate with **UDP discovery** (the
  device re-announces its ip) or **static DHCP leases** on the router. Phase 2 wires the discovery
  listener so ip drift self-heals.
- **Not everything is IP-addressable.** Cloud stays mandatory for:
  - **Initial fleet discovery** (enumerating what devices exist),
  - **Cloud scenes** (Tuya-hosted automations),
  - **Zigbee / BLE sub-devices behind a gateway** — e.g. the **wxkg 4-button scene switch** is a Zigbee
    sub-device that talks to a hub, not a direct-IP Wi-Fi device, so it can never be reached at TCP 6668.
    Those stay cloud-controlled.

## The credential-harvest dependency (the only cloud-dependent step)

`local_key` and `ip` both originate in the cloud:

- **`local_key`** comes from `listDevices()` — the associated-users listing already captures it
  (`normalizeRaw` at `apps/api/src/connectors/tuya.ts` ~line 253, field `localKey`, "captured for the
  future local-control path").
- **`ip`** comes from `getDeviceDetail(id)` (`tuya.ts` ~line 574, the per-device detail carrying the LAN
  `ip`).

This is the **only** cloud-dependent part of local control, and it is **cheap and infrequent**: a few
hundred calls **once** (one `listDevices` page-walk + one `getDeviceDetail` per device). We **harvest all
keys in a single burst and cache them to a local file**, then local control runs indefinitely with no
further cloud calls (until a key rotates or a new device is added).

> **Prerequisite (owner action):** the base resource pack is currently **Suspended**, so a live harvest
> needs the owner to first **re-subscribe / un-suspend the free base pack** at `iot.tuya.com`, OR wait for
> the ~monthly free-quota refresh. Until then the probe's harvest step is skipped and it runs off any
> previously-cached creds. One successful harvest is enough to unlock local control for a long time.

Harvested creds are written to **`/Users/joris/sites/energy/.data/tuya-local.json`** on the mini. That
path is under `.data/`, which is already **gitignored** — real keys/ips are **never committed**.

## Phased plan

- **Phase 1 — this PR (read-only protocol validation).**
  `scripts/tuya-local-probe.mjs` + `.github/workflows/ops-tuya-local-probe.yml`. On the mini it (a)
  harvests `{id, name, category, ip, localKey}` (cloud if available + quota allows, else cached), caches
  to `tuya-local.json`, then (b) for each device with `ip`+`localKey` attempts a **local read-only**
  connection via `tuyapi` with **protocol-version auto-detection** (try 3.3 → 3.4 → 3.5), reads the
  status DPS, and prints a fleet report: *how many devices are locally reachable, at which versions, and
  which still need cloud (and why)*. **No device is actuated** unless an explicit `--write-test <id>`
  arg / `write_test_device_id` input is given. The report is the deliverable — it tells us how much of
  the fleet is locally controllable before we build anything real.

- **Phase 2 — discovery + transport wired in (with cloud fallback).**
  Add a **UDP discovery listener** (id → ip on 6666/6667) so ip drift self-heals, and wire a **local
  transport** into the command path. Each command tries **local first, cloud fallback** per device — the
  eventual hook point is **`sendCommandsDual` in `tuya.ts`** (today it fans a command across the three
  cloud APIs; Phase 2 makes local the first, preferred rail before those). Additive and reversible.

- **Phase 3 — status reads move local; cloud reserved for maintenance.**
  Fleet/device status polling reads over the LAN, dropping cloud from the hot path. Cloud is reserved for
  **key refresh** (on rotation) and **initial discovery / new-device onboarding** — a few calls a month,
  comfortably inside even the suspended-then-refreshed free tier. Zigbee/BLE sub-devices (scene switch)
  and cloud scenes remain cloud-controlled by design.

## Research validation & refined plan (2026-07-03)

A deep-research pass (21 sources, 25 adversarially-verified claims, 0 refuted) confirmed this
local-first direction is the **near-universal** community answer to the Tuya cloud-quota wall,
and sharpened a few choices:

- **Library choice validated.** [`codetheweb/tuyapi`](https://github.com/codetheweb/tuyapi)
  (Node, TCP 6668, fully local after setup) is *the* Node-native library — exactly what this
  spike uses. The Python reference impl [`jasonacox/tinytuya`](https://github.com/jasonacox/tinytuya)
  supports the full 3.1–3.5 range and ships the best key-harvest **wizard**.
- **Harvest via the tinytuya wizard (Phase 2 refinement).** Rather than only our hand-rolled
  cloud harvest, fold in tinytuya's `wizard` — the battle-tested way to pull every `local_key`
  into a `devices.json` in one cloud pass. Our tuyapi runtime is unchanged; the wizard is purely
  a one-shot harvest tool. Cross-check: any device tinytuya's 3.5 session negotiation can't reach
  is worth re-testing against [`make-all/tuya-local`](https://github.com/make-all/tuya-local)
  (1000+ configs, widest 3.5 coverage) to confirm it's reachable at all.
- **`local_key` rotates on re-pair — confirmed.** A one-time harvest is effectively permanent
  *unless* a device is reset/re-paired; then re-harvest that device's key. Matches our design.
- **Free trial *extension* is the validated bridge.** The community stopgap is NOT paying — it's
  repeatedly requesting **free trial extensions** (approved in ~1–2 days; multi-month grants
  reported). We already extended IoT Core to **2027-01-25**, so we have a long runway; another
  extension is the free lever if we ever need to un-suspend sooner. (Confirmed: paid metered
  billing is gated behind Enterprise Verification; the visible paid edition is the $25k Flagship.
  Also: Tuya caps accounts at **2 projects**, and the base-pack block is account-level, so
  "spin up a fresh project for new quota" is a dead end.)
- **Offline key extraction — downgraded.** The phone-app routes (rooted-Android SQLite, iOS
  backup, pairing packet capture) could NOT be corroborated; only cloud-based extractors
  (e.g. `redphx/tuya-local-key-extractor`) are confirmed. **Plan: harvest via cloud once** after
  the quota refresh — do not rely on offline extraction.
- **Parallel track — Zigbee switch off the gateway.** The wxkg 4-button scene switch (never
  IP-addressable) can move off the Tuya gateway onto **Zigbee2MQTT/ZHA** with a generic
  coordinator (Sonoff/ConBee), fully de-clouding it. Tracked separately from this connector work.
- **Firmware reflash — explicit last resort.** `tuya-cloudcutter` + LibreTiny/OpenBeken/ESPHome
  can convert Beken/Realtek-chip devices to open firmware, but Tuya patched the OTA exploit
  (Feb 2022) so newer stock is often serial-only, and **breakers must never be reflashed**
  (bricking risk on a live circuit). Reserve for a single stubborn plug, never the fleet.

### Execution checklist — run at the ~monthly quota refresh (end of July 2026)

1. Confirm the base resource pack shows **In service** (quota reset) at `iot.tuya.com` — refresh
   is ~the 25th; or request another free trial extension to un-suspend sooner.
2. Run `ops-tuya-local-probe` (read-only) on the mini → read the fleet reachability report.
3. If most Wi-Fi devices answer locally: merge this PR (#201), then build Phase 2 (UDP discovery
   + local-first transport with cloud fallback at `sendCommandsDual`), harvesting keys via the
   tinytuya wizard into the cached `devices.json`/`tuya-local.json`.
4. Schedule the Zigbee-switch → Zigbee2MQTT migration as its own small brief.

## What this PR intentionally does NOT do

- Does **not** touch `sendCommandsDual` or any control/arming logic — the spike is purely additive
  (new doc + new standalone script + new read-only workflow + one dev-only dependency for the script).
- Does **not** actuate real devices by default — reading status is safe; toggling is opt-in behind the
  explicit write-test input.
- Does **not** deploy — it is `scripts/` + `docs/` + `.github/` only, all of which are `paths-ignore`d in
  `deploy.yml`, so merging it never restarts the API or disarms control.
