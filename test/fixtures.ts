/**
 * Golden transcripts: one per meeting type, plus an adversarial one.
 *
 * Each fixture is hand-labeled with the statements a correct extraction must find and
 * the themes a correct outline should carry, so a prompt change can be scored
 * (see src/cli/eval-grounding.ts) instead of eyeballed. `goldNotes` is a
 * known-good compose response — every leaf in it must pass every validator, and
 * a test asserts exactly that.
 */
import type { Segment, MeetingType } from "../src/lib/segments.js";
import type { Notes } from "../src/lib/outline.js";

let n = 0;
/** Terse segment builder. `c` is STT confidence; omit for "heard fine". */
function seg(speaker: string, text: string, c?: number): Segment {
  const start = n * 6000;
  n++;
  return {
    id: `S${String(n).padStart(3, "0")}`,
    speaker,
    startMs: start,
    endMs: start + 5500,
    text,
    confidence: c ?? 1,
  };
}
const reset = () => void (n = 0);

export type Fixture = {
  id: string;
  title: string;
  type: MeetingType;
  participants: string[];
  segments: Segment[];
  /** Hand-labeled statements, matched loosely (content words) by the eval script. */
  expectedStatements: { text: string; source: string[] }[];
  /** Hand-labeled top-level themes, matched loosely. */
  expectedThemes: string[];
  /** A known-good compose response. Must validate clean. */
  goldNotes: Notes;
  /** A known-good response for this type's default handoff. */
  goldHandoff?: { id: string; value: unknown };
};

// ── Investor ────────────────────────────────────────────────────────────────

reset();
export const investor: Fixture = {
  id: "fx_investor",
  title: "Investor update — Q3",
  type: "investor",
  participants: ["Rachita", "Maya", "Prabhav"],
  segments: [
    seg("Rachita", "Thanks for making time. The headline is that ANZ pricing moved to September, and I want to walk you through why that is the right call."),
    seg("Maya", "September is fine if the reason is demand shaped. Is it?"),
    seg("Rachita", "Yes. Enterprise prospects want usage based tiers instead of per seat pricing, so we are rebuilding the tiers rather than shipping the wrong model."),
    seg("Maya", "Send me the prospecting table and the updated tier model when they are ready."),
    seg("Rachita", "Will do. The prospecting table of two hundred fifty companies is in progress, I will share both by end of month."),
    seg("Maya", "And where is burn?"),
    seg("Rachita", "Net burn is one hundred eighty thousand a month and runway is fourteen months."),
    seg("Prabhav", "I can own the tier rebuild. Three weeks from Monday."),
  ],
  expectedStatements: [
    { text: "ANZ pricing moved to September", source: ["S001"] },
    { text: "enterprise prospects want usage based tiers instead of per seat", source: ["S003"] },
    { text: "send prospecting table and updated tier model by end of month", source: ["S004", "S005"] },
    { text: "prospecting table of two hundred fifty companies", source: ["S005"] },
    { text: "net burn one hundred eighty thousand a month", source: ["S007"] },
    { text: "runway fourteen months", source: ["S007"] },
    { text: "Prabhav owns the tier rebuild, three weeks from Monday", source: ["S008"] },
  ],
  expectedThemes: ["pricing", "burn", "commitments"],
  goldNotes: {
    summary: {
      text: "ANZ pricing moved to September because enterprise prospects want usage based tiers instead of per seat pricing. Net burn is 180,000 a month with fourteen months of runway.",
      source: ["S001", "S003", "S007"],
    },
    themes: [
      {
        text: "Discussion",
        children: [
          {
            text: "ANZ pricing",
            children: [
              { text: "ANZ pricing moved to September", source: ["S001"] },
              { text: "Enterprise prospects want usage based tiers instead of per seat pricing", source: ["S003"] },
            ],
          },
          {
            text: "Burn and runway",
            children: [
              { text: "Net burn is 180,000 a month", source: ["S007"] },
              { text: "Runway is fourteen months", source: ["S007"] },
            ],
          },
        ],
      },
      {
        text: "Decisions",
        children: [{ text: "The tiers are being rebuilt rather than shipping the wrong model", source: ["S003"] }],
      },
      {
        text: "Action items",
        children: [
          { text: "Rachita: share the prospecting table of 250 companies and the updated tier model by end of month", source: ["S005"] },
          { text: "Prabhav: own the tier rebuild, three weeks from Monday", source: ["S008"] },
        ],
      },
    ],
  },
  goldHandoff: {
    id: "team_actions",
    value: {
      perOwner: [
        {
          owner: "Rachita",
          items: [
            { text: "Share the prospecting table and the updated tier model", owner: "Rachita", due: "by end of month", source: ["S005"] },
          ],
        },
        {
          owner: "Prabhav",
          items: [{ text: "Own the tier rebuild", owner: "Prabhav", due: "three weeks from Monday", source: ["S008"] }],
        },
      ],
    },
  },
};

// ── Vendor ──────────────────────────────────────────────────────────────────

reset();
export const vendor: Fixture = {
  id: "fx_vendor",
  title: "Vendor pricing call — Northsend",
  type: "vendor",
  participants: ["Rachita", "Dev"],
  segments: [
    seg("Rachita", "Walk me through pricing."),
    seg("Dev", "The platform license is forty eight thousand dollars a year for up to fifty seats."),
    seg("Dev", "Overage is nine dollars per seat per month beyond fifty seats."),
    seg("Rachita", "Any commitment on our side?"),
    seg("Dev", "Twelve month minimum term, net thirty payment terms. The quote holds until September 30."),
    seg("Rachita", "And onboarding?"),
    seg("Dev", "Onboarding is a separate statement of work, I cannot quote it today."),
    seg("Rachita", "Understood. Send the paper and I will review it."),
  ],
  expectedStatements: [
    { text: "platform license forty eight thousand dollars a year up to fifty seats", source: ["S002"] },
    { text: "overage nine dollars per seat per month", source: ["S003"] },
    { text: "twelve month minimum term net thirty payment terms", source: ["S005"] },
    { text: "quote holds until September 30", source: ["S005"] },
    { text: "onboarding cannot be quoted today", source: ["S007"] },
  ],
  expectedThemes: ["pricing", "terms", "onboarding"],
  goldNotes: {
    summary: {
      text: "Northsend quoted $48,000 a year for up to fifty seats on a twelve month minimum term. Onboarding was not quoted.",
      source: ["S002", "S005", "S007"],
    },
    themes: [
      {
        text: "Discussion",
        children: [
          {
            text: "License pricing",
            children: [
              { text: "Platform license is $48,000 a year for up to fifty seats", source: ["S002"] },
              { text: "Overage is $9 per seat per month beyond fifty seats", source: ["S003"] },
            ],
          },
          {
            text: "Commercial terms",
            children: [
              { text: "Twelve month minimum term, net thirty payment terms", source: ["S005"] },
              { text: "The quote holds until September 30", source: ["S005"] },
            ],
          },
        ],
      },
      {
        text: "Open questions",
        children: [{ text: "Onboarding is a separate statement of work and was not quoted", source: ["S007"] }],
      },
    ],
  },
  goldHandoff: {
    id: "pricing_quote",
    value: {
      quotes: [
        {
          item: "Platform license",
          price: "forty eight thousand dollars",
          unit: "a year for up to fifty seats",
          terms: "twelve month minimum term, net thirty",
          validUntil: "September 30",
          source: ["S002", "S005"],
        },
        {
          item: "Overage",
          price: "nine dollars",
          unit: "per seat per month beyond fifty seats",
          terms: "",
          validUntil: null,
          source: ["S003"],
        },
      ],
      unclear: [{ text: "Onboarding is a separate statement of work and could not be quoted", source: ["S007"] }],
    },
  },
};

// ── Customer ────────────────────────────────────────────────────────────────

reset();
export const customer: Fixture = {
  id: "fx_customer",
  title: "Customer call — Lumen Health",
  type: "customer",
  participants: ["Rachita", "Priya", "Prabhav"],
  segments: [
    seg("Rachita", "Thanks for making the time, Priya."),
    seg("Priya", "Happy to. Our main blocker is that SSO is missing, and our security team will not sign off without it."),
    seg("Rachita", "SSO is on the roadmap for October. I can send you the security questionnaire this week."),
    seg("Priya", "That helps. We also need the migration plan before we commit."),
    seg("Rachita", "I will send the migration plan by Friday and loop in Prabhav on the SSO timeline."),
    seg("Priya", "One more thing, onboarding felt slow. It took two weeks to get our first workspace."),
    seg("Rachita", "That is fair. I will take that back to the team."),
  ],
  expectedStatements: [
    { text: "SSO is missing and security will not sign off without it", source: ["S002"] },
    { text: "SSO is on the roadmap for October", source: ["S003"] },
    { text: "send the security questionnaire this week", source: ["S003"] },
    { text: "migration plan needed before they commit", source: ["S004"] },
    { text: "send the migration plan by Friday", source: ["S005"] },
    { text: "onboarding took two weeks to get the first workspace", source: ["S006"] },
  ],
  expectedThemes: ["sso", "migration", "onboarding"],
  goldNotes: {
    summary: {
      text: "Lumen cannot sign off without SSO, which is on the roadmap for October, and they need the migration plan before they commit.",
      source: ["S002", "S003", "S004"],
    },
    themes: [
      {
        text: "Discussion",
        children: [
          {
            text: "SSO",
            children: [
              { text: "SSO is missing and the security team will not sign off without it", source: ["S002"] },
              { text: "SSO is on the roadmap for October", source: ["S003"] },
            ],
          },
          {
            text: "Onboarding",
            children: [{ text: "Onboarding felt slow: two weeks to get the first workspace", source: ["S006"] }],
          },
        ],
      },
      {
        text: "Action items",
        children: [
          { text: "Rachita: send the security questionnaire this week", source: ["S003"] },
          { text: "Rachita: send the migration plan by Friday and loop in Prabhav on the SSO timeline", source: ["S005"] },
        ],
      },
      {
        text: "Risks & concerns",
        children: [{ text: "Lumen need the migration plan before they commit", source: ["S004"] }],
      },
    ],
  },
  goldHandoff: {
    id: "followup_email",
    value: {
      subject: "Following up on our conversation",
      body: [
        "Hi Priya,",
        "",
        "Thanks for the time today — really useful.",
        "",
        "Where we landed:",
        "- SSO is on the roadmap for October, and I know your security team can't sign off without it [S002, S003]",
        "- You need the migration plan before committing [S004]",
        "",
        "Next steps:",
        "- I'll send the security questionnaire this week [S003]",
        "- I'll send the migration plan by Friday, and loop in Prabhav on the SSO timeline [S005]",
        "",
        "Best,",
        "Rachita",
      ].join("\n"),
    },
  },
};

// ── Team ────────────────────────────────────────────────────────────────────

reset();
export const team: Fixture = {
  id: "fx_team",
  title: "ANZ pricing kickoff",
  type: "team",
  participants: ["Rachita", "Prabhav", "Sharon"],
  segments: [
    seg("Rachita", "ANZ pricing. Where do we stand on the rollout?"),
    seg("Prabhav", "The usage measurement logic is still wrong for annual accounts, so August is not realistic."),
    seg("Rachita", "What are prospects actually saying about the pricing model?"),
    seg("Prabhav", "Enterprise prospects pushed back hard on per seat pricing. They want usage based tiers. Rebuilding takes three weeks."),
    seg("Rachita", "Then the decision is we delay the ANZ rollout to September and rebuild the tiers."),
    seg("Sharon", "I will send the tier comparison by Thursday."),
    seg("Prabhav", "Do we tell the design partners now, or after the rebuild?"),
  ],
  expectedStatements: [
    { text: "usage measurement logic wrong for annual accounts", source: ["S002"] },
    { text: "August is not realistic", source: ["S002"] },
    { text: "enterprise prospects pushed back on per seat pricing", source: ["S004"] },
    { text: "rebuilding takes three weeks", source: ["S004"] },
    { text: "decision to delay ANZ rollout to September and rebuild tiers", source: ["S005"] },
    { text: "Sharon will send the tier comparison by Thursday", source: ["S006"] },
    { text: "open question whether to tell design partners now or after the rebuild", source: ["S007"] },
  ],
  expectedThemes: ["rollout", "pricing model", "open questions"],
  goldNotes: {
    summary: {
      text: "The ANZ rollout moves to September and the tiers get rebuilt, because enterprise prospects pushed back on per seat pricing.",
      source: ["S004", "S005"],
    },
    themes: [
      {
        text: "Discussion",
        children: [
          {
            text: "Rollout timing",
            children: [
              { text: "Usage measurement logic is still wrong for annual accounts, so August is not realistic", source: ["S002"] },
            ],
          },
          {
            text: "Pricing model",
            children: [
              { text: "Enterprise prospects pushed back hard on per seat pricing and want usage based tiers", source: ["S004"] },
              { text: "Rebuilding the tiers takes three weeks", source: ["S004"] },
            ],
          },
        ],
      },
      {
        text: "Decisions",
        children: [{ text: "Delay the ANZ rollout to September and rebuild the tiers", source: ["S005"] }],
      },
      {
        text: "Action items",
        children: [{ text: "Sharon: send the tier comparison by Thursday", source: ["S006"] }],
      },
      {
        text: "Open questions",
        children: [{ text: "Do we tell the design partners now, or after the rebuild?", source: ["S007"] }],
      },
    ],
  },
  goldHandoff: {
    id: "summary_next_steps",
    value: {
      themes: [
        {
          text: "ANZ rollout timing",
          children: [
            { text: "Usage measurement logic is wrong for annual accounts, so August is not realistic", source: ["S002"] },
            { text: "The decision is to delay the rollout to September and rebuild the tiers", source: ["S005"] },
          ],
        },
      ],
      nextSteps: [{ text: "Send the tier comparison", owner: "Sharon", due: "by Thursday", source: ["S006"] }],
      openQuestions: [{ text: "Do we tell the design partners now, or after the rebuild?", source: ["S007"] }],
    },
  },
};

// ── 1:1 (hiring) ────────────────────────────────────────────────────────────

reset();
export const oneOnOne: Fixture = {
  id: "fx_1on1",
  title: "Interview — Arjun, staff engineer",
  type: "one_on_one",
  participants: ["Rachita", "Arjun"],
  segments: [
    seg("Rachita", "Walk me through the hardest system you have built."),
    seg("Arjun", "I rewrote our batch pipeline and cut p95 latency from nine hundred milliseconds to one hundred twenty."),
    seg("Rachita", "How did you find the bottleneck?"),
    seg("Arjun", "I profiled it and found we were re-serialising the payload three times per hop."),
    seg("Rachita", "What would you do differently on the migration you mentioned?"),
    seg("Arjun", "Honestly I am not sure. We never load tested it before the cutover."),
    seg("Rachita", "Okay. On the engineering side this is a yes from me."),
  ],
  expectedStatements: [
    { text: "rewrote batch pipeline cut p95 latency from nine hundred to one hundred twenty milliseconds", source: ["S002"] },
    { text: "profiled and found payload re-serialised three times per hop", source: ["S004"] },
    { text: "never load tested the migration before cutover", source: ["S006"] },
    { text: "interviewer stated a yes on the engineering side", source: ["S007"] },
  ],
  expectedThemes: ["systems experience", "gaps"],
  goldNotes: {
    summary: {
      text: "Arjun walked through rewriting the batch pipeline and diagnosing the bottleneck by profiling. The migration was never load tested before cutover.",
      source: ["S002", "S004", "S006"],
    },
    themes: [
      {
        text: "Discussion",
        children: [
          {
            text: "Systems experience",
            children: [
              { text: "Rewrote the batch pipeline and cut p95 latency from 900 to 120 milliseconds", source: ["S002"] },
              { text: "Found the bottleneck by profiling: the payload was re-serialised three times per hop", source: ["S004"] },
            ],
          },
        ],
      },
      {
        text: "Risks & concerns",
        children: [{ text: "Was not sure what to change on the migration; it was never load tested before cutover", source: ["S006"] }],
      },
    ],
  },
  goldHandoff: {
    id: "candidate_feedback",
    value: {
      signals: [
        { text: "Rewrote the batch pipeline and cut p95 latency from 900 to 120 milliseconds", source: ["S002"] },
        { text: "Diagnosed the bottleneck by profiling and found the payload re-serialised three times per hop", source: ["S004"] },
      ],
      strengths: [{ text: "Traced a latency problem to a concrete cause rather than guessing", source: ["S004"] }],
      concerns: [{ text: "Said the migration was never load tested before cutover", source: ["S006"] }],
      statedLean: { text: "On the engineering side this is a yes from me", source: ["S007"] },
    },
  },
};

// ── Adversarial: off-topic tangent + a misheard number ──────────────────────

reset();
export const adversarial: Fixture = {
  id: "fx_adversarial",
  title: "Vendor call — noisy line",
  type: "vendor",
  participants: ["Rachita", "Dev"],
  segments: [
    seg("Rachita", "Before we start, did you catch the game last night?"),
    seg("Dev", "I did, terrible refereeing. Anyway."),
    // Heard poorly AND the only place a price is spoken: any claim resting here
    // is flagged, and a figure that does not match it exactly must be rejected.
    seg("Dev", "The pricing is eighty dollars per seat per month.", 0.42),
    seg("Rachita", "Eighty. Let me write that down."),
    seg("Dev", "My dog is called Biscuit, by the way. She hates video calls."),
    seg("Dev", "We can start the pilot in March."),
  ],
  expectedStatements: [
    { text: "pricing eighty dollars per seat per month", source: ["S003"] },
    { text: "pilot can start in March", source: ["S006"] },
  ],
  expectedThemes: ["pricing", "pilot"],
  goldNotes: {
    summary: { text: "Pricing was given as $80 per seat per month and the pilot can start in March.", source: ["S003", "S006"] },
    themes: [
      {
        text: "Discussion",
        children: [
          { text: "Pricing", children: [{ text: "Pricing is $80 per seat per month", source: ["S003"], lowConfidence: true }] },
          { text: "Pilot", children: [{ text: "The pilot can start in March", source: ["S006"] }] },
        ],
      },
    ],
  },
};

export const FIXTURES: Fixture[] = [investor, vendor, customer, team, oneOnOne, adversarial];

export function fixtureById(id: string): Fixture | undefined {
  return FIXTURES.find((f) => f.id === id);
}
