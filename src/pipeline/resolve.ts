/**
 * Canonical entity resolution.
 *
 * A cascade of matchers, each returning a score and a REASON, pushed through
 * the project's existing `applyGate` so every merge is auditable and nothing is
 * ever silently dropped. An entity merge is a claim, so it carries a receipt
 * exactly like a decision does.
 *
 * Deliberately conservative about MERGING. Calibration on the real transcripts
 * showed the classes overlap badly: "ANZ rollout"/"ANZ pricing" (same subject,
 * should link) scores BELOW "CS dashboard"/"sales dashboard" (different things)
 * on every similarity measure tried. So identity is asserted only where the
 * evidence is near-exact; everything weaker becomes a scored `related` link,
 * which answers "which meetings discussed X" without claiming X == Y.
 */
import type { DatabaseSync } from "node:sqlite";
import { applyGate, normalize, type Gate, type StepRecord } from "../lib/harness.js";
import { because } from "../lib/reasons.js";
import { slug } from "../lib/db.js";
import type { Candidate } from "./candidates.js";

export type Matcher = "alias" | "slug" | "contains" | "lexical" | "none";

export type Resolution = Candidate & {
  entityId: string | null;
  matcher: Matcher;
  score: number;
  runnerUp: number;
  reason: string;
};

/** Merge only at near-identity. See the header for why this is high. */
const MERGE_LEXICAL = 0.72;
/**
 * Below merge but plausibly the same subject -> a `related` edge. The floor is
 * low because the REAL requirement is the shared anchor token: "ANZ rollout" /
 * "ANZ pricing" score only ~0.29 lexically, but sharing the distinctive token
 * "anz" is what makes them worth linking. A related edge is a weak, receipted
 * claim — it says "these were discussed in connected terms", not "these are
 * the same thing" — so anchor + low floor is the right trade. (Floor lowered
 * again after LLM phrasing variance produced longer labels that dilute
 * Jaccard: "ANZ pricing moved" vs "ANZ rollout delay" scored ~0.2.)
 */
const RELATE_MIN = 0.15;
/** Best match must beat the runner-up by this, or it is ambiguous. */
const MARGIN = 0.05;

const STOP = new Set("the a an of to for and or is are in on at by with from that this our your their".split(" "));
// >= 2, not > 2: dropping two-char tokens turns "CS dashboard" into just
// "dashboard", which then lexically merges with "sales dashboard" — the
// acronym IS the distinctive part. (Caught by eval-brain.)
const toks = (s: string) => normalize(s).split(" ").filter((w) => w.length >= 2 && !STOP.has(w));

function jaccard(a: string[], b: string[]) {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  const inter = [...A].filter((x) => B.has(x)).length;
  return inter / (A.size + B.size - inter);
}

function trigrams(s: string) {
  const t = normalize(s).replace(/\s+/g, " ");
  const out = new Set<string>();
  for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3));
  return out;
}

function dice(a: string, b: string) {
  const A = trigrams(a), B = trigrams(b);
  if (!A.size || !B.size) return 0;
  const inter = [...A].filter((x) => B.has(x)).length;
  return (2 * inter) / (A.size + B.size);
}

/**
 * Similarity for entity labels. Head-final bonus because English noun phrases
 * put the head last: "warehouse migration" vs "warehouse migration issue".
 */
export function similarity(a: string, b: string): number {
  const ta = toks(a), tb = toks(b);
  if (!ta.length || !tb.length) return 0;
  let s = 0.6 * jaccard(ta, tb) + 0.4 * dice(a, b);
  if (ta[ta.length - 1] === tb[tb.length - 1]) s += 0.15;
  return Math.min(1, s);
}

/** Non-stopword tokens shared by two surfaces — the grounding for a link. */
export function anchors(a: string, b: string): string[] {
  const B = new Set(toks(b));
  return toks(a).filter((w) => B.has(w));
}

const PLACEHOLDER = /^(you|them|me|myself|agent|customer|speaker ?\d*|unknown)$/;

/**
 * The gate. Returns null to pass, or the reason it was blocked — matching the
 * `Gate<T>` contract the receipts gate already uses.
 */
export function canonicalGate(hasProof: (c: Candidate) => boolean): Gate<Resolution> {
  return (r) => {
    if (r.kind === "person" && PLACEHOLDER.test(normalize(r.surface)))
      return `speaker placeholder "${r.surface}" is not a person — no canonical identity`;
    if (!r.surface.trim()) return "empty surface";
    if (!hasProof(r))
      return `no transcript proof for "${r.surface}" — a mention without a receipt cannot link meetings`;
    if (r.entityId && r.matcher === "lexical" && r.score - r.runnerUp < MARGIN)
      return `ambiguous: ${r.score.toFixed(2)} vs runner-up ${r.runnerUp.toFixed(2)}, margin < ${MARGIN}`;
    return null;
  };
}

type Row = { id: string; kind: string; label: string; pinned: number };

/**
 * Resolve one meeting's candidates against everything already known.
 *
 * Resolution is sequential and best-evidence-first: an accepted candidate
 * immediately joins the `known` pool, so "warehouse migration issue" (from a
 * decision) and "warehouse migration" (from repetition) resolve to ONE entity
 * even when both arrive in the same meeting. Without this, one meeting mints
 * near-duplicate entities that nothing ever merges.
 */
export function resolveCandidates(db: DatabaseSync, cands: Candidate[]): Resolution[] {
  const aliasHit = db.prepare(
    "SELECT e.id FROM entity_aliases a JOIN entities e ON e.id = a.entity_id WHERE a.norm = ? AND e.kind = ? AND e.merged_into IS NULL",
  );
  const known = db
    .prepare("SELECT id, kind, label, pinned FROM entities WHERE merged_into IS NULL")
    .all() as Row[];

  return cands.map((c) => {
    const r = resolveOne(c);
    if (r.entityId === null)
      known.push({ id: slug(c.kind, c.surface), kind: c.kind, label: c.surface, pinned: 0 });
    return r;
  });

  function resolveOne(c: Candidate): Resolution {
    const norm = normalize(c.surface);

    // Rung 1 — exact alias. O(1), and the reason we never re-decide a string.
    const hit = aliasHit.get(norm, c.kind) as { id: string } | undefined;
    if (hit)
      return { ...c, entityId: hit.id, matcher: "alias" as const, score: 1, runnerUp: 0,
        reason: `exact alias match on "${c.surface}"` };

    // Rung 2 — canonical slug. Catches casing/punctuation/article drift.
    const id = slug(c.kind, c.surface);
    if (known.some((k) => k.id === id))
      return { ...c, entityId: id, matcher: "slug" as const, score: 0.95, runnerUp: 0,
        reason: `slug match on ${id}` };

    // Rung 3 — token containment: "warehouse migration" inside "warehouse
    // migration issue" is the same thing wearing a qualifier. Near-certain,
    // and cheaper to state as its own rule than to hope similarity() clears
    // the merge bar on it.
    const myToks = toks(c.surface);
    if (myToks.length) {
      const contained = known
        .filter((k) => k.kind === c.kind)
        .find((k) => {
          const kt = toks(k.label);
          if (!kt.length) return false;
          const [small, big] = myToks.length <= kt.length ? [myToks, kt] : [kt, myToks];
          const B = new Set(big);
          return small.every((w) => B.has(w));
        });
      if (contained)
        return { ...c, entityId: contained.id, matcher: "contains" as const, score: 0.9, runnerUp: 0,
          reason: `"${c.surface}" and "${contained.label}" contain one another's tokens` };
    }

    // Rung 4 — lexical similarity, same kind only.
    const scored = known
      .filter((k) => k.kind === c.kind)
      .map((k) => ({ k, s: similarity(c.surface, k.label) }))
      .sort((x, y) => y.s - x.s);
    const best = scored[0], second = scored[1];
    if (best && best.s >= MERGE_LEXICAL) {
      const shared = anchors(c.surface, best.k.label);
      return { ...c, entityId: best.k.id, matcher: "lexical" as const, score: best.s,
        runnerUp: second?.s ?? 0,
        reason: `lexical ${best.s.toFixed(2)} to "${best.k.label}"${shared.length ? `, anchored on "${shared.join(", ")}"` : ""}` };
    }

    return { ...c, entityId: null, matcher: "none" as const, score: best?.s ?? 0,
      runnerUp: second?.s ?? 0,
      reason: `no match above ${MERGE_LEXICAL} — created new entity` };
  }
}

/**
 * Persist resolutions. Returns a StepRecord so the run panel shows what merged
 * and what didn't, with no UI work.
 */
export function storeResolutions(
  db: DatabaseSync,
  meetingId: string,
  resolutions: Resolution[],
  hasProof: (c: Candidate) => boolean,
): { step: StepRecord; passed: number; blocked: number } {
  const now = Date.now();
  const { kept, blocked } = applyGate(resolutions, canonicalGate(hasProof));

  const insEntity = db.prepare(
    "INSERT INTO entities (id, kind, label, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
  );
  const insAlias = db.prepare(
    "INSERT INTO entity_aliases (entity_id, norm, alias, matcher, score, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
  );
  const insMention = db.prepare(
    `INSERT INTO entity_mentions (entity_id, meeting_id, surface, offset_s, quote, source, matcher, score, gate, gate_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
  );

  for (const r of kept) {
    const id = r.entityId ?? slug(r.kind, r.surface);
    insEntity.run(id, r.kind, r.surface, now);
    // The entity learns: next time this surface is a rung-1 hit.
    insAlias.run(id, normalize(r.surface), r.surface, r.matcher, r.score, r.reason, now);
    insMention.run(id, meetingId, r.surface, r.offset_s ?? null, r.quote ?? null, r.source, r.matcher, r.score, "passed", null);
  }

  // Blocked mentions still get an entity of their own — nothing vanishes, the
  // row just records who it nearly merged with and why it didn't. EXCEPT
  // speaker placeholders ("You"/"Them"): every live meeting produces them, the
  // rejection is categorical rather than evidential, and the ghost entities
  // pollute the graph. The step record already counts them.
  for (const { item: r, reason } of blocked) {
    if (reason.includes("speaker placeholder")) continue;
    const id = slug(r.kind, r.surface);
    insEntity.run(id, r.kind, r.surface, now);
    insMention.run(id, meetingId, r.surface, r.offset_s ?? null, r.quote ?? null, r.source, r.matcher, r.score, "blocked", reason);
  }

  return {
    passed: kept.length,
    blocked: blocked.length,
    step: {
      name: "resolve:entities",
      status: blocked.length ? "blocked" : "ok",
      attempts: 1,
      ms: 0,
      reason: blocked.length
        ? because("grounding-blocked", `${blocked.length} of ${resolutions.length} mentions could not be canonicalised`)
        : undefined,
    },
  };
}

/**
 * Scored `related` edges between distinct entities that share a subject.
 * This is what answers "which meetings discussed ANZ?" without asserting that
 * "ANZ rollout" and "ANZ pricing" are the same thing — a claim the data does
 * not support.
 */
export function relateEntities(db: DatabaseSync): { pairs: number; step: StepRecord } {
  const ents = db
    .prepare("SELECT id, kind, label FROM entities WHERE merged_into IS NULL AND kind = 'topic'")
    .all() as Row[];
  const ins = db.prepare(
    "INSERT INTO edges (src, dst, kind, meeting_id) VALUES (?, ?, 'related', '') ON CONFLICT DO NOTHING",
  );
  let pairs = 0;
  for (let i = 0; i < ents.length; i++)
    for (let j = i + 1; j < ents.length; j++) {
      const s = similarity(ents[i].label, ents[j].label);
      if (s < RELATE_MIN || s >= MERGE_LEXICAL) continue;
      if (!anchors(ents[i].label, ents[j].label).length) continue; // shared-token grounding
      ins.run(ents[i].id, ents[j].id);
      ins.run(ents[j].id, ents[i].id);
      pairs++;
    }
  return { pairs, step: { name: "resolve:relate", status: "ok", attempts: 1, ms: 0, reason: because("info", `${pairs} related pair(s)`) } };
}
