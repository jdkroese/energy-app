// Anthropic Message Batches API connector (docs/46 §2c) — a plain fetch, same idiom as
// connectors/claude.ts (no SDK dependency). Used ONLY by the bulk recipe-library generator
// (kitchen/library-generate.ts): each batch request asks for 5 recipes as strict JSON.
// Batches run async (minutes to ~24h) — createBatch() returns immediately with an id; the
// generator polls getBatchStatus() on a timer and, once `ended`, calls getBatchResults() to
// stream the JSONL results. 50% cheaper than synchronous /v1/messages (docs/46), which is
// why the bulk pipeline uses this instead of connectors/claude.ts's complete()/completeJSON().
//
// NEVER exercised in tests — every unit test in kitchen/library-generate.test.ts feeds
// fixture batch results straight into the pure parse/validate/dedupe functions; nothing here
// makes a real network call outside a live deployment with a configured key.

import { getApiKey, API_VERSION, MODEL } from './claude';

const BATCHES_URL = 'https://api.anthropic.com/v1/messages/batches';
const TIMEOUT_MS = 20_000;

export interface BatchMessageParams {
  custom_id: string;
  system?: string;
  prompt: string;
  maxTokens: number;
}

export interface BatchInfo {
  id: string;
  processingStatus: 'in_progress' | 'canceling' | 'ended';
  requestCounts: { processing: number; succeeded: number; errored: number; canceled: number; expired: number };
  resultsAvailable: boolean;
}

export interface BatchResultSucceeded {
  customId: string;
  outcome: 'succeeded';
  text: string;
  inputTokens: number;
  outputTokens: number;
}
export interface BatchResultFailed {
  customId: string;
  outcome: 'errored' | 'canceled' | 'expired';
  detail: string;
}
export type BatchResult = BatchResultSucceeded | BatchResultFailed;

function headers(key: string): Record<string, string> {
  return { 'x-api-key': key, 'anthropic-version': API_VERSION, 'content-type': 'application/json' };
}

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await fn(ctl.signal);
  } finally {
    clearTimeout(t);
  }
}

/** Submit a batch of requests. Returns the new batch id, or null on any failure (no key,
 *  HTTP error, timeout) — callers (library-generate.ts) treat null as "try again later". */
export async function createBatch(requests: BatchMessageParams[]): Promise<string | null> {
  const key = getApiKey();
  if (!key || !requests.length) return null;
  try {
    return await withTimeout(async (signal) => {
      const res = await fetch(BATCHES_URL, {
        method: 'POST',
        signal,
        headers: headers(key),
        body: JSON.stringify({
          requests: requests.map((r) => ({
            custom_id: r.custom_id,
            params: {
              model: MODEL,
              max_tokens: r.maxTokens,
              thinking: { type: 'disabled' },
              ...(r.system ? { system: r.system } : {}),
              messages: [{ role: 'user', content: r.prompt }],
            },
          })),
        }),
      });
      if (!res.ok) {
        console.error('[claude-batch] createBatch HTTP error:', res.status, (await res.text()).slice(0, 300));
        return null;
      }
      const json = (await res.json()) as { id?: string };
      return json.id ?? null;
    });
  } catch (e) {
    console.error('[claude-batch] createBatch failed:', (e as Error).message);
    return null;
  }
}

/** Poll a batch's status. Returns null on any failure (caller retries next tick). */
export async function getBatchStatus(id: string): Promise<BatchInfo | null> {
  const key = getApiKey();
  if (!key) return null;
  try {
    return await withTimeout(async (signal) => {
      const res = await fetch(`${BATCHES_URL}/${encodeURIComponent(id)}`, { signal, headers: headers(key) });
      if (!res.ok) {
        console.error('[claude-batch] getBatchStatus HTTP error:', res.status, (await res.text()).slice(0, 300));
        return null;
      }
      const json = (await res.json()) as {
        id: string;
        processing_status?: string;
        request_counts?: { processing?: number; succeeded?: number; errored?: number; canceled?: number; expired?: number };
        results_url?: string | null;
      };
      const c = json.request_counts ?? {};
      return {
        id: json.id,
        processingStatus: json.processing_status === 'ended' ? 'ended' : json.processing_status === 'canceling' ? 'canceling' : 'in_progress',
        requestCounts: {
          processing: c.processing ?? 0,
          succeeded: c.succeeded ?? 0,
          errored: c.errored ?? 0,
          canceled: c.canceled ?? 0,
          expired: c.expired ?? 0,
        },
        resultsAvailable: Boolean(json.results_url),
      };
    });
  } catch (e) {
    console.error('[claude-batch] getBatchStatus failed:', (e as Error).message);
    return null;
  }
}

/** Fetch + parse the JSONL results of an ended batch. Returns null on any failure. */
export async function getBatchResults(id: string): Promise<BatchResult[] | null> {
  const key = getApiKey();
  if (!key) return null;
  try {
    return await withTimeout(async (signal) => {
      const res = await fetch(`${BATCHES_URL}/${encodeURIComponent(id)}/results`, { signal, headers: headers(key) });
      if (!res.ok) {
        console.error('[claude-batch] getBatchResults HTTP error:', res.status, (await res.text()).slice(0, 300));
        return null;
      }
      const text = await res.text();
      return parseBatchResultsJsonl(text);
    });
  } catch (e) {
    console.error('[claude-batch] getBatchResults failed:', (e as Error).message);
    return null;
  }
}

/** Pure JSONL parser — exported for unit tests (no network). Tolerant of blank lines and
 *  the two result shapes (succeeded vs errored/canceled/expired) the Batches API returns. */
export function parseBatchResultsJsonl(text: string): BatchResult[] {
  const out: BatchResult[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed) as {
        custom_id?: string;
        result?: {
          type?: string;
          message?: { content?: Array<{ type: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
          error?: { message?: string };
        };
      };
      const customId = row.custom_id ?? '';
      const result = row.result;
      if (result?.type === 'succeeded' && result.message) {
        const text2 = (result.message.content ?? [])
          .filter((b) => b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text)
          .join('');
        out.push({
          customId,
          outcome: 'succeeded',
          text: text2,
          inputTokens: result.message.usage?.input_tokens ?? 0,
          outputTokens: result.message.usage?.output_tokens ?? 0,
        });
      } else {
        out.push({
          customId,
          outcome: result?.type === 'canceled' || result?.type === 'expired' ? result.type : 'errored',
          detail: result?.error?.message ?? result?.type ?? 'unknown batch result',
        });
      }
    } catch {
      // A malformed JSONL line can never take down the poller — skip it.
      continue;
    }
  }
  return out;
}

/** Cancel an in-progress batch (best-effort — a batch already ending may finish anyway). */
export async function cancelBatch(id: string): Promise<boolean> {
  const key = getApiKey();
  if (!key) return false;
  try {
    return await withTimeout(async (signal) => {
      const res = await fetch(`${BATCHES_URL}/${encodeURIComponent(id)}/cancel`, { method: 'POST', signal, headers: headers(key) });
      return res.ok;
    });
  } catch {
    return false;
  }
}
