import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import { MOCK_WATER } from '../lib/mock';
import type { WaterResponse } from '../lib/types';
import { Card, Icon, Button, SegmentedControl, EmptyState } from '../components/ui';
import { MobileHeader, Avatar, StaleBanner } from './_shared';
import { IrrigationPanel } from './Irrigation';
import { WaterOverview } from './water/Overview';
import { WaterHistory } from './water/History';
import { WaterAlerts } from './water/Alerts';
import { WaterSettingsTab } from './water/SettingsTab';
import type { ShellContext } from '../components/shell/AppShell';

/* ============================================================================
 * Water hub (/water, docs/52) — the BI-WATER/Contazara meter + Irrigation
 * merged into one resource hub, same pattern as Solar Inverters -> Energy
 * (/batteries, PR #170). Five tabs in a "now -> biggest consumer -> the past ->
 * what's wrong -> how it's set up" order: Overview · Irrigation · History ·
 * Alerts · Settings. Tabs are deep-linkable via ?tab= (Automations.tsx pattern)
 * — /irrigation now redirects to /water?tab=irrigation, so that value MUST work.
 *
 * The organizing idea (docs/52 §1): every litre the meter measures is either
 * explained (a logged Rain Bird zone, or normal household rhythm) or it isn't.
 * Unexplained litres are the product — see WaterOverview / WaterAlerts.
 * ==========================================================================*/

type WaterTab = 'overview' | 'irrigation' | 'history' | 'alerts' | 'settings';
const WATER_TABS: readonly WaterTab[] = ['overview', 'irrigation', 'history', 'alerts', 'settings'];
const TAB_OPTIONS: { value: WaterTab; label: string }[] = [
  { value: 'overview', label: 'Overview' },
  { value: 'irrigation', label: 'Irrigation' },
  { value: 'history', label: 'History' },
  { value: 'alerts', label: 'Alerts' },
  { value: 'settings', label: 'Settings' },
];

export function Water({ ctx }: { ctx: ShellContext }) {
  const wide = ctx.desktop;
  const [params, setParams] = useSearchParams();
  const paramTab = params.get('tab');
  const tab: WaterTab = (WATER_TABS as readonly string[]).includes(paramTab ?? '') ? (paramTab as WaterTab) : 'overview';
  const setTab = (next: WaterTab) => {
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (next === 'overview') p.delete('tab');
        else p.set('tab', next);
        return p;
      },
      { replace: true },
    );
  };

  // Water's own connector snapshot — polled moderately (the meter itself is an
  // hourly-read / ~daily-upload feed, not live, so there's no point hammering
  // it). Irrigation and Settings work fully even when this isn't configured yet
  // (Irrigation has its own separate Rain Bird connection; Settings is where
  // Water gets connected in the first place).
  const { data, loading, stale, updatedAt, refetch } = usePolling<WaterResponse>(api.water.snapshot, 60_000);
  const d = data || (loading ? null : MOCK_WATER);
  const view = d || MOCK_WATER;

  const criticalAlert = view.activeAlerts.find((a) => a.severity === 'critical') ?? null;

  const tabBar = wide ? (
    <SegmentedControl block options={TAB_OPTIONS} value={tab} onChange={(v) => setTab(v as WaterTab)} />
  ) : (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <SegmentedControl block options={TAB_OPTIONS.slice(0, 3)} value={tab} onChange={(v) => setTab(v as WaterTab)} />
      <SegmentedControl block options={TAB_OPTIONS.slice(3)} value={tab} onChange={(v) => setTab(v as WaterTab)} />
    </div>
  );

  const needsOnboarding = !view.configured && tab !== 'irrigation' && tab !== 'settings';

  const panel = tab === 'irrigation' ? (
    <IrrigationPanel ctx={ctx} />
  ) : tab === 'settings' ? (
    <WaterSettingsTab ctx={ctx} snapshot={view} onSaved={() => void refetch()} />
  ) : needsOnboarding ? (
    <Card padded>
      <EmptyState
        icon="waves"
        iconTone="default"
        title="Connect the water meter"
        subtitle="Add your BI-WATER account (email, password, meter serial) in Settings to see usage, history and leak alerts here."
        action={
          <Button size="sm" variant="secondary" iconLeft={<Icon name="settings-2" size={14} />} onClick={() => setTab('settings')}>
            Go to Settings
          </Button>
        }
      />
    </Card>
  ) : tab === 'history' ? (
    <WaterHistory ctx={ctx} />
  ) : tab === 'alerts' ? (
    <WaterAlerts ctx={ctx} snapshot={view} />
  ) : (
    <WaterOverview ctx={ctx} snapshot={view} onOpenIrrigation={() => setTab('irrigation')} onOpenAlerts={() => setTab('alerts')} />
  );

  const body = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: wide ? 16 : 14, width: '100%', padding: wide ? 0 : '8px 14px 22px' }}>
      {stale && tab !== 'irrigation' && <StaleBanner updatedAt={updatedAt} />}
      {view.configured && !view.connected && tab !== 'irrigation' && tab !== 'settings' && (
        <Card padded style={{ border: '1px solid var(--grid)', background: 'var(--grid-wash)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Icon name="cloud-off" size={16} color="var(--grid)" />
            <div style={{ fontSize: 12.5, color: 'var(--text-2)' }}>
              Not reachable right now{view.lastError ? ` — ${view.lastError}` : ''}. Showing the last reading
              {view.meter?.lastReadingIso ? ` from ${new Date(view.meter.lastReadingIso).toLocaleString()}` : ''}.
            </div>
          </div>
        </Card>
      )}
      {criticalAlert && tab !== 'alerts' && (
        <Card padded style={{ border: '1px solid var(--danger)', background: 'var(--danger-wash)' }} onClick={() => setTab('alerts')} interactive>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
            <Icon name="triangle-alert" size={18} color="var(--danger)" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--danger)' }}>{criticalAlert.title}</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-2)' }}>{criticalAlert.sub}</div>
            </div>
            <Icon name="chevron-right" size={16} color="var(--danger)" />
          </div>
        </Card>
      )}
      {tabBar}
      {panel}
    </div>
  );

  return (
    <>
      {!wide && <MobileHeader eyebrow="Water" title="Every litre, accounted for" right={<Avatar />} />}
      {body}
    </>
  );
}
