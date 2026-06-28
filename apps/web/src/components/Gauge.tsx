// Gauge — a compact radial ARC gauge (semicircle ~200°) for an unbounded live
// measure (circuit current / voltage). Self-contained inline SVG, no deps. Auto-ranges
// the max so a small reading never pegs and a large one never overflows the arc.

type Props = {
  label: string;
  value: number | null;
  unit?: string;
  /** Brand hue for the filled arc, e.g. "var(--ev)" / "var(--grid)". */
  accent: string;
  /** A sensible floor for the auto-range so a tiny reading doesn't peg the arc. */
  nominalFloor?: number;
  size?: number;
};

/** Round up to a clean 1 / 2 / 5 × 10ⁿ ceiling so the scale reads nicely. */
function niceCeil(n: number): number {
  if (!(n > 0)) return 1;
  const exp = Math.floor(Math.log10(n));
  const base = Math.pow(10, exp);
  const f = n / base;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * base;
}

const SWEEP_DEG = 200;

/** Point on the arc at fraction t (0→start, 1→end) of a ~200° sweep. */
function arcPoint(cx: number, cy: number, r: number, t: number): [number, number] {
  // Rainbow arc over the TOP, centred on 12 o'clock: lower-left (t=0) up over the
  // top (t=0.5) down to lower-right (t=1). The math angle decreases 190°→-10°, which
  // is clockwise on screen (y points down), so the arc never dips through the bottom.
  const deg = 190 - SWEEP_DEG * t;
  const rad = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy - r * Math.sin(rad)];
}

function arcPath(cx: number, cy: number, r: number, from: number, to: number): string {
  const [x1, y1] = arcPoint(cx, cy, r, from);
  const [x2, y2] = arcPoint(cx, cy, r, to);
  // large-arc-flag must reflect the ACTUAL angular span, not a fixed 0.5 fraction.
  const large = (to - from) * SWEEP_DEG > 180 ? 1 : 0;
  // sweep-flag 1 = clockwise in SVG's y-down space (our angle decreases).
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

export function Gauge({ label, value, unit, accent, nominalFloor = 1, size = 132 }: Props) {
  const has = value != null && Number.isFinite(value);
  const v = has ? Math.max(0, value as number) : 0;
  const max = niceCeil(Math.max(nominalFloor, v));
  const frac = Math.max(0, Math.min(1, v / max));

  const cx = size / 2;
  const cy = size * 0.56;
  const thickness = Math.max(8, Math.round(size * 0.085));
  const r = size / 2 - thickness / 2 - 2;
  const fs = Math.round(size * 0.24);

  return (
    <div
      style={{ width: size, height: Math.round(size * 0.78), position: 'relative' }}
      role="img"
      aria-label={`${label}: ${has ? `${v} ${unit ?? ''}`.trim() : 'no reading'}`}
    >
      <svg width={size} height={Math.round(size * 0.78)} viewBox={`0 0 ${size} ${Math.round(size * 0.78)}`}>
        <path
          d={arcPath(cx, cy, r, 0, 1)}
          fill="none"
          stroke="var(--surface-3)"
          strokeWidth={thickness}
          strokeLinecap="round"
        />
        {has && frac > 0 && (
          <path
            d={arcPath(cx, cy, r, 0, frac)}
            fill="none"
            stroke={accent}
            strokeWidth={thickness}
            strokeLinecap="round"
            style={{ filter: `drop-shadow(0 0 5px ${accent})` }}
          />
        )}
      </svg>
      <div
        style={{
          position: 'absolute',
          top: '58%',
          left: 0,
          right: 0,
          textAlign: 'center',
          transform: 'translateY(-50%)',
          pointerEvents: 'none',
        }}
      >
        <div className="pwr-mono" style={{ fontSize: fs, fontWeight: 600, color: 'var(--text-1)', lineHeight: 1.05 }}>
          {has ? Math.round(v) : '—'}
          {has && unit && <span style={{ fontSize: Math.round(fs * 0.45), color: 'var(--text-3)', marginLeft: 2 }}>{unit}</span>}
        </div>
        <div style={{ fontSize: 10.5, color: 'var(--text-3)', marginTop: 2, letterSpacing: 0.2 }}>{label}</div>
      </div>
    </div>
  );
}
