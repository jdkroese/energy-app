import type { ReactNode } from 'react';

/** The green-bolt Power logo, sized for the auth header. */
export function PowerMark({ size = 44 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 44 44" fill="none" aria-label="Power">
      <rect x="1" y="1" width="42" height="42" rx="12" fill="#0F1619" stroke="#2EE6A0" strokeOpacity="0.5" strokeWidth="1.5" />
      <path d="M24.5 9 L14 24.2 h6.4 l-2.9 10.8 L31 19.4 h-6.4 z" fill="#2EE6A0" />
    </svg>
  );
}

/**
 * AuthShell — full-screen dark canvas with a centered ~380px Power card.
 * Used by Login, Setup and Reset. A subtle solar glow sits behind the card.
 */
export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div
      style={{
        minHeight: '100dvh',
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'radial-gradient(120% 80% at 50% -10%, var(--auth-bg-glow), transparent 60%), var(--bg-0)',
        padding: '24px 16px calc(24px + env(safe-area-inset-bottom))',
      }}
    >
      <div style={{ width: '100%', maxWidth: 380, display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, textAlign: 'center' }}>
          <PowerMark />
          <div>
            <h1
              style={{
                fontSize: 22,
                fontWeight: 700,
                letterSpacing: '-.02em',
                color: 'var(--text-1)',
                margin: 0,
              }}
            >
              {title}
            </h1>
            {subtitle && (
              <p style={{ fontSize: 13, color: 'var(--text-2)', margin: '6px 0 0', lineHeight: 1.5 }}>{subtitle}</p>
            )}
          </div>
        </div>

        <div
          style={{
            background: 'var(--surface-card)',
            border: '1px solid var(--border-1)',
            borderRadius: 'var(--radius-card)',
            boxShadow: 'var(--shadow-2), var(--hairline-top)',
            padding: 22,
          }}
        >
          {children}
        </div>

        {footer && (
          <div style={{ textAlign: 'center', fontSize: 12.5, color: 'var(--text-3)' }}>{footer}</div>
        )}
      </div>
    </div>
  );
}

/** A calm inline error banner used inside the auth card. */
export function AuthError({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <div
      role="alert"
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'flex-start',
        fontSize: 12.5,
        color: 'var(--danger)',
        background: 'var(--danger-wash)',
        border: '1px solid var(--border-danger)',
        borderRadius: 'var(--radius-md)',
        padding: '9px 12px',
        lineHeight: 1.45,
      }}
    >
      {children}
    </div>
  );
}

/** A calm inline success / info banner. */
export function AuthNote({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'success' }) {
  const c = tone === 'success' ? 'var(--solar)' : 'var(--battery)';
  const wash = tone === 'success' ? 'var(--solar-wash)' : 'var(--battery-wash)';
  return (
    <div
      style={{
        fontSize: 12.5,
        color: c,
        background: wash,
        border: `1px solid color-mix(in srgb, ${c} 25%, transparent)`,
        borderRadius: 'var(--radius-md)',
        padding: '9px 12px',
        lineHeight: 1.45,
      }}
    >
      {children}
    </div>
  );
}

/** Shared password-strength / match hint row. */
export function HintRow({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: ok ? 'var(--solar)' : 'var(--text-3)' }}>
      <span
        style={{
          width: 14,
          height: 14,
          borderRadius: '50%',
          flex: 'none',
          display: 'grid',
          placeItems: 'center',
          background: ok ? 'var(--solar-wash)' : 'transparent',
          border: ok ? '1px solid transparent' : '1px solid var(--border-2)',
        }}
      >
        {ok && (
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="var(--solar)" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        )}
      </span>
      <span>{children}</span>
    </div>
  );
}
