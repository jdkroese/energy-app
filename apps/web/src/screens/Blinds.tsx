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

/** Best-known position for the card: native feedback, else the timed assumed %. */
function knownPct(d: BlindUnit): number | null {
  if (d.positionMode === 'timed') return d.assumedPct ?? null;
  return d.positionPct;
}

function stateText(d: BlindUnit): string {
  if (!d.online) return 'offline';
  if (d.moving) return 'moving…';
  const p = knownPct(d);
  if (p == null) {
    // Timed blind that hasn't been anchored yet — position is unknown until the first move.
    if (d.positionMode === 'timed') return 'position unknown';
    return '—';
  }
  if (p <= 2) return 'closed';
  if (p >= 98) return 'open';
  const label = `${p}% open`;
  // A timed blind that has never re-anchored shows its value as approximate.
  return d.positionMode === 'timed' && d.anchored === false ? `~${label}` : label;
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
  onSaveSettings: (patch: { room?: string; invertPosition?: boolean; travelSec?: number | null }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [roomDraft, setRoomDraft] = useState(d.room);
  // Slider drag value — lets the thumb track the finger smoothly; committed on release.
  const known = knownPct(d);
  const [slider, setSlider] = useState<number | null>(null);
  const sliderVal = slider ?? (known ?? 0);
  const posMode = d.positionMode ?? (d.supportsPosition ? 'native' : null);
  const isOpen = (known ?? 0) > 2;
  const tint = d.online && isOpen ? 'var(--ev)' : 'var(--text-3)';
  const disabled = !canControl || !d.online;
  // Travel-time stepper (timed positioning). Default seed 30s when configuring for the first time.
  const travelSec = d.travelSec ?? 30;

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
        <span style={{ width: 38, height: 38, borderRadius: 11, flex: 'none', display: 'grid', placeItems: 'center', background: d.online && isOpen ? 'var(--ev-wash)' : 'var(--surface-3)', color: tint }}>
          <Icon name="blinds" size={19} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div title={d.room || d.name} style={{ fontSize: 14, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.room || d.name}</div>
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
          {posMode && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {/* Commit the dragged value on release (pointer up / key up) so a timed blind
                  fires exactly one position command per gesture, not one per pixel. */}
              <div
                onPointerUp={() => {
                  if (slider != null && canControl) onCmd('position', slider);
                  setSlider(null); // hand back to the live/assumed value (optimistic override covers the gap)
                }}
                onKeyUp={() => {
                  if (slider != null && canControl) onCmd('position', slider);
                  setSlider(null);
                }}
              >
                <Slider
                  label="Position (open)"
                  min={0}
                  max={100}
                  value={sliderVal}
                  unit="%"
                  onChange={(v) => setSlider(v)}
                />
              </div>
              {/* Preset chips — one-tap common positions. */}
              <div style={{ display: 'flex', gap: 6 }}>
                {[0, 25, 50, 75, 100].map((p) => (
                  <button
                    key={p}
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      if (canControl) onCmd('position', p);
                      setSlider(null);
                    }}
                    style={{
                      flex: 1, padding: '5px 0', borderRadius: 'var(--radius-sm)',
                      border: '1px solid var(--border-2)', background: 'var(--surface-2)',
                      color: disabled ? 'var(--text-disabled)' : 'var(--text-2)',
                      fontSize: 11, fontWeight: 600, cursor: disabled ? 'default' : 'pointer',
                      fontFamily: 'var(--font-mono, monospace)',
                    }}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
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

          {/* Travel time — only relevant when there's no native position DP. Enables timed
              positioning: a move to N% runs the motor for travelSec×|Δ|/100 then Stops. */}
          {!d.supportsPosition && (
            <div style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', padding: '9px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13 }}>Travel time</div>
                  <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
                    {d.travelSec != null
                      ? `Full travel ${travelSec}s · each 10% ≈ ${(travelSec / 10).toFixed(1)}s`
                      : 'Set the full open/close time to enable the % slider'}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={travelSec <= 5}
                    onClick={() => onSaveSettings({ travelSec: Math.max(5, travelSec - 5) })}
                  >
                    –
                  </Button>
                  <span className="pwr-mono" style={{ minWidth: 42, textAlign: 'center', fontSize: 14, color: d.travelSec != null ? 'var(--text-1)' : 'var(--text-3)' }}>
                    {travelSec}s
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={travelSec >= 90}
                    onClick={() => onSaveSettings({ travelSec: Math.min(90, travelSec + 5) })}
                  >
                    +
                  </Button>
                </div>
              </div>
              {d.travelSec != null && (
                <button
                  type="button"
                  onClick={() => onSaveSettings({ travelSec: null })}
                  style={{ alignSelf: 'flex-start', background: 'none', border: 'none', color: 'var(--text-3)', fontSize: 11, cursor: 'pointer', padding: 0, textDecoration: 'underline' }}
                >
                  Clear (open/stop/close only)
                </button>
              )}
            </div>
          )}
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

  const saveSettings = (id: string, patch: { room?: string; invertPosition?: boolean; travelSec?: number | null }) => {
    void api.devices.setSettings(id, patch).then(() => refetch());
  };

  const withOverride = (d: BlindUnit): BlindUnit => {
    const p = override[d.id];
    // Reflect the optimistic value on BOTH the native (positionPct) and timed (assumedPct)
    // read paths so the slider/state line feel live regardless of positionMode.
    return typeof p === 'number' ? { ...d, positionPct: p, assumedPct: p } : d;
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
    <div style={{ background: accent ? 'var(--ev-wash)' : 'var(--surface-1)', border: `1px solid ${accent ? 'var(--border-ev)' : 'var(--border-1)'}`, borderRadius: 'var(--radius-md)', padding: '8px 12px', textAlign: 'right', minWidth: 0 }}>
      <div className="pwr-eyebrow" style={{ color: accent ? 'var(--ev)' : 'var(--text-3)' }}>{label}</div>
      <div className="pwr-mono" style={{ fontSize: 16, marginTop: 2, color: color ?? 'var(--text-1)' }}>{value}</div>
    </div>
  );
}
