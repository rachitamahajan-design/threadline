/** Speaker identification: matching math + rename propagation, no network. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { matchSegments, rederiveMeeting } from "../src/pipeline/diarize.js";
import { openDb } from "../src/lib/db.js";

test("matchSegments assigns speakers by time overlap", () => {
  const utts = [
    { idx: 0, speaker: "Them", offset_s: 0, duration_s: 4 },
    { idx: 1, speaker: "Them", offset_s: 5, duration_s: 3 },
    { idx: 2, speaker: "Them", offset_s: 20, duration_s: 2 },
  ];
  const segs = [
    { id: 0, start: 0, end: 4.5, text: "", speaker: "Speaker 1" },
    { id: 1, start: 4.8, end: 8.2, text: "", speaker: "Speaker 2" },
    // nothing near t=20 — utterance 2 must stay unmatched
  ];
  const m = matchSegments(utts, segs);
  assert.equal(m.get(0), "Speaker 1");
  assert.equal(m.get(1), "Speaker 2");
  assert.equal(m.has(2), false);
});

test("matchSegments tolerates small offset drift", () => {
  const utts = [{ idx: 0, speaker: "Them", offset_s: 10, duration_s: 4 }];
  // segment shifted 1.5s late (reconnect drift) — within the ±2s tolerance
  const m = matchSegments(utts, [{ id: 0, start: 11.5, end: 15.5, text: "", speaker: "Speaker 3" }]);
  assert.equal(m.get(0), "Speaker 3");
});

test("rename + rederive propagates a named speaker into entities", () => {
  const db = openDb(mkdtempSync(path.join(tmpdir(), "diar-")));
  const now = Date.now();
  db.prepare("INSERT INTO meetings (id, title, mode, started_at, duration_s) VALUES ('dm1','Test','discovery',?,60)").run(now);
  const utt = db.prepare("INSERT INTO utterances (meeting_id, idx, speaker, speaker_role, text, offset_s, duration_s) VALUES ('dm1', ?, ?, 'customer', ?, ?, 3)");
  utt.run(0, "Speaker 1", "The warehouse migration is blocked again.", 0);
  utt.run(1, "Speaker 1", "We need Sharon to escalate it.", 4);
  utt.run(2, "You", "I will follow up.", 8);
  // rename Speaker 1 -> Sharon (what POST /api/speaker/rename does)
  db.prepare("UPDATE utterances SET speaker = 'Sharon' WHERE meeting_id = 'dm1' AND speaker = 'Speaker 1'").run();
  rederiveMeeting(db, "dm1");
  const person = db.prepare("SELECT id FROM entities WHERE kind='person' AND id='person:sharon'").get();
  assert.ok(person, "named speaker becomes a person entity");
  const ghost = db.prepare("SELECT id FROM entities WHERE id IN ('person:speaker-1','person:you')").all();
  assert.equal(ghost.length, 0, "placeholders never become entities");
});

test("Room N placeholders never become entities", () => {
  const db2 = openDb(); // same process singleton — reuse seeded db from above
  db2.prepare("INSERT OR IGNORE INTO meetings (id, title, mode, started_at, duration_s) VALUES ('dm2','Hybrid','discovery',1,60)").run();
  db2.prepare("INSERT INTO utterances (meeting_id, idx, speaker, speaker_role, text, offset_s, duration_s) VALUES ('dm2',0,'Room 2','customer','We should revisit the pricing tiers.',0,3)").run();
  rederiveMeeting(db2, "dm2");
  assert.equal((db2.prepare("SELECT count(*) n FROM entities WHERE id='person:room-2'").get() as { n: number }).n, 0);
});
