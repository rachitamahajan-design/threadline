/**
 * Test plumbing: a scripted model and a grounding context per fixture.
 *
 * Every test in here runs with MODEL_PROVIDER=mock, so the suite needs no key,
 * no network and no PyAI account. That is deliberate: the guarantees under test
 * are ours, not the model's.
 */
import { groundingContext, type GroundingContext } from "../src/lib/grounding.js";
import { setMockModel, type ModelCall } from "../src/lib/model.js";
import type { Fixture } from "./fixtures.js";

process.env.MODEL_PROVIDER = "mock";

export function ctxFor(fx: Fixture): GroundingContext {
  return groundingContext({ segments: fx.segments, participants: fx.participants });
}

export type Script = Record<string, unknown[]>;

/**
 * Install a scripted model. Keys are matched against the call's `purpose`
 * ("facts.extract", "notes", "handoff:pricing_quote"); values are consumed in
 * order, and the last one repeats — which is how "always returns garbage" and
 * "gets it right on the second try" are both expressible.
 */
export function scriptModel(script: Script): { calls: ModelCall[] } {
  const calls: ModelCall[] = [];
  const cursor: Record<string, number> = {};
  setMockModel((call) => {
    calls.push(call);
    const key = Object.keys(script).find((k) => call.purpose === k) ?? Object.keys(script).find((k) => call.purpose.startsWith(k));
    if (!key) throw new Error(`no scripted response for purpose "${call.purpose}"`);
    const queue = script[key];
    const i = Math.min(cursor[key] ?? 0, queue.length - 1);
    cursor[key] = (cursor[key] ?? 0) + 1;
    return queue[i];
  });
  return { calls };
}

export function clearModel() {
  setMockModel(null);
}

/** A well-formed extraction response derived from a fixture's own segments. */
export function factsResponseFor(fx: Fixture) {
  return {
    facts: fx.segments
      // Skip the off-topic lines: a good extraction would.
      .filter((s) => !/game last night|refereeing|dog is called/i.test(s.text))
      .map((s) => ({
        text: s.text,
        kind: /\d|hundred|thousand|dollars|percent/i.test(s.text) ? "number" : "statement",
        source: [s.id],
        speaker: s.speaker,
        heardPoorly: s.confidence < 0.6,
      })),
  };
}
