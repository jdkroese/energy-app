import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import type { LightUnit, LightsResponse, LightLever, LightHsv, ScenesResponse } from '../lib/types';
import { Card, Icon, Switch, Slider, SegmentedControl, Input, InlineReveal } from '../components/ui';
import { StaleBanner } from './_shared';
import { useAuth } from '../auth/AuthProvider';
import type { ShellContext } from '../components/shell/AppShell';
import { ScenesSection, LightSchedulesSection } from '../components/lights/ScenesAndSchedules';

/* ============================================================================
 * Lights — first Tuya device category, built to the "Power" design system.
 *   • context strip (lights · on now)
 *   • connect prompt when no Tuya project is linked
 *   • a card per light with inline controls: power · brightness · white temp ·
 *     colour, shown only for the capabilities each device reports.
 * Reads poll /api/lights; writes are admin-gated server-side. Responsive across
 * desktop (grid) and mobile (single column) per the web+mobile standing rule.
 * ==========================================================================*/

/** Warm→cool gradient for the colour-temperature track preview. */
const TEMP_GRADIENT = 'linear-gradient(90deg, #ffb15e, #fff4e3 50%, #cfe5ff)';

function colorEq(a: unknown, b: LightHsv | null): boolean {
  if (!b || !a || typeof a !== 'object') return false;
  const x = a as LightHsv;
  return x.h === b.h && x.s === b.s && x.v === b.v;
}

function hsvToCss({ h, s, v }: LightHsv): string {
  // s,v are 0–100 percent here; HSL is close enough for a swatch preview.
  const l = (v / 100) * (1 - s / 200) * 100;
  return `hsl(${h}, ${s}%, ${Math.round(l)}%)`;
}

function LightCard({
  d,
  wide,
  canControl,
  pending,
  onCmd,
  onRename,
  onOpenDetail,
}: {
  d: LightUnit;
  wide: boolean;
  canControl: boolean;
  /** Levers with an in-flight optimistic command — drives the sync/pending ring. */
  pending: Set<LightLever>;
  onCmd: (lever: LightLever, value: boolean | number | LightHsv) => void;
  onRename: (name: string) => void;
  /** Configured (set-up) lights only — opens the device edit/detail screen where the
   *  full capability set (modes, inching, sensor readouts) lives. */
  onOpenDetail?: () => void;
}) {
  const on = d.power;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(d.name);
  const nameInputRef = useRef<HTMLInputElement>(null);
  // InlineReveal keeps the field mounted, so focus it on open (autoFocus only
  // fires on first mount).
  useEffect(() => { if (editing) nameInputRef.current?.focus(); }, [editing]);
  const tint = on
    ? d.workMode === 'colour' && d.color
      ? hsvToCss(d.color)
      : 'var(--solar)'
    : 'var(--text-3)';

  const syncing = pending.size > 0;
  const showWhite = d.workMode !== 'colour';
  const modeOptions = [
    ...(d.dimmable || d.tunable ? [{ value: 'white', label: 'White' }] : []),
    ...(d.colorable ? [{ value: 'colour', label: 'Colour' }] : []),
  ];
  const saveName = () => {
    const n = draft.trim();
    if (n && n !== d.name) onRename(n);
    setEditing(false);
  };

  return (
    <Card padded style={{ display: 'flex', flexDirection: 'column', gap: 12, opacity: d.online ? 1 : 0.6 }}>
      {/* Header: icon · name (editable) · power */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
        <span
          style={{
            width: 38, height: 38, borderRadius: 11, flex: 'none', display: 'grid', placeItems: 'center',
            background: on ? 'var(--solar-wash)' : 'var(--surface-3)', color: tint,
            boxShadow: on ? `0 0 16px -4px ${tint}` : 'none', transition: 'all .2s ease',
          }}
        >
          <Icon name="lightbulb" size={19} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <InlineReveal open={editing}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingBottom: 2 }}>
              <Input
                ref={nameInputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') setEditing(false); }}
                onBlur={saveName}
                style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 500 }}
              />
              <button type="button" aria-label="Save name" onMouseDown={(e) => e.preventDefault()} onClick={saveName} style={{ background: 'none', border: 'none', color: 'var(--solar)', cursor: 'pointer', padding: 2 }}><Icon name="check" size={15} /></button>
            </div>
          </InlineReveal>
          {!editing && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                <div title={d.name} style={{ fontSize: 14, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.name}</div>
                {canControl && (
                  <button type="button" aria-label="Rename" onClick={() => { setDraft(d.name); setEditing(true); }} style={{ background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer', padding: 2, flex: 'none' }}><Icon name="pencil" size={12} /></button>
                )}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-3)', display: 'flex', alignItems: 'center', gap: 5 }}>
                {d.online ? (on ? 'on' : 'off') : 'offline'}
                {syncing && (
                  <span
                    aria-label="Syncing"
                    title="Syncing — confirming with the bulb"
                    style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--grid)', display: 'inline-block', animation: 'pwrSyncPulse 1s ease-in-out infinite' }}
                  >
                    <style>{`@keyframes pwrSyncPulse { 0%,100% { opacity: .35 } 50% { opacity: 1 } }`}</style>
                  </span>
                )}
              </div>
            </>
          )}
        </div>
        {onOpenDetail && (
          <button
            type="button"
            aria-label="Device details"
            title="Details & advanced settings"
            onClick={onOpenDetail}
            style={{ background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer', padding: 4, flex: 'none', display: 'grid', placeItems: 'center' }}
          >
            <Icon name="settings-2" size={15} />
          </button>
        )}
        <span className={pending.has('power') ? 'pwr-ifx-pending' : undefined} style={{ display: 'inline-flex', flex: 'none' }}>
          <Switch
            checked={on}
            disabled={!canControl || !d.online}
            onChange={(e) => onCmd('power', e.target.checked)}
          />
        </span>
      </div>

      {/* Brightness — shown whenever dimmable, even when off (presets the level) */}
      {d.online && showWhite && d.dimmable && d.brightnessPct != null && (
        <Slider
          label="Brightness"
          min={1}
          max={100}
          value={d.brightnessPct}
          unit="%"
          onChange={(v) => canControl && onCmd('brightness', v)}
        />
      )}

      {/* Colour-mode + temperature controls — only when on */}
      {on && d.online && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {modeOptions.length > 1 && (
            <SegmentedControl
              size="sm"
              block
              value={d.workMode === 'colour' ? 'colour' : 'white'}
              options={modeOptions}
              onChange={(m) =>
                canControl &&
                (m === 'colour'
                  ? onCmd('color', d.color ?? { h: 30, s: 100, v: 100 })
                  : onCmd('colorTemp', d.colorTempPct ?? 50))
              }
            />
          )}

          {showWhite && d.tunable && d.colorTempPct != null && (
            <div>
              <Slider
                label="White temperature"
                min={0}
                max={100}
                value={d.colorTempPct}
                showValue={false}
                onChange={(v) => canControl && onCmd('colorTemp', v)}
              />
              <div style={{ height: 4, borderRadius: 2, marginTop: -4, background: TEMP_GRADIENT, opacity: 0.5 }} />
            </div>
          )}

          {!showWhite && d.colorable && (
            <>
              <Slider
                label="Hue"
                min={0}
                max={360}
                value={d.color?.h ?? 0}
                showValue={false}
                onChange={(h) => canControl && onCmd('color', { h, s: d.color?.s ?? 100, v: d.color?.v ?? 100 })}
              />
              <Slider
                label="Saturation"
                min={0}
                max={100}
                value={d.color?.s ?? 100}
                unit="%"
                onChange={(s) => canControl && onCmd('color', { h: d.color?.h ?? 0, s, v: d.color?.v ?? 100 })}
              />
            </>
          )}
        </div>
      )}
      {!canControl && <div style={{ fontSize: 11, color: 'var(--text-3)' }}>Read-only — admin required to control.</div>}
    </Card>
  );
}

/** The lights content (no page chrome) — embedded in the Devices → Lighting tab. */
export function LightsPanel({ ctx }: { ctx: ShellContext }) {
  const { user } = useAuth();
  const nav = useNavigate();
  const canControl = user?.role === 'admin';
  const wide = ctx.desktop;
  const { data, loading, stale, updatedAt, refetch } = usePolling<LightsResponse>(api.lights.list, 15_000);

  // Optimistic overrides keyed by `${id}:${lever}`: the UI reflects the change
  // instantly and the override is held (NOT cleared on send) until a later poll
  // shows the device has caught up — which avoids the brief "snap back" while the
  // Tuya cloud read lags the write. A failed command drops its override (reverts).
  const [override, setOverride] = useState<Record<string, boolean | number | LightHsv>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const send = (id: string, lever: LightLever, value: boolean | number | LightHsv) => {
    const key = `${id}:${lever}`;
    setOverride((o) => ({ ...o, [key]: value }));
    clearTimeout(timers.current[key]);
    const fire = () => {
      api.lights
        .command(id, lever, value)
        .then(() => setTimeout(() => refetch(), 1200)) // pull the real state back in soon
        .catch(() =>
          setOverride((o) => {
            const n = { ...o };
            delete n[key];
            return n;
          }),
        );
    };
    // Power/colour-mode toggles fire immediately; continuous sliders (brightness,
    // temp, hue) coalesce for 150ms so a drag doesn't flood the cloud — the thumb
    // and bulb still move instantly via the optimistic override above.
    if (typeof value === 'number' || typeof value === 'object') {
      timers.current[key] = setTimeout(fire, 150);
    } else {
      fire();
    }
  };

  // Reconcile: once a poll shows the device matches an optimistic value, drop it.
  useEffect(() => {
    if (!data) return;
    setOverride((prev) => {
      if (Object.keys(prev).length === 0) return prev;
      const next = { ...prev };
      let changed = false;
      for (const dev of data.devices) {
        const drop = (lever: LightLever, serverVal: unknown) => {
          const k = `${dev.id}:${lever}`;
          if (!(k in next)) return;
          const ov = next[k];
          const eq = lever === 'color' ? colorEq(ov, serverVal as LightHsv | null) : ov === serverVal;
          if (eq) {
            delete next[k];
            changed = true;
          }
        };
        drop('power', dev.power);
        drop('brightness', dev.brightnessPct);
        drop('colorTemp', dev.colorTempPct);
        drop('color', dev.color);
      }
      return changed ? next : prev;
    });
  }, [data]);

  /** Levers with an in-flight (unconfirmed) optimistic override for this light —
   *  mirrors how Devices tracks per-(id,lever) pending. Drives the sync/pending
   *  affordance; purely visual (command behavior is unchanged). */
  const pendingLevers = (id: string): Set<LightLever> => {
    const out = new Set<LightLever>();
    for (const k of Object.keys(override)) {
      const [kid, lever] = k.split(':');
      if (kid === id) out.add(lever as LightLever);
    }
    return out;
  };

  /** Merge any in-flight optimistic overrides onto the server view of a light. */
  const withOverrides = (d: LightUnit): LightUnit => {
    const o = override;
    const p = o[`${d.id}:power`];
    const b = o[`${d.id}:brightness`];
    const t = o[`${d.id}:colorTemp`];
    const c = o[`${d.id}:color`];
    return {
      ...d,
      power: typeof p === 'boolean' ? p : d.power,
      brightnessPct: typeof b === 'number' ? b : d.brightnessPct,
      colorTempPct: typeof t === 'number' ? t : d.colorTempPct,
      color: c && typeof c === 'object' ? (c as LightHsv) : d.color,
      workMode: c ? 'colour' : t !== undefined || b !== undefined ? 'white' : d.workMode,
    };
  };

  const { data: scenesData, refetch: refetchScenes } = usePolling<ScenesResponse>(api.lights.scenes, 0);
  const d = data;
  // Alphabetical (case-insensitive, number-aware) order for the lights list, the scene
  // builder's light picker, and the light-schedule target picker — derived once here.
  const sortedLights = [...(d?.devices ?? [])].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

  // All/On/Off filter for the grid. Counts and filtering both read the
  // optimistic (override-merged) power so a just-toggled light moves buckets
  // immediately rather than waiting for the next poll.
  const [filter, setFilter] = useState<'all' | 'on' | 'off'>('all');
  const merged = sortedLights.map(withOverrides);
  const onCount = merged.filter((m) => m.power).length;
  const counts = { all: merged.length, on: onCount, off: merged.length - onCount };
  const visibleLights = merged.filter((m) => filter === 'all' || (filter === 'on' ? m.power : !m.power));

  const body = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {stale && <StaleBanner updatedAt={updatedAt} />}
      {!d && loading && <Card padded style={{ color: 'var(--text-3)', fontSize: 13 }}>Loading lights…</Card>}
      {d && !d.connected && (
        <Card padded style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
          <span style={{ width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'var(--grid-wash)', color: 'var(--grid)', flex: 'none' }}>
            <Icon name="cloud-off" size={16} />
          </span>
          <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5 }}>
            Tuya is not connected. Add your Cloud project in <strong style={{ color: 'var(--text-1)' }}>Settings → Connect Tuya</strong> to discover and control your lights.
          </div>
        </Card>
      )}
      {d && d.connected && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, maxWidth: wide ? 480 : '100%' }} role="group" aria-label="Filter lights">
            <FilterChip label="All" value={counts.all} selected={filter === 'all'} onClick={() => setFilter('all')} />
            <FilterChip label="On" value={counts.on} selected={filter === 'on'} onClick={() => setFilter('on')} accent />
            <FilterChip label="Off" value={counts.off} selected={filter === 'off'} onClick={() => setFilter('off')} />
          </div>
          {d.fleetError && <div style={{ fontSize: 11.5, color: 'var(--danger)' }}>Could not read the fleet: {d.fleetError}</div>}
          {d.devices.length === 0 ? (
            <Card padded style={{ textAlign: 'center', color: 'var(--text-3)', fontSize: 13, padding: 24 }}>
              No lights found on this Tuya account.
            </Card>
          ) : visibleLights.length === 0 ? (
            <Card padded style={{ textAlign: 'center', color: 'var(--text-3)', fontSize: 13, padding: 24 }}>
              No lights are {filter === 'on' ? 'on' : 'off'} right now.
            </Card>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: wide ? 'repeat(auto-fill, minmax(260px, 1fr))' : '1fr', gap: 12 }}>
              {visibleLights.map((m) => (
                <LightCard
                  key={m.id}
                  d={m}
                  wide={wide}
                  canControl={canControl}
                  pending={pendingLevers(m.id)}
                  onCmd={(lever, value) => send(m.id, lever, value)}
                  onRename={(name) => { void api.lights.rename(m.id, name).then(refetch); }}
                  onOpenDetail={m.configured ? () => nav(`/devices/generic/${m.id}`) : undefined}
                />
              ))}
            </div>
          )}

          {/* Scenes + schedules — manage on/off+dim presets and time-based rules */}
          <ScenesSection lights={sortedLights} canControl={canControl} onScenesChanged={refetchScenes} />
          <LightSchedulesSection lights={sortedLights} scenes={scenesData?.scenes ?? []} canControl={canControl} />
        </>
      )}
    </div>
  );

  return body;
}

/** A clickable stat chip that doubles as an All/On/Off filter segment. The
 *  selected segment lights up (solar wash); the "On" segment carries the solar
 *  accent for its count so the live on-count stays visually distinct. */
function FilterChip({ label, value, selected, onClick, accent }: { label: string; value: number; selected: boolean; onClick: () => void; accent?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className="touch-area"
      style={{
        background: selected ? 'var(--solar-wash)' : 'var(--surface-1)',
        border: `1px solid ${selected ? 'var(--border-solar)' : 'var(--border-1)'}`,
        borderRadius: 'var(--radius-md)',
        padding: '8px 12px',
        textAlign: 'left',
        minWidth: 0,
        cursor: 'pointer',
        transition: 'background .15s ease, border-color .15s ease',
      }}
    >
      <div className="pwr-eyebrow" style={{ color: selected ? 'var(--solar-dim)' : 'var(--text-3)' }}>{label}</div>
      <div className="pwr-mono" style={{ fontSize: 16, marginTop: 2, color: accent ? 'var(--solar)' : 'var(--text-1)' }}>{value}</div>
    </button>
  );
}
