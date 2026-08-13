/**
 * Projects canonical entities down into the legacy `nodes`/`edges` tables.
 *
 * Those two tables are now a DERIVED VIEW, not a source of truth. Keeping them
 * means the canvas in public/index.html and the backlinks self-join in
 * server/index.ts keep working with no changes — they just finally join on real
 * shared topics instead of on whoever attended every meeting.
 *
 * Edge DIRECTION is load-bearing and must not be "tidied": the backlink query
 * has one branch for shared `src` (person -> meeting) and one for shared `dst`
 * (meeting -> topic). Flipping either silently breaks it.
 */
import type { DatabaseSync } from "node:sqlite";
import { upsertNode, addEdge } from "../lib/db.js";
import type { StepRecord } from "../lib/harness.js";

type MentionRow = {
  entity_id: string;
  meeting_id: string;
  kind: string;
  label: string;
};

/** Rebuild nodes/edges for the given meetings (or all of them). */
export function projectGraph(db: DatabaseSync, meetingIds?: string[]): StepRecord {
  const ids =
    meetingIds ??
    (db.prepare("SELECT id FROM meetings").all() as { id: string }[]).map((r) => r.id);
  if (!ids.length) return { name: "graph:project", status: "skipped", attempts: 0, ms: 0, reason: "no meetings" };

  const started = Date.now();
  const place = ids.map(() => "?").join(",");
  const mentions = db
    .prepare(
      `SELECT m.entity_id, m.meeting_id, e.kind, e.label
       FROM entity_mentions m JOIN entities e ON e.id = m.entity_id
       WHERE m.gate = 'passed' AND e.merged_into IS NULL AND m.meeting_id IN (${place})`,
    )
    .all(...ids) as MentionRow[];

  db.exec("BEGIN");
  try {
    // Only the derived rows for these meetings are cleared, so `related` edges
    // (meeting_id '') and other meetings' evidence survive.
    const del = db.prepare("DELETE FROM edges WHERE meeting_id = ?");
    for (const id of ids) del.run(id);

    for (const id of ids) {
      const title = (db.prepare("SELECT title FROM meetings WHERE id = ?").get(id) as { title?: string } | undefined)?.title;
      if (title) upsertNode(db, "meeting", id);
    }

    for (const m of mentions) {
      // canonical: the entity's label is authoritative for its node.
      upsertNode(db, m.kind, m.label, { id: m.entity_id, canonical: true });
      if (m.kind === "person") addEdge(db, m.entity_id, m.meeting_id, "attended", m.meeting_id);
      else addEdge(db, m.meeting_id, m.entity_id, "mentions", m.meeting_id);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    return {
      name: "graph:project",
      status: "failed",
      attempts: 1,
      ms: Date.now() - started,
      reason: e instanceof Error ? e.message : String(e),
    };
  }

  return { name: "graph:project", status: "ok", attempts: 1, ms: Date.now() - started };
}
