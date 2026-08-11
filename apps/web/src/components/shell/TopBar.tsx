import type { ReactNode } from 'react';
import { Icon, ScreenHeader } from '../ui';
import { ThemeToggle } from './ThemeToggle';
import { EditToggle } from './EditToggle';

type Props = {
  eyebrow: string;
  title: string;
  actions?: ReactNode;
};

/**
 * TopBar — desktop per-screen header. Renders through the shared <ScreenHeader>
 * (Track C) so screen titles have ONE source of truth across both viewports
 * (the mobile MobileHeader wraps the same component).
 *
 * Trailing cluster is one line, always: per-screen `actions` (a SegmentedControl
 * on some screens), the weather pill, then a pair of circular utility buttons
 * (edit · theme) plus the avatar — mirroring a dense toolbar reference the owner
 * shared. ScreenHeader's title truncates instead of wrapping, so this row can't
 * spill onto a second line even with a long title + actions both present.
 */
export function TopBar({ eyebrow, title, actions }: Props) {
  return (
    <ScreenHeader
      asTopBar
      eyebrow={eyebrow}
      title={title}
      right={
        <>
          {actions}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '5px 14px 5px 5px',
              borderRadius: 'var(--radius-pill)',
              background: 'var(--surface-1)',
              border: '1px solid var(--border-1)',
              flex: 'none',
            }}
          >
            <span
              style={{
                display: 'grid',
                placeItems: 'center',
                width: 28,
                height: 28,
                borderRadius: '50%',
                background: 'var(--grid-wash)',
                flex: 'none',
              }}
            >
              <Icon name="sun" size={15} color="var(--grid)" />
            </span>
            <div style={{ lineHeight: 1.25 }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)', fontWeight: 600, color: 'var(--text-1)' }}>26°</div>
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-3)' }}>Jávea</div>
            </div>
          </div>
          <EditToggle />
          <ThemeToggle />
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: '50%',
              background: 'linear-gradient(135deg,var(--solar-dim),var(--battery-dim))',
              display: 'grid',
              placeItems: 'center',
              fontWeight: 700,
              fontSize: 'var(--fs-sm)',
              color: 'var(--text-inverse)',
              flex: 'none',
            }}
          >
            JK
          </div>
        </>
      }
    />
  );
}
