/**
 * Export meetings as portable JSON bundles so a team can work on one shared
 * dataset without a shared server — the local-first answer to sync. Bundles
 * carry the SOURCE data only (meeting, transcript, claims with receipts);
 * derived state (entities, graph, chunks) is rebuilt by the importer, so two
 * machines end up with identical brains from identical inputs.
 *
 *   npm run export              -> shared-dataset/<meeting_id>.json
 *   npm run export -- <id...>   -> just those meetings
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { openDb } from "../lib/db.js";

const db = openDb();
const DIR = "shared-dataset";
mkdirSync(DIR, { recursive: true });

const wanted = process.argv.slice(2);
const meetings = (db.prepare("SELECT * FROM meetings").all() as Record<string, unknown>[]).filter(
  (m) => !wanted.length || wanted.includes(m.id as string),
);

for (const m of meetings) {
  const id = m.id as string;
  const bundle = {
    version: 1,
    meeting: m,
    utterances: db.prepare("SELECT * FROM utterances WHERE meeting_id = ? ORDER BY idx").all(id),
    claims: db.prepare("SELECT * FROM claims WHERE meeting_id = ?").all(id),
  };
  const file = `${DIR}/${id}.json`;
  writeFileSync(file, JSON.stringify(bundle, null, 2));
  console.log(`✓ ${file} (${bundle.utterances.length} utterances, ${bundle.claims.length} claims)`);
}
console.log(`\n${meetings.length} meeting(s) exported. Share the ${DIR}/ folder; teammates run: npm run import`);
