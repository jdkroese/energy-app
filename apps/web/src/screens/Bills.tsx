import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../auth/AuthProvider';
import type {
  InvoiceSummary,
  InvoiceDetail,
  ParsedInvoice,
  ReconcileRow,
} from '../lib/types';
import { Card, Badge, Button, Icon, Eyebrow, Input } from '../components/ui';
import type { ShellContext } from '../components/shell/AppShell';

/* ------------------------------------------------------------------ helpers */

const eur = (n: number | null | undefined) =>
  n == null ? '—' : `€${n.toFixed(2)}`;
const kwh = (n: number | null | undefined) =>
  n == null ? '—' : `${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

/** DD-MM-YYYY → "Mar 2026"-ish period label. */
function periodLabel(s?: string, e?: string): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmt = (d?: string) => {
    const m = d && /^(\d{2})-(\d{2})-(\d{4})$/.exec(d);
    return m ? `${m[1]} ${months[Number(m[2]) - 1] ?? '?'}` : d ?? '—';
  };
  if (!s && !e) return '—';
  return `${fmt(s)} → ${fmt(e)}`;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

const BAND_TONE: Record<string, string> = { P1: 'var(--grid)', P2: 'var(--home)', P3: 'var(--battery)' };

/* --------------------------------------------------------------- band chips */

function BandChips({ bandKwh, size = 'md' }: { bandKwh: { P1: number | null; P2: number | null; P3: number | null }; size?: 'sm' | 'md' }) {
  const pad = size === 'sm' ? '2px 7px' : '3px 9px';
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      {(['P1', 'P2', 'P3'] as const).map((b) => (
        <span
          key={b}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            padding: pad,
            borderRadius: 7,
            background: 'var(--surface-3)',
            fontSize: 11,
            fontFamily: 'var(--font-mono)',
          }}
        >
          <i style={{ width: 7, height: 7, borderRadius: 2, background: BAND_TONE[b] }} />
          <span style={{ color: 'var(--text-3)' }}>{b}</span>
          <span style={{ color: 'var(--text-1)' }}>{kwh(bandKwh[b])}</span>
        </span>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------- trend (mini) */

/** Tiny inline bar trend of total € across saved invoices (oldest → newest). */
function TrendChart({ invoices, desktop }: { invoices: InvoiceSummary[]; desktop: boolean }) {
  const data = useMemo(
    () =>
      [...invoices]
        .filter((i) => i.total != null)
        .sort((a, b) => (a.periodStart ?? '').localeCompare(b.periodStart ?? '') || a.uploadedAt.localeCompare(b.uploadedAt)),
    [invoices],
  );
  if (data.length < 2) return null;
  const max = Math.max(...data.map((d) => d.total ?? 0)) || 1;
  const h = desktop ? 120 : 92;
  return (
    <Card style={desktop ? undefined : { padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <Eyebrow>Invoice total · trend</Eyebrow>
        <Icon name="trending-up" size={desktop ? 18 : 16} color="var(--grid)" />
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: desktop ? 14 : 8, height: h }}>
        {data.map((d) => {
          const pct = ((d.total ?? 0) / max) * 100;
          return (
            <div key={d.id} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-2)' }}>{eur(d.total)}</div>
              <div
                style={{
                  width: '100%',
                  maxWidth: 46,
                  height: `${Math.max(6, pct)}%`,
                  borderRadius: '5px 5px 2px 2px',
                  background: 'linear-gradient(180deg,var(--grid),var(--grid-dim,var(--grid)))',
                  opacity: 0.92,
                }}
              />
              <div style={{ fontSize: 10, color: 'var(--text-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 56 }}>
                {periodLabel(d.periodStart, d.periodEnd).split('→')[0].trim()}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/* --------------------------------------------------------------- list card */

function InvoiceCard({ inv, onOpen, desktop }: { inv: InvoiceSummary; onOpen: () => void; desktop: boolean }) {
  return (
    <Card interactive accent={inv.flagged ? 'grid' : undefined} onClick={onOpen} style={{ cursor: 'pointer', ...(desktop ? {} : { padding: 16 }) }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-1)' }}>{periodLabel(inv.periodStart, inv.periodEnd)}</span>
            {inv.flagged && (
              <Badge tone="grid" variant="soft" icon={<Icon name="triangle-alert" size={12} />}>
                check
              </Badge>
            )}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>
            #{inv.facturaNum ?? inv.id}
            {inv.flagReason ? ` · ${inv.flagReason}` : ''}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 19, fontWeight: 700, color: 'var(--text-1)' }}>{eur(inv.total)}</div>
        </div>
      </div>
      <div style={{ marginTop: 12 }}>
        <BandChips bandKwh={inv.bandKwh} size={desktop ? 'md' : 'sm'} />
      </div>
    </Card>
  );
}

/* --------------------------------------------------- reconciliation table */

function deltaColor(d: number | null): string {
  if (d == null || Math.abs(d) < 0.005) return 'var(--text-3)';
  return d > 0 ? 'var(--grid)' : 'var(--battery)';
}

function ReconcileTable({ rows, desktop }: { rows: ReconcileRow[]; desktop: boolean }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: desktop ? 13 : 12 }}>
        <thead>
          <tr style={{ textAlign: 'right', color: 'var(--text-3)', fontSize: 11 }}>
            <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 500 }}>Line</th>
            <th style={{ padding: '6px 8px', fontWeight: 500 }}>Billed</th>
            <th style={{ padding: '6px 8px', fontWeight: 500 }}>Modelled</th>
            <th style={{ padding: '6px 8px', fontWeight: 500 }}>Δ €</th>
            <th style={{ padding: '6px 8px', fontWeight: 500 }}>Δ %</th>
          </tr>
        </thead>
        <tbody style={{ fontFamily: 'var(--font-mono)' }}>
          {rows.map((r) => {
            const isTotal = r.key === 'total';
            const isSub = r.key === 'subtotal' || r.key === 'base';
            return (
              <tr
                key={r.key}
                style={{
                  borderTop: '1px solid var(--border)',
                  background: isTotal ? 'var(--surface-3)' : undefined,
                  fontWeight: isTotal ? 700 : isSub ? 600 : 400,
                }}
              >
                <td style={{ textAlign: 'left', padding: '7px 8px', fontFamily: 'var(--font-sans)', color: 'var(--text-2)' }}>{r.label}</td>
                <td style={{ textAlign: 'right', padding: '7px 8px', color: 'var(--text-1)' }}>{eur(r.billed)}</td>
                <td style={{ textAlign: 'right', padding: '7px 8px', color: 'var(--text-2)' }}>{eur(r.modelled)}</td>
                <td style={{ textAlign: 'right', padding: '7px 8px', color: deltaColor(r.deltaEur) }}>
                  {r.deltaEur == null ? '—' : `${r.deltaEur > 0 ? '+' : ''}${r.deltaEur.toFixed(2)}`}
                </td>
                <td style={{ textAlign: 'right', padding: '7px 8px', color: deltaColor(r.deltaEur) }}>
                  {r.deltaPct == null ? '—' : `${r.deltaPct > 0 ? '+' : ''}${r.deltaPct.toFixed(1)}%`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* --------------------------------------------------------------- detail view */

function Detail({ id, onBack, onDeleted, desktop, isAdmin }: { id: string; onBack: () => void; onDeleted: () => void; desktop: boolean; isAdmin: boolean }) {
  const [detail, setDetail] = useState<InvoiceDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api.invoices
      .detail(id)
      .then((d) => live && setDetail(d))
      .catch((e) => live && setErr(e instanceof Error ? e.message : 'load failed'));
    return () => {
      live = false;
    };
  }, [id]);

  if (err) return <Card><div style={{ color: 'var(--grid)' }}>{err}</div></Card>;
  if (!detail) return <Card><div style={{ color: 'var(--text-3)' }}>Loading…</div></Card>;

  const p = detail.parsed;
  const rec = detail.reconciliation;

  const remove = async () => {
    setBusy(true);
    try {
      await api.invoices.remove(id);
      onDeleted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'delete failed');
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: desktop ? 18 : 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Button variant="ghost" size="sm" iconLeft={<Icon name="arrow-left" size={16} />} onClick={onBack}>
          Bills
        </Button>
        <div style={{ flex: 1 }} />
        <a href={api.invoices.pdfUrl(id)} target="_blank" rel="noreferrer">
          <Button variant="secondary" size="sm" iconLeft={<Icon name="file-text" size={15} />}>
            PDF
          </Button>
        </a>
        {isAdmin && (
          <Button variant="danger" size="sm" loading={busy} iconLeft={<Icon name="trash-2" size={15} />} onClick={remove}>
            Delete
          </Button>
        )}
      </div>

      <Card accent={rec.totalDeltaPct != null && Math.abs(rec.totalDeltaPct) >= 5 ? 'grid' : undefined}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
          <div>
            <Eyebrow>Factura #{p.facturaNum ?? id}</Eyebrow>
            <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-.02em', marginTop: 2 }}>{periodLabel(p.periodStart, p.periodEnd)}</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-3)', marginTop: 3 }}>
              {p.days ?? '—'} days · {p.comercializadora ?? 'ADX'} · CUPS {p.cups ?? '—'}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 11, color: 'var(--text-3)' }}>Billed total</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 26, fontWeight: 700 }}>{eur(p.total)}</div>
            <div style={{ fontSize: 12, color: deltaColor(rec.totalDeltaEur), marginTop: 2 }}>
              model {eur(rec.modelledTotal)} · Δ {rec.totalDeltaEur == null ? '—' : `${rec.totalDeltaEur > 0 ? '+' : ''}${rec.totalDeltaEur.toFixed(2)}`}
              {rec.totalDeltaPct != null ? ` (${rec.totalDeltaPct > 0 ? '+' : ''}${rec.totalDeltaPct.toFixed(1)}%)` : ''}
            </div>
          </div>
        </div>
        <div style={{ marginTop: 14 }}>
          <BandChips bandKwh={{ P1: p.energy?.P1?.kwh ?? null, P2: p.energy?.P2?.kwh ?? null, P3: p.energy?.P3?.kwh ?? null }} />
        </div>
      </Card>

      <Card title={desktop ? 'Billed vs modelled' : undefined} subtitle={desktop ? 'reconciliation — our cost model priced against this bill' : undefined} icon={desktop ? <Icon name="scale" /> : undefined} style={desktop ? undefined : { padding: 14 }}>
        {!desktop && <Eyebrow>Billed vs modelled</Eyebrow>}
        <div style={{ marginTop: desktop ? 6 : 10 }}>
          <ReconcileTable rows={rec.rows} desktop={desktop} />
        </div>
        {rec.notes.length > 0 && (
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 7 }}>
            {rec.notes.map((n, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, fontSize: 12, color: 'var(--text-2)' }}>
                <Icon name="info" size={14} color="var(--text-3)" />
                <span>{n}</span>
              </div>
            ))}
          </div>
        )}
        {rec.pricingLabel && (
          <div style={{ marginTop: 12, fontSize: 11, color: 'var(--text-3)' }}>Priced with: {rec.pricingLabel}</div>
        )}
      </Card>

      {p.warnings.length > 0 && (
        <Card accent="grid">
          <Eyebrow>Parse warnings</Eyebrow>
          <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12.5, color: 'var(--text-2)' }}>
            {p.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- review form */

/** Editable review of the parsed fields before saving. Edits are sent as a partial patch. */
function Review({
  parsed,
  sourceFile,
  file,
  onCancel,
  onSaved,
  desktop,
}: {
  parsed: ParsedInvoice;
  sourceFile: string;
  file: File | null;
  onCancel: () => void;
  onSaved: () => void;
  desktop: boolean;
}) {
  const [edited, setEdited] = useState<ParsedInvoice>(parsed);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const setBand = (band: 'P1' | 'P2' | 'P3', kwhVal: string) => {
    setEdited((e) => ({
      ...e,
      energy: { ...e.energy, [band]: { ...e.energy?.[band], kwh: kwhVal === '' ? undefined : Number(kwhVal) } } as ParsedInvoice['energy'],
    }));
  };

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const pdfBase64 = file ? await fileToBase64(file) : undefined;
      // Send the full edited struct as `parsed` (already includes any corrections).
      await api.invoices.save({ sourceFile, parsed: edited, pdfBase64 });
      onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'save failed');
      setBusy(false);
    }
  };

  const field = (label: string, value: string | number | undefined, onChange: (v: string) => void) => (
    <Input label={label} defaultValue={value ?? ''} onChange={(ev) => onChange(ev.target.value)} />
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: desktop ? 16 : 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Button variant="ghost" size="sm" iconLeft={<Icon name="arrow-left" size={16} />} onClick={onCancel}>
          Cancel
        </Button>
        <div style={{ flex: 1 }} />
        <Button variant="primary" size="sm" loading={busy} iconLeft={<Icon name="check" size={15} />} onClick={save}>
          Save invoice
        </Button>
      </div>

      <Card>
        <Eyebrow>Review parsed invoice</Eyebrow>
        <div style={{ fontSize: 12.5, color: 'var(--text-3)', margin: '4px 0 14px' }}>
          {sourceFile} · correct anything wrong, then save.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: desktop ? '1fr 1fr 1fr' : '1fr 1fr', gap: 12 }}>
          {field('Factura nº', edited.facturaNum, (v) => setEdited((e) => ({ ...e, facturaNum: v })))}
          {field('Period start (DD-MM-YYYY)', edited.periodStart, (v) => setEdited((e) => ({ ...e, periodStart: v })))}
          {field('Period end (DD-MM-YYYY)', edited.periodEnd, (v) => setEdited((e) => ({ ...e, periodEnd: v })))}
          {field('Days', edited.days, (v) => setEdited((e) => ({ ...e, days: v === '' ? undefined : Number(v) })))}
          {field('Total €', edited.total, (v) => setEdited((e) => ({ ...e, total: v === '' ? undefined : Number(v) })))}
        </div>
        <div style={{ marginTop: 16 }}>
          <Eyebrow>Energy per band (kWh)</Eyebrow>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginTop: 8 }}>
            {(['P1', 'P2', 'P3'] as const).map((b) => field(b, edited.energy?.[b]?.kwh, (v) => setBand(b, v)))}
          </div>
        </div>
        {edited.warnings.length > 0 && (
          <div style={{ marginTop: 14, padding: '10px 12px', borderRadius: 10, background: 'var(--grid-wash)', color: 'var(--grid)', fontSize: 12 }}>
            {edited.warnings.length} field(s) couldn't be read automatically — double-check the values above.
          </div>
        )}
        {err && <div style={{ marginTop: 12, color: 'var(--grid)', fontSize: 13 }}>{err}</div>}
      </Card>
    </div>
  );
}

/* --------------------------------------------------------------- upload zone */

function UploadZone({ onParsed, desktop }: { onParsed: (parsed: ParsedInvoice, sourceFile: string, file: File) => void; desktop: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);

  const handle = async (file: File) => {
    setBusy(true);
    setErr(null);
    try {
      const res = await api.invoices.parse(file);
      onParsed(res.parsed, res.sourceFile, file);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'parse failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card style={desktop ? undefined : { padding: 16 }}>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          const f = e.dataTransfer.files?.[0];
          if (f) void handle(f);
        }}
        style={{
          border: `1.5px dashed ${drag ? 'var(--solar)' : 'var(--border)'}`,
          borderRadius: 14,
          padding: desktop ? '28px 20px' : '22px 14px',
          textAlign: 'center',
          background: drag ? 'var(--solar-wash)' : 'transparent',
          transition: 'background .15s, border-color .15s',
        }}
      >
        <Icon name="file-up" size={desktop ? 30 : 26} color="var(--text-3)" />
        <div style={{ fontSize: 14.5, fontWeight: 600, marginTop: 10 }}>
          {busy ? 'Reading invoice…' : 'Upload an electricity invoice (PDF)'}
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--text-3)', marginTop: 4 }}>
          Drag a PDF here, or pick one. We extract the fields for you to confirm — nothing is saved yet.
        </div>
        <div style={{ marginTop: 14 }}>
          <Button variant="secondary" size="sm" loading={busy} iconLeft={<Icon name="upload" size={15} />} onClick={() => inputRef.current?.click()}>
            Choose PDF
          </Button>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handle(f);
            e.target.value = '';
          }}
        />
        {err && <div style={{ marginTop: 12, color: 'var(--grid)', fontSize: 13 }}>{err}</div>}
      </div>
    </Card>
  );
}

/* --------------------------------------------------------------- main screen */

type View = { kind: 'list' } | { kind: 'review'; parsed: ParsedInvoice; sourceFile: string; file: File | null } | { kind: 'detail'; id: string };

export function Bills({ ctx }: { ctx: ShellContext }) {
  const desktop = ctx.desktop;
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [view, setView] = useState<View>({ kind: 'list' });
  const [invoices, setInvoices] = useState<InvoiceSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const reload = () => {
    api.invoices
      .list()
      .then((r) => setInvoices(r.invoices))
      .catch((e) => setErr(e instanceof Error ? e.message : 'load failed'));
  };
  useEffect(reload, []);

  if (view.kind === 'review') {
    return (
      <Review
        parsed={view.parsed}
        sourceFile={view.sourceFile}
        file={view.file}
        desktop={desktop}
        onCancel={() => setView({ kind: 'list' })}
        onSaved={() => {
          reload();
          setView({ kind: 'list' });
        }}
      />
    );
  }
  if (view.kind === 'detail') {
    return (
      <Detail
        id={view.id}
        desktop={desktop}
        isAdmin={isAdmin}
        onBack={() => setView({ kind: 'list' })}
        onDeleted={() => {
          reload();
          setView({ kind: 'list' });
        }}
      />
    );
  }

  const empty = invoices && invoices.length === 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: desktop ? 18 : 12 }}>
      {isAdmin && (
        <UploadZone
          desktop={desktop}
          onParsed={(parsed, sourceFile, file) => setView({ kind: 'review', parsed, sourceFile, file })}
        />
      )}

      {err && <Card accent="grid"><div style={{ color: 'var(--grid)' }}>{err}</div></Card>}

      {invoices && invoices.length >= 2 && <TrendChart invoices={invoices} desktop={desktop} />}

      {empty && (
        <Card>
          <div style={{ textAlign: 'center', padding: desktop ? '28px 12px' : '20px 8px', color: 'var(--text-3)' }}>
            <Icon name="receipt" size={28} color="var(--text-3)" />
            <div style={{ marginTop: 10, fontSize: 14, color: 'var(--text-2)' }}>No invoices yet.</div>
            <div style={{ fontSize: 12.5, marginTop: 3 }}>{isAdmin ? 'Upload a PDF above to get started.' : 'No invoices have been saved yet.'}</div>
          </div>
        </Card>
      )}

      {invoices && invoices.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: desktop ? '1fr 1fr' : '1fr', gap: desktop ? 16 : 12 }}>
          {invoices.map((inv) => (
            <InvoiceCard key={inv.id} inv={inv} desktop={desktop} onOpen={() => setView({ kind: 'detail', id: inv.id })} />
          ))}
        </div>
      )}

      {!invoices && !err && <Card><div style={{ color: 'var(--text-3)' }}>Loading…</div></Card>}
    </div>
  );
}
