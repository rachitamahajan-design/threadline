/**
 * The transcript adapter. STT output in, `Segment[]` out.
 *
 * A Segment is the ONLY thing a grounded claim is allowed to cite. Everything
 * downstream (facts, notes, handoffs, validators) addresses the transcript by
 * segment id and never by free text, so "where did this come from" is always
 * answerable by lookup instead of by search.
 *
 * STT is someone else's module. This file is the seam: `fromStt` accepts the
 * shapes we have seen (live `Utterance[]`, the shared-dataset export, a raw
 * diarization job) and normalises them. When the STT payload changes, this file
 * changes and nothing else does.
 */
import type { DatabaseSync } from "node:sqlite";
import type { Utterance } from "./pyai.js";

/** A single diarized, timestamped chunk from STT. Stable id, verbatim text. */
export type Segment = {
  id: string; // "S001" — stable for the life of the meeting
  speaker: string; // diarized label or resolved participant name
  startMs: number;
  endMs: number;
  text: string;
  confidence: number; // 0..1 from STT
};

export type MeetingType =
  | "investor"
  | "vendor"
  | "customer" // external
  | "team"
  | "one_on_one"; // internal

export type Participant = { id: string; name: string; role?: string; org?: string };

/** Below this, a segment is "heard poorly" — usable, but claims resting only on it get flagged. */
export const LOW_CONFIDENCE = 0.6;

/** STT gives us no confidence today; absent means "no reason to doubt it". */
const DEFAULT_CONFIDENCE = 1;

export function segmentId(idx: number): string {
  return `S${String(idx + 1).padStart(3, "0")}`;
}

/** Live/DB utterances → segments. `idx` decides the id, so ids are stable across runs. */
export function fromUtterances(utterances: (Utterance & { idx?: number; confidence?: number | null })[]): Segment[] {
  return utterances.map((u, i) => ({
    id: segmentId(u.idx ?? i),
    speaker: u.speaker ?? u.speaker_role ?? "a participant",
    startMs: Math.round((u.offset_s ?? 0) * 1000),
    endMs: Math.round(((u.offset_s ?? 0) + (u.duration_s ?? 0)) * 1000),
    text: (u.text ?? "").trim(),
    confidence: clampConfidence(u.confidence),
  }));
}

/**
 * Tolerant entry point for whatever the STT module hands us. Recognised shapes:
 *   Segment[]                          (already ours)
 *   Utterance[]                        (live session / samples)
 *   { utterances: [...] }              (shared-dataset export)
 *   { segments: [...] }                (word/segment-level STT)
 *   { transcript: { utterances: [] } } (PyAI transcription job)
 * Anything unrecognised throws rather than guessing — a silently empty
 * transcript would produce notes with no receipts, which is the one outcome
 * this whole pipeline exists to prevent.
 */
export function fromStt(raw: unknown): Segment[] {
  const rows = pickRows(raw);
  if (!rows) throw new Error("unrecognised STT payload: expected an array, or {utterances|segments|transcript}");
  if (rows.length === 0) return [];
  if (looksLikeSegment(rows[0])) {
    return (rows as Segment[]).map((s, i) => ({
      ...s,
      id: s.id || segmentId(i),
      text: (s.text ?? "").trim(),
      confidence: clampConfidence(s.confidence),
    }));
  }
  return fromUtterances(rows as (Utterance & { idx?: number })[]);
}

function pickRows(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (Array.isArray(o.segments)) return o.segments;
  if (Array.isArray(o.utterances)) return o.utterances;
  const t = o.transcript as Record<string, unknown> | undefined;
  if (t && Array.isArray(t.utterances)) return t.utterances;
  if (Array.isArray(t)) return t;
  return null;
}

function looksLikeSegment(x: unknown): boolean {
  const o = x as Record<string, unknown>;
  return !!o && typeof o.startMs === "number" && typeof o.text === "string";
}

function clampConfidence(c: unknown): number {
  return typeof c === "number" && Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : DEFAULT_CONFIDENCE;
}

/** id → Segment. Every source check is a lookup in here; nothing else counts. */
export function indexSegments(segments: Segment[]): Map<string, Segment> {
  return new Map(segments.map((s) => [s.id, s]));
}

/** The concatenated text of the cited segments — the haystack for verbatim checks. */
export function citedText(index: Map<string, Segment>, sourceIds: string[]): string {
  return sourceIds
    .map((id) => index.get(id)?.text ?? "")
    .filter(Boolean)
    .join(" ");
}

/** True when every cited segment was heard poorly, i.e. the claim rests on mush. */
export function restsOnLowConfidence(index: Map<string, Segment>, sourceIds: string[]): boolean {
  const found = sourceIds.map((id) => index.get(id)).filter((s): s is Segment => !!s);
  return found.length > 0 && found.every((s) => s.confidence < LOW_CONFIDENCE);
}

/** `[S001] Speaker: text` — the one transcript rendering every prompt shares. */
export function renderSegments(segments: Segment[]): string {
  return segments
    .map((s) => `[${s.id}] ${s.speaker}: ${s.text}${s.confidence < LOW_CONFIDENCE ? "  (heard poorly)" : ""}`)
    .join("\n");
}

/**
 * The meeting's `mode` (a recording preset) mapped onto the handoff taxonomy.
 * Modes were never a closed set, so anything unknown lands on the internal
 * default rather than inventing an external-facing one.
 */
const MODE_TO_TYPE: Record<string, MeetingType> = {
  investor: "investor",
  vendor: "vendor",
  customer: "customer",
  discovery: "customer",
  team: "team",
  kickoff: "team",
  standup: "team",
  one_on_one: "one_on_one",
  "1on1": "one_on_one",
};

export function meetingTypeOf(mode: string | null | undefined, override?: string | null): MeetingType {
  const explicit = override && MODE_TO_TYPE[override] ? MODE_TO_TYPE[override] : null;
  return explicit ?? MODE_TO_TYPE[(mode ?? "").toLowerCase()] ?? "team";
}

/** Segments for a stored meeting, straight from the local DB. */
export function loadSegments(db: DatabaseSync, meetingId: string): Segment[] {
  const rows = db
    .prepare(
      `SELECT idx, speaker, speaker_role, text, offset_s, duration_s, confidence
       FROM utterances WHERE meeting_id = ? ORDER BY idx`,
    )
    .all(meetingId) as (Utterance & { idx: number; confidence: number | null })[];
  return fromUtterances(rows);
}

/**
 * The owner whitelist: who is allowed to own an action item in this meeting.
 * Speakers heard in the transcript, plus anyone in the local people directory
 * (a founder assigns work to people who weren't on the call). Nothing else.
 */
export function participantsOf(db: DatabaseSync, meetingId: string): Participant[] {
  const speakers = db
    .prepare(`SELECT DISTINCT speaker FROM utterances WHERE meeting_id = ? AND speaker IS NOT NULL`)
    .all(meetingId) as { speaker: string }[];
  const directory = db.prepare(`SELECT id, name, team FROM people`).all() as
    { id: number; name: string; team: string | null }[];
  const byName = new Map<string, Participant>();
  for (const { speaker } of speakers) {
    if (!speaker.trim()) continue;
    byName.set(speaker.toLowerCase(), { id: `speaker:${speaker}`, name: speaker });
  }
  for (const p of directory) {
    const key = p.name.toLowerCase();
    const existing = byName.get(key);
    byName.set(key, {
      id: `person:${p.id}`,
      name: existing?.name ?? p.name,
      role: p.team ?? undefined,
    });
  }
  return [...byName.values()];
}
