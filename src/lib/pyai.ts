/**
 * PyAI client for OpenGranola.
 *
 * Surfaces used:
 *   Hear stream  — wss /v1/audio/transcriptions/stream  (live transcript)
 *   Hear jobs    — POST /v1/transcription/jobs          (diarized speakers)
 *   Recap        — POST /v1/recap/calls/{id}            (structured extraction)
 *
 * Field names here were verified against the live API on 2026-08-13, not just
 * read from the docs. Where the two disagree the live behaviour wins; those
 * spots are marked UNDOCUMENTED and must be treated as optional.
 */

const BASE = process.env.PYAI_BASE_URL ?? "https://api.pyai.com/v1";
const WS_BASE = BASE.replace(/^http/, "ws");

export type Utterance = {
  /** Recap only accepts these two roles. Real names live in `speaker`. */
  speaker_role: "agent" | "customer";
  /** Our own label, carried locally. Recap never sees it. */
  speaker?: string;
  text: string;
  offset_s: number;
  duration_s: number;
  /** STT confidence 0..1 where the engine reports it. Absent = not reported. */
  confidence?: number | null;
};

export type StreamFrame =
  | { type: "config_ack"; endpointing_ms: number; warnings: unknown[]; session_id?: string }
  | { type: "partial"; text: string; stable_text: string; active_text: string; utterance_id: string; t_ms: number }
  | { type: "partial_stable"; text: string; utterance_id: string; t_ms: number }
  | { type: "speech_final"; text: string; utterance_id: string; t_ms: number; audio_ms: number; endpoint_reason: string }
  | { type: "final"; text: string; utterance_id: string; t_ms: number; audio_ms: number; endpoint_reason: string }
  | { type: "usage"; product: string; meter: string; audio_seconds: number; minutes: number }
  | { type: "error"; code: string; message: string };

export function streamUrl(opts: { sampleRate?: number; endpointingMs?: number } = {}) {
  const q = new URLSearchParams({
    protocol: "pyai-hear-v1", // without this you get legacy transcript.* frames
    model: "pyai-hear",
    language: "en",
    sample_rate: String(opts.sampleRate ?? 16000),
    encoding: "pcm16",
    interim_results: "true",
    endpointing_ms: String(opts.endpointingMs ?? 800),
  });
  return `${WS_BASE}/audio/transcriptions/stream?${q}`;
}


function headers(apiKey: string) {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

export class PyAIError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
  /** 402 and 4xx never succeed on retry; 429 does once the window moves. */
  get retryable() {
    return this.status === 429;
  }
}

async function call<T>(apiKey: string, path: string, init: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: headers(apiKey) });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as Record<string, unknown>);
    // Data plane returns {error:{code}}, control plane returns RFC 7807 {type:".../code}.
    const code =
      (body as any)?.error?.code ??
      String((body as any)?.type ?? "").split("/").pop() ??
      "unknown";
    const message = (body as any)?.error?.message ?? (body as any)?.detail ?? res.statusText;
    throw new PyAIError(res.status, code, message);
  }
  return res.json() as Promise<T>;
}

export type RecapRecord = {
  tldr?: string;
  summary?: string;
  summary_draft?: string;
  key_decisions?: string[];
  action_items?: { task: string; owner: string | null; due: string | null }[];
  next_steps?: string;
  /** The only field carrying a timeline anchor back into the audio. */
  moments?: { category: string; offset_s: number; description: string }[];
  risk_signals?: { quote: string; category: string; severity: string }[];
  objections?: { text: string; note?: string }[];
  coverage_gaps?: { fact: string; type: string; transcript_quote: string }[];
  analytics?: { talk_ratio?: number; filler_rate?: number; question_count?: number };
  sentiment_phases?: { phase: string; note: string }[];
  buying_signals?: { quote: string; category: string }[];
  competitor_mentions?: unknown[];
  extracted_fields?: Record<string, unknown>;
};

export type RecapCall = {
  object: "recap.call";
  call_id: string;
  status: "pending" | "processing" | "complete" | "failed";
  /** UNDOCUMENTED but always present live. */
  headline?: string;
  record?: RecapRecord;
  transcript?: { format: string; utterances: Utterance[] };
  error?: string | null;
};


export async function triggerRecap(
  apiKey: string,
  callId: string,
  utterances: Utterance[],
  durationS: number,
) {
  // Strip our local `speaker` label — Recap rejects unknown utterance fields silently
  // and we don't want to depend on that.
  const wire = utterances.map(({ speaker_role, text, offset_s, duration_s }) => ({
    speaker_role,
    text,
    offset_s,
    duration_s,
  }));
  return call<RecapCall>(apiKey, `/recap/calls/${encodeURIComponent(callId)}`, {
    method: "POST",
    body: JSON.stringify({ call_duration_s: durationS, utterances: wire }),
  });
}

export async function getRecap(apiKey: string, callId: string) {
  return call<RecapCall>(apiKey, `/recap/calls/${encodeURIComponent(callId)}`, { method: "GET" });
}

/** Recap completes in ~2s, but poll rather than assume. */
export async function awaitRecap(apiKey: string, callId: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let waitMs = 500;
  while (Date.now() < deadline) {
    const r = await getRecap(apiKey, callId);
    if (r.status === "complete" || r.status === "failed") return r;
    await new Promise((res) => setTimeout(res, waitMs));
    waitMs = Math.min(waitMs * 1.5, 4000);
  }
  throw new PyAIError(408, "recap_timeout", `Recap for ${callId} did not finish in ${timeoutMs}ms`);
}
