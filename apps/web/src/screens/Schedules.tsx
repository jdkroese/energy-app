import { useMemo, useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import type { DeviceType, DeviceView, DevicesResponse, Schedule, SchedulesResponse, LightSchedule, LightScene, LightSchedulesResponse, ScenesResponse, BlindsResponse } from '../lib/types';
import { Icon, Button, SegmentedControl, Switch } from '../components/ui';
import { StaleBanner } from './_shared';
import { useAuth } from '../auth/AuthProvider';
import type { ShellContext } from '../components/shell/AppShell';
import { UnitScheduleBox } from '../components/schedules/UnitScheduleBox';
import { DayTrack, barsForWindow } from '../components/schedules/DayTrack';
import { EditRuleOverlay, type RulePeer } from '../components/schedules/EditRuleOverlay';
import { newRuleDraft, TYPE_LABEL } from '../lib/scheduleRules';

/* ============================================================================
 * Schedules — rendered under the "Schedules" tab on the Automations screen
 * (/automations?tab=schedules). One UnitScheduleBox per unit (or group) that holds
 * rules, grouped/sorted by device type, behind an All/Cooling/Heating/Lighting/
 * Circuits filter. Rules are created/edited through the shared EditRuleOverlay.
 * "New schedule" reveals every unit so a rule can be added to any of them.
 * ==========================================================================*/

const FILTERS: { value: 'all' | DeviceType; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'cooling', label: 'Cool' },
  { value: 'heating', label: 'Heat' },
  { value: 'lighting', label: 'Light' },
  { value: 'blinds', label: 'Blinds' },
  { value: 'circuit', label: 'Circ' },
];
const TYPE_ORDER: DeviceType[] = ['cooling', 'heating', 'lighting', 'blinds', 'circuit'];

/** Minimal schedulable-unit shape — climate devices and Tuya blinds both map to this. */
interface SchedUnit { id: string; name: string; type: DeviceType }

/**
 * SchedulesPanel — the Schedules screen body without page chrome (no page title /
 * MobileHeader). Rendered under the "Schedules" tab on the Automations screen. The
 * "New schedule" toggle button is rendered inline at the top of the panel so it
 * works identically on desktop and mobile.
 */
export function SchedulesPanel({ ctx }: { ctx: ShellContext }) {
  const { user } = useAuth();
  const canConfig = user?.role === 'admin';
  const wide = ctx.desktop;
  const { data, stale, updatedAt, refetch } = usePolling<SchedulesResponse>(api.schedules.list, 0);
  const { data: devData } = usePolling<DevicesResponse>(api.devices.list, 0);
  const { data: blindsData } = usePolling<BlindsResponse>(api.blinds.list, 0);
  const [filter, setFilter] = useState<'all' | DeviceType>('all');
  const [showAll, setShowAll] = useState(false);
  const [editing, setEditing] = useState<{ rule: Schedule; isNew: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [params, setParams] = useSearchParams();

  const schedules = useMemo(() => data?.schedules ?? [], [data]);
  // Schedulable units = the climate fleet + the Tuya blinds fleet, mapped to a
  // common {id, name, type} shape so the screen treats them identically.
  const units = useMemo<SchedUnit[]>(() => {
    const climate: SchedUnit[] = (devData?.devices ?? []).map((d) => ({ id: d.id, name: d.room || d.name, type: d.type }));
    const blinds: SchedUnit[] = (blindsData?.devices ?? []).map((b) => ({ id: b.id, name: b.room || b.name, type: 'blinds' as DeviceType }));
    return [...climate, ...blinds];
  }, [devData, blindsData]);
  const unitById = useMemo(() => new Map(units.map((u) => [u.id, u])), [units]);
  const unitName = (id: string) => unitById.get(id)?.name || id;

  // Strip only the deep-link keys, preserving anything else (e.g. ?tab=schedules
  // when this panel is hosted inside the Automations screen).
  const clearDeepLink = () => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('new');
      next.delete('edit');
      return next;
    }, { replace: true });
  };

  // Deep-link from a device page: ?new=<deviceId> opens a fresh rule for that unit.
  useEffect(() => {
    const newFor = params.get('new');
    if (newFor && unitById.has(newFor)) {
      const u = unitById.get(newFor)!;
      setEditing({ rule: newRuleDraft({ type: u.type, deviceId: u.id, name: u.name }), isNew: true });
      clearDeepLink();
    }
    const editId = params.get('edit');
    if (editId) {
      const s = schedules.find((x) => x.id === editId);
      if (s) { setEditing({ rule: s, isNew: false }); clearDeepLink(); }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, schedules.length, units.length]);

  // Rules per unit (unit-scoped only); group-scoped rules render under their group id.
  const rulesByUnit = useMemo(() => {
    const m = new Map<string, Schedule[]>();
    for (const s of schedules) {
      const key = s.scope.kind === 'unit' ? s.scope.deviceId : `group:${s.scope.groupId}`;
      const list = m.get(key) ?? [];
      list.push(s);
      m.set(key, list);
    }
    return m;
  }, [schedules]);

  // Which units to render as boxes: those with rules, or every device when "New schedule".
  const unitBoxes = useMemo(() => {
    const ids = new Set<string>();
    if (showAll) units.forEach((u) => ids.add(u.id));
    for (const s of schedules) if (s.scope.kind === 'unit') ids.add(s.scope.deviceId);
    const list = [...ids]
      .map((id) => ({ id, unit: unitById.get(id), rules: rulesByUnit.get(id) ?? [] }))
      .filter((u): u is { id: string; unit: SchedUnit; rules: Schedule[] } => !!u.unit)
      .filter((u) => filter === 'all' || u.unit.type === filter)
      .sort((a, b) => TYPE_ORDER.indexOf(a.unit.type) - TYPE_ORDER.indexOf(b.unit.type) || a.unit.type.localeCompare(b.unit.type));
    return list;
  }, [showAll, units, schedules, unitById, rulesByUnit, filter]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); } catch { /* surfaced via refetch */ } finally { setBusy(false); refetch(); }
  };
  const toggleEnabled = (s: Schedule, enabled: boolean) => run(() => api.schedules.update(s.id, { enabled }));
  const toggleDay = (s: Schedule, day: number) => {
    const days = s.days.includes(day) ? s.days.filter((x) => x !== day) : [...s.days, day].sort();
    return run(() => api.schedules.update(s.id, { days }));
  };
  const openAdd = (u: SchedUnit) =>
    setEditing({ rule: newRuleDraft({ type: u.type, deviceId: u.id, name: u.name }), isNew: true });

  const saveRule = async (rule: Schedule, copyTo: string[]) => {
    const { id: _id, ...payload } = rule;
    if (rule.id) await api.schedules.update(rule.id, payload);
    else await api.schedules.create(payload);
    // Copy-to-units: duplicate as independent unit-scoped rules.
    for (const deviceId of copyTo) {
      await api.schedules.create({ ...payload, scope: { kind: 'unit', deviceId } });
    }
    setEditing(null);
    refetch();
  };
  const deleteRule = (s: Schedule) => { setEditing(null); void run(() => api.schedules.remove(s.id)); };

  const peersFor = (rule: Schedule): RulePeer[] => {
    const ownId = rule.scope.kind === 'unit' ? rule.scope.deviceId : '';
    return units.filter((u) => u.type === rule.type && u.id !== ownId).map((u) => ({ id: u.id, name: u.name }));
  };

  const list = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {stale && <StaleBanner updatedAt={updatedAt} />}

      <div style={{ maxWidth: wide ? 420 : '100%' }}>
        <SegmentedControl size="sm" block options={FILTERS} value={filter} onChange={(v) => setFilter(v as 'all' | DeviceType)} />
      </div>

      {unitBoxes.length === 0 ? (
        <div style={{ textAlign: 'center', color: 'var(--text-3)', fontSize: 13, padding: 24, background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-lg)' }}>
          {units.length === 0 ? 'Connect a climate or Tuya integration to schedule units.' : `No ${filter === 'all' ? '' : TYPE_LABEL[filter].toLowerCase() + ' '}rules yet — add one to a unit.`}
        </div>
      ) : (
        unitBoxes.map((u) => (
          <UnitScheduleBox
            key={u.id}
            name={unitName(u.id)}
            type={u.unit.type}
            rules={u.rules}
            canConfig={!!canConfig}
            busy={busy}
            onAddRule={() => openAdd(u.unit)}
            onEditRule={(s) => setEditing({ rule: s, isNew: false })}
            onToggleEnabled={toggleEnabled}
            onToggleDay={toggleDay}
          />
        ))
      )}

      {/* Lighting — Tuya light/scene schedules (managed in Devices → Lighting) */}
      {(filter === 'all' || filter === 'lighting') && <LightingSchedulesCard canConfig={!!canConfig} />}

      {/* smart-override note */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, background: 'var(--solar-wash)', border: '1px solid rgba(46,230,160,0.18)', borderRadius: 'var(--radius-md)', padding: '10px 13px' }}>
        <Icon name="zap" size={15} color="var(--solar)" />
        <span style={{ fontSize: 11.5, color: 'var(--text-2)' }}>Smart rules run on top — surplus solar can start a window <span style={{ color: 'var(--text-1)' }}>early</span>. Schedules are the floor.</span>
      </div>
    </div>
  );

  const newBtn = canConfig && (
    <Button size="sm" variant="secondary" iconLeft={<Icon name="plus" size={15} />} onClick={() => setShowAll((v) => !v)}>
      {showAll ? 'Done adding' : 'New schedule'}
    </Button>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {newBtn && <div style={{ display: 'flex', justifyContent: wide ? 'flex-end' : 'flex-start' }}>{newBtn}</div>}
      {list}

      {editing && (
        <EditRuleOverlay
          rule={editing.rule}
          unitName={unitName(editing.rule.scope.kind === 'unit' ? editing.rule.scope.deviceId : '')}
          wide={wide}
          peers={peersFor(editing.rule)}
          allRules={schedules}
          canDelete={!!canConfig && !editing.isNew}
          onCancel={() => setEditing(null)}
          onSave={saveRule}
          onDelete={() => deleteRule(editing.rule)}
        />
      )}
    </div>
  );
}

/* ---- Lighting (Tuya) light/scene schedules — read + enable here; full editing
 *      lives in Devices → Lighting. Only renders when there are light schedules. */
const DOW_S = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
function lightSummary(s: LightSchedule, scenes: LightScene[]): string {
  const days = s.days.length === 7 ? 'Every day' : s.days.length === 0 ? 'No days' : [...s.days].sort().map((d) => DOW_S[d]).join(' ');
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

function LightingSchedulesCard({ canConfig }: { canConfig: boolean }) {
  const { data, refetch } = usePolling<LightSchedulesResponse>(api.lights.schedules, 0);
  const { data: scenesData } = usePolling<ScenesResponse>(api.lights.scenes, 0);
  const schedules = data?.schedules ?? [];
  const scenes = scenesData?.scenes ?? [];
  if (schedules.length === 0) return null;
  const toggle = (s: LightSchedule, enabled: boolean) => { void api.lights.updateSchedule(s.id, { enabled }).then(refetch); };
  const del = (s: LightSchedule) => { void api.lights.deleteSchedule(s.id).then(refetch); };
  return (
    <div style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '12px 14px', borderBottom: '1px solid var(--border-1)' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--home)' }} />
        <Icon name="lightbulb" size={15} color="var(--home)" />
        <span style={{ fontSize: 13.5, fontWeight: 600, flex: 1 }}>Lighting</span>
        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>edit in Devices → Lighting</span>
      </div>
      {schedules.map((s, i) => (
        <div key={s.id} style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '11px 14px', borderTop: i === 0 ? 'none' : '1px solid var(--border-1)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 1 }}>{lightSummary(s, scenes)}</div>
            </div>
            {canConfig && <button type="button" aria-label="Delete schedule" onClick={() => del(s)} style={{ background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer', padding: 4 }}><Icon name="trash-2" size={14} /></button>}
            <Switch checked={s.enabled} disabled={!canConfig} onChange={(e) => toggle(s, e.target.checked)} />
          </div>
          <DayTrack bars={barsForWindow(s.onTime, s.offTime)} dim={!s.enabled} title={lightSummary(s, scenes)} height={16} />
        </div>
      ))}
    </div>
  );
}
