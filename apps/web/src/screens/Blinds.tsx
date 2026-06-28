import { useRef, useState } from 'react';
import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import type { BlindUnit, BlindsResponse, BlindLever } from '../lib/types';
import { Card, Icon, Switch, Slider, Input, Button } from '../components/ui';
import { StaleBanner } from './_shared';
import { useAuth } from '../auth/AuthProvider';
import type { ShellContext } from '../components/shell/AppShell';

/* ============================================================================
 * Blinds — second Tuya device category, embedded in the Devices → Blinds tab and
 * built to the "Power" design system. A card per blind with open / stop / close,
 * a position slider (100 = fully open) when the motor reports position, and an
 * expandable per-device config (room name + invert direction). Reads poll
 * /api/blinds; writes are admin-gated server-side. Responsive desktop/mobile.
 * ==========================================================================*/

function stateText(d: BlindUnit): string {
  if (!d.online) return 'offline';
  if (d.moving) return 'moving…';
  if (d.positionPct == null) return d.room && d.room !== d.name ? d.room : '—';
  if (d.positionPct <= 2) return 'closed';
  if (d.positionPct >= 98) return 'open';
  return `${d.positionPct}% open`;
}

function BlindCard({
  d,
  wide,
  canControl,
  onCmd,
  onSaveSettings,
}: {
  d: BlindUnit;
  wide: boolean;
  canControl: boolean;
  onCmd: (lever: BlindLever, value?: number) => void;
  onSaveSettings: (patch: { room?: string; invertPosition?: boolean }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [roomDraft, setRoomDraft] = useState(d.room);
  const isOpen = (d.positionPct ?? 0) > 2;
  const tint = d.online && isOpen ? 'var(--ev)' : 'var(--text-3)';
  const disabled = !canControl || !d.online;

  const moveBtn = (label: string, icon: string, lever: BlindLever) => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onCmd(lever)}
      style={{
        flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        padding: '7px 6px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-2)',
        background: 'var(--surface-2)', color: disabled ? 'var(--text-disabled)' : 'var(--text-1)',
        fontSize: 12, fontWeight: 600, cursor: disabled ? 'default' : 'pointer',
      }}
    >
      <Icon name={icon} size={14} /> {label}
    </button>
  );

  return (
    <Card padded style={{ display: 'flex', flexDirection: 'column', gap: 12, opacity: d.online ? 1 : 0.6 }}>
      {/* Header: icon · name/state · settings */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
        <span style={{ width: 38, height: 38, borderRadius: 11, flex: 'none', display: 'grid', placeItems: 'center', background: d.online && isOpen ? 'rgba(139,140,255,0.14)' : 'var(--surface-3)', color: tint }}>
          <Icon name="blinds" size={19} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.name}</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{stateText(d)}</div>
        </div>
        {canControl && (
          <button type="button" aria-label="Settings" onClick={() => setOpen((v) => !v)} style={{ background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer', padding: 4 }}>
            <Icon name={open ? 'chevron-up' : 'settings'} size={16} />
          </button>
        )}
      </div>

      {/* Controls */}
      {d.online && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {d.supportsPosition && d.positionPct != null && (
            <Slider
              label="Position (open)"
              min={0}
              max={100}
              value={d.positionPct}
              unit="%"
              onChange={(v) => canControl && onCmd('position', v)}
            />
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            {moveBtn('Open', 'arrow-up', 'open')}
            {moveBtn('Stop', 'square', 'stop')}
            {moveBtn('Close', 'arrow-down', 'close')}
          </div>
        </div>
      )}

      {/* Config (admin) */}
      {open && canControl && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 4, borderTop: '1px solid var(--border-1)' }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <Input label="Room name" value={roomDraft} onChange={(e) => setRoomDraft(e.target.value)} />
            </div>
            <Button size="sm" variant="secondary" disabled={roomDraft === d.room} onClick={() => onSaveSettings({ room: roomDraft })}>Save</Button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', padding: '9px 12px' }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13 }}>Invert direction</div>
              <div style={{ fontSize: 11, color: 'var(--text-3)' }}>Flip if “open” and “closed” look reversed</div>
            </div>
            <Switch checked={d.inverted} onChange={(e) => onSaveSettings({ invertPosition: e.target.checked })} />
          </div>
        </div>
      )}
      {!canControl && <div style={{ fontSize: 11, color: 'var(--text-3)' }}>Read-only — admin required to control.</div>}
    </Card>
  );
}

/** The blinds content (no page chrome) — embedded in the Devices → Blinds tab. */
export function BlindsPanel({ ctx }: { ctx: ShellContext }) {
  const { user } = useAuth();
  const canControl = user?.role === 'admin';
  const wide = ctx.desktop;
  const { data, loading, stale, updatedAt, refetch } = usePolling<BlindsResponse>(api.blinds.list, 15_000);

  // Optimistic position override keyed by id, so a dragged slider / open-close feels
  // live while the debounced command is in flight; cleared on the next refresh.
  const [override, setOverride] = useState<Record<string, number>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const send = (id: string, lever: BlindLever, value?: number) => {
    const optimistic = lever === 'open' ? 100 : lever === 'close' ? 0 : lever === 'position' ? value : undefined;
    if (typeof optimistic === 'number') setOverride((o) => ({ ...o, [id]: optimistic }));
    const key = `${id}:${lever}`;
    clearTimeout(timers.current[key]);
    const delay = lever === 'position' ? 300 : 0; // buttons fire now; slider debounces
    timers.current[key] = setTimeout(() => {
      api.blinds
        .command(id, lever, value)
        .catch(() => undefined)
        .finally(() => {
          setOverride((o) => {
            const next = { ...o };
            delete next[id];
            return next;
          });
          refetch();
        });
    }, delay);
  };

  const saveSettings = (id: string, patch: { room?: string; invertPosition?: boolean }) => {
    void api.devices.setSettings(id, patch).then(() => refetch());
  };

  const withOverride = (d: BlindUnit): BlindUnit => {
    const p = override[d.id];
    return typeof p === 'number' ? { ...d, positionPct: p } : d;
  };

  const d = data;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {stale && <StaleBanner updatedAt={updatedAt} />}
      {!d && loading && <Card padded style={{ color: 'var(--text-3)', fontSize: 13 }}>Loading blinds…</Card>}
      {d && !d.connected && (
        <Card padded style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
          <span style={{ width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'var(--grid-wash)', color: 'var(--grid)', flex: 'none' }}>
            <Icon name="cloud-off" size={16} />
          </span>
          <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5 }}>
            Tuya is not connected. Add your Cloud project in <strong style={{ color: 'var(--text-1)' }}>Settings → Connect Tuya</strong> to discover and control your blinds.
          </div>
        </Card>
      )}
      {d && d.connected && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, maxWidth: wide ? 360 : '100%' }}>
            <Chip label="Blinds" value={String(d.context.deviceCount)} />
            <Chip label="Open now" value={String(d.context.openCount)} color="var(--ev)" accent />
          </div>
          {d.fleetError && <div style={{ fontSize: 11.5, color: 'var(--danger)' }}>Could not read the fleet: {d.fleetError}</div>}
          {d.devices.length === 0 ? (
            <Card padded style={{ textAlign: 'center', color: 'var(--text-3)', fontSize: 13, padding: 24 }}>
              No blinds or curtains found on this Tuya account.
            </Card>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: wide ? 'repeat(auto-fill, minmax(260px, 1fr))' : '1fr', gap: 12 }}>
              {d.devices.map((dev) => (
                <BlindCard
                  key={dev.id}
                  d={withOverride(dev)}
                  wide={wide}
                  canControl={canControl}
                  onCmd={(lever, value) => send(dev.id, lever, value)}
                  onSaveSettings={(patch) => saveSettings(dev.id, patch)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Chip({ label, value, color, accent }: { label: string; value: string; color?: string; accent?: boolean }) {
  return (
    <div style={{ background: accent ? 'rgba(139,140,255,0.12)' : 'var(--surface-1)', border: `1px solid ${accent ? 'rgba(139,140,255,0.25)' : 'var(--border-1)'}`, borderRadius: 'var(--radius-md)', padding: '8px 12px', textAlign: 'right', minWidth: 0 }}>
      <div className="pwr-eyebrow" style={{ color: accent ? 'var(--ev)' : 'var(--text-3)' }}>{label}</div>
      <div className="pwr-mono" style={{ fontSize: 16, marginTop: 2, color: color ?? 'var(--text-1)' }}>{value}</div>
    </div>
  );
}
