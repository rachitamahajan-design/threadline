/**
 * Zero-setup demo: processes the three sample meetings end to end.
 *   npm run demo
 * Needs only PYAI_API_KEY in .env. Prints notes with receipts, the to-do
 * list, and the meeting graph — the same data the UI renders.
 */
import { readFileSync } from "node:fs";
import { openDb } from "../lib/db.js";
import { processMeeting, type MeetingInput } from "../pipeline/extract.js";

// tiny .env loader — no dependency needed
for (const line of (() => { try { return readFileSync(".env", "utf8").split("\n"); } catch { return []; } })()) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

import { ensureApiKey } from "../lib/firstrun.js";
const apiKey = await ensureApiKey().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});

const db = openDb();
const meetings: MeetingInput[] = JSON.parse(readFileSync("samples/meetings.json", "utf8"));

for (const m of meetings) {
  const already = db.prepare("SELECT exit FROM meetings WHERE id = ? AND exit IS NOT NULL").get(m.id);
  if (already) {
    console.log(`− ${m.title}: already processed (${(already as { exit: string }).exit}), skipping`);
    continue;
  }
  process.stdout.write(`▶ ${m.title} … `);
  const res = await processMeeting(db, apiKey, m);
  console.log(`${res.exit} (${res.stored.passed} claims passed, ${res.stored.blocked} blocked)`);
}

console.log("\n══ TODAY ═══════════════════════════════════");
const todos = db
  .prepare(
    `SELECT c.body, c.quote, m.title FROM claims c JOIN meetings m ON m.id = c.meeting_id
     WHERE c.kind = 'action_item' AND c.gate = 'passed' AND c.done = 0`,
  )
  .all() as { body: string; quote: string | null; title: string }[];
for (const t of todos) {
  const b = JSON.parse(t.body) as { task: string; owner: string | null; due: string | null };
  console.log(`☐ ${b.task}${b.owner ? `  — ${b.owner}` : ""}${b.due ? ` (due ${b.due})` : ""}`);
  console.log(`    receipt: "${t.quote}" · from: ${t.title}`);
}

console.log("\n══ MEETING GRAPH ═══════════════════════════");
const edges = db
  .prepare(
    `SELECT n1.label AS src, e.kind, n2.label AS dst FROM edges e
     JOIN nodes n1 ON n1.id = e.src JOIN nodes n2 ON n2.id = e.dst`,
  )
  .all() as { src: string; kind: string; dst: string }[];
for (const e of edges) console.log(`  ${e.src}  ─${e.kind}→  ${e.dst}`);

console.log("\n══ BLOCKED BY GATES (the harness working) ══");
const blocked = db
  .prepare(`SELECT kind, gate_reason FROM claims WHERE gate = 'blocked'`)
  .all() as { kind: string; gate_reason: string }[];
if (blocked.length === 0) console.log("  none — every claim had a receipt");
for (const b of blocked) console.log(`  ✗ ${b.kind}: ${b.gate_reason}`);

console.log("\n══ SEARCH ('warehouse migration') ══════════");
const hits = db
  .prepare(
    `SELECT DISTINCT m.title FROM search s JOIN meetings m ON m.id = s.meeting_id
     WHERE search MATCH ? LIMIT 5`,
  )
  .all("warehouse migration") as { title: string }[];
for (const h of hits) console.log(`  ⌕ ${h.title}`);
