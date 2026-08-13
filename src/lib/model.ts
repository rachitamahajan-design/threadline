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

export type Provider = "pyai" | "openai" | "mock";

export type ModelCall = {
  /** What this call is for — shows up in logs and on the output card. */
  purpose: string;
  system: string;
  user: string;
  /** Extraction runs at 0; composition a hair above. Never high. */
  temperature?: number;
  maxTokens?: number;
};

export type ModelUsage = { provider: Provider; model: string; ms: number; purpose: string };

export class ModelError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
  /** Rate limits and gateway hiccups pass; 4xx bodies never succeed on retry. */
  get retryable() {
    return this.status === 429 || this.status >= 500 || this.status === 0;
  }
}

const DEFAULT_TIMEOUT_MS = Number(process.env.MODEL_TIMEOUT_MS ?? 60_000);
const DEFAULT_TEMPERATURE = 0;

/**
 * Provider resolution: explicit env wins, else whichever key exists. PyAI is the
 * product's model host; OpenAI stays reachable because the fallback path in
 * lib/openai.ts already depends on it.
 */
export function provider(): Provider {
  const forced = (process.env.MODEL_PROVIDER ?? "").toLowerCase();
  if (forced === "pyai" || forced === "openai" || forced === "mock") return forced;
  if (mock) return "mock";
  if (process.env.OPENAI_API_KEY) return "openai";
  return "pyai";
}

export function modelName(p: Provider = provider()): string {
  if (p === "mock") return "mock";
  return p === "pyai"
    ? process.env.PYAI_CHAT_MODEL ?? "pyai-think"
    : process.env.SUMMARIZER_MODEL ?? "gpt-4o-mini";
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
export function recentUsage(): ModelUsage[] {
  return [...usageLog];
}

/**
 * One JSON-mode chat call. Returns parsed JSON; callers own the schema and are
 * expected to validate it (see lib/grounding.ts). Throws ModelError on
 * transport failure and Error on unparseable output.
 */
export async function chatJson(call: ModelCall): Promise<unknown> {
  const p = provider();
  const started = Date.now();
  const temperature = call.temperature ?? DEFAULT_TEMPERATURE;
  let raw: unknown;
  if (p === "mock") {
    if (!mock) throw new ModelError(0, "MODEL_PROVIDER=mock but no mock model is installed");
    raw = await mock(call);
  } else {
    raw = parseJsonLoose(await post(p, call, temperature));
  }
  const usage: ModelUsage = { provider: p, model: modelName(p), ms: Date.now() - started, purpose: call.purpose };
  usageLog.push(usage);
  if (usageLog.length > 200) usageLog.shift();
  if (process.env.LOG_MODEL === "1")
    console.log(`[model] ${usage.purpose} → ${usage.provider}/${usage.model} ${usage.ms}ms temp=${temperature}`);
  return raw;
}

/** The single outbound request. Both providers speak the OpenAI chat shape. */
async function post(p: Exclude<Provider, "mock">, call: ModelCall, temperature: number): Promise<string> {
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
        model: modelName(p),
        temperature,
        ...(call.maxTokens ? { max_tokens: call.maxTokens } : {}),
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: call.system },
          { role: "user", content: call.user },
        ],
      }),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      throw new ModelError(res.status, `${p} chat failed: HTTP ${res.status} ${body}`);
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new ModelError(res.status, `${p} returned no message content`);
    return content;
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
