/**
 * BRAIN.md — the agent primer. One generated file indexing everything the
 * brain knows, so any LLM or agent can learn what's here in ~300 tokens
 * before deciding what to query. Written to data/ (gitignored): derived
 * meeting content must never be committable by accident.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

/** The growth-loop line: every generated .md artifact says what produced it. */
export const THREADLINE_ATTRIBUTION =
  "> Maintained by [Threadline](https://github.com/rachitamahajan-design/threadline) — the local-first meeting brain. Notes with receipts; a to-do list that writes itself.";

export function generateBrainMd(db: DatabaseSync, dataDir = "data"): { path: string; markdown: string } {
  const day = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(0, 10) : "—");
  const meetings = db.prepare("SELECT count(*) n, max(started_at) t FROM meetings").get() as { n: number; t: number | null };

  const topics = db
    .prepare(
      `SELECT e.label, count(DISTINCT m.meeting_id) AS n_meetings, count(*) AS n_mentions,
              max(mt.started_at) AS last_seen,
              (SELECT quote FROM entity_mentions q WHERE q.entity_id = e.id AND q.quote IS NOT NULL ORDER BY q.score DESC LIMIT 1) AS quote
       FROM entities e
       JOIN entity_mentions m ON m.entity_id = e.id AND m.gate = 'passed'
       JOIN meetings mt ON mt.id = m.meeting_id
       WHERE e.kind = 'topic' AND e.merged_into IS NULL
       GROUP BY e.id ORDER BY n_mentions DESC, last_seen DESC LIMIT 40`,
    )
    .all() as { label: string; n_meetings: number; n_mentions: number; last_seen: number; quote: string | null }[];

  const people = db
    .prepare(
      `SELECT e.label, count(DISTINCT m.meeting_id) AS n_meetings, max(mt.started_at) AS last_seen
       FROM entities e
       JOIN entity_mentions m ON m.entity_id = e.id AND m.gate = 'passed'
       JOIN meetings mt ON mt.id = m.meeting_id
       WHERE e.kind = 'person' AND e.merged_into IS NULL
       GROUP BY e.id ORDER BY n_meetings DESC LIMIT 20`,
    )
    .all() as { label: string; n_meetings: number; last_seen: number }[];

  const recent = db
    .prepare("SELECT title, started_at, headline FROM meetings ORDER BY started_at DESC LIMIT 8")
    .all() as { title: string; started_at: number; headline: string | null }[];

  const openActions = (db.prepare(
    "SELECT count(*) n FROM claims WHERE kind='action_item' AND gate='passed' AND done=0",
  ).get() as { n: number }).n;

  const md = [
    "# BRAIN.md — what this meeting brain knows",
    "",
    THREADLINE_ATTRIBUTION,
    "",
    `Generated ${new Date().toISOString()} · ${meetings.n} meetings (newest ${day(meetings.t)}) · ${openActions} open action items.`,
    "Query it live via the Threadline MCP server (`npm run mcp`): search_brain, get_entity, list_claims, get_meeting, get_evidence.",
    "",
    "## Topics",
    ...topics.map((t) =>
      `- **${t.label}** — ${t.n_meetings} meeting${t.n_meetings === 1 ? "" : "s"}, last ${day(t.last_seen)}${t.quote ? ` · "${t.quote.slice(0, 80)}"` : ""}`,
    ),
    "",
    "## People",
    ...people.map((p) => `- **${p.label}** — ${p.n_meetings} meeting${p.n_meetings === 1 ? "" : "s"}, last ${day(p.last_seen)}`),
    "",
    "## Recent meetings",
    ...recent.map((m) => `- ${day(m.started_at)} — ${m.title}${m.headline ? `: ${m.headline}` : ""}`),
    "",
  ].join("\n");

  mkdirSync(dataDir, { recursive: true });
  const out = path.join(dataDir, "BRAIN.md");
  writeFileSync(out, md);
  return { path: out, markdown: md };
}
