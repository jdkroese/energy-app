import { Card, Icon, Eyebrow } from '../components/ui';

/** Batteries — fast-follow (not yet designed). Placeholder per docs/11 §0. */
export function Batteries() {
  return (
    <div style={{ padding: '12px 18px 22px', maxWidth: 760, margin: '0 auto', width: '100%' }}>
      <Eyebrow>Batteries</Eyebrow>
      <h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-.02em', margin: '2px 0 16px' }}>Sonnen + Tesla</h1>
      <Card accent="battery" style={{ padding: 24, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, textAlign: 'center' }}>
        <span style={{ width: 48, height: 48, borderRadius: 12, display: 'grid', placeItems: 'center', background: 'var(--battery-wash)', color: 'var(--battery)' }}>
          <Icon name="battery-charging" size={24} />
        </span>
        <div style={{ fontSize: 16, fontWeight: 600 }}>Battery detail coming soon</div>
        <div style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5, maxWidth: 360 }}>
          Per-battery SoC history, charge/discharge cycles, and health for the Sonnen and the two Powerwall 3 units land in a fast-follow release.
        </div>
      </Card>
    </div>
  );
}
