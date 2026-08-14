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
import { groundedIn, type StepRecord } from "../lib/harness.js";
import { recordRun } from "../lib/runlog.js";
import { because, publicReason, reasonFrom } from "../lib/reasons.js";
import { generateBrainMd } from "./brain-md.js";
import { clearStatements } from "../lib/store.js";
import { ensureNotes } from "./handoff.js";
import type { RecapRecord } from "../lib/pyai.js";

const MIN_TAPE_BYTES = 960_000; // ~30s @ 32KB/s — shorter isn't worth a job
function wordOverlap(a: string, b: string): number {
  const t = (x: string) => new Set(x.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2));
  const A = t(a), B = t(b);
  if (!A.size || !B.size) return 0;
  return [...A].filter((w) => B.has(w)).length / Math.min(A.size, B.size);
}

const MIN_LINES = 2;            // need something to relabel
const MIN_SPOKEN_S = 20;        // duration is the content measure — line count is an endpointing artifact
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

/**
 * Pick which channel carries the room. Calls: ch0 (system audio) holds the
 * other participants. In-person meetings: nobody comes through the speakers,
 * the mic (ch1) hears everyone — so when ch0 is absent/near-silent and ch1 is
 * substantial, diarize the mic and split "You" instead. PyAI has no voice
 * recognition, so in-person mode can't know which voice is the owner's —
 * every voice becomes Speaker N and gets named by a human, the owner included.
 */
type ChannelPlan = { tape: string; target: "Them" | "You"; prefix: string; bytes: number };

/**
 * Every substantial channel gets diarized — covering all three meeting shapes:
 * pure call (ch0 only), in-person (ch1 only, nobody through the speakers),
 * and HYBRID (on a call with several people sharing your room mic): both
 * channels run, with distinct label namespaces so the naming chips say where
 * each voice sat — call side "Speaker N", your room "Room N".
 */
function planChannels(dir: string, meetingId: string): ChannelPlan[] | { reason: string } {
  const size = (ch: number) => {
    const t = `${dir}/${meetingId}-ch${ch}.pcm`;
    return existsSync(t) ? statSync(t).size : 0;
  };
  const ch0 = size(0), ch1 = size(1);
  const plans: ChannelPlan[] = [];
  if (ch0 >= MIN_TAPE_BYTES) plans.push({ tape: `${dir}/${meetingId}-ch0.pcm`, target: "Them", prefix: "Speaker", bytes: ch0 });
  if (ch1 >= MIN_TAPE_BYTES) plans.push({ tape: `${dir}/${meetingId}-ch1.pcm`, target: "You", prefix: "Room", bytes: ch1 });
  if (plans.length) return plans;
  if (!ch0 && !ch1) return { reason: "no tapes on disk" };
  return { reason: `recording too short (${Math.round(Math.max(ch0, ch1) / 32_000)}s) to be worth a job` };
}

/**
 * The full pipeline: guards → job(s) → match → rewrite → re-derive.
 * Wrapped in recordRun per harnesses.md: the run lands in the shared runs
 * table with a four-outcome exit; diarize_runs remains the UI-facing chip
 * state (shipped|failed|skipped|running), vocabulary aligned.
 */
export async function diarizeMeeting(db: DatabaseSync, apiKey: string, meetingId: string): Promise<void> {
  const steps: StepRecord[] = [];
  await recordRun(
    db,
    { kind: "diarize", meetingId },
    async (budget) => diarizeInner(db, apiKey, meetingId, steps, () => budget.spendUnits(1)),
    () => {
      const st = (db.prepare("SELECT status, reason FROM diarize_runs WHERE meeting_id = ?").get(meetingId) as { status: string; reason: string | null } | undefined);
      // Honest four-outcome mapping: a guard skip shipped nothing → partial.
      const outcome =
        st?.status === "failed" ? "failed"
        : st?.status === "skipped" ? "partial"
        : st?.status === "shipped" && st.reason ? "partial"
        : "shipped";
      return { outcome, steps };
    },
  ).catch(() => { /* recordRun re-throws after recording; chip state already set */ });
}

async function diarizeInner(db: DatabaseSync, apiKey: string, meetingId: string, steps: StepRecord[], spend: () => void): Promise<void> {
  const done = db.prepare("SELECT status FROM diarize_runs WHERE meeting_id = ? AND status = 'shipped'").get(meetingId);
  if (done) return;

  const skip = (reason: string) => {
    steps.push({ name: "diarize:guard", status: "skipped", attempts: 0, ms: 0, reason: because("info", reason) });
    setRun(db, meetingId, { status: "skipped", reason });
  };

  // Resumed meetings write suffixed tapes with unpersisted offset bases — v1 skips.
  const dir = "data/recordings";
  if (existsSync(dir) && readdirSync(dir).some((f) => f.startsWith(`${meetingId}-s`)))
    return skip("resumed recordings aren't supported yet");

  const plans = planChannels(dir, meetingId);
  if ("reason" in plans) return skip(plans.reason);

  // Substitution consumes the Them/You labels — a second pass has nothing to
  // split. Say so instead of a misleading under-Ns message.
  const already = db.prepare(
    "SELECT count(*) n FROM utterances WHERE meeting_id = ? AND (speaker LIKE 'Speaker %' OR speaker LIKE 'Room %')",
  ).get(meetingId) as { n: number };
  if (already.n > 0) return skip("already diarized — rename speakers instead of re-running");

  setRun(db, meetingId, { status: "running", reason: null });
  let totalSpeakers = 0, totalMatched = 0, totalLines = 0, anyRewrite = false;
  let callSegs: DiarizedSegment[] = []; // ch0's turns — the bleed-dedup reference
  const notes: string[] = [];
  try {
    for (const plan of plans) {
      const lines = db
        .prepare("SELECT idx, speaker, offset_s, duration_s FROM utterances WHERE meeting_id = ? AND speaker = ? ORDER BY idx")
        .all(meetingId, plan.target) as UttRow[];
      const spokenS = lines.reduce((a, u) => a + u.duration_s, 0);
      if (lines.length < MIN_LINES || spokenS < MIN_SPOKEN_S) { notes.push(`${plan.target}: under ${MIN_SPOKEN_S}s of speech — nothing to split`); continue; }
      totalLines += lines.length;

      spend();
      const jobId = await submitTranscriptionJob(apiKey, pcm16ToWav(readFileSync(plan.tape)), { diarize: true });
      setRun(db, meetingId, { job_id: jobId });
      const { segments, speakers } = await awaitTranscriptionJob(apiKey, jobId, plan.bytes / 32_000);
      if (speakers <= 1) { notes.push(`${plan.target}: one voice`); continue; }
      totalSpeakers += speakers;

      // SUBSTITUTE, don't relabel: stream endpointing yields paragraph-length
      // utterances spanning several voices — no single label can be right.
      // The diarized job returns per-turn segments WITH text, so the channel's
      // transcript is replaced by the finer one. Distinct namespace per
      // channel: call side "Speaker K", mic side "Room K".
      const role = plan.target === "Them" ? "customer" : "agent";
      // Mic bleed: without OS echo cancellation the mic re-records the
      // speakers, and each channel's ASR transcribes that same sound slightly
      // differently — so the dedup is fuzzy (time overlap + word overlap),
      // and it happens HERE, where both channels' full text exists, rather
      // than being guessed live.
      const isBleed = (g: DiarizedSegment) =>
        plan.target === "You" &&
        callSegs.some((c) => Math.abs(c.start - g.start) < 4 && wordOverlap(c.text, g.text) >= 0.5);
      if (plan.target === "Them") callSegs = segments;
      const replacement = segments
        .filter((g) => g.text?.trim() && !isBleed(g))
        .map((g) => ({
          // PyAI labels arrive as "speaker_1" — normalize into the channel's
          // namespace so call and room voices can never collide.
          speaker: `${plan.prefix} ${(g.speaker.match(/(\d+)/)?.[1] ?? "1")}`,
          speaker_role: role,
          text: g.text.trim(),
          offset_s: g.start,
          duration_s: Math.max(0.3, g.end - g.start),
        }));
      const keep = db
        .prepare("SELECT speaker, speaker_role, text, offset_s, duration_s FROM utterances WHERE meeting_id = ? AND speaker != ? ORDER BY idx")
        .all(meetingId, plan.target) as { speaker: string; speaker_role: string; text: string; offset_s: number; duration_s: number }[];
      const merged = [...keep, ...replacement].sort((a, b) => a.offset_s - b.offset_s);
      db.exec("BEGIN");
      try {
        db.prepare("DELETE FROM utterances WHERE meeting_id = ?").run(meetingId);
        const ins = db.prepare(
          "INSERT INTO utterances (meeting_id, idx, speaker, speaker_role, text, offset_s, duration_s) VALUES (?, ?, ?, ?, ?, ?, ?)",
        );
        merged.forEach((u, i) => ins.run(meetingId, i, u.speaker, u.speaker_role, u.text, u.offset_s, u.duration_s));
        db.exec("COMMIT");
      } catch (e) { db.exec("ROLLBACK"); throw e; }
      totalMatched += replacement.length;
      anyRewrite = true;
      steps.push({ name: `diarize:${plan.target === "Them" ? "call" : "room"}`, status: "ok", attempts: 1, ms: 0 });
      if (plan.target === "You") notes.push("one of the Room voices is you — name yourself too");
    }

    if (anyRewrite) {
      rederiveMeeting(db, meetingId);
      // The outline's [S###] receipts are positional — substitution renumbered
      // every line, so the old notes now cite the WRONG segments. Facts are
      // cleared and notes regenerate against the diarized transcript (one paid
      // notes call; guarded — a notes failure never fails the diarize run).
      clearStatements(db, meetingId);
      await ensureNotes(db, meetingId, { force: true }).catch(() => {});
      notes.push("notes rebuilt against the diarized transcript");
    }
    const rate = totalLines ? totalMatched / totalLines : 0;
    if (anyRewrite && rate < 0.7) notes.unshift("low match — offsets may have drifted (mid-call reconnects?)");
    setRun(db, meetingId, {
      status: "shipped", speakers: totalSpeakers, matched: totalMatched, total: totalLines,
      reason: notes.length ? notes.join("; ") : null,
    });
  } catch (e) {
    // The chip renders this string verbatim, so it gets the public label only;
    // the raw error lands in the run record's step reasons, not on screen.
    const failure = reasonFrom(e);
    steps.push({ name: "diarize", status: "failed", attempts: 1, ms: 0, reason: failure });
    setRun(db, meetingId, { status: "failed", reason: publicReason(failure) });
  }
}
