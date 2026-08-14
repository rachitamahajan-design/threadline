/**
 * Rebuild the brain from what is already on disk. No API calls, no keys —
 * claims are stored as JSON, so candidates can be re-derived and re-resolved
 * offline. Idempotent: run it as often as you like.
 *
 *   npm run rebuild-brain
 */
import { openDb } from "../lib/db.js";
import { candidates, curateTopics } from "../pipeline/candidates.js";
import { modelConfigured } from "../lib/model.js";
import { resolveCandidates, storeResolutions, relateEntities } from "../pipeline/resolve.js";
import { projectGraph } from "../pipeline/project.js";
import { indexMeeting } from "../pipeline/chunker.js";
import { groundedIn } from "../lib/harness.js";
import type { RecapRecord, Utterance } from "../lib/pyai.js";

const db = openDb();

type ClaimRow = { kind: string; body: string; offset_s: number | null; quote: string | null };

/** Rebuild a RecapRecord-shaped object from stored claims. */
function recFromClaims(rows: ClaimRow[]): RecapRecord {
  const rec: RecapRecord = { key_decisions: [], action_items: [], coverage_gaps: [], risk_signals: [] };
  for (const r of rows) {
    const body = JSON.parse(r.body);
    if (r.kind === "decision") rec.key_decisions!.push(body.text ?? r.quote ?? "");
    else if (r.kind === "action_item") rec.action_items!.push(body);
    else if (r.kind === "risk") rec.risk_signals!.push(body);
  }
  return rec;
}

// Start from a clean canonical layer — this is a rebuild, not an append.
db.exec("BEGIN");
db.exec("DELETE FROM entity_mentions; DELETE FROM entity_aliases; DELETE FROM entities;");
db.exec("DELETE FROM edges;"); // fully derived; re-projected below
db.exec("DELETE FROM nodes WHERE kind = 'topic';"); // stale labels would otherwise survive as orphans
db.exec("COMMIT");

const meetings = db.prepare("SELECT id, title FROM meetings").all() as { id: string; title: string }[];
let totalPassed = 0, totalBlocked = 0;

for (const m of meetings) {
  const utterances = db
    .prepare("SELECT speaker, speaker_role, text, offset_s, duration_s FROM utterances WHERE meeting_id = ? ORDER BY idx")
    .all(m.id) as Utterance[];
  const claims = db
    .prepare("SELECT kind, body, offset_s, quote FROM claims WHERE meeting_id = ? AND gate = 'passed'")
    .all(m.id) as ClaimRow[];

  const rec = recFromClaims(claims);
  // LLM curation runs when a key is around; without one the deterministic
  // gates still hold and the rebuild stays fully offline.
  const cands = modelConfigured()
    ? await curateTopics(candidates(utterances, rec), m.title)
    : candidates(utterances, rec);
  const gate = groundedIn(utterances);
  const hasProof = (c: { quote?: string; offset_s?: number }) =>
    gate({ quote: c.quote, offset_s: c.offset_s }) === null;

  const res = storeResolutions(db, m.id, resolveCandidates(db, cands), hasProof);
  totalPassed += res.passed;
  totalBlocked += res.blocked;
  console.log(`▶ ${m.title}: ${res.passed} mentions, ${res.blocked} blocked`);
}

// Project first: `related` edges reference entity nodes, which projection creates.
const proj = projectGraph(db);
const rel = relateEntities(db);
console.log(`\nprojection: ${proj.status} · related pairs: ${rel.pairs}`);

// Rebuild retrieval chunks + legacy FTS (fixes historical duplication).
for (const m of meetings) {
  indexMeeting(db, m.id);
  db.exec("BEGIN");
  db.prepare("DELETE FROM search WHERE meeting_id = ?").run(m.id);
  const meta = db.prepare("SELECT title, summary FROM meetings WHERE id = ?").get(m.id) as { title: string; summary: string | null };
  const ins = db.prepare("INSERT INTO search (meeting_id, kind, text) VALUES (?, ?, ?)");
  ins.run(m.id, "summary", `${meta.title} ${meta.summary ?? ""}`);
  for (const u of db.prepare("SELECT text FROM utterances WHERE meeting_id = ? ORDER BY idx").all(m.id) as { text: string }[])
    ins.run(m.id, "utterance", u.text);
  db.exec("COMMIT");
}

const ents = db.prepare("SELECT kind, count(*) n FROM entities WHERE merged_into IS NULL GROUP BY kind").all() as { kind: string; n: number }[];
console.log(`\n══ BRAIN ═══════════════════════════════`);
for (const e of ents) console.log(`  ${e.kind}: ${e.n}`);
console.log(`  mentions: ${totalPassed} passed, ${totalBlocked} blocked`);

// The proof query: topics known to span meetings.
const spanning = db
  .prepare(
    `SELECT e.label, count(DISTINCT m.meeting_id) n FROM entities e
     JOIN entity_mentions m ON m.entity_id = e.id AND m.gate = 'passed'
     WHERE e.kind = 'topic' AND e.merged_into IS NULL
     GROUP BY e.id HAVING n >= 2 ORDER BY n DESC`,
  )
  .all() as { label: string; n: number }[];
console.log(`\n  topics spanning ≥2 meetings: ${spanning.length}`);
for (const s of spanning) console.log(`    ⊕ ${s.label} (${s.n} meetings)`);
