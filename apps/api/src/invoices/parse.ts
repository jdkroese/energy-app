// ADX Renovables electricity-invoice parser.
//
// The bills are DIGITAL-TEXT PDFs (not scans), so server-side text extraction works.
// We extract the text with pdfjs-dist's legacy (pure-JS, no-worker) build and then
// pull the labelled fields with regexes anchored on STABLE ASCII substrings.
//
// Tolerance rules (the bill is Spanish + occasionally mojibake'd):
//   • Decimals use a comma (`0,209285`); thousands use a dot (`1.005,64`). `esNum()`
//     normalises both.  Accented labels can come through as `�` in some extractions,
//     so every anchor avoids the accented chars (e.g. match `rmino Energ` not
//     `Término Energía`).
//   • EVERY field is optional. The parser NEVER throws — a missing/odd field just
//     stays undefined and pushes a string onto `warnings[]`.
//
// The struct is returned for owner review BEFORE persisting (the route does not save).

import { getDocument, VerbosityLevel } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { Band } from '../tariff';

/** One per-band line `<kwh> kWh x <rate>€  <amount>€`. */
export interface BandLine {
  kwh?: number;
  rate?: number;
  amount?: number;
}

/** One power-term line `<kw> kW x <days> días x <rate>€  <amount>€`. */
export interface PowerLine {
  kw?: number;
  days?: number;
  rate?: number;
  amount?: number;
}

/** The billed electricity tax line, captured verbatim enough to reconcile. */
export interface IeeLine {
  /** Printed amount (€). */
  amount?: number;
  /** When the bill expressed it as `<base>€ x <pct>`. */
  basis?: number;
  pct?: number;
  /** When the bill expressed it as `<mwh>MWh x <eurPerMwh>€/MWh` (the per-MWh floor). */
  mwh?: number;
  eurPerMwh?: number;
}

export interface ParsedInvoice {
  // identity
  facturaNum?: string;
  fechaFactura?: string; // DD-MM-YYYY
  cups?: string;
  nif?: string;
  comercializadora?: string;
  // period
  periodStart?: string; // DD-MM-YYYY
  periodEnd?: string; // DD-MM-YYYY
  days?: number;
  // contracted power (kW) per band, and observed maximeter (kW) per band
  contractedKw?: { P1?: number; P2?: number };
  maxPowerKw?: { P1?: number; P2?: number; P3?: number };
  // meter register difference per band (gross consumption from `Lectura de contador`)
  meterRegister?: Record<Band, number | undefined>;
  // billed energy term per band (differs from register: hourly self-consumption netting)
  energy?: Record<Band, BandLine | undefined>;
  // power term per band (€/kW/day split)
  power?: { P1?: PowerLine; P2?: PowerLine };
  // export compensation per band (excedentes; negative kWh, positive rate)
  excedentes?: Record<Band, BandLine | undefined>;
  /** Retroactive "Costes del Sistema" / SSAA settlement lines (regularizaciones).
   *  Month-specific true-ups (e.g. `Liquidación SSAA <kwh> kWh x <rate>€/kWh  <amount>€`)
   *  that land in the subtotal but are NOT part of the standing model — surfaced so the
   *  reconciliation can name them instead of leaving an unexplained subtotal delta. */
  adjustments?: Array<{ label: string; kwh?: number; rate?: number; amount?: number }>;
  // line totals
  subtotal?: number;
  iee?: IeeLine;
  meterRental?: number;
  bonoSocial?: { days?: number; rate?: number; amount?: number };
  baseImponible?: number;
  ivaPct?: number;
  iva?: number;
  total?: number;
  /** Non-fatal parse issues, surfaced in the review UI. */
  warnings: string[];
}

const BANDS: Band[] = ['P1', 'P2', 'P3'];

/** Parse a Spanish-formatted number: dot = thousands, comma = decimal. */
export function esNum(raw: string | undefined | null): number | undefined {
  if (raw == null) return undefined;
  const s = String(raw).trim().replace(/\s+/g, '');
  if (!s) return undefined;
  // Remove thousands dots, then turn the decimal comma into a point.
  const norm = s.replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  const n = Number(norm);
  return Number.isFinite(n) ? n : undefined;
}

/** First capture group of the first match, or undefined. */
function m1(text: string, re: RegExp): string | undefined {
  const m = re.exec(text);
  return m ? m[1] : undefined;
}

/**
 * Extract the full text of a PDF buffer using pdfjs-dist's legacy build.
 * Items are grouped into visual lines by their Y transform so labelled
 * "label  value" rows survive as single lines for the anchored regexes.
 */
export async function extractText(buf: Buffer | Uint8Array): Promise<string> {
  // pdfjs v4 rejects a Node Buffer (even though it IS a Uint8Array subclass), so
  // copy into a plain Uint8Array over the exact byte range.
  const data = new Uint8Array(buf.byteLength);
  data.set(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
  const doc = await getDocument({
    data,
    // Headless server: no worker, no system fonts. We only read text positions, never
    // render glyphs, so missing standard-font data is irrelevant — silence the noise.
    isEvalSupported: false,
    useSystemFonts: false,
    verbosity: VerbosityLevel.ERRORS,
  }).promise;
  const lines: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    let lastY: number | null = null;
    let line = '';
    for (const it of tc.items as Array<{ str: string; transform: number[]; hasEOL?: boolean }>) {
      const y = it.transform[5];
      if (lastY !== null && Math.abs(y - lastY) > 2) {
        lines.push(line);
        line = '';
      }
      line += it.str + (it.hasEOL ? '' : ' ');
      lastY = y;
    }
    if (line) lines.push(line);
  }
  await doc.cleanup().catch(() => {});
  return lines.join('\n');
}

/** Parse a band-energy / excedente line by its anchor label, returning kwh/rate/amount. */
function parseBandLine(text: string, anchor: RegExp): BandLine | undefined {
  const m = anchor.exec(text);
  if (!m) return undefined;
  // Capture the `<kwh> kWh x <rate>€   <amount> €` numbers from the matched region.
  const kwh = esNum(m[1]);
  const rate = esNum(m[2]);
  const amount = esNum(m[3]);
  const out: BandLine = {};
  if (kwh !== undefined) out.kwh = kwh;
  if (rate !== undefined) out.rate = rate;
  if (amount !== undefined) out.amount = amount;
  return Object.keys(out).length ? out : undefined;
}

// Number token used inside the line regexes (handles `1.005,64`, `-174,67`, `32,48`).
const N = '(-?[\\d.]+,?\\d*)';

/** Parse already-extracted invoice text into a tolerant ParsedInvoice. Never throws. */
export function parseInvoiceText(text: string): ParsedInvoice {
  const out: ParsedInvoice = { warnings: [] };
  const warn = (s: string) => out.warnings.push(s);
  // Collapse runs of whitespace for label matching but keep newlines navigable.
  const t = text.replace(/[ \t]+/g, ' ');

  // ---- identity ----
  out.facturaNum = m1(t, /Factura n[u\W]?m:?\s*(\d{6,})/i);
  if (!out.facturaNum) warn('facturaNum not found');
  out.fechaFactura = m1(t, /Fecha factura:?\s*(\d{2}-\d{2}-\d{4})/i);
  out.cups = m1(t, /CUPS:?\s*([A-Z0-9]{18,22})/i);
  out.nif = m1(t, /(?:CIF\/NIF|NIF)\s*Titular:?\s*([A-Z0-9]{8,10})/i);
  if (/ADX/i.test(t)) out.comercializadora = 'ADX Renovables, S.L.';

  // ---- period ----
  const per = /Periodo de facturaci\W?n:?\s*Del\s*(\d{2}-\d{2}-\d{4})\s*al\s*(\d{2}-\d{2}-\d{4})/i.exec(t);
  if (per) {
    out.periodStart = per[1];
    out.periodEnd = per[2];
  } else {
    warn('billing period not found');
  }

  // ---- contracted + max power (kW) ----
  const pot = /Potencia\(s\):?\s*([\d.,]+)\s*kW;\s*([\d.,]+)\s*kW/i.exec(t);
  if (pot) out.contractedKw = { P1: esNum(pot[1]), P2: esNum(pot[2]) };
  const maxp = /Potencia\(s\) M\W?xima\(s\):?\s*([\d.,]+)\s*kW;\s*([\d.,]+)\s*kW;\s*([\d.,]+)\s*kW/i.exec(t);
  if (maxp) out.maxPowerKw = { P1: esNum(maxp[1]), P2: esNum(maxp[2]), P3: esNum(maxp[3]) };

  // ---- meter register (Lectura de contador): per-band `Px <act> <ant> <dif>` ----
  // We want the final number on each `Px ...` line within the register block.
  const reg: Record<Band, number | undefined> = { P1: undefined, P2: undefined, P3: undefined };
  for (const b of BANDS) {
    // Px followed by 2 or 3 dotted/grouped numbers; the LAST is the difference (consumption).
    const re = new RegExp(`\\b${b}\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)\\b`);
    const mm = re.exec(t);
    if (mm) reg[b] = esNum(mm[3]);
  }
  if (reg.P1 !== undefined || reg.P2 !== undefined || reg.P3 !== undefined) out.meterRegister = reg;
  else warn('meter register block not found');

  // ---- energy term per band: `T(e/é)rmino Energía Px ... <kwh> kWh x <rate>€  <amount>€` ----
  const energy: Record<Band, BandLine | undefined> = { P1: undefined, P2: undefined, P3: undefined };
  for (const b of BANDS) {
    const anchor = new RegExp(`rmino Energ\\Wa\\s+${b}[\\s\\S]{0,40}?${N}\\s*kWh\\s*x\\s*${N}\\s*\\W?\\s*${N}`, 'i');
    energy[b] = parseBandLine(t, anchor);
    if (!energy[b]) warn(`energy ${b} not found`);
  }
  out.energy = energy;

  // ---- power term per band: `... Px <kw> kW x <days> días x <rate>€  <amount>€` ----
  const power: { P1?: PowerLine; P2?: PowerLine } = {};
  for (const b of ['P1', 'P2'] as const) {
    const re = new RegExp(
      `rmino de Potencia\\s+${b}[\\s\\S]{0,40}?${N}\\s*kW\\s*x\\s*${N}\\s*d\\Was\\s*x\\s*${N}\\s*\\W?\\s*${N}`,
      'i',
    );
    const mm = re.exec(t);
    if (mm) {
      const pl: PowerLine = {};
      const kw = esNum(mm[1]);
      const days = esNum(mm[2]);
      const rate = esNum(mm[3]);
      const amount = esNum(mm[4]);
      if (kw !== undefined) pl.kw = kw;
      if (days !== undefined) pl.days = days;
      if (rate !== undefined) pl.rate = rate;
      if (amount !== undefined) pl.amount = amount;
      power[b] = pl;
      if (out.days === undefined && days !== undefined) out.days = days;
    } else {
      warn(`power term ${b} not found`);
    }
  }
  out.power = power;

  // ---- excedentes per band: `Excedente del periodo n  -<kwh> kWh x <rate>€  <amount>€` ----
  const exc: Record<Band, BandLine | undefined> = { P1: undefined, P2: undefined, P3: undefined };
  for (let i = 0; i < 3; i++) {
    const b = BANDS[i];
    const anchor = new RegExp(`Excedente del periodo ${i + 1}[\\s\\S]{0,40}?${N}\\s*kWh\\s*x\\s*${N}\\s*\\W?\\s*${N}`, 'i');
    exc[b] = parseBandLine(t, anchor);
  }
  if (exc.P1 || exc.P2 || exc.P3) out.excedentes = exc;

  // ---- bono social: `<days> días x <rate>€ /día  <amount>€` ----
  const bs = new RegExp(`Bono Social[\\s\\S]{0,60}?${N}\\s*d\\Was\\s*x\\s*${N}\\s*\\W?\\s*\\/d\\Wa\\s*${N}`, 'i').exec(t);
  if (bs) {
    out.bonoSocial = { days: esNum(bs[1]), rate: esNum(bs[2]), amount: esNum(bs[3]) };
  }

  // ---- adjustments: Liquidación SSAA / Costes del Sistema true-ups ----
  // `Liquidación SSAA  <kwh> kWh x <rate>€/kWh  <amount>€` — may appear 0..n times.
  const adjRe = new RegExp(`Liquidaci\\Wn SSAA[\\s\\S]{0,30}?${N}\\s*kWh\\s*x\\s*${N}\\s*\\W?\\/kWh\\s*${N}`, 'gi');
  const adjustments: NonNullable<ParsedInvoice['adjustments']> = [];
  let am: RegExpExecArray | null;
  while ((am = adjRe.exec(t)) !== null) {
    adjustments.push({ label: 'Liquidación SSAA', kwh: esNum(am[1]), rate: esNum(am[2]), amount: esNum(am[3]) });
  }
  if (adjustments.length) out.adjustments = adjustments;

  // ---- subtotal / IEE / rental / base / IVA / total ----
  out.subtotal = esNum(m1(t, new RegExp(`Subtotal\\s*${N}\\s*\\W`, 'i')));

  // IEE has two forms. Try the percentage form first, then the per-MWh-floor form.
  const ieePct = new RegExp(`electricidad[\\s\\S]{0,40}?${N}\\s*\\W?\\s*x\\s*0?,?(\\d{2,12})\\s*\\W?\\s*${N}`, 'i').exec(t);
  const ieeMwh = new RegExp(`electricidad[\\s\\S]{0,40}?${N}\\s*MWh\\s*x\\s*${N}\\s*\\W?\\/MWh\\s*${N}`, 'i').exec(t);
  if (ieeMwh) {
    out.iee = {
      mwh: esNum(ieeMwh[1]),
      eurPerMwh: esNum(ieeMwh[2]),
      amount: esNum(ieeMwh[3]),
    };
  } else if (ieePct) {
    out.iee = {
      basis: esNum(ieePct[1]),
      pct: esNum(`0,${ieePct[2]}`),
      amount: esNum(ieePct[3]),
    };
  } else {
    warn('IEE line not found');
  }

  out.meterRental = esNum(m1(t, new RegExp(`Alquiler de equipos\\s*${N}\\s*\\W`, 'i')));
  out.baseImponible = esNum(m1(t, new RegExp(`Base Imponible\\s*${N}\\s*\\W`, 'i')));
  const iva = new RegExp(`IVA\\s*${N}\\s*%\\s*${N}\\s*\\W`, 'i').exec(t);
  if (iva) {
    out.ivaPct = esNum(iva[1]);
    out.iva = esNum(iva[2]);
  }
  out.total = esNum(m1(t, new RegExp(`TOTAL FACTURA\\s*${N}\\s*\\W`, 'i')));
  if (out.total === undefined) warn('TOTAL FACTURA not found');

  return out;
}

/** Extract + parse a PDF buffer end-to-end. Never throws (extraction failures → a warning). */
export async function parseInvoicePdf(buf: Buffer | Uint8Array): Promise<ParsedInvoice> {
  let text = '';
  try {
    text = await extractText(buf);
  } catch (e) {
    return { warnings: [`PDF text extraction failed: ${(e as Error).message}`] };
  }
  if (!text.trim()) return { warnings: ['PDF produced no extractable text (a scan?)'] };
  return parseInvoiceText(text);
}
