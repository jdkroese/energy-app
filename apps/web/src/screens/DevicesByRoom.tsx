import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import type { RoomsResponse, RoomWithCount } from '../lib/types';
import { Card, Icon } from '../components/ui';
import { useRoomDevices, type UnifiedDevice } from '../lib/useRoomDevices';
import { roomsListFetcher } from '../lib/roomsDemo';
import { RoomPicker } from '../components/RoomPicker';

/* ============================================================================
 * By-room lens — collapsible room cards, each listing that room's devices of ALL
 * types, plus an "Unassigned" card. Each room header carries "All off" and "All
 * lights off" (admin). The room shown for a device is the SAME roomId the By-type
 * views resolve. Both viewports.
 * ==========================================================================*/

/** One device row inside a room card: icon · name · kind · on/off dot · room picker · ›. */
function DeviceLine({ d, rooms, canEdit, onChanged }: {
  d: UnifiedDevice; rooms: RoomWithCount[]; canEdit: boolean; onChanged: () => void;
}) {
  const nav = useNavigate();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '9px 4px' }}>
      <span style={{ width: 28, height: 28, borderRadius: 8, display: 'grid', placeItems: 'center', background: 'var(--surface-3)', color: d.hue, flex: 'none' }}>
        <Icon name={d.icon} size={15} />
      </span>
      <button type="button" onClick={() => nav(d.href)} style={{ flex: 1, minWidth: 0, textAlign: 'left', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' }}>
        <div style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--text-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {d.name}
          {d.sensitive && <Icon name="shield-alert" size={12} color="var(--grid)" style={{ marginLeft: 6, verticalAlign: 'middle' }} />}
        </div>
        <div className="pwr-mono" style={{ fontSize: 10.5, color: 'var(--text-3)' }}>{d.kind}{d.power ? ' · on' : ''}</div>
      </button>
      <span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', background: d.power ? 'var(--solar)' : 'var(--text-disabled)', flex: 'none' }} />
      <RoomPicker deviceId={d.id} value={d.roomId} rooms={rooms} disabled={!canEdit} compact onChanged={onChanged} />
      <Icon name="chevron-right" size={15} color="var(--text-3)" />
    </div>
  );
}

/** A collapsible room card with its devices + the All-off actions in the header. */
function RoomCard({ room, devices, rooms, canEdit, defaultOpen, onChanged }: {
  room: RoomWithCount | null; devices: UnifiedDevice[]; rooms: RoomWithCount[]; canEdit: boolean; defaultOpen: boolean; onChanged: () => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [busy, setBusy] = useState<null | 'all' | 'lights'>(null);
  const isUnassigned = room === null;

  const hasLights = devices.some((d) => d.kind === 'lighting');
  const onCount = devices.filter((d) => d.power).length;

  const allOff = (scope: 'all' | 'lights') => {
    if (!room) return;
    setBusy(scope);
    void api.rooms.allOff(room.id, scope).then(onChanged).finally(() => setBusy(null));
  };

  return (
    <Card padded style={{ padding: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px' }}>
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} style={{ display: 'flex', alignItems: 'center', gap: 11, flex: 1, minWidth: 0, background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' }}>
          <span style={{ width: 34, height: 34, borderRadius: 9, display: 'grid', placeItems: 'center', background: isUnassigned ? 'var(--surface-2)' : 'var(--surface-3)', color: isUnassigned ? 'var(--text-3)' : 'var(--text-1)', flex: 'none' }}>
            <Icon name={isUnassigned ? 'inbox' : (room.icon || 'house')} size={17} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--text-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{isUnassigned ? 'Unassigned' : room.name}</div>
            <div className="pwr-mono" style={{ fontSize: 10.5, color: 'var(--text-3)', marginTop: 1 }}>
              {devices.length} device{devices.length === 1 ? '' : 's'}{onCount > 0 ? ` · ${onCount} on` : ''}
            </div>
          </div>
        </button>

        {/* Room-level All-off actions (admin, assigned rooms only). Reversible → no confirm. */}
        {canEdit && !isUnassigned && devices.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 'none' }}>
            {hasLights && (
              <button type="button" disabled={busy !== null} onClick={() => allOff('lights')} title="Switch this room's lights off"
                style={pillBtn('var(--home)')}>
                <Icon name="lightbulb-off" size={13} /> {busy === 'lights' ? '…' : 'Lights off'}
              </button>
            )}
            <button type="button" disabled={busy !== null} onClick={() => allOff('all')} title="Power off this room's devices (locks/sirens excluded)"
              style={pillBtn('var(--text-2)')}>
              <Icon name="power" size={13} /> {busy === 'all' ? '…' : 'All off'}
            </button>
          </div>
        )}
        <button type="button" onClick={() => setOpen((v) => !v)} aria-label={open ? 'Collapse' : 'Expand'} style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 2, flex: 'none' }}>
          <Icon name={open ? 'chevron-up' : 'chevron-down'} size={18} color="var(--text-3)" />
        </button>
      </div>

      {open && (
        <div style={{ padding: '2px 14px 12px' }}>
          {devices.length === 0 ? (
            <div style={{ fontSize: 12.5, color: 'var(--text-3)', padding: '6px 0' }}>No devices here yet.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {devices.map((d, i) => (
                <div key={d.id} style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border-1)' }}>
                  <DeviceLine d={d} rooms={rooms} canEdit={canEdit} onChanged={onChanged} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

const pillBtn = (hue: string) => ({
  display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 'var(--radius-pill)',
  border: `1px solid ${hue}`, background: 'transparent', color: hue, fontSize: 11.5, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' as const,
});

export function DevicesByRoom({ wide, canEdit }: { wide: boolean; canEdit: boolean }) {
  const nav = useNavigate();
  const { data: roomsData, refetch: refetchRooms } = usePolling<RoomsResponse>(roomsListFetcher, 20_000);
  const { devices, loading, refetch: refetchDevices } = useRoomDevices();
  const rooms = roomsData?.rooms ?? [];

  const onChanged = () => { refetchRooms(); refetchDevices(); };

  const byRoom = (roomId: string | null) => devices.filter((d) => (d.roomId ?? null) === roomId);
  const unassigned = byRoom(null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ fontSize: 12, color: 'var(--text-3)' }}>{rooms.length} room{rooms.length === 1 ? '' : 's'} · {devices.length} device{devices.length === 1 ? '' : 's'}</div>
        <button type="button" onClick={() => nav('/rooms')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'transparent', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-pill)', padding: '6px 12px', color: 'var(--text-2)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
          <Icon name="settings-2" size={14} /> Manage rooms
        </button>
      </div>

      {rooms.length === 0 && unassigned.length === 0 && (
        <Card padded style={{ textAlign: 'center', color: 'var(--text-3)', fontSize: 13, padding: 24 }}>
          {loading ? 'Loading…' : 'No rooms yet. Connect devices and rooms seed from their names, or add rooms in Manage.'}
        </Card>
      )}

      {rooms.map((r) => (
        <RoomCard key={r.id} room={r} devices={byRoom(r.id)} rooms={rooms} canEdit={canEdit} defaultOpen onChanged={onChanged} />
      ))}

      {unassigned.length > 0 && (
        <RoomCard room={null} devices={unassigned} rooms={rooms} canEdit={canEdit} defaultOpen={rooms.length === 0} onChanged={onChanged} />
      )}
    </div>
  );
}
