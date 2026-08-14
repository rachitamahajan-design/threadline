/**
 * The always-on output: a themed outline of the meeting.
 *
 * Notes are not a handoff. They generate themselves as soon as a transcript
 * exists, they are the first thing on the page, and they are editable in place.
 * Everything here is the compose half of the two-pass pipeline; the guarantees
 * come from lib/grounding.ts and the pruning below.
 */
import type { DatabaseSync } from "node:sqlite";
import { NOTES_COMPOSE, promptRef } from "../lib/prompts.js";
import { markNotesConfidence, validateNotes, type Failure, type GroundingContext } from "../lib/grounding.js";
import {
  bulletAtPath,
  countLeaves,
  dedupeLeaves,
  isLeaf,
  normalizeSections,
  rebuildNotes,
  validateNotesShape,
  type NoteBullet,
  type Notes,
} from "../lib/outline.js";
import type { MeetingType } from "../lib/segments.js";
import { because } from "../lib/reasons.js";
import { compose, type GroundedOutput } from "./grounded.js";
import type { Statement } from "./statements.js";
import type { Budget } from "../lib/harness.js";

/** Rules whose failure makes a LEAF unshippable. */
const LEAF_KILLERS: Failure["rule"][] = [
  "leaf-sourced",
  "source-exists",
  "no-memory-source",
  "verbatim-number",
  "exact-quote",
  "entailment-unsupported",
];

export function notesSpec(opts: {
  type: MeetingType;
  participants: string[];
  memory?: string;
  hints?: string;
}) {
  return {
    purpose: "notes",
    promptVersion: promptRef(NOTES_COMPOSE),
    temperature: 0.1,
    system: (statements: string) =>
      NOTES_COMPOSE.build({
        participants: opts.participants.join(", ") || "unknown",
        type: opts.type,
        statements,
        memory: opts.memory,
        hints: opts.hints,
      }),
    user: 'Write the themed outline first, then the summary. Return {"themes": [...], "summary": {...}} and nothing else.',
    parse: (raw: unknown): Notes | string => {
      const errors = validateNotesShape(raw);
      if (errors.length) return errors.slice(0, 6).join("; ");
      const r = raw as Notes;
      // Sections are forced into the fixed readout order here rather than in
      // finalize, so the section-scoped checks (owners under "Action items")
      // judge the structure the reader will actually get.
      return normalizeSections({ ...(r.summary?.text ? { summary: r.summary } : {}), themes: r.themes });
    },
    validate: (notes: Notes, ctx: GroundingContext) => validateNotes(notes, ctx),
    prune: (notes: Notes, failures: Failure[], _ctx: GroundingContext) => repairNotes(notes, failures),
    finalize: (notes: Notes, ctx: GroundingContext) => {
      // Order matters: merge duplicates first so the surviving bullet's
      // confidence is computed from the union of its sources.
      dedupeLeaves(notes);
      markNotesConfidence(notes, ctx);
    },
  };
}

/**
 * Turn validator failures into tree surgery: kill unsupported leaves, flatten
 * headers that asserted something their children never carried. Paths are
 * resolved to nodes first, because every removal invalidates the paths after it.
 */
export function repairNotes(notes: Notes, failures: Failure[]): { value: Notes; dropped: number } {
  const badLeaves = new Set<NoteBullet>();
  const badLabels = new Set<NoteBullet>();
  let dropSummary = false;
  for (const f of failures) {
    if (f.path === "summary") {
      // A summary we cannot verify is removed, not softened. The outline below
      // it is still worth reading; a made-up overview is not.
      dropSummary = true;
      continue;
    }
    const node = bulletAtPath(notes, f.path);
    if (!node) continue;
    if (isLeaf(node)) {
      if (LEAF_KILLERS.includes(f.rule)) badLeaves.add(node);
    } else {
      badLabels.add(node);
    }
  }
  const out = rebuildNotes(notes, {
    dropLeaf: (b) => badLeaves.has(b),
    flattenLabel: (b) => badLabels.has(b),
  });
  const value: Notes = dropSummary || !notes.summary ? { themes: out.notes.themes } : { summary: notes.summary, themes: out.notes.themes };
  return { value, dropped: out.dropped + (dropSummary ? 1 : 0) };
}

export async function generateNotes(
  statements: Statement[],
  ctx: GroundingContext,
  opts: {
    type: MeetingType;
    participants: string[];
    memory?: string;
    hints?: string;
    budget?: Budget;
    refine?: string;
  },
): Promise<GroundedOutput<Notes>> {
  // No statements means the transcript carried nothing extractable. That is a
  // real answer: an empty outline beats a model asked to fill a page from nothing.
  if (!statements.length)
    return {
      value: { themes: [] },
      needsReview: true,
      failures: [],
      dropped: 0,
      attempts: 0,
      promptVersion: promptRef(NOTES_COMPOSE),
      steps: [
        {
          name: "compose:notes",
          status: "skipped",
          attempts: 0,
          ms: 0,
          reason: because("no-statements", "no grounded statements to compose from"),
        },
      ],
    };
  return compose(notesSpec(opts), statements, ctx, { budget: opts.budget, refine: opts.refine });
}

/**
 * Memory for LABELS ONLY: names of threads and topics this meeting already
 * links to. It never carries segment ids, so lib/grounding.ts cannot accept it
 * as a source even if the model tries — the structure forbids it.
 */
export function memoryContext(db: DatabaseSync, meetingId: string, limit = 8): string | undefined {
  const rows = db
    .prepare(
      `SELECT DISTINCT e.label FROM entity_mentions em
       JOIN entities e ON e.id = em.entity_id
       WHERE em.meeting_id != ? AND em.gate = 'passed' AND e.kind = 'topic'
         AND em.entity_id IN (SELECT entity_id FROM entity_mentions WHERE meeting_id = ?)
       LIMIT ?`,
    )
    .all(meetingId, meetingId, limit) as { label: string }[];
  if (!rows.length) return undefined;
  return JSON.stringify(rows.map((r) => ({ label: r.label, fromMemory: true })));
}

export function notesStats(notes: Notes | null) {
  if (!notes) return { themes: 0, leaves: 0 };
  return { themes: notes.themes.length, leaves: countLeaves(notes) };
}
