import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { api, auth, ApiError } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import { MOCK_SETTINGS } from '../lib/mock';
import type { Channels, ChannelType, IntegrationStatus, OtpChannel, SettingsResponse, SessionsResponse, UserRole, AuthUser } from '../lib/types';
import { Card, Icon, Eyebrow, Switch, Input, Button, Select, Badge } from '../components/ui';
import { StaleBanner } from './_shared';
import { enablePush, getPushStatus, type PushStatus } from '../lib/push';
import { InstallSheet } from '../components/InstallSheet';
import { isStandalone } from '../lib/install';
import { useAuth } from '../auth/AuthProvider';
import { useNavigate } from 'react-router-dom';
import { SegmentedControl } from '../components/ui';
import type { ShellContext } from '../components/shell/AppShell';
import { settingsTabsFor, type SettingsTabLabel } from '../components/shell/nav';

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
  onClick,
}: {
  icon: string;
  tone?: string;
  name: string;
  detail?: ReactNode;
  right?: ReactNode;
  first?: boolean;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
      style={{ ...row, borderTop: first ? 'none' : '1px solid var(--border-1)', cursor: onClick ? 'pointer' : undefined }}
    >
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

/** Lightweight centered modal (mirrors the InstallSheet pattern). */
function Modal({ title, subtitle, onClose, children }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);
  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,.62)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 14, animation: 'fadeIn .16s ease' }}
    >
      <style>{`@keyframes fadeIn{from{opacity:0}to{opacity:1}}`}</style>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        style={{ width: '100%', maxWidth: 460, background: 'var(--surface-1, #14181d)', border: '1px solid var(--border-2)', borderRadius: 16, boxShadow: '0 12px 48px rgba(0,0,0,.5)', maxHeight: '88vh', overflowY: 'auto' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 18px 12px', borderBottom: '1px solid var(--border-1)' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{title}</div>
            {subtitle && <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginTop: 2 }}>{subtitle}</div>}
          </div>
          <button onClick={onClose} aria-label="Close" style={{ display: 'grid', placeItems: 'center', width: 32, height: 32, flex: 'none', borderRadius: 8, border: '1px solid var(--border-2)', background: 'var(--surface-2)', color: 'var(--text-2)', cursor: 'pointer' }}>
            <Icon name="x" size={17} />
          </button>
        </div>
        <div style={{ padding: '16px 18px 18px' }}>{children}</div>
      </div>
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

/* ============================================================================
 * Security card — 2FA, sessions, trusted devices, and (admin) user management.
 * ==========================================================================*/

function relTime(iso?: string): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = Date.now() - t;
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

function RevokeBtn({ onClick, label = 'Revoke' }: { onClick: () => void; label?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      loading={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await onClick();
        } finally {
          setBusy(false);
        }
      }}
    >
      {label}
    </Button>
  );
}

function TwoFactorRow() {
  const [enabled, setEnabled] = useState(false);
  const [channel, setChannel] = useState<OtpChannel>('email');
  const [waAvail, setWaAvail] = useState(true);
  const [busy, setBusy] = useState(true); // busy until the real state has loaded
  const [err, setErr] = useState<string | null>(null);

  // Seed from the server's REAL 2FA state. Never assume "off" — that would let a
  // stray toggle silently DISABLE a user's active two-factor protection.
  useEffect(() => {
    let alive = true;
    auth
      .me()
      .then((me) => {
        if (!alive) return;
        if (me.twoFactor) {
          setEnabled(me.twoFactor.enabled);
          setChannel(me.twoFactor.channel);
        }
        if (typeof me.whatsappAvailable === 'boolean') setWaAvail(me.whatsappAvailable);
      })
      .catch(() => {
        /* leave safe defaults (off / email) */
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const save = async (nextEnabled: boolean, nextChannel: OtpChannel) => {
    setBusy(true);
    setErr(null);
    const prevEnabled = enabled;
    const prevChannel = channel;
    setEnabled(nextEnabled);
    setChannel(nextChannel);
    try {
      await auth.set2fa(nextEnabled, nextChannel);
    } catch (e) {
      setEnabled(prevEnabled);
      setChannel(prevChannel);
      setErr(e instanceof ApiError ? e.message : 'Could not update — try again');
    } finally {
      setBusy(false);
    }
  };

  // Only offer WhatsApp once a provider is configured — otherwise it can't deliver.
  const channelOptions = waAvail
    ? [
        { value: 'whatsapp', label: 'WhatsApp' },
        { value: 'email', label: 'Email' },
      ]
    : [{ value: 'email', label: 'Email' }];

  return (
    <div style={{ ...row, borderTop: 'none', alignItems: 'flex-start' }}>
      <span style={{ width: 34, height: 34, borderRadius: 10, display: 'grid', placeItems: 'center', flex: 'none', background: 'var(--surface-3)', color: enabled ? 'var(--solar)' : 'var(--text-3)' }}>
        <Icon name="shield-check" size={17} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14 }}>Two-factor authentication</div>
        <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.45 }}>
          Require a one-time code at sign-in. Codes use the same channels as your alerts.
        </div>
        {enabled && (
          <div style={{ marginTop: 10, maxWidth: 200 }}>
            <Select
              label="Code channel"
              value={channel}
              disabled={busy}
              options={channelOptions}
              onChange={(e) => void save(true, e.target.value as OtpChannel)}
            />
          </div>
        )}
        {!waAvail && (
          <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 6 }}>
            WhatsApp delivery isn’t set up yet — codes are sent by email.
          </div>
        )}
        {err && <div style={{ fontSize: 11.5, color: 'var(--danger)', marginTop: 6 }}>{err}</div>}
      </div>
      <Switch checked={enabled} disabled={busy} onChange={(e) => void save(e.target.checked, channel)} />
    </div>
  );
}

function DeviceList({
  data,
  reload,
  currentLabel,
}: {
  data: SessionsResponse;
  reload: () => void;
  currentLabel: string;
}) {
  const navigate = useNavigate();
  const { logout } = useAuth();
  // Defensive: never let a missing array blank the whole app (no error boundary).
  const sessions = data.sessions ?? [];
  const trusted = data.trusted ?? [];

  const onRevokeSession = async (id: string, current?: boolean) => {
    await auth.revokeSession(id);
    if (current) {
      await logout();
      navigate('/login', { replace: true });
      return;
    }
    reload();
  };

  return (
    <>
      <div style={{ padding: '12px 16px 4px' }}>
        <Eyebrow>Active sessions</Eyebrow>
      </div>
      {sessions.length === 0 && (
        <div style={{ ...row, color: 'var(--text-3)', fontSize: 13 }}>No active sessions.</div>
      )}
      {sessions.map((s, i) => (
        <div key={s.id} style={{ ...row, borderTop: i === 0 ? 'none' : '1px solid var(--border-1)' }}>
          <span style={{ width: 34, height: 34, borderRadius: 10, display: 'grid', placeItems: 'center', flex: 'none', background: 'var(--surface-3)', color: 'var(--text-2)' }}>
            <Icon name="monitor" size={17} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
              {s.device}
              {s.current && (
                <span style={{ fontSize: 10.5, color: 'var(--solar)', background: 'var(--solar-wash)', borderRadius: 999, padding: '1px 8px', fontWeight: 600 }}>This device</span>
              )}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-2)', fontFamily: 'var(--font-mono)' }}>
              {[s.location, relTime(s.lastSeen)].filter(Boolean).join(' · ') || currentLabel}
            </div>
          </div>
          <RevokeBtn onClick={() => onRevokeSession(s.id, s.current)} label={s.current ? 'Sign out' : 'Revoke'} />
        </div>
      ))}

      {trusted.length > 0 && (
        <>
          <div style={{ padding: '14px 16px 4px', borderTop: '1px solid var(--border-1)' }}>
            <Eyebrow>Trusted devices</Eyebrow>
          </div>
          {trusted.map((t, i) => (
            <div key={t.id} style={{ ...row, borderTop: i === 0 ? 'none' : '1px solid var(--border-1)' }}>
              <span style={{ width: 34, height: 34, borderRadius: 10, display: 'grid', placeItems: 'center', flex: 'none', background: 'var(--surface-3)', color: 'var(--text-2)' }}>
                <Icon name="shield" size={17} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
                  {t.device}
                  {t.current && (
                    <span style={{ fontSize: 10.5, color: 'var(--solar)', background: 'var(--solar-wash)', borderRadius: 999, padding: '1px 8px', fontWeight: 600 }}>This device</span>
                  )}
                </div>
                {t.expiresAt && (
                  <div style={{ fontSize: 12, color: 'var(--text-2)', fontFamily: 'var(--font-mono)' }}>
                    Trusted until {new Date(t.expiresAt).toLocaleDateString()}
                  </div>
                )}
              </div>
              <RevokeBtn onClick={async () => { await auth.revokeTrusted(t.id); reload(); }} label="Remove" />
            </div>
          ))}
        </>
      )}
    </>
  );
}

function AddUserForm({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<UserRole>('member');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [setupUrl, setSetupUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const submit = async () => {
    if (!email.trim() || !name.trim()) {
      setErr('Email and name are required');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await auth.createUser(email.trim(), name.trim(), role);
      setSetupUrl(res.setupUrl);
      setEmail('');
      setName('');
      setRole('member');
      onCreated();
    } catch {
      setErr('Could not create user — try again');
    } finally {
      setBusy(false);
    }
  };

  if (setupUrl) {
    return (
      <div style={{ padding: '12px 16px 16px', borderTop: '1px solid var(--border-1)', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.45 }}>
          User created. Share this one-time setup link so they can set a password:
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Input readOnly value={setupUrl} onFocus={(e) => e.currentTarget.select()} />
          <Button
            size="md"
            variant="secondary"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(setupUrl);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              } catch {
                /* ignore */
              }
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <div>
          <Button size="sm" variant="ghost" onClick={() => { setSetupUrl(null); setOpen(false); }}>Done</Button>
        </div>
      </div>
    );
  }

  if (!open) {
    return (
      <div style={{ padding: '10px 16px 14px', borderTop: '1px solid var(--border-1)' }}>
        <Button size="sm" variant="secondary" iconLeft={<Icon name="user-plus" />} onClick={() => { setOpen(true); setErr(null); }}>
          Add user
        </Button>
      </div>
    );
  }

  return (
    <div style={{ padding: '12px 16px 16px', borderTop: '1px solid var(--border-1)', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <Input label="Email" type="email" placeholder="name@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
      <Input label="Name" type="text" placeholder="Full name" value={name} onChange={(e) => setName(e.target.value)} />
      <Select
        label="Role"
        value={role}
        options={[
          { value: 'member', label: 'Member' },
          { value: 'admin', label: 'Admin' },
        ]}
        onChange={(e) => setRole(e.target.value as UserRole)}
      />
      {err && <div style={{ fontSize: 11.5, color: 'var(--danger)' }}>{err}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <Button size="sm" variant="primary" loading={busy} onClick={() => void submit()}>Create &amp; get link</Button>
        <Button size="sm" variant="ghost" onClick={() => { setOpen(false); setErr(null); }}>Cancel</Button>
      </div>
    </div>
  );
}

function UsersSection() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<AuthUser[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await auth.listUsers();
      setUsers(res.users);
      setErr(null);
    } catch {
      setErr('Could not load users');
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const remove = async (id: string) => {
    await auth.deleteUser(id);
    void load();
  };

  return (
    <Card title="Users" subtitle="People with access to this Power install" style={{ padding: 0 }}>
      {err && <div style={{ ...row, color: 'var(--danger)', fontSize: 13 }}>{err}</div>}
      {users === null && !err && <div style={{ ...row, color: 'var(--text-3)', fontSize: 13 }}>Loading…</div>}
      {users?.map((u, i) => (
        <div key={u.id} style={{ ...row, borderTop: i === 0 ? 'none' : '1px solid var(--border-1)' }}>
          <span style={{ width: 34, height: 34, borderRadius: 10, display: 'grid', placeItems: 'center', flex: 'none', background: 'var(--surface-3)', color: u.role === 'admin' ? 'var(--solar)' : 'var(--home)' }}>
            <Icon name={u.role === 'admin' ? 'shield' : 'user'} size={17} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
              {u.name}
              {u.id === me?.id && (
                <span style={{ fontSize: 10.5, color: 'var(--text-2)', background: 'var(--surface-3)', borderRadius: 999, padding: '1px 8px', fontWeight: 600 }}>You</span>
              )}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-2)', fontFamily: 'var(--font-mono)' }}>{u.email} · {u.role}</div>
          </div>
          {u.id !== me?.id && <RevokeBtn onClick={() => remove(u.id)} label="Remove" />}
        </div>
      ))}
      <AddUserForm onCreated={() => void load()} />
    </Card>
  );
}

function SecurityCard() {
  const { user } = useAuth();
  const [sessions, setSessions] = useState<SessionsResponse | null>(null);
  const [loadErr, setLoadErr] = useState(false);

  const load = async () => {
    try {
      setSessions(await auth.sessions());
      setLoadErr(false);
    } catch {
      setLoadErr(true);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  return (
    <Card title="Security" subtitle={user ? `${user.name} · ${user.email}` : undefined} style={{ padding: 0 }}>
      <TwoFactorRow />
      <div style={{ borderTop: '1px solid var(--border-1)' }}>
        {loadErr && <div style={{ ...row, color: 'var(--danger)', fontSize: 13 }}>Could not load sessions.</div>}
        {!loadErr && !sessions && <div style={{ ...row, color: 'var(--text-3)', fontSize: 13 }}>Loading sessions…</div>}
        {sessions && <DeviceList data={sessions} reload={() => void load()} currentLabel="Active now" />}
      </div>
    </Card>
  );
}

/* ============================================================================
 * AC Cloud — Intesis (Panasonic Etherea) integration. Shown as a row in the
 * Connections list; clicking opens the config modal. Admin enters the AC Cloud
 * account; the backend validates by logging in BEFORE persisting and never logs
 * the password. Once connected, the Devices screen shows the fleet.
 * ==========================================================================*/

function AcCloudConnection() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);

  const load = async () => {
    try {
      const s = await api.integrations.intesisStatus();
      setStatus(s);
      if (s.username) setUsername(s.username);
    } catch {
      /* ignore — shows as not-connected */
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const connect = async () => {
    if (!username.trim() || !password) {
      setErr('Enter your AC Cloud email and password');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const s = await api.integrations.intesisConnect(username.trim(), password);
      setStatus(s);
      setPassword('');
      setEditing(false);
    } catch (e) {
      setErr((e as Error).message || 'Could not connect — check your credentials');
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await api.integrations.intesisDisconnect();
      await load();
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  const connected = status?.connected ?? false;
  // Status text in the row, matching the other connections (dot + word + chevron).
  const statusText = status === null ? 'loading…' : connected ? `connected · ${status.deviceCount ?? 0} units` : 'not connected';
  const statusTone = status === null ? 'text-3' : connected ? 'solar' : 'grid';

  return (
    <>
      <LinkRow
        icon="thermometer"
        tone={connected ? 'solar' : undefined}
        name="AC Cloud"
        onClick={() => setOpen(true)}
        right={
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            {status !== null && <Dot tone={connected ? 'solar' : 'grid'} />}
            <span style={{ fontSize: 12, color: `var(--${statusTone})` }}>{statusText}</span>
            <Chev />
          </div>
        }
      />

      {open && (
        <Modal title="AC Cloud" subtitle="Panasonic Etherea climate (Intesis)" onClose={() => setOpen(false)}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ width: 38, height: 38, borderRadius: 11, display: 'grid', placeItems: 'center', flex: 'none', background: 'var(--surface-3)', color: connected ? 'var(--solar)' : 'var(--text-3)' }}>
              <Icon name="thermometer" size={19} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {connected ? (
                  <Badge tone="solar" variant="soft" icon={<Icon name="check" size={11} />}>Connected · {status?.deviceCount ?? 0} units</Badge>
                ) : (
                  <Badge tone="neutral" variant="soft">Not connected</Badge>
                )}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-2)', fontFamily: 'var(--font-mono)', marginTop: 4 }}>
                {connected ? status?.username : 'Sign in with your AC Cloud (Intesis) account'}
              </div>
            </div>
          </div>

          {status?.error && <div style={{ fontSize: 11.5, color: 'var(--danger)', marginTop: 12 }}>{status.error}</div>}

          {isAdmin && (!connected || editing) && (
            <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <Input label="Email / username" type="text" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="you@example.com" />
              <Input label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
              {err && <div style={{ fontSize: 11.5, color: 'var(--danger)' }}>{err}</div>}
              <div style={{ display: 'flex', gap: 8 }}>
                <Button size="sm" variant="primary" loading={busy} onClick={() => void connect()}>{connected ? 'Re-connect' : 'Connect'}</Button>
                {connected && <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setErr(null); }}>Cancel</Button>}
              </div>
            </div>
          )}

          {isAdmin && connected && !editing && (
            <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
              <Button size="sm" variant="secondary" onClick={() => { setEditing(true); setErr(null); }}>Change account</Button>
              <Button size="sm" variant="ghost" loading={busy} onClick={() => void disconnect()}>Disconnect</Button>
            </div>
          )}
          {!isAdmin && <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 12 }}>Only an admin can connect AC Cloud.</div>}
        </Modal>
      )}
    </>
  );
}

export function Settings({ ctx }: { ctx: ShellContext }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [installOpen, setInstallOpen] = useState(false);
  const installed = isStandalone();
  const signOut = async () => {
    await logout();
    navigate('/login', { replace: true });
  };
  const { data, loading, stale, updatedAt } = usePolling<SettingsResponse>(api.settings, 0);
  const fetched = data || (loading ? null : MOCK_SETTINGS) || MOCK_SETTINGS;

  // local mirror of channels so optimistic edits survive across re-renders
  const [channels, setChannels] = useState<Channels | null>(null);
  useEffect(() => {
    if (data?.channels) setChannels(data.channels);
  }, [data?.channels]);
  const ch = channels || fetched.channels;

  const s = fetched;

  const isAdmin = user?.role === 'admin';
  const tabs = settingsTabsFor(isAdmin);
  const active: SettingsTabLabel = (tabs as readonly string[]).includes(ctx.settingsTab)
    ? (ctx.settingsTab as SettingsTabLabel)
    : 'Connections';

  const sections = (
    <>
      {active === 'Connections' && (
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
          {/* AC Cloud (Intesis) — config opens in a modal on click */}
          <AcCloudConnection />
        </Card>
      )}

      {active === 'Notifications' && <NotificationsCard channels={ch} onChannels={setChannels} />}

      {active === 'Security' && <SecurityCard />}

      {active === 'Users' && isAdmin && <UsersSection />}

      {active === 'System' && (
        <>
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

          <Card title="My system" style={{ padding: 0 }}>
            {s.assets.map((a, i) => (
              <LinkRow key={a.name} first={i === 0} icon={a.icon} tone={a.tone} name={a.name} detail={a.detail} right={<Chev />} />
            ))}
          </Card>

          <Card title="App" style={{ padding: 0 }}>
            <LinkRow
              first
              icon="smartphone-nfc"
              tone="solar"
              name={installed ? 'Installed on this device' : 'Add to home screen'}
              detail={installed ? 'Running as a full-screen app' : 'Install Power as a full-screen app'}
              onClick={() => setInstallOpen(true)}
              right={installed ? <Icon name="check" size={18} color="var(--solar)" /> : <Chev />}
            />
            <LinkRow
              icon="user"
              tone="home"
              name={user?.name || 'Account'}
              detail={user?.email || 'Signed in'}
              right={<Button size="sm" variant="ghost" iconLeft={<Icon name="log-out" />} onClick={() => void signOut()}>Sign out</Button>}
            />
            <LinkRow icon="moon" tone="battery" name="Theme" detail="Dark (control-room)" right={<Chev />} />
            <LinkRow icon="info" tone="text-2" name="Version" detail="0.1.0 · energy.hirobo.nl" />
          </Card>
        </>
      )}
    </>
  );

  // Desktop: the shell TopBar supplies the eyebrow, active-tab title, and tab strip
  // (Reports pattern) — the page renders content only.
  if (ctx.desktop) {
    return (
      <>
        {stale && <StaleBanner updatedAt={updatedAt} />}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 820, margin: '0 auto', width: '100%' }}>
          {sections}
        </div>
        {installOpen && <InstallSheet onClose={() => setInstallOpen(false)} />}
      </>
    );
  }

  // Mobile: no TopBar — render the header + tab strip in-page.
  return (
    <>
      <div style={{ padding: '12px 18px 12px' }}>
        <Eyebrow>Settings</Eyebrow>
        <h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-.02em', margin: '2px 0 0' }}>{active}</h1>
      </div>
      {stale && <StaleBanner updatedAt={updatedAt} />}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '8px 14px 22px' }}>
        <SegmentedControl block options={tabs} value={active} onChange={ctx.setSettingsTab} />
        {sections}
      </div>
      {installOpen && <InstallSheet onClose={() => setInstallOpen(false)} />}
    </>
  );
}
