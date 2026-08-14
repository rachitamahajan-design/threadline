/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  THE NETWORK BOUNDARY.                                                   │
 * │                                                                          │
 * │  This file contains the only `fetch` that meeting content passes through. │
 * │  Transcripts, notes, entities and embeddings never leave the laptop by    │
 * │  any other path. If you are about to add a second outbound call for       │
 * │  meeting text, add it here or not at all.                                │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * The model is assumed pluggable and NOT frontier-grade: one adapter, one place
 * to set temperature/timeout/retry, one place to swap providers. Everything that
 * makes the output trustworthy lives in lib/grounding.ts instead.
 */

import { chatModel, costOf } from "./config.js";
import { log } from "./log.js";

export type Provider = "pyai" | "openai" | "mock";

export type ModelCall = {
  /** What this call is for — shows up in logs and on the output card. */
  purpose: string;
  system: string;
  user: string;
  /** Prior conversation turns, inserted between system and user verbatim. */
  history?: { role: "user" | "assistant"; content: string }[];
  /** Extraction runs at 0; composition a hair above. Never high. */
  temperature?: number;
  maxTokens?: number;
  /** "json" (default) forces json_object mode and parses; "text" returns prose. */
  format?: "json" | "text";
};

export type ModelUsage = {
  provider: Provider;
  model: string;
  ms: number;
  purpose: string;
  /** Token counts as the provider reported them; 0 when not reported (mock). */
  tokensIn: number;
  tokensOut: number;
  /** USD, from the pricing table in agents.json. 0 for unpriced models. */
  costUsd: number;
};

export class ModelError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
  /** Rate limits and gateway hiccups pass; 4xx bodies never succeed on retry. */
  get retryable() {
    return this.status === 429 || this.status >= 500 || this.status === 0;
  }
}

// 60s proved too tight in practice: statements.extract on an 11-minute
// transcript takes ~64s on gpt-4o-mini, so every notes run died at the wire.
const DEFAULT_TIMEOUT_MS = Number(process.env.MODEL_TIMEOUT_MS ?? 240_000);
const DEFAULT_TEMPERATURE = 0;

/**
 * Provider resolution: explicit env wins, then the provider agents.json prefers
 * (when its key is actually configured), else whichever key exists. Text chat
 * prefers OpenAI: PyAI hosts speech only (hear/speak/omni/amd — verified live
 * 2026-08-14, /v1/chat/completions 404s), so routing chat there just buys a
 * failed round-trip per call. The failover keeps either direction safe.
 */
export function provider(): Provider {
  const forced = (process.env.MODEL_PROVIDER ?? "").toLowerCase();
  if (forced === "pyai" || forced === "openai" || forced === "mock") return forced;
  if (mock) return "mock";
  const preferred = chatModel().provider;
  if (preferred === "pyai" && process.env.PYAI_API_KEY) return "pyai";
  if (preferred === "openai" && process.env.OPENAI_API_KEY) return "openai";
  if (process.env.OPENAI_API_KEY) return "openai";
  return "pyai";
}

/**
 * Which model answers: env override > per-purpose config > per-provider config
 * > code default. Swapping the model is an edit to agents.json's models.chat.
 */
export function modelName(p: Provider = provider(), purpose?: string): string {
  if (p === "mock") return "mock";
  const env = p === "pyai" ? process.env.PYAI_CHAT_MODEL : process.env.SUMMARIZER_MODEL;
  if (env) return env;
  const cfg = chatModel();
  if (purpose && cfg.purposes?.[purpose]?.model) return cfg.purposes[purpose].model!;
  return cfg.model?.[p] ?? (p === "pyai" ? "pyai-think" : "gpt-4o-mini");
}

/** Is a model reachable at all? The UI greys out generation instead of erroring. */
export function modelConfigured(): boolean {
  const p = provider();
  if (p === "mock") return true;
  return p === "pyai" ? !!process.env.PYAI_API_KEY : !!process.env.OPENAI_API_KEY;
}

export function modelInfo() {
  const p = provider();
  return { provider: p, model: modelName(p), configured: modelConfigured() };
}

// ── Test/offline seam ───────────────────────────────────────────────────────
// Tests and `npm run eval-notes` must run with no network and no key. A mock is
// a function, so a fixture can answer differently per purpose.

type MockFn = (call: ModelCall) => unknown | Promise<unknown>;
let mock: MockFn | null = null;

export function setMockModel(fn: MockFn | null) {
  mock = fn;
}

// ── The call ────────────────────────────────────────────────────────────────

const usageLog: ModelUsage[] = [];
/** Total calls ever logged (survives the ring-buffer trim). */
let usageTotal = 0;
export function recentUsage(): ModelUsage[] {
  return [...usageLog];
}

/**
 * The token meter the run logger reads: `usageCursor()` at run start, then
 * `usageSince(cursor)` at run end sums what the run's calls actually cost.
 */
export function usageCursor(): number {
  return usageTotal;
}

export function usageSince(cursor: number): { tokensIn: number; tokensOut: number; costUsd: number } {
  // Entries older than the ring buffer are gone; a run that overflows 200 calls
  // undercounts rather than crashes.
  const fresh = Math.min(usageTotal - cursor, usageLog.length);
  const window = fresh > 0 ? usageLog.slice(-fresh) : [];
  return {
    tokensIn: window.reduce((n, u) => n + u.tokensIn, 0),
    tokensOut: window.reduce((n, u) => n + u.tokensOut, 0),
    costUsd: window.reduce((n, u) => n + u.costUsd, 0),
  };
}

/**
 * One JSON-mode chat call. Returns parsed JSON; callers own the schema and are
 * expected to validate it (see lib/grounding.ts). Throws ModelError on
 * transport failure and Error on unparseable output.
 *
 * SILENT FAILOVER: if the preferred provider's host fails (404 on the route,
 * dead key, timeout, 5xx) and the other provider has a key, the call is retried
 * there before anyone is told anything. The user sees an answer; the usage log
 * and run record see which provider actually produced it. Both hosts failing is
 * the only thing that surfaces.
 */
export async function chatJson(call: ModelCall): Promise<unknown> {
  const p = provider();
  if (p === "mock") {
    if (!mock) throw new ModelError(0, "MODEL_PROVIDER=mock but no mock model is installed");
    const started = Date.now();
    const raw = await mock(call);
    logUsage({ provider: p, model: "mock", ms: Date.now() - started, purpose: call.purpose, tokensIn: 0, tokensOut: 0, costUsd: 0 });
    return raw;
  }
  try {
    return await chatVia(p, call);
  } catch (e) {
    const alt = altProvider(p);
    if (!alt || !(e instanceof ModelError)) throw e;
    log.warn("model.failover", { purpose: call.purpose, from: p, to: alt, status: e.status, detail: e.message.slice(0, 160) });
    try {
      return await chatVia(alt, call);
    } catch (e2) {
      // Surface the PRIMARY failure: "pyai chat failed: 404" hid a plain
      // openai timeout for hours. The alt error rides along for the log.
      if (e2 instanceof ModelError) throw new ModelError(e.status, `${e.message} (failover to ${alt} also failed: ${e2.message.slice(0, 120)})`);
      throw e2;
    }
  }
}

/** Plain-prose variant of chatJson — same boundary, failover and metering. */
export async function chatText(call: Omit<ModelCall, "format">): Promise<string> {
  const raw = await chatJson({ ...call, format: "text" });
  return typeof raw === "string" ? raw : JSON.stringify(raw);
}

/** The provider to fail over to: the other one, if its key is configured. */
function altProvider(p: Exclude<Provider, "mock">): Exclude<Provider, "mock"> | null {
  if (p === "pyai") return process.env.OPENAI_API_KEY ? "openai" : null;
  return process.env.PYAI_API_KEY ? "pyai" : null;
}

async function chatVia(p: Exclude<Provider, "mock">, call: ModelCall): Promise<unknown> {
  const started = Date.now();
  const temperature = call.temperature ?? chatModel().purposes?.[call.purpose]?.temperature ?? DEFAULT_TEMPERATURE;
  const res = await post(p, call, temperature);
  const raw = call.format === "text" ? res.content : parseJsonLoose(res.content);
  const model = modelName(p, call.purpose);
  logUsage({
    provider: p,
    model,
    ms: Date.now() - started,
    purpose: call.purpose,
    ...res.tokens,
    costUsd: costOf(model, res.tokens.tokensIn, res.tokens.tokensOut),
  });
  return raw;
}

function logUsage(usage: ModelUsage): void {
  usageLog.push(usage);
  usageTotal++;
  if (usageLog.length > 200) usageLog.shift();
  // Per-call detail is debug: on at LOG_LEVEL=debug, off in normal running,
  // where run.finish already carries the totals that matter.
  log.debug("model.call", {
    purpose: usage.purpose,
    provider: usage.provider,
    model: usage.model,
    ms: usage.ms,
    tokensIn: usage.tokensIn,
    tokensOut: usage.tokensOut,
  });
}

/** The single outbound request. Both providers speak the OpenAI chat shape. */
async function post(
  p: Exclude<Provider, "mock">,
  call: ModelCall,
  temperature: number,
): Promise<{ content: string; tokens: { tokensIn: number; tokensOut: number } }> {
  const base =
    p === "pyai"
      ? process.env.PYAI_BASE_URL ?? "https://api.pyai.com/v1"
      : "https://api.openai.com/v1";
  const key = p === "pyai" ? process.env.PYAI_API_KEY : process.env.OPENAI_API_KEY;
  if (!key) throw new ModelError(0, `${p.toUpperCase()}_API_KEY is not set — cannot reach the model`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: modelName(p, call.purpose),
        temperature,
        ...(call.maxTokens ? { max_tokens: call.maxTokens } : {}),
        ...(call.format === "text" ? {} : { response_format: { type: "json_object" } }),
        messages: [
          { role: "system", content: call.system },
          ...(call.history ?? []),
          { role: "user", content: call.user },
        ],
      }),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      throw new ModelError(res.status, `${p} chat failed: HTTP ${res.status} ${body}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new ModelError(res.status, `${p} returned no message content`);
    return {
      content,
      tokens: { tokensIn: data.usage?.prompt_tokens ?? 0, tokensOut: data.usage?.completion_tokens ?? 0 },
    };
  } catch (e) {
    if (e instanceof ModelError) throw e;
    if (e instanceof Error && e.name === "AbortError")
      throw new ModelError(0, `model call "${call.purpose}" timed out after ${DEFAULT_TIMEOUT_MS}ms`);
    throw new ModelError(0, e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Weak models wrap JSON in prose, fence it, or trail a comma. None of that is
 * worth a regeneration, so recover what we can before giving up.
 */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1].trim());
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      try {
        return JSON.parse(c.replace(/,\s*([}\]])/g, "$1"));
      } catch {
        /* next candidate */
      }
    }
  }
  throw new Error(`model did not return JSON: ${trimmed.slice(0, 160)}`);
}
