import { api } from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import { Modal } from '../ui';
import { VoltageHistoryChart } from './VoltageHistoryChart';

/* ============================================================================
 * VoltageHistoryOverlay — the 48h grid-voltage chart modal opened from the Live
 * "Grid voltage" tile. Desktop = centered modal; mobile = bottom sheet. Built on
 * the shared <Modal> primitive (Track C) — Escape / backdrop close, focus trap,
 * single z-index, motion-token fade+rise. Owns its own slow poll of
 * /api/voltage/history. Rendered in both viewports via GridVoltageStat.
 * ==========================================================================*/

export function VoltageHistoryOverlay({ wide, onClose }: { wide: boolean; onClose: () => void }) {
  const { data, loading } = usePolling(api.voltageHistory, 60_000);

  const band = data?.band ?? { minV: 190, maxV: 240 };
  const samples = data?.samples ?? [];
  const breakerName = data?.breaker?.name ?? null;

  // Summary stats over the window (current = latest sample).
  const vals = samples.map((s) => s.voltageV);
  const current = vals.length ? vals[vals.length - 1] : null;
  const min = vals.length ? Math.min(...vals) : null;
  const max = vals.length ? Math.max(...vals) : null;
  const avg = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;

  return (
    <Modal
      open
      onClose={onClose}
      placement="sheet"
      wideViewport={wide}
      tone="grid"
      icon="activity"
      title="Grid voltage · 48h"
      subtitle={`${breakerName ? `${breakerName} · ` : ''}5-min samples · band ${band.minV}–${band.maxV} V`}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: wide ? '18px 22px 22px' : '14px 16px 18px' }}>
        {/* summary stats */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8 }}>
          <Stat label="Current" value={current} accent="var(--grid)" band={band} />
          <Stat label="Min" value={min} band={band} />
          <Stat label="Max" value={max} band={band} />
          <Stat label="Avg" value={avg} band={band} />
        </div>

        {/* chart */}
        <VoltageHistoryChart samples={samples} band={band} height={wide ? 220 : 190} />

        {loading && samples.length === 0 && (
          <div style={{ fontSize: 11.5, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div>
        )}
      </div>
    </Modal>
  );
}

function Stat({
  label,
  value,
  accent,
  band,
}: {
  label: string;
  value: number | null;
  accent?: string;
  band: { minV: number; maxV: number };
}) {
  const bad = value != null && (value < band.minV || value > band.maxV);
  const color = bad ? 'var(--danger)' : accent ?? 'var(--text-1)';
  return (
    <div
      style={{
        background: 'var(--surface-2)',
        border: '1px solid var(--border-1)',
        borderRadius: 'var(--radius-md)',
        padding: '8px 10px',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
      }}
    >
      <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-3)' }}>
        {label}
      </span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 17, fontWeight: 600, color }}>
        {value == null ? '—' : value}
        <span style={{ fontSize: 11, color: 'var(--text-3)', marginLeft: 2 }}>V</span>
      </span>
    </div>
  );
}
