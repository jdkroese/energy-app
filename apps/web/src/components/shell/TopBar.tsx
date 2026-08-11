import type { ReactNode } from 'react';
import { Icon, ScreenHeader } from '../ui';
import { ThemeToggle } from './ThemeToggle';

type Props = {
  eyebrow: string;
  title: string;
  actions?: ReactNode;
};

/**
 * TopBar — desktop per-screen header. Now renders through the shared
 * <ScreenHeader> (Track C) so screen titles have ONE source of truth across both
 * viewports (the mobile MobileHeader wraps the same component).
 *
 * The parallel `theme-toggle` PR's compact sun/moon <ThemeToggle /> is integrated
 * into the trailing cluster, just before the weather pill (same position it had
 * before the header was consolidated).
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
          <ThemeToggle />
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 12px',
              borderRadius: 'var(--radius-pill)',
              background: 'var(--surface-1)',
              border: '1px solid var(--border-1)',
              fontSize: 'var(--fs-sm)',
              color: 'var(--text-2)',
            }}
          >
            <Icon name="sun" size={16} color="var(--grid)" />
            <span style={{ fontFamily: 'var(--font-mono)' }}>26°</span>
            <span style={{ color: 'var(--text-3)' }}>· Jávea</span>
          </div>
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
            }}
          >
            JK
          </div>
        </>
      }
    />
  );
}
