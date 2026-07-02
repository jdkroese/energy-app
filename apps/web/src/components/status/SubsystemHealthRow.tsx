import { useState } from 'react';
import { StatusDot, Icon } from '../ui';
import type { HealthState, SubsystemRollup } from '../../lib/health';
import { healthTone, isIssue } from '../../lib/health';

/* Device health matrix row (docs/36 §5.4) — one collapsible row per subsystem.
 * Header: icon + name + online/total + worst-state StatusDot. Expanded: a dense
 * wrap of per-device chips (name + StatusDot + key telemetry). Issues float to
 * the top and show even when collapsed. Rooms alphabetical within each subsystem
 * (the caller sorts `chips`). */

export interface DeviceChip {
  id: string;
  name: string;
  state: HealthState;
  /** Key telemetry line (temp/mode, brightness, position, SoC, volume). */
  telemetry?: string;
}

export interface SubsystemRowProps {
  icon: string;
  name: string;
  rollup: SubsystemRollup;
  chips: DeviceChip[];
}

function Chip({ c }: { c: DeviceChip }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        background: 'var(--surface-1)',
        border: '1px solid var(--border-1)',
        borderRadius: 8,
        padding: '5px 9px',
        fontSize: 11.5,
        maxWidth: '100%',
      }}
    >
      <StatusDot tone={healthTone(c.state)} live={c.state === 'ok'} />
      <span style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</span>
      {c.telemetry && <span className="pwr-mono" style={{ color: 'var(--text-3)', fontSize: 10.5 }}>{c.telemetry}</span>}
    </span>
  );
}

export function SubsystemHealthRow({ icon, name, rollup, chips }: SubsystemRowProps) {
  const [open, setOpen] = useState(false);
  const tone = healthTone(rollup.worst);
  const issueChips = chips.filter((c) => isIssue(c.state));
  const okChips = chips.filter((c) => !isIssue(c.state));

  return (
    <div style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '11px 13px',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
          color: 'inherit',
        }}
      >
        <Icon name={icon} size={17} color="var(--text-2)" />
        <span style={{ fontSize: 13.5, fontWeight: 600 }}>{name}</span>
        <StatusDot tone={tone} live={rollup.worst === 'ok'} />
        <span className="pwr-mono" style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--text-3)' }}>
          {rollup.online}/{rollup.total}
        </span>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={15} color="var(--text-3)" />
      </button>

      {/* Issues float to top — always visible even when collapsed. */}
      {issueChips.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '0 13px 11px' }}>
          {issueChips.map((c) => (
            <Chip key={c.id} c={c} />
          ))}
        </div>
      )}

      {/* Healthy devices only when expanded. */}
      {open && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '0 13px 12px' }}>
          {okChips.length === 0 && issueChips.length === 0 ? (
            <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>No devices.</span>
          ) : (
            okChips.map((c) => <Chip key={c.id} c={c} />)
          )}
        </div>
      )}
    </div>
  );
}
