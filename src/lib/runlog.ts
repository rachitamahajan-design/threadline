/**
 * Failure invariance: no run exits without leaving a structured record.
 *
 * The trick is the write order. `beginRun` INSERTs the row the moment a run
 * starts, already stamped `failed` with a crash reason — then `finish` (called
 * in the happy path AND in the catch) UPDATEs it with what actually happened.
 * A process that dies mid-run, an unhandled throw, a kill -9: the record is
 * already on disk, honestly describing a run that never finished. The UI can
 * always offer a retry, because there is always a row to hang it on.
 *
 * Every record carries: kind, start, end, one of the four outcomes, every
 * step with its structured reason, units spent, tokens and cost.
 */
import type { DatabaseSync } from "node:sqlite";
import { log } from "./log.js";
import { usageCursor, usageSince } from "./model.js";
import { because, reasonFrom, type Outcome, type Reason } from "./reasons.js";
import type { WorkflowKind } from "./config.js";
import { Budget, type StepRecord } from "./harness.js";

export type RunRecord = {
  id: number;
  kind: WorkflowKind | string;
  meetingId: string;
  startedAt: number;
  /** null means the run never finished — the crash placeholder is still live. */
  endedAt: number | null;
  outcome: Outcome;
  failure: Reason | null;
  steps: StepRecord[];
  /** What the retry button re-runs with (handoff id, question, …). */
  args: unknown;
  unitsSpent: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
};

export type RunHandle = {
  id: number;
  finish(final: { outcome: Outcome; steps: StepRecord[]; failure?: Reason | null; unitsSpent?: number }): void;
};

/** INSERT the crash placeholder now; `finish` overwrites it with the truth. */
export function beginRun(
  db: DatabaseSync,
  opts: { kind: WorkflowKind; meetingId?: string; args?: unknown },
): RunHandle {
  const cursor = usageCursor();
  const crash = because("crash", "run never finished — the process died or was killed mid-run");
  const r = db
    .prepare(
      `INSERT INTO runs (meeting_id, started_at, exit, steps, units_spent, kind, outcome, failure, args)
       VALUES (?, ?, 'failed', '[]', 0, ?, 'failed', ?, ?)`,
    )
    .run(
      opts.meetingId ?? "",
      Date.now(),
      opts.kind,
      JSON.stringify(crash),
      opts.args === undefined ? null : JSON.stringify(opts.args),
    );
  const id = Number(r.lastInsertRowid);
  const startedAt = Date.now();
  log.info("run.start", { run: id, kind: opts.kind, meeting: opts.meetingId ?? "" });
  let finished = false;
  return {
    id,
    finish(final) {
      if (finished) return;
      finished = true;
      const use = usageSince(cursor);
      // The disk twin of the row below. Metadata only — no meeting content.
      log[final.outcome === "shipped" ? "info" : "warn"]("run.finish", {
        run: id,
        kind: opts.kind,
        meeting: opts.meetingId ?? "",
        outcome: final.outcome,
        ms: Date.now() - startedAt,
        units: final.unitsSpent ?? 0,
        tokensIn: use.tokensIn,
        tokensOut: use.tokensOut,
        costUsd: Number(use.costUsd.toFixed(6)),
        // Code only — failure.detail can quote the transcript, and the log file
        // must stay free of meeting content. The full Reason lives in the row below.
        failure: final.failure ? final.failure.code : undefined,
        steps: final.steps.map((s) => ({ name: s.name, status: s.status, attempts: s.attempts, ms: s.ms, code: s.reason?.code })),
      });
      db.prepare(
        `UPDATE runs SET exit = ?, outcome = ?, steps = ?, failure = ?, ended_at = ?, units_spent = ?,
           tokens_in = ?, tokens_out = ?, cost_usd = ? WHERE id = ?`,
      ).run(
        final.outcome, // legacy column readers keep working
        final.outcome,
        JSON.stringify(final.steps),
        final.failure ? JSON.stringify(final.failure) : null,
        Date.now(),
        final.unitsSpent ?? 0,
        use.tokensIn,
        use.tokensOut,
        use.costUsd,
        id,
      );
    },
  };
}

/**
 * Run one workflow inside the invariant. The budget governor comes from config
 * (agents.json budgets.workflows) unless the caller passes one; `summarize`
 * maps the workflow's own result shape onto the closed set of outcomes.
 * Exceptions still propagate — but only after the record is finalized.
 */
export async function recordRun<T>(
  db: DatabaseSync,
  opts: { kind: WorkflowKind; meetingId?: string; args?: unknown; budget?: Budget },
  fn: (budget: Budget, runId: number) => Promise<T>,
  summarize: (value: T) => { outcome: Outcome; steps: StepRecord[]; failure?: Reason | null },
): Promise<T> {
  const budget = opts.budget ?? Budget.for(opts.kind);
  const run = beginRun(db, opts);
  try {
    const value = await fn(budget, run.id);
    run.finish({ ...summarize(value), unitsSpent: budget.spent.units });
    return value;
  } catch (e) {
    const reason = reasonFrom(e);
    run.finish({
      outcome: "failed",
      steps: [{ name: `${opts.kind}:crash`, status: "failed", attempts: 1, ms: 0, reason }],
      failure: reason,
      unitsSpent: budget.spent.units,
    });
    throw e;
  }
}

/** The first structured reason that explains a non-shipped run, for the record's failure column. */
export function firstFailure(steps: StepRecord[]): Reason | null {
  const bad = steps.find((s) => s.status === "failed") ?? steps.find((s) => s.status === "blocked" || s.status === "skipped");
  return bad?.reason ?? null;
}

// ── Readers ─────────────────────────────────────────────────────────────────

type RunRow = {
  id: number;
  meeting_id: string;
  started_at: number;
  exit: string;
  steps: string;
  units_spent: number;
  kind: string;
  outcome: string | null;
  failure: string | null;
  args: string | null;
  ended_at: number | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
};

function toRecord(r: RunRow): RunRecord {
  const parse = <T,>(s: string | null, fallback: T): T => {
    if (!s) return fallback;
    try {
      return JSON.parse(s) as T;
    } catch {
      return fallback;
    }
  };
  // Rows older than the outcome column: map the legacy 5-value exit down.
  const legacy = r.exit === "budget" ? "deadline" : r.exit;
  const outcome = (r.outcome ?? legacy) as Outcome;
  return {
    id: r.id,
    kind: r.kind,
    meetingId: r.meeting_id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    outcome,
    failure: parse<Reason | null>(r.failure, null),
    steps: parse<StepRecord[]>(r.steps, []),
    args: parse<unknown>(r.args, null),
    unitsSpent: r.units_spent,
    tokensIn: r.tokens_in,
    tokensOut: r.tokens_out,
    costUsd: r.cost_usd,
  };
}

export function getRun(db: DatabaseSync, id: number): RunRecord | null {
  const row = db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as RunRow | undefined;
  return row ? toRecord(row) : null;
}

export function listRuns(db: DatabaseSync, meetingId: string, limit = 10): RunRecord[] {
  const rows = db
    .prepare(`SELECT * FROM runs WHERE meeting_id = ? ORDER BY id DESC LIMIT ?`)
    .all(meetingId, limit) as RunRow[];
  return rows.map(toRecord);
}

/** Every meeting, newest first — feeds the harness console on harness.html. */
export function listRecentRuns(db: DatabaseSync, limit = 50): RunRecord[] {
  const rows = db.prepare(`SELECT * FROM runs ORDER BY id DESC LIMIT ?`).all(limit) as RunRow[];
  return rows.map(toRecord);
}
