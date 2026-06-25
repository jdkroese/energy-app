import { useEffect } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { Icon } from '../ui/Icon';
import { Eyebrow } from '../ui/Eyebrow';
import { MOBILE_MORE } from './nav';
import { useAuth } from '../../auth/AuthProvider';

/**
 * MoreMenu — mobile overflow sheet opened from the bottom bar's "More" tab.
 * Lists every destination that isn't a primary tab (Devices, Scenarios,
 * Autopilot, Schedules, Automations, Settings) plus account status + sign out,
 * so the whole app is reachable on iPhone.
 */
export function MoreMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
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
  }, [open, onClose]);

  if (!open) return null;

  const signOut = async () => {
    onClose();
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(0,0,0,.6)',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
        animation: 'mmFade .18s ease',
      }}
    >
      <style>{`
        @keyframes mmFade { from { opacity: 0 } to { opacity: 1 } }
        @keyframes mmRise { from { transform: translateY(22px); opacity: .5 } to { transform: translateY(0); opacity: 1 } }
      `}</style>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="More"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg-1, #0F1619)',
          borderTop: '1px solid var(--border-2)',
          borderTopLeftRadius: 18,
          borderTopRightRadius: 18,
          padding: '8px 12px calc(14px + env(safe-area-inset-bottom))',
          animation: 'mmRise .22s cubic-bezier(.2,.7,.3,1)',
          maxHeight: '82vh',
          overflowY: 'auto',
        }}
      >
        <div style={{ width: 38, height: 4, borderRadius: 99, background: 'var(--border-2)', margin: '4px auto 12px' }} />
        <div style={{ padding: '0 6px 8px' }}>
          <Eyebrow>More</Eyebrow>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {MOBILE_MORE.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/'}
              onClick={onClose}
              style={({ isActive }) => ({
                display: 'flex',
                alignItems: 'center',
                gap: 11,
                textDecoration: 'none',
                padding: '14px 14px',
                borderRadius: 12,
                border: `1px solid ${isActive ? 'var(--solar)' : 'var(--border-1)'}`,
                background: isActive ? 'var(--solar-wash)' : 'var(--surface-1)',
                color: isActive ? 'var(--solar)' : 'var(--text-1)',
              })}
            >
              <Icon name={n.icon} size={20} />
              <span style={{ fontSize: 14, fontWeight: 500 }}>{n.label}</span>
            </NavLink>
          ))}
        </div>

        <button
          onClick={() => void signOut()}
          style={{
            marginTop: 12,
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 9,
            height: 46,
            borderRadius: 12,
            border: '1px solid var(--border-2)',
            background: 'var(--surface-2)',
            color: 'var(--text-2)',
            fontSize: 14,
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          <Icon name="log-out" size={18} />
          Sign out{user ? ` · ${user.name}` : ''}
        </button>
      </div>
    </div>
  );
}
