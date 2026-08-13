/**
 * Handoff prompts, versioned like every other template (see lib/prompts.ts).
 *
 * They are deliberately unclever. A weak model is not talked into accuracy by a
 * longer prompt; it is caught by the validators. So each prompt does three
 * things only: state the exact JSON shape, state the tone, and repeat that
 * unsupported lines get deleted.
 */
import { GROUNDING_RULES, type PromptTemplate } from "../lib/prompts.js";
import type { HandoffVars } from "./types.js";

function handoffPrompt(
  id: string,
  version: number,
  note: string,
  body: (v: HandoffVars) => string,
): PromptTemplate<HandoffVars> {
  return {
    id,
    version,
    note,
    build: (v) => `${body(v)}

${GROUNDING_RULES}

PARTICIPANTS: ${v.participants}
MEETING_TYPE: ${v.type}${v.roster ? `\nMEETINGS: ${v.roster}` : ""}
EXTRACTED_FACTS (json): ${v.facts}

Return JSON only. No prose outside JSON.`,
  };
}

export const TEAM_ACTIONS = handoffPrompt(
  "handoff.team_actions",
  2,
  "v2: owner is whoever does the work, not whoever asked",
  () => `You pull every commitment and ask out of an investor conversation and group them by the person who has to do the work, so the founder can forward each owner only their slice.

Shape:
{"perOwner": [{"owner": "Name", "items": [{"text": "what they committed to", "owner": "Name", "due": "as stated, else null", "source": ["S004"]}]}]}

Rules:
- "owner" must be a name from PARTICIPANTS spelled exactly as given, or "Unassigned". Never a team name, a role, a company, or a guess. If nobody took it, it is "Unassigned".
- The owner is whoever has to DO the work, never whoever asked for it. "Send me the table" said by an investor is an action owned by the founder, not by the investor. If the transcript does not make the doer explicit, use "Unassigned".
- Write each item from the doer's side: "Send the prospecting table", not "They will send me the table".
- One group per owner. Do not invent an owner to make the list look complete.
- "due" only if a date or timeframe was actually said ("by Friday", "end of month"). Otherwise null. Never derive a date from context.
- Include asks the investor made of the founder, and commitments the founder made. Exclude anything nobody committed to.
- "text" is imperative and specific: "Send the updated tier model", not "Follow up on pricing".`,
);

export const PRICING_QUOTE = handoffPrompt(
  "handoff.pricing_quote",
  1,
  "verbatim price table plus an explicit not-quoted list",
  () => `You extract a pricing quote from a vendor conversation. This is the strictest output in the product: a number that is not verbatim is worse than no number.

Shape:
{"quotes": [{"item": string, "price": string, "unit": string, "terms": string, "validUntil": string|null, "source": ["S004"]}],
 "unclear": [{"text": "what was raised but never priced", "source": ["S009"]}]}

Rules:
- Copy "price", "unit", "terms" and "validUntil" character-for-character as spoken. "$4,000" stays "$4,000" — never round, convert, annualise or tidy it.
- If a figure was said in words ("forty thousand"), write the digits only if the words are unambiguous, and cite the segment where they were said.
- Never compute anything. No per-seat maths, no totals, no discounts you worked out yourself.
- "unit" is what the price is per ("per seat / month", "one-off", "per 1,000 calls"). Empty string if not stated.
- "terms" holds conditions actually stated: minimum term, payment terms, volume tiers, notice periods.
- "validUntil" only if an expiry was stated; otherwise null.
- Anything discussed but not firmly priced goes in "unclear" as a sourced line, never in the table.`,
);

export const FOLLOWUP_EMAIL = handoffPrompt(
  "handoff.followup_email",
  2,
  "v2: address only people who were on the call; keep commitment direction",
  () => `You draft the follow-up email the founder sends after a customer conversation. Warm, first person, short — and every factual sentence carries its receipt inline.

Shape:
{"subject": string, "body": "markdown"}

Rules:
- Put the segment ids at the end of any line that states a fact, like: "- We'll send the migration plan by Friday [S011]".
- Lines with NO citation must contain no facts at all: greeting, thanks, and sign-off only. A line with a number, date or quote and no citation is deleted by a validator.
- The subject line carries no numbers, dates or quotes.
- Structure: one-line thanks, a short recap of what was discussed, an "agreed next steps" list with owner and timing, a one-line close.
- Warm phrasing is allowed ("great to meet you", "looking forward"). Invented commitments are not. If nobody agreed a date, do not imply one.
- Six to twelve lines total. First person singular ("I", "we"). No corporate filler.
- Do not thank them for anything they did not do, and do not promise anything nobody promised.
- Address the person who was on THIS call, taken from PARTICIPANTS. If PARTICIPANTS gives only a role ("Investor", "customer"), open with a plain "Hi there," rather than guessing a name.
- Keep each commitment pointing the right way: what you owe them goes under your name, what they owe you goes under theirs. Never turn their request into their promise.`,
);

export const SUMMARY_NEXT_STEPS = handoffPrompt(
  "handoff.summary_next_steps",
  2,
  "v2: commitments belong in nextSteps, never as a theme",
  () => `You produce the internal readout of a team meeting: a themed outline plus an explicit next-steps block.

Shape:
{"themes": [{"text": "Theme label", "children": [{"text": "a point", "source": ["S004"]}]}],
 "nextSteps": [{"text": "what happens next", "owner": "Name", "due": "as stated, else null", "source": ["S012"]}],
 "openQuestions": [{"text": "the question left hanging", "source": ["S014"]}]}

Rules:
- Theme labels are topics, never claims. A node has EITHER "children" OR "source", never both.
- Commitments belong in "nextSteps" and nowhere else. Do not create a theme called "Action items" or "Next steps" — the themes cover what was discussed, "nextSteps" covers what happens now.
- "owner" is a PARTICIPANTS name spelled exactly, or "Unassigned". Never a team, never a guess. The owner is whoever does the work, not whoever asked for it.
- "due" only when stated. Never inferred from "soon", "next sprint" or the meeting date.
- "openQuestions" holds questions that were actually asked and left unanswered. If there were none, return an empty array — do not manufacture one to fill the section.
- If nobody agreed a next step, "nextSteps" is empty. An empty section is a true statement about the meeting.`,
);

export const CANDIDATE_FEEDBACK = handoffPrompt(
  "handoff.candidate_feedback",
  1,
  "interview signals with examples; verdict only if one was stated",
  () => `You write up interview feedback from a 1:1 hiring conversation. Evaluative language is only allowed when it is anchored to something the candidate actually said or did in this conversation.

Shape:
{"signals": [{"text": "observed behaviour or answer, with its example", "source": ["S004"]}],
 "strengths": [{"text": string, "source": ["S006"]}],
 "concerns": [{"text": string, "source": ["S009"]}],
 "statedLean": {"text": "the hire/no-hire view the interviewer stated", "source": ["S021"]} | null}

Rules:
- Every line names the evidence: what was asked, what they answered, what they built. "Walked through how they cut p95 latency by rewriting the batch job [S012]" — not "strong engineer".
- "statedLean" is null unless the interviewer explicitly stated a lean in this transcript. Never infer one from tone or from the balance of strengths and concerns. Leaving it null is the correct, common answer.
- Concerns describe gaps in what was demonstrated, not speculation about the person.
- Never mention or infer age, gender, race, nationality, religion, disability, family or personal circumstances, accent, or where they went to school. If the transcript contains them, leave them out.
- No sentiment reading. "Hesitated on the scaling question [S018]" is observable; "seemed nervous" is not.`,
);

export const COLLATED_FEEDBACK = handoffPrompt(
  "handoff.collated_feedback",
  1,
  "cross-meeting customer themes; every theme cites instances",
  () => `You cluster recurring customer feedback across several meetings so the founder can see what keeps coming up.

Segment ids are namespaced by meeting: "M2:S007" means segment S007 of meeting M2. Use them exactly.

Shape:
{"themes": [{"theme": "short label", "kind": "request"|"objection"|"praise"|"churn_risk",
             "examples": [{"meetingId": "M2", "source": ["M2:S007"]}]}]}

Rules:
- A theme with no examples cannot exist. If you cannot cite it, it is not a theme.
- Every id in "examples[].source" must start with that example's own "meetingId".
- One example entry per instance, so the same request in three meetings is three entries under one theme.
- Theme labels are short topics — "usage-based pricing", "SSO missing", "slow onboarding". Labels carry no numbers, no dates and no company names unless the cited lines do.
- Do not count anything yourself. Frequency is computed from your citations.
- Merge wordings of the same underlying ask. Keep genuinely different asks apart.`,
);
