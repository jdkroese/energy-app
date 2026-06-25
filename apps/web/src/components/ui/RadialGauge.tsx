import { ensureDsStyles } from './dsStyles';

const TONE: Record<string, string> = {
  solar: 'var(--solar)',
  battery: 'var(--battery)',
  grid: 'var(--grid)',
  home: 'var(--home)',
  ev: 'var(--ev)',
  accent: 'var(--accent)',
};

type Props = {
  value?: number;
  min?: number;
  max?: number;
  size?: number;
  thickness?: number;
  tone?: keyof typeof TONE;
  label?: string;
  unit?: string;
  showValue?: boolean;
  valueText?: string;
  className?: string;
};

/** RadialGauge — 270° arc gauge for bounded values (battery %, self-sufficiency). */
export function RadialGauge({
  value = 0,
  min = 0,
  max = 100,
  size = 132,
  thickness = 10,
  tone = 'battery',
  label,
  unit = '%',
  showValue = true,
  valueText,
  className = '',
}: Props) {
  ensureDsStyles();
  const pct = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const sweep = 0.75;
  const track = c * sweep;
  const dash = track * pct;
  const color = TONE[tone] || TONE.battery;
  const fs = Math.round(size * 0.26);
  return (
    <div
      className={['pwr-gauge', className].filter(Boolean).join(' ')}
      style={{ width: size, height: size }}
      role="img"
      aria-label={`${label ? `${label}: ` : ''}${valueText != null ? valueText : Math.round(value)}${unit}`}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--surface-4)"
          strokeWidth={thickness}
          strokeLinecap="round"
          strokeDasharray={`${track} ${c}`}
        />
        <circle
          className="pwr-gauge__arc"
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={thickness}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${c}`}
          style={{ filter: `drop-shadow(0 0 6px ${color})` }}
        />
      </svg>
      <div className="pwr-gauge__center">
        {showValue && (
          <div className="pwr-gauge__val" style={{ fontSize: fs }}>
            {valueText != null ? valueText : Math.round(value)}
            {unit && <span className="pwr-gauge__unit">{unit}</span>}
          </div>
        )}
        {label && <div className="pwr-gauge__cap">{label}</div>}
      </div>
    </div>
  );
}
