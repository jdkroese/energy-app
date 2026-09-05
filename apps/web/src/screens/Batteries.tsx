import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import { MOCK_BATTERIES, MOCK_HISTORY_DAY, MOCK_LIVE } from '../lib/mock';
import type { BatteriesResponse, BatteryDetail, FlowDir, HistoryDayResponse, LiveResponse } from '../lib/types';
import { Badge, Card, Eyebrow, Icon } from '../components/ui';
import { MobileHeader, Avatar, StaleBanner } from './_shared';
import { SolarInverterRows } from './SolarInverters';
import { aggregateDay, bandAtHour } from '../lib/dayMetrics';
import { useMediaQuery } from '../components/shell/useMediaQuery';
import type { ShellContext } from '../components/shell/AppShell';

/* ============================================================================
 * Energy (V2, docs/53) — the state of storage, and whether the packs are being
 * used well.
 *
 * A storage HERO answers "how much is left, and how far does it get me" in one
 * sentence, with the day's SoC trace over the tariff bands behind it. Then one
 * card per pack — they have deliberately different roles (Sonnen = fast
 * self-consumption actuator, Tesla = backup + policy), so the cards are toned
 * differently and each opens its detail page. Solar generation closes the screen
 * as a production-share row.
 * ==========================================================================*/

export interface PowerState {
  label: string;
  tone: 'solar' | 'battery' | 'neutral';
  icon: string;
}

export function powerState(power: { kw: number; dir: FlowDir }): PowerState {
  if (power.dir === 'charging') return { label: 'Charging', tone: 'solar', icon: 'arrow-down-to-line' };
  if (power.dir === 'discharging') return { label: 'Discharging', tone: 'battery', icon: 'arrow-up-from-line' };
  return { label: 'Idle', tone: 'neutral', icon: 'minus' };
}

const toneVar = (t: string) => (t === 'neutral' ? 'var(--text-3)' : `var(--${t})`);

/** Live power pill — "Charging · 2.1 kW" with a tone dot. Used by BatteryDetail. */
export function PowerPill({ power }: { power: { kw: number; dir: FlowDir } }) {
  const ps = powerState(power);
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 9px',
        borderRadius: 'var(--radius-pill)',
        background: ps.tone === 'neutral' ? 'var(--surface-3)' : `var(--${ps.tone}-wash)`,
        color: toneVar(ps.tone),
        fontSize: 12,
        fontWeight: 600,
      }}
    >
      <Icon name={ps.icon} size={13} />
      {ps.label}
      {power.dir !== 'idle' && <span style={{ fontFamily: 'var(--font-mono)' }}>· {power.kw.toFixed(1)} kW</span>}
    </span>
  );
}

/** Signed pack flow, positive = charging. */
const signedKw = (p: { kw: number; dir: FlowDir }) =>
  p.dir === 'charging' ? Math.abs(p.kw) : p.dir === 'discharging' ? -Math.abs(p.kw) : 0;

const fmtSigned = (kw: number) => (kw > 0.05 ? `+${kw.toFixed(1)}` : kw < -0.05 ? `−${Math.abs(kw).toFixed(1)}` : '0.0');

/** Each pack's own tone — Sonnen is the battery actuator, Tesla the policy pack. */
const packTone = (id: string): 'battery' | 'ev' => (id === 'tesla' ? 'ev' : 'battery');

const PACK_NOTE: Record<string, string> = {
  sonnen: 'Cycled first each evening — the cheaper cycle per kWh through the pack.',
  tesla: 'Holds the backup reserve. Its gateway meter also provides the Grid and Home readings.',
};

/** The day's combined-SoC trace over tariff-band grounds, at sparkline scale. */
function SocTrace({ day }: { day: HistoryDayResponse }) {
  const W = 1000;
  const H = 90;
  const path = useMemo(() => {
    const soc = day.series.combinedSoc;
    const last = day.nowIndex ?? soc.length - 1;
    const pts: string[] = [];
    for (let i = 0; i <= last; i += 3) {
      const x = (i / 288) * W;
      const y = 86 - ((soc[i] ?? 0) / 100) * 78;
      pts.push(`${pts.length === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`);
    }
    return pts.join(' ');
  }, [day]);

  const bands = useMemo(() => {
    const out: { x: number; w: number; fill: string }[] = [];
    let start = 0;
    for (let h = 1; h <= 24; h++) {
      if (h === 24 || bandAtHour(day.tariffBands, h) !== bandAtHour(day.tariffBands, start)) {
        const b = bandAtHour(day.tariffBands, start);
        out.push({
          x: (start / 24) * W,
          w: ((h - start) / 24) * W,
          fill: b === 'P1' ? 'var(--band-p1-fill)' : b === 'P3' ? 'var(--band-p3-fill)' : 'transparent',
        });
        start = h;
      }
    }
    return out;
  }, [day]);

  const nowX = day.nowIndex != null ? (day.nowIndex / 288) * W : null;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: 'block', width: '100%', height: 80 }} aria-hidden>
      {bands.map((b, i) => (
        <rect key={i} x={b.x} y={0} width={b.w} height={H} fill={b.fill} />
      ))}
      <path d={path} fill="none" stroke="var(--series-soc-combined)" strokeWidth={2} vectorEffect="non-scaling-stroke" style={{ filter: 'drop-shadow(0 0 5px color-mix(in srgb, var(--series-soc-combined) 55%, transparent))' }} />
      {nowX != null && <line x1={nowX} y1={0} x2={nowX} y2={H} stroke="var(--solar)" strokeWidth={1} vectorEffect="non-scaling-stroke" opacity=".5" />}
    </svg>
  );
}

function StorageHero({ view, live, day, wide, roomy, pad, gap }: {
  view: BatteriesResponse;
  live: LiveResponse;
  day: HistoryDayResponse;
  /** Desktop (>= 768 px). */
  wide: boolean;
  /** Desktop AND wider than the 1180 px two-column breakpoint. */
  roomy: boolean;
  pad: number;
  gap: number;
}) {
  const { combined } = view;
  const soc = Math.round(combined.soc);
  const R = 43;
  const C = 2 * Math.PI * R;

  const agg = aggregateDay(day);
  const solarChargedPct = agg.chargeKwh > 0.2 ? Math.round((1 - agg.chargeImportKwh / agg.chargeKwh) * 100) : null;
  const roundTrip = view.batteries.map((b) => b.roundTripPct).filter((v): v is number => v != null);
  const roundTripPct = roundTrip.length ? Math.round(roundTrip.reduce((s, v) => s + v, 0) / roundTrip.length) : null;

  // "Enough to carry the house to HH:MM" — stored energy against the load the
  // house is pulling right now. Only claimed while the packs are actually
  // carrying the house, and only when the runway lands TONIGHT: past ~14 h the
  // clock time would silently mean tomorrow, which reads as a much smaller
  // reserve than it is, so the sentence switches to plain hours.
  const discharging = view.batteries.some((b) => b.power.dir === 'discharging');
  const runwayH = combined.storedKwh / Math.max(0.3, live.home.kw);
  const until = new Date(Date.now() + runwayH * 3600_000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const headline = !discharging
    ? `Storage at ${soc}% · ${combined.storedKwh.toFixed(1)} kWh banked.`
    : runwayH <= 14
      ? `${combined.storedKwh.toFixed(1)} kWh left — enough to carry the house to ${until}.`
      : `${combined.storedKwh.toFixed(1)} kWh left — about ${Math.round(runwayH)} h at the load right now.`;

  const names = view.batteries.map((b) => b.name).join(' + ');

  return (
    <Card
      accent="battery"
      glow
      padded={false}
      style={{
        padding: pad,
        display: 'grid',
        gridTemplateColumns: roomy ? 'auto 1fr' : '1fr',
        gap,
        alignItems: 'center',
        animation: 'v2rise .5s var(--ease-out)',
      }}
    >
      <div style={{ position: 'relative', width: 150, height: 150, justifySelf: 'center' }}>
        <svg viewBox="0 0 100 100" style={{ width: 150, height: 150, transform: 'rotate(-90deg)' }} aria-hidden>
          <circle cx="50" cy="50" r={R} fill="none" stroke="var(--surface-4)" strokeWidth="6" />
          <circle
            cx="50"
            cy="50"
            r={R}
            fill="none"
            stroke="var(--battery)"
            strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray={`${((C * soc) / 100).toFixed(1)} ${C.toFixed(1)}`}
            style={{ filter: 'drop-shadow(0 0 7px var(--battery))', transition: 'stroke-dasharray .6s var(--ease-out)' }}
          />
        </svg>
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
          <span className="pwr-mono" style={{ fontSize: 34, fontWeight: 500 }}>
            {soc}
            <small style={{ fontSize: 15, color: 'var(--text-2)' }}>%</small>
          </span>
          <span style={{ fontSize: 9, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--text-3)' }}>combined</span>
        </div>
      </div>

      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Eyebrow>Storage</Eyebrow>
        <div style={{ fontSize: !wide ? 25 : roomy ? 32 : 27, fontWeight: 600, letterSpacing: '-.02em', lineHeight: 1.15, textWrap: 'pretty' }}>{headline}</div>
        <div style={{ fontSize: 14, color: 'var(--text-2)', lineHeight: 1.55, textWrap: 'pretty' }}>
          {combined.usableKwh.toFixed(0)} kWh usable across {names}. The coordinator treats them as one pool but cycles the
          Sonnen first — it is the cheaper cycle.
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {roundTripPct != null && <Badge tone="battery" variant="soft">Round-trip {roundTripPct}%</Badge>}
          {solarChargedPct != null && <Badge tone="solar" variant="soft">Solar-charged {solarChargedPct}%</Badge>}
        </div>
        <div style={{ marginTop: 4 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-3)', marginBottom: 6 }}>
            <span>State of charge · today</span>
            <span className="pwr-mono">{Math.round(day.series.combinedSoc[0] ?? 0)} % → {soc} %</span>
          </div>
          <SocTrace day={day} />
        </div>
      </div>
    </Card>
  );
}

function PackCard({ b, pad, onOpen }: { b: BatteryDetail; pad: number; onOpen: () => void }) {
  const tone = packTone(b.id);
  const ps = powerState(b.power);
  const kw = signedKw(b.power);
  return (
    <Card
      interactive
      accent={tone}
      padded={false}
      onClick={onOpen}
      style={{ padding: pad, display: 'flex', flexDirection: 'column', gap: 14, cursor: 'pointer', animation: 'v2rise .5s var(--ease-out) .08s' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
        <span style={{ width: 34, height: 34, borderRadius: 11, display: 'grid', placeItems: 'center', background: `var(--${tone}-wash)`, color: `var(--${tone})`, flex: 'none' }}>
          <Icon name="battery-charging" size={18} />
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>{b.name}</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {b.vendor} · {b.usableKwh} kWh
          </div>
        </div>
        <span style={{ marginLeft: 'auto' }}>
          <Badge tone={b.online ? tone : 'neutral'} variant="soft">{b.online ? ps.label : 'Offline'}</Badge>
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <span className="pwr-mono" style={{ fontSize: 38, fontWeight: 500, color: `var(--${tone})` }}>{fmtSigned(kw)}</span>
        <span className="pwr-mono" style={{ fontSize: 13, color: 'var(--text-2)' }}>kW · {b.kwh.toFixed(1)} kWh stored</span>
      </div>

      <div style={{ height: 9, borderRadius: 999, background: 'var(--surface-4)', overflow: 'hidden' }}>
        <i
          style={{
            display: 'block',
            height: '100%',
            width: `${Math.max(0, Math.min(100, b.soc))}%`,
            background: `var(--${tone})`,
            borderRadius: 999,
            boxShadow: `0 0 12px var(--${tone})`,
            transition: 'width .6s var(--ease-out)',
          }}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10 }}>
        {[
          { k: 'Cycles', v: b.cyclesTotal != null ? b.cyclesTotal.toLocaleString() : '—' },
          { k: 'Throughput', v: b.throughputKwh != null ? `${(b.throughputKwh / 1000).toFixed(1)} MWh` : '—' },
          { k: 'Health', v: b.health != null ? `${b.health}%` : '—' },
        ].map((s) => (
          <div key={s.k}>
            <div style={{ fontSize: 9, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--text-3)', fontWeight: 600 }}>{s.k}</div>
            <div className="pwr-mono" style={{ fontSize: 14, marginTop: 3 }}>{s.v}</div>
          </div>
        ))}
      </div>

      <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5, textWrap: 'pretty' }}>
        {PACK_NOTE[b.id] ?? b.role}
        {b.hasBackup && b.backupKwh != null && (
          <> Backup holds {b.backupKwh.toFixed(1)} kWh{b.backupHours != null ? ` ≈ ${b.backupHours} h` : ''}.</>
        )}
      </div>
    </Card>
  );
}

export function Batteries({ ctx }: { ctx: ShellContext }) {
  const nav = useNavigate();
  const { data, loading, stale, updatedAt } = usePolling<BatteriesResponse>(api.batteries, 15_000);
  const { data: liveData } = usePolling<LiveResponse>(api.live, 15_000);
  const { data: dayData } = usePolling<HistoryDayResponse>(api.historyDayToday, 60_000);
  const roomy = useMediaQuery('(min-width: 1180px)');

  const view = data || (loading ? null : MOCK_BATTERIES) || MOCK_BATTERIES;
  const live = liveData ?? MOCK_LIVE;
  const day = dayData ?? MOCK_HISTORY_DAY;
  const wide = ctx.desktop;

  const gap = !wide ? 12 : roomy ? 18 : 16;
  const pad = !wide ? 16 : roomy ? 20 : 18;
  const twoCol = wide && roomy;

  const body = (
    <>
      {stale && <StaleBanner updatedAt={updatedAt} />}
      <StorageHero view={view} live={live} day={day} wide={wide} roomy={twoCol} pad={pad} gap={gap} />
      <div style={{ display: 'grid', gridTemplateColumns: twoCol ? '1fr 1fr' : '1fr', gap }}>
        {view.batteries.map((b) => (
          <PackCard key={b.id} b={b} pad={pad} onOpen={() => nav(`/batteries/${b.id}`)} />
        ))}
      </div>
      <SolarInverterRows pad={pad} />
    </>
  );

  if (wide) return <div style={{ display: 'flex', flexDirection: 'column', gap }}>{body}</div>;

  return (
    <>
      <MobileHeader eyebrow="Energy" title="Solar & batteries" right={<Avatar />} />
      <div style={{ display: 'flex', flexDirection: 'column', gap, padding: '8px 14px 22px' }}>{body}</div>
    </>
  );
}
