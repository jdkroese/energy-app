import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import { mockWaterHistory, MOCK_WATER_SETTINGS } from '../../lib/mock';
import { MAX_BACK, periodLabel } from '../../lib/periods';
import { Card, StatTile, Icon, Eyebrow, SegmentedControl, Sparkline } from '../../components/ui';
import { PeriodNav } from '../../components/energy/PeriodNav';
import { WaterStackedChart, type WaterStackedBucket } from '../../components/water/WaterStackedChart';
import { WaterNightBaselineChart } from '../../components/water/WaterNightBaselineChart';
import { StaleBanner } from '../_shared';
import type { ShellContext } from '../../components/shell/AppShell';

/* ============================================================================
 * Water hub — History tab (docs/51). "The past": meter-index / month / bill
 * tiles, the period's stacked daily bars, four day-part small multiples
 * (Night/Morning/Afternoon/Evening — the night row is the leak tell), and the
 * night-baseline floor against the alert threshold.
 *
 * PeriodNav + ShellContext.range + a local offset, exactly like Reports.tsx's
 * EnergyReports: range is the shared app-wide period selector (Reports uses the
 * same ctx.range), offset resets to "now" whenever it changes. Water has no
 * hourly resolution, so 'Hour' coerces to 'Day'.
 * ==========================================================================*/

const RANGE_OPTIONS = ['Day', 'Week', 'Month', 'Year'];

export function WaterHistory({ ctx }: { ctx: ShellContext }) {
  const wide = ctx.desktop;
  const range = ctx.range === 'Hour' ? 'Day' : ctx.range;
  const [offset, setOffset] = useState(0);
  useEffect(() => setOffset(0), [range]);

  const { data, loading, stale, updatedAt } = usePolling(
    () => api.water.history(range.toLowerCase(), offset),
    0,
    [range, offset],
  );
  const h = data || (loading ? null : mockWaterHistory(range.toLowerCase(), offset)) || mockWaterHistory(range.toLowerCase(), offset);

  const { data: settings } = usePolling(api.water.settings, 0);
  const s = settings ?? MOCK_WATER_SETTINGS;
  const nightToleranceL = s.thresholds.nightToleranceL;
  const floorLph = s.thresholds.quietHourFloorLph;

  const maxBack = MAX_BACK[range.toLowerCase()] ?? 0;
  const hasPrev = offset > -maxBack;
  const hasNext = offset < 0;

  const buckets: WaterStackedBucket[] = h.labels.map((l, i) => ({
    label: l,
    irrigationL: h.series.irrigation[i] ?? 0,
    householdL: h.series.household[i] ?? 0,
    unexplainedL: h.series.unexplained[i] ?? 0,
  }));

  // Night-with-irrigation-removed — the daypart small multiples need the "is
  // this night actually clean" read, not raw night volume (a big irrigation
  // night looks identical to a leak in raw litres). Approximation: irrigation
  // mostly runs at night (docs/51 §1), so subtract that day's total logged
  // irrigation from the night daypart bucket.
  const nightRemoved = h.dayparts.night.map((v, i) => Math.max(0, v - (h.series.irrigation[i] ?? 0)));
  const nightFlagged = nightRemoved.map((v) => v > nightToleranceL);

  const estBillEur = h.totals.costEur;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: wide ? 16 : 14 }}>
      {stale && <StaleBanner updatedAt={updatedAt} />}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <SegmentedControl options={RANGE_OPTIONS} value={range} onChange={(v) => ctx.setRange(v)} size={wide ? 'sm' : undefined} />
        <PeriodNav range={range} offset={offset} hasPrev={hasPrev} hasNext={hasNext} onChange={setOffset} desktop={wide} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: wide ? 'repeat(3, 1fr)' : '1fr 1fr', gap: 10 }}>
        <Card style={wide ? undefined : { padding: 14 }}>
          <StatTile size={wide ? 'md' : 'sm'} label="Total" value={(h.totals.totalL / 1000).toFixed(2)} unit="m³" tone="water" icon={<Icon name="gauge" />} footnote={periodLabel(range, offset)} />
        </Card>
        <Card style={wide ? undefined : { padding: 14 }}>
          <StatTile size={wide ? 'md' : 'sm'} label="Irrigation share" value={String(Math.round((h.totals.irrigationL / Math.max(1, h.totals.totalL)) * 100))} unit="%" tone="solar" icon={<Icon name="sprout" />} footnote={`${Math.round(h.totals.irrigationL).toLocaleString()} L`} />
        </Card>
        <div style={{ gridColumn: wide ? 'auto' : 'span 2' }}>
          <Card style={wide ? undefined : { padding: 14 }}>
            <StatTile size={wide ? 'md' : 'sm'} label="Estimated bill" value={`€${estBillEur.toFixed(2)}`} tone="neutral" icon={<Icon name="receipt" />} footnote="tariff estimate — see Settings" />
          </Card>
        </div>
      </div>

      <Card title={wide ? `${periodLabel(range, offset)}, by ${range === 'Year' ? 'month' : range === 'Month' ? 'day' : 'day'}` : undefined} icon={wide ? <Icon name="chart-column" /> : undefined} style={wide ? undefined : { padding: 16 }}>
        {!wide && <Eyebrow>{periodLabel(range, offset)}</Eyebrow>}
        <div style={wide ? undefined : { marginTop: 10 }}>
          <WaterStackedChart buckets={buckets} height={wide ? 220 : 180} />
        </div>
      </Card>

      <Card padded>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>By time of day</div>
        <div style={{ fontSize: 11.5, color: 'var(--text-2)', marginBottom: 12 }}>night flagged when irrigation-removed flow exceeds tolerance ({nightToleranceL} L)</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <DaypartRow label="Night" icon="moon" values={nightRemoved} flagged={nightFlagged} />
          <DaypartRow label="Morning" icon="sunrise" values={h.dayparts.morning} />
          <DaypartRow label="Afternoon" icon="sun" values={h.dayparts.afternoon} />
          <DaypartRow label="Evening" icon="sunset" values={h.dayparts.evening} />
        </div>
      </Card>

      <Card title={wide ? 'Night-hour floor' : undefined} subtitle={wide ? 'the leak signal, over time' : undefined} icon={wide ? <Icon name="moon" /> : undefined} style={wide ? undefined : { padding: 16 }}>
        {!wide && <Eyebrow>Night-hour floor</Eyebrow>}
        <div style={wide ? undefined : { marginTop: 10 }}>
          <WaterNightBaselineChart labels={h.labels} values={h.nightBaseline} thresholdL={floorLph} height={wide ? 160 : 140} />
        </div>
      </Card>
    </div>
  );
}

function DaypartRow({ label, icon, values, flagged }: { label: string; icon: string; values: number[]; flagged?: boolean[] }) {
  const last = values[values.length - 1] ?? 0;
  const anyFlag = flagged?.some(Boolean) ?? false;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span
        style={{
          width: 28,
          height: 28,
          borderRadius: 8,
          display: 'grid',
          placeItems: 'center',
          flex: 'none',
          background: anyFlag ? 'var(--danger-wash)' : 'var(--water-wash)',
          color: anyFlag ? 'var(--danger)' : 'var(--water)',
        }}
      >
        <Icon name={icon} size={14} />
      </span>
      <span style={{ width: 68, flex: 'none', fontSize: 12.5, color: 'var(--text-2)' }}>{label}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Sparkline
          values={values}
          width={220}
          height={26}
          kind="bars"
          color={anyFlag ? 'var(--danger)' : 'var(--water)'}
          barColorAt={flagged ? (i) => (flagged[i] ? 'var(--danger)' : 'var(--water)') : undefined}
        />
      </div>
      <span style={{ width: 64, flex: 'none', textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 12, color: anyFlag ? 'var(--danger)' : 'var(--text-1)' }}>{Math.round(last)} L</span>
    </div>
  );
}
