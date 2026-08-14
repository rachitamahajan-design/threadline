/**
 * The closed loop: four named outcomes, structured reasons, config-driven
 * budgets, failure invariance, and the intent-inflation gate.
 *
 * The invariant under test throughout: no run exits without a structured
 * record, and nothing ships that the transcript does not state.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { because, reasonFrom, CodedError, OUTCOMES } from "../src/lib/reasons.js";
import { budgetFor, gatePolicy, retryPolicy, costOf, setConfigForTests } from "../src/lib/config.js";
import { Budget, decideExit, retry, type StepRecord } from "../src/lib/harness.js";
import { ModelError, setMockModel } from "../src/lib/model.js";
import { ensureNotes } from "../src/pipeline/handoff.js";
import { NOTES_COMPOSE, promptRef } from "../src/lib/prompts.js";
import { groundingContext } from "../src/lib/grounding.js";
import { repairNotes } from "../src/pipeline/notes-outline.js";
import { entailmentFailures, spotcheckNotes } from "../src/pipeline/entail.js";
import { openDb } from "../src/lib/db.js";
import { beginRun, recordRun, getRun, listRuns } from "../src/lib/runlog.js";
import type { Notes } from "../src/lib/outline.js";
import type { Segment } from "../src/lib/segments.js";
import { scriptModel, clearModel } from "./helpers.js";

process.env.MODEL_PROVIDER = "mock";

afterEach(() => {
  setConfigForTests(null);
  clearModel();
});

// ── Structured reasons ──────────────────────────────────────────────────────

test("the outcome set is closed: exactly four named exits", () => {
  assert.deepEqual([...OUTCOMES], ["shipped", "partial", "deadline", "failed"]);
});

test("thrown errors classify to structured codes, never free strings", () => {
  assert.equal(reasonFrom(new ModelError(429, "slow down")).code, "model-rate-limited");
  assert.equal(reasonFrom(new ModelError(503, "bad gateway")).code, "model-http");
  assert.equal(reasonFrom(new ModelError(0, 'model call "notes" timed out after 60000ms')).code, "model-timeout");
  assert.equal(reasonFrom(new ModelError(0, "PYAI_API_KEY is not set — cannot reach the model")).code, "model-unconfigured");
  assert.equal(reasonFrom(new Error("model did not return JSON: hello")).code, "model-bad-json");
  // Undici's bare fetch failure — the shape /api/chat dies with when offline.
  const fetchFail = new TypeError("fetch failed");
  (fetchFail as { cause?: unknown }).cause = new Error("getaddrinfo ENOTFOUND api.openai.com");
  assert.equal(reasonFrom(fetchFail).code, "network-failed");
  assert.match(reasonFrom(fetchFail).detail ?? "", /ENOTFOUND/); // the cause survives into the record
  assert.equal(reasonFrom(new Error("connect ECONNREFUSED 127.0.0.1:443")).code, "network-failed");
  assert.equal(reasonFrom(new CodedError("grounding-blocked", "2 failures")).code, "grounding-blocked");
  assert.equal(reasonFrom("boom").code, "crash");
  // The detail survives for humans and repair prompts.
  assert.equal(reasonFrom(new CodedError("grounding-blocked", "2 failures")).detail, "2 failures");
});

// ── Budget governor + config ────────────────────────────────────────────────

test("budgets are config: agents.json sizes the governor per workflow", () => {
  setConfigForTests({ budgets: { workflows: { notes: { units: 2, ms: 99 } } } });
  assert.deepEqual(budgetFor("notes"), { units: 2, ms: 99 });
  // Unconfigured workflows keep their code defaults.
  assert.equal(budgetFor("ask").units, 3);
  const b = Budget.for("notes");
  assert.equal(b.maxUnits, 2);
  assert.equal(b.maxMs, 99);
});

test("an exhausted governor stops the run with a structured reason and a deadline exit", async () => {
  const spent = new Budget(1, 60_000);
  spent.spendUnits(1);
  assert.equal(spent.check()?.code, "budget-exhausted");
  assert.equal(decideExit([], spent), "deadline");

  const late = new Budget(10, -1); // deadline already passed
  assert.equal(late.check()?.code, "deadline-exceeded");
  assert.equal(decideExit([], late), "deadline");

  // retry refuses to even start a step once the governor says stop.
  const r = await retry("step", spent, async () => "never");
  assert.equal(r.value, null);
  assert.equal(r.record.status, "skipped");
  assert.equal(r.record.reason?.code, "budget-exhausted");
});

test("retry policy is config, and retries are aimed with the last failure", async () => {
  setConfigForTests({ retry: { max_attempts: 2, base_delay_ms: 1 } });
  const seen: (string | null)[] = [];
  const r = await retry("step", new Budget(10, 60_000), async (attempt, lastError) => {
    seen.push(lastError);
    if (attempt === 1) throw new CodedError("grounding-blocked", "S1 misquoted the price");
    return "ok";
  });
  assert.equal(r.value, "ok");
  assert.equal(r.record.status, "retried");
  // Attempt 2 was told exactly what failed — a retry that isn't is a dice roll.
  assert.deepEqual(seen, [null, "S1 misquoted the price"]);
});

test("a non-retryable failure records its structured reason and gives up at once", async () => {
  let attempts = 0;
  const r = await retry(
    "step",
    new Budget(10, 60_000),
    async () => {
      attempts++;
      throw new ModelError(400, "bad request never heals");
    },
    { retryable: (e) => e instanceof ModelError && e.retryable },
  );
  assert.equal(attempts, 1);
  assert.equal(r.record.status, "failed");
  assert.equal(r.record.reason?.code, "model-http");
});

test("model pricing is config: costOf reads the table", () => {
  setConfigForTests({ models: { pricing: { "test-model": { in: 1, out: 2 } } } });
  assert.equal(costOf("test-model", 1000, 500), 1 + 1); // 1k in @ $1 + 0.5k out @ $2
  assert.equal(costOf("unpriced", 1000, 500), 0);
});

// ── Prompts are config ──────────────────────────────────────────────────────

test("prompt templates load from config/prompts.json with their version stamp", () => {
  assert.match(promptRef(NOTES_COMPOSE), /^notes\.compose@v\d+\+r\d+$/);
  const built = NOTES_COMPOSE.build({ participants: "Rachita, Maya", type: "investor", facts: "[]" });
  assert.ok(built.includes("PARTICIPANTS: Rachita, Maya"));
  assert.ok(built.includes("MEETING_TYPE: investor"));
  assert.ok(built.includes("traction and metrics quoted")); // investor theme guide
  assert.ok(!built.includes("{{")); // every placeholder resolved
});

// ── The entailment gate, blocking per config ────────────────────────────────
// This is the "does the summary match its source" check: paraphrase drift like
// "Let's launch this product" → "wants to launch as soon as possible" is caught
// here by the model-judged support verdict, not by keyword rules.

const launchSegments: Segment[] = [
  { id: "S001", speaker: "Rachita", startMs: 0, endMs: 5000, text: "Let's launch this product.", confidence: 1 },
  { id: "S002", speaker: "Maya", startMs: 6000, endMs: 11000, text: "I want to ship the beta as soon as possible.", confidence: 1 },
];

test("unsupported entailment verdicts become prunable gate failures", async () => {
  scriptModel({
    "entail.spotcheck": [
      { verdicts: [{ i: 1, supported: false, why: "the segment proposes a launch, not a desire" }, { i: 2, supported: true, why: "" }] },
    ],
  });
  const ctx = groundingContext({ segments: launchSegments, participants: ["Rachita", "Maya"] });
  const notes: Notes = {
    themes: [
      {
        text: "Launch",
        children: [
          { text: "Everyone is aligned on launching", source: ["S001"] },
          { text: "Rachita proposed launching the product", source: ["S001"] },
        ],
      },
    ],
  };
  const check = await spotcheckNotes(notes, ctx);
  assert.equal(check.flagged, 1);
  const failures = entailmentFailures(check.verdicts);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].rule, "entailment-unsupported");
  const { value, dropped } = repairNotes(notes, failures);
  assert.equal(dropped, 1);
  assert.deepEqual(value.themes[0].children!.map((b) => b.text), ["Rachita proposed launching the product"]);
});

test("a checker that dies deletes nothing and reports a structured reason", async () => {
  scriptModel({}); // no scripted response → the mock throws
  const ctx = groundingContext({ segments: launchSegments, participants: ["Rachita"] });
  const notes: Notes = { themes: [{ text: "Launch", children: [{ text: "A launch was proposed", source: ["S001"] }] }] };
  const check = await spotcheckNotes(notes, ctx);
  assert.equal(check.flagged, 0);
  assert.ok(check.error, "the failure must be visible, not swallowed");
  assert.deepEqual(notes.themes[0].children!.length, 1);
});

test("gates are config: entailment defaults to blocking", () => {
  assert.equal(gatePolicy().entailment, "blocking");
  setConfigForTests({ gates: { entailment: "advisory" } });
  assert.equal(gatePolicy().entailment, "advisory");
});

// ── Failure invariance: every run leaves a record ───────────────────────────

const dir = mkdtempSync(path.join(tmpdir(), "threadline-runlog-"));
const db = openDb(dir);

test("a run's record exists from the moment it starts — a crash leaves the truth behind", () => {
  const run = beginRun(db, { kind: "notes", meetingId: "m1", args: { refine: null } });
  // Before finish (i.e. what disk holds if the process dies right now):
  const inFlight = getRun(db, run.id)!;
  assert.equal(inFlight.outcome, "failed");
  assert.equal(inFlight.failure?.code, "crash");
  assert.equal(inFlight.endedAt, null);

  const steps: StepRecord[] = [{ name: "compose:notes", status: "ok", attempts: 1, ms: 5 }];
  run.finish({ outcome: "shipped", steps, failure: null, unitsSpent: 3 });
  const done = getRun(db, run.id)!;
  assert.equal(done.outcome, "shipped");
  assert.equal(done.failure, null);
  assert.ok(done.endedAt !== null);
  assert.equal(done.unitsSpent, 3);
  assert.deepEqual(done.steps, steps);
});

test("recordRun finalizes the record even when the workflow throws, then rethrows", async () => {
  await assert.rejects(
    recordRun(
      db,
      { kind: "handoff", meetingId: "m2", args: { handoffId: "x" } },
      async () => {
        throw new ModelError(0, 'model call "handoff" timed out after 60000ms');
      },
      () => ({ outcome: "shipped", steps: [] }),
    ),
  );
  const [latest] = listRuns(db, "m2", 1);
  assert.equal(latest.outcome, "failed");
  assert.equal(latest.failure?.code, "model-timeout");
  assert.ok(latest.endedAt !== null, "the crash record is finalized, not left dangling");
  assert.deepEqual(latest.args, { handoffId: "x" }); // the retry button knows what to re-run
});

test("recordRun maps the workflow's own result onto the closed outcome set", async () => {
  const res = await recordRun(
    db,
    { kind: "ask", meetingId: "", args: { q: "what changed?" } },
    async () => ({ exit: "partial" as const, steps: [] as StepRecord[] }),
    (r) => ({ outcome: r.exit, steps: r.steps, failure: because("grounding-blocked", "1 point had no receipt") }),
  );
  assert.equal(res.exit, "partial");
  const [latest] = listRuns(db, "", 1);
  assert.equal(latest.kind, "ask");
  assert.equal(latest.outcome, "partial");
  assert.equal(latest.failure?.code, "grounding-blocked");
});

test("a 404ing provider fails over to the other one, silently", async () => {
  const realFetch = globalThis.fetch;
  const env = { ...process.env };
  process.env.MODEL_PROVIDER = "pyai";
  process.env.PYAI_API_KEY = "pyai_test";
  process.env.OPENAI_API_KEY = "sk-test";
  const hit: string[] = [];
  globalThis.fetch = (async (url: unknown) => {
    hit.push(String(url));
    if (String(url).includes("api.pyai.com")) return new Response("not found", { status: 404 });
    return new Response(
      JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 5, completion_tokens: 3 } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const { chatJson, recentUsage } = await import("../src/lib/model.js");
    const raw = await chatJson({ purpose: "notes", system: "s", user: "u" });
    assert.deepEqual(raw, { ok: true }); // the caller never saw the 404
    assert.ok(hit.some((u) => u.includes("api.pyai.com")) && hit.some((u) => u.includes("api.openai.com")));
    const last = recentUsage().at(-1)!;
    assert.equal(last.provider, "openai"); // the record says who really answered
    assert.equal(last.tokensIn, 5);
  } finally {
    globalThis.fetch = realFetch;
    for (const k of ["MODEL_PROVIDER", "PYAI_API_KEY", "OPENAI_API_KEY"]) {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
  }
});

test("a dead model is an outcome, not a crash: ensureNotes fails closed with a record", async () => {
  db.prepare("INSERT INTO meetings (id, title, mode, started_at) VALUES ('m404', 'T', 'discovery', 1)").run();
  db.prepare(
    "INSERT OR REPLACE INTO utterances (meeting_id, idx, speaker, speaker_role, text, offset_s, duration_s) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run("m404", 0, "Rachita", "agent", "Let's launch this product.", 0, 5);
  // The exact failure from the field: the model host 404s on every call.
  setMockModel(() => {
    throw new ModelError(404, "pyai chat failed: HTTP 404");
  });

  // Must resolve, not reject — a throw here is what used to kill the server.
  const res = await ensureNotes(db, "m404", { force: true });
  assert.ok(res.error, "the failure is reported, not thrown");
  assert.equal(res.outline, null);

  const [latest] = listRuns(db, "m404", 1);
  assert.equal(latest.kind, "notes");
  assert.equal(latest.outcome, "failed");
  assert.equal(latest.failure?.code, "model-http");
  assert.ok(latest.endedAt !== null);
  // And the extraction step is on the record with its structured reason.
  assert.ok(latest.steps.some((s) => s.name === "extract:facts" && s.reason?.code === "model-http"));
});

test("cleanup", () => {
  rmSync(dir, { recursive: true, force: true });
});
