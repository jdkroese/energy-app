import { useState } from 'react';
import { Card, StatTile, Eyebrow, Icon } from '../ui';
import type { LiveResponse, BatteriesResponse, InvertersResponse } from '../../lib/types';

/* Live load & flow — power strip (docs/36 §5.3a). KPI tiles from /api/live:
 * Solar (+ per-inverter/array split on tap), Home, Grid (tone by dir), Battery
 * (combined SoC + flow), Self-sufficiency, Tariff. Mono numerals via StatTile.
 *
 * Battery SoC comes from /api/batteries (`combined.soc`) when available — the
 * /api/live snapshot reports soc 0 whenever a battery's read misses that tick,
 * which showed a bogus "SoC 0%". Batteries is the authoritative source. */

function liveCombinedSoc(live: LiveResponse): number {
  // Weighted by usable capacity (mirrors Automations.batterySoc: Sonnen 9.2, Tesla 27).
  return Math.round((live.sonnen.soc * 9.2 + live.tesla.soc * 27) / (9.2 + 27));
}

export function LiveLoadStrip({
  live,
  wide,
  batteries,
  inverters,
}: {
  live: LiveResponse;
  wide: boolean;
  batteries?: BatteriesResponse | null;
  inverters?: InvertersResponse | null;
}) {
  const [showArrays, setShowArrays] = useState(false);
  const solar = live.solar.kw;
  const arrays = live.solar.arrays ?? [];
  // Per-inverter live production (Sungrow ×2) — the "where are the inverters" split.
  const invUnits = inverters?.inverters ?? [];
  const expandable = invUnits.length > 0 || arrays.length > 0;
  const grid = live.grid;
  const gridImporting = grid.dir === 'importing';
  const gridTone = grid.dir === 'exporting' ? 'solar' : gridImporting ? 'grid' : 'neutral';
  // Prefer the authoritative battery SoC + flow from /api/batteries; fall back to
  // the live snapshot only when batteries hasn't loaded.
  const soc = batteries ? Math.round(batteries.combined.soc) : liveCombinedSoc(live);
  const batKw = batteries
    ? Math.round(batteries.batteries.reduce((s, b) => s + (b.power?.kw ?? 0), 0) * 10) / 10
    : Math.round((live.sonnen.kw + live.tesla.kw) * 10) / 10;
  const batCharging = batteries
    ? batteries.batteries.some((b) => b.power?.dir === 'charging')
    : live.sonnen.dir === 'charging' || live.tesla.dir === 'charging';

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
        <div style={{ cursor: expandable ? 'pointer' : 'default' }} onClick={() => expandable && setShowArrays((v) => !v)}>
          <StatTile
            label="Solar"
            value={solar.toFixed(1)}
            unit="kW"
            tone="solar"
            icon={<Icon name="sun" size={15} />}
            footnote={
              expandable
                ? showArrays
                  ? 'tap to hide'
                  : invUnits.length > 0
                    ? `${invUnits.length} inverters`
                    : `${arrays.length} arrays`
                : undefined
            }
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
      {showArrays && expandable && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {/* Per-inverter live production + today (Sungrow ×2) when onboarded. */}
          {invUnits.map((inv) => (
            <span
              key={inv.id}
              className="pwr-mono"
              title={`${inv.model} · ${inv.status}${inv.dailyKwh != null ? ` · ${inv.dailyKwh.toFixed(1)} kWh today` : ''}`}
              style={{
                fontSize: 11.5,
                background: inv.status === 'offline' ? 'var(--danger-wash)' : 'var(--solar-wash)',
                color: inv.status === 'offline' ? 'var(--danger)' : 'var(--solar)',
                borderRadius: 8,
                padding: '5px 10px',
              }}
            >
              {inv.name} · {inv.kw.toFixed(1)} kW
              {inv.status !== 'online' ? ` · ${inv.status}` : inv.dailyKwh != null ? ` · ${inv.dailyKwh.toFixed(1)} kWh` : ''}
            </span>
          ))}
          {/* Fall back to array split (Array A/B proxy) when no inverter units. */}
          {invUnits.length === 0 &&
            arrays.map((a) => (
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
