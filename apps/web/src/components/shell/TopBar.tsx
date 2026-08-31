import type { ReactNode } from 'react';
import { ScreenHeader } from '../ui';
import { ThemeToggle } from './ThemeToggle';
import { WeatherPill } from './WeatherPill';
import { WaterPill } from './WaterPill';

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
 * before the header was consolidated). The water pill sits right after the
 * weather pill — "live consumption next to the weather" per the owner's ask —
 * and renders nothing until the meter is configured.
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
          <WeatherPill />
          <WaterPill />
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
