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
}

export interface FlowData {
  solar: FlowNode;
  sonnen: FlowNode;
  tesla: FlowNode;
  grid: FlowNode;
  home: FlowNode;
}

type NodeKey = keyof FlowData;

const POS_MOBILE: Record<NodeKey, { x: number; y: number }> = {
  solar: { x: 50, y: 16 },
  sonnen: { x: 15, y: 37 },
  tesla: { x: 15, y: 70 },
  grid: { x: 85, y: 50 },
  home: { x: 50, y: 88 },
};
const POS_DESKTOP: Record<NodeKey, { x: number; y: number }> = {
  solar: { x: 50, y: 14 },
  sonnen: { x: 10, y: 34 },
  tesla: { x: 10, y: 70 },
  grid: { x: 90, y: 50 },
  home: { x: 50, y: 90 },
};
const HUB = { x: 50, y: 50 };
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

/**
 * EnergyFlow — the signature two-battery live diagram (`pwr2`). A central hub
 * links Solar, Sonnen, Tesla, Grid and Home; power animates along each line in
 * its real direction. Ported faithfully from the live mockups.
 */
export function EnergyFlow({ flow, size = 'sm' }: Props) {
  ensureDsStyles();
  const POS = size === 'lg' ? POS_DESKTOP : POS_MOBILE;
  const seg = (k: NodeKey, a: { x: number; y: number }, b: { x: number; y: number }) => ({
    key: k,
    d: `M${a.x} ${a.y} L${b.x} ${b.y}`,
    color: COLOR[k],
  });

  const links: { key: NodeKey; d: string; color: string }[] = [];
  if (flow.solar.kw > 0.05) links.push(seg('solar', POS.solar, HUB));
  if (flow.home.kw > 0.05) links.push(seg('home', HUB, POS.home));
  if (flow.grid.dir === 'exporting' && flow.grid.kw > 0.05) links.push(seg('grid', HUB, POS.grid));
  if (flow.grid.dir === 'importing' && flow.grid.kw > 0.05) links.push(seg('grid', POS.grid, HUB));
  (['sonnen', 'tesla'] as const).forEach((b) => {
    if (flow[b].dir === 'charging') links.push(seg(b, HUB, POS[b]));
    if (flow[b].dir === 'discharging') links.push(seg(b, POS[b], HUB));
  });
  const active = new Set(links.map((l) => l.key));
  const keys = Object.keys(POS) as NodeKey[];

  return (
    <div className={`pwr2${size === 'lg' ? ' pwr2--lg' : ''}`}>
      <svg className="pwr2__svg" viewBox="0 0 100 100" preserveAspectRatio="none">
        {keys.map((k) => (
          <line key={k} className="pwr2__base" x1={HUB.x} y1={HUB.y} x2={POS[k].x} y2={POS[k].y} />
        ))}
        {links.map((l) => (
          <path key={l.key} className="pwr2__line" d={l.d} style={{ stroke: l.color }} />
        ))}
      </svg>
      {keys.map((k) => {
        const n = flow[k];
        const on = active.has(k);
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
      <div className="pwr2__hub">
        <Icon name="zap" />
      </div>
    </div>
  );
}
