import * as sonnen from '../connectors/sonnen';
import * as tesla from '../connectors/tesla';
import { probeAll } from './health-probe';

type Severity = 'danger' | 'warning' | 'info' | 'ok';

interface Alert {
  id: string;
  severity: Severity;
  icon: string;
  title: string;
  sub: string;
  device: string;
  ts: string;
  status: 'new' | 'ack' | 'resolved';
}

const RESERVE_TARGET = 20; // %

// A small seeded set of historical/resolved alerts so the feed is never empty.
const SEEDED: Alert[] = [
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

export async function getAlerts(): Promise<unknown> {
  const now = new Date().toISOString();
  const live: Alert[] = [];

  const probe = await probeAll();

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
    });
  }

  // State-derived alerts (best-effort).
  const [sRes, tRes] = await Promise.allSettled([sonnen.getNormalized(), tesla.getNormalized()]);
  if (sRes.status === 'fulfilled') {
    const s = sRes.value;
    if (s.dir === 'charging' && s.soc >= 95 && s.gridFeedInW < -50) {
      live.push({
        id: 'sonnen-grid-charge-high',
        severity: 'warning',
        icon: 'plug-zap',
        title: 'Sonnen charging from grid at high SoC',
        sub: `SoC ${s.soc}% — avoid paying to top off a full battery`,
        device: 'Sonnen',
        ts: now,
        status: 'new',
      });
    }
  }
  if (tRes.status === 'fulfilled') {
    const t = tRes.value;
    if (t.reservePct < RESERVE_TARGET) {
      live.push({
        id: 'tesla-reserve-low',
        severity: 'warning',
        icon: 'shield-alert',
        title: 'Tesla backup reserve below target',
        sub: `Reserve ${t.reservePct}% (target ${RESERVE_TARGET}%)`,
        device: 'Tesla',
        ts: now,
        status: 'new',
      });
    }
    if (t.island) {
      live.push({
        id: 'tesla-island',
        severity: 'danger',
        icon: 'zap-off',
        title: 'Grid outage — running on battery',
        sub: `~${t.backupHours}h autonomy at current reserve`,
        device: 'Tesla',
        ts: now,
        status: 'new',
      });
    }
  }

  const alerts = [...live, ...SEEDED];

  return {
    ts: now,
    alerts,
    channels: [
      { type: 'WhatsApp', detail: '+34 ••• ••• 197', enabled: true },
      { type: 'Push', detail: 'This device', enabled: true },
      { type: 'Email', detail: 'j.kroese@levante.nl', enabled: false },
    ],
    rules: [
      { id: 'rule-grid-charge', icon: 'plug-zap', label: 'Charging from grid at high SoC', enabled: true },
      { id: 'rule-reserve', icon: 'shield-alert', label: 'Backup reserve below target', enabled: true },
      { id: 'rule-offline', icon: 'wifi-off', label: 'Device unreachable', enabled: true },
      { id: 'rule-outage', icon: 'zap-off', label: 'Grid outage detected', enabled: true },
      { id: 'rule-export', icon: 'arrow-up-from-line', label: 'Exporting during P1 (wasted value)', enabled: false },
    ],
  };
}
