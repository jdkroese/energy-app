import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import type {
  LightUnit, LightScene, LightSceneMember, LightSchedule, LightScheduleTarget,
  ScenesResponse, LightSchedulesResponse,
} from '../../lib/types';
import { Card, Icon, Button, Switch, Slider, SegmentedControl, Input, Select } from '../ui';

/* ============================================================================
 * Scenes + light schedules — the two management blocks under the Devices →
 * Lighting tab. Scenes are named on/off+dim presets; schedules apply a scene or
 * an ad-hoc light set at a time window. Built to the Power design system.
 * ==========================================================================*/

const DOW = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

/* ---- modal shell --------------------------------------------------------- */
function Overlay({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer: ReactNode }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(4,8,10,0.66)', backdropFilter: 'blur(3px)', display: 'grid', placeItems: 'center', padding: 16 }}
    >
      <div style={{ width: '100%', maxWidth: 460, maxHeight: '88vh', display: 'flex', flexDirection: 'column', background: 'var(--surface-1)', border: '1px solid var(--border-2)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-2)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '15px 18px', borderBottom: '1px solid var(--border-1)' }}>
          <span style={{ width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'var(--solar-wash)', color: 'var(--solar)', flex: 'none' }}><Icon name="lightbulb" size={16} /></span>
          <div style={{ fontSize: 15.5, fontWeight: 600, flex: 1 }}>{title}</div>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer', padding: 4 }}><Icon name="x" size={18} /></button>
        </div>
        <div style={{ padding: 18, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>{children}</div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', padding: '14px 18px', borderTop: '1px solid var(--border-1)' }}>{footer}</div>
      </div>
    </div>
  );
}

/* ---- days picker --------------------------------------------------------- */
function DaysPicker({ days, onToggle }: { days: number[]; onToggle: (d: number) => void }) {
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      {DOW.map((label, d) => {
        const on = days.includes(d);
        return (
          <button key={d} type="button" onClick={() => onToggle(d)} style={{
            flex: 1, padding: '7px 0', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: 12, fontWeight: 600,
            border: `1px solid ${on ? 'var(--solar)' : 'var(--border-2)'}`,
            background: on ? 'var(--solar-wash)' : 'transparent', color: on ? 'var(--solar)' : 'var(--text-3)',
          }}>{label}</button>
        );
      })}
    </div>
  );
}

/* ---- member editor (pick lights + on/off + dim) -------------------------- */
type Draft = Record<string, { included: boolean; on: boolean; brightnessPct: number }>;

function membersToDraft(lights: LightUnit[], members: LightSceneMember[]): Draft {
  const byId = new Map(members.map((m) => [m.lightId, m]));
  const d: Draft = {};
  for (const l of lights) {
    const m = byId.get(l.id);
    d[l.id] = {
      included: !!m,
      on: m ? m.on : true,
      brightnessPct: (m?.brightnessPct ?? l.brightnessPct ?? 100) || 100,
    };
  }
  return d;
}
function draftToMembers(draft: Draft, lights: LightUnit[]): LightSceneMember[] {
  return lights.filter((l) => draft[l.id]?.included).map((l) => ({
    lightId: l.id,
    on: draft[l.id].on,
    brightnessPct: l.dimmable && draft[l.id].on ? draft[l.id].brightnessPct : null,
  }));
}

function MemberEditor({ lights, draft, setDraft }: { lights: LightUnit[]; draft: Draft; setDraft: (d: Draft) => void }) {
  const patch = (id: string, p: Partial<Draft[string]>) => setDraft({ ...draft, [id]: { ...draft[id], ...p } });
  if (lights.length === 0) return <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>No lights available.</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
      {lights.map((l, i) => {
        const dr = draft[l.id];
        return (
          <div key={l.id} style={{ padding: '10px 12px', borderTop: i === 0 ? 'none' : '1px solid var(--border-1)', background: dr?.included ? 'var(--surface-2)' : 'transparent' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button type="button" onClick={() => patch(l.id, { included: !dr?.included })} aria-label="include" style={{
                width: 18, height: 18, borderRadius: 5, flex: 'none', cursor: 'pointer', display: 'grid', placeItems: 'center', color: '#06090b',
                border: dr?.included ? 'none' : '1.5px solid var(--border-3)', background: dr?.included ? 'var(--solar)' : 'transparent',
              }}>{dr?.included && <Icon name="check" size={12} />}</button>
              <div style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.name}</div>
              {dr?.included && (
                <SegmentedControl size="sm" value={dr.on ? 'on' : 'off'} options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} onChange={(v) => patch(l.id, { on: v === 'on' })} />
              )}
            </div>
            {dr?.included && dr.on && l.dimmable && (
              <div style={{ marginTop: 8, paddingLeft: 28 }}>
                <Slider label="Brightness" min={1} max={100} unit="%" value={dr.brightnessPct} onChange={(v) => patch(l.id, { brightnessPct: v })} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ============================================================================
 * Scenes
 * ==========================================================================*/
function SceneEditor({ lights, scene, onClose, onSaved }: { lights: LightUnit[]; scene: LightScene | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(scene?.name ?? '');
  const [draft, setDraft] = useState<Draft>(() => membersToDraft(lights, scene?.members ?? []));
  const [busy, setBusy] = useState(false);
  const includedCount = Object.values(draft).filter((d) => d.included).length;

  const save = async () => {
    setBusy(true);
    try {
      const payload = { name: name.trim() || 'New scene', members: draftToMembers(draft, lights) };
      if (scene) await api.lights.updateScene(scene.id, payload);
      else await api.lights.createScene(payload);
      onSaved();
      onClose();
    } catch { setBusy(false); }
  };
  const remove = async () => { if (!scene) return; setBusy(true); try { await api.lights.deleteScene(scene.id); onSaved(); onClose(); } catch { setBusy(false); } };

  return (
    <Overlay title={scene ? 'Edit scene' : 'New scene'} onClose={onClose} footer={
      <>
        {scene && <Button size="sm" variant="ghost" onClick={() => void remove()} style={{ marginRight: 'auto', color: 'var(--danger)' }}>Delete</Button>}
        <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button size="sm" variant="primary" loading={busy} disabled={includedCount === 0} onClick={() => void save()}>Save</Button>
      </>
    }>
      <Input label="Scene name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Movie night" />
      <div>
        <div className="pwr-eyebrow" style={{ marginBottom: 7 }}>Lights · {includedCount} selected</div>
        <MemberEditor lights={lights} draft={draft} setDraft={setDraft} />
      </div>
    </Overlay>
  );
}

export function ScenesSection({ lights, canControl }: { lights: LightUnit[]; canControl: boolean }) {
  const { data, refetch } = usePolling<ScenesResponse>(api.lights.scenes, 0);
  const scenes = data?.scenes ?? [];
  const [editing, setEditing] = useState<LightScene | null | undefined>(undefined); // undefined=closed, null=new
  const [applying, setApplying] = useState<string | null>(null);

  const apply = async (id: string) => {
    setApplying(id);
    try { await api.lights.applyScene(id); } catch { /* ignore */ } finally { setApplying(null); refetch(); }
  };

  return (
    <Card padded style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Icon name="sparkles" size={16} color="var(--solar)" />
        <div style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>Scenes</div>
        {canControl && <Button size="sm" variant="secondary" iconLeft={<Icon name="plus" size={14} />} onClick={() => setEditing(null)}>New</Button>}
      </div>
      {scenes.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>No scenes yet. {canControl ? 'Create one to set several lights at once.' : ''}</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8 }}>
          {scenes.map((s) => (
            <div key={s.id} style={{ border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', padding: 11, display: 'flex', flexDirection: 'column', gap: 8, background: 'var(--surface-1)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Icon name={s.icon || 'sparkles'} size={15} color="var(--solar)" />
                <div style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</div>
                {canControl && <button type="button" onClick={() => setEditing(s)} style={{ background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer', padding: 2 }}><Icon name="pencil" size={13} /></button>}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{s.members.length} light{s.members.length === 1 ? '' : 's'}</div>
              <Button size="sm" variant="secondary" block disabled={!canControl} loading={applying === s.id} iconLeft={<Icon name="play" size={13} />} onClick={() => void apply(s.id)}>Apply</Button>
            </div>
          ))}
        </div>
      )}
      {editing !== undefined && <SceneEditor lights={lights} scene={editing} onClose={() => setEditing(undefined)} onSaved={refetch} />}
    </Card>
  );
}

/* ============================================================================
 * Light schedules
 * ==========================================================================*/
function summarize(s: LightSchedule, scenes: LightScene[]): string {
  const days = s.days.length === 7 ? 'Every day' : s.days.length === 0 ? 'No days' : s.days.slice().sort().map((d) => DOW[d]).join(' ');
  let tgt: string;
  if (s.target.kind === 'scene') {
    const sid = s.target.sceneId;
    tgt = scenes.find((x) => x.id === sid)?.name ?? 'scene';
  } else {
    tgt = `${s.target.members.length} lights`;
  }
  const win = s.offTime ? `${s.onTime}–${s.offTime}` : `at ${s.onTime}`;
  return `${days} · ${win} · ${tgt}`;
}

function ScheduleEditor({ lights, scenes, sched, onClose, onSaved }: { lights: LightUnit[]; scenes: LightScene[]; sched: LightSchedule | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(sched?.name ?? '');
  const [days, setDays] = useState<number[]>(sched?.days ?? [1, 2, 3, 4, 5]);
  const [onTime, setOnTime] = useState(sched?.onTime ?? '18:00');
  const [autoOff, setAutoOff] = useState<boolean>(!!sched?.offTime);
  const [offTime, setOffTime] = useState(sched?.offTime ?? '23:00');
  const [kind, setKind] = useState<LightScheduleTarget['kind']>(sched?.target.kind ?? (scenes.length ? 'scene' : 'lights'));
  const [sceneId, setSceneId] = useState(sched?.target.kind === 'scene' ? sched.target.sceneId : scenes[0]?.id ?? '');
  const [draft, setDraft] = useState<Draft>(() => membersToDraft(lights, sched?.target.kind === 'lights' ? sched.target.members : []));
  const [busy, setBusy] = useState(false);

  const toggleDay = (d: number) => setDays((p) => (p.includes(d) ? p.filter((x) => x !== d) : [...p, d].sort()));
  const valid = days.length > 0 && (kind === 'scene' ? !!sceneId : Object.values(draft).some((x) => x.included));

  const save = async () => {
    setBusy(true);
    try {
      const target: LightScheduleTarget = kind === 'scene' ? { kind: 'scene', sceneId } : { kind: 'lights', members: draftToMembers(draft, lights) };
      const payload = { name: name.trim() || 'Light schedule', days, onTime, offTime: autoOff ? offTime : null, target, enabled: sched?.enabled ?? true };
      if (sched) await api.lights.updateSchedule(sched.id, payload);
      else await api.lights.createSchedule(payload);
      onSaved(); onClose();
    } catch { setBusy(false); }
  };
  const remove = async () => { if (!sched) return; setBusy(true); try { await api.lights.deleteSchedule(sched.id); onSaved(); onClose(); } catch { setBusy(false); } };

  return (
    <Overlay title={sched ? 'Edit schedule' : 'New light schedule'} onClose={onClose} footer={
      <>
        {sched && <Button size="sm" variant="ghost" onClick={() => void remove()} style={{ marginRight: 'auto', color: 'var(--danger)' }}>Delete</Button>}
        <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button size="sm" variant="primary" loading={busy} disabled={!valid} onClick={() => void save()}>Save</Button>
      </>
    }>
      <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Evening lights" />
      <div>
        <div className="pwr-eyebrow" style={{ marginBottom: 7 }}>Days</div>
        <DaysPicker days={days} onToggle={toggleDay} />
      </div>
      <div style={{ display: 'flex', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div className="pwr-eyebrow" style={{ marginBottom: 7 }}>Turn on at</div>
          <Input type="time" value={onTime} onChange={(e) => setOnTime(e.target.value)} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 7 }}>
            <span className="pwr-eyebrow">Turn off at</span>
            <Switch checked={autoOff} onChange={(e) => setAutoOff(e.target.checked)} />
          </div>
          <Input type="time" value={offTime} disabled={!autoOff} onChange={(e) => setOffTime(e.target.value)} />
        </div>
      </div>
      <div>
        <div className="pwr-eyebrow" style={{ marginBottom: 7 }}>Apply</div>
        <SegmentedControl block value={kind} options={[{ value: 'scene', label: 'A scene' }, { value: 'lights', label: 'Specific lights' }]} onChange={(v) => setKind(v as LightScheduleTarget['kind'])} />
      </div>
      {kind === 'scene' ? (
        scenes.length ? (
          <Select label="Scene" value={sceneId} onChange={(e) => setSceneId(e.target.value)} options={scenes.map((s) => ({ value: s.id, label: s.name }))} />
        ) : (
          <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>No scenes yet — create one first, or schedule specific lights.</div>
        )
      ) : (
        <MemberEditor lights={lights} draft={draft} setDraft={setDraft} />
      )}
    </Overlay>
  );
}

export function LightSchedulesSection({ lights, scenes, canControl }: { lights: LightUnit[]; scenes: LightScene[]; canControl: boolean }) {
  const { data, refetch } = usePolling<LightSchedulesResponse>(api.lights.schedules, 0);
  const schedules = useMemo(() => data?.schedules ?? [], [data]);
  const [editing, setEditing] = useState<LightSchedule | null | undefined>(undefined);

  const toggle = (s: LightSchedule, enabled: boolean) => { void api.lights.updateSchedule(s.id, { enabled }).then(refetch); };

  return (
    <Card padded style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Icon name="calendar-clock" size={16} color="var(--solar)" />
        <div style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>Schedules</div>
        {canControl && <Button size="sm" variant="secondary" iconLeft={<Icon name="plus" size={14} />} onClick={() => setEditing(null)}>New</Button>}
      </div>
      {schedules.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>No light schedules yet. {canControl ? 'Schedule a scene or specific lights by time.' : ''}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {schedules.map((s, i) => (
            <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '11px 2px', borderTop: i === 0 ? 'none' : '1px solid var(--border-1)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 1 }}>{summarize(s, scenes)}</div>
              </div>
              {canControl && <button type="button" onClick={() => setEditing(s)} style={{ background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer', padding: 4 }}><Icon name="pencil" size={14} /></button>}
              <Switch checked={s.enabled} disabled={!canControl} onChange={(e) => toggle(s, e.target.checked)} />
            </div>
          ))}
        </div>
      )}
      {editing !== undefined && <ScheduleEditor lights={lights} scenes={scenes} sched={editing} onClose={() => setEditing(undefined)} onSaved={refetch} />}
    </Card>
  );
}
