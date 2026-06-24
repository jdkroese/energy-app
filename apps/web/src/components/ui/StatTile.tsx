import type { CSSProperties, ReactNode } from 'react';
import { ensureDsStyles } from './dsStyles';

export type Tone = 'solar' | 'battery' | 'grid' | 'home' | 'ev' | 'neutral';

const TONE: Record<Tone, [string | null, string | null]> = {
  solar: ['var(--solar)', 'var(--solar-wash)'],
  battery: ['var(--battery)', 'var(--battery-wash)'],
  grid: ['var(--grid)', 'var(--grid-wash)'],
  home: ['var(--home)', 'var(--home-wash)'],
  ev: ['var(--ev)', 'rgba(139,140,255,0.12)'],
  neutral: [null, null],
};

const Arrow = ({ dir }: { dir: 'up' | 'down' | 'flat' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    {dir === 'up' && (
      <>
        <line x1="7" y1="17" x2="17" y2="7" />
        <polyline points="9 7 17 7 17 15" />
      </>
    )}
    {dir === 'down' && (
      <>
        <line x1="7" y1="7" x2="17" y2="17" />
        <polyline points="17 9 17 17 9 17" />
      </>
    )}
    {dir === 'flat' && <line x1="6" y1="12" x2="18" y2="12" />}
  </svg>
);

type Props = {
  label?: ReactNode;
  value: ReactNode;
  unit?: string;
  tone?: Tone;
  icon?: ReactNode;
  size?: 'sm' | 'md' | 'xl';
  delta?: number | string;
  deltaDir?: 'up' | 'down' | 'flat';
  footnote?: ReactNode;
  className?: string;
  children?: ReactNode;
};

/** StatTile — big mono value + unit, uppercase label, tone icon, delta. */
export function StatTile({
  label,
  value,
  unit,
  tone = 'neutral',
  icon,
  size = 'md',
  delta,
  deltaDir,
  footnote,
  className = '',
  children,
}: Props) {
  ensureDsStyles();
  const [c, wash] = TONE[tone] || TONE.neutral;
  const dir = deltaDir || (typeof delta === 'number' ? (delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat') : 'flat');
  const style = { '--_tone': tone === 'neutral' ? undefined : c, '--_wash': wash } as CSSProperties;
  return (
    <div className={['pwr-stat', size !== 'md' && `pwr-stat--${size}`, className].filter(Boolean).join(' ')} style={style}>
      {(label || icon) && (
        <div className="pwr-stat__top">
          {icon && <span className="pwr-stat__icon">{icon}</span>}
          {label && <span className="pwr-stat__label">{label}</span>}
        </div>
      )}
      <div className="pwr-stat__value">
        <span className="pwr-stat__num">{value}</span>
        {unit && <span className="pwr-stat__unit">{unit}</span>}
      </div>
      {(delta != null || footnote) && (
        <div className="pwr-stat__foot">
          {delta != null && (
            <span className={`pwr-stat__delta pwr-stat__delta--${dir}`}>
              <Arrow dir={dir} />
              {typeof delta === 'number' ? `${Math.abs(delta)}%` : delta}
            </span>
          )}
          {footnote && <span>{footnote}</span>}
        </div>
      )}
      {children}
    </div>
  );
}
