/**
 * Hybrid retrieval across every meeting.
 *
 * Two arms, fused by weighted Reciprocal Rank Fusion:
 *   L — FTS5/BM25 over chunks (porter-stemmed, exact-ish language)
 *   G — the canonical entity graph: query terms resolve to entities (aliases
 *       included), hop one `related` edge, then return the chunks around each
 *       mention's receipt. This is what answers "Q4 board" when the meeting
 *       only ever said "the board deck".
 *
 * RRF fuses ordinal ranks, not scores — BM25 is unbounded-negative and drifts
 * with corpus size, graph relevance is a count; ranks are the only comparable
 * currency. K=60 per the original RRF paper: corroboration across arms beats
 * a single confident arm. A missing arm simply contributes nothing.
 */
import type { DatabaseSync } from "node:sqlite";
import { normalize } from "../lib/harness.js";

export type Snippet = {
  chunk_id: number;
  meeting_id: string;
  meeting_title: string;
  started_at: number;
  kind: string;
  text: string;
  speakers: string | null;
  offset_s: number;
  score: number;
  arms: string[];
};

const K = 60;
const W = { lex: 1.0, graph: 0.6 };
const STOP = new Set(
  "which what who when where why how did does do is are was were the a an of to for and or in on at by with from that this these those we i you it they meetings meeting discussed discuss talk talked about".split(" "),
);

const terms = (q: string) => normalize(q).split(" ").filter((w) => w.length >= 2 && !STOP.has(w));

/** AND-with-prefix first for precision, OR fallback for recall. */
function ftsArm(db: DatabaseSync, q: string, limit = 60): number[] {
  const ts = terms(q);
  if (!ts.length) return [];
  const run = (match: string) => {
    try {
      return (db
        .prepare(`SELECT rowid FROM chunk_fts WHERE chunk_fts MATCH ? ORDER BY bm25(chunk_fts, 10.0, 2.0) LIMIT ?`)
        .all(match, limit) as { rowid: number }[]).map((r) => r.rowid);
    } catch {
      return [];
    }
  };
  const quoted = ts.map((t, i) => (i === ts.length - 1 ? `"${t}"*` : `"${t}"`));
  const strict = run(quoted.join(" AND "));
  return strict.length ? strict : run(ts.map((t) => `"${t}"`).join(" OR "));
}

/** Query -> entities (via aliases) -> one related hop -> chunks near receipts. */
function graphArm(db: DatabaseSync, q: string, limit = 60): number[] {
  const ts = terms(q);
  if (!ts.length) return [];
  const like = ts.map(() => "a.norm LIKE '%' || ? || '%'").join(" OR ");
  const seeds = (db
    .prepare(`SELECT DISTINCT e.id FROM entity_aliases a JOIN entities e ON e.id = a.entity_id WHERE e.merged_into IS NULL AND (${like})`)
    .all(...ts) as { id: string }[]).map((r) => r.id);
  if (!seeds.length) return [];

  const ph = seeds.map(() => "?").join(",");
  const hop = (db
    .prepare(`SELECT DISTINCT dst FROM edges WHERE kind='related' AND src IN (${ph})`)
    .all(...seeds) as { dst: string }[]).map((r) => r.dst);
  const all = [...new Set([...seeds, ...hop])];

  // Mentions ordered by evidence strength (seed entities before related ones),
  // then map each receipt to the window chunk covering its offset.
  const ph2 = all.map(() => "?").join(",");
  const mentions = db
    .prepare(
      `SELECT m.meeting_id, m.offset_s, (m.entity_id IN (${ph})) AS is_seed
       FROM entity_mentions m WHERE m.gate='passed' AND m.entity_id IN (${ph2})
       ORDER BY is_seed DESC LIMIT 80`,
    )
    .all(...seeds, ...all) as { meeting_id: string; offset_s: number | null }[];

  const out: number[] = [];
  const seen = new Set<number>();
  const near = db.prepare(
    `SELECT id FROM chunks WHERE meeting_id = ? AND kind='window' AND start_offset_s <= ? AND end_offset_s >= ?
     ORDER BY (end_offset_s - start_offset_s) LIMIT 1`,
  );
  const first = db.prepare(`SELECT id FROM chunks WHERE meeting_id = ? AND kind='window' ORDER BY src_id LIMIT 1`);
  for (const m of mentions) {
    const row = (m.offset_s != null ? near.get(m.meeting_id, m.offset_s, m.offset_s) : null) ?? first.get(m.meeting_id);
    const id = (row as { id: number } | undefined)?.id;
    if (id && !seen.has(id)) { seen.add(id); out.push(id); }
    if (out.length >= limit) break;
  }
  return out;
}

export function retrieve(db: DatabaseSync, q: string, topN = 12): Snippet[] {
  const arms: Record<string, number[]> = { lex: ftsArm(db, q), graph: graphArm(db, q) };

  const fused = new Map<number, { score: number; arms: string[] }>();
  for (const [arm, ids] of Object.entries(arms))
    ids.forEach((id, rank) => {
      const cur = fused.get(id) ?? { score: 0, arms: [] };
      cur.score += (W as Record<string, number>)[arm] / (K + rank + 1);
      cur.arms.push(arm);
      fused.set(id, cur);
    });
  if (!fused.size) return [];

  const ph = [...fused.keys()].map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT c.id, c.meeting_id, c.kind, c.text, c.speakers, c.start_offset_s, m.title, m.started_at
       FROM chunks c JOIN meetings m ON m.id = c.meeting_id WHERE c.id IN (${ph})`,
    )
    .all(...fused.keys()) as {
    id: number; meeting_id: string; kind: string; text: string; speakers: string | null;
    start_offset_s: number; title: string; started_at: number;
  }[];

  const snippets: Snippet[] = rows.map((r) => {
    const f = fused.get(r.id)!;
    // Weak recency prior: breaks ties toward recent, can't bury a relevant old meeting.
    const ageDays = Math.max(0, (Date.now() - r.started_at) / 86_400_000);
    return {
      chunk_id: r.id, meeting_id: r.meeting_id, meeting_title: r.title, started_at: r.started_at,
      kind: r.kind, text: r.text, speakers: r.speakers, offset_s: r.start_offset_s,
      score: f.score * (1 + 0.15 * Math.exp(-ageDays / 180)), arms: f.arms,
    };
  });

  // Per-meeting cap of 3 so one long meeting can't flood a cross-meeting answer.
  snippets.sort((a, b) => b.score - a.score);
  const perMeeting = new Map<string, number>();
  const out: Snippet[] = [];
  for (const s of snippets) {
    const n = perMeeting.get(s.meeting_id) ?? 0;
    if (n >= 3) continue;
    perMeeting.set(s.meeting_id, n + 1);
    out.push(s);
    if (out.length >= topN) break;
  }
  return out;
}
