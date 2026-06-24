import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import { MOCK_PLAN } from '../lib/mock';
import type { BrainPlanResponse } from '../lib/types';
import { Card, StatTile, Badge, Eyebrow, Icon } from '../components/ui';
import { PlanTimeline } from '../components/energy/PlanTimeline';
import { StaleBanner } from './_shared';
import type { ShellContext } from '../components/shell/AppShell';

function Legend() {
  const items: [string, string][] = [
    ['Solar forecast', 'var(--solar)'],
    ['House load', 'var(--home)'],
    ['Battery SoC plan', 'var(--battery)'],
  ];
  return (
    <div style={{ display: 'flex', gap: 18, fontSize: 12, color: 'var(--text-2)', flexWrap: 'wrap' }}>
      {items.map((it) => (
        <span key={it[0]} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <i style={{ width: 14, height: 3, borderRadius: 2, background: it[1], display: 'inline-block' }} />
          {it[0]}
        </span>
      ))}
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
        <i style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--grid)', opacity: 0.6 }} />P1
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <i style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--grid-dim)', opacity: 0.6 }} />P2
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <i style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--solar)', opacity: 0.6 }} />P3
      </span>
    </div>
  );
}

function hhmm(h: number) {
  return `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
}

export function Brain({ ctx }: { ctx: ShellContext }) {
  const { data, stale, updatedAt } = usePolling<BrainPlanResponse>(api.brainPlan, 60_000);
  const plan = data || MOCK_PLAN;
  const wide = ctx.desktop;

  return (
    <div style={wide ? undefined : { padding: '8px 0 22px' }}>
      {!wide && (
        <div style={{ padding: '12px 18px 12px' }}>
          <Eyebrow>Energy brain</Eyebrow>
          <h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-.02em', margin: '2px 0 0' }}>Today's plan</h1>
        </div>
      )}
      {stale && <StaleBanner updatedAt={updatedAt} />}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 18, padding: wide ? 0 : '8px 14px 0', maxWidth: 1200, margin: '0 auto', width: '100%' }}>
        {/* status tiles */}
        <div style={{ display: 'grid', gridTemplateColumns: wide ? 'repeat(4,1fr)' : '1fr 1fr', gap: wide ? 16 : 10 }}>
          <Card style={wide ? undefined : { padding: 14 }}>
            <StatTile size={wide ? 'md' : 'sm'} label="Projected saved today" value={`€${plan.projected.savedEur.toFixed(2)}`} tone="solar" icon={<Icon name="piggy-bank" />} delta={13} footnote="vs vendor default" />
          </Card>
          <Card style={wide ? undefined : { padding: 14 }}>
            <StatTile size={wide ? 'md' : 'sm'} label="Self-sufficiency (plan)" value={String(plan.projected.selfSufficiencyPct)} unit="%" tone="battery" icon={<Icon name="leaf" />} footnote="solar + stored" />
          </Card>
          <Card style={wide ? undefined : { padding: 14 }}>
            <StatTile size={wide ? 'md' : 'sm'} label="Backup reserve" value={String(plan.projected.reservePct)} unit="%" tone="battery" icon={<Icon name="shield-check" />} footnote="Tesla · calm · dynamic" />
          </Card>
          <Card style={wide ? undefined : { padding: 14 }}>
            <StatTile size={wide ? 'md' : 'sm'} label="P1 import avoided" value={plan.projected.p1AvoidedKwh.toFixed(1)} unit="kWh" tone="grid" icon={<Icon name="trending-down" />} footnote="this evening's peak" />
          </Card>
        </div>

        {/* hero timeline */}
        <Card
          title="The plan — next 24 h"
          subtitle="solar forecast · battery trajectory · tariff bands · the brain's moves"
          icon={<Icon name="brain" />}
          actions={<Badge tone="solar" variant="soft" icon={<Icon name="radio" size={12} />}>Live plan</Badge>}
        >
          <PlanTimeline solar={plan.forecast.solarKw} load={plan.forecast.loadKw} soc={plan.socPct} tariff={plan.tariff} actions={plan.actions} now={plan.now} />
          <div style={{ marginTop: 10 }}>
            <Legend />
          </div>
        </Card>

        <div style={{ display: 'grid', gridTemplateColumns: wide ? '1.25fr 1fr' : '1fr', gap: 18 }}>
          {/* schedule */}
          <Card title="What the boss is doing" subtitle="today's scheduled moves" icon={<Icon name="list-checks" />} style={{ padding: '18px 20px 8px' }}>
            {plan.actions.map((a, i) => (
              <div key={i} style={{ display: 'flex', gap: 12, padding: '13px 4px', borderTop: '1px solid var(--border-1)' }}>
                <span
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: '50%',
                    flex: 'none',
                    display: 'grid',
                    placeItems: 'center',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                    fontWeight: 600,
                    background: `color-mix(in srgb, var(--${a.tone}) 18%, transparent)`,
                    color: `var(--${a.tone})`,
                  }}
                >
                  {i + 1}
                </span>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-3)' }}>{hhmm(a.h)}</span>
                    <Icon name={a.icon} size={15} color={`var(--${a.tone})`} />
                    <span style={{ fontSize: 14, fontWeight: 500 }}>{a.title}</span>
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginTop: 3, lineHeight: 1.45 }}>{a.why}</div>
                </div>
              </div>
            ))}
          </Card>

          {/* why now */}
          <Card accent="battery" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ width: 32, height: 32, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'var(--battery-wash)', color: 'var(--battery)' }}>
                <Icon name="brain" size={18} />
              </span>
              <div>
                <Eyebrow>Why now · {hhmm(plan.now)}</Eyebrow>
                <div style={{ fontSize: 15, fontWeight: 600, marginTop: 2 }}>{plan.whyNow.title}</div>
              </div>
            </div>
            <div style={{ fontSize: 14, color: 'var(--text-1)', lineHeight: 1.55 }}>{plan.whyNow.body}</div>
            <div style={{ marginTop: 'auto', display: 'flex', gap: 8, fontSize: 12, color: 'var(--text-3)' }}>
              <Icon name="cpu" size={14} /> Re-planned every 10 min · MPC over 36 h
            </div>
          </Card>
        </div>

        {/* how it decides */}
        <Card title="How the brain decides" subtitle="five layers, replanned continuously" icon={<Icon name="layers" />}>
          <div style={{ display: 'flex', alignItems: 'stretch', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
            {[
              ['1 · Sense', 'Telemetry', 'Sonnen · Tesla · solar · grid · weather · EV'],
              ['2 · Forecast', 'Foresight', 'solar yield · temp→demand · load · prices'],
              ['3 · Plan', 'MPC brain', '36 h rolling optimize, value-priced'],
              ['4 · Act', 'Hands', 'Tesla policy · Sonnen setpoints · loads'],
              ['5 · Guard', 'Safety', 'SoC/14 kW limits · fail-safe · override'],
            ].map((l, i, a) => (
              <div key={i} style={{ display: 'contents' }}>
                <div style={{ flex: 1, minWidth: 150, background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 12, padding: '12px 14px' }}>
                  <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--text-3)' }}>{l[0]}</div>
                  <div style={{ fontSize: 14, fontWeight: 600, marginTop: 4 }}>{l[1]}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-2)', marginTop: 3, lineHeight: 1.45 }}>{l[2]}</div>
                </div>
                {i < a.length - 1 && (
                  <div style={{ display: 'flex', alignItems: 'center', color: 'var(--text-3)' }}>
                    <Icon name="chevron-right" size={18} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
