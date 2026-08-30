import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import { MOCK_WATER_SETTINGS } from '../../lib/mock';
import type { WaterResponse, WaterSettingsResponse, WaterTariff, WaterIntegrationTestResponse, Channels, ChannelType } from '../../lib/types';
import { useAuth } from '../../auth/AuthProvider';
import { Card, Icon, Button, Input, Select, Switch, Eyebrow, Badge } from '../../components/ui';
import type { ShellContext } from '../../components/shell/AppShell';

/* ============================================================================
 * Water hub — Settings tab (docs/51). "How it's set up": the BI-WATER
 * connection (follows RainbirdConnection in screens/Settings.tsx — admin-gated,
 * password write-only, never re-displayed), a read-only meter card, the five
 * detection-rule thresholds, the shared alert channels, and a tariff editor
 * with a live-recalculating bill breakdown (every default is a placeholder —
 * docs/51 D5 — so figures are labelled estimates throughout).
 * ==========================================================================*/

const POLL_OPTIONS = [
  { value: '1', label: 'every hour' },
  { value: '3', label: 'every 3 hours' },
  { value: '6', label: 'every 6 hours' },
  { value: '12', label: 'every 12 hours' },
  { value: '24', label: 'once a day' },
];

function errMsg(e: unknown): string {
  return e instanceof ApiError ? e.message : 'Something went wrong — try again';
}

function calcBill(t: WaterTariff, m3: number) {
  const b1 = Math.max(0, Math.min(m3, t.block1M3));
  const b2 = Math.max(0, Math.min(m3 - t.block1M3, Math.max(0, t.block2M3 - t.block1M3)));
  const b3 = Math.max(0, m3 - t.block2M3);
  const consumption = b1 * t.block1RateEur + b2 * t.block2RateEur + b3 * t.block3RateEur;
  const sewerage = m3 * t.sewerageRateEur;
  const canon = m3 * t.canonSaneamientoRateEur;
  const preTax = t.serviceChargeEur + consumption + sewerage + canon;
  const iva = preTax * (t.ivaPct / 100);
  return { b1, b2, b3, consumption, sewerage, canon, preTax, iva, total: preTax + iva };
}

export function WaterSettingsTab({
  ctx,
  snapshot,
  onSaved,
}: {
  ctx: ShellContext;
  snapshot: WaterResponse;
  onSaved: () => void;
}) {
  const wide = ctx.desktop;
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const { data, refetch } = usePolling<WaterSettingsResponse>(api.water.settings, 0);
  const s = data ?? MOCK_WATER_SETTINGS;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: wide ? 16 : 14 }}>
      <ConnectionCard settings={s} isAdmin={isAdmin} onSaved={() => { refetch(); onSaved(); }} />
      <MeterCard snapshot={snapshot} />
      <ThresholdsCard settings={s} isAdmin={isAdmin} onSaved={refetch} />
      <ChannelsCard isAdmin={isAdmin} />
      <TariffCard settings={s} isAdmin={isAdmin} monthM3={snapshot.month.m3} onSaved={refetch} />
    </div>
  );
}

// ---- Connection ---------------------------------------------------------

function ConnectionCard({ settings, isAdmin, onSaved }: { settings: WaterSettingsResponse; isAdmin: boolean; onSaved: () => void }) {
  const [email, setEmail] = useState(settings.email ?? '');
  const [password, setPassword] = useState('');
  const [serial, setSerial] = useState(settings.serial ?? '');
  const [pollHours, setPollHours] = useState(String(settings.pollHours ?? 6));
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [res, setRes] = useState<WaterIntegrationTestResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setEmail((v) => v || settings.email || '');
    setSerial((v) => v || settings.serial || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.email, settings.serial]);

  const run = async (kind: 'test' | 'save') => {
    setBusy(kind);
    setErr(null);
    setRes(null);
    try {
      const body = { email: email.trim() || undefined, password: password || undefined, serial: serial.trim() || undefined };
      if (kind === 'test') {
        const r = await api.integrations.testWater(body);
        setRes(r);
      } else {
        const r = await api.integrations.setWater({ ...body, pollHours: Number(pollHours) });
        setRes(r);
        setPassword(''); // never keep the entered secret in component state
        onSaved();
      }
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const statusTone = settings.connected ? 'solar' : settings.configured ? 'grid' : 'text-3';
  const statusText = settings.connected ? 'connected' : settings.configured ? 'not reachable' : 'not connected';

  return (
    <Card padded>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 12 }}>
        <span style={{ width: 34, height: 34, borderRadius: 10, display: 'grid', placeItems: 'center', background: settings.connected ? 'var(--water-wash)' : 'var(--surface-3)', color: settings.connected ? 'var(--water)' : 'var(--text-2)', flex: 'none' }}>
          <Icon name="waves" size={17} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>BI-WATER (Contazara)</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-2)' }}>the CZ3000 NB-IoT meter's cloud account</div>
        </div>
        <span style={{ fontSize: 12, color: `var(--${statusTone})` }}>{statusText}</span>
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5, marginBottom: 12 }}>
        The same email/password you use in the BI-WATER app. Data is hourly-read and uploaded roughly once a day —
        this is not a live feed, so don't expect the numbers here to move minute to minute.
      </div>
      {isAdmin ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Input label="Account email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          <Input
            label="Account password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={settings.hasPassword ? '•••••••• (unchanged)' : 'enter password'}
          />
          <Input label="Meter serial" value={serial} onChange={(e) => setSerial(e.target.value)} placeholder="P23EA822644C" />
          <div style={{ maxWidth: 220 }}>
            <Select label="Poll interval" value={pollHours} onChange={(e) => setPollHours(e.target.value)} options={POLL_OPTIONS} />
          </div>
          {res && (
            <div style={{ fontSize: 11.5, color: res.ok ? 'var(--solar)' : 'var(--danger)' }}>
              {res.ok ? '✓ ' : ''}
              {res.detail}
              {res.ok && res.meter ? ` · index ${res.meter.indexL.toLocaleString()} L` : ''}
            </div>
          )}
          {err && <div style={{ fontSize: 11.5, color: 'var(--danger)' }}>{err}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <Button size="sm" variant="secondary" loading={busy === 'test'} onClick={() => void run('test')}>Test</Button>
            <Button size="sm" variant="primary" loading={busy === 'save'} onClick={() => void run('save')}>Save</Button>
          </div>
        </div>
      ) : (
        <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>Only an admin can connect the water meter.</div>
      )}
    </Card>
  );
}

// ---- Meter (read-only) ---------------------------------------------------

function MeterCard({ snapshot }: { snapshot: WaterResponse }) {
  const m = snapshot.meter;
  return (
    <Card padded>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Meter</div>
      {!m ? (
        <div style={{ fontSize: 12.5, color: 'var(--text-2)' }}>No meter data yet — connect the account above.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <MeterLine label="Serial" value={m.serial} />
          <MeterLine label="Model" value={m.model} />
          <MeterLine label="Address" value={m.address} />
          <MeterLine label="Index" value={`${(m.indexL / 1000).toFixed(1)} m³`} />
          <MeterLine label="Last reading" value={m.lastReadingIso ? new Date(m.lastReadingIso).toLocaleString() : '—'} tone={m.staleHours != null && m.staleHours > 30 ? 'grid' : undefined} />
        </div>
      )}
    </Card>
  );
}

function MeterLine({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div style={{ display: 'flex', gap: 10, fontSize: 12.5 }}>
      <span style={{ color: 'var(--text-3)', width: 96, flex: 'none' }}>{label}</span>
      <span style={{ color: tone ? `var(--${tone})` : 'var(--text-1)', fontFamily: 'var(--font-mono)', minWidth: 0, wordBreak: 'break-word' }}>{value}</span>
    </div>
  );
}

// ---- Detection thresholds -------------------------------------------------

function ThresholdsCard({ settings, isAdmin, onSaved }: { settings: WaterSettingsResponse; isAdmin: boolean; onSaved: () => void }) {
  const [t, setT] = useState(settings.thresholds);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => setT(settings.thresholds), [settings.thresholds]);

  const save = async () => {
    setBusy(true);
    setErr(null);
    setSaved(false);
    try {
      await api.water.saveSettings({ thresholds: t });
      setSaved(true);
      onSaved();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card padded>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Detection thresholds</div>
        {saved && <Badge tone="water" variant="soft">saved</Badge>}
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-2)', marginBottom: 12 }}>on/off switches for each rule live on the Alerts tab — these are the numbers behind them</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
        <Input label="Continuous-flow floor (L/h)" type="number" min={0} disabled={!isAdmin} value={t.continuousFlow.floorLph} onChange={(e) => setT((p) => ({ ...p, continuousFlow: { ...p.continuousFlow, floorLph: Number(e.target.value) } }))} />
        <Input label="Continuous-flow hours" type="number" min={1} disabled={!isAdmin} value={t.continuousFlow.hours} onChange={(e) => setT((p) => ({ ...p, continuousFlow: { ...p.continuousFlow, hours: Number(e.target.value) } }))} />
        <Input label="Night-use tolerance (L)" type="number" min={0} disabled={!isAdmin} value={t.nightUse.toleranceL} onChange={(e) => setT((p) => ({ ...p, nightUse: { ...p.nightUse, toleranceL: Number(e.target.value) } }))} />
        <Input label="Daily-spike multiplier" type="number" min={1} step={0.1} disabled={!isAdmin} value={t.dailySpike.multiplier} onChange={(e) => setT((p) => ({ ...p, dailySpike: { ...p.dailySpike, multiplier: Number(e.target.value) } }))} />
        <Input label="Monthly budget (m³)" type="number" min={0} disabled={!isAdmin} value={t.monthlyBudget.budgetM3} onChange={(e) => setT((p) => ({ ...p, monthlyBudget: { ...p.monthlyBudget, budgetM3: Number(e.target.value) } }))} />
        <Input label="Meter-silent hours" type="number" min={1} disabled={!isAdmin} value={t.meterSilent.hours} onChange={(e) => setT((p) => ({ ...p, meterSilent: { ...p.meterSilent, hours: Number(e.target.value) } }))} />
      </div>
      {err && <div style={{ fontSize: 11.5, color: 'var(--danger)', marginTop: 10 }}>{err}</div>}
      {isAdmin && (
        <div style={{ marginTop: 12 }}>
          <Button size="sm" variant="primary" loading={busy} onClick={() => void save()}>Save thresholds</Button>
        </div>
      )}
    </Card>
  );
}

// ---- Alert channels (shared global channels — no per-feature plumbing) ---

function ChannelsCard({ isAdmin }: { isAdmin: boolean }) {
  const { data } = usePolling(api.settings, 0);
  const [channels, setChannels] = useState<Channels | null>(null);
  useEffect(() => {
    if (data?.channels) setChannels(data.channels);
  }, [data]);
  const [busy, setBusy] = useState<ChannelType | null>(null);

  const toggle = async (type: ChannelType, enabled: boolean) => {
    setBusy(type);
    setChannels((prev) => (prev ? { ...prev, [type]: { ...prev[type], enabled } } : prev));
    try {
      const r = await api.setChannel(type, enabled);
      setChannels(r.channels);
    } catch {
      /* keep-last-good; the poll above will reconcile */
    } finally {
      setBusy(null);
    }
  };

  const c = channels;
  return (
    <Card padded>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Alert channels</div>
      <div style={{ fontSize: 11.5, color: 'var(--text-2)', marginBottom: 12 }}>
        shared with the rest of the app — a critical water alert forwards through these the same way any other critical event does
      </div>
      {!c ? (
        <div style={{ fontSize: 12.5, color: 'var(--text-2)' }}>Loading…</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <ChannelRow icon="smartphone" label="Push" enabled={c.push.enabled} disabled={!isAdmin || busy === 'push'} onChange={(v) => void toggle('push', v)} />
          <ChannelRow icon="message-square" label="WhatsApp" sub={c.whatsapp.number || 'no number set'} enabled={c.whatsapp.enabled} disabled={!isAdmin || busy === 'whatsapp'} onChange={(v) => void toggle('whatsapp', v)} />
          <ChannelRow icon="mail" label="Email" sub={c.email.address || 'no address set'} enabled={c.email.enabled} disabled={!isAdmin || busy === 'email'} onChange={(v) => void toggle('email', v)} />
        </div>
      )}
      {!isAdmin && <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 10 }}>Sign in as admin to change alert channels.</div>}
    </Card>
  );
}

function ChannelRow({ icon, label, sub, enabled, disabled, onChange }: { icon: string; label: string; sub?: string; enabled: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ width: 28, height: 28, borderRadius: 8, display: 'grid', placeItems: 'center', background: 'var(--surface-3)', color: 'var(--text-2)', flex: 'none' }}>
        <Icon name={icon} size={14} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13 }}>{label}</div>
        {sub && <div style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>{sub}</div>}
      </div>
      <Switch checked={enabled} disabled={disabled} onChange={(e) => onChange(e.currentTarget.checked)} />
    </div>
  );
}

// ---- Tariff (live-recalculating bill breakdown) --------------------------

function TariffCard({ settings, isAdmin, monthM3, onSaved }: { settings: WaterSettingsResponse; isAdmin: boolean; monthM3: number; onSaved: () => void }) {
  const [t, setT] = useState(settings.tariff);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => setT(settings.tariff), [settings.tariff]);

  const set = (patch: Partial<WaterTariff>) => setT((p) => ({ ...p, ...patch }));
  const bill = calcBill(t, monthM3);

  const save = async () => {
    setBusy(true);
    setErr(null);
    setSaved(false);
    try {
      await api.water.saveSettings({ tariff: t });
      setSaved(true);
      onSaved();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card padded>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Tariff (AMJASA)</div>
        {saved && <Badge tone="water" variant="soft">saved</Badge>}
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-2)', marginBottom: 12 }}>
        every figure below is a placeholder until a real AMJASA bill is entered — cost figures elsewhere in Water are labelled as estimates
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
        <Input label="Service charge (€)" type="number" min={0} step={0.01} disabled={!isAdmin} value={t.serviceChargeEur} onChange={(e) => set({ serviceChargeEur: Number(e.target.value) })} />
        <Input label="Block 1 up to (m³)" type="number" min={0} disabled={!isAdmin} value={t.block1M3} onChange={(e) => set({ block1M3: Number(e.target.value) })} />
        <Input label="Block 1 rate (€/m³)" type="number" min={0} step={0.01} disabled={!isAdmin} value={t.block1RateEur} onChange={(e) => set({ block1RateEur: Number(e.target.value) })} />
        <Input label="Block 2 up to (m³)" type="number" min={0} disabled={!isAdmin} value={t.block2M3} onChange={(e) => set({ block2M3: Number(e.target.value) })} />
        <Input label="Block 2 rate (€/m³)" type="number" min={0} step={0.01} disabled={!isAdmin} value={t.block2RateEur} onChange={(e) => set({ block2RateEur: Number(e.target.value) })} />
        <Input label="Block 3 rate (€/m³)" type="number" min={0} step={0.01} disabled={!isAdmin} value={t.block3RateEur} onChange={(e) => set({ block3RateEur: Number(e.target.value) })} />
        <Input label="Sewerage (€/m³)" type="number" min={0} step={0.01} disabled={!isAdmin} value={t.sewerageRateEur} onChange={(e) => set({ sewerageRateEur: Number(e.target.value) })} />
        <Input label="Canon saneamiento (€/m³)" type="number" min={0} step={0.01} disabled={!isAdmin} value={t.canonSaneamientoRateEur} onChange={(e) => set({ canonSaneamientoRateEur: Number(e.target.value) })} />
        <Input label="IVA (%)" type="number" min={0} step={1} disabled={!isAdmin} value={t.ivaPct} onChange={(e) => set({ ivaPct: Number(e.target.value) })} />
      </div>

      {err && <div style={{ fontSize: 11.5, color: 'var(--danger)', marginTop: 10 }}>{err}</div>}
      {isAdmin && (
        <div style={{ marginTop: 12 }}>
          <Button size="sm" variant="primary" loading={busy} onClick={() => void save()}>Save tariff</Button>
        </div>
      )}

      {/* live-recalculating bill breakdown */}
      <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border-1)' }}>
        <Eyebrow>Estimated bill this month · {monthM3.toFixed(1)} m³</Eyebrow>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 8 }}>
          <BillRow label="Service charge" value={t.serviceChargeEur} />
          <BillRow label={`Block 1 (${bill.b1.toFixed(1)} m³ × €${t.block1RateEur.toFixed(2)})`} value={bill.b1 * t.block1RateEur} />
          <BillRow label={`Block 2 (${bill.b2.toFixed(1)} m³ × €${t.block2RateEur.toFixed(2)})`} value={bill.b2 * t.block2RateEur} />
          <BillRow label={`Block 3 (${bill.b3.toFixed(1)} m³ × €${t.block3RateEur.toFixed(2)})`} value={bill.b3 * t.block3RateEur} />
          <BillRow label="Sewerage" value={bill.sewerage} />
          <BillRow label="Canon de saneamiento" value={bill.canon} />
          <BillRow label={`IVA (${t.ivaPct}%)`} value={bill.iva} />
          <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 8, marginTop: 3, borderTop: '1px solid var(--border-1)', fontSize: 14, fontWeight: 700 }}>
            <span>Estimated total</span>
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--water)' }}>€{bill.total.toFixed(2)}</span>
          </div>
        </div>
      </div>
    </Card>
  );
}

function BillRow({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, color: 'var(--text-2)' }}>
      <span>{label}</span>
      <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-1)' }}>€{value.toFixed(2)}</span>
    </div>
  );
}
