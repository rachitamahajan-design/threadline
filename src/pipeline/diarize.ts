/**
 * Speaker identification: split the merged "Them" channel into Speaker 1/2/3
 * via a PyAI diarized batch job on the saved system-audio tape, then let the
 * user name each speaker once — names propagate through utterances, entities,
 * graph and search via the free local re-derive path (no paid calls).
 *
 * Runs automatically after stop, but never blocks it and never fails a
 * meeting: every outcome lands in diarize_runs with a reason the UI can show.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { pcm16ToWav } from "../lib/openai.js";
import { submitTranscriptionJob, awaitTranscriptionJob, PyAIError, type DiarizedSegment } from "../lib/pyai.js";
import { candidates } from "./candidates.js";
import { resolveCandidates, storeResolutions } from "./resolve.js";
import { projectGraph } from "./project.js";
import { relateEntities } from "./resolve.js";
import { indexMeeting } from "./chunker.js";
import { reindexMeeting } from "./extract.js";
import { groundedIn } from "../lib/harness.js";
import { generateBrainMd } from "./brain-md.js";
import type { RecapRecord } from "../lib/pyai.js";

const MIN_TAPE_BYTES = 960_000; // ~30s @ 32KB/s — shorter isn't worth a job
const MIN_THEM_LINES = 4;
const OVERLAP_MIN = 0.5; // segment must cover ≥50% of the utterance span
const DRIFT_TOLERANCE_S = 2;

type UttRow = { idx: number; speaker: string | null; offset_s: number; duration_s: number };

function setRun(db: DatabaseSync, meetingId: string, fields: Record<string, unknown>) {
  const cur = db.prepare("SELECT meeting_id FROM diarize_runs WHERE meeting_id = ?").get(meetingId);
  if (!cur)
    db.prepare("INSERT INTO diarize_runs (meeting_id, status, updated_at) VALUES (?, 'queued', ?)").run(meetingId, Date.now());
  const keys = Object.keys(fields);
  db.prepare(`UPDATE diarize_runs SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE meeting_id = ?`)
    .run(...keys.map((k) => fields[k] as string | number | null), Date.now(), meetingId);
}

/**
 * Match diarized segments to stored "Them" utterances by time overlap.
 * Pure — unit-testable. Returns idx -> speaker label for confident matches.
 */
export function matchSegments(utterances: UttRow[], segments: DiarizedSegment[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const u of utterances) {
    const uStart = u.offset_s, uEnd = u.offset_s + Math.max(u.duration_s, 0.5);
    let best: { speaker: string; overlap: number } | null = null;
    for (const s of segments) {
      const start = Math.max(uStart, s.start - DRIFT_TOLERANCE_S);
      const end = Math.min(uEnd, s.end + DRIFT_TOLERANCE_S);
      const overlap = Math.max(0, end - start) / (uEnd - uStart);
      if (overlap >= OVERLAP_MIN && (!best || overlap > best.overlap)) best = { speaker: s.speaker, overlap };
    }
    if (best) out.set(u.idx, best.speaker);
  }
  return out;
}

/** Re-derive everything downstream of utterances — zero paid calls. */
export function rederiveMeeting(db: DatabaseSync, meetingId: string) {
  const utterances = db
    .prepare("SELECT speaker, speaker_role, text, offset_s, duration_s FROM utterances WHERE meeting_id = ? ORDER BY idx")
    .all(meetingId) as unknown as import("../lib/pyai.js").Utterance[];
  // Stale mentions linger under ON CONFLICT DO NOTHING — clear before re-resolving.
  db.prepare("DELETE FROM entity_mentions WHERE meeting_id = ?").run(meetingId);
  // Rebuild a record shape from stored claims so topics keep their receipts.
  const rec: RecapRecord = { key_decisions: [], action_items: [], risk_signals: [] };
  for (const c of db.prepare("SELECT kind, body, quote FROM claims WHERE meeting_id = ? AND gate = 'passed'").all(meetingId) as { kind: string; body: string; quote: string | null }[]) {
    const body = JSON.parse(c.body);
    if (c.kind === "decision") rec.key_decisions!.push(body.text ?? c.quote ?? "");
    else if (c.kind === "action_item") rec.action_items!.push(body);
    else if (c.kind === "risk") rec.risk_signals!.push(body);
  }
  const gate = groundedIn(utterances);
  const hasProof = (c: { quote?: string; offset_s?: number }) => gate({ quote: c.quote, offset_s: c.offset_s }) === null;
  storeResolutions(db, meetingId, resolveCandidates(db, candidates(utterances, rec)), hasProof);
  projectGraph(db, [meetingId]);
  relateEntities(db);
  indexMeeting(db, meetingId);
  reindexMeeting(db, meetingId);
  try { generateBrainMd(db); } catch { /* derived file only */ }
}

/** The full pipeline: guards → job → match → rewrite → re-derive. */
export async function diarizeMeeting(db: DatabaseSync, apiKey: string, meetingId: string): Promise<void> {
  const done = db.prepare("SELECT status FROM diarize_runs WHERE meeting_id = ? AND status = 'done'").get(meetingId);
  if (done) return;

  const skip = (reason: string) => setRun(db, meetingId, { status: "skipped", reason });

  // Resumed meetings write suffixed tapes with unpersisted offset bases — v1 skips.
  const dir = "data/recordings";
  if (existsSync(dir) && readdirSync(dir).some((f) => f.startsWith(`${meetingId}-s`)))
    return skip("resumed recordings aren't supported yet");

  const tape = `${dir}/${meetingId}-ch0.pcm`;
  if (!existsSync(tape)) return skip("no system-audio tape on disk");
  const bytes = statSync(tape).size;
  if (bytes < MIN_TAPE_BYTES) return skip(`recording too short (${Math.round(bytes / 32_000)}s) to be worth a job`);

  const them = db
    .prepare("SELECT idx, speaker, offset_s, duration_s FROM utterances WHERE meeting_id = ? AND speaker = 'Them' ORDER BY idx")
    .all(meetingId) as UttRow[];
  if (them.length < MIN_THEM_LINES) return skip(`only ${them.length} line(s) from other participants — nothing to split`);

  setRun(db, meetingId, { status: "running", reason: null });
  try {
    const jobId = await submitTranscriptionJob(apiKey, pcm16ToWav(readFileSync(tape)), { diarize: true });
    setRun(db, meetingId, { job_id: jobId });
    const { segments, speakers } = await awaitTranscriptionJob(apiKey, jobId, bytes / 32_000);

    if (speakers <= 1) return setRun(db, meetingId, { status: "done", speakers, matched: 0, total: them.length, reason: "one voice — nothing to split" });

    const matches = matchSegments(them, segments);
    const upd = db.prepare("UPDATE utterances SET speaker = ? WHERE meeting_id = ? AND idx = ?");
    db.exec("BEGIN");
    try {
      for (const [idx, speaker] of matches) upd.run(speaker, meetingId, idx);
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }

    rederiveMeeting(db, meetingId);
    const rate = them.length ? matches.size / them.length : 0;
    setRun(db, meetingId, {
      status: "done", speakers, matched: matches.size, total: them.length,
      reason: rate < 0.7 ? "low match — offsets may have drifted (mid-call reconnects?)" : null,
    });
  } catch (e) {
    const msg = e instanceof PyAIError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
    setRun(db, meetingId, { status: "failed", reason: msg });
  }
}
