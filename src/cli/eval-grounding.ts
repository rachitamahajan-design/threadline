/**
 * evalNotes / evalHandoff — score the grounded pipeline against the golden
 * transcripts, so a prompt edit can be judged instead of guessed at.
 *
 *   npm run eval-grounding              # scores the fixtures' gold outputs
 *                                       # (no key, no network: checks the metrics
 *                                       #  and the fixtures agree)
 *   npm run eval-grounding -- --live    # runs the real two-pass pipeline
 *   npm run eval-grounding -- --live --fixture fx_vendor
 *
 * Precision is the number that matters: the share of leaves whose cited segments
 * actually support them. Two flavours, both reported:
 *
 *   strict    passes every deterministic validator (this is the shipping gate)
 *   lexical   >=50% of the claim's content words appear in the cited text — a
 *             cheap stand-in for entailment, which catches a leaf that cites a
 *             real segment about something else
 *
 * Recall is reported against the hand-labeled facts and themes in the fixtures.
 */
import { contentWords, groundingContext, lexicalOverlap, validateNotes, type Failure } from "../lib/grounding.js";
import { citedText } from "../lib/segments.js";
import { walkBullets, isLeaf, type NoteBullet, type Notes } from "../lib/outline.js";
import { modelConfigured, modelInfo, setMockModel } from "../lib/model.js";
import { extractFacts } from "../pipeline/facts.js";
import { generateNotes } from "../pipeline/notes-outline.js";
import { getHandoff } from "../handoffs/registry.js";
import { promptRef } from "../lib/prompts.js";
import { compose } from "../pipeline/grounded.js";
import { FIXTURES, type Fixture } from "../../test/fixtures.js";
import { readFileSync } from "node:fs";

// tiny .env loader, same as the server's
for (const line of (() => {
  try {
    return readFileSync(".env", "utf8").split("\n");
  } catch {
    return [];
  }
})()) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const argv = process.argv.slice(2);
const LIVE = argv.includes("--live");
// indexOf returns -1 when the flag is absent, and argv[0] is not a fixture name.
const fixtureFlag = argv.indexOf("--fixture");
const only = fixtureFlag >= 0 ? argv[fixtureFlag + 1] : undefined;
const LEXICAL_MIN = 0.5;

export type Score = {
  fixture: string;
  leaves: number;
  strict: number; // 0..1
  lexical: number; // 0..1
  factRecall: number; // 0..1
  themeRecall: number; // 0..1
  needsReview: boolean;
  dropped: number;
  failures: Failure[];
};

/** Score one Notes tree against one fixture. Pure — no model involved. */
export function scoreNotes(fx: Fixture, notes: Notes, extra: { needsReview?: boolean; dropped?: number } = {}): Score {
  const ctx = groundingContext({ segments: fx.segments, participants: fx.participants });
  const failures = validateNotes(notes, ctx);
  const badPaths = new Set(failures.map((f) => f.path));

  const leaves: { path: string; leaf: NoteBullet }[] = [];
  const labels: string[] = [];
  walkBullets(notes, (b, path) => (isLeaf(b) ? leaves.push({ path, leaf: b }) : labels.push(b.text)));

  const strictOk = leaves.filter(({ path }) => !badPaths.has(path)).length;
  const lexicalOk = leaves.filter(
    ({ leaf }) => lexicalOverlap(leaf.text, citedText(ctx.index, leaf.source ?? [])) >= LEXICAL_MIN,
  ).length;

  // Recall: is each hand-labeled fact present in some leaf, and each expected
  // theme present as a label? Matched on content words, so wording can drift.
  const leafBlob = leaves.map(({ leaf }) => leaf.text).join(" ｜ ").toLowerCase();
  const factHits = fx.expectedFacts.filter((f) => covered(f.text, leafBlob)).length;
  const themeBlob = [...labels, ...leaves.map(({ leaf }) => leaf.text)].join(" ｜ ").toLowerCase();
  const themeHits = fx.expectedThemes.filter((t) => themeBlob.includes(t.toLowerCase())).length;

  return {
    fixture: fx.id,
    leaves: leaves.length,
    strict: leaves.length ? strictOk / leaves.length : 1,
    lexical: leaves.length ? lexicalOk / leaves.length : 1,
    factRecall: fx.expectedFacts.length ? factHits / fx.expectedFacts.length : 1,
    themeRecall: fx.expectedThemes.length ? themeHits / fx.expectedThemes.length : 1,
    needsReview: !!extra.needsReview,
    dropped: extra.dropped ?? 0,
    failures,
  };
}

/** A labelled fact counts as covered when 60% of its content words show up. */
function covered(expected: string, blob: string): boolean {
  const words = [...new Set(contentWords(expected))];
  if (!words.length) return true;
  return words.filter((w) => blob.includes(w)).length / words.length >= 0.6;
}

/** Run the real pipeline (or score the gold output) for one fixture. */
export async function evalNotes(fx: Fixture, live: boolean): Promise<Score> {
  if (!live) return scoreNotes(fx, fx.goldNotes);
  const ctx = groundingContext({ segments: fx.segments, participants: fx.participants });
  const { set: facts } = await extractFacts(fx.segments, ctx, { type: fx.type, participants: fx.participants });
  const out = await generateNotes(facts.facts, ctx, { type: fx.type, participants: fx.participants });
  if (!out.value) {
    return { fixture: fx.id, leaves: 0, strict: 0, lexical: 0, factRecall: 0, themeRecall: 0, needsReview: true, dropped: 0, failures: [] };
  }
  return scoreNotes(fx, out.value, { needsReview: out.needsReview, dropped: out.dropped });
}

/** Same idea for a handoff: did the output survive its own validators? */
export async function evalHandoff(
  fx: Fixture,
  live: boolean,
): Promise<{ fixture: string; handoff: string; clean: boolean; failures: Failure[]; dropped: number } | null> {
  if (!fx.goldHandoff) return null;
  const def = getHandoff(fx.goldHandoff.id)!;
  const ctx = groundingContext({ segments: fx.segments, participants: fx.participants });

  if (!live) {
    const value = def.parse(fx.goldHandoff.value);
    if (typeof value === "string") return { fixture: fx.id, handoff: def.id, clean: false, failures: [], dropped: 0 };
    const failures = def.validate(value, ctx);
    return { fixture: fx.id, handoff: def.id, clean: failures.length === 0, failures, dropped: 0 };
  }

  const { set: facts } = await extractFacts(fx.segments, ctx, { type: fx.type, participants: fx.participants });
  const out = await compose(
    {
      purpose: `handoff:${def.id}`,
      promptVersion: promptRef(def.prompt),
      temperature: def.temperature,
      system: (f: string) => def.prompt.build({ facts: f, participants: fx.participants.join(", "), type: fx.type }),
      user: `Produce the ${def.label} now. Return JSON only.`,
      parse: def.parse,
      validate: def.validate,
      prune: def.prune,
      finalize: def.finalize,
    },
    facts.facts,
    ctx,
  );
  return {
    fixture: fx.id,
    handoff: def.id,
    clean: !!out.value && !out.needsReview,
    failures: out.failures,
    dropped: out.dropped,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const pct = (n: number) => `${(n * 100).toFixed(0)}%`.padStart(4);
const bar = (n: number) => "█".repeat(Math.round(n * 10)).padEnd(10, "·");

async function main() {
  const fixtures = only ? FIXTURES.filter((f) => f.id === only) : FIXTURES;
  if (!fixtures.length) {
    console.error(`no fixture named "${only}". Available: ${FIXTURES.map((f) => f.id).join(", ")}`);
    process.exit(2);
  }

  const live = LIVE && modelConfigured();
  if (LIVE && !live) {
    console.error("--live needs a model: set PYAI_API_KEY (or OPENAI_API_KEY) in .env");
    process.exit(2);
  }
  if (!live) {
    // Gold mode: score the fixtures' own known-good outputs. This is the check
    // that runs without a key — it proves the metrics and the fixtures agree.
    setMockModel(() => ({}));
  }

  console.log(
    `\nGrounded notes eval — ${live ? `LIVE via ${modelInfo().provider}/${modelInfo().model}` : "gold fixtures (offline)"}\n`,
  );
  console.log("fixture         leaves  strict      lexical     facts       themes      notes");
  console.log("─".repeat(92));

  const scores: Score[] = [];
  for (const fx of fixtures) {
    const s = await evalNotes(fx, live);
    scores.push(s);
    const flags = [s.needsReview ? "needs-review" : "", s.dropped ? `${s.dropped} dropped` : ""].filter(Boolean).join(" · ");
    console.log(
      `${fx.id.padEnd(15)} ${String(s.leaves).padStart(5)}  ` +
        `${bar(s.strict)}${pct(s.strict)}  ${bar(s.lexical)}${pct(s.lexical)}  ` +
        `${bar(s.factRecall)}${pct(s.factRecall)}  ${bar(s.themeRecall)}${pct(s.themeRecall)}  ${flags}`,
    );
    for (const f of s.failures.slice(0, 3)) console.log(`                └─ [${f.rule}] ${f.detail.slice(0, 100)}`);
  }

  const avg = (pick: (s: Score) => number) => scores.reduce((a, s) => a + pick(s), 0) / scores.length;
  console.log("─".repeat(92));
  console.log(
    `${"AVERAGE".padEnd(15)} ${String(scores.reduce((a, s) => a + s.leaves, 0)).padStart(5)}  ` +
      `${bar(avg((s) => s.strict))}${pct(avg((s) => s.strict))}  ${bar(avg((s) => s.lexical))}${pct(avg((s) => s.lexical))}  ` +
      `${bar(avg((s) => s.factRecall))}${pct(avg((s) => s.factRecall))}  ${bar(avg((s) => s.themeRecall))}${pct(avg((s) => s.themeRecall))}`,
  );

  console.log("\nHandoffs");
  console.log("─".repeat(92));
  for (const fx of fixtures) {
    const h = await evalHandoff(fx, live);
    if (!h) continue;
    console.log(
      `${fx.id.padEnd(15)} ${h.handoff.padEnd(20)} ${h.clean ? "clean" : `${h.failures.length} failure(s), ${h.dropped} dropped`}`,
    );
    for (const f of h.failures.slice(0, 3)) console.log(`                └─ [${f.rule}] ${f.detail.slice(0, 100)}`);
  }

  // Strict precision is the shipping invariant: anything below 1.0 means a leaf
  // that would have reached the user unsourced, which is a bug, not a metric.
  const strictAvg = avg((s) => s.strict);
  console.log(
    `\n${strictAvg === 1 ? "✓" : "✗"} strict precision ${pct(strictAvg).trim()} — every shipped leaf must be valid.\n`,
  );
  if (!live) console.log("Tip: `npm run eval-grounding -- --live` scores the real model, which is what prompt changes move.\n");
  process.exit(strictAvg === 1 ? 0 : 1);
}

// Keep the module importable from tests without running the CLI.
if (process.argv[1]?.includes("eval-grounding")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
