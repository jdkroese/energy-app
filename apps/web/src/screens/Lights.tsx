import { useRef, useState } from 'react';
import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import type { LightUnit, LightsResponse, LightLever, LightHsv } from '../lib/types';
import { Card, Icon, Switch, Slider, SegmentedControl } from '../components/ui';
import { StaleBanner } from './_shared';
import { useAuth } from '../auth/AuthProvider';
import type { ShellContext } from '../components/shell/AppShell';

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

function hsvToCss({ h, s, v }: LightHsv): string {
  // s,v are 0–100 percent here; HSL is close enough for a swatch preview.
  const l = (v / 100) * (1 - s / 200) * 100;
  return `hsl(${h}, ${s}%, ${Math.round(l)}%)`;
}

function LightCard({
  d,
  wide,
  canControl,
  onCmd,
}: {
  d: LightUnit;
  wide: boolean;
  canControl: boolean;
  onCmd: (lever: LightLever, value: boolean | number | LightHsv) => void;
}) {
  const on = d.power;
  const tint = on
    ? d.workMode === 'colour' && d.color
      ? hsvToCss(d.color)
      : 'var(--solar)'
    : 'var(--text-3)';

  const showWhite = d.workMode !== 'colour';
  const modeOptions = [
    ...(d.dimmable || d.tunable ? [{ value: 'white', label: 'White' }] : []),
    ...(d.colorable ? [{ value: 'colour', label: 'Colour' }] : []),
  ];

  return (
    <Card padded style={{ display: 'flex', flexDirection: 'column', gap: 12, opacity: d.online ? 1 : 0.6 }}>
      {/* Header: icon · name/room · power */}
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
          <div style={{ fontSize: 14, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.name}</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
            {d.online ? (d.room && d.room !== d.name ? d.room : on ? 'on' : 'off') : 'offline'}
          </div>
        </div>
        <Switch
          checked={on}
          disabled={!canControl || !d.online}
          onChange={(e) => onCmd('power', e.target.checked)}
        />
      </div>

      {/* Controls — only when on */}
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

          {showWhite && d.dimmable && d.brightnessPct != null && (
            <Slider
              label="Brightness"
              min={1}
              max={100}
              value={d.brightnessPct}
              unit="%"
              onChange={(v) => canControl && onCmd('brightness', v)}
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
  const canControl = user?.role === 'admin';
  const wide = ctx.desktop;
  const { data, loading, stale, updatedAt, refetch } = usePolling<LightsResponse>(api.lights.list, 15_000);

  // Optimistic overrides keyed by `${id}:${lever}` so a dragged slider feels live
  // while the debounced command is in flight; cleared on the next server refresh.
  const [override, setOverride] = useState<Record<string, boolean | number | LightHsv>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const send = (id: string, lever: LightLever, value: boolean | number | LightHsv) => {
    setOverride((o) => ({ ...o, [`${id}:${lever}`]: value }));
    const key = `${id}:${lever}`;
    clearTimeout(timers.current[key]);
    // Booleans fire immediately; continuous sliders debounce to spare the cloud API.
    const delay = typeof value === 'boolean' ? 0 : 300;
    timers.current[key] = setTimeout(() => {
      api.lights
        .command(id, lever, value)
        .catch(() => undefined)
        .finally(() => {
          setOverride((o) => {
            const next = { ...o };
            delete next[key];
            return next;
          });
          refetch();
        });
    }, delay);
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

  const d = data;

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
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, maxWidth: wide ? 360 : '100%' }}>
            <Chip label="Lights" value={String(d.context.deviceCount)} />
            <Chip label="On now" value={String(d.context.onCount)} color="var(--solar)" accent />
          </div>
          {d.fleetError && <div style={{ fontSize: 11.5, color: 'var(--danger)' }}>Could not read the fleet: {d.fleetError}</div>}
          {d.devices.length === 0 ? (
            <Card padded style={{ textAlign: 'center', color: 'var(--text-3)', fontSize: 13, padding: 24 }}>
              No lights found on this Tuya account.
            </Card>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: wide ? 'repeat(auto-fill, minmax(260px, 1fr))' : '1fr', gap: 12 }}>
              {d.devices.map((dev) => {
                const m = withOverrides(dev);
                return (
                  <LightCard
                    key={dev.id}
                    d={m}
                    wide={wide}
                    canControl={canControl}
                    onCmd={(lever, value) => send(dev.id, lever, value)}
                  />
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );

  return body;
}

function Chip({ label, value, color, accent }: { label: string; value: string; color?: string; accent?: boolean }) {
  return (
    <div
      style={{
        background: accent ? 'var(--solar-wash)' : 'var(--surface-1)',
        border: `1px solid ${accent ? 'rgba(46,230,160,0.25)' : 'var(--border-1)'}`,
        borderRadius: 'var(--radius-md)',
        padding: '8px 12px',
        textAlign: 'right',
        minWidth: 0,
      }}
    >
      <div className="pwr-eyebrow" style={{ color: accent ? 'var(--solar-dim)' : 'var(--text-3)' }}>{label}</div>
      <div className="pwr-mono" style={{ fontSize: 16, marginTop: 2, color: color ?? 'var(--text-1)' }}>{value}</div>
    </div>
  );
}
