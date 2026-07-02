import { Card, StatusDot, Eyebrow, Icon } from '../ui';
import type { LiveResponse, VoltageMonitor } from '../../lib/types';

/* Grid quality (docs/36 §5.6) — live breaker voltage vs [minV,maxV] band with an
 * in-band / out-of-band StatusDot. Ties to the recurring Spain grid over-voltage
 * → Sonnen trip issue. Only render when a voltage-capable breaker exists (caller
 * checks live.breaker present). */

export function GridQualityCard({ live, monitor }: { live: LiveResponse; monitor?: VoltageMonitor }) {
  const breaker = live.breaker;
  if (!breaker) return null;

  const v = breaker.voltageV;
  const minV = monitor?.minV ?? 207;
  const maxV = monitor?.maxV ?? 253;
  const inBand = v >= minV && v <= maxV;
  const over = v > maxV;

  return (
    <Card padded style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <Eyebrow>Grid quality</Eyebrow>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
            <span className="pwr-mono" style={{ fontSize: 26, fontWeight: 700, color: inBand ? 'var(--text-1)' : 'var(--danger)' }}>
              {v.toFixed(1)}
            </span>
            <span style={{ fontSize: 13, color: 'var(--text-3)' }}>V</span>
          </div>
          <StatusDot tone={inBand ? 'solar' : 'danger'} live>
            <span style={{ fontSize: 11.5, color: 'var(--text-2)' }}>
              {inBand ? 'In band' : over ? 'Over-voltage' : 'Under-voltage'} · {minV}–{maxV} V
            </span>
          </StatusDot>
        </div>
        <span className="pwr-mono" style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--text-3)' }}>
          {breaker.name} · {breaker.currentA.toFixed(1)} A · {(breaker.powerW / 1000).toFixed(2)} kW
        </span>
      </div>
      {over && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: 'var(--text-2)', background: 'var(--danger-wash)', borderRadius: 'var(--radius-md)', padding: '9px 12px' }}>
          <Icon name="alert-triangle" size={14} color="var(--danger)" />
          Grid voltage above {maxV} V — the Sonnen can trip on over-voltage. A full mains power-cycle usually clears it.
        </div>
      )}
    </Card>
  );
}
