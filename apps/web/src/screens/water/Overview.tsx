import { useMemo } from 'react';
import { api } from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import { mockWaterHistory } from '../../lib/mock';
import type { WaterResponse, IrrigationPlanResponse } from '../../lib/types';
import { Card, StatTile, Icon, Eyebrow, Sparkline, Badge } from '../../components/ui';
import { WaterStackedChart, type WaterStackedBucket } from '../../components/water/WaterStackedChart';
import { WaterCumulativeChart } from '../../components/water/WaterCumulativeChart';
import type { ShellContext } from '../../components/shell/AppShell';

/* ============================================================================
 * Water hub — Overview tab (docs/52). "Now": today's attribution split, the
 * cumulative measured-vs-accounted-for story, the quiet-hour leak signal, and a
 * compact link into tonight's watering. The critical continuous-flow banner is
 * rendered once by the hub (Water.tsx) above every tab, so it isn't duplicated
 * here.
 * ==========================================================================*/

export function WaterOverview({
  ctx,
  snapshot,
  onOpenIrrigation,
}: {
  ctx: ShellContext;
  snapshot: WaterResponse;
  onOpenIrrigation: () => void;
}) {
  const wide = ctx.desktop;

  // 14-day night-floor strip for the "quiet hour" card — pulled from the History
  // month view's nightBaseline (one value/night); a light secondary poll, same
  // as e.g. Reports' InverterHistoryCard pulling its own per-inverter series.
  const { data: monthHistory } = usePolling(
    () => api.water.history('month', 0),
    5 * 60_000,
  );
  const nightStrip = useMemo(() => {
    const h = monthHistory ?? mockWaterHistory('month', 0);
    return h.nightBaseline.slice(-14);
  }, [monthHistory]);

  const { data: irrigationPlan } = usePolling<IrrigationPlanResponse>(api.irrigation.plan, 30_000);

  const buckets: WaterStackedBucket[] = snapshot.today.hours.map((h) => ({
    label: `${String(h.h).padStart(2, '0')}`,
    irrigationL: h.irrigationL,
    householdL: h.householdL,
    unexplainedL: h.unexplainedL,
    night: h.h < 6,
    reported: h.reported,
  }));

  // Cumulative measured-vs-accounted derived from the same hourly buckets — the
  // /api/water contract only carries per-hour figures for today, so the running
  // totals are built client-side (accounted-for = household + irrigation).
  const cumLabels: string[] = [];
  const cumActual: number[] = [];
  const cumExpected: number[] = [];
  let ra = 0;
  let re = 0;
  for (const h of snapshot.today.hours) {
    ra += h.totalL;
    re += h.householdL + h.irrigationL;
    cumLabels.push(`${String(h.h).padStart(2, '0')}:00`);
    cumActual.push(ra);
    cumExpected.push(re);
  }

  const meterOk = snapshot.meter && (snapshot.meter.staleHours == null || snapshot.meter.staleHours < 30);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: wide ? 16 : 14 }}>
      {/* stat tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: wide ? 'repeat(3, 1fr)' : '1fr 1fr', gap: 10 }}>
        <Card style={wide ? undefined : { padding: 14 }}>
          <StatTile
            size={wide ? 'md' : 'sm'}
            label="Unexplained today"
            value={String(Math.round(snapshot.today.unexplainedL))}
            unit="L"
            tone={snapshot.today.unexplainedL > 200 ? 'grid' : 'water'}
            icon={<Icon name="circle-alert" />}
            footnote={`of ${Math.round(snapshot.today.totalL)} L total`}
          />
        </Card>
        <Card style={wide ? undefined : { padding: 14 }}>
          <StatTile
            size={wide ? 'md' : 'sm'}
            label="Meter today"
            value={Math.round(snapshot.today.totalL).toLocaleString()}
            unit="L"
            tone="water"
            icon={<Icon name="gauge" />}
            footnote={meterOk ? 'reading fresh' : 'reading is stale'}
          />
        </Card>
        <div style={{ gridColumn: wide ? 'auto' : 'span 2' }}>
          <Card style={wide ? undefined : { padding: 14 }}>
            <StatTile
              size={wide ? 'md' : 'sm'}
              label="This month so far"
              value={snapshot.month.m3.toFixed(1)}
              unit="m³"
              tone="neutral"
              icon={<Icon name="calendar-days" />}
              footnote={`≈€${snapshot.month.costEur.toFixed(0)} · ${Math.round((snapshot.month.irrigationM3 / Math.max(0.01, snapshot.month.m3)) * 100)}% irrigation`}
            />
          </Card>
        </div>
      </div>

      {/* today by hour */}
      <Card title={wide ? "Today, by the hour" : undefined} subtitle={wide ? 'irrigation · household · unexplained' : undefined} icon={wide ? <Icon name="chart-column" /> : undefined} style={wide ? undefined : { padding: 16 }}>
        {!wide && <Eyebrow>Today, by the hour</Eyebrow>}
        <div style={wide ? undefined : { marginTop: 10 }}>
          <WaterStackedChart buckets={buckets} height={wide ? 220 : 180} showNightShade />
        </div>
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-3)' }}>Night window (00:00–05:59) shaded — irrigation usually runs here.</div>
      </Card>

      {/* measured vs accounted for */}
      <Card title={wide ? 'Measured vs accounted for' : undefined} subtitle={wide ? "today's running total" : undefined} icon={wide ? <Icon name="trending-up" /> : undefined} style={wide ? undefined : { padding: 16 }}>
        {!wide && <Eyebrow>Measured vs accounted for</Eyebrow>}
        <div style={wide ? undefined : { marginTop: 10 }}>
          <WaterCumulativeChart labels={cumLabels} actual={cumActual} expected={cumExpected} height={wide ? 200 : 170} />
        </div>
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: wide ? '1fr 1fr' : '1fr', gap: wide ? 16 : 14 }}>
        {/* quiet hour */}
        <Card padded>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <span style={{ width: 34, height: 34, borderRadius: 10, display: 'grid', placeItems: 'center', background: snapshot.quietHour.ok ? 'var(--water-wash)' : 'var(--danger-wash)', color: snapshot.quietHour.ok ? 'var(--water)' : 'var(--danger)', flex: 'none' }}>
              <Icon name={snapshot.quietHour.ok ? 'moon' : 'triangle-alert'} size={17} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>Quiet hour</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-2)' }}>the leak signal — lowest single-hour flow</div>
            </div>
            <Badge tone={snapshot.quietHour.ok ? 'water' : 'danger'} variant="soft">
              {snapshot.quietHour.ok ? 'clears nightly' : 'never clears'}
            </Badge>
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
            <span className="pwr-mono" style={{ fontSize: 28, fontWeight: 700, color: snapshot.quietHour.ok ? 'var(--text-1)' : 'var(--danger)' }}>
              {snapshot.quietHour.lowestLph}
            </span>
            <span style={{ fontSize: 13, color: 'var(--text-2)' }}>L/h</span>
            {snapshot.quietHour.atHour != null && (
              <span style={{ fontSize: 11.5, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>at {String(snapshot.quietHour.atHour).padStart(2, '0')}:00</span>
            )}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-2)', marginBottom: 10 }}>
            floor {snapshot.quietHour.floorLph} L/h ·{' '}
            {snapshot.quietHour.hoursSinceBelowFloor == null
              ? 'cleared last night'
              : snapshot.quietHour.hoursSinceBelowFloor === 0
                ? 'clear right now'
                : `${snapshot.quietHour.hoursSinceBelowFloor}h since it last cleared`}
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--text-3)', marginBottom: 4 }}>last 14 nights</div>
          <Sparkline
            values={nightStrip}
            width={wide ? 320 : 260}
            height={30}
            kind="bars"
            color="var(--water)"
            referenceValue={snapshot.quietHour.floorLph}
            barColorAt={(_, v) => (v > snapshot.quietHour.floorLph ? 'var(--danger)' : 'var(--water)')}
            highlightIndex={nightStrip.length - 1}
          />
        </Card>

        {/* Billing period — AMJASA bills bimonthly and prices EVERY m³ at the band the
            period total reaches, so this, not the calendar month, is what decides cost. */}
        {snapshot.period && (
          <Card padded>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <span style={{ width: 34, height: 34, borderRadius: 10, display: 'grid', placeItems: 'center', background: 'var(--water-wash)', color: 'var(--water)', flex: 'none' }}>
                <Icon name="receipt" size={17} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>This billing period</div>
                <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
                  {fmtDay(snapshot.period.startIso)} – {fmtDay(snapshot.period.endIso)} · day {snapshot.period.daysElapsed} of {snapshot.period.daysTotal}
                </div>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: wide ? 'repeat(3, 1fr)' : 'repeat(2, 1fr)', gap: 12 }}>
              <Metric label="Used so far" value={`${snapshot.period.m3ToDate.toFixed(1)}`} unit="m³" />
              <Metric label="On track for" value={`${snapshot.period.projectedM3.toFixed(0)}`} unit="m³" tone="water" />
              <Metric label="Projected bill" value={`€${snapshot.period.projectedCostEur.toFixed(0)}`} unit="" />
            </div>

            <div style={{ marginTop: 12, paddingTop: 11, borderTop: '1px solid var(--border-1)' }}>
              <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.6 }}>
                Every m³ is billed at the band your period total reaches — currently{' '}
                <strong style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-1)' }}>
                  €{snapshot.period.bandRateEurM3.toFixed(2)}/m³
                </strong>
                .
              </div>
              {snapshot.period.cliff.m3ToNextBandDown != null && snapshot.period.cliff.savingEur != null && (
                <div
                  style={{
                    marginTop: 9,
                    padding: '10px 12px',
                    borderRadius: 'var(--radius-md)',
                    background: 'var(--solar-wash)',
                    border: '1px solid var(--border-solar-soft)',
                    fontSize: 12.5,
                    color: 'var(--text-2)',
                    lineHeight: 1.6,
                  }}
                >
                  Use{' '}
                  <strong style={{ fontFamily: 'var(--font-mono)', color: 'var(--solar)' }}>
                    {snapshot.period.cliff.m3ToNextBandDown.toFixed(0)} m³
                  </strong>{' '}
                  less this period and the whole period re-prices a band lower — worth about{' '}
                  <strong style={{ fontFamily: 'var(--font-mono)', color: 'var(--solar)' }}>
                    €{snapshot.period.cliff.savingEur.toFixed(0)}
                  </strong>
                  , far more than those cubic metres cost on their own.
                </div>
              )}
            </div>
          </Card>
        )}

        {/* garden tonight */}
        <Card padded interactive onClick={onOpenIrrigation} style={{ cursor: 'pointer' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <span style={{ width: 34, height: 34, borderRadius: 10, display: 'grid', placeItems: 'center', background: 'var(--solar-wash)', color: 'var(--solar)', flex: 'none' }}>
              <Icon name="sprout" size={17} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>Garden tonight</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-2)' }}>the biggest consumer, at a glance</div>
            </div>
            <Icon name="chevron-right" size={16} color="var(--text-3)" />
          </div>
          {irrigationPlan?.connected ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12.5, color: 'var(--text-2)' }}>
              <div>
                Next run <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-1)' }}>{irrigationPlan.stats.nextRun ? irrigationPlan.stats.nextRun.startTime : '—'}</span>
              </div>
              <div>
                Planned today <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-1)' }}>{irrigationPlan.stats.plannedTodayMin}m</span>
                {' · '}
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-1)' }}>{Math.round(snapshot.today.irrigationL)} L</span> so far today
              </div>
              <div>{irrigationPlan.stats.zoneCount} zones · {irrigationPlan.mode === 'live' ? 'Home App live' : 'Rain Bird schedule'}</div>
            </div>
          ) : (
            <div style={{ fontSize: 12.5, color: 'var(--text-2)' }}>Rain Bird isn't connected yet — open the Irrigation tab to set it up.</div>
          )}
        </Card>
      </div>
    </div>
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
      <div style={{ fontSize: 9, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--text-3)' }}>{label}</div>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontVariantNumeric: 'tabular-nums',
          fontSize: 21,
          fontWeight: 600,
          marginTop: 3,
          color: tone === 'water' ? 'var(--water)' : 'var(--text-1)',
        }}
      >
        {value}
        {unit && <span style={{ fontSize: 11, color: 'var(--text-3)', marginLeft: 3 }}>{unit}</span>}
      </div>
    </div>
  );
}
