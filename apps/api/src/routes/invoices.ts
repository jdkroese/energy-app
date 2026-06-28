// Invoice vault routes (Phase 1 — additive + read-only; no control/battery paths touched).
//
//   POST   /api/invoices/parse   multipart PDF upload → parse, return ParsedInvoice (NOT saved)
//   POST   /api/invoices         confirm/save: { sourceFile, parsed, edits? } (+ optional pdfBase64)
//   GET    /api/invoices         list newest-first (summaries)
//   GET    /api/invoices/:id     detail + reconciliation
//   GET    /api/invoices/:id/pdf serve the stored PDF
//   DELETE /api/invoices/:id     delete record + blob
//
// Mutating routes (parse/save/delete) are admin-gated in index.ts like the other writes.
// The PDF upload for /parse is handled with multer (memory storage, 15MB cap).

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { parseInvoicePdf, type ParsedInvoice } from '../invoices/parse';
import * as invoices from '../invoices/store';
import { reconcile, effectiveParsed, type Reconciliation } from '../invoices/model';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB — an ADX PDF is ~200KB; generous headroom.
});

/** Compact list/summary view of a stored invoice (per-band kWh + headline figures). */
export interface InvoiceSummary {
  id: string;
  uploadedAt: string;
  sourceFile: string;
  confirmed: boolean;
  facturaNum?: string;
  periodStart?: string;
  periodEnd?: string;
  total?: number;
  bandKwh: { P1: number | null; P2: number | null; P3: number | null };
  /** True if a read looks estimated or the reconciliation total delta is large. */
  flagged: boolean;
  flagReason?: string;
}

export interface InvoiceDetail {
  id: string;
  uploadedAt: string;
  sourceFile: string;
  confirmed: boolean;
  parsed: ParsedInvoice;
  reconciliation: Reconciliation;
}

const LARGE_DELTA_PCT = 5; // a |total delta| beyond this flags the card

function summarize(inv: invoices.Invoice): InvoiceSummary {
  const p = effectiveParsed(inv);
  const rec = reconcile(inv);
  const bandKwh = {
    P1: p.energy?.P1?.kwh ?? null,
    P2: p.energy?.P2?.kwh ?? null,
    P3: p.energy?.P3?.kwh ?? null,
  };
  let flagged = false;
  let flagReason: string | undefined;
  if (rec.totalDeltaPct != null && Math.abs(rec.totalDeltaPct) >= LARGE_DELTA_PCT) {
    flagged = true;
    flagReason = `Model vs bill off by ${rec.totalDeltaPct}%`;
  }
  if (p.warnings.length) {
    flagged = true;
    flagReason = flagReason ?? `${p.warnings.length} parse warning(s)`;
  }
  return {
    id: inv.id,
    uploadedAt: inv.uploadedAt,
    sourceFile: inv.sourceFile,
    confirmed: inv.confirmed,
    facturaNum: p.facturaNum,
    periodStart: p.periodStart,
    periodEnd: p.periodEnd,
    total: p.total,
    bandKwh,
    flagged,
    flagReason,
  };
}

/** POST /api/invoices/parse — parse an uploaded PDF, return the struct, DO NOT save. */
export async function postParse(req: Request, res: Response): Promise<void> {
  const file = (req as Request & { file?: { buffer: Buffer; originalname: string } }).file;
  if (!file || !file.buffer?.length) {
    res.status(400).json({ error: 'no PDF uploaded (field "file")', code: 'BAD_INPUT' });
    return;
  }
  const parsed = await parseInvoicePdf(file.buffer);
  res.json({ parsed, sourceFile: file.originalname });
}

/** POST /api/invoices — confirm/save a parsed+edited record (+ optional base64 PDF). */
export function postSave(req: Request, res: Response): void {
  const body = (req.body ?? {}) as {
    sourceFile?: string;
    parsed?: ParsedInvoice;
    edits?: Partial<ParsedInvoice>;
    pdfBase64?: string;
  };
  if (!body.parsed || typeof body.parsed !== 'object') {
    res.status(400).json({ error: 'missing parsed invoice', code: 'BAD_INPUT' });
    return;
  }
  const parsed: ParsedInvoice = {
    ...body.parsed,
    warnings: Array.isArray(body.parsed.warnings) ? body.parsed.warnings : [],
  };
  // Stable id from the factura number when present, else a timestamp id.
  const merged = { ...parsed, ...(body.edits ?? {}) };
  const id = merged.facturaNum?.trim() || `inv-${Date.now()}`;
  const inv: invoices.Invoice = {
    id,
    uploadedAt: new Date().toISOString(),
    sourceFile: body.sourceFile || `${id}.pdf`,
    parsed,
    confirmed: true,
    edits: body.edits && Object.keys(body.edits).length ? body.edits : undefined,
  };
  if (body.pdfBase64) {
    try {
      const buf = Buffer.from(body.pdfBase64.replace(/^data:application\/pdf;base64,/, ''), 'base64');
      if (buf.length) invoices.savePdf(id, buf);
    } catch {
      /* a bad blob doesn't block saving the record */
    }
  }
  invoices.upsert(inv);
  res.json({ id, invoice: summarize(inv) });
}

/** GET /api/invoices — list, newest first. */
export function getList(_req: Request, res: Response): void {
  res.json({ invoices: invoices.list().map(summarize) });
}

/** GET /api/invoices/:id — detail + reconciliation. */
export function getDetail(req: Request, res: Response): void {
  const inv = invoices.get(String(req.params.id));
  if (!inv) {
    res.status(404).json({ error: 'invoice not found', code: 'NOT_FOUND' });
    return;
  }
  const detail: InvoiceDetail = {
    id: inv.id,
    uploadedAt: inv.uploadedAt,
    sourceFile: inv.sourceFile,
    confirmed: inv.confirmed,
    parsed: effectiveParsed(inv),
    reconciliation: reconcile(inv),
  };
  res.json(detail);
}

/** GET /api/invoices/:id/pdf — serve the stored PDF blob. */
export function getPdf(req: Request, res: Response): void {
  const id = String(req.params.id);
  const buf = invoices.readPdf(id);
  if (!buf) {
    res.status(404).json({ error: 'PDF not found', code: 'NOT_FOUND' });
    return;
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${id}.pdf"`);
  res.send(buf);
}

/** DELETE /api/invoices/:id — remove record + blob. */
export function deleteInvoice(req: Request, res: Response): void {
  const removed = invoices.remove(String(req.params.id));
  if (!removed) {
    res.status(404).json({ error: 'invoice not found', code: 'NOT_FOUND' });
    return;
  }
  res.json({ ok: true });
}

/** The multer middleware for the single-file parse upload (field name "file"). */
export const parseUpload = upload.single('file');

/**
 * Optional convenience router (not used by index.ts, which mounts handlers individually
 * with its own admin gating, but handy for tests / standalone mounting).
 */
export function invoicesRouter(): Router {
  const r = Router();
  r.post('/parse', parseUpload, postParse);
  r.post('/', postSave);
  r.get('/', getList);
  r.get('/:id', getDetail);
  r.get('/:id/pdf', getPdf);
  r.delete('/:id', deleteInvoice);
  return r;
}
