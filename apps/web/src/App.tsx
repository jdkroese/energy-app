import { useEffect, useState } from 'react';
import { getJSON } from './lib/api';

type Live = {
  time: string;
  sonnen: Record<string, unknown> & { error?: string };
  tesla: Record<string, unknown> & { error?: string };
};

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function Tile(props: { label: string; value: string; accent?: string; sub?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-surface p-5">
      <div className="text-xs uppercase tracking-wide text-muted">{props.label}</div>
      <div className="mt-2 text-3xl font-semibold" style={{ color: props.accent }}>
        {props.value}
      </div>
      {props.sub && <div className="mt-1 text-sm text-muted">{props.sub}</div>}
    </div>
  );
}

export default function App() {
  const [live, setLive] = useState<Live | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const d = await getJSON<Live>('/api/live');
        if (!alive) return;
        setLive(d);
        setOk(true);
        setErr(null);
      } catch (e) {
        if (!alive) return;
        setOk(false);
        setErr((e as Error).message);
      }
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const sonnenSoc = num(live?.sonnen?.USOC);
  const teslaSoc = num(live?.tesla?.percentage_charged);
  const solarW = num(live?.tesla?.solar_power);
  const gridW = num(live?.tesla?.grid_power);
  const loadW = num(live?.tesla?.load_power);
  const kw = (w: number | null) => (w == null ? '—' : `${(w / 1000).toFixed(2)} kW`);

  return (
    <div className="mx-auto max-w-5xl p-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Energy — the boss</h1>
          <p className="text-sm text-muted">Jávea · Sonnen + 2× Powerwall 3 + solar</p>
        </div>
        <span
          className="rounded-full border px-3 py-1 text-sm"
          style={{
            color: ok ? 'var(--color-ok)' : 'var(--color-grid)',
            borderColor: ok ? 'var(--color-ok)' : 'var(--color-grid)',
          }}
        >
          {ok ? '● live' : '● offline'}
        </span>
      </header>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        <Tile label="Solar" value={kw(solarW)} accent="var(--color-solar)" />
        <Tile label="House load" value={kw(loadW)} accent="var(--color-text)" />
        <Tile
          label="Grid"
          value={kw(gridW)}
          accent="var(--color-grid)"
          sub={gridW == null ? undefined : gridW >= 0 ? 'importing' : 'exporting'}
        />
        <Tile
          label="Sonnen SoC"
          value={sonnenSoc == null ? '—' : `${sonnenSoc}%`}
          accent="var(--color-battery)"
        />
        <Tile
          label="Tesla SoC"
          value={teslaSoc == null ? '—' : `${Math.round(teslaSoc)}%`}
          accent="var(--color-battery)"
        />
        <Tile
          label="Updated"
          value={live ? new Date(live.time).toLocaleTimeString() : '—'}
          accent="var(--color-muted)"
        />
      </div>

      {(live?.sonnen?.error || live?.tesla?.error || err) && (
        <div className="mt-6 rounded-xl border border-border bg-surface-2 p-4 text-sm text-muted">
          {err && <div>API: {err}</div>}
          {live?.sonnen?.error && <div>Sonnen: {live.sonnen.error}</div>}
          {live?.tesla?.error && <div>Tesla: {live.tesla.error}</div>}
        </div>
      )}

      <p className="mt-8 text-xs text-muted">
        Scaffold dashboard — MVP shell. Full power-flow diagram &amp; pages per
        docs/08-design-brief.md.
      </p>
    </div>
  );
}
