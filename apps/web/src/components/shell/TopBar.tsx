import type { ReactNode } from 'react';
import { Icon, ScreenHeader } from '../ui';
import { ThemeToggle } from './ThemeToggle';
import { api } from '../../lib/api';
import { usePolling } from '../../lib/usePolling';

type Props = {
  eyebrow: string;
  title: string;
  actions?: ReactNode;
};

// Current conditions barely change minute to minute — poll gently so the pill
// stays fresh without hammering the Open-Meteo passthrough.
const WEATHER_POLL_MS = 5 * 60_000;

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
  // Fail-soft: temperatureC/windSpeedKmh are null when the upstream fetch
  // failed (or hasn't resolved yet), so the pill falls back to the site name
  // alone rather than showing a fake reading — same convention getForecast()'s
  // other callers use.
  const { data: weather } = usePolling(api.weatherCurrent, WEATHER_POLL_MS);
  const temp = weather?.temperatureC;
  const wind = weather?.windSpeedKmh;

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
            {temp != null && <span style={{ fontFamily: 'var(--font-mono)' }}>{Math.round(temp)}°</span>}
            <span style={{ color: 'var(--text-3)' }}>
              · Jávea{wind != null ? ` · ${Math.round(wind)} km/h` : ''}
            </span>
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
