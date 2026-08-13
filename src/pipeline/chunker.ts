/**
 * Chunking for retrieval. The unit is a sliding window of 3 utterances with
 * stride 2, because the answer to a question is usually the NEXT line — a
 * single utterance ("yeah, let's push it") is unretrievable on its own, and a
 * whole meeting has no timestamp to deep-link to. 50% overlap guarantees any
 * adjacent question/answer pair lands intact in at least one chunk.
 *
 * Claims (gate='passed' only — a blocked claim must not re-enter through the
 * search back door) and the meeting summary are indexed as their own chunks.
 */
import type { DatabaseSync } from "node:sqlite";
import type { Utterance } from "../lib/pyai.js";
import type { StepRecord } from "../lib/harness.js";

const WINDOW = 3;
const STRIDE = 2;
const MAX_CHARS = 900;

/** Rebuild all chunks for one meeting. Delete-then-insert: reindex, not append. */
export function indexMeeting(db: DatabaseSync, meetingId: string): StepRecord {
  const started = Date.now();
  const utterances = db
    .prepare("SELECT idx, speaker, text, offset_s, duration_s FROM utterances WHERE meeting_id = ? ORDER BY idx")
    .all(meetingId) as (Utterance & { idx: number })[];
  const meta = db.prepare("SELECT title, headline, summary FROM meetings WHERE id = ?").get(meetingId) as
    | { title: string; headline: string | null; summary: string | null }
    | undefined;
  if (!meta) return { name: "index:chunks", status: "skipped", attempts: 0, ms: 0, reason: "no meeting" };

  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM chunks WHERE meeting_id = ?").run(meetingId); // trigger clears FTS
    const ins = db.prepare(
      "INSERT INTO chunks (meeting_id, kind, src_id, start_offset_s, end_offset_s, speakers, text) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );

    for (let i = 0; i < utterances.length; i += STRIDE) {
      const win = utterances.slice(i, i + WINDOW);
      if (!win.length) break;
      let text = win.map((u) => `${u.speaker ?? u.speaker_role ?? ""}: ${u.text}`).join("\n");
      if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS);
      const speakers = [...new Set(win.map((u) => u.speaker).filter(Boolean))].join(", ");
      const last = win[win.length - 1];
      ins.run(meetingId, "window", win[0].idx, win[0].offset_s, last.offset_s + last.duration_s, speakers, text);
      if (i + WINDOW >= utterances.length) break;
    }

    const claims = db
      .prepare("SELECT id, kind, body, offset_s, quote FROM claims WHERE meeting_id = ? AND gate = 'passed'")
      .all(meetingId) as { id: number; kind: string; body: string; offset_s: number | null; quote: string | null }[];
    for (const c of claims) {
      const body = JSON.parse(c.body);
      const text = [c.kind, body.task ?? body.text ?? body.description ?? "", c.quote ?? ""].filter(Boolean).join(" — ");
      ins.run(meetingId, "claim", c.id, c.offset_s ?? 0, c.offset_s ?? 0, null, text);
    }

    ins.run(meetingId, "summary", 0, 0, 0, null, `${meta.title} ${meta.headline ?? ""} ${meta.summary ?? ""}`.trim());
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    return { name: "index:chunks", status: "failed", attempts: 1, ms: Date.now() - started, reason: e instanceof Error ? e.message : String(e) };
  }
  return { name: "index:chunks", status: "ok", attempts: 1, ms: Date.now() - started };
}
