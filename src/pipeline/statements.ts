/**
 * Pass 1 of two: extraction.
 *
 * The model returns atomic statements — anything substantive someone said,
 * from a hard number to a voiced concern to a joke worth remembering — each
 * tagged with the segment ids it came from and a kind. No prose, no synthesis,
 * temperature 0. Then we throw away every statement that cannot survive the
 * same deterministic checks the final output faces — because a poisoned
 * statement list makes a poisoned outline unavoidable, no matter how good the
 * compose prompt is.
 *
 * Statements are extracted once per meeting and reused by every handoff.
 */
import { ModelError, chatJson } from "../lib/model.js";
import { Budget, retry, type StepRecord } from "../lib/harness.js";
import { CodedError, because } from "../lib/reasons.js";
import { EXTRACT_STATEMENTS, promptRef } from "../lib/prompts.js";
import { checkQuotes, verbatimMisses, type GroundingContext } from "../lib/grounding.js";
import { citedText, renderSegments, type MeetingType, type Segment } from "../lib/segments.js";

export type StatementKind =
  | "decision"
  | "action"
  | "number"
  | "quote"
  | "question"
  | "opinion"
  | "aside"
  | "other";
const KINDS: StatementKind[] = ["decision", "action", "number", "quote", "question", "opinion", "aside", "other"];

export type Statement = {
  id: string; // "ST1" — debugging and eval only; sources are what count
  text: string;
  kind: StatementKind;
  source: string[];
  speaker?: string;
  heardPoorly?: boolean;
};

export type StatementSet = {
  statements: Statement[];
  /** Statements the sanitiser refused, with why. Shown in the debug drawer. */
  dropped: { text: string; reason: string }[];
  promptVersion: string;
};

/**
 * Pass 1, under the same harness as compose: silent, budgeted, aimed retries.
 * Without this a single transient 429 on extraction killed the whole run —
 * compose was protected and the pass feeding it was not.
 *
 * Retries are invisible by design. What the user eventually sees is the
 * outcome; what the run record keeps is the attempt count and the reason.
 */
export async function extractStatements(
  segments: Segment[],
  ctx: GroundingContext,
  opts: { type: MeetingType; participants: string[]; budget?: Budget },
): Promise<{ set: StatementSet; step: StepRecord }> {
  const budget = opts.budget ?? Budget.for("notes");
  const run = await retry(
    "extract:statements",
    budget,
    async () => {
      const raw = await chatJson({
        purpose: "statements.extract",
        temperature: 0,
        system: EXTRACT_STATEMENTS.build({
          transcript: renderSegments(segments),
          participants: opts.participants.join(", ") || "unknown",
          type: opts.type,
        }),
        // The transcript is in the system prompt; the user turn only has to trigger
        // the shape. Weak models do better with an explicit, boring instruction.
        user: 'Extract the statements now. Return {"statements": [...]} and nothing else.',
      });
      budget.spendUnits(1);
      return sanitizeStatements(raw, ctx);
    },
    // A 404 or a dead key never becomes valid on the third try.
    { retryable: (e) => !(e instanceof ModelError) || e.retryable },
  );
  if (!run.value) {
    const reason = run.record.reason ?? because("crash", "extraction produced nothing");
    throw new CodedError(reason.code, reason.detail);
  }
  return { set: run.value, step: run.record };
}

/**
 * Deterministic gate on the extraction pass. Keeps only statements that cite
 * real segments and whose figures and quotes actually appear in those segments.
 */
export function sanitizeStatements(raw: unknown, ctx: GroundingContext): StatementSet {
  const list = Array.isArray((raw as { statements?: unknown })?.statements)
    ? ((raw as { statements: unknown[] }).statements)
    : [];
  const statements: Statement[] = [];
  const dropped: { text: string; reason: string }[] = [];
  let n = 0;

  for (const item of list) {
    const f = item as Record<string, unknown>;
    const text = typeof f?.text === "string" ? f.text.trim() : "";
    if (!text) {
      dropped.push({ text: JSON.stringify(item).slice(0, 80), reason: "no text" });
      continue;
    }
    const source = Array.isArray(f.source) ? f.source.filter((s): s is string => typeof s === "string") : [];
    if (!source.length) {
      dropped.push({ text, reason: "no source segment ids" });
      continue;
    }
    const unknown = source.filter((id) => !ctx.index.has(id));
    if (unknown.length) {
      dropped.push({ text, reason: `cites segments that do not exist: ${unknown.join(", ")}` });
      continue;
    }
    const cited = citedText(ctx.index, source);
    const misses = verbatimMisses(text, cited);
    if (misses.length) {
      dropped.push({ text, reason: `figure/date not in cited text: ${misses.map((m) => m.raw).join(", ")}` });
      continue;
    }
    const badQuote = checkQuotes(text, source, "statement", ctx);
    if (badQuote.length) {
      dropped.push({ text, reason: "quoted span is not verbatim in one cited segment" });
      continue;
    }
    const kind = KINDS.includes(f.kind as StatementKind) ? (f.kind as StatementKind) : "other";
    // Speaker must be someone we heard, else it is an invented attribution.
    const claimed = typeof f.speaker === "string" ? f.speaker.trim() : "";
    const speaker = claimed && ctx.owners.has(claimed.toLowerCase()) ? claimed : undefined;
    statements.push({
      id: `ST${++n}`,
      text,
      kind,
      source,
      ...(speaker ? { speaker } : {}),
      // Recomputed, not trusted: heardPoorly is derived from STT confidence.
      ...(source.every((id) => (ctx.index.get(id)?.confidence ?? 1) < 0.6) ? { heardPoorly: true } : {}),
    });
  }
  return { statements, dropped, promptVersion: promptRef(EXTRACT_STATEMENTS) };
}

/** The compact JSON the compose pass sees. Trimmed to keep weak models on task. */
export function statementsForPrompt(statements: Statement[]): string {
  return JSON.stringify(
    statements.map((f) => ({
      text: f.text,
      kind: f.kind,
      source: f.source,
      ...(f.speaker ? { speaker: f.speaker } : {}),
      ...(f.heardPoorly ? { heardPoorly: true } : {}),
    })),
  );
}
