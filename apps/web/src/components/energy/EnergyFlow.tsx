import type { CSSProperties } from 'react';
import { Icon } from '../ui/Icon';
import { ensureDsStyles } from '../ui/dsStyles';
import type { FlowDir } from '../../lib/types';

export interface FlowNode {
  /** big readout value, already formatted (e.g. "11.1" or "+1.9") */
  val: string;
  /** unit shown small after the value ("kW" / "%") */
  unit: string;
  /** sub line under the value — the SECONDARY params, small + grey ("8.1 kWh") */
  sub: string;
  name: string;
  kw: number;
  dir?: FlowDir;
  /** State of charge (0–100). When set, the chip gets a tone-coloured SoC ring
   *  gauge and the label shows the % as a prominent bold line above `sub`. */
  soc?: number;
  /**
   * Optional per-source split of the solar total (2× Sungrow inverters + the
   * Tesla-metered array). When present (≥2 entries) the diagram renders each
   * as its own node across the top, feeding a line into the combined Solar
   * "production feed" node. `est` marks proxy-estimated values (shown as ~).
   */
  breakdown?: { label: string; kw: number; est?: boolean }[];
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

// Node positions are the CHIP CENTRES (labels hang off the chip and don't move
// the anchor), so every line starts/ends exactly at the middle of a box.
// Two layouts per breakpoint: `compact` (no source row) and `src` (inverter
// sources across the top, everything else pushed down; uses the full height).
const L_SM_COMPACT: Layout = {
  hub: { x: 50, y: 52 },
  srcY: 0,
  pos: { solar: { x: 50, y: 26 }, sonnen: { x: 16, y: 40 }, tesla: { x: 16, y: 74 }, grid: { x: 84, y: 40 }, home: { x: 50, y: 74 } },
};
const L_SM_SRC: Layout = {
  hub: { x: 50, y: 58 },
  srcY: 12,
  pos: { solar: { x: 50, y: 33 }, sonnen: { x: 16, y: 54 }, tesla: { x: 16, y: 81 }, grid: { x: 84, y: 54 }, home: { x: 50, y: 81 } },
};
const L_LG_COMPACT: Layout = {
  hub: { x: 50, y: 52 },
  srcY: 0,
  pos: { solar: { x: 50, y: 25 }, sonnen: { x: 14, y: 40 }, tesla: { x: 14, y: 75 }, grid: { x: 86, y: 40 }, home: { x: 50, y: 75 } },
};
const L_LG_SRC: Layout = {
  hub: { x: 50, y: 58 },
  srcY: 13,
  pos: { solar: { x: 50, y: 34 }, sonnen: { x: 14, y: 54 }, tesla: { x: 14, y: 80 }, grid: { x: 86, y: 54 }, home: { x: 50, y: 80 } },
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

/** SoC ring gauge drawn around a battery chip (tone colour from --_c). */
function SocRing({ soc, size }: { soc: number; size: number }) {
  const r = (size - 4) / 2;
  const c = 2 * Math.PI * r;
  const fill = (c * Math.max(0, Math.min(100, soc))) / 100;
  return (
    <svg className="pwr2__ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <circle className="pwr2__ring-track" cx={size / 2} cy={size / 2} r={r} />
      <circle className="pwr2__ring-fill" cx={size / 2} cy={size / 2} r={r} strokeDasharray={`${fill} ${c}`} />
    </svg>
  );
}

/**
 * EnergyFlow — the signature two-battery live diagram (`pwr2`). A central hub
 * links Solar, Sonnen, Tesla, Grid and Home; power animates along each line in
 * its real direction. Stream pace AND thickness encode each flow's share of
 * the biggest current flow, batteries carry a SoC ring gauge, and (when the
 * live solar split is available) individual inverter nodes across the top feed
 * the combined Solar "production feed" node.
 */
export function EnergyFlow({ flow, size = 'sm' }: Props) {
  ensureDsStyles();
  const lg = size === 'lg';
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

  const seg = (color: string, kw: number, a: Pt, b: Pt) => ({
    d: `M${a.x} ${a.y} L${b.x} ${b.y}`,
    color,
    kw,
  });

  // Animated flow links (only real, moving flows).
  const links: { key: string; d: string; color: string; kw: number }[] = [];
  if (flow.solar.kw > 0.05) links.push({ key: 'solar', ...seg(COLOR.solar, flow.solar.kw, POS.solar, HUB) });
  if (flow.home.kw > 0.05) links.push({ key: 'home', ...seg(COLOR.home, flow.home.kw, HUB, POS.home) });
  if (flow.grid.dir === 'exporting' && flow.grid.kw > 0.05) links.push({ key: 'grid', ...seg(COLOR.grid, flow.grid.kw, HUB, POS.grid) });
  if (flow.grid.dir === 'importing' && flow.grid.kw > 0.05) links.push({ key: 'grid', ...seg(COLOR.grid, flow.grid.kw, POS.grid, HUB) });
  (['sonnen', 'tesla'] as const).forEach((b) => {
    if (flow[b].dir === 'charging' && flow[b].kw > 0.05) links.push({ key: b, ...seg(COLOR[b], flow[b].kw, HUB, POS[b]) });
    if (flow[b].dir === 'discharging' && flow[b].kw > 0.05) links.push({ key: b, ...seg(COLOR[b], flow[b].kw, POS[b], HUB) });
  });
  // Each producing inverter feeds a line down into the Solar production node.
  srcPts.forEach((s, i) => {
    if (s.kw > 0.05) links.push({ key: `src${i}`, ...seg(COLOR.solar, s.kw, { x: s.x, y: s.y }, POS.solar) });
  });

  // Pace + weight ∝ contribution: each stream's dash speed and stroke width
  // scale with its share of the biggest flow on screen right now, so the
  // dominant stream visibly races and carries the thickest channel.
  const maxKw = Math.max(0.1, ...links.map((l) => l.kw));
  const linkStyle = (l: { color: string; kw: number }): CSSProperties => {
    const share = l.kw / maxKw;
    return {
      stroke: l.color,
      strokeWidth: 1.3 + 1.7 * share,
      animationDuration: `${(1.45 - 1.05 * share).toFixed(2)}s`,
    };
  };
  const glowStyle = (l: { color: string; kw: number }): CSSProperties => ({
    stroke: l.color,
    strokeWidth: 4.5 + 4.5 * (l.kw / maxKw),
  });

  const activeMain = new Set(links.map((l) => l.key));
  const keys = Object.keys(POS) as NodeKey[];
  const ringSize = lg ? 68 : 62;

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
        {/* live flows: a soft glow underlay + the crisp animated dash on top */}
        {links.map((l) => (
          <path key={`g-${l.key}`} className="pwr2__glow" d={l.d} style={glowStyle(l)} />
        ))}
        {links.map((l) => (
          <path key={l.key} className="pwr2__line" d={l.d} style={linkStyle(l)} />
        ))}
      </svg>

      {/* main nodes — the chip sits exactly on the line anchor; labels hang off it */}
      {keys.map((k, i) => {
        const n = flow[k];
        const on = activeMain.has(k);
        const lbl = k === 'solar' ? (hasSrc ? 'right' : 'above') : 'below';
        return (
          <div
            key={k}
            className={'pwr2__node' + (on ? ' pwr2__node--active' : '')}
            style={{ left: POS[k].x + '%', top: POS[k].y + '%', '--_c': COLOR[k], animationDelay: `${i * 45}ms` } as CSSProperties}
          >
            {n.soc != null && <SocRing soc={n.soc} size={ringSize} />}
            <div className="pwr2__chip">
              <Icon name={ICON[k]} />
            </div>
            <div className={`pwr2__lbl pwr2__lbl--${lbl}`}>
              <span className="pwr2__name">{n.name}</span>
              <span className="pwr2__kw">
                {n.val}
                <small> {n.unit}</small>
              </span>
              {n.soc != null ? (
                <span className="pwr2__soc">
                  {Math.round(n.soc)} %<small> · {n.sub}</small>
                </span>
              ) : (
                n.sub && <span className="pwr2__sub">{n.sub}</span>
              )}
            </div>
          </div>
        );
      })}

      {/* inverter source nodes (top row, feeding Solar); labels above so the
          feed lines below the chips never cross text */}
      {srcPts.map((s, i) => (
        <div
          key={`src${i}`}
          className={'pwr2__node pwr2__node--src' + (s.kw > 0.05 ? ' pwr2__node--active' : '')}
          style={{ left: s.x + '%', top: s.y + '%', '--_c': COLOR.solar, animationDelay: `${(keys.length + i) * 45}ms` } as CSSProperties}
        >
          <div className="pwr2__chip">
            <Icon name="sun" />
          </div>
          <div className="pwr2__lbl pwr2__lbl--above">
            <span className="pwr2__name">{shortSource(s.label)}</span>
            <span className="pwr2__kw">
              {s.est ? '~' : ''}
              {s.kw.toFixed(1)}
              <small> kW</small>
            </span>
          </div>
        </div>
      ))}

      <div className="pwr2__hub" style={{ left: HUB.x + '%', top: HUB.y + '%' }}>
        <Icon name="zap" />
      </div>
    </div>
  );
}
