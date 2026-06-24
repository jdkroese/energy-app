import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { api } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import { MOCK_SETTINGS } from '../lib/mock';
import type { Channels, ChannelType, SettingsResponse } from '../lib/types';
import { Card, Icon, Eyebrow, Switch, Input, Button } from '../components/ui';
import { StaleBanner } from './_shared';
import { enablePush, getPushStatus, type PushStatus } from '../lib/push';

const Chev = () => <Icon name="chevron-right" size={18} color="var(--text-3)" />;
const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px' };

function Dot({ tone }: { tone: string }) {
  return <span style={{ width: 8, height: 8, borderRadius: '50%', background: `var(--${tone})`, boxShadow: `0 0 8px var(--${tone})`, display: 'inline-block' }} />;
}

function ChanIcon({ name, on }: { name: string; on: boolean }) {
  return (
    <span style={{ width: 34, height: 34, borderRadius: 10, display: 'grid', placeItems: 'center', flex: 'none', background: 'var(--surface-3)', color: on ? 'var(--solar)' : 'var(--text-3)' }}>
      <Icon name={name} size={17} />
    </span>
  );
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

const pushLabel: Record<PushStatus, string> = {
  unsupported: 'Not supported on this browser',
  'needs-install': 'Add to Home Screen to enable',
  default: 'Tap to enable on this iPhone',
  granted: 'On · this device',
  denied: 'Blocked — allow in iOS settings',
};

function NotificationsCard({ channels, onChannels }: { channels: Channels; onChannels: (c: Channels) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(channels.whatsapp.number);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushStatus, setPushStatus] = useState<PushStatus>('default');

  useEffect(() => {
    setPushStatus(getPushStatus());
  }, []);

  // keep the draft in sync when not actively editing
  useEffect(() => {
    if (!editing) setDraft(channels.whatsapp.number);
  }, [channels.whatsapp.number, editing]);

  const startEdit = () => {
    setDraft(channels.whatsapp.number);
    setErr(null);
    setEditing(true);
  };

  const saveNumber = async () => {
    const next = draft.trim();
    if (!next) {
      setErr('Enter a number');
      return;
    }
    const prev = channels;
    // optimistic
    onChannels({ ...channels, whatsapp: { ...channels.whatsapp, number: next } });
    setEditing(false);
    setSaving(true);
    setErr(null);
    try {
      const res = await api.setWhatsapp(next);
      onChannels(res.channels);
    } catch {
      onChannels(prev); // revert to last-good
      setErr('Could not save — reverted');
      setEditing(true);
    } finally {
      setSaving(false);
    }
  };

  const toggleChannel = async (type: ChannelType, enabled: boolean) => {
    const prev = channels;
    const optimistic: Channels = {
      ...channels,
      [type]: { ...channels[type], enabled },
    } as Channels;
    onChannels(optimistic);
    try {
      const res = await api.setChannel(type, enabled);
      onChannels(res.channels);
    } catch {
      onChannels(prev);
    }
  };

  const onEnablePush = async () => {
    setPushBusy(true);
    try {
      const status = await enablePush();
      setPushStatus(status);
      if (status === 'granted') await toggleChannel('push', true);
    } catch {
      setPushStatus(getPushStatus());
    } finally {
      setPushBusy(false);
    }
  };

  const pushOn = pushStatus === 'granted' && channels.push.enabled;

  return (
    <Card title="Notifications" style={{ padding: 0 }}>
      {/* WhatsApp — editable number */}
      <div style={{ ...row, borderTop: 'none', alignItems: editing ? 'flex-start' : 'center' }}>
        <ChanIcon name="message-circle" on={channels.whatsapp.enabled} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14 }}>WhatsApp</div>
          {!editing ? (
            <div style={{ fontSize: 12, color: 'var(--text-2)', fontFamily: 'var(--font-mono)' }}>
              {channels.whatsapp.number || 'No number set'}
              {saving && <span style={{ color: 'var(--text-3)' }}> · saving…</span>}
            </div>
          ) : (
            <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Input
                type="tel"
                inputMode="tel"
                autoFocus
                value={draft}
                placeholder="+34 600 000 000"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveNumber();
                  if (e.key === 'Escape') setEditing(false);
                }}
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <Button size="sm" variant="primary" onClick={() => void saveNumber()}>Save</Button>
                <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setErr(null); }}>Cancel</Button>
              </div>
            </div>
          )}
          {err && <div style={{ fontSize: 11.5, color: 'var(--danger)', marginTop: 4 }}>{err}</div>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {!editing && (
            <button
              onClick={startEdit}
              aria-label="Edit WhatsApp number"
              style={{ display: 'grid', placeItems: 'center', width: 30, height: 30, borderRadius: 8, border: '1px solid var(--border-2)', background: 'var(--surface-2)', color: 'var(--text-2)', cursor: 'pointer' }}
            >
              <Icon name="pencil" size={15} />
            </button>
          )}
          <Switch checked={channels.whatsapp.enabled} onChange={(e) => void toggleChannel('whatsapp', e.target.checked)} />
        </div>
      </div>

      {/* Push */}
      <div style={{ ...row, borderTop: '1px solid var(--border-1)' }}>
        <ChanIcon name="bell" on={pushOn} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14 }}>Push notifications</div>
          <div style={{ fontSize: 12, color: 'var(--text-2)' }}>{pushLabel[pushStatus]}</div>
          {(pushStatus === 'default' || pushStatus === 'needs-install' || pushStatus === 'denied') && (
            <div style={{ marginTop: 8 }}>
              <Button
                size="sm"
                variant="secondary"
                loading={pushBusy}
                disabled={pushStatus === 'needs-install' || pushStatus === 'denied'}
                iconLeft={<Icon name="bell" />}
                onClick={() => void onEnablePush()}
              >
                Enable push on this iPhone
              </Button>
            </div>
          )}
        </div>
        <Switch
          checked={pushOn}
          disabled={pushStatus !== 'granted'}
          onChange={(e) => void toggleChannel('push', e.target.checked)}
        />
      </div>

      {/* Email */}
      <div style={{ ...row, borderTop: '1px solid var(--border-1)' }}>
        <ChanIcon name="mail" on={channels.email.enabled} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14 }}>Email</div>
          <div style={{ fontSize: 12, color: 'var(--text-2)', fontFamily: 'var(--font-mono)' }}>{channels.email.address}</div>
        </div>
        <Switch checked={channels.email.enabled} onChange={(e) => void toggleChannel('email', e.target.checked)} />
      </div>
    </Card>
  );
}

export function Settings() {
  const { data, loading, stale, updatedAt } = usePolling<SettingsResponse>(api.settings, 0);
  const fetched = data || (loading ? null : MOCK_SETTINGS) || MOCK_SETTINGS;

  // local mirror of channels so optimistic edits survive across re-renders
  const [channels, setChannels] = useState<Channels | null>(null);
  useEffect(() => {
    if (data?.channels) setChannels(data.channels);
  }, [data?.channels]);
  const ch = channels || fetched.channels;

  const s = fetched;

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

        {/* notifications */}
        <NotificationsCard channels={ch} onChannels={setChannels} />

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
