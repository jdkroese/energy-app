import * as sonnen from '../connectors/sonnen';
import * as tesla from '../connectors/tesla';
import { bandFor } from '../tariff';
import { probeAll } from './health-probe';
import { getMonitoredBreaker } from '../connectors/tuya-voltage';
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
};

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
