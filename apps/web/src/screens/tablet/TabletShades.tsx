import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import type { BlindLever, BlindUnit, BlindsResponse } from '../../lib/types';
import { Icon, Slider, EmptyState } from '../../components/ui';

/* ============================================================================
 * TabletShades — wall-tablet blinds screen. Big tiles grouped by room
 * (alphabetical, Unassigned last): name, state, fat Open / Stop / Close buttons,
 * and a position slider when the motor reports a settable target. Reuses the
 * phone/desktop Blinds optimistic override (buttons fire now, the slider
 * debounces 300ms). Calm empty/disconnected states.
 * ==========================================================================*/

const sortByName = <T extends { name: string }>(xs: T[]): T[] =>
  [...xs].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

function groupByRoom(blinds: BlindUnit[]): { room: string; items: BlindUnit[] }[] {
  const map = new Map<string, BlindUnit[]>();
  for (const b of blinds) {
    const room = (b.roomName || b.room || '').trim() || 'Unassigned';
    if (!map.has(room)) map.set(room, []);
    map.get(room)!.push(b);
  }
  const rooms = [...map.keys()].sort((a, b) => {
    if (a === 'Unassigned') return 1;
    if (b === 'Unassigned') return -1;
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  });
  return rooms.map((room) => ({ room, items: sortByName(map.get(room)!) }));
}

export function TabletShades() {
  const { data, refetch } = usePolling<BlindsResponse>(api.blinds.list, 15_000);

  // Optimistic position override keyed by blind id (open=100, close=0, slider=value).
  const [override, setOverride] = useState<Record<string, number>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const send = (id: string, lever: BlindLever, value?: number) => {
    const optimistic = lever === 'open' ? 100 : lever === 'close' ? 0 : lever === 'position' ? value : undefined;
    if (typeof optimistic === 'number') setOverride((o) => ({ ...o, [id]: optimistic }));
    clearTimeout(timers.current[id]);
    const fire = () => {
      api.blinds
        .command(id, lever, value)
        .then(() => setTimeout(() => refetch(), 1500))
        .catch(() =>
          setOverride((o) => {
            const n = { ...o };
            delete n[id];
            return n;
          }),
        );
    };
    if (lever === 'position') timers.current[id] = setTimeout(fire, 300);
    else fire();
  };

  // Drop an override once a poll shows the motor settled near the target.
  useEffect(() => {
    if (!data) return;
    setOverride((prev) => {
      if (Object.keys(prev).length === 0) return prev;
      const next = { ...prev };
      let changed = false;
      for (const b of data.devices) {
        if (b.id in next && !b.moving && b.positionPct != null && Math.abs(b.positionPct - next[b.id]) <= 2) {
          delete next[b.id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [data]);

  const withOverride = (b: BlindUnit): BlindUnit =>
    b.id in override ? { ...b, positionPct: override[b.id] } : b;

  const groups = useMemo(() => groupByRoom(data?.devices ?? []), [data]);
  const empty = data && data.devices.length === 0;

  return (
    <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 20 }}>
      {empty && <Calm icon="blinds" title="No shades" subtitle="No blinds or curtains were found on this account." />}
      {(!data || data.devices.length > 0) && groups.map(({ room, items }) => (
        <section key={room} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--text-2)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>{room}</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 }}>
            {items.map((raw) => <ShadeTile key={raw.id} b={withOverride(raw)} onCmd={send} />)}
          </div>
        </section>
      ))}
    </div>
  );
}

function stateText(b: BlindUnit): string {
  if (!b.online) return 'Offline';
  if (b.moving) return 'Moving…';
  if (b.positionPct == null) return '—';
  if (b.positionPct <= 1) return 'Closed';
  if (b.positionPct >= 99) return 'Open';
  return `${Math.round(b.positionPct)}% open`;
}

function ShadeTile({ b, onCmd }: { b: BlindUnit; onCmd: (id: string, lever: BlindLever, value?: number) => void }) {
  const open = (b.positionPct ?? 0) > 1;
  return (
    <div style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-lg)', padding: 16, display: 'flex', flexDirection: 'column', gap: 14, opacity: b.online ? 1 : 0.55 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <span style={{ width: 48, height: 48, borderRadius: 14, flex: 'none', display: 'grid', placeItems: 'center', background: open ? 'var(--home-wash)' : 'var(--surface-3)', color: open ? 'var(--home)' : 'var(--text-3)' }}>
          <Icon name="blinds" size={24} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--text-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.name}</div>
          <div style={{ fontSize: 13, color: 'var(--text-3)' }}>{stateText(b)}</div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <BlindBtn icon="chevron-up" label="Open" disabled={!b.online} onClick={() => onCmd(b.id, 'open')} />
        <BlindBtn icon="square" label="Stop" disabled={!b.online} onClick={() => onCmd(b.id, 'stop')} />
        <BlindBtn icon="chevron-down" label="Close" disabled={!b.online} onClick={() => onCmd(b.id, 'close')} />
      </div>

      {b.online && b.supportsPosition && b.positionPct != null && (
        <Slider label="Position" min={0} max={100} unit="%" value={b.positionPct} onChange={(v) => onCmd(b.id, 'position', v)} />
      )}
    </div>
  );
}

function BlindBtn({ icon, label, disabled, onClick }: { icon: string; label: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{
        flex: 1,
        minHeight: 52,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 2,
        border: '1px solid var(--border-2)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--surface-3)',
        color: disabled ? 'var(--text-3)' : 'var(--text-1)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        fontSize: 12,
        fontWeight: 600,
      }}
    >
      <Icon name={icon} size={20} />
      <span>{label}</span>
    </button>
  );
}

function Calm({ icon, title, subtitle }: { icon: string; title: string; subtitle: string }) {
  return (
    <div style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-lg)' }}>
      <EmptyState icon={icon} title={title} subtitle={subtitle} />
    </div>
  );
}
