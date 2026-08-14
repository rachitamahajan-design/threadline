/**
 * What a Handoff is.
 *
 * One meeting, many stakeholders. A Handoff turns the meeting into the artefact
 * one of them needs — a team's slice of the action items, a pricing table, a
 * follow-up email — on demand, never automatically. The meeting type only
 * decides which one is *suggested*.
 *
 * Every Handoff shares the two-pass pipeline and the validators in
 * lib/grounding.ts. A Handoff definition is therefore small on purpose: a
 * versioned prompt, a shape parser, a grounding check, a pruner and a renderer.
 */
import type { PromptTemplate } from "../lib/prompts.js";
import type { Failure, GroundingContext } from "../lib/grounding.js";
import type { MeetingType, Segment } from "../lib/segments.js";
import { UNASSIGNED, type ActionItem, type SourcedItem } from "../lib/outline.js";
import { checkOwner, checkQuotes, checkSources, checkVerbatim, numericTokens } from "../lib/grounding.js";

export type HandoffScope = "meeting" | "cross-meeting";

export type HandoffVars = {
  statements: string;
  participants: string;
  type: string;
  /** Cross-meeting handoffs get a meeting roster instead of one participant list. */
  roster?: string;
};

export type HandoffDef<T = unknown> = {
  id: string;
  label: string;
  /** Meeting types this is the *default* (suggested) handoff for. */
  appliesTo: MeetingType[];
  scope: HandoffScope;
  /** One line the UI shows in the slash menu. */
  blurb: string;
  tone: string;
  /** Extra rules beyond the shared set — shown in the debug drawer verbatim. */
  groundingRules: string[];
  prompt: PromptTemplate<HandoffVars>;
  temperature?: number;
  parse: (raw: unknown) => T | string;
  validate: (value: T, ctx: GroundingContext) => Failure[];
  prune: (value: T, failures: Failure[], ctx: GroundingContext) => { value: T; dropped: number };
  finalize?: (value: T, ctx: GroundingContext) => void;
  /** Clean Markdown for the clipboard. No segment ids — that's the app's business. */
  toMarkdown: (value: T, meta: { title: string; when: string }) => string;
  /** Grouped outputs get per-block copy (e.g. one block per team). */
  blocks?: (value: T) => { label: string; markdown: string }[];
};

/**
 * §3: type sets the suggestions. Each meeting type leads with 2–3 handoffs
 * built for it; the FIRST is the default the chip row leans on. Anything can
 * still be run from chat or the slash menu — this list only decides what is
 * offered unprompted.
 */
export const SUGGESTED_HANDOFFS: Record<MeetingType, string[]> = {
  investor: ["team_actions", "investor_update", "followup_email"],
  vendor: ["pricing_quote", "negotiation_brief", "followup_email"],
  customer: ["followup_email", "crm_note", "collated_feedback"],
  team: ["summary_next_steps", "team_actions", "slack_update"],
  one_on_one: ["candidate_feedback", "one_on_one_recap"],
};

/** The lead suggestion per type — always the first of SUGGESTED_HANDOFFS. */
export const DEFAULT_HANDOFF: Record<MeetingType, string> = Object.fromEntries(
  (Object.entries(SUGGESTED_HANDOFFS) as [MeetingType, string[]][]).map(([t, ids]) => [t, ids[0]]),
) as Record<MeetingType, string>;

// ── Shared parsing helpers ──────────────────────────────────────────────────

export function asString(x: unknown): string {
  return typeof x === "string" ? x.trim() : "";
}

export function asSourcedItems(x: unknown): SourcedItem[] {
  if (!Array.isArray(x)) return [];
  return x
    .map((raw) => {
      const o = (raw ?? {}) as Record<string, unknown>;
      return {
        text: asString(o.text),
        source: Array.isArray(o.source) ? o.source.filter((s): s is string => typeof s === "string") : [],
      };
    })
    .filter((i) => !!i.text);
}

export function asActionItems(x: unknown): ActionItem[] {
  if (!Array.isArray(x)) return [];
  return x
    .map((raw) => {
      const o = (raw ?? {}) as Record<string, unknown>;
      const due = asString(o.due);
      return {
        text: asString(o.text) || asString(o.task),
        // An absent owner is "Unassigned", never a guess. The whitelist check
        // still runs — this only stops a missing field failing as a fake name.
        owner: asString(o.owner) || UNASSIGNED,
        ...(due ? { due } : { due: null }),
        source: Array.isArray(o.source) ? o.source.filter((s): s is string => typeof s === "string") : [],
      } satisfies ActionItem;
    })
    .filter((i) => !!i.text);
}

// ── Shared validation ───────────────────────────────────────────────────────

/**
 * Prose lines that carry no citation. Allowed only if they assert nothing —
 * "Hi Maya", "Thanks for the time today", "Best, Rachita". The test is the same
 * one theme labels face: no numbers, no dates, no quotes.
 */
export function checkUnsourcedProse(line: string, path: string): Failure[] {
  const out: Failure[] = [];
  const nums = numericTokens(line);
  if (nums.length)
    out.push({
      path,
      rule: "verbatim-number",
      detail: `${path} states "${nums[0].raw}" with no citation. Any line with a number, price or date must carry the segment ids it came from, e.g. "... [S004]".`,
    });
  if (/[“"][^“”"]{4,}[”"]/.test(line))
    out.push({
      path,
      rule: "exact-quote",
      detail: `${path} quotes someone without a citation. Add the segment ids, or drop the quote marks.`,
    });
  return out;
}

/** A `{text, source}` line: sources exist, figures verbatim, quotes exact. */
export function checkSourcedLine(text: string, source: string[], path: string, ctx: GroundingContext): Failure[] {
  const srcFailures = checkSources(source, path, ctx);
  if (srcFailures.length) return srcFailures;
  return [...checkVerbatim(text, source, path, ctx), ...checkQuotes(text, source, path, ctx)];
}

export function checkActionItem(item: ActionItem, path: string, ctx: GroundingContext): Failure[] {
  const out = checkOwner(item.owner, path, ctx);
  const srcFailures = checkSources(item.source, path, ctx);
  out.push(...srcFailures);
  if (srcFailures.length) return out;
  out.push(...checkVerbatim(`${item.text} ${item.due ?? ""}`.trim(), item.source, path, ctx));
  out.push(...checkQuotes(item.text, item.source, path, ctx));
  return out;
}

/** Every failure path that names index `i` of `prefix` — used by pruners. */
export function failedIndexes(failures: Failure[], prefix: string): Set<number> {
  const out = new Set<number>();
  const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\[(\\d+)\\]`);
  for (const f of failures) {
    const m = f.path.match(re);
    if (m) out.add(Number(m[1]));
  }
  return out;
}

export function dropFailed<T>(items: T[], failures: Failure[], prefix: string): { kept: T[]; dropped: number } {
  const bad = failedIndexes(failures, prefix);
  const kept = items.filter((_, i) => !bad.has(i));
  return { kept, dropped: items.length - kept.length };
}

// ── Shared rendering ────────────────────────────────────────────────────────

export function mdItems(items: SourcedItem[]): string {
  return items.map((i) => `- ${i.text}${i.lowConfidence ? " _(heard poorly — verify)_" : ""}`).join("\n");
}

export function mdActions(items: ActionItem[]): string {
  return items
    .map(
      (i) =>
        `- [ ] **${i.owner}** — ${i.text}${i.due ? ` _(${i.due})_` : ""}${i.lowConfidence ? " _(heard poorly — verify)_" : ""}`,
    )
    .join("\n");
}

/** Segment ids stripped: what lands on the clipboard is what a human should read. */
export function stripSourceMarkers(text: string): string {
  return text
    .replace(/\s*\[(?:[A-Za-z]\d+|[A-Za-z]\d+:[A-Za-z]?\d+)(?:\s*,\s*(?:[A-Za-z]\d+|[A-Za-z]\d+:[A-Za-z]?\d+))*\s*\??\]/g, "")
    .replace(/[ \t]+$/gm, "");
}

/** Inline `[S004]` / `[S004, S007]` markers found in a line of prose. */
export function inlineSources(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/\[((?:[A-Za-z]\d+(?::[A-Za-z]?\d+)?)(?:\s*,\s*[A-Za-z]\d+(?::[A-Za-z]?\d+)?)*)\]/g))
    out.push(...m[1].split(",").map((s) => s.trim()).filter(Boolean));
  return out;
}

/**
 * Cross-meeting handoffs address segments as "M1:S004": a per-run alias for the
 * meeting, then the segment id inside it. Aliases keep prompts short and keep
 * real meeting ids (which can be long and ugly) out of the model's way.
 */
export function aliasSegments(meetings: { id: string; segments: Segment[] }[]): {
  segments: Segment[];
  aliasOf: Map<string, string>;
  idOf: Map<string, string>;
} {
  const segments: Segment[] = [];
  const aliasOf = new Map<string, string>(); // meetingId → "M1"
  const idOf = new Map<string, string>(); // "M1" → meetingId
  meetings.forEach((m, i) => {
    const alias = `M${i + 1}`;
    aliasOf.set(m.id, alias);
    idOf.set(alias, m.id);
    for (const s of m.segments) segments.push({ ...s, id: `${alias}:${s.id}` });
  });
  return { segments, aliasOf, idOf };
}
