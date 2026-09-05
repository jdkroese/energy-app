import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import { useAuth } from '../../auth/AuthProvider';
import type { BrainPlanResponse, ControlStatus, LiveResponse } from '../../lib/types';
import type { DayAggregate } from '../../lib/dayMetrics';
import { Badge, Button, Card, Eyebrow, Modal } from '../ui';
import { PlanRibbon } from './PlanRibbon';

/* ============================================================================
 * VerdictHero (V2, docs/53) — the centrepiece of the Live screen.
 *
 * V1 answered "is the coordinator doing the right thing?" LAST: the plan and the
 * reasoning sat below six equal-weight KPI cards. V2 leads with the verdict —
 * what Autopilot is doing right now, why, how confident it is, and what it will
 * do if it is wrong — then the plan for the next 24 h, then (on demand) the log
 * of what it actually did today.
 *
 * THE VERDICT READS THE LIVE STATE, NOT THE PLAN. A plan window that says "cover
 * the peak from 18:00" would otherwise print "running from storage" over a 0.0 kW
 * battery flow while the house is still exporting. The plan supplies only the
 * label and the "since" time.
 * ==========================================================================*/

type Tone = 'solar' | 'battery' | 'grid' | 'home';
type State = 'Executing' | 'Holding' | 'Advisory' | 'Steady';

interface Verdict {
  tone: Tone;
  state: State;
  title: string;
  because: string;
  confidence: number;
  fallback: string;
}

const f1 = (v: number) => Math.abs(v).toFixed(1);

/** Signed battery flow across both packs: positive = charging into storage. */
function batteryKw(d: LiveResponse): number {
  const one = (b: { kw: number; dir: string }) =>
    b.dir === 'charging' ? Math.abs(b.kw) : b.dir === 'discharging' ? -Math.abs(b.kw) : 0;
  return one(d.sonnen) + one(d.tesla);
}

/** Signed grid flow: positive = importing. */
function gridKw(d: LiveResponse): number {
  return d.grid.dir === 'importing' ? Math.abs(d.grid.kw) : d.grid.dir === 'exporting' ? -Math.abs(d.grid.kw) : 0;
}

/**
 * Combined state of charge. Prefers the API's own combined series (it knows the
 * real usable capacities); falls back to a nominal-capacity weighting.
 */
export function combinedSoc(d: LiveResponse): number {
  const h = Math.floor(d.day?.nowHour ?? -1);
  const fromSeries = h >= 0 ? d.day?.combinedSoc?.[h] : undefined;
  if (typeof fromSeries === 'number' && fromSeries > 0) return Math.round(fromSeries);
  return Math.round((d.sonnen.soc * 9.2 + d.tesla.soc * 27) / (9.2 + 27));
}

export function deriveVerdict(d: LiveResponse, nextMoveLabel: string | null, nextMoveAt: string | null): Verdict {
  const bkw = batteryKw(d);
  const grid = gridKw(d);
  const soc = combinedSoc(d);
  const band = d.tariff.band;
  const rate = d.tariff.rateEur;
  const p = d.solar.kw;
  const c = d.home.kw;

  const charging = bkw > 0.15;
  const discharging = bkw < -0.15;
  const exporting = grid < -0.15;
  const importing = grid > 0.15;
  const gridFed = charging && p < c + 0.2;

  const nextPhrase = nextMoveLabel && nextMoveAt ? `${nextMoveLabel.toLowerCase()} at ${nextMoveAt}` : 'the next planned move';

  const fallbackDischarging =
    'If the evening runs past the plan, it releases the Tesla reserve rather than importing — the guardrail floor still holds.';
  const fallbackCharging =
    'If cloud cover drops production below 2 kW for 20 minutes, it stops charging and re-plans against the evening peak.';
  const fallbackIdle =
    'If load crosses production, storage takes over inside one control tick — the packs stay armed while the surplus is exported.';

  if (discharging)
    return {
      tone: 'home',
      state: 'Executing',
      confidence: 94,
      title: `Running the house from storage through the ${band} band.`,
      because: `Grid is €${rate.toFixed(3)} right now. ${f1(bkw)} kW is coming out of the packs instead, so import is holding near zero.`,
      fallback: fallbackDischarging,
    };
  if (gridFed)
    return {
      tone: 'battery',
      state: 'Executing',
      confidence: 92,
      title: 'Pre-charging on the cheapest hours of the night.',
      because: `${band} at €${rate.toFixed(3)}. Taking ${f1(bkw)} kW from the grid now costs a fraction of what the same kWh costs through the evening peak.`,
      fallback: fallbackCharging,
    };
  if (charging)
    return {
      tone: 'solar',
      state: 'Executing',
      confidence: 92,
      title: 'Banking the surplus instead of exporting it.',
      because: `Solar is ${f1(p)} kW against a ${f1(c)} kW load. Export pays ≈€0.003; the same kWh saves €${rate.toFixed(3)} when the house uses it.`,
      fallback: fallbackCharging,
    };
  if (exporting && soc > 94)
    return {
      tone: 'grid',
      state: 'Holding',
      confidence: 88,
      title:
        band === 'P1'
          ? `Peak has begun — still exporting, storage held at ${soc}%.`
          : `Full at ${soc}% — the surplus is going to the grid.`,
      because: `Solar still covers the ${f1(c)} kW load, so the packs stay untouched at ${soc}%. ${f1(grid)} kW is exported at ≈€0.003 until production drops below load — then storage takes over.`,
      fallback: fallbackIdle,
    };
  if (exporting)
    return {
      tone: 'grid',
      state: 'Advisory',
      confidence: 79,
      title: 'Exporting cheap while there is still headroom.',
      because: `${f1(grid)} kW is leaving at ≈€0.003 with ${Math.max(0, 100 - soc)}% of the packs still empty. Worth storing instead.`,
      fallback: fallbackIdle,
    };
  if (importing)
    return {
      tone: 'grid',
      state: 'Advisory',
      confidence: 84,
      title: `Importing ${f1(grid)} kW on the ${band} band.`,
      because: `Storage is at ${soc}% and load is ${f1(c)} kW. At €${rate.toFixed(3)} the coordinator holds the remaining charge for ${nextPhrase}.`,
      fallback: fallbackDischarging,
    };
  return {
    tone: 'battery',
    state: 'Steady',
    confidence: 86,
    title: 'Steady — nothing worth moving right now.',
    because: `Load is ${f1(c)} kW on the ${band} band at €${rate.toFixed(3)}. Next planned move: ${nextPhrase}.`,
    fallback: fallbackIdle,
  };
}

const hhmm = (h: number) =>
  `${String(Math.floor(h) % 24).padStart(2, '0')}:${String(Math.round((h % 1) * 60) % 60).padStart(2, '0')}`;

const RING_C = 2 * Math.PI * 42;

export function VerdictHero({
  live,
  plan,
  agg,
  wide,
  roomy,
}: {
  live: LiveResponse;
  plan: BrainPlanResponse;
  agg: DayAggregate;
  /** Desktop (>= 768 px). */
  wide: boolean;
  /** Desktop AND wider than the 1180 px two-column breakpoint. */
  roomy: boolean;
}) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const { data: status, refetch } = usePolling<ControlStatus>(api.control.status, 10_000);
  const [logOpen, setLogOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const armed = !!status?.armed && status.mode !== 'off';
  const now = plan.now;
  const active = plan.actions.find((a) => now >= a.startH && now < a.endH && a.endH - a.startH < 24) ?? null;
  const next = plan.actions.find((a) => a.startH > now) ?? plan.actions[0] ?? null;
  const v = deriveVerdict(live, next?.title ?? null, next ? hhmm(next.startH) : null);

  // The decision log is the coordinator's real command audit trail, filtered to
  // today — "every move, and what it was worth" in the only currency the API
  // actually records: what changed, and whether it stuck.
  const today = new Date().toDateString();
  const log = (status?.log ?? []).filter((r) => new Date(r.ts).toDateString() === today);
  const applied = log.filter((r) => r.ok).length;
  const failed = log.length - applied;
  const trust =
    log.length === 0
      ? 'No commands issued today.'
      : `${log.length} decision${log.length === 1 ? '' : 's'} today · ${applied} as planned · ${failed} revised`;

  const doDisarm = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.control.arm(false, 'off');
      setConfirmOpen(false);
      void refetch();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Disarm request failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      accent={v.tone}
      glow
      padded={false}
      style={{ position: 'relative', overflow: 'hidden', animation: 'v2rise .5s var(--ease-out)' }}
    >
      {/* The only decorative gradient in the system — it exists because glow means "live". */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          inset: '-70% -20% auto -20%',
          height: '220%',
          background: `radial-gradient(45% 55% at 22% 40%, var(--${v.tone}-wash), transparent 70%), radial-gradient(40% 55% at 76% 30%, var(--battery-wash), transparent 70%)`,
          filter: 'blur(28px)',
          animation: 'v2amb 26s var(--ease-in-out) infinite',
          pointerEvents: 'none',
          opacity: 0.9,
        }}
      />

      <div
        style={{
          position: 'relative',
          padding: !wide ? 16 : roomy ? 20 : 18,
          display: 'grid',
          gridTemplateColumns: roomy ? 'minmax(0,1.35fr) minmax(0,1fr)' : '1fr',
          gap: !wide ? 14 : roomy ? 18 : 16,
        }}
      >
        {/* ---- left: what, and why ---- */}
        <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
            <Eyebrow>Autopilot</Eyebrow>
            <Badge tone={v.tone} variant="soft">{v.state}</Badge>
            <span className="pwr-mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>
              {active ? `${active.title} · since ${hhmm(active.startH)}` : 'no move scheduled'}
            </span>
          </div>

          <div style={{ fontSize: !wide ? 25 : roomy ? 32 : 27, fontWeight: 600, letterSpacing: '-.02em', lineHeight: 1.14, textWrap: 'pretty' }}>
            {v.title}
          </div>

          <div style={{ fontSize: 14.5, color: 'var(--text-2)', lineHeight: 1.55, textWrap: 'pretty', maxWidth: '56ch' }}>
            {v.because}
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <Badge tone="solar" variant="soft">Self-sufficient {agg.selfSufficiencyPct}%</Badge>
            <Badge tone="battery" variant="soft">Storage {combinedSoc(live)}%</Badge>
            <Badge tone="grid" variant="soft">{live.tariff.band} · €{live.tariff.rateEur.toFixed(3)}</Badge>
          </div>

          <div style={{ display: 'flex', gap: 9, marginTop: 2, flexWrap: 'wrap' }}>
            <Button onClick={() => setLogOpen((o) => !o)} style={{ height: 38 }}>
              {logOpen ? 'Hide the reasoning' : 'Show the reasoning'}
            </Button>
            <Button
              variant="ghost"
              style={{ height: 38 }}
              onClick={() => (armed && isAdmin ? setConfirmOpen(true) : navigate('/settings?tab=autopilot'))}
              title={armed ? (isAdmin ? 'Disarm Autopilot' : 'Autopilot settings') : 'Arm Autopilot in Settings'}
            >
              {!status ? 'Autopilot connecting…' : armed ? 'Autopilot armed' : 'Autopilot paused'}
            </Button>
          </div>
        </div>

        {/* ---- right: how sure, what if wrong, what next ---- */}
        <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <div style={{ position: 'relative', width: 96, height: 96, flex: 'none' }}>
              <svg viewBox="0 0 100 100" style={{ width: 96, height: 96, transform: 'rotate(-90deg)' }} aria-hidden>
                <circle cx="50" cy="50" r="42" fill="none" stroke="var(--surface-4)" strokeWidth="7" />
                <circle
                  cx="50"
                  cy="50"
                  r="42"
                  fill="none"
                  stroke="var(--solar)"
                  strokeWidth="7"
                  strokeLinecap="round"
                  strokeDasharray={`${((RING_C * v.confidence) / 100).toFixed(1)} ${RING_C.toFixed(1)}`}
                  style={{ filter: 'drop-shadow(0 0 6px var(--solar))', transition: 'stroke-dasharray .6s var(--ease-out)' }}
                />
              </svg>
              <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                <span className="pwr-mono" style={{ fontSize: 22, fontWeight: 500 }}>{v.confidence}%</span>
                <span style={{ fontSize: 9, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--text-3)' }}>conf.</span>
              </div>
            </div>
            <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div>
                <div style={{ fontSize: 9, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--text-3)', fontWeight: 600 }}>Fallback</div>
                <div style={{ fontSize: 13, color: 'var(--text-1)', lineHeight: 1.5, textWrap: 'pretty' }}>{v.fallback}</div>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{trust}</div>
            </div>
          </div>

          <PlanRibbon actions={plan.actions} tariff={plan.tariff} now={plan.now} />
        </div>
      </div>

      {/* ---- decision log (reveal) ---- */}
      <div
        style={{
          maxHeight: logOpen ? 420 : 0,
          opacity: logOpen ? 1 : 0,
          overflow: logOpen ? 'auto' : 'hidden',
          transition: 'max-height .42s var(--ease-out), opacity .3s var(--ease-out)',
          position: 'relative',
        }}
      >
        <div style={{ padding: `2px ${!wide ? 16 : roomy ? 20 : 18}px ${!wide ? 16 : roomy ? 20 : 18}px`, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0 10px', borderTop: '1px solid var(--border-1)' }}>
            <Eyebrow>Decision log · today</Eyebrow>
            <span style={{ fontSize: 11, color: 'var(--text-3)' }}>every move, and whether it stuck</span>
          </div>
          {log.length === 0 ? (
            <div style={{ fontSize: 12.5, color: 'var(--text-3)', padding: '4px 2px 2px' }}>
              Nothing yet today — the coordinator only logs a decision when it changes something.
            </div>
          ) : (
            log.map((r, i) => (
              <div
                key={`${r.ts}-${i}`}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '56px 1fr auto',
                  gap: 12,
                  alignItems: 'baseline',
                  padding: '9px 10px',
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border-1)',
                  marginBottom: 6,
                }}
              >
                <span className="pwr-mono" style={{ fontSize: 12, color: 'var(--text-2)' }}>
                  {new Date(r.ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                </span>
                <span style={{ fontSize: 13, color: 'var(--text-1)', lineHeight: 1.45, textWrap: 'pretty' }}>
                  <b style={{ fontWeight: 600, textTransform: 'capitalize' }}>{r.device} · {r.lever}</b>
                  {r.reason ? ` — ${r.reason}` : ''}
                  {!r.ok && r.detail ? ` — ${r.detail}` : ''}
                </span>
                <span className="pwr-mono" style={{ fontSize: 12.5, color: r.ok ? 'var(--solar)' : 'var(--grid)' }}>
                  {String(r.to)}
                </span>
              </div>
            ))
          )}
        </div>
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
    </Card>
  );
}
