import { useEffect, useState, type ReactNode } from 'react';
import { ScreenHeader } from '../ui';
import { ThemeToggle } from './ThemeToggle';
import { WeatherPill } from './WeatherPill';
import { WaterPill } from './WaterPill';

/**
 * Live clock pill — a 6 px breathing solar dot beside the wall time. It is the
 * cheapest possible proof that the page in front of you is live and not a stale
 * tab left open overnight (docs/53).
 */
function ClockPill() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 20_000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <span className="pwr-badge pwr-badge--soft" data-tone="solar" style={{ gap: 7 }}>
      <i
        aria-hidden
        style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--solar)', boxShadow: '0 0 8px var(--solar)', animation: 'v2breathe 2.2s var(--ease-in-out) infinite' }}
      />
      {now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
    </span>
  );
}

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
          <ClockPill />
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
