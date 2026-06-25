import { useMemo, useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import type { DeviceType, DeviceView, DevicesResponse, Schedule, SchedulesResponse } from '../lib/types';
import { Icon, Button, Eyebrow, SegmentedControl } from '../components/ui';
import { MobileHeader, Avatar, StaleBanner } from './_shared';
import { useAuth } from '../auth/AuthProvider';
import type { ShellContext } from '../components/shell/AppShell';
import { UnitScheduleBox } from '../components/schedules/UnitScheduleBox';
import { EditRuleOverlay, type RulePeer } from '../components/schedules/EditRuleOverlay';
import { newRuleDraft, TYPE_LABEL } from '../lib/scheduleRules';

/* ============================================================================
 * Schedules (/schedules) — one UnitScheduleBox per unit (or group) that holds
 * rules, grouped/sorted by device type, behind an All/Cooling/Heating/Lighting/
 * Circuits filter. Rules are created/edited through the shared EditRuleOverlay.
 * "New schedule" reveals every unit so a rule can be added to any of them.
 * ==========================================================================*/

const FILTERS: { value: 'all' | DeviceType; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'cooling', label: 'Cool' },
  { value: 'heating', label: 'Heat' },
  { value: 'lighting', label: 'Light' },
  { value: 'circuit', label: 'Circ' },
];
const TYPE_ORDER: DeviceType[] = ['cooling', 'heating', 'lighting', 'circuit'];

export function Schedules({ ctx }: { ctx: ShellContext }) {
  const { user } = useAuth();
  const canConfig = user?.role === 'admin';
  const wide = ctx.desktop;
  const { data, stale, updatedAt, refetch } = usePolling<SchedulesResponse>(api.schedules.list, 0);
  const { data: devData } = usePolling<DevicesResponse>(api.devices.list, 0);
  const [filter, setFilter] = useState<'all' | DeviceType>('all');
  const [showAll, setShowAll] = useState(false);
  const [editing, setEditing] = useState<{ rule: Schedule; isNew: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [params, setParams] = useSearchParams();

  const schedules = useMemo(() => data?.schedules ?? [], [data]);
  const devices = useMemo(() => devData?.devices ?? [], [devData]);
  const deviceById = useMemo(() => new Map(devices.map((d) => [d.id, d])), [devices]);
  const unitName = (id: string) => deviceById.get(id)?.room || deviceById.get(id)?.name || id;

  // Deep-link from a device page: ?new=<deviceId> opens a fresh rule for that unit.
  useEffect(() => {
    const newFor = params.get('new');
    if (newFor && deviceById.has(newFor)) {
      const dev = deviceById.get(newFor)!;
      setEditing({ rule: newRuleDraft({ type: dev.type, deviceId: dev.id, name: dev.room || dev.name }), isNew: true });
      setParams({}, { replace: true });
    }
    const editId = params.get('edit');
    if (editId) {
      const s = schedules.find((x) => x.id === editId);
      if (s) { setEditing({ rule: s, isNew: false }); setParams({}, { replace: true }); }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, schedules.length, devices.length]);

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
    if (showAll) devices.forEach((d) => ids.add(d.id));
    for (const s of schedules) if (s.scope.kind === 'unit') ids.add(s.scope.deviceId);
    const list = [...ids]
      .map((id) => ({ id, dev: deviceById.get(id), rules: rulesByUnit.get(id) ?? [] }))
      .filter((u): u is { id: string; dev: DeviceView; rules: Schedule[] } => !!u.dev)
      .filter((u) => filter === 'all' || u.dev.type === filter)
      .sort((a, b) => TYPE_ORDER.indexOf(a.dev.type) - TYPE_ORDER.indexOf(b.dev.type) || a.dev.type.localeCompare(b.dev.type));
    return list;
  }, [showAll, devices, schedules, deviceById, rulesByUnit, filter]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); } catch { /* surfaced via refetch */ } finally { setBusy(false); refetch(); }
  };
  const toggleEnabled = (s: Schedule, enabled: boolean) => run(() => api.schedules.update(s.id, { enabled }));
  const toggleDay = (s: Schedule, day: number) => {
    const days = s.days.includes(day) ? s.days.filter((x) => x !== day) : [...s.days, day].sort();
    return run(() => api.schedules.update(s.id, { days }));
  };
  const openAdd = (dev: DeviceView) =>
    setEditing({ rule: newRuleDraft({ type: dev.type, deviceId: dev.id, name: dev.room || dev.name }), isNew: true });

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
    return devices.filter((d) => d.type === rule.type && d.id !== ownId).map((d) => ({ id: d.id, name: d.room || d.name }));
  };

  const list = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {stale && <StaleBanner updatedAt={updatedAt} />}

      <div style={{ maxWidth: wide ? 420 : '100%' }}>
        <SegmentedControl size="sm" block options={FILTERS} value={filter} onChange={(v) => setFilter(v as 'all' | DeviceType)} />
      </div>

      {unitBoxes.length === 0 ? (
        <div style={{ textAlign: 'center', color: 'var(--text-3)', fontSize: 13, padding: 24, background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-lg)' }}>
          {devices.length === 0 ? 'Connect a climate integration to schedule units.' : `No ${filter === 'all' ? '' : TYPE_LABEL[filter].toLowerCase() + ' '}rules yet — add one to a unit.`}
        </div>
      ) : (
        unitBoxes.map((u) => (
          <UnitScheduleBox
            key={u.id}
            name={unitName(u.id)}
            type={u.dev.type}
            rules={u.rules}
            canConfig={!!canConfig}
            busy={busy}
            onAddRule={() => openAdd(u.dev)}
            onEditRule={(s) => setEditing({ rule: s, isNew: false })}
            onToggleEnabled={toggleEnabled}
            onToggleDay={toggleDay}
          />
        ))
      )}

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
    <>
      {wide ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 760, margin: '0 auto', width: '100%' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
            <div><Eyebrow>Automation</Eyebrow><h1 style={{ fontSize: 24, fontWeight: 600, letterSpacing: '-.01em', margin: '2px 0 0' }}>Schedules</h1></div>
            {newBtn}
          </div>
          {list}
        </div>
      ) : (
        <>
          <MobileHeader eyebrow="Automation" title="Schedules" right={<Avatar />} />
          <div style={{ padding: '8px 14px 22px', display: 'flex', flexDirection: 'column', gap: 12 }}>{newBtn}{list}</div>
        </>
      )}

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
    </>
  );
}
