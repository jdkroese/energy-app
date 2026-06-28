import { Icon } from '../ui';
import type { TimeAnchor } from '../../lib/types';
import type { CSSProperties } from 'react';

const stepBtn: CSSProperties = {
  display: 'grid', placeItems: 'center', width: 28, height: 28,
  borderRadius: 7, border: '1px solid var(--border-2)',
  background: 'var(--surface-1)', color: 'var(--text-2)', cursor: 'pointer',
};

export function AnchorPicker({ value, onChange }: { value: TimeAnchor; onChange: (a: TimeAnchor) => void }) {
  const opts: { v: TimeAnchor; label: string }[] = [
    { v: 'fixed', label: 'Time' },
    { v: 'sunrise', label: 'Sunrise' },
    { v: 'sunset', label: 'Sunset' },
  ];
  return (
    <div style={{ display: 'flex', gap: 3, background: 'var(--surface-2)', border: '1px solid var(--border-1)', borderRadius: 8, padding: 3 }}>
      {opts.map((o) => {
        const on = value === o.v;
        return (
          <button key={o.v} type="button" onClick={() => onChange(o.v)}
            style={{ padding: '4px 7px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: on ? 700 : 500, background: on ? 'var(--surface-3)' : 'transparent', color: on ? 'var(--solar)' : 'var(--text-3)', whiteSpace: 'nowrap' }}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function OffsetStepper({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const STEP = 5, MIN = -180, MAX = 180;
  const clamp = (v: number) => Math.min(MAX, Math.max(MIN, Math.round(v / STEP) * STEP));
  const disp = value === 0 ? '± 0 min' : value > 0 ? `+ ${value} min` : `− ${Math.abs(value)} min`;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1 }}>
      <button type="button" aria-label="Decrease offset" onClick={() => onChange(clamp(value - STEP))} style={stepBtn}><Icon name="minus" size={13} /></button>
      <span className="pwr-mono" style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-2)', flex: 1, textAlign: 'center' }}>{disp}</span>
      <button type="button" aria-label="Increase offset" onClick={() => onChange(clamp(value + STEP))} style={stepBtn}><Icon name="plus" size={13} /></button>
    </div>
  );
}

/** Short label for a time field, e.g. "18:00", "Sunrise", "Sunset+30m" */
export function anchorLabel(hhmm: string, anchor?: TimeAnchor, offsetMin?: number): string {
  if (!anchor || anchor === 'fixed') return hhmm;
  const base = anchor === 'sunrise' ? 'Sunrise' : 'Sunset';
  const off = offsetMin ?? 0;
  if (off === 0) return base;
  return off > 0 ? `${base}+${off}m` : `${base}${off}m`;
}
