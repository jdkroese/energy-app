import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import { mockWaterHistory, MOCK_WATER_SETTINGS } from '../../lib/mock';
import type { WaterResponse, WaterThresholds } from '../../lib/types';
import { useAuth } from '../../auth/AuthProvider';
import { Card, Icon, Button, Switch, Badge, Eyebrow, EmptyState } from '../../components/ui';
import type { ShellContext } from '../../components/shell/AppShell';

/* ============================================================================
 * Water hub — Alerts tab (docs/51). "What's wrong": the active-alert list with
 * acknowledge/mute/Event-Viewer actions, the detection-rule switches (docs/51
 * §3 P2's five detectors), and the headline feature — a big irrigation night
 * that correctly did NOT alert, because the app can tell the difference
 * between "the garden ran" and "something is leaking" (the Rain Bird
 * false-positive suppression this whole section exists to deliver).
 * ==========================================================================*/

/* `rule` matches the `rule-water-*` ids in the API's RULE_META (routes/alerts.ts),
 * which is the single source of truth for whether a rule is enabled — the
 * thresholds below only say *where* each line sits, never whether it runs. */
const RULE_META: { rule: string; label: string; icon: string; describe: (t: WaterThresholds) => string }[] = [
  { rule: 'rule-water-continuous-flow', label: 'Continuous flow', icon: 'infinity', describe: (t) => `no hour below ${t.quietHourFloorLph} L/h for ${t.continuousFlowHours}h · critical` },
  { rule: 'rule-water-night-use', label: 'Night use', icon: 'moon', describe: (t) => `night flow (irrigation removed) > ${t.nightToleranceL} L` },
  { rule: 'rule-water-daily-spike', label: 'Daily spike', icon: 'trending-up', describe: (t) => `a day > ${t.dailySpikeFactor}× the 30-day median, unattributed` },
  { rule: 'rule-water-monthly-budget', label: 'Monthly budget', icon: 'calendar-days', describe: (t) => `projected month > ${t.monthlyBudgetM3} m³ — warns on the trend, not the arrival` },
  { rule: 'rule-water-meter-silent', label: 'Meter silent', icon: 'wifi-off', describe: (t) => `no new reading for ${t.meterSilentHours}h — connector health, not a leak` },
];

const SEVERITY_TONE: Record<string, 'danger' | 'grid' | 'water' | 'neutral'> = {
  critical: 'danger',
  high: 'danger',
  medium: 'grid',
  low: 'neutral',
};

/** 'neutral' has no bare --neutral/-wash CSS var (Badge/StatusDot handle it via a
 *  CSS class, not a token) — resolve it to a concrete colour pair here instead. */
function severityColors(sev: string): { fg: string; wash: string } {
  const tone = SEVERITY_TONE[sev] ?? 'neutral';
  if (tone === 'neutral') return { fg: 'var(--text-2)', wash: 'var(--surface-3)' };
  return { fg: `var(--${tone})`, wash: `var(--${tone}-wash)` };
}

export function WaterAlerts({ ctx, snapshot }: { ctx: ShellContext; snapshot: WaterResponse }) {
  const wide = ctx.desktop;
  const nav = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const { data: settings } = usePolling(api.water.settings, 0);
  const s = settings ?? MOCK_WATER_SETTINGS;

  // Rule on/off comes from the shared alert-rule store, not from water settings.
  const { data: alerts, refetch: refetchAlerts } = usePolling(api.alerts, 30_000);
  const alertRules = alerts?.rules ?? [];

  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const act = async (id: string, kind: 'ack' | 'resolve') => {
    setBusy(`${kind}-${id}`);
    setErr(null);
    try {
      if (kind === 'ack') await api.events.ack(id);
      else await api.events.resolve(id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not update the alert');
    } finally {
      setBusy(null);
    }
  };

  /* Enable/disable lives in the shared alert-rule store (the same `rule-water-*`
   * ids the API registers in RULE_META), NOT in the water thresholds — so this
   * switch and Settings ▸ Notifications stay one setting, not two. */
  const toggleRule = async (ruleId: string, enabled: boolean) => {
    setBusy(`rule-${ruleId}`);
    try {
      await api.setRule(ruleId, enabled);
      await refetchAlerts();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save the rule');
    } finally {
      setBusy(null);
    }
  };

  // The headline "explained and closed automatically" example — the biggest
  // logged irrigation night in the last month, with its night floor for proof
  // it stayed inside tolerance and correctly didn't fire. Derived client-side
  // from History's own contract (no dedicated endpoint needed).
  const { data: monthHistory } = usePolling(() => api.water.history('month', 0), 0);
  const suppressedNight = useMemo(() => {
    const h = monthHistory ?? mockWaterHistory('month', 0);
    let bestI = -1;
    let bestV = 0;
    h.series.irrigation.forEach((v, i) => {
      if (v > bestV) {
        bestV = v;
        bestI = i;
      }
    });
    if (bestI < 0 || bestV < 1000) return null;
    return {
      label: h.labels[bestI],
      irrigationL: bestV,
      // nightBaseline is the night slot's litres with irrigation removed — a
      // volume, not a rate — so it is judged against the night tolerance.
      nightResidualL: h.nightBaseline[bestI] ?? 0,
      toleranceL: s.thresholds.nightToleranceL,
    };
  }, [monthHistory, s]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: wide ? 16 : 14 }}>
      {err && (
        <div style={{ padding: '8px 12px', borderRadius: 'var(--radius-md)', background: 'var(--danger-wash)', color: 'var(--danger)', fontSize: 12.5 }}>{err}</div>
      )}

      {/* active alerts */}
      <div>
        <Eyebrow>Active</Eyebrow>
        {snapshot.activeAlerts.length === 0 ? (
          <Card padded style={{ marginTop: 8 }}>
            <EmptyState icon="shield-check" iconTone="solar" title="Nothing active" subtitle="No leak, spike, or connectivity alerts are firing right now." />
          </Card>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
            {snapshot.activeAlerts.map((a) => (
              <Card key={a.id} padded style={{ border: a.severity === 'critical' ? '1px solid var(--danger)' : undefined, background: a.severity === 'critical' ? 'var(--danger-wash)' : undefined }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                  <span style={{ width: 34, height: 34, borderRadius: 10, display: 'grid', placeItems: 'center', background: severityColors(a.severity).wash, color: severityColors(a.severity).fg, flex: 'none' }}>
                    <Icon name="triangle-alert" size={17} />
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 14, fontWeight: 700 }}>{a.title}</span>
                      <Badge tone={SEVERITY_TONE[a.severity]} variant="soft">{a.severity}</Badge>
                    </div>
                    <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginTop: 3 }}>{a.sub}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 3, fontFamily: 'var(--font-mono)' }}>since {new Date(a.sinceIso).toLocaleString()}</div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                      <Button size="sm" variant="secondary" loading={busy === `ack-${a.id}`} onClick={() => void act(a.id, 'ack')}>Acknowledge</Button>
                      <Button size="sm" variant="ghost" loading={busy === `resolve-${a.id}`} onClick={() => void act(a.id, 'resolve')}>Mute</Button>
                      <Button size="sm" variant="ghost" iconLeft={<Icon name="external-link" size={13} />} onClick={() => nav('/automations?tab=events&cat=water')}>Event Viewer</Button>
                    </div>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* explained and closed automatically — the headline feature */}
      <div>
        <Eyebrow>Explained automatically</Eyebrow>
        <Card
          padded
          style={{ marginTop: 8, border: '1px solid var(--solar)', background: 'var(--solar-wash)' }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <span style={{ width: 34, height: 34, borderRadius: 10, display: 'grid', placeItems: 'center', background: 'var(--surface-1)', color: 'var(--solar)', flex: 'none' }}>
              <Icon name="shield-check" size={18} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--solar)' }}>A big watering night, correctly ignored</div>
              {suppressedNight ? (
                <>
                  <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginTop: 4, lineHeight: 1.6 }}>
                    <strong style={{ color: 'var(--text-1)' }}>{suppressedNight.label}</strong> logged{' '}
                    <strong style={{ color: 'var(--text-1)', fontFamily: 'var(--font-mono)' }}>{Math.round(suppressedNight.irrigationL).toLocaleString()} L</strong>{' '}
                    from Rain Bird zones — a volume that would fail almost any fixed threshold. Once that's subtracted, the night's
                    unexplained residual was{' '}
                    <strong style={{ color: 'var(--text-1)', fontFamily: 'var(--font-mono)' }}>{Math.round(suppressedNight.nightResidualL)} L</strong>, under the{' '}
                    {suppressedNight.toleranceL} L night tolerance — so nothing fired.
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 8 }}>
                    This is the point of attribution: a leak detector that alerts on every watering night gets muted within a week — this one doesn't.
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginTop: 4 }}>No large irrigation night in the last month yet to illustrate this with — check back after the next big watering run.</div>
              )}
            </div>
          </div>
        </Card>
      </div>

      {/* detection rules */}
      <div>
        <Eyebrow>Detection rules</Eyebrow>
        <Card padded style={{ marginTop: 8 }}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {RULE_META.map((m, i) => {
              const rule = alertRules.find((r) => r.id === m.rule);
              return (
                <div
                  key={m.rule}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '11px 0',
                    borderTop: i === 0 ? 'none' : '1px solid var(--border-1)',
                  }}
                >
                  <span style={{ width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'var(--surface-3)', color: 'var(--text-2)', flex: 'none' }}>
                    <Icon name={m.icon} size={15} />
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{m.label}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-2)' }}>{m.describe(s.thresholds)}</div>
                  </div>
                  <Switch checked={rule?.enabled ?? true} disabled={!isAdmin || busy === `rule-${m.rule}`} onChange={(e) => void toggleRule(m.rule, e.currentTarget.checked)} />
                </div>
              );
            })}
          </div>
          {!isAdmin && <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 10 }}>Sign in as admin to change detection rules.</div>}
        </Card>
      </div>
    </div>
  );
}
