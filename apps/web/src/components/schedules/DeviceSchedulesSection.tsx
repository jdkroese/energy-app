import { useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import type { Capability, Schedule, SchedulesResponse } from '../../lib/types';
import { Card, Icon, Button } from '../ui';
import { ScheduleRuleObject } from './ScheduleRuleObject';
import { EditRuleOverlay } from './EditRuleOverlay';
import { newRuleDraft } from '../../lib/scheduleRules';

/* ============================================================================
 * DeviceSchedulesSection — the consolidated "Schedules" card that sits UNDER the
 * device list on the generic (Switching / Fan / custom) and Blinds device tabs.
 * Visually + behaviourally mirrors the Lighting tab's LightSchedulesSection: a
 * Card titled "Schedules" with a calendar-clock icon + a "New" button, then a
 * flat list of rule rows (name · summary · per-day toggles · 24h track).
 *
 * Because a tab can hold MULTIPLE devices, rules are grouped by unit under a small
 * device-name subheader, all inside the single card. Rules are CRUD'd through the
 * shared Schedule model (api.schedules.*) and edited via the shared
 * EditRuleOverlay — the same store the central Schedules page reads.
 * ==========================================================================*/

interface SchedUnit {
  id: string;
  name: string;
  capabilities?: Capability[];
}

export function DeviceSchedulesSection({
  type,
  units,
  canConfig,
  wide,
  title = 'Schedules',
}: {
  type: 'circuit' | 'blinds';
  units: SchedUnit[];
  canConfig: boolean;
  wide: boolean;
  title?: string;
}) {
  const { data, refetch } = usePolling<SchedulesResponse>(api.schedules.list, 0);
  const allRules = useMemo(() => data?.schedules ?? [], [data]);

  // Only this tab's units, sorted alphabetically (numeric, base sensitivity).
  const sortedUnits = useMemo(
    () => [...units].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })),
    [units],
  );
  const unitIds = useMemo(() => new Set(units.map((u) => u.id)), [units]);

  // Rules scoped to one of this tab's units.
  const rules = useMemo(
    () => allRules.filter((s) => s.scope.kind === 'unit' && unitIds.has(s.scope.deviceId)),
    [allRules, unitIds],
  );
  const rulesForUnit = (unitId: string) => rules.filter((s) => s.scope.kind === 'unit' && s.scope.deviceId === unitId);

  const [editing, setEditing] = useState<{ rule: Schedule; unit: SchedUnit; isNew: boolean } | null>(null);
  // Device picker (only when a tab holds >1 schedulable unit and "New" is tapped).
  const [picking, setPicking] = useState(false);

  // ---- handlers (mirror DeviceDetail.tsx) -----------------------------------
  const toggleRuleEnabled = (s: Schedule, enabled: boolean) =>
    void api.schedules.update(s.id, { enabled }).finally(refetch);
  const toggleRuleDay = (s: Schedule, day: number) => {
    const days = s.days.includes(day) ? s.days.filter((x) => x !== day) : [...s.days, day].sort();
    void api.schedules.update(s.id, { days }).finally(refetch);
  };
  const saveRule = async (rule: Schedule, copyTo: string[]) => {
    const { id: _rid, ...payload } = rule;
    if (rule.id) await api.schedules.update(rule.id, payload);
    else await api.schedules.create(payload);
    for (const deviceId of copyTo) await api.schedules.create({ ...payload, scope: { kind: 'unit', deviceId } });
    setEditing(null);
    refetch();
  };
  const deleteRule = (s: Schedule) => { setEditing(null); void api.schedules.remove(s.id).finally(refetch); };

  const openNewFor = (unit: SchedUnit) => {
    setPicking(false);
    setEditing({ rule: newRuleDraft({ type, deviceId: unit.id, name: unit.name }), isNew: true, unit });
  };
  const onNew = () => {
    if (sortedUnits.length === 1) openNewFor(sortedUnits[0]);
    else setPicking(true);
  };

  // A tab with no schedulable devices shows nothing at all.
  if (units.length === 0) return null;

  const editUnit = editing?.unit;

  return (
    <Card padded style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* HEADER — matches LightSchedulesSection */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Icon name="calendar-clock" size={16} color="var(--solar)" />
        <div style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>{title}</div>
        {canConfig && (
          <Button size="sm" variant="secondary" iconLeft={<Icon name="plus" size={14} />} onClick={onNew}>New</Button>
        )}
      </div>

      {rules.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
          No schedules yet.{' '}
          {canConfig ? (type === 'blinds' ? 'Schedule an open/close window by time.' : 'Schedule a device on/off window by time.') : ''}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {sortedUnits.map((u) => {
            const unitRules = rulesForUnit(u.id);
            if (unitRules.length === 0) return null;
            return (
              <div key={u.id} style={{ display: 'flex', flexDirection: 'column' }}>
                <div className="pwr-eyebrow" style={{ marginTop: 6, marginBottom: 2 }}>{u.name}</div>
                {unitRules.map((s) => (
                  <ScheduleRuleObject
                    key={s.id}
                    s={s}
                    canConfig={canConfig}
                    busy={false}
                    onToggleEnabled={(en) => toggleRuleEnabled(s, en)}
                    onToggleDay={(day) => toggleRuleDay(s, day)}
                    onEdit={() => setEditing({ rule: s, unit: u, isNew: false })}
                  />
                ))}
              </div>
            );
          })}
        </div>
      )}

      {/* DEVICE PICKER — only when a tab holds multiple schedulable units. */}
      {picking && (
        <DevicePicker units={sortedUnits} wide={wide} onPick={openNewFor} onCancel={() => setPicking(false)} />
      )}

      {/* EDITOR — rendered once for the section. */}
      {editing && editUnit && (
        <EditRuleOverlay
          rule={editing.rule}
          unitName={editUnit.name}
          wide={wide}
          peers={[]}
          allRules={rules}
          capabilities={type === 'circuit' ? editUnit.capabilities : undefined}
          canDelete={canConfig && !editing.isNew}
          onCancel={() => setEditing(null)}
          onSave={saveRule}
          onDelete={() => deleteRule(editing.rule)}
        />
      )}
    </Card>
  );
}

/* ---- device picker (a small dark modal, Power design system) -------------- */
function DevicePicker({ units, wide, onPick, onCancel }: {
  units: SchedUnit[]; wide: boolean; onPick: (u: SchedUnit) => void; onCancel: () => void;
}) {
  return (
    <div
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-label="Choose a device to schedule"
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,.5)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: wide ? 'center' : 'flex-end', justifyContent: 'center', padding: wide ? 16 : 0, animation: 'ruleFade .16s ease' }}
    >
      <style>{`@keyframes ruleFade { from { opacity: 0 } to { opacity: 1 } }`}</style>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 420, maxHeight: '80vh', display: 'flex', flexDirection: 'column',
          background: 'var(--surface-1)', border: '1px solid var(--border-2)',
          borderRadius: wide ? 18 : '18px 18px 0 0', boxShadow: '0 -8px 40px rgba(0,0,0,.5)',
        }}
      >
        {!wide && <div style={{ width: 38, height: 4, borderRadius: 999, background: 'var(--border-3)', margin: '10px auto 2px' }} />}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '15px 18px', borderBottom: '1px solid var(--border-1)' }}>
          <Icon name="calendar-clock" size={16} color="var(--solar)" />
          <div style={{ fontSize: 14.5, fontWeight: 600, flex: 1 }}>Schedule which device?</div>
          <button type="button" aria-label="Cancel" onClick={onCancel} style={{ background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer', padding: 4 }}><Icon name="x" size={18} /></button>
        </div>
        <div style={{ padding: 12, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {units.map((u) => (
            <button
              key={u.id}
              type="button"
              onClick={() => onPick(u)}
              style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: '11px 12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-2)', background: 'var(--surface-2)', color: 'var(--text-1)', cursor: 'pointer', fontSize: 13.5, fontWeight: 500 }}
            >
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.name}</span>
              <Icon name="chevron-right" size={15} color="var(--text-3)" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
