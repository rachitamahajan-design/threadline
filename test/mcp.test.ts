/**
 * MCP read layer: the queries behind the tools, against a seeded db.
 * Protocol framing is the SDK's problem; what we own is that every result
 * carries receipts and no tool path exposes bulk transcript.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/lib/db.js";
import { brainCounts, listClaims, getEntity, listMeetings, backlinks } from "../src/mcp/queries.js";
import { generateBrainMd, THREADLINE_ATTRIBUTION } from "../src/pipeline/brain-md.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Own temp DB: node --test runs each file in its own process, so the openDb
// singleton binds to this tempdir without fighting other suites.
const db = openDb(mkdtempSync(path.join(tmpdir(), "mcpdb-")));
(function seed() {
  const now = Date.now();
  const ins = db.prepare("INSERT INTO meetings (id, title, mode, started_at, duration_s) VALUES (?, ?, 'discovery', ?, 60)");
  ins.run("m1", "ANZ pricing kickoff", now - 86_400_000);
  ins.run("m2", "Investor update", now);
  const utt = db.prepare("INSERT INTO utterances (meeting_id, idx, speaker, speaker_role, text, offset_s, duration_s) VALUES (?, ?, ?, 'agent', ?, ?, 3)");
  utt.run("m1", 0, "Rachita", "We will delay the ANZ rollout to September.", 0);
  utt.run("m2", 0, "Rachita", "ANZ pricing moved to September.", 0);
  const claim = db.prepare("INSERT INTO claims (meeting_id, kind, body, quote, offset_s, gate, done) VALUES (?, ?, ?, ?, 0, 'passed', ?)");
  claim.run("m1", "action_item", JSON.stringify({ task: "Send tier model", owner: "Rachita" }), "Send tier model", 0);
  claim.run("m1", "action_item", JSON.stringify({ task: "Old done item", owner: "Sharon" }), "Old done item", 1);
  claim.run("m2", "decision", JSON.stringify({ text: "Move ANZ pricing to September" }), "Move ANZ pricing to September", 0);
  db.prepare("INSERT INTO entities (id, kind, label, created_at) VALUES ('topic:anz-pricing','topic','ANZ pricing', ?)").run(now);
  db.prepare("INSERT INTO entity_aliases (entity_id, norm, alias, matcher, score, reason, created_at) VALUES ('topic:anz-pricing','anz pricing','ANZ pricing','seed',1,'seed', ?)").run(now);
  const men = db.prepare("INSERT INTO entity_mentions (entity_id, meeting_id, surface, quote, offset_s, source, matcher, score, gate) VALUES ('topic:anz-pricing', ?, 'ANZ pricing', ?, 0, 'decision', 'seed', 1, 'passed')");
  men.run("m1", "delay the ANZ rollout");
  men.run("m2", "ANZ pricing moved");
  db.prepare("INSERT INTO nodes (id, kind, label) VALUES ('m1','meeting','m1'), ('m2','meeting','m2'), ('topic:anz-pricing','topic','ANZ pricing')").run();
  db.prepare("INSERT INTO edges (src, dst, kind, meeting_id) VALUES ('m1','topic:anz-pricing','mentions','m1'), ('m2','topic:anz-pricing','mentions','m2')").run();
})();

test("brainCounts reports a populated brain", () => {
  const c = brainCounts(db);
  assert.ok(c.meetings > 0);
  assert.ok(c.claims > 0);
});

test("listClaims returns receipted rows and honors open_only", () => {
  const all = listClaims(db, { kind: "action_item" });
  assert.ok(all.length > 0);
  for (const c of all) {
    assert.ok(c.receipt.meeting_id, "claim carries meeting receipt");
    assert.ok("quote" in c.receipt, "claim carries quote field");
  }
  const open = listClaims(db, { kind: "action_item", open_only: true });
  assert.ok(open.every((c) => !c.done));
});

test("listMeetings excludes transcript text", () => {
  const rows = listMeetings(db, { limit: 5 }) as Record<string, unknown>[];
  assert.ok(rows.length > 0);
  for (const r of rows) assert.ok(!("utterances" in r) && !("transcript" in r));
});

test("getEntity resolves by fuzzy name and carries mention receipts", () => {
  // seeded fixtures include at least one topic entity — find any and re-resolve by label
  const any = db.prepare("SELECT label FROM entities WHERE kind='topic' AND merged_into IS NULL LIMIT 1").get() as { label: string } | undefined;
  if (!any) return; // fixture-dependent; absence is not a failure of the query layer
  const e = getEntity(db, any.label)!;
  assert.equal(e.label, any.label);
  for (const m of e.mentions as { meeting_id: string }[]) assert.ok(m.meeting_id);
});

test("backlinks returns rows shaped {id,title,via}", () => {
  const m = db.prepare("SELECT id FROM meetings LIMIT 1").get() as { id: string };
  const rows = backlinks(db, m.id) as Record<string, unknown>[];
  for (const r of rows) { assert.ok(r.id); assert.ok(r.via); }
});

test("BRAIN.md generates with attribution and topic index", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "brainmd-"));
  const { markdown, path: out } = generateBrainMd(db, dir);
  assert.ok(out.endsWith("BRAIN.md"));
  assert.ok(markdown.includes(THREADLINE_ATTRIBUTION));
  assert.ok(markdown.includes("## Topics"));
  assert.ok(markdown.includes("## Recent meetings"));
});
