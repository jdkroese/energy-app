import { lazy, Suspense, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { api, auth, ApiError } from '../lib/api';
import { usePolling } from '../lib/usePolling';
import { MOCK_SETTINGS } from '../lib/mock';
import type { Channels, ChannelType, IntegrationsConfig, IntegrationStatus, KitchenIntelligence, MercadonaAccountStatus, MercadonaStatus, OtpChannel, ProbeResult, RainbirdIntegrationStatus, SettingsResponse, SessionsResponse, TuyaIntegrationStatus, SonosIntegrationStatus, SpotifyStatus, AlarmConfig, UserRole, AuthUser } from '../lib/types';
import { ALARM_BLINK_FLOOR_MS } from '../lib/types';
import { Card, Icon, Eyebrow, Switch, Input, Button, Select, Badge, Slider, ScreenHeader } from '../components/ui';
import { StaleBanner } from './_shared';
import { AlertRulesCard, VoltageMonitorCard, EventMonitorsCard } from '../components/Notifications';
import { enablePush, getPushStatus, type PushStatus } from '../lib/push';
import { InstallSheet } from '../components/InstallSheet';
import { HomeSceneBuilder } from '../components/home/HomeSceneBuilder';
import { isStandalone } from '../lib/install';
import { useAuth } from '../auth/AuthProvider';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { SegmentedControl } from '../components/ui';
import type { ShellContext } from '../components/shell/AppShell';
import { settingsTabsFor, type SettingsTabLabel } from '../components/shell/nav';
import { Autopilot } from './Autopilot';
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
 * Sungrow — solar inverters (SG5.0RS ×2, one WiNet-S dongle each) on the LAN.
 * READ-ONLY monitoring (docs/36). Two dongle-IP fields; the backend probes each via
 * the open local product endpoint before persisting. Distinguishes "asleep" (night —
 * both dongles down, expected) from "offline" so the row isn't a scary red every night.
 * ==========================================================================*/

function SungrowConnection({ first, open, onToggle, cfg, reload }: { first?: boolean; open: boolean; onToggle: () => void; cfg: IntegrationsConfig | null; reload: () => void }) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [status, setStatus] = useState<ProbeResult | null>(null);
  const [checked, setChecked] = useState(false);
  const [ip1, setIp1] = useState('');
  const [ip2, setIp2] = useState('');
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [res, setRes] = useState<ProbeResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Seed the dongle-IP fields once config arrives.
  useEffect(() => {
    const d = cfg?.sungrow.dongles ?? [];
    if (d[0]?.ip) setIp1(d[0].ip);
    if (d[1]?.ip) setIp2(d[1].ip);
  }, [cfg?.sungrow.dongles]);

  // Live status for the row (read-only probe of the configured dongles).
  useEffect(() => {
    api.integrations.testSungrow().then(setStatus).catch(() => {}).finally(() => setChecked(true));
  }, []);

  const dongles = () => {
    const out: { ip: string; name?: string }[] = [];
    if (ip1.trim()) out.push({ ip: ip1.trim(), name: 'Solar Inverter 1' });
    if (ip2.trim()) out.push({ ip: ip2.trim(), name: 'Solar Inverter 2' });
    return out;
  };

  const run = async (kind: 'test' | 'save') => {
    setBusy(kind); setErr(null); setRes(null);
    try {
      if (kind === 'test') setRes(await api.integrations.testSungrow(dongles()));
      else {
        const r = await api.integrations.setSungrow(dongles());
        setRes({ ok: r.ok, detail: r.detail });
        setStatus({ ok: r.ok, detail: r.detail });
        reload();
      }
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(null); }
  };

  // A reachable probe = producing (day). An unreachable probe at NIGHT is expected
  // (both dongles sleep), so show it calmly rather than as a hard error.
  const statusText = !checked ? 'loading…' : status ? (status.ok ? status.detail : 'asleep / unreachable') : '2 inverters';
  const statusTone = !checked ? 'text-3' : status?.ok ? 'solar' : status ? 'grid' : 'text-2';

  return (
    <ConnectionRow
      first={first}
      icon="sun"
      tone={status?.ok ? 'solar' : undefined}
      name="Sungrow"
      statusText={statusText}
      statusTone={statusTone}
      showDot={status !== null}
      open={open}
      onToggle={onToggle}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={cfgDesc}>Sungrow SG5.0RS ×2 (Array A) — read over each WiNet-S dongle on the home network. Read-only; the inverters sleep at night, which is normal.</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <DetailLine label="Status" value={status ? status.detail : '—'} tone={status?.ok ? 'solar' : 'grid'} />
          {(cfg?.sungrow.dongles ?? []).map((d, i) => (
            <DetailLine
              key={d.ip || i}
              label={d.name || `Inverter ${i + 1}`}
              value={`${d.ip}${d.lastSeen ? ` · seen ${relTime(d.lastSeen)}` : ' · never seen'}`}
              tone={d.lastSeen ? undefined : 'text-3'}
            />
          ))}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.5, background: 'var(--surface-3)', borderRadius: 8, padding: '8px 10px' }}>
          <strong style={{ color: 'var(--text-2)' }}>Tip:</strong> set a DHCP reservation on your router for each dongle's MAC address so these IPs never change. A WiNet-S dongle that moves to a new IP looks "offline" here — a reservation prevents that.
        </div>
        {isAdmin ? (
          <>
            <Input label="Dongle 1 host / IP" value={ip1} onChange={(e) => setIp1(e.target.value)} placeholder="192.168.1.67" />
            <Input label="Dongle 2 host / IP" value={ip2} onChange={(e) => setIp2(e.target.value)} placeholder="192.168.1.181" />
            <ResultLine r={res} err={err} />
            <div style={{ display: 'flex', gap: 8 }}>
              <Button size="sm" variant="secondary" loading={busy === 'test'} onClick={() => void run('test')}>Test</Button>
              <Button size="sm" variant="primary" loading={busy === 'save'} onClick={() => void run('save')}>Save</Button>
            </div>
          </>
        ) : (
          <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>Only an admin can change the Sungrow dongle IPs.</div>
        )}
      </div>
    </ConnectionRow>
  );
}

/* ============================================================================
 * iSolarCloud — the LAN-independent CLOUD backstop for the Sungrow inverters
 * (docs/44, Phase B). A crashed WiNet-S dongle or a home-LAN outage no longer blinds
 * outage detection: the cloud is the source of truth for "an inverter is dark". GATED —
 * disabled until the owner enters their OpenAPI credentials (appkey + access key + RSA
 * public key + account). Secrets are write-only from the UI and never returned. Test/Save
 * authenticate against the real OpenAPI before persisting.
 * ==========================================================================*/

function IsolarcloudConnection({ first, open, onToggle, cfg, reload }: { first?: boolean; open: boolean; onToggle: () => void; cfg: IntegrationsConfig | null; reload: () => void }) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const isc = cfg?.isolarcloud;
  const [appkey, setAppkey] = useState('');
  const [accessKey, setAccessKey] = useState('');
  const [rsaPublicKey, setRsaPublicKey] = useState('');
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [region, setRegion] = useState('');
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [res, setRes] = useState<ProbeResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Seed the non-secret fields once config arrives (account/region are safe to echo).
  useEffect(() => {
    if (isc?.account && !account) setAccount(isc.account);
    if (isc?.region && !region) setRegion(isc.region);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isc?.account, isc?.region]);

  const payload = () => ({
    appkey: appkey.trim() || undefined,
    accessKey: accessKey.trim() || undefined,
    rsaPublicKey: rsaPublicKey.trim() || undefined,
    account: account.trim() || undefined,
    password: password || undefined,
    region: region.trim() || undefined,
  });

  const run = async (kind: 'test' | 'save') => {
    setBusy(kind); setErr(null); setRes(null);
    try {
      if (kind === 'test') setRes(await api.integrations.testIsolarcloud(payload()));
      else {
        const r = await api.integrations.setIsolarcloud(payload());
        setRes({ ok: r.ok, detail: r.detail });
        setPassword(''); // never keep the entered secret in component state
        reload();
      }
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(null); }
  };

  const configured = isc?.configured ?? false;
  const statusText = configured ? 'connected · cloud backstop' : 'not configured';
  const statusTone = configured ? 'solar' : 'text-3';

  return (
    <ConnectionRow
      first={first}
      icon="cloud"
      tone={configured ? 'solar' : undefined}
      name="iSolarCloud"
      statusText={statusText}
      statusTone={statusTone}
      showDot={cfg !== null}
      open={open}
      onToggle={onToggle}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={cfgDesc}>
          The Sungrow cloud (iSolarCloud OpenAPI) — a <strong style={{ color: 'var(--text-1)' }}>LAN-independent</strong> source
          of truth so a crashed WiNet-S dongle or a home-network outage never hides a tripped
          breaker. Read-only. Enter your OpenAPI credentials from developer-api.isolarcloud.com.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <DetailLine label="Status" value={configured ? 'configured' : 'not configured'} tone={configured ? 'solar' : 'text-3'} />
          <DetailLine label="Region" value={isc?.region || 'gateway.isolarcloud.eu'} />
          {isc?.account && <DetailLine label="Account" value={isc.account} />}
          <DetailLine label="App key" value={isc?.hasAppkey ? 'set' : 'not set'} tone={isc?.hasAppkey ? 'solar' : 'text-3'} />
          <DetailLine label="Access key" value={isc?.hasAccessKey ? 'set' : 'not set'} tone={isc?.hasAccessKey ? 'solar' : 'text-3'} />
          <DetailLine label="RSA key" value={isc?.hasRsaKey ? 'set' : 'not set'} tone={isc?.hasRsaKey ? 'solar' : 'text-3'} />
        </div>
        {isAdmin ? (
          <>
            <Input label="App key" value={appkey} onChange={(e) => setAppkey(e.target.value)} placeholder={isc?.hasAppkey ? '•••••••• (unchanged)' : 'OpenAPI appkey'} />
            <Input label="Access key (x-access-key)" value={accessKey} onChange={(e) => setAccessKey(e.target.value)} placeholder={isc?.hasAccessKey ? '•••••••• (unchanged)' : 'OpenAPI access key'} />
            <Input label="RSA public key (base64)" value={rsaPublicKey} onChange={(e) => setRsaPublicKey(e.target.value)} placeholder={isc?.hasRsaKey ? '•••••••• (unchanged)' : 'X.509 public key, base64'} />
            <Input label="Account (email)" value={account} onChange={(e) => setAccount(e.target.value)} placeholder="iSolarCloud login" />
            <Input label="Password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={configured ? '•••••••• (unchanged)' : 'iSolarCloud password'} />
            <Input label="Region host" value={region} onChange={(e) => setRegion(e.target.value)} placeholder="gateway.isolarcloud.eu" />
            <ResultLine r={res} err={err} />
            <div style={{ display: 'flex', gap: 8 }}>
              <Button size="sm" variant="secondary" loading={busy === 'test'} onClick={() => void run('test')}>Test</Button>
              <Button size="sm" variant="primary" loading={busy === 'save'} onClick={() => void run('save')}>Save</Button>
            </div>
          </>
        ) : (
          <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>Only an admin can configure the iSolarCloud backstop.</div>
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
 * Spotify (Music) — server-side OAuth (Authorization Code). The owner registers a
 * Spotify developer app, pastes Client ID + Client Secret here (secret write-only),
 * then Connect runs the consent flow. Playback targets the Sonos rooms (as Spotify
 * Connect devices). Browse/playback UI lives on the Speakers page; only the
 * credential/connect config lives here. Admin-only writes; no secret is ever
 * rendered back. Web + mobile responsive.
 * ==========================================================================*/

function SpotifyConnection({ first, open, onToggle }: { first?: boolean; open: boolean; onToggle: () => void }) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [status, setStatus] = useState<SpotifyStatus | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<'save' | 'connect' | 'disconnect' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = async () => {
    try {
      const s = await api.spotify.status();
      setStatus(s);
    } catch {
      /* shows as not-connected */
    }
  };
  useEffect(() => { void load(); }, []);

  // Surface the OAuth callback outcome (?spotify=connected | error:…) once, then clean the URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const r = params.get('spotify');
    if (!r) return;
    if (r.startsWith('error')) setErr(`Spotify connect failed — ${r.replace(/^error:?/, '') || 'try again'}`);
    void load();
    params.delete('spotify');
    const qs = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''));
  }, []);

  const saveCreds = async () => {
    if (!clientId.trim() || !clientSecret.trim()) { setErr('Enter your Client ID and Client Secret'); return; }
    setBusy('save'); setErr(null);
    try {
      const r = await api.spotify.setCredentials(clientId.trim(), clientSecret.trim());
      setStatus(r.status);
      setClientSecret('');
      setEditing(false);
    } catch (e) {
      setErr((e as Error).message || 'Could not save credentials');
    } finally { setBusy(null); }
  };

  const connect = async () => {
    setBusy('connect'); setErr(null);
    try {
      const r = await api.spotify.authUrl();
      // Full-page redirect to Spotify's consent screen; it returns to /api/spotify/callback.
      window.location.href = r.url;
    } catch (e) {
      setErr((e as Error).message || 'Could not start the Spotify connect flow');
      setBusy(null);
    }
  };

  const disconnect = async () => {
    setBusy('disconnect'); setErr(null);
    try { await api.spotify.disconnect(); await load(); setClientSecret(''); } finally { setBusy(null); }
  };

  const copyRedirect = () => {
    if (!status?.redirectUri) return;
    void navigator.clipboard?.writeText(status.redirectUri).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {});
  };

  const configured = status?.configured ?? false;
  const connected = status?.connected ?? false;
  const statusText = status === null ? 'loading…' : connected ? `connected${status.premium ? ' · Premium' : ''}` : configured ? 'not connected' : 'not set up';
  const statusTone = status === null ? 'text-3' : connected ? 'solar' : 'grid';

  return (
    <ConnectionRow
      first={first}
      icon="music"
      tone={connected ? 'solar' : undefined}
      name="Spotify"
      statusText={statusText}
      statusTone={statusTone}
      showDot={status !== null}
      open={open}
      onToggle={onToggle}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5 }}>
          Play Spotify on your Sonos speakers via the Spotify Web API. Register a Spotify developer app, paste its Client ID + Secret below, then Connect. Spotify Premium is required for playback on speakers.
        </div>

        {connected && status && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Badge tone="solar" variant="soft" icon={<Icon name="check" size={11} />}>
              {status.displayName ? `Connected · ${status.displayName}` : 'Connected'}
            </Badge>
            {status.premium
              ? <Badge tone="solar" variant="soft">Premium</Badge>
              : <Badge tone="neutral" variant="soft">Free — playback disabled</Badge>}
          </div>
        )}

        {/* Redirect URI to register — always shown so setup is copy-paste. */}
        {status?.redirectUri && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span className="pwr-eyebrow">Redirect URI to register in your Spotify app</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <code style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: 'var(--text-2)', background: 'var(--surface-2)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', padding: '7px 10px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{status.redirectUri}</code>
              <Button size="sm" variant="ghost" onClick={copyRedirect}>{copied ? 'Copied' : 'Copy'}</Button>
            </div>
          </div>
        )}

        {err && <div style={{ fontSize: 11.5, color: 'var(--danger)' }}>{err}</div>}

        {isAdmin ? (
          <>
            {(!configured || editing) && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 380 }}>
                <Input label="Client ID" type="text" autoComplete="off" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="Spotify app Client ID" />
                <Input label="Client Secret" type="password" autoComplete="off" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder={configured ? '•••• set — enter to replace' : '••••••••'} />
                <div style={{ display: 'flex', gap: 8 }}>
                  <Button size="sm" variant="primary" loading={busy === 'save'} onClick={() => void saveCreds()}>Save credentials</Button>
                  {configured && <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setErr(null); setClientSecret(''); }}>Cancel</Button>}
                </div>
              </div>
            )}

            {configured && !editing && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {!connected && <Button size="sm" variant="primary" loading={busy === 'connect'} iconLeft={<Icon name="music" size={14} />} onClick={() => void connect()}>Connect Spotify</Button>}
                {connected && <Button size="sm" variant="secondary" loading={busy === 'connect'} onClick={() => void connect()}>Re-connect</Button>}
                <Button size="sm" variant="secondary" onClick={() => { setEditing(true); setErr(null); }}>Change app</Button>
                {connected && <Button size="sm" variant="ghost" loading={busy === 'disconnect'} onClick={() => void disconnect()}>Disconnect</Button>}
              </div>
            )}
          </>
        ) : (
          <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>Only an admin can connect Spotify.</div>
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

/**
 * Mercadona (Kitchen Hub, docs/38 + docs/39 + docs/41 P2) — grocery catalog connector
 * (read-only, anonymous) + the OPT-IN account link for cart fill: one-time manual
 * token bootstrap (login is reCAPTCHA-gated; Tesla-token pattern), then headless
 * renewal. Guardrails surfaced here: spend cap, dry-run toggle, Unlink kill switch.
 * The app NEVER checks out — the human picks the slot and pays in Mercadona.
 */
function MercadonaConnection({ first, open, onToggle }: { first?: boolean; open: boolean; onToggle: () => void }) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [status, setStatus] = useState<MercadonaStatus | null>(null);
  const [account, setAccount] = useState<MercadonaAccountStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [probed, setProbed] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [tokenDraft, setTokenDraft] = useState('');
  const [customerDraft, setCustomerDraft] = useState('');
  const [capDraft, setCapDraft] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const loadAccount = () => {
    api.kitchen
      .mercadonaAccount()
      .then((r) => {
        setAccount(r.account);
        setCapDraft(String(r.account.spendCapEur));
      })
      .catch(() => setAccount(null));
  };

  const probe = async () => {
    setBusy(true);
    try {
      setStatus(await api.kitchen.mercadonaStatus());
    } catch {
      setStatus(null);
    } finally {
      setBusy(false);
      setProbed(true);
    }
  };
  // Probe lazily on first expand (it does live Mercadona fetches — don't run on page load).
  useEffect(() => {
    if (open && isAdmin && !probed && !busy) void probe();
    if (open && !account) loadAccount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const flash = (msg: string) => {
    setSaved(msg);
    setTimeout(() => setSaved(null), 2200);
  };

  const link = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.kitchen.linkMercadona(tokenDraft.trim(), customerDraft.trim() || undefined);
      setAccount(r.account);
      setCapDraft(String(r.account.spendCapEur));
      setTokenDraft('');
      setCustomerDraft('');
      setLinkOpen(false);
      flash('Account linked ✓ — cart fill is live (dry-run off)');
    } catch (e) {
      setErr((e as Error).message || 'Link failed');
    } finally {
      setBusy(false);
    }
  };

  const unlink = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.kitchen.unlinkMercadona();
      setAccount(r.account);
      flash('Unlinked — tokens forgotten, cart fill disabled');
    } catch (e) {
      setErr((e as Error).message || 'Unlink failed');
    } finally {
      setBusy(false);
    }
  };

  const saveSettings = async (patch: { spendCapEur?: number; dryRun?: boolean }) => {
    setErr(null);
    try {
      const r = await api.kitchen.setMercadonaSettings(patch);
      setAccount(r.account);
      setCapDraft(String(r.account.spendCapEur));
      flash('Saved ✓');
    } catch (e) {
      setErr((e as Error).message || 'Save failed');
    }
  };

  const ok = Boolean(status?.ok);
  const accountLinked = Boolean(account?.linked);
  const statusText = !probed
    ? accountLinked
      ? `linked${account?.label ? ` · ${account.label}` : ''}`
      : 'catalog only'
    : busy
      ? 'checking…'
      : ok
        ? `connected · ${status?.warehouse ?? ''}${accountLinked ? ' · account linked' : ''}`
        : 'offline';
  return (
    <ConnectionRow
      first={first}
      icon="shopping-basket"
      tone={!probed || ok ? 'solar' : undefined}
      name="Mercadona"
      statusText={statusText}
      statusTone={!probed || ok ? 'solar' : 'grid'}
      open={open}
      onToggle={onToggle}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5 }}>
          Live grocery catalog, prices and photos for the Groceries order builder (read-only, anonymous — warehouse from
          postal code 03730 → Jávea, responses cached 30 min). Linking your account below additionally enables{' '}
          <b>cart fill</b>: the app batches your checked list into your real Mercadona cart; <b>you</b> pick the slot and
          pay — the app never checks out.
        </div>
        {status && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <DetailLine label="Status" value={ok ? 'connected' : status.detail ?? 'unreachable'} tone={ok ? 'solar' : 'grid'} />
            <DetailLine label="Store" value={status.warehouse ?? 'unresolved'} />
            <DetailLine label="Search" value={status.searchOk ? 'ok (Algolia)' : 'degraded — category walk'} tone={status.searchOk ? 'solar' : 'grid'} />
            <DetailLine label="Probe" value={`${status.products ?? '?'} products in the first category · ${status.latencyMs} ms`} />
          </div>
        )}

        {/* ---- Account (cart fill) — docs/41 §1 ---- */}
        <div style={{ borderTop: '1px solid var(--border-1)', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--text-3)' }}>
            Account · cart fill
          </div>
          {accountLinked && account ? (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <DetailLine label="Linked as" value={account.label ?? account.customerIdMasked ?? 'Mercadona account'} tone="solar" />
                <DetailLine
                  label="Token health"
                  value={
                    account.lastRefreshOk === false
                      ? 'refresh failing — re-link if it persists'
                      : `ok · rotated ${account.lastRefreshAt ? new Date(account.lastRefreshAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'at link time'}`
                  }
                  tone={account.lastRefreshOk === false ? 'grid' : 'solar'}
                />
                <DetailLine label="Refresh token" value={account.tokenMasked ?? '—'} />
              </div>
              {isAdmin && (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <Input
                      label="Spend cap (€, server-enforced)"
                      type="number"
                      value={capDraft}
                      onChange={(e) => setCapDraft(e.target.value)}
                      style={{ width: 120 }}
                    />
                    <Button size="sm" variant="secondary" onClick={() => void saveSettings({ spendCapEur: Math.round(Number(capDraft) || 150) })}>
                      Save cap
                    </Button>
                  </div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
                    <Switch checked={account.dryRun} onChange={(e) => void saveSettings({ dryRun: e.target.checked })} />
                    Dry-run mode — build &amp; show the payload, send nothing
                  </label>
                  <div>
                    <Button size="sm" variant="danger" loading={busy} onClick={() => void unlink()}>
                      Unlink account
                    </Button>
                    <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
                      The kill switch: forgets the tokens immediately and re-arms dry-run.
                    </div>
                  </div>
                </>
              )}
            </>
          ) : isAdmin ? (
            <>
              {!linkOpen ? (
                <div>
                  <Button size="sm" variant="primary" onClick={() => setLinkOpen(true)}>
                    Link account…
                  </Button>
                  <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
                    One-time, ~2 minutes. Until then the Fill-cart button runs in dry-run (payload preview only).
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, background: 'var(--surface-2)', borderRadius: 'var(--radius-md)', padding: '12px 14px' }}>
                  <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.6 }}>
                    Mercadona's login has a captcha, so the link is a one-time manual copy (exactly like the Tesla
                    token). After this the app renews the session by itself.
                    <ol style={{ margin: '8px 0 0', paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <li>
                        On a computer, open <b>tienda.mercadona.es</b> in Chrome and <b>log in</b> as usual.
                      </li>
                      <li>
                        Press <b>F12</b> to open DevTools → <b>Application</b> tab → left sidebar <b>Local storage</b> →
                        click <b>https://tienda.mercadona.es</b>.
                      </li>
                      <li>
                        In the list, find the entry whose name contains <b>refresh</b> (e.g. “refresh_token”). Its value
                        is a long text starting with <b>ey…</b> — double-click it, select all, copy.
                      </li>
                      <li>
                        Can't find it? Alternative: DevTools → <b>Network</b> tab → type <b>tokens</b> in the filter →
                        reload the page → click the <b>tokens/</b> request → <b>Response</b> tab → copy the{' '}
                        <b>refresh_token</b> value (without the quotes).
                      </li>
                      <li>Paste it below and press Link. Done — you can close DevTools.</li>
                    </ol>
                  </div>
                  <Input
                    label="Refresh token"
                    type="password"
                    placeholder="ey…"
                    value={tokenDraft}
                    onChange={(e) => setTokenDraft(e.target.value)}
                  />
                  <Input
                    label="Customer id (optional — usually read from the token)"
                    placeholder="only if the link asks for it"
                    value={customerDraft}
                    onChange={(e) => setCustomerDraft(e.target.value)}
                  />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Button size="sm" variant="primary" loading={busy} disabled={!tokenDraft.trim()} onClick={() => void link()}>
                      Link account
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setLinkOpen(false)}>
                      Cancel
                    </Button>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-3)', lineHeight: 1.5 }}>
                    The token is validated against Mercadona before anything is stored, lives only in the server's
                    private state, is never logged and is always shown masked. Guardrails once linked:{' '}
                    {account?.spendCapEur ?? 150} € spend cap, explicit confirm on every fill, human checkout, Unlink
                    kill switch.
                  </div>
                </div>
              )}
            </>
          ) : (
            <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
              {accountLinked ? 'Account linked.' : 'No account linked yet.'} Only an admin can manage the Mercadona link.
            </div>
          )}
        </div>

        {err && <div style={{ fontSize: 12, color: 'var(--grid)' }}>{err}</div>}
        {saved && <div style={{ fontSize: 12, color: 'var(--solar)' }}>{saved}</div>}
        {isAdmin ? (
          <div>
            <Button size="sm" variant="secondary" loading={busy && !linkOpen} onClick={() => void probe()}>Test connection</Button>
          </div>
        ) : (
          <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>Managed automatically — nothing to configure here.</div>
        )}
      </div>
    </ConnectionRow>
  );
}

/**
 * Settings ▸ Intelligence (Kitchen Hub D2) — the Claude API helper. Master switch,
 * per-feature toggles, masked API key + month usage counter. Every feature fails soft
 * to the deterministic engine when off. Editing is admin-only (the PUT is admin-gated).
 */
function IntelligenceCard() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [intel, setIntel] = useState<KitchenIntelligence | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [editingKey, setEditingKey] = useState(false);
  const [pexelsKeyDraft, setPexelsKeyDraft] = useState('');
  const [editingPexelsKey, setEditingPexelsKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.kitchen
      .intelligence()
      .then((r) => setIntel(r.intelligence))
      .catch(() => {});
  }, []);

  const put = async (patch: Parameters<typeof api.kitchen.setIntelligence>[0]) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.kitchen.setIntelligence(patch);
      setIntel(r.intelligence);
    } catch (e) {
      setErr((e as Error).message || 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  if (!intel) return null;
  const featureRow = (
    key: keyof KitchenIntelligence['features'],
    label: string,
    hint: string,
  ) => (
    <div style={{ ...row, padding: '11px 16px', borderTop: '1px solid var(--border-1)' }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 14 }}>{label}</div>
        <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 2 }}>{hint}</div>
      </div>
      <Switch
        checked={intel.features[key]}
        disabled={!isAdmin || busy}
        onChange={(e) => void put({ features: { [key]: e.target.checked } })}
      />
    </div>
  );

  return (
    <Card title="Intelligence" subtitle="Claude assistance for the Kitchen Hub — fails soft to the deterministic engine" style={{ padding: 0 }}>
      <div style={{ ...row, borderTop: '1px solid var(--border-1)' }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14 }}>Claude assistance</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 2 }}>
            Master switch — everything falls back to the deterministic engine when off
          </div>
        </div>
        <Switch checked={intel.enabled} disabled={!isAdmin || busy} onChange={(e) => void put({ enabled: e.target.checked })} />
      </div>
      <div style={{ ...row, padding: '11px 16px', borderTop: '1px solid var(--border-1)' }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14 }}>API key</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 2 }}>
            {intel.envKey ? 'Using ANTHROPIC_API_KEY from the server environment' : 'Or set ANTHROPIC_API_KEY in .env'}
          </div>
        </div>
        {editingKey ? (
          <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Input
              type="password"
              placeholder="sk-ant-…"
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              style={{ width: 190 }}
            />
            <Button
              size="sm"
              variant="secondary"
              loading={busy}
              onClick={() => {
                void put({ apiKey: keyDraft.trim() }).then(() => {
                  setEditingKey(false);
                  setKeyDraft('');
                });
              }}
            >
              Save
            </Button>
          </span>
        ) : (
          <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <code style={{ fontSize: 11.5, color: 'var(--text-2)', background: 'var(--surface-2)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', padding: '6px 10px' }}>
              {intel.keyMasked ?? (intel.envKey ? 'env key' : 'not set')}
            </code>
            {isAdmin && (
              <Button size="sm" variant="ghost" onClick={() => setEditingKey(true)}>
                {intel.keyMasked ? 'Replace' : 'Add key'}
              </Button>
            )}
          </span>
        )}
      </div>
      <div style={{ ...row, padding: '11px 16px', borderTop: '1px solid var(--border-1)' }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14 }}>Pexels API key (photos)</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 2 }}>
            Optional — free key, faster photo fetching. Openverse (no key needed) is used otherwise.
          </div>
        </div>
        {editingPexelsKey ? (
          <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Input
              type="password"
              placeholder="563...(pexels key)"
              value={pexelsKeyDraft}
              onChange={(e) => setPexelsKeyDraft(e.target.value)}
              style={{ width: 190 }}
            />
            <Button
              size="sm"
              variant="secondary"
              loading={busy}
              onClick={() => {
                void put({ pexelsApiKey: pexelsKeyDraft.trim() }).then(() => {
                  setEditingPexelsKey(false);
                  setPexelsKeyDraft('');
                });
              }}
            >
              Save
            </Button>
          </span>
        ) : (
          <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <code style={{ fontSize: 11.5, color: 'var(--text-2)', background: 'var(--surface-2)', border: '1px solid var(--border-1)', borderRadius: 'var(--radius-md)', padding: '6px 10px' }}>
              {intel.pexelsKeyMasked ?? 'not set'}
            </code>
            {isAdmin && (
              <Button size="sm" variant="ghost" onClick={() => setEditingPexelsKey(true)}>
                {intel.pexelsKeyMasked ? 'Replace' : 'Add key'}
              </Button>
            )}
          </span>
        )}
      </div>
      {featureRow('importParsing', 'Recipe import parsing', 'URL → structured recipe + nutrition estimate when JSON-LD is missing')}
      {featureRow('cookingSuggestions', 'Cooking suggestions', '“What can I make with…” free-form ideas (arrives with cooking mode)')}
      {featureRow('recipeGeneration', 'Recipe generation', 'Invent a few complete recipes from a question or ingredients — save the ones you like')}
      {featureRow('plannerRequestBox', 'Planner request box', '“Ask for anything” on the week planner')}
      {featureRow('weeklyPlanAssist', 'Weekly-plan assist', 'Blends with the rotation + preference engine')}
      <div style={{ ...row, padding: '11px 16px', borderTop: '1px solid var(--border-1)' }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14 }}>Usage this month</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 2 }}>Household volume ≈ cents · counted + priced locally</div>
        </div>
        <b style={{ fontFamily: 'var(--font-mono)', fontSize: 14 }}>{intel.usage.eur.toFixed(2).replace('.', ',')} €</b>
      </div>
      {err && <div style={{ padding: '0 16px 12px', fontSize: 12, color: 'var(--grid)' }}>{err}</div>}
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
      <SungrowConnection first={false} open={openId === 'sungrow'} onToggle={() => toggle('sungrow')} cfg={cfg} reload={loadCfg} />
      <IsolarcloudConnection first={false} open={openId === 'isolarcloud'} onToggle={() => toggle('isolarcloud')} cfg={cfg} reload={loadCfg} />
      <RainbirdConnection first={false} open={openId === 'rainbird'} onToggle={() => toggle('rainbird')} />
      <TuyaConnection first={false} open={openId === 'tuya'} onToggle={() => toggle('tuya')} />
      <SonosConnection first={false} open={openId === 'sonos'} onToggle={() => toggle('sonos')} />
      <SpotifyConnection first={false} open={openId === 'spotify'} onToggle={() => toggle('spotify')} />
      <MercadonaConnection first={false} open={openId === 'mercadona'} onToggle={() => toggle('mercadona')} />
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
  // ctx.settingsTab is already deep-link aware (AppShell reads ?tab=… when on /settings),
  // so it is the single source of truth here.
  const active: SettingsTabLabel = (tabs as readonly string[]).includes(ctx.settingsTab)
    ? (ctx.settingsTab as SettingsTabLabel)
    : 'Connections';
  // Selecting a tab updates both the shell state and the URL (?tab=<lowercase label>) so
  // the TopBar title, the strip, and deep-links like /settings?tab=autopilot all agree.
  // Connections is the default tab, so it keeps the clean /settings URL.
  const [, setParams] = useSearchParams();
  const selectTab = (t: string) => {
    ctx.setSettingsTab(t);
    setParams((prev) => {
      const p = new URLSearchParams(prev);
      if (t === 'Connections') p.delete('tab');
      else p.set('tab', t.toLowerCase());
      return p;
    }, { replace: true });
  };

  const sections = (
    <>
      {/* Battery Autopilot — arm/mode/kill + manual levers, relocated from
          /automations?tab=settings. The embedded Autopilot renders only its settings
          panel (armed strip + Master + Manual controls, or the view-only lock card for
          non-admins) and keeps its own confirm-dialog + toast plumbing. It polls the
          control plane only while this tab is mounted. */}
      {active === 'Autopilot' && <Autopilot ctx={ctx} embedded tab="settings" />}

      {active === 'Connections' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <ConnectionsCard connections={s.connections} />
          {/* Kitchen Hub Intelligence (Claude API) — docs/38 D2. */}
          <IntelligenceCard />
        </div>
      )}

      {active === 'Notifications' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <NotificationsCard channels={ch} onChannels={setChannels} />
          <AlertRulesCard />
          <VoltageMonitorCard />
          <EventMonitorsCard />
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
  // content beneath. The desktop TopBar supplies the eyebrow + active-tab title (so no
  // page header on desktop); mobile (no TopBar) renders its own header.
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 820, margin: '0 auto', width: '100%', padding: ctx.desktop ? 0 : '8px 14px 22px' }}>
      {!ctx.desktop && <ScreenHeader eyebrow="Settings" title={active} padding="4px 2px 0" />}
      {stale && <StaleBanner updatedAt={updatedAt} />}
      {/* Six tabs (five for non-admins) are too wide for one row at ~360px, so mobile
          splits into two stacked rows (Automations-style); desktop keeps one block. */}
      {ctx.desktop ? (
        <SegmentedControl block options={tabs} value={active} onChange={selectTab} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <SegmentedControl block options={tabs.slice(0, 3)} value={active} onChange={selectTab} />
          <SegmentedControl block options={tabs.slice(3)} value={active} onChange={selectTab} />
        </div>
      )}
      {sections}
      {installOpen && <InstallSheet onClose={() => setInstallOpen(false)} />}
      {isAdmin && <HomeSceneBuilder open={scenesOpen} onClose={() => setScenesOpen(false)} />}
    </div>
  );
}
