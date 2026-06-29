import { lazy, Suspense, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { api, auth, ApiError } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import { MOCK_SETTINGS } from '../lib/mock';
import type { Channels, ChannelType, IntegrationsConfig, IntegrationStatus, OtpChannel, ProbeResult, RainbirdIntegrationStatus, SettingsResponse, SessionsResponse, TuyaIntegrationStatus, SonosIntegrationStatus, AlarmConfig, UserRole, AuthUser } from '../lib/types';
import { ALARM_BLINK_FLOOR_MS } from '../lib/types';
import { Card, Icon, Eyebrow, Switch, Input, Button, Select, Badge, Slider, ScreenHeader } from '../components/ui';
import { StaleBanner } from './_shared';
import { AlertRulesCard, VoltageMonitorCard } from '../components/Notifications';
import { enablePush, getPushStatus, type PushStatus } from '../lib/push';
import { InstallSheet } from '../components/InstallSheet';
import { HomeSceneBuilder } from '../components/home/HomeSceneBuilder';
import { isStandalone } from '../lib/install';
import { useAuth } from '../auth/AuthProvider';
import { useNavigate } from 'react-router-dom';
import { SegmentedControl } from '../components/ui';
import type { ShellContext } from '../components/shell/AppShell';
import { settingsTabsFor, type SettingsTabLabel } from '../components/shell/nav';
// Leaflet (map + CSS, ~150KB) is heavy and only used by this one card — load it
// on demand so it never enters the main bundle.
const SiteLocationCard = lazy(() =>
  import('../components/SiteLocationCard').then((m) => ({ default: m.SiteLocationCard })),
);
import { useTheme } from '../lib/ThemeProvider';
import type { Theme } from '../lib/theme';
import { isKioskEnabled, setKioskEnabled } from '../lib/kiosk';

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

/** ThemeRow — appearance picker (Dark / Light / System) wired to useTheme. */
function ThemeRow({ first }: { first?: boolean }) {
  const { theme, resolved, setTheme } = useTheme();
  const icon = resolved === 'light' ? 'sun' : 'moon';
  return (
    <div style={{ borderTop: first ? 'none' : '1px solid var(--border-1)', padding: '13px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
      <span style={{ width: 34, height: 34, borderRadius: 10, display: 'grid', placeItems: 'center', flex: 'none', background: 'var(--surface-3)', color: 'var(--battery)' }}>
        <Icon name={icon} size={17} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14 }}>Appearance</div>
        <div style={{ fontSize: 12, color: 'var(--text-2)', fontFamily: 'var(--font-mono)' }}>
          {theme === 'system' ? `System · ${resolved}` : theme === 'light' ? 'Light' : 'Dark (control-room)'}
        </div>
      </div>
      <SegmentedControl
        size="sm"
        value={theme}
        onChange={(v) => setTheme(v as Theme)}
        options={[
          { value: 'dark', label: 'Dark', icon: <Icon name="moon" size={14} /> },
          { value: 'light', label: 'Light', icon: <Icon name="sun" size={14} /> },
          { value: 'system', label: 'System', icon: <Icon name="monitor" size={14} /> },
        ]}
      />
    </div>
  );
}

/** KioskRow — wall-tablet (kiosk) mode toggle; admin-only, provisions then reloads. */
function KioskRow() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onToggle = async (on: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      if (on) {
        await api.kiosk.provision();
        setKioskEnabled(true);
      } else {
        setKioskEnabled(false);
      }
      window.location.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not enable tablet mode');
      setBusy(false);
    }
  };

  return (
    <div style={{ borderTop: '1px solid var(--border-1)', padding: '13px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
      <span style={{ width: 34, height: 34, borderRadius: 10, display: 'grid', placeItems: 'center', flex: 'none', background: 'var(--surface-3)', color: 'var(--battery)' }}>
        <Icon name="tablet" size={17} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14 }}>Wall tablet mode</div>
        <div style={{ fontSize: 12, color: err ? 'var(--danger)' : 'var(--text-2)', fontFamily: 'var(--font-mono)' }}>
          {err || 'Big-button kitchen display'}
        </div>
      </div>
      <Switch checked={isKioskEnabled()} disabled={busy} onChange={(e) => void onToggle(e.target.checked)} />
    </div>
  );
}

/* ============================================================================
 * Connections accordion — each row expands inline to reveal its panel.
 * ==========================================================================*/

/** A collapsible connection row: clickable header + smoothly-expanding panel. */
function ConnectionRow({
  first,
  icon,
  tone,
  name,
  statusText,
  statusTone,
  showDot = true,
  open,
  onToggle,
  children,
}: {
  first?: boolean;
  icon: string;
  tone?: string;
  name: string;
  statusText: string;
  statusTone: string;
  showDot?: boolean;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div style={{ borderTop: first ? 'none' : '1px solid var(--border-1)' }}>
      <div
        onClick={onToggle}
        role="button"
        aria-expanded={open}
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
        style={{ ...row, cursor: 'pointer' }}
      >
        <span style={{ width: 34, height: 34, borderRadius: 10, display: 'grid', placeItems: 'center', flex: 'none', background: 'var(--surface-3)', color: tone ? `var(--${tone})` : 'var(--text-2)' }}>
          <Icon name={icon} size={17} />
        </span>
        <div style={{ flex: 1, minWidth: 0, fontSize: 14 }}>{name}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          {showDot && <Dot tone={statusTone} />}
          <span style={{ fontSize: 12, color: `var(--${statusTone})` }}>{statusText}</span>
          <span style={{ display: 'inline-flex', transition: 'transform .2s ease', transform: open ? 'rotate(90deg)' : 'none' }}>
            <Chev />
          </span>
        </div>
      </div>
      {/* grid-rows 0fr→1fr animates height without measuring content */}
      <div style={{ display: 'grid', gridTemplateRows: open ? '1fr' : '0fr', transition: 'grid-template-rows .22s ease' }}>
        <div style={{ overflow: 'hidden', minHeight: 0 }}>
          <div style={{ padding: '0 16px 16px 62px' }}>{children}</div>
        </div>
      </div>
    </div>
  );
}

/** One label/value line inside an expanded connection panel. */
function DetailLine({ label, value, tone = 'text-2' }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div style={{ display: 'flex', gap: 10, fontSize: 12.5, lineHeight: 1.5 }}>
      <span style={{ color: 'var(--text-3)', width: 58, flex: 'none' }}>{label}</span>
      <span style={{ color: `var(--${tone})`, fontFamily: 'var(--font-mono)', minWidth: 0, wordBreak: 'break-word' }}>{value}</span>
    </div>
  );
}

// Static descriptions of the server-managed integrations (live status comes from the API).
const CONN_INFO: Record<string, { desc: string; setup: string }> = {
  'Tesla cloud': { desc: 'Tesla Fleet API — Powerwall live status & history over the cloud.', setup: 'Authenticated server-side via the Fleet API token.' },
  'Sonnen LAN': { desc: 'sonnenBatterie local JSON API on the home network.', setup: 'Reached over the LAN / VPN; configured server-side.' },
  Weather: { desc: 'Open-Meteo forecast for Jávea — drives solar & load planning.', setup: 'Public API — no credentials required.' },
  Sungrow: { desc: 'Sungrow inverter direct read (Array A).', setup: 'Not yet wired — pending integration.' },
};

/** Read-only info panel for a server-managed connection. */
function ConnectionInfo({ conn, ok, note = 'Managed automatically — nothing to configure here.' }: { conn: SettingsResponse['connections'][number]; ok: boolean; note?: string }) {
  const info = CONN_INFO[conn.name];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {info?.desc && <div style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5 }}>{info.desc}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <DetailLine label="Status" value={conn.status} tone={ok ? 'solar' : 'grid'} />
        {conn.detail && <DetailLine label="Detail" value={conn.detail} />}
        {info?.setup && <DetailLine label="Setup" value={info.setup} />}
      </div>
      {note && <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>{note}</div>}
    </div>
  );
}

// ---- Editable connection config panels (admin) --------------------------

function errMsg(e: unknown): string {
  return e instanceof ApiError ? e.message : 'Something went wrong — try again';
}

/** Inline test/save result line. */
function ResultLine({ r, err }: { r?: ProbeResult | null; err?: string | null }) {
  if (err) return <div style={{ fontSize: 11.5, color: 'var(--danger)' }}>{err}</div>;
  if (!r) return null;
  return <div style={{ fontSize: 11.5, color: r.ok ? 'var(--solar)' : 'var(--danger)' }}>{r.ok ? '✓ ' : ''}{r.detail}</div>;
}

const cfgDesc: CSSProperties = { fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5 };

function SonnenConfig({ conn, ok, cfg, reload }: { conn: SettingsResponse['connections'][number]; ok: boolean; cfg: IntegrationsConfig; reload: () => void }) {
  const [host, setHost] = useState(cfg.sonnen.host);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [res, setRes] = useState<ProbeResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = async (kind: 'test' | 'save') => {
    setBusy(kind); setErr(null); setRes(null);
    try {
      if (kind === 'test') setRes(await api.integrations.testSonnen(host.trim(), token || undefined));
      else { const r = await api.integrations.setSonnen(host.trim(), token || undefined); setRes({ ok: r.ok, detail: r.detail }); setToken(''); reload(); }
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(null); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={cfgDesc}>sonnenBatterie local JSON API on the home network.</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <DetailLine label="Status" value={conn.status} tone={ok ? 'solar' : 'grid'} />
        {conn.detail && <DetailLine label="Detail" value={conn.detail} />}
      </div>
      <Input label="Host / IP" value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.197" />
      <Input label="Auth token" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder={cfg.sonnen.hasToken ? '•••••• (leave blank to keep)' : 'Auth-Token'} />
      <ResultLine r={res} err={err} />
      <div style={{ display: 'flex', gap: 8 }}>
        <Button size="sm" variant="secondary" loading={busy === 'test'} onClick={() => void run('test')}>Test</Button>
        <Button size="sm" variant="primary" loading={busy === 'save'} onClick={() => void run('save')}>Save</Button>
      </div>
    </div>
  );
}

function WeatherConfig({ cfg }: { cfg: IntegrationsConfig; reload: () => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={cfgDesc}>Open-Meteo forecast location — drives solar &amp; load planning.</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <DetailLine label="Location" value={`${cfg.weather.lat}, ${cfg.weather.lon}`} />
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
        Set the coordinates from the map in the <strong style={{ color: 'var(--text-2)' }}>Site location</strong> card on the <strong style={{ color: 'var(--text-2)' }}>System</strong> tab.
      </div>
    </div>
  );
}

function TeslaConfig({ conn, ok, cfg, reload }: { conn: SettingsResponse['connections'][number]; ok: boolean; cfg: IntegrationsConfig; reload: () => void }) {
  const [siteId, setSiteId] = useState(cfg.tesla.siteId);
  const [busy, setBusy] = useState<'test' | 'save' | 'reauth' | null>(null);
  const [res, setRes] = useState<ProbeResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showReauth, setShowReauth] = useState(false);
  const [token, setToken] = useState('');

  const test = async () => { setBusy('test'); setErr(null); setRes(null); try { setRes(await api.integrations.testTesla()); } catch (e) { setErr(errMsg(e)); } finally { setBusy(null); } };
  const saveSite = async () => { setBusy('save'); setErr(null); setRes(null); try { await api.integrations.setTeslaSite(siteId.trim()); setRes({ ok: true, detail: 'Site id saved' }); reload(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(null); } };
  const reauth = async () => { setBusy('reauth'); setErr(null); setRes(null); try { const r = await api.integrations.reauthTesla(token.trim()); setRes(r); setToken(''); setShowReauth(false); reload(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(null); } };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={cfgDesc}>Tesla Fleet API — Powerwall live status &amp; history (cloud).</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <DetailLine label="Status" value={conn.status} tone={ok ? 'solar' : 'grid'} />
        {conn.detail && <DetailLine label="Detail" value={conn.detail} />}
      </div>
      <Input label="Energy site id" inputMode="numeric" value={siteId} onChange={(e) => setSiteId(e.target.value)} placeholder="1689529157873570" />
      <ResultLine r={res} err={err} />
      <div style={{ display: 'flex', gap: 8 }}>
        <Button size="sm" variant="secondary" loading={busy === 'test'} onClick={() => void test()}>Test connection</Button>
        <Button size="sm" variant="primary" loading={busy === 'save'} onClick={() => void saveSite()}>Save site</Button>
      </div>
      {!showReauth ? (
        <button onClick={() => { setShowReauth(true); setErr(null); setRes(null); }} style={{ alignSelf: 'flex-start', background: 'none', border: 'none', padding: 0, color: 'var(--text-2)', fontSize: 12, cursor: 'pointer', textDecoration: 'underline' }}>
          Re-authenticate…
        </button>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--border-1)' }}>
          <div style={{ fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.5 }}>
            Pasting a new refresh token replaces the live one. It's validated against Tesla before saving — a bad token is rejected and the current one is kept.
          </div>
          <Input label="Refresh token" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="eyJ…" />
          <div style={{ display: 'flex', gap: 8 }}>
            <Button size="sm" variant="primary" loading={busy === 'reauth'} onClick={() => void reauth()}>Re-authenticate</Button>
            <Button size="sm" variant="ghost" onClick={() => { setShowReauth(false); setToken(''); }}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Dispatch to the right panel per connection; non-admins see read-only info. */
function ConnectionPanel({ conn, ok, cfg, reload }: { conn: SettingsResponse['connections'][number]; ok: boolean; cfg: IntegrationsConfig | null; reload: () => void }) {
  const { user } = useAuth();
  if (user?.role !== 'admin') return <ConnectionInfo conn={conn} ok={ok} note="Only an admin can change this." />;
  if (cfg) {
    if (conn.name === 'Sonnen LAN') return <SonnenConfig conn={conn} ok={ok} cfg={cfg} reload={reload} />;
    if (conn.name === 'Weather') return <WeatherConfig cfg={cfg} reload={reload} />; // read-only; editing lives in SiteLocationCard
    if (conn.name === 'Tesla cloud') return <TeslaConfig conn={conn} ok={ok} cfg={cfg} reload={reload} />;
  }
  return <ConnectionInfo conn={conn} ok={ok} />;
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

function AcCloudConnection({ first, open, onToggle }: { first?: boolean; open: boolean; onToggle: () => void }) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

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
  const statusText = status === null ? 'loading…' : connected ? `connected · ${status.deviceCount ?? 0} units` : 'not connected';
  const statusTone = status === null ? 'text-3' : connected ? 'solar' : 'grid';

  return (
    <ConnectionRow
      first={first}
      icon="thermometer"
      tone={connected ? 'solar' : undefined}
      name="AC Cloud"
      statusText={statusText}
      statusTone={statusTone}
      showDot={status !== null}
      open={open}
      onToggle={onToggle}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5 }}>
          Panasonic Etherea climate via your AC Cloud (Intesis) account.
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {connected ? (
            <Badge tone="solar" variant="soft" icon={<Icon name="check" size={11} />}>Connected · {status?.deviceCount ?? 0} units</Badge>
          ) : (
            <Badge tone="neutral" variant="soft">Not connected</Badge>
          )}
          {connected && status?.username && (
            <span style={{ fontSize: 12, color: 'var(--text-2)', fontFamily: 'var(--font-mono)' }}>{status.username}</span>
          )}
        </div>

        {status?.error && <div style={{ fontSize: 11.5, color: 'var(--danger)' }}>{status.error}</div>}

        {isAdmin && (!connected || editing) && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 360 }}>
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
          <div style={{ display: 'flex', gap: 8 }}>
            <Button size="sm" variant="secondary" onClick={() => { setEditing(true); setErr(null); }}>Change account</Button>
            <Button size="sm" variant="ghost" loading={busy} onClick={() => void disconnect()}>Disconnect</Button>
          </div>
        )}
        {!isAdmin && <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>Only an admin can connect AC Cloud.</div>}
      </div>
    </ConnectionRow>
  );
}

/* ============================================================================
 * Airzone — underfloor heating via the Local API (LAN, no auth). Shown as a row
 * in the Connections list; expands to edit the webserver host/IP. Status is a
 * live read-only probe (any user); saving the host is admin-only and validated.
 * ==========================================================================*/

function AirzoneConnection({ first, open, onToggle, cfg, reload }: { first?: boolean; open: boolean; onToggle: () => void; cfg: IntegrationsConfig | null; reload: () => void }) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [status, setStatus] = useState<ProbeResult | null>(null);
  const [checked, setChecked] = useState(false);
  const [host, setHost] = useState('');
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [res, setRes] = useState<ProbeResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Seed the host field once config arrives.
  useEffect(() => {
    if (cfg?.airzone.host) setHost(cfg.airzone.host);
  }, [cfg?.airzone.host]);

  // Live status for the row (read-only probe of the configured host).
  useEffect(() => {
    api.integrations.testAirzone().then(setStatus).catch(() => {}).finally(() => setChecked(true));
  }, []);

  const run = async (kind: 'test' | 'save') => {
    setBusy(kind); setErr(null); setRes(null);
    try {
      if (kind === 'test') setRes(await api.integrations.testAirzone(host.trim()));
      else {
        const r = await api.integrations.setAirzone(host.trim());
        setRes({ ok: r.ok, detail: r.detail });
        setStatus({ ok: r.ok, detail: r.detail }); // refresh the row
        reload();
      }
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(null); }
  };

  const statusText = !checked ? 'loading…' : status ? (status.ok ? status.detail : 'unreachable') : 'underfloor heating';
  const statusTone = !checked ? 'text-3' : status?.ok ? 'solar' : status ? 'grid' : 'text-2';

  return (
    <ConnectionRow
      first={first}
      icon="thermometer-sun"
      tone={status?.ok ? 'solar' : undefined}
      name="Airzone"
      statusText={statusText}
      statusTone={statusTone}
      showDot={status !== null}
      open={open}
      onToggle={onToggle}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={cfgDesc}>Airzone underfloor heating — per-room control over the Local API on the home network.</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <DetailLine label="Status" value={status ? status.detail : '—'} tone={status?.ok ? 'solar' : 'grid'} />
          {cfg && <DetailLine label="Webserver" value={`${cfg.airzone.host}:3000`} />}
        </div>
        {isAdmin ? (
          <>
            <Input label="Webserver host / IP" value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.165" />
            <ResultLine r={res} err={err} />
            <div style={{ display: 'flex', gap: 8 }}>
              <Button size="sm" variant="secondary" loading={busy === 'test'} onClick={() => void run('test')}>Test</Button>
              <Button size="sm" variant="primary" loading={busy === 'save'} onClick={() => void run('save')}>Save</Button>
            </div>
          </>
        ) : (
          <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>Only an admin can change the Airzone host.</div>
        )}
      </div>
    </ConnectionRow>
  );
}

/* ============================================================================
 * Rain Bird — irrigation controller (ESP-TM2 + LNK/LNK2 WiFi module) on the LAN.
 * Host is prefilled with the known module IP; the PASSWORD is required and never
 * leaves the server (we only learn whether one is set). The backend PROBES the box
 * (model/version) before persisting, mirroring Airzone/Sonnen.
 * ==========================================================================*/

function RainbirdConnection({ first, open, onToggle }: { first?: boolean; open: boolean; onToggle: () => void }) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [status, setStatus] = useState<RainbirdIntegrationStatus | null>(null);
  const [checked, setChecked] = useState(false);
  const [host, setHost] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [res, setRes] = useState<ProbeResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = () => {
    api.integrations
      .rainbirdStatus()
      .then((s) => {
        setStatus(s);
        if (s.host && !host) setHost(s.host);
      })
      .catch(() => {})
      .finally(() => setChecked(true));
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (kind: 'test' | 'save') => {
    setBusy(kind); setErr(null); setRes(null);
    try {
      if (kind === 'test') {
        const r = await api.integrations.testRainbird(host.trim(), password || undefined);
        setRes(r);
        // If the scan located the controller at a different IP, fill it in so the
        // owner can just hit Save.
        if (r.suggestedHost) setHost(r.suggestedHost);
      } else {
        const r = await api.integrations.setRainbird(host.trim(), password || undefined);
        setRes({ ok: r.ok, detail: r.detail });
        setPassword(''); // never keep the entered secret in component state
        load();
      }
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(null); }
  };

  const connected = status?.connected ?? false;
  const probe = status?.status ?? null;
  const statusText = !checked
    ? 'loading…'
    : !connected
      ? 'not connected'
      : probe
        ? (probe.ok ? probe.detail : 'unreachable')
        : 'sprinkler controller';
  const statusTone = !checked ? 'text-3' : connected && probe?.ok ? 'solar' : connected ? 'grid' : 'text-2';

  return (
    <ConnectionRow
      first={first}
      icon="droplets"
      tone={connected && probe?.ok ? 'solar' : undefined}
      name="Rain Bird"
      statusText={statusText}
      statusTone={statusTone}
      showDot={checked}
      open={open}
      onToggle={onToggle}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={cfgDesc}>
          Rain Bird ESP-TM2 sprinkler controller with an LNK / LNK2 WiFi module — local
          watering control over the home network. A password is required. If the IP is
          wrong, Test scans your network to find the controller.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <DetailLine label="Status" value={probe ? probe.detail : connected ? 'connected' : 'not connected'} tone={probe?.ok ? 'solar' : 'grid'} />
          {status?.host && <DetailLine label="Host" value={status.host} />}
          {status?.info && <DetailLine label="Serial" value={status.info.serialNumber} />}
          <DetailLine label="Password" value={status?.hasPassword ? 'set' : 'not set'} tone={status?.hasPassword ? 'solar' : 'text-3'} />
        </div>
        {isAdmin ? (
          <>
            <Input label="Module host / IP" value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.158" />
            <Input
              label="Controller password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={status?.hasPassword ? '•••••••• (unchanged)' : 'enter password'}
            />
            <ResultLine r={res} err={err} />
            <div style={{ display: 'flex', gap: 8 }}>
              <Button size="sm" variant="secondary" loading={busy === 'test'} onClick={() => void run('test')}>Test</Button>
              <Button size="sm" variant="primary" loading={busy === 'save'} onClick={() => void run('save')}>Save</Button>
            </div>
          </>
        ) : (
          <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>Only an admin can connect Rain Bird.</div>
        )}
      </div>
    </ConnectionRow>
  );
}

/* ============================================================================
 * Tuya — Cloud project (lights first; covers/switches/breakers/fans to follow).
 * Admin enters the datacenter region + Access ID/Secret from their iot.tuya.com
 * project (with the Smart-Life app account linked). The backend validates by
 * fetching a token + discovering devices BEFORE persisting, and never logs the
 * secret. Once connected, the Lights screen shows the fleet.
 * ==========================================================================*/

const TUYA_REGIONS = [
  { value: 'eu', label: 'Central Europe (eu)' },
  { value: 'weu', label: 'Western Europe (weu)' },
  { value: 'us', label: 'Western America (us)' },
  { value: 'eus', label: 'Eastern America (eus)' },
  { value: 'cn', label: 'China (cn)' },
  { value: 'in', label: 'India (in)' },
];

function TuyaConnection({ first, open, onToggle }: { first?: boolean; open: boolean; onToggle: () => void }) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const navigate = useNavigate();
  const [status, setStatus] = useState<TuyaIntegrationStatus | null>(null);
  const [region, setRegion] = useState('eu');
  const [accessId, setAccessId] = useState('');
  const [accessSecret, setAccessSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const load = async () => {
    try {
      const s = await api.integrations.tuyaStatus();
      setStatus(s);
      if (s.region) setRegion(s.region);
    } catch {
      /* ignore — shows as not-connected */
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const connect = async () => {
    if (!accessId.trim() || !accessSecret.trim()) {
      setErr('Enter your Tuya Access ID and Access Secret');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const s = await api.integrations.tuyaConnect(region, accessId.trim(), accessSecret.trim());
      setStatus(s);
      setAccessSecret('');
      setEditing(false);
    } catch (e) {
      setErr((e as Error).message || 'Could not connect — check your credentials and region');
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await api.integrations.tuyaDisconnect();
      await load();
      setAccessSecret('');
    } finally {
      setBusy(false);
    }
  };

  const connected = status?.connected ?? false;
  const statusText =
    status === null ? 'loading…' : connected ? `connected · ${status.lightCount} lights` : 'not connected';
  const statusTone = status === null ? 'text-3' : connected ? 'solar' : 'grid';

  return (
    <ConnectionRow
      first={first}
      icon="lightbulb"
      tone={connected ? 'solar' : undefined}
      name="Tuya"
      statusText={statusText}
      statusTone={statusTone}
      showDot={status !== null}
      open={open}
      onToggle={onToggle}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5 }}>
          Smart-Life / Tuya devices via a Tuya IoT Cloud project. One project unlocks the whole linked fleet — lights are supported now; more categories to come.
        </div>

        {connected && status && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Badge tone="solar" variant="soft" icon={<Icon name="check" size={11} />}>
              {status.deviceCount} devices · {status.lightCount} lights
            </Badge>
            {status.categories.map((c) => (
              <span key={c.label} style={{ fontSize: 11.5, color: 'var(--text-2)', background: 'var(--surface-2)', borderRadius: 'var(--radius-pill)', padding: '2px 9px' }}>
                {c.label} · {c.count}
              </span>
            ))}
          </div>
        )}

        {connected && status && (
          <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
            {status.deviceCount} device{status.deviceCount === 1 ? '' : 's'} connected · {status.deviceCount - (status.needsSetupCount ?? 0)} configured · {status.needsSetupCount ?? 0} not yet configured
          </div>
        )}

        {connected && (status?.needsSetupCount ?? 0) > 0 && (
          <button
            type="button"
            onClick={() => navigate('/devices?type=needs-setup')}
            style={{ display: 'flex', alignItems: 'center', gap: 7, alignSelf: 'flex-start', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--grid)', fontSize: 12.5, fontWeight: 600 }}
          >
            <Icon name="sparkles" size={13} />
            {status!.needsSetupCount} device{status!.needsSetupCount === 1 ? '' : 's'} not yet set up
            <Icon name="arrow-right" size={13} />
          </button>
        )}

        {status?.error && <div style={{ fontSize: 11.5, color: 'var(--danger)' }}>{status.error}</div>}

        {isAdmin && (!connected || editing) && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 360 }}>
            <Select label="Datacenter region" options={TUYA_REGIONS} value={region} onChange={(e) => setRegion(e.target.value)} />
            <Input label="Access ID" type="text" autoComplete="off" value={accessId} onChange={(e) => setAccessId(e.target.value)} placeholder="Tuya Cloud project Access ID" />
            <Input label="Access Secret" type="password" autoComplete="off" value={accessSecret} onChange={(e) => setAccessSecret(e.target.value)} placeholder="••••••••" />
            {err && <div style={{ fontSize: 11.5, color: 'var(--danger)' }}>{err}</div>}
            <div style={{ display: 'flex', gap: 8 }}>
              <Button size="sm" variant="primary" loading={busy} onClick={() => void connect()}>{connected ? 'Re-connect' : 'Connect'}</Button>
              {connected && <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setErr(null); }}>Cancel</Button>}
            </div>
          </div>
        )}

        {isAdmin && connected && !editing && (
          <div style={{ display: 'flex', gap: 8 }}>
            <Button size="sm" variant="secondary" onClick={() => { setEditing(true); setErr(null); }}>Change project</Button>
            <Button size="sm" variant="ghost" loading={busy} onClick={() => void disconnect()}>Disconnect</Button>
          </div>
        )}
        {!isAdmin && <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>Only an admin can connect Tuya.</div>}
      </div>
    </ConnectionRow>
  );
}

/* ============================================================================
 * Sonos — the house-alarm speakers, discovered over LOCAL UPnP (no account/login).
 * Enabled by default; a seed IP is the robust path on multi-NIC hosts where SSDP
 * multicast is blocked. A Re-scan re-runs discovery. Admin-only writes.
 * ==========================================================================*/

function SonosConnection({ first, open, onToggle }: { first?: boolean; open: boolean; onToggle: () => void }) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [status, setStatus] = useState<SonosIntegrationStatus | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [seedIp, setSeedIp] = useState('');
  const [busy, setBusy] = useState<'save' | 'rescan' | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    try {
      const s = await api.integrations.sonosStatus();
      setStatus(s);
      setEnabled(s.enabled);
      setSeedIp(s.seedIp ?? '');
    } catch {
      /* shows as not-connected */
    }
  };
  useEffect(() => { void load(); }, []);

  const save = async () => {
    setBusy('save'); setErr(null);
    try {
      const s = await api.integrations.setSonos(enabled, seedIp.trim() || undefined);
      setStatus(s);
    } catch (e) {
      setErr((e as Error).message || 'Could not save');
    } finally {
      setBusy(null);
    }
  };
  const rescan = async () => {
    setBusy('rescan'); setErr(null);
    try {
      await api.integrations.rescanSonos();
      await load();
    } catch (e) {
      setErr((e as Error).message || 'Re-scan failed');
    } finally {
      setBusy(null);
    }
  };

  const count = status?.discoveredCount ?? 0;
  const statusText = status === null ? 'loading…' : !status.enabled ? 'off' : count > 0 ? `${count} speaker${count === 1 ? '' : 's'}` : 'no speakers found';
  const statusTone = status === null ? 'text-3' : !status.enabled ? 'grid' : count > 0 ? 'solar' : 'grid';

  return (
    <ConnectionRow
      first={first}
      icon="volume-2"
      tone={count > 0 ? 'solar' : undefined}
      name="Sonos"
      statusText={statusText}
      statusTone={statusTone}
      showDot={status !== null}
      open={open}
      onToggle={onToggle}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5 }}>
          Sonos speakers for the house alarm — discovered over local UPnP on the home network. No Sonos account or login needed.
        </div>

        {status?.enabled && count > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Badge tone="solar" variant="soft" icon={<Icon name="check" size={11} />}>{count} discovered</Badge>
            {status.names.slice(0, 8).map((n) => (
              <span key={n} style={{ fontSize: 11.5, color: 'var(--text-2)', background: 'var(--surface-2)', borderRadius: 'var(--radius-pill)', padding: '2px 9px' }}>{n}</span>
            ))}
          </div>
        )}

        {status?.lastError && <div style={{ fontSize: 11.5, color: 'var(--danger)' }}>{status.lastError}</div>}
        {err && <div style={{ fontSize: 11.5, color: 'var(--danger)' }}>{err}</div>}

        {isAdmin ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 360 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--text-1)' }}>
              <Switch checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              Sonos enabled
            </label>
            <Input
              label="Seed IP (optional)"
              type="text"
              autoComplete="off"
              value={seedIp}
              onChange={(e) => setSeedIp(e.target.value)}
              placeholder="e.g. 192.168.1.149"
            />
            <div style={{ fontSize: 11, color: 'var(--text-3)', lineHeight: 1.5 }}>
              On a host with more than one network adapter, multicast discovery can fail — set any one speaker's IP here for reliable topology-based discovery.
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <Button size="sm" variant="primary" loading={busy === 'save'} onClick={() => void save()}>Save</Button>
              <Button size="sm" variant="secondary" loading={busy === 'rescan'} onClick={() => void rescan()}>Re-scan</Button>
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>Only an admin can change Sonos settings.</div>
        )}
      </div>
    </ConnectionRow>
  );
}

/* ============================================================================
 * House alarm — owner-configurable defaults for the house alarm (siren + light
 * blink). Lives in Settings → Notifications (alongside the channels + grid-voltage
 * alert). The alarm is triggered from the nav alarm button (everywhere); this card
 * configures what it does. Web + mobile responsive. Admin-only writes.
 * ==========================================================================*/

function AlarmPanicCard() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [cfg, setCfg] = useState<AlarmConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.alarm.config().then((r) => setCfg(r.config)).catch(() => {});
  }, []);

  if (!cfg) {
    return <Card title="House alarm"><div style={{ padding: '4px 16px 16px', fontSize: 13, color: 'var(--text-3)' }}>Loading…</div></Card>;
  }

  const patch = (p: Partial<AlarmConfig>) => setCfg((c) => (c ? { ...c, ...p } : c));
  const save = async () => {
    if (!cfg) return;
    setBusy(true); setSaved(false);
    try {
      // Enforce the blink floor client-side too (the API also clamps).
      const blinkMs = Math.max(ALARM_BLINK_FLOOR_MS, Math.round(cfg.blinkMs));
      const r = await api.alarm.setConfig({ ...cfg, blinkMs });
      setCfg(r.config);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setBusy(false);
    }
  };

  const blinkHz = (1000 / Math.max(ALARM_BLINK_FLOOR_MS, cfg.blinkMs)).toFixed(1);

  return (
    <Card title="House alarm">
      <div style={{ padding: '4px 16px 16px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5 }}>
          The alarm button (in the navigation bar) sounds a siren on your Sonos speakers and blinks your lights until stopped. Configure the defaults here.
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13.5, color: 'var(--text-1)', fontWeight: 500 }}>
          <Switch checked={cfg.enabled} disabled={!isAdmin} onChange={(e) => patch({ enabled: e.target.checked })} />
          House alarm enabled
        </label>

        <div style={{ opacity: cfg.enabled ? 1 : 0.5, pointerEvents: cfg.enabled && isAdmin ? 'auto' : 'none', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <Slider label="Siren volume" min={0} max={100} value={cfg.volumePct} unit="%" onChange={(v) => patch({ volumePct: v })} />
          </div>

          <div>
            <Slider
              label={`Light blink rate · ${blinkHz} Hz`}
              min={ALARM_BLINK_FLOOR_MS}
              max={2000}
              value={cfg.blinkMs}
              showValue={false}
              onChange={(v) => patch({ blinkMs: Math.max(ALARM_BLINK_FLOOR_MS, v) })}
            />
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
              {cfg.blinkMs} ms on / {cfg.blinkMs} ms off. Floor {ALARM_BLINK_FLOOR_MS} ms — lights are cloud-controlled and can't blink faster reliably.
            </div>
          </div>

          <div>
            <Input
              label="Auto-stop after (seconds, 0 = never)"
              type="number"
              value={String(cfg.autoStopSec)}
              onChange={(e) => patch({ autoStopSec: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
            />
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
              Safety cap so a forgotten alarm self-stops. The primary stop is always the manual STOP button.
            </div>
          </div>

          <div style={{ fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.5 }}>
            Scope: all discovered speakers and all lights are included by default. (Per-device selection is coming; today the alarm sounds everywhere.)
          </div>
        </div>

        {isAdmin ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Button size="sm" variant="primary" loading={busy} onClick={() => void save()}>Save</Button>
            {saved && <span style={{ fontSize: 12, color: 'var(--solar)' }}>✓ Saved</span>}
          </div>
        ) : (
          <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>Only an admin can change the alarm settings.</div>
        )}
      </div>
    </Card>
  );
}

/** Connections card — single-open accordion across all integrations. */
function ConnectionsCard({ connections }: { connections: SettingsResponse['connections'] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [cfg, setCfg] = useState<IntegrationsConfig | null>(null);
  const loadCfg = () => {
    api.integrations.config().then(setCfg).catch(() => {
      /* leave null — panels fall back to read-only info */
    });
  };
  useEffect(() => {
    loadCfg();
  }, []);
  const toggle = (id: string) => setOpenId((cur) => (cur === id ? null : id));
  return (
    <Card title="Connections" style={{ padding: 0 }}>
      {connections.map((c, i) => {
        const ok = !/pending|offline/i.test(c.status);
        return (
          <ConnectionRow
            key={c.name}
            first={i === 0}
            icon={c.icon}
            tone={c.tone}
            name={c.name}
            statusText={c.status}
            statusTone={ok ? 'solar' : 'grid'}
            open={openId === c.name}
            onToggle={() => toggle(c.name)}
          >
            <ConnectionPanel conn={c} ok={ok} cfg={cfg} reload={loadCfg} />
          </ConnectionRow>
        );
      })}
      <AcCloudConnection first={false} open={openId === 'accloud'} onToggle={() => toggle('accloud')} />
      <AirzoneConnection first={false} open={openId === 'airzone'} onToggle={() => toggle('airzone')} cfg={cfg} reload={loadCfg} />
      <RainbirdConnection first={false} open={openId === 'rainbird'} onToggle={() => toggle('rainbird')} />
      <TuyaConnection first={false} open={openId === 'tuya'} onToggle={() => toggle('tuya')} />
      <SonosConnection first={false} open={openId === 'sonos'} onToggle={() => toggle('sonos')} />
    </Card>
  );
}

export function Settings({ ctx }: { ctx: ShellContext }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [installOpen, setInstallOpen] = useState(false);
  const [scenesOpen, setScenesOpen] = useState(false);
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <ConnectionsCard connections={s.connections} />
        </div>
      )}

      {active === 'Notifications' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <NotificationsCard channels={ch} onChannels={setChannels} />
          <AlertRulesCard />
          <VoltageMonitorCard />
          <AlarmPanicCard />
        </div>
      )}

      {active === 'Security' && <SecurityCard />}

      {active === 'Users' && isAdmin && <UsersSection />}

      {active === 'System' && (
        <>
          <Suspense fallback={null}>
            <SiteLocationCard />
          </Suspense>

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
            <LinkRow first icon="layout-grid" tone="solar" name="Rooms" detail="Organize devices by room" onClick={() => navigate('/rooms')} right={<Chev />} />
            {isAdmin && (
              <LinkRow icon="sparkles" tone="home" name="Scenes" detail="One-tap whole-home presets for the wall tablet" onClick={() => setScenesOpen(true)} right={<Chev />} />
            )}
            {s.assets.map((a) => (
              <LinkRow key={a.name} icon={a.icon} tone={a.tone} name={a.name} detail={a.detail} right={<Chev />} />
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
            <ThemeRow />
            {isAdmin && <KioskRow />}
            <LinkRow icon="info" tone="text-2" name="Version" detail="0.1.0 · energy.hirobo.nl" />
          </Card>
        </>
      )}
    </>
  );

  // Autopilot-style layout: a full-width SegmentedControl tab bar in the page body,
  // content beneath. The desktop TopBar supplies the eyebrow + "System" title (so no
  // page header on desktop); mobile (no TopBar) renders its own header.
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 820, margin: '0 auto', width: '100%', padding: ctx.desktop ? 0 : '8px 14px 22px' }}>
      {!ctx.desktop && <ScreenHeader eyebrow="Settings" title="System" padding="4px 2px 0" />}
      {stale && <StaleBanner updatedAt={updatedAt} />}
      <SegmentedControl block options={tabs} value={active} onChange={ctx.setSettingsTab} />
      {sections}
      {installOpen && <InstallSheet onClose={() => setInstallOpen(false)} />}
      {isAdmin && <HomeSceneBuilder open={scenesOpen} onClose={() => setScenesOpen(false)} />}
    </div>
  );
}
