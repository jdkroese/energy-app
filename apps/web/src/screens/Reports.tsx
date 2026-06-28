import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import { MOCK_HISTORY } from '../lib/mock';
import type { HistoryResponse } from '../lib/types';
import { Card, StatTile, ProgressBar, Badge, SegmentedControl, Eyebrow, Icon } from '../components/ui';
import { BarChart, type BarDatum } from '../components/energy/BarChart';
import { GridBandChart } from '../components/energy/GridBandChart';
import { StaleBanner } from './_shared';
import type { ShellContext } from '../components/shell/AppShell';

function toBars(h: HistoryResponse): BarDatum[] {
  return h.series.labels.map((l, i) => ({
    l,
    p: h.series.prod[i] ?? 0,
    c: h.series.cons[i] ?? 0,
    a: h.series.autonomy?.[i],
  }));
}

/**
 * Per-bucket grid import split by band for the GridBandChart. Prefers the API's
 * real time-of-use series; falls back to distributing each band's `byBand` total
 * across buckets weighted by consumption (older API / mock without bandKwh).
 */
function bandSeries(h: HistoryResponse): { P1: number[]; P2: number[]; P3: number[] } {
  if (h.series.bandKwh) return h.series.bandKwh;
  const cons = h.series.cons;
  const tot = cons.reduce((s, v) => s + (v ?? 0), 0);
  const n = h.series.labels.length || 1;
  const w = (i: number) => (tot > 0 ? (cons[i] ?? 0) / tot : 1 / n);
  const mk = (band: 'P1' | 'P2' | 'P3') => {
    const bk = h.byBand.find((b) => b.band === band)?.kwh ?? 0;
    return h.series.labels.map((_, i) => Math.round(bk * w(i) * 100) / 100);
  };
  return { P1: mk('P1'), P2: mk('P2'), P3: mk('P3') };
}

export function Reports({ ctx }: { ctx: ShellContext }) {
  const { data, loading, stale, updatedAt } = usePolling<HistoryResponse>(
    () => api.history(ctx.range.toLowerCase()),
    0,
    [ctx.range],
  );
  const h = data || (loading ? null : MOCK_HISTORY) || MOCK_HISTORY;
  const bars = toBars(h);
  const sv = h.solarValue;
  const left = sv.worthIfSelfUsedEur - sv.exportEur;

  // Period label tracks the Hour/Day/Week/Month/Year selector (was hardcoded "This month").
  const periodTitle =
    ctx.range === 'Hour' ? 'Past hour' : ctx.range === 'Day' ? 'Today' : `This ${ctx.range.toLowerCase()}`;
  const periodSub =
    ctx.range === 'Hour' ? 'past hour' : ctx.range === 'Day' ? 'today' : `this ${ctx.range.toLowerCase()}`;

  // Real average grid price = what each self-consumed kWh is worth (avoided import).
  // Derived from the by-band import cost (Σeur / Σkwh) — replaces a hardcoded €0.21.
  const importKwh = h.byBand.reduce((s, b) => s + b.kwh, 0);
  const importEur = h.byBand.reduce((s, b) => s + b.eur, 0);
  const selfUsedRate = importKwh > 0 ? importEur / importKwh : null;

  const captured = (
    <Card accent="grid" style={ctx.desktop ? undefined : { padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: ctx.desktop ? 12 : 10 }}>
        <Eyebrow>Solar value · captured vs lost</Eyebrow>
        <Icon name="trending-up" size={ctx.desktop ? 18 : 16} color="var(--solar)" />
      </div>
      <div className="splitbar" style={{ display: 'flex', height: ctx.desktop ? 34 : 30, borderRadius: 9, overflow: 'hidden' }}>
        <div style={{ flex: sv.selfUsedPct, background: 'var(--solar)', color: '#06090b', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600 }}>
          {sv.selfUsedPct}% self-used
        </div>
        <div style={{ flex: 100 - sv.selfUsedPct, background: 'var(--surface-3)', color: 'var(--text-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600 }}>
          {100 - sv.selfUsedPct}% exported
        </div>
      </div>
      <div style={{ marginTop: 12, display: 'flex', gap: ctx.desktop ? 12 : 10 }}>
        <div style={{ flex: 1, padding: '10px 12px', borderRadius: 10, background: 'var(--solar-wash)' }}>
          <div style={{ fontSize: 11, color: 'var(--text-2)' }}>Self-consumed worth</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 16, fontWeight: 600, color: 'var(--solar)', marginTop: 3 }}>
            {selfUsedRate != null ? `€${selfUsedRate.toFixed(2)}` : '—'}<small style={{ fontSize: 9, color: 'var(--text-3)' }}>/kWh</small>
          </div>
        </div>
        <div style={{ flex: 1, padding: '10px 12px', borderRadius: 10, background: 'var(--grid-wash)' }}>
          <div style={{ fontSize: 11, color: 'var(--text-2)' }}>Exported {sv.exportedKwh} kWh</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 16, fontWeight: 600, color: 'var(--grid)', marginTop: 3 }}>
            €{sv.exportEur.toFixed(2)}<small style={{ fontSize: 9, color: 'var(--text-3)' }}> back</small>
          </div>
        </div>
      </div>
      <div style={{ marginTop: 11, fontSize: 12.5, color: 'var(--text-1)', lineHeight: 1.5 }}>
        That exported solar would've been worth <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--solar)' }}>€{sv.worthIfSelfUsedEur}</span> if self-consumed —{' '}
        <span style={{ color: 'var(--grid)' }}>€{left.toFixed(0)} of value left on the table.</span>
      </div>
    </Card>
  );

  const gridBand = (
    <Card style={ctx.desktop ? undefined : { padding: 16 }}>
      <GridBandChart
        labels={h.series.labels}
        bandKwh={bandSeries(h)}
        powerTermEur={h.powerTermEur}
        desktop={ctx.desktop}
      />
    </Card>
  );

  const prodCons = (
    <Card
      title="Production vs consumption"
      subtitle={ctx.desktop ? `${periodTitle} · kWh · ${h.totals.selfSufficiencyPct}% autonomy` : undefined}
      icon={ctx.desktop ? <Icon name="bar-chart-3" /> : undefined}
      style={ctx.desktop ? undefined : { padding: 16 }}
      actions={
        ctx.desktop ? (
          <div style={{ display: 'flex', gap: 16, fontSize: 12, color: 'var(--text-2)' }}>
            <span>
              <i style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 2, background: 'var(--solar)', marginRight: 5 }} />
              Prod
            </span>
            <span>
              <i style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 2, background: 'var(--home)', marginRight: 5 }} />
              Used
            </span>
          </div>
        ) : undefined
      }
    >
      {!ctx.desktop && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <Eyebrow>Production vs consumption · {h.totals.selfSufficiencyPct}% autonomy</Eyebrow>
          <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--text-2)' }}>
            <span>
              <i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: 'var(--solar)', marginRight: 5 }} />
              Prod
            </span>
            <span>
              <i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: 'var(--home)', marginRight: 5 }} />
              Used
            </span>
          </div>
        </div>
      )}
      <BarChart data={bars} height={ctx.desktop ? 210 : 140} size={ctx.desktop ? 'lg' : 'sm'} />
    </Card>
  );

  const byLoad = (
    <Card
      title={ctx.desktop ? 'Consumption by load' : undefined}
      subtitle={ctx.desktop ? 'all-electric' : undefined}
      icon={ctx.desktop ? <Icon name="pie-chart" /> : undefined}
      actions={ctx.desktop ? <Badge tone="battery" variant="soft">estimated</Badge> : undefined}
      style={ctx.desktop ? undefined : { padding: 16 }}
    >
      {!ctx.desktop && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Eyebrow>Consumption by load</Eyebrow>
          <Badge tone="battery" variant="soft">estimated</Badge>
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: ctx.desktop ? 14 : 13, marginTop: ctx.desktop ? 4 : 14 }}>
        {h.byLoad.map((l) => (
          <div key={l.name} style={{ display: 'flex', flexDirection: 'column', gap: ctx.desktop ? 7 : 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ width: 26, height: 26, borderRadius: 8, display: 'grid', placeItems: 'center', background: 'var(--surface-3)', color: l.tone }}>
                <Icon name={l.icon} size={14} />
              </span>
              <span style={{ flex: 1, fontSize: 13.5 }}>{l.name}</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--text-2)' }}>{l.kwh} kWh</span>
            </div>
            <ProgressBar height={6} segments={[{ value: l.pct, tone: l.tone }]} />
          </div>
        ))}
      </div>
    </Card>
  );

  const kpis = (
    <>
      <Card style={ctx.desktop ? undefined : { padding: 14 }}>
        <StatTile size={ctx.desktop ? 'md' : 'sm'} label="Produced" value={h.totals.producedKwh.toLocaleString()} unit="kWh" tone="solar" icon={<Icon name="sun" />} footnote={ctx.desktop ? periodSub : undefined} />
      </Card>
      <Card style={ctx.desktop ? undefined : { padding: 14 }}>
        <StatTile size={ctx.desktop ? 'md' : 'sm'} label="Consumed" value={h.totals.consumedKwh.toLocaleString()} unit="kWh" tone="home" icon={<Icon name="plug" />} footnote={ctx.desktop ? periodSub : undefined} />
      </Card>
      {ctx.desktop && (
        <Card>
          <StatTile label="Exported" value={h.totals.exportedKwh.toLocaleString()} unit="kWh" tone="grid" icon={<Icon name="upload" />} footnote="to grid" />
        </Card>
      )}
      <Card style={ctx.desktop ? undefined : { padding: 14 }}>
        <StatTile size={ctx.desktop ? 'md' : 'sm'} label="Self-sufficiency" value={String(h.totals.selfSufficiencyPct)} unit="%" tone="battery" icon={<Icon name="leaf" />} footnote={ctx.desktop ? 'solar + stored' : undefined} />
      </Card>
      <Card style={ctx.desktop ? undefined : { padding: 14 }}>
        <StatTile size={ctx.desktop ? 'md' : 'sm'} label="CO₂ avoided" value={String(h.totals.co2Kg)} unit="kg" tone="solar" icon={<Icon name="sprout" />} footnote={ctx.desktop ? periodSub : undefined} />
      </Card>
    </>
  );

  if (ctx.desktop) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {stale && <StaleBanner updatedAt={updatedAt} />}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 16 }}>{kpis}</div>
        {gridBand}
        <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: 20 }}>
          {captured}
          {byLoad}
        </div>
        {prodCons}
      </div>
    );
  }

  return (
    <>
      <div style={{ padding: '12px 18px 12px' }}>
        <Eyebrow>Reports</Eyebrow>
        <h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-.02em', margin: '2px 0 0' }}>{periodTitle}</h1>
      </div>
      {stale && <StaleBanner updatedAt={updatedAt} />}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '8px 14px 22px' }}>
        <SegmentedControl block options={['Hour', 'Day', 'Week', 'Month', 'Year']} value={ctx.range} onChange={ctx.setRange} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>{kpis}</div>
        {gridBand}
        {captured}
        {prodCons}
        {byLoad}
      </div>
    </>
  );
}
