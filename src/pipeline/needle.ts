/**
 * Needle — a conversation threaded through every meeting.
 *
 * Spotlight (⌘K) is a single stitch: one question, one pass. Needle keeps
 * sewing: each turn retrieves fresh context, and answers ground against the
 * union of everything the conversation has already retrieved.
 *
 * Three design decisions, deliberately:
 *  - Follow-ups are REWRITTEN into standalone queries before retrieval
 *    ("who owns the second one?" retrieves nothing by itself).
 *  - Enumerative questions ("list the open action items") are answered from
 *    the claims table by SQL — complete by construction, every row already
 *    receipted. Retrieval-then-summarize can silently drop item #4; SQL can't.
 *  - Same receipts gates as Spotlight. A refusal offers the nearest topics the
 *    brain does know, because a dead-end kills a chat.
 */
import type { DatabaseSync } from "node:sqlite";
import { Budget, retry, applyGate, normalize, decideExit, type StepRecord } from "../lib/harness.js";
import { hasOpenAI } from "../lib/openai.js";
import { retrieve, type Snippet } from "./retrieve.js";
import { gates, type RawPoint } from "./ask.js";

export type NeedleMessage = {
  id: number;
  role: "user" | "assistant";
  content: string;
  payload: {
    mode?: string;
    exit?: string;
    points?: { text: string; quote: string; meeting_id: string; meeting_title: string; offset_s: number }[];
    blocked?: number;
    chunk_ids?: number[];
    suggestions?: string[];
  } | null;
};

const ENUMERATIVE =
  /\b(list|all|every|open|pending|outstanding)\b.*\b(action items?|next steps?|decisions?|to-?dos?|tasks?|risks?|commitments?)\b|\b(action items?|next steps?|decisions?|to-?dos?|tasks?)\b.*\b(so far|till now|until now|currently|open|pending)\b|what (are|were) the (last |latest )?(agreed( upon)? )?(next steps|action items|decisions)/i;

type Row = Record<string, unknown>;

function history(db: DatabaseSync, conversationId: number, limit = 8) {
  return (db
    .prepare("SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?")
    .all(conversationId, limit) as { role: string; content: string }[]).reverse();
}

/** Union of chunks every prior turn retrieved — the conversation's evidence. */
function conversationCorpus(db: DatabaseSync, conversationId: number): number[] {
  const rows = db
    .prepare("SELECT payload FROM messages WHERE conversation_id = ? AND payload IS NOT NULL")
    .all(conversationId) as { payload: string }[];
  const ids = new Set<number>();
  for (const r of rows)
    for (const id of (JSON.parse(r.payload).chunk_ids ?? []) as number[]) ids.add(id);
  return [...ids];
}

function snippetsByIds(db: DatabaseSync, ids: number[]): Snippet[] {
  if (!ids.length) return [];
  const ph = ids.map(() => "?").join(",");
  return (db
    .prepare(
      `SELECT c.id AS chunk_id, c.meeting_id, m.title AS meeting_title, m.started_at, c.kind,
              c.text, c.speakers, c.start_offset_s AS offset_s
       FROM chunks c JOIN meetings m ON m.id = c.meeting_id WHERE c.id IN (${ph})`,
    )
    .all(...ids) as unknown as Snippet[]).map((s) => ({ ...s, score: 0, arms: [] }));
}

/** Condense the conversation + follow-up into a standalone retrieval query. */
async function rewriteQuery(hist: { role: string; content: string }[], question: string): Promise<string> {
  if (!hist.length || !hasOpenAI()) return question;
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Rewrite the user's follow-up as ONE standalone search query over meeting notes, resolving pronouns and references from the conversation. Reply with the query text only." },
        { role: "user", content: hist.map((m) => `${m.role}: ${m.content}`).join("\n") + `\nfollow-up: ${question}` },
      ],
    }),
  });
  if (!res.ok) return question;
  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  const q = data.choices[0].message.content.trim().replace(/^"|"$/g, "");
  return q.length > 2 && q.length < 300 ? q : question;
}

/** Enumerative path: complete, receipted, fully local. */
function enumerate(db: DatabaseSync, question: string, projectId: number | null) {
  const kind = /decision/i.test(question) ? "decision" : /risk/i.test(question) ? "risk" : "action_item";
  const openOnly = kind === "action_item" && !/all|every|done|completed/i.test(question);
  const scope = projectId
    ? "AND c.meeting_id IN (SELECT meeting_id FROM meeting_projects WHERE project_id = ?)" : "";
  const rows = db
    .prepare(
      `SELECT c.body, c.quote, c.offset_s, c.done, m.id AS meeting_id, m.title, m.started_at
       FROM claims c JOIN meetings m ON m.id = c.meeting_id
       WHERE c.kind = ? AND c.gate = 'passed' ${openOnly ? "AND c.done = 0" : ""} ${scope}
       ORDER BY m.started_at DESC`,
    )
    .all(...(projectId ? [kind, projectId] : [kind])) as Row[];

  const points = rows.map((r) => {
    const body = JSON.parse(r.body as string);
    const label = body.task ?? body.text ?? body.description ?? (r.quote as string) ?? "";
    const owner = body.owner ? ` — ${body.owner}` : "";
    const due = body.due ? ` (due ${body.due})` : "";
    return {
      text: `${label}${owner}${due}`,
      quote: (r.quote as string) ?? "",
      meeting_id: r.meeting_id as string,
      meeting_title: r.title as string,
      offset_s: (r.offset_s as number) ?? 0,
    };
  });
  const noun = kind === "action_item" ? (openOnly ? "open action item" : "action item") : kind;
  const meetings = new Set(points.map((p) => p.meeting_id)).size;
  const summary = points.length
    ? `${points.length} ${noun}${points.length === 1 ? "" : "s"} across ${meetings} meeting${meetings === 1 ? "" : "s"}, newest first.`
    : `No ${noun}s found${projectId ? " in this project" : ""}.`;
  return { summary, points };
}

/** Nearest topics for a conversational refusal. */
function suggestions(db: DatabaseSync): string[] {
  return (db
    .prepare(
      `SELECT e.label, count(*) n FROM entities e
       JOIN entity_mentions m ON m.entity_id = e.id AND m.gate='passed'
       WHERE e.kind='topic' AND e.merged_into IS NULL GROUP BY e.id ORDER BY n DESC LIMIT 4`,
    )
    .all() as { label: string }[]).map((r) => r.label);
}

async function synthesizeTurn(
  question: string,
  hist: { role: string; content: string }[],
  fresh: Snippet[],
  lastError: string | null,
): Promise<{ summary: string; points: RawPoint[] }> {
  const context = fresh
    .map((s) => `[#${s.chunk_id}] (meeting "${s.meeting_title}", ${Math.round(s.offset_s)}s) ${s.text}`)
    .join("\n\n");
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            'You answer questions about the user\'s meetings, in an ongoing conversation. Use ONLY the numbered snippets (and facts already established earlier in this conversation). Reply with JSON {"summary": string, "points":[{"text": string, "chunk_id": number, "quote": string}]}. ' +
            "summary: a direct conversational answer in plain third-person words, 1-3 sentences. " +
            "points: the evidence — each cites its snippet number as chunk_id with a short VERBATIM quote from that snippet. " +
            "Never introduce names or numbers that appear in neither the snippets nor the prior conversation." +
            (lastError ? ` Your previous answer was rejected: ${lastError}.` : ""),
        },
        ...hist.map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.content })),
        { role: "user", content: `${question}\n\nSnippets:\n${context}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`needle synthesis failed: HTTP ${res.status}`);
  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  const parsed = JSON.parse(data.choices[0].message.content) as { summary?: string; points?: RawPoint[] };
  return { summary: parsed.summary ?? "", points: parsed.points ?? [] };
}

/** One full turn: store the user message, produce and store the reply. */
export async function converse(db: DatabaseSync, conversationId: number, text: string) {
  const now = Date.now();
  const conv = db.prepare("SELECT project_id FROM conversations WHERE id = ?").get(conversationId) as
    | { project_id: number | null }
    | undefined;
  if (!conv) return { error: "no such conversation" };
  const hist = history(db, conversationId);
  db.prepare("INSERT INTO messages (conversation_id, role, content, payload, created_at) VALUES (?, 'user', ?, NULL, ?)")
    .run(conversationId, text, now);

  // A thread still wearing its default name takes the first question as title.
  if (!hist.length)
    db.prepare("UPDATE conversations SET title = ? WHERE id = ? AND title = 'New thread'")
      .run(text.slice(0, 60), conversationId);

  const steps: StepRecord[] = [];
  const budget = Budget.for("needle");
  const save = (content: string, payload: object) => {
    db.prepare("INSERT INTO messages (conversation_id, role, content, payload, created_at) VALUES (?, 'assistant', ?, ?, ?)")
      .run(conversationId, content, JSON.stringify(payload), Date.now());
    return { content, payload };
  };

  // Enumerative → SQL. Complete by construction, zero LLM, fully local.
  if (ENUMERATIVE.test(text)) {
    const { summary, points } = enumerate(db, text, conv.project_id);
    steps.push({ name: "route:enumerate", status: "ok", attempts: 1, ms: 0 });
    return save(summary, { mode: "enumerated", exit: "shipped", points, blocked: 0, chunk_ids: [] });
  }

  // Semantic → rewrite, retrieve, synthesize against the conversation corpus.
  const t0 = Date.now();
  const standalone = await rewriteQuery(hist, text);
  if (standalone !== text) steps.push({ name: "rewrite", status: "ok", attempts: 1, ms: Date.now() - t0 });

  let fresh = retrieve(db, standalone);
  if (conv.project_id) {
    const ids = new Set(
      (db.prepare("SELECT meeting_id FROM meeting_projects WHERE project_id = ?").all(conv.project_id) as { meeting_id: string }[])
        .map((r) => r.meeting_id),
    );
    fresh = fresh.filter((s) => ids.has(s.meeting_id));
  }
  const prior = snippetsByIds(db, conversationCorpus(db, conversationId));
  const corpus = [...fresh, ...prior.filter((p) => !fresh.some((f) => f.chunk_id === p.chunk_id))];
  steps.push({ name: "retrieve", status: fresh.length ? "ok" : "failed", attempts: 1, ms: 0 });

  if (!corpus.length) {
    const sugg = suggestions(db);
    return save(
      "Nothing in the meetings supports an answer to that — refusing rather than guessing.",
      { mode: "refused", exit: "failed", points: [], blocked: 0, chunk_ids: [], suggestions: sugg },
    );
  }

  const gate = gates(corpus); // grounding = fresh + everything this thread already saw
  const byId = new Map(corpus.map((s) => [s.chunk_id, s]));

  if (!hasOpenAI() || process.env.THREADLINE_SYNTHESIS === "off") {
    const points = fresh.slice(0, 3).map((s) => ({ text: s.text, chunk_id: s.chunk_id, quote: s.text.slice(0, 80) }));
    const { kept } = applyGate(points, gate);
    return save("Closest passages from the meetings:", {
      mode: "extractive", exit: "partial",
      points: kept.map((p) => pointOut(p, byId)), blocked: 0, chunk_ids: fresh.map((s) => s.chunk_id),
    });
  }

  let summary = "", kept: RawPoint[] = [], blockedN = 0;
  const run = await retry("synthesize", budget, async (_a, lastError) => {
    budget.spendUnits(1);
    const out = await synthesizeTurn(text, hist, fresh.length ? fresh : corpus, lastError);
    const res = applyGate(out.points, gate);
    if (!res.kept.length && res.blocked.length)
      throw new Error(res.blocked.map((b) => b.reason).slice(0, 2).join("; "));
    return { ...res, summary: out.summary };
  }, { max: 2 });
  steps.push(run.record);
  if (run.value) { kept = run.value.kept; blockedN = run.value.blocked.length; summary = run.value.summary; }

  // Summary gate: no new names/numbers beyond corpus + this conversation.
  const known = normalize(corpus.map((s) => s.text).join(" ") + " " + hist.map((h) => h.content).join(" "));
  for (const t of summary.match(/\b[A-Z][a-z]{2,}\b|\b\d[\d.,%$/-]*\b/g) ?? [])
    if (!known.includes(normalize(t))) { summary = ""; blockedN++; break; }

  if (!summary && !kept.length) {
    const points = fresh.slice(0, 3).map((s) => ({ text: s.text, chunk_id: s.chunk_id, quote: s.text.slice(0, 80) }));
    const res = applyGate(points, gate);
    return save("Couldn't ground a synthesized answer — here's what the meetings actually say:", {
      mode: "extractive", exit: decideExit(steps, budget),
      points: res.kept.map((p) => pointOut(p, byId)), blocked: blockedN, chunk_ids: fresh.map((s) => s.chunk_id),
    });
  }
  return save(summary || "Here's what the meetings support:", {
    mode: "synthesized", exit: decideExit(steps, budget),
    points: kept.map((p) => pointOut(p, byId)), blocked: blockedN, chunk_ids: fresh.map((s) => s.chunk_id),
  });
}

function pointOut(p: RawPoint, byId: Map<number, Snippet>) {
  const s = byId.get(p.chunk_id!)!;
  return { text: p.text ?? "", quote: p.quote ?? "", meeting_id: s.meeting_id, meeting_title: s.meeting_title, offset_s: s.offset_s };
}
