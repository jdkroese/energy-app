import * as React from 'react';

export interface FlowNode {
  /** Power in kW (magnitude). */
  kw: number;
}
export interface BatteryNode extends FlowNode {
  dir?: 'charging' | 'discharging' | 'idle';
  /** State of charge %, if you want to surface it. */
  soc?: number;
}
export interface GridNode extends FlowNode {
  dir?: 'importing' | 'exporting' | 'idle';
}

/**
 * @startingPoint section="Data" subtitle="Animated solar→battery→home→grid diagram" viewport="520x440"
 */
export interface EnergyFlowProps extends React.HTMLAttributes<HTMLDivElement> {
  solar?: FlowNode;
  battery?: BatteryNode;
  grid?: GridNode;
  home?: FlowNode;
}

/**
 * The signature live energy-flow diagram: a central hub linking Solar, Battery,
 * Grid and Home with animated directional power lines. Requires Lucide loaded
 * on the page (icons render via data-lucide).
 */
export function EnergyFlow(props: EnergyFlowProps): JSX.Element;
