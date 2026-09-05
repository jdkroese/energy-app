import { api } from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import { MOCK_PLAN } from '../../lib/mock';
import type { BrainPlanResponse } from '../../lib/types';
import { Card, StatTile, Badge, Icon } from '../ui';
import { PlanTimeline } from './PlanTimeline';

/* ============================================================================
 * PlanSummary — the brain's forward-looking 24 h plan.
 *
 *   · usePlan()      — polls /api/brain/plan (falls back to MOCK_PLAN)
 *   · PlanHero       — the next-24 h timeline card (sun meter · predicted
 *                      generation · events · solar/load/SoC · tariff bands)
 *   · PlanKpis       — the 5-metric forecast KPI row
 *   · TodaysMoves    — the brain's scheduled moves for today
 *
 * V2 (docs/53) moved the FORECAST off the Live dashboard: Live now leads with a
 * verdict about the present and carries the plan as a 54 px ribbon. The full
 * forecast belongs with the machinery that acts on it, so these three render on
 * Automations → Summary. `usePlan` is still shared — Live's ribbon reads the same
 * poll.
 *
 * The armed-state / kill-switch cell that used to live here is gone: the Live
 * verdict hero owns that control now (one Autopilot button, one confirm), and
 * the full arm/mode panel is at /settings?tab=autopilot.
 * ==========================================================================*/

function hhmm(h: number): string {
  return `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
}

/** Poll the brain's 24 h plan. Shared by Live (the ribbon) and Automations (the forecast). */
export function usePlan() {
  const { data, stale, updatedAt } = usePolling<BrainPlanResponse>(api.brainPlan, 60_000);
  return { plan: data || MOCK_PLAN, stale, updatedAt };
}

/* ============================================================================
 * PlanHero — the next-24 h timeline card (sun meter · predicted gen · events ·
 * solar/load/SoC chart · tariff strip).
 * ==========================================================================*/
export function PlanHero({ plan, wide }: { plan: BrainPlanResponse; wide: boolean }) {
  return (
    <Card
      title="The plan · next 24 h"
      subtitle={`sun forecast · predicted generation · battery trajectory · tariff bands — cloud-adjusted (${plan.weather.source === 'live' ? 'Open-Meteo, Jávea' : 'estimate'}), ${plan.weather.cloudAvgPct}% avg cloud`}
      icon={<Icon name="brain" />}
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Badge tone="battery" variant="soft" icon={<Icon name="graduation-cap" size={12} />}>
            {`${plan.model.month} roof model · ${plan.model.confidencePct}% (${plan.model.days}d)`}
          </Badge>
          <Badge tone="solar" variant="soft" icon={<Icon name="radio" size={12} />}>Live plan</Badge>
        </div>
      }
    >
      <PlanTimeline
        solar={plan.forecast.solarKw}
        load={plan.forecast.loadKw}
        soc={plan.socPct}
        tariff={plan.tariff}
        sunIntensityPct={plan.forecast.sunIntensityPct}
        genKwh={plan.forecast.genKwh}
        actions={plan.actions}
        now={plan.now}
        wide={wide}
      />
      <div style={{ display: 'flex', gap: 16, fontSize: 12, color: 'var(--text-2)', flexWrap: 'wrap', marginTop: 10 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><i style={{ width: 12, height: 8, borderRadius: 2, background: 'linear-gradient(var(--sun-lit-3),var(--sun-lit-1))' }} /> Sun intensity</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><i style={{ width: 14, height: 3, borderRadius: 2, background: 'var(--solar)' }} /> Solar (cloud-adjusted)</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><i style={{ width: 14, height: 3, borderRadius: 2, background: 'var(--home)' }} /> House load</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><i style={{ width: 14, height: 3, borderRadius: 2, background: 'var(--battery)' }} /> Battery SoC</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto', color: 'var(--text-3)' }}><Icon name="cloud" size={13} /> {plan.weather.cloudAvgPct}% cloud</span>
      </div>
    </Card>
  );
}

/* ============================================================================
 * PlanKpis — the 5-metric forecast KPI row (one row desktop, 2-up mobile).
 * ==========================================================================*/
export function PlanKpis({ plan, wide }: { plan: BrainPlanResponse; wide: boolean }) {
  const sum24 = (a: number[]) => a.slice(0, 24).reduce((s, v) => s + (v || 0), 0);
  const genKwhTotal = Math.round(sum24(plan.forecast.genKwh));
  const usageKwhTotal = Math.round(sum24(plan.forecast.usageKwh));
  return (
    <div style={{ display: 'grid', gridTemplateColumns: wide ? 'repeat(5,1fr)' : '1fr 1fr', gap: wide ? 12 : 10 }}>
      <Card style={wide ? undefined : { padding: 14 }}><StatTile size={wide ? 'md' : 'sm'} label="Production & usage" value={`${genKwhTotal} / ${usageKwhTotal}`} unit="kWh" tone="solar" icon={<Icon name="sun" />} footnote="forecast today" /></Card>
      <Card style={wide ? undefined : { padding: 14 }}><StatTile size={wide ? 'md' : 'sm'} label="Self-sufficiency" value={String(plan.projected.selfSufficiencyPct)} unit="%" tone="battery" icon={<Icon name="leaf" />} footnote="forecast · solar + stored" /></Card>
      <Card style={wide ? undefined : { padding: 14 }}><StatTile size={wide ? 'md' : 'sm'} label="P1 avoided" value={plan.projected.p1AvoidedKwh.toFixed(1)} unit="kWh" tone="grid" icon={<Icon name="trending-down" />} footnote="moved to P3" /></Card>
      <Card style={wide ? undefined : { padding: 14 }}><StatTile size={wide ? 'md' : 'sm'} label="Free climatization" value={plan.projected.freeClimatizationKwh.toFixed(1)} unit="kWh" tone="home" icon={<Icon name="snowflake" />} footnote="surplus → HVAC" /></Card>
      <Card style={wide ? undefined : { padding: 14 }}><StatTile size={wide ? 'md' : 'sm'} label="Projected savings" value={`€${plan.projected.savedEur.toFixed(2)}`} tone="solar" icon={<Icon name="piggy-bank" />} footnote="vs vendor default" /></Card>
    </div>
  );
}

/* ============================================================================
 * TodaysMoves — the brain's scheduled actions for the day.
 * ==========================================================================*/
export function TodaysMoves({ plan }: { plan: BrainPlanResponse }) {
  return (
    <Card title="Today's moves" subtitle="scheduled by the brain" icon={<Icon name="list-checks" />} style={{ padding: '16px 18px 6px' }}>
      {plan.actions.map((a, i) => (
        <div key={i} style={{ display: 'flex', gap: 12, padding: '12px 2px', borderTop: i === 0 ? 'none' : '1px solid var(--border-1)' }}>
          <span style={{ width: 24, height: 24, borderRadius: '50%', flex: 'none', display: 'grid', placeItems: 'center', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, background: `color-mix(in srgb, var(--${a.tone}) 18%, transparent)`, color: `var(--${a.tone})` }}>{i + 1}</span>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-3)' }}>{hhmm(a.startH)}–{hhmm(a.endH)}</span>
              <Icon name={a.icon} size={15} color={`var(--${a.tone})`} />
              <span style={{ fontSize: 14, fontWeight: 500 }}>{a.title}</span>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginTop: 3, lineHeight: 1.45 }}>{a.why}</div>
          </div>
        </div>
      ))}
    </Card>
  );
}
