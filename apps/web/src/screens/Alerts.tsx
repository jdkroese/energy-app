import type { CSSProperties } from 'react';
import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import { MOCK_ALERTS } from '../lib/mock';
import type { AlertsResponse, AlertSeverity, AlertStatus } from '../lib/types';
import { Card, Switch, Icon } from '../components/ui';
import { MobileHeader, StaleBanner } from './_shared';

const COL: Record<AlertSeverity, string> = { danger: 'var(--danger)', warning: 'var(--grid)', info: 'var(--battery)', ok: 'var(--solar)' };
const WASH: Record<AlertSeverity, string> = { danger: 'var(--danger-wash)', warning: 'var(--grid-wash)', info: 'var(--battery-wash)', ok: 'var(--solar-wash)' };
const STATUS_LABEL: Record<AlertStatus, string> = { new: 'New', ack: 'Ack', resolved: 'Resolved' };

function StatusPill({ s }: { s: AlertStatus }) {
  const map: Record<AlertStatus, { c: string; b: string }> = {
    new: { c: 'var(--danger)', b: 'var(--danger-wash)' },
    ack: { c: 'var(--battery)', b: 'var(--battery-wash)' },
    resolved: { c: 'var(--text-3)', b: 'transparent' },
  };
  const m = map[s];
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 600,
        color: m.c,
        background: m.b,
        padding: '3px 8px',
        borderRadius: 999,
        border: s === 'resolved' ? '1px solid var(--border-2)' : 'none',
      }}
    >
      {STATUS_LABEL[s]}
    </span>
  );
}

const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px' };

export function Alerts() {
  const { data, loading, stale, updatedAt } = usePolling<AlertsResponse>(api.alerts, 30_000);
  const a = data || (loading ? null : MOCK_ALERTS) || MOCK_ALERTS;
  const active = a.alerts.filter((x) => x.status !== 'resolved').length;

  return (
    <>
      <MobileHeader
        eyebrow="Alerts"
        title="Notifications"
        right={
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--danger)', background: 'var(--danger-wash)', padding: '5px 11px', borderRadius: 999 }}>
            {active} active
          </span>
        }
      />
      {stale && <StaleBanner updatedAt={updatedAt} />}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '8px 14px 22px', maxWidth: 760, margin: '0 auto', width: '100%' }}>
        {/* feed */}
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          {a.alerts.map((al, i) => (
            <div key={al.id} style={{ ...row, borderTop: i ? '1px solid var(--border-1)' : 'none', opacity: al.status === 'resolved' ? 0.6 : 1 }}>
              <span style={{ width: 34, height: 34, borderRadius: 10, display: 'grid', placeItems: 'center', flex: 'none', background: WASH[al.severity], color: COL[al.severity] }}>
                <Icon name={al.icon} size={17} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 500, lineHeight: 1.25 }}>{al.title}</div>
                <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 2 }}>{al.sub}</div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5 }}>
                <StatusPill s={al.status} />
                <span style={{ fontSize: 10.5, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>{al.ts}</span>
              </div>
            </div>
          ))}
        </Card>

        {/* channels */}
        <Card title="Notify via" style={{ padding: 0 }}>
          {a.channels.map((c, i) => (
            <div key={c.type} style={{ ...row, borderTop: i ? '1px solid var(--border-1)' : 'none' }}>
              <span style={{ width: 34, height: 34, borderRadius: 10, display: 'grid', placeItems: 'center', flex: 'none', background: 'var(--surface-3)', color: c.enabled ? 'var(--solar)' : 'var(--text-3)' }}>
                <Icon name={chanIcon(c.type)} size={17} />
              </span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14 }}>{c.type}</div>
                <div style={{ fontSize: 12, color: 'var(--text-2)', fontFamily: 'var(--font-mono)' }}>{c.detail}</div>
              </div>
              <Switch defaultChecked={c.enabled} />
            </div>
          ))}
        </Card>

        {/* rules */}
        <Card title="Alert rules" style={{ padding: 0 }}>
          {a.rules.map((r) => (
            <div key={r.id} style={{ ...row, borderTop: '1px solid var(--border-1)' }}>
              <span style={{ color: 'var(--text-2)' }}>
                <Icon name={r.icon} size={17} />
              </span>
              <span style={{ flex: 1, fontSize: 14 }}>{r.label}</span>
              <Switch defaultChecked={r.enabled} />
            </div>
          ))}
        </Card>
      </div>
    </>
  );
}

function chanIcon(type: string): string {
  const t = type.toLowerCase();
  if (t.includes('whatsapp')) return 'message-circle';
  if (t.includes('push')) return 'bell';
  if (t.includes('email')) return 'mail';
  return 'bell';
}
