/**
 * The two-pass pipeline under a hostile model.
 *
 * The scripted model here plays the part of the weak model we actually ship on:
 * it invents owners, misquotes prices, cites segments that do not exist, and
 * fills in sections nobody discussed. Every test asserts the same thing from a
 * different angle — none of that reaches the user.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { compose } from "../src/pipeline/grounded.js";
import { generateNotes, notesSpec, repairNotes } from "../src/pipeline/notes-outline.js";
import { sanitizeStatements, extractStatements, statementsForPrompt } from "../src/pipeline/statements.js";
import { isSoft, validateNotes } from "../src/lib/grounding.js";
import { countLeaves, dedupeLeaves, walkLeaves } from "../src/lib/outline.js";
import { investor, team, vendor } from "./fixtures.js";
import { clearModel, ctxFor, statementsResponseFor, scriptModel } from "./helpers.js";

const statementsOf = (fx: typeof investor) => sanitizeStatements(statementsResponseFor(fx), ctxFor(fx)).statements;

test.afterEach(() => clearModel());

// ── Pass 1 ──────────────────────────────────────────────────────────────────

test("extraction drops statements that cite nothing, cite the dead, or misquote", () => {
  const ctx = ctxFor(vendor);
  const set = sanitizeStatements(
    {
      statements: [
        { text: "Platform license is forty eight thousand dollars a year", kind: "number", source: ["S002"] },
        { text: "Platform license is fifty two thousand dollars a year", kind: "number", source: ["S002"] }, // misheard
        { text: "There is a 10% discount for annual prepay", kind: "number", source: ["S002"] }, // invented
        { text: "Dev promised a pilot", kind: "other", source: ["S099"] }, // dead source
        { text: "Something happened", kind: "other", source: [] }, // no source
        { text: 'Dev said "I cannot quote it today"', kind: "quote", source: ["S007"] },
        { text: 'Dev said "we will discount that heavily"', kind: "quote", source: ["S007"] }, // fake quote
      ],
    },
    ctx,
  );
  assert.equal(set.statements.length, 2);
  assert.deepEqual(
    set.dropped.map((d) => d.reason.split(":")[0]),
    ["figure/date not in cited text", "figure/date not in cited text", "cites segments that do not exist", "no source segment ids", "quoted span is not verbatim in one cited segment"],
  );
  // Ids are assigned after sanitising, so they are dense and stable.
  assert.deepEqual(set.statements.map((f) => f.id), ["ST1", "ST2"]);
});

test("extraction refuses an attribution to someone who was not there", () => {
  const set = sanitizeStatements(
    { statements: [{ text: "The tiers are being rebuilt", kind: "other", source: ["S003"], speaker: "Jordan" }] },
    ctxFor(investor),
  );
  assert.equal(set.statements[0].speaker, undefined);
});

test("extraction recomputes heardPoorly from STT rather than trusting the model", async () => {
  const ctx = ctxFor(vendor);
  const set = sanitizeStatements(
    { statements: [{ text: "Overage is nine dollars per seat per month", kind: "number", source: ["S003"], heardPoorly: true }] },
    ctx,
  );
  assert.equal(set.statements[0].heardPoorly, undefined, "S003 was heard fine, so the flag is dropped");

  // And the round trip through the real extract pass keeps the prompt honest.
  scriptModel({ "statements.extract": [statementsResponseFor(vendor)] });
  const { set: live } = await extractStatements(vendor.segments, ctx, { type: "vendor", participants: vendor.participants });
  assert.ok(live.statements.length >= 4);
  assert.match(live.promptVersion, /^statements\.extract@v\d+\+r\d+$/);
  assert.match(statementsForPrompt(live.statements), /^\[{"text"/);
});

// ── Pass 2 ──────────────────────────────────────────────────────────────────

test("a clean compose ships on the first attempt", async () => {
  const { calls } = scriptModel({ notes: [investor.goldNotes] });
  const out = await compose(notesSpec({ type: "investor", participants: investor.participants }), statementsOf(investor), ctxFor(investor));
  assert.equal(out.needsReview, false);
  assert.equal(out.attempts, 1);
  assert.equal(out.dropped, 0);
  assert.deepEqual(out.failures, []);
  assert.equal(out.value?.themes.length, 3);
  assert.match(out.promptVersion, /^notes\.compose@v\d+\+r\d+$/);
  assert.equal(calls.length, 1);
});

test("an invalid compose is regenerated with the validator's own words", async () => {
  const bad = {
    themes: [
      {
        text: "Pricing",
        children: [
          { text: "ANZ pricing moved to August", source: ["S001"] }, // wrong month
          { text: "Prospecting table covers 400 companies", source: ["S005"] }, // wrong number
        ],
      },
    ],
  };
  const { calls } = scriptModel({ notes: [bad, bad, investor.goldNotes] });
  const out = await compose(notesSpec({ type: "investor", participants: investor.participants }), statementsOf(investor), ctxFor(investor));

  assert.equal(out.needsReview, false, "the third attempt was clean, so nothing needs review");
  assert.equal(out.attempts, 3);
  assert.equal(calls.length, 3);
  // The retry prompt carries the specific failures, not a generic scolding.
  assert.match(calls[1].user, /REJECTED by a deterministic validator/);
  assert.match(calls[1].user, /August/);
  assert.match(calls[1].user, /attempt 2 of 3/);
});

test("when every attempt fails, invalid bullets are pruned and the output is flagged", async () => {
  const bad = {
    themes: [
      {
        text: "ANZ pricing",
        children: [
          { text: "ANZ pricing moved to September", source: ["S001"] }, // good
          { text: "Prospecting table covers 400 companies", source: ["S005"] }, // bad number
          { text: "Maya committed to a follow-on cheque", source: ["S042"] }, // dead source
        ],
      },
    ],
  };
  scriptModel({ notes: [bad] });
  const out = await compose(notesSpec({ type: "investor", participants: investor.participants }), statementsOf(investor), ctxFor(investor));

  assert.equal(out.needsReview, true, "the user must be told this came back thin");
  assert.equal(out.attempts, 3, "it tried three times before giving up");
  assert.equal(out.dropped, 2);
  assert.equal(countLeaves(out.value!), 1);
  // "ANZ pricing" is not one of the five sections, so it became a Discussion
  // topic; the one true bullet is still under it.
  assert.equal(out.value!.themes[0].text, "Discussion");
  const survivors: string[] = [];
  walkLeaves(out.value!, (leaf) => survivors.push(leaf.text));
  assert.deepEqual(survivors, ["ANZ pricing moved to September"]);
  // The invariant that matters: what ships is clean, whatever the model did.
  assert.deepEqual(validateNotes(out.value!, ctxFor(investor)), []);
  assert.ok(out.failures.length >= 2, "the reasons are kept for the debug drawer");
  assert.ok(out.steps.some((s) => s.status === "blocked"));
});

test("a repeated bullet becomes one bullet with both receipts", () => {
  // A weak model says the same thing twice when a fact was said twice. Merging
  // is mechanical, so code does it: same claim, both citations, one line.
  const notes = {
    themes: [
      {
        text: "Pricing",
        children: [
          { text: "The pricing is eighty dollars per seat per month.", source: ["S003"], lowConfidence: true },
          { text: "the pricing is eighty dollars per seat per month", source: ["S004"] },
          { text: "The pilot can start in March", source: ["S006"] },
        ],
      },
    ],
  };
  assert.equal(dedupeLeaves(notes), 1);
  assert.equal(notes.themes[0].children.length, 2);
  assert.deepEqual(notes.themes[0].children[0].source, ["S003", "S004"]);
  // One clean citation is enough to stop calling the merged claim shaky.
  assert.equal(notes.themes[0].children[0].lowConfidence, undefined);
});

test("a bullet that drops its source's figure is a style note, not a rejection", async () => {
  const titleish = {
    themes: [
      {
        text: "Burn and runway",
        // Both cite S007 ("one hundred eighty thousand a month ... fourteen months")
        // and neither carries a number: useless, but not untrue.
        children: [{ text: "Net burn rate" }, { text: "Runway duration" }].map((b) => ({ ...b, source: ["S007"] })),
      },
    ],
  };
  const ctx = ctxFor(investor);
  const failures = validateNotes(titleish, ctx);
  assert.equal(failures.length, 2);
  assert.ok(failures.every((f) => f.rule === "bullet-is-a-title" && isSoft(f)));

  // It drives a regeneration, but if the model will not do better the bullets
  // still ship — and the "please review" banner stays off, because nothing here
  // is ungrounded.
  scriptModel({ notes: [titleish] });
  const out = await compose(notesSpec({ type: "investor", participants: investor.participants }), statementsOf(investor), ctx);
  assert.equal(out.needsReview, false, "a style note must not read as a grounding problem");
  assert.equal(countLeaves(out.value!), 2, "nothing was deleted for being terse");
  assert.equal(out.attempts, 2, "one corrective pass, not the full retry budget");
  assert.ok(out.failures.every(isSoft));
});

test("a bad theme label is flattened, and its valid children survive", () => {
  const notes = {
    themes: [
      {
        text: "Pricing slipped to August",
        children: [
          { text: "Enterprise prospects want usage based tiers instead of per seat pricing", source: ["S003"] },
          { text: "The tiers are being rebuilt", source: ["S003"] },
        ],
      },
    ],
  };
  const ctx = ctxFor(investor);
  const failures = validateNotes(notes, ctx);
  assert.equal(failures.length, 1);

  const repaired = repairNotes(notes, failures);
  assert.equal(repaired.value.themes.length, 2, "children moved up a level");
  assert.equal(countLeaves(repaired.value), 2, "no real bullet was lost");
  assert.deepEqual(validateNotes(repaired.value, ctx), []);
});

test("nothing ships without a valid source, ever", async () => {
  // Every leaf is unsourced or dead-sourced: the correct output is nothing.
  scriptModel({
    notes: [
      {
        themes: [
          { text: "Pricing", children: [{ text: "Pricing is going up", source: ["S404"] }] },
          { text: "Team", children: [{ text: "Everyone is aligned", source: ["S405"] }] },
        ],
      },
    ],
  });
  const out = await compose(notesSpec({ type: "investor", participants: investor.participants }), statementsOf(investor), ctxFor(investor));
  assert.equal(countLeaves(out.value!), 0);
  assert.equal(out.value!.themes.length, 0);
  assert.equal(out.needsReview, true);
});

test('"not discussed" stays not discussed — no next steps are invented', async () => {
  // The team fixture has an unanswered question and one real commitment. The
  // model is scripted to invent two more, sourced to segments that never said so.
  const gold = team.goldHandoff!.value as { themes: unknown[] };
  const inventive = {
    themes: gold.themes,
    nextSteps: [
      { text: "Send the tier comparison", owner: "Sharon", due: "by Thursday", source: ["S006"] },
      { text: "Book the ANZ launch review for October 3", owner: "Rachita", due: "October 3", source: ["S005"] },
      { text: "Sign off the pricing deck", owner: "Marketing", due: null, source: ["S005"] },
    ],
    openQuestions: [{ text: "Do we tell the design partners now, or after the rebuild?", source: ["S007"] }],
  };
  const { getHandoff } = await import("../src/handoffs/registry.js");
  const def = getHandoff("summary_next_steps")!;
  const value = def.parse(inventive);
  assert.notEqual(typeof value, "string", `parse failed: ${value}`);
  const ctx = ctxFor(team);
  const failures = def.validate(value, ctx);
  const pruned = def.prune(value, failures, ctx);

  assert.equal(pruned.value.nextSteps.length, 1, "only the commitment that was actually made survives");
  assert.equal(pruned.value.nextSteps[0].owner, "Sharon");
  assert.equal(pruned.value.openQuestions.length, 1, "a real open question is kept, not answered");
  assert.deepEqual(def.validate(pruned.value, ctx), []);
});

test("no statements means an empty outline, not a hallucinated one", async () => {
  const out = await generateNotes([], ctxFor(investor), { type: "investor", participants: investor.participants });
  assert.deepEqual(out.value, { themes: [] });
  assert.equal(out.needsReview, true);
  assert.equal(out.steps[0].status, "skipped");
});

test("every leaf that ships carries a source that exists", async () => {
  scriptModel({ notes: [investor.goldNotes] });
  const out = await compose(notesSpec({ type: "investor", participants: investor.participants }), statementsOf(investor), ctxFor(investor));
  const ctx = ctxFor(investor);
  let leaves = 0;
  walkLeaves(out.value!, (leaf) => {
    leaves++;
    assert.ok(leaf.source && leaf.source.length > 0);
    for (const id of leaf.source!) assert.ok(ctx.index.has(id), `${id} must exist`);
  });
  assert.equal(leaves, 7);
});

test("a model that returns prose instead of JSON fails honestly", async () => {
  scriptModel({ notes: ["I'm sorry, I can't help with that." as unknown] });
  const out = await compose(notesSpec({ type: "investor", participants: investor.participants }), statementsOf(investor), ctxFor(investor));
  assert.equal(out.value, null);
  assert.equal(out.needsReview, true);
  assert.match(out.error ?? "", /schema|themes/i);
});
