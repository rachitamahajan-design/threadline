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

// ── The readout's fixed sections ────────────────────────────────────────────

/** The section order the notes always come back in. Empty ones are omitted. */
export const SECTIONS = ["Discussion", "Decisions", "Action items", "Risks & concerns", "Open questions"] as const;

/** Wordings we accept as meaning one of the five. */
const SECTION_ALIASES: { section: (typeof SECTIONS)[number]; match: RegExp }[] = [
  { section: "Discussion", match: /^(discussion|topics?|what was discussed|notes)$/i },
  { section: "Decisions", match: /^(decisions?|what was decided|agreements?)$/i },
  { section: "Action items", match: /^(action items?|actions?|next steps?|commitments?|to-?dos?|follow[- ]?ups?)$/i },
  { section: "Risks & concerns", match: /^(risks?( (&|and) concerns?)?|concerns?|blockers?|risks? raised)$/i },
  { section: "Open questions", match: /^(open questions?|questions?|unanswered|unknowns?)$/i },
];

function sectionOf(label: string): (typeof SECTIONS)[number] | null {
  const clean = label.trim().replace(/[:.]+$/, "");
  return SECTION_ALIASES.find((a) => a.match.test(clean))?.section ?? null;
}

/**
 * Force the readout into its five sections.
 *
 * The model is told to use exactly these and still returns a "Pricing" section
 * next to "Discussion". That is a structural mistake, not a factual one, so code
 * fixes it rather than the prompt asking again: anything that is not one of the
 * five becomes a topic *inside* Discussion, aliases are folded together, and the
 * order is fixed. Labels assert nothing, so moving them loses nothing — and every
 * bullet keeps its own receipts wherever it lands.
 */
export function normalizeSections(notes: Notes): Notes {
  const buckets = new Map<string, NoteBullet[]>();
  const topics: NoteBullet[] = [];

  const add = (section: string, kids: NoteBullet[]) =>
    buckets.set(section, [...(buckets.get(section) ?? []), ...kids]);

  for (const node of notes.themes) {
    const section = sectionOf(node.text);
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
    if (section !== "Discussion") {
      add(section, node.children!);
      continue;
    }
    // Inside Discussion, a topic named like one of the other sections is really
    // that section written in the wrong place ("Discussion → Risks → …").
    for (const child of node.children!) {
      const nested = isLeaf(child) ? null : sectionOf(child.text);
      if (nested && nested !== "Discussion") add(nested, child.children!);
      else topics.push(child);
    }
  }
  if (topics.length) buckets.set("Discussion", [...topics, ...(buckets.get("Discussion") ?? [])]);

  return {
    ...(notes.summary ? { summary: notes.summary } : {}),
    themes: SECTIONS.filter((s) => (buckets.get(s) ?? []).length > 0).map((s) => ({
      text: s,
      children: buckets.get(s)!,
    })),
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
