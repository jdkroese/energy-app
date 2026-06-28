import type { CSSProperties, ReactNode } from 'react';
import { Icon } from './Icon';
import { Button } from './Button';

/* ============================================================================
 * States family (Track C) — EmptyState / LoadingState / ErrorState.
 *
 * Standardizes the ad-hoc empty/loading/error blocks scattered across screens
 * (centered text in a Card, hand-rolled "Loading…" lines, one-off error copy).
 * One visual language: an icon-in-wash + title + subtitle, a skeleton shimmer
 * for loading, and a retry affordance for errors. Token-only so it renders in
 * light + dark.
 *
 * The Skeleton primitive lives here too (promoted from screens/_shared.tsx,
 * which now re-exports it) so loading shimmers share one source.
 * ==========================================================================*/

type Tone = 'default' | 'danger' | 'solar' | 'grid';

const TONE: Record<Tone, { wash: string; fg: string }> = {
  default: { wash: 'var(--surface-3)', fg: 'var(--text-3)' },
  danger: { wash: 'var(--danger-wash)', fg: 'var(--danger)' },
  solar: { wash: 'var(--solar-wash)', fg: 'var(--solar)' },
  grid: { wash: 'var(--grid-wash)', fg: 'var(--grid)' },
};

interface StateShellProps {
  icon: string;
  iconTone?: Tone;
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  style?: CSSProperties;
}

/** Shared icon-in-wash + title + subtitle + action layout. */
function StateShell({ icon, iconTone = 'default', title, subtitle, action, style }: StateShellProps) {
  const tone = TONE[iconTone];
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        gap: 10,
        padding: '36px 24px',
        ...style,
      }}
    >
      <span
        style={{
          width: 46,
          height: 46,
          borderRadius: 13,
          display: 'grid',
          placeItems: 'center',
          background: tone.wash,
          color: tone.fg,
          flex: 'none',
        }}
      >
        <Icon name={icon} size={22} />
      </span>
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-1)' }}>{title}</div>
      {subtitle && <div style={{ fontSize: 12.5, color: 'var(--text-3)', maxWidth: 320, lineHeight: 1.5 }}>{subtitle}</div>}
      {action && <div style={{ marginTop: 4 }}>{action}</div>}
    </div>
  );
}

export interface EmptyStateProps {
  icon?: string;
  iconTone?: Tone;
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  style?: CSSProperties;
}

/** Nothing-here state — e.g. no devices in a group, no scenes yet. */
export function EmptyState({ icon = 'inbox', iconTone = 'default', title, subtitle, action, style }: EmptyStateProps) {
  return <StateShell icon={icon} iconTone={iconTone} title={title} subtitle={subtitle} action={action} style={style} />;
}

export interface ErrorStateProps {
  icon?: string;
  title?: ReactNode;
  subtitle?: ReactNode;
  /** Renders a "Retry" button when provided. */
  onRetry?: () => void;
  retryLabel?: string;
  style?: CSSProperties;
}

/** Something-failed state with an optional retry. */
export function ErrorState({
  icon = 'alert-triangle',
  title = 'Something went wrong',
  subtitle,
  onRetry,
  retryLabel = 'Retry',
  style,
}: ErrorStateProps) {
  return (
    <StateShell
      icon={icon}
      iconTone="danger"
      title={title}
      subtitle={subtitle}
      action={
        onRetry ? (
          <Button size="sm" variant="secondary" iconLeft={<Icon name="refresh-cw" size={14} />} onClick={onRetry}>
            {retryLabel}
          </Button>
        ) : undefined
      }
      style={style}
    />
  );
}

/** Simple skeleton block for loading states (shared shimmer). */
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

export interface LoadingStateProps {
  /** Number of skeleton rows to render. */
  rows?: number;
  /** Height of each skeleton row. */
  rowHeight?: number;
  gap?: number;
  /** Optional below-the-skeletons label (e.g. "Loading devices…"). */
  label?: ReactNode;
  style?: CSSProperties;
}

/** Loading state — stacked skeleton shimmers + optional label. */
export function LoadingState({ rows = 3, rowHeight = 72, gap = 10, label, style }: LoadingStateProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap, ...style }} aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} height={rowHeight} />
      ))}
      {label && <div style={{ fontSize: 12, color: 'var(--text-3)', textAlign: 'center', marginTop: 2 }}>{label}</div>}
    </div>
  );
}
