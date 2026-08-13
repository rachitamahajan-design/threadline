/**
 * Recap inspector: sends a sample meeting to PyAI Recap and dumps the raw
 * response JSON — every field the model returns, not just what the pipeline
 * stores. Use this to judge and iterate on summary quality.
 *
 *   npx tsx src/cli/inspect.ts           # first sample meeting
 *   npx tsx src/cli/inspect.ts 2         # by index
 *   npx tsx src/cli/inspect.ts sharon    # by title match
 */
import { readFileSync } from "node:fs";

// tiny .env loader — no dependency needed
for (const line of (() => { try { return readFileSync(".env", "utf8").split("\n"); } catch { return []; } })()) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

import { triggerRecap, awaitRecap } from "../lib/pyai.js";
import type { MeetingInput } from "../pipeline/extract.js";

const apiKey = process.env.PYAI_API_KEY;
if (!apiKey) {
  console.error("PYAI_API_KEY missing — add it to .env");
  process.exit(1);
}

const meetings: MeetingInput[] = JSON.parse(readFileSync("samples/meetings.json", "utf8"));
const arg = process.argv[2];
const meeting = arg
  ? /^\d+$/.test(arg)
    ? meetings[Number(arg)]
    : meetings.find((m) => m.title.toLowerCase().includes(arg.toLowerCase()))
  : meetings[0];
if (!meeting) {
  console.error(`No meeting matched "${arg}". Available:`);
  meetings.forEach((m, i) => console.error(`  ${i}: ${m.title}`));
  process.exit(1);
}

const durationS = Math.max(...meeting.utterances.map((u) => u.offset_s + u.duration_s), 0);
// Fresh call id each run so we always get a new generation, not a cached one.
const callId = `${meeting.id}-inspect-${Date.now()}`;

console.error(`▶ ${meeting.title} (${meeting.utterances.length} utterances, ${durationS}s) → ${callId}`);
await triggerRecap(apiKey, callId, meeting.utterances, durationS);
const r = await awaitRecap(apiKey, callId);

console.log(JSON.stringify(r, null, 2));
