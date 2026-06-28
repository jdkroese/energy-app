// Dedicated invoice vault — a SEPARATE atomic JSON store (`invoices.json`) plus the
// original PDF blobs (`invoices/<id>.pdf`). Kept out of the hot `state.json` (which
// store.ts rewrites on every mutation) exactly like `history5m.ts`: atomic write
// (tmp + rename), never throws, in-memory cache.
//
// Path resolution mirrors store.ts / history5m.ts:
//   INVOICES_FILE / INVOICES_DIR env overrides, else co-located with STATE_FILE, else
//   production → /opt/energy/…, else dev → <repoRoot>/.data/…

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { ParsedInvoice } from './parse';

/** A stored invoice: the parsed struct + any owner edits + provenance. */
export interface Invoice {
  id: string;
  uploadedAt: string; // ISO
  sourceFile: string;
  parsed: ParsedInvoice;
  confirmed: boolean;
  /** Owner corrections applied over `parsed` (only the changed fields). */
  edits?: Partial<ParsedInvoice>;
}

interface InvoicesFile {
  v: 1;
  invoices: Invoice[];
}

let cache: InvoicesFile | null = null;
let filePath: string | null = null;
let dirPath: string | null = null;

function dataDir(): string {
  if (process.env.STATE_FILE) return dirname(process.env.STATE_FILE);
  if (process.env.NODE_ENV === 'production') return '/opt/energy';
  const repoRoot =
    typeof __dirname !== 'undefined'
      ? resolve(__dirname, '..', '..', '..')
      : resolve(process.cwd(), '..', '..');
  return resolve(repoRoot, '.data');
}

function invoicesFilePath(): string {
  if (process.env.INVOICES_FILE) return process.env.INVOICES_FILE;
  return resolve(dataDir(), 'invoices.json');
}

/** Directory holding the original PDF blobs. */
export function invoicesDir(): string {
  if (process.env.INVOICES_DIR) return process.env.INVOICES_DIR;
  return resolve(dataDir(), 'invoices');
}

function file(): string {
  if (!filePath) filePath = invoicesFilePath();
  return filePath;
}
function dir(): string {
  if (!dirPath) dirPath = invoicesDir();
  return dirPath;
}

/**
 * Sanitise a (possibly client-controlled) invoice id into a filesystem-safe slug.
 * Strips EVERYTHING that isn't `[A-Za-z0-9_-]` — so `/`, `\`, `.`, `..`, and any path
 * separator can never appear — and caps the length. Empty after stripping → a timestamp
 * fallback. This is the single chokepoint that makes id→path traversal-proof.
 */
export function safeId(raw: string): string {
  const slug = String(raw)
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 80);
  return slug || `inv-${Date.now()}`;
}

/** Path to a single invoice's stored PDF. ALWAYS sanitises the id, so every caller
 *  (readPdf/savePdf/remove) is traversal-proof regardless of where the id came from. */
export function pdfPath(id: string): string {
  return resolve(dir(), `${safeId(id)}.pdf`);
}

function load(): InvoicesFile {
  if (cache) return cache;
  const f = file();
  try {
    if (existsSync(f)) {
      const raw = JSON.parse(readFileSync(f, 'utf8')) as Partial<InvoicesFile>;
      cache = {
        v: 1,
        invoices: Array.isArray(raw.invoices) ? (raw.invoices as Invoice[]) : [],
      };
    } else {
      cache = { v: 1, invoices: [] };
    }
  } catch (e) {
    console.error('[invoices] load failed, starting empty:', (e as Error).message);
    cache = { v: 1, invoices: [] };
  }
  return cache;
}

function persist(state: InvoicesFile): void {
  const f = file();
  try {
    const d = dirname(f);
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), 'utf8');
    renameSync(tmp, f); // atomic on the same filesystem
  } catch (e) {
    console.error('[invoices] persist failed:', (e as Error).message);
  }
}

/** All invoices, newest-first (by uploadedAt). */
export function list(): Invoice[] {
  return [...load().invoices].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
}

/** One invoice by id, or null. */
export function get(id: string): Invoice | null {
  return load().invoices.find((i) => i.id === id) ?? null;
}

/** Persist a PDF blob for an invoice. Never throws. */
export function savePdf(id: string, buf: Buffer | Uint8Array): void {
  try {
    const d = dir();
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
    const tmp = `${pdfPath(id)}.${process.pid}.tmp`;
    writeFileSync(tmp, buf);
    renameSync(tmp, pdfPath(id));
  } catch (e) {
    console.error('[invoices] savePdf failed:', (e as Error).message);
  }
}

/** Read a stored PDF blob, or null if absent. */
export function readPdf(id: string): Buffer | null {
  try {
    const p = pdfPath(id);
    if (!existsSync(p)) return null;
    return readFileSync(p);
  } catch {
    return null;
  }
}

/** Insert (or replace by id) an invoice record. Returns the stored record. */
export function upsert(inv: Invoice): Invoice {
  const state = load();
  const idx = state.invoices.findIndex((i) => i.id === inv.id);
  if (idx >= 0) state.invoices[idx] = inv;
  else state.invoices.push(inv);
  persist(state);
  return inv;
}

/** Delete an invoice record + its PDF blob. Returns true if a record was removed. */
export function remove(id: string): boolean {
  const state = load();
  const before = state.invoices.length;
  state.invoices = state.invoices.filter((i) => i.id !== id);
  const removed = state.invoices.length < before;
  if (removed) {
    persist(state);
    try {
      rmSync(pdfPath(id), { force: true });
    } catch {
      /* best-effort blob cleanup */
    }
  }
  return removed;
}
