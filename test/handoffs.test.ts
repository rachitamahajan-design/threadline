/**
 * Handoffs: the taxonomy, the shapes, and what each one refuses.
 *
 * The shape assertions are the snapshot tests — a Handoff whose output keys or
 * markdown sections move breaks a test here, because downstream copy/paste and
 * the UI cards depend on both.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_HANDOFF,
  SUGGESTED_HANDOFFS,
  aliasSegments,
  inlineSources,
  stripSourceMarkers,
} from "../src/handoffs/types.js";
import {
  HANDOFFS,
  defaultHandoffFor,
  getHandoff,
  handoffCatalog,
  matchHandoff,
  suggestedHandoffsFor,
} from "../src/handoffs/registry.js";
import { countLeaves, normalizeSections, type Notes } from "../src/lib/outline.js";
import { groundingContext, validateNotes } from "../src/lib/grounding.js";
import type { MeetingType } from "../src/lib/segments.js";
import { customer, investor, oneOnOne, team, vendor, FIXTURES } from "./fixtures.js";
import { ctxFor } from "./helpers.js";

const META = { title: "Test meeting", when: "Aug 13, 2026" };

// ── §3 taxonomy ─────────────────────────────────────────────────────────────

test("each meeting type leads with the handoff the taxonomy says", () => {
  const expected: Record<MeetingType, string> = {
    investor: "team_actions",
    vendor: "pricing_quote",
    customer: "followup_email",
    team: "summary_next_steps",
    one_on_one: "candidate_feedback",
  };
  for (const [type, id] of Object.entries(expected) as [MeetingType, string][]) {
    assert.equal(defaultHandoffFor(type)?.id, id);
    assert.equal(DEFAULT_HANDOFF[type], id);
  }
});

test("every meeting type suggests 2-3 handoffs, all of which exist", () => {
  for (const [type, ids] of Object.entries(SUGGESTED_HANDOFFS) as [MeetingType, string[]][]) {
    assert.ok(ids.length >= 2 && ids.length <= 3, `${type} should suggest 2-3, got ${ids.length}`);
    assert.equal(ids[0], DEFAULT_HANDOFF[type], `${type}'s first suggestion is its default`);
    assert.deepEqual(suggestedHandoffsFor(type).map((h) => h.id), ids, `${type}'s suggestions must all resolve`);
  }
});

test("the catalog marks the suggestions and offers everything else", () => {
  const catalog = handoffCatalog("vendor");
  assert.equal(catalog.length, HANDOFFS.length);
  assert.deepEqual(catalog.filter((h) => h.isDefault).map((h) => h.id), ["pricing_quote"]);
  assert.deepEqual(
    catalog.filter((h) => h.suggested).map((h) => h.id).sort(),
    [...SUGGESTED_HANDOFFS.vendor].sort(),
  );
  // Non-suggestions are still runnable — that is the point of the menu.
  assert.ok(catalog.some((h) => h.id === "crm_note" && !h.suggested));
  // The stamp carries both the template version and the shared-rules version,
  // so one edit to GROUNDING_RULES is visible on every output.
  for (const h of catalog) assert.match(h.promptVersion, /^handoff\.\w+@v\d+\+r\d+$/);
  assert.equal(catalog.filter((h) => h.scope === "cross-meeting").length, 1);
});

test("natural language routes to a handoff, and unrelated questions do not", () => {
  assert.equal(matchHandoff("draft the follow-up email")?.id, "followup_email");
  assert.equal(matchHandoff("can you pull the pricing quote out of this")?.id, "pricing_quote");
  assert.equal(matchHandoff("what are the action items?")?.id, "team_actions");
  assert.equal(matchHandoff("summarise this for the team")?.id, "summary_next_steps");
  assert.equal(matchHandoff("write up the interview feedback")?.id, "candidate_feedback");
  assert.equal(matchHandoff("what keeps coming up across my customer calls")?.id, "collated_feedback");
  assert.equal(matchHandoff("draft the investor update")?.id, "investor_update");
  assert.equal(matchHandoff("write a crm note for this call")?.id, "crm_note");
  assert.equal(matchHandoff("give me the negotiation brief")?.id, "negotiation_brief");
  assert.equal(matchHandoff("write the slack update")?.id, "slack_update");
  // "1:1 recap" names its own artefact — it must not fall through to the
  // generic team readout just because "recap" appears in both.
  assert.equal(matchHandoff("write the 1:1 recap")?.id, "one_on_one_recap");
  // Ordinary questions fall through to grounded Q&A.
  assert.equal(matchHandoff("why did we delay ANZ?"), undefined);
  assert.equal(matchHandoff("who was on this call?"), undefined);
});

test("a question about a topic is answered, not turned into a handoff", () => {
  // Regression: matching a bare "pricing" turned this question into a quote
  // extraction. Naming a subject is not asking for a deliverable.
  assert.equal(matchHandoff("why did ANZ pricing move?"), undefined);
  assert.equal(matchHandoff("how did the pricing conversation go?"), undefined);
  assert.equal(matchHandoff("why did they quote that number?"), undefined);
  assert.equal(matchHandoff("who owns the pricing rebuild?"), undefined);
  assert.equal(matchHandoff("when is the follow up call?"), undefined);

  // ...while an actual request for the artefact still routes, question mark or not.
  assert.equal(matchHandoff("pull the pricing quote out of this")?.id, "pricing_quote");
  assert.equal(matchHandoff("what did they quote?")?.id, "pricing_quote");
  assert.equal(matchHandoff("can you draft the follow-up email?")?.id, "followup_email");
  assert.equal(matchHandoff("how about you draft the follow up email")?.id, "followup_email");
  assert.equal(matchHandoff("what are the action items?")?.id, "team_actions");
});

test("every registered handoff is fully formed", () => {
  for (const h of HANDOFFS) {
    assert.ok(h.id && h.label && h.blurb && h.tone, `${h.id} needs its metadata`);
    assert.ok(h.groundingRules.length > 0, `${h.id} must state its extra rules`);
    assert.equal(typeof h.parse, "function");
    assert.equal(typeof h.validate, "function");
    assert.equal(typeof h.prune, "function");
    assert.equal(typeof h.toMarkdown, "function");
    // Every prompt bakes in the shared grounding rules.
    const built = h.prompt.build({ statements: "[]", participants: "A, B", type: "team" });
    assert.match(built, /Grounding rules/);
    assert.match(built, /EXTRACTED_STATEMENTS/);
  }
});

// ── Gold outputs: shape + clean validation ──────────────────────────────────

test("gold handoff outputs parse, validate clean, and render without receipts", () => {
  for (const fx of FIXTURES.filter((f) => f.goldHandoff)) {
    const def = getHandoff(fx.goldHandoff!.id)!;
    const value = def.parse(fx.goldHandoff!.value);
    assert.notEqual(typeof value, "string", `${fx.id}/${def.id} should parse: ${value}`);
    const ctx = ctxFor(fx);
    assert.deepEqual(def.validate(value, ctx), [], `${fx.id}/${def.id} gold output should validate clean`);
    def.finalize?.(value, ctx);
    const md = def.toMarkdown(value, META);
    assert.ok(md.length > 20, `${def.id} markdown should be substantial`);
    assert.ok(!/\[S\d{3}(,|\])/.test(md), `${def.id} markdown must not leak segment ids`);
  }
});

test("investor → per-owner action items, one copyable block per owner", () => {
  const def = getHandoff("team_actions")!;
  const value = def.parse(investor.goldHandoff!.value) as { perOwner: { owner: string; items: unknown[] }[] };
  assert.deepEqual(value.perOwner.map((g) => g.owner), ["Rachita", "Prabhav"]);
  const blocks = def.blocks!(value);
  assert.deepEqual(blocks.map((b) => b.label), ["Rachita", "Prabhav"]);
  assert.match(blocks[1].markdown, /Own the tier rebuild/);
  assert.match(def.toMarkdown(value, META), /### Rachita/);
});

test("vendor → a price table plus an explicit not-quoted list", () => {
  const def = getHandoff("pricing_quote")!;
  const value = def.parse(vendor.goldHandoff!.value) as { quotes: unknown[]; unclear: unknown[] };
  assert.equal(value.quotes.length, 2);
  assert.equal(value.unclear.length, 1);
  const md = def.toMarkdown(value, META);
  assert.match(md, /\| Item \| Price \| Unit \| Terms \| Valid until \|/);
  assert.match(md, /Not quoted \/ unclear/);
  assert.match(md, /Onboarding is a separate statement of work/);
});

test("customer → an email whose factual lines are sourced and whose copy is clean", () => {
  const def = getHandoff("followup_email")!;
  const value = def.parse(customer.goldHandoff!.value) as { subject: string; body: string };
  assert.match(value.subject, /Following up/);
  // Stored body keeps receipts; the clipboard version does not.
  assert.ok(inlineSources(value.body).includes("S003"));
  const md = def.toMarkdown(value, META);
  assert.ok(!md.includes("[S00"), "copied email carries no segment ids");
  assert.match(md, /^Subject: /);
  assert.match(md, /migration plan by Friday/);
});

test("1:1 → feedback that keeps a stated lean and never invents one", () => {
  const def = getHandoff("candidate_feedback")!;
  const ctx = ctxFor(oneOnOne);
  const value = def.parse(oneOnOne.goldHandoff!.value) as { statedLean: { text: string } | null };
  assert.match(value.statedLean!.text, /yes from me/);

  // Same transcript, but the model asserts a verdict nobody stated.
  const invented = def.parse({
    signals: [{ text: "Rewrote the batch pipeline and cut p95 latency from 900 to 120 milliseconds", source: ["S002"] }],
    strengths: [],
    concerns: [],
    statedLean: { text: "Strong hire, we should move fast", source: ["S002"] },
  });
  const failures = def.validate(invented, ctx);
  assert.ok(failures.some((f) => f.path === "statedLean"), "an unsupported verdict must fail");
  const pruned = def.prune(invented, failures, ctx);
  assert.equal(pruned.value.statedLean, null, "no verdict is better than a fabricated one");
  assert.match(def.toMarkdown(pruned.value, META), /None stated on the call/);
});

// ── What each handoff refuses ───────────────────────────────────────────────

test("an invented owner takes its item down with it", () => {
  const def = getHandoff("team_actions")!;
  const ctx = ctxFor(investor);
  const value = def.parse({
    perOwner: [
      { owner: "Rachita", items: [{ text: "Share the prospecting table", owner: "Rachita", due: "by end of month", source: ["S005"] }] },
      { owner: "Growth team", items: [{ text: "Build the funnel dashboard", owner: "Growth team", due: null, source: ["S005"] }] },
    ],
  });
  const failures = def.validate(value, ctx);
  assert.ok(failures.some((f) => f.rule === "owner-whitelist"));
  const pruned = def.prune(value, failures, ctx);
  assert.equal(pruned.value.perOwner.length, 1);
  assert.equal(pruned.value.perOwner[0].owner, "Rachita");
  assert.equal(pruned.dropped, 1);
  assert.deepEqual(def.validate(pruned.value, ctx), []);
});

test("a price that is not verbatim is dropped from the table, not softened", () => {
  const def = getHandoff("pricing_quote")!;
  const ctx = ctxFor(vendor);
  const value = def.parse({
    quotes: [
      { item: "Platform license", price: "$48,000", unit: "a year", terms: "twelve month minimum", validUntil: "September 30", source: ["S002", "S005"] },
      { item: "Support", price: "$5,000", unit: "a year", terms: "", validUntil: null, source: ["S002"] }, // never said
    ],
    unclear: [],
  });
  const failures = def.validate(value, ctx);
  assert.equal(failures.filter((f) => f.rule === "verbatim-number").length, 1);
  const pruned = def.prune(value, failures, ctx);
  assert.equal(pruned.value.quotes.length, 1);
  assert.equal(pruned.dropped, 1);
  const md = def.toMarkdown(pruned.value, META);
  assert.ok(!md.includes("5,000"), "the invented price appears nowhere, not even softened");
  assert.ok(!/around|approximately|~\$/.test(md));
});

test("the readout always comes back in its five sections", () => {
  // The model is told to use exactly these and still returns its own headings, so
  // code puts them where they belong instead of asking again.
  const messy: Notes = {
    summary: { text: "ANZ pricing moved to September.", source: ["S001"] },
    themes: [
      { text: "Pricing", children: [{ text: "ANZ pricing moved to September", source: ["S001"] }] },
      { text: "Next steps", children: [{ text: "Rachita: share the tier model by end of month", source: ["S005"] }] },
      { text: "Decisions", children: [{ text: "The tiers are being rebuilt", source: ["S003"] }] },
      // A second, differently-worded action section folds into the first.
      { text: "Action Items:", children: [{ text: "Prabhav: own the tier rebuild", source: ["S008"] }] },
      // A bare top-level leaf still has to land somewhere.
      { text: "Runway is fourteen months", source: ["S007"] },
    ],
  };
  const out = normalizeSections(messy);
  assert.deepEqual(out.themes.map((t) => t.text), ["Discussion", "Decisions", "Action items"]);
  assert.equal(out.summary?.text, messy.summary!.text);
  // Stray sections and stray leaves both became Discussion topics/points.
  assert.deepEqual(out.themes[0].children!.map((c) => c.text), ["Pricing", "Runway is fourteen months"]);
  // Both action wordings merged, in the order they arrived.
  assert.deepEqual(out.themes[2].children!.map((c) => c.text), [
    "Rachita: share the tier model by end of month",
    "Prabhav: own the tier rebuild",
  ]);
  // Nothing was lost and nothing lost its receipts.
  assert.equal(countLeaves(out), countLeaves(messy));
  assert.deepEqual(validateNotes(out, ctxFor(investor)), []);
  // Already-canonical notes come back untouched.
  assert.deepEqual(normalizeSections(investor.goldNotes), investor.goldNotes);

  // A section written in the wrong place — "Discussion → Risks → …" — is hoisted
  // out to its own section rather than left as a topic.
  const nested = normalizeSections({
    themes: [
      {
        text: "Discussion",
        children: [
          { text: "Pricing", children: [{ text: "ANZ pricing moved to September", source: ["S001"] }] },
          { text: "Risks", children: [{ text: "Runway is fourteen months", source: ["S007"] }] },
        ],
      },
    ],
  });
  assert.deepEqual(nested.themes.map((t) => t.text), ["Discussion", "Risks & concerns"]);
  assert.deepEqual(nested.themes[0].children!.map((c) => c.text), ["Pricing"]);
  assert.deepEqual(nested.themes[1].children!.map((c) => c.text), ["Runway is fourteen months"]);
});

test("a price with no named item still ships — nothing priced is dropped silently", () => {
  // Regression: "the pricing is eighty dollars per seat" names no item, and an
  // earlier parse required one, so a real quote vanished with nothing to show
  // for it. Verbatim wording is preserved too — no tidying "eighty" into "$80".
  const def = getHandoff("pricing_quote")!;
  const ctx = ctxFor(vendor);
  const value = def.parse({
    quotes: [{ item: "", price: "nine dollars", unit: "per seat per month", terms: "", validUntil: null, source: ["S003"] }],
    unclear: [],
  }) as { quotes: { item: string; price: string }[] };
  assert.equal(value.quotes.length, 1);
  assert.equal(value.quotes[0].item, "Unnamed item");
  assert.equal(value.quotes[0].price, "nine dollars");
  assert.deepEqual(def.validate(value, ctx), []);
});

test("an uncited factual line is cut from the email; the warm ones stay", () => {
  const def = getHandoff("followup_email")!;
  const ctx = ctxFor(customer);
  const value = def.parse({
    subject: "Following up",
    body: [
      "Hi Priya,",
      "Great to meet you.",
      "- I'll send the migration plan by Friday [S005]",
      "- We'll have SSO shipped by 15 September", // no citation, invented date
      '- You said "we are ready to sign today"', // no citation, invented quote
      "Best,",
      "Rachita",
    ].join("\n"),
  });
  const failures = def.validate(value, ctx);
  assert.equal(failures.length, 2);
  const pruned = def.prune(value, failures, ctx);
  const lines: string[] = pruned.value.body.split("\n");
  assert.ok(lines.some((l: string) => l.includes("migration plan by Friday")));
  assert.ok(lines.some((l: string) => l.includes("Great to meet you")), "warm, factless lines are allowed");
  assert.ok(!pruned.value.body.includes("15 September"));
  assert.ok(!pruned.value.body.includes("ready to sign"));
  assert.deepEqual(def.validate(pruned.value, ctx), []);
});

test("an unverifiable subject line falls back to a neutral one", () => {
  const def = getHandoff("followup_email")!;
  const ctx = ctxFor(customer);
  const value = def.parse({ subject: "Confirming SSO for October 15", body: "- Thanks for your time" });
  const failures = def.validate(value, ctx);
  assert.ok(failures.some((f) => f.path === "subject"));
  assert.equal(def.prune(value, failures, ctx).value.subject, "Follow-up on our conversation");
});

// ── Cross-meeting ───────────────────────────────────────────────────────────

test("cross-meeting ids are namespaced per meeting and cannot drift", () => {
  const { segments, aliasOf, idOf } = aliasSegments([
    { id: customer.id, segments: customer.segments },
    { id: team.id, segments: team.segments },
  ]);
  assert.equal(aliasOf.get(customer.id), "M1");
  assert.equal(idOf.get("M2"), team.id);
  assert.ok(segments.some((s) => s.id === "M1:S002"));

  const def = getHandoff("collated_feedback")!;
  const ctx = groundingContext({ segments, participants: [...customer.participants, ...team.participants] });
  const value = def.parse({
    themes: [
      {
        theme: "SSO missing",
        kind: "objection",
        examples: [
          { meetingId: "M1", source: ["M1:S002"] },
          { meetingId: "M2", source: ["M1:S002"] }, // filed under the wrong meeting
        ],
      },
      { theme: "onboarding too slow", kind: "objection", examples: [{ meetingId: "M1", source: ["M1:S006"] }] },
    ],
  }) as { themes: { theme: string; frequency: number; examples: unknown[] }[] };

  const failures = def.validate(value, ctx);
  assert.ok(failures.some((f) => f.path === "themes[0].examples[1]"));
  const pruned = def.prune(value, failures, ctx);
  def.finalize?.(pruned.value, ctx);
  assert.equal(pruned.value.themes.length, 2);
  // Frequency is computed from surviving citations, never taken from the model.
  for (const t of pruned.value.themes) assert.equal(t.frequency, t.examples.length);
  assert.deepEqual(def.validate(pruned.value, ctx), []);
});

test("a theme with no citations cannot exist", () => {
  const def = getHandoff("collated_feedback")!;
  const parsed = def.parse({ themes: [{ theme: "customers love us", kind: "praise", examples: [] }] });
  assert.equal(typeof parsed, "string", "an uncited theme is not even parseable");
});

test("source markers are stripped for the clipboard, in every form we emit", () => {
  assert.equal(stripSourceMarkers("A claim [S004]"), "A claim");
  assert.equal(stripSourceMarkers("A claim [S004, S007]"), "A claim");
  assert.equal(stripSourceMarkers("A claim [S004, S007 ?]"), "A claim");
  assert.equal(stripSourceMarkers("Cross-meeting [M2:S004]"), "Cross-meeting");
  assert.equal(stripSourceMarkers("Keep [brackets] that are not receipts"), "Keep [brackets] that are not receipts");
});
