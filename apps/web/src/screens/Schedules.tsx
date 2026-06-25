import { useState } from 'react';
import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import type { Schedule, SchedulesResponse, DevicesResponse, ClimateMode } from '../lib/types';
import { Card, Icon, Button, Switch, Input, Select, Badge, Eyebrow } from '../components/ui';
import { MobileHeader, Avatar, StaleBanner } from './_shared';
import { useAuth } from '../auth/AuthProvider';
import type { ShellContext } from '../components/shell/AppShell';

/* ============================================================================
 * Schedules (/schedules) — weekly time windows that set a mode + setpoint on a
 * scope of devices. CRUD over /api/schedules. Admin-gated writes; the day-of-week
 * row doubles as a tiny weekly timeline per schedule.
 * ==========================================================================*/

const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const MODE_OPTS = [
  { value: 'cool', label: 'Cool' },
  { value: 'heat', label: 'Heat' },
  { value: 'dry', label: 'Dry' },
  { value: 'fan', label: 'Fan' },
  { value: 'auto', label: 'Auto' },
];

function DayDots({ days }: { days: number[] }) {
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      {DAY_LABELS.map((l, i) => {
        const on = days.includes(i);
        return (
          <span
            key={i}
            style={{
              width: 20,
              height: 20,
              borderRadius: 6,
              display: 'grid',
              placeItems: 'center',
              fontSize: 10.5,
              fontWeight: 700,
              background: on ? 'var(--solar)' : 'var(--surface-3)',
              color: on ? '#06090b' : 'var(--text-3)',
            }}
          >
            {l}
          </span>
        );
      })}
    </div>
  );
}

function DayPicker({ days, onChange }: { days: number[]; onChange: (d: number[]) => void }) {
  const toggle = (i: number) => {
    onChange(days.includes(i) ? days.filter((x) => x !== i) : [...days, i].sort());
  };
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      {DAY_LABELS.map((l, i) => {
        const on = days.includes(i);
        return (
          <button
            key={i}
            type="button"
            onClick={() => toggle(i)}
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              border: 'none',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 700,
              background: on ? 'var(--solar)' : 'var(--surface-3)',
              color: on ? '#06090b' : 'var(--text-2)',
            }}
          >
            {l}
          </button>
        );
      })}
    </div>
  );
}

function ScheduleEditor({
  initial,
  deviceOptions,
  onSave,
  onCancel,
}: {
  initial: Partial<Schedule>;
  deviceOptions: { id: string; name: string }[];
  onSave: (s: Partial<Schedule>) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial.name ?? 'New schedule');
  const [days, setDays] = useState<number[]>(initial.days ?? [1, 2, 3, 4, 5]);
  const [start, setStart] = useState(initial.start ?? '08:00');
  const [end, setEnd] = useState(initial.end ?? '22:00');
  const [mode, setMode] = useState<ClimateMode>((initial.mode as ClimateMode) ?? 'cool');
  const [setpointC, setSetpointC] = useState(initial.setpointC ?? 24);
  const [deviceIds, setDeviceIds] = useState<string[]>(initial.scope?.deviceIds ?? []);
  const [busy, setBusy] = useState(false);

  const toggleDevice = (id: string) =>
    setDeviceIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const save = async () => {
    setBusy(true);
    try {
      await onSave({ name, days, start, end, mode, setpointC, scope: { deviceIds } });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card padded style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} />
      <div>
        <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 6 }}>Days</div>
        <DayPicker days={days} onChange={setDays} />
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <Input label="Start" type="time" value={start} onChange={(e) => setStart(e.target.value)} />
        <Input label="End" type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <Select label="Mode" value={mode} options={MODE_OPTS} onChange={(e) => setMode(e.target.value as ClimateMode)} />
        <Input label="Setpoint °C" type="number" step={0.5} min={16} max={30} value={setpointC} onChange={(e) => setSetpointC(Number(e.target.value))} />
      </div>
      <div>
        <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 6 }}>Devices</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {deviceOptions.length === 0 && <span style={{ fontSize: 12, color: 'var(--text-3)' }}>Connect AC Cloud to pick devices.</span>}
          {deviceOptions.map((dvc) => {
            const on = deviceIds.includes(dvc.id);
            return (
              <button
                key={dvc.id}
                type="button"
                onClick={() => toggleDevice(dvc.id)}
                style={{
                  padding: '5px 10px',
                  borderRadius: 999,
                  border: on ? 'none' : '1px solid var(--border-2)',
                  background: on ? 'var(--solar-wash)' : 'transparent',
                  color: on ? 'var(--solar)' : 'var(--text-2)',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                {dvc.name}
              </button>
            );
          })}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button size="sm" variant="primary" loading={busy} onClick={() => void save()}>Save</Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </Card>
  );
}

function ScheduleCard({
  s,
  deviceNames,
  canWrite,
  onToggle,
  onEdit,
  onDelete,
}: {
  s: Schedule;
  deviceNames: Record<string, string>;
  canWrite: boolean;
  onToggle: (on: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <Card padded style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
        <span style={{ width: 34, height: 34, borderRadius: 10, display: 'grid', placeItems: 'center', background: 'var(--solar-wash)', color: 'var(--solar)', flex: 'none' }}>
          <Icon name="calendar-clock" size={17} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>{s.name}</div>
          <div style={{ fontSize: 12, color: 'var(--text-2)', fontFamily: 'var(--font-mono)' }}>
            {s.start}–{s.end} · {s.mode} {s.setpointC}°
          </div>
        </div>
        <Switch checked={s.enabled} disabled={!canWrite} onChange={(e) => onToggle(e.target.checked)} />
      </div>
      <DayDots days={s.days} />
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {s.scope.deviceIds.map((id) => (
          <Badge key={id} tone="neutral" variant="soft">{deviceNames[id] ?? id}</Badge>
        ))}
        {s.scope.deviceIds.length === 0 && <span style={{ fontSize: 12, color: 'var(--text-3)' }}>No devices</span>}
        {canWrite && (
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <Button size="sm" variant="ghost" iconLeft={<Icon name="pencil" size={13} />} onClick={onEdit}>Edit</Button>
            <Button size="sm" variant="ghost" onClick={onDelete}>Delete</Button>
          </div>
        )}
      </div>
    </Card>
  );
}

export function Schedules({ ctx }: { ctx: ShellContext }) {
  const { user } = useAuth();
  const canWrite = user?.role === 'admin';
  const wide = ctx.desktop;
  const { data, stale, updatedAt, refetch } = usePolling<SchedulesResponse>(api.schedules.list, 0);
  const { data: devData } = usePolling<DevicesResponse>(api.devices.list, 0);
  const [editing, setEditing] = useState<Schedule | 'new' | null>(null);

  const schedules = data?.schedules ?? [];
  const deviceOptions = (devData?.devices ?? []).map((d) => ({ id: d.id, name: d.name }));
  const deviceNames: Record<string, string> = {};
  for (const d of devData?.devices ?? []) deviceNames[d.id] = d.name;

  const saveNew = async (s: Partial<Schedule>) => {
    await api.schedules.create(s);
    setEditing(null);
    refetch();
  };
  const saveEdit = async (id: string, s: Partial<Schedule>) => {
    await api.schedules.update(id, s);
    setEditing(null);
    refetch();
  };
  const toggle = async (s: Schedule, on: boolean) => {
    await api.schedules.update(s.id, { enabled: on });
    refetch();
  };
  const remove = async (id: string) => {
    await api.schedules.remove(id);
    refetch();
  };

  const list = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: wide ? 14 : 10 }}>
      {stale && <StaleBanner updatedAt={updatedAt} />}
      {canWrite && editing !== 'new' && (
        <Button variant="secondary" iconLeft={<Icon name="plus" size={16} />} onClick={() => setEditing('new')}>
          New schedule
        </Button>
      )}
      {editing === 'new' && (
        <ScheduleEditor initial={{}} deviceOptions={deviceOptions} onSave={saveNew} onCancel={() => setEditing(null)} />
      )}
      {schedules.map((s) =>
        editing !== 'new' && typeof editing !== 'string' && editing?.id === s.id ? (
          <ScheduleEditor
            key={s.id}
            initial={s}
            deviceOptions={deviceOptions}
            onSave={(patch) => saveEdit(s.id, patch)}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <ScheduleCard
            key={s.id}
            s={s}
            deviceNames={deviceNames}
            canWrite={!!canWrite}
            onToggle={(on) => void toggle(s, on)}
            onEdit={() => setEditing(s)}
            onDelete={() => void remove(s.id)}
          />
        ),
      )}
      {schedules.length === 0 && editing !== 'new' && (
        <Card padded style={{ textAlign: 'center', color: 'var(--text-3)', fontSize: 13, padding: 24 }}>
          No schedules yet. Create one to run a mode + setpoint on a weekly window.
        </Card>
      )}
    </div>
  );

  if (wide) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 760, margin: '0 auto', width: '100%' }}>
        <div><Eyebrow>Climate</Eyebrow><h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-.02em', margin: '2px 0 0' }}>Schedules</h1></div>
        {list}
      </div>
    );
  }
  return (
    <>
      <MobileHeader eyebrow="Climate" title="Schedules" right={<Avatar />} />
      <div style={{ padding: '8px 14px 22px' }}>{list}</div>
    </>
  );
}
