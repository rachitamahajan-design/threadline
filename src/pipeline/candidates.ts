/**
 * Where topics come from.
 *
 * Previously a topic was `decision.split(" ").slice(0,6)` — the first six words
 * of a sentence. That is why "Delay the ANZ rollout to September" and "Move ANZ
 * pricing to September" became two unrelated nodes and the graph never joined
 * across meetings.
 *
 * Four sources, in descending order of trust. All of them are already in hand;
 * none of them costs an extra model call, so the graph never depends on a
 * second vendor — the same constraint the extraction pipeline holds itself to.
 */
import type { RecapRecord, Utterance } from "../lib/pyai.js";
import { normalize } from "../lib/harness.js";
import { chatJson } from "../lib/model.js";

export type Candidate = {
  kind: "person" | "topic";
  surface: string;
  source: "coverage_gap" | "decision" | "action" | "ngram" | "speaker";
  /** receipt: what was actually said */
  quote?: string;
  /** receipt: where in the call */
  offset_s?: number;
  /** ranking weight — how much evidence backs this candidate */
  weight: number;
};

const STOP = new Set(
  ("the a an of to for and or is are was were be been in on at by with from that this these those " +
    "we i you he she it they our your their my me us them will would should could can may might " +
    "so if then than as but not no yes ok okay just really very much more most some any all")
    .split(" "),
);

/**
 * Leading imperative + article, e.g. "Delay the ", "Move ", "Rebuild the ".
 * Idioms come first so "Keep an eye on renewal risk" yields "renewal risk"
 * rather than "eye".
 */
const LEAD = new RegExp(
  "^(?:let'?s\\s+)?(?:we\\s+(?:will\\s+|should\\s+|need\\s+to\\s+)?)?(?:" +
    // multi-word idioms, longest first
    "keep\\s+an\\s+eye\\s+on|take\\s+a\\s+look\\s+at|follow\\s+up\\s+on|circle\\s+back\\s+on|" +
    "come\\s+back\\s+with|check\\s+in\\s+on|" +
    // plain imperatives
    "delay|move|rebuild|build|send|ship|share|update|review|fix|add|create|draft|prepare|" +
    "escalate|keep|start|stop|finish|confirm|check|decide|agree" +
    ")\\s+(?:the\\s+|a\\s+|an\\s+|our\\s+|my\\s+|your\\s+)?",
  "i",
);

/**
 * Trailing tail worth dropping. Deliberately limited to TEMPORAL prepositions
 * plus "of": those introduce qualifiers ("to September", "of 250 companies").
 * "for"/"with"/"on" are semantic and usually carry the actual object, so
 * stripping them turned "the timeline for portfolio changes" into "timeline".
 */
const TAIL = /\s+(?:to|by|until|till|before|after|due|of)\s+.*$/i;

/** Reduce a sentence-shaped string to its head-final noun phrase, 1-4 words. */
export function nounPhrase(s: string): string | null {
  let t = s.trim().replace(/^["'“”]|["'“”.,;:!?]+$/g, "");
  t = t.replace(LEAD, "");
  // Only strip a tail if something substantive survives it.
  const stripped = t.replace(TAIL, "");
  if (stripped.split(/\s+/).filter(Boolean).length >= 1 && stripped.length >= 3) t = stripped;
  t = t.replace(/^(?:the|a|an|our|my|your|their)\s+/i, "");

  const words = t.split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  // Head-final: keep the last <=4 words, dropping leading stopwords.
  const kept = words.slice(-4).filter((w, i, arr) => !(i === 0 && STOP.has(w.toLowerCase()) && arr.length > 1));
  const out = kept.join(" ").replace(/[.,;:]+$/, "").trim();
  if (out.length < 3) return null;
  if (out.split(/\s+/).every((w) => STOP.has(w.toLowerCase()))) return null;
  return out;
}

function usable(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 1 && v.trim().toLowerCase() !== "none";
}

/**
 * A topic must read like a topic: words, not clock marks, figures or whole
 * sentences. Transcripts with inline timestamps taught the ngram miner that
 * "03:08" recurs — of course it does.
 */
export function plausibleTopic(surface: string): boolean {
  const t = surface.trim();
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(t)) return false; // timestamps
  const letters = (t.match(/[A-Za-z]/g) ?? []).length;
  const digits = (t.match(/\d/g) ?? []).length;
  if (letters < 3 || digits > letters) return false; // "0.99", "25,000"
  if (t.split(/\s+/).length > 5) return false; // sentence fragments
  return true;
}

/**
 * LLM curation, best-effort: the model keeps only coherent, recognisable
 * discussion topics out of the candidate strings. Deterministic gates have
 * already run; a curation failure just means they stand alone.
 */
export async function curateTopics(cands: Candidate[], context: string): Promise<Candidate[]> {
  const topics = cands.filter((c) => c.kind === "topic");
  if (topics.length <= 1) return cands;
  try {
    const raw = await chatJson({
      purpose: "topics.curate",
      system:
        'You curate topic nodes for a meeting knowledge graph. From the candidate strings, KEEP only specific, coherent discussion topics a team would recognise on a map — products, projects, workstreams, named concepts, decisions\' subjects. REJECT timestamps, bare numbers or prices, sentence fragments, filler ("medium confidence", "App"), and near-duplicates of a kept topic. Return JSON {"keep": ["..."]} repeating the exact candidate strings you keep.',
      user: `Meeting: ${context}\n\nCandidates:\n${topics.map((t) => `- ${t.surface}`).join("\n")}`,
      maxTokens: 400,
    });
    const keep = new Set((((raw as { keep?: string[] })?.keep) ?? []).map((s) => normalize(s)));
    if (!keep.size) return cands; // a model that rejects everything is a model that failed
    return cands.filter((c) => c.kind !== "topic" || keep.has(normalize(c.surface)));
  } catch {
    return cands;
  }
}

/** Repeated multi-word phrases: the only source that catches a topic nobody decided on. */
function repeatedNgrams(utterances: Utterance[]): Candidate[] {
  const counts = new Map<string, { surface: string; n: number; quote: string; offset_s: number }>();
  for (const u of utterances) {
    const words = u.text.split(/\s+/).map((w) => w.replace(/[^A-Za-z0-9-]/g, "")).filter(Boolean);
    for (const size of [2, 3]) {
      for (let i = 0; i + size <= words.length; i++) {
        const gram = words.slice(i, i + size);
        if (gram.every((w) => STOP.has(w.toLowerCase()))) continue;
        if (gram.some((w) => w.length < 3)) continue;
        // "hello hello" — a phrase of one repeated token is stutter, not a topic
        if (new Set(gram.map((w) => w.toLowerCase())).size === 1) continue;
        if (STOP.has(gram[0].toLowerCase()) || STOP.has(gram[gram.length - 1].toLowerCase())) continue;
        const key = normalize(gram.join(" "));
        const prev = counts.get(key);
        if (prev) prev.n++;
        else counts.set(key, { surface: gram.join(" "), n: 1, quote: u.text, offset_s: u.offset_s });
      }
    }
  }
  return [...counts.values()]
    .filter((c) => c.n >= 2)
    .map((c) => ({ kind: "topic" as const, surface: c.surface, source: "ngram" as const, quote: c.quote, offset_s: c.offset_s, weight: c.n }));
}

/** Everything worth putting in the graph for one meeting, best evidence first. */
export function candidates(utterances: Utterance[], rec: RecapRecord): Candidate[] {
  const out: Candidate[] = [];

  // 1. coverage_gaps — already noun-shaped AND already carry a transcript quote
  //    that the old code threw away. This is the only source PyAI hands us that
  //    is entity-shaped rather than sentence-shaped.
  for (const g of rec.coverage_gaps ?? []) {
    if (!usable(g.fact)) continue;
    out.push({
      kind: g.type === "name" ? "person" : "topic",
      surface: g.fact.trim(),
      source: "coverage_gap",
      quote: g.transcript_quote ?? g.fact,
      weight: 5,
    });
  }

  // 2 + 3. Decisions and action items, reduced to their noun phrase.
  for (const d of rec.key_decisions ?? []) {
    if (!usable(d)) continue;
    const np = nounPhrase(d);
    if (np) out.push({ kind: "topic", surface: np, source: "decision", quote: d, weight: 4 });
  }
  for (const a of rec.action_items ?? []) {
    if (!usable(a?.task)) continue;
    const np = nounPhrase(a.task);
    if (np) out.push({ kind: "topic", surface: np, source: "action", quote: a.task, weight: 3 });
  }

  // 4. Repetition — catches what was discussed but never decided.
  out.push(...repeatedNgrams(utterances));

  // Speakers, so people still land in the graph. A speaker's receipt is their
  // own first utterance — the proof that they spoke is that they spoke. Live
  // capture writes the placeholders "You"/"Them"; the gate filters those.
  const seen = new Set<string>();
  for (const u of utterances) {
    if (!usable(u.speaker) || seen.has(u.speaker)) continue;
    seen.add(u.speaker);
    out.push({ kind: "person", surface: u.speaker, source: "speaker", quote: u.text, offset_s: u.offset_s, weight: 5 });
  }

  // Collapse exact duplicates, keeping the best-evidenced instance.
  const best = new Map<string, Candidate>();
  for (const c of out) {
    const key = `${c.kind}:${normalize(c.surface)}`;
    const prev = best.get(key);
    if (!prev || c.weight > prev.weight) best.set(key, prev ? { ...c, weight: prev.weight + c.weight } : c);
    else prev.weight += c.weight;
  }
  return [...best.values()]
    .filter((c) => c.kind !== "topic" || plausibleTopic(c.surface))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 12);
}
