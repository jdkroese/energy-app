import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import type {
  DeviceView, DevicesResponse, DeviceWarmth, LiveResponse, DevicesStatus, AutomationsResponse, Automation, ClimateLever, LightsResponse, BlindsResponse,
} from '../lib/types';
import { Card, Icon } from '../components/ui';
import { MobileHeader, Avatar, StaleBanner } from './_shared';
import { useAuth } from '../auth/AuthProvider';
import type { ShellContext } from '../components/shell/AppShell';
import { DEVICE_TYPES, typeMeta, classifyDevice, type DeviceType } from '../lib/deviceTypes';
import { AutomationRow } from '../components/AutomationRow';
import { LightsPanel } from './Lights';
import { BlindsPanel } from './Blinds';

/* ============================================================================
 * Devices — the typed-device hub. A segmented type bar (Cooling · Heating ·
 * Lighting · Switching) selects which device type's content shows below. Cooling
 * (the Intesis AC fleet) and Heating (the Airzone underfloor fleet) are built;
 * Lighting / Switching are placeholders.
 *
 * Cooling rows are plain navigable rows (inline controls are a separate slice).
 * Heating rows carry inline controls — clickable mode chip, setpoint steppers and
 * a power toggle — wired through the same optimistic + debounced lever path as the
 * unit detail. Writes are admin + arm gated server-side.
 * ==========================================================================*/

const WARMTH_COLOR: Record<DeviceWarmth, string> = {
  cold: 'var(--battery)', cool: 'var(--battery)', comfortable: 'var(--text-2)',
  warm: 'var(--grid)', hot: 'var(--danger)', unknown: 'var(--text-3)',
};

const t1 = (t: number | null) => (t == null ? '—' : `${t.toFixed(1)}°`);

/** Free solar surplus = what's being exported right now (≈ €0 value). */
function surplusKw(live: LiveResponse | null): number | null {
  if (!live) return null;
  return live.grid.dir === 'exporting' ? Math.round(live.grid.kw * 10) / 10 : 0;
}

/* ----------------------------------------------------------------------------
 * Shared optimistic lever-command hook for inline row controls. Mirrors the AC
 * detail pipeline (commits 260ed1b / 9f8c5a9): every lever updates its shown value
 * instantly; writes are coalesced per (device,lever) via a short debounce so rapid
 * taps send only the FINAL value. Setpoint debounces; mode/power fire ~immediately
 * (manual non-power levers are exempt from the 30s rate-limit server-side). A
 * pending value clears when the device poll reads back the requested value, or after
 * a safety settle window.
 * --------------------------------------------------------------------------*/
type PendingMap = Record<string, Partial<Record<ClimateLever, number | boolean | string>>>;

function useLeverCommands(devices: DeviceView[], refetch: () => void) {
  const [pending, setPending] = useState<PendingMap>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const settle = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const key = (id: string, lever: ClimateLever) => `${id}:${lever}`;

  const clearPending = (id: string, lever: ClimateLever) =>
    setPending((p) => {
      const dev = { ...(p[id] ?? {}) };
      delete dev[lever];
      return { ...p, [id]: dev };
    });

  const sendLever = (id: string, lever: ClimateLever, value: number | boolean | string, debounceMs = 0) => {
    setPending((p) => ({ ...p, [id]: { ...(p[id] ?? {}), [lever]: value } }));
    const k = key(id, lever);
    if (timers.current[k]) clearTimeout(timers.current[k]);
    timers.current[k] = setTimeout(() => {
      delete timers.current[k];
      void api.devices.command(id, lever, value)
        .then((res) => {
          const r = (res as { result?: { ok?: boolean } }).result;
          if (r?.ok === false) clearPending(id, lever); // rejected — snap back
        })
        .catch(() => { /* transient — keep optimistic; the poll reconciles */ })
        .finally(() => {
          refetch();
          if (settle.current[k]) clearTimeout(settle.current[k]);
          settle.current[k] = setTimeout(() => clearPending(id, lever), 45_000);
        });
    }, debounceMs);
  };

  // Confirm-poll: drop a pending value once the device reports the requested one.
  useEffect(() => {
    if (devices.length === 0) return;
    setPending((p) => {
      if (Object.keys(p).length === 0) return p;
      let changed = false;
      const next: PendingMap = {};
      for (const [id, levers] of Object.entries(p)) {
        const d = devices.find((x) => x.id === id);
        const keep: Partial<Record<ClimateLever, number | boolean | string>> = {};
        for (const [lever, val] of Object.entries(levers) as [ClimateLever, number | boolean | string][]) {
          const live =
            lever === 'power' ? d?.power
              : lever === 'mode' ? d?.mode
                : lever === 'setpoint' ? d?.setpointC
                  : undefined;
          if (d && live === val) { changed = true; continue; } // confirmed — drop
          keep[lever] = val;
        }
        if (Object.keys(keep).length) next[id] = keep;
        else if (Object.keys(levers).length) changed = true;
      }
      return changed ? next : p;
    });
  }, [devices]);

  // Tear down timers on unmount.
  useEffect(() => () => {
    for (const t of Object.values(timers.current)) clearTimeout(t);
    for (const t of Object.values(settle.current)) clearTimeout(t);
  }, []);

  const pendingFor = (id: string) => pending[id] ?? {};
  return { sendLever, pendingFor };
}

/* ---- type tab bar (matches the Autopilot SegmentedControl look + hue dots) -- */
function TypeTabs({ active, counts, wide, onSelect }: {
  active: DeviceType; counts: Record<DeviceType, number>; wide: boolean; onSelect: (t: DeviceType) => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 4, background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-lg)', padding: 5 }}>
      {DEVICE_TYPES.map((m) => {
        const on = m.type === active;
        const short = !wide && m.label.length > 7 ? m.label.slice(0, 5) : m.label;
        return (
          <button
            key={m.type}
            type="button"
            onClick={() => onSelect(m.type)}
            style={{
              flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
              padding: wide ? '9px 6px' : '8px 4px', borderRadius: 'var(--radius-md)', border: 'none', cursor: 'pointer',
              background: on ? 'var(--surface-3)' : 'transparent',
              boxShadow: on ? 'inset 0 1px 0 rgba(233,245,242,0.06)' : 'none',
              color: on ? 'var(--text-1)' : 'var(--text-2)',
              fontSize: wide ? 13 : 11.5, fontWeight: 500, minWidth: 0,
            }}
          >
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: m.hue, flex: 'none', opacity: on ? 1 : 0.6 }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{short}</span>
            {wide && counts[m.type] > 0 && (
              <span className="pwr-mono" style={{ fontSize: 11, color: on ? 'var(--text-3)' : 'var(--text-disabled)' }}>{counts[m.type]}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function SummaryTile({ label, value, color, accent }: { label: string; value: string; color?: string; accent?: 'solar' | 'grid' }) {
  const accentBg = accent === 'grid' ? 'var(--grid-wash)' : accent === 'solar' ? 'var(--solar-wash)' : 'var(--surface-1)';
  const accentBorder = accent === 'grid' ? 'rgba(245,165,36,0.25)' : accent === 'solar' ? 'rgba(46,230,160,0.25)' : 'var(--border-1)';
  const eyebrowColor = accent === 'grid' ? 'var(--grid)' : accent === 'solar' ? 'var(--solar-dim)' : 'var(--text-3)';
  return (
    <div style={{
      background: accentBg,
      border: `1px solid ${accentBorder}`,
      borderRadius: 'var(--radius-md)', padding: '8px 12px', textAlign: 'right', minWidth: 0,
    }}>
      <div className="pwr-eyebrow" style={{ color: eyebrowColor }}>{label}</div>
      <div className="pwr-mono" style={{ fontSize: 16, marginTop: 2, color: color ?? 'var(--text-1)' }}>{value}</div>
    </div>
  );
}

/* ---- inline row controls (shared by cooling + heating rows) --------------- */

/** Pulsing dot shown while a lever's command is in flight / unconfirmed. */
function SyncDot() {
  return (
    <span aria-label="syncing" title="Syncing — confirming with the unit" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--grid)', flex: 'none', animation: 'pwrSyncPulse 1s ease-in-out infinite' }}>
      <style>{`@keyframes pwrSyncPulse { 0%,100% { opacity: .35 } 50% { opacity: 1 } }`}</style>
    </span>
  );
}

const MODE_HUE: Record<string, string> = { heat: 'var(--grid)', cool: 'var(--battery)', auto: 'var(--text-2)', fan: 'var(--text-2)', dry: 'var(--battery)', stop: 'var(--text-3)' };

/** Clickable mode chip — cycles through the zone's available modes (heat→cool→auto…). */
function ModeChip({ mode, available, disabled, syncing, onCycle }: {
  mode: string; available: string[]; disabled: boolean; syncing: boolean; onCycle: () => void;
}) {
  const hue = MODE_HUE[mode] ?? 'var(--text-2)';
  const canCycle = !disabled && available.length > 1;
  return (
    <button
      type="button"
      disabled={!canCycle}
      onClick={(e) => { e.stopPropagation(); onCycle(); }}
      aria-label={`Mode ${mode} — tap to change`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 9px', borderRadius: 'var(--radius-pill)',
        border: `1px solid ${hue}`, background: 'transparent', color: hue, fontSize: 11.5, fontWeight: 600,
        cursor: canCycle ? 'pointer' : 'default', textTransform: 'capitalize', minWidth: 0,
      }}
    >
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{mode}</span>
      {syncing ? <SyncDot /> : canCycle && <Icon name="repeat" size={11} color={hue} />}
    </button>
  );
}

/** −/＋ setpoint steppers around a mono value. Dimmed/disabled when the room is off. */
function SetpointStepper({ value, lo, hi, step, accent, disabled, syncing, onStep, compact }: {
  value: number | null; lo: number; hi: number; step: number; accent: string; disabled: boolean; syncing: boolean; onStep: (delta: number) => void; compact?: boolean;
}) {
  const v = value;
  const stepBtn = (label: string, delta: number, off: boolean) => (
    <button
      type="button"
      disabled={off}
      aria-label={delta < 0 ? 'Lower setpoint' : 'Raise setpoint'}
      onClick={(e) => { e.stopPropagation(); onStep(delta); }}
      style={{
        width: compact ? 26 : 28, height: compact ? 26 : 28, display: 'grid', placeItems: 'center', borderRadius: 'var(--radius-md)',
        border: '1px solid var(--border-2)', background: 'var(--surface-2)', color: off ? 'var(--text-disabled)' : 'var(--text-1)',
        cursor: off ? 'default' : 'pointer', flex: 'none',
      }}
    >{label}</button>
  );
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: disabled ? 0.5 : 1 }}>
      {stepBtn('−', -step, disabled || v == null || v <= lo)}
      <span className="pwr-mono" style={{ fontSize: 13, fontWeight: 600, color: accent, minWidth: 42, textAlign: 'center', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
        {v == null ? '—' : `${v.toFixed(1)}°`}{syncing && <SyncDot />}
      </span>
      {stepBtn('+', step, disabled || v == null || v >= hi)}
    </div>
  );
}

/** Inline pill power toggle. */
function PowerToggle({ on, accent, accentWash, disabled, syncing, onToggle }: { on: boolean; accent: string; accentWash: string; disabled: boolean; syncing: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={on ? 'Turn off' : 'Turn on'}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      style={{
        width: 44, height: 24, borderRadius: 'var(--radius-pill)', border: '1px solid var(--border-2)', position: 'relative',
        background: on ? accentWash : 'var(--surface-3)', cursor: disabled ? 'default' : 'pointer', flex: 'none', padding: 0,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <span style={{ position: 'absolute', top: 2, left: on ? 22 : 2, width: 18, height: 18, borderRadius: '50%', background: on ? accent : 'var(--text-3)', transition: 'left .14s', display: 'grid', placeItems: 'center' }}>
        {syncing && <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--surface-1)', animation: 'pwrSyncPulse 1s ease-in-out infinite' }} />}
      </span>
    </button>
  );
}

/** Solar bolt — three states: lit (free surplus), dim (on paid energy), faint (not enrolled).
 *  Orange (--grid) = pre-heat; matches the unified surplus-bolt icon system (cool = blue bolt).
 *  Clickable (admin) to toggle this device's enrolment in surplus pre-heat. */
function SolarBolt({ enrolled, demand, exporting, hue = 'var(--grid)', label = 'pre-heat', canToggle, onToggle }: {
  enrolled: boolean; demand: boolean; exporting: boolean; hue?: string; label?: string; canToggle?: boolean; onToggle?: () => void;
}) {
  const lit = enrolled && demand && exporting;
  const color = enrolled ? hue : 'var(--text-3)';
  const opacity = lit ? 1 : enrolled ? 0.5 : 0.25;
  const verb = label === 'pre-cool' ? 'Cooling' : 'Heating';
  const title = !enrolled ? `Not in solar ${label} — tap to enrol`
    : lit ? `${verb} on free solar surplus — tap to remove`
    : `Solar ${label} enrolled (on paid energy now) — tap to remove`;
  const inner = <Icon name="zap" size={16} color={color} />;
  const glow = lit ? `drop-shadow(0 0 5px ${hue})` : 'none';
  if (!canToggle) {
    return <span title={title} style={{ display: 'inline-flex', filter: glow, opacity }}>{inner}</span>;
  }
  return (
    <button
      type="button"
      aria-label={enrolled ? `Remove from solar ${label}` : `Enrol in solar ${label}`}
      aria-pressed={enrolled}
      title={title}
      onClick={(e) => { e.stopPropagation(); onToggle?.(); }}
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', padding: 4, margin: -4, cursor: 'pointer', filter: glow, opacity }}
    >
      {inner}
    </button>
  );
}

/* ---- shared climate unit row (cooling + heating) -------------------------- */

function nextMode(cur: string, available: string[]): string {
  if (available.length === 0) return cur;
  const i = available.indexOf(cur);
  return available[(i + 1) % available.length];
}

/** State pill — driven by the active mode + running state. Heating distinguishes IDLE
 *  (on but not calling for heat) via the floor-demand signal; cooling has no such signal. */
function climateState(power: boolean, mode: string, active: boolean, hasDemand: boolean): { label: string; color: string; bg: string } {
  if (!power) return { label: 'OFF', color: 'var(--text-3)', bg: 'var(--surface-3)' };
  if (hasDemand && !active) return { label: 'IDLE', color: 'var(--text-2)', bg: 'var(--surface-3)' };
  const M: Record<string, [string, string, string]> = {
    cool: ['COOLING', 'var(--battery)', 'var(--battery-wash)'],
    heat: ['HEATING', 'var(--grid)', 'var(--grid-wash)'],
    dry: ['DRYING', 'var(--battery)', 'var(--battery-wash)'],
    fan: ['FAN', 'var(--text-2)', 'var(--surface-3)'],
    auto: ['AUTO', 'var(--text-2)', 'var(--surface-3)'],
  };
  const m = M[mode] ?? [mode.toUpperCase(), 'var(--text-2)', 'var(--surface-3)'];
  return { label: m[0], color: m[1], bg: m[2] };
}

function ClimateRow({ d, type, wide, canWrite, canConfig, exporting, pending, sendLever, onToggleSurplus, onOpen }: {
  d: DeviceView; type: 'cooling' | 'heating'; wide: boolean; canWrite: boolean; canConfig: boolean; exporting: boolean;
  pending: Partial<Record<ClimateLever, number | boolean | string>>;
  sendLever: (id: string, lever: ClimateLever, value: number | boolean | string, debounceMs?: number) => void;
  onToggleSurplus: (id: string, next: boolean) => void;
  onOpen: () => void;
}) {
  const isHeat = type === 'heating';
  const accent = isHeat ? 'var(--grid)' : 'var(--battery)';
  const accentWash = isHeat ? 'var(--grid-wash)' : 'var(--battery-wash)';
  const boltLabel = isHeat ? 'pre-heat' : 'pre-cool';
  // availableModes isn't on DeviceView yet; both fleets support cool/heat/auto — cycle
  // those (the server clamps anything else). Fan/dry/vanes stay on the detail page.
  const available = isHeat ? ['heat', 'cool', 'auto'] : ['cool', 'heat', 'auto'];

  const power = (pending.power as boolean | undefined) ?? d.power;
  const mode = (pending.mode as string | undefined) ?? d.mode;
  const setpoint = (pending.setpoint as number | undefined) ?? d.setpointC;
  const lo = d.minSetpointC ?? (isHeat ? 15 : 16);
  const hi = d.maxSetpointC ?? 30;
  const step = 0.5;
  // "Currently conditioning": heating has the floor-demand signal; cooling = on.
  const active = isHeat ? Boolean(d.floorDemand) : power;
  const st = climateState(power, mode, active, isHeat);

  const clampStep = (delta: number) => {
    const base = setpoint ?? lo;
    const v = Math.min(hi, Math.max(lo, Math.round((base + delta) * 2) / 2));
    sendLever(d.id, 'setpoint', v, 500);
  };
  const cycleMode = () => sendLever(d.id, 'mode', nextMode(mode, available), 0);
  const togglePower = () => sendLever(d.id, 'power', !power, 0);

  const bolt = <SolarBolt enrolled={d.automationEnabled} demand={active} exporting={exporting} hue={accent} label={boltLabel} canToggle={canConfig} onToggle={() => onToggleSurplus(d.id, !d.automationEnabled)} />;

  if (!wide) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '11px 12px' }}>
        {/* line 1: name · bolt · room temp · power */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button type="button" onClick={onOpen} style={{ flex: 1, minWidth: 0, textAlign: 'left', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' }}>
            <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-1)' }}>{d.name}</div>
            {d.room && d.room !== d.name && <div style={{ fontSize: 10.5, color: 'var(--text-3)' }}>{d.room}</div>}
          </button>
          {bolt}
          <span className="pwr-mono" style={{ fontSize: 13, color: WARMTH_COLOR[d.warmth], minWidth: 42, textAlign: 'right' }}>{t1(d.currentTempC)}</span>
          <PowerToggle on={power} accent={accent} accentWash={accentWash} disabled={!canWrite} syncing={pending.power !== undefined} onToggle={togglePower} />
        </div>
        {/* line 2: mode chip + setpoint steppers (right) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <ModeChip mode={mode} available={available} disabled={!canWrite || !power} syncing={pending.mode !== undefined} onCycle={cycleMode} />
          <span style={{ flex: 1 }} />
          <SetpointStepper value={setpoint} lo={lo} hi={hi} step={step} accent={accent} disabled={!canWrite || !power} syncing={pending.setpoint !== undefined} onStep={clampStep} compact />
        </div>
      </div>
    );
  }

  // Desktop grid: Room/zone · State · Mode · Solar · Setpoint · Room · Power · ›
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 92px 78px 34px 116px 56px 52px 22px', alignItems: 'center', gap: 10, padding: '10px 10px', borderRadius: 'var(--radius-md)' }}>
      <button type="button" onClick={onOpen} style={{ minWidth: 0, textAlign: 'left', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' }}>
        <div style={{ fontSize: 13.5, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--text-1)' }}>{d.name}</div>
        {d.room && d.room !== d.name && (
          <div style={{ fontSize: 11, color: 'var(--text-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.room}</div>
        )}
      </button>
      <span style={{ justifySelf: 'start', fontSize: 10.5, fontWeight: 600, letterSpacing: '0.04em', padding: '3px 8px', borderRadius: 'var(--radius-pill)', background: st.bg, color: st.color }}>{st.label}</span>
      <span style={{ justifySelf: 'start' }}><ModeChip mode={mode} available={available} disabled={!canWrite || !power} syncing={pending.mode !== undefined} onCycle={cycleMode} /></span>
      <span style={{ justifySelf: 'center' }}>{bolt}</span>
      <span style={{ justifySelf: 'end' }}><SetpointStepper value={setpoint} lo={lo} hi={hi} step={step} accent={accent} disabled={!canWrite || !power} syncing={pending.setpoint !== undefined} onStep={clampStep} /></span>
      <span className="pwr-mono" style={{ textAlign: 'right', fontSize: 13, color: WARMTH_COLOR[d.warmth] }}>{t1(d.currentTempC)}</span>
      <span style={{ justifySelf: 'end' }}><PowerToggle on={power} accent={accent} accentWash={accentWash} disabled={!canWrite} syncing={pending.power !== undefined} onToggle={togglePower} /></span>
      <button type="button" onClick={onOpen} aria-label="Open detail" style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, justifySelf: 'center' }}><Icon name="chevron-right" size={15} color="var(--text-3)" /></button>
    </div>
  );
}

function ComingSoon({ meta }: { meta: { label: string; icon: string; hue: string } }) {
  return (
    <Card padded style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: 28 }}>
      <span style={{ width: 40, height: 40, borderRadius: 11, display: 'grid', placeItems: 'center', background: 'var(--surface-3)', color: meta.hue }}><Icon name={meta.icon} size={20} /></span>
      <div style={{ fontSize: 15, fontWeight: 600 }}>{meta.label}</div>
      <div style={{ fontSize: 12.5, color: 'var(--text-3)', maxWidth: 320, lineHeight: 1.5 }}>Not set up yet — {meta.label.toLowerCase()} controls are coming to this hub.</div>
    </Card>
  );
}

export function Devices({ ctx }: { ctx: ShellContext }) {
  const nav = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const wide = ctx.desktop;
  const { data, loading, stale, updatedAt, refetch } = usePolling<DevicesResponse>(api.devices.list, 20_000);
  const { data: live } = usePolling<LiveResponse>(api.live, 20_000);
  const { data: status } = usePolling<DevicesStatus>(api.devices.status, 20_000);
  const { data: autoData, refetch: refetchAuto } = usePolling<AutomationsResponse>(api.automations.list, 0);
  const { data: lightsData } = usePolling<LightsResponse>(api.lights.list, 20_000);
  const { data: blindsData } = usePolling<BlindsResponse>(api.blinds.list, 20_000);
  // Active tab persists in the URL (?type=) so returning from a unit detail
  // restores the tab the device lives on (e.g. back from a heating zone → Heating).
  const [params, setParams] = useSearchParams();
  const paramType = params.get('type');
  const initialType: DeviceType = DEVICE_TYPES.some((m) => m.type === paramType) ? (paramType as DeviceType) : 'cooling';
  const [activeType, setActiveType] = useState<DeviceType>(initialType);
  const selectType = (t: DeviceType) => {
    setActiveType(t);
    setParams((prev) => { const n = new URLSearchParams(prev); n.set('type', t); return n; }, { replace: true });
  };

  const d = data;
  const armed = status?.armed ?? false;

  const counts = DEVICE_TYPES.reduce((acc, m) => {
    acc[m.type] = (d?.devices ?? []).filter((x) => classifyDevice(x) === m.type).length;
    return acc;
  }, {} as Record<DeviceType, number>);
  // Lights and blinds are separate Tuya fleets (not in the climate /api/devices list).
  counts.lighting = lightsData?.context.deviceCount ?? 0;
  counts.blinds = blindsData?.context.deviceCount ?? 0;

  const cooling = (d?.devices ?? []).filter((x) => classifyDevice(x) === 'cooling');
  const heating = (d?.devices ?? []).filter((x) => classifyDevice(x) === 'heating');
  const coolingNow = cooling.filter((x) => x.power && x.mode === 'cool').length;
  const warmest = cooling.reduce<number | null>((m, x) => (x.currentTempC != null && x.currentTempC > (m ?? -Infinity) ? x.currentTempC : m), null);
  const warmestHot = warmest != null && warmest >= 28;
  const surplus = surplusKw(live);
  const exporting = (surplus ?? 0) > 0;

  // Heating summary numbers.
  const heatingNow = heating.filter((x) => x.power && x.floorDemand).length;
  const heatTemps = heating.map((x) => x.currentTempC).filter((t): t is number => t != null);
  const heatIndoorAvg = heatTemps.length ? Math.round((heatTemps.reduce((a, b) => a + b, 0) / heatTemps.length) * 10) / 10 : null;
  const coldest = heating.reduce<number | null>((m, x) => (x.currentTempC != null && x.currentTempC < (m ?? Infinity) ? x.currentTempC : m), null);
  const coldestCold = coldest != null && coldest < 19;

  const heatCmds = useLeverCommands(heating, refetch);
  const coolCmds = useLeverCommands(cooling, refetch);
  // Manual row commands (power/mode/setpoint) are NOT arm-gated server-side (issueClimate
  // { manual: true }, commit 0c41458) — same as the unit detail. Only admin is required;
  // the disarmed note below explains that the *automation* won't act.
  const canWrite = isAdmin;
  // Per-device solar-surplus enrolment is a config setting (admin), independent of arm.
  const toggleSurplus = (id: string, next: boolean) => {
    void api.devices.setSettings(id, { automationEnabled: next }).then(() => refetch());
  };

  const automation: Automation | null = autoData?.automations?.[0] ?? null;
  const saveAuto = (patch: Partial<Automation>) => {
    if (!automation) return;
    void api.automations.update(automation.id, patch).then(() => refetchAuto());
  };

  const disarmedNote = !armed && (
    <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
      <Icon name="shield-off" size={13} color="var(--grid)" />
      Control is disarmed — the rule won't act. Arm it on the <button type="button" onClick={() => nav('/automations')} style={{ color: 'var(--solar)', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontWeight: 600 }}>Automations</button> screen.
    </div>
  );

  const coolingContent = !d ? null : !d.connected ? (
    <Card padded style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
      <span style={{ width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'var(--grid-wash)', color: 'var(--grid)', flex: 'none' }}><Icon name="cloud-off" size={16} /></span>
      <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5 }}>AC Cloud is not connected. Add your account in <strong style={{ color: 'var(--text-1)' }}>Settings → Connect AC Cloud</strong> to see and control the units.</div>
    </Card>
  ) : (
    <>
      {/* SUMMARY */}
      <div style={{ display: 'grid', gridTemplateColumns: wide ? 'repeat(4,1fr)' : '1fr 1fr', gap: 8 }}>
        <SummaryTile label="Cooling now" value={`${coolingNow} / ${cooling.length}`} color="var(--solar)" />
        <SummaryTile label="Indoor avg" value={d.context.indoorAvgC != null ? `${d.context.indoorAvgC.toFixed(1)}°` : '—'} />
        <SummaryTile label="Warmest" value={t1(warmest)} color={warmestHot ? 'var(--danger)' : 'var(--text-1)'} />
        <SummaryTile label="Surplus" value={surplus != null ? `${surplus >= 0 ? '+' : ''}${surplus} kW` : '—'} color="var(--solar)" accent="solar" />
      </div>

      {/* AUTOPILOT ROW — shared automation object (read/write here and on Automations) */}
      {automation && (
        <Card padded style={{ padding: '13px 15px' }}>
          <AutomationRow automation={automation} canWrite={isAdmin} onSave={saveAuto} subtitle="Automation · cooling" icon="zap" iconColor="var(--battery)" dim={!armed} />
          {disarmedNote}
        </Card>
      )}

      {/* UNIT LIST — same interactive row as Heating (blue accent, full mode set) */}
      {cooling.length > 0 ? (
        <Card padded style={{ padding: '6px 6px' }}>
          {wide && (
            <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 92px 78px 34px 116px 56px 52px 22px', gap: 10, padding: '4px 12px 6px' }}>
              <span className="pwr-eyebrow">Unit / room</span>
              <span className="pwr-eyebrow">State</span>
              <span className="pwr-eyebrow">Mode</span>
              <span className="pwr-eyebrow" style={{ textAlign: 'center' }}>Solar</span>
              <span className="pwr-eyebrow" style={{ textAlign: 'right' }}>Setpoint</span>
              <span className="pwr-eyebrow" style={{ textAlign: 'right' }}>Room</span>
              <span className="pwr-eyebrow" style={{ textAlign: 'right' }}>Power</span>
              <span />
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {cooling.map((dev, i) => (
              <div key={dev.id} style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border-1)' }}>
                <ClimateRow d={dev} type="cooling" wide={wide} canWrite={canWrite} canConfig={isAdmin} exporting={exporting} pending={coolCmds.pendingFor(dev.id)} sendLever={coolCmds.sendLever} onToggleSurplus={toggleSurplus} onOpen={() => nav(`/devices/${dev.id}`)} />
              </div>
            ))}
          </div>
        </Card>
      ) : (
        <Card padded style={{ textAlign: 'center', color: 'var(--text-3)', fontSize: 13, padding: 24 }}>
          {d.fleetError ? `Could not read the fleet: ${d.fleetError}` : 'No AC units reported by the account.'}
        </Card>
      )}
    </>
  );

  const heatingContent = !d ? null : (
    <>
      {/* SUMMARY (heating uses the --grid hue) */}
      <div style={{ display: 'grid', gridTemplateColumns: wide ? 'repeat(4,1fr)' : '1fr 1fr', gap: 8 }}>
        <SummaryTile label="Heating now" value={`${heatingNow} / ${heating.length}`} color="var(--grid)" />
        <SummaryTile label="Indoor avg" value={heatIndoorAvg != null ? `${heatIndoorAvg.toFixed(1)}°` : '—'} />
        <SummaryTile label="Coldest room" value={t1(coldest)} color={coldestCold ? 'var(--battery)' : 'var(--text-1)'} />
        <SummaryTile label="Surplus" value={surplus != null ? `${surplus >= 0 ? '+' : ''}${surplus} kW` : '—'} color="var(--grid)" accent="grid" />
      </div>

      {/* AUTOPILOT ROW — shared automation object; orange bolt (--grid) */}
      {automation && (
        <Card padded style={{ padding: '13px 15px' }}>
          <AutomationRow automation={automation} canWrite={isAdmin} onSave={saveAuto} subtitle="Automation · heating" icon="zap" iconColor="var(--grid)" dim={!armed} />
          {disarmedNote}
        </Card>
      )}

      {/* UNIT LIST */}
      {heating.length > 0 ? (
        <Card padded style={{ padding: '6px 6px' }}>
          {wide && (
            <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 92px 78px 34px 116px 56px 52px 22px', gap: 10, padding: '4px 12px 6px' }}>
              <span className="pwr-eyebrow">Room / zone</span>
              <span className="pwr-eyebrow">State</span>
              <span className="pwr-eyebrow">Mode</span>
              <span className="pwr-eyebrow" style={{ textAlign: 'center' }}>Solar</span>
              <span className="pwr-eyebrow" style={{ textAlign: 'right' }}>Setpoint</span>
              <span className="pwr-eyebrow" style={{ textAlign: 'right' }}>Room</span>
              <span className="pwr-eyebrow" style={{ textAlign: 'right' }}>Power</span>
              <span />
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {heating.map((dev, i) => (
              <div key={dev.id} style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border-1)' }}>
                <ClimateRow d={dev} type="heating" wide={wide} canWrite={canWrite} canConfig={isAdmin} exporting={exporting} pending={heatCmds.pendingFor(dev.id)} sendLever={heatCmds.sendLever} onToggleSurplus={toggleSurplus} onOpen={() => nav(`/devices/${dev.id}`)} />
              </div>
            ))}
          </div>
        </Card>
      ) : (
        <Card padded style={{ textAlign: 'center', color: 'var(--text-3)', fontSize: 13, padding: 24 }}>
          {d.fleetError ? `Could not read the fleet: ${d.fleetError}` : 'No underfloor zones reported.'}
        </Card>
      )}

      {!isAdmin && <div style={{ fontSize: 11.5, color: 'var(--grid)', textAlign: 'center' }}>Read-only — only an admin can command these zones.</div>}
    </>
  );

  const content = (t: DeviceType) => {
    if (t === 'cooling') return coolingContent;
    if (t === 'heating') return heatingContent;
    if (t === 'lighting') return <LightsPanel ctx={ctx} />;
    if (t === 'blinds') return <BlindsPanel ctx={ctx} />;
    return <ComingSoon meta={typeMeta(t)} />;
  };

  const body = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {stale && <StaleBanner updatedAt={updatedAt} />}
      {!d && loading && <Card padded style={{ color: 'var(--text-3)', fontSize: 13 }}>Loading devices…</Card>}
      {d && (
        <>
          <TypeTabs active={activeType} counts={counts} wide={wide} onSelect={selectType} />
          {content(activeType)}
        </>
      )}
    </div>
  );

  if (wide) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 880, margin: '0 auto', width: '100%' }}>
        {body}
      </div>
    );
  }
  return (
    <>
      <MobileHeader eyebrow="Home" title="Devices" right={<Avatar />} />
      <div style={{ padding: '8px 14px 22px' }}>{body}</div>
    </>
  );
}
