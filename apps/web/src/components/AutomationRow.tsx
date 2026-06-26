import { Icon, Switch } from './ui';
import type { Automation } from '../lib/types';

/* ============================================================================
 * AutomationRow — the shared "Solar-surplus pre-cool · Automation · <type>"
 * control: bolt icon + name + subtitle, a Shadow / Auto authority selector, and
 * the master on/off toggle. It is the SAME automation object wherever it shows
 * (the Automations screen and the Devices hub), and is read/write in both — so
 * a change here reflects everywhere. Pure presentational; the parent owns the
 * write via `onSave` (→ api.automations.update) and any optimistic state.
 * ==========================================================================*/

export function AutomationRow({
  automation,
  canWrite,
  onSave,
  subtitle = 'Automation · climate',
  dim = false,
  icon = 'zap',
  iconColor = 'var(--battery)',
}: {
  automation: Automation;
  canWrite: boolean;
  onSave: (patch: Partial<Automation>) => void;
  subtitle?: string;
  /** Visually de-emphasise when control is disarmed (the rule can't act). */
  dim?: boolean;
  /** Leading solar-surplus glyph — the bolt (`zap`). Caller picks per type. */
  icon?: string;
  /** Bolt hue — blue (`--battery`) = pre-cool, orange (`--grid`) = pre-heat. */
  iconColor?: string;
}) {
  const { name, authority, enabled } = automation;
  const authBtn = (active: boolean, solid: boolean) =>
    ({
      fontSize: 11,
      padding: '5px 11px',
      borderRadius: 8,
      cursor: canWrite ? 'pointer' : 'default',
      fontWeight: 600,
      border: solid ? 'none' : '1px solid var(--border-1)',
      background: active ? (solid ? 'var(--solar)' : 'var(--surface-3)') : 'var(--surface-3)',
      color: active ? (solid ? '#06090b' : 'var(--text-1)') : 'var(--text-3)',
    }) as const;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, opacity: dim ? 0.6 : 1 }}>
      <Icon name={icon} size={19} color={iconColor} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
        <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{subtitle}</div>
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flex: 'none' }}>
        <button type="button" disabled={!canWrite} onClick={() => onSave({ authority: 'shadow' })} style={authBtn(authority === 'shadow', false)}>Shadow</button>
        <button type="button" disabled={!canWrite} onClick={() => onSave({ authority: 'auto' })} style={authBtn(authority === 'auto', true)}>Auto</button>
        <Switch checked={enabled} disabled={!canWrite} onChange={(e) => onSave({ enabled: e.target.checked })} />
      </div>
    </div>
  );
}
