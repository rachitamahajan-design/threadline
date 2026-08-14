/**
 * The anti-hallucination harness: deterministic validators, no model involved.
 *
 * The model we ship on is not frontier-grade and may be swapped for a worse
 * one. So correctness does not live in the prompt — it lives here, in code that
 * can be unit-tested and that fails closed. Every rule below answers one
 * question about output the model just produced:
 *
 *   source-exists      does every cited segment id actually exist?
 *   leaf-sourced       does every claim carry at least one citation?
 *   theme-claim-free   does this topic label assert something no child carries?
 *   owner-whitelist    is this owner a real participant (or "Unassigned")?
 *   verbatim-number    does every number/price/%/date appear in the cited text?
 *   exact-quote        is every quoted span really a substring of one segment?
 *   no-memory-source   is any citation reaching outside this meeting?
 *   unstated-verdict   does the cited line actually state this hire/no-hire call?
 *
 * One rule is model-assisted and lives in pipeline/entail.ts: entailment-
 * unsupported, the per-leaf "do the citations actually support this?" check —
 * the semantic net that catches paraphrase drift ("let's launch" becoming
 * "wants to launch asap"). Whether it blocks or merely flags is the
 * gates.entailment config.
 *
 * Plus two SOFT rules about usefulness rather than truth — they earn a rewrite,
 * never a deletion: bullet-is-a-title and owner-unnamed.
 *
 * If a rule and a prompt instruction ever disagree, the rule wins.
 */
import { LOW_CONFIDENCE, citedText, restsOnLowConfidence, type Participant, type Segment } from "./segments.js";
import {
  UNASSIGNED,
  descendantLeaves,
  isLeaf,
  walkBullets,
  type ActionItem,
  type NoteBullet,
  type Notes,
  type SourcedItem,
} from "./outline.js";

export type Rule =
  | "source-exists"
  | "leaf-sourced"
  | "theme-claim-free"
  | "owner-whitelist"
  | "verbatim-number"
  | "exact-quote"
  | "no-memory-source"
  /** A verdict/lean the cited segment does not actually state (see checkStatedVerdict). */
  | "unstated-verdict"
  /** A claim the entailment gate judged unsupported by its own citations (pipeline/entail.ts). */
  | "entailment-unsupported"
  /** SOFT: a bullet that reads as a heading rather than a point (see checkBulletIsAPoint). */
  | "bullet-is-a-title"
  /** SOFT: an action-item bullet that names no owner (see checkActionOwnerNamed). */
  | "owner-unnamed";

/**
 * Soft rules are about usefulness, not truth.
 *
 * A bullet reading "Net burn rate" cited to a line that says "one hundred eighty
 * thousand a month" is not a lie — it is just worthless, and a weak model
 * produces them constantly because vagueness feels safe to it. So soft failures
 * drive a regeneration, but they never delete content and they never raise the
 * "low confidence, please review" banner: that banner has to keep meaning
 * "grounding is in doubt", or it stops meaning anything.
 */
export const SOFT_RULES: Rule[] = ["bullet-is-a-title", "owner-unnamed"];

export function isSoft(f: Failure): boolean {
  return SOFT_RULES.includes(f.rule);
}

export type Failure = {
  /** Where in the output: a notes path ("0.1.2") or an item address ("perOwner[0].items[2]"). */
  path: string;
  rule: Rule;
  /** Phrased to be pasted straight back into the model on a retry. */
  detail: string;
};

export type GroundingContext = {
  segments: Segment[];
  index: Map<string, Segment>;
  /** Lower-cased legal owners, including "unassigned". */
  owners: Set<string>;
  ownerNames: string[];
  /** Ids the model was shown as memory/brain context. Never a legal source. */
  memoryIds: Set<string>;
};

export function groundingContext(opts: {
  segments: Segment[];
  participants?: Participant[] | string[];
  memoryIds?: Iterable<string>;
}): GroundingContext {
  const names = (opts.participants ?? []).map((p) => (typeof p === "string" ? p : p.name)).filter(Boolean);
  // Speakers heard in the transcript are participants whether or not the caller
  // listed them — otherwise a real owner gets rejected for a bookkeeping gap.
  const heard = [...new Set(opts.segments.map((s) => s.speaker).filter(Boolean))];
  const ownerNames = [...new Set([...names, ...heard])];
  return {
    segments: opts.segments,
    index: new Map(opts.segments.map((s) => [s.id, s])),
    owners: new Set([...ownerNames.map((n) => n.toLowerCase()), UNASSIGNED.toLowerCase()]),
    ownerNames,
    memoryIds: new Set(opts.memoryIds ?? []),
  };
}

// ── Rule 1 + 7: citations exist, and point inside THIS meeting ───────────────

export function checkSources(sourceIds: unknown, path: string, ctx: GroundingContext): Failure[] {
  if (!Array.isArray(sourceIds) || sourceIds.length === 0)
    return [{ path, rule: "leaf-sourced", detail: `${path} carries no source — every claim needs >=1 segment id` }];
  const out: Failure[] = [];
  for (const id of sourceIds) {
    if (typeof id !== "string" || !id.trim()) {
      out.push({ path, rule: "leaf-sourced", detail: `${path} has a source entry that is not a segment id` });
      continue;
    }
    // `mem:`/`brain:` prefixes are how memory context is labelled. Note the
    // deliberate absence of a bare "m" — cross-meeting handoffs cite "M2:S004".
    if (ctx.memoryIds.has(id) || /^(mem|memory|brain)[:\-]/i.test(id)) {
      out.push({
        path,
        rule: "no-memory-source",
        detail: `${path} cites ${id}, which is memory from another meeting — memory can label a theme but can never source a claim about this meeting`,
      });
      continue;
    }
    if (!ctx.index.has(id))
      out.push({
        path,
        rule: "source-exists",
        detail: `${path} cites ${id}, which is not a segment in this meeting`,
      });
  }
  return out;
}

// ── Rule 5: numbers, prices, percentages and dates must be verbatim ─────────

const MONTHS = [
  ["january", "jan"],
  ["february", "feb"],
  ["march", "mar"],
  ["april", "apr"],
  ["may"],
  ["june", "jun"],
  ["july", "jul"],
  ["august", "aug"],
  ["september", "sept", "sep"],
  ["october", "oct"],
  ["november", "nov"],
  ["december", "dec"],
];
const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

const NUM_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const NUM_SCALES: Record<string, number> = { hundred: 100, thousand: 1000, million: 1e6, billion: 1e9 };

/**
 * Spelled-out numbers, with the phrase that produced each value.
 *
 * Needed in both directions. STT writes "forty eight thousand" where the model
 * writes "$48,000", so the cited text has to be expanded before matching — and
 * the model sometimes writes "fifty two thousand dollars" too, which would sail
 * straight past a digits-only guard.
 */
export function numberWordSpans(text: string): { phrase: string; value: number }[] {
  const tokens = [...text.toLowerCase().matchAll(/[a-z]+/g)];
  const found: { phrase: string; value: number }[] = [];
  let total = 0;
  let current = 0;
  let start = -1;
  let end = -1;
  const flush = () => {
    if (start >= 0) {
      const value = total + current;
      if (value > 0) found.push({ phrase: text.slice(start, end).trim(), value });
    }
    total = 0;
    current = 0;
    start = -1;
    end = -1;
  };
  for (const m of tokens) {
    const w = m[0];
    const isNumberWord = w in NUM_WORDS || w in NUM_SCALES;
    if (w === "and" && start >= 0) continue;
    if (!isNumberWord) {
      flush();
      continue;
    }
    if (start < 0) start = m.index!;
    end = m.index! + w.length;
    if (w in NUM_WORDS) {
      current += NUM_WORDS[w];
    } else {
      const scale = NUM_SCALES[w];
      if (scale >= 1000) {
        total += (current || 1) * scale;
        current = 0;
      } else {
        current = (current || 1) * scale;
      }
    }
  }
  flush();
  return found;
}

/** The values only, joined — the form the haystack wants. */
export function expandNumberWords(text: string): string {
  return numberWordSpans(text).map((s) => String(s.value)).join(" ");
}

/** Lower-case, currency/percent words unified, number words expanded. */
export function haystack(text: string): string {
  const base = text
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[’]/g, "'")
    .replace(/\s+/g, " ");
  const digitsOnly = base.replace(/(\d),(\d)/g, "$1$2"); // 25,000 → 25000
  return [base, digitsOnly, expandNumberWords(base)].join(" ␟ ");
}

type NumToken = { raw: string; forms: string[] };

/**
 * Every number-ish token in a piece of output, with the alternate spellings we
 * accept as the same fact. Deliberately generous on FORMS (so 20% matches
 * "twenty percent") and strict on PRESENCE (the digits have to be there).
 */
export function numericTokens(text: string): NumToken[] {
  const out: NumToken[] = [];
  const push = (raw: string, forms: string[]) => out.push({ raw, forms: [...new Set(forms.map((f) => f.toLowerCase()))] });
  const clean = text.replace(/\[[^\]]*\]/g, " "); // drop [S001] citation markers

  // Money, percentages and bare numbers, with optional k/m/bn suffixes.
  const numRe = /(\$|usd\s*|€|£)?\s?(\d[\d,]*(?:\.\d+)?)\s*(%|percent|k\b|m\b|mm\b|bn\b|b\b|million|billion|thousand)?/gi;
  for (const m of clean.matchAll(numRe)) {
    const [, cur, digits, suffix] = m;
    const bare = digits.replace(/,/g, "");
    const forms = [m[0].trim(), digits, bare];
    const n = Number(bare);
    if (Number.isFinite(n)) {
      forms.push(withCommas(n));
      const s = (suffix ?? "").toLowerCase();
      if (s === "%" || s === "percent") forms.push(`${bare}%`, `${bare} percent`, `${withCommas(n)} percent`);
      if (s === "k" || s === "thousand") forms.push(String(n * 1000), withCommas(n * 1000), `${bare} thousand`, `${bare}k`);
      if (s === "m" || s === "mm" || s === "million") forms.push(String(n * 1e6), withCommas(n * 1e6), `${bare} million`, `${bare}m`);
      if (s === "b" || s === "bn" || s === "billion") forms.push(String(n * 1e9), `${bare} billion`, `${bare}bn`);
      if (cur) forms.push(`${bare} dollars`, `${withCommas(n)} dollars`);
    }
    push(m[0].trim(), forms);
  }

  // Numbers the model spelled out. Without this, "fifty two thousand dollars"
  // cited to a segment saying "forty eight thousand" would pass unchallenged.
  for (const span of numberWordSpans(clean)) {
    // Skip tiny counts ("one more thing", "three times"): they are ordinary
    // prose, they are checked as words by the quote rules, and treating them as
    // figures produces noise that gets the whole guard distrusted.
    if (span.value < 10) continue;
    push(span.phrase, [span.phrase, String(span.value), withCommas(span.value)]);
  }

  // Dates: ISO, numeric, month names and weekday names.
  for (const m of clean.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const monthNames = MONTHS[Number(m[2]) - 1] ?? [];
    const day = String(Number(m[3]));
    push(m[0], [m[0], `${m[2]}/${m[3]}`, `${Number(m[2])}/${day}`, ...monthNames.map((mo) => `${mo} ${day}`)]);
  }
  // Month and weekday names keep the writer's own casing as `raw`, so the
  // failure message quotes the offending output back verbatim and the model can
  // find the line it has to fix.
  for (const group of MONTHS) {
    let hit: string | null = null;
    for (const name of group) {
      const m = clean.match(new RegExp(`\\b${name}\\b`, "i"));
      if (m) {
        hit = m[0];
        break; // one hit per month is enough — they are aliases of each other
      }
    }
    if (hit) push(hit, group);
  }
  for (const day of WEEKDAYS) {
    const m = clean.match(new RegExp(`\\b${day}\\b`, "i"));
    if (m) push(m[0], [day, day.slice(0, 3)]);
  }
  return dedupeByRaw(out);
}

function withCommas(n: number): string {
  return n.toLocaleString("en-US");
}

function dedupeByRaw(tokens: NumToken[]): NumToken[] {
  const seen = new Map<string, NumToken>();
  for (const t of tokens) {
    const key = t.raw.toLowerCase();
    if (!seen.has(key)) seen.set(key, t);
  }
  return [...seen.values()];
}

/** The number-ish tokens in `text` that appear nowhere in `cited`. */
export function verbatimMisses(text: string, cited: string): NumToken[] {
  const hay = haystack(cited);
  return numericTokens(text).filter((t) => !t.forms.some((f) => hay.includes(f)));
}

export function checkVerbatim(text: string, sourceIds: string[], path: string, ctx: GroundingContext): Failure[] {
  const cited = citedText(ctx.index, sourceIds);
  if (!cited) return []; // source-existence already failed; don't pile on
  return verbatimMisses(text, cited).map((t) => ({
    path,
    rule: "verbatim-number" as const,
    detail: `${path} states "${t.raw}", which does not appear in its cited segments (${sourceIds.join(", ")}). Quote the number exactly as it was said, or drop the claim.`,
  }));
}

/**
 * The bullet that is really a heading: "Net burn rate", "Platform license cost",
 * "ANZ pricing timeline". Three words or fewer, no figure of its own, cited to a
 * line that does state one — which is the shape a weak model falls into when it
 * has already written a summary and treats the bullets as an index.
 *
 * The word-count condition is what keeps it honest. Without it the rule fired on
 * "Rachita: send the security questionnaire this week", whose segment happens to
 * mention October too: a segment usually holds several statements, and a bullet
 * is entitled to carry only one of them.
 */
const TITLEISH_MAX_WORDS = 3;

export function checkBulletIsAPoint(text: string, sourceIds: string[], path: string, ctx: GroundingContext): Failure[] {
  if (contentWords(text).length > TITLEISH_MAX_WORDS) return []; // a real sentence
  if (numericTokens(text).length) return []; // carries its own figure
  const cited = citedText(ctx.index, sourceIds);
  const citedFigures = cited ? numericTokens(cited) : [];
  if (!citedFigures.length) return [];
  return [
    {
      path,
      rule: "bullet-is-a-title",
      detail: `${path} ("${text}") reads as a heading, not a point: it states nothing, while the line it cites says "${citedFigures[0].raw}". Rewrite it as a full statement carrying that figure exactly as it was said — a topic name belongs in the section label instead.`,
    },
  ];
}

// ── Rule 6: a quoted span must be an exact substring of ONE cited segment ───

export function quotedSpans(text: string): string[] {
  const spans: string[] = [];
  for (const m of text.matchAll(/[“"]([^“”"]{2,})[”"]/g)) {
    const inner = m[1].trim().replace(/^[\s.,;:!?—-]+|[\s.,;:!?—-]+$/g, "");
    if (inner) spans.push(inner);
  }
  return spans;
}

const flat = (s: string) =>
  s.toLowerCase().replace(/[“”]/g, '"').replace(/[’]/g, "'").replace(/\s+/g, " ").trim();

export function checkQuotes(text: string, sourceIds: string[], path: string, ctx: GroundingContext): Failure[] {
  const segs = sourceIds.map((id) => ctx.index.get(id)).filter((s): s is Segment => !!s);
  if (!segs.length) return [];
  return quotedSpans(text)
    .filter((q) => !segs.some((s) => flat(s.text).includes(flat(q))))
    .map((q) => ({
      path,
      rule: "exact-quote" as const,
      detail: `${path} quotes "${q}", which is not an exact substring of any cited segment (${sourceIds.join(", ")}). Use the words that were actually said, or paraphrase without quote marks.`,
    }));
}

// ── Lexical overlap: the one cheap handle we have on qualitative claims ─────
// Substring guards catch invented figures and misquotes. They cannot catch
// "strong hire" attached to a segment about latency. Overlap is a weak signal,
// so it is used in exactly two places: the hire/no-hire verdict below (where a
// fabrication is most costly) and the eval script's precision score.

const STOP = new Set(
  ("a an and the to of in on for with is are was were be been it its this that they we you i he she them us our your " +
    "as at by from or but if then than so not no yes do does did have has had will would can could should about into " +
    "over under out up down more most less least very really just also too only there here what which who whom whose")
    .split(" "),
);

export function contentWords(text: string): string[] {
  return flat(text)
    .replace(/[^a-z0-9\s%$.-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/** Share of the claim's content words that appear in the cited text (0..1). */
export function lexicalOverlap(text: string, cited: string): number {
  const words = [...new Set(contentWords(text))];
  if (!words.length) return 1;
  const hay = haystack(cited);
  return words.filter((w) => hay.includes(w)).length / words.length;
}

const VERDICT_MARKERS =
  /\b(hire|no[- ]hire|yes from me|no from me|a yes|a no|strong yes|strong no|thumbs (up|down)|pass on|passing on|not a fit|make an offer|an offer|lean(ing)? (yes|no|towards|toward)|move forward|move ahead)\b/i;

/**
 * A stated hire/no-hire lean must actually be stated. Two deterministic
 * conditions: the cited segment contains a verdict marker, and the write-up
 * stays lexically close to it. A model that infers a verdict from the balance of
 * strengths and concerns fails both, which is the entire point.
 */
export function checkStatedVerdict(
  lean: { text: string; source: string[] },
  path: string,
  ctx: GroundingContext,
  minOverlap = 0.4,
): Failure[] {
  const cited = citedText(ctx.index, lean.source);
  if (!cited) return [];
  if (!VERDICT_MARKERS.test(cited))
    return [
      {
        path,
        rule: "unstated-verdict",
        detail: `${path} reports a hire/no-hire lean, but the cited segment (${lean.source.join(", ")}) does not state one. Set "statedLean" to null unless the interviewer said it out loud.`,
      },
    ];
  if (lexicalOverlap(lean.text, cited) < minOverlap)
    return [
      {
        path,
        rule: "unstated-verdict",
        detail: `${path} restates the lean as "${lean.text}", which does not track what the cited segment says. Report the lean in the interviewer's own terms, or set it to null.`,
      },
    ];
  return [];
}

// ── Rule 4: owners are whitelisted participants ─────────────────────────────

export function checkOwner(owner: unknown, path: string, ctx: GroundingContext): Failure[] {
  const name = typeof owner === "string" ? owner.trim() : "";
  if (!name)
    return [{ path, rule: "owner-whitelist", detail: `${path}.owner is empty — use a participant name or "${UNASSIGNED}"` }];
  if (ctx.owners.has(name.toLowerCase())) return [];
  return [
    {
      path,
      rule: "owner-whitelist",
      detail: `${path}.owner is "${name}", who is not a participant. Allowed owners: ${ctx.ownerNames.join(", ")}, ${UNASSIGNED}.`,
    },
  ];
}

/** Section labels whose bullets are commitments and therefore need an owner. */
export const ACTION_SECTION = /\b(action items?|next steps?|commitments?|to-?dos?|follow[- ]?ups?)\b/i;

/**
 * An action-item bullet has to name someone. Soft, not hard: the bullet is still
 * true and still sourced, so deleting it would lose real work — but a commitment
 * with no owner is how work quietly stops happening, so it earns a rewrite. The
 * hard whitelist guarantee lives on ActionItem.owner in the handoffs, where the
 * owner is a field that gets forwarded rather than prose.
 */
export function checkActionOwnerNamed(text: string, path: string, ctx: GroundingContext): Failure[] {
  const hay = flat(text);
  if (/^\s*unassigned\b/i.test(text)) return [];
  const named = ctx.ownerNames.some(
    (n) => n.length >= 3 && new RegExp(`\\b${escapeRe(n.toLowerCase())}\\b`).test(hay),
  );
  if (named) return [];
  return [
    {
      path,
      rule: "owner-unnamed",
      detail: `${path} ("${text.slice(0, 60)}") is an action item that names no owner. Start it with a participant name — ${ctx.ownerNames.join(", ")} — or with "Unassigned:" if nobody took it.`,
    },
  ];
}

// ── Rule 3: theme labels are labels, not claims ─────────────────────────────

/**
 * Verb stems that turn a topic label into an assertion. Listed with their
 * inflections so the check needs no stemmer: a header may use one only if a
 * descendant leaf uses the same stem.
 */
const CLAIM_VERBS: Record<string, string[]> = {
  decide: ["decide", "decided", "decides", "deciding", "decision"],
  agree: ["agree", "agreed", "agrees"],
  approve: ["approve", "approved", "approves"],
  reject: ["reject", "rejected", "rejects"],
  commit: ["commit", "committed", "commits"],
  sign: ["sign", "signed", "signs"],
  delay: ["delay", "delayed", "delays", "slip", "slipped"],
  move: ["moved", "moves", "moving"],
  launch: ["launch", "launched", "launches"],
  cut: ["cut", "cuts"],
  drop: ["drop", "dropped", "drops"],
  raise: ["raise", "raised", "raises"],
  choose: ["choose", "chose", "chosen", "picked"],
  will: ["will", "shall"],
  wont: ["won't", "wont"],
};

/**
 * A theme/sub-theme label may only contain claim-bearing tokens that a
 * descendant leaf also carries. "Pricing" is always fine. "Pricing moved to
 * September" is fine only if some leaf under it says both.
 */
export function checkThemeHeader(label: NoteBullet, path: string, ctx: GroundingContext): Failure[] {
  if (isLeaf(label)) return [];
  const leafText = flat(descendantLeaves(label).map((l) => l.text).join(" ｜ "));
  const header = label.text;
  const hLower = flat(header);
  // One failure per header listing everything wrong with it: the repair prompt
  // dedupes by path+rule, so splitting these would silently drop the rest.
  const offences: string[] = [];

  for (const t of numericTokens(header)) {
    if (!t.forms.some((f) => leafText.includes(f))) offences.push(`the number/date "${t.raw}"`);
  }
  for (const forms of Object.values(CLAIM_VERBS)) {
    const used = forms.find((f) => new RegExp(`\\b${escapeRe(f)}\\b`).test(hLower));
    if (used && !forms.some((f) => new RegExp(`\\b${escapeRe(f)}\\b`).test(leafText))) offences.push(`the decision "${used}"`);
  }
  for (const name of ctx.ownerNames) {
    const n = name.toLowerCase();
    if (n.length < 3) continue;
    if (new RegExp(`\\b${escapeRe(n)}\\b`).test(hLower) && !new RegExp(`\\b${escapeRe(n)}\\b`).test(leafText))
      offences.push(`the attribution to "${name}"`);
  }
  if (!offences.length) return [];
  return [
    {
      path,
      rule: "theme-claim-free",
      detail: `theme label ${path} ("${header}") asserts ${offences.join(" and ")} — none of its child bullets carry that. A theme label must be a topic only: rename it to the topic and move the claim into a sourced child bullet.`,
    },
  ];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Composite validators ────────────────────────────────────────────────────

/** Every rule, over a whole Notes tree. Empty array means the notes may ship. */
export function validateNotes(notes: Notes, ctx: GroundingContext): Failure[] {
  const failures: Failure[] = [];
  // The overview is prose, but prose that states facts is still a claim.
  if (notes.summary?.text) {
    const src = notes.summary.source ?? [];
    const srcFailures = checkSources(src, "summary", ctx);
    failures.push(...srcFailures);
    if (!srcFailures.length) {
      failures.push(...checkVerbatim(notes.summary.text, src, "summary", ctx));
      failures.push(...checkQuotes(notes.summary.text, src, "summary", ctx));
    }
  }
  walkBullets(notes, (b, path) => {
    if (!isLeaf(b)) {
      if (b.source !== undefined && b.source.length)
        failures.push({
          path,
          rule: "theme-claim-free",
          detail: `theme label ${path} carries "source" — labels assert nothing, so they cite nothing. Sources belong on leaf bullets.`,
        });
      failures.push(...checkThemeHeader(b, path, ctx));
      return;
    }
    const src = b.source ?? [];
    const srcFailures = checkSources(src, path, ctx);
    failures.push(...srcFailures);
    if (srcFailures.length) return; // no point checking text against citations we rejected
    failures.push(...checkVerbatim(b.text, src, path, ctx));
    failures.push(...checkQuotes(b.text, src, path, ctx));
    failures.push(...checkBulletIsAPoint(b.text, src, path, ctx));
    // Which section a bullet sits under changes what is expected of it: the
    // top-level label is the first component of its path.
    const section = notes.themes[Number(path.split(".")[0])]?.text ?? "";
    if (ACTION_SECTION.test(section)) failures.push(...checkActionOwnerNamed(b.text, path, ctx));
  });
  return failures;
}

export function validateSourcedItems(items: SourcedItem[] | undefined, prefix: string, ctx: GroundingContext): Failure[] {
  const failures: Failure[] = [];
  (items ?? []).forEach((item, i) => {
    const path = `${prefix}[${i}]`;
    const text = typeof item?.text === "string" ? item.text : "";
    if (!text.trim()) failures.push({ path, rule: "leaf-sourced", detail: `${path}.text is empty` });
    const srcFailures = checkSources(item?.source, path, ctx);
    failures.push(...srcFailures);
    if (srcFailures.length) return;
    failures.push(...checkVerbatim(text, item.source, path, ctx));
    failures.push(...checkQuotes(text, item.source, path, ctx));
  });
  return failures;
}

export function validateActionItems(items: ActionItem[] | undefined, prefix: string, ctx: GroundingContext): Failure[] {
  const failures: Failure[] = [];
  (items ?? []).forEach((item, i) => {
    const path = `${prefix}[${i}]`;
    const text = typeof item?.text === "string" ? item.text : "";
    if (!text.trim()) failures.push({ path, rule: "leaf-sourced", detail: `${path}.text is empty` });
    failures.push(...checkOwner(item?.owner, path, ctx));
    const srcFailures = checkSources(item?.source, path, ctx);
    failures.push(...srcFailures);
    if (srcFailures.length) return;
    // The due date faces the same verbatim guard as the body: a date nobody
    // said is the single most common invented field in a meeting note.
    failures.push(...checkVerbatim(`${text} ${item.due ?? ""}`.trim(), item.source, path, ctx));
    failures.push(...checkQuotes(text, item.source, path, ctx));
  });
  return failures;
}

// ── Low confidence is computed, never trusted ───────────────────────────────

/**
 * A claim resting only on segments STT heard poorly is flagged. The model is
 * asked to do this too, but we recompute it: `lowConfidence` is derived data and
 * derived data is ours.
 */
export function markLowConfidence<T extends { source?: string[]; lowConfidence?: boolean }>(
  items: T[],
  ctx: GroundingContext,
): number {
  let flagged = 0;
  for (const item of items) {
    const low = restsOnLowConfidence(ctx.index, item.source ?? []);
    if (low) {
      item.lowConfidence = true;
      flagged++;
    } else if (item.lowConfidence) {
      delete item.lowConfidence;
    }
  }
  return flagged;
}

export function markNotesConfidence(notes: Notes, ctx: GroundingContext): number {
  const items: { source?: string[]; lowConfidence?: boolean }[] = [];
  if (notes.summary) items.push(notes.summary);
  walkBullets(notes, (b) => {
    if (isLeaf(b)) items.push(b);
  });
  return markLowConfidence(items, ctx);
}

/** Prompt-ready failure list. Deduped and capped: a 200-line scolding helps nobody. */
export function formatFailures(failures: Failure[], max = 12): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const f of failures) {
    const key = `${f.path}|${f.rule}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`- [${f.rule}] ${f.detail}`);
    if (lines.length >= max) break;
  }
  const extra = failures.length - lines.length;
  return lines.join("\n") + (extra > 0 ? `\n- (and ${extra} more of the same kinds)` : "");
}

export { LOW_CONFIDENCE };
