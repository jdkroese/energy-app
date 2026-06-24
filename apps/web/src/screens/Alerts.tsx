import { useEffect, useState, type CSSProperties } from 'react';
import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import { MOCK_ALERTS } from '../lib/mock';
import type { Alert, AlertsResponse, AlertSeverity, AlertStatus, ChannelType } from '../lib/types';
import { Card, Switch, Icon, Button } from '../components/ui';
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

/** Map the channel's display label to the contract channel type. */
function channelType(type: string): ChannelType | null {
  const t = type.toLowerCase();
  if (t.includes('whatsapp')) return 'whatsapp';
  if (t.includes('push')) return 'push';
  if (t.includes('email')) return 'email';
  return null;
}

export function Alerts() {
  const { data, loading, stale, updatedAt, refetch } = usePolling<AlertsResponse>(api.alerts, 30_000);
  const fetched = data || (loading ? null : MOCK_ALERTS) || MOCK_ALERTS;

  // local mirror so optimistic toggles/actions persist across polls
  const [local, setLocal] = useState<AlertsResponse | null>(null);
  useEffect(() => {
    if (data) setLocal(data);
  }, [data]);
  const a = local || fetched;

  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const active = a.alerts.filter((x) => x.status !== 'resolved').length;

  const patch = (next: AlertsResponse) => setLocal(next);

  const toggleChannel = async (label: string, enabled: boolean) => {
    const ct = channelType(label);
    const prev = a;
    patch({ ...a, channels: a.channels.map((c) => (c.type === label ? { ...c, enabled } : c)) });
    if (!ct) return;
    try {
      await api.setChannel(ct, enabled);
    } catch {
      patch(prev); // revert
    }
  };

  const toggleRule = async (id: string, enabled: boolean) => {
    const prev = a;
    patch({ ...a, rules: a.rules.map((r) => (r.id === id ? { ...r, enabled } : r)) });
    try {
      await api.setRule(id, enabled);
    } catch {
      patch(prev);
    }
  };

  const act = async (al: Alert, kind: 'ack' | 'resolve') => {
    setBusy(al.id + kind);
    const prev = a;
    const nextStatus: AlertStatus = kind === 'ack' ? 'ack' : 'resolved';
    patch({ ...a, alerts: a.alerts.map((x) => (x.id === al.id ? { ...x, status: nextStatus } : x)) });
    setExpanded(null);
    try {
      if (kind === 'ack') await api.ackAlert(al.id);
      else await api.resolveAlert(al.id);
      refetch();
    } catch {
      patch(prev);
    } finally {
      setBusy(null);
    }
  };

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
          {a.alerts.map((al, i) => {
            const actionable = al.status !== 'resolved';
            const open = expanded === al.id;
            return (
              <div key={al.id} style={{ borderTop: i ? '1px solid var(--border-1)' : 'none', opacity: al.status === 'resolved' ? 0.6 : 1 }}>
                <div
                  style={{ ...row, cursor: actionable ? 'pointer' : 'default' }}
                  onClick={() => actionable && setExpanded(open ? null : al.id)}
                >
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
                {actionable && open && (
                  <div style={{ display: 'flex', gap: 8, padding: '0 16px 14px 62px' }}>
                    {al.status === 'new' && (
                      <Button size="sm" variant="secondary" loading={busy === al.id + 'ack'} iconLeft={<Icon name="eye" />} onClick={() => void act(al, 'ack')}>
                        Acknowledge
                      </Button>
                    )}
                    <Button size="sm" variant="primary" loading={busy === al.id + 'resolve'} iconLeft={<Icon name="check" />} onClick={() => void act(al, 'resolve')}>
                      Resolve
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
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
              <Switch checked={c.enabled} onChange={(e) => void toggleChannel(c.type, e.target.checked)} />
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
              <Switch checked={r.enabled} onChange={(e) => void toggleRule(r.id, e.target.checked)} />
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
