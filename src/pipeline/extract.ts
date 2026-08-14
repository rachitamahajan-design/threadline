/**
 * The post-meeting pipeline. Named loop, one exit, receipts everywhere.
 *
 *   transcript ──▶ Recap (PyAI) ──▶ grounding gate ──▶ local DB
 *                                       │
 *                                   blocked claims recorded with reasons
 *
 * Entities for the graph come from a light local pass over the transcript +
 * Recap output (people from action-item owners, topics from decisions). An
 * optional Anthropic pass can enrich this later; the pipeline must not depend
 * on a second vendor to ship its core.
 */
import { DatabaseSync } from "node:sqlite";
import { triggerRecap, awaitRecap, PyAIError, type Utterance, type RecapRecord } from "../lib/pyai.js";
import { retry, groundedIn, applyGate, decideExit, type Budget, type StepRecord } from "../lib/harness.js";
import { because } from "../lib/reasons.js";
import { firstFailure, recordRun } from "../lib/runlog.js";
import { candidates } from "./candidates.js";
import { resolveCandidates, storeResolutions, relateEntities } from "./resolve.js";
import { projectGraph } from "./project.js";
import { indexMeeting } from "./chunker.js";
import { generateBrainMd } from "./brain-md.js";
import { hasOpenAI, openaiExtract } from "../lib/openai.js";
import { modelConfigured } from "../lib/model.js";
import { clearFacts } from "../lib/store.js";
import { ensureNotes } from "./handoff.js";
import { structureSummary } from "./summarize.js";
import { suggestProjects } from "./match.js";
import { applyDictionary } from "./corrections.js";

export type MeetingInput = {
  id: string;
  title: string;
  mode: string;
  startedAt: number;
  utterances: Utterance[];
};

/**
 * Wipe a meeting's derived rows so reprocessing is idempotent. Utterances use
 * INSERT OR REPLACE and runs are append-only by invariant; everything else is
 * rebuilt from scratch each run.
 */
export function clearDerived(db: DatabaseSync, meetingId: string) {
  db.prepare("DELETE FROM claims WHERE meeting_id = ?").run(meetingId);
  db.prepare("DELETE FROM search WHERE meeting_id = ?").run(meetingId);
  db.prepare("DELETE FROM edges WHERE meeting_id = ?").run(meetingId);
  // Sweep nodes that no longer appear in any meeting's graph.
  db.prepare(
    `DELETE FROM nodes WHERE kind != 'meeting'
       AND id NOT IN (SELECT src FROM edges UNION SELECT dst FROM edges)`,
  ).run();
}

/**
 * Rebuild the FTS rows for one meeting from current DB state (corrected
 * utterances, structured summary if present, else the flat summary). Both the
 * pipeline and the corrections engine call this so the index never drifts.
 */
export function reindexMeeting(db: DatabaseSync, meetingId: string) {
  db.prepare("DELETE FROM search WHERE meeting_id = ?").run(meetingId);
  const ins = db.prepare("INSERT INTO search (meeting_id, kind, text) VALUES (?, ?, ?)");
  const m = db
    .prepare("SELECT title, summary, summary_json, my_notes FROM meetings WHERE id = ?")
    .get(meetingId) as
    | { title: string; summary: string | null; summary_json: string | null; my_notes: string | null }
    | undefined;
  if (!m) return;
  if (m.my_notes?.trim()) ins.run(meetingId, "notes", m.my_notes);
  let indexedStructured = false;
  if (m.summary_json) {
    try {
      const s = JSON.parse(m.summary_json) as {
        overview?: string;
        sections?: { title: string; bullets?: { text: string }[]; subsections?: { title: string; bullets?: { text: string }[] }[] }[];
      };
      ins.run(meetingId, "summary", `${m.title} ${s.overview ?? ""}`);
      for (const sec of s.sections ?? []) {
        const parts = [sec.title, ...(sec.bullets ?? []).map((b) => b.text)];
        for (const sub of sec.subsections ?? []) parts.push(sub.title, ...(sub.bullets ?? []).map((b) => b.text));
        ins.run(meetingId, "summary", parts.join(" "));
      }
      indexedStructured = true;
    } catch {
      /* fall through to flat summary */
    }
  }
  if (!indexedStructured) ins.run(meetingId, "summary", `${m.title} ${m.summary ?? ""}`);
  const utts = db
    .prepare("SELECT text FROM utterances WHERE meeting_id = ? ORDER BY idx")
    .all(meetingId) as { text: string }[];
  for (const u of utts) ins.run(meetingId, "utterance", u.text);
}

/**
 * Closed loop with failure invariance: the whole pipeline runs inside a run
 * record that exists from the first instruction — a crash mid-run leaves an
 * honest 'failed' row instead of nothing. Budget comes from agents.json.
 */
export async function processMeeting(db: DatabaseSync, apiKey: string, m: MeetingInput) {
  return recordRun(
    db,
    { kind: "process-meeting", meetingId: m.id, args: { title: m.title, mode: m.mode } },
    (budget) => processMeetingInner(db, apiKey, m, budget),
    (res) => ({
      outcome: res.exit,
      steps: res.steps,
      failure: res.exit === "shipped" ? null : firstFailure(res.steps),
    }),
  );
}

async function processMeetingInner(db: DatabaseSync, apiKey: string, m: MeetingInput, budget: Budget) {
  const steps: StepRecord[] = [];

  // Known corrections are applied before anything downstream sees the text —
  // a mistake the user fixed once never reappears, even on regenerate.
  m = { ...m, utterances: applyDictionary(db, m.id, m.utterances) };
  const durationS = Math.max(...m.utterances.map((u) => u.offset_s + u.duration_s), 0);

  clearDerived(db, m.id);
  db.prepare(
    `INSERT INTO meetings (id, title, mode, started_at, duration_s) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET title=excluded.title`,
  ).run(m.id, m.title, m.mode, m.startedAt, durationS);
  const insUtt = db.prepare(
    "INSERT OR REPLACE INTO utterances (meeting_id, idx, speaker, speaker_role, text, offset_s, duration_s, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  m.utterances.forEach((u, i) =>
    insUtt.run(m.id, i, u.speaker ?? null, u.speaker_role, u.text, u.offset_s, u.duration_s, u.confidence ?? null),
  );

  // core: Recap. 402s never succeed on retry, so only 429s are retried.
  const recap = await retry(
    "core:recap",
    budget,
    async () => {
      // Fresh call id per run: Recap refuses a changed payload for an existing
      // call, and reprocessing after corrections legitimately changes the text.
      const recapId = `${m.id}-r${Date.now()}`;
      await triggerRecap(apiKey, recapId, m.utterances, durationS);
      budget.spendUnits(1);
      const r = await awaitRecap(apiKey, recapId);
      if (r.status === "failed") throw new Error(r.error ?? "recap failed");
      return r;
    },
    { retryable: (e) => e instanceof PyAIError && e.retryable },
  );
  steps.push(recap.record);

  // Recap down but OpenAI configured → same extraction, fallback engine.
  let record = recap.value?.record ?? null;
  let headline = recap.value?.headline ?? null;
  if (!record && hasOpenAI()) {
    const fb = await retry("fallback:openai-extract", budget, () => openaiExtract(m.utterances), { max: 2 });
    steps.push(fb.record);
    if (fb.value) {
      record = fb.value;
      headline = fb.value.tldr ?? null;
      // the core step failed but the run recovered — reflect that honestly
      const core = steps.find((s) => s.name === "core:recap");
      if (core) core.name = "recap(pyai-down)";
    }
  }

  let stored = { passed: 0, blocked: 0 };
  if (record) {
    stored = storeClaims(db, m, record);
    steps.push({
      name: "gate:grounding",
      status: stored.blocked > 0 ? "blocked" : "ok",
      attempts: 1,
      ms: 0,
      reason: stored.blocked > 0 ? because("grounding-blocked", `${stored.blocked} claim(s) had no proof in the transcript`) : undefined,
    });

    const rec = record;
    db.prepare("UPDATE meetings SET headline = ?, summary = ? WHERE id = ?").run(
      headline ?? rec.tldr ?? null,
      rec.summary ?? rec.summary_draft ?? null,
      m.id,
    );

    // Auto-title: a meeting still wearing a default name takes one from its own
    // content. Must run AFTER the upsert above (which forces title from the
    // session) and only against the two default shapes, so an explicit name is
    // never overwritten and a regenerate can't rename twice.
    autoTitle(db, m.id, headline ?? rec.tldr ?? null);

    // Second pass: restructure the draft into a validated, grounded document.
    // Non-core — a failure here degrades to the flat summary, never kills the run.
    if (hasOpenAI()) {
      const structured = await structureSummary(budget, m.utterances, rec);
      steps.push(structured.record);
      if (structured.value) {
        db.prepare("UPDATE meetings SET summary_json = ? WHERE id = ?").run(
          JSON.stringify(structured.value),
          m.id,
        );
        db.prepare(
          "INSERT INTO summary_versions (meeting_id, json, source, created_at) VALUES (?, ?, 'generated', ?)",
        ).run(m.id, JSON.stringify(structured.value), Date.now());
        steps.push({
          name: "check:summary-grounding",
          status: structured.ungrounded > 0 ? "blocked" : "ok",
          attempts: 1,
          ms: 0,
          reason:
            structured.ungrounded > 0
              ? because("grounding-blocked", `${structured.ungrounded} bullet(s) had no verifiable anchor in the transcript`)
              : undefined,
        });
      }
    }

    // Canonical entities, then project them down into nodes/edges. Replaces
    // the old buildGraph(), whose topics were the first six words of a
    // decision — which is why reworded topics never joined across meetings.
    const cands = candidates(m.utterances, rec);
    const gate = groundedIn(m.utterances);
    const hasProof = (c: { quote?: string; offset_s?: number }) =>
      gate({ quote: c.quote, offset_s: c.offset_s }) === null;
    const resolutions = resolveCandidates(db, cands);
    const res = storeResolutions(db, m.id, resolutions, hasProof);
    steps.push(res.step);
    steps.push(projectGraph(db, [m.id]));
    // Without this, `related` edges only existed after a manual rebuild-brain —
    // leaving the retrieval graph arm and the backlinks related-hop inert in
    // production. (Audit finding: half the hybrid retrieval design was off.)
    steps.push(relateEntities(db).step);

    // Retrieval chunks (windows + claims + summary), delete-then-insert so
    // reprocessing can never duplicate index rows. reindexMeeting fills the
    // legacy `search` table (utterances + structured summary + notes) until
    // every reader has moved to chunk_fts.
    steps.push(indexMeeting(db, m.id));
    reindexMeeting(db, m.id);

    // Project matching: suggestions only, the user files. Non-core — skipped
    // silently without OpenAI or candidate projects, never kills the run.
    if (hasOpenAI()) {
      const match = await suggestProjects(db, budget, m, rec);
      if (match) steps.push(match);
    }
  }

  // The themed outline: the one output that generates itself. Handoffs never do
  // — they wait to be asked. Non-core: a failure here leaves the meeting usable
  // and the outline regenerable from the UI.
  if (modelConfigured()) {
    const startedAt = Date.now();
    // Extraction re-runs when the transcript changed under us (corrections,
    // "record more"), so notes are never composed from stale facts.
    clearFacts(db, m.id);
    const notes = await ensureNotes(db, m.id, { force: true, budget }).catch((e: unknown) => ({
      outline: null,
      error: e instanceof Error ? e.message : String(e),
    }));
    steps.push(
      notes.outline
        ? {
            name: "notes:outline",
            status: notes.outline.needsReview ? "blocked" : "ok",
            attempts: 1,
            ms: Date.now() - startedAt,
            reason: notes.outline.needsReview
              ? because(
                  "grounding-blocked",
                  `${notes.outline.failures.length} grounding failure(s); ${notes.outline.dropped} bullet(s) dropped`,
                )
              : undefined,
          }
        : {
            name: "notes:outline",
            status: "failed",
            attempts: 1,
            ms: Date.now() - startedAt,
            reason: because("upstream-failed", notes.error ?? "unknown"),
          },
    );
  }

  // The run record itself is written by the recordRun wrapper — including when
  // this function never gets here.
  const exit = decideExit(steps, budget);
  db.prepare("UPDATE meetings SET exit = ? WHERE id = ?").run(exit, m.id);

  // Keep the agent primer fresh. A projection failure must never fail a run.
  try { generateBrainMd(db); } catch { /* derived file only */ }

  return { exit, steps, stored };
}

/**
 * Content-derived title for meetings still wearing a default name. The two
 * default shapes in the wild: the server's `Meeting <locale datetime>` and the
 * old UI prompt's literal "Untitled meeting". Anything else is a human choice
 * and is never touched.
 */
export function autoTitle(db: DatabaseSync, meetingId: string, headline: string | null) {
  const row = db.prepare("SELECT title FROM meetings WHERE id = ?").get(meetingId) as { title: string } | undefined;
  if (!row) return;
  const isDefault =
    row.title === "Untitled meeting" || /^Meeting \d/.test(row.title) || /^Quick capture /.test(row.title);
  if (!isDefault) return;

  let title = headline?.trim() ?? "";
  if (!title) {
    // No headline (extraction thin) — fall back to the strongest topic + date.
    const top = db
      .prepare(
        `SELECT e.label FROM entity_mentions m JOIN entities e ON e.id = m.entity_id
         WHERE m.meeting_id = ? AND m.gate = 'passed' AND e.kind = 'topic'
         GROUP BY e.id ORDER BY count(*) DESC, sum(m.score) DESC LIMIT 1`,
      )
      .get(meetingId) as { label: string } | undefined;
    if (!top) return; // nothing to name from — keep the default
    const when = new Date((db.prepare("SELECT started_at FROM meetings WHERE id = ?").get(meetingId) as { started_at: number }).started_at)
      .toLocaleDateString(undefined, { month: "short", day: "numeric" });
    title = `${top.label} — ${when}`;
  }
  if (title.length > 60) title = title.slice(0, 57).trimEnd() + "…";
  db.prepare("UPDATE meetings SET title = ? WHERE id = ?").run(title, meetingId);
}

/** Push Recap's claims through the grounding gate, store both outcomes. */
function storeClaims(db: DatabaseSync, m: MeetingInput, rec: RecapRecord) {
  const gate = groundedIn(m.utterances);
  const ins = db.prepare(
    "INSERT INTO claims (meeting_id, kind, body, offset_s, quote, gate, gate_reason) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );

  type Claim = { kind: string; body: unknown; offset_s?: number; quote?: string };
  const claims: Claim[] = [
    ...(rec.moments ?? []).map((x) => ({ kind: "moment", body: x, offset_s: x.offset_s })),
    ...(rec.risk_signals ?? []).map((x) => ({ kind: "risk", body: x, quote: x.quote })),
    ...(rec.objections ?? []).map((x) => ({ kind: "objection", body: x, quote: x.text })),
    // Decisions/actions have no anchor from Recap; anchor them ourselves by
    // finding the closest moment or matching utterance, else they face the gate bare.
    ...(rec.key_decisions ?? []).map((x) => ({ kind: "decision", body: { text: x }, quote: x })),
    ...(rec.action_items ?? []).map((x) => ({
      kind: "action_item",
      body: { ...x, owner: resolveOwner(m, x.owner, x.task) },
      quote: x.task,
    })),
  ];

  const { kept, blocked } = applyGate(claims, (c) => gate({ quote: c.quote, offset_s: c.offset_s }));
  for (const c of kept) ins.run(m.id, c.kind, JSON.stringify(c.body), c.offset_s ?? null, c.quote ?? null, "passed", null);
  for (const { item: c, reason } of blocked)
    ins.run(m.id, c.kind, JSON.stringify(c.body), c.offset_s ?? null, c.quote ?? null, "blocked", reason);
  return { passed: kept.length, blocked: blocked.length };
}

/**
 * Recap only knows the roles "agent"/"customer"; we know who actually spoke.
 * Map a role back to a name by finding the utterance that best matches the
 * task's words and taking its speaker.
 */
export function resolveOwner(m: MeetingInput, owner: string | null, task: string): string | null {
  if (!owner) return null;
  const role = owner.toLowerCase();
  if (role !== "agent" && role !== "customer") return owner; // already a name
  const words = task.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  let best: { score: number; speaker: string | null } = { score: 0, speaker: null };
  for (const u of m.utterances) {
    if (u.speaker_role !== role || !u.speaker) continue;
    const text = u.text.toLowerCase();
    const score = words.filter((w) => text.includes(w)).length;
    if (score > best.score) best = { score, speaker: u.speaker };
  }
  if (best.speaker) return best.speaker;
  // No text match — fall back to the sole speaker with that role, if unambiguous.
  const speakers = [...new Set(m.utterances.filter((u) => u.speaker_role === role && u.speaker).map((u) => u.speaker!))];
  return speakers.length === 1 ? speakers[0] : owner;
}
