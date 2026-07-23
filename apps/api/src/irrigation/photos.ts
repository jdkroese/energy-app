// On-disk garden-photo asset store for irrigation zones. One photo per zone, stored OUTSIDE
// the hot state.json (which only keeps the small photoId reference). Mirrors the invoices
// blob store. Photos are NEVER pushed to the controller — the LNK has no photo concept.
//
// Layout: <dataDir>/irrigation-photos/<photoId>.<ext>  (jpg/png/webp). The photoId is a
// random opaque token so the URL doesn't leak the zone or the original filename.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { dataDir } from "../store";

/** Allowed upload mime types → file extension. */
const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** Max accepted photo size (bytes). A phone photo is ~2–5 MB; 8 MB is generous headroom. */
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

function dir(): string {
  return resolve(dataDir(), "irrigation-photos");
}

/** A photoId is `<token>.<ext>` so the path is self-describing and safe (no user filename). */
function pathFor(photoId: string): string | null {
  // Only ever resolve ids we minted (token.ext) — reject anything with separators.
  if (!/^[a-f0-9]{16,}\.(jpg|png|webp)$/.test(photoId)) return null;
  return resolve(dir(), photoId);
}

export interface SavedPhoto {
  photoId: string;
  contentType: string;
}

/** Validate + persist an uploaded photo buffer. Returns the new photoId, or throws BAD_INPUT. */
export function savePhoto(buf: Buffer, mime: string): SavedPhoto {
  const ext = MIME_EXT[mime];
  if (!ext) {
    const e = new Error("Photo must be a JPEG, PNG, or WebP image") as Error & {
      code: string;
    };
    e.code = "BAD_INPUT";
    throw e;
  }
  if (buf.length === 0 || buf.length > MAX_PHOTO_BYTES) {
    const e = new Error(
      `Photo must be 1 byte–${Math.round(MAX_PHOTO_BYTES / 1024 / 1024)} MB`,
    ) as Error & {
      code: string;
    };
    e.code = "BAD_INPUT";
    throw e;
  }
  const d = dir();
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  const photoId = `${randomBytes(12).toString("hex")}.${ext}`;
  const full = resolve(d, photoId);
  const tmp = `${full}.${process.pid}.tmp`;
  writeFileSync(tmp, buf);
  renameSync(tmp, full);
  return { photoId, contentType: mime };
}

/** Read a stored photo (+ its content-type), or null if absent/invalid id. */
export function readPhoto(
  photoId: string,
): { buf: Buffer; contentType: string } | null {
  const p = pathFor(photoId);
  if (!p || !existsSync(p)) return null;
  const ext = photoId.split(".").pop();
  const contentType =
    ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  try {
    return { buf: readFileSync(p), contentType };
  } catch {
    return null;
  }
}

/** Delete a stored photo blob (best-effort; never throws). */
export function deletePhoto(photoId: string | undefined | null): void {
  if (!photoId) return;
  const p = pathFor(photoId);
  if (!p) return;
  try {
    rmSync(p, { force: true });
  } catch {
    /* best-effort */
  }
}
