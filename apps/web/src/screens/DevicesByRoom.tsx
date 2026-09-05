import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import type { RoomsResponse, RoomWithCount } from '../lib/types';
import { Badge, Card, Eyebrow, Button, Icon } from '../components/ui';
import { useRoomDevices, type UnifiedDevice } from '../lib/useRoomDevices';
import { roomsListFetcher } from '../lib/roomsDemo';
import { RoomPicker } from '../components/RoomPicker';
import { useMediaQuery } from '../components/shell/useMediaQuery';

/* ============================================================================
 * Rooms (V2, docs/53) — the house by room, then straight to a device.
 *
 * A summary line with the two whole-house actions, a grid of room cards (each a
 * button), and one device panel below that swaps to the selected room. Picking a
 * room is a SELECTION, not a navigation: the card lifts 2 px, takes a solar
 * border and a soft glow, and the panel underneath changes — so the two halves
 * of the screen visibly belong together.
 * ==========================================================================*/

/** Room accent hues, assigned by position so a room keeps its colour. */
const ROOM_TONES = ['home', 'grid', 'battery', 'solar', 'water', 'ev'] as const;
type RoomTone = (typeof ROOM_TONES)[number];

const KIND_LABEL: Record<UnifiedDevice['kind'], string> = {
  cooling: 'cooling',
  heating: 'heating',
  lighting: 'light',
  blinds: 'blind',
  switching: 'switch',
};

interface RoomView {
  room: RoomWithCount | null;
  key: string;
  name: string;
  icon: string;
  tone: RoomTone;
  devices: UnifiedDevice[];
  onCount: number;
  lights: number;
  lightsOn: number;
  tempC: number | null;
}

/** The 38×22 switch pill from the design — the knob springs, the track glows. */
function SwitchPill({ on, disabled, pending, onToggle, label }: {
  on: boolean;
  disabled: boolean;
  pending: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      style={{
        all: 'unset',
        boxSizing: 'border-box',
        width: 38,
        height: 22,
        flex: 'none',
        position: 'relative',
        borderRadius: 999,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : pending ? 0.7 : 1,
        background: on ? 'var(--solar)' : 'var(--surface-4)',
        boxShadow: on ? '0 0 12px var(--solar)' : 'none',
        transition: 'background .2s var(--ease-out), opacity .15s var(--ease-out)',
      }}
    >
      <i
        style={{
          position: 'absolute',
          top: 3,
          left: on ? 19 : 3,
          width: 16,
          height: 16,
          borderRadius: '50%',
          background: on ? 'var(--accent-contrast)' : 'var(--text-3)',
          transition: 'left .2s var(--ease-spring)',
        }}
      />
    </button>
  );
}

function DeviceRow({ d, canEdit, rooms, onChanged }: {
  d: UnifiedDevice;
  canEdit: boolean;
  rooms: RoomWithCount[];
  onChanged: () => void;
}) {
  const nav = useNavigate();
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const on = optimistic ?? d.power;

  const flip = () => {
    if (!d.toggle || busy) return;
    const next = !on;
    setOptimistic(next);
    setBusy(true);
    void d
      .toggle(next)
      .then(() => window.setTimeout(onChanged, 1200))
      .catch(() => setOptimistic(null))
      .finally(() => setBusy(false));
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '13px 14px', borderRadius: 'var(--radius-md)', background: 'var(--surface-2)', border: '1px solid var(--border-1)' }}>
      <span style={{ width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'var(--surface-3)', color: d.hue, flex: 'none' }}>
        <Icon name={d.icon} size={16} />
      </span>
      <button
        type="button"
        onClick={() => nav(d.href)}
        style={{ all: 'unset', cursor: 'pointer', minWidth: 0, flex: 1 }}
      >
        <div style={{ fontSize: 13.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {d.name}
          {d.sensitive && <Icon name="shield-alert" size={12} color="var(--grid)" style={{ marginLeft: 6, verticalAlign: 'middle' }} />}
        </div>
        <div className="pwr-mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>
          {KIND_LABEL[d.kind]}
          {d.tempC != null ? ` · ${d.tempC.toFixed(1)}°` : ''} · {on ? 'on' : 'off'}
        </div>
      </button>
      {canEdit && <RoomPicker deviceId={d.id} value={d.roomId} rooms={rooms} disabled={!canEdit} compact onChanged={onChanged} />}
      {d.toggle ? (
        <SwitchPill on={on} disabled={!canEdit} pending={busy} onToggle={flip} label={`Turn ${d.name} ${on ? 'off' : 'on'}`} />
      ) : (
        <Icon name="chevron-right" size={16} color="var(--text-3)" />
      )}
    </div>
  );
}

export function DevicesByRoom({ wide, canEdit }: { wide: boolean; canEdit: boolean }) {
  const nav = useNavigate();
  const roomy = useMediaQuery('(min-width: 1180px)');
  const { data: roomsData, refetch: refetchRooms } = usePolling<RoomsResponse>(roomsListFetcher, 20_000);
  const { devices, loading, refetch: refetchDevices } = useRoomDevices();
  const rooms = roomsData?.rooms ?? [];
  const [busyAll, setBusyAll] = useState<null | 'all' | 'lights'>(null);

  const onChanged = () => {
    refetchRooms();
    refetchDevices();
  };

  // Rooms are always listed alphabetically (standing rule), which also keeps each
  // room's accent hue stable as the fleet grows.
  const views = useMemo<RoomView[]>(() => {
    const sorted = [...rooms].sort((a, b) => a.name.localeCompare(b.name));
    const mk = (room: RoomWithCount | null, i: number): RoomView => {
      const list = devices.filter((d) => (d.roomId ?? null) === (room?.id ?? null));
      const lights = list.filter((d) => d.kind === 'lighting');
      const temps = list.map((d) => d.tempC).filter((t): t is number => t != null);
      return {
        room,
        key: room?.id ?? '__unassigned',
        name: room?.name ?? 'Unassigned',
        icon: room ? room.icon || 'house' : 'inbox',
        tone: ROOM_TONES[i % ROOM_TONES.length],
        devices: list,
        onCount: list.filter((d) => d.power).length,
        lights: lights.length,
        lightsOn: lights.filter((d) => d.power).length,
        tempC: temps.length ? temps.reduce((s, v) => s + v, 0) / temps.length : null,
      };
    };
    const out = sorted.map(mk);
    const unassigned = devices.filter((d) => d.roomId == null);
    if (unassigned.length > 0) out.push(mk(null, out.length));
    return out;
  }, [rooms, devices]);

  const [selected, setSelected] = useState<string | null>(null);
  const active = views.find((v) => v.key === selected) ?? views[0] ?? null;

  const totalOn = devices.filter((d) => d.power).length;
  const totalLightsOn = devices.filter((d) => d.kind === 'lighting' && d.power).length;

  /** Whole-house actions run the same server-side room All-off the room cards do. */
  const allOff = (scope: 'all' | 'lights') => {
    if (busyAll) return;
    setBusyAll(scope);
    void Promise.all(rooms.map((r) => api.rooms.allOff(r.id, scope).catch(() => undefined)))
      .then(onChanged)
      .finally(() => setBusyAll(null));
  };

  const cols = !wide ? 1 : roomy ? 3 : 2;
  const devCols = !wide ? 1 : roomy ? 3 : 2;

  if (views.length === 0) {
    return (
      <Card padded style={{ textAlign: 'center', color: 'var(--text-3)', fontSize: 13, padding: 24 }}>
        {loading ? 'Loading…' : 'No rooms yet. Connect devices and rooms seed from their names, or add rooms in Manage.'}
      </Card>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: wide ? 18 : 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, color: 'var(--text-2)' }}>
          {devices.length} device{devices.length === 1 ? '' : 's'} across {views.length} room{views.length === 1 ? '' : 's'} ·{' '}
          {totalLightsOn} light{totalLightsOn === 1 ? '' : 's'} on · {totalOn} device{totalOn === 1 ? '' : 's'} drawing
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button variant="ghost" style={{ height: 34 }} onClick={() => nav('/rooms')} iconLeft={<Icon name="settings-2" size={14} />}>
            Manage rooms
          </Button>
          {canEdit && (
            <>
              <Button variant="ghost" style={{ height: 34 }} disabled={busyAll !== null} onClick={() => allOff('lights')}>
                {busyAll === 'lights' ? 'Switching…' : 'Lights off'}
              </Button>
              <Button style={{ height: 34 }} disabled={busyAll !== null} onClick={() => allOff('all')}>
                {busyAll === 'all' ? 'Switching…' : 'All off'}
              </Button>
            </>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, minmax(0,1fr))`, gap: wide ? 14 : 10 }}>
        {views.map((v) => {
          const on = active?.key === v.key;
          const load = v.devices.length ? (v.onCount / v.devices.length) * 100 : 0;
          return (
            <button
              key={v.key}
              type="button"
              onClick={() => setSelected(v.key)}
              aria-pressed={on}
              style={{
                all: 'unset',
                cursor: 'pointer',
                boxSizing: 'border-box',
                display: 'block',
                padding: wide ? 16 : 14,
                borderRadius: 'var(--radius-card)',
                background: 'var(--surface-1)',
                border: `1px solid ${on ? 'var(--border-solar)' : 'var(--border-1)'}`,
                boxShadow: on ? 'var(--shadow-2), var(--glow-soft)' : 'var(--shadow-2), var(--hairline-top)',
                transform: on ? 'translateY(-2px)' : 'none',
                transition: 'all .18s var(--ease-out)',
                fontFamily: 'var(--font-sans)',
                color: 'var(--text-1)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center', background: `var(--${v.tone}-wash)`, color: `var(--${v.tone})`, flex: 'none' }}>
                  <Icon name={v.icon} size={16} />
                </span>
                <span style={{ fontSize: 15, fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.name}</span>
                <span style={{ marginLeft: 'auto' }}>
                  <Badge tone={v.tone} variant="soft">{v.onCount > 0 ? `${v.onCount} on` : 'Quiet'}</Badge>
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 14 }}>
                <span className="pwr-mono" style={{ fontSize: 26, fontWeight: 500 }}>{v.onCount}</span>
                <span className="pwr-mono" style={{ fontSize: 11, color: 'var(--text-2)' }}>
                  on{v.tempC != null ? ` · ${v.tempC.toFixed(1)}°` : ''}
                </span>
              </div>
              <div style={{ height: 5, borderRadius: 999, background: 'var(--surface-4)', overflow: 'hidden', marginTop: 11 }}>
                <i style={{ display: 'block', height: '100%', width: `${load.toFixed(0)}%`, background: `var(--${v.tone})`, borderRadius: 999, boxShadow: `0 0 8px var(--${v.tone})` }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10, fontSize: 11.5, color: 'var(--text-3)' }}>
                <span>{v.devices.length} device{v.devices.length === 1 ? '' : 's'}</span>
                <span>{v.lights > 0 ? `${v.lightsOn}/${v.lights} lights` : 'no lights'}</span>
              </div>
            </button>
          );
        })}
      </div>

      {active && (
        <Card
          title={active.name}
          subtitle={`${active.devices.length} device${active.devices.length === 1 ? '' : 's'} · ${active.lightsOn} of ${active.lights} light${active.lights === 1 ? '' : 's'} on${active.tempC != null ? ` · ${active.tempC.toFixed(1)}°` : ''}`}
          actions={<Badge tone="home" variant="soft">{active.onCount} on now</Badge>}
          style={{ animation: 'v2rise .5s var(--ease-out) .12s' }}
        >
          {active.devices.length === 0 ? (
            <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>No devices here yet.</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${devCols}, minmax(0,1fr))`, gap: 12 }}>
              {active.devices.map((d) => (
                <DeviceRow key={d.id} d={d} canEdit={canEdit} rooms={rooms} onChanged={onChanged} />
              ))}
            </div>
          )}
          {!canEdit && (
            <div style={{ marginTop: 12 }}>
              <Eyebrow>Read-only — switching devices needs an admin account.</Eyebrow>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
