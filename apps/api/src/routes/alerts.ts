import * as sonnen from '../connectors/sonnen';
import * as tesla from '../connectors/tesla';
import * as sungrow from '../connectors/sungrow';
import { bandFor } from '../tariff';
import { probeAll } from './health-probe';
import { getMonitoredBreaker } from '../connectors/tuya-voltage';
import { expectMeaningfulProductionNow } from '../solar-daylight';
import * as store from '../store';

export type Severity = 'danger' | 'warning' | 'info' | 'ok';

export interface Alert {
  id: string;
  severity: Severity;
  icon: string;
  title: string;
  sub: string;
  device: string;
  ts: string;
  status: store.AlertStatus;
  /** Which rule produced this alert (so we can honour rule enable/disable). */
  rule?: string;
}

const RESERVE_TARGET = 20; // %

// Channel + rule presentation metadata (labels/icons). Enable-state lives in the store.
const RULE_META: Record<string, { icon: string; label: string }> = {
  'rule-grid-charge': { icon: 'plug-zap', label: 'Charging from grid at high SoC' },
  'rule-reserve': { icon: 'shield-alert', label: 'Backup reserve below target' },
  'rule-offline': { icon: 'wifi-off', label: 'Device unreachable' },
  'rule-outage': { icon: 'zap-off', label: 'Grid outage detected' },
  'rule-export': { icon: 'arrow-up-from-line', label: 'Exporting during P1 (wasted value)' },
  'rule-charge-stall': { icon: 'battery-warning', label: 'Sonnen not absorbing surplus' },
  'rule-voltage': { icon: 'zap', label: 'Grid voltage out of band' },
  'rule-inverter-fault': { icon: 'triangle-alert', label: 'Solar inverter fault/alarm' },
  'rule-inverter-dark': { icon: 'zap-off', label: 'Solar inverter dark (breaker/outage)' },
  'rule-inverter-offline': { icon: 'wifi-off', label: 'Solar inverter offline (daylight)' },
  'rule-inverter-stall': { icon: 'sun-dim', label: 'Solar inverter not producing' },
  'rule-inverter-grid-quality': { icon: 'zap', label: 'Repeated grid-voltage trips (inverter)' },
  'rule-inverter-imbalance': { icon: 'scale', label: 'Solar inverters producing unevenly' },
  'rule-tesla-solar-dark': { icon: 'zap-off', label: 'Tesla solar array dark (breaker/outage)' },
  'rule-sonnen-fault': { icon: 'battery-warning', label: 'Sonnen battery fault' },
};

// ---- Grid-quality trip aggregation (rule-inverter-grid-quality) -------------
// Voltage trips auto-recover in seconds, so we DON'T page on every flap. We track
// each inverter's under/over-voltage fault transitions over a rolling 1h window and
// only fire when the count in the window crosses a threshold. Keyed by inverter id;
// each new Active transition (a fault key not currently marked active) records a ts.
const GRID_TRIP_WINDOW_MS = 60 * 60 * 1000;
const GRID_TRIP_THRESHOLD = 4; // trips within the window before we corroborate rule-voltage
const gridTripTimes = new Map<string, number[]>(); // inverterId → [epoch ms of Active transitions]
const gridTripActive = new Map<string, Set<string>>(); // inverterId → fault keys currently Active

function isVoltageTrip(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes('voltage') && (n.includes('under') || n.includes('over'));
}

/**
 * Madrid calendar-date key (YYYY-MM-DD). The dark-inverter alert id is suffixed with
 * this so a still-dark inverter re-alerts once per DAYLIGHT WINDOW (a new day mints a
 * new id → the 6h re-notify dedupe can't permanently silence a multi-day outage — the
 * exact failure mode of the 2026-07-03 incident where a tripped breaker went unnoticed).
 */
function madridDateKey(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** Fold this poll's fault list into the rolling voltage-trip counter for an inverter. */
function trackGridTrips(inverterId: string, faults: sungrow.InverterFault[]): number {
  const now = Date.now();
  const active = gridTripActive.get(inverterId) ?? new Set<string>();
  const times = (gridTripTimes.get(inverterId) ?? []).filter((t) => now - t < GRID_TRIP_WINDOW_MS);
  const seenNow = new Set<string>();
  for (const f of faults) {
    if (!isVoltageTrip(f.name)) continue;
    const key = `${f.name}#${f.code ?? ''}`;
    const isActive = f.status.toLowerCase().includes('active');
    if (isActive) {
      seenNow.add(key);
      // A NEW Active transition (wasn't active last poll) counts as one trip.
      if (!active.has(key)) times.push(now);
    }
  }
  gridTripActive.set(inverterId, seenNow);
  gridTripTimes.set(inverterId, times);
  return times.length;
}

// A small seeded set of historical/resolved alerts so the feed is never empty.
function seeded(): Alert[] {
  return [
    {
      id: 'seed-1',
      severity: 'ok',
      icon: 'check-circle',
      title: 'Sonnen back online',
      sub: 'LAN connection restored after brief drop',
      device: 'Sonnen',
      ts: new Date(Date.now() - 6 * 3600_000).toISOString(),
      status: 'resolved',
    },
    {
      id: 'seed-2',
      severity: 'info',
      icon: 'sun',
      title: 'High solar forecast tomorrow',
      sub: 'Plan favours midday battery charging',
      device: 'Brain',
      ts: new Date(Date.now() - 2 * 3600_000).toISOString(),
      status: 'ack',
    },
  ];
}

function ruleEnabled(id: string): boolean {
  const r = store.get().rules.find((x) => x.id === id);
  return r ? r.enabled : true;
}

/**
 * Evaluate the live system against the enabled rules and return any *currently
 * firing* alerts (status 'new'). Shared by GET /api/alerts and the background
 * notification loop, so they never disagree. READ-ONLY — never sends a command.
 */
export async function evaluateLiveAlerts(): Promise<Alert[]> {
  const now = new Date().toISOString();
  const live: Alert[] = [];

  const probe = await probeAll();

  if (ruleEnabled('rule-offline')) {
    if (!probe.sonnen.ok) {
      live.push({
        id: 'sonnen-offline',
        severity: 'danger',
        icon: 'wifi-off',
        title: 'Sonnen unreachable',
        sub: probe.sonnen.detail,
        device: 'Sonnen',
        ts: now,
        status: 'new',
        rule: 'rule-offline',
      });
    }
    if (!probe.tesla.ok) {
      live.push({
        id: 'tesla-offline',
        severity: 'warning',
        icon: 'cloud-off',
        title: 'Tesla cloud unreachable',
        sub: probe.tesla.detail,
        device: 'Tesla',
        ts: now,
        status: 'new',
        rule: 'rule-offline',
      });
    }
  }

  // State-derived alerts (best-effort).
  const [sRes, tRes] = await Promise.allSettled([sonnen.getNormalized(), tesla.getNormalized()]);

  if (sRes.status === 'fulfilled') {
    const s = sRes.value;
    if (ruleEnabled('rule-grid-charge') && s.dir === 'charging' && s.soc >= 95 && s.gridFeedInW < -50) {
      live.push({
        id: 'sonnen-grid-charge-high',
        severity: 'warning',
        icon: 'plug-zap',
        title: 'Sonnen charging from grid at high SoC',
        sub: `SoC ${s.soc}% — avoid paying to top off a full battery`,
        device: 'Sonnen',
        ts: now,
        status: 'new',
        rule: 'rule-grid-charge',
      });
    }
    // Exporting during P1 — exported energy is near-worthless vs P1 self-use value.
    if (ruleEnabled('rule-export') && s.gridFeedInW > 200 && bandFor(new Date()) === 'P1') {
      live.push({
        id: 'export-during-p1',
        severity: 'info',
        icon: 'arrow-up-from-line',
        title: 'Exporting during P1',
        sub: `${Math.round(s.gridFeedInW)} W out — that energy is worth €0.21/kWh if self-used`,
        device: 'Solar',
        ts: now,
        status: 'new',
        rule: 'rule-export',
      });
    }

    // Sonnen not absorbing the solar surplus — only meaningful when the coordinator is
    // actively managing the battery (armed + auto). NET export means neither battery is
    // soaking the surplus, so this cleanly excludes the legit "Tesla-first idles Sonnen"
    // case. The usual cause is a grid OVER-VOLTAGE trip: the inverter stops charging AND
    // exporting while the house still spills to grid, and the control log shows healthy
    // "setpoint issued / ok" because the Sonnen 200s the command but ignores it.
    const ctrl = store.get().control;
    if (
      ruleEnabled('rule-charge-stall') &&
      ctrl.armed &&
      ctrl.mode === 'auto' &&
      s.gridFeedInW > ctrl.soakExport.startW &&
      s.soc < ctrl.soakExport.socCeilingPct &&
      s.dir !== 'charging'
    ) {
      // Diagnostic: read the monitored breaker voltage and the Sonnen's own Uac. If EITHER
      // is above the configured band, this is almost certainly an over-voltage trip.
      const vm = store.get().voltageMonitor;
      const breaker = await getMonitoredBreaker().catch(() => null);
      const breakerHigh = !!breaker && breaker.voltageV > 0 && breaker.voltageV > vm.maxV;
      const uacHigh = s.uacV > 0 && s.uacV > vm.maxV;
      const sub =
        breakerHigh || uacHigh
          ? `Exporting ${Math.round(s.gridFeedInW)} W with SoC ${s.soc}% — likely grid over-voltage trip (Uac ${s.uacV} V)`
          : `Exporting ${Math.round(s.gridFeedInW)} W with SoC ${s.soc}% but battery idle — not absorbing surplus`;
      live.push({
        id: 'sonnen-charge-stall',
        severity: 'danger',
        icon: 'battery-warning',
        title: 'Sonnen not absorbing surplus',
        sub,
        device: 'Sonnen',
        ts: now,
        status: 'new',
        rule: 'rule-charge-stall',
      });
    }
  }

  if (tRes.status === 'fulfilled') {
    const t = tRes.value;
    if (ruleEnabled('rule-reserve') && t.reservePct < RESERVE_TARGET) {
      live.push({
        id: 'tesla-reserve-low',
        severity: 'warning',
        icon: 'shield-alert',
        title: 'Tesla backup reserve below target',
        sub: `Reserve ${t.reservePct}% (target ${RESERVE_TARGET}%)`,
        device: 'Tesla',
        ts: now,
        status: 'new',
        rule: 'rule-reserve',
      });
    }
    if (ruleEnabled('rule-outage') && t.island) {
      live.push({
        id: 'tesla-island',
        severity: 'danger',
        icon: 'zap-off',
        title: 'Grid outage — running on battery',
        sub: `~${t.backupHours}h autonomy at current reserve`,
        device: 'Tesla',
        ts: now,
        status: 'new',
        rule: 'rule-outage',
      });
    }
  }

  // Grid voltage out of band — gated on its OWN config (voltageMonitor.enabled), not the
  // generic rule toggle. Reads the monitored Tuya breaker's live voltage; debounced in the
  // alert loop (2 consecutive ticks) since the reading fluctuates a lot.
  const vm = store.get().voltageMonitor;
  if (vm.enabled) {
    const breaker = await getMonitoredBreaker().catch(() => null);
    // Only evaluate a real reading (>0). A poll that momentarily lacks cur_voltage
    // reads as 0 and must not fire a false "0 V — out of band" alert.
    if (breaker && breaker.voltageV > 0 && (breaker.voltageV < vm.minV || breaker.voltageV > vm.maxV)) {
      live.push({
        id: 'voltage-out-of-band',
        severity: 'danger',
        icon: 'zap',
        title: 'Grid voltage out of band',
        sub: `${breaker.voltageV} V — outside ${vm.minV}–${vm.maxV} V band`,
        device: breaker.name,
        ts: now,
        status: 'new',
        rule: 'rule-voltage',
      });
    }
  }

  // ---- Solar inverters (Sungrow SG5.0RS ×2; docs/36) --------------------------
  // READ-ONLY. Night-gated where relevant: the string inverters + their WiNet-S
  // dongles de-energize at dusk, so an unreachable/zero-output reading is only an
  // alert when clear-sky expects meaningful production.
  const wantInverterRules =
    ruleEnabled('rule-inverter-fault') ||
    ruleEnabled('rule-inverter-dark') ||
    ruleEnabled('rule-inverter-offline') ||
    ruleEnabled('rule-inverter-stall') ||
    ruleEnabled('rule-inverter-grid-quality') ||
    ruleEnabled('rule-inverter-imbalance') ||
    // The Tesla-array-dark rule needs the Sungrow reading (as its producing-daylight proof),
    // so include it in the gate that fetches invRes.
    ruleEnabled('rule-tesla-solar-dark');
  if (wantInverterRules) {
    const invRes = await sungrow.getNormalized().catch(() => null);
    if (invRes && invRes.inverters.length > 0) {
      // Daylight/expected-production gate — computed once for the offline/stall rules.
      const daylight = await expectMeaningfulProductionNow().catch(() => false);

      for (const iv of invRes.inverters) {
        // 0) DARK — the reliable single-inverter outage net (docs/44). Fire when this
        //    inverter is dark (unreachable, OR reachable-but-zero) AND either its twin is
        //    reachable+producing (independent proof the roof CAN produce right now) OR
        //    clear-sky expects meaningful production. Catches a breaker trip on ONE
        //    inverter even when the other is healthy — without depending on both being
        //    down. Trusts the cloud backstop when present (LAN outage no longer blinds us).
        //    Critical severity; the id is daylight-window-keyed so a persistent outage
        //    re-alerts each new day rather than being silenced by the 6h dedupe.
        if (ruleEnabled('rule-inverter-dark')) {
          const isDark = !iv.reachable || iv.acPowerW < 50;
          const siblingProducing = invRes.inverters.some(
            (o) => o.id !== iv.id && o.reachable && o.acPowerW >= 50,
          );
          const cloudSaysDark = iv.cloudConfirmedDark === true;
          // Gate: fire only when production is genuinely expected — either the twin is
          // actively producing (unarguable proof) OR the clear-sky model expects output,
          // OR the cloud source confirms this specific unit is offline. This suppresses
          // the whole-array night sleep (both dark, no daylight) that is normal.
          if (isDark && (siblingProducing || daylight || cloudSaysDark)) {
            const why = iv.reachable
              ? `reachable but producing ~0 W`
              : `unreachable (${iv.detail ?? 'no response'})`;
            const proof = siblingProducing
              ? `its twin is producing ${((invRes.inverters.find((o) => o.id !== iv.id && o.reachable && o.acPowerW >= 50)?.acPowerW ?? 0) / 1000).toFixed(1)} kW right now`
              : cloudSaysDark
                ? `iSolarCloud reports this inverter offline`
                : `clear-sky expects meaningful production now`;
            live.push({
              id: `inverter-dark-${iv.id}-${madridDateKey()}`,
              severity: 'danger',
              icon: 'zap-off',
              title: `${iv.name} is dark`,
              sub: `${iv.name} ${why} while ${proof} — likely a tripped breaker or a crashed dongle. Check the inverter.`,
              device: iv.name,
              ts: now,
              status: 'new',
              rule: 'rule-inverter-dark',
            });
          }
        }

        // 1) Fault/alarm Active — page immediately, naming the cause. Not night-gated
        //    (a real fault while asleep is unusual but still worth surfacing).
        if (ruleEnabled('rule-inverter-fault')) {
          const active = sungrow.activeFaults(iv.faults);
          const nonVoltage = active.filter((f) => !isVoltageTrip(f.name));
          const primary = nonVoltage[0] ?? active[0];
          if (iv.reachable && iv.workState === 'Fault' && active.length === 0) {
            // Work-state says Fault but the log had nothing parseable — still alert.
            live.push({
              id: `inverter-fault-${iv.id}`,
              severity: 'danger',
              icon: 'triangle-alert',
              title: `Fault on ${iv.name}`,
              sub: `${iv.name} reports work-state Fault`,
              device: iv.name,
              ts: now,
              status: 'new',
              rule: 'rule-inverter-fault',
            });
          } else if (primary) {
            live.push({
              id: `inverter-fault-${iv.id}`,
              severity: primary.type.toLowerCase() === 'fault' ? 'danger' : 'warning',
              icon: 'triangle-alert',
              title: `${primary.name} on ${iv.name}`,
              sub: `${primary.type} · fault code ${primary.code ?? '—'}${primary.id != null ? ` (ID ${primary.id})` : ''}`,
              device: iv.name,
              ts: now,
              status: 'new',
              rule: 'rule-inverter-fault',
            });
          }
        }

        // 2) Dongle offline — DAYLIGHT-GATED (night misses are expected + suppressed).
        //    Debounced ~5 min in the alert loop (N consecutive misses).
        if (ruleEnabled('rule-inverter-offline') && !iv.reachable && daylight) {
          live.push({
            id: `inverter-offline-${iv.id}`,
            severity: 'danger',
            icon: 'wifi-off',
            title: `${iv.name} unreachable`,
            sub: `No response from ${iv.ip} while the roof should be producing — ${iv.detail ?? 'check the inverter/dongle'}`,
            device: iv.name,
            ts: now,
            status: 'new',
            rule: 'rule-inverter-offline',
          });
        }

        // 3) Stall — reachable, Run/Standby, but ~0 output while daylight expects some.
        if (
          ruleEnabled('rule-inverter-stall') &&
          iv.reachable &&
          daylight &&
          (iv.workState === 'Run' || iv.workState === 'Standby') &&
          iv.acPowerW < 50
        ) {
          live.push({
            id: `inverter-stall-${iv.id}`,
            severity: 'warning',
            icon: 'sun-dim',
            title: `${iv.name} not producing`,
            sub: `${iv.name} is ${iv.workState} but at ~0 W while clear-sky expects output — possible string/MPPT fault or derating`,
            device: iv.name,
            ts: now,
            status: 'new',
            rule: 'rule-inverter-stall',
          });
        }

        // 4) Grid-quality aggregation — count under/over-voltage trips over the last
        //    hour; fire once past the threshold (corroborates rule-voltage without
        //    paging on every auto-recovering flap).
        const trips = trackGridTrips(iv.id, iv.faults);
        if (ruleEnabled('rule-inverter-grid-quality') && trips >= GRID_TRIP_THRESHOLD) {
          live.push({
            id: `inverter-grid-quality-${iv.id}`,
            severity: 'warning',
            icon: 'zap',
            title: `Repeated grid-voltage trips on ${iv.name}`,
            sub: `${trips} grid under/over-voltage trips in the last hour — weak-grid event corroborating the voltage monitor`,
            device: iv.name,
            ts: now,
            status: 'new',
            rule: 'rule-inverter-grid-quality',
          });
        }
      }

      // 5) Imbalance — the two arrays are near-identical, so under the SAME daylight
      //    conditions one producing materially less than its twin flags slow
      //    degradation (soiling/shading/string fault). Only when BOTH are reachable,
      //    daylight expects output, and the leader is producing a meaningful amount.
      if (ruleEnabled('rule-inverter-imbalance')) {
        const daylightNow = await expectMeaningfulProductionNow().catch(() => false);
        const both = invRes.inverters.filter((i) => i.reachable);
        if (daylightNow && both.length === 2) {
          const [a, b] = both;
          const hi = Math.max(a.acPowerW, b.acPowerW);
          const lo = Math.min(a.acPowerW, b.acPowerW);
          const lagging = a.acPowerW < b.acPowerW ? a : b;
          const leader = a.acPowerW < b.acPowerW ? b : a;
          // Require a meaningful leader (>1 kW) and the laggard <60% of it, both healthy
          // (no active fault — a fault is already covered by rule-inverter-fault).
          const laggingHasFault = sungrow.activeFaults(lagging.faults).length > 0;
          if (hi > 1000 && lo < hi * 0.6 && !laggingHasFault) {
            live.push({
              id: `inverter-imbalance-${lagging.id}`,
              severity: 'info',
              icon: 'scale',
              title: `${lagging.name} under-producing`,
              sub: `${lagging.name} at ${(lo / 1000).toFixed(1)} kW vs ${leader.name} at ${(hi / 1000).toFixed(1)} kW under the same sun — check for shading/soiling/string fault`,
              device: lagging.name,
              ts: now,
              status: 'new',
              rule: 'rule-inverter-imbalance',
            });
          }
        }
      }

      // 6) TESLA-METERED ARRAY DARK (rule-tesla-solar-dark) — the 3rd solar source is the
      //    Tesla-metered array (dedicated = solar_power − the Sungrows, since the Tesla CT
      //    reads whole-site solar). Nothing else monitors it going dark. Fire ONLY when
      //    the Sungrows PROVE it's a genuine producing-daylight moment (so we don't page
      //    at dawn/dusk on a low-sun sample) and Tesla's own array reads ~0: a likely
      //    tripped breaker / crashed gateway on that string. Conservative + daylight-gated;
      //    debounced ~5 ticks in the alert loop. Danger; recovery message on real recovery.
      if (ruleEnabled('rule-tesla-solar-dark') && probe.tesla.ok && tRes.status === 'fulfilled') {
        const teslaSolarKw = tRes.value.solarKw;
        // Measured Sungrow AC across LIVE inverters (local OR cloud), same predicate the
        // energy-flow split uses — this is the "it's genuinely producing weather" proof.
        const sungrowKw =
          invRes.inverters.reduce(
            (sum, iv) => sum + (iv.reachable && iv.acPowerW > 0 ? iv.acPowerW : 0),
            0,
          ) / 1000;
        const teslaDedicated = Math.max(0, teslaSolarKw - sungrowKw);
        // Gate: only when the Sungrows are clearly producing (>1 kW) — an unarguable proof
        // the roof CAN produce right now — AND daylight expects output — AND Tesla's own
        // residual is ~dark (<0.1 kW).
        if (daylight && sungrowKw > 1 && teslaDedicated < 0.1) {
          live.push({
            id: `tesla-solar-dark-${madridDateKey()}`,
            severity: 'danger',
            icon: 'zap-off',
            title: 'Tesla solar array is dark',
            sub: `The Tesla-metered array is producing ~0 kW while the Sungrows are generating ${sungrowKw.toFixed(1)} kW under the same sun — likely a tripped breaker or a crashed gateway on that string. Check the array.`,
            device: 'Tesla',
            ts: now,
            status: 'new',
            rule: 'rule-tesla-solar-dark',
          });
        }
      }
    }
  }

  // ---- Battery fault/health (Sonnen; monitoring only, docs/45) ----------------
  // Sonnen reports a hardware/comms FAULT via ic_status (front LED red / DC-shutdown /
  // error code). This is DISTINCT from plain unreachability (rule-offline already covers
  // that for both packs). Read-only + conservative: only fires on a clearly-negative,
  // reliably-present field; a missing field ⇒ known:false ⇒ no alert. Debounced ~3 ticks.
  if (ruleEnabled('rule-sonnen-fault')) {
    const fs = await sonnen.getFaultStatus().catch(() => null);
    if (fs && fs.known && fs.fault) {
      live.push({
        id: 'sonnen-fault',
        severity: 'danger',
        icon: 'battery-warning',
        title: 'Sonnen battery fault',
        sub: `Sonnen reports a fault/comms error — ${fs.reason}. Check the battery.`,
        device: 'Sonnen',
        ts: now,
        status: 'new',
        rule: 'rule-sonnen-fault',
      });
    }
  }

  return live;
}

function maskNumber(num: string): string {
  const digits = num.replace(/\D/g, '');
  const last3 = digits.slice(-3);
  const cc = num.trim().startsWith('+') ? `+${digits.slice(0, 2)}` : '';
  return `${cc} ••• ••• ${last3}`.trim();
}

export async function getAlerts(): Promise<unknown> {
  const now = new Date().toISOString();
  const state = store.get();

  const live = await evaluateLiveAlerts();

  // Merge persisted overrides (ack/resolved) onto live + seeded alerts.
  const merged = [...live, ...seeded()].map((a) => {
    const ov = state.alertOverrides[a.id];
    return ov ? { ...a, status: ov.status } : a;
  });

  return {
    ts: now,
    alerts: merged,
    channels: [
      {
        type: 'WhatsApp',
        detail: maskNumber(state.channels.whatsapp.number),
        enabled: state.channels.whatsapp.enabled,
      },
      { type: 'Push', detail: 'This device', enabled: state.channels.push.enabled },
      { type: 'Email', detail: state.channels.email.address, enabled: state.channels.email.enabled },
    ],
    // `rule-voltage` is intentionally omitted from the generic rule toggles — it has its
    // own config + control (Settings → Notifications "Grid voltage" card / voltageMonitor),
    // so it must not appear here as a second, competing on/off switch.
    rules: state.rules
      .filter((r) => r.id !== 'rule-voltage')
      .map((r) => ({
        id: r.id,
        icon: RULE_META[r.id]?.icon ?? 'bell',
        label: RULE_META[r.id]?.label ?? r.id,
        enabled: r.enabled,
      })),
  };
}

// ---- Mutations ----------------------------------------------------------

export function setChannel(type: 'whatsapp' | 'push' | 'email', enabled: boolean): unknown {
  store.update((s) => {
    s.channels[type].enabled = enabled;
  });
  return { ts: new Date().toISOString(), type, enabled };
}

export function setRule(id: string, enabled: boolean): unknown {
  const found = store.update((s) => {
    const r = s.rules.find((x) => x.id === id);
    if (r) {
      r.enabled = enabled;
      return true;
    }
    return false;
  });
  if (!found) throw new Error(`rule ${id} not found`);
  return { ts: new Date().toISOString(), id, enabled };
}

export function setAlertStatus(id: string, status: store.AlertStatus): unknown {
  store.update((s) => {
    s.alertOverrides[id] = { status };
  });
  return { ts: new Date().toISOString(), id, status };
}
