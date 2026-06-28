import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import type { RoomsResponse, RoomWithCount } from '../lib/types';
import { Card, Icon, Button } from '../components/ui';
import { MobileHeader, Avatar, StaleBanner } from './_shared';
import { useAuth } from '../auth/AuthProvider';
import type { ShellContext } from '../components/shell/AppShell';
import { useRoomDevices } from '../lib/useRoomDevices';
import { roomsListFetcher } from '../lib/roomsDemo';
import { RoomPicker } from '../components/RoomPicker';

/* ============================================================================
 * Manage rooms — create / rename / delete rooms (+ icon pick), plus a
 * quick-bin "Unassigned" list with one-tap "Assign to…" per device. Reachable from
 * Settings → Rooms AND the "Manage" affordance on the By-room lens. Both viewports.
 * ==========================================================================*/

/** A small palette of room icons (Lucide names available in the Icon set). */
const ROOM_ICONS = [
  'home', 'sofa', 'bed', 'cooking-pot', 'bath', 'briefcase', 'door-open', 'car',
  'tree-palm', 'baby', 'tv', 'lamp', 'utensils', 'wash-machine', 'dumbbell', 'warehouse',
];

function IconPicker({ value, onPick }: { value: string; onPick: (icon: string) => void }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {ROOM_ICONS.map((ic) => {
        const on = ic === value;
        return (
          <button
            key={ic}
            type="button"
            aria-label={`Icon ${ic}`}
            aria-pressed={on}
            onClick={() => onPick(ic)}
            style={{
              width: 36, height: 36, display: 'grid', placeItems: 'center', borderRadius: 'var(--radius-md)',
              border: on ? '1px solid var(--solar)' : '1px solid var(--border-2)',
              background: on ? 'var(--solar-wash)' : 'var(--surface-2)',
              color: on ? 'var(--solar)' : 'var(--text-2)', cursor: 'pointer',
            }}
          >
            <Icon name={ic} size={17} />
          </button>
        );
      })}
    </div>
  );
}

/** One editable room row: icon, (inline-editable) name, delete. Rooms always render
 *  alphabetically, so there's no manual reorder. */
function RoomRow({ room, first, canEdit, onChanged }: {
  room: RoomWithCount; first: boolean; canEdit: boolean; onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(room.name);
  const [iconOpen, setIconOpen] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [busy, setBusy] = useState(false);

  const save = (patch: { name?: string; icon?: string }) => {
    setBusy(true);
    void api.rooms.update(room.id, patch).then(onChanged).finally(() => setBusy(false));
  };
  const del = () => { setBusy(true); void api.rooms.remove(room.id).then(onChanged).finally(() => setBusy(false)); };

  return (
    <div style={{ borderTop: first ? 'none' : '1px solid var(--border-1)', padding: '11px 14px', display: 'flex', flexDirection: 'column', gap: iconOpen ? 10 : 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
        <button type="button" disabled={!canEdit} aria-label="Change icon" onClick={() => setIconOpen((v) => !v)}
          style={{ width: 34, height: 34, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'var(--surface-3)', color: 'var(--text-1)', border: 'none', cursor: canEdit ? 'pointer' : 'default', flex: 'none' }}>
          <Icon name={room.icon || 'home'} size={17} />
        </button>

        {editing ? (
          <input
            autoFocus value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { save({ name }); setEditing(false); } if (e.key === 'Escape') { setName(room.name); setEditing(false); } }}
            onBlur={() => { if (name.trim() && name !== room.name) save({ name }); setEditing(false); }}
            className="pwr-input" style={{ flex: 1, minWidth: 0, height: 34 }}
          />
        ) : (
          <button type="button" disabled={!canEdit} onClick={() => setEditing(true)} style={{ flex: 1, minWidth: 0, textAlign: 'left', background: 'transparent', border: 'none', cursor: canEdit ? 'pointer' : 'default', padding: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-1)' }}>{room.name}</div>
            <div className="pwr-mono" style={{ fontSize: 10.5, color: 'var(--text-3)', marginTop: 1 }}>{room.deviceCount} device{room.deviceCount === 1 ? '' : 's'}</div>
          </button>
        )}

        {canEdit && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, opacity: busy ? 0.5 : 1 }}>
            {confirmDel ? (
              <span style={{ display: 'inline-flex', gap: 4 }}>
                <button type="button" aria-label="Confirm delete" onClick={del} style={{ ...iconBtn(false), border: '1px solid var(--danger)', color: 'var(--danger)' }}><Icon name="check" size={16} /></button>
                <button type="button" aria-label="Cancel delete" onClick={() => setConfirmDel(false)} style={iconBtn(false)}><Icon name="x" size={16} /></button>
              </span>
            ) : (
              <button type="button" aria-label="Delete room" onClick={() => setConfirmDel(true)} style={{ ...iconBtn(false), color: 'var(--text-3)' }}><Icon name="trash-2" size={15} /></button>
            )}
          </div>
        )}
      </div>

      {iconOpen && canEdit && (
        <IconPicker value={room.icon} onPick={(ic) => { save({ icon: ic }); setIconOpen(false); }} />
      )}
      {confirmDel && (
        <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 8 }}>
          Delete “{room.name}”? Its {room.deviceCount} device{room.deviceCount === 1 ? '' : 's'} will become Unassigned.
        </div>
      )}
    </div>
  );
}

const iconBtn = (off: boolean) => ({
  width: 30, height: 30, display: 'grid', placeItems: 'center', borderRadius: 'var(--radius-md)',
  border: '1px solid var(--border-2)', background: 'var(--surface-2)',
  color: off ? 'var(--text-disabled)' : 'var(--text-2)', cursor: off ? 'default' : 'pointer', flex: 'none' as const,
});

function CreateRoom({ onChanged }: { onChanged: () => void }) {
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('home');
  const [busy, setBusy] = useState(false);
  const create = () => {
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    void api.rooms.create(n, icon).then(() => { setName(''); setIcon('home'); onChanged(); }).finally(() => setBusy(false));
  };
  return (
    <Card padded style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="pwr-eyebrow">Add a room</div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') create(); }}
          placeholder="Room name" className="pwr-input" style={{ flex: 1, minWidth: 0, height: 38 }} />
        <Button variant="primary" size="md" disabled={busy || !name.trim()} onClick={create} iconLeft={<Icon name="plus" size={15} />}>Add</Button>
      </div>
      <IconPicker value={icon} onPick={setIcon} />
    </Card>
  );
}

export function RoomsManage({ ctx }: { ctx: ShellContext }) {
  const nav = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const wide = ctx.desktop;

  const { data, loading, stale, updatedAt, refetch } = usePolling<RoomsResponse>(roomsListFetcher, 20_000);
  const { devices, refetch: refetchDevices } = useRoomDevices();
  const rooms: RoomWithCount[] = data?.rooms ?? [];
  const unassigned = devices.filter((d) => !d.roomId);

  const onChanged = () => { refetch(); refetchDevices(); };

  const body = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {stale && <StaleBanner updatedAt={updatedAt} />}

      {isAdmin && <CreateRoom onChanged={onChanged} />}

      <Card title="Rooms" style={{ padding: 0 }}>
        {rooms.length === 0 ? (
          <div style={{ padding: 22, textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>
            {loading ? 'Loading…' : 'No rooms yet. Add one above — or connect devices and rooms seed automatically from their names.'}
          </div>
        ) : (
          rooms.map((r, i) => (
            <RoomRow key={r.id} room={r} first={i === 0} canEdit={isAdmin} onChanged={onChanged} />
          ))
        )}
      </Card>

      {/* Quick-bin: Unassigned devices with one-tap Assign to… */}
      <Card title={`Unassigned · ${unassigned.length}`} style={{ padding: 0 }}>
        {unassigned.length === 0 ? (
          <div style={{ padding: 22, textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>Every device has a room. Nice.</div>
        ) : (
          unassigned.map((d, i) => (
            <div key={d.id} style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border-1)', padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 11 }}>
              <span style={{ width: 30, height: 30, borderRadius: 8, display: 'grid', placeItems: 'center', background: 'var(--surface-3)', color: d.hue, flex: 'none' }}><Icon name={d.icon} size={16} /></span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--text-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</div>
                <div className="pwr-mono" style={{ fontSize: 10.5, color: 'var(--text-3)' }}>{d.kind}</div>
              </div>
              <RoomPicker deviceId={d.id} value={null} rooms={rooms} disabled={!isAdmin} compact onChanged={onChanged} />
            </div>
          ))
        )}
      </Card>

      <Button variant="ghost" size="sm" onClick={() => nav('/devices')} iconLeft={<Icon name="arrow-left" size={15} />}>Back to devices</Button>
    </div>
  );

  if (wide) return <div style={{ display: 'flex', flexDirection: 'column', gap: 16, width: '100%' }}>{body}</div>;
  return (
    <>
      <MobileHeader eyebrow="Home" title="Rooms" right={<Avatar />} />
      <div style={{ padding: '8px 14px 22px' }}>{body}</div>
    </>
  );
}
