import { useEffect } from 'react';
import { api } from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import { Icon } from '../ui';
import { VoltageHistoryChart } from './VoltageHistoryChart';

/* ============================================================================
 * VoltageHistoryOverlay — the 48h grid-voltage chart modal opened from the Live
 * "Grid voltage" tile. Desktop = centered modal; mobile = bottom sheet (mirrors
 * EditRuleOverlay). Owns its own slow poll of /api/voltage/history. Escape /
 * backdrop close. Rendered in both viewports via GridVoltageStat.
 * ==========================================================================*/

export function VoltageHistoryOverlay({ wide, onClose }: { wide: boolean; onClose: () => void }) {
  const { data, loading } = usePolling(api.voltageHistory, 60_000);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

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
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(0,0,0,.5)',
        backdropFilter: 'blur(3px)',
        display: 'flex',
        alignItems: wide ? 'flex-start' : 'flex-end',
        justifyContent: 'center',
        overflowY: 'auto',
        animation: 'vhFade .16s ease',
      }}
    >
      <style>{`@keyframes vhFade { from { opacity: 0 } to { opacity: 1 } } @keyframes vhRise { from { transform: translateY(14px); opacity: .7 } to { transform: translateY(0); opacity: 1 } }`}</style>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="48-hour grid voltage history"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 620,
          margin: wide ? '6vh 12px 6vh' : 0,
          background: 'var(--surface-1, #14181d)',
          border: '1px solid var(--border-2)',
          borderRadius: wide ? 18 : '18px 18px 0 0',
          boxShadow: '0 -8px 40px rgba(0,0,0,.5)',
          animation: 'vhRise .2s cubic-bezier(.2,.7,.3,1)',
        }}
      >
        {!wide && <div style={{ width: 38, height: 4, borderRadius: 999, background: 'var(--border-3)', margin: '10px auto 2px' }} />}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: wide ? '18px 22px 22px' : '6px 16px 18px' }}>
          {/* header */}
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 8,
                  display: 'grid',
                  placeItems: 'center',
                  background: 'var(--grid-wash)',
                  color: 'var(--grid)',
                  flex: 'none',
                }}
              >
                <Icon name="activity" size={16} />
              </span>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-1)' }}>Grid voltage · 48h</div>
                <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 2 }}>
                  {breakerName ? `${breakerName} · ` : ''}5-min samples · band {band.minV}–{band.maxV} V
                </div>
              </div>
            </div>
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              style={{
                display: 'grid',
                placeItems: 'center',
                width: 32,
                height: 32,
                flex: 'none',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border-2)',
                background: 'var(--surface-2)',
                color: 'var(--text-2)',
                cursor: 'pointer',
              }}
            >
              <Icon name="x" size={16} />
            </button>
          </div>

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
      </div>
    </div>
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
