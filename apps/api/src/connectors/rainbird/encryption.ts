// Rain Bird LNK / LNK2 WiFi module crypto — a faithful Node `crypto` port of
// pyrainbird/encryption.py (github.com/allenporter/pyrainbird). The module wraps
// each JSON-RPC request body in an AES-256-CBC envelope keyed by the controller
// password; the response comes back in the same envelope.
//
// Wire layout (request AND response body):
//   bytes[0..32)   = SHA256(plaintextJson)          (integrity hash of the *unpadded* JSON)
//   bytes[32..48)  = IV                              (16 random bytes per request)
//   bytes[48..)    = AES-256-CBC(ciphertext)
//
// Key       = SHA256(password)  → 32 bytes (AES-256).
// Plaintext = json + "\x00\x10", then right-padded with "\x10" to a 16-byte boundary.
// Decrypt   = AES-CBC over bytes[48..) using IV=bytes[32..48), then strip trailing
//             \x10 / \x0a / \x00 / whitespace and JSON.parse.
//
// NOTE: the integrity hash is SHA256 of the ORIGINAL json (without the "\x00\x10"
// suffix or padding), exactly as pyrainbird computes it (`b2 = SHA256(data)`).

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const BLOCK_SIZE = 16;
const PAD = 0x10; // "\x10"

/** AES-256 key = SHA256(password). */
function symmetricKey(password: string): Buffer {
  return createHash("sha256").update(password, "utf8").digest();
}

/** Right-pad to a 16-byte boundary with 0x10 bytes (matches pyrainbird `_add_padding`).
 *  When the length is already a multiple of 16 NO padding is added (remaining % 16 == 0). */
function addPadding(data: Buffer): Buffer {
  const remaining = BLOCK_SIZE - (data.length % BLOCK_SIZE);
  const padLen = remaining % BLOCK_SIZE;
  if (padLen === 0) return data;
  return Buffer.concat([data, Buffer.alloc(padLen, PAD)]);
}

/**
 * Encrypt a JSON payload string into the LNK wire envelope.
 * Returns `SHA256(json) ++ IV ++ AES-CBC(json + "\x00\x10" padded)`.
 *
 * @param iv optional fixed IV (16 bytes) — used by tests for deterministic vectors;
 *           production passes none so a fresh random IV is generated per request.
 */
export function encrypt(json: string, password: string, iv?: Buffer): Buffer {
  const key = symmetricKey(password);
  const realIv = iv ?? randomBytes(16);
  if (realIv.length !== 16)
    throw new Error("rainbird encrypt: IV must be 16 bytes");

  const hash = createHash("sha256").update(json, "utf8").digest(); // hash of the *unpadded* json
  const plaintext = addPadding(
    Buffer.concat([Buffer.from(json, "utf8"), Buffer.from([0x00, 0x10])]),
  );

  const cipher = createCipheriv("aes-256-cbc", key, realIv);
  cipher.setAutoPadding(false); // we pad manually (PKCS-ish 0x10 fill) to match the device
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return Buffer.concat([hash, realIv, ciphertext]);
}

/**
 * Decrypt an LNK wire envelope back to its JSON string. IV = bytes[32..48),
 * ciphertext = bytes[48..). Trailing 0x10 / 0x0a / 0x00 / whitespace are stripped,
 * mirroring pyrainbird's `.rstrip("\x10").rstrip("\x0a").rstrip("\x00").rstrip()`.
 */
export function decrypt(encrypted: Buffer, password: string): string {
  if (encrypted.length < 48)
    throw new Error("rainbird decrypt: payload too short");
  const key = symmetricKey(password);
  const iv = encrypted.subarray(32, 48);
  const ciphertext = encrypted.subarray(48);

  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  decipher.setAutoPadding(false);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  // Strip the trailing pad/terminator/whitespace bytes (0x10, 0x0a, 0x00, and ASCII ws).
  let end = plain.length;
  const isStrippable = (b: number) =>
    b === 0x10 ||
    b === 0x0a ||
    b === 0x00 ||
    b === 0x20 ||
    b === 0x09 ||
    b === 0x0d;
  while (end > 0 && isStrippable(plain[end - 1])) end--;
  return plain.subarray(0, end).toString("utf8");
}
