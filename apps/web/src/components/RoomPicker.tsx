import { useState } from 'react';
import { api } from '../lib/api';
import type { RoomWithCount } from '../lib/types';
import { Icon } from './ui';

/* ============================================================================
 * RoomPicker — assign a device to a room (cross-cutting Rooms model). A native
 * select of the existing rooms plus "Unassigned" and a "+ New room…" option that
 * reveals an inline name field, creating + assigning the room without leaving the
 * surface. Used on every device detail page AND inline on cards/rows.
 *
 * Self-contained: takes the deviceId + current value + known rooms, performs the
 * write itself, and calls onChanged() after a successful assign/create so the caller
 * refetches. `disabled` (non-admin) renders a read-only label.
 * ==========================================================================*/

const NEW = '__new__';
const UNASSIGNED = '';

export function RoomPicker({
  deviceId, value, rooms, disabled, compact, onChanged,
}: {
  deviceId: string;
  value: string | null;
  rooms: RoomWithCount[];
  disabled?: boolean;
  /** Tighter styling for inline use on a card/row. */
  compact?: boolean;
  /** Called after a successful assign/create so the caller refetches rooms + devices. */
  onChanged: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const current = value ? rooms.find((r) => r.id === value) ?? null : null;

  if (disabled) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: compact ? 11.5 : 13, color: 'var(--text-2)' }}>
        <Icon name={current?.icon ?? 'home'} size={compact ? 13 : 14} color="var(--text-3)" />
        {current?.name ?? 'Unassigned'}
      </span>
    );
  }

  const assign = (roomId: string | null) => {
    setBusy(true);
    void api.devices.setRoom(deviceId, roomId).then(onChanged).finally(() => setBusy(false));
  };

  const createAndAssign = () => {
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    void api.rooms
      .create(n, 'home')
      .then((res) => api.devices.setRoom(deviceId, res.room.id))
      .then(() => { setCreating(false); setName(''); onChanged(); })
      .finally(() => setBusy(false));
  };

  const onSelect = (v: string) => {
    if (v === NEW) { setCreating(true); return; }
    assign(v === UNASSIGNED ? null : v);
  };

  const selectH = compact ? 30 : 36;

  if (creating) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') createAndAssign(); if (e.key === 'Escape') { setCreating(false); setName(''); } }}
          placeholder="Room name"
          className="pwr-input"
          style={{ height: selectH, fontSize: compact ? 12 : 13, minWidth: 0, width: compact ? 120 : 160 }}
        />
        <button type="button" aria-label="Create room" disabled={busy || !name.trim()} onClick={createAndAssign}
          style={{ height: selectH, width: selectH, display: 'grid', placeItems: 'center', borderRadius: 'var(--radius-md)', border: '1px solid var(--solar)', background: 'var(--solar-wash)', color: 'var(--solar)', cursor: name.trim() ? 'pointer' : 'default', flex: 'none' }}>
          <Icon name="check" size={15} />
        </button>
        <button type="button" aria-label="Cancel" onClick={() => { setCreating(false); setName(''); }}
          style={{ height: selectH, width: selectH, display: 'grid', placeItems: 'center', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-2)', background: 'var(--surface-2)', color: 'var(--text-3)', cursor: 'pointer', flex: 'none' }}>
          <Icon name="x" size={15} />
        </button>
      </span>
    );
  }

  return (
    <div className="pwr-select-wrap" style={{ minWidth: compact ? 130 : 170, opacity: busy ? 0.6 : 1 }}>
      <select
        className="pwr-select"
        value={value ?? UNASSIGNED}
        disabled={busy}
        onChange={(e) => onSelect(e.target.value)}
        style={{ height: selectH, fontSize: compact ? 12 : 13 }}
        aria-label="Assign room"
      >
        <option value={UNASSIGNED}>Unassigned</option>
        {rooms.map((r) => (
          <option key={r.id} value={r.id}>{r.name}</option>
        ))}
        <option value={NEW}>+ New room…</option>
      </select>
      <span className="pwr-select__chev">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
      </span>
    </div>
  );
}
