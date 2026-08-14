/**
 * Read-only queries backing the MCP tools. Evidence, not transcripts: every
 * row that leaves here carries its receipt (quote and/or offset), and nothing
 * returns bulk verbatim transcript.
 */
import type { DatabaseSync } from "node:sqlite";
import { normalize } from "../lib/harness.js";

export function brainCounts(db: DatabaseSync) {
  const one = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    meetings: one("SELECT count(*) n FROM meetings"),
    entities: one("SELECT count(*) n FROM entities WHERE merged_into IS NULL"),
    claims: one("SELECT count(*) n FROM claims WHERE gate = 'passed'"),
    chunks: one("SELECT count(*) n FROM chunks"),
    newest_meeting:
      (db.prepare("SELECT max(started_at) t FROM meetings").get() as { t: number | null }).t ?? null,
  };
}

export function listClaims(
  db: DatabaseSync,
  opts: { kind?: string; open_only?: boolean; since_ms?: number; limit?: number },
) {
  const kind = ["decision", "action_item", "risk", "moment", "objection"].includes(opts.kind ?? "")
    ? opts.kind
    : "action_item";
  const rows = db
    .prepare(
      `SELECT c.body, c.quote, c.offset_s, c.done, m.id AS meeting_id, m.title, m.started_at
       FROM claims c JOIN meetings m ON m.id = c.meeting_id
       WHERE c.kind = ? AND c.gate = 'passed'
         ${opts.open_only ? "AND c.done = 0" : ""}
         ${opts.since_ms ? "AND m.started_at >= ?" : ""}
       ORDER BY m.started_at DESC LIMIT ?`,
    )
    .all(...([kind, ...(opts.since_ms ? [opts.since_ms] : []), opts.limit ?? 50] as (string | number)[])) as {
    body: string; quote: string | null; offset_s: number | null; done: number;
    meeting_id: string; title: string; started_at: number;
  }[];
  return rows.map((r) => {
    const body = JSON.parse(r.body) as Record<string, string | null>;
    return {
      kind,
      text: body.task ?? body.text ?? body.description ?? r.quote ?? "",
      owner: body.owner ?? null,
      due: body.due ?? null,
      done: !!r.done,
      receipt: { quote: r.quote, offset_s: r.offset_s, meeting_id: r.meeting_id, meeting_title: r.title },
      meeting_date: new Date(r.started_at).toISOString().slice(0, 10),
    };
  });
}

/** Entity by id or fuzzy name — aliases, receipted mentions, related topics. */
export function getEntity(db: DatabaseSync, nameOrId: string) {
  const norm = normalize(nameOrId);
  const ent =
    (db.prepare("SELECT * FROM entities WHERE id = ? AND merged_into IS NULL").get(nameOrId) as
      | Record<string, unknown>
      | undefined) ??
    (db
      .prepare(
        `SELECT e.* FROM entity_aliases a JOIN entities e ON e.id = a.entity_id
         WHERE e.merged_into IS NULL AND a.norm = ? LIMIT 1`,
      )
      .get(norm) as Record<string, unknown> | undefined) ??
    (db
      .prepare(
        `SELECT e.* FROM entity_aliases a JOIN entities e ON e.id = a.entity_id
         WHERE e.merged_into IS NULL AND a.norm LIKE '%' || ? || '%'
         ORDER BY length(a.norm) LIMIT 1`,
      )
      .get(norm) as Record<string, unknown> | undefined);
  if (!ent) return null;
  const id = ent.id as string;
  const aliases = db
    .prepare("SELECT alias, matcher, score FROM entity_aliases WHERE entity_id = ?")
    .all(id);
  const mentions = db
    .prepare(
      `SELECT m.surface, m.quote, m.offset_s, m.meeting_id, mt.title, mt.started_at
       FROM entity_mentions m JOIN meetings mt ON mt.id = m.meeting_id
       WHERE m.entity_id = ? AND m.gate = 'passed' ORDER BY mt.started_at DESC`,
    )
    .all(id);
  const related = db
    .prepare(
      `SELECT n.id, n.label FROM edges e JOIN nodes n ON n.id = e.dst
       WHERE e.kind = 'related' AND e.src = ?`,
    )
    .all(id);
  return { id, kind: ent.kind, label: ent.label, aliases, mentions, related };
}

/** Other meetings sharing a node or one related hop — the backlinks join. */
export function backlinks(db: DatabaseSync, meetingId: string) {
  return db
    .prepare(
      `SELECT DISTINCT m.id, m.title, n.label AS via FROM edges e1
       JOIN edges e2 ON e1.src = e2.src AND e2.meeting_id != e1.meeting_id
       JOIN meetings m ON m.id = e2.meeting_id JOIN nodes n ON n.id = e1.src
       WHERE e1.meeting_id = ?
       UNION
       SELECT DISTINCT m.id, m.title, n.label AS via FROM edges e1
       JOIN edges e2 ON e1.dst = e2.dst AND e2.meeting_id != e1.meeting_id
       JOIN meetings m ON m.id = e2.meeting_id JOIN nodes n ON n.id = e1.dst
       WHERE e1.meeting_id = ? AND n.kind != 'meeting'
       UNION
       SELECT DISTINCT m.id, m.title, n1.label || ' ~ ' || n2.label AS via FROM edges e1
       JOIN edges r ON r.src = e1.dst AND r.kind = 'related'
       JOIN edges e2 ON e2.dst = r.dst AND e2.kind = 'mentions' AND e2.meeting_id != e1.meeting_id
       JOIN meetings m ON m.id = e2.meeting_id
       JOIN nodes n1 ON n1.id = e1.dst JOIN nodes n2 ON n2.id = r.dst
       WHERE e1.meeting_id = ? AND e1.kind = 'mentions'`,
    )
    .all(meetingId, meetingId, meetingId);
}

export function listMeetings(db: DatabaseSync, opts: { limit?: number; since_ms?: number }) {
  return db
    .prepare(
      `SELECT m.id, m.title, m.mode, m.started_at, m.duration_s, m.headline,
        (SELECT count(*) FROM claims c WHERE c.meeting_id = m.id AND c.kind='decision' AND c.gate='passed') AS decisions,
        (SELECT count(*) FROM claims c WHERE c.meeting_id = m.id AND c.kind='action_item' AND c.gate='passed') AS action_items,
        (SELECT group_concat(DISTINCT speaker) FROM utterances u WHERE u.meeting_id = m.id AND speaker IS NOT NULL) AS participants
       FROM meetings m ${opts.since_ms ? "WHERE m.started_at >= ?" : ""}
       ORDER BY m.started_at DESC LIMIT ?`,
    )
    .all(...([...(opts.since_ms ? [opts.since_ms] : []), opts.limit ?? 20] as number[]));
}
