import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import { MOCK_SCENARIOS } from '../lib/mock';
import type { Scenario, ScenarioDef, ScenariosResponse } from '../lib/types';
import { Card, Slider, Switch, SegmentedControl, Button, Eyebrow, Icon } from '../components/ui';
import { StaleBanner } from './_shared';

/** Client-side brain-twin preview (fallback / instant feedback before the API replies). */
function localPreview(s: { weights: Scenario['weights']; reserve: number; gridCharge: boolean }) {
  const selfSuff = Math.max(50, Math.min(96, Math.round(58 + s.weights.self * 0.18 + s.weights.indep * 0.13 - (s.gridCharge ? 6 : 0))));
  const saved = Number((3.0 + s.weights.save * 0.035 + (s.gridCharge ? 1.4 : 0) + s.weights.self * 0.012).toFixed(2));
  const backupH = Math.round((s.reserve / 100) * 27 / 0.6);
  return { selfSufficiencyPct: selfSuff, savedPerDayEur: saved, backupHours: backupH };
}

const frow: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '11px 0' };

/** Pull the editable definition out of a draft's local editor state. */
function toDef(d: {
  weights: Scenario['weights'];
  reserve: number;
  dynReserve: boolean;
  gridCharge: boolean;
  exportRule: string;
  ev: string;
  precondition: boolean;
  activation: string;
  trigger: string;
}): ScenarioDef {
  return { ...d };
}

export function Scenarios() {
  const { data, stale, updatedAt, refetch } = usePolling<ScenariosResponse>(api.scenarios, 0);
  const resp = data || MOCK_SCENARIOS;
  const list = resp.scenarios;

  const [sel, setSel] = useState(list[0].id);
  const [activeId, setActiveId] = useState(resp.active || list.find((s) => s.active)?.id || list[0].id);
  const base = list.find((s) => s.id === sel) || list[0];

  // keep activeId in sync with the API
  useEffect(() => {
    setActiveId(resp.active || list.find((s) => s.active)?.id || list[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resp.active, data]);

  // editor draft
  const [w, setW] = useState(base.weights);
  const [reserve, setReserve] = useState(base.reserve);
  const [dyn, setDyn] = useState(base.dynReserve);
  const [gridChg, setGridChg] = useState(base.gridCharge);
  const [exportRule, setExportRule] = useState(base.exportRule);
  const [ev, setEv] = useState(base.ev);
  const [precond, setPrecond] = useState(base.precondition);
  const [activation, setActivation] = useState(base.activation);

  const [applying, setApplying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedTick, setSavedTick] = useState(false);

  // re-seed editor when the selected scenario changes
  useEffect(() => {
    setW(base.weights);
    setReserve(base.reserve);
    setDyn(base.dynReserve);
    setGridChg(base.gridCharge);
    setExportRule(base.exportRule);
    setEv(base.ev);
    setPrecond(base.precondition);
    setActivation(base.activation);
    setSavedTick(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel]);

  // --- debounced server-side preview, with client-calc as instant fallback ---
  const fallback = localPreview({ weights: w, reserve, gridCharge: gridChg });
  const [p, setP] = useState(fallback);
  const debRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // show the instant client estimate immediately…
    setP(localPreview({ weights: w, reserve, gridCharge: gridChg }));
    // …then refine with the brain twin (debounced).
    if (debRef.current) clearTimeout(debRef.current);
    const def = toDef({ weights: w, reserve, dynReserve: dyn, gridCharge: gridChg, exportRule, ev, precondition: precond, activation, trigger: base.trigger });
    debRef.current = setTimeout(() => {
      api
        .scenarioPreview(def)
        .then((res) => setP(res))
        .catch(() => {
          /* keep the client estimate */
        });
    }, 350);
    return () => {
      if (debRef.current) clearTimeout(debRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w, reserve, dyn, gridChg, exportRule, ev, precond, activation, sel]);

  const currentDef = () => toDef({ weights: w, reserve, dynReserve: dyn, gridCharge: gridChg, exportRule, ev, precondition: precond, activation, trigger: base.trigger });

  const onApply = async () => {
    const prev = activeId;
    setApplying(true);
    setActiveId(sel); // optimistic active badge
    try {
      // persist the edits first, then mark it active
      await api.scenarioSave(sel, currentDef());
      await api.scenarioApply(sel);
      refetch();
    } catch {
      setActiveId(prev); // revert badge
    } finally {
      setApplying(false);
    }
  };

  const onSave = async () => {
    setSaving(true);
    try {
      await api.scenarioSave(sel, currentDef());
      setSavedTick(true);
      setTimeout(() => setSavedTick(false), 1800);
      refetch();
    } catch {
      /* keep draft; user can retry */
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div style={{ padding: '12px 18px 12px' }}>
        <Eyebrow>Scenarios</Eyebrow>
        <h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-.02em', margin: '2px 0 0' }}>Strategy profiles</h1>
      </div>
      {stale && <StaleBanner updatedAt={updatedAt} />}

      {/* selector */}
      <div style={{ display: 'flex', gap: 10, overflowX: 'auto', padding: '2px 14px 4px', scrollbarWidth: 'none' }}>
        {list.map((s) => {
          const on = sel === s.id;
          return (
            <div
              key={s.id}
              onClick={() => setSel(s.id)}
              style={{
                flex: 'none',
                width: 150,
                borderRadius: 14,
                padding: 13,
                cursor: 'pointer',
                border: `1px solid ${on ? 'var(--solar)' : 'var(--border-2)'}`,
                background: on ? 'var(--solar-wash)' : 'var(--surface-1)',
                transition: 'border-color .15s,background .15s',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center', background: on ? 'transparent' : 'var(--surface-3)', color: on ? 'var(--solar)' : 'var(--text-2)' }}>
                  <Icon name={s.icon} size={17} />
                </span>
                {activeId === s.id && (
                  <span style={{ fontSize: 9, fontWeight: 600, color: 'var(--solar)', background: 'var(--solar-wash)', padding: '3px 7px', borderRadius: 999 }}>ACTIVE</span>
                )}
              </div>
              <div style={{ fontSize: 13.5, fontWeight: 500, marginTop: 9, lineHeight: 1.25 }}>{s.name}</div>
            </div>
          );
        })}
        <div style={{ flex: 'none', width: 150, borderRadius: 14, padding: 13, border: '1px solid var(--border-2)', display: 'grid', placeItems: 'center', color: 'var(--text-3)' }}>
          <div style={{ textAlign: 'center' }}>
            <Icon name="plus" size={20} />
            <div style={{ fontSize: 12, marginTop: 6 }}>New</div>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '12px 14px 22px', maxWidth: 760, margin: '0 auto', width: '100%' }}>
        {/* shadow-mode note */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 12px', borderRadius: 'var(--radius-md)', background: 'var(--battery-wash)', color: 'var(--battery)', fontSize: 12, lineHeight: 1.45 }}>
          <Icon name="eye" size={15} />
          <span style={{ color: 'var(--text-2)' }}>
            <strong style={{ color: 'var(--battery)' }}>Advisory mode.</strong> The brain plans with this profile but doesn't command the batteries yet — Apply changes the strategy it optimizes toward.
          </span>
        </div>

        {/* optimize for */}
        <Card style={{ padding: 16 }}>
          <Eyebrow>Optimize for</Eyebrow>
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Slider label="Savings" unit="%" value={w.save} onChange={(v) => setW({ ...w, save: v })} />
            <Slider label="Self-consumption" unit="%" value={w.self} onChange={(v) => setW({ ...w, self: v })} />
            <Slider label="Independence" unit="%" value={w.indep} onChange={(v) => setW({ ...w, indep: v })} />
            <Slider label="Comfort" unit="%" value={w.comfort} onChange={(v) => setW({ ...w, comfort: v })} />
          </div>
        </Card>

        {/* batteries */}
        <Card style={{ padding: 16 }}>
          <Eyebrow>Batteries</Eyebrow>
          <div style={{ marginTop: 8 }}>
            <Slider label="Tesla backup reserve" unit="%" value={reserve} onChange={setReserve} />
          </div>
          <div style={frow}>
            <div>
              <div style={{ fontSize: 14 }}>Weather-aware reserve</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 2 }}>Raise reserve automatically on storm / outage risk</div>
            </div>
            <Switch checked={dyn} onChange={(e) => setDyn(e.target.checked)} />
          </div>
          <div style={{ ...frow, borderTop: '1px solid var(--border-1)' }}>
            <div>
              <div style={{ fontSize: 14 }}>Grid charging</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 2 }}>{gridChg ? 'Allowed in P3 (cheap) only' : 'Solar only — never buy to store'}</div>
            </div>
            <Switch checked={gridChg} onChange={(e) => setGridChg(e.target.checked)} />
          </div>
          <div style={{ paddingTop: 11 }}>
            <div style={{ fontSize: 14, marginBottom: 8 }}>Export rule</div>
            <SegmentedControl block options={['PV only', 'Battery OK', 'Never']} value={exportRule} onChange={setExportRule} />
          </div>
        </Card>

        {/* flexible loads */}
        <Card style={{ padding: 16 }}>
          <Eyebrow>Flexible loads</Eyebrow>
          <div style={{ paddingTop: 10 }}>
            <div style={{ fontSize: 14, marginBottom: 8 }}>EV charging · 2× BMW i3</div>
            <SegmentedControl block options={['Solar', 'P3 night', 'Off']} value={ev} onChange={setEv} />
          </div>
          <div style={{ ...frow, marginTop: 4 }}>
            <div>
              <div style={{ fontSize: 14 }}>Pre-condition home</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 2 }}>Pre-cool / pre-heat the slab to dodge the P1 peak</div>
            </div>
            <Switch checked={precond} onChange={(e) => setPrecond(e.target.checked)} />
          </div>
        </Card>

        {/* activation */}
        <Card style={{ padding: 16 }}>
          <Eyebrow>When it runs</Eyebrow>
          <div style={{ paddingTop: 10 }}>
            <SegmentedControl block options={['Manual', 'Schedule', 'Auto']} value={activation} onChange={setActivation} />
          </div>
          <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--text-2)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="info" size={15} color="var(--text-3)" />
            {base.trigger}
          </div>
        </Card>

        {/* impact preview */}
        <Card accent="solar" style={{ padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <Eyebrow>Projected impact</Eyebrow>
            <span style={{ fontSize: 11, color: 'var(--text-3)' }}>brain twin · estimate</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
            <div style={{ background: 'var(--surface-2)', borderRadius: 12, padding: 12 }}>
              <div style={{ fontSize: 11, color: 'var(--text-2)' }}>Self-sufficiency</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 600, color: 'var(--battery)', marginTop: 4 }}>
                {p.selfSufficiencyPct}
                <small style={{ fontSize: 11, color: 'var(--text-3)' }}>%</small>
              </div>
            </div>
            <div style={{ background: 'var(--surface-2)', borderRadius: 12, padding: 12 }}>
              <div style={{ fontSize: 11, color: 'var(--text-2)' }}>Saved / day</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 600, color: 'var(--solar)', marginTop: 4 }}>€{p.savedPerDayEur.toFixed(2)}</div>
            </div>
            <div style={{ background: 'var(--surface-2)', borderRadius: 12, padding: 12 }}>
              <div style={{ fontSize: 11, color: 'var(--text-2)' }}>Backup</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 600, color: 'var(--text-1)', marginTop: 4 }}>
                {p.backupHours}
                <small style={{ fontSize: 11, color: 'var(--text-3)' }}>h</small>
              </div>
            </div>
          </div>
          <div style={{ marginTop: 11, fontSize: 11, color: 'var(--text-3)', display: 'flex', alignItems: 'center', gap: 7 }}>
            <Icon name="shield-check" size={14} />
            14 kW grid cap, SoC limits &amp; fail-safe always enforced
          </div>
        </Card>

        {/* actions */}
        <div style={{ display: 'flex', gap: 10, marginTop: 2 }}>
          <Button variant="primary" block loading={applying} iconLeft={<Icon name="check" />} disabled={activeId === sel} onClick={() => void onApply()}>
            {activeId === sel ? 'Active' : 'Apply scenario'}
          </Button>
          <Button variant="secondary" loading={saving} iconLeft={<Icon name={savedTick ? 'check' : 'copy'} />} onClick={() => void onSave()}>
            {savedTick ? 'Saved' : 'Save'}
          </Button>
        </div>
      </div>
    </>
  );
}
