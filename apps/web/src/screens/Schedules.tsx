import { useMemo, useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import type { DeviceType, DevicesResponse, Schedule, SchedulesResponse, LightsResponse, ScenesResponse, BlindsResponse, ConfiguredResponse, SpeakersResponse } from '../lib/types';
import { Icon, Button, SegmentedControl } from '../components/ui';
import { StaleBanner } from './_shared';
import { useAuth } from '../auth/AuthProvider';
import type { ShellContext } from '../components/shell/AppShell';
import { UnitScheduleBox } from '../components/schedules/UnitScheduleBox';
import { EditRuleOverlay, type RulePeer } from '../components/schedules/EditRuleOverlay';
import { LightSchedulesSection } from '../components/lights/ScenesAndSchedules';
import { RadioSchedulesSection } from '../components/radio/Radio';
import { newRuleDraft, TYPE_LABEL } from '../lib/scheduleRules';
import { hasPowerSwitch } from '../lib/capabilities';

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
  { value: 'speakers', label: 'Music' },
];

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
  const { data: configuredData } = usePolling<ConfiguredResponse>(api.devices.configured, 0);
  const { data: lightsData } = usePolling<LightsResponse>(api.lights.list, 0);
  const { data: lightScenesData } = usePolling<ScenesResponse>(api.lights.scenes, 0);
  const { data: speakersData } = usePolling<SpeakersResponse>(api.speakers.list, 0);
  const speakers = useMemo(
    () => [...(speakersData?.speakers ?? [])].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })),
    [speakersData],
  );
  const lights = useMemo(
    () => [...(lightsData?.devices ?? [])].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })),
    [lightsData],
  );
  const lightScenes = lightScenesData?.scenes ?? [];
  const [filter, setFilter] = useState<'all' | DeviceType>('all');
  const [showAll, setShowAll] = useState(false);
  const [editing, setEditing] = useState<{ rule: Schedule; isNew: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [params, setParams] = useSearchParams();

  const schedules = useMemo(() => data?.schedules ?? [], [data]);
  // Configured generic devices that have a power on/off switch are schedulable as
  // 'circuit' units (fan plugs, ceiling fans, …). Keep a id→capabilities map so the
  // editor can offer the device's fan speed / direction. Lighting is folded into the
  // lights fleet (scheduled separately), so skip typeId === 'lighting'.
  const circuitDevices = useMemo(
    () => (configuredData?.devices ?? []).filter((d) => d.typeId !== 'lighting' && hasPowerSwitch(d.capabilities)),
    [configuredData],
  );
  const capsById = useMemo(() => new Map(circuitDevices.map((d) => [d.id, d.capabilities])), [circuitDevices]);
  // Schedulable units = the climate fleet + the Tuya blinds fleet + switchable generic
  // (circuit) devices, mapped to a common {id, name, type} shape so the screen treats
  // them identically.
  const units = useMemo<SchedUnit[]>(() => {
    const climate: SchedUnit[] = (devData?.devices ?? []).map((d) => ({ id: d.id, name: d.room || d.name, type: d.type }));
    const blinds: SchedUnit[] = (blindsData?.devices ?? []).map((b) => ({ id: b.id, name: b.room || b.name, type: 'blinds' as DeviceType }));
    const circuits: SchedUnit[] = circuitDevices.map((d) => ({ id: d.id, name: d.name, type: 'circuit' as DeviceType }));
    return [...climate, ...blinds, ...circuits].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  }, [devData, blindsData, circuitDevices]);
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
      .sort((a, b) => a.unit.name.localeCompare(b.unit.name, undefined, { numeric: true, sensitivity: 'base' }));
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

      {/* Lighting — full Tuya light/scene scheduling, same editor as Devices → Lighting */}
      {(filter === 'all' || filter === 'lighting') && lights.length > 0 && (
        <LightSchedulesSection lights={lights} scenes={lightScenes} canControl={!!canConfig} heading="Lighting" icon="lightbulb" iconColor="var(--home)" />
      )}

      {/* Music — radio station OR Spotify context schedules (play on chosen speakers). */}
      {(filter === 'all' || filter === 'speakers') && speakersData?.enabled && (
        <RadioSchedulesSection speakers={speakers} canControl={!!canConfig} wide={wide} />
      )}

      {/* smart-override note */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, background: 'var(--solar-wash)', border: '1px solid var(--border-solar-soft)', borderRadius: 'var(--radius-md)', padding: '10px 13px' }}>
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
          capabilities={editing.rule.scope.kind === 'unit' ? capsById.get(editing.rule.scope.deviceId) : undefined}
          canDelete={!!canConfig && !editing.isNew}
          onCancel={() => setEditing(null)}
          onSave={saveRule}
          onDelete={() => deleteRule(editing.rule)}
        />
      )}
    </div>
  );
}
