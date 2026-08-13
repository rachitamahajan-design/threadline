/**
 * Import meeting bundles produced by `npm run export`, then rebuild the brain
 * so this machine's entities/graph/search match the exporter's exactly.
 * Idempotent: re-importing the same bundle replaces, never duplicates.
 *
 *   npm run import                    -> everything in shared-dataset/
 *   npm run import -- path/to/dir     -> another folder of bundles
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { openDb } from "../lib/db.js";

const db = openDb();
const dir = process.argv[2] ?? "shared-dataset";

let files: string[];
try {
  files = readdirSync(dir).filter((f) => f.endsWith(".json"));
} catch {
  console.error(`no such folder: ${dir} — run \`npm run export\` on the source machine first`);
  process.exit(1);
}
if (!files.length) {
  console.error(`no .json bundles in ${dir}/`);
  process.exit(1);
}

let imported = 0;
for (const f of files) {
  const bundle = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
  if (bundle.version !== 1 || !bundle.meeting?.id) {
    console.log(`− ${f}: not a v1 meeting bundle, skipping`);
    continue;
  }
  const id = bundle.meeting.id as string;

  db.exec("BEGIN");
  try {
    // Replace, never append — same discipline as every other reindex path.
    db.prepare("DELETE FROM claims WHERE meeting_id = ?").run(id);
    db.prepare("DELETE FROM utterances WHERE meeting_id = ?").run(id);
    db.prepare("DELETE FROM meetings WHERE id = ?").run(id);

    const m = bundle.meeting;
    db.prepare(
      `INSERT INTO meetings (id, title, mode, started_at, duration_s, exit, headline, summary, my_notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(m.id, m.title, m.mode ?? "discovery", m.started_at, m.duration_s ?? 0, m.exit ?? null, m.headline ?? null, m.summary ?? null, m.my_notes ?? null);

    const insU = db.prepare(
      "INSERT INTO utterances (meeting_id, idx, speaker, speaker_role, text, offset_s, duration_s) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (const u of bundle.utterances)
      insU.run(id, u.idx, u.speaker ?? null, u.speaker_role, u.text, u.offset_s, u.duration_s);

    const insC = db.prepare(
      "INSERT INTO claims (meeting_id, kind, body, offset_s, quote, gate, gate_reason, done) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const c of bundle.claims)
      insC.run(id, c.kind, c.body, c.offset_s ?? null, c.quote ?? null, c.gate, c.gate_reason ?? null, c.done ?? 0);

    db.exec("COMMIT");
    imported++;
    console.log(`✓ ${m.title} (${bundle.utterances.length} utterances, ${bundle.claims.length} claims)`);
  } catch (e) {
    db.exec("ROLLBACK");
    console.log(`✗ ${f}: ${e instanceof Error ? e.message : e}`);
  }
}

console.log(`\n${imported} meeting(s) imported. Rebuilding the brain…\n`);
execSync("npm run rebuild-brain", { stdio: "inherit" });
