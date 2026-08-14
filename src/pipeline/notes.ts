/**
 * Meeting chat: grounded Q&A over one transcript, which may also rewrite the
 * user's notes when they ask it to.
 *
 * Structured notes no longer live here — they are the grounded outline
 * (pipeline/notes-outline.ts), where every bullet carries a receipt. This file
 * keeps the conversational half, and it talks to OpenAI directly.
 *
 * Chat receives the *client's* current notes (not the DB copy) so an in-flight
 * autosave can never be clobbered by a stale read. Every write is snapshotted
 * to notes_versions first.
 */
import { DatabaseSync } from "node:sqlite";
import { flattenTranscript } from "../lib/openai.js";
import { chatJson } from "../lib/model.js";
import type { Budget } from "../lib/harness.js";
import type { Utterance } from "../lib/pyai.js";

const CHAT_SYSTEM = `You are the meeting assistant for the notes document below. Ground every answer ONLY
in the transcript; cite moments as [Ns] using the transcript's second markers when useful.
If — and only if — the user asks you to change the notes (add a section, list someone's
action items into the doc, reorganize, remove something), return the FULL revised markdown
document in "updated_notes"; otherwise "updated_notes" must be null and the notes stay
untouched. Keep answers short and specific.
Reply as JSON: {"answer": string, "updated_notes": string|null}`;

function snapshotNotes(db: DatabaseSync, meetingId: string, markdown: string, source: string) {
  db.prepare(
    "INSERT INTO notes_versions (meeting_id, markdown, source, created_at) VALUES (?, ?, ?, ?)",
  ).run(meetingId, markdown, source, Date.now());
}

function writeNotes(db: DatabaseSync, meetingId: string, incoming: string, result: string, source: string) {
  if (incoming.trim()) snapshotNotes(db, meetingId, incoming, "user");
  db.prepare("UPDATE meetings SET my_notes = ? WHERE id = ?").run(result, meetingId);
  snapshotNotes(db, meetingId, result, source);
}

/** One validated JSON call with a single corrective retry — the mini-harness. */
async function callWithRetry<T>(
  system: string,
  user: string,
  validate: (raw: unknown) => T | string, // returns the value, or an error string
  budget?: Budget, // the wrapper's governor, so chat units land on the run record
): Promise<T> {
  let lastError: string | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const sys = lastError
      ? `${system}\n\nYour previous reply was rejected: ${lastError}\nFix this and reply with valid JSON only.`
      : system;
    try {
      budget?.spendUnits(1);
      const raw = await chatJson({ purpose: "meeting.chat", system: sys, user });
      const out = validate(raw);
      if (typeof out === "string") throw new Error(out);
      return out;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      if (attempt === 2) throw e;
    }
  }
  throw new Error("unreachable");
}

export async function chatAboutMeeting(
  db: DatabaseSync,
  meetingId: string,
  message: string,
  history: { role: "user" | "assistant"; content: string }[],
  currentNotes: string,
  utterances: Utterance[],
  budget?: Budget,
): Promise<{ answer: string; notes: string | null }> {
  const convo = history
    .slice(-10)
    .map((h) => `${h.role === "user" ? "User" : "Assistant"}: ${h.content}`)
    .join("\n");
  const out = await callWithRetry(
    CHAT_SYSTEM,
    `Transcript:\n${flattenTranscript(utterances)}\n\nCurrent notes document:\n${currentNotes || "(empty)"}\n\n${
      convo ? `Conversation so far:\n${convo}\n\n` : ""
    }User: ${message}`,
    (raw): { answer: string; notes: string | null } | string => {
      const r = raw as { answer?: unknown; updated_notes?: unknown };
      if (typeof r?.answer !== "string" || !r.answer.trim()) return 'response must include a non-empty "answer" string';
      const notes = typeof r.updated_notes === "string" && r.updated_notes.trim() ? r.updated_notes.trim() : null;
      return { answer: r.answer.trim(), notes };
    },
    budget,
  );
  if (out.notes) writeNotes(db, meetingId, currentNotes, out.notes, "chat");
  return out;
}
