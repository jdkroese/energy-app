import { Card, StatusDot, Icon } from '../ui';
import type { HealthState } from '../../lib/health';
import { healthTone } from '../../lib/health';

/* System health banner (docs/36 §5.1) — one-line verdict + mono counts +
 * worst-issue callout. Full-width; renders identically on both viewports. */

export interface SystemHealthBannerProps {
  worst: HealthState;
  devicesOnline: number;
  devicesTotal: number;
  subsystems: number;
  alerts: number;
  /** One-line "worst issue" summary, shown only when worst is not ok. */
  worstIssue?: string | null;
}

const VERDICT: Record<HealthState, { label: string; icon: string }> = {
  ok: { label: 'All systems nominal', icon: 'shield-check' },
  nosetup: { label: 'All systems nominal', icon: 'shield-check' },
  warning: { label: 'Warnings active', icon: 'alert-triangle' },
  offline: { label: 'Devices offline', icon: 'wifi-off' },
  error: { label: 'Errors active', icon: 'alert-octagon' },
};

export function SystemHealthBanner({
  worst,
  devicesOnline,
  devicesTotal,
  subsystems,
  alerts,
  worstIssue,
}: SystemHealthBannerProps) {
  const tone = healthTone(worst);
  const v = VERDICT[worst];
  const color =
    tone === 'solar'
      ? 'var(--solar)'
      : tone === 'grid'
        ? 'var(--grid)'
        : tone === 'danger'
          ? 'var(--danger)'
          : 'var(--text-3)';
  const wash =
    tone === 'solar'
      ? 'var(--solar-wash)'
      : tone === 'grid'
        ? 'var(--grid-wash)'
        : tone === 'danger'
          ? 'var(--danger-wash)'
          : 'var(--surface-3)';

  return (
    <Card
      accent={tone === 'solar' ? 'solar' : tone === 'grid' ? 'grid' : tone === 'danger' ? 'danger' : undefined}
      glow
      padded
      style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        {/* status pill */}
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            background: wash,
            color,
            borderRadius: 999,
            padding: '6px 13px',
            fontSize: 14,
            fontWeight: 600,
          }}
        >
          <Icon name={v.icon} size={16} />
          <StatusDot tone={tone === 'danger' ? 'danger' : tone === 'grid' ? 'grid' : tone === 'solar' ? 'solar' : 'offline'} live>
            {v.label}
          </StatusDot>
        </span>
        {/* counts */}
        <span
          className="pwr-mono"
          style={{ marginLeft: 'auto', fontSize: 12.5, color: 'var(--text-2)' }}
        >
          {devicesOnline} / {devicesTotal} devices online · {subsystems} subsystems ·{' '}
          {alerts} alert{alerts === 1 ? '' : 's'}
        </span>
      </div>
      {worst !== 'ok' && worst !== 'nosetup' && worstIssue && (
        <div style={{ fontSize: 12.5, color: 'var(--text-2)', display: 'flex', alignItems: 'center', gap: 7 }}>
          <Icon name="alert-circle" size={14} color={color} />
          {worstIssue}
        </div>
      )}
    </Card>
  );
}
