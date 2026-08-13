/**
 * The transcript adapter. STT belongs to someone else, so this seam is the only
 * thing that has to change when their payload does — these tests pin that
 * promise down by feeding it every shape we have seen, plus one we haven't.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  LOW_CONFIDENCE,
  citedText,
  fromStt,
  fromUtterances,
  indexSegments,
  meetingTypeOf,
  renderSegments,
  restsOnLowConfidence,
  segmentId,
} from "../src/lib/segments.js";

const utterances = [
  { speaker: "Rachita", speaker_role: "agent" as const, text: "Pricing moved to September.", offset_s: 0, duration_s: 4.2 },
  { speaker: "Maya", speaker_role: "customer" as const, text: "Why?", offset_s: 4.5, duration_s: 1.1 },
];

test("segment ids are positional, padded and stable", () => {
  assert.equal(segmentId(0), "S001");
  assert.equal(segmentId(41), "S042");
  // `idx` from the DB wins over array position, so ids survive a partial read.
  const segs = fromUtterances([{ ...utterances[1], idx: 7 }]);
  assert.equal(segs[0].id, "S008");
});

test("live utterances become segments with millisecond bounds", () => {
  const segs = fromUtterances(utterances);
  assert.equal(segs.length, 2);
  assert.deepEqual(
    segs.map((s) => [s.id, s.speaker, s.startMs, s.endMs]),
    [
      ["S001", "Rachita", 0, 4200],
      ["S002", "Maya", 4500, 5600],
    ],
  );
  assert.equal(segs[0].confidence, 1, "unreported confidence means no reason to doubt");
});

test("every STT shape we have seen is accepted", () => {
  const expect = (segs: ReturnType<typeof fromStt>) => {
    assert.equal(segs.length, 2);
    assert.equal(segs[0].id, "S001");
    assert.equal(segs[1].text, "Why?");
  };
  expect(fromStt(utterances)); // live session / samples
  expect(fromStt({ utterances })); // shared-dataset export
  expect(fromStt({ transcript: { utterances } })); // PyAI transcription job
  expect(fromStt({ segments: utterances })); // segment-level STT
  // Already ours: ids and text are preserved, confidence normalised.
  const ours = fromStt([
    { id: "S001", speaker: "Rachita", startMs: 0, endMs: 4200, text: "Pricing moved to September.", confidence: 0.9 },
    { id: "S002", speaker: "Maya", startMs: 4500, endMs: 5600, text: "Why?", confidence: 2 },
  ]);
  expect(ours);
  assert.equal(ours[1].confidence, 1, "out-of-range confidence is clamped");
});

test("an unrecognised payload throws instead of quietly producing no transcript", () => {
  assert.throws(() => fromStt({ words: [] }), /unrecognised STT payload/);
  assert.throws(() => fromStt("a string"), /unrecognised STT payload/);
  assert.deepEqual(fromStt([]), [], "an empty transcript is legitimate, though");
});

test("missing speakers fall back to the diarization role, never to a guess", () => {
  const segs = fromUtterances([{ speaker_role: "customer", text: "We need SSO.", offset_s: 0, duration_s: 2 }]);
  assert.equal(segs[0].speaker, "customer");
  const unlabelled = fromUtterances([{ speaker_role: undefined as never, text: "Hmm.", offset_s: 0, duration_s: 1 }]);
  assert.equal(unlabelled[0].speaker, "a participant");
});

test("cited text and low-confidence detection work off the index", () => {
  const segs = fromUtterances([
    { ...utterances[0], confidence: 0.4 },
    { ...utterances[1], confidence: 0.95 },
  ]);
  const index = indexSegments(segs);
  assert.equal(citedText(index, ["S001", "S002"]), "Pricing moved to September. Why?");
  assert.equal(citedText(index, ["S404"]), "", "unknown ids contribute nothing");

  assert.equal(restsOnLowConfidence(index, ["S001"]), true);
  assert.equal(restsOnLowConfidence(index, ["S001", "S002"]), false, "one solid citation is enough");
  assert.equal(restsOnLowConfidence(index, []), false);
  assert.ok(LOW_CONFIDENCE > 0 && LOW_CONFIDENCE < 1);
});

test("the rendered transcript flags poorly heard lines for the model", () => {
  const rendered = renderSegments(fromUtterances([{ ...utterances[0], confidence: 0.3 }, utterances[1]]));
  assert.match(rendered, /^\[S001\] Rachita: Pricing moved to September\.\s+\(heard poorly\)$/m);
  assert.ok(!rendered.split("\n")[1].includes("heard poorly"));
});

test("recording modes map onto the handoff taxonomy, with a safe fallback", () => {
  assert.equal(meetingTypeOf("investor"), "investor");
  assert.equal(meetingTypeOf("discovery"), "customer");
  assert.equal(meetingTypeOf("standup"), "team");
  assert.equal(meetingTypeOf("one_on_one"), "one_on_one");
  // Unknown modes land internal rather than inventing an external-facing default.
  assert.equal(meetingTypeOf("brainstorm"), "team");
  assert.equal(meetingTypeOf(null), "team");
  // An explicit user override wins.
  assert.equal(meetingTypeOf("discovery", "vendor"), "vendor");
  assert.equal(meetingTypeOf("discovery", "nonsense"), "customer", "a bad override falls back to the derived type");
});
