import { useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Icon, Button, Modal, Input } from '../ui';
import type { Action, Capability, ClimateMode, FanSetting, RunCondition, Schedule, ScheduleWindow, VaneSetting } from '../../lib/types';
import { checkRuleOverlap, expandSegments, selfOverlaps, wouldOverlapUnit, TYPE_LABEL } from '../../lib/scheduleRules';
import { AnchorPicker, OffsetStepper } from './TimeAnchorControls';

/* ============================================================================
 * EditRuleOverlay — single source of truth for creating/editing a rule. Opens
 * from "+ Add rule", a rule's edit icon, or the inline name affordance, on both
 * the device-detail box and the Schedules page. Desktop = centered modal;
 * mobile = bottom sheet. Blocks Save on overlapping windows; the server
 * re-validates. "Copy to units" duplicates the rule into other same-type units
 * (targets where it would overlap are disabled).
 * ==========================================================================*/

const MODES: { value: ClimateMode; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'cool', label: 'Cool' },
  { value: 'heat', label: 'Heat' },
  { value: 'dry', label: 'Dry' },
  { value: 'fan', label: 'Fan' },
];
// Underfloor (Airzone) heating supports cool / heat / auto only — no dry/fan.
const HEATING_MODES: { value: ClimateMode; label: string }[] = [
  { value: 'cool', label: 'Cool' },
  { value: 'heat', label: 'Heat' },
  { value: 'auto', label: 'Auto' },
];
const DAY_ABBR = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const ROW_TO_STORE = [1, 2, 3, 4, 5, 6, 0];

const label: CSSProperties = { fontSize: 10.5, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-3)' };

export interface RulePeer {
  id: string;
  name: string;
}

export function EditRuleOverlay({
  rule,
  unitName,
  wide,
  peers,
  allRules,
  capabilities,
  canDelete,
  onCancel,
  onSave,
  onDelete,
}: {
  rule: Schedule;
  unitName: string;
  wide: boolean;
  peers: RulePeer[];
  allRules: Schedule[];
  /** For a 'circuit' rule: the device's capabilities, to offer fan speed / direction. */
  capabilities?: Capability[];
  canDelete: boolean;
  onCancel: () => void;
  onSave: (rule: Schedule, copyToDeviceIds: string[]) => Promise<void>;
  onDelete?: () => void;
}) {
  const [name, setName] = useState(rule.name);
  const [action, setAction] = useState<Action>(rule.action);
  const [days, setDays] = useState<number[]>(rule.days);
  // Each window carries a transient `_k` (local-only, stripped before save) so
  // React keys on a stable identity instead of the array index — without it,
  // removing a window shifts indices and React mis-associates inputs (lost focus
  // / wrong values on the rows below the one removed).
  const winKey = useRef(0);
  const [windows, setWindows] = useState<Array<ScheduleWindow & { _k: number }>>(() =>
    (rule.windows.length ? rule.windows : [{ start: '14:00', end: '17:00' }]).map((w) => ({ ...w, _k: winKey.current++ })),
  );
  const [condition, setCondition] = useState<RunCondition>(rule.condition);
  const [copyTo, setCopyTo] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const isBlind = rule.type === 'blinds';
  const isCircuit = rule.type === 'circuit';
  const hideFanVanes = rule.type === 'heating'; // underfloor has no fan/vanes
  const modeOptions = rule.type === 'heating' ? HEATING_MODES : MODES; // heat: cool/heat/auto only

  // Circuit (generic switchable device) levers, derived from the device's capabilities.
  const speedCap = useMemo(
    () => (capabilities ?? []).find((c) => c.kind === 'range' && c.dp === 'fan_speed')
      ?? (capabilities ?? []).find((c) => c.kind === 'range'),
    [capabilities],
  );
  const directionCap = useMemo(
    () => (capabilities ?? []).find((c) => c.kind === 'enum' && (c.dp.includes('direction')))
      ?? (capabilities ?? []).find((c) => c.kind === 'enum'),
    [capabilities],
  );
  const speedMin = speedCap?.min ?? 1;
  const speedMax = speedCap?.max ?? 6;

  const setAct = (patch: Partial<Action>) => setAction((a) => ({ ...a, ...patch }));
  const toggleDay = (store: number) => setDays((p) => (p.includes(store) ? p.filter((x) => x !== store) : [...p, store].sort()));
  const setWindow = (i: number, patch: Partial<ScheduleWindow>) =>
    setWindows((ws) => ws.map((w, j) => (j === i ? { ...w, ...patch } : w)));
  const addWindow = () => setWindows((ws) => [...ws, { start: '20:00', end: '23:00', _k: winKey.current++ }]);
  const removeWindow = (i: number) => setWindows((ws) => (ws.length > 1 ? ws.filter((_, j) => j !== i) : ws));

  const draft: Schedule = useMemo(
    // Strip the transient `_k` so the persisted payload is exactly { start, end }.
    () => ({ ...rule, name: name.trim() || 'Rule', action, days, windows: windows.map(({ start, end }) => ({ start, end })), condition }),
    [rule, name, action, days, windows, condition],
  );

  const windowsOverlap = useMemo(() => selfOverlaps(expandSegments([0], windows)), [windows]);
  const overlapCheck = useMemo(() => checkRuleOverlap(draft, allRules), [draft, allRules]);

  const save = async () => {
    if (!overlapCheck.ok) { setErr(overlapCheck.reason); return; }
    setBusy(true);
    setErr(null);
    try {
      await onSave(draft, [...copyTo]);
    } catch (e) {
      setErr((e as Error).message || 'Could not save the rule');
      setBusy(false);
    }
  };

  const condKind = condition.kind;
  const threshold = condition.kind === 'always' ? (rule.type === 'heating' ? 19 : 27) : condition.thresholdC;
  const setCond = (kind: RunCondition['kind']) => {
    if (kind === 'always') setCondition({ kind: 'always' });
    else setCondition({ kind, thresholdC: threshold });
  };

  const body = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: wide ? '4px 22px 22px' : '4px 16px 18px' }}>
      {/* NAME + subtitle */}
      <div>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Rule name"
          style={{ fontSize: 18, fontWeight: 700 }}
        />
        <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 6 }}>{unitName} · {TYPE_LABEL[rule.type]}</div>
      </div>

      {/* OPERATION */}
      <Field title={isBlind ? 'Move the blind to' : isCircuit ? 'What to do' : 'Operation to run'}>
        {isBlind ? (
          <SegRow
            options={[{ value: 'close', label: 'Close' }, { value: 'open', label: 'Open' }]}
            value={(action.positionPct ?? 0) >= 50 ? 'open' : 'close'}
            onChange={(v) => setAct({ positionPct: v === 'open' ? 100 : 0 })}
            activeColor="var(--ev)"
          />
        ) : isCircuit ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-lg)', padding: 12 }}>
            <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>Turns on during the window · off after.</div>
            {speedCap && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, background: 'var(--surface-2)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', padding: '7px 10px' }}>
                <span style={{ fontSize: 12, color: 'var(--text-2)' }}>Fan speed</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {/* "—" = leave the device's current speed as-is (action.speed === undefined). */}
                  <button type="button" aria-label="Decrease speed"
                    onClick={() => {
                      const cur = action.speed ?? speedMin;
                      setAct({ speed: cur <= speedMin ? undefined : cur - 1 });
                    }}
                    style={stepBtn}><Icon name="minus" size={13} /></button>
                  <span className="pwr-mono" style={{ fontSize: 15, fontWeight: 600, color: 'var(--solar)', minWidth: 32, textAlign: 'center' }}>
                    {action.speed == null ? '—' : action.speed}
                  </span>
                  <button type="button" aria-label="Increase speed"
                    onClick={() => {
                      const cur = action.speed;
                      setAct({ speed: cur == null ? speedMin : Math.min(speedMax, cur + 1) });
                    }}
                    style={stepBtn}><Icon name="plus" size={13} /></button>
                </div>
              </div>
            )}
            {directionCap && directionCap.options && directionCap.options.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={label}>Direction</span>
                <SegRow
                  options={[{ value: '', label: 'Leave' }, ...directionCap.options.map((o) => ({ value: o, label: o }))]}
                  value={action.direction ?? ''}
                  onChange={(v) => setAct({ direction: v || undefined })}
                />
              </div>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-lg)', padding: 12 }}>
            <SegRow options={modeOptions} value={action.mode} onChange={(m) => setAct({ mode: m as ClimateMode })} />
            <div style={{ display: 'grid', gridTemplateColumns: hideFanVanes ? '1fr' : '1fr 1fr', gap: 10 }}>
              <Stepper label="Setpoint" value={action.setpointC} suffix="°" min={16} max={30} step={0.5} onChange={(v) => setAct({ setpointC: v })} />
              {!hideFanVanes && <FanVaneSelect title="Fan" value={action.fan} onChange={(v) => setAct({ fan: v as FanSetting })} />}
            </div>
            {!hideFanVanes && (
              <>
                <FanVaneSelect title="Up / down" value={action.vaneUpDown} onChange={(v) => setAct({ vaneUpDown: v as VaneSetting })} />
                <FanVaneSelect title="Left / right" value={action.vaneLeftRight} onChange={(v) => setAct({ vaneLeftRight: v as VaneSetting })} />
              </>
            )}
          </div>
        )}
      </Field>

      {/* DAYS */}
      <Field title="Days" right={
        <div style={{ display: 'flex', gap: 6 }}>
          <Preset onClick={() => setDays([1, 2, 3, 4, 5])}>Weekdays</Preset>
          <Preset onClick={() => setDays([0, 1, 2, 3, 4, 5, 6])}>Every day</Preset>
        </div>
      }>
        <div style={{ display: 'flex', gap: 6 }}>
          {DAY_ABBR.map((l, row) => {
            const store = ROW_TO_STORE[row];
            const on = days.includes(store);
            return (
              <button key={row} type="button" onClick={() => toggleDay(store)} aria-pressed={on}
                style={{ width: 34, height: 34, borderRadius: 9, border: `1px solid ${on ? 'transparent' : 'var(--border-1)'}`, cursor: 'pointer', fontSize: 12.5, fontWeight: 600, background: on ? 'var(--solar)' : 'var(--surface-1)', color: on ? 'var(--accent-contrast)' : 'var(--text-3)' }}>{l}</button>
            );
          })}
        </div>
      </Field>

      {/* TIME WINDOWS */}
      <Field title="Time windows" right={
        <button type="button" onClick={addWindow} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, color: 'var(--solar)', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}>
          <Icon name="plus" size={13} /> Add window
        </button>
      }>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {windows.map((w, i) => (
            <div key={w._k} style={{ background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {/* Start */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 10.5, color: 'var(--text-3)', width: 28, flex: 'none' }}>from</span>
                <AnchorPicker
                  value={w.startAnchor ?? 'fixed'}
                  onChange={(a) => {
                    const patch: Partial<ScheduleWindow> = { startAnchor: a };
                    if (a === 'sunrise') patch.start = '07:00';
                    if (a === 'sunset') patch.start = '20:30';
                    setWindow(i, patch);
                  }}
                />
                {(!w.startAnchor || w.startAnchor === 'fixed') ? (
                  <input type="time" value={w.start} onChange={(e) => setWindow(i, { start: e.target.value })} className="pwr-input" style={{ flex: 1, fontFamily: 'var(--font-mono)' }} />
                ) : (
                  <OffsetStepper value={w.startOffsetMin ?? 0} onChange={(v) => setWindow(i, { startOffsetMin: v })} />
                )}
              </div>
              {/* End */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 10.5, color: 'var(--text-3)', width: 28, flex: 'none' }}>to</span>
                <AnchorPicker
                  value={w.endAnchor ?? 'fixed'}
                  onChange={(a) => {
                    const patch: Partial<ScheduleWindow> = { endAnchor: a };
                    if (a === 'sunrise') patch.end = '07:00';
                    if (a === 'sunset') patch.end = '20:30';
                    setWindow(i, patch);
                  }}
                />
                {(!w.endAnchor || w.endAnchor === 'fixed') ? (
                  <input type="time" value={w.end} onChange={(e) => setWindow(i, { end: e.target.value })} className="pwr-input" style={{ flex: 1, fontFamily: 'var(--font-mono)' }} />
                ) : (
                  <OffsetStepper value={w.endOffsetMin ?? 0} onChange={(v) => setWindow(i, { endOffsetMin: v })} />
                )}
                <button type="button" aria-label="Remove window" disabled={windows.length <= 1} onClick={() => removeWindow(i)}
                  style={{ display: 'grid', placeItems: 'center', width: 30, height: 30, flex: 'none', borderRadius: 7, border: '1px solid var(--border-2)', background: 'var(--surface-2)', color: windows.length <= 1 ? 'var(--text-disabled)' : 'var(--text-2)', cursor: windows.length <= 1 ? 'default' : 'pointer' }}>
                  <Icon name="trash-2" size={13} />
                </button>
              </div>
            </div>
          ))}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: windowsOverlap ? 'var(--grid)' : 'var(--solar-dim)' }}>
            <Icon name={windowsOverlap ? 'triangle-alert' : 'check'} size={12} color={windowsOverlap ? 'var(--grid)' : 'var(--solar)'} />
            {windowsOverlap ? 'Windows overlap — fix before saving.' : 'No overlaps — colliding windows are blocked on save.'}
          </div>
        </div>
      </Field>

      {/* RUN CONDITION (climate only — blinds + circuits run purely on the time windows) */}
      {!isBlind && !isCircuit && (
      <Field title="Run condition">
        <SegRow
          options={[{ value: 'always', label: 'Always' }, { value: 'warmerThan', label: 'Only if warmer than' }, { value: 'coolerThan', label: 'Only if cooler than' }]}
          value={condKind}
          onChange={(k) => setCond(k as RunCondition['kind'])}
          activeColor="var(--grid)"
        />
        {condKind !== 'always' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10 }}>
            <Stepper label="Threshold" value={threshold} suffix="°" min={10} max={32} step={0.5} accent="var(--grid)" onChange={(v) => setCondition({ kind: condKind, thresholdC: v })} />
            <span style={{ fontSize: 11, color: 'var(--text-3)', flex: 1 }}>
              {condKind === 'warmerThan' ? 'Skips units already below this — pairs with cool.' : 'Skips units already above this — pairs with heat.'}
            </span>
          </div>
        )}
      </Field>
      )}

      {/* COPY TO UNITS */}
      {peers.length > 0 && (
        <Field title="Copy to units" right={<span style={{ fontSize: 11, color: 'var(--text-3)' }}>other {TYPE_LABEL[rule.type].toLowerCase()} units</span>}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {peers.map((p) => {
              const overlaps = wouldOverlapUnit(draft, p.id, allRules);
              const on = copyTo.has(p.id);
              return (
                <button key={p.id} type="button" disabled={overlaps}
                  onClick={() => setCopyTo((prev) => { const n = new Set(prev); n.has(p.id) ? n.delete(p.id) : n.add(p.id); return n; })}
                  title={overlaps ? 'Would overlap an existing rule on this unit' : undefined}
                  style={{ padding: '5px 11px', borderRadius: 999, fontSize: 12, fontWeight: 600, cursor: overlaps ? 'default' : 'pointer',
                    border: on ? 'none' : '1px solid var(--border-2)', background: on ? 'var(--solar-wash)' : 'transparent',
                    color: overlaps ? 'var(--text-disabled)' : on ? 'var(--solar)' : 'var(--text-2)', opacity: overlaps ? 0.55 : 1 }}>
                  {p.name}{overlaps ? ' · overlaps' : ''}
                </button>
              );
            })}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 8 }}>Duplicates this rule into each unit. Units where it would overlap are disabled.</div>
        </Field>
      )}

      {err && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: 'var(--grid)', background: 'var(--grid-wash)', border: '1px solid var(--border-grid-soft)', borderRadius: 'var(--radius-md)', padding: '8px 12px' }}>
          <Icon name="triangle-alert" size={14} color="var(--grid)" />{err}
        </div>
      )}

      {/* ACTIONS */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <Button variant="primary" loading={busy} disabled={windowsOverlap || days.length === 0} onClick={() => void save()} style={{ flex: 1 }}>Save rule</Button>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        {canDelete && rule.id && onDelete && (
          <button type="button" aria-label="Delete rule" onClick={onDelete} style={{ display: 'grid', placeItems: 'center', width: 40, height: 40, flex: 'none', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-2)', background: 'var(--surface-2)', color: 'var(--danger)', cursor: 'pointer' }}>
            <Icon name="trash-2" size={16} />
          </button>
        )}
      </div>
    </div>
  );

  return (
    <Modal open onClose={onCancel} placement="sheet" wideViewport={wide} ariaLabel="Edit rule">
      {body}
    </Modal>
  );
}

/* ---- Pieces ----------------------------------------------------------------*/

function Field({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, gap: 8 }}>
        <span style={label}>{title}</span>
        {right}
      </div>
      {children}
    </div>
  );
}

function Preset({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-2)', background: 'var(--surface-1)', border: '1px solid var(--border-2)', borderRadius: 8, padding: '4px 10px', cursor: 'pointer' }}>{children}</button>
  );
}

function SegRow({ options, value, onChange, activeColor = 'var(--solar)' }: {
  options: { value: string; label: string }[]; value: string; onChange: (v: string) => void; activeColor?: string;
}) {
  return (
    <div style={{ display: 'flex', gap: 4, background: 'var(--surface-2)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', padding: 4 }}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button key={o.value} type="button" onClick={() => onChange(o.value)}
            style={{ flex: 1, padding: '7px 4px', borderRadius: 7, border: 'none', cursor: 'pointer', fontSize: 11.5, fontWeight: on ? 700 : 500, background: on ? 'var(--surface-3)' : 'transparent', color: on ? activeColor : 'var(--text-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.label}</button>
        );
      })}
    </div>
  );
}

function Stepper({ label: lab, value, suffix, min, max, step, accent = 'var(--solar)', onChange }: {
  label: string; value: number; suffix?: string; min: number; max: number; step: number; accent?: string; onChange: (v: number) => void;
}) {
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v / step) * step));
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, background: 'var(--surface-2)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', padding: '7px 10px' }}>
      <span style={{ fontSize: 12, color: 'var(--text-2)' }}>{lab}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button type="button" aria-label="Decrease" onClick={() => onChange(clamp(value - step))} style={stepBtn}><Icon name="minus" size={13} /></button>
        <span className="pwr-mono" style={{ fontSize: 15, fontWeight: 600, color: accent, minWidth: 48, textAlign: 'center' }}>{value.toFixed(suffix === '°' ? 1 : 0)}{suffix}</span>
        <button type="button" aria-label="Increase" onClick={() => onChange(clamp(value + step))} style={stepBtn}><Icon name="plus" size={13} /></button>
      </div>
    </div>
  );
}

const stepBtn: CSSProperties = { display: 'grid', placeItems: 'center', width: 28, height: 28, borderRadius: 7, border: '1px solid var(--border-2)', background: 'var(--surface-1)', color: 'var(--text-2)', cursor: 'pointer' };

function FanVaneSelect({ title, value, onChange }: { title: string; value: FanSetting | VaneSetting; onChange: (v: FanSetting | VaneSetting) => void }) {
  const opts: (FanSetting | VaneSetting)[] = ['auto', 1, 2, 3, 4, 5];
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 11.5, color: 'var(--text-2)', width: 56, flex: 'none' }}>{title}</span>
      <div style={{ display: 'flex', gap: 4, flex: 1, background: 'var(--surface-2)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', padding: 4 }}>
        {opts.map((o) => {
          const on = value === o;
          return (
            <button key={String(o)} type="button" onClick={() => onChange(o)}
              style={{ flex: 1, padding: '6px 0', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: on ? 700 : 500, background: on ? 'var(--solar)' : 'transparent', color: on ? 'var(--accent-contrast)' : 'var(--text-3)' }}>
              {o === 'auto' ? 'A' : o}
            </button>
          );
        })}
      </div>
    </div>
  );
}

