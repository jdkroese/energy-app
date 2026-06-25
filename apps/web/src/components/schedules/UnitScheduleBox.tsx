import { Card, Icon } from '../ui';
import type { DeviceType, Schedule } from '../../lib/types';
import { TYPE_COLOR, TYPE_LABEL } from '../../lib/scheduleRules';
import { ScheduleRuleObject } from './ScheduleRuleObject';

/* ============================================================================
 * UnitScheduleBox — one card per unit/group, titled "<name> — <Device type>",
 * holding that scope's rules as ScheduleRuleObjects. The title is NOT editable
 * (it's the unit); rule names are (in the overlay). Footer notes the no-overlap
 * guarantee. Used identically on the Schedules page and the device-detail box.
 * ==========================================================================*/

export function UnitScheduleBox({
  name,
  type,
  rules,
  canConfig,
  busy,
  showAxis = true,
  showFootnote = true,
  onAddRule,
  onEditRule,
  onToggleEnabled,
  onToggleDay,
}: {
  name: string;
  type: DeviceType;
  rules: Schedule[];
  canConfig: boolean;
  busy?: boolean;
  showAxis?: boolean;
  showFootnote?: boolean;
  onAddRule: () => void;
  onEditRule: (s: Schedule) => void;
  onToggleEnabled: (s: Schedule, enabled: boolean) => void;
  onToggleDay: (s: Schedule, storeDay: number) => void;
}) {
  const dot = TYPE_COLOR[type];
  return (
    <Card padded style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {/* HEADER — unit name + device type (not editable) + add-rule */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, paddingBottom: 4 }}>
        <span style={{ width: 8, height: 8, borderRadius: 999, background: dot, flex: 'none', boxShadow: `0 0 6px ${dot}` }} />
        <span style={{ fontSize: 13.5, fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {name} — {TYPE_LABEL[type]}
        </span>
        {rules.length > 0 && (
          <span style={{ fontSize: 11, color: 'var(--text-3)', background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 999, padding: '2px 8px' }}>
            {rules.length} rule{rules.length > 1 ? 's' : ''}
          </span>
        )}
        {canConfig && (
          <button type="button" onClick={onAddRule} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, color: 'var(--solar)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}>
            <Icon name="plus" size={14} /> Add rule
          </button>
        )}
      </div>

      {rules.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text-3)', padding: '8px 0 4px' }}>No rules yet — add one to run this unit on a weekly window.</div>
      ) : (
        rules.map((s) => (
          <ScheduleRuleObject
            key={s.id}
            s={s}
            canConfig={canConfig}
            busy={busy}
            showAxis={showAxis}
            onToggleEnabled={(en) => onToggleEnabled(s, en)}
            onToggleDay={(day) => onToggleDay(s, day)}
            onEdit={() => onEditRule(s)}
          />
        ))
      )}

      {showFootnote && rules.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 10.5, color: 'var(--text-3)' }}>
          <Icon name="shield-check" size={12} color="var(--text-3)" />
          Rules for one unit can’t overlap — the editor blocks colliding windows.
        </div>
      )}
    </Card>
  );
}
