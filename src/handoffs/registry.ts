/**
 * The six Handoffs.
 *
 * Each one is data: prompt + parser + validator + pruner + renderer. Adding a
 * seventh means adding an entry here, not touching the pipeline. Nothing in this
 * file runs a model — pipeline/handoff.ts does that, once, for all of them.
 *
 * House rule for prices, applied consistently everywhere below: a figure that
 * fails the verbatim check is DROPPED, never paraphrased and never softened into
 * "around $X". The card footer says how many were dropped and the debug drawer
 * says why, so a silent hole is impossible.
 */
import type { Failure, GroundingContext } from "../lib/grounding.js";
import {
  checkStatedVerdict,
  checkThemeHeader,
  markLowConfidence,
  markNotesConfidence,
  validateNotes,
} from "../lib/grounding.js";
import {
  UNASSIGNED,
  notesToMarkdown,
  validateNotesShape,
  type ActionItem,
  type Notes,
  type SourcedItem,
} from "../lib/outline.js";
import { repairNotes } from "../pipeline/notes-outline.js";
import type { MeetingType } from "../lib/segments.js";
import { promptRef } from "../lib/prompts.js";
import type { PromptTemplate } from "../lib/prompts.js";
import {
  CANDIDATE_FEEDBACK,
  COLLATED_FEEDBACK,
  CRM_NOTE,
  FOLLOWUP_EMAIL,
  INVESTOR_UPDATE,
  NEGOTIATION_BRIEF,
  ONE_ON_ONE_RECAP,
  PRICING_QUOTE,
  SLACK_UPDATE,
  SUMMARY_NEXT_STEPS,
  TEAM_ACTIONS,
} from "./prompts.js";
import {
  SUGGESTED_HANDOFFS,
  asActionItems,
  asSourcedItems,
  asString,
  checkActionItem,
  checkSourcedLine,
  checkUnsourcedProse,
  dropFailed,
  inlineSources,
  mdActions,
  mdItems,
  stripSourceMarkers,
  type HandoffDef,
  type HandoffVars,
} from "./types.js";

// ── 6.1 Investor → team-specific action items ───────────────────────────────

export type TeamActions = { perOwner: { owner: string; items: ActionItem[] }[] };

const teamActions: HandoffDef<TeamActions> = {
  id: "team_actions",
  label: "Team action items",
  appliesTo: ["investor"],
  scope: "meeting",
  blurb: "Commitments grouped by owner, so each team gets only its slice",
  tone: "Terse and imperative. This gets forwarded, not read.",
  groundingRules: [
    "Owners are whitelisted participants or Unassigned.",
    "Due dates only when spoken; never derived from the meeting date.",
  ],
  prompt: TEAM_ACTIONS,
  parse: (raw) => {
    const groups = (raw as { perOwner?: unknown })?.perOwner;
    if (!Array.isArray(groups)) return '"perOwner" must be an array of {owner, items}';
    // Regroup by each item's own owner rather than trusting the model's
    // grouping. This block gets forwarded to one person — a group headed
    // "Unassigned" holding items owned by someone else is worse than useless.
    const byOwner = new Map<string, ActionItem[]>();
    for (const g of groups) {
      const o = (g ?? {}) as Record<string, unknown>;
      const groupOwner = asString(o.owner) || UNASSIGNED;
      for (const item of asActionItems(o.items)) {
        const owner = item.owner === UNASSIGNED ? groupOwner : item.owner;
        const list = byOwner.get(owner) ?? [];
        list.push({ ...item, owner });
        byOwner.set(owner, list);
      }
    }
    const perOwner = [...byOwner].map(([owner, items]) => ({ owner, items }));
    if (!perOwner.length) return '"perOwner" contained no items with text';
    // "Unassigned" last: it is a to-do for the founder, not a teammate's slice.
    perOwner.sort((a, b) => Number(a.owner === UNASSIGNED) - Number(b.owner === UNASSIGNED));
    return { perOwner };
  },
  validate: (v, ctx) => {
    const out: Failure[] = [];
    v.perOwner.forEach((g, gi) => {
      g.items.forEach((item, ii) => out.push(...checkActionItem(item, `perOwner[${gi}].items[${ii}]`, ctx)));
    });
    return out;
  },
  prune: (v, failures) => {
    let dropped = 0;
    const perOwner = v.perOwner
      .map((g, gi) => {
        const { kept, dropped: d } = dropFailed(g.items, failures, `perOwner[${gi}].items`);
        dropped += d;
        // An invented owner loses the label, not the work: valid items keep
        // their own (validated) owner, the group becomes Unassigned.
        const ownerFailed = failures.some((f) => f.path.startsWith(`perOwner[${gi}].items`) && f.rule === "owner-whitelist");
        return { owner: ownerFailed && !kept.length ? UNASSIGNED : g.owner, items: kept };
      })
      .filter((g) => g.items.length > 0);
    return { value: { perOwner }, dropped };
  },
  finalize: (v, ctx) => v.perOwner.forEach((g) => markLowConfidence(g.items, ctx)),
  toMarkdown: (v, meta) =>
    [`**Action items — ${meta.title}** (${meta.when})`, "", ...v.perOwner.map((g) => `### ${g.owner}\n${mdActions(g.items)}`)].join(
      "\n",
    ),
  blocks: (v) => v.perOwner.map((g) => ({ label: g.owner, markdown: `**${g.owner}**\n${mdActions(g.items)}` })),
};

// ── 6.2 Vendor → pricing-quote extract ──────────────────────────────────────

export type QuoteRow = {
  item: string;
  price: string;
  unit: string;
  terms: string;
  validUntil?: string | null;
  source: string[];
  lowConfidence?: boolean;
};
export type PricingQuote = { quotes: QuoteRow[]; unclear: SourcedItem[] };

/** Everything a quote row asserts, as one string for the verbatim guard. */
const quoteText = (q: QuoteRow) => [q.item, q.price, q.unit, q.terms, q.validUntil ?? ""].filter(Boolean).join(" ");

const pricingQuote: HandoffDef<PricingQuote> = {
  id: "pricing_quote",
  label: "Pricing quote",
  appliesTo: ["vendor"],
  scope: "meeting",
  blurb: "Every price, unit and term — verbatim or dropped",
  tone: "Table, not prose. No adjectives.",
  groundingRules: [
    "Prices, units, terms and expiry must appear verbatim in the cited segments.",
    "A row failing the verbatim check is dropped, never paraphrased.",
    "Nothing is computed: no totals, no per-seat maths, no annualisation.",
  ],
  prompt: PRICING_QUOTE,
  temperature: 0,
  parse: (raw) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    if (!Array.isArray(o.quotes)) return '"quotes" must be an array (use [] if nothing was priced)';
    const quotes: QuoteRow[] = (o.quotes as unknown[])
      .map((r) => {
        const q = (r ?? {}) as Record<string, unknown>;
        const validUntil = asString(q.validUntil);
        return {
          // A price is a price even when nobody named the thing being priced
          // ("the pricing is eighty dollars per seat"). Requiring an item here
          // silently deleted real quotes, which is the one thing this handoff
          // must never do — the grounding checks below decide what survives.
          item: asString(q.item) || "Unnamed item",
          price: asString(q.price),
          unit: asString(q.unit),
          terms: asString(q.terms),
          validUntil: validUntil || null,
          source: Array.isArray(q.source) ? q.source.filter((s): s is string => typeof s === "string") : [],
        };
      })
      .filter((q) => q.price);
    return { quotes, unclear: asSourcedItems(o.unclear) };
  },
  validate: (v, ctx) => {
    const out: Failure[] = [];
    v.quotes.forEach((q, i) => out.push(...checkSourcedLine(quoteText(q), q.source, `quotes[${i}]`, ctx)));
    v.unclear.forEach((u, i) => out.push(...checkSourcedLine(u.text, u.source, `unclear[${i}]`, ctx)));
    return out;
  },
  prune: (v, failures) => {
    const q = dropFailed(v.quotes, failures, "quotes");
    const u = dropFailed(v.unclear, failures, "unclear");
    return { value: { quotes: q.kept, unclear: u.kept }, dropped: q.dropped + u.dropped };
  },
  finalize: (v, ctx) => {
    markLowConfidence(v.quotes, ctx);
    markLowConfidence(v.unclear, ctx);
  },
  toMarkdown: (v, meta) => {
    const head = `**Pricing — ${meta.title}** (${meta.when})`;
    const table = v.quotes.length
      ? [
          "| Item | Price | Unit | Terms | Valid until |",
          "| --- | --- | --- | --- | --- |",
          ...v.quotes.map(
            (q) =>
              `| ${q.item} | ${q.price} | ${q.unit || "—"} | ${q.terms || "—"} | ${q.validUntil || "—"} |${
                q.lowConfidence ? " <!-- heard poorly -->" : ""
              }`,
          ),
        ].join("\n")
      : "_No price was quoted clearly enough to record._";
    const unclear = v.unclear.length ? `\n\n**Not quoted / unclear**\n${mdItems(v.unclear)}` : "";
    return `${head}\n\n${table}${unclear}`;
  },
};

// ── 6.3 Customer → follow-up email ──────────────────────────────────────────

export type FollowupEmail = { subject: string; body: string };

const NEUTRAL_SUBJECT = "Follow-up on our conversation";

const followupEmail: HandoffDef<FollowupEmail> = {
  id: "followup_email",
  label: "Follow-up email",
  appliesTo: ["customer"],
  scope: "meeting",
  blurb: "A warm recap with agreed next steps, in your voice",
  tone: "First person, warm, short. Sounds like the founder, not like marketing.",
  groundingRules: [
    "Every factual line carries inline segment ids.",
    "Uncited lines may contain no numbers, dates or quotes.",
    "No commitment appears that nobody made.",
  ],
  prompt: FOLLOWUP_EMAIL,
  temperature: 0.2,
  parse: (raw) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    const subject = asString(o.subject);
    const body = typeof o.body === "string" ? o.body.trim() : "";
    if (!body) return '"body" must be a non-empty markdown string';
    return { subject: subject || NEUTRAL_SUBJECT, body };
  },
  validate: (v, ctx) => {
    const out: Failure[] = [...checkUnsourcedProse(v.subject, "subject")];
    v.body.split("\n").forEach((line, i) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const path = `body[${i}]`;
      const sources = inlineSources(trimmed);
      if (!sources.length) out.push(...checkUnsourcedProse(trimmed, path));
      else out.push(...checkSourcedLine(stripSourceMarkers(trimmed), sources, path, ctx));
    });
    return out;
  },
  prune: (v, failures) => {
    const bad = new Set<number>();
    let subjectFailed = false;
    for (const f of failures) {
      const m = f.path.match(/^body\[(\d+)\]$/);
      if (m) bad.add(Number(m[1]));
      if (f.path === "subject") subjectFailed = true;
    }
    const lines = v.body.split("\n").filter((_, i) => !bad.has(i));
    return {
      // A subject we cannot verify is replaced with a neutral one rather than
      // trimmed word by word — the founder retitles emails anyway.
      value: { subject: subjectFailed ? NEUTRAL_SUBJECT : v.subject, body: lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() },
      dropped: bad.size + (subjectFailed ? 1 : 0),
    };
  },
  toMarkdown: (v) => `Subject: ${v.subject}\n\n${stripSourceMarkers(v.body)}`,
};

// ── 6.4 Team → summary & next steps ─────────────────────────────────────────

export type SummaryNextSteps = { themes: Notes["themes"]; nextSteps: ActionItem[]; openQuestions: SourcedItem[] };

const summaryNextSteps: HandoffDef<SummaryNextSteps> = {
  id: "summary_next_steps",
  label: "Summary & next steps",
  appliesTo: ["team"],
  scope: "meeting",
  blurb: "Themed readout plus who does what next",
  tone: "Internal, plain, no ceremony.",
  groundingRules: [
    "Theme labels stay claim-free.",
    "Owners whitelisted; gaps left blank rather than filled.",
  ],
  prompt: SUMMARY_NEXT_STEPS,
  parse: (raw) => {
    const errors = validateNotesShape(raw);
    if (errors.length) return errors.slice(0, 6).join("; ");
    const o = raw as Record<string, unknown>;
    return {
      themes: (o.themes as Notes["themes"]) ?? [],
      nextSteps: asActionItems(o.nextSteps),
      openQuestions: asSourcedItems(o.openQuestions),
    };
  },
  validate: (v, ctx) => {
    const out = validateNotes({ themes: v.themes }, ctx);
    v.nextSteps.forEach((item, i) => out.push(...checkActionItem(item, `nextSteps[${i}]`, ctx)));
    v.openQuestions.forEach((q, i) => out.push(...checkSourcedLine(q.text, q.source, `openQuestions[${i}]`, ctx)));
    return out;
  },
  prune: (v, failures) => {
    // Notes failures address "0.1.2"; list failures address "nextSteps[0]".
    const noteFailures = failures.filter((f) => /^\d/.test(f.path));
    const repaired = repairNotes({ themes: v.themes }, noteFailures);
    const ns = dropFailed(v.nextSteps, failures, "nextSteps");
    const oq = dropFailed(v.openQuestions, failures, "openQuestions");
    return {
      value: { themes: repaired.value.themes, nextSteps: ns.kept, openQuestions: oq.kept },
      dropped: repaired.dropped + ns.dropped + oq.dropped,
    };
  },
  finalize: (v, ctx) => {
    markNotesConfidence({ themes: v.themes }, ctx);
    markLowConfidence(v.nextSteps, ctx);
    markLowConfidence(v.openQuestions, ctx);
  },
  toMarkdown: (v, meta) =>
    [
      `**${meta.title}** (${meta.when})`,
      "",
      notesToMarkdown({ themes: v.themes }, { sources: false }),
      v.nextSteps.length ? `\n**Next steps**\n${mdActions(v.nextSteps)}` : "",
      v.openQuestions.length ? `\n**Open questions**\n${mdItems(v.openQuestions)}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  blocks: (v) => [
    { label: "Notes", markdown: notesToMarkdown({ themes: v.themes }, { sources: false }) },
    ...(v.nextSteps.length ? [{ label: "Next steps", markdown: mdActions(v.nextSteps) }] : []),
  ],
};

// ── 6.5 1:1 → candidate feedback ────────────────────────────────────────────

export type CandidateFeedback = {
  signals: SourcedItem[];
  strengths: SourcedItem[];
  concerns: SourcedItem[];
  statedLean?: SourcedItem | null;
};

const candidateFeedback: HandoffDef<CandidateFeedback> = {
  id: "candidate_feedback",
  label: "Candidate feedback",
  appliesTo: ["one_on_one"],
  scope: "meeting",
  blurb: "Signals with examples, strengths, concerns — no invented verdict",
  tone: "Observational. Every judgement points at an example.",
  groundingRules: [
    "No hire/no-hire verdict unless the interviewer stated one.",
    "Evaluative language must be anchored to a cited example.",
    "Protected characteristics are never mentioned or inferred.",
  ],
  prompt: CANDIDATE_FEEDBACK,
  parse: (raw) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    const lean = (o.statedLean ?? null) as Record<string, unknown> | null;
    const statedLean =
      lean && asString(lean.text)
        ? {
            text: asString(lean.text),
            source: Array.isArray(lean.source) ? (lean.source as unknown[]).filter((s): s is string => typeof s === "string") : [],
          }
        : null;
    const value = {
      signals: asSourcedItems(o.signals),
      strengths: asSourcedItems(o.strengths),
      concerns: asSourcedItems(o.concerns),
      statedLean,
    };
    if (!value.signals.length && !value.strengths.length && !value.concerns.length)
      return "no signals, strengths or concerns were returned — at least one sourced observation is required";
    return value;
  },
  validate: (v, ctx) => {
    const out: Failure[] = [];
    (["signals", "strengths", "concerns"] as const).forEach((key) =>
      v[key].forEach((item, i) => out.push(...checkSourcedLine(item.text, item.source, `${key}[${i}]`, ctx))),
    );
    if (v.statedLean) {
      out.push(...checkSourcedLine(v.statedLean.text, v.statedLean.source, "statedLean", ctx));
      // A verdict is the one qualitative claim we refuse to take on trust:
      // the cited line has to actually contain a hire/no-hire call.
      out.push(...checkStatedVerdict(v.statedLean, "statedLean", ctx));
    }
    return out;
  },
  prune: (v, failures) => {
    const s = dropFailed(v.signals, failures, "signals");
    const st = dropFailed(v.strengths, failures, "strengths");
    const c = dropFailed(v.concerns, failures, "concerns");
    const leanFailed = failures.some((f) => f.path === "statedLean");
    return {
      value: {
        signals: s.kept,
        strengths: st.kept,
        concerns: c.kept,
        // An unverifiable lean becomes no lean. We never hand the founder a
        // hire/no-hire call the interviewer did not make.
        statedLean: leanFailed ? null : v.statedLean ?? null,
      },
      dropped: s.dropped + st.dropped + c.dropped + (leanFailed ? 1 : 0),
    };
  },
  finalize: (v, ctx) => {
    markLowConfidence(v.signals, ctx);
    markLowConfidence(v.strengths, ctx);
    markLowConfidence(v.concerns, ctx);
    if (v.statedLean) markLowConfidence([v.statedLean], ctx);
  },
  toMarkdown: (v, meta) =>
    [
      `**Interview feedback — ${meta.title}** (${meta.when})`,
      v.signals.length ? `\n**Signals observed**\n${mdItems(v.signals)}` : "",
      v.strengths.length ? `\n**Strengths**\n${mdItems(v.strengths)}` : "",
      v.concerns.length ? `\n**Concerns**\n${mdItems(v.concerns)}` : "",
      v.statedLean
        ? `\n**Stated lean**\n- ${v.statedLean.text}`
        : `\n**Stated lean**\n_None stated on the call — left for you to decide._`,
    ]
      .filter(Boolean)
      .join("\n"),
};

// ── Sectioned handoffs: one shape, five artefacts ────────────────────────────
// A run of sourced-item and action-item sections, optionally led by one
// uncited prose line (a headline). Parsing, validation, pruning and rendering
// are identical across them, so the definitions below are data.

type SectionSpec = { key: string; kind: "items" | "actions"; heading: string };
type Sectioned = Record<string, SourcedItem[] | ActionItem[] | string>;

function sectionedHandoff(opts: {
  id: string;
  label: string;
  appliesTo: MeetingType[];
  blurb: string;
  tone: string;
  groundingRules: string[];
  prompt: PromptTemplate<HandoffVars>;
  temperature?: number;
  sections: SectionSpec[];
  /** An uncited one-liner (headline). Replaced with the fallback, never trimmed word by word. */
  prose?: { key: string; fallback: string };
}): HandoffDef<Sectioned> {
  const { sections, prose } = opts;
  const listOf = (v: Sectioned, s: SectionSpec) => v[s.key] as (SourcedItem[] & ActionItem[]);
  return {
    id: opts.id,
    label: opts.label,
    appliesTo: opts.appliesTo,
    scope: "meeting",
    blurb: opts.blurb,
    tone: opts.tone,
    groundingRules: opts.groundingRules,
    prompt: opts.prompt,
    temperature: opts.temperature,
    parse: (raw) => {
      const o = (raw ?? {}) as Record<string, unknown>;
      const value: Sectioned = {};
      for (const s of sections) value[s.key] = s.kind === "actions" ? asActionItems(o[s.key]) : asSourcedItems(o[s.key]);
      if (prose) value[prose.key] = asString(o[prose.key]) || prose.fallback;
      if (sections.every((s) => listOf(value, s).length === 0))
        return `nothing in this conversation fits a ${opts.label.toLowerCase()} — no line qualified for any of its sections (${sections.map((s) => `"${s.key}"`).join(", ")})`;
      return value;
    },
    validate: (v, ctx) => {
      const out: Failure[] = prose ? checkUnsourcedProse(v[prose.key] as string, prose.key) : [];
      for (const s of sections)
        listOf(v, s).forEach((item, i) =>
          out.push(
            ...(s.kind === "actions"
              ? checkActionItem(item as ActionItem, `${s.key}[${i}]`, ctx)
              : checkSourcedLine(item.text, item.source, `${s.key}[${i}]`, ctx)),
          ),
        );
      return out;
    },
    prune: (v, failures) => {
      let dropped = 0;
      const value: Sectioned = { ...v };
      for (const s of sections) {
        const { kept, dropped: d } = dropFailed(listOf(v, s), failures, s.key);
        value[s.key] = kept;
        dropped += d;
      }
      if (prose && failures.some((f) => f.path === prose.key)) {
        value[prose.key] = prose.fallback;
        dropped++;
      }
      return { value, dropped };
    },
    finalize: (v, ctx) => {
      for (const s of sections) markLowConfidence(listOf(v, s), ctx);
    },
    toMarkdown: (v, meta) =>
      [
        `**${opts.label} — ${meta.title}** (${meta.when})`,
        prose ? `\n${v[prose.key]}` : "",
        ...sections.map((s) => {
          const list = listOf(v, s);
          if (!list.length) return "";
          return `\n**${s.heading}**\n${s.kind === "actions" ? mdActions(list as ActionItem[]) : mdItems(list)}`;
        }),
      ]
        .filter(Boolean)
        .join("\n"),
  };
}

// ── 6.6 Investor → investor-update material ──────────────────────────────────

const investorUpdate = sectionedHandoff({
  id: "investor_update",
  label: "Investor update",
  appliesTo: ["investor"],
  blurb: "Traction, metrics, commitments and asks, paste-ready for your update",
  tone: "Factual and compact. Numbers speak, adjectives don't.",
  groundingRules: [
    "Metrics are verbatim or absent — never rounded or annualised.",
    "Asks are requests actually made of the investor in this meeting.",
  ],
  prompt: INVESTOR_UPDATE,
  sections: [
    { key: "highlights", kind: "items", heading: "Highlights" },
    { key: "metrics", kind: "items", heading: "Metrics" },
    { key: "commitments", kind: "actions", heading: "Commitments" },
    { key: "asks", kind: "items", heading: "Asks" },
  ],
});

// ── 6.7 Customer → CRM note ──────────────────────────────────────────────────

const crmNote = sectionedHandoff({
  id: "crm_note",
  label: "CRM note",
  appliesTo: ["customer"],
  blurb: "Needs, objections, buying signals and next steps, in paste-into-CRM form",
  tone: "Terse field notes. The customer's framing, not marketing's.",
  groundingRules: [
    "Signals are stated facts (budget, timeline, process) — never read enthusiasm.",
    "Objections keep the customer's own framing.",
  ],
  prompt: CRM_NOTE,
  sections: [
    { key: "needs", kind: "items", heading: "Needs & pain points" },
    { key: "objections", kind: "items", heading: "Objections" },
    { key: "signals", kind: "items", heading: "Buying signals" },
    { key: "nextSteps", kind: "actions", heading: "Next steps" },
  ],
});

// ── 6.8 Vendor → negotiation brief ───────────────────────────────────────────

const negotiationBrief = sectionedHandoff({
  id: "negotiation_brief",
  label: "Negotiation brief",
  appliesTo: ["vendor"],
  blurb: "What's settled, what's still open, and the risks before you sign",
  tone: "A brief for your own side. Plain statements, no posturing.",
  groundingRules: [
    "Agreed means both sides settled it; a one-sided proposal stays open.",
    "Terms and figures are verbatim or dropped.",
    "Risks were raised in the room, never foreseen by the model.",
  ],
  prompt: NEGOTIATION_BRIEF,
  temperature: 0,
  sections: [
    { key: "agreed", kind: "items", heading: "Agreed" },
    { key: "open", kind: "items", heading: "Still open" },
    { key: "risks", kind: "items", heading: "Risks raised" },
    { key: "nextSteps", kind: "actions", heading: "Next steps" },
  ],
});

// ── 6.9 Team → Slack update ──────────────────────────────────────────────────

const slackUpdate = sectionedHandoff({
  id: "slack_update",
  label: "Slack update",
  appliesTo: ["team"],
  blurb: "A short post-to-channel update: headline, points, blockers",
  tone: "Reads on a phone. Decisions first, no ceremony.",
  groundingRules: [
    "The headline carries no numbers, dates or quotes — cited points do.",
    "Blockers only when someone said they were blocked.",
  ],
  prompt: SLACK_UPDATE,
  sections: [
    { key: "points", kind: "items", heading: "What moved" },
    { key: "blockers", kind: "items", heading: "Blockers" },
  ],
  prose: { key: "headline", fallback: "Update from today's meeting" },
});

// ── 6.10 1:1 → private recap ─────────────────────────────────────────────────

const oneOnOneRecap = sectionedHandoff({
  id: "one_on_one_recap",
  label: "1:1 recap",
  appliesTo: ["one_on_one"],
  blurb: "What you talked about, what was agreed, and anything to watch",
  tone: "A private note to yourself. Their words, not your read of them.",
  groundingRules: [
    "Flags are concerns the person stated themselves — no mood-reading.",
    "Commitments cover both sides, owner whitelisted.",
  ],
  prompt: ONE_ON_ONE_RECAP,
  sections: [
    { key: "discussed", kind: "items", heading: "Discussed" },
    { key: "commitments", kind: "actions", heading: "Commitments" },
    { key: "flags", kind: "items", heading: "Worth watching" },
  ],
});

// ── 6.11 Cross-meeting → collated customer feedback ─────────────────────────

export type FeedbackTheme = {
  theme: string;
  kind: "request" | "objection" | "praise" | "churn_risk";
  /** Computed from citations, never taken from the model. */
  frequency: number;
  examples: { meetingId: string; source: string[] }[];
};
export type CollatedFeedback = {
  themes: FeedbackTheme[];
  /** Alias → real title, filled in by code for rendering. */
  meetingTitles?: Record<string, string>;
};

const KINDS = ["request", "objection", "praise", "churn_risk"] as const;

const collatedFeedback: HandoffDef<CollatedFeedback> = {
  id: "collated_feedback",
  label: "Collated customer feedback",
  appliesTo: [],
  scope: "cross-meeting",
  blurb: "What keeps coming up across customer calls, by frequency",
  tone: "Analytical. Counts come from citations, not vibes.",
  groundingRules: [
    "A theme with zero citations cannot exist.",
    "Every cited id must belong to the meeting it is filed under.",
    "Frequency is computed from citations in code.",
  ],
  prompt: COLLATED_FEEDBACK,
  parse: (raw) => {
    const list = (raw as { themes?: unknown })?.themes;
    if (!Array.isArray(list)) return '"themes" must be an array of {theme, kind, examples}';
    const themes: FeedbackTheme[] = list
      .map((t) => {
        const o = (t ?? {}) as Record<string, unknown>;
        const examples = (Array.isArray(o.examples) ? o.examples : [])
          .map((e) => {
            const x = (e ?? {}) as Record<string, unknown>;
            return {
              meetingId: asString(x.meetingId),
              source: Array.isArray(x.source) ? x.source.filter((s): s is string => typeof s === "string") : [],
            };
          })
          .filter((e) => e.meetingId && e.source.length);
        return {
          theme: asString(o.theme),
          kind: (KINDS as readonly string[]).includes(asString(o.kind)) ? (asString(o.kind) as FeedbackTheme["kind"]) : "request",
          frequency: examples.length,
          examples,
        };
      })
      .filter((t) => t.theme && t.examples.length);
    if (!themes.length) return "no theme survived: every theme needs a label and at least one cited example";
    return { themes };
  },
  validate: (v, ctx) => {
    const out: Failure[] = [];
    v.themes.forEach((t, ti) => {
      t.examples.forEach((ex, ei) => {
        const path = `themes[${ti}].examples[${ei}]`;
        const wrongMeeting = ex.source.filter((id) => !id.startsWith(`${ex.meetingId}:`));
        if (wrongMeeting.length)
          out.push({
            path,
            rule: "source-exists",
            detail: `${path} is filed under ${ex.meetingId} but cites ${wrongMeeting.join(", ")} — every id must start with its own meeting alias.`,
          });
        out.push(...checkSourcedLine(t.theme, ex.source, path, ctx));
      });
      // The label itself must not assert anything its citations do not carry.
      out.push(
        ...checkThemeHeader(
          {
            text: t.theme,
            children: t.examples.map((ex) => ({
              text: ex.source.map((id) => ctx.index.get(id)?.text ?? "").join(" "),
              source: ex.source,
            })),
          },
          `themes[${ti}]`,
          ctx,
        ),
      );
    });
    return out;
  },
  prune: (v, failures) => {
    let dropped = 0;
    const themes = v.themes
      .map((t, ti) => {
        const ex = dropFailed(t.examples, failures, `themes[${ti}].examples`);
        dropped += ex.dropped;
        const labelFailed = failures.some((f) => f.path === `themes[${ti}]`);
        if (labelFailed) {
          dropped++;
          return null;
        }
        return { ...t, examples: ex.kept, frequency: ex.kept.length };
      })
      .filter((t): t is FeedbackTheme => !!t && t.examples.length > 0)
      .sort((a, b) => b.frequency - a.frequency);
    return { value: { ...v, themes }, dropped };
  },
  finalize: (v) => {
    // Frequency is ours, always recomputed from what survived.
    for (const t of v.themes) t.frequency = t.examples.length;
    v.themes.sort((a, b) => b.frequency - a.frequency);
  },
  toMarkdown: (v, meta) => {
    const name = (alias: string) => v.meetingTitles?.[alias] ?? alias;
    return [
      `**Collated customer feedback** (${meta.when})`,
      "",
      ...v.themes.map(
        (t) =>
          `- **${t.theme}** — ${t.frequency} mention${t.frequency === 1 ? "" : "s"} · ${t.kind.replace("_", " ")}\n` +
          `  _heard in:_ ${[...new Set(t.examples.map((e) => name(e.meetingId)))].join(", ")}`,
      ),
    ].join("\n");
  },
};

// ── Registry ────────────────────────────────────────────────────────────────

export const HANDOFFS: HandoffDef<any>[] = [
  teamActions,
  pricingQuote,
  followupEmail,
  summaryNextSteps,
  candidateFeedback,
  investorUpdate,
  crmNote,
  negotiationBrief,
  slackUpdate,
  oneOnOneRecap,
  collatedFeedback,
];

export function getHandoff(id: string): HandoffDef<any> | undefined {
  return HANDOFFS.find((h) => h.id === id);
}

/** The 2–3 handoffs a meeting of this type leads with, in suggestion order. */
export function suggestedHandoffsFor(type: MeetingType): HandoffDef<any>[] {
  return (SUGGESTED_HANDOFFS[type] ?? []).map((id) => getHandoff(id)).filter((h): h is HandoffDef<any> => !!h);
}

/** The lead suggestion — the first of the type's list. Suggested, never run. */
export function defaultHandoffFor(type: MeetingType): HandoffDef<any> | undefined {
  return suggestedHandoffsFor(type)[0];
}

/** What the UI needs to draw the slash menu and chips, with no prompts leaking. */
export function handoffCatalog(type: MeetingType) {
  const suggested = SUGGESTED_HANDOFFS[type] ?? [];
  return HANDOFFS.map((h) => ({
    id: h.id,
    label: h.label,
    blurb: h.blurb,
    scope: h.scope,
    suggested: suggested.includes(h.id),
    /** Position in the type's suggestion list; -1 when not suggested. */
    suggestedRank: suggested.indexOf(h.id),
    isDefault: h.id === suggested[0],
    promptVersion: promptRef(h.prompt),
  }));
}

/**
 * Natural-language routing: "draft the follow-up email" → followup_email.
 *
 * Deliberately keyword-based, not a model call — an unmatched message falls
 * through to ordinary grounded Q&A, which is the safe default. The patterns name
 * the DELIVERABLE ("pricing quote", "action items"), never the topic: matching a
 * bare "pricing" turned "why did ANZ pricing move?" into a quote extraction
 * instead of an answer, which is the worst kind of wrong — confidently helpful.
 */
const KEYWORDS: { id: string; words: RegExp }[] = [
  {
    id: "followup_email",
    words: /\b(follow[- ]?up|followup)\s+(email|note|mail|message)\b|\bdraft\b[^?]*\b(email|mail|note|message)\b|\b(email|mail)\b[^?]*\b(recap|follow[- ]?up)\b/i,
  },
  {
    id: "pricing_quote",
    words: /\b(pricing|price|rate)[- ]?(quote|table|card|sheet|breakdown|extract)\b|\bquotes?\b|\bprices? (they|he|she|the vendor) (quoted|gave|said)\b/i,
  },
  { id: "team_actions", words: /\b(action items?|to-?dos?|commitments?)\b|\bwho owes\b|\bwho is doing what\b/i },
  // The specific artefacts go before summary_next_steps: "1:1 summary" and
  // "negotiation summary" name a deliverable of their own, not the readout.
  { id: "investor_update", words: /\binvestor update\b|\bupdate (for|to) (the |my )?investors?\b/i },
  { id: "crm_note", words: /\bcrm (note|notes|entry|update)\b|\b(log|put) (this|it|the call) in(to)? (the )?crm\b/i },
  { id: "negotiation_brief", words: /\b(negotiation|vendor) (brief|summary|notes)\b|\bbefore (we|i) sign\b/i },
  { id: "slack_update", words: /\bslack (update|post|message)\b|\bstandup update\b|\bpost (an? )?update\b/i },
  { id: "one_on_one_recap", words: /\b(1:1|1on1|one[- ]on[- ]one)\s+(recap|notes?|summary)\b|\brecap (of |for )?(the |our )?(1:1|one[- ]on[- ]one)\b/i },
  { id: "summary_next_steps", words: /\b(summar(y|ise|ize)|readout|recap|next steps)\b/i },
  {
    id: "candidate_feedback",
    words: /\b(candidate|interview|hiring)\s+(feedback|write[- ]?up|notes|debrief)\b|\bwrite up the interview\b|\bfeedback on the candidate\b/i,
  },
  { id: "collated_feedback", words: /\b(collate|collated|recurring (themes?|feedback|asks?)|common (themes?|feedback))\b|\bacross (all )?(my |the )?(customer )?(calls|meetings)\b/i },
];

/** Verbs that make a message a request rather than a question. */
const REQUEST_VERBS =
  /\b(draft|write|make|generate|create|prepare|build|pull|extract|collate|compile|give me|send me|show me|put together|turn (this|that) into)\b/i;

/** Openers that mean the user wants an explanation, not an artefact. */
const EXPLAIN_OPENERS = /^(why|how|when|where|which|who|whose|whom)\b/i;

export function matchHandoff(message: string): HandoffDef<any> | undefined {
  const text = message.trim();
  // "why did pricing move?" is a question about the meeting. Answer it.
  if (EXPLAIN_OPENERS.test(text) && !REQUEST_VERBS.test(text)) return undefined;
  const hit = KEYWORDS.find((k) => k.words.test(text));
  return hit ? getHandoff(hit.id) : undefined;
}
