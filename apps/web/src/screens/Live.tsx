import { useMemo, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import { MOCK_LIVE, MOCK_HISTORY_DAY } from '../lib/mock';
import type { FlowDir, HistoryDayResponse, LiveResponse, VoltageMonitor } from '../lib/types';
import { Card, StatTile, Badge, Eyebrow, Icon } from '../components/ui';
import { EnergyFlow, type FlowData, type FlowNode } from '../components/energy/EnergyFlow';
import { DayChart } from '../components/energy/DayChart';
import { VoltageHistoryOverlay } from '../components/energy/VoltageHistoryOverlay';
import { VerdictHero, combinedSoc } from '../components/energy/VerdictHero';
import { MobileHeader, Avatar, StaleBanner } from './_shared';
import { NotificationsWidget } from '../components/Notifications';
import { usePlan } from '../components/energy/PlanSummary';
import { aggregateDay, bucketTime, eur, BAND_RATE, BAND_WORD } from '../lib/dayMetrics';
import { useMediaQuery } from '../components/shell/useMediaQuery';
import type { ShellContext } from '../components/shell/AppShell';

/* ============================================================================
 * Live (V2, docs/53) — "is the coordinator doing the right thing?", answered in
 * the first second.
 *
 * Top to bottom: the VERDICT (what Autopilot is doing, why, how sure, and the
 * next 24 h) · the live flow beside the day chart · six KPI tiles the day chart's
 * scrub RETARGETS to any moment of the day · tariff + insight.
 *
 * Every number on the screen comes from ONE aggregate (lib/dayMetrics) so no two
 * components can disagree — V1 computed self-sufficiency and "saved" two
 * different ways on the same screen.
 * ==========================================================================*/

const fmtKw = (kw: number) => Math.abs(kw).toFixed(1);

/**
 * Battery node for the live-flow diagram. The HERO readout is the live flow
 * (signed kW, bold + tone colour, grey when idle); `soc` renders as a ring
 * gauge around the chip + a prominent bold % line, with stored kWh trailing
 * small + grey — so the diagram reads power in motion AND state at a glance.
 */
function batteryNode(name: string, b: { soc: number; kwh: number; kw: number; dir: FlowDir }): FlowNode {
  const val = b.dir === 'charging' ? `+${fmtKw(b.kw)}` : b.dir === 'discharging' ? `−${fmtKw(b.kw)}` : '0.0';
  return { name, val, unit: 'kW', sub: `${b.kwh} kWh`, kw: b.kw, dir: b.dir, soc: b.soc };
}

function toFlow(d: LiveResponse): FlowData {
  return {
    solar: (() => {
      // Show the true per-source split (2× Sungrow + Tesla) as inverter nodes
      // feeding the combined Solar node — whenever the backend sends real, named
      // arrays (the API now keeps the names at night too, with `est` values).
      const named =
        d.solar.arrays && d.solar.arrays.length >= 2 && d.solar.arrays.every((a) => a.name.length > 1)
          ? d.solar.arrays
          : null;
      return {
        name: 'Solar',
        val: fmtKw(d.solar.kw),
        unit: 'kW',
        sub: named ? 'combined feed' : `${d.solar.arrays?.length || 2} arrays`,
        kw: d.solar.kw,
        breakdown: named ? named.map((a) => ({ label: a.name, kw: a.kw, est: a.est, dark: a.dark })) : undefined,
      };
    })(),
    sonnen: batteryNode('Sonnen', d.sonnen),
    tesla: batteryNode('Tesla', d.tesla),
    // Grid + Home read from the TESLA GATEWAY meter — a separate metering domain
    // from Sonnen/Sungrow (which meter themselves), so the five flows around the
    // hub don't always sum. The caption under the diagram makes that explicit.
    grid: {
      name: 'Grid',
      val: fmtKw(d.grid.kw),
      unit: 'kW',
      sub: `${d.grid.dir === 'exporting' ? 'Export' : d.grid.dir === 'importing' ? 'Import' : 'Idle'} · Tesla meter`,
      kw: d.grid.kw,
      dir: d.grid.dir,
    },
    home: { name: 'Home', val: fmtKw(d.home.kw), unit: 'kW', sub: 'Load', kw: d.home.kw },
  };
}

/**
 * Metering-domain caption for the live flow. The site has TWO independent meter
 * domains that can't see each other — Grid/Home come from the Tesla gateway
 * meter, while Sonnen + the Sungrows meter themselves — so the flows around the
 * hub don't always visually sum. Saying so beats looking wrong.
 */
function MeterDomainsNote() {
  return (
    <div style={{ marginTop: 6, textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: 10, lineHeight: 1.5, color: 'var(--text-3)' }}>
      Grid &amp; Home · Tesla gateway meter&ensp;—&ensp;Sonnen &amp; inverters metered separately
    </div>
  );
}

/** A 5 px breathing dot — the honest "this is live" signal on a card head. */
function LiveBadge() {
  return (
    <Badge tone="solar" variant="soft">
      <i style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--solar)', animation: 'v2breathe 2.2s var(--ease-in-out) infinite' }} />
      Live
    </Badge>
  );
}

/**
 * Live grid voltage KPI — reads `live.breaker` (a monitored Tuya breaker, category `tdq`)
 * for voltage (V, primary) + current (A) + power (W) in the footnote. Empty-states to "—"
 * when no breaker exposes cur_voltage. The value turns danger-toned when voltage leaves the
 * configured band (polled separately; defaults 190–240 V).
 */
function GridVoltageStat({ live, wide = false }: { live: LiveResponse; wide?: boolean }) {
  const { data } = usePolling<{ voltageMonitor: VoltageMonitor }>(api.voltageMonitor, 60_000);
  const band = data?.voltageMonitor ?? { enabled: true, minV: 190, maxV: 240 };
  const b = live.breaker;
  const [showHistory, setShowHistory] = useState(false);

  if (!b) {
    return <StatTile size="sm" label="Grid voltage" value="—" tone="grid" footnote="no breaker configured" />;
  }

  const noLive = b.voltageV <= 0;
  const outOfBand = !noLive && (b.voltageV < band.minV || b.voltageV > band.maxV);
  const value = noLive ? '—' : outOfBand ? <span style={{ color: 'var(--danger)' }}>{b.voltageV}</span> : b.voltageV;
  const detail = `${b.currentA.toFixed(1)} A`;
  const footnote = noLive
    ? `band ${band.minV}–${band.maxV} V`
    : outOfBand
      ? `${detail} · outside ${band.minV}–${band.maxV} V`
      : `${detail} · band ${band.minV}–${band.maxV} V`;

  return (
    <>
      <button
        type="button"
        onClick={() => setShowHistory(true)}
        aria-label="Show 48-hour voltage history"
        title="Show 48-hour voltage history"
        className="pwr-voltage-tile"
        style={{ all: 'unset', position: 'relative', display: 'block', width: '100%', boxSizing: 'border-box', cursor: 'pointer', borderRadius: 'var(--radius-lg)', textAlign: 'left' }}
      >
        <span
          aria-hidden
          className="pwr-voltage-tile__chart"
          style={{ position: 'absolute', top: 0, right: 0, color: 'var(--text-3)', opacity: 0.7, lineHeight: 0, transition: 'opacity .15s' }}
        >
          <Icon name="activity" size={14} />
        </span>
        <StatTile size="sm" label="Grid voltage" value={value} unit="V" tone="grid" footnote={footnote} />
      </button>
      {showHistory && <VoltageHistoryOverlay wide={wide} onClose={() => setShowHistory(false)} />}
    </>
  );
}

interface Insight {
  tone: 'solar' | 'grid' | 'home';
  icon: string;
  title: string;
  body: string;
}

/** Three variants, chosen from the LIVE state — same gate as the verdict. */
function deriveInsight(d: LiveResponse, selfPct: number): Insight {
  const grid = d.grid.dir === 'importing' ? d.grid.kw : d.grid.dir === 'exporting' ? -d.grid.kw : 0;
  const discharging = d.sonnen.dir === 'discharging' || d.tesla.dir === 'discharging';
  const soc = combinedSoc(d);
  if (grid < -0.2 && soc < 96)
    return {
      tone: 'grid',
      icon: 'upload',
      title: 'Surplus going cheap',
      body: `Exporting ${Math.abs(grid).toFixed(1)} kW at ≈€0.003 while there is still ${Math.max(0, 100 - soc)}% of headroom in the packs.`,
    };
  if (discharging)
    return {
      tone: 'home',
      icon: 'battery-charging',
      title: 'Covering the peak',
      body: `Running the house from the batteries through the ${d.tariff.band} band — near €0 grid import at €${d.tariff.rateEur.toFixed(3)}/kWh.`,
    };
  return {
    tone: 'solar',
    icon: 'leaf',
    title: 'Running on your own power',
    body: `Solar and storage are covering the house · ${selfPct}% self-sufficient so far today on the ${d.tariff.band} band.`,
  };
}

function InsightCard({ live, selfPct, pad }: { live: LiveResponse; selfPct: number; pad: number }) {
  const ins = deriveInsight(live, selfPct);
  return (
    <Card accent={ins.tone} padded={false} style={{ padding: pad, display: 'flex', flexDirection: 'column', gap: 9 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <span style={{ width: 30, height: 30, borderRadius: 'var(--radius-lg)', display: 'grid', placeItems: 'center', background: `var(--${ins.tone}-wash)`, color: `var(--${ins.tone})` }}>
          <Icon name={ins.icon} size={17} />
        </span>
        <Eyebrow>Why this matters</Eyebrow>
      </div>
      <div style={{ fontSize: 15, fontWeight: 600 }}>{ins.title}</div>
      <div style={{ fontSize: 14, color: 'var(--text-1)', lineHeight: 1.55, textWrap: 'pretty' }}>{ins.body}</div>
      <div style={{ marginTop: 'auto', paddingTop: 6, fontSize: 12, color: 'var(--text-3)' }}>
        Advisory — the coordinator plans, holds capacity for the evening.
      </div>
    </Card>
  );
}

/** Tariff card — the band now, the day's shape, and what the evening block is worth. */
function TariffCard({ live, tariff24, pad }: { live: LiveResponse; tariff24: number[]; pad: number }) {
  const t = live.tariff;
  const hour = new Date(live.ts).getHours();
  const bandColor = t.band === 'P1' ? 'var(--band-p1)' : t.band === 'P3' ? 'var(--band-p3)' : 'var(--text-1)';
  const cells = ['var(--band-p3)', 'var(--band-p2)', 'var(--band-p1)'];
  const ratio = (BAND_RATE.P1 / BAND_RATE.P3).toFixed(1);
  const delta = (BAND_RATE.P1 - BAND_RATE.P3).toFixed(3);
  return (
    <Card padded={false} style={{ padding: pad, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
        <Eyebrow>Tariff · 2.0TD</Eyebrow>
        <span className="pwr-mono" style={{ fontSize: 12, color: 'var(--grid)' }}>
          Next · {t.nextBand} in {Math.floor(t.minsToNext / 60)}h {t.minsToNext % 60}m
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 9 }}>
        <span className="pwr-mono" style={{ fontSize: 30, fontWeight: 600, color: bandColor }}>{t.band}</span>
        <span style={{ fontSize: 13, color: 'var(--text-2)' }}>
          {BAND_WORD[t.band]} · <span className="pwr-mono" style={{ color: 'var(--text-1)' }}>€{t.rateEur.toFixed(3)}</span>/kWh
        </span>
      </div>
      <div style={{ display: 'flex', height: 12, gap: 2, borderRadius: 'var(--radius-sm)', overflow: 'hidden' }} aria-hidden>
        {Array.from({ length: 24 }).map((_, h) => {
          const b = tariff24[h] ?? 0;
          const cur = hour === h;
          return (
            <i
              key={h}
              style={{ flex: 1, background: cells[b], opacity: cur ? 1 : 0.42, color: cells[b], boxShadow: cur ? '0 0 10px currentColor' : 'none', borderRadius: 2 }}
            />
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 14, fontSize: 11, color: 'var(--text-3)', flexWrap: 'wrap' }}>
        {(['P1 peak', 'P2 shoulder', 'P3 off-peak'] as const).map((l, i) => (
          <span key={l} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <i style={{ width: 8, height: 8, borderRadius: 2, background: cells[2 - i] }} />
            {l}
          </span>
        ))}
      </div>
      <div style={{ marginTop: 'auto', paddingTop: 8, fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5, textWrap: 'pretty' }}>
        The evening P1 block is {ratio}× the off-peak rate. Every kWh the batteries cover between 18:00 and 22:00 is
        worth €{delta} more than one covered in the P3 valley.
      </div>
    </Card>
  );
}

/** The six actuals tiles — all six read the same aggregate, retargeted by the scrub. */
function KpiRow({ live, day, scrub, cols, gap, pad }: {
  live: LiveResponse;
  day: HistoryDayResponse;
  scrub: number | null;
  cols: number;
  gap: number;
  pad: number;
}) {
  const agg = useMemo(() => aggregateDay(day, scrub ?? undefined), [day, scrub]);
  const when = scrub == null ? 'today' : `by ${bucketTime(scrub)}`;
  const tiles: { label: string; value: ReactNode; unit?: string; foot: string; tone: 'solar' | 'home' | 'grid' | 'battery' }[] = [
    { label: 'Produced', value: agg.producedKwh.toFixed(1), unit: 'kWh', foot: when, tone: 'solar' },
    { label: 'Consumed', value: agg.consumedKwh.toFixed(1), unit: 'kWh', foot: when, tone: 'home' },
    { label: 'Exported', value: agg.exportedKwh.toFixed(1), unit: 'kWh', foot: 'to grid', tone: 'grid' },
    { label: 'Self-sufficiency', value: String(agg.selfSufficiencyPct), unit: '%', foot: 'load met without the grid', tone: 'battery' },
    { label: 'Saved', value: eur(agg.savedEur), foot: 'vs grid-only', tone: 'solar' },
  ];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))`, gap, animation: 'v2rise .5s var(--ease-out) .18s' }}>
      {tiles.map((t) => (
        <Card key={t.label} interactive padded={false} style={{ padding: pad }}>
          <StatTile size="sm" label={t.label} value={t.value} unit={t.unit} tone={t.tone} footnote={t.foot} />
        </Card>
      ))}
      <Card interactive padded={false} style={{ padding: pad }}>
        <GridVoltageStat live={live} wide={cols > 2} />
      </Card>
    </div>
  );
}

export function Live({ ctx }: { ctx: ShellContext }) {
  const { data, loading, stale, updatedAt } = usePolling<LiveResponse>(api.live, 10_000);
  const { data: dayData } = usePolling<HistoryDayResponse>(api.historyDayToday, 60_000);
  const { plan } = usePlan();
  // The 1180 px breakpoint below which the two-column rows collapse to one and
  // the KPI row goes 6 → 3.
  const roomy = useMediaQuery('(min-width: 1180px)');

  // Scrubbing the day chart retargets the KPI row — cause and effect across two
  // components, which is the whole point of the interaction. The screen owns it.
  const [scrub, setScrub] = useState<number | null>(null);

  const live = data || (loading ? null : MOCK_LIVE) || MOCK_LIVE;
  const day = dayData ?? MOCK_HISTORY_DAY;
  const flow = toFlow(live);
  const agg = useMemo(() => aggregateDay(day), [day]);
  const wide = ctx.desktop;

  const gap = !wide ? 12 : roomy ? 18 : 16;
  const cardPad = !wide ? 16 : roomy ? 20 : 18;
  const tilePad = !wide ? 13 : roomy ? 16 : 15;
  const kpiCols = !wide ? 2 : roomy ? 6 : 3;
  const kpiGap = !wide ? 10 : roomy ? 14 : 12;
  const chartH = !wide ? 190 : roomy ? 300 : 240;
  const oneCol = !wide || !roomy;
  const chartSub = `today · 15-min · measured to ${day.nowIndex != null ? bucketTime(day.nowIndex) : '—'}, forecast after`;

  const body = (
    <>
      {stale && <StaleBanner updatedAt={updatedAt} />}

      <VerdictHero live={live} plan={plan} agg={agg} wide={wide} roomy={wide && roomy} />

      {/* flow + day chart */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: oneCol ? '1fr' : 'minmax(0,2fr) minmax(0,3fr)',
          gap,
          alignItems: 'stretch',
        }}
      >
        <Card
          accent="solar"
          title="Live energy flow"
          subtitle="Tesla gateway + Sonnen · 10 s"
          actions={<LiveBadge />}
          style={{ display: 'flex', flexDirection: 'column', animation: 'v2rise .5s var(--ease-out) .06s' }}
        >
          <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
            <EnergyFlow flow={flow} size={wide ? 'lg' : 'sm'} />
          </div>
          <MeterDomainsNote />
        </Card>

        <Card
          title="The day, measured and forecast"
          subtitle={chartSub}
          actions={
            <div style={{ display: 'flex', gap: 13, fontSize: 11.5, color: 'var(--text-2)' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <i style={{ width: 9, height: 9, borderRadius: 2, background: 'var(--series-production)' }} />Solar
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <i style={{ width: 9, height: 9, borderRadius: 2, background: 'var(--series-consumption)' }} />Load
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <i style={{ width: 9, height: 2, borderRadius: 2, background: 'var(--series-soc-combined)' }} />SoC
              </span>
            </div>
          }
          style={{ display: 'flex', flexDirection: 'column', animation: 'v2rise .5s var(--ease-out) .12s' }}
        >
          <DayChart day={day} height={chartH} scrub={scrub} onScrub={setScrub} />
        </Card>
      </div>

      <KpiRow live={live} day={day} scrub={scrub} cols={kpiCols} gap={kpiGap} pad={tilePad} />

      {/* tariff + insight */}
      <div style={{ display: 'grid', gridTemplateColumns: oneCol ? '1fr' : '1fr 1fr', gap, animation: 'v2rise .5s var(--ease-out) .24s' }}>
        <TariffCard live={live} tariff24={plan.tariff} pad={cardPad} />
        <InsightCard live={live} selfPct={agg.selfSufficiencyPct} pad={cardPad} />
      </div>

      <NotificationsWidget />
    </>
  );

  if (wide) {
    return <div style={{ display: 'flex', flexDirection: 'column', gap }}>{body}</div>;
  }

  return (
    <>
      <MobileHeader eyebrow="Live overview" title="Your home, right now" right={<Avatar />} />
      <div style={{ display: 'flex', flexDirection: 'column', gap, padding: '8px 14px 22px' }}>{body}</div>
    </>
  );
}
