import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import type {
  Automation, AutomationsResponse, DevicesResponse, DevicesStatus,
  LiveResponse, SolarSurplusPrecoolParams, TariffArbitrageParams,
  ControlStatus, BatteryPriorityKey, BatteryPriorityRule, SoakExportRule,
  ArbitrageEvent, ArbitrageStats, ArbitrageEventType,
} from '../lib/types';
import { isTariffArbitrage } from '../lib/types';
import { Card, Icon, Button, Switch, SegmentedControl, Slider, Eyebrow } from '../components/ui';
import { AutomationRow } from '../components/AutomationRow';
import { MobileHeader, Avatar, StaleBanner } from './_shared';
import { SchedulesPanel } from './Schedules';
import { Autopilot, type TabKey as AutopilotTabKey } from './Autopilot';
import { useAuth } from '../auth/AuthProvider';
import type { ShellContext } from '../components/shell/AppShell';
import type { ReactNode } from 'react';

/* ============================================================================
 * Automations (/automations) — to the approved design: the master arm control,
 * then per-rule WHEN / DO / UNTIL / LIMITS colored blocks with a live preview of
 * what the rule would do right now, plus a collapsible editor. Admin-gated.
 * ==========================================================================*/

function batterySoc(live: LiveResponse | null): number | null {
  if (!live) return null;
  return Math.round((live.sonnen.soc * 9.2 + live.tesla.soc * 27) / (9.2 + 27));
}

function Tok({ children, color }: { children: ReactNode; color?: string }) {
  return <span className="pwr-mono" style={{ fontSize: 12, background: 'var(--surface-3)', border: '1px solid var(--border-1)', borderRadius: 7, padding: '3px 8px', color: color ?? 'var(--text-1)' }}>{children}</span>;
}
function Block({ label, color, wash, children }: { label: string; color: string; wash: string; children: ReactNode }) {
  return (
    <div style={{ background: wash, border: `1px solid ${color}`, borderRadius: 'var(--radius-lg)', padding: '11px 14px' }}>
      <div className="pwr-eyebrow" style={{ color, marginBottom: 7 }}>{label}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', fontSize: 12.5, lineHeight: 2 }}>{children}</div>
    </div>
  );
}

function ArmCard({ status, canWrite, onArm, busy }: {
  status: DevicesStatus | null; canWrite: boolean; onArm: (armed: boolean, mode: 'auto' | 'manual') => void; busy: boolean;
}) {
  const armed = status?.armed ?? false;
  const mode = status?.mode ?? 'off';
  return (
    <Card accent={armed ? 'solar' : 'grid'} glow padded style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
        <span style={{ width: 36, height: 36, borderRadius: 10, display: 'grid', placeItems: 'center', background: armed ? 'var(--solar-wash)' : 'var(--grid-wash)', color: armed ? 'var(--solar)' : 'var(--grid)', flex: 'none' }}><Icon name={armed ? 'shield-check' : 'shield-off'} size={19} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Climate control · {armed ? (mode === 'auto' ? 'Auto' : 'Manual') : 'Disarmed'}</div>
          <div style={{ fontSize: 12, color: 'var(--text-2)' }}>{armed ? 'Writes are permitted. Automations in Auto will act.' : 'Read-only. Nothing is written to the units.'}</div>
        </div>
      </div>
      {status?.lastError && <div style={{ fontSize: 11.5, color: 'var(--danger)' }}>{status.lastError}</div>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button size="sm" variant={armed && mode === 'manual' ? 'primary' : 'secondary'} disabled={!canWrite || busy} onClick={() => onArm(true, 'manual')}>Arm · Manual</Button>
        <Button size="sm" variant={armed && mode === 'auto' ? 'primary' : 'secondary'} disabled={!canWrite || busy} onClick={() => onArm(true, 'auto')}>Arm · Auto</Button>
        <Button size="sm" variant="danger" disabled={!canWrite || busy || !armed} onClick={() => onArm(false, 'manual')}>Disarm</Button>
      </div>
      {!canWrite && <div style={{ fontSize: 11.5, color: 'var(--grid)' }}>Only an admin can arm device control.</div>}
    </Card>
  );
}

function RuleCard({ a, live, devData, canWrite, onSave, onDelete }: {
  a: Automation; live: LiveResponse | null; devData: DevicesResponse | null;
  canWrite: boolean; onSave: (patch: Partial<Automation>) => Promise<void>; onDelete: () => void;
}) {
  const [enabled, setEnabled] = useState(a.enabled);
  const [p, setP] = useState<SolarSurplusPrecoolParams>(a.params as SolarSurplusPrecoolParams);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<SolarSurplusPrecoolParams>) => setP((prev) => ({ ...prev, ...patch }));

  const save = async () => { setBusy(true); try { await onSave({ enabled, params: p }); setEditing(false); } finally { setBusy(false); } };

  // Single-direction rule: COOLING (solar_surplus_precool) cools warm rooms, HEATING
  // (solar_surplus_preheat) heats cold rooms. Render every block for the rule's own
  // direction only. (Airzone underfloor is excluded from both.)
  const heating = a.type === 'solar_surplus_preheat';
  const triggerC = heating ? (p.heatRoomFloorC ?? 19) : p.roomTempLimitC;
  const targetC = heating ? (p.heatTargetSetpointC ?? 21) : p.targetSetpointC;
  const verb = heating ? 'heat' : 'cool';
  const tone = heating ? 'var(--grid)' : 'var(--battery)';
  const wash = heating ? 'var(--grid-wash)' : 'var(--battery-wash)';

  const surplus = live?.climateSurplusKw ?? 0;                 // real rule surplus (kW), may be negative
  const batteryDataOk = live?.batteryDataComplete ?? true;
  const startThresholdKw = (p.startThresholdW ?? 800) / 1000;
  const hasSurplus = batteryDataOk && surplus > startThresholdKw; // the rule would actually act
  const soc = batterySoc(live);
  // Rooms that QUALIFY for this direction right now: cooling wants rooms ABOVE the warm
  // limit, heating wants rooms BELOW the cold floor. Enrolment is per-direction
  // (solarCoolEnabled / solarHeatEnabled). Split into included (rule would act) vs
  // excluded (off-trigger but not enrolled) — the common "why is nothing happening?" case.
  // Both rules target the Intesis HVAC fleet (device type 'cooling'); Airzone underfloor
  // ('heating') is excluded from surplus. The heat rule runs those HVAC units in heat mode.
  const offTrigger = (devData?.devices ?? []).filter(
    (d) =>
      d.type === 'cooling' &&
      d.currentTempC != null &&
      (heating ? d.currentTempC < triggerC : d.currentTempC > triggerC),
  );
  const enrolled = (d: { solarCoolEnabled?: boolean; solarHeatEnabled?: boolean }) =>
    heating ? !!d.solarHeatEnabled : !!d.solarCoolEnabled;
  const qualifying = offTrigger.filter(enrolled);
  const excluded = offTrigger.filter((d) => !enrolled(d));
  const bandOn = p.bandRestrictionEnabled ?? true;

  return (
    <Card padded style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
      {/* header — the shared automation row (same control as on the Devices hub) */}
      <AutomationRow
        automation={{ ...a, enabled }}
        canWrite={canWrite}
        subtitle="Automation · climate"
        iconColor={tone}
        onSave={(patch) => {
          if (patch.enabled !== undefined) { setEnabled(patch.enabled); void onSave({ enabled: patch.enabled }); }
        }}
      />

      {/* WHEN / DO / UNTIL / LIMITS */}
      <Block label="When" color="var(--battery)" wash="var(--battery-wash)">
        <Tok>solar surplus</Tok><span style={{ color: 'var(--text-3)' }}>&gt;</span><Tok>battery intake headroom</Tok>
        <span style={{ color: 'var(--text-3)' }}>and</span><Tok>a room is {heating ? 'cold' : 'warm'}</Tok><span style={{ color: 'var(--text-3)' }}>{heating ? '<' : '>'}</span><Tok color="var(--grid)">{triggerC.toFixed(1)}°</Tok>
      </Block>
      <Block label="Do" color={tone} wash={wash}>
        run the <Tok>HVAC units</Tok> — <Tok color={tone}>{verb}</Tok> — to <Tok color={tone}>{targetC.toFixed(1)}°</Tok>, <Tok>staggered ≤ 14 kW</Tok>
      </Block>
      <Block label="Until" color="var(--home)" wash="var(--home-wash)">
        surplus clears <span style={{ color: 'var(--text-3)' }}>for</span> <Tok>{p.surplusClearSec}s</Tok> <span style={{ color: 'var(--text-3)' }}>·or·</span> room reaches target
        {bandOn && (<><span style={{ color: 'var(--text-3)' }}>·or·</span> band <Tok color="var(--grid)">{p.exitBand}</Tok></>)}
      </Block>
      <div style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-lg)', padding: '10px 14px' }}>
        <div className="pwr-eyebrow" style={{ marginBottom: 6 }}>Limits (always enforced)</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <Tok color="var(--text-2)">grid import ≤ 14 kW</Tok><Tok color="var(--text-2)">comfort ceiling</Tok><Tok color="var(--text-2)">min cycle 8 min</Tok>
        </div>
      </div>

      {/* LIVE PREVIEW */}
      <div style={{ background: 'var(--surface-2)', border: '1px solid rgba(46,230,160,0.2)', borderRadius: 'var(--radius-lg)', padding: '12px 14px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <span className="pwr-eyebrow" style={{ color: tone }}>Live preview · right now</span>
          <span className="pwr-mono" style={{ fontSize: 11, color: 'var(--text-2)' }}>surplus <span style={{ color: hasSurplus ? 'var(--solar)' : 'var(--text-3)' }}>{surplus > 0 ? '+' : ''}{surplus} kW</span>{soc != null ? ` · batteries ${soc}%` : ''}</span>
        </div>
        {!batteryDataOk ? (
          <div style={{ fontSize: 12.5, color: 'var(--text-2)' }}>Battery data offline — rule paused.</div>
        ) : hasSurplus && qualifying.length > 0 ? (
          <>
            <div style={{ fontSize: 12.5, marginBottom: 8 }}>{qualifying.length} room{qualifying.length > 1 ? 's' : ''} qualify — would {verb} to {targetC.toFixed(1)}°:</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {qualifying.slice(0, 6).map((d) => (
                <span key={d.id} className="pwr-mono" style={{ fontSize: 11.5, background: wash, color: tone, borderRadius: 8, padding: '5px 10px' }}>{d.name} · {d.currentTempC!.toFixed(1)}°→{targetC.toFixed(0)}°</span>
              ))}
            </div>
          </>
        ) : !hasSurplus ? (
          <div style={{ fontSize: 12.5, color: 'var(--text-2)' }}>
            No spare solar right now — rule is idle.{offTrigger.length > 0 ? ` (${offTrigger.length} room${offTrigger.length > 1 ? 's' : ''} ${heating ? 'below' : 'above'} ${triggerC.toFixed(1)}°, but no spare solar to ${verb}.)` : ''}
          </div>
        ) : excluded.length > 0 ? (
          <>
            <div style={{ fontSize: 12.5, marginBottom: 8, color: 'var(--text-2)' }}>
              {excluded.length} room{excluded.length > 1 ? 's are' : ' is'} {heating ? 'below' : 'above'} {triggerC.toFixed(1)}° but not included in automation — open the device and tap “Include in automation” to let the rule {verb} {excluded.length > 1 ? 'them' : 'it'}:
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {excluded.slice(0, 6).map((d) => (
                <span key={d.id} className="pwr-mono" style={{ fontSize: 11.5, background: 'var(--surface-3)', color: 'var(--grid)', borderRadius: 8, padding: '5px 10px' }}>{d.name} · {d.currentTempC!.toFixed(1)}° · excluded</span>
              ))}
            </div>
          </>
        ) : (
          <div style={{ fontSize: 12.5, color: 'var(--text-2)' }}>No rooms {heating ? 'below' : 'above'} the {heating ? 'floor' : 'limit'} right now — nothing to {verb}.</div>
        )}
      </div>

      {/* EDIT */}
      {canWrite && (
        <button type="button" onClick={() => setEditing((v) => !v)} style={{ alignSelf: 'flex-start', fontSize: 11.5, color: 'var(--text-2)', background: 'none', border: 'none', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <Icon name={editing ? 'chevron-up' : 'sliders-horizontal'} size={14} /> {editing ? 'Hide settings' : 'Edit rule'}
        </button>
      )}
      {editing && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 4, borderTop: '1px solid var(--border-1)' }}>
          {heating ? (
            <>
              <Slider label="Heat when room below" unit="°C" min={14} max={24} step={0.5} value={p.heatRoomFloorC ?? 19} onChange={(v) => set({ heatRoomFloorC: v })} />
              <Slider label="Heat to target" unit="°C" min={16} max={26} step={0.5} value={p.heatTargetSetpointC ?? 21} onChange={(v) => set({ heatTargetSetpointC: v })} />
            </>
          ) : (
            <>
              <Slider label="Cool when room above" unit="°C" min={20} max={30} step={0.5} value={p.roomTempLimitC} onChange={(v) => set({ roomTempLimitC: v })} />
              <Slider label="Cool to target" unit="°C" min={16} max={26} step={0.5} value={p.targetSetpointC} onChange={(v) => set({ targetSetpointC: v })} />
            </>
          )}
          <Slider label="Surplus must clear for" unit=" s" min={30} max={600} step={30} value={p.surplusClearSec} onChange={(v) => set({ surplusClearSec: v })} />
          <div>
            <div className="pwr-eyebrow" style={{ marginBottom: 6 }}>Price-band stand-down</div>
            <SegmentedControl
              size="sm"
              options={['Off', 'P1', 'P2', 'P3']}
              value={bandOn ? p.exitBand : 'Off'}
              onChange={(b) => (b === 'Off' ? set({ bandRestrictionEnabled: false }) : set({ bandRestrictionEnabled: true, exitBand: b as SolarSurplusPrecoolParams['exitBand'] }))}
            />
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 5 }}>{bandOn ? `Stands down (and won't start) while the tariff is in ${p.exitBand}.` : `Conditions in any tariff band, including P1 peak.`}</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button size="sm" variant="primary" loading={busy} onClick={() => void save()}>Save</Button>
            <Button size="sm" variant="ghost" onClick={onDelete}>Delete</Button>
          </div>
        </div>
      )}
    </Card>
  );
}

/* ============================================================================
 * Tariff arbitrage (task #15) — a battery rule. Shifts grid purchases from the P1
 * peak to the P3 valley: pre-charge from cheap valley grid when the forecast solar
 * won't carry the peak, discharge through P1, refill after. Solar-first (only the
 * shortfall) and live-self-correcting (if solar surges, the buy stands down and the
 * soak-export takes over). Seeded DISABLED — ACTS only when enabled AND the battery
 * Autopilot is armed in Auto. Mirrors the surplus rules' WHEN/DO/UNTIL/LIMITS layout.
 * ==========================================================================*/

// Spain 2.0TD rates (mirror apps/api/src/tariff.ts) for the live spread readout.
const TARIFF_RATES: Record<string, number> = { P1: 0.2093, P2: 0.1309, P3: 0.0957 };

function TariffArbitrageCard({ a, live, ctrlArmedAuto, canWrite, onSave, onDelete }: {
  a: Automation & { params: TariffArbitrageParams };
  live: LiveResponse | null; ctrlArmedAuto: boolean;
  canWrite: boolean; onSave: (patch: Partial<Automation>) => Promise<void>; onDelete: () => void;
}) {
  const [enabled, setEnabled] = useState(a.enabled);
  const [p, setP] = useState<TariffArbitrageParams>(a.params);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<TariffArbitrageParams>) => setP((prev) => ({ ...prev, ...patch }));

  const tone = 'var(--ev)';
  const wash = 'color-mix(in srgb, var(--ev) 12%, transparent)';
  const spread = (TARIFF_RATES[p.peakBand] ?? 0) - (TARIFF_RATES[p.valleyBand] ?? 0);
  const spreadOk = spread >= p.minSpreadEur;
  // SAFETY GATE — advisory (observe & log only) vs active (executes valley grid-charge).
  const mode = p.executionMode ?? 'advisory';
  const active = mode === 'active';
  // Persist the mode immediately on toggle (round-trips via the automation update path, which
  // clamps params with sanitizeArbitrageParams). Optimistic local update so the UI tracks it.
  const setMode = (next: 'advisory' | 'active') => {
    setP((prev) => ({ ...prev, executionMode: next }));
    void onSave({ params: { ...p, executionMode: next } });
  };

  const soc = batterySoc(live);
  // Grid-export surplus (kW) — what this battery rule reasons about (solar spilling to grid).
  const surplus = live && live.grid.dir === 'exporting' ? Math.round(live.grid.kw * 10) / 10 : 0;
  const exporting = surplus > 0;

  // Live preview — mirror the coordinator's gating (band isn't in /live, so we describe
  // the conditions rather than assert the exact band here).
  let preview = 'Connecting to live data…';
  if (live && soc != null) {
    if (!spreadOk) preview = `Spread €${spread.toFixed(4)} < €${p.minSpreadEur.toFixed(2)} — arbitrage stands down (not worthwhile).`;
    else if (exporting && p.surplusOverridesGridCharge) preview = `Exporting +${surplus} kW now — solar covers it; grid-charge defers to soak-export.`;
    else if (soc >= p.peakTargetSocPct) preview = `Batteries ${soc}% ≥ target ${p.peakTargetSocPct}% — no pre-buy needed; will discharge through the peak.`;
    else preview = `Batteries ${soc}% < target ${p.peakTargetSocPct}% — in a P3 valley it would pre-buy the forecast shortfall (≤ ${p.maxGridChargeKw} kW), then discharge through P1 to ${p.dischargeFloorPct}%.`;
  }

  const save = async () => { setBusy(true); try { await onSave({ enabled, params: p }); setEditing(false); } finally { setBusy(false); } };

  return (
    <Card padded style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Icon name="arrow-left-right" size={19} color={tone} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>{a.name}</div>
          <div style={{ fontSize: 11, color: 'var(--text-3)' }}>Automation · battery</div>
        </div>
        <Switch checked={enabled} disabled={!canWrite} onChange={(e) => { setEnabled(e.target.checked); void onSave({ enabled: e.target.checked }); }} />
      </div>

      {/* SAFETY GATE — Advisory ↔ Active. Advisory observes + logs only (no battery commands);
          Active executes the valley grid-charge (spends money). Make the distinction obvious. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', background: active ? 'var(--solar-wash)' : 'var(--surface-1)', border: `1px solid ${active ? 'var(--solar)' : 'var(--border-1)'}`, borderRadius: 'var(--radius-lg)', padding: '10px 13px' }}>
        <Icon name={active ? 'zap' : 'eye'} size={16} color={active ? 'var(--solar)' : 'var(--text-2)'} />
        <div style={{ flex: 1, minWidth: 140 }}>
          <div className="pwr-eyebrow" style={{ color: active ? 'var(--solar)' : 'var(--text-2)' }}>Execution mode</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-2)', marginTop: 2 }}>
            {active
              ? 'Active — executes valley grid-charge (spends money to pre-buy).'
              : 'Advisory — observe & log only, no battery commands.'}
          </div>
        </div>
        <SegmentedControl
          size="sm"
          options={[{ value: 'advisory', label: 'Advisory' }, { value: 'active', label: 'Active' }]}
          value={mode}
          onChange={(v) => canWrite && setMode(v as 'advisory' | 'active')}
        />
      </div>

      {/* WHEN / DO / UNTIL / LIMITS */}
      <Block label="When" color="var(--battery)" wash="var(--battery-wash)">
        <Tok color="var(--grid)">{p.valleyBand}</Tok><span style={{ color: 'var(--text-3)' }}>valley is cheap</span>
        <span style={{ color: 'var(--text-3)' }}>and</span><Tok>forecast solar won’t carry the next {p.peakBand} cycle — ≥{p.solarConfidencePct ?? 70}% certain</Tok>
      </Block>
      <Block label="Do" color={tone} wash={wash}>
        grid-charge to <Tok color={tone}>{p.peakTargetSocPct}%</Tok> before the peak <span style={{ color: 'var(--text-3)' }}>·then·</span> discharge through <Tok color="var(--grid)">{p.peakBand}</Tok> to <Tok color={tone}>{p.dischargeFloorPct}%</Tok>
      </Block>
      <Block label="Until" color="var(--home)" wash="var(--home-wash)">
        target reached <span style={{ color: 'var(--text-3)' }}>·or·</span> solar surges (export) <span style={{ color: 'var(--text-3)' }}>·or·</span> band leaves <Tok color="var(--grid)">{p.valleyBand}</Tok>
      </Block>
      <div style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-lg)', padding: '10px 14px' }}>
        <div className="pwr-eyebrow" style={{ marginBottom: 6 }}>Limits (always enforced)</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <Tok color="var(--text-2)">spread ≥ €{p.minSpreadEur.toFixed(2)}</Tok>
          <Tok color="var(--text-2)">≤ {p.maxGridChargeKw} kW grid-charge</Tok>
          <Tok color="var(--text-2)">never P1 / P2</Tok>
          <Tok color="var(--text-2)">solar-first</Tok>
          <Tok color="var(--text-2)">SoC floor + Tesla reserve</Tok>
          <Tok color="var(--text-2)">stand down if {p.peakBand} &lt;{p.prePeakSurplusGuardHours ?? 2}h away &amp; solar &gt;{100 + (p.prePeakSurplusMarginPct ?? 30)}% of load</Tok>
        </div>
      </div>

      {/* LIVE PREVIEW */}
      <div style={{ background: 'var(--surface-2)', border: `1px solid ${spreadOk ? tone : 'var(--border-1)'}`, borderRadius: 'var(--radius-lg)', padding: '12px 14px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <span className="pwr-eyebrow" style={{ color: spreadOk ? tone : 'var(--text-3)' }}>Live preview · right now</span>
          <span className="pwr-mono" style={{ fontSize: 11, color: 'var(--text-2)' }}>
            spread €{spread.toFixed(3)}{soc != null ? ` · batteries ${soc}%` : ''}{exporting ? ` · +${surplus} kW` : ''}
          </span>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--text-2)' }}>{preview}</div>
        {!ctrlArmedAuto && (
          <div style={{ fontSize: 11, color: 'var(--grid)', marginTop: 6 }}>
            Acts only when <Link to="/automations?tab=settings" style={{ color: 'var(--battery)' }}>Autopilot</Link> is armed in Auto.
          </div>
        )}
      </div>

      {/* EDIT */}
      {canWrite && (
        <button type="button" onClick={() => setEditing((v) => !v)} style={{ alignSelf: 'flex-start', fontSize: 11.5, color: 'var(--text-2)', background: 'none', border: 'none', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <Icon name={editing ? 'chevron-up' : 'sliders-horizontal'} size={14} /> {editing ? 'Hide settings' : 'Edit rule'}
        </button>
      )}
      {editing && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 4, borderTop: '1px solid var(--border-1)' }}>
          <Slider label="Pre-peak SoC target" unit=" %" min={40} max={100} step={5} value={p.peakTargetSocPct} onChange={(v) => set({ peakTargetSocPct: v })} />
          <Slider label="Discharge floor through peak" unit=" %" min={10} max={60} step={5} value={p.dischargeFloorPct} onChange={(v) => set({ dischargeFloorPct: v })} />
          <Slider label="Max grid-charge rate" unit=" kW" min={1} max={4.6} step={0.1} value={p.maxGridChargeKw} onChange={(v) => set({ maxGridChargeKw: v })} />
          <Slider label="Min worthwhile spread" unit=" €/kWh" min={0} max={0.2} step={0.01} value={p.minSpreadEur} onChange={(v) => set({ minSpreadEur: v })} />
          <Slider label="Solar-shortfall certainty to pre-buy" unit=" %" min={50} max={95} step={5} value={p.solarConfidencePct ?? 70} onChange={(v) => set({ solarConfidencePct: v })} />
          <Slider label="Pre-peak surplus guard window" unit=" h" min={0} max={6} step={1} value={p.prePeakSurplusGuardHours ?? 2} onChange={(v) => set({ prePeakSurplusGuardHours: v })} />
          <Slider label="Pre-peak surplus margin (solar over load)" unit=" %" min={0} max={200} step={10} value={p.prePeakSurplusMarginPct ?? 30} onChange={(v) => set({ prePeakSurplusMarginPct: v })} />
          <Slider label="Re-plan when forecast diverges by" unit=" %" min={1} max={100} step={5} value={p.deviationThresholdPct ?? 30} onChange={(v) => set({ deviationThresholdPct: v })} />
          <Slider label="Deviation floor (ignore tiny gaps)" unit=" kW" min={0} max={5} step={0.1} value={p.deviationMinKw ?? 0.8} onChange={(v) => set({ deviationMinKw: v })} />
          <div style={{ display: 'flex', gap: 8 }}>
            <Button size="sm" variant="primary" loading={busy} onClick={() => void save()}>Save</Button>
            <Button size="sm" variant="ghost" onClick={onDelete}>Delete</Button>
          </div>
        </div>
      )}
    </Card>
  );
}

/* ----------------------------------------------------------------------------
 * Tariff-arbitrage effectiveness — cumulative MODELLED savings + valley kWh shifted +
 * engagement count (advisory vs active tracked apart), a "since" date, and a short recent-
 * events list. Mirrors the BatteryRuleCard / Surplus-soak card styling. Renders on desktop
 * (>=768px) and mobile (<768px). The savings are a MODELLED estimate (kWh assumed to displace
 * a peak import) — labelled as such.
 * --------------------------------------------------------------------------*/
const ARB_TYPE_META: Record<ArbitrageEventType, { label: string; color: string }> = {
  plan: { label: 'plan', color: 'var(--text-2)' },
  engage: { label: 'engage', color: 'var(--solar)' },
  revert: { label: 'revert', color: 'var(--grid)' },
  standdown: { label: 'stand-down', color: 'var(--text-3)' },
  deviation: { label: 'deviation', color: 'var(--ev)' },
};

function fmtEur(v: number): string {
  return `€${v.toFixed(2)}`;
}
function fmtSince(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
function fmtClock(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function ArbitrageEffectivenessCard({ stats, events }: { stats?: ArbitrageStats; events?: ArbitrageEvent[] }) {
  const tone = 'var(--ev)';
  const [showTicks, setShowTicks] = useState(false);
  const all = events ?? [];
  // A `plan` event is a re-plan tick — nothing engaged, nothing changed. These dominate the log
  // (especially in Advisory) and are non-events, so hide them by default; the meaningful events
  // are engage/revert/stand-down/deviation. A toggle reveals the plan ticks when wanted.
  const meaningful = all.filter((e) => e.type !== 'plan');
  const planCount = all.length - meaningful.length;
  const recent = (showTicks ? all : meaningful).slice(-8).reverse();
  const hasData = !!stats && (stats.engagementsActive + stats.engagementsAdvisory > 0 || all.length > 0);

  const Stat = ({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) => (
    <div style={{ flex: 1, minWidth: 110, background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', padding: '10px 12px' }}>
      <div className="pwr-eyebrow" style={{ marginBottom: 4 }}>{label}</div>
      <div className="pwr-mono" style={{ fontSize: 18, fontWeight: 600, color }}>{value}</div>
      <div style={{ fontSize: 10.5, color: 'var(--text-3)', marginTop: 2 }}>{sub}</div>
    </div>
  );

  return (
    <Card padded style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Icon name="line-chart" size={19} color={tone} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>Arbitrage effectiveness</div>
          <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
            Modelled savings{stats ? ` · since ${fmtSince(stats.sinceTs)}` : ''}
          </div>
        </div>
      </div>

      {!hasData ? (
        <div style={{ fontSize: 12.5, color: 'var(--text-2)' }}>
          No arbitrage activity logged yet. While the rule is enabled and Autopilot is armed in Auto, every tick is recorded here — Advisory logs what it <em>would</em> do; Active logs what it did.
        </div>
      ) : (
        <>
          {/* Advisory (modelled) vs Active (realized) headline stats */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Stat label="Advisory €" value={fmtEur(stats!.estSavedEurAdvisory)} sub={`modelled · ${stats!.engagementsAdvisory} engage${stats!.engagementsAdvisory === 1 ? '' : 's'}`} color="var(--text-1)" />
            <Stat label="Active €" value={fmtEur(stats!.estSavedEurActive)} sub={`realized · ${stats!.engagementsActive} engage${stats!.engagementsActive === 1 ? '' : 's'}`} color={tone} />
            <Stat label="Valley kWh" value={(stats!.valleyKwhAdvisory + stats!.valleyKwhActive).toFixed(1)} sub={`${stats!.valleyKwhActive.toFixed(1)} active · ${stats!.valleyKwhAdvisory.toFixed(1)} advisory`} color="var(--text-1)" />
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--text-3)' }}>
            Savings are a MODELLED estimate — each shifted kWh is assumed to displace a peak (P1) import at the live P1−P3 spread.
          </div>

          {/* Recent events — plan ticks hidden by default (toggle to reveal) */}
          {(recent.length > 0 || planCount > 0) && (
            <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-lg)', padding: '10px 12px' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
                <div className="pwr-eyebrow">Recent events</div>
                {planCount > 0 && (
                  <button onClick={() => setShowTicks((v) => !v)} style={{ marginLeft: 'auto', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-3)', textDecoration: 'underline', fontSize: 11 }}>
                    {showTicks ? 'hide' : 'show'} {planCount} plan tick{planCount === 1 ? '' : 's'}
                  </button>
                )}
              </div>
              {recent.length === 0 ? (
                <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
                  No engagements yet — only plan ticks so far. {showTicks ? '' : 'Tap “show” above to see them.'}
                </div>
              ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {recent.map((e, i) => {
                  const m = ARB_TYPE_META[e.type] ?? ARB_TYPE_META.plan;
                  return (
                    <div key={`${e.ts}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 11.5 }}>
                      <span className="pwr-mono" style={{ color: 'var(--text-3)', minWidth: 92 }}>{fmtClock(e.ts)}</span>
                      <span className="pwr-mono" style={{ color: m.color, fontWeight: 600, minWidth: 70 }}>{m.label}</span>
                      <span className="pwr-mono" style={{ fontSize: 10.5, color: e.executionMode === 'active' ? 'var(--solar)' : 'var(--text-3)' }}>{e.executionMode}</span>
                      <span className="pwr-mono" style={{ color: 'var(--text-2)' }}>{e.band}</span>
                      {e.live.combinedSoc != null && <span className="pwr-mono" style={{ color: 'var(--text-2)' }}>SoC {Math.round(e.live.combinedSoc)}%</span>}
                      {e.chargedKwhTick > 0 && <span className="pwr-mono" style={{ color: 'var(--text-2)' }}>{e.chargedKwhTick.toFixed(2)} kWh</span>}
                      {e.estSavedEurTick > 0 && <span className="pwr-mono" style={{ color: tone }}>{fmtEur(e.estSavedEurTick)}</span>}
                      {e.type === 'deviation' && e.deviation && (
                        <span className="pwr-mono" style={{ fontSize: 10.5, color: 'var(--ev)' }}>
                          {e.deviation.input}: {e.deviation.input.includes('solar') ? `solar ${e.deviation.solarLiveKw.toFixed(1)}≠${e.deviation.solarForecastKw.toFixed(1)}` : `load ${e.deviation.loadLiveKw.toFixed(1)}≠${e.deviation.loadForecastKw.toFixed(1)}`} kW
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
              )}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

/* ============================================================================
 * Battery-priority rules — Sonnen-first discharge / Tesla-first charge. These are
 * battery-control policies (persisted in control state), so they ACT only when the
 * battery Autopilot is armed in Auto (on the Autopilot screen), independent of the
 * climate arm above. Each rule has its own enable + Shadow/Auto authority + a
 * throughput cap beyond which the OTHER battery is allowed to join in.
 * ==========================================================================*/

interface BatRuleMeta {
  key: BatteryPriorityKey;
  kind: 'discharge' | 'charge';
  title: string;
  icon: string;
  tone: string;
  wash: string;
}
const BAT_RULES: BatRuleMeta[] = [
  { key: 'dischargeSonnenFirst', kind: 'discharge', title: 'Discharge — Sonnen first', icon: 'battery-low', tone: 'var(--battery)', wash: 'var(--battery-wash)' },
  { key: 'chargeTeslaFirst', kind: 'charge', title: 'Charge — Tesla first', icon: 'battery-charging', tone: 'var(--solar)', wash: 'var(--solar-wash)' },
];

function BatteryRuleCard({ meta, rule, live, socFloorPct, canWrite, onSave }: {
  meta: BatRuleMeta; rule: BatteryPriorityRule; live: LiveResponse | null;
  socFloorPct: number; canWrite: boolean; onSave: (patch: Partial<BatteryPriorityRule>) => void;
}) {
  const [enabled, setEnabled] = useState(rule.enabled);
  const [authority, setAuthority] = useState(rule.authority);
  const [thr, setThr] = useState(rule.throughputKw);
  const [editing, setEditing] = useState(false);

  const setAuthAndSave = (next: 'shadow' | 'auto') => { setAuthority(next); onSave({ authority: next }); };
  const toggleEnabled = (on: boolean) => { setEnabled(on); onSave({ enabled: on }); };
  const saveThr = () => { onSave({ throughputKw: thr }); setEditing(false); };

  const sonnenSoc = live ? Math.round(live.sonnen.soc) : null;
  const teslaSoc = live ? Math.round(live.tesla.soc) : null;
  const importKw = live && live.grid.dir === 'importing' ? Math.round(live.grid.kw * 10) / 10 : 0;
  const exportKw = live && live.grid.dir === 'exporting' ? Math.round(live.grid.kw * 10) / 10 : 0;

  // Live preview — mirror the coordinator's decision so the UI shows what WOULD happen.
  let preview = 'Connecting to live data…';
  let active = false;
  if (live && sonnenSoc != null && teslaSoc != null) {
    if (meta.kind === 'discharge') {
      if (exportKw > 0.2) preview = `Solar surplus now (+${exportKw} kW) — discharge priority idle.`;
      else if (sonnenSoc <= socFloorPct) preview = `Sonnen ${sonnenSoc}% at floor — Tesla released to share the load.`;
      else if (importKw > thr) preview = `Grid import ${importKw} kW > ${thr} kW — Tesla joins in.`;
      else { active = true; preview = `Sonnen covers the house first; Tesla held in backup so it stays charged (${teslaSoc}%).`; }
    } else {
      if (exportKw <= 0.2) preview = 'No solar surplus now — charge priority idle.';
      else if (teslaSoc >= 100) preview = 'Tesla full — Sonnen free to charge.';
      else if (exportKw > thr) preview = `Surplus ${exportKw} kW > ${thr} kW — Sonnen joins in.`;
      else { active = true; preview = `Would idle Sonnen — Tesla charges first (${teslaSoc}%).`; }
    }
  }

  const whenDo = meta.kind === 'discharge'
    ? { when: <><Tok>house drawing</Tok><span style={{ color: 'var(--text-3)' }}>and</span><Tok>Sonnen &gt; floor</Tok></>,
        doIt: <>discharge <Tok color="var(--battery)">Sonnen</Tok> first · keep <Tok color="var(--ev)">Tesla</Tok> full for backup</>,
        until: <>grid import <span style={{ color: 'var(--text-3)' }}>&gt;</span> <Tok>{thr} kW</Tok> <span style={{ color: 'var(--text-3)' }}>·or·</span> Sonnen hits floor <span style={{ color: 'var(--text-3)' }}>→</span> Tesla joins</> }
    : { when: <><Tok>solar surplus</Tok><span style={{ color: 'var(--text-3)' }}>and</span><Tok>Tesla not full</Tok></>,
        doIt: <>charge <Tok color="var(--ev)">Tesla</Tok> first · restore backup capacity</>,
        until: <>surplus <span style={{ color: 'var(--text-3)' }}>&gt;</span> <Tok>{thr} kW</Tok> <span style={{ color: 'var(--text-3)' }}>·or·</span> Tesla full <span style={{ color: 'var(--text-3)' }}>→</span> Sonnen joins</> };

  return (
    <Card padded style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Icon name={meta.icon} size={19} color={meta.tone} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>{meta.title}</div>
          <div style={{ fontSize: 11, color: 'var(--text-3)' }}>Automation · battery</div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button type="button" disabled={!canWrite} onClick={() => setAuthAndSave('shadow')} style={{ fontSize: 11, padding: '5px 11px', borderRadius: 8, cursor: canWrite ? 'pointer' : 'default', border: '1px solid var(--border-1)', background: authority === 'shadow' ? 'var(--surface-3)' : 'transparent', color: authority === 'shadow' ? 'var(--text-1)' : 'var(--text-3)', fontWeight: 600 }}>Shadow</button>
          <button type="button" disabled={!canWrite} onClick={() => setAuthAndSave('auto')} style={{ fontSize: 11, padding: '5px 11px', borderRadius: 8, cursor: canWrite ? 'pointer' : 'default', border: 'none', background: authority === 'auto' ? 'var(--solar)' : 'var(--surface-3)', color: authority === 'auto' ? '#06090b' : 'var(--text-3)', fontWeight: 600 }}>Auto</button>
          <Switch checked={enabled} disabled={!canWrite} onChange={(e) => toggleEnabled(e.target.checked)} />
        </div>
      </div>

      {/* WHEN / DO / UNTIL */}
      <Block label="When" color="var(--battery)" wash="var(--battery-wash)">{whenDo.when}</Block>
      <Block label="Do" color={meta.tone} wash={meta.wash}>{whenDo.doIt}</Block>
      <Block label="Until" color="var(--home)" wash="var(--home-wash)">{whenDo.until}</Block>

      {/* LIVE PREVIEW */}
      <div style={{ background: 'var(--surface-2)', border: `1px solid ${active ? meta.tone : 'var(--border-1)'}`, borderRadius: 'var(--radius-lg)', padding: '12px 14px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <span className="pwr-eyebrow" style={{ color: active ? meta.tone : 'var(--text-3)' }}>Live preview · right now</span>
          <span className="pwr-mono" style={{ fontSize: 11, color: 'var(--text-2)' }}>
            {meta.kind === 'discharge' ? (importKw > 0 ? `import ${importKw} kW` : 'no import') : (exportKw > 0 ? `+${exportKw} kW` : 'no surplus')}
            {sonnenSoc != null ? ` · S ${sonnenSoc}%` : ''}{teslaSoc != null ? ` · T ${teslaSoc}%` : ''}
          </span>
        </div>
        <div style={{ fontSize: 12.5, color: active ? 'var(--text-1)' : 'var(--text-2)' }}>{preview}</div>
      </div>

      {/* EDIT */}
      {canWrite && (
        <button type="button" onClick={() => setEditing((v) => !v)} style={{ alignSelf: 'flex-start', fontSize: 11.5, color: 'var(--text-2)', background: 'none', border: 'none', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <Icon name={editing ? 'chevron-up' : 'sliders-horizontal'} size={14} /> {editing ? 'Hide settings' : 'Edit rule'}
        </button>
      )}
      {editing && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 4, borderTop: '1px solid var(--border-1)' }}>
          <Slider label={meta.kind === 'discharge' ? 'Sonnen-only until grid import exceeds' : 'Tesla-only until surplus exceeds'} unit=" kW" min={0} max={14} step={0.5} value={thr} onChange={(v) => setThr(v)} />
          <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
            {meta.kind === 'discharge'
              ? `The Sonnen carries the house alone; once grid import climbs past ${thr} kW (it can't keep up) the Tesla joins to discharge.`
              : `The Tesla absorbs the surplus alone; once surplus exceeds ${thr} kW (it can't keep up) the Sonnen joins to charge.`}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button size="sm" variant="primary" disabled={thr === rule.throughputKw} onClick={saveThr}>Save</Button>
            <Button size="sm" variant="ghost" onClick={() => { setThr(rule.throughputKw); setEditing(false); }}>Cancel</Button>
          </div>
        </div>
      )}
    </Card>
  );
}

/* ----------------------------------------------------------------------------
 * Surplus soak — the force-charge-to-soak-export rule, surfaced + made tunable.
 * No Shadow/Auto authority (it acts only in armed+auto, like the priority rules);
 * just an enable toggle + the hysteresis thresholds. Mirrors BatteryRuleCard.
 * --------------------------------------------------------------------------*/
function SoakRuleCard({ rule, live, canWrite, onSave }: {
  rule: SoakExportRule; live: LiveResponse | null;
  canWrite: boolean; onSave: (patch: Partial<SoakExportRule>) => void;
}) {
  const [enabled, setEnabled] = useState(rule.enabled);
  const [startW, setStartW] = useState(rule.startW);
  const [stopW, setStopW] = useState(rule.stopW);
  const [ceil, setCeil] = useState(rule.socCeilingPct);
  const [editing, setEditing] = useState(false);

  const toggleEnabled = (on: boolean) => { setEnabled(on); onSave({ enabled: on }); };
  const dirty = startW !== rule.startW || stopW !== rule.stopW || ceil !== rule.socCeilingPct;
  const invalid = stopW >= startW; // hysteresis: stop must sit below start
  const save = () => { onSave({ startW, stopW, socCeilingPct: ceil }); setEditing(false); };
  const cancel = () => { setStartW(rule.startW); setStopW(rule.stopW); setCeil(rule.socCeilingPct); setEditing(false); };

  const tone = 'var(--solar)';
  const wash = 'var(--solar-wash)';
  const sonnenSoc = live ? Math.round(live.sonnen.soc) : null;
  const exportKw = live && live.grid.dir === 'exporting' ? Math.round(live.grid.kw * 10) / 10 : 0;
  const exportW = Math.round(exportKw * 1000);
  const soaking = live?.sonnen.mode === 'manual' && live?.sonnen.dir === 'charging';

  // Live preview — mirror the coordinator's decision so the UI shows what WOULD happen.
  let preview = 'Connecting to live data…';
  let active = false;
  if (live && sonnenSoc != null) {
    if (!enabled) preview = 'Rule off — surplus follows charge-priority / self-consumption.';
    else if (sonnenSoc >= ceil) preview = `Battery full — held at SoC ${sonnenSoc}% ≥ ${ceil}% ceiling.`;
    else if (soaking) { active = true; preview = `Soaking ~${Math.min(exportW, 4600)} W — absorbing surplus before it spills to grid.`; }
    else if (exportW > startW) { active = true; preview = `Surplus +${exportKw} kW > ${startW} W — would force-charge to soak it.`; }
    else if (exportW > stopW) preview = `Surplus +${exportKw} kW in the deadband — holding current state.`;
    else preview = exportKw > 0 ? `Only +${exportKw} kW surplus — below the ${startW} W start.` : 'No surplus to soak — self-consumption.';
  }

  return (
    <Card padded style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Icon name="battery-charging" size={19} color={tone} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>Surplus soak — Sonnen absorbs export</div>
          <div style={{ fontSize: 11, color: 'var(--text-3)' }}>Automation · battery</div>
        </div>
        <Switch checked={enabled} disabled={!canWrite} onChange={(e) => toggleEnabled(e.target.checked)} />
      </div>

      {/* WHEN / DO / UNTIL */}
      <Block label="When" color="var(--battery)" wash="var(--battery-wash)">
        <Tok>grid exporting</Tok><span style={{ color: 'var(--text-3)' }}>and</span><Tok>SoC &lt; {ceil}%</Tok>
      </Block>
      <Block label="Do" color={tone} wash={wash}>
        force-charge <Tok color="var(--battery)">Sonnen</Tok> at the would-be-export · soak surplus before it spills to <Tok color="var(--grid)">grid</Tok>
      </Block>
      <Block label="Until" color="var(--home)" wash="var(--home-wash)">
        export <span style={{ color: 'var(--text-3)' }}>&lt;</span> <Tok>{stopW} W</Tok> <span style={{ color: 'var(--text-3)' }}>·or·</span> SoC <span style={{ color: 'var(--text-3)' }}>≥</span> <Tok>{ceil}%</Tok> <span style={{ color: 'var(--text-3)' }}>→</span> self-consumption
      </Block>

      {/* LIVE PREVIEW */}
      <div style={{ background: 'var(--surface-2)', border: `1px solid ${active ? tone : 'var(--border-1)'}`, borderRadius: 'var(--radius-lg)', padding: '12px 14px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <span className="pwr-eyebrow" style={{ color: active ? tone : 'var(--text-3)' }}>Live preview · right now</span>
          <span className="pwr-mono" style={{ fontSize: 11, color: 'var(--text-2)' }}>
            {exportKw > 0 ? `+${exportKw} kW` : 'no surplus'}{sonnenSoc != null ? ` · S ${sonnenSoc}%` : ''}
          </span>
        </div>
        <div style={{ fontSize: 12.5, color: active ? 'var(--text-1)' : 'var(--text-2)' }}>{preview}</div>
      </div>

      {/* EDIT */}
      {canWrite && (
        <button type="button" onClick={() => setEditing((v) => !v)} style={{ alignSelf: 'flex-start', fontSize: 11.5, color: 'var(--text-2)', background: 'none', border: 'none', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <Icon name={editing ? 'chevron-up' : 'sliders-horizontal'} size={14} /> {editing ? 'Hide settings' : 'Edit rule'}
        </button>
      )}
      {editing && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 4, borderTop: '1px solid var(--border-1)' }}>
          <Slider label="Engage when export exceeds" unit=" W" min={0} max={2000} step={50} value={startW} onChange={(v) => setStartW(v)} />
          <Slider label="Revert when export drops below" unit=" W" min={0} max={2000} step={50} value={stopW} onChange={(v) => setStopW(v)} />
          <Slider label="Don't charge above SoC" unit=" %" min={50} max={100} step={1} value={ceil} onChange={(v) => setCeil(v)} />
          <div style={{ fontSize: 11, color: invalid ? 'var(--danger)' : 'var(--text-3)' }}>
            {invalid
              ? `Revert (${stopW} W) must sit below engage (${startW} W) — that gap is the hysteresis deadband that stops flapping.`
              : `Engages once export clears ${startW} W; keeps soaking until it falls under ${stopW} W. Never charges a battery at/above ${ceil}%.`}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button size="sm" variant="primary" disabled={!dirty || invalid} onClick={save}>Save</Button>
            <Button size="sm" variant="ghost" onClick={cancel}>Cancel</Button>
          </div>
        </div>
      )}
    </Card>
  );
}

// Merged screen: Autopilot's tabs (Summary · Events · Status · Settings) + the two
// Automations tabs (Schedules · Smart Rules), in the approved strip order below.
type AutoTab = 'summary' | 'schedules' | 'rules' | 'events' | 'status' | 'settings';
const AUTO_TABS: readonly AutoTab[] = ['summary', 'schedules', 'rules', 'events', 'status', 'settings'];
// Tabs hosted by the embedded Autopilot — their keys line up 1:1 with its TabKey.
const AUTOPILOT_TABS: readonly AutoTab[] = ['summary', 'events', 'status', 'settings'];

export function Automations({ ctx }: { ctx: ShellContext }) {
  const { user } = useAuth();
  const canWrite = user?.role === 'admin';
  const wide = ctx.desktop;
  const [params, setParams] = useSearchParams();
  // Selected tab persists in the URL (?tab=…) so deep-links and the
  // /schedules → ?tab=schedules and /brain → /automations redirects all land.
  const paramTab = params.get('tab');
  const tab: AutoTab = (AUTO_TABS as readonly string[]).includes(paramTab ?? '') ? (paramTab as AutoTab) : 'summary';
  const setTab = (next: AutoTab) => {
    setParams((prev) => {
      const p = new URLSearchParams(prev);
      if (next === 'summary') p.delete('tab');
      else p.set('tab', next);
      return p;
    }, { replace: true });
  };
  const { data, stale, updatedAt, refetch } = usePolling<AutomationsResponse>(api.automations.list, 0);
  const { data: status, refetch: refetchStatus } = usePolling<DevicesStatus>(api.devices.status, 20_000);
  const { data: devData } = usePolling<DevicesResponse>(api.devices.list, 20_000);
  const { data: live } = usePolling<LiveResponse>(api.live, 20_000);
  const { data: ctrl, refetch: refetchCtrl } = usePolling<ControlStatus>(api.control.status, 20_000);
  const [busy, setBusy] = useState(false);

  const automations = data?.automations ?? [];
  const arbAutomations = automations.filter(isTariffArbitrage);
  const climateAutomations = automations.filter((a) => !isTariffArbitrage(a));
  const bp = ctrl?.batteryPriority ?? null;
  const socFloorPct = ctrl?.guardrails.socFloorPct ?? 10;
  const batteryArmedAuto = !!ctrl?.armed && ctrl.mode === 'auto';

  const onArm = async (armed: boolean, mode: 'auto' | 'manual') => {
    setBusy(true);
    try { await api.devices.arm(armed, mode); } catch { /* ignore */ } finally { setBusy(false); refetchStatus(); }
  };
  const saveAuto = async (id: string, patch: Partial<Automation>) => { await api.automations.update(id, patch); refetch(); };
  const addAuto = async () => { await api.automations.create({ name: 'Solar-surplus climate', type: 'solar_surplus_precool' }); refetch(); };
  const removeAuto = async (id: string) => { await api.automations.remove(id); refetch(); };
  const saveBatteryRule = async (key: BatteryPriorityKey, patch: Partial<BatteryPriorityRule>) => {
    try { await api.control.batteryPriority(key, patch); } catch { /* ignore */ } finally { refetchCtrl(); }
  };
  const saveSoak = async (patch: Partial<SoakExportRule>) => {
    try { await api.control.soakExport(patch); } catch { /* ignore */ } finally { refetchCtrl(); }
  };

  const list = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {stale && <StaleBanner updatedAt={updatedAt} />}

      {/* ---- Battery priority ---- */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginTop: 2 }}>
        <Eyebrow>Battery</Eyebrow>
        <span style={{ fontSize: 11, color: batteryArmedAuto ? 'var(--solar)' : 'var(--text-3)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <Icon name={batteryArmedAuto ? 'shield-check' : 'shield-off'} size={13} />
          {batteryArmedAuto ? 'Autopilot armed · Auto' : 'Acts when Autopilot is in Auto'}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, background: 'var(--battery-wash)', border: '1px solid rgba(64,160,255,0.18)', borderRadius: 'var(--radius-md)', padding: '9px 13px' }}>
        <Icon name="info" size={15} color="var(--battery)" />
        <span style={{ fontSize: 11.5, color: 'var(--text-2)' }}>
          The Tesla is kept full for backup (the Sonnen has no backup mode). These rules run in the battery coordinator — <strong style={{ color: 'var(--text-1)' }}>Shadow</strong> only logs intended actions; flip to <strong style={{ color: 'var(--text-1)' }}>Auto</strong> and arm <Link to="/automations?tab=settings" style={{ color: 'var(--battery)' }}>Autopilot</Link> (Auto) to let them act.
        </span>
      </div>
      {bp
        ? BAT_RULES.map((m) => (
            <BatteryRuleCard key={m.key} meta={m} rule={bp[m.key]} live={live ?? null} socFloorPct={socFloorPct} canWrite={!!canWrite} onSave={(patch) => void saveBatteryRule(m.key, patch)} />
          ))
        : <Card padded style={{ color: 'var(--text-3)', fontSize: 12.5 }}>Connecting to the battery control plane…</Card>}
      {ctrl?.soakExport && (
        <SoakRuleCard rule={ctrl.soakExport} live={live ?? null} canWrite={!!canWrite} onSave={(patch) => void saveSoak(patch)} />
      )}
      {arbAutomations.map((a) => (
        <TariffArbitrageCard key={a.id} a={a} live={live ?? null} ctrlArmedAuto={batteryArmedAuto} canWrite={!!canWrite} onSave={(patch) => saveAuto(a.id, patch)} onDelete={() => void removeAuto(a.id)} />
      ))}
      {arbAutomations.length > 0 && (
        <ArbitrageEffectivenessCard stats={ctrl?.arbitrageStats} events={ctrl?.arbitrageLog} />
      )}

      {/* ---- Climate ---- */}
      <Eyebrow>Climate</Eyebrow>
      <ArmCard status={status ?? null} canWrite={!!canWrite} onArm={(a, m) => void onArm(a, m)} busy={busy} />
      {devData && !devData.connected && (
        <Card padded style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
          <span style={{ width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'var(--grid-wash)', color: 'var(--grid)', flex: 'none' }}><Icon name="cloud-off" size={16} /></span>
          <div style={{ fontSize: 12.5, color: 'var(--text-2)' }}>AC Cloud is not connected — automations have nothing to act on until you connect it in Settings.</div>
        </Card>
      )}
      {climateAutomations.map((a) => (
        <RuleCard key={a.id} a={a} live={live ?? null} devData={devData ?? null} canWrite={!!canWrite} onSave={(patch) => saveAuto(a.id, patch)} onDelete={() => void removeAuto(a.id)} />
      ))}
      {canWrite && <Button variant="secondary" iconLeft={<Icon name="plus" size={16} />} onClick={() => void addAuto()}>New automation</Button>}
    </div>
  );

  // Six-tab switcher in the approved order: Summary · Schedules · Smart Rules ·
  // Events · Status · Settings. Selection is persisted in the URL (?tab=…).
  // Six segments are too many to sit comfortably in one block row at ~360px, so on
  // mobile we split into two stacked rows of three; desktop keeps the single block.
  const tabOptions: { value: AutoTab; label: string }[] = [
    { value: 'summary', label: 'Summary' },
    { value: 'schedules', label: 'Schedules' },
    { value: 'rules', label: 'Smart Rules' },
    { value: 'events', label: 'Events' },
    { value: 'status', label: 'Status' },
    { value: 'settings', label: 'Settings' },
  ];
  const tabBar = wide ? (
    <SegmentedControl block options={tabOptions} value={tab} onChange={(v) => setTab(v as AutoTab)} />
  ) : (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <SegmentedControl block options={tabOptions.slice(0, 3)} value={tab} onChange={(v) => setTab(v as AutoTab)} />
      <SegmentedControl block options={tabOptions.slice(3)} value={tab} onChange={(v) => setTab(v as AutoTab)} />
    </div>
  );

  // Full-width like every other page — the tab strip, graphs, and every panel use the
  // whole content area. The embedded Autopilot fills the host (its own 1100 wrapper is
  // dropped when embedded), and Schedules / Smart Rules fill it too.
  const panel = AUTOPILOT_TABS.includes(tab) ? (
    <Autopilot ctx={ctx} embedded tab={tab as AutopilotTabKey} />
  ) : tab === 'schedules' ? (
    <SchedulesPanel ctx={ctx} />
  ) : (
    list
  );

  const body = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {tabBar}
      {panel}
    </div>
  );

  // Desktop: full-width like every other page; the page title comes from the AppShell
  // TopBar (META['/automations']) rather than an in-body heading.
  if (wide) return body;
  return (<><MobileHeader eyebrow="Power" title="Automations" right={<Avatar />} /><div style={{ padding: '8px 14px 22px' }}>{body}</div></>);
}
