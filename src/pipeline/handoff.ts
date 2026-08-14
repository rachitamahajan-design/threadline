/**
 * Running things: the orchestration the server calls.
 *
 *   ensureStatements pass 1, cached per meeting (every handoff shares it)
 *   ensureNotes     the always-on themed outline
 *   runHandoff      one handoff, on demand, for one meeting
 *   runCrossHandoff one handoff across N meetings (collated feedback)
 *
 * Nothing in here runs by itself. `ensureNotes` is called when a transcript
 * lands; handoffs are called only from an explicit user action.
 */
import type { DatabaseSync } from "node:sqlite";
import { Budget, decideExit, type StepRecord } from "../lib/harness.js";
import { because, publicReason, reasonFrom, type Outcome, type Reason } from "../lib/reasons.js";
import { firstFailure, recordRun } from "../lib/runlog.js";
import { groundingContext, type GroundingContext } from "../lib/grounding.js";
import { modelConfigured } from "../lib/model.js";
import {
  loadSegments,
  meetingTypeOf,
  participantsOf,
  transcriptFingerprint,
  type MeetingType,
  type Segment,
} from "../lib/segments.js";
import {
  insertHandoffRun,
  readOutline,
  readStatements,
  writeOutline,
  writeStatements,
  type StoredHandoff,
  type StoredOutline,
} from "../lib/store.js";
import { extractStatements, type Statement, type StatementSet } from "./statements.js";

import { compose, type GroundedOutput } from "./grounded.js";
import { generateNotes, memoryContext, repairNotes } from "./notes-outline.js";
import { entailmentFailures, entailmentMode, spotcheckNotes } from "./entail.js";
import type { Notes } from "../lib/outline.js";
import { aliasSegments, type HandoffDef } from "../handoffs/types.js";
import { getHandoff } from "../handoffs/registry.js";
import { promptRef } from "../lib/prompts.js";

export type MeetingMeta = {
  id: string;
  title: string;
  type: MeetingType;
  when: string;
  segments: Segment[];
  participants: string[];
  ctx: GroundingContext;
};

export function meetingMeta(db: DatabaseSync, meetingId: string): MeetingMeta | null {
  const row = db.prepare(`SELECT id, title, mode, meeting_type, started_at FROM meetings WHERE id = ?`).get(meetingId) as
    | { id: string; title: string; mode: string; meeting_type: string | null; started_at: number }
    | undefined;
  if (!row) return null;
  const segments = loadSegments(db, meetingId);
  // Two different lists, deliberately:
  //   `participants`  who was actually in the room — this is what prompts see,
  //                   so a follow-up email cannot greet someone who wasn't there.
  //   ctx owners      that set PLUS the local people directory — a founder may
  //                   legitimately assign an action to someone off the call.
  const speakers = [...new Set(segments.map((s) => s.speaker).filter(Boolean))];
  return {
    id: row.id,
    title: row.title,
    type: meetingTypeOf(row.mode, row.meeting_type),
    when: new Date(row.started_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }),
    segments,
    participants: speakers,
    ctx: groundingContext({ segments, participants: participantsOf(db, meetingId) }),
  };
}

/**
 * Pass 1, once per meeting. Cheap on repeat, identical statements for every
 * handoff. `steps` collects the extraction step when one actually ran, so a
 * cache hit costs nothing and a retried extraction still shows up on the run
 * record.
 */
export async function ensureStatements(
  db: DatabaseSync,
  m: MeetingMeta,
  opts: { force?: boolean; budget?: Budget; steps?: StepRecord[] } = {},
): Promise<StatementSet> {
  const fingerprint = transcriptFingerprint(m.segments);
  if (!opts.force) {
    const cached = readStatements(db, m.id);
    // Only a cache built from THIS transcript counts. A set extracted while
    // the recording was still short (or before an edit) — including the empty
    // set a near-blank transcript yields — must not be served forever.
    if (cached && cached.fingerprint === fingerprint) return cached;
  }
  const { set, step } = await extractStatements(m.segments, m.ctx, {
    type: m.type,
    participants: m.participants,
    budget: opts.budget,
  });
  opts.steps?.push(step);
  writeStatements(db, m.id, set, fingerprint);
  return set;
}

/**
 * The blocking entailment gate (§4.2), applied to a composed Notes tree.
 * In "blocking" mode an unsupported leaf is pruned before the user sees it;
 * in "advisory" mode spotcheckNotes has already marked it lowConfidence. A
 * checker that itself fails never deletes — the output ships marked
 * needs-review instead, because unverified is not the same as wrong.
 */
async function applyEntailmentGate(
  out: GroundedOutput<Notes>,
  ctx: GroundingContext,
  steps: StepRecord[],
): Promise<void> {
  const mode = entailmentMode();
  if (mode === "off" || !out.value) return;
  const t0 = Date.now();
  const check = await spotcheckNotes(out.value, ctx);
  const ms = Date.now() - t0;
  if (check.error) {
    steps.push({ name: "gate:entailment", status: "failed", attempts: 1, ms, reason: check.error });
    if (mode === "blocking") out.needsReview = true;
    return;
  }
  if (!check.flagged) {
    steps.push({ name: "gate:entailment", status: "ok", attempts: 1, ms });
    return;
  }
  if (mode === "blocking") {
    const failures = entailmentFailures(check.verdicts);
    const pruned = repairNotes(out.value, failures);
    out.value = pruned.value;
    out.dropped += pruned.dropped;
    out.failures = [...out.failures, ...failures];
    out.needsReview = true;
    steps.push({
      name: "gate:entailment",
      status: "blocked",
      attempts: 1,
      ms,
      reason: because("entailment-unsupported", `${check.flagged} claim(s) not supported by their own citations — pruned`),
    });
  } else {
    steps.push({
      name: "gate:entailment",
      status: "blocked",
      attempts: 1,
      ms,
      reason: because("entailment-unsupported", `${check.flagged} claim(s) doubted — marked low confidence`),
    });
  }
}

/** Maps a grounded compose onto the closed set of outcomes. */
function outcomeOf(out: { value: unknown; needsReview: boolean; dropped: number }, steps: StepRecord[], budget: Budget): Outcome {
  if (!out.value) return decideExit(steps, budget) === "deadline" ? "deadline" : "failed";
  if (budget.check()) return "deadline";
  if (out.needsReview || out.dropped > 0) return "partial";
  return decideExit(steps, budget);
}

/**
 * The always-on notes. Returns the stored outline, generating it if this
 * meeting has none. A user-edited outline is never regenerated implicitly.
 *
 * Closed loop: every generation attempt — including the ones that die on a
 * missing transcript or a crash — leaves a run record with one of the four
 * outcomes, and `runId` rides back so the UI can hang a retry on it.
 */
export async function ensureNotes(
  db: DatabaseSync,
  meetingId: string,
  opts: { force?: boolean; refine?: string; budget?: Budget; hints?: string } = {},
): Promise<{ outline: StoredOutline | null; error?: string; runId?: number }> {
  const existing = readOutline(db, meetingId);
  if (existing && !opts.force && !opts.refine) return { outline: existing };

  const steps: StepRecord[] = [];
  let failure: Reason | null = null;
  let budgetUsed: Budget | null = null;
  const bail = (code: Parameters<typeof because>[0], msg: string, outline: StoredOutline | null) => {
    failure = because(code, msg);
    steps.push({ name: "notes:precondition", status: "failed", attempts: 1, ms: 0, reason: failure });
    return { outline, error: msg };
  };

  return recordRun(
    db,
    {
      kind: "notes",
      meetingId,
      args: { refine: opts.refine ?? null, hints: opts.hints ? true : false },
      budget: opts.budget,
    },
    async (budget, runId) => {
      budgetUsed = budget;
      const m = meetingMeta(db, meetingId);
      if (!m) return { ...bail("not-found", "meeting not found", null), runId };
      if (!m.segments.length) return { ...bail("no-transcript", "no transcript yet", null), runId };
      if (!modelConfigured())
        return { ...bail("model-unconfigured", "no model configured — set PYAI_API_KEY (or OPENAI_API_KEY)", existing), runId };

      // Fail closed. A model that is down, 404ing or out of quota is an
      // OUTCOME, not an exception to throw at the caller: the run is recorded
      // failed with its reason and the UI gets a retry button. Throwing here is
      // what previously took the server down instead.
      let statements: StatementSet;
      try {
        // An explicit rebuild re-extracts: the user is asking for a fresh pass
        // over the transcript, not a recompose of whatever pass 1 said before.
        statements = await ensureStatements(db, m, { force: opts.force, budget, steps });
      } catch (e) {
        failure = reasonFrom(e);
        steps.push({ name: "extract:statements", status: "failed", attempts: 1, ms: 0, reason: failure });
        return { outline: existing, error: publicReason(failure), runId };
      }
      const out = await generateNotes(statements.statements, m.ctx, {
        type: m.type,
        participants: m.participants,
        memory: memoryContext(db, meetingId),
        // The founder's rough notes steer emphasis and theme naming. They are not
        // a transcript, so the validators still refuse to let them source anything.
        hints: opts.hints?.trim() ? opts.hints.trim().slice(0, 4000) : undefined,
        budget,
        refine: opts.refine,
      });
      steps.push(...out.steps);
      if (!out.value) {
        failure = firstFailure(out.steps) ?? because("crash", out.error ?? "notes could not be generated");
        return { outline: existing, error: out.error ?? "notes could not be generated", runId };
      }
      await applyEntailmentGate(out, m.ctx, steps);
      writeOutline(
        db,
        meetingId,
        {
          notes: out.value,
          promptVersion: out.promptVersion,
          needsReview: out.needsReview,
          dropped: out.dropped,
          failures: out.failures,
        },
        opts.refine ? "refine" : opts.force ? "regenerate" : "generated",
      );
      if (out.needsReview || out.dropped > 0) failure = failure ?? firstFailure(steps);
      return { outline: readOutline(db, meetingId), runId, _out: out } as {
        outline: StoredOutline | null;
        error?: string;
        runId: number;
        _out?: GroundedOutput<Notes>;
      };
    },
    (res) => {
      const budget = budgetUsed ?? Budget.for("notes");
      const out = (res as { _out?: GroundedOutput<Notes> })._out;
      const outcome: Outcome = res.error
        ? "failed"
        : out
          ? outcomeOf(out, steps, budget)
          : decideExit(steps, budget);
      return { outcome, steps, failure: outcome === "shipped" ? null : failure ?? firstFailure(steps) };
    },
  );
}

// ── Handoffs ────────────────────────────────────────────────────────────────

export type HandoffResult = { run: StoredHandoff | null; error?: string; runId?: number };

export async function runHandoff(
  db: DatabaseSync,
  args: { meetingId: string; handoffId: string; refine?: string },
): Promise<HandoffResult> {
  const def = getHandoff(args.handoffId);
  if (!def) return { run: null, error: `unknown handoff "${args.handoffId}"` };
  if (def.scope === "cross-meeting")
    return { run: null, error: `${def.label} runs across meetings — call /api/handoff/cross instead` };

  const steps: StepRecord[] = [];
  let failure: Reason | null = null;
  let budgetUsed: Budget | null = null;
  const bail = (code: Parameters<typeof because>[0], msg: string) => {
    failure = because(code, msg);
    steps.push({ name: "handoff:precondition", status: "failed", attempts: 1, ms: 0, reason: failure });
    return { run: null, error: msg };
  };

  return recordRun(
    db,
    { kind: "handoff", meetingId: args.meetingId, args: { handoffId: args.handoffId, refine: args.refine ?? null } },
    async (budget, runId): Promise<HandoffResult & { _out?: GroundedOutput<unknown> }> => {
      budgetUsed = budget;
      const m = meetingMeta(db, args.meetingId);
      if (!m) return { ...bail("not-found", "meeting not found"), runId };
      if (!m.segments.length) return { ...bail("no-transcript", "no transcript yet"), runId };
      if (!modelConfigured())
        return { ...bail("model-unconfigured", "no model configured — set PYAI_API_KEY (or OPENAI_API_KEY)"), runId };

      let statements: StatementSet;
      try {
        statements = await ensureStatements(db, m, { budget, steps });
      } catch (e) {
        failure = reasonFrom(e);
        steps.push({ name: "extract:statements", status: "failed", attempts: 1, ms: 0, reason: failure });
        return { run: null, error: publicReason(failure), runId };
      }
      if (!statements.statements.length)
        return { ...bail("no-statements", "nothing in this transcript survived extraction — there is nothing to hand off"), runId };

      const out = await compose(specOf(def, { participants: m.participants, type: m.type }), statements.statements, m.ctx, {
        budget,
        refine: args.refine,
      });
      steps.push(...out.steps);
      if (!out.value) {
        failure = firstFailure(out.steps) ?? because("crash", out.error ?? `${def.label} could not be generated`);
        return { run: null, error: out.error ?? `${def.label} could not be generated`, runId };
      }

      const markdown = def.toMarkdown(out.value, { title: m.title, when: m.when });
      return {
        run: insertHandoffRun(db, {
          meetingId: m.id,
          handoffId: def.id,
          value: out.value,
          markdown,
          promptVersion: out.promptVersion,
          needsReview: out.needsReview,
          dropped: out.dropped,
          failures: out.failures,
        }),
        runId,
        _out: out,
      };
    },
    (res) => {
      const budget = budgetUsed ?? Budget.for("handoff");
      const outcome: Outcome = res.error ? "failed" : res._out ? outcomeOf(res._out, steps, budget) : decideExit(steps, budget);
      return { outcome, steps, failure: outcome === "shipped" ? null : failure ?? firstFailure(steps) };
    },
  );
}

/**
 * Cross-meeting handoff. Statements come from each meeting's cache with their
 * segment ids namespaced ("M2:S007"), so one grounding context can span the
 * whole set and a citation can never drift to the wrong meeting.
 */
export async function runCrossHandoff(
  db: DatabaseSync,
  args: { handoffId: string; meetingIds?: string[]; refine?: string },
): Promise<HandoffResult> {
  const def = getHandoff(args.handoffId);
  if (!def) return { run: null, error: `unknown handoff "${args.handoffId}"` };

  const steps: StepRecord[] = [];
  let failure: Reason | null = null;
  let budgetUsed: Budget | null = null;
  const bail = (code: Parameters<typeof because>[0], msg: string) => {
    failure = because(code, msg);
    steps.push({ name: "cross-handoff:precondition", status: "failed", attempts: 1, ms: 0, reason: failure });
    return { run: null, error: msg };
  };

  return recordRun(
    db,
    {
      kind: "cross-handoff",
      meetingId: "",
      args: { handoffId: args.handoffId, meetingIds: args.meetingIds ?? null, refine: args.refine ?? null },
    },
    async (budget, runId): Promise<HandoffResult & { _out?: GroundedOutput<unknown> }> => {
      budgetUsed = budget;
      if (!modelConfigured())
        return { ...bail("model-unconfigured", "no model configured — set PYAI_API_KEY (or OPENAI_API_KEY)"), runId };

      const ids = args.meetingIds?.length ? args.meetingIds : customerMeetingIds(db);
      if (ids.length < 2) return { ...bail("no-transcript", "collating needs at least two meetings"), runId };

      const metas = ids.map((id) => meetingMeta(db, id)).filter((m): m is MeetingMeta => !!m && m.segments.length > 0);
      if (metas.length < 2) return { ...bail("no-transcript", "fewer than two of those meetings have transcripts"), runId };

      const { segments, aliasOf, idOf } = aliasSegments(metas.map((m) => ({ id: m.id, segments: m.segments })));
      const ctx = groundingContext({ segments, participants: metas.flatMap((m) => m.participants) });

      const statements: Statement[] = [];
      try {
        for (const m of metas) {
          const set = await ensureStatements(db, m, { budget, steps });
          const alias = aliasOf.get(m.id)!;
          // Same statements, namespaced ids. Extraction is never re-run for a collation.
          for (const f of set.statements) statements.push({ ...f, id: `${alias}${f.id}`, source: f.source.map((s) => `${alias}:${s}`) });
        }
      } catch (e) {
        failure = reasonFrom(e);
        steps.push({ name: "extract:statements", status: "failed", attempts: 1, ms: 0, reason: failure });
        return { run: null, error: publicReason(failure), runId };
      }
      if (!statements.length) return { ...bail("no-statements", "no grounded statements across those meetings"), runId };

      const roster = metas.map((m) => `${aliasOf.get(m.id)} = ${m.title} (${m.when})`).join("; ");
      const out = await compose(
        specOf(def, { participants: [...new Set(metas.flatMap((m) => m.participants))], type: "customer", roster }),
        statements,
        ctx,
        { budget, refine: args.refine },
      );
      steps.push(...out.steps);
      if (!out.value) {
        failure = firstFailure(out.steps) ?? because("crash", out.error ?? `${def.label} could not be generated`);
        return { run: null, error: out.error ?? `${def.label} could not be generated`, runId };
      }

      // Titles for rendering: the model only ever saw aliases.
      const titles: Record<string, string> = {};
      for (const [alias, id] of idOf) titles[alias] = metas.find((m) => m.id === id)?.title ?? id;
      const value = { ...(out.value as Record<string, unknown>), meetingTitles: titles };
      const markdown = def.toMarkdown(value, { title: "Customer feedback", when: new Date().toLocaleDateString() });
      return {
        run: insertHandoffRun(db, {
          meetingId: "",
          scopeIds: metas.map((m) => m.id),
          handoffId: def.id,
          value,
          markdown,
          promptVersion: out.promptVersion,
          needsReview: out.needsReview,
          dropped: out.dropped,
          failures: out.failures,
        }),
        runId,
        _out: out,
      };
    },
    (res) => {
      const budget = budgetUsed ?? Budget.for("cross-handoff");
      const outcome: Outcome = res.error ? "failed" : res._out ? outcomeOf(res._out, steps, budget) : decideExit(steps, budget);
      return { outcome, steps, failure: outcome === "shipped" ? null : failure ?? firstFailure(steps) };
    },
  );
}

/** Meetings whose type is customer-facing — the default input to a collation. */
export function customerMeetingIds(db: DatabaseSync, limit = 8): string[] {
  const rows = db
    .prepare(
      `SELECT id, mode, meeting_type FROM meetings
       WHERE EXISTS (SELECT 1 FROM utterances u WHERE u.meeting_id = meetings.id)
       ORDER BY started_at DESC LIMIT 40`,
    )
    .all() as { id: string; mode: string; meeting_type: string | null }[];
  return rows
    .filter((r) => meetingTypeOf(r.mode, r.meeting_type) === "customer")
    .slice(0, limit)
    .map((r) => r.id);
}

/** Bridge a HandoffDef into the generic ComposeSpec the two-pass runner takes. */
function specOf(
  def: HandoffDef<any>,
  vars: { participants: string[]; type: MeetingType; roster?: string },
) {
  return {
    purpose: `handoff:${def.id}`,
    promptVersion: promptRef(def.prompt),
    temperature: def.temperature,
    system: (statements: string) =>
      def.prompt.build({
        statements,
        participants: vars.participants.join(", ") || "unknown",
        type: vars.type,
        roster: vars.roster,
      }),
    user: `Produce the ${def.label} now. Return JSON only.`,
    parse: def.parse,
    validate: def.validate,
    prune: def.prune,
    finalize: def.finalize,
  };
}
