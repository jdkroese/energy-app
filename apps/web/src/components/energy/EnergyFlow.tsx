import type { CSSProperties } from 'react';
import { Icon } from '../ui/Icon';
import { ensureDsStyles } from '../ui/dsStyles';
import type { FlowDir } from '../../lib/types';

export interface FlowNode {
  /** big readout value, already formatted (e.g. "11.1" or "100") */
  val: string;
  /** unit shown small after the value ("kW" / "%") */
  unit: string;
  /** sub line under the value ("2 arrays", "9.2 kWh · idle") */
  sub: string;
  name: string;
  kw: number;
  dir?: FlowDir;
  /**
   * Optional per-source split of the solar total (2× Sungrow inverters + the
   * Tesla-metered array). When present (≥2 real, named sources) the diagram
   * renders each as its own node at the top, feeding a line into the combined
   * Solar "production feed" node. Absent → the compact single-Solar layout.
   */
  breakdown?: { label: string; kw: number }[];
}

export interface FlowData {
  solar: FlowNode;
  sonnen: FlowNode;
  tesla: FlowNode;
  grid: FlowNode;
  home: FlowNode;
}

type NodeKey = keyof FlowData;
type Pt = { x: number; y: number };
type Layout = { hub: Pt; pos: Record<NodeKey, Pt>; srcY: number };

// Two layouts per breakpoint. `compact` is the original 5-node diagram (Solar
// feeds the hub from the top). `sources` pushes the whole graph down and frees
// the top ~22% for a row of inverter source nodes that feed into Solar.
const L_SM_COMPACT: Layout = {
  hub: { x: 50, y: 50 },
  srcY: 0,
  pos: { solar: { x: 50, y: 18 }, sonnen: { x: 15, y: 42 }, tesla: { x: 15, y: 80 }, grid: { x: 85, y: 42 }, home: { x: 50, y: 80 } },
};
const L_SM_SRC: Layout = {
  hub: { x: 50, y: 62 },
  srcY: 11,
  pos: { solar: { x: 50, y: 33 }, sonnen: { x: 15, y: 55 }, tesla: { x: 15, y: 86 }, grid: { x: 85, y: 55 }, home: { x: 50, y: 86 } },
};
const L_LG_COMPACT: Layout = {
  hub: { x: 50, y: 50 },
  srcY: 0,
  pos: { solar: { x: 50, y: 17 }, sonnen: { x: 13, y: 40 }, tesla: { x: 13, y: 80 }, grid: { x: 87, y: 40 }, home: { x: 50, y: 80 } },
};
const L_LG_SRC: Layout = {
  hub: { x: 50, y: 61 },
  srcY: 10,
  pos: { solar: { x: 50, y: 34 }, sonnen: { x: 13, y: 55 }, tesla: { x: 13, y: 84 }, grid: { x: 87, y: 55 }, home: { x: 50, y: 84 } },
};

const COLOR: Record<NodeKey, string> = {
  solar: 'var(--solar)',
  sonnen: 'var(--battery)',
  tesla: 'var(--battery)',
  grid: 'var(--grid)',
  home: 'var(--home)',
};
const ICON: Record<NodeKey, string> = {
  solar: 'sun',
  sonnen: 'battery-charging',
  tesla: 'battery-charging',
  grid: 'utility-pole',
  home: 'house',
};

type Props = {
  flow: FlowData;
  /** larger node sizing for desktop */
  size?: 'sm' | 'lg';
};

/** Drop a redundant leading "Solar " from an inverter label ("Solar Inverter 1"
 * → "Inverter 1") — it's already grouped under the Solar node. */
function shortSource(label: string): string {
  return label.replace(/^solar\s+/i, '');
}

/**
 * EnergyFlow — the signature two-battery live diagram (`pwr2`). A central hub
 * links Solar, Sonnen, Tesla, Grid and Home; power animates along each line in
 * its real direction. When the live solar split is available, the Solar node
 * becomes a "combined production feed" fed by the individual inverter nodes.
 */
export function EnergyFlow({ flow, size = 'sm' }: Props) {
  ensureDsStyles();
  const lg = size === 'lg';
  // Only split into source nodes when there are ≥2 real, named arrays (the
  // night-time A/B proxy is filtered upstream so it stays on the compact layout).
  const sources = flow.solar.breakdown && flow.solar.breakdown.length >= 2 ? flow.solar.breakdown : null;
  const hasSrc = !!sources;
  const layout = lg ? (hasSrc ? L_LG_SRC : L_LG_COMPACT) : hasSrc ? L_SM_SRC : L_SM_COMPACT;
  const POS = layout.pos;
  const HUB = layout.hub;

  // Fan the source nodes across the top, centred over Solar.
  const srcPts = (sources ?? []).map((s, i) => {
    const n = sources!.length;
    const spread = Math.min(48, 24 * (n - 1));
    const x = n === 1 ? 50 : 50 - spread / 2 + spread * (i / (n - 1));
    return { ...s, x, y: layout.srcY };
  });

  const seg = (color: string, a: Pt, b: Pt) => ({ d: `M${a.x} ${a.y} L${b.x} ${b.y}`, color });

  // Animated flow links (only real, moving flows).
  const links: { key: string; d: string; color: string }[] = [];
  if (flow.solar.kw > 0.05) links.push({ key: 'solar', ...seg(COLOR.solar, POS.solar, HUB) });
  if (flow.home.kw > 0.05) links.push({ key: 'home', ...seg(COLOR.home, HUB, POS.home) });
  if (flow.grid.dir === 'exporting' && flow.grid.kw > 0.05) links.push({ key: 'grid', ...seg(COLOR.grid, HUB, POS.grid) });
  if (flow.grid.dir === 'importing' && flow.grid.kw > 0.05) links.push({ key: 'grid', ...seg(COLOR.grid, POS.grid, HUB) });
  (['sonnen', 'tesla'] as const).forEach((b) => {
    if (flow[b].dir === 'charging') links.push({ key: b, ...seg(COLOR[b], HUB, POS[b]) });
    if (flow[b].dir === 'discharging') links.push({ key: b, ...seg(COLOR[b], POS[b], HUB) });
  });
  // Each producing inverter feeds a line down into the Solar production node.
  srcPts.forEach((s, i) => {
    if (s.kw > 0.05) links.push({ key: `src${i}`, ...seg(COLOR.solar, { x: s.x, y: s.y }, POS.solar) });
  });

  const activeMain = new Set(links.map((l) => l.key));
  const keys = Object.keys(POS) as NodeKey[];

  return (
    <div className={`pwr2${lg ? ' pwr2--lg' : ''}${hasSrc ? ' pwr2--src' : ''}`}>
      <svg className="pwr2__svg" viewBox="0 0 100 100" preserveAspectRatio="none">
        {/* base (idle) rails: hub → each main node, and each source → solar */}
        {keys.map((k) => (
          <line key={k} className="pwr2__base" x1={HUB.x} y1={HUB.y} x2={POS[k].x} y2={POS[k].y} />
        ))}
        {srcPts.map((s, i) => (
          <line key={`sb${i}`} className="pwr2__base" x1={s.x} y1={s.y} x2={POS.solar.x} y2={POS.solar.y} />
        ))}
        {links.map((l) => (
          <path key={l.key} className="pwr2__line" d={l.d} style={{ stroke: l.color }} />
        ))}
      </svg>

      {/* main nodes */}
      {keys.map((k) => {
        const n = flow[k];
        const on = activeMain.has(k);
        const above = k === 'solar';
        const chip = (
          <div className="pwr2__chip">
            <Icon name={ICON[k]} />
          </div>
        );
        const labels = (
          <>
            <span className="pwr2__name">{n.name}</span>
            <span className="pwr2__kw">
              {n.val}
              <small> {n.unit}</small>
            </span>
            <span className="pwr2__sub">{n.sub}</span>
          </>
        );
        return (
          <div
            key={k}
            className={'pwr2__node' + (on ? ' pwr2__node--active' : '')}
            style={{ left: POS[k].x + '%', top: POS[k].y + '%', '--_c': COLOR[k] } as CSSProperties}
          >
            {above ? (
              <>
                {labels}
                {chip}
              </>
            ) : (
              <>
                {chip}
                {labels}
              </>
            )}
          </div>
        );
      })}

      {/* inverter source nodes (top row, feeding Solar) */}
      {srcPts.map((s, i) => (
        <div
          key={`src${i}`}
          className={'pwr2__node pwr2__node--src' + (s.kw > 0.05 ? ' pwr2__node--active' : '')}
          style={{ left: s.x + '%', top: s.y + '%', '--_c': COLOR.solar } as CSSProperties}
        >
          <div className="pwr2__chip">
            <Icon name="sun" />
          </div>
          <span className="pwr2__name">{shortSource(s.label)}</span>
          <span className="pwr2__kw">
            {s.kw.toFixed(1)}
            <small> kW</small>
          </span>
        </div>
      ))}

      <div className="pwr2__hub" style={{ left: HUB.x + '%', top: HUB.y + '%' }}>
        <Icon name="zap" />
      </div>
    </div>
  );
}
