import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import type {
  DeviceView, DevicesResponse, DeviceWarmth, LiveResponse, DevicesStatus, AutomationsResponse, Automation, ClimateLever, LightsResponse, BlindsResponse, SpeakersResponse,
  ConfiguredResponse, ConfiguredDeviceView, Capability,
} from '../lib/types';
import { Card, Icon, Switch, Button } from '../components/ui';
import { Gauge } from '../components/Gauge';
import { MobileHeader, Avatar, StaleBanner } from './_shared';
import { useAuth } from '../auth/AuthProvider';
import type { ShellContext } from '../components/shell/AppShell';
import { DEVICE_TYPES, classifyDevice, resolveTypeMeta, type DeviceType } from '../lib/deviceTypes';
import { AutomationRow } from '../components/AutomationRow';
import { GenericControl } from '../components/GenericControl';
import { primaryCapabilities, powerCap, findMeasure } from '../lib/capabilities';
import { LightsPanel } from './Lights';
import { BlindsPanel } from './Blinds';
import { SpeakersPanel } from './Speakers';
import { DiscoveredInbox, useDiscoveredCount } from './DiscoveredInbox';

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

/** A hub view = a device type id (built-in or custom) OR the onboarding inbox. */
type HubView = string; // a DeviceType key, a custom type id, or 'needs-setup'

/** One tab in the type bar — built-in or custom, with its hue + icon + count. */
interface TabSpec {
  id: string;
  label: string;
  hue: string;
  icon: string;
  count: number;
}

/* ---- type tab bar (matches the Autopilot SegmentedControl look + hue dots) --
 * Renders built-in tabs plus any type (built-in or custom) that has configured
 * generic devices. Appends a warning-toned "Needs setup · N" segment when N>0. */
function TypeTabs({ active, tabs, needsSetup, wide, onSelect }: {
  active: HubView; tabs: TabSpec[]; needsSetup: number; wide: boolean; onSelect: (t: HubView) => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 4, background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-lg)', padding: 5, flexWrap: 'wrap' }}>
      {tabs.map((m) => {
        const on = m.id === active;
        const short = !wide && m.label.length > 7 ? m.label.slice(0, 5) : m.label;
        return (
          <button
            key={m.id}
            type="button"
            onClick={() => onSelect(m.id)}
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
            {wide && m.count > 0 && (
              <span className="pwr-mono" style={{ fontSize: 11, color: on ? 'var(--text-3)' : 'var(--text-disabled)' }}>{m.count}</span>
            )}
          </button>
        );
      })}
      {needsSetup > 0 && (() => {
        const on = active === 'needs-setup';
        return (
          <button
            type="button"
            onClick={() => onSelect('needs-setup')}
            title="Devices found but not set up yet"
            style={{
              flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              padding: wide ? '9px 6px' : '8px 4px', borderRadius: 'var(--radius-md)', border: '1px solid rgba(245,165,36,0.35)', cursor: 'pointer',
              background: on ? 'var(--grid-wash)' : 'transparent',
              color: on ? 'var(--grid)' : 'var(--text-2)',
              fontSize: wide ? 13 : 11.5, fontWeight: 600, minWidth: 0,
            }}
          >
            <Icon name="sparkles" size={12} color="var(--grid)" />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{wide ? 'Needs setup' : 'Setup'}</span>
            <span className="pwr-mono" style={{ fontSize: 11, color: 'var(--grid)' }}>{needsSetup}</span>
          </button>
        );
      })()}
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

/** Solar bolt — one PER DIRECTION. Blue (--battery) = solar COOL, orange (--grid) = solar
 *  HEAT. Three states: lit (enrolled + this direction in demand + exporting), dim (enrolled,
 *  on paid energy / no demand), faint (not enrolled). Clickable (admin) to toggle THIS
 *  direction's enrolment independently. */
function SolarBolt({ dir, enrolled, demand, exporting, canToggle, onToggle }: {
  dir: 'cool' | 'heat'; enrolled: boolean; demand: boolean; exporting: boolean; canToggle?: boolean; onToggle?: () => void;
}) {
  const hue = dir === 'cool' ? 'var(--battery)' : 'var(--grid)';
  const word = dir === 'cool' ? 'cooling' : 'heating';
  const lit = enrolled && demand && exporting;
  const color = enrolled ? hue : 'var(--text-3)';
  const opacity = lit ? 1 : enrolled ? 0.5 : 0.25;
  const title = !enrolled ? `Not enrolled in solar ${word} — tap to enrol`
    : lit ? `Solar ${word} on free surplus now — tap to remove`
    : `Solar ${word} enrolled (on paid energy / no demand now) — tap to remove`;
  const inner = <Icon name="zap" size={15} color={color} />;
  const glow = lit ? `drop-shadow(0 0 5px ${hue})` : 'none';
  if (!canToggle) {
    return <span title={title} style={{ display: 'inline-flex', filter: glow, opacity }}>{inner}</span>;
  }
  return (
    <button
      type="button"
      aria-label={enrolled ? `Remove from solar ${word}` : `Enrol in solar ${word}`}
      aria-pressed={enrolled}
      title={title}
      onClick={(e) => { e.stopPropagation(); onToggle?.(); }}
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', padding: 3, margin: -3, cursor: 'pointer', filter: glow, opacity }}
    >
      {inner}
    </button>
  );
}

/** Manual-on marker — lit hand when the user has switched this unit on by hand (so the
 *  surplus rule won't auto-stop it); a faint placeholder otherwise so columns align. */
function HandMark({ manualOn }: { manualOn: boolean }) {
  if (!manualOn) {
    return <span aria-hidden style={{ display: 'inline-flex', opacity: 0.15 }}><Icon name="hand" size={15} color="var(--text-3)" /></span>;
  }
  return (
    <span title="Manually switched on — excluded from auto-stop" style={{ display: 'inline-flex', opacity: 1 }}>
      <Icon name="hand" size={15} color="var(--text-1)" />
    </span>
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

// Desktop row grids. COOLING has a wider Solar column to fit TWO bolts (blue cool +
// orange heat) and keeps the Manual column. HEATING drops both Solar and Manual.
//                Unit    State  Mode  Solar Manual Setpt Room Pwr  ›
const COOL_GRID = '1.5fr 92px 78px 56px 30px 116px 56px 52px 22px';
//                Unit    State  Mode  Setpt Room Pwr  ›
const HEAT_GRID = '1.5fr 92px 78px 116px 56px 52px 22px';

function ClimateRow({ d, type, wide, canWrite, canConfig, exporting, pending, sendLever, onToggleSurplus, onOpen }: {
  d: DeviceView; type: 'cooling' | 'heating'; wide: boolean; canWrite: boolean; canConfig: boolean; exporting: boolean;
  pending: Partial<Record<ClimateLever, number | boolean | string>>;
  sendLever: (id: string, lever: ClimateLever, value: number | boolean | string, debounceMs?: number) => void;
  onToggleSurplus: (id: string, dir: 'cool' | 'heat', next: boolean) => void;
  onOpen: () => void;
}) {
  const isHeat = type === 'heating';
  const accent = isHeat ? 'var(--grid)' : 'var(--battery)';
  const accentWash = isHeat ? 'var(--grid-wash)' : 'var(--battery-wash)';
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

  const accSetRef = useRef<number | null>(null);
  useEffect(() => { if (pending.setpoint === undefined) accSetRef.current = null; }, [pending.setpoint]);
  const clampStep = (delta: number) => {
    const base = accSetRef.current ?? setpoint ?? lo;
    const v = Math.min(hi, Math.max(lo, Math.round((base + delta) * 2) / 2));
    accSetRef.current = v;
    sendLever(d.id, 'setpoint', v, 500);
  };
  const cycleMode = () => sendLever(d.id, 'mode', nextMode(mode, available), 0);
  const togglePower = () => sendLever(d.id, 'power', !power, 0);

  // Solar enrolment applies only to the HVAC (cooling) fleet — TWO independent bolts:
  // blue = solar cooling (lit when warm), orange = solar heating (lit when cold). The
  // heating (underfloor) tab is not surplus-eligible and shows no bolts at all.
  const warmNow = d.currentTempC != null ? d.currentTempC >= 24 : power;
  const bolts = isHeat ? null : (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <SolarBolt dir="cool" enrolled={d.solarCoolEnabled} demand={warmNow} exporting={exporting} canToggle={canConfig} onToggle={() => onToggleSurplus(d.id, 'cool', !d.solarCoolEnabled)} />
      <SolarBolt dir="heat" enrolled={d.solarHeatEnabled} demand={!warmNow} exporting={exporting} canToggle={canConfig} onToggle={() => onToggleSurplus(d.id, 'heat', !d.solarHeatEnabled)} />
    </span>
  );
  const handMark = <HandMark manualOn={d.manualOn} />;

  if (!wide) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '11px 12px' }}>
        {/* line 1: name · bolt · room temp · power */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button type="button" onClick={onOpen} style={{ flex: 1, minWidth: 0, textAlign: 'left', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' }}>
            <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-1)' }}>{d.name}</div>
            {d.room && d.room !== d.name && <div style={{ fontSize: 10.5, color: 'var(--text-3)' }}>{d.room}</div>}
          </button>
          {/* Cooling: two solar bolts (blue cool / orange heat) + manual hand. Heating
              (underfloor) is not surplus-eligible and carries no solar/manual markers. */}
          {!isHeat && bolts}
          {!isHeat && handMark}
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

  // Desktop grid. Cooling: Unit · State · Mode · Solar(2 bolts) · Manual · Setpoint · Room ·
  // Power · ›. Heating: same MINUS Solar + Manual (underfloor isn't surplus-eligible and
  // manual protection is irrelevant there).
  return (
    <div style={{ display: 'grid', gridTemplateColumns: isHeat ? HEAT_GRID : COOL_GRID, alignItems: 'center', gap: 10, padding: '10px 10px', borderRadius: 'var(--radius-md)' }}>
      <button type="button" onClick={onOpen} style={{ minWidth: 0, textAlign: 'left', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' }}>
        <div style={{ fontSize: 13.5, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--text-1)' }}>{d.name}</div>
        {d.room && d.room !== d.name && (
          <div style={{ fontSize: 11, color: 'var(--text-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.room}</div>
        )}
      </button>
      <span style={{ justifySelf: 'start', fontSize: 10.5, fontWeight: 600, letterSpacing: '0.04em', padding: '3px 8px', borderRadius: 'var(--radius-pill)', background: st.bg, color: st.color }}>{st.label}</span>
      <span style={{ justifySelf: 'start' }}><ModeChip mode={mode} available={available} disabled={!canWrite || !power} syncing={pending.mode !== undefined} onCycle={cycleMode} /></span>
      {!isHeat && <span style={{ justifySelf: 'center' }}>{bolts}</span>}
      {!isHeat && <span style={{ justifySelf: 'center' }}>{handMark}</span>}
      <span style={{ justifySelf: 'end' }}><SetpointStepper value={setpoint} lo={lo} hi={hi} step={step} accent={accent} disabled={!canWrite || !power} syncing={pending.setpoint !== undefined} onStep={clampStep} /></span>
      <span className="pwr-mono" style={{ textAlign: 'right', fontSize: 13, color: WARMTH_COLOR[d.warmth] }}>{t1(d.currentTempC)}</span>
      <span style={{ justifySelf: 'end' }}><PowerToggle on={power} accent={accent} accentWash={accentWash} disabled={!canWrite} syncing={pending.power !== undefined} onToggle={togglePower} /></span>
      <button type="button" onClick={onOpen} aria-label="Open detail" style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, justifySelf: 'center' }}><Icon name="chevron-right" size={15} color="var(--text-3)" /></button>
    </div>
  );
}

/* ---- generic (set-up) device group ---------------------------------------- */

/** A compact card for one configured generic device — header + the generic control
 *  renderer. Used in the type tab grid; the whole card title links to its detail. */
function GenericDeviceCard({ d, wide, canWrite, onWrite, onOpen }: {
  d: ConfiguredDeviceView; wide: boolean; canWrite: boolean;
  onWrite: (dp: string, kind: Capability['kind'], value: unknown) => Promise<unknown> | void;
  onOpen: () => void;
}) {
  return (
    <Card padded style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button type="button" onClick={onOpen} style={{ flex: 1, minWidth: 0, textAlign: 'left', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</div>
          <div className="pwr-mono" style={{ fontSize: 10.5, color: 'var(--text-3)', marginTop: 1 }}>
            Tuya · {d.category || '?'}{!d.online ? ' · offline' : ''}
          </div>
        </button>
        <button type="button" onClick={onOpen} aria-label="Open detail" style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 2 }}>
          <Icon name="chevron-right" size={16} color="var(--text-3)" />
        </button>
      </div>
      <GenericControl capabilities={primaryCapabilities(d.capabilities)} values={d.values} onWrite={onWrite} disabled={!canWrite} variant="card" />
    </Card>
  );
}

/** A clean card for one configured circuit breaker / switch: inline-editable name,
 *  one On/Off switch, two live gauges (Current + Voltage) and a Schedule shortcut.
 *  The full datapoint list stays on the detail page. */
function CircuitBreakerCard({ d, wide, canWrite, onWrite, onOpen, onSchedule, onRenamed }: {
  d: ConfiguredDeviceView; wide: boolean; canWrite: boolean;
  onWrite: (dp: string, kind: Capability['kind'], value: unknown) => Promise<unknown> | void;
  onOpen: () => void;
  onSchedule: () => void;
  onRenamed: () => void;
}) {
  void wide;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(d.name);
  const [saving, setSaving] = useState(false);

  const sw = powerCap(d.capabilities);
  const cur = findMeasure(d.capabilities, 'current');
  const volt = findMeasure(d.capabilities, 'voltage');
  const on = sw ? Boolean(d.values[sw.dp]) : false;

  const startEdit = () => { setDraft(d.name); setEditing(true); };
  const save = async () => {
    const name = draft.trim();
    if (!name || name === d.name) { setEditing(false); return; }
    setSaving(true);
    try {
      await api.devices.rename(d.id, name);
      onRenamed();
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const numFrom = (dp?: string): number | null => {
    if (!dp) return null;
    const v = d.values[dp];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };

  return (
    <Card padded style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Header: name (inline-editable for admins) + chevron to detail */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {editing ? (
          <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void save(); if (e.key === 'Escape') setEditing(false); }}
              disabled={saving}
              style={{
                flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, color: 'var(--text-1)',
                background: 'var(--surface-3)', border: '1px solid var(--border-1)', borderRadius: 8,
                padding: '5px 8px', outline: 'none',
              }}
            />
            <button type="button" aria-label="Save name" onClick={() => void save()} disabled={saving}
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 3 }}>
              <Icon name="check" size={16} color="var(--solar)" />
            </button>
            <button type="button" aria-label="Cancel rename" onClick={() => setEditing(false)} disabled={saving}
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 3 }}>
              <Icon name="x" size={16} color="var(--text-3)" />
            </button>
          </div>
        ) : (
          <>
            <button type="button" onClick={onOpen} style={{ flex: 1, minWidth: 0, textAlign: 'left', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</div>
              <div className="pwr-mono" style={{ fontSize: 10.5, color: 'var(--text-3)', marginTop: 1 }}>
                Tuya · {d.category || '?'}{!d.online ? ' · offline' : ''}
              </div>
            </button>
            {canWrite && (
              <button type="button" aria-label="Rename" onClick={startEdit} style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 2 }}>
                <Icon name="pencil" size={15} color="var(--text-3)" />
              </button>
            )}
            <button type="button" onClick={onOpen} aria-label="Open detail" style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 2 }}>
              <Icon name="chevron-right" size={16} color="var(--text-3)" />
            </button>
          </>
        )}
      </div>

      {/* On/Off row */}
      {sw && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <span style={{ fontSize: 13, color: 'var(--text-2)' }}>Power</span>
          <Switch
            checked={on}
            disabled={!canWrite}
            onChange={(e) => onWrite(sw.dp, 'switch', e.target.checked)}
          />
        </div>
      )}

      {/* Gauges row — Current + Voltage */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, placeItems: 'center' }}>
        <Gauge label="Current" value={numFrom(cur?.dp)} unit={cur?.unit ?? 'mA'} accent="var(--ev)" nominalFloor={1000} size={124} />
        <Gauge label="Voltage" value={numFrom(volt?.dp)} unit={volt?.unit ?? 'V'} accent="var(--grid)" nominalFloor={250} size={124} />
      </div>

      {/* Footer — Schedule shortcut */}
      <div>
        <Button size="sm" variant="secondary" onClick={onSchedule} iconLeft={<Icon name="calendar-clock" size={14} />}>
          Schedule
        </Button>
      </div>
    </Card>
  );
}

/** The content for a type tab populated by configured generic devices (Switching /
 *  custom / any type a set-up device landed in). */
function GenericGroup({ devices, wide, canWrite, onWrite, onOpen, emptyMeta, breaker, onSchedule, onRenamed }: {
  devices: ConfiguredDeviceView[]; wide: boolean; canWrite: boolean;
  onWrite: (id: string, dp: string, kind: Capability['kind'], value: unknown) => Promise<unknown> | void;
  onOpen: (id: string) => void;
  emptyMeta: { label: string; icon: string; hue: string };
  /** Render the clean CircuitBreakerCard instead of the generic card (Switching tab). */
  breaker?: boolean;
  onSchedule?: (id: string) => void;
  onRenamed?: () => void;
}) {
  if (devices.length === 0) return <ComingSoon meta={emptyMeta} />;
  const sorted = [...devices].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return (
    <div style={{ display: 'grid', gridTemplateColumns: wide ? 'repeat(2, 1fr)' : '1fr', gap: 10 }}>
      {sorted.map((d) => (
        breaker ? (
          <CircuitBreakerCard
            key={d.id}
            d={d}
            wide={wide}
            canWrite={canWrite}
            onWrite={(dp, kind, value) => onWrite(d.id, dp, kind, value)}
            onOpen={() => onOpen(d.id)}
            onSchedule={() => onSchedule?.(d.id)}
            onRenamed={() => onRenamed?.()}
          />
        ) : (
          <GenericDeviceCard
            key={d.id}
            d={d}
            wide={wide}
            canWrite={canWrite}
            onWrite={(dp, kind, value) => onWrite(d.id, dp, kind, value)}
            onOpen={() => onOpen(d.id)}
          />
        )
      ))}
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
  const { data: speakersData } = usePolling<SpeakersResponse>(api.speakers.list, 20_000);
  // Configured (set-up) generic devices — populate the Switching + custom tabs.
  const { data: configuredData, refetch: refetchConfigured } = usePolling<ConfiguredResponse>(api.devices.configured, 20_000);
  // Active tab persists in the URL (?type=) so returning from a unit detail
  // restores the tab the device lives on (e.g. back from a heating zone → Heating).
  const [params, setParams] = useSearchParams();
  const paramType = params.get('type');
  const initialType: HubView = paramType || 'cooling';
  const [activeType, setActiveType] = useState<HubView>(initialType);
  const selectType = (t: HubView) => {
    setActiveType(t);
    setParams((prev) => { const n = new URLSearchParams(prev); n.set('type', t); return n; }, { replace: true });
  };
  // Discovered (not-yet-set-up) count — badges the tab + drives the pinned card.
  const needsSetupCount = useDiscoveredCount();
  const inboxView = activeType === 'needs-setup';

  const d = data;
  const armed = status?.armed ?? false;

  const configured = configuredData?.devices ?? [];
  const customTypes = configuredData?.customDeviceTypes ?? [];

  const counts = DEVICE_TYPES.reduce((acc, m) => {
    acc[m.type] = (d?.devices ?? []).filter((x) => classifyDevice(x) === m.type).length;
    return acc;
  }, {} as Record<DeviceType, number>);
  // Lights and blinds are separate Tuya fleets (not in the climate /api/devices list).
  counts.lighting = lightsData?.context.deviceCount ?? 0;
  counts.blinds = blindsData?.context.deviceCount ?? 0;
  // Speakers are the Sonos fleet (local UPnP, separate from /api/devices).
  counts.speakers = speakersData?.context.deviceCount ?? 0;
  // Configured generic devices feed the Switching tab + any custom-type tab.
  // Skip 'lighting' — those are folded into the /api/lights fleet already, so
  // counts.lighting (from the fleet) would otherwise double-count them.
  for (const cfg of configured) {
    if (cfg.typeId === 'lighting') continue;
    if (cfg.typeId in counts) (counts as Record<string, number>)[cfg.typeId] += 1;
  }
  counts.switching = configured.filter((c) => c.typeId === 'switching').length;

  // Devices grouped by their assigned typeId (built-in or custom).
  const configuredByType = (typeId: string) => configured.filter((c) => c.typeId === typeId);

  // Tab list = the built-in types + any custom type that has configured devices.
  const customTabSpecs: TabSpec[] = customTypes
    .filter((c) => configuredByType(c.id).length > 0)
    .map((c) => { const m = resolveTypeMeta(c.id, customTypes); return { id: c.id, label: c.label, hue: m.hue, icon: m.icon, count: configuredByType(c.id).length }; });
  const tabs: TabSpec[] = [
    ...DEVICE_TYPES.map((m) => ({ id: m.type, label: m.label, hue: m.hue, icon: m.icon, count: counts[m.type] })),
    ...customTabSpecs,
  ];

  // Optimistic write for a generic capability — fire-and-refetch.
  const writeCap = (id: string, dp: string, kind: Capability['kind'], value: unknown) =>
    api.devices.commandCap(id, dp, kind, value).finally(() => refetchConfigured());

  const cooling = (d?.devices ?? []).filter((x) => classifyDevice(x) === 'cooling').sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  const heating = (d?.devices ?? []).filter((x) => classifyDevice(x) === 'heating').sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
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
  // Cool and heat are now independent flags — toggle whichever direction was tapped.
  const toggleSurplus = (id: string, dir: 'cool' | 'heat', next: boolean) => {
    const patch = dir === 'cool' ? { solarCoolEnabled: next } : { solarHeatEnabled: next };
    void api.devices.setSettings(id, patch).then(() => refetch());
  };

  // The Cooling hub shows the COOLING surplus rule (solar_surplus_precool); the heating
  // rule lives on the Automations screen. Fall back to the first automation for any
  // legacy single-rule install.
  const automation: Automation | null =
    autoData?.automations?.find((a) => a.type === 'solar_surplus_precool') ??
    autoData?.automations?.[0] ??
    null;
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
          <AutomationRow automation={automation} canWrite={isAdmin} onSave={saveAuto} subtitle="Solar-surplus cooling · cools enrolled HVAC when a room is warm — on surplus" icon="zap" iconColor="var(--battery)" dim={!armed} />
          {disarmedNote}
        </Card>
      )}

      {/* UNIT LIST — same interactive row as Heating (blue accent, full mode set) */}
      {cooling.length > 0 ? (
        <Card padded style={{ padding: '6px 6px' }}>
          {wide && (
            <div style={{ display: 'grid', gridTemplateColumns: COOL_GRID, gap: 10, padding: '4px 12px 6px' }}>
              <span className="pwr-eyebrow">Unit / room</span>
              <span className="pwr-eyebrow">State</span>
              <span className="pwr-eyebrow">Mode</span>
              <span className="pwr-eyebrow" style={{ textAlign: 'center' }}>Solar</span>
              <span className="pwr-eyebrow" style={{ textAlign: 'center' }}>Manual</span>
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

      {/* No Solar-surplus banner on Heating — underfloor is no longer surplus-eligible.
          (The HVAC "solar climate" rule lives on the Cooling tab.) */}

      {/* UNIT LIST */}
      {heating.length > 0 ? (
        <Card padded style={{ padding: '6px 6px' }}>
          {wide && (
            <div style={{ display: 'grid', gridTemplateColumns: HEAT_GRID, gap: 10, padding: '4px 12px 6px' }}>
              {/* Underfloor heating: not surplus-eligible (no Solar) and not surplus-
                  owned, so manual protection is irrelevant (no Manual column either). */}
              <span className="pwr-eyebrow">Room / zone</span>
              <span className="pwr-eyebrow">State</span>
              <span className="pwr-eyebrow">Mode</span>
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

  const onSetupDone = (typeId: string) => {
    refetchConfigured();
    // Jump to the group the device graduated into (switching by default; the inbox
    // passes the proposed-type label, which may not be a tab id — fall to switching).
    const target = tabs.some((t) => t.id === typeId) ? typeId : 'switching';
    selectType(target);
  };

  // A set-up generic device can be pointed at a BUILT-IN bespoke type (Cooling /
  // Heating / Lighting / Blinds) from the setup sheet — not just Switching/custom.
  // Those bespoke tabs render their own native fleet, so the configured devices
  // assigned to them would otherwise be orphaned (counted in the tab, never shown).
  // Render them via the generic group BELOW the native fleet so they always appear.
  const bespokeExtras = (t: HubView) => {
    const extras = configuredByType(t);
    if (extras.length === 0) return null;
    return (
      <GenericGroup
        devices={extras}
        wide={wide}
        canWrite={isAdmin}
        onWrite={writeCap}
        onOpen={(id) => nav(`/devices/generic/${id}`)}
        emptyMeta={{ label: '', icon: 'plug', hue: 'var(--text-3)' }}
      />
    );
  };

  const content = (t: HubView) => {
    if (t === 'needs-setup') return <DiscoveredInbox wide={wide} canTriage={isAdmin} onSetupDone={onSetupDone} />;
    if (t === 'cooling') return <>{coolingContent}{bespokeExtras(t)}</>;
    if (t === 'heating') return <>{heatingContent}{bespokeExtras(t)}</>;
    // Lighting: devices set up as 'lighting' are folded into the /api/lights fleet
    // and render as light cards inside LightsPanel — no separate generic block here.
    if (t === 'lighting') return <LightsPanel ctx={ctx} />;
    if (t === 'blinds') return <><BlindsPanel ctx={ctx} />{bespokeExtras(t)}</>;
    // Speakers: the Sonos fleet + the house-alarm control (local UPnP, not Tuya).
    if (t === 'speakers') return <><SpeakersPanel ctx={ctx} />{bespokeExtras(t)}</>;
    // Switching (built-in generic bucket) + any custom type → the generic group.
    const meta = resolveTypeMeta(t, customTypes);
    return (
      <GenericGroup
        devices={configuredByType(t)}
        wide={wide}
        canWrite={isAdmin}
        onWrite={writeCap}
        onOpen={(id) => nav(`/devices/generic/${id}`)}
        emptyMeta={{ label: meta.label, icon: meta.icon, hue: meta.hue }}
        breaker={t === 'switching'}
        onSchedule={(id) => nav(`/automations?tab=schedules&new=${id}`)}
        onRenamed={refetchConfigured}
      />
    );
  };

  // Pinned inbox prompt — sits atop the hub whenever there are devices to triage and
  // we're not already on the inbox. One tap jumps to the Needs-setup view.
  const inboxPrompt = needsSetupCount > 0 && !inboxView && (
    <Card padded style={{ display: 'flex', alignItems: 'center', gap: 11, background: 'var(--grid-wash)', border: '1px solid rgba(245,165,36,0.3)', cursor: 'pointer' }} onClick={() => selectType('needs-setup')}>
      <span style={{ width: 32, height: 32, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'var(--surface-1)', color: 'var(--grid)', flex: 'none' }}><Icon name="sparkles" size={17} /></span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-1)' }}>{needsSetupCount} device{needsSetupCount === 1 ? '' : 's'} found, not set up yet</div>
        <div style={{ fontSize: 11.5, color: 'var(--text-2)' }}>Review and triage what your account has paired.</div>
      </div>
      <Icon name="chevron-right" size={16} color="var(--grid)" />
    </Card>
  );

  const body = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {stale && <StaleBanner updatedAt={updatedAt} />}
      {!d && loading && <Card padded style={{ color: 'var(--text-3)', fontSize: 13 }}>Loading devices…</Card>}
      {d && (
        <>
          {inboxPrompt}
          <TypeTabs active={activeType} tabs={tabs} needsSetup={needsSetupCount} wide={wide} onSelect={selectType} />
          {content(activeType)}
        </>
      )}
    </div>
  );

  if (wide) {
    // Full-width like every other page (title comes from the AppShell TopBar).
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, width: '100%' }}>
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
