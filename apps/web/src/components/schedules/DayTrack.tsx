import type { CSSProperties } from 'react';

/* ============================================================================
 * DayTrack — the shared 24h / 30-min timeline bar (matches the look used by the
 * climate ScheduleRuleObject). Pass window spans as [left%, width%]; helper
 * `barsForWindow` builds them from an on/off "HH:MM" pair (wraps past midnight).
 * ==========================================================================*/

// Faint gridline every 30 min (100%/48), stronger every 6h (100%/4).
const TRACK_BG =
  'repeating-linear-gradient(90deg, var(--border-1) 0, var(--border-1) 1px, transparent 1px, transparent calc(100%/48)),' +
  'repeating-linear-gradient(90deg, var(--border-2) 0, var(--border-2) 1px, transparent 1px, transparent calc(100%/4))';

export interface DayBar {
  left: number;
  width: number;
}

function hhmmToMin(s: string): number {
  const [h, m] = (s || '').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** Build bar spans from an on-time (+ optional off-time). No off → a thin marker. */
export function barsForWindow(onTime: string, offTime?: string | null): DayBar[] {
  const a = hhmmToMin(onTime);
  if (!offTime) return [{ left: (a / 1440) * 100, width: 1.5 }];
  const b = hhmmToMin(offTime);
  if (a < b) return [{ left: (a / 1440) * 100, width: ((b - a) / 1440) * 100 }];
  // wraps past midnight (or all-day when equal): evening tail + next-morning head.
  const out: DayBar[] = [];
  if (a < 1440) out.push({ left: (a / 1440) * 100, width: ((1440 - a) / 1440) * 100 });
  if (b > 0) out.push({ left: 0, width: (b / 1440) * 100 });
  return out;
}

export function DayTrack({ bars, dim, axis, title, height = 22, style }: {
  bars: DayBar[];
  dim?: boolean;
  axis?: boolean;
  title?: string;
  height?: number;
  style?: CSSProperties;
}) {
  return (
    <div style={style}>
      <div
        title={title}
        style={{ position: 'relative', height, borderRadius: 5, background: 'var(--surface-1)', backgroundImage: TRACK_BG, border: '1px solid var(--border-1)', overflow: 'hidden', opacity: dim ? 0.4 : 1 }}
      >
        {bars.map((bar, i) => (
          <span
            key={i}
            style={{ position: 'absolute', top: 3, bottom: 3, left: `${bar.left}%`, width: `${Math.max(0.7, bar.width)}%`, borderRadius: 3, background: 'var(--solar)', boxShadow: 'var(--glow-solar-bar)' }}
          />
        ))}
      </div>
      {axis && (
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
          {['00', '06', '12', '18', '24'].map((h) => (
            <span key={h} className="pwr-mono" style={{ fontSize: 9.5, color: 'var(--text-3)' }}>{h}</span>
          ))}
        </div>
      )}
    </div>
  );
}
