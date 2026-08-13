/**
 * The notes brain: three LLM passes over the user's notes document.
 *
 *   enhance   — polish the user's rough notes in place, transcript as ground truth
 *   structure — full structured notes: sections, team-wise action items,
 *               person inference (Meet/Zoom remote speakers are all "Them";
 *               identities come from how people address each other)
 *   chat      — grounded Q&A that may also rewrite the notes when asked
 *
 * All passes receive the *client's* current notes (not the DB copy) so an
 * in-flight autosave can never be clobbered by a stale read. Every write is
 * snapshotted to notes_versions first.
 */
import { DatabaseSync } from "node:sqlite";
import { chatJSON, flattenTranscript } from "../lib/openai.js";
import type { Utterance } from "../lib/pyai.js";

export type PersonMapping = { heard_as: string; inferred_name: string; team: string | null };

const ENHANCE_SYSTEM = `You improve a person's rough meeting notes using the transcript as ground truth.
Rules:
- PRESERVE the user's structure, ordering, headings and personal phrasing. Their words win.
- Expand fragments into complete points; fix obvious typos; fill clear gaps the transcript
  covers that the notes gesture at. Add missing important items only under an
  "Also discussed" section at the end.
- Never state anything the transcript does not support. Prefer the transcript's spelling
  of names, numbers and dates.
- Keep it markdown: #/## headings, - bullets, - [ ] for open action items.
- If the notes are empty, produce concise notes from the transcript alone.
Reply as JSON: {"notes": "<full markdown document>"}`;

const STRUCTURE_SYSTEM = `You turn a meeting transcript (plus the user's notes, if any) into fully structured
meeting notes in markdown.

Person inference: speakers may be labeled generically ("Them" is everyone on the remote
side of a Google Meet / Zoom call; "You" is the note-taker). Infer real identities from how
people address each other in the transcript ("thanks, Rachita", "Dev, can you take that").
When confident, use the real name; when not, write "Unidentified speaker". Never invent names.

Structure (omit empty sections):
# <meeting title>
## Summary            — 2-4 sentences
## <one heading per topic actually discussed>  — specific bullets
## Decisions
## Action items       — group by TEAM when teams are identifiable (### Engineering,
                        ### Sales, ...); infer team from role context in the transcript;
                        otherwise group by owner. Each item:
                        - [ ] **Name**: task (due date if stated)
## Open questions

Only facts supported by the transcript. Numbers, names, dates over vagueness.
Reply as JSON: {"notes": "<markdown>", "people": [{"heard_as": string, "inferred_name": string, "team": string|null}]}`;

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
): Promise<T> {
  let lastError: string | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const sys = lastError
      ? `${system}\n\nYour previous reply was rejected: ${lastError}\nFix this and reply with valid JSON only.`
      : system;
    try {
      const raw = await chatJSON(sys, user);
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

const asNotes = (raw: unknown): { notes: string } | string => {
  const r = raw as { notes?: unknown };
  return typeof r?.notes === "string" && r.notes.trim()
    ? { notes: r.notes.trim() }
    : 'response must be {"notes": "<non-empty markdown>"}';
};

export async function enhanceNotes(
  db: DatabaseSync,
  meetingId: string,
  currentNotes: string,
  utterances: Utterance[],
): Promise<{ notes: string }> {
  const out = await callWithRetry(
    ENHANCE_SYSTEM,
    `Transcript:\n${flattenTranscript(utterances)}\n\nUser's rough notes:\n${currentNotes || "(empty)"}`,
    asNotes,
  );
  writeNotes(db, meetingId, currentNotes, out.notes, "enhance");
  return out;
}

export async function structureNotes(
  db: DatabaseSync,
  meetingId: string,
  currentNotes: string,
  utterances: Utterance[],
  title: string,
): Promise<{ notes: string; people: PersonMapping[] }> {
  const out = await callWithRetry(
    STRUCTURE_SYSTEM,
    `Meeting title: ${title}\n\nTranscript:\n${flattenTranscript(utterances)}\n\nUser's notes (may be empty):\n${currentNotes || "(empty)"}`,
    (raw): { notes: string; people: PersonMapping[] } | string => {
      const n = asNotes(raw);
      if (typeof n === "string") return n;
      const people = Array.isArray((raw as { people?: unknown }).people)
        ? ((raw as { people: unknown[] }).people.filter(
            (p): p is PersonMapping =>
              typeof p === "object" && p !== null &&
              typeof (p as PersonMapping).heard_as === "string" &&
              typeof (p as PersonMapping).inferred_name === "string",
          ) as PersonMapping[])
        : [];
      return { notes: n.notes, people };
    },
  );
  writeNotes(db, meetingId, currentNotes, out.notes, "structure");
  return out;
}

export async function chatAboutMeeting(
  db: DatabaseSync,
  meetingId: string,
  message: string,
  history: { role: "user" | "assistant"; content: string }[],
  currentNotes: string,
  utterances: Utterance[],
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
  );
  if (out.notes) writeNotes(db, meetingId, currentNotes, out.notes, "chat");
  return out;
}
