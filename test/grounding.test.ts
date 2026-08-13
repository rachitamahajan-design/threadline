/**
 * The hallucination suite. Each test is a thing a weak model actually does, and
 * the assertion is that our code refuses it. These must fail closed: a bug that
 * makes a validator too permissive has to break a test here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  checkOwner,
  checkQuotes,
  checkThemeHeader,
  checkVerbatim,
  expandNumberWords,
  formatFailures,
  groundingContext,
  isSoft,
  markNotesConfidence,
  numericTokens,
  validateActionItems,
  validateNotes,
  verbatimMisses,
} from "../src/lib/grounding.js";
import { countLeaves, notesFromMarkdown, notesToMarkdown, validateNotesShape, type Notes } from "../src/lib/outline.js";
import { adversarial, investor, vendor, FIXTURES } from "./fixtures.js";
import { ctxFor } from "./helpers.js";

test("gold notes validate clean for every fixture", () => {
  for (const fx of FIXTURES) {
    const failures = validateNotes(fx.goldNotes, ctxFor(fx));
    assert.deepEqual(
      failures.map((f) => `${f.rule} @ ${f.path}: ${f.detail}`),
      [],
      `${fx.id} gold notes should validate clean`,
    );
  }
});

test("(a) an invented owner is rejected", () => {
  const ctx = ctxFor(investor);
  const failures = validateActionItems(
    [{ text: "Send the prospecting table", owner: "Jordan from Growth", due: null, source: ["S005"] }],
    "nextSteps",
    ctx,
  );
  assert.equal(failures.length, 1);
  assert.equal(failures[0].rule, "owner-whitelist");
  // The whitelist is in the message, so the retry has something to work with.
  assert.match(failures[0].detail, /Rachita/);

  // Real participants and the explicit escape hatch both pass.
  assert.deepEqual(checkOwner("Prabhav", "x", ctx), []);
  assert.deepEqual(checkOwner("prabhav", "x", ctx), []); // case-insensitive
  assert.deepEqual(checkOwner("Unassigned", "x", ctx), []);
  assert.equal(checkOwner("", "x", ctx).length, 1);
});

test("(b) a price that is not verbatim in the cited segment is rejected", () => {
  const ctx = ctxFor(vendor);
  // S002 says "forty eight thousand dollars a year".
  assert.deepEqual(checkVerbatim("Platform license is $48,000 a year", ["S002"], "q", ctx), []);
  const wrong = checkVerbatim("Platform license is $52,000 a year", ["S002"], "q", ctx);
  assert.equal(wrong.length, 1);
  assert.equal(wrong[0].rule, "verbatim-number");

  // Rounding, softening and unit-switching are all still inventions.
  assert.equal(checkVerbatim("about $50,000 a year", ["S002"], "q", ctx).length, 1);
  assert.equal(checkVerbatim("$4,000 a month", ["S002"], "q", ctx).length, 1);
  // A date nobody said, cited to a segment that has a different one.
  assert.equal(checkVerbatim("valid until October 30", ["S005"], "q", ctx).length, 1);
  assert.deepEqual(checkVerbatim("valid until September 30", ["S005"], "q", ctx), []);
});

test("(c) a leaf with a missing or dead source is rejected", () => {
  const ctx = ctxFor(investor);
  const dead = validateNotes(
    { themes: [{ text: "Pricing", children: [{ text: "ANZ pricing moved to September", source: ["S099"] }] }] },
    ctx,
  );
  assert.equal(dead.length, 1);
  assert.equal(dead[0].rule, "source-exists");

  const missing = validateNotes(
    { themes: [{ text: "Pricing", children: [{ text: "ANZ pricing moved to September", source: [] }] }] },
    ctx,
  );
  assert.equal(missing[0].rule, "leaf-sourced");

  // Shape validation catches it even earlier, before grounding runs.
  const shapeErrors = validateNotesShape({ themes: [{ text: "Pricing", children: [{ text: "no source here" }] }] });
  assert.equal(shapeErrors.length, 1);
  assert.match(shapeErrors[0], /must carry "source"/);
});

test("(d) a quote that is not an exact substring is rejected", () => {
  const ctx = ctxFor(investor);
  // S002: "September is fine if the reason is demand shaped. Is it?"
  assert.deepEqual(checkQuotes('Maya said "September is fine if the reason is demand shaped"', ["S002"], "q", ctx), []);
  const paraphrased = checkQuotes('Maya said "September works if demand justifies it"', ["S002"], "q", ctx);
  assert.equal(paraphrased.length, 1);
  assert.equal(paraphrased[0].rule, "exact-quote");

  // A quote spliced from two different segments is not a quote.
  const spliced = checkQuotes('"September is fine if the reason is demand shaped. Send me the prospecting table"', ["S002", "S004"], "q", ctx);
  assert.equal(spliced.length, 1);
});

test("(e) a theme header asserting a claim its children do not carry is rejected", () => {
  const ctx = ctxFor(investor);
  const bad = {
    themes: [
      {
        text: "Pricing moved to September",
        children: [{ text: "Enterprise prospects want usage based tiers instead of per seat pricing", source: ["S003"] }],
      },
    ],
  };
  const failures = validateNotes(bad, ctx);
  // One failure per header, listing every unsupported assertion in it.
  assert.equal(failures.length, 1);
  assert.equal(failures[0].rule, "theme-claim-free");
  assert.match(failures[0].detail, /September/);
  assert.match(failures[0].detail, /moved/);

  // Same claim, but a child carries it → the label is legitimate.
  const ok = {
    themes: [
      {
        text: "Pricing moved to September",
        children: [{ text: "ANZ pricing moved to September", source: ["S001"] }],
      },
    ],
  };
  assert.deepEqual(validateNotes(ok, ctx), []);

  // Plain topic labels are always fine.
  assert.deepEqual(checkThemeHeader({ text: "Pricing", children: [{ text: "x", source: ["S001"] }] }, "0", ctx), []);
});

test("theme headers may not assert a decision or an attribution their children lack", () => {
  const ctx = ctxFor(investor);
  const decision = validateNotes(
    { themes: [{ text: "We decided to rebuild the tiers", children: [{ text: "Enterprise prospects want usage based tiers", source: ["S003"] }] }] },
    ctx,
  );
  assert.equal(decision[0]?.rule, "theme-claim-free");

  const attribution = validateNotes(
    { themes: [{ text: "Prabhav's concerns", children: [{ text: "Enterprise prospects want usage based tiers", source: ["S003"] }] }] },
    ctx,
  );
  assert.equal(attribution[0]?.rule, "theme-claim-free");
});

test("a theme label carrying its own source is rejected — labels assert nothing", () => {
  const ctx = ctxFor(investor);
  const failures = validateNotes(
    {
      themes: [
        {
          text: "Pricing",
          source: ["S001"],
          children: [{ text: "ANZ pricing moved to September", source: ["S001"] }],
        },
      ],
    },
    ctx,
  );
  assert.ok(failures.some((f) => f.rule === "theme-claim-free" && /carries "source"/.test(f.detail)));
});

test("brain/memory context can never be a source for a claim about this meeting", () => {
  const ctx = groundingContext({
    segments: investor.segments,
    participants: investor.participants,
    memoryIds: ["mem:anz-pricing"],
  });
  const failures = validateNotes(
    { themes: [{ text: "Pricing", children: [{ text: "ANZ pricing has slipped twice before", source: ["mem:anz-pricing"] }] }] },
    ctx,
  );
  assert.equal(failures.length, 1);
  assert.equal(failures[0].rule, "no-memory-source");

  // Even an unregistered memory-shaped id is refused.
  const sneaky = validateNotes(
    { themes: [{ text: "Pricing", children: [{ text: "Something from before", source: ["memory:past-call"] }] }] },
    ctx,
  );
  assert.equal(sneaky[0].rule, "no-memory-source");
});

test("cross-meeting ids are not mistaken for memory ids", () => {
  // "M2:S004" starts with "m" — the memory check must not swallow it.
  const ctx = groundingContext({
    segments: [{ id: "M2:S004", speaker: "Priya", startMs: 0, endMs: 1000, text: "We need SSO", confidence: 1 }],
  });
  assert.deepEqual(validateNotes({ themes: [{ text: "SSO", children: [{ text: "We need SSO", source: ["M2:S004"] }] }] }, ctx), []);
});

test("spoken numbers are matched against digits, both ways round", () => {
  assert.equal(expandNumberWords("two hundred fifty companies"), "250");
  assert.equal(expandNumberWords("forty eight thousand dollars"), "48000");
  assert.equal(expandNumberWords("one hundred eighty thousand a month"), "180000");
  assert.equal(expandNumberWords("nine hundred milliseconds to one hundred twenty"), "900 120");
  assert.equal(expandNumberWords("no numbers here"), "");

  // The guard therefore accepts "250" for "two hundred fifty"...
  assert.deepEqual(verbatimMisses("250 companies", "a table of two hundred fifty companies"), []);
  // ...and still rejects a number nobody said.
  assert.equal(verbatimMisses("450 companies", "a table of two hundred fifty companies").length, 1);
});

test("numeric token extraction covers money, percentages, dates and weekdays", () => {
  const tokens = numericTokens("We agreed $4,000 per month, a 20% discount, valid until 2026-09-30, review on Friday");
  const raws = tokens.map((t) => t.raw.toLowerCase());
  assert.ok(raws.some((r) => r.includes("4,000")));
  assert.ok(raws.some((r) => r.includes("20%")));
  assert.ok(raws.some((r) => r.includes("2026-09-30")));
  assert.ok(raws.includes("friday"));
  // An ISO date also accepts the way a human says it, so "2026-09-30" cited to
  // a segment saying "September 30" passes.
  const iso = tokens.find((t) => t.raw.includes("2026-09-30"))!;
  assert.ok(iso.forms.some((f) => f.includes("september 30")));
  // Citation markers are not facts.
  assert.deepEqual(numericTokens("A claim with a marker [S004]").map((t) => t.raw), []);
});

test("low confidence is computed from STT, not taken from the model", () => {
  const ctx = ctxFor(adversarial);
  // The model claimed nothing; code flags the leaf resting only on S003 (0.42).
  const notes: Notes = {
    themes: [
      { text: "Pricing", children: [{ text: "Pricing is $80 per seat per month", source: ["S003"] }] },
      { text: "Pilot", children: [{ text: "The pilot can start in March", source: ["S006"], lowConfidence: true }] },
    ],
  };
  const flagged = markNotesConfidence(notes, ctx);
  assert.equal(flagged, 1);
  assert.equal(notes.themes[0].children![0].lowConfidence, true);
  // ...and unflags a leaf the model wrongly marked.
  assert.equal(notes.themes[1].children![0].lowConfidence, undefined);
});

test("the adversarial fixture: off-topic tangent excluded, misheard number caught", () => {
  const ctx = ctxFor(adversarial);
  // "eighty dollars" heard on a bad line; the model writes $18.
  const misheard = validateNotes(
    { themes: [{ text: "Pricing", children: [{ text: "Pricing is $18 per seat per month", source: ["S003"] }] }] },
    ctx,
  );
  assert.equal(misheard.length, 1);
  assert.equal(misheard[0].rule, "verbatim-number");

  // The tangent has no fact in it, so nothing may cite it as one; a claim
  // sourced to the dog line cannot survive the verbatim/quote guards either.
  const tangent = validateNotes(
    { themes: [{ text: "Pricing", children: [{ text: "Pricing is $80 per seat per month", source: ["S005"] }] }] },
    ctx,
  );
  assert.equal(tangent.length, 1);
  assert.equal(tangent[0].rule, "verbatim-number");
});

test("an action item under Action items has to name someone", () => {
  const ctx = ctxFor(investor);
  const notes = (text: string): Notes => ({
    themes: [{ text: "Action items", children: [{ text, source: ["S005"] }] }],
  });
  // Named owner, or the explicit escape hatch: fine.
  assert.deepEqual(validateNotes(notes("Rachita: share the prospecting table by end of month"), ctx), []);
  assert.deepEqual(validateNotes(notes("Unassigned: chase the renewal risk"), ctx), []);

  // Ownerless, and owned by someone who was never here.
  for (const text of ["Share the prospecting table by end of month", "Jordan: build the funnel dashboard"]) {
    const failures = validateNotes(notes(text), ctx);
    assert.equal(failures.length, 1, text);
    assert.equal(failures[0].rule, "owner-unnamed");
    assert.ok(isSoft(failures[0]), "an ownerless bullet is still true — it earns a rewrite, not deletion");
    assert.match(failures[0].detail, /Rachita/);
  }

  // An ownerless statement under a discussion section is not a commitment, so
  // the rule leaves it alone.
  assert.deepEqual(
    validateNotes(
      {
        themes: [
          {
            text: "Discussion",
            children: [{ text: "The prospecting table of two hundred fifty companies is in progress", source: ["S005"] }],
          },
        ],
      },
      ctx,
    ),
    [],
  );
});

test("the summary is a claim: it cites, and its figures must be verbatim", () => {
  const ctx = ctxFor(investor);
  const ok: Notes = {
    summary: {
      text: "ANZ pricing moved to September because enterprise prospects want usage based tiers. Net burn is 180,000 a month.",
      source: ["S001", "S003", "S007"],
    },
    themes: investor.goldNotes.themes,
  };
  assert.deepEqual(validateNotes(ok, ctx), []);

  // A figure nobody said.
  const badNumber = validateNotes({ ...ok, summary: { text: "Net burn is 250,000 a month.", source: ["S007"] } }, ctx);
  assert.equal(badNumber[0]?.rule, "verbatim-number");
  assert.equal(badNumber[0]?.path, "summary");

  // A summary with no citation at all.
  const unsourced = validateNotes({ ...ok, summary: { text: "The call went well.", source: [] } }, ctx);
  assert.equal(unsourced[0]?.rule, "leaf-sourced");

  // Shape validation catches it before grounding runs.
  assert.ok(
    validateNotesShape({ summary: { text: "No receipt here" }, themes: investor.goldNotes.themes })
      .some((e) => /summary" must carry "source"/.test(e)),
  );
});

test("a poorly heard summary is flagged, like any other claim", () => {
  const ctx = ctxFor(adversarial);
  const notes: Notes = {
    summary: { text: "Pricing is $80 per seat per month.", source: ["S003"] },
    themes: adversarial.goldNotes.themes,
  };
  markNotesConfidence(notes, ctx);
  assert.equal(notes.summary!.lowConfidence, true);
});

test("markdown round-trips exactly, receipts included", () => {
  for (const fx of FIXTURES) {
    const md = notesToMarkdown(fx.goldNotes);
    const back = notesFromMarkdown(md);
    assert.deepEqual(back, fx.goldNotes, `${fx.id} should round-trip`);
    assert.equal(notesToMarkdown(back), md);
  }
});

test("the clipboard form drops segment ids but keeps the tree", () => {
  const md = notesToMarkdown(investor.goldNotes, { sources: false });
  assert.ok(!/\[S\d/.test(md), "no segment ids in copied markdown");
  // Section → topic → point, two spaces per level.
  assert.match(md, /^- Discussion\n {2}- ANZ pricing\n {4}- ANZ pricing moved to September$/m);
  assert.equal(countLeaves(notesFromMarkdown(notesToMarkdown(investor.goldNotes))), countLeaves(investor.goldNotes));
});

test("failure lists sent back to the model are deduped and capped", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({
    path: `${i}`,
    rule: "verbatim-number" as const,
    detail: `bad number ${i}`,
  }));
  const text = formatFailures(many, 5);
  assert.equal(text.split("\n").filter((l) => l.startsWith("- [")).length, 5);
  assert.match(text, /and 25 more/);
});
