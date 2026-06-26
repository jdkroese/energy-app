import { Icon, Switch } from './ui';
import type { Automation } from '../lib/types';

/* ============================================================================
 * AutomationRow — the shared "Solar-surplus pre-cool · Automation · <type>"
 * control: an icon + name + subtitle and the master on/off toggle. It is the
 * SAME automation object wherever it shows (the Automations screen and the
 * Cooling/Heating Devices hubs), and is read/write in both — so a change here
 * reflects everywhere. Pure presentational; the parent owns the write via
 * `onSave` (→ api.automations.update) and any optimistic state.
 *
 * (The Shadow/Auto authority selector was removed system-wide 2026-06-26: an
 * enabled automation under armed control now always acts — there is no dry-run.)
 * ==========================================================================*/

export function AutomationRow({
  automation,
  canWrite,
  onSave,
  subtitle = 'Automation · climate',
  icon = 'zap',
  iconColor = 'var(--battery)',
  dim = false,
}: {
  automation: Automation;
  canWrite: boolean;
  onSave: (patch: Partial<Automation>) => void;
  subtitle?: string;
  /** Lucide icon name — the surplus bolt ('zap') for both cool and heat. */
  icon?: string;
  /** Bolt hue — cooling --battery (blue, default), heating --grid (orange). */
  iconColor?: string;
  /** Visually de-emphasise when control is disarmed (the rule can't act). */
  dim?: boolean;
}) {
  const { name, enabled } = automation;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, opacity: dim ? 0.6 : 1 }}>
      <Icon name={icon} size={19} color={iconColor} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
        <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{subtitle}</div>
      </div>
      <Switch checked={enabled} disabled={!canWrite} onChange={(e) => onSave({ enabled: e.target.checked })} />
    </div>
  );
}
