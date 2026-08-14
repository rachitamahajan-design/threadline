/**
 * The structured vocabulary every run speaks.
 *
 * Nothing in a run record is a free string: an outcome is one of four named
 * exits, and every "why" is a `Reason` — a machine-readable code plus an
 * optional human detail. The code is what dashboards, retries and tests branch
 * on; the detail is what a person (or a repair prompt) reads.
 *
 * This file imports nothing, so anything may import it without cycles.
 */

/**
 * The four ways a run is allowed to end. Closed set, closed loop:
 *   shipped   everything produced and verified
 *   partial   something shipped, but steps failed/were blocked/were pruned
 *   deadline  the budget governor stopped the run (time or units exhausted)
 *   failed    a core step died — nothing usable shipped
 */
export const OUTCOMES = ["shipped", "partial", "deadline", "failed"] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** Every way a step is known to fail. Add here, never inline a new string. */
export const FAILURE_CODES = [
  // transport / model
  "model-timeout",
  "model-rate-limited",
  "model-http",
  "model-unreachable",
  "model-unconfigured",
  "model-bad-json",
  // output quality
  "schema-invalid",
  "grounding-blocked",
  "entailment-unsupported",
  // budget governor
  "budget-exhausted",
  "deadline-exceeded",
  // preconditions
  "no-transcript",
  "no-facts",
  "no-retrieval",
  "not-found",
  // everything else
  "upstream-failed",
  "network-failed",
  "skipped-local-only",
  "crash",
  /** Not a failure: an informational annotation on an ok step. */
  "info",
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

/** A structured "why". `detail` is for humans and repair prompts; `code` is for code. */
export type Reason = { code: FailureCode; detail?: string };

export function because(code: FailureCode, detail?: string): Reason {
  return detail ? { code, detail } : { code };
}

const LABELS: Record<FailureCode, string> = {
  "model-timeout": "the model call timed out",
  "model-rate-limited": "the model host rate-limited us",
  "model-http": "the model host returned an error",
  "model-unreachable": "the model host could not be reached",
  "model-unconfigured": "no model is configured",
  "model-bad-json": "the model did not return usable JSON",
  "schema-invalid": "the model's JSON did not match the schema",
  "grounding-blocked": "the output failed the grounding gate",
  "entailment-unsupported": "the cited transcript does not support the claim",
  "budget-exhausted": "the run's unit budget was exhausted",
  "deadline-exceeded": "the run's deadline passed",
  "no-transcript": "no transcript exists yet",
  "no-facts": "nothing in the transcript survived extraction",
  "no-retrieval": "retrieval found nothing relevant",
  "not-found": "the requested record does not exist",
  "upstream-failed": "an upstream service failed",
  "network-failed": "a network request failed",
  "skipped-local-only": "skipped — running local-only",
  crash: "something went wrong",
  info: "",
};

/**
 * One line for logs, run records and repair prompts. Prefers the specific
 * detail over the label — NEVER show this to the user; that's publicReason.
 */
export function describeReason(r: Reason | undefined | null): string {
  if (!r) return "";
  return r.detail ?? LABELS[r.code] ?? r.code;
}

/**
 * The user-facing line. Only the human label for the code — the detail
 * (HTTP bodies, validator output, stack fragments) stays in the run record
 * and the server log, never on screen.
 */
export function publicReason(r: Reason | undefined | null): string {
  if (!r) return "";
  return LABELS[r.code] ?? "something went wrong";
}

/** Throw this when you already know the code. `reasonFrom` returns it verbatim. */
export class CodedError extends Error {
  readonly reason: Reason;
  constructor(code: FailureCode, detail?: string) {
    super(detail ?? LABELS[code] ?? code);
    this.reason = because(code, detail);
  }
}

/**
 * Classify any thrown value into a Reason. ModelError is detected structurally
 * (a numeric `status`) so this file stays import-free.
 */
export function reasonFrom(e: unknown): Reason {
  if (e instanceof CodedError) return e.reason;
  if (e instanceof Error) {
    const status = (e as { status?: unknown }).status;
    if (typeof status === "number") {
      if (status === 429) return because("model-rate-limited", e.message);
      if (status >= 500) return because("model-http", e.message);
      if (status === 0) {
        if (/timed out/i.test(e.message)) return because("model-timeout", e.message);
        if (/API_KEY|not set|no mock/i.test(e.message)) return because("model-unconfigured", e.message);
        return because("model-unreachable", e.message);
      }
      return because("model-http", e.message);
    }
    if (/did not return JSON/i.test(e.message)) return because("model-bad-json", e.message);
    if (/^schema:/i.test(e.message)) return because("schema-invalid", e.message);
    // Undici's bare "TypeError: fetch failed" and friends: a dead network is a
    // known failure mode, not a crash. The useful part often hides in `cause`.
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket hang up|network/i.test(e.message)) {
      const cause = (e as { cause?: unknown }).cause;
      const detail = cause instanceof Error && cause.message ? `${e.message}: ${cause.message}` : e.message;
      return because("network-failed", detail);
    }
    return because("crash", e.message);
  }
  return because("crash", String(e));
}
