import type { CSSProperties, ReactNode } from 'react';
import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import { MOCK_SETTINGS } from '../lib/mock';
import type { SettingsResponse } from '../lib/types';
import { Card, Icon, Eyebrow } from '../components/ui';
import { StaleBanner } from './_shared';

const Chev = () => <Icon name="chevron-right" size={18} color="var(--text-3)" />;
const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px' };

function Dot({ tone }: { tone: string }) {
  return <span style={{ width: 8, height: 8, borderRadius: '50%', background: `var(--${tone})`, boxShadow: `0 0 8px var(--${tone})`, display: 'inline-block' }} />;
}

function LinkRow({
  icon,
  tone,
  name,
  detail,
  right,
  first,
}: {
  icon: string;
  tone?: string;
  name: string;
  detail?: ReactNode;
  right?: ReactNode;
  first?: boolean;
}) {
  return (
    <div style={{ ...row, borderTop: first ? 'none' : '1px solid var(--border-1)' }}>
      <span style={{ width: 34, height: 34, borderRadius: 10, display: 'grid', placeItems: 'center', flex: 'none', background: 'var(--surface-3)', color: tone ? `var(--${tone})` : 'var(--text-2)' }}>
        <Icon name={icon} size={17} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14 }}>{name}</div>
        {detail && <div style={{ fontSize: 12, color: 'var(--text-2)', fontFamily: 'var(--font-mono)' }}>{detail}</div>}
      </div>
      {right}
    </div>
  );
}

export function Settings() {
  const { data, loading, stale, updatedAt } = usePolling<SettingsResponse>(api.settings, 0);
  const s = data || (loading ? null : MOCK_SETTINGS) || MOCK_SETTINGS;

  return (
    <>
      <div style={{ padding: '12px 18px 12px' }}>
        <Eyebrow>Settings</Eyebrow>
        <h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-.02em', margin: '2px 0 0' }}>System</h1>
      </div>
      {stale && <StaleBanner updatedAt={updatedAt} />}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '8px 14px 22px', maxWidth: 760, margin: '0 auto', width: '100%' }}>
        {/* connections */}
        <Card title="Connections" style={{ padding: 0 }}>
          {s.connections.map((c, i) => {
            const ok = !/pending/i.test(c.status);
            return (
              <LinkRow
                key={c.name}
                first={i === 0}
                icon={c.icon}
                tone={c.tone}
                name={c.name}
                right={
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                    <Dot tone={ok ? 'solar' : 'grid'} />
                    <span style={{ fontSize: 12, color: ok ? 'var(--solar)' : 'var(--grid)' }}>{c.status}</span>
                    <Chev />
                  </div>
                }
              />
            );
          })}
        </Card>

        {/* tariff */}
        <Card title="Tariff · Spain 2.0TD" style={{ padding: 0 }}>
          <div style={{ padding: '4px 16px 14px' }}>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              {s.tariff.bands.map((b) => {
                const color = b.band === 'P1' ? 'var(--grid)' : b.band === 'P2' ? 'var(--grid-dim)' : 'var(--solar)';
                return (
                  <div key={b.band} style={{ flex: 1, padding: 10, borderRadius: 10, background: 'var(--surface-2)', textAlign: 'center' }}>
                    <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color }}>{b.band}</div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-2)', marginTop: 3 }}>€{b.rate.toFixed(3)}</div>
                  </div>
                );
              })}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12, fontSize: 12, color: 'var(--text-2)' }}>
              <span>Power term</span>
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-1)' }}>€{s.tariff.powerTermEur.toFixed(2)}/mo · 14 kW</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 12, color: 'var(--text-2)' }}>
              <span>Export (excedentes)</span>
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--grid)' }}>{s.tariff.exportRange}</span>
            </div>
          </div>
          <LinkRow icon="pencil" tone="text-2" name="Edit tariff & rates" right={<Chev />} />
        </Card>

        {/* assets */}
        <Card title="My system" style={{ padding: 0 }}>
          {s.assets.map((a, i) => (
            <LinkRow key={a.name} first={i === 0} icon={a.icon} tone={a.tone} name={a.name} detail={a.detail} right={<Chev />} />
          ))}
        </Card>

        {/* app */}
        <Card title="App" style={{ padding: 0 }}>
          <LinkRow first icon="smartphone-nfc" tone="solar" name="Add to home screen" detail="Install as a full-screen app" right={<Chev />} />
          <LinkRow icon="user" tone="home" name="Joris Kroese" detail="j.kroese@levante.nl" right={<Chev />} />
          <LinkRow icon="moon" tone="battery" name="Theme" detail="Dark (control-room)" right={<Chev />} />
          <LinkRow icon="info" tone="text-2" name="Version" detail="0.1.0 · energy.hirobo.nl" />
        </Card>
      </div>
    </>
  );
}
