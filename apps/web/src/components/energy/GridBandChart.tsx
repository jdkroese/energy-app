import { useEffect, useRef, useState } from 'react';
import type { Band } from '../../lib/types';

/**
 * GridBandChart — "Grid purchase · by tariff band".
 *
 * A stacked time-series of grid-imported energy, split into Spain's 2.0TD P1/P2/P3
 * bands (real time-of-use attribution from the API), with a kWh⇄€ toggle, band
 * isolation, a hover crosshair + per-band tooltip, and an animated cost summary.
 * Follows the Reports range selector via the buckets the API returns.
 */

const BANDS: Band[] = ['P1', 'P2', 'P3']; // stack order, bottom → top
// Spain 2.0TD energy rates (mirror apps/api/src/tariff.ts RATES).
const RATE: Record<Band, number> = { P1: 0.2093, P2: 0.1309, P3: 0.0957 };
const NAME: Record<Band, string> = { P1: 'Peak', P2: 'Standard', P3: 'Valley' };
const COLOR: Record<Band, string> = {
  P1: 'var(--band-p1)',
  P2: 'var(--band-p2)',
  P3: 'var(--band-p3)',
};

type Mode = 'eur' | 'kwh';

interface Props {
  labels: string[];
  bandKwh: { P1: number[]; P2: number[]; P3: number[] };
  powerTermEur?: number;
  /** Wider layout, taller plot, summary beside the chart (vs. stacked on mobile). */
  desktop?: boolean;
}

/** Nice axis max with ~4 human-friendly ticks. */
function niceTicks(rawMax: number, floor: number): { max: number; ticks: number[]; decimals: number } {
  const step0 = Math.max(rawMax, floor) / 4;
  const pow = 10 ** Math.floor(Math.log10(step0));
  const n = step0 / pow;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
  const max = Math.ceil(Math.max(rawMax, floor) / step) * step;
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  const ticks: number[] = [];
  for (let v = 0; v <= max + step / 1000; v += step) ticks.push(v);
  return { max, ticks, decimals };
}

/** Count a number up to `target` over ~0.6s whenever it changes. */
function useCountUp(target: number): number {
  const [val, setVal] = useState(target);
  const fromRef = useRef(target);
  const rafRef = useRef(0);
  useEffect(() => {
    const from = fromRef.current;
    const start = performance.now();
    const dur = 600;
    const tick = (now: number) => {
      const t = Math.min((now - start) / dur, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      const v = from + (target - from) * eased;
      setVal(v);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
      else fromRef.current = target;
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target]);
  return val;
}

export function GridBandChart({ labels, bandKwh, powerTermEur, desktop = false }: Props) {
  const [mode, setMode] = useState<Mode>('eur');
  const [hidden, setHidden] = useState<Record<Band, boolean>>({ P1: false, P2: false, P3: false });
  const [hover, setHover] = useState<number | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const n = labels.length;
  const kwhAt = (b: Band, i: number) => bandKwh[b][i] ?? 0;
  const valAt = (b: Band, i: number) => (mode === 'eur' ? kwhAt(b, i) * RATE[b] : kwhAt(b, i));
  const colTotal = (i: number) =>
    BANDS.reduce((s, b) => (hidden[b] ? s : s + valAt(b, i)), 0);

  const rawMax = Math.max(...labels.map((_, i) => colTotal(i)), mode === 'eur' ? 0.01 : 0.1);
  const { max, ticks, decimals } = niceTicks(rawMax, mode === 'eur' ? 0.5 : 1);

  // Aggregates over the whole period.
  const sumKwh: Record<Band, number> = { P1: 0, P2: 0, P3: 0 };
  for (const b of BANDS) sumKwh[b] = bandKwh[b].reduce((s, v) => s + (v ?? 0), 0);
  const sumEur: Record<Band, number> = {
    P1: sumKwh.P1 * RATE.P1,
    P2: sumKwh.P2 * RATE.P2,
    P3: sumKwh.P3 * RATE.P3,
  };
  const totKwh = sumKwh.P1 + sumKwh.P2 + sumKwh.P3;
  const totEur = sumEur.P1 + sumEur.P2 + sumEur.P3;
  const avgRate = totKwh > 0 ? totEur / totKwh : 0;

  const heroTarget = mode === 'eur' ? totEur : totKwh;
  const hero = useCountUp(heroTarget);

  // X-axis label thinning so dense ranges (e.g. 28 days) don't collide.
  const stride = Math.max(1, Math.ceil(n / (desktop ? 16 : 7)));
  const plotH = desktop ? 244 : 170;

  const fmtTick = (v: number) =>
    mode === 'eur' ? `€${v >= 10 ? v.toFixed(0) : v.toFixed(Math.min(decimals, 1))}` : v.toFixed(decimals);

  const toggle = (b: Band) => setHidden((h) => ({ ...h, [b]: !h[b] }));

  // Tooltip horizontal anchoring (clamps near the edges so it never clips).
  const hoverPct = hover != null ? ((hover + 0.5) / n) * 100 : 0;
  const tipShift = hover == null ? -50 : hover < n * 0.18 ? -8 : hover > n * 0.82 ? -92 : -50;

  const summary = (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: desktop ? 18 : 16,
        ...(desktop
          ? { borderLeft: '1px solid var(--border-1)', paddingLeft: 22 }
          : { borderTop: '1px solid var(--border-1)', paddingTop: 16 }),
      }}
    >
      <div>
        <div style={{ fontSize: 10.5, letterSpacing: '.13em', textTransform: 'uppercase', color: 'var(--text-3)', fontWeight: 600 }}>
          Total grid {mode === 'eur' ? 'spend' : 'import'}
        </div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: desktop ? 33 : 28, fontWeight: 600, letterSpacing: '-.02em', marginTop: 6, fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>
          {mode === 'eur' ? (
            <><span style={{ fontSize: desktop ? 20 : 17, color: 'var(--text-2)', marginRight: 2 }}>€</span>{hero.toFixed(2)}</>
          ) : (
            <>{hero.toFixed(0)}<span style={{ fontSize: desktop ? 16 : 14, color: 'var(--text-2)', marginLeft: 4 }}>kWh</span></>
          )}
        </div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-3)', marginTop: 8 }}>
          {mode === 'eur'
            ? `${totKwh.toFixed(0)} kWh · €${avgRate.toFixed(3)}/kWh avg`
            : `€${totEur.toFixed(2)} · €${avgRate.toFixed(3)}/kWh avg`}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {BANDS.slice().reverse().map((b) => {
          const denom = mode === 'eur' ? totEur : totKwh;
          const share = denom > 0 ? ((mode === 'eur' ? sumEur[b] : sumKwh[b]) / denom) * 100 : 0;
          return (
            <div key={b}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, marginBottom: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: COLOR[b], flex: 'none', alignSelf: 'center' }} />
                <span style={{ fontSize: 12, fontWeight: 600 }}>{b}</span>
                <span style={{ fontSize: 10.5, color: 'var(--text-3)', flex: 1 }}>{NAME[b]} · {sumKwh[b].toFixed(0)} kWh</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}>€{sumEur[b].toFixed(2)}</span>
              </div>
              <div style={{ height: 6, background: 'var(--surface-2)', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${mounted ? share : 0}%`, background: COLOR[b], borderRadius: 4, transition: 'width .7s cubic-bezier(.22,1,.36,1)' }} />
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-2)', background: 'var(--surface-2)', border: '1px solid var(--border-1)', borderRadius: 10, padding: '11px 13px' }}>
        Valley (P3) is{' '}
        <b style={{ color: 'var(--band-p3)', fontWeight: 600 }}>{totKwh > 0 ? Math.round((sumKwh.P3 / totKwh) * 100) : 0}% of your kWh</b>{' '}
        but only {totEur > 0 ? Math.round((sumEur.P3 / totEur) * 100) : 0}% of spend. Peak (P1) is just{' '}
        {totKwh > 0 ? Math.round((sumKwh.P1 / totKwh) * 100) : 0}% of kWh yet{' '}
        <b style={{ color: 'var(--band-p1)', fontWeight: 600 }}>{totEur > 0 ? Math.round((sumEur.P1 / totEur) * 100) : 0}% of the bill</b>.
      </div>
      {powerTermEur != null && (
        <div style={{ fontSize: 11, color: 'var(--text-3)' }}>+ fixed power term €{powerTermEur.toFixed(2)} (14 kW)</div>
      )}
    </div>
  );

  const chart = (
    <div role="img" aria-label={`Grid electricity purchased by tariff band — total €${totEur.toFixed(2)} over ${totKwh.toFixed(0)} kWh`}>
      <div style={{ display: 'flex', height: plotH }}>
        {/* y-axis */}
        <div style={{ width: desktop ? 48 : 40, position: 'relative', flex: 'none' }}>
          {ticks.map((t) => (
            <span key={t} style={{ position: 'absolute', right: 8, bottom: `calc(${(t / max) * 100}% - 6px)`, fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-3)', fontVariantNumeric: 'tabular-nums' }}>
              {fmtTick(t)}
            </span>
          ))}
        </div>
        {/* plot */}
        <div style={{ flex: 1, position: 'relative', borderLeft: '1px solid var(--border-1)', borderBottom: '1px solid var(--border-1)' }}>
          {/* gridlines */}
          {ticks.map((t) => (
            <div key={t} style={{ position: 'absolute', left: 0, right: 0, bottom: `${(t / max) * 100}%`, borderTop: '1px dashed var(--border-1)', opacity: t === 0 ? 0 : 0.5 }} />
          ))}
          {/* crosshair */}
          <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${hoverPct}%`, width: 1, background: 'var(--text-3)', opacity: hover != null ? 0.4 : 0, transition: 'opacity .12s', pointerEvents: 'none' }} />
          {/* bars */}
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'flex-end', gap: n > 16 ? 2 : 3, padding: '0 2px' }}>
            {labels.map((_, i) => (
              <div
                key={i}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover((x) => (x === i ? null : x))}
                style={{ flex: 1, height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', cursor: 'pointer' }}
              >
                {BANDS.slice().reverse().map((b) => {
                  const hgt = hidden[b] || !mounted ? 0 : (valAt(b, i) / max) * 100;
                  const top = b === BANDS[BANDS.length - 1]; // P3 sits on top of the stack
                  return (
                    <div
                      key={b}
                      style={{
                        width: '100%',
                        height: `${hgt}%`,
                        background: COLOR[b],
                        borderRadius: top ? '2px 2px 0 0' : 0,
                        opacity: hover == null || hover === i ? 1 : 0.55,
                        filter: hover === i ? 'brightness(1.15)' : 'none',
                        transition: `height .6s cubic-bezier(.22,1,.36,1), opacity .2s`,
                        transitionDelay: mounted ? `${Math.min(i * 8, 240)}ms` : '0ms',
                      }}
                    />
                  );
                })}
              </div>
            ))}
          </div>
          {/* tooltip */}
          {hover != null && (
            <div
              style={{
                position: 'absolute',
                left: `${hoverPct}%`,
                top: 8,
                transform: `translateX(${tipShift}%)`,
                background: '#060c0e',
                border: '1px solid rgba(233,245,242,0.14)',
                borderRadius: 11,
                padding: '10px 12px',
                minWidth: 156,
                pointerEvents: 'none',
                zIndex: 5,
                boxShadow: '0 12px 32px rgba(0,0,0,.55)',
              }}
            >
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 8, fontWeight: 600 }}>{labels[hover]}</div>
              {BANDS.slice().reverse().map((b) => (
                <div key={b} style={{ display: 'flex', alignItems: 'center', gap: 7, margin: '5px 0', opacity: hidden[b] ? 0.4 : 1 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: COLOR[b], flex: 'none' }} />
                  <span style={{ fontSize: 11.5, width: 20, fontWeight: 600 }}>{b}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-3)', flex: 1 }}>{kwhAt(b, hover).toFixed(1)} kWh</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, fontVariantNumeric: 'tabular-nums' }}>€{(kwhAt(b, hover) * RATE[b]).toFixed(2)}</span>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--border-1)', marginTop: 8, paddingTop: 8, fontSize: 11, color: 'var(--text-2)' }}>
                <span>Total</span>
                <b style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-1)', fontVariantNumeric: 'tabular-nums' }}>
                  €{BANDS.reduce((s, b) => s + kwhAt(b, hover!) * RATE[b], 0).toFixed(2)}
                </b>
              </div>
            </div>
          )}
        </div>
      </div>
      {/* x-axis labels */}
      <div style={{ display: 'flex', marginLeft: desktop ? 48 : 40, marginTop: 7 }}>
        {labels.map((l, i) => (
          <div key={i} style={{ flex: 1, textAlign: 'center', font: '500 10px var(--font-mono)', color: 'var(--text-3)', whiteSpace: 'nowrap', overflow: 'hidden' }}>
            {i % stride === 0 ? l : ''}
          </div>
        ))}
      </div>
      {/* legend — click to isolate a band */}
      <div style={{ display: 'flex', gap: 8, marginLeft: desktop ? 48 : 40, marginTop: 16, flexWrap: 'wrap' }}>
        {BANDS.map((b) => (
          <button
            key={b}
            onClick={() => toggle(b)}
            style={{
              display: 'flex', alignItems: 'center', gap: 7,
              background: 'var(--surface-2)', border: '1px solid var(--border-1)',
              borderRadius: 9, padding: '7px 11px', cursor: 'pointer',
              color: 'var(--text-1)', opacity: hidden[b] ? 0.4 : 1, transition: 'opacity .18s',
            }}
          >
            <span style={{ width: 9, height: 9, borderRadius: 3, background: COLOR[b], flex: 'none' }} />
            <span style={{ fontSize: 12.5, fontWeight: 600 }}>{b}</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-3)' }}>{NAME[b]} · €{RATE[b].toFixed(4)}</span>
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div>
      {/* header: title + kWh/€ toggle */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: desktop ? 18 : 14 }}>
        <div style={{ fontSize: 10.5, letterSpacing: '.13em', textTransform: 'uppercase', color: 'var(--text-3)', fontWeight: 600 }}>
          Grid purchase · by band
        </div>
        <div style={{ display: 'flex', background: 'var(--surface-2)', border: '1px solid var(--border-1)', borderRadius: 10, padding: 3, flex: 'none' }}>
          {(['eur', 'kwh'] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              style={{
                font: '600 12.5px var(--font-sans)',
                color: mode === m ? 'var(--solar)' : 'var(--text-2)',
                background: mode === m ? 'color-mix(in srgb, var(--solar) 12%, transparent)' : 'transparent',
                border: 0, padding: '6px 12px', borderRadius: 7, cursor: 'pointer', transition: 'color .18s, background .18s',
              }}
            >
              {m === 'eur' ? 'Cost €' : 'Energy kWh'}
            </button>
          ))}
        </div>
      </div>

      {desktop ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 240px', gap: 24 }}>
          {chart}
          {summary}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {chart}
          {summary}
        </div>
      )}
    </div>
  );
}
