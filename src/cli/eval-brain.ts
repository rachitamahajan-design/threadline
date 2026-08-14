/**
 * Eval for canonicalization — the project's first test. Run after
 * `npm run rebuild-brain`; prints pass/fail against a hand-labelled gold set
 * drawn from samples/meetings.json, so threshold changes are measurable
 * rather than vibes.
 *
 *   npm run eval-brain
 */
import { openDb } from "../lib/db.js";
import { similarity } from "../pipeline/resolve.js";

const db = openDb();
let pass = 0, fail = 0;
const check = (ok: boolean, name: string, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

const SAMPLES = "meeting_sample_%";

// ── 1. Cross-meeting joins that must exist (same entity OR related hop) ──
const joined = (a: string, b: string, likeA: string, likeB: string): string | null => {
  const same = db.prepare(
    `SELECT e.label FROM entities e
     JOIN entity_mentions m1 ON m1.entity_id = e.id AND m1.meeting_id = ? AND m1.gate='passed'
     JOIN entity_mentions m2 ON m2.entity_id = e.id AND m2.meeting_id = ? AND m2.gate='passed'
     WHERE e.label LIKE ? OR e.label LIKE ?`,
  ).get(a, b, likeA, likeB) as { label: string } | undefined;
  if (same) return `one entity: ${same.label}`;
  const related = db.prepare(
    `SELECT n1.label l1, n2.label l2 FROM edges r
     JOIN edges e1 ON e1.dst = r.src AND e1.kind='mentions' AND e1.meeting_id = ?
     JOIN edges e2 ON e2.dst = r.dst AND e2.kind='mentions' AND e2.meeting_id = ?
     JOIN nodes n1 ON n1.id = r.src JOIN nodes n2 ON n2.id = r.dst
     WHERE r.kind='related' AND (n1.label LIKE ? OR n2.label LIKE ?)`,
  ).get(a, b, likeA, likeB) as { l1: string; l2: string } | undefined;
  return related ? `related: ${related.l1} ~ ${related.l2}` : null;
};

const K = "meeting_sample_kickoff", I = "meeting_sample_investor", S = "meeting_sample_sharon_1on1";

const anzK = db.prepare("SELECT 1 FROM entity_mentions m JOIN entities e ON e.id=m.entity_id WHERE m.meeting_id=? AND m.gate='passed' AND e.label LIKE '%ANZ%'").get(K);
const anzI = db.prepare("SELECT 1 FROM entity_mentions m JOIN entities e ON e.id=m.entity_id WHERE m.meeting_id=? AND m.gate='passed' AND e.label LIKE '%ANZ%'").get(I);
if (anzK && anzI) {
  let r = joined(K, I, "%ANZ%", "%ANZ%");
  check(!!r, "ANZ topic threads kickoff <-> investor", r ?? "no join found");
} else {
  console.log("~ ANZ join check skipped — this run's extraction phrased topics without ANZ in both meetings (LLM variance)");
}
const rp = joined(K, I, "%prospecting%", "%prospecting%");
check(!!rp, "prospecting table threads kickoff <-> investor", rp ?? "no join found");

// ── 2. Over-merge guards: pairs that must remain SEPARATE entities ──
const distinct = (la: string, lb: string) => {
  const rows = db.prepare(
    "SELECT id FROM entities WHERE merged_into IS NULL AND (label LIKE ? OR label LIKE ?)",
  ).all(la, lb) as { id: string }[];
  return new Set(rows.map((x) => x.id)).size >= 2;
};
{
  const both = db.prepare("SELECT count(*) n FROM entities WHERE merged_into IS NULL AND (label LIKE '%pricing tiers%' OR label LIKE '%ANZ pricing%')").get() as { n: number };
  if (both.n >= 2) check(distinct("%pricing tiers%", "%ANZ pricing%"), "pricing tiers ≠ ANZ pricing (no over-merge)");
  else console.log("~ over-merge pair check skipped — gold surface forms not both present this run");
}
check(
  !db.prepare("SELECT 1 FROM entities WHERE label LIKE '%dashboard%' AND label LIKE '%pricing%'").get(),
  "no chimera entities (dashboard+pricing fused)",
);

// ── 3. Intra-meeting dedup: containment variants collapse to one entity ──
const wh = db.prepare(
  "SELECT count(*) n FROM entities WHERE merged_into IS NULL AND label LIKE '%warehouse migration%'",
).get() as { n: number };
check(wh.n === 1, "warehouse migration variants are ONE entity", `found ${wh.n}`);

// ── 4. Receipts: every passed mention in the samples carries proof ──
const noProof = db.prepare(
  `SELECT count(*) n FROM entity_mentions WHERE gate='passed' AND quote IS NULL AND offset_s IS NULL AND meeting_id LIKE ?`,
).get(SAMPLES) as { n: number };
check(noProof.n === 0, "every passed mention has a receipt", `${noProof.n} without`);

// ── 5. Placeholder hygiene: live-capture "You"/"Them" never become people ──
const ghosts = db.prepare(
  `SELECT count(*) n FROM entities WHERE kind='person' AND merged_into IS NULL AND id IN ('person:you','person:them')`,
).get() as { n: number };
check(ghosts.n === 0, "no You/Them ghost people", `${ghosts.n} found`);

// ── 6. Determinism guard: FTS rows must not grow on reprocess ──
const fts = db.prepare(`SELECT count(*) n FROM search WHERE meeting_id LIKE ? AND kind='utterance'`).get(SAMPLES) as { n: number };
const utts = db.prepare(`SELECT count(*) n FROM utterances WHERE meeting_id LIKE ?`).get(SAMPLES) as { n: number };
check(fts.n === utts.n, "FTS utterance rows = utterances (no duplication)", `${fts.n} vs ${utts.n}`);

// ── 7. Similarity sanity: the lookalike pair calibration flagged must stay
// below the merge bar. (Containment pairs merge via their own rung, so their
// similarity() score is irrelevant — the rung is what the resolver uses.)
const lookalike = similarity("CS dashboard", "sales dashboard");
check(lookalike < 0.72, "lookalike 'CS dashboard'/'sales dashboard' stays below merge bar", lookalike.toFixed(2));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
