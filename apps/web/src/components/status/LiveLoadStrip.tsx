import { useState } from 'react';
import { Card, StatTile, Eyebrow, Icon } from '../ui';
import type { LiveResponse } from '../../lib/types';

/* Live load & flow — power strip (docs/36 §5.3a). KPI tiles from /api/live:
 * Solar (+ per-array split on tap), Home, Grid (tone by dir), Battery (combined
 * SoC + flow), Self-sufficiency, Tariff. Mono numerals via StatTile. */

function combinedSoc(live: LiveResponse): number {
  // Weighted by usable capacity (mirrors Automations.batterySoc: Sonnen 9.2, Tesla 27).
  return Math.round((live.sonnen.soc * 9.2 + live.tesla.soc * 27) / (9.2 + 27));
}

export function LiveLoadStrip({ live, wide }: { live: LiveResponse; wide: boolean }) {
  const [showArrays, setShowArrays] = useState(false);
  const solar = live.solar.kw;
  const arrays = live.solar.arrays ?? [];
  const grid = live.grid;
  const gridImporting = grid.dir === 'importing';
  const gridTone = grid.dir === 'exporting' ? 'solar' : gridImporting ? 'grid' : 'neutral';
  const soc = combinedSoc(live);
  const batKw = Math.round((live.sonnen.kw + live.tesla.kw) * 10) / 10;
  const batCharging = live.sonnen.dir === 'charging' || live.tesla.dir === 'charging';

  return (
    <Card padded style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <Eyebrow>Live load &amp; flow</Eyebrow>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: wide ? 'repeat(6, 1fr)' : 'repeat(2, 1fr)',
          gap: 8,
        }}
      >
        <div style={{ cursor: arrays.length ? 'pointer' : 'default' }} onClick={() => arrays.length && setShowArrays((v) => !v)}>
          <StatTile
            label="Solar"
            value={solar.toFixed(1)}
            unit="kW"
            tone="solar"
            icon={<Icon name="sun" size={15} />}
            footnote={arrays.length ? (showArrays ? 'tap to hide arrays' : `${arrays.length} arrays`) : undefined}
          />
        </div>
        <StatTile label="Home" value={live.home.kw.toFixed(1)} unit="kW" tone="home" icon={<Icon name="house" size={15} />} />
        <StatTile
          label={grid.dir === 'exporting' ? 'Grid export' : grid.dir === 'importing' ? 'Grid import' : 'Grid'}
          value={grid.kw.toFixed(1)}
          unit="kW"
          tone={gridTone}
          icon={<Icon name={grid.dir === 'exporting' ? 'upload' : 'download'} size={15} />}
        />
        <StatTile
          label="Battery"
          value={`${batKw >= 0 ? '' : ''}${batKw.toFixed(1)}`}
          unit="kW"
          tone="battery"
          icon={<Icon name={batCharging ? 'battery-charging' : 'battery'} size={15} />}
          footnote={`SoC ${soc}%`}
        />
        <StatTile
          label="Self-sufficiency"
          value={Math.round(live.today.selfSufficiencyPct).toString()}
          unit="%"
          tone="solar"
          icon={<Icon name="leaf" size={15} />}
        />
        <StatTile
          label="Tariff"
          value={live.tariff.band}
          tone={live.tariff.band === 'P1' ? 'grid' : 'neutral'}
          icon={<Icon name="euro" size={15} />}
          footnote={`€${live.tariff.rateEur.toFixed(3)}/kWh`}
        />
      </div>
      {showArrays && arrays.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {arrays.map((a) => (
            <span
              key={a.name}
              className="pwr-mono"
              style={{ fontSize: 11.5, background: 'var(--solar-wash)', color: 'var(--solar)', borderRadius: 8, padding: '5px 10px' }}
            >
              {a.name} · {a.kw.toFixed(1)} kW
            </span>
          ))}
        </div>
      )}
    </Card>
  );
}
