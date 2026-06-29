// Rain Bird LNK / LNK2 transport. Each call POSTs an AES-encrypted JSON-RPC 2.0 body
// to `<host>/stick` (content type application/octet-stream); the encrypted response is
// decrypted and the inner `result` returned.
//
// Two module generations, two endpoints — we try both:
//   * LNK2 "LNKSS" (secure server): HTTPS on port 443 (self-signed cert).
//   * classic LNK:                  plain HTTP on port 80.
// We attempt HTTPS:443 first and fall back to HTTP:80 only on a CONNECTION-level error
// (refused/timeout); an actual HTTP response — even 403 "Invalid Password" — is a real
// answer and is surfaced as-is. An explicit `host:port` overrides the port.
//
// CRITICAL: the LNK module accepts ONE request at a time. All calls are serialized
// through a module-level promise chain (mutex) so we never issue concurrent requests
// — concurrency makes the box drop/garble responses. (Commands also conflict with the
// Rain Bird mobile app being open; that surfaces as an upstream error — we report it.)

import http from "node:http";
import https from "node:https";
import { encrypt, decrypt } from "./encryption";

const STICK_PATH = "/stick";

/** Headers cloned from pyrainbird's `async_client` HEAD. Accept-Encoding is forced to
 *  identity so we never have to inflate a gzipped body before decrypting. */
const HEADERS: Record<string, string> = {
  "Accept-Language": "en",
  "Accept-Encoding": "identity",
  "User-Agent": "RainBird/2.0 CFNetwork/811.5.4 Darwin/16.7.0",
  Accept: "*/*",
  "Content-Type": "application/octet-stream",
};

interface JsonRpcResult {
  /** Hex SIP response payload. */
  data: string;
  length?: number;
}

interface JsonRpcEnvelope {
  jsonrpc?: string;
  id?: number | string;
  result?: JsonRpcResult;
  error?: { code?: number; message?: string };
}

// ---- One-request-at-a-time serialization -----------------------------------
let chain: Promise<unknown> = Promise.resolve();

/** Run `fn` after every previously-queued LNK request settles (success OR failure). */
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  // Keep the chain alive regardless of this call's outcome.
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

let requestId = 0;

interface HttpResult {
  status: number;
  body: Buffer;
}

/** A connection-level failure (vs an HTTP status) — the trigger to try the other scheme. */
function isConnError(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  return (
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "EHOSTUNREACH" ||
    code === "ENETUNREACH" ||
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    (e as Error)?.message === "timeout"
  );
}

/** One POST to `/stick` over the given scheme/port. Resolves with the HTTP status and
 *  raw body for ANY response; rejects only on a connection-level error/timeout. */
function requestOnce(
  scheme: "http" | "https",
  hostname: string,
  port: number,
  encrypted: Buffer,
  timeoutMs: number,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const mod = scheme === "https" ? https : http;
    const req = mod.request(
      {
        host: hostname,
        port,
        path: STICK_PATH,
        method: "POST",
        headers: { ...HEADERS, "Content-Length": String(encrypted.length) },
        timeout: timeoutMs,
        // The LNKSS presents a self-signed cert — trust it (LAN-local device).
        ...(scheme === "https" ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.write(encrypted);
    req.end();
  });
}

/** POST to the controller, preferring HTTPS:443 (LNKSS) and falling back to HTTP:80
 *  (classic LNK) on a connection error. Honors an explicit `host:port`. */
async function postStick(
  host: string,
  encrypted: Buffer,
  timeoutMs: number,
): Promise<HttpResult> {
  const m = /^(.+):(\d+)$/.exec(host);
  const hostname = m ? m[1] : host;
  const explicitPort = m ? Number(m[2]) : null;
  const attempts: Array<{ scheme: "http" | "https"; port: number }> =
    explicitPort != null
      ? [
          { scheme: "https", port: explicitPort },
          { scheme: "http", port: explicitPort },
        ]
      : [
          { scheme: "https", port: 443 },
          { scheme: "http", port: 80 },
        ];
  let lastErr: unknown;
  for (const a of attempts) {
    try {
      return await requestOnce(a.scheme, hostname, a.port, encrypted, timeoutMs);
    } catch (e) {
      lastErr = e;
      // Only fall back on a connection-level miss; a real HTTP error is the answer.
      if (!isConnError(e)) throw e;
    }
  }
  throw lastErr;
}

/**
 * Send ONE SIP command (hex string) to the LNK module and return the decoded hex
 * response payload. Serialized against all other in-flight LNK calls.
 *
 * @param host     LNK module IP/host (no scheme; optional :port).
 * @param password controller password (AES key material).
 * @param sipHex   the hex SIP command from sip.encode().
 * @param timeoutMs request timeout (default 8s).
 */
export function tunnelSip(
  host: string,
  password: string,
  sipHex: string,
  timeoutMs = 8000,
): Promise<string> {
  return serialize(async () => {
    const id = ++requestId;
    const body = JSON.stringify({
      id,
      jsonrpc: "2.0",
      method: "tunnelSip",
      params: { data: sipHex, length: Math.ceil(sipHex.length / 2) },
    });
    const encrypted = encrypt(body, password);

    const { status, body: raw } = await postStick(host, encrypted, timeoutMs);
    if (status !== 200) {
      // Surface short text bodies (e.g. "Invalid Password") so the cause is clear.
      const text = raw.toString("utf8").trim();
      const hint = text && text.length <= 48 ? `: ${text}` : "";
      throw new Error(`Rain Bird LNK HTTP ${status}${hint}`);
    }

    const json = decrypt(raw, password);
    let env: JsonRpcEnvelope;
    try {
      env = JSON.parse(json) as JsonRpcEnvelope;
    } catch {
      throw new Error(
        "Rain Bird LNK: malformed response (decrypt/parse failed — wrong password?)",
      );
    }
    if (env.error) {
      const code = env.error.code;
      const msg = env.error.message || "controller error";
      throw new Error(
        `Rain Bird LNK error${code != null ? ` ${code}` : ""}: ${msg}`,
      );
    }
    const data = env.result?.data;
    if (typeof data !== "string")
      throw new Error("Rain Bird LNK: response missing result.data");
    return data.toUpperCase();
  });
}
