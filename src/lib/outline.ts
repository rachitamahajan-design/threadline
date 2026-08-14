/**
 * The notes document: a themed outline, plus the shared item shapes every
 * handoff is built from.
 *
 * Two rules give this file its whole shape:
 *   1. A LEAF is a claim and must carry >=1 segment id. No source, no leaf.
 *   2. A NON-LEAF is a topic label. It carries no source because it asserts
 *      nothing; its support is the union of its descendants' sources.
 *
 * The tree is the stored form and Markdown is the wire form, and they round-trip
 * exactly — the UI is allowed to edit either one without losing receipts.
 */

/** A recursive bullet. Labels have children; leaves have sources. */
export type NoteBullet = {
  text: string;
  children?: NoteBullet[];
  /** REQUIRED on leaves (>=1 segment id); omitted on labels. */
  source?: string[];
  lowConfidence?: boolean;
  /** True once a human has touched this bullet. Set by the UI, never by a model. */
  edited?: boolean;
};

export type Notes = {
  /**
   * The 2-4 sentence overview the reader sees first. It is prose, but it is
   * still a claim, so it cites the segments it rests on and faces the same
   * verbatim/quote guards as any leaf.
   */
  summary?: SourcedItem;
  themes: NoteBullet[];
};

/** Shared building blocks for handoffs. `source` is never optional. */
export type SourcedItem = { text: string; source: string[]; lowConfidence?: boolean };

export type ActionItem = {
  text: string;
  /** MUST be a participant name or "Unassigned". */
  owner: string;
  /** ISO or a phrase lifted from the transcript; never invented. */
  due?: string | null;
  source: string[];
  lowConfidence?: boolean;
};

export const UNASSIGNED = "Unassigned";

export function isLeaf(b: NoteBullet): boolean {
  return !b.children || b.children.length === 0;
}

/** Every leaf in document order with its dotted path ("0.2.1"). */
export function walkLeaves(notes: Notes, fn: (leaf: NoteBullet, path: string) => void): void {
  const walk = (bullets: NoteBullet[], prefix: string) => {
    bullets.forEach((b, i) => {
      const path = prefix ? `${prefix}.${i}` : String(i);
      if (isLeaf(b)) fn(b, path);
      else walk(b.children!, path);
    });
  };
  walk(notes.themes, "");
}

/** Every bullet (labels included) in document order with its path. */
export function walkBullets(notes: Notes, fn: (b: NoteBullet, path: string, depth: number) => void): void {
  const walk = (bullets: NoteBullet[], prefix: string, depth: number) => {
    bullets.forEach((b, i) => {
      const path = prefix ? `${prefix}.${i}` : String(i);
      fn(b, path, depth);
      if (!isLeaf(b)) walk(b.children!, path, depth + 1);
    });
  };
  walk(notes.themes, "", 0);
}

export function bulletAtPath(notes: Notes, path: string): NoteBullet | null {
  const parts = path.split(".").map(Number);
  if (!parts.length || parts.some((n) => !Number.isInteger(n) || n < 0)) return null;
  let level: NoteBullet[] | undefined = notes.themes;
  let node: NoteBullet | undefined;
  for (const i of parts) {
    node = level?.[i];
    if (!node) return null;
    level = node.children;
  }
  return node ?? null;
}

/** Descendant leaves of a bullet — the support a label is allowed to imply. */
export function descendantLeaves(b: NoteBullet): NoteBullet[] {
  if (isLeaf(b)) return [b];
  return b.children!.flatMap(descendantLeaves);
}

/** The union of a bullet's descendant sources. A label's implied receipt. */
export function impliedSources(b: NoteBullet): string[] {
  return [...new Set(descendantLeaves(b).flatMap((l) => l.source ?? []))];
}

export function countLeaves(notes: Notes): number {
  let n = 0;
  walkLeaves(notes, () => n++);
  return n;
}

/**
 * Deterministic tree surgery — how the pipeline fails closed.
 *
 *   dropLeaf      an ungroundable claim is removed, never softened
 *   flattenLabel  a label that asserts something unverifiable disappears, and
 *                 its (valid, sourced) children move up a level — so killing a
 *                 bad header never costs us a real bullet
 *
 * Predicates take nodes, not paths, because paths shift as soon as the first
 * node is removed. Labels left with no children are dropped: a label with
 * nothing under it labels nothing.
 */
export function rebuildNotes(
  notes: Notes,
  opts: { dropLeaf?: (b: NoteBullet) => boolean; flattenLabel?: (b: NoteBullet) => boolean },
): { notes: Notes; dropped: number; flattened: number } {
  let dropped = 0;
  let flattened = 0;
  const walk = (bullets: NoteBullet[]): NoteBullet[] => {
    const kept: NoteBullet[] = [];
    for (const b of bullets) {
      if (isLeaf(b)) {
        if (opts.dropLeaf?.(b)) dropped++;
        else kept.push(b);
        continue;
      }
      const children = walk(b.children!);
      if (!children.length) {
        dropped++;
        continue;
      }
      if (opts.flattenLabel?.(b)) {
        flattened++;
        kept.push(...children);
        continue;
      }
      kept.push({ ...b, children });
    }
    return kept;
  };
  return { notes: { themes: walk(notes.themes) }, dropped, flattened };
}

// ── The readout's sections, per meeting mode ────────────────────────────────

/**
 * One section of a mode's readout: the canonical name, the wordings a model
 * might return that mean it, one line of guidance the prompt shows for it, and
 * whether its bullets are commitments (owner-first).
 */
export type SectionSpec = { name: string; match: RegExp; guide: string; actions?: boolean };

/** Shared by every mode: the catch-all where discussion topics land… */
const DISCUSSION: SectionSpec = {
  name: "Discussion",
  match: /^(discussion|topics?|what was discussed|notes)$/i,
  guide: "one sub-section per topic actually discussed, with the points under them",
};
/** …and the section for what was left hanging. */
const OPEN_QUESTIONS: SectionSpec = {
  name: "Open questions",
  match: /^(open questions?|questions?|unanswered|unknowns?)$/i,
  guide: "questions asked and left unanswered in this meeting",
};

/**
 * The mode decides the readout's vocabulary: an investor call reports traction
 * and asks, a vendor call reports pricing and scope. The FIRST spec is always
 * Discussion — it is the bucket everything unrecognised falls into.
 */
export const MODE_SECTIONS: Record<string, SectionSpec[]> = {
  team: [
    DISCUSSION,
    { name: "Decisions", match: /^(decisions?|what was decided|agreements?)$/i, guide: "things settled, not things considered" },
    {
      name: "Action items",
      match: /^(action items?|actions?|next steps?|commitments?|to-?dos?|follow[- ]?ups?)$/i,
      guide: "who does what next, and when if a time was said",
      actions: true,
    },
    {
      name: "Risks & concerns",
      match: /^(risks?( (&|and) concerns?)?|concerns?|blockers?|risks? raised)$/i,
      guide: "risks someone actually raised, kept attributed to their speaker",
    },
    OPEN_QUESTIONS,
  ],
  investor: [
    DISCUSSION,
    {
      name: "Traction & metrics",
      match: /^(traction( (&|and) metrics)?|metrics|numbers|kpis?|figures)$/i,
      guide: "every figure reported — revenue, growth, churn, runway — exactly as spoken",
    },
    {
      name: "Commitments & asks",
      match: /^(commitments?( (&|and) asks?)?|asks?|action items?|next steps?|follow[- ]?ups?)$/i,
      guide: "who owes what: intros, materials, decisions — including asks made of the investor",
      actions: true,
    },
    {
      name: "Risks raised",
      match: /^(risks?( raised| (&|and) concerns?)?|concerns?)$/i,
      guide: "risks the investor or founder actually raised",
    },
    OPEN_QUESTIONS,
  ],
  vendor: [
    DISCUSSION,
    {
      name: "Pricing & terms",
      match: /^(pricing( (&|and) terms)?|terms|prices?|quotes?|commercials?)$/i,
      guide: "prices, units, terms and expiries exactly as quoted — verbatim or left out",
    },
    {
      name: "Scope & integration",
      match: /^(scope( (&|and) integration)?|integration|implementation|security( (&|and) compliance)?)$/i,
      guide: "what is included, how it integrates, security and compliance points",
    },
    {
      name: "Risks & concerns",
      match: /^(risks?( (&|and) concerns?)?|concerns?|blockers?|risks? raised)$/i,
      guide: "lock-ins, dependencies and conditions someone raised",
    },
    OPEN_QUESTIONS,
  ],
  customer: [
    DISCUSSION,
    {
      name: "Needs & pain points",
      match: /^(needs?( (&|and) pain points?)?|pain points?|requirements?|problems?)$/i,
      guide: "what they need and the problem behind it, in their own framing",
    },
    {
      name: "Objections & blockers",
      match: /^(objections?( (&|and) blockers?)?|blockers?|pushback|concerns?)$/i,
      guide: "what stands between them and a yes, as they said it",
    },
    {
      name: "Next steps",
      match: /^(next steps?|action items?|follow[- ]?ups?|commitments?)$/i,
      guide: "who does what next — theirs and yours",
      actions: true,
    },
    OPEN_QUESTIONS,
  ],
  one_on_one: [
    DISCUSSION,
    {
      name: "Signals & examples",
      match: /^(signals?( (&|and) examples?)?|observations?|examples?)$/i,
      guide: "what they said or did, with the example — never a judgement without one",
    },
    {
      name: "Concerns & gaps",
      match: /^(concerns?( (&|and) gaps)?|gaps|worries|risks?)$/i,
      guide: "concerns either side stated, in their own words",
    },
    {
      name: "Growth & next steps",
      match: /^(growth( (&|and) next steps?)?|next steps?|action items?|development|follow[- ]?ups?)$/i,
      guide: "what was agreed to happen next",
      actions: true,
    },
    OPEN_QUESTIONS,
  ],
};

/** How the mode wants its 30-second summary to open. Outcome-first, never a
 *  demand for figures — exact numbers live in the bullets, where each one is
 *  cited; a summary that restates them has to pass the same verbatim check. */
export const SUMMARY_GUIDE: Record<string, string> = {
  team: "open with what was decided or what changed",
  investor: "open with what was reported and what each side committed to or asked for",
  vendor: "open with what is on the table and what is still unsettled",
  customer: "open with what the customer needs and what was agreed to happen next",
  one_on_one: "open with what was agreed and any concern that was raised",
};

export function sectionsFor(type?: string | null): SectionSpec[] {
  return MODE_SECTIONS[type ?? "team"] ?? MODE_SECTIONS.team;
}

/** The team readout's names — the default vocabulary. */
export const SECTIONS = MODE_SECTIONS.team.map((s) => s.name);

function sectionOf(label: string, specs: SectionSpec[]): string | null {
  const clean = label.trim().replace(/[:.]+$/, "");
  return specs.find((a) => a.match.test(clean))?.name ?? null;
}

/**
 * Force the readout into its mode's sections.
 *
 * The model is told to use exactly these and still returns a "Pricing" section
 * next to "Discussion". That is a structural mistake, not a factual one, so code
 * fixes it rather than the prompt asking again: anything that is not one of the
 * mode's sections becomes a topic *inside* Discussion, aliases are folded
 * together, and the order is fixed. Labels assert nothing, so moving them loses
 * nothing — and every bullet keeps its own receipts wherever it lands.
 */
export function normalizeSections(notes: Notes, type?: string | null): Notes {
  const specs = sectionsFor(type);
  const catchAll = specs[0].name; // Discussion, in every mode
  const buckets = new Map<string, NoteBullet[]>();
  const topics: NoteBullet[] = [];

  const add = (section: string, kids: NoteBullet[]) =>
    buckets.set(section, [...(buckets.get(section) ?? []), ...kids]);

  for (const node of notes.themes) {
    const section = sectionOf(node.text, specs);
    if (!section) {
      // A stray section is a discussion topic. A stray *leaf* is one too, but it
      // has no children to become a topic, so it goes in as a bare point.
      topics.push(node);
      continue;
    }
    if (isLeaf(node)) {
      add(section, [node]);
      continue;
    }
    if (section !== catchAll) {
      add(section, node.children!);
      continue;
    }
    // Inside Discussion, a topic named like one of the other sections is really
    // that section written in the wrong place ("Discussion → Risks → …").
    for (const child of node.children!) {
      const nested = isLeaf(child) ? null : sectionOf(child.text, specs);
      if (nested && nested !== catchAll) add(nested, child.children!);
      else topics.push(child);
    }
  }
  if (topics.length) buckets.set(catchAll, [...topics, ...(buckets.get(catchAll) ?? [])]);

  return {
    ...(notes.summary ? { summary: notes.summary } : {}),
    themes: specs
      .filter((s) => (buckets.get(s.name) ?? []).length > 0)
      .map((s) => ({ text: s.name, children: buckets.get(s.name)! })),
  };
}

/**
 * Two bullets that say exactly the same thing are one bullet with two receipts.
 * A weak model repeats itself, especially on short transcripts where one fact
 * was said twice; merging is mechanical, so code does it rather than asking.
 */
export function dedupeLeaves(notes: Notes): number {
  let merged = 0;
  const walk = (bullets: NoteBullet[]): NoteBullet[] => {
    const seen = new Map<string, NoteBullet>();
    const kept: NoteBullet[] = [];
    for (const b of bullets) {
      if (!isLeaf(b)) {
        b.children = walk(b.children!);
        kept.push(b);
        continue;
      }
      const key = b.text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const twin = seen.get(key);
      if (twin) {
        twin.source = [...new Set([...(twin.source ?? []), ...(b.source ?? [])])];
        // The merged claim is only shaky if every line behind it is.
        if (!b.lowConfidence) delete twin.lowConfidence;
        merged++;
        continue;
      }
      seen.set(key, b);
      kept.push(b);
    }
    return kept;
  };
  notes.themes = walk(notes.themes);
  return merged;
}

// ── Markdown round-trip ─────────────────────────────────────────────────────
// Nested "-" bullets, two spaces per level, sources as a trailing bracket group:
//   - Pricing
//     - Enterprise pushed back on per-seat pricing [S004]
//     - Rebuild takes three weeks [S004, S006 ?]      ← "?" = low confidence
// Labels carry no bracket group, which is exactly what makes the round-trip
// lossless: bracket present ⇒ leaf, absent ⇒ label.

const SOURCE_RE = /\s*\[((?:[A-Za-z]\d+)(?:\s*,\s*[A-Za-z]\d+)*)(\s*\?)?\]\s*$/;

/**
 * `sources: true` (the default) is the persisted form and round-trips exactly.
 * `sources: false` is what Copy puts on the clipboard — receipts are for the app,
 * not for the Slack message the founder is about to paste.
 */
export function notesToMarkdown(notes: Notes, opts: { sources?: boolean } = {}): string {
  const withSources = opts.sources !== false;
  const lines: string[] = [];
  // The summary is the one non-bullet block, so "text before the first bullet"
  // is all the parser needs to find it again.
  if (notes.summary?.text) {
    const src = withSources && notes.summary.source?.length ? ` [${notes.summary.source.join(", ")}]` : "";
    lines.push(`${notes.summary.text}${src}`, "");
  }
  const walk = (bullets: NoteBullet[], depth: number) => {
    for (const b of bullets) {
      const indent = "  ".repeat(depth);
      if (isLeaf(b)) {
        const src = withSources && b.source?.length ? ` [${b.source.join(", ")}${b.lowConfidence ? " ?" : ""}]` : "";
        lines.push(`${indent}- ${b.text}${src}`);
      } else {
        lines.push(`${indent}- ${b.text}`);
        walk(b.children!, depth + 1);
      }
    }
  };
  walk(notes.themes, 0);
  return lines.join("\n");
}

export function notesFromMarkdown(markdown: string): Notes {
  type Frame = { depth: number; bullet: NoteBullet };
  const themes: NoteBullet[] = [];
  const stack: Frame[] = [];
  const summaryLines: string[] = [];
  let seenBullet = false;
  for (const raw of String(markdown ?? "").split("\n")) {
    const m = raw.match(/^(\s*)[-*]\s+(.*)$/);
    if (!m) {
      // Prose before the first bullet is the summary. A human editing by hand
      // may leave it uncited — their words are trusted; the model's are not.
      if (!seenBullet && raw.trim() && !/^#{1,6}\s/.test(raw.trim())) summaryLines.push(raw.trim());
      continue;
    }
    seenBullet = true;
    const text = m[2].trim();
    if (!text) continue;
    // Two spaces per level, but tolerate 3/4-space and tab indentation from
    // hand-edited markdown: any deeper indent is one level deeper.
    const depth = Math.floor(m[1].replace(/\t/g, "  ").length / 2);
    const srcMatch = text.match(SOURCE_RE);
    const bullet: NoteBullet = srcMatch
      ? {
          text: text.replace(SOURCE_RE, "").trim(),
          source: srcMatch[1].split(",").map((s) => s.trim()).filter(Boolean),
          ...(srcMatch[2] ? { lowConfidence: true } : {}),
        }
      : { text };
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    const parent = stack[stack.length - 1];
    if (!parent) themes.push(bullet);
    else (parent.bullet.children ??= []).push(bullet);
    stack.push({ depth, bullet });
  }
  if (!summaryLines.length) return { themes };
  const joined = summaryLines.join(" ");
  const srcMatch = joined.match(SOURCE_RE);
  return {
    summary: {
      text: joined.replace(SOURCE_RE, "").trim(),
      source: srcMatch ? srcMatch[1].split(",").map((s) => s.trim()).filter(Boolean) : [],
    },
    themes,
  };
}

/**
 * Shape-only validation: is this a plausible Notes tree at all? Grounding is a
 * separate, harder question answered in lib/grounding.ts. Errors are phrased so
 * they can be pasted straight back into the model on a retry.
 */
export function validateNotesShape(x: unknown, maxDepth = 3): string[] {
  const errors: string[] = [];
  if (typeof x !== "object" || x === null) return ["response is not a JSON object"];
  const summary = (x as { summary?: unknown }).summary;
  if (summary !== undefined && summary !== null) {
    const s = summary as Record<string, unknown>;
    if (typeof s.text !== "string" || !s.text.trim()) errors.push('"summary".text must be a non-empty string');
    if (!Array.isArray(s.source) || s.source.length === 0)
      errors.push('"summary" must carry "source": ["S###", ...] — the overview states facts, so it cites them too');
  }
  const themes = (x as { themes?: unknown }).themes;
  if (!Array.isArray(themes)) return ['"themes" must be an array of theme bullets'];
  if (themes.length === 0) errors.push('"themes" is empty — return at least one theme, or an explicit empty outline');
  themes.forEach((t, i) => walk(t, `themes[${i}]`, 1));
  return errors;

  function walk(node: unknown, path: string, depth: number) {
    if (typeof node !== "object" || node === null) return void errors.push(`${path} is not an object`);
    const b = node as Record<string, unknown>;
    if (typeof b.text !== "string" || !b.text.trim()) errors.push(`${path}.text must be a non-empty string`);
    const kids = b.children;
    const hasKids = Array.isArray(kids) && kids.length > 0;
    if (kids !== undefined && !Array.isArray(kids)) errors.push(`${path}.children must be an array`);
    if (hasKids) {
      if (b.source !== undefined) errors.push(`${path} has children, so it is a theme label and must not carry "source"`);
      if (depth >= maxDepth) errors.push(`${path}.children exceeds the maximum outline depth of ${maxDepth}`);
      else (kids as unknown[]).forEach((k, i) => walk(k, `${path}.children[${i}]`, depth + 1));
      return;
    }
    // Leaf.
    if (!Array.isArray(b.source) || b.source.length === 0)
      errors.push(`${path} is a leaf bullet and must carry "source": ["S###", ...] with at least one segment id`);
    else if ((b.source as unknown[]).some((s) => typeof s !== "string" || !s.trim()))
      errors.push(`${path}.source must contain only segment id strings`);
  }
}
