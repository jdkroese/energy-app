import { useCallback, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import { MOCK_LIVE, MOCK_HISTORY_DAY } from '../lib/mock';
import type { FlowDir, HistoryDayResponse, LiveResponse, VoltageMonitor } from '../lib/types';
import { Card, StatTile, RadialGauge, ProgressBar, Badge, Eyebrow, Icon } from '../components/ui';
import { EnergyFlow, type FlowData } from '../components/energy/EnergyFlow';
import { DayChart } from '../components/energy/DayChart';
import { VoltageHistoryOverlay } from '../components/energy/VoltageHistoryOverlay';
import { TariffBand } from '../components/energy/TariffBand';
import { MobileHeader, Avatar, StaleBanner } from './_shared';
import { NotificationsWidget } from '../components/Notifications';
import { usePlan, ControlGrid, PlanHero, PlanKpis, TodaysMoves } from '../components/energy/PlanSummary';
import type { BrainPlanResponse } from '../lib/types';
import type { ShellContext } from '../components/shell/AppShell';

const fmtKw = (kw: number) => (Math.abs(kw) >= 10 ? Math.abs(kw).toFixed(1) : Math.abs(kw).toFixed(1));

/**
 * Battery sub-line for the live-flow diagram. The big readout stays SoC %, so the
 * stored kWh and — crucially — the live charge/discharge rate go here, signed so the
 * flows visibly balance against Solar/Grid/Home (e.g. "8.9 kWh · +1.2 kW" charging,
 * "27 kWh · −2.4 kW" discharging, "8.9 kWh · idle" when not flowing).
 */
function batterySub(kwh: number, kw: number, dir?: FlowDir): string {
  const stored = `${kwh} kWh`;
  if (dir === 'charging') return `${stored} · +${fmtKw(kw)} kW`;
  if (dir === 'discharging') return `${stored} · −${fmtKw(kw)} kW`;
  return `${stored} · idle`;
}

function toFlow(d: LiveResponse): FlowData {
  return {
    solar: { name: 'Solar', val: fmtKw(d.solar.kw), unit: 'kW', sub: `${d.solar.arrays?.length || 2} arrays`, kw: d.solar.kw },
    sonnen: { name: 'Sonnen', val: String(Math.round(d.sonnen.soc)), unit: '%', sub: batterySub(d.sonnen.kwh, d.sonnen.kw, d.sonnen.dir), kw: d.sonnen.kw, dir: d.sonnen.dir },
    tesla: { name: 'Tesla', val: String(Math.round(d.tesla.soc)), unit: '%', sub: batterySub(d.tesla.kwh, d.tesla.kw, d.tesla.dir), kw: d.tesla.kw, dir: d.tesla.dir },
    grid: { name: 'Grid', val: fmtKw(d.grid.kw), unit: 'kW', sub: d.grid.dir === 'exporting' ? 'Export' : d.grid.dir === 'importing' ? 'Import' : 'Idle', kw: d.grid.kw, dir: d.grid.dir },
    home: { name: 'Home', val: fmtKw(d.home.kw), unit: 'kW', sub: 'Load', kw: d.home.kw },
  };
}

function bandLabel(b: string) {
  return b === 'P1' ? 'peak' : b === 'P2' ? 'shoulder' : 'off-peak';
}

/** Live battery status word from its flow direction (was hardcoded "idle"). */
function dirLabel(dir: string) {
  return dir === 'charging' ? 'charging' : dir === 'discharging' ? 'discharging' : 'idle';
}

/**
 * Live grid voltage KPI — reads `live.breaker` (a monitored Tuya breaker, category `tdq`)
 * for voltage (V, primary) + current (A) + power (W) in the footnote. Empty-states to "—"
 * when no breaker exposes cur_voltage. The value turns danger-toned when voltage leaves the
 * configured band (polled separately; defaults 190–240 V). Rendered in BOTH viewports.
 */
function GridVoltageStat({ live, size = 'md', wide = false }: { live: LiveResponse; size?: 'sm' | 'md'; wide?: boolean }) {
  // Band rarely changes — a slow poll is enough; falls back to the 190–240 V default.
  const { data } = usePolling<{ voltageMonitor: VoltageMonitor }>(api.voltageMonitor, 60_000);
  const band = data?.voltageMonitor ?? { enabled: true, minV: 190, maxV: 240 };
  const b = live.breaker;
  const [showHistory, setShowHistory] = useState(false);

  // No configured breaker: a neutral, NON-clickable placeholder (no history to show).
  if (!b) {
    return (
      <StatTile
        size={size}
        label="Grid voltage"
        value="—"
        tone="grid"
        icon={<Icon name="zap" />}
        footnote="no breaker configured"
      />
    );
  }

  // A configured breaker that momentarily lacks a reading (0 V): show "—" but still
  // let the user open the 48h history (earlier readings may be recorded).
  const noLive = b.voltageV <= 0;
  const outOfBand = !noLive && (b.voltageV < band.minV || b.voltageV > band.maxV);
  const value = noLive ? (
    '—'
  ) : outOfBand ? (
    <span style={{ color: 'var(--danger)' }}>{b.voltageV}</span>
  ) : (
    b.voltageV
  );
  const detail = `${b.currentA.toFixed(1)} A · ${b.powerW} W`;
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
        style={{
          all: 'unset',
          position: 'relative',
          display: 'block',
          width: '100%',
          boxSizing: 'border-box',
          cursor: 'pointer',
          borderRadius: 'var(--radius-lg)',
          textAlign: 'left',
        }}
        className="pwr-voltage-tile"
      >
        {/* subtle "view history" affordance, top-right of the tile */}
        <span
          aria-hidden
          className="pwr-voltage-tile__chart"
          style={{ position: 'absolute', top: 0, right: 0, color: 'var(--text-3)', opacity: 0.7, lineHeight: 0, transition: 'opacity .15s' }}
        >
          <Icon name="activity" size={14} />
        </span>
        <StatTile
          size={size}
          label="Grid voltage"
          value={value}
          unit="V"
          tone="grid"
          icon={<Icon name="zap" />}
          footnote={footnote}
        />
      </button>
      {showHistory && <VoltageHistoryOverlay wide={wide} onClose={() => setShowHistory(false)} />}
    </>
  );
}

interface Insight {
  tone: 'solar' | 'battery' | 'grid';
  icon: string;
  title: string;
  body: ReactNode;
}

const HEADROOM = 96; // SoC% below which a battery still has capacity to store

/** Compute the "Why this matters" insight from the live snapshot. */
function deriveInsight(d: LiveResponse): Insight {
  const { grid, sonnen, tesla, tariff } = d;
  const exporting = grid.dir === 'exporting' && grid.kw > 0.1;
  const hasHeadroom = sonnen.soc < HEADROOM || tesla.soc < HEADROOM;
  const bothFull = sonnen.soc >= HEADROOM && tesla.soc >= HEADROOM;
  const discharging = sonnen.dir === 'discharging' || tesla.dir === 'discharging';
  const exportEur = tariff.band === 'P1' ? 0.029 : 0.003;

  // 1) Discharging during the P1 peak — covering the peak from batteries.
  if (tariff.band === 'P1' && discharging) {
    return {
      tone: 'battery',
      icon: 'battery-charging',
      title: 'Covering the peak',
      body: (
        <>
          Running the house from the batteries through the{' '}
          <span style={{ color: 'var(--grid)' }}>P1 peak</span> — near{' '}
          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--solar)' }}>€0</span> grid import at €
          {tariff.rateEur.toFixed(3)}/kWh.
        </>
      ),
    };
  }

  // 2) Exporting while there's still headroom to store it.
  if (exporting && hasHeadroom) {
    return {
      tone: 'solar',
      icon: 'upload',
      title: 'Surplus going cheap',
      body: (
        <>
          Exporting{' '}
          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--grid)' }}>{grid.kw.toFixed(1)} kW</span> at ≈€
          {exportEur.toFixed(3)} — there's still capacity to store it instead.
        </>
      ),
    };
  }

  // 3) Both full and a P1 peak is near — nothing reserved.
  if (bothFull && tariff.nextBand === 'P1') {
    const h = Math.floor(tariff.minsToNext / 60);
    const m = tariff.minsToNext % 60;
    const when = h > 0 ? `${h}h ${m}m` : `${m}m`;
    return {
      tone: 'grid',
      icon: 'alert-triangle',
      title: 'Both full · peak ahead',
      body: (
        <>
          Both batteries full and the <span style={{ color: 'var(--grid)' }}>P1 peak</span> lands in{' '}
          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--grid)' }}>{when}</span> — nothing held back yet.
        </>
      ),
    };
  }

  // 4) Both full, exporting (no peak imminent).
  if (bothFull && exporting) {
    return {
      tone: 'grid',
      icon: 'upload',
      title: 'Nowhere left to store',
      body: (
        <>
          Both batteries full · exporting{' '}
          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--grid)' }}>{grid.kw.toFixed(1)} kW</span> at ≈€
          {exportEur.toFixed(3)}/kWh — banked sun has nowhere to go.
        </>
      ),
    };
  }

  // 5) Neutral — self-sufficiency framing.
  return {
    tone: 'battery',
    icon: 'leaf',
    title: 'Running on your own power',
    body: (
      <>
        Solar and storage are covering the house ·{' '}
        <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-1)' }}>{d.today.selfSufficiencyPct}%</span>{' '}
        self-sufficient today on the {tariff.band} band.
      </>
    ),
  };
}

/**
 * Day-chart card: owns the day-offset state, fetches /api/history/day for the
 * current offset, and paginates with the prev/next arrows. Falls back to mock
 * data when the API isn't reachable so the chart always renders.
 */
function DayChartCard({ height, subtitle }: { height: number; subtitle: string }) {
  const [offset, setOffset] = useState(0);
  const fetcher = useCallback(() => api.historyDay(offset), [offset]);
  const { data, loading } = usePolling<HistoryDayResponse>(
    fetcher,
    offset === 0 ? 60_000 : 0,
    [offset],
  );
  const day = data ?? MOCK_HISTORY_DAY;
  return (
    <Card title="Production & consumption" subtitle={subtitle} icon={<Icon name="activity" />}>
      <DayChart
        day={day}
        height={height}
        loading={loading}
        onPrev={() => day.hasPrev && setOffset((o) => o - 1)}
        onNext={() => day.hasNext && setOffset((o) => o + 1)}
      />
    </Card>
  );
}

export function Live({ ctx }: { ctx: ShellContext }) {
  const { data, loading, stale, updatedAt } = usePolling<LiveResponse>(api.live, 10_000);
  const { plan } = usePlan();
  const d = data || (loading ? null : MOCK_LIVE);
  const live = d || MOCK_LIVE;
  const flow = toFlow(live);
  const t = live.tariff;
  const hour = new Date(live.ts).getHours();

  if (ctx.desktop) return <LiveDesktop live={live} flow={flow} plan={plan} stale={stale} />;

  return (
    <>
      <MobileHeader eyebrow="Live · Jávea · 26° sunny" title="Your home" right={<Avatar />} />
      {stale && <StaleBanner updatedAt={updatedAt} />}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '8px 14px 22px' }}>
        {/* today totals */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Card style={{ padding: 14 }}>
            <StatTile size="sm" label="Produced today" value={live.today.producedKwh.toFixed(1)} unit="kWh" tone="solar" icon={<Icon name="sun" />} />
          </Card>
          <Card style={{ padding: 14 }}>
            <StatTile size="sm" label="Consumed" value={live.today.consumedKwh.toFixed(1)} unit="kWh" tone="home" icon={<Icon name="plug" />} />
          </Card>
          <Card style={{ padding: 14 }}>
            <StatTile size="sm" label="Grid feed-in" value={live.today.gridFeedInKwh.toFixed(1)} unit="kWh" tone="grid" icon={<Icon name="upload" />} />
          </Card>
          <Card style={{ padding: 14 }}>
            <StatTile size="sm" label="Self-sufficiency" value={String(live.today.selfSufficiencyPct)} unit="%" tone="battery" icon={<Icon name="leaf" />} />
          </Card>
          <div style={{ gridColumn: 'span 2' }}>
            <Card glow accent="solar" style={{ padding: 14 }}>
              <StatTile size="sm" label="Saved today" value={`€${live.today.savedEur.toFixed(2)}`} tone="solar" icon={<Icon name="piggy-bank" />} footnote="vs grid-only" />
            </Card>
          </div>
          <div style={{ gridColumn: 'span 2' }}>
            <Card accent="grid" style={{ padding: 14 }}>
              <GridVoltageStat live={live} size="sm" />
            </Card>
          </div>
        </div>

        {/* live flow */}
        <Card accent="solar" glow style={{ padding: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
            <Eyebrow>Live flow</Eyebrow>
            <Badge tone="solar" variant="soft" icon={<Icon name="radio" size={12} />}>
              Live
            </Badge>
          </div>
          <EnergyFlow flow={flow} />
        </Card>

        {/* batteries */}
        <BatteriesCard live={live} />

        {/* notifications */}
        <NotificationsWidget />

        {/* autopilot state + 24 h plan (moved from Automations → Summary) */}
        <ControlGrid plan={plan} />
        <PlanHero plan={plan} wide={false} />
        <PlanKpis plan={plan} wide={false} />
        <TodaysMoves plan={plan} />

        {/* tariff */}
        <Card style={{ padding: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Eyebrow>Tariff · 2.0TD</Eyebrow>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--grid)' }}>
              Next · {t.nextBand} in {Math.floor(t.minsToNext / 60)}h {t.minsToNext % 60}m
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 6 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 26, fontWeight: 600 }}>{t.band}</span>
            <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
              {bandLabel(t.band)} · <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-1)' }}>€{t.rateEur.toFixed(3)}</span>/kWh
            </span>
          </div>
          <TariffBand current={hour} />
        </Card>

        {/* insight */}
        {(() => {
          const ins = deriveInsight(live);
          return (
            <Card accent={ins.tone} style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <span style={{ width: 28, height: 28, borderRadius: 8, display: 'grid', placeItems: 'center', background: `var(--${ins.tone}-wash)`, color: `var(--${ins.tone})` }}>
                  <Icon name={ins.icon} size={16} />
                </span>
                <Eyebrow>Why this matters</Eyebrow>
              </div>
              <div style={{ fontSize: 14, color: 'var(--text-1)', lineHeight: 1.5 }}>{ins.body}</div>
            </Card>
          );
        })()}

        {/* day chart */}
        <DayChartCard height={190} subtitle="5-min · kW left · SoC % right" />
      </div>
    </>
  );
}

function LiveDesktop({ live, flow, plan, stale }: { live: LiveResponse; flow: FlowData; plan: BrainPlanResponse; stale: boolean }) {
  const t = live.tariff;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {stale && <StaleBanner updatedAt={null} />}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: 14 }}>
        <Card>
          <StatTile label="Produced today" value={live.today.producedKwh.toFixed(1)} unit="kWh" tone="solar" icon={<Icon name="sun" />} footnote="today" />
        </Card>
        <Card>
          <StatTile label="Consumed today" value={live.today.consumedKwh.toFixed(1)} unit="kWh" tone="home" icon={<Icon name="plug" />} footnote="today" />
        </Card>
        <Card>
          <StatTile label="Grid feed-in" value={live.today.gridFeedInKwh.toFixed(1)} unit="kWh" tone="grid" icon={<Icon name="upload" />} footnote="exported today" />
        </Card>
        <Card>
          <StatTile label="Self-sufficiency" value={String(live.today.selfSufficiencyPct)} unit="%" tone="battery" icon={<Icon name="leaf" />} footnote="solar + stored" />
        </Card>
        <Card>
          <StatTile label="Saved today" value={`€${live.today.savedEur.toFixed(2)}`} tone="solar" icon={<Icon name="piggy-bank" />} footnote="vs grid-only" />
        </Card>
        {/* Live grid voltage/current/power (#77) — kept on desktop after the right-column
            tile grid was removed in the redesign. */}
        <Card>
          <GridVoltageStat live={live} wide />
        </Card>
      </div>

      {/* Row 2 — live energy flow (left) · Batteries + Notifications (right) */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.25fr 1fr', gap: 20, alignItems: 'stretch' }}>
        <Card
          title="Live energy flow"
          subtitle="Updated just now"
          accent="solar"
          icon={<Icon name="zap" />}
          actions={<Badge tone="solar" variant="soft" icon={<Icon name="radio" size={12} />}>Live</Badge>}
          style={{ display: 'flex', flexDirection: 'column' }}
        >
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <EnergyFlow flow={flow} size="lg" />
          </div>
        </Card>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <BatteriesCard live={live} />
          <NotificationsWidget />
        </div>
      </div>

      {/* Autopilot state + the brain's 24 h plan (moved from Automations → Summary) */}
      <ControlGrid plan={plan} />
      <PlanHero plan={plan} wide />
      <PlanKpis plan={plan} wide />
      <TodaysMoves plan={plan} />

      {/* Tariff + Insight — displaced by moving Batteries up */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        <Card style={{ display: 'flex', flexDirection: 'column' }}>
          <Eyebrow>Tariff · 2.0TD</Eyebrow>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 8 }}>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 30, fontWeight: 600 }}>{t.band}</span>
            <span style={{ fontSize: 13, color: 'var(--text-2)' }}>
              {bandLabel(t.band)} · <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-1)' }}>€{t.rateEur.toFixed(3)}</span>/kWh
            </span>
          </div>
          <TariffBand current={new Date(live.ts).getHours()} height={10} />
          <div style={{ marginTop: 12, fontSize: 12, color: 'var(--grid)', fontFamily: 'var(--font-mono)' }}>
            Next · {t.nextBand} in {Math.floor(t.minsToNext / 60)}h {t.minsToNext % 60}m
          </div>
        </Card>
        <InsightCard live={live} />
      </div>

      <DayChartCard height={240} subtitle="5-min · kW left · SoC % right" />
    </div>
  );
}

/**
 * Batteries card — Sonnen + Tesla SoC gauges + kWh/direction text + a
 * self-sufficiency bar. Shared across desktop (live-flow right column) and
 * mobile. Both contexts are narrow, so the two gauges stack vertically with
 * a 92px radius and centered kWh·direction caption — fits gracefully without
 * overflowing at common desktop right-column and mobile widths.
 */
function BatteriesCard({ live }: { live: LiveResponse }) {
  const batteries = [
    { name: 'Sonnen', soc: live.sonnen.soc, kwh: live.sonnen.kwh, dir: live.sonnen.dir },
    { name: 'Tesla', soc: live.tesla.soc, kwh: live.tesla.kwh, dir: live.tesla.dir },
  ];
  return (
    <Card title="Batteries" subtitle="Sonnen + Tesla · combined 36 kWh" icon={<Icon name="battery-charging" />}>
      <div style={{ display: 'flex', alignItems: 'stretch', gap: 10 }}>
        {batteries.map((b, i) => (
          <div key={b.name} style={{ display: 'contents' }}>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 7 }}>
              <RadialGauge value={b.soc} tone="battery" label={b.name} size={92} />
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-2)', textAlign: 'center' }}>{b.kwh} kWh · {dirLabel(b.dir)}</div>
            </div>
            {i === 0 && <div style={{ width: 1, alignSelf: 'stretch', background: 'var(--border-1)' }} />}
          </div>
        ))}
      </div>
      <div style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text-2)', marginBottom: 7 }}>
          <span>Self-sufficiency today</span>
          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-1)' }}>{live.today.selfSufficiencyPct}%</span>
        </div>
        <ProgressBar
          height={6}
          segments={[
            { value: live.today.selfSufficiencyPct, tone: 'solar' },
            { value: 100 - live.today.selfSufficiencyPct, tone: 'grid' },
          ]}
        />
      </div>
    </Card>
  );
}

function InsightCard({ live }: { live: LiveResponse }) {
  const ins = deriveInsight(live);
  return (
    <Card accent={ins.tone} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center', background: `var(--${ins.tone}-wash)`, color: `var(--${ins.tone})` }}>
          <Icon name={ins.icon} size={17} />
        </span>
        <Eyebrow>Why this matters</Eyebrow>
      </div>
      <div style={{ fontSize: 15, color: 'var(--text-1)', lineHeight: 1.5, fontWeight: 600 }}>{ins.title}</div>
      <div style={{ fontSize: 14, color: 'var(--text-1)', lineHeight: 1.5 }}>{ins.body}</div>
      <div style={{ marginTop: 'auto', fontSize: 12, color: 'var(--text-3)', display: 'flex', alignItems: 'center', gap: 7 }}>
        <Icon name="cpu" size={14} /> Advisory — the coordinator plans, holds capacity for the evening.
      </div>
    </Card>
  );
}
