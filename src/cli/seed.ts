/**
 * Seed the local brain from raw sample meetings (samples/dummy-meetings/*.json)
 * by running each through the full pipeline — Recap extraction, receipts,
 * entities, graph, search — so demo data behaves exactly like recorded data.
 *
 *   npm run seed                    -> samples/dummy-meetings
 *   npm run seed -- path/to/dir     -> another folder
 *
 * Wipe first for a clean slate:  rm -f data/opengranola.db* && npm run seed
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { openDb } from "../lib/db.js";
import { ensureApiKey } from "../lib/firstrun.js";
import { processMeeting, type MeetingInput } from "../pipeline/extract.js";
import type { Utterance } from "../lib/pyai.js";

// tiny .env loader
for (const line of (() => { try { return readFileSync(".env", "utf8").split("\n"); } catch { return []; } })()) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

type RawMeeting = {
  id: string;
  title: string;
  started_at: string;
  duration_minutes?: number;
  participants?: { name: string; role: string }[];
  transcript: { offset_seconds: number; speaker: string; text: string }[];
};

const apiKey = await ensureApiKey().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
const db = openDb();
const dir = process.argv[2] ?? "samples/dummy-meetings";
const files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "manifest.json").sort();
if (!files.length) {
  console.error(`no meeting .json files in ${dir}/`);
  process.exit(1);
}

let ok = 0, failed = 0;
for (const f of files) {
  const raw = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as RawMeeting;
  if (!raw.transcript?.length) continue;
  // Recap's wire format only knows agent/customer; the first participant
  // hosts the meeting, everyone else is "customer". Real names ride along.
  const host = raw.participants?.[0]?.name ?? raw.transcript[0].speaker;
  const utterances: Utterance[] = raw.transcript.map((u, i) => {
    const next = raw.transcript[i + 1];
    const est = Math.max(1.5, u.text.split(/\s+/).length * 0.38);
    return {
      speaker: u.speaker,
      speaker_role: u.speaker === host ? "agent" : "customer",
      text: u.text,
      offset_s: u.offset_seconds,
      duration_s: next ? Math.min(est, Math.max(1, next.offset_seconds - u.offset_seconds)) : est,
    };
  });
  const input: MeetingInput = {
    id: raw.id,
    title: raw.title,
    mode: "discovery",
    startedAt: Date.parse(raw.started_at) || Date.now(),
    utterances,
  };
  process.stdout.write(`▶ ${raw.title} … `);
  try {
    const res = await processMeeting(db, apiKey, input);
    console.log(`${res.exit} (${res.stored.passed} claims)`);
    ok++;
  } catch (e) {
    console.log(`failed: ${e instanceof Error ? e.message : e}`);
    failed++;
  }
}
console.log(`\nseeded ${ok}/${files.length} meetings${failed ? `, ${failed} failed` : ""}`);
