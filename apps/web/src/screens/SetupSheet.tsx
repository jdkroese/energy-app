import { useMemo, useState } from 'react';
import type { Capability, CapabilityKind, CapabilityOverride, CustomDeviceType, DiscoveredDevice } from '../lib/types';
import { Button, Icon, Input, Select, Modal } from '../components/ui';
import { GenericControl } from '../components/GenericControl';
import { SETUP_BUILTIN_TYPES } from '../lib/deviceTypes';
import { api } from '../lib/api';

/* ============================================================================
 * SetupSheet — the SET-UP flow for a discovered device. Opens from the inbox
 * "Set up" button (and a "Re-classify" affordance). Desktop = right-side panel;
 * mobile = bottom sheet. Fields:
 *   • Name (prefilled from device name)
 *   • Type — inferred proposedType preselected + editable (built-in + custom +
 *     "+ New type")
 *   • Detected controls — the generic renderer in a live PREVIEW with a working
 *     Test (actuate to confirm the right physical device)
 *   • Advanced · datapoints (collapsed) — the DP-remap editor (kind/label/hide/
 *     read-only), saved as capOverrides
 *   • Add → POST setup → device leaves the inbox and appears in its group.
 * The inferred roomGuess is shown read-only (rooms are Phase 3; nothing assignable).
 * ==========================================================================*/

const KINDS: CapabilityKind[] = ['switch', 'range', 'enum', 'action', 'color', 'measure', 'status'];
const ICON_CHOICES = ['plug', 'toggle-right', 'lock', 'siren', 'fan', 'thermometer', 'lightbulb', 'radar', 'door-open', 'zap', 'circle-help'];

const eyebrow = { fontSize: 10.5, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase' as const, color: 'var(--text-3)' };

/** Build the inferred proposedType's matching typeId. Generic devices map to the
 *  'switching' bucket by default; the user can re-point to any built-in/custom. */
function inferTypeId(d: DiscoveredDevice, customTypes: CustomDeviceType[]): string {
  const label = d.proposedType.label.toLowerCase();
  // A few proposed labels map onto built-in tabs; everything else → switching.
  if (label.includes('light') || label.includes('dimmer')) return 'lighting';
  if (label.includes('blind')) return 'blinds';
  // Plug / switch / fan / lock / siren / sensor / unknown → generic Switching bucket,
  // unless a custom type with a matching label already exists.
  const custom = customTypes.find((c) => c.label.toLowerCase() === label);
  if (custom) return custom.id;
  return 'switching';
}

export interface SetupSheetProps {
  device: DiscoveredDevice;
  wide: boolean;
  customTypes: CustomDeviceType[];
  /** Re-classify mode pre-fills the existing assignment (name + typeId). */
  initialName?: string;
  initialTypeId?: string;
  onClose: () => void;
  /** Called after a successful setup (parent refetches inbox + configured). */
  onDone: (typeLabel: string) => void;
  /** Called after a new custom type is minted (parent refetches the type list). */
  onTypesChanged: () => void;
}

export function SetupSheet({ device, wide, customTypes, initialName, initialTypeId, onClose, onDone, onTypesChanged }: SetupSheetProps) {
  const [name, setName] = useState(initialName ?? device.name);
  const [typeId, setTypeId] = useState(initialTypeId ?? inferTypeId(device, customTypes));
  const [overrides, setOverrides] = useState<Record<string, CapabilityOverride>>({});
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // "New type" sub-form.
  const [newType, setNewType] = useState<{ label: string; icon: string } | null>(null);

  // Live preview capabilities = inference with the in-progress overrides applied.
  const previewCaps = useMemo(() => applyOverrides(device.capabilities, overrides), [device.capabilities, overrides]);

  const typeOptions = useMemo(
    () => [
      ...SETUP_BUILTIN_TYPES.map((m) => ({ value: m.type, label: m.label })),
      ...customTypes.map((c) => ({ value: c.id, label: `${c.label} (custom)` })),
    ],
    [customTypes],
  );

  const overrideList = (): CapabilityOverride[] =>
    Object.values(overrides).filter((o) => o.kind || o.label || o.hidden || o.readOnly);

  // Test = actuate one capability against the (not-yet-configured) real device.
  const test = (dp: string, kind: CapabilityKind, value: unknown) => api.devices.commandCap(device.id, dp, kind, value);

  const createType = async () => {
    if (!newType || !newType.label.trim()) return;
    setBusy(true);
    try {
      const res = await api.devices.createCustomType(newType.label.trim(), newType.icon);
      setTypeId(res.customDeviceType.id);
      setNewType(null);
      onTypesChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    if (!name.trim()) { setErr('Name is required'); return; }
    setBusy(true);
    setErr(null);
    try {
      await api.devices.setup(device.id, { typeId, name: name.trim(), capOverrides: overrideList() });
      const label =
        SETUP_BUILTIN_TYPES.find((m) => m.type === typeId)?.label ??
        customTypes.find((c) => c.id === typeId)?.label ??
        'group';
      onDone(label);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  const setOv = (dp: string, patch: Partial<CapabilityOverride>) =>
    setOverrides((o) => ({ ...o, [dp]: { ...o[dp], dp, ...patch } }));

  const body = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
        <span style={{ width: 38, height: 38, borderRadius: 10, display: 'grid', placeItems: 'center', background: 'var(--surface-3)', color: 'var(--text-2)', flex: 'none' }}>
          <Icon name={device.proposedType.icon} size={19} />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-1)' }}>Set up device</div>
          <div className="pwr-mono" style={{ fontSize: 10.5, color: 'var(--text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            Tuya · {device.category || '?'}{device.productName ? ` · ${device.productName}` : ''}
          </div>
        </div>
        <button type="button" aria-label="Close" onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-3)', padding: 4 }}><Icon name="x" size={18} /></button>
      </div>

      {/* Name */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={eyebrow}>Name</span>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Device name" />
      </div>

      {/* Type */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={eyebrow}>Type</span>
        {newType === null ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <div style={{ flex: 1 }}>
              <Select value={typeId} options={typeOptions} onChange={(e) => setTypeId(e.target.value)} />
            </div>
            <Button size="sm" variant="secondary" iconLeft={<Icon name="plus" size={13} />} onClick={() => setNewType({ label: '', icon: 'plug' })}>New type</Button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', padding: 10 }}>
            <Input label="New type name" value={newType.label} onChange={(e) => setNewType({ ...newType, label: e.target.value })} placeholder="e.g. Smart lock" />
            <div>
              <span style={eyebrow}>Icon</span>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                {ICON_CHOICES.map((ic) => (
                  <button key={ic} type="button" aria-label={ic} onClick={() => setNewType({ ...newType, icon: ic })}
                    style={{ width: 34, height: 34, borderRadius: 8, display: 'grid', placeItems: 'center', cursor: 'pointer',
                      border: `1px solid ${newType.icon === ic ? 'var(--solar)' : 'var(--border-2)'}`,
                      background: newType.icon === ic ? 'var(--solar-wash)' : 'var(--surface-2)', color: 'var(--text-2)' }}>
                    <Icon name={ic} size={16} />
                  </button>
                ))}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Button size="sm" variant="ghost" onClick={() => setNewType(null)}>Cancel</Button>
              <Button size="sm" variant="primary" disabled={!newType.label.trim() || busy} onClick={createType}>Create type</Button>
            </div>
          </div>
        )}
        {device.roomGuess && (
          <div style={{ fontSize: 11, color: 'var(--text-3)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <Icon name="map-pin" size={12} color="var(--text-3)" />
            Room hint: <span style={{ textTransform: 'capitalize', color: 'var(--text-2)' }}>{device.roomGuess}</span> (rooms come later)
          </div>
        )}
      </div>

      {/* Detected controls — live preview + Test */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={eyebrow}>Detected controls</span>
        <div style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', padding: 12 }}>
          <GenericControl capabilities={previewCaps} values={{}} onWrite={test} variant="detail" />
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-3)' }}>Actuate a control to confirm this is the right physical device.</div>
      </div>

      {/* Advanced · datapoints (DP-remap) */}
      <div>
        <button type="button" onClick={() => setAdvanced((a) => !a)}
          style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px 2px', color: 'var(--text-2)' }}>
          <Icon name={advanced ? 'chevron-down' : 'chevron-right'} size={15} />
          <span style={eyebrow}>Advanced · datapoints</span>
          <span style={{ fontSize: 11, color: 'var(--text-3)', marginLeft: 'auto' }}>{device.capabilities.length} DP{device.capabilities.length === 1 ? '' : 's'}</span>
        </button>
        {advanced && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
            {device.capabilities.map((cap) => {
              const ov = overrides[cap.dp] ?? { dp: cap.dp };
              const kind = ov.kind ?? cap.kind;
              const hidden = ov.hidden ?? false;
              const readOnly = ov.readOnly ?? cap.readOnly;
              return (
                <div key={cap.key} style={{ display: 'flex', flexDirection: 'column', gap: 6, background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', padding: 10, opacity: hidden ? 0.55 : 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="pwr-mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>{cap.dp}</span>
                    <Icon name="arrow-right" size={12} color="var(--text-disabled)" />
                    <select value={kind} onChange={(e) => setOv(cap.dp, { kind: e.target.value as CapabilityKind })}
                      className="pwr-select" style={{ fontSize: 12, padding: '3px 6px' }}>
                      {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
                    </select>
                  </div>
                  <Input value={ov.label ?? cap.label} onChange={(e) => setOv(cap.dp, { label: e.target.value })} placeholder="Label" />
                  <div style={{ display: 'flex', gap: 14, fontSize: 12, color: 'var(--text-2)' }}>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
                      <input type="checkbox" checked={hidden} onChange={(e) => setOv(cap.dp, { hidden: e.target.checked })} /> Hide
                    </label>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
                      <input type="checkbox" checked={readOnly} onChange={(e) => setOv(cap.dp, { readOnly: e.target.checked })} /> Read-only
                    </label>
                  </div>
                </div>
              );
            })}
            {device.capabilities.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-disabled)' }}>No datapoints reported.</div>}
          </div>
        )}
      </div>

      {err && <div style={{ fontSize: 12, color: 'var(--danger)' }}>{err}</div>}

      {/* actions */}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', paddingTop: 4 }}>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={busy || !name.trim()} loading={busy} iconLeft={<Icon name="check" size={14} />} onClick={add}>Add</Button>
      </div>
    </div>
  );

  // Desktop = right-side rail; mobile = bottom sheet — via the shared <Modal>.
  return (
    <Modal open onClose={onClose} placement="sheet" wideViewport={wide} ariaLabel="Set up device">
      <div style={{ padding: wide ? '20px 18px' : '8px 16px 20px' }}>{body}</div>
    </Modal>
  );
}

/* ---- local override application (mirrors the API's applyOverrides) ----------*/
function applyOverrides(caps: Capability[], overrides: Record<string, CapabilityOverride>): Capability[] {
  const out: Capability[] = [];
  for (const cap of caps) {
    const o = overrides[cap.dp];
    if (!o) { out.push(cap); continue; }
    if (o.hidden) continue;
    const kind = o.kind ?? cap.kind;
    const readOnly = typeof o.readOnly === 'boolean' ? o.readOnly : kind === 'measure' || kind === 'status' ? true : cap.readOnly;
    out.push({ ...cap, kind, readOnly, ...(o.label ? { label: o.label } : {}) });
  }
  return out;
}
