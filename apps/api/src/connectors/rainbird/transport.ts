// Rain Bird LNK / LNK2 HTTP transport — ports pyrainbird/async_client.py. Each call
// POSTs an AES-encrypted JSON-RPC 2.0 body to `http://<host>/stick` with an
// `application/octet-stream` content type; the encrypted response is decrypted and
// the inner `result` returned.
//
// CRITICAL: the LNK module accepts ONE request at a time. All calls are serialized
// through a module-level promise chain (mutex) so we never issue concurrent fetches
// — concurrency makes the box drop/garble responses. (Commands also conflict with
// the Rain Bird mobile app being open; that surfaces as an upstream error, which is
// acceptable — we just report it.)

import { encrypt, decrypt } from "./encryption";

const STICK_PATH = "/stick";

/** Headers cloned from pyrainbird's `async_client` HEAD. */
const HEADERS: Record<string, string> = {
  "Accept-Language": "en",
  "Accept-Encoding": "gzip, deflate",
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

/**
 * Send ONE SIP command (hex string) to the LNK module and return the decoded hex
 * response payload. Serialized against all other in-flight LNK calls.
 *
 * @param host     LNK module IP/host (no scheme).
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

    const res = await fetch(`http://${host}${STICK_PATH}`, {
      method: "POST",
      headers: HEADERS,
      body: encrypted,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`Rain Bird LNK HTTP ${res.status}`);

    const raw = Buffer.from(await res.arrayBuffer());
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
