/**
 * The harness: the seven parts from slide 10, applied to a meeting.
 *
 * The point of this file is that a note is never allowed to contain a claim
 * that isn't in the transcript. Everything else is bookkeeping around that.
 */

import { because, reasonFrom, type Outcome, type Reason } from "./reasons.js";
import { budgetFor, retryPolicy, type WorkflowKind } from "./config.js";

/**
 * The four named exits, re-exported for existing imports. "deadline" covers
 * both budget dimensions: time ran out or units ran out — either way the
 * governor stopped the run. The canonical type lives in reasons.ts.
 */
export type ExitReason = Outcome;

export type RunResult<T> = {
  exit: Outcome;
  value: T | null;
  /** Every run leaves a record, including the ones that died. */
  steps: StepRecord[];
  spent: { units: number; ms: number };
};

export type StepStatus = "ok" | "retried" | "blocked" | "failed" | "skipped";

export type StepRecord = {
  name: string;
  status: StepStatus;
  attempts: number;
  ms: number;
  /** Why a gate blocked it, or why it failed. Structured: a code plus detail. */
  reason?: Reason;
};

/**
 * Budget governor. Time and API units, checked before every step. Sizes come
 * from the budgets section of agents.json via `Budget.for(kind)` — a workflow's
 * spend ceiling is a config edit, not a code change.
 */
export class Budget {
  private startedAt = Date.now();
  private units = 0;
  constructor(
    readonly maxUnits: number,
    readonly maxMs: number,
  ) {}
  /** The governor for one workflow, sized by config. */
  static for(kind: WorkflowKind): Budget {
    const spec = budgetFor(kind);
    return new Budget(spec.units, spec.ms);
  }
  spendUnits(n: number) {
    this.units += n;
  }
  get spent() {
    return { units: this.units, ms: Date.now() - this.startedAt };
  }
  /** Why the run must stop now, or null to continue. Both codes exit as "deadline". */
  check(): Reason | null {
    if (Date.now() - this.startedAt > this.maxMs)
      return because("deadline-exceeded", `run exceeded its ${this.maxMs}ms deadline`);
    if (this.units >= this.maxUnits)
      return because("budget-exhausted", `run spent all ${this.maxUnits} of its budgeted units`);
    return null;
  }
}

/**
 * A blocking gate. Returns null to pass, or a reason string to block.
 * A blocked step never reaches the note.
 */
export type Gate<T> = (value: T) => string | null;

/**
 * The gate that matters: every claim must quote the transcript.
 *
 * Recap hands back `moments` with an `offset_s` and `risk_signals` with a
 * `quote`, but it also hands back prose (`summary_draft`, `next_steps`) with no
 * anchor at all. We only ship the anchored parts, and we verify the anchor
 * actually exists in the transcript rather than trusting the model.
 */
export function groundedIn(transcript: { text: string; offset_s: number }[]) {
  const haystack = transcript.map((u) => normalize(u.text)).join(" ␟ ");
  return function gate(claim: { quote?: string; offset_s?: number }): string | null {
    if (claim.quote) {
      const needle = normalize(claim.quote);
      // Models paraphrase. Require a real overlap, not an exact match.
      if (!containsLooseley(haystack, needle)) {
        return `quote not found in transcript: ${JSON.stringify(claim.quote.slice(0, 60))}`;
      }
      return null;
    }
    if (typeof claim.offset_s === "number") {
      const hit = transcript.some((u) => Math.abs(u.offset_s - claim.offset_s!) <= 15);
      return hit ? null : `offset ${claim.offset_s}s matches no utterance`;
    }
    return "claim carries neither a quote nor an offset";
  };
}

/** Exported so entity resolution and the receipts gate agree on "same text". */
export function normalize(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

/** True if most of the needle's content words appear in order-independent form. */
function containsLooseley(haystack: string, needle: string) {
  if (!needle) return false;
  if (haystack.includes(needle)) return true;
  const words = needle.split(" ").filter((w) => w.length > 3);
  if (words.length === 0) return haystack.includes(needle);
  const hits = words.filter((w) => haystack.includes(w)).length;
  return hits / words.length >= 0.7;
}

/** Composes gates: first reason wins, null only if every gate passes. */
export function allOf<T>(...gates: Gate<T>[]): Gate<T> {
  return (v) => {
    for (const g of gates) {
      const r = g(v);
      if (r) return r;
    }
    return null;
  };
}

/** Runs `gate` over a list, keeping what passes and recording what didn't. */
export function applyGate<T>(items: T[], gate: Gate<T>) {
  const kept: T[] = [];
  const blocked: { item: T; reason: string }[] = [];
  for (const item of items) {
    const reason = gate(item);
    if (reason) blocked.push({ item, reason });
    else kept.push(item);
  }
  return { kept, blocked };
}

/**
 * Bounded, aimed retry. The failure reason is fed back into the next attempt so
 * the retry is actually different from the attempt that failed. Capped, never
 * infinite, and it gives up immediately on errors that can't succeed.
 */
export async function retry<T>(
  name: string,
  budget: Budget,
  fn: (attempt: number, lastError: string | null) => Promise<T>,
  opts: { max?: number; retryable?: (e: unknown) => boolean } = {},
): Promise<{ value: T | null; record: StepRecord }> {
  const policy = retryPolicy();
  const max = opts.max ?? policy.maxAttempts;
  const startedAt = Date.now();
  let lastError: string | null = null;
  let lastReason: Reason | null = null;

  for (let attempt = 1; attempt <= max; attempt++) {
    const stop = budget.check();
    if (stop) {
      return {
        value: null,
        record: { name, status: "skipped", attempts: attempt - 1, ms: Date.now() - startedAt, reason: stop },
      };
    }
    try {
      const value = await fn(attempt, lastError);
      return {
        value,
        record: {
          name,
          status: attempt === 1 ? "ok" : "retried",
          attempts: attempt,
          ms: Date.now() - startedAt,
        },
      };
    } catch (e) {
      // The structured reason is what the record keeps; the raw message is what
      // the next attempt is aimed with (validator text, verbatim).
      lastReason = reasonFrom(e);
      lastError = e instanceof Error ? e.message : String(e);
      const canRetry = opts.retryable ? opts.retryable(e) : true;
      if (!canRetry || attempt === max) {
        return {
          value: null,
          record: { name, status: "failed", attempts: attempt, ms: Date.now() - startedAt, reason: lastReason },
        };
      }
      await new Promise((r) => setTimeout(r, policy.baseDelayMs * 2 ** (attempt - 1)));
    }
  }
  return {
    value: null,
    record: { name, status: "failed", attempts: max, ms: Date.now() - startedAt, reason: lastReason ?? because("crash") },
  };
}

/**
 * Safe parallelism: reads fan out, writes are serialised. Meeting extraction
 * runs several independent passes over one transcript, but only one of them is
 * allowed to touch the local database at a time.
 */
export async function fanOut<T>(tasks: (() => Promise<T>)[], limit = 4): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const i = cursor++;
      try {
        results[i] = { status: "fulfilled", value: await tasks[i]() };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/** Decides the run's single named exit from what actually happened. */
export function decideExit(steps: StepRecord[], budget: Budget): Outcome {
  if (budget.check()) return "deadline";
  if (steps.some((s) => s.status === "failed" && s.name.startsWith("core:"))) return "failed";
  if (steps.some((s) => s.status === "failed" || s.status === "blocked" || s.status === "skipped")) return "partial";
  return "shipped";
}
