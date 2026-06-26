import { useEffect, useState, type CSSProperties } from 'react';
import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import { MOCK_ALERTS } from '../lib/mock';
import type { Alert, AlertsResponse, AlertSeverity, AlertStatus } from '../lib/types';
import { Card, Switch, Icon, Button } from './ui';

/* ============================================================================
 * Notifications — the alert feed (recent notifications) and the alert-rule
 * toggles, extracted from the old standalone /alerts screen. The feed renders as
 * a widget on the Live page; the rules render in Settings → Notifications (next to
 * the channels). Both are self-contained: they poll the alerts API and mirror it
 * locally for optimistic toggles/actions.
 * ==========================================================================*/

const COL: Record<AlertSeverity, string> = { danger: 'var(--danger)', warning: 'var(--grid)', info: 'var(--battery)', ok: 'var(--solar)' };
const WASH: Record<AlertSeverity, string> = { danger: 'var(--danger-wash)', warning: 'var(--grid-wash)', info: 'var(--battery-wash)', ok: 'var(--solar-wash)' };
const STATUS_LABEL: Record<AlertStatus, string> = { new: 'New', ack: 'Ack', resolved: 'Resolved' };

const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px' };

function StatusPill({ s }: { s: AlertStatus }) {
  const map: Record<AlertStatus, { c: string; b: string }> = {
    new: { c: 'var(--danger)', b: 'var(--danger-wash)' },
    ack: { c: 'var(--battery)', b: 'var(--battery-wash)' },
    resolved: { c: 'var(--text-3)', b: 'transparent' },
  };
  const m = map[s];
  return (
    <span style={{ fontSize: 10, fontWeight: 600, color: m.c, background: m.b, padding: '3px 8px', borderRadius: 999, border: s === 'resolved' ? '1px solid var(--border-2)' : 'none' }}>
      {STATUS_LABEL[s]}
    </span>
  );
}

/** ISO → short relative time; non-date strings (offline mock) shown verbatim. */
function fmtAlertTime(ts: string): string {
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return ts;
  const diff = Date.now() - t;
  if (diff < 0) return 'just now';
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d}d ago`;
}

/** Shared alerts source — polls the API, keeps a local mirror for optimistic edits. */
function useAlerts() {
  const { data, loading, refetch } = usePolling<AlertsResponse>(api.alerts, 30_000);
  const fetched = data || (loading ? null : MOCK_ALERTS) || MOCK_ALERTS;
  const [local, setLocal] = useState<AlertsResponse | null>(null);
  useEffect(() => { if (data) setLocal(data); }, [data]);
  return { a: local || fetched, setLocal, refetch };
}

/** Recent-notifications feed widget for the Live page (acknowledge / resolve inline). */
export function NotificationsWidget({ limit = 6 }: { limit?: number }) {
  const { a, setLocal, refetch } = useAlerts();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const active = a.alerts.filter((x) => x.status !== 'resolved').length;
  // Active first, then most-recent resolved; cap to keep the widget compact.
  const ordered = [...a.alerts].sort((x, y) => Number(x.status === 'resolved') - Number(y.status === 'resolved'));
  const list = ordered.slice(0, limit);

  const act = async (al: Alert, kind: 'ack' | 'resolve') => {
    setBusy(al.id + kind);
    const prev = a;
    const nextStatus: AlertStatus = kind === 'ack' ? 'ack' : 'resolved';
    setLocal({ ...a, alerts: a.alerts.map((x) => (x.id === al.id ? { ...x, status: nextStatus } : x)) });
    setExpanded(null);
    try {
      if (kind === 'ack') await api.ackAlert(al.id);
      else await api.resolveAlert(al.id);
      refetch();
    } catch {
      setLocal(prev);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card
      title="Notifications"
      icon={<Icon name="bell" />}
      actions={active > 0 ? <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--danger)', background: 'var(--danger-wash)', padding: '4px 10px', borderRadius: 999 }}>{active} active</span> : undefined}
      style={{ padding: 0 }}
    >
      {list.length === 0 ? (
        <div style={{ ...row, color: 'var(--text-3)', fontSize: 13 }}>
          <Icon name="check" size={16} color="var(--solar)" /> All clear — no notifications.
        </div>
      ) : (
        list.map((al, i) => {
          const actionable = al.status !== 'resolved';
          const open = expanded === al.id;
          return (
            <div key={al.id} style={{ borderTop: i ? '1px solid var(--border-1)' : 'none', opacity: al.status === 'resolved' ? 0.6 : 1 }}>
              <div style={{ ...row, cursor: actionable ? 'pointer' : 'default' }} onClick={() => actionable && setExpanded(open ? null : al.id)}>
                <span style={{ width: 34, height: 34, borderRadius: 10, display: 'grid', placeItems: 'center', flex: 'none', background: WASH[al.severity], color: COL[al.severity] }}>
                  <Icon name={al.icon} size={17} />
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 500, lineHeight: 1.25 }}>{al.title}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 2 }}>{al.sub}</div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5 }}>
                  <StatusPill s={al.status} />
                  <span style={{ fontSize: 10.5, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>{fmtAlertTime(al.ts)}</span>
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
        })
      )}
    </Card>
  );
}

/** Alert-rule toggles for Settings → Notifications (which already holds the channels). */
export function AlertRulesCard() {
  const { a, setLocal } = useAlerts();

  const toggleRule = async (id: string, enabled: boolean) => {
    const prev = a;
    setLocal({ ...a, rules: a.rules.map((r) => (r.id === id ? { ...r, enabled } : r)) });
    try {
      await api.setRule(id, enabled);
    } catch {
      setLocal(prev);
    }
  };

  return (
    <Card title="Alert rules" style={{ padding: 0 }}>
      {a.rules.map((r, i) => (
        <div key={r.id} style={{ ...row, borderTop: i ? '1px solid var(--border-1)' : 'none' }}>
          <span style={{ color: 'var(--text-2)' }}>
            <Icon name={r.icon} size={17} />
          </span>
          <span style={{ flex: 1, fontSize: 14 }}>{r.label}</span>
          <Switch checked={r.enabled} onChange={(e) => void toggleRule(r.id, e.target.checked)} />
        </div>
      ))}
    </Card>
  );
}
