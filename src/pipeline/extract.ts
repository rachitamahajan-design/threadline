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
import { Budget, retry, groundedIn, applyGate, decideExit, type StepRecord } from "../lib/harness.js";
import { upsertNode, addEdge } from "../lib/db.js";

export type MeetingInput = {
  id: string;
  title: string;
  mode: string;
  startedAt: number;
  utterances: Utterance[];
};

export async function processMeeting(db: DatabaseSync, apiKey: string, m: MeetingInput) {
  const budget = new Budget(60, 180_000);
  const steps: StepRecord[] = [];
  const durationS = Math.max(...m.utterances.map((u) => u.offset_s + u.duration_s), 0);

  db.prepare(
    `INSERT INTO meetings (id, title, mode, started_at, duration_s) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET title=excluded.title`,
  ).run(m.id, m.title, m.mode, m.startedAt, durationS);
  const insUtt = db.prepare(
    "INSERT OR REPLACE INTO utterances (meeting_id, idx, speaker, speaker_role, text, offset_s, duration_s) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  m.utterances.forEach((u, i) =>
    insUtt.run(m.id, i, u.speaker ?? null, u.speaker_role, u.text, u.offset_s, u.duration_s),
  );

  // core: Recap. 402s never succeed on retry, so only 429s are retried.
  const recap = await retry(
    "core:recap",
    budget,
    async () => {
      await triggerRecap(apiKey, m.id, m.utterances, durationS);
      budget.spendUnits(1);
      const r = await awaitRecap(apiKey, m.id);
      if (r.status === "failed") throw new Error(r.error ?? "recap failed");
      return r;
    },
    { retryable: (e) => e instanceof PyAIError && e.retryable },
  );
  steps.push(recap.record);

  let stored = { passed: 0, blocked: 0 };
  if (recap.value?.record) {
    stored = storeClaims(db, m, recap.value.record);
    steps.push({
      name: "gate:grounding",
      status: stored.blocked > 0 ? "blocked" : "ok",
      attempts: 1,
      ms: 0,
      reason: stored.blocked > 0 ? `${stored.blocked} claim(s) had no proof in the transcript` : undefined,
    });

    const rec = recap.value.record;
    db.prepare("UPDATE meetings SET headline = ?, summary = ? WHERE id = ?").run(
      recap.value.headline ?? rec.tldr ?? null,
      rec.summary ?? rec.summary_draft ?? null,
      m.id,
    );

    buildGraph(db, m, rec);
    steps.push({ name: "graph:link", status: "ok", attempts: 1, ms: 0 });

    const insSearch = db.prepare("INSERT INTO search (meeting_id, kind, text) VALUES (?, ?, ?)");
    insSearch.run(m.id, "summary", `${m.title} ${rec.summary ?? rec.summary_draft ?? ""}`);
    m.utterances.forEach((u) => insSearch.run(m.id, "utterance", u.text));
    steps.push({ name: "index:fts", status: "ok", attempts: 1, ms: 0 });
  }

  const exit = decideExit(steps, budget);
  db.prepare(
    "INSERT INTO runs (meeting_id, started_at, exit, steps, units_spent) VALUES (?, ?, ?, ?, ?)",
  ).run(m.id, Date.now(), exit, JSON.stringify(steps), budget.spent.units);
  db.prepare("UPDATE meetings SET exit = ? WHERE id = ?").run(exit, m.id);

  return { exit, steps, stored };
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

/** Only real labels become nodes — Recap sometimes emits null/"None" facts. */
function usable(label: unknown): label is string {
  return typeof label === "string" && label.trim().length > 1 && label.trim().toLowerCase() !== "none";
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

/** Meetings, people and topics become nodes; shared entities become edges. */
function buildGraph(db: DatabaseSync, m: MeetingInput, rec: RecapRecord) {
  const meetingNode = upsertNode(db, "meeting", m.id);

  const people = new Set<string>();
  for (const u of m.utterances) if (u.speaker) people.add(u.speaker);
  for (const a of rec.action_items ?? []) {
    const named = resolveOwner(m, a.owner, a.task);
    if (usable(named) && !["agent", "customer"].includes(named.toLowerCase())) people.add(named);
  }
  for (const p of people) addEdge(db, upsertNode(db, "person", p), meetingNode, "attended", m.id);

  for (const d of rec.key_decisions ?? []) {
    if (!usable(d)) continue;
    const topic = d.split(/\s+/).slice(0, 6).join(" ");
    addEdge(db, meetingNode, upsertNode(db, "topic", topic), "mentions", m.id);
  }
  for (const g of rec.coverage_gaps ?? [])
    if ((g.type === "product" || g.type === "name") && usable(g.fact))
      addEdge(db, meetingNode, upsertNode(db, g.type === "name" ? "person" : "topic", g.fact), "mentions", m.id);
}
