// Local photo cache (docs/48 §4b) — the durability core of "make sure all recipes have
// pictures". Hotlinked provider/og:image URLs are fragile (referrer/burst limits, rot,
// upload.wikimedia.org 429s bursty image fetches per docs/48's live probe); downloading once
// to <dataDir>/recipe-photos/<recipeId>.jpg removes render-time flakiness forever and is
// license-compliant (CC + Pexels licenses permit storing a copy; we keep the attribution and
// add the license name in the UI credit line).
//
// Paced independently of the SEARCH throttle in photo-providers.ts (>=10s between downloads,
// regardless of which provider/search produced the URL) — downloads and searches hit
// different hosts (upload.wikimedia.org / images.pexels.com vs. the search APIs) and fail for
// different reasons, so they get their own throttle state here.
//
// Validation: HTTP 200 + Content-Type starting with image/ + >10 KB. A download failure keeps
// the recipe exactly as it was (photo-null, or still hotlinked) — NEVER treated as a
// definitive no-hit; the caller (photo-enrich.ts) just retries later.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dataDir } from '../store';

const MIN_DOWNLOAD_INTERVAL_MS = 10_000;
const MIN_BYTES = 10 * 1024;
const USER_AGENT = 'EnergyApp-KitchenRecipes/1.0 (self-hosted household app; recipe photo caching)';

/** <dataDir>/recipe-photos — created on first use. Resolved the same way kitchen.json/
 *  recipes.db resolve their directory (store.ts's dataDir()), so it lands next to them on
 *  the mini (/opt/energy) and in dev (<repoRoot>/.data). */
export function photosDir(): string {
  return resolve(dataDir(), 'recipe-photos');
}

// Recipe ids are always simple alnum/underscore/dash tokens (generate.ts's `gen_N`, seed
// slugs, etc.) — this guard exists purely as a path-traversal defense for the one place an id
// flows straight into a filesystem path (both the download write and the serve read use it).
const VALID_ID = /^[A-Za-z0-9_-]+$/;

export function cachedPhotoPath(recipeId: string): string {
  if (!VALID_ID.test(recipeId)) throw new Error(`invalid recipe id: ${recipeId}`);
  return resolve(photosDir(), `${recipeId}.jpg`);
}

/** The URL the app serves the cached photo at (routes/kitchen.ts registers the GET handler). */
export function cachedPhotoRoute(recipeId: string): string {
  return `/api/kitchen/photos/${recipeId}`;
}

export function hasCachedPhoto(recipeId: string): boolean {
  return existsSync(cachedPhotoPath(recipeId));
}

// ---- Throttle (pure, injectable clock — mirrors photo-providers.ts's pattern) -----------------

let lastDownloadAt = -Infinity;

export function canDownloadNow(now: number): boolean {
  return now - lastDownloadAt >= MIN_DOWNLOAD_INTERVAL_MS;
}

/** Test-only: reset the download throttle between test cases. */
export function _resetThrottleForTests(): void {
  lastDownloadAt = -Infinity;
}

let clock: () => number = () => Date.now();
/** Test-only: inject a deterministic clock (pass nothing to restore Date.now). */
export function _setClockForTests(fn?: () => number): void {
  clock = fn ?? (() => Date.now());
}

type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

let fetchImpl: FetchLike = fetch as unknown as FetchLike;
/** Test-only: swap the fetch implementation (pass nothing to restore the real one). */
export function _setFetchForTests(fn?: FetchLike): void {
  fetchImpl = fn ?? (fetch as unknown as FetchLike);
}

export type DownloadOutcome =
  | { kind: 'cached'; route: string }
  | { kind: 'throttled' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'error'; detail: string };

/**
 * Download `url` and persist it as the durable local photo for `recipeId`, or report why it
 * didn't happen. Every non-'cached' outcome is retryable — never a signal to give up on the
 * recipe (that's what photoTriedAt from the SEARCH step means, not this).
 */
export async function downloadAndCache(recipeId: string, url: string): Promise<DownloadOutcome> {
  const now = clock();
  if (!canDownloadNow(now)) return { kind: 'throttled' };
  lastDownloadAt = now;

  try {
    const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) return { kind: 'invalid', reason: `http ${res.status}` };
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (!contentType.startsWith('image/')) return { kind: 'invalid', reason: `content-type "${contentType || 'missing'}"` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < MIN_BYTES) return { kind: 'invalid', reason: `only ${buf.length} bytes` };

    const dir = photosDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(cachedPhotoPath(recipeId), buf);
    return { kind: 'cached', route: cachedPhotoRoute(recipeId) };
  } catch (e) {
    return { kind: 'error', detail: (e as Error).message };
  }
}

// ---- Serving (routes/kitchen.ts wires the Express handler around this) -----------------------

export interface CachedPhotoFile {
  buffer: Buffer;
  contentType: string;
}

/** Sniff the real image format from magic bytes — the file is always named "<id>.jpg" (docs/48
 *  §4b simplification) regardless of the source format, so the Content-Type the route sends
 *  has to come from the bytes, not the filename. Defaults to jpeg (the common case). */
function sniffContentType(buf: Buffer): string {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return 'image/jpeg';
}

/** Read the cached file for `GET /api/kitchen/photos/:recipeId`, or null on a 404. Pure
 *  (no res/req) so it's directly unit-testable — mirrors media.ts's alarmClip() split. */
export function readCachedPhoto(recipeId: string): CachedPhotoFile | null {
  try {
    const path = cachedPhotoPath(recipeId);
    if (!existsSync(path)) return null;
    const buffer = readFileSync(path);
    return { buffer, contentType: sniffContentType(buffer) };
  } catch {
    return null;
  }
}
