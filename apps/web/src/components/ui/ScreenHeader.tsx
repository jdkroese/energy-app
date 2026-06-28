import type { CSSProperties, ReactNode } from 'react';
import { Eyebrow } from './Eyebrow';
import { Icon } from './Icon';

/* ============================================================================
 * ScreenHeader — the ONE screen/section title (eyebrow + h1) for BOTH viewports
 * (Track C). Kills the drift where some screens rendered a raw <h1> with inline
 * styles, some used MobileHeader, and the desktop TopBar had yet another copy.
 *
 * Every per-screen title now flows through this so the type spec lives in one
 * place: h1 ≈ 24/700/-.02em (a `compact` flag drops to 21/600 for nested detail
 * headers like DeviceDetail / BatteryDetail). The desktop TopBar and the mobile
 * header both render through it, so titles are standardized app-wide.
 *
 * Slots:
 *  - eyebrow / title — the core pair.
 *  - back — optional leading back affordance (detail screens).
 *  - right — trailing content (avatar, weather pill, a control, etc.).
 *  - actions — alias for `right` kept for TopBar back-compat.
 * ==========================================================================*/

export interface ScreenHeaderProps {
  eyebrow?: ReactNode;
  title: ReactNode;
  /** Trailing slot (avatar / weather pill / per-screen control). */
  right?: ReactNode;
  /** Alias of `right` (TopBar called it `actions`). */
  actions?: ReactNode;
  /** Optional leading back button (detail screens). */
  onBack?: () => void;
  backLabel?: string;
  /** Smaller heading (21/600) for nested detail headers. */
  compact?: boolean;
  /** Renders the TopBar chrome (bottom border + desktop padding). */
  asTopBar?: boolean;
  /** Extra padding override (defaults match the prior inline values per context). */
  padding?: string;
  style?: CSSProperties;
  className?: string;
}

export function ScreenHeader({
  eyebrow,
  title,
  right,
  actions,
  onBack,
  backLabel = 'Back',
  compact = false,
  asTopBar = false,
  padding,
  style,
  className,
}: ScreenHeaderProps) {
  const trailing = right ?? actions;

  const h1Style: CSSProperties = compact
    ? { fontSize: 21, fontWeight: 700, letterSpacing: '-.02em', margin: 0 }
    : asTopBar
      ? { fontSize: 22, fontWeight: 600, letterSpacing: '-.01em', margin: '2px 0 0' }
      : { fontSize: 24, fontWeight: 700, letterSpacing: '-.02em', margin: '2px 0 0' };

  const pad = padding ?? (asTopBar ? '18px 28px' : '12px 18px 12px');

  return (
    <header
      className={className}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: trailing || asTopBar ? 20 : 12,
        padding: pad,
        ...(asTopBar ? { borderBottom: '1px solid var(--border-1)' } : null),
        ...style,
      }}
    >
      {onBack && (
        <button
          type="button"
          aria-label={backLabel}
          onClick={onBack}
          style={{
            display: 'grid',
            placeItems: 'center',
            width: 36,
            height: 36,
            flex: 'none',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border-2)',
            background: 'var(--surface-2)',
            color: 'var(--text-2)',
            cursor: 'pointer',
          }}
        >
          <Icon name="chevron-left" size={18} />
        </button>
      )}
      <div style={{ minWidth: 0, flex: 1 }}>
        {eyebrow != null && <Eyebrow>{eyebrow}</Eyebrow>}
        <h1 style={h1Style}>{title}</h1>
      </div>
      {trailing && (
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14, flex: 'none' }}>{trailing}</div>
      )}
    </header>
  );
}
