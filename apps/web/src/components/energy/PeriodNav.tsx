import { useEffect, useRef, useState } from 'react';
import { periodLabel, periodOptions } from '../../lib/periods';

/**
 * PeriodNav — Reports "go back in time" control. ◀ / ▶ step the period and the
 * center label opens a picker to jump to any past day/week/month/year (scope
 * follows the selected range). Offset 0 = current period; negative = past.
 */
interface Props {
  range: string;
  offset: number;
  hasPrev: boolean;
  hasNext: boolean;
  onChange: (offset: number) => void;
  desktop?: boolean;
}

function Arrow({ dir }: { dir: 'prev' | 'next' }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      {dir === 'prev' ? <polyline points="15 18 9 12 15 6" /> : <polyline points="9 18 15 12 9 6" />}
    </svg>
  );
}

export function PeriodNav({ range, offset, hasPrev, hasNext, onChange, desktop = false }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const btn = (dir: 'prev' | 'next', disabled: boolean, onClick: () => void) => (
    <button
      type="button"
      aria-label={dir === 'prev' ? 'Previous period' : 'Next period'}
      disabled={disabled}
      onClick={onClick}
      style={{
        width: 30, height: 30, flex: 'none', display: 'grid', placeItems: 'center',
        borderRadius: 8, border: '1px solid var(--border-1)', background: 'var(--surface-2)',
        color: disabled ? 'var(--text-3)' : 'var(--text-1)',
        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.4 : 1, padding: 0,
        transition: 'background .15s, opacity .15s',
      }}
    >
      <Arrow dir={dir} />
    </button>
  );

  const options = periodOptions(range);

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      {btn('prev', !hasPrev, () => hasPrev && onChange(offset - 1))}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 8, height: 30,
          padding: '0 12px', borderRadius: 8, border: '1px solid var(--border-1)',
          background: open ? 'var(--surface-3)' : 'var(--surface-2)', color: 'var(--text-1)',
          cursor: 'pointer', minWidth: desktop ? 168 : 138, justifyContent: 'center',
          transition: 'background .15s',
        }}
      >
        {offset !== 0 && (
          <span style={{ width: 6, height: 6, borderRadius: 3, background: 'var(--grid)', flex: 'none' }} />
        )}
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
          {periodLabel(range, offset)}
        </span>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.6, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .18s' }}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {btn('next', !hasNext, () => hasNext && onChange(offset + 1))}

      {open && (
        <div
          role="listbox"
          style={{
            position: 'absolute', top: 36, left: '50%', transform: 'translateX(-50%)', zIndex: 30,
            minWidth: desktop ? 196 : 168, maxHeight: 264, overflowY: 'auto',
            background: '#060c0e', border: '1px solid rgba(233,245,242,0.14)', borderRadius: 11,
            padding: 5, boxShadow: '0 16px 40px rgba(0,0,0,.6)',
          }}
        >
          {options.map((o) => {
            const sel = o.offset === offset;
            return (
              <button
                key={o.offset}
                type="button"
                role="option"
                aria-selected={sel}
                onClick={() => { onChange(o.offset); setOpen(false); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                  padding: '8px 10px', borderRadius: 7, border: 0, cursor: 'pointer',
                  background: sel ? 'color-mix(in srgb, var(--solar) 14%, transparent)' : 'transparent',
                  color: sel ? 'var(--solar)' : 'var(--text-1)', textAlign: 'left',
                  font: '500 12.5px var(--font-mono)', fontVariantNumeric: 'tabular-nums',
                }}
                onMouseEnter={(e) => { if (!sel) (e.currentTarget.style.background = 'var(--surface-3)'); }}
                onMouseLeave={(e) => { if (!sel) (e.currentTarget.style.background = 'transparent'); }}
              >
                {o.offset === 0 && (
                  <span style={{ fontSize: 9, color: sel ? 'var(--solar)' : 'var(--text-3)', letterSpacing: '.08em' }}>●</span>
                )}
                <span style={{ flex: 1 }}>{o.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
