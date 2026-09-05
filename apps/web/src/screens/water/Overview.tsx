import { useMemo } from 'react';
import { api } from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import { mockWaterHistory } from '../../lib/mock';
import type { IrrigationPlanResponse, IrrigationPlanZone, WaterResponse } from '../../lib/types';
import { Badge, Button, Card, Eyebrow, Icon } from '../../components/ui';
import { WaterAttributionChart } from '../../components/water/WaterAttributionChart';
import { useMediaQuery } from '../../components/shell/useMediaQuery';
import type { ShellContext } from '../../components/shell/AppShell';

/* ============================================================================
 * Water hub — Overview tab (V2, docs/53).
 *
 * The purpose of this screen is to prove every litre is accounted for, and to
 * make an UNEXPLAINED litre impossible to miss. So the hero leads with today's
 * total and, beside it, the overnight anomaly; the attribution chart carries the
 * evidence in two registers; the zones and the 14-night baseline close it.
 *
 * The billing-period card stays below all of that: AMJASA prices every m³ at the
 * band the PERIOD total reaches, so the cliff is the one number that can save
 * tens of euros — it has no counterpart in the V2 composition, and dropping it
 * would drop the only place that story is told.
 * ==========================================================================*/

export function WaterOverview({
  ctx,
  snapshot,
  onOpenIrrigation,
  onOpenAlerts,
}: {
  ctx: ShellContext;
  snapshot: WaterResponse;
  onOpenIrrigation: () => void;
  onOpenAlerts: () => void;
}) {
  const wide = ctx.desktop;
  const roomy = useMediaQuery('(min-width: 1180px)');
  const gap = !wide ? 12 : roomy ? 18 : 16;
  const pad = !wide ? 16 : roomy ? 20 : 18;
  const oneCol = !wide || !roomy;

  // 14-night floor strip — pulled from the History month view's nightBaseline
  // (one value per night); a light secondary poll, same as Reports' per-inverter
  // series.
  const { data: monthHistory } = usePolling(() => api.water.history('month', 0), 5 * 60_000);
  const nights = useMemo(() => {
    const h = monthHistory ?? mockWaterHistory('month', 0);
    return h.nightBaseline.slice(-14);
  }, [monthHistory]);

  const { data: irrigationPlan } = usePolling<IrrigationPlanResponse>(api.irrigation.plan, 30_000);

  const t = snapshot.today;
  const floor = snapshot.quietHour.floorLph;
  const nightUnexplained = t.hours.filter((h) => h.h < 6).reduce((s, h) => s + h.unexplainedL, 0);
  const overnightHours = t.hours.filter((h) => h.h < 6 && h.unexplainedL > floor);
  const leaking = overnightHours.length >= 2;
  const window =
    overnightHours.length > 0
      ? `${String(overnightHours[0].h).padStart(2, '0')}:00 and ${String(overnightHours[overnightHours.length - 1].h + 1).padStart(2, '0')}:00`
      : null;

  const hero = (
    <Card
      accent={leaking ? 'danger' : 'water'}
      padded={false}
      style={{ padding: pad, display: 'grid', gridTemplateColumns: oneCol ? '1fr' : '1fr 1fr', gap, animation: 'v2rise .5s var(--ease-out)' }}
    >
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Eyebrow>Water · today</Eyebrow>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <span className="pwr-mono" style={{ fontSize: wide ? 52 : 40, fontWeight: 500, letterSpacing: '-.02em', lineHeight: 1, color: 'var(--water)' }}>
            {Math.round(t.totalL).toLocaleString()}
          </span>
          <span className="pwr-mono" style={{ fontSize: 15, color: 'var(--text-2)' }}>L</span>
        </div>
        <div style={{ fontSize: 14, color: 'var(--text-2)', lineHeight: 1.55, textWrap: 'pretty' }}>
          Irrigation {Math.round(t.irrigationL)} L · household {Math.round(t.householdL)} L ·{' '}
          {Math.round(t.unexplainedL)} L not attributed to anything. The stack below is ordered so the unattributed band
          always sits on top, where it is impossible to miss.
        </div>
      </div>

      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10, justifyContent: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center', background: leaking ? 'var(--danger-wash)' : 'var(--water-wash)', color: leaking ? 'var(--danger)' : 'var(--water)', flex: 'none' }}>
            <Icon name={leaking ? 'triangle-alert' : 'moon'} size={17} />
          </span>
          <Eyebrow>Unexplained overnight</Eyebrow>
        </div>
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-1)' }}>
          {leaking && window
            ? `${Math.round(nightUnexplained)} L unexplained between ${window}`
            : `The house reached ${snapshot.quietHour.lowestLph} L/h overnight`}
        </div>
        <div style={{ fontSize: 13.5, color: 'var(--text-2)', lineHeight: 1.55, textWrap: 'pretty' }}>
          {leaking
            ? `${overnightHours.length} hour${overnightHours.length === 1 ? '' : 's'} above the ${floor} L/h quiet-hour floor with no zone scheduled and no tap open. A flow that never stops is a valve, not a habit.`
            : `A healthy house hits its floor at some point every night; this one did${snapshot.quietHour.atHour != null ? ` at ${String(snapshot.quietHour.atHour).padStart(2, '0')}:00` : ''}. The floor is ${floor} L/h.`}
        </div>
        <div style={{ display: 'flex', gap: 9, marginTop: 2, flexWrap: 'wrap' }}>
          <Button variant="ghost" style={{ height: 34 }} onClick={onOpenIrrigation}>Open valve log</Button>
          <Button variant="ghost" style={{ height: 34 }} onClick={onOpenAlerts}>See alerts</Button>
        </div>
      </div>
    </Card>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap }}>
      {hero}

      <Card
        title="Every litre, accounted for"
        subtitle="hourly attribution · L/h · irrigation → household → unexplained"
        style={{ animation: 'v2rise .5s var(--ease-out) .08s' }}
      >
        <WaterAttributionChart hours={t.hours} height={wide ? 230 : 190} floorLph={floor} />
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: oneCol ? '1fr' : '1fr 1fr', gap, animation: 'v2rise .5s var(--ease-out) .14s' }}>
        <IrrigationZones plan={irrigationPlan ?? null} pad={pad} onOpen={onOpenIrrigation} />
        <NightBaseline nights={nights} floor={floor} lowest={snapshot.quietHour.lowestLph} pad={pad} />
      </div>

      {snapshot.period && <BillingPeriod period={snapshot.period} pad={pad} wide={wide} />}
    </div>
  );
}

/** The zones, their next run and what each drew today — the biggest consumer. */
function IrrigationZones({ plan, pad, onOpen }: { plan: IrrigationPlanResponse | null; pad: number; onOpen: () => void }) {
  const zones = plan?.zones ?? [];
  return (
    <Card padded={false} interactive onClick={onOpen} style={{ padding: pad, display: 'flex', flexDirection: 'column', gap: 13, cursor: 'pointer' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <Eyebrow>Irrigation zones</Eyebrow>
        <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
          {plan?.stats.nextRun ? `next run ${plan.stats.nextRun.startTime}` : plan?.connected ? 'nothing scheduled' : 'not connected'}
        </span>
      </div>
      {zones.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5 }}>
          Rain Bird isn't connected yet — open the Irrigation tab to set it up. Until then every irrigation litre lands in
          the unattributed band.
        </div>
      ) : (
        zones.map((z) => <ZoneRow key={z.zoneId} z={z} />)
      )}
    </Card>
  );
}

function ZoneRow({ z }: { z: IrrigationPlanZone }) {
  const skipped = z.nextRunSkip?.decision === 'skip';
  const state = z.active ? 'Watering' : skipped ? 'Skipped' : z.litersToday > 0 ? 'Done' : 'Queued';
  const tone: 'water' | 'solar' | 'grid' | 'battery' = z.active ? 'water' : skipped ? 'grid' : z.litersToday > 0 ? 'solar' : 'battery';
  const when = skipped
    ? (z.nextRunSkip?.reason ?? 'skipped')
    : z.nextRun
      ? `${z.nextRun.startTime} · ${z.trimmedMinToday || z.scheduledMinToday} min`
      : 'no run scheduled';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 12px', borderRadius: 'var(--radius-md)', background: 'var(--surface-2)', border: '1px solid var(--border-1)' }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', flex: 'none', background: `var(--${tone})`, boxShadow: `0 0 8px var(--${tone})` }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{z.name}</div>
        <div style={{ fontSize: 11, color: 'var(--text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{when}</div>
      </div>
      <span className="pwr-mono" style={{ fontSize: 12.5, color: 'var(--text-2)', flex: 'none' }}>{Math.round(z.litersToday)} L</span>
      <Badge tone={tone} variant="soft">{state}</Badge>
    </div>
  );
}

/**
 * Fourteen nights of the quiet-hour floor. The shape is the whole point: a flat
 * run then a STEP reads as a valve; a slow rise reads as evaporation or a habit.
 */
function NightBaseline({ nights, floor, lowest, pad }: { nights: number[]; floor: number; lowest: number; pad: number }) {
  const max = Math.max(floor * 2, ...nights) * 1.1;
  const first = nights.slice(0, Math.max(1, nights.length - 3));
  const flatAvg = first.reduce((s, v) => s + v, 0) / Math.max(1, first.length);
  const stepped = nights.length >= 4 && nights[nights.length - 1] > flatAvg * 1.8 && nights[nights.length - 1] > floor;

  return (
    <Card padded={false} style={{ padding: pad, display: 'flex', flexDirection: 'column', gap: 13 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <Eyebrow>Night baseline · 14 days</Eyebrow>
        <span className="pwr-mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>floor {floor} L/h</span>
      </div>
      {nights.length === 0 ? (
        <div style={{ height: 120, display: 'grid', placeItems: 'center', fontSize: 12.5, color: 'var(--text-3)', textAlign: 'center', lineHeight: 1.5 }}>
          No nights recorded yet — the baseline needs a fortnight of meter reads before its shape means anything.
        </div>
      ) : (
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 5, height: 120 }}>
        {nights.map((v, i) => {
          const bad = v > floor;
          return (
            <div key={i} title={`night −${nights.length - 1 - i} · ${v.toFixed(1)} L/h`} style={{ flex: 1, height: '100%', display: 'flex', alignItems: 'flex-end' }}>
              <i
                style={{
                  width: '100%',
                  height: `${((Math.min(v, max) / max) * 100).toFixed(0)}%`,
                  background: bad ? 'var(--danger)' : 'var(--water)',
                  borderRadius: '3px 3px 0 0',
                  boxShadow: bad ? '0 0 10px color-mix(in srgb, var(--danger) 60%, transparent)' : 'none',
                  animation: 'v2grow .5s var(--ease-out)',
                  transformOrigin: 'bottom',
                }}
              />
            </div>
          );
        })}
      </div>
      )}
      <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.55, textWrap: 'pretty' }}>
        {stepped
          ? `The baseline sat near ${flatAvg.toFixed(1)} L/h for most of the fortnight, then stepped to ${nights[nights.length - 1].toFixed(1)} L/h and stayed there. A step, not a drift — that reads as a valve, not evaporation.`
          : `Lowest single-hour flow last night: ${lowest} L/h against a ${floor} L/h floor. A house that reaches its floor every night is a house without a leak.`}
      </div>
    </Card>
  );
}

/**
 * AMJASA bills bimonthly and prices EVERY m³ at the band the period total
 * reaches, so this — not the calendar month — is what decides the cost.
 */
function BillingPeriod({ period, pad, wide }: { period: NonNullable<WaterResponse['period']>; pad: number; wide: boolean }) {
  return (
    <Card padded={false} style={{ padding: pad, display: 'flex', flexDirection: 'column', gap: 12, animation: 'v2rise .5s var(--ease-out) .2s' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'var(--water-wash)', color: 'var(--water)', flex: 'none' }}>
          <Icon name="receipt" size={17} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Eyebrow>This billing period</Eyebrow>
          <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
            {fmtDay(period.startIso)} – {fmtDay(period.endIso)} · day {period.daysElapsed} of {period.daysTotal}
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: wide ? 'repeat(3, 1fr)' : 'repeat(2, 1fr)', gap: 12 }}>
        <Metric label="Used so far" value={period.m3ToDate.toFixed(1)} unit="m³" />
        <Metric label="On track for" value={period.projectedM3.toFixed(0)} unit="m³" tone="water" />
        <Metric label="Projected bill" value={`€${period.projectedCostEur.toFixed(0)}`} unit="" />
      </div>

      <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.6, textWrap: 'pretty' }}>
        Every m³ is billed at the band your period total reaches — currently{' '}
        <strong className="pwr-mono" style={{ color: 'var(--text-1)' }}>€{period.bandRateEurM3.toFixed(2)}/m³</strong>.
      </div>
      {period.cliff.m3ToNextBandDown != null && period.cliff.savingEur != null && (
        <div style={{ padding: '10px 12px', borderRadius: 'var(--radius-md)', background: 'var(--solar-wash)', border: '1px solid var(--border-solar-soft)', fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.6, textWrap: 'pretty' }}>
          Use <strong className="pwr-mono" style={{ color: 'var(--solar)' }}>{period.cliff.m3ToNextBandDown.toFixed(0)} m³</strong> less this
          period and the whole period re-prices a band lower — worth about{' '}
          <strong className="pwr-mono" style={{ color: 'var(--solar)' }}>€{period.cliff.savingEur.toFixed(0)}</strong>, far more than
          those cubic metres cost on their own.
        </div>
      )}
    </Card>
  );
}

/** "2026-07-01" -> "1 Jul" (Madrid dates come from the API already localised). */
function fmtDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d} ${MON[m - 1]}`;
}

function Metric({ label, value, unit, tone }: { label: string; value: string; unit: string; tone?: 'water' }) {
  return (
    <div>
      <div style={{ fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--text-3)', fontWeight: 600 }}>{label}</div>
      <div className="pwr-mono" style={{ fontSize: 21, fontWeight: 600, marginTop: 3, color: tone === 'water' ? 'var(--water)' : 'var(--text-1)' }}>
        {value}
        {unit && <span style={{ fontSize: 11, color: 'var(--text-3)', marginLeft: 3 }}>{unit}</span>}
      </div>
    </div>
  );
}
