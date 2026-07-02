// Claude API helper (Kitchen Hub Intelligence, D2) — a plain fetch to the Anthropic
// Messages API; deliberately no SDK dependency (docs/39). The FIRST LLM use in this
// app, so it is fenced hard:
//  - Master switch + per-feature toggles live in state.json (kitchen.intelligence);
//    every caller must check isFeatureEnabled() and fail soft to the deterministic path.
//  - Key: env ANTHROPIC_API_KEY overrides the stored key.
//  - Usage: tokens are counted from the response and priced LOCALLY into a monthly
//    € counter shown in Settings ▸ Intelligence (household volume ≈ cents/month).
//  - Model pinned to claude-sonnet-5 (the brief's choice), small max_tokens.

import * as store from '../store';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
export const MODEL = 'claude-sonnet-5';
const TIMEOUT_MS = 30_000;

// Local pricing for the € counter — claude-sonnet-5 list price is $3/MTok in,
// $15/MTok out; priced here in EUR at a ~0.93 conversion. Close enough for a
// cents-per-month household counter (not a billing system).
const EUR_PER_MTOK_IN = 2.8;
const EUR_PER_MTOK_OUT = 14;

export type IntelligenceFeature = 'importParsing' | 'cookingSuggestions' | 'plannerRequestBox' | 'weeklyPlanAssist';

function apiKey(): string | null {
  return process.env.ANTHROPIC_API_KEY || store.get().kitchen.intelligence.apiKey || null;
}

/** Master switch + per-feature toggle + a usable key. Callers fail soft when false. */
export function isFeatureEnabled(feature: IntelligenceFeature): boolean {
  const cfg = store.get().kitchen.intelligence;
  return cfg.enabled && cfg.features[feature] && Boolean(apiKey());
}

export function isConfigured(): boolean {
  return Boolean(apiKey());
}

function recordUsage(inputTokens: number, outputTokens: number): void {
  const month = new Date().toISOString().slice(0, 7); // YYYY-MM
  store.update((s) => {
    const u = s.kitchen.intelligence.usage;
    if (u.month !== month) {
      u.month = month;
      u.inputTokens = 0;
      u.outputTokens = 0;
      u.eur = 0;
    }
    u.inputTokens += inputTokens;
    u.outputTokens += outputTokens;
    u.eur += (inputTokens / 1_000_000) * EUR_PER_MTOK_IN + (outputTokens / 1_000_000) * EUR_PER_MTOK_OUT;
  });
}

interface MessagesResponse {
  content?: Array<{ type: string; text?: string }>;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * One small extraction/completion call. Returns the response text, or null on ANY
 * failure (no key, HTTP error, refusal, timeout) — callers always have a
 * deterministic fallback, so this never throws.
 */
export async function complete(opts: {
  system?: string;
  prompt: string;
  maxTokens?: number;
}): Promise<string | null> {
  const key = apiKey();
  if (!key) return null;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        'x-api-key': key,
        'anthropic-version': API_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: opts.maxTokens ?? 2000,
        // Small structured-extraction calls don't benefit from thinking spend.
        thinking: { type: 'disabled' },
        ...(opts.system ? { system: opts.system } : {}),
        messages: [{ role: 'user', content: opts.prompt }],
      }),
    });
    if (!res.ok) {
      console.error('[claude] messages API error:', res.status, (await res.text()).slice(0, 300));
      return null;
    }
    const json = (await res.json()) as MessagesResponse;
    recordUsage(json.usage?.input_tokens ?? 0, json.usage?.output_tokens ?? 0);
    if (json.stop_reason === 'refusal') return null;
    const text = (json.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
    return text || null;
  } catch (e) {
    console.error('[claude] request failed:', (e as Error).message);
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** complete() + tolerant JSON extraction (strips ```json fences / leading prose). */
export async function completeJSON<T>(opts: { system?: string; prompt: string; maxTokens?: number }): Promise<T | null> {
  const text = await complete(opts);
  if (!text) return null;
  const cleaned = text.replace(/^[\s\S]*?(\{|\[)/, '$1').replace(/(\}|\])[^}\]]*$/, '$1');
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }
}
