import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import { MOCK_HISTORY } from '../lib/mock';
import type { HistoryResponse, InvertersHistoryResponse } from '../lib/types';
import { MAX_BACK, periodLabel } from '../lib/periods';
import { Card, StatTile, Badge, Eyebrow, Icon } from '../components/ui';
import { BarChart, type BarDatum } from '../components/energy/BarChart';
import { GridBandChart } from '../components/energy/GridBandChart';
import { PeriodNav } from '../components/energy/PeriodNav';
import { StaleBanner } from './_shared';
import { Bills } from './Bills';
import { useMediaQuery } from '../components/shell/useMediaQuery';
import type { ShellContext } from '../components/shell/AppShell';

/* ============================================================================
 * Reports (V2, docs/53) — where the money went.
 *
 * Range switcher and period navigator lead, then five totals, then the one chart
 * that actually explains the bill: grid import PRICED BY BAND. Solar value
 * (captured vs lost) and the load split sit beside each other below it, and the
 * production-vs-consumption bars close the screen.
 * ==========================================================================*/

const RANGES = ['Hour', 'Day', 'Week', 'Month', 'Year'] as const;

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

/** The V2 range switcher — a 3 px-padded shell with a solid solar pill on the pick. */
function RangeSwitch({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ display: 'flex', gap: 3, background: 'var(--surface-2)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', padding: 3, flexWrap: 'wrap' }}>
      {RANGES.map((r) => {
        const on = value === r;
        return (
          <button
            key={r}
            type="button"
            onClick={() => onChange(r)}
            aria-pressed={on}
            style={{
              all: 'unset',
              cursor: 'pointer',
              padding: '6px 14px',
              borderRadius: 'var(--radius-sm)',
              fontFamily: 'var(--font-sans)',
              fontSize: 12.5,
              fontWeight: 600,
              textAlign: 'center',
              color: on ? 'var(--accent-contrast)' : 'var(--text-2)',
              background: on ? 'var(--solar)' : 'transparent',
              transition: 'all .12s var(--ease-out)',
            }}
          >
            {r}
          </button>
        );
      })}
    </div>
  );
}

/** Energy / Bills — the two things Reports answers, kept as a peer of the range. */
function TabSwitch({ value, onChange }: { value: 'Energy' | 'Bills'; onChange: (v: 'Energy' | 'Bills') => void }) {
  return (
    <div style={{ display: 'flex', gap: 3, background: 'var(--surface-2)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', padding: 3 }}>
      {(['Energy', 'Bills'] as const).map((t) => {
        const on = value === t;
        return (
          <button
            key={t}
            type="button"
            onClick={() => onChange(t)}
            aria-pressed={on}
            style={{
              all: 'unset',
              cursor: 'pointer',
              padding: '6px 14px',
              borderRadius: 'var(--radius-sm)',
              fontFamily: 'var(--font-sans)',
              fontSize: 12.5,
              fontWeight: 600,
              color: on ? 'var(--text-1)' : 'var(--text-2)',
              background: on ? 'var(--surface-4)' : 'transparent',
              boxShadow: on ? 'var(--shadow-1), var(--hairline-top)' : 'none',
              transition: 'all .12s var(--ease-out)',
            }}
          >
            {t}
          </button>
        );
      })}
    </div>
  );
}

export function Reports({ ctx }: { ctx: ShellContext }) {
  const [tab, setTab] = useState<'Energy' | 'Bills'>('Energy');
  return tab === 'Energy' ? (
    <EnergyReports ctx={ctx} tab={tab} setTab={setTab} />
  ) : (
    <div style={{ display: 'flex', flexDirection: 'column', gap: ctx.desktop ? 18 : 12, padding: ctx.desktop ? 0 : '8px 14px 22px' }}>
      <TabSwitch value={tab} onChange={setTab} />
      <Bills ctx={ctx} />
    </div>
  );
}

const INVERTER_HUES = ['var(--solar)', 'var(--battery)'];

/**
 * Per-inverter solar production for the selected range (Sungrow SG5.0RS ×2; docs/36).
 * Reads the durable per-inverter store; renders nothing before samples accrue.
 */
function InverterHistoryCard({ ctx, gap }: { ctx: ShellContext; gap: number }) {
  const { data } = usePolling<InvertersHistoryResponse>(() => api.invertersHistory(ctx.range.toLowerCase()), 0, [ctx.range]);
  const series = data?.series ?? [];
  const labels = data?.labels ?? [];
  if (series.length === 0) return null;

  const max = Math.max(1, ...series.flatMap((s) => s.kwh));
  const stride = Math.max(1, Math.ceil(labels.length / (ctx.desktop ? 16 : 8)));

  return (
    <Card
      title="Solar inverters"
      subtitle="per-inverter production · kWh"
      actions={
        <div style={{ display: 'flex', gap: 13, fontSize: 11.5, color: 'var(--text-2)', flexWrap: 'wrap' }}>
          {series.map((s, i) => (
            <span key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <i style={{ width: 9, height: 9, borderRadius: 2, background: INVERTER_HUES[i % INVERTER_HUES.length] }} />
              {s.name} · {s.totalKwh} kWh
            </span>
          ))}
        </div>
      }
      style={{ animation: `v2rise .5s var(--ease-out) .3s` }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-end', gap, height: ctx.desktop ? 150 : 110 }}>
        {labels.map((l, i) => (
          <div key={i} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
            <div style={{ flex: 1, width: '100%', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', gap: 2 }}>
              {series.map((s, si) => {
                const v = s.kwh[i] ?? 0;
                return (
                  <div
                    key={s.id}
                    title={`${s.name}: ${v.toFixed(2)} kWh`}
                    style={{ width: '40%', height: `${Math.max(v > 0 ? 2 : 0, (v / max) * 100)}%`, background: INVERTER_HUES[si % INVERTER_HUES.length], borderRadius: '2px 2px 0 0' }}
                  />
                );
              })}
            </div>
            <span style={{ fontSize: 9, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>{i % stride === 0 ? l : ''}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function EnergyReports({ ctx, tab, setTab }: { ctx: ShellContext; tab: 'Energy' | 'Bills'; setTab: (t: 'Energy' | 'Bills') => void }) {
  // Period navigator: how far back from the current period (0 = now, negative = past).
  const [offset, setOffset] = useState(0);
  useEffect(() => setOffset(0), [ctx.range]);
  const roomy = useMediaQuery('(min-width: 1180px)');

  const { data, loading, stale, updatedAt } = usePolling<HistoryResponse>(
    () => api.history(ctx.range.toLowerCase(), offset),
    0,
    [ctx.range, offset],
  );
  const h = data || (loading ? null : MOCK_HISTORY) || MOCK_HISTORY;
  const bars = toBars(h);
  const sv = h.solarValue;
  const left = sv.worthIfSelfUsedEur - sv.exportEur;

  const wide = ctx.desktop;
  const gap = !wide ? 12 : roomy ? 18 : 16;
  const cardPad = !wide ? 16 : roomy ? 20 : 18;
  const tilePad = !wide ? 13 : roomy ? 16 : 15;
  const kpiCols = !wide ? 2 : roomy ? 5 : 3;
  const kpiGap = !wide ? 10 : roomy ? 14 : 12;
  const barsH = !wide ? 130 : roomy ? 180 : 160;
  const barGap = !wide ? 2 : 4;
  const oneCol = !wide || !roomy;

  const showNav = ctx.range !== 'Hour';
  const maxBack = MAX_BACK[ctx.range.toLowerCase()] ?? 0;
  const periodTitle = periodLabel(ctx.range, offset);
  const periodSub = offset === 0
    ? (ctx.range === 'Hour' ? 'past hour' : ctx.range === 'Day' ? 'today' : `this ${ctx.range.toLowerCase()}`)
    : periodTitle;

  // Real average grid price = what each self-consumed kWh is worth (avoided import).
  const importKwh = h.byBand.reduce((s, b) => s + b.kwh, 0);
  const importEur = h.byBand.reduce((s, b) => s + b.eur, 0);
  const selfUsedRate = importKwh > 0 ? importEur / importKwh : null;

  const bandCadence = { hour: 'per 5 min', day: 'per hour', week: 'per day', month: 'per day', year: 'per month' }[ctx.range.toLowerCase()] ?? 'per bucket';

  const kpis: { label: string; value: string; unit: string; foot: string; tone: 'solar' | 'home' | 'grid' | 'battery' }[] = [
    { label: 'Produced', value: h.totals.producedKwh.toLocaleString(), unit: 'kWh', foot: periodSub, tone: 'solar' },
    { label: 'Consumed', value: h.totals.consumedKwh.toLocaleString(), unit: 'kWh', foot: periodSub, tone: 'home' },
    { label: 'Imported', value: Math.round(importKwh).toLocaleString(), unit: 'kWh', foot: 'from grid', tone: 'grid' },
    { label: 'Self-sufficiency', value: String(h.totals.selfSufficiencyPct), unit: '%', foot: 'solar + stored', tone: 'battery' },
    { label: 'CO₂ avoided', value: String(h.totals.co2Kg), unit: 'kg', foot: periodSub, tone: 'solar' },
  ];

  const bandLegend = (
    <div style={{ display: 'flex', gap: 12, fontSize: 11.5, color: 'var(--text-2)' }}>
      {(['P1', 'P2', 'P3'] as const).map((b) => (
        <span key={b} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <i style={{ width: 9, height: 9, borderRadius: 2, background: `var(--band-${b.toLowerCase()})` }} />
          {b}
        </span>
      ))}
    </div>
  );

  const solarValue = (
    <Card accent="grid" padded={false} style={{ padding: cardPad, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Eyebrow>Solar value · captured vs lost</Eyebrow>
        <Icon name="trending-up" size={18} color="var(--solar)" />
      </div>
      {/* A share under ~14% has no room for its own label — the other half names
          the split, so the sliver stays a colour rather than clipped text. */}
      <div style={{ display: 'flex', height: 34, borderRadius: 9, overflow: 'hidden' }}>
        <div style={{ flex: sv.selfUsedPct, minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', background: 'var(--solar)', color: 'var(--accent-contrast)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600 }}>
          {sv.selfUsedPct >= 14 ? `${sv.selfUsedPct}% self-used` : ''}
        </div>
        <div style={{ flex: 100 - sv.selfUsedPct, minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', background: 'var(--surface-3)', color: 'var(--text-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600 }}>
          {100 - sv.selfUsedPct >= 14 ? `${100 - sv.selfUsedPct}% exported` : ''}
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 11 }}>
        <div style={{ padding: '11px 13px', borderRadius: 10, background: 'var(--solar-wash)' }}>
          <div style={{ fontSize: 11, color: 'var(--text-2)' }}>Self-consumed worth</div>
          <div className="pwr-mono" style={{ fontSize: 17, fontWeight: 600, color: 'var(--solar)', marginTop: 3 }}>
            {selfUsedRate != null ? `€${selfUsedRate.toFixed(2)}` : '—'}
            <small style={{ fontSize: 9, color: 'var(--text-3)' }}>/kWh</small>
          </div>
        </div>
        <div style={{ padding: '11px 13px', borderRadius: 10, background: 'var(--grid-wash)' }}>
          <div style={{ fontSize: 11, color: 'var(--text-2)' }}>Exported {sv.exportedKwh} kWh</div>
          <div className="pwr-mono" style={{ fontSize: 17, fontWeight: 600, color: 'var(--grid)', marginTop: 3 }}>
            €{sv.exportEur.toFixed(2)}
            <small style={{ fontSize: 9, color: 'var(--text-3)' }}> back</small>
          </div>
        </div>
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-1)', lineHeight: 1.55, textWrap: 'pretty' }}>
        That exported solar would have been worth{' '}
        <span className="pwr-mono" style={{ color: 'var(--solar)' }}>€{sv.worthIfSelfUsedEur}</span> if self-consumed —{' '}
        <span style={{ color: 'var(--grid)' }}>€{left.toFixed(0)} of value left on the table.</span>
      </div>
    </Card>
  );

  const byLoad = (
    <Card padded={false} style={{ padding: cardPad, display: 'flex', flexDirection: 'column', gap: 13 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Eyebrow>Consumption by load</Eyebrow>
        <Badge tone="battery" variant="soft">estimated</Badge>
      </div>
      {h.byLoad.map((l) => (
        <div key={l.name} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ width: 26, height: 26, borderRadius: 8, display: 'grid', placeItems: 'center', background: 'var(--surface-3)', color: l.tone, flex: 'none' }}>
              <Icon name={l.icon} size={14} />
            </span>
            <span style={{ flex: 1, fontSize: 13.5, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.name}</span>
            <span className="pwr-mono" style={{ fontSize: 12.5, color: 'var(--text-2)' }}>{l.kwh} kWh</span>
          </div>
          <div style={{ height: 6, borderRadius: 999, background: 'var(--surface-4)', overflow: 'hidden' }}>
            <i style={{ display: 'block', height: '100%', width: `${l.pct}%`, background: l.tone, borderRadius: 999, boxShadow: `0 0 10px ${l.tone}` }} />
          </div>
        </div>
      ))}
    </Card>
  );

  const body = (
    <>
      {stale && <StaleBanner updatedAt={updatedAt} />}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', animation: 'v2rise .5s var(--ease-out)' }}>
        <TabSwitch value={tab} onChange={setTab} />
        <RangeSwitch value={ctx.range} onChange={ctx.setRange} />
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 12, color: 'var(--text-3)' }}>Showing</span>
          {showNav ? (
            <PeriodNav range={ctx.range} offset={offset} hasPrev={offset > -maxBack} hasNext={offset < 0} onChange={setOffset} desktop={wide} />
          ) : (
            <span className="pwr-mono" style={{ fontSize: 12, color: 'var(--text-1)' }}>{periodTitle}</span>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${kpiCols}, minmax(0,1fr))`, gap: kpiGap, animation: 'v2rise .5s var(--ease-out) .06s' }}>
        {kpis.map((k) => (
          <Card key={k.label} interactive padded={false} style={{ padding: tilePad }}>
            <StatTile size="sm" label={k.label} value={k.value} unit={k.unit} tone={k.tone} footnote={k.foot} />
          </Card>
        ))}
      </div>

      <Card
        title="Grid import, priced by band"
        subtitle={`kWh drawn from the grid, split by 2.0TD band · ${bandCadence}`}
        actions={bandLegend}
        style={{ animation: 'v2rise .5s var(--ease-out) .12s' }}
      >
        <GridBandChart
          labels={h.series.labels}
          bandKwh={bandSeries(h)}
          powerTermEur={h.powerTermEur}
          height={barsH}
          gap={barGap}
        />
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: oneCol ? '1fr' : '1.25fr 1fr', gap, animation: 'v2rise .5s var(--ease-out) .18s' }}>
        {solarValue}
        {byLoad}
      </div>

      <Card
        title="Production vs consumption"
        subtitle={`${periodTitle} · kWh · ${h.totals.selfSufficiencyPct}% autonomy`}
        actions={
          <div style={{ display: 'flex', gap: 14, fontSize: 11.5, color: 'var(--text-2)' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}><i style={{ width: 9, height: 9, borderRadius: 2, background: 'var(--solar)' }} />Prod</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}><i style={{ width: 9, height: 9, borderRadius: 2, background: 'var(--home)' }} />Used</span>
          </div>
        }
        style={{ animation: 'v2rise .5s var(--ease-out) .24s' }}
      >
        <BarChart data={bars} height={barsH} gap={barGap} />
      </Card>

      <InverterHistoryCard ctx={ctx} gap={barGap} />
    </>
  );

  if (wide) return <div style={{ display: 'flex', flexDirection: 'column', gap }}>{body}</div>;
  return <div style={{ display: 'flex', flexDirection: 'column', gap, padding: '8px 14px 22px' }}>{body}</div>;
}
