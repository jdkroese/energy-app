import { useState, type ReactNode } from 'react';
import { api, ApiError } from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import { MOCK_PLAN } from '../../lib/mock';
import { useAuth } from '../../auth/AuthProvider';
import type { BrainPlanResponse, ControlStatus } from '../../lib/types';
import { Card, StatTile, Badge, Icon, Button, Modal } from '../ui';
import { PlanTimeline } from './PlanTimeline';

/* ============================================================================
 * PlanSummary — the brain's forward-looking 24 h plan, relocated from the
 * Autopilot/Automations "Summary" tab onto the Live dashboard. Four pieces,
 * each a standalone export so Live can lay them out per viewport:
 *   · usePlan()      — polls /api/brain/plan (falls back to MOCK_PLAN)
 *   · ControlGrid    — armed-state / autopilot / solar / next-move (self-contained
 *                      Disarm with confirm; polls /api/control/status)
 *   · PlanHero       — the next-24 h timeline card
 *   · PlanKpis       — the 5-metric forecast KPI row
 *   · TodaysMoves    — the brain's scheduled moves for today
 * ==========================================================================*/

function hhmm(h: number): string {
  return `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
}

/* ---- armed-state tone (mirrors Autopilot.armTone) ------------------------ */
function armTone(s: ControlStatus | null): { c: string; wash: string; label: string; icon: string; live: boolean } {
  if (!s || !s.armed || s.mode === 'off') return { c: 'var(--text-3)', wash: 'var(--surface-2)', label: 'OFF', icon: 'power-off', live: false };
  if (s.mode === 'manual') return { c: 'var(--battery)', wash: 'var(--battery-wash)', label: 'MANUAL', icon: 'hand', live: true };
  return { c: 'var(--solar)', wash: 'var(--solar-wash)', label: 'AUTO', icon: 'sparkles', live: true };
}

function StatePill({ label, tone, dot }: { label: string; tone: string; dot?: boolean }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 999, fontSize: 11, fontWeight: 600, flex: 'none', background: `color-mix(in srgb, var(--${tone}) 14%, transparent)`, color: `var(--${tone})` }}>
      {dot && <span style={{ width: 6, height: 6, borderRadius: '50%', background: `var(--${tone})`, boxShadow: `0 0 6px var(--${tone})` }} />}
      {label}
    </span>
  );
}

function StatusCell({ icon, name, sub, label, tone, dot }: { icon: string; name: string; sub: ReactNode; label: string; tone: string; dot?: boolean }) {
  return (
    <div style={{ background: 'var(--surface-2)', borderRadius: 12, padding: '11px 12px', display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Icon name={icon} size={16} color={`var(--${tone})`} />
        <span style={{ fontSize: 13, fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
        <StatePill label={label} tone={tone} dot={dot} />
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-3)', lineHeight: 1.4 }}>{sub}</div>
    </div>
  );
}

/** Poll the brain's 24 h plan. Shared by Live (hero/KPIs/moves) and the control grid. */
export function usePlan() {
  const { data, stale, updatedAt } = usePolling<BrainPlanResponse>(api.brainPlan, 60_000);
  return { plan: data || MOCK_PLAN, stale, updatedAt };
}

/* ============================================================================
 * ControlGrid — armed state + battery autopilot + solar + next move (2×2). Owns
 * its own control-status poll and a confirm-gated Disarm (admin only). On the
 * Live dashboard this is the quick "is the boss driving?" read + kill switch;
 * full arm/mode/manual controls still live on Automations → Settings.
 * ==========================================================================*/
export function ControlGrid({ plan }: { plan: BrainPlanResponse }) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const { data: status, refetch } = usePolling<ControlStatus>(api.control.status, 10_000);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const at = armTone(status);
  const armed = !!status?.armed && status.mode !== 'off';
  const sysLabel = at.label === 'OFF' ? 'Off' : at.label === 'MANUAL' ? 'Manual' : 'Auto';
  const nowH = plan.now;
  const solarNow = plan.forecast.solarKw[Math.min(plan.forecast.solarKw.length - 1, Math.max(0, Math.round(nowH)))] ?? 0;
  const nextAction = plan.actions.find((a) => a.h > nowH) ?? plan.actions[0];
  const nextRel = nextAction
    ? nextAction.h > nowH
      ? `in ${Math.floor(nextAction.h - nowH)}h ${String(Math.round(((nextAction.h - nowH) % 1) * 60)).padStart(2, '0')}m`
      : 'now'
    : '';

  const doDisarm = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.control.arm(false, 'off');
      setConfirmOpen(false);
      refetch();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Disarm request failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ borderRadius: 'var(--radius-card)', border: '1px solid var(--border-1)', background: 'var(--surface-1)', padding: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        {/* cell 1 — armed state + what it means */}
        <div style={{ background: at.live ? at.wash : 'var(--surface-2)', border: `1px solid ${at.live ? at.c : 'transparent'}`, borderRadius: 12, padding: '11px 12px', display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ position: 'relative', width: 10, height: 10, flex: 'none' }}>
              <span style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: at.c, boxShadow: at.live ? `0 0 8px ${at.c}` : 'none' }} />
              {at.live && <span style={{ position: 'absolute', inset: -4, borderRadius: '50%', background: at.c, opacity: 0.5, animation: 'pwr-pulse 1.8s var(--ease-out) infinite' }} />}
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 13.5, letterSpacing: '.03em', color: at.c, flex: 1, minWidth: 0 }}>{!status ? 'CONNECTING…' : at.label === 'OFF' ? 'DISARMED' : `${at.label} — running`}</span>
            {isAdmin && armed && <Button size="sm" variant="danger" onClick={() => setConfirmOpen(true)}>Disarm</Button>}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-2)', lineHeight: 1.4 }}>
            {armed
              ? 'Power is sending live commands to your Sonnen + Tesla — guardrails stay enforced.'
              : 'Read-only: no commands reach your batteries. Arm it in Automations → Settings.'}
          </div>
        </div>

        {/* cell 2 — battery autopilot */}
        <StatusCell icon="cpu" name="Battery autopilot" sub="Sonnen + Tesla authority" label={sysLabel} tone={at.label === 'OFF' ? 'text-3' : at.label === 'MANUAL' ? 'battery' : 'solar'} dot={at.live} />

        {/* cell 3 — solar */}
        <StatusCell icon="sun" name="Solar self-consumption" sub={`cloud-adjusted · ~${solarNow.toFixed(1)} kW · ${plan.weather.cloudAvgPct}% cloud`} label={armed ? sysLabel : 'Producing'} tone="solar" dot />

        {/* cell 4 — next move */}
        {nextAction && (
          <div style={{ background: 'var(--surface-2)', borderRadius: 12, padding: '11px 12px', display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <Icon name={nextAction.icon} size={16} color="var(--battery)" />
              <span style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--text-3)', flex: 1 }}>Next move</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--battery)', background: 'var(--surface-3)', borderRadius: 999, padding: '2px 8px' }}>{hhmm(nextAction.h)} · {nextRel}</span>
            </div>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{nextAction.title}</div>
            <div style={{ fontSize: 11, color: 'var(--text-2)', lineHeight: 1.4 }}>{nextAction.why}</div>
          </div>
        )}
      </div>

      {confirmOpen && (
        <Modal
          open
          onClose={() => !busy && setConfirmOpen(false)}
          dismissable={!busy}
          zLayer="nested"
          size="md"
          tone="danger"
          icon="triangle-alert"
          title="Kill switch — disarm now?"
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmOpen(false)} disabled={busy}>Cancel</Button>
              <Button variant="danger" loading={busy} onClick={() => void doDisarm()}>Disarm now</Button>
            </>
          }
        >
          <div style={{ fontSize: 13.5, color: 'var(--text-2)', lineHeight: 1.5, padding: '16px 18px' }}>
            Immediately disarms Autopilot and reverts your Sonnen + Tesla to safe <strong>self-consumption</strong>. Use this if anything looks wrong.
            {err && <div style={{ marginTop: 10, color: 'var(--danger)' }}>{err}</div>}
          </div>
        </Modal>
      )}
    </div>
  );
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
