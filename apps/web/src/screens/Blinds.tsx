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
 * a position control, and an expandable per-device config (room name + invert +
 * travel time). Reads poll /api/blinds; writes are admin-gated server-side.
 * Responsive desktop/mobile.
 *
 * DISPLAY CONVENTION — "% CLOSED" (owner decision, 2026-07-01): the UI shows the
 * percentage CLOSED (0% = fully open, 100% = fully closed). This is a display-only
 * inversion at the UI boundary — the API/internal model stays "% open" (positionPct/
 * assumedPct where 100 = open; the lever:'position' value is open-convention). The
 * card converts open↔closed right at the render/command edge (closedPct = 100 − openPct;
 * openTarget = 100 − closedTarget). The invert-direction setting is a separate raw↔open
 * flip that lives BELOW this and is unaffected by the closed display.
 * ==========================================================================*/

/* ---------------------------------------------------------------------------
 * Window-scene visual (silhouette + animated venetian slats). Injected once, the
 * same idiom as ensureDsStyles(): a self-contained illustration with its OWN fixed
 * colours (so it reads identically in light + dark themes), while the surrounding
 * card text/border use design-system tokens. The "shade" height = closedPct%, so
 * 100% closed fully covers the scene and 0% reveals it. Respects reduced-motion.
 * ------------------------------------------------------------------------- */
const BLIND_SCENE_CSS = `
.blz-win{ position:relative; width:100%; height:140px; border-radius:10px; overflow:hidden;
  border:1px solid var(--border-2); background:#182838; }
.blz-win__scene{ position:absolute; inset:0;
  background:linear-gradient(180deg,#182838 0%,#33506d 52%,#7d97ab 100%); }
.blz-win__scene svg{ display:block; width:100%; height:100%; }
.blz-win__shade{ position:absolute; top:0; left:0; right:0; overflow:hidden; z-index:2;
  background:
    repeating-linear-gradient(180deg,rgba(255,255,255,.06) 0 1px,transparent 1px 3px,rgba(0,0,0,.28) 9px 10px,transparent 10px 11px),
    repeating-linear-gradient(180deg,#1c261f 0 10px,#151d18 10px 11px);
  transition:height .16s ease-out; }
.blz-win__shade--glide{ transition:height .6s cubic-bezier(.4,0,.2,1); }
.blz-win__rail{ position:absolute; bottom:0; left:0; right:0; height:6px;
  background:linear-gradient(180deg,#0e130f,#060907); box-shadow:0 3px 7px rgba(0,0,0,.55); }
.blz-win__frame{ position:absolute; inset:0; z-index:3; pointer-events:none; border-radius:10px;
  box-shadow:inset 0 0 0 3px #0b1016; }
.blz-win__frame::after{ content:""; position:absolute; top:0; bottom:0; left:50%; width:2px;
  transform:translateX(-50%); background:#0b1016; opacity:.85; }
@media (max-width:767px){ .blz-win{ height:108px; } }
@media (prefers-reduced-motion:reduce){
  .blz-win__shade, .blz-win__shade--glide{ transition:none; }
}
`;
let blindStylesInjected = false;
function ensureBlindStyles(): void {
  if (blindStylesInjected || typeof document === 'undefined') return;
  blindStylesInjected = true;
  const s = document.createElement('style');
  s.setAttribute('data-pwr', 'blinds-scene');
  s.textContent = BLIND_SCENE_CSS;
  document.head.appendChild(s);
}

/** The window silhouette with the venetian shade drawn down to `closedPct`%.
 *  `glide` selects the longer eased transition (preset/Open/Close) vs the short
 *  finger-tracking one (drag). Decorative — aria-hidden. */
function WindowScene({ closedPct, glide }: { closedPct: number; glide: boolean }) {
  ensureBlindStyles();
  const pct = Math.max(0, Math.min(100, closedPct));
  return (
    <div className="blz-win" aria-hidden="true">
      <div className="blz-win__scene">
        <svg viewBox="0 0 300 120" preserveAspectRatio="xMidYMid slice" width="100%" height="100%">
          <circle cx="228" cy="30" r="15" fill="#f2d69a" opacity="0.9" />
          <circle cx="228" cy="30" r="24" fill="#f2d69a" opacity="0.12" />
          <path d="M150 34 q4 -5 8 0 q4 -5 8 0" fill="none" stroke="#16232f" strokeWidth="1.6" strokeLinecap="round" />
          <path d="M176 44 q3.5 -4 7 0 q3.5 -4 7 0" fill="none" stroke="#16232f" strokeWidth="1.4" strokeLinecap="round" />
          <path d="M0 84 Q55 64 118 78 T300 72 V120 H0 Z" fill="#274158" opacity="0.85" />
          <g fill="#101c27">
            <rect x="41" y="86" width="5" height="26" />
            <path d="M43.5 52 L30 78 L57 78 Z" />
            <path d="M43.5 64 L28 90 L59 90 Z" />
            <path d="M43.5 74 L26 102 L61 102 Z" />
          </g>
          <path d="M0 100 Q80 84 165 98 T300 92 V120 H0 Z" fill="#0f1a25" />
        </svg>
      </div>
      <div
        className={glide ? 'blz-win__shade blz-win__shade--glide' : 'blz-win__shade'}
        style={{ height: `${pct}%` }}
      >
        <div className="blz-win__rail" />
      </div>
      <div className="blz-win__frame" />
    </div>
  );
}

/** Best-known OPEN position for the card: native feedback, else the timed assumed %. */
function knownPct(d: BlindUnit): number | null {
  if (d.positionMode === 'timed') return d.assumedPct ?? null;
  return d.positionPct;
}

/** open% → closed% display value (the app-wide inversion applied only at the UI edge). */
function toClosed(openPct: number): number {
  return 100 - openPct;
}

function stateText(d: BlindUnit): string {
  if (!d.online) return 'offline';
  const open = knownPct(d);
  if (open == null) {
    if (d.moving) return 'moving…';
    // Timed blind that hasn't been anchored yet — position is unknown until the first move.
    if (d.positionMode === 'timed') return 'position unknown';
    return '—';
  }
  const closed = toClosed(open);
  // While moving, name the direction in CLOSED terms toward the target.
  if (d.moving) {
    return `${closed}% closed`;
  }
  if (closed <= 2) return 'open';
  if (closed >= 98) return 'closed';
  const label = `${closed}% closed`;
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
  // The slider works in the CLOSED display convention. `slider` holds the dragged
  // closed% while a gesture is in flight; committed (converted back to open%) on release.
  const known = knownPct(d); // open%
  const knownClosed = known == null ? 0 : toClosed(known);
  const [slider, setSlider] = useState<number | null>(null);
  const sliderClosed = slider ?? knownClosed;
  // `glide` picks the longer eased shade animation for discrete jumps (preset / Open /
  // Close); a drag uses the short finger-tracking transition. Reset on the next drag.
  const [glide, setGlide] = useState(false);
  // A blind with no native position DP can only be positioned via timing → its slider is
  // "would-be timed". Native blinds always position; a would-be-timed blind can only when a
  // travelSec is configured. We still RENDER the control for a would-be-timed blind with no
  // travelSec, but disabled + hinted, so the affordance is discoverable.
  const wouldBeTimed = !d.supportsPosition;
  const positionReady = d.supportsPosition || (wouldBeTimed && d.travelSec != null);
  const showPosition = d.supportsPosition || wouldBeTimed; // every blind qualifies
  const isOpen = (known ?? 0) > 2;
  const tint = d.online && isOpen ? 'var(--ev)' : 'var(--text-3)';
  const disabled = !canControl || !d.online;
  // The position slider/presets are additionally gated on the timed blind being ready.
  const posDisabled = disabled || !positionReady;
  // Send a CLOSED target: convert to the open-convention value the API expects.
  const sendClosed = (closedTarget: number, useGlide: boolean) => {
    if (!positionReady) return; // never emit a position command on an un-configured timed blind
    setGlide(useGlide);
    if (canControl) onCmd('position', toClosed(closedTarget)); // openTarget = 100 − closed
  };
  // Travel-time stepper (timed positioning). Default seed 30s when configuring for the first time.
  const travelSec = d.travelSec ?? 30;

  const moveBtn = (label: string, icon: string, lever: BlindLever) => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        // Open → 0% closed, Close → 100% closed. Glide the scene; drop any drag override.
        if (lever === 'open' || lever === 'close') setGlide(true);
        setSlider(null);
        onCmd(lever);
      }}
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
          {showPosition && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, position: 'relative', opacity: positionReady ? 1 : 0.55 }}>
              {/* Window silhouette — the shade drops to the current CLOSED %. */}
              <WindowScene closedPct={sliderClosed} glide={glide} />
              {/* Slider works in CLOSED convention (0 = open … 100 = closed). Commit the
                  dragged value on release (pointer/key up); convert closed→open when sending.
                  When the (timed) blind has no travel time, the whole control is inert. */}
              <div
                style={positionReady ? undefined : { pointerEvents: 'none' }}
                onPointerDown={() => setGlide(false)}
                onPointerUp={() => {
                  if (slider != null) sendClosed(slider, false);
                  setSlider(null); // hand back to the live/assumed value (optimistic override covers the gap)
                }}
                onKeyDown={() => setGlide(false)}
                onKeyUp={() => {
                  if (slider != null) sendClosed(slider, false);
                  setSlider(null);
                }}
              >
                <Slider
                  label="Position (closed)"
                  min={0}
                  max={100}
                  value={sliderClosed}
                  unit="%"
                  onChange={(v) => positionReady && setSlider(v)}
                />
              </div>
              {/* Preset chips — one-tap common CLOSED positions. */}
              <div style={{ display: 'flex', gap: 6 }}>
                {[0, 25, 50, 75, 100].map((p) => (
                  <button
                    key={p}
                    type="button"
                    disabled={posDisabled}
                    onClick={() => {
                      sendClosed(p, true); // discrete jump → glide the scene
                      setSlider(null);
                    }}
                    style={{
                      flex: 1, padding: '5px 0', borderRadius: 'var(--radius-sm)',
                      border: '1px solid var(--border-2)', background: 'var(--surface-2)',
                      color: posDisabled ? 'var(--text-disabled)' : 'var(--text-2)',
                      fontSize: 11, fontWeight: 600, cursor: posDisabled ? 'default' : 'pointer',
                      fontFamily: 'var(--font-mono, monospace)',
                    }}
                  >
                    {p}
                  </button>
                ))}
              </div>
              {/* Gate hint — timed blind with no travel time yet. Clicking opens the settings
                  panel (where the Travel-time stepper lives). */}
              {!positionReady && (
                <button
                  type="button"
                  onClick={() => canControl && setOpen(true)}
                  style={{
                    alignSelf: 'flex-start', background: 'none', border: 'none', padding: 0,
                    color: 'var(--text-3)', fontSize: 11.5, textAlign: 'left',
                    cursor: canControl ? 'pointer' : 'default',
                    textDecoration: canControl ? 'underline' : 'none',
                  }}
                >
                  Set a travel time to enable partial positioning
                </button>
              )}
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
