import React from 'react';

const CSS = `
.pwr-flow{ position:relative; width:100%; aspect-ratio:1.18/1; min-height:240px;
  font-family:var(--font-sans); }
.pwr-flow__svg{ position:absolute; inset:0; width:100%; height:100%; overflow:visible; }
.pwr-flow__base{ stroke:var(--border-2); stroke-width:1.4; fill:none; }
.pwr-flow__line{ fill:none; stroke-width:2.2; stroke-linecap:round;
  stroke-dasharray:5 6; animation:pwr-flow-move 0.9s linear infinite; }
@keyframes pwr-flow-move{ from{ stroke-dashoffset:11; } to{ stroke-dashoffset:0; } }
@media (prefers-reduced-motion: reduce){ .pwr-flow__line{ animation:none; } }

.pwr-flow__node{ position:absolute; transform:translate(-50%,-50%);
  display:flex; flex-direction:column; align-items:center; gap:5px; width:84px; }
.pwr-flow__chip{ display:flex; align-items:center; justify-content:center;
  width:52px; height:52px; border-radius:16px; background:var(--surface-2);
  border:1px solid var(--border-2); color:var(--_c, var(--text-2));
  box-shadow:var(--shadow-1), var(--hairline-top); transition:box-shadow var(--dur) var(--ease-out); }
.pwr-flow__chip svg{ width:22px; height:22px; }
.pwr-flow__node--active .pwr-flow__chip{ border-color:var(--_c);
  box-shadow:0 0 0 1px var(--_c), 0 0 18px color-mix(in srgb, var(--_c) 45%, transparent); }
.pwr-flow__name{ font-size:10px; font-weight:var(--fw-semibold); letter-spacing:0.06em;
  text-transform:uppercase; color:var(--text-2); }
.pwr-flow__kw{ font-family:var(--font-mono); font-variant-numeric:tabular-nums; font-size:13px;
  font-weight:var(--fw-medium); color:var(--_c, var(--text-1)); line-height:1; }
.pwr-flow__kw small{ font-size:9px; color:var(--text-3); }

.pwr-flow__hub{ position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
  width:58px; height:58px; border-radius:50%; display:flex; align-items:center; justify-content:center;
  background:radial-gradient(circle at 50% 35%, var(--surface-3), var(--surface-1));
  border:1px solid var(--border-3); color:var(--accent); box-shadow:var(--glow-soft); }
.pwr-flow__hub svg{ width:24px; height:24px; }
.pwr-flow__hub::after{ content:""; position:absolute; inset:-6px; border-radius:50%;
  border:1px solid rgba(46,230,160,0.25); animation:pwr-hub-ring 2.6s var(--ease-out) infinite; }
@keyframes pwr-hub-ring{ 0%{ transform:scale(0.85); opacity:0.7; } 70%{ transform:scale(1.5); opacity:0; } 100%{ opacity:0; } }
@media (prefers-reduced-motion: reduce){ .pwr-flow__hub::after{ animation:none; } }
`;

let injected = false;
function inject() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.setAttribute('data-pwr', 'flow');
  s.textContent = CSS;
  document.head.appendChild(s);
}

const HUB = { x: 50, y: 50 };
const POS = {
  solar: { x: 50, y: 11 },
  battery: { x: 12, y: 50 },
  grid: { x: 88, y: 50 },
  home: { x: 50, y: 89 },
};
const COLOR = { solar: 'var(--solar)', battery: 'var(--battery)', grid: 'var(--grid)', home: 'var(--home)' };
const ICON = { solar: 'sun', battery: 'battery-charging', grid: 'utility-pole', home: 'house' };

const Ico = ({ name }) => <i data-lucide={name}></i>;

function fmt(kw) {
  if (kw == null) return '0';
  const v = Math.abs(kw);
  return v >= 10 ? v.toFixed(0) : v.toFixed(1);
}

/**
 * EnergyFlow — the signature live diagram. A central hub links Solar, Battery,
 * Grid and Home; power animates along each line in its real direction. Pass per-
 * node { kw, dir } where dir decides which way the flow travels (and if it's live).
 */
export function EnergyFlow({
  solar = { kw: 0 },
  battery = { kw: 0, dir: 'idle' },
  grid = { kw: 0, dir: 'idle' },
  home = { kw: 0 },
  className = '',
  ...rest
}) {
  inject();

  // For each node: is it active, and which way does flow travel along the
  // hub<->node segment. We draw the animated line from source to destination.
  const links = [];
  const data = { solar, battery, grid, home };

  // solar always flows INTO the hub when producing
  if ((solar.kw || 0) > 0.05) links.push(seg('solar', POS.solar, HUB));
  // home always draws FROM the hub when consuming
  if ((home.kw || 0) > 0.05) links.push(seg('home', HUB, POS.home));
  // battery: charging = hub->battery, discharging = battery->hub
  if (battery.dir === 'charging' && (battery.kw || 0) > 0.05) links.push(seg('battery', HUB, POS.battery));
  if (battery.dir === 'discharging' && (battery.kw || 0) > 0.05) links.push(seg('battery', POS.battery, HUB));
  // grid: importing = grid->hub, exporting = hub->grid
  if (grid.dir === 'importing' && (grid.kw || 0) > 0.05) links.push(seg('grid', POS.grid, HUB));
  if (grid.dir === 'exporting' && (grid.kw || 0) > 0.05) links.push(seg('grid', HUB, POS.grid));

  function seg(key, from, to) {
    return { key, d: `M${from.x} ${from.y} L${to.x} ${to.y}`, color: COLOR[key] };
  }

  const activeKeys = new Set(links.map((l) => l.key));

  const subLabel = {
    solar: 'Producing',
    home: 'Home load',
    battery: battery.dir === 'charging' ? 'Charging' : battery.dir === 'discharging' ? 'Discharging' : 'Idle',
    grid: grid.dir === 'importing' ? 'Importing' : grid.dir === 'exporting' ? 'Exporting' : 'Idle',
  };

  React.useEffect(() => {
    if (window.lucide) window.lucide.createIcons();
  });

  return (
    <div className={['pwr-flow', className].filter(Boolean).join(' ')} {...rest}>
      <svg className="pwr-flow__svg" viewBox="0 0 100 100" preserveAspectRatio="none">
        {/* base connectors */}
        {Object.keys(POS).map((k) => (
          <line key={k} className="pwr-flow__base"
            x1={HUB.x} y1={HUB.y} x2={POS[k].x} y2={POS[k].y} />
        ))}
        {/* animated flows */}
        {links.map((l) => (
          <path key={l.key} className="pwr-flow__line" d={l.d} style={{ stroke: l.color }} />
        ))}
      </svg>

      {Object.keys(POS).map((k) => {
        const active = activeKeys.has(k);
        return (
          <div key={k} className={`pwr-flow__node${active ? ' pwr-flow__node--active' : ''}`}
            style={{ left: POS[k].x + '%', top: POS[k].y + '%', '--_c': COLOR[k] }}>
            <div className="pwr-flow__chip"><Ico name={ICON[k]} /></div>
            <span className="pwr-flow__name">{k}</span>
            <span className="pwr-flow__kw">{fmt(data[k].kw)}<small> kW</small></span>
          </div>
        );
      })}

      <div className="pwr-flow__hub" title="Home hub">
        <Ico name="zap" />
      </div>
    </div>
  );
}
