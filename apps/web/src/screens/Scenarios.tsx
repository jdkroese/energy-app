import { useEffect, useState, type CSSProperties } from 'react';
import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import { MOCK_SCENARIOS } from '../lib/mock';
import type { Scenario, ScenariosResponse } from '../lib/types';
import { Card, Slider, Switch, SegmentedControl, Button, Eyebrow, Icon } from '../components/ui';
import { StaleBanner } from './_shared';

/** Client-side brain-twin preview (mirrors the mockup's estimate). */
function preview(s: { weights: Scenario['weights']; reserve: number; gridCharge: boolean }) {
  const selfSuff = Math.max(50, Math.min(96, Math.round(58 + s.weights.self * 0.18 + s.weights.indep * 0.13 - (s.gridCharge ? 6 : 0))));
  const saved = (3.0 + s.weights.save * 0.035 + (s.gridCharge ? 1.4 : 0) + s.weights.self * 0.012).toFixed(2);
  const backupH = Math.round((s.reserve / 100) * 27 / 0.6);
  return { selfSuff, saved, backupH };
}

const frow: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '11px 0' };

export function Scenarios() {
  const { data, stale, updatedAt } = usePolling<ScenariosResponse>(api.scenarios, 0);
  const list = (data || MOCK_SCENARIOS).scenarios;

  const [sel, setSel] = useState(list[0].id);
  const [activeId, setActiveId] = useState(list.find((s) => s.active)?.id || list[0].id);
  const base = list.find((s) => s.id === sel) || list[0];

  const [w, setW] = useState(base.weights);
  const [reserve, setReserve] = useState(base.reserve);
  const [dyn, setDyn] = useState(base.dynReserve);
  const [gridChg, setGridChg] = useState(base.gridCharge);
  const [exportRule, setExportRule] = useState(base.exportRule);
  const [ev, setEv] = useState(base.ev);
  const [precond, setPrecond] = useState(base.precondition);
  const [activation, setActivation] = useState(base.activation);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel]);

  const p = preview({ weights: w, reserve, gridCharge: gridChg });

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
                {p.selfSuff}
                <small style={{ fontSize: 11, color: 'var(--text-3)' }}>%</small>
              </div>
            </div>
            <div style={{ background: 'var(--surface-2)', borderRadius: 12, padding: 12 }}>
              <div style={{ fontSize: 11, color: 'var(--text-2)' }}>Saved / day</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 600, color: 'var(--solar)', marginTop: 4 }}>€{p.saved}</div>
            </div>
            <div style={{ background: 'var(--surface-2)', borderRadius: 12, padding: 12 }}>
              <div style={{ fontSize: 11, color: 'var(--text-2)' }}>Backup</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 22, fontWeight: 600, color: 'var(--text-1)', marginTop: 4 }}>
                {p.backupH}
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
          <Button variant="primary" block iconLeft={<Icon name="check" />} onClick={() => setActiveId(sel)}>
            {activeId === sel ? 'Active' : 'Apply scenario'}
          </Button>
          <Button variant="secondary" iconLeft={<Icon name="copy" />}>
            Save
          </Button>
        </div>
      </div>
    </>
  );
}
