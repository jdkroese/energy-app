import { useEffect, useState, type ReactNode } from 'react';
import type { Capability } from '../lib/types';
import { Switch, Slider, SegmentedControl, Button, Badge, Icon } from './ui';
import { ConfirmDialog } from './ConfirmDialog';

/* ============================================================================
 * GenericControl — the reusable capability renderer. Given a device's
 * capabilities + live values, it renders a live, actuating control per kind:
 *   switch  → Switch
 *   range   → Slider (with unit; percent for unbounded, device-units for bounded)
 *   enum    → SegmentedControl / Select
 *   action  → Button (confirm dialog when `sensitive`)
 *   color   → hue slider (compact HSV control)
 *   measure → read-only numeric readout
 *   status  → Badge
 * Writes are optimistic (local value snaps immediately) and flow through the
 * supplied `onWrite(dp, kind, value)` callback. Used as a compact card (group
 * grid), an expanded detail view, AND the live PREVIEW in the setup sheet.
 * ==========================================================================*/

export interface GenericControlProps {
  capabilities: Capability[];
  /** dp → current app-facing value (live read-back). */
  values: Record<string, unknown>;
  /** Issue a write. Return a promise so the row can show a brief in-flight state. */
  onWrite: (dp: string, kind: Capability['kind'], value: unknown) => Promise<unknown> | void;
  /** Disable all controls (read-only viewer / not admin). */
  disabled?: boolean;
  /** 'card' = compact (group grid); 'detail' = roomy (expanded view / preview). */
  variant?: 'card' | 'detail';
}

type Val = boolean | number | string | { h: number; s: number; v: number } | undefined;

export function GenericControl({ capabilities, values, onWrite, disabled = false, variant = 'detail' }: GenericControlProps) {
  // Local optimistic overlay: a control's shown value updates instantly; the live
  // `values` reconcile it on the next poll. Keyed by dp.
  const [optimistic, setOptimistic] = useState<Record<string, Val>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [confirm, setConfirm] = useState<Capability | null>(null);

  // Drop an optimistic value once the live read-back matches it.
  useEffect(() => {
    setOptimistic((o) => {
      if (Object.keys(o).length === 0) return o;
      let changed = false;
      const next: Record<string, Val> = {};
      for (const [dp, val] of Object.entries(o)) {
        if (values[dp] !== undefined && JSON.stringify(values[dp]) === JSON.stringify(val)) { changed = true; continue; }
        next[dp] = val;
      }
      return changed ? next : o;
    });
  }, [values]);

  const valueOf = (cap: Capability): Val => {
    if (cap.dp in optimistic) return optimistic[cap.dp];
    return values[cap.dp] as Val;
  };

  const write = (cap: Capability, value: Val) => {
    setOptimistic((o) => ({ ...o, [cap.dp]: value }));
    setBusy((b) => ({ ...b, [cap.dp]: true }));
    void Promise.resolve(onWrite(cap.dp, cap.kind, value)).finally(() => {
      setBusy((b) => ({ ...b, [cap.dp]: false }));
    });
  };

  const fireAction = (cap: Capability) => {
    // For an enum-style action, send the first option as the "go" value; else `true`.
    const go = cap.options && cap.options.length ? cap.options[0] : true;
    write(cap, go as Val);
  };

  const onActionClick = (cap: Capability) => {
    if (cap.sensitive) { setConfirm(cap); return; }
    fireAction(cap);
  };

  const visible = capabilities.filter((c) => c.kind !== undefined);
  const compact = variant === 'card';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 8 : 12 }}>
      {visible.map((cap) => (
        <ControlRow
          key={cap.key}
          cap={cap}
          value={valueOf(cap)}
          busy={!!busy[cap.dp]}
          disabled={disabled}
          compact={compact}
          onSwitch={(v) => write(cap, v)}
          onRange={(v) => write(cap, v)}
          onEnum={(v) => write(cap, v)}
          onColor={(v) => write(cap, v)}
          onAction={() => onActionClick(cap)}
        />
      ))}
      {visible.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-disabled)' }}>No controllable datapoints.</div>
      )}

      <ConfirmDialog
        open={confirm !== null}
        tone="danger"
        title={confirm ? `${confirm.label}?` : ''}
        body={confirm ? `This is a safety-critical control. Confirm to ${confirm.label.toLowerCase()} now.` : ''}
        confirmLabel={confirm?.label ?? 'Confirm'}
        onCancel={() => setConfirm(null)}
        onConfirm={() => { if (confirm) fireAction(confirm); setConfirm(null); }}
      />
    </div>
  );
}

/* ---- one capability row ---------------------------------------------------*/

function Label({ cap, right }: { cap: Capability; right?: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, minWidth: 0 }}>
      <span style={{ fontSize: 12.5, color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cap.label}</span>
      {right}
    </div>
  );
}

function ControlRow({
  cap, value, busy, disabled, compact, onSwitch, onRange, onEnum, onColor, onAction,
}: {
  cap: Capability; value: Val; busy: boolean; disabled: boolean; compact: boolean;
  onSwitch: (v: boolean) => void; onRange: (v: number) => void; onEnum: (v: string) => void;
  onColor: (v: { h: number; s: number; v: number }) => void; onAction: () => void;
}) {
  const sync = busy ? <SyncDot /> : null;

  if (cap.kind === 'switch') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <span style={{ fontSize: 12.5, color: 'var(--text-2)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>{cap.label}{sync}</span>
        <Switch checked={Boolean(value)} disabled={disabled} onChange={(e) => onSwitch(e.target.checked)} />
      </div>
    );
  }

  if (cap.kind === 'range') {
    // Unbounded ranges are app percent (0..100); bounded ranges (e.g. fan 1..5) use device units.
    const explicit = cap.min !== undefined || cap.max !== undefined;
    const min = explicit ? cap.min ?? 0 : 0;
    const max = explicit ? cap.max ?? 100 : 100;
    const v = typeof value === 'number' ? value : min;
    const unit = cap.unit ?? (explicit ? '' : '%');
    return (
      <div>
        <Slider
          label={cap.label}
          value={v}
          min={min}
          max={max}
          step={explicit ? 1 : 1}
          unit={unit}
          onChange={(nv) => onRange(nv)}
          className={disabled ? 'pwr-slider--disabled' : ''}
        />
      </div>
    );
  }

  if (cap.kind === 'enum') {
    const opts = cap.options ?? [];
    const v = typeof value === 'string' ? value : opts[0] ?? '';
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        <Label cap={cap} right={sync} />
        {opts.length > 0 ? (
          <SegmentedControl options={opts} value={v} size="sm" block onChange={(nv) => !disabled && onEnum(nv)} />
        ) : (
          <span style={{ fontSize: 12, color: 'var(--text-disabled)' }}>no options reported</span>
        )}
      </div>
    );
  }

  if (cap.kind === 'action') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <span style={{ fontSize: 12.5, color: 'var(--text-2)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {cap.sensitive && <Icon name="shield-alert" size={13} color="var(--danger)" />}
          {cap.label}{sync}
        </span>
        <Button
          size="sm"
          variant={cap.sensitive ? 'danger' : 'secondary'}
          disabled={disabled || busy}
          onClick={onAction}
          iconLeft={cap.sensitive ? <Icon name="lock" size={13} /> : <Icon name="play" size={13} />}
        >
          {cap.label}
        </Button>
      </div>
    );
  }

  if (cap.kind === 'color') {
    const c = (value && typeof value === 'object' ? value : { h: 0, s: 100, v: 100 }) as { h: number; s: number; v: number };
    const swatch = `hsl(${c.h} ${c.s}% ${Math.max(30, c.v / 2 + 25)}%)`;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        <Label cap={cap} right={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>{sync}<span style={{ width: 16, height: 16, borderRadius: 5, background: swatch, border: '1px solid var(--border-2)' }} /></span>} />
        <Slider label="Hue" value={c.h} min={0} max={360} unit="°" onChange={(h) => !disabled && onColor({ ...c, h })} />
      </div>
    );
  }

  if (cap.kind === 'measure') {
    const num = typeof value === 'number' ? value : null;
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <span style={{ fontSize: 12.5, color: 'var(--text-2)' }}>{cap.label}</span>
        <span className="pwr-mono" style={{ fontSize: 13, color: 'var(--text-1)' }}>
          {num != null ? `${num}${cap.unit ? ` ${cap.unit}` : ''}` : '—'}
        </span>
      </div>
    );
  }

  // status
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
      <span style={{ fontSize: 12.5, color: 'var(--text-2)' }}>{cap.label}</span>
      <Badge tone="neutral" variant="soft">{value === undefined || value === null ? '—' : String(value)}</Badge>
    </div>
  );
}

function SyncDot() {
  return (
    <span aria-label="syncing" title="Syncing" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--grid)', display: 'inline-block', animation: 'pwrSyncPulse 1s ease-in-out infinite' }}>
      <style>{`@keyframes pwrSyncPulse { 0%,100% { opacity: .35 } 50% { opacity: 1 } }`}</style>
    </span>
  );
}
