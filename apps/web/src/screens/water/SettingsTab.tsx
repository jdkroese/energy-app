import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import { MOCK_WATER_SETTINGS } from '../../lib/mock';
import type { WaterResponse, WaterSettingsResponse, WaterTariff, WaterIntegrationTestResponse, Channels, ChannelType } from '../../lib/types';
import { useAuth } from '../../auth/AuthProvider';
import { Card, Icon, Button, Input, Select, Switch, Eyebrow, Badge } from '../../components/ui';
import type { ShellContext } from '../../components/shell/AppShell';

/* ============================================================================
 * Water hub — Settings tab (docs/52). "How it's set up": the BI-WATER
 * connection (follows RainbirdConnection in screens/Settings.tsx — admin-gated,
 * password write-only, never re-displayed), a read-only meter card, the five
 * detection-rule thresholds, the shared alert channels, and a tariff editor
 * with a live-recalculating bill breakdown (every default is a placeholder —
 * docs/52 D5 — so figures are labelled estimates throughout).
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

/* Mirrors apps/api/src/control/water-tariff.ts. AMJASA bills bimonthly, IVA
 * applies to the supply half only, and sanitation has its own standing charge —
 * so this is NOT "sum everything, then add VAT". */
function calcBill(t: WaterTariff, m3: number, months = 1) {
  const vol = Math.max(0, m3);
  const fixedShare = months / (t.periodMonths > 0 ? t.periodMonths : 1);
  const blocks = t.supplyBlocks?.length ? t.supplyBlocks : [{ upToM3: null, eurM3: 0 }];

  const bandOf = (v: number) => blocks.find((b) => b.upToM3 === null || v <= b.upToM3) ?? blocks[blocks.length - 1];

  const parts: { label: string; m3: number; eur: number }[] = [];
  if (vol > 0) {
    if (t.blockMode === 'all-at-last') {
      // AMJASA: every m³ at the price of the last m³ consumed.
      const b = bandOf(vol);
      parts.push({
        label: b.upToM3 === null ? 'Water consumed — top band' : `Water consumed — ≤${b.upToM3} m³ band`,
        m3: vol,
        eur: vol * b.eurM3,
      });
    } else {
      let lower = 0;
      let remaining = vol;
      for (const b of blocks) {
        if (remaining <= 0) break;
        const span = b.upToM3 === null ? Infinity : Math.max(0, b.upToM3 - lower);
        const take = Math.min(remaining, span);
        if (take > 0) {
          parts.push({
            label: b.upToM3 === null ? `Water consumed (above ${lower} m³)` : `Water consumed (${lower}–${b.upToM3} m³)`,
            m3: take,
            eur: take * b.eurM3,
          });
          remaining -= take;
        }
        if (b.upToM3 === null) break;
        lower = b.upToM3;
      }
    }
  }

  const supplyFixed = t.supplyFixedEurPeriod * fixedShare;
  const supplyBase = supplyFixed + parts.reduce((a, x) => a + x.eur, 0);
  const iva = supplyBase * (t.ivaPct / 100);
  const sanitationFixed = t.sanitationFixedEurPeriod * fixedShare;
  const sanitationVolume = vol * t.sanitationEurM3;

  return {
    parts,
    band: bandOf(vol),
    supplyFixed,
    supplyBase,
    iva,
    sanitationFixed,
    sanitationVolume,
    sanitationBase: sanitationFixed + sanitationVolume,
    total: supplyBase + iva + sanitationFixed + sanitationVolume,
  };
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
      <HistoryCard settings={s} isAdmin={isAdmin} onSaved={refetch} />
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
        <Input label="Continuous-flow floor (L/h)" type="number" min={0} disabled={!isAdmin} value={t.quietHourFloorLph} onChange={(e) => setT((p) => ({ ...p, quietHourFloorLph: Number(e.target.value) }))} />
        <Input label="Continuous-flow hours" type="number" min={1} disabled={!isAdmin} value={t.continuousFlowHours} onChange={(e) => setT((p) => ({ ...p, continuousFlowHours: Number(e.target.value) }))} />
        <Input label="Night-use tolerance (L)" type="number" min={0} disabled={!isAdmin} value={t.nightToleranceL} onChange={(e) => setT((p) => ({ ...p, nightToleranceL: Number(e.target.value) }))} />
        <Input label="Daily-spike multiplier" type="number" min={1} step={0.1} disabled={!isAdmin} value={t.dailySpikeFactor} onChange={(e) => setT((p) => ({ ...p, dailySpikeFactor: Number(e.target.value) }))} />
        <Input label="Monthly budget (m³)" type="number" min={0} disabled={!isAdmin} value={t.monthlyBudgetM3} onChange={(e) => setT((p) => ({ ...p, monthlyBudgetM3: Number(e.target.value) }))} />
        <Input label="Meter-silent hours" type="number" min={1} disabled={!isAdmin} value={t.meterSilentHours} onChange={(e) => setT((p) => ({ ...p, meterSilentHours: Number(e.target.value) }))} />
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
        from AMJASA factura 3/1836657 (Jul–Aug 2026). AMJASA bills every {t.periodMonths} months; IVA applies to the water half only — the EPSAR sanitation half is exempt.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
        <Input label={`Water standing charge (€ / ${t.periodMonths} months)`} type="number" min={0} step={0.01} disabled={!isAdmin} value={t.supplyFixedEurPeriod} onChange={(e) => set({ supplyFixedEurPeriod: Number(e.target.value) })} />
        <Input label={`EPSAR standing charge (€ / ${t.periodMonths} months)`} type="number" min={0} step={0.01} disabled={!isAdmin} value={t.sanitationFixedEurPeriod} onChange={(e) => set({ sanitationFixedEurPeriod: Number(e.target.value) })} />
        <Input label="EPSAR rate (€/m³)" type="number" min={0} step={0.001} disabled={!isAdmin} value={t.sanitationEurM3} onChange={(e) => set({ sanitationEurM3: Number(e.target.value) })} />
        <Input label="Billing period (months)" type="number" min={1} max={12} step={1} disabled={!isAdmin} value={t.periodMonths} onChange={(e) => set({ periodMonths: Number(e.target.value) })} />
        <Input label="IVA on water (%)" type="number" min={0} step={1} disabled={!isAdmin} value={t.ivaPct} onChange={(e) => set({ ivaPct: Number(e.target.value) })} />
      </div>

      {/* Consumption bands. AMJASA prices EVERY m³ at the band the total reaches, so
          the boundaries are cliffs, not gentle steps — worth showing explicitly. */}
      <div style={{ marginTop: 14 }}>
        <Eyebrow>Consumption bands · per {t.periodMonths}-month period</Eyebrow>
        <div style={{ fontSize: 11.5, color: 'var(--text-2)', margin: '6px 0 10px' }}>
          {t.blockMode === 'all-at-last'
            ? 'Every m³ is billed at the rate of the band your total reaches — so crossing a boundary re-prices the whole period.'
            : 'Each m³ is billed at its own band’s rate.'}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {t.supplyBlocks.map((b, i) => {
            const lower = i === 0 ? 0 : ((t.supplyBlocks[i - 1].upToM3 ?? 0) + 1);
            const active = bill.band === b;
            return (
              <div
                key={i}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 110px 110px',
                  gap: 8,
                  alignItems: 'center',
                  padding: '7px 9px',
                  borderRadius: 'var(--radius-sm)',
                  background: active ? 'var(--water-wash)' : 'transparent',
                  border: `1px solid ${active ? 'var(--border-water)' : 'var(--border-1)'}`,
                }}
              >
                <div style={{ fontSize: 12.5, color: active ? 'var(--water)' : 'var(--text-2)', fontWeight: active ? 600 : 400 }}>
                  {b.upToM3 === null ? `Over ${lower - 1} m³` : `${lower}–${b.upToM3} m³`}
                  {active && <span style={{ fontSize: 10.5, marginLeft: 7, opacity: 0.85 }}>you are here</span>}
                </div>
                <Input
                  aria-label={`Band ${i + 1} upper bound in cubic metres`}
                  type="number"
                  min={0}
                  disabled={!isAdmin || b.upToM3 === null}
                  value={b.upToM3 ?? ''}
                  placeholder="no limit"
                  onChange={(e) => {
                    const next = t.supplyBlocks.map((x, k) => (k === i ? { ...x, upToM3: Number(e.target.value) } : x));
                    set({ supplyBlocks: next });
                  }}
                />
                <Input
                  aria-label={`Band ${i + 1} rate in euros per cubic metre`}
                  type="number"
                  min={0}
                  step={0.001}
                  disabled={!isAdmin}
                  value={b.eurM3}
                  onChange={(e) => {
                    const next = t.supplyBlocks.map((x, k) => (k === i ? { ...x, eurM3: Number(e.target.value) } : x));
                    set({ supplyBlocks: next });
                  }}
                />
              </div>
            );
          })}
        </div>
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
          <BillRow label="Water standing charge" value={bill.supplyFixed} />
          {bill.parts.map((p) => (
            <BillRow key={p.label} label={`${p.label} (${p.m3.toFixed(1)} m³)`} value={p.eur} />
          ))}
          <BillRow label={`IVA ${t.ivaPct}% (water only)`} value={bill.iva} />
          <BillRow label="EPSAR standing charge (exempt)" value={bill.sanitationFixed} />
          <BillRow label={`EPSAR sanitation (${monthM3.toFixed(1)} m³, exempt)`} value={bill.sanitationVolume} />
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

// ---- History & billing period --------------------------------------------

/**
 * How far back to import, how long to keep it, and where the billing period starts.
 * The backfill is deliberately one-shot, so widening the window alone would never
 * fetch the older data — hence the explicit re-import action.
 */
function HistoryCard({ settings, isAdmin, onSaved }: { settings: WaterSettingsResponse; isAdmin: boolean; onSaved: () => void }) {
  const [h, setH] = useState(settings.history);
  const [anchor, setAnchor] = useState(settings.billingAnchorDay);
  const [busy, setBusy] = useState<'save' | 'reimport' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    setH(settings.history);
    setAnchor(settings.billingAnchorDay);
  }, [settings.history, settings.billingAnchorDay]);

  const save = async () => {
    setBusy('save');
    setErr(null);
    setMsg(null);
    try {
      await api.water.saveSettings({ history: h, billingAnchorDay: anchor });
      setMsg('Saved');
      onSaved();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const reimport = async () => {
    setBusy('reimport');
    setErr(null);
    setMsg(null);
    try {
      const r = await api.water.reimportHistory();
      setMsg(r.detail);
      onSaved();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  const b = settings.backfill;

  return (
    <Card padded>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <span style={{ width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center', background: 'var(--water-wash)', color: 'var(--water)', flex: 'none' }}>
          <Icon name="calendar-days" size={16} />
        </span>
        <div>
          <div style={{ fontSize: 14.5, fontWeight: 600 }}>History &amp; billing period</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>how far back to import, and when a period starts</div>
        </div>
      </div>

      <div style={{ fontSize: 11.5, color: 'var(--text-2)', margin: '10px 0 12px', lineHeight: 1.6 }}>
        Contazara serves daily readings much further back than hourly ones, so these are separate.
        Daily rows drive the year view and same-period-last-year; hourly rows are what the leak
        detectors read.
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
        <Input label="Import daily (months)" type="number" min={1} max={120} disabled={!isAdmin} value={h.backfillDailyMonths} onChange={(e) => setH((p) => ({ ...p, backfillDailyMonths: Number(e.target.value) }))} />
        <Input label="Import hourly (days)" type="number" min={1} max={1000} disabled={!isAdmin} value={h.backfillHourlyDays} onChange={(e) => setH((p) => ({ ...p, backfillHourlyDays: Number(e.target.value) }))} />
        <Input label="Keep hourly for (days)" type="number" min={7} max={3650} disabled={!isAdmin} value={h.retainHourlyDays} onChange={(e) => setH((p) => ({ ...p, retainHourlyDays: Number(e.target.value) }))} />
        <Input label="Billing period starts" type="date" disabled={!isAdmin} value={anchor} onChange={(e) => setAnchor(e.target.value)} />
      </div>

      <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 8, lineHeight: 1.55 }}>
        Any known meter-read date works — AMJASA reads on the 1st of odd months, and every
        period boundary is stepped from here in {settings.tariff.periodMonths}-month jumps.
      </div>

      <div style={{ marginTop: 12, paddingTop: 11, borderTop: '1px solid var(--border-1)', display: 'flex', flexDirection: 'column', gap: 5 }}>
        <DetailLine label="Daily readings stored" value={b.dailyRows > 0 ? `${b.dailyRows.toLocaleString()} days${b.oldestDay ? ` · back to ${b.oldestDay}` : ''}` : 'none yet'} />
        <DetailLine label="Hourly readings stored" value={b.hourlyRows > 0 ? `${b.hourlyRows.toLocaleString()} hours` : 'none yet'} />
        <DetailLine label="Initial import" value={b.dailyDone ? 'complete' : b.dailyRows > 0 ? 'in progress' : 'not started'} />
      </div>

      {err && <div style={{ fontSize: 11.5, color: 'var(--danger)', marginTop: 10 }}>{err}</div>}
      {msg && <div style={{ fontSize: 11.5, color: 'var(--solar)', marginTop: 10 }}>{msg}</div>}

      {isAdmin && (
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <Button size="sm" variant="primary" loading={busy === 'save'} onClick={() => void save()}>Save</Button>
          <Button size="sm" variant="secondary" loading={busy === 'reimport'} onClick={() => void reimport()}>Re-import history</Button>
        </div>
      )}
      <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 8, lineHeight: 1.55 }}>
        Re-importing fills gaps rather than replacing anything — existing readings are matched by
        date and left alone. It runs in the background over the next few polls, paced to be polite
        to Contazara.
      </div>
    </Card>
  );
}

/** Label/value row used by the meter and history cards. */
function DetailLine({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12 }}>
      <span style={{ color: 'var(--text-3)' }}>{label}</span>
      <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-1)', textAlign: 'right' }}>{value}</span>
    </div>
  );
}
