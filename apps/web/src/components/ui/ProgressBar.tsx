import type { CSSProperties } from 'react';
import { ensureDsStyles } from './dsStyles';

const TONE: Record<string, string> = {
  solar: 'var(--solar)',
  battery: 'var(--battery)',
  grid: 'var(--grid)',
  home: 'var(--home)',
  ev: 'var(--ev)',
  accent: 'var(--accent)',
  danger: 'var(--danger)',
};

export type Segment = { value: number; tone?: string; label?: string };

type Props = {
  value?: number;
  max?: number;
  tone?: string;
  height?: number;
  label?: string;
  valueText?: string;
  showValue?: boolean;
  glow?: boolean;
  segments?: Segment[];
  className?: string;
};

/** ProgressBar — linear level, or `segments` for a stacked energy-mix bar. */
export function ProgressBar({
  value = 0,
  max = 100,
  tone = 'accent',
  height = 8,
  label,
  valueText,
  showValue = false,
  glow = false,
  segments,
  className = '',
}: Props) {
  ensureDsStyles();
  const cls = ['pwr-bar', glow && 'pwr-bar--glow', className].filter(Boolean).join(' ');
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className={cls} style={{ '--_c': TONE[tone] || TONE.accent } as CSSProperties}>
      {(label || showValue) && (
        <div className="pwr-bar__top">
          {label && <span className="pwr-bar__label">{label}</span>}
          {showValue && <span className="pwr-bar__val">{valueText != null ? valueText : `${Math.round(pct)}%`}</span>}
        </div>
      )}
      <div className="pwr-bar__track" style={{ height }}>
        {segments ? (
          <div style={{ display: 'flex', height: '100%', width: '100%' }}>
            {segments.map((s, i) => (
              <div
                key={i}
                className="pwr-bar__seg"
                style={{ width: `${s.value}%`, background: TONE[s.tone || ''] || s.tone || 'var(--accent)' }}
                title={s.label}
              />
            ))}
          </div>
        ) : (
          <div className="pwr-bar__fill" style={{ width: `${pct}%` }} />
        )}
      </div>
    </div>
  );
}
