import { useState } from 'react';
import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import type { Schedule, SchedulesResponse, DevicesResponse, ClimateMode } from '../lib/types';
import { Card, Icon, Button, Switch, Input, Select, Eyebrow } from '../components/ui';
import { MobileHeader, Avatar, StaleBanner } from './_shared';
import { useAuth } from '../auth/AuthProvider';
import type { ShellContext } from '../components/shell/AppShell';

/* ============================================================================
 * Schedules (/schedules) — built to the approved design: scope chips, a weekly
 * timeline of setpoint blocks for the selected schedule, schedule cards, and the
 * smart-override note. Full CRUD over /api/schedules; admin-gated writes.
 * ==========================================================================*/

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_ABBR = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
// store days are 0=Sun..6=Sat; the timeline shows Mon..Sun.
const ROW_TO_STORE = [1, 2, 3, 4, 5, 6, 0];
const MODE_OPTS = [
  { value: 'cool', label: 'Cool' }, { value: 'heat', label: 'Heat' },
  { value: 'dry', label: 'Dry' }, { value: 'fan', label: 'Fan' }, { value: 'auto', label: 'Auto' },
];
const MODE_COLOR: Record<string, string> = { cool: 'var(--battery)', heat: 'var(--grid)', dry: 'var(--home)', fan: 'var(--text-2)', auto: 'var(--solar)' };
const ICON_FOR = (name: string): string => {
  const n = name.toLowerCase();
  if (/(night|bed|sleep|mbr)/.test(n)) return 'moon';
  if (/(living|sofa|lounge|evening)/.test(n)) return 'sofa';
  if (/(away|eco|holiday)/.test(n)) return 'plane';
  if (/(guest)/.test(n)) return 'users';
  return 'calendar-clock';
};
const pct = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return ((h * 60 + (m || 0)) / 1440) * 100;
};

function WeeklyTimeline({ s }: { s: Schedule }) {
  const color = MODE_COLOR[s.mode] ?? 'var(--battery)';
  const a = pct(s.start);
  const b = pct(s.end);
  // wrap (e.g. 22:00→07:00) → two blocks
  const blocks = b > a ? [[a, b - a]] : [[0, b], [a, 100 - a]];
  return (
    <Card padded>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
        <span className="pwr-eyebrow" style={{ color }}>{s.name} — weekly</span>
        <span className="pwr-mono" style={{ fontSize: 11, color: 'var(--text-2)' }}>{s.mode} · {s.setpointC.toFixed(1)}°</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {DAY_LABELS.map((label, row) => {
          const active = s.days.includes(ROW_TO_STORE[row]);
          return (
            <div key={row} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 28, fontSize: 10, color: active ? 'var(--text-2)' : 'var(--text-disabled)' }}>{label}</span>
              <div style={{ position: 'relative', height: 16, flex: 1, background: 'var(--surface-1)', borderRadius: 4, overflow: 'hidden' }}>
                {active && blocks.map(([left, width], i) => (
                  <span key={i} style={{ position: 'absolute', top: 0, height: 16, left: `${left}%`, width: `${width}%`, background: color, opacity: 0.55, borderRadius: 3 }} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 7, paddingLeft: 36 }}>
        {['00', '06', '12', '18', '24'].map((h) => <span key={h} className="pwr-mono" style={{ fontSize: 9.5, color: 'var(--text-3)' }}>{h}</span>)}
      </div>
    </Card>
  );
}

function ScheduleCard({ s, deviceNames, canWrite, onToggle, onEdit, onDelete }: {
  s: Schedule; deviceNames: Record<string, string>; canWrite: boolean;
  onToggle: (on: boolean) => void; onEdit: () => void; onDelete: () => void;
}) {
  const color = MODE_COLOR[s.mode] ?? 'var(--battery)';
  const names = s.scope.deviceIds.map((id) => deviceNames[id] ?? id);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'var(--surface-2)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-lg)', padding: '11px 14px' }}>
      <Icon name={ICON_FOR(s.name)} size={18} color={color} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{s.name}</div>
        <div style={{ fontSize: 11, color: 'var(--text-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {names.length ? names.join(' · ') : 'No devices'}
          {s.roomTempAboveC != null && <span style={{ color: 'var(--grid)' }}> · only if &gt; {s.roomTempAboveC}°</span>}
        </div>
      </div>
      <div className="pwr-mono" style={{ fontSize: 12, color: 'var(--text-2)', textAlign: 'right', whiteSpace: 'nowrap' }}>
        {s.start}–{s.end}<br /><span style={{ color }}>{s.mode} {s.setpointC.toFixed(1)}°</span>
      </div>
      <Switch checked={s.enabled} disabled={!canWrite} onChange={(e) => onToggle(e.target.checked)} />
      {canWrite && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <button type="button" aria-label="Edit" onClick={onEdit} style={{ background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer' }}><Icon name="pencil" size={14} /></button>
          <button type="button" aria-label="Delete" onClick={onDelete} style={{ background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer' }}><Icon name="trash-2" size={14} /></button>
        </div>
      )}
    </div>
  );
}

function ScheduleEditor({ initial, deviceOptions, onSave, onCancel }: {
  initial: Partial<Schedule>; deviceOptions: { id: string; name: string }[];
  onSave: (s: Partial<Schedule>) => Promise<void>; onCancel: () => void;
}) {
  const [name, setName] = useState(initial.name ?? 'New schedule');
  const [days, setDays] = useState<number[]>(initial.days ?? [1, 2, 3, 4, 5]);
  const [start, setStart] = useState(initial.start ?? '22:00');
  const [end, setEnd] = useState(initial.end ?? '07:00');
  const [mode, setMode] = useState<ClimateMode>((initial.mode as ClimateMode) ?? 'cool');
  const [setpointC, setSetpointC] = useState(initial.setpointC ?? 24);
  const [deviceIds, setDeviceIds] = useState<string[]>(initial.scope?.deviceIds ?? []);
  const [condOn, setCondOn] = useState(initial.roomTempAboveC != null);
  const [condC, setCondC] = useState(initial.roomTempAboveC ?? 26);
  const [busy, setBusy] = useState(false);

  const toggleDay = (store: number) => setDays((p) => (p.includes(store) ? p.filter((x) => x !== store) : [...p, store].sort()));
  const toggleDevice = (id: string) => setDeviceIds((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const save = async () => { setBusy(true); try { await onSave({ name, days, start, end, mode, setpointC, scope: { deviceIds }, roomTempAboveC: condOn ? condC : null }); } finally { setBusy(false); } };

  return (
    <Card padded style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} />
      <div>
        <div className="pwr-eyebrow" style={{ marginBottom: 6 }}>Days</div>
        <div style={{ display: 'flex', gap: 6 }}>
          {DAY_ABBR.map((l, row) => {
            const store = ROW_TO_STORE[row];
            const on = days.includes(store);
            return <button key={row} type="button" onClick={() => toggleDay(store)} style={{ width: 30, height: 30, borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, background: on ? 'var(--solar)' : 'var(--surface-3)', color: on ? '#06090b' : 'var(--text-2)' }}>{l}</button>;
          })}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <Input label="Start" type="time" value={start} onChange={(e) => setStart(e.target.value)} />
        <Input label="End" type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <Select label="Mode" value={mode} options={MODE_OPTS} onChange={(e) => setMode(e.target.value as ClimateMode)} />
        <Input label="Setpoint °C" type="number" step={0.5} min={16} max={30} value={setpointC} onChange={(e) => setSetpointC(Number(e.target.value))} />
      </div>
      {/* CONDITION — only run when the room is warm enough */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', padding: '11px 13px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Icon name="thermometer" size={16} color="var(--grid)" />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 500 }}>Only if room is warm</div>
            <div style={{ fontSize: 11, color: 'var(--text-3)' }}>Skip cooling rooms that aren't above a temperature</div>
          </div>
          <Switch checked={condOn} onChange={(e) => setCondOn(e.target.checked)} />
        </div>
        {condOn && (
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10 }}>
            <div style={{ width: 140 }}>
              <Input label="Room above °C" type="number" step={0.5} min={16} max={32} value={condC} onChange={(e) => setCondC(Number(e.target.value))} />
            </div>
            <span style={{ fontSize: 11, color: 'var(--text-3)', paddingBottom: 9 }}>only cools a room when it's hotter than this</span>
          </div>
        )}
      </div>
      <div>
        <div className="pwr-eyebrow" style={{ marginBottom: 6 }}>Devices</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {deviceOptions.length === 0 && <span style={{ fontSize: 12, color: 'var(--text-3)' }}>Connect AC Cloud to pick devices.</span>}
          {deviceOptions.map((dvc) => {
            const on = deviceIds.includes(dvc.id);
            return <button key={dvc.id} type="button" onClick={() => toggleDevice(dvc.id)} style={{ padding: '5px 10px', borderRadius: 999, border: on ? 'none' : '1px solid var(--border-2)', background: on ? 'var(--solar-wash)' : 'transparent', color: on ? 'var(--solar)' : 'var(--text-2)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>{dvc.name}</button>;
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

export function Schedules({ ctx }: { ctx: ShellContext }) {
  const { user } = useAuth();
  const canWrite = user?.role === 'admin';
  const wide = ctx.desktop;
  const { data, stale, updatedAt, refetch } = usePolling<SchedulesResponse>(api.schedules.list, 0);
  const { data: devData } = usePolling<DevicesResponse>(api.devices.list, 0);
  const [editing, setEditing] = useState<Schedule | 'new' | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const schedules = data?.schedules ?? [];
  const deviceOptions = (devData?.devices ?? []).map((d) => ({ id: d.id, name: d.name }));
  const deviceNames: Record<string, string> = {};
  for (const d of devData?.devices ?? []) deviceNames[d.id] = d.name;
  const active = schedules.find((s) => s.id === activeId) ?? schedules[0] ?? null;

  const saveNew = async (s: Partial<Schedule>) => { await api.schedules.create(s); setEditing(null); refetch(); };
  const saveEdit = async (id: string, s: Partial<Schedule>) => { await api.schedules.update(id, s); setEditing(null); refetch(); };
  const toggle = async (s: Schedule, on: boolean) => { await api.schedules.update(s.id, { enabled: on }); refetch(); };
  const remove = async (id: string) => { await api.schedules.remove(id); refetch(); };

  const list = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {stale && <StaleBanner updatedAt={updatedAt} />}

      {/* scope chips */}
      {schedules.length > 0 && (
        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
          {schedules.map((s) => {
            const on = active?.id === s.id;
            return <button key={s.id} type="button" onClick={() => setActiveId(s.id)} style={{ fontSize: 11.5, padding: '6px 11px', borderRadius: 8, cursor: 'pointer', background: on ? 'var(--surface-3)' : 'var(--surface-1)', color: on ? (MODE_COLOR[s.mode] ?? 'var(--solar)') : 'var(--text-2)', border: `1px solid ${on ? 'var(--border-2)' : 'var(--border-1)'}` }}>{s.name}</button>;
          })}
        </div>
      )}

      {active && editing == null && <WeeklyTimeline s={active} />}

      {editing === 'new' && <ScheduleEditor initial={{}} deviceOptions={deviceOptions} onSave={saveNew} onCancel={() => setEditing(null)} />}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {schedules.map((s) =>
          typeof editing !== 'string' && editing?.id === s.id ? (
            <ScheduleEditor key={s.id} initial={s} deviceOptions={deviceOptions} onSave={(patch) => saveEdit(s.id, patch)} onCancel={() => setEditing(null)} />
          ) : (
            <ScheduleCard key={s.id} s={s} deviceNames={deviceNames} canWrite={!!canWrite} onToggle={(on) => void toggle(s, on)} onEdit={() => setEditing(s)} onDelete={() => void remove(s.id)} />
          ),
        )}
      </div>

      {schedules.length === 0 && editing !== 'new' && (
        <Card padded style={{ textAlign: 'center', color: 'var(--text-3)', fontSize: 13, padding: 24 }}>No schedules yet. Create one to run a mode + setpoint on a weekly window.</Card>
      )}

      {/* smart-override note */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, background: 'var(--solar-wash)', border: '1px solid rgba(46,230,160,0.18)', borderRadius: 'var(--radius-md)', padding: '9px 13px' }}>
        <Icon name="zap" size={15} color="var(--solar)" />
        <span style={{ fontSize: 11.5, color: 'var(--text-2)' }}>Smart rules can pre-cool <span style={{ color: 'var(--text-1)' }}>earlier than scheduled</span> when free solar is available — schedules are the floor, surplus is a bonus.</span>
      </div>
    </div>
  );

  const header = (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
      <div><Eyebrow>Climate</Eyebrow><h1 style={{ fontSize: wide ? 24 : 20, fontWeight: 600, letterSpacing: '-.01em', margin: '2px 0 0' }}>Schedules</h1></div>
      {canWrite && editing !== 'new' && <Button size="sm" variant="secondary" iconLeft={<Icon name="plus" size={15} />} onClick={() => setEditing('new')}>New schedule</Button>}
    </div>
  );

  if (wide) return <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 760, margin: '0 auto', width: '100%' }}>{header}{list}</div>;
  return (
    <>
      <MobileHeader eyebrow="Climate" title="Schedules" right={<Avatar />} />
      <div style={{ padding: '8px 14px 22px', display: 'flex', flexDirection: 'column', gap: 12 }}>{canWrite && editing !== 'new' && <Button size="sm" variant="secondary" iconLeft={<Icon name="plus" size={15} />} onClick={() => setEditing('new')}>New schedule</Button>}{list}</div>
    </>
  );
}
