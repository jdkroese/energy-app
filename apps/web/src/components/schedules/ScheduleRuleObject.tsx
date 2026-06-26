import type { CSSProperties } from 'react';
import { Icon, Switch } from '../ui';
import type { Schedule } from '../../lib/types';
import { actionSummary, conditionTag, hhmmToMin, windowsSummary } from '../../lib/scheduleRules';

/* ============================================================================
 * ScheduleRuleObject — the reusable rule atom. Identical on the device-detail
 * schedule box and the Schedules page. One-line header (name · action · cond ·
 * edit · switch), seven per-day toggles, and a compact 24h / 30-min track with
 * green window bars. Writes `days` immediately; opens the overlay to edit.
 * ==========================================================================*/

// Display Mon..Sun; store days are 0=Sun..6=Sat.
const DAY_ABBR = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const ROW_TO_STORE = [1, 2, 3, 4, 5, 6, 0];

// Two stacked gridlines: a faint line every 30 min (100%/48), stronger every 6h (100%/4).
const TRACK_BG =
  'repeating-linear-gradient(90deg, var(--border-1) 0, var(--border-1) 1px, transparent 1px, transparent calc(100%/48)),' +
  'repeating-linear-gradient(90deg, var(--border-2) 0, var(--border-2) 1px, transparent 1px, transparent calc(100%/4))';

interface Bar {
  left: number;
  width: number;
}

/** Window spans as [left%, width%], expanding a wrap-past-midnight window into two bars. */
function barsFor(windows: Schedule['windows']): Bar[] {
  const bars: Bar[] = [];
  for (const w of windows) {
    const a = hhmmToMin(w.start);
    const b = hhmmToMin(w.end);
    if (a < b) {
      bars.push({ left: (a / 1440) * 100, width: ((b - a) / 1440) * 100 });
    } else {
      if (a < 1440) bars.push({ left: (a / 1440) * 100, width: ((1440 - a) / 1440) * 100 });
      if (b > 0) bars.push({ left: 0, width: (b / 1440) * 100 });
    }
  }
  return bars;
}

export function ScheduleRuleObject({
  s,
  canConfig,
  busy,
  showAxis = false,
  onToggleEnabled,
  onToggleDay,
  onEdit,
}: {
  s: Schedule;
  canConfig: boolean;
  busy?: boolean;
  showAxis?: boolean;
  onToggleEnabled: (enabled: boolean) => void;
  onToggleDay: (storeDay: number) => void;
  onEdit: () => void;
}) {
  const dim = !s.enabled;
  const tag = conditionTag(s.condition);
  const bars = barsFor(s.windows);
  const tagColor = tag?.tone === 'warm' ? 'var(--grid)' : 'var(--battery)';
  // Blinds: tint the window bars by direction (open = ev/violet, close = muted),
  // so the 24h track reads as "open here / closed here" at a glance.
  const isBlind = s.type === 'blinds';
  const opening = isBlind && (s.action.positionPct ?? 0) >= 50;
  const barColor = isBlind ? (opening ? 'var(--ev)' : 'var(--text-3)') : 'var(--solar)';
  const barGlow = isBlind
    ? opening
      ? '0 0 8px rgba(139,140,255,0.55)'
      : 'none'
    : '0 0 8px rgba(46,230,160,0.55)';

  const dayCell = (on: boolean): CSSProperties => ({
    width: 26,
    height: 24,
    flex: 'none',
    borderRadius: 6,
    display: 'grid',
    placeItems: 'center',
    fontSize: 10.5,
    fontWeight: 600,
    cursor: canConfig ? 'pointer' : 'default',
    background: on ? 'var(--solar)' : 'var(--surface-1)',
    color: on ? '#06090b' : 'var(--text-3)',
    border: `1px solid ${on ? 'transparent' : 'var(--border-1)'}`,
    transition: 'background .12s',
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '11px 0', borderTop: '1px solid var(--border-1)' }}>
      {/* HEADER */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button
          type="button"
          onClick={onEdit}
          title="Edit rule"
          style={{ flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 'none', padding: 0, cursor: 'pointer', opacity: dim ? 0.55 : 1 }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
            <Icon name="pencil" size={11} color="var(--text-3)" />
          </div>
          <div className="pwr-mono" style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {windowsSummary(s.windows)} · <span style={{ color: 'var(--solar-dim)' }}>{actionSummary(s)}</span>
            {tag && <span style={{ color: tagColor }}> · {tag.text}</span>}
          </div>
        </button>
        <button
          type="button"
          aria-label="Edit rule"
          onClick={onEdit}
          style={{ display: 'grid', placeItems: 'center', width: 30, height: 30, flex: 'none', borderRadius: 8, border: '1px solid var(--border-2)', background: 'var(--surface-2)', color: 'var(--text-2)', cursor: 'pointer' }}
        >
          <Icon name="sliders-horizontal" size={14} />
        </button>
        <Switch checked={s.enabled} disabled={!canConfig || busy} onChange={(e) => onToggleEnabled(e.target.checked)} />
      </div>

      {/* PER-DAY TOGGLES */}
      <div style={{ display: 'flex', gap: 5 }}>
        {DAY_ABBR.map((l, row) => {
          const store = ROW_TO_STORE[row];
          const on = s.days.includes(store);
          return (
            <button key={row} type="button" disabled={!canConfig || busy} aria-pressed={on} aria-label={`Toggle ${l}`} onClick={() => onToggleDay(store)} style={dayCell(on)}>
              {l}
            </button>
          );
        })}
      </div>

      {/* 24H / 30-MIN TRACK */}
      <div style={{ position: 'relative', height: 22, borderRadius: 5, background: 'var(--surface-1)', backgroundImage: TRACK_BG, border: '1px solid var(--border-1)', overflow: 'hidden', opacity: dim ? 0.4 : 1 }}>
        {bars.map((bar, i) => (
          <span
            key={i}
            title={windowsSummary(s.windows)}
            style={{
              position: 'absolute',
              top: 3,
              bottom: 3,
              left: `${bar.left}%`,
              width: `${Math.max(0.7, bar.width)}%`,
              borderRadius: 3,
              background: barColor,
              boxShadow: barGlow,
            }}
          />
        ))}
      </div>

      {showAxis && (
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          {['00', '06', '12', '18', '24'].map((h) => (
            <span key={h} className="pwr-mono" style={{ fontSize: 9.5, color: 'var(--text-3)' }}>{h}</span>
          ))}
        </div>
      )}
    </div>
  );
}
