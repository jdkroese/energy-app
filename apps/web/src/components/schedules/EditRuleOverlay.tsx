import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { Icon, Button, Switch } from '../ui';
import type { Action, ClimateMode, FanSetting, RunCondition, Schedule, VaneSetting } from '../../lib/types';
import { checkRuleOverlap, expandSegments, selfOverlaps, wouldOverlapUnit, TYPE_LABEL } from '../../lib/scheduleRules';

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
  canDelete: boolean;
  onCancel: () => void;
  onSave: (rule: Schedule, copyToDeviceIds: string[]) => Promise<void>;
  onDelete?: () => void;
}) {
  const [name, setName] = useState(rule.name);
  const [action, setAction] = useState<Action>(rule.action);
  const [days, setDays] = useState<number[]>(rule.days);
  const [windows, setWindows] = useState(rule.windows.length ? rule.windows : [{ start: '14:00', end: '17:00' }]);
  const [condition, setCondition] = useState<RunCondition>(rule.condition);
  const [copyTo, setCopyTo] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const hideFanVanes = rule.type === 'heating'; // underfloor has no fan/vanes

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onCancel]);

  const setAct = (patch: Partial<Action>) => setAction((a) => ({ ...a, ...patch }));
  const toggleDay = (store: number) => setDays((p) => (p.includes(store) ? p.filter((x) => x !== store) : [...p, store].sort()));
  const setWindow = (i: number, patch: { start?: string; end?: string }) =>
    setWindows((ws) => ws.map((w, j) => (j === i ? { ...w, ...patch } : w)));
  const addWindow = () => setWindows((ws) => [...ws, { start: '20:00', end: '23:00' }]);
  const removeWindow = (i: number) => setWindows((ws) => (ws.length > 1 ? ws.filter((_, j) => j !== i) : ws));

  const draft: Schedule = useMemo(
    () => ({ ...rule, name: name.trim() || 'Rule', action, days, windows, condition }),
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
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Rule name"
          className="pwr-input"
          style={{ fontSize: 18, fontWeight: 700, width: '100%' }}
        />
        <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 6 }}>{unitName} · {TYPE_LABEL[rule.type]}</div>
      </div>

      {/* OPERATION */}
      <Field title="Operation to run">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-lg)', padding: 12 }}>
          <SegRow options={MODES} value={action.mode} onChange={(m) => setAct({ mode: m as ClimateMode })} />
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
                style={{ width: 34, height: 34, borderRadius: 9, border: `1px solid ${on ? 'transparent' : 'var(--border-1)'}`, cursor: 'pointer', fontSize: 12.5, fontWeight: 600, background: on ? 'var(--solar)' : 'var(--surface-1)', color: on ? '#06090b' : 'var(--text-3)' }}>{l}</button>
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
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--surface-1)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', padding: '8px 10px' }}>
              <input type="time" value={w.start} onChange={(e) => setWindow(i, { start: e.target.value })} className="pwr-input" style={{ flex: 1, fontFamily: 'var(--font-mono)' }} />
              <span style={{ color: 'var(--text-3)' }}>—</span>
              <input type="time" value={w.end} onChange={(e) => setWindow(i, { end: e.target.value })} className="pwr-input" style={{ flex: 1, fontFamily: 'var(--font-mono)' }} />
              <button type="button" aria-label="Remove window" disabled={windows.length <= 1} onClick={() => removeWindow(i)}
                style={{ display: 'grid', placeItems: 'center', width: 30, height: 30, flex: 'none', borderRadius: 7, border: '1px solid var(--border-2)', background: 'var(--surface-2)', color: windows.length <= 1 ? 'var(--text-disabled)' : 'var(--text-2)', cursor: windows.length <= 1 ? 'default' : 'pointer' }}>
                <Icon name="trash-2" size={13} />
              </button>
            </div>
          ))}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: windowsOverlap ? 'var(--grid)' : 'var(--solar-dim)' }}>
            <Icon name={windowsOverlap ? 'alert-triangle' : 'check'} size={12} color={windowsOverlap ? 'var(--grid)' : 'var(--solar)'} />
            {windowsOverlap ? 'Windows overlap — fix before saving.' : 'No overlaps — colliding windows are blocked on save.'}
          </div>
        </div>
      </Field>

      {/* RUN CONDITION */}
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: 'var(--grid)', background: 'var(--grid-wash)', border: '1px solid rgba(245,165,36,0.22)', borderRadius: 'var(--radius-md)', padding: '8px 12px' }}>
          <Icon name="alert-triangle" size={14} color="var(--grid)" />{err}
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
    <div
      onClick={onCancel}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,.5)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: wide ? 'flex-start' : 'flex-end', justifyContent: 'center', overflowY: 'auto', animation: 'ruleFade .16s ease' }}
    >
      <style>{`@keyframes ruleFade { from { opacity: 0 } to { opacity: 1 } } @keyframes ruleRise { from { transform: translateY(14px); opacity: .7 } to { transform: translateY(0); opacity: 1 } }`}</style>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Edit rule"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 560,
          margin: wide ? '6vh 12px 6vh' : 0,
          background: 'var(--surface-1, #14181d)',
          border: '1px solid var(--border-2)',
          borderRadius: wide ? 18 : '18px 18px 0 0',
          boxShadow: '0 -8px 40px rgba(0,0,0,.5)',
          animation: 'ruleRise .2s cubic-bezier(.2,.7,.3,1)',
        }}
      >
        {!wide && <div style={{ width: 38, height: 4, borderRadius: 999, background: 'var(--border-3)', margin: '10px auto 2px' }} />}
        {body}
      </div>
    </div>
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
              style={{ flex: 1, padding: '6px 0', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: on ? 700 : 500, background: on ? 'var(--solar)' : 'transparent', color: on ? '#06090b' : 'var(--text-3)' }}>
              {o === 'auto' ? 'A' : o}
            </button>
          );
        })}
      </div>
    </div>
  );
}
