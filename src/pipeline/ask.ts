/**
 * Ask the brain a question across every meeting.
 *
 * retrieve ──▶ synthesize (LLM, optional) ──▶ gates ──▶ answer with receipts
 *
 * The model has NO prose channel: it returns {points:[{text, chunk_id, quote}]}
 * and we assemble the visible answer from the points that survive the gates.
 * A sentence that cannot cite a retrieved chunk, quote it, and avoid inventing
 * new facts is dropped and recorded — same discipline as extraction claims.
 *
 * Without OPENAI_API_KEY the answer is extractive (top chunks verbatim), which
 * trivially passes every gate and keeps the whole feature fully local.
 */
import type { DatabaseSync } from "node:sqlite";
import { Budget, retry, groundedIn, applyGate, allOf, decideExit, normalize, type Gate, type StepRecord } from "../lib/harness.js";
import { because, CodedError } from "../lib/reasons.js";
import { chatJson } from "../lib/model.js";
import { hasOpenAI } from "../lib/openai.js";
import { retrieve, type Snippet } from "./retrieve.js";

export type AskPoint = { text: string; chunk_id: number; quote: string; meeting_id: string; meeting_title: string; offset_s: number };
export type AskResult = {
  question: string;
  mode: "synthesized" | "extractive";
  /** One direct answer in plain language. Empty in extractive mode. */
  summary: string;
  answer: AskPoint[];
  blocked: { text: string; reason: string }[];
  receipts: Snippet[];
  exit: string;
  steps: StepRecord[];
};

export type RawPoint = { text?: string; chunk_id?: number; quote?: string };

export function gates(snippets: Snippet[]): Gate<RawPoint> {
  const byId = new Map(snippets.map((s) => [s.chunk_id, s]));
  const corpus = normalize(snippets.map((s) => s.text).join(" "));

  const citesRetrieved: Gate<RawPoint> = (p) =>
    p.chunk_id != null && byId.has(p.chunk_id) ? null : `cites chunk ${p.chunk_id} which was not retrieved`;

  // Scoped to the SINGLE cited chunk, not the union — a quote that exists in
  // meeting A but is credited to meeting B is the signature failure mode of
  // cross-meeting synthesis, and per-chunk scoping closes it.
  const groundedInCited: Gate<RawPoint> = (p) => {
    const s = byId.get(p.chunk_id!)!;
    return groundedIn([{ text: s.text, offset_s: s.offset_s }])({ quote: p.quote });
  };

  // Synthesis composes free sentences, so it can attach a fabricated number or
  // name to a real quote. Every proper noun / numeric token must appear
  // somewhere in the retrieved corpus.
  const noNewFacts: Gate<RawPoint> = (p) => {
    const tokens = (p.text ?? "").match(/\b[A-Z][a-z]{2,}\b|\b\d[\d.,%$/-]*\b/g) ?? [];
    for (const t of tokens) {
      const n = normalize(t);
      if (n && !corpus.includes(n)) return `asserts "${t}" which appears in no retrieved snippet`;
    }
    return null;
  };

  return allOf(citesRetrieved, groundedInCited, noNewFacts);
}

async function synthesize(
  question: string,
  snippets: Snippet[],
  lastError: string | null,
): Promise<{ summary: string; points: RawPoint[] }> {
  const context = snippets
    .map((s) => `[#${s.chunk_id}] (meeting "${s.meeting_title}", ${Math.round(s.offset_s)}s) ${s.text}`)
    .join("\n\n");
  const parsed = (await chatJson({
    purpose: "ask.synthesize",
    system:
      'Answer the question using ONLY the numbered snippets. Reply with JSON {"summary": string, "points":[{"text": string, "chunk_id": number, "quote": string}]}. ' +
      "summary: a direct 1-3 sentence answer to the question, written in your own plain third-person words — do NOT copy transcript sentences or speak in first person. " +
      "points: the evidence behind the summary; each cites its snippet number as chunk_id and copies a short VERBATIM quote from that snippet as quote, with text being a one-line paraphrase of what that quote establishes. " +
      "Do not introduce names or numbers that are not in the snippets." +
      (lastError ? ` Your previous answer was rejected: ${lastError}. Every point must quote its cited snippet verbatim.` : ""),
    user: `Question: ${question}\n\nSnippets:\n${context}`,
  })) as { summary?: string; points?: RawPoint[] };
  return { summary: parsed.summary ?? "", points: parsed.points ?? [] };
}

export async function ask(db: DatabaseSync, question: string, opts: { budget?: Budget } = {}): Promise<AskResult> {
  const budget = opts.budget ?? Budget.for("ask");
  const steps: StepRecord[] = [];
  const t0 = Date.now();

  const receipts = retrieve(db, question);
  steps.push({ name: "retrieve", status: receipts.length ? "ok" : "failed", attempts: 1, ms: Date.now() - t0,
    reason: receipts.length ? undefined : because("no-retrieval", "nothing matched") });
  if (!receipts.length)
    return { question, mode: "extractive", summary: "", answer: [], blocked: [], receipts, exit: "failed", steps };

  const gate = gates(receipts);

  // The summary is free prose, so it gets the no-new-facts check against the
  // whole retrieved corpus: every proper noun / number it asserts must appear
  // in some retrieved snippet, or the summary is dropped and only receipted
  // points render.
  const corpus = normalize(receipts.map((s) => s.text).join(" "));
  const summaryOk = (s: string): string | null => {
    if (!s.trim()) return "empty summary";
    const tokens = s.match(/\b[A-Z][a-z]{2,}\b|\b\d[\d.,%$/-]*\b/g) ?? [];
    for (const t of tokens) {
      const n = normalize(t);
      if (n && !corpus.includes(n)) return `summary asserts "${t}" which appears in no retrieved snippet`;
    }
    return null;
  };

  const finish = (summary: string, kept: RawPoint[], blocked: { item: RawPoint; reason: string }[], mode: AskResult["mode"]): AskResult => {
    const byId = new Map(receipts.map((s) => [s.chunk_id, s]));
    const answer = kept.map((p) => {
      const s = byId.get(p.chunk_id!)!;
      return { text: p.text ?? "", chunk_id: p.chunk_id!, quote: p.quote ?? "",
        meeting_id: s.meeting_id, meeting_title: s.meeting_title, offset_s: s.offset_s };
    });
    if (blocked.length)
      steps.push({ name: "gate:synthesis", status: "blocked", attempts: 1, ms: 0,
        reason: because("grounding-blocked", `${blocked.length} point(s) had no receipt in the retrieved snippets`) });
    return { question, mode, summary, answer, blocked: blocked.map((b) => ({ text: b.item.text ?? "", reason: b.reason })),
      receipts, exit: decideExit(steps, budget), steps };
  };

  if (!hasOpenAI() || process.env.THREADLINE_SYNTHESIS === "off") {
    // Extractive: top snippets ARE the answer, so the gates pass by construction.
    const points: RawPoint[] = receipts.slice(0, 3).map((s) => ({ text: s.text, chunk_id: s.chunk_id, quote: s.text.slice(0, 80) }));
    steps.push({ name: "synthesize", status: "skipped", attempts: 0, ms: 0, reason: because("skipped-local-only", "local-only — extractive answer") });
    const { kept, blocked } = applyGate(points, gate);
    return finish("", kept, blocked, "extractive");
  }

  // The aimed retry: a fully-gated answer throws, so attempt 2 sees WHY.
  let summary = "", kept: RawPoint[] = [], blocked: { item: RawPoint; reason: string }[] = [];
  const run = await retry("synthesize", budget, async (_attempt, lastError) => {
    budget.spendUnits(1);
    const out = await synthesize(question, receipts, lastError);
    const res = applyGate(out.points, gate);
    if (!res.kept.length && res.blocked.length)
      throw new CodedError("grounding-blocked", res.blocked.map((b) => b.reason).slice(0, 2).join("; "));
    return { ...res, summary: out.summary };
  }, { max: 2 });
  steps.push(run.record);

  if (run.value) ({ kept, blocked, summary } = run.value);
  const sumReason = summaryOk(summary);
  if (sumReason) {
    // Ungrounded summary never renders; the receipted points still can.
    if (summary.trim())
      steps.push({ name: "gate:summary", status: "blocked", attempts: 1, ms: 0, reason: because("grounding-blocked", sumReason) });
    summary = "";
  }
  if (!kept.length) {
    // Never show an ungrounded sentence — fall back to extractive.
    const points: RawPoint[] = receipts.slice(0, 3).map((s) => ({ text: s.text, chunk_id: s.chunk_id, quote: s.text.slice(0, 80) }));
    const res = applyGate(points, gate);
    return finish("", res.kept, blocked.length ? blocked : res.blocked, "extractive");
  }
  return finish(summary, kept, blocked, "synthesized");
}
