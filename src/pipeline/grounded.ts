/**
 * The two-pass pipeline: extract → compose → validate → regenerate.
 *
 *   facts (pass 1, temp 0) ─┐
 *                           ├─▶ compose (pass 2) ─▶ validate (code) ─┬─▶ ship
 *   memory (labels only) ───┘            ▲                           │
 *                                        └── failures fed back ──────┘
 *                                            (max 2 retries)
 *
 * After the retries are spent we do NOT ship the model's last answer as-is and
 * we do not paper over it: invalid leaves and items are pruned by code, and the
 * output is marked needsReview so the UI can say "low confidence, please review".
 * Failing closed is the whole design — a thin note is recoverable, a confident
 * wrong one is not.
 */
import { Budget, retry, type StepRecord } from "../lib/harness.js";
import { CodedError, because, publicReason } from "../lib/reasons.js";
import { ModelError, chatJson } from "../lib/model.js";
import { REFINE, REPAIR } from "../lib/prompts.js";
import { formatFailures, isSoft, type Failure, type GroundingContext } from "../lib/grounding.js";
import { factsForPrompt, type Fact } from "./facts.js";

export type ComposeSpec<T> = {
  /** For logs and the output card: "notes", "handoff:vendor_quote". */
  purpose: string;
  /** Versioned template ref recorded on the output, e.g. "notes.compose@v1". */
  promptVersion: string;
  system: (facts: string) => string;
  /** The user turn. Kept separate so repair/refine text can be appended to it. */
  user: string;
  temperature?: number;
  /** Shape check. Returns the typed value, or an error string to feed back. */
  parse: (raw: unknown) => T | string;
  /** Grounding check. Empty array means shippable. */
  validate: (value: T, ctx: GroundingContext) => Failure[];
  /** Deterministic last resort: drop what failed, keep what is real. */
  prune: (value: T, failures: Failure[], ctx: GroundingContext) => { value: T; dropped: number };
  /** Code-owned derived flags (lowConfidence). Runs on the value that ships. */
  finalize?: (value: T, ctx: GroundingContext) => void;
};

export type GroundedOutput<T> = {
  value: T | null;
  /** True when the output shipped with pruning or without full validation. */
  needsReview: boolean;
  /** Why, in the validator's words. Surfaced in the debug drawer, not the card. */
  failures: Failure[];
  dropped: number;
  attempts: number;
  promptVersion: string;
  steps: StepRecord[];
  /** Set when even the shape never parsed — the UI shows a failure, not a card. */
  error?: string;
};

export const MAX_COMPOSE_ATTEMPTS = 3; // one shot + two retries (§4.2)
/** Style-only problems are worth one corrective pass, not three. */
export const SOFT_ONLY_ATTEMPTS = 2;

export async function compose<T>(
  spec: ComposeSpec<T>,
  facts: Fact[],
  ctx: GroundingContext,
  opts: { budget?: Budget; refine?: string } = {},
): Promise<GroundedOutput<T>> {
  const budget = opts.budget ?? new Budget(12, 120_000);
  const factsJson = factsForPrompt(facts);
  const steps: StepRecord[] = [];
  // The last invalid candidate survives the loop so we can prune it instead of
  // returning nothing at all.
  let last: { value: T; failures: Failure[] } | null = null;
  let attempts = 0;

  const run = await retry(
    `compose:${spec.purpose}`,
    budget,
    async (attempt, lastError) => {
      attempts = attempt;
      const repair = lastError ? REPAIR.build({ failures: lastError, attempt }) : "";
      const refine = opts.refine ? REFINE.build({ instruction: opts.refine }) : "";
      const raw = await chatJson({
        purpose: spec.purpose,
        temperature: spec.temperature ?? 0.1,
        system: spec.system(factsJson),
        user: `${spec.user}${refine}${repair}`,
      });
      budget.spendUnits(1);
      const parsed = spec.parse(raw);
      if (typeof parsed === "string") throw new CodedError("schema-invalid", `schema: ${parsed}`);
      const failures = spec.validate(parsed, ctx);
      if (failures.length) {
        last = { value: parsed, failures };
        // Style-only failures get one nudge, not the full retry budget: nobody
        // should pay for three model calls because a bullet was terse.
        if (attempt >= SOFT_ONLY_ATTEMPTS && failures.every(isSoft)) return parsed;
        // The aimed retry: the validator's words ride back as the detail.
        throw new CodedError("grounding-blocked", formatFailures(failures));
      }
      return parsed;
    },
    {
      max: MAX_COMPOSE_ATTEMPTS,
      // A dead key or a 400 will not become valid on the third try.
      retryable: (e) => !(e instanceof ModelError) || e.retryable,
    },
  );
  steps.push(run.record);

  if (run.value) {
    spec.finalize?.(run.value, ctx);
    // A soft-only run is shippable: the notes are true, just terser than we
    // asked for. The reasons stay on the record for the debug drawer.
    const soft = last && (last as { value: T; failures: Failure[] }).value === run.value ? (last as { value: T; failures: Failure[] }).failures : [];
    return { value: run.value, needsReview: false, failures: soft, dropped: 0, attempts, promptVersion: spec.promptVersion, steps };
  }

  const candidate = last as { value: T; failures: Failure[] } | null;
  if (!candidate) {
    // Never parsed, or transport died. No card, an honest error.
    return {
      value: null,
      needsReview: true,
      failures: [],
      dropped: 0,
      attempts,
      promptVersion: spec.promptVersion,
      steps,
      // User-facing: the code's human label only; the detail stays on the record.
      error: publicReason(run.record.reason) || "the model produced nothing usable",
    };
  }

  const pruned = spec.prune(candidate.value, candidate.failures, ctx);
  spec.finalize?.(pruned.value, ctx);
  const hard = candidate.failures.filter((f) => !isSoft(f));
  steps.push({
    name: `gate:${spec.purpose}`,
    status: hard.length ? "blocked" : "retried",
    attempts,
    ms: 0,
    reason: because(
      "grounding-blocked",
      `${hard.length} grounding failure(s) and ${candidate.failures.length - hard.length} style note(s) after ${attempts} attempts; ${pruned.dropped} item(s) dropped`,
    ),
  });
  return {
    value: pruned.value,
    // "Please review" has to keep meaning "grounding is in doubt".
    needsReview: hard.length > 0,
    failures: candidate.failures,
    dropped: pruned.dropped,
    attempts,
    promptVersion: spec.promptVersion,
    steps,
  };
}
