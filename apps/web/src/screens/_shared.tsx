import type { ReactNode } from 'react';
import { ScreenHeader } from '../components/ui';
import { ThemeToggle } from '../components/shell/ThemeToggle';

/**
 * Mobile screen header (eyebrow + h1), matching the *-mobile mockups.
 * Thin wrapper over the shared <ScreenHeader> so titles are standardized
 * app-wide (Track C). Kept `md:hidden` so the desktop TopBar owns the title on
 * wide layouts.
 */
export function MobileHeader({ eyebrow, title, right }: { eyebrow: ReactNode; title: string; right?: ReactNode }) {
  // Integrate the theme-toggle PR's sun/moon control into the standardized
  // header (it sits just before the screen-supplied `right` slot, as before).
  return (
    <ScreenHeader
      className="md:hidden"
      eyebrow={eyebrow}
      title={title}
      right={
        <>
          <ThemeToggle />
          {right}
        </>
      }
    />
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

