import type { CSSProperties, ReactNode } from 'react';
import { Eyebrow } from '../components/ui';
import { ThemeToggle } from '../components/shell/ThemeToggle';

/** Mobile screen header (eyebrow + h1), matching the *-mobile mockups. */
export function MobileHeader({ eyebrow, title, right }: { eyebrow: ReactNode; title: string; right?: ReactNode }) {
  return (
    <div className="flex md:hidden" style={{ alignItems: 'center', gap: 12, padding: '12px 18px 12px' }}>
      <div style={{ flex: 1 }}>
        <Eyebrow>{eyebrow}</Eyebrow>
        <h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-.02em', margin: '2px 0 0' }}>{title}</h1>
      </div>
      <ThemeToggle />
      {right}
    </div>
  );
}

/** Avatar bubble (JK). */
export function Avatar({ size = 38 }: { size?: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: 'linear-gradient(135deg,var(--solar-dim),var(--battery-dim))',
        display: 'grid',
        placeItems: 'center',
        fontWeight: 700,
        fontSize: 13,
        color: 'var(--text-inverse)',
      }}
    >
      JK
    </div>
  );
}

/** A thin "data is stale" banner shown when a refetch failed but we keep last-good. */
export function StaleBanner({ updatedAt }: { updatedAt: number | null }) {
  const mins = updatedAt ? Math.max(0, Math.round((Date.now() - updatedAt) / 60000)) : null;
  return (
    <div
      style={{
        margin: '0 14px',
        padding: '8px 12px',
        borderRadius: 'var(--radius-md)',
        background: 'var(--grid-wash)',
        color: 'var(--grid)',
        fontSize: 12,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}
    >
      Showing last-good data{mins != null ? ` · updated ${mins} min ago` : ''}
    </div>
  );
}

/** Simple skeleton block for loading states. */
export function Skeleton({ height = 120, style }: { height?: number; style?: CSSProperties }) {
  return (
    <div
      style={{
        height,
        borderRadius: 'var(--radius-card)',
        background: 'linear-gradient(90deg,var(--surface-1),var(--surface-2),var(--surface-1))',
        backgroundSize: '200% 100%',
        animation: 'pwr-shimmer 1.4s ease-in-out infinite',
        ...style,
      }}
    />
  );
}
