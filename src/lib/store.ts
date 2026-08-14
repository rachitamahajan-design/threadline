/**
 * Local-first persistence for grounded notes and handoffs.
 *
 * Two invariants this file exists to keep:
 *   1. Nothing a human typed is ever lost. Every write snapshots first, so
 *      Regenerate can be offered with a confirm and undone after the fact.
 *   2. A user edit is sticky. `edited` rides with the row, and regeneration has
 *      to be explicit about overwriting it (see /api/handoff/regenerate).
 */
import type { DatabaseSync } from "node:sqlite";
import { notesFromMarkdown, notesToMarkdown, type Notes } from "./outline.js";
import type { Failure } from "./grounding.js";
import type { Statement, StatementSet } from "../pipeline/statements.js";

// ── Extraction cache ────────────────────────────────────────────────────────

export function readStatements(db: DatabaseSync, meetingId: string): StatementSet | null {
  const row = db.prepare(`SELECT json, dropped, prompt_version FROM meeting_statements WHERE meeting_id = ?`).get(meetingId) as
    | { json: string; dropped: string | null; prompt_version: string }
    | undefined;
  if (!row) return null;
  try {
    return {
      statements: JSON.parse(row.json) as Statement[],
      dropped: row.dropped ? JSON.parse(row.dropped) : [],
      promptVersion: row.prompt_version,
    };
  } catch {
    return null;
  }
}

export function writeStatements(db: DatabaseSync, meetingId: string, set: StatementSet): void {
  db.prepare(
    `INSERT INTO meeting_statements (meeting_id, json, dropped, prompt_version, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(meeting_id) DO UPDATE SET json = excluded.json, dropped = excluded.dropped,
       prompt_version = excluded.prompt_version, created_at = excluded.created_at`,
  ).run(meetingId, JSON.stringify(set.statements), JSON.stringify(set.dropped), set.promptVersion, Date.now());
}

export function clearStatements(db: DatabaseSync, meetingId: string): void {
  db.prepare(`DELETE FROM meeting_statements WHERE meeting_id = ?`).run(meetingId);
}

// ── The notes outline ───────────────────────────────────────────────────────

export type StoredOutline = {
  notes: Notes;
  markdown: string;
  promptVersion: string;
  needsReview: boolean;
  dropped: number;
  edited: boolean;
  failures: Failure[];
  updatedAt: number;
};

export function readOutline(db: DatabaseSync, meetingId: string): StoredOutline | null {
  const row = db
    .prepare(
      `SELECT json, prompt_version, needs_review, dropped, edited, failures, updated_at
       FROM note_outlines WHERE meeting_id = ?`,
    )
    .get(meetingId) as
    | {
        json: string;
        prompt_version: string;
        needs_review: number;
        dropped: number;
        edited: number;
        failures: string | null;
        updated_at: number;
      }
    | undefined;
  if (!row) return null;
  try {
    const notes = JSON.parse(row.json) as Notes;
    return {
      notes,
      markdown: notesToMarkdown(notes),
      promptVersion: row.prompt_version,
      needsReview: !!row.needs_review,
      dropped: row.dropped,
      edited: !!row.edited,
      failures: row.failures ? (JSON.parse(row.failures) as Failure[]) : [],
      updatedAt: row.updated_at,
    };
  } catch {
    return null;
  }
}

export function writeOutline(
  db: DatabaseSync,
  meetingId: string,
  out: { notes: Notes; promptVersion: string; needsReview: boolean; dropped: number; failures: Failure[] },
  source: "generated" | "user" | "refine" | "regenerate",
): void {
  const previous = db.prepare(`SELECT json FROM note_outlines WHERE meeting_id = ?`).get(meetingId) as
    | { json: string }
    | undefined;
  if (previous) snapshotOutline(db, meetingId, previous.json, "user");
  const now = Date.now();
  const json = JSON.stringify(out.notes);
  db.prepare(
    `INSERT INTO note_outlines (meeting_id, json, prompt_version, needs_review, dropped, failures, edited, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT(meeting_id) DO UPDATE SET json = excluded.json, prompt_version = excluded.prompt_version,
       needs_review = excluded.needs_review, dropped = excluded.dropped, failures = excluded.failures,
       edited = 0, updated_at = excluded.updated_at`,
  ).run(meetingId, json, out.promptVersion, out.needsReview ? 1 : 0, out.dropped, JSON.stringify(out.failures), now, now);
  snapshotOutline(db, meetingId, json, source);
}

/**
 * A human edited the outline. Markdown in, tree out — the round-trip in
 * lib/outline.ts is what makes editing either representation safe.
 */
export function saveOutlineEdit(db: DatabaseSync, meetingId: string, markdown: string): StoredOutline | null {
  const current = readOutline(db, meetingId);
  if (!current) return null;
  snapshotOutline(db, meetingId, JSON.stringify(current.notes), "user");
  const notes = notesFromMarkdown(markdown);
  db.prepare(`UPDATE note_outlines SET json = ?, edited = 1, updated_at = ? WHERE meeting_id = ?`).run(
    JSON.stringify(notes),
    Date.now(),
    meetingId,
  );
  return readOutline(db, meetingId);
}

function snapshotOutline(db: DatabaseSync, meetingId: string, json: string, source: string): void {
  db.prepare(`INSERT INTO outline_versions (meeting_id, json, source, created_at) VALUES (?, ?, ?, ?)`).run(
    meetingId,
    json,
    source,
    Date.now(),
  );
}

// ── Handoff runs ────────────────────────────────────────────────────────────

export type StoredHandoff = {
  id: number;
  meetingId: string;
  scopeIds: string[] | null;
  handoffId: string;
  value: unknown;
  markdown: string;
  promptVersion: string;
  needsReview: boolean;
  dropped: number;
  failures: Failure[];
  edited: boolean;
  editedMarkdown: string | null;
  createdAt: number;
  updatedAt: number;
};

type HandoffRow = {
  id: number;
  meeting_id: string;
  scope_ids: string | null;
  handoff_id: string;
  json: string;
  markdown: string;
  prompt_version: string;
  needs_review: number;
  dropped: number;
  failures: string | null;
  edited: number;
  edited_markdown: string | null;
  created_at: number;
  updated_at: number;
};

const toStored = (r: HandoffRow): StoredHandoff => ({
  id: r.id,
  meetingId: r.meeting_id,
  scopeIds: r.scope_ids ? (JSON.parse(r.scope_ids) as string[]) : null,
  handoffId: r.handoff_id,
  value: JSON.parse(r.json),
  markdown: r.markdown,
  promptVersion: r.prompt_version,
  needsReview: !!r.needs_review,
  dropped: r.dropped,
  failures: r.failures ? (JSON.parse(r.failures) as Failure[]) : [],
  edited: !!r.edited,
  editedMarkdown: r.edited_markdown,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function insertHandoffRun(
  db: DatabaseSync,
  run: {
    meetingId: string;
    scopeIds?: string[] | null;
    handoffId: string;
    value: unknown;
    markdown: string;
    promptVersion: string;
    needsReview: boolean;
    dropped: number;
    failures: Failure[];
  },
): StoredHandoff {
  const now = Date.now();
  const r = db
    .prepare(
      `INSERT INTO handoff_runs (meeting_id, scope_ids, handoff_id, json, markdown, prompt_version,
         needs_review, dropped, failures, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      run.meetingId,
      run.scopeIds ? JSON.stringify(run.scopeIds) : null,
      run.handoffId,
      JSON.stringify(run.value),
      run.markdown,
      run.promptVersion,
      run.needsReview ? 1 : 0,
      run.dropped,
      JSON.stringify(run.failures),
      now,
      now,
    );
  return getHandoffRun(db, Number(r.lastInsertRowid))!;
}

export function getHandoffRun(db: DatabaseSync, id: number): StoredHandoff | null {
  const row = db.prepare(`SELECT * FROM handoff_runs WHERE id = ?`).get(id) as HandoffRow | undefined;
  return row ? toStored(row) : null;
}

/** Newest run per handoff for a meeting — the cards the chat log replays. */
export function listHandoffRuns(db: DatabaseSync, meetingId: string): StoredHandoff[] {
  const rows = db
    .prepare(`SELECT * FROM handoff_runs WHERE meeting_id = ? ORDER BY id ASC`)
    .all(meetingId) as HandoffRow[];
  return rows.map(toStored);
}

export function listCrossMeetingRuns(db: DatabaseSync, limit = 20): StoredHandoff[] {
  const rows = db
    .prepare(`SELECT * FROM handoff_runs WHERE meeting_id = '' ORDER BY id DESC LIMIT ?`)
    .all(limit) as HandoffRow[];
  return rows.map(toStored);
}

/** The user's own version of an output. Kept separately so Regenerate can offer it back. */
export function saveHandoffEdit(db: DatabaseSync, id: number, markdown: string): StoredHandoff | null {
  const existing = getHandoffRun(db, id);
  if (!existing) return null;
  db.prepare(`UPDATE handoff_runs SET edited = 1, edited_markdown = ?, updated_at = ? WHERE id = ?`).run(
    markdown,
    Date.now(),
    id,
  );
  return getHandoffRun(db, id);
}

export function deleteHandoffRun(db: DatabaseSync, id: number): void {
  db.prepare(`DELETE FROM handoff_runs WHERE id = ?`).run(id);
}
