import type { ReactNode } from 'react';
import { Icon } from '../ui/Icon';
import { Eyebrow } from '../ui/Eyebrow';

type Props = {
  eyebrow: string;
  title: string;
  actions?: ReactNode;
};

/** TopBar — desktop per-screen header with weather pill + avatar. */
export function TopBar({ eyebrow, title, actions }: Props) {
  return (
    <header style={{ display: 'flex', alignItems: 'center', gap: 20, padding: '18px 28px', borderBottom: '1px solid var(--border-1)' }}>
      <div>
        <Eyebrow>{eyebrow}</Eyebrow>
        <h1 style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-.01em', margin: '2px 0 0' }}>{title}</h1>
      </div>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14 }}>
        {actions}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 12px',
            borderRadius: 'var(--radius-pill)',
            background: 'var(--surface-1)',
            border: '1px solid var(--border-1)',
            fontSize: 13,
            color: 'var(--text-2)',
          }}
        >
          <Icon name="sun" size={16} color="var(--grid)" />
          <span style={{ fontFamily: 'var(--font-mono)' }}>26°</span>
          <span style={{ color: 'var(--text-3)' }}>· Jávea</span>
        </div>
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: '50%',
            background: 'linear-gradient(135deg,var(--solar-dim),var(--battery-dim))',
            display: 'grid',
            placeItems: 'center',
            fontWeight: 700,
            fontSize: 13,
            color: 'var(--text-inverse)',
          }}
        >
          JK
        </div>
      </div>
    </header>
  );
}
