/**
 * Running things: the orchestration the server calls.
 *
 *   ensureFacts     pass 1, cached per meeting (every handoff shares it)
 *   ensureNotes     the always-on themed outline
 *   runHandoff      one handoff, on demand, for one meeting
 *   runCrossHandoff one handoff across N meetings (collated feedback)
 *
 * Nothing in here runs by itself. `ensureNotes` is called when a transcript
 * lands; handoffs are called only from an explicit user action.
 */
import type { DatabaseSync } from "node:sqlite";
import { Budget } from "../lib/harness.js";
import { groundingContext, type GroundingContext } from "../lib/grounding.js";
import { modelConfigured } from "../lib/model.js";
import {
  loadSegments,
  meetingTypeOf,
  participantsOf,
  type MeetingType,
  type Segment,
} from "../lib/segments.js";
import {
  insertHandoffRun,
  readFacts,
  readOutline,
  writeFacts,
  writeOutline,
  type StoredHandoff,
  type StoredOutline,
} from "../lib/store.js";
import { extractFacts, type Fact, type FactSet } from "./facts.js";
import { compose } from "./grounded.js";
import { generateNotes, memoryContext } from "./notes-outline.js";
import { spotcheckEnabled, spotcheckNotes } from "./entail.js";
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

/** Pass 1, once per meeting. Cheap on repeat, identical facts for every handoff. */
export async function ensureFacts(db: DatabaseSync, m: MeetingMeta, opts: { force?: boolean } = {}): Promise<FactSet> {
  if (!opts.force) {
    const cached = readFacts(db, m.id);
    if (cached) return cached;
  }
  const set = await extractFacts(m.segments, m.ctx, { type: m.type, participants: m.participants });
  writeFacts(db, m.id, set);
  return set;
}

/**
 * The always-on notes. Returns the stored outline, generating it if this
 * meeting has none. A user-edited outline is never regenerated implicitly.
 */
export async function ensureNotes(
  db: DatabaseSync,
  meetingId: string,
  opts: { force?: boolean; refine?: string; budget?: Budget; hints?: string } = {},
): Promise<{ outline: StoredOutline | null; error?: string }> {
  const existing = readOutline(db, meetingId);
  if (existing && !opts.force && !opts.refine) return { outline: existing };
  const m = meetingMeta(db, meetingId);
  if (!m) return { outline: null, error: "meeting not found" };
  if (!m.segments.length) return { outline: null, error: "no transcript yet" };
  if (!modelConfigured()) return { outline: existing, error: "no model configured — set PYAI_API_KEY (or OPENAI_API_KEY)" };

  const budget = opts.budget ?? new Budget(12, 150_000);
  const facts = await ensureFacts(db, m);
  const out = await generateNotes(facts.facts, m.ctx, {
    type: m.type,
    participants: m.participants,
    memory: memoryContext(db, meetingId),
    // The founder's rough notes steer emphasis and theme naming. They are not
    // a transcript, so the validators still refuse to let them source anything.
    hints: opts.hints?.trim() ? opts.hints.trim().slice(0, 4000) : undefined,
    budget,
    refine: opts.refine,
  });
  if (!out.value) return { outline: existing, error: out.error ?? "notes could not be generated" };
  // Advisory only, and off by default: doubted leaves get a quiet marker, never
  // a deletion. See pipeline/entail.ts for why.
  if (spotcheckEnabled()) await spotcheckNotes(out.value, m.ctx);
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
  return { outline: readOutline(db, meetingId) };
}

// ── Handoffs ────────────────────────────────────────────────────────────────

export type HandoffResult = { run: StoredHandoff | null; error?: string };

export async function runHandoff(
  db: DatabaseSync,
  args: { meetingId: string; handoffId: string; refine?: string },
): Promise<HandoffResult> {
  const def = getHandoff(args.handoffId);
  if (!def) return { run: null, error: `unknown handoff "${args.handoffId}"` };
  if (def.scope === "cross-meeting")
    return { run: null, error: `${def.label} runs across meetings — call /api/handoff/cross instead` };
  const m = meetingMeta(db, args.meetingId);
  if (!m) return { run: null, error: "meeting not found" };
  if (!m.segments.length) return { run: null, error: "no transcript yet" };
  if (!modelConfigured()) return { run: null, error: "no model configured — set PYAI_API_KEY (or OPENAI_API_KEY)" };

  const budget = new Budget(12, 150_000);
  const facts = await ensureFacts(db, m);
  if (!facts.facts.length)
    return { run: null, error: "nothing in this transcript survived extraction — there is nothing to hand off" };

  const out = await compose(specOf(def, { facts: "", participants: m.participants, type: m.type }), facts.facts, m.ctx, {
    budget,
    refine: args.refine,
  });
  if (!out.value) return { run: null, error: out.error ?? `${def.label} could not be generated` };

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
  };
}

/**
 * Cross-meeting handoff. Facts come from each meeting's cache with their segment
 * ids namespaced ("M2:S007"), so one grounding context can span the whole set
 * and a citation can never drift to the wrong meeting.
 */
export async function runCrossHandoff(
  db: DatabaseSync,
  args: { handoffId: string; meetingIds?: string[]; refine?: string },
): Promise<HandoffResult> {
  const def = getHandoff(args.handoffId);
  if (!def) return { run: null, error: `unknown handoff "${args.handoffId}"` };
  if (!modelConfigured()) return { run: null, error: "no model configured — set PYAI_API_KEY (or OPENAI_API_KEY)" };

  const ids = args.meetingIds?.length ? args.meetingIds : customerMeetingIds(db);
  if (ids.length < 2) return { run: null, error: "collating needs at least two meetings" };

  const metas = ids.map((id) => meetingMeta(db, id)).filter((m): m is MeetingMeta => !!m && m.segments.length > 0);
  if (metas.length < 2) return { run: null, error: "fewer than two of those meetings have transcripts" };

  const { segments, aliasOf, idOf } = aliasSegments(metas.map((m) => ({ id: m.id, segments: m.segments })));
  const ctx = groundingContext({ segments, participants: metas.flatMap((m) => m.participants) });

  const facts: Fact[] = [];
  for (const m of metas) {
    const set = await ensureFacts(db, m);
    const alias = aliasOf.get(m.id)!;
    // Same facts, namespaced ids. Extraction is never re-run for a collation.
    for (const f of set.facts) facts.push({ ...f, id: `${alias}${f.id}`, source: f.source.map((s) => `${alias}:${s}`) });
  }
  if (!facts.length) return { run: null, error: "no grounded facts across those meetings" };

  const roster = metas.map((m) => `${aliasOf.get(m.id)} = ${m.title} (${m.when})`).join("; ");
  const out = await compose(
    specOf(def, { facts: "", participants: [...new Set(metas.flatMap((m) => m.participants))], type: "customer", roster }),
    facts,
    ctx,
    { budget: new Budget(16, 180_000), refine: args.refine },
  );
  if (!out.value) return { run: null, error: out.error ?? `${def.label} could not be generated` };

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
  };
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
  vars: { facts: string; participants: string[]; type: MeetingType; roster?: string },
) {
  return {
    purpose: `handoff:${def.id}`,
    promptVersion: promptRef(def.prompt),
    temperature: def.temperature,
    system: (facts: string) =>
      def.prompt.build({
        facts,
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
